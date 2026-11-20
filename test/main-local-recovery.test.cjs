'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { normalizeVault } = require('../electron/store-schema.cjs');

test('Main recovery IPC owns file selection, cryptography and additive commit; native Cancel is default', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-main-kit-'));
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-main-kit-export-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(external, { recursive: true, force: true }); });
  const directory = path.join(__dirname, '../electron'), handlers = new Map();
  let savePath = null, openPath = null, confirmation = 0, dialogOptions, writes = 0, loggedIn = false;
  let vault = normalizeVault({ connections: [{ id: 'retained', workspaceId: 'ws-personal', name: 'Source', password: 'secret-private-marker' }] });
  const original = structuredClone(vault), snapshots = [];
  const store = { snapshotForSync: () => structuredClone(vault), saveSyncRecovery: value => snapshots.push(value),
    replaceFromSync: value => { writes++; vault = structuredClone(value); } };
  const dialog = {
    showSaveDialog: async () => ({ canceled: !savePath, filePath: savePath }),
    showOpenDialog: async () => ({ canceled: !openPath, filePaths: openPath ? [openPath] : [] }),
    showMessageBox: async (window, options) => { dialogOptions = options; return { response: confirmation }; }
  };
  vm.runInNewContext(fs.readFileSync(path.join(directory, 'main.cjs'), 'utf8'), {
    require(id) {
      if (id === 'electron') return { app: { requestSingleInstanceLock: () => true, on() {}, whenReady: () => new Promise(() => {}), getPath: () => root },
        ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, dialog };
      if (id === './store.cjs') return store;
      if (id === './sync.cjs') return { status: () => ({ loggedIn, email: 'fixture@example.com' }) };
      if (id === './navicat.cjs') return {};
      if (id === './database.cjs') return { DatabaseSession: class { constructor() { assert.fail('recovery must not open a DB session'); } } };
      return require(id.startsWith('./') ? path.join(directory, id) : id);
    }, __dirname: directory, process, Buffer, console, setTimeout, clearTimeout, AbortController
  });
  const call = (name, payload) => handlers.get(name)({ sender: null }, payload);
  assert.equal((await call('account:export-local-kit')).data.canceled, true);
  savePath = path.join(root, 'protected.sqlpro-recovery');
  assert.equal((await call('account:export-local-kit')).error.code, 'PROTECTED_EXPORT_PATH');
  savePath = path.join(external, 'kit.sqlpro-recovery');
  const exported = await call('account:export-local-kit', { vault: { connections: [] } });
  assert.equal(exported.ok, true, JSON.stringify(exported.error));
  const key = exported.data.recoveryKey;
  assert.equal(fs.readFileSync(savePath, 'utf8').includes('secret-private-marker'), false);
  assert.equal(fs.readFileSync(savePath, 'utf8').includes(key), false);
  openPath = savePath;
  const wrong = await call('account:prepare-local-kit', { recoveryKey: '0'.repeat(64) });
  assert.equal(wrong.error.code, 'RECOVERY_UNLOCK_FAILED'); assert.equal(writes, 0);
  let preview = await call('account:prepare-local-kit', { recoveryKey: key });
  assert.equal(preview.data.connections, 1);
  assert.equal(JSON.stringify(preview).includes('secret-private-marker'), false);
  assert.equal((await call('account:apply-local-kit', { token: preview.data.token })).data.canceled, true);
  assert.equal(dialogOptions.defaultId, 0); assert.equal(dialogOptions.cancelId, 0); assert.equal(writes, 0);
  preview = await call('account:prepare-local-kit', { recoveryKey: key }); confirmation = 1;
  assert.equal((await call('account:apply-local-kit', { token: preview.data.token, vault: {} })).data.imported, true);
  assert.equal(writes, 1); assert.equal(vault.connections.length, 2);
  assert.deepEqual(vault.connections[0], original.connections[0]);
  assert.deepEqual(snapshots[0], original);
  loggedIn = true;
  assert.equal((await call('account:prepare-local-kit', { recoveryKey: key })).ok, false);
  assert.equal(writes, 1);
});
