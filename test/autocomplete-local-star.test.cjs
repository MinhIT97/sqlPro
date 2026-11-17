'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getContext } = require('../sql-autocomplete.js');
const { loadRenderer } = require('./helpers/renderer.cjs');

const at = marked => getContext(marked.replace('|', ''), marked.indexOf('|'));
const columns = marked => at(marked).references[0]?.columnNames;

test('local star expansion preserves declaration order, aliases and complete mixed projections', () => {
  for (const star of ['*', 'r.*', 'r /* keep */ . *']) {
    const marked = `WITH source(id,total) AS (SELECT 1,2), recent AS (SELECT ${star}, 1 AS extra FROM source r WHERE r.id>0) SELECT * FROM recent WHERE recent.|`;
    assert.deepEqual(columns(marked), ['id', 'total', 'extra']);
    assert.equal(Object.isFrozen(columns(marked)), true);
  }
  assert.deepEqual(columns('WITH source AS (SELECT id item_id, COUNT(*) total FROM invoices), recent AS (SELECT * FROM source) SELECT * FROM recent WHERE recent.|'), ['item_id', 'total']);
  assert.deepEqual(columns('SELECT * FROM (SELECT d.* FROM (SELECT id item_id, name label FROM invoices) d) recent WHERE recent.|'), ['item_id', 'label']);
  assert.deepEqual(columns('SELECT * FROM (SELECT * FROM (SELECT id FROM (SELECT 1 AS id) x) d) recent WHERE recent.|'), ['id']);
  const literal = at("SELECT * FROM (SELECT * FROM (SELECT 'PRIVATE_VALUE' AS label) d) recent WHERE recent.|").references[0];
  assert.deepEqual(literal.columnNames, ['label']); assert.doesNotMatch(JSON.stringify(literal), /PRIVATE_VALUE/);
});

test('quoted Unicode names, stars and keywords remain exact while inherited and nested CTE bindings shadow correctly', () => {
  assert.deepEqual(columns('WITH `nguồn`(`tên cột`,`a``b`,`x.y`,`*`,`WHERE`) AS (SELECT 1), recent AS (SELECT `r``x`.* FROM `nguồn` `r``x`) SELECT * FROM recent WHERE recent.|'), ['tên cột', 'a`b', 'x.y', '*', 'WHERE']);
  assert.deepEqual(columns('WITH c(outer_id) AS (SELECT 1) SELECT * FROM (SELECT * FROM c) d WHERE d.|'), ['outer_id']);
  assert.deepEqual(columns('WITH c(outer_id) AS (SELECT 1) SELECT * FROM (WITH c(inner_id) AS (SELECT 2) SELECT * FROM c) d WHERE d.|'), ['inner_id']);
  assert.equal(columns('WITH c(outer_id) AS (SELECT 1) SELECT * FROM (WITH c AS (SELECT * FROM physical_t) SELECT * FROM c) d WHERE d.|'), undefined);
  assert.equal(columns('WITH c(outer_id) AS (SELECT 1) SELECT * FROM (WITH c(id,id) AS (SELECT 2) SELECT * FROM c) d WHERE d.|'), undefined);
});

test('local set branches expand independently and retain only first-arm names with the usual arity guard', () => {
  assert.deepEqual(columns('WITH a(id,total) AS (SELECT 1,2), b(other_id,other_total) AS (SELECT 3,4), recent AS (SELECT a.* FROM a UNION ALL SELECT * FROM b) SELECT * FROM recent WHERE recent.|'), ['id', 'total']);
  assert.equal(columns('WITH a(id,total) AS (SELECT 1,2), b(other) AS (SELECT 3), recent AS (SELECT * FROM a UNION ALL SELECT * FROM b) SELECT * FROM recent WHERE recent.|'), undefined);
  assert.deepEqual(columns('WITH RECURSIVE c(id) AS (SELECT 1 UNION ALL SELECT * FROM c), recent AS (SELECT c.* FROM c) SELECT * FROM recent WHERE recent.|'), ['id']);
});

test('qualified stars select one exact local owner across joins and comma sources without merging columns', () => {
  const prefix = 'WITH a(id,total) AS (SELECT 1,2), b(other_id,label) AS (SELECT 3,4), ';
  for (const from of [
    'a x JOIN b y ON x.id=y.other_id', 'a x INNER JOIN b y ON (x.id=y.other_id AND y.label IN (1,2))',
    'a x LEFT JOIN b y ON x.id=y.other_id', 'a x RIGHT OUTER JOIN b y ON x.id=y.other_id',
    'a x CROSS JOIN b y', 'a x JOIN b y', 'a x, b y', "a x JOIN b y ON y.label='JOIN, NATURAL USING'",
    "a x JOIN b y ON 'TRUE'", 'a x JOIN b y ON EXISTS (SELECT 1 FROM physical_t WHERE id=x.id)'
  ]) {
    assert.deepEqual(columns(`${prefix}recent AS (SELECT y.*,x.* FROM ${from}) SELECT * FROM recent WHERE recent.|`), ['other_id', 'label', 'id', 'total'], from);
  }
  assert.deepEqual(columns(`${prefix}recent AS (SELECT y.* FROM a x JOIN a y ON x.id=y.id) SELECT * FROM recent WHERE recent.|`), ['id', 'total']);
  assert.deepEqual(columns('SELECT * FROM (SELECT y.* FROM (SELECT 1 AS id) x JOIN (SELECT 2 AS `mã`, 3 AS `a``b`) y ON 1=1) d WHERE d.|'), ['mã', 'a`b']);
  assert.deepEqual(columns(`${prefix}recent AS (SELECT a.* FROM a JOIN b ON a.id=b.other_id UNION ALL SELECT b.* FROM a,b) SELECT * FROM recent WHERE recent.|`), ['id', 'total']);
  assert.deepEqual(columns('WITH a(id) AS (SELECT 1), b(label) AS (SELECT 2), recent AS (SELECT `x.y`.* FROM a `x.y` JOIN b `tên` ON 1=1) SELECT * FROM recent WHERE recent.|'), ['id']);
  assert.deepEqual(columns(`${prefix}recent AS (SELECT z.* FROM a x LEFT OUTER JOIN b y ON x.id=y.other_id JOIN (SELECT 1 AS last_id) z ON z.last_id=x.id) SELECT * FROM recent WHERE recent.|`), ['last_id']);
  assert.deepEqual(columns('WITH a(id) AS (SELECT 1), b(`JOIN`) AS (SELECT 2), recent AS (SELECT y /* qualifier */ .* FROM a x INNER /* keep */ JOIN b y ON y.JOIN=x.id) SELECT * FROM recent WHERE recent.|'), ['JOIN']);
});

test('multi-source stars reject ambiguous owners, incomplete sources, unsupported joins and duplicate output', () => {
  const prefix = 'WITH a(id,total) AS (SELECT 1,2), b(other_id,label) AS (SELECT 3,4) ';
  for (const projection of [
    '* FROM a,b', '* FROM a JOIN b ON 1=1', 'a.*,b.* FROM a JOIN a b ON 1=1',
    'x.* FROM a x JOIN b x ON 1=1', 'x.* FROM a x JOIN b X ON 1=1',
    'a.* FROM a x JOIN b y ON 1=1', 'X.* FROM a x JOIN b y ON 1=1',
    'a.* FROM a JOIN b USING(id)', 'a.* FROM a NATURAL JOIN b', 'a.* FROM a FULL JOIN b ON 1=1',
    'a.* FROM a STRAIGHT_JOIN b ON 1=1', 'a.* FROM a LEFT JOIN b', 'a.* FROM a RIGHT OUTER JOIN b',
    'a.* FROM a JOIN b ON', 'a.* FROM a ON 1=1 JOIN b ON 1=1', 'a.* FROM a JOIN', 'a.* FROM a,',
    'a.* FROM a JOIN app.b ON 1=1', 'a.* FROM a JOIN b() x ON 1=1', 'a.* FROM a JOIN physical_t p ON 1=1',
    'a.* FROM a JOIN (SELECT * FROM physical_t) d ON 1=1', 'a.* FROM a JOIN (SELECT 1 AS id) ON 1=1',
    "a.* FROM a LEFT 'literal' JOIN b ON 1=1", "a.* FROM a JOIN 'literal' b ON 1=1",
    "a.* FROM a JOIN b 'literal' ON 1=1", "a.* FROM a JOIN (SELECT 1 AS id) 'literal' d ON 1=1",
    'a.* FROM a JOIN b ON 1=1 USING(id)', 'a.* FROM a JOIN b ON 1=1 NATURAL JOIN a c'
  ]) assert.equal(columns(`${prefix}SELECT * FROM (SELECT ${projection}) d WHERE d.|`), undefined, projection);
  const sources = count => `WITH a(id) AS (SELECT 1) SELECT * FROM (SELECT x0.* FROM ${Array.from({ length: count }, (_, index) => `a x${index}`).join(',')}) d WHERE d.|`;
  assert.deepEqual(columns(sources(64)), ['id']);
  assert.equal(columns(sources(65)), undefined);
  assert.equal(columns('WITH a(id) AS (SELECT 1), b AS (SELECT a.* FROM a JOIN c ON 1=1), c(label) AS (SELECT 2) SELECT * FROM b WHERE b.|'), undefined);
  assert.equal(columns('WITH a(id) AS (SELECT 1) SELECT * FROM (WITH a AS (SELECT * FROM physical_t), b(label) AS (SELECT 2) SELECT b.* FROM a JOIN b ON 1=1) d WHERE d.|'), undefined);
});

test('physical, ambiguous, malformed, duplicate and unsupported stars never yield partial lists or outer fallbacks', () => {
  for (const projection of [
    '* FROM physical_t', 'p.* FROM physical_t p', '* FROM app.c', '* FROM c()', '* FROM (SELECT * FROM physical_t) d',
    '* FROM c JOIN physical_t p ON 1=1', 'c.* FROM c JOIN physical_t p ON 1=1', '* FROM c, c other',
    '* FROM c NATURAL JOIN c other', '* FROM c JOIN c other USING(id)', '* FROM LATERAL (SELECT id FROM c) d',
    'c.* FROM c alias_name', 'wrong.* FROM c', 'app.c.* FROM c', '* AS guessed FROM c',
    '*,id FROM c', '*,* FROM c', '*,total AS ID FROM c', '*,unknown+1 FROM c',
    "* 'literal' FROM c", "* FROM c 'literal'", "c.* FROM c 'literal' alias_name",
    "* FROM 'literal' (SELECT 1 AS id) x", "* FROM (SELECT 1 AS id) 'literal' x",
    '* FROM c PARTITION(p0)', '* FROM c USE INDEX(idx)', '* FROM c FORCE INDEX(idx)', '* FROM c WHERE id=1 UNION SELECT * FROM physical_t'
  ]) {
    const marked = `WITH c(id,total) AS (SELECT 1,2) SELECT * FROM (SELECT ${projection}) d WHERE d.|`;
    assert.equal(columns(marked), undefined, projection);
  }
  assert.equal(columns('WITH c(id,id) AS (SELECT 1), recent AS (SELECT * FROM c) SELECT * FROM recent WHERE recent.|'), undefined);
  assert.equal(columns('WITH c AS (SELECT * FROM c) SELECT * FROM c WHERE c.|'), undefined);
  assert.equal(columns('WITH first AS (SELECT * FROM second), second AS (SELECT * FROM first) SELECT * FROM first WHERE first.|'), undefined);
  assert.equal(columns('WITH first AS (SELECT * FROM second), second(id) AS (SELECT 1) SELECT * FROM first WHERE first.|'), undefined);
  assert.equal(columns('WITH c(id) AS (SELECT 1) SELECT * FROM c; SELECT * FROM (SELECT * FROM c) d WHERE d.|'), undefined);
});

test('expansion has bounded total reads and name copies and returns no truncated column lists', () => {
  const declared = Array.from({ length: 256 }, (_, index) => `c${index}`).join(',');
  assert.equal(columns(`WITH c(${declared}) AS (SELECT 1), recent AS (SELECT * FROM c) SELECT * FROM recent WHERE recent.|`).length, 256);
  assert.equal(columns(`WITH c(${declared}) AS (SELECT 1), recent AS (SELECT *, 1 AS extra FROM c) SELECT * FROM recent WHERE recent.|`), undefined);
  const chain = count => 'WITH c0(id) AS (SELECT 1), ' + Array.from({ length: count }, (_, index) => `c${index + 1} AS (SELECT * FROM c${index})`).join(', ') + ` SELECT * FROM c${count} WHERE c${count}.|`;
  assert.deepEqual(columns(chain(64)), ['id']);
  assert.equal(columns(chain(65)), undefined);
  const wide = count => `WITH c0(${declared}) AS (SELECT 1), ` + Array.from({ length: count }, (_, index) => `c${index + 1} AS (SELECT * FROM c${index})`).join(', ') + ` SELECT * FROM c${count} WHERE c${count}.|`;
  assert.equal(columns(wide(16)).length, 256);
  assert.equal(columns(wide(17)), undefined);
});

test('renderer resolves local stars without any underlying/catalog read and ignores stale local completion', async () => {
  const calls = [];
  const editor = { value: '', selectionStart: 0, selectionEnd: 0, isConnected: true, setAttribute() {}, removeAttribute() {} };
  const r = loadRenderer({ elements: new Map([['#sql', editor]]), desktop: { db: { columns: async (...args) => {
    calls.push(args); return { ok: true, data: [{ name: 'physical_key', type: 'int' }] };
  } } } });
  r.evaluate("mode='query';app.connection={id:'p'};app.database='demo';app.query={id:'q'};app.tables=[{name:'source'},{name:'recent'},{name:'d'}];rendered=[];renderSqlSuggestions=(editor,context,items)=>rendered.push(items)");
  const set = marked => { editor.value = marked.replace('|', ''); editor.selectionStart = editor.selectionEnd = marked.indexOf('|'); };
  const refresh = async marked => {
    set(marked); await r.evaluate("refreshSqlSuggestions($('#sql'),true)");
    return JSON.parse(r.evaluate('JSON.stringify(rendered.at(-1))'));
  };
  const marked = 'WITH source(id,total) AS (SELECT * FROM invoices), recent AS (SELECT s.* FROM source s) SELECT * FROM recent r WHERE r.|';
  let items = await refresh(marked);
  assert.deepEqual(items.map(item => item.label), ['r.id', 'r.total']);
  assert.ok(items.every(item => item.detail === 'CTE · recent · tên từ SELECT')); assert.equal(calls.length, 0);
  items = await refresh('SELECT * FROM (SELECT * FROM (SELECT id item_id FROM invoices) x) d WHERE d.|');
  assert.deepEqual(items.map(item => item.insertText), ['`item_id`']); assert.equal(calls.length, 0);
  items = await refresh('WITH source(id,total) AS (SELECT * FROM invoices), recent AS (SELECT y.* FROM source x JOIN (SELECT 1 AS `tên cột`) y ON x.id=1) SELECT * FROM recent r WHERE r.|');
  assert.deepEqual(items.map(item => item.label), ['r.tên cột']); assert.equal(calls.length, 0);
  assert.deepEqual(await refresh('WITH source(id) AS (SELECT 1), recent AS (SELECT s.* FROM source s JOIN source S ON 1=1) SELECT * FROM recent r WHERE r.|'), []); assert.equal(calls.length, 0);
  assert.deepEqual(await refresh('SELECT * FROM (SELECT * FROM invoices) d WHERE d.|'), []); assert.equal(calls.length, 0);
  items = await refresh('WITH c(id) AS (SELECT 1), recent AS (SELECT * FROM c) SELECT * FROM recent r JOIN accounts a ON 1=1 WHERE |');
  assert.deepEqual(items.map(item => item.label), ['r.id', 'a.physical_key']); assert.deepEqual(calls, [['demo', 'accounts', 'p']]);
  set(marked); const pending = r.evaluate("refreshSqlSuggestions($('#sql'),true)"); editor.selectionStart -= 1; await pending;
  assert.deepEqual(JSON.parse(r.evaluate('JSON.stringify(rendered.at(-1))')), []);
});
