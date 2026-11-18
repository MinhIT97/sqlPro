'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { SqlScriptParser, skipReason } = require('./sql-script.cjs');
const { RestoreObjectInventory } = require('./restore-object-inventory.cjs');
const { computeSchemaFingerprint } = require('./schema-snapshot.cjs');
const { DatabaseSession } = require('./database.cjs');
const { createRestoreContextPolicy } = require('./restore-context-policy.cjs');

const DEFAULT_PLAN_SERVICE_OPTIONS = Object.freeze({
  planTtlMs: 5 * 60 * 1000,
  maxPendingPlans: 32
});

const error = (code, message) => Object.assign(new Error(message), { code });

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
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

class RestorePlanService {
  constructor(options = {}) {
    this.options = { ...DEFAULT_PLAN_SERVICE_OPTIONS, ...options };
    this.pendingPlans = new Map();
    this.generation = 0;
    this.store = options.store;
    this.createSession = options.createSession || (profile => new DatabaseSession(profile));
    this.fingerprintProfile = options.fingerprintProfile || computeSchemaFingerprint;
  }

  prune() {
    const now = Date.now();
    for (const [token, plan] of this.pendingPlans) {
      if (now >= plan.expiresAt) {
        this.pendingPlans.delete(token);
      }
    }
  }

  clear() {
    this.generation++;
    this.pendingPlans.clear();
  }

  async createSelectiveRestorePlan({
    filePath,
    targetProfileId,
    targetDatabase,
    selection = {},
    dropExisting = false,
    options = {}
  } = {}) {
    const generation = this.generation;
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw error('INVALID_RESTORE_FILE', 'Đường dẫn tệp backup không hợp lệ.');
    }
    if (typeof targetProfileId !== 'string' || !targetProfileId.trim()) {
      throw error('INVALID_TARGET_PROFILE', 'Profile đích không hợp lệ.');
    }
    if (typeof targetDatabase !== 'string' || !targetDatabase.trim() || targetDatabase.includes('\0')) {
      throw error('INVALID_TARGET_DATABASE', 'Cơ sở dữ liệu đích không hợp lệ.');
    }

    let stat;
    try {
      stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) throw new Error('Not a file');
    } catch {
      throw error('RESTORE_FILE_NOT_FOUND', 'Không tìm thấy tệp sao lưu hoặc đường dẫn không phải tệp.');
    }

    if (!this.store || typeof this.store.getWithSecrets !== 'function') {
      throw error('STORE_REQUIRED', 'Store profile bắt buộc phải được cấu hình.');
    }

    const targetProfile = this.store.getWithSecrets(targetProfileId);
    if (!targetProfile) {
      throw error('PROFILE_NOT_FOUND', 'Không tìm thấy cấu hình kết nối đích.');
    }
    const profileFingerprint = this.fingerprintProfile(targetProfile);

    // 1. Stream scan file to extract inventory and calculate checksum
    const inv = new RestoreObjectInventory(targetDatabase);
    const parser = new SqlScriptParser({ rejectDialectComments: true });
    const hash = crypto.createHash('sha256');
    const contextPolicy = createRestoreContextPolicy();
    const contextBlockers = [];
    const inspectStatement = stmt => {
      statementCount++;
      try { contextPolicy.validate(stmt); }
      catch (err) {
        if (contextBlockers.length < 32) contextBlockers.push({ code: 'RESTORE_CONTEXT_UNSUPPORTED', statementNumber: statementCount,
          details: 'Context SQL mode, charset hoặc SET của dump chưa được hỗ trợ cho phục hồi chọn lọc.' });
      }
      inv.addStatement(stmt, statementCount);
    };

    const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
    let statementCount = 0;

    try {
      for await (const chunk of stream) {
        hash.update(chunk);
        for (const stmt of parser.push(chunk)) {
          inspectStatement(stmt);
        }
      }
      for (const stmt of parser.end()) {
        inspectStatement(stmt);
      }
    } catch (err) {
      if (err.code === 'RESTORE_CONTEXT_UNSUPPORTED') throw err;
      throw error('RESTORE_SCAN_FAILED', `Không thể quét tệp backup: ${err.message}`);
    }

    const fileChecksum = hash.digest('hex');

    // 2. Authoritatively collect targetFacts at Main
    let targetFacts = null;
    let workerSession = null;
    try {
      workerSession = this.createSession(runtimeProfile(targetProfile));
      if (workerSession && typeof workerSession.collectRestoreTargetFacts === 'function') {
        if (typeof workerSession.connect === 'function') await workerSession.connect();
        targetFacts = await workerSession.collectRestoreTargetFacts(targetDatabase);
      }
    } catch {
      // If collection fails (e.g. database does not exist or credentials invalid), record minimal facts
      targetFacts = { database: targetDatabase, objects: [], errors: [{ check: 'connect', message: 'Không thể kết nối lấy metadata đích' }] };
    } finally {
      if (workerSession && typeof workerSession.close === 'function') {
        try { await workerSession.close(); } catch {}
      }
    }

    // 3. Generate canonical execution plan with dependency analysis
    const targetId = `mysql://${targetProfile.id}/${targetDatabase}`;
    const generated = inv.generateExecutionPlan({
      selection: {
        tables: Array.isArray(selection.tables) ? selection.tables : null,
        views: Array.isArray(selection.views) ? selection.views : null,
        procedures: Array.isArray(selection.procedures) ? selection.procedures : null,
        functions: Array.isArray(selection.functions) ? selection.functions : null,
        triggers: Array.isArray(selection.triggers) ? selection.triggers : null,
        events: Array.isArray(selection.events) ? selection.events : null,
        includeStructure: selection.includeStructure !== false,
        includeData: selection.includeData !== false
      },
      fileChecksum,
      targetIdentity: targetId,
      targetFacts,
      dropExisting: Boolean(dropExisting)
    });

    const blockers = [...(generated.blockers || []), ...contextBlockers];
    const isReady = generated.canExecute && blockers.length === 0;
    const planToken = crypto.randomBytes(32).toString('hex');
    const planId = `restore_plan_${crypto.randomBytes(16).toString('hex')}`;
    const now = Date.now();
    const expiresAt = now + this.options.planTtlMs;

    const planDigestPayload = JSON.stringify({
      filePath,
      fileChecksum,
      sourceDatabase: inv.database,
      targetScope: {
        profileId: targetProfile.id,
        database: targetDatabase
      },
      selection: generated.selection,
      dropExisting: Boolean(dropExisting),
      order: generated.order || [],
      dropOrder: generated.dropOrder || []
    });
    const planDigest = crypto.createHash('sha256').update(planDigestPayload).digest('hex');

    const plan = freeze({
      kind: 'sqlpro-selective-restore-plan',
      planId,
      planToken,
      planDigest,
      filePath,
      fileStats: {
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeMs: stat.mtimeMs
      },
      fileChecksum,
      sourceDatabase: inv.database,
      targetScope: {
        profileId: targetProfile.id,
        database: targetDatabase,
        engine: targetProfile.engine || 'MySQL',
        profileFingerprint
      },
      selection: structuredClone(generated.selection),
      dropExisting: Boolean(dropExisting),
      order: generated.order || [],
      dropOrder: generated.dropOrder || [],
      steps: generated.steps || [],
      blockers,
      warnings: generated.warnings || [],
      canExecute: isReady,
      status: isReady ? 'ready' : 'blocked',
      applySupported: isReady,
      summary: {
        totalStatements: statementCount,
        candidateSteps: (generated.steps || []).filter(s => s.decision === 'candidate').length,
        excludedSteps: (generated.steps || []).filter(s => s.decision === 'excluded').length,
        blockedSteps: (generated.steps || []).filter(s => s.decision === 'blocked').length
      },
      createdAt: new Date(now).toISOString(),
      expiresAt
    });

    if (generation !== this.generation) throw error('RESTORE_CONTEXT_CHANGED', 'Context phục hồi đã được reset trong khi lập kế hoạch.');
    const freshProfile = this.store.getWithSecrets(targetProfileId);
    if (!freshProfile || freshProfile.id !== targetProfileId || this.fingerprintProfile(freshProfile) !== profileFingerprint) {
      throw error('TARGET_CONTEXT_DRIFT', 'Cấu hình đích đã thay đổi trong khi lập kế hoạch.');
    }
    this.prune();
    if (this.pendingPlans.size >= this.options.maxPendingPlans) {
      this.pendingPlans.delete(this.pendingPlans.keys().next().value);
    }
    this.pendingPlans.set(planToken, plan);

    return this.projectPlanForRenderer(plan);
  }

  getPlan(planToken) {
    this.prune();
    return this.pendingPlans.get(planToken) || null;
  }

  consumePlan(planToken) {
    if (!planToken || typeof planToken !== 'string') {
      throw error('INVALID_PLAN_TOKEN', 'Token kế hoạch phục hồi không hợp lệ.');
    }
    const plan = this.pendingPlans.get(planToken);
    if (!plan) {
      throw error('RESTORE_PLAN_NOT_FOUND', 'Kế hoạch phục hồi không tồn tại.');
    }
    if (Date.now() >= plan.expiresAt) {
      this.pendingPlans.delete(planToken);
      throw error('RESTORE_PLAN_EXPIRED', 'Kế hoạch phục hồi đã hết hạn.');
    }
    // One-time consumption: delete immediately to prevent replay
    this.pendingPlans.delete(planToken);
    this.prune();
    return plan;
  }

  projectPlanForRenderer(plan) {
    return structuredClone({
      kind: plan.kind,
      planId: plan.planId,
      planToken: plan.planToken,
      status: plan.status,
      canExecute: plan.canExecute,
      applySupported: plan.applySupported,
      sourceDatabase: plan.sourceDatabase,
      targetScope: {
        profileId: plan.targetScope.profileId,
        database: plan.targetScope.database,
        engine: plan.targetScope.engine
      },
      selection: plan.selection,
      dropExisting: plan.dropExisting,
      blockers: plan.blockers,
      warnings: plan.warnings,
      summary: plan.summary,
      createdAt: plan.createdAt,
      expiresAt: new Date(plan.expiresAt).toISOString()
    });
  }
}

module.exports = {
  RestorePlanService,
  DEFAULT_PLAN_SERVICE_OPTIONS
};
