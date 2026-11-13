'use strict';

const crypto = require('node:crypto');
const { normalizeColumnType, compareSelectionColumns } = require('./restore-selection-columns.cjs');
const { reviewTargetIndexes } = require('./restore-selection-target-indexes.cjs');
const { reviewTargetForeignKeys } = require('./restore-selection-target-foreign-keys.cjs');
const { normalizeSessionSettings, projectSessionSettings } = require('./restore-selection-session-policy.cjs');
const { projectValueColumns } = require('./restore-selection-values.cjs');
const { normalizePacketSettings, projectPacketSettings } = require('./restore-selection-packets.cjs');
const LIMIT = 5000;
const validName = value => typeof value === 'string' && value.length > 0 && value.length <= 64 && !value.includes('\0');

async function collectSelectionTargetFacts(session, database, checkContext = () => {}, selectedTables = null) {
  if (!validName(database)) throw new Error('Database đích không hợp lệ.');
  if (selectedTables !== null && (!Array.isArray(selectedTables) || !selectedTables.length || selectedTables.length > 1000 || selectedTables.some(name => !validName(name)))) throw new Error('Danh sách bảng đích không hợp lệ.');
  const facts = { database, checkedAt: new Date().toISOString(), version: null, lowerCaseTableNames: null, sessionSettings: null, packetSettings: null,
    databaseVisible: null, objects: [], triggers: [], foreignKeys: [], foreignKeyMetadataVersion: 2, columns: [], indexes: [], indexVisibility: { version: 1, status: 'unknown', kind: null }, errors: [], truncated: [] };
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
  const settings = await read('sessionSettings', 'SELECT @@SESSION.foreign_key_checks AS foreignKeyChecks, @@SESSION.autocommit AS autocommit, @@SESSION.sql_mode AS sqlMode, @@SESSION.character_set_client AS charsetClient, @@SESSION.character_set_connection AS charsetConnection, @@SESSION.character_set_results AS charsetResults, @@SESSION.max_allowed_packet AS maxAllowedPacket', [], row => {
    const session = normalizeSessionSettings(row);
    return session ? { session, packetSettings: normalizePacketSettings(row.maxAllowedPacket) } : null;
  }, 1);
  if (settings?.length === 1 && !facts.truncated.includes('sessionSettings')) {
    facts.sessionSettings = settings[0].session;
    facts.packetSettings = settings[0].packetSettings;
    if (!facts.packetSettings) facts.errors.push({ section: 'packetSettings', code: 'METADATA_RESULT_INVALID' });
  } else if (settings) facts.errors.push({ section: 'sessionSettings', code: 'METADATA_RESULT_INVALID' });
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
  facts.foreignKeys = await read('foreignKeys', `SELECT k.CONSTRAINT_NAME AS name, k.TABLE_SCHEMA AS tableSchema, k.TABLE_NAME AS tableName, k.COLUMN_NAME AS columnName, k.REFERENCED_TABLE_SCHEMA AS referencedSchema, k.REFERENCED_TABLE_NAME AS referencedTable, k.REFERENCED_COLUMN_NAME AS referencedColumn, k.ORDINAL_POSITION AS ordinal, r.DELETE_RULE AS onDelete, r.UPDATE_RULE AS onUpdate, r.MATCH_OPTION AS matchOption FROM information_schema.KEY_COLUMN_USAGE k LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON BINARY r.CONSTRAINT_SCHEMA = BINARY k.CONSTRAINT_SCHEMA AND BINARY r.TABLE_NAME = BINARY k.TABLE_NAME AND BINARY r.CONSTRAINT_NAME = BINARY k.CONSTRAINT_NAME AND BINARY r.UNIQUE_CONSTRAINT_SCHEMA = BINARY k.REFERENCED_TABLE_SCHEMA AND BINARY r.REFERENCED_TABLE_NAME = BINARY k.REFERENCED_TABLE_NAME WHERE k.REFERENCED_TABLE_NAME IS NOT NULL AND (k.TABLE_SCHEMA = ? OR k.REFERENCED_TABLE_SCHEMA = ?) ORDER BY k.TABLE_SCHEMA, k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION LIMIT ${LIMIT + 1}`, [database, database], row => {
    if (![row.name, row.tableSchema, row.tableName, row.columnName, row.referencedSchema, row.referencedTable, row.referencedColumn].every(validName)
        || !['number', 'string'].includes(typeof row.ordinal) || !/^\d{1,4}$/.test(String(row.ordinal)) || Number(row.ordinal) < 1 || Number(row.ordinal) > 4096
        || ![null, 'RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION', 'SET DEFAULT'].includes(row.onDelete)
        || ![null, 'RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION', 'SET DEFAULT'].includes(row.onUpdate)
        || ![null, 'NONE', 'SIMPLE', 'FULL', 'PARTIAL'].includes(row.matchOption)) return null;
    return { name: row.name, tableSchema: row.tableSchema, table: row.tableName, column: row.columnName,
      referencedSchema: row.referencedSchema, referencedTable: row.referencedTable, referencedColumn: row.referencedColumn,
      ordinal: Number(row.ordinal), onDelete: row.onDelete, onUpdate: row.onUpdate, match: row.matchOption };
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
  const visibilityColumns = await read('indexVisibility', 'SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME IN (?,?) ORDER BY COLUMN_NAME LIMIT 3',
    ['information_schema', 'STATISTICS', 'IS_VISIBLE', 'IGNORED'], row => ['IS_VISIBLE', 'IGNORED'].includes(row.name) ? { name: row.name } : null, 2);
  if (visibilityColumns?.length === 1 && !facts.truncated.includes('indexVisibility')) {
    facts.indexVisibility = { version: 1, status: 'observed', kind: visibilityColumns[0].name === 'IS_VISIBLE' ? 'mysql-visible' : 'mariadb-ignored' };
  } else if (visibilityColumns?.length === 0) facts.indexVisibility.status = 'unsupported';
  else if (visibilityColumns) facts.errors.push({ section: 'indexVisibility', code: 'METADATA_RESULT_INVALID' });
  // These are fixed identifiers selected by a bounded capability probe, never
  // names supplied by the renderer or arbitrary SQL from the server.
  const visibilityColumn = facts.indexVisibility.kind === 'mysql-visible' ? 'IS_VISIBLE' : facts.indexVisibility.kind === 'mariadb-ignored' ? 'IGNORED' : 'NULL';
  facts.indexes = await read('indexes', `SELECT TABLE_NAME AS tableName, INDEX_NAME AS name, NON_UNIQUE AS nonUnique, SEQ_IN_INDEX AS ordinal, COLUMN_NAME AS columnName, SUB_PART AS prefixLength, COLLATION AS direction, INDEX_TYPE AS type, ${visibilityColumn} AS indexVisibility FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ?${tableFilter} ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX LIMIT 20001`, [database, ...(selectedTables || [])], row => {
    if (!validName(row.tableName) || !validName(row.name) || ![0, 1, '0', '1'].includes(row.nonUnique)
        || !['number', 'string'].includes(typeof row.ordinal) || !/^\d{1,4}$/.test(String(row.ordinal)) || Number(row.ordinal) < 1 || Number(row.ordinal) > 4096
        || row.columnName !== null && !validName(row.columnName)
        || row.prefixLength !== null && (!['number', 'string'].includes(typeof row.prefixLength) || !/^\d{1,5}$/.test(String(row.prefixLength)) || Number(row.prefixLength) < 1 || Number(row.prefixLength) > 65535)
        || facts.indexVisibility.kind !== null && !['YES', 'NO'].includes(row.indexVisibility)
        || ![null, 'A', 'D'].includes(row.direction) || typeof row.type !== 'string' || !/^[A-Z0-9_]{1,32}$/.test(row.type)) return null;
    return { table: row.tableName, name: row.name, nonUnique: Number(row.nonUnique) === 1, ordinal: Number(row.ordinal),
      column: row.columnName, prefixLength: row.prefixLength === null ? null : Number(row.prefixLength), direction: row.direction, type: row.type,
      visibility: facts.indexVisibility.kind === 'mysql-visible' ? row.indexVisibility === 'YES' ? 'visible' : 'invisible'
        : facts.indexVisibility.kind === 'mariadb-ignored' ? row.indexVisibility === 'YES' ? 'ignored' : 'not-ignored' : 'unknown' };
  }, 20000) || [];
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
  const indexGroups = new Map();
  const indexMetadataComplete = Array.isArray(facts.indexes) && facts.indexes.length <= 20000
    && !facts.errors.some(error => error.section === 'indexes') && !facts.truncated.includes('indexes');
  for (const index of (facts.indexes || []).slice(0, 20000)) {
    const table = key(index.table), group = indexGroups.get(table) || [];
    group.push(index); indexGroups.set(table, group);
  }
  let columnFieldBudget = 2000, columnFindingBudget = 1000, indexBudget = 1000, indexPartBudget = 4000, valueColumnBudget = 2000;
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
    const valueColumns = projectValueColumns(targetColumns, facts.databaseVisible === true && [0, 1, 2].includes(facts.lowerCaseTableNames)
      && matches.length === 1 && matches[0].type === 'table'
      && !facts.errors.some(error => ['columns', 'objects', 'database', 'server'].includes(error.section))
      && !facts.truncated.some(section => ['columns', 'objects', 'database', 'server'].includes(section)), valueColumnBudget);
    valueColumnBudget -= valueColumns.columns.length;
    const indexReview = reviewTargetIndexes(indexGroups.get(key(row.name)) || [], {
      metadataComplete: indexMetadataComplete,
      visibilityKind: facts.indexVisibility?.version === 1 && facts.indexVisibility.status === 'observed'
        && !facts.errors.some(error => error.section === 'indexVisibility') && !facts.truncated.includes('indexVisibility') ? facts.indexVisibility.kind : null,
      tableObserved: [0, 1, 2].includes(facts.lowerCaseTableNames) && facts.databaseVisible === true && matches.length === 1 && matches[0].type === 'table'
        && !facts.errors.some(error => ['objects', 'database', 'server'].includes(error.section)) && !facts.truncated.includes('objects'),
      limit: Math.min(50, indexBudget), partLimit: Math.min(800, indexPartBudget)
    });
    if (!indexReview.complete && matches.some(object => object.type === 'table')) add('TARGET_INDEXES_REQUIRE_REVIEW', row.name);
    indexBudget -= indexReview.indexes.length; indexPartBudget -= indexReview.parts;
    return { name: row.name, objects: matches.slice(0, 10), objectCount: matches.length,
      triggers: triggers.slice(0, 10), triggerCount: triggers.length, columnReview, indexReview, valueColumns };
  });
  const targetForeignKeyReview = reviewTargetForeignKeys(facts.foreignKeys, { database: facts.database, selectedTables: source.selectedTables, lowerCaseTableNames: facts.lowerCaseTableNames,
    metadataComplete: facts.foreignKeyMetadataVersion === 2 && Array.isArray(facts.foreignKeys) && facts.foreignKeys.length <= LIMIT
      && !facts.errors.some(error => error.section === 'foreignKeys') && !facts.truncated.includes('foreignKeys') && facts.databaseVisible === true });
  if (!targetForeignKeyReview.complete) add('TARGET_FOREIGN_KEYS_REQUIRE_REVIEW');
  const inbound = new Set();
  const foreignKeys = facts.foreignKeys.filter(fk => key(fk.tableSchema) === key(facts.database) && selected.has(key(fk.table))
    || key(fk.referencedSchema) === key(facts.database) && selected.has(key(fk.referencedTable)));
  for (const fk of foreignKeys) {
    if (key(fk.referencedSchema) === key(facts.database) && selected.has(key(fk.referencedTable))
        && (key(fk.tableSchema) !== key(facts.database) || !selected.has(key(fk.table)))) {
      const identity = JSON.stringify([fk.tableSchema, fk.table, fk.name]);
      if (!inbound.has(identity)) add('TARGET_INBOUND_FK_FROM_UNSELECTED_TABLE', fk.referencedTable, `${fk.tableSchema}.${fk.table}`);
      inbound.add(identity);
    }
  }
  if (foreignKeys.length) add('TARGET_FOREIGN_KEYS_PRESENT');
  if (source.includeStructure && source.totals.dropStatements) add('SOURCE_DROP_REQUIRES_EXPLICIT_POLICY');
  if (facts.database !== source.sourceDatabase) add('SOURCE_SCHEMA_MAPPING_NOT_VALIDATED');
  // The digest names an observation, never an approval token or executable plan.
  // Exclude observation time; include full collected metadata even if the UI is bounded.
  const { checkedAt, ...metadata } = facts;
  const snapshotId = crypto.createHash('sha256').update(JSON.stringify({ version: 9, checksum, targetIdentity,
    sourceDatabase: source.sourceDatabase, tables: [...source.selectedTables].sort(),
    includeStructure: source.includeStructure, includeData: source.includeData, metadata })).digest('hex');
  return { version: 9, canExecute: false, snapshotId, checkedAt, database: facts.database, serverVersion: facts.version,
    lowerCaseTableNames: facts.lowerCaseTableNames, sessionSettings: projectSessionSettings(facts.sessionSettings), packetSettings: projectPacketSettings(facts.packetSettings), visibility: 'account-visible', status: 'partial',
    metadataStatus: { databaseVisible: facts.databaseVisible === true, complete: targetForeignKeyReview.complete && indexMetadataComplete && facts.errors.length === 0 && facts.truncated.length === 0 },
    rows, foreignKeys, targetForeignKeyReview, findings, findingsTruncated };
}

module.exports = { collectSelectionTargetFacts, buildSelectionTargetPreview };
