'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRenderer } = require('./helpers/renderer.cjs');

const rowResult = () => ({ kind: 'rows', columns: [{ name: 'value', type: 'INT' }], rows: [[1]], durationMs: 1 });
function setup(query = async () => ({ ok: true, data: rowResult() })) {
  const requests = [];
  const editor = { value: 'SELECT 1', selectionStart: 0, selectionEnd: 0, setAttribute() {}, removeAttribute() {} };
  const renderer = loadRenderer({ desktop: { db: { query: async (payload) => {
    requests.push(structuredClone(payload));
    return query(payload);
  } } }, elements: new Map([['#sql', editor], ['#queryResult', { innerHTML: '' }], ['#status', { textContent: '' }]]) });
  renderer.evaluate("app.connection={id:'test', name:'Mock'}; app.database='test'; mode='query'; renderQueryTabs=()=>{};");
  return { ...renderer, requests, editor };
}

test('query: selected SQL is executed and saved as text without a DOM named global', async () => {
  const r = setup();
  r.editor.value = 'SELECT 1; SELECT 2;';
  r.editor.selectionStart = 10;
  r.editor.selectionEnd = r.editor.value.length;
  await r.evaluate('runQuery()');
  assert.equal(r.requests[0].sql, 'SELECT 2;');
  assert.equal(r.evaluate('historyRows[0].sql'), 'SELECT 2;');
  assert.equal(r.evaluate('app.query.result.kind'), 'rows');
  assert.equal(r.evaluate('app.query.error'), null);
});

test('query: failed SQL produces a readable error and string history', async () => {
  const r = setup(async () => ({ ok: false, error: { message: 'Syntax failure', code: 'SQL_ERROR' } }));
  await r.evaluate('runQuery()');
  assert.equal(r.evaluate('app.query.error'), 'Syntax failure');
  assert.equal(r.evaluate('historyRows[0].sql'), 'SELECT 1');
  assert.equal(r.evaluate('historyRows[0].ok'), false);
  assert.equal(r.evaluate('app.query.running'), false);
});

test('query: switching away while executing preserves results without touching a removed grid', async () => {
  let complete;
  const r = setup(() => new Promise((resolve) => { complete = resolve; }));
  const pending = r.evaluate('runQuery()');
  r.elements.delete('#sql');
  r.elements.delete('#queryResult');
  r.evaluate("mode='structure'");
  complete({ ok: true, data: rowResult() });
  await pending;
  assert.equal(r.evaluate('app.query.result.kind'), 'rows');
  assert.equal(r.evaluate('app.query.running'), false);
});

test('EXPLAIN: caret selects a single statement and clears stale error/sort state', async () => {
  const r = setup();
  r.editor.value = "SELECT ';'; SELECT * FROM users";
  r.editor.selectionStart = r.editor.selectionEnd = r.editor.value.length;
  r.evaluate("app.query.error='previous failure'; app.query.sortCol=2");
  await r.evaluate('runExplainQuery()');
  assert.equal(r.requests[0].sql, 'EXPLAIN SELECT * FROM users');
  assert.equal(r.evaluate('app.query.result.isExplain'), true);
  assert.equal(r.evaluate('app.query.error'), null);
  assert.equal(r.evaluate('app.query.sortCol'), null);
});

test('EXPLAIN: selected batches cannot execute later statements', async () => {
  const r = setup();
  r.editor.value = 'SELECT 1; DELETE FROM users';
  r.editor.selectionEnd = r.editor.value.length;
  await r.evaluate('runExplainQuery()');
  assert.equal(r.requests.length, 0);
  assert.match(r.messages.at(-1).message, /một câu lệnh/);
});

test('EXPLAIN: an active query prevents a competing request', async () => {
  const r = setup();
  r.evaluate('app.query.running=true');
  await r.evaluate('runExplainQuery()');
  assert.equal(r.requests.length, 0);
  assert.equal(r.evaluate('app.query.running'), true);
});

test('data grid: an older sort response cannot replace the latest data', async () => {
  const pending = [];
  const r = loadRenderer({ desktop: { db: { tableData: () => new Promise((resolve) => pending.push(resolve)) } },
    elements: new Map([['#workspace', { innerHTML: '' }], ['#status', { textContent: '' }]]) });
  r.evaluate("app.connection={id:'test'}; app.database='test'; table='users'; mode='data'; updateChrome=()=>{}; renderDataView=()=>{};");
  const first = r.evaluate('loadData()');
  const second = r.evaluate("app.orderBy='name'; loadData()");
  const data = (name) => ({ ok: true, data: { columns: [], primaryKey: ['id'], rows: [{ id: 1, name }], total: 1, page: 1, pageSize: 100 } });
  pending[1](data('latest'));
  await second;
  pending[0](data('stale'));
  await first;
  assert.equal(r.evaluate('app.rows[0].name'), 'latest');
});
