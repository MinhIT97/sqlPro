'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSession } = require('../electron/database.cjs');
const { SchemaSnapshotCollector, projectSnapshotForRenderer } = require('../electron/schema-snapshot.cjs');

// Use the production DatabaseSession normalizers; only the driver response is faked.
function fixture(capabilities = ['EXPRESSION', 'IS_VISIBLE']) {
  const session = new DatabaseSession({ id: 'fixture-profile', type: 'mysql' });
  session.version = '8.4.0';
  const queries = [];
  const state = {
    expression: 'lower(`email`)', visibility: 'YES',
    trigger: null
  };
  session.raw = async (sql, params, timeoutMs) => {
    queries.push({ sql, params, timeoutMs });
    if (sql.includes("COLUMN_NAME IN ('EXPRESSION'")) {
      return { result: capabilities.map(name => ({ name })) };
    }
    if (sql.includes('information_schema.TABLES')) return { result: [{ name: 'users', type: 'BASE TABLE', engine: 'InnoDB' }] };
    if (sql.includes('information_schema.COLUMNS')) return { result: [{ name: 'email', type: 'varchar(255)', nullable: 'YES', position: 1 }] };
    if (sql.includes('information_schema.STATISTICS')) {
      if (sql.includes(' AS expression')) {
        assert.match(sql, capabilities.includes('EXPRESSION') ? /EXPRESSION AS expression/ : /NULL AS expression/);
      }
      return { result: [{ name: 'idx_email', nonUnique: 1, sequence: 1, columnName: state.expression ? null : 'email',
        expression: state.expression, visibilityValue: state.visibility, type: 'BTREE', collation: 'A' }] };
    }
    if (sql.includes('information_schema.TRIGGERS')) {
      assert.match(sql, /DEFINER AS definer/);
      assert.match(sql, /SQL_MODE AS sqlMode/);
      assert.match(sql, /ACTION_ORDER AS actionOrder/);
      return { result: state.trigger ? [state.trigger] : [] };
    }
    return { result: [] };
  };
  const collector = new SchemaSnapshotCollector(session, { sessionId: 'fixture-session' });
  return { session, collector, queries, state };
}

test('functional expression and visibility drift survive DatabaseSession and change the snapshot hash', async () => {
  const { collector, state, queries } = fixture();
  const first = await collector.collect('sample');
  const index = first.tables[0].indexes[0];
  assert.equal(first.coverage, 'complete');
  assert.equal(index.columns[0].expression, 'lower(`email`)');
  assert.equal(index.visibilityKind, 'mysql-visible');
  assert.equal(index.visibility, 'YES');
  assert.equal(index.migrationStatus, 'blocked');
  assert.equal(index.migrationBlockReason, 'UNSUPPORTED_FUNCTIONAL_INDEX');
  state.expression = 'upper(`email`)';
  const changedExpression = await collector.collect('sample');
  assert.notEqual(first.snapshotIdentity, changedExpression.snapshotIdentity);
  state.visibility = 'NO';
  const changedVisibility = await collector.collect('sample');
  assert.notEqual(changedExpression.snapshotIdentity, changedVisibility.snapshotIdentity);
  const projection = projectSnapshotForRenderer(changedVisibility);
  assert.equal(projection.tables[0].blockedIndexCount, 1);
  assert.ok(!JSON.stringify(projection).includes('upper(`email`)'));
  assert.ok(queries.every(query => query.sql.trim().startsWith('SELECT')));
});

test('MariaDB ignored indexes are detected without querying MySQL-only metadata columns', async () => {
  const { collector, state, queries } = fixture(['IGNORED']);
  state.expression = null;
  state.visibility = 'NO';
  const first = await collector.collect('sample');
  assert.equal(first.tables[0].indexes[0].visibilityKind, 'mariadb-ignored');
  assert.equal(first.tables[0].indexes[0].migrationStatus, 'supported');
  state.visibility = 'YES';
  const second = await collector.collect('sample');
  assert.notEqual(first.snapshotIdentity, second.snapshotIdentity);
  assert.equal(second.tables[0].indexes[0].migrationBlockReason, 'UNSUPPORTED_INDEX_VISIBILITY');
  assert.ok(queries.some(query => /IGNORED AS visibilityValue/.test(query.sql)));
  assert.ok(!queries.some(query => /IS_VISIBLE AS visibilityValue/.test(query.sql)));
});

test('missing functional expression or invalid visibility is unknown, and capability errors do not fall back', async () => {
  const { collector, state, session } = fixture();
  state.visibility = null;
  const missingVisibility = await collector.collect('sample');
  assert.equal(missingVisibility.coverage, 'partial');
  assert.equal(missingVisibility.tables[0].indexes[0].status, 'unknown');
  assert.equal(missingVisibility.tables[0].indexes[0].migrationBlockReason, 'METADATA_INCOMPLETE');
  const originalRaw = session.raw;
  session.raw = async (...args) => {
    if (args[0].includes("COLUMN_NAME IN ('EXPRESSION'")) throw Object.assign(new Error('denied'), { code: 'ER_TABLEACCESS_DENIED_ERROR' });
    return originalRaw(...args);
  };
  const denied = await collector.collect('sample');
  assert.equal(denied.coverage, 'partial');
  assert.ok(denied.warnings.some(warning => warning.code === 'TABLE_METADATA_PARTIAL'));

  const incomplete = fixture();
  const raw = incomplete.session.raw;
  incomplete.session.raw = async (...args) => {
    const response = await raw(...args);
    if (args[0].includes('information_schema.STATISTICS')) response.result[0].expression = null;
    return response;
  };
  const missingExpression = await incomplete.collector.collect('sample');
  assert.equal(missingExpression.coverage, 'partial');
  assert.equal(missingExpression.tables[0].indexes[0].status, 'unknown');
});

test('legacy metadata capability and basic index cache stay separate from snapshot metadata', async () => {
  const { session, state, queries, collector } = fixture([]);
  state.expression = null;
  await session.listIndexes('sample', 'users');
  assert.equal(queries.length, 1);
  const detailed = await session.listIndexes('sample', 'users', { includeDefinition: true });
  assert.equal(queries.length, 3, 'A basic cache entry must not bypass capability and definition reads');
  assert.equal(detailed[0].definitionStatus, 'complete');
  const snapshot = await collector.collect('sample');
  assert.equal(snapshot.coverage, 'complete');
  assert.equal(snapshot.tables[0].indexes[0].visibilityKind, 'unsupported');
  assert.equal(snapshot.tables[0].indexes[0].visibility, 'unsupported');
});

function trigger() {
  return { name: 'tr_users', table: 'users', timing: 'BEFORE', event: 'INSERT', statement: 'SET NEW.email = LOWER(NEW.email)',
    definer: 'admin@localhost', sqlMode: '', actionOrder: 1, characterSetClient: 'utf8mb4',
    collationConnection: 'utf8mb4_bin', databaseCollation: 'utf8mb4_bin' };
}

test('trigger rights, SQL context and execution order each participate in the fingerprint', async () => {
  const { collector, state } = fixture();
  state.expression = null;
  state.trigger = trigger();
  let previous = await collector.collect('sample');
  assert.equal(previous.coverage, 'complete');
  assert.equal(previous.triggers[0].sqlMode, '');
  assert.equal(previous.triggers[0].migrationStatus, 'blocked');
  assert.equal(previous.triggers[0].migrationBlockReason, 'TRIGGER_CONTEXT_REVIEW_REQUIRED');
  for (const [field, value] of Object.entries({ definer: 'other@localhost', sqlMode: 'ANSI_QUOTES', actionOrder: 2,
    characterSetClient: 'latin1', collationConnection: 'latin1_bin', databaseCollation: 'utf8mb4_0900_ai_ci' })) {
    state.trigger[field] = value;
    const next = await collector.collect('sample');
    assert.equal(next.coverage, 'complete');
    assert.notEqual(previous.snapshotIdentity, next.snapshotIdentity, `${field} must affect fingerprint`);
    previous = next;
  }
  const projection = projectSnapshotForRenderer(previous);
  assert.equal(projection.triggers[0].migrationStatus, 'blocked');
  assert.ok(!JSON.stringify(projection).includes('other@localhost'));
  assert.ok(!JSON.stringify(projection).includes('ANSI_QUOTES'));
});

test('missing trigger context and exceeded expression/context byte budget cannot be reported complete', async () => {
  const { collector, state } = fixture();
  state.expression = null;
  for (const field of ['definer', 'sqlMode', 'actionOrder', 'characterSetClient', 'collationConnection', 'databaseCollation']) {
    state.trigger = trigger();
    delete state.trigger[field];
    const missing = await collector.collect('sample');
    assert.equal(missing.coverage, 'partial', field);
    assert.equal(missing.triggers[0].status, 'unknown', field);
    assert.equal(missing.triggers[0].migrationStatus, 'blocked');
  }
  state.trigger = trigger();
  const cappedContext = await collector.collect('sample', { quotas: { maxDdlBytes: 40 } });
  assert.equal(cappedContext.triggers[0].reason, 'BYTE_QUOTA_EXCEEDED');
  state.trigger = null;
  state.expression = 'x'.repeat(100);
  const cappedExpression = await collector.collect('sample', { quotas: { maxDdlBytes: 10 } });
  assert.equal(cappedExpression.coverage, 'partial');
  assert.equal(cappedExpression.tables[0].indexes[0].columns[0].expression, null);
});
