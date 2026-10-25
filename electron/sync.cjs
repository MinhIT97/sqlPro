'use strict';

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const store = require('./store.cjs');
const {
  normalizeEmail,
  deriveMasterKey,
  deriveAuthProof,
  deriveVaultKey,
  encryptVault,
  decryptVault,
  KDF_VERSION
} = require('./sync-crypto.cjs');
const { normalizeVault, fingerprint, mergeVaultsWithBase } = require('./store-schema.cjs');

const DEFAULT_SERVER_URL = process.env.SQLPRO_SYNC_URL || 'http://localhost:8080';
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const SESSION_FILE = 'sync-session.json';
const RETRY_DELAYS = [60_000, 300_000, 900_000];

let runtime = null;
let generation = 0;
let lifecycle = new AbortController();
let inflight = null;
let syncTimer = null;
let retryTimer = null;
let retryIndex = 0;
let pending = false;
let notifier = null;
let status = {
  loggedIn: false,
  email: '',
  serverUrl: '',
  revision: 0,
  lastSyncAt: null,
  remember: false,
  state: 'signed-out',
  error: null,
  conflicts: [],
  conflictCount: 0
};

function sessionPath() {
  return path.join(app.getPath('userData'), SESSION_FILE);
}

function makeError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function statusSnapshot() {
  return {
    ...status,
    cloudOwner: store.getMeta().cloudOwner || null,
    defaultServerUrl: DEFAULT_SERVER_URL
  };
}

function emitStatus() {
  if (notifier && notifier.status) notifier.status(statusSnapshot());
}

function setStatus(state, error = null) {
  status.state = state;
  status.error = error ? { code: error.code || '', message: error.message || String(error) } : null;
  emitStatus();
}

function emitApplied() {
  if (notifier && notifier.applied) notifier.applied({ at: new Date().toISOString() });
}

function clearTimer(timer) {
  if (timer) clearTimeout(timer);
  return null;
}

function normalizeServerUrl(value, allowInsecure) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw makeError('Địa chỉ server không hợp lệ.', 'INVALID_SERVER_URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw makeError('Server phải dùng HTTP hoặc HTTPS.', 'INVALID_SERVER_URL');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw makeError('Địa chỉ server không được chứa thông tin đăng nhập, query hoặc hash.', 'INVALID_SERVER_URL');
  }
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'http:' && !loopback && allowInsecure !== true) {
    throw makeError('Hãy dùng HTTPS hoặc xác nhận cho phép HTTP không an toàn.', 'INSECURE_SERVER');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${pathname}`;
}

function requestUrl(serverUrl, pathname) {
  return `${serverUrl}${pathname}`;
}

async function apiRequest(session, pathname, { method = 'GET', body, maxBytes = MAX_RESPONSE_BYTES, signal = session.signal } = {}) {
  let response;
  try {
    response = await fetch(requestUrl(session.serverUrl, pathname), {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(session.token ? { Authorization: `Bearer ${session.token}` } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
      redirect: 'error'
    });
  } catch {
    throw makeError('Không kết nối được tới server đồng bộ.', 'NETWORK_ERROR');
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) {
    throw makeError('Phản hồi từ server quá lớn.', 'RESPONSE_TOO_LARGE');
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw makeError('Phản hồi từ server quá lớn.', 'RESPONSE_TOO_LARGE');
  }
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw makeError('Server trả về dữ liệu không hợp lệ.', 'INVALID_SERVER_RESPONSE');
    }
  }
  if (!response.ok) {
    const error = makeError(
      (data && data.error && data.error.message) || `Server trả về lỗi ${response.status}.`,
      (data && data.error && data.error.code) || `HTTP_${response.status}`
    );
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function persistSession() {
  if (!runtime || !runtime.remember) return;
  const serialized = JSON.stringify({
    serverUrl: runtime.serverUrl,
    userId: runtime.userId,
    email: runtime.email,
    vaultSalt: runtime.vaultSalt,
    tokenSealed: store.seal(runtime.token),
    vaultKeySealed: store.seal(runtime.vaultKey.toString('base64url')),
    revision: runtime.revision,
    lastSyncAt: runtime.lastSyncAt,
    remember: true
  });
  const target = sessionPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, target);
}

function deleteSessionFile() {
  try {
    fs.unlinkSync(sessionPath());
  } catch {
    // missing session file
  }
}

function loadSession() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(sessionPath(), 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || parsed.remember !== true || typeof parsed.serverUrl !== 'string'
    || typeof parsed.userId !== 'string' || typeof parsed.email !== 'string'
    || typeof parsed.vaultSalt !== 'string') {
    deleteSessionFile();
    return null;
  }
  const token = store.unseal(parsed.tokenSealed);
  const vaultKeyValue = store.unseal(parsed.vaultKeySealed);
  const vaultKey = Buffer.from(vaultKeyValue || '', 'base64url');
  if (!token || vaultKey.length !== 32) {
    deleteSessionFile();
    return null;
  }
  return {
    serverUrl: parsed.serverUrl,
    userId: parsed.userId,
    email: parsed.email,
    vaultSalt: parsed.vaultSalt,
    token,
    vaultKey,
    revision: Number.isInteger(parsed.revision) ? parsed.revision : 0,
    lastSyncAt: typeof parsed.lastSyncAt === 'string' ? parsed.lastSyncAt : null,
    remember: true
  };
}

function applyRuntimeSession(session) {
  invalidateOperations();
  runtime = { ...session, signal: lifecycle.signal };
  status = {
    loggedIn: true,
    email: session.email,
    serverUrl: session.serverUrl,
    revision: session.revision,
    lastSyncAt: session.lastSyncAt,
    remember: session.remember,
    state: 'idle',
    error: null
  };
  return runtime;
}

function invalidateOperations() {
  generation += 1;
  lifecycle.abort();
  lifecycle = new AbortController();
  inflight = null;
  syncTimer = clearTimer(syncTimer);
  retryTimer = clearTimer(retryTimer);
  retryIndex = 0;
  pending = false;
}

function operation(session = runtime) {
  const version = generation;
  const signal = lifecycle.signal;
  return {
    session,
    signal,
    assertCurrent() {
      if (version !== generation || session !== runtime || signal.aborted) {
        throw makeError('Thao tác đồng bộ đã hết hiệu lực.', 'SYNC_CANCELED');
      }
    }
  };
}

function clearRuntime() {
  invalidateOperations();
  runtime = null;
  status = {
    loggedIn: false,
    email: '',
    serverUrl: '',
    revision: 0,
    lastSyncAt: null,
    remember: false,
    state: 'signed-out',
    error: null,
    conflicts: [],
    conflictCount: 0
  };
  emitStatus();
}

function assertAccount(userId) {
  const owner = store.getMeta().cloudOwner;
  if (owner && owner !== userId) {
    throw makeError(
      'Dữ liệu local đang thuộc một tài khoản khác. Hãy sao lưu rồi xóa dữ liệu local trước khi đổi tài khoản.',
      'SYNC_ACCOUNT_MISMATCH'
    );
  }
}

async function fetchServerMeta(serverUrl, allowInsecure, signal) {
  const normalized = normalizeServerUrl(serverUrl, allowInsecure);
  const meta = await apiRequest({ serverUrl: normalized }, '/api/meta', { maxBytes: 64 * 1024, signal });
  if (!meta || meta.kdfVersion !== KDF_VERSION || typeof meta.authContext !== 'string') {
    throw makeError('Server không hỗ trợ phiên bản đồng bộ này.', 'UNSUPPORTED_SERVER');
  }
  return { serverUrl: normalized, meta };
}

async function register({ email: rawEmail, password, serverUrl, allowInsecure }) {
  const email = normalizeEmail(rawEmail);
  if (!email) throw makeError('Email không hợp lệ.', 'INVALID_EMAIL');
  if (typeof password !== 'string' || password.length < 10) {
    throw makeError('Mật khẩu phải có ít nhất 10 ký tự.', 'WEAK_PASSWORD');
  }
  clearRuntime();
  const job = operation();
  const connection = await fetchServerMeta(serverUrl, allowInsecure, job.signal);
  job.assertCurrent();
  if (password.length < (connection.meta.minPasswordLength || 10)) {
    throw makeError(`Mật khẩu phải có ít nhất ${connection.meta.minPasswordLength} ký tự.`, 'WEAK_PASSWORD');
  }
  if (connection.meta.registrationAllowed === false) {
    throw makeError('Server này không mở đăng ký tài khoản.', 'REGISTRATION_DISABLED');
  }
  const masterKey = deriveMasterKey(password, email);
  const authProof = deriveAuthProof(masterKey, connection.meta.authContext);
  const result = await apiRequest({ serverUrl: connection.serverUrl }, '/api/auth/register', {
    method: 'POST',
    signal: job.signal,
    body: { email, authProof }
  });
  job.assertCurrent();
  if (!result || !result.token || !result.user || !result.vaultSalt) {
    throw makeError('Server trả về phản hồi đăng ký không hợp lệ.', 'INVALID_SERVER_RESPONSE');
  }
  assertAccount(result.user.id);
  const vaultKey = deriveVaultKey(masterKey, result.vaultSalt);
  applyRuntimeSession({
    serverUrl: connection.serverUrl,
    userId: result.user.id,
    email: result.user.email,
    vaultSalt: result.vaultSalt,
    token: result.token,
    vaultKey,
    revision: Number.isInteger(result.revision) ? result.revision : 0,
    lastSyncAt: null,
    remember: true
  });
  store.setMeta({ cloudOwner: result.user.id });
  try {
    persistSession();
  } catch {
    status.remember = false;
  }
  setStatus('idle');
  schedule(50);
  return statusSnapshot();
}

async function login({ email: rawEmail, password, serverUrl, allowInsecure, remember = true }) {
  const email = normalizeEmail(rawEmail);
  if (!email) throw makeError('Email không hợp lệ.', 'INVALID_EMAIL');
  if (typeof password !== 'string' || password.length === 0) {
    throw makeError('Mật khẩu không hợp lệ.', 'INVALID_CREDENTIALS');
  }
  clearRuntime();
  const job = operation();
  const connection = await fetchServerMeta(serverUrl, allowInsecure, job.signal);
  job.assertCurrent();
  const masterKey = deriveMasterKey(password, email);
  const authProof = deriveAuthProof(masterKey, connection.meta.authContext);
  const result = await apiRequest({ serverUrl: connection.serverUrl }, '/api/auth/login', {
    method: 'POST',
    signal: job.signal,
    body: { email, authProof }
  });
  job.assertCurrent();
  if (!result || !result.token || !result.user || !result.vaultSalt) {
    throw makeError('Server trả về phản hồi đăng nhập không hợp lệ.', 'INVALID_SERVER_RESPONSE');
  }
  assertAccount(result.user.id);
  const vaultKey = deriveVaultKey(masterKey, result.vaultSalt);
  applyRuntimeSession({
    serverUrl: connection.serverUrl,
    userId: result.user.id,
    email: result.user.email,
    vaultSalt: result.vaultSalt,
    token: result.token,
    vaultKey,
    revision: Number.isInteger(result.revision) ? result.revision : 0,
    lastSyncAt: null,
    remember: remember === true
  });
  store.setMeta({ cloudOwner: result.user.id });
  if (remember === true) {
    try {
      persistSession();
    } catch {
      status.remember = false;
    }
  } else {
    deleteSessionFile();
  }
  setStatus('idle');
  schedule(50);
  return statusSnapshot();
}

async function logout() {
  const current = runtime;
  clearRuntime();
  deleteSessionFile();
  if (current) {
    try {
      await apiRequest({ ...current, signal: undefined }, '/api/auth/logout', { method: 'POST', maxBytes: 64 * 1024 });
    } catch {
      // local logout succeeds even when the server is unreachable
    }
  }
  return statusSnapshot();
}

async function fetchRemoteVault(session) {
  const response = await apiRequest(session, '/api/vault');
  let vault = normalizeVault({});
  if (response && response.envelope) {
    const decrypted = decryptVault(response.envelope, session.vaultKey, session.userId);
    vault = normalizeVault(decrypted);
  }
  return {
    revision: response && Number.isInteger(response.revision) ? response.revision : 0,
    vault
  };
}

function saveRevision(revision) {
  if (!runtime) return;
  runtime.revision = revision;
  runtime.lastSyncAt = new Date().toISOString();
  status.revision = revision;
  status.lastSyncAt = runtime.lastSyncAt;
  try {
    persistSession();
  } catch {
    // keep the in-memory session usable
  }
}

function handleAuthFailure(error) {
  if (error && ['INVALID_TOKEN', 'SESSION_EXPIRED', 'UNAUTHORIZED', 'ACCOUNT_DISABLED'].includes(error.code)) {
    clearRuntime();
    deleteSessionFile();
    setStatus('reauth-required', error);
    return true;
  }
  return false;
}

function publishConflicts(result) {
  status.conflicts = Array.isArray(result.conflicts) ? result.conflicts : [];
  status.conflictCount = status.conflicts.filter((entry) => entry.requiresChoice).length;
}

function clearConflicts() {
  status.conflicts = [];
  status.conflictCount = 0;
}

function saveConflictSnapshots(localVault, remoteVault) {
  try { store.saveSyncRecovery(localVault, 'conflict-local'); } catch { /* recovery history is best-effort */ }
  try { store.saveSyncRecovery(remoteVault, 'conflict-remote'); } catch { /* recovery history is best-effort */ }
}

async function mergeWithRemote(session, job, choices) {
  const remote = await fetchRemoteVault(session);
  job.assertCurrent();
  const local = store.snapshotForSync();
  const result = mergeVaultsWithBase(local, remote.vault, store.getSyncBase(), { choices });
  return { remote, local, result };
}

function normalizeConflictChoices(input) {
  const choices = new Map();
  if (input instanceof Map) return input;
  const entries = Array.isArray(input)
    ? input
    : (input && typeof input === 'object'
      ? Object.entries(input).map(([connectionId, fields]) => ({ connectionId, fields }))
      : []);
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const connectionId = String(entry.connectionId || entry.id || '');
    if (!connectionId) continue;
    for (const [path, choice] of Object.entries(entry.fields || {})) {
      if (choice === 'local' || choice === 'remote') choices.set(`${connectionId}\u0000${path}`, choice);
    }
  }
  return choices;
}

async function runSync(choices = null) {
  if (!runtime) throw makeError('Chưa đăng nhập tài khoản đồng bộ.', 'NOT_LOGGED_IN');
  const job = operation();
  const session = job.session;
  setStatus('syncing');
  try {
    let { remote, local, result } = await mergeWithRemote(session, job, choices);
    publishConflicts(result);
    let merged = result.vault;
    if (fingerprint(merged) !== fingerprint(local)) {
      job.assertCurrent();
      store.replaceFromSync(merged);
      emitApplied();
    }
    if (result.conflicts.length) saveConflictSnapshots(local, remote.vault);

    let currentRevision = remote.revision;
    let remoteVault = remote.vault;
    for (let attempt = 0; result.requiresResolution || fingerprint(merged) !== fingerprint(remoteVault); attempt += 1) {
      if (result.requiresResolution) {
        saveRevision(currentRevision);
        setStatus('conflict');
        return statusSnapshot();
      }
      if (attempt >= 3) throw makeError('Không thể đồng bộ sau nhiều lần xung đột revision.', 'SYNC_CONFLICT_RETRY');
      job.assertCurrent();
      const envelope = encryptVault(merged, session.vaultKey, session.userId);
      try {
        const pushed = await apiRequest(session, '/api/vault', {
          method: 'PUT',
          body: { baseRevision: currentRevision, envelope },
          maxBytes: 64 * 1024
        });
        job.assertCurrent();
        currentRevision = pushed.revision;
        remoteVault = merged;
        break;
      } catch (error) {
        job.assertCurrent();
        if (error.code !== 'REVISION_CONFLICT' || attempt >= 2) throw error;
        remoteVault = error.data && error.data.envelope
          ? normalizeVault(decryptVault(error.data.envelope, session.vaultKey, session.userId))
          : normalizeVault({});
        currentRevision = Number.isInteger(error.data && error.data.revision)
          ? error.data.revision
          : currentRevision;
        result = mergeVaultsWithBase(store.snapshotForSync(), remoteVault, store.getSyncBase(), { choices });
        publishConflicts(result);
        merged = result.vault;
        if (fingerprint(merged) !== fingerprint(store.snapshotForSync())) {
          job.assertCurrent();
          store.replaceFromSync(merged);
          emitApplied();
        }
        if (result.conflicts.length) saveConflictSnapshots(store.snapshotForSync(), remoteVault);
      }
    }

    job.assertCurrent();
    store.setSyncBase(merged, currentRevision);
    clearConflicts();
    saveRevision(currentRevision);
    retryIndex = 0;
    setStatus('synced');
    if (pending) {
      pending = false;
      schedule(500);
    }
    return statusSnapshot();
  } catch (error) {
    job.assertCurrent();
    if (handleAuthFailure(error)) throw error;
    const offlineCodes = ['NETWORK_ERROR', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'HTTP_503', 'HTTP_502'];
    setStatus(offlineCodes.includes(error.code) ? 'offline' : 'error', error);
    if (offlineCodes.includes(error.code)) scheduleRetry();
    throw error;
  }
}

async function resolveConflicts(choices) {
  if (!runtime) throw makeError('Chưa đăng nhập tài khoản đồng bộ.', 'NOT_LOGGED_IN');
  const normalized = normalizeConflictChoices(choices);
  if (!normalized.size) throw makeError('Chưa chọn hướng xử lý xung đột.', 'SYNC_CHOICE_REQUIRED');
  return runSync(normalized);
}

function listRecovery() {
  return store.listSyncRecovery();
}

function restoreRecovery(id) {
  const result = store.restoreSyncRecovery(id);
  emitApplied();
  return result;
}

function syncNow() {
  if (!runtime) return Promise.reject(makeError('Chưa đăng nhập tài khoản đồng bộ.', 'NOT_LOGGED_IN'));
  if (inflight) {
    pending = true;
    return inflight;
  }
  pending = false;
  const task = runSync().finally(() => {
    if (inflight === task) inflight = null;
  });
  inflight = task;
  return task;
}

function schedule(delay = 2000) {
  if (!runtime) return;
  pending = true;
  syncTimer = clearTimer(syncTimer);
  retryTimer = clearTimer(retryTimer);
  if (status.state !== 'syncing') {
    status.state = 'pending';
    emitStatus();
  }
  syncTimer = setTimeout(() => {
    syncTimer = null;
    syncNow().catch(() => undefined);
  }, Math.max(0, delay));
}

function scheduleRetry() {
  if (!runtime || retryTimer) return;
  const delay = RETRY_DELAYS[Math.min(retryIndex, RETRY_DELAYS.length - 1)];
  retryIndex += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    syncNow().catch(() => undefined);
  }, delay);
}

async function startup() {
  let session;
  try { session = loadSession(); }
  catch (error) {
    clearRuntime();
    setStatus('error', error);
    return statusSnapshot();
  }
  if (!session) {
    clearRuntime();
    return statusSnapshot();
  }
  session = applyRuntimeSession(session);
  const job = operation(session);
  setStatus('idle');
  try {
    const info = await apiRequest(session, '/api/auth/me', { maxBytes: 64 * 1024 });
    job.assertCurrent();
    if (info && info.user) {
      runtime.email = info.user.email;
      runtime.vaultSalt = info.vaultSalt;
      runtime.revision = Number.isInteger(info.revision) ? info.revision : runtime.revision;
      status.email = runtime.email;
      status.revision = runtime.revision;
      if (typeof info.updatedAt === 'string' && !runtime.lastSyncAt) runtime.lastSyncAt = info.updatedAt;
      status.lastSyncAt = runtime.lastSyncAt;
    }
    persistSession();
    schedule(3000);
  } catch (error) {
    try { job.assertCurrent(); } catch { return statusSnapshot(); }
    if (handleAuthFailure(error)) return statusSnapshot();
    if (error.code === 'NETWORK_ERROR') {
      setStatus('offline', error);
      schedule(3000);
    } else {
      setStatus('error', error);
    }
  }
  return statusSnapshot();
}

function init(options = {}) {
  notifier = options.notify || null;
}

function shutdown() {
  invalidateOperations();
}

module.exports = {
  DEFAULT_SERVER_URL,
  init,
  startup,
  register,
  login,
  logout,
  status: statusSnapshot,
  syncNow,
  resolveConflicts,
  listRecovery,
  restoreRecovery,
  schedule,
  shutdown
};
