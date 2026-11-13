'use strict';

const { reviewReferencedIndex } = require('./restore-selection-indexes.cjs');
const { reviewTargetReferencedIndex } = require('./restore-selection-target-indexes.cjs');
const validName = value => typeof value === 'string' && value.length > 0 && value.length <= 64 && !/[\u0000-\u001f\u007f]/.test(value);
const ACTIONS = new Set([null, 'RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION']);
function projectForeignKeys(list) {
  if (!Array.isArray(list) || list.length > 64) return null;
  const names = new Set(), result = [];
  for (const fk of list) {
    if (!fk || fk.name !== null && !validName(fk.name) || fk.referencedSchema !== null && !validName(fk.referencedSchema)
        || !validName(fk.referencedTable) || !ACTIONS.has(fk.onDelete) || !ACTIONS.has(fk.onUpdate)) return null;
    if (fk.name !== null) {
      const name = fk.name.toLowerCase(); if (names.has(name)) return null; names.add(name);
    }
    const columns = fk.columns, remote = fk.referencedColumns;
    if (!Array.isArray(columns) || !columns.length || columns.length > 16 || !Array.isArray(remote) || remote.length !== columns.length
        || [...columns, ...remote].some(name => !validName(name))
        || new Set(columns.map(name => name.toLowerCase())).size !== columns.length || new Set(remote.map(name => name.toLowerCase())).size !== remote.length) return null;
    result.push({ name: fk.name, columns: [...columns], referencedSchema: fk.referencedSchema, referencedTable: fk.referencedTable,
      referencedColumns: [...remote], onDelete: fk.onDelete, onUpdate: fk.onUpdate });
  }
  return result;
}

// Source CREATE definitions with optional target index observations. Never
// read rows, synthesize ALTER, resolve a
// missing parent from account-visible absence, or turn syntax into authority.
function reviewSelectedForeignKeys({ source, targetReview, policyReview, creates }) {
  const rows = [], findings = [];
  let truncated = false, tablesNotReviewed = 0, pairs = 0;
  const flag = (code, table = null) => {
    if (findings.length < 100) findings.push({ code, table }); else truncated = true;
  };
  const policies = new Map(policyReview.rows.map(row => [row.name, row]));
  const caseKnown = [0, 1, 2].includes(targetReview.lowerCaseTableNames);
  const key = name => targetReview.lowerCaseTableNames === 0 ? name : name.toLowerCase();
  const selected = new Map(), definitions = new Map();
  for (const row of source.rows) {
    const group = selected.get(key(row.name)) || []; group.push(row); selected.set(key(row.name), group);
  }
  for (const entry of creates.slice(0, 10000)) {
    const group = definitions.get(entry.table) || []; group.push(entry); definitions.set(entry.table, group);
  }
  if (creates.length > 10000) { truncated = true; flag('FK_REVIEW_LIMIT'); }
  if (source.includeStructure) for (const owner of source.rows) {
    const ownerPolicy = policies.get(owner.name);
    const candidates = definitions.get(owner.name);
    const entry = candidates?.length === 1 ? candidates[0] : null;
    const foreignKeys = entry?.review?.version === 3 && entry.review.status === 'matched' ? projectForeignKeys(entry.review.foreignKeys) : null;
    if (!foreignKeys) { tablesNotReviewed++; flag('FK_CREATE_NOT_REVIEWED', owner.name); continue; }
    for (const fk of foreignKeys) {
      if (rows.length >= 2000 || pairs + fk.columns.length > 10000) { truncated = true; flag('FK_REVIEW_LIMIT', owner.name); break; }
      pairs += fk.columns.length;
      const row = { table: owner.name, name: fk.name, referencedSchema: fk.referencedSchema, referencedTable: fk.referencedTable,
        pairs: fk.columns.map((column, index) => ({ column, referencedColumn: fk.referencedColumns[index] })),
        onDelete: fk.onDelete, onUpdate: fk.onUpdate, status: 'blocked', reason: 'FK_OWNER_POLICY_BLOCKED', requires: [], referencedIndexReview: null, targetReferencedIndexReview: null };
      rows.push(row);
      // Explicit CREATE schemas follow the same exact mapping gate as draft
      // statements, even when conflict policy proposes skipping the table.
      if (entry.schema && entry.schema !== targetReview.database) { row.reason = 'FK_SCHEMA_MAPPING_REQUIRED'; continue; }
      if (ownerPolicy?.disposition === 'skip') { row.status = 'excluded'; row.reason = 'FK_OWNER_SKIPPED'; continue; }
      if (!caseKnown) { row.reason = 'FK_CASE_POLICY_UNKNOWN'; continue; }
      if (entry.schema && key(entry.schema) !== key(targetReview.database) || fk.referencedSchema && key(fk.referencedSchema) !== key(targetReview.database)) {
        row.reason = 'FK_SCHEMA_MAPPING_REQUIRED'; continue;
      }
      const matches = selected.get(key(fk.referencedTable));
      if (!matches?.length) { row.reason = 'FK_PARENT_NOT_SELECTED'; continue; }
      if (matches.length !== 1) { row.reason = 'FK_PARENT_NAME_AMBIGUOUS'; continue; }
      const parent = matches[0], parentPolicy = policies.get(parent.name);
      const targetParents = (targetReview.rows || []).filter(row => key(row.name) === key(parent.name));
      if (targetParents.length === 1 && targetParents[0].objectCount === 1 && targetParents[0].objects?.[0]?.type === 'table') {
        row.targetReferencedIndexReview = reviewTargetReferencedIndex(targetParents[0].indexReview, fk.referencedColumns);
      }
      if (parentPolicy?.disposition === 'skip') { row.reason = 'FK_PARENT_SKIPPED'; continue; }
      if (ownerPolicy?.disposition !== 'review') continue;
      if (parentPolicy?.disposition !== 'review') { row.reason = 'FK_PARENT_POLICY_BLOCKED'; continue; }
      const parentDefinitions = definitions.get(parent.name);
      if (parentDefinitions?.length !== 1 || parentDefinitions[0].review?.version !== 3 || parentDefinitions[0].review?.status !== 'matched') {
        row.reason = 'FK_PARENT_CREATE_NOT_REVIEWED'; continue;
      }
      if (parentDefinitions[0].schema && parentDefinitions[0].schema !== targetReview.database) {
        row.reason = 'FK_SCHEMA_MAPPING_REQUIRED'; continue;
      }
      if (!owner.columnSchema?.complete || !parent.columnSchema?.complete) { row.reason = 'FK_COLUMN_METADATA_UNKNOWN'; continue; }
      const local = new Map(owner.columnSchema.columns.map(column => [column.name.toLowerCase(), column]));
      const remote = new Map(parent.columnSchema.columns.map(column => [column.name.toLowerCase(), column]));
      row.reason = null;
      for (const pair of row.pairs) {
        const left = local.get(pair.column.toLowerCase()), right = remote.get(pair.referencedColumn.toLowerCase());
        if (!left || !right) { row.reason = 'FK_COLUMN_NOT_FOUND'; break; }
        if (left.typeKnown !== true || right.typeKnown !== true || left.attributesKnown !== true || right.attributesKnown !== true) { row.reason = 'FK_COLUMN_METADATA_UNKNOWN'; break; }
        if (left.type !== right.type) { row.reason = 'FK_COLUMN_TYPE_REQUIRES_REVIEW'; break; }
        if (/^(?:char|varchar|.*text)(?:\(|$)/.test(left.type)) {
          if (!left.charset || !right.charset || !left.collation || !right.collation) { row.reason = 'FK_COLUMN_METADATA_UNKNOWN'; break; }
          if (left.charset.toLowerCase() !== right.charset.toLowerCase() || left.collation.toLowerCase() !== right.collation.toLowerCase()) { row.reason = 'FK_COLLATION_REQUIRES_REVIEW'; break; }
        }
        if ((fk.onDelete === 'SET NULL' || fk.onUpdate === 'SET NULL') && left.nullable !== true) { row.reason = 'FK_SET_NULL_REQUIRES_NULLABLE'; break; }
      }
      if (!row.reason) {
        row.referencedIndexReview = reviewReferencedIndex(parentDefinitions[0].review.indexDefinitions, fk.referencedColumns);
        if (row.referencedIndexReview.status !== 'matched') { row.reason = row.referencedIndexReview.code; continue; }
        row.status = 'review'; row.reason = 'FK_DEFINITION_REQUIRES_REVIEW';
        row.requires = ['FK_DATA_NOT_CHECKED', 'FK_SERVER_RULES_NOT_VALIDATED'];
      }
    }
  }
  const totals = { review: 0, blocked: 0, excluded: 0 };
  for (const row of rows) totals[row.status]++;
  return { version: 4, canExecute: false, scope: 'selected-source-create', rows, totals, tablesNotReviewed, pairs, findings, truncated };
}

module.exports = { projectForeignKeys, reviewSelectedForeignKeys };
