'use strict';
// Round-five audit probes: fake drivers/metadata, real services and Main VM, disposable /tmp files.
// Prints observations, not an acceptance verdict; all late fake connections are explicitly closed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const req=p=>require(path.join(root,p));
const {RestorePlanService}=req('electron/restore-plan-service.cjs');
const {RestoreSelectionExecutor}=req('electron/restore-selection-executor.cjs');
const {parseAlterRename,evaluateAutocommit,tokenizeSql}=req('electron/sql-script.cjs');
const results={};
async function main(){
  const dir=fs.mkdtempSync('/tmp/sqlpro-r5-');const file=path.join(dir,'backup.sql');
  const profile={id:'p',readOnly:false};const store={getWithSecrets:()=>profile};
  const metadata=()=>({async connect(){},async close(){},async collectRestoreTargetFacts(database){return {database,objects:[{name:'users',type:'table'}],errors:[]}}});
  const service=new RestorePlanService({store,fingerprintProfile:()=> 'fp',createSession:metadata});
  const create='CREATE TABLE `users` (`id` int PRIMARY KEY); ';
  async function fixture(sql,options={}){
    fs.writeFileSync(file,sql);
    const plan=await service.createSelectiveRestorePlan({filePath:file,targetProfileId:'p',targetDatabase:'sample',selection:{tables:['users'],includeStructure:options.includeStructure!==false}});
    const queries=[];
    const worker={async connect(){await options.onConnect?.()},async useDatabase(){},async raw(sql){queries.push(sql);if(sql.startsWith('SELECT @@SESSION.foreign_key_checks'))return {result:[{foreignKeys:1,sqlMode:'',autocommit:1}]};if(options.onRaw)return options.onRaw(sql);return {result:[]}},async close(){await options.onClose?.()}};
    const executor=new RestoreSelectionExecutor({consumePlan:t=>service.consumePlan(t),getProfileWithSecrets:store.getWithSecrets,fingerprintProfile:()=> 'fp',createSession:()=>worker,statementTimeoutMs:options.timeout??40});
    async function run(){try{return {planStatus:plan.status,result:await executor.executePlan({planToken:plan.planToken}),queries}}catch(e){return {planStatus:plan.status,code:e.code,partialCommit:e.partialCommit,targetChanged:e.targetChanged,executionUncertain:e.executionUncertain,queries}}}
    return {run,plan,worker,queries};
  }
  try{
    const alter="ALTER TABLE `users` COMMENT='x\\', RENAME TO `other_db`.`victim` -- '\n;";
    const modeDump=create+"SET SQL_MODE='NO_BACKSLASH_ESCAPES'; "+alter;
    results.modeParser={sql:alter,parse:parseAlterRename(alter),...await (await fixture(modeDump)).run()};
    results.userVariableAutocommit=await (await fixture(create+'SET AUTOCOMMIT=0; SET @autocommit=1; INSERT INTO `users` VALUES (1);')).run();
    results.defaultAutocommit={staticValue:evaluateAutocommit(tokenizeSql('DEFAULT')),...await (await fixture(create+'SET AUTOCOMMIT=DEFAULT; INSERT INTO `users` VALUES (1);')).run()};
    results.commitLostAck=await (await fixture('START TRANSACTION; INSERT INTO `users` VALUES (1); COMMIT;',{includeStructure:false,onRaw(sql){if(sql==='COMMIT')throw Object.assign(Error('lost COMMIT acknowledgement'),{code:'ECONNRESET'});return {result:[]}}})).run();
    let releaseConnect,enter;let open=false,closeCount=0;
    const entered=new Promise(resolve=>{enter=resolve});
    const late=await fixture(create,{timeout:10,onConnect(){enter();return new Promise(resolve=>{releaseConnect=()=>{open=true;resolve()}})},onClose(){closeCount++;open=false}});
    const pending=late.run();await entered;
    const beforeRelease=await pending;const beforeCloseCount=closeCount;
    releaseConnect();await new Promise(resolve=>setTimeout(resolve,20));
    results.lateConnectAfterTimeout={beforeRelease,closeCountBeforeRelease:beforeCloseCount,closeCountAfterRelease:closeCount,connectionOpenAfterLateCompletion:open};
    await late.worker.close();
    const fixtureText=fs.readFileSync(path.join(root,'test/main-schema-migration.test.cjs'),'utf8');
    const body=fixtureText.slice(fixtureText.indexOf('function fixture()'),fixtureText.indexOf('\ntest('));
    const makeMain=new Function('require','path','vm','fs','crypto','DatabaseSession','__dirname',body+';return fixture;')(require('node:module').createRequire(path.join(root,'test/main-schema-migration.test.cjs')),path,vm,fs,crypto,req('electron/database.cjs').DatabaseSession,path.join(root,'test'));
    const r=makeMain();r.profiles.p={readOnly:false,environment:'local'};
    r.evaluate(`restorePlanService.createSession=()=>({async connect(){},async close(){},async collectRestoreTargetFacts(database){return {database,objects:[],errors:[]}}});globalThis.r5Sql=[];restoreSelectionExecutor.createSession=()=>({async connect(){},async close(){},async useDatabase(){},async raw(sql){r5Sql.push(sql);return {result:[]}}});`);
    fs.writeFileSync(file,modeDump);
    const plan=await r.evaluate('restorePlanService').createSelectiveRestorePlan({filePath:file,targetProfileId:'p',targetDatabase:'sample',selection:{tables:['users']}});
    results.mainSqlMode={planStatus:plan.status,response:await r.call('db:apply-selective-restore-plan',{planToken:plan.planToken,profileId:'p'}),queries:r.evaluate('r5Sql')};
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
  console.log(JSON.stringify(results,null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1});
