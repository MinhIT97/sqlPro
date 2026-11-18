'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SchemaMigrationService } = require('../electron/schema-migration-service.cjs');
const { computeSchemaFingerprint } = require('../electron/schema-snapshot.cjs');

function snapshot(profileId, columns = [{ name: 'id', type: 'int', nullable: false }]) {
  const data = { database: 'sample', engine: 'MySQL', tables: [{ name: 'users', engine: 'InnoDB',
    columns, indexes: [], foreignKeys: [], foreignKeysStatus: 'complete' }], views: [], routines: [], triggers: [], events: [] };
  return { ...data, kind: 'sqlpro-schema-snapshot', version: 1,
    scope: { profileId, sessionId: `session-${profileId}`, generation: 0,
      profileFingerprint: 'a'.repeat(64), database: 'sample', engine: 'MySQL', serverVersion: '8.4.0' },
    snapshotIdentity: computeSchemaFingerprint(data), coverage: 'complete', warnings: [] };
}

function pair(options) {
  const service = new SchemaMigrationService(options);
  const source = snapshot('source', [{ name: 'id', type: 'int', nullable: false }, { name: 'email', type: 'varchar(255)', nullable: true }]);
  const target = snapshot('target');
  const request = { sourceSnapshotId: service.storeSnapshot(source), targetSnapshotId: service.storeSnapshot(target) };
  return { service, source, target, request };
}

test('identical schema hashes on different profiles or sessions retain separate immutable captures', () => {
  const service = new SchemaMigrationService();
  const source = snapshot('source');
  const target = snapshot('target');
  assert.equal(source.snapshotIdentity, target.snapshotIdentity);
  const a = service.storeSnapshot(source);
  const b = service.storeSnapshot(target);
  assert.notEqual(a, b);
  assert.equal(service.getSnapshot(a).scope.profileId, 'source');
  assert.equal(service.getSnapshot(b).scope.profileId, 'target');
  target.scope.sessionId = 'mutated-session';
  target.tables[0].columns[0].type = 'text';
  assert.equal(service.getSnapshot(b).scope.sessionId, 'session-target');
  assert.equal(service.getSnapshot(b).tables[0].columns[0].type, 'int');
  assert.throws(() => { service.getSnapshot(a).tables[0].columns[0].type = 'text'; }, TypeError);
  assert.throws(() => service.getSnapshot(source.snapshotIdentity), { code: 'SNAPSHOT_NOT_FOUND' });
});

test('complete simple schemas produce a detached SQL preview, never executable statements', () => {
  const { service, request } = pair();
  const plan = service.createMigrationPlan({ ...request, confirmed: true, statements: ['DROP DATABASE sample'] });
  assert.equal(plan.status, 'preview');
  assert.equal(plan.applySupported, false);
  assert.equal(plan.applyBlockReason, 'MIGRATION_APPLY_NOT_READY');
  assert.equal(plan.summary.executable, 0);
  assert.ok(plan.statements.some(statement => statement.sql.includes('ADD COLUMN `email`')));
  assert.ok(plan.statements.every(statement => !statement.enabled && statement.status === 'preview'));
  plan.statements[0].sql = 'DROP DATABASE sample';
  plan.summary.executable = 100;
  const again = service.projectPlanForRenderer(service.pendingPlans.get(plan.planToken));
  assert.ok(!again.statements[0].sql.includes('DROP DATABASE'));
  assert.equal(again.summary.executable, 0);
});

test('incomplete coverage blocks all SQL including non-DROP and replacement statements', () => {
  for (const coverage of ['unknown', 'partial', undefined]) {
    const { service, request, source } = pair();
    source.coverage = coverage;
    request.sourceSnapshotId = service.storeSnapshot(source);
    const plan = service.createMigrationPlan({ ...request, options: { allowDropTables: true, allowDropColumns: true } });
    assert.equal(plan.status, 'blocked');
    assert.equal(plan.blockReason, 'SCHEMA_COVERAGE_INCOMPLETE');
    assert.deepEqual(plan.statements, []);
  }
});

test('nested and unsupported metadata blocks CREATE TABLE before SchemaDiff drops guard fields', () => {
  for (const change of [
    table => { table.indexes = [{ name: 'idx.with.dot', migrationStatus: 'blocked', migrationBlockReason: 'UNSUPPORTED_FUNCTIONAL_INDEX', columns: [{ name: null, expression: 'lower(email)' }] }]; },
    table => { table.columns.push({ name: 'calc.col', type: 'int', isGenerated: true, generationExpression: 'id * 2' }); },
    table => { table.columns[0].status = 'unknown'; },
    table => { table.foreignKeysStatus = 'unknown'; },
    table => { table.foreignKeys = [{ name: 'fk', referencedTable: 'other' }]; }
  ]) {
    const { service, source, request } = pair();
    source.tables[0].name = 'new.table';
    change(source.tables[0]);
    request.sourceSnapshotId = service.storeSnapshot(source);
    const plan = service.createMigrationPlan(request);
    assert.equal(plan.status, 'blocked');
    assert.deepEqual(plan.statements, []);
  }
});

test('view/routine/trigger/event dependencies are blocked instead of silently losing DEFINER or statements', () => {
  for (const kind of ['views', 'routines', 'triggers', 'events']) {
    const { service, source, request } = pair();
    source[kind].push({ name: 'object', status: 'complete', definition: 'SELECT 1', migrationStatus: 'blocked' });
    request.sourceSnapshotId = service.storeSnapshot(source);
    const plan = service.createMigrationPlan(request);
    assert.equal(plan.blockReason, 'OBJECT_DEPENDENCY_REVIEW_REQUIRED');
    assert.deepEqual(plan.statements, []);
  }
});

test('same target, cross engine and FK override cannot become ready plans', () => {
  const { service, request, source, target } = pair();
  assert.equal(service.createMigrationPlan({ sourceSnapshotId: request.sourceSnapshotId, targetSnapshotId: request.sourceSnapshotId }).blockReason, 'SAME_DATABASE');
  assert.equal(service.createMigrationPlan({ ...request, options: { wrapForeignKeys: true } }).blockReason, 'FOREIGN_KEY_CHECKS_OVERRIDE_UNSUPPORTED');
  target.engine = target.scope.engine = 'MariaDB';
  const targetSnapshotId = service.storeSnapshot(target);
  assert.equal(service.createMigrationPlan({ ...request, targetSnapshotId }).blockReason, 'CROSS_ENGINE_MIGRATION_UNSUPPORTED');
  delete source.scope.sessionId;
  assert.throws(() => service.storeSnapshot(source), { code: 'INVALID_SNAPSHOT' });
});

test('snapshot TTL, eviction, pending blocked-plan quotas and clear apply to every path', () => {
  const service = new SchemaMigrationService({ maxSnapshots: 2, maxPendingPlans: 2 });
  const a = service.storeSnapshot(snapshot('a'));
  const b = service.storeSnapshot(snapshot('b'));
  const c = service.storeSnapshot(snapshot('c'));
  assert.throws(() => service.getSnapshot(a), { code: 'SNAPSHOT_NOT_FOUND' });
  service.snapshots.get(c).expiresAt = 0;
  assert.throws(() => service.getSnapshot(c), { code: 'SNAPSHOT_NOT_FOUND' });
  const d = service.storeSnapshot(snapshot('d'));
  for (let i = 0; i < 5; i++) service.createMigrationPlan({ sourceSnapshotId: b, targetSnapshotId: d, options: { wrapForeignKeys: true } });
  assert.equal(service.pendingPlans.size, 2);
  const token = service.pendingPlans.keys().next().value;
  service.pendingPlans.set(token, { ...service.pendingPlans.get(token), expiresAt: 0 });
  service.prune();
  assert.equal(service.pendingPlans.size, 1);
  service.clear();
  assert.equal(service.pendingPlans.size, 0);
  assert.equal(service.snapshots.size, 0);
});

test('statement and byte limits reject oversized previews and malformed options', () => {
  for (const limits of [{ maxStatements: 1 }, { maxPlanBytes: 1 }]) {
    const { service, source, request } = pair(limits);
    source.tables[0].columns.push({ name: 'phone', type: 'text', nullable: true });
    request.sourceSnapshotId = service.storeSnapshot(source);
    assert.equal(service.createMigrationPlan(request).blockReason, 'MIGRATION_PLAN_QUOTA_EXCEEDED');
  }
  const { service, request } = pair();
  assert.throws(() => service.createMigrationPlan({ ...request, options: null }), { code: 'INVALID_PLAN_OPTIONS' });
});

test('Apply rejects before any SQL, FK setting, USE or collector call regardless of forged approval or read-only flags', async () => {
  const { service, request } = pair();
  const plan = service.createMigrationPlan(request);
  for (const targetProfile of [{ readOnly: true }, { readOnly: false, environment: 'production' }, undefined]) {
    let calls = 0;
    await assert.rejects(service.applyPlan({ planToken: plan.planToken, confirmed: true,
      targetProfile, targetSession: { raw() { calls++; }, useDatabase() { calls++; } },
      collectorFactory() { calls++; } }), { code: 'MIGRATION_APPLY_NOT_READY' });
    assert.equal(calls, 0);
  }
});
