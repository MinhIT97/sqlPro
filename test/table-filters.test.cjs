'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Filters = require('../table-filters.js');
const { DatabaseSession } = require('../electron/database.cjs');
const columns = [
  { name: 'id', type: 'bigint', key: 'PRI' }, { name: 'title`', type: 'varchar(200)' },
  { name: 'date', type: 'date' }, { name: 'total', type: 'decimal(30,2)', extra: 'VIRTUAL GENERATED' },
  { name: 'payload', type: 'json' }, { name: 'data', type: 'blob' }, { name: 'shape', type: 'geometry' }
];
const rule = (column = 'id', operator = 'eq', value = '1') => ({ column, operator, value });
const tree = (...items) => ({ version: 1, op: 'AND', items });
const compile = input => Filters.compile(input, columns);

test('mixed groups retain parentheses, bound value order, exact names and immutable canonical trees', () => {
  const input = tree(rule('id', 'gte', '9223372036854775800'), { op: 'OR', items: [rule('title`', 'prefix', "%' OR 1=1"), { column: 'date', operator: 'is-null' }] });
  const before = JSON.stringify(input), plan = compile(input);
  assert.equal(plan.where, "(`id` >= ? AND (`title``` LIKE ? ESCAPE '=' OR `date` IS NULL))");
  assert.deepEqual(plan.params, ['9223372036854775800', "=%' OR 1==1%"]);
  assert.ok(!plan.where.includes('9223372036854775800')); assert.ok(!plan.where.includes('OR 1=1'));
  assert.equal(JSON.stringify(input), before); assert.equal(plan.rules, 3);
  assert.ok(Object.isFrozen(plan.tree)); assert.ok(Object.isFrozen(plan.tree.items)); assert.ok(Object.isFrozen(plan.tree.items[1].items[0]));
  assert.equal(plan.key, compile(plan.tree).key);
});

test('typed ranges preserve decimal and SQL dates, generated values and empty text', () => {
  const plan = compile(tree(rule('total', 'between', ['12345678901234567890.01', '12345678901234567890.12']), rule('date', 'between', ['2026-11-01', '2026-11-17']), rule('title`', 'eq', '')));
  assert.deepEqual(plan.params, ['12345678901234567890.01', '12345678901234567890.12', '2026-11-01', '2026-11-17', '']);
  assert.match(plan.where, /`total` BETWEEN \? AND \? AND `date` BETWEEN \? AND \?/);
  assert.deepEqual(compile(tree(rule('title`', 'contains', ' %_= '))).params, ['% =%=_== %']);
  for (const invalid of [rule('id', 'eq', '1.5'), rule('date', 'eq', '2026-02-30'), rule('total', 'eq', '1.123'), rule('title`', 'between', ['a', 'b']), rule('payload'), rule('data'), rule('shape')]) {
    assert.throws(() => compile(tree(invalid)), { code: 'INVALID_FILTER' });
  }
  for (const column of ['payload', 'data', 'shape']) assert.deepEqual(compile(tree({ column, operator: 'is-null' })).params, []);
});

test('invalid or empty trees never become missing predicates or silently dropped rules', () => {
  const inherited = Object.assign(Object.create({ version: 1, op: 'AND' }), { items: [rule()] });
  const cycle = tree(rule()); cycle.items.push(cycle);
  for (const invalid of [false, [], {}, tree(), rule(), { ...tree(rule()), version: 2 }, { ...tree(rule()), op: 'AND 1=1' },
    tree({ op: 'OR', items: [] }), tree({ ...rule(), sql: '1=1' }), tree(rule('missing')), tree(rule('id', 'LIKE', '1')),
    tree({ column: 'id', operator: 'eq' }), tree({ column: 'id', operator: 'is-null', value: '' }), tree(rule('id', 'eq', 1)),
    tree(rule('id', 'between', ['1'])), tree(rule('id', 'between', ['1', null])), inherited, cycle]) {
    assert.throws(() => compile(invalid), { code: 'INVALID_FILTER' });
  }
  assert.equal(compile(null).where, '');
  assert.throws(() => Filters.compile(tree(rule()), [...columns, columns[0]]), { code: 'INVALID_FILTER' });
});

test('IN and NOT IN bind typed lists without splitting commas, trimming text or losing precision', () => {
  const values = ['', ' NULL ', 'NULL', 'a,b', "x') OR 1=1 --", '%_\\='];
  const input = tree(rule('title`', 'in', values), { op: 'OR', items: [rule('id', 'not-in', ['9223372036854775800', '2']),
    rule('total', 'in', ['12345678901234567890.01', '1.00']), rule('date', 'not-in', ['2026-11-17'])] });
  const before = JSON.stringify(input), plan = compile(input);
  assert.equal(plan.where, '(`title``` IN (?, ?, ?, ?, ?, ?) AND (`id` NOT IN (?, ?) OR `total` IN (?, ?) OR `date` NOT IN (?)))');
  assert.deepEqual(plan.params, [...values, '9223372036854775800', '2', '12345678901234567890.01', '1.00', '2026-11-17']);
  assert.equal(plan.where.includes('OR 1=1'), false);
  assert.equal(JSON.stringify(input), before);
  assert.ok(Object.isFrozen(plan.tree.items[0].value));
  assert.equal(plan.key, compile(plan.tree).key);
  assert.deepEqual(Filters.compile(tree(rule('choice', 'in', ['a,b'])), [{ name: 'choice', type: "enum('a,b','x')" }]).params, ['a,b']);
});

test('list cardinality, total values, unsupported types and any invalid member fail the entire predicate', async () => {
  const list = Array.from({ length: 20 }, (_, index) => String(index));
  assert.equal(compile(tree(...Array.from({ length: 5 }, () => rule('id', 'in', list)))).params.length, 100);
  const bad = [[], '1,2', ['1', null], ['1', 2], Array(2), Array.from({ length: 21 }, () => '1'), ['1', '1.5'], ['1', 'x']];
  for (const operator of ['in', 'not-in']) {
    for (const values of bad) assert.throws(() => compile(tree(rule('id', operator, values))), { code: 'INVALID_FILTER' });
    assert.throws(() => compile(tree(rule('date', operator, ['2026-02-30']))), { code: 'INVALID_FILTER' });
    assert.throws(() => compile(tree(rule('title`', operator, ['x'.repeat(201)]))), { code: 'INVALID_FILTER' });
    for (const column of ['payload', 'data', 'shape']) assert.throws(() => compile(tree(rule(column, operator, ['x']))), { code: 'INVALID_FILTER' });
  }
  assert.throws(() => compile(tree(...Array.from({ length: 5 }, () => rule('id', 'in', list)), rule())), /100 giá trị/);
  assert.throws(() => compile(tree(...Array.from({ length: 5 }, () => rule('id', 'in', list)), rule('title`', 'prefix', 'x'))), /100 giá trị/);
  const session = new DatabaseSession({}); let reads = 0;
  session.listColumns = async () => columns;
  session.raw = async () => { reads++; return { result: [] }; };
  await assert.rejects(session.tableData({ database: 'd', table: 't', filterTree: tree(rule('id', 'in', ['1', null])) }), { code: 'INVALID_FILTER' });
  await assert.rejects(session.countTableRows({ database: 'd', table: 't', filterTree: tree(rule('id', 'not-in', [])) }), { code: 'INVALID_FILTER' });
  assert.equal(reads, 0);
});

test('depth/group/rule/value quotas are enforced before returning any partial predicate', () => {
  assert.equal(compile(tree(...Array.from({ length: 20 }, () => rule()))).rules, 20);
  assert.throws(() => compile(tree(...Array.from({ length: 21 }, () => rule()))), { code: 'INVALID_FILTER' });
  assert.equal(compile(tree(...Array.from({ length: 7 }, () => ({ op: 'OR', items: [rule()] })))).rules, 7);
  assert.throws(() => compile(tree(...Array.from({ length: 8 }, () => ({ op: 'OR', items: [rule()] })))), { code: 'INVALID_FILTER' });
  assert.equal(compile(tree({ op: 'OR', items: [{ op: 'AND', items: [rule()] }] })).rules, 1);
  assert.throws(() => compile(tree({ op: 'OR', items: [{ op: 'AND', items: [{ op: 'OR', items: [rule()] }] }] })), { code: 'INVALID_FILTER' });
  assert.equal(compile(tree(rule('title`', 'eq', 'a'.repeat(200)))).params[0].length, 200);
  assert.throws(() => compile(tree(rule('title`', 'eq', 'a'.repeat(201)))), { code: 'INVALID_FILTER' });
});

test('advanced filters bind COUNT/cache/cursor and combine with quick search through one predicate', async () => {
  const session = new DatabaseSession({}), calls = [];
  session.listColumns = async () => columns;
  session.raw = async (sql, params) => { calls.push({ sql, params }); return /COUNT/.test(sql) ? { rows: [{ total: 1 }] } : { result: [{ id: '1' }, { id: '2' }] }; };
  const options = { database: 'd', table: 't', pageSize: 1, search: '%', searchColumn: 'title`', filterTree: tree(rule('id', 'gte', '1')) };
  const first = await session.tableData(options);
  assert.deepEqual(calls.at(-1).params, ['%=%%', '1', 2, 0]);
  assert.match(calls.at(-1).sql, /WHERE \(CAST\(`title``` AS CHAR\) LIKE \? ESCAPE '='\) AND \(`id` >= \?\)/);
  await session.countTableRows(options); assert.equal((await session.countTableRows(options)).cached, true);
  const changed = { ...options, filterTree: tree(rule('id', 'gte', '2')) };
  assert.equal((await session.countTableRows(changed)).cached, false);
  await session.tableData({ ...changed, page: 2, cursor: first.nextCursor }); assert.match(calls.at(-1).sql, /OFFSET/);
  const lists = { ...options, filterTree: tree(rule('id', 'in', ['1', '2'])) };
  const listPage = await session.tableData(lists);
  assert.equal((await session.countTableRows(lists)).cached, false);
  assert.equal((await session.countTableRows(lists)).cached, true);
  const listChanged = { ...lists, filterTree: tree(rule('id', 'in', ['1', '3'])) };
  assert.equal((await session.countTableRows(listChanged)).cached, false);
  await session.tableData({ ...listChanged, page: 2, cursor: listPage.nextCursor }); assert.match(calls.at(-1).sql, /OFFSET/);
  const before = calls.length;
  await assert.rejects(session.tableData({ ...options, filterTree: tree() }), { code: 'INVALID_FILTER' });
  assert.equal(calls.length, before);
});

test('shared filter asset is loaded after row values and included in the packaged app', () => {
  const root = path.join(__dirname, '..'), html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(html.indexOf('src="table-filters.js"') > html.indexOf('src="row-values.js"'));
  assert.ok(html.indexOf('src="table-filters.js"') < html.indexOf('src="app.js"'));
  assert.ok(require('../package.json').build.files.includes('table-filters.js'));
});
