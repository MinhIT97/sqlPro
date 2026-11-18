'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');

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
    this.maxRetries = Number(options.maxRetries) || 3;
    this.retryDelayMs = Number(options.retryDelayMs) || 1000;
  }

  async copyAtomic(sourcePath, destinationPath, expectedChecksum = null, options = {}) {
    const overwrite = options.overwrite === true;
    const destDir = path.dirname(destinationPath);
    await fs.promises.mkdir(destDir, { recursive: true, mode: 0o700 });

    const tempPath = `${destinationPath}.${crypto.randomBytes(8).toString('hex')}.part`;
    const readStream = fs.createReadStream(sourcePath);
    const writeStream = fs.createWriteStream(tempPath, { mode: 0o600 });

    const hash = crypto.createHash('sha256');
    readStream.on('data', chunk => hash.update(chunk));

    try {
      await pipeline(readStream, writeStream);
      // Fsync file descriptor to guarantee written to physical disk
      const handle = await fs.promises.open(tempPath, 'r');
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

  async createReplica({
    sourceFilePath,
    destinationDir,
    expectedFileChecksum = null,
    overwrite = false
  }) {
    if (!sourceFilePath || typeof sourceFilePath !== 'string') {
      throw error('INVALID_SOURCE_PATH', 'Đường dẫn tệp nguồn backup không hợp lệ.');
    }
    if (!destinationDir || typeof destinationDir !== 'string') {
      throw error('INVALID_DESTINATION_DIR', 'Thư mục đích lưu bản sao replica không hợp lệ.');
    }

    const sourceStat = await fs.promises.stat(sourceFilePath);
    if (!sourceStat.isFile()) {
      throw error('SOURCE_NOT_A_FILE', 'Tệp nguồn không tồn tại hoặc không phải là tệp thường.');
    }

    const baseName = path.basename(sourceFilePath);
    let targetReplicaPath = path.join(destinationDir, baseName);

    // If destination file already exists and overwrite is false:
    // allocate a unique non-conflicting replica path to avoid destroying existing backup
    if (!overwrite && fs.existsSync(targetReplicaPath)) {
      const ext = path.extname(baseName);
      const stem = path.basename(baseName, ext);
      let counter = 1;
      while (fs.existsSync(targetReplicaPath)) {
        targetReplicaPath = path.join(destinationDir, `${stem}_replica_${counter}${ext}`);
        counter++;
      }
    }

    // Prevent overwriting or pointing to the same file
    let realSource = null;
    try { realSource = fs.realpathSync(sourceFilePath); } catch {}
    let realTargetDir = null;
    try { realTargetDir = fs.realpathSync(destinationDir); } catch {}
    if (realSource && realTargetDir) {
      const targetCanonical = path.join(realTargetDir, baseName);
      if (realSource === targetCanonical) {
        throw error('REPLICA_TARGET_CONFLICT', 'Thư mục đích không được trùng với vị trí tệp nguồn.');
      }
    }

    // Verify source checksum if expected checksum is provided
    let sourceChecksum = expectedFileChecksum;
    if (!sourceChecksum) {
      sourceChecksum = await computeFileSha256(sourceFilePath);
    }

    let lastError = null;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const copyResult = await this.copyAtomic(sourceFilePath, targetReplicaPath, sourceChecksum, { overwrite });
        const writtenChecksum = typeof copyResult === 'string' ? copyResult : (copyResult.checksum || String(copyResult));
        const finalReplicaPath = (copyResult && copyResult.replicaPath) ? copyResult.replicaPath : targetReplicaPath;

        // Copy sidecar manifest if exists
        const sidecarManifest = `${sourceFilePath}.manifest.json`;
        let manifestCopied = false;
        try {
          const sidecarStat = await fs.promises.stat(sidecarManifest);
          if (sidecarStat.isFile()) {
            const destManifest = `${finalReplicaPath}.manifest.json`;
            await this.copyAtomic(sidecarManifest, destManifest, null, { overwrite });
            manifestCopied = true;
          }
        } catch {
          // No sidecar manifest, that's fine
        }

        return {
          replicaPath: finalReplicaPath,
          fileChecksum: writtenChecksum,
          verified: true,
          verifiedAt: new Date().toISOString(),
          attempts: attempt,
          manifestCopied
        };
      } catch (err) {
        lastError = err;
        if (attempt < this.maxRetries) {
          await new Promise(r => setTimeout(r, this.retryDelayMs * attempt));
        }
      }
    }

    throw error('REPLICA_CREATION_FAILED', `Tạo bản sao ngoài máy thất bại sau ${this.maxRetries} lần thử: ${lastError?.message}`);
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
