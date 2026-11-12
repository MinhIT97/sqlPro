'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readManifest, sha256File, writeManifest, fileIdentity, sameFileIdentity, manifestPathFor } = require('./backup-file.cjs');

const { normalizeBackupDisplayName, normalizeAnnotations, readAnnotations, writeAnnotations, withAnnotationLock } = require('./backup-annotations.cjs');

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

async function listBackups(root, profileId, database, { maxEntries = Infinity } = {}) {
  const directory = backupDirectory(root, profileId, database);
  let files;
  try {
    files = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const backupFiles = files.filter(file => file.isFile() && BACKUP_NAME.test(file.name));
  if (backupFiles.length > maxEntries) throw new Error(`Catalog vượt giới hạn ${maxEntries} bản cho thao tác này.`);
  const entries = await Promise.all(backupFiles
    .map(async (file) => {
      const filePath = path.join(directory, file.name);
      const stats = await fs.stat(filePath);
      const { manifest, error } = await readManifest(filePath);
      let trial=null;
      try {
        const reportStats=await fs.stat(`${filePath}.trial.json`);
        if(reportStats.size<=256*1024){
          const report=JSON.parse(await fs.readFile(`${filePath}.trial.json`,'utf8'));
          trial={status:report.status,cleanup:report.cleanup,finishedAt:report.finishedAt,checksum:report.checksum,database:report.database};
        }
      }catch { /* A report is optional and never changes checksum verification. */ }
      let annotations = { note: '', pinned: false };
      let annotationError;
      try { annotations = await readAnnotations(filePath); }
      catch (error) { annotationError = error.message; }
      const legacy = !manifest;
      const verification = manifest
        ? { ...manifest.verification, checksum: sameFileIdentity(manifest.verification?.file, fileIdentity(stats))
          ? manifest.verification.checksum : 'unverified' }
        : { fileWritten: true, checksum: 'missing', restore: 'not-tested' };
      return {
        id: file.name,
        name: annotations.name || file.name.slice(0, 14),
        note: annotations.note,
        pinned: annotations.pinned,
        ...(annotationError ? { annotationError } : {}),
        bytes: stats.size,
        createdAt: manifest?.createdAt || stats.mtime.toISOString(),
        checksum: manifest?.checksum?.value || null,
        verification,
        source: manifest?.source || null,
        selection: manifest?.selection || null,
        result: manifest?.result || null,
        legacy,
        trial,
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

async function updateBackupAnnotations(root, profileId, database, id, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)
      || Object.keys(patch).some(key => !['name', 'note', 'pinned'].includes(key))
      || Object.keys(patch).length === 0) throw new Error('Thay đổi ghi chú backup không hợp lệ.');
  if (Object.values(patch).some(value => value === undefined)) throw new Error('Thiếu giá trị ghi chú backup.');
  const changes = { ...patch };
  normalizeAnnotations(changes);
  const filePath = await resolveBackup(root, profileId, database, id);
  return withAnnotationLock(filePath, async () => {
    await resolveBackup(root, profileId, database, id);
    const current = await readAnnotations(filePath);
    const annotations = await writeAnnotations(filePath, { ...current, ...changes });
    return { id, ...annotations };
  });
}

async function renameBackup(root, profileId, database, id, value) {
  const name = normalizeBackupDisplayName(value);
  await updateBackupAnnotations(root, profileId, database, id, { name });
  return { id, name };
}

async function deleteBackup(root, profileId, database, id) {
  const filePath = await resolveBackup(root, profileId, database, id);
  return withAnnotationLock(filePath, async () => {
    await resolveBackup(root, profileId, database, id);
    const annotations = await readAnnotations(filePath);
    if (annotations.pinned) throw Object.assign(new Error('Bản sao lưu đang được ghim. Hãy bỏ ghim trước khi xóa.'), { code: 'BACKUP_PINNED' });
    await fs.unlink(filePath);
    await fs.rm(manifestPathFor(filePath), { force: true });
    await fs.rm(`${filePath}.name.json`, { force: true });
    await fs.rm(`${filePath}.trial.json`, { force: true });
    return { deleted: true };
  });
}

async function verifyBackup(root, profileId, database, id) {
  const filePath = await resolveBackup(root, profileId, database, id);
  return withAnnotationLock(filePath, () => verifyBackupFile(root, profileId, database, id));
}

async function verifyBackupFile(root, profileId, database, id) {
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

async function copyBackup(...args) {
  const sourceDatabase = args.length === 5 ? args[2] : args[3];
  const id = args.length === 5 ? args[4] : args[5];
  const filePath = await resolveBackup(args[0], args[1], sourceDatabase, id);
  return withAnnotationLock(filePath, () => copyBackupFile(...args));
}

async function copyBackupFile(root, sourceProfileId, targetProfileId, sourceDatabase, targetDatabase, id) {
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
  const annotations = await readAnnotations(sourceFile);
  const sourceManifest = await readManifest(sourceFile);
  const targetDir = backupDirectory(root, tgtProf, tgtDb);
  await fs.mkdir(targetDir, { recursive: true, mode: 0o700 });
  const newId = backupName();
  const targetFile = path.join(targetDir, newId);
  const temporaryFile = path.join(targetDir, `.${newId}.${crypto.randomBytes(8).toString('hex')}.part`);
  let targetChecksum = null;
  let annotationPublished = false;
  try {
    for (const suffix of ['', '.json', '.name.json', '.trial.json']) {
      try {
        await fs.lstat(`${targetFile}${suffix}`);
        throw Object.assign(new Error('Mã backup đích đã tồn tại. Hãy sao chép lại để tạo mã mới.'), { code: 'EEXIST' });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
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
    await writeAnnotations(targetFile, annotations, { exclusive: true });
    annotationPublished = true;
    // Atomic no-replace publication: an ID collision must never replace an
    // existing backup or its pin metadata.
    await fs.link(temporaryFile, targetFile);
    await fs.rm(temporaryFile, { force: true }).catch(() => {});
  } catch (error) {
    await fs.rm(temporaryFile, { force: true }).catch(() => {});
    if (annotationPublished) await fs.rm(`${targetFile}.name.json`, { force: true }).catch(() => {});
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
    name: annotations.name || newId.slice(0, 14),
    note: annotations.note,
    pinned: annotations.pinned,
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

module.exports = { backupDirectory, backupName, listBackups, resolveBackup, copyBackup, verifyBackup, renameBackup, updateBackupAnnotations, deleteBackup };
