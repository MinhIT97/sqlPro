'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const SqlAuditLog = require('../audit-log.js');

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB quota
const MAX_ENTRIES = 1000;

function createAuditLogStore(root) {
  const filePath = path.join(root, 'audit-log.json');

  function readRaw() {
    let stat;
    try {
      stat = fs.lstatSync(filePath);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    if (!stat.isFile() || stat.size > MAX_BYTES) {
      throw new Error('Tệp nhật ký thao tác vượt quá giới hạn hoặc không hợp lệ; giữ nguyên tệp để bảo vệ dữ liệu.');
    }

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      throw new Error('Tệp nhật ký thao tác bị hỏng cú pháp; giữ nguyên tệp để kiểm tra.');
    }

    if (!parsed || parsed.version !== SqlAuditLog.AUDIT_VERSION || !Array.isArray(parsed.entries)) {
      throw new Error('Định dạng tệp nhật ký thao tác không khớp phiên bản được hỗ trợ.');
    }

    // Apply current privacy rules to legacy entries before UI/export or a rewrite.
    return parsed.entries.map(entry => SqlAuditLog.createAuditEntry(entry));
  }

  function writeRaw(entries) {
    const pruned = SqlAuditLog.pruneAuditEntries(entries, { maxEntries: MAX_ENTRIES });
    const payload = JSON.stringify({
      version: SqlAuditLog.AUDIT_VERSION,
      updatedAt: new Date().toISOString(),
      entries: pruned
    });

    if (Buffer.byteLength(payload) > MAX_BYTES) {
      throw new Error('Kích thước nhật ký thao tác vượt quá giới hạn 2 MB.');
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${crypto.randomBytes(8).toString('hex')}.part`;
    try {
      fs.writeFileSync(temporary, payload, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, filePath);
    } finally {
      fs.rmSync(temporary, { force: true });
    }

    return pruned;
  }

  function read(filter) {
    const entries = readRaw();
    if (!filter) return entries;
    return SqlAuditLog.filterAuditEntries(entries, filter);
  }

  function append(entryInput) {
    const entry = SqlAuditLog.createAuditEntry(entryInput);
    let entries = [];
    try {
      entries = readRaw();
    } catch (err) {
      // If reading fails due to file issue, don't overwrite if corrupt
      throw err;
    }

    entries.unshift(entry);
    writeRaw(entries);
    return entry;
  }

  function prune(options) {
    const entries = readRaw();
    const pruned = SqlAuditLog.pruneAuditEntries(entries, options);
    writeRaw(pruned);
    return { prunedCount: entries.length - pruned.length, remainingCount: pruned.length };
  }

  function clear() {
    writeRaw([]);
    return { cleared: true };
  }

  return Object.freeze({
    read,
    append,
    prune,
    clear,
    filePath
  });
}

module.exports = { createAuditLogStore };
