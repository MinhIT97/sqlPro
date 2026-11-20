'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createJob } = require('../data-diff-job.js');
const report = () => ({ columns: [], primaryKeys: ['id'], coverage: { complete: true, consistent: true, canSynchronize: false } });
const scope = { sourceProfileId:'s',sourceDb:'sd',sourceTable:'st',targetProfileId:'t',targetDb:'td',targetTable:'tt',rowLimit:500 };
function fixture(overrides = {}) {
  const calls = [], state = { current: true, polls: 0 };
  const db = {
    async startDataDiff(payload) { calls.push(['start',payload]); return {jobId:'job'}; },
    async dataDiffStatus(payload) { calls.push(['status',payload]); return ++state.polls === 1 ? {jobId:'job',status:'running',progress:{totalSource:200}} : {jobId:'job',status:'completed',report:report()}; },
    async cancelDataDiff(payload) { calls.push(['cancel',payload]); return {cancelled:true}; },
    ...overrides
  };
  const progress = [];
  const job = createJob({db,unwrap:async value=>value,isCurrent:()=>state.current,onProgress:p=>progress.push(p),pause:async()=>{}});
  return { job,calls,state,progress };
}
test('job facade polls Main, whitelists scope and keeps reports read-only', async () => {
  const r = fixture(); const value = await r.job.run({...scope,sql:'DELETE FROM users',confirmed:true});
  assert.deepEqual(r.calls[0], ['start',scope]); assert.equal(r.progress[0].totalSource,200);
  assert.equal(value.coverage.canSynchronize,false); assert.equal(r.calls.some(c=>c[0]==='cancel'),false);
});
test('late start after cancel or stale dialog cancels exactly the newly returned job', async () => {
  for (const cancel of [true,false]) {
    let release; const r = fixture({startDataDiff:()=>new Promise(resolve=>{release=resolve;})});
    const pending = r.job.run(scope);
    if (cancel) await r.job.cancel(); else r.state.current=false;
    release({jobId:'late'}); await assert.rejects(pending,{code:'DATA_DIFF_CANCELLED'});
    assert.deepEqual(r.calls,[['cancel',{jobId:'late'}]]);
  }
});
test('configuration drift during status drops the report and cancels only that job', async () => {
  let release; const r = fixture({dataDiffStatus:()=>new Promise(resolve=>{release=resolve;})});
  const pending=r.job.run(scope); await new Promise(resolve=>setImmediate(resolve));
  r.state.current=false; release({jobId:'job',status:'completed',report:report()});
  await assert.rejects(pending,{code:'DATA_DIFF_CANCELLED'});
  assert.deepEqual(r.calls.at(-1),['cancel',{jobId:'job'}]);
});
test('failed, wrong-job and unsafe reports never become usable results', async () => {
  for (const value of [
    {jobId:'job',status:'failed',error:{code:'DATA_DIFF_SCHEMA_MISMATCH',message:'Schema mismatch'}},
    {jobId:'different',status:'completed',report:report()},
    {jobId:'job',status:'completed',report:{...report(),coverage:{canSynchronize:true}}}
  ]) {
    const r=fixture({dataDiffStatus:async()=>value}); await assert.rejects(r.job.run(scope));
    assert.equal(r.calls.at(-1)[0],'cancel');
  }
});
test('polling has a finite budget and timeout cancels Main job', async () => {
  const r=fixture({dataDiffStatus:async()=>({jobId:'job',status:'running',progress:{}})});
  await assert.rejects(r.job.run(scope),{code:'DATA_DIFF_TIMEOUT'});
  assert.equal(r.calls.at(-1)[0],'cancel');
});

test('a hung start times out and its late job is cancelled instead of becoming an orphan',async()=>{
  let release;const cancelled=[];
  const job=createJob({db:{startDataDiff:()=>new Promise(resolve=>{release=resolve;}),cancelDataDiff:async p=>cancelled.push(p)},unwrap:async v=>v,isCurrent:()=>true,timeoutMs:10});
  await assert.rejects(job.run(scope),{code:'DATA_DIFF_TIMEOUT'});
  release({jobId:'late-timeout'});await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(cancelled,[{jobId:'late-timeout'}]);
});
test('cancel interrupts a hung status immediately without waiting for Main acknowledgement',async()=>{
  let started;const ready=new Promise(resolve=>{started=resolve;});
  const job=createJob({db:{startDataDiff:async()=>({jobId:'job'}),dataDiffStatus:()=>{started();return new Promise(()=>{});},cancelDataDiff:()=>new Promise(()=>{})},unwrap:async v=>v,isCurrent:()=>true});
  const pending=job.run(scope);await ready;void job.cancel();
  await assert.rejects(pending,{code:'DATA_DIFF_CANCELLED'});
});
