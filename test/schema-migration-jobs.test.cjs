'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { SessionRegistry } = require('../electron/session-registry.cjs');
const {
  SchemaMigrationJob,
  SchemaMigrationJobManager,
  sanitizeErrorCode
} = require('../electron/schema-migration-jobs.cjs');
const {
  SchemaMigrationAdmission,
  SchemaMigrationApproval,
  createMainContextHooks,
  createSourceVerifier
} = require('../electron/schema-migration-admission.cjs');
const { SchemaMigrationExecutor, planDigest } = require('../electron/schema-migration-executor.cjs');
const { computeSchemaFingerprint } = require('../electron/schema-snapshot.cjs');

function sampleProfiles() {
  const source = {
    id: 'source_profile',
    name: 'Source DB',
    host: 'source.internal',
    port: 3306,
    user: 'dev_user',
    password: 'super_secret_source_password',
    readOnly: true,
    environment: 'local'
  };
  const target = {
    id: 'target_profile',
    name: 'Target DB',
    host: 'target.internal',
    port: 3306,
    user: 'prod_user',
    password: 'super_secret_target_password',
    readOnly: false,
    environment: 'local'
  };
  return {
    source,
    target,
    [source.id]: source,
    [target.id]: target
  };
}

function sampleCandidatePlan(profiles, overrides = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  return {
    planId: `plan_${crypto.randomBytes(16).toString('hex')}`,
    planToken: token,
    sourceSnapshotId: `snap_src_${crypto.randomBytes(16).toString('hex')}`,
    targetSnapshotId: `snap_tgt_${crypto.randomBytes(16).toString('hex')}`,
    sourceScope: {
      profileId: profiles.source.id,
      sessionId: 'session_source_editor',
      generation: 0,
      database: 'source_db',
      engine: 'MySQL',
      profileFingerprint: computeSchemaFingerprint(profiles.source),
      snapshotIdentity: 'a'.repeat(64)
    },
    targetScope: {
      profileId: profiles.target.id,
      sessionId: 'session_target_editor',
      generation: 0,
      database: 'target_db',
      engine: 'MySQL',
      profileFingerprint: computeSchemaFingerprint(profiles.target),
      snapshotIdentity: 'b'.repeat(64)
    },
    options: {
      statementTimeoutMs: 15000,
      wrapForeignKeys: false
    },
    statements: [
      { id: 'stmt_1', sql: 'CREATE TABLE orders (id INT PRIMARY KEY);', status: 'executable', enabled: true },
      { id: 'stmt_2', sql: 'ALTER TABLE orders ADD COLUMN amount DECIMAL(10,2);', status: 'executable', enabled: true }
    ],
    status: 'ready',
    applySupported: true,
    expiresAt: Date.now() + 120000,
    ...overrides
  };
}

function mockDriverSession(options = {}) {
  const events = [];
  const queries = [];
  let closed = false;
  let dead = false;

  return {
    events,
    queries,
    get closed() { return closed; },
    get dead() { return dead; },
    set dead(val) { dead = val; },
    connection: {
      destroy() {
        events.push('destroy');
        dead = true;
      }
    },
    async connect() {
      events.push('connect');
      if (options.failConnect) throw new Error('CONNECTION_REFUSED');
    },
    async useDatabase(db) {
      events.push(`use:${db}`);
      if (options.failUse) throw new Error('UNKNOWN_DATABASE');
    },
    async raw(sql, params, timeoutMs) {
      queries.push({ sql, params, timeoutMs });
      events.push(`raw:${sql.slice(0, 30)}`);
      if (options.onRaw) return options.onRaw(sql, params, timeoutMs);
      if (sql.includes('@@SESSION.foreign_key_checks')) {
        return { result: [{ fkChecks: 1, autocommit: 1 }] };
      }
      return { result: [] };
    },
    async close() {
      events.push('close');
      closed = true;
      dead = true;
    }
  };
}

function registryFor(entries) {
  const registry = new SessionRegistry({ create: async () => { throw Error('Unexpected open'); },
    isProtected: entry => Boolean(entry.exclusiveOperation || entry.productionWriteInProgress) });
  registry.entries = entries;
  return registry;
}
function environment(plan) {
  const openSessions = new Map([plan.sourceScope, plan.targetScope].map(scope => [scope.profileId, {
    profileId: scope.profileId, sessionId: scope.sessionId, profileFingerprint: scope.profileFingerprint,
    session: { dead: false, autocommit: true }
  }]));
  return { openSessions, sessionRegistry: registryFor(openSessions) };
}

test('sanitizeErrorCode extracts safe code and never leaks raw SQL or details', () => {
  assert.equal(sanitizeErrorCode('ER_TABLE_EXISTS_ERROR'), 'ER_TABLE_EXISTS_ERROR');
  assert.equal(sanitizeErrorCode({ code: 'PROTOCOL_SEQUENCE_TIMEOUT' }), 'PROTOCOL_SEQUENCE_TIMEOUT');
  assert.equal(
    sanitizeErrorCode(new Error("You have an error in your SQL syntax near 'ALTER TABLE users ADD secret VARCHAR(255)'")),
    'MIGRATION_EXECUTION_FAILED'
  );
  assert.equal(
    sanitizeErrorCode({ message: 'Table production_db.users already exists' }),
    'MIGRATION_EXECUTION_FAILED'
  );
  assert.equal(sanitizeErrorCode(null), null);
  assert.equal(sanitizeErrorCode(undefined), null);
});

test('job lifecycle progresses through preparing -> verifying -> executing -> completed', async () => {
  const profiles = sampleProfiles();
  const candidate = sampleCandidatePlan(profiles);
  const admission = new SchemaMigrationAdmission();
  const admitted = admission.admitCandidate(candidate, { allowTestCandidate: true });

  const manager = new SchemaMigrationJobManager();
  const job = manager.createJob({
    plan: admitted,
    planToken: admitted.planToken
  });

  assert.equal(job.status, 'preparing');
  assert.ok(job.jobId.startsWith('job_'));
  assert.equal(job.planDigest, admitted.planDigest);

  // Setup execution environment
  const store = { getWithSecrets: id => structuredClone(profiles[id]) };
  const openSessions = new Map([
    [profiles.source.id, {
      profileId: profiles.source.id,
      sessionId: candidate.sourceScope.sessionId,
      profileFingerprint: candidate.sourceScope.profileFingerprint,
      session: { inTransaction: false, autocommit: true, activeTask: null, dead: false }
    }],
    [profiles.target.id, {
      profileId: profiles.target.id,
      sessionId: candidate.targetScope.sessionId,
      profileFingerprint: candidate.targetScope.profileFingerprint,
      session: { inTransaction: false, autocommit: true, activeTask: null, dead: false }
    }]
  ]);

  const sessionRegistry = registryFor(openSessions);
  const hooks = createMainContextHooks({ store, openSessions, sessionRegistry, getGeneration: () => 0,
    ownsLease: (id, plan, entry) => manager.ownsLease(id, plan, entry) });

  const sourceVerifier = createSourceVerifier({
    store,
    createSession: () => mockDriverSession(),
    createCollector: (session, ctx) => ({
      collect: async db => ({
        coverage: 'complete',
        database: db,
        snapshotIdentity: candidate.sourceScope.snapshotIdentity,
        scope: { ...ctx, database: db, engine: 'MySQL' }
      })
    })
  });

  let targetWorkerSession = null;
  const executor = new SchemaMigrationExecutor({
    consumePlan: token => admission.consumePlan(token),
    getProfileWithSecrets: hooks.getProfileWithSecrets,
    fingerprintProfile: hooks.fingerprintProfile,
    checkContext: hooks.checkContext,
    verifySource: sourceVerifier,
    createSession: () => {
      targetWorkerSession = mockDriverSession();
      return targetWorkerSession;
    },
    createCollector: (session, ctx) => ({
      collect: async db => ({
        coverage: 'complete',
        database: db,
        snapshotIdentity: candidate.targetScope.snapshotIdentity,
        scope: { ...ctx, database: db, engine: 'MySQL' }
      })
    })
  });

  const progressEvents = [];
  const result = await manager.runJob({
    job,
    executor,
    openSessions,
    sessionRegistry,
    onProgress: p => progressEvents.push(p)
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.executedCount, 2);
  assert.equal(result.totalCount, 2);
  assert.equal(result.executionUncertain, false);
  assert.equal(result.partialCommit, false);
  assert.ok(targetWorkerSession.closed);
  assert.ok(progressEvents.length > 0);
});

test('concurrency quota: two jobs competing for same target database are rejected with TARGET_BUSY', () => {
  const profiles = sampleProfiles();
  const candidate1 = sampleCandidatePlan(profiles);
  const candidate2 = sampleCandidatePlan(profiles);
  const admission = new SchemaMigrationAdmission();

  const admitted1 = admission.admitCandidate(candidate1, { allowTestCandidate: true });
  const admitted2 = admission.admitCandidate(candidate2, { allowTestCandidate: true });

  const manager = new SchemaMigrationJobManager();
  const job1 = manager.createJob({
    plan: admitted1,
    planToken: admitted1.planToken
  });

  assert.throws(() => manager.createJob({
    plan: admitted2,
    planToken: admitted2.planToken
  }), {
    code: 'TARGET_BUSY'
  });
});

test('concurrency quota: maxActiveJobs limit rejects excess concurrent jobs', () => {
  const profiles = sampleProfiles();
  const admission = new SchemaMigrationAdmission();
  const manager = new SchemaMigrationJobManager({ maxActiveJobs: 2 });

  // Job 1 on target db1
  const cand1 = sampleCandidatePlan(profiles);
  cand1.targetScope.database = 'target_db_1';
  const adm1 = admission.admitCandidate(cand1, { allowTestCandidate: true });
  manager.createJob({ plan: adm1, planToken: adm1.planToken });

  // Job 2 on target db2
  const cand2 = sampleCandidatePlan(profiles);
  cand2.targetScope.database = 'target_db_2';
  const adm2 = admission.admitCandidate(cand2, { allowTestCandidate: true });
  manager.createJob({ plan: adm2, planToken: adm2.planToken });

  // Job 3 on target db3 exceeds maxActiveJobs (2)
  const cand3 = sampleCandidatePlan(profiles);
  cand3.targetScope.database = 'target_db_3';
  const adm3 = admission.admitCandidate(cand3, { allowTestCandidate: true });

  assert.throws(() => manager.createJob({
    plan: adm3,
    planToken: adm3.planToken
  }), {
    code: 'MIGRATION_JOB_LIMIT_EXCEEDED'
  });
});

test('cancellation before start rejects immediately without executing any database work', async () => {
  const profiles = sampleProfiles();
  const candidate = sampleCandidatePlan(profiles);
  const admission = new SchemaMigrationAdmission();
  const admitted = admission.admitCandidate(candidate, { allowTestCandidate: true });

  const manager = new SchemaMigrationJobManager();
  const job = manager.createJob({ plan: admitted, planToken: admitted.planToken });

  let executorCalled = false;
  const executor = {
    executePlan: async () => {
      executorCalled = true;
    }
  };

  const controller = new AbortController();
  controller.abort('Pre-cancelled');

  await assert.rejects(manager.runJob({
    job,
    executor,
    signal: controller.signal
  }), {
    code: 'QUERY_CANCELED'
  });

  assert.equal(executorCalled, false);
  assert.equal(job.status, 'cancelled');
});

test('cancellation mid-DDL marks uncertainty, stops subsequent statements and retains executed ledger', async () => {
  const profiles = sampleProfiles();
  const candidate = sampleCandidatePlan(profiles);
  const admission = new SchemaMigrationAdmission();
  const admitted = admission.admitCandidate(candidate, { allowTestCandidate: true });

  const manager = new SchemaMigrationJobManager();
  const job = manager.createJob({ plan: admitted, planToken: admitted.planToken });

  const store = { getWithSecrets: id => structuredClone(profiles[id]) };
  const env = environment(admitted);
  const hooks = createMainContextHooks({ store, ...env, getGeneration: () => 0,
    ownsLease: (id, plan, entry) => manager.ownsLease(id, plan, entry) });

  let targetWorker = null;
  const executor = new SchemaMigrationExecutor({
    consumePlan: token => admission.consumePlan(token),
    getProfileWithSecrets: hooks.getProfileWithSecrets,
    fingerprintProfile: hooks.fingerprintProfile,
    checkContext: hooks.checkContext,
    verifySource: async () => ({
      coverage: 'complete',
      database: candidate.sourceScope.database,
      snapshotIdentity: candidate.sourceScope.snapshotIdentity,
      scope: { ...candidate.sourceScope }
    }),
    createSession: () => {
      targetWorker = mockDriverSession({
        onRaw: async sql => {
          if (sql.includes('@@SESSION.foreign_key_checks')) {
            return { result: [{ fkChecks: 1, autocommit: 1 }] };
          }
          if (sql.includes('ALTER TABLE orders ADD COLUMN amount')) {
            // Abort during second DDL statement
            job.cancel('User clicked Cancel');
            throw Object.assign(new Error('QUERY_CANCELED'), {
              code: 'QUERY_CANCELED',
              executionUncertain: true
            });
          }
          return { result: [] };
        }
      });
      return targetWorker;
    },
    createCollector: (session, ctx) => ({
      collect: async db => ({
        coverage: 'complete',
        database: db,
        snapshotIdentity: candidate.targetScope.snapshotIdentity,
        scope: { ...ctx, database: db, engine: 'MySQL' }
      })
    })
  });

  await assert.rejects(manager.runJob({ job, executor, ...env }), err => {
    assert.equal(err.code, 'QUERY_CANCELED');
    return true;
  });

  assert.equal(job.status, 'uncertain');
  assert.equal(job.executedCount, 1);
  assert.equal(job.partialCommit, true);
  assert.equal(job.executionUncertain, true);

  // Statement 1 executed, statement 2 uncertain/failed
  assert.equal(job.ledger[0].status, 'executed');
  assert.ok(['uncertain', 'failed', 'cancelled'].includes(job.ledger[1].status));
});

test('projectForRenderer sanitizes output and never discloses SQL, DEFINER, driver text or passwords', () => {
  const profiles = sampleProfiles();
  const candidate = sampleCandidatePlan(profiles);
  const admission = new SchemaMigrationAdmission();
  const admitted = admission.admitCandidate(candidate, { allowTestCandidate: true });

  const job = new SchemaMigrationJob({
    plan: admitted,
    planToken: admitted.planToken
  });

  job.ledger[0].status = 'executed';
  job.ledger[1].status = 'failed';
  job.ledger[1].error = new Error("Syntax error near 'ALTER TABLE secret_table ADD COLUMN pii_col'");

  const projection = job.projectForRenderer();

  // Whitelist checks
  assert.ok(projection.jobId);
  assert.equal(projection.status, 'preparing');
  assert.equal(projection.totalCount, 2);

  // Absence of secrets
  const json = JSON.stringify(projection);
  assert.equal(json.includes('super_secret_source_password'), false);
  assert.equal(json.includes('super_secret_target_password'), false);
  assert.equal(json.includes('secret_table'), false);
  assert.equal(json.includes('CREATE TABLE orders'), false);
  assert.equal(json.includes('pii_col'), false);

  // Error is sanitized code only
  assert.equal(projection.statements[1].error, 'MIGRATION_EXECUTION_FAILED');
  assert.equal(projection.statements[0].error, null);
});

test('lease coordination: editor operations see SESSION_BUSY while job owns exclusive lease, then release in finally', async () => {
  const profiles = sampleProfiles();
  const candidate = sampleCandidatePlan(profiles);
  const admission = new SchemaMigrationAdmission();
  const admitted = admission.admitCandidate(candidate, { allowTestCandidate: true });

  const manager = new SchemaMigrationJobManager();
  const job = manager.createJob({ plan: admitted, planToken: admitted.planToken });

  const sourceEntry = {
    profileId: profiles.source.id,
    sessionId: candidate.sourceScope.sessionId,
    profileFingerprint: candidate.sourceScope.profileFingerprint,
    session: { inTransaction: false, autocommit: true, activeTask: null, dead: false },
    exclusiveOperation: false,
    exclusiveOwnerJobId: null
  };

  const targetEntry = {
    profileId: profiles.target.id,
    sessionId: candidate.targetScope.sessionId,
    profileFingerprint: candidate.targetScope.profileFingerprint,
    session: { inTransaction: false, autocommit: true, activeTask: null, dead: false },
    exclusiveOperation: false,
    exclusiveOwnerJobId: null
  };

  const openSessions = new Map([
    [profiles.source.id, sourceEntry],
    [profiles.target.id, targetEntry]
  ]);

  const sessionRegistry = registryFor(openSessions);

  const hooks = createMainContextHooks({
    store: { getWithSecrets: id => structuredClone(profiles[id]) },
    openSessions,
    sessionRegistry,
    getGeneration: () => 0,
    ownsLease: (id, plan, entry) => manager.ownsLease(id, plan, entry)
  });

  const executor = {
    executePlan: async ({ jobId }) => {
      // During execution: targetEntry is marked exclusive for this job
      assert.equal(targetEntry.exclusiveOperation, true);
      assert.equal(targetEntry.exclusiveOwnerJobId, job.jobId);

      // Job's own context check succeeds
      const contextOk = await hooks.checkContext(admitted, { jobId });
      assert.equal(contextOk, true);

      // Third-party context check (another job or no jobId) fails
      const thirdPartyOk = await hooks.checkContext(admitted, { jobId: 'job_other_competing' });
      assert.equal(thirdPartyOk, false);

      return {
        executedCount: 2,
        totalCount: 2,
        partialCommit: false,
        executionUncertain: false,
        ledger: [
          { id: 'stmt_1', status: 'executed' },
          { id: 'stmt_2', status: 'executed' }
        ]
      };
    }
  };

  const result = await manager.runJob({
    job,
    executor,
    sessionRegistry,
    openSessions
  });

  assert.equal(result.status, 'completed');

  // After completion, exclusive lease is cleanly released
  assert.equal(targetEntry.exclusiveOperation, false);
  assert.equal(targetEntry.exclusiveOwnerJobId, null);
  assert.equal(sessionRegistry.leases.size, 0);
});

test('cancelJob and clear abort running jobs and clean up registry maps', () => {
  const profiles = sampleProfiles();
  const admission = new SchemaMigrationAdmission();
  const manager = new SchemaMigrationJobManager();

  const cand1 = sampleCandidatePlan(profiles);
  cand1.targetScope.database = 'db_a';
  const adm1 = admission.admitCandidate(cand1, { allowTestCandidate: true });
  const job1 = manager.createJob({ plan: adm1, planToken: adm1.planToken });

  const cand2 = sampleCandidatePlan(profiles);
  cand2.targetScope.database = 'db_b';
  const adm2 = admission.admitCandidate(cand2, { allowTestCandidate: true });
  const job2 = manager.createJob({ plan: adm2, planToken: adm2.planToken });

  assert.equal(job1.status, 'preparing');
  assert.equal(job2.status, 'preparing');

  // Cancel job 1 specifically
  const proj1 = manager.cancelJob(job1.jobId, 'Cancelled single job');
  assert.equal(proj1.status, 'cancelled');
  assert.equal(job1.status, 'cancelled');
  assert.equal(job2.status, 'preparing');

  // Clear all
  manager.clear();
  assert.equal(job2.status, 'cancelled');
  assert.equal(manager.jobs.size, 0);
  assert.equal(manager.activeJobsByTarget.size, 0);
});

test('busy sessions are never overwritten; partial lease acquisition is cleaned up', async () => {
  for (const mode of ['busy', 'acquire-failure']) {
    const profiles = sampleProfiles(), plan = sampleCandidatePlan(profiles);
    const manager = new SchemaMigrationJobManager(), job = manager.createJob({ plan, planToken: plan.planToken });
    const env = environment(plan), entries = [...env.openSessions.values()];
    let called = false;
    if (mode === 'busy') {
      entries[1].exclusiveOperation = true;
      entries[1].exclusiveOwnerJobId = 'other-operation';
    } else {
      const acquire = env.sessionRegistry.acquire.bind(env.sessionRegistry);
      let count = 0;
      env.sessionRegistry.acquire = entry => { if (++count === 2) throw Error('acquire failed'); return acquire(entry); };
    }
    await assert.rejects(manager.runJob({ job, ...env, executor: { executePlan: async () => { called = true; } } }));
    assert.equal(called, false);
    assert.equal(env.sessionRegistry.leases.size, 0);
    assert.equal(Boolean(entries[0].exclusiveOperation), false);
    if (mode === 'busy') assert.equal(entries[1].exclusiveOwnerJobId, 'other-operation');
    assert.ok(job.finishedAt);
  }
});

test('cancel/clear retain target and concurrency slots until cleanup; jobs cannot run twice or report late progress', async () => {
  const profiles = sampleProfiles(), plan = sampleCandidatePlan(profiles);
  const manager = new SchemaMigrationJobManager(), job = manager.createJob({ plan, planToken: plan.planToken });
  const env = environment(plan);
  let finish, progress;
  const executor = { executePlan: ({ onProgress }) => { progress = onProgress; return new Promise(resolve => { finish = resolve; }); } };
  const pending = manager.runJob({ job, executor, ...env });
  await assert.rejects(manager.runJob({ job, executor, ...env }), { code: 'JOB_INVALID_STATE' });
  manager.clear();
  assert.equal(job.status, 'cancelling');
  assert.equal(manager.activeJobsByTarget.size, 1);
  assert.throws(() => manager.createJob({ plan, planToken: plan.planToken }), { code: 'TARGET_BUSY' });
  finish({ executedCount: 1, totalCount: 2, partialCommit: false,
    ledger: [{ id: plan.statements[0].id, status: 'executed' }] });
  await assert.rejects(pending, err => { assert.equal(err.job.status, 'cancelled'); assert.equal(err.job.partialCommit, true); assert.ok(err.job.finishedAt); return true; });
  assert.equal(env.sessionRegistry.leases.size, 0);
  assert.equal(manager.jobs.size, 0);
  assert.equal(manager.activeJobsByTarget.size, 0);
  progress({ executedCount: 999 });
  assert.equal(job.executedCount, 1);
  assert.ok(manager.createJob({ plan, planToken: plan.planToken }));
});

test('foreign jobs and mismatched tokens are rejected; target keys have exact tuple boundaries', async () => {
  const profiles = sampleProfiles(), plan = sampleCandidatePlan(profiles), manager = new SchemaMigrationJobManager();
  const foreign = new SchemaMigrationJobManager().createJob({ plan, planToken: plan.planToken });
  await assert.rejects(manager.runJob({ job: foreign }), { code: 'JOB_INVALID_STATE' });
  assert.throws(() => manager.createJob({ plan, planToken: '0'.repeat(64) }), { code: 'INVALID_PLAN_TOKEN' });
  const first = structuredClone(plan), second = structuredClone(plan);
  first.targetScope.profileId = 'a:b'; first.targetScope.database = 'c';
  second.targetScope.profileId = 'a'; second.targetScope.database = 'b:c';
  manager.createJob({ plan: first, planToken: first.planToken });
  manager.createJob({ plan: second, planToken: second.planToken });
  assert.equal(manager.activeJobsByTarget.size, 2);
});

test('only registered lease ownership can pass context; forged plan jobId and extra leases cannot', async () => {
  const profiles = sampleProfiles(), plan = sampleCandidatePlan(profiles), manager = new SchemaMigrationJobManager();
  const job = manager.createJob({ plan, planToken: plan.planToken }), env = environment(plan);
  const hooks = createMainContextHooks({ store: { getWithSecrets: id => profiles[id] }, ...env, getGeneration: () => 0,
    ownsLease: (id, p, entry) => manager.ownsLease(id, p, entry) });
  const result = await manager.runJob({ job, ...env, executor: { executePlan: async ({ jobId }) => {
    assert.equal(await hooks.checkContext(plan, { jobId }), true);
    assert.equal(await hooks.checkContext({ ...plan, jobId }), false);
    assert.equal(await hooks.checkContext({ ...plan, statements: [] }, { jobId }), false);
    const release = env.sessionRegistry.acquire(env.openSessions.get(plan.targetScope.profileId));
    assert.equal(await hooks.checkContext(plan, { jobId }), false);
    release();
    return { executedCount: 0, totalCount: 2, ledger: [] };
  } } });
  assert.equal(result.status, 'completed');
  assert.ok(result.finishedAt);
});

test('observer promises cannot stall cleanup or leak rejections; projections are detached and error codes allowlisted', async () => {
  const profiles = sampleProfiles(), plan = sampleCandidatePlan(profiles), manager = new SchemaMigrationJobManager();
  const job = manager.createJob({ plan, planToken: plan.planToken }), env = environment(plan);
  job.onProgress(p => { p.target.database = 'mutated'; });
  job.onProgress(async () => { throw Error('observer rejected'); });
  job.onProgress(() => new Promise(() => {}));
  await manager.runJob({ job, ...env, executor: { executePlan: async ({ onProgress }) => {
    onProgress({ executedCount: 1, currentStatement: { id: plan.statements[0].id, status: 'executed' } });
    return { executedCount: 1, totalCount: 2, ledger: [] };
  } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(job.targetScope.database, plan.targetScope.database);
  assert.ok(job.observerWarnings.includes('PROGRESS_CALLBACK_FAILED'));
  assert.equal(env.sessionRegistry.leases.size, 0);
  job.cleanupError = 'TOP_SECRET_TOKEN';
  job.error = { code: 'TOP_SECRET_TOKEN' };
  job.ledger[0].status = 'TOP_SECRET_TOKEN';
  job.ledger[0].durationMs = 'TOP_SECRET_TOKEN';
  job.observerWarnings.push('TOP_SECRET_TOKEN');
  assert.equal(JSON.stringify(job.projectForRenderer()).includes('TOP_SECRET_TOKEN'), false);
});

test('terminal job retention is bounded, expired history prunes and immutable identity cannot be changed', () => {
  const manager = new SchemaMigrationJobManager({ maxJobs: 1, jobTtlMs: 1000 });
  const profiles = sampleProfiles(), first = sampleCandidatePlan(profiles);
  const job = manager.createJob({ plan: first, planToken: first.planToken });
  assert.throws(() => { job.targetScope = {}; }, TypeError);
  manager.cancelJob(job.jobId);
  const second = sampleCandidatePlan(profiles);
  const next = manager.createJob({ plan: second, planToken: second.planToken });
  assert.equal(manager.jobs.size, 1);
  assert.equal(manager.jobs.has(job.jobId), false);
  manager.cancelJob(next.jobId);
  next.finishedAt = new Date(Date.now() - 2000).toISOString();
  manager.prune();
  assert.equal(manager.jobs.size, 0);
  assert.equal(manager.activeJobsByTarget.size, 0);
});
