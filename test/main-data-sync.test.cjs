'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DataSyncPlanService } = require('../electron/data-sync-plan-service.cjs');
const { DataSyncExecutor } = require('../electron/data-sync-executor.cjs');

test('Main Data Sync: end-to-end plan creation and guarded execution with optimistic concurrency', async () => {
  const diffReport = {
    coverage: { complete: true, consistent: true, canSynchronize: false },
    primaryKeys: ['id'],
    columns: [
      { name: 'id', type: 'int' },
      { name: 'code', type: 'varchar(20)' },
      { name: 'balance', type: 'decimal(18,2)' }
    ],
    summary: { totalSource: 2, totalTarget: 2, identicalCount: 0, differentCount: 1, onlyInSourceCount: 1, onlyInTargetCount: 1 },
    identical: [],
    onlyInSource: [{ rowKey: '["10"]', row: { id: 10, code: 'NEW_ACC', balance: '500.00' } }],
    different: [{
      rowKey: '["20"]',
      sourceRow: { id: 20, code: 'ACC_B', balance: '1200.00' },
      targetRow: { id: 20, code: 'ACC_B', balance: '1000.00' },
      differences: [{ column: 'balance', sourceValue: '1200.00', targetValue: '1000.00' }]
    }],
    onlyInTarget: [{ rowKey: '["30"]', row: { id: 30, code: 'ACC_C', balance: '0.00' } }]
  };

  const store = {
    getWithSecrets(id) {
      if (id === 'p_target') {
        return {
          id: 'p_target',
          name: 'Target DB',
          environment: 'staging',
          readOnly: false
        };
      }
      return null;
    }
  };

  const planService = new DataSyncPlanService({ store });

  // 1. Create plan
  const plan = planService.createSyncPlan({
    diffReport,
    sourceScope: { profileId: 'p_source', database: 'finance_db', table: 'accounts' },
    targetScope: { profileId: 'p_target', database: 'finance_db', table: 'accounts' }
  });

  assert.ok(plan.planToken);
  assert.equal(plan.counts.inserts, 1);
  assert.equal(plan.counts.updates, 1);
  assert.equal(plan.counts.deletes, 0); // Safe default: 0 deletes

  // 2. Execute plan
  const executedSql = [];
  const fakeSession = {
    async connect() {},
    async useDatabase() {},
    async listColumns() {
      return [
        { name: 'id', type: 'int', key: 'PRI' },
        { name: 'code', type: 'varchar(20)', key: '' },
        { name: 'balance', type: 'decimal(18,2)', key: '' }
      ];
    },
    async raw(sql, params) {
      if (sql.includes('SELECT ENGINE FROM')) return { result: [{ ENGINE: 'InnoDB' }] };
      if (sql.includes('SELECT TRIGGER_NAME FROM')) return { result: [] };
      executedSql.push({ sql, params });
      return { result: { affectedRows: 1 } };
    },
    async close() {}
  };

  const executor = new DataSyncExecutor({
    consumePlan: (token) => planService.consumePlan(token),
    getProfileWithSecrets: (id) => store.getWithSecrets(id),
    createSession: () => fakeSession
  });

  const progressEvents = [];
  const execResult = await executor.executeSyncPlan({
    planToken: plan.planToken,
    batchSize: 50,
    onProgress: (p) => progressEvents.push(p)
  });

  assert.equal(execResult.success, true);
  assert.equal(execResult.committedCount, 2);
  assert.equal(execResult.totalCount, 2);
  assert.equal(progressEvents.length > 0, true);

  // Invariant verification:
  // - Starts with START TRANSACTION
  // - Executes INSERT with quoted identifiers
  // - Executes UPDATE with optimistic concurrency guard
  // - Commits transaction
  assert.ok(executedSql.some(q => q.sql === 'START TRANSACTION'));
  assert.ok(executedSql.some(q => q.sql.includes('INSERT INTO `finance_db`.`accounts`')));
  assert.ok(executedSql.some(q => q.sql.includes('UPDATE `finance_db`.`accounts`') && q.sql.includes('`balance` = ?')));
  assert.equal(executedSql[executedSql.length - 1].sql, 'COMMIT');
});

test('DataSyncExecutor rejects non-InnoDB table engines (e.g. MyISAM) to prevent unrollbackable writes', async () => {
  const diffReport = {
    coverage: { complete: true, consistent: true, canSynchronize: false },
    primaryKeys: ['id'],
    columns: [{ name: 'id', type: 'int' }, { name: 'val', type: 'varchar(20)' }],
    summary: { totalSource: 1, totalTarget: 1, identicalCount: 0, differentCount: 1, onlyInSourceCount: 0, onlyInTargetCount: 0 },
    identical: [],
    onlyInSource: [],
    different: [{
      rowKey: '["1"]',
      sourceRow: { id: 1, val: 'new' },
      targetRow: { id: 1, val: 'old' },
      differences: [{ column: 'val', sourceValue: 'new', targetValue: 'old' }]
    }],
    onlyInTarget: []
  };

  const store = {
    getWithSecrets: () => ({ id: 'p_target', environment: 'staging', readOnly: false })
  };
  const planService = new DataSyncPlanService({ store });
  const plan = planService.createSyncPlan({
    diffReport,
    sourceScope: { profileId: 'p_src', database: 'db', table: 'myisam_tbl' },
    targetScope: { profileId: 'p_target', database: 'db', table: 'myisam_tbl' }
  });

  const fakeSession = {
    async connect() {},
    async useDatabase() {},
    async listColumns() {
      return [{ name: 'id', type: 'int', key: 'PRI' }, { name: 'val', type: 'varchar(20)', key: '' }];
    },
    async raw(sql) {
      if (sql.includes('SELECT ENGINE FROM information_schema.TABLES')) {
        return { result: [{ ENGINE: 'MyISAM' }] };
      }
      return { result: [] };
    },
    async close() {}
  };

  const executor = new DataSyncExecutor({
    consumePlan: (token) => planService.consumePlan(token),
    getProfileWithSecrets: (id) => store.getWithSecrets(id),
    createSession: () => fakeSession
  });

  await assert.rejects(
    executor.executeSyncPlan({ planToken: plan.planToken }),
    { code: 'UNSUPPORTED_TABLE_ENGINE' }
  );
});

test('DataSyncExecutor rejects tables with triggers to prevent unverified side-effects', async () => {
  const diffReport = {
    coverage: { complete: true, consistent: true, canSynchronize: false },
    primaryKeys: ['id'],
    columns: [{ name: 'id', type: 'int' }, { name: 'val', type: 'varchar(20)' }],
    summary: { totalSource: 1, totalTarget: 1, identicalCount: 0, differentCount: 1, onlyInSourceCount: 0, onlyInTargetCount: 0 },
    identical: [],
    onlyInSource: [],
    different: [{
      rowKey: '["1"]',
      sourceRow: { id: 1, val: 'new' },
      targetRow: { id: 1, val: 'old' },
      differences: [{ column: 'val', sourceValue: 'new', targetValue: 'old' }]
    }],
    onlyInTarget: []
  };

  const store = {
    getWithSecrets: () => ({ id: 'p_target', environment: 'staging', readOnly: false })
  };
  const planService = new DataSyncPlanService({ store });
  const plan = planService.createSyncPlan({
    diffReport,
    sourceScope: { profileId: 'p_src', database: 'db', table: 'users_trigger' },
    targetScope: { profileId: 'p_target', database: 'db', table: 'users_trigger' }
  });

  const fakeSession = {
    async connect() {},
    async useDatabase() {},
    async listColumns() {
      return [{ name: 'id', type: 'int', key: 'PRI' }, { name: 'val', type: 'varchar(20)', key: '' }];
    },
    async raw(sql) {
      if (sql.includes('SELECT ENGINE FROM information_schema.TABLES')) {
        return { result: [{ ENGINE: 'InnoDB' }] };
      }
      if (sql.includes('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS')) {
        return { result: [{ TRIGGER_NAME: 'audit_log_trigger' }] };
      }
      return { result: [] };
    },
    async close() {}
  };

  const executor = new DataSyncExecutor({
    consumePlan: (token) => planService.consumePlan(token),
    getProfileWithSecrets: (id) => store.getWithSecrets(id),
    createSession: () => fakeSession
  });

  await assert.rejects(
    executor.executeSyncPlan({ planToken: plan.planToken }),
    { code: 'TARGET_TABLE_TRIGGERS_DETECTED' }
  );
});

test('DataSyncPlanService resolves report and scopes from Main-owned dataDiffService via jobId', async () => {
  const dataDiffService = {
    getJob(id) {
      if (id === 'job_diff_123') {
        return {
          status: 'completed',
          sourceScope: { profileId: 'p_src', database: 'prod_db', table: 'orders' },
          targetScope: { profileId: 'p_tgt', database: 'backup_db', table: 'orders' },
          report: {
            coverage: { complete: true, consistent: true, canSynchronize: false },
            primaryKeys: ['id'],
            columns: [{ name: 'id', type: 'int' }, { name: 'total', type: 'decimal(10,2)' }],
            summary: { totalSource: 1, totalTarget: 0, identicalCount: 0, differentCount: 0, onlyInSourceCount: 1, onlyInTargetCount: 0 },
            identical: [],
            onlyInSource: [{ rowKey: '["100"]', row: { id: 100, total: '99.95' } }],
            different: [],
            onlyInTarget: []
          }
        };
      }
      return null;
    }
  };

  const planService = new DataSyncPlanService({ dataDiffService });
  const plan = planService.createSyncPlan({ jobId: 'job_diff_123' });

  assert.ok(plan.planToken);
  assert.equal(plan.counts.inserts, 1);
  assert.equal(plan.sourceScope.database, 'prod_db');
  assert.equal(plan.targetScope.database, 'backup_db');

  // Unknown jobId rejects
  assert.throws(
    () => planService.createSyncPlan({ jobId: 'unknown_job' }),
    { code: 'DIFF_JOB_NOT_FOUND' }
  );
});
