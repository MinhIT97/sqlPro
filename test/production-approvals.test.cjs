'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {ProductionApprovals,redactSql,parameterSummary} = require('../electron/production-approvals.cjs');
const {DatabaseSession} = require('../electron/database.cjs');
const {loadRenderer} = require('./helpers/renderer.cjs');

test('production approvals expire, are bounded and cannot replay even a failed write',async () => {
  let time = 100;
  let writes = 0;
  const approvals = new ProductionApprovals({ttlMs:10,limit:1,now:()=>time});
  const issue = () => approvals.issue({sql:'UPDATE t SET x=?'},async () => {writes += 1;return 'done';});
  const first = issue();
  assert.equal(first.code,'PRODUCTION_CONFIRM_REQUIRED');
  assert.throws(issue,{code:'PRODUCTION_APPROVAL_BUSY'});
  assert.equal(await approvals.confirm(first.preview.token),'done');
  await assert.rejects(approvals.confirm(first.preview.token),{code:'PRODUCTION_APPROVAL_EXPIRED'});
  const expired = issue();time += 11;
  await assert.rejects(approvals.confirm(expired.preview.token),{code:'PRODUCTION_APPROVAL_EXPIRED'});
  const cancelled = issue();approvals.cancel(cancelled.preview.token);
  await assert.rejects(approvals.confirm(cancelled.preview.token),{code:'PRODUCTION_APPROVAL_EXPIRED'});
  const failure = approvals.issue({},async () => {throw new Error('write failed');});
  await assert.rejects(approvals.confirm(failure.preview.token),/write failed/);
  await assert.rejects(approvals.confirm(failure.preview.token),{code:'PRODUCTION_APPROVAL_EXPIRED'});
  assert.equal(writes,1);
});

test('SQL and parameters hide values and comments while preserving quoted target identifiers',() => {
  const sql = redactSql('UPDATE `app`.`users` SET name=\'sensitive-value\',token=\'private-token\',n=123,blob=0xdeadbeef WHERE id=1; -- comment-secret\n/* block-secret */');
  for (const secret of ['sensitive-value','private-token','123','deadbeef','comment-secret','block-secret']) assert.equal(sql.includes(secret),false,secret);
  assert.match(sql,/`app`.`users`/);
  assert.deepEqual(parameterSummary(['secret',Buffer.from('data'),null]).map((entry)=>entry.type),['string','binary','NULL']);
  assert.equal(JSON.stringify(parameterSummary(['secret'])).includes('secret'),false);
  for (const ambiguous of ['SELECT 1 /*!; DROP TABLE users */','SELECT 1 /*M!; DROP TABLE users */', 'UPDATE t SET x="value"', "UPDATE t SET x='a\\b'"]) {
    assert.throws(()=>redactSql(ambiguous),{code:'PRODUCTION_SQL_PREVIEW_UNSUPPORTED'});
  }
  assert.throws(()=>redactSql('SELECT '+ ' '.repeat(13000) + '1 /*!; DROP TABLE users */'), {code:'PRODUCTION_SQL_PREVIEW_UNSUPPORTED'});
});

test('insert/update previews use the same planner as execution and do not execute SQL',async () => {
  const session = new DatabaseSession({});
  session.listColumns = async () => [{name:'id',type:'int',key:'PRI',extra:'auto_increment',nullable:'NO'},{name:'name',type:'varchar(40)',key:'',extra:'',nullable:'YES'}];
  const captured = [];
  session.raw = async (sql,params) => {captured.push({sql,params});return {result:{insertId:7,affectedRows:1,changedRows:1}};};
  for (const [operation,payload,execute] of [
    ['insert-row',{database:'db',table:'users',values:{name:'new'}},(p)=>session.insertRow(p)],
    ['update-row',{database:'db',table:'users',keys:{id:1},values:{name:'new'},original:{id:1,name:'old'}},(p)=>session.updateRow(p)]
  ]) {
    const count = captured.length;
    const plan = await session.previewRowWrite(operation,payload);
    assert.equal(captured.length,count);
    await execute(payload);
    assert.equal(captured.at(-1).sql,plan.sql);
    assert.deepEqual(captured.at(-1).params,plan.params);
  }
});

test('row preview refreshes cached columns before planning after external DDL', async () => {
  const session = new DatabaseSession({});
  const stale = [{name:'old_column',type:'int',key:'PRI'}];
  session.metadata.set(JSON.stringify(['columns', 'db', 'users']), stale);
  session.listColumns = async (database,table) => {
    const cached = session.metadata.get(JSON.stringify(['columns', database, table]));
    return cached || [{name:'id',type:'int',key:'PRI',extra:''},{name:'new_column',type:'varchar(20)',extra:''}];
  };
  const plan = await session.previewRowWrite('insert-row',{database:'db',table:'users',values:{new_column:'value'}});
  assert.match(plan.sql,/new_column/);
  assert.notEqual(plan.columns,stale);
});

test('renderer approval confirms the exact token and cancellation preserves the write draft',async () => {
  const calls = [];
  const preview = {token:'opaque-token'};
  const r = loadRenderer({desktop:{db:{
    confirmProduction:async (token)=>{calls.push(['confirm',token]);return {ok:true,data:{affectedRows:1}};},
    cancelProduction:async (token)=>{calls.push(['cancel',token]);return {ok:true};}
  }}});
  r.context.response = {ok:false,error:{code:'PRODUCTION_CONFIRM_REQUIRED',preview}};
  r.evaluate('confirmProductionWrite=async () => true');
  assert.equal((await r.evaluate('call(Promise.resolve(response))')).affectedRows,1);
  r.evaluate('confirmProductionWrite=async () => false');
  await assert.rejects(r.evaluate('call(Promise.resolve(response))'),{code:'PRODUCTION_WRITE_CANCELLED'});
  assert.deepEqual(calls,[['confirm','opaque-token'],['cancel','opaque-token']]);
});

test('production preview escapes metadata and displays explicit target, masked SQL and unknown row counts',() => {
  const r = loadRenderer();
  const html = r.evaluate(`productionPreviewHtml({connectionName:'Prod <script>',host:'db',database:'target',operation:'query',selectedRows:null,sql:'UPDATE <x> SET x=?',parameters:[],parameterCount:0,note:'note'})`);
  assert.match(html,/Prod &lt;script&gt;/);
  assert.match(html,/target/);
  assert.match(html,/Số dòng ảnh hưởng chưa xác định/);
  assert.doesNotMatch(html,/<script>|<x>/);
});
