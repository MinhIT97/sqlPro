'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');

test('cửa sổ chỉ điều hướng tới trang ứng dụng đã tải', () => {
  const root = path.join(__dirname, '../electron');
  const listeners = new Map();
  let loadedFile;
  class BrowserWindow {
    constructor() {
      this.webContents = {
        on: (name, listener) => listeners.set(name, listener),
        setWindowOpenHandler: () => {},
        session: { setPermissionRequestHandler: () => {} }
      };
    }
    loadFile(filePath) { loadedFile = filePath; }
    once() {}
    on() {}
  }
  const electron = {
    app: {
      requestSingleInstanceLock: () => true,
      on: () => {},
      whenReady: () => new Promise(() => {}),
      getPath: () => '/tmp/sqlpro-navigation-test'
    },
    BrowserWindow,
    ipcMain: { handle: () => {} },
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1600, height: 900 } }) }
  };
  const context = vm.createContext({
    require(id) {
      if (id === 'electron') return electron;
      if (id === './store.cjs' || id === './sync.cjs' || id === './navicat.cjs') return {};
      if (id === './database.cjs') return { DatabaseSession: class {}, normalizeFileFormat: () => 'csv' };
      if (id === './backup-file.cjs' || id === './backup-catalog.cjs') return {};
      return require(id.startsWith('./') ? path.join(root, id) : id);
    },
    __dirname: root,
    process,
    Buffer,
    console,
    setTimeout,
    clearTimeout
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'main.cjs'), 'utf8'), context);
  vm.runInContext('createWindow()', context);

  const navigate = listeners.get('will-navigate');
  assert.equal(typeof navigate, 'function');
  const isBlocked = (url) => {
    let blocked = false;
    navigate({ preventDefault() { blocked = true; } }, url);
    return blocked;
  };
  assert.equal(isBlocked(pathToFileURL(loadedFile).href), false);
  assert.equal(isBlocked(pathToFileURL(path.join(root, 'other.html')).href), true);
  assert.equal(isBlocked('https://example.com/'), true);
});
