'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { DatabaseSession } = require('../electron/database.cjs');

function stubSession(runQuery) {
  const session = new DatabaseSession({});
  session.connection = {};
  session.runQuery = runQuery;
  return session;
}

test('batch row results share a byte allowance without dropping later statements', async () => {
  const limits = [];
  const session = stubSession(async (_sql, _timeout, _rows, bytes) => {
    limits.push(bytes);
    return { kind: 'rows', columns: [], rows: [], bytes: Math.min(bytes, 32 * 1024 * 1024), truncated: bytes === 0 };
  });
  const result = await session.runQueryScript('SELECT 1; SELECT 2; SELECT 3');
  assert.deepEqual(limits, [32 * 1024 * 1024, 32 * 1024 * 1024, 0]);
  assert.equal(result.executedCount, 3);
});

test('batch results capture each statement database before later USE statements change it', async () => {
  let database = 'first';
  const session = stubSession(async (sql) => {
    if (sql.startsWith('USE ')) { database = sql.slice(4); return { kind: 'ok' }; }
    return { kind: 'rows', rows: [[database]], columns: [], truncated: false };
  });
  session.database = 'first';
  session.raw = async () => ({ rows: [{ value: database }] });
  const result = await session.runQueryScript('SELECT 1; USE second; SELECT 1; USE first; SELECT 1');
  assert.deepEqual(result.results.map((entry) => entry.database), ['first', 'first', 'second', 'second', 'first']);
});

test('parse toàn bộ script trước khi execute', async () => {
  const calls = [];
  const session = stubSession(async (sql) => {
    calls.push(sql);
    return { kind: 'ok', affectedRows: 0 };
  });
  await assert.rejects(
    session.runQueryScript("SELECT 1; SELECT 'chưa đóng;"),
    (error) => error.code === 'INVALID_SQL_SCRIPT'
  );
  assert.deepEqual(calls, []);
});

test('chạy tuần tự và trả partial results khi statement bị lỗi', async () => {
  const calls = [];
  const session = stubSession(async (sql) => {
    calls.push(sql);
    if (sql === 'SELECT broken') {
      const error = new Error('Unknown column');
      error.code = 'ER_BAD_FIELD_ERROR';
      error.sqlState = '42S22';
      throw error;
    }
    return { kind: 'rows', columns: [], rows: [[sql]], truncated: false };
  });

  const batch = await session.runQueryScript('SELECT 1; SELECT broken; SELECT 3;');
  assert.deepEqual(calls, ['SELECT 1', 'SELECT broken']);
  assert.equal(batch.kind, 'batch');
  assert.equal(batch.statementCount, 3);
  assert.equal(batch.executedCount, 2);
  assert.equal(batch.succeededCount, 1);
  assert.equal(batch.failedCount, 1);
  assert.equal(batch.stopped, true);
  assert.deepEqual(batch.results[1].error, {
    message: 'Unknown column',
    code: 'ER_BAD_FIELD_ERROR',
    sqlState: '42S22'
  });
});

test('kiểm tra mọi statement nguy hiểm trước khi execute', async () => {
  const calls = [];
  const session = stubSession(async (sql) => {
    calls.push(sql);
    return { kind: 'ok', affectedRows: 1 };
  });
  const sql = 'SELECT 1; WITH ids AS (SELECT 1) UPDATE users SET active = 0; /*!50000 DELETE FROM logs */;';
  await assert.rejects(
    session.runQueryScript(sql),
    (error) => error.code === 'CONFIRM_REQUIRED' && /#2, 3/.test(error.message)
  );
  assert.deepEqual(calls, []);

  const batch = await session.runQueryScript(sql, 30000, true);
  assert.equal(batch.executedCount, 3);
  assert.equal(batch.failedCount, 0);
});

test('giới hạn 100 statement trước khi execute', async () => {
  let calls = 0;
  const session = stubSession(async () => {
    calls += 1;
    return { kind: 'ok' };
  });
  const sql = Array.from({ length: 101 }, (_, index) => `SELECT ${index}`).join(';');
  await assert.rejects(session.runQueryScript(sql), (error) => error.code === 'TOO_MANY_STATEMENTS');
  assert.equal(calls, 0);
});

test('giới hạn tổng số row lưu trong batch nhưng vẫn chạy statement sau', async () => {
  const limits = [];
  const session = stubSession(async (sql, timeoutMs, rowLimit) => {
    limits.push(rowLimit);
    const count = Math.min(5000, rowLimit);
    return {
      kind: 'rows',
      columns: [],
      rows: Array.from({ length: count }, () => [sql]),
      truncated: count === 0
    };
  });
  const batch = await session.runQueryScript('SELECT 1; SELECT 2; SELECT 3;', 30000, false, null, { rowLimit: 5000 });
  assert.deepEqual(limits, [5000, 5000, 0]);
  assert.equal(batch.executedCount, 3);
  assert.equal(batch.stopped, false);
  assert.equal(batch.truncated, true);
  assert.equal(batch.results.reduce((sum, entry) => sum + entry.result.rows.length, 0), 10000);
});

test('timeout toàn batch dừng câu sau và giữ kết quả đã chạy', async () => {
  const session = stubSession(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
    return { kind: 'ok', affectedRows: 0 };
  });
  const batch = await session.runQueryScript('SELECT 1; SELECT 2;', 5);
  assert.equal(batch.succeededCount, 1);
  assert.equal(batch.failedCount, 1);
  assert.equal(batch.results[1].error.code, 'QUERY_TIMEOUT');
});

test('CTE UPDATE dùng nhánh mutation thay vì streaming rows', async () => {
  const session = new DatabaseSession({});
  let callbackQuery = false;
  session.connection = {
    query(sql, callback) {
      callbackQuery = typeof callback === 'function';
      queueMicrotask(() => callback(null, { affectedRows: 2, changedRows: 2 }));
    }
  };
  const result = await session.runQuery('WITH ids AS (SELECT id FROM users) UPDATE users SET active = 0');
  assert.equal(callbackQuery, true);
  assert.equal(result.kind, 'ok');
  assert.equal(result.affectedRows, 2);
});

test('truncate row result chỉ drain phần dư và giữ connection dùng được', async () => {
  const session = new DatabaseSession({});
  let destroyCalls = 0;
  let queryCalls = 0;
  session.connection = {
    destroy() {
      destroyCalls += 1;
    },
    query(options) {
      queryCalls += 1;
      const query = new EventEmitter();
      queueMicrotask(() => {
        query.emit('fields', [{ name: 'id', orgName: 'id', table: 'items', columnType: 3 }]);
        for (let index = 0; index < 5002; index += 1) query.emit('result', [index]);
        query.emit('end');
      });
      return query;
    }
  };

  const first = await session.runQuery('SELECT id FROM items');
  const second = await session.runQuery('SELECT id FROM items', 30000, 1);
  assert.equal(first.rows.length, 5000);
  assert.equal(first.truncated, true);
  assert.equal(second.rows.length, 1);
  assert.equal(second.truncated, true);
  assert.equal(queryCalls, 2);
  assert.equal(destroyCalls, 0);
  assert.equal(session.dead, false);
});

test('hủy batch dừng statement hiện tại, không chạy statement kế tiếp', async () => {
  const session = new DatabaseSession({});
  let destroyCalls = 0;
  let queryCalls = 0;
  session.connection = {
    destroy() {
      destroyCalls += 1;
    },
    query() {
      queryCalls += 1;
      return new EventEmitter();
    }
  };

  const pending = session.runQueryScript('SELECT 1; SELECT 2;');
  await Promise.resolve();
  assert.equal(typeof session.cancelQuery, 'function');
  session.cancelQuery();
  const batch = await pending;
  assert.equal(batch.executedCount, 1);
  assert.equal(batch.failedCount, 1);
  assert.equal(batch.results[0].error.code, 'QUERY_CANCELED');
  assert.equal(queryCalls, 1);
  assert.equal(destroyCalls, 1);
  assert.equal(session.dead, true);
});

