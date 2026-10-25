'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSession } = require('../electron/database.cjs');
const column = (name, type, extra = {}) => ({ name, type, key: '', nullable: 'YES', extra: '', ...extra });

function setup(columns) {
  const session = new DatabaseSession({});
  const requests = [];
  session.listColumns = async () => columns;
  session.raw = async (sql, params) => { requests.push({ sql, params }); return { result: { affectedRows: 1, changedRows: 1, insertId: 1 } }; };
  return { session, requests };
}

test('row writes bind date/time and exact numeric values without conversion', async () => {
  const { session, requests } = setup([column('id', 'int', { key: 'PRI', nullable: 'NO' }), column('at', 'datetime(6)'), column('amount', 'decimal(30,6)'), column('count', 'bigint unsigned')]);
  await session.updateRow({ database: 'demo', table: 'items', keys: { id: 1 }, values: { at: '2026-10-24 23:59:59.123456', amount: '12345678901234567890.123456', count: '18446744073709551615' } });
  assert.deepEqual(requests[0].params, ['2026-10-24 23:59:59.123456', '12345678901234567890.123456', '18446744073709551615', 1]);
  assert.match(requests[0].sql, /SET `at` = \?, `amount` = \?, `count` = \?/);
});

test('invalid row data is rejected before SQL executes', async () => {
  const { session, requests } = setup([column('id', 'int', { key: 'PRI' }), column('at', 'date'), column('json', 'json'), column('status', "enum('open','closed')")]);
  for (const values of [{ at: '2026-02-30' }, { json: '{bad}' }, { status: 'other' }]) {
    await assert.rejects(session.updateRow({ database: 'demo', table: 'items', keys: { id: 1 }, values }), { code: 'ROW_VALUE_INVALID' });
  }
  assert.equal(requests.length, 0);
});

test('binary and BIT updates bind bytes, including binary primary keys', async () => {
  const { session, requests } = setup([column('id', 'binary(2)', { key: 'PRI' }), column('raw', 'blob'), column('flags', 'bit(4)')]);
  await session.updateRow({ database: 'demo', table: 'items', keys: { id: '0x00ff' }, values: { raw: '0x0001ff', flags: '1010' } });
  assert.deepEqual(requests[0].params, [Buffer.from('0001ff', 'hex'), Buffer.from('0a', 'hex'), Buffer.from('00ff', 'hex')]);
  await session.updateRow({ database: 'demo', table: 'items', keys: { id: Buffer.from('00ff', 'hex') }, values: { raw: '0x00' } });
  assert.deepEqual(requests[1].params, [Buffer.from('00', 'hex'), Buffer.from('00ff', 'hex')]);
});

test('deleting rows binds binary and BIT primary keys as bytes', async () => {
  const { session, requests } = setup([column('id', 'binary(2)', { key: 'PRI' }), column('flags', 'bit(4)', { key: 'PRI' })]);
  await session.deleteRows({
    database: 'demo',
    table: 'items',
    keysList: [{ id: '0x00ff', flags: '1010' }, { id: Buffer.from('abcd', 'hex'), flags: '0001' }]
  });
  assert.deepEqual(requests[0].params, [
    Buffer.from('00ff', 'hex'), Buffer.from('0a', 'hex'),
    Buffer.from('abcd', 'hex'), Buffer.from('01', 'hex')
  ]);
});

test('insert honors omitted defaults and preserves empty/literal NULL/JSON values', async () => {
  const { session, requests } = setup([column('empty', 'varchar(20)'), column('literal', 'varchar(20)'), column('nullable', 'int'), column('json', 'json'), column('generated', 'int', { extra: 'STORED GENERATED' })]);
  await session.insertRow({ database: 'demo', table: 'items', values: { empty: '', literal: 'NULL', nullable: null, json: '{"n":18446744073709551615}', generated: 1 } });
  assert.deepEqual(requests[0].params, ['', 'NULL', null, '{"n":18446744073709551615}']);
  assert.doesNotMatch(requests[0].sql, /generated/);
  await session.insertRow({ database: 'demo', table: 'items', values: {} });
  assert.match(requests[1].sql, /\(\) VALUES \(\)/);
});

test('MySQL options keep JSON and dates as strings for precise editing', () => {
  const options = new DatabaseSession({ host: 'db.example', port: 3306, user: 'demo' }).buildMysqlOptions();
  assert.equal(options.jsonStrings, true);
  assert.equal(options.dateStrings, true);
  assert.equal(options.bigNumberStrings, true);
  assert.deepEqual(options.flags, ['FOUND_ROWS']);
});

test('row update distinguishes missing rows from unchanged matched rows', async () => {
  const { session } = setup([column('id', 'int', { key: 'PRI' }), column('label', 'varchar(30)')]);
  const input = { database: 'demo', table: 'items', keys: { id: 1 }, values: { label: 'same' } };
  session.raw = async () => ({ result: { affectedRows: 0, changedRows: 0 } });
  await assert.rejects(session.updateRow(input), { code: 'ROW_NOT_FOUND' });
  session.raw = async () => ({ result: { affectedRows: 1, changedRows: 0 } });
  assert.deepEqual(await session.updateRow(input), { status: 'unchanged', matchedRows: 1, affectedRows: 1, changedRows: 0 });
  await assert.rejects(session.updateRow({ ...input, values: { unknown: 'ignored' } }), { code: 'NO_ROW_CHANGES' });
});
