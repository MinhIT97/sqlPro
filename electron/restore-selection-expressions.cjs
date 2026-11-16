'use strict';

const validName = value => typeof value === 'string' && value.length > 0 && value.length <= 64 && !value.includes('\0');
const digest = value => typeof value === 'string' && value.length === 64 && /^[a-f0-9]+$/.test(value);
const REQUIRES = ['TARGET_DEFAULT_VALUES_NOT_VALIDATED', 'TARGET_GENERATED_VALUES_NOT_VALIDATED', 'TARGET_COLUMN_EXPRESSIONS_RECHECK_REQUIRED'];
const FINDINGS = new Set(['TARGET_COLUMN_EXPRESSIONS_INCOMPLETE', 'TARGET_COLUMN_EXPRESSIONS_REPORT_LIMIT']);
const DEFAULT_STATES = ['observed', 'null-metadata', 'unknown'];
const GENERATED_STATES = ['observed', 'not-reported', 'unknown'];

// Hash at the server; raw default/generated text must never leave this query.
const COLUMN_EXPRESSION_SQL = "CASE WHEN COLUMN_DEFAULT IS NULL THEN 'null-metadata' WHEN OCTET_LENGTH(COLUMN_DEFAULT) BETWEEN 0 AND 65536 THEN 'observed' ELSE 'unknown' END AS defaultStatus, CASE WHEN OCTET_LENGTH(COLUMN_DEFAULT) BETWEEN 0 AND 65536 THEN SHA2(COLUMN_DEFAULT,256) ELSE NULL END AS defaultDigest, CASE WHEN GENERATION_EXPRESSION IS NULL OR OCTET_LENGTH(GENERATION_EXPRESSION)=0 THEN 'not-reported' WHEN OCTET_LENGTH(GENERATION_EXPRESSION) BETWEEN 1 AND 65536 THEN 'observed' ELSE 'unknown' END AS generatedStatus, CASE WHEN OCTET_LENGTH(GENERATION_EXPRESSION) BETWEEN 1 AND 65536 THEN SHA2(GENERATION_EXPRESSION,256) ELSE NULL END AS generatedDigest";

function normalizeColumnExpressions(row, hasDefault, generated) {
  let defaultStatus = row?.defaultStatus, defaultDigest = row?.defaultDigest;
  const defaultValid = DEFAULT_STATES.includes(defaultStatus) && (defaultStatus === 'observed'
    ? digest(defaultDigest) && hasDefault === true : defaultDigest === null && (defaultStatus !== 'null-metadata' || hasDefault === false));
  if (!defaultValid) {
    defaultStatus = 'unknown'; defaultDigest = null;
  }
  let generatedStatus = row?.generatedStatus, generatedDigest = row?.generatedDigest;
  const generatedValid = GENERATED_STATES.includes(generatedStatus) && (generatedStatus === 'observed'
    ? digest(generatedDigest) && generated === true : generatedDigest === null && (generatedStatus !== 'not-reported' || generated === false));
  if (!generatedValid) {
    generatedStatus = 'unknown'; generatedDigest = null;
  }
  return { version: 1, defaultStatus, defaultDigest, generatedStatus, generatedDigest };
}

function reviewTargetExpressions(facts, selectedTables) {
  const key = value => facts.lowerCaseTableNames === 1 || facts.lowerCaseTableNames === 2 ? value.toLowerCase() : value;
  const selected = new Set(selectedTables.map(key)), identities = new Map(), tables = new Map(), observedTables = new Set();
  const columns = Array.isArray(facts.columns) ? facts.columns : [];
  const columnIdentity = column => JSON.stringify([key(column.table), column.name.toLowerCase()]);
  for (const column of columns.slice(0, 10000)) {
    if (![column?.table, column?.name].every(validName) || !selected.has(key(column.table))) continue;
    const identity = columnIdentity(column);
    identities.set(identity, (identities.get(identity) || 0) + 1);
  }
  const metadataKnown = Array.isArray(facts.columns) && columns.length <= 10000 && facts.databaseVisible === true && [0, 1, 2].includes(facts.lowerCaseTableNames)
    && !facts.errors.some(error => ['columns', 'objects', 'database', 'server'].includes(error.section))
    && !facts.truncated.some(section => ['columns', 'objects', 'database', 'server'].includes(section));
  for (const object of (facts.objects || []).slice(0, 5000)) {
    const group = tables.get(key(object.name)) || []; group.push(object); tables.set(key(object.name), group);
  }
  const rows = [], totals = { observed: 0, unknown: 0 }, findings = [];
  let complete = metadataKnown, truncated = columns.length > 10000 || facts.truncated.includes('columns');
  for (const column of columns.slice(0, 10000)) {
    if (![column?.table, column?.name].every(validName)) { complete = false; continue; }
    if (!selected.has(key(column.table))) continue;
    observedTables.add(key(column.table));
    const objects = tables.get(key(column.table)), unique = identities.get(columnIdentity(column)) === 1;
    const profile = column.expressionProfile?.version === 1 ? normalizeColumnExpressions(column.expressionProfile, column.hasDefault, column.generated) : null;
    const known = metadataKnown && unique && objects?.length === 1 && objects[0].type === 'table'
      && profile && profile.defaultStatus !== 'unknown' && profile.generatedStatus !== 'unknown';
    if (!known) complete = false;
    totals[known ? 'observed' : 'unknown']++;
    if (rows.length < 200) rows.push({ table: column.table, column: column.name, status: known ? 'metadata-observed' : 'unknown',
      defaultStatus: profile?.defaultStatus || 'unknown', generatedStatus: profile?.generatedStatus || 'unknown' });
    else truncated = true;
  }
  // Missing columns do not establish absence, even for a table visible to the
  // account. The report reviews observations, never evaluates expressions.
  for (const table of selected) if (!observedTables.has(table)) complete = false;
  if (!complete) findings.push('TARGET_COLUMN_EXPRESSIONS_INCOMPLETE');
  if (truncated) findings.push('TARGET_COLUMN_EXPRESSIONS_REPORT_LIMIT');
  return { version: 1, canExecute: false, status: 'partial', complete, totals, rows, findings, truncated, requires: [...REQUIRES] };
}

function projectTargetExpressions(value) {
  const unknown = () => ({ version: 1, canExecute: false, status: 'partial', complete: false, totals: { observed: 0, unknown: 0 }, rows: [],
    findings: ['TARGET_COLUMN_EXPRESSIONS_INCOMPLETE'], truncated: false, requires: [...REQUIRES] });
  if (value?.version !== 1 || value.canExecute !== false || typeof value.complete !== 'boolean' || typeof value.truncated !== 'boolean'
      || !Array.isArray(value.rows) || value.rows.length > 200 || !Array.isArray(value.findings) || value.findings.length > 2 || value.findings.some(code => !FINDINGS.has(code))
      || !['observed', 'unknown'].every(name => Number.isSafeInteger(value.totals?.[name]) && value.totals[name] >= 0 && value.totals[name] <= 10000)
      || value.totals.observed + value.totals.unknown > 10000 || value.rows.length > value.totals.observed + value.totals.unknown
      || !value.truncated && value.rows.length !== value.totals.observed + value.totals.unknown || value.complete && value.totals.unknown) return unknown();
  const rows = [];
  for (const row of value.rows) {
    if (![row?.table, row?.column].every(validName) || !['metadata-observed', 'unknown'].includes(row.status)
        || !DEFAULT_STATES.includes(row.defaultStatus) || !GENERATED_STATES.includes(row.generatedStatus)
        || row.status === 'metadata-observed' && (row.defaultStatus === 'unknown' || row.generatedStatus === 'unknown')) return unknown();
    rows.push({ table: row.table, column: row.column, status: row.status, defaultStatus: row.defaultStatus, generatedStatus: row.generatedStatus });
  }
  const observed = rows.filter(row => row.status === 'metadata-observed').length, unknownCount = rows.length - observed;
  if (observed > value.totals.observed || unknownCount > value.totals.unknown
      || !value.truncated && (observed !== value.totals.observed || unknownCount !== value.totals.unknown)) return unknown();
  return { version: 1, canExecute: false, status: 'partial', complete: value.complete, totals: { observed: value.totals.observed, unknown: value.totals.unknown },
    rows, findings: [...value.findings], truncated: value.truncated, requires: [...REQUIRES] };
}

module.exports = { COLUMN_EXPRESSION_SQL, normalizeColumnExpressions, reviewTargetExpressions, projectTargetExpressions };
