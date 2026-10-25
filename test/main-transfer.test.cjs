'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup() {
  const handlers = new Map(), sessions = [];
  let chooseFile = async () => ({ filePath: '/review/export.json' });
  let finish;
  class Session {
    constructor(profile) { this.profile = profile; this.canceled = []; sessions.push(this); }
    async connect() { this.connection = {}; }
    async close() { this.dead = true; }
    async listDatabases() { return ['demo']; }
    async useDatabase() {}
    backupDatabase(options) { return this.run(options.taskId, 'BACKUP_CANCELED'); }
    exportQueryFile(options) { return this.run(options.taskId, 'EXPORT_CANCELED'); }
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
  const electron = { app, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, dialog: { showSaveDialog: (...args) => chooseFile(...args) } };
  const root = path.join(__dirname, '../electron');
  vm.runInNewContext(fs.readFileSync(path.join(root, 'main.cjs'), 'utf8'), {
    require(id) {
      if (id === 'electron') return electron;
      if (id === './database.cjs') return { DatabaseSession: Session };
      if (id === './store.cjs') return { getWithSecrets: (id) => ({ id, ssh: {} }) };
      if (id === './sync.cjs' || id === './navicat.cjs') return {};
      if (id === './backup-file.cjs') return { saveBackupFile: (_file, run) => run(async () => {}) };
      if (id === './backup-catalog.cjs') return { backupDirectory: () => '/review/backups', backupName: () => 'test.sql' };
      if (id === 'node:fs') return { ...fs, promises: { ...fs.promises, mkdir: async () => {} } };
      return require(id.startsWith('./') ? path.join(root, id) : id);
    }, __dirname: root, process, Buffer, console, setTimeout, clearTimeout
  });
  return {
    call: (name, payload) => handlers.get(name)({ sender: null }, payload), sessions,
    dialog: (callback) => { chooseFile = callback; },
    finish: (value) => finish(value)
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

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
  assert.equal((await r.call('db:cancel-task', { profileId: 'p1', taskId: 'backup-1' })).data.canceled, true);
  assert.equal((await pending).data.canceled, true);
  assert.deepEqual(worker.canceled, ['backup-1']);
  assert.equal(worker.dead, true);
  assert.equal(parent.dead, undefined);
  assert.equal(parent.userTransaction, true);
  assert.deepEqual(parent.canceled, []);
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
