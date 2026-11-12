'use strict';

const crypto = require('node:crypto');
const { normalizeColumnType, compareSelectionColumns } = require('./restore-selection-columns.cjs');
const LIMIT = 5000;
const validName = value => typeof value === 'string' && value.length > 0 && value.length <= 64 && !value.includes('\0');

async function collectSelectionTargetFacts(session, database, checkContext = () => {}, selectedTables = null) {
  if (!validName(database)) throw new Error('Database đích không hợp lệ.');
  if (selectedTables !== null && (!Array.isArray(selectedTables) || !selectedTables.length || selectedTables.length > 1000 || selectedTables.some(name => !validName(name)))) throw new Error('Danh sách bảng đích không hợp lệ.');
  const facts = { database, checkedAt: new Date().toISOString(), version: null, lowerCaseTableNames: null,
    databaseVisible: null, objects: [], triggers: [], foreignKeys: [], columns: [], errors: [], truncated: [] };
  const read = async (section, sql, params, map, maximum = LIMIT) => {
    checkContext();
    let result;
    try { result = await session.raw(sql, params, 10000); }
    catch (error) {
      checkContext();
      facts.errors.push({ section, code: typeof error.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'METADATA_QUERY_FAILED' });
      return null;
    }
    checkContext();
    const rows = result?.rows;
    if (!Array.isArray(rows)) { facts.errors.push({ section, code: 'METADATA_RESULT_INVALID' }); return null; }
    if (rows.length > maximum) facts.truncated.push(section);
    const projected = [];
    for (const row of rows.slice(0, maximum)) {
      const value = row && typeof row === 'object' ? map(row) : null;
      if (!value) { facts.errors.push({ section, code: 'METADATA_RESULT_INVALID' }); return null; }
      projected.push(value);
    }
    return projected;
  };
  const server = await read('server', 'SELECT VERSION() AS version, @@lower_case_table_names AS lowerCaseTableNames', [], row => {
    if (typeof row.version !== 'string' || !row.version || ![0, 1, 2, '0', '1', '2'].includes(row.lowerCaseTableNames)) return null;
    return { version: row.version.slice(0, 120), lowerCaseTableNames: Number(row.lowerCaseTableNames) };
  });
  if (server?.length === 1) Object.assign(facts, server[0]);
  else if (server) facts.errors.push({ section: 'server', code: 'METADATA_RESULT_INVALID' });
  const schemas = await read('database', 'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ? LIMIT 2', [database], row => validName(row.name) ? { name: row.name } : null);
  if (schemas) facts.databaseVisible = schemas.some(row => facts.lowerCaseTableNames === 1 || facts.lowerCaseTableNames === 2 ? row.name.toLowerCase() === database.toLowerCase() : row.name === database);
  facts.objects = await read('objects', `SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME LIMIT ${LIMIT + 1}`, [database], row => {
    if (!validName(row.name) || !['BASE TABLE', 'VIEW'].includes(row.type)) return null;
    return { name: row.name, type: row.type === 'VIEW' ? 'view' : 'table' };
  }) || [];
  facts.triggers = await read('triggers', `SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tableName, EVENT_MANIPULATION AS event FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME LIMIT ${LIMIT + 1}`, [database], row => {
    if (!validName(row.name) || !validName(row.tableName) || !['INSERT', 'UPDATE', 'DELETE'].includes(row.event)) return null;
    return { name: row.name, table: row.tableName, event: row.event };
  }) || [];
  facts.foreignKeys = await read('foreignKeys', `SELECT CONSTRAINT_NAME AS name, TABLE_SCHEMA AS tableSchema, TABLE_NAME AS tableName, COLUMN_NAME AS columnName, REFERENCED_TABLE_SCHEMA AS referencedSchema, REFERENCED_TABLE_NAME AS referencedTable, REFERENCED_COLUMN_NAME AS referencedColumn FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_NAME IS NOT NULL AND (TABLE_SCHEMA = ? OR REFERENCED_TABLE_SCHEMA = ?) ORDER BY TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION LIMIT ${LIMIT + 1}`, [database, database], row => {
    if (![row.name, row.tableSchema, row.tableName, row.columnName, row.referencedSchema, row.referencedTable, row.referencedColumn].every(validName)) return null;
    return { name: row.name, tableSchema: row.tableSchema, table: row.tableName, column: row.columnName,
      referencedSchema: row.referencedSchema, referencedTable: row.referencedTable, referencedColumn: row.referencedColumn };
  }) || [];
  const tableFilter = selectedTables ? ` AND TABLE_NAME IN (${selectedTables.map(() => '?').join(',')})` : '';
  facts.columns = await read('columns', `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS name, ORDINAL_POSITION AS ordinal, COLUMN_TYPE AS columnType, IS_NULLABLE AS nullable, EXTRA AS extra, CHARACTER_SET_NAME AS charset, COLLATION_NAME AS collation, (COLUMN_DEFAULT IS NOT NULL) AS hasDefault FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?${tableFilter} ORDER BY TABLE_NAME, ORDINAL_POSITION LIMIT 10001`, [database, ...(selectedTables || [])], row => {
    if (!validName(row.tableName) || !validName(row.name) || !Number.isInteger(Number(row.ordinal)) || Number(row.ordinal) < 1 || Number(row.ordinal) > 4096
        || typeof row.columnType !== 'string' || row.columnType.length > 65536 || !['YES', 'NO'].includes(row.nullable)
        || typeof row.extra !== 'string' || row.extra.length > 256 || ![0, 1, '0', '1', true, false].includes(row.hasDefault)
        || row.charset !== null && !validName(row.charset) || row.collation !== null && !validName(row.collation)) return null;
    return { table: row.tableName, name: row.name, ordinal: Number(row.ordinal), ...normalizeColumnType(row.columnType),
      nullable: row.nullable === 'YES', hasDefault: row.hasDefault === true || row.hasDefault === 1 || row.hasDefault === '1',
      autoIncrement: /\bauto_increment\b/i.test(row.extra), generated: /\b(?:VIRTUAL|STORED) GENERATED\b/i.test(row.extra),
      generatedKind: /\bSTORED GENERATED\b/i.test(row.extra) ? 'stored' : /\bVIRTUAL GENERATED\b/i.test(row.extra) ? 'virtual' : null,
      invisible: /\bINVISIBLE\b/i.test(row.extra), charset: row.charset, collation: row.collation,
      attributesKnown: !row.extra.replace(/\b(?:auto_increment|DEFAULT_GENERATED|(?:VIRTUAL|STORED) GENERATED|INVISIBLE)\b/gi, '').trim(),
      extraFingerprint: crypto.createHash('sha256').update(row.extra).digest('hex') };
  }, 10000) || [];
  checkContext();
  return facts;
}

function buildSelectionTargetPreview({ source, checksum, targetIdentity, facts }) {
  if (!source || source.canExecute !== false || !/^[a-f0-9]{64}$/.test(checksum) || !/^[a-f0-9]{64}$/.test(targetIdentity)) throw new Error('Thiếu snapshot nguồn hoặc đích để đối chiếu.');
  const folded = facts.lowerCaseTableNames !== 0;
  const key = name => folded ? name.toLowerCase() : name;
  const selected = new Set(source.selectedTables.map(key));
  const findings = []; let findingsTruncated = false;
  const add = (code, table = null, detail = null) => {
    if (findings.length < 100) findings.push({ code, table, detail }); else findingsTruncated = true;
  };
  add('ACCOUNT_VISIBLE_METADATA_ONLY');
  add('TARGET_RECHECK_REQUIRED');
  add('TARGET_METADATA_NOT_ATOMIC');
  add('SOURCE_SQL_EFFECTS_NOT_VALIDATED');
  if (facts.lowerCaseTableNames === null) add('TARGET_CASE_POLICY_UNKNOWN');
  if (facts.databaseVisible !== true) add('TARGET_DATABASE_NOT_VISIBLE');
  for (const error of facts.errors) add('TARGET_METADATA_ERROR', null, `${error.section}: ${error.code}`);
  for (const section of facts.truncated) add('TARGET_METADATA_TRUNCATED', null, section);
  let columnFieldBudget = 2000, columnFindingBudget = 1000;
  const rows = source.rows.map(row => {
    const matches = facts.objects.filter(object => key(object.name) === key(row.name));
    if (matches.length > 1) add('TARGET_AMBIGUOUS_OBJECT', row.name);
    if (matches.some(object => object.type === 'view')) add('TARGET_VIEW_CONFLICT', row.name);
    else if (source.includeStructure && matches.length) add('TARGET_STRUCTURE_CONFLICT', row.name);
    else if (!source.includeStructure && !matches.length) add('TARGET_DATA_TABLE_NOT_VISIBLE', row.name);
    if (!source.includeStructure && source.includeData && matches.length) add('TARGET_DATA_SCHEMA_NOT_VALIDATED', row.name);
    const triggers = facts.triggers.filter(trigger => key(trigger.table) === key(row.name));
    if (triggers.length) add('TARGET_TRIGGERS_PRESENT', row.name);
    const targetColumns = (facts.columns || []).filter(column => key(column.table) === key(row.name));
    const columnReview = compareSelectionColumns(row, targetColumns, { limit: Math.min(50, columnFieldBudget), findingLimit: Math.min(20, columnFindingBudget),
      metadataComplete: !facts.errors.some(error => error.section === 'columns') && !facts.truncated.includes('columns') });
    columnFieldBudget -= columnReview.fields.length;
    columnFindingBudget -= columnReview.findings.length;
    return { name: row.name, objects: matches.slice(0, 10), objectCount: matches.length,
      triggers: triggers.slice(0, 10), triggerCount: triggers.length, columnReview };
  });
  const foreignKeys = facts.foreignKeys.filter(fk => key(fk.tableSchema) === key(facts.database) && selected.has(key(fk.table))
    || key(fk.referencedSchema) === key(facts.database) && selected.has(key(fk.referencedTable)));
  for (const fk of foreignKeys) {
    if (key(fk.referencedSchema) === key(facts.database) && selected.has(key(fk.referencedTable))
        && (key(fk.tableSchema) !== key(facts.database) || !selected.has(key(fk.table)))) add('TARGET_INBOUND_FK_FROM_UNSELECTED_TABLE', fk.referencedTable, `${fk.tableSchema}.${fk.table}`);
  }
  if (foreignKeys.length) add('TARGET_FOREIGN_KEYS_PRESENT');
  if (source.includeStructure && source.totals.dropStatements) add('SOURCE_DROP_REQUIRES_EXPLICIT_POLICY');
  if (facts.database !== source.sourceDatabase) add('SOURCE_SCHEMA_MAPPING_NOT_VALIDATED');
  // The digest names an observation, never an approval token or executable plan.
  // Exclude observation time; include full collected metadata even if the UI is bounded.
  const { checkedAt, ...metadata } = facts;
  const snapshotId = crypto.createHash('sha256').update(JSON.stringify({ version: 1, checksum, targetIdentity,
    sourceDatabase: source.sourceDatabase, tables: [...source.selectedTables].sort(),
    includeStructure: source.includeStructure, includeData: source.includeData, metadata })).digest('hex');
  return { version: 1, canExecute: false, snapshotId, checkedAt, database: facts.database, serverVersion: facts.version,
    lowerCaseTableNames: facts.lowerCaseTableNames, visibility: 'account-visible', status: 'partial',
    rows, foreignKeys, findings, findingsTruncated };
}

module.exports = { collectSelectionTargetFacts, buildSelectionTargetPreview };
