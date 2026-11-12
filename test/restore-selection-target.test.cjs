'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { collectSelectionTargetFacts, buildSelectionTargetPreview } = require('../electron/restore-selection-target.cjs');
const { previewRestoreSelection } = require('../electron/restore-selection.cjs');

function source(tables = ['parent'], flags = {}) {
  return previewRestoreSelection({ version: 1, database: 'source_db', findings: [], truncated: false, opaqueObjects: [],
    tables: ['parent', 'child'].map(name => ({ name, createStatements: 1, dataStatements: 1, dropStatements: 1, dependencies: [] })) }, { tables, ...flags });
}
function facts(overrides = {}) {
  return { database: 'target_db', checkedAt: '2026-11-12T00:00:00Z', version: '8.4', lowerCaseTableNames: 0, databaseVisible: true,
    objects: [{ name: 'parent', type: 'table' }], triggers: [{ name: 'after_parent', table: 'parent', event: 'INSERT' }],
    foreignKeys: [{ name: 'fk_outside', tableSchema: 'another_db', table: 'child', column: 'parent_id', referencedSchema: 'target_db', referencedTable: 'parent', referencedColumn: 'id' }], errors: [], truncated: [], ...overrides };
}
const report = (metadata = facts(), selected = source(), checksum = 'a'.repeat(64), targetIdentity = 'b'.repeat(64)) => buildSelectionTargetPreview({ source: selected, checksum, targetIdentity, facts: metadata });

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
  assert.equal(result.databaseVisible, true); assert.deepEqual(result.objects, [{ name: '__proto__', type: 'table' }]);
  assert.equal(queries.length, 6); assert.deepEqual(queries.find(query => query.sql.includes('KEY_COLUMN_USAGE')).params, [database, database]);
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
  assert.equal(JSON.stringify(result).includes('password'), false); assert.equal(result.errors.length, 4);
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
    if (!sql.includes('information_schema.COLUMNS')) return { rows: [] };
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
  assert.equal(query.sql.includes('GENERATION_EXPRESSION'), false);
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
    if (sql.includes('information_schema.COLUMNS')) return { rows: [{ tableName: 'parent', name: 'updated_at', ordinal: 1, columnType: 'datetime',
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
