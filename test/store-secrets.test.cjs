'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
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
        readdirSync(directory) { return [...files.keys()].filter(file => path.dirname(file) === directory).map(file => path.basename(file)); },
        lstatSync(file) { return { isFile: () => true, size: Buffer.byteLength(files.get(file)) }; },
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

test('environment is preserved through save, legacy normalization and encrypted vault round trip', () => {
  const r = setup();
  const legacy = r.store.save({ host: 'fixture.example', password: 'synthetic' });
  assert.equal(legacy.environment, 'unclassified');
  for (const environment of ['local', 'staging', 'production', 'unclassified']) {
    const profile = r.store.save({ id: legacy.id, host: 'fixture.example', environment });
    assert.equal(profile.environment, environment);
    const updated = r.store.save({ id: legacy.id, host: 'fixture.example', name: 'renamed' });
    assert.equal(updated.environment, environment);
    const snapshot = r.store.snapshotForSync();
    assert.equal(snapshot.connections[0].environment, environment);
    r.store.replaceFromSync(snapshot);
    assert.equal(r.store.list()[0].environment, environment);
  }
  assert.equal(normalizeVault({ connections: [{ id: 'old', host: 'production.example' }] }).connections[0].environment, 'unclassified');
  assert.equal(normalizeVault({ connections: [{ id: 'bad', environment: '<script>' }] }).connections[0].environment, 'unclassified');
});

test('an encrypted trial journal prevents replacing a missing local key', () => {
  const r = setup();
  const sealed = r.store.seal('trial ownership fixture');
  r.files.set(path.join('/fixture/restore-trial-journal', `${'a'.repeat(32)}.json`), JSON.stringify(sealed));
  r.files.delete(r.key);
  assert.throws(() => r.store.seal('new secret'), { code: 'LOCAL_KEY_MISSING' });
  assert.equal(r.files.has(r.key), false);
});

test('read-only policy survives editing and sync; old profiles remain writable', () => {
  const r = setup();
  const profile = r.store.save({host:'fixture.example',password:'fixture',readOnly:true});
  assert.equal(profile.readOnly,true);
  assert.equal(r.store.save({id:profile.id,host:'fixture.example',name:'renamed'}).readOnly,true);
  const snapshot = r.store.snapshotForSync();
  assert.equal(snapshot.connections[0].readOnly,true);
  r.store.replaceFromSync(snapshot);
  assert.equal(r.store.list()[0].readOnly,true);
  assert.throws(() => r.store.save({id:profile.id,host:'fixture.example',readOnly:'false'}),/chỉ đọc/);
  assert.equal(r.store.save({id:profile.id,host:'fixture.example',readOnly:false}).readOnly,false);
  assert.equal(normalizeVault({connections:[{id:'legacy',host:'fixture'}]}).connections[0].readOnly,false);
  assert.equal(normalizeVault({connections:[{id:'bad',readOnly:'false'}]}).connections[0].readOnly,true);
});

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

test('Navicat import checks all existing target IDs before writing any profile or secret', () => {
  const r = setup();
  const inputs = ['first', 'second'].map(name => ({ name, host: 'fixture.example', importKey: name, password: 'original' }));
  const initial = r.store.importMany(inputs);
  const file = path.join('/fixture', 'connections.json');
  const before = r.files.get(file);
  let targets;
  assert.throws(() => r.store.importMany(inputs.map(input => ({ ...input, password: 'replacement' })), undefined, {
    beforeWrite(ids) { targets = [...ids]; throw Object.assign(new Error('transaction'), { code: 'PROFILE_TRANSACTION_OPEN' }); }
  }), { code: 'PROFILE_TRANSACTION_OPEN' });
  assert.deepEqual(targets, initial.connections.map(profile => profile.id));
  assert.equal(r.files.get(file), before);
  for (const profile of initial.connections) assert.equal(r.store.getWithSecrets(profile.id).password, 'original');
});

test('Navicat JSON/XML imports clear explicit empty secrets and preserve missing or undecodable secrets', () => {
  const encrypted = value => {
    const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from('libcckeylibcckey'), Buffer.from('libcciv libcciv '));
    return Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]).toString('hex');
  };
  const parse = (format, secret) => {
    const attrs = { ConnectionName: 'fixture', Host: 'fixture.example', SSL: 'true', SSH: 'true', SSH_Host: 'ssh.example',
      Password: secret, SSL_PEMClientKeyPassword: secret, SSH_Password: secret, SSH_Passphrase: secret };
    const text = format === 'json' ? JSON.stringify({ Connections: [{ Name: 'fixture', Hostname: 'fixture.example',
      UseSSL: true, UseSSH: true, Password: secret, SSL: { ClientKeyPassword: secret },
      SSH: { Host: 'ssh.example', Password: secret, Passphrase: secret } }] })
      : `<Connections><Connection ${Object.entries(attrs).filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}="${value}"`).join(' ')} /></Connections>`;
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/navicat.cjs'), 'utf8'), {
      module, Buffer, require: id => id === 'node:fs' ? { readFileSync: () => text } : require(id)
    });
    return module.exports.parseNavicatFile('fixture');
  };
  for (const format of ['json', 'xml']) {
    for (const [input, expected] of [[encrypted(''), ''], ['', ''], [undefined, 'original'],
      ['invalid-ciphertext', 'original'], [encrypted('replacement'), 'replacement']]) {
      const r = setup();
      const first = r.store.importMany(parse(format, encrypted('original')).connections).connections[0];
      const parsed = parse(format, input), result = r.store.importMany(parsed.connections);
      assert.equal(result.updated, 1, format);
      const profile = r.store.getWithSecrets(first.id);
      assert.equal(profile.password, expected, format);
      assert.equal(profile.sshPassword, expected, format);
      assert.equal(profile.sshPassphrase, expected, format);
      assert.equal(profile.ssl.passphrase, expected, format);
      if (input === undefined || input === 'invalid-ciphertext') {
        assert.equal(parsed.connections[0].password, undefined);
        assert.equal(parsed.connections[0].ssh.password, undefined);
        assert.equal(parsed.connections[0].ssl.passphrase, undefined);
      }
      assert.equal(JSON.stringify(result).includes('replacement'), false);
    }
  }
});

test('cleartext authentication opt-in survives Navicat reimport but never survives an insecure transport change', () => {
  const r = setup(), input = { name: 'fixture', host: 'fixture.example', importKey: 'fixture', ssl: { enabled: true, verify: true } };
  const id = r.store.importMany([input]).connections[0].id;
  assert.equal(r.store.getWithSecrets(id).allowCleartextPassword, false);
  r.store.save({ ...input, id, allowCleartextPassword: true });
  r.store.importMany([input]); assert.equal(r.store.getWithSecrets(id).allowCleartextPassword, true);
  const before = r.files.get(path.join('/fixture', 'connections.json'));
  for (const ssl of [{ enabled: false }, { enabled: true, verify: false }]) {
    assert.throws(() => r.store.importMany([{ ...input, ssl }]), { code: 'CLEARTEXT_AUTH_INSECURE_TRANSPORT' });
    assert.equal(r.files.get(path.join('/fixture', 'connections.json')), before);
  }
  assert.throws(() => r.store.save({ ...input, id, allowCleartextPassword: 'true' }), /mysql_clear_password/);
  r.store.save({ ...input, id, allowCleartextPassword: false });
  r.store.importMany([input]); assert.equal(r.store.getWithSecrets(id).allowCleartextPassword, false);
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
