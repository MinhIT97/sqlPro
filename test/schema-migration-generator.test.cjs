'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SchemaMigrationGenerator,
  generateSafeMigrationPlan,
  inspectSnapshotMetadata,
  ALLOWLIST_STATEMENT_TYPES
} = require('../electron/schema-migration-generator.cjs');
const { SchemaMigrationAdmission } = require('../electron/schema-migration-admission.cjs');
const { computeSchemaFingerprint } = require('../electron/schema-snapshot.cjs');

function makeSnapshot(profileId, dbName = 'test_db', tables = []) {
  const data = {
    database: dbName,
    engine: 'MySQL',
    tables,
    views: [],
    routines: [],
    triggers: [],
    events: []
  };
  return {
    ...data,
    kind: 'sqlpro-schema-snapshot',
    version: 1,
    scope: {
      profileId,
      sessionId: `session_${profileId}`,
      generation: 0,
      profileFingerprint: 'a'.repeat(64),
      database: dbName,
      engine: 'MySQL',
      serverVersion: '8.0.35',
      snapshotIdentity: computeSchemaFingerprint(data)
    },
    snapshotIdentity: computeSchemaFingerprint(data),
    coverage: 'complete',
    warnings: []
  };
}

function makeTable(name, columns = [], indexes = [], foreignKeys = []) {
  return {
    name,
    engine: 'InnoDB',
    charset: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
    comment: '',
    columns: columns.length ? columns : [
      { name: 'id', type: 'int', nullable: false, isAutoIncrement: true, default: null }
    ],
    indexes: indexes.length ? indexes : [
      { name: 'PRIMARY', isPrimary: true, isUnique: true, columns: [{ name: 'id' }] }
    ],
    foreignKeys,
    foreignKeysStatus: 'complete',
    status: 'complete',
    coverageStatus: 'complete'
  };
}

test('ALLOWLIST_STATEMENT_TYPES includes exactly CREATE_TABLE, ADD_COLUMN, ADD_INDEX', () => {
  assert.deepEqual(ALLOWLIST_STATEMENT_TYPES, ['CREATE_TABLE', 'ADD_COLUMN', 'ADD_INDEX']);
});

test('CREATE_TABLE generates executable statement with valid preCondition and postCondition', () => {
  const newTable = makeTable('products', [
    { name: 'id', type: 'bigint', nullable: false, isAutoIncrement: true, default: null },
    { name: 'sku', type: 'varchar(64)', nullable: false, default: null },
    { name: 'price', type: 'decimal(10,2)', nullable: false, default: '0.00' }
  ], [
    { name: 'PRIMARY', isPrimary: true, isUnique: true, columns: [{ name: 'id' }] },
    { name: 'idx_sku', isPrimary: false, isUnique: true, columns: [{ name: 'sku' }] }
  ]);

  const source = makeSnapshot('src', 'app_db', [newTable]);
  const target = makeSnapshot('tgt', 'app_db', []);

  const plan = generateSafeMigrationPlan({ sourceSnapshot: source, targetSnapshot: target });
  assert.equal(plan.status, 'ready');
  assert.equal(plan.applySupported, true);
  assert.equal(plan.blockReason, null);
  assert.equal(plan.statements.length, 1);

  const stmt = plan.statements[0];
  assert.equal(stmt.type, 'CREATE_TABLE');
  assert.equal(stmt.table, 'products');
  assert.equal(stmt.status, 'executable');
  assert.equal(stmt.enabled, true);
  assert.ok(stmt.sql.includes('CREATE TABLE `products`'));

  // Pre-condition: table must NOT exist
  assert.deepEqual(stmt.preCondition, {
    type: 'TABLE_NOT_EXISTS',
    table: 'products',
    checkSql: 'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
    params: ['app_db', 'products'],
    expectedCount: 0
  });

  // Post-condition: table MUST exist
  assert.deepEqual(stmt.postCondition, {
    type: 'TABLE_EXISTS',
    table: 'products',
    checkSql: 'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
    params: ['app_db', 'products'],
    expectedCount: 1,
    expectedColumns: newTable.columns.map(column => ({ name: column.name, type: column.type, nullable: column.nullable ? 'YES' : 'NO', defaultValue: column.default, extra: column.isAutoIncrement ? 'auto_increment' : '', collation: null })),
    exactColumns: true
  });
});

test('ADD_COLUMN generates executable statement with pre/post-conditions', () => {
  const srcTable = makeTable('users', [
    { name: 'id', type: 'int', nullable: false, isAutoIncrement: true, default: null },
    { name: 'nickname', type: 'varchar(50)', nullable: true, default: null },
    { name: 'is_active', type: 'tinyint(1)', nullable: false, default: '1' }
  ]);
  const tgtTable = makeTable('users', [
    { name: 'id', type: 'int', nullable: false, isAutoIncrement: true, default: null }
  ]);

  const source = makeSnapshot('src', 'app_db', [srcTable]);
  const target = makeSnapshot('tgt', 'app_db', [tgtTable]);

  const plan = generateSafeMigrationPlan({ sourceSnapshot: source, targetSnapshot: target });
  assert.equal(plan.status, 'ready');
  assert.equal(plan.applySupported, true);
  assert.equal(plan.statements.length, 2);

  const col1 = plan.statements[0];
  assert.equal(col1.type, 'ADD_COLUMN');
  assert.equal(col1.column, 'nickname');
  assert.equal(col1.preCondition.type, 'COLUMN_NOT_EXISTS');
  assert.deepEqual(col1.preCondition.params, ['app_db', 'users', 'nickname']);
  assert.equal(col1.preCondition.expectedCount, 0);
  assert.equal(col1.postCondition.type, 'COLUMN_EXISTS');
  assert.deepEqual(col1.postCondition.params, ['app_db', 'users', 'nickname']);
  assert.equal(col1.postCondition.expectedCount, 1);

  const col2 = plan.statements[1];
  assert.equal(col2.type, 'ADD_COLUMN');
  assert.equal(col2.column, 'is_active');
  assert.equal(col2.preCondition.expectedCount, 0);
  assert.equal(col2.postCondition.expectedCount, 1);
});

test('ADD_INDEX generates executable statement with pre/post-conditions', () => {
  const srcTable = makeTable('orders', [
    { name: 'id', type: 'int', nullable: false, isAutoIncrement: true, default: null },
    { name: 'user_id', type: 'int', nullable: false, default: '0' }
  ], [
    { name: 'PRIMARY', isPrimary: true, isUnique: true, columns: [{ name: 'id' }] },
    { name: 'idx_user', isPrimary: false, isUnique: false, columns: [{ name: 'user_id' }] }
  ]);
  const tgtTable = makeTable('orders', [
    { name: 'id', type: 'int', nullable: false, isAutoIncrement: true, default: null },
    { name: 'user_id', type: 'int', nullable: false, default: '0' }
  ], [
    { name: 'PRIMARY', isPrimary: true, isUnique: true, columns: [{ name: 'id' }] }
  ]);

  const source = makeSnapshot('src', 'app_db', [srcTable]);
  const target = makeSnapshot('tgt', 'app_db', [tgtTable]);

  const plan = generateSafeMigrationPlan({ sourceSnapshot: source, targetSnapshot: target });
  assert.equal(plan.status, 'ready');
  assert.equal(plan.applySupported, true);
  assert.equal(plan.statements.length, 1);

  const idx = plan.statements[0];
  assert.equal(idx.type, 'ADD_INDEX');
  assert.equal(idx.index, 'idx_user');
  assert.ok(idx.sql.includes('ALTER TABLE `orders` ADD KEY `idx_user` (`user_id`);'));
  assert.equal(idx.preCondition.type, 'INDEX_NOT_EXISTS');
  assert.deepEqual(idx.preCondition.params, ['app_db', 'orders', 'idx_user']);
  assert.equal(idx.preCondition.expectedCount, 0);
  assert.equal(idx.postCondition.type, 'INDEX_EXISTS');
  assert.deepEqual(idx.postCondition.params, ['app_db', 'orders', 'idx_user']);
  assert.equal(idx.postCondition.expectedCount, 1);
});

test('generateCandidatePlan produces an admitted plan when fed into SchemaMigrationAdmission', () => {
  const generator = new SchemaMigrationGenerator();
  const newTable = makeTable('items', [
    { name: 'id', type: 'int', nullable: false, isAutoIncrement: true, default: null },
    { name: 'title', type: 'varchar(100)', nullable: true, default: null }
  ]);
  const source = makeSnapshot('src', 'app_db', [newTable]);
  const target = makeSnapshot('tgt', 'app_db', []);

  const candidate = generator.generateCandidatePlan({ sourceSnapshot: source, targetSnapshot: target });
  assert.equal(candidate.status, 'ready');
  assert.equal(candidate.applySupported, true);
  assert.ok(candidate.planToken);
  assert.ok(candidate.expiresAt > Date.now());

  const admission = new SchemaMigrationAdmission();
  const admitted = admission.admitCandidate(candidate);
  assert.equal(admitted.planId, candidate.planId);
  assert.equal(admitted.planToken, candidate.planToken);
  assert.equal(admitted.status, 'ready');
  assert.equal(admitted.applySupported, true);
  assert.equal(admitted.statements.length, 1);
  assert.ok(admitted.planDigest);
});

test('destructive DDL (DROP TABLE) is blocked', () => {
  const existingTable = makeTable('legacy_data');
  const source = makeSnapshot('src', 'app_db', []);
  const target = makeSnapshot('tgt', 'app_db', [existingTable]);

  const plan = generateSafeMigrationPlan({ sourceSnapshot: source, targetSnapshot: target });
  assert.equal(plan.status, 'blocked');
  assert.equal(plan.blockReason, 'DESTRUCTIVE_DDL_BLOCKED');
  assert.equal(plan.applySupported, false);
  assert.equal(plan.statements.length, 0);
});

test('destructive DDL (DROP COLUMN) is blocked', () => {
  const srcTable = makeTable('users', [
    { name: 'id', type: 'int', nullable: false, isAutoIncrement: true, default: null }
  ]);
  const tgtTable = makeTable('users', [
    { name: 'id', type: 'int', nullable: false, isAutoIncrement: true, default: null },
    { name: 'deprecated_col', type: 'varchar(100)', nullable: true, default: null }
  ]);
  const source = makeSnapshot('src', 'app_db', [srcTable]);
  const target = makeSnapshot('tgt', 'app_db', [tgtTable]);

  const plan = generateSafeMigrationPlan({ sourceSnapshot: source, targetSnapshot: target });
  assert.equal(plan.status, 'blocked');
  assert.equal(plan.blockReason, 'DESTRUCTIVE_DDL_BLOCKED');
  assert.equal(plan.applySupported, false);
});

test('TYPE_MUTATION_REVIEW_REQUIRED for modified columns', () => {
  const srcTable = makeTable('users', [
    { name: 'id', type: 'bigint', nullable: false, isAutoIncrement: true, default: null }
  ]);
  const tgtTable = makeTable('users', [
    { name: 'id', type: 'int', nullable: false, isAutoIncrement: true, default: null }
  ]);
  const source = makeSnapshot('src', 'app_db', [srcTable]);
  const target = makeSnapshot('tgt', 'app_db', [tgtTable]);

  const plan = generateSafeMigrationPlan({ sourceSnapshot: source, targetSnapshot: target });
  assert.equal(plan.status, 'blocked');
  assert.equal(plan.blockReason, 'TYPE_MUTATION_REVIEW_REQUIRED');
});

test('FOREIGN_KEY_DEPENDENCY_REVIEW_REQUIRED when table has foreign keys', () => {
  const srcTable = makeTable('child', [
    { name: 'id', type: 'int', nullable: false, isAutoIncrement: true, default: null },
    { name: 'parent_id', type: 'int', nullable: false, default: null }
  ], [
    { name: 'PRIMARY', isPrimary: true, isUnique: true, columns: [{ name: 'id' }] }
  ], [
    { name: 'fk_parent', columns: ['parent_id'], referencedTable: 'parent', referencedColumns: ['id'] }
  ]);
  const source = makeSnapshot('src', 'app_db', [srcTable]);
  const target = makeSnapshot('tgt', 'app_db', []);

  const plan = generateSafeMigrationPlan({ sourceSnapshot: source, targetSnapshot: target });
  assert.equal(plan.status, 'blocked');
  assert.equal(plan.blockReason, 'FOREIGN_KEY_DEPENDENCY_REVIEW_REQUIRED');
});

test('OBJECT_DEPENDENCY_REVIEW_REQUIRED when snapshot contains views/routines/triggers/events', () => {
  for (const kind of ['views', 'routines', 'triggers', 'events']) {
    const source = makeSnapshot('src', 'app_db', []);
    source[kind].push({ name: 'my_obj', definition: 'SELECT 1' });
    const target = makeSnapshot('tgt', 'app_db', []);

    const plan = generateSafeMigrationPlan({ sourceSnapshot: source, targetSnapshot: target });
    assert.equal(plan.status, 'blocked');
    assert.equal(plan.blockReason, 'OBJECT_DEPENDENCY_REVIEW_REQUIRED');
  }
});

test('COLUMN_EXPRESSION_UNSUPPORTED for virtual or generated columns', () => {
  const srcTable = makeTable('metrics', [
    { name: 'id', type: 'int', nullable: false, isAutoIncrement: true, default: null },
    { name: 'calc', type: 'int', isGenerated: true, generationExpression: 'id * 2' }
  ]);
  const source = makeSnapshot('src', 'app_db', [srcTable]);
  const target = makeSnapshot('tgt', 'app_db', []);

  const plan = generateSafeMigrationPlan({ sourceSnapshot: source, targetSnapshot: target });
  assert.equal(plan.status, 'blocked');
  assert.equal(plan.blockReason, 'COLUMN_EXPRESSION_UNSUPPORTED');
});

test('UNSAFE_COLUMN_ADD_REVIEW_REQUIRED when adding NOT NULL column without DEFAULT', () => {
  const srcTable = makeTable('customers', [
    { name: 'id', type: 'int', nullable: false, isAutoIncrement: true, default: null },
    { name: 'ssn', type: 'varchar(11)', nullable: false, default: null, isAutoIncrement: false }
  ]);
  const tgtTable = makeTable('customers', [
    { name: 'id', type: 'int', nullable: false, isAutoIncrement: true, default: null }
  ]);
  const source = makeSnapshot('src', 'app_db', [srcTable]);
  const target = makeSnapshot('tgt', 'app_db', [tgtTable]);

  const plan = generateSafeMigrationPlan({ sourceSnapshot: source, targetSnapshot: target });
  assert.equal(plan.status, 'blocked');
  assert.equal(plan.blockReason, 'UNSAFE_COLUMN_ADD_REVIEW_REQUIRED');
});

test('SAME_DATABASE and CROSS_ENGINE_MIGRATION_UNSUPPORTED guards', () => {
  const s1 = makeSnapshot('prof_a', 'same_db', []);
  const s2 = makeSnapshot('prof_a', 'same_db', []);
  assert.equal(generateSafeMigrationPlan({ sourceSnapshot: s1, targetSnapshot: s2 }).blockReason, 'SAME_DATABASE');

  const s3 = makeSnapshot('prof_a', 'db_mysql', []);
  const s4 = makeSnapshot('prof_b', 'db_maria', []);
  s4.engine = 'MariaDB';
  assert.equal(generateSafeMigrationPlan({ sourceSnapshot: s3, targetSnapshot: s4 }).blockReason, 'CROSS_ENGINE_MIGRATION_UNSUPPORTED');
});

test('MIGRATION_PLAN_QUOTA_EXCEEDED when exceeding statement limit', () => {
  const generator = new SchemaMigrationGenerator({ maxStatements: 2 });
  const tables = [
    makeTable('t1'),
    makeTable('t2'),
    makeTable('t3')
  ];
  const source = makeSnapshot('src', 'app_db', tables);
  const target = makeSnapshot('tgt', 'app_db', []);

  const plan = generator.generateMigrationPlan({ sourceSnapshot: source, targetSnapshot: target });
  assert.equal(plan.status, 'blocked');
  assert.equal(plan.blockReason, 'MIGRATION_PLAN_QUOTA_EXCEEDED');
  assert.equal(plan.statements.length, 0);
});
