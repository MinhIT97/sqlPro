'use strict';

const validName = value => typeof value === 'string' && value.length > 0 && value.length <= 64 && !value.includes('\0');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const CAPABILITIES = new Set(['CHECK_CONSTRAINTS.CONSTRAINT_SCHEMA', 'CHECK_CONSTRAINTS.CONSTRAINT_NAME',
  'CHECK_CONSTRAINTS.CHECK_CLAUSE', 'CHECK_CONSTRAINTS.TABLE_NAME', 'TABLE_CONSTRAINTS.ENFORCED']);
const SESSION_UNKNOWN = new Set(['TARGET_CHECK_SESSION_NOT_REVIEWED', 'TARGET_CHECK_SESSION_VARIABLE_UNAVAILABLE',
  'TARGET_CHECK_SESSION_QUERY_FAILED', 'TARGET_CHECK_SESSION_RESULT_INVALID']);
const unknownSession = reason => ({ version: 1, status: 'unknown', enabled: null, reason });

async function collectCheckSessionSettings(session, checkContext = () => {}) {
  checkContext();
  let result;
  try { result = await session.raw('SELECT @@SESSION.check_constraint_checks AS enabled', [], 10000); }
  catch (error) {
    checkContext();
    return unknownSession(error?.code === 'ER_UNKNOWN_SYSTEM_VARIABLE' ? 'TARGET_CHECK_SESSION_VARIABLE_UNAVAILABLE' : 'TARGET_CHECK_SESSION_QUERY_FAILED');
  }
  checkContext();
  if (!Array.isArray(result?.rows) || result.rows.length !== 1 || ![0, 1, '0', '1'].includes(result.rows[0]?.enabled)) {
    return unknownSession('TARGET_CHECK_SESSION_RESULT_INVALID');
  }
  return { version: 1, status: 'observed', enabled: Number(result.rows[0].enabled) === 1, reason: 'TARGET_CHECK_SESSION_OBSERVED' };
}

function projectCheckSessionSettings(value) {
  if (value?.version === 1 && value.status === 'observed' && typeof value.enabled === 'boolean' && value.reason === 'TARGET_CHECK_SESSION_OBSERVED') {
    return { version: 1, status: 'observed', enabled: value.enabled, reason: 'TARGET_CHECK_SESSION_OBSERVED' };
  }
  if (value?.version === 1 && value.status === 'unknown' && value.enabled === null && SESSION_UNKNOWN.has(value.reason)) return unknownSession(value.reason);
  return unknownSession('TARGET_CHECK_SESSION_NOT_REVIEWED');
}

async function collectTargetChecks(read, database, selectedTables) {
  const columns = await read('checkCapabilities', "SELECT TABLE_NAME AS tableName, COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND ((TABLE_NAME = ? AND COLUMN_NAME IN (?,?,?,?)) OR (TABLE_NAME = ? AND COLUMN_NAME = ?)) ORDER BY TABLE_NAME, COLUMN_NAME LIMIT 6",
    ['information_schema', 'CHECK_CONSTRAINTS', 'CONSTRAINT_SCHEMA', 'CONSTRAINT_NAME', 'CHECK_CLAUSE', 'TABLE_NAME', 'TABLE_CONSTRAINTS', 'ENFORCED'], row =>
      CAPABILITIES.has(`${row.tableName}.${row.name}`) ? { table: row.tableName, name: row.name } : null, 5);
  const seen = new Set(columns?.map(row => `${row.table}.${row.name}`));
  const observed = Array.isArray(columns) && columns.length <= 5 && seen.size === columns.length
    && ['CONSTRAINT_SCHEMA', 'CONSTRAINT_NAME', 'CHECK_CLAUSE'].every(name => seen.has(`CHECK_CONSTRAINTS.${name}`));
  const capabilities = { version: 1, status: observed ? 'observed' : 'unknown',
    tableColumn: observed && seen.has('CHECK_CONSTRAINTS.TABLE_NAME'), enforcedColumn: observed && seen.has('TABLE_CONSTRAINTS.ENFORCED') };
  if (!observed) return { capabilities, rows: [] };
  // Identifiers come only from the capability whitelist. Never return the
  // expression: its bounded metadata digest is used only for snapshot drift.
  const tableJoin = capabilities.tableColumn ? ' AND BINARY c.TABLE_NAME = BINARY t.TABLE_NAME' : '';
  const enforced = capabilities.enforcedColumn ? 't.ENFORCED' : 'NULL';
  const filter = selectedTables ? ` AND t.TABLE_NAME IN (${selectedTables.map(() => '?').join(',')})` : '';
  const rows = await read('checks', `SELECT t.CONSTRAINT_SCHEMA AS constraintSchema, t.TABLE_SCHEMA AS tableSchema, t.TABLE_NAME AS tableName, t.CONSTRAINT_NAME AS name, ${enforced} AS declaredEnforcement, CASE WHEN OCTET_LENGTH(c.CHECK_CLAUSE) BETWEEN 1 AND 65536 THEN SHA2(c.CHECK_CLAUSE,256) ELSE NULL END AS clauseDigest FROM information_schema.TABLE_CONSTRAINTS t LEFT JOIN information_schema.CHECK_CONSTRAINTS c ON BINARY c.CONSTRAINT_SCHEMA = BINARY t.CONSTRAINT_SCHEMA AND BINARY c.CONSTRAINT_NAME = BINARY t.CONSTRAINT_NAME${tableJoin} WHERE t.TABLE_SCHEMA = ? AND t.CONSTRAINT_SCHEMA = ? AND t.CONSTRAINT_TYPE = 'CHECK'${filter} ORDER BY t.TABLE_NAME, t.CONSTRAINT_NAME LIMIT 2001`,
    [database, database, ...(selectedTables || [])], row => {
      if (![row.constraintSchema, row.tableSchema, row.tableName, row.name].every(validName)
          || row.clauseDigest !== null && !digest(row.clauseDigest)
          || ![null, 'YES', 'NO'].includes(row.declaredEnforcement)
          || !capabilities.enforcedColumn && row.declaredEnforcement !== null) return null;
      return { constraintSchema: row.constraintSchema, tableSchema: row.tableSchema, table: row.tableName, name: row.name,
        clauseDigest: row.clauseDigest, declaredEnforcement: row.declaredEnforcement === 'YES' ? 'yes' : row.declaredEnforcement === 'NO' ? 'no' : 'unknown' };
    }, 2000);
  return { capabilities, rows: rows || [] };
}

function reviewTargetChecks(facts, selectedTables) {
  const rows = [], findings = [], seen = new Set();
  const sessionSettings = projectCheckSessionSettings(facts.checkSessionSettings);
  let truncated = false;
  const flag = code => { if (!findings.includes(code)) { if (findings.length < 50) findings.push(code); else truncated = true; } };
  const capabilities = facts.checkCapabilities;
  const capabilityKnown = capabilities?.version === 1 && capabilities.status === 'observed'
    && typeof capabilities.tableColumn === 'boolean' && typeof capabilities.enforcedColumn === 'boolean';
  const metadataValid = Array.isArray(facts.checks) && facts.checks.length <= 2000;
  let complete = capabilityKnown && metadataValid && facts.databaseVisible === true && [0, 1, 2].includes(facts.lowerCaseTableNames)
    && !facts.errors.some(error => ['checks', 'checkCapabilities', 'objects', 'database', 'server'].includes(error.section))
    && !facts.truncated.some(section => ['checks', 'checkCapabilities', 'objects', 'database', 'server'].includes(section));
  const key = value => facts.lowerCaseTableNames === 1 || facts.lowerCaseTableNames === 2 ? value.toLowerCase() : value;
  const selected = new Set(selectedTables.map(key)), totals = { observed: 0, unknown: 0 };
  const tables = new Map();
  for (const object of facts.objects || []) {
    const name = key(object.name), matches = tables.get(name) || []; matches.push(object); tables.set(name, matches);
  }
  if (!capabilityKnown) flag('TARGET_CHECK_CAPABILITY_UNKNOWN');
  for (const row of (Array.isArray(facts.checks) ? facts.checks : []).slice(0, 2000)) {
    if (![row?.constraintSchema, row?.tableSchema, row?.table, row?.name].every(validName)
        || row.clauseDigest !== null && !digest(row.clauseDigest) || !['yes', 'no', 'unknown'].includes(row.declaredEnforcement)) {
      complete = false; flag('TARGET_CHECK_METADATA_INVALID'); continue;
    }
    if (key(row.tableSchema) !== key(facts.database) || key(row.constraintSchema) !== key(facts.database)) {
      complete = false; flag('TARGET_CHECK_SCHEMA_MISMATCH'); continue;
    }
    if (!selected.has(key(row.table))) continue;
    const identity = JSON.stringify([key(row.tableSchema), key(row.table), row.name]), objects = tables.get(key(row.table));
    const duplicate = seen.has(identity); seen.add(identity);
    const known = complete && !duplicate && objects?.length === 1 && objects[0].type === 'table' && digest(row.clauseDigest);
    if (duplicate) { complete = false; flag('TARGET_CHECK_DUPLICATE_METADATA'); }
    if (objects?.length !== 1 || objects[0].type !== 'table') { complete = false; flag('TARGET_CHECK_TABLE_NOT_OBSERVED'); }
    if (!row.clauseDigest) { complete = false; flag('TARGET_CHECK_DEFINITION_UNKNOWN'); }
    const reason = known ? 'TARGET_CHECK_DATA_NOT_VALIDATED' : 'TARGET_CHECK_METADATA_INCOMPLETE';
    totals[known ? 'observed' : 'unknown']++;
    if (rows.length < 200) rows.push({ table: row.table, name: row.name, clauseObserved: digest(row.clauseDigest),
      declaredEnforcement: capabilityKnown && capabilities.enforcedColumn ? row.declaredEnforcement : 'unknown', status: known ? 'requires-review' : 'unknown', reason });
    else truncated = true;
  }
  if (!complete) {
    flag('TARGET_CHECK_METADATA_INCOMPLETE'); totals.unknown += totals.observed; totals.observed = 0;
    for (const row of rows) { row.status = 'unknown'; row.reason = 'TARGET_CHECK_METADATA_INCOMPLETE'; }
  }
  if (totals.observed + totals.unknown) flag('TARGET_CHECK_DATA_NOT_VALIDATED');
  if (sessionSettings.enabled === false) flag('TARGET_CHECK_SESSION_DISABLED');
  if (sessionSettings.enabled === null) flag(sessionSettings.reason);
  if (truncated) flag('TARGET_CHECK_REPORT_LIMIT');
  return { version: 2, canExecute: false, status: 'partial', visibility: 'account-visible', complete, sessionSettings, totals, rows, findings, truncated,
    requires: ['TARGET_CHECK_EXPRESSION_NOT_EVALUATED', 'TARGET_CHECK_SESSION_NOT_REVIEWED', 'TARGET_CHECK_RECHECK_REQUIRED'] };
}

module.exports = { collectTargetChecks, reviewTargetChecks, collectCheckSessionSettings, projectCheckSessionSettings };
