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
const { BackupReplicaManager } = require('../electron/backup-replica-manager.cjs');
const { DatabaseSession } = require('../electron/database.cjs');
const { parseAlterRename, parseRenameTable } = require('../electron/sql-script.cjs');

test('T01: Production approval fails closed on missing, invalid, or expired tokens', async () => {
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-t01-'));
  try {
    const dump = path.join(tmp, 'prod.sql');
    fs.writeFileSync(dump, 'CREATE TABLE `users` (`id` int PRIMARY KEY); INSERT INTO `users` VALUES (1);');

    const r = fixture();
    r.profiles.prod = { id: 'prod', name: 'Production DB', environment: 'production', readOnly: false };

    r.evaluate(`
      restorePlanService.createSession = () => ({
        async connect() {},
        async close() {},
        async collectRestoreTargetFacts(database) { return { database, objects: [], errors: [] }; }
      });
      globalThis.t01Queries = [];
      restoreSelectionExecutor.createSession = () => ({
        async connect() {},
        async useDatabase() {},
        async close() {},
        async raw(sql) {
          if (sql.startsWith('SELECT @@SESSION.foreign_key_checks')) return { result: [{ foreignKeys: 1, sqlMode: '', autocommit: 1 }] }; globalThis.t01Queries.push(sql); return { result: [] }; }
      });
    `);

    const planService = r.evaluate('restorePlanService');
    const prodPlan = await planService.createSelectiveRestorePlan({
      filePath: dump,
      targetProfileId: 'prod',
      targetDatabase: 'sample',
      selection: { tables: ['users'] }
    });
    assert.equal(prodPlan.status, 'ready');

    // 1. Calling without approval token MUST fail closed with PRODUCTION_APPROVAL_REQUIRED
    const resultNoToken = await r.call('db:apply-selective-restore-plan', {
      planToken: prodPlan.planToken,
      profileId: 'prod',
      taskId: 't01-no-token'
    });
    assert.equal(resultNoToken.ok, false);
    assert.equal(resultNoToken.error?.code, 'PRODUCTION_APPROVAL_REQUIRED');

    // Queries executed must be strictly 0
    const queries = r.evaluate('globalThis.t01Queries');
    assert.equal(queries.length, 0);

    // 2. Calling with invalid/random approval token MUST fail closed
    const prodPlan2 = await planService.createSelectiveRestorePlan({
      filePath: dump,
      targetProfileId: 'prod',
      targetDatabase: 'sample',
      selection: { tables: ['users'] }
    });
    const resultBadToken = await r.call('db:apply-selective-restore-plan', {
      planToken: prodPlan2.planToken,
      approvalToken: 'invalid_token_xyz',
      profileId: 'prod',
      taskId: 't01-bad-token'
    });
    assert.equal(resultBadToken.ok, false);
    assert.equal(resultBadToken.error?.code, 'PRODUCTION_APPROVAL_REQUIRED');
    assert.equal(r.evaluate('globalThis.t01Queries').length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('T02: ALTER TABLE RENAME to another schema is blocked during preflight and execution', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-t02-'));
  try {
    const dump = path.join(tmp, 'cross-rename.sql');
    fs.writeFileSync(dump, 'CREATE TABLE `users` (`id` int PRIMARY KEY); ALTER TABLE `users` RENAME TO `other_db`.`victim`;');

    const store = { getWithSecrets: () => ({ id: 'p', readOnly: false }) };
    const metadataSession = () => ({
      async connect() {},
      async close() {},
      async collectRestoreTargetFacts(database) { return { database, objects: [], errors: [] }; }
    });
    const service = new RestorePlanService({ store, fingerprintProfile: () => 'fp', createSession: metadataSession });

    const plan = await service.createSelectiveRestorePlan({
      filePath: dump,
      targetProfileId: 'p',
      targetDatabase: 'sample',
      selection: { tables: ['users'] }
    });

    // Plan must be blocked because the dump attempts cross-database write
    assert.equal(plan.status, 'blocked');
    assert.equal(plan.canExecute, false);
    const hasBlocker = plan.blockers.some(f => f.code === 'RESTORE_CROSS_DATABASE_BLOCKED');
    assert.ok(hasBlocker, 'Expected RESTORE_CROSS_DATABASE_BLOCKED finding in plan');

    // Executor must also reject blocked plan
    const executor = new RestoreSelectionExecutor({
      consumePlan: t => service.consumePlan(t),
      getProfileWithSecrets: store.getWithSecrets,
      fingerprintProfile: () => 'fp',
      createSession: () => ({ async connect() {}, async useDatabase() {}, async close() {}, async raw(sql) {
          if (sql.startsWith('SELECT @@SESSION.foreign_key_checks')) return { result: [{ foreignKeys: 1, sqlMode: '', autocommit: 1 }] }; return { result: [] }; } })
    });

    await assert.rejects(
      () => executor.executePlan({ planToken: plan.planToken }),
      err => err.code === 'RESTORE_PLAN_BLOCKED'
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('T02: Strict exact-case table isolation prevents executing mismatched casing statements', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-t02-case-'));
  try {
    const dump = path.join(tmp, 'case.sql');
    fs.writeFileSync(dump, 'CREATE TABLE `users` (`id` int PRIMARY KEY); INSERT INTO `Users` VALUES (1);');

    const store = { getWithSecrets: () => ({ id: 'p', readOnly: false }) };
    const metadataSession = () => ({
      async connect() {},
      async close() {},
      async collectRestoreTargetFacts(database) { return { database, objects: [], errors: [] }; }
    });
    const service = new RestorePlanService({ store, fingerprintProfile: () => 'fp', createSession: metadataSession });

    const plan = await service.createSelectiveRestorePlan({
      filePath: dump,
      targetProfileId: 'p',
      targetDatabase: 'sample',
      selection: { tables: ['users'] }
    });
    assert.equal(plan.status, 'ready');

    const executedSql = [];
    const executor = new RestoreSelectionExecutor({
      consumePlan: t => service.consumePlan(t),
      getProfileWithSecrets: store.getWithSecrets,
      fingerprintProfile: () => 'fp',
      createSession: () => ({
        async connect() {},
        async useDatabase() {},
        async close() {},
        async raw(sql) {
          if (sql.startsWith('SELECT @@SESSION.foreign_key_checks')) return { result: [{ foreignKeys: 1, sqlMode: '', autocommit: 1 }] }; executedSql.push(sql); return { result: [] }; }
      })
    });

    const result = await executor.executePlan({ planToken: plan.planToken });
    assert.equal(result.success, true);
    assert.equal(result.executedCount, 1);
    assert.equal(result.skippedCount, 1);

    // Only CREATE TABLE `users` was executed; INSERT INTO `Users` was skipped
    assert.ok(executedSql.some(s => s.includes('CREATE TABLE `users`')));
    assert.ok(!executedSql.some(s => s.includes('INSERT INTO `Users`')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('T03: Transaction tracking detects AUTOCOMMIT=FALSE and COMMIT AND CHAIN without final commit', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-t03-'));
  try {
    const store = { getWithSecrets: () => ({ id: 'p', readOnly: false }) };
    const metadataSession = () => ({
      async connect() {},
      async close() {},
      async collectRestoreTargetFacts(database) { return { database, objects: [], errors: [] }; }
    });
    const service = new RestorePlanService({ store, fingerprintProfile: () => 'fp', createSession: metadataSession });

    // 1. AUTOCOMMIT=FALSE with uncommitted INSERT
    const dumpAutocommit = path.join(tmp, 'autocommit.sql');
    fs.writeFileSync(dumpAutocommit, 'CREATE TABLE `users` (`id` int PRIMARY KEY); SET AUTOCOMMIT=FALSE; INSERT INTO `users` VALUES (1);');
    const p1 = await service.createSelectiveRestorePlan({
      filePath: dumpAutocommit,
      targetProfileId: 'p',
      targetDatabase: 'sample',
      selection: { tables: ['users'] }
    });
    const exec1 = new RestoreSelectionExecutor({
      consumePlan: t => service.consumePlan(t),
      getProfileWithSecrets: store.getWithSecrets,
      fingerprintProfile: () => 'fp',
      createSession: () => ({ async connect() {}, async useDatabase() {}, async close() {}, async raw(sql) {
          if (sql.startsWith('SELECT @@SESSION.foreign_key_checks')) return { result: [{ foreignKeys: 1, sqlMode: '', autocommit: 1 }] }; return { result: [] }; } })
    });
    await assert.rejects(
      () => exec1.executePlan({ planToken: p1.planToken }),
      err => err.code === 'RESTORE_UNCOMMITTED_TRANSACTION' && err.partialCommit === true
    );

    // 2. COMMIT AND CHAIN with subsequent uncommitted INSERT
    const dumpChain = path.join(tmp, 'chain.sql');
    fs.writeFileSync(dumpChain, 'CREATE TABLE `users` (`id` int PRIMARY KEY); START TRANSACTION; INSERT INTO `users` VALUES (1); COMMIT AND CHAIN; INSERT INTO `users` VALUES (2);');
    const p2 = await service.createSelectiveRestorePlan({
      filePath: dumpChain,
      targetProfileId: 'p',
      targetDatabase: 'sample',
      selection: { tables: ['users'] }
    });
    const exec2 = new RestoreSelectionExecutor({
      consumePlan: t => service.consumePlan(t),
      getProfileWithSecrets: store.getWithSecrets,
      fingerprintProfile: () => 'fp',
      createSession: () => ({ async connect() {}, async useDatabase() {}, async close() {}, async raw(sql) {
          if (sql.startsWith('SELECT @@SESSION.foreign_key_checks')) return { result: [{ foreignKeys: 1, sqlMode: '', autocommit: 1 }] }; return { result: [] }; } })
    });
    await assert.rejects(
      () => exec2.executePlan({ planToken: p2.planToken }),
      err => err.code === 'RESTORE_UNCOMMITTED_TRANSACTION' && err.partialCommit === true
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('T04: In-flight DDL error sets executionUncertain, partialCommit, and targetChanged', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-t04-'));
  try {
    const dump = path.join(tmp, 'ddl-timeout.sql');
    fs.writeFileSync(dump, 'CREATE TABLE `users` (`id` int PRIMARY KEY);');

    const store = { getWithSecrets: () => ({ id: 'p', readOnly: false }) };
    const metadataSession = () => ({
      async connect() {},
      async close() {},
      async collectRestoreTargetFacts(database) { return { database, objects: [], errors: [] }; }
    });
    const service = new RestorePlanService({ store, fingerprintProfile: () => 'fp', createSession: metadataSession });
    const plan = await service.createSelectiveRestorePlan({
      filePath: dump,
      targetProfileId: 'p',
      targetDatabase: 'sample',
      selection: { tables: ['users'] }
    });

    const executor = new RestoreSelectionExecutor({
      consumePlan: t => service.consumePlan(t),
      getProfileWithSecrets: store.getWithSecrets,
      fingerprintProfile: () => 'fp',
      createSession: () => ({
        async connect() {},
        async useDatabase() {},
        async close() {},
        async raw(sql) {
          if (sql.startsWith('SELECT @@SESSION.foreign_key_checks')) return { result: [{ foreignKeys: 1, sqlMode: '', autocommit: 1 }] };
          if (sql.startsWith('CREATE')) {
            throw Object.assign(new Error('lost DDL acknowledgement'), { code: 'ECONNRESET' });
          }
          return { result: [] };
        }
      })
    });

    await assert.rejects(
      () => executor.executePlan({ planToken: plan.planToken }),
      err => {
        assert.equal(err.code, 'ECONNRESET');
        assert.equal(err.executionUncertain, true);
        assert.equal(err.partialCommit, true);
        assert.equal(err.targetChanged, true);
        return true;
      }
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('T05: Replica publication no-replace preserves concurrent file without overwriting', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-t05-'));
  try {
    const srcDir = path.join(tmp, 'src');
    const dstDir = path.join(tmp, 'dst');
    fs.mkdirSync(srcDir);
    fs.mkdirSync(dstDir);

    const src = path.join(srcDir, 'backup.sql');
    const dst = path.join(dstDir, 'backup.sql');
    fs.writeFileSync(src, 'NEW BACKUP DATA');

    const manager = new BackupReplicaManager({ maxRetries: 1 });
    const copy = manager.copyAtomic.bind(manager);

    // Simulate concurrent file appearing after target path calculation but before copyAtomic publication
    manager.copyAtomic = async (s, d, exp, opts) => {
      fs.writeFileSync(d, 'CONCURRENT VALUABLE BACKUP');
      return copy(s, d, exp, opts);
    };

    const replica = await manager.createReplica({
      sourceFilePath: src,
      destinationDir: dstDir,
      overwrite: false
    });

    assert.equal(replica.verified, true);
    // Original destination file must be completely preserved!
    assert.equal(fs.readFileSync(dst, 'utf8'), 'CONCURRENT VALUABLE BACKUP');
    // New replica must be allocated at a unique non-conflicting path
    assert.notEqual(replica.replicaPath, dst);
    assert.equal(fs.readFileSync(replica.replicaPath, 'utf8'), 'NEW BACKUP DATA');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
