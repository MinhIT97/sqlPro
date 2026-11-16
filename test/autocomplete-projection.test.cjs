'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getContext } = require('../sql-autocomplete.js');
const { loadRenderer } = require('./helpers/renderer.cjs');

const at = marked => getContext(marked.replace('|', ''), marked.indexOf('|'));
const derived = projection => at(`SELECT * FROM (SELECT ${projection}) d WHERE d.|`).references[0];
const cte = projection => at(`WITH c AS (SELECT ${projection}) SELECT * FROM c WHERE c.|`).references[0];

test('complete direct column paths and AS names expose only output names for CTE and derived sources', () => {
  for (const source of [derived, cte]) {
    const reference = source('id, t.name, app.t.total, `tên cột`, t.id AS item_id FROM app.t');
    assert.equal(reference.local, true);
    assert.deepEqual(reference.columnNames, ['id', 'name', 'total', 'tên cột', 'item_id']);
    assert.equal(Object.isFrozen(reference.columnNames), true);
    assert.deepEqual(source('DISTINCT t.id, t.name FROM t').columnNames, ['id', 'name']);
    assert.deepEqual(source('ALL t.id FROM t').columnNames, ['id']);
  }
  assert.equal(derived('id FROM t').columnSource, 'derived-select');
  assert.equal(cte('id FROM t').columnSource, 'cte-select');
});

test('expression aliases are names only: functions, CASE, subqueries and masked literals do not expose their text', () => {
  const reference = derived("COUNT(*) AS total, CONCAT(a, ',', b) AS label, (SELECT MAX(secret) FROM hidden) AS latest, 'PRIVATE_VALUE' AS note, CASE WHEN a=1 THEN 2 ELSE 3 END AS flag FROM t");
  assert.deepEqual(reference.columnNames, ['total', 'label', 'latest', 'note', 'flag']);
  assert.equal(JSON.stringify(reference).includes('PRIVATE_VALUE'), false);
  assert.equal(JSON.stringify(reference).includes('secret'), false);
  assert.deepEqual(derived('t.id AS `a``b`, t.name AS `FROM x.y`, t.total AS `<img src=x>` FROM t').columnNames, ['a`b', 'FROM x.y', '<img src=x>']);
  assert.deepEqual(derived('id /* AS fake, FROM secret */, t.name AS label FROM t WHERE t.x=1 ORDER BY id LIMIT 1').columnNames, ['id', 'label']);
});

test('unknown, masked, duplicate, unsupported or oversized projections stay entirely opaque', () => {
  for (const projection of [
    '* FROM t', 'id, t.* FROM t', 'id, a+b FROM t', 'id, COUNT(*) FROM t', "id, 'private' FROM t", 'id, 1 FROM t',
    'NULL', 'CURRENT_TIMESTAMP', 'id,', ',id', 'id,,total', 'id,ID FROM t', 'a.id,b.id FROM a JOIN b',
    "id 'literal' FROM t", "'literal' id FROM t", "id AS 'literal' other FROM t", "id AS other 'literal' FROM t",
    'AS label FROM t', 'id AS x AS y FROM t', '* AS guessed FROM t', 't.* AS guessed FROM t',
    'SQL_CALC_FOUND_ROWS id FROM t',
    'id INTO OUTFILE \'private\' FROM t', 'id FROM t QUALIFY id=1', '`' + 'x'.repeat(65) + '` FROM t',
    Array.from({ length: 257 }, (_, index) => `c${index}`).join(',')
  ]) {
    const reference = derived(projection);
    assert.equal(reference?.local, true, projection);
    assert.equal(reference.columnNames, undefined, projection);
    assert.equal(reference.columnSource, undefined, projection);
  }
  assert.equal(at('WITH c AS (SELECT id FROM c WHERE c.|').references[0]?.columnNames, undefined);
  assert.equal(at('WITH c(id,id) AS (SELECT value AS valid FROM t) SELECT * FROM c WHERE |').references[0]?.columnNames, undefined);
  assert.equal(at('WITH c(id) AS (SELECT value AS inferred FROM t) SELECT * FROM c WHERE |').references[0]?.columnSource, undefined);
  assert.deepEqual(at('WITH c(id) AS (SELECT value AS inferred FROM t) SELECT * FROM c WHERE |').references[0]?.columnNames, ['id']);
});

test('projection scopes honor nested shadowing, aliases, explicit schema, and never expand stars or table functions', () => {
  const shadow = at('WITH c AS (SELECT outer_id FROM t) SELECT * FROM (WITH c AS (SELECT inner_id FROM u) SELECT * FROM c WHERE c.|) d');
  assert.deepEqual(shadow.references[0].columnNames, ['inner_id']);
  const opaque = at('WITH c AS (SELECT outer_id FROM t) SELECT * FROM (WITH c AS (SELECT * FROM u) SELECT * FROM c WHERE c.|) d');
  assert.equal(opaque.references[0].columnNames, undefined);
  const physical = at('WITH c AS (SELECT id FROM t) SELECT * FROM app.c WHERE |');
  assert.deepEqual(physical.references, [{ database: 'app', table: 'c' }]);
  assert.equal(at('WITH c AS (SELECT id FROM t) SELECT * FROM c() WHERE |').references[0].columnNames, undefined);
  const inherited = at('WITH c AS (SELECT id FROM t) SELECT * FROM (SELECT c.id AS item_id FROM c) d WHERE d.|');
  assert.deepEqual(inherited.references[0].columnNames, ['item_id']);
  assert.deepEqual(at('SELECT * FROM (SELECT id FROM t) d JOIN (SELECT name FROM u) e ON 1=1 WHERE |').references.map(ref => ref.columnNames), [['id'], ['name']]);
  const recursive = at('WITH RECURSIVE c AS (SELECT 1 AS id UNION ALL SELECT id+1 FROM c) SELECT * FROM c WHERE c.|');
  assert.equal(recursive.references[0].columnNames, undefined);
});

test('projection quotas accept 256 complete names, and keyword-looking quoted names do not split the list', () => {
  const columns = Array.from({ length: 256 }, (_, index) => `c${index}`);
  assert.deepEqual(derived(columns.join(',')).columnNames, columns);
  assert.deepEqual(derived('`FROM`, `AS`, `,`, `UNION`, `a.b`, t.`x``y` FROM t').columnNames, ['FROM', 'AS', ',', 'UNION', 'a.b', 'x`y']);
});

function renderer() {
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
  return { ...r, editor, calls, refresh };
}

test('renderer uses projection names without IPC and distinguishes CTE, derived and physical names', async () => {
  const r = renderer();
  let items = await r.refresh('WITH c AS (SELECT id, COUNT(*) AS total FROM invoices) SELECT * FROM c WHERE c.|');
  assert.deepEqual(items.map(item => item.label), ['c.id', 'c.total']);
  assert.ok(items.every(item => item.detail === 'CTE · c · tên từ SELECT'));
  items = await r.refresh('SELECT * FROM (SELECT id AS item_id FROM invoices) d WHERE d.|');
  assert.deepEqual(items.map(item => item.insertText), ['`item_id`']);
  assert.equal(items[0].detail, 'Derived · d · tên từ SELECT');
  assert.equal(r.calls.length, 0);
  items = await r.refresh('WITH c AS (SELECT id FROM invoices) SELECT * FROM c r JOIN accounts a ON 1=1 WHERE |');
  assert.deepEqual(items.map(item => item.label), ['r.id', 'a.physical_key']);
  assert.deepEqual(r.calls, [['demo', 'accounts', 'p']]);
  items = await r.refresh('SELECT * FROM (SELECT id FROM invoices) d JOIN accounts d ON 1=1 WHERE d.|');
  assert.deepEqual(items, []); assert.equal(r.calls.length, 1);
  items = await r.refresh('WITH c AS (SELECT id, * FROM invoices) SELECT * FROM c WHERE c.|');
  assert.deepEqual(items, []); assert.equal(r.calls.length, 1);
});
