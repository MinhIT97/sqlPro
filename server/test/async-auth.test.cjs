'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskGate } = require('../src/async-gate.cjs');
const { hashSecret, verifySecret, verifyDummy } = require('../src/auth.cjs');
const { startServer, request, randomProof } = require('./helpers.cjs');

test('hash gate limits concurrent work, rejects a full queue and recovers after failure', async () => {
  const gate = createTaskGate({ concurrency: 1, maxQueue: 1 });
  let finish;
  const first = gate.run(() => new Promise((resolve) => { finish = resolve; }));
  const second = gate.run(() => { throw new Error('expected'); });
  const failure = assert.rejects(second, /expected/);
  await assert.rejects(gate.run(() => 3), { code: 'AUTH_BUSY' });
  await Promise.resolve(); finish(1);
  assert.equal(await first, 1); await failure;
  assert.equal(await gate.run(() => 4), 4);
});

test('async password hashing preserves format/verification and yields to the event loop', async () => {
  let ticked = false;
  const timer = new Promise((resolve) => setTimeout(() => { ticked = true; resolve(); }, 0));
  let completed = false;
  const hashes = Promise.all(Array.from({ length: 5 }, () => hashSecret('test-only'))).then((result) => { completed = true; return result; });
  await timer; assert.equal(ticked, true); assert.equal(completed, false);
  const [hash] = await hashes;
  assert.match(hash, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await verifySecret('test-only', hash), true);
  assert.equal(await verifySecret('wrong', hash), false);
  assert.equal(await verifyDummy('test-only'), false);
});

test('health stays responsive while real login requests are queued', async (t) => {
  const context = await startServer(); t.after(() => context.close());
  const proof = randomProof();
  assert.equal((await request(context.baseUrl, '/api/auth/register', { method: 'POST', body: { email: 'async@example.com', authProof: proof } })).status, 201);
  let completed = 0;
  const pending = Array.from({ length: 8 }, () => request(context.baseUrl, '/api/auth/login', { method: 'POST', body: { email: 'async@example.com', authProof: proof } }).finally(() => { completed++; }));
  const health = await fetch(context.baseUrl + '/healthz');
  assert.equal(health.status, 200);
  assert.ok(completed < 8);
  for (const response of await Promise.all(pending)) assert.equal(response.status, 200);
});
