'use strict';

const validName = value => typeof value === 'string' && value.length > 0 && value.length <= 64 && !value.includes('\0');
const digest = value => typeof value === 'string' && value.length === 64 && /^[a-f0-9]+$/.test(value);
const order = value => ['number', 'string'].includes(typeof value) && /^[1-9][0-9]{0,3}$/.exec(String(value))?.[0] === String(value)
  && Number(value) <= 5000 ? Number(value) : null;
const REQUIRES = ['TARGET_TRIGGER_EFFECTS_NOT_VALIDATED', 'TARGET_TRIGGER_VISIBILITY_NOT_PROVEN', 'TARGET_TRIGGER_RECHECK_REQUIRED'];
const CODES = new Set(['TARGET_TRIGGER_METADATA_INCOMPLETE', 'TARGET_TRIGGER_SCHEMA_MISMATCH', 'TARGET_TRIGGER_DUPLICATE_METADATA',
  'TARGET_TRIGGER_TABLE_NOT_OBSERVED', 'TARGET_TRIGGER_DEFINITION_UNKNOWN', 'TARGET_TRIGGER_CONTEXT_UNKNOWN', 'TARGET_TRIGGER_REPORT_LIMIT', 'TARGET_TRIGGERS_REQUIRE_REVIEW']);

async function collectTargetTriggers(read, database) {
  // Fixed-length inner hashes frame context fields without returning SQL mode,
  // the DEFINER account or connection collation strings to the application.
  const rows = await read('triggers', `SELECT TRIGGER_SCHEMA AS triggerSchema, EVENT_OBJECT_SCHEMA AS tableSchema, TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tableName, EVENT_MANIPULATION AS event, ACTION_TIMING AS timing, ACTION_ORIENTATION AS orientation, ACTION_ORDER AS actionOrder, CASE WHEN OCTET_LENGTH(ACTION_STATEMENT) BETWEEN 1 AND 65536 THEN SHA2(ACTION_STATEMENT,256) ELSE NULL END AS actionDigest, CASE WHEN OCTET_LENGTH(CONCAT(SQL_MODE,DEFINER,CHARACTER_SET_CLIENT,COLLATION_CONNECTION,DATABASE_COLLATION)) BETWEEN 1 AND 32768 THEN SHA2(CONCAT(SHA2(SQL_MODE,256),SHA2(DEFINER,256),SHA2(CHARACTER_SET_CLIENT,256),SHA2(COLLATION_CONNECTION,256),SHA2(DATABASE_COLLATION,256)),256) ELSE NULL END AS contextDigest FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? AND EVENT_OBJECT_SCHEMA = ? ORDER BY TRIGGER_NAME LIMIT 5001`, [database, database], normalizeTargetTrigger, 5000);
  return rows || [];
}

function normalizeTargetTrigger(row) {
  if (![row?.name, row?.tableName, row?.triggerSchema, row?.tableSchema].every(validName) || !['INSERT', 'UPDATE', 'DELETE'].includes(row.event)) return null;
  return { name: row.name, table: row.tableName, triggerSchema: row.triggerSchema, tableSchema: row.tableSchema, event: row.event,
    timing: ['BEFORE', 'AFTER'].includes(row.timing) ? row.timing : null, orientation: row.orientation === 'ROW' ? 'ROW' : null,
    actionOrder: order(row.actionOrder), actionDigest: digest(row.actionDigest) ? row.actionDigest : null,
    contextDigest: digest(row.contextDigest) ? row.contextDigest : null };
}

function projectTrigger(row) {
  return { name: row.name, table: row.table, event: row.event, timing: ['BEFORE', 'AFTER'].includes(row.timing) ? row.timing : null,
    actionOrder: order(row.actionOrder), definitionObserved: digest(row.actionDigest), contextObserved: digest(row.contextDigest) };
}

function reviewTargetTriggers(facts, selectedTables) {
  const findings = [], rows = [], seen = new Set(), positions = new Set();
  let truncated = Array.isArray(facts.triggers) && facts.triggers.length > 5000 || facts.truncated.includes('triggers');
  const flag = code => { if (!findings.includes(code)) findings.push(code); };
  const metadataValid = Array.isArray(facts.triggers) && facts.triggers.length <= 5000;
  let complete = facts.triggerMetadataVersion === 1 && metadataValid && facts.databaseVisible === true
    && [0, 1, 2].includes(facts.lowerCaseTableNames)
    && !facts.errors.some(error => ['triggers', 'objects', 'database', 'server'].includes(error.section))
    && !facts.truncated.some(section => ['triggers', 'objects', 'database', 'server'].includes(section));
  const key = value => facts.lowerCaseTableNames === 1 || facts.lowerCaseTableNames === 2 ? value.toLowerCase() : value;
  const selected = new Set(selectedTables.map(key)), tables = new Map();
  for (const object of (facts.objects || []).slice(0, 5000)) {
    const name = key(object.name), group = tables.get(name) || []; group.push(object); tables.set(name, group);
  }
  const totals = { observed: 0, unknown: 0, insert: 0 };
  for (const trigger of (metadataValid ? facts.triggers : Array.isArray(facts.triggers) ? facts.triggers.slice(0, 5000) : [])) {
    if (![trigger?.name, trigger?.table].every(validName) || !['INSERT', 'UPDATE', 'DELETE'].includes(trigger.event)) {
      complete = false; flag('TARGET_TRIGGER_METADATA_INCOMPLETE'); continue;
    }
    if (!selected.has(key(trigger.table))) continue;
    const row = projectTrigger(trigger), objects = tables.get(key(trigger.table));
    const identity = trigger.name.toLowerCase(), position = JSON.stringify([key(trigger.table), trigger.event, row.timing, row.actionOrder]);
    if (seen.has(identity) || row.actionOrder !== null && positions.has(position)) { complete = false; flag('TARGET_TRIGGER_DUPLICATE_METADATA'); }
    seen.add(identity); positions.add(position);
    if (![trigger.triggerSchema, trigger.tableSchema].every(validName) || key(trigger.triggerSchema) !== key(facts.database) || key(trigger.tableSchema) !== key(facts.database)) {
      complete = false; flag('TARGET_TRIGGER_SCHEMA_MISMATCH');
    }
    if (objects?.length !== 1 || objects[0].type !== 'table') { complete = false; flag('TARGET_TRIGGER_TABLE_NOT_OBSERVED'); }
    if (!row.definitionObserved) { complete = false; flag('TARGET_TRIGGER_DEFINITION_UNKNOWN'); }
    if (!row.contextObserved) { complete = false; flag('TARGET_TRIGGER_CONTEXT_UNKNOWN'); }
    if (!row.timing || !row.actionOrder || trigger.orientation !== 'ROW') { complete = false; flag('TARGET_TRIGGER_METADATA_INCOMPLETE'); }
    totals.observed++; if (trigger.event === 'INSERT') totals.insert++;
    if (rows.length < 200) rows.push({ ...row, status: 'requires-review', reason: 'TARGET_TRIGGER_EFFECTS_NOT_VALIDATED' }); else truncated = true;
  }
  if (!complete) {
    flag('TARGET_TRIGGER_METADATA_INCOMPLETE'); totals.unknown = totals.observed; totals.observed = 0;
    for (const row of rows) { row.status = 'unknown'; row.reason = 'TARGET_TRIGGER_METADATA_INCOMPLETE'; }
  }
  if (totals.observed + totals.unknown) flag('TARGET_TRIGGERS_REQUIRE_REVIEW');
  if (truncated) flag('TARGET_TRIGGER_REPORT_LIMIT');
  return { version: 1, canExecute: false, status: 'partial', visibility: 'account-visible', complete, totals, rows, findings, truncated, requires: [...REQUIRES] };
}

// The main process supplies this metadata report; retain no expression, account
// or individual digest in the plan/renderer, including old or malformed reports.
function projectTargetTriggerReview(value) {
  const unknown = () => ({ version: 1, canExecute: false, status: 'partial', visibility: 'account-visible', complete: false,
    totals: { observed: 0, unknown: 0, insert: 0 }, rows: [], findings: ['TARGET_TRIGGER_METADATA_INCOMPLETE'], truncated: false, requires: [...REQUIRES] });
  if (value?.version !== 1 || value.canExecute !== false || typeof value.complete !== 'boolean' || typeof value.truncated !== 'boolean'
      || !Array.isArray(value.rows) || value.rows.length > 200 || !Array.isArray(value.findings) || value.findings.length > CODES.size
      || value.findings.some(code => !CODES.has(code)) || !['observed', 'unknown', 'insert'].every(name => Number.isSafeInteger(value.totals?.[name]) && value.totals[name] >= 0 && value.totals[name] <= 5000)
      || value.totals.observed + value.totals.unknown > 5000 || value.totals.insert > value.totals.observed + value.totals.unknown) return unknown();
  const rows = [];
  for (const row of value.rows) {
    if (![row?.name, row?.table].every(validName) || !['INSERT', 'UPDATE', 'DELETE'].includes(row.event)
        || ![null, 'BEFORE', 'AFTER'].includes(row.timing) || row.actionOrder !== null && order(row.actionOrder) !== row.actionOrder
        || typeof row.definitionObserved !== 'boolean' || typeof row.contextObserved !== 'boolean'
        || !['unknown', 'requires-review'].includes(row.status)
        || row.reason !== (row.status === 'unknown' ? 'TARGET_TRIGGER_METADATA_INCOMPLETE' : 'TARGET_TRIGGER_EFFECTS_NOT_VALIDATED')) return unknown();
    rows.push({ name: row.name, table: row.table, event: row.event, timing: row.timing, actionOrder: row.actionOrder,
      definitionObserved: row.definitionObserved, contextObserved: row.contextObserved, status: row.status, reason: row.reason });
  }
  if ((!value.truncated && rows.length !== value.totals.observed + value.totals.unknown)
      || rows.length > value.totals.observed + value.totals.unknown
      || value.complete && (value.totals.unknown !== 0 || rows.some(row => row.status !== 'requires-review' || !row.definitionObserved || !row.contextObserved || !row.timing || !row.actionOrder))
      || !value.complete && (value.totals.observed !== 0 || rows.some(row => row.status !== 'unknown'))) return unknown();
  const retainedInserts = rows.filter(row => row.event === 'INSERT').length;
  const omitted = value.totals.observed + value.totals.unknown - rows.length;
  if (value.totals.insert < retainedInserts || value.totals.insert > retainedInserts + omitted) return unknown();
  return { version: 1, canExecute: false, status: 'partial', visibility: 'account-visible', complete: value.complete,
    totals: { observed: value.totals.observed, unknown: value.totals.unknown, insert: value.totals.insert }, rows,
    findings: [...value.findings], truncated: value.truncated, requires: [...REQUIRES] };
}

module.exports = { collectTargetTriggers, normalizeTargetTrigger, projectTrigger, reviewTargetTriggers, projectTargetTriggerReview };
