'use strict';

const { app, safeStorage } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_WORKSPACE_ID,
  STORE_VERSION,
  defaultWorkspace,
  normalizeStore,
  normalizeVault,
  fingerprint
} = require('./store-schema.cjs');

function storePath() {
  return path.join(app.getPath('userData'), 'connections.json');
}

function keyPath() {
  return path.join(app.getPath('userData'), '.connections-key');
}

function readStoreError(message, cause) {
  const error = new Error(message);
  error.code = 'STORE_READ_FAILED';
  if (cause && cause.code) error.causeCode = String(cause.code);
  return error;
}

function validateStoredShape(parsed) {
  const invalid = () => { throw readStoreError('Tệp cấu hình kết nối không đúng cấu trúc hoặc phiên bản chưa được hỗ trợ. Dữ liệu hiện có được giữ nguyên.'); };
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(parsed)) invalid();
  if (parsed.version !== undefined && ![1, STORE_VERSION].includes(parsed.version)) invalid();
  if (!Array.isArray(parsed.connections)) invalid();
  const unique = (entries, valid, key) => {
    const seen = new Set();
    for (const entry of entries) {
      if (!valid(entry)) invalid();
      const id = key(entry);
      if (seen.has(id)) invalid();
      seen.add(id);
    }
  };
  unique(parsed.connections, (entry) => object(entry) && typeof entry.id === 'string' && Boolean(entry.id)
    && (entry.workspaceId === undefined || (typeof entry.workspaceId === 'string' && Boolean(entry.workspaceId))), (entry) => entry.id);
  for (const name of ['workspaces', 'tombstones']) {
    if (parsed[name] !== undefined && !Array.isArray(parsed[name])) invalid();
    if (parsed.version === STORE_VERSION && parsed[name] === undefined) invalid();
  }
  unique(parsed.workspaces || [], (entry) => object(entry) && typeof entry.id === 'string'
    && /^[A-Za-z0-9_-]{1,80}$/.test(entry.id), (entry) => entry.id);
  unique(parsed.tombstones || [], (entry) => object(entry) && ['connection', 'workspace'].includes(entry.type)
    && typeof entry.id === 'string' && /^[^\s]{1,120}$/.test(entry.id), (entry) => `${entry.type}:${entry.id}`);
  if (parsed.meta !== undefined && !object(parsed.meta)) invalid();
  if (parsed.workspaces) {
    const ids = new Set([DEFAULT_WORKSPACE_ID, ...parsed.workspaces.map((entry) => entry.id)]);
    if (parsed.connections.some((entry) => entry.workspaceId && !ids.has(entry.workspaceId))) invalid();
  }
}

function readStore() {
  let source;
  try {
    source = fs.readFileSync(storePath(), 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return normalizeStore({});
    throw readStoreError(
      'Không đọc được tệp cấu hình kết nối. Dữ liệu hiện có được giữ nguyên để tránh ghi đè.',
      error
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw readStoreError(
      'Tệp cấu hình kết nối bị hỏng nên không thể đọc. Dữ liệu hiện có được giữ nguyên để tránh ghi đè.',
      error
    );
  }
  validateStoredShape(parsed);
  const needsMigration = parsed.version !== STORE_VERSION
    || !Array.isArray(parsed.workspaces)
    || !Array.isArray(parsed.tombstones)
    || (Array.isArray(parsed.connections) && parsed.connections.some((entry) => !entry.workspaceId));
  const normalized = normalizeStore(parsed);
  if (needsMigration) writeStore(normalized);
  return normalized;
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  const temporary = `${storePath()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(normalizeStore(store), null, 2), {
    encoding: 'utf8',
    mode: 0o600
  });
  fs.renameSync(temporary, storePath());
}

function resetLocalData() {
  let backupName = null;
  if (fs.existsSync(storePath())) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backupName = `connections-backup-${stamp}.json`;
    const backupPath = path.join(app.getPath('userData'), backupName);
    fs.copyFileSync(storePath(), backupPath);
    try {
      fs.chmodSync(backupPath, 0o600);
    } catch {
      // permissions are best effort on filesystems without chmod support
    }
  }
  writeStore(normalizeStore({}));
  return { backupName };
}

function safeStorageAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function secretError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause && cause.code) error.causeCode = String(cause.code);
  return error;
}

function hasLocalSecrets() {
  const profiles = readStore().connections;
  if (profiles.some((profile) => [profile.password, profile.sshPassword, profile.sshPassphrase, profile.ssl?.passphrase]
    .some((secret) => secret?.alg === 'local'))) return true;
  try {
    const session = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'sync-session.json'), 'utf8'));
    return [session.tokenSealed, session.vaultKeySealed].some((secret) => secret?.alg === 'local');
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw secretError('LOCAL_KEY_READ_FAILED', 'Không kiểm tra được dữ liệu mã hóa hiện có. Khóa và dữ liệu được giữ nguyên.', error);
  }
}

function localKey(create = false) {
  try {
    const stored = fs.readFileSync(keyPath(), 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(stored)) return Buffer.from(stored, 'hex');
    throw secretError('LOCAL_KEY_INVALID', 'Khóa mã hóa local không hợp lệ. Hãy khôi phục .connections-key từ bản sao lưu; dữ liệu được giữ nguyên.');
  } catch (error) {
    if (error.code === 'LOCAL_KEY_INVALID') throw error;
    if (error.code !== 'ENOENT') {
      throw secretError('LOCAL_KEY_READ_FAILED', 'Không đọc được khóa mã hóa local. Hãy kiểm tra quyền truy cập và thử lại; dữ liệu được giữ nguyên.', error);
    }
    if (!create || hasLocalSecrets()) {
      throw secretError('LOCAL_KEY_MISSING', 'Thiếu khóa mã hóa local. Hãy khôi phục .connections-key từ bản sao lưu trước khi dùng dữ liệu mã hóa.');
    }
  }
  const key = crypto.randomBytes(32);
  try {
    fs.mkdirSync(path.dirname(keyPath()), { recursive: true });
    fs.writeFileSync(keyPath(), key.toString('hex'), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') return localKey();
    throw secretError('LOCAL_KEY_WRITE_FAILED', 'Không tạo được khóa mã hóa local. Chưa lưu dữ liệu mới.', error);
  }
  return key;
}

function seal(secret) {
  if (secret === undefined || secret === null || secret === '') return null;
  const value = String(secret);
  if (safeStorageAvailable()) {
    try {
      return { alg: 'safeStorage', data: safeStorage.encryptString(value).toString('base64') };
    } catch {
      // fall through to local encryption
    }
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', localKey(true), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    alg: 'local',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64')
  };
}

function unseal(sealed) {
  if (sealed === null || sealed === undefined) return '';
  try {
    if (sealed.alg === 'safeStorage') {
      return safeStorage.decryptString(Buffer.from(sealed.data, 'base64'));
    }
    if (sealed.alg === 'local') {
      const decipher = crypto.createDecipheriv('aes-256-gcm', localKey(), Buffer.from(sealed.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(sealed.data, 'base64')),
        decipher.final()
      ]).toString('utf8');
    }
  } catch (error) {
    if (String(error.code || '').startsWith('LOCAL_KEY_')) throw error;
    throw secretError('SECRET_DECRYPT_FAILED', 'Không giải mã được thông tin bí mật. Hãy khôi phục khóa hoặc quyền truy cập kho khóa hệ điều hành; dữ liệu được giữ nguyên.', error);
  }
  throw secretError('SECRET_DECRYPT_FAILED', 'Định dạng thông tin bí mật không được hỗ trợ. Dữ liệu được giữ nguyên.');
}

function text(value, maxLength) {
  return String(value === undefined || value === null ? '' : value).trim().slice(0, maxLength);
}

function port(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
}

function normalizeSsl(input) {
  const ssl = input && typeof input === 'object' ? input : {};
  return {
    enabled: Boolean(ssl.enabled),
    verify: ssl.verify === undefined ? false : Boolean(ssl.verify),
    ca: text(ssl.ca, 1024),
    cert: text(ssl.cert, 1024),
    key: text(ssl.key, 1024)
  };
}

function normalizeKnownSshHostKey(input) {
  if (!input || typeof input !== 'object') return null;
  const host = text(input.host, 255).toLowerCase();
  const fingerprint = text(input.fingerprint, 256);
  if (!host || !fingerprint) return null;
  return { host, port: port(input.port, 22), fingerprint };
}

function normalizeSsh(input, existing) {
  const ssh = input && typeof input === 'object' ? input : {};
  return {
    enabled: Boolean(ssh.enabled),
    host: text(ssh.host, 255),
    port: port(ssh.port, 22),
    user: text(ssh.user, 128),
    authMethod: ssh.authMethod === 'key' ? 'key' : 'password',
    privateKeyPath: text(ssh.privateKeyPath, 1024),
    knownHostKey: ssh.knownHostKey === undefined
      ? normalizeKnownSshHostKey(existing && existing.knownHostKey)
      : normalizeKnownSshHostKey(ssh.knownHostKey)
  };
}

function workspaceIds(store) {
  return new Set(store.workspaces.map((workspace) => workspace.id));
}

function normalizeProfile(input, existing, store) {
  if (!input || typeof input !== 'object') throw new Error('Thông tin kết nối không hợp lệ.');
  const host = text(input.host, 255);
  if (!host) throw new Error('Host không được để trống.');
  const ssh = normalizeSsh(input.ssh, existing && existing.ssh);
  if (ssh.enabled && !ssh.host) throw new Error('SSH host không được để trống.');
  const type = input.type === 'mariadb' ? 'mariadb' : 'mysql';
  const ssl = normalizeSsl(input.ssl);
  const allowCleartextPassword = input.allowCleartextPassword === true;
  const sshToLocalMysql = ssh.enabled && ['localhost', '127.0.0.1', '::1'].includes(host.toLowerCase());
  if (allowCleartextPassword && !(ssl.enabled && ssl.verify) && !sshToLocalMysql) {
    throw new Error('mysql_clear_password yêu cầu TLS đã xác thực hoặc SSH tunnel tới MySQL trên chính máy SSH (host localhost/127.0.0.1/::1).');
  }
  ssl.passphrase = input.ssl && input.ssl.passphrase !== undefined
    ? seal(input.ssl.passphrase)
    : (existing && existing.ssl ? existing.ssl.passphrase : null);
  const password = input.password === undefined
    ? (existing ? existing.password : null)
    : seal(input.password);
  const sshPassword = input.sshPassword === undefined
    ? (existing ? existing.sshPassword : null)
    : seal(input.sshPassword);
  const sshPassphrase = input.sshPassphrase === undefined
    ? (existing ? existing.sshPassphrase : null)
    : seal(input.sshPassphrase);
  const requestedWorkspace = text(input.workspaceId, 80)
    || (existing && existing.workspaceId)
    || DEFAULT_WORKSPACE_ID;
  const knownWorkspaces = workspaceIds(store);
  const workspaceId = knownWorkspaces.has(requestedWorkspace) ? requestedWorkspace : DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  return {
    id: existing ? existing.id : crypto.randomUUID(),
    workspaceId,
    name: text(input.name, 120) || `${text(input.user, 128) || 'root'}@${host}`,
    type,
    host,
    port: port(input.port, 3306),
    user: text(input.user, 128),
    database: text(input.database, 128),
    allowCleartextPassword,
    ssl,
    ssh,
    password,
    sshPassword,
    sshPassphrase,
    source: input.source === 'navicat' ? 'navicat' : (existing ? existing.source : 'manual'),
    importKey: input.importKey === undefined
      ? (existing ? existing.importKey : null)
      : (text(input.importKey, 512) || null),
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now
  };
}

function sanitize(profile) {
  return {
    id: profile.id,
    workspaceId: profile.workspaceId || DEFAULT_WORKSPACE_ID,
    name: profile.name,
    type: profile.type,
    host: profile.host,
    port: profile.port,
    user: profile.user,
    database: profile.database,
    allowCleartextPassword: profile.allowCleartextPassword === true,
    ssl: { enabled: profile.ssl.enabled, verify: profile.ssl.verify, ca: profile.ssl.ca, cert: profile.ssl.cert, key: profile.ssl.key },
    ssh: {
      enabled: profile.ssh.enabled,
      host: profile.ssh.host,
      port: profile.ssh.port,
      user: profile.ssh.user,
      authMethod: profile.ssh.authMethod,
      privateKeyPath: profile.ssh.privateKeyPath,
      knownHostKey: profile.ssh.knownHostKey || null
    },
    hasPassword: Boolean(profile.password),
    hasSslPassphrase: Boolean(profile.ssl.passphrase),
    hasSshPassword: Boolean(profile.sshPassword),
    hasSshPassphrase: Boolean(profile.sshPassphrase),
    source: profile.source,
    updatedAt: profile.updatedAt
  };
}

function decryptProfile(profile) {
  return {
    ...profile,
    password: unseal(profile.password),
    sshPassword: unseal(profile.sshPassword),
    sshPassphrase: unseal(profile.sshPassphrase),
    ssl: {
      ...profile.ssl,
      passphrase: unseal(profile.ssl.passphrase)
    }
  };
}

function sealProfile(profile) {
  const {
    hasPassword,
    hasSslPassphrase,
    hasSshPassword,
    hasSshPassphrase,
    ...rest
  } = profile;
  const ssl = rest.ssl && typeof rest.ssl === 'object' ? { ...rest.ssl } : {};
  const ssh = rest.ssh && typeof rest.ssh === 'object' ? { ...rest.ssh } : {};
  delete ssh.password;
  ssl.passphrase = seal(ssl.passphrase);
  rest.ssl = ssl;
  rest.ssh = ssh;
  rest.password = seal(rest.password);
  rest.sshPassword = seal(rest.sshPassword);
  rest.sshPassphrase = seal(rest.sshPassphrase);
  return rest;
}

function list() {
  return readStore().connections.map(sanitize);
}

function save(input) {
  const store = readStore();
  const existing = input && input.id
    ? store.connections.find((profile) => profile.id === input.id)
    : null;
  if (input && input.id && !existing) throw new Error('Không tìm thấy kết nối cần cập nhật.');
  const profile = normalizeProfile(input, existing, store);
  if (existing) {
    const index = store.connections.indexOf(existing);
    store.connections[index] = profile;
  } else {
    store.connections.push(profile);
  }
  writeStore(store);
  return sanitize(profile);
}

function trustSshHostKey(id, knownHostKey) {
  const store = readStore();
  const profile = store.connections.find((entry) => entry.id === id);
  if (!profile) throw new Error('Không tìm thấy kết nối.');
  const normalized = normalizeKnownSshHostKey(knownHostKey);
  if (!normalized) throw new Error('SSH host key không hợp lệ.');
  if (normalized.host !== String(profile.ssh.host || '').trim().toLowerCase()
    || normalized.port !== Number(profile.ssh.port || 22)) {
    throw new Error('SSH host key không khớp host/port hiện tại của kết nối.');
  }
  profile.ssh.knownHostKey = normalized;
  profile.updatedAt = new Date().toISOString();
  writeStore(store);
  return sanitize(profile);
}

function remove(id) {
  const store = readStore();
  const existing = store.connections.find((profile) => profile.id === id);
  if (!existing) throw new Error('Không tìm thấy kết nối cần xóa.');
  const now = new Date().toISOString();
  store.connections = store.connections.filter((profile) => profile.id !== id);
  store.tombstones = [
    ...store.tombstones.filter((entry) => !(entry.type === 'connection' && entry.id === id)),
    { type: 'connection', id, updatedAt: now }
  ];
  writeStore(store);
}

function getWithSecrets(id) {
  const profile = readStore().connections.find((entry) => entry.id === id);
  if (!profile) throw new Error('Không tìm thấy kết nối.');
  return decryptProfile(profile);
}

function importMany(imported, targetWorkspaceId) {
  const store = readStore();
  const workspaceId = workspaceIds(store).has(targetWorkspaceId)
    ? targetWorkspaceId
    : DEFAULT_WORKSPACE_ID;
  let added = 0;
  let updated = 0;
  for (const input of imported) {
    const importKey = input.importKey;
    const existing = importKey
      ? store.connections.find((profile) => profile.importKey === importKey)
      : null;
    const sshPassword = input.sshPassword !== undefined ? input.sshPassword : input.ssh?.password;
    const sshPassphrase = input.sshPassphrase !== undefined ? input.sshPassphrase : input.ssh?.passphrase;
    const payload = {
      ...input,
      workspaceId,
      password: input.password || undefined,
      sshPassword: sshPassword || undefined,
      sshPassphrase: sshPassphrase || undefined,
      ssl: input.ssl
        ? { ...input.ssl, passphrase: input.ssl.passphrase || undefined }
        : input.ssl
    };
    const profile = normalizeProfile(payload, existing, store);
    profile.source = 'navicat';
    profile.importKey = importKey || null;
    if (existing) {
      store.connections[store.connections.indexOf(existing)] = profile;
      updated += 1;
    } else {
      store.connections.push(profile);
      added += 1;
    }
  }
  writeStore(store);
  return { added, updated, connections: store.connections.map(sanitize) };
}

function listWorkspaces() {
  const store = readStore();
  return store.workspaces.map((workspace) => ({
    ...workspace,
    isDefault: workspace.id === DEFAULT_WORKSPACE_ID,
    connectionCount: store.connections.filter((profile) => profile.workspaceId === workspace.id).length
  }));
}

function saveWorkspace(input) {
  if (!input || typeof input !== 'object') throw new Error('Workspace không hợp lệ.');
  const store = readStore();
  const existing = input.id
    ? store.workspaces.find((workspace) => workspace.id === input.id)
    : null;
  if (input.id && !existing) throw new Error('Không tìm thấy workspace cần cập nhật.');
  if (existing && existing.id === DEFAULT_WORKSPACE_ID) {
    throw new Error('Không thể đổi tên workspace mặc định.');
  }
  const name = text(input.name, 80);
  if (!name) throw new Error('Tên workspace không được để trống.');
  const duplicate = store.workspaces.find((workspace) => (
    workspace.id !== (existing ? existing.id : '')
    && workspace.name.toLowerCase() === name.toLowerCase()
  ));
  if (duplicate) throw new Error('Tên workspace đã tồn tại.');
  const now = new Date().toISOString();
  const workspace = existing
    ? {
        ...existing,
        name,
        description: text(input.description, 500),
        updatedAt: now
      }
    : {
        id: crypto.randomUUID(),
        name,
        description: text(input.description, 500),
        createdAt: now,
        updatedAt: now
      };
  if (existing) {
    store.workspaces[store.workspaces.indexOf(existing)] = workspace;
  } else {
    store.workspaces.push(workspace);
  }
  writeStore(store);
  return {
    ...workspace,
    isDefault: workspace.id === DEFAULT_WORKSPACE_ID,
    connectionCount: store.connections.filter((profile) => profile.workspaceId === workspace.id).length
  };
}

function removeWorkspace(id) {
  const store = readStore();
  if (id === DEFAULT_WORKSPACE_ID) throw new Error('Không thể xóa workspace mặc định.');
  const existing = store.workspaces.find((workspace) => workspace.id === id);
  if (!existing) throw new Error('Không tìm thấy workspace cần xóa.');
  const now = new Date().toISOString();
  let moved = 0;
  for (const profile of store.connections) {
    if (profile.workspaceId === id) {
      profile.workspaceId = DEFAULT_WORKSPACE_ID;
      profile.updatedAt = now;
      moved += 1;
    }
  }
  store.workspaces = store.workspaces.filter((workspace) => workspace.id !== id);
  store.tombstones = [
    ...store.tombstones.filter((entry) => !(entry.type === 'workspace' && entry.id === id)),
    { type: 'workspace', id, updatedAt: now }
  ];
  writeStore(store);
  return { removed: true, moved, name: existing.name };
}

function snapshotForSync() {
  const store = readStore();
  return normalizeVault({
    version: 1,
    defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
    workspaces: store.workspaces,
    connections: store.connections.map((profile) => ({
      ...decryptProfile(profile),
      workspaceId: profile.workspaceId
    })),
    tombstones: store.tombstones
  });
}

function replaceFromSync(vault) {
  const current = readStore();
  const normalized = normalizeVault(vault);
  const next = {
    version: STORE_VERSION,
    workspaces: normalized.workspaces,
    connections: normalized.connections.map(sealProfile),
    tombstones: normalized.tombstones,
    meta: { ...current.meta }
  };
  writeStore(next);
  return {
    workspaces: next.workspaces.length,
    connections: next.connections.length,
    tombstones: next.tombstones.length
  };
}

function getMeta() {
  return { ...readStore().meta };
}

function setMeta(patch) {
  if (!patch || typeof patch !== 'object') throw new Error('Metadata không hợp lệ.');
  const store = readStore();
  store.meta = { ...store.meta, ...patch };
  writeStore(store);
  return { ...store.meta };
}

const SYNC_RECOVERY_LIMIT = 8;

function getSyncBase() {
  const sealed = readStore().meta.syncBaseSealed;
  if (!sealed) return null;
  try {
    const parsed = JSON.parse(unseal(sealed) || 'null');
    return parsed ? normalizeVault(parsed) : null;
  } catch {
    return null;
  }
}

function setSyncBase(vault, revision = null) {
  const store = readStore();
  const normalized = normalizeVault(vault);
  store.meta = {
    ...store.meta,
    syncBaseSealed: seal(JSON.stringify(normalized)),
    syncBaseAt: new Date().toISOString(),
    syncBaseRevision: Number.isInteger(revision) ? revision : (store.meta.syncBaseRevision ?? null)
  };
  writeStore(store);
  return { revision: store.meta.syncBaseRevision, at: store.meta.syncBaseAt };
}

function saveSyncRecovery(vault, reason = 'sync') {
  const normalized = normalizeVault(vault);
  const hash = fingerprint(normalized);
  const store = readStore();
  const entries = Array.isArray(store.meta.syncRecovery) ? [...store.meta.syncRecovery] : [];
  if (entries.at(-1)?.hash === hash) return null;
  const entry = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    reason: String(reason || 'sync').slice(0, 80),
    hash,
    sealed: seal(JSON.stringify(normalized))
  };
  entries.push(entry);
  store.meta = { ...store.meta, syncRecovery: entries.slice(-SYNC_RECOVERY_LIMIT) };
  writeStore(store);
  return { id: entry.id, at: entry.at, reason: entry.reason };
}

function listSyncRecovery() {
  const entries = readStore().meta.syncRecovery;
  return (Array.isArray(entries) ? entries : []).map(({ id, at, reason, hash }) => ({ id, at, reason, hash }));
}

function restoreSyncRecovery(id) {
  const entries = readStore().meta.syncRecovery;
  const entry = (Array.isArray(entries) ? entries : []).find((item) => item && item.id === id);
  if (!entry) throw new Error('Không tìm thấy bản phục hồi đồng bộ.');
  const parsed = JSON.parse(unseal(entry.sealed) || 'null');
  if (!parsed) throw new Error('Bản phục hồi đồng bộ không đọc được.');
  const result = replaceFromSync(parsed);
  return { restored: true, id, at: entry.at, reason: entry.reason, ...result };
}

function defaultWorkspaceInfo() {
  return defaultWorkspace();
}

module.exports = {
  DEFAULT_WORKSPACE_ID,
  STORE_VERSION,
  list,
  save,
  trustSshHostKey,
  remove,
  getWithSecrets,
  importMany,
  listWorkspaces,
  saveWorkspace,
  removeWorkspace,
  snapshotForSync,
  replaceFromSync,
  resetLocalData,
  getMeta,
  setMeta,
  getSyncBase,
  setSyncBase,
  saveSyncRecovery,
  listSyncRecovery,
  restoreSyncRecovery,
  defaultWorkspaceInfo,
  seal,
  unseal
};
