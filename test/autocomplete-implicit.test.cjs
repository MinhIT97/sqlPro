'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getContext } = require('../sql-autocomplete.js');
const { loadRenderer } = require('./helpers/renderer.cjs');

const at = marked => getContext(marked.replace('|', ''), marked.indexOf('|'));
const derived = projection => at(`SELECT * FROM (SELECT ${projection}) d WHERE d.|`).references[0];
const cte = projection => at(`WITH c AS (SELECT ${projection}) SELECT * FROM c WHERE c.|`).references[0];

test('implicit aliases replace direct paths without changing unaliased path semantics', () => {
  for (const source of [cte, derived]) {
    assert.deepEqual(source('id item_id, t.name label, app.t.total amount, t.created_at FROM app.t').columnNames,
      ['item_id', 'label', 'amount', 'created_at']);
    assert.deepEqual(source('DISTINCT id item_id FROM t').columnNames, ['item_id']);
    assert.deepEqual(source('ALL id item_id FROM t').columnNames, ['item_id']);
    assert.deepEqual(source('`t``x`.`a.b` `tên cột`, id `a``b`, id `AND`, id `,` FROM t').columnNames,
      ['tên cột', 'a`b', 'AND', ',']);
  }
});

test('simple function/group aliases retain names only and ignore commas, literals and AS inside groups', () => {
  const reference = derived("COUNT(*) total, CONCAT(a, 'PRIVATE_VALUE', b) label, CAST(a AS DECIMAL(10,2)) amount, (a+b) sum_value, (SELECT MAX(secret) FROM hidden) latest FROM t");
  assert.deepEqual(reference.columnNames, ['total', 'label', 'amount', 'sum_value', 'latest']);
  assert.equal(JSON.stringify(reference).includes('PRIVATE_VALUE'), false);
  assert.equal(JSON.stringify(reference).includes('secret'), false);
  assert.equal(Object.isFrozen(reference.columnNames), true);
  assert.deepEqual(derived('COUNT(*) total, id AS explicit_name, t.name FROM t').columnNames, ['total', 'explicit_name', 'name']);
});

test('trivia separates aliases, while lexer-hidden values and ambiguous token adjacency stay opaque', () => {
  assert.deepEqual(derived('id/* AS fake, FROM hidden */item_id, COUNT(*)\n-- comment\ntotal FROM t').columnNames,
    ['item_id', 'total']);
  for (const projection of [
    "id 'literal' label FROM t", "id label 'literal' FROM t", "'literal' label FROM t", '"literal" label FROM t',
    "COUNT(*) 'literal' label FROM t", "COUNT(*) label 'literal' FROM t", "id 'a' 'b' label FROM t",
    'COUNT(*)total FROM t', '(a+b)label FROM t', '`id`label FROM t', 'id`label` FROM t',
    'a+b total FROM t', 'a + b FROM t', 'id AND FROM t', 'id OR FROM t', 'id XOR FROM t',
    'id COLLATE FROM t', 'id COLLATE utf8mb4_bin FROM t', 'id DIV FROM t', 'id MOD FROM t', 'id IS FROM t',
    'id LIKE FROM t', 'id BETWEEN FROM t', 'id DESC FROM t', 'COUNT(*) OVER FROM t',
    'CURRENT_TIMESTAMP stamp FROM t', 'NULL value FROM t', '1 one FROM t', '* name FROM t', 't.* name FROM t',
    'app.fn(a) result FROM t', 'CASE WHEN x=1 THEN 2 ELSE 3 END label FROM t'
  ]) assert.equal(derived(projection).columnNames, undefined, projection);
});

test('implicit names obey complete-list, casefold/length quotas, declaration precedence and nested scope guards', () => {
  assert.equal(derived('id item_id, name ITEM_ID FROM t').columnNames, undefined);
  assert.equal(derived('id item_id, a+b FROM t').columnNames, undefined);
  assert.equal(derived('id `' + 'x'.repeat(65) + '` FROM t').columnNames, undefined);
  const columns = Array.from({ length: 256 }, (_, index) => `c${index}`);
  assert.deepEqual(derived(columns.map(name => `id ${name}`).join(',')).columnNames, columns);
  assert.equal(derived(columns.map(name => `id ${name}`).join(',') + ',id overflow').columnNames, undefined);
  assert.deepEqual(at('WITH c(declared) AS (SELECT id inferred FROM t) SELECT * FROM c WHERE c.|').references[0].columnNames, ['declared']);
  assert.equal(at('WITH c(id,id) AS (SELECT id inferred FROM t) SELECT * FROM c WHERE c.|').references[0].columnNames, undefined);
  assert.deepEqual(at('WITH c AS (SELECT id outer_id FROM t) SELECT * FROM (WITH c AS (SELECT id inner_id FROM u) SELECT * FROM c WHERE c.|) d').references[0].columnNames, ['inner_id']);
  assert.equal(at('WITH c AS (SELECT id outer_id FROM t) SELECT * FROM (WITH c AS (SELECT a+b FROM u) SELECT * FROM c WHERE c.|) d').references[0].columnNames, undefined);
});

test('renderer suggests implicit names locally, keeps source labels and reads only physical JOIN metadata', async () => {
  const calls = [];
  const editor = { value: '', selectionStart: 0, selectionEnd: 0, isConnected: true, setAttribute() {}, removeAttribute() {} };
  const r = loadRenderer({ elements: new Map([['#sql', editor]]), desktop: { db: { columns: async (...args) => {
    calls.push(args); return { ok: true, data: [{ name: 'physical_key', type: 'int' }] };
  } } } });
  r.evaluate("mode='query';app.connection={id:'p'};app.database='demo';app.query={id:'q'};app.tables=[{name:'c'},{name:'d'}];rendered=[];renderSqlSuggestions=(editor,context,items)=>rendered.push(items)");
  const refresh = async marked => {
    editor.value = marked.replace('|', ''); editor.selectionStart = editor.selectionEnd = marked.indexOf('|');
    await r.evaluate("refreshSqlSuggestions($('#sql'),true)");
    return JSON.parse(r.evaluate('JSON.stringify(rendered.at(-1))'));
  };
  let items = await refresh('WITH c AS (SELECT id item_id, COUNT(*) total FROM invoices) SELECT * FROM c WHERE c.|');
  assert.deepEqual(items.map(item => item.label), ['c.item_id', 'c.total']);
  assert.ok(items.every(item => item.detail === 'CTE · c · tên từ SELECT'));
  items = await refresh('SELECT * FROM (SELECT id `tên cột` FROM invoices) d WHERE d.|');
  assert.deepEqual(items.map(item => item.insertText), ['`tên cột`']);
  assert.equal(items[0].detail, 'Derived · d · tên từ SELECT');
  assert.equal(calls.length, 0);
  items = await refresh('SELECT * FROM (SELECT id item_id FROM invoices) d JOIN accounts a ON 1=1 WHERE |');
  assert.deepEqual(items.map(item => item.label), ['d.item_id', 'a.physical_key']);
  assert.deepEqual(calls, [['demo', 'accounts', 'p']]);
  assert.deepEqual(await refresh('SELECT * FROM (SELECT id COLLATE FROM invoices) d WHERE d.|'), []);
  assert.equal(calls.length, 1);
});
