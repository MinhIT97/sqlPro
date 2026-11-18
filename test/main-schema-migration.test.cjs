'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSession } = require('../electron/database.cjs');

// Execute main.cjs itself, with the real registry/collector/service and a fake SQL driver.
function fixture() {
  const handlers = new Map(), profiles = {}, queries = [], sessions = [];
  const root = path.join(__dirname, '../electron');
  const controls = { onRaw: null };
  class Session extends DatabaseSession {
    constructor(profile) { super(profile); this.version = '8.4.0'; sessions.push(this); }
    async connect() { this.connection = {}; }
    async close() { this.connection = null; this.dead = true; }
    async raw(sql, params, timeoutMs) {
      queries.push({ sql, params, timeoutMs, profileId: this.profile.id });
      if (controls.onRaw) await controls.onRaw(sql, this);
      if (sql.includes("COLUMN_NAME IN ('EXPRESSION'")) return { result: [] };
      if (sql.includes('information_schema.TABLES')) return { result: [{ name: 'users', type: 'BASE TABLE', engine: 'InnoDB' }] };
      if (sql.includes('information_schema.COLUMNS')) return { result: [{ name: 'id', type: 'int', nullable: 'NO', position: 1 }] };
      return { result: [] };
    }
  }
  const context = vm.createContext({
    require(id) {
      if (id === 'electron') return {
        app: { requestSingleInstanceLock: () => true, on() {}, whenReady: () => new Promise(() => {}), getPath: () => '/tmp/sqlpro-main-schema-tests' },
        ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
        dialog: { showMessageBox() { throw Error('Unexpected production approval'); } }
      };
      if (id === './database.cjs') return { ...require(path.join(root, id)), DatabaseSession: Session };
      if (id === './store.cjs') return { getWithSecrets: id => ({ id, host: 'fixture', port: 3306, user: 'fixture', ssh: {}, ...profiles[id] }) };
      if (id === './sync.cjs' || id === './navicat.cjs') return {};
      return require(id.startsWith('./') ? path.join(root, id) : id);
    }, __dirname: root, process, Buffer, console, setTimeout, clearTimeout, AbortController
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'main.cjs'), 'utf8'), context, { filename: 'main.cjs' });
  return { profiles, queries, sessions, controls,
    evaluate: code => vm.runInContext(code, context),
    call: (channel, payload) => handlers.get(channel)({ sender: null }, payload)
  };
}

test('snapshot IPC uses trusted registry context, blocks overlap, ignores renderer quotas and releases its lease', async () => {
  const r = fixture();
  r.profiles.p = { readOnly: true };
  let unblock, entered;
  const started = new Promise(resolve => { entered = resolve; });
  r.controls.onRaw = async sql => {
    if (!unblock && sql.includes('information_schema.TABLES')) {
      entered();
      await new Promise(resolve => { unblock = resolve; });
    }
  };
  const pending = r.call('db:schema-snapshot', { profileId: 'p', database: 'sample',
    options: { quotas: { maxObjects: 0, timeoutMs: Infinity } } });
  await started;
  assert.equal((await r.call('db:columns', { profileId: 'p', database: 'sample', table: 'users' })).error.code, 'SESSION_BUSY');
  assert.equal((await r.call('db:schema-snapshot', { profileId: 'p', database: 'sample' })).error.code, 'SESSION_BUSY');
  unblock();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.data.coverage, 'complete');
  assert.equal(result.data.tables.length, 1, 'Renderer maxObjects:0 must not override Main limits');
  assert.match(result.data.snapshotId, /^snapshot_/);
  assert.ok(result.data.scope.sessionId);
  assert.equal(result.data.scope.generation, 0);
  assert.match(result.data.scope.profileFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(r.evaluate('sessionRegistry.leases.size'), 0);
  assert.equal(r.evaluate("openSessions.get('p').exclusiveOperation"), false);
  assert.ok(r.queries.every(query => query.sql.startsWith('SELECT')));
});

test('snapshot IPC rejects profile or logout drift during collection and always releases the lease', async () => {
  for (const variant of ['profile', 'logout', 'session', 'policy']) {
    const r = fixture();
    let changed = false;
    r.controls.onRaw = () => {
      if (changed) return;
      changed = true;
      if (variant === 'profile') r.profiles.p = { host: 'changed-host' };
      if (variant === 'policy') r.profiles.p = { readOnly: true };
      if (variant === 'logout') r.evaluate('stopBackupSchedules()');
      if (variant === 'session') r.evaluate("openSessions.get('p').sessionId = 'replaced'");
    };
    const result = await r.call('db:schema-snapshot', { profileId: 'p', database: 'sample' });
    assert.equal(result.ok, false, variant);
    assert.ok(['SESSION_CONTEXT_CHANGED', 'PROFILE_TARGET_CHANGED'].includes(result.error.code), variant);
    assert.equal(r.evaluate('sessionRegistry.leases.size'), 0);
    assert.equal(r.evaluate('schemaMigrationService.snapshots.size'), 0);
  }
});

test('plan IPC preserves equal hashes on different servers and rejects stale cached capture scope', async () => {
  const r = fixture();
  const a = await r.call('db:schema-snapshot', { profileId: 'a', database: 'sample' });
  const b = await r.call('db:schema-snapshot', { profileId: 'b', database: 'sample' });
  assert.equal(a.data.snapshotIdentity, b.data.snapshotIdentity);
  assert.notEqual(a.data.snapshotId, b.data.snapshotId);
  const payload = { sourceSnapshotId: a.data.snapshotId, targetSnapshotId: b.data.snapshotId };
  const plan = await r.call('db:create-migration-plan', payload);
  assert.equal(plan.ok, true);
  assert.equal(plan.data.sourceScope.profileId, 'a');
  assert.equal(plan.data.targetScope.profileId, 'b');
  assert.equal(plan.data.applySupported, false);
  r.profiles.a = { environment: 'production' };
  assert.equal((await r.call('db:create-migration-plan', payload)).error.code, 'SESSION_CONTEXT_CHANGED');
});

test('Apply IPC cannot bypass policy with confirmed, token or environment flags, and opens no sessions', async () => {
  const r = fixture();
  for (const payload of [undefined, { confirmed: true }, { planToken: 'forged', confirmed: true, readOnly: false, environment: 'local' }]) {
    const result = await r.call('db:apply-migration-plan', payload);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'MIGRATION_APPLY_NOT_READY');
  }
  assert.equal(r.sessions.length, 0);
  assert.equal(r.queries.length, 0);
});

test('snapshot IPC validates database, protects Editor transactions and invalidates caches on reset', async () => {
  const r = fixture();
  for (const database of ['', ' ', 'x'.repeat(65), 'bad\0db']) {
    assert.equal((await r.call('db:schema-snapshot', { profileId: 'p', database })).ok, false);
  }
  assert.equal(r.sessions.length, 0);
  await r.evaluate("ensureSession('p')");
  r.sessions[0].inTransaction = true;
  assert.equal((await r.call('db:schema-snapshot', { profileId: 'p', database: 'sample' })).error.code, 'SESSION_BUSY');
  r.sessions[0].inTransaction = false;
  const response = await r.call('db:schema-snapshot', { profileId: 'p', database: 'sample' });
  assert.equal(response.ok, true);
  r.evaluate('stopBackupSchedules()');
  assert.equal(r.evaluate('schemaMigrationService.snapshots.size'), 0);
});
