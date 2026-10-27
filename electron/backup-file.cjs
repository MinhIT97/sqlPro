'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');

const MANIFEST_VERSION = 1;
const MANIFEST_KIND = 'sqlpro-backup-manifest';

function manifestPathFor(filePath) {
  return `${filePath}.json`;
}

function fileIdentity(stats) {
  return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs };
}

function sameFileIdentity(left, right) {
  return Boolean(left && right && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every((key) => left[key] === right[key]));
}

function temporaryName(target) {
  return `${target}.part-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function safeText(value, maxLength = 200) {
  if (value === undefined || value === null) return null;
  return String(value).slice(0, maxLength);
}

function safeList(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 2000).map((entry) => safeText(entry, 200)).filter(Boolean);
}

function buildManifest(checksum, stats, options = {}) {
  const source = options.source && typeof options.source === 'object' ? options.source : {};
  const selection = options.selection && typeof options.selection === 'object' ? options.selection : {};
  return {
    version: MANIFEST_VERSION,
    kind: MANIFEST_KIND,
    createdAt: new Date().toISOString(),
    app: {
      name: safeText(options.appName, 80),
      version: safeText(options.appVersion, 40)
    },
    source: {
      profileId: safeText(source.profileId, 120),
      database: safeText(source.database, 64),
      serverVersion: safeText(source.serverVersion, 120)
    },
    selection: {
      includeStructure: selection.includeStructure !== false,
      includeData: selection.includeData !== false,
      dropTables: selection.dropTables === true,
      stripDefiner: selection.stripDefiner === true,
      tables: safeList(selection.tables),
      routines: safeList(selection.routines),
      events: safeList(selection.events)
    },
    result: {
      bytes: Number(stats.bytes) || 0,
      rows: Number(stats.rows) || 0,
      objects: Number(stats.objects) || 0,
      tables: Number(stats.tables) || 0,
      views: Number(stats.views) || 0,
      triggers: Number(stats.triggers) || 0,
      procedures: Number(stats.procedures) || 0,
      functions: Number(stats.functions) || 0,
      events: Number(stats.events) || 0
    },
    checksum: { algorithm: 'sha256', value: checksum },
    verification: {
      fileWritten: true,
      checksum: 'verified',
      restore: 'not-tested'
    }
  };
}

async function writeManifest(filePath, manifest) {
  const target = manifestPathFor(filePath);
  const temporary = temporaryName(target);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, target);
    return target;
  } catch (error) {
    if (handle) {
      try { await handle.close(); } catch { /* ignore close error */ }
    }
    try { await fs.unlink(temporary); } catch { /* ignore cleanup error */ }
    throw error;
  }
}

async function readManifest(filePath) {
  const target = manifestPathFor(filePath);
  let text;
  try {
    text = await fs.readFile(target, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { manifest: null, error: null, path: target };
    return { manifest: null, error: error.message, path: target };
  }
  try {
    const manifest = JSON.parse(text);
    if (!manifest || manifest.version !== MANIFEST_VERSION || manifest.kind !== MANIFEST_KIND
      || !manifest.checksum || manifest.checksum.algorithm !== 'sha256'
      || typeof manifest.checksum.value !== 'string' || !/^[0-9a-f]{64}$/i.test(manifest.checksum.value)) {
      return { manifest: null, error: 'Manifest không hợp lệ.', path: target };
    }
    return { manifest, error: null, path: target };
  } catch (error) {
    return { manifest: null, error: `Manifest không đọc được: ${error.message}`, path: target };
  }
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

async function saveBackupFile(filePath, produce, options = {}) {
  const temporary = temporaryName(filePath);
  const hash = crypto.createHash('sha256');
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    const stats = await produce(async (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      hash.update(buffer);
      await handle.writeFile(buffer);
    });
    await handle.sync();
    await handle.close();
    handle = null;
    const temporaryStats = await fs.stat(temporary);
    if (!temporaryStats.isFile() || temporaryStats.size !== stats.bytes) {
      throw new Error('Tệp chưa được ghi đầy đủ. Hãy kiểm tra dung lượng ổ đĩa và thử lại.');
    }
    const checksum = hash.digest('hex');
    await fs.rename(temporary, filePath);
    const result = {
      ...stats,
      checksum,
      verification: { fileWritten: true, checksum: 'verified', restore: 'not-tested' }
    };
    if (options.manifest !== false) {
      const manifest = buildManifest(checksum, stats, options);
      manifest.verification.file = fileIdentity(await fs.stat(filePath));
      try {
        result.manifestPath = await writeManifest(filePath, manifest);
      } catch (error) {
        result.manifestError = `Không ghi được manifest checksum: ${error.message}`;
        result.verification = { fileWritten: true, checksum: 'unverified', restore: 'not-tested' };
      }
    }
    return result;
  } catch (error) {
    if (handle) {
      try { await handle.close(); } catch { /* ignore close error */ }
    }
    try { await fs.unlink(temporary); } catch { /* ignore cleanup error */ }
    throw error;
  }
}

module.exports = {
  MANIFEST_VERSION,
  saveBackupFile,
  manifestPathFor,
  readManifest,
  sha256File,
  writeManifest,
  fileIdentity,
  sameFileIdentity
};
