'use strict';
// Round-two offline observations: fake SQL sessions and disposable /tmp files only.
// This is an audit probe, not a passing safety regression suite.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const req = p => require(path.join(root,p));
const { RestorePlanService } = req('electron/restore-plan-service.cjs');
const { RestoreSelectionExecutor } = req('electron/restore-selection-executor.cjs');
const { BackupReplicaManager } = req('electron/backup-replica-manager.cjs');
const results = {};
async function run() {
  const tmp=fs.mkdtempSync('/tmp/sqlpro-rereview-extra-');
  try {
    const dump=path.join(tmp,'dump.sql');
    const store={getWithSecrets:()=>({id:'p',readOnly:false})};
    const service=new RestorePlanService({store,fingerprintProfile:()=> 'fp',createSession:()=>({async connect(){},async close(){},async collectRestoreTargetFacts(database){return {database,objects:[],errors:[]}}})});
    async function restore(label, sql, options={}) {
      fs.writeFileSync(dump,sql);
      const plan=await service.createSelectiveRestorePlan({filePath:dump,targetProfileId:'p',targetDatabase:'sample',selection:{tables:['users']},dropExisting:options.dropExisting||false});
      const queries=[];
      const executor=new RestoreSelectionExecutor({consumePlan:t=>service.consumePlan(t),getProfileWithSecrets:store.getWithSecrets,fingerprintProfile:()=> 'fp',createSession:()=>({async connect(){options.onConnect?.()},async useDatabase(){},async raw(sql){queries.push(sql);return {result:[]}},async close(){}})});
      try {results[label]={planStatus:plan.status,result:await executor.executePlan({planToken:plan.planToken}),queries};}
      catch(e){results[label]={planStatus:plan.status,code:e.code,partialCommit:e.partialCommit,queries};}
    }
    const create='CREATE TABLE `users` (`id` int PRIMARY KEY); ';
    await restore('multiDrop',create+'DROP TABLE `users`, `other_db`.`victim`;',{dropExisting:true});
    await restore('caseDatabase',create+'INSERT INTO `SAMPLE`.`users` VALUES (1);');
    await restore('sessionAutocommit',create+'SET AUTOCOMMIT=0; INSERT INTO `users` VALUES (1);');
    await restore('lateFileSwap',create+'INSERT INTO `users` VALUES (1);',{onConnect(){fs.writeFileSync(dump,create+'INSERT INTO `users` VALUES (9);')}});
    fs.writeFileSync(dump,create+'INSERT INTO `users` VALUES (1);');
    let currentProfile={id:'p',readOnly:false};
    const driftStore={getWithSecrets:()=>currentProfile};
    const driftService=new RestorePlanService({store:driftStore,fingerprintProfile:p=>JSON.stringify(p),createSession:()=>({async connect(){},async close(){},async collectRestoreTargetFacts(database){return {database,objects:[],errors:[]}}})});
    const driftPlan=await driftService.createSelectiveRestorePlan({filePath:dump,targetProfileId:'p',targetDatabase:'sample',selection:{tables:['users']}});
    const driftQueries=[];
    const driftExecutor=new RestoreSelectionExecutor({consumePlan:t=>driftService.consumePlan(t),getProfileWithSecrets:driftStore.getWithSecrets,fingerprintProfile:p=>JSON.stringify(p),createSession:()=>({async connect(){currentProfile={id:'p',readOnly:true}},async useDatabase(){},async raw(sql){driftQueries.push(sql);return {result:[]}},async close(){}})});
    try {
      results.profileDrift={result:await driftExecutor.executePlan({planToken:driftPlan.planToken}),profileReadOnly:currentProfile.readOnly,queries:driftQueries};
    } catch(e) {
      results.profileDrift={code:e.code,profileReadOnly:currentProfile.readOnly,queries:driftQueries};
    }
    const srcDir=path.join(tmp,'source'),destDir=path.join(tmp,'replica');
    fs.mkdirSync(srcDir);fs.mkdirSync(destDir);
    const src=path.join(srcDir,'backup.sql'),dest=path.join(destDir,'backup.sql');
    fs.writeFileSync(src,'NEW BACKUP');fs.writeFileSync(dest,'EXISTING BACKUP');
    const rep=await new BackupReplicaManager({maxRetries:1}).createReplica({sourceFilePath:src,destinationDir:destDir});
    results.replicaOverwrite={verified:rep.verified,destinationContent:fs.readFileSync(dest,'utf8')};
    const fixtureText=fs.readFileSync(path.join(root,'test/main-schema-migration.test.cjs'),'utf8');
    const body=fixtureText.slice(fixtureText.indexOf('function fixture()'),fixtureText.indexOf('\ntest('));
    const fixture=new Function('require','path','vm','fs','crypto','DatabaseSession','__dirname',body+';return fixture;')(require('node:module').createRequire(path.join(root,'test/main-schema-migration.test.cjs')),path,vm,fs,crypto,req('electron/database.cjs').DatabaseSession,path.join(root,'test'));
    const r=fixture();
    results.cancelTransfer=r.evaluate(`(()=>{const t=claimDatabaseTransfer({operation:'restore-selective',profileId:'p',pending:true}); const canceled=cancelDatabaseTransfer(t); const afterCancel=t.controller.signal.aborted; stopBackupSchedules(); const afterReset=t.controller.signal.aborted; activeDatabaseTransfer=null; return {canceled,afterCancel,afterReset};})()`);
    results.approval=r.evaluate(`(async()=>{const plan={planToken:'x',planDigest:'claimed',expiresAt:Date.now()+60000,targetScope:{profileId:'p',profileFingerprint:'fp'},operations:[{sql:'original'}]}; const profile={id:'p',environment:'production',readOnly:false};const receipt=await operationApprovalManager.requestApproval({planType:'selective-restore',plan,targetProfile:profile,showConfirmDialog:async()=>({response:0})});plan.operations[0].sql='changed';plan.targetScope.profileFingerprint='changed';return {receiptDespiteCancel:!!receipt.approvalToken,authorized:operationApprovalManager.authorizeProduction({planType:'selective-restore',plan,approvalToken:receipt.approvalToken})};})()`);
    results.approval=await results.approval;
    const {DataSyncPlanService,computePlanDigest}=req('electron/data-sync-plan-service.cjs');
    const syncService=new DataSyncPlanService();
    const scope={profileId:'tgt',database:'sample',table:'users'};
    const draft=syncService.createSyncPlan({sourceScope:{...scope,profileId:'src'},targetScope:scope,diffReport:{primaryKeys:['id'],columns:[{name:'id',type:'int'}],onlyInSource:[{rowKey:'1',row:{id:1}}]}});
    scope.database='changed_after_plan';
    const syncPlan=syncService.consumePlan(draft.planToken);
    results.syncShallowFreeze={frozen:Object.isFrozen(syncPlan),operationFrozen:Object.isFrozen(syncPlan.operations[0]),targetDatabase:syncPlan.targetScope.database,digestMatches:syncPlan.planDigest===computePlanDigest(syncPlan)};
    const {DataSyncExecutor}=req('electron/data-sync-executor.cjs');
    const observerError=Promise.race([
      new Promise(resolve=>process.once('unhandledRejection',e=>resolve(e.message))),
      new Promise(resolve=>setTimeout(()=>resolve(null),100))
    ]);
    const syncExecutor=new DataSyncExecutor({consumePlan:()=>({...syncPlan,targetScope:{profileId:'p',database:'sample',table:'users'}}),getProfileWithSecrets:()=>({id:'p',readOnly:false}),createSession:()=>({async connect(){},async useDatabase(){},async listColumns(){return [{name:'id',type:'int',key:'PRI'}]},async raw(){return {result:{affectedRows:1}}},async close(){}})});
    const progressResult=await syncExecutor.executeSyncPlan({planToken:'fixture',onProgress:async()=>{throw Error('fixture observer rejection')}});
    results.asyncProgress={success:progressResult.success,unhandledRejection:await observerError};
  } finally {fs.rmSync(tmp,{recursive:true,force:true});}
  console.log(JSON.stringify(results,null,2));
}
run().catch(e=>{console.error(e);process.exitCode=1});
