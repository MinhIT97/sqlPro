'use strict';

const crypto = require('node:crypto');
const SchemaDiff = require('../schema-diff.js');

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

// Inspect original metadata before SchemaDiff can discard unsupported attributes.
function metadataBlock(snapshot) {
  if (snapshot.coverage !== 'complete') return 'SCHEMA_COVERAGE_INCOMPLETE';
  if (!['MySQL', 'MariaDB'].includes(snapshot.engine)) return 'ENGINE_UNSUPPORTED';
  if (['views', 'routines', 'triggers', 'events'].some(kind => snapshot[kind].length)) return 'OBJECT_DEPENDENCY_REVIEW_REQUIRED';
  const blocked = item => !item || typeof item !== 'object' || item.status === 'unknown' || item.coverageStatus === 'unknown' || item.migrationStatus === 'blocked';
  for (const table of snapshot.tables) {
    if (blocked(table) || table.foreignKeysStatus === 'unknown' || !Array.isArray(table.columns) || !table.columns.length
        || !Array.isArray(table.indexes) || !Array.isArray(table.foreignKeys)) return 'TABLE_METADATA_INCOMPLETE';
    if (table.foreignKeys.length) return 'FOREIGN_KEY_DEPENDENCY_REVIEW_REQUIRED';
    for (const column of table.columns) {
      if (blocked(column)) return column.migrationBlockReason || 'COLUMN_METADATA_INCOMPLETE';
      if (column.isGenerated || column.generationExpression || /generated|virtual|stored|persistent/i.test(column.extra || '')) return 'COLUMN_EXPRESSION_UNSUPPORTED';
    }
    for (const index of table.indexes) {
      if (blocked(index)) return index.migrationBlockReason || 'INDEX_METADATA_INCOMPLETE';
      if (!Array.isArray(index.columns) || !index.columns.length || index.columns.some(column =>
        !column || typeof column !== 'object' || !column.name || column.expression || column.subPart || column.direction === 'DESC')) return 'INDEX_DEFINITION_UNSUPPORTED';
      if (index.visibilityKind === 'mysql-visible' && index.visibility !== 'YES'
          || index.visibilityKind === 'mariadb-ignored' && index.visibility !== 'NO') return 'INDEX_VISIBILITY_UNSUPPORTED';
    }
  }
  return null;
}

class SchemaMigrationService {
  constructor(options = {}) {
    this.options = { ...DEFAULT_SERVICE_OPTIONS, ...options };
    for (const key of Object.keys(DEFAULT_SERVICE_OPTIONS)) {
      if (!Number.isSafeInteger(this.options[key]) || this.options[key] <= 0) throw error('INVALID_SERVICE_OPTIONS', 'Giới hạn migration không hợp lệ.');
    }
    this.snapshots = new Map();
    this.pendingPlans = new Map();
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
    let blockReason = metadataBlock(source) || metadataBlock(target);
    if (source.scope.profileId === target.scope.profileId && source.database === target.database) blockReason = 'SAME_DATABASE';
    if (source.engine !== target.engine) blockReason = 'CROSS_ENGINE_MIGRATION_UNSUPPORTED';
    if (options.wrapForeignKeys === true) blockReason = 'FOREIGN_KEY_CHECKS_OVERRIDE_UNSUPPORTED';
    let statements = [];
    if (!blockReason) {
      const diff = SchemaDiff.compareSchemas(source, target, {
        ignoreComments: options.ignoreComments === true, ignoreCollation: options.ignoreCollation === true
      });
      statements = SchemaDiff.generateMigrationSql(diff, {
        allowDropTables: options.allowDropTables === true, allowDropColumns: options.allowDropColumns === true
      });
      if (statements.length > this.options.maxStatements || Buffer.byteLength(JSON.stringify(statements)) > this.options.maxPlanBytes) {
        blockReason = 'MIGRATION_PLAN_QUOTA_EXCEEDED';
        statements = [];
      }
    }
    const planToken = crypto.randomBytes(32).toString('hex');
    const plan = freeze({
      planId: `plan_${crypto.randomBytes(16).toString('hex')}`, planToken,
      createdAt: new Date().toISOString(), expiresAt: Date.now() + this.options.planTtlMs,
      sourceSnapshotId, targetSnapshotId, sourceScope: source.scope, targetScope: target.scope,
      status: blockReason ? 'blocked' : 'preview', blockReason,
      applySupported: false, applyBlockReason: APPLY_BLOCK_REASON,
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
      applySupported: false, applyBlockReason: APPLY_BLOCK_REASON,
      sourceScope: projectScope(plan.sourceScope), targetScope: projectScope(plan.targetScope),
      statements: plan.statements, summary: plan.summary
    });
  }

  async applyPlan() {
    // No experimental path may mutate an Editor session or bypass production policy.
    // Implement an isolated, reviewed executor before enabling this entry point.
    throw error(APPLY_BLOCK_REASON, 'Áp dụng migration chưa sẵn sàng. Hiện chỉ hỗ trợ xem trước.');
  }
}

module.exports = { SchemaMigrationService, DEFAULT_SERVICE_OPTIONS, APPLY_BLOCK_REASON };
