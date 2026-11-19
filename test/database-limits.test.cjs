'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { DatabaseSession } = require('../electron/database.cjs');
const { ResultBudget } = require('../electron/result-budget.cjs');

test('SQL editor default can return 11,674 rows without truncating at 5,000', async () => {
  const session = new DatabaseSession({});
  session.connection = { query() {
    const query = new EventEmitter();
    queueMicrotask(() => {
      query.emit('fields', [{ name: 'id', columnType: 3 }]);
      for (let i = 0; i < 11674; i += 1) query.emit('result', [i]);
      query.emit('end');
    });
    return query;
  } };
  const result = await session.runQueryScript('SELECT id FROM items');
  assert.equal(result.rows.length, 11674);
  assert.equal(result.truncated, false);
  const limited = await session.runQueryScript('SELECT id FROM items', 30000, false, null, { rowLimit: 5000 });
  assert.equal(limited.rows.length, 5000);
  assert.equal(limited.truncationReason, 'row-limit');
});

test('read timeout reports received rows, closes the stalled session and never retries SQL', async () => {
  const session = new DatabaseSession({});
  let destroyed = 0, queries = 0;
  session.connection = {
    destroy() { destroyed += 1; },
    query() { queries += 1; const query = new EventEmitter(); queueMicrotask(() => query.emit('result', [1])); return query; }
  };
  await assert.rejects(session.runQuery('SELECT id FROM items', 10), (error) => {
    assert.equal(error.code, 'QUERY_TIMEOUT');
    assert.match(error.message, /đã nhận 1 dòng/);
    return true;
  });
  assert.equal(session.dead, true);
  assert.equal(destroyed, 1);
  assert.equal(queries, 1);
});

test('row budgets account for escaped JSON and stop oversized cells before keeping a row', () => {
  const budget = new ResultBudget({ rows: 10, bytes: 30 });
  assert.equal(budget.add(['abc']), true);
  assert.equal(budget.add(['"'.repeat(12)]), false);
  assert.equal(budget.reason, 'byte-limit'); assert.equal(budget.rows.length, 1);
  assert.equal(budget.bytes, Buffer.byteLength(JSON.stringify(budget.rows)));
});
test('query byte limit interrupts through a control connection without destroying its SQL session', async () => {
  const session = new DatabaseSession({});
  const emitter = new EventEmitter(); let destroyed = 0, paused = 0, resumed = 0;
  const connection = { threadId: 42, pause() { paused++; }, resume() { resumed++; emitter.emit('error', Object.assign(new Error('interrupted'), { code: 'ER_QUERY_INTERRUPTED' })); }, destroy() { destroyed++; }, query() { queueMicrotask(() => { emitter.emit('result', ['small']); emitter.emit('result', ['x'.repeat(100)]); }); return emitter; } };
  session.connection = connection;
  session.inTransaction = true;
  session.interruptRead = async (target) => { assert.equal(target, connection); return true; };
  const result = await session.runQuery('SELECT text FROM items', 1000, 100, 30);
  assert.deepEqual(result.rows, [['small']]); assert.equal(result.truncationReason, 'byte-limit');
  assert.equal(result.stoppedEarly, true); assert.equal(paused, 1); assert.equal(resumed, 1);
  assert.equal(destroyed, 0); assert.equal(session.inTransaction, true);
});
test('close forces a stuck end to destroy its socket and closes SSH', async () => {
  const session = new DatabaseSession({}); let destroyed = 0, sshEnded = 0;
  session.connection = { end() {}, destroy() { destroyed++; } };
  session.ssh = { end() { sshEnded++; } };
  await session.close(); assert.equal(destroyed, 1); assert.equal(sshEnded, 1);
});
test('close handles a thrown end and a late callback once', async () => {
  const session = new DatabaseSession({}); let destroyed = 0, callback;
  session.connection = { end(done) { callback = done; throw new Error('broken socket'); }, destroy() { destroyed++; } };
  await session.close(); callback(); assert.equal(destroyed, 1);
});
