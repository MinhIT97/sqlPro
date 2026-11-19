'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DataSyncPlanService } = require('../electron/data-sync-plan-service.cjs');
const { DataSyncExecutor } = require('../electron/data-sync-executor.cjs');

function makeDiffReport(overrides = {}) {
  return {
    coverage: { complete: true, consistent: true, canSynchronize: false },
    primaryKeys: ['id'],
    columns: [{ name: 'id', type: 'int' }, { name: 'name', type: 'varchar(50)' }],
    summary: { totalSource: 2, totalTarget: 2, identicalCount: 0, differentCount: 1, onlyInSourceCount: 1, onlyInTargetCount: 1 },
    identical: [],
    onlyInSource: [{ rowKey: '["1"]', row: { id: 1, name: 'Alice' } }],
    different: [{
      rowKey: '["2"]',
      sourceRow: { id: 2, name: 'Bob New' },
      targetRow: { id: 2, name: 'Bob Old' },
      differences: [{ column: 'name', sourceValue: 'Bob New', targetValue: 'Bob Old' }]
    }],
    onlyInTarget: [{ rowKey: '["3"]', row: { id: 3, name: 'Charlie' } }],
    ...overrides
  };
}

test('DataSyncPlanService creates plan with inserts and updates, excluding deletes by default', () => {
  const service = new DataSyncPlanService();
  const diffReport = makeDiffReport();

  const plan = service.createSyncPlan({
    diffReport,
    sourceScope: { profileId: 'p_src', database: 'db', table: 'users' },
    targetScope: { profileId: 'p_dst', database: 'db', table: 'users' }
  });

  assert.ok(plan.planToken);
  assert.ok(plan.planDigest);
  assert.equal(plan.counts.inserts, 1);
  assert.equal(plan.counts.updates, 1);
  assert.equal(plan.counts.deletes, 0); // Deletes excluded by default!
  assert.equal(plan.counts.total, 2);

  // Deletes only included when opt-in is explicitly true
  const planWithDeletes = service.createSyncPlan({
    diffReport,
    sourceScope: { profileId: 'p_src', database: 'db', table: 'users' },
    targetScope: { profileId: 'p_dst', database: 'db', table: 'users' },
    options: { includeDeletes: true }
  });
  assert.equal(planWithDeletes.counts.deletes, 1);
  assert.equal(planWithDeletes.counts.total, 3);
});

test('DataSyncPlanService enforces one-time token consumption and TTL expiry', () => {
  const service = new DataSyncPlanService({ planTtlMs: 50 });
  const plan = service.createSyncPlan({
    diffReport: makeDiffReport(),
    sourceScope: { profileId: 'p1', database: 'db', table: 't' },
    targetScope: { profileId: 'p2', database: 'db', table: 't' }
  });

  // First consumption succeeds
  const consumed = service.consumePlan(plan.planToken);
  assert.equal(consumed.planDigest, plan.planDigest);

  // Second consumption throws SYNC_PLAN_TOKEN_USED
  assert.throws(() => service.consumePlan(plan.planToken), { code: 'SYNC_PLAN_TOKEN_USED' });

  // Expired plan throws SYNC_PLAN_EXPIRED
  const expiredPlan = service.createSyncPlan({
    diffReport: makeDiffReport(),
    sourceScope: { profileId: 'p1', database: 'db', table: 't' },
    targetScope: { profileId: 'p2', database: 'db', table: 't' }
  });
  const now = Date.now();
  // Simulate time travel past expiry
  const entry = service.pendingPlans.get(expiredPlan.planToken);
  entry.expiresAt = now - 1;

  assert.throws(() => service.consumePlan(expiredPlan.planToken), { code: 'SYNC_PLAN_EXPIRED' });
});

test('DataSyncExecutor executes transactional batches with optimistic concurrency checks', async () => {
  const service = new DataSyncPlanService();
  const plan = service.createSyncPlan({
    diffReport: makeDiffReport(),
    sourceScope: { profileId: 'p1', database: 'app_db', table: 'users' },
    targetScope: { profileId: 'p2', database: 'app_db', table: 'users' }
  });

  const executedQueries = [];
  const fakeSession = {
    async connect() {},
    async useDatabase() {},
    async listColumns() {
      return [
        { name: 'id', type: 'int', key: 'PRI' },
        { name: 'name', type: 'varchar(50)', key: '' }
      ];
    },
    async raw(sql, params) {
      if (sql.includes('SELECT ENGINE FROM')) return { result: [{ ENGINE: 'InnoDB' }] };
      if (sql.includes('SELECT TRIGGER_NAME FROM')) return { result: [] };
      executedQueries.push({ sql, params });
      return { result: { affectedRows: 1 } };
    },
    async close() {}
  };

  const executor = new DataSyncExecutor({
    consumePlan: (token) => service.consumePlan(token),
    getProfileWithSecrets: () => ({ id: 'p2', environment: 'development', readOnly: false }),
    createSession: () => fakeSession
  });

  const result = await executor.executeSyncPlan({
    planToken: plan.planToken,
    batchSize: 10
  });

  assert.equal(result.success, true);
  assert.equal(result.committedCount, 2);
  assert.equal(result.partialCommit, false);

  // Verify queries: START TRANSACTION -> INSERT -> UPDATE (with optimistic WHERE) -> COMMIT
  assert.ok(executedQueries.some(q => q.sql === 'START TRANSACTION'));
  assert.ok(executedQueries.some(q => q.sql.startsWith('INSERT INTO `app_db`.`users`')));
  assert.ok(executedQueries.some(q => q.sql.startsWith('UPDATE `app_db`.`users`') && q.sql.includes('`id` = ?') && q.sql.includes('`name` = ?')));
  assert.ok(executedQueries.some(q => q.sql === 'COMMIT'));
});

test('DataSyncExecutor rejects read-only target connections', async () => {
  const service = new DataSyncPlanService();
  const plan = service.createSyncPlan({
    diffReport: makeDiffReport(),
    sourceScope: { profileId: 'p1', database: 'db', table: 't' },
    targetScope: { profileId: 'p2', database: 'db', table: 't' }
  });

  const executor = new DataSyncExecutor({
    consumePlan: (token) => service.consumePlan(token),
    getProfileWithSecrets: () => ({ id: 'p2', readOnly: true }),
    createSession: () => ({})
  });

  await assert.rejects(
    () => executor.executeSyncPlan({ planToken: plan.planToken }),
    { code: 'CONNECTION_READ_ONLY' }
  );
});

test('DataSyncExecutor detects schema drift and halts before execution', async () => {
  const service = new DataSyncPlanService();
  const plan = service.createSyncPlan({
    diffReport: makeDiffReport(),
    sourceScope: { profileId: 'p1', database: 'db', table: 't' },
    targetScope: { profileId: 'p2', database: 'db', table: 't' }
  });

  const fakeSession = {
    async connect() {},
    async useDatabase() {},
    async listColumns() {
      // Changed column type from int to varchar
      return [
        { name: 'id', type: 'varchar(50)', key: 'PRI' },
        { name: 'name', type: 'varchar(50)', key: '' }
      ];
    },
    async close() {}
  };

  const executor = new DataSyncExecutor({
    consumePlan: (token) => service.consumePlan(token),
    getProfileWithSecrets: () => ({ id: 'p2', readOnly: false }),
    createSession: () => fakeSession
  });

  await assert.rejects(
    () => executor.executeSyncPlan({ planToken: plan.planToken }),
    { code: 'TARGET_SCHEMA_DRIFT' }
  );
});

test('DataSyncExecutor detects optimistic concurrency conflict and rolls back active batch', async () => {
  const service = new DataSyncPlanService();
  const plan = service.createSyncPlan({
    diffReport: makeDiffReport(),
    sourceScope: { profileId: 'p1', database: 'db', table: 't' },
    targetScope: { profileId: 'p2', database: 'db', table: 't' }
  });

  const queries = [];
  const fakeSession = {
    async connect() {},
    async useDatabase() {},
    async listColumns() {
      return [
        { name: 'id', type: 'int', key: 'PRI' },
        { name: 'name', type: 'varchar(50)', key: '' }
      ];
    },
    async raw(sql, params) {
      if (sql.includes('SELECT ENGINE FROM')) return { result: [{ ENGINE: 'InnoDB' }] };
      if (sql.includes('SELECT TRIGGER_NAME FROM')) return { result: [] };
      queries.push(sql);
      if (sql.startsWith('UPDATE')) {
        // 0 rows affected: row was modified concurrently on target!
        return { result: { affectedRows: 0 } };
      }
      return { result: { affectedRows: 1 } };
    },
    async close() {}
  };

  const executor = new DataSyncExecutor({
    consumePlan: (token) => service.consumePlan(token),
    getProfileWithSecrets: () => ({ id: 'p2', readOnly: false }),
    createSession: () => fakeSession
  });

  await assert.rejects(
    () => executor.executeSyncPlan({ planToken: plan.planToken }),
    (err) => {
      assert.equal(err.code, 'SYNC_CONFLICT_DETECTED');
      return true;
    }
  );

  // Verify ROLLBACK was executed
  assert.ok(queries.includes('ROLLBACK'));
});

test('DataSyncPlanService resolves multi-table foreign key dependencies in topological order', () => {
  const service = new DataSyncPlanService();

  // Authors (parent) and Books (child referencing authors)
  const authorsReport = {
    primaryKeys: ['id'],
    columns: [{ name: 'id', type: 'int' }, { name: 'name', type: 'varchar(100)' }],
    onlyInSource: [{ rowKey: '["1"]', row: { id: 1, name: 'Arthur' } }],
    different: [],
    onlyInTarget: [{ rowKey: '["9"]', row: { id: 9, name: 'Old Author' } }]
  };

  const booksReport = {
    primaryKeys: ['id'],
    columns: [{ name: 'id', type: 'int' }, { name: 'author_id', type: 'int' }, { name: 'title', type: 'varchar(100)' }],
    onlyInSource: [{ rowKey: '["101"]', row: { id: 101, author_id: 1, title: 'Sherlock' } }],
    different: [],
    onlyInTarget: [{ rowKey: '["901"]', row: { id: 901, author_id: 9, title: 'Old Book' } }]
  };

  const relations = [
    { tableName: 'books', refTable: 'authors' }
  ];

  const plan = service.createMultiTableSyncPlan({
    tableDiffReports: [
      { table: 'books', diffReport: booksReport },
      { table: 'authors', diffReport: authorsReport }
    ],
    sourceScope: { profileId: 'p1', database: 'lib_db' },
    targetScope: { profileId: 'p2', database: 'lib_db' },
    relations,
    options: { includeDeletes: true }
  });

  // Verify insert order: authors (parent) before books (child)
  assert.deepEqual(plan.insertOrder, ['authors', 'books']);
  // Verify delete order: books (child) before authors (parent)
  assert.deepEqual(plan.deleteOrder, ['books', 'authors']);

  const planObj = service.pendingPlans.get(plan.planToken);
  const insertOps = planObj.operations.filter(op => op.type === 'INSERT');
  assert.equal(insertOps[0].table, 'authors');
  assert.equal(insertOps[1].table, 'books');

  const deleteOps = planObj.operations.filter(op => op.type === 'DELETE');
  assert.equal(deleteOps[0].table, 'books');
  assert.equal(deleteOps[1].table, 'authors');
});

test('DataSyncPlanService detects circular foreign key dependencies between tables', () => {
  const service = new DataSyncPlanService();

  const r1 = { primaryKeys: ['id'], columns: [{ name: 'id', type: 'int' }], onlyInSource: [{ rowKey: '["1"]', row: { id: 1 } }], different: [] };
  const r2 = { primaryKeys: ['id'], columns: [{ name: 'id', type: 'int' }], onlyInSource: [{ rowKey: '["2"]', row: { id: 2 } }], different: [] };

  const relations = [
    { tableName: 'table_a', refTable: 'table_b' },
    { tableName: 'table_b', refTable: 'table_a' }
  ];

  assert.throws(
    () => service.createMultiTableSyncPlan({
      tableDiffReports: [
        { table: 'table_a', diffReport: r1 },
        { table: 'table_b', diffReport: r2 }
      ],
      sourceScope: { profileId: 'p1', database: 'db' },
      targetScope: { profileId: 'p2', database: 'db' },
      relations
    }),
    { code: 'CIRCULAR_DEPENDENCY_DETECTED' }
  );
});

test('DataSyncExecutor executes multi-table plan with correct per-table schema checks', async () => {
  const service = new DataSyncPlanService();

  const authorsReport = {
    primaryKeys: ['id'],
    columns: [{ name: 'id', type: 'int' }, { name: 'name', type: 'varchar(100)' }],
    onlyInSource: [{ rowKey: '["1"]', row: { id: 1, name: 'Arthur' } }],
    different: []
  };

  const booksReport = {
    primaryKeys: ['id'],
    columns: [{ name: 'id', type: 'int' }, { name: 'author_id', type: 'int' }],
    onlyInSource: [{ rowKey: '["101"]', row: { id: 101, author_id: 1 } }],
    different: []
  };

  const plan = service.createMultiTableSyncPlan({
    tableDiffReports: [
      { table: 'books', diffReport: booksReport },
      { table: 'authors', diffReport: authorsReport }
    ],
    sourceScope: { profileId: 'p1', database: 'lib_db' },
    targetScope: { profileId: 'p2', database: 'lib_db' },
    relations: [{ tableName: 'books', refTable: 'authors' }]
  });

  const executedQueries = [];
  const fakeSession = {
    async connect() {},
    async useDatabase() {},
    async listColumns(database, table) {
      if (table === 'authors') {
        return [{ name: 'id', type: 'int', key: 'PRI' }, { name: 'name', type: 'varchar(100)', key: '' }];
      }
      return [{ name: 'id', type: 'int', key: 'PRI' }, { name: 'author_id', type: 'int', key: '' }];
    },
    async raw(sql, params) {
      if (sql.includes('SELECT ENGINE FROM')) return { result: [{ ENGINE: 'InnoDB' }] };
      if (sql.includes('SELECT TRIGGER_NAME FROM')) return { result: [] };
      executedQueries.push({ sql, params });
      return { result: { affectedRows: 1 } };
    },
    async close() {}
  };

  const executor = new DataSyncExecutor({
    consumePlan: (token) => service.consumePlan(token),
    getProfileWithSecrets: () => ({ id: 'p2', environment: 'development', readOnly: false }),
    createSession: () => fakeSession
  });

  const result = await executor.executeSyncPlan({
    planToken: plan.planToken
  });

  assert.equal(result.success, true);
  assert.equal(result.committedCount, 2);

  // Verify authors inserted before books
  const insertAuthorsIdx = executedQueries.findIndex(q => q.sql.includes('INSERT INTO `lib_db`.`authors`'));
  const insertBooksIdx = executedQueries.findIndex(q => q.sql.includes('INSERT INTO `lib_db`.`books`'));
  assert.ok(insertAuthorsIdx !== -1);
  assert.ok(insertBooksIdx !== -1);
  assert.ok(insertAuthorsIdx < insertBooksIdx, 'Parent authors must be inserted before child books');
});
