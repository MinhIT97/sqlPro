'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { SessionRegistry } = require('../electron/session-registry.cjs');
const { SchemaMigrationOrchestrator } = require('../electron/schema-migration-orchestrator.cjs');
const { SchemaMigrationAdmission, SchemaMigrationApproval } = require('../electron/schema-migration-admission.cjs');
const { SchemaMigrationJobManager } = require('../electron/schema-migration-jobs.cjs');
const { computeSchemaFingerprint } = require('../electron/schema-snapshot.cjs');
const { planDigest } = require('../electron/schema-migration-executor.cjs');

function sampleProfiles() {
  const source = {
    id: 'source_profile',
    name: 'Source DB',
    host: 'source.internal',
    port: 3306,
    user: 'source_user',
    password: 'source_secret_password',
    readOnly: true,
    environment: 'local'
  };
  const target = {
    id: 'target_profile',
    name: 'Target DB',
    host: 'target.internal',
    port: 3306,
    user: 'target_user',
    password: 'target_secret_password',
    readOnly: false,
    environment: 'local'
  };
  const prodTarget = {
    id: 'prod_target_profile',
    name: 'Production Target DB',
    host: 'prod.internal',
    port: 3306,
    user: 'prod_user',
    password: 'prod_secret_password',
    readOnly: false,
    environment: 'production'
  };
  return {
    source,
    target,
    prodTarget,
    [source.id]: source,
    [target.id]: target,
    [prodTarget.id]: prodTarget
  };
}

function sampleCandidate(profiles, { isProd = false, targetId = isProd ? 'prod_target_profile' : 'target_profile', statements = null } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const targetProf = profiles[targetId];
  return {
    planId: `plan_${crypto.randomBytes(16).toString('hex')}`,
    planToken: token,
    status: 'ready',
    applySupported: true,
    expiresAt: Date.now() + 60000,
    sourceSnapshotId: `snap_src_${crypto.randomBytes(16).toString('hex')}`,
    targetSnapshotId: `snap_tgt_${crypto.randomBytes(16).toString('hex')}`,
    sourceScope: {
      profileId: profiles.source.id,
      sessionId: `session_${profiles.source.id}_editor`,
      generation: 0,
      database: 'source_db',
      engine: 'MySQL',
      profileFingerprint: computeSchemaFingerprint(profiles.source),
      snapshotIdentity: 'a'.repeat(64)
    },
    targetScope: {
      profileId: targetProf.id,
      sessionId: `session_${targetProf.id}_editor`,
      generation: 0,
      database: 'target_db',
      engine: 'MySQL',
      profileFingerprint: computeSchemaFingerprint(targetProf),
      snapshotIdentity: 'b'.repeat(64)
    },
    options: {
      statementTimeoutMs: 15000,
      wrapForeignKeys: false
    },
    statements: statements || [
      { id: 'stmt_1', sql: 'CREATE TABLE customers (id INT PRIMARY KEY);', status: 'executable', enabled: true },
      { id: 'stmt_2', sql: 'ALTER TABLE customers ADD COLUMN email VARCHAR(255);', status: 'executable', enabled: true }
    ]
  };
}

function createOrchestratorFixture(overrides = {}) {
  const profiles = sampleProfiles();
  const store = {
    profiles,
    getWithSecrets(id) {
      const p = this.profiles[id];
      return p ? { ...p } : null;
    }
  };

  const sessionRegistry = new SessionRegistry({ create: async () => ({}) });
  const openSessions = new Map();
  let generation = 0;
  const progressEvents = [];

  const sourceEditor = {
    profileId: profiles.source.id,
    sessionId: `session_${profiles.source.id}_editor`,
    profileFingerprint: computeSchemaFingerprint(profiles.source),
    session: { dead: false, inTransaction: false, autocommit: true, activeTask: null }
  };
  openSessions.set(profiles.source.id, sourceEditor);

  const targetEditor = {
    profileId: profiles.target.id,
    sessionId: `session_${profiles.target.id}_editor`,
    profileFingerprint: computeSchemaFingerprint(profiles.target),
    session: { dead: false, inTransaction: false, autocommit: true, activeTask: null }
  };
  openSessions.set(profiles.target.id, targetEditor);

  const prodEditor = {
    profileId: profiles.prodTarget.id,
    sessionId: `session_${profiles.prodTarget.id}_editor`,
    profileFingerprint: computeSchemaFingerprint(profiles.prodTarget),
    session: { dead: false, inTransaction: false, autocommit: true, activeTask: null }
  };
  openSessions.set(profiles.prodTarget.id, prodEditor);

  const workerEvents = [];
  const workerQueries = [];
  let workerCreatedCount = 0;
  let workerClosedCount = 0;

  class FakeWorkerSession {
    constructor(profile) {
      this.profile = profile;
      this.sessionId = null;
      this.dead = false;
      workerCreatedCount++;
    }
    async connect() {
      workerEvents.push(`connect:${this.profile.id}`);
      if (overrides.onWorkerConnect) await overrides.onWorkerConnect(this);
    }
    async useDatabase(db) {
      workerEvents.push(`use:${db}`);
      if (overrides.onWorkerUseDatabase) await overrides.onWorkerUseDatabase(this, db);
    }
    async raw(sql) {
      workerQueries.push(sql);
      if (overrides.onWorkerRaw) await overrides.onWorkerRaw(this, sql);
      if (sql.includes('foreign_key_checks')) {
        return { result: [{ fkChecks: 1, autocommit: 1 }] };
      }
      return { result: [] };
    }
    async close() {
      if (this.closed) return;
      this.closed = true;
      this.dead = true;
      workerClosedCount++;
      workerEvents.push(`close:${this.profile.id}`);
    }
  }

  const createCollector = (session, context) => ({
    async collect(database) {
      workerEvents.push(`collect:${database}`);
      if (overrides.onCollector) await overrides.onCollector(session, context, database);
      const isSource = session.profile.id === profiles.source.id;
      return {
        coverage: 'complete',
        database,
        snapshotIdentity: isSource ? 'a'.repeat(64) : 'b'.repeat(64),
        scope: {
          profileId: context.profileId,
          sessionId: context.sessionId,
          generation: context.generation,
          profileFingerprint: context.profileFingerprint,
          database,
          engine: 'MySQL',
          serverVersion: '8.4.0'
        },
        tables: []
      };
    }
  });

  let confirmDialogResponse = { response: 1 };
  const showConfirmDialog = async (opts) => {
    workerEvents.push(`dialog:${opts.title}`);
    if (overrides.onConfirmDialog) await overrides.onConfirmDialog(opts);
    return confirmDialogResponse;
  };

  const orchestrator = new SchemaMigrationOrchestrator({
    store,
    sessionRegistry,
    openSessions,
    getGeneration: () => generation,
    productionProfileFingerprint: computeSchemaFingerprint,
    sessionProfileFingerprint: computeSchemaFingerprint,
    assertSessionProfile: (current) => {
      const p = store.getWithSecrets(current.profileId);
      if (!p || computeSchemaFingerprint(p) !== current.profileFingerprint) {
        throw new Error('PROFILE_TARGET_CHANGED');
      }
    },
    showConfirmDialog,
    createSession: (profile) => new FakeWorkerSession(profile),
    createCollector,
    sendProgress: (evt) => progressEvents.push(evt),
    statementTimeoutMs: 10000,
    ...overrides.orchestratorOptions
  });

  return {
    orchestrator,
    store,
    profiles,
    sessionRegistry,
    openSessions,
    get generation() { return generation; },
    set generation(g) { generation = g; },
    progressEvents,
    workerEvents,
    workerQueries,
    get workerCreatedCount() { return workerCreatedCount; },
    get workerClosedCount() { return workerClosedCount; },
    setConfirmDialogResponse(resp) { confirmDialogResponse = resp; }
  };
}

test('admitPlan admits candidate and rejects caller-supplied plan/sql/hooks/profiles in executeMigrationJob', async () => {
  const f = createOrchestratorFixture();
  const candidate = sampleCandidate(f.profiles);
  const admitted = f.orchestrator.admitPlan(candidate);

  assert.equal(admitted.status, 'ready');
  assert.equal(admitted.applySupported, true);
  assert.match(admitted.planDigest, /^[a-f0-9]{64}$/);

  // Reject caller supplying plan
  await assert.rejects(
    f.orchestrator.executeMigrationJob({ planToken: admitted.planToken, plan: {} }),
    { code: 'CALLER_FIELDS_REJECTED' }
  );

  // Reject caller supplying statements
  await assert.rejects(
    f.orchestrator.executeMigrationJob({ planToken: admitted.planToken, statements: [] }),
    { code: 'CALLER_FIELDS_REJECTED' }
  );

  // Reject caller supplying sql
  await assert.rejects(
    f.orchestrator.executeMigrationJob({ planToken: admitted.planToken, sql: 'DROP TABLE users' }),
    { code: 'CALLER_FIELDS_REJECTED' }
  );

  // Reject caller supplying hooks
  await assert.rejects(
    f.orchestrator.executeMigrationJob({ planToken: admitted.planToken, hooks: {} }),
    { code: 'CALLER_FIELDS_REJECTED' }
  );

  // Reject caller supplying sourceProfile / targetProfile
  await assert.rejects(
    f.orchestrator.executeMigrationJob({ planToken: admitted.planToken, sourceProfile: {} }),
    { code: 'CALLER_FIELDS_REJECTED' }
  );

  // Reject malformed plan token
  await assert.rejects(
    f.orchestrator.executeMigrationJob({ planToken: 'not-a-valid-token' }),
    { code: 'INVALID_PLAN_TOKEN' }
  );

  // Reject unknown plan token
  await assert.rejects(
    f.orchestrator.executeMigrationJob({ planToken: 'a'.repeat(64) }),
    { code: 'INVALID_PLAN_TOKEN' }
  );
});

test('full happy path execution via orchestrator leases editor sessions and releases them cleanly', async () => {
  const f = createOrchestratorFixture();
  const candidate = sampleCandidate(f.profiles);
  const admitted = f.orchestrator.admitPlan(candidate);

  const result = await f.orchestrator.executeMigrationJob({ planToken: admitted.planToken });

  assert.equal(result.kind, 'sqlpro-migration-job');
  assert.equal(result.status, 'completed');
  assert.equal(result.executedCount, 2);
  assert.equal(result.totalCount, 2);
  assert.equal(result.executionUncertain, false);
  assert.equal(result.partialCommit, false);
  assert.equal(result.error, null);

  // Editor session leases released
  assert.equal(f.sessionRegistry.leases.size, 0);
  assert.equal(f.openSessions.get(f.profiles.source.id).exclusiveOperation, false);
  assert.equal(f.openSessions.get(f.profiles.target.id).exclusiveOperation, false);

  // Workers were closed cleanly (2 source verifications + 1 target worker)
  assert.equal(f.workerCreatedCount, 3);
  assert.equal(f.workerClosedCount, 3);

  // Progress events received
  assert.ok(f.progressEvents.length > 0);
  assert.ok(f.progressEvents.every(e => e.generation === 0));

  // Cannot reuse plan token
  await assert.rejects(
    f.orchestrator.executeMigrationJob({ planToken: admitted.planToken }),
    { code: 'MIGRATION_TOKEN_USED' }
  );
});

test('production approval flow requires confirm dialog, validates receipt and enforces atomic consumption', async () => {
  const f = createOrchestratorFixture();

  // 1. Executing production job without approval token must throw PRODUCTION_APPROVAL_REQUIRED
  const candNoApproval = sampleCandidate(f.profiles, { isProd: true });
  const admittedNoApproval = f.orchestrator.admitPlan(candNoApproval);
  await assert.rejects(
    f.orchestrator.executeMigrationJob({ planToken: admittedNoApproval.planToken }),
    { code: 'PRODUCTION_APPROVAL_REQUIRED' }
  );

  // 2. Calling requestProductionApproval when user cancels dialog throws MIGRATION_APPROVAL_CANCELED
  const candCancel = sampleCandidate(f.profiles, { isProd: true });
  const admittedCancel = f.orchestrator.admitPlan(candCancel);
  f.setConfirmDialogResponse({ response: 0 }); // User clicked "Hủy"
  await assert.rejects(
    f.orchestrator.requestProductionApproval(admittedCancel.planToken),
    { code: 'MIGRATION_APPROVAL_CANCELED' }
  );

  // 3. When user approves
  const candOk = sampleCandidate(f.profiles, { isProd: true });
  const admittedOk = f.orchestrator.admitPlan(candOk);
  f.setConfirmDialogResponse({ response: 1 }); // User clicked "Xác nhận"
  const approval = await f.orchestrator.requestProductionApproval(admittedOk.planToken);
  assert.ok(approval.approvalToken);
  assert.ok(approval.expiresAt);

  // 4. Executing production job with valid approval token succeeds
  const result = await f.orchestrator.executeMigrationJob({
    planToken: admittedOk.planToken,
    approvalToken: approval.approvalToken
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.executedCount, 2);

  // 5. Plan token cannot be reused
  await assert.rejects(
    f.orchestrator.executeMigrationJob({
      planToken: admittedOk.planToken,
      approvalToken: approval.approvalToken
    }),
    { code: 'MIGRATION_TOKEN_USED' }
  );
});

test('cancelJob revokes admitted plan and pending approval if not yet consumed', async () => {
  const f = createOrchestratorFixture();
  const candidate = sampleCandidate(f.profiles, { isProd: true });
  const admitted = f.orchestrator.admitPlan(candidate);

  f.setConfirmDialogResponse({ response: 1 });
  const approval = await f.orchestrator.requestProductionApproval(admitted.planToken);

  const job = f.orchestrator.jobManager.createJob({
    plan: admitted,
    planToken: admitted.planToken,
    approvalToken: approval.approvalToken
  });

  const cancelled = f.orchestrator.cancelJob(job.jobId, 'Canceled before run');
  assert.equal(cancelled.status, 'cancelled');

  // Admitted plan must have been consumed/revoked
  assert.equal(f.orchestrator.admission.getAdmittedPlan(admitted.planToken), null);

  // Approval must have been deleted
  assert.equal(f.orchestrator.approval.pending.has(approval.approvalToken), false);
});

test('cancel during DDL marks partial commit, stops subsequent statements and cleans up workers', async () => {
  let triggerCancel;
  const f = createOrchestratorFixture();

  const candidate = sampleCandidate(f.profiles);
  const admitted = f.orchestrator.admitPlan(candidate);

  const origSend = f.orchestrator.sendProgress;
  f.orchestrator.sendProgress = (evt) => {
    origSend(evt);
    const s1 = evt.statements?.find(s => s.id === 'stmt_1');
    if (s1?.status === 'executed' && triggerCancel) {
      const cancelFn = triggerCancel;
      triggerCancel = null;
      cancelFn();
    }
  };

  triggerCancel = () => {
    const activeJobs = [...f.orchestrator.jobManager.jobs.keys()];
    if (activeJobs.length > 0) {
      f.orchestrator.cancelJob(activeJobs[0], 'User aborted during execution');
    }
  };

  await assert.rejects(
    f.orchestrator.executeMigrationJob({ planToken: admitted.planToken }),
    { code: 'QUERY_CANCELED' }
  );

  const job = f.orchestrator.jobManager.jobs.values().next().value;
  assert.ok(['cancelled', 'uncertain'].includes(job.status));
  assert.equal(job.executedCount, 1);
  assert.equal(job.partialCommit, true);
  assert.equal(job.ledger[0].status, 'executed');
  assert.equal(job.ledger[1].status, 'cancelled');

  // Both workers closed cleanly
  assert.equal(f.workerClosedCount, f.workerCreatedCount);
  // Editor sessions freed
  assert.equal(f.sessionRegistry.leases.size, 0);
});

test('source profile drift during worker await throws SOURCE_PROFILE_DRIFT and closes worker', async () => {
  let drifted = false;
  const f = createOrchestratorFixture({
    async onCollector(session, context, database) {
      if (session.profile.id === f.profiles.source.id && !drifted) {
        drifted = true;
        // Tamper with source password
        f.store.profiles.source_profile.password = 'new_changed_secret';
      }
    }
  });

  const candidate = sampleCandidate(f.profiles);
  const admitted = f.orchestrator.admitPlan(candidate);

  await assert.rejects(
    f.orchestrator.executeMigrationJob({ planToken: admitted.planToken }),
    err => ['SOURCE_PROFILE_DRIFT', 'SOURCE_CONTEXT_CHANGED'].includes(err.code)
  );

  assert.equal(f.workerClosedCount, f.workerCreatedCount);
  assert.equal(f.sessionRegistry.leases.size, 0);
});

test('logout or generation change during worker await throws and drops late progress events', async () => {
  let generationChanged = false;
  const f = createOrchestratorFixture({
    async onWorkerUseDatabase(session, db) {
      if (!generationChanged && session.profile.id === f.profiles.target.id) {
        generationChanged = true;
        // Bump generation (simulating logout/reset)
        f.generation = 1;
      }
    }
  });

  const candidate = sampleCandidate(f.profiles);
  const admitted = f.orchestrator.admitPlan(candidate);

  await assert.rejects(
    f.orchestrator.executeMigrationJob({ planToken: admitted.planToken }),
    { code: 'MIGRATION_CONTEXT_UNVERIFIED' }
  );

  // Late progress events with old generation are dropped
  assert.ok(f.progressEvents.every(e => e.generation === 0));
  assert.equal(f.sessionRegistry.leases.size, 0);
});

test('competing jobs targeting same database are blocked with TARGET_BUSY', async () => {
  let unblock;
  let notifyEntered;
  const entered = new Promise(r => { notifyEntered = r; });
  const f = createOrchestratorFixture({
    async onWorkerRaw(worker, sql) {
      if (sql.includes('CREATE TABLE customers')) {
        notifyEntered();
        await new Promise(r => { unblock = r; });
      }
    }
  });

  const cand1 = sampleCandidate(f.profiles);
  const cand2 = sampleCandidate(f.profiles);
  const adm1 = f.orchestrator.admitPlan(cand1);
  const adm2 = f.orchestrator.admitPlan(cand2);

  const job1Promise = f.orchestrator.executeMigrationJob({ planToken: adm1.planToken });
  await entered;

  // Attempting to run a second job on the same target while first is running
  await assert.rejects(
    f.orchestrator.executeMigrationJob({ planToken: adm2.planToken }),
    { code: 'TARGET_BUSY' }
  );

  if (unblock) unblock();
  const res1 = await job1Promise;
  assert.equal(res1.status, 'completed');
});

test('session busy or transaction on Editor session blocks job before any worker creation', async () => {
  const f = createOrchestratorFixture();
  // Set target editor session in transaction
  f.openSessions.get(f.profiles.target.id).session.inTransaction = true;

  const candidate = sampleCandidate(f.profiles);
  const admitted = f.orchestrator.admitPlan(candidate);

  await assert.rejects(
    f.orchestrator.executeMigrationJob({ planToken: admitted.planToken }),
    { code: 'SESSION_BUSY' }
  );

  // No workers created
  assert.equal(f.workerCreatedCount, 0);
  assert.equal(f.sessionRegistry.leases.size, 0);
});

test('orchestrator.reset cancels active jobs, awaits worker close, and clears all state', async () => {
  let unblockWorker;
  let notifyEntered;
  const entered = new Promise(r => { notifyEntered = r; });
  const f = createOrchestratorFixture({
    async onWorkerRaw(worker, sql) {
      if (sql.includes('CREATE TABLE customers')) {
        notifyEntered();
        await new Promise(r => { unblockWorker = r; });
      }
    }
  });

  const candidate = sampleCandidate(f.profiles);
  const admitted = f.orchestrator.admitPlan(candidate);

  const jobPromise = f.orchestrator.executeMigrationJob({ planToken: admitted.planToken });
  await entered;

  // Reset orchestrator while job is in progress
  const resetPromise = f.orchestrator.reset('Logout triggered');

  if (unblockWorker) unblockWorker();

  await assert.rejects(jobPromise, { code: 'QUERY_CANCELED' });
  await resetPromise;

  assert.equal(f.orchestrator.runningPromises.size, 0);
  assert.equal(f.orchestrator.jobManager.jobs.size, 0);
  assert.equal(f.orchestrator.admission.admittedPlans.size, 0);
  assert.equal(f.orchestrator.approval.pending.size, 0);
  assert.equal(f.sessionRegistry.leases.size, 0);
  assert.equal(f.workerClosedCount, f.workerCreatedCount);
});
