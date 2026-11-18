'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  compareKeysetStreams,
  DataDiffService,
  sanitizeDiffError
} = require('../electron/data-diff-service.cjs');

function makeFakeReader({
  columns = [{ name: 'id', type: 'int' }, { name: 'val', type: 'varchar(50)' }],
  primaryKeys = ['id'],
  pkTypes = ['int'],
  chunks = [],
  inTransaction = true
} = {}) {
  let chunkIdx = 0;
  return {
    columns,
    primaryKeys,
    pkTypes,
    inTransaction,
    hasMore: chunks.length > 0,
    async readNextChunk() {
      if (chunkIdx >= chunks.length) {
        this.hasMore = false;
        return { rows: [], hasMore: false };
      }
      const rows = chunks[chunkIdx++];
      this.hasMore = chunkIdx < chunks.length;
      return { rows, hasMore: this.hasMore };
    },
    async close() {
      this.inTransaction = false;
    }
  };
}

test('compareKeysetStreams merges two streams across chunks with deep canonical equality', async () => {
  // Source:
  // Chunk 1: [id=1, val='A'], [id=2, val='1.00']
  // Chunk 2: [id=3, val='source-only'], [id=4, val='diff-A']
  const sourceReader = makeFakeReader({
    columns: [{ name: 'id', type: 'int' }, { name: 'val', type: 'decimal(10,2)' }],
    chunks: [
      [{ id: 1, val: '10.50' }, { id: 2, val: '1.00' }],
      [{ id: 3, val: '99.00' }, { id: 4, val: '123.45' }]
    ]
  });

  // Target:
  // Chunk 1: [id=1, val='10.5'], [id=2, val='1.01']  (id=1 identical, id=2 different)
  // Chunk 2: [id=4, val='123.46'], [id=5, val='target-only'] (id=4 different, id=5 target-only, id=3 source-only)
  const targetReader = makeFakeReader({
    columns: [{ name: 'id', type: 'int' }, { name: 'val', type: 'decimal(10,2)' }],
    chunks: [
      [{ id: 1, val: '10.5' }, { id: 2, val: '1.01' }],
      [{ id: 4, val: '123.46' }, { id: 5, val: '500.00' }]
    ]
  });

  const report = await compareKeysetStreams({
    sourceReader,
    targetReader,
    rowLimit: 100
  });

  assert.equal(report.summary.totalSource, 4);
  assert.equal(report.summary.totalTarget, 4);
  assert.equal(report.summary.identicalCount, 1); // id=1
  assert.equal(report.summary.differentCount, 2); // id=2, id=4
  assert.equal(report.summary.onlyInSourceCount, 1); // id=3
  assert.equal(report.summary.onlyInTargetCount, 1); // id=5

  assert.equal(report.identical[0].rowKey, '["1"]');
  assert.equal(report.onlyInSource[0].rowKey, '["3"]');
  assert.equal(report.onlyInTarget[0].rowKey, '["5"]');

  assert.equal(report.coverage.complete, true);
  assert.equal(report.coverage.consistent, true);
  assert.equal(report.coverage.canSynchronize, false);

  const syncSql = report.generateSyncSql();
  assert.equal(syncSql.blocked, true);
  assert.deepEqual(syncSql.statements, []);
});

test('compareKeysetStreams handles rowLimit quota cutoff gracefully', async () => {
  const sourceReader = makeFakeReader({
    chunks: [
      [{ id: 1, val: 'A' }, { id: 2, val: 'B' }],
      [{ id: 3, val: 'C' }, { id: 4, val: 'D' }]
    ]
  });
  const targetReader = makeFakeReader({
    chunks: [
      [{ id: 1, val: 'A' }, { id: 2, val: 'B' }],
      [{ id: 3, val: 'C' }, { id: 4, val: 'D' }]
    ]
  });

  // Limit = 2 rows
  const report = await compareKeysetStreams({
    sourceReader,
    targetReader,
    rowLimit: 2
  });

  assert.equal(report.summary.identicalCount, 2);
  assert.equal(report.coverage.complete, false); // Not complete because more rows remained
});

test('compareKeysetStreams honors AbortSignal', async () => {
  const sourceReader = makeFakeReader({
    chunks: [[{ id: 1, val: 'A' }]]
  });
  const targetReader = makeFakeReader({
    chunks: [[{ id: 1, val: 'A' }]]
  });

  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => compareKeysetStreams({ sourceReader, targetReader, signal: controller.signal }),
    { code: 'DATA_DIFF_CANCELLED' }
  );
});

test('DataDiffService validates input parameters and profiles', async () => {
  const service = new DataDiffService({
    store: {
      getWithSecrets(id) {
        if (id === 'p_valid') return { id: 'p_valid', host: '127.0.0.1' };
        return null;
      }
    }
  });

  await assert.rejects(
    () => service.startDiff({ sourceProfileId: '', targetProfileId: 'p_valid', sourceDb: 'db', targetDb: 'db', sourceTable: 't', targetTable: 't' }),
    { code: 'INVALID_PROFILE' }
  );

  await assert.rejects(
    () => service.startDiff({ sourceProfileId: 'missing', targetProfileId: 'p_valid', sourceDb: 'db', targetDb: 'db', sourceTable: 't', targetTable: 't' }),
    { code: 'INVALID_PROFILE' }
  );
});

test('DataDiffService runs full diff lifecycle with worker session cleanup', async () => {
  const closedSessions = [];
  const fakeSession = (name) => ({
    name,
    async connect() {},
    async useDatabase() {},
    async listColumns() {
      return [
        { name: 'id', type: 'int', key: 'PRI' },
        { name: 'val', type: 'varchar(50)', key: '' }
      ];
    },
    async raw(sql) {
      if (sql.includes('information_schema.TABLES')) return { result: [{ engine: 'InnoDB' }] };
      if (sql.startsWith('START TRANSACTION') || sql.startsWith('ROLLBACK')) return { result: [] };
      return {
        rows: name === 'src' ? [{ id: 1, val: 'X' }] : [{ id: 1, val: 'Y' }]
      };
    },
    async close() {
      closedSessions.push(name);
    }
  });

  let sessionCount = 0;
  const service = new DataDiffService({
    store: {
      getWithSecrets(id) {
        return { id, host: '127.0.0.1' };
      }
    },
    createSession(profile) {
      sessionCount++;
      return fakeSession(profile.id === 'p1' ? 'src' : 'dst');
    }
  });

  const { jobId, status } = await service.startDiff({
    sourceProfileId: 'p1',
    targetProfileId: 'p2',
    sourceDb: 'app_db',
    targetDb: 'app_db',
    sourceTable: 'users',
    targetTable: 'users'
  });

  assert.equal(status, 'running');

  // Wait for background job to finish
  const job = service.jobs.get(jobId);
  await job.promise;

  const res = service.getDiffStatus(jobId);
  assert.equal(res.status, 'completed');
  assert.equal(res.report.summary.differentCount, 1);
  assert.equal(res.report.different[0].differences[0].column, 'val');

  // Verify worker sessions were closed
  assert.ok(closedSessions.includes('src'));
  assert.ok(closedSessions.includes('dst'));
});

test('DataDiffService detects schema mismatch between source and target', async () => {
  const fakeSession = (name) => ({
    name,
    async connect() {},
    async useDatabase() {},
    async listColumns() {
      if (name === 'src') {
        return [{ name: 'id', type: 'int', key: 'PRI' }];
      }
      return [{ name: 'id_different', type: 'int', key: 'PRI' }];
    },
    async raw() {
      return { result: [{ engine: 'InnoDB' }] };
    },
    async close() {}
  });

  const service = new DataDiffService({
    store: {
      getWithSecrets(id) {
        return { id, host: '127.0.0.1' };
      }
    },
    createSession(profile) {
      return fakeSession(profile.id === 'p1' ? 'src' : 'dst');
    }
  });

  const { jobId } = await service.startDiff({
    sourceProfileId: 'p1',
    targetProfileId: 'p2',
    sourceDb: 'db',
    targetDb: 'db',
    sourceTable: 't',
    targetTable: 't'
  });

  const job = service.jobs.get(jobId);
  await job.promise;

  const res = service.getDiffStatus(jobId);
  assert.equal(res.status, 'failed');
  assert.equal(res.error.code, 'DATA_DIFF_SCHEMA_MISMATCH');
});

test('DataDiffService enforces max concurrent diff jobs quota', async () => {
  const blocker = new AbortController();
  const service = new DataDiffService({
    store: {
      getWithSecrets(id) {
        return { id, host: '127.0.0.1' };
      }
    },
    createSession() {
      return {
        async connect() {},
        async useDatabase() {},
        async listColumns() { return [{ name: 'id', type: 'int', key: 'PRI' }]; },
        async raw(sql) {
          if (sql.includes('information_schema.TABLES')) return { result: [{ engine: 'InnoDB' }] };
          if (sql.startsWith('START TRANSACTION') || sql.startsWith('ROLLBACK')) return { result: [] };
          return new Promise((_, reject) => {
            if (blocker.signal.aborted) return reject(new Error('aborted'));
            blocker.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        },
        async close() {}
      };
    }
  });

  // Start 2 jobs (hits quota)
  await service.startDiff({ sourceProfileId: 'p1', targetProfileId: 'p2', sourceDb: 'db', targetDb: 'db', sourceTable: 't', targetTable: 't' });
  await service.startDiff({ sourceProfileId: 'p1', targetProfileId: 'p2', sourceDb: 'db', targetDb: 'db', sourceTable: 't', targetTable: 't' });

  // 3rd job throws DATA_DIFF_BUSY
  await assert.rejects(
    () => service.startDiff({ sourceProfileId: 'p1', targetProfileId: 'p2', sourceDb: 'db', targetDb: 'db', sourceTable: 't', targetTable: 't' }),
    { code: 'DATA_DIFF_BUSY' }
  );

  blocker.abort();
  await service.clear();
});
