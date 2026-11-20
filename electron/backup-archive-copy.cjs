'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { fileIdentity, sameFileIdentity } = require('./backup-file.cjs');
const { inspectBackupContainer } = require('./backup-crypto.cjs');

const fail = (code, message) => Object.assign(new Error(message), { code });

async function assertExternalDestination(filePath, userData) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw fail('INVALID_EXPORT_PATH', 'Đường dẫn xuất không hợp lệ.');
  const directory = await fs.promises.realpath(path.dirname(filePath));
  const root = await fs.promises.realpath(userData);
  const relative = path.relative(root, directory);
  if (!relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) {
    throw fail('PROTECTED_EXPORT_PATH', 'Hãy chọn nơi lưu ngoài thư mục dữ liệu SqlPro.');
  }
}

async function copyArchiveExclusive(source, destination, { signal, checkContext = () => {} } = {}) {
  const before = await fs.promises.lstat(source);
  if (!before.isFile() || before.size > 12 * 1024 ** 3) throw fail('INVALID_BACKUP_ARCHIVE', 'Archive không phải tệp thường hoặc vượt 12 GiB.');
  const info = await inspectBackupContainer(source);
  if (!info.encrypted) throw fail('NOT_ENCRYPTED_BACKUP', 'Chỉ nhập/xuất container mã hóa SqlPro.');
  const temporary = `${destination}.${crypto.randomBytes(8).toString('hex')}.part`;
  const checksum = crypto.createHash('sha256');
  let bytes = 0;
  const budget = new Transform({
    transform(chunk, encoding, done) {
      bytes += chunk.length;
      if (bytes > before.size) { done(fail('BACKUP_FILE_CHANGED', 'Archive thay đổi khi sao chép.')); return; }
      checksum.update(chunk); done(null, chunk);
    }
  });
  try {
    await pipeline(fs.createReadStream(source), budget, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal });
    const handle = await fs.promises.open(temporary, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    await checkContext();
    if (signal?.aborted) throw fail('BACKUP_CRYPTO_CANCELLED', 'Đã hủy sao chép archive.');
    if (bytes !== before.size || !sameFileIdentity(fileIdentity(before), fileIdentity(await fs.promises.lstat(source)))) {
      throw fail('BACKUP_FILE_CHANGED', 'Archive thay đổi khi sao chép.');
    }
    await checkContext();
    await fs.promises.link(temporary, destination);
    return { bytes, fileChecksum: checksum.digest('hex'), authenticated: false, version: info.version };
  } finally { await fs.promises.rm(temporary, { force: true }); }
}

module.exports = { assertExternalDestination, copyArchiveExclusive };
