'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Preferences = require('../table-preferences.js');
const MAX_BYTES = 128 * 1024;

function createTablePreferences(root) {
  function location(input) {
    const scope = Preferences.scope(input);
    const key = JSON.stringify([scope.profileId, scope.database, scope.table]);
    return { scope, file: path.join(root, 'table-preferences', `${crypto.createHash('sha256').update(key).digest('hex')}.json`) };
  }
  function read(input) {
    const { scope, file } = location(input);
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Tệp cấu hình bảng không hợp lệ; giữ nguyên tệp để kiểm tra.');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!record || record.version !== 1 || Object.keys(record).some(key => !['version', 'scope', 'view', 'updatedAt'].includes(key))
        || JSON.stringify(Preferences.scope(record.scope)) !== JSON.stringify(scope)
        || typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))) throw new Error('Định dạng cấu hình bảng không hợp lệ.');
    return { view: Preferences.normalize(record.view), updatedAt: record.updatedAt };
  }
  function save(input, view) {
    const { scope, file } = location(input);
    const normalized = Preferences.normalize(view);
    // Preserve corrupt/future-version files, rather than replacing them silently.
    read(scope);
    const updatedAt = new Date().toISOString();
    const contents = JSON.stringify({ version: 1, scope, view: normalized, updatedAt });
    if (Buffer.byteLength(contents) > MAX_BYTES) throw new Error('Cấu hình bảng vượt giới hạn 128 KiB.');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.part`;
    try {
      fs.writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
    return { view: normalized, updatedAt };
  }
  function remove(input) {
    const { file } = location(input);
    read(input);
    fs.rmSync(file, { force: true });
    return { removed: true };
  }
  return Object.freeze({ read, save, remove });
}

module.exports = { createTablePreferences };
