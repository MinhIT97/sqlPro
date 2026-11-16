'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getContext, tableScope } = require('../sql-autocomplete.js');
const { loadRenderer } = require('./helpers/renderer.cjs');

function contextAt(marked) {
  const caret = marked.indexOf('|'); assert.ok(caret >= 0);
  return getContext(marked.slice(0, caret) + marked.slice(caret + 1), caret);
}

test('subqueries isolate references at the caret and do not leak descendants or siblings into the outer SELECT', () => {
  const outer = contextAt('SELECT | FROM accounts a WHERE EXISTS (SELECT 1 FROM invoices i WHERE i.account_id=a.id) AND EXISTS (SELECT 1 FROM audit_log l)');
  assert.equal(outer.scopeKnown, true); assert.deepEqual(outer.references, [{ table: 'accounts', alias: 'a' }]);
  const inner = contextAt('SELECT * FROM accounts a WHERE EXISTS (SELECT * FROM invoices i WHERE | i.account_id=a.id) AND EXISTS (SELECT 1 FROM audit_log l)');
  assert.deepEqual(inner.references, [{ table: 'invoices', alias: 'i' }]); assert.equal(inner.allowQualifierCatalog, false);
  assert.deepEqual(contextAt('SELECT * FROM accounts a WHERE EXISTS (SELECT * FROM invoices i WHERE (| i.id=1))').references, inner.references);
  assert.deepEqual(contextAt('SELECT * FROM accounts a WHERE EXISTS (SELECT * FROM invoices i WHERE i.id=1) AND |').references, outer.references);
  assert.deepEqual(contextAt('SELECT * FROM accounts a WHERE EXISTS (SELECT * FROM invoices i WHERE |').references, inner.references);
});

test('alias shadowing in nested scopes keeps only the current SELECT binding', () => {
  assert.deepEqual(contextAt('SELECT * FROM outside_t x WHERE EXISTS (SELECT * FROM inside_t x WHERE x.|)').references, [{ table: 'inside_t', alias: 'x' }]);
  assert.deepEqual(contextAt('SELECT * FROM outside_t x WHERE EXISTS (SELECT * FROM inside_t x WHERE x.id=1) AND x.|').references, [{ table: 'outside_t', alias: 'x' }]);
});

test('CTE and derived names are opaque sources instead of physical tables; definitions still expose their own physical sources', () => {
  const cte = contextAt('WITH recent AS (SELECT * FROM invoices i WHERE |) SELECT * FROM recent r JOIN accounts a ON a.id=r.account_id');
  assert.equal(cte.scopeKnown, true); assert.deepEqual(cte.references, [{ table: 'invoices', alias: 'i' }]);
  const main = contextAt('WITH recent AS (SELECT * FROM invoices) SELECT * FROM recent r JOIN accounts a ON a.id=r.account_id WHERE |');
  assert.deepEqual(main.references, [{ table: 'recent', alias: 'r', local: true }, { table: 'accounts', alias: 'a' }]);
  assert.equal(main.allowQualifierCatalog, false);
  assert.deepEqual(contextAt('WITH recent AS (SELECT * FROM invoices) SELECT * FROM app.recent r WHERE |').references, [{ database: 'app', table: 'recent', alias: 'r' }]);
  assert.deepEqual(contextAt('SELECT * FROM (SELECT * FROM invoices) r JOIN accounts a ON a.id=r.account_id WHERE |').references,
    [{ table: 'r', alias: 'r', local: true }, { table: 'accounts', alias: 'a' }]);
  assert.deepEqual(contextAt('SELECT * FROM (SELECT * FROM invoices i WHERE |) r JOIN accounts a ON a.id=r.account_id').references, [{ table: 'invoices', alias: 'i' }]);
});

test('nested/recursive/explicit-column CTE names never produce physical reads, including case variants and incomplete definitions', () => {
  for (const sql of [
    'WITH RECURSIVE chain(id) AS (SELECT * FROM chain) SELECT * FROM CHAIN c WHERE |',
    'WITH first AS (SELECT * FROM t), second AS (SELECT * FROM first) SELECT * FROM second WHERE |',
    'WITH c AS (SELECT * FROM t) SELECT * FROM (WITH c AS (SELECT * FROM u) SELECT * FROM c WHERE |) d'
  ]) {
    const context = contextAt(sql); assert.equal(context.scopeKnown, true, sql);
    assert.equal(context.references.length, 1); assert.equal(context.references[0].local, true, sql);
  }
  assert.deepEqual(contextAt('WITH c AS (SELECT * FROM t WHERE |').references, [{ table: 't' }]);
  assert.equal(contextAt('WITH c AS SELECT * FROM c WHERE |').scopeKnown, false);
});

test('UNION/INTERSECT/EXCEPT arms are independent and set-wide ORDER/LIMIT have no guessed table scope', () => {
  for (const operator of ['UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT']) {
    assert.deepEqual(contextAt(`SELECT * FROM a WHERE | id=1 ${operator} SELECT * FROM b WHERE id=2`).references, [{ table: 'a' }]);
    assert.deepEqual(contextAt(`SELECT * FROM a WHERE id=1 ${operator} SELECT * FROM b WHERE | id=2`).references, [{ table: 'b' }]);
    assert.equal(contextAt(`SELECT * FROM a ${operator} SELECT * FROM b ORDER BY |`).scopeKnown, false);
    assert.equal(contextAt(`SELECT * FROM a ${operator} SELECT * FROM b LIMIT |`).scopeKnown, false);
  }
});

test('quoted identifiers cannot introduce keywords or parentheses and exact schema/name/backtick boundaries survive', () => {
  assert.deepEqual(contextAt('SELECT `FROM fake JOIN secret` FROM `a.b`.`t``name` AS `WHERE` WHERE |').references,
    [{ database: 'a.b', table: 't`name', alias: 'WHERE' }]);
  assert.deepEqual(contextAt('SELECT a.from, a.join, a.select FROM `bảng` a WHERE |').references, [{ table: 'bảng', alias: 'a' }]);
  assert.deepEqual(contextAt("SELECT 'FROM secret (SELECT * FROM hidden)' FROM public_t p /* JOIN hidden h */ WHERE |").references, [{ table: 'public_t', alias: 'p' }]);
  assert.deepEqual(contextAt('SELECT * FROM a, app.b AS b WHERE |').references, [{ table: 'a' }, { database: 'app', table: 'b', alias: 'b' }]);
});

test('table entry contexts stay available and nested function expressions keep their surrounding query scope', () => {
  for (const sql of ['SELECT * FROM |', 'SELECT * FROM `us|', 'SELECT * FROM a JOIN |', 'SELECT * FROM a, |']) assert.equal(contextAt(sql).scopeKnown, true, sql);
  assert.deepEqual(contextAt('SELECT EXTRACT(YEAR FROM created_at) FROM logs WHERE COALESCE(|,1)').references, [{ table: 'logs' }]);
  assert.deepEqual(contextAt('UPDATE logs SET |').references, [{ table: 'logs' }]);
  assert.deepEqual(contextAt('INSERT INTO logs VALUES (|)').references, [{ table: 'logs' }]);
  assert.deepEqual(contextAt('INSERT INTO logs (|) VALUES (1)').references, [{ table: 'logs' }]);
  assert.deepEqual(contextAt('INSERT INTO logs (id) SELECT * FROM source_t WHERE |').references, [{ table: 'source_t' }]);
  assert.deepEqual(contextAt('INSERT INTO logs (|) SELECT id FROM source_t').references, [{ table: 'logs' }]);
  assert.deepEqual(contextAt('INSERT INTO logs (|) SELECT id FROM source_t UNION SELECT id FROM other_t').references, [{ table: 'logs' }]);
  assert.equal(contextAt('DROP TABLE |').scopeKnown, true);
  assert.equal(contextAt('DESCRIBE |').scopeKnown, true);
});

test('ambiguous/unsupported syntax and all parser quotas produce unknown rather than fallback physical sources', () => {
  for (const sql of ['SELECT * FROM a.b.c WHERE |', 'SELECT * FROM "a" WHERE |', 'SELECT * FROM t /*! JOIN hidden */ WHERE |',
    'SELECT /*+ HINT */ * FROM t WHERE |', 'SELECT * FROM t /*M! JOIN hidden */ WHERE |', "SELECT * FROM t WHERE value='a\\b' AND |",
    'SELECT * FROM t) WHERE |', 'WITH c AS (SELECT 1), SELECT * FROM c WHERE |', 'SELECT * FROM bảng WHERE |',
    'SELECT * FROM t PARTITION(p0) AS x WHERE |', 'SELECT * FROM t x USE INDEX(idx) WHERE |',
    'SELECT * FROM user-name WHERE |', 'SELECT * FROM t JOIN LATERAL (SELECT 1) d WHERE |',
    'SELECT * FROM t\u00a0suffix WHERE |']) assert.equal(contextAt(sql).scopeKnown, false, sql);
  assert.equal(tableScope('SELECT * FROM t ' + ' '.repeat(65536)).known, false);
  assert.equal(tableScope('SELECT * FROM t WHERE ' + '('.repeat(33) + '1').known, false);
  assert.equal(tableScope('SELECT * FROM t WHERE ' + 'x+'.repeat(2100) + '1').known, false);
  assert.equal(tableScope('SELECT * FROM t WHERE ' + 'x() + '.repeat(128) + '1').known, false);
  assert.equal(tableScope('SELECT * FROM ' + Array.from({ length: 65 }, (_, i) => `t${i}`).join(',')).known, false);
});

function renderer() {
  const editor = { value: '', selectionStart: 0, isConnected: true, setAttribute() {}, removeAttribute() {} };
  const calls = [];
  const r = loadRenderer({ desktop: { db: { columns: async (...args) => {
    calls.push(args); return { ok: true, data: [{ name: args[1] + '_key', type: 'int' }] };
  } } }, elements: new Map([['#sql', editor]]) });
  r.evaluate("app.connection={id:'p'};app.database='demo';app.tables=[{name:'recent'},{name:'r'},{name:'accounts'},{name:'outside_t'}];mode='query';rendered=[];renderSqlSuggestions=(editor,context,items)=>rendered.push(items)");
  const refresh = async marked => {
    editor.selectionStart = marked.indexOf('|'); editor.value = marked.replace('|', '');
    await r.evaluate("refreshSqlSuggestions($('#sql'),true)");
    return r.evaluate('JSON.stringify(rendered.at(-1))');
  };
  return { ...r, calls, refresh };
}

test('renderer reads only physical sources in the current block, never logical names or correlated guesses from sidebar', async () => {
  const r = renderer();
  let html = await r.refresh('WITH recent AS (SELECT * FROM invoices) SELECT * FROM recent r JOIN accounts a ON a.id=r.id WHERE |');
  assert.deepEqual(r.calls, [['demo', 'accounts', 'p']]); assert.match(html, /a.accounts_key/); assert.doesNotMatch(html, /invoices_key|recent_key/);
  for (const marked of [
    'WITH recent AS (SELECT * FROM invoices) SELECT * FROM recent r WHERE r.|',
    'SELECT * FROM (SELECT * FROM invoices) r WHERE r.|',
    'SELECT * FROM outside_t WHERE EXISTS (SELECT outside_t.|)',
    'SELECT * FROM (SELECT * FROM invoices) a JOIN accounts a ON 1=1 WHERE |'
  ]) { await r.refresh(marked); assert.equal(r.calls.length, 1, marked); }
  html = await r.refresh('SELECT * FROM accounts a WHERE EXISTS (SELECT * FROM invoices i WHERE |)');
  assert.deepEqual(r.calls.at(-1), ['demo', 'invoices', 'p']); assert.match(html, /invoices_key/); assert.doesNotMatch(html, /accounts_key/);
});

test('unknown scopes cannot borrow sidebar table names while ordinary FROM completion still has the current catalog', async () => {
  const r = renderer();
  const known = await r.refresh('SELECT * FROM |'); assert.match(known, /accounts/);
  const unknown = await r.refresh('SELECT /*+ HINT */ * FROM recent WHERE |'); assert.doesNotMatch(unknown, /recent|accounts/);
  assert.equal(r.calls.length, 0);
});

test('qualified aliases cannot hide another visible unaliased source with the same owner', async () => {
  const r = renderer();
  for (const marked of [
    'SELECT * FROM accounts outside_t JOIN outside_t ON 1=1 WHERE outside_t.|',
    'WITH recent(id) AS (SELECT 1) SELECT * FROM recent accounts JOIN accounts ON 1=1 WHERE accounts.|'
  ]) { assert.equal(await r.refresh(marked), '[]'); assert.equal(r.calls.length, 0); }
  const known = await r.refresh('SELECT * FROM accounts outside_t JOIN outside_t other ON 1=1 WHERE outside_t.|');
  assert.match(known, /outside_t.accounts_key/);
  assert.deepEqual(r.calls, [['demo', 'accounts', 'p']]);
});
