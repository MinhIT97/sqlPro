'use strict';
// Round-four offline audit: fake SQL drivers, real services/Main VM, disposable /tmp files.
// Observations only; exit 0 does not certify safety. Pending operations are released before cleanup.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const req = p => require(path.join(root,p));
const {RestorePlanService} = req('electron/restore-plan-service.cjs');
const {RestoreSelectionExecutor} = req('electron/restore-selection-executor.cjs');
const {parseAlterRename} = req('electron/sql-script.cjs');
const {BackupReplicaManager} = req('electron/backup-replica-manager.cjs');
const results = {};
async function main() {
  const dir = fs.mkdtempSync('/tmp/sqlpro-r4-');
  const dump=path.join(dir,'backup.sql');
  let profile={id:'p',readOnly:false};
  const store={getWithSecrets:()=>profile};
  const metadataSession=()=>({async connect(){},async close(){},async collectRestoreTargetFacts(database){return {database,objects:[{type:'table',name:'users'}],errors:[]}}});
  const service=new RestorePlanService({store,fingerprintProfile:()=> 'fp',createSession:metadataSession});
  async function fixture(sql, options={}) {
    profile={id:'p',readOnly:false};
    fs.writeFileSync(dump,sql);
    const plan=await service.createSelectiveRestorePlan({filePath:dump,targetProfileId:'p',targetDatabase:'sample',selection:{tables:['users'],includeStructure:options.includeStructure!==false},dropExisting:options.dropExisting===true});
    const queries=[];
    const worker={async connect(){await options.onConnect?.()},async useDatabase(){},async close(){await options.onClose?.()},async raw(sql){queries.push(sql);return options.onRaw?options.onRaw(sql):{result:[]}}};
    const executor=new RestoreSelectionExecutor({consumePlan:t=>service.consumePlan(t),getProfileWithSecrets:store.getWithSecrets,fingerprintProfile:()=> 'fp',createSession:()=>worker,statementTimeoutMs:options.statementTimeoutMs??20});
    const run=async(signal)=>{try{return {planStatus:plan.status,result:await executor.executePlan({planToken:plan.planToken,signal}),queries}}catch(e){return {planStatus:plan.status,code:e.code,executedCount:e.executedCount,partialCommit:e.partialCommit,targetChanged:e.targetChanged,executionUncertain:e.executionUncertain,queries}}};
    return {run,worker,plan,queries};
  }
  try {
    const create='CREATE TABLE `users` (`id` int PRIMARY KEY); ';
    const alter="ALTER TABLE `users` COMMENT='RENAME TO users ignored', RENAME TO `other_db`.`victim`;";
    const a=await fixture(create+alter);
    results.renameInsideString={parser:parseAlterRename(alter),...await a.run()};
    results.quotedAutocommit=await (await fixture(create+'SET `AUTOCOMMIT`=0; INSERT INTO `users` VALUES (1);')).run();
    results.expressionAutocommit=await (await fixture(create+'SET AUTOCOMMIT=(0); INSERT INTO `users` VALUES (1);')).run();
    results.dropThenContextDrift=await (await fixture(create,{dropExisting:true,onRaw(sql){if(sql.startsWith('DROP TABLE IF EXISTS'))profile={id:'p',readOnly:true};return {result:[]}}})).run();
    results.firstDmlLostAck=await (await fixture('INSERT INTO `users` VALUES (1);',{includeStructure:false,onRaw(sql){if(sql.startsWith('INSERT'))throw Object.assign(Error('lost INSERT acknowledgement'),{code:'ECONNRESET'});return {result:[]}}})).run();
    let releaseConnect,entered;
    const connectStarted=new Promise(resolve=>{entered=resolve});
    const c=await fixture(create,{onConnect(){entered();return new Promise(resolve=>{releaseConnect=resolve})}});
    const controller=new AbortController();
    const pending=c.run(controller.signal);await connectStarted;controller.abort();
    const settledBeforeRelease=await Promise.race([pending.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),60))]);
    releaseConnect();results.cancelHungConnect={settledBeforeRelease,response:await pending};
    let releaseDdl,ddlEntered;
    const ddlStarted=new Promise(resolve=>{ddlEntered=resolve});
    const d=await fixture(create,{statementTimeoutMs:10,onRaw(sql){if(sql.startsWith('CREATE')){ddlEntered();return new Promise(resolve=>{releaseDdl=resolve})}return {result:[]}}});
    const ddlPending=d.run();await ddlStarted;
    const settledAfterDeadline=await Promise.race([ddlPending.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),60))]);
    releaseDdl({result:[]});results.rawDeadline={settledAfterDeadline,response:await ddlPending};
    const fixtureText=fs.readFileSync(path.join(root,'test/main-schema-migration.test.cjs'),'utf8');
    const body=fixtureText.slice(fixtureText.indexOf('function fixture()'),fixtureText.indexOf('\ntest('));
    const mainFixture=new Function('require','path','vm','fs','crypto','DatabaseSession','__dirname',body+';return fixture;')(require('node:module').createRequire(path.join(root,'test/main-schema-migration.test.cjs')),path,vm,fs,crypto,req('electron/database.cjs').DatabaseSession,path.join(root,'test'));
    const r=mainFixture();r.profiles.p={readOnly:false,environment:'local'};
    r.evaluate(`restorePlanService.createSession=()=>({async connect(){},async close(){},async collectRestoreTargetFacts(database){return {database,objects:[],errors:[]}}});globalThis.r4Queries=[];restoreSelectionExecutor.createSession=()=>({async connect(){},async close(){},async useDatabase(){},async raw(sql){r4Queries.push(sql);return {result:[]}}});`);
    fs.writeFileSync(dump,create+alter);
    const mainPlan=await r.evaluate('restorePlanService').createSelectiveRestorePlan({filePath:dump,targetProfileId:'p',targetDatabase:'sample',selection:{tables:['users']}});
    results.mainParserBypass={response:await r.call('db:apply-selective-restore-plan',{planToken:mainPlan.planToken,profileId:'p'}),queries:r.evaluate('r4Queries')};
    fs.writeFileSync(dump,create);
    const lostPlan=await r.evaluate('restorePlanService').createSelectiveRestorePlan({filePath:dump,targetProfileId:'p',targetDatabase:'sample',selection:{tables:['users']}});
    r.evaluate(`restoreSelectionExecutor.createSession=()=>({async connect(){},async close(){},async useDatabase(){},async raw(sql){if(sql.startsWith('CREATE'))throw Object.assign(Error('lost CREATE acknowledgement'),{code:'ECONNRESET'});return {result:[]}}})`);
    results.mainLostAckProjection=await r.call('db:apply-selective-restore-plan',{planToken:lostPlan.planToken,profileId:'p'});
    const srcDir=path.join(dir,'source'),dstDir=path.join(dir,'dest');fs.mkdirSync(srcDir);fs.mkdirSync(dstDir);
    const src=path.join(srcDir,'backup.sql'),dest=path.join(dstDir,'backup.sql');fs.writeFileSync(src,'NEW BACKUP');
    const manager=new BackupReplicaManager({maxRetries:1});const copy=manager.copyAtomic.bind(manager);
    manager.copyAtomic=async(s,d,e,o)=>{fs.writeFileSync(d,'CONCURRENT BACKUP');return copy(s,d,e,o)};
    const replica=await manager.createReplica({sourceFilePath:src,destinationDir:dstDir});
    results.replicaPublication={originalContent:fs.readFileSync(dest,'utf8'),newReplicaContent:fs.readFileSync(replica.replicaPath,'utf8'),usesDifferentPath:replica.replicaPath!==dest};
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
  console.log(JSON.stringify(results,null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1});
