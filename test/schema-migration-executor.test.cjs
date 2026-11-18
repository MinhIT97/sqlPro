'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SchemaMigrationExecutor, planDigest } = require('../electron/schema-migration-executor.cjs');
const { computeSchemaFingerprint } = require('../electron/schema-snapshot.cjs');

function fixture(overrides = {}) {
  const token = 'f'.repeat(64), queries = [], events = [];
  const profiles = {
    source: { id: 'source', host: 'source.fixture', readOnly: true, environment: 'local' },
    target: { id: 'target', host: 'target.fixture', readOnly: false, environment: 'local' }
  };
  const scope = id => ({ profileId: id, database: 'sample', sessionId: `editor-${id}`, generation: 0,
    engine: 'MySQL', snapshotIdentity: (id === 'source' ? 'a' : 'b').repeat(64), profileFingerprint: computeSchemaFingerprint(profiles[id]) });
  const plan = { planId: 'plan-fixture', planToken: token, status: 'ready', applySupported: true,
    expiresAt: Date.now() + 60000, sourceScope: scope('source'), targetScope: scope('target'),
    options: { wrapForeignKeys: false }, statements: [
      { id: 's1', sql: 'CREATE TABLE users (id INT)', type: 'CREATE_TABLE', status: 'executable', enabled: true },
      { id: 's2', sql: 'ALTER TABLE users ADD COLUMN email TEXT', type: 'ADD_COLUMN', status: 'executable', enabled: true }
    ] };
  const proof = scope => ({ database: scope.database, scope: { ...scope }, coverage: 'complete', snapshotIdentity: scope.snapshotIdentity });
  let created = 0, closed = 0, destroyed = 0;
  const worker = { connection: { destroy() { destroyed++; } },
    async connect() { events.push('connect'); }, async useDatabase(db) { events.push(`use:${db}`); },
    async close() { closed++; }, async raw(sql) {
      queries.push(sql);
      return { result: sql.startsWith('SELECT @@SESSION') ? [{ fkChecks: 1, autocommit: 1 }] : [] };
    }
  };
  const options = {
    consumePlan: async () => plan,
    getProfileWithSecrets: id => profiles[id], fingerprintProfile: computeSchemaFingerprint,
    checkContext: async () => true, verifySource: async s => proof(s),
    createSession: p => { created++; assert.equal(p.id, 'target'); return worker; },
    createCollector: (session, ctx) => {
      assert.equal(ctx.sessionId, session.sessionId);
      assert.notEqual(ctx.sessionId, plan.targetScope.sessionId);
      return { collect: async () => ({ ...proof(plan.targetScope), scope: { ...plan.targetScope, sessionId: ctx.sessionId } }) };
    }, ...overrides
  };
  const executor = new SchemaMigrationExecutor(options);
  return { token, plan, profiles, queries, events, worker, options, executor, proof,
    counts: () => ({ created, closed, destroyed }), run: extra => executor.executePlan({ planToken: token, ...extra }) };
}

test('executor rejects caller plans, missing Main hooks, preview/disabled statements and FK override before creating workers', async () => {
  const empty = new SchemaMigrationExecutor();
  await assert.rejects(empty.executePlan({ planToken: 'f'.repeat(64) }), { code: 'MIGRATION_ADMISSION_REQUIRED' });
  await assert.rejects(empty.executePlan({ plan: {} }), { code: 'CALLER_PLAN_REJECTED' });
  for (const variant of ['preview', 'disabled', 'blocked', 'fk', 'duplicate', 'expired', 'timeout']) {
    const r = fixture();
    if (variant === 'preview') r.plan.status = 'preview';
    if (variant === 'disabled') r.plan.statements[1].enabled = false;
    if (variant === 'blocked') r.plan.statements[0].status = 'blocked';
    if (variant === 'fk') r.plan.options.wrapForeignKeys = true;
    if (variant === 'duplicate') r.plan.statements[1].id = 's1';
    if (variant === 'expired') r.plan.expiresAt = Date.now() - 1;
    if (variant === 'timeout') r.plan.options.statementTimeoutMs = Infinity;
    await assert.rejects(r.run());
    assert.equal(r.counts().created, 0, variant);
  }
});

test('unknown DDL driver errors are uncertain, while a failed precondition read has not dispatched DDL', async () => {
  for (const precondition of [false, true]) {
    const r = fixture(), raw = r.worker.raw;
    if (precondition) r.plan.statements[0].preCondition = { checkSql: 'SELECT precondition_marker', expectedCount: 0 };
    r.worker.raw = sql => {
      if (sql.includes('precondition_marker') || !sql.startsWith('SELECT')) throw Object.assign(new Error('unknown driver result'), { code: 'DRIVER_CUSTOM_ERROR' });
      return raw(sql);
    };
    await assert.rejects(r.run(), err => err.code === 'DRIVER_CUSTOM_ERROR' && err.executionUncertain === !precondition && err.partialCommit === !precondition && err.executedCount === 0);
  }
});

test('profile drift during a precondition blocks the DDL and a hung observer cannot retain the worker', async () => {
  const r = fixture(), raw = r.worker.raw;
  r.plan.statements[0].preCondition = { checkSql: 'SELECT precondition_marker', expectedCount: 0 };
  r.worker.raw = async sql => {
    if (sql.includes('precondition_marker')) { r.profiles.target.host = 'changed'; return { result: [] }; }
    return raw(sql);
  };
  await assert.rejects(r.run(), { code: 'MIGRATION_CONTEXT_CHANGED' });
  assert.equal(r.queries.some(sql => /^CREATE|^ALTER/.test(sql)), false);
  const observer = fixture();
  assert.equal((await observer.run({ onProgress: () => new Promise(() => {}) })).success, true);
  assert.equal(observer.counts().closed, 1);
});

test('token is reserved before admission awaits and cannot replay even after failure', async () => {
  let resolve;
  const r = fixture({ consumePlan: () => new Promise(done => { resolve = done; }) });
  const pending = r.run();
  await assert.rejects(r.run(), { code: 'MIGRATION_TOKEN_USED' });
  resolve({ ...r.plan, status: 'blocked' });
  await assert.rejects(pending, { code: 'MIGRATION_PLAN_BLOCKED' });
  await assert.rejects(r.run(), { code: 'MIGRATION_TOKEN_USED' });
  assert.equal(r.counts().created, 0);
});

test('admitted plan is detached and progress observers cannot mutate ledger or cause a false failed DDL', async () => {
  const r = fixture();
  const result = await r.run({ onProgress: event => {
    event.currentStatement.status = 'failed';
    r.plan.statements[1].sql = 'DROP DATABASE unrelated';
    throw new Error('Observer failed');
  } });
  assert.equal(result.executedCount, 2);
  assert.ok(result.ledger.every(entry => entry.status === 'executed'));
  assert.ok(!r.queries.some(sql => sql.includes('DROP DATABASE')));
  assert.ok(!r.queries.some(sql => sql.startsWith('SET ')));
  assert.equal(result.observerWarnings.length, 2);
  assert.equal(r.counts().closed, 1);
});

test('a worker rejecting with no error object never becomes a successful DDL', async () => {
  const r = fixture(), raw = r.worker.raw;
  r.worker.raw = sql => sql.startsWith('SELECT') ? raw(sql) : Promise.reject(null);
  await assert.rejects(r.run(), err => {
    assert.equal(err.code, 'MIGRATION_EXECUTION_FAILED');
    assert.equal(err.executionUncertain, true);
    assert.equal(err.executedCount, 0);
    assert.equal(err.ledger[0].status, 'uncertain');
    return true;
  });
  assert.equal(r.counts().closed, 1);
});

test('async progress failures are contained; cancellation during the final notification retains executed DDL', async () => {
  const r = fixture();
  const result = await r.run({ onProgress: async () => { throw new Error('Async observer failed'); } });
  assert.equal(result.executedCount, 2);
  assert.deepEqual(result.observerWarnings, ['PROGRESS_CALLBACK_FAILED', 'PROGRESS_CALLBACK_FAILED']);
  const cancelled = fixture(), controller = new AbortController();
  await assert.rejects(cancelled.run({ signal: controller.signal, onProgress: async ({ executedCount }) => {
    if (executedCount === 2) { await Promise.resolve(); controller.abort(); }
  } }), err => {
    assert.equal(err.code, 'QUERY_CANCELED');
    assert.equal(err.executedCount, 2);
    assert.ok(err.ledger.every(entry => entry.status === 'executed'));
    assert.equal(err.executionUncertain, false);
    assert.equal(err.partialCommit, true);
    return true;
  });
  assert.equal(cancelled.counts().closed, 1);
});

test('pre-aborted jobs perform no admission or database work', async () => {
  let consumed = false;
  const r = fixture({ consumePlan: async () => { consumed = true; } }), controller = new AbortController();
  controller.abort();
  await assert.rejects(r.run({ signal: controller.signal }), { code: 'QUERY_CANCELED' });
  assert.equal(consumed, false);
  assert.equal(r.counts().created, 0);
});

test('authoritative profile drift, unverified context and read-only changes across await stop writes', async () => {
  for (const variant of ['host', 'read-only', 'context']) {
    const r = fixture();
    let called = false;
    r.options.checkContext = async () => {
      if (!called) {
        called = true;
        if (variant === 'host') r.profiles.target.host = 'other.fixture';
        if (variant === 'read-only') r.profiles.target.readOnly = true;
      }
      return variant !== 'context';
    };
    await assert.rejects(r.run());
    assert.equal(r.counts().created, 0, variant);
    assert.equal(r.queries.length, 0);
  }
});

test('Production approval must be a Main-issued receipt bound to exact plan, target and expiry', async () => {
  for (const variant of ['missing', 'wrong-plan', 'expired', 'valid']) {
    const r = fixture();
    r.profiles.target.environment = 'production';
    r.plan.targetScope.profileFingerprint = computeSchemaFingerprint(r.profiles.target);
    if (variant !== 'missing') r.options.authorizeProduction = async ({ plan, planDigest: digest }) => ({
      planToken: plan.planToken, planDigest: variant === 'wrong-plan' ? '0'.repeat(64) : digest,
      targetProfileFingerprint: plan.targetScope.profileFingerprint,
      expiresAt: variant === 'expired' ? Date.now() - 1 : plan.expiresAt
    });
    if (variant === 'valid') assert.equal((await r.run({ approvalToken: 'receipt-token' })).success, true);
    else { await assert.rejects(r.run({ approvalToken: 'unrelated' })); assert.equal(r.counts().created, 0, variant); }
  }
});

test('fresh source/target proof and safe worker settings are required, including a second source check before DDL', async () => {
  for (const variant of ['source', 'source-late', 'source-session', 'target', 'target-session', 'target-engine', 'incomplete', 'fk-zero', 'setting-missing']) {
    const r = fixture();
    let sourceReads = 0;
    r.options.verifySource = async s => {
      sourceReads++;
      const proof = r.proof(s);
      if (variant === 'source' || variant === 'source-late' && sourceReads > 1) proof.snapshotIdentity = '0'.repeat(64);
      if (variant === 'source-session') proof.scope.sessionId = 'stale-session';
      return proof;
    };
    r.executor.createCollector = (_, ctx) => ({ collect: async () => ({ ...r.proof(r.plan.targetScope), scope: { ...r.plan.targetScope, sessionId: ctx.sessionId },
      ...(variant === 'target' ? { snapshotIdentity: '0'.repeat(64) } : {}),
      ...(variant === 'target-session' ? { scope: { ...r.plan.targetScope, sessionId: 'stale-session' } } : {}),
      ...(variant === 'target-engine' ? { scope: { ...r.plan.targetScope, sessionId: ctx.sessionId, engine: 'MariaDB' } } : {}),
      ...(variant === 'incomplete' ? { coverage: 'partial' } : {}) }) });
    if (variant === 'fk-zero') r.worker.raw = async sql => { r.queries.push(sql); return { result: [{ fkChecks: 0, autocommit: 1 }] }; };
    if (variant === 'setting-missing') r.worker.raw = async sql => { r.queries.push(sql); return { result: [] }; };
    await assert.rejects(r.run());
    assert.ok(r.queries.every(sql => sql.startsWith('SELECT')), variant);
    assert.equal(r.counts().closed, r.counts().created, variant);
  }
});

test('SQL errors stop remaining statements; timeout on the first DDL is reported uncertain, not rolled back', async () => {
  for (const mode of ['server-error', 'first-timeout']) {
    const r = fixture();
    const raw = r.worker.raw;
    r.plan.statements.push({ ...r.plan.statements[1], id: 's3', sql: 'ALTER TABLE users ADD COLUMN phone TEXT' });
    r.worker.raw = async sql => {
      if (sql.startsWith('SELECT')) return raw(sql);
      r.queries.push(sql);
      if (mode === 'first-timeout' || sql.includes('email')) throw Object.assign(new Error('driver failure'), {
        code: mode === 'first-timeout' ? 'PROTOCOL_SEQUENCE_TIMEOUT' : 'ER_PARSE_ERROR'
      });
      return { result: [] };
    };
    await assert.rejects(r.run(), err => {
      assert.equal(err.partialCommit, true);
      assert.equal(err.executedCount, mode === 'first-timeout' ? 0 : 1);
      assert.equal(err.executionUncertain, mode === 'first-timeout');
      assert.equal(err.ledger[0].status, mode === 'first-timeout' ? 'uncertain' : 'executed');
      assert.equal(err.ledger[2].status, 'not_run');
      return true;
    });
    assert.ok(!r.queries.some(sql => sql.includes('phone')));
    assert.equal(r.counts().closed, 1);
  }
});

test('cancelling a hung DDL destroys/closes its worker, marks uncertainty and prevents later statements', async () => {
  const r = fixture(), controller = new AbortController();
  let began;
  const started = new Promise(resolve => { began = resolve; });
  const raw = r.worker.raw;
  r.worker.raw = async sql => {
    if (sql.startsWith('SELECT')) return raw(sql);
    r.queries.push(sql);
    began();
    return new Promise(() => {});
  };
  const pending = r.run({ signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(pending, err => {
    assert.equal(err.code, 'QUERY_CANCELED');
    assert.equal(err.executionUncertain, true);
    assert.equal(err.partialCommit, true);
    assert.equal(err.ledger[1].status, 'cancelled');
    return true;
  });
  assert.equal(r.counts().destroyed, 1);
  assert.equal(r.counts().closed, 1);
  assert.equal(r.queries.filter(sql => !sql.startsWith('SELECT')).length, 1);
});

test('profile changes after a successful DDL retain executed ledger and stop subsequent DDL', async () => {
  const r = fixture();
  const raw = r.worker.raw;
  r.worker.raw = async sql => {
    const result = await raw(sql);
    if (sql.startsWith('CREATE')) r.profiles.source.host = 'changed-source.fixture';
    return result;
  };
  await assert.rejects(r.run(), err => {
    assert.equal(err.executedCount, 1);
    assert.equal(err.ledger[0].status, 'executed');
    assert.equal(err.ledger[1].status, 'not_run');
    return true;
  });
  assert.ok(!r.queries.some(sql => sql.startsWith('ALTER')));
});

test('worker close failure is reported and plan digest binds SQL as well as target', async () => {
  const r = fixture();
  r.worker.close = async () => { throw Error('close failed'); };
  await assert.rejects(r.run(), err => {
    assert.equal(err.cleanupError, 'MIGRATION_WORKER_CLOSE_FAILED');
    assert.equal(err.executedCount, 2);
    assert.equal(err.partialCommit, true);
    return true;
  });
  const original = planDigest(r.plan);
  r.plan.statements[0].sql = 'DROP DATABASE sample';
  assert.notEqual(planDigest(r.plan), original);
});

test('cancel during target connect or collector stops promptly and closes worker; source verifier receives signal', async () => {
  for (const phase of ['connect', 'use', 'collect']) {
    const r = fixture(), controller = new AbortController();
    let began, finish;
    const started = new Promise(resolve => { began = resolve; });
    const pendingPhase = () => { began(); return new Promise(resolve => { finish = resolve; }); };
    r.options.verifySource = async (scope, options) => { assert.equal(options.signal, controller.signal); return r.proof(scope); };
    if (phase === 'connect') r.worker.connect = pendingPhase;
    else if (phase === 'use') r.worker.useDatabase = pendingPhase;
    else r.executor.createCollector = () => ({ collect: pendingPhase });
    const pending = r.run({ signal: controller.signal });
    await started;
    controller.abort();
    await assert.rejects(pending, { code: 'QUERY_CANCELED' });
    assert.equal(r.counts().closed, 1);
    assert.ok(r.queries.every(sql => sql.startsWith('SELECT')));
    finish(r.proof(r.plan.targetScope));
    await new Promise(resolve => setImmediate(resolve));
  }
});

test('worker deadline interrupts a hung DDL and reports uncertain execution without retry', async () => {
  const r = fixture();
  r.plan.options.statementTimeoutMs = 15;
  const raw = r.worker.raw;
  r.worker.raw = sql => {
    if (sql.startsWith('SELECT')) return raw(sql);
    r.queries.push(sql);
    return new Promise(() => {});
  };
  await assert.rejects(r.run(), err => {
    assert.equal(err.code, 'QUERY_TIMEOUT');
    assert.equal(err.executionUncertain, true);
    assert.equal(err.partialCommit, true);
    assert.equal(err.ledger[0].status, 'uncertain');
    assert.equal(err.ledger[1].status, 'not_run');
    return true;
  });
  assert.equal(r.counts().closed, 1);
});
