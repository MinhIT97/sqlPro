'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, screen, shell, clipboard } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const store = require('./store.cjs');
const sync = require('./sync.cjs');
const { parseNavicatFile } = require('./navicat.cjs');
const { DatabaseSession, testConnection, previewImportFile, normalizeFileFormat } = require('./database.cjs');
const { saveBackupFile, manifestPathFor } = require('./backup-file.cjs');
const { SessionRegistry } = require('./session-registry.cjs');
const { backupDirectory, backupName, listBackups, resolveBackup, copyBackup, verifyBackup } = require('./backup-catalog.cjs');

const MAX_RENDERER_STATE_BYTES = 2 * 1024 * 1024;
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const MAX_EXPORT_BYTES = 50 * 1024 * 1024;

let mainWindow;
let isQuitting = false;
let activeSession = null;
const MAX_OPEN_SESSIONS = 8;
const sessionRegistry = new SessionRegistry({
  limit: MAX_OPEN_SESSIONS,
  isProtected: (entry) => entry === activeSession,
  create: async (profileId, options) => {
    const profile = runtimeProfile(store.getWithSecrets(profileId));
    if (options.sshHostKey) profile.ssh = { ...profile.ssh, knownHostKey: options.sshHostKey };
    const session = new DatabaseSession(profile);
    try {
      await session.connect();
      if (options.sshHostKey) {
        try { store.trustSshHostKey(profileId, options.sshHostKey); } catch { /* Ask again next time if trust cannot be stored. */ }
      }
      return { profileId, session };
    } catch (error) { await session.close().catch(() => {}); throw error; }
  }
});
const openSessions = sessionRegistry.entries;
let activeDatabaseTransfer = null;

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

function transferLabel(operation) {
  return {
    backup: 'sao lưu',
    restore: 'phục hồi',
    import: 'nhập dữ liệu',
    export: 'xuất dữ liệu'
  }[operation] || 'database';
}

function claimDatabaseTransfer(details) {
  if (activeDatabaseTransfer) throw new Error('Một tác vụ database đang chạy. Hãy đợi tác vụ hoàn tất.');
  const transfer = { canceled: false, pending: false, ...details };
  activeDatabaseTransfer = transfer;
  return transfer;
}

function resolveProfileId(profileId) {
  const id = typeof profileId === 'string' && profileId ? profileId : activeSession?.profileId;
  if (!id) throw new Error('Chưa kết nối database.');
  return id;
}

function activeTransactions() {
  return [...openSessions.values()]
    .filter((entry) => !entry.session.dead && entry.session.inTransaction)
    .map((entry) => entry.profileId);
}

function confirmActiveTransactions(action = 'ngắt kết nối') {
  const profiles = activeTransactions();
  if (!profiles.length) return true;
  const options = {
    type: 'warning',
    title: 'Transaction chưa hoàn tất',
    message: `Có ${profiles.length} phiên đang mở transaction chưa commit.`,
    detail: `${action === 'thoát' ? 'Thoát' : 'Ngắt kết nối'} sẽ rollback các thay đổi chưa commit của transaction đó.`,
    buttons: ['Quay lại', `Vẫn ${action}`],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  };
  let choice = 0;
  try {
    choice = mainWindow && !mainWindow.isDestroyed()
      ? dialog.showMessageBoxSync(mainWindow, options)
      : dialog.showMessageBoxSync(options);
  } catch {
    choice = 0;
  }
  return choice === 1;
}

function cancelDatabaseTransfer(transfer) {
  const session = transfer.session || openSessions.get(transfer.profileId)?.session;
  const canceled = session?.cancelTask(transfer.taskId) || transfer.pending;
  if (canceled) transfer.canceled = true;
  return Boolean(canceled);
}

function confirmStopActiveTransfer() {
  const active = activeDatabaseTransfer;
  if (!active) return true;
  const label = transferLabel(active.operation);
  const partialRisk = active.operation === 'restore' || active.operation === 'import';
  const message = `Tác vụ ${label} đang chạy. Thoát bây giờ sẽ hủy tác vụ${partialRisk ? ' và có thể để database ở trạng thái đã áp dụng một phần' : ''}.`;
  const options = {
    type: 'warning',
    title: 'Tác vụ database đang chạy',
    message,
    detail: 'Chọn “Tiếp tục chạy” để quay lại ứng dụng, hoặc “Dừng tác vụ và thoát” để hủy trước khi đóng.',
    buttons: ['Tiếp tục chạy', 'Dừng tác vụ và thoát'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  };
  const choice = mainWindow && !mainWindow.isDestroyed()
    ? dialog.showMessageBoxSync(mainWindow, options)
    : dialog.showMessageBoxSync(options);
  if (choice === 0) return false;
  cancelDatabaseTransfer(active);
  return true;
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
  const appPage = path.join(__dirname, '..', 'index.html');
  const appUrl = pathToFileURL(appPage).href;
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

  mainWindow.loadFile(appPage);
  mainWindow.once('ready-to-show', () => {
    if (options.maximized) mainWindow.maximize();
    mainWindow.show();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== appUrl) event.preventDefault();
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
  mainWindow.on('close', (event) => {
    if (!isQuitting && activeDatabaseTransfer) {
      event.preventDefault();
      if (!confirmStopActiveTransfer()) return;
      isQuitting = true;
      saveWindowState();
      mainWindow.destroy();
      return;
    }
    if (!isQuitting && activeTransactions().length && !confirmActiveTransactions('thoát')) {
      event.preventDefault();
      return;
    }
    saveWindowState();
  });
  mainWindow.on('closed', () => { mainWindow = undefined; });
}

function validateState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Trạng thái ứng dụng không hợp lệ.');
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error('Trạng thái ứng dụng không thể chuyển thành JSON.');
  }
  if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) {
    throw new Error('Trạng thái ứng dụng vượt quá giới hạn 2 MB.');
  }
  return value;
}

function validateDialogFilters(filters) {
  if (!Array.isArray(filters)) return undefined;
  return filters.slice(0, 5)
    .filter((filter) => filter && typeof filter === 'object')
    .map((filter) => ({
      name: typeof filter.name === 'string' ? filter.name.slice(0, 80) : 'Tệp dữ liệu',
      extensions: Array.isArray(filter.extensions)
        ? filter.extensions.slice(0, 20)
          .filter((extension) => typeof extension === 'string' && /^[A-Za-z0-9*]+$/.test(extension))
          .map((extension) => extension.slice(0, 20))
        : ['*']
    }));
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
          sqlState: error && error.sqlState ? String(error.sqlState) : '',
          ...(error && error.fingerprint ? { fingerprint: String(error.fingerprint) } : {}),
          ...(error && error.expectedFingerprint ? { expectedFingerprint: String(error.expectedFingerprint) } : {}),
          ...(error && error.partial ? { partial: error.partial } : {}),
          ...(error && error.impact ? { impact: error.impact } : {}),
          ...(error && error.preflight ? { preflight: error.preflight } : {}),
          ...(error && error.conflict ? { conflict: error.conflict } : {})
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
    QUERY_TIMEOUT: error.message || 'Truy vấn quá thời gian cho phép.',
    QUERY_CANCELED: 'Đã hủy truy vấn.',
    ER_LOCK_WAIT_TIMEOUT: 'Database đang bị transaction khác giữ khóa. Hãy hoàn tất hoặc rollback transaction đó rồi thử lại.',
    ER_LOCK_DEADLOCK: 'Database phát hiện deadlock và đã hủy một transaction. Hãy thử lại sau khi kiểm tra transaction đang mở.',
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
    VAULT_TOO_LARGE: 'Dữ liệu đồng bộ vượt quá giới hạn 5 MB.',
    STORE_READ_FAILED: 'Không đọc được cấu hình kết nối. Tệp dữ liệu được giữ nguyên, không ghi đè; hãy kiểm tra tệp hoặc dùng chức năng đặt lại dữ liệu local.',
    BACKUP_SNAPSHOT_FAILED: 'Không tạo được snapshot nhất quán cho bản sao lưu.',
    RESTORE_PREFLIGHT_BLOCKED: 'Kiểm tra trước phục hồi phát hiện vấn đề có thể làm hỏng dữ liệu đích. Chưa có thay đổi nào được ghi.',
    BACKUP_CHECKSUM_MISMATCH: 'Tệp sao lưu không khớp checksum đã lưu. Tệp có thể đã bị sửa hoặc hỏng.',
    TLS_NOT_SUPPORTED: 'Máy chủ không hỗ trợ TLS nhưng kết nối đang yêu cầu SSL/TLS. Hãy liên hệ quản trị viên máy chủ hoặc tắt TLS nếu hiểu rõ rủi ro.',
    TLS_CERT_UNTRUSTED: 'Chứng chỉ TLS của máy chủ không được tin cậy. Hãy cung cấp đúng CA hoặc dùng chứng chỉ do CA tin cậy phát hành.',
    TLS_CERT_EXPIRED: 'Chứng chỉ TLS của máy chủ đã hết hạn hoặc chưa có hiệu lực. Hãy cập nhật chứng chỉ trên máy chủ.',
    TLS_CERT_HOSTNAME_MISMATCH: 'Tên/IP trên chứng chỉ TLS không khớp địa chỉ máy chủ. Hãy dùng đúng hostname trong chứng chỉ hoặc cấu hình lại chứng chỉ.',
    TLS_HANDSHAKE_FAILED: 'Không thiết lập được TLS với máy chủ (giao thức hoặc chứng chỉ không tương thích). Kiểm tra cấu hình TLS của máy chủ và CA.',
    SSH_AUTH_FAILED: 'Xác thực SSH thất bại. Kiểm tra username, mật khẩu hoặc private key/passphrase.',
    SSH_CONNECTION_FAILED: 'Không kết nối được SSH host. Kiểm tra địa chỉ, cổng, mạng và firewall.',
    SSH_TUNNEL_FAILED: 'Đã kết nối SSH nhưng không mở được tunnel tới MySQL. Kiểm tra host/port MySQL nhìn từ máy SSH.',
    SSH_KEY_READ_FAILED: 'Không đọc được SSH private key. Kiểm tra đường dẫn và quyền đọc tệp.',
    SSH_TIMEOUT: 'Kết nối SSH quá thời gian chờ. Kiểm tra mạng, cổng và cấu hình SSH host.',
    MYSQL_CLEARTEXT_AUTH_REQUIRED: 'Máy chủ yêu cầu mysql_clear_password nhưng SqlPro chưa cho phép hoặc vận chuyển hiện tại không đáp ứng chính sách.',
    CLEARTEXT_AUTH_INSECURE_TRANSPORT: 'mysql_clear_password chỉ được phép khi TLS đã xác thực chứng chỉ hoặc qua SSH tunnel tới MySQL loopback trên chính máy SSH với host key đã xác minh.',
    SSL_FILE_READ_FAILED: 'Không đọc được tệp CA/chứng chỉ/khóa TLS. Kiểm tra đường dẫn và quyền đọc tệp.'
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
    allowCleartextPassword: payload && payload.allowCleartextPassword,
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
    if (!payload.ssh) {
      base.ssh = stored.ssh;
    } else if (stored && stored.ssh && stored.ssh.knownHostKey && !payload.ssh.knownHostKey) {
      base.ssh = { ...payload.ssh, knownHostKey: stored.ssh.knownHostKey };
    }
  }
  return base;
}

function isConnectionError(error) {
  const code = String(error && error.code ? error.code : '');
  return ['ECONNRESET', 'PROTOCOL_CONNECTION_LOST', 'ETIMEDOUT', 'EPIPE', 'ER_SERVER_SHUTDOWN', 'SESSION_CLOSED'].includes(code);
}

async function closeSession(profileId, expected) {
  if (expected && openSessions.get(profileId) !== expected) return false;
  if (activeSession?.profileId === profileId && (!expected || activeSession === expected)) activeSession = null;
  return sessionRegistry.close(profileId, expected);
}

async function closeActiveSession() {
  if (activeSession) await closeSession(activeSession.profileId);
}

async function closeAllSessions() {
  activeSession = null;
  await sessionRegistry.closeAll();
}

async function openSession(profileId, makeActive = true, options = {}, expected) {
  const current = await (expected ? sessionRegistry.reopen(expected, options) : sessionRegistry.open(profileId, options));
  if (openSessions.get(profileId) !== current) throw Object.assign(new Error('Yêu cầu kết nối đã bị hủy.'), { code: 'SESSION_OPEN_CANCELED' });
  if (makeActive) activeSession = current;
  return current;
}

async function ensureSession(profileId) {
  if (profileId) {
    const current = openSessions.get(profileId);
    if (!current || current.session.dead) return openSession(profileId, activeSession?.profileId === profileId);
    return current;
  }
  if (!activeSession) {
    throw Object.assign(new Error('Chưa kết nối database.'), { code: 'SESSION_CLOSED' });
  }
  if (activeSession.session.dead) {
    await openSession(activeSession.profileId);
  }
  return activeSession;
}

async function withSessionFor(profileId, handler, { retry = false } = {}) {
  return withSession(handler, { retry, profileId });
}

async function withSession(handler, { retry = false, profileId = null } = {}) {
  let current = await ensureSession(profileId);
  let release = sessionRegistry.acquire(current);
  try {
    return await handler(current.session);
  } catch (error) {
    if (retry && isConnectionError(error)) {
      if (openSessions.get(current.profileId) !== current) throw error;
      current.session.dead = true;
      release();
      current = await openSession(current.profileId, activeSession === current, {}, current);
      release = sessionRegistry.acquire(current);
      return await handler(current.session);
    }
    throw error;
  } finally { release(); }
}

handle('clipboard:write-text', async (text) => {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 32 * 1024 * 1024) {
    throw new Error('Nội dung sao chép không hợp lệ hoặc vượt quá 32 MB. Hãy xuất ra tệp nếu dữ liệu lớn hơn.');
  }
  await clipboard.writeText(text);
  return { written: true };
});
handle('clipboard:read-text', async () => {
  const text = await clipboard.readText();
  if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw new Error('Nội dung clipboard vượt quá 32 MB.');
  return text;
});

handle('app:metadata', () => ({
  name: app.getName(),
  version: app.getVersion(),
  platform: process.platform
}));
handle('state:load', async () => {
  const value = await readJson('renderer-state.json', {});
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
});
handle('state:save', (value) => {
  writeJson('renderer-state.json', validateState(value));
  return { saved: true };
});

handle('file:save-text', async (payload) => {
  if (!payload || typeof payload !== 'object' || typeof payload.contents !== 'string'
    || typeof payload.suggestedName !== 'string') {
    throw new Error('Yêu cầu lưu tệp không hợp lệ.');
  }
  if (Buffer.byteLength(payload.contents) > MAX_EXPORT_BYTES) {
    throw new Error('Tệp xuất vượt quá giới hạn 50 MB.');
  }
  const safeName = path.basename(payload.suggestedName).replace(/[<>:"/\\|?*]/g, '_').slice(0, 160) || 'sqlpro-export.txt';
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Xuất dữ liệu',
    defaultPath: safeName,
    filters: validateDialogFilters(payload.filters)
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.promises.writeFile(result.filePath, payload.contents, 'utf8');
  return { canceled: false, filePath: result.filePath };
});

handle('file:open-json', async () => {
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

handle('file:open-text', async (payload) => {
  if (!payload || typeof payload !== 'object') throw new Error('Tham số mở tệp không hợp lệ.');
  const filters = validateDialogFilters(payload.filters);
  const result = await dialog.showOpenDialog(mainWindow, {
    title: typeof payload.title === 'string' ? payload.title.slice(0, 120) : 'Chọn tệp dữ liệu',
    properties: ['openFile'],
    filters: filters && filters.length
      ? filters
      : [{ name: 'Tệp dữ liệu', extensions: ['csv', 'tsv', 'txt', 'json', 'sql'] }]
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  const filePath = result.filePaths[0];
  const stat = await fs.promises.stat(filePath);
  if (stat.size > MAX_IMPORT_BYTES) throw new Error('Tệp nhập vượt quá giới hạn 20 MB.');
  return { canceled: false, filePath, contents: await fs.promises.readFile(filePath, 'utf8') };
});

handle('connections:list', () => store.list());

handle('connections:save', async (payload) => {
  const saved = store.save(payload);
  if (payload?.id) await closeSession(payload.id);
  sync.schedule();
  return saved;
});

handle('connections:remove', async (id) => {
  await closeSession(id);
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
  if (imported.updated) await closeAllSessions();
  sync.schedule();
  return {
    canceled: false,
    filePath: result.filePaths[0],
    added: imported.added,
    updated: imported.updated,
    skipped: parsed.skipped,
    sessionsClosed: imported.updated > 0
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
  await sync.logout();
  await closeAllSessions();
  const { backupName } = store.resetLocalData();
  writeJson('renderer-state.json', {});
  return { backupName };
});

handle('account:sync-now', () => sync.syncNow());

handle('account:resolve-conflicts', (choices) => sync.resolveConflicts(choices));

handle('account:list-recovery', () => sync.listRecovery());

handle('account:restore-recovery', (id) => {
  if (typeof id !== 'string' || !id) throw new Error('Bản phục hồi không hợp lệ.');
  return sync.restoreRecovery(id);
});

handle('db:connect', async (profileId, options = {}) => {
  if (typeof profileId !== 'string' || !profileId) throw new Error('Kết nối không hợp lệ.');
  const sshHostKey = options && typeof options === 'object' ? options.sshHostKey : null;
  const cached = openSessions.get(profileId);
  let reused = Boolean(cached && !cached.session.dead && cached.session.connection && cached.databases);
  let current = await openSession(profileId, true, { sshHostKey });
  let release = sessionRegistry.acquire(current);
  try {
    let databases = reused ? current.databases : null;
    try {
      if (!databases) databases = await current.session.listDatabases();
    } catch (error) {
      if (!isConnectionError(error)) throw error;
      release();
      current = await openSession(profileId, true, { sshHostKey }, current);
      release = sessionRegistry.acquire(current);
      databases = await current.session.listDatabases();
      reused = false;
    }
    if (openSessions.get(profileId) !== current) throw Object.assign(new Error('Yêu cầu kết nối đã hết hiệu lực.'), { code: 'SESSION_OPEN_CANCELED' });
    current.databases = databases;
    return {
      profileId,
      server: current.session.version,
      databases,
      reused,
      openProfiles: [...openSessions.keys()]
    };
  } catch (error) {
    await closeSession(profileId, current);
    throw error;
  } finally { release(); }
});

handle('db:disconnect', async (profileId, options = {}) => {
  const target = typeof profileId === 'string' && profileId ? openSessions.get(profileId) : activeSession;
  if (target?.session.inTransaction && (!options || options.force !== true)) {
    return { disconnected: false, needsConfirmation: true, profileId: target.profileId };
  }
  if (typeof profileId === 'string' && profileId) await closeSession(profileId);
  else await closeActiveSession();
  return { disconnected: true, openProfiles: [...openSessions.keys()] };
});

handle('db:session-state', (profileId) => {
  const current = typeof profileId === 'string' && profileId ? openSessions.get(profileId) : activeSession;
  const session = current?.session;
  return {
    profileId: current?.profileId || null,
    connected: Boolean(session && !session.dead),
    inTransaction: Boolean(session?.inTransaction),
    autocommit: session?.autocommit !== false,
    tls: session?.tls || null
  };
});

handle('db:open-profiles', () => [...openSessions.entries()]
  .filter(([, current]) => !current.session.dead)
  .map(([profileId]) => profileId));

handle('db:databases', (payload) => {
  const profileId = payload && typeof payload === 'object' ? payload.profileId : null;
  return withSessionFor(profileId, async (session) => {
    const databases = await session.listDatabases();
    const current = [...openSessions.values()].find((entry) => entry.session === session);
    if (current) current.databases = databases;
    return databases;
  }, { retry: true });
});

handle('db:use-database', (payload) => {
  const profileId = payload && typeof payload === 'object' ? payload.profileId : null;
  const database = payload && typeof payload === 'object' ? payload.database : payload;
  if (typeof database !== 'string' || !database) throw new Error('Database không hợp lệ.');
  return withSessionFor(profileId, (session) => session.useDatabase(database), { retry: true });
});

handle('db:tables', (payload) => {
  const profileId = payload && typeof payload === 'object' ? payload.profileId : null;
  const database = payload && typeof payload === 'object' ? payload.database : payload;
  if (typeof database !== 'string' || !database) throw new Error('Database không hợp lệ.');
  return withSessionFor(profileId, (session) => session.listTables(database), { retry: true });
});

handle('db:columns', (payload, legacyTable) => {
  const profileId = payload && typeof payload === 'object' ? payload.profileId : null;
  const database = payload && typeof payload === 'object' ? payload.database : payload;
  const table = payload && typeof payload === 'object' ? payload.table : legacyTable;
  if (typeof database !== 'string' || typeof table !== 'string') throw new Error('Tham số không hợp lệ.');
  return withSessionFor(profileId, (session) => session.listColumns(database, table), { retry: true });
});

handle('db:indexes', (payload, legacyTable) => {
  const profileId = payload && typeof payload === 'object' ? payload.profileId : null;
  const database = payload && typeof payload === 'object' ? payload.database : payload;
  const table = payload && typeof payload === 'object' ? payload.table : legacyTable;
  if (typeof database !== 'string' || typeof table !== 'string') throw new Error('Tham số không hợp lệ.');
  return withSessionFor(profileId, (session) => session.listIndexes(database, table), { retry: true });
});

handle('db:relations', (payload, legacyTable) => {
  const profileId = payload && typeof payload === 'object' ? payload.profileId : null;
  const database = payload && typeof payload === 'object' ? payload.database : payload;
  const table = payload && typeof payload === 'object' ? payload.table : legacyTable;
  if (typeof database !== 'string' || typeof table !== 'string') throw new Error('Tham số không hợp lệ.');
  return withSessionFor(profileId, (session) => session.listRelations(database, table), { retry: true });
});

handle('db:routines', (payload) => {
  if (!payload || typeof payload.database !== 'string' || !payload.database) throw new Error('Chưa chọn database.');
  return withSessionFor(payload.profileId, (session) => session.listRoutines(payload.database), { retry: true });
});

handle('db:events', (payload) => {
  if (!payload || typeof payload.database !== 'string' || !payload.database) throw new Error('Chưa chọn database.');
  return withSessionFor(payload.profileId, (session) => session.listEvents(payload.database), { retry: true });
});

handle('db:show-create', (payload) => {
  if (!payload || typeof payload.database !== 'string' || typeof payload.name !== 'string') {
    throw new Error('Tham số SHOW CREATE không hợp lệ.');
  }
  return withSessionFor(payload.profileId, (session) => session.showCreate(payload.database, payload.name, payload.kind), { retry: true });
});

handle('db:table-data', (payload) => {
  if (!payload || typeof payload !== 'object') throw new Error('Tham số không hợp lệ.');
  return withSessionFor(payload.profileId, (session) => session.tableData(payload), { retry: true });
});

handle('db:table-count', (payload) => {
  if (!payload || typeof payload.database !== 'string' || typeof payload.table !== 'string') throw new Error('Tham số không hợp lệ.');
  return withSessionFor(payload.profileId, (session) => session.countTableRows(payload), { retry: true });
});

handle('db:query', (payload) => {
  if (!payload || typeof payload.sql !== 'string') throw new Error('Câu lệnh SQL không hợp lệ.');
  const database = typeof payload.database === 'string' && payload.database ? payload.database : null;
  return withSessionFor(payload.profileId, async (session) => {
    if (database) await session.useDatabase(database);
    return session.runQueryScript(
      payload.sql,
      Math.min(900000, Math.max(1000, Number(payload.timeoutMs) || 300000)),
      payload.confirmed === true,
      typeof payload.taskId === 'string' ? payload.taskId : null,
      { rowLimit: payload.rowLimit }
    );
  });
});

handle('db:cancel-query', (payload) => {
  const profileId = payload && typeof payload === 'object' ? payload.profileId : null;
  const taskId = payload && typeof payload === 'object' ? payload.taskId : null;
  const current = profileId ? openSessions.get(profileId) : activeSession;
  if (!current) return { canceled: false, reason: 'no-session' };
  const canceled = current.session.cancelTask(taskId || null);
  return { canceled, reason: canceled ? 'canceled' : 'not-running' };
});

handle('db:cancel-task', (payload) => {
  const profileId = payload && typeof payload === 'object' ? payload.profileId : null;
  const taskId = payload && typeof payload === 'object' ? payload.taskId : null;
  if (!taskId) return { canceled: false, reason: 'invalid-task' };
  const active = activeDatabaseTransfer;
  if (!active || !profileId || active.profileId !== profileId || active.taskId !== taskId) {
    return { canceled: false, reason: 'not-running' };
  }
  const canceled = cancelDatabaseTransfer(active);
  return { canceled, reason: canceled ? 'canceled' : 'not-running' };
});

handle('db:insert-row', (payload) => {
  if (!payload || typeof payload !== 'object') throw new Error('Tham số không hợp lệ.');
  return withSessionFor(payload.profileId, (session) => session.insertRow(payload));
});

handle('db:update-row', (payload) => {
  if (!payload || typeof payload !== 'object') throw new Error('Tham số không hợp lệ.');
  return withSessionFor(payload.profileId, (session) => session.updateRow(payload));
});

handle('db:delete-rows', (payload) => {
  if (!payload || typeof payload !== 'object') throw new Error('Tham số không hợp lệ.');
  return withSessionFor(payload.profileId, (session) => session.deleteRows(payload));
});

handle('db:pick-import-file', async (payload) => {
  if (activeDatabaseTransfer) throw new Error('Một tác vụ database đang chạy. Hãy đợi tác vụ hoàn tất.');
  const requested = payload && typeof payload === 'object' && typeof payload.format === 'string' ? payload.format : '';
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Chọn tệp dữ liệu để nhập',
    properties: ['openFile'],
    filters: [
      { name: 'CSV/TSV', extensions: ['csv', 'tsv', 'tab'] },
      { name: 'JSON', extensions: ['json'] },
      { name: 'Tất cả tệp', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  const filePath = result.filePaths[0];
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error('Đường dẫn đã chọn không phải là tệp.');
  return {
    canceled: false,
    filePath,
    name: path.basename(filePath),
    size: stat.size,
    format: normalizeFileFormat(requested, filePath)
  };
});

handle('db:preview-import', async (payload) => {
  if (activeDatabaseTransfer) throw new Error('Một tác vụ database đang chạy. Hãy đợi tác vụ hoàn tất.');
  if (!payload || typeof payload !== 'object') throw new Error('Tham số không hợp lệ.');
  return previewImportFile(payload);
});

handle('db:export-file', async (payload) => {
  if (activeDatabaseTransfer) throw new Error('Một tác vụ database đang chạy. Hãy đợi tác vụ hoàn tất.');
  if (!payload || typeof payload !== 'object') throw new Error('Tham số không hợp lệ.');
  if (typeof payload.database !== 'string' || !payload.database) throw new Error('Chưa chọn database để xuất.');
  if (typeof payload.table !== 'string' || !payload.table) throw new Error('Chưa chọn bảng hoặc view để xuất.');
  const format = normalizeFileFormat(payload.format, payload.filePath);
  const extension = format === 'json' ? '.json' : format === 'tsv' ? '.tsv' : '.csv';
  const current = await ensureSession(payload.profileId);
  const profileId = current.profileId;
  const suggested = `${payload.database}.${payload.table}${extension}`.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 180);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Xuất dữ liệu ra tệp',
    defaultPath: suggested,
    filters: [
      format === 'json'
        ? { name: 'JSON', extensions: ['json'] }
        : format === 'tsv'
          ? { name: 'TSV', extensions: ['tsv'] }
          : { name: 'CSV', extensions: ['csv'] },
      { name: 'Tất cả tệp', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePath) return { canceled: true, dialog: true };
  let filePath = result.filePath;
  if (!filePath.toLowerCase().endsWith(extension)) filePath += extension;
  const taskId = typeof payload.taskId === 'string' && payload.taskId ? payload.taskId : null;
  claimDatabaseTransfer({ taskId, profileId, operation: 'export', database: payload.database, table: payload.table });
  try {
    const stats = await saveBackupFile(filePath, (write) =>
      withSessionFor(profileId, (session) => session.exportTableFile({
        database: payload.database,
        table: payload.table,
        format,
        filePath,
        columns: payload.columns,
        filters: payload.filters,
        search: payload.search,
        searchColumn: payload.searchColumn,
        searchMode: payload.searchMode,
        orderBy: payload.orderBy,
        taskId
      }, write, (progress) => sendDbProgress({
        ...progress,
        taskId,
        profileId,
        database: payload.database,
        table: payload.table
      }))));
    return { canceled: false, filePath, ...stats };
  } catch (error) {
    if (error && error.code === 'EXPORT_CANCELED') {
      return { canceled: true, filePath, ...(error.partial || {}) };
    }
    throw error;
  } finally {
    activeDatabaseTransfer = null;
  }
});

handle('db:export-query', async (payload) => {
  if (!payload || typeof payload !== 'object') throw new Error('Tham số không hợp lệ.');
  if (typeof payload.sql !== 'string' || !payload.sql.trim()) throw new Error('Câu lệnh SQL không hợp lệ.');
  if (typeof payload.taskId !== 'string' || !payload.taskId) throw new Error('Thiếu mã tác vụ xuất dữ liệu.');
  const format = payload.format === 'json' ? 'json' : 'csv';
  const extension = format === 'json' ? '.json' : '.csv';
  const database = typeof payload.database === 'string' && payload.database ? payload.database : null;
  const taskId = payload.taskId;
  const transfer = claimDatabaseTransfer({ taskId, profileId: payload.profileId || activeSession?.profileId, operation: 'export', database, pending: true });
  let filePath;
  try {
    const current = await ensureSession(payload.profileId);
    const profileId = current.profileId;
    transfer.profileId = profileId;
    if (transfer.canceled) return { canceled: true };
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Xuất toàn bộ kết quả truy vấn',
      defaultPath: `query-result${extension}`,
      filters: [
        format === 'json' ? { name: 'JSON', extensions: ['json'] } : { name: 'CSV', extensions: ['csv'] },
        { name: 'Tất cả tệp', extensions: ['*'] }
      ]
    });
    if (transfer.canceled) return { canceled: true };
    if (result.canceled || !result.filePath) return { canceled: true, dialog: true };
    filePath = result.filePath;
    if (!filePath.toLowerCase().endsWith(extension)) filePath += extension;
    const stats = await saveBackupFile(filePath, (write) =>
      withSessionFor(profileId, async (session) => {
        if (session.activeTask) throw new Error('Phiên kết nối đang chạy một tác vụ khác.');
        transfer.session = session;
        if (database) await session.useDatabase(database);
        if (transfer.canceled) throw Object.assign(new Error('Đã hủy xuất dữ liệu.'), { code: 'EXPORT_CANCELED' });
        transfer.pending = false;
        return session.exportQueryFile({ sql: payload.sql, format, filePath, taskId }, write, (progress) => sendDbProgress({
          ...progress,
          taskId,
          profileId,
          database
        }));
      }));
    return { canceled: false, filePath, ...stats };
  } catch (error) {
    if (error && error.code === 'EXPORT_CANCELED') {
      return { canceled: true, filePath, ...(error.partial || {}) };
    }
    throw error;
  } finally {
    if (activeDatabaseTransfer === transfer) activeDatabaseTransfer = null;
  }
});

handle('db:import-file', async (payload) => {
  if (activeDatabaseTransfer) throw new Error('Một tác vụ database đang chạy. Hãy đợi tác vụ hoàn tất.');
  if (!payload || typeof payload !== 'object') throw new Error('Tham số không hợp lệ.');
  if (typeof payload.database !== 'string' || !payload.database) throw new Error('Chưa chọn database đích.');
  if (typeof payload.table !== 'string' || !payload.table) throw new Error('Chưa chọn bảng đích.');
  if (typeof payload.filePath !== 'string' || !payload.filePath) throw new Error('Chưa chọn tệp để nhập.');
  const profileId = resolveProfileId(payload.profileId);
  const format = normalizeFileFormat(payload.format, payload.filePath);
  const taskId = typeof payload.taskId === 'string' && payload.taskId ? payload.taskId : null;
  const transfer = claimDatabaseTransfer({ taskId, profileId, operation: 'import', database: payload.database, table: payload.table, pending: true });
  let session;
  try {
    session = new DatabaseSession(runtimeProfile(store.getWithSecrets(profileId)));
    transfer.session = session;
    await session.connect();
    if (transfer.canceled) return { canceled: true };
    if (typeof session.prepareWorkerForImport === 'function') await session.prepareWorkerForImport();
    transfer.pending = false;
    const stats = await session.importFile({
      database: payload.database,
      table: payload.table,
      filePath: payload.filePath,
      format,
      delimiter: payload.delimiter,
      hasHeader: payload.hasHeader !== false,
      mapping: payload.mapping,
      mode: payload.mode,
      transaction: payload.transaction,
      allowNonTransactional: payload.allowNonTransactional === true,
      taskId
    }, (progress) => sendDbProgress({
      ...progress,
      taskId,
      profileId,
      database: payload.database,
      table: payload.table
    }));
    return { canceled: false, ...stats };
  } catch (error) {
    if (error && error.code === 'IMPORT_CANCELED') {
      return { canceled: true, ...(error.partial || {}) };
    }
    throw error;
  } finally {
    try { await session?.close(); }
    finally { if (activeDatabaseTransfer === transfer) activeDatabaseTransfer = null; }
  }
});

handle('db:backup', async (payload) => {
  if (activeDatabaseTransfer) throw new Error('Một tác vụ database đang chạy. Hãy đợi tác vụ hoàn tất.');
  if (!payload || typeof payload !== 'object') throw new Error('Tham số không hợp lệ.');
  if (typeof payload.database !== 'string' || !payload.database) throw new Error('Chưa chọn database để sao lưu.');
  const taskId = typeof payload.taskId === 'string' && payload.taskId ? payload.taskId : null;
  const requested = {
    database: payload.database,
    tables: Array.isArray(payload.tables) ? payload.tables.filter((name) => typeof name === 'string' && name) : null,
    routines: Array.isArray(payload.routines) ? payload.routines : [],
    events: Array.isArray(payload.events) ? payload.events : [],
    includeStructure: payload.includeStructure !== false,
    includeData: payload.includeData !== false,
    dropTables: payload.dropTables === true,
    stripDefiner: payload.stripDefiner === true,
    taskId
  };
  if (!requested.includeStructure && !requested.includeData) throw new Error('Hãy chọn cấu trúc hoặc dữ liệu để sao lưu.');
  const profileId = payload.profileId || activeSession?.profileId;
  if (!profileId) throw new Error('Chưa chọn kết nối để sao lưu.');
  const transfer = claimDatabaseTransfer({ taskId, profileId, operation: 'backup', pending: true });
  let session;
  try {
    session = new DatabaseSession(runtimeProfile(store.getWithSecrets(profileId)));
    transfer.session = session;
    await session.connect();
    if (transfer.canceled) return { canceled: true, id: null, filePath: null };
    const directory = backupDirectory(app.getPath('userData'), profileId, requested.database);
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    const id = backupName();
    const filePath = path.join(directory, id);
    const stats = await saveBackupFile(filePath, (write) => {
      if (transfer.canceled) throw Object.assign(new Error('Đã hủy sao lưu.'), { code: 'BACKUP_CANCELED' });
      transfer.pending = false;
      return session.backupDatabase(requested, write,
        (progress) => sendDbProgress({ ...progress, taskId, profileId, database: requested.database }));
    }, {
      appName: 'SqlPro',
      appVersion: typeof app.getVersion === 'function' ? app.getVersion() : null,
      source: { profileId, database: requested.database, serverVersion: session.version || null },
      selection: {
        includeStructure: requested.includeStructure,
        includeData: requested.includeData,
        dropTables: requested.dropTables,
        stripDefiner: requested.stripDefiner,
        tables: requested.tables || [],
        routines: requested.routines,
        events: requested.events
      }
    });
    return { canceled: false, id, filePath, ...stats };
  } catch (error) {
    if (error && error.code === 'BACKUP_CANCELED') {
      return { canceled: true, id: null, filePath: null, ...(error.partial || {}) };
    }
    throw error;
  } finally {
    try { await session?.close(); }
    finally { if (activeDatabaseTransfer === transfer) activeDatabaseTransfer = null; }
  }
});

handle('db:list-backups', async (payload, legacyDatabase) => {
  const database = payload && typeof payload === 'object' ? payload.database : (legacyDatabase || payload);
  const profileId = payload && typeof payload === 'object' ? payload.profileId : null;
  if (typeof database !== 'string' || !database) throw new Error('Chưa chọn database.');
  const current = await ensureSession(profileId);
  return listBackups(app.getPath('userData'), current.profileId, database);
});

handle('db:delete-backup', async (payload) => {
  if (activeDatabaseTransfer) throw new Error('Một tác vụ database đang chạy. Hãy đợi tác vụ hoàn tất.');
  if (!payload || typeof payload.database !== 'string' || !payload.database) throw new Error('Chưa chọn database.');
  const current = await ensureSession(payload.profileId);
  const filePath = await resolveBackup(app.getPath('userData'), current.profileId, payload.database, payload.id);
  await fs.promises.unlink(filePath);
  await fs.promises.rm(manifestPathFor(filePath), { force: true });
  return { deleted: true };
});

handle('db:verify-backup', async (payload) => {
  if (!payload || typeof payload.database !== 'string' || !payload.database) throw new Error('Chưa chọn database.');
  if (typeof payload.id !== 'string' || !payload.id) throw new Error('Chưa chọn bản sao lưu.');
  const current = await ensureSession(payload.profileId);
  return verifyBackup(app.getPath('userData'), current.profileId, payload.database, payload.id);
});

handle('db:export-backup', async (payload) => {
  if (!payload || typeof payload.database !== 'string' || !payload.database) throw new Error('Chưa chọn database.');
  const current = await ensureSession(payload.profileId);
  const source = await resolveBackup(app.getPath('userData'), current.profileId, payload.database, payload.id);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Xuất tệp SQL sao lưu',
    defaultPath: `${payload.database.replace(/[<>:"/\\|?*]/g, '_').slice(0, 80)}-${payload.id}`,
    filters: [{ name: 'SQL', extensions: ['sql'] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  if (path.resolve(result.filePath) === path.resolve(source)) return { canceled: false, filePath: source };
  await fs.promises.copyFile(source, result.filePath);
  return { canceled: false, filePath: result.filePath };
});

handle('db:show-backup-folder', async (payload) => {
  if (!payload || typeof payload.database !== 'string' || !payload.database) throw new Error('Chưa chọn database.');
  const current = await ensureSession(payload.profileId);
  const directory = backupDirectory(app.getPath('userData'), current.profileId, payload.database);
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  if (payload.id) {
    const filePath = await resolveBackup(app.getPath('userData'), current.profileId, payload.database, payload.id);
    shell.showItemInFolder(filePath);
  } else {
    const error = await shell.openPath(directory);
    if (error) throw new Error(error);
  }
  return { opened: true };
});

handle('db:restore', async (payload) => {
  if (activeDatabaseTransfer) throw new Error('Một tác vụ database đang chạy. Hãy đợi tác vụ hoàn tất.');
  if (!payload || typeof payload !== 'object') throw new Error('Tham số không hợp lệ.');
  if (typeof payload.database !== 'string' || !payload.database) throw new Error('Chưa chọn database đích để phục hồi.');
  const taskId = typeof payload.taskId === 'string' && payload.taskId ? payload.taskId : null;
  const targetProfileId = resolveProfileId(payload.targetProfileId || payload.profileId);
  const sourceProfileId = payload.sourceProfileId || targetProfileId;
  const sourceDatabase = payload.sourceDatabase || payload.database;
  const savedFile = payload.backupId
    ? await resolveBackup(app.getPath('userData'), sourceProfileId, sourceDatabase, payload.backupId)
    : null;
  const result = savedFile ? null : await dialog.showOpenDialog(mainWindow, {
    title: 'Phục hồi database từ tệp SQL',
    properties: ['openFile'],
    filters: [
      { name: 'SQL', extensions: ['sql'] },
      { name: 'Tất cả tệp', extensions: ['*'] }
    ]
  });
  if (result && (result.canceled || !result.filePaths.length)) return { canceled: true };
  const filePath = savedFile || result.filePaths[0];
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error('Đường dẫn phục hồi không phải là tệp.');
  const transfer = claimDatabaseTransfer({ taskId, profileId: targetProfileId, operation: 'restore', pending: true });
  let session;
  try {
    session = new DatabaseSession(runtimeProfile(store.getWithSecrets(targetProfileId)));
    transfer.session = session;
    await session.connect();
    if (transfer.canceled) return { canceled: true, filePath };
    if (typeof session.prepareWorkerForRestore === 'function') await session.prepareWorkerForRestore();
    transfer.pending = false;
    const stats = await session.restoreDatabase({
      database: payload.database,
      filePath,
      dropExisting: payload.dropExisting === true,
      createDatabaseIfNotExists: payload.createDatabaseIfNotExists === true,
      taskId
    }, (progress) => sendDbProgress({
      ...progress,
      taskId,
      profileId: targetProfileId,
      database: payload.database
    }));
    let copiedBackup = null;
    if (payload.backupId && payload.copyToTargetCatalog && (sourceDatabase !== payload.database || sourceProfileId !== targetProfileId)) {
      try {
        copiedBackup = await copyBackup(app.getPath('userData'), sourceProfileId, targetProfileId, sourceDatabase, payload.database, payload.backupId);
      } catch {
        // non-fatal
      }
    }
    return { canceled: false, filePath, copiedBackup, ...stats };
  } catch (error) {
    if (error && error.code === 'RESTORE_CANCELED') {
      return { canceled: true, filePath, ...(error.partial || {}) };
    }
    throw error;
  } finally {
    try { await session?.close(); }
    finally { if (activeDatabaseTransfer === transfer) activeDatabaseTransfer = null; }
  }
});

handle('db:copy-backup', async (payload) => {
  if (!payload || typeof payload !== 'object') throw new Error('Tham số không hợp lệ.');
  if (typeof payload.sourceDatabase !== 'string' || !payload.sourceDatabase) throw new Error('Chưa chọn database nguồn.');
  if (typeof payload.targetDatabase !== 'string' || !payload.targetDatabase) throw new Error('Chưa chọn database đích.');
  if (typeof payload.id !== 'string' || !payload.id) throw new Error('Chưa chọn bản sao lưu.');
  const current = await ensureSession(payload.profileId || payload.sourceProfileId);
  const sourceProfileId = payload.sourceProfileId || current.profileId;
  const targetProfileId = payload.targetProfileId || payload.profileId || current.profileId;
  return copyBackup(app.getPath('userData'), sourceProfileId, targetProfileId, payload.sourceDatabase, payload.targetDatabase, payload.id);
});

app.whenReady().then(() => {
  buildMenu();
  sync.init({ notify: syncNotifier() });
  createWindow();
  sync.startup().catch(() => undefined);
});

app.on('before-quit', (event) => {
  if (!isQuitting && activeDatabaseTransfer && !confirmStopActiveTransfer()) {
    event.preventDefault();
    return;
  }
  if (!isQuitting && !activeDatabaseTransfer && activeTransactions().length && !confirmActiveTransactions('thoát')) {
    event.preventDefault();
    return;
  }
  isQuitting = true;
  sync.shutdown();
  sessionRegistry.closeAll().catch(() => undefined);
  activeSession = null;
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && !isQuitting) createWindow();
});
