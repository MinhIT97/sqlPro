'use strict';

const crypto = require('node:crypto');
const { DatabaseSession } = require('./database.cjs');
const Diff = require('../data-diff.js');
const { createWorkerGuard } = require('./schema-migration-worker.cjs');
const { computeSchemaFingerprint } = require('./schema-snapshot.cjs');
const {
  TableKeysetReader,
  extractRowKeyTuple,
  compareKeyTuples
} = require('./data-diff-reader.cjs');

const SAFE_DIFF_CODES = new Set([
  'DATA_DIFF_SCHEMA_MISMATCH',
  'DATA_DIFF_NO_PRIMARY_KEY',
  'DATA_DIFF_UNSUPPORTED_COLUMN_TYPE',
  'DATA_DIFF_UNSUPPORTED_PK_TYPE',
  'DATA_DIFF_NULL_KEY',
  'DATA_DIFF_KEY_MISMATCH',
  'DATA_DIFF_BUDGET_EXCEEDED',
  'DATA_DIFF_CANCELLED',
  'DATA_DIFF_BUSY',
  'DATA_DIFF_TIMEOUT',
  'INVALID_PROFILE',
  'INVALID_DATABASE',
  'INVALID_TABLE',
  'QUERY_TIMEOUT',
  'QUERY_CANCELED',
  'PROTOCOL_SEQUENCE_TIMEOUT',
  'DATA_DIFF_CONTEXT_CHANGED', 'DATA_DIFF_WORKER_CLOSE_FAILED'
]);

function error(code, message) {
  return Object.assign(new Error(message), { code });
}

function sanitizeDiffError(err) {
  if (!err) return null;
  const code = typeof err === 'string' ? err : err.code;
  const safeCode = SAFE_DIFF_CODES.has(code) ? code : 'DATA_DIFF_FAILED';
  // Driver errors may contain SQL, literals, credentials or server paths.
  const message = `So sánh dữ liệu không hoàn tất (${safeCode}).`;
  return { code: safeCode, message };
}

function runtimeProfile(profile) {
  return {
    ...profile,
    ssh: {
      ...profile?.ssh,
      password: profile?.sshPassword || '',
      passphrase: profile?.sshPassphrase || ''
    }
  };
}

async function compareKeysetStreams({
  sourceReader,
  targetReader,
  rowLimit = 2000,
  signal = null,
  onProgress = null
}) {
  const pkTypes = sourceReader.pkTypes;
  const primaryKeys = sourceReader.primaryKeys;
  const columns = sourceReader.columns;
  const colNames = columns.map(c => c.name);

  let sourceChunk = await sourceReader.readNextChunk();
  let targetChunk = await targetReader.readNextChunk();

  let sourceIndex = 0;
  let targetIndex = 0;

  const identical = [];
  const different = [];
  const onlyInSource = [];
  const onlyInTarget = [];

  let totalSourceObserved = 0;
  let totalTargetObserved = 0;

  let lastProgressReport = Date.now();
  const maybeReport = (force = false) => {
    const now = Date.now();
    if (!force && now - lastProgressReport < 100) return;
    lastProgressReport = now;
    if (typeof onProgress === 'function') {
      onProgress({
        totalSource: totalSourceObserved,
        totalTarget: totalTargetObserved,
        identicalCount: identical.length,
        differentCount: different.length,
        onlyInSourceCount: onlyInSource.length,
        onlyInTargetCount: onlyInTarget.length
      });
    }
  };

  while (true) {
    if (signal?.aborted) {
      throw error('DATA_DIFF_CANCELLED', 'Thao tác so sánh dữ liệu đã bị hủy.');
    }

    while (sourceIndex >= sourceChunk.rows.length && sourceChunk.hasMore) {
      sourceChunk = await sourceReader.readNextChunk();
      sourceIndex = 0;
    }

    while (targetIndex >= targetChunk.rows.length && targetChunk.hasMore) {
      targetChunk = await targetReader.readNextChunk();
      targetIndex = 0;
    }

    const hasSourceRow = sourceIndex < sourceChunk.rows.length;
    const hasTargetRow = targetIndex < targetChunk.rows.length;

    if (!hasSourceRow && !hasTargetRow) {
      break;
    }

    if (totalSourceObserved >= rowLimit || totalTargetObserved >= rowLimit) {
      break;
    }

    if (hasSourceRow && hasTargetRow) {
      const sRow = sourceChunk.rows[sourceIndex];
      const tRow = targetChunk.rows[targetIndex];

      const sTuple = extractRowKeyTuple(sRow, primaryKeys, colNames);
      const tTuple = extractRowKeyTuple(tRow, primaryKeys, colNames);

      const cmp = compareKeyTuples(sTuple, tTuple, pkTypes);

      if (cmp === 0) {
        totalSourceObserved++;
        totalTargetObserved++;
        sourceIndex++;
        targetIndex++;

        const sKey = JSON.stringify(sTuple.map(String));
        const diffCols = [];

        for (let c = 0; c < columns.length; c++) {
          const colName = columns[c].name;
          const colType = columns[c].type;

          const valA = Array.isArray(sRow) ? sRow[c] : sRow[colName];
          const valB = Array.isArray(tRow) ? tRow[c] : tRow[colName];

          if (!Diff.compareCanonicalValues(valA, valB, colType)) {
            diffCols.push({
              column: colName,
              columnIndex: c,
              columnType: colType,
              sourceValue: valA,
              targetValue: valB
            });
          }
        }

        if (diffCols.length > 0) {
          different.push(Object.freeze({
            rowKey: sKey,
            sourceRow: sRow,
            targetRow: tRow,
            differences: Object.freeze(diffCols)
          }));
        } else {
          identical.push(Object.freeze({
            rowKey: sKey,
            row: sRow
          }));
        }
      } else if (cmp < 0) {
        totalSourceObserved++;
        sourceIndex++;
        const sKey = JSON.stringify(sTuple.map(String));
        onlyInSource.push(Object.freeze({
          rowKey: sKey,
          row: sRow
        }));
      } else {
        totalTargetObserved++;
        targetIndex++;
        const tKey = JSON.stringify(tTuple.map(String));
        onlyInTarget.push(Object.freeze({
          rowKey: tKey,
          row: tRow
        }));
      }
    } else if (hasSourceRow && !hasTargetRow) {
      const sRow = sourceChunk.rows[sourceIndex];
      const sTuple = extractRowKeyTuple(sRow, primaryKeys, colNames);
      totalSourceObserved++;
      sourceIndex++;
      const sKey = JSON.stringify(sTuple.map(String));
      onlyInSource.push(Object.freeze({
        rowKey: sKey,
        row: sRow
      }));
    } else if (!hasSourceRow && hasTargetRow) {
      const tRow = targetChunk.rows[targetIndex];
      const tTuple = extractRowKeyTuple(tRow, primaryKeys, colNames);
      totalTargetObserved++;
      targetIndex++;
      const tKey = JSON.stringify(tTuple.map(String));
      onlyInTarget.push(Object.freeze({
        rowKey: tKey,
        row: tRow
      }));
    }

    maybeReport();
  }

  maybeReport(true);

  const quotaReached = Boolean(
    sourceReader.quotaReached ||
    targetReader.quotaReached ||
    sourceChunk?.quotaReached ||
    targetChunk?.quotaReached ||
    totalSourceObserved >= rowLimit ||
    totalTargetObserved >= rowLimit
  );

  const complete = (
    !quotaReached &&
    !sourceChunk.hasMore &&
    sourceIndex >= sourceChunk.rows.length &&
    !targetChunk.hasMore &&
    targetIndex >= targetChunk.rows.length
  );

  const consistent = Boolean(sourceReader.inTransaction && targetReader.inTransaction);
  const isolation = consistent ? 'consistent-snapshot' : 'read-committed';

  return Object.freeze({
    coverage: Object.freeze({
      version: 1,
      kind: 'bounded-observation',
      complete,
      consistent,
      isolation,
      canSynchronize: false
    }),
    primaryKeys: Object.freeze([...primaryKeys]),
    columns: Object.freeze(columns.map(c => Object.freeze({ name: c.name, type: c.type }))),
    summary: Object.freeze({
      totalSource: totalSourceObserved,
      totalTarget: totalTargetObserved,
      identicalCount: identical.length,
      onlyInSourceCount: onlyInSource.length,
      differentCount: different.length,
      onlyInTargetCount: onlyInTarget.length
    }),
    identical: Object.freeze(identical),
    onlyInSource: Object.freeze(onlyInSource),
    different: Object.freeze(different),
    onlyInTarget: Object.freeze(onlyInTarget),
    generateSyncSql: () => Object.freeze({
      statements: Object.freeze([]),
      script: '',
      blocked: true,
      reason: 'Báo cáo chỉ gồm các dòng quan sát theo keyset, chưa có snapshot nhất quán hoặc kiểm tra thay đổi trước ghi. Đồng bộ và xuất SQL đang bị khóa.'
    })
  });
}

class DataDiffService {
  constructor(options = {}) {
    this.store = options.store || null;
    this.createSession = options.createSession || (profile => new DatabaseSession(profile));
    this.jobs = new Map();
    this.activeJobCount = 0;
    this.maxConcurrentJobs = 2;
    this.jobTtlMs = 10 * 60 * 1000;
    this.generation = 0;
    this.clearing = null;
    this.timeoutMs = options.timeoutMs ?? 30000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300000) throw error('DATA_DIFF_TIMEOUT', 'Giới hạn thời gian không hợp lệ.');
  }

  prune() {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (['completed', 'failed', 'cancelled'].includes(job.status)) {
        if (now - job.completedAt > this.jobTtlMs) {
          this.jobs.delete(id);
        }
      }
    }
  }

  async startDiff({
    sourceProfileId,
    sourceDb,
    sourceTable,
    targetProfileId,
    targetDb,
    targetTable,
    rowLimit = 2000,
    chunkSize = 200
  } = {}) {
    this.prune();

    if (this.clearing || this.activeJobCount >= this.maxConcurrentJobs) {
      throw error('DATA_DIFF_BUSY', 'Đang có quá nhiều tác vụ so sánh dữ liệu đang chạy; vui lòng thử lại sau.');
    }

    if (!sourceProfileId || typeof sourceProfileId !== 'string') throw error('INVALID_PROFILE', 'Profile nguồn không hợp lệ.');
    if (!targetProfileId || typeof targetProfileId !== 'string') throw error('INVALID_PROFILE', 'Profile đích không hợp lệ.');
    if (!sourceDb || typeof sourceDb !== 'string') throw error('INVALID_DATABASE', 'Database nguồn không hợp lệ.');
    if (!targetDb || typeof targetDb !== 'string') throw error('INVALID_DATABASE', 'Database đích không hợp lệ.');
    if (!sourceTable || typeof sourceTable !== 'string') throw error('INVALID_TABLE', 'Bảng nguồn không hợp lệ.');
    if (!targetTable || typeof targetTable !== 'string') throw error('INVALID_TABLE', 'Bảng đích không hợp lệ.');

    const sourceProfile = this.store?.getWithSecrets ? this.store.getWithSecrets(sourceProfileId) : null;
    const targetProfile = this.store?.getWithSecrets ? this.store.getWithSecrets(targetProfileId) : null;

    if (!sourceProfile) throw error('INVALID_PROFILE', `Không tìm thấy profile nguồn ${sourceProfileId}.`);
    if (!targetProfile) throw error('INVALID_PROFILE', `Không tìm thấy profile đích ${targetProfileId}.`);
    rowLimit = Math.max(1, Math.min(2000, Math.floor(Number(rowLimit) || 2000)));
    const generation = this.generation;
    const sourceFingerprint = computeSchemaFingerprint(sourceProfile);
    const targetFingerprint = computeSchemaFingerprint(targetProfile);

    const jobId = `diff_${crypto.randomUUID()}`;
    const controller = new AbortController();
    const deadline = Date.now() + this.timeoutMs;
    const assertCurrent = () => {
      if (controller.signal.aborted || generation !== this.generation) throw error('DATA_DIFF_CANCELLED', 'Đã hủy tác vụ.');
      const source = this.store?.getWithSecrets(sourceProfileId), target = this.store?.getWithSecrets(targetProfileId);
      if (!source || !target || computeSchemaFingerprint(source) !== sourceFingerprint || computeSchemaFingerprint(target) !== targetFingerprint) {
        throw error('DATA_DIFF_CONTEXT_CHANGED', 'Cấu hình nguồn hoặc đích đã thay đổi.');
      }
    };
    const wrapSession = worker => {
      const guard = createWorkerGuard(worker, { signal: controller.signal, deadline });
      const wrapped = { close: () => guard.close() };
      for (const method of ['connect', 'useDatabase', 'raw', 'listColumns']) {
        wrapped[method] = async (...args) => {
          assertCurrent();
          const result = await guard.run(() => worker[method](...args));
          assertCurrent();
          return result;
        };
      }
      return wrapped;
    };

    const job = {
      jobId,
      status: 'running',
      createdAt: Date.now(),
      completedAt: null,
      progress: {
        totalSource: 0,
        totalTarget: 0,
        identicalCount: 0,
        differentCount: 0,
        onlyInSourceCount: 0,
        onlyInTargetCount: 0
      },
      report: null,
      error: null,
      controller,
      promise: null
    };

    this.jobs.set(jobId, job);
    this.activeJobCount++;

    const runDiff = async () => {
      let sourceSession = null;
      let targetSession = null;
      let sourceReader = null;
      let targetReader = null;
      let completedReport = null;

      try {
        sourceSession = wrapSession(this.createSession(runtimeProfile(sourceProfile)));
        targetSession = wrapSession(this.createSession(runtimeProfile(targetProfile)));

        await sourceSession.connect();
        await sourceSession.useDatabase(sourceDb);

        await targetSession.connect();
        await targetSession.useDatabase(targetDb);

        sourceReader = new TableKeysetReader(sourceSession, sourceDb, sourceTable, {
          rowLimit,
          chunkSize,
          signal: controller.signal
        });

        targetReader = new TableKeysetReader(targetSession, targetDb, targetTable, {
          rowLimit,
          chunkSize,
          signal: controller.signal
        });

        await sourceReader.init();
        await targetReader.init();

        // Validate schema equality
        if (sourceReader.columns.length !== targetReader.columns.length) {
          throw error('DATA_DIFF_SCHEMA_MISMATCH', 'Số lượng cột giữa bảng nguồn và bảng đích không khớp nhau.');
        }
        for (let i = 0; i < sourceReader.columns.length; i++) {
          const sc = sourceReader.columns[i];
          const tc = targetReader.columns[i];
          if (sc.name !== tc.name || sc.type.toLowerCase() !== tc.type.toLowerCase()) {
            throw error('DATA_DIFF_SCHEMA_MISMATCH', `Cột "${sc.name}" (${sc.type}) ở nguồn khác với cột "${tc.name}" (${tc.type}) ở đích; chưa hỗ trợ mapping.`);
          }
        }
        if (JSON.stringify(sourceReader.primaryKeys) !== JSON.stringify(targetReader.primaryKeys)) {
          throw error('DATA_DIFF_SCHEMA_MISMATCH', 'Khóa chính giữa hai bảng không khớp nhau.');
        }

        const report = await compareKeysetStreams({
          sourceReader,
          targetReader,
          rowLimit,
          signal: controller.signal,
          onProgress: p => {
            job.progress = { ...p };
          }
        });

        assertCurrent();
        completedReport = report;
      } catch (err) {
        if (controller.signal.aborted || err?.code === 'DATA_DIFF_CANCELLED') {
          job.status = 'cancelled';
          job.error = sanitizeDiffError(error('DATA_DIFF_CANCELLED', 'Thao tác so sánh dữ liệu đã bị hủy.'));
        } else {
          job.status = 'failed';
          job.error = sanitizeDiffError(err || error('DATA_DIFF_FAILED', 'Không xác nhận được kết quả tác vụ.'));
        }
        job.completedAt = Date.now();
      } finally {
        if (sourceReader) {
          try { await sourceReader.close(); } catch { /* ignore */ }
        }
        if (targetReader) {
          try { await targetReader.close(); } catch { /* ignore */ }
        }
        if (sourceSession) {
          try { await sourceSession.close(); } catch { job.status = 'failed'; job.report = null; job.error = sanitizeDiffError({ code: 'DATA_DIFF_WORKER_CLOSE_FAILED' }); }
        }
        if (targetSession) {
          try { await targetSession.close(); } catch { job.status = 'failed'; job.report = null; job.error = sanitizeDiffError({ code: 'DATA_DIFF_WORKER_CLOSE_FAILED' }); }
        }
        this.activeJobCount = Math.max(0, this.activeJobCount - 1);
      }
      if (job.status === 'running' && completedReport) {
        try {
          assertCurrent();
          job.report = completedReport;
          job.status = 'completed';
        } catch (err) {
          job.status = controller.signal.aborted ? 'cancelled' : 'failed';
          job.error = sanitizeDiffError(err);
        }
        job.completedAt = Date.now();
      }
      if (job.status !== 'running' && job.completedAt === null) job.completedAt = Date.now();
    };

    job.promise = runDiff();

    return {
      jobId,
      status: 'running'
    };
  }

  getDiffStatus(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw error('DATA_DIFF_JOB_NOT_FOUND', `Không tìm thấy tác vụ so sánh ${jobId}.`);
    }

    return {
      jobId: job.jobId,
      status: job.status,
      progress: { ...job.progress },
      report: job.report ? structuredClone({ coverage: job.report.coverage, primaryKeys: job.report.primaryKeys,
        columns: job.report.columns, summary: job.report.summary, identical: job.report.identical,
        different: job.report.different, onlyInSource: job.report.onlyInSource, onlyInTarget: job.report.onlyInTarget }) : null,
      error: job.error ? { ...job.error } : null
    };
  }

  async cancelDiff(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return { cancelled: false };

    if (job.status === 'running') {
      job.controller.abort();
      if (job.promise) {
        try {
          await job.promise;
        } catch {
          // ignore
        }
      }
      return { cancelled: true };
    }

    return { cancelled: false };
  }

  async clear() {
    if (this.clearing) return this.clearing;
    this.generation++;
    const jobs = [...this.jobs.values()];
    this.jobs.clear();
    for (const job of jobs) {
      if (job.status === 'running') {
        job.controller.abort();
      }
    }
    this.clearing = Promise.allSettled(jobs.map(j => j.promise).filter(Boolean)).then(() => {
      this.activeJobCount = 0;
      this.clearing = null;
    });
    return this.clearing;
  }
}

module.exports = {
  compareKeysetStreams,
  DataDiffService,
  sanitizeDiffError
};
