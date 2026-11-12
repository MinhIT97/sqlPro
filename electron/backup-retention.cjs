'use strict';

const DAY_MS = 86400000;

function normalizeRetentionPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['maxCount', 'maxAgeDays', 'maxBytes'].includes(key))) throw new Error('Chính sách lưu backup không hợp lệ.');
  const result = {};
  for (const [key, maximum] of [['maxCount', 100000], ['maxAgeDays', 36500], ['maxBytes', Number.MAX_SAFE_INTEGER]]) {
    const number = value[key] === undefined || value[key] === null ? null : value[key];
    if (number !== null && (!Number.isSafeInteger(number) || number < 1 || number > maximum)) throw new Error('Giới hạn retention phải là số nguyên dương trong phạm vi hỗ trợ.');
    result[key] = number;
  }
  if (Object.values(result).every(value => value === null)) throw new Error('Hãy nhập ít nhất một giới hạn lưu backup.');
  return result;
}

// Planning only. Never use a displayed plan as authorization to delete files.
function planBackupRetention(entries, input, { now = Date.now(), activeIds = [] } = {}) {
  const policy = normalizeRetentionPolicy(input);
  if (!Array.isArray(entries) || !Number.isFinite(now)) throw new Error('Danh sách backup hoặc thời gian không hợp lệ.');
  const seen = new Set();
  const byId = new Map();
  const active = new Set(activeIds);
  const rows = entries.map(entry => {
    if (!entry || typeof entry.id !== 'string' || seen.has(entry.id)) throw new Error('Mã backup bị thiếu hoặc trùng.');
    seen.add(entry.id);
    byId.set(entry.id, entry);
    const time = typeof entry.createdAt === 'string' ? Date.parse(entry.createdAt) : NaN;
    const validBytes = Number.isSafeInteger(entry.bytes) && entry.bytes >= 0;
    const protectedReasons = [];
    if (entry.pinned === true) protectedReasons.push('pinned');
    if (active.has(entry.id)) protectedReasons.push('active');
    if (entry.annotationError || entry.manifestError) protectedReasons.push('metadata-error');
    if (!Number.isFinite(time) || time > now) protectedReasons.push('invalid-date');
    if (!validBytes) protectedReasons.push('invalid-size');
    if (entry.verification?.checksum === 'mismatch') protectedReasons.push('checksum-mismatch');
    return { id: entry.id, name: entry.name || entry.id, bytes: validBytes ? entry.bytes : 0,
      createdAt: entry.createdAt, time, protectedReasons, reasons: [], action: 'keep' };
  }).sort((a, b) => (Number.isFinite(b.time) ? b.time : -Infinity) - (Number.isFinite(a.time) ? a.time : -Infinity) || a.id.localeCompare(b.id));
  const newest = rows.find(row => Number.isFinite(row.time) && row.time <= now);
  if (newest) newest.protectedReasons.push('newest');
  const successful = rows.find(row => {
    const entry = byId.get(row.id);
    return row.protectedReasons.every(reason => ['pinned', 'active', 'newest'].includes(reason))
      && entry.verification?.fileWritten === true && entry.verification?.checksum === 'verified';
  });
  if (successful) successful.protectedReasons.push('latest-verified');
  let totalBytes = rows.reduce((sum, row) => sum + row.bytes, 0);
  if (!Number.isSafeInteger(totalBytes)) throw new Error('Tổng dung lượng backup vượt phạm vi tính toán chính xác.');
  const initialBytes = totalBytes;
  let remainingCount = rows.length;
  const warnings = [];
  if (rows.some(row => row.protectedReasons.includes('invalid-size'))) warnings.push('unknown-size');
  const blocked = rows.length > 0 && !successful;
  if (blocked) warnings.push('no-verified-backup');
  const mark = (row, reason) => {
    if (row.action === 'remove') { if (!row.reasons.includes(reason)) row.reasons.push(reason); return; }
    if (blocked || row.protectedReasons.length) return;
    row.action = 'remove'; row.reasons.push(reason);
    remainingCount--; totalBytes -= row.bytes;
  };
  const oldestFirst = [...rows].reverse();
  if (policy.maxAgeDays !== null) for (const row of oldestFirst) {
    if (now - row.time > policy.maxAgeDays * DAY_MS) mark(row, 'age');
  }
  if (policy.maxCount !== null) for (const row of oldestFirst) {
    if (remainingCount <= policy.maxCount) break;
    mark(row, 'count');
  }
  if (policy.maxBytes !== null) for (const row of oldestFirst) {
    if (totalBytes <= policy.maxBytes) break;
    mark(row, 'bytes');
  }
  if (policy.maxCount !== null && remainingCount > policy.maxCount) warnings.push('count-unmet');
  if (policy.maxBytes !== null && totalBytes > policy.maxBytes) warnings.push('bytes-unmet');
  if (policy.maxAgeDays !== null && rows.some(row => row.action === 'keep' && now - row.time > policy.maxAgeDays * DAY_MS)) warnings.push('age-unmet');
  return { policy, plannedAt: new Date(now).toISOString(), blocked, warnings,
    totalCount: rows.length, removeCount: rows.length - remainingCount, remainingCount,
    totalBytes: initialBytes, removeBytes: initialBytes - totalBytes, remainingBytes: totalBytes,
    rows: rows.map(({ time, ...row }) => row) };
}

module.exports = { normalizeRetentionPolicy, planBackupRetention };
