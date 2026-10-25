'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { DatabaseSession } = require('../electron/database.cjs');
const { ResultBudget } = require('../electron/result-budget.cjs');

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
