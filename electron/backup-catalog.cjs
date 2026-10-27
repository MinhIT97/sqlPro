'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readManifest, sha256File, writeManifest, fileIdentity, sameFileIdentity } = require('./backup-file.cjs');

const BACKUP_NAME = /^\d{14}-[0-9a-f]{8}\.sql$/;

function backupDirectory(root, profileId, database) {
  if (!profileId || !database) throw new Error('Chưa chọn kết nối hoặc database.');
  const key = (value) => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
  return path.join(root, 'backups', key(profileId), key(database));
}

function backupName(date = new Date()) {
  const timestamp = date.toISOString().replace(/\D/g, '').slice(0, 14);
  return `${timestamp}-${crypto.randomBytes(4).toString('hex')}.sql`;
}

async function listBackups(root, profileId, database) {
  const directory = backupDirectory(root, profileId, database);
  let files;
  try {
    files = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const entries = await Promise.all(files.filter((file) => file.isFile() && BACKUP_NAME.test(file.name))
    .map(async (file) => {
      const filePath = path.join(directory, file.name);
      const stats = await fs.stat(filePath);
      const { manifest, error } = await readManifest(filePath);
      const legacy = !manifest;
      const verification = manifest
        ? { ...manifest.verification, checksum: sameFileIdentity(manifest.verification?.file, fileIdentity(stats))
          ? manifest.verification.checksum : 'unverified' }
        : { fileWritten: true, checksum: 'missing', restore: 'not-tested' };
      return {
        id: file.name,
        name: file.name.slice(0, 14),
        bytes: stats.size,
        createdAt: manifest?.createdAt || stats.mtime.toISOString(),
        checksum: manifest?.checksum?.value || null,
        verification,
        source: manifest?.source || null,
        selection: manifest?.selection || null,
        result: manifest?.result || null,
        legacy,
        ...(error ? { manifestError: error } : {})
      };
    }));
  return entries.sort((a, b) => b.id.localeCompare(a.id));
}

async function resolveBackup(root, profileId, database, id) {
  if (typeof id !== 'string' || !BACKUP_NAME.test(id)) throw new Error('Bản sao lưu không hợp lệ.');
  const filePath = path.join(backupDirectory(root, profileId, database), id);
  const stats = await fs.lstat(filePath);
  if (!stats.isFile()) throw new Error('Không tìm thấy tệp sao lưu.');
  return filePath;
}

async function verifyBackup(root, profileId, database, id) {
  const filePath = await resolveBackup(root, profileId, database, id);
  const stats = await fs.stat(filePath);
  const { manifest, error } = await readManifest(filePath);
  const checksum = await sha256File(filePath);
  const currentStats = await fs.stat(filePath);
  if (!sameFileIdentity(fileIdentity(stats), fileIdentity(currentStats))) {
    throw Object.assign(new Error('Tệp sao lưu đã thay đổi trong khi xác minh. Hãy thử lại.'), { code: 'BACKUP_FILE_CHANGED' });
  }
  if (!manifest) {
    return {
      id,
      filePath,
      bytes: stats.size,
      checksum,
      expected: null,
      match: null,
      legacy: true,
      verification: { fileWritten: true, checksum: 'missing', restore: 'not-tested' },
      ...(error ? { manifestError: error } : {})
    };
  }
  const expected = manifest.checksum.value.toLowerCase();
  const match = checksum === expected;
  const verification = {
    ...manifest.verification,
    checksum: match ? 'verified' : 'mismatch',
    checkedAt: new Date().toISOString(),
    file: fileIdentity(currentStats)
  };
  await writeManifest(filePath, { ...manifest, verification });
  return {
    id,
    filePath,
    bytes: stats.size,
    checksum,
    expected,
    match,
    legacy: false,
    verification
  };
}

async function copyBackup(root, sourceProfileId, targetProfileId, sourceDatabase, targetDatabase, id) {
  let srcProf = sourceProfileId;
  let tgtProf = targetProfileId;
  let srcDb = sourceDatabase;
  let tgtDb = targetDatabase;
  let backupId = id;
  if (arguments.length === 5) {
    srcProf = sourceProfileId;
    tgtProf = sourceProfileId;
    srcDb = targetProfileId;
    tgtDb = sourceDatabase;
    backupId = targetDatabase;
  }
  if (typeof backupId !== 'string' || !BACKUP_NAME.test(backupId)) throw new Error('Bản sao lưu không hợp lệ.');
  if (!srcProf || !tgtProf) throw new Error('Chưa chọn kết nối nguồn hoặc đích.');
  if (!srcDb || typeof srcDb !== 'string') throw new Error('Chưa chọn database nguồn.');
  if (!tgtDb || typeof tgtDb !== 'string') throw new Error('Chưa chọn database đích.');

  const sourceFile = await resolveBackup(root, srcProf, srcDb, backupId);
  const sourceStat = await fs.stat(sourceFile);
  const sourceManifest = await readManifest(sourceFile);
  const targetDir = backupDirectory(root, tgtProf, tgtDb);
  await fs.mkdir(targetDir, { recursive: true, mode: 0o700 });
  const newId = backupName();
  const targetFile = path.join(targetDir, newId);
  const temporaryFile = path.join(targetDir, `.${newId}.${crypto.randomBytes(8).toString('hex')}.part`);
  let targetChecksum = null;
  try {
    await fs.copyFile(sourceFile, temporaryFile, constants.COPYFILE_EXCL);
    const [copiedStat, currentSourceStat] = await Promise.all([fs.stat(temporaryFile), fs.stat(sourceFile)]);
    if (copiedStat.size !== sourceStat.size || currentSourceStat.size !== sourceStat.size ||
        currentSourceStat.dev !== sourceStat.dev || currentSourceStat.ino !== sourceStat.ino ||
        currentSourceStat.mtimeMs !== sourceStat.mtimeMs || currentSourceStat.ctimeMs !== sourceStat.ctimeMs) {
      throw new Error('Tệp sao lưu nguồn đã thay đổi trong khi sao chép.');
    }
    if (sourceManifest.manifest) {
      const [sourceChecksum, copiedChecksum] = await Promise.all([
        sha256File(sourceFile),
        sha256File(temporaryFile)
      ]);
      const expected = sourceManifest.manifest.checksum.value.toLowerCase();
      if (sourceChecksum !== expected || copiedChecksum !== expected) {
        throw Object.assign(new Error('Bản sao lưu nguồn không khớp checksum đã lưu. Tệp có thể đã bị sửa hoặc hỏng.'), {
          code: 'BACKUP_CHECKSUM_MISMATCH'
        });
      }
      targetChecksum = copiedChecksum;
    }
    await fs.chmod(temporaryFile, 0o600);
    const handle = await fs.open(temporaryFile, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporaryFile, targetFile);
  } catch (error) {
    await fs.rm(temporaryFile, { force: true }).catch(() => {});
    throw error;
  }
  let manifestPath = null;
  let manifestError = sourceManifest.error || null;
  if (sourceManifest.manifest && targetChecksum) {
    const manifest = {
      ...sourceManifest.manifest,
      createdAt: new Date().toISOString(),
      copiedFrom: {
        id: backupId,
        database: srcDb,
        createdAt: sourceManifest.manifest.createdAt || sourceStat.mtime.toISOString()
      },
      checksum: { algorithm: 'sha256', value: targetChecksum },
      verification: { ...sourceManifest.manifest.verification, checksum: 'verified', restore: 'not-tested', file: fileIdentity(await fs.stat(targetFile)) }
    };
    try {
      manifestPath = await writeManifest(targetFile, manifest);
    } catch (error) {
      manifestError = `Không ghi được manifest checksum: ${error.message}`;
    }
  }
  const stats = await fs.stat(targetFile);
  return {
    id: newId,
    name: newId.slice(0, 14),
    bytes: stats.size,
    createdAt: stats.mtime.toISOString(),
    filePath: targetFile,
    checksum: targetChecksum,
    verification: targetChecksum
      ? { fileWritten: true, checksum: 'verified', restore: 'not-tested' }
      : { fileWritten: true, checksum: 'missing', restore: 'not-tested' },
    legacy: !sourceManifest.manifest,
    ...(manifestPath ? { manifestPath } : {}),
    ...(manifestError ? { manifestError } : {})
  };
}

module.exports = { backupDirectory, backupName, listBackups, resolveBackup, copyBackup, verifyBackup };
