'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { Transform, Readable } = require('node:stream');
const { fileIdentity, sameFileIdentity } = require('./backup-file.cjs');
const { normalizeArchiveMetadata, encodeMetadata, createMetadataReader } = require('./backup-archive-metadata.cjs');

const MAGIC = Buffer.from('SQLPRO_ENC_V1\0'); // 14 bytes
const HEADER_SIZE = 61; // 14 magic + 1 version + 1 cipher + 1 compress + 32 salt + 12 iv
const TAG_SIZE = 16;

function error(code, message) {
  return Object.assign(new Error(message), { code });
}

function validateHeader(header, size) {
  if (size < HEADER_SIZE + TAG_SIZE) throw error('BACKUP_FILE_CORRUPT', 'Tệp backup mã hóa bị thiếu dữ liệu.');
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw error('NOT_ENCRYPTED_BACKUP', 'Tệp không phải backup mã hóa của SqlPro.');
  if (![1, 2, 3].includes(header[14]) || header[15] !== 1 || ![0, 1].includes(header[16])) {
    throw error('BACKUP_FORMAT_UNSUPPORTED', 'Phiên bản hoặc thuật toán backup chưa được hỗ trợ.');
  }
}

async function publishExclusive(tempPath, destinationPath, checkContext = () => {}) {
  const handle = await fs.promises.open(tempPath, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
  await checkContext();
  try { await fs.promises.link(tempPath, destinationPath); }
  catch (err) {
    if (err.code === 'EEXIST') throw error('BACKUP_DESTINATION_EXISTS', 'Tệp đích đã tồn tại. Bản backup hiện có được giữ nguyên.');
    throw err;
  }
  await fs.promises.unlink(tempPath);
}

function deriveKey(passphrase, salt) {
  if (typeof passphrase !== 'string' || !passphrase || passphrase.length > 1024) {
    throw error('PASSPHRASE_REQUIRED', 'Mật khẩu bảo vệ backup bắt buộc phải được cung cấp.');
  }
  // Scrypt with safe parameters
  return crypto.scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

async function inspectBackupContainer(filePath) {
  let handle;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const header = Buffer.alloc(HEADER_SIZE);
    const { bytesRead } = await handle.read(header, 0, HEADER_SIZE, 0);

    if (bytesRead >= MAGIC.length && header.subarray(0, MAGIC.length).equals(MAGIC)) {
      validateHeader(header, (await handle.stat()).size);
      const version = header[14];
      const cipher = header[15] === 1 ? 'aes-256-gcm' : 'unknown';
      const compressed = header[16] === 1;
      return {
        format: 'encrypted',
        encrypted: true,
        compressed,
        version,
        cipher,
        kdf: 'scrypt'
      };
    }

    if (bytesRead >= 2 && header[0] === 0x1f && header[1] === 0x8b) {
      return {
        format: 'gzip',
        encrypted: false,
        compressed: true
      };
    }

    return {
      format: 'sql',
      encrypted: false,
      compressed: false
    };
  } finally {
    if (handle) await handle.close();
  }
}

async function encryptBackupFile(sourcePath, destinationPath, { passphrase, compress = true, signal, checkContext = () => {}, metadata = null } = {}) {
  if (!passphrase || typeof passphrase !== 'string' || passphrase.length < 8 || passphrase.length > 1024) {
    throw error('PASSPHRASE_TOO_SHORT', 'Mật khẩu mã hóa phải có ít nhất 8 ký tự.');
  }

  try {
    const realSrc = fs.realpathSync(sourcePath);
    let realDst = null;
    try { realDst = fs.realpathSync(destinationPath); } catch {}
    if (realSrc && realDst && realSrc === realDst) {
      throw error('BACKUP_TARGET_CONFLICT', 'Tệp nguồn và tệp đích không được trùng nhau.');
    }
  } catch (e) {
    if (e.code === 'BACKUP_TARGET_CONFLICT') throw e;
  }

  const archiveMetadata = metadata === null ? null : normalizeArchiveMetadata(metadata);
  const prefix = archiveMetadata ? encodeMetadata(archiveMetadata) : null;
  let prefixSent = false;
  const prependMetadata = new Transform({
    transform(chunk, encoding, callback) {
      if (!prefixSent) { prefixSent = true; if (prefix) this.push(prefix); }
      callback(null, chunk);
    },
    flush(callback) { if (!prefixSent && prefix) this.push(prefix); callback(); }
  });
  const sourceIdentity = fileIdentity(await fs.promises.stat(sourcePath));
  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);

  const header = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(header, 0);
  header[14] = archiveMetadata ? 3 : 2; // v3 adds authenticated, encrypted metadata before SQL
  header[15] = 1; // 1 = aes-256-gcm
  header[16] = compress ? 1 : 0;
  salt.copy(header, 17);
  iv.copy(header, 49);

  const tempPath = `${destinationPath}.${crypto.randomBytes(8).toString('hex')}.part`;
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header);
  key.fill(0);
  const out = fs.createWriteStream(tempPath, { mode: 0o600, flags: 'wx' });
  out.write(header);

  // Compute dual checksums during encryption
  const contentHasher = crypto.createHash('sha256');
  const fileHasher = crypto.createHash('sha256');
  fileHasher.update(header);

  const hashContentStream = new Transform({
    transform(chunk, encoding, callback) {
      contentHasher.update(chunk);
      callback(null, chunk);
    }
  });

  const hashFileStream = new Transform({
    transform(chunk, encoding, callback) {
      fileHasher.update(chunk);
      callback(null, chunk);
    }
  });

  const inputStream = fs.createReadStream(sourcePath);

  try {
    if (compress) {
      const gzip = zlib.createGzip({ level: 6 });
      await pipeline(inputStream, hashContentStream, prependMetadata, gzip, cipher, hashFileStream, out, { end: false, signal });
    } else {
      await pipeline(inputStream, hashContentStream, prependMetadata, cipher, hashFileStream, out, { end: false, signal });
    }

    const tag = cipher.getAuthTag();
    fileHasher.update(tag);

    await new Promise((resolve, reject) => {
      out.end(tag, err => err ? reject(err) : resolve());
    });

    const contentChecksum = contentHasher.digest('hex');
    const fileChecksum = fileHasher.digest('hex');
    if (archiveMetadata?.manifest && archiveMetadata.manifest.checksum.value !== contentChecksum) {
      throw error('BACKUP_CHECKSUM_MISMATCH', 'SQL nguồn không khớp manifest; chưa tạo bản mã hóa.');
    }

    await publishExclusive(tempPath, destinationPath, async () => {
      if (signal?.aborted) throw error('BACKUP_CRYPTO_CANCELLED', 'Đã hủy xử lý backup.');
      await checkContext();
      if (!sameFileIdentity(sourceIdentity, fileIdentity(await fs.promises.stat(sourcePath)))) {
        throw error('BACKUP_FILE_CHANGED', 'Tệp nguồn thay đổi khi mã hóa; chưa tạo bản mã hóa.');
      }
      await checkContext();
    });

    return {
      format: 'encrypted',
      compressed: Boolean(compress),
      cipher: 'aes-256-gcm',
      kdf: 'scrypt',
      contentChecksum,
      fileChecksum
    };
  } catch (err) {
    try { await fs.promises.unlink(tempPath); } catch {}
    throw err;
  }
}

async function decryptBackupFile(sourcePath, destinationPath, { passphrase, signal, checkContext = () => {}, maxPlaintextBytes = 10 * 1024 ** 3 } = {}) {
  if (!Number.isSafeInteger(maxPlaintextBytes) || maxPlaintextBytes < 1 || maxPlaintextBytes > 10 * 1024 ** 3) {
    throw error('BACKUP_CRYPTO_QUOTA_INVALID', 'Hạn mức giải mã không hợp lệ.');
  }
  let plaintextBytes = 0;
  const stat = await fs.promises.stat(sourcePath);
  if (stat.size < HEADER_SIZE + TAG_SIZE) {
    throw error('BACKUP_FILE_CORRUPT', 'Tệp backup không hợp lệ hoặc kích thước quá nhỏ.');
  }

  try {
    const realSrc = fs.realpathSync(sourcePath);
    let realDst = null;
    try { realDst = fs.realpathSync(destinationPath); } catch {}
    if (realSrc && realDst && realSrc === realDst) {
      throw error('BACKUP_TARGET_CONFLICT', 'Tệp nguồn và tệp đích không được trùng nhau.');
    }
  } catch (e) {
    if (e.code === 'BACKUP_TARGET_CONFLICT') throw e;
  }

  const handle = await fs.promises.open(sourcePath, 'r');
  const header = Buffer.alloc(HEADER_SIZE);
  const tag = Buffer.alloc(TAG_SIZE);
  try {
    const read = await handle.read(header, 0, HEADER_SIZE, 0);
    if (read.bytesRead !== HEADER_SIZE) throw error('BACKUP_FILE_CORRUPT', 'Header backup bị thiếu dữ liệu.');
    validateHeader(header, stat.size);
    const readTag = await handle.read(tag, 0, TAG_SIZE, stat.size - TAG_SIZE);
    if (readTag.bytesRead !== TAG_SIZE) throw error('BACKUP_FILE_CORRUPT', 'Tag backup bị thiếu dữ liệu.');
  } finally { await handle.close(); }
  const compress = header[16] === 1;
  const salt = header.subarray(17, 49);
  const iv = header.subarray(49, 61);

  if (!passphrase) {
    throw error('PASSPHRASE_REQUIRED', 'Tệp backup yêu cầu mật khẩu để giải mã.');
  }

  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  if (header[14] >= 2) decipher.setAAD(header);
  key.fill(0);
  decipher.setAuthTag(tag);

  const cipherStream = stat.size === HEADER_SIZE + TAG_SIZE ? Readable.from([]) : fs.createReadStream(sourcePath, {
    start: HEADER_SIZE,
    end: stat.size - TAG_SIZE - 1
  });

  const tempPath = `${destinationPath}.${crypto.randomBytes(8).toString('hex')}.part`;
  const out = fs.createWriteStream(tempPath, { mode: 0o600, flags: 'wx' });
  const contentHasher = crypto.createHash('sha256');
  const metadataReader = header[14] === 3 ? createMetadataReader() : null;
  const quota = new Transform({
    transform(chunk, encoding, callback) {
      plaintextBytes += chunk.length;
      if (plaintextBytes > maxPlaintextBytes) {
        callback(error('BACKUP_DECOMPRESSION_LIMIT', 'Nội dung giải mã vượt hạn mức; chưa tạo bản SQL.')); return;
      }
      callback(null, chunk);
    }
  });

  const hashContentStream = new Transform({
    transform(chunk, encoding, callback) {
      contentHasher.update(chunk);
      callback(null, chunk);
    }
  });

  try {
    if (compress) {
      const gunzip = zlib.createGunzip();
      await pipeline(cipherStream, decipher, gunzip, quota, ...(metadataReader ? [metadataReader.stream] : []), hashContentStream, out, { signal });
    } else {
      await pipeline(cipherStream, decipher, quota, ...(metadataReader ? [metadataReader.stream] : []), hashContentStream, out, { signal });
    }
    const expected = metadataReader?.getMetadata()?.manifest?.checksum.value;
    if (expected && contentHasher.copy().digest('hex') !== expected) {
      throw error('BACKUP_CHECKSUM_MISMATCH', 'Nội dung SQL không khớp metadata đã xác thực.');
    }
    await publishExclusive(tempPath, destinationPath, async () => {
      if (signal?.aborted) throw error('BACKUP_CRYPTO_CANCELLED', 'Đã hủy xử lý backup.');
      await checkContext();
      if (!sameFileIdentity(fileIdentity(stat), fileIdentity(await fs.promises.stat(sourcePath)))) {
        throw error('BACKUP_FILE_CHANGED', 'Container thay đổi khi giải mã; chưa tạo bản SQL.');
      }
      await checkContext();
    });
  } catch (err) {
    // Delete ONLY partial temporary file on error, never destinationPath
    try { await fs.promises.unlink(tempPath); } catch {}
    if (/unable to authenticate|Unsupported state|bad decrypt/i.test(err.message) || ['Z_DATA_ERROR', 'Z_BUF_ERROR'].includes(err.code)) {
      throw error('BACKUP_DECRYPTION_FAILED', 'Mật khẩu giải mã không chính xác hoặc dữ liệu backup đã bị can thiệp/hỏng.');
    }
    throw err;
  }

  return {
    contentChecksum: contentHasher.digest('hex'),
    ...(metadataReader ? { metadata: metadataReader.getMetadata() } : {})
  };
}

module.exports = {
  MAGIC,
  HEADER_SIZE,
  TAG_SIZE,
  inspectBackupContainer,
  encryptBackupFile,
  decryptBackupFile,
  deriveKey
};
