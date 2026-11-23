'use strict';

const crypto = require('node:crypto');
const { assertWritable } = require('./connection-policy.cjs');
const { DatabaseSession } = require('./database.cjs');
const { planDigest, runtimeProfile } = require('./schema-migration-executor.cjs');
const { SchemaSnapshotCollector, computeSchemaFingerprint } = require('./schema-snapshot.cjs');
const { createWorkerGuard } = require('./schema-migration-worker.cjs');

const error = (code, message) => Object.assign(new Error(message), { code });
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

class SchemaMigrationAdmission {
  constructor(options = {}) {
    this.maxAdmitted = options.maxAdmitted ?? 32;
    this.ttlMs = options.ttlMs ?? (5 * 60 * 1000); // 5 minutes max
    this.now = options.now || (() => Date.now());
    this.admittedPlans = new Map();
    this.usedTokens = new Map();
  }

  clear() {
    this.admittedPlans.clear();
    this.usedTokens.clear();
  }

  prune() {
    const now = this.now();
    for (const [token, item] of this.admittedPlans) {
      if (now >= item.expiresAt) this.admittedPlans.delete(token);
    }
    for (const [token, expiry] of this.usedTokens) {
      if (now >= expiry) this.usedTokens.delete(token);
    }
  }

  admitCandidate(candidate, options = {}) {
    if (!candidate || typeof candidate !== 'object') {
      throw error('INVALID_CANDIDATE_PLAN', 'Candidate migration plan không hợp lệ.');
    }
    // Preview plans are explicitly blocked from self-promoting to ready
    // until generator and DB matrix are verified (B02-E3).
    if (candidate.status === 'preview' || candidate.applySupported !== true) {
      if (options.allowTestCandidate !== true) {
        throw error('MIGRATION_APPLY_NOT_READY', 'Preview plan chưa thể cấp quyền thực thi. Cần nghiệm thu generator và DB matrix.');
      }
    }
    if (candidate.status !== 'ready' || candidate.applySupported !== true) {
      throw error('MIGRATION_PLAN_BLOCKED', 'Candidate plan phải có trạng thái ready và applySupported: true.');
    }

    const validScope = scope => scope && typeof scope.profileId === 'string' && scope.profileId
      && typeof scope.sessionId === 'string' && scope.sessionId && typeof scope.database === 'string'
      && scope.database.length > 0 && scope.database.length <= 64 && !scope.database.includes('\0')
      && hash(scope.snapshotIdentity) && hash(scope.profileFingerprint) && ['MySQL', 'MariaDB'].includes(scope.engine)
      && Number.isSafeInteger(scope.generation) && scope.generation >= 0;

    if (!validScope(candidate.sourceScope) || !validScope(candidate.targetScope)) {
      throw error('INVALID_PLAN_SCOPE', 'Phạm vi nguồn/đích của plan không hợp lệ.');
    }
    if (candidate.sourceScope.engine !== candidate.targetScope.engine) {
      throw error('CROSS_ENGINE_MIGRATION_UNSUPPORTED', 'Không hỗ trợ migration khác loại cơ sở dữ liệu.');
    }
    if (candidate.sourceScope.profileId === candidate.targetScope.profileId && candidate.sourceScope.database === candidate.targetScope.database) {
      throw error('SAME_DATABASE', 'Nguồn và đích trùng nhau.');
    }

    if (candidate.options?.wrapForeignKeys === true) {
      throw error('FK_OVERRIDE_UNSUPPORTED', 'Executor này không tắt FK checks.');
    }

    const statements = candidate.statements;
    if (!Array.isArray(statements) || !statements.length || statements.length > 500) {
      throw error('MIGRATION_STATEMENTS_BLOCKED', 'Danh sách statement rỗng hoặc vượt quá 500 câu.');
    }
    if (Buffer.byteLength(JSON.stringify(statements)) > 1024 * 1024) {
      throw error('MIGRATION_PLAN_QUOTA_EXCEEDED', 'Dung lượng SQL migration vượt quá 1MB.');
    }
    const seenIds = new Set();
    for (const stmt of statements) {
      if (!stmt || typeof stmt !== 'object' || typeof stmt.id !== 'string' || !stmt.id) {
        throw error('MIGRATION_STATEMENTS_BLOCKED', 'Statement thiếu id hợp lệ.');
      }
      if (seenIds.has(stmt.id)) {
        throw error('MIGRATION_STATEMENTS_BLOCKED', 'Trùng lặp id statement trong plan.');
      }
      seenIds.add(stmt.id);
      if (stmt.status !== 'executable' || stmt.enabled !== true) {
        throw error('MIGRATION_STATEMENTS_BLOCKED', 'Tất cả statement trong admitted plan phải có status executable và enabled: true.');
      }
      if (typeof stmt.sql !== 'string' || !stmt.sql.trim() || stmt.sql.includes('\0')) {
        throw error('MIGRATION_STATEMENTS_BLOCKED', 'SQL statement không hợp lệ.');
      }
    }

    this.prune();
    const now = this.now();
    if (!Number.isSafeInteger(candidate.expiresAt) || candidate.expiresAt <= now) {
      throw error('MIGRATION_PLAN_EXPIRED', 'Kế hoạch migration đã hết hạn hoặc không có thời gian hợp lệ. Hãy tạo lại preview.');
    }
    if (candidate.expiresAt > now + this.ttlMs) {
      throw error('INVALID_PLAN_EXPIRY', 'Thời gian hết hạn của plan vượt quá giới hạn TTL cho phép.');
    }
    const expiresAt = candidate.expiresAt;

    const planToken = hash(candidate.planToken) ? candidate.planToken : crypto.randomBytes(32).toString('hex');
    if (this.usedTokens.has(planToken)) {
      throw error('MIGRATION_TOKEN_USED', 'Token migration đã được sử dụng. Không thể tái cấp token cũ.');
    }
    if (this.admittedPlans.has(planToken)) {
      throw error('MIGRATION_TOKEN_ALREADY_ADMITTED', 'Kế hoạch với token này đang chờ thực thi.');
    }

    const planId = candidate.planId && typeof candidate.planId === 'string' ? candidate.planId : `plan_${crypto.randomBytes(16).toString('hex')}`;

    const admitted = {
      planId,
      planToken,
      sourceSnapshotId: candidate.sourceSnapshotId || null,
      targetSnapshotId: candidate.targetSnapshotId || null,
      sourceScope: structuredClone(candidate.sourceScope),
      targetScope: structuredClone(candidate.targetScope),
      options: structuredClone(candidate.options || {}),
      statements: structuredClone(statements),
      status: 'ready',
      applySupported: true,
      createdAt: candidate.createdAt || new Date(now).toISOString(),
      expiresAt
    };

    const digest = planDigest(admitted);
    admitted.planDigest = digest;

    if (this.admittedPlans.size >= this.maxAdmitted) {
      const oldestKey = this.admittedPlans.keys().next().value;
      this.admittedPlans.delete(oldestKey);
    }

    const frozen = freeze(structuredClone(admitted));
    this.admittedPlans.set(planToken, frozen);
    return frozen;
  }

  getAdmittedPlan(planToken) {
    if (!hash(planToken)) return null;
    this.prune();
    const candidate = this.admittedPlans.get(planToken);
    return candidate ? freeze(structuredClone(candidate)) : null;
  }

  consumePlan(planToken) {
    if (!hash(planToken)) throw error('INVALID_PLAN_TOKEN', 'Token migration không hợp lệ.');
    const candidate = this.admittedPlans.get(planToken);
    // ATOMIC CONSUMPTION: Token is deleted immediately before any await or processing.
    this.admittedPlans.delete(planToken);
    this.prune();
    if (!candidate) {
      throw error('MIGRATION_TOKEN_USED', 'Token migration không tồn tại hoặc đã được sử dụng.');
    }
    // Record token as retired so re-admission with same token is blocked.
    const retireUntil = Math.max(candidate.expiresAt, this.now() + this.ttlMs);
    this.usedTokens.set(planToken, retireUntil);

    if (candidate.expiresAt <= this.now()) {
      throw error('MIGRATION_PLAN_EXPIRED', 'Kế hoạch migration đã hết hạn.');
    }
    return candidate;
  }
}

class SchemaMigrationApproval {
  constructor(options = {}) {
    this.limit = options.limit ?? 32;
    this.ttlMs = options.ttlMs ?? 120000; // 2 minutes default
    this.now = options.now || (() => Date.now());
    this.getProfileWithSecrets = options.getProfileWithSecrets || null;
    this.fingerprintProfile = options.fingerprintProfile || null;
    this.checkContext = options.checkContext || null;
    this.getGeneration = options.getGeneration || null;
    this.generation = 0;
    this.inFlightSlots = new Set();
    this.pending = new Map();
  }

  clear() {
    this.generation++;
    this.inFlightSlots.clear();
    this.pending.clear();
  }

  prune() {
    const now = this.now();
    for (const [token, item] of this.pending) {
      if (now >= item.expiresAt) this.pending.delete(token);
    }
  }

  async requestApproval({ plan, targetProfile, sourceProfile, showConfirmDialog, ...hooks } = {}) {
    if (!plan || typeof plan !== 'object') {
      throw error('INVALID_PLAN', 'Plan không hợp lệ để yêu cầu phê duyệt.');
    }
    if (!targetProfile || typeof targetProfile !== 'object') {
      throw error('INVALID_TARGET_PROFILE', 'Target profile không hợp lệ.');
    }
    if (typeof showConfirmDialog !== 'function') {
      throw error('CONFIRM_DIALOG_REQUIRED', 'Hộp thoại xác nhận là bắt buộc đối với môi trường Production.');
    }
    assertWritable(targetProfile);
    if (targetProfile.environment !== 'production') {
      throw error('PRODUCTION_APPROVAL_NOT_REQUIRED', 'Chỉ yêu cầu phê duyệt khi target ở môi trường Production.');
    }

    const fpFunc = hooks.fingerprintProfile || this.fingerprintProfile || computeSchemaFingerprint;
    const getProfile = hooks.getProfileWithSecrets || this.getProfileWithSecrets;

    // Verify target profile matches plan targetScope and fingerprint before showing dialog
    if (targetProfile.id !== plan.targetScope?.profileId) {
      throw error('TARGET_PROFILE_MISMATCH', 'Target profile không khớp với phạm vi đích của kế hoạch migration.');
    }
    if (fpFunc(targetProfile) !== plan.targetScope?.profileFingerprint) {
      throw error('TARGET_PROFILE_MISMATCH', 'Fingerprint của target profile không khớp với kế hoạch migration.');
    }

    // Verify source profile matches plan sourceScope and fingerprint before showing dialog
    const resolvedSource = sourceProfile || ((typeof getProfile === 'function') ? getProfile(plan.sourceScope?.profileId) : null);
    if (!resolvedSource || typeof resolvedSource !== 'object' || resolvedSource.id !== plan.sourceScope?.profileId) {
      throw error('SOURCE_PROFILE_MISMATCH', 'Source profile không khớp với phạm vi nguồn của kế hoạch migration.');
    }
    if (fpFunc(resolvedSource) !== plan.sourceScope?.profileFingerprint) {
      throw error('SOURCE_PROFILE_MISMATCH', 'Fingerprint của source profile không khớp với kế hoạch migration.');
    }

    const now = this.now();
    if (!Number.isSafeInteger(plan.expiresAt) || plan.expiresAt <= now) {
      throw error('MIGRATION_PLAN_EXPIRED', 'Plan đã hết hạn.');
    }
    if (!hash(plan.planToken)) {
      throw error('INVALID_PLAN_TOKEN', 'Plan thiếu token hợp lệ.');
    }

    const digest = planDigest(plan);
    this.prune();

    // Check concurrency quota: reserve slot before await using ticket ID to prevent negative counters
    if (this.pending.size + this.inFlightSlots.size >= this.limit) {
      throw error('PRODUCTION_APPROVAL_BUSY', 'Có quá nhiều yêu cầu phê duyệt migration đang chờ.');
    }

    const startGeneration = this.generation;
    const getGen = hooks.getGeneration || this.getGeneration;
    const appGeneration = typeof getGen === 'function' ? getGen() : null;
    const slotId = Symbol('approval_slot');

    this.inFlightSlots.add(slotId);
    try {
      const preview = {
        source: {
          profileId: resolvedSource.id,
          name: resolvedSource.name || resolvedSource.id,
          host: resolvedSource.host || '',
          database: plan.sourceScope?.database
        },
        target: {
          profileId: targetProfile.id,
          name: targetProfile.name || targetProfile.id,
          host: targetProfile.host || '',
          database: plan.targetScope?.database,
          environment: 'production'
        },
        statementCount: Array.isArray(plan.statements) ? plan.statements.length : 0,
        risks: [
          'DDL trên MySQL/MariaDB tự động commit ngầm và không thể rollback khi có lỗi giữa chừng.',
          'Thao tác chạy trên worker độc lập; khi hủy hoặc mất kết nối có thể để lại thay đổi dở dang.',
          'Khóa bảng và tác động schema có thể làm gián đoạn các truy vấn khác trên production.'
        ]
      };

      const dialogResult = await showConfirmDialog({
        type: 'warning',
        title: 'Xác nhận chạy migration trên Production',
        message: `Áp dụng ${preview.statementCount} câu SQL migration vào Production (${preview.target.database})?`,
        detail: `Nguồn: ${preview.source.name} [${preview.source.database}]\nĐích: ${preview.target.name} [${preview.target.database}]\nMáy chủ: ${preview.target.host}\n\nLưu ý quan trọng:\n- DDL tự động commit ngầm; không thể rollback toàn bộ nếu phát sinh lỗi.\n- Thao tác chạy trên kết nối riêng; không dùng phiên SQL Editor.\n- Mọi câu lệnh đã được kiểm tra tính hợp lệ trước khi thực hiện.`,
        buttons: ['Hủy', 'Xác nhận đúng đích và thực hiện'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      });

      const accepted = (dialogResult && typeof dialogResult === 'object') ? dialogResult.response === 1 : dialogResult === 1;
      if (!accepted) {
        throw error('MIGRATION_APPROVAL_CANCELED', 'Đã hủy xác nhận migration trên Production.');
      }

      // Re-verify context generation after dialog await
      if (this.generation !== startGeneration) {
        throw error('PRODUCTION_CONTEXT_CHANGED', 'Yêu cầu phê duyệt hoặc phiên ứng dụng đã bị xóa trong khi chờ xác nhận.');
      }
      if (typeof getGen === 'function' && getGen() !== appGeneration) {
        throw error('PRODUCTION_CONTEXT_CHANGED', 'Phiên ứng dụng đã thay đổi trong khi chờ xác nhận.');
      }

      // Re-read and re-verify authoritative target and source profiles after dialog await
      const latestTarget = (typeof getProfile === 'function') ? getProfile(targetProfile.id) : targetProfile;
      if (!latestTarget || latestTarget.id !== plan.targetScope?.profileId) {
        throw error('PRODUCTION_CONTEXT_CHANGED', 'Target profile không còn tồn tại hoặc đã thay đổi.');
      }
      assertWritable(latestTarget);
      if (fpFunc(latestTarget) !== plan.targetScope?.profileFingerprint) {
        throw error('PRODUCTION_CONTEXT_CHANGED', 'Cấu hình target đã thay đổi trong khi chờ xác nhận.');
      }

      const latestSource = (typeof getProfile === 'function') ? getProfile(plan.sourceScope?.profileId) : resolvedSource;
      if (!latestSource || latestSource.id !== plan.sourceScope?.profileId || fpFunc(latestSource) !== plan.sourceScope?.profileFingerprint) {
        throw error('PRODUCTION_CONTEXT_CHANGED', 'Cấu hình source đã thay đổi trong khi chờ xác nhận.');
      }

      // Asynchronous context check
      const chkCtx = hooks.checkContext || this.checkContext;
      if (typeof chkCtx === 'function') {
        const ok = await chkCtx(plan);
        if (ok !== true) {
          throw error('PRODUCTION_CONTEXT_CHANGED', 'Ngữ cảnh phiên hoặc cấu hình không còn hợp lệ sau khi xác nhận.');
        }
      }

      // CRITICAL RE-CHECK: Re-read profiles and generation right before storing token!
      // This catches target becoming read-only or configuration drifting while checkContext was awaiting.
      if (this.generation !== startGeneration) {
        throw error('PRODUCTION_CONTEXT_CHANGED', 'Yêu cầu phê duyệt hoặc phiên ứng dụng đã bị xóa sau khi kiểm tra ngữ cảnh.');
      }
      if (typeof getGen === 'function' && getGen() !== appGeneration) {
        throw error('PRODUCTION_CONTEXT_CHANGED', 'Phiên ứng dụng đã thay đổi sau khi kiểm tra ngữ cảnh.');
      }
      const finalTarget = (typeof getProfile === 'function') ? getProfile(targetProfile.id) : latestTarget;
      if (!finalTarget || finalTarget.id !== plan.targetScope?.profileId) {
        throw error('PRODUCTION_CONTEXT_CHANGED', 'Target profile không còn tồn tại hoặc đã thay đổi.');
      }
      assertWritable(finalTarget);
      if (fpFunc(finalTarget) !== plan.targetScope?.profileFingerprint) {
        throw error('PRODUCTION_CONTEXT_CHANGED', 'Cấu hình target đã thay đổi sau khi kiểm tra ngữ cảnh.');
      }
      const finalSource = (typeof getProfile === 'function') ? getProfile(plan.sourceScope?.profileId) : latestSource;
      if (!finalSource || finalSource.id !== plan.sourceScope?.profileId || fpFunc(finalSource) !== plan.sourceScope?.profileFingerprint) {
        throw error('PRODUCTION_CONTEXT_CHANGED', 'Cấu hình source đã thay đổi sau khi kiểm tra ngữ cảnh.');
      }

      const finalNow = this.now();
      if (finalNow >= plan.expiresAt) {
        throw error('MIGRATION_PLAN_EXPIRED', 'Plan đã hết hạn trong khi chờ xác nhận.');
      }

      // Safe calculation: expiresAt can NEVER exceed plan.expiresAt
      const expiresAt = Math.min(plan.expiresAt, finalNow + this.ttlMs);
      if (expiresAt <= finalNow) {
        throw error('MIGRATION_PLAN_EXPIRED', 'Plan đã hết hạn trong khi chờ xác nhận.');
      }

      const approvalToken = crypto.randomBytes(32).toString('hex');

      this.pending.set(approvalToken, {
        planToken: plan.planToken,
        planDigest: digest,
        targetProfileFingerprint: plan.targetScope.profileFingerprint,
        targetProfileId: targetProfile.id,
        expiresAt,
        issuedAt: finalNow
      });

      return {
        approvalToken,
        preview,
        expiresAt
      };
    } finally {
      this.inFlightSlots.delete(slotId);
    }
  }

  authorizeProduction({ plan, planDigest: digest, approvalToken }) {
    if (!approvalToken || typeof approvalToken !== 'string') {
      throw error('PRODUCTION_APPROVAL_REQUIRED', 'Thiếu token phê duyệt Production gắn với plan.');
    }

    // ATOMIC CONSUMPTION: delete immediately before any inspection or await
    const entry = this.pending.get(approvalToken);
    this.pending.delete(approvalToken);

    const now = this.now();
    if (!entry || entry.expiresAt <= now) {
      throw error('PRODUCTION_APPROVAL_EXPIRED', 'Phê duyệt Production không tồn tại hoặc đã hết hạn.');
    }

    // A claimed digest is not proof that this is still the approved plan.
    // Consume first, then independently bind the receipt to the current payload.
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)
        || !hash(digest) || digest !== planDigest(plan)
        || entry.planToken !== plan.planToken
        || entry.planDigest !== digest
        || entry.targetProfileId !== plan.targetScope?.profileId
        || entry.targetProfileFingerprint !== plan.targetScope?.profileFingerprint
        || !Number.isSafeInteger(plan.expiresAt) || entry.expiresAt > plan.expiresAt) {
      throw error('PRODUCTION_APPROVAL_MISMATCH', 'Phê duyệt không khớp plan, đích hoặc đã hết hạn.');
    }

    return freeze({
      planToken: plan.planToken,
      planDigest: digest,
      targetProfileFingerprint: plan.targetScope.profileFingerprint,
      expiresAt: entry.expiresAt
    });
  }

  cancel(approvalToken) {
    this.pending.delete(approvalToken);
    return { cancelled: true };
  }
}

function createMainContextHooks({
  store,
  openSessions,
  sessionRegistry,
  getGeneration,
  fingerprintProfile,
  sessionFingerprint,
  assertProfile,
  ownsLease
} = {}) {
  const getProfileWithSecrets = (profileId) => {
    if (!store || typeof store.getWithSecrets !== 'function') return null;
    return store.getWithSecrets(profileId);
  };

  const getFingerprint = (profile) => {
    return typeof fingerprintProfile === 'function'
      ? fingerprintProfile(profile)
      : computeSchemaFingerprint(profile);
  };

  const checkContext = async (plan, jobContext = {}) => {
    if (!plan || typeof plan !== 'object') return false;
    const scopes = [plan.sourceScope, plan.targetScope];
    const currentGeneration = typeof getGeneration === 'function' ? getGeneration() : 0;

    for (const scope of scopes) {
      if (!scope || typeof scope !== 'object') return false;
      const profile = store && typeof store.getWithSecrets === 'function' ? store.getWithSecrets(scope.profileId) : null;
      if (!profile || profile.id !== scope.profileId) return false;
      if (getFingerprint(profile) !== scope.profileFingerprint) return false;
      if (scope.generation !== currentGeneration) return false;

      if (openSessions) {
        const entry = openSessions.get(scope.profileId);
        const isJobOwner = () => Boolean(jobContext.jobId && typeof ownsLease === 'function'
          && ownsLease(jobContext.jobId, plan, entry));
        if (!entry || entry.session?.dead || entry.sessionId !== scope.sessionId) return false;
        if (typeof assertProfile === 'function') {
          try { assertProfile(entry); } catch { return false; }
        } else if (typeof sessionFingerprint === 'function') {
          if (sessionFingerprint(profile) !== entry.profileFingerprint) return false;
        }

        // Check interactive editor session integrity:
        // Transactions, disabled autocommit, active tasks block execution.
        if (entry.session?.inTransaction) return false;
        if (entry.session?.autocommit === false) return false;
        if (entry.session?.activeTask) return false;

        // Exclusive leases: if held by this migration job itself, allow it;
        // if held by another operation or job, reject to protect session integrity.
        if (entry.exclusiveOperation && !isJobOwner()) return false;
        if (entry.productionWriteInProgress) return false;

        if (sessionRegistry) {
          const leaseCount = sessionRegistry.leases?.get(entry) || 0;
          if (leaseCount > 0 && (!isJobOwner() || leaseCount !== 1)) {
            return false;
          }
          // isProtected() pins the selected Editor against LRU eviction, even when idle.
          // Active operations/transactions and foreign leases are checked explicitly above.
        }
      }
    }
    return true;
  };

  return {
    getProfileWithSecrets,
    fingerprintProfile: getFingerprint,
    checkContext
  };
}

function createSourceVerifier(options = {}) {
  const {
    store, createSession = profile => new DatabaseSession(profile),
    createCollector = (session, context) => new SchemaSnapshotCollector(session, context),
    fingerprintProfile = computeSchemaFingerprint, timeoutMs = 30000, quotas = {}, getSignal,
    checkContext
  } = options;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw error('INVALID_VERIFIER_OPTIONS', 'Timeout verifier không hợp lệ.');
  if (!store || typeof store.getWithSecrets !== 'function') {
    return async () => { throw error('SOURCE_VERIFIER_NOT_READY', 'Source verifier chưa có store tin cậy.'); };
  }
  return async (inputScope, verifyOptions = {}) => {
    const sourceScope = freeze(structuredClone(inputScope));
    if (!sourceScope || !hash(sourceScope.snapshotIdentity) || !hash(sourceScope.profileFingerprint)
        || typeof sourceScope.profileId !== 'string' || !sourceScope.profileId
        || typeof sourceScope.sessionId !== 'string' || !sourceScope.sessionId
        || !Number.isSafeInteger(sourceScope.generation) || sourceScope.generation < 0
        || typeof sourceScope.database !== 'string' || !sourceScope.database.trim()
        || sourceScope.database.length > 64 || sourceScope.database.includes('\0')
        || !['MySQL', 'MariaDB'].includes(sourceScope.engine)) {
      throw error('INVALID_SOURCE_SCOPE', 'Source scope không hợp lệ.');
    }
    const signal = verifyOptions.signal || getSignal?.();
    const budget = verifyOptions.timeoutMs === undefined ? timeoutMs : Math.min(timeoutMs, verifyOptions.timeoutMs);
    if (!Number.isSafeInteger(budget) || budget < 1) throw error('INVALID_VERIFIER_OPTIONS', 'Timeout verifier không hợp lệ.');
    const deadline = Date.now() + budget;
    const profile = store.getWithSecrets(sourceScope.profileId);
    if (!profile || profile.id !== sourceScope.profileId) throw error('SOURCE_PROFILE_NOT_FOUND', 'Không tìm thấy profile nguồn.');
    // Also guard credentials during this worker lifetime when the public policy
    // fingerprint deliberately excludes secrets.
    const captureFingerprint = computeSchemaFingerprint(profile);
    const contextGuard = createWorkerGuard({}, { signal, deadline });
    const guard = async () => {
      if (signal?.aborted) throw error('QUERY_CANCELED', 'Đã hủy kiểm tra nguồn.');
      if (typeof checkContext === 'function' && await contextGuard.run(() => checkContext(sourceScope, verifyOptions)) !== true) {
        throw error('SOURCE_CONTEXT_CHANGED', 'Context nguồn đã thay đổi.');
      }
      const current = store.getWithSecrets(sourceScope.profileId);
      if (!current || current.id !== sourceScope.profileId || fingerprintProfile(current) !== sourceScope.profileFingerprint
          || computeSchemaFingerprint(current) !== captureFingerprint) throw error('SOURCE_PROFILE_DRIFT', 'Profile nguồn đã thay đổi.');
      if (signal?.aborted) throw error('QUERY_CANCELED', 'Đã hủy kiểm tra nguồn.');
      if (Date.now() >= deadline) throw error('QUERY_TIMEOUT', 'Hết thời gian kiểm tra nguồn.');
    };
    await guard();
    let worker, workerGuard, result, failure, cleanupError;
    try {
      worker = createSession(runtimeProfile(structuredClone(profile)));
      if (!worker || ['connect', 'useDatabase', 'close'].some(key => typeof worker[key] !== 'function')) {
        throw error('INVALID_SOURCE_WORKER', 'Worker nguồn không hợp lệ.');
      }
      workerGuard = createWorkerGuard(worker, { signal, deadline });
      await workerGuard.run(() => worker.connect());
      await guard();
      await workerGuard.run(() => worker.useDatabase(sourceScope.database));
      await guard();
      const workerSessionId = `worker_source_${crypto.randomBytes(16).toString('hex')}`;
      worker.sessionId = workerSessionId;
      const context = { profileId: sourceScope.profileId, sessionId: workerSessionId,
        generation: sourceScope.generation, profileFingerprint: sourceScope.profileFingerprint };
      const collector = createCollector(worker, { ...context, quotas: { ...quotas, timeoutMs: Math.max(1, deadline - Date.now()) } });
      const snapshot = await workerGuard.run(() => collector.collect(sourceScope.database));
      await guard();
      if (!snapshot || snapshot.coverage !== 'complete') throw error('SOURCE_SCHEMA_INCOMPLETE', 'Snapshot nguồn chưa đầy đủ.');
      if (snapshot.database !== sourceScope.database || snapshot.snapshotIdentity !== sourceScope.snapshotIdentity
          || !['profileId', 'sessionId', 'generation', 'profileFingerprint'].every(key => snapshot.scope?.[key] === context[key])
          || snapshot.scope.database !== sourceScope.database || snapshot.scope.engine !== sourceScope.engine
          || (sourceScope.serverVersion && snapshot.scope.serverVersion !== sourceScope.serverVersion)) {
        throw error('SOURCE_SCHEMA_DRIFT', 'Snapshot nguồn hoặc identity worker không khớp.');
      }
      result = { ...snapshot, scope: { ...snapshot.scope, workerSessionId, captureSessionId: sourceScope.sessionId } };
    } catch (err) { failure = err; }
    finally {
      if (worker && typeof worker.close === 'function') {
        try { await (workerGuard || createWorkerGuard(worker)).close(); }
        catch { cleanupError = 'SOURCE_WORKER_CLOSE_FAILED'; }
      }
    }
    if (failure || cleanupError) throw Object.assign(failure || error(cleanupError, 'Không đóng được worker nguồn.'), { cleanupError: cleanupError || null });
    await guard();
    return freeze(result);
  };
}

module.exports = {
  SchemaMigrationAdmission,
  SchemaMigrationApproval,
  createMainContextHooks,
  createSourceVerifier,
  planDigest
};
