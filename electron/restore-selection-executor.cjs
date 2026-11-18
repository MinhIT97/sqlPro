'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { SqlScriptParser, stripLeadingComments, createTarget, skipReason, assertRestoreSet, parseAlterRename, parseRenameTable, parseDropTargets, parseSetAssignments, evaluateAutocommit } = require('./sql-script.cjs');
const { assertWritable } = require('./connection-policy.cjs');
const { DatabaseSession } = require('./database.cjs');
const { createWorkerGuard } = require('./schema-migration-worker.cjs');
const { assertSupportedRestoreMode, createRestoreContextPolicy } = require('./restore-context-policy.cjs');

const error = (code, message) => Object.assign(new Error(message), { code });

async function computeFileSha256(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
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

const RESTORE_TARGET_PATTERN = new RegExp(
  `^(?:(?:INSERT|REPLACE)\\s+(?:(?:LOW_PRIORITY|DELAYED|HIGH_PRIORITY|IGNORE)\\s+)*(?:INTO\\s+)?|(?:DROP|ALTER|TRUNCATE)\\s+(?:TABLE|VIEW|TRIGGER|PROCEDURE|FUNCTION|EVENT)\\s+(?:IF\\s+EXISTS\\s+)?)` +
  `(?:(\`[^\`]+\`|\\w+)\\s*\\.\\s*)?(\`[^\`]+\`|\\w+)`, 'i'
);

const CREATE_TARGET_PATTERN = new RegExp(
  `^(?:CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:TEMPORARY\\s+)?(?:(?:ALGORITHM\\s*=\\s*\\w+|SQL\\s+SECURITY\\s+(?:DEFINER|INVOKER)|DEFINER\\s*=\\s*(?:\`[^\`]+\`|'[^']+'|"[^"]+"|[A-Za-z0-9_@$]+))\\s+)*(TABLE|VIEW|TRIGGER|PROCEDURE|FUNCTION|EVENT)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?)(?:(\`[^\`]+\`|\\w+)\\s*\\.\\s*)?(\`[^\`]+\`|\\w+)`,
  'i'
);

function unquote(raw) {
  if (!raw) return '';
  return raw.startsWith('`') ? raw.slice(1, -1).replace(/``/g, '`') : raw;
}

function extractObjectName(statement, targetDatabase) {
  const sql = statement.trimStart();
  const createMatch = CREATE_TARGET_PATTERN.exec(sql);
  if (createMatch) {
    const type = createMatch[1].toLowerCase();
    const schema = createMatch[2] ? unquote(createMatch[2]) : null;
    const name = unquote(createMatch[3]);
    if (schema && targetDatabase && schema !== targetDatabase) {
      throw error('RESTORE_CROSS_DATABASE_BLOCKED', `Lệnh CREATE trỏ tới database khác (${schema}), không khớp với database đích (${targetDatabase}).`);
    }
    return { type, schema, name, command: 'CREATE' };
  }

  const match = RESTORE_TARGET_PATTERN.exec(sql);
  if (!match) {
    const created = createTarget(sql);
    if (created) {
      if (created.schema && targetDatabase && created.schema !== targetDatabase) {
        throw error('RESTORE_CROSS_DATABASE_BLOCKED', `Lệnh CREATE trỏ tới database khác (${created.schema}), không khớp với database đích (${targetDatabase}).`);
      }
      return { type: created.type, schema: created.schema || null, name: created.name, command: 'CREATE' };
    }
    return { type: 'unknown', schema: null, name: null };
  }

  const schema = match[1] ? unquote(match[1]) : null;
  const name = unquote(match[2]);
  if (schema && targetDatabase && schema !== targetDatabase) {
    throw error('RESTORE_CROSS_DATABASE_BLOCKED', `Lệnh SQL trỏ tới database khác (${schema}), không khớp với database đích (${targetDatabase}).`);
  }

  const command = (/^([A-Za-z]+)/.exec(sql) || [])[1]?.toUpperCase() || '';
  let type = 'table';
  if (/^DROP\s+(VIEW|TRIGGER|PROCEDURE|FUNCTION|EVENT)\b/i.test(sql)) {
    type = (/^DROP\s+(\w+)/i.exec(sql) || [])[1]?.toLowerCase() || 'table';
  }
  return { type, schema, name, command };
}

class RestoreSelectionExecutor {
  constructor(options = {}) {
    this.options = options;
    this.createSession = options.createSession || (profile => new DatabaseSession(profile));
    this.statementTimeoutMs = options.statementTimeoutMs ?? 60000;
    if (!Number.isSafeInteger(this.statementTimeoutMs) || this.statementTimeoutMs < 1 || this.statementTimeoutMs > 300000) {
      throw error('INVALID_EXECUTOR_OPTIONS', 'Thời gian chờ phục hồi không hợp lệ.');
    }
  }

  async executePlan({ planToken, approvalToken, signal, onSession, onProgress, ...callerFields } = {}) {
    if (signal?.aborted) throw error('QUERY_CANCELED', 'Đã hủy phục hồi.');
    if ('plan' in callerFields || 'steps' in callerFields || 'filePath' in callerFields || 'sql' in callerFields) {
      throw error('CALLER_PLAN_REJECTED', 'Executor chỉ nhận token, không nhận plan từ caller.');
    }
    if (typeof this.options.consumePlan !== 'function' || typeof this.options.getProfileWithSecrets !== 'function' || typeof this.options.fingerprintProfile !== 'function') {
      throw error('EXECUTOR_DEPENDENCY_REQUIRED', 'Thiếu hook quản lý plan và store.');
    }

    // 1. Consume the admitted plan (one-time token)
    const plan = await this.options.consumePlan(planToken);
    if (!plan || plan.status !== 'ready' || plan.canExecute !== true || plan.applySupported !== true) {
      throw error('RESTORE_PLAN_BLOCKED', 'Kế hoạch phục hồi chưa sẵn sàng hoặc bị chặn.');
    }
    if (Date.now() >= plan.expiresAt) {
      throw error('RESTORE_PLAN_EXPIRED', 'Kế hoạch phục hồi đã hết hạn.');
    }

    // 2. Validate target profile & policy
    const targetProfile = this.options.getProfileWithSecrets(plan.targetScope.profileId);
    if (!targetProfile || targetProfile.id !== plan.targetScope.profileId) {
      throw error('PROFILE_NOT_FOUND', 'Không tìm thấy cấu hình kết nối đích.');
    }
    assertWritable(targetProfile);

    if (this.options.fingerprintProfile(targetProfile) !== plan.targetScope.profileFingerprint) {
      throw error('TARGET_CONTEXT_DRIFT', 'Cấu hình kết nối đích đã thay đổi sau khi tạo kế hoạch.');
    }

    // 3. Production approval verification
    if (targetProfile.environment === 'production') {
      if (typeof this.options.authorizeProduction !== 'function') {
        throw error('PRODUCTION_APPROVAL_REQUIRED', 'Phục hồi vào Production yêu cầu phê duyệt bảo mật.');
      }
      let receipt;
      try {
        receipt = await this.options.authorizeProduction({ plan, approvalToken });
      } catch (err) {
        if (err && err.code && err.code.startsWith('PRODUCTION_APPROVAL_')) throw err;
        throw error('PRODUCTION_APPROVAL_REQUIRED', err?.message || 'Xác thực phê duyệt Production thất bại.');
      }
      if (!receipt || typeof receipt !== 'object' || receipt.planToken !== plan.planToken) {
        throw error('PRODUCTION_APPROVAL_REQUIRED', 'Phê duyệt Production không hợp lệ hoặc thiếu chứng thực.');
      }
    }

    // 4. Verify file identity on disk before write & create immutable staging snapshot
    let stat;
    try {
      stat = await fs.promises.stat(plan.filePath);
    } catch {
      throw error('RESTORE_FILE_NOT_FOUND', 'Không tìm thấy tệp sao lưu trên đĩa.');
    }

    if (stat.size !== plan.fileStats.size || stat.mtimeMs !== plan.fileStats.mtimeMs) {
      throw error('RESTORE_FILE_CHANGED', 'Tệp sao lưu đã bị thay đổi trước khi thực thi. Chưa có dữ liệu nào được ghi.');
    }

    if (plan.fileChecksum) {
      const actualChecksum = await computeFileSha256(plan.filePath);
      if (actualChecksum !== plan.fileChecksum) {
        throw error('RESTORE_FILE_CHANGED', 'Nội dung tệp sao lưu đã bị thay đổi (mã băm không khớp). Chưa có dữ liệu nào được ghi.');
      }
    }

    const stagingPath = path.join(os.tmpdir(), `sqlpro-restore-staged-${plan.planToken}-${crypto.randomBytes(8).toString('hex')}.sql`);
    try {
      await fs.promises.copyFile(plan.filePath, stagingPath);
      await fs.promises.chmod(stagingPath, 0o400).catch(() => {});
      if (plan.fileChecksum) {
        const stagingChecksum = await computeFileSha256(stagingPath);
        if (stagingChecksum !== plan.fileChecksum) {
          throw error('RESTORE_FILE_CHANGED', 'Nội dung tệp sao lưu đã bị thay đổi trong quá trình chuẩn bị staging.');
        }
      }
      // Validate the entire staged context before opening a writer or dropping anything.
      const context = createRestoreContextPolicy();
      const preflightParser = new SqlScriptParser({ rejectDialectComments: true });
      for await (const chunk of fs.createReadStream(stagingPath, { encoding: 'utf8', highWaterMark: 64 * 1024 })) {
        if (signal?.aborted) throw error('QUERY_CANCELED', 'Đã hủy phục hồi.');
        for (const stmt of preflightParser.push(chunk)) context.validate(stmt);
      }
      for (const stmt of preflightParser.end()) context.validate(stmt);
    } catch (e) {
      try { await fs.promises.unlink(stagingPath); } catch {}
      throw e;
    }

    // 5. Prepare selection lookup tables (strict exact-case identity)
    const selectedTables = new Set(plan.selection?.tables || []);
    const selectedViews = new Set(plan.selection?.views || []);
    const selectedFunctions = new Set(plan.selection?.functions || []);
    const selectedProcedures = new Set(plan.selection?.procedures || []);
    const selectedTriggers = new Set(plan.selection?.triggers || []);
    const selectedEvents = new Set(plan.selection?.events || []);

    const includeStructure = plan.selection?.includeStructure !== false;
    const includeData = plan.selection?.includeData !== false;

    const isSelected = (type, name) => {
      if (!name) return false;
      if (type === 'table') return selectedTables.has(name);
      if (type === 'view') return selectedViews.has(name);
      if (type === 'function') return selectedFunctions.has(name);
      if (type === 'procedure') return selectedProcedures.has(name);
      if (type === 'trigger') return selectedTriggers.has(name);
      if (type === 'event') return selectedEvents.has(name);
      return false;
    };

    const recheckContext = () => {
      if (signal?.aborted) throw error('QUERY_CANCELED', 'Đã hủy phục hồi.');
      const freshProfile = this.options.getProfileWithSecrets(plan.targetScope.profileId);
      if (!freshProfile || freshProfile.id !== plan.targetScope.profileId) {
        throw error('PROFILE_NOT_FOUND', 'Không tìm thấy cấu hình kết nối đích.');
      }
      assertWritable(freshProfile);
      if (this.options.fingerprintProfile(freshProfile) !== plan.targetScope.profileFingerprint) {
        throw error('TARGET_CONTEXT_DRIFT', 'Cấu hình kết nối đích đã thay đổi sau khi tạo kế hoạch.');
      }
    };

    let worker = null;
    let previousFk = 1;
    let previousSqlMode = '';
    let executedCount = 0;
    let skippedCount = 0;
    let bytesRead = 0;
    let failure = null;

    let autocommitDisabled = false;
    let inTransaction = false;
    let uncommittedWrites = false;
    let targetChanged = false;
    let partialCommit = false;
    let inFlight = null;
    let connected = false;
    let stateCaptured = false;
    let workerGuard = null;
    let cleanupError = null;
    const contextPolicy = createRestoreContextPolicy();

    const guarded = async (actionFn, timeoutMs = this.statementTimeoutMs) => {
      try { return await workerGuard.run(actionFn, timeoutMs); }
      catch (err) {
        if (err.code === 'QUERY_TIMEOUT') throw error('STATEMENT_TIMEOUT', 'Thao tác phục hồi vượt quá thời gian chờ.');
        throw err;
      }
    };

    try {
      worker = this.createSession(runtimeProfile(targetProfile));
      if (!worker || typeof worker.connect !== 'function' || typeof worker.raw !== 'function' || typeof worker.close !== 'function') {
        throw error('INVALID_WORKER_SESSION', 'Worker session phục hồi không hợp lệ.');
      }
      workerGuard = createWorkerGuard(worker, { signal, deadline: Infinity });
      if (typeof onSession === 'function') {
        onSession(worker);
      }

      const runRaw = async (sqlText, params = []) => {
        return await guarded(() => worker.raw(sqlText, params, this.statementTimeoutMs), this.statementTimeoutMs, 'query');
      };

      await guarded(() => worker.connect());
      connected = true;
      recheckContext();

      await guarded(() => worker.useDatabase(plan.targetScope.database), this.statementTimeoutMs || 30000, 'useDatabase');
      recheckContext();

      // TOCTOU check: ensure source file on disk was not modified during connect/USE
      let freshStat;
      try {
        freshStat = await fs.promises.stat(plan.filePath);
      } catch {
        throw error('RESTORE_FILE_CHANGED', 'Tệp sao lưu trên đĩa không còn tồn tại.');
      }
      if (freshStat.size !== plan.fileStats.size || freshStat.mtimeMs !== plan.fileStats.mtimeMs) {
        throw error('RESTORE_FILE_CHANGED', 'Tệp sao lưu trên đĩa đã bị thay đổi trong quá trình kết nối.');
      }
      if (plan.fileChecksum) {
        const freshChecksum = await computeFileSha256(plan.filePath);
        if (freshChecksum !== plan.fileChecksum) {
          throw error('RESTORE_FILE_CHANGED', 'Nội dung tệp sao lưu trên đĩa đã bị thay đổi trong quá trình kết nối.');
        }
      }

      const previous = await runRaw('SELECT @@SESSION.foreign_key_checks AS foreignKeys, @@SESSION.sql_mode AS sqlMode, IF(@@SESSION.autocommit,1,0) AS autocommit');
      recheckContext();
      const sessionState = previous.rows?.[0] || previous.result?.[0];
      const isFlag = value => [0, 1, '0', '1'].includes(value);
      if (!sessionState || !isFlag(sessionState.foreignKeys)
          || !isFlag(sessionState.autocommit) || typeof sessionState.sqlMode !== 'string') {
        throw error('RESTORE_SESSION_STATE_UNKNOWN', 'Không xác minh được SQL mode và transaction context của worker.');
      }
      previousFk = Number(sessionState.foreignKeys);
      previousSqlMode = assertSupportedRestoreMode(sessionState.sqlMode);
      autocommitDisabled = Number(sessionState.autocommit) === 0;
      stateCaptured = true;

      // Pin a compatible client grammar before dump-saved charset variables are read.
      await runRaw('SET NAMES utf8mb4');
      // COMMIT/ROLLBACK without an explicit CHAIN clause must have predictable semantics.
      await runRaw('SET SESSION completion_type=0');
      await runRaw('SET FOREIGN_KEY_CHECKS=0');

      // Drop existing objects if requested
      if (plan.dropExisting && Array.isArray(plan.dropOrder)) {
        for (const item of plan.dropOrder) {
          recheckContext();
          if (isSelected(item.type, item.name)) {
            const kind = item.type.toUpperCase();
            inFlight = { cmd: 'DROP', isDdl: true, isMutating: true };
            await runRaw(`DROP ${kind} IF EXISTS \`${item.name}\``);
            inFlight = null;
            targetChanged = true;
            partialCommit = true;
            uncommittedWrites = false;
            if (!autocommitDisabled) inTransaction = false;
            executedCount++;
          }
        }
      }

      // Stream file execution exclusively from the immutable staged file
      const stream = fs.createReadStream(stagingPath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
      const parser = new SqlScriptParser({ rejectDialectComments: true });

      const executeStatement = async (statement) => {
        recheckContext();
        const text = stripLeadingComments(statement).trim();
        if (!text) return;

        const reason = skipReason(text);
        if (reason === 'USE' || reason === 'database') {
          skippedCount++;
          return;
        }

        const cmd = (/^([A-Za-z]+)/.exec(text) || [])[1]?.toUpperCase() || '';
        if (cmd === 'SET') {
          try {
            assertRestoreSet(text);
          } catch (setErr) {
            throw error('RESTORE_DANGEROUS_STATEMENT', `Lệnh SET không an toàn bị từ chối: ${setErr.message}`);
          }
          contextPolicy.validate(text);
          const parsedSet = parseSetAssignments(text);
          let nextAutocommit = null;
          if (parsedSet && parsedSet.assignments) {
            for (const assign of parsedSet.assignments) {
              if (!assign.isUserVar && ['session', 'local'].includes(assign.scope) && assign.name.toUpperCase() === 'AUTOCOMMIT') {
                const acVal = evaluateAutocommit(assign.valueTokens);
                if (acVal === null) {
                  throw error('RESTORE_DANGEROUS_STATEMENT', 'Biểu thức gán AUTOCOMMIT không thể xác định tĩnh giá trị.');
                }
                nextAutocommit = acVal;
              }
            }
          }
          const enablesAutocommit = nextAutocommit === true && autocommitDisabled;
          const commitsPending = enablesAutocommit && uncommittedWrites;
          if (commitsPending) inFlight = { cmd: 'SET', isCommit: true, isMutating: true };
          await runRaw(text);
          inFlight = null;
          if (nextAutocommit !== null) {
            autocommitDisabled = !nextAutocommit;
            if (enablesAutocommit) {
              if (commitsPending) partialCommit = true;
              uncommittedWrites = false;
              inTransaction = false;
            }
          }
          return;
        }

        if (cmd === 'START' || cmd === 'BEGIN') {
          if (uncommittedWrites) throw error('RESTORE_TRANSACTION_UNSUPPORTED', 'Không mở transaction mới khi transaction phục hồi chưa kết thúc.');
          await runRaw(text);
          inTransaction = true;
          return;
        }

        if (cmd === 'COMMIT') {
          const hadWrites = uncommittedWrites;
          const isChain = /\bCOMMIT(?:\s+WORK)?\s+AND\s+CHAIN\b/i.test(text);
          inFlight = { cmd: 'COMMIT', isCommit: true, isMutating: hadWrites };
          await runRaw(text);
          inFlight = null;
          inTransaction = isChain;
          uncommittedWrites = false;
          if (hadWrites) partialCommit = true;
          executedCount++;
          return;
        }

        if (cmd === 'ROLLBACK') {
          if (/\bTO\b/i.test(text)) throw error('RESTORE_TRANSACTION_UNSUPPORTED', 'ROLLBACK TO SAVEPOINT chưa được hỗ trợ trong phục hồi chọn lọc.');
          const isChain = /\bROLLBACK(?:\s+WORK)?\s+AND\s+CHAIN\b/i.test(text);
          inFlight = { cmd: 'ROLLBACK', isMutating: uncommittedWrites };
          await runRaw(text);
          inFlight = null;
          inTransaction = isChain;
          uncommittedWrites = false;
          return;
        }

        if (cmd === 'DROP') {
          const dropInfo = parseDropTargets(text);
          if (dropInfo) {
            for (const t of dropInfo.targets) {
              if (t.schema && t.schema !== plan.targetScope.database) {
                throw error('RESTORE_CROSS_DATABASE_BLOCKED', `Lệnh DROP trỏ tới database khác (${t.schema}), không khớp với database đích (${plan.targetScope.database}).`);
              }
            }
            const selectedList = dropInfo.targets.filter(t => isSelected(dropInfo.type, t.name));
            if (selectedList.length === 0) {
              skippedCount++;
              return;
            }
            if (selectedList.length < dropInfo.targets.length) {
              const unselected = dropInfo.targets.filter(t => !isSelected(dropInfo.type, t.name)).map(t => t.name).join(', ');
              throw error('RESTORE_MIXED_SELECTION_BLOCKED', `Câu lệnh DROP chứa đối tượng không nằm trong phạm vi lựa chọn phục hồi: ${unselected}.`);
            }
            if (!plan.dropExisting) {
              skippedCount++;
              return;
            }
            inFlight = { cmd: 'DROP', isDdl: true, isMutating: true };
            await runRaw(text);
            inFlight = null;
            targetChanged = true;
            partialCommit = true;
            uncommittedWrites = false;
            if (!autocommitDisabled) inTransaction = false;
            executedCount++;
            return;
          }
        }

        if (cmd === 'ALTER') {
          const alterRename = parseAlterRename(text);
          if (alterRename) {
            if (alterRename.source?.schema && alterRename.source.schema !== plan.targetScope.database) {
              throw error('RESTORE_CROSS_DATABASE_BLOCKED', `Lệnh ALTER TABLE trỏ tới database khác (${alterRename.source.schema}), không khớp database đích (${plan.targetScope.database}).`);
            }
            const allDests = alterRename.destinations && alterRename.destinations.length > 0
              ? alterRename.destinations
              : (alterRename.destination ? [alterRename.destination] : []);
            for (const dst of allDests) {
              if (dst?.schema && dst.schema !== plan.targetScope.database) {
                throw error('RESTORE_CROSS_DATABASE_BLOCKED', `Lệnh ALTER TABLE RENAME trỏ tới database khác (${dst.schema}), không khớp database đích (${plan.targetScope.database}).`);
              }
            }
            const srcSelected = isSelected('table', alterRename.source.name);
            if (allDests.length > 0) {
              for (const dst of allDests) {
                const dstSelected = isSelected('table', dst.name);
                if (srcSelected !== dstSelected) {
                  throw error('RESTORE_MIXED_SELECTION_BLOCKED', `Lệnh ALTER TABLE RENAME thay đổi đối tượng ngoài phạm vi lựa chọn: ${srcSelected ? dst.name : alterRename.source.name}.`);
                }
              }
              if (srcSelected) {
                if (!includeStructure) {
                  skippedCount++;
                  return;
                }
                inFlight = { cmd: 'ALTER', isDdl: true, isMutating: true };
                await runRaw(text);
                inFlight = null;
                targetChanged = true;
                partialCommit = true;
                uncommittedWrites = false;
                if (!autocommitDisabled) inTransaction = false;
                executedCount++;
                return;
              } else {
                skippedCount++;
                return;
              }
            } else {
              if (srcSelected) {
                if (!includeStructure) {
                  skippedCount++;
                  return;
                }
                inFlight = { cmd: 'ALTER', isDdl: true, isMutating: true };
                await runRaw(text);
                inFlight = null;
                targetChanged = true;
                partialCommit = true;
                uncommittedWrites = false;
                if (!autocommitDisabled) inTransaction = false;
                executedCount++;
                return;
              } else {
                skippedCount++;
                return;
              }
            }
          }
        }

        if (cmd === 'RENAME') {
          const renameTable = parseRenameTable(text);
          if (renameTable && renameTable.pairs.length > 0) {
            for (const pair of renameTable.pairs) {
              if (pair.source?.schema && pair.source.schema !== plan.targetScope.database) {
                throw error('RESTORE_CROSS_DATABASE_BLOCKED', `Lệnh RENAME TABLE trỏ tới database khác (${pair.source.schema}), không khớp database đích (${plan.targetScope.database}).`);
              }
              if (pair.destination?.schema && pair.destination.schema !== plan.targetScope.database) {
                throw error('RESTORE_CROSS_DATABASE_BLOCKED', `Lệnh RENAME TABLE trỏ tới database khác (${pair.destination.schema}), không khớp database đích (${plan.targetScope.database}).`);
              }
            }
            const allSelected = renameTable.pairs.every(p => isSelected('table', p.source.name) && isSelected('table', p.destination.name));
            const noneSelected = renameTable.pairs.every(p => !isSelected('table', p.source.name) && !isSelected('table', p.destination.name));
            if (allSelected) {
              if (!includeStructure) {
                skippedCount++;
                return;
              }
              inFlight = { cmd: 'RENAME', isDdl: true, isMutating: true };
              await runRaw(text);
              inFlight = null;
              targetChanged = true;
              partialCommit = true;
              uncommittedWrites = false;
              if (!autocommitDisabled) inTransaction = false;
              executedCount++;
              return;
            } else if (!noneSelected) {
              throw error('RESTORE_MIXED_SELECTION_BLOCKED', 'Lệnh RENAME TABLE chứa các bảng nằm ngoài phạm vi lựa chọn.');
            } else {
              skippedCount++;
              return;
            }
          }
        }

        const target = extractObjectName(text, plan.targetScope.database);
        if (target.name && isSelected(target.type, target.name)) {
          if (cmd === 'DROP' && !plan.dropExisting) {
            skippedCount++;
            return;
          }
          if (cmd === 'CREATE' && !includeStructure) {
            skippedCount++;
            return;
          }
          if ((cmd === 'INSERT' || cmd === 'REPLACE') && !includeData) {
            skippedCount++;
            return;
          }

          // Execute selected statement!
          const isDdl = ['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME'].includes(cmd);
          const isMutating = ['INSERT', 'REPLACE', 'UPDATE', 'DELETE'].includes(cmd);
          inFlight = { cmd, isDdl, isMutating };
          await runRaw(text);
          inFlight = null;
          targetChanged = true;

          if (isDdl) {
            partialCommit = true;
            uncommittedWrites = false;
            if (!autocommitDisabled) inTransaction = false;
          } else if (isMutating) {
            if (autocommitDisabled || inTransaction) {
              uncommittedWrites = true;
            } else {
              partialCommit = true;
            }
          }
          executedCount++;
        } else {
          // Statement belongs to an unselected object, or unknown command: skip!
          skippedCount++;
        }
      };

      for await (const chunk of stream) {
        recheckContext();
        bytesRead += Buffer.byteLength(chunk, 'utf8');
        for (const statement of parser.push(chunk)) {
          await executeStatement(statement);
        }
        if (typeof onProgress === 'function') {
          try {
            const p = onProgress({
              executedCount,
              skippedCount,
              bytesRead,
              totalBytes: stat.size
            });
            if (p && typeof p.catch === 'function') p.catch(() => {});
          } catch {}
        }
      }

      for (const statement of parser.end()) {
        await executeStatement(statement);
      }

      if (uncommittedWrites) {
        throw error('RESTORE_UNCOMMITTED_TRANSACTION', 'Tệp sao lưu chứa giao dịch chưa COMMIT (tắt AUTOCOMMIT hoặc COMMIT AND CHAIN). Dữ liệu chưa được ghi nhận bền vững.');
      }

      if (typeof onProgress === 'function') {
        try {
          const p = onProgress({
            executedCount,
            skippedCount,
            bytesRead,
            totalBytes: stat.size
          });
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch {}
      }
    } catch (err) {
      failure = err;
      if (inFlight) {
        failure.inFlight = inFlight;
      }
    } finally {
      try { await fs.promises.unlink(stagingPath); } catch {}
      if (worker) {
        if (connected && stateCaptured) {
          try { await guarded(() => worker.raw(`SET FOREIGN_KEY_CHECKS=${previousFk}`), 2000, 'cleanup'); } catch {}
          try { await guarded(() => worker.raw('SET SESSION sql_mode=?', [previousSqlMode]), 2000, 'cleanup'); } catch {}
        }
        try {
          if (workerGuard) await workerGuard.close();
          else await worker.close();
        } catch { cleanupError = 'RESTORE_WORKER_CLOSE_FAILED'; }
      }
    }

    if (failure || cleanupError) {
      failure ||= error(cleanupError, 'Không thể xác nhận worker phục hồi đã đóng an toàn.');
      const finalError = failure.code ? failure : error('RESTORE_EXECUTION_FAILED', failure.message || 'Thực thi phục hồi thất bại.');
      finalError.executedCount = executedCount;
      finalError.skippedCount = skippedCount;
      const hadInFlightDdl = Boolean(failure.inFlight?.isDdl);
      const hadInFlightMutating = Boolean(failure.inFlight?.isMutating);
      const hadInFlightCommit = Boolean(failure.inFlight?.isCommit);

      finalError.targetChanged = targetChanged || hadInFlightDdl || hadInFlightMutating;
      finalError.partialCommit = partialCommit || hadInFlightDdl || hadInFlightMutating || hadInFlightCommit;
      if (hadInFlightDdl || hadInFlightMutating || hadInFlightCommit) {
        finalError.executionUncertain = true;
        finalError.targetChanged = true;
        finalError.partialCommit = true;
      }
      if (cleanupError) finalError.cleanupError = cleanupError;
      throw finalError;
    }

    return {
      success: true,
      executedCount,
      skippedCount,
      targetChanged: targetChanged || executedCount > 0,
      partialCommit: false
    };
  }
}

module.exports = {
  RestoreSelectionExecutor,
  extractObjectName,
  parseDropTargets
};
