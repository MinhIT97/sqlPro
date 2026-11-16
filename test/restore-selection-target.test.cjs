'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { collectSelectionTargetFacts, buildSelectionTargetPreview } = require('../electron/restore-selection-target.cjs');
const { previewRestoreSelection } = require('../electron/restore-selection.cjs');
const { normalizeSessionSettings } = require('../electron/restore-selection-session-policy.cjs');

function source(tables = ['parent'], flags = {}) {
  return previewRestoreSelection({ version: 1, database: 'source_db', findings: [], truncated: false, opaqueObjects: [],
    tables: ['parent', 'child'].map(name => ({ name, createStatements: 1, dataStatements: 1, dropStatements: 1, dependencies: [] })) }, { tables, ...flags });
}
function facts(overrides = {}) {
  return { database: 'target_db', checkedAt: '2026-11-12T00:00:00Z', version: '8.4', lowerCaseTableNames: 0, databaseVisible: true,
    objects: [{ name: 'parent', type: 'table' }], triggers: [{ name: 'after_parent', table: 'parent', event: 'INSERT' }],
    foreignKeyMetadataVersion: 2, foreignKeys: [{ ordinal: 1, onDelete: 'RESTRICT', onUpdate: 'CASCADE', match: 'NONE', name: 'fk_outside', tableSchema: 'another_db', table: 'child', column: 'parent_id', referencedSchema: 'target_db', referencedTable: 'parent', referencedColumn: 'id' }], indexes: [], indexVisibility: { version: 1, status: 'observed', kind: 'mysql-visible' }, errors: [], truncated: [], ...overrides };
}
const report = (metadata = facts(), selected = source(), checksum = 'a'.repeat(64), targetIdentity = 'b'.repeat(64)) => buildSelectionTargetPreview({ source: selected, checksum, targetIdentity, facts: metadata });

test('session metadata is read-only, bounded, projected and bound to snapshot including unknown-mode drift', async () => {
  const raw = { foreignKeyChecks: 1, uniqueChecks: 1, autocommit: 1, sqlMode: 'STRICT_TRANS_TABLES,PRIVATE_MODE',
    charsetClient: 'utf8mb4', charsetConnection: 'utf8mb4', charsetResults: 'utf8mb4', maxAllowedPacket: 67108864, privateValue: 'secret' };
  const queries = [];
  const result = await collectSelectionTargetFacts({ raw: async (sql, params) => {
    queries.push(sql); assert.match(sql, /^SELECT /);
    if (sql.includes('AS foreignKeyChecks')) { assert.match(sql, /@@SESSION.unique_checks AS uniqueChecks/); assert.deepEqual(params, []); return { rows: [raw] }; }
    return { rows: [] };
  } }, 'target_db');
  assert.deepEqual(result.sessionSettings, normalizeSessionSettings(raw));
  assert.equal(queries.filter(sql => sql.includes('AS foreignKeyChecks')).length, 1);
  assert.equal(JSON.stringify(result).includes('PRIVATE_MODE'), false); assert.equal(JSON.stringify(result).includes('secret'), false);
  const initial = report(facts({ sessionSettings: result.sessionSettings }));
  assert.notEqual(initial.snapshotId, report(facts()).snapshotId);
  for (const changes of [{ foreignKeyChecks: 0 }, { uniqueChecks: 0 }, { autocommit: 0 }, { sqlMode: 'STRICT_TRANS_TABLES,OTHER_MODE' }, { charsetResults: 'latin1' }]) {
    assert.notEqual(initial.snapshotId, report(facts({ sessionSettings: normalizeSessionSettings({ ...raw, ...changes }) })).snapshotId);
  }
  for (const rows of [[], [raw, raw], [{ ...raw, autocommit: null }]]) {
    const invalid = await collectSelectionTargetFacts({ raw: async sql => ({ rows: sql.includes('AS foreignKeyChecks') ? rows : [] }) }, 'target_db');
    assert.equal(invalid.sessionSettings, null);
    assert.ok(invalid.errors.some(error => error.section === 'sessionSettings') || invalid.truncated.includes('sessionSettings'));
  }
  const denied = await collectSelectionTargetFacts({ raw: async sql => {
    if (sql.includes('AS foreignKeyChecks')) throw Object.assign(new Error('private-settings-error'), { code: 'ER_SPECIFIC_ACCESS_DENIED_ERROR' });
    return { rows: [] };
  } }, 'target_db');
  assert.equal(denied.sessionSettings, null); assert.ok(denied.errors.some(error => error.section === 'sessionSettings'));
  assert.equal(JSON.stringify(denied).includes('private-settings-error'), false);
  let canceled = false, calls = 0;
  await assert.rejects(() => collectSelectionTargetFacts({ raw: async sql => {
    calls++; if (sql.includes('AS foreignKeyChecks')) canceled = true; return { rows: [] };
  } }, 'target_db', () => { if (canceled) throw new Error('canceled-settings'); }), /canceled-settings/);
  assert.equal(calls, 2);
});

test('target value-column metadata requires an observed table and complete ordered bounded columns', () => {
  const column = { table: 'parent', name: 'id', ordinal: 1, type: 'int', typeKnown: true, nullable: false, autoIncrement: false,
    generated: false, invisible: false, attributesKnown: true, privateValue: 'private-default' };
  const initial = report(facts({ columns: [column] }));
  assert.equal(initial.rows[0].valueColumns.complete, true);
  assert.equal(JSON.stringify(initial.rows[0].valueColumns).includes('private-default'), false);
  for (const changes of [{ objects: [] }, { objects: [{ name: 'parent', type: 'view' }] }, { lowerCaseTableNames: null },
    { errors: [{ section: 'columns', code: 'METADATA_RESULT_INVALID' }] }, { truncated: ['columns'] },
    { columns: [{ ...column, ordinal: 2 }] }, { columns: [column, { ...column, ordinal: 2 }] }]) {
    assert.equal(report(facts({ columns: [column], ...changes })).rows[0].valueColumns.complete, false);
  }
  assert.notEqual(initial.snapshotId, report(facts({ columns: [{ ...column, nullable: true }] })).snapshotId);
  const names = Array.from({ length: 21 }, (_, index) => `t${index}`);
  const selected = { canExecute: false, selectedTables: names, rows: names.map(name => ({ name })), sourceDatabase: 'source_db', includeStructure: false, includeData: true, totals: {} };
  const metadata = facts({ objects: names.map(name => ({ name, type: 'table' })), triggers: [], foreignKeys: [],
    columns: names.flatMap(table => Array.from({ length: 100 }, (_, index) => ({ ...column, table, name: `c${index}`, ordinal: index + 1 }))) });
  const bounded = report(metadata, selected);
  assert.equal(bounded.rows.reduce((sum, row) => sum + row.valueColumns.columns.length, 0), 2000);
  assert.equal(bounded.rows.at(-1).valueColumns.complete, false); assert.deepEqual(bounded.rows.at(-1).valueColumns.columns, []);
});

test('target preview identifies table/view conflicts, triggers and inbound FK from outside selection', () => {
  const input = facts(); const before = structuredClone(input);
  const result = report(input);
  assert.equal(result.canExecute, false); assert.equal(result.status, 'partial');
  for (const code of ['TARGET_STRUCTURE_CONFLICT', 'TARGET_TRIGGERS_PRESENT', 'TARGET_INBOUND_FK_FROM_UNSELECTED_TABLE', 'TARGET_FOREIGN_KEYS_PRESENT', 'SOURCE_DROP_REQUIRES_EXPLICIT_POLICY']) assert.ok(result.findings.some(item => item.code === code), code);
  assert.equal(result.rows[0].objects[0].name, 'parent'); assert.equal(result.foreignKeys[0].tableSchema, 'another_db');
  assert.ok(report(facts({ objects: [{ name: 'parent', type: 'view' }] })).findings.some(item => item.code === 'TARGET_VIEW_CONFLICT'));
  assert.deepEqual(input, before);
});

test('data-only missing tables and unknown metadata never imply safe target', () => {
  const result = report(facts({ databaseVisible: false, lowerCaseTableNames: null, objects: [], triggers: [], foreignKeys: [],
    errors: [{ section: 'triggers', code: 'ER_TABLEACCESS_DENIED_ERROR' }], truncated: ['foreignKeys'] }), source(['parent'], { includeStructure: false }));
  for (const code of ['TARGET_DATABASE_NOT_VISIBLE', 'TARGET_CASE_POLICY_UNKNOWN', 'TARGET_DATA_TABLE_NOT_VISIBLE', 'TARGET_METADATA_ERROR', 'TARGET_METADATA_TRUNCATED', 'ACCOUNT_VISIBLE_METADATA_ONLY']) assert.ok(result.findings.some(item => item.code === code), code);
  assert.equal(result.canExecute, false);
  assert.ok(report(facts(), source(['parent'], { includeStructure: false })).findings.some(item => item.code === 'TARGET_DATA_SCHEMA_NOT_VALIDATED'));
});

test('target name matching uses server case policy and FK selection respects schema identity', () => {
  const metadata = facts({ database: 'TARGET_DB', lowerCaseTableNames: 1, objects: [{ name: 'PARENT', type: 'table' }],
    triggers: [{ name: 'tr', table: 'PARENT', event: 'INSERT' }] });
  const folded = report(metadata);
  assert.equal(folded.rows[0].objectCount, 1); assert.equal(folded.rows[0].triggerCount, 1); assert.equal(folded.foreignKeys.length, 1);
  const exact = report({ ...metadata, lowerCaseTableNames: 0 });
  assert.equal(exact.rows[0].objectCount, 0); assert.equal(exact.rows[0].triggerCount, 0); assert.equal(exact.foreignKeys.length, 0);
});

test('snapshot digest binds checksum, selected flags, target identity and all metadata but not observation time', () => {
  const base = report();
  assert.match(base.snapshotId, /^[a-f0-9]{64}$/);
  assert.equal(base.snapshotId, report(facts({ checkedAt: '2027-01-01T00:00:00Z' })).snapshotId);
  for (const changed of [report(facts(), source(), 'c'.repeat(64)), report(facts(), source(), 'a'.repeat(64), 'c'.repeat(64)),
    report(facts(), source(['child'])), report(facts(), source(['parent'], { includeData: false })), report(facts({ objects: [] }))]) assert.notEqual(base.snapshotId, changed.snapshotId);
  assert.throws(() => report(facts(), source(), 'not-a-checksum'));
  assert.equal(report(facts(), source(['child', 'parent'])).snapshotId, report(facts(), source(['parent', 'child'])).snapshotId);
});

test('metadata identity isolates observed target facts from source bytes/flags/time and binds exact selection/target identity', () => {
  const base = report(); assert.match(base.metadataId, /^[a-f0-9]{64}$/);
  assert.equal(base.metadataId, report(facts({ checkedAt: '2027-01-01T00:00:00Z' })).metadataId);
  assert.equal(base.metadataId, report(facts(), source(), 'c'.repeat(64)).metadataId);
  assert.equal(base.metadataId, report(facts(), source(['parent'], { includeStructure: false })).metadataId);
  assert.equal(base.metadataId, report(facts(), source(['parent'], { includeData: false })).metadataId);
  for (const changed of [report(facts({ objects: [] })), report(facts({ database: 'another' })), report(facts(), source(['child'])),
    report(facts(), source(), 'a'.repeat(64), 'c'.repeat(64)), report(facts({ errors: [{ section: 'triggers', code: 'METADATA_QUERY_FAILED' }] }))]) assert.notEqual(base.metadataId, changed.metadataId);
  assert.equal(report(facts(), source(['child', 'parent'])).metadataId, report(facts(), source(['parent', 'child'])).metadataId);
});

test('collector sends only fixed metadata SELECT statements with bound schema values', async () => {
  const queries = [], database = "db' OR 1=1 --";
  const session = { raw: async (sql, params, timeout) => {
    queries.push({ sql, params }); assert.match(sql, /^SELECT /); assert.equal(timeout, 10000); assert.equal(sql.includes(database), false);
    if (sql.includes('VERSION()')) return { rows: [{ version: '8.4', lowerCaseTableNames: 0 }] };
    if (sql.includes('SCHEMATA')) return { rows: [{ name: database }] };
    if (sql.includes('information_schema.TABLES')) return { rows: [{ name: '__proto__', type: 'BASE TABLE', secret: 'not-returned' }] };
    return { rows: [] };
  } };
  const result = await collectSelectionTargetFacts(session, database);
  assert.equal(result.databaseVisible, true); assert.deepEqual(result.objects, [{ name: '__proto__', type: 'table', engine: null }]);
  assert.equal(queries.length, 11); assert.deepEqual(queries.find(query => query.sql.includes('KEY_COLUMN_USAGE')).params, [database, database]);
  await assert.rejects(() => collectSelectionTargetFacts(session, 'invalid\0database'));
});

test('collector bounds metadata, masks raw errors and treats malformed results as unknown', async () => {
  const result = await collectSelectionTargetFacts({ raw: async sql => {
    if (sql.includes('VERSION()')) return { rows: [{ version: '8.4', lowerCaseTableNames: null }] };
    if (sql.includes('SCHEMATA')) return { rows: [] };
    if (sql.includes('information_schema.TABLES')) return { rows: Array.from({ length: 5001 }, (_, i) => ({ name: `t${i}`, type: 'BASE TABLE' })) };
    if (sql.includes('TRIGGERS')) throw Object.assign(new Error('password or SQL must stay private'), { code: 'ER_TABLEACCESS_DENIED_ERROR' });
    return { rows: [{ name: 'incomplete' }] };
  } }, 'target_db');
  assert.equal(result.objects.length, 5000); assert.deepEqual(result.truncated, ['objects']);
  assert.equal(result.lowerCaseTableNames, null); assert.equal(result.databaseVisible, false);
  assert.equal(JSON.stringify(result).includes('password'), false); assert.equal(result.errors.length, 8);
  const many = facts({ triggers: Array.from({ length: 30 }, (_, i) => ({ name: `trigger${i}`, table: 'parent', event: 'INSERT' })) });
  assert.equal(report(many).rows[0].triggers.length, 10); assert.equal(report(many).rows[0].triggerCount, 30);
});

test('context cancellation propagates before and after awaited queries', async () => {
  let checks = 0, queries = 0;
  await assert.rejects(() => collectSelectionTargetFacts({ raw: async () => { queries++; return { rows: [] }; } }, 'target_db', () => {
    if (++checks > 1) throw new Error('canceled');
  }), /canceled/);
  assert.equal(queries, 1);
});

test('column collector binds selected table names, redacts enum labels/default values and recognizes generated precisely', async () => {
  let query;
  const result = await collectSelectionTargetFacts({ raw: async (sql, params) => {
    if (sql.includes('VERSION()')) return { rows: [{ version: '8.4', lowerCaseTableNames: 0 }] };
    if (!sql.includes('COLUMN_TYPE AS columnType')) return { rows: [] };
    query = { sql, params };
    return { rows: [
      { tableName: 'parent', name: 'kind', ordinal: 1, columnType: "enum('private-label')", nullable: 'YES', extra: 'DEFAULT_GENERATED', charset: 'utf8mb4', collation: 'utf8mb4_bin', hasDefault: 1, defaultValue: 'private-default' },
      { tableName: 'parent', name: 'calc', ordinal: 2, columnType: 'int', nullable: 'YES', extra: 'STORED GENERATED', charset: null, collation: null, hasDefault: 0 }
    ] };
  } }, 'target_db', () => {}, ['parent', "odd'name"]);
  assert.deepEqual(query.params, ['target_db', 'parent', "odd'name"]);
  assert.match(query.sql, /TABLE_NAME IN \(\?,\?\)/); assert.equal(query.sql.includes("odd'name"), false);
  assert.equal(result.columns[0].type, 'enum(…)'); assert.equal(result.columns[0].generated, false);
  assert.equal(result.columns[1].generated, true); assert.equal(result.columns[1].generatedKind, 'stored');
  assert.equal(JSON.stringify(result).includes('private-'), false);
  assert.match(query.sql, /SHA2\(GENERATION_EXPRESSION,256\)/);
  assert.match(query.sql, /SHA2\(COLUMN_DEFAULT,256\)/);
});

test('target snapshot changes when column metadata changes and column report remains partial', () => {
  const { RestoreSelectionInventory } = require('../electron/restore-selection.cjs');
  const { assertStatementScope } = require('../electron/sql-script.cjs');
  const collector = new RestoreSelectionInventory('source_db');
  const sql = 'CREATE TABLE parent (id bigint NOT NULL)'; collector.add(sql, assertStatementScope(sql, 'source_db', 1), 1);
  const selected = previewRestoreSelection(collector.finish(), { tables: ['parent'], includeStructure: false });
  const columns = [{ table: 'parent', name: 'id', ordinal: 1, ...require('../electron/restore-selection-columns.cjs').normalizeColumnType('bigint'), nullable: false, autoIncrement: false, generated: false, generatedKind: null, invisible: false, hasDefault: false, charset: null, collation: null }];
  const first = report(facts({ columns }), selected);
  const changed = report(facts({ columns: [{ ...columns[0], type: 'int' }] }), selected);
  assert.notEqual(first.snapshotId, changed.snapshotId);
  assert.equal(first.rows[0].columnReview.status, 'partial');
  assert.ok(changed.rows[0].columnReview.findings.some(item => item.code === 'COLUMN_TYPE_DIFFERS'));
});

test('unhandled EXTRA attributes stay unknown and their complete fingerprint binds snapshot drift', async () => {
  let extra = 'on update CURRENT_TIMESTAMP';
  const session = { raw: async sql => {
    if (sql.includes('VERSION()')) return { rows: [{ version: '8.4', lowerCaseTableNames: 0 }] };
    if (sql.includes('SCHEMATA')) return { rows: [{ name: 'target_db' }] };
    if (sql.includes('COLUMN_TYPE AS columnType')) return { rows: [{ tableName: 'parent', name: 'updated_at', ordinal: 1, columnType: 'datetime',
      nullable: 'YES', extra, charset: null, collation: null, hasDefault: 0 }] };
    return { rows: [] };
  } };
  const first = await collectSelectionTargetFacts(session, 'target_db');
  assert.equal(first.columns[0].attributesKnown, false);
  assert.equal(JSON.stringify(first).includes('CURRENT_TIMESTAMP'), false);
  extra = 'on update CURRENT_TIMESTAMP(3)';
  const second = await collectSelectionTargetFacts(session, 'target_db');
  assert.notEqual(first.columns[0].extraFingerprint, second.columns[0].extraFingerprint);
  assert.notEqual(report(first).snapshotId, report(second).snapshotId);
});

const statistic = (overrides = {}) => ({ tableName: 'parent', name: 'PRIMARY', nonUnique: 0, ordinal: 1,
  columnName: 'id', prefixLength: null, direction: 'A', type: 'BTREE', indexVisibility: 'YES', ...overrides });

test('index collector binds schema/table filters and projects only bounded structural metadata', async () => {
  let query;
  const result = await collectSelectionTargetFacts({ raw: async (sql, params) => {
    if (sql.includes('VERSION()')) return { rows: [{ version: '8.4', lowerCaseTableNames: 0 }] };
    if (sql.includes('COLUMN_NAME AS name FROM information_schema.COLUMNS')) return { rows: [{ name: 'IS_VISIBLE' }] };
    if (!sql.includes('information_schema.STATISTICS')) return { rows: [] };
    query = { sql, params };
    return { rows: [statistic({ ordinal: '1', expression: 'private-expression', cardinality: 1234567 }),
      statistic({ name: 'functional', columnName: null }), statistic({ name: 'prefix', nonUnique: '1', prefixLength: '10', direction: 'D' })] };
  } }, "db'quoted", () => {}, ['parent', "odd'name"]);
  assert.deepEqual(query.params, ["db'quoted", 'parent', "odd'name"]);
  assert.match(query.sql, /TABLE_NAME IN \(\?,\?\)/); assert.match(query.sql, /LIMIT 20001$/);
  assert.equal(query.sql.includes("odd'name"), false); assert.equal(query.sql.includes('EXPRESSION'), false); assert.equal(query.sql.includes('CARDINALITY'), false);
  assert.deepEqual(result.indexes[0], { table: 'parent', name: 'PRIMARY', nonUnique: false, ordinal: 1, column: 'id', prefixLength: null, direction: 'A', type: 'BTREE', visibility: 'visible' });
  assert.equal(result.indexes[1].column, null); assert.equal(result.indexes[2].prefixLength, 10);
  assert.equal(JSON.stringify(result).includes('private-'), false);
});

test('index metadata errors, malformed rows and quotas remain unknown and cancel propagates at the new query', async () => {
  for (const changes of [{ ordinal: true }, { ordinal: 0 }, { prefixLength: true }, { prefixLength: 0 }, { nonUnique: 2 }, { direction: 'wrong' }, { columnName: undefined }]) {
    const result = await collectSelectionTargetFacts({ raw: async sql => ({ rows: sql.includes('STATISTICS') ? [statistic(changes)] : [] }) }, 'target_db');
    assert.deepEqual(result.indexes, []);
    assert.ok(result.errors.some(error => error.section === 'indexes' && error.code === 'METADATA_RESULT_INVALID'));
  }
  const denied = await collectSelectionTargetFacts({ raw: async sql => {
    if (sql.includes('STATISTICS')) throw Object.assign(new Error('private-error'), { code: 'ER_TABLEACCESS_DENIED_ERROR' });
    return { rows: [] };
  } }, 'target_db');
  assert.equal(report(denied).metadataStatus.complete, false); assert.equal(JSON.stringify(denied).includes('private-'), false);
  const limited = await collectSelectionTargetFacts({ raw: async sql => ({ rows: sql.includes('STATISTICS') ? Array(20001).fill(statistic()) : [] }) }, 'target_db');
  assert.equal(limited.indexes.length, 20000); assert.ok(limited.truncated.includes('indexes'));
  assert.equal(report(limited).rows[0].indexReview.complete, false);
  let canceled = false;
  await assert.rejects(() => collectSelectionTargetFacts({ raw: async sql => { if (sql.includes('STATISTICS')) canceled = true; return { rows: [] }; } },
    'target_db', () => { if (canceled) throw new Error('canceled-index-read'); }), /canceled-index-read/);
});

test('target index snapshot binds order, prefix, uniqueness and type drift; missing legacy evidence stays unknown', () => {
  const index = { table: 'parent', name: 'pair', nonUnique: false, ordinal: 1, column: 'id', prefixLength: null, direction: 'A', type: 'BTREE', visibility: 'visible' };
  const first = report(facts({ indexes: [index] }));
  assert.equal(first.version, 16); assert.equal(first.rows[0].indexReview.complete, true);
  for (const changes of [{ nonUnique: true }, { ordinal: 2 }, { prefixLength: 8 }, { direction: 'D' }, { type: 'HASH' }, { column: null }, { visibility: 'invisible' }]) {
    assert.notEqual(report(facts({ indexes: [{ ...index, ...changes }] })).snapshotId, first.snapshotId);
  }
  const legacy = facts(); delete legacy.indexes;
  assert.equal(report(legacy).metadataStatus.complete, false); assert.equal(report(legacy).rows[0].indexReview.complete, false);
  assert.ok(report(legacy).findings.some(item => item.code === 'TARGET_INDEXES_REQUIRE_REVIEW'));
  assert.equal(report(facts({ indexes: [index], lowerCaseTableNames: null })).rows[0].indexReview.complete, false);
  assert.equal(report(facts({ indexes: [index], objects: [{ name: 'parent', type: 'view' }] })).rows[0].indexReview.complete, false);
  assert.equal(report(facts({ indexes: [index], objects: [{ name: 'parent', type: 'table' }, { name: 'parent', type: 'table' }] })).rows[0].indexReview.complete, false);
});

test('aggregate target index response budgets stay bounded and exhausted tables retain unknown status', () => {
  const names = Array.from({ length: 250 }, (_, i) => `t${i}`);
  const selected = { canExecute: false, selectedTables: names, rows: names.map(name => ({ name })), sourceDatabase: 'source_db', includeStructure: false, includeData: true, totals: {} };
  const indexes = names.flatMap(table => Array.from({ length: 5 }, (_, key) => Array.from({ length: 5 }, (_, col) => ({ table, name: `key${key}`, nonUnique: false,
    ordinal: col + 1, column: `c${col}`, prefixLength: null, direction: 'A', type: 'BTREE', visibility: 'visible' }))).flat());
  const result = report(facts({ indexes, objects: names.map(name => ({ name, type: 'table' })), triggers: [], foreignKeys: [] }), selected);
  assert.ok(result.rows.reduce((sum, row) => sum + row.indexReview.indexes.length, 0) <= 1000);
  assert.equal(result.rows.reduce((sum, row) => sum + row.indexReview.parts, 0), 4000);
  assert.equal(result.rows.at(-1).indexReview.complete, false); assert.equal(result.rows.at(-1).indexReview.truncated, true);
  assert.equal(result.canExecute, false);
});

test('capability probe chooses only fixed visibility columns and validates YES/NO values without version guessing', async () => {
  for (const [name, flag, kind, state] of [['IS_VISIBLE', 'YES', 'mysql-visible', 'visible'], ['IS_VISIBLE', 'NO', 'mysql-visible', 'invisible'],
    ['IGNORED', 'YES', 'mariadb-ignored', 'ignored'], ['IGNORED', 'NO', 'mariadb-ignored', 'not-ignored']]) {
    const queries = [];
    const result = await collectSelectionTargetFacts({ raw: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes('COLUMN_NAME AS name FROM information_schema.COLUMNS')) return { rows: [{ name }] };
      if (sql.includes('information_schema.STATISTICS')) return { rows: [statistic({ indexVisibility: flag })] };
      return { rows: [] };
    } }, 'target_db', () => {}, ['parent']);
    assert.deepEqual(result.indexVisibility, { version: 1, status: 'observed', kind });
    assert.equal(result.indexes[0].visibility, state);
    assert.deepEqual(queries.find(query => query.sql.includes('LIMIT 3')).params, ['information_schema', 'STATISTICS', 'IS_VISIBLE', 'IGNORED']);
    assert.match(queries.find(query => query.sql.includes('information_schema.STATISTICS')).sql, new RegExp(`${name} AS indexVisibility`));
    assert.deepEqual(queries.find(query => query.sql.includes('information_schema.STATISTICS')).params, ['target_db', 'parent']);
  }
});

test('missing, denied, malformed or ambiguous flag metadata stays unknown and never retries by assuming visible', async () => {
  for (const names of [[], ['IS_VISIBLE', 'IGNORED'], ['IS_VISIBLE', 'IS_VISIBLE'], ['private-column'], ['IS_VISIBLE', 'IGNORED', 'IS_VISIBLE']]) {
    let statisticsQuery;
    const result = await collectSelectionTargetFacts({ raw: async sql => {
      if (sql.includes('COLUMN_NAME AS name FROM information_schema.COLUMNS')) return { rows: names.map(name => ({ name })) };
      if (sql.includes('information_schema.STATISTICS')) { statisticsQuery = sql; return { rows: [statistic()] }; }
      return { rows: [] };
    } }, 'target_db');
    assert.equal(result.indexVisibility.kind, null); assert.equal(result.indexes[0].visibility, 'unknown');
    assert.match(statisticsQuery, /NULL AS indexVisibility/); assert.equal(JSON.stringify(result).includes('private-'), false);
  }
  for (const flag of [undefined, null, 0, true, 'yes', 'private-value']) {
    const result = await collectSelectionTargetFacts({ raw: async sql => {
      if (sql.includes('COLUMN_NAME AS name FROM information_schema.COLUMNS')) return { rows: [{ name: 'IS_VISIBLE' }] };
      return { rows: sql.includes('information_schema.STATISTICS') ? [statistic({ indexVisibility: flag })] : [] };
    } }, 'target_db');
    assert.equal(result.indexes.length, 0); assert.ok(result.errors.some(error => error.section === 'indexes'));
    assert.equal(JSON.stringify(result).includes('private-'), false);
  }
  let canceled = false;
  await assert.rejects(() => collectSelectionTargetFacts({ raw: async sql => {
    if (sql.includes('COLUMN_NAME AS name FROM information_schema.COLUMNS')) canceled = true;
    return { rows: [] };
  } }, 'target_db', () => { if (canceled) throw new Error('canceled-flag-probe'); }), /canceled-flag-probe/);
});

const fkMetadata = (changes = {}) => ({ name: 'fk_pair', tableSchema: 'target_db', tableName: 'child', columnName: 'pa', referencedSchema: 'target_db',
  referencedTable: 'parent', referencedColumn: 'a', ordinal: 1, onDelete: 'SET NULL', onUpdate: 'CASCADE', matchOption: 'NONE', ...changes });

test('FK collector joins rules by schema/table/name, binds both schema scopes and projects ordered pairs/actions', async () => {
  let query;
  const collected = await collectSelectionTargetFacts({ raw: async (sql, params) => {
    if (!sql.includes('KEY_COLUMN_USAGE')) return { rows: [] };
    query = { sql, params };
    return { rows: [fkMetadata({ privateSQL: 'private-sql' }), fkMetadata({ ordinal: '2', columnName: 'pb', referencedColumn: 'b' })] };
  } }, "db'quoted");
  assert.equal(collected.foreignKeyMetadataVersion, 2);
  assert.deepEqual(query.params, ["db'quoted", "db'quoted"]); assert.equal(query.sql.includes("db'quoted"), false);
  assert.match(query.sql, /LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS/);
  for (const predicate of ['BINARY r.CONSTRAINT_SCHEMA = BINARY k.CONSTRAINT_SCHEMA', 'BINARY r.TABLE_NAME = BINARY k.TABLE_NAME', 'BINARY r.CONSTRAINT_NAME = BINARY k.CONSTRAINT_NAME', 'BINARY r.UNIQUE_CONSTRAINT_SCHEMA = BINARY k.REFERENCED_TABLE_SCHEMA', 'BINARY r.REFERENCED_TABLE_NAME = BINARY k.REFERENCED_TABLE_NAME']) assert.ok(query.sql.includes(predicate));
  assert.equal(collected.foreignKeys[1].ordinal, 2); assert.equal(collected.foreignKeys[0].onDelete, 'SET NULL');
  assert.equal(JSON.stringify(collected).includes('private-'), false);
  const first = report(facts({ foreignKeys: collected.foreignKeys }));
  assert.equal(first.targetForeignKeyReview.rows[0].pairs.length, 2);
  assert.equal(first.targetForeignKeyReview.rows[0].relation, 'inbound');
  assert.equal(first.findings.filter(item => item.code === 'TARGET_INBOUND_FK_FROM_UNSELECTED_TABLE').length, 1);
  const changed = report(facts({ foreignKeys: collected.foreignKeys.map(row => ({ ...row, onDelete: 'RESTRICT' })) }));
  assert.notEqual(first.snapshotId, changed.snapshotId);
  const legacy = facts(); delete legacy.foreignKeyMetadataVersion;
  assert.equal(report(legacy).metadataStatus.complete, false); assert.equal(report(legacy).targetForeignKeyReview.complete, false);
});

test('missing rule joins, malformed FK rows, metadata truncation and cancellation never produce a complete target FK review', async () => {
  for (const changes of [{ ordinal: 0 }, { ordinal: true }, { onDelete: 'private-rule' }, { matchOption: 'private-match' }]) {
    const result = await collectSelectionTargetFacts({ raw: async sql => ({ rows: sql.includes('KEY_COLUMN_USAGE') ? [fkMetadata(changes)] : [] }) }, 'target_db');
    assert.equal(result.foreignKeys.length, 0); assert.ok(result.errors.some(error => error.section === 'foreignKeys'));
    assert.equal(JSON.stringify(result).includes('private-'), false);
  }
  const noRules = await collectSelectionTargetFacts({ raw: async sql => ({ rows: sql.includes('KEY_COLUMN_USAGE') ? [fkMetadata({ onDelete: null, onUpdate: null, matchOption: null })] : [] }) }, 'target_db');
  const missing = report(facts({ foreignKeys: noRules.foreignKeys }));
  assert.equal(missing.targetForeignKeyReview.complete, false); assert.equal(missing.metadataStatus.complete, false);
  assert.equal(missing.targetForeignKeyReview.rows[0].onDelete, null);
  const cut = report(facts({ truncated: ['foreignKeys'] })); assert.equal(cut.targetForeignKeyReview.complete, false);
  let canceled = false;
  await assert.rejects(() => collectSelectionTargetFacts({ raw: async sql => {
    if (sql.includes('KEY_COLUMN_USAGE')) canceled = true; return { rows: [] };
  } }, 'target_db', () => { if (canceled) throw new Error('canceled-fk-read'); }), /canceled-fk-read/);
});
