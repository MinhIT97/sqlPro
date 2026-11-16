'use strict';

// This is an observation of the selected table, not a transaction/rollback
// guarantee. Triggers, DDL and a later execution connection need their own review.
function normalizeTargetEngine(value) {
  if (typeof value !== 'string' || value.length > 64 || /^[A-Za-z][A-Za-z0-9_]{0,63}$/.exec(value)?.[0] !== value) return null;
  return value.toLowerCase() === 'innodb' ? 'InnoDB' : value;
}

function reviewTargetEngine(row, { lowerCaseTableNames, metadataComplete, databaseVisible }) {
  const result = { version: 1, status: 'unknown', engine: null, reason: 'TARGET_ENGINE_NOT_REVIEWED',
    requires: ['TARGET_ENGINE_RECHECK_REQUIRED', 'TARGET_INDIRECT_WRITES_NOT_REVIEWED'] };
  if (metadataComplete !== true || databaseVisible !== true || ![0, 1, 2].includes(lowerCaseTableNames)
      || !row || typeof row.name !== 'string' || !row.name.length || row.name.length > 64 || row.name.includes('\0')
      || row.objectCount !== 1 || !Array.isArray(row.objects) || row.objects.length !== 1) return result;
  const object = row.objects[0];
  if (!object || object.type !== 'table' || typeof object.name !== 'string'
      || (lowerCaseTableNames === 0 ? object.name !== row.name : object.name.toLowerCase() !== row.name.toLowerCase())) return result;
  const engine = normalizeTargetEngine(object.engine);
  if (!engine) return result;
  return { ...result, status: 'observed', engine,
    reason: engine === 'InnoDB' ? 'TARGET_ENGINE_INNODB_OBSERVED' : 'TARGET_ENGINE_UNSUPPORTED' };
}

module.exports = { normalizeTargetEngine, reviewTargetEngine };
