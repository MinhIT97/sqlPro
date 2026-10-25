'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionRegistry } = require('../electron/session-registry.cjs');

function setup(limit = 2) {
  const created = [];
  const registry = new SessionRegistry({ limit, create: async (id) => {
    const session = { connection: {}, closed: 0, async close() { this.closed += 1; this.dead = true; } };
    const entry = { profileId: id, session }; created.push(entry); return entry;
  } });
  return { registry, created };
}
test('concurrent opens share one connection and busy/leased entries survive eviction', async () => {
  const { registry, created } = setup();
  const [a, duplicate] = await Promise.all([registry.open('a'), registry.open('a')]);
  assert.equal(a, duplicate); assert.equal(created.length, 1);
  const release = registry.acquire(a);
  const b = await registry.open('b');
  await registry.open('c');
  assert.equal(a.session.closed, 0); assert.equal(b.session.closed, 1);
  release();
  a.session.inTransaction = true;
  const c = registry.entries.get('c'); c.session.activeTask = {};
  await assert.rejects(registry.open('d'), { code: 'SESSION_BUSY' });
  assert.equal(a.session.closed, 0); assert.equal(c.session.closed, 0);
  assert.equal(created.at(-1).session.closed, 1);
});
test('disconnect invalidates a pending open and a later open cannot be resurrected by it', async () => {
  let resolve;
  const old = { profileId: 'a', session: { close: async () => { old.closed = true; } } };
  let count = 0;
  const registry = new SessionRegistry({ create: async () => ++count === 1 ? new Promise((r) => { resolve = r; }) : { profileId: 'a', session: { connection: {}, close: async () => {} } } });
  const stale = registry.open('a');
  await registry.close('a');
  const current = await registry.open('a');
  resolve(old);
  await assert.rejects(stale, { code: 'SESSION_OPEN_CANCELED' });
  assert.equal(old.closed, true); assert.equal(registry.entries.get('a'), current);
});
test('concurrent different opens obey capacity and failed creation can be retried', async () => {
  const { registry } = setup(2);
  await Promise.all(Array.from({ length: 6 }, (_, i) => registry.open(String(i))));
  assert.equal(registry.entries.size, 2);
  await registry.closeAll(); assert.equal(registry.entries.size, 0);
  let fail = true;
  registry.create = async (id) => { if (fail) throw new Error('offline'); return { profileId: id, session: { connection: {}, close: async () => {} } }; };
  await assert.rejects(registry.open('x'), /offline/);
  fail = false;
  assert.equal((await registry.open('x')).profileId, 'x');
});

test('conditional cleanup cannot close a replacement and disconnect during retry disposal wins', async () => {
  const { registry } = setup();
  const old = await registry.open('a');
  await registry.close('a');
  const fresh = await registry.open('a');
  assert.equal(await registry.close('a', old), false);
  await assert.rejects(registry.reopen(old), { code: 'SESSION_OPEN_CANCELED' });
  assert.equal(registry.entries.get('a'), fresh);
  let finish;
  fresh.session.close = () => new Promise((resolve) => { finish = resolve; });
  const retry = registry.reopen(fresh);
  await registry.close('a');
  finish();
  await assert.rejects(retry, { code: 'SESSION_OPEN_CANCELED' });
  assert.equal(registry.entries.size, 0);
});
