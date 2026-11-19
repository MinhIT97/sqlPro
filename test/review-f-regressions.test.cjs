'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const SchemaDiff = require('../schema-diff.js');
const { SchemaMigrationService } = require('../electron/schema-migration-service.cjs');
const { computeSchemaFingerprint } = require('../electron/schema-snapshot.cjs');
const { DataSyncExecutor } = require('../electron/data-sync-executor.cjs');
const { loadRenderer } = require('./helpers/renderer.cjs');

const table = (overrides = {}) => ({ name: 't', engine: 'InnoDB', columns: [{ name: 'id', type: 'int', nullable: 'NO', default: null }], indexes: [], foreignKeys: [], foreignKeysStatus: 'complete', checkConstraintsStatus: 'complete', checkConstraints: [], ...overrides });
function snapshot(database, tables = [table()], engine = 'MySQL') {
  const data = { database, engine, tables, views: [], routines: [], triggers: [], events: [] };
  return { ...data, kind: 'sqlpro-schema-snapshot', version: 1, coverage: 'complete', snapshotIdentity: computeSchemaFingerprint(data),
    scope: { profileId: 'p', sessionId: 's', generation: 0, database, engine, profileFingerprint: 'a'.repeat(64), lowerCaseTableNames: 0 } };
}
function preview(source, target) {
  const service = new SchemaMigrationService();
  const request = { sourceSnapshotId: service.storeSnapshot(source), targetSnapshotId: service.storeSnapshot(target) };
  return { plan: service.createMigrationPlan(request), candidate: service.createCandidatePlan(request) };
}
function rendererFixture({ source = snapshot('source'), target = snapshot('target', []), capture } = {}) {
  const elements = new Map(), calls = [], service = new SchemaMigrationService();
  for (const id of ['modal', 'diffTabContent', 'diffSourceProfile', 'diffTargetProfile', 'diffSourceDb', 'diffTargetDb', 'diffSwapBtn', 'diffAllowDropTables', 'diffAllowDropColumns', 'diffIgnoreComments', 'diffIgnoreCollation', 'diffRunCompareBtn', 'diffGoMigrationBtn', 'diffGoTablesBtn', 'diffCopySqlBtn', 'diffDownloadSqlBtn', 'diffOpenEditorBtn', 'diffApplyTargetBtn']) {
    elements.set('#' + id, { innerHTML: '', open: false, listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; }, showModal() { this.open = true; }, close() { this.open = false; } });
  }
  const ok = data => ({ ok: true, data }), forbidden = async () => { throw new Error('Legacy renderer metadata path must not run'); };
  const r = loadRenderer({ elements, desktop: { db: {
    databases: async () => ok(['source', 'target']),
    tables: forbidden, columns: forbidden, indexes: forbidden, relations: forbidden, routines: forbidden,
    schemaSnapshot: async payload => {
      calls.push(['snapshot', payload]);
      if (capture) return capture(payload);
      const s = payload.database === 'source' ? source : target;
      return ok({ snapshotId: service.storeSnapshot(s), coverage: s.coverage });
    },
    createMigrationPlan: async payload => { calls.push(['plan', payload]); return ok(service.createMigrationPlan(payload)); }
  } } });
  r.context.window.SchemaDiff = SchemaDiff;
  r.evaluate("app.connection={id:'p'};app.connections=[app.connection];app.database='source'");
  return { ...r, calls, click: id => elements.get('#' + id).listeners.click(), async start() {
    await r.evaluate('showSchemaDiffModal()'); await new Promise(resolve => setImmediate(resolve));
  } };
}

test('F01/F02: Schema Diff UI captures Main snapshots and exports the Main plan, preserving nonunique indexes', async () => {
  const source = snapshot('source', [table({ indexes: [{ name: 'idx_id', isUnique: false, type: 'BTREE', columns: [{ name: 'id' }] }] })]);
  const r = rendererFixture({ source }); await r.start(); await r.click('diffRunCompareBtn');
  assert.deepEqual(r.calls.map(c => c[0]), ['snapshot', 'snapshot', 'plan']);
  await r.click('diffGoMigrationBtn');
  const html = r.elements.get('#diffTabContent').innerHTML;
  assert.ok(html.includes('KEY `idx_id`')); assert.equal(html.includes('UNIQUE KEY'), false);
  assert.equal(html.includes('FOREIGN_KEY_CHECKS'), false); assert.equal(html.includes('SQL_MODE'), false);
});

test('F01: failed snapshot prevents plan and stale dialog results cannot touch a replacement', async () => {
  const failed = rendererFixture({ capture: async () => ({ ok: false, error: { code: 'SCHEMA_COVERAGE_INCOMPLETE', message: 'Metadata unavailable' } }) });
  await failed.start(); await failed.click('diffRunCompareBtn');
  assert.equal(failed.calls.filter(c => c[0] === 'plan').length, 0);
  assert.ok(failed.elements.get('#diffTabContent').innerHTML.includes('Metadata unavailable'));
  let resolve;
  const stale = rendererFixture({ capture: () => new Promise(done => { resolve = done; }) });
  await stale.start(); const pending = stale.click('diffRunCompareBtn');
  stale.evaluate("closeModal();modal('replacement')");
  resolve({ ok: true, data: { snapshotId: 'old', coverage: 'complete' } }); await pending;
  assert.equal(stale.calls.length, 1); assert.equal(stale.elements.get('#modal').innerHTML, 'replacement');
});

test('F01/F02/F06: partial coverage, CHECK and MariaDB defaults block both preview and candidate without SQL', () => {
  for (const variant of ['partial', 'check', 'maria']) {
    const source = snapshot('source'), target = snapshot('target', []);
    if (variant === 'partial') source.coverage = 'partial';
    if (variant === 'check') source.tables[0].checkConstraints = [{ name: 'positive' }];
    if (variant === 'maria') {
      source.engine = source.scope.engine = target.engine = target.scope.engine = 'MariaDB';
      source.tables[0].columns = [{ name: 'v', type: 'varchar(30)', nullable: 'YES', default: "'pending'" }];
    }
    const { plan, candidate } = preview(source, target);
    assert.equal(plan.status, 'blocked'); assert.equal(plan.blockReason, candidate.blockReason);
    assert.deepEqual(plan.statements, []); assert.equal(plan.sqlScript, ''); assert.equal(plan.exportSupported, false);
  }
});

test('F03: formatter preserves settings by default, rejects override and keeps header names on one comment line', () => {
  const statements = [{ sql: 'SELECT 1;', enabled: true }];
  const sql = SchemaDiff.formatMigrationScript(statements, { sourceName: 's\nDROP DATABASE unsafe;', targetName: 't\r\nSET x=1;' });
  assert.equal(/^SET /m.test(sql), false); assert.equal(/^DROP DATABASE/m.test(sql), false); assert.ok(sql.includes('SELECT 1;'));
  assert.throws(() => SchemaDiff.formatMigrationScript(statements, { wrapForeignKeys: true }), /FOREIGN_KEY_CHECKS_OVERRIDE_UNSUPPORTED/);
});

function syncFixture() {
  const columns = [{ name: 'id', type: 'int', key: 'PRI' }], calls = [];
  const state = { profile: { id: 'p', environment: 'local', readOnly: false }, generation: 0 };
  const plan = { targetScope: { profileId: 'p', database: 'd', table: 't' }, primaryKeys: ['id'], columns,
    operations: [{ type: 'INSERT', values: { id: 1 } }, { type: 'INSERT', values: { id: 2 } }] };
  const worker = { connect: async () => {}, useDatabase: async () => {}, close: async () => {}, listColumns: async () => columns,
    raw: async sql => { calls.push(sql); return { result: sql === 'SHOW GRANTS' ? [{ grants: "GRANT SELECT, TRIGGER ON *.* TO 'fixture'@'%'" }] : sql.includes('SELECT ENGINE') ? [{ ENGINE: 'InnoDB' }] : sql.includes('SELECT TRIGGER_NAME') || sql.includes('REFERENTIAL_CONSTRAINTS') ? [] : { affectedRows: 1 } }; } };
  const executor = new DataSyncExecutor({ consumePlan: () => plan, getProfileWithSecrets: () => state.profile, getGeneration: () => state.generation, createSession: () => worker });
  return { state, worker, plan, calls, run: args => executor.executeSyncPlan({ planToken: 'internal', ...args }) };
}

test('F04: inbound FK metadata missing or present blocks before any DML', async () => {
  for (const variant of ['cascade', 'unknown', 'denied']) {
    const f = syncFixture(), raw = f.worker.raw;
    f.worker.raw = async (...args) => {
      if (args[0].includes('REFERENTIAL_CONSTRAINTS')) {
        if (variant === 'denied') throw Object.assign(new Error('denied'), { code: 'ER_TABLEACCESS_DENIED_ERROR' });
        return { result: variant === 'unknown' ? {} : [{ tableName: 'outside', deleteRule: 'CASCADE' }] };
      }
      return raw(...args);
    };
    await assert.rejects(f.run(), { code: variant === 'cascade' ? 'SYNC_FOREIGN_KEY_DEPENDENCY_UNSUPPORTED' : 'SYNC_METADATA_UNVERIFIED' });
    assert.equal(f.calls.some(sql => sql.startsWith('INSERT')), false); assert.ok(f.calls.includes('ROLLBACK'));
  }
});

test('F04: a dependency observed after DML rolls back instead of committing cascades', async () => {
  const f = syncFixture(), raw = f.worker.raw; let reads = 0;
  f.worker.raw = async (...args) => args[0].includes('REFERENTIAL_CONSTRAINTS')
    ? { result: ++reads === 1 ? [] : [{ tableName: 'child' }] } : raw(...args);
  await assert.rejects(f.run(), { code: 'SYNC_FOREIGN_KEY_DEPENDENCY_UNSUPPORTED' });
  assert.ok(f.calls.some(sql => sql.startsWith('INSERT')));
  assert.equal(f.calls.includes('COMMIT'), false); assert.ok(f.calls.includes('ROLLBACK'));
});

test('F05: policy, credentials and generation drift between batches never write the next batch', async () => {
  for (const variant of ['readonly', 'production', 'credentials', 'logout', 'deleted']) {
    const f = syncFixture();
    await assert.rejects(f.run({ batchSize: 1, onProgress: () => {
      if (variant === 'readonly') f.state.profile = { ...f.state.profile, readOnly: true };
      if (variant === 'production') f.state.profile = { ...f.state.profile, environment: 'production' };
      if (variant === 'credentials') f.state.profile = { ...f.state.profile, password: 'changed' };
      if (variant === 'logout') f.state.generation++;
      if (variant === 'deleted') f.state.profile = null;
    } }), err => {
      assert.ok(['CONNECTION_READ_ONLY', 'SYNC_CONTEXT_CHANGED', 'TARGET_PROFILE_NOT_FOUND'].includes(err.code));
      assert.equal(err.committedCount, 1); assert.equal(err.partialCommit, true); return true;
    });
    assert.equal(f.calls.filter(sql => sql.startsWith('INSERT')).length, 1);
  }
});

test('F05: policy drift during DML rolls back the pending batch before COMMIT', async () => {
  const f = syncFixture(), raw = f.worker.raw;
  f.worker.raw = async (...args) => {
    const result = await raw(...args);
    if (args[0].startsWith('INSERT')) f.state.profile = { ...f.state.profile, readOnly: true };
    return result;
  };
  await assert.rejects(f.run(), { code: 'CONNECTION_READ_ONLY' });
  assert.equal(f.calls.includes('COMMIT'), false); assert.ok(f.calls.includes('ROLLBACK'));
});

test('F05: Production receipts require matching digest, fingerprint and live bounded expiry', async () => {
  for (const variant of ['valid', 'legacy', 'digest', 'target', 'expired', 'too-long']) {
    const f = syncFixture(); f.state.profile.environment = 'production';
    f.plan.planToken = 'prod-token'; f.plan.planDigest = 'prod-digest'; f.plan.expiresAt = Date.now() + 60000;
    const executor = new DataSyncExecutor({ consumePlan: () => f.plan, getProfileWithSecrets: () => f.state.profile,
      createSession: () => f.worker, fingerprintProfile: () => 'prod-fingerprint', authorizeProduction: async () => {
        const receipt = { planToken: f.plan.planToken, planDigest: f.plan.planDigest, targetProfileFingerprint: 'prod-fingerprint', expiresAt: f.plan.expiresAt };
        if (variant === 'legacy') { delete receipt.targetProfileFingerprint; delete receipt.expiresAt; }
        if (variant === 'digest') receipt.planDigest = 'other';
        if (variant === 'target') receipt.targetProfileFingerprint = 'other';
        if (variant === 'expired') receipt.expiresAt = Date.now() - 1;
        if (variant === 'too-long') receipt.expiresAt++;
        return receipt;
      } });
    const pending = executor.executeSyncPlan({ planToken: 'prod-token' });
    if (variant === 'valid') assert.equal((await pending).success, true);
    else { await assert.rejects(pending, { code: 'PRODUCTION_APPROVAL_REQUIRED' }); assert.equal(f.calls.length, 0); }
  }
});
