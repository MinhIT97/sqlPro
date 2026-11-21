'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { Client } = require('ssh2');
const { verifySshHostKey } = require('./database.cjs');
const { fileIdentity, sameFileIdentity } = require('./backup-file.cjs');
const { inspectBackupContainer } = require('./backup-crypto.cjs');
const fail = (code, message) => Object.assign(new Error(message), { code });

function validateRemoteDirectory(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 1024
      || /[\x00-\x1f\x7f\\]/.test(value) || value.split('/').includes('..')) {
    throw fail('INVALID_REPLICA_DIRECTORY', 'Đường dẫn SFTP phải tuyệt đối và không chứa .. hoặc ký tự điều khiển.');
  }
  return path.posix.normalize(value);
}

async function replicateEncryptedArchive({ sourceFile, ssh, destinationDir, signal, checkContext = () => {},
  createClient = () => new Client(), timeoutMs = 600000 }) {
  const directory = validateRemoteDirectory(destinationDir);
  if (!ssh?.enabled || !ssh.host || !ssh.user || !ssh.knownHostKey?.fingerprint) {
    throw fail('REPLICA_SSH_REQUIRED', 'Cần cấu hình SSH và host key đã tin cậy trên kết nối này.');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw fail('INVALID_REPLICA_OPTIONS', 'Thời hạn SFTP không hợp lệ.');
  const before = await fs.promises.lstat(sourceFile);
  if (!before.isFile() || before.size > 12 * 1024 ** 3 || !(await inspectBackupContainer(sourceFile)).encrypted) {
    throw fail('INVALID_BACKUP_ARCHIVE', 'Chỉ gửi archive mã hóa thông thường, tối đa 12 GiB.');
  }
  if (signal?.aborted) throw fail('REPLICA_CANCELLED', 'Đã hủy gửi replica.');
  checkContext();
  const client = createClient(), controller = new AbortController();
  let rejectStopped, stoppedError, closing = false, sftp, remoteDirectory = null, commitStarted = false;
  const stopped = new Promise((resolve, reject) => { rejectStopped = reject; });
  stopped.catch(() => {});
  const stop = error => {
    if (closing || stoppedError) return;
    stoppedError = error; controller.abort(); rejectStopped(error);
    try { client.destroy(); } catch {}
  };
  const abort = () => stop(fail('REPLICA_CANCELLED', 'Đã hủy gửi replica.'));
  const timer = setTimeout(() => stop(fail('REPLICA_TIMEOUT', 'Gửi replica vượt thời gian cho phép.')), timeoutMs);
  signal?.addEventListener('abort', abort, { once: true });
  const check = () => { if (stoppedError) throw stoppedError; checkContext(); };
  const bounded = async pending => { check(); const value = await Promise.race([pending, stopped]); check(); return value; };
  const invoke = (name, ...args) => {
    check();
    return bounded(new Promise((resolve, reject) => {
    try { sftp[name](...args, (error, value) => error ? reject(error) : resolve(value)); }
    catch (error) { reject(error); }
    }));
  };
  client.on('error', () => stop(fail('REPLICA_NETWORK_FAILED', 'Kết nối SFTP lỗi; bản local được giữ nguyên.')));
  client.on('close', () => { if (!closing) stop(fail('REPLICA_NETWORK_FAILED', 'Kết nối SFTP bị đóng.')); });
  try {
    let hostFailure;
    const options = { host: ssh.host, port: ssh.port || 22, username: ssh.user, readyTimeout: 15000,
      keepaliveInterval: 15000, keepaliveCountMax: 3,
      hostVerifier: key => {
        const result = verifySshHostKey(ssh.knownHostKey, ssh.host, ssh.port || 22, key);
        if (!result.ok) hostFailure = fail(result.code, 'SSH host key chưa khớp cấu hình đã tin cậy; chưa gửi replica.');
        return result.ok;
      } };
    if (ssh.authMethod === 'key') {
      const stat = await fs.promises.stat(ssh.privateKeyPath);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw fail('SSH_KEY_READ_FAILED', 'Không đọc được SSH private key hợp lệ.');
      options.privateKey = await fs.promises.readFile(ssh.privateKeyPath);
      if (ssh.passphrase) options.passphrase = ssh.passphrase;
    } else options.password = ssh.password || '';
    check();
    try {
      await bounded(new Promise(resolve => {
        client.once('ready', resolve);
        client.connect(options);
      }));
    } catch (error) { throw hostFailure || error; }
    sftp = await bounded(new Promise((resolve, reject) => client.sftp((error, value) => error ? reject(error) : resolve(value))));
    const root = await invoke('stat', directory);
    if (!root.isDirectory()) throw fail('INVALID_REPLICA_DIRECTORY', 'Đích SFTP không phải thư mục.');
    // A fresh private directory isolates every attempt and every publication.
    // Never use posix-rename (overwrites), shell commands or a reusable remote name.
    const candidate = path.posix.join(directory, `sqlpro-replica-${crypto.randomBytes(16).toString('hex')}`);
    await invoke('mkdir', candidate, { mode: 0o700 }); remoteDirectory = candidate;
    const temporary = path.posix.join(remoteDirectory, '.archive.part');
    const finalPath = path.posix.join(remoteDirectory, path.basename(sourceFile));
    let bytes = 0;
    const hash = crypto.createHash('sha256');
    const meter = new Transform({ transform(chunk, encoding, done) {
      try { check(); bytes += chunk.length; if (bytes > before.size) throw fail('REPLICA_SOURCE_CHANGED', 'Archive local đã thay đổi.');
        hash.update(chunk); done(null, chunk); } catch (error) { done(error); }
    } });
    await bounded(pipeline(fs.createReadStream(sourceFile), meter,
      sftp.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal: controller.signal }));
    const checksum = hash.digest('hex');
    const observed = crypto.createHash('sha256');
    let remoteBytes = 0;
    const remoteRead = sftp.createReadStream(temporary);
    const abortRead = () => remoteRead.destroy(stoppedError || fail('REPLICA_CANCELLED', 'Đã hủy đọc replica.'));
    controller.signal.addEventListener('abort', abortRead, { once: true });
    try {
      await bounded((async () => {
        for await (const chunk of remoteRead) {
          check(); remoteBytes += chunk.length;
          if (remoteBytes > before.size) throw fail('REPLICA_CHECKSUM_MISMATCH', 'Archive đọc lại từ SFTP vượt kích thước nguồn.');
          observed.update(chunk);
        }
      })());
    } finally { controller.signal.removeEventListener('abort', abortRead); remoteRead.destroy(); }
    if (bytes !== before.size || remoteBytes !== bytes || observed.digest('hex') !== checksum) {
      throw fail('REPLICA_CHECKSUM_MISMATCH', 'Checksum đọc lại từ SFTP không khớp nguồn; chưa công bố replica.');
    }
    let durability = 'server-acknowledged';
    // Windows-backed SFTP servers need a writable handle for fsync.
    const handle = await invoke('open', temporary, 'r+');
    try {
      try { await invoke('ext_openssh_fsync', handle); durability = 'fsync'; }
      catch (error) { if (error.code !== 8 && !/does not support.*extended/i.test(error.message)) throw error; }
    } finally { await invoke('close', handle); }
    if (!sameFileIdentity(fileIdentity(before), fileIdentity(await fs.promises.lstat(sourceFile)))) {
      throw fail('REPLICA_SOURCE_CHANGED', 'Archive local thay đổi trước khi công bố replica.');
    }
    check(); commitStarted = true;
    await invoke('rename', temporary, finalPath);
    return { remotePath: finalPath, bytes, fileChecksum: checksum, verified: true,
      verification: 'readback-sha256', durability, restore: 'not-tested' };
  } catch (error) {
    if (commitStarted) throw fail('REPLICA_COMMIT_UNCERTAIN', `Chưa xác nhận được việc công bố replica. Kiểm tra thư mục ${remoteDirectory}; không tự retry.`);
    if (remoteDirectory && sftp && !stoppedError) {
      try { await invoke('unlink', path.posix.join(remoteDirectory, '.archive.part')); await invoke('rmdir', remoteDirectory); } catch {}
    }
    if (error.code && typeof error.code === 'string' && /^(REPLICA_|INVALID_|SSH_)/.test(error.code)) throw error;
    throw fail('REPLICA_TRANSFER_FAILED', 'Không gửi được replica SFTP; bản local được giữ nguyên. Có thể còn thư mục tạm ở đích.');
  } finally {
    closing = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
    try { sftp?.end(); } catch {}
    try { client.end(); } catch {}
  }
}

module.exports = { replicateEncryptedArchive, validateRemoteDirectory };
