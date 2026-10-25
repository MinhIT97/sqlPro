'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRenderer } = require('./helpers/renderer.cjs');

const rowResult = () => ({ kind: 'rows', columns: [{ name: 'value', type: 'INT' }], rows: [[1]], durationMs: 1 });
test('sorted renderer keeps original row IDs without calling indexOf for each row', () => {
  const r = loadRenderer();
  const html = r.evaluate(`(()=>{app.query={sortCol:0,sortDir:'DESC'};const rows=[[1],[3],[2]];rows.indexOf=()=>{throw new Error('quadratic lookup')};return singleQueryResultHtml({kind:'rows',columns:[{name:'id'}],rows,durationMs:1});})()`);
  const indexes = [...html.matchAll(/<tr data-query-row="(\d+)"/g)].map((match) => Number(match[1]));
  assert.deepEqual(indexes, [1, 2, 0]);
});
function exportElements() {
  return new Map([['#modal', { open: false, showModal() { this.open = true; }, close() { this.open = false; } }]]);
}

test('small query exports use full backend values and expose a cancellable captured task', async () => {
  const requests = [], canceled = [];
  let finish;
  const r = loadRenderer({ elements: exportElements(), desktop: { db: {
    exportQuery: (payload) => { requests.push(structuredClone(payload)); return new Promise((resolve) => { finish = resolve; }); },
    cancelTask: async (profileId, taskId) => { canceled.push({ profileId, taskId }); return { ok: true, data: { canceled: true } }; }
  } } });
  r.evaluate(`app.query={lastSql:'SELECT raw FROM items',profileId:'other',database:'other',resultContext:{profileId:'original',database:'demo'},result:{kind:'rows',columns:[{name:'raw',type:'BLOB'}],rows:[['0x00… (64 bytes)']],truncated:false}}`);
  const pending = r.evaluate("exportCurrentResult('json')");
  assert.match(r.elements.get('#modal').innerHTML, /SQL được chạy lại/);
  await r.evaluate("exportCurrentResult('json')");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].profileId, 'original');
  assert.equal(requests[0].database, 'demo');
  await r.evaluate('cancelActiveTransfer()');
  assert.deepEqual(canceled[0], { profileId: 'original', taskId: requests[0].taskId });
  finish({ ok: true, data: { canceled: true } });
  await pending;
  assert.equal(r.evaluate('activeTransfer'), null);
  assert.equal(r.elements.get('#modal').open, false);
});

test('export without source SQL blocks incomplete previews and preserves special JSON names', async () => {
  const files = [];
  const r = loadRenderer({ desktop: { saveTextFile: async (payload) => { files.push(payload); return { canceled: false }; } } });
  r.evaluate(`app.query={result:{kind:'rows',columns:[{name:'raw',type:'BLOB'}],rows:[['0x00… (64 bytes)']]}}`);
  await r.evaluate("exportCurrentResult('json')");
  assert.equal(files.length, 0);
  r.evaluate(`app.query.result={kind:'rows',columns:[{name:'__proto__',type:'JSON'},{name:'value',type:'VARCHAR'}],rows:[['{"n":9007199254740993}','text']]}`);
  await r.evaluate("exportCurrentResult('json')");
  const parsed = JSON.parse(files[0].contents);
  assert.equal(Object.hasOwn(parsed[0], '__proto__'), true);
  assert.ok(files[0].contents.includes('"n":9007199254740993'));
  assert.equal(parsed[0].value, 'text');
});
function setup(query = async () => ({ ok: true, data: rowResult() })) {
  const requests = [];
  const editor = { value: 'SELECT 1', selectionStart: 0, selectionEnd: 0, setAttribute() {}, removeAttribute() {} };
  const renderer = loadRenderer({ desktop: { db: { query: async (payload) => {
    requests.push(structuredClone(payload));
    return query(payload);
  } } }, elements: new Map([['#sql', editor], ['#queryResult', { innerHTML: '' }], ['#status', { textContent: '' }]]) });
  renderer.evaluate("app.connections=[{id:'test', name:'Mock'}]; app.connection={id:'test', name:'Mock'}; app.database='test'; mode='query'; renderQueryTabs=()=>{};");
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

test('query result export distinguishes NULL from empty and disambiguates JSON names', async () => {
  const files = [];
  const r = loadRenderer({ desktop: { saveTextFile: async (payload) => { files.push(payload); return { canceled: false }; } } });
  r.evaluate(`
    app.query = {
      result: { kind: 'rows', columns: [{ name: 'a' }, { name: 'a' }, { name: 'c' }], rows: [[null, '', 'x']] },
      lastSql: 'SELECT 1'
    };
  `);
  await r.evaluate("exportCurrentResult('csv')");
  await r.evaluate("exportCurrentResult('json')");
  assert.equal(files[0].contents, '﻿a,a,c\r\n\\N,,x');
  assert.deepEqual(JSON.parse(files[1].contents), [{ a: null, a_2: '', c: 'x' }]);
});

test('query result export re-runs a truncated single result through the backend', async () => {
  const requests = [];
  const files = [];
  const r = loadRenderer({ desktop: {
    saveTextFile: async (payload) => { files.push(payload); return { canceled: false }; },
    db: {
      exportQuery: async (payload) => {
        requests.push(structuredClone(payload));
        return { ok: true, data: { canceled: false, rows: 6000 } };
      }
    }
  }, elements: exportElements() });
  r.evaluate(`
    app.query = {
      result: { kind: 'rows', columns: [{ name: 'id' }], rows: [[1]], truncated: true },
      lastSql: 'SELECT id FROM items',
      profileId: 'p1',
      database: 'demo'
    };
  `);
  await r.evaluate("exportCurrentResult('csv')");
  const { taskId, ...request } = requests[0];
  assert.match(taskId, /^export-/);
  assert.deepEqual(request, {
    sql: 'SELECT id FROM items',
    profileId: 'p1',
    database: 'demo',
    format: 'csv'
  });
  assert.equal(files.length, 0);
  assert.match(r.messages.at(-1).message, /toàn bộ 6000 dòng/);
});

test('batch result export re-runs the selected truncated statement', async () => {
  const requests = [];
  const r = loadRenderer({ desktop: {
    saveTextFile: async () => ({ canceled: true }),
    db: {
      exportQuery: async (payload) => {
        requests.push(structuredClone(payload));
        return { ok: true, data: { canceled: false, rows: 123 } };
      }
    }
  }, elements: exportElements() });
  r.evaluate(`
    app.query = {
      result: { kind: 'batch', results: [
        { index: 1, sql: 'SELECT a FROM t1', ok: true, result: { kind: 'rows', columns: [{ name: 'a' }], rows: [[1]], truncated: true } },
        { index: 2, sql: 'SELECT b FROM t2', ok: true, result: { kind: 'rows', columns: [{ name: 'b' }], rows: [[2]], truncated: true } }
      ] },
      resultTab: 'result-2',
      lastSql: 'SELECT a FROM t1; SELECT b FROM t2',
      profileId: 'p1',
      database: 'demo'
    };
  `);
  await r.evaluate("exportCurrentResult('json')");
  assert.equal(requests[0].sql, 'SELECT b FROM t2');
  assert.equal(requests[0].format, 'json');
});

test('query: switching away while executing preserves results without touching a removed grid', async () => {
  let complete;
  const r = setup(() => new Promise((resolve) => { complete = resolve; }));
  const pending = r.evaluate('runQuery()');
  await new Promise((resolve) => setImmediate(resolve));
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
  assert.match(r.evaluate('app.query.lastSql'), /^EXPLAIN /);
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

test('query results: renders row/col metadata and editable badge when PK is present', async () => {
  const r = setup();
  const html = r.evaluate(`
    singleQueryResultHtml({
      kind: 'rows',
      columns: [
        { name: 'id', table: 'users', type: 'INT', flags: 2 },
        { name: 'username', table: 'users', type: 'VARCHAR', flags: 0 }
      ],
      rows: [[1, 'john_doe']],
      durationMs: 5
    });
  `);
  assert.match(html, /data-query-row="0"/);
  assert.match(html, /data-col="username"/);
  assert.match(html, /data-col-idx="1"/);
  assert.match(html, /Sửa trực tiếp: Bật/);
});

test('query results: getQueryColumnPkInfo recognizes primary key and allows update', async () => {
  const updateCalls = [];
  const r = loadRenderer({
    desktop: {
      db: {
        updateRow: async (payload) => {
          updateCalls.push(payload);
          return { affectedRows: 1 };
        }
      }
    },
    elements: new Map([
      ['#status', { textContent: '' }],
      ['#toast', { textContent: '', style: {}, setAttribute() {} }]
    ])
  });

  r.evaluate(`
    app.connection = { id: 'test', name: 'Mock' };
    app.database = 'testdb';
    app.query = {
      result: {
        kind: 'rows',
        columns: [
          { name: 'id', orgName: 'id', table: 'users', type: 'INT', flags: 2 },
          { name: 'username', orgName: 'username', table: 'users', type: 'VARCHAR', flags: 0 }
        ],
        rows: [[2887, 'paul.brigham']]
      }
    };
  `);

  const info = await r.evaluate(`getQueryColumnPkInfo(app.query.result, 1)`);
  assert.equal(info.editable, true);
  assert.equal(info.table, 'users');
  assert.equal(info.colName, 'username');
  assert.equal(info.pkCols.length, 1);
  assert.equal(info.pkCols[0].index, 0);
});
