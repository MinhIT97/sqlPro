'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { normalizeVault } = require('../electron/store-schema.cjs');
const { createLocalRecovery, openLocalRecovery, writeLocalRecovery, readLocalRecovery, createLocalRecoveryManager } = require('../electron/local-recovery.cjs');

const vault = () => normalizeVault({ connections: [{ id: 'old-id', workspaceId: 'ws-personal', name: 'Exact name',
  password: 'private-password-marker', host: 'host-secret', readOnly: true, ssh: { password: 'ssh-secret', privateKeyPath: '/old/key' } }] });

function harness(confirm = async () => true) {
  let current = vault(), generation = 0, loggedIn = false, busy = false, writes = 0;
  const snapshots = [];
  const store = { snapshotForSync: () => structuredClone(current), saveSyncRecovery: value => snapshots.push(value),
    replaceFromSync: value => { writes++; current = structuredClone(value); } };
  const manager = createLocalRecoveryManager({ store, getGeneration: () => generation, isLoggedIn: () => loggedIn,
    isBusy: () => busy, confirm });
  return { manager, snapshots, get current() { return current; }, get writes() { return writes; },
    change: () => { current.connections[0].name = 'changed'; }, invalidate: () => generation++, login: () => { loggedIn = true; }, setBusy: () => { busy = true; } };
}

test('local kit preserves credentials with a separate recovery key; wrong key, scope and versions fail closed', () => {
  const original = vault(), kit = createLocalRecovery(original, 'owner@example.com');
  const serialized = JSON.stringify(kit.bundle);
  assert.equal(serialized.includes('private-password-marker'), false);
  assert.equal(serialized.includes('host-secret'), false);
  assert.equal(serialized.includes(kit.recoveryKey), false);
  assert.deepEqual(openLocalRecovery(kit.bundle, kit.recoveryKey), original);
  assert.throws(() => openLocalRecovery(kit.bundle, '0'.repeat(64)), { code: 'RECOVERY_UNLOCK_FAILED' });
  assert.throws(() => openLocalRecovery({ ...kit.bundle, email: 'changed@example.com' }, kit.recoveryKey), { code: 'RECOVERY_UNLOCK_FAILED' });
  assert.throws(() => openLocalRecovery({ ...kit.bundle, version: 99 }, kit.recoveryKey), { code: 'RECOVERY_BUNDLE_INVALID' });
  assert.throws(() => openLocalRecovery({ ...kit.bundle, kitData: { ...kit.bundle.kitData, saltHex: 'x' } }, kit.recoveryKey), { code: 'RECOVERY_UNLOCK_FAILED' });
});

test('kit publication is exclusive, file permissions are private and corrupted files are retained', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-local-kit-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'recovery.sqlpro-recovery'), kit = createLocalRecovery(vault());
  await writeLocalRecovery(file, kit.bundle);
  assert.deepEqual(openLocalRecovery(await readLocalRecovery(file), kit.recoveryKey), vault());
  await assert.rejects(writeLocalRecovery(file, createLocalRecovery(vault()).bundle), { code: 'EEXIST' });
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const failed = path.join(directory, 'failed.sqlpro-recovery');
  await assert.rejects(writeLocalRecovery(failed, kit.bundle, () => { throw new Error('context drift'); }));
  assert.equal((await fs.readdir(directory)).length, 1);
  await fs.writeFile(file, '{broken');
  await assert.rejects(readLocalRecovery(file), { code: 'RECOVERY_BUNDLE_INVALID' });
  assert.equal(await fs.readFile(file, 'utf8'), '{broken');
});

test('recovery adds new identities, preserves current profiles and ignores recovered tombstones', async () => {
  const h = harness(), original = structuredClone(h.current), source = vault();
  source.tombstones = [{ id: 'old-id', type: 'connection', deletedAt: '2026-11-20T00:00:00.000Z' }];
  const kit = createLocalRecovery(source), preview = h.manager.prepare(kit.bundle, kit.recoveryKey);
  assert.equal(JSON.stringify(preview).includes('private-password-marker'), false);
  assert.equal(preview.connections, 1);
  assert.equal((await h.manager.apply(preview.token)).imported, true);
  assert.equal(h.writes, 1);
  assert.deepEqual(h.current.connections[0], original.connections[0]);
  assert.equal(h.current.connections.length, 2);
  assert.notEqual(h.current.connections[1].id, original.connections[0].id);
  assert.notEqual(h.current.connections[1].workspaceId, original.connections[0].workspaceId);
  assert.equal(h.current.connections[1].password, original.connections[0].password);
  assert.deepEqual(h.current.tombstones, original.tombstones);
  assert.deepEqual(h.snapshots[0], original);
  await assert.rejects(h.manager.apply(preview.token), { code: 'RECOVERY_PLAN_INVALID' });
});

test('Cancel, drift, logout generation, sign-in and database tasks revoke pending approval without mutation', async () => {
  const kit = createLocalRecovery(vault());
  const cancel = harness(async () => false), preview = cancel.manager.prepare(kit.bundle, kit.recoveryKey);
  assert.equal((await cancel.manager.apply(preview.token)).canceled, true);
  assert.equal(cancel.writes, 0);
  for (const mutate of ['change', 'invalidate', 'login', 'setBusy']) {
    let h;
    h = harness(async () => { h[mutate](); return true; });
    const plan = h.manager.prepare(kit.bundle, kit.recoveryKey);
    await assert.rejects(h.manager.apply(plan.token));
    assert.equal(h.writes, 0);
  }
  let resolve;
  const h = harness(() => new Promise(done => { resolve = done; }));
  const plan = h.manager.prepare(kit.bundle, kit.recoveryKey), pending = h.manager.apply(plan.token);
  h.manager.revoke(plan.token); resolve(true);
  await assert.rejects(pending, { code: 'RECOVERY_CONTEXT_CHANGED' });
  assert.equal(h.writes, 0);
});

test('failed safety snapshot prevents import and malformed vaults cannot be silently normalized', async () => {
  const source = vault(); source.connections.push({ ...source.connections[0] });
  assert.throws(() => createLocalRecovery(source), { code: 'RECOVERY_VAULT_INVALID' });
  const store = { snapshotForSync: vault, saveSyncRecovery() { throw new Error('fixture disk full'); },
    replaceFromSync() { assert.fail('must not write after failed safety snapshot'); } };
  const manager = createLocalRecoveryManager({ store, isLoggedIn: () => false, getGeneration: () => 0, confirm: async () => true });
  const kit = createLocalRecovery(vault()), plan = manager.prepare(kit.bundle, kit.recoveryKey);
  await assert.rejects(manager.apply(plan.token), /fixture disk full/);
});
