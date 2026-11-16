'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getContext } = require('../sql-autocomplete.js');
const { loadRenderer } = require('./helpers/renderer.cjs');

function at(marked) { return getContext(marked.replace('|', ''), marked.indexOf('|')); }
const names = marked => at(marked).references[0]?.columnNames;

test('explicit CTE output names are immutable suggestions, including recursive, quoted and inherited declarations', () => {
  const sql = 'WITH recent(id, `tên cột`, `a``b`, `x.y`, `WHERE`) AS (SELECT * FROM invoices) SELECT * FROM recent r WHERE r.|';
  assert.deepEqual(at(sql).references, [{ table: 'recent', alias: 'r', local: true,
    columnNames: ['id', 'tên cột', 'a`b', 'x.y', 'WHERE'] }]);
  assert.equal(Object.isFrozen(names(sql)), true);
  assert.deepEqual(names('WITH RECURSIVE chain(id, parent_id) AS (SELECT * FROM CHAIN c WHERE c.|) SELECT * FROM chain'), ['id', 'parent_id']);
  assert.deepEqual(names('WITH recent(id,total) AS (SELECT 1,2) SELECT * FROM (SELECT * FROM recent r WHERE r.|) d'), ['id', 'total']);
  assert.deepEqual(names('WITH first(id) AS (SELECT 1), second(total) AS (SELECT 2) SELECT * FROM second WHERE |'), ['total']);
});

test('nearest CTE declaration shadows outer names, including unknown and malformed output lists', () => {
  for (const [declaration, expected] of [['c(inner_id)', ['inner_id']], ['c', undefined], ['c(id,id)', undefined]]) {
    assert.deepEqual(names(`WITH c(outer_id) AS (SELECT 1) SELECT * FROM (WITH ${declaration} AS (SELECT 2) SELECT * FROM c WHERE |) d`), expected);
  }
  const sql = 'WITH c(id) AS (SELECT 1) SELECT * FROM (WITH c(other_id) AS (SELECT 2) SELECT * FROM c) d JOIN c ON 1=1 WHERE c.|';
  assert.deepEqual(at(sql).references[1].columnNames, ['id']);
});

test('unsupported explicit declarations stay opaque with no partial names or metadata authority', () => {
  for (const list of ['', 'id,', ',id', 'id,,total', 'id,id', 'id,ID', 'id,x.y', 'id,1', 'id,(total)',
    "id,'literal'", "id 'literal'", 'id "literal"', 'id `,` total', '`' + 'x'.repeat(65) + '`',
    Array.from({ length: 257 }, (_, i) => `c${i}`).join(',')]) {
    const context = at(`WITH c(${list}) AS (SELECT 1) SELECT * FROM c WHERE c.|`);
    assert.equal(context.references[0]?.local, true, list);
    assert.equal(context.references[0]?.columnNames, undefined, list);
  }
  assert.deepEqual(names('WITH c AS (SELECT id AS guessed FROM t) SELECT * FROM c WHERE c.|'), ['guessed']);
  assert.deepEqual(names('SELECT * FROM (SELECT id AS guessed FROM t) c WHERE c.|'), ['guessed']);
  assert.deepEqual(at('WITH c(id) AS (SELECT 1) SELECT * FROM app.c WHERE |').references, [{ table: 'c', database: 'app' }]);
  assert.equal(names('WITH c(id) AS (SELECT 1) SELECT * FROM c() WHERE |'), undefined);
  assert.equal(at('WITH c(id) AS (SELECT 1), C(other) AS (SELECT 2) SELECT * FROM c WHERE |').scopeKnown, false);
});

test('declaration quota accepts 256 complete names and strings/comments do not create phantom names', () => {
  const declared = Array.from({ length: 256 }, (_, i) => `c${i}`);
  assert.deepEqual(names(`WITH c(${declared.join(',')}) AS (SELECT 1) SELECT * FROM c WHERE |`), declared);
  assert.deepEqual(names('WITH c(id /* literal "fake" */, `a\'b`) AS (SELECT 1,2) SELECT * FROM c WHERE |'), ['id', "a'b"]);
});

function renderer() {
  const calls = [];
  const editor = { value: '', selectionStart: 0, selectionEnd: 0, isConnected: true, setAttribute() {}, removeAttribute() {} };
  const r = loadRenderer({ elements: new Map([['#sql', editor]]), desktop: { db: { columns: async (...args) => {
    calls.push(args); return { ok: true, data: [{ name: 'physical_key', type: 'int' }] };
  } } } });
  r.evaluate("mode='query';app.connection={id:'p'};app.database='demo';app.query={id:'q'};app.tables=[{name:'recent'},{name:'r'}];rendered=[];renderSqlSuggestions=(editor,context,items)=>rendered.push(items)");
  const refresh = async marked => {
    editor.value = marked.replace('|', ''); editor.selectionStart = editor.selectionEnd = marked.indexOf('|');
    await r.evaluate("refreshSqlSuggestions($('#sql'),true)");
    return JSON.parse(r.evaluate('JSON.stringify(rendered.at(-1))'));
  };
  return { ...r, calls, editor, refresh };
}

test('renderer suggests declared names without reading local CTEs or their underlying tables and keeps aliases separate', async () => {
  const r = renderer();
  let items = await r.refresh('WITH recent(id,total) AS (SELECT * FROM invoices) SELECT * FROM recent r WHERE r.|');
  assert.deepEqual(items.map(item => item.label), ['r.id', 'r.total']);
  assert.deepEqual(items.map(item => item.insertText), ['`id`', '`total`']);
  assert.ok(items.every(item => item.detail === 'CTE · recent · cột khai báo'));
  assert.equal(r.calls.length, 0);
  items = await r.refresh('WITH recent(id,total) AS (SELECT 1,2) SELECT * FROM recent a JOIN recent b ON 1=1 WHERE |');
  assert.deepEqual(items.map(item => item.label), ['a.id', 'a.total', 'b.id', 'b.total']);
  assert.deepEqual(items.map(item => item.insertText), ['`a`.`id`', '`a`.`total`', '`b`.`id`', '`b`.`total`']);
  assert.equal(r.calls.length, 0);
  items = await r.refresh('WITH recent(id,total) AS (SELECT 1,2) SELECT * FROM recent r JOIN accounts a ON 1=1 WHERE |');
  assert.deepEqual(items.map(item => item.label), ['r.id', 'r.total', 'a.physical_key']);
  assert.deepEqual(r.calls, [['demo', 'accounts', 'p']]);
  items = await r.refresh('WITH recent(id,total) AS (SELECT 1,2) SELECT * FROM recent r JOIN accounts r ON 1=1 WHERE r.|');
  assert.equal(items.length, 0); assert.equal(r.calls.length, 1);
});

test('renderer blocks invalid lists and stale local completions and does not reuse declaration names across statements', async () => {
  const r = renderer();
  assert.deepEqual(await r.refresh('WITH recent(id,id) AS (SELECT 1,2) SELECT * FROM recent r WHERE r.|'), []);
  const marked = 'WITH recent(id) AS (SELECT 1) SELECT * FROM recent r WHERE r.|';
  r.editor.value = marked.replace('|', ''); r.editor.selectionStart = r.editor.selectionEnd = marked.indexOf('|');
  const pending = r.evaluate("refreshSqlSuggestions($('#sql'),true)");
  r.editor.value += ' changed';
  await pending;
  assert.deepEqual(JSON.parse(r.evaluate('JSON.stringify(rendered.at(-1))')), []);
  assert.equal(r.calls.length, 0);
  await r.refresh('WITH recent(id) AS (SELECT 1) SELECT * FROM recent; SELECT * FROM recent r WHERE r.|');
  assert.deepEqual(r.calls, [['demo', 'recent', 'p']]);
});
