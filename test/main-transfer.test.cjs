'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

function setup({ sync = {}, reset = () => ({ backupName: 'fixture-backup.json' }) } = {}) {
  const handlers = new Map(), sessions = [];
  let chooseFile = async () => ({ filePath: '/review/export.json' });
  let chooseOpen = async () => ({ canceled: true, filePaths: [] });
  let finish;
  class Session {
    constructor(profile) { this.profile = profile; this.canceled = []; sessions.push(this); }
    async connect() { this.connection = {}; }
    async close() { this.dead = true; }
    async listDatabases() { return ['demo']; }
    async useDatabase() {}
    backupDatabase(options) { return this.run(options.taskId, 'BACKUP_CANCELED'); }
    exportQueryFile(options) { return this.run(options.taskId, 'EXPORT_CANCELED'); }
    prepareWorkerForImport() { this.prepared = 'import'; }
    prepareWorkerForRestore() { this.prepared = 'restore'; }
    importFile(options) { return this.run(options.taskId, 'IMPORT_CANCELED'); }
    restoreDatabase(options) { return this.run(options.taskId, 'RESTORE_CANCELED'); }
    run(taskId, code) {
      this.activeTask = { id: taskId };
      return new Promise((resolve, reject) => { finish = resolve; this.reject = () => reject(Object.assign(new Error('Canceled'), { code })); });
    }
    cancelTask(taskId) {
      if (this.activeTask?.id !== taskId) return false;
      this.canceled.push(taskId); this.reject(); return true;
    }
  }
  const app = { requestSingleInstanceLock: () => true, on() {}, whenReady: () => new Promise(() => {}), getPath: () => '/review' };
  const electron = {
    app,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    dialog: { showSaveDialog: (...args) => chooseFile(...args), showOpenDialog: (...args) => chooseOpen(...args) }
  };
  const root = path.join(__dirname, '../electron');
  vm.runInNewContext(fs.readFileSync(path.join(root, 'main.cjs'), 'utf8'), {
    require(id) {
      if (id === 'electron') return electron;
      if (id === './database.cjs') return {
        DatabaseSession: Session,
        normalizeFileFormat: (format) => (['csv', 'tsv', 'json'].includes(format) ? format : 'csv')
      };
      if (id === './store.cjs') return { getWithSecrets: (id) => ({ id, ssh: {} }), resetLocalData: reset };
      if (id === './sync.cjs') return sync;
      if (id === './navicat.cjs') return {};
      if (id === './backup-file.cjs') return { saveBackupFile: (_file, run) => run(async () => {}) };
      if (id === './backup-catalog.cjs') return { backupDirectory: () => '/review/backups', backupName: () => 'test.sql' };
      if (id === 'node:fs') return { ...fs, mkdirSync() {}, writeFileSync() {}, renameSync() {}, promises: { ...fs.promises, mkdir: async () => {} } };
      return require(id.startsWith('./') ? path.join(root, id) : id);
    }, __dirname: root, process, Buffer, console, setTimeout, clearTimeout
  });
  return {
    call: (name, payload, options) => handlers.get(name)({ sender: null }, payload, options),
    sessions,
    dialog: (callback) => { chooseFile = callback; },
    openDialog: (callback) => { chooseOpen = callback; },
    finish: (value) => finish(value)
  };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  throw new Error('Timed out waiting for fixture state.');
};

test('reset invalidates sync before waiting for database shutdown or replacing local data', async () => {
  const events = [];
  let finish;
  const r = setup({ sync: { logout: async () => { events.push('logout'); } }, reset: () => { events.push('reset'); return { backupName: 'fixture.json' }; } });
  await r.call('db:connect', 'p1');
  r.sessions[0].close = () => { events.push('close'); return new Promise((resolve) => { finish = resolve; }); };
  const pending = r.call('account:reset-local'); await tick();
  assert.deepEqual(events, ['logout', 'close']);
  finish();
  assert.equal((await pending).ok, true);
  assert.deepEqual(events, ['logout', 'close', 'reset']);
});

test('backup uses and cancels its own session without touching the SQL editor session', async () => {
  const r = setup();
  await r.call('db:connect', 'p1');
  const parent = r.sessions[0];
  parent.userTransaction = true;
  const pending = r.call('db:backup', { profileId: 'p1', database: 'demo', taskId: 'backup-1' });
  await tick();
  assert.equal(r.sessions.length, 2);
  const worker = r.sessions[1];
  assert.equal(worker.activeTask.id, 'backup-1');
  assert.equal((await r.call('db:connect', 'p2')).ok, true);
  assert.equal(r.sessions.length, 3);
  assert.equal((await r.call('db:cancel-task', { profileId: 'p1', taskId: 'backup-1' })).data.canceled, true);
  assert.equal((await pending).data.canceled, true);
  assert.deepEqual(worker.canceled, ['backup-1']);
  assert.equal(worker.dead, true);
  assert.equal(parent.dead, undefined);
  assert.equal(parent.userTransaction, true);
  assert.deepEqual(parent.canceled, []);
});

test('import và restore dùng phiên riêng, không đụng transaction của SQL editor', async () => {
  const r = setup();
  await r.call('db:connect', 'p1');
  const parent = r.sessions[0];
  parent.inTransaction = true;
  parent.autocommit = false;
  const { profileId, connected, inTransaction, autocommit } = (await r.call('db:session-state', 'p1')).data;
  assert.deepEqual({ profileId, connected, inTransaction, autocommit }, {
    profileId: 'p1',
    connected: true,
    inTransaction: true,
    autocommit: false
  });
  assert.equal(JSON.stringify((await r.call('db:disconnect', 'p1')).data), JSON.stringify({
    disconnected: false,
    needsConfirmation: true,
    profileId: 'p1'
  }));

  const importing = r.call('db:import-file', {
    profileId: 'p1',
    database: 'demo',
    table: 'items',
    filePath: '/review/items.csv',
    format: 'csv',
    taskId: 'import-worker'
  });
  await tick();
  assert.equal(r.sessions.length, 2);
  const importWorker = r.sessions[1];
  assert.notEqual(importWorker, parent);
  assert.equal(importWorker.prepared, 'import');
  assert.equal(importWorker.activeTask.id, 'import-worker');
  assert.deepEqual(parent.canceled, []);
  r.finish({ rows: 1, written: 1, committed: 1 });
  const importResult = await importing;
  assert.equal(importResult.ok, true);
  assert.equal(importResult.data.written, 1);
  assert.equal(importWorker.dead, true);
  assert.equal(parent.dead, undefined);

  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-main-restore-'));
  const filePath = path.join(folder, 'backup.sql');
  fs.writeFileSync(filePath, 'SELECT 1;\n');
  r.openDialog(async () => ({ canceled: false, filePaths: [filePath] }));
  try {
    const restoring = r.call('db:restore', { profileId: 'p1', database: 'demo', taskId: 'restore-worker' });
    await waitFor(() => r.sessions.length === 3);
    const restoreWorker = r.sessions[2];
    assert.notEqual(restoreWorker, parent);
    assert.equal(restoreWorker.prepared, 'restore');
    assert.equal(restoreWorker.activeTask.id, 'restore-worker');
    r.finish({ statements: 1, verification: { status: 'verified' } });
    const restoreResult = await restoring;
    assert.equal(restoreResult.ok, true);
    assert.equal(restoreResult.data.statements, 1);
    assert.equal(restoreWorker.dead, true);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }

  assert.equal(parent.dead, undefined);
  assert.equal(parent.inTransaction, true);
  assert.equal(parent.autocommit, false);
  assert.deepEqual(parent.canceled, []);
  assert.equal(JSON.stringify((await r.call('db:disconnect', 'p1', { force: true })).data), JSON.stringify({
    disconnected: true,
    openProfiles: []
  }));
});

test('query export reserves its task before the save dialog and supports cancel during preparation', async () => {
  const r = setup();
  let choose;
  r.dialog(() => new Promise((resolve) => { choose = resolve; }));
  const pending = r.call('db:export-query', { profileId: 'p1', sql: 'SELECT 1', format: 'json', taskId: 'export-1' });
  await tick();
  const competing = await r.call('db:export-query', { profileId: 'p1', sql: 'SELECT 2', taskId: 'export-2' });
  assert.equal(competing.ok, false);
  assert.equal((await r.call('db:cancel-task', { profileId: 'other', taskId: 'export-1' })).data.canceled, false);
  assert.equal((await r.call('db:cancel-task', { profileId: 'p1', taskId: 'export-1' })).data.canceled, true);
  choose({ filePath: '/review/export.json' });
  assert.equal((await pending).data.canceled, true);
  assert.equal(r.sessions[0].activeTask, undefined);
  r.dialog(async () => ({ canceled: true }));
  assert.equal((await r.call('db:export-query', { profileId: 'p1', sql: 'SELECT 1', taskId: 'export-3' })).data.dialog, true);
});

for (const outcome of ['metadata-error', 'connection-error', 'success']) {
  test(`stale connect ${outcome} does not close or replace a new busy session`, async () => {
    const r = setup();
    // Opening yields before metadata, allowing us to hold that session's response.
    const old = r.call('db:connect', 'p1');
    let finish, fail;
    r.sessions[0].listDatabases = () => new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    await tick();
    await r.call('db:disconnect', 'p1');
    assert.equal((await r.call('db:connect', 'p1')).ok, true);
    const current = r.sessions[1];
    current.inTransaction = true; current.activeTask = { id: 'busy' };
    if (outcome === 'success') finish(['old']);
    else fail(Object.assign(new Error('old metadata failure'), { code: outcome === 'connection-error' ? 'ECONNRESET' : 'OLD_METADATA_ERROR' }));
    assert.equal((await old).ok, false);
    assert.equal(current.dead, undefined);
    assert.equal(r.sessions.length, 2);
    assert.equal(JSON.stringify((await r.call('db:open-profiles')).data), '["p1"]');
    assert.equal((await r.call('db:connect', 'p1')).data.reused, true);
  });
}

test('query export cancels the matching stream and releases the transfer slot', async () => {
  const r = setup();
  const pending = r.call('db:export-query', { profileId: 'p1', sql: 'SELECT 1', format: 'json', taskId: 'export-1' });
  await tick();
  assert.equal(r.sessions[0].activeTask.id, 'export-1');
  assert.equal((await r.call('db:cancel-task', { profileId: 'p1', taskId: 'wrong' })).data.canceled, false);
  assert.equal((await r.call('db:cancel-task', { profileId: 'p1', taskId: 'export-1' })).data.canceled, true);
  assert.equal((await pending).data.canceled, true);
  r.dialog(async () => ({ canceled: true }));
  assert.equal((await r.call('db:export-query', { profileId: 'p1', sql: 'SELECT 1', taskId: 'export-2' })).ok, true);
});
