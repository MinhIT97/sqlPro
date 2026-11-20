'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { backupDirectory, backupName, resolveBackup } = require('./backup-catalog.cjs');
const { inspectBackupContainer, encryptBackupFile, decryptBackupFile } = require('./backup-crypto.cjs');
const { readManifest, writeManifest, buildManifest, fileIdentity, sameFileIdentity } = require('./backup-file.cjs');
const { readAnnotations, writeAnnotations, withAnnotationLock } = require('./backup-annotations.cjs');
const { normalizeArchiveMetadata } = require('./backup-archive-metadata.cjs');
const { copyArchiveExclusive } = require('./backup-archive-copy.cjs');
const { replicateEncryptedArchive } = require('./backup-sftp-replica.cjs');
const fail = (code, message) => Object.assign(new Error(message), { code });
const ARCHIVE_NAME = /^\d{14}-[0-9a-f]{8}\.sql\.enc$/;

function createEncryptedCatalog({ root, profileId, database, checkContext = () => {}, signal }) {
  if (typeof profileId !== 'string' || !profileId || profileId.length > 160
    || typeof database !== 'string' || !database || database.length > 64 || database.includes('\0')) {
    throw fail('INVALID_BACKUP_SCOPE', 'Thiếu đích catalog backup hợp lệ.');
  }
  const directory = backupDirectory(root, profileId, database);
  const check = () => {
    if (signal?.aborted) throw fail('BACKUP_CRYPTO_CANCELLED', 'Đã hủy xử lý backup.');
    checkContext();
  };
  async function resolveArchive(id) {
    check();
    if (typeof id !== 'string' || !ARCHIVE_NAME.test(id)) throw fail('INVALID_BACKUP_ARCHIVE', 'Tên bản mã hóa không hợp lệ.');
    const file = path.join(directory, id), stat = await fs.lstat(file);
    check();
    if (!stat.isFile() || stat.isSymbolicLink()) throw fail('INVALID_BACKUP_ARCHIVE', 'Bản mã hóa không phải tệp thông thường.');
    return file;
  }
  async function list() {
    check();
    let files;
    try { files = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    check();
    const archives = files.filter(file => file.isFile() && ARCHIVE_NAME.test(file.name));
    if (archives.length > 256) throw fail('BACKUP_ARCHIVE_QUOTA_EXCEEDED', 'Catalog bản mã hóa vượt 256 tệp.');
    const result = [];
    for (const file of archives) {
      const filePath = await resolveArchive(file.name), stat = await fs.stat(filePath);
      check();
      result.push({ id: file.name, bytes: stat.size, createdAt: stat.mtime.toISOString() });
    }
    return result.sort((a,b) => b.id.localeCompare(a.id));
  }
  async function identity(file) {
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile()) throw fail('BACKUP_METADATA_INVALID', 'Metadata không phải tệp thông thường.');
      return fileIdentity(stat);
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function encrypt(id, passphrase, compress = true) {
    check();
    const filePath = await resolveBackup(root, profileId, database, id);
    return withAnnotationLock(filePath, async () => {
      check();
      const sidecars = await Promise.all(['.json', '.name.json'].map(async suffix => ({ suffix, before: await identity(filePath + suffix) })));
      const { manifest, error } = await readManifest(filePath);
      if (error) throw fail('BACKUP_METADATA_INVALID', 'Manifest nguồn lỗi; chưa tạo bản mã hóa.');
      const metadata = normalizeArchiveMetadata({ version: 1, kind: 'sqlpro-backup-archive-metadata',
        sourceId: id, manifest, annotations: await readAnnotations(filePath) });
      const archiveId = `${id}.enc`;
      const result = await encryptBackupFile(filePath, path.join(directory, archiveId), {
        passphrase, compress, signal, metadata,
        checkContext: async () => {
          check();
          for (const item of sidecars) {
            const current = await identity(filePath + item.suffix);
            if (item.before === null ? current !== null : !sameFileIdentity(item.before, current)) {
              throw fail('BACKUP_FILE_CHANGED', 'Metadata nguồn thay đổi khi mã hóa; chưa công bố archive.');
            }
          }
          check();
        }
      });
      return { ...result, id: archiveId, metadataIncluded: true };
    });
  }
  async function decrypt(id, passphrase) {
    const filePath = await resolveArchive(id);
    const sourceIdentity = await identity(filePath);
    const info = await inspectBackupContainer(filePath);
    check();
    if (!info.encrypted) throw fail('NOT_ENCRYPTED_BACKUP', 'Tệp không phải container mã hóa được hỗ trợ.');
    const stage = await fs.mkdtemp(path.join(directory, '.decrypt-'));
    const stagedSql = path.join(stage, 'decrypted.sql');
    const sqlId = backupName(), target = path.join(directory, sqlId);
    const published = [];
    let committed = false;
    try {
      const result = await decryptBackupFile(filePath, stagedSql, { passphrase, signal, checkContext: check });
      const metadata = result.metadata || null;
      const stats = await fs.stat(stagedSql);
      const original = metadata?.manifest;
      const manifest = { ...(original || buildManifest(result.contentChecksum, { bytes: stats.size })),
        createdAt: new Date().toISOString(),
        result: { ...(original?.result || {}), bytes: stats.size },
        checksum: { algorithm: 'sha256', value: result.contentChecksum },
        verification: { fileWritten: true, checksum: 'unverified', restore: 'not-tested' },
        origin: { kind: 'encrypted-archive', archiveId: id, sourceBackupId: metadata?.sourceId || null,
          sourceCreatedAt: original?.createdAt || null } };
      await writeManifest(stagedSql, manifest, { exclusive: true });
      await writeAnnotations(stagedSql, metadata?.annotations || {}, { exclusive: true });
      const sidecars = ['.json', '.name.json'];
      for (const suffix of sidecars) {
        const handle = await fs.open(stagedSql + suffix, 'r+');
        try { await handle.sync(); } finally { await handle.close(); }
      }
      return await withAnnotationLock(target, async () => {
        for (const suffix of ['', ...sidecars, '.trial.json']) {
          if (await identity(target + suffix)) throw fail('BACKUP_DESTINATION_EXISTS', 'Mã SQL mới đã tồn tại; giữ nguyên bản cũ.');
        }
        for (const suffix of [...sidecars, '']) {
          check();
          if (!sameFileIdentity(sourceIdentity, await identity(filePath))) {
            throw fail('BACKUP_FILE_CHANGED', 'Container thay đổi trước khi công bố SQL.');
          }
          check();
          const staged = stagedSql + suffix, destination = target + suffix;
          await fs.link(staged, destination);
          published.push({ staged, destination });
        }
        committed = true; // SQL is the discovery point; never erase it after this point.
        let manifestError = null;
        try {
          await fs.rm(stage, { recursive: true, force: true });
          manifest.verification = { fileWritten: true, checksum: 'verified', restore: 'not-tested',
            file: fileIdentity(await fs.stat(target)) };
          await writeManifest(target, manifest);
        } catch { manifestError = 'SQL đã được công bố; cần xác minh lại checksum và metadata.'; }
        return { id: sqlId, archiveId: id, contentChecksum: result.contentChecksum, restore: 'not-tested',
          metadataRestored: Boolean(metadata), verification: { checksum: manifestError ? 'unverified' : 'verified', restore: 'not-tested' },
          ...(manifestError ? { manifestError } : {}) };
      });
    } catch (error) {
      if (!committed) {
        for (const item of published.reverse()) {
          const current = await fs.lstat(item.destination).catch(() => null);
          const own = await fs.stat(item.staged).catch(() => null);
          if (current && own && current.ino === own.ino && current.dev === own.dev) await fs.unlink(item.destination);
        }
      }
      throw error;
    } finally { await fs.rm(stage, { recursive: true, force: true }).catch(() => {}); }
  }
  async function importArchive(filePath) {
    check();
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const id = `${backupName()}.enc`;
    const result = await copyArchiveExclusive(filePath, path.join(directory, id), { signal, checkContext: check });
    return { ...result, id };
  }
  async function exportArchive(id, destination) {
    const filePath = await resolveArchive(id);
    return withAnnotationLock(filePath, () => copyArchiveExclusive(filePath, destination, { signal, checkContext: check }));
  }
  async function removeArchive(id) {
    const filePath = await resolveArchive(id);
    return withAnnotationLock(filePath, async () => {
      await resolveArchive(id); check();
      await fs.unlink(filePath);
      return { deleted: true, id };
    });
  }
  async function replicateArchive(id, options) {
    const filePath = await resolveArchive(id);
    return withAnnotationLock(filePath, () => replicateEncryptedArchive({ ...options,
      sourceFile: filePath, signal, checkContext: check }));
  }
  return { list, encrypt, decrypt, importArchive, exportArchive, removeArchive, replicateArchive };
}

module.exports = { createEncryptedCatalog };
