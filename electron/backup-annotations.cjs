'use strict';

const fs = require('node:fs/promises');
const crypto = require('node:crypto');

const pending = new Map();

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_BACKUP_ANNOTATIONS' });
}

function normalizeBackupDisplayName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120 || /[\x00-\x1f\x7f]/.test(value)) {
    throw Object.assign(new Error('Tên bản sao lưu phải có từ 1 đến 120 ký tự và không chứa ký tự điều khiển.'), { code: 'INVALID_BACKUP_NAME' });
  }
  return value.trim();
}

function normalizeAnnotations(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || (value.version !== undefined && value.version !== 1)) throw invalid('Định dạng ghi chú backup chưa được hỗ trợ.');
  const note = value.note === undefined ? '' : value.note;
  const pinned = value.pinned === undefined ? false : value.pinned;
  if (typeof note !== 'string' || note.length > 2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(note)) throw invalid('Ghi chú tối đa 2.000 ký tự và không chứa ký tự điều khiển.');
  if (typeof pinned !== 'boolean') throw invalid('Trạng thái ghim backup không hợp lệ.');
  return { version: 1, ...(value.name === undefined ? {} : { name: normalizeBackupDisplayName(value.name) }), note, pinned };
}

async function readAnnotations(filePath) {
  const target = `${filePath}.name.json`;
  let stats;
  try { stats = await fs.lstat(target); }
  catch (error) { if (error.code === 'ENOENT') return normalizeAnnotations({}); throw error; }
  if (!stats.isFile() || stats.size > 16384) throw invalid('Tệp ghi chú backup không hợp lệ hoặc vượt 16 KiB.');
  try { return normalizeAnnotations(JSON.parse(await fs.readFile(target, 'utf8'))); }
  catch (error) { if (error instanceof SyntaxError) throw invalid('Không đọc được ghi chú backup. Tệp được giữ nguyên.'); throw error; }
}

async function writeAnnotations(filePath, value, { exclusive = false } = {}) {
  const normalized = normalizeAnnotations(value);
  const target = `${filePath}.name.json`;
  const temporary = `${target}.${crypto.randomBytes(8).toString('hex')}.part`;
  try {
    await fs.writeFile(temporary, JSON.stringify(normalized), { flag: 'wx', mode: 0o600 });
    if (exclusive) await fs.link(temporary, target);
    else await fs.rename(temporary, target);
  } finally { await fs.rm(temporary, { force: true }); }
  return normalized;
}

// Serialize metadata edits and deletion for the same backup inside main. Failed
// writes release the queue, and concurrent rename/note/pin edits merge in order.
async function withAnnotationLock(filePath, operation) {
  const previous = pending.get(filePath) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  pending.set(filePath, current);
  try { return await current; }
  finally { if (pending.get(filePath) === current) pending.delete(filePath); }
}

module.exports = { normalizeBackupDisplayName, normalizeAnnotations, readAnnotations, writeAnnotations, withAnnotationLock };
