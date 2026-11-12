'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { backupDirectory } = require('./backup-catalog.cjs');
const { normalizeRetentionPolicy } = require('./backup-retention.cjs');

const BACKUP_ID = /^\d{14}-[a-f0-9]{8}\.sql$/;
const STATES = new Set(['running', 'completed', 'stopped', 'failed']);

function ids(value) {
  if (!Array.isArray(value) || value.length > 100 || value.some(id => typeof id !== 'string' || !BACKUP_ID.test(id)) || new Set(value).size !== value.length) throw new Error('Danh sách trong lịch sử retention không hợp lệ.');
  return [...value];
}

function normalizeRecord(value) {
  if (!value || typeof value.id !== 'string' || !/^[a-f0-9]{32}$/.test(value.id) || !STATES.has(value.state)
      || typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt))
      || (value.finishedAt !== null && (typeof value.finishedAt !== 'string' || !Number.isFinite(Date.parse(value.finishedAt))))
      || (value.state === 'running') !== (value.finishedAt === null)
      || !Number.isSafeInteger(value.reclaimedBytes) || value.reclaimedBytes < 0
      || !Array.isArray(value.failed) || value.failed.length > 100) throw new Error('Bản ghi lịch sử retention không hợp lệ.');
  const planned = ids(value.planned), deleted = ids(value.deleted), remaining = ids(value.remaining);
  if (deleted.some(id => !planned.includes(id)) || remaining.some(id => !planned.includes(id) || deleted.includes(id))
      || value.failed.some(error => !error || !planned.includes(error.id))) throw new Error('Kết quả lịch sử không khớp danh sách đã lên kế hoạch.');
  if (value.state === 'running' && (deleted.length || remaining.length || value.failed.length || value.reclaimedBytes)
      || value.state !== 'running' && deleted.length + remaining.length !== planned.length
      || value.state === 'completed' && (remaining.length || value.failed.length)
      || value.state === 'failed' && !value.failed.length
      || value.failed.some(error => error.sqlDeleted !== deleted.includes(error.id))) throw new Error('Trạng thái lịch sử retention không khớp kết quả.');
  return { id: value.id, state: value.state, startedAt: value.startedAt, finishedAt: value.finishedAt,
    policy: normalizeRetentionPolicy(value.policy), planned, deleted, remaining,
    reclaimedBytes: value.reclaimedBytes, failed: value.failed.map(error => {
      if (!error || typeof error.id !== 'string' || !BACKUP_ID.test(error.id)
          || typeof error.code !== 'string' || !/^[A-Z0-9_]{1,80}$/.test(error.code) || typeof error.sqlDeleted !== 'boolean') throw new Error('Mã lỗi lịch sử retention không hợp lệ.');
      return { id: error.id, code: error.code, sqlDeleted: error.sqlDeleted };
    }) };
}

function createRetentionHistory(root) {
  function location(profileId, database) {
    if (typeof profileId !== 'string' || !profileId || typeof database !== 'string' || !database) throw new Error('Chưa chọn kết nối hoặc database.');
    return path.join(backupDirectory(root, profileId, database), 'retention-history.json');
  }
  function read(profileId, database) {
    const file = location(profileId, database);
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Tệp lịch sử retention không hợp lệ hoặc vượt 1 MiB.');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || value.version !== 1 || !Array.isArray(value.records) || value.records.length > 50) throw new Error('Định dạng lịch sử retention chưa được hỗ trợ.');
    const records = value.records.map(normalizeRecord);
    if (new Set(records.map(record => record.id)).size !== records.length) throw new Error('Lịch sử retention có mã bị trùng.');
    return records;
  }
  function write(profileId, database, records) {
    const file = location(profileId, database);
    const text = JSON.stringify({ version: 1, records: records.map(normalizeRecord) });
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Lịch sử retention vượt giới hạn 1 MiB.');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.part`;
    try {
      fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  function begin(profileId, database, plan) {
    const records = read(profileId, database);
    if (records.filter(record => record.state === 'running').length >= 50) throw new Error('Lịch sử có quá nhiều lượt chưa xác nhận kết thúc. Cần kiểm tra tệp lịch sử trước khi tiếp tục.');
    const record = normalizeRecord({ id: crypto.randomBytes(16).toString('hex'), state: 'running', startedAt: new Date().toISOString(), finishedAt: null,
      policy: plan.policy, planned: plan.rows.filter(row => row.action === 'remove').map(row => row.id),
      deleted: [], remaining: [], failed: [], reclaimedBytes: 0 });
    records.unshift(record);
    while (records.length > 50) {
      const oldest = records.findLastIndex(item => item.state !== 'running');
      records.splice(oldest, 1);
    }
    write(profileId, database, records);
    return record.id;
  }
  function finish(profileId, database, id, result) {
    const records = read(profileId, database);
    const index = records.findIndex(record => record.id === id);
    if (index < 0 || records[index].state !== 'running') throw new Error('Không tìm thấy lượt retention đang chạy để lưu kết quả.');
    records[index] = normalizeRecord({ ...records[index], finishedAt: new Date().toISOString(),
      state: result.stopped ? 'stopped' : result.failed.length ? 'failed' : 'completed',
      deleted: result.deleted, remaining: result.remaining, failed: result.failed.map(error => ({ id: error.id,
        code: /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'BACKUP_RETENTION_FAILED', sqlDeleted: Boolean(error.sqlDeleted) })), reclaimedBytes: result.reclaimedBytes });
    write(profileId, database, records);
  }
  return { read, begin, finish };
}

module.exports = { createRetentionHistory };
