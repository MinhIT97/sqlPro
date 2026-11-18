'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DataDiffService } = require('../electron/data-diff-service.cjs');

test('Main Data Diff: end-to-end keyset streaming comparison, status polling and read-only invariant', async () => {
  const executedSourceQueries = [];
  const executedTargetQueries = [];
  let sourceClosed = false;
  let targetClosed = false;

  const fakeSession = (side) => {
    const executedQueries = side === 'source' ? executedSourceQueries : executedTargetQueries;
    return {
      async connect() {},
      async useDatabase() {},
      async close() {
        if (side === 'source') sourceClosed = true;
        else targetClosed = true;
      },
      async listColumns() {
        return [
          { name: 'id', type: 'int', key: 'PRI' },
          { name: 'amount', type: 'decimal(20,4)', key: '' },
          { name: 'payload', type: 'json', key: '' }
        ];
      },
      async raw(sql, params) {
        executedQueries.push({ sql, params });
        if (sql.includes('information_schema.TABLES')) {
          return { result: [{ engine: 'InnoDB' }] };
        }
        if (sql.startsWith('START TRANSACTION') || sql.startsWith('ROLLBACK')) {
          return { result: [] };
        }
        // Simulated keyset results
        if (side === 'source') {
          return {
            rows: [
              { id: 1, amount: '100.5000', payload: '{"status":"active"}' },
              { id: 2, amount: '200.0000', payload: '{"status":"pending"}' },
              { id: 3, amount: '300.0000', payload: '{"status":"archived"}' }
            ]
          };
        } else {
          return {
            rows: [
              { id: 1, amount: '100.50', payload: '{"status":"active"}' }, // identical (decimal normalizes)
              { id: 2, amount: '200.0000', payload: '{"status":"completed"}' }, // different
              { id: 4, amount: '400.0000', payload: '{"status":"new"}' } // only in target (id 3 is only in source)
            ]
          };
        }
      }
    };
  };

  const store = {
    getWithSecrets(id) {
      if (id === 'source_profile') return { id: 'source_profile', name: 'Source', host: '127.0.0.1' };
      if (id === 'target_profile') return { id: 'target_profile', name: 'Target', host: '127.0.0.1' };
      return null;
    }
  };

  const service = new DataDiffService({
    store,
    createSession: (profile) => fakeSession(profile.id === 'source_profile' ? 'source' : 'target')
  });

  const { jobId, status } = await service.startDiff({
    sourceProfileId: 'source_profile',
    targetProfileId: 'target_profile',
    sourceDb: 'source_db',
    targetDb: 'target_db',
    sourceTable: 'orders',
    targetTable: 'orders',
    rowLimit: 2000,
    chunkSize: 50
  });

  assert.equal(status, 'running');

  // Await background execution
  const job = service.jobs.get(jobId);
  await job.promise;

  const result = service.getDiffStatus(jobId);
  assert.equal(result.status, 'completed');
  assert.equal(result.report.summary.totalSource, 3);
  assert.equal(result.report.summary.totalTarget, 3);
  assert.equal(result.report.summary.identicalCount, 1); // id 1
  assert.equal(result.report.summary.differentCount, 1); // id 2
  assert.equal(result.report.summary.onlyInSourceCount, 1); // id 3
  assert.equal(result.report.summary.onlyInTargetCount, 1); // id 4

  // Verify coverage flags
  assert.equal(result.report.coverage.complete, true);
  assert.equal(result.report.coverage.consistent, true);
  assert.equal(result.report.coverage.isolation, 'consistent-snapshot');
  assert.equal(result.report.coverage.canSynchronize, false);

  // Invariant: strict read-only, 0 write statements executed
  const allExecuted = [...executedSourceQueries, ...executedTargetQueries];
  for (const query of allExecuted) {
    assert.match(query.sql, /^(?:SELECT|SET TRANSACTION ISOLATION LEVEL REPEATABLE READ|START TRANSACTION|ROLLBACK)/i);
    assert.doesNotMatch(query.sql, /^(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|TRUNCATE)/i);
  }

  // Verify worker sessions were closed
  assert.equal(sourceClosed, true);
  assert.equal(targetClosed, true);

  // Sync script generation is blocked
  assert.doesNotThrow(() => structuredClone(result));
  assert.equal('generateSyncSql' in result.report, false);
  const syncSql = require('../data-diff.js').generateSyncSql({ diffResult: result.report });
  assert.equal(syncSql.blocked, true);
  assert.deepEqual(syncSql.statements, []);

  await service.clear();
});
