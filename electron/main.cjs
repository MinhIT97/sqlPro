'use strict';

require('./main-errors.cjs').installMainErrorHandlers();

const { app, BrowserWindow, Menu, dialog, ipcMain, screen, shell, clipboard } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { serialize, deserialize } = require('node:v8');
const { pathToFileURL } = require('node:url');

const store = require('./store.cjs');
const { createTablePreferences } = require('./table-preferences.cjs');
let tablePreferencesRepository;
function tablePreferences() {
  if (!tablePreferencesRepository) tablePreferencesRepository = createTablePreferences(app.getPath('userData'));
  return tablePreferencesRepository;
}
const { createAuditLogStore } = require('./audit-log.cjs');
let auditLogRepository;
function auditLog() {
  if (!auditLogRepository) auditLogRepository = createAuditLogStore(app.getPath('userData'));
  return auditLogRepository;
}
const sync = require('./sync.cjs');
const { parseNavicatFile } = require('./navicat.cjs');
const { DatabaseSession, testConnection, previewImportFile, normalizeFileFormat } = require('./database.cjs');
const { saveBackupFile, manifestPathFor, fileIdentity } = require('./backup-file.cjs');
const { SessionRegistry } = require('./session-registry.cjs');
const { assertWritable, assertReadOnlySql, analyzeProductionSqlRisks } = require('./connection-policy.cjs');
const { ProductionApprovals, redactSql, parameterSummary } = require('./production-approvals.cjs');
const productionApprovals = new ProductionApprovals();
const { BackupInspection } = require('./backup-inspection.cjs');
const { runRestoreTrial, createTrialControl } = require('./restore-trial.cjs');
const { createTrialJournal, cleanupTrialDatabase, targetIdentity } = require('./restore-trial-journal.cjs');
const { normalizeRetentionPolicy } = require('./backup-retention.cjs');
const { withAnnotationLock } = require('./backup-annotations.cjs');
const { createRetentionStore } = require('./backup-retention-store.cjs');
const { createRetentionHistory } = require('./backup-retention-history.cjs');
const { exportRetentionHistory } = require('./backup-retention-export.cjs');
const { runAutomaticRetention } = require('./backup-retention-auto.cjs');
const { createScheduleStore, BackupScheduler, scheduleId, validateSchedule } = require('./backup-scheduler.cjs');
const { previewRestoreSelection } = require('./restore-selection.cjs');
const { collectSelectionTargetFacts, buildSelectionTargetPreview } = require('./restore-selection-target.cjs');
const { buildSelectionDraft } = require('./restore-selection-plan.cjs');
const { normalizeConflictPolicy } = require('./restore-selection-policy.cjs');
const { stripLeadingComments, SqlScriptParser } = require('./sql-script.cjs');
const { RestoreObjectInventory } = require('./restore-object-inventory.cjs');
const { RestoreDependencyGraph } = require('./restore-dependency-graph.cjs');
const { validateAnalyzeSource, buildAnalyzeQuery, assertAnalyzeSession, assertPlanExport } = require('./query-analyze.cjs');
const { explainSettings, explainSchema } = require('../query-results.js');
const {
  SchemaSnapshotCollector,
  projectSnapshotForRenderer
} = require('./schema-snapshot.cjs');
const { SchemaMigrationService } = require('./schema-migration-service.cjs');
const {
  SchemaMigrationAdmission,
  SchemaMigrationApproval,
  createMainContextHooks,
  createSourceVerifier
} = require('./schema-migration-admission.cjs');
const { SchemaMigrationJobManager } = require('./schema-migration-jobs.cjs');
const { SchemaMigrationOrchestrator } = require('./schema-migration-orchestrator.cjs');
const schemaMigrationService = new SchemaMigrationService();
const schemaMigrationAdmission = new SchemaMigrationAdmission();
const schemaMigrationApproval = new SchemaMigrationApproval();
const schemaMigrationJobManager = new SchemaMigrationJobManager();
let scheduleServices;
let schedulerReady = false;
let backupContextGeneration = 0;

function backupSchedules() {
  if (scheduleServices) return scheduleServices;
  const repository = createScheduleStore(app.getPath('userData'));
  const scheduler = new BackupScheduler({ repository, isBusy: () => Boolean(activeDatabaseTransfer), run: runScheduledBackup });
  scheduleServices = { repository, scheduler };
  return scheduleServices;
}

function stopBackupSchedules() {
  backupContextGeneration++;
  schemaMigrationService.clear();
  schemaMigrationAdmission.clear();
  schemaMigrationApproval.clear();
  schemaMigrationJobManager.clear();
  schemaMigrationOrchestrator?.clear();
  dataDiffService?.clear();
  dataSyncPlanService?.clear();
  restorePlanService?.clear();
  operationApprovalManager?.clear();
  backupInspection.invalidate?.();
  scheduleServices?.scheduler.stop();
  if (activeDatabaseTransfer?.scheduleId || ['backup-retention', 'backup-selection-preview', 'selective-restore', 'restore-selective', 'data-sync'].includes(activeDatabaseTransfer?.operation)) {
    cancelDatabaseTransfer(activeDatabaseTransfer);
  }
}

async function runScheduledBackup(schedule, taskId) {
  const scope = { operation: 'backup', scheduled: true, taskId, profileId: schedule.profileId, database: schedule.database };
  try {
    const result = await runCatalogBackup(scope, schedule);
    sendDbProgress({ ...scope, stage: 'scheduled-finish', status: result.canceled ? 'canceled' : 'completed',
      needsReview: Boolean(result.manifestError || ['failed', 'stopped'].includes(result.retention?.status) || result.retention?.historySaveError) });
    return result;
  } catch (error) {
    sendDbProgress({ ...scope, stage: 'scheduled-finish', status: 'failed' });
    throw error;
  }
}
const { BackupRetentionApply } = require('./backup-retention-apply.cjs');
let retentionApplyService;
function retentionApply() {
  if (!retentionApplyService) retentionApplyService = new BackupRetentionApply({ root: app.getPath('userData') });
  return retentionApplyService;
}
const backupInspection = new BackupInspection({
  stat:(filePath)=>fs.promises.stat(filePath),
  scan:(options)=>new DatabaseSession({}).scanRestoreInventoryInWorker({...options,dropExisting:false,selectionPreview:true})
});

const { RestorePlanService } = require('./restore-plan-service.cjs');
const { RestoreSelectionExecutor } = require('./restore-selection-executor.cjs');

class OperationApprovalManager {
  constructor(options = {}) {
    this.pending = new Map();
    this.now = options.now || (() => Date.now());
  }

  clear() {
    this.pending.clear();
  }

  prune() {
    const now = this.now();
    for (const [token, item] of this.pending) {
      if (now >= item.expiresAt) this.pending.delete(token);
    }
  }

  async requestApproval({ planType, plan, targetProfile, showConfirmDialog }) {
    if (!plan || !targetProfile) throw new Error('Dữ liệu yêu cầu phê duyệt không hợp lệ.');
    if (targetProfile.environment !== 'production') {
      throw new Error('Chỉ yêu cầu phê duyệt khi thao tác trên môi trường Production.');
    }
    assertWritable(targetProfile);
    if (!plan.planToken || !plan.planDigest) {
      throw new Error('Kế hoạch thiếu planToken hoặc planDigest hợp lệ.');
    }
    let confirmed = false;
    if (typeof showConfirmDialog === 'function') {
      const res = await showConfirmDialog({
        type: 'warning',
        title: `Xác nhận thao tác Production [${planType}]`,
        message: `Bạn có chắc chắn muốn thực thi thao tác [${planType}] trên CSDL Production "${targetProfile.name || targetProfile.id}" không?`,
        buttons: ['Hủy bỏ', 'Xác nhận thực thi'],
        defaultId: 0,
        cancelId: 0
      });
      if (typeof res === 'boolean') {
        confirmed = res;
      } else if (res && typeof res === 'object') {
        confirmed = res.response === 1;
      }
    }
    if (!confirmed) {
      return { approvalToken: null, canceled: true };
    }

    const hashPlanPayload = (p) => {
      if (!p) return '';
      const obj = {
        planToken: p.planToken,
        planDigest: p.planDigest,
        targetScope: p.targetScope,
        operations: p.operations,
        steps: p.steps,
        selection: p.selection
      };
      return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
    };

    this.prune();
    const approvalToken = crypto.randomBytes(24).toString('hex');
    const expiresAt = Math.min(plan.expiresAt || (this.now() + 120000), this.now() + 120000);
    this.pending.set(approvalToken, {
      approvalToken,
      planType,
      planToken: plan.planToken,
      planDigest: plan.planDigest,
      planPayloadHash: hashPlanPayload(plan),
      targetProfileId: targetProfile.id,
      targetProfileFingerprint: plan.targetScope?.profileFingerprint,
      expiresAt
    });
    return { approvalToken, expiresAt, canceled: false };
  }

  authorizeProduction({ planType, plan, approvalToken }) {
    if (!approvalToken || typeof approvalToken !== 'string') {
      return null;
    }
    this.prune();
    const entry = this.pending.get(approvalToken);
    this.pending.delete(approvalToken);
    if (!entry || entry.expiresAt <= this.now()) {
      return null;
    }
    const hashPlanPayload = (p) => {
      if (!p) return '';
      const obj = {
        planToken: p.planToken,
        planDigest: p.planDigest,
        targetScope: p.targetScope,
        operations: p.operations,
        steps: p.steps,
        selection: p.selection
      };
      return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
    };
    if (entry.planType !== planType || entry.planToken !== plan.planToken || entry.planDigest !== plan.planDigest
        || entry.targetProfileId !== plan.targetScope?.profileId
        || entry.targetProfileFingerprint !== plan.targetScope?.profileFingerprint
        || entry.planPayloadHash !== hashPlanPayload(plan)) {
      return null;
    }
    return Object.freeze({
      planToken: plan.planToken,
      planDigest: plan.planDigest,
      authorizedAt: this.now(),
      targetProfileFingerprint: entry.targetProfileFingerprint,
      expiresAt: entry.expiresAt
    });
  }
}

const operationApprovalManager = new OperationApprovalManager();

const restorePlanService = new RestorePlanService({
  store,
  createSession: (profile) => new DatabaseSession(profile),
  fingerprintProfile: (p) => productionProfileFingerprint(p)
});

const restoreSelectionExecutor = new RestoreSelectionExecutor({
  consumePlan: (token) => restorePlanService.consumePlan(token),
  getProfileWithSecrets: (id) => store.getWithSecrets(id),
  fingerprintProfile: (p) => productionProfileFingerprint(p),
  authorizeProduction: async ({ plan, approvalToken }) => {
    const receipt = operationApprovalManager.authorizeProduction({ planType: 'selective-restore', plan, approvalToken });
    if (!receipt) {
      const err = new Error('Thiếu token phê duyệt Production gắn với kế hoạch.');
      err.code = 'PRODUCTION_APPROVAL_REQUIRED';
      throw err;
    }
    return receipt;
  },
  createSession: (profile) => new DatabaseSession(profile)
});

const { DataDiffService } = require('./data-diff-service.cjs');
const dataDiffService = new DataDiffService({
  store,
  createSession: (profile) => new DatabaseSession(profile)
});

const { DataSyncPlanService } = require('./data-sync-plan-service.cjs');
const { DataSyncExecutor } = require('./data-sync-executor.cjs');

const dataSyncPlanService = new DataSyncPlanService({ store, dataDiffService });
const dataSyncExecutor = new DataSyncExecutor({
  getGeneration: () => backupContextGeneration,
  consumePlan: (token) => dataSyncPlanService.consumePlan(token),
  getProfileWithSecrets: (id) => store.getWithSecrets(id),
  fingerprintProfile: (p) => productionProfileFingerprint(p),
  authorizeProduction: async ({ plan, approvalToken }) => {
    const receipt = operationApprovalManager.authorizeProduction({ planType: 'data-sync', plan, approvalToken });
    if (!receipt) {
      const err = new Error('Thiếu token phê duyệt Production gắn với kế hoạch.');
      err.code = 'PRODUCTION_APPROVAL_REQUIRED';
      throw err;
    }
    return receipt;
  },
  createSession: (profile) => new DatabaseSession(profile)
});

const { BackupReplicaManager } = require('./backup-replica-manager.cjs');
const { inspectBackupContainer, encryptBackupFile, decryptBackupFile } = require('./backup-crypto.cjs');
const backupReplicaManager = new BackupReplicaManager();
const { backupDirectory, backupName, listBackups, resolveBackup, copyBackup, verifyBackup, renameBackup, updateBackupAnnotations, deleteBackup } = require('./backup-catalog.cjs');

const MAX_RENDERER_STATE_BYTES = 2 * 1024 * 1024;
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const MAX_EXPORT_BYTES = 50 * 1024 * 1024;

let mainWindow;
let isQuitting = false;
let activeSession = null;
const MAX_OPEN_SESSIONS = 8;
const sessionRegistry = new SessionRegistry({
  limit: MAX_OPEN_SESSIONS,
  isProtected: (entry) => entry === activeSession,
  create: async (profileId, options) => {
    const stored = store.getWithSecrets(profileId);
    const fingerprint = sessionProfileFingerprint(stored);
    const profile = runtimeProfile(stored);
    if (options.sshHostKey) profile.ssh = { ...profile.ssh, knownHostKey: options.sshHostKey };
    const session = new DatabaseSession(profile);
    try {
      await session.connect();
      if (sessionProfileFingerprint(store.getWithSecrets(profileId)) !== fingerprint) throw profileTargetChanged();
      if (options.sshHostKey) {
        try { store.trustSshHostKey(profileId, options.sshHostKey); } catch { /* Ask again next time if trust cannot be stored. */ }
      }
      return { profileId, session, sessionId: crypto.randomUUID(), profileFingerprint: sessionProfileFingerprint(store.getWithSecrets(profileId)) };
    } catch (error) { await session.close().catch(() => {}); throw error; }
  }
});
const openSessions = sessionRegistry.entries;
let activeDatabaseTransfer = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

function jsonPath(fileName) {
  return path.join(app.getPath('userData'), fileName);
}

function readJson(fileName, fallback) {
  try {
    return JSON.parse(fs.readFileSync(jsonPath(fileName), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(fileName, value) {
  const serialized = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(serialized) > MAX_RENDERER_STATE_BYTES) {
    throw new Error('Dữ liệu cài đặt vượt quá giới hạn cho phép.');
  }
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  const target = jsonPath(fileName);
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, serialized, 'utf8');
  fs.renameSync(temporary, target);
}

function getWindowOptions() {
  const saved = readJson('window-state.json', {});
  const area = screen.getPrimaryDisplay().workArea;
  const width = Number.isFinite(saved.width) ? Math.max(1024, Math.min(saved.width, area.width)) : 1280;
  const height = Number.isFinite(saved.height) ? Math.max(650, Math.min(saved.height, area.height)) : 800;
  const positionIsVisible = Number.isFinite(saved.x) && Number.isFinite(saved.y)
    && saved.x < area.x + area.width - 80
    && saved.y < area.y + area.height - 80
    && saved.x + width > area.x + 80
    && saved.y + height > area.y + 80;

  return {
    width,
    height,
    ...(positionIsVisible ? { x: saved.x, y: saved.y } : {}),
    maximized: Boolean(saved.maximized)
  };
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.isMaximized() ? mainWindow.getNormalBounds() : mainWindow.getBounds();
  writeJson('window-state.json', { ...bounds, maximized: mainWindow.isMaximized() });
}

function sendCommand(command) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('menu:command', command);
  }
}

function sendDbProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('db:progress', payload);
  }
}

function transferLabel(operation) {
  return {
    backup: 'sao lưu',
    restore: 'phục hồi',
    import: 'nhập dữ liệu',
    export: 'xuất dữ liệu',
    'backup-retention': 'dọn backup cục bộ',
    'backup-selection-preview': 'kiểm tra metadata đích'
  }[operation] || 'database';
}

function claimDatabaseTransfer(details) {
  if (activeDatabaseTransfer) throw new Error('Một tác vụ database đang chạy. Hãy đợi tác vụ hoàn tất.');
  const controller = new AbortController();
  const transfer = { canceled: false, pending: false, controller, cancelController: controller, ...details };
  activeDatabaseTransfer = transfer;
  return transfer;
}

function resolveProfileId(profileId) {
  const id = typeof profileId === 'string' && profileId ? profileId : activeSession?.profileId;
  if (!id) throw new Error('Chưa kết nối database.');
  return id;
}

function checkConnectionPolicy(profileId, sql) {
  const id = resolveProfileId(profileId);
  const profile = store.getWithSecrets(id);
  if (sql === undefined) assertWritable(profile);
  else assertReadOnlySql(profile, sql);
  return id;
}

function productionProfileFingerprint(profile) {
  return crypto.createHash('sha256').update(serialize({
    id:profile.id,name:profile.name,host:profile.host,port:profile.port,user:profile.user,database:profile.database,
    ssh:profile.ssh,ssl:profile.ssl,
    environment:profile.environment,readOnly:profile.readOnly,updatedAt:profile.updatedAt
  })).digest('hex');
}

function sessionProfileFingerprint(profile) {
  return crypto.createHash('sha256').update(serialize({ target: targetIdentity(profile), database: profile.database,
    password: profile.password, sshPassword: profile.sshPassword, sshPassphrase: profile.sshPassphrase })).digest('hex');
}

function profileTargetChanged() {
  return Object.assign(new Error('Đích hoặc thông tin đăng nhập đã thay đổi. Phiên đang mở vẫn thuộc cấu hình cũ. Có thể Rollback transaction hiện tại; hãy chủ động ngắt kết nối và kết nối lại trước khi chạy tiếp.'), { code: 'PROFILE_TARGET_CHANGED' });
}

function assertSessionProfile(current) {
  if (sessionProfileFingerprint(store.getWithSecrets(current.profileId)) !== current.profileFingerprint) throw profileTargetChanged();
}

const schemaMigrationContextHooks = createMainContextHooks({
  store,
  openSessions,
  sessionRegistry,
  getGeneration: () => backupContextGeneration,
  fingerprintProfile: productionProfileFingerprint,
  sessionFingerprint: sessionProfileFingerprint,
  assertProfile: assertSessionProfile,
  ownsLease: (jobId, plan, entry) => schemaMigrationJobManager.ownsLease(jobId, plan, entry)
});
const schemaMigrationSourceVerifier = createSourceVerifier({
  store,
  createSession: (profile) => new DatabaseSession(profile),
  createCollector: (session, context) => new SchemaSnapshotCollector(session, context),
  fingerprintProfile: productionProfileFingerprint,
  checkContext: (sourceScope) => {
    const currentGeneration = typeof backupContextGeneration === 'number' ? backupContextGeneration : 0;
    if (sourceScope.generation !== currentGeneration) return false;
    const profile = store.getWithSecrets(sourceScope.profileId);
    if (!profile || profile.id !== sourceScope.profileId) return false;
    if (productionProfileFingerprint(profile) !== sourceScope.profileFingerprint) return false;
    const entry = openSessions.get(sourceScope.profileId);
    if (!entry || entry.sessionId !== sourceScope.sessionId || entry.session?.dead) return false;
    try { assertSessionProfile(entry); } catch { return false; }
    if (entry.session?.inTransaction || entry.session?.autocommit === false || entry.session?.activeTask || entry.exclusiveOperation || entry.productionWriteInProgress) return false;
    return true;
  }
});
schemaMigrationApproval.getProfileWithSecrets = (id) => store.getWithSecrets(id);
schemaMigrationApproval.fingerprintProfile = productionProfileFingerprint;
schemaMigrationApproval.checkContext = (plan) => schemaMigrationContextHooks.checkContext(plan);
schemaMigrationApproval.getGeneration = () => backupContextGeneration;
schemaMigrationApproval.showConfirmDialog = async (dialogOptions) => {
  return dialog.showMessageBox(mainWindow, {
    ...dialogOptions,
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
};

const schemaMigrationOrchestrator = new SchemaMigrationOrchestrator({
  store,
  sessionRegistry,
  openSessions,
  getGeneration: () => backupContextGeneration,
  productionProfileFingerprint,
  sessionProfileFingerprint,
  assertSessionProfile,
  createSession: (profile) => new DatabaseSession(profile),
  createCollector: (session, context) => new SchemaSnapshotCollector(session, context),
  showConfirmDialog: async (dialogOptions) => {
    return dialog.showMessageBox(mainWindow, {
      ...dialogOptions,
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
  },
  sendProgress: sendDbProgress,
  admission: schemaMigrationAdmission,
  approval: schemaMigrationApproval,
  jobManager: schemaMigrationJobManager
});

async function confirmProductionTransfer(profileId, database, filePath, operation, details) {
  const profile = store.getWithSecrets(profileId);
  if (profile.environment !== 'production') return true;
  checkConnectionPolicy(profileId);
  const identity = (stats) => `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
  const before = await fs.promises.stat(filePath);
  if (!before.isFile()) throw new Error('Nguồn dữ liệu không phải tệp.');
  const fingerprint = productionProfileFingerprint(profile);
  const started = Date.now();
  const response = await dialog.showMessageBox(mainWindow,{
    type:'warning',title:'Xác nhận ghi trên Production',
    message:`${operation === 'import' ? 'Nhập dữ liệu' : 'Phục hồi backup'} vào Production?`,
    detail:`Kết nối: ${profile.name || profileId}\nMáy chủ: ${profile.user || ''}@${profile.host || ''}:${profile.port || 3306}\nDatabase đích: ${database}\nTệp: ${filePath}\nDung lượng: ${before.size} byte\n${details}\n\nTác vụ dùng phiên riêng, không thuộc transaction của SQL Editor. Khi lỗi hoặc hủy có thể còn dữ liệu đã ghi; DDL không được bảo đảm rollback.`,
    buttons:['Hủy','Xác nhận đúng đích và thực hiện'],defaultId:0,cancelId:0,noLink:true
  });
  if (response.response !== 1) return false;
  checkConnectionPolicy(profileId);
  if (Date.now()-started > 120000 || productionProfileFingerprint(store.getWithSecrets(profileId)) !== fingerprint
      || identity(await fs.promises.stat(filePath)) !== identity(before)) {
    throw Object.assign(new Error('Tệp hoặc cấu hình đích đã thay đổi, hoặc xác nhận quá 2 phút. Hãy thực hiện lại.'),{code:'PRODUCTION_CONTEXT_CHANGED'});
  }
  return true;
}

async function withWriteReview(profileId,operation,payload,execute) {
  const serialized = serialize(payload);
  const snapshot = deserialize(serialized);
  return withSessionFor(profileId,async (session) => {
    if (operation === 'query') checkConnectionPolicy(profileId,snapshot.sql);
    else checkConnectionPolicy(profileId);
    const profile = store.getWithSecrets(profileId);
    let needsReview = profile.environment === 'production';
    if (needsReview && operation === 'query') {
      try { assertReadOnlySql({readOnly:true},snapshot.sql); needsReview = false; } catch { /* unknown SQL requires explicit review */ }
    }
    if (!needsReview) return execute(session,snapshot);
    if (serialized.length > 4 * 1024 * 1024 || (operation === 'query' && snapshot.sql.length > 1024 * 1024)) {
      throw Object.assign(new Error('Nội dung quá lớn để xác nhận an toàn. Hãy chia nhỏ thao tác.'),{code:'PRODUCTION_PREVIEW_TOO_LARGE'});
    }
    const current = openSessions.get(profileId);
    if (!current || current.session !== session || session.activeTask || sessionRegistry.leases.get(current) > 1) {
      throw Object.assign(new Error('Phiên đang bận. Hãy đợi trước khi xem trước thao tác.'),{code:'SESSION_BUSY'});
    }
    const plan = operation === 'query' ? {sql:snapshot.sql,params:[]} : await session.previewRowWrite(operation,snapshot);
    const schemaHash = crypto.createHash('sha256').update(serialize(plan.columns || null)).digest('hex');
    const planSql = plan.sql;
    const planParams = serialize(plan.params);
    const revision = session.transactionRevision || 0;
    const fingerprint = productionProfileFingerprint(store.getWithSecrets(profileId));
    const syntaxRisks = operation === 'query' ? analyzeProductionSqlRisks(snapshot.sql) : [];
    const hasDestructiveRisk = syntaxRisks.some((r) => r.severity === 'destructive');
    const preview = {
      operation,profileId,connectionName:profile.name || profileId,
      host:profile.host ? `${profile.user || ''}@${profile.host}:${profile.port || 3306}` : '',
      database:snapshot.database || session.database || null,table:snapshot.table || null,
      sql:redactSql(plan.sql),parameters:parameterSummary(plan.params),parameterCount:plan.params.length,
      selectedRows:operation === 'delete-rows' ? snapshot.keysList.length : operation === 'query' ? null : 1,
      rowCountEstimate: operation === 'query' ? 'Chưa xác định' : null,
      rowCountNotice: operation === 'query' ? 'Số dòng ảnh hưởng chưa xác định. SqlPro không chạy COUNT(*) hoặc EXPLAIN ANALYZE ngầm để tránh khóa bảng và tiêu tốn tài nguyên production.' : '',
      syntaxRisks,
      hasDestructiveRisk,
      columns:operation === 'query' ? [] : Object.keys(snapshot.values || {}),
      inTransaction:Boolean(session.inTransaction),autocommit:session.autocommit !== false,
      note:operation === 'delete-rows' ? 'SQL dự kiến theo khóa chính. Khi có snapshot gốc, dữ liệu được kiểm tra và khóa trong transaction trước khi xóa.'
        : operation === 'query' ? 'Đích hiển thị là database ban đầu. SQL có thể đổi database hoặc tác động nhiều bảng; không dự đoán số dòng ảnh hưởng.'
          : operation === 'insert-row' ? 'Giá trị được che. Bản ghi mới vẫn chịu kiểm tra kiểu, ràng buộc và quyền database.'
            : 'SQL dùng placeholder. Khi có snapshot gốc, cập nhật vẫn kiểm tra xung đột dữ liệu trước khi ghi.'
    };
    throw productionApprovals.issue(preview,async () => {
      const latest = openSessions.get(profileId);
      const stale = () => Object.assign(new Error('Phiên, transaction, cấu hình hoặc schema đã thay đổi. Hãy thực hiện lại để xem trước.'),{code:'PRODUCTION_CONTEXT_CHANGED'});
      if (latest !== current || session.dead || (session.transactionRevision || 0) !== revision
          || productionProfileFingerprint(store.getWithSecrets(profileId)) !== fingerprint) throw stale();
      if (session.activeTask || sessionRegistry.leases.get(current)) throw Object.assign(new Error('Phiên đang bận.'),{code:'SESSION_BUSY'});
      if (operation === 'query') checkConnectionPolicy(profileId,snapshot.sql);
      else checkConnectionPolicy(profileId);
      const release = sessionRegistry.acquire(current);
      current.productionWriteInProgress = true;
      try {
        if (operation !== 'query') {
          const latestPlan = await session.previewRowWrite(operation,snapshot);
          if (crypto.createHash('sha256').update(serialize(latestPlan.columns || null)).digest('hex') !== schemaHash
              || latestPlan.sql !== planSql || !serialize(latestPlan.params).equals(planParams)) throw stale();
        }
        if (openSessions.get(profileId) !== current || session.dead || productionProfileFingerprint(store.getWithSecrets(profileId)) !== fingerprint) throw stale();
        return await execute(session,{...snapshot,confirmed:true});
      } finally { current.productionWriteInProgress = false; release(); }
    });
  }, { exclusive: true });
}

function activeTransactions() {
  return [...openSessions.values()]
    .filter((entry) => !entry.session.dead && entry.session.inTransaction)
    .map((entry) => entry.profileId);
}

function confirmActiveTransactions(action = 'ngắt kết nối') {
  const profiles = activeTransactions();
  if (!profiles.length) return true;
  const options = {
    type: 'warning',
    title: 'Transaction chưa hoàn tất',
    message: `Có ${profiles.length} phiên đang mở transaction chưa commit.`,
    detail: `${action === 'thoát' ? 'Thoát' : 'Ngắt kết nối'} sẽ rollback các thay đổi chưa commit của transaction đó.`,
    buttons: ['Quay lại', `Vẫn ${action}`],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  };
  let choice = 0;
  try {
    choice = mainWindow && !mainWindow.isDestroyed()
      ? dialog.showMessageBoxSync(mainWindow, options)
      : dialog.showMessageBoxSync(options);
  } catch {
    choice = 0;
  }
  return choice === 1;
}

function cancelDatabaseTransfer(transfer) {
  if (!transfer) return false;
  if (transfer.operation === 'backup-selection-preview') {
    transfer.canceled = true;
    transfer.controller?.abort();
    void transfer.session?.close().catch(() => {});
    return true;
  }
  if (['backup-retention', 'selective-restore', 'restore-selective', 'data-sync'].includes(transfer.operation)) {
    transfer.canceled = true;
    transfer.controller?.abort();
    if (transfer.cancelController && transfer.cancelController !== transfer.controller) {
      transfer.cancelController.abort();
    }
    if (transfer.session) {
      void transfer.session.close().catch(() => {});
    }
    return true;
  }
  if (transfer.trialControl) {
    transfer.canceled = true;
    return transfer.trialControl.cancel();
  }
  const session = transfer.session || openSessions.get(transfer.profileId)?.session;
  const canceled = session?.cancelTask(transfer.taskId) || transfer.pending;
  if (canceled) transfer.canceled = true;
  return Boolean(canceled);
}

function confirmStopActiveTransfer() {
  const active = activeDatabaseTransfer;
  if (!active) return true;
  const label = transferLabel(active.operation);
  const partialRisk = active.operation === 'restore' || active.operation === 'import';
  const message = `Tác vụ ${label} đang chạy. Thoát bây giờ sẽ hủy tác vụ${partialRisk ? ' và có thể để database ở trạng thái đã áp dụng một phần' : ''}.`;
  const options = {
    type: 'warning',
    title: 'Tác vụ database đang chạy',
    message,
    detail: 'Chọn “Tiếp tục chạy” để quay lại ứng dụng, hoặc “Dừng tác vụ và thoát” để hủy trước khi đóng.',
    buttons: ['Tiếp tục chạy', 'Dừng tác vụ và thoát'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  };
  const choice = mainWindow && !mainWindow.isDestroyed()
    ? dialog.showMessageBoxSync(mainWindow, options)
    : dialog.showMessageBoxSync(options);
  if (choice === 0) return false;
  cancelDatabaseTransfer(active);
  return true;
}

function syncNotifier() {
  return {
    status: (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sync:status', payload);
      }
    },
    applied: (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sync:applied', payload);
      }
    }
  };
}

function applyZoom(delta) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const contents = mainWindow.webContents;
  const level = delta === null ? 0 : Math.max(-6, Math.min(6, contents.getZoomLevel() + delta));
  contents.setZoomLevel(level);
}

function buildMenu() {
  const template = [
    {
      label: 'Tệp',
      submenu: [
        { label: 'Kết nối mới', accelerator: 'Ctrl+N', click: () => sendCommand('new-connection') },
        { label: 'Nhập kết nối Navicat…', click: () => sendCommand('import-navicat') },
        { label: 'Ngắt kết nối', click: () => sendCommand('disconnect') },
        { type: 'separator' },
        { label: 'Truy vấn mới', accelerator: 'Ctrl+T', click: () => sendCommand('new-query') },
        { label: 'Lưu truy vấn', accelerator: 'Ctrl+S', click: () => sendCommand('save-query') },
        { label: 'Nhập dữ liệu…', accelerator: 'Ctrl+O', click: () => sendCommand('import') },
        { label: 'Xuất dữ liệu…', accelerator: 'Ctrl+Shift+S', click: () => sendCommand('export') },
        { type: 'separator' },
        { label: 'Sao lưu database…', click: () => sendCommand('backup') },
        { label: 'Phục hồi database…', click: () => sendCommand('restore') },
        { type: 'separator' },
        { role: 'quit', label: 'Thoát' }
      ]
    },
    {
      label: 'Chỉnh sửa',
      submenu: [
        { role: 'undo', label: 'Hoàn tác' },
        { role: 'redo', label: 'Làm lại' },
        { type: 'separator' },
        { role: 'cut', label: 'Cắt' },
        { role: 'copy', label: 'Sao chép' },
        { role: 'paste', label: 'Dán' },
        { role: 'selectAll', label: 'Chọn tất cả' }
      ]
    },
    {
      label: 'Hiển thị',
      submenu: [
        { label: 'Ẩn/hiện thanh bên', accelerator: 'Ctrl+B', click: () => sendCommand('toggle-sidebar') },
        { type: 'separator' },
        { label: 'Cỡ mặc định', accelerator: 'Ctrl+0', registerAccelerator: false, click: () => applyZoom(null) },
        { label: 'Phóng to', accelerator: 'Ctrl+Plus', registerAccelerator: false, click: () => applyZoom(0.5) },
        { label: 'Thu nhỏ', accelerator: 'Ctrl+-', registerAccelerator: false, click: () => applyZoom(-0.5) },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Toàn màn hình', accelerator: 'F11' }
      ]
    },
    {
      label: 'Truy vấn',
      submenu: [
        { label: 'Chạy truy vấn', accelerator: 'Ctrl+Enter', click: () => sendCommand('run-query') },
        { label: 'Chạy truy vấn (F5)', accelerator: 'F5', click: () => sendCommand('run-query') },
        { label: 'Hủy truy vấn đang chạy', click: () => sendCommand('cancel-query') },
        { label: 'Làm mới dữ liệu', accelerator: 'Ctrl+R', click: () => sendCommand('refresh-data') }
      ]
    },
    {
      label: 'Trợ giúp',
      submenu: [
        {
          label: 'Giới thiệu SqlPro',
          click: () => dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'Giới thiệu SqlPro',
            message: `SqlPro ${app.getVersion()}`,
            detail: 'Ứng dụng desktop quản trị cơ sở dữ liệu MySQL/MariaDB.\nHỗ trợ nhập kết nối và SSH tunnel tương thích Navicat.'
          })
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const options = getWindowOptions();
  const appPage = path.join(__dirname, '..', 'index.html');
  const appUrl = pathToFileURL(appPage).href;
  mainWindow = new BrowserWindow({
    width: options.width,
    height: options.height,
    x: options.x,
    y: options.y,
    minWidth: 1024,
    minHeight: 650,
    show: false,
    backgroundColor: '#f7f9fa',
    title: 'SqlPro',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  mainWindow.loadFile(appPage);
  mainWindow.once('ready-to-show', () => {
    if (options.maximized) mainWindow.maximize();
    mainWindow.show();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== appUrl) event.preventDefault();
  });
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.alt || (!input.control && !input.meta)) return;
    const key = input.key || '';
    const code = input.code || '';
    if (key === '+' || key === '=' || code === 'NumpadAdd') {
      event.preventDefault();
      applyZoom(0.5);
    } else if (key === '-' || key === '_' || code === 'NumpadSubtract') {
      event.preventDefault();
      applyZoom(-0.5);
    } else if (key === '0' || code === 'Numpad0') {
      event.preventDefault();
      applyZoom(null);
    }
  });
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  mainWindow.on('close', (event) => {
    if (!isQuitting && activeDatabaseTransfer) {
      event.preventDefault();
      if (!confirmStopActiveTransfer()) return;
      isQuitting = true;
      saveWindowState();
      mainWindow.destroy();
      return;
    }
    if (!isQuitting && activeTransactions().length && !confirmActiveTransactions('thoát')) {
      event.preventDefault();
      return;
    }
    saveWindowState();
  });
  mainWindow.on('closed', () => { stopBackupSchedules(); mainWindow = undefined; });
}

function validateState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Trạng thái ứng dụng không hợp lệ.');
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error('Trạng thái ứng dụng không thể chuyển thành JSON.');
  }
  if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) {
    throw new Error('Trạng thái ứng dụng vượt quá giới hạn 2 MB.');
  }
  return value;
}

function validateDialogFilters(filters) {
  if (!Array.isArray(filters)) return undefined;
  return filters.slice(0, 5)
    .filter((filter) => filter && typeof filter === 'object')
    .map((filter) => ({
      name: typeof filter.name === 'string' ? filter.name.slice(0, 80) : 'Tệp dữ liệu',
      extensions: Array.isArray(filter.extensions)
        ? filter.extensions.slice(0, 20)
          .filter((extension) => typeof extension === 'string' && /^[A-Za-z0-9*]+$/.test(extension))
          .map((extension) => extension.slice(0, 20))
        : ['*']
    }));
}

function handle(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (mainWindow && event.sender !== mainWindow.webContents) {
      return { ok: false, error: { message: 'Yêu cầu không hợp lệ.', code: 'INVALID_SENDER' } };
    }
    try {
      return { ok: true, data: await handler(...args) };
    } catch (error) {
      return {
        ok: false,
        error: {
          message: friendlyError(error),
          code: error && error.code ? String(error.code) : '',
          sqlState: error && error.sqlState ? String(error.sqlState) : '',
          ...(error && typeof error.executedCount === 'number' ? { executedCount: error.executedCount } : {}),
          ...(error && typeof error.skippedCount === 'number' ? { skippedCount: error.skippedCount } : {}),
          ...(error && typeof error.targetChanged === 'boolean' ? { targetChanged: error.targetChanged } : {}),
          ...(error && typeof error.partialCommit === 'boolean' ? { partialCommit: error.partialCommit } : {}),
          ...(error && typeof error.executionUncertain === 'boolean' ? { executionUncertain: error.executionUncertain } : {}),
          ...(error && error.fingerprint ? { fingerprint: String(error.fingerprint) } : {}),
          ...(error && error.expectedFingerprint ? { expectedFingerprint: String(error.expectedFingerprint) } : {}),
          ...(error && error.partial ? { partial: error.partial } : {}),
          ...(error && error.impact ? { impact: error.impact } : {}),
          ...(error && error.preflight ? { preflight: error.preflight } : {}),
          ...(error && error.conflict ? { conflict: error.conflict } : {}),
          ...(error && error.code === 'PRODUCTION_CONFIRM_REQUIRED' ? {preview:error.preview} : {})
        }
      };
    }
  });
}

function friendlyError(error) {
  if (!error) return 'Đã xảy ra lỗi không xác định.';
  const code = String(error.code || '');
  const messages = {
    ER_ACCESS_DENIED_ERROR: 'Sai username hoặc mật khẩu.',
    ER_DBACCESS_DENIED_ERROR: 'Tài khoản không có quyền truy cập database này.',
    ER_BAD_DB_ERROR: 'Database không tồn tại.',
    ECONNREFUSED: 'Không kết nối được tới host/port. Kiểm tra lại địa chỉ và firewall.',
    ENOTFOUND: 'Không phân giải được hostname.',
    ETIMEDOUT: 'Kết nối quá thời gian chờ.',
    ECONNRESET: 'Kết nối bị đóng bởi máy chủ.',
    PROTOCOL_CONNECTION_LOST: 'Mất kết nối tới database.',
    SESSION_CLOSED: 'Phiên kết nối đã đóng. Hãy kết nối lại.',
    QUERY_TIMEOUT: error.message || 'Truy vấn quá thời gian cho phép.',
    QUERY_CANCELED: 'Đã hủy truy vấn.',
    ER_LOCK_WAIT_TIMEOUT: 'Database đang bị transaction khác giữ khóa. Hãy hoàn tất hoặc rollback transaction đó rồi thử lại.',
    ER_LOCK_DEADLOCK: 'Database phát hiện deadlock và đã hủy một transaction. Hãy thử lại sau khi kiểm tra transaction đang mở.',
    NO_PRIMARY_KEY: 'Bảng không có khóa chính nên không thể sửa/xóa trực tiếp.',
    NETWORK_ERROR: 'Không kết nối được tới server đồng bộ. Kiểm tra URL và kết nối mạng.',
    INVALID_SERVER_URL: 'Địa chỉ server đồng bộ không hợp lệ.',
    INSECURE_SERVER: 'Server không dùng HTTPS. Hãy dùng HTTPS hoặc xác nhận cho phép HTTP không an toàn.',
    INVALID_CREDENTIALS: 'Email hoặc mật khẩu không đúng.',
    EMAIL_TAKEN: 'Email này đã được đăng ký trên server.',
    RATE_LIMITED: 'Bạn thao tác quá nhanh. Hãy thử lại sau.',
    SYNC_ACCOUNT_MISMATCH: 'Dữ liệu local thuộc tài khoản khác. Hãy sao lưu và xóa dữ liệu local trước khi đổi tài khoản.',
    WEAK_PASSWORD: 'Mật khẩu quá ngắn. Hãy dùng ít nhất 10 ký tự.',
    REGISTRATION_DISABLED: 'Server này không mở đăng ký tài khoản.',
    VAULT_DECRYPT_FAILED: 'Không thể giải mã dữ liệu đồng bộ. Kiểm tra mật khẩu hoặc dữ liệu trên server.',
    NOT_LOGGED_IN: 'Chưa đăng nhập tài khoản đồng bộ.',
    SESSION_EXPIRED: 'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.',
    VAULT_TOO_LARGE: 'Dữ liệu đồng bộ vượt quá giới hạn 5 MB.',
    STORE_READ_FAILED: 'Không đọc được cấu hình kết nối. Tệp dữ liệu được giữ nguyên, không ghi đè; hãy kiểm tra tệp hoặc dùng chức năng đặt lại dữ liệu local.',
    BACKUP_SNAPSHOT_FAILED: 'Không tạo được snapshot nhất quán cho bản sao lưu.',
    RESTORE_PREFLIGHT_BLOCKED: 'Kiểm tra trước phục hồi phát hiện vấn đề có thể làm hỏng dữ liệu đích. Chưa có thay đổi nào được ghi.',
    BACKUP_CHECKSUM_MISMATCH: 'Tệp sao lưu không khớp checksum đã lưu. Tệp có thể đã bị sửa hoặc hỏng.',
    TLS_NOT_SUPPORTED: 'Máy chủ không hỗ trợ TLS nhưng kết nối đang yêu cầu SSL/TLS. Hãy liên hệ quản trị viên máy chủ hoặc tắt TLS nếu hiểu rõ rủi ro.',
    TLS_CERT_UNTRUSTED: 'Chứng chỉ TLS của máy chủ không được tin cậy. Hãy cung cấp đúng CA hoặc dùng chứng chỉ do CA tin cậy phát hành.',
    TLS_CERT_EXPIRED: 'Chứng chỉ TLS của máy chủ đã hết hạn hoặc chưa có hiệu lực. Hãy cập nhật chứng chỉ trên máy chủ.',
    TLS_CERT_HOSTNAME_MISMATCH: 'Tên/IP trên chứng chỉ TLS không khớp địa chỉ máy chủ. Hãy dùng đúng hostname trong chứng chỉ hoặc cấu hình lại chứng chỉ.',
    TLS_HANDSHAKE_FAILED: 'Không thiết lập được TLS với máy chủ (giao thức hoặc chứng chỉ không tương thích). Kiểm tra cấu hình TLS của máy chủ và CA.',
    SSH_AUTH_FAILED: 'Xác thực SSH thất bại. Kiểm tra username, mật khẩu hoặc private key/passphrase.',
    SSH_CONNECTION_FAILED: 'Không kết nối được SSH host. Kiểm tra địa chỉ, cổng, mạng và firewall.',
    SSH_TUNNEL_FAILED: 'Đã kết nối SSH nhưng không mở được tunnel tới MySQL. Kiểm tra host/port MySQL nhìn từ máy SSH.',
    SSH_KEY_READ_FAILED: 'Không đọc được SSH private key. Kiểm tra đường dẫn và quyền đọc tệp.',
    SSH_TIMEOUT: 'Kết nối SSH quá thời gian chờ. Kiểm tra mạng, cổng và cấu hình SSH host.',
    MYSQL_CLEARTEXT_AUTH_REQUIRED: 'Máy chủ yêu cầu mysql_clear_password nhưng SqlPro chưa cho phép hoặc vận chuyển hiện tại không đáp ứng chính sách.',
    CLEARTEXT_AUTH_INSECURE_TRANSPORT: 'mysql_clear_password chỉ được phép khi TLS đã xác thực chứng chỉ hoặc qua SSH tunnel tới MySQL loopback trên chính máy SSH với host key đã xác minh.',
    SSL_FILE_READ_FAILED: 'Không đọc được tệp CA/chứng chỉ/khóa TLS. Kiểm tra đường dẫn và quyền đọc tệp.'
  };
  return messages[code] || error.message || 'Đã xảy ra lỗi.';
}

function runtimeProfile(profile) {
  return {
    ...profile,
    ssh: {
      ...profile.ssh,
      password: profile.sshPassword || '',
      passphrase: profile.sshPassphrase || ''
    }
  };
}

function mergeSecrets(payload) {
  const base = {
    name: payload && payload.name,
    type: payload && payload.type,
    host: payload && payload.host,
    port: payload && payload.port,
    user: payload && payload.user,
    password: payload && payload.password,
    database: payload && payload.database,
    allowCleartextPassword: payload && payload.allowCleartextPassword,
    ssl: payload && payload.ssl,
    ssh: payload && payload.ssh,
    sshPassword: payload && payload.sshPassword,
    sshPassphrase: payload && payload.sshPassphrase
  };
  if (payload && payload.id) {
    const stored = store.getWithSecrets(payload.id);
    if (payload.password === undefined) base.password = stored.password;
    if (payload.sshPassword === undefined) base.sshPassword = stored.sshPassword;
    if (payload.sshPassphrase === undefined) base.sshPassphrase = stored.sshPassphrase;
    if (!payload.ssl) base.ssl = stored.ssl;
    if (!payload.ssh) {
      base.ssh = stored.ssh;
    } else if (stored && stored.ssh && stored.ssh.knownHostKey && !payload.ssh.knownHostKey) {
      base.ssh = { ...payload.ssh, knownHostKey: stored.ssh.knownHostKey };
    }
  }
  return base;
}

function isConnectionError(error) {
  const code = String(error && error.code ? error.code : '');
  return ['ECONNRESET', 'PROTOCOL_CONNECTION_LOST', 'ETIMEDOUT', 'EPIPE', 'ER_SERVER_SHUTDOWN', 'SESSION_CLOSED'].includes(code);
}

async function closeSession(profileId, expected) {
  if (expected && openSessions.get(profileId) !== expected) return false;
  if (activeSession?.profileId === profileId && (!expected || activeSession === expected)) activeSession = null;
  return sessionRegistry.close(profileId, expected);
}

async function closeActiveSession() {
  if (activeSession) await closeSession(activeSession.profileId);
}

async function closeAllSessions() {
  activeSession = null;
  await sessionRegistry.closeAll();
}

async function openSession(profileId, makeActive = true, options = {}, expected) {
  const current = await (expected ? sessionRegistry.reopen(expected, options) : sessionRegistry.open(profileId, options));
  if (openSessions.get(profileId) !== current) throw Object.assign(new Error('Yêu cầu kết nối đã bị hủy.'), { code: 'SESSION_OPEN_CANCELED' });
  assertSessionProfile(current);
  if (makeActive) activeSession = current;
  return current;
}

async function ensureSession(profileId) {
  if (profileId) {
    const current = openSessions.get(profileId);
    if (!current || current.session.dead) return openSession(profileId, activeSession?.profileId === profileId);
    assertSessionProfile(current);
    return current;
  }
  if (!activeSession) {
    throw Object.assign(new Error('Chưa kết nối database.'), { code: 'SESSION_CLOSED' });
  }
  if (activeSession.session.dead) {
    await openSession(activeSession.profileId);
  }
  assertSessionProfile(activeSession);
  return activeSession;
}

async function withSessionFor(profileId, handler, { retry = false, exclusive = false } = {}) {
  return withSession(handler, { retry, profileId, exclusive });
}

async function withSession(handler, { retry = false, profileId = null, exclusive = false } = {}) {
  let current = await ensureSession(profileId);
  const acquire = entry => {
    assertSessionProfile(entry);
    if (entry.productionWriteInProgress || entry.exclusiveOperation || entry.session.activeTask
        || exclusive && sessionRegistry.leases.get(entry)) throw Object.assign(new Error('Phiên đang bận. Hãy đợi tác vụ hoàn tất rồi thử lại.'), { code: 'SESSION_BUSY' });
    const releaseLease = sessionRegistry.acquire(entry);
    if (exclusive) entry.exclusiveOperation = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (exclusive) entry.exclusiveOperation = false;
      releaseLease();
    };
  };
  let release = acquire(current);
  try {
    return await handler(current.session);
  } catch (error) {
    if (retry && isConnectionError(error)) {
      if (openSessions.get(current.profileId) !== current) throw error;
      current.session.dead = true;
      release();
      current = await openSession(current.profileId, activeSession === current, {}, current);
      release = acquire(current);
      return await handler(current.session);
    }
    throw error;
  } finally { release(); }
}

handle('clipboard:write-text', async (text) => {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 32 * 1024 * 1024) {
    throw new Error('Nội dung sao chép không hợp lệ hoặc vượt quá 32 MB. Hãy xuất ra tệp nếu dữ liệu lớn hơn.');
  }
  await clipboard.writeText(text);
  return { written: true };
});
handle('clipboard:read-text', async () => {
  const text = await clipboard.readText();
  if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw new Error('Nội dung clipboard vượt quá 32 MB.');
  return text;
});

handle('db:confirm-production', (token) => productionApprovals.confirm(token));
handle('db:cancel-production', (token) => productionApprovals.cancel(token));

handle('app:metadata', () => ({
  name: app.getName(),
  version: app.getVersion(),
  platform: process.platform
}));
handle('state:load', async () => {
  const value = await readJson('renderer-state.json', {});
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
});
handle('state:save', (value) => {
  writeJson('renderer-state.json', validateState(value));
  return { saved: true };
});
handle('table-preferences:read', (scope) => tablePreferences().read(scope));
handle('table-preferences:save', (scope, value) => tablePreferences().save(scope, value));
handle('table-preferences:remove', (scope) => tablePreferences().remove(scope));
handle('audit-log:read', (filter) => auditLog().read(filter));
handle('audit-log:append', (entry) => auditLog().append(entry));
handle('audit-log:prune', (options) => auditLog().prune(options));
handle('audit-log:clear', () => auditLog().clear());

handle('file:save-text', async (payload) => {
  if (!payload || typeof payload !== 'object' || typeof payload.contents !== 'string'
    || typeof payload.suggestedName !== 'string') {
    throw new Error('Yêu cầu lưu tệp không hợp lệ.');
  }
  if (Buffer.byteLength(payload.contents) > MAX_EXPORT_BYTES) {
    throw new Error('Tệp xuất vượt quá giới hạn 50 MB.');
  }
  const safeName = path.basename(payload.suggestedName).replace(/[<>:"/\\|?*]/g, '_').slice(0, 160) || 'sqlpro-export.txt';
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Xuất dữ liệu',
    defaultPath: safeName,
    filters: validateDialogFilters(payload.filters)
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.promises.writeFile(result.filePath, payload.contents, 'utf8');
  return { canceled: false, filePath: result.filePath };
});

handle('file:open-json', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Nhập dữ liệu JSON',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  const filePath = result.filePaths[0];
  const stat = await fs.promises.stat(filePath);
  if (stat.size > MAX_IMPORT_BYTES) throw new Error('Tệp nhập vượt quá giới hạn 20 MB.');
  return { canceled: false, filePath, contents: await fs.promises.readFile(filePath, 'utf8') };
});

handle('file:open-text', async (payload) => {
  if (!payload || typeof payload !== 'object') throw new Error('Tham số mở tệp không hợp lệ.');
  const filters = validateDialogFilters(payload.filters);
  const result = await dialog.showOpenDialog(mainWindow, {
    title: typeof payload.title === 'string' ? payload.title.slice(0, 120) : 'Chọn tệp dữ liệu',
    properties: ['openFile'],
    filters: filters && filters.length
      ? filters
      : [{ name: 'Tệp dữ liệu', extensions: ['csv', 'tsv', 'txt', 'json', 'sql'] }]
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  const filePath = result.filePaths[0];
  const stat = await fs.promises.stat(filePath);
  if (stat.size > MAX_IMPORT_BYTES) throw new Error('Tệp nhập vượt quá giới hạn 20 MB.');
  return { canceled: false, filePath, contents: await fs.promises.readFile(filePath, 'utf8') };
});

handle('connections:list', () => store.list());

handle('connections:save', async (payload) => {
  if (payload?.id && activeDatabaseTransfer?.profileId === payload.id) {
    throw Object.assign(new Error('Kết nối đang chạy tác vụ truyền dữ liệu. Hãy đợi hoàn tất trước khi sửa cấu hình.'), { code: 'SESSION_BUSY' });
  }
  const current = payload?.id ? openSessions.get(payload.id) : null;
  if (current && (current.session.activeTask || sessionRegistry.leases.get(current))) {
    throw Object.assign(new Error('Kết nối đang chạy tác vụ. Hãy đợi hoàn tất trước khi sửa cấu hình.'), { code: 'SESSION_BUSY' });
  }
  if (current && (current.session.inTransaction || current.session.autocommit === false)) {
    throw Object.assign(new Error('Hãy kết thúc transaction và bật lại autocommit trước khi sửa cấu hình kết nối. Dữ liệu chưa commit được giữ nguyên.'), { code: 'PROFILE_TRANSACTION_OPEN' });
  }
  const saved = store.save(payload);
  if (payload?.id) await closeSession(payload.id, current);
  sync.schedule();
  return saved;
});

handle('connections:remove', async (id) => {
  await closeSession(id);
  store.remove(id);
  sync.schedule();
  return { removed: true };
});

handle('connections:test', async (payload) => {
  const merged = mergeSecrets(payload);
  if (!merged.host) throw new Error('Host không được để trống.');
  const result = await testConnection(runtimeProfile(merged));
  return { version: result.version };
});

handle('connections:import-navicat', async (workspaceId) => {
  const candidates = [
    path.join(os.homedir(), '.config', 'navicat', 'Common', 'connections.json'),
    path.join(app.getPath('appData'), 'navicat', 'Common', 'connections.json')
  ];
  const defaultPath = candidates.find((candidate) => fs.existsSync(candidate));
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Nhập kết nối từ Navicat',
    properties: ['openFile'],
    defaultPath,
    filters: [
      { name: 'Navicat connections', extensions: ['ncx', 'json'] },
      { name: 'Tất cả tệp', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  const parsed = parseNavicatFile(result.filePaths[0]);
  const imported = store.importMany(parsed.connections, workspaceId);
  if (imported.updated) await closeAllSessions();
  sync.schedule();
  return {
    canceled: false,
    filePath: result.filePaths[0],
    added: imported.added,
    updated: imported.updated,
    skipped: parsed.skipped,
    sessionsClosed: imported.updated > 0
  };
});

handle('workspaces:list', () => store.listWorkspaces());

handle('workspaces:save', (payload) => {
  const workspace = store.saveWorkspace(payload);
  sync.schedule();
  return workspace;
});

handle('workspaces:remove', (id) => {
  if (typeof id !== 'string' || !id) throw new Error('Workspace không hợp lệ.');
  const result = store.removeWorkspace(id);
  sync.schedule();
  return result;
});

handle('account:status', () => sync.status());

handle('account:register', (payload) => {
  if (!payload || typeof payload !== 'object') throw new Error('Thông tin đăng ký không hợp lệ.');
  return sync.register(payload);
});

handle('account:login', (payload) => {
  if (!payload || typeof payload !== 'object') throw new Error('Thông tin đăng nhập không hợp lệ.');
  return sync.login(payload);
});

handle('account:logout', () => { stopBackupSchedules(); return sync.logout(); });

handle('account:reset-local', async () => {
  stopBackupSchedules();
  await sync.logout();
  const repository = backupSchedules().repository;
  for (const schedule of repository.read()) repository.update(schedule.id, schedule.revision, item => ({ ...item, enabled: false }));
  await closeAllSessions();
  const { backupName } = store.resetLocalData();
  writeJson('renderer-state.json', {});
  return { backupName };
});

handle('account:sync-now', () => sync.syncNow());

handle('account:resolve-conflicts', (choices) => sync.resolveConflicts(choices));

handle('account:list-recovery', () => sync.listRecovery());

handle('account:restore-recovery', (id) => {
  if (typeof id !== 'string' || !id) throw new Error('Bản phục hồi không hợp lệ.');
  return sync.restoreRecovery(id);
});

handle('db:connect', async (profileId, options = {}) => {
  if (typeof profileId !== 'string' || !profileId) throw new Error('Kết nối không hợp lệ.');
  const sshHostKey = options && typeof options === 'object' ? options.sshHostKey : null;
  const cached = openSessions.get(profileId);
  let reused = Boolean(cached && !cached.session.dead && cached.session.connection && cached.databases);
  let current = await openSession(profileId, true, { sshHostKey });
  let release = sessionRegistry.acquire(current);
  try {
    let databases = reused ? current.databases : null;
    try {
      if (!databases) databases = await current.session.listDatabases();
    } catch (error) {
      if (!isConnectionError(error)) throw error;
      release();
      current = await openSession(profileId, true, { sshHostKey }, current);
      release = sessionRegistry.acquire(current);
      databases = await current.session.listDatabases();
      reused = false;
    }
    if (openSessions.get(profileId) !== current) throw Object.assign(new Error('Yêu cầu kết nối đã hết hiệu lực.'), { code: 'SESSION_OPEN_CANCELED' });
    current.databases = databases;
    return {
      profileId,
      server: current.session.version,
      databases,
      reused,
      openProfiles: [...openSessions.keys()]
    };
  } catch (error) {
    await closeSession(profileId, current);
    throw error;
  } finally { release(); }
});

handle('db:disconnect', async (profileId, options = {}) => {
  const target = typeof profileId === 'string' && profileId ? openSessions.get(profileId) : activeSession;
  if (target?.session.inTransaction && (!options || options.force !== true)) {
    return { disconnected: false, needsConfirmation: true, profileId: target.profileId };
  }
  if (typeof profileId === 'string' && profileId) await closeSession(profileId);
  else await closeActiveSession();
  return { disconnected: true, openProfiles: [...openSessions.keys()] };
});

function sessionState(current) {
  const session = current?.session;
  return {
    profileId: current?.profileId || null,
    sessionId: current?.sessionId || null,
    connected: Boolean(session && !session.dead),
    busy: Boolean(session?.activeTask || (current && sessionRegistry.leases.get(current))),
    transactionRevision: session?.transactionRevision || 0,
    transactionObservedAt: session?.transactionObservedAt || null,
    inTransaction: Boolean(session?.inTransaction),
    autocommit: session?.autocommit !== false,
    tls: session?.tls || null
  };
}

handle('db:session-state', (profileId) => {
  const current = typeof profileId === 'string' && profileId ? openSessions.get(profileId) : activeSession;
  return sessionState(current);
});

async function executeTransaction(payload, expected = null) {
  if (!payload || !['commit', 'rollback'].includes(payload.action) || typeof payload.profileId !== 'string') {
    throw Object.assign(new Error('Thao tác transaction không hợp lệ.'), { code: 'INVALID_TRANSACTION_ACTION' });
  }
  // Never open/reconnect here: a confirmation only authorizes the observed session.
  const current = openSessions.get(payload.profileId);
  if (!current || (expected && current !== expected) || current.session.dead || !payload.sessionId || current.sessionId !== payload.sessionId
      || (current.session.transactionRevision || 0) !== payload.transactionRevision) {
    throw Object.assign(new Error('Phiên hoặc transaction đã thay đổi. Hãy kiểm tra trạng thái và thử lại.'), { code: 'TRANSACTION_CONTEXT_CHANGED' });
  }
  if (current.session.activeTask || sessionRegistry.leases.get(current)) {
    throw Object.assign(new Error('Phiên đang bận. Hãy đợi tác vụ hoàn tất.'), { code: 'SESSION_BUSY' });
  }
  if (payload.action === 'commit') { assertSessionProfile(current); checkConnectionPolicy(payload.profileId); }
  if (!current.session.inTransaction && current.session.autocommit !== false) return sessionState(current);
  const release = sessionRegistry.acquire(current);
  try {
    await current.session.runQueryScript(payload.action === 'commit' ? 'COMMIT' : 'ROLLBACK', 30000, true);
    return sessionState(current);
  } finally { release(); }
}

handle('db:transaction', async (payload) => {
  if (!payload || !['commit', 'rollback'].includes(payload.action) || typeof payload.profileId !== 'string') {
    throw Object.assign(new Error('Thao tác transaction không hợp lệ.'), { code: 'INVALID_TRANSACTION_ACTION' });
  }
  const current = openSessions.get(payload.profileId);
  // Roll back only the observed socket, even if sync removed its saved profile.
  if (payload.action === 'rollback') return executeTransaction(payload);
  const profile = store.getWithSecrets(payload.profileId);
  if (current) assertSessionProfile(current);
  if (profile.environment !== 'production') return executeTransaction(payload);
  checkConnectionPolicy(payload.profileId);
  if (!current || current.session.dead || current.sessionId !== payload.sessionId
      || (current.session.transactionRevision || 0) !== payload.transactionRevision) {
    throw Object.assign(new Error('Phiên hoặc transaction đã thay đổi. Hãy kiểm tra và thử lại.'), {code:'TRANSACTION_CONTEXT_CHANGED'});
  }
  if (current.session.activeTask || sessionRegistry.leases.get(current)) throw Object.assign(new Error('Phiên đang bận.'), {code:'SESSION_BUSY'});
  if (!current.session.inTransaction && current.session.autocommit !== false) return sessionState(current);
  const snapshot = deserialize(serialize(payload));
  const fingerprint = productionProfileFingerprint(profile);
  throw productionApprovals.issue({
    operation:'commit', profileId:profile.id,connectionName:profile.name || payload.profileId,
    host:profile.host ? `${profile.user || ''}@${profile.host}:${profile.port || 3306}` : '',
    database:current.session.database || null,sql:'COMMIT',parameters:[],parameterCount:0,selectedRows:null,
    inTransaction:Boolean(current.session.inTransaction),autocommit:current.session.autocommit !== false,
    note:'Commit toàn bộ thay đổi chưa commit của phiên, bao gồm mọi tab dùng chung kết nối. Không chỉ riêng database đang hiển thị. Sau commit không thể rollback các thay đổi đó.'
  },async () => {
    if (productionProfileFingerprint(store.getWithSecrets(snapshot.profileId)) !== fingerprint) {
      throw Object.assign(new Error('Cấu hình kết nối đã thay đổi. Hãy xem trước lại.'), {code:'PRODUCTION_CONTEXT_CHANGED'});
    }
    return executeTransaction(snapshot,current);
  });
});

handle('db:open-profiles', () => [...openSessions.entries()]
  .filter(([, current]) => !current.session.dead)
  .map(([profileId]) => profileId));

handle('db:databases', (payload) => {
  const profileId = payload && typeof payload === 'object' ? payload.profileId : null;
  return withSessionFor(profileId, async (session) => {
    const databases = await session.listDatabases();
    const current = [...openSessions.values()].find((entry) => entry.session === session);
    if (current) current.databases = databases;
    return databases;
  }, { retry: true });
});

handle('db:use-database', (payload) => {
  const profileId = payload && typeof payload === 'object' ? payload.profileId : null;
  const database = payload && typeof payload === 'object' ? payload.database : payload;
  if (typeof database !== 'string' || !database) throw new Error('Database không hợp lệ.');
  return withSessionFor(profileId, (session) => session.useDatabase(database), { retry: true, exclusive: true });
});

handle('db:tables', (payload) => {
  const profileId = payload && typeof payload === 'object' ? payload.profileId : null;
  const database = payload && typeof payload === 'object' ? payload.database : payload;
  if (typeof database !== 'string' || !database) throw new Error('Database không hợp lệ.');
  return withSessionFor(profileId, (session) => session.listTables(database), { retry: true });
});

handle('db:columns', (payload, legacyTable) => {
  const profileId = payload && typeof payload === 'object' ? payload.profileId : null;
  const database = payload && typeof payload === 'object' ? payload.database : payload;
  const table = payload && typeof payload === 'object' ? payload.table : legacyTable;
  if (typeof database !== 'string' || typeof table !== 'string') throw new Error('Tham số không hợp lệ.');
  return withSessionFor(profileId, (session) => session.listColumns(database, table), { retry: true });
});

handle('db:indexes', (payload, legacyTable) => {
  const profileId = payload && typeof payload === 'object' ? payload.profileId : null;
  const database = payload && typeof payload === 'object' ? payload.database : payload;
  const table = payload && typeof payload === 'object' ? payload.table : legacyTable;
  if (typeof database !== 'string' || typeof table !== 'string') throw new Error('Tham số không hợp lệ.');
  return withSessionFor(profileId, (session) => session.listIndexes(database, table), { retry: true });
});

handle('db:relations', (payload, legacyTable) => {
  const profileId = payload && typeof payload === 'object' ? payload.profileId : null;
  const database = payload && typeof payload === 'object' ? payload.database : payload;
  const table = payload && typeof payload === 'object' ? payload.table : legacyTable;
  if (typeof database !== 'string' || typeof table !== 'string') throw new Error('Tham số không hợp lệ.');
  return withSessionFor(profileId, (session) => session.listRelations(database, table), { retry: true });
});

handle('db:routines', (payload) => {
  if (!payload || typeof payload.database !== 'string' || !payload.database) throw new Error('Chưa chọn database.');
  return withSessionFor(payload.profileId, (session) => session.listRoutines(payload.database), { retry: true });
});

handle('db:events', (payload) => {
  if (!payload || typeof payload.database !== 'string' || !payload.database) throw new Error('Chưa chọn database.');
  return withSessionFor(payload.profileId, (session) => session.listEvents(payload.database), { retry: true });
});

handle('db:show-create', (payload) => {
  if (!payload || typeof payload.database !== 'string' || typeof payload.name !== 'string') {
    throw new Error('Tham số SHOW CREATE không hợp lệ.');
  }
  return withSessionFor(payload.profileId, (session) => session.showCreate(payload.database, payload.name, payload.kind), { retry: true });
});

function assertSchemaSnapshotScope(snapshot) {
  const scope = snapshot.scope;
  const entry = openSessions.get(scope.profileId);
  if (!entry || entry.session.dead || entry.sessionId !== scope.sessionId
      || backupContextGeneration !== scope.generation
      || productionProfileFingerprint(store.getWithSecrets(scope.profileId)) !== scope.profileFingerprint) {
    throw Object.assign(new Error('Phiên kết nối hoặc cấu hình đã thay đổi. Hãy thu thập lại snapshot.'), { code: 'SESSION_CONTEXT_CHANGED' });
  }
  assertSessionProfile(entry);
  return entry;
}

handle('db:schema-snapshot', async (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || typeof payload.database !== 'string' || !payload.database.trim()
      || payload.database.length > 64 || payload.database.includes('\0')) throw new Error('Database không hợp lệ.');
  const profileId = resolveProfileId(payload.profileId);
  const database = payload.database;
  const generation = backupContextGeneration;
  const entry = await ensureSession(profileId);
  assertSessionProfile(entry);
  if (generation !== backupContextGeneration) throw Object.assign(new Error('Phiên ứng dụng đã thay đổi.'), { code: 'SESSION_CONTEXT_CHANGED' });
  if (entry.productionWriteInProgress || entry.exclusiveOperation || entry.session.activeTask
      || entry.session.inTransaction || entry.session.autocommit === false || sessionRegistry.leases.get(entry)) {
    throw Object.assign(new Error('Phiên đang bận. Hãy đợi tác vụ hoàn tất rồi thử lại.'), { code: 'SESSION_BUSY' });
  }
  const release = sessionRegistry.acquire(entry);
  entry.exclusiveOperation = true;
  try {
    const collector = new SchemaSnapshotCollector(entry.session, {
      profileId: entry.profileId, sessionId: entry.sessionId, generation,
      profileFingerprint: productionProfileFingerprint(store.getWithSecrets(entry.profileId))
      // Quotas belong to Main; renderer options cannot disable them.
    });
    const snapshot = await collector.collect(database);
    assertSchemaSnapshotScope(snapshot);
    const snapshotId = schemaMigrationService.storeSnapshot(snapshot);
    return { ...projectSnapshotForRenderer(snapshot), snapshotId };
  } finally {
    entry.exclusiveOperation = false;
    release();
  }
});

handle('db:create-migration-plan', (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Tham số kế hoạch migration không hợp lệ.');
  const source = schemaMigrationService.getSnapshot(payload.sourceSnapshotId);
  const target = schemaMigrationService.getSnapshot(payload.targetSnapshotId);
  assertSchemaSnapshotScope(source);
  assertSchemaSnapshotScope(target);
  return schemaMigrationService.createMigrationPlan(payload);
});

// Fail closed at the IPC boundary too: confirmed/production flags cannot enable DDL.
handle('db:apply-migration-plan', () => schemaMigrationService.applyPlan());

handle('db:migration-job-status', (payload) => {
  if (!payload || typeof payload !== 'object' || typeof payload.jobId !== 'string' || !/^job_[a-f0-9]{32}$/.test(payload.jobId)) {
    throw new Error('Tham số jobId không hợp lệ.');
  }
  return schemaMigrationOrchestrator.getJob(payload.jobId);
});

handle('db:migration-job-cancel', (payload) => {
  if (!payload || typeof payload !== 'object' || typeof payload.jobId !== 'string' || !/^job_[a-f0-9]{32}$/.test(payload.jobId)) {
    throw new Error('Tham số jobId không hợp lệ.');
  }
  const reason = typeof payload.reason === 'string' && payload.reason ? payload.reason.slice(0, 200) : 'Migration đã bị hủy bởi người dùng.';
  const job = schemaMigrationOrchestrator.cancelJob(payload.jobId, reason);
  return { canceled: Boolean(job), job };
});

handle('db:table-data', (payload) => {
  if (!payload || typeof payload !== 'object') throw new Error('Tham số không hợp lệ.');
  return withSessionFor(payload.profileId, (session) => session.tableData(payload), { retry: true });
});

handle('db:table-count', (payload) => {
  if (!payload || typeof payload.database !== 'string' || typeof payload.table !== 'string') throw new Error('Tham số không hợp lệ.');
  return withSessionFor(payload.profileId, (session) => session.countTableRows(payload), { retry: true });
});

handle('db:query', (payload) => {
  if (!payload || typeof payload.sql !== 'string') throw new Error('Câu lệnh SQL không hợp lệ.');
  const profileId = checkConnectionPolicy(payload.profileId, payload.sql);
  return withWriteReview(profileId,'query',payload, async (session,request) => {
    const requestedSettings = request.explainSettings === true;
    const requestedSchema = request.explainSchema === true;
    const requestedContext = requestedSettings || requestedSchema;
    const generation = backupContextGeneration;
    const contextEntry = openSessions.get(profileId);
    const contextFingerprint = requestedContext ? productionProfileFingerprint(store.getWithSecrets(profileId)) : null;
    const checkExplainContext = () => {
      if (!contextEntry || contextEntry.session !== session || openSessions.get(profileId) !== contextEntry || session.dead
          || generation !== backupContextGeneration || productionProfileFingerprint(store.getWithSecrets(profileId)) !== contextFingerprint) {
        throw Object.assign(new Error('Ngữ cảnh EXPLAIN đã thay đổi. Hãy thực hiện lại.'), { code: 'EXPLAIN_CONTEXT_CHANGED' });
      }
      assertSessionProfile(contextEntry);
      checkConnectionPolicy(profileId, request.sql);
    };
    const database = typeof request.database === 'string' && request.database ? request.database : null;
    if (requestedContext) checkExplainContext();
    checkConnectionPolicy(profileId, request.sql);
    if (database) await session.useDatabase(database);
    if (requestedContext) checkExplainContext();
    checkConnectionPolicy(profileId, request.sql);
    const observedEntry = openSessions.get(profileId);
    const result = await session.runQueryScript(
      request.sql,
      Math.min(900000, Math.max(1000, Number(request.timeoutMs) || 300000)),
      request.confirmed === true,
      typeof request.taskId === 'string' ? request.taskId : null,
      { rowLimit: request.rowLimit, ...(requestedContext ? { explainSettings: requestedSettings, explainSchema: requestedSchema, checkExplainContext } : {}) }
    );
    const settings = requestedSettings ? explainSettings(result?.explainSettings) : null;
    const schema = requestedSchema ? explainSchema(result?.explainSchema) : null;
    if (result) { delete result.explainSettings; delete result.explainSchema; }
    if (result?.kind === 'rows' && /^EXPLAIN\b/i.test(stripLeadingComments(request.sql))) {
      result.explainContext = null;
      // Identity and optional metadata observations of this completed plan;
      // never execution permission or renderer-provided evidence.
      if (observedEntry?.session === session && openSessions.get(profileId) === observedEntry && !session.dead
          && typeof request.taskId === 'string' && request.taskId.length > 0 && request.taskId.length <= 160
          && (session.database === null || typeof session.database === 'string' && session.database.length <= 64)) {
        try {
          assertSessionProfile(observedEntry);
          if (requestedContext) checkExplainContext();
          result.explainContext = { version: 1, profileId, sessionId: observedEntry.sessionId, database: session.database,
            sqlHash: crypto.createHash('sha256').update(request.sql).digest('hex'), taskId: request.taskId,
            checkedAt: new Date().toISOString(), ...(requestedSettings ? { settings } : {}), ...(requestedSchema ? { schema } : {}) };
        } catch { /* Keep the result, but do not compare a stale target. */ }
      }
    }
    return result;
  });
});

handle('db:analyze-query', (payload) => {
  const sql = validateAnalyzeSource(payload?.sql);
  const database = payload?.database;
  const taskId = payload?.taskId;
  if (typeof database !== 'string' || !database || database.length > 64 || database.includes('\0')
      || typeof taskId !== 'string' || !taskId || taskId.length > 160 || taskId.includes('\0')) throw new Error('Chọn database và mã tác vụ hợp lệ để ANALYZE.');
  const timeoutMs = Math.min(60000, Math.max(1000, Number(payload.timeoutMs) || 30000));
  const profileId = checkConnectionPolicy(payload.profileId);
  const generation = backupContextGeneration;
  return withSessionFor(profileId, async session => {
    const current = openSessions.get(profileId);
    const profile = store.getWithSecrets(profileId);
    const fingerprint = productionProfileFingerprint(profile);
    const revision = session.transactionRevision || 0;
    const serverVersion = session.version;
    const started = Date.now();
    const check = (ownedTask = null) => {
      checkConnectionPolicy(profileId);
      if (!current || openSessions.get(profileId) !== current || current.session !== session || session.dead
          || generation !== backupContextGeneration || session.version !== serverVersion || Date.now() - started > 120000
          || productionProfileFingerprint(store.getWithSecrets(profileId)) !== fingerprint) {
        throw Object.assign(new Error('Phiên, tài khoản hoặc cấu hình đã đổi, hoặc xác nhận quá 2 phút. Hãy chạy lại từ đầu.'), { code: 'ANALYZE_CONTEXT_CHANGED' });
      }
      assertSessionProfile(current);
      assertAnalyzeSession(session, ownedTask);
    };
    check();
    const plan = buildAnalyzeQuery(sql, session.version);
    const preview = redactSql(sql);
    const response = await dialog.showMessageBox(mainWindow, {
      type: 'warning', title: 'ANALYZE thực thi truy vấn', message: 'Chạy SELECT để đo kế hoạch thực tế?',
      detail: `Kết nối: ${profile.name || profileId}\nMôi trường: ${profile.environment || 'local'}\nMáy chủ: ${profile.user || ''}@${profile.host || ''}:${profile.port || 3306}\nDatabase: ${database}\nServer: ${session.version}\nĐịnh dạng: ${plan.engine} ${plan.format}\nThời gian chờ: ${Math.ceil(timeoutMs / 1000)} giây\n\nANALYZE thực sự chạy SELECT, có thể tốn CPU/I/O và chờ hoặc giữ khóa. View/hàm phía server có thể có tác động gián tiếp. Bộ kiểm tra SQL không thay thế tài khoản database có quyền tối thiểu. Hủy/timeout đóng phiên; không tự thử lại.\n\nSQL đã che giá trị${preview.length > 12000 ? ' (đã rút gọn)' : ''}:\n${preview.slice(0, 12000)}`,
      buttons: ['Hủy', 'Chạy ANALYZE'], defaultId: 0, cancelId: 0, noLink: true
    });
    if (response.response !== 1) return { canceled: true };
    check();
    if ((session.transactionRevision || 0) !== revision) throw Object.assign(new Error('Trạng thái phiên đã đổi. Hãy xác nhận ANALYZE lại.'), { code: 'ANALYZE_CONTEXT_CHANGED' });
    await session.useDatabase(database);
    check();
    return session.analyzeQuery(sql, timeoutMs, taskId, check);
  }, { exclusive: true });
});

handle('db:cancel-query', (payload) => {
  const profileId = payload && typeof payload === 'object' ? payload.profileId : null;
  const taskId = payload && typeof payload === 'object' ? payload.taskId : null;
  const current = profileId ? openSessions.get(profileId) : activeSession;
  if (!current) return { canceled: false, reason: 'no-session' };
  const canceled = current.session.cancelTask(taskId || null);
  return { canceled, reason: canceled ? 'canceled' : 'not-running' };
});

handle('db:cancel-task', (payload) => {
  const profileId = payload && typeof payload === 'object' ? payload.profileId : null;
  const taskId = payload && typeof payload === 'object' ? payload.taskId : null;
  if (!taskId) return { canceled: false, reason: 'invalid-task' };
  const active = activeDatabaseTransfer;
  if (!active || !profileId || active.profileId !== profileId || active.taskId !== taskId) {
    return { canceled: false, reason: 'not-running' };
  }
  const canceled = cancelDatabaseTransfer(active);
  return { canceled, reason: canceled ? 'canceled' : 'not-running' };
});

handle('db:insert-row', (payload) => {
  if (!payload || typeof payload !== 'object') throw new Error('Tham số không hợp lệ.');
  const profileId = checkConnectionPolicy(payload.profileId);
  return withWriteReview(profileId,'insert-row',payload,(session,request) => { checkConnectionPolicy(profileId); return session.insertRow(request); });
});

handle('db:update-row', (payload) => {
  if (!payload || typeof payload !== 'object') throw new Error('Tham số không hợp lệ.');
  const profileId = checkConnectionPolicy(payload.profileId);
  return withWriteReview(profileId,'update-row',payload,(session,request) => { checkConnectionPolicy(profileId); return session.updateRow(request); });
});

handle('db:delete-rows', (payload) => {
  if (!payload || typeof payload !== 'object') throw new Error('Tham số không hợp lệ.');
  const profileId = checkConnectionPolicy(payload.profileId);
  return withWriteReview(profileId,'delete-rows',payload,(session,request) => { checkConnectionPolicy(profileId); return session.deleteRows(request); });
});

handle('db:pick-import-file', async (payload) => {
  if (activeDatabaseTransfer) throw new Error('Một tác vụ database đang chạy. Hãy đợi tác vụ hoàn tất.');
  const requested = payload && typeof payload === 'object' && typeof payload.format === 'string' ? payload.format : '';
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Chọn tệp dữ liệu để nhập',
    properties: ['openFile'],
    filters: [
      { name: 'CSV/TSV', extensions: ['csv', 'tsv', 'tab'] },
      { name: 'JSON', extensions: ['json'] },
      { name: 'Tất cả tệp', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  const filePath = result.filePaths[0];
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error('Đường dẫn đã chọn không phải là tệp.');
  return {
    canceled: false,
    filePath,
    name: path.basename(filePath),
    size: stat.size,
    format: normalizeFileFormat(requested, filePath)
  };
});

handle('db:preview-import', async (payload) => {
  if (activeDatabaseTransfer) throw new Error('Một tác vụ database đang chạy. Hãy đợi tác vụ hoàn tất.');
  if (!payload || typeof payload !== 'object') throw new Error('Tham số không hợp lệ.');
  return previewImportFile(payload);
});

handle('db:export-file', async (payload) => {
  if (activeDatabaseTransfer) throw new Error('Một tác vụ database đang chạy. Hãy đợi tác vụ hoàn tất.');
  if (!payload || typeof payload !== 'object') throw new Error('Tham số không hợp lệ.');
  if (typeof payload.database !== 'string' || !payload.database) throw new Error('Chưa chọn database để xuất.');
  if (typeof payload.table !== 'string' || !payload.table) throw new Error('Chưa chọn bảng hoặc view để xuất.');
  const format = normalizeFileFormat(payload.format, payload.filePath);
  const extension = format === 'json' ? '.json' : format === 'tsv' ? '.tsv' : '.csv';
  const current = await ensureSession(payload.profileId);
  const profileId = current.profileId;
  const suggested = `${payload.database}.${payload.table}${extension}`.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 180);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Xuất dữ liệu ra tệp',
    defaultPath: suggested,
    filters: [
      format === 'json'
        ? { name: 'JSON', extensions: ['json'] }
        : format === 'tsv'
          ? { name: 'TSV', extensions: ['tsv'] }
          : { name: 'CSV', extensions: ['csv'] },
      { name: 'Tất cả tệp', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePath) return { canceled: true, dialog: true };
  let filePath = result.filePath;
  if (!filePath.toLowerCase().endsWith(extension)) filePath += extension;
  const taskId = typeof payload.taskId === 'string' && payload.taskId ? payload.taskId : null;
  claimDatabaseTransfer({ taskId, profileId, operation: 'export', database: payload.database, table: payload.table });
  try {
    const stats = await saveBackupFile(filePath, (write) =>
      withSessionFor(profileId, (session) => session.exportTableFile({
        database: payload.database,
        table: payload.table,
        format,
        filePath,
        columns: payload.columns,
        filters: payload.filters,
        search: payload.search,
        searchColumn: payload.searchColumn,
        searchMode: payload.searchMode,
        filterTree: payload.filterTree,
        sorts: payload.sorts,
        orderBy: payload.orderBy,
        taskId
      }, write, (progress) => sendDbProgress({
        ...progress,
        taskId,
        profileId,
        database: payload.database,
        table: payload.table
      }))));
    return { canceled: false, filePath, ...stats };
  } catch (error) {
    if (error && error.code === 'EXPORT_CANCELED') {
      return { canceled: true, filePath, ...(error.partial || {}) };
    }
    throw error;
  } finally {
    activeDatabaseTransfer = null;
  }
});

handle('db:export-query', async (payload) => {
  if (!payload || typeof payload !== 'object') throw new Error('Tham số không hợp lệ.');
  if (typeof payload.sql !== 'string' || !payload.sql.trim()) throw new Error('Câu lệnh SQL không hợp lệ.');
  assertPlanExport(payload.sql);
  const checkedProfileId = checkConnectionPolicy(payload.profileId, payload.sql);
  // Export owns a file stream: never defer its execution into an approval whose
  // stream would already be closed. Unclassified production SQL uses the editor.
  if (store.getWithSecrets(checkedProfileId).environment === 'production') assertReadOnlySql({readOnly:true},payload.sql);
  if (typeof payload.taskId !== 'string' || !payload.taskId) throw new Error('Thiếu mã tác vụ xuất dữ liệu.');
  const format = payload.format === 'json' ? 'json' : 'csv';
  const extension = format === 'json' ? '.json' : '.csv';
  const database = typeof payload.database === 'string' && payload.database ? payload.database : null;
  const taskId = payload.taskId;
  const transfer = claimDatabaseTransfer({ taskId, profileId: payload.profileId || activeSession?.profileId, operation: 'export', database, pending: true });
  let filePath;
  try {
    const current = await ensureSession(checkedProfileId);
    const profileId = current.profileId;
    transfer.profileId = profileId;
    if (transfer.canceled) return { canceled: true };
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Xuất toàn bộ kết quả truy vấn',
      defaultPath: `query-result${extension}`,
      filters: [
        format === 'json' ? { name: 'JSON', extensions: ['json'] } : { name: 'CSV', extensions: ['csv'] },
        { name: 'Tất cả tệp', extensions: ['*'] }
      ]
    });
    if (transfer.canceled) return { canceled: true };
    if (result.canceled || !result.filePath) return { canceled: true, dialog: true };
    filePath = result.filePath;
    if (!filePath.toLowerCase().endsWith(extension)) filePath += extension;
    const stats = await saveBackupFile(filePath, (write) =>
      withSessionFor(profileId, async (session) => {
        checkConnectionPolicy(profileId, payload.sql);
        if (store.getWithSecrets(profileId).environment === 'production') assertReadOnlySql({readOnly:true},payload.sql);
        if (session.activeTask) throw new Error('Phiên kết nối đang chạy một tác vụ khác.');
        transfer.session = session;
        if (database) await session.useDatabase(database);
        checkConnectionPolicy(profileId, payload.sql);
        if (transfer.canceled) throw Object.assign(new Error('Đã hủy xuất dữ liệu.'), { code: 'EXPORT_CANCELED' });
        transfer.pending = false;
        return session.exportQueryFile({ sql: payload.sql, format, filePath, taskId }, write, (progress) => sendDbProgress({
          ...progress,
          taskId,
          profileId,
          database
        }));
      }));
    return { canceled: false, filePath, ...stats };
  } catch (error) {
    if (error && error.code === 'EXPORT_CANCELED') {
      return { canceled: true, filePath, ...(error.partial || {}) };
    }
    throw error;
  } finally {
    if (activeDatabaseTransfer === transfer) activeDatabaseTransfer = null;
  }
});

handle('db:import-file', async (payload) => {
  if (activeDatabaseTransfer) throw new Error('Một tác vụ database đang chạy. Hãy đợi tác vụ hoàn tất.');
  if (!payload || typeof payload !== 'object') throw new Error('Tham số không hợp lệ.');
  if (typeof payload.database !== 'string' || !payload.database) throw new Error('Chưa chọn database đích.');
  if (typeof payload.table !== 'string' || !payload.table) throw new Error('Chưa chọn bảng đích.');
  if (typeof payload.filePath !== 'string' || !payload.filePath) throw new Error('Chưa chọn tệp để nhập.');
  const profileId = resolveProfileId(payload.profileId);
  checkConnectionPolicy(profileId);
  const format = normalizeFileFormat(payload.format, payload.filePath);
  if (!await confirmProductionTransfer(profileId,payload.database,payload.filePath,'import',
    `Bảng đích: ${payload.table}\nĐịnh dạng: ${format}\nChế độ ghi: ${payload.mode || 'insert'}\nTransaction: ${payload.transaction || 'batch'}`)) return {canceled:true};
  const taskId = typeof payload.taskId === 'string' && payload.taskId ? payload.taskId : null;
  const transfer = claimDatabaseTransfer({ taskId, profileId, operation: 'import', database: payload.database, table: payload.table, pending: true });
  let session;
  try {
    checkConnectionPolicy(profileId);
    session = new DatabaseSession(runtimeProfile(store.getWithSecrets(profileId)));
    transfer.session = session;
    await session.connect();
    if (transfer.canceled) return { canceled: true };
    if (typeof session.prepareWorkerForImport === 'function') await session.prepareWorkerForImport();
    checkConnectionPolicy(profileId);
    transfer.pending = false;
    const stats = await session.importFile({
      database: payload.database,
      table: payload.table,
      filePath: payload.filePath,
      format,
      delimiter: payload.delimiter,
      hasHeader: payload.hasHeader !== false,
      mapping: payload.mapping,
      mode: payload.mode,
      transaction: payload.transaction,
      allowNonTransactional: payload.allowNonTransactional === true,
      taskId
    }, (progress) => sendDbProgress({
      ...progress,
      taskId,
      profileId,
      database: payload.database,
      table: payload.table
    }));
    return { canceled: false, ...stats };
  } catch (error) {
    if (error && error.code === 'IMPORT_CANCELED') {
      return { canceled: true, ...(error.partial || {}) };
    }
    throw error;
  } finally {
    try { await session?.close(); }
    finally { if (activeDatabaseTransfer === transfer) activeDatabaseTransfer = null; }
  }
});

async function runCatalogBackup(payload, scheduled = null) {
  if (activeDatabaseTransfer) throw new Error('Một tác vụ database đang chạy. Hãy đợi tác vụ hoàn tất.');
  if (!payload || typeof payload !== 'object') throw new Error('Tham số không hợp lệ.');
  if (typeof payload.database !== 'string' || !payload.database) throw new Error('Chưa chọn database để sao lưu.');
  const taskId = typeof payload.taskId === 'string' && payload.taskId ? payload.taskId : null;
  const requested = {
    database: payload.database,
    tables: Array.isArray(payload.tables) ? payload.tables.filter((name) => typeof name === 'string' && name) : null,
    routines: Array.isArray(payload.routines) ? payload.routines : [],
    events: Array.isArray(payload.events) ? payload.events : [],
    includeStructure: payload.includeStructure !== false,
    includeData: payload.includeData !== false,
    dropTables: payload.dropTables === true,
    stripDefiner: payload.stripDefiner === true,
    taskId
  };
  if (!requested.includeStructure && !requested.includeData) throw new Error('Hãy chọn cấu trúc hoặc dữ liệu để sao lưu.');
  const profileId = payload.profileId || activeSession?.profileId;
  if (!profileId) throw new Error('Chưa chọn kết nối để sao lưu.');
  const transfer = claimDatabaseTransfer({ taskId, profileId, operation: 'backup', pending: true });
  const generation = backupContextGeneration;
  if (scheduled) transfer.scheduleId = scheduled.id;
  const retentionRepository = createRetentionStore(app.getPath('userData'));
  let retentionSettings, retentionSettingsError;
  try { retentionSettings = retentionRepository.read(profileId, requested.database); }
  catch (error) { retentionSettingsError = error.message; }
  let session;
  try {
    const backupProfile = store.getWithSecrets(profileId);
    const checkSchedule = () => {
      if (!scheduled) return;
      const { repository, scheduler } = backupSchedules();
      const current = repository.read().find(item => item.id === scheduled.id);
      if (scheduler.stopped || transfer.canceled || !current?.enabled || current.revision !== scheduled.revision || current.lastRun?.taskId !== taskId) throw Object.assign(new Error('Lịch backup đã dừng hoặc thay đổi.'), { code: 'BACKUP_CANCELED' });
      if (targetIdentity(store.getWithSecrets(profileId)) !== scheduled.target) throw Object.assign(new Error('Đích kết nối đã thay đổi. Hãy lưu lại lịch backup.'), { code: 'SCHEDULE_TARGET_CHANGED' });
    };
    checkSchedule();
    session = new DatabaseSession(runtimeProfile(backupProfile));
    transfer.session = session;
    await session.connect();
    checkSchedule();
    if (transfer.canceled) return { canceled: true, id: null, filePath: null };
    if (scheduled) {
      requested.tables = (await session.listTables(requested.database)).map(item => item.name);
      checkSchedule();
      requested.routines = (await session.listRoutines(requested.database)).map(item => `${item.type}:${item.name}`);
      checkSchedule();
      requested.events = (await session.listEvents(requested.database)).map(item => item.name);
      if ([requested.tables, requested.routines, requested.events].some(items => items.length > 2000)) throw new Error('Lịch backup hiện hỗ trợ tối đa 2.000 đối tượng mỗi nhóm.');
      checkSchedule();
    }
    const directory = backupDirectory(app.getPath('userData'), profileId, requested.database);
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    const id = backupName();
    const filePath = path.join(directory, id);
    const stats = await saveBackupFile(filePath, (write) => {
      if (transfer.canceled) throw Object.assign(new Error('Đã hủy sao lưu.'), { code: 'BACKUP_CANCELED' });
      checkSchedule();
      transfer.pending = false;
      return session.backupDatabase(requested, write,
        (progress) => sendDbProgress({ ...progress, taskId, profileId, database: requested.database }));
    }, {
      appName: 'SqlPro',
      appVersion: typeof app.getVersion === 'function' ? app.getVersion() : null,
      exclusive: true,
      source: { profileId, database: requested.database, serverVersion: session.version || null, target: targetIdentity(backupProfile) },
      selection: {
        includeStructure: requested.includeStructure,
        includeData: requested.includeData,
        dropTables: requested.dropTables,
        stripDefiner: requested.stripDefiner,
        tables: requested.tables || [],
        routines: requested.routines,
        events: requested.events
      }
    });
    let retention = retentionSettingsError ? { status: 'failed', reason: `Không đọc được chính sách tự dọn: ${retentionSettingsError}` } : { status: 'disabled' };
    if (retentionSettings?.automaticAfterBackup) {
      if (backupInspection.active) retention = { status: 'skipped', reason: 'Có lượt đọc backup đang chạy. Chưa tự dọn.' };
      else {
        const controller = new AbortController();
        transfer.operation = 'backup-retention'; transfer.controller = controller; transfer.database = requested.database;
        transfer.progress = { phase: 'checking', total: 0, deleted: 0, reclaimedBytes: 0 };
        if (transfer.canceled) controller.abort();
        retention = await runAutomaticRetention({ root: app.getPath('userData'), profileId, database: requested.database,
          backupId: id, stats, settings: retentionSettings, service: retentionApply(), signal: controller.signal,
          onHistory: historyId => { transfer.historyId = historyId; },
          isCanceled: () => transfer.canceled || generation !== backupContextGeneration, checkContext: () => {
            checkSchedule();
            if (generation !== backupContextGeneration) throw Object.assign(new Error('Phiên ứng dụng đã thay đổi. Dừng dọn backup.'), { code: 'BACKUP_RETENTION_CANCELLED' });
            if (productionProfileFingerprint(store.getWithSecrets(profileId)) !== productionProfileFingerprint(backupProfile)) throw new Error('Kết nối đã thay đổi trong khi sao lưu. Không tự dọn thêm.');
            if (JSON.stringify(retentionRepository.read(profileId, requested.database)) !== JSON.stringify(retentionSettings)) throw new Error('Chính sách đã thay đổi trong khi sao lưu. Không tự dọn thêm.');
            if (backupInspection.active) throw new Error('Có lượt đọc backup vừa bắt đầu. Dừng tự dọn.');
          }, onProgress: progress => {
            if (activeDatabaseTransfer !== transfer) return;
            transfer.progress = progress;
            sendDbProgress({ operation: 'backup', stage: 'retention', taskId, profileId, database: requested.database,
              percent: 100, message: `Đang tự dọn backup: ${progress.deleted}/${progress.total} bản đã xóa` });
          } });
      }
    }
    return { canceled: false, id, filePath, ...stats, retention };
  } catch (error) {
    if (error && error.code === 'BACKUP_CANCELED') {
      return { canceled: true, id: null, filePath: null, ...(error.partial || {}) };
    }
    throw error;
  } finally {
    try { await session?.close(); }
    finally { if (activeDatabaseTransfer === transfer) activeDatabaseTransfer = null; }
  }
}

handle('db:backup', payload => runCatalogBackup(payload));

handle('db:get-backup-schedule', payload => {
  if (!payload || typeof payload.database !== 'string') throw new Error('Chưa chọn database.');
  const profileId = resolveProfileId(payload.profileId);
  const profile = store.getWithSecrets(profileId);
  const { repository, scheduler } = backupSchedules();
  const schedule = repository.read().find(item => item.id === scheduleId(profileId, payload.database));
  return { schedule: schedule ? { ...schedule, target: undefined, targetMatches: schedule.target === targetIdentity(profile) } : null,
    paused: scheduler.stopped, schedulerError: scheduler.error };
});

handle('db:save-backup-schedule', async payload => {
  if (!payload || typeof payload.database !== 'string') throw new Error('Chưa chọn database.');
  const profileId = resolveProfileId(payload.profileId);
  const profile = store.getWithSecrets(profileId);
  const id = scheduleId(profileId, payload.database);
  const { repository, scheduler } = backupSchedules();
  if (activeDatabaseTransfer) throw new Error('Đang có tác vụ database. Hãy đợi hoàn tất trước khi lưu lịch.');
  const before = JSON.stringify(repository.read());
  const generation = scheduler.generation;
  const candidate = validateSchedule({ id, profileId, database: payload.database, enabled: true,
    intervalHours: payload.intervalHours, nextRunAt: payload.nextRunAt, timeZone: payload.timeZone,
    target: targetIdentity(profile), revision: crypto.randomBytes(16).toString('hex'), lastRun: null });
  const started = Date.now();
  if (Date.parse(candidate.nextRunAt) <= started) throw new Error('Lần chạy đầu phải trong tương lai.');
  const confirmation = await dialog.showMessageBox(mainWindow, {
    type: 'question', title: 'Bật lịch backup khi app đang mở', message: 'Lưu và bật lịch backup cho database này?',
    detail: `Kết nối: ${profile.name || profileId}\nMáy chủ: ${profile.host || ''}:${profile.port || 3306}\nDatabase: ${candidate.database}\nChu kỳ: mỗi ${candidate.intervalHours} giờ trôi qua\nBắt đầu: ${new Intl.DateTimeFormat('vi-VN', { timeZone: candidate.timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(candidate.nextRunAt))} (${candidate.timeZone})\n\nSao lưu cấu trúc và dữ liệu của toàn bộ bảng/view/routine/event mà tài khoản nhìn thấy, vào catalog local bằng phiên riêng. Chỉ chạy khi app mở; quá hạn 60 giây thì ghi nhận bỏ lỡ, không chạy bù và không tự retry. Chính sách tự dọn đã bật cũng được áp dụng sau backup thành công. Không tự chấp nhận SSH host key hoặc bỏ kiểm tra TLS khi chạy nền.`,
    buttons: ['Hủy', 'Lưu và bật lịch'], defaultId: 0, cancelId: 0, noLink: true
  });
  if (confirmation.response !== 1) return { canceled: true };
  if (Date.now() - started > 120000 || generation !== scheduler.generation || activeDatabaseTransfer || JSON.stringify(repository.read()) !== before
      || productionProfileFingerprint(store.getWithSecrets(profileId)) !== productionProfileFingerprint(profile)) throw new Error('Kết nối/lịch hoặc xác nhận đã thay đổi. Hãy lưu lại.');
  const saved = repository.save(candidate);
  if (schedulerReady) { scheduler.recover(); scheduler.start(); }
  return { schedule: { ...saved, target: undefined, targetMatches: true } };
});

handle('db:pause-backup-schedule', payload => {
  if (!payload || typeof payload.database !== 'string') throw new Error('Chưa chọn database.');
  const profileId = resolveProfileId(payload.profileId);
  store.getWithSecrets(profileId);
  const id = scheduleId(profileId, payload.database);
  const repository = backupSchedules().repository;
  const schedule = repository.read().find(item => item.id === id);
  if (schedule) repository.update(id, schedule.revision, item => ({ ...item, enabled: false }));
  if (activeDatabaseTransfer?.scheduleId === id) cancelDatabaseTransfer(activeDatabaseTransfer);
  return { paused: true };
});

handle('db:delete-backup-schedule', payload => {
  if (!payload || typeof payload.database !== 'string') throw new Error('Chưa chọn database.');
  const profileId = resolveProfileId(payload.profileId);
  store.getWithSecrets(profileId);
  const id = scheduleId(profileId, payload.database);
  if (activeDatabaseTransfer?.scheduleId === id) throw new Error('Lịch đang chạy. Hãy tạm dừng và đợi kết thúc trước khi xóa lịch.');
  backupSchedules().repository.remove(id);
  return { deleted: true };
});

handle('db:list-backups', async (payload, legacyDatabase) => {
  const database = payload && typeof payload === 'object' ? payload.database : (legacyDatabase || payload);
  const profileId = payload && typeof payload === 'object' ? payload.profileId : null;
  if (typeof database !== 'string' || !database) throw new Error('Chưa chọn database.');
  const current = await ensureSession(profileId);
  return listBackups(app.getPath('userData'), current.profileId, database);
});

for (const operation of ['get', 'save', 'clear']) {
  handle(`db:${operation}-backup-retention-policy`, async (payload) => {
    if (!payload || typeof payload.database !== 'string' || !payload.database) throw new Error('Chưa chọn database.');
    if (operation !== 'get' && activeDatabaseTransfer) throw new Error('Đang có tác vụ database. Hãy đợi hoàn tất trước khi đổi chính sách.');
    const generation = backupContextGeneration;
    const current = await ensureSession(payload.profileId);
    const repository = createRetentionStore(app.getPath('userData'));
    if (operation === 'get') return repository.read(current.profileId, payload.database);
    if (generation !== backupContextGeneration) throw new Error('Phiên ứng dụng đã thay đổi. Hãy mở lại chính sách.');
    if (activeDatabaseTransfer) throw new Error('Đang có tác vụ database. Hãy đợi hoàn tất trước khi đổi chính sách.');
    if (operation === 'clear') return repository.clear(current.profileId, payload.database);
    const policy = normalizeRetentionPolicy(payload.policy);
    const automaticAfterBackup = payload.automaticAfterBackup === undefined ? false : payload.automaticAfterBackup;
    if (typeof automaticAfterBackup !== 'boolean') throw new Error('Trạng thái tự dọn không hợp lệ.');
    const before = repository.read(current.profileId, payload.database);
    const profile = store.getWithSecrets(current.profileId);
    if (automaticAfterBackup && (!before.automaticAfterBackup || JSON.stringify(before.policy) !== JSON.stringify(policy))) {
      const started = Date.now();
      const confirmation = await dialog.showMessageBox(mainWindow, {
        type: 'warning', title: 'Bật tự dọn backup', message: 'Tự xóa backup cũ sau khi backup mới thành công?',
        detail: `Kết nối: ${profile.name || current.profileId}\nDatabase: ${payload.database}\nGiới hạn: ${policy.maxCount ?? 'không giới hạn'} bản; ${policy.maxAgeDays ?? 'không giới hạn'} ngày; ${policy.maxBytes ?? 'không giới hạn'} byte SQL.\n\nChỉ dọn các bản cùng nguồn và cùng phạm vi lựa chọn với bản mới. Luôn giữ bản ghim và bản mới đã xác minh checksum. Mỗi lượt tối đa 100 bản; lỗi/hủy dừng phần còn lại, không hoàn tác tệp đã xóa. Những lần backup tiếp theo trên máy này sẽ áp dụng chính sách mà không hỏi lại.`,
        buttons: ['Hủy', 'Bật tự dọn theo chính sách'], defaultId: 0, cancelId: 0, noLink: true
      });
      if (confirmation.response !== 1) return { canceled: true };
      if (Date.now() - started > 120000 || generation !== backupContextGeneration || productionProfileFingerprint(store.getWithSecrets(current.profileId)) !== productionProfileFingerprint(profile)
          || JSON.stringify(repository.read(current.profileId, payload.database)) !== JSON.stringify(before)) throw new Error('Cấu hình hoặc xác nhận đã thay đổi. Hãy lưu lại chính sách.');
    }
    if (activeDatabaseTransfer) throw new Error('Tác vụ database vừa bắt đầu. Hãy đợi hoàn tất.');
    return repository.save(current.profileId, payload.database, policy, { automaticAfterBackup });
  });
}

handle('db:preview-backup-retention', async (payload) => {
  if (activeDatabaseTransfer) throw new Error('Một tác vụ database đang chạy. Hãy đợi tác vụ hoàn tất.');
  if (!payload || typeof payload.database !== 'string' || !payload.database) throw new Error('Chưa chọn database.');
  const policy = normalizeRetentionPolicy(payload.policy);
  const current = await ensureSession(payload.profileId);
  const plan = await retentionApply().preview(current.profileId, payload.database, policy);
  if (activeDatabaseTransfer) throw new Error('Một tác vụ database vừa bắt đầu. Hãy xem trước lại sau khi hoàn tất.');
  return plan;
});

handle('db:apply-backup-retention', async (payload) => {
  if (activeDatabaseTransfer || backupInspection.active) throw new Error('Có tác vụ đang dùng backup. Hãy đợi hoàn tất.');
  if (!payload || typeof payload.database !== 'string' || !payload.database) throw new Error('Chưa chọn database.');
  if (typeof payload.taskId !== 'string' || !payload.taskId || payload.taskId.length > 120) throw new Error('Thiếu mã tác vụ dọn backup.');
  const profileId = resolveProfileId(payload.profileId);
  const profile = store.getWithSecrets(profileId);
  const entry = retentionApply().consume(profileId, payload.database, payload.token);
  const generation = backupContextGeneration;
  const candidates = entry.plan.rows.filter(row => row.action === 'remove').reverse();
  if (candidates.length > 100) throw new Error('Mỗi lần dọn tối đa 100 bản. Hãy điều chỉnh giới hạn và xem trước lại.');
  const confirmation = await dialog.showMessageBox(mainWindow, {
    type: 'warning', title: 'Dọn bản backup cục bộ', message: `Xóa ${candidates.length} bản backup đã xem trước?`,
    detail: `Kết nối: ${profile.name || profileId}\nDatabase: ${entry.database}\nDung lượng SQL: ${entry.plan.removeBytes} byte\n${candidates.map(row => `${row.name} (${row.id})`).join('\n')}\n\nThao tác xóa tệp cục bộ và metadata, không thể hoàn tác trong SqlPro. Bản ghim và bản giữ lại được kiểm tra lại trước khi dọn; tác vụ dừng ở lỗi đầu tiên.`,
    buttons: ['Hủy', 'Xóa các bản đã liệt kê'], defaultId: 0, cancelId: 0, noLink: true
  });
  if (confirmation.response !== 1) return { canceled: true };
  if (generation !== backupContextGeneration || productionProfileFingerprint(store.getWithSecrets(profileId)) !== productionProfileFingerprint(profile)) throw new Error('Phiên ứng dụng hoặc kết nối đã thay đổi. Hãy xem trước lại.');
  if (backupInspection.active) throw new Error('Đang đọc backup. Hãy đợi hoàn tất rồi xem trước lại.');
  const controller = new AbortController();
  const transfer = claimDatabaseTransfer({ profileId, taskId: payload.taskId, database: payload.database,
    operation: 'backup-retention', controller, progress: { phase: 'checking', total: candidates.length, deleted: 0, reclaimedBytes: 0 } });
  const history = createRetentionHistory(app.getPath('userData'));
  let historyId;
  try {
    historyId = history.begin(profileId, payload.database, entry.plan);
    transfer.historyId = historyId;
    const result = await retentionApply().apply(entry, { isCanceled: () => transfer.canceled === true,
      checkContext: () => {
        if (generation !== backupContextGeneration || productionProfileFingerprint(store.getWithSecrets(profileId)) !== productionProfileFingerprint(profile)) throw Object.assign(new Error('Phiên ứng dụng hoặc kết nối đã thay đổi. Dừng dọn backup.'), { code: 'BACKUP_RETENTION_CHANGED' });
      },
      signal: controller.signal, onProgress: progress => { if (activeDatabaseTransfer === transfer) transfer.progress = progress; } });
    try { history.finish(profileId, payload.database, historyId, result); }
    catch (error) { result.historySaveError = error.message; }
    return { ...result, historyId };
  } catch (error) {
    if (historyId) {
      try { history.finish(profileId, payload.database, historyId, { deleted: [], reclaimedBytes: 0,
        remaining: candidates.map(row => row.id), failed: [{ id: candidates[0].id, sqlDeleted: false, code: error.code || 'BACKUP_RETENTION_FAILED' }] }); }
      catch { /* Preserve the running record as evidence of an incomplete report. */ }
    }
    throw error;
  }
  finally { if (activeDatabaseTransfer === transfer) activeDatabaseTransfer = null; }
});

handle('db:backup-retention-history', payload => {
  if (!payload || typeof payload.database !== 'string' || !payload.database) throw new Error('Chưa chọn database.');
  const profileId = resolveProfileId(payload.profileId);
  store.getWithSecrets(profileId);
  const transfer = activeDatabaseTransfer;
  return createRetentionHistory(app.getPath('userData')).read(profileId, payload.database).map(record => ({ ...record,
    state: record.state === 'running' && !(transfer?.profileId === profileId && transfer.database === payload.database
      && transfer.operation === 'backup-retention' && transfer.historyId === record.id) ? 'incomplete' : record.state }));
});

handle('db:export-backup-retention-history', async payload => {
  if (!payload || typeof payload.database !== 'string' || !payload.database) throw new Error('Chưa chọn database.');
  const profileId = resolveProfileId(payload.profileId);
  const profile = store.getWithSecrets(profileId);
  const database = payload.database;
  const generation = backupContextGeneration;
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Xuất lịch sử dọn backup',
    defaultPath: `sqlpro-retention-history-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'Báo cáo JSON', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  if (generation !== backupContextGeneration || productionProfileFingerprint(store.getWithSecrets(profileId)) !== productionProfileFingerprint(profile)) throw new Error('Phiên ứng dụng hoặc kết nối đã thay đổi. Hãy mở lại lịch sử để xuất.');
  const records = createRetentionHistory(app.getPath('userData')).read(profileId, database);
  const transfer = activeDatabaseTransfer;
  const activeHistoryId = transfer?.profileId === profileId && transfer.database === database
    && transfer.operation === 'backup-retention' ? transfer.historyId : null;
  return exportRetentionHistory({ filePath: result.filePath, userData: app.getPath('userData'),
    records, appVersion: app.getVersion(), activeHistoryId });
});

handle('db:backup-retention-status', payload => {
  const transfer = activeDatabaseTransfer;
  if (!transfer || transfer.operation !== 'backup-retention' || !payload?.taskId
      || transfer.profileId !== payload.profileId || transfer.taskId !== payload.taskId || transfer.database !== payload.database) return { running: false };
  return { running: true, stopping: transfer.canceled, ...transfer.progress };
});

handle('db:delete-backup', async (payload) => {
  if (activeDatabaseTransfer) throw new Error('Một tác vụ database đang chạy. Hãy đợi tác vụ hoàn tất.');
  if (!payload || typeof payload.database !== 'string' || !payload.database) throw new Error('Chưa chọn database.');
  const current = await ensureSession(payload.profileId);
  return deleteBackup(app.getPath('userData'), current.profileId, payload.database, payload.id);
});

handle('db:rename-backup', async (payload) => {
  if (activeDatabaseTransfer) throw new Error('Một tác vụ database đang chạy. Hãy đợi tác vụ hoàn tất.');
  if (!payload || typeof payload.database !== 'string' || !payload.database) throw new Error('Chưa chọn database.');
  const current = await ensureSession(payload.profileId);
  return renameBackup(app.getPath('userData'), current.profileId, payload.database, payload.id, payload.name);
});

handle('db:update-backup-annotations', async (payload) => {
  if (activeDatabaseTransfer) throw new Error('Một tác vụ database đang chạy. Hãy đợi tác vụ hoàn tất.');
  if (!payload || typeof payload.database !== 'string' || !payload.database) throw new Error('Chưa chọn database.');
  const current = await ensureSession(payload.profileId);
  return updateBackupAnnotations(app.getPath('userData'), current.profileId, payload.database, payload.id, payload.patch);
});

handle('db:verify-backup', async (payload) => {
  if (!payload || typeof payload.database !== 'string' || !payload.database) throw new Error('Chưa chọn database.');
  if (typeof payload.id !== 'string' || !payload.id) throw new Error('Chưa chọn bản sao lưu.');
  const current = await ensureSession(payload.profileId);
  return verifyBackup(app.getPath('userData'), current.profileId, payload.database, payload.id);
});

handle('db:inspect-backup', async (payload) => {
  if (activeDatabaseTransfer?.operation === 'backup-retention') throw new Error('Đang dọn backup. Hãy đợi hoàn tất.');
  if (!payload || typeof payload.database !== 'string' || !payload.database) throw new Error('Chưa chọn database.');
  const { database, id, taskId } = payload;
  const profileId = resolveProfileId(payload.profileId);
  store.getWithSecrets(profileId);
  const generation = backupContextGeneration;
  const filePath = await resolveBackup(app.getPath('userData'), profileId, database, id);
  if (generation !== backupContextGeneration) throw new Error('Phiên ứng dụng đã thay đổi. Hãy mở lại bản xem trước.');
  if (activeDatabaseTransfer?.operation === 'backup-retention') throw new Error('Đang dọn backup. Hãy đợi hoàn tất.');
  const result = await backupInspection.inspect({profileId,database,id,filePath,taskId});
  if (generation !== backupContextGeneration) throw new Error('Phiên ứng dụng đã thay đổi. Hãy mở lại bản xem trước.');
  return result;
});

handle('db:cancel-inspect-backup',(payload)=>backupInspection.cancel(payload?.profileId,payload?.taskId));
handle('db:inspect-backup-status',(payload)=>backupInspection.status(payload?.profileId,payload?.taskId));

function backupSelectionRequest(payload) {
  if (!payload || typeof payload.database !== 'string' || !payload.database) throw new Error('Chưa chọn database.');
  const profileId = resolveProfileId(payload.profileId);
  const { database, id, taskId } = payload;
  if (typeof taskId !== 'string' || !taskId || taskId.length > 120) throw new Error('Thiếu mã tác vụ xem trước.');
  const selection = { tables: Array.isArray(payload.tables) ? [...payload.tables] : null,
    includeStructure: payload.includeStructure, includeData: payload.includeData };
  if (!selection.tables?.length || selection.tables.length > 1000 || selection.tables.some(name => typeof name !== 'string' || !name || name.length > 64)
      || new Set(selection.tables).size !== selection.tables.length
      || ['includeStructure', 'includeData'].some(key => selection[key] !== undefined && typeof selection[key] !== 'boolean')
      || selection.includeStructure === false && selection.includeData === false) throw new Error('Chọn 1–1.000 bảng khác nhau và ít nhất cấu trúc hoặc dữ liệu.');
  return { profileId, database, id, taskId, selection };
}

handle('db:preview-backup-selection', async payload => {
  if (activeDatabaseTransfer?.operation === 'backup-retention') throw new Error('Đang dọn backup. Hãy đợi hoàn tất.');
  const { profileId, database, id, taskId, selection } = backupSelectionRequest(payload);
  store.getWithSecrets(profileId);
  const generation = backupContextGeneration;
  const filePath = await resolveBackup(app.getPath('userData'), profileId, database, id);
  if (activeDatabaseTransfer?.operation === 'backup-retention' || generation !== backupContextGeneration) throw new Error('Phiên ứng dụng hoặc tác vụ đã thay đổi. Hãy mở lại bản xem trước.');
  const result = await backupInspection.inspect({ profileId, database, id, filePath, taskId });
  if (generation !== backupContextGeneration) throw new Error('Phiên ứng dụng đã thay đổi. Hãy mở lại bản xem trước.');
  return { ...previewRestoreSelection(result.selectionPreview, selection), checksum: result.checksum, cached: result.cached };
});

handle('db:preview-backup-selection-target', async payload => {
  const { profileId, database, id, taskId, selection } = backupSelectionRequest(payload);
  const conflictPolicy = normalizeConflictPolicy(payload.conflictPolicy);
  const targetDatabase = payload.targetDatabase;
  if (typeof targetDatabase !== 'string' || !targetDatabase || targetDatabase.length > 64 || targetDatabase.includes('\0')) throw new Error('Chọn database đích hợp lệ (1–64 ký tự).');
  const profile = store.getWithSecrets(profileId);
  const fingerprint = productionProfileFingerprint(profile);
  const generation = backupContextGeneration;
  const transfer = claimDatabaseTransfer({ profileId, taskId, operation: 'backup-selection-preview', pending: true, controller: new AbortController() });
  const check = () => {
    if (transfer.timedOut) throw Object.assign(new Error('Kiểm tra đích vượt giới hạn 60 giây.'), { code: 'SELECTION_PREVIEW_TIMEOUT' });
    if (transfer.canceled || generation !== backupContextGeneration) throw Object.assign(new Error('Đã hủy kiểm tra đích.'), { code: 'SELECTION_PREVIEW_CANCELED' });
    if (productionProfileFingerprint(store.getWithSecrets(profileId)) !== fingerprint) throw new Error('Kết nối đã thay đổi. Hãy kiểm tra đích lại.');
  };
  const timer = setTimeout(() => { transfer.timedOut = true; cancelDatabaseTransfer(transfer); }, 60000);
  let session, report;
  try {
    const filePath = await resolveBackup(app.getPath('userData'), profileId, database, id);
    check();
    report = await withAnnotationLock(filePath, async () => {
      check();
      const before = await fs.promises.lstat(filePath);
      if (!before.isFile()) throw new Error('Tệp backup không hợp lệ.');
      const identity = JSON.stringify(fileIdentity(before));
      check();
      const scanned = await backupInspection.inspect({ profileId, database, id, filePath, taskId, fresh: true, signal: transfer.controller.signal });
      check();
      const source = previewRestoreSelection(scanned.selectionPreview, selection);
      session = new DatabaseSession(runtimeProfile(profile));
      transfer.session = session;
      await session.connect();
      check();
      const facts = await collectSelectionTargetFacts(session, targetDatabase, check, selection.tables);
      check();
      if (JSON.stringify(fileIdentity(await fs.promises.lstat(filePath))) !== identity) throw new Error('Tệp backup đã thay đổi. Hãy xem trước lại.');
      check();
      const identityDigest = targetIdentity(profile);
      const targetReview = buildSelectionTargetPreview({ source, checksum: scanned.checksum, targetIdentity: identityDigest, facts });
      const draftPlan = buildSelectionDraft({ inventory: scanned.selectionPreview, source, checksum: scanned.checksum, targetIdentity: identityDigest, targetReview, conflictPolicy });
      return { ...source, checksum: scanned.checksum, cached: false, targetReview, draftPlan };
    });
  } catch (error) {
    check();
    throw error;
  } finally {
    clearTimeout(timer);
    try { await session?.close(); }
    finally { if (activeDatabaseTransfer === transfer) activeDatabaseTransfer = null; }
  }
  check();
  return report;
});

handle('db:inspect-restore-objects', async payload => {
  if (activeDatabaseTransfer?.operation === 'backup-retention') throw new Error('Đang dọn backup. Hãy đợi hoàn tất.');
  const profileId = payload?.profileId;
  const database = payload?.database;
  const id = payload?.id;
  const taskId = payload?.taskId;
  if (!profileId || !database || !id || !taskId) throw new Error('Thiếu tham số quét đối tượng backup.');
  store.getWithSecrets(profileId);
  const filePath = await resolveBackup(app.getPath('userData'), profileId, database, id);
  const stat = await fs.promises.lstat(filePath);
  if (!stat.isFile()) throw new Error('Tệp backup không hợp lệ.');

  const inv = new RestoreObjectInventory(database);
  const parser = new SqlScriptParser();
  const hash = crypto.createHash('sha256');

  const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
  let statementCount = 0;

  for await (const chunk of stream) {
    hash.update(chunk);
    for (const stmt of parser.push(chunk)) {
      statementCount++;
      inv.addStatement(stmt, statementCount);
    }
  }
  for (const stmt of parser.end()) {
    statementCount++;
    inv.addStatement(stmt, statementCount);
  }

  const checksum = hash.digest('hex');
  const graph = inv.buildDependencyGraph();
  const cycles = graph.detectCycles();

  return {
    checksum,
    database,
    counts: {
      tables: inv.tables.size,
      views: inv.views.size,
      functions: inv.functions.size,
      procedures: inv.procedures.size,
      triggers: inv.triggers.size,
      events: inv.events.size,
      statements: statementCount
    },
    tables: Array.from(inv.tables.values()).map(t => ({ name: t.name, createStatements: t.createStatements, dataStatements: t.dataStatements, dropStatements: t.dropStatements, dependencies: t.dependencies })),
    views: Array.from(inv.views.values()).map(v => ({ name: v.name, createStatements: v.createStatements, dropStatements: v.dropStatements, referencedTables: v.referencedTables })),
    functions: Array.from(inv.functions.values()).map(f => ({ name: f.name, createStatements: f.createStatements, dropStatements: f.dropStatements, hasDynamicSql: f.hasDynamicSql })),
    procedures: Array.from(inv.procedures.values()).map(p => ({ name: p.name, createStatements: p.createStatements, dropStatements: p.dropStatements, hasDynamicSql: p.hasDynamicSql })),
    triggers: Array.from(inv.triggers.values()).map(tr => ({ name: tr.name, createStatements: tr.createStatements, dropStatements: tr.dropStatements, targetTable: tr.targetTable, timing: tr.timing, event: tr.event })),
    events: Array.from(inv.events.values()).map(e => ({ name: e.name, createStatements: e.createStatements, dropStatements: e.dropStatements })),
    findings: inv.findings,
    hasCycles: cycles.length > 0,
    cycles
  };
});

handle('db:preview-object-restore-plan', async payload => {
  if (activeDatabaseTransfer?.operation === 'backup-retention') throw new Error('Đang dọn backup. Hãy đợi hoàn tất.');
  const { profileId, database, id, taskId } = payload || {};
  if (!profileId || !database || !id || !taskId) throw new Error('Thiếu thông tin yêu cầu kế hoạch phục hồi.');
  const profile = store.getWithSecrets(profileId);
  const filePath = await resolveBackup(app.getPath('userData'), profileId, database, id);
  const stat = await fs.promises.lstat(filePath);
  if (!stat.isFile()) throw new Error('Tệp backup không hợp lệ.');

  const inv = new RestoreObjectInventory(database);
  const parser = new SqlScriptParser();
  const hash = crypto.createHash('sha256');

  const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
  let statementCount = 0;

  for await (const chunk of stream) {
    hash.update(chunk);
    for (const stmt of parser.push(chunk)) {
      statementCount++;
      inv.addStatement(stmt, statementCount);
    }
  }
  for (const stmt of parser.end()) {
    statementCount++;
    inv.addStatement(stmt, statementCount);
  }

  const checksum = hash.digest('hex');
  const targetId = targetIdentity(profile);

  const plan = inv.generateExecutionPlan({
    selection: payload.selection || {},
    fileChecksum: checksum,
    targetIdentity: targetId,
    targetFacts: payload.targetFacts || null,
    dropExisting: Boolean(payload.dropExisting)
  });

  return { plan, checksum };
});

handle('db:create-selective-restore-plan', async (payload) => {
  const contextGeneration = backupContextGeneration;
  if (activeDatabaseTransfer?.operation === 'backup-retention') throw new Error('Đang dọn backup. Hãy đợi hoàn tất.');
  const { profileId, database, id, selection, dropExisting } = payload || {};
  if (!profileId || !database || !id) throw new Error('Thiếu thông tin yêu cầu tạo kế hoạch phục hồi chọn lọc.');
  const filePath = await resolveBackup(app.getPath('userData'), profileId, database, id);
  if (contextGeneration !== backupContextGeneration) throw Object.assign(new Error('Context phục hồi đã thay đổi.'), { code: 'RESTORE_CONTEXT_CHANGED' });
  return restorePlanService.createSelectiveRestorePlan({
    filePath,
    targetProfileId: profileId,
    targetDatabase: database,
    selection,
    dropExisting
  });
});

handle('db:apply-selective-restore-plan', async (payload) => {
  if (!payload || typeof payload.planToken !== 'string') throw new Error('Thiếu planToken để thực thi phục hồi chọn lọc.');
  const transfer = claimDatabaseTransfer({
    taskId: payload.taskId,
    profileId: payload.profileId,
    operation: 'selective-restore',
    pending: true
  });
  try {
    return await restoreSelectionExecutor.executePlan({
      planToken: payload.planToken,
      approvalToken: payload.approvalToken,
      signal: transfer.cancelController?.signal,
      onSession: (session) => {
        transfer.session = session;
      },
      onProgress: (progress) => {
        sendDbProgress({ operation: 'selective-restore', taskId: payload.taskId, ...progress });
      }
    });
  } finally {
    if (activeDatabaseTransfer === transfer) activeDatabaseTransfer = null;
  }
});

handle('db:start-data-diff', async (payload) => {
  return dataDiffService.startDiff(payload);
});

handle('db:data-diff-status', async (payload) => {
  if (!payload || !payload.jobId) throw new Error('Thiếu jobId tác vụ so sánh.');
  return dataDiffService.getDiffStatus(payload.jobId);
});

handle('db:cancel-data-diff', async (payload) => {
  if (!payload || !payload.jobId) throw new Error('Thiếu jobId tác vụ so sánh.');
  return dataDiffService.cancelDiff(payload.jobId);
});

handle('db:create-data-sync-plan', async (payload) => {
  return dataSyncPlanService.createSyncPlanFromJob(payload);
});

handle('db:apply-data-sync-plan', async () => {
  throw Object.assign(new Error('Chức năng áp dụng đồng bộ dữ liệu (Data Sync Apply) đang khóa an toàn để hoàn thiện kiểm chứng.'), {
    code: 'SYNC_APPLY_NOT_READY'
  });
});

handle('db:inspect-backup-container', async (payload) => {
  const filePath = await resolveBackup(app.getPath('userData'), payload.profileId, payload.database, payload.id);
  return inspectBackupContainer(filePath);
});

handle('db:encrypt-backup', async (payload) => {
  const filePath = await resolveBackup(app.getPath('userData'), payload.profileId, payload.database, payload.id);
  const outPath = `${filePath}.enc`;
  const result = await encryptBackupFile(filePath, outPath, {
    passphrase: payload.passphrase,
    compress: payload.compress !== false
  });
  return { ...result, outPath };
});

handle('db:decrypt-backup', async (payload) => {
  const filePath = await resolveBackup(app.getPath('userData'), payload.profileId, payload.database, payload.id);
  const outPath = filePath.endsWith('.enc') ? filePath.slice(0, -4) : `${filePath}.dec.sql`;
  const result = await decryptBackupFile(filePath, outPath, {
    passphrase: payload.passphrase
  });
  return { ...result, outPath };
});

handle('db:create-backup-replica', async (payload) => {
  const filePath = await resolveBackup(app.getPath('userData'), payload.profileId, payload.database, payload.id);
  return backupReplicaManager.createReplica({
    sourceFilePath: filePath,
    destinationDir: payload.destinationDir,
    expectedFileChecksum: payload.expectedFileChecksum
  });
});

handle('db:verify-backup-replica', async (payload) => {
  return backupReplicaManager.verifyReplica({
    replicaPath: payload.replicaPath,
    expectedFileChecksum: payload.expectedFileChecksum
  });
});

function trialJournal() {
  return createTrialJournal({ directory: jsonPath('restore-trial-journal'), seal: store.seal, unseal: store.unseal });
}

handle('db:list-trial-recovery', (payload) => {
  const profile = store.getWithSecrets(payload?.profileId);
  return trialJournal().list(profile);
});

handle('db:cleanup-trial-recovery', async (payload) => {
  const profileId = checkConnectionPolicy(payload?.profileId);
  const profile = store.getWithSecrets(profileId);
  const journal = trialJournal();
  const record = journal.read(payload?.id);
  if (record.profileId !== profileId || record.target !== targetIdentity(profile)) throw new Error('Nhật ký không thuộc đích kết nối này.');
  const started = Date.now();
  const confirmation = await dialog.showMessageBox(mainWindow, {
    type: 'warning', title: 'Dọn database phục hồi thử', message: 'Kiểm tra và xóa database tạm còn sót?',
    detail: `Kết nối: ${profile.name || profileId}\nMáy chủ: ${profile.host}:${profile.port || 3306}\nDatabase: ${record.database}\nChỉ xóa khi marker sở hữu khớp với nhật ký đã mã hóa. Nếu marker thiếu hoặc sai, database được giữ lại để kiểm tra thủ công.`,
    buttons: ['Hủy', 'Kiểm tra và dọn'], defaultId: 0, cancelId: 0, noLink: true
  });
  if (confirmation.response !== 1) return { canceled: true };
  checkConnectionPolicy(profileId);
  if (Date.now() - started > 120000 || productionProfileFingerprint(store.getWithSecrets(profileId)) !== productionProfileFingerprint(profile)) throw new Error('Kết nối hoặc xác nhận đã thay đổi. Hãy thực hiện lại.');
  const transfer = claimDatabaseTransfer({ profileId, operation: 'trial-recovery', pending: true });
  let session;
  try {
    session = new DatabaseSession(runtimeProfile(profile)); transfer.session = session;
    await session.connect();
    if (transfer.canceled) throw new Error('Đã hủy dọn database thử.');
    checkConnectionPolicy(profileId);
    if (productionProfileFingerprint(store.getWithSecrets(profileId)) !== productionProfileFingerprint(profile)) throw new Error('Kết nối đã thay đổi trong khi mở phiên dọn database thử.');
    transfer.pending = false;
    const result = await cleanupTrialDatabase(session, record, profile);
    journal.remove(record.id);
    return result;
  } finally {
    try { await session?.close(); } finally { if (activeDatabaseTransfer === transfer) activeDatabaseTransfer = null; }
  }
});

handle('db:trial-backup',async(payload)=>{
  if(activeDatabaseTransfer)throw Object.assign(new Error('Một tác vụ database đang chạy. Hãy đợi hoàn tất.'),{code:'SESSION_BUSY'});
  if (!payload || typeof payload.database!=='string' || !payload.database) throw new Error('Chưa chọn database.');
  if(typeof payload.taskId!=='string' || !payload.taskId || payload.taskId.length>120)throw new Error('Thiếu mã tác vụ phục hồi thử.');
  const profileId=checkConnectionPolicy(payload.profileId);
  const filePath=await resolveBackup(app.getPath('userData'),profileId,payload.database,payload.id);
  const sourceBefore=await fs.promises.stat(filePath);
  const sourceIdentity=stats=>[stats.dev,stats.ino,stats.size,stats.mtimeMs,stats.ctimeMs].join(':');
  const confirmationStarted=Date.now();
  const profile=store.getWithSecrets(profileId);
  const confirmation=await dialog.showMessageBox(mainWindow,{
    type:'warning',title:'Phục hồi thử backup',message:'Tạo database tạm để kiểm tra backup?',
    detail:`Kết nối: ${profile.name || profileId}\nMáy chủ: ${profile.host}:${profile.port || 3306}\nBackup: ${payload.id}\nỨng dụng sẽ tạo database sqlpro_trial_* trên máy chủ này, kiểm tra và dọn sau khi hoàn tất. Bản đầu chỉ hỗ trợ bảng InnoDB và INSERT, giới hạn 512 MiB. Cần quyền CREATE/DROP DATABASE và đủ dung lượng trống. Nếu dọn thất bại, báo cáo ghi tên database cần kiểm tra.`,
    buttons:['Hủy','Phục hồi thử'],defaultId:0,cancelId:0,noLink:true
  });
  if (confirmation.response!==1)return {canceled:true};
  if(Date.now()-confirmationStarted>120000 || sourceIdentity(sourceBefore)!==sourceIdentity(await fs.promises.stat(filePath))) {
    throw Object.assign(new Error('Tệp đã thay đổi hoặc xác nhận quá 2 phút. Hãy thực hiện lại.'),{code:'PRODUCTION_CONTEXT_CHANGED'});
  }
  checkConnectionPolicy(profileId);
  if (productionProfileFingerprint(store.getWithSecrets(profileId))!==productionProfileFingerprint(profile))throw new Error('Kết nối đã thay đổi. Hãy thực hiện lại.');
  const taskId=typeof payload.taskId==='string'?payload.taskId:null;
  const transfer=claimDatabaseTransfer({taskId,profileId,operation:'restore-trial',pending:true});
  let session;
  try {
    session=new DatabaseSession(runtimeProfile(profile));transfer.session=session;
    await session.connect();
    checkConnectionPolicy(profileId);
    if (productionProfileFingerprint(store.getWithSecrets(profileId)) !== productionProfileFingerprint(profile)) throw new Error('Kết nối đã thay đổi trong khi mở phiên phục hồi thử.');
    const control=createTrialControl(session,taskId);
    transfer.trialControl=control;
    if(transfer.canceled)control.cancel();
    transfer.pending=false;
    const journal = trialJournal();
    const report=await runRestoreTrial({session,filePath,taskId,control,
      journal: { prepare: ownership => journal.prepare(profile, ownership), remove: id => journal.remove(id) },
      onProgress:progress=>sendDbProgress({...progress,taskId,profileId})});
    const reportPath=`${filePath}.trial.json`;
    const temporary=`${reportPath}.${crypto.randomBytes(8).toString('hex')}.part`;
    try {await fs.promises.writeFile(temporary,JSON.stringify(report,null,2),{flag:'wx',mode:0o600});await fs.promises.rename(temporary,reportPath);}
    catch(error){report.reportSaveError=error.message;}
    finally {await fs.promises.rm(temporary,{force:true}).catch(()=>{});}
    return {report};
  } finally {try {await session?.close();}finally {if(activeDatabaseTransfer===transfer)activeDatabaseTransfer=null;}}
});

handle('db:export-backup', async (payload) => {
  if (!payload || typeof payload.database !== 'string' || !payload.database) throw new Error('Chưa chọn database.');
  const current = await ensureSession(payload.profileId);
  const source = await resolveBackup(app.getPath('userData'), current.profileId, payload.database, payload.id);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Xuất tệp SQL sao lưu',
    defaultPath: `${payload.database.replace(/[<>:"/\\|?*]/g, '_').slice(0, 80)}-${payload.id}`,
    filters: [{ name: 'SQL', extensions: ['sql'] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  if (path.resolve(result.filePath) === path.resolve(source)) return { canceled: false, filePath: source };
  await withAnnotationLock(source, () => fs.promises.copyFile(source, result.filePath));
  return { canceled: false, filePath: result.filePath };
});

handle('db:show-backup-folder', async (payload) => {
  if (!payload || typeof payload.database !== 'string' || !payload.database) throw new Error('Chưa chọn database.');
  const current = await ensureSession(payload.profileId);
  const directory = backupDirectory(app.getPath('userData'), current.profileId, payload.database);
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  if (payload.id) {
    const filePath = await resolveBackup(app.getPath('userData'), current.profileId, payload.database, payload.id);
    shell.showItemInFolder(filePath);
  } else {
    const error = await shell.openPath(directory);
    if (error) throw new Error(error);
  }
  return { opened: true };
});

handle('db:restore', async (payload) => {
  if (activeDatabaseTransfer) throw new Error('Một tác vụ database đang chạy. Hãy đợi tác vụ hoàn tất.');
  if (!payload || typeof payload !== 'object') throw new Error('Tham số không hợp lệ.');
  if (typeof payload.database !== 'string' || !payload.database) throw new Error('Chưa chọn database đích để phục hồi.');
  const taskId = typeof payload.taskId === 'string' && payload.taskId ? payload.taskId : null;
  const targetProfileId = resolveProfileId(payload.targetProfileId || payload.profileId);
  checkConnectionPolicy(targetProfileId);
  const sourceProfileId = payload.sourceProfileId || targetProfileId;
  const sourceDatabase = payload.sourceDatabase || payload.database;
  const savedFile = payload.backupId
    ? await resolveBackup(app.getPath('userData'), sourceProfileId, sourceDatabase, payload.backupId)
    : null;
  const result = savedFile ? null : await dialog.showOpenDialog(mainWindow, {
    title: 'Phục hồi database từ tệp SQL',
    properties: ['openFile'],
    filters: [
      { name: 'SQL', extensions: ['sql'] },
      { name: 'Tất cả tệp', extensions: ['*'] }
    ]
  });
  if (result && (result.canceled || !result.filePaths.length)) return { canceled: true };
  const filePath = savedFile || result.filePaths[0];
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error('Đường dẫn phục hồi không phải là tệp.');
  if (!await confirmProductionTransfer(targetProfileId,payload.database,filePath,'restore',
    `Xóa đối tượng hiện có: ${payload.dropExisting === true ? 'Có' : 'Không'}\nTạo database nếu chưa có: ${payload.createDatabaseIfNotExists === true ? 'Có' : 'Không'}\nPhạm vi và xung đột tiếp tục được kiểm tra bằng preflight trước khi ghi.`)) return {canceled:true,filePath};
  const transfer = claimDatabaseTransfer({ taskId, profileId: targetProfileId, operation: 'restore', pending: true });
  let session;
  try {
    checkConnectionPolicy(targetProfileId);
    session = new DatabaseSession(runtimeProfile(store.getWithSecrets(targetProfileId)));
    transfer.session = session;
    await session.connect();
    if (transfer.canceled) return { canceled: true, filePath };
    if (typeof session.prepareWorkerForRestore === 'function') await session.prepareWorkerForRestore();
    checkConnectionPolicy(targetProfileId);
    transfer.pending = false;
    const stats = await session.restoreDatabase({
      database: payload.database,
      filePath,
      dropExisting: payload.dropExisting === true,
      createDatabaseIfNotExists: payload.createDatabaseIfNotExists === true,
      taskId
    }, (progress) => sendDbProgress({
      ...progress,
      taskId,
      profileId: targetProfileId,
      database: payload.database
    }));
    let copiedBackup = null;
    if (payload.backupId && payload.copyToTargetCatalog && (sourceDatabase !== payload.database || sourceProfileId !== targetProfileId)) {
      try {
        copiedBackup = await copyBackup(app.getPath('userData'), sourceProfileId, targetProfileId, sourceDatabase, payload.database, payload.backupId);
      } catch {
        // non-fatal
      }
    }
    return { canceled: false, filePath, copiedBackup, ...stats };
  } catch (error) {
    if (error && error.code === 'RESTORE_CANCELED') {
      return { canceled: true, filePath, ...(error.partial || {}) };
    }
    throw error;
  } finally {
    try { await session?.close(); }
    finally { if (activeDatabaseTransfer === transfer) activeDatabaseTransfer = null; }
  }
});

handle('db:copy-backup', async (payload) => {
  if (!payload || typeof payload !== 'object') throw new Error('Tham số không hợp lệ.');
  if (typeof payload.sourceDatabase !== 'string' || !payload.sourceDatabase) throw new Error('Chưa chọn database nguồn.');
  if (typeof payload.targetDatabase !== 'string' || !payload.targetDatabase) throw new Error('Chưa chọn database đích.');
  if (typeof payload.id !== 'string' || !payload.id) throw new Error('Chưa chọn bản sao lưu.');
  const current = await ensureSession(payload.profileId || payload.sourceProfileId);
  const sourceProfileId = payload.sourceProfileId || current.profileId;
  const targetProfileId = payload.targetProfileId || payload.profileId || current.profileId;
  return copyBackup(app.getPath('userData'), sourceProfileId, targetProfileId, payload.sourceDatabase, payload.targetDatabase, payload.id);
});

app.whenReady().then(() => {
  buildMenu();
  sync.init({ notify: syncNotifier() });
  createWindow();
  schedulerReady = true;
  const { scheduler } = backupSchedules();
  try { scheduler.recover(); scheduler.start(); }
  catch (error) { scheduler.error = error.message; scheduler.stop(); }
  sync.startup().catch(() => undefined);
});

app.on('before-quit', (event) => {
  if (!isQuitting && activeDatabaseTransfer && !confirmStopActiveTransfer()) {
    event.preventDefault();
    return;
  }
  if (!isQuitting && !activeDatabaseTransfer && activeTransactions().length && !confirmActiveTransactions('thoát')) {
    event.preventDefault();
    return;
  }
  isQuitting = true;
  stopBackupSchedules();
  sync.shutdown();
  sessionRegistry.closeAll().catch(() => undefined);
  activeSession = null;
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && !isQuitting) createWindow();
});
