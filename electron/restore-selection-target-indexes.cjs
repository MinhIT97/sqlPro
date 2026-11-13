'use strict';

const { projectIndexes, reviewReferencedIndex } = require('./restore-selection-indexes.cjs');
const validName = value => typeof value === 'string' && value.length > 0 && value.length <= 64 && !/[\u0000-\u001f\u007f]/.test(value);

// Bounded metadata observations, not execution evidence. Visibility describes
// optimizer use, not constraint enforcement. Data and FK rules remain unknown.
function reviewTargetIndexes(statistics, { metadataComplete = false, tableObserved = false, visibilityKind = null, limit = 50, partLimit = 800 } = {}) {
  const findings = [], indexes = [], groups = new Map();
  let truncated = false, findingOverflow = false, parts = 0;
  const knownVisibility = ['mysql-visible', 'mariadb-ignored'].includes(visibilityKind);
  const visibilityStates = visibilityKind === 'mysql-visible' ? ['visible', 'invisible'] : visibilityKind === 'mariadb-ignored' ? ['not-ignored', 'ignored'] : [];
  const flag = code => {
    if (!findings.includes(code)) {
      if (findings.length < 20) findings.push(code); else findingOverflow = true;
    }
  };
  const indexLimit = Math.max(0, Math.min(50, Number.isInteger(limit) ? limit : 0));
  const columnLimit = Math.max(0, Math.min(800, Number.isInteger(partLimit) ? partLimit : 0));
  if (!metadataComplete || !Array.isArray(statistics)) flag('TARGET_INDEX_METADATA_INCOMPLETE');
  if (!tableObserved) flag('TARGET_INDEX_TABLE_NOT_OBSERVED');
  if (!knownVisibility) flag('TARGET_INDEX_VISIBILITY_NOT_REVIEWED');
  for (const row of (Array.isArray(statistics) ? statistics : []).slice(0, 20000)) {
    if (!row || !validName(row.name)) { flag('TARGET_INDEX_METADATA_INVALID'); continue; }
    const group = groups.get(row.name) || [];
    if (!groups.has(row.name) && groups.size >= 128) { truncated = true; break; }
    group.push(row); groups.set(row.name, group);
  }
  if (statistics?.length > 20000) truncated = true;
  const foldedNames = new Set();
  for (const [name, group] of groups) {
    if (indexes.length >= indexLimit || group.length > columnLimit - parts) { truncated = true; break; }
    const ordered = [...group].sort((left, right) => left.ordinal - right.ordinal), first = ordered[0];
    const kind = name === 'PRIMARY' ? 'primary' : first.nonUnique === false ? 'unique' : 'index';
    const columns = [], seen = new Set();
    const visibility = knownVisibility && visibilityStates.includes(first.visibility) && group.every(part => part.visibility === first.visibility) ? first.visibility : 'unknown';
    if (visibility === 'unknown') flag('TARGET_INDEX_VISIBILITY_NOT_REVIEWED');
    let supported = group.length <= 16 && !foldedNames.has(name.toLowerCase()) && first.type === 'BTREE'
      && typeof first.nonUnique === 'boolean' && (kind !== 'primary' || !first.nonUnique);
    if (foldedNames.has(name.toLowerCase())) flag('TARGET_INDEX_METADATA_INVALID');
    foldedNames.add(name.toLowerCase());
    for (const [position, part] of ordered.entries()) {
      const nameKnown = validName(part.column);
      const prefixKnown = part.prefixLength === null || Number.isInteger(part.prefixLength) && part.prefixLength > 0 && part.prefixLength <= 65535;
      const directionKnown = [null, 'A', 'D'].includes(part.direction);
      if (part.ordinal !== position + 1 || part.nonUnique !== first.nonUnique || part.type !== first.type
          || !nameKnown || !prefixKnown || !directionKnown || part.direction !== 'A' || seen.has(part.column?.toLowerCase())) supported = false;
      if (nameKnown) seen.add(part.column.toLowerCase());
      columns.push({ name: nameKnown ? part.column : null, prefixLength: prefixKnown ? part.prefixLength : null,
        direction: directionKnown ? part.direction : null });
    }
    if (!supported) flag('TARGET_INDEX_DEFINITION_UNSUPPORTED');
    indexes.push({ name, kind, type: typeof first.type === 'string' && /^[A-Z0-9_]{1,32}$/.test(first.type) ? first.type : null, columns, supported, visibility });
    parts += columns.length;
  }
  if (truncated) flag('TARGET_INDEX_REVIEW_LIMIT');
  return { version: 2, canExecute: false, visibilityKind: knownVisibility ? visibilityKind : null, complete: metadataComplete === true && tableObserved === true && findings.length === 0 && !truncated && !findingOverflow,
    definitionCount: groups.size, indexes, parts, findings, truncated: truncated || findingOverflow,
    requires: [...(findings.includes('TARGET_INDEX_VISIBILITY_NOT_REVIEWED') ? ['TARGET_INDEX_VISIBILITY_NOT_REVIEWED'] : []), 'TARGET_INDEX_SERVER_RULES_NOT_VALIDATED', 'TARGET_INDEX_DATA_NOT_CHECKED'] };
}

function reviewTargetReferencedIndex(review, columns) {
  if (review?.version !== 2 || review.canExecute !== false || review.complete !== true || review.truncated || !Array.isArray(review.indexes)
      || !['mysql-visible', 'mariadb-ignored'].includes(review.visibilityKind) || review.indexes.length > 50 || review.definitionCount !== review.indexes.length || review.indexes.some(index => !index || index.supported !== true || index.type !== 'BTREE'
        || !Array.isArray(index.columns) || index.columns.some(part => !part || part.direction !== 'A'))) {
    return { status: 'unknown', code: 'FK_TARGET_INDEX_NOT_REVIEWED' };
  }
  const states = review.visibilityKind === 'mysql-visible' ? ['visible', 'invisible'] : ['not-ignored', 'ignored'];
  if (review.indexes.some(index => !states.includes(index.visibility))) return { status: 'unknown', code: 'FK_TARGET_INDEX_NOT_REVIEWED' };
  const definitions = list => list.map(index => ({ name: index.name, kind: index.kind,
    columns: index.columns.map(part => ({ name: part.name, prefixLength: part.prefixLength })) }));
  if (!projectIndexes(definitions(review.indexes))) return { status: 'unknown', code: 'FK_TARGET_INDEX_NOT_REVIEWED' };
  const active = review.indexes.filter(index => ['visible', 'not-ignored'].includes(index.visibility));
  const matched = reviewReferencedIndex(definitions(active), columns);
  if (matched.code === 'FK_REFERENCED_UNIQUE_KEY_NOT_FOUND') {
    const hidden = reviewReferencedIndex(definitions(review.indexes.filter(index => ['invisible', 'ignored'].includes(index.visibility))), columns);
    if (hidden.status === 'matched') return { status: 'requires-review', code: 'FK_TARGET_KEY_INVISIBLE_OR_IGNORED', name: hidden.name, kind: hidden.kind,
      columns: hidden.columns, visibility: review.indexes.find(index => index.name === hidden.name).visibility };
  }
  if (matched.status !== 'matched') return { status: matched.code === 'FK_REFERENCED_UNIQUE_KEY_NOT_FOUND' ? 'not-observed' : 'unknown',
    code: matched.code === 'FK_REFERENCED_UNIQUE_KEY_NOT_FOUND' ? 'FK_TARGET_UNIQUE_KEY_NOT_OBSERVED' : 'FK_TARGET_INDEX_NOT_REVIEWED' };
  return { status: 'observed-match', code: 'FK_TARGET_UNIQUE_KEY_OBSERVED', name: matched.name, kind: matched.kind, columns: matched.columns };
}

module.exports = { reviewTargetIndexes, reviewTargetReferencedIndex };
