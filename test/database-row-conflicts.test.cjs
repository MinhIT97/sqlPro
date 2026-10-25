'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSession } = require('../electron/database.cjs');

const column = (name, type, extra = {}) => ({ name, type, key: '', nullable: 'YES', extra: '', ...extra });
const COLUMNS = [
  column('id', 'int', { key: 'PRI', nullable: 'NO' }),
  column('name', 'varchar(40)'),
  column('note', 'varchar(40)')
];

function setup(columns = COLUMNS) {
  const session = new DatabaseSession({});
  const requests = [];
  const transactions = [];
  session.listColumns = async () => columns;
  session.connection = {
    beginTransaction(callback) { transactions.push('begin'); callback(null); },
    commit(callback) { transactions.push('commit'); callback(null); },
    rollback(callback) { transactions.push('rollback'); callback(null); }
  };
  session.raw = async (sql, params) => {
    requests.push({ sql, params });
    throw new Error(`Unexpected query: ${sql}`);
  };
  return { session, requests, transactions };
}

test('cập nhật có điều kiện giữ nguyên giá trị gốc và trả ROW_CONFLICT kèm khác biệt', async () => {
  const { session } = setup();
  const logs = [];
  session.raw = async (sql, params) => {
    logs.push({ sql, params });
    if (/^UPDATE /.test(sql)) return { result: { affectedRows: 0, changedRows: 0 } };
    if (/^SELECT 1 AS present/.test(sql)) return { rows: [{ present: 1 }] };
    if (/^SELECT \*/.test(sql)) return { rows: [{ id: 1, name: 'changed elsewhere', note: 'same' }] };
    throw new Error(`Unexpected query: ${sql}`);
  };
  await assert.rejects(
    session.updateRow({
      database: 'demo',
      table: 'items',
      keys: { id: 1 },
      values: { name: 'draft' },
      original: { id: 1, name: 'original', note: 'same' }
    }),
    (error) => {
      assert.equal(error.code, 'ROW_CONFLICT');
      assert.equal(error.conflict.table, 'items');
      assert.deepEqual(error.conflict.original, { id: 1, name: 'original', note: 'same' });
      assert.equal(error.conflict.current.name, 'changed elsewhere');
      return true;
    }
  );
  assert.match(logs[0].sql, /CAST\(`name` AS BINARY\) <=> CAST\(\? AS BINARY\)/);
  assert.match(logs[0].sql, /CAST\(`note` AS BINARY\) <=> CAST\(\? AS BINARY\)/);
  assert.deepEqual(logs[0].params, ['draft', 1, '1', 'original', 'same']);
  assert.equal(logs.length, 3);
});

test('cập nhật có điều kiện trả ROW_NOT_FOUND khi bản ghi đã bị xóa', async () => {
  const { session } = setup();
  const logs = [];
  session.raw = async (sql, params) => {
    logs.push({ sql, params });
    if (/^UPDATE /.test(sql)) return { result: { affectedRows: 0, changedRows: 0 } };
    if (/^SELECT 1 AS present/.test(sql)) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  };
  await assert.rejects(
    session.updateRow({
      database: 'demo',
      table: 'items',
      keys: { id: 5 },
      values: { name: 'draft' },
      original: { id: 5, name: 'gone' }
    }),
    { code: 'ROW_NOT_FOUND' }
  );
  assert.equal(logs.length, 2);
});

test('cập nhật thành công báo đã dùng điều kiện giá trị gốc', async () => {
  const { session } = setup();
  session.raw = async (sql) => {
    assert.match(sql, /^UPDATE /);
    return { result: { affectedRows: 1, changedRows: 1 } };
  };
  const result = await session.updateRow({
    database: 'demo',
    table: 'items',
    keys: { id: 2 },
    values: { name: 'next' },
    original: { id: 2, name: 'before' }
  });
  assert.equal(result.status, 'updated');
  assert.equal(result.guardedBy, 'original-values');
});

test('điều kiện giá trị gốc giữ đúng NULL, BINARY, JSON và số lớn', async () => {
  const columns = [
    column('id', 'bigint', { key: 'PRI', nullable: 'NO' }),
    column('blob', 'varbinary(4)'),
    column('data', 'json'),
    column('note', 'varchar(40)')
  ];
  const { session } = setup(columns);
  const logs = [];
  session.raw = async (sql, params) => {
    logs.push({ sql, params });
    return { result: { affectedRows: 1, changedRows: 1 } };
  };
  const result = await session.updateRow({
    database: 'demo',
    table: 'items',
    keys: { id: '9007199254740993' },
    values: { note: 'next' },
    original: {
      id: '9007199254740993',
      blob: Buffer.from([0, 1, 2, 255]),
      data: { nested: { count: '9007199254740993' } },
      note: null
    }
  });
  assert.equal(result.status, 'updated');
  assert.match(logs[0].sql, /`blob` <=> \?/);
  assert.match(logs[0].sql, /JSON_EXTRACT\(`data`, '\$'\).*JSON_EXTRACT\(\?, '\$'\)/);
  assert.equal(logs[0].params[0], 'next');
  assert.equal(logs[0].params[1], '9007199254740993');
  assert.equal(logs[0].params[2], '9007199254740993');
  assert.deepEqual(logs[0].params[3], Buffer.from([0, 1, 2, 255]));
  assert.equal(logs[0].params[4], '{"nested":{"count":"9007199254740993"}}');
  assert.equal(logs[0].params[5], null);
});

test('xóa hàng loạt không xóa phần nào khi một bản ghi đã thay đổi', async () => {
  const { session, transactions } = setup();
  const logs = [];
  session.raw = async (sql, params) => {
    logs.push({ sql, params });
    if (/^SELECT .* FOR UPDATE$/s.test(sql)) {
      return {
        rows: [
          { id: 1, name: 'A', m0: 1 },
          { id: 2, name: 'B', m1: 0 }
        ]
      };
    }
    if (/^DELETE /.test(sql)) return { result: { affectedRows: 2 } };
    throw new Error(`Unexpected query: ${sql}`);
  };
  await assert.rejects(
    session.deleteRows({
      database: 'demo',
      table: 'items',
      keysList: [{ id: 1 }, { id: 2 }],
      originalValues: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }]
    }),
    (error) => {
      assert.equal(error.code, 'ROW_CONFLICT');
      assert.deepEqual(error.conflicts, [{ id: 2 }]);
      assert.deepEqual(error.missing, []);
      return true;
    }
  );
  assert.equal(logs.some((entry) => /^DELETE /.test(entry.sql)), false);
  assert.deepEqual(transactions, ['begin', 'rollback']);
  assert.equal(session.inTransaction, false);
  assert.equal(session.autocommit, true);
});

test('xóa hàng loạt báo ROW_NOT_FOUND khi có bản ghi biến mất', async () => {
  const { session, transactions } = setup();
  const logs = [];
  session.raw = async (sql) => {
    logs.push(sql);
    if (/^SELECT .* FOR UPDATE$/s.test(sql)) return { rows: [{ id: 1, name: 'A', m0: 1 }] };
    throw new Error('DELETE must not run');
  };
  await assert.rejects(
    session.deleteRows({
      database: 'demo',
      table: 'items',
      keysList: [{ id: 1 }, { id: 2 }],
      originalValues: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }]
    }),
    (error) => {
      assert.equal(error.code, 'ROW_NOT_FOUND');
      assert.deepEqual(error.missing, [{ id: 2 }]);
      return true;
    }
  );
  assert.equal(logs.some((sql) => /^DELETE /.test(sql)), false);
  assert.deepEqual(transactions, ['begin', 'rollback']);
});

test('xóa hàng loạt chỉ commit sau khi tất cả bản ghi khớp giá trị gốc', async () => {
  const { session, transactions } = setup();
  const logs = [];
  session.raw = async (sql, params) => {
    logs.push({ sql, params });
    if (/^SELECT .* FOR UPDATE$/s.test(sql)) {
      return { rows: [{ id: 1, name: 'A', m0: 1 }, { id: 2, name: 'B', m1: 1 }] };
    }
    if (/^DELETE /.test(sql)) return { result: { affectedRows: 2 } };
    throw new Error(`Unexpected query: ${sql}`);
  };
  const result = await session.deleteRows({
    database: 'demo',
    table: 'items',
    keysList: [{ id: 1 }, { id: 2 }],
    originalValues: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }]
  });
  assert.equal(result.affectedRows, 2);
  assert.equal(result.guardedBy, 'original-values');
  assert.equal(result.transaction, 'statement');
  assert.deepEqual(transactions, ['begin', 'commit']);
  const select = logs.find((entry) => /^SELECT /.test(entry.sql));
  assert.match(select.sql, /CAST\(`name` AS BINARY\).*AS m0/);
  assert.match(select.sql, /CAST\(`name` AS BINARY\).*AS m1/);
  assert.equal(select.sql.includes('FOR UPDATE'), true);
  const remove = logs.find((entry) => /^DELETE /.test(entry.sql));
  assert.deepEqual(remove.params, [1, 2]);
});

for (const mode of ['autocommit-off', 'existing']) {
  for (const outcome of ['success', 'conflict']) {
    test(`guarded delete uses a savepoint in ${mode} on ${outcome} without owning the caller transaction`, async () => {
      const { session, transactions } = setup();
      session.autocommit = mode !== 'autocommit-off';
      session.inTransaction = mode === 'existing';
      const commands = [];
      session.raw = async (sql) => {
        commands.push(sql);
        if (/^SELECT .*FOR UPDATE$/s.test(sql)) return { rows: [{ id: 1, m0: outcome === 'success' ? 1 : 0 }] };
        if (/^DELETE/.test(sql)) return { result: { affectedRows: 1 } };
        return { rows: [] };
      };
      const pending = session.deleteRows({ database: 'demo', table: 'items', keysList: [{ id: 1 }], originalValues: [{ id: 1, name: 'before' }] });
      if (outcome === 'conflict') await assert.rejects(pending, { code: 'ROW_CONFLICT' });
      else assert.equal((await pending).transaction, 'existing');
      assert.deepEqual(transactions, []);
      assert.match(commands[0], /^SAVEPOINT `sqlpro_delete_/);
      assert.match(commands.at(-1), /^RELEASE SAVEPOINT /);
      assert.equal(commands.some((sql) => /^ROLLBACK TO SAVEPOINT/.test(sql)), outcome === 'conflict');
      assert.equal(session.autocommit, mode !== 'autocommit-off');
      assert.equal(session.inTransaction, true);
    });
  }
}

test('literal ellipses are guarded as text; binary previews require full-value hashes', async () => {
  const { session } = setup([column('id', 'int', { key: 'PRI' }), column('note', 'text'), column('data', 'blob')]);
  let request;
  session.raw = async (sql, params) => { request = { sql, params }; return { result: { affectedRows: 1, changedRows: 1 } }; };
  const input = { database: 'demo', table: 'items', keys: { id: 1 }, values: { note: 'new' } };
  await session.updateRow({ ...input, original: { note: 'complete…text', data: { kind: 'sha256', value: 'ab'.repeat(32) } } });
  assert.ok(request.params.includes('complete…text'));
  assert.match(request.sql, /SHA2\(`data`, 256\) <=> \?/);
  assert.ok(request.params.includes('ab'.repeat(32)));
  await assert.rejects(session.updateRow({ ...input, original: { data: '0x0012… (100 bytes)' } }), { code: 'ROW_ORIGINAL_INCOMPLETE' });
  await assert.rejects(session.updateRow({ ...input, original: { data: { kind: 'sha256', value: 'invalid' } } }), { code: 'ROW_ORIGINAL_INCOMPLETE' });
});
