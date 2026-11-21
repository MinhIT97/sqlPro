'use strict';

const crypto = require('node:crypto');
const SchemaDiff = require('../schema-diff.js');
const { SchemaMigrationGenerator } = require('./schema-migration-generator.cjs');

const DEFAULT_SERVICE_OPTIONS = Object.freeze({
  snapshotTtlMs: 10 * 60 * 1000, planTtlMs: 5 * 60 * 1000,
  maxSnapshots: 32, maxPendingPlans: 32, maxStatements: 500, maxPlanBytes: 1024 * 1024
});
const APPLY_BLOCK_REASON = 'MIGRATION_APPLY_NOT_READY';
const error = (code, message) => Object.assign(new Error(message), { code });
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !value.includes('\0');

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

class SchemaMigrationService {
  constructor(options = {}) {
    this.options = { ...DEFAULT_SERVICE_OPTIONS, ...options };
    for (const key of Object.keys(DEFAULT_SERVICE_OPTIONS)) {
      if (!Number.isSafeInteger(this.options[key]) || this.options[key] <= 0) throw error('INVALID_SERVICE_OPTIONS', 'Giới hạn migration không hợp lệ.');
    }
    this.snapshots = new Map();
    this.pendingPlans = new Map();
    this.enableMySqlApply = options.enableMySqlApply === true;
  }

  clear() {
    this.snapshots.clear();
    this.pendingPlans.clear();
  }

  prune() {
    const now = Date.now();
    for (const [id, item] of this.snapshots) if (now >= item.expiresAt) this.snapshots.delete(id);
    for (const [id, item] of this.pendingPlans) if (now >= item.expiresAt) this.pendingPlans.delete(id);
  }

  storeSnapshot(snapshot) {
    const scope = snapshot?.scope;
    if (snapshot?.kind !== 'sqlpro-schema-snapshot' || snapshot.version !== 1
        || !/^[a-f0-9]{64}$/.test(snapshot.snapshotIdentity || '') || !scope
        || !validId(scope.profileId) || !validId(scope.sessionId)
        || !Number.isSafeInteger(scope.generation) || scope.generation < 0
        || !/^[a-f0-9]{64}$/.test(scope.profileFingerprint || '')
        || typeof snapshot.database !== 'string' || !snapshot.database || snapshot.database.length > 64
        || snapshot.database.includes('\0') || scope.database !== snapshot.database
        || !['tables', 'views', 'routines', 'triggers', 'events'].every(kind => Array.isArray(snapshot[kind]))) {
      throw error('INVALID_SNAPSHOT', 'Snapshot thiếu định danh phiên hoặc metadata hợp lệ.');
    }
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 16 * 1024 * 1024) throw error('SNAPSHOT_QUOTA_EXCEEDED', 'Snapshot vượt giới hạn lưu trữ.');
    this.prune();
    if (this.snapshots.size >= this.options.maxSnapshots) this.snapshots.delete(this.snapshots.keys().next().value);
    // Equal schema hashes on different servers must not overwrite capture identities.
    const snapshotId = `snapshot_${crypto.randomBytes(24).toString('hex')}`;
    this.snapshots.set(snapshotId, { snapshot: freeze(structuredClone(snapshot)), expiresAt: Date.now() + this.options.snapshotTtlMs });
    return snapshotId;
  }

  getSnapshot(snapshotId) {
    this.prune();
    const entry = this.snapshots.get(snapshotId);
    if (!entry) throw error('SNAPSHOT_NOT_FOUND', 'Snapshot không tồn tại hoặc đã hết hạn. Hãy thu thập lại.');
    return entry.snapshot;
  }

  createMigrationPlan({ sourceSnapshotId, targetSnapshotId, options = {} } = {}) {
    const source = this.getSnapshot(sourceSnapshotId);
    const target = this.getSnapshot(targetSnapshotId);
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw error('INVALID_PLAN_OPTIONS', 'Tùy chọn migration không hợp lệ.');
    const generated = new SchemaMigrationGenerator(this.options).generateMigrationPlan({ sourceSnapshot: source, targetSnapshot: target, options });
    let blockReason = generated.blockReason;
    let statements = blockReason ? [] : generated.statements;
    let comparison = blockReason ? null : SchemaDiff.compareSchemas(source, target, {
      ignoreComments: options.ignoreComments === true, ignoreCollation: options.ignoreCollation === true
    });
    if (Buffer.byteLength(JSON.stringify({ statements, comparison })) > this.options.maxPlanBytes) {
      blockReason = 'MIGRATION_PLAN_QUOTA_EXCEEDED'; statements = []; comparison = null;
    }
    const sqlScript = blockReason ? '' : SchemaDiff.formatMigrationScript(statements, {
      sourceName: `${source.database} (${source.scope.profileId})`,
      targetName: `${target.database} (${target.scope.profileId})`
    });
    const planToken = crypto.randomBytes(32).toString('hex');
    const applySupported = this.enableMySqlApply && !blockReason && statements.length > 0
      && [source, target].every(snapshot => snapshot.scope.engine === 'MySQL' && /^8\./.test(snapshot.scope.serverVersion || ''));
    const plan = freeze({
      planId: `plan_${crypto.randomBytes(16).toString('hex')}`, planToken,
      createdAt: new Date().toISOString(), expiresAt: Date.now() + this.options.planTtlMs,
      sourceSnapshotId, targetSnapshotId, sourceScope: source.scope, targetScope: target.scope,
      comparison, sqlScript, exportSupported: !blockReason,
      status: blockReason ? 'blocked' : 'preview', blockReason,
      applySupported, applyBlockReason: applySupported ? null : APPLY_BLOCK_REASON,
      options: structuredClone(options),
      statements: statements.map((statement, i) => ({ ...statement, id: `stmt_${i + 1}`, status: 'preview', enabled: false })),
      summary: { total: statements.length, executable: 0, blocked: 0 }
    });
    this.prune();
    if (this.pendingPlans.size >= this.options.maxPendingPlans) this.pendingPlans.delete(this.pendingPlans.keys().next().value);
    this.pendingPlans.set(planToken, plan);
    return this.projectPlanForRenderer(plan);
  }

  projectPlanForRenderer(plan) {
    const projectScope = scope => ({ profileId: scope.profileId, database: scope.database, engine: scope.engine });
    return structuredClone({
      kind: 'sqlpro-migration-plan', planId: plan.planId, planToken: plan.planToken,
      sourceSnapshotId: plan.sourceSnapshotId, targetSnapshotId: plan.targetSnapshotId,
      createdAt: plan.createdAt, expiresAt: new Date(plan.expiresAt).toISOString(),
      status: plan.status, blockReason: plan.blockReason,
      applySupported: plan.applySupported === true, applyBlockReason: plan.applyBlockReason,
      sourceScope: projectScope(plan.sourceScope), targetScope: projectScope(plan.targetScope),
      statements: plan.statements, summary: plan.summary,
      comparison: plan.comparison, sqlScript: plan.sqlScript, exportSupported: plan.exportSupported === true
    });
  }

  createCandidatePlan({ sourceSnapshotId, targetSnapshotId, options = {}, ttlMs } = {}) {
    const source = this.getSnapshot(sourceSnapshotId);
    const target = this.getSnapshot(targetSnapshotId);
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw error('INVALID_PLAN_OPTIONS', 'Tùy chọn migration không hợp lệ.');
    const generator = new SchemaMigrationGenerator(this.options);
    return generator.generateCandidatePlan({
      sourceSnapshot: source,
      targetSnapshot: target,
      options: { ...options, sourceSnapshotId, targetSnapshotId },
      ttlMs
    });
  }

  getPreviewPlan(planToken) {
    this.prune();
    const plan = typeof planToken === 'string' && this.pendingPlans.get(planToken);
    if (!plan) throw error('MIGRATION_PLAN_NOT_FOUND', 'Kế hoạch không tồn tại hoặc đã hết hạn. Hãy so sánh lại.');
    return plan;
  }

  consumeApplyCandidate(planToken) {
    const plan = this.getPreviewPlan(planToken);
    if (plan.applySupported !== true) throw error(APPLY_BLOCK_REASON, 'Kế hoạch này chưa hỗ trợ áp dụng trực tiếp.');
    this.pendingPlans.delete(planToken);
    const remaining = plan.expiresAt - Date.now();
    if (remaining <= 0) throw error('MIGRATION_PLAN_EXPIRED', 'Kế hoạch đã hết hạn.');
    return this.createCandidatePlan({ sourceSnapshotId: plan.sourceSnapshotId, targetSnapshotId: plan.targetSnapshotId,
      options: plan.options, ttlMs: remaining });
  }

  async applyPlan() {
    // No experimental path may mutate an Editor session or bypass production policy.
    // Implement an isolated, reviewed executor before enabling this entry point.
    throw error(APPLY_BLOCK_REASON, 'Áp dụng migration chưa sẵn sàng. Hiện chỉ hỗ trợ xem trước.');
  }
}

module.exports = { SchemaMigrationService, DEFAULT_SERVICE_OPTIONS, APPLY_BLOCK_REASON };
