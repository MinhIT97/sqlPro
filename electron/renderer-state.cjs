'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_STATE_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 3 * 1024 * 1024;
const KIND = 'sqlpro-renderer-state';

function stateError(code, message) {
  return Object.assign(new Error(message), { code });
}

function serializeState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw stateError('STATE_INVALID', 'Trạng thái ứng dụng không hợp lệ.');
  }
  let serialized;
  try { serialized = JSON.stringify(value); }
  catch { throw stateError('STATE_INVALID', 'Trạng thái ứng dụng không thể chuyển thành JSON.'); }
  if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) {
    throw stateError('STATE_TOO_LARGE', 'Trạng thái ứng dụng vượt quá giới hạn 2 MB.');
  }
  return serialized;
}

function createRendererState({ directory, seal, unseal, io = fs }) {
  const file = path.join(directory, 'renderer-state.json');
  function read() {
    let text;
    try {
      const stat = io.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error('Invalid state file');
      text = io.readFileSync(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw stateError('STATE_READ_FAILED', 'Không đọc được trạng thái đã lưu. Tệp được giữ nguyên; hãy kiểm tra quyền truy cập hoặc khôi phục bản sao.');
    }
    let value;
    try {
      value = JSON.parse(text);
      if (value?.kind === KIND) {
        if (value.version !== 1 || !value.sealed || typeof value.sealed !== 'object') throw new Error('Invalid envelope');
        // Keep errors from the key store intact; never fall back to an empty state.
        value = JSON.parse(unseal(value.sealed));
      }
      serializeState(value);
    } catch (error) {
      if (String(error.code || '').startsWith('LOCAL_KEY_') || error.code === 'SECRET_DECRYPT_FAILED') throw error;
      throw stateError('STATE_READ_FAILED', 'Trạng thái đã lưu không đọc được hoặc không tương thích. Tệp được giữ nguyên.');
    }
    return value;
  }

  function save(value) {
    const serialized = serializeState(value);
    // Verify that the old file is recoverable before replacing it, including
    // when renderer init failed or the OS keychain has since been locked.
    read();
    const sealed = seal(serialized);
    if (!sealed || typeof sealed !== 'object' || !['local', 'safeStorage'].includes(sealed.alg)) {
      throw stateError('STATE_ENCRYPT_FAILED', 'Không mã hóa được trạng thái. Chưa ghi tệp mới.');
    }
    const envelope = JSON.stringify({ kind: KIND, version: 1, sealed });
    if (Buffer.byteLength(envelope) > MAX_FILE_BYTES) throw stateError('STATE_TOO_LARGE', 'Trạng thái mã hóa vượt quá giới hạn.');
    io.mkdirSync(directory, { recursive: true });
    const temporary = `${file}.${crypto.randomUUID()}.part`;
    let fd;
    let owned = false;
    try {
      fd = io.openSync(temporary, 'wx', 0o600);
      owned = true;
      io.writeFileSync(fd, envelope, 'utf8');
      io.fsyncSync(fd);
      io.closeSync(fd);
      fd = undefined;
      io.renameSync(temporary, file);
      owned = false;
    } finally {
      if (fd !== undefined) { try { io.closeSync(fd); } catch {} }
      if (owned) { try { io.unlinkSync(temporary); } catch {} }
    }
    return { saved: true };
  }
  return { read, save };
}

module.exports = { createRendererState, serializeState };
