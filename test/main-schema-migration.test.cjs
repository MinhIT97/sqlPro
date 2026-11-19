'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { DatabaseSession } = require('../electron/database.cjs');

// Execute main.cjs itself, with the real registry/collector/service and a fake SQL driver.
function fixture() {
  const handlers = new Map(), profiles = {}, queries = [], sessions = [];
  const root = path.join(__dirname, '../electron');
  const controls = { onRaw: null };
  class Session extends DatabaseSession {
    constructor(profile) { super(profile); this.version = '8.4.0'; sessions.push(this); }
    async connect() { this.connection = {}; }
    async close() { this.connection = null; this.dead = true; }
    async raw(sql, params, timeoutMs) {
      queries.push({ sql, params, timeoutMs, profileId: this.profile.id });
      if (controls.onRaw) {
        const intercept = await controls.onRaw(sql, this, params);
        if (intercept !== undefined) return intercept;
      }
      if (sql.includes("COLUMN_NAME IN ('EXPRESSION'")) return { result: [] };
      if (sql.includes('foreign_key_checks')) return { result: [{ fkChecks: 1, foreignKeys: 1, sqlMode: '', autocommit: 1 }] };
      if (sql.includes('information_schema.TABLES')) {
        const allTables = (controls.tablesByProfile && controls.tablesByProfile[this.profile.id]) || controls.tables || [{ name: 'users', type: 'BASE TABLE', engine: 'InnoDB' }];
        if (sql.includes('TABLE_NAME = ?') && params && params.length >= 2) {
          const tableName = params[1];
          const matched = allTables.filter(t => t.name === tableName);
          return { result: matched };
        }
        return { result: allTables };
      }
      if (sql.includes('LOWER(COLUMN_TYPE)')) return { result: [{ name: 'id', type: 'int', nullable: 'NO', defaultValue: null, extra: '', collation: null }] };
      if (sql.includes('information_schema.COLUMNS')) return { result: [{ name: 'id', type: 'int', nullable: 'NO', position: 1 }] };
      return { result: [] };
    }
  }
  const context = vm.createContext({
    require(id) {
      if (id === 'electron') return {
        app: { requestSingleInstanceLock: () => true, on() {}, whenReady: () => new Promise(() => {}), getPath: () => '/tmp/sqlpro-main-schema-tests' },
        ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
        dialog: {
          showMessageBox: (...args) => (controls.showMessageBox ? controls.showMessageBox(...args) : Promise.reject(Error('Unexpected production approval')))
        }
      };
      if (id === './database.cjs') return { ...require(path.join(root, id)), DatabaseSession: Session };
      if (id === './store.cjs') return { getWithSecrets: id => ({ id, host: 'fixture', port: 3306, user: 'fixture', ssh: {}, ...profiles[id] }) };
      if (id === './sync.cjs' || id === './navicat.cjs') return {};
      return require(id.startsWith('./') ? path.join(root, id) : id);
    }, __dirname: root, process, Buffer, console, setTimeout, clearTimeout, AbortController
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'main.cjs'), 'utf8'), context, { filename: 'main.cjs' });
  return { profiles, queries, sessions, controls,
    evaluate: code => vm.runInContext(code, context),
    call: (channel, payload) => handlers.get(channel)({ sender: null }, payload)
  };
}

test('snapshot IPC uses trusted registry context, blocks overlap, ignores renderer quotas and releases its lease', async () => {
  const r = fixture();
  r.profiles.p = { readOnly: true };
  let unblock, entered;
  const started = new Promise(resolve => { entered = resolve; });
  r.controls.onRaw = async sql => {
    if (!unblock && sql.includes('information_schema.TABLES')) {
      entered();
      await new Promise(resolve => { unblock = resolve; });
    }
  };
  const pending = r.call('db:schema-snapshot', { profileId: 'p', database: 'sample',
    options: { quotas: { maxObjects: 0, timeoutMs: Infinity } } });
  await started;
  assert.equal((await r.call('db:columns', { profileId: 'p', database: 'sample', table: 'users' })).error.code, 'SESSION_BUSY');
  assert.equal((await r.call('db:schema-snapshot', { profileId: 'p', database: 'sample' })).error.code, 'SESSION_BUSY');
  unblock();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.data.coverage, 'complete');
  assert.equal(result.data.tables.length, 1, 'Renderer maxObjects:0 must not override Main limits');
  assert.match(result.data.snapshotId, /^snapshot_/);
  assert.ok(result.data.scope.sessionId);
  assert.equal(result.data.scope.generation, 0);
  assert.match(result.data.scope.profileFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(r.evaluate('sessionRegistry.leases.size'), 0);
  assert.equal(r.evaluate("openSessions.get('p').exclusiveOperation"), false);
  assert.ok(r.queries.every(query => query.sql.startsWith('SELECT')));
});

test('snapshot IPC rejects profile or logout drift during collection and always releases the lease', async () => {
  for (const variant of ['profile', 'logout', 'session', 'policy']) {
    const r = fixture();
    let changed = false;
    r.controls.onRaw = () => {
      if (changed) return;
      changed = true;
      if (variant === 'profile') r.profiles.p = { host: 'changed-host' };
      if (variant === 'policy') r.profiles.p = { readOnly: true };
      if (variant === 'logout') r.evaluate('stopBackupSchedules()');
      if (variant === 'session') r.evaluate("openSessions.get('p').sessionId = 'replaced'");
    };
    const result = await r.call('db:schema-snapshot', { profileId: 'p', database: 'sample' });
    assert.equal(result.ok, false, variant);
    assert.ok(['SESSION_CONTEXT_CHANGED', 'PROFILE_TARGET_CHANGED'].includes(result.error.code), variant);
    assert.equal(r.evaluate('sessionRegistry.leases.size'), 0);
    assert.equal(r.evaluate('schemaMigrationService.snapshots.size'), 0);
  }
});

test('plan IPC preserves equal hashes on different servers and rejects stale cached capture scope', async () => {
  const r = fixture();
  const a = await r.call('db:schema-snapshot', { profileId: 'a', database: 'sample' });
  const b = await r.call('db:schema-snapshot', { profileId: 'b', database: 'sample' });
  assert.equal(a.data.snapshotIdentity, b.data.snapshotIdentity);
  assert.notEqual(a.data.snapshotId, b.data.snapshotId);
  const payload = { sourceSnapshotId: a.data.snapshotId, targetSnapshotId: b.data.snapshotId };
  const plan = await r.call('db:create-migration-plan', payload);
  assert.equal(plan.ok, true);
  assert.equal(plan.data.sourceScope.profileId, 'a');
  assert.equal(plan.data.targetScope.profileId, 'b');
  assert.equal(plan.data.applySupported, false);
  r.profiles.a = { environment: 'production' };
  assert.equal((await r.call('db:create-migration-plan', payload)).error.code, 'SESSION_CONTEXT_CHANGED');
});

test('Apply IPC cannot bypass policy with confirmed, token or environment flags, and opens no sessions', async () => {
  const r = fixture();
  for (const payload of [undefined, { confirmed: true }, { planToken: 'forged', confirmed: true, readOnly: false, environment: 'local' }]) {
    const result = await r.call('db:apply-migration-plan', payload);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'MIGRATION_APPLY_NOT_READY');
  }
  assert.equal(r.sessions.length, 0);
  assert.equal(r.queries.length, 0);
});

test('snapshot IPC validates database, protects Editor transactions and invalidates caches on reset', async () => {
  const r = fixture();
  for (const database of ['', ' ', 'x'.repeat(65), 'bad\0db']) {
    assert.equal((await r.call('db:schema-snapshot', { profileId: 'p', database })).ok, false);
  }
  assert.equal(r.sessions.length, 0);
  await r.evaluate("ensureSession('p')");
  r.sessions[0].inTransaction = true;
  assert.equal((await r.call('db:schema-snapshot', { profileId: 'p', database: 'sample' })).error.code, 'SESSION_BUSY');
  r.sessions[0].inTransaction = false;
  const response = await r.call('db:schema-snapshot', { profileId: 'p', database: 'sample' });
  assert.equal(response.ok, true);
  r.evaluate('stopBackupSchedules()');
  assert.equal(r.evaluate('schemaMigrationService.snapshots.size'), 0);
  assert.equal(r.evaluate('schemaMigrationAdmission.admittedPlans.size'), 0);
  assert.equal(r.evaluate('schemaMigrationApproval.pending.size'), 0);
  assert.equal(r.evaluate('schemaMigrationJobManager.jobs.size'), 0);
  assert.equal(r.evaluate('schemaMigrationJobManager.activeJobsByTarget.size'), 0);
  assert.equal(r.evaluate('schemaMigrationOrchestrator.runningPromises.size'), 0);
});

test('read-only migration job status and cancel IPCs enforce schema and reject invalid payloads', async () => {
  const r = fixture();
  for (const bad of [null, undefined, '', {}, { jobId: 123 }, { jobId: 'job_invalid' }]) {
    const statusRes = await r.call('db:migration-job-status', bad);
    assert.equal(statusRes.ok, false);
    const cancelRes = await r.call('db:migration-job-cancel', bad);
    assert.equal(cancelRes.ok, false);
  }

  const validUnknownId = `job_${crypto.randomBytes(16).toString('hex')}`;
  const statusOk = await r.call('db:migration-job-status', { jobId: validUnknownId });
  assert.equal(statusOk.ok, true);
  assert.equal(statusOk.data, null);

  const cancelOk = await r.call('db:migration-job-cancel', { jobId: validUnknownId });
  assert.equal(cancelOk.ok, true);
  assert.equal(cancelOk.data.canceled, false);
});

test('full main integration proves only worker executes DDL, Editor session never receives COMMIT/ROLLBACK/SET, and fresh metadata reads detect drift', async () => {
  const r = fixture();
  r.profiles.src = { readOnly: true, environment: 'local' };
  r.profiles.tgt = { readOnly: false, environment: 'local' };

  // 1. Capture snapshots via named IPC
  const snapSrc = await r.call('db:schema-snapshot', { profileId: 'src', database: 'src_db' });
  const snapTgt = await r.call('db:schema-snapshot', { profileId: 'tgt', database: 'tgt_db' });
  assert.equal(snapSrc.ok, true);
  assert.equal(snapTgt.ok, true);

  // 2. Create preview plan via named IPC: preview remains disabled
  const planRes = await r.call('db:create-migration-plan', {
    sourceSnapshotId: snapSrc.data.snapshotId,
    targetSnapshotId: snapTgt.data.snapshotId
  });
  assert.equal(planRes.ok, true);
  assert.equal(planRes.data.applySupported, false);

  // Apply IPC continues to reject preview or forged apply
  const applyRes = await r.call('db:apply-migration-plan', { planId: planRes.data.planId });
  assert.equal(applyRes.ok, false);
  assert.equal(applyRes.error.code, 'MIGRATION_APPLY_NOT_READY');

  // 3. Construct ready candidate inside fixture
  const candidate = {
    planId: `plan_${crypto.randomBytes(16).toString('hex')}`,
    planToken: crypto.randomBytes(32).toString('hex'),
    status: 'ready',
    applySupported: true,
    expiresAt: Date.now() + 60000,
    sourceSnapshotId: snapSrc.data.snapshotId,
    targetSnapshotId: snapTgt.data.snapshotId,
    sourceScope: { ...snapSrc.data.scope, snapshotIdentity: snapSrc.data.snapshotIdentity, database: 'src_db', engine: 'MySQL' },
    targetScope: { ...snapTgt.data.scope, snapshotIdentity: snapTgt.data.snapshotIdentity, database: 'tgt_db', engine: 'MySQL' },
    options: { statementTimeoutMs: 15000, wrapForeignKeys: false },
    statements: [
      { id: 'stmt_1', sql: 'CREATE TABLE orders (id INT PRIMARY KEY);', status: 'executable', enabled: true }
    ]
  };

  const initialEditorQueryCount = r.queries.length;

  // Admit candidate into orchestrator
  const admitted = r.evaluate('schemaMigrationOrchestrator').admitPlan(candidate);
  assert.equal(admitted.status, 'ready');

  const result = await r.evaluate('schemaMigrationOrchestrator').executeMigrationJob({
    planToken: admitted.planToken
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.executedCount, 1);
  assert.equal(result.totalCount, 1);

  // Editor session assertions:
  // Session 0 (src) and Session 1 (tgt) are editor sessions created during db:schema-snapshot
  const editorSessions = [r.sessions[0], r.sessions[1]];
  for (const es of editorSessions) {
    assert.equal(es.inTransaction, false);
    assert.equal(es.autocommit, true);
  }

  // All queries executed after snapshot capture must NOT contain COMMIT, ROLLBACK, or SET on editor sessions
  const migrationQueries = r.queries.slice(initialEditorQueryCount);
  const ddlQuery = migrationQueries.find(q => q.sql.includes('CREATE TABLE orders'));
  assert.ok(ddlQuery, 'DDL query must be executed');
  assert.equal(ddlQuery.profileId, 'tgt');

  // Assert editor sessions never received COMMIT, ROLLBACK, or SET
  const editorQueries = migrationQueries.filter(q => q.profileId === 'src' && editorSessions[0].connection || q.profileId === 'tgt' && editorSessions[1].connection);
  assert.ok(!editorQueries.some(q => /^(COMMIT|ROLLBACK|SET)/i.test(q.sql)));

  // Leases cleaned up
  assert.equal(r.evaluate('sessionRegistry.leases.size'), 0);

  // 4. Test source schema drift: change source metadata tables
  r.controls.tables = [
    { name: 'users', type: 'BASE TABLE', engine: 'InnoDB' },
    { name: 'new_drift_table', type: 'BASE TABLE', engine: 'InnoDB' }
  ];

  const candDrift = {
    ...candidate,
    planId: `plan_${crypto.randomBytes(16).toString('hex')}`,
    planToken: crypto.randomBytes(32).toString('hex'),
    expiresAt: Date.now() + 60000
  };

  const admittedDrift = r.evaluate('schemaMigrationOrchestrator').admitPlan(candDrift);
  await assert.rejects(
    r.evaluate('schemaMigrationOrchestrator').executeMigrationJob({ planToken: admittedDrift.planToken }),
    { code: 'SOURCE_SCHEMA_DRIFT' }
  );

  // Leases cleaned up after drift rejection
  assert.equal(r.evaluate('sessionRegistry.leases.size'), 0);
});

test('main lifecycle cancel during worker execution cleans up leases and keeps Editor session functional', async () => {
  const r = fixture();
  r.profiles.src = { readOnly: true, environment: 'local' };
  r.profiles.tgt = { readOnly: false, environment: 'local' };

  const snapSrc = await r.call('db:schema-snapshot', { profileId: 'src', database: 'src_db' });
  const snapTgt = await r.call('db:schema-snapshot', { profileId: 'tgt', database: 'tgt_db' });

  let unblock;
  let entered = false;
  let activeJobId = null;

  r.controls.onRaw = async (sql) => {
    if (sql.includes('CREATE TABLE long_running') && !entered) {
      entered = true;
      activeJobId = [...r.evaluate('schemaMigrationJobManager.jobs.keys()')][0];
      // Trigger cancel via IPC while DDL is awaiting
      await r.call('db:migration-job-cancel', { jobId: activeJobId, reason: 'Canceled via IPC' });
    }
  };

  const candidate = {
    planId: `plan_${crypto.randomBytes(16).toString('hex')}`,
    planToken: crypto.randomBytes(32).toString('hex'),
    status: 'ready',
    applySupported: true,
    expiresAt: Date.now() + 60000,
    sourceSnapshotId: snapSrc.data.snapshotId,
    targetSnapshotId: snapTgt.data.snapshotId,
    sourceScope: { ...snapSrc.data.scope, snapshotIdentity: snapSrc.data.snapshotIdentity, database: 'src_db', engine: 'MySQL' },
    targetScope: { ...snapTgt.data.scope, snapshotIdentity: snapTgt.data.snapshotIdentity, database: 'tgt_db', engine: 'MySQL' },
    options: { statementTimeoutMs: 15000, wrapForeignKeys: false },
    statements: [
      { id: 'stmt_1', sql: 'CREATE TABLE long_running (id INT PRIMARY KEY);', status: 'executable', enabled: true }
    ]
  };

  const admitted = r.evaluate('schemaMigrationOrchestrator').admitPlan(candidate);

  await assert.rejects(
    r.evaluate('schemaMigrationOrchestrator').executeMigrationJob({ planToken: admitted.planToken }),
    { code: 'QUERY_CANCELED' }
  );

  // Leases must be completely freed
  assert.equal(r.evaluate('sessionRegistry.leases.size'), 0);

  // Editor session remains functional
  const editorSnap = await r.call('db:schema-snapshot', { profileId: 'tgt', database: 'tgt_db' });
  assert.equal(editorSnap.ok, true);
});

test('complete collector -> generator -> admission -> orchestrator -> worker flow with preCondition and postCondition', async () => {
  const r = fixture();
  r.profiles.src = { readOnly: true, environment: 'local' };
  r.profiles.tgt = { readOnly: false, environment: 'local' };
  r.controls.tablesByProfile = {
    src: [
      { name: 'users', type: 'BASE TABLE', engine: 'InnoDB' },
      { name: 'orders', type: 'BASE TABLE', engine: 'InnoDB' }
    ],
    tgt: [
      { name: 'users', type: 'BASE TABLE', engine: 'InnoDB' }
    ]
  };

  const snapSrc = await r.call('db:schema-snapshot', { profileId: 'src', database: 'src_db' });
  const snapTgt = await r.call('db:schema-snapshot', { profileId: 'tgt', database: 'tgt_db' });
  assert.equal(snapSrc.ok, true);
  assert.equal(snapTgt.ok, true);

  // Generate candidate plan via generator on Main
  const candidate = r.evaluate('schemaMigrationService').createCandidatePlan({
    sourceSnapshotId: snapSrc.data.snapshotId,
    targetSnapshotId: snapTgt.data.snapshotId
  });

  assert.equal(candidate.status, 'ready');
  assert.equal(candidate.applySupported, true);
  assert.equal(candidate.statements.length, 1);
  assert.equal(candidate.statements[0].type, 'CREATE_TABLE');
  assert.equal(candidate.statements[0].table, 'orders');
  assert.ok(candidate.statements[0].preCondition);
  assert.equal(candidate.statements[0].preCondition.type, 'TABLE_NOT_EXISTS');
  assert.ok(candidate.statements[0].postCondition);
  assert.equal(candidate.statements[0].postCondition.type, 'TABLE_EXISTS');

  // When DDL executes on target worker, simulate table creation so postCondition succeeds
  r.controls.onRaw = async (sql) => {
    if (sql.includes('CREATE TABLE `orders`')) {
      r.controls.tablesByProfile.tgt.push({ name: 'orders', type: 'BASE TABLE', engine: 'InnoDB' });
    }
  };

  // Admit plan into orchestrator
  const admitted = r.evaluate('schemaMigrationOrchestrator').admitPlan(candidate);
  assert.equal(admitted.status, 'ready');

  // Execute migration job
  const result = await r.evaluate('schemaMigrationOrchestrator').executeMigrationJob({
    planToken: admitted.planToken
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.executedCount, 1);
  assert.equal(result.totalCount, 1);
  assert.equal(result.partialCommit, false);

  // PreCondition and PostCondition queries were executed
  const preCheck = r.queries.find(q => q.sql.includes('TABLE_NAME = ?') && q.params?.includes('orders') && q.params?.includes('tgt_db'));
  assert.ok(preCheck, 'PreCondition check query must be executed');

  const ddlQuery = r.queries.find(q => q.sql.includes('CREATE TABLE `orders`'));
  assert.ok(ddlQuery, 'DDL must be executed');

  // Leases released
  assert.equal(r.evaluate('sessionRegistry.leases.size'), 0);
});

test('preCondition failure halts execution immediately with zero DDL queries executed', async () => {
  const r = fixture();
  r.profiles.src = { readOnly: true, environment: 'local' };
  r.profiles.tgt = { readOnly: false, environment: 'local' };
  r.controls.tablesByProfile = {
    src: [
      { name: 'users', type: 'BASE TABLE', engine: 'InnoDB' },
      { name: 'orders', type: 'BASE TABLE', engine: 'InnoDB' }
    ],
    tgt: [
      { name: 'users', type: 'BASE TABLE', engine: 'InnoDB' }
    ]
  };

  const snapSrc = await r.call('db:schema-snapshot', { profileId: 'src', database: 'src_db' });
  const snapTgt = await r.call('db:schema-snapshot', { profileId: 'tgt', database: 'tgt_db' });

  const candidate = r.evaluate('schemaMigrationService').createCandidatePlan({
    sourceSnapshotId: snapSrc.data.snapshotId,
    targetSnapshotId: snapTgt.data.snapshotId
  });

  const admitted = r.evaluate('schemaMigrationOrchestrator').admitPlan(candidate);

  // Simulate that the table already exists at target when preCondition checks
  r.controls.onRaw = async (sql, session, params) => {
    if (session.profile.id === 'tgt' && sql.includes('information_schema.TABLES') && sql.includes('TABLE_NAME = ?') && params?.includes('orders')) {
      return { result: [{ TABLE_NAME: 'orders' }] }; // Return 1 row instead of 0
    }
  };

  await assert.rejects(
    r.evaluate('schemaMigrationOrchestrator').executeMigrationJob({ planToken: admitted.planToken }),
    { code: 'MIGRATION_PRECONDITION_FAILED' }
  );

  // Assert ZERO DDL queries were executed
  assert.ok(!r.queries.some(q => q.sql.includes('CREATE TABLE `orders`')), 'DDL must not run when preCondition fails');
  assert.equal(r.evaluate('sessionRegistry.leases.size'), 0);
});

test('postCondition failure detects unverified schema state and reports failure with partialCommit', async () => {
  const r = fixture();
  r.profiles.src = { readOnly: true, environment: 'local' };
  r.profiles.tgt = { readOnly: false, environment: 'local' };
  r.controls.tablesByProfile = {
    src: [
      { name: 'users', type: 'BASE TABLE', engine: 'InnoDB' },
      { name: 'orders', type: 'BASE TABLE', engine: 'InnoDB' }
    ],
    tgt: [
      { name: 'users', type: 'BASE TABLE', engine: 'InnoDB' }
    ]
  };

  const snapSrc = await r.call('db:schema-snapshot', { profileId: 'src', database: 'src_db' });
  const snapTgt = await r.call('db:schema-snapshot', { profileId: 'tgt', database: 'tgt_db' });

  const candidate = r.evaluate('schemaMigrationService').createCandidatePlan({
    sourceSnapshotId: snapSrc.data.snapshotId,
    targetSnapshotId: snapTgt.data.snapshotId
  });

  const admitted = r.evaluate('schemaMigrationOrchestrator').admitPlan(candidate);

  // Do NOT add 'orders' to target tables, so postCondition check (expecting 1) returns 0 rows
  await assert.rejects(
    r.evaluate('schemaMigrationOrchestrator').executeMigrationJob({ planToken: admitted.planToken }),
    (err) => {
      assert.equal(err.code, 'MIGRATION_POSTCONDITION_FAILED');
      assert.equal(err.job.executedCount, 1);
      assert.equal(err.job.partialCommit, true);
      return true;
    }
  );

  assert.equal(r.evaluate('sessionRegistry.leases.size'), 0);
});

test('target schema drift between plan admission and execution halts migration before DDL', async () => {
  const r = fixture();
  r.profiles.src = { readOnly: true, environment: 'local' };
  r.profiles.tgt = { readOnly: false, environment: 'local' };
  r.controls.tablesByProfile = {
    src: [
      { name: 'users', type: 'BASE TABLE', engine: 'InnoDB' },
      { name: 'orders', type: 'BASE TABLE', engine: 'InnoDB' }
    ],
    tgt: [
      { name: 'users', type: 'BASE TABLE', engine: 'InnoDB' }
    ]
  };

  const snapSrc = await r.call('db:schema-snapshot', { profileId: 'src', database: 'src_db' });
  const snapTgt = await r.call('db:schema-snapshot', { profileId: 'tgt', database: 'tgt_db' });

  const candidate = r.evaluate('schemaMigrationService').createCandidatePlan({
    sourceSnapshotId: snapSrc.data.snapshotId,
    targetSnapshotId: snapTgt.data.snapshotId
  });

  const admitted = r.evaluate('schemaMigrationOrchestrator').admitPlan(candidate);

  // Target schema drifts out-of-band before execution starts
  r.controls.tablesByProfile.tgt.push({ name: 'external_drift_table', type: 'BASE TABLE', engine: 'InnoDB' });

  await assert.rejects(
    r.evaluate('schemaMigrationOrchestrator').executeMigrationJob({ planToken: admitted.planToken }),
    { code: 'TARGET_SCHEMA_DRIFT' }
  );

  assert.ok(!r.queries.some(q => q.sql.includes('CREATE TABLE `orders`')), 'Zero DDL must run on target schema drift');
  assert.equal(r.evaluate('sessionRegistry.leases.size'), 0);
});

test('in-flight unexpected driver error marks executionUncertain: true without false success', async () => {
  const r = fixture();
  r.profiles.src = { readOnly: true, environment: 'local' };
  r.profiles.tgt = { readOnly: false, environment: 'local' };
  r.controls.tablesByProfile = {
    src: [
      { name: 'users', type: 'BASE TABLE', engine: 'InnoDB' },
      { name: 'orders', type: 'BASE TABLE', engine: 'InnoDB' }
    ],
    tgt: [
      { name: 'users', type: 'BASE TABLE', engine: 'InnoDB' }
    ]
  };

  const snapSrc = await r.call('db:schema-snapshot', { profileId: 'src', database: 'src_db' });
  const snapTgt = await r.call('db:schema-snapshot', { profileId: 'tgt', database: 'tgt_db' });

  const candidate = r.evaluate('schemaMigrationService').createCandidatePlan({
    sourceSnapshotId: snapSrc.data.snapshotId,
    targetSnapshotId: snapTgt.data.snapshotId
  });

  const admitted = r.evaluate('schemaMigrationOrchestrator').admitPlan(candidate);

  // Simulate network drop / unknown driver crash when DDL executes
  r.controls.onRaw = async (sql) => {
    if (sql.includes('CREATE TABLE `orders`')) {
      const crash = new Error('Connection lost to target database server');
      crash.code = 'PROTOCOL_CONNECTION_LOST';
      throw crash;
    }
  };

  await assert.rejects(
    r.evaluate('schemaMigrationOrchestrator').executeMigrationJob({ planToken: admitted.planToken }),
    (err) => {
      assert.equal(err.job.executionUncertain, true);
      assert.equal(err.job.partialCommit, true);
      assert.equal(err.job.status, 'uncertain');
      return true;
    }
  );

  assert.equal(r.evaluate('sessionRegistry.leases.size'), 0);
});

test('production approval dialog matrix: requires approval, dialog cancel, dialog confirm, context drift, single-use token', async () => {
  const r = fixture();
  r.profiles.src = { readOnly: true, environment: 'local' };
  r.profiles.tgt = { readOnly: false, environment: 'production' };
  r.controls.tablesByProfile = {
    src: [
      { name: 'users', type: 'BASE TABLE', engine: 'InnoDB' },
      { name: 'orders', type: 'BASE TABLE', engine: 'InnoDB' }
    ],
    tgt: [
      { name: 'users', type: 'BASE TABLE', engine: 'InnoDB' }
    ]
  };

  const snapSrc = await r.call('db:schema-snapshot', { profileId: 'src', database: 'src_db' });
  const snapTgt = await r.call('db:schema-snapshot', { profileId: 'tgt', database: 'tgt_db' });

  const candidate1 = r.evaluate('schemaMigrationService').createCandidatePlan({
    sourceSnapshotId: snapSrc.data.snapshotId,
    targetSnapshotId: snapTgt.data.snapshotId
  });
  const admitted1 = r.evaluate('schemaMigrationOrchestrator').admitPlan(candidate1);

  // 1. Without approval token, execution must be blocked on production target
  await assert.rejects(
    r.evaluate('schemaMigrationOrchestrator').executeMigrationJob({ planToken: admitted1.planToken }),
    { code: 'PRODUCTION_APPROVAL_REQUIRED' }
  );

  // Plan 2 for dialog cancel test
  const candidate2 = r.evaluate('schemaMigrationService').createCandidatePlan({
    sourceSnapshotId: snapSrc.data.snapshotId,
    targetSnapshotId: snapTgt.data.snapshotId
  });
  const admitted2 = r.evaluate('schemaMigrationOrchestrator').admitPlan(candidate2);

  // 2. Dialog cancel: user clicks Cancel (response: 0)
  r.controls.showMessageBox = async () => ({ response: 0 });
  await assert.rejects(
    r.evaluate('schemaMigrationOrchestrator').requestProductionApproval(admitted2.planToken),
    { code: 'MIGRATION_APPROVAL_CANCELED' }
  );

  // 3. Dialog confirm: user clicks Approve (response: 1)
  r.controls.showMessageBox = async () => ({ response: 1 });
  const approvalRes = await r.evaluate('schemaMigrationOrchestrator').requestProductionApproval(admitted2.planToken);
  assert.ok(approvalRes.approvalToken);
  assert.ok(approvalRes.expiresAt);

  // 4. Target profile drift invalidates approval
  r.profiles.tgt.host = 'drifted-production-host';
  await assert.rejects(
    r.evaluate('schemaMigrationOrchestrator').executeMigrationJob({
      planToken: admitted2.planToken,
      approvalToken: approvalRes.approvalToken
    }),
    { code: 'MIGRATION_CONTEXT_CHANGED' }
  );

  // Restore profile host
  delete r.profiles.tgt.host;

  // Re-approve after context was restored
  const freshApproval = await r.evaluate('schemaMigrationOrchestrator').requestProductionApproval(admitted2.planToken);

  // 5. Successful execution with valid approval token
  r.controls.onRaw = async (sql) => {
    if (sql.includes('CREATE TABLE `orders`')) {
      r.controls.tablesByProfile.tgt.push({ name: 'orders', type: 'BASE TABLE', engine: 'InnoDB' });
    }
  };

  const result = await r.evaluate('schemaMigrationOrchestrator').executeMigrationJob({
    planToken: admitted2.planToken,
    approvalToken: freshApproval.approvalToken
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.executedCount, 1);

  // 6. Token is single-use; reuse must be rejected
  await assert.rejects(
    r.evaluate('schemaMigrationOrchestrator').executeMigrationJob({
      planToken: admitted2.planToken,
      approvalToken: freshApproval.approvalToken
    }),
    { code: 'MIGRATION_TOKEN_USED' }
  );

  assert.equal(r.evaluate('sessionRegistry.leases.size'), 0);
});

test('N04: real Main diff job creates only a bound preview; forged payloads and stale/incomplete jobs fail closed', async () => {
  const r = fixture();
  r.profiles.src = { readOnly: true };
  r.profiles.tgt = { readOnly: false };
  r.controls.onRaw = (sql, worker) => {
    if (sql.includes('information_schema.COLUMNS')) return { result: [{ name: 'id', type: 'int', nullable: 'NO', keyType: 'PRI', position: 1 }] };
    if (sql.startsWith('SELECT `id` FROM')) return { rows: worker.profile.id === 'src' ? [[1]] : [] };
  };
  const service = r.evaluate('dataDiffService');
  const started = await r.call('db:start-data-diff', { sourceProfileId: 'src', targetProfileId: 'tgt', sourceDb: 'source', targetDb: 'target', sourceTable: 'users', targetTable: 'users' });
  const jobId = started.data.jobId;
  try {
    await service.jobs.get(jobId).promise;
    const evidence = service.getJob(jobId);
    assert.equal(evidence.status, 'completed');
    assert.equal(Object.isFrozen(evidence.sourceScope), true);
    const created = await r.call('db:create-data-sync-plan', { jobId });
    assert.equal(created.ok, true, JSON.stringify(created.error));
    assert.equal(created.data.counts.inserts, 1);
    assert.equal(created.data.targetScope.database, 'target');
    assert.equal(created.data.targetScope.profileFingerprint, undefined);
    assert.equal(created.data.applySupported, false);
    assert.equal((await r.call('db:apply-data-sync-plan', { planToken: created.data.planToken })).error.code, 'SYNC_APPLY_NOT_READY');
    await assert.rejects(r.evaluate('dataSyncExecutor').executeSyncPlan({ planToken: created.data.planToken }), { code: 'SYNC_APPLY_NOT_READY' });
    for (const fields of [{ diffReport: {} }, { targetScope: { database: 'forged' } }, { sql: 'DELETE FROM users' }]) {
      assert.equal((await r.call('db:create-data-sync-plan', { jobId, ...fields })).error.code, 'CALLER_FIELDS_REJECTED');
    }
    assert.equal((await r.call('db:create-data-sync-plan', { jobId: 'missing' })).error.code, 'DIFF_JOB_NOT_FOUND');
    r.profiles.tgt.readOnly = true;
    assert.equal((await r.call('db:create-data-sync-plan', { jobId })).error.code, 'DATA_DIFF_CONTEXT_CHANGED');
    r.profiles.tgt.readOnly = false;
    const job = service.jobs.get(jobId), originalReport = job.report;
    for (const status of ['running', 'cancelled', 'failed']) {
      job.status = status;
      assert.equal((await r.call('db:create-data-sync-plan', { jobId })).error.code, 'DIFF_JOB_NOT_FOUND');
    }
    job.status = 'completed';
    for (const coverage of [{ complete: false, consistent: true }, { complete: true, consistent: false }]) {
      job.report = { ...originalReport, coverage };
      assert.equal((await r.call('db:create-data-sync-plan', { jobId })).error.code, 'DIFF_REPORT_INCOMPLETE');
    }
    job.report = originalReport;
    job.completedAt = Date.now() - service.jobTtlMs - 1;
    assert.equal((await r.call('db:create-data-sync-plan', { jobId })).error.code, 'DIFF_JOB_NOT_FOUND');
    assert.equal(r.queries.some(q => /^(INSERT|UPDATE|DELETE)\b/.test(q.sql)), false);
  } finally { await service.clear(); }
});
