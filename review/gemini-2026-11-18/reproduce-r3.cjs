'use strict';
// Round-three offline audit probes: real modules/Main VM, fake database driver, disposable /tmp files.
// Prints observations; exit 0 is not a safety acceptance verdict.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const req = p => require(path.join(root,p));
const {RestorePlanService} = req('electron/restore-plan-service.cjs');
const {RestoreSelectionExecutor} = req('electron/restore-selection-executor.cjs');
const {BackupReplicaManager} = req('electron/backup-replica-manager.cjs');
const results = {};
async function run() {
  const tmp=fs.mkdtempSync('/tmp/sqlpro-r3-');
  try {
    const dump=path.join(tmp,'dump.sql');
    const create='CREATE TABLE `users` (`id` int PRIMARY KEY); ';
    const store={getWithSecrets:()=>({id:'p',readOnly:false})};
    const metadataSession=()=>({async connect(){},async close(){},async collectRestoreTargetFacts(database){return {database,objects:[],errors:[]}}});
    const service=new RestorePlanService({store,fingerprintProfile:()=> 'fp',createSession:metadataSession});
    async function restore(label,sql,options={}) {
      fs.writeFileSync(dump,sql);
      const p=await service.createSelectiveRestorePlan({filePath:dump,targetProfileId:'p',targetDatabase:'sample',selection:{tables:['users']},dropExisting:options.dropExisting===true});
      const queries=[];
      const executor=new RestoreSelectionExecutor({consumePlan:t=>service.consumePlan(t),getProfileWithSecrets:store.getWithSecrets,fingerprintProfile:()=> 'fp',createSession:()=>({async connect(){},async useDatabase(){},async close(){},async raw(sql){queries.push(sql);if(options.onRaw) return options.onRaw(sql);return {result:[]}}})});
      try {results[label]={planStatus:p.status,result:await executor.executePlan({planToken:p.planToken}),queries};}
      catch(e){results[label]={planStatus:p.status,code:e.code,partialCommit:e.partialCommit,targetChanged:e.targetChanged,executionUncertain:e.executionUncertain,queries};}
    }
    await restore('alterRenameOutside',create+'ALTER TABLE `users` RENAME TO `other_db`.`victim`;');
    await restore('caseTable',create+'INSERT INTO `Users` VALUES (1);');
    await restore('autocommitFalse',create+'SET AUTOCOMMIT=FALSE; INSERT INTO `users` VALUES (1);');
    await restore('commitChain',create+'START TRANSACTION; INSERT INTO `users` VALUES (1); COMMIT AND CHAIN; INSERT INTO `users` VALUES (2);');
    await restore('firstDdlTimeout',create,{onRaw(sql){if(sql.startsWith('CREATE')) throw Object.assign(Error('lost DDL acknowledgement'),{code:'ECONNRESET'});return {result:[]}}});
    const fixtureText=fs.readFileSync(path.join(root,'test/main-schema-migration.test.cjs'),'utf8');
    const body=fixtureText.slice(fixtureText.indexOf('function fixture()'),fixtureText.indexOf('\ntest('));
    const fixture=new Function('require','path','vm','fs','crypto','DatabaseSession','__dirname',body+';return fixture;')(require('node:module').createRequire(path.join(root,'test/main-schema-migration.test.cjs')),path,vm,fs,crypto,req('electron/database.cjs').DatabaseSession,path.join(root,'test'));
    const r=fixture();r.profiles.prod={environment:'production',readOnly:false};
    r.evaluate(`restorePlanService.createSession=()=>({async connect(){},async close(){},async collectRestoreTargetFacts(database){return {database,objects:[],errors:[]}}});globalThis.r3Queries=[];restoreSelectionExecutor.createSession=()=>({async connect(){},async useDatabase(){},async close(){},async raw(sql){r3Queries.push(sql);return {result:[]}}});`);
    fs.writeFileSync(dump,create+'INSERT INTO `users` VALUES (1);');
    const prodPlan=await r.evaluate('restorePlanService').createSelectiveRestorePlan({filePath:dump,targetProfileId:'prod',targetDatabase:'sample',selection:{tables:['users']}});
    const prodResult=await r.call('db:apply-selective-restore-plan',{planToken:prodPlan.planToken,profileId:'prod',taskId:'review-r3'});
    results.productionWithoutApproval={planStatus:prodPlan.status,response:prodResult,queries:r.evaluate('r3Queries')};
    // Test controller cancellation while a driver query is still awaiting acknowledgement.
    r.profiles.p={environment:'local',readOnly:false};
    const cancelPlan=await r.evaluate('restorePlanService').createSelectiveRestorePlan({filePath:dump,targetProfileId:'p',targetDatabase:'sample',selection:{tables:['users']}});
    let release,entered;
    const started=new Promise(resolve=>{entered=resolve});
    const cancelQueries=[];
    r.evaluate('restoreSelectionExecutor').createSession=()=>({async connect(){},async useDatabase(){},async close(){},async raw(sql){cancelQueries.push(sql);if(sql.startsWith('CREATE')){entered();return new Promise(resolve=>{release=resolve})}return {result:[]}}});
    const pending=r.call('db:apply-selective-restore-plan',{planToken:cancelPlan.planToken,profileId:'p',taskId:'review-cancel'});
    await started;
    const cancelResult=r.evaluate('cancelDatabaseTransfer(activeDatabaseTransfer)');
    const settledBeforeRelease=await Promise.race([pending.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),40))]);
    release({result:[]});
    results.cancelHungDdl={cancelResult,settledBeforeRelease,response:await pending,queries:cancelQueries};
    // A destination can appear after existsSync and before rename.
    const srcDir=path.join(tmp,'source'),dstDir=path.join(tmp,'dest');fs.mkdirSync(srcDir);fs.mkdirSync(dstDir);
    const src=path.join(srcDir,'backup.sql');fs.writeFileSync(src,'NEW BACKUP');
    const manager=new BackupReplicaManager({maxRetries:1});
    const copy=manager.copyAtomic.bind(manager);
    manager.copyAtomic=async(src,dst,expected)=>{fs.writeFileSync(dst,'CONCURRENT BACKUP');return copy(src,dst,expected)};
    const replica=await manager.createReplica({sourceFilePath:src,destinationDir:dstDir});
    results.replicaRace={verified:replica.verified,destinationContent:fs.readFileSync(replica.replicaPath,'utf8')};
  } finally {fs.rmSync(tmp,{recursive:true,force:true})}
  console.log(JSON.stringify(results,null,2));
}
run().catch(e=>{console.error(e);process.exitCode=1});
