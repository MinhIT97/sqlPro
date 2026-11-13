'use strict';

const validName = value => typeof value === 'string' && value.length > 0 && value.length <= 64 && !/[\u0000-\u001f\u007f]/.test(value);
const ACTIONS = new Set(['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION']);

// Group the entire bounded observation before selecting relations. A malformed
// part outside the selection must not make the retained half look complete.
function reviewTargetForeignKeys(statistics, { database, selectedTables, lowerCaseTableNames, metadataComplete = false } = {}) {
  const rows = [], findings = [], groups = new Map(), identities = new Map();
  const totals = { observed: 0, unknown: 0, inbound: 0, outbound: 0, internal: 0, inconsistent: 0 };
  let truncated = false, invalid = false, pairCount = 0, retainedPairs = 0, definitionCount = 0;
  const flag = (code, table = null) => {
    if (findings.length < 50) findings.push({ code, table }); else truncated = true;
  };
  const caseKnown = [0, 1, 2].includes(lowerCaseTableNames);
  const key = name => lowerCaseTableNames === 0 ? name : name.toLowerCase();
  const scopeValid = validName(database) && Array.isArray(selectedTables) && selectedTables.length > 0 && selectedTables.length <= 1000 && selectedTables.every(validName);
  const selected = new Set(scopeValid ? selectedTables.map(key) : []);
  const scopeKnown = scopeValid && selected.size === selectedTables.length;
  const includes = (schema, table) => scopeValid && key(schema) === key(database) && selected.has(key(table));
  if (!metadataComplete || !Array.isArray(statistics)) flag('TARGET_FK_METADATA_INCOMPLETE');
  if (!caseKnown || !scopeKnown) flag('TARGET_FK_SCOPE_UNKNOWN');
  for (const part of (Array.isArray(statistics) ? statistics : []).slice(0, 5000)) {
    if (!part || ![part.name, part.tableSchema, part.table, part.column, part.referencedSchema, part.referencedTable, part.referencedColumn].every(validName)) {
      invalid = true; flag('TARGET_FK_METADATA_INVALID'); continue;
    }
    const identity = JSON.stringify([part.tableSchema, part.table, part.name]);
    const group = groups.get(identity) || []; group.push(part); groups.set(identity, group);
    const folded = JSON.stringify([key(part.tableSchema), key(part.table), part.name.toLowerCase()]);
    const names = identities.get(folded) || new Set(); names.add(identity); identities.set(folded, names);
  }
  if (statistics?.length > 5000) { truncated = true; flag('TARGET_FK_REVIEW_LIMIT'); }
  for (const group of groups.values()) {
    if (!group.some(part => includes(part.tableSchema, part.table) || includes(part.referencedSchema, part.referencedTable))) continue;
    definitionCount++; pairCount += group.length;
    const ordered = [...group].sort((left, right) => left.ordinal - right.ordinal), first = ordered[0];
    const childSelected = includes(first.tableSchema, first.table), parentSelected = includes(first.referencedSchema, first.referencedTable);
    let relation = childSelected && parentSelected ? 'internal' : parentSelected ? 'inbound' : 'outbound';
    let reason = !caseKnown || !scopeKnown ? 'TARGET_FK_SCOPE_UNKNOWN' : !metadataComplete ? 'TARGET_FK_METADATA_INCOMPLETE' : null;
    const folded = JSON.stringify([key(first.tableSchema), key(first.table), first.name.toLowerCase()]);
    if (identities.get(folded).size > 1) reason = 'TARGET_FK_IDENTITY_AMBIGUOUS';
    if (group.some(part => part.referencedSchema !== first.referencedSchema || part.referencedTable !== first.referencedTable)) {
      reason = 'TARGET_FK_REFERENCE_INCONSISTENT'; relation = 'inconsistent';
    }
    if (group.length > 16) reason = 'TARGET_FK_PAIR_LIMIT';
    const local = new Set(), remote = new Set();
    for (const [position, part] of ordered.entries()) {
      if (part.ordinal !== position + 1 || local.has(part.column.toLowerCase()) || remote.has(part.referencedColumn.toLowerCase())) reason = 'TARGET_FK_PAIRS_INVALID';
      local.add(part.column.toLowerCase()); remote.add(part.referencedColumn.toLowerCase());
      if (!ACTIONS.has(part.onDelete) || !ACTIONS.has(part.onUpdate) || part.match !== 'NONE') reason = 'TARGET_FK_ACTIONS_NOT_REVIEWED';
      if (part.onDelete !== first.onDelete || part.onUpdate !== first.onUpdate || part.match !== first.match) reason = 'TARGET_FK_ACTIONS_INCONSISTENT';
    }
    const actionsConsistent = group.every(part => part.onDelete === first.onDelete && part.onUpdate === first.onUpdate && part.match === first.match);
    const referenceConsistent = group.every(part => part.referencedSchema === first.referencedSchema && part.referencedTable === first.referencedTable);
    const status = reason ? 'unknown' : 'observed';
    totals[status]++; totals[relation]++;
    if (reason) flag(reason, first.table);
    const size = Math.min(16, ordered.length);
    if (rows.length >= 200 || retainedPairs + size > 1000) { truncated = true; continue; }
    retainedPairs += size;
    rows.push({ name: first.name, tableSchema: first.tableSchema, table: first.table, referencedSchema: referenceConsistent ? first.referencedSchema : null, referencedTable: referenceConsistent ? first.referencedTable : null,
      relation, status, reason: reason || 'TARGET_FK_DEFINITION_OBSERVED', pairCount: group.length,
      pairs: ordered.slice(0, 16).map(part => ({ ordinal: Number.isSafeInteger(part.ordinal) && part.ordinal > 0 && part.ordinal <= 4096 ? part.ordinal : null,
        column: part.column, referencedColumn: part.referencedColumn })),
      onDelete: actionsConsistent && (ACTIONS.has(first.onDelete) || first.onDelete === 'SET DEFAULT') ? first.onDelete : null,
      onUpdate: actionsConsistent && (ACTIONS.has(first.onUpdate) || first.onUpdate === 'SET DEFAULT') ? first.onUpdate : null,
      match: actionsConsistent && first.match === 'NONE' ? 'NONE' : null });
  }
  if (truncated && !findings.some(item => item.code === 'TARGET_FK_REVIEW_LIMIT')) flag('TARGET_FK_REVIEW_LIMIT');
  return { version: 1, canExecute: false, scope: 'selected-target-metadata', complete: Array.isArray(statistics) && metadataComplete === true && caseKnown && scopeKnown && !invalid && !truncated && totals.unknown === 0,
    rows, definitionCount, pairCount, retainedPairs, totals, findings, truncated,
    requires: ['TARGET_FK_DATA_NOT_CHECKED', 'TARGET_FK_SERVER_RULES_NOT_VALIDATED', 'TARGET_FK_RECHECK_REQUIRED'] };
}

module.exports = { reviewTargetForeignKeys };
