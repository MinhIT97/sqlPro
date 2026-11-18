'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SchemaMigrationGenerator } = require('../electron/schema-migration-generator.cjs');
const { SchemaMigrationAdmission, SchemaMigrationApproval } = require('../electron/schema-migration-admission.cjs');
const { SchemaMigrationExecutor } = require('../electron/schema-migration-executor.cjs');
const { SchemaMigrationJobManager } = require('../electron/schema-migration-jobs.cjs');
const { computeSchemaFingerprint } = require('../electron/schema-snapshot.cjs');

function makeTable(name, columns = [], indexes = []) {
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
    foreignKeys: [],
    foreignKeysStatus: 'complete',
    status: 'complete',
    coverageStatus: 'complete'
  };
}

function makeSnapshot(profileId, dbName = 'matrix_db', tables = []) {
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
      profileFingerprint: computeSchemaFingerprint({ id: profileId }),
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

function buildTestEnvironment({ targetEnv = 'local', onRaw = null, getSource = null, getTarget = null } = {}) {
  const profiles = {
    source: { id: 'source', host: 'src.matrix.local', environment: 'local', readOnly: true },
    target: { id: 'target', host: 'tgt.matrix.local', environment: targetEnv, readOnly: false }
  };

  const queriesExecuted = [];
  let closedWorkers = 0;

  class FakeMatrixWorker {
    constructor() {
      this.connected = false;
      this.currentDb = null;
      this.sessionId = null;
    }
    async connect() { this.connected = true; }
    async useDatabase(db) { this.currentDb = db; }
    async close() { closedWorkers++; }
    async raw(sql, params = []) {
      queriesExecuted.push({ sql, params });
      if (onRaw) {
        const custom = await onRaw(sql, params);
        if (custom !== undefined) return custom;
      }
      if (sql.includes('SELECT @@SESSION.foreign_key_checks')) {
        return { result: [{ fkChecks: 1, autocommit: 1 }] };
      }
      return { result: [], rows: [] };
    }
  }

  const admission = new SchemaMigrationAdmission();
  const approval = new SchemaMigrationApproval({
    showConfirmDialog: async () => ({ response: 1 })
  });
  const jobManager = new SchemaMigrationJobManager();

  let activeSource = null;
  let activeTarget = null;

  const executor = new SchemaMigrationExecutor({
    consumePlan: token => admission.consumePlan(token),
    getProfileWithSecrets: id => profiles[id],
    fingerprintProfile: p => computeSchemaFingerprint({ id: p.id }),
    checkContext: async () => true,
    verifySource: async scope => {
      const snap = getSource ? getSource(scope) : (activeSource || makeSnapshot(scope.profileId, scope.database, [
        makeTable('users', [
          { name: 'id', type: 'int', nullable: false, isAutoIncrement: true, default: null },
          { name: 'email', type: 'varchar(255)', nullable: true, default: null }
        ])
      ]));
      return { ...snap, scope: { ...scope, snapshotIdentity: snap.snapshotIdentity } };
    },
    authorizeProduction: async ({ plan, planDigest, approvalToken }) => {
      return approval.authorizeProduction({ plan, planDigest, approvalToken });
    },
    createSession: () => new FakeMatrixWorker(),
    createCollector: (session, ctx) => ({
      collect: async db => {
        const snap = getTarget ? getTarget(ctx) : (activeTarget || makeSnapshot(ctx.profileId, db, [makeTable('users')]));
        return { ...snap, scope: { ...ctx, snapshotIdentity: snap.snapshotIdentity } };
      }
    })
  });

  return {
    profiles,
    admission,
    approval,
    jobManager,
    executor,
    queriesExecuted,
    setActiveSnapshots: (src, tgt) => { activeSource = src; activeTarget = tgt; },
    getClosedWorkers: () => closedWorkers
  };
}

test('Engine Matrix: executes CREATE_TABLE, ADD_COLUMN, ADD_INDEX with pre/post-conditions passing', async () => {
  const env = buildTestEnvironment({
    onRaw: async (sql, params) => {
      // Pre-condition: TABLE_NOT_EXISTS or COLUMN_NOT_EXISTS or INDEX_NOT_EXISTS
      if (sql.includes('information_schema.TABLES') && sql.includes('TABLE_NAME = ?')) {
        return { rows: [] }; // 0 rows -> does not exist
      }
      if (sql.includes('information_schema.COLUMNS') && sql.includes('COLUMN_NAME = ?')) {
        return { rows: [] }; // 0 rows -> does not exist
      }
      if (sql.includes('information_schema.STATISTICS') && sql.includes('INDEX_NAME = ?')) {
        return { rows: [] }; // 0 rows -> does not exist
      }
      return { result: [], rows: [] };
    }
  });

  const generator = new SchemaMigrationGenerator();
  const srcTable = makeTable('users', [
    { name: 'id', type: 'int', nullable: false, isAutoIncrement: true, default: null },
    { name: 'email', type: 'varchar(255)', nullable: true, default: null }
  ]);
  const tgtTable = makeTable('users');
  const src = makeSnapshot('source', 'matrix_db', [srcTable]);
  const tgt = makeSnapshot('target', 'matrix_db', [tgtTable]);

  const candidate = generator.generateCandidatePlan({ sourceSnapshot: src, targetSnapshot: tgt });
  assert.equal(candidate.status, 'ready');
  assert.equal(candidate.statements.length, 1);
  assert.equal(candidate.statements[0].type, 'ADD_COLUMN');

  // Adjust onRaw post-condition to return 1 row for existence check
  let ddlRan = false;
  env.executor.createSession = () => ({
    async connect() {},
    async useDatabase() {},
    async close() {},
    async raw(sql, params) {
      if (sql.includes('SELECT @@SESSION.foreign_key_checks')) {
        return { result: [{ fkChecks: 1, autocommit: 1 }] };
      }
      if (sql.includes('information_schema.COLUMNS')) {
        // Return 0 rows before DDL, 1 row after DDL
        return { rows: ddlRan ? [{ COLUMN_NAME: 'email' }] : [] };
      }
      if (sql.includes('ALTER TABLE `users` ADD COLUMN')) {
        ddlRan = true;
        return { result: { affectedRows: 0 } };
      }
      return { result: [], rows: [] };
    }
  });

  const admitted = env.admission.admitCandidate(candidate);
  const result = await env.executor.executePlan({ planToken: admitted.planToken });

  assert.equal(result.success, true);
  assert.equal(result.executedCount, 1);
  assert.equal(result.totalCount, 1);
  assert.equal(result.partialCommit, false);
  assert.equal(result.ledger[0].status, 'executed');
  assert.ok(ddlRan);
});

test('Engine Matrix: pre-condition failure stops BEFORE DDL is executed', async () => {
  let ddlAttempted = false;
  const env = buildTestEnvironment({
    onRaw: async (sql, params) => {
      // Simulate that the column already exists in the target DB (schema drift)
      if (sql.includes('information_schema.COLUMNS')) {
        return { rows: [{ COLUMN_NAME: 'email' }] }; // 1 row -> pre-condition expects 0!
      }
      if (sql.includes('ALTER TABLE `users` ADD COLUMN')) {
        ddlAttempted = true;
        return { result: {} };
      }
      return undefined;
    }
  });

  const generator = new SchemaMigrationGenerator();
  const srcTable = makeTable('users', [
    { name: 'id', type: 'int', nullable: false, isAutoIncrement: true, default: null },
    { name: 'email', type: 'varchar(255)', nullable: true, default: null }
  ]);
  const tgtTable = makeTable('users');
  const src = makeSnapshot('source', 'matrix_db', [srcTable]);
  const tgt = makeSnapshot('target', 'matrix_db', [tgtTable]);

  const candidate = generator.generateCandidatePlan({ sourceSnapshot: src, targetSnapshot: tgt });
  const admitted = env.admission.admitCandidate(candidate);

  await assert.rejects(
    env.executor.executePlan({ planToken: admitted.planToken }),
    err => {
      assert.equal(err.code, 'MIGRATION_PRECONDITION_FAILED');
      assert.equal(err.executedCount, 0);
      assert.equal(err.partialCommit, false);
      assert.equal(err.executionUncertain, false);
      assert.equal(err.ledger[0].status, 'failed');
      assert.equal(err.ledger[0].error, 'MIGRATION_PRECONDITION_FAILED');
      return true;
    }
  );

  // Assert DDL was NEVER called!
  assert.equal(ddlAttempted, false, 'DDL must not be attempted when pre-condition fails');
});

test('Engine Matrix: post-condition failure detects unverified schema state and reports partialCommit', async () => {
  let ddlRan = false;
  const env = buildTestEnvironment({
    onRaw: async (sql, params) => {
      if (sql.includes('information_schema.COLUMNS')) {
        // Pre-condition returns 0 rows (valid). But post-condition also returns 0 rows (invalid)!
        return { rows: [] };
      }
      if (sql.includes('ALTER TABLE `users` ADD COLUMN')) {
        ddlRan = true;
        return { result: { affectedRows: 0 } };
      }
      return undefined;
    }
  });

  const generator = new SchemaMigrationGenerator();
  const srcTable = makeTable('users', [
    { name: 'id', type: 'int', nullable: false, isAutoIncrement: true, default: null },
    { name: 'email', type: 'varchar(255)', nullable: true, default: null }
  ]);
  const tgtTable = makeTable('users');
  const src = makeSnapshot('source', 'matrix_db', [srcTable]);
  const tgt = makeSnapshot('target', 'matrix_db', [tgtTable]);

  const candidate = generator.generateCandidatePlan({ sourceSnapshot: src, targetSnapshot: tgt });
  const admitted = env.admission.admitCandidate(candidate);

  await assert.rejects(
    env.executor.executePlan({ planToken: admitted.planToken }),
    err => {
      assert.equal(err.code, 'MIGRATION_POSTCONDITION_FAILED');
      assert.equal(err.executedCount, 1); // DDL did execute!
      assert.equal(err.partialCommit, true); // MySQL implicit commit -> partialCommit is true
      assert.equal(err.executionUncertain, false);
      assert.equal(err.ledger[0].status, 'failed');
      assert.equal(err.ledger[0].error, 'MIGRATION_POSTCONDITION_FAILED');
      return true;
    }
  );

  assert.equal(ddlRan, true, 'DDL did run before post-condition check');
});

test('Engine Matrix: multi-statement partial commit tracking upon mid-sequence failure', async () => {
  const env = buildTestEnvironment();

  const srcTable = makeTable('users', [
    { name: 'id', type: 'int', nullable: false, isAutoIncrement: true, default: null },
    { name: 'email', type: 'varchar(255)', nullable: true, default: null },
    { name: 'phone', type: 'varchar(30)', nullable: true, default: null },
    { name: 'address', type: 'varchar(255)', nullable: true, default: null }
  ]);
  const tgtTable = makeTable('users');
  const src = makeSnapshot('source', 'matrix_db', [srcTable]);
  const tgt = makeSnapshot('target', 'matrix_db', [tgtTable]);
  env.setActiveSnapshots(src, tgt);

  const generator = new SchemaMigrationGenerator();
  const candidate = generator.generateCandidatePlan({ sourceSnapshot: src, targetSnapshot: tgt });

  let stmt1Ran = false;
  let stmt3Ran = false;

  env.executor.createSession = () => ({
    async connect() {},
    async useDatabase() {},
    async close() {},
    async raw(sql, params = []) {
      if (sql.includes('SELECT @@SESSION.foreign_key_checks')) {
        return { result: [{ fkChecks: 1, autocommit: 1 }] };
      }
      if (sql.includes('information_schema.COLUMNS')) {
        const colName = params?.[2];
        if (colName === 'email') {
          return { rows: stmt1Ran ? [{ COLUMN_NAME: 'email' }] : [] };
        }
        return { rows: [] };
      }
      if (sql.includes('`email`')) {
        stmt1Ran = true;
        return { result: {} };
      }
      if (sql.includes('`phone`')) {
        const ddlErr = new Error('Table users is locked or syntax error');
        ddlErr.code = 'ER_TABLEACCESS_DENIED_ERROR';
        throw ddlErr;
      }
      if (sql.includes('`address`')) {
        stmt3Ran = true;
        return { result: {} };
      }
      return { result: [], rows: [] };
    }
  });

  const admitted = env.admission.admitCandidate(candidate);

  await assert.rejects(
    env.executor.executePlan({ planToken: admitted.planToken }),
    err => {
      assert.equal(err.code, 'ER_TABLEACCESS_DENIED_ERROR');
      assert.equal(err.executedCount, 1);
      assert.equal(err.partialCommit, true);
      assert.equal(err.executionUncertain, false);
      assert.equal(err.ledger[0].status, 'executed');
      assert.equal(err.ledger[1].status, 'failed');
      assert.equal(err.ledger[2].status, 'not_run');
      return true;
    }
  );

  assert.equal(stmt1Ran, true);
  assert.equal(stmt3Ran, false);
});

test('Engine Matrix: timeout during execution sets executionUncertain and closes worker', async () => {
  const env = buildTestEnvironment();
  let workerClosed = false;

  const srcTable = makeTable('users', [
    { name: 'id', type: 'int', nullable: false, isAutoIncrement: true, default: null },
    { name: 'email', type: 'varchar(255)', nullable: true, default: null }
  ]);
  const tgtTable = makeTable('users');
  const src = makeSnapshot('source', 'matrix_db', [srcTable]);
  const tgt = makeSnapshot('target', 'matrix_db', [tgtTable]);
  env.setActiveSnapshots(src, tgt);

  const generator = new SchemaMigrationGenerator();
  const candidate = generator.generateCandidatePlan({ sourceSnapshot: src, targetSnapshot: tgt });

  env.executor.createSession = () => ({
    async connect() {},
    async useDatabase() {},
    async close() { workerClosed = true; },
    async raw(sql) {
      if (sql.includes('SELECT @@SESSION.foreign_key_checks')) {
        return { result: [{ fkChecks: 1, autocommit: 1 }] };
      }
      if (sql.includes('information_schema.COLUMNS')) {
        return { rows: [] }; // pre-condition pass
      }
      const timeoutErr = new Error('Query timed out on target server');
      timeoutErr.code = 'QUERY_TIMEOUT';
      throw timeoutErr;
    }
  });

  const admitted = env.admission.admitCandidate(candidate);

  await assert.rejects(
    env.executor.executePlan({ planToken: admitted.planToken }),
    err => {
      assert.equal(err.code, 'QUERY_TIMEOUT');
      assert.equal(err.executionUncertain, true);
      assert.equal(err.partialCommit, true);
      assert.equal(err.ledger[0].status, 'uncertain');
      return true;
    }
  );

  assert.equal(workerClosed, true);
});

test('Engine Matrix: production approval flow verified with generator candidate plan', async () => {
  const env = buildTestEnvironment({ targetEnv: 'production' });

  const generator = new SchemaMigrationGenerator();
  const srcTable = makeTable('users', [
    { name: 'id', type: 'int', nullable: false, isAutoIncrement: true, default: null },
    { name: 'email', type: 'varchar(255)', nullable: true, default: null }
  ]);
  const tgtTable = makeTable('users');
  const src = makeSnapshot('source', 'matrix_db', [srcTable]);
  const tgt = makeSnapshot('target', 'matrix_db', [tgtTable]);

  const candidate = generator.generateCandidatePlan({ sourceSnapshot: src, targetSnapshot: tgt });
  const admitted = env.admission.admitCandidate(candidate);

  // Missing approval on production target must reject
  await assert.rejects(
    env.executor.executePlan({ planToken: admitted.planToken }),
    { code: 'PRODUCTION_APPROVAL_REQUIRED' }
  );

  // Need a fresh plan token because admission reserved the old one
  const candidate2 = generator.generateCandidatePlan({ sourceSnapshot: src, targetSnapshot: tgt });
  const admitted2 = env.admission.admitCandidate(candidate2);

  const approvalReceipt = await env.approval.requestApproval({
    plan: admitted2,
    targetProfile: env.profiles.target,
    sourceProfile: env.profiles.source,
    showConfirmDialog: async () => ({ response: 1 }),
    fingerprintProfile: p => computeSchemaFingerprint({ id: p.id }),
    checkContext: async () => true,
    getGeneration: () => 0,
    getProfile: id => env.profiles[id]
  });

  let ddlRan = false;
  env.executor.createSession = () => ({
    async connect() {},
    async useDatabase() {},
    async close() {},
    async raw(sql) {
      if (sql.includes('SELECT @@SESSION.foreign_key_checks')) {
        return { result: [{ fkChecks: 1, autocommit: 1 }] };
      }
      if (sql.includes('information_schema.COLUMNS')) {
        return { rows: ddlRan ? [{ COLUMN_NAME: 'email' }] : [] };
      }
      if (sql.includes('ALTER TABLE `users` ADD COLUMN')) {
        ddlRan = true;
        return { result: {} };
      }
      return { result: [], rows: [] };
    }
  });

  const res = await env.executor.executePlan({
    planToken: admitted2.planToken,
    approvalToken: approvalReceipt.approvalToken
  });

  assert.equal(res.success, true);
  assert.equal(res.executedCount, 1);
  assert.ok(ddlRan);
});
