'use strict';

const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { withAnnotationLock } = require('./backup-annotations.cjs');
const { readManifest, writeManifest, fileIdentity, sameFileIdentity } = require('./backup-file.cjs');

async function recordBackupTrial(filePath, report, sourceIdentity) {
  return withAnnotationLock(filePath, async () => {
    const target = `${filePath}.trial.json`, temporary = `${target}.${crypto.randomBytes(8).toString('hex')}.part`;
    try {
      const text = JSON.stringify(report, null, 2);
      if (Buffer.byteLength(text) > 256 * 1024) throw new Error('Báo cáo phục hồi thử vượt 256 KiB.');
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, target);
      const { manifest, error } = await readManifest(filePath);
      if (error) throw new Error('Manifest lỗi; giữ nguyên trạng thái phục hồi của manifest.');
      if (!manifest) return report;
      const current = await fs.lstat(filePath);
      const unchanged = current.isFile() && sameFileIdentity(sourceIdentity, fileIdentity(current));
      const verified = unchanged && report.status === 'verified' && report.cleanup === 'removed'
        && report.checksum === manifest.checksum.value.toLowerCase();
      await writeManifest(filePath, { ...manifest, verification: {
        ...manifest.verification, restore: verified ? 'verified' : 'not-tested',
        ...(verified ? { checksum: 'verified', file: fileIdentity(current) } : {}),
        restoreCheckedAt: report.finishedAt || null
      } });
      if (!unchanged) report.sourceChanged = true;
    } catch {
      report.reportSaveError = 'Không lưu đầy đủ báo cáo/manifest; hãy xác minh lại bản sao lưu.';
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
    return report;
  });
}

module.exports = { recordBackupTrial };
