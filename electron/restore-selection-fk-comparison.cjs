'use strict';

const { projectForeignKeys } = require('./restore-selection-foreign-keys.cjs');
const validName = value => typeof value === 'string' && value.length > 0 && value.length <= 64 && !/[\u0000-\u001f\u007f]/.test(value);
const ACTIONS = new Set(['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION']);

// Compare structural observations only. Omitted source actions stay unknown;
// matching constraints never grant write authority or prove data validity.
function compareSelectedForeignKeys({ source, targetReview, creates }) {
  const rows = [], findings = [], totals = { matched: 0, differs: 0, unknown: 0, notObserved: 0, targetOnly: 0, notApplicable: 0 };
  let truncated = false, sourceCount = 0, pairs = 0, retainedPairs = 0;
  const flag = code => { if (findings.length < 50) findings.push({ code }); else truncated = true; };
  const retain = row => {
    totals[row.status]++;
    const size = (row.source?.pairs.length || 0) + (row.target?.pairs.length || 0);
    if (rows.length >= 200 || retainedPairs + size > 2000) { truncated = true; return; }
    rows.push(row); retainedPairs += size;
  };
  const knownCase = [0, 1, 2].includes(targetReview.lowerCaseTableNames);
  const key = name => targetReview.lowerCaseTableNames === 0 ? name : name.toLowerCase();
  const target = targetReview.targetForeignKeyReview;
  const targetKnown = target?.version === 1 && target.canExecute === false && target.complete === true && target.truncated === false
    && Array.isArray(target.rows) && target.rows.length <= 200 && target.definitionCount === target.rows.length;
  const observed = [], byOwner = new Map(), used = new Set(), reviewedOwners = new Set(), sourceNames = new Map(), definitions = new Map(), targetObjects = new Map();
  for (const row of (targetReview.rows || []).slice(0, 1000)) {
    const name = key(row.name), group = targetObjects.get(name) || []; group.push(row); targetObjects.set(name, group);
  }
  let targetValid = targetKnown;
  const targetIdentities = new Set();
  for (const row of targetKnown ? target.rows : []) {
    if (!row || row.status !== 'observed' || ![row.name, row.tableSchema, row.table, row.referencedSchema, row.referencedTable].every(validName)
        || !ACTIONS.has(row.onDelete) || !ACTIONS.has(row.onUpdate) || row.match !== 'NONE' || !Array.isArray(row.pairs) || !row.pairs.length
        || row.pairs.length > 16 || row.pairCount !== row.pairs.length || row.pairs.some((part, index) => !part || part.ordinal !== index + 1 || !validName(part.column) || !validName(part.referencedColumn))
        || new Set(row.pairs.map(part => part.column.toLowerCase())).size !== row.pairs.length
        || new Set(row.pairs.map(part => part.referencedColumn.toLowerCase())).size !== row.pairs.length) { targetValid = false; break; }
    const identity = JSON.stringify([key(row.tableSchema), key(row.table), row.name.toLowerCase()]);
    if (targetIdentities.has(identity)) { targetValid = false; break; }
    targetIdentities.add(identity);
    const value = { name: row.name, schema: row.tableSchema, table: row.table, referencedSchema: row.referencedSchema, referencedTable: row.referencedTable,
      pairs: row.pairs.map(part => ({ column: part.column, referencedColumn: part.referencedColumn })), onDelete: row.onDelete, onUpdate: row.onUpdate };
    observed.push(value);
    const owner = JSON.stringify([key(row.tableSchema), key(row.table)]), group = byOwner.get(owner) || [];
    group.push(value); byOwner.set(owner, group);
  }
  if (!targetValid) flag('FK_COMPARE_TARGET_INCOMPLETE');
  for (const row of source.rows) sourceNames.set(key(row.name), (sourceNames.get(key(row.name)) || 0) + 1);
  for (const entry of creates.slice(0, 10000)) {
    const group = definitions.get(entry.table) || []; group.push(entry); definitions.set(entry.table, group);
  }
  if (creates.length > 10000) { truncated = true; flag('FK_COMPARE_LIMIT'); }
  const sameColumns = (left, right) => left.length === right.length && left.every((part, index) => part.column.toLowerCase() === right[index].column.toLowerCase());
  for (const owner of source.rows) {
    const entries = definitions.get(owner.name), entry = entries?.length === 1 ? entries[0] : null;
    const foreignKeys = entry?.review?.version === 3 && entry.review.status === 'matched' ? projectForeignKeys(entry.review.foreignKeys) : null;
    if (!foreignKeys) { flag('FK_COMPARE_SOURCE_INCOMPLETE'); continue; }
    const ownerId = JSON.stringify([key(targetReview.database), key(owner.name)]);
    const ownerKnown = knownCase && sourceNames.get(key(owner.name)) === 1 && (!entry.schema || key(entry.schema) === key(targetReview.database));
    const owners = targetObjects.get(key(owner.name)) || [], observation = owners.length === 1 ? owners[0] : null;
    const objectKnown = observation && Number.isSafeInteger(observation.objectCount) && observation.objectCount >= 0 && observation.objectCount <= 1
      && Array.isArray(observation.objects) && observation.objectCount === observation.objects.length
      && observation.objects.every(object => object.type === 'table' && key(object.name) === key(owner.name));
    if (ownerKnown && objectKnown && observation.objectCount === 1) reviewedOwners.add(ownerId);
    for (const fk of foreignKeys) {
      if (sourceCount >= 2000 || pairs + fk.columns.length > 10000) { truncated = true; flag('FK_COMPARE_LIMIT'); break; }
      sourceCount++; pairs += fk.columns.length;
      const value = { name: fk.name, schema: entry.schema, table: owner.name, referencedSchema: fk.referencedSchema || targetReview.database, referencedTable: fk.referencedTable,
        pairs: fk.columns.map((column, index) => ({ column, referencedColumn: fk.referencedColumns[index] })), onDelete: fk.onDelete, onUpdate: fk.onUpdate };
      const row = { status: 'unknown', reason: 'FK_COMPARE_TARGET_INCOMPLETE', source: value, target: null, differences: [], nameDiffers: false };
      if (!ownerKnown || fk.referencedSchema && key(fk.referencedSchema) !== key(targetReview.database)) { reviewedOwners.delete(ownerId); row.reason = 'FK_COMPARE_SCHEMA_OR_CASE_UNKNOWN'; retain(row); continue; }
      if (!targetValid) { retain(row); continue; }
      if (!objectKnown) { row.reason = 'FK_COMPARE_OWNER_UNKNOWN'; retain(row); continue; }
      if (observation.objectCount === 0) { row.status = 'notApplicable'; row.reason = 'FK_COMPARE_OWNER_NOT_OBSERVED'; retain(row); continue; }
      const candidates = byOwner.get(ownerId) || [];
      const sameName = fk.name ? candidates.filter(candidate => candidate.name.toLowerCase() === fk.name.toLowerCase()) : [];
      const matches = sameName.length ? sameName : candidates.filter(candidate => sameColumns(value.pairs, candidate.pairs));
      if (!matches.length) { row.status = 'notObserved'; row.reason = 'FK_COMPARE_NOT_OBSERVED'; retain(row); continue; }
      if (matches.length !== 1) { for (const candidate of matches) used.add(candidate); row.reason = 'FK_COMPARE_AMBIGUOUS'; retain(row); continue; }
      const match = matches[0]; row.target = match; used.add(match); row.nameDiffers = fk.name !== null && fk.name !== match.name;
      if (!sameColumns(value.pairs, match.pairs)) row.differences.push('FK_COMPARE_LOCAL_COLUMNS_DIFFER');
      if (key(value.referencedSchema) !== key(match.referencedSchema) || key(value.referencedTable) !== key(match.referencedTable)) row.differences.push('FK_COMPARE_REFERENCE_DIFFERS');
      if (value.pairs.length !== match.pairs.length || value.pairs.some((part, index) => part.referencedColumn.toLowerCase() !== match.pairs[index]?.referencedColumn.toLowerCase())) row.differences.push('FK_COMPARE_REMOTE_COLUMNS_DIFFER');
      if (fk.onDelete !== null && fk.onDelete !== match.onDelete) row.differences.push('FK_COMPARE_DELETE_DIFFERS');
      if (fk.onUpdate !== null && fk.onUpdate !== match.onUpdate) row.differences.push('FK_COMPARE_UPDATE_DIFFERS');
      if (row.differences.length) { row.status = 'differs'; row.reason = 'FK_COMPARE_DEFINITION_DIFFERS'; }
      else if (fk.onDelete === null || fk.onUpdate === null) row.reason = 'FK_COMPARE_SOURCE_ACTION_UNSPECIFIED';
      else { row.status = 'matched'; row.reason = 'FK_COMPARE_METADATA_MATCHED'; }
      retain(row);
    }
  }
  if (targetValid && !truncated) for (const row of observed) {
    if (used.has(row) || key(row.schema) !== key(targetReview.database) || !reviewedOwners.has(JSON.stringify([key(row.schema), key(row.table)]))) continue;
    retain({ status: 'targetOnly', reason: 'FK_COMPARE_TARGET_ONLY', source: null, target: row, differences: [], nameDiffers: false });
  }
  if (truncated && !findings.some(item => item.code === 'FK_COMPARE_LIMIT')) flag('FK_COMPARE_LIMIT');
  return { version: 1, canExecute: false, scope: 'source-target-fk-metadata', rows, totals, sourceCount, pairs, retainedPairs, findings, truncated,
    requires: ['FK_COMPARE_DATA_NOT_CHECKED', 'FK_COMPARE_SERVER_NOT_VALIDATED', 'FK_COMPARE_TARGET_RECHECK_REQUIRED'] };
}

module.exports = { compareSelectedForeignKeys };
