'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSession } = require('../electron/database.cjs');
function setup() {
  const session = new DatabaseSession({}), calls = [];
  session.listColumns = async () => [{ name: 'a', type: 'int', key: 'PRI' }, { name: 'b', type: 'int', key: 'PRI' }, { name: 'label', type: 'text' }];
  session.raw = async (sql, params) => { calls.push({ sql, params }); return /COUNT/.test(sql) ? { rows: [{ total: 20 }] } : { result: [{ a: 1, b: 1, label: 'x' }, { a: 1, b: 2, label: 'x' }, { a: 1, b: 3, label: 'x' }] }; };
  return { session, calls };
}
test('grid, COUNT and column metadata use server-side parameters; generic raw calls retain their explicit protocol', async () => {
  const session = new DatabaseSession({}), calls = [];
  const metadata = [{ name: 'id', type: 'int', nullable: 'NO', keyType: 'PRI', extra: '', position: 1 }, { name: 'label', type: 'text', keyType: '', position: 2 }];
  session.connection = {
    execute(sql, params, callback) {
      calls.push({ protocol: 'execute', sql, params });
      callback(null, /information_schema/.test(sql) ? metadata : /COUNT/.test(sql) ? [{ total: 1 }] : [{ id: 1, label: "a\\b'" }]);
    },
    query(sql, params, callback) { calls.push({ protocol: 'query', sql, params }); callback(null, []); }
  };
  const options = { database: "db'\\", table: 't', searchColumn: 'label', searchMode: 'exact', search: "a\\b'" };
  await session.tableData(options); await session.countTableRows(options);
  assert.deepEqual(calls.map(call => call.protocol), ['execute', 'execute', 'execute']);
  assert.deepEqual(calls[0].params, [options.database, 't']);
  assert.equal(calls[1].params[0], options.search);
  assert.equal(calls[1].sql.includes(options.search), false);
  await session.raw('SELECT 1'); assert.equal(calls.at(-1).protocol, 'query');
  assert.equal(session.buildMysqlOptions().maxPreparedStatements, 64);
});
test('paging reads immediately, counts only on request and caches count across sort changes', async () => {
  const { session, calls } = setup(); const options = { database: 'd', table: 't', pageSize: 2 };
  const first = await session.tableData(options);
  assert.equal(calls.length, 1); assert.ok(!calls[0].sql.includes('COUNT')); assert.equal(first.total, null);
  assert.equal(first.rows.length, 2); assert.equal(first.hasMore, true);
  await session.countTableRows(options);
  assert.equal((await session.countTableRows({ ...options, orderBy: 'label' })).cached, true);
  assert.equal((await session.tableData(options)).total, 20);
  session.tableDataService.invalidate();
  assert.equal((await session.tableData(options)).total, null);
});
test('keyset pages bind composite keys and reverse previous pages without OFFSET', async () => {
  const { session, calls } = setup(); const options = { database: 'd', table: 't', pageSize: 2 };
  const first = await session.tableData(options);
  const second = await session.tableData({ ...options, page: 2, cursor: first.nextCursor });
  assert.ok(!calls.at(-1).sql.includes('OFFSET'));
  assert.match(calls.at(-1).sql, /`a` > \?.*`a` = \? AND `b` > \?/);
  assert.deepEqual(calls.at(-1).params, [1, 1, 2, 3]);
  await session.tableData({ ...options, page: 1, cursor: second.previousCursor });
  assert.match(calls.at(-1).sql, /ORDER BY `a` DESC, `b` DESC/);
  await session.tableData({ ...options, page: 2, cursor: first.nextCursor, search: 'other' });
  assert.ok(calls.at(-1).sql.includes('OFFSET'));
});
test('exact column search and stable sort include key tie breakers', async () => {
  const { session, calls } = setup();
  await session.tableData({ database: 'd', table: 't', search: 'x', searchColumn: 'label', searchMode: 'exact', orderBy: 'label' });
  assert.match(calls[0].sql, /WHERE \(`label` = \?\).*ORDER BY `label` ASC, `a` ASC, `b` ASC/);
  assert.equal(calls[0].params[0], 'x');
});

test('count cache expires and exact numeric filters reject invalid values before SQL', async () => {
  const { session, calls } = setup(); let now = 0;
  session.tableDataService.now = () => now;
  const options = { database: 'd', table: 't' };
  await session.countTableRows(options);
  now = 15001;
  assert.equal((await session.countTableRows(options)).cached, false);
  const before = calls.length;
  await assert.rejects(session.tableData({ ...options, searchColumn: 'a', searchMode: 'exact', search: 'invalid' }), { code: 'ROW_VALUE_INVALID' });
  assert.equal(calls.length, before);
});
