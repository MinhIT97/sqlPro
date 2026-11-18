'use strict';

const { DatabaseSession } = require('./database.cjs');
const { quoteId } = require('./data-diff-reader.cjs');

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

class DataSyncExecutor {
  constructor(options = {}) {
    this.consumePlan = options.consumePlan;
    this.getProfileWithSecrets = options.getProfileWithSecrets;
    this.createSession = options.createSession || (profile => new DatabaseSession(profile));
    this.authorizeProduction = options.authorizeProduction;
    this.fingerprintProfile = options.fingerprintProfile;
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

    // 2. Resolve target profile and verify writable
    const targetProfileId = plan.targetScope.profileId;
    const targetProfile = this.getProfileWithSecrets ? this.getProfileWithSecrets(targetProfileId) : null;
    if (!targetProfile) {
      throw error('TARGET_PROFILE_NOT_FOUND', `Không tìm thấy profile đích ${targetProfileId}.`);
    }

    assertWritable(targetProfile);

    // 3. Authorize Production if target is production environment
    if (targetProfile.environment === 'production') {
      if (typeof this.authorizeProduction !== 'function') {
        throw error('PRODUCTION_APPROVAL_REQUIRED', 'Môi trường Production yêu cầu xác thực phê duyệt an toàn.');
      }
      let receipt;
      try {
        receipt = await this.authorizeProduction({ plan, approvalToken });
      } catch (err) {
        if (err && err.code && err.code.startsWith('PRODUCTION_APPROVAL_')) throw err;
        throw error('PRODUCTION_APPROVAL_REQUIRED', err?.message || 'Xác thực phê duyệt Production thất bại.');
      }
      if (!receipt || typeof receipt !== 'object' || receipt.planToken !== plan.planToken) {
        throw error('PRODUCTION_APPROVAL_REQUIRED', 'Phê duyệt Production không hợp lệ hoặc thiếu chứng thực.');
      }
    }

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
      await worker.connect();
      await worker.useDatabase(database);

      // 4. Pre-execution target schema drift verification
      if (plan.tables) {
        for (const [tblName, meta] of Object.entries(plan.tables)) {
          const currentCols = await worker.listColumns(database, tblName, { fresh: true });
          if (!Array.isArray(currentCols) || currentCols.length !== meta.columns.length) {
            throw error('TARGET_SCHEMA_DRIFT', `Cấu trúc bảng đích "${tblName}" đã thay đổi kể từ lúc tạo kế hoạch đồng bộ.`);
          }
          for (let i = 0; i < meta.columns.length; i++) {
            const expected = meta.columns[i];
            const actual = currentCols.find(c => c.name === expected.name);
            if (!actual || actual.type.toLowerCase() !== expected.type.toLowerCase()) {
              throw error('TARGET_SCHEMA_DRIFT', `Cột "${expected.name}" trên bảng đích "${tblName}" đã bị thay đổi kiểu hoặc bị xóa.`);
            }
          }
          const currentPks = currentCols.filter(c => c.key === 'PRI').map(c => c.name);
          if (JSON.stringify(currentPks) !== JSON.stringify(meta.primaryKeys)) {
            throw error('TARGET_SCHEMA_DRIFT', `Khóa chính trên bảng đích "${tblName}" đã thay đổi.`);
          }
        }
      } else {
        const currentColumns = await worker.listColumns(database, table, { fresh: true });
        if (!Array.isArray(currentColumns) || currentColumns.length !== columns.length) {
          throw error('TARGET_SCHEMA_DRIFT', 'Cấu trúc bảng đích đã thay đổi kể từ lúc tạo kế hoạch đồng bộ.');
        }

        for (let i = 0; i < columns.length; i++) {
          const expected = columns[i];
          const actual = currentColumns.find(c => c.name === expected.name);
          if (!actual || actual.type.toLowerCase() !== expected.type.toLowerCase()) {
            throw error('TARGET_SCHEMA_DRIFT', `Cột "${expected.name}" trên bảng đích đã bị thay đổi kiểu hoặc bị xóa.`);
          }
        }

        const currentPks = currentColumns.filter(c => c.key === 'PRI').map(c => c.name);
        if (JSON.stringify(currentPks) !== JSON.stringify(primaryKeys)) {
          throw error('TARGET_SCHEMA_DRIFT', 'Khóa chính trên bảng đích đã thay đổi.');
        }
      }

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
        await worker.raw('START TRANSACTION');

        try {
          for (let opIdx = 0; opIdx < batch.length; opIdx++) {
            if (signal?.aborted) {
              throw error('SYNC_CANCELLED', 'Quá trình đồng bộ đã bị hủy bỏ bởi người dùng.');
            }

            const op = batch[opIdx];
            const opTable = op.table || table;
            const opTableRef = `${quoteId(database)}.${quoteId(opTable)}`;
            const opPks = plan.tables ? plan.tables[opTable].primaryKeys : primaryKeys;

            if (op.type === 'INSERT') {
              const colNames = Object.keys(op.values);
              const colList = colNames.map(quoteId).join(', ');
              const placeholders = colNames.map(() => '?').join(', ');
              const values = colNames.map(c => op.values[c]);
              const sql = `INSERT INTO ${opTableRef} (${colList}) VALUES (${placeholders})`;

              await worker.raw(sql, values, 30000, { prepared: true });
            } else if (op.type === 'UPDATE') {
              const updateCols = op.changedColumns && op.changedColumns.length > 0
                ? op.changedColumns
                : Object.keys(op.values).filter(c => !opPks.includes(c));

              if (updateCols.length === 0) continue;

              const setClauses = updateCols.map(c => `${quoteId(c)} = ?`).join(', ');
              const setValues = updateCols.map(c => op.values[c]);

              // Optimistic concurrency guard with PK
              const whereParts = opPks.map(pk => `${quoteId(pk)} = ?`);
              const whereValues = opPks.map((_, i) => op.pkValues[i]);

              // Guard all original values to detect concurrent drift
              if (op.originalValues && typeof op.originalValues === 'object') {
                for (const [col, origVal] of Object.entries(op.originalValues)) {
                  if (opPks.includes(col)) continue;
                  if (origVal === null || origVal === undefined) {
                    whereParts.push(`${quoteId(col)} IS NULL`);
                  } else {
                    whereParts.push(`${quoteId(col)} = ?`);
                    whereValues.push(origVal);
                  }
                }
              }

              const sql = `UPDATE ${opTableRef} SET ${setClauses} WHERE ${whereParts.join(' AND ')}`;
              const params = [...setValues, ...whereValues];

              const res = await worker.raw(sql, params, 30000, { prepared: true });
              const affected = res.result?.affectedRows ?? 0;
              if (affected === 0) {
                throw error('SYNC_CONFLICT_DETECTED', `Phát hiện xung đột: dòng khóa ${op.rowKey} bảng "${opTable}" đã bị sửa đổi hoặc xóa trên đích kể từ lúc so sánh.`);
              }
            } else if (op.type === 'DELETE') {
              const whereParts = opPks.map(pk => `${quoteId(pk)} = ?`);
              const whereValues = opPks.map((_, i) => op.pkValues[i]);

              // Guard original values on DELETE to prevent deleting concurrently modified rows
              if (op.originalValues && typeof op.originalValues === 'object') {
                for (const [col, origVal] of Object.entries(op.originalValues)) {
                  if (opPks.includes(col)) continue;
                  if (origVal === null || origVal === undefined) {
                    whereParts.push(`${quoteId(col)} IS NULL`);
                  } else {
                    whereParts.push(`${quoteId(col)} = ?`);
                    whereValues.push(origVal);
                  }
                }
              }

              const sql = `DELETE FROM ${opTableRef} WHERE ${whereParts.join(' AND ')}`;
              const res = await worker.raw(sql, whereValues, 30000, { prepared: true });
              const affected = res.result?.affectedRows ?? 0;
              if (affected === 0) {
                throw error('SYNC_CONFLICT_DETECTED', `Phát hiện xung đột: dòng khóa ${op.rowKey} bảng "${opTable}" đã không còn khớp giá trị ban đầu trên đích.`);
              }
            }
          }

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
      const isPartial = Boolean(err.partialCommit) || (committedCount > 0 && committedCount < totalCount);
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
