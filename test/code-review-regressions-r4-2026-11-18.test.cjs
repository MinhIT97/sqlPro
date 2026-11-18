'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');

const { RestorePlanService } = require('../electron/restore-plan-service.cjs');
const { RestoreSelectionExecutor } = require('../electron/restore-selection-executor.cjs');
const { DatabaseSession } = require('../electron/database.cjs');
const { parseAlterRename, parseSetAssignments, evaluateAutocommit } = require('../electron/sql-script.cjs');

test('U01: Literal in COMMENT does not trick ALTER RENAME parser; cross-db destination blocked with 0 writes across Main VM', async () => {
  const root = path.resolve(__dirname, '..');
  const fixtureText = fs.readFileSync(path.join(root, 'test/main-schema-migration.test.cjs'), 'utf8');
  const body = fixtureText.slice(fixtureText.indexOf('function fixture()'), fixtureText.indexOf('\ntest('));
  const fixture = new Function('require', 'path', 'vm', 'fs', 'crypto', 'DatabaseSession', '__dirname', body + ';return fixture;')(
    require('node:module').createRequire(path.join(root, 'test/main-schema-migration.test.cjs')),
    path,
    vm,
    fs,
    crypto,
    DatabaseSession,
    path.join(root, 'test')
  );

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-u01-'));
  try {
    const dump = path.join(tmp, 'backup.sql');
    const create = 'CREATE TABLE `users` (`id` int PRIMARY KEY); ';
    const alter = "ALTER TABLE `users` COMMENT='RENAME TO users ignored', RENAME TO `other_db`.`victim`;";
    fs.writeFileSync(dump, create + alter);

    // 1. Verify parser extracts the real destination and ignores literal inside COMMENT
    const parsed = parseAlterRename(alter);
    assert.ok(parsed);
    assert.deepEqual(parsed.source, { schema: null, name: 'users' });
    assert.deepEqual(parsed.destination, { schema: 'other_db', name: 'victim' });
    assert.deepEqual(parsed.destinations, [{ schema: 'other_db', name: 'victim' }]);

    // 2. Verify planner blocks the cross-database ALTER
    const r = fixture();
    r.profiles.p = { id: 'p', name: 'Local DB', environment: 'local', readOnly: false };
    r.evaluate(`
      restorePlanService.createSession = () => ({
        async connect() {},
        async close() {},
        async collectRestoreTargetFacts(database) { return { database, objects: [], errors: [] }; }
      });
      globalThis.u01Queries = [];
      restoreSelectionExecutor.createSession = () => ({
        async connect() {},
        async close() {},
        async useDatabase() {},
        async raw(sql) {
          if (sql.startsWith('SELECT @@SESSION.foreign_key_checks')) return { result: [{ foreignKeys: 1, sqlMode: '', autocommit: 1 }] }; globalThis.u01Queries.push(sql); return { result: [] }; }
      });
    `);

    const planService = r.evaluate('restorePlanService');
    const plan = await planService.createSelectiveRestorePlan({
      filePath: dump,
      targetProfileId: 'p',
      targetDatabase: 'sample',
      selection: { tables: ['users'] }
    });
    assert.equal(plan.status, 'blocked');
    assert.ok(plan.blockers?.some(b => b.code === 'RESTORE_CROSS_DATABASE_BLOCKED'));

    // 3. Verify Main VM apply handler rejects and executes 0 queries
    const response = await r.call('db:apply-selective-restore-plan', { planToken: plan.planToken, profileId: 'p' });
    assert.equal(response.ok, false);
    assert.equal(response.error?.code, 'RESTORE_PLAN_BLOCKED');
    const queries = r.evaluate('globalThis.u01Queries');
    assert.equal(queries.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('U02: AUTOCOMMIT quoted identifier and parenthesized expression track state and block uncommitted writes', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-u02-'));
  try {
    const dump = path.join(tmp, 'backup.sql');
    let profile = { id: 'p', readOnly: false };
    const store = { getWithSecrets: () => profile };
    const metadataSession = () => ({
      async connect() {},
      async close() {},
      async collectRestoreTargetFacts(database) {
        return { database, objects: [{ type: 'table', name: 'users' }], errors: [] };
      }
    });
    const service = new RestorePlanService({ store, fingerprintProfile: () => 'fp', createSession: metadataSession });

    const runPlan = async (sql) => {
      fs.writeFileSync(dump, sql);
      const plan = await service.createSelectiveRestorePlan({
        filePath: dump,
        targetProfileId: 'p',
        targetDatabase: 'sample',
        selection: { tables: ['users'] }
      });
      const queries = [];
      const worker = {
        async connect() {},
        async useDatabase() {},
        async close() {},
        async raw(query) { if (query.startsWith('SELECT @@SESSION.foreign_key_checks')) return { result: [{ foreignKeys: 1, sqlMode: '', autocommit: 1 }] }; queries.push(query); return { result: [] }; }
      };
      const executor = new RestoreSelectionExecutor({
        consumePlan: t => service.consumePlan(t),
        getProfileWithSecrets: store.getWithSecrets,
        fingerprintProfile: () => 'fp',
        createSession: () => worker
      });
      try {
        const result = await executor.executePlan({ planToken: plan.planToken });
        return { success: true, result, queries };
      } catch (err) {
        return { success: false, code: err.code, err, queries };
      }
    };

    // 1. Quoted identifier: SET `AUTOCOMMIT`=0 without COMMIT must fail
    const r1 = await runPlan('CREATE TABLE `users` (`id` int PRIMARY KEY); SET `AUTOCOMMIT`=0; INSERT INTO `users` VALUES (1);');
    assert.equal(r1.success, false);
    assert.equal(r1.code, 'RESTORE_UNCOMMITTED_TRANSACTION');

    // 2. Parenthesized expression: SET AUTOCOMMIT=(0) without COMMIT must fail
    const r2 = await runPlan('CREATE TABLE `users` (`id` int PRIMARY KEY); SET AUTOCOMMIT=(0); INSERT INTO `users` VALUES (1);');
    assert.equal(r2.success, false);
    assert.equal(r2.code, 'RESTORE_UNCOMMITTED_TRANSACTION');

    // 3. Quoted with COMMIT must succeed
    const r3 = await runPlan('CREATE TABLE `users` (`id` int PRIMARY KEY); SET `AUTOCOMMIT`=0; INSERT INTO `users` VALUES (1); COMMIT;');
    assert.equal(r3.success, true);
    assert.equal(r3.result.success, true);

    // 4. Unknown/complex expression: SET AUTOCOMMIT=(1 + 0) must be rejected fail-closed
    const r4 = await runPlan('CREATE TABLE `users` (`id` int PRIMARY KEY); SET AUTOCOMMIT=(1 + 0); INSERT INTO `users` VALUES (1);');
    assert.equal(r4.success, false);
    assert.equal(r4.code, 'RESTORE_PLAN_BLOCKED');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('U03: Pre-stream DROP records targetChanged: true on context drift; lost first DML ACK sets uncertainty; IPC projects outcome', async () => {
  const root = path.resolve(__dirname, '..');
  const fixtureText = fs.readFileSync(path.join(root, 'test/main-schema-migration.test.cjs'), 'utf8');
  const body = fixtureText.slice(fixtureText.indexOf('function fixture()'), fixtureText.indexOf('\ntest('));
  const fixture = new Function('require', 'path', 'vm', 'fs', 'crypto', 'DatabaseSession', '__dirname', body + ';return fixture;')(
    require('node:module').createRequire(path.join(root, 'test/main-schema-migration.test.cjs')),
    path,
    vm,
    fs,
    crypto,
    DatabaseSession,
    path.join(root, 'test')
  );

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-u03-'));
  try {
    const dump = path.join(tmp, 'backup.sql');
    let profile = { id: 'p', readOnly: false };
    const store = { getWithSecrets: () => profile };
    const metadataSession = () => ({
      async connect() {},
      async close() {},
      async collectRestoreTargetFacts(database) {
        return { database, objects: [{ type: 'table', name: 'users' }], errors: [] };
      }
    });
    const service = new RestorePlanService({ store, fingerprintProfile: () => 'fp', createSession: metadataSession });

    // 1. DROP then context drift: pre-stream DROP executed, then profile becomes readOnly
    fs.writeFileSync(dump, 'CREATE TABLE `users` (`id` int PRIMARY KEY);');
    const plan1 = await service.createSelectiveRestorePlan({
      filePath: dump,
      targetProfileId: 'p',
      targetDatabase: 'sample',
      selection: { tables: ['users'] },
      dropExisting: true
    });
    const queries = [];
    const worker1 = {
      async connect() {},
      async useDatabase() {},
      async close() {},
      async raw(sql) {
          if (sql.startsWith('SELECT @@SESSION.foreign_key_checks')) return { result: [{ foreignKeys: 1, sqlMode: '', autocommit: 1 }] };
        queries.push(sql);
        if (sql.startsWith('DROP TABLE IF EXISTS')) {
          profile = { id: 'p', readOnly: true };
        }
        return { result: [] };
      }
    };
    const executor1 = new RestoreSelectionExecutor({
      consumePlan: t => service.consumePlan(t),
      getProfileWithSecrets: store.getWithSecrets,
      fingerprintProfile: () => 'fp',
      createSession: () => worker1
    });

    let err1 = null;
    try {
      await executor1.executePlan({ planToken: plan1.planToken });
    } catch (e) {
      err1 = e;
    }
    assert.ok(err1);
    assert.equal(err1.code, 'CONNECTION_READ_ONLY');
    assert.equal(err1.targetChanged, true);
    assert.equal(err1.partialCommit, true);
    assert.equal(err1.executedCount, 1);

    // 2. First DML lost ACK: data-only plan, first INSERT throws ECONNRESET -> uncertain
    profile = { id: 'p', readOnly: false };
    fs.writeFileSync(dump, 'INSERT INTO `users` VALUES (1);');
    const plan2 = await service.createSelectiveRestorePlan({
      filePath: dump,
      targetProfileId: 'p',
      targetDatabase: 'sample',
      selection: { tables: ['users'], includeStructure: false }
    });
    const worker2 = {
      async connect() {},
      async useDatabase() {},
      async close() {},
      async raw(sql) {
          if (sql.startsWith('SELECT @@SESSION.foreign_key_checks')) return { result: [{ foreignKeys: 1, sqlMode: '', autocommit: 1 }] };
        if (sql.startsWith('INSERT')) {
          throw Object.assign(new Error('lost INSERT acknowledgement'), { code: 'ECONNRESET' });
        }
        return { result: [] };
      }
    };
    const executor2 = new RestoreSelectionExecutor({
      consumePlan: t => service.consumePlan(t),
      getProfileWithSecrets: store.getWithSecrets,
      fingerprintProfile: () => 'fp',
      createSession: () => worker2
    });

    let err2 = null;
    try {
      await executor2.executePlan({ planToken: plan2.planToken });
    } catch (e) {
      err2 = e;
    }
    assert.ok(err2);
    assert.equal(err2.code, 'ECONNRESET');
    assert.equal(err2.executionUncertain, true);
    assert.equal(err2.targetChanged, true);
    assert.equal(err2.partialCommit, true);

    // 3. Main IPC projection test: error outcomes forwarded to renderer
    const r = fixture();
    r.profiles.p = { id: 'p', name: 'Local DB', environment: 'local', readOnly: false };
    fs.writeFileSync(dump, 'CREATE TABLE `users` (`id` int PRIMARY KEY);');
    r.evaluate(`
      restorePlanService.createSession = () => ({
        async connect() {},
        async close() {},
        async collectRestoreTargetFacts(database) { return { database, objects: [], errors: [] }; }
      });
      restoreSelectionExecutor.createSession = () => ({
        async connect() {},
        async close() {},
        async useDatabase() {},
        async raw(sql) {
          if (sql.startsWith('SELECT @@SESSION.foreign_key_checks')) return { result: [{ foreignKeys: 1, sqlMode: '', autocommit: 1 }] };
          if (sql.startsWith('CREATE')) {
            throw Object.assign(new Error('lost CREATE acknowledgement'), { code: 'ECONNRESET' });
          }
          return { result: [] };
        }
      });
    `);

    const mainPlan = await r.evaluate('restorePlanService').createSelectiveRestorePlan({
      filePath: dump,
      targetProfileId: 'p',
      targetDatabase: 'sample',
      selection: { tables: ['users'] }
    });
    const ipcResponse = await r.call('db:apply-selective-restore-plan', {
      planToken: mainPlan.planToken,
      profileId: 'p'
    });
    assert.equal(ipcResponse.ok, false);
    assert.equal(ipcResponse.error?.code, 'ECONNRESET');
    assert.equal(ipcResponse.error?.targetChanged, true);
    assert.equal(ipcResponse.error?.partialCommit, true);
    assert.equal(ipcResponse.error?.executionUncertain, true);
    assert.equal(ipcResponse.error?.executedCount, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('U04: Worker lifecycle guard enforces cancellation and statement deadline across connect and raw queries', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-u04-'));
  try {
    const dump = path.join(tmp, 'backup.sql');
    fs.writeFileSync(dump, 'CREATE TABLE `users` (`id` int PRIMARY KEY);');

    const profile = { id: 'p', readOnly: false };
    const store = { getWithSecrets: () => profile };
    const metadataSession = () => ({
      async connect() {},
      async close() {},
      async collectRestoreTargetFacts(database) {
        return { database, objects: [{ type: 'table', name: 'users' }], errors: [] };
      }
    });
    const service = new RestorePlanService({ store, fingerprintProfile: () => 'fp', createSession: metadataSession });

    // 1. Cancellation during hung connect: must settle immediately without waiting for test release
    let releaseConnect, entered;
    const connectStarted = new Promise(resolve => { entered = resolve; });
    const plan1 = await service.createSelectiveRestorePlan({
      filePath: dump,
      targetProfileId: 'p',
      targetDatabase: 'sample',
      selection: { tables: ['users'] }
    });
    const worker1 = {
      async connect() {
        entered();
        return new Promise(resolve => { releaseConnect = resolve; });
      },
      async useDatabase() {},
      async close() {},
      async raw(sql) {
          if (sql.startsWith('SELECT @@SESSION.foreign_key_checks')) return { result: [{ foreignKeys: 1, sqlMode: '', autocommit: 1 }] }; return { result: [] }; }
    };
    const executor1 = new RestoreSelectionExecutor({
      consumePlan: t => service.consumePlan(t),
      getProfileWithSecrets: store.getWithSecrets,
      fingerprintProfile: () => 'fp',
      createSession: () => worker1
    });

    const controller = new AbortController();
    const pendingConnect = executor1.executePlan({ planToken: plan1.planToken, signal: controller.signal });
    await connectStarted;
    controller.abort();

    const settledBeforeRelease = await Promise.race([
      pendingConnect.then(() => true, () => true),
      new Promise(resolve => setTimeout(() => resolve(false), 80))
    ]);
    releaseConnect();
    assert.equal(settledBeforeRelease, true, 'Cancellation during connect must settle before slow connect finishes');

    let cancelErr = null;
    try {
      await pendingConnect;
    } catch (e) {
      cancelErr = e;
    }
    assert.ok(cancelErr);
    assert.equal(cancelErr.code, 'QUERY_CANCELED');

    // 2. Statement deadline: raw query timing out must settle within deadline
    let releaseDdl, ddlEntered;
    const ddlStarted = new Promise(resolve => { ddlEntered = resolve; });
    const plan2 = await service.createSelectiveRestorePlan({
      filePath: dump,
      targetProfileId: 'p',
      targetDatabase: 'sample',
      selection: { tables: ['users'] }
    });
    const worker2 = {
      async connect() {},
      async useDatabase() {},
      async close() {},
      async raw(sql) {
          if (sql.startsWith('SELECT @@SESSION.foreign_key_checks')) return { result: [{ foreignKeys: 1, sqlMode: '', autocommit: 1 }] };
        if (sql.startsWith('CREATE')) {
          ddlEntered();
          return new Promise(resolve => { releaseDdl = resolve; });
        }
        return { result: [] };
      }
    };
    const executor2 = new RestoreSelectionExecutor({
      consumePlan: t => service.consumePlan(t),
      getProfileWithSecrets: store.getWithSecrets,
      fingerprintProfile: () => 'fp',
      createSession: () => worker2,
      statementTimeoutMs: 15
    });

    const pendingDdl = executor2.executePlan({ planToken: plan2.planToken });
    await ddlStarted;

    const settledAfterDeadline = await Promise.race([
      pendingDdl.then(() => true, () => true),
      new Promise(resolve => setTimeout(() => resolve(false), 80))
    ]);
    releaseDdl({ result: [] });
    assert.equal(settledAfterDeadline, true, 'Hung DDL query must settle when statement deadline expires');

    let timeoutErr = null;
    try {
      await pendingDdl;
    } catch (e) {
      timeoutErr = e;
    }
    assert.ok(timeoutErr);
    assert.equal(timeoutErr.code, 'STATEMENT_TIMEOUT');
    assert.equal(timeoutErr.executionUncertain, true);
    assert.equal(timeoutErr.targetChanged, true);
    assert.equal(timeoutErr.partialCommit, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
