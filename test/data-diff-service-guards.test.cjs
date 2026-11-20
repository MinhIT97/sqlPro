'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {DataDiffService}=require('../electron/data-diff-service.cjs');
function fixture() {
  const profiles={s:{id:'s',host:'fixture'},t:{id:'t',host:'fixture'}}, state={targetType:'int',value:'x'};
  const service=new DataDiffService({store:{getWithSecrets:id=>profiles[id]},createSession:profile=>({
    async connect(){},async useDatabase(){},async close(){},
    async listColumns(){return [{name:'id',type:'int',key:'PRI'},{name:'value',type:profile.id==='s'?'int':state.targetType,key:''}];},
    async raw(sql){
      if(sql.includes('information_schema.TABLES'))return {result:[{engine:'InnoDB'}]};
      return {rows:/^SELECT/.test(sql)?[[1,state.value]]:[]};
    }
  })});
  const run=async()=>{
    const {jobId}=await service.startDiff({sourceProfileId:'s',targetProfileId:'t',sourceDb:'d',targetDb:'d',sourceTable:'a',targetTable:'b'});
    await service.jobs.get(jobId).promise;return jobId;
  };
  return {service,profiles,state,run};
}
test('completed reports expire and profile changes cannot return stale rows through status',async()=>{
  const r=fixture();r.state.value='1';const id=await r.run();assert.equal(r.service.getDiffStatus(id).status,'completed');
  r.profiles.t.host='different';const stale=r.service.getDiffStatus(id);
  assert.equal(stale.status,'failed');assert.equal(stale.report,null);assert.equal(stale.error.code,'DATA_DIFF_CONTEXT_CHANGED');
  r.service.jobs.get(id).completedAt=Date.now()-r.service.jobTtlMs-1;
  assert.throws(()=>r.service.getDiffStatus(id),{code:'DATA_DIFF_JOB_NOT_FOUND'});
});
test('report byte budget fails closed and completed job retention stays bounded',async()=>{
  const r=fixture();r.state.value='1';r.service.maxReportBytes=32;
  assert.equal(r.service.getDiffStatus(await r.run()).error.code,'DATA_DIFF_BUDGET_EXCEEDED');
  r.service.maxReportBytes=4096;r.service.maxJobs=3;
  for(let i=0;i<6;i++)await r.run();
  assert.equal(r.service.jobs.size,3);
});
test('schema comparison retains ENUM literal case instead of accepting semantic differences',async()=>{
  let index=0;const r=fixture();r.service.createSession=()=>{
    const side=index++;
    return {async connect(){},async useDatabase(){},async close(){},
      async listColumns(){return [{name:'id',type:'int',key:'PRI'},{name:'value',type:side===0?"enum('Ready')":"enum('ready')",key:''}];},
      async raw(sql){return {result:sql.includes('information_schema.TABLES')?[{engine:'InnoDB'}]:[],rows:[]};}
    };
  };
  assert.equal(r.service.getDiffStatus(await r.run()).error.code,'DATA_DIFF_SCHEMA_MISMATCH');
});
