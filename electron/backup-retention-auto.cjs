'use strict';

const { createRetentionHistory } = require('./backup-retention-history.cjs');

async function runAutomaticRetention({ root, profileId, database, backupId, stats, settings, service,
  isCanceled = () => false, signal, onProgress = () => {}, onHistory = () => {}, checkContext = () => {} }) {
  if (!settings?.automaticAfterBackup || !settings.policy) return { status: 'disabled' };
  if (isCanceled() || signal?.aborted) return { status: 'stopped', deleted: [], remaining: [], failed: [], reclaimedBytes: 0 };
  if (stats?.manifestError || !stats?.manifestPath || stats.verification?.fileWritten !== true
      || stats.verification?.checksum !== 'verified') return { status: 'skipped', reason: 'Backup mới chưa có manifest/checksum hợp lệ.' };
  let history, historyId, candidates;
  try {
    checkContext();
    const preview = await service.preview(profileId, database, settings.policy, { requiredBackupId: backupId });
    checkContext();
    if (isCanceled() || signal?.aborted) return { status: 'stopped', deleted: [], remaining: [], failed: [], reclaimedBytes: 0 };
    if (!preview.token) return { status: 'skipped', reason: preview.removeCount > 100
      ? 'Danh sách vượt 100 bản; hãy xem trước và dọn thủ công.' : 'Không có bản đủ điều kiện tự dọn trong giới hạn hiện tại.', warnings: preview.warnings };
    const entry = service.consume(profileId, database, preview.token);
    candidates = entry.plan.rows.filter(row => row.action === 'remove');
    history = createRetentionHistory(root);
    historyId = history.begin(profileId, database, entry.plan, { mode: 'automatic', triggerBackupId: backupId });
    onHistory(historyId);
    const result = await service.apply(entry, { isCanceled, signal, onProgress, checkContext });
    try { history.finish(profileId, database, historyId, result); }
    catch (error) { result.historySaveError = error.message; }
    return { ...result, historyId, warnings: preview.warnings, status: result.stopped ? 'stopped' : result.failed.length ? 'failed' : 'completed' };
  } catch (error) {
    if (historyId) {
      try { history.finish(profileId, database, historyId, { deleted: [], remaining: candidates.map(row => row.id), reclaimedBytes: 0,
        failed: [{ id: candidates[0].id, sqlDeleted: false, code: error.code || 'BACKUP_RETENTION_FAILED' }] }); }
      catch { /* Keep incomplete evidence if the report cannot be finalized. */ }
    }
    return { status: 'failed', reason: error.message, code: error.code || 'BACKUP_RETENTION_FAILED', ...(historyId ? { historyId } : {}) };
  }
}

module.exports = { runAutomaticRetention };
