'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTableSearch } = require('../electron/table-search.cjs');
const { DatabaseSession } = require('../electron/database.cjs');

const columns = [{ name: 'id', type: 'bigint', key: 'PRI' }, { name: 'tên`cột', type: 'varchar(200)' }, { name: 'amount', type: 'decimal(30,2)' }];
const quoteId = value => '`' + value.replace(/`/g, '``') + '`';
const compile = options => buildTableSearch(options, columns, { quoteId, coerceValue: value => value });

test('contains/prefix bind literal wildcard, escape, Unicode, quote and backslash characters', () => {
  const term = "a%_==\\' Việt";
  const contains = compile({ search: term, searchColumn: 'tên`cột' });
  assert.equal(contains.where, "(CAST(`tên``cột` AS CHAR) LIKE ? ESCAPE '=')");
  assert.deepEqual(contains.params, ["%a=%=_====\\' Việt%"]);
  const prefix = compile({ search: term, searchColumn: 'tên`cột', searchMode: 'prefix' });
  assert.equal(prefix.where, "(`tên``cột` LIKE ? ESCAPE '=')");
  assert.deepEqual(prefix.params, ["a=%=_====\\' Việt%"]);
  assert.ok(!prefix.where.includes(term));
  assert.match(compile({ search: '12', searchColumn: 'id', searchMode: 'prefix' }).where, /CAST\(`id` AS CHAR\)/);
  const all = compile({ search: 'a', searchMode: 'prefix' });
  assert.equal((all.where.match(/CAST\(/g) || []).length, 3);
  assert.deepEqual(all.params, ['a%', 'a%', 'a%']);
});

test('NULL predicates require one real column and never depend on a search value', () => {
  for (const [mode, operator] of [['is-null', 'IS NULL'], ['not-null', 'IS NOT NULL']]) {
    const plan = compile({ searchMode: mode, searchColumn: 'tên`cột', search: 'ignored' });
    assert.equal(plan.where, `(${quoteId('tên`cột')} ${operator})`);
    assert.deepEqual(plan.params, []);
    assert.equal(plan.key, compile({ searchMode: mode, searchColumn: 'tên`cột' }).key);
    assert.throws(() => compile({ searchMode: mode }), { code: 'INVALID_FILTER' });
  }
  assert.throws(() => compile({ searchColumn: 'missing', searchMode: 'is-null' }), { code: 'INVALID_COLUMN' });
  assert.throws(() => compile({ searchMode: "prefix') OR 1=1 --" }), { code: 'INVALID_FILTER' });
  assert.equal(compile({ search: '   ' }).where, '');
  assert.equal(compile({ search: 'x'.repeat(300) }).params[0].length, 202);
});

test('grid/count share predicates and cache/cursor bindings include modes and exact identifiers', async () => {
  const session = new DatabaseSession({}), calls = [];
  session.listColumns = async () => columns;
  session.raw = async (sql, params) => {
    calls.push({ sql, params });
    return /COUNT/.test(sql) ? { rows: [{ total: 2 }] } : { result: [{ id: '1' }, { id: '2' }] };
  };
  const base = { database: 'd', table: 't', pageSize: 1, searchColumn: 'tên`cột', searchMode: 'prefix', search: '%_' };
  const first = await session.tableData(base);
  const grid = calls.at(-1);
  await session.countTableRows(base);
  assert.equal(calls.at(-1).sql.split(' WHERE ')[1], grid.sql.split(' WHERE ')[1].split(' ORDER BY ')[0]);
  assert.deepEqual(calls.at(-1).params, ['=%=_%']);
  assert.equal((await session.countTableRows(base)).cached, true);
  assert.equal((await session.countTableRows({ ...base, searchMode: 'contains' })).cached, false);
  await session.tableData({ ...base, page: 2, cursor: first.nextCursor, searchMode: 'contains' });
  assert.match(calls.at(-1).sql, /OFFSET \?/);
  await session.tableData({ ...base, searchMode: 'is-null', search: 'ignored' });
  assert.match(calls.at(-1).sql, /WHERE \(`tên``cột` IS NULL\)/);
  assert.deepEqual(calls.at(-1).params, [2, 0]);
  const before = calls.length;
  await assert.rejects(session.tableData({ ...base, searchColumn: null, searchMode: 'not-null' }), { code: 'INVALID_FILTER' });
  await assert.rejects(session.tableData({ ...base, searchColumn: 'id', searchMode: 'exact', search: 'not-an-integer' }), { code: 'ROW_VALUE_INVALID' });
  assert.equal(calls.length, before);
  await session.tableData({ ...base, searchColumn: 'id', searchMode: 'exact', search: '9223372036854775807' });
  assert.equal(calls.at(-1).params[0], '9223372036854775807');
});
