'use strict';

const crypto = require('node:crypto');
const {
  SchemaMigrationAdmission,
  SchemaMigrationApproval,
  createMainContextHooks,
  createSourceVerifier
} = require('./schema-migration-admission.cjs');
const { SchemaMigrationJobManager } = require('./schema-migration-jobs.cjs');
const { SchemaMigrationExecutor, planDigest } = require('./schema-migration-executor.cjs');
const { DatabaseSession } = require('./database.cjs');
const { SchemaSnapshotCollector, computeSchemaFingerprint } = require('./schema-snapshot.cjs');

const error = (code, message) => Object.assign(new Error(message), { code });
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

class SchemaMigrationOrchestrator {
  constructor(options = {}) {
    this.store = options.store;
    this.sessionRegistry = options.sessionRegistry;
    this.openSessions = options.openSessions;
    this.getGeneration = options.getGeneration || (() => 0);
    this.productionProfileFingerprint = options.productionProfileFingerprint || options.fingerprintProfile || computeSchemaFingerprint;
    this.sessionProfileFingerprint = options.sessionProfileFingerprint;
    this.assertSessionProfile = options.assertSessionProfile;
    this.showConfirmDialog = options.showConfirmDialog;
    this.createSession = options.createSession || (profile => new DatabaseSession(profile));
    this.createCollector = options.createCollector || ((session, ctx) => new SchemaSnapshotCollector(session, ctx));
    this.sendProgress = options.sendProgress || (() => {});
    this.statementTimeoutMs = options.statementTimeoutMs ?? 30000;

    this.admission = options.admission || new SchemaMigrationAdmission();
    this.approval = options.approval || new SchemaMigrationApproval({
      now: options.now,
      showConfirmDialog: this.showConfirmDialog
    });
    this.jobManager = options.jobManager || new SchemaMigrationJobManager();

    this.runningPromises = new Map(); // jobId -> Promise
  }

  getJob(jobId) {
    if (!jobId || typeof jobId !== 'string') return null;
    const job = this.jobManager.getJob(jobId);
    return job ? job.projectForRenderer() : null;
  }

  cancelJob(jobId, reason = 'Migration đã bị hủy bởi người dùng.') {
    if (!jobId || typeof jobId !== 'string') return null;
    const job = this.jobManager.getJob(jobId);
    if (!job) return null;

    // Revoke admitted plan and pending approval if not yet consumed
    if (job.planToken) {
      try { this.admission.consumePlan(job.planToken); } catch {}
    }
    if (job.approvalToken) {
      try { this.approval.cancel(job.approvalToken); } catch {}
    }

    return this.jobManager.cancelJob(jobId, reason);
  }

  async reset(reason = 'Phiên ứng dụng đã thay đổi hoặc đặt lại.') {
    this.jobManager.cancelAll(reason);
    this.admission.clear();
    this.approval.clear();

    const active = [...this.runningPromises.values()];
    if (active.length) {
      await Promise.race([
        Promise.allSettled(active),
        new Promise(resolve => setTimeout(resolve, 2000))
      ]);
    }
    this.runningPromises.clear();
    this.jobManager.clear();
  }

  clear() {
    return this.reset();
  }

  admitPlan(candidate, options = {}) {
    return this.admission.admitCandidate(candidate, options);
  }

  async requestProductionApproval(planToken) {
    if (!hash(planToken)) throw error('INVALID_PLAN_TOKEN', 'Token migration không hợp lệ.');
    const plan = this.admission.getAdmittedPlan(planToken);
    if (!plan) throw error('INVALID_PLAN_TOKEN', 'Kế hoạch migration không tồn tại hoặc đã hết hạn.');

    if (!this.store || typeof this.store.getWithSecrets !== 'function') {
      throw error('ORCHESTRATOR_STORE_REQUIRED', 'Store bắt buộc phải được cung cấp.');
    }

    const targetProfile = this.store.getWithSecrets(plan.targetScope.profileId);
    const sourceProfile = this.store.getWithSecrets(plan.sourceScope.profileId);

    const contextHooks = createMainContextHooks({
      store: this.store,
      openSessions: this.openSessions,
      sessionRegistry: this.sessionRegistry,
      getGeneration: this.getGeneration,
      fingerprintProfile: this.productionProfileFingerprint,
      sessionFingerprint: this.sessionProfileFingerprint,
      assertProfile: this.assertSessionProfile
    });

    return await this.approval.requestApproval({
      plan,
      targetProfile,
      sourceProfile,
      showConfirmDialog: this.showConfirmDialog,
      fingerprintProfile: this.productionProfileFingerprint,
      checkContext: p => contextHooks.checkContext(p),
      getGeneration: this.getGeneration,
      getProfile: id => this.store.getWithSecrets(id)
    });
  }

  async executeMigrationJob({ planToken, approvalToken, signal, ...callerFields } = {}) {
    if (signal?.aborted) throw error('QUERY_CANCELED', 'Đã hủy migration.');
    if ('plan' in callerFields || 'statements' in callerFields || 'sql' in callerFields
        || 'sourceProfile' in callerFields || 'targetProfile' in callerFields || 'hooks' in callerFields) {
      throw error('CALLER_FIELDS_REJECTED', 'Orchestrator không nhận plan/SQL/hook/profile từ caller.');
    }
    if (!hash(planToken)) throw error('INVALID_PLAN_TOKEN', 'Token migration không hợp lệ.');
    if (this.admission.usedTokens?.has(planToken)) {
      throw error('MIGRATION_TOKEN_USED', 'Token migration đã được sử dụng.');
    }

    const plan = this.admission.getAdmittedPlan(planToken);
    if (!plan) throw error('INVALID_PLAN_TOKEN', 'Kế hoạch migration không tồn tại hoặc đã hết hạn.');
    if (!Number.isSafeInteger(plan.expiresAt) || plan.expiresAt <= Date.now()) {
      throw error('MIGRATION_PLAN_EXPIRED', 'Kế hoạch migration đã hết hạn.');
    }

    if (!this.store || typeof this.store.getWithSecrets !== 'function') {
      throw error('ORCHESTRATOR_STORE_REQUIRED', 'Store bắt buộc phải được cung cấp.');
    }

    // Verify profiles exist in store and match fingerprints before creating job
    const sourceProf = this.store.getWithSecrets(plan.sourceScope.profileId);
    const targetProf = this.store.getWithSecrets(plan.targetScope.profileId);
    if (!sourceProf || !targetProf) {
      throw error('MIGRATION_CONTEXT_CHANGED', 'Không tìm thấy cấu hình nguồn/đích.');
    }
    const getFp = this.productionProfileFingerprint;
    if (getFp(sourceProf) !== plan.sourceScope.profileFingerprint || getFp(targetProf) !== plan.targetScope.profileFingerprint) {
      throw error('MIGRATION_CONTEXT_CHANGED', 'Cấu hình nguồn/đích đã thay đổi.');
    }

    // Create the job via jobManager (enforces concurrency and quotas)
    const job = this.jobManager.createJob({
      plan,
      planToken,
      approvalToken
    });

    // Create per-job context hooks with manager.ownsLease
    const contextHooks = createMainContextHooks({
      store: this.store,
      openSessions: this.openSessions,
      sessionRegistry: this.sessionRegistry,
      getGeneration: this.getGeneration,
      fingerprintProfile: this.productionProfileFingerprint,
      sessionFingerprint: this.sessionProfileFingerprint,
      assertProfile: this.assertSessionProfile,
      ownsLease: (jobId, p, entry) => this.jobManager.ownsLease(jobId, p, entry)
    });

    // Create source verifier bound to job.signal and contextHooks
    const sourceVerifier = createSourceVerifier({
      store: this.store,
      createSession: this.createSession,
      createCollector: this.createCollector,
      fingerprintProfile: this.productionProfileFingerprint,
      getSignal: () => job.signal,
      checkContext: (sourceScope, verifyOpts) => {
        return contextHooks.checkContext(plan, { jobId: job.jobId });
      }
    });

    // Create executor for this job
    const executor = new SchemaMigrationExecutor({
      consumePlan: (token) => this.admission.consumePlan(token),
      getProfileWithSecrets: contextHooks.getProfileWithSecrets,
      fingerprintProfile: contextHooks.fingerprintProfile,
      checkContext: (p, ctx) => contextHooks.checkContext(p, ctx),
      verifySource: sourceVerifier,
      authorizeProduction: (args) => this.approval.authorizeProduction(args),
      createSession: this.createSession,
      createCollector: this.createCollector,
      statementTimeoutMs: this.statementTimeoutMs
    });

    const jobGen = this.getGeneration();
    const onProgress = (projection) => {
      // Discard stale events if logout or reset occurred
      if (this.getGeneration() !== jobGen) return;
      this.sendProgress({ ...projection, generation: jobGen });
    };

    const runPromise = this.jobManager.runJob({
      job,
      executor,
      sessionRegistry: this.sessionRegistry,
      openSessions: this.openSessions,
      onProgress,
      signal
    });

    this.runningPromises.set(job.jobId, runPromise);
    try {
      return await runPromise;
    } finally {
      this.runningPromises.delete(job.jobId);
    }
  }
}

module.exports = {
  SchemaMigrationOrchestrator
};
