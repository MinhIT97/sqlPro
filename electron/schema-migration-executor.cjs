'use strict';

const { assertWritable } = require('./connection-policy.cjs');
const { DatabaseSession, isTimeoutOrConnectionError } = require('./database.cjs');
const { SchemaSnapshotCollector, computeSchemaFingerprint } = require('./schema-snapshot.cjs');
const error = (code, message) => Object.assign(new Error(message), { code });
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function runtimeProfile(profile) {
  return { ...profile, ssh: { ...profile.ssh, password: profile.sshPassword || '', passphrase: profile.sshPassphrase || '' } };
}

function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

function planDigest(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return computeSchemaFingerprint(plan);
  }
  const { planDigest: _ignored, ...payload } = plan;
  return computeSchemaFingerprint(payload);
}

// Experimental internal executor. Main IPC stays disabled until admission, approval,
// source verification and context hooks below are implemented and reviewed at Main.
class SchemaMigrationExecutor {
  constructor(options = {}) {
    this.options = options;
    this.statementTimeoutMs = options.statementTimeoutMs ?? 30000;
    if (!Number.isSafeInteger(this.statementTimeoutMs) || this.statementTimeoutMs < 1 || this.statementTimeoutMs > 300000) {
      throw error('INVALID_EXECUTOR_OPTIONS', 'Timeout migration không hợp lệ.');
    }
    this.createSession = options.createSession || (profile => new DatabaseSession(profile));
    this.createCollector = options.createCollector || ((session, context) => new SchemaSnapshotCollector(session, context));
    this.usedTokens = new Map();
  }

  async executePlan({ planToken, approvalToken, signal, onProgress, ...callerFields } = {}) {
    if (signal?.aborted) throw error('QUERY_CANCELED', 'Đã hủy migration.');
    if ('plan' in callerFields) throw error('CALLER_PLAN_REJECTED', 'Executor chỉ nhận token, không nhận plan từ caller.');
    const required = ['consumePlan', 'getProfileWithSecrets', 'fingerprintProfile', 'checkContext', 'verifySource'];
    if (required.some(key => typeof this.options[key] !== 'function')) {
      throw error('MIGRATION_ADMISSION_REQUIRED', 'Chưa có admission/context/source verification do Main sở hữu.');
    }
    if (!hash(planToken)) throw error('INVALID_PLAN_TOKEN', 'Token migration không hợp lệ.');
    const now = Date.now();
    for (const [token, expiry] of this.usedTokens) if (expiry <= now) this.usedTokens.delete(token);
    if (this.usedTokens.has(planToken)) throw error('MIGRATION_TOKEN_USED', 'Token đã được sử dụng.');
    if (this.usedTokens.size >= 1024) throw error('MIGRATION_ADMISSION_BUSY', 'Vượt giới hạn admission migration.');
    // Reserve before the first await, even if admission subsequently fails.
    this.usedTokens.set(planToken, now + 300000);
    const plan = freeze(structuredClone(await this.options.consumePlan(planToken)));
    if (!plan || typeof plan.planId !== 'string' || !plan.planId || plan.planToken !== planToken || plan.status !== 'ready' || plan.applySupported !== true) {
      throw error('MIGRATION_PLAN_BLOCKED', 'Plan chưa được Main cấp quyền thực thi.');
    }
    const validScope = scope => scope && typeof scope.profileId === 'string' && scope.profileId
      && typeof scope.sessionId === 'string' && scope.sessionId && typeof scope.database === 'string'
      && scope.database.length > 0 && scope.database.length <= 64 && !scope.database.includes('\0')
      && hash(scope.snapshotIdentity) && hash(scope.profileFingerprint) && ['MySQL', 'MariaDB'].includes(scope.engine)
      && Number.isSafeInteger(scope.generation) && scope.generation >= 0;
    if (!validScope(plan.sourceScope) || !validScope(plan.targetScope)
        || plan.sourceScope.engine !== plan.targetScope.engine
        || plan.sourceScope.profileId === plan.targetScope.profileId && plan.sourceScope.database === plan.targetScope.database) {
      throw error('INVALID_PLAN_SCOPE', 'Phạm vi nguồn/đích của plan không hợp lệ.');
    }
    if (!Number.isSafeInteger(plan.expiresAt) || plan.expiresAt <= Date.now() || plan.expiresAt > now + 300000) {
      throw error('MIGRATION_PLAN_EXPIRED', 'Plan đã hết hạn hoặc TTL không hợp lệ.');
    }
    if (plan.options?.wrapForeignKeys === true) throw error('FK_OVERRIDE_UNSUPPORTED', 'Executor này không tắt FK checks.');
    const timeoutMs = plan.options?.statementTimeoutMs ?? this.statementTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw error('INVALID_PLAN_TIMEOUT', 'Timeout plan không hợp lệ.');
    if (!Array.isArray(plan.statements) || !plan.statements.length || plan.statements.length > 500
        || plan.statements.some(s => !s || typeof s.id !== 'string' || !s.id || s.status !== 'executable' || s.enabled !== true || typeof s.sql !== 'string' || !s.sql.trim() || s.sql.includes('\0'))
        || new Set(plan.statements.map(s => s.id)).size !== plan.statements.length
        || Buffer.byteLength(JSON.stringify(plan.statements)) > 1024 * 1024) {
      throw error('MIGRATION_STATEMENTS_BLOCKED', 'Danh sách statement chưa được duyệt hoặc vượt quota.');
    }
    const digest = planDigest(plan);
    let approval = null;
    const assertLive = () => {
      if (signal?.aborted) throw error('QUERY_CANCELED', 'Đã hủy migration.');
      if (Date.now() >= plan.expiresAt) throw error('MIGRATION_PLAN_EXPIRED', 'Plan đã hết hạn.');
    };
    const profiles = () => {
      assertLive();
      const source = this.options.getProfileWithSecrets(plan.sourceScope.profileId);
      const target = this.options.getProfileWithSecrets(plan.targetScope.profileId);
      if (!source || !target || source.id !== plan.sourceScope.profileId || target.id !== plan.targetScope.profileId
          || this.options.fingerprintProfile(source) !== plan.sourceScope.profileFingerprint
          || this.options.fingerprintProfile(target) !== plan.targetScope.profileFingerprint) {
        throw error('MIGRATION_CONTEXT_CHANGED', 'Cấu hình nguồn/đích đã thay đổi.');
      }
      assertWritable(target);
      return { source, target };
    };
    const guard = async () => {
      profiles();
      if (await this.options.checkContext(plan) !== true) throw error('MIGRATION_CONTEXT_UNVERIFIED', 'Chưa xác minh được context tại Main.');
      return profiles(); // Re-read authoritative policy after every async context check.
    };
    let current = await guard();
    if (current.target.environment === 'production') {
      if (typeof this.options.authorizeProduction !== 'function') throw error('PRODUCTION_APPROVAL_REQUIRED', 'Thiếu phê duyệt Production gắn với plan.');
      // Never call ProductionApprovals.confirm() as a verifier: it executes a stored callback.
      approval = freeze(structuredClone(await this.options.authorizeProduction({ plan, planDigest: digest, approvalToken })));
      await guard();
    }
    const checkApproval = target => {
      if (target.environment === 'production' && (!approval || approval.planToken !== planToken || approval.planDigest !== digest
          || approval.targetProfileFingerprint !== plan.targetScope.profileFingerprint || !Number.isSafeInteger(approval.expiresAt)
          || approval.expiresAt <= Date.now() || approval.expiresAt > plan.expiresAt)) {
        throw error('PRODUCTION_APPROVAL_MISMATCH', 'Phê duyệt không khớp plan/đích hoặc đã hết hạn.');
      }
    };
    checkApproval(profiles().target);
    const matchesSnapshot = (snapshot, scope) => snapshot?.coverage === 'complete'
      && snapshot.database === scope.database && snapshot.snapshotIdentity === scope.snapshotIdentity
      && ['profileId', 'sessionId', 'generation', 'profileFingerprint', 'database', 'engine', 'serverVersion']
        .every(key => snapshot.scope?.[key] === scope[key]);
    const verifySource = async () => {
      const sourceSnapshot = await this.options.verifySource(plan.sourceScope);
      await guard();
      if (!matchesSnapshot(sourceSnapshot, plan.sourceScope)) {
        throw error('SOURCE_SCHEMA_DRIFT', 'Snapshot nguồn không đầy đủ hoặc đã thay đổi.');
      }
    };
    await verifySource();

    const ledger = plan.statements.map((s, index) => ({ id: s.id || `stmt_${index + 1}`, sql: s.sql, status: 'pending', durationMs: null, error: null }));
    let worker, executedCount = 0, executionUncertain = false, failure = null, cleanupError = null;
    const observerWarnings = [];
    const abort = () => {
      if (!worker) return;
      worker.dead = true;
      try { worker.connection?.destroy(); } catch { /* Closing the worker is retried in finally. */ }
    };
    signal?.addEventListener('abort', abort, { once: true });
    const query = sql => {
      if (signal?.aborted) { abort(); throw error('QUERY_CANCELED', 'Đã hủy migration.'); }
      if (!signal) return worker.raw(sql, [], timeoutMs);
      return new Promise((resolve, reject) => {
        const cancel = () => reject(error('QUERY_CANCELED', 'Đã hủy truy vấn migration; kết quả DDL cần đối chiếu.'));
        signal.addEventListener('abort', cancel, { once: true });
        Promise.resolve().then(() => { assertLive(); return worker.raw(sql, [], timeoutMs); })
          .then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
      });
    };
    try {
      current = await guard();
      checkApproval(current.target);
      worker = this.createSession(runtimeProfile(structuredClone(current.target)));
      if (!worker || ['connect', 'useDatabase', 'raw', 'close'].some(key => typeof worker[key] !== 'function')) {
        throw error('INVALID_MIGRATION_WORKER', 'Worker độc lập không hợp lệ.');
      }
      await worker.connect();
      await guard();
      await worker.useDatabase(plan.targetScope.database);
      await guard();
      const collector = this.createCollector(worker, { ...plan.targetScope });
      const fresh = await collector.collect(plan.targetScope.database);
      await guard();
      if (!matchesSnapshot(fresh, plan.targetScope)) {
        throw error('TARGET_SCHEMA_DRIFT', 'Snapshot đích không đầy đủ hoặc đã thay đổi.');
      }
      const settings = await query('SELECT @@SESSION.foreign_key_checks AS fkChecks, @@SESSION.autocommit AS autocommit');
      await guard();
      if (settings?.result?.length !== 1 || Number(settings.result[0].fkChecks) !== 1 || Number(settings.result[0].autocommit) !== 1) {
        throw error('MIGRATION_SESSION_UNSAFE', 'Worker phải bật FK checks và autocommit; không tự sửa setting.');
      }
      await verifySource(); // Connecting/collecting the target may have taken substantial time.
      for (const entry of ledger) {
        current = await guard();
        checkApproval(current.target);
        entry.status = 'executing';
        const started = Date.now();
        try {
          await query(entry.sql);
          entry.status = 'executed';
          executedCount++;
        } catch (err) {
          executionUncertain = isTimeoutOrConnectionError(err) || !String(err.code || '').startsWith('ER_');
          entry.status = executionUncertain ? 'uncertain' : 'failed';
          entry.error = String(err.code || 'MIGRATION_EXECUTION_FAILED');
          throw err;
        } finally { entry.durationMs = Date.now() - started; }
        await guard();
        if (typeof onProgress === 'function') {
          try { await onProgress(structuredClone({ executedCount, totalCount: ledger.length, currentStatement: entry })); }
          catch { observerWarnings.push('PROGRESS_CALLBACK_FAILED'); }
          await guard();
        }
      }
    } catch (err) { failure = err; }
    finally {
      signal?.removeEventListener('abort', abort);
      if (worker && typeof worker.close === 'function') {
        try { await worker.close(); } catch { cleanupError = 'MIGRATION_WORKER_CLOSE_FAILED'; }
      }
    }
    if (failure || cleanupError) {
      for (const entry of ledger) if (entry.status === 'pending') entry.status = signal?.aborted ? 'cancelled' : 'not_run';
      throw Object.assign(failure || error(cleanupError, 'Không đóng được worker migration.'), {
        executedCount, totalCount: ledger.length, partialCommit: executedCount > 0 || executionUncertain,
        executionUncertain, cleanupError, ledger, observerWarnings
      });
    }
    return { success: true, executedCount, totalCount: ledger.length, partialCommit: false, executionUncertain: false,
      ddlImplicitCommit: true, ledger, observerWarnings };
  }
}

module.exports = { SchemaMigrationExecutor, runtimeProfile, planDigest };
