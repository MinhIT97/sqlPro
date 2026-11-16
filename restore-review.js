'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SqlRestoreReview = api;
}(typeof globalThis === 'object' ? globalThis : this, () => {
  const digest = value => typeof value === 'string' && value.length === 64 && /^[a-f0-9]+$/.test(value);
  const name = (value, maximum) => typeof value === 'string' && value.length > 0 && value.length <= maximum && !value.includes('\0');
  const version = value => Number.isSafeInteger(value) && value > 0 && value <= 10000;
  const sameTables = (left, right) => Array.isArray(left) && left.length === right.length
    && left.every(value => name(value, 64)) && JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());

  // A short-lived renderer observation, never a stored plan, permission or data
  // revision. Copy only identifiers produced by main, not SQL or review bodies.
  function captureObservation(request, result) {
    const target = result?.targetReview, plan = result?.draftPlan;
    if (![request?.profileId, request?.id].every(value => name(value, 128))
        || ![request?.database, request?.targetDatabase].every(value => name(value, 64))
        || !['stop-on-conflict', 'skip-existing'].includes(request.conflictPolicy)
        || typeof request.includeStructure !== 'boolean' || typeof request.includeData !== 'boolean' || !request.includeStructure && !request.includeData
        || !Array.isArray(request.tables) || !request.tables.length || request.tables.length > 1000
        || request.tables.some(value => !name(value, 64)) || new Set(request.tables).size !== request.tables.length
        || target?.canExecute !== false || plan?.canExecute !== false || !version(target.version) || !version(plan.version)
        || ![result.checksum, target.metadataId, target.snapshotId, plan.planId].every(digest)
        || target.database !== request.targetDatabase || plan.targetDatabase !== request.targetDatabase || plan.sourceDatabase !== request.database
        || plan.checksum !== result.checksum || plan.targetSnapshotId !== target.snapshotId
        || !sameTables(plan.selection?.tables, request.tables) || plan.selection.includeStructure !== request.includeStructure || plan.selection.includeData !== request.includeData
        || plan.conflictPolicyReview?.policy !== request.conflictPolicy
        || typeof target.checkedAt !== 'string' || target.checkedAt.length > 40 || !Number.isFinite(Date.parse(target.checkedAt))) return null;
    return Object.freeze({ version: 1,
      scope: JSON.stringify([request.profileId, request.database, request.id, request.targetDatabase, request.conflictPolicy,
        request.includeStructure, request.includeData, [...request.tables].sort()]),
      checksum: result.checksum, metadataId: target.metadataId, snapshotId: target.snapshotId, planId: plan.planId,
      targetVersion: target.version, planVersion: plan.version, checkedAt: target.checkedAt });
  }

  function compareObservations(previous, current) {
    const valid = value => value?.version === 1 && typeof value.scope === 'string' && value.scope.length <= 400000
      && [value.checksum, value.metadataId, value.snapshotId, value.planId].every(digest)
      && version(value.targetVersion) && version(value.planVersion) && name(value.checkedAt, 40) && Number.isFinite(Date.parse(value.checkedAt));
    const report = status => ({ version: 1, canExecute: false, status, sourceChanged: null, metadataChanged: null, planChanged: null });
    if (!valid(current)) return report('unknown');
    if (!valid(previous)) return report('baseline');
    if (previous.scope !== current.scope) return report('different-scope');
    if (previous.targetVersion !== current.targetVersion || previous.planVersion !== current.planVersion) return report('different-version');
    const sourceChanged = previous.checksum !== current.checksum, metadataChanged = previous.metadataId !== current.metadataId;
    const planChanged = previous.planId !== current.planId;
    if ((!sourceChanged && !metadataChanged && previous.snapshotId !== current.snapshotId)
        || (sourceChanged || metadataChanged) && (previous.snapshotId === current.snapshotId || !planChanged)) return report('unknown');
    return { ...report(sourceChanged || metadataChanged || planChanged ? 'changed' : 'unchanged'), sourceChanged, metadataChanged, planChanged };
  }

  return Object.freeze({ captureObservation, compareObservations });
}));
