'use strict';

const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { backupDirectory, listBackups, resolveBackup } = require('./backup-catalog.cjs');
const { fileIdentity } = require('./backup-file.cjs');
const { withAnnotationLock } = require('./backup-annotations.cjs');
const { planBackupRetention } = require('./backup-retention.cjs');

function changed() {
  return Object.assign(new Error('Catalog backup đã thay đổi. Hãy xem trước lại; chưa dọn thêm tệp.'), { code: 'BACKUP_RETENTION_CHANGED' });
}

async function snapshot(root, profileId, database, check = () => {}) {
  check();
  const entries = await listBackups(root, profileId, database, { maxEntries: 2000 });
  const files = [];
  for (const entry of [...entries].sort((a, b) => a.id.localeCompare(b.id))) {
    check();
    const file = await resolveBackup(root, profileId, database, entry.id);
    const identities = [];
    for (const suffix of ['', '.json', '.name.json', '.trial.json']) {
      try {
        const stat = await fs.lstat(`${file}${suffix}`);
        if (!stat.isFile()) throw changed();
        identities.push(fileIdentity(stat));
      } catch (error) { if (suffix && error.code === 'ENOENT') identities.push(null); else throw error; }
    }
    files.push({ id: entry.id, identities });
  }
  return { entries, files, identity: JSON.stringify({ entries, files }) };
}

async function locked(paths, operation, index = 0) {
  if (index === paths.length) return operation();
  return withAnnotationLock(paths[index], () => locked(paths, operation, index + 1));
}

class BackupRetentionApply {
  constructor({ root, now = Date.now, ttlMs = 120000 }) {
    Object.assign(this, { root, now, ttlMs });
    this.pending = new Map();
  }

  async preview(profileId, database, policy) {
    if (this.previewBusy) throw Object.assign(new Error('Đang đọc catalog để xem trước. Hãy đợi hoàn tất rồi thử lại.'), { code: 'SESSION_BUSY' });
    this.previewBusy = true;
    try { return await this.preparePreview(profileId, database, policy); }
    finally { this.previewBusy = false; }
  }

  async preparePreview(profileId, database, policy) {
    for (const [token, plan] of this.pending) if (plan.expiresAt <= this.now()) this.pending.delete(token);
    for (const [token, plan] of this.pending) if (plan.profileId === profileId && plan.database === database) this.pending.delete(token);
    if (this.pending.size >= 8) throw new Error('Có quá nhiều bản xem trước đang chờ. Hãy đợi 2 phút rồi thử lại.');
    const before = await snapshot(this.root, profileId, database);
    const plan = planBackupRetention(before.entries, policy, { now: this.now() });
    const after = await snapshot(this.root, profileId, database);
    if (before.identity !== after.identity) throw changed();
    if (plan.blocked || !plan.removeCount || plan.removeCount > 100) return plan;
    for (const [token, pending] of this.pending) if (pending.profileId === profileId && pending.database === database) this.pending.delete(token);
    if (this.pending.size >= 8) throw new Error('Có quá nhiều bản xem trước đang chờ. Hãy đợi 2 phút rồi thử lại.');
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = this.now() + this.ttlMs;
    this.pending.set(token, { profileId, database, expiresAt, snapshot: before, plan: structuredClone(plan) });
    return { ...plan, token, expiresAt };
  }

  consume(profileId, database, token) {
    const plan = typeof token === 'string' ? this.pending.get(token) : null;
    if (!plan || plan.profileId !== profileId || plan.database !== database) throw new Error('Bản xem trước không thuộc database này hoặc đã được sử dụng.');
    this.pending.delete(token);
    if (plan.expiresAt <= this.now()) throw new Error('Bản xem trước hết hạn. Hãy xem trước lại.');
    return plan;
  }

  async apply(entry, { isCanceled = () => false, signal, onProgress = () => {} } = {}) {
    const { profileId, database, plan } = entry;
    const candidates = plan.rows.filter(row => row.action === 'remove').reverse();
    const result = { deleted: [], failed: [], remaining: [], reclaimedBytes: 0, stopped: false };
    const check = () => {
      if (isCanceled() || signal?.aborted) throw Object.assign(new Error('Đã dừng dọn backup.'), { code: 'BACKUP_RETENTION_CANCELLED' });
    };
    const progress = (phase, details = {}) => onProgress({ phase, total: candidates.length,
      deleted: result.deleted.length, reclaimedBytes: result.reclaimedBytes, ...details });
    if (entry.expiresAt <= this.now()) throw new Error('Xác nhận quá 2 phút. Hãy xem trước lại.');
    const paths = entry.snapshot.files.map(file => path.join(backupDirectory(this.root, profileId, database), file.id)).sort();
    try {
      return await locked(paths, async () => {
        progress('checking');
        const current = await snapshot(this.root, profileId, database, check);
        if (current.identity !== entry.snapshot.identity) throw changed();
        const anchor = plan.rows.find(row => row.protectedReasons.includes('latest-verified'));
        if (!anchor) throw changed();
        const anchorEntry = current.entries.find(file => file.id === anchor.id);
        const anchorPath = await resolveBackup(this.root, profileId, database, anchor.id);
        const hash = crypto.createHash('sha256');
        let bytesRead = 0, lastUpdate = 0;
        progress('hashing', { bytesRead, totalBytes: anchorEntry.bytes });
        for await (const chunk of createReadStream(anchorPath, { signal })) {
          check(); hash.update(chunk); bytesRead += chunk.length;
          if (Date.now() - lastUpdate >= 200) {
            progress('hashing', { bytesRead, totalBytes: anchorEntry.bytes }); lastUpdate = Date.now();
          }
        }
        check();
        progress('hashing', { bytesRead, totalBytes: anchorEntry.bytes });
        if (hash.digest('hex') !== anchorEntry.checksum) throw new Error('Bản giữ lại không khớp checksum. Không dọn backup.');
        if ((await snapshot(this.root, profileId, database, check)).identity !== current.identity) throw changed();
        if (entry.expiresAt <= this.now()) throw new Error('Bản xem trước hết hạn trong khi xác minh. Hãy xem trước lại.');
        for (let index = 0; index < candidates.length; index++) {
          const candidate = candidates[index];
          let sqlDeleted = false;
          try {
            // Compare all remaining files before each deletion, including the
            // protected anchor; external changes stop the rest of this batch.
            const expected = entry.snapshot.files.filter(file => !result.deleted.includes(file.id));
            progress('checking', { currentId: candidate.id });
            const latest = await snapshot(this.root, profileId, database, check);
            if (JSON.stringify(latest.files) !== JSON.stringify(expected)) throw changed();
            check();
            const filePath = await resolveBackup(this.root, profileId, database, candidate.id);
            check();
            await fs.unlink(filePath); sqlDeleted = true;
            result.deleted.push(candidate.id); result.reclaimedBytes += candidate.bytes;
            for (const suffix of ['.json', '.name.json', '.trial.json']) await fs.rm(`${filePath}${suffix}`, { force: true });
            progress('deleting', { currentId: candidate.id });
          } catch (error) {
            result.failed.push({ id: candidate.id, sqlDeleted, code: error.code || 'BACKUP_RETENTION_FAILED', message: error.message });
            result.stopped = error.code === 'BACKUP_RETENTION_CANCELLED';
            result.remaining = candidates.slice(index + (sqlDeleted ? 1 : 0)).map(row => row.id);
            break;
          }
        }
        progress(result.stopped ? 'stopped' : result.failed.length ? 'failed' : 'finished');
        return result;
      });
    } catch (error) {
      if (error.code !== 'BACKUP_RETENTION_CANCELLED' && !signal?.aborted) throw error;
      result.stopped = true;
      result.remaining = candidates.filter(candidate => !result.deleted.includes(candidate.id)).map(candidate => candidate.id);
      progress('stopped');
      return result;
    }
  }
}

module.exports = { BackupRetentionApply };
