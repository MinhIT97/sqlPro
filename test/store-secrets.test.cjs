'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { normalizeVault } = require('../electron/store-schema.cjs');

function setup() {
  const files = new Map();
  let readError = null;
  const key = path.join('/fixture', '.connections-key');
  const root = path.join(__dirname, '../electron');
  const safeStorage = { isEncryptionAvailable: () => false, decryptString() { throw new Error('locked keychain'); } };
  const context = {
    module: { exports: {} }, Buffer,
    require(id) {
      if (id === 'electron') return { app: { getPath: () => '/fixture' }, safeStorage };
      if (id === 'node:fs') return {
        readFileSync(file) {
          if (file === key && readError) { const error = readError; readError = null; throw error; }
          if (!files.has(file)) throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' });
          return files.get(file);
        },
        writeFileSync(file, value, options) {
          if (options?.flag === 'wx' && files.has(file)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
          files.set(file, value);
        },
        renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
        mkdirSync() {}
      };
      return require(id.startsWith('./') ? path.join(root, id) : id);
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'store.cjs'), 'utf8'), context);
  return { store: context.module.exports, files, key, safeStorage, failRead: (code) => { readError = Object.assign(new Error('fixture I/O'), { code }); } };
}

test('local secrets round-trip and transient key read failures never replace a valid key', () => {
  const r = setup();
  const sealed = r.store.seal('synthetic fixture');
  const original = r.files.get(r.key);
  for (const code of ['EIO', 'EACCES']) {
    r.failRead(code);
    assert.throws(() => r.store.unseal(sealed), { code: 'LOCAL_KEY_READ_FAILED', causeCode: code });
    assert.equal(r.files.get(r.key), original);
    r.failRead(code);
    assert.throws(() => r.store.seal('another fixture'), { code: 'LOCAL_KEY_READ_FAILED' });
    assert.equal(r.files.get(r.key), original);
  }
  assert.equal(r.store.unseal(sealed), 'synthetic fixture');
});

test('missing/corrupt keys stop decrypt, save and sync snapshot without changing stored ciphertext', () => {
  for (const invalid of [null, 'broken key', '22'.repeat(32)]) {
    const r = setup();
    const profile = r.store.save({ host: 'fixture.example', password: 'synthetic fixture' });
    const file = path.join('/fixture', 'connections.json');
    const before = r.files.get(file);
    if (invalid === null) r.files.delete(r.key); else r.files.set(r.key, invalid);
    const code = invalid === null ? 'LOCAL_KEY_MISSING' : invalid === 'broken key' ? 'LOCAL_KEY_INVALID' : 'SECRET_DECRYPT_FAILED';
    assert.throws(() => r.store.getWithSecrets(profile.id), { code });
    assert.throws(() => r.store.snapshotForSync(), { code });
    if (invalid !== '22'.repeat(32)) {
      assert.throws(() => r.store.save({ id: profile.id, host: 'fixture.example', password: 'replacement' }), { code });
    }
    assert.equal(r.files.get(file), before);
    assert.equal(r.files.get(r.key), invalid === null ? undefined : invalid);
  }
});

test('decrypt never initializes a missing key and OS keychain/malformed envelopes fail explicitly', () => {
  const r = setup();
  const sealed = r.store.seal('fixture');
  r.files.delete(r.key);
  assert.throws(() => r.store.unseal(sealed), { code: 'LOCAL_KEY_MISSING' });
  assert.equal(r.files.has(r.key), false);
  for (const secret of [{ alg: 'safeStorage', data: 'Zml4dHVyZQ==' }, { alg: 'unknown' }, 'corrupt', {}]) {
    assert.throws(() => r.store.unseal(secret), { code: 'SECRET_DECRYPT_FAILED' });
  }
  assert.equal(r.store.unseal(null), '');
});

test('remembered local sync secrets prevent initializing a replacement key', () => {
  const r = setup();
  r.files.set(path.join('/fixture', 'sync-session.json'), JSON.stringify({ tokenSealed: { alg: 'local', data: 'fixture' } }));
  assert.throws(() => r.store.seal('new fixture'), { code: 'LOCAL_KEY_MISSING' });
  assert.equal(r.files.has(r.key), false);
});

test('Navicat import stores encrypted secrets and returns metadata without plaintext to the UI', () => {
  const r = setup();
  const marker = 'synthetic-navicat-private-fixture';
  const result = r.store.importMany([{
    host: 'fixture.example', name: 'fixture', user: 'fixture', password: marker,
    ssl: { passphrase: marker }, ssh: { enabled: true, host: 'fixture.example', password: marker, passphrase: marker }
  }]);
  assert.equal(result.added, 1);
  assert.equal(JSON.stringify(result).includes(marker), false);
  assert.equal(result.connections[0].hasPassword, true);
  assert.equal(result.connections[0].hasSshPassword, true);
  const file = r.files.get(path.join('/fixture', 'connections.json'));
  assert.equal(file.includes(marker), false);
  assert.equal(r.store.getWithSecrets(result.connections[0].id).password, marker);
  assert.equal(r.store.getWithSecrets(result.connections[0].id).sshPassword, marker);
  assert.equal(r.store.getWithSecrets(result.connections[0].id).sshPassphrase, marker);
});

const syncVault = (id, password) => normalizeVault({
  connections: [{
    id,
    name: id,
    host: `${id}.example`,
    password,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ssl: {},
    ssh: {}
  }]
});

test('sync base và bản phục hồi được mã hóa, chống trùng và giới hạn số bản lưu', () => {
  const r = setup();
  const file = path.join('/fixture', 'connections.json');
  assert.equal(r.store.getSyncBase(), null);
  r.store.setSyncBase(syncVault('base', 'synthetic-base-secret'), 7);
  assert.equal(r.store.getSyncBase().connections[0].password, 'synthetic-base-secret');
  assert.equal(r.files.get(file).includes('synthetic-base-secret'), false);
  const baseEntry = JSON.parse(r.files.get(file)).meta;
  assert.ok(baseEntry.syncBaseSealed);
  assert.equal(baseEntry.syncBaseRevision, 7);

  const saved = r.store.saveSyncRecovery(syncVault('recovery', 'synthetic-recovery-secret'), 'conflict-local');
  assert.ok(saved.id);
  assert.equal(r.store.saveSyncRecovery(syncVault('recovery', 'synthetic-recovery-secret'), 'conflict-local'), null);
  assert.equal(r.files.get(file).includes('synthetic-recovery-secret'), false);
  const listed = r.store.listSyncRecovery();
  assert.equal(listed.length, 1);
  assert.deepEqual(Object.keys(listed[0]).sort(), ['at', 'hash', 'id', 'reason']);
  assert.equal('sealed' in listed[0], false);

  for (let index = 0; index < 10; index += 1) {
    r.store.saveSyncRecovery(syncVault(`recovery-${index}`, `synthetic-${index}-secret`), 'sync');
  }
  assert.equal(r.store.listSyncRecovery().length, 8);
  assert.equal(r.store.listSyncRecovery().some((entry) => entry.id === saved.id), false);
  assert.equal(r.files.get(file).includes('synthetic-9-secret'), false);

  r.store.replaceFromSync(normalizeVault({}));
  const restored = r.store.restoreSyncRecovery(r.store.listSyncRecovery().at(-1).id);
  assert.equal(restored.restored, true);
  assert.equal(r.store.snapshotForSync().connections[0].password, 'synthetic-9-secret');
});
