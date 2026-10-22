'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('./store.cjs');
const sync = require('./sync.cjs');
const { parseNavicatFile } = require('./navicat.cjs');
const { DatabaseSession, testConnection, MAX_RESTORE_BYTES } = require('./database.cjs');

const MAX_RENDERER_STATE_BYTES = 2 * 1024 * 1024;
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const MAX_EXPORT_BYTES = 50 * 1024 * 1024;

let mainWindow;
let isQuitting = false;
let activeSession = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

function jsonPath(fileName) {
  return path.join(app.getPath('userData'), fileName);
}

function readJson(fileName, fallback) {
  try {
    return JSON.parse(fs.readFileSync(jsonPath(fileName), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(fileName, value) {
  const serialized = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(serialized) > MAX_RENDERER_STATE_BYTES) {
    throw new Error('Dữ liệu cài đặt vượt quá giới hạn cho phép.');
  }
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  const target = jsonPath(fileName);
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, serialized, 'utf8');
  fs.renameSync(temporary, target);
}

function getWindowOptions() {
  const saved = readJson('window-state.json', {});
  const area = screen.getPrimaryDisplay().workArea;
  const width = Number.isFinite(saved.width) ? Math.max(1024, Math.min(saved.width, area.width)) : 1280;
  const height = Number.isFinite(saved.height) ? Math.max(650, Math.min(saved.height, area.height)) : 800;
  const positionIsVisible = Number.isFinite(saved.x) && Number.isFinite(saved.y)
    && saved.x < area.x + area.width - 80
    && saved.y < area.y + area.height - 80
    && saved.x + width > area.x + 80
    && saved.y + height > area.y + 80;

  return {
    width,
    height,
    ...(positionIsVisible ? { x: saved.x, y: saved.y } : {}),
    maximized: Boolean(saved.maximized)
  };
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.isMaximized() ? mainWindow.getNormalBounds() : mainWindow.getBounds();
  writeJson('window-state.json', { ...bounds, maximized: mainWindow.isMaximized() });
}

function sendCommand(command) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('menu:command', command);
  }
}

function sendDbProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('db:progress', payload);
  }
}

function syncNotifier() {
  return {
    status: (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sync:status', payload);
      }
    },
    applied: (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sync:applied', payload);
      }
    }
  };
}

function applyZoom(delta) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const contents = mainWindow.webContents;
  const level = delta === null ? 0 : Math.max(-6, Math.min(6, contents.getZoomLevel() + delta));
  contents.setZoomLevel(level);
}

function buildMenu() {
  const template = [
    {
      label: 'Tệp',
      submenu: [
        { label: 'Kết nối mới', accelerator: 'Ctrl+N', click: () => sendCommand('new-connection') },
        { label: 'Nhập kết nối Navicat…', click: () => sendCommand('import-navicat') },
        { label: 'Ngắt kết nối', click: () => sendCommand('disconnect') },
        { type: 'separator' },
        { label: 'Truy vấn mới', accelerator: 'Ctrl+T', click: () => sendCommand('new-query') },
        { label: 'Lưu truy vấn', accelerator: 'Ctrl+S', click: () => sendCommand('save-query') },
        { label: 'Nhập dữ liệu…', accelerator: 'Ctrl+O', click: () => sendCommand('import') },
        { label: 'Xuất dữ liệu…', accelerator: 'Ctrl+Shift+S', click: () => sendCommand('export') },
        { type: 'separator' },
        { label: 'Sao lưu database…', click: () => sendCommand('backup') },
        { label: 'Phục hồi database…', click: () => sendCommand('restore') },
        { type: 'separator' },
        { role: 'quit', label: 'Thoát' }
      ]
    },
    {
      label: 'Chỉnh sửa',
      submenu: [
        { role: 'undo', label: 'Hoàn tác' },
        { role: 'redo', label: 'Làm lại' },
        { type: 'separator' },
        { role: 'cut', label: 'Cắt' },
        { role: 'copy', label: 'Sao chép' },
        { role: 'paste', label: 'Dán' },
        { role: 'selectAll', label: 'Chọn tất cả' }
      ]
    },
    {
      label: 'Hiển thị',
      submenu: [
        { label: 'Ẩn/hiện thanh bên', accelerator: 'Ctrl+B', click: () => sendCommand('toggle-sidebar') },
        { type: 'separator' },
        { label: 'Cỡ mặc định', accelerator: 'Ctrl+0', registerAccelerator: false, click: () => applyZoom(null) },
        { label: 'Phóng to', accelerator: 'Ctrl+Plus', registerAccelerator: false, click: () => applyZoom(0.5) },
        { label: 'Thu nhỏ', accelerator: 'Ctrl+-', registerAccelerator: false, click: () => applyZoom(-0.5) },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Toàn màn hình', accelerator: 'F11' }
      ]
    },
    {
      label: 'Truy vấn',
      submenu: [
        { label: 'Chạy truy vấn', accelerator: 'Ctrl+Enter', click: () => sendCommand('run-query') },
        { label: 'Chạy truy vấn (F5)', accelerator: 'F5', click: () => sendCommand('run-query') },
        { label: 'Hủy truy vấn đang chạy', click: () => sendCommand('cancel-query') },
        { label: 'Làm mới dữ liệu', accelerator: 'Ctrl+R', click: () => sendCommand('refresh-data') }
      ]
    },
    {
      label: 'Trợ giúp',
      submenu: [
        {
          label: 'Giới thiệu SqlPro',
          click: () => dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'Giới thiệu SqlPro',
            message: `SqlPro ${app.getVersion()}`,
            detail: 'Ứng dụng desktop quản trị cơ sở dữ liệu MySQL/MariaDB.\nHỗ trợ nhập kết nối và SSH tunnel tương thích Navicat.'
          })
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const options = getWindowOptions();
  mainWindow = new BrowserWindow({
    width: options.width,
    height: options.height,
    x: options.x,
    y: options.y,
    minWidth: 1024,
    minHeight: 650,
    show: false,
    backgroundColor: '#f7f9fa',
    title: 'SqlPro',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    if (options.maximized) mainWindow.maximize();
    mainWindow.show();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.alt || (!input.control && !input.meta)) return;
    const key = input.key || '';
    const code = input.code || '';
    if (key === '+' || key === '=' || code === 'NumpadAdd') {
      event.preventDefault();
      applyZoom(0.5);
    } else if (key === '-' || key === '_' || code === 'NumpadSubtract') {
      event.preventDefault();
      applyZoom(-0.5);
    } else if (key === '0' || code === 'Numpad0') {
      event.preventDefault();
      applyZoom(null);
    }
  });
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  mainWindow.on('close', () => saveWindowState());
  mainWindow.on('closed', () => { mainWindow = undefined; });
}

function validateState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Trạng thái ứng dụng không hợp lệ.');
  }
  return value;
}

function handle(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (mainWindow && event.sender !== mainWindow.webContents) {
      return { ok: false, error: { message: 'Yêu cầu không hợp lệ.', code: 'INVALID_SENDER' } };
    }
    try {
      return { ok: true, data: await handler(...args) };
    } catch (error) {
      return {
        ok: false,
        error: {
          message: friendlyError(error),
          code: error && error.code ? String(error.code) : '',
          sqlState: error && error.sqlState ? String(error.sqlState) : ''
        }
      };
    }
  });
}

function friendlyError(error) {
  if (!error) return 'Đã xảy ra lỗi không xác định.';
  const code = String(error.code || '');
  const messages = {
    ER_ACCESS_DENIED_ERROR: 'Sai username hoặc mật khẩu.',
    ER_DBACCESS_DENIED_ERROR: 'Tài khoản không có quyền truy cập database này.',
    ER_BAD_DB_ERROR: 'Database không tồn tại.',
    ECONNREFUSED: 'Không kết nối được tới host/port. Kiểm tra lại địa chỉ và firewall.',
    ENOTFOUND: 'Không phân giải được hostname.',
    ETIMEDOUT: 'Kết nối quá thời gian chờ.',
    ECONNRESET: 'Kết nối bị đóng bởi máy chủ.',
    PROTOCOL_CONNECTION_LOST: 'Mất kết nối tới database.',
    SESSION_CLOSED: 'Phiên kết nối đã đóng. Hãy kết nối lại.',
    QUERY_TIMEOUT: 'Truy vấn quá thời gian cho phép.',
    QUERY_CANCELED: 'Đã hủy truy vấn.',
    NO_PRIMARY_KEY: 'Bảng không có khóa chính nên không thể sửa/xóa trực tiếp.',
    NETWORK_ERROR: 'Không kết nối được tới server đồng bộ. Kiểm tra URL và kết nối mạng.',
    INVALID_SERVER_URL: 'Địa chỉ server đồng bộ không hợp lệ.',
    INSECURE_SERVER: 'Server không dùng HTTPS. Hãy dùng HTTPS hoặc xác nhận cho phép HTTP không an toàn.',
    INVALID_CREDENTIALS: 'Email hoặc mật khẩu không đúng.',
    EMAIL_TAKEN: 'Email này đã được đăng ký trên server.',
    RATE_LIMITED: 'Bạn thao tác quá nhanh. Hãy thử lại sau.',
    SYNC_ACCOUNT_MISMATCH: 'Dữ liệu local thuộc tài khoản khác. Hãy sao lưu và xóa dữ liệu local trước khi đổi tài khoản.',
    WEAK_PASSWORD: 'Mật khẩu quá ngắn. Hãy dùng ít nhất 10 ký tự.',
    REGISTRATION_DISABLED: 'Server này không mở đăng ký tài khoản.',
    VAULT_DECRYPT_FAILED: 'Không thể giải mã dữ liệu đồng bộ. Kiểm tra mật khẩu hoặc dữ liệu trên server.',
    NOT_LOGGED_IN: 'Chưa đăng nhập tài khoản đồng bộ.',
    SESSION_EXPIRED: 'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.',
    VAULT_TOO_LARGE: 'Dữ liệu đồng bộ vượt quá giới hạn 5 MB.'
  };
  return messages[code] || error.message || 'Đã xảy ra lỗi.';
}

function runtimeProfile(profile) {
  return {
    ...profile,
    ssh: {
      ...profile.ssh,
      password: profile.sshPassword || '',
      passphrase: profile.sshPassphrase || ''
    }
  };
}

function mergeSecrets(payload) {
  const base = {
    name: payload && payload.name,
    type: payload && payload.type,
    host: payload && payload.host,
    port: payload && payload.port,
    user: payload && payload.user,
    password: payload && payload.password,
    database: payload && payload.database,
    ssl: payload && payload.ssl,
    ssh: payload && payload.ssh,
    sshPassword: payload && payload.sshPassword,
    sshPassphrase: payload && payload.sshPassphrase
  };
  if (payload && payload.id) {
    const stored = store.getWithSecrets(payload.id);
    if (payload.password === undefined) base.password = stored.password;
    if (payload.sshPassword === undefined) base.sshPassword = stored.sshPassword;
    if (payload.sshPassphrase === undefined) base.sshPassphrase = stored.sshPassphrase;
    if (!payload.ssl) base.ssl = stored.ssl;
    if (!payload.ssh) base.ssh = stored.ssh;
  }
  return base;
}

function isConnectionError(error) {
  const code = String(error && error.code ? error.code : '');
  return ['ECONNRESET', 'PROTOCOL_CONNECTION_LOST', 'ETIMEDOUT', 'EPIPE', 'ER_SERVER_SHUTDOWN', 'SESSION_CLOSED'].includes(code);
}

async function closeActiveSession() {
  const current = activeSession;
  activeSession = null;
  if (!current) return;
  try {
    await current.session.close();
  } catch {
    // ignore
  }
}

async function openSession(profileId) {
  await closeActiveSession();
  const stored = store.getWithSecrets(profileId);
  const session = new DatabaseSession(runtimeProfile(stored));
  await session.connect();
  activeSession = { profileId, session };
  return activeSession;
}

async function ensureSession() {
  if (!activeSession) {
    throw Object.assign(new Error('Chưa kết nối database.'), { code: 'SESSION_CLOSED' });
  }
  if (activeSession.session.dead) {
    await openSession(activeSession.profileId);
  }
  return activeSession;
}

async function withSession(handler, { retry = false } = {}) {
  let current = await ensureSession();
  try {
    return await handler(current.session);
  } catch (error) {
    if (retry && isConnectionError(error)) {
      current.session.dead = true;
      current = await openSession(current.profileId);
      return handler(current.session);
    }
    throw error;
  }
}

ipcMain.handle('app:metadata', () => ({
  name: app.getName(),
  version: app.getVersion(),
  platform: process.platform
}));
ipcMain.handle('state:load', () => readJson('renderer-state.json', {}));
ipcMain.handle('state:save', (_event, value) => {
  writeJson('renderer-state.json', validateState(value));
  return { ok: true };
});

ipcMain.handle('file:save-text', async (_event, payload) => {
  if (!payload || typeof payload.contents !== 'string' || typeof payload.suggestedName !== 'string') {
    throw new Error('Yêu cầu lưu tệp không hợp lệ.');
  }
  if (Buffer.byteLength(payload.contents) > MAX_EXPORT_BYTES) {
    throw new Error('Tệp xuất vượt quá giới hạn 50 MB.');
  }
  const safeName = path.basename(payload.suggestedName).replace(/[<>:"/\\|?*]/g, '_').slice(0, 160) || 'sqlpro-export.txt';
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Xuất dữ liệu',
    defaultPath: safeName,
    filters: Array.isArray(payload.filters) ? payload.filters.slice(0, 5) : undefined
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.promises.writeFile(result.filePath, payload.contents, 'utf8');
  return { canceled: false, filePath: result.filePath };
});

ipcMain.handle('file:open-json', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Nhập dữ liệu JSON',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  const filePath = result.filePaths[0];
  const stat = await fs.promises.stat(filePath);
  if (stat.size > MAX_IMPORT_BYTES) throw new Error('Tệp nhập vượt quá giới hạn 20 MB.');
  return { canceled: false, filePath, contents: await fs.promises.readFile(filePath, 'utf8') };
});

handle('connections:list', () => store.list());

handle('connections:save', (payload) => {
  const saved = store.save(payload);
  sync.schedule();
  return saved;
});

handle('connections:remove', async (id) => {
  if (activeSession && activeSession.profileId === id) await closeActiveSession();
  store.remove(id);
  sync.schedule();
  return { removed: true };
});

handle('connections:test', async (payload) => {
  const merged = mergeSecrets(payload);
  if (!merged.host) throw new Error('Host không được để trống.');
  const result = await testConnection(runtimeProfile(merged));
  return { version: result.version };
});

handle('connections:import-navicat', async (workspaceId) => {
  const candidates = [
    path.join(os.homedir(), '.config', 'navicat', 'Common', 'connections.json'),
    path.join(app.getPath('appData'), 'navicat', 'Common', 'connections.json')
  ];
  const defaultPath = candidates.find((candidate) => fs.existsSync(candidate));
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Nhập kết nối từ Navicat',
    properties: ['openFile'],
    defaultPath,
    filters: [
      { name: 'Navicat connections', extensions: ['ncx', 'json'] },
      { name: 'Tất cả tệp', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  const parsed = parseNavicatFile(result.filePaths[0]);
  const imported = store.importMany(parsed.connections, workspaceId);
  sync.schedule();
  return {
    canceled: false,
    filePath: result.filePaths[0],
    added: imported.added,
    updated: imported.updated,
    skipped: parsed.skipped
  };
});

handle('workspaces:list', () => store.listWorkspaces());

handle('workspaces:save', (payload) => {
  const workspace = store.saveWorkspace(payload);
  sync.schedule();
  return workspace;
});

handle('workspaces:remove', (id) => {
  if (typeof id !== 'string' || !id) throw new Error('Workspace không hợp lệ.');
  const result = store.removeWorkspace(id);
  sync.schedule();
  return result;
});

handle('account:status', () => sync.status());

handle('account:register', (payload) => {
  if (!payload || typeof payload !== 'object') throw new Error('Thông tin đăng ký không hợp lệ.');
  return sync.register(payload);
});

handle('account:login', (payload) => {
  if (!payload || typeof payload !== 'object') throw new Error('Thông tin đăng nhập không hợp lệ.');
  return sync.login(payload);
});

handle('account:logout', () => sync.logout());

handle('account:reset-local', async () => {
  await closeActiveSession();
  const { backupName } = store.resetLocalData();
  await sync.logout();
  writeJson('renderer-state.json', {});
  return { backupName };
});

handle('account:sync-now', () => sync.syncNow());

handle('db:connect', async (profileId) => {
  if (typeof profileId !== 'string' || !profileId) throw new Error('Kết nối không hợp lệ.');
  const current = await openSession(profileId);
  try {
    const databases = await current.session.listDatabases();
    return {
      profileId,
      server: current.session.version,
      databases
    };
  } catch (error) {
    await closeActiveSession();
    throw error;
  }
});

handle('db:disconnect', async () => {
  await closeActiveSession();
  return { disconnected: true };
});

handle('db:databases', () => withSession((session) => session.listDatabases(), { retry: true }));

handle('db:use-database', (database) => {
  if (typeof database !== 'string' || !database) throw new Error('Database không hợp lệ.');
  return withSession((session) => session.useDatabase(database), { retry: true });
});

handle('db:tables', (database) => {
  if (typeof database !== 'string' || !database) throw new Error('Database không hợp lệ.');
  return withSession((session) => session.listTables(database), { retry: true });
});

handle('db:columns', (database, table) => {
  if (typeof database !== 'string' || typeof table !== 'string') throw new Error('Tham số không hợp lệ.');
  return withSession((session) => session.listColumns(database, table), { retry: true });
});

handle('db:indexes', (database, table) => {
  if (typeof database !== 'string' || typeof table !== 'string') throw new Error('Tham số không hợp lệ.');
  return withSession((session) => session.listIndexes(database, table), { retry: true });
});

handle('db:relations', (database, table) => {
  if (typeof database !== 'string' || typeof table !== 'string') throw new Error('Tham số không hợp lệ.');
  return withSession((session) => session.listRelations(database, table), { retry: true });
});

handle('db:table-data', (payload) => {
  if (!payload || typeof payload !== 'object') throw new Error('Tham số không hợp lệ.');
  return withSession((session) => session.tableData(payload), { retry: true });
});

handle('db:query', (payload) => {
  if (!payload || typeof payload.sql !== 'string') throw new Error('Câu lệnh SQL không hợp lệ.');
  return withSession((session) => session.runQueryScript(
    payload.sql,
    Math.min(300000, Math.max(1000, Number(payload.timeoutMs) || 30000)),
    payload.confirmed === true
  ));
});

handle('db:cancel-query', () => {
  if (activeSession && activeSession.session.cancelQuery) activeSession.session.cancelQuery();
  return { canceled: true };
});

handle('db:insert-row', (payload) => {
  if (!payload || typeof payload !== 'object') throw new Error('Tham số không hợp lệ.');
  return withSession((session) => session.insertRow(payload));
});

handle('db:update-row', (payload) => {
  if (!payload || typeof payload !== 'object') throw new Error('Tham số không hợp lệ.');
  return withSession((session) => session.updateRow(payload));
});

handle('db:delete-rows', (payload) => {
  if (!payload || typeof payload !== 'object') throw new Error('Tham số không hợp lệ.');
  return withSession((session) => session.deleteRows(payload));
});

handle('db:export-table', (payload) => {
  if (!payload || typeof payload !== 'object') throw new Error('Tham số không hợp lệ.');
  return withSession((session) => session.exportTable(payload), { retry: true });
});

handle('db:import-rows', (payload) => {
  if (!payload || typeof payload !== 'object') throw new Error('Tham số không hợp lệ.');
  return withSession((session) => session.importRows(payload));
});

handle('db:backup', async (payload) => {
  if (!payload || typeof payload !== 'object') throw new Error('Tham số không hợp lệ.');
  if (typeof payload.database !== 'string' || !payload.database) throw new Error('Chưa chọn database để sao lưu.');
  const requested = {
    database: payload.database,
    tables: Array.isArray(payload.tables) ? payload.tables.filter((name) => typeof name === 'string' && name) : null,
    includeStructure: payload.includeStructure !== false,
    includeData: payload.includeData !== false,
    dropTables: payload.dropTables === true
  };
  if (!requested.includeStructure && !requested.includeData) throw new Error('Hãy chọn cấu trúc hoặc dữ liệu để sao lưu.');
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const safeName = requested.database.replace(/[<>:"/\\|?*]/g, '_').slice(0, 80) || 'database';
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Sao lưu database',
    defaultPath: `${safeName}-${stamp}.sql`,
    filters: [
      { name: 'SQL', extensions: ['sql'] },
      { name: 'Tất cả tệp', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePath) return { canceled: true };

  const temporary = `${result.filePath}.part-${process.pid}-${Date.now()}`;
  let handle = null;
  try {
    handle = await fs.promises.open(temporary, 'wx', 0o600);
    const write = async (chunk) => {
      await handle.write(chunk);
    };
    const stats = await withSession((session) => session.backupDatabase(requested, write, sendDbProgress));
    await handle.close();
    handle = null;
    await fs.promises.rename(temporary, result.filePath);
    return { canceled: false, filePath: result.filePath, ...stats };
  } catch (error) {
    try {
      if (handle) await handle.close();
    } catch {
      // ignore
    }
    try {
      await fs.promises.unlink(temporary);
    } catch {
      // ignore
    }
    throw error;
  }
});

handle('db:restore', async (payload) => {
  if (!payload || typeof payload !== 'object') throw new Error('Tham số không hợp lệ.');
  if (typeof payload.database !== 'string' || !payload.database) throw new Error('Chưa chọn database đích để phục hồi.');
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Phục hồi database từ tệp SQL',
    properties: ['openFile'],
    filters: [
      { name: 'SQL', extensions: ['sql'] },
      { name: 'Tất cả tệp', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  const filePath = result.filePaths[0];
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error('Đường dẫn phục hồi không phải là tệp.');
  if (stat.size > MAX_RESTORE_BYTES) throw new Error('Tệp SQL vượt quá giới hạn 1 GB.');
  const stats = await withSession((session) => session.restoreDatabase({
    database: payload.database,
    filePath,
    dropExisting: payload.dropExisting === true
  }, sendDbProgress));
  return { canceled: false, filePath, ...stats };
});

app.whenReady().then(() => {
  buildMenu();
  sync.init({ notify: syncNotifier() });
  createWindow();
  sync.startup().catch(() => undefined);
});

app.on('before-quit', () => {
  isQuitting = true;
  sync.shutdown();
  if (activeSession) {
    try {
      activeSession.session.close();
    } catch {
      // ignore
    }
  }
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && !isQuitting) createWindow();
});
