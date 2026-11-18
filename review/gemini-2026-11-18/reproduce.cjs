'use strict';
// Offline review probes: fake SQL driver and disposable /tmp files only.
// Prints observed behavior; this is not a passing safety regression suite.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const req = p => require(path.join(root, p));
const { DataSyncPlanService, computePlanDigest } = req('electron/data-sync-plan-service.cjs');
const { DataSyncExecutor } = req('electron/data-sync-executor.cjs');
const { RestorePlanService } = req('electron/restore-plan-service.cjs');
const { RestoreSelectionExecutor } = req('electron/restore-selection-executor.cjs');
const { encryptBackupFile, decryptBackupFile, MAGIC, HEADER_SIZE } = req('electron/backup-crypto.cjs');
const { BackupReplicaManager } = req('electron/backup-replica-manager.cjs');
const results = {};
const scopes = {sourceScope:{profileId:'src',database:'sample',table:'users'},targetScope:{profileId:'tgt',database:'sample',table:'users'}};
const report = {coverage:{complete:false,consistent:false,canSynchronize:false},primaryKeys:['id'],columns:[{name:'id',type:'int'},{name:'value',type:'varchar(20)'}],onlyInTarget:[{rowKey:'1',row:{id:1,value:'old'}}]};
async function run() {
  const fixtureText = fs.readFileSync(path.join(root,'test/main-schema-migration.test.cjs'),'utf8');
  const fixtureBody = fixtureText.slice(fixtureText.indexOf('function fixture()'),fixtureText.indexOf('\ntest('));
  const fixture = new Function('require','path','vm','fs','crypto','DatabaseSession','__dirname',fixtureBody+'; return fixture;')(require('node:module').createRequire(path.join(root,'test/main-schema-migration.test.cjs')),path,vm,fs,crypto,req('electron/database.cjs').DatabaseSession,path.join(root,'test'));
  const r = fixture();
  r.profiles.tgt = {environment:'staging',readOnly:false};
  r.evaluate(`globalThis.reviewSql = []; dataSyncExecutor.createSession = () => ({async connect(){},async useDatabase(){},async listColumns(){return [{name:'id',type:'int',key:'PRI'},{name:'value',type:'varchar(20)',key:''}]},async raw(sql,params){reviewSql.push({sql,params});return {result:{affectedRows:1}}},async close(){}})`);
  const p = await r.call('db:create-data-sync-plan',{...scopes,diffReport:report,options:{includeDeletes:true}});
  const a = await r.call('db:apply-data-sync-plan',{planToken:p.data.planToken,profileId:'unrelated'});
  results.mainForgedDiff = {planAccepted:p.ok,applyResponse:a,queries:r.evaluate('reviewSql'),sendToRendererType:r.evaluate('typeof sendToRenderer')};
  const s = new DataSyncPlanService();
  const draft = s.createSyncPlan({...scopes,diffReport:report,options:{includeDeletes:true}});
  const plan = s.consumePlan(draft.planToken);
  const before = computePlanDigest(plan);
  let mutated = false;
  try { plan.operations[0].table = 'another_table'; mutated = true; } catch {}
  results.syncDigestOmitsTable = {digestUnchanged: mutated ? before === computePlanDigest(plan) : false, frozen: Object.isFrozen(plan)};
  const { TableKeysetReader } = req('electron/data-diff-reader.cjs');
  const { compareKeysetStreams } = req('electron/data-diff-service.cjs');
  const capped = () => {
    const reader = new TableKeysetReader({async raw(){return {rows:[{id:1}]}}},'sample','users',{maxRows:1});
    reader.columns=[{name:'id',type:'int'}];reader.primaryKeys=['id'];reader.pkTypes=['int'];
    return reader;
  };
  const cappedReport = await compareKeysetStreams({sourceReader:capped(),targetReader:capped(),rowLimit:10});
  results.diffQuota = {coverage:cappedReport.coverage,summary:cappedReport.summary};
  const matrixText=fs.readFileSync(path.join(root,'test/schema-migration-engine-matrix.test.cjs'),'utf8');
  const helperText=matrixText.slice(matrixText.indexOf('function makeTable('),matrixText.indexOf('\ntest('));
  const {makeSnapshot,makeTable}=new Function('computeSchemaFingerprint',helperText+'; return {makeSnapshot,makeTable};')(req('electron/schema-snapshot.cjs').computeSchemaFingerprint);
  const cols=[{name:'id',type:'int',nullable:false},{name:'body',type:'text',nullable:true}];
  const pk={name:'PRIMARY',isPrimary:true,isUnique:true,columns:[{name:'id'}]};
  const fulltext={name:'ft_body',type:'FULLTEXT',isUnique:false,columns:[{name:'body'}]};
  const gen=new (req('electron/schema-migration-generator.cjs').SchemaMigrationGenerator)();
  const gp=gen.generateMigrationPlan({sourceSnapshot:makeSnapshot('src','sample',[makeTable('users',cols,[pk,fulltext])]),targetSnapshot:makeSnapshot('tgt','sample',[makeTable('users',cols,[pk])])});
  results.generatorFulltext={status:gp.status,sql:gp.statements.map(s=>s.sql)};
  const syncSql = [];
  const ex = new DataSyncExecutor({consumePlan:()=>({...plan,operations:[{...plan.operations[0],table:'users'}]}), getProfileWithSecrets:()=>({id:'tgt',readOnly:false}),createSession:()=>({async connect(){},async useDatabase(){},async listColumns(){return [{name:'id',type:'int',key:'PRI'},{name:'value',type:'varchar(20)',key:''}]},async raw(sql,params){syncSql.push({sql,params});if(sql==='COMMIT')throw Object.assign(Error('commit acknowledgement lost'),{code:'ECONNRESET'});return {result:{affectedRows:1}}},async close(){}})});
  try {await ex.executeSyncPlan({planToken:'x'});}catch(e){results.syncCommitFailure={code:e.code,partialCommit:e.partialCommit,committedCount:e.committedCount,queries:syncSql};}
  const tmp = fs.mkdtempSync('/tmp/sqlpro-review-evidence-');
  try {
    const source=path.join(tmp,'source.sql'), dest=path.join(tmp,'existing.sql'), enc=path.join(tmp,'source.enc');
    fs.writeFileSync(source,'SELECT 1;');fs.writeFileSync(dest,'DO NOT DELETE');
    results.cryptoHeader={magicBytes:MAGIC.length,headerSize:HEADER_SIZE};
    await encryptBackupFile(source,enc,{passphrase:'correct password'});
    try {await decryptBackupFile(enc,dest,{passphrase:'wrong password'});}catch(e){results.decryptFailure={code:e.code,message:e.message,destinationExists:fs.existsSync(dest)};}
    try {await new BackupReplicaManager({maxRetries:1}).createReplica({sourceFilePath:source,destinationDir:tmp,expectedFileChecksum:'0'.repeat(64)});}catch(e){results.replicaFailure={code:e.code,originalSourceExists:fs.existsSync(source)};}
    const dump=path.join(tmp,'dump.sql');
    const original="CREATE TABLE `users` (`id` int PRIMARY KEY); INSERT INTO `users` VALUES (1);";
    const changed=original.replace('VALUES (1)','VALUES (9)');
    fs.writeFileSync(dump,original);fs.utimesSync(dump,1700000000,1700000000);
    const store={getWithSecrets:()=>({id:'p',readOnly:false})};
    const service=new RestorePlanService({store,fingerprintProfile:()=> 'fp',createSession:()=>({async connect(){},async close(){},async collectRestoreTargetFacts(database){return {database,objects:[],errors:[]}}})});
    const rp=await service.createSelectiveRestorePlan({filePath:dump,targetProfileId:'p',targetDatabase:'sample',selection:{tables:['users']}});
    fs.writeFileSync(dump,changed);fs.utimesSync(dump,1700000000,1700000000);
    const writes=[];
    const restore=new RestoreSelectionExecutor({consumePlan:t=>service.consumePlan(t),getProfileWithSecrets:store.getWithSecrets,fingerprintProfile:()=> 'fp',createSession:()=>({async connect(){},async close(){},async useDatabase(){},async raw(sql){writes.push(sql);return {result:[]}}})});
    try {const rr=await restore.executePlan({planToken:rp.planToken});results.restoreTamper={planStatus:rp.status,result:rr,queries:[...writes]};}catch(e){results.restoreTamper={planStatus:rp.status,error:e.code,message:e.message,queries:[...writes]};}
    fs.writeFileSync(dump,original + ' SET GLOBAL max_connections=999;');
    const globalPlan=await service.createSelectiveRestorePlan({filePath:dump,targetProfileId:'p',targetDatabase:'sample',selection:{tables:['users']}});
    const offset=writes.length;
    try {await restore.executePlan({planToken:globalPlan.planToken});results.restoreGlobalSet={planStatus:globalPlan.status,queries:writes.slice(offset)};}catch(e){results.restoreGlobalSet={planStatus:globalPlan.status,error:e.code,queries:writes.slice(offset)};}
    fs.writeFileSync(dump,original.replace('INSERT INTO `users`','INSERT INTO `other_db`.`users`'));
    const crossPlan=await service.createSelectiveRestorePlan({filePath:dump,targetProfileId:'p',targetDatabase:'sample',selection:{tables:['users']}});
    const next=writes.length;
    try {await restore.executePlan({planToken:crossPlan.planToken});results.restoreCrossDb={planStatus:crossPlan.status,queries:writes.slice(next)};}catch(e){results.restoreCrossDb={planStatus:crossPlan.status,error:e.code,queries:writes.slice(next)};}
  } finally {fs.rmSync(tmp,{recursive:true,force:true});}
  console.log(JSON.stringify(results,null,2));
}
run().catch(e=>{console.error(e);process.exitCode=1});
