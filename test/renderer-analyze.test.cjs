'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRenderer } = require('./helpers/renderer.cjs');

const result = () => ({ kind: 'rows', isAnalyze: true, isExplain: true, explainFormat: 'JSON',
  analysis: { version: 1, executed: true, engine: 'MariaDB' }, columns: [{ name: 'ANALYZE', type: 'TEXT' }],
  rows: [['{"query_block":{"r_rows":2,"condition":"<img src=x onerror=alert(1)>"}}']], durationMs: 10 });

function fixture(response = async () => ({ ok: true, data: result() })) {
  const requests = [], files = [], unexpected = [];
  const editor = { value: 'SELECT * FROM items', selectionStart: 0, selectionEnd: 0, setAttribute() {}, removeAttribute() {} };
  const button = { disabled: false };
  const r = loadRenderer({ desktop: { db: {
    analyzeQuery: async request => { requests.push(structuredClone(request)); return response(request); },
    query: async () => { unexpected.push('query'); return {}; },
    exportQuery: async () => { unexpected.push('exportQuery'); return {}; }
  }, saveTextFile: async payload => { files.push(payload); return { canceled: false }; } },
  elements: new Map([['#sql', editor], ['#analyzeQueryBtn', button], ['#queryResult', { innerHTML: '' }], ['#status', { textContent: '' }]]) });
  r.evaluate("app.connections=[{id:'p1',name:'Fixture'}];app.connection=app.connections[0];app.database='demo';mode='query';renderQueryTabs=()=>{}");
  return { ...r, requests, files, unexpected, editor, button };
}

test('ANALYZE sends one captured SELECT with capped timeout, escapes native result, clears comparison and exports cached bytes only', async () => {
  const r = fixture();
  r.evaluate("app.query.result={explainComparison:{version:1,status:'baseline'}};app.query.lastSql='EXPLAIN ANALYZE SELECT 1'");
  await r.evaluate('runAnalyzeQuery()');
  assert.equal(r.requests.length, 1); assert.equal(r.requests[0].sql, 'SELECT * FROM items');
  assert.equal(r.requests[0].database, 'demo'); assert.equal(r.requests[0].timeoutMs, 60000);
  assert.equal(r.evaluate('app.query.lastSql'), null); assert.equal(r.evaluate('app.query.running'), false);
  const html = r.evaluate('queryResultHtml()');
  assert.match(html, /ANALYZE đã thực thi SELECT/); assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img|Đọc kế hoạch EXPLAIN|So sánh hai lần EXPLAIN/);
  // Even stale/reintroduced lastSql must not cause the export action to replay.
  r.evaluate("app.query.lastSql='EXPLAIN ANALYZE SELECT 1'");
  await r.evaluate("exportCurrentResult('json')"); await r.evaluate("exportCurrentResult('csv')");
  assert.equal(r.files.length, 2); assert.equal(JSON.parse(r.files[0].contents)[0].ANALYZE, result().rows[0][0]);
  assert.deepEqual(r.unexpected, []); assert.equal(r.evaluate('historyRows.length'), 0);
});

test('ANALYZE cancellation retains prior output, errors do not retry or request generic confirmation, and incomplete results cannot be replayed for export', async () => {
  for (const outcome of [{ ok: true, data: { canceled: true } }, { ok: false, error: { code: 'CONFIRM_REQUIRED', message: 'Expected failure' } }]) {
    const r = fixture(async () => outcome);
    r.evaluate("app.query.result={kind:'rows',columns:[{name:'old'}],rows:[[1]],explainComparison:{version:1,status:'baseline'}};confirmAction=()=>{throw Error('unexpected generic confirmation')}");
    await r.evaluate('runAnalyzeQuery()');
    assert.equal(r.requests.length, 1); assert.equal(r.evaluate('app.query.result.columns[0].name'), 'old');
    assert.equal(r.evaluate('app.query.result.explainComparison'), undefined); assert.equal(r.evaluate('app.query.running'), false);
    assert.equal(r.evaluate('app.query.error'), outcome.ok ? null : 'Expected failure');
  }
  const r = fixture(async () => ({ ok: true, data: { ...result(), truncated: true } }));
  await r.evaluate('runAnalyzeQuery()'); await r.evaluate("exportCurrentResult('json')");
  assert.equal(r.files.length, 0); assert.deepEqual(r.unexpected, []);
});

test('ANALYZE captures selection and target before await, blocks read-only/busy/stale contexts and ignores late logout results', async () => {
  const r = fixture();
  r.editor.value = 'SELECT 1; SELECT 2'; r.editor.selectionStart = 10; r.editor.selectionEnd = 18;
  r.evaluate('ensureQueryTarget=async()=>{ await Promise.resolve();app.query.database="other";return {profileId:"p1",database:"captured",connection:{id:"p1"}} }');
  const pending = r.evaluate('runAnalyzeQuery()'); r.editor.value = 'DELETE FROM items'; await pending;
  assert.equal(r.requests[0].sql, 'SELECT 2'); assert.equal(r.requests[0].database, 'captured');
  for (const variant of ['read-only', 'busy', 'stale']) {
    const blocked = fixture();
    if (variant === 'read-only') blocked.evaluate('app.connection.readOnly=true');
    if (variant === 'busy') blocked.evaluate('app.query.running=true');
    if (variant === 'stale') blocked.evaluate('ensureQueryTarget=async()=>{resetExplainComparisons();return {profileId:"p1",database:"demo"}}');
    await blocked.evaluate('runAnalyzeQuery()'); assert.equal(blocked.requests.length, 0, variant);
  }
  let finish;
  const late = fixture(() => new Promise(resolve => { finish = resolve; }));
  const task = late.evaluate('runAnalyzeQuery()');
  while (!finish) await Promise.resolve();
  late.evaluate('resetExplainComparisons();app.query.result=null');
  finish({ ok: true, data: result() }); await task; assert.equal(late.evaluate('app.query.result'), null);
});

test('late ANALYZE success/cancel/error cannot replace a newer task or refresh state after invalidation', async () => {
  for (const variant of ['reset', 'superseded', 'closed', 'canceled']) {
    for (const outcome of [{ ok: true, data: result() }, { ok: true, data: { canceled: true } },
      { ok: false, error: { message: 'stale failure' } }]) {
      let finish;
      const r = fixture(() => new Promise(resolve => { finish = resolve; }));
      r.evaluate("app.query.result={kind:'rows',columns:[{name:'saved'}],rows:[['kept']]};refreshes=0;refreshSessionState=async()=>{refreshes++}");
      const task = r.evaluate('runAnalyzeQuery()');
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(typeof finish, 'function');
      r.evaluate("savedTab=app.query;app.query.error='current error'");
      if (variant === 'reset') r.evaluate('resetExplainComparisons()');
      if (variant === 'superseded') r.evaluate("app.query.taskId='new-task';app.query.running=true");
      if (variant === 'closed') r.evaluate('queryTabs=[]');
      if (variant === 'canceled') r.evaluate('app.query.running=false;app.query.taskId=null');
      const before = r.evaluate("JSON.stringify({result:savedTab.result,error:savedTab.error,status:$('#status').textContent})");
      const count = r.messages.length;
      finish(outcome); await task;
      assert.equal(r.evaluate("JSON.stringify({result:savedTab.result,error:savedTab.error,status:$('#status').textContent})"), before, variant);
      assert.equal(r.messages.length, count, variant); assert.equal(r.evaluate('refreshes'), 0, variant);
      assert.equal(r.evaluate('savedTab.taskId'), variant === 'superseded' ? 'new-task' : null);
      assert.equal(r.evaluate('savedTab.running'), variant === 'superseded');
    }
  }
});
