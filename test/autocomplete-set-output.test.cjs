'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getContext } = require('../sql-autocomplete.js');
const { loadRenderer } = require('./helpers/renderer.cjs');

const at = marked => getContext(marked.replace('|', ''), marked.indexOf('|'));
const derived = sql => at(`SELECT * FROM (${sql}) d WHERE d.|`).references[0];
const cte = sql => at(`WITH c AS (${sql}) SELECT * FROM c WHERE c.|`).references[0];

test('simple set projections use first SELECT names while validating the complete named shape of every arm', () => {
  for (const source of [cte, derived]) {
    for (const operator of ['UNION', 'UNION ALL', 'UNION DISTINCT', 'INTERSECT', 'INTERSECT ALL', 'EXCEPT', 'EXCEPT DISTINCT']) {
      const reference = source(`SELECT id AS item_id, total amount FROM a ${operator} SELECT other_id AS later_name, other_total AS ignored FROM b`);
      assert.deepEqual(reference.columnNames, ['item_id', 'amount'], operator);
      assert.equal(Object.isFrozen(reference.columnNames), true);
    }
  }
  assert.deepEqual(derived('SELECT id first_name FROM a UNION SELECT id second_name FROM b INTERSECT SELECT id third_name FROM c EXCEPT SELECT id fourth_name FROM e').columnNames, ['first_name']);
});

test('literal and keyword-looking aliases keep exact names without exposing literals or splitting quoted operators', () => {
  const reference = derived("SELECT 'PRIVATE_ONE' AS `UNION`, id AS `tên``cột` FROM a UNION SELECT 'PRIVATE_TWO' AS other, other_id FROM b ORDER BY 1 LIMIT 1");
  assert.deepEqual(reference.columnNames, ['UNION', 'tên`cột']);
  assert.doesNotMatch(JSON.stringify(reference), /PRIVATE_ONE|PRIVATE_TWO/);
  assert.deepEqual(derived("SELECT 'PRIVATE' AS label UNION SELECT 'OTHER' AS ignored").columnNames, ['label']);
  assert.deepEqual(derived('SELECT `UNION` AS `EXCEPT` FROM a /* UNION SELECT wrong */ UNION SELECT id FROM b').columnNames, ['EXCEPT']);
});

test('mismatched, unnamed, incomplete, parenthesized or unsupported arms keep the whole source opaque', () => {
  for (const sql of [
    'SELECT id FROM a UNION SELECT id,total FROM b', 'SELECT id,total FROM a UNION SELECT id FROM b',
    'SELECT * FROM a UNION SELECT id FROM b', 'SELECT id FROM a UNION SELECT * FROM b',
    'SELECT id FROM a UNION SELECT id+1 FROM b', 'SELECT id FROM a UNION SELECT 1',
    'SELECT id,ID FROM a UNION SELECT id,total FROM b', 'SELECT id FROM a UNION',
    'SELECT id FROM a UNION ALL', 'SELECT id FROM a UNION ALL ALL SELECT id FROM b',
    'SELECT id FROM a UNION INTERSECT SELECT id FROM b', 'SELECT id FROM a UNION TABLE b',
    'SELECT id FROM a UNION (SELECT id FROM b)', '(SELECT id FROM a) UNION SELECT id FROM b',
    'SELECT id FROM a UNION SELECT id INTO OUTFILE \'private\' FROM b'
  ]) {
    const reference = derived(sql);
    assert.equal(reference?.local, true, sql); assert.equal(reference.columnNames, undefined, sql);
  }
});

test('set output quota is 16 arms and explicit declarations still have priority over unsupported bodies', () => {
  const arms = Array.from({ length: 16 }, (_, index) => `SELECT id AS c${index} FROM t${index}`);
  assert.deepEqual(derived(arms.join(' UNION ALL ')).columnNames, ['c0']);
  assert.equal(derived([...arms, 'SELECT id FROM overflow'].join(' UNION ALL ')).columnNames, undefined);
  assert.deepEqual(at('WITH c(declared) AS (SELECT * FROM a UNION SELECT * FROM b) SELECT * FROM c WHERE c.|').references[0].columnNames, ['declared']);
  assert.equal(at('WITH c(id,id) AS (SELECT id first_name FROM a UNION SELECT id FROM b) SELECT * FROM c WHERE c.|').references[0].columnNames, undefined);
});

test('nested and recursive declarations retain scope while branch-local metadata and set-wide tail stay isolated', () => {
  assert.deepEqual(at('WITH RECURSIVE c AS (SELECT 1 AS id UNION ALL SELECT id+1 AS next_id FROM c) SELECT * FROM c WHERE c.|').references[0].columnNames, ['id']);
  const nested = at('WITH c AS (SELECT id outer_id FROM a UNION SELECT id FROM b) SELECT * FROM (WITH c AS (SELECT id inner_id FROM x EXCEPT SELECT id FROM y) SELECT * FROM c WHERE c.|) d');
  assert.deepEqual(nested.references[0].columnNames, ['inner_id']);
  assert.deepEqual(at('SELECT id FROM a WHERE | UNION SELECT id FROM b').references, [{ table: 'a' }]);
  assert.deepEqual(at('SELECT id FROM a UNION SELECT id FROM b WHERE |').references, [{ table: 'b' }]);
  assert.equal(at('SELECT id FROM a UNION SELECT id FROM b ORDER BY |').scopeKnown, false);
});

test('renderer serves set names locally, never later-arm names or physical catalog collisions', async () => {
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
  let items = await refresh('WITH c AS (SELECT id item_id FROM a UNION SELECT id ignored FROM b) SELECT * FROM c WHERE c.|');
  assert.deepEqual(items.map(item => item.label), ['c.item_id']);
  assert.equal(items[0].detail, 'CTE · c · tên từ SELECT');
  items = await refresh('SELECT * FROM (SELECT id item_id FROM a EXCEPT SELECT id ignored FROM b) d WHERE d.|');
  assert.deepEqual(items.map(item => item.insertText), ['`item_id`']); assert.equal(calls.length, 0);
  assert.deepEqual(await refresh('SELECT * FROM (SELECT id FROM a UNION SELECT * FROM b) d WHERE d.|'), []);
  assert.equal(calls.length, 0);
  items = await refresh('WITH c AS (SELECT id item_id FROM a UNION SELECT id FROM b) SELECT * FROM c r JOIN accounts a ON 1=1 WHERE |');
  assert.deepEqual(items.map(item => item.label), ['r.item_id', 'a.physical_key']);
  assert.deepEqual(calls, [['demo', 'accounts', 'p']]);
});
