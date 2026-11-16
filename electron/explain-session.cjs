'use strict';

const crypto = require('node:crypto');
const { splitSqlStatements, stripLeadingComments } = require('./sql-script.cjs');
const { assertReadOnlySql } = require('./connection-policy.cjs');
const { explainSettingNames, explainSettings, explainSchema } = require('../query-results.js');
const { SCHEMA_BYTES, singleTableSource, showCreateSql, captureTableDefinition } = require('./explain-schema.cjs');

const SETTINGS_SQL = 'SELECT ' + explainSettingNames.map(name => {
  const expression = name === 'server_version' ? 'VERSION()' : name === 'database' ? 'DATABASE()'
    : name === 'autocommit' ? 'IF(@@SESSION.autocommit, 1, 0)' : `@@SESSION.${name}`;
  return `CAST(${expression} AS CHAR) AS \`${name}\``;
}).join(', ') + ' LIMIT 1';
const SETTINGS_BYTES = 32768;

function canObserveExplainSettings(sql) {
  if (typeof sql !== 'string' || sql.length > 1024 * 1024 || !/^EXPLAIN\b/i.test(stripLeadingComments(sql))) return false;
  try {
    assertReadOnlySql({ readOnly: true }, sql);
    return splitSqlStatements(sql).length === 1;
  } catch { return false; }
}

function captureSettings(result) {
  if (result?.kind !== 'rows' || result.truncated || !Array.isArray(result.columns) || result.columns.length !== explainSettingNames.length
      || result.columns.some((column, index) => column?.name !== explainSettingNames[index])
      || !Array.isArray(result.rows) || result.rows.length !== 1 || !Array.isArray(result.rows[0]) || result.rows[0].length !== explainSettingNames.length) return null;
  const fields = [];
  for (let index = 0; index < explainSettingNames.length; index++) {
    const name = explainSettingNames[index], value = result.rows[0][index];
    const maximum = ['sql_mode', 'optimizer_switch'].includes(name) ? 8192 : name === 'server_version' ? 256 : 64;
    if (value === null ? !['database', 'character_set_results'].includes(name)
      : typeof value !== 'string' || value.length > maximum || value.includes('\0')) return null;
    if (name === 'autocommit' && !['0', '1'].includes(value)) return null;
    if (name === 'sql_select_limit' && (typeof value !== 'string' || !/^\d{1,20}$/.test(value) || /[\r\n]/.test(value))) return null;
    if (name !== 'sql_mode' && value !== null && !value) return null;
    fields.push({ name, digest: crypto.createHash('sha256').update(JSON.stringify([1, name, value])).digest('hex') });
  }
  return fields;
}

function unknown(reason) { return { version: 1, status: 'unknown', reason }; }
function errorReason(error) {
  return error?.code === 'QUERY_CANCELED' ? 'canceled' : error?.code === 'QUERY_TIMEOUT' ? 'timeout' : 'unavailable';
}

async function runExplainWithContext({ sql, timeoutMs, rowLimit, read, check, isDead, database,
  settingsRequested = true, schemaRequested = false, now = Date.now }) {
  if (!canObserveExplainSettings(sql)) throw Object.assign(new Error('Chỉ quan sát thiết lập cho một EXPLAIN SELECT được nhận diện.'), { code: 'EXPLAIN_SETTINGS_UNSUPPORTED' });
  const deadline = now() + Math.min(900000, Math.max(1, Number(timeoutMs) || 30000));
  const remaining = () => {
    const value = deadline - now();
    if (value <= 0) throw Object.assign(new Error('Lượt EXPLAIN đã hết thời gian chờ.'), { code: 'QUERY_TIMEOUT' });
    return value;
  };
  const capture = async observation => {
    check();
    const result = await read(observation.sql, Math.min(2000, remaining()), 1, observation.bytes);
    check();
    return observation.capture(result);
  };
  const observations = [];
  if (settingsRequested) observations.push({ key: 'explainSettings', sql: SETTINGS_SQL, bytes: SETTINGS_BYTES, capture: captureSettings,
    compare: (before, after) => {
      const changedFields = before.filter((field, index) => field.digest !== after[index].digest).map(field => field.name);
      return explainSettings(changedFields.length ? { version: 1, status: 'changed-during-run', changedFields }
        : { version: 1, status: 'observed', fields: before });
    } });
  if (schemaRequested) {
    const source = singleTableSource(sql, database);
    observations.push({ key: 'explainSchema', sql: showCreateSql(source), bytes: SCHEMA_BYTES, capture: captureTableDefinition,
      compare: (before, after) => explainSchema({ version: 1, status: before === after ? 'observed' : 'changed-during-run',
        ...source, ...(before === after ? { digest: before } : {}) }) });
  }
  for (const observation of observations) {
    observation.before = null;
    observation.reason = observation.sql ? 'invalid' : 'unsupported-sql';
    if (!observation.sql) continue;
    try { observation.before = await capture(observation); }
    catch (error) {
      if (isDead() || ['QUERY_CANCELED', 'QUERY_TIMEOUT'].includes(error.code)) throw error;
      observation.reason = errorReason(error);
    }
  }
  check();
  const result = await read(sql, remaining(), rowLimit);
  // A completed plan remains useful if the optional trailing observation fails.
  // Never rerun SQL, reconnect, change settings or discard its original rows.
  for (const observation of observations) {
    result[observation.key] = unknown(observation.reason);
    try {
      check();
      if (!observation.before) continue;
      const after = await capture(observation);
      result[observation.key] = after ? observation.compare(observation.before, after) : unknown('invalid');
    } catch (error) {
      result[observation.key] = unknown(['EXPLAIN_CONTEXT_CHANGED', 'PROFILE_TARGET_CHANGED', 'CONNECTION_READ_ONLY'].includes(error.code)
        ? 'context-changed' : errorReason(error));
    }
  }
  return result;
}

module.exports = { SETTINGS_SQL, SETTINGS_BYTES, canObserveExplainSettings, captureSettings, runExplainWithContext };
