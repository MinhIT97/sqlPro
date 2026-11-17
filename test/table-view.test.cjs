'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const View = require('../table-view.js');
const { DatabaseSession } = require('../electron/database.cjs');
const columns = [{ name: 'a', key: 'PRI', type: 'int' }, { name: 'b', key: 'PRI', type: 'int' }, { name: 'label`', type: 'text' }];
const sort = (column, direction = 'ASC') => ({ column, direction });
function setup() {
  const session = new DatabaseSession({}), calls = [];
  session.listColumns = async () => columns;
  session.raw = async (sql, params) => { calls.push({ sql, params }); return /COUNT/.test(sql) ? { rows: [{ total: 3 }] } : { result: [{ a: 2, b: 5, 'label`': 'x' }, { a: 2, b: 4, 'label`': 'x' }, { a: 3, b: 1, 'label`': 'z' }] }; };
  return { session, calls };
}

test('sorts retain priority/directions and append missing PK without changing inputs', () => {
  const sorts = [sort('label`', 'DESC'), sort('b')], before = JSON.stringify(sorts);
  const result = View.order({ sorts }, columns);
  assert.deepEqual(result.entries, [...sorts, sort('a', 'DESC')]); assert.equal(result.keyset, false);
  assert.equal(JSON.stringify(sorts), before); assert.ok(Object.isFrozen(result.requested[0]));
  assert.deepEqual(View.order({ orderBy: 'a', orderDir: 'DESC' }, columns).entries, [sort('a', 'DESC'), sort('b', 'DESC')]);
  assert.deepEqual(View.order({ sorts: [], orderBy: 'label`' }, columns).entries, [sort('a'), sort('b')]);
});

test('unknown, duplicate, inherited, oversized and SQL-shaped sort input cannot silently fall back', () => {
  for (const sorts of [false, {}, [sort('missing')], [sort('a', 'DESC; DROP TABLE x')], [sort('a'), sort('a')],
    [sort('A')], [Object.create(sort('a'))], [{ column: 'a' }], [{ ...sort('a'), sql: '1' }], Array(1), Array.from({ length: 6 }, () => sort('a'))]) {
    assert.throws(() => View.order({ sorts }, columns), { code: 'INVALID_ORDER' });
  }
  assert.throws(() => View.order({ orderBy: 'missing' }, columns), { code: 'INVALID_ORDER' });
  const wide = Array.from({ length: 6 }, (_, index) => ({ name: `c${index}`, key: 'PRI' }));
  const sorts = wide.slice(0, 5).map(column => sort(column.name));
  assert.equal(View.order({ sorts }, wide).entries.length, 6);
  assert.throws(() => View.order({ sorts: wide.map(column => sort(column.name)) }, wide), { code: 'INVALID_ORDER' });
});

test('mixed-direction PK keyset handles next/previous lexicographic comparison and cursor invalidation', async () => {
  const { session, calls } = setup();
  const options = { database: 'd', table: 't', pageSize: 2, sorts: [sort('a'), sort('b', 'DESC')] };
  const first = await session.tableData(options);
  const second = await session.tableData({ ...options, page: 2, cursor: first.nextCursor });
  assert.match(calls.at(-1).sql, /\(`a` > \?\) OR \(`a` = \? AND `b` < \?\)/);
  assert.match(calls.at(-1).sql, /ORDER BY `a` ASC, `b` DESC LIMIT \?$/);
  assert.deepEqual(calls.at(-1).params, [2, 2, 4, 3]);
  await session.tableData({ ...options, page: 1, cursor: second.previousCursor });
  assert.match(calls.at(-1).sql, /\(`a` < \?\) OR \(`a` = \? AND `b` > \?\)/);
  assert.match(calls.at(-1).sql, /ORDER BY `a` DESC, `b` ASC/);
  await session.tableData({ ...options, sorts: [sort('a'), sort('b')], page: 2, cursor: first.nextCursor });
  assert.match(calls.at(-1).sql, /OFFSET/);
  await session.tableData({ ...options, sorts: [sort('b', 'DESC'), sort('a')], page: 2, cursor: first.nextCursor });
  assert.match(calls.at(-1).sql, /OFFSET/);
});

test('non-PK ordering uses OFFSET with stable tie breakers; count cache stays independent', async () => {
  const { session, calls } = setup();
  const options = { database: 'd', table: 't', sorts: [sort('label`', 'DESC'), sort('b')] };
  const result = await session.tableData(options);
  assert.match(calls.at(-1).sql, /ORDER BY `label``` DESC, `b` ASC, `a` DESC/);
  assert.match(calls.at(-1).sql, /OFFSET/); assert.equal(result.nextCursor, null);
  await session.countTableRows(options);
  assert.equal((await session.countTableRows({ ...options, sorts: [sort('a')] })).cached, true);
  const before = calls.length;
  await assert.rejects(session.tableData({ ...options, sorts: [sort('absent')] }), { code: 'INVALID_ORDER' });
  assert.equal(calls.length, before);
});

test('visibility selects metadata in original order without stripping hidden row keys or mutating metadata', () => {
  assert.deepEqual(View.visible(['label`', 'b'], columns), [columns[1], columns[2]]);
  assert.equal(View.visible(null, columns), columns);
  assert.equal(View.visible(['deleted'], columns), columns);
  assert.equal(View.visible([], columns), columns);
  assert.equal(columns.length, 3);
  const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
  assert.ok(html.indexOf('src="table-view.js"') < html.indexOf('src="app.js"'));
  assert.ok(require('../package.json').build.files.includes('table-view.js'));
});
