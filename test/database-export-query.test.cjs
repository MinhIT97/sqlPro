'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2');
const { DatabaseSession } = require('../electron/database.cjs');

function querySession(fields, rows, calls = []) {
  const session = new DatabaseSession({});
  session.connection = {
    query(config) {
      calls.push(config);
      return {
        on(event, handler) {
          if (event === 'fields') this.fieldsHandler = handler;
        },
        async *stream() {
          if (this.fieldsHandler) this.fieldsHandler(fields);
          for (const row of rows) yield row;
        }
      };
    }
  };
  return { session, calls };
}

function field(name, columnType = mysql.Types.VAR_STRING) {
  return { name, columnType };
}

test('exportQueryFile xuất toàn bộ kết quả JSON và tách tên cột trùng', async () => {
  const rows = Array.from({ length: 5001 }, (_value, index) => [index, null, `0x0${index % 10}`]);
  const { session, calls } = querySession(
    [field('id', mysql.Types.LONGLONG), field('id'), field('raw', mysql.Types.BLOB)],
    rows
  );
  let output = '';
  const result = await session.exportQueryFile(
    { sql: 'SELECT id, id, raw FROM items', format: 'json' },
    async (chunk) => { output += chunk; }
  );
  assert.equal(calls[0].sql, 'SELECT id, id, raw FROM items');
  assert.equal(calls[0].rowsAsArray, true);
  assert.equal(result.rows, 5001);
  assert.deepEqual(result.columns, ['id', 'id_2', 'raw']);
  const parsed = JSON.parse(output);
  assert.equal(parsed.length, 5001);
  assert.deepEqual(parsed[0], { id: 0, id_2: null, raw: '0x00' });
  assert.deepEqual(parsed[5000], { id: 5000, id_2: null, raw: '0x00' });
});

test('exportQueryFile CSV giữ khác biệt NULL, chuỗi rỗng và backslash-N', async () => {
  const { session } = querySession(
    [field('a'), field('b'), field('c'), field('d')],
    [[null, '', '\\N', 'a,b']]
  );
  let output = '';
  await session.exportQueryFile(
    { sql: 'SELECT * FROM items', format: 'csv' },
    async (chunk) => { output += chunk; }
  );
  assert.equal(output, 'a,b,c,d\n\\N,,\\\\N,"a,b"\n');
});

test('exportQueryFile giữ JSON của cột JSON và BIT/binary dạng hex', async () => {
  const { session } = querySession(
    [field('payload', mysql.Types.JSON), field('raw', mysql.Types.BLOB)],
    [['{"n":18446744073709551615}', Buffer.from('00ff', 'hex')]]
  );
  let output = '';
  await session.exportQueryFile(
    { sql: 'SELECT payload, raw FROM items', format: 'json' },
    async (chunk) => { output += chunk; }
  );
  assert.ok(output.includes('"payload":{"n":18446744073709551615}'));
  assert.deepEqual(JSON.parse(output), [{ payload: { n: 18446744073709551615 }, raw: '0x00ff' }]);
});

test('exportQueryFile chỉ chấp nhận một câu lệnh đọc dữ liệu', async () => {
  const { session, calls } = querySession([field('id')], [[1]]);
  for (const sql of ['', 'SELECT 1; SELECT 2', 'DELETE FROM items', 'WITH x AS (SELECT 1) UPDATE items SET id = 1']) {
    await assert.rejects(
      session.exportQueryFile({ sql, format: 'csv' }, async () => {}),
      (error) => ['EMPTY_QUERY', 'INVALID_EXPORT_QUERY'].includes(error.code)
    );
  }
  assert.equal(calls.length, 0);
});

test('cancel during the final buffered write still rejects instead of committing the file', async () => {
  const { session } = querySession([field('id')], [[1]]);
  await assert.rejects(session.exportQueryFile(
    { sql: 'SELECT id FROM items', format: 'json', taskId: 'final-write' },
    async () => { session.cancelTask('final-write'); }
  ), { code: 'EXPORT_CANCELED' });
  assert.equal(session.activeTask, null);
});
