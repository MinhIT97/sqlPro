'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createSourceVerifier } = require('../electron/schema-migration-admission.cjs');
const { computeSchemaFingerprint } = require('../electron/schema-snapshot.cjs');

function sampleProfile(overrides = {}) {
  return {
    id: 'source_profile',
    name: 'Source Production DB',
    host: 'source.internal',
    port: 3306,
    user: 'app_user',
    password: 'secret_password_123',
    readOnly: true,
    environment: 'production',
    ...overrides
  };
}

function sampleScope(profile, overrides = {}) {
  return {
    profileId: profile.id,
    sessionId: 'editor_session_abc123',
    generation: 0,
    database: 'production_crm',
    engine: 'MySQL',
    serverVersion: '8.4.0',
    profileFingerprint: computeSchemaFingerprint(profile),
    snapshotIdentity: 'a'.repeat(64),
    ...overrides
  };
}

function mockDriverSession(options = {}) {
  const events = [];
  const queries = [];
  let closed = false;
  let dead = false;

  const session = {
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
      return { result: [] };
    },
    async close() {
      events.push('close');
      closed = true;
      dead = true;
    }
  };

  return session;
}

test('source verifier connects independent worker, switches database, collects fresh snapshot, and closes worker', async () => {
  const profile = sampleProfile();
  const scope = sampleScope(profile);
  const profiles = { [profile.id]: profile };

  const store = {
    getWithSecrets: id => profiles[id] ? structuredClone(profiles[id]) : null
  };

  let createdSession = null;
  let collectorContext = null;

  const verifier = createSourceVerifier({
    store,
    createSession: prof => {
      createdSession = mockDriverSession();
      createdSession.profile = prof;
      return createdSession;
    },
    createCollector: (session, ctx) => {
      collectorContext = ctx;
      return {
        collect: async db => ({
          kind: 'sqlpro-schema-snapshot',
          version: 1,
          coverage: 'complete',
          database: db,
          snapshotIdentity: scope.snapshotIdentity,
          scope: {
            profileId: ctx.profileId,
            sessionId: ctx.sessionId,
            captureSessionId: ctx.captureSessionId,
            workerSessionId: ctx.workerSessionId,
            generation: ctx.generation,
            profileFingerprint: ctx.profileFingerprint,
            database: db,
            engine: 'MySQL',
            serverVersion: '8.4.0'
          }
        })
      };
    }
  });

  const snapshot = await verifier(scope);

  assert.equal(snapshot.coverage, 'complete');
  assert.equal(snapshot.snapshotIdentity, scope.snapshotIdentity);
  assert.equal(snapshot.database, 'production_crm');

  // Verify independent worker lifecycle
  assert.ok(createdSession);
  assert.deepEqual(createdSession.events, ['connect', 'use:production_crm', 'close']);
  assert.equal(createdSession.closed, true);

  // Verify worker session identity is distinct from bound editor session
  assert.notEqual(collectorContext.sessionId, scope.sessionId);
  assert.equal(collectorContext.sessionId, createdSession.sessionId);
  assert.equal(snapshot.scope.captureSessionId, scope.sessionId);
  assert.equal(snapshot.scope.workerSessionId, collectorContext.sessionId);
  assert.match(snapshot.scope.workerSessionId, /^worker_source_/);
});

test('source verifier rejects schema drift when snapshotIdentity changes', async () => {
  const profile = sampleProfile();
  const scope = sampleScope(profile);
  const store = { getWithSecrets: () => structuredClone(profile) };

  let createdSession = null;
  const verifier = createSourceVerifier({
    store,
    createSession: () => {
      createdSession = mockDriverSession();
      return createdSession;
    },
    createCollector: (session, ctx) => ({
      collect: async db => ({
        coverage: 'complete',
        database: db,
        // Different hash represents schema modified on server
        snapshotIdentity: 'b'.repeat(64),
        scope: { ...ctx, database: db, engine: 'MySQL' }
      })
    })
  });

  await assert.rejects(verifier(scope), {
    code: 'SOURCE_SCHEMA_DRIFT'
  });
  assert.equal(createdSession.closed, true);
});

test('source verifier rejects incomplete, unknown or denied coverage', async () => {
  for (const coverage of ['partial', 'unknown', null, undefined]) {
    const profile = sampleProfile();
    const scope = sampleScope(profile);
    const store = { getWithSecrets: () => structuredClone(profile) };

    let createdSession = null;
    const verifier = createSourceVerifier({
      store,
      createSession: () => {
        createdSession = mockDriverSession();
        return createdSession;
      },
      createCollector: (session, ctx) => ({
        collect: async db => ({
          coverage,
          database: db,
          snapshotIdentity: scope.snapshotIdentity,
          scope: { ...ctx, database: db, engine: 'MySQL' }
        })
      })
    });

    await assert.rejects(verifier(scope), {
      code: 'SOURCE_SCHEMA_INCOMPLETE'
    });
    assert.equal(createdSession.closed, true);
  }
});

test('source verifier rejects profile drift (credential or host change) before and after connect', async () => {
  const profile = sampleProfile();
  const scope = sampleScope(profile);

  // 1. Drift before connect: password was changed in store
  {
    const store = {
      getWithSecrets: () => ({ ...sampleProfile(), password: 'new_password_changed' })
    };
    const verifier = createSourceVerifier({ store });
    await assert.rejects(verifier(scope), { code: 'SOURCE_PROFILE_DRIFT' });
  }

  // 2. Drift after connect: host was modified mid-flight
  {
    const live = sampleProfile();
    const store = { getWithSecrets: () => structuredClone(live) };
    let createdSession = null;
    const verifier = createSourceVerifier({
      store,
      createSession: () => {
        createdSession = mockDriverSession();
        createdSession.connect = async () => { live.host = 'changed.fixture'; };
        return createdSession;
      },
      createCollector: () => ({
        collect: async db => ({
          coverage: 'complete',
          database: db,
          snapshotIdentity: scope.snapshotIdentity
        })
      })
    });

    await assert.rejects(verifier(scope), { code: 'SOURCE_PROFILE_DRIFT' });
    assert.equal(createdSession.closed, true);
  }
});

test('source verifier rejects missing source profile in store', async () => {
  const scope = sampleScope(sampleProfile());
  const store = { getWithSecrets: () => null };
  const verifier = createSourceVerifier({ store });

  await assert.rejects(verifier(scope), {
    code: 'SOURCE_PROFILE_NOT_FOUND'
  });
});

test('cancellation via signal interrupts verifier and closes worker immediately', async () => {
  const profile = sampleProfile();
  const scope = sampleScope(profile);
  const store = { getWithSecrets: () => structuredClone(profile) };

  // 1. Pre-aborted signal
  {
    const controller = new AbortController();
    controller.abort('Cancel before start');
    const verifier = createSourceVerifier({ store });

    await assert.rejects(verifier(scope, { signal: controller.signal }), {
      code: 'QUERY_CANCELED'
    });
  }

  // 2. Abort during collector execution
  {
    const controller = new AbortController();
    let createdSession = null;

    const verifier = createSourceVerifier({
      store,
      createSession: () => {
        createdSession = mockDriverSession();
        return createdSession;
      },
      createCollector: () => ({
        collect: async () => {
          controller.abort('Cancel during collect');
          throw Object.assign(new Error('QUERY_CANCELED'), { code: 'QUERY_CANCELED' });
        }
      })
    });

    await assert.rejects(verifier(scope, { signal: controller.signal }), {
      code: 'QUERY_CANCELED'
    });
    assert.equal(createdSession.closed, true);
    assert.ok(createdSession.events.includes('destroy'));
  }
});

test('worker connection or USE failure closes worker and reports clean error', async () => {
  const profile = sampleProfile();
  const scope = sampleScope(profile);
  const store = { getWithSecrets: () => structuredClone(profile) };

  let createdSession = null;
  const verifier = createSourceVerifier({
    store,
    createSession: () => {
      createdSession = mockDriverSession({ failConnect: true });
      return createdSession;
    }
  });

  await assert.rejects(verifier(scope), /CONNECTION_REFUSED/);
  assert.equal(createdSession.closed, true);
});

function completeProof(scope, ctx, db) {
  return { coverage: 'complete', database: db, snapshotIdentity: scope.snapshotIdentity,
    scope: { ...ctx, database: db, engine: scope.engine, serverVersion: scope.serverVersion } };
}

test('cancel during hung connect closes promptly and destroys a connection that opens late', async () => {
  const profile = sampleProfile(), scope = sampleScope(profile), controller = new AbortController();
  let finish, began;
  const started = new Promise(resolve => { began = resolve; });
  const worker = mockDriverSession();
  let uses = 0;
  worker.connect = () => { began(); return new Promise(resolve => { finish = resolve; }); };
  worker.useDatabase = async () => { uses++; };
  const verifier = createSourceVerifier({ store: { getWithSecrets: () => profile }, createSession: () => worker });
  const pending = verifier(scope, { signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(pending, { code: 'QUERY_CANCELED' });
  assert.equal(worker.closed, true);
  let destroyed = false;
  worker.connection = { destroy: () => { destroyed = true; } };
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(destroyed, true);
  assert.equal(uses, 0);
});

test('timeout covers USE and invalid scopes open no worker; close errors prevent successful verification', async () => {
  const profile = sampleProfile(), scope = sampleScope(profile);
  const worker = mockDriverSession();
  worker.useDatabase = () => new Promise(() => {});
  const verifier = createSourceVerifier({ store: { getWithSecrets: () => profile }, timeoutMs: 20, createSession: () => worker });
  await assert.rejects(verifier(scope), { code: 'QUERY_TIMEOUT' });
  assert.equal(worker.closed, true);
  await assert.rejects(verifier({ ...scope, database: 'bad\0db' }), { code: 'INVALID_SOURCE_SCOPE' });
  const failedClose = mockDriverSession();
  failedClose.close = async () => { throw Error('close failed'); };
  const verifyClose = createSourceVerifier({ store: { getWithSecrets: () => profile }, createSession: () => failedClose,
    createCollector: (_, ctx) => ({ collect: async db => completeProof(scope, ctx, db) }) });
  await assert.rejects(verifyClose(scope), { code: 'SOURCE_WORKER_CLOSE_FAILED' });
});

test('credential drift after USE is detected even when the public policy fingerprint excludes passwords', async () => {
  const profile = sampleProfile();
  const policyFingerprint = p => computeSchemaFingerprint({ id: p.id, host: p.host });
  const scope = sampleScope(profile, { profileFingerprint: policyFingerprint(profile) });
  const worker = mockDriverSession();
  worker.useDatabase = async () => { profile.password = 'changed-password'; };
  let collected = false;
  const verifier = createSourceVerifier({ store: { getWithSecrets: () => structuredClone(profile) },
    fingerprintProfile: policyFingerprint, createSession: () => worker,
    createCollector: () => { collected = true; } });
  await assert.rejects(verifier(scope), { code: 'SOURCE_PROFILE_DRIFT' });
  assert.equal(collected, false);
});

test('real collector and DatabaseSession metadata reads detect column drift across fresh worker captures', async () => {
  const { DatabaseSession } = require('../electron/database.cjs');
  const { SchemaSnapshotCollector } = require('../electron/schema-snapshot.cjs');
  const profile = sampleProfile(), scope = sampleScope(profile);
  let changed = false, queries = 0, workers = 0;
  class Session extends DatabaseSession {
    constructor() { super(profile); this.version = '8.4.0'; workers++; }
    async connect() { this.connection = {}; }
    async close() { this.connection = null; this.dead = true; }
    async raw(sql) {
      queries++;
      if (sql.includes("COLUMN_NAME IN ('EXPRESSION'")) return { result: [] };
      if (sql.includes('information_schema.TABLES')) return { result: [{ name: 'users', type: 'BASE TABLE', engine: 'InnoDB' }] };
      if (sql.includes('information_schema.COLUMNS')) return { result: [{ name: 'id', type: changed ? 'bigint' : 'int', nullable: 'NO', position: 1 }] };
      return { result: [] };
    }
  }
  const baseline = new Session();
  await baseline.connect();
  const original = await new SchemaSnapshotCollector(baseline, scope).collect(scope.database);
  assert.equal(original.coverage, 'complete', JSON.stringify(original.warnings));
  scope.snapshotIdentity = original.snapshotIdentity;
  const verifier = createSourceVerifier({ store: { getWithSecrets: () => structuredClone(profile) }, createSession: () => new Session() });
  const before = queries;
  const first = await verifier(scope);
  const after = queries;
  assert.ok(after > before);
  assert.notEqual(first.scope.sessionId, scope.sessionId);
  assert.equal(first.scope.captureSessionId, scope.sessionId);
  assert.equal((await verifier(scope)).snapshotIdentity, first.snapshotIdentity);
  assert.ok(queries > after);
  changed = true;
  await assert.rejects(verifier(scope), { code: 'SOURCE_SCHEMA_DRIFT' });
  assert.equal(workers, 4);
  await baseline.close();
});
