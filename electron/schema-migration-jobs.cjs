'use strict';

const crypto = require('node:crypto');
const { planDigest } = require('./schema-migration-executor.cjs');

const error = (code, message) => Object.assign(new Error(message), { code });
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/**
 * Sanitize error codes for progress & result projection.
 * Strictly whitelist safe, non-sensitive error code strings.
 * Never leaks raw SQL, table names, DEFINER or driver error messages.
 */
const SAFE_CODES = new Set([
  'MIGRATION_EXECUTION_FAILED', 'QUERY_CANCELED', 'QUERY_TIMEOUT', 'PROTOCOL_SEQUENCE_TIMEOUT',
  'ER_TABLE_EXISTS_ERROR', 'ER_PARSE_ERROR', 'ER_QUERY_INTERRUPTED', 'SESSION_BUSY',
  'MIGRATION_CONTEXT_CHANGED', 'MIGRATION_CONTEXT_UNVERIFIED', 'MIGRATION_PLAN_EXPIRED',
  'SOURCE_SCHEMA_DRIFT', 'SOURCE_SCHEMA_INCOMPLETE', 'SOURCE_PROFILE_DRIFT', 'SOURCE_CONTEXT_CHANGED',
  'SOURCE_WORKER_CLOSE_FAILED', 'TARGET_SCHEMA_DRIFT', 'MIGRATION_WORKER_CLOSE_FAILED',
  'MIGRATION_TOKEN_USED', 'MIGRATION_PLAN_BLOCKED', 'CONNECTION_READ_ONLY', 'JOB_INVALID_STATE',
  'PRODUCTION_APPROVAL_REQUIRED', 'PRODUCTION_APPROVAL_MISMATCH', 'MIGRATION_SESSION_UNSAFE',
  'MIGRATION_PRECONDITION_FAILED', 'MIGRATION_POSTCONDITION_FAILED'
]);
function sanitizeErrorCode(err) {
  if (!err) return null;
  const code = typeof err === 'string' ? err : err.code;
  return SAFE_CODES.has(code) ? code : 'MIGRATION_EXECUTION_FAILED';
}
const terminal = status => ['completed', 'cancelled', 'failed', 'uncertain'].includes(status);
const statementStatuses = new Set(['pending', 'executing', 'executed', 'failed', 'uncertain', 'cancelled', 'not_run']);
const targetKey = scope => JSON.stringify([scope.profileId, scope.database]);

class SchemaMigrationJob {
  constructor({ plan, planToken, approvalToken, options = {} } = {}) {
    if (!plan || typeof plan !== 'object') {
      throw error('INVALID_JOB_PLAN', 'Migration plan bắt buộc phải được cung cấp cho job.');
    }
    if (!hash(planToken)) {
      throw error('INVALID_PLAN_TOKEN', 'Token migration không hợp lệ.');
    }

    this.jobId = `job_${crypto.randomBytes(16).toString('hex')}`;
    this.planToken = planToken;
    this.approvalToken = approvalToken || null;
    this.planId = plan.planId;
    if (planToken !== plan.planToken) throw error('INVALID_PLAN_TOKEN', 'Token không khớp plan.');
    this.planDigest = planDigest(plan);
    this.expiresAt = plan.expiresAt;
    this.sourceScope = freeze(structuredClone(plan.sourceScope));
    this.targetScope = freeze(structuredClone(plan.targetScope));
    this.options = freeze(structuredClone(options || {}));

    // Explicit state machine:
    // preparing -> verifying -> executing -> completed | cancelled | failed | uncertain
    this.status = 'preparing';
    this.createdAt = new Date().toISOString();
    this.startedAt = null;
    this.finishedAt = null;

    this.abortController = new AbortController();
    this.signal = this.abortController.signal;

    const statements = Array.isArray(plan.statements) ? plan.statements : [];
    this.totalCount = statements.length;
    this.executedCount = 0;
    this.executionUncertain = false;
    this.partialCommit = false;
    this.cleanupError = null;
    this.error = null;
    this.observerWarnings = [];

    // Full ledger stays strictly in memory at Main Process:
    this.ledger = statements.map((s, index) => ({
      id: s.id || `stmt_${index + 1}`,
      index,
      sql: s.sql,
      status: 'pending',
      durationMs: null,
      error: null
    }));

    this.listeners = new Set();
    for (const key of ['jobId', 'planToken', 'approvalToken', 'planId', 'planDigest', 'sourceScope', 'targetScope', 'expiresAt']) {
      Object.defineProperty(this, key, { writable: false, configurable: false });
    }
  }

  cancel(reason = 'Migration đã bị hủy.') {
    if (terminal(this.status)) return;
    this.abortController.abort(reason);
    this.status = this.running ? 'cancelling' : 'cancelled';
    if (!this.running) this.finishedAt = new Date().toISOString();
    this._notify();
  }

  onProgress(listener) {
    if (typeof listener === 'function') {
      this.listeners.add(listener);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  _notify() {
    for (const listener of this.listeners) {
      try {
        Promise.resolve(listener(this.projectForRenderer())).catch(() => {
          if (this.observerWarnings.length < 50) this.observerWarnings.push('PROGRESS_CALLBACK_FAILED');
        });
      } catch {
        if (this.observerWarnings.length < 50) this.observerWarnings.push('PROGRESS_CALLBACK_FAILED');
      }
    }
  }

  _updateProgress(progress) {
    if (!progress || typeof progress !== 'object') return;
    if (this.status === 'verifying' || this.status === 'preparing') {
      this.status = 'executing';
      if (!this.startedAt) this.startedAt = new Date().toISOString();
    }

    if (Number.isSafeInteger(progress.executedCount)) {
      this.executedCount = progress.executedCount;
    }
    if (Number.isSafeInteger(progress.totalCount)) {
      this.totalCount = progress.totalCount;
    }

    if (progress.currentStatement && typeof progress.currentStatement === 'object') {
      const cur = progress.currentStatement;
      const entry = this.ledger.find(s => s.id === cur.id);
      if (entry) {
        entry.status = cur.status;
        entry.durationMs = cur.durationMs ?? entry.durationMs;
        entry.error = cur.error ? sanitizeErrorCode(cur.error) : entry.error;
      }
    }

    this._notify();
  }

  /**
   * Project sanitized job status for Renderer / IPC events.
   * Whitelist only safe attributes; strictly excludes raw SQL, DEFINER,
   * connection credentials, SSH secrets, and driver error text.
   */
  projectForRenderer() {
    return {
      kind: 'sqlpro-migration-job',
      jobId: this.jobId,
      planId: this.planId,
      planToken: this.planToken,
      planDigest: this.planDigest,
      status: this.status,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      executedCount: this.executedCount,
      totalCount: this.totalCount,
      executionUncertain: this.executionUncertain,
      partialCommit: this.partialCommit,
      cleanupError: sanitizeErrorCode(this.cleanupError),
      error: this.error ? sanitizeErrorCode(this.error) : null,
      observerWarnings: this.observerWarnings.filter(code => code === 'PROGRESS_CALLBACK_FAILED').slice(0, 50),
      source: {
        profileId: this.sourceScope?.profileId,
        database: this.sourceScope?.database,
        engine: this.sourceScope?.engine
      },
      target: {
        profileId: this.targetScope?.profileId,
        database: this.targetScope?.database,
        engine: this.targetScope?.engine
      },
      // Statements projection: sanitized metadata only, no raw SQL
      statements: this.ledger.map(s => ({
        id: s.id,
        index: s.index,
        status: statementStatuses.has(s.status) ? s.status : 'unknown',
        durationMs: Number.isFinite(s.durationMs) && s.durationMs >= 0 ? s.durationMs : null,
        error: s.error ? sanitizeErrorCode(s.error) : null
      }))
    };
  }
}

class SchemaMigrationJobManager {
  #runs = new Set();
  #leases = new Map();
  #discard = new Set();
  constructor(options = {}) {
    this.maxActiveJobs = options.maxActiveJobs ?? 2;
    this.maxJobs = options.maxJobs ?? 64;
    this.jobTtlMs = options.jobTtlMs ?? 600000;
    for (const value of [this.maxActiveJobs, this.maxJobs, this.jobTtlMs]) {
      if (!Number.isSafeInteger(value) || value < 1) throw error('INVALID_JOB_OPTIONS', 'Quota job không hợp lệ.');
    }
    this.jobs = new Map();
    this.activeJobsByTarget = new Map();
  }
  #releaseTarget(job) {
    const key = targetKey(job.targetScope);
    if (this.activeJobsByTarget.get(key) === job.jobId) this.activeJobsByTarget.delete(key);
  }
  prune() {
    for (const [id, job] of this.jobs) {
      if (this.#runs.has(id)) continue;
      if (!terminal(job.status) && Date.now() >= job.expiresAt) job.cancel();
      if (terminal(job.status)) {
        this.#releaseTarget(job);
        if (Date.now() - Date.parse(job.finishedAt) >= this.jobTtlMs) this.jobs.delete(id);
      }
    }
  }
  getJob(id) { this.prune(); return this.jobs.get(id) || null; }
  cancelJob(id, reason) {
    const job = this.getJob(id);
    if (!job) return null;
    job.cancel(reason);
    if (!this.#runs.has(id)) this.#releaseTarget(job);
    return job.projectForRenderer();
  }
  cancelAll(reason) { for (const id of this.jobs.keys()) this.cancelJob(id, reason); }
  clear() {
    this.cancelAll();
    for (const [id, job] of this.jobs) {
      job.listeners.clear();
      if (this.#runs.has(id)) this.#discard.add(id);
      else { this.#releaseTarget(job); this.jobs.delete(id); }
    }
  }
  createJob({ plan, planToken, approvalToken, options } = {}) {
    this.prune();
    const validScope = scope => scope && typeof scope.profileId === 'string' && scope.profileId
      && typeof scope.sessionId === 'string' && scope.sessionId && typeof scope.database === 'string'
      && scope.database.length > 0 && scope.database.length <= 64 && !scope.database.includes('\0')
      && hash(scope.profileFingerprint) && hash(scope.snapshotIdentity);
    if (!plan || !plan.sourceScope || !plan.targetScope || !Number.isSafeInteger(plan.expiresAt)
        || !validScope(plan.sourceScope) || !validScope(plan.targetScope)
        || plan.expiresAt <= Date.now() || !Array.isArray(plan.statements) || plan.statements.length > 500
        || Buffer.byteLength(JSON.stringify(plan)) > 2 * 1024 * 1024) throw error('INVALID_JOB_PLAN', 'Plan job không hợp lệ.');
    if (this.activeJobsByTarget.has(targetKey(plan.targetScope))) throw error('TARGET_BUSY', 'Đích đang có job chưa cleanup xong.');
    if (this.activeJobsByTarget.size >= this.maxActiveJobs) throw error('MIGRATION_JOB_LIMIT_EXCEEDED', 'Đạt giới hạn job.');
    if (this.jobs.size >= this.maxJobs) {
      const old = [...this.jobs].find(([id, job]) => terminal(job.status) && !this.#runs.has(id));
      if (!old) throw error('MIGRATION_JOB_LIMIT_EXCEEDED', 'Đạt giới hạn lưu job.');
      this.jobs.delete(old[0]);
    }
    const job = new SchemaMigrationJob({ plan, planToken, approvalToken, options });
    this.jobs.set(job.jobId, job);
    this.activeJobsByTarget.set(targetKey(job.targetScope), job.jobId);
    return job;
  }
  ownsLease(jobId, plan, entry) {
    const job = this.jobs.get(jobId);
    return Boolean(job && this.#runs.has(jobId) && !job.signal.aborted && job.planToken === plan.planToken
      && job.planDigest === planDigest(plan) && this.#leases.get(jobId)?.has(entry)
      && entry.exclusiveOwnerJobId === jobId && entry.exclusiveOperation);
  }
  async runJob({ job, executor, sessionRegistry, openSessions, onProgress, signal } = {}) {
    if (!job || this.jobs.get(job.jobId) !== job || this.#runs.has(job.jobId) || job.status !== 'preparing') {
      throw error('JOB_INVALID_STATE', 'Job không còn quyền chạy hoặc đã được chạy.');
    }
    if (!executor || typeof executor.executePlan !== 'function') throw error('INVALID_EXECUTOR', 'Thiếu executor.');
    if (signal?.aborted || job.signal.aborted) {
      this.cancelJob(job.jobId);
      throw error('QUERY_CANCELED', 'Đã hủy trước khi bắt đầu.');
    }
    this.#runs.add(job.jobId);
    job.running = true;
    job.status = 'verifying';
    job.startedAt = new Date().toISOString();
    const abort = () => job.cancel();
    signal?.addEventListener('abort', abort, { once: true });
    const unsubscribe = onProgress ? job.onProgress(onProgress) : () => {};
    const releases = [], entries = new Set();
    let failure;
    this.#leases.set(job.jobId, entries);
    const copyLedger = result => {
      job.executedCount = Number.isSafeInteger(result.executedCount) ? result.executedCount : job.executedCount;
      job.totalCount = Number.isSafeInteger(result.totalCount) ? result.totalCount : job.totalCount;
      job.executionUncertain = Boolean(result.executionUncertain);
      job.partialCommit = Boolean(result.partialCommit || job.executedCount > 0 && job.signal.aborted || job.executionUncertain);
      job.cleanupError = sanitizeErrorCode(result.cleanupError);
      job.observerWarnings = [...new Set([...job.observerWarnings, ...(result.observerWarnings || [])])].filter(code => code === 'PROGRESS_CALLBACK_FAILED');
      for (const item of result.ledger || []) {
        const entry = job.ledger.find(s => s.id === item.id);
        if (entry) Object.assign(entry, { status: item.status, durationMs: item.durationMs, error: sanitizeErrorCode(item.error) });
      }
    };
    try {
      if (!openSessions || !sessionRegistry || typeof sessionRegistry.acquire !== 'function') throw error('SESSION_BUSY', 'Chưa có registry tin cậy.');
      // Validate every entry before acquiring or overwriting any ownership flag.
      for (const scope of [job.sourceScope, job.targetScope]) {
        const entry = openSessions.get(scope.profileId);
        if (!entry || entry.sessionId !== scope.sessionId || entry.session?.dead || entry.exclusiveOperation
            || entry.productionWriteInProgress || entry.session?.activeTask || entry.session?.inTransaction
            || entry.session?.autocommit === false || sessionRegistry.leases.get(entry)) throw error('SESSION_BUSY', 'Phiên nguồn/đích bận hoặc stale.');
        // Registry busy() also protects the selected Editor from LRU eviction.
        // Selection alone is not an operation; the explicit checks above protect its work.
        entries.add(entry);
      }
      for (const entry of entries) {
        const release = sessionRegistry.acquire(entry);
        releases.push(release);
        entry.exclusiveOperation = true;
        entry.exclusiveOwnerJobId = job.jobId;
      }
      const result = await executor.executePlan({ planToken: job.planToken, approvalToken: job.approvalToken,
        signal: job.signal, jobId: job.jobId,
        onProgress: progress => { if (this.#runs.has(job.jobId)) job._updateProgress(progress); }
      });
      copyLedger(result);
      if (job.signal.aborted) throw Object.assign(error('QUERY_CANCELED', 'Job đã hủy.'), result);
      job.status = 'completed';
    } catch (err) {
      copyLedger(err);
      job.error = sanitizeErrorCode(err);
      job.status = job.executionUncertain ? 'uncertain' : job.signal.aborted || err.code === 'QUERY_CANCELED' ? 'cancelled' : 'failed';
      for (const item of job.ledger) if (item.status === 'pending') item.status = job.signal.aborted ? 'cancelled' : 'not_run';
      failure = error(job.error, 'Migration job chưa hoàn tất.');
    } finally {
      signal?.removeEventListener('abort', abort);
      for (const entry of entries) {
        if (entry.exclusiveOwnerJobId === job.jobId) { entry.exclusiveOperation = false; entry.exclusiveOwnerJobId = null; }
      }
      for (const release of releases.reverse()) { try { release(); } catch { /* Try all releases. */ } }
      this.#leases.delete(job.jobId);
      this.#runs.delete(job.jobId);
      job.running = false;
      job.finishedAt = new Date().toISOString();
      this.#releaseTarget(job);
      job._notify();
      unsubscribe();
      if (this.#discard.delete(job.jobId)) { this.jobs.delete(job.jobId); job.listeners.clear(); }
    }
    if (failure) throw Object.assign(failure, { job: job.projectForRenderer() });
    return job.projectForRenderer();
  }
}

module.exports = {
  SchemaMigrationJob,
  SchemaMigrationJobManager,
  sanitizeErrorCode
};
