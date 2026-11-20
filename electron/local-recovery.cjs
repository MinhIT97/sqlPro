'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { createRecoveryKit, recoverMasterKey } = require('./recovery-kit.cjs');
const { encryptVault, decryptVault } = require('./sync-crypto.cjs');
const { normalizeVault, fingerprint } = require('./store-schema.cjs');

const MAX_VAULT_BYTES = 6 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 10 * 1024 * 1024;
const fail = (code, message) => Object.assign(new Error(message), { code });

function validateVault(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.connections) || value.connections.length > 2000
      || !Array.isArray(value.workspaces) || value.workspaces.length > 2000
      || !Array.isArray(value.tombstones) || value.tombstones.length > 10000
      || Buffer.byteLength(JSON.stringify(value)) > MAX_VAULT_BYTES) throw fail('RECOVERY_VAULT_INVALID', 'Kho phục hồi lỗi, khác phiên bản hoặc vượt hạn mức.');
  const result = normalizeVault(value);
  if (result.connections.length !== value.connections.length || result.workspaces.length !== value.workspaces.length
      || result.tombstones.length !== value.tombstones.length) throw fail('RECOVERY_VAULT_INVALID', 'Kho phục hồi có phần tử trùng hoặc không hợp lệ.');
  const groups = new Set(result.workspaces.map(item => item.id));
  if (value.connections.some(item => !groups.has(item.workspaceId))) throw fail('RECOVERY_VAULT_INVALID', 'Kết nối phục hồi thiếu workspace.');
  return result;
}

function createLocalRecovery(vault, email = 'offline') {
  const normalized = validateVault(vault), key = crypto.randomBytes(32);
  try {
    const { recoveryKey, kitData } = createRecoveryKit({ masterKey: key, userEmail: email || 'offline' });
    const id = crypto.randomUUID(), createdAt = new Date().toISOString();
    const envelope = encryptVault({ version: 1, kind: 'sqlpro-local-recovery-payload', id, createdAt,
      email: kitData.userEmail, vault: normalized }, key, id);
    const bundle = { version: 1, kind: 'sqlpro-local-recovery-bundle', id, createdAt, email: kitData.userEmail, kitData, envelope };
    return { bundle, recoveryKey, connections: normalized.connections.length, workspaces: normalized.workspaces.length };
  } finally { key.fill(0); }
}

function openLocalRecovery(bundle, recoveryKey) {
  if (!bundle || bundle.kind !== 'sqlpro-local-recovery-bundle' || bundle.version !== 1
      || typeof bundle.id !== 'string' || !/^[a-f0-9-]{36}$/.test(bundle.id)
      || typeof bundle.createdAt !== 'string' || bundle.createdAt.length > 40
      || typeof bundle.email !== 'string' || bundle.email.length > 254
      || typeof bundle.envelope !== 'string' || bundle.envelope.length > MAX_BUNDLE_BYTES) {
    throw fail('RECOVERY_BUNDLE_INVALID', 'Tệp không phải bộ phục hồi cục bộ được hỗ trợ.');
  }
  let key;
  try {
    key = recoverMasterKey({ recoveryKey, kitData: bundle.kitData });
    const payload = decryptVault(bundle.envelope, key, bundle.id);
    if (payload.kind !== 'sqlpro-local-recovery-payload' || payload.version !== 1 || payload.id !== bundle.id
        || payload.email !== bundle.email || payload.email !== bundle.kitData.userEmail || payload.createdAt !== bundle.createdAt) {
      throw new Error('Recovery scope mismatch');
    }
    return validateVault(payload.vault);
  } catch { throw fail('RECOVERY_UNLOCK_FAILED', 'Mã khôi phục sai hoặc tệp bị hỏng/không được hỗ trợ. Chưa thay đổi dữ liệu.'); }
  finally { key?.fill(0); }
}

async function readLocalRecovery(filePath) {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.size > MAX_BUNDLE_BYTES) throw fail('RECOVERY_BUNDLE_INVALID', 'Bộ phục hồi phải là tệp thường, tối đa 10 MiB.');
  const handle = await fs.open(filePath, 'r');
  try {
    const chunks = []; let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > MAX_BUNDLE_BYTES) throw new Error('Bundle quota');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw fail('RECOVERY_BUNDLE_INVALID', 'Không đọc được bộ phục hồi; giữ nguyên tệp.'); }
  finally { await handle.close(); }
}

async function writeLocalRecovery(filePath, bundle, checkContext = () => {}) {
  const text = JSON.stringify(bundle);
  if (Buffer.byteLength(text) > MAX_BUNDLE_BYTES) throw fail('RECOVERY_BUNDLE_INVALID', 'Bộ phục hồi vượt 10 MiB.');
  const temporary = `${filePath}.${crypto.randomBytes(8).toString('hex')}.part`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    checkContext(); await fs.link(temporary, filePath);
  } finally { await fs.rm(temporary, { force: true }); }
}

function createLocalRecoveryManager({ store, isLoggedIn, getGeneration, confirm, isBusy = () => false, now = Date.now, ttlMs = 120000 }) {
  const plans = new Map();
  const revoke = token => { const plan = plans.get(token); if (plan) clearTimeout(plan.timer); return plans.delete(token); };
  const signedOut = () => {
    if (isBusy()) throw fail('RECOVERY_BUSY', 'Hãy đợi tác vụ database hoàn tất trước khi nhập bộ phục hồi.');
    if (isLoggedIn()) throw fail('RECOVERY_SIGN_OUT_REQUIRED', 'Hãy đăng xuất đồng bộ trước khi nhập bộ phục hồi cục bộ.'); };
  function prepare(bundle, recoveryKey) {
    signedOut();
    if (plans.size >= 4) throw fail('RECOVERY_BUSY', 'Hãy đóng bản xem trước phục hồi cũ trước khi mở thêm.');
    const recovered = openLocalRecovery(bundle, recoveryKey), current = store.snapshotForSync();
    const groupIds = new Map(recovered.workspaces.map(item => [item.id, crypto.randomUUID()]));
    const timestamp = new Date(now()).toISOString();
    const merged = validateVault({ ...current,
      workspaces: [...current.workspaces, ...recovered.workspaces.map(item => ({ ...item, id: groupIds.get(item.id),
        name: item.name.slice(0, 68) + ' (phục hồi)', createdAt: timestamp, updatedAt: timestamp }))],
      connections: [...current.connections, ...recovered.connections.map(item => ({ ...item,
        id: crypto.randomUUID(), workspaceId: groupIds.get(item.workspaceId), source: 'local-recovery', importKey: null,
        updatedAt: timestamp }))]
    });
    const token = crypto.randomBytes(32).toString('hex'), expiresAt = now() + ttlMs;
    const plan = { merged, current: fingerprint(current), generation: getGeneration(), expiresAt, confirming: false,
      counts: { connections: recovered.connections.length, workspaces: recovered.workspaces.length }, timer: null };
    plan.timer = setTimeout(() => revoke(token), ttlMs); plan.timer.unref?.(); plans.set(token, plan);
    return { token, expiresAt, ...plan.counts, email: bundle.email, createdAt: bundle.createdAt };
  }
  async function apply(token) {
    const plan = typeof token === 'string' && plans.get(token);
    if (!plan || plan.confirming) throw fail('RECOVERY_PLAN_INVALID', 'Bản xem trước phục hồi không tồn tại hoặc đang xử lý.');
    const check = () => {
      signedOut();
      if (plans.get(token) !== plan || now() >= plan.expiresAt || getGeneration() !== plan.generation
          || fingerprint(store.snapshotForSync()) !== plan.current) throw fail('RECOVERY_CONTEXT_CHANGED', 'Dữ liệu hoặc bản xem trước đã thay đổi. Hãy chọn lại bộ phục hồi.');
    };
    plan.confirming = true;
    try {
      check();
      if (!await confirm(plan.counts)) return { canceled: true };
      check();
      // Synchronous store calls leave no await gap between final guard and commit.
      store.saveSyncRecovery(store.snapshotForSync(), 'before-local-recovery');
      store.replaceFromSync(plan.merged);
      return { imported: true, ...plan.counts };
    } finally { revoke(token); }
  }
  return { prepare, apply, revoke, clear: () => { for (const token of plans.keys()) revoke(token); } };
}

module.exports = { createLocalRecovery, openLocalRecovery, readLocalRecovery, writeLocalRecovery, createLocalRecoveryManager };
