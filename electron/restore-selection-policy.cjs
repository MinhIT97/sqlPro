'use strict';

const validName = value => typeof value === 'string' && value.length > 0 && value.length <= 64 && !value.includes('\0');

function normalizeConflictPolicy(value = 'stop-on-conflict') {
  if (value !== 'stop-on-conflict' && value !== 'skip-existing') {
    throw Object.assign(new Error('Chính sách xung đột chưa được hỗ trợ. Chỉ chọn chặn khi trùng hoặc bỏ qua bảng đã thấy.'), { code: 'INVALID_RESTORE_CONFLICT_POLICY' });
  }
  return value;
}

// Review proposals only. Account-visible metadata cannot prove absence, grant
// permissions, certify append compatibility or authorize destructive changes.
function reviewConflictPolicy({ source, targetReview, conflictPolicy }) {
  const policy = normalizeConflictPolicy(conflictPolicy);
  if (source?.canExecute !== false || targetReview?.canExecute !== false || !Array.isArray(source.rows) || !source.rows.length
      || typeof source.includeStructure !== 'boolean' || typeof source.includeData !== 'boolean' || !source.includeStructure && !source.includeData
      || source.rows.length > 1000 || source.rows.some(row => !validName(row.name))
      || new Set(source.rows.map(row => row.name)).size !== source.rows.length) throw new Error('Thiếu phạm vi nguồn để review chính sách xung đột.');
  const caseKnown = [0, 1, 2].includes(targetReview.lowerCaseTableNames);
  const key = name => targetReview.lowerCaseTableNames === 0 ? name : name.toLowerCase();
  const status = targetReview.metadataStatus;
  const metadataKnown = caseKnown && status?.complete === true && status.databaseVisible === true && !targetReview.findingsTruncated
    && Array.isArray(targetReview.rows) && targetReview.rows.length <= 1000;
  const grouped = new Map();
  for (const row of source.rows) grouped.set(key(row.name), (grouped.get(key(row.name)) || 0) + 1);
  const observations = new Map();
  for (const row of (Array.isArray(targetReview.rows) ? targetReview.rows : []).slice(0, 1000)) {
    const list = observations.get(row.name) || []; list.push(row); observations.set(row.name, list);
  }
  const rows = source.rows.map(row => {
    const result = { name: row.name, observed: 'unknown', disposition: 'blocked', proposal: null, reason: 'POLICY_METADATA_INCOMPLETE', requires: ['POLICY_TARGET_RECHECK_REQUIRED'] };
    if (!metadataKnown) return result;
    if (grouped.get(key(row.name)) > 1) return { ...result, reason: 'POLICY_SOURCE_NAME_AMBIGUOUS' };
    const matches = observations.get(row.name);
    if (matches?.length !== 1) return result;
    const observed = matches[0];
    if (!Array.isArray(observed.objects) || !Number.isSafeInteger(observed.objectCount) || observed.objectCount < 0
        || observed.objectCount !== observed.objects.length || observed.objects.some(object => !validName(object.name)
          || !['table', 'view'].includes(object.type) || key(object.name) !== key(row.name))) return result;
    if (observed.objectCount > 1) return { ...result, reason: 'POLICY_TARGET_NAME_AMBIGUOUS' };
    if (observed.objects[0]?.type === 'view') return { ...result, observed: 'view', reason: 'POLICY_VIEW_CONFLICT' };
    if (observed.objectCount === 1) {
      result.observed = 'table';
      if (policy === 'skip-existing') return { ...result, disposition: 'skip', proposal: 'skip-table', reason: 'POLICY_SKIP_EXISTING_TABLE' };
      if (source.includeStructure) return { ...result, reason: 'POLICY_TABLE_EXISTS' };
      return { ...result, disposition: 'review', proposal: 'append-data', reason: 'POLICY_APPEND_REQUIRES_REVIEW',
        requires: [...result.requires, 'POLICY_APPEND_VALUES_NOT_VALIDATED'] };
    }
    result.observed = 'not-seen';
    if (!source.includeStructure) return { ...result, reason: 'POLICY_DATA_TABLE_NOT_SEEN' };
    return { ...result, disposition: 'review', proposal: 'create-table', reason: 'POLICY_CREATE_REQUIRES_REVIEW',
      requires: [...result.requires, 'POLICY_ABSENCE_NOT_PROVEN'] };
  });
  const skipped = new Set(rows.filter(row => row.disposition === 'skip').map(row => key(row.name)));
  for (const [index, row] of rows.entries()) {
    if (row.disposition !== 'review' || !skipped.size) continue;
    const dependencies = source.rows[index].dependencies;
    if (!Array.isArray(dependencies) || dependencies.some(ref => !ref || !validName(ref.table)
        || ref.schema !== null && ref.schema !== undefined && !validName(ref.schema))) {
      row.disposition = 'blocked'; row.reason = 'POLICY_DEPENDENCIES_UNKNOWN'; continue;
    }
    if (dependencies.some(ref => (!ref.schema || ref.schema === source.sourceDatabase) && validName(ref.table) && skipped.has(key(ref.table)))) {
      row.disposition = 'blocked'; row.reason = 'POLICY_DEPENDENCY_SKIPPED';
    }
  }
  const totals = { review: 0, skip: 0, blocked: 0 };
  for (const row of rows) totals[row.disposition]++;
  return { version: 1, canExecute: false, policy, rows, totals, destructiveChangesAllowed: false };
}

module.exports = { normalizeConflictPolicy, reviewConflictPolicy };
