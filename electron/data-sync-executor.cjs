'use strict';

const { DatabaseSession } = require('./database.cjs');
const { quoteId } = require('./data-diff-reader.cjs');
const RowValues = require('../row-values.js');
const { normalizeColumnType } = require('../schema-diff.js');
const { computeSchemaFingerprint } = require('./schema-snapshot.cjs');
const { provesMetadataVisibility } = require('./sync-metadata-visibility.cjs');

function error(code, message) {
  return Object.assign(new Error(message), { code });
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

function assertWritable(profile) {
  if (profile?.readOnly === true) {
    throw error('CONNECTION_READ_ONLY', 'Kết nối đang ở chế độ Chỉ đọc (Read-only); thao tác đồng bộ bị từ chối.');
  }
}

function originalGuard(columns, values, names) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw error('SYNC_ORIGINAL_INCOMPLETE', 'Thiếu snapshot giá trị gốc.');
  const parts = [], params = [];
  for (const name of names) {
    const column = columns.find(item => item.name === name);
    if (!column || !Object.hasOwn(values, name) || values[name] === undefined) throw error('SYNC_ORIGINAL_INCOMPLETE', 'Snapshot giá trị gốc thiếu cột.');
    const value = values[name], spec = RowValues.describe(column), kind = spec.kind;
    if (spec.readOnly) throw error('SYNC_ORIGINAL_UNSUPPORTED', 'Cột generated/không gian chưa có contract đồng bộ.');
    if (value === null) { parts.push(`${quoteId(name)} IS NULL`); continue; }
    if (typeof value === 'object' || !['string', 'number', 'boolean', 'bigint'].includes(typeof value)
        || typeof value === 'number' && !Number.isFinite(value)
        || kind === 'binary' || !['json', 'text', 'enum', 'set', 'integer', 'decimal', 'float', 'boolean', 'bit', 'year', 'date', 'time', 'datetime'].includes(kind)) {
      throw error('SYNC_ORIGINAL_UNSUPPORTED', 'Không có bằng chứng so sánh chính xác cho giá trị gốc.');
    }
    if (kind === 'json') {
      if (typeof value !== 'string') throw error('SYNC_ORIGINAL_UNSUPPORTED', 'JSON gốc phải giữ dạng document text.');
      try { JSON.parse(value); } catch { throw error('SYNC_ORIGINAL_UNSUPPORTED', 'JSON gốc không hợp lệ.'); }
      parts.push(`CAST(JSON_EXTRACT(${quoteId(name)}, '$') AS BINARY) <=> CAST(JSON_EXTRACT(?, '$') AS BINARY)`);
    } else if (['text', 'enum', 'set'].includes(kind)) {
      if (typeof value !== 'string') throw error('SYNC_ORIGINAL_UNSUPPORTED', 'Text gốc phải là chuỗi đầy đủ.');
      parts.push(`CAST(${quoteId(name)} AS BINARY) <=> CAST(? AS BINARY)`);
    } else parts.push(`${quoteId(name)} = ?`);
    params.push(value);
  }
  return { parts, params };
}

async function verifyTableSchema(worker, database, table, metadata) {
  const current = await worker.listColumns(database, table, { fresh: true });
  const expected = metadata.columns;
  const failDrift = () => { throw error('TARGET_SCHEMA_DRIFT', 'Cấu trúc/khóa chính của bảng đích đã thay đổi.'); };
  if (!Array.isArray(current) || !Array.isArray(expected) || !expected.length
      || current.length !== expected.length) failDrift();
  for (let i = 0; i < expected.length; i++) {
    const before = expected[i], after = current[i];
    if (!before || !after || before.name !== after.name || typeof before.type !== 'string'
        || typeof after.type !== 'string' || normalizeColumnType(before.type) !== normalizeColumnType(after.type)) failDrift();
    if (/^(?:enum|set)\b/i.test(before.type) && /\\/.test(before.type)) {
      throw error('SYNC_TYPE_SQL_MODE_UNSUPPORTED', 'ENUM/SET có escape chưa có contract SQL mode để đồng bộ.');
    }
    // Compare every semantic fact carried by the trusted plan, not just type.
    // Bounded public previews remain blocked and do not supply write authority.
    for (const field of ['nullable', 'default', 'defaultValue', 'extra', 'collation', 'charset', 'generationExpression', 'isJson', 'checkClause']) {
      if (Object.hasOwn(before, field) && (!Object.hasOwn(after, field) || before[field] !== after[field])) failDrift();
    }
  }
  const keys = current.filter(column => column.key === 'PRI').map(column => column.name);
  if (!Array.isArray(metadata.primaryKeys) || !metadata.primaryKeys.length
      || JSON.stringify(keys) !== JSON.stringify(metadata.primaryKeys)) failDrift();
}

class DataSyncExecutor {
  constructor(options = {}) {
    this.consumePlan = options.consumePlan;
    this.getProfileWithSecrets = options.getProfileWithSecrets;
    this.createSession = options.createSession || (profile => new DatabaseSession(profile));
    this.authorizeProduction = options.authorizeProduction;
    this.fingerprintProfile = options.fingerprintProfile;
    this.getGeneration = options.getGeneration || (() => 0);
  }

  async executeSyncPlan({
    planToken,
    approvalToken,
    signal = null,
    batchSize = 50,
    onProgress = null
  } = {}) {
    if (typeof this.consumePlan !== 'function') {
      throw error('EXECUTOR_UNCONFIGURED', 'Thiếu hàm consumePlan trong executor.');
    }

    // 1. Consume token once
    const plan = this.consumePlan(planToken);
    if (plan.applySupported === false) throw error('SYNC_APPLY_NOT_READY', 'Kế hoạch quan sát chỉ dùng để xem trước.');

    // 2. Resolve target profile and verify writable
    const targetProfileId = plan.targetScope.profileId;
    const targetProfile = structuredClone(this.getProfileWithSecrets ? this.getProfileWithSecrets(targetProfileId) : null);
    if (!targetProfile) {
      throw error('TARGET_PROFILE_NOT_FOUND', `Không tìm thấy profile đích ${targetProfileId}.`);
    }

    assertWritable(targetProfile);
    const generation = this.getGeneration();
    const fullFingerprint = computeSchemaFingerprint(targetProfile);
    const policyFingerprint = this.fingerprintProfile ? this.fingerprintProfile(targetProfile) : fullFingerprint;
    const expiresAt = plan.expiresAt ?? Date.now() + 300000;
    let approval = null;
    const guard = (checkApproval = true) => {
      if (signal?.aborted) throw error('SYNC_CANCELLED', 'Quá trình đồng bộ đã bị hủy bỏ.');
      if (Date.now() >= expiresAt) throw error('SYNC_PLAN_EXPIRED', 'Kế hoạch đồng bộ đã hết hạn.');
      const current = this.getProfileWithSecrets?.(targetProfileId);
      if (!current) throw error('TARGET_PROFILE_NOT_FOUND', 'Profile đích không còn tồn tại.');
      assertWritable(current);
      if (this.getGeneration() !== generation || computeSchemaFingerprint(current) !== fullFingerprint
          || (this.fingerprintProfile ? this.fingerprintProfile(current) : computeSchemaFingerprint(current)) !== policyFingerprint
          || plan.targetScope.profileFingerprint && plan.targetScope.profileFingerprint !== policyFingerprint) {
        throw error('SYNC_CONTEXT_CHANGED', 'Cấu hình hoặc context đồng bộ đã thay đổi; hãy tạo kế hoạch mới.');
      }
      if (checkApproval && current.environment === 'production'
          && (!approval || approval.planToken !== plan.planToken || approval.planDigest !== plan.planDigest
            || approval.targetProfileFingerprint !== policyFingerprint || !Number.isSafeInteger(approval.expiresAt)
            || approval.expiresAt <= Date.now() || approval.expiresAt > expiresAt)) {
        throw error('PRODUCTION_APPROVAL_REQUIRED', 'Phê duyệt Production thiếu, hết hạn hoặc không khớp kế hoạch/đích.');
      }
    };
    const checked = async operation => { guard(); const result = await operation(); guard(); return result; };
    guard(false);

    // 3. Authorize Production if target is production environment
    if (targetProfile.environment === 'production') {
      if (typeof this.authorizeProduction !== 'function') {
        throw error('PRODUCTION_APPROVAL_REQUIRED', 'Môi trường Production yêu cầu xác thực phê duyệt an toàn.');
      }
      let receipt;
      try {
        receipt = await this.authorizeProduction({ plan, approvalToken, targetProfileFingerprint: policyFingerprint });
        guard(false);
      } catch (err) {
        if (err && err.code && err.code.startsWith('PRODUCTION_APPROVAL_')) throw err;
        throw error('PRODUCTION_APPROVAL_REQUIRED', err?.message || 'Xác thực phê duyệt Production thất bại.');
      }
      if (!receipt || typeof receipt !== 'object' || receipt.planToken !== plan.planToken) {
        throw error('PRODUCTION_APPROVAL_REQUIRED', 'Phê duyệt Production không hợp lệ hoặc thiếu chứng thực.');
      }
      approval = structuredClone(receipt);
    }
    guard();

    const { database, table } = plan.targetScope;
    const targetTableRef = `${quoteId(database)}.${quoteId(table)}`;
    const primaryKeys = plan.primaryKeys;
    const columns = plan.columns;

    let worker = null;
    let committedCount = 0;
    const totalCount = plan.operations.length;
    const startedAt = Date.now();

    try {
      worker = this.createSession(runtimeProfile(targetProfile));
      await checked(() => worker.connect());
      await checked(() => worker.useDatabase(database));
      const query = (...args) => checked(() => worker.raw(...args));

      const targetTables = plan.tables ? Object.entries(plan.tables)
        : [[table, { columns, primaryKeys }]];
      const verifyTargetSchema = async () => {
        for (const [name, metadata] of targetTables) {
          await checked(() => verifyTableSchema(worker, database, name, metadata));
        }
      };
      await verifyTargetSchema();

      // 5. Engine and Trigger safety verification (must be InnoDB for rollback guarantees)
      if (typeof worker.raw !== 'function') throw error('SYNC_METADATA_UNVERIFIED', 'Worker thiếu API xác minh metadata.');
      const verifyTargetSafety = async () => {
        let grants;
        try { grants = await query('SHOW GRANTS'); }
        catch (err) {
          if (['SYNC_CONTEXT_CHANGED', 'CONNECTION_READ_ONLY', 'SYNC_CANCELLED', 'SYNC_PLAN_EXPIRED', 'TARGET_PROFILE_NOT_FOUND', 'PRODUCTION_APPROVAL_REQUIRED'].includes(err.code)) throw err;
          throw error('SYNC_METADATA_VISIBILITY_UNVERIFIED', 'Chưa xác minh được quyền đọc dependency/trigger metadata.');
        }
        if (!provesMetadataVisibility(grants?.result)) {
          throw error('SYNC_METADATA_VISIBILITY_UNVERIFIED', 'Cần quyền SELECT và TRIGGER toàn server trực tiếp để xác minh đầy đủ metadata; chưa hỗ trợ quyền qua role/giới hạn.');
        }
        const tablesToCheck = plan.tables ? Object.keys(plan.tables) : [table];
        for (const tName of tablesToCheck) {
          const engineRes = await query(
            'SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
            [database, tName], 30000, { prepared: true }
          );
          const engineRows = engineRes?.result;
          if (!Array.isArray(engineRows) || engineRows.length !== 1
              || typeof (engineRows[0]?.ENGINE ?? engineRows[0]?.engine) !== 'string'
              || !(engineRows[0].ENGINE ?? engineRows[0].engine).trim()) {
            throw error('SYNC_METADATA_UNVERIFIED', `Chưa xác minh được engine của bảng "${tName}".`);
          }
          const engine = (engineRows[0].ENGINE ?? engineRows[0].engine).toUpperCase();
          if (engine !== 'INNODB') {
            throw error('UNSUPPORTED_TABLE_ENGINE', `Chỉ hỗ trợ đồng bộ dữ liệu an toàn với bảng engine InnoDB (bảng "${tName}" sử dụng ${engine}).`);
          }

          const triggerRes = await query(
            'SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? AND EVENT_OBJECT_TABLE = ?',
            [database, tName], 30000, { prepared: true }
          );
          if (!Array.isArray(triggerRes?.result)) throw error('SYNC_METADATA_UNVERIFIED', `Chưa xác minh được triggers của bảng "${tName}".`);
          if (triggerRes.result.length > 0) {
            const names = triggerRes.result.map(t => t.TRIGGER_NAME || t.trigger_name).filter(Boolean).join(', ');
            throw error('TARGET_TABLE_TRIGGERS_DETECTED', `Bảng đích "${tName}" có triggers (${names}). Tác vụ đồng bộ bị chặn để ngăn tác dụng phụ ngoài ý muốn.`);
          }
          // Until dependency closure is part of the authorized plan, any
          // inbound FK is unsupported, even if its child is also selected.
          let relationRes;
          try {
            relationRes = await query(`SELECT CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS
              WHERE UNIQUE_CONSTRAINT_SCHEMA = ? AND REFERENCED_TABLE_NAME = ? LIMIT 1`,
            [database, tName], 30000, { prepared: true });
          } catch (err) {
            if (['SYNC_CONTEXT_CHANGED', 'CONNECTION_READ_ONLY', 'SYNC_CANCELLED', 'SYNC_PLAN_EXPIRED', 'TARGET_PROFILE_NOT_FOUND', 'PRODUCTION_APPROVAL_REQUIRED'].includes(err.code)) throw err;
            throw error('SYNC_METADATA_UNVERIFIED', 'Không xác minh được phụ thuộc FK của bảng đích.');
          }
          if (!Array.isArray(relationRes?.result)) throw error('SYNC_METADATA_UNVERIFIED', 'Metadata FK chưa đầy đủ.');
          if (relationRes.result.length) throw error('SYNC_FOREIGN_KEY_DEPENDENCY_UNSUPPORTED', 'Bảng có FK tham chiếu tới; chưa có kế hoạch kiểm chứng tác động dependency.');
        }
      };

      // 5. Execute in transactional batches
      const effectiveBatchSize = Math.max(1, Math.min(500, Number(batchSize) || 50));
      const batches = [];
      for (let i = 0; i < plan.operations.length; i += effectiveBatchSize) {
        batches.push(plan.operations.slice(i, i + effectiveBatchSize));
      }

      for (let b = 0; b < batches.length; b++) {
        if (signal?.aborted) {
          throw error('SYNC_CANCELLED', 'Quá trình đồng bộ đã bị hủy bỏ bởi người dùng.');
        }

        const batch = batches[b];
        await query('START TRANSACTION');

        try {
          // Open every target table inside this transaction before inspecting
          // engine/triggers, retaining metadata locks until COMMIT/ROLLBACK.
          const tablesToLock = plan.tables ? Object.keys(plan.tables) : [table];
          for (const name of tablesToLock) {
            await query(`SELECT 1 FROM ${quoteId(database)}.${quoteId(name)} LIMIT 0`);
          }
          await verifyTargetSafety();
          await verifyTargetSchema();
          for (let opIdx = 0; opIdx < batch.length; opIdx++) {
            if (signal?.aborted) {
              throw error('SYNC_CANCELLED', 'Quá trình đồng bộ đã bị hủy bỏ bởi người dùng.');
            }

            const op = batch[opIdx];
            const opTable = op.table || table;
            if (!tablesToLock.includes(opTable)) throw error('INVALID_PLAN_SCOPE', 'Thao tác nằm ngoài danh sách bảng đã xác minh.');
            const opTableRef = `${quoteId(database)}.${quoteId(opTable)}`;
            const opPks = plan.tables ? plan.tables[opTable].primaryKeys : primaryKeys;

            if (op.type === 'INSERT') {
              const colNames = Object.keys(op.values);
              const colList = colNames.map(quoteId).join(', ');
              const placeholders = colNames.map(() => '?').join(', ');
              const values = colNames.map(c => op.values[c]);
              const sql = `INSERT INTO ${opTableRef} (${colList}) VALUES (${placeholders})`;

              await query(sql, values, 30000, { prepared: true });
            } else if (op.type === 'UPDATE') {
              const updateCols = op.changedColumns && op.changedColumns.length > 0
                ? op.changedColumns
                : Object.keys(op.values).filter(c => !opPks.includes(c));

              if (updateCols.length === 0) continue;

              const setClauses = updateCols.map(c => `${quoteId(c)} = ?`).join(', ');
              const setValues = updateCols.map(c => op.values[c]);

              const opColumns = plan.tables ? plan.tables[opTable].columns : columns;
              const original = originalGuard(opColumns, op.originalValues, opColumns.map(column => column.name));
              const whereParts = original.parts;
              const whereValues = original.params;

              const sql = `UPDATE ${opTableRef} SET ${setClauses} WHERE ${whereParts.join(' AND ')}`;
              const params = [...setValues, ...whereValues];

              const res = await query(sql, params, 30000, { prepared: true });
              const affected = res.result?.affectedRows ?? 0;
              if (affected !== 1 && affected !== 0) throw error('SYNC_ROW_COUNT_MISMATCH', 'Thao tác phải khớp đúng một dòng; dừng batch.');
              if (affected === 0) {
                throw error('SYNC_CONFLICT_DETECTED', `Phát hiện xung đột: dòng khóa ${op.rowKey} bảng "${opTable}" đã bị sửa đổi hoặc xóa trên đích kể từ lúc so sánh.`);
              }
            } else if (op.type === 'DELETE') {
              const opColumns = plan.tables ? plan.tables[opTable].columns : columns;
              const original = originalGuard(opColumns, op.originalValues, opColumns.map(column => column.name));
              const whereParts = original.parts;
              const whereValues = original.params;

              const sql = `DELETE FROM ${opTableRef} WHERE ${whereParts.join(' AND ')}`;
              const res = await query(sql, whereValues, 30000, { prepared: true });
              const affected = res.result?.affectedRows ?? 0;
              if (affected !== 1 && affected !== 0) throw error('SYNC_ROW_COUNT_MISMATCH', 'Thao tác phải khớp đúng một dòng; dừng batch.');
              if (affected === 0) {
                throw error('SYNC_CONFLICT_DETECTED', `Phát hiện xung đột: dòng khóa ${op.rowKey} bảng "${opTable}" đã không còn khớp giá trị ban đầu trên đích.`);
              }
            }
          }

          await verifyTargetSafety(); // Recheck dependencies after DML while its locks are still held.
          guard();
          try {
            await worker.raw('COMMIT');
            committedCount += batch.length;
          } catch (commitErr) {
            const uncertainErr = Object.assign(new Error(`Lỗi trong lúc xác nhận giao dịch (COMMIT): ${commitErr.message}`), {
              code: commitErr.code || 'SYNC_COMMIT_UNCERTAIN',
              executionUncertain: true,
              partialCommit: true,
              committedCount,
              totalCount
            });
            throw uncertainErr;
          }

          guard();
          if (typeof onProgress === 'function') {
            try {
              const p = onProgress({
                committedCount,
                totalCount,
                percent: Math.round((committedCount / totalCount) * 100)
              });
              if (p && typeof p.catch === 'function') p.catch(() => {});
            } catch {
              // Observer error must NEVER fail an already-committed transaction
            }
          }
        } catch (batchErr) {
          try {
            await worker.raw('ROLLBACK');
          } catch {
            // ignore rollback error
          }
          throw batchErr;
        }
      }

      return {
        success: true,
        committedCount,
        totalCount,
        partialCommit: false,
        durationMs: Date.now() - startedAt
      };
    } catch (err) {
      const isPartial = Boolean(err.partialCommit) || committedCount > 0;
      const enhancedError = Object.assign(new Error(err.message), {
        code: err.code || 'SYNC_EXECUTION_FAILED',
        partialCommit: isPartial,
        executionUncertain: Boolean(err.executionUncertain),
        committedCount: err.committedCount !== undefined ? err.committedCount : committedCount,
        totalCount,
        durationMs: Date.now() - startedAt
      });
      throw enhancedError;
    } finally {
      if (worker) {
        try {
          await worker.close();
        } catch {
          // ignore
        }
      }
    }
  }
}

module.exports = {
  DataSyncExecutor,
  assertWritable
};
