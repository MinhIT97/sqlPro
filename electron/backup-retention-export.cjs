'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildRetentionHistoryReport } = require('./backup-retention-history.cjs');

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function exportRetentionHistory({ filePath, userData, records, appVersion, activeHistoryId = null }) {
  if (typeof filePath !== 'string' || !filePath || !path.isAbsolute(filePath)) throw new Error('Đường dẫn xuất báo cáo không hợp lệ.');
  // Resolve directory aliases before excluding managed files. Replace the final
  // file atomically rather than following a destination symlink when writing.
  const [directory, protectedRoot] = await Promise.all([fs.realpath(path.dirname(filePath)), fs.realpath(userData)]);
  const target = path.join(directory, path.basename(filePath));
  if (isWithin(protectedRoot, target)) throw new Error('Hãy lưu báo cáo bên ngoài thư mục dữ liệu của SqlPro để giữ nguyên backup và cấu hình.');
  const report = buildRetentionHistoryReport(records, { appVersion, activeHistoryId });
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('Báo cáo vượt giới hạn 2 MiB.');
  const temporary = path.join(directory, `.sqlpro-report-${crypto.randomBytes(16).toString('hex')}.part`);
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(text); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, target);
  } finally { await fs.rm(temporary, { force: true }); }
  return { canceled: false, records: report.records.length };
}

module.exports = { exportRetentionHistory };
