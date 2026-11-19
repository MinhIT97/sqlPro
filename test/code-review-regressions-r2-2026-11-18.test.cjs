'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const { RestorePlanService } = require('../electron/restore-plan-service.cjs');
const { RestoreSelectionExecutor } = require('../electron/restore-selection-executor.cjs');
const { BackupReplicaManager } = require('../electron/backup-replica-manager.cjs');
const { DataSyncPlanService, computePlanDigest } = require('../electron/data-sync-plan-service.cjs');
const { DataSyncExecutor } = require('../electron/data-sync-executor.cjs');

test('S01: Selective Restore blocks multi-object DROP with unselected/cross-database targets and exact-case schema mismatch', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-s01-'));
  try {
    const dump = path.join(tmp, 'multidrop.sql');
    const store = { getWithSecrets: () => ({ id: 'p', readOnly: false }) };
    const service = new RestorePlanService({
      store,
      fingerprintProfile: () => 'fp',
      createSession: () => ({
        async connect() {},
        async close() {},
        async collectRestoreTargetFacts(database) { return { database, objects: [], errors: [] }; }
      })
    });

    // 1. Multi-drop targeting external db or unselected table
    const create = 'CREATE TABLE `users` (`id` int PRIMARY KEY); ';
    fs.writeFileSync(dump, create + 'DROP TABLE `users`, `other_db`.`victim`;');

    const plan = await service.createSelectiveRestorePlan({
      filePath: dump,
      targetProfileId: 'p',
      targetDatabase: 'sample',
      selection: { tables: ['users'] },
      dropExisting: true
    });

    assert.equal(plan.status, 'blocked');
    assert.equal(plan.canExecute, false);

    const queries = [];
    const executor = new RestoreSelectionExecutor({
      consumePlan: t => service.consumePlan(t),
      getProfileWithSecrets: store.getWithSecrets,
      fingerprintProfile: () => 'fp',
      createSession: () => ({
        async connect() {},
        async useDatabase() {},
        async raw(sql) {
          if (sql.startsWith('SELECT @@SESSION.foreign_key_checks')) return { result: [{ foreignKeys: 1, sqlMode: '', autocommit: 1 }] }; queries.push(sql); return { result: [] }; },
        async close() {}
      })
    });

    await assert.rejects(
      () => executor.executePlan({ planToken: plan.planToken }),
      err => err.code === 'RESTORE_PLAN_BLOCKED'
    );
    assert.equal(queries.length, 0, 'Zero queries should be executed for blocked multiDrop plan');

    // 2. Case-sensitive database mismatch
    fs.writeFileSync(dump, create + 'INSERT INTO `SAMPLE`.`users` VALUES (1);');
    const planCase = await service.createSelectiveRestorePlan({
      filePath: dump,
      targetProfileId: 'p',
      targetDatabase: 'sample',
      selection: { tables: ['users'] }
    });
    assert.equal(planCase.status, 'blocked');
    await assert.rejects(
      () => executor.executePlan({ planToken: planCase.planToken }),
      err => err.code === 'RESTORE_PLAN_BLOCKED'
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('S02: RestoreSelectionExecutor detects late file modification and prevents TOCTOU tampering', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-s02-'));
  try {
    const dump = path.join(tmp, 'dump.sql');
    const create = 'CREATE TABLE `users` (`id` int PRIMARY KEY); ';
    fs.writeFileSync(dump, create + 'INSERT INTO `users` VALUES (1);');

    const store = { getWithSecrets: () => ({ id: 'p', readOnly: false }) };
    const service = new RestorePlanService({
      store,
      fingerprintProfile: () => 'fp',
      createSession: () => ({
        async connect() {},
        async close() {},
        async collectRestoreTargetFacts(database) { return { database, objects: [], errors: [] }; }
      })
    });

    const plan = await service.createSelectiveRestorePlan({
      filePath: dump,
      targetProfileId: 'p',
      targetDatabase: 'sample',
      selection: { tables: ['users'] }
    });
    assert.equal(plan.status, 'ready');

    const queries = [];
    const executor = new RestoreSelectionExecutor({
      consumePlan: t => service.consumePlan(t),
      getProfileWithSecrets: store.getWithSecrets,
      fingerprintProfile: () => 'fp',
      createSession: () => ({
        async connect() {
          // Attacker swaps/alters file right after connect
          fs.writeFileSync(dump, create + 'INSERT INTO `users` VALUES (9);');
        },
        async useDatabase() {},
        async raw(sql) {
          if (sql.startsWith('SELECT @@SESSION.foreign_key_checks')) return { result: [{ foreignKeys: 1, sqlMode: '', autocommit: 1 }] }; queries.push(sql); return { result: [] }; },
        async close() {}
      })
    });

    await assert.rejects(
      () => executor.executePlan({ planToken: plan.planToken }),
      err => err.code === 'RESTORE_FILE_CHANGED'
    );

    // Verify tampered query was NEVER issued
    assert.equal(queries.some(q => q.includes('VALUES (9)')), false, 'Tampered SQL statement must never be executed');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('S03: RestoreSelectionExecutor verifies autocommit and uncommitted writes before reporting success', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-s03-'));
  try {
    const dump = path.join(tmp, 'autocommit.sql');
    const create = 'CREATE TABLE `users` (`id` int PRIMARY KEY); ';
    // Dump sets AUTOCOMMIT=0 and inserts row, but never issues COMMIT
    fs.writeFileSync(dump, create + 'SET AUTOCOMMIT=0; INSERT INTO `users` VALUES (1);');

    const store = { getWithSecrets: () => ({ id: 'p', readOnly: false }) };
    const service = new RestorePlanService({
      store,
      fingerprintProfile: () => 'fp',
      createSession: () => ({
        async connect() {},
        async close() {},
        async collectRestoreTargetFacts(database) { return { database, objects: [], errors: [] }; }
      })
    });

    const plan = await service.createSelectiveRestorePlan({
      filePath: dump,
      targetProfileId: 'p',
      targetDatabase: 'sample',
      selection: { tables: ['users'] }
    });
    assert.equal(plan.status, 'ready');

    const queries = [];
    const executor = new RestoreSelectionExecutor({
      consumePlan: t => service.consumePlan(t),
      getProfileWithSecrets: store.getWithSecrets,
      fingerprintProfile: () => 'fp',
      createSession: () => ({
        async connect() {},
        async useDatabase() {},
        async raw(sql) {
          if (sql.startsWith('SELECT @@SESSION.foreign_key_checks')) return { result: [{ foreignKeys: 1, sqlMode: '', autocommit: 1 }] }; queries.push(sql); return { result: [] }; },
        async close() {}
      })
    });

    await assert.rejects(
      () => executor.executePlan({ planToken: plan.planToken }),
      err => err.code === 'RESTORE_UNCOMMITTED_TRANSACTION'
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('S04: Profile read-only drift during connection halts execution immediately with zero writes', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-s04-'));
  try {
    const dump = path.join(tmp, 'drift.sql');
    const create = 'CREATE TABLE `users` (`id` int PRIMARY KEY); ';
    fs.writeFileSync(dump, create + 'INSERT INTO `users` VALUES (1);');

    let currentProfile = { id: 'p', readOnly: false };
    const store = { getWithSecrets: () => currentProfile };
    const service = new RestorePlanService({
      store,
      fingerprintProfile: p => JSON.stringify(p),
      createSession: () => ({
        async connect() {},
        async close() {},
        async collectRestoreTargetFacts(database) { return { database, objects: [], errors: [] }; }
      })
    });

    const plan = await service.createSelectiveRestorePlan({
      filePath: dump,
      targetProfileId: 'p',
      targetDatabase: 'sample',
      selection: { tables: ['users'] }
    });

    const queries = [];
    const executor = new RestoreSelectionExecutor({
      consumePlan: t => service.consumePlan(t),
      getProfileWithSecrets: store.getWithSecrets,
      fingerprintProfile: p => JSON.stringify(p),
      createSession: () => ({
        async connect() {
          currentProfile = { id: 'p', readOnly: true };
        },
        async useDatabase() {},
        async raw(sql) {
          if (sql.startsWith('SELECT @@SESSION.foreign_key_checks')) return { result: [{ foreignKeys: 1, sqlMode: '', autocommit: 1 }] }; queries.push(sql); return { result: [] }; },
        async close() {}
      })
    });

    await assert.rejects(
      () => executor.executePlan({ planToken: plan.planToken }),
      err => err.code === 'CONNECTION_READ_ONLY' || err.code === 'POLICY_READ_ONLY' || err.code === 'TARGET_CONTEXT_DRIFT'
    );

    assert.equal(queries.some(q => q.includes('CREATE TABLE') || q.includes('INSERT INTO')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('S05: BackupReplicaManager preserves existing backup file in destinationDir when overwrite is false', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-s05-'));
  try {
    const srcDir = path.join(tmp, 'source');
    const destDir = path.join(tmp, 'replica');
    fs.mkdirSync(srcDir);
    fs.mkdirSync(destDir);

    const src = path.join(srcDir, 'backup.sql');
    const dest = path.join(destDir, 'backup.sql');
    fs.writeFileSync(src, 'NEW BACKUP DATA');
    fs.writeFileSync(dest, 'EXISTING VALUABLE BACKUP');

    const manager = new BackupReplicaManager({ maxRetries: 1 });
    const rep = await manager.createReplica({
      sourceFilePath: src,
      destinationDir: destDir,
      overwrite: false
    });

    assert.equal(rep.verified, true);
    // Original destination file must be completely preserved!
    assert.equal(fs.readFileSync(dest, 'utf8'), 'EXISTING VALUABLE BACKUP');
    // New replica should be published to a unique non-conflicting path
    assert.notEqual(rep.replicaPath, dest);
    assert.equal(fs.readFileSync(rep.replicaPath, 'utf8'), 'NEW BACKUP DATA');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('S07: DataSyncPlanService deep-freezes operations and scopes; input mutations do not affect plan', () => {
  const syncService = new DataSyncPlanService();
  const scope = { profileId: 'tgt', database: 'sample', table: 'users' };
  const draft = syncService.createSyncPlan({
    sourceScope: { ...scope, profileId: 'src' },
    targetScope: scope,
    diffReport: { primaryKeys: ['id'], columns: [{ name: 'id', type: 'int' }], onlyInSource: [{ rowKey: '1', row: { id: 1 } }] }
  });

  // Mutate caller input scope
  scope.database = 'mutated_database';

  const syncPlan = syncService.consumePlan(draft.planToken);
  assert.equal(Object.isFrozen(syncPlan), true);
  assert.equal(Object.isFrozen(syncPlan.operations[0]), true);
  assert.equal(syncPlan.targetScope.database, 'sample', 'Target database must stay intact regardless of caller mutation');
  assert.equal(syncPlan.planDigest, computePlanDigest(syncPlan));
});

test('S08: DataSyncExecutor handles async onProgress rejections safely without unhandledRejection', async () => {
  const syncService = new DataSyncPlanService();
  const scope = { profileId: 'p', database: 'sample', table: 'users' };
  const draft = syncService.createSyncPlan({
    sourceScope: { ...scope, profileId: 'src' },
    targetScope: scope,
    diffReport: { primaryKeys: ['id'], columns: [{ name: 'id', type: 'int' }], onlyInSource: [{ rowKey: '1', row: { id: 1 } }] }
  });

  const syncPlan = syncService.consumePlan(draft.planToken);

  let unhandledOccurred = false;
  const onUnhandled = () => { unhandledOccurred = true; };
  process.on('unhandledRejection', onUnhandled);

  try {
    const executor = new DataSyncExecutor({
      consumePlan: () => syncPlan,
      getProfileWithSecrets: () => ({ id: 'p', readOnly: false }),
      createSession: () => ({
        async connect() {},
        async useDatabase() {},
        async listColumns() { return [{ name: 'id', type: 'int', key: 'PRI' }]; },
        async raw(sql) {
          if (sql.includes('SELECT ENGINE FROM')) return { result: [{ ENGINE: 'InnoDB' }] };
          if (sql.includes('SELECT TRIGGER_NAME FROM')) return { result: [] };
          return { result: { affectedRows: 1 } };
        },
        async close() {}
      })
    });

    const res = await executor.executeSyncPlan({
      planToken: 'test-token',
      onProgress: async () => {
        throw new Error('Async progress observer error');
      }
    });

    assert.equal(res.success, true);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(unhandledOccurred, false, 'Async observer error must be safely caught and not leak unhandledRejection');
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});
