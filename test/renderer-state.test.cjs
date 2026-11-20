'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRendererState, serializeState } = require('../electron/renderer-state.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-state-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(__dirname, '../electron');
  const context = {
    module: { exports: {} }, Buffer,
    require(id) {
      if (id === 'electron') return { app: { getPath: () => directory }, safeStorage: { isEncryptionAvailable: () => false } };
      return require(id.startsWith('./') ? path.join(root, id) : id);
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'store.cjs'), 'utf8'), context);
  const store = context.module.exports;
  return { directory, store, file: path.join(directory, 'renderer-state.json'),
    create: (io = fs) => createRendererState({ directory, seal: store.seal, unseal: store.unseal, io }) };
}

const state = () => ({
  savedQuery: "CREATE USER 'fixture' IDENTIFIED BY 'Secret-state-marker';",
  queryTabs: [{ title: 'Draft', sql: 'SELECT 123', profileId: 'profile-a', database: 'db-a' }],
  savedQueries: [{ id: 'saved', sql: "SET PASSWORD = 'Secret-state-marker';" }],
  snippets: [{ sql: 'SELECT api_token FROM users' }], history: [{ sql: "SELECT 'Secret-state-marker'" }]
});

test('renderer state encrypts all SQL at rest without changing drafts or their targets', t => {
  const r = fixture(t); const repository = r.create();
  assert.deepEqual(repository.read(), {});
  repository.save(state());
  const disk = fs.readFileSync(r.file, 'utf8');
  assert.equal(disk.includes('Secret-state-marker'), false);
  assert.equal(disk.includes('SELECT'), false);
  assert.equal(disk.includes('profile-a'), false);
  assert.equal(JSON.parse(disk).sealed.alg, 'local');
  assert.deepEqual(repository.read(), state());
  assert.deepEqual(r.create().read(), state(), 'readable after repository restart');
  if (process.platform !== 'win32') assert.equal(fs.statSync(r.file).mode & 0o777, 0o600);
});

test('legacy plaintext is readable and migrates atomically on next save', t => {
  const r = fixture(t); fs.writeFileSync(r.file, JSON.stringify(state()));
  assert.deepEqual(r.create().read(), state());
  r.create().save(state());
  assert.equal(fs.readFileSync(r.file, 'utf8').includes('Secret-state-marker'), false);
  assert.deepEqual(r.create().read(), state());
});

test('corruption, unsupported version and failed decryption preserve the old file and reject subsequent writes', t => {
  const r = fixture(t); const repository = r.create();
  repository.save(state()); const valid = JSON.parse(fs.readFileSync(r.file, 'utf8'));
  for (const text of ['{broken', JSON.stringify({ ...valid, version: 2 }), JSON.stringify({ ...valid, sealed: { ...valid.sealed, tag: Buffer.alloc(16).toString('base64') } })]) {
    fs.writeFileSync(r.file, text);
    assert.throws(() => repository.read());
    assert.throws(() => repository.save({ queryTabs: [] }));
    assert.equal(fs.readFileSync(r.file, 'utf8'), text);
  }
});

test('missing local key with only encrypted state cannot create a replacement key', t => {
  const r = fixture(t); r.create().save(state());
  const before = fs.readFileSync(r.file, 'utf8');
  const key = path.join(r.directory, '.connections-key'); fs.unlinkSync(key);
  assert.throws(() => r.create().read(), { code: 'LOCAL_KEY_MISSING' });
  assert.throws(() => r.create().save({}), { code: 'LOCAL_KEY_MISSING' });
  assert.throws(() => r.store.seal('new profile password'), { code: 'LOCAL_KEY_MISSING' });
  assert.equal(fs.existsSync(key), false);
  assert.equal(fs.readFileSync(r.file, 'utf8'), before);
});

test('write/fsync/rename failures retain old ciphertext and clean only the owned staging file', t => {
  const r = fixture(t); r.create().save(state()); const before = fs.readFileSync(r.file, 'utf8');
  for (const method of ['writeFileSync', 'fsyncSync', 'renameSync']) {
    const io = { ...fs, [method]() { throw Object.assign(new Error('fixture failure'), { code: 'ENOSPC' }); } };
    assert.throws(() => r.create(io).save({ savedQuery: 'new draft' }), { code: 'ENOSPC' });
    assert.equal(fs.readFileSync(r.file, 'utf8'), before);
    assert.equal(fs.readdirSync(r.directory).some(name => name.endsWith('.part')), false);
    assert.deepEqual(r.create().read(), state());
  }
});

test('state quota validates bytes, rejects arrays and cycles without touching existing data', t => {
  const r = fixture(t); r.create().save(state()); const before = fs.readFileSync(r.file, 'utf8');
  const cyclic = {}; cyclic.self = cyclic;
  for (const value of [[], null, cyclic, { savedQuery: 'ữ'.repeat(800000) }]) assert.throws(() => r.create().save(value));
  assert.equal(fs.readFileSync(r.file, 'utf8'), before);
  assert.equal(serializeState({ savedQuery: 'SELECT 1' }), '{"savedQuery":"SELECT 1"}');
});

test('production Main state IPC uses encryption for saves and returns errors without overwriting corrupt state', async t => {
  const r = fixture(t); const root = path.join(__dirname, '../electron'); const handlers = new Map();
  const context = {
    require(id) {
      if (id === 'electron') return {
        app: { requestSingleInstanceLock: () => true, on() {}, whenReady: () => new Promise(() => {}), getPath: () => r.directory },
        ipcMain: { handle(name, fn) { handlers.set(name, fn); } }
      };
      if (id === './store.cjs') return r.store;
      if (['./sync.cjs', './navicat.cjs'].includes(id)) return {};
      return require(id.startsWith('./') ? path.join(root, id) : id);
    }, __dirname: root, process, Buffer, console, setTimeout, clearTimeout, AbortController
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'main.cjs'), 'utf8'), context);
  const call = (name, value) => handlers.get(name)({ sender: null }, value);
  assert.equal((await call('state:save', state())).ok, true);
  assert.equal(fs.readFileSync(r.file, 'utf8').includes('Secret-state-marker'), false);
  assert.deepEqual((await call('state:load')).data, state());
  fs.writeFileSync(r.file, '{broken');
  assert.equal((await call('state:load')).error.code, 'STATE_READ_FAILED');
  assert.equal((await call('state:save', {})).error.code, 'STATE_READ_FAILED');
  assert.equal(fs.readFileSync(r.file, 'utf8'), '{broken');
});
