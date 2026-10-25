'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('đổi A → B → A dùng lại phiên cũ và ngắt kết nối chỉ đóng phiên đang chọn', async () => {
  const handlers = new Map();
  const created = [];
  let databaseReads = 0;
  class FakeSession {
    constructor(profile) { this.profile = profile; this.connection = null; this.dead = false; this.version = '8.0'; this.queries = []; this.usedDatabases = []; this.canceledTasks = []; this.runningTask = null; this.finishQuery = null; created.push(this); }
    async connect() { this.connection = {}; }
    async close() { this.connection = null; this.dead = true; }
    async listDatabases() { databaseReads += 1; return ['sample']; }
    async useDatabase(database) { this.usedDatabases.push(database); }
    async runQueryScript(sql, _timeout, _confirmed, taskId) {
      this.queries.push(sql);
      this.runningTask = taskId || null;
      if (sql === 'SLOW') {
        return new Promise((resolve) => { this.finishQuery = resolve; });
      }
      this.runningTask = null;
      return { kind: 'ok', sql };
    }
    cancelTask(taskId) {
      if (!this.runningTask || (taskId && taskId !== this.runningTask)) return false;
      this.canceledTasks.push(taskId);
      this.runningTask = null;
      return true;
    }
  }
  const fakeApp = { requestSingleInstanceLock: () => true, on() {}, whenReady: () => new Promise(() => {}), getPath: () => '/tmp' };
  const fakeElectron = { app: fakeApp, BrowserWindow: {}, Menu: {}, dialog: {},
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, screen: {}, shell: {} };
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  vm.runInNewContext(source, {
    require: (id) => {
      if (id === 'electron') return fakeElectron;
      if (id === './store.cjs') return { getWithSecrets: (profileId) => ({ id: profileId, ssh: {} }) };
      if (id === './sync.cjs') return {};
      if (id === './navicat.cjs') return {};
      if (id === './database.cjs') return { DatabaseSession: FakeSession };
      return require(id.startsWith('./') ? path.join(__dirname, '../electron', id) : id);
    },
    __dirname: path.join(__dirname, '../electron'), process, Buffer, console, setTimeout, clearTimeout
  });
  const call = (channel, value) => handlers.get(channel)({ sender: null }, value);
  assert.equal((await call('db:connect', 'a')).data.reused, false);
  assert.equal((await call('db:connect', 'b')).ok, true);
  assert.equal(created.length, 2);
  assert.equal(created[0].dead, false);
  assert.equal((await call('db:connect', 'a')).data.reused, true);
  assert.equal(created.length, 2);
  assert.equal(databaseReads, 2);
  assert.deepEqual(Array.from((await call('db:open-profiles')).data).sort(), ['a', 'b']);
  const query = await call('db:query', { profileId: 'b', database: 'sample', sql: 'SELECT 42' });
  assert.equal(query.ok, true);
  assert.deepEqual(created[1].queries, ['SELECT 42']);
  assert.deepEqual(created[1].usedDatabases, ['sample']);
  assert.deepEqual(created[0].queries, []);
  const pendingA = call('db:query', { profileId: 'a', database: 'sample', sql: 'SLOW', taskId: 'q-a' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await call('db:cancel-query', { profileId: 'b', taskId: 'q-a' })).data.canceled, false);
  assert.deepEqual(created[0].canceledTasks, []);
  assert.deepEqual(created[1].canceledTasks, []);
  assert.equal((await call('db:cancel-query', { profileId: 'a', taskId: 'q-a' })).data.canceled, true);
  assert.deepEqual(created[0].canceledTasks, ['q-a']);
  assert.deepEqual(created[1].canceledTasks, []);
  created[0].finishQuery({ kind: 'ok', sql: 'SLOW' });
  assert.equal((await pendingA).ok, true);
  assert.equal(created[0].queries.at(-1), 'SLOW');
  await call('db:disconnect');
  assert.equal(created[0].dead, true);
  assert.equal(created[1].dead, false);
  created[1].dead = true;
  assert.equal((await call('db:connect', 'b')).ok, true);
  assert.equal(created.length, 3);
  const worker = created[2];
  const background = call('db:query', { profileId: 'b', database: 'sample', sql: 'SLOW', taskId: 'background' });
  await new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 8; i++) assert.equal((await call('db:connect', `extra-${i}`)).ok, true);
  assert.equal(worker.dead, false);
  worker.finishQuery({ kind: 'ok' });
  assert.equal((await background).ok, true);
});
