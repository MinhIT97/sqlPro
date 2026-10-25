'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('../electron/sync-crypto.cjs');
const { normalizeVault } = require('../electron/store-schema.cjs');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const response = (data, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, text: async () => JSON.stringify(data) });
const fixture = (id) => normalizeVault({ connections: [{ id, host: 'fixture.example', updatedAt: '2026-10-25T00:00:00Z', ssl: {}, ssh: {} }] });

function setup() {
  let local = normalizeVault({}), meta = {}, base = null, handler = async () => response({});
  const files = new Map(), writes = [], calls = [], notices = [], recoveries = [];
  const key = Buffer.alloc(32, 1);
  const root = path.join(__dirname, '../electron');
  const sessionFile = path.join('/fixture', 'sync-session.json');
  const context = {
    module: { exports: {} }, Buffer, URL, AbortController, AbortSignal, process,
    setTimeout: () => 1, clearTimeout() {},
    fetch: async (url, options) => { const call = { url, ...options }; calls.push(call); return handler(call); },
    require(id) {
      if (id === 'electron') return { app: { getPath: () => '/fixture' } };
      if (id === 'node:fs') return {
        readFileSync(file) { if (!files.has(file)) throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' }); return files.get(file); },
        writeFileSync(file, value) { files.set(file, value); },
        renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
        unlinkSync(file) { files.delete(file); }, mkdirSync() {}
      };
      if (id === './store.cjs') return {
        getMeta: () => meta, setMeta: (patch) => { meta = { ...meta, ...patch }; },
        getSyncBase: () => base,
        setSyncBase: (vault, revision) => { base = vault; if (Number.isInteger(revision)) meta.revision = revision; },
        saveSyncRecovery: (vault, reason) => { recoveries.push({ vault, reason }); return { id: `recovery-${recoveries.length}` }; },
        listSyncRecovery: () => [],
        restoreSyncRecovery: () => { throw new Error('not used in fixture'); },
        snapshotForSync: () => local,
        replaceFromSync(vault) { writes.push(vault); local = vault; },
        seal: (data) => ({ data }), unseal: (sealed) => sealed.data
      };
      if (id === './sync-crypto.cjs') return { ...crypto, deriveMasterKey: () => Buffer.alloc(32, 2) };
      return require(id.startsWith('./') ? path.join(root, id) : id);
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'sync.cjs'), 'utf8'), context);
  const api = context.module.exports;
  api.init({ notify: { status: (value) => notices.push(value), applied: () => notices.push('applied') } });
  const remembered = (userId = 'old') => files.set(sessionFile, JSON.stringify({
    serverUrl: 'https://fixture.example', userId, email: `${userId}@fixture.example`, vaultSalt: 'fixture',
    tokenSealed: { data: userId }, vaultKeySealed: { data: key.toString('base64url') }, revision: 0, remember: true
  }));
  return {
    api, writes, calls, notices, key, files, sessionFile, remembered,
    get recoveries() { return recoveries; },
    get base() { return base; },
    route: (fn) => { handler = fn; }, local: (value) => { local = value; },
    start: async (id) => { remembered(id); handler = async () => response({}); await api.startup(); }
  };
}

test('late vault fetch after logout/reset cannot restore profiles or emit synced/applied', async () => {
  const r = setup(); await r.start('old');
  const delayed = deferred();
  r.route((call) => call.url.endsWith('/api/vault') ? delayed.promise : response({}));
  const pending = r.api.syncNow();
  const rejected = assert.rejects(pending, { code: 'SYNC_CANCELED' });
  const signal = r.calls.at(-1).signal;
  await r.api.logout(); r.local(normalizeVault({}));
  const notices = r.notices.length;
  assert.equal(signal.aborted, true);
  delayed.resolve(response({ revision: 1, envelope: crypto.encryptVault(fixture('old-profile'), r.key, 'old') }));
  await rejected;
  assert.equal(r.writes.length, 0);
  assert.equal(r.notices.length, notices);
  assert.equal(r.api.status().state, 'signed-out');
});

for (const outcome of ['success', 'conflict', 'auth-error', 'network-error']) {
  test(`late PUT ${outcome} cannot affect a new account or clear its in-flight job`, async () => {
    const r = setup(); await r.start('old'); r.local(fixture('local'));
    const oldPut = deferred();
    r.route((call) => call.method === 'PUT' ? oldPut.promise : response({ revision: 0 }));
    const old = r.api.syncNow();
    const rejected = assert.rejects(old, { code: 'SYNC_CANCELED' });
    await tick();
    assert.equal(r.calls.at(-1).method, 'PUT');
    await r.api.logout(); r.local(normalizeVault({}));
    await r.start('new');
    const newGet = deferred(); r.route(() => newGet.promise);
    const current = r.api.syncNow();
    const before = r.notices.length;
    if (outcome === 'network-error') oldPut.reject(new Error('late network failure'));
    else if (outcome === 'success') oldPut.resolve(response({ revision: 99 }));
    else oldPut.resolve(response({ error: { code: outcome === 'conflict' ? 'REVISION_CONFLICT' : 'INVALID_TOKEN' }, revision: 99 }, 409));
    await rejected;
    assert.equal(r.api.status().email, 'new@fixture.example');
    assert.equal(r.api.status().state, 'syncing');
    assert.equal(r.api.status().revision, 0);
    assert.equal(r.notices.length, before);
    assert.equal(r.api.syncNow(), current);
    newGet.resolve(response({ revision: 2 })); await current;
    assert.equal(r.api.status().state, 'pending');
    assert.equal(r.api.status().revision, 2);
    assert.equal(r.writes.length, 0);
    r.api.shutdown();
  });
}

test('late startup and login responses cannot resurrect a logged-out account', async () => {
  for (const kind of ['startup', 'login']) {
    const r = setup(), delayed = deferred();
    r.remembered();
    r.route((call) => {
      if (call.url.endsWith('/api/meta')) return response({ kdfVersion: crypto.KDF_VERSION, authContext: 'fixture-auth-context-1234567890' });
      if (call.url.endsWith('/api/auth/logout')) return response({});
      return delayed.promise;
    });
    const pending = kind === 'startup' ? r.api.startup() : r.api.login({ email: 'old@fixture.example', password: 'fixture password', serverUrl: 'https://fixture.example' });
    const finished = kind === 'login' ? assert.rejects(pending, { code: 'SYNC_CANCELED' }) : pending;
    await tick(); await r.api.logout();
    delayed.resolve(response({ user: { id: 'old', email: 'old@fixture.example' }, token: 'fixture', vaultSalt: 'fixture' }));
    await finished;
    assert.equal(r.api.status().loggedIn, false);
    assert.equal(r.api.status().state, 'signed-out');
    assert.equal(r.files.has(r.sessionFile), false);
  }
});

test('failed remembered-key decryption reports an error and preserves the session file', async () => {
  const r = setup();
  r.files.set(r.sessionFile, JSON.stringify({ serverUrl: 'https://fixture.example', userId: 'old', email: 'old@fixture.example', vaultSalt: 'fixture', remember: true }));
  const before = r.files.get(r.sessionFile);
  await r.api.startup();
  assert.equal(r.api.status().state, 'error');
  assert.equal(r.api.status().loggedIn, false);
  assert.equal(r.files.get(r.sessionFile), before);
});

for (const kind of ['register', 'login']) {
  test(`${kind} still persists its own session and handles a current revision conflict`, async () => {
    const r = setup(); r.local(fixture('local'));
    const salt = Buffer.alloc(16, 3).toString('base64url');
    const vaultKey = crypto.deriveVaultKey(Buffer.alloc(32, 2), salt);
    let puts = 0;
    r.route((call) => {
      if (call.url.endsWith('/api/meta')) return response({ kdfVersion: crypto.KDF_VERSION, authContext: Buffer.alloc(16, 4).toString('base64url') });
      if (call.url.includes('/api/auth/')) return response({ user: { id: 'owner', email: 'owner@fixture.example' }, token: 'fixture-token', vaultSalt: salt });
      if (call.method !== 'PUT') return response({ revision: 0 });
      const body = JSON.parse(call.body);
      if (++puts === 1) return response({ error: { code: 'REVISION_CONFLICT' }, revision: 1, envelope: crypto.encryptVault(fixture('remote'), vaultKey, 'owner') }, 409);
      assert.equal(body.baseRevision, 1);
      const vault = crypto.decryptVault(body.envelope, vaultKey, 'owner');
      assert.deepEqual(vault.connections.map((profile) => profile.id).sort(), ['local', 'remote']);
      assert.equal(call.headers.Authorization, 'Bearer fixture-token');
      return response({ revision: 2 });
    });
    await r.api[kind]({ email: 'owner@fixture.example', password: 'fixture password', serverUrl: 'https://fixture.example' });
    assert.equal(r.api.status().loggedIn, true);
    await r.api.syncNow();
    assert.equal(r.api.status().state, 'synced');
    assert.equal(r.api.status().revision, 2);
    assert.equal(puts, 2);
    assert.equal(r.writes.length, 1);
    assert.equal(JSON.parse(r.files.get(r.sessionFile)).revision, 2);
    r.api.shutdown();
  });
}

test('sync hợp nhất từng trường, dừng ở xung đột mật khẩu và chỉ đẩy sau khi người dùng chọn', async () => {
  const r = setup();
  const salt = Buffer.alloc(16, 3).toString('base64url');
  const vaultKey = crypto.deriveVaultKey(Buffer.alloc(32, 2), salt);
  const connectionVault = (overrides = {}) => normalizeVault({
    connections: [{
      id: 'c1',
      name: 'Prod',
      host: 'db.example',
      user: 'root',
      password: 'base-secret',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ssl: {},
      ssh: {},
      ...overrides
    }]
  });
  let revision = 0;
  let serverVault = normalizeVault({});
  const pushes = [];
  r.local(connectionVault());
  r.route((call) => {
    if (call.url.endsWith('/api/meta')) {
      return response({ kdfVersion: crypto.KDF_VERSION, authContext: Buffer.alloc(16, 4).toString('base64url') });
    }
    if (call.url.includes('/api/auth/')) {
      return response({ user: { id: 'owner', email: 'owner@fixture.example' }, token: 'fixture-token', vaultSalt: salt });
    }
    if (call.method === 'GET') {
      return response({
        revision,
        ...(serverVault.connections.length
          ? { envelope: crypto.encryptVault(serverVault, vaultKey, 'owner') }
          : {})
      });
    }
    if (call.method === 'PUT') {
      const body = JSON.parse(call.body);
      assert.equal(body.baseRevision, revision);
      pushes.push(crypto.decryptVault(body.envelope, vaultKey, 'owner'));
      revision += 1;
      serverVault = pushes.at(-1);
      return response({ revision });
    }
    return response({});
  });
  await r.api.login({ email: 'owner@fixture.example', password: 'fixture password', serverUrl: 'https://fixture.example' });
  await r.api.syncNow();
  assert.equal(pushes.length, 1);
  assert.equal(r.api.status().state, 'synced');
  assert.equal(pushes[0].connections[0].password, 'base-secret');
  assert.equal(r.base.connections[0].password, 'base-secret');

  serverVault = connectionVault({ name: 'Production' });
  r.local(connectionVault({ password: 'local-secret' }));
  await r.api.syncNow();
  assert.equal(pushes.length, 2);
  assert.equal(pushes[1].connections[0].name, 'Production');
  assert.equal(pushes[1].connections[0].password, 'local-secret');
  assert.equal(r.api.status().state, 'synced');

  serverVault = connectionVault({ name: 'Production', password: 'remote-secret' });
  r.local(connectionVault({ name: 'Production', password: 'local-secret-2' }));
  const conflict = await r.api.syncNow();
  assert.equal(conflict.state, 'conflict');
  assert.equal(conflict.conflictCount, 1);
  assert.equal(pushes.length, 2);
  const serialized = JSON.stringify(conflict.conflicts);
  assert.equal(serialized.includes('local-secret-2'), false);
  assert.equal(serialized.includes('remote-secret'), false);
  assert.equal(conflict.conflicts[0].fields[0].secret, true);
  assert.equal(r.recoveries.length, 2);
  assert.deepEqual(r.recoveries.map((entry) => entry.reason).sort(), ['conflict-local', 'conflict-remote']);

  const resolved = await r.api.resolveConflicts([
    { connectionId: 'c1', fields: { password: 'local' } }
  ]);
  assert.equal(resolved.state, 'synced');
  assert.equal(resolved.conflictCount, 0);
  assert.equal(resolved.conflicts.length, 0);
  assert.equal(pushes.length, 3);
  assert.equal(pushes[2].connections[0].password, 'local-secret-2');
  assert.equal(pushes[2].connections[0].name, 'Production');
  assert.equal(r.base.connections[0].password, 'local-secret-2');
  r.api.shutdown();
});
