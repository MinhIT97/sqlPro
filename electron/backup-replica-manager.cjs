'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { readManifest, fileIdentity, sameFileIdentity } = require('./backup-file.cjs');
const { readAnnotations, withAnnotationLock } = require('./backup-annotations.cjs');

function error(code, message) {
  return Object.assign(new Error(message), { code });
}

async function computeFileSha256(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

class BackupReplicaManager {
  constructor(options = {}) {
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 1000;
    if (!Number.isSafeInteger(this.maxRetries) || this.maxRetries < 1 || this.maxRetries > 5
        || !Number.isSafeInteger(this.retryDelayMs) || this.retryDelayMs < 0 || this.retryDelayMs > 60000) {
      throw error('INVALID_REPLICA_OPTIONS', 'Giới hạn retry replica không hợp lệ.');
    }
  }

  async stageCopy(source, destination, checksum) {
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try { return { file: (await this.copyAtomic(source, destination, checksum)).replicaPath, attempts: attempt }; }
      catch (err) {
        // Only unpublished staging may retry transient I/O. Verification,
        // permissions, source changes and publication failures never retry.
        if (attempt === this.maxRetries || !['EIO', 'EBUSY', 'ETIMEDOUT', 'ECONNRESET'].includes(err.code)) throw err;
        await new Promise(resolve => setTimeout(resolve, this.retryDelayMs * attempt));
      }
    }
  }

  async copyAtomic(sourcePath, destinationPath, expectedChecksum = null, options = {}) {
    const overwrite = options.overwrite === true;
    const destDir = path.dirname(destinationPath);
    await fs.promises.mkdir(destDir, { recursive: true, mode: 0o700 });

    const tempPath = `${destinationPath}.${crypto.randomBytes(8).toString('hex')}.part`;
    const readStream = fs.createReadStream(sourcePath);
    const writeStream = fs.createWriteStream(tempPath, { mode: 0o600, flags: 'wx' });

    const hash = crypto.createHash('sha256');
    readStream.on('data', chunk => hash.update(chunk));

    try {
      await pipeline(readStream, writeStream);
      // Fsync file descriptor to guarantee written to physical disk
      const handle = await fs.promises.open(tempPath, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }

      const computedHash = hash.digest('hex');
      if (expectedChecksum && computedHash !== expectedChecksum) {
        throw error('REPLICA_CHECKSUM_MISMATCH', `Checksum bản sao không khớp: mong đợi ${expectedChecksum}, nhận được ${computedHash}.`);
      }

      let finalPath = destinationPath;
      if (!overwrite) {
        // Exclusive publication: guarantee never overwriting an existing file at publication time
        let linked = false;
        let suffix = 0;
        const ext = path.extname(destinationPath);
        const stem = path.basename(destinationPath, ext);

        while (!linked) {
          try {
            await fs.promises.link(tempPath, finalPath);
            linked = true;
          } catch (linkErr) {
            if (linkErr.code === 'EEXIST') {
              suffix++;
              finalPath = path.join(destDir, `${stem}_replica_${suffix}${ext}`);
            } else {
              throw linkErr;
            }
          }
        }
        await fs.promises.unlink(tempPath);
      } else {
        await fs.promises.rename(tempPath, destinationPath);
      }

      const result = Object.assign(new String(computedHash), {
        checksum: computedHash,
        fileChecksum: computedHash,
        replicaPath: finalPath
      });
      return result;
    } catch (err) {
      try { await fs.promises.unlink(tempPath); } catch {}
      throw err;
    }
  }

  async createReplica(options) {
    return withAnnotationLock(options?.sourceFilePath, () => this.createReplicaFiles(options));
  }

  async createReplicaFiles({ sourceFilePath, destinationDir, expectedFileChecksum = null, overwrite = false } = {}) {
    if (typeof sourceFilePath !== 'string' || !sourceFilePath) throw error('INVALID_SOURCE_PATH', 'Đường dẫn nguồn không hợp lệ.');
    if (typeof destinationDir !== 'string' || !destinationDir) throw error('INVALID_DESTINATION_DIR', 'Thư mục đích không hợp lệ.');
    if (overwrite) throw error('REPLICA_OVERWRITE_UNSUPPORTED', 'Replica chỉ công bố độc quyền, không ghi đè backup hoặc metadata.');
    const sourceStat = await fs.promises.lstat(sourceFilePath);
    if (!sourceStat.isFile()) throw error('SOURCE_NOT_A_FILE', 'Nguồn phải là tệp thường, không phải symlink.');
    await fs.promises.mkdir(destinationDir, { recursive: true, mode: 0o700 });
    if (path.dirname(await fs.promises.realpath(sourceFilePath)) === await fs.promises.realpath(destinationDir)) {
      throw error('REPLICA_TARGET_CONFLICT', 'Thư mục đích không được trùng thư mục nguồn.');
    }
    const sourceManifest = await readManifest(sourceFilePath);
    if (sourceManifest.error) throw error('REPLICA_MANIFEST_INVALID', 'Manifest nguồn không hợp lệ; giữ nguyên nguồn và đích.');
    const manifestChecksum = sourceManifest.manifest?.checksum.value.toLowerCase();
    if (expectedFileChecksum != null && (typeof expectedFileChecksum !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedFileChecksum))) {
      throw error('INVALID_EXPECTED_CHECKSUM', 'Checksum đối chiếu không hợp lệ.');
    }
    if (manifestChecksum && expectedFileChecksum && manifestChecksum !== expectedFileChecksum.toLowerCase()) {
      throw error('REPLICA_CHECKSUM_MISMATCH', 'Checksum yêu cầu không khớp manifest nguồn.');
    }
    const sourceChecksum = manifestChecksum || expectedFileChecksum?.toLowerCase() || await computeFileSha256(sourceFilePath);
    // Stage the complete pair first. Missing sidecars are allowed; malformed,
    // unreadable or changing sidecars fail instead of silently becoming absent.
    const sidecars = [];
    for (const suffix of ['.json', '.name.json', '.manifest.json']) {
      let stat;
      try { stat = await fs.promises.lstat(sourceFilePath + suffix); }
      catch (err) { if (err.code === 'ENOENT') continue; throw err; }
      if (!stat.isFile() || stat.size > (suffix === '.name.json' ? 16384 : 2 * 1024 * 1024)) throw error('REPLICA_MANIFEST_INVALID', 'Metadata nguồn không phải tệp thường hoặc vượt quota.');
      if (suffix === '.name.json') await readAnnotations(sourceFilePath);
      if (suffix === '.manifest.json') {
        let legacy;
        try { legacy = JSON.parse(await fs.promises.readFile(sourceFilePath + suffix, 'utf8')); }
        catch { throw error('REPLICA_MANIFEST_INVALID', 'Sidecar legacy không hợp lệ.'); }
        if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) throw error('REPLICA_MANIFEST_INVALID', 'Sidecar legacy không hợp lệ.');
      }
      sidecars.push({ suffix, identity: fileIdentity(stat), checksum: await computeFileSha256(sourceFilePath + suffix) });
    }
    const stagingDir = await fs.promises.mkdtemp(path.join(destinationDir, '.sqlpro-replica-'));
    try {
      const stagedSqlCopy = await this.stageCopy(sourceFilePath, path.join(stagingDir, 'backup.sql'), sourceChecksum);
      const stagedSql = stagedSqlCopy.file;
      let attempts = stagedSqlCopy.attempts;
      const staged = [];
      for (const item of sidecars) {
        const copied = await this.stageCopy(sourceFilePath + item.suffix, path.join(stagingDir, 'backup.sql' + item.suffix), item.checksum);
        attempts = Math.max(attempts, copied.attempts);
        if (!sameFileIdentity(item.identity, fileIdentity(await fs.promises.lstat(sourceFilePath + item.suffix)))) throw error('REPLICA_SOURCE_CHANGED', 'Metadata nguồn đã thay đổi.');
        staged.push({ suffix: item.suffix, file: copied.file });
      }
      if (!sameFileIdentity(fileIdentity(sourceStat), fileIdentity(await fs.promises.lstat(sourceFilePath)))) throw error('REPLICA_SOURCE_CHANGED', 'Backup nguồn đã thay đổi.');
      const ext = path.extname(sourceFilePath), stem = path.basename(sourceFilePath, ext);
      for (let collision = 0; collision < 1000; collision++) {
        const finalPath = path.join(destinationDir, collision ? `${stem}_replica_${collision}${ext}` : path.basename(sourceFilePath));
        // Sidecars precede SQL. SQL is the discovery/commit point; no partial
        // pair appears as a usable backup. Never suffix a sidecar independently.
        const published = [];
        try {
          for (const suffix of ['', '.json', '.name.json', '.manifest.json', '.trial.json']) {
            try { await fs.promises.lstat(finalPath + suffix); }
            catch (err) { if (err.code === 'ENOENT') continue; throw err; }
            throw Object.assign(new Error('Replica name collision'), { code: 'EEXIST' });
          }
          for (const item of [...staged, { suffix: '', file: stagedSql }]) {
            const target = finalPath + item.suffix;
            await fs.promises.link(item.file, target);
            published.push({ target, file: item.file });
          }
          return { replicaPath: finalPath, fileChecksum: sourceChecksum, verified: true,
            verifiedAt: new Date().toISOString(), attempts,
            manifestCopied: sidecars.some(item => item.suffix === '.json' || item.suffix === '.manifest.json'),
            annotationsCopied: sidecars.some(item => item.suffix === '.name.json') };
        } catch (err) {
          // Only unlink names still referring to our staged inodes.
          for (const item of published.reverse()) {
            const current = await fs.promises.lstat(item.target).catch(() => null);
            const own = await fs.promises.stat(item.file);
            if (current?.ino === own.ino && current?.dev === own.dev) await fs.promises.unlink(item.target);
          }
          if (err.code !== 'EEXIST') throw err;
        }
      }
      throw error('REPLICA_DESTINATION_BUSY', 'Không cấp được tên replica độc quyền.');
    } finally { await fs.promises.rm(stagingDir, { recursive: true, force: true }); }
  }

  async verifyReplica({ replicaPath, expectedFileChecksum }) {
    if (!replicaPath || typeof replicaPath !== 'string') {
      throw error('INVALID_REPLICA_PATH', 'Đường dẫn bản sao replica không hợp lệ.');
    }
    if (!expectedFileChecksum || typeof expectedFileChecksum !== 'string') {
      throw error('INVALID_EXPECTED_CHECKSUM', 'Checksum đối chiếu không hợp lệ.');
    }

    try {
      const actualChecksum = await computeFileSha256(replicaPath);
      const matches = (actualChecksum === expectedFileChecksum);
      return {
        valid: matches,
        actualChecksum,
        expectedChecksum: expectedFileChecksum,
        verifiedAt: new Date().toISOString()
      };
    } catch (err) {
      return {
        valid: false,
        error: err.code || err.message,
        verifiedAt: new Date().toISOString()
      };
    }
  }
}

module.exports = {
  BackupReplicaManager,
  computeFileSha256
};
