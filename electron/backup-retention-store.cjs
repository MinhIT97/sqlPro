'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { backupDirectory } = require('./backup-catalog.cjs');
const { normalizeRetentionPolicy } = require('./backup-retention.cjs');

function createRetentionStore(root) {
  function location(profileId, database) {
    if (typeof profileId !== 'string' || !profileId || typeof database !== 'string' || !database) throw new Error('Chưa chọn kết nối hoặc database.');
    return path.join(backupDirectory(root, profileId, database), 'retention-policy.json');
  }
  function read(profileId, database) {
    const file = location(profileId, database);
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) { if (error.code === 'ENOENT') return { policy: null, updatedAt: null }; throw error; }
    if (!stat.isFile() || stat.size > 4096) throw new Error('Tệp chính sách retention không hợp lệ. Giữ nguyên tệp để kiểm tra.');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || value.version !== 1 || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) throw new Error('Định dạng chính sách retention chưa được hỗ trợ.');
    return { policy: normalizeRetentionPolicy(value.policy), updatedAt: value.updatedAt };
  }
  function save(profileId, database, input) {
    const policy = normalizeRetentionPolicy(input);
    const file = location(profileId, database);
    // Do not silently replace corrupt or future-version settings.
    read(profileId, database);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const value = { version: 1, policy, updatedAt: new Date().toISOString() };
    const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.part`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
    return { policy, updatedAt: value.updatedAt };
  }
  function clear(profileId, database) {
    const file = location(profileId, database);
    read(profileId, database);
    fs.rmSync(file, { force: true });
    return { policy: null, updatedAt: null };
  }
  return { read, save, clear };
}

module.exports = { createRetentionStore };
