'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { serialize } = require('node:v8');
const { assertWritable } = require('./connection-policy.cjs');

function targetIdentity(profile) {
  return crypto.createHash('sha256').update(serialize({
    id: profile.id, host: profile.host, port: profile.port || 3306,
    user: profile.user, ssh: profile.ssh, ssl: profile.ssl
  })).digest('hex');
}

function validateRecord(record) {
  if (!record || record.version !== 1 || !/^[a-f0-9]{32}$/.test(record.id)
      || !/^sqlpro_trial_[a-f0-9]{32}$/.test(record.database)
      || !/^owner_[a-f0-9]{24}$/.test(record.marker)
      || !/^[a-f0-9]{64}$/.test(record.token)
      || !/^[a-f0-9]{64}$/.test(record.target)
      || typeof record.profileId !== 'string' || typeof record.startedAt !== 'string') {
    throw new Error('Nhật ký database thử không hợp lệ. Giữ nguyên tệp để kiểm tra.');
  }
  return record;
}

// Each authenticated, encrypted record is independent: one damaged record must
// never erase other recovery evidence. Writes precede CREATE DATABASE.
function createTrialJournal({ directory, seal, unseal }) {
  function location(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw new Error('Mã nhật ký không hợp lệ.');
    return path.join(directory, `${id}.json`);
  }
  function read(id) {
    const file = location(id);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 65536) throw new Error('Tệp nhật ký không hợp lệ.');
    const record = validateRecord(JSON.parse(unseal(JSON.parse(fs.readFileSync(file, 'utf8')))));
    if (record.id !== id) throw new Error('Mã nhật ký không khớp.');
    return record;
  }
  function prepare(profile, ownership) {
    const record = validateRecord({ ...ownership, version: 1,
      id: crypto.randomBytes(16).toString('hex'), profileId: profile.id,
      target: targetIdentity(profile), startedAt: new Date().toISOString() });
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.readdirSync(directory).length >= 1000) throw new Error('Nhật ký database thử đã đầy. Hãy kiểm tra các database tạm còn sót.');
    const file = location(record.id);
    const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.part`;
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify(seal(JSON.stringify(record))));
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor); descriptor = undefined;
      fs.renameSync(temporary, file);
      return record.id;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      fs.rmSync(temporary, { force: true });
    }
  }
  function remove(id) { fs.rmSync(location(id), { force: true }); }
  function list(profile) {
    let files;
    try { files = fs.readdirSync(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (files.length > 1000) throw new Error('Nhật ký database thử vượt giới hạn. Cần kiểm tra thư mục nhật ký.');
    return files.filter(file => /^[a-f0-9]{32}\.json$/.test(file)).map(file => read(file.slice(0, -5)))
      .filter(record => record.profileId === profile.id)
      .map(record => ({ id: record.id, database: record.database, startedAt: record.startedAt,
        targetMatches: record.target === targetIdentity(profile) }));
  }
  return { prepare, read, remove, list };
}

async function cleanupTrialDatabase(session, record, profile = session.profile) {
  validateRecord(record);
  assertWritable(session.profile);
  if (targetIdentity(profile) !== record.target) throw new Error('Đích kết nối đã thay đổi; không dọn database trên máy chủ khác.');
  // Names are generated and validated above, never accepted as arbitrary SQL.
  let ownership;
  try {
    ownership = await session.raw(`SELECT token FROM \`${record.database}\`.\`${record.marker}\``, [], 15000);
  } catch (error) {
    if (error.code === 'ER_BAD_DB_ERROR' || error.errno === 1049) return { cleanup: 'already-removed' };
    // Missing marker/table may also mean the whole schema is absent. Check the
    // schema explicitly, without interpreting an arbitrary SELECT error as absence.
    if (error.code === 'ER_NO_SUCH_TABLE' || error.errno === 1146) {
      const exists = await session.raw('SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?', [record.database], 15000);
      if (exists.rows?.length === 0) return { cleanup: 'already-removed' };
    }
    throw error;
  }
  if (ownership.rows?.length !== 1 || ownership.rows[0].token !== record.token) throw new Error('Marker sở hữu không khớp. Giữ nguyên database để kiểm tra thủ công.');
  await session.raw(`DROP DATABASE \`${record.database}\``, [], 15000);
  return { cleanup: 'removed' };
}

module.exports = { createTrialJournal, cleanupTrialDatabase, targetIdentity };
