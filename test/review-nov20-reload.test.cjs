'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const root = path.join(__dirname, '../electron');
  const calls = [], controls = { choice: 0, duringDialog() {} };
  const timers = [], state = { closed: false };
  const window = {
    isDestroyed: () => state.closed,
    webContents: {
      reload: () => calls.push('reload'), reloadIgnoringCache: () => calls.push('reload'),
      send: (...args) => calls.push(args)
    }
  };
  const context = vm.createContext({
    require(id) {
      if (id === 'electron') return {
        app: { requestSingleInstanceLock: () => true, on() {}, whenReady: () => new Promise(() => {}) },
        ipcMain: { handle() {} },
        dialog: { showMessageBoxSync(_win, options) { calls.push(options); controls.duringDialog(); return controls.choice; } }
      };
      if (id === 'node:fs') return { ...fs, watch(_root, _options, cb) { controls.watch = cb; return { unref() {}, close() {} }; } };
      if (['./store.cjs', './sync.cjs', './navicat.cjs'].includes(id)) return {};
      return require(id.startsWith('./') ? path.join(root, id) : id);
    },
    __dirname: root, process, Buffer, console, AbortController,
    setTimeout(fn) { timers.push(fn); return { unref() {} }; }, clearTimeout() {}, window
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'main.cjs'), 'utf8'), context);
  const evaluate = code => vm.runInContext(code, context);
  evaluate('mainWindow = window');
  return { calls, controls, timers, state, evaluate };
}

test('development file changes notify the renderer without reloading drafts or running work', () => {
  const r = fixture();
  r.evaluate('setupDevFileWatcher()'); r.controls.watch('change', 'app.js');
  r.timers.at(-1)();
  assert.equal(r.calls.includes('reload'), false);
  assert.deepEqual(r.calls[0], ['menu:command', 'dev-files-changed']);
});

test('manual development reload defaults to Cancel and reloads only after explicit confirmation', () => {
  const r = fixture();
  r.evaluate('requestDevReload()');
  assert.equal(r.calls[0].defaultId, 0); assert.equal(r.calls[0].cancelId, 0);
  assert.equal(r.calls.includes('reload'), false);
  r.controls.choice = 1; r.evaluate('requestDevReload()');
  assert.equal(r.calls.filter(c => c === 'reload').length, 1);
});

test('reload is blocked for transactions, autocommit OFF, leases, opens and transfers, including changes during confirm', () => {
  for (const setup of [
    "openSessions.set('p',{session:{inTransaction:true}})",
    "openSessions.set('p',{session:{autocommit:false}})",
    "openSessions.set('p',{session:{activeTask:{}}})",
    "sessionRegistry.leases.set({},1)",
    "sessionRegistry.opening.set('p',Promise.resolve())",
    'activeDatabaseTransfer={}'
  ]) {
    const r = fixture(); r.controls.choice = 1; r.evaluate(setup); r.evaluate('requestDevReload()');
    assert.equal(r.calls.includes('reload'), false, setup);
    const late = fixture(); late.controls.choice = 1; late.controls.duringDialog = () => late.evaluate(setup);
    late.evaluate('requestDevReload()'); assert.equal(late.calls.includes('reload'), false, 'late: ' + setup);
  }
  const r = fixture(); r.controls.choice = 1; r.controls.duringDialog = () => { r.state.closed = true; };
  r.evaluate('requestDevReload()'); assert.equal(r.calls.includes('reload'), false);
});
