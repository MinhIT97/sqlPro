'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const { DataSyncPlanService, computePlanDigest } = require('../electron/data-sync-plan-service.cjs');
const { DataSyncExecutor } = require('../electron/data-sync-executor.cjs');
const { RestorePlanService } = require('../electron/restore-plan-service.cjs');
const { RestoreSelectionExecutor } = require('../electron/restore-selection-executor.cjs');
const { encryptBackupFile, decryptBackupFile } = require('../electron/backup-crypto.cjs');
const { BackupReplicaManager } = require('../electron/backup-replica-manager.cjs');
const { TableKeysetReader } = require('../electron/data-diff-reader.cjs');
const { compareKeysetStreams } = require('../electron/data-diff-service.cjs');
const { SchemaMigrationGenerator } = require('../electron/schema-migration-generator.cjs');
const { computeSchemaFingerprint } = require('../electron/schema-snapshot.cjs');

test('R04: BackupReplicaManager rejects identical source/destination and preserves original source', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-r04-'));
  try {
    const source = path.join(tmp, 'source.sql');
    fs.writeFileSync(source, 'SELECT 1;');
    const manager = new BackupReplicaManager({ maxRetries: 1 });

    await assert.rejects(
      () => manager.createReplica({ sourceFilePath: source, destinationDir: tmp }),
      err => err.code === 'REPLICA_TARGET_CONFLICT'
    );

    // Assert source file is preserved intact
    assert.strictEqual(fs.existsSync(source), true);
    assert.strictEqual(fs.readFileSync(source, 'utf8'), 'SELECT 1;');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('R05: decryptBackupFile with wrong password does not delete pre-existing destination file', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-r05-'));
  try {
    const source = path.join(tmp, 'source.sql');
    const enc = path.join(tmp, 'source.enc');
    const dest = path.join(tmp, 'existing.sql');
    fs.writeFileSync(source, 'SELECT 1;');
    fs.writeFileSync(dest, 'DO NOT DELETE');

    await encryptBackupFile(source, enc, { passphrase: 'correct-password-123' });

    await assert.rejects(
      () => decryptBackupFile(enc, dest, { passphrase: 'wrong-password-456' }),
      err => err.code === 'BACKUP_DECRYPTION_FAILED'
    );

    // Destination must still exist and contain original content
    assert.strictEqual(fs.existsSync(dest), true);
    assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'DO NOT DELETE');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('R02: RestoreSelectionExecutor rejects SET GLOBAL and cross-database SQL', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-r02-'));
  try {
    const dumpGlobal = path.join(tmp, 'global.sql');
    fs.writeFileSync(dumpGlobal, 'SET GLOBAL max_connections=999; CREATE TABLE `users` (`id` int PRIMARY KEY);');
    const store = { getWithSecrets: () => ({ id: 'p', readOnly: false }) };
    const service = new RestorePlanService({
      store,
      fingerprintProfile: () => 'fp',
      createSession: () => ({ async connect() {}, async close() {}, async collectRestoreTargetFacts(database) { return { database, objects: [], errors: [] }; } })
    });

    const planGlobal = await service.createSelectiveRestorePlan({
      filePath: dumpGlobal,
      targetProfileId: 'p',
      targetDatabase: 'sample',
      selection: { tables: ['users'] }
    });

    assert.equal(planGlobal.status, 'blocked');
    assert.ok(planGlobal.blockers.some(b => b.code === 'RESTORE_CONTEXT_UNSUPPORTED'));
    const executor = new RestoreSelectionExecutor({
      consumePlan: t => service.consumePlan(t),
      getProfileWithSecrets: store.getWithSecrets,
      fingerprintProfile: () => 'fp',
      createSession: () => ({ async connect() {}, async close() {}, async useDatabase() {}, async raw(sql) {
          if (sql.startsWith('SELECT @@SESSION.foreign_key_checks')) return { result: [{ foreignKeys: 1, sqlMode: '', autocommit: 1 }] }; return { result: [] }; } })
    });

    await assert.rejects(
      () => executor.executePlan({ planToken: planGlobal.planToken }),
      err => err.code === 'RESTORE_PLAN_BLOCKED'
    );

    // Cross-database statement
    const dumpCross = path.join(tmp, 'cross.sql');
    fs.writeFileSync(dumpCross, 'CREATE TABLE `users` (`id` int PRIMARY KEY); INSERT INTO `other_db`.`users` VALUES (1);');
    const planCross = await service.createSelectiveRestorePlan({
      filePath: dumpCross,
      targetProfileId: 'p',
      targetDatabase: 'sample',
      selection: { tables: ['users'] }
    });

    await assert.rejects(
      () => executor.executePlan({ planToken: planCross.planToken }),
      err => err.code === 'RESTORE_CROSS_DATABASE_BLOCKED' || err.code === 'RESTORE_PLAN_BLOCKED'
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('R03: RestoreSelectionExecutor rejects tampered backup file where checksum changed', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-r03-'));
  try {
    const dump = path.join(tmp, 'tamper.sql');
    const original = 'CREATE TABLE `users` (`id` int PRIMARY KEY); INSERT INTO `users` VALUES (1);';
    const changed = original.replace('VALUES (1)', 'VALUES (9)');
    fs.writeFileSync(dump, original);

    const store = { getWithSecrets: () => ({ id: 'p', readOnly: false }) };
    const service = new RestorePlanService({
      store,
      fingerprintProfile: () => 'fp',
      createSession: () => ({ async connect() {}, async close() {}, async collectRestoreTargetFacts(database) { return { database, objects: [], errors: [] }; } })
    });

    const plan = await service.createSelectiveRestorePlan({
      filePath: dump,
      targetProfileId: 'p',
      targetDatabase: 'sample',
      selection: { tables: ['users'] }
    });

    // Tamper with file content while keeping identical file size and mtime
    const statBefore = fs.statSync(dump);
    fs.writeFileSync(dump, changed);
    fs.utimesSync(dump, statBefore.atime, statBefore.mtime);

    const writes = [];
    const executor = new RestoreSelectionExecutor({
      consumePlan: t => service.consumePlan(t),
      getProfileWithSecrets: store.getWithSecrets,
      fingerprintProfile: () => 'fp',
      createSession: () => ({ async connect() {}, async close() {}, async useDatabase() {}, async raw(sql) {
          if (sql.startsWith('SELECT @@SESSION.foreign_key_checks')) return { result: [{ foreignKeys: 1, sqlMode: '', autocommit: 1 }] }; writes.push(sql); return { result: [] }; } })
    });

    await assert.rejects(
      () => executor.executePlan({ planToken: plan.planToken }),
      err => err.code === 'RESTORE_FILE_CHANGED'
    );

    // Assert zero writes were issued
    assert.strictEqual(writes.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function makeSnapshot(profileId, dbName = 'sample', tables = []) {
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
      profileFingerprint: 'a'.repeat(64),
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

function makeTable(name, columns = [], indexes = [], foreignKeys = []) {
  return {
    name,
    engine: 'InnoDB',
    charset: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
    comment: '',
    rowCount: 0,
    dataLength: 0,
    columns: columns.map(c => ({
      name: c.name,
      type: c.type || 'varchar(255)',
      nullable: c.nullable !== false,
      defaultValue: c.defaultValue ?? null,
      extra: c.extra || '',
      comment: '',
      isGenerated: false,
      coverageStatus: 'complete',
      migrationStatus: 'executable'
    })),
    indexes: indexes.map(i => ({
      name: i.name,
      isPrimary: Boolean(i.isPrimary),
      isUnique: Boolean(i.isUnique),
      type: i.type || 'BTREE',
      comment: '',
      coverageStatus: 'complete',
      migrationStatus: 'executable',
      columns: i.columns.map((c, idx) => ({
        name: typeof c === 'string' ? c : c.name,
        seq: idx + 1,
        order: c.order || 'ASC',
        subPart: null,
        expression: null
      }))
    })),
    foreignKeys,
    coverageStatus: 'complete',
    foreignKeysStatus: 'complete',
    migrationStatus: 'executable'
  };
}

test('R10: SchemaMigrationGenerator preserves FULLTEXT and SPATIAL indexes', () => {
  const gen = new SchemaMigrationGenerator();
  const cols = [{ name: 'id', type: 'int', nullable: false }, { name: 'body', type: 'text', nullable: true }];
  const pk = { name: 'PRIMARY', isPrimary: true, isUnique: true, columns: [{ name: 'id' }] };
  const fulltext = { name: 'ft_body', type: 'FULLTEXT', isUnique: false, columns: [{ name: 'body' }] };

  const sourceSnapshot = makeSnapshot('src', 'sample', [makeTable('users', cols, [pk, fulltext])]);
  const targetSnapshot = makeSnapshot('tgt', 'sample', [makeTable('users', cols, [pk])]);

  const plan = gen.generateMigrationPlan({ sourceSnapshot, targetSnapshot });
  assert.strictEqual(plan.status, 'ready');
  assert.strictEqual(plan.statements.length, 1);
  assert.strictEqual(plan.statements[0].sql, 'ALTER TABLE `users` ADD FULLTEXT KEY `ft_body` (`body`);');
  assert.strictEqual(plan.statements[0].postCondition.indexType, 'FULLTEXT');
});

test('R11: Data diff keyset reader and service do not mistake reaching quota for complete', async () => {
  const cappedReader = () => {
    const reader = new TableKeysetReader({ async raw() { return { rows: [{ id: 1 }] }; } }, 'sample', 'users', { maxRows: 1 });
    reader.columns = [{ name: 'id', type: 'int' }];
    reader.primaryKeys = ['id'];
    reader.pkTypes = ['int'];
    return reader;
  };

  const report = await compareKeysetStreams({
    sourceReader: cappedReader(),
    targetReader: cappedReader(),
    rowLimit: 10
  });

  // Because readers hit quota (maxRows = 1), coverage.complete must be FALSE
  assert.strictEqual(report.coverage.complete, false);
});

test('R06: DataSyncExecutor guards originalValues on DELETE and UPDATE', async () => {
  const plan = {
    planToken: 'token_1',
    planDigest: 'digest_1',
    expiresAt: Date.now() + 60000,
    targetScope: { profileId: 'tgt', database: 'sample', table: 'users', profileFingerprint: 'fp' },
    columns: [{ name: 'id', type: 'int' }, { name: 'value', type: 'varchar(20)' }],
    primaryKeys: ['id'],
    operations: [{
      type: 'DELETE',
      table: 'users',
      rowKey: '1',
      pkValues: [1],
      originalValues: { id: 1, value: 'old_value' }
    }]
  };

  const queries = [];
  const executor = new DataSyncExecutor({
    consumePlan: () => plan,
    getProfileWithSecrets: () => ({ id: 'tgt', readOnly: false }),
    fingerprintProfile: () => 'fp',
    createSession: () => ({
      async connect() {},
      async useDatabase() {},
      async listColumns() { return [{ name: 'id', type: 'int', key: 'PRI' }, { name: 'value', type: 'varchar(20)', key: '' }]; },
      async raw(sql, params) {
        if (sql.includes('SELECT ENGINE FROM')) return { result: [{ ENGINE: 'InnoDB' }] };
        if (sql.includes('SELECT TRIGGER_NAME FROM')) return { result: [] };
        queries.push({ sql, params });
        // Return 0 affected rows to simulate row was modified concurrently
        if (sql.startsWith('DELETE')) return { result: { affectedRows: 0 } };
        return { result: { affectedRows: 1 } };
      },
      async close() {}
    })
  });

  await assert.rejects(
    () => executor.executeSyncPlan({ planToken: 'token_1' }),
    err => err.code === 'SYNC_CONFLICT_DETECTED'
  );

  // Assert DELETE query included both PK and originalValues
  const deleteQuery = queries.find(q => q.sql.startsWith('DELETE'));
  assert.ok(deleteQuery);
  assert.strictEqual(deleteQuery.sql, 'DELETE FROM `sample`.`users` WHERE `id` = ? AND `value` = ?');
  assert.deepStrictEqual(deleteQuery.params, [1, 'old_value']);
});

test('R07: DataSyncExecutor handles lost COMMIT ACK with partialCommit=true and executionUncertain=true', async () => {
  const plan = {
    planToken: 'token_2',
    planDigest: 'digest_2',
    expiresAt: Date.now() + 60000,
    targetScope: { profileId: 'tgt', database: 'sample', table: 'users', profileFingerprint: 'fp' },
    columns: [{ name: 'id', type: 'int' }],
    primaryKeys: ['id'],
    operations: [{
      type: 'INSERT',
      table: 'users',
      rowKey: '2',
      pkValues: [2],
      values: { id: 2 }
    }]
  };

  const executor = new DataSyncExecutor({
    consumePlan: () => plan,
    getProfileWithSecrets: () => ({ id: 'tgt', readOnly: false }),
    fingerprintProfile: () => 'fp',
    createSession: () => ({
      async connect() {},
      async useDatabase() {},
      async listColumns() { return [{ name: 'id', type: 'int', key: 'PRI' }]; },
      async raw(sql) {
        if (sql.includes('SELECT ENGINE FROM')) return { result: [{ ENGINE: 'InnoDB' }] };
        if (sql.includes('SELECT TRIGGER_NAME FROM')) return { result: [] };
          if (sql.startsWith('SELECT @@SESSION.foreign_key_checks')) return { result: [{ foreignKeys: 1, sqlMode: '', autocommit: 1 }] };
        if (sql === 'COMMIT') throw Object.assign(new Error('commit acknowledgement lost'), { code: 'ECONNRESET' });
        return { result: { affectedRows: 1 } };
      },
      async close() {}
    })
  });

  await assert.rejects(
    () => executor.executeSyncPlan({ planToken: 'token_2' }),
    err => {
      assert.strictEqual(err.code, 'ECONNRESET');
      assert.strictEqual(err.partialCommit, true);
      assert.strictEqual(err.executionUncertain, true);
      return true;
    }
  );
});

test('R01 & syncDigestOmitsTable: changing operation table changes plan digest', () => {
  const service = new DataSyncPlanService();
  const plan = {
    sourceScope: { profileId: 'src', database: 'sample', table: 'users' },
    targetScope: { profileId: 'tgt', database: 'sample', table: 'users' },
    primaryKeys: ['id'],
    columns: [{ name: 'id', type: 'int' }],
    counts: { total: 1 },
    direction: 'source-to-target',
    operations: [{
      table: 'users',
      type: 'INSERT',
      rowKey: '1',
      pkValues: [1],
      values: { id: 1 }
    }]
  };

  const before = computePlanDigest(plan);
  const mutated = {
    ...plan,
    operations: [{
      ...plan.operations[0],
      table: 'another_table'
    }]
  };
  const after = computePlanDigest(mutated);

  // Changing table MUST change digest
  assert.notStrictEqual(before, after);
});

test('R12: Production approval requires valid approvalToken and matching planDigest', async () => {
  const plan = {
    planToken: 'token_prod',
    planDigest: 'digest_prod',
    expiresAt: Date.now() + 60000,
    targetScope: { profileId: 'prod', database: 'prod_db', table: 'users', profileFingerprint: 'fp_prod' },
    columns: [{ name: 'id', type: 'int' }],
    primaryKeys: ['id'],
    operations: [{
      type: 'INSERT',
      table: 'users',
      rowKey: '1',
      pkValues: [1],
      values: { id: 1 }
    }]
  };

  const executor = new DataSyncExecutor({
    consumePlan: () => plan,
    getProfileWithSecrets: () => ({ id: 'prod', environment: 'production', readOnly: false }),
    fingerprintProfile: () => 'fp_prod',
    authorizeProduction: async ({ plan: p, approvalToken }) => {
      if (!approvalToken) {
        throw Object.assign(new Error('Thiếu token phê duyệt Production.'), { code: 'PRODUCTION_APPROVAL_REQUIRED' });
      }
      if (approvalToken !== 'valid_token' || p.planDigest !== 'digest_prod') {
        throw Object.assign(new Error('Phê duyệt Production không khớp với kế hoạch.'), { code: 'PRODUCTION_APPROVAL_MISMATCH' });
      }
      return { planToken: p.planToken, planDigest: p.planDigest };
    },
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

  // 1. Missing approval token -> rejected
  await assert.rejects(
    () => executor.executeSyncPlan({ planToken: 'token_prod' }),
    err => err.code === 'PRODUCTION_APPROVAL_REQUIRED'
  );

  // 2. Mismatched approval token / digest -> rejected
  await assert.rejects(
    () => executor.executeSyncPlan({ planToken: 'token_prod', approvalToken: 'wrong_token' }),
    err => err.code === 'PRODUCTION_APPROVAL_MISMATCH'
  );

  // 3. Valid token -> accepted
  const result = await executor.executeSyncPlan({ planToken: 'token_prod', approvalToken: 'valid_token' });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.committedCount, 1);
});
