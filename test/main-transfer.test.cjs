'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

function setup({ sync = {}, reset = () => ({ backupName: 'fixture-backup.json' }), readOnlyProfiles = [], productionProfiles = [], removedProfiles = [], profiles = {}, scheduleHarness, inspection, trialRecovery, backupCatalog = {}, retentionStore, retentionApply, retentionExport, retentionAuto, onConnect, onRaw, timers, retentionHistory = { read: () => [], begin: () => 'history-fixture', finish() {} } } = {}) {
  const handlers = new Map(), sessions = [];
  let chooseFile = async () => ({ filePath: '/review/export.json' });
  let chooseOpen = async () => ({ canceled: true, filePaths: [] });
  let reviewProduction = async () => ({response:0});
  let finish;
  let savedBackupOptions;
  class Session {
    constructor(profile) { this.profile = profile; this.canceled = []; sessions.push(this); }
    async connect() { this.connection = {}; onConnect?.(this); }
    async raw(sql, params, timeout) { return onRaw ? onRaw(sql, params, timeout, this) : { rows: [] }; }
    async close() { this.dead = true; }
    async listDatabases() { return ['demo']; }
    async listTables() { return [{ name: 'items' }, { name: 'item_view' }]; }
    async listRoutines() { return [{ name: 'count_items', type: 'function' }]; }
    async listEvents() { return [{ name: 'refresh_items' }]; }
    async useDatabase() {}
    async previewRowWrite(operation,payload) {return {sql:`UPDATE \`items\` SET \`name\`=? WHERE \`id\`=?`,params:[payload.values?.name,payload.keys?.id],columns:this.columns || [{name:'id',type:'int'}]};}
    backupDatabase(options) { this.backupOptions = options; return this.run(options.taskId, 'BACKUP_CANCELED'); }
    exportQueryFile(options) { return this.run(options.taskId, 'EXPORT_CANCELED'); }
    prepareWorkerForImport() { this.prepared = 'import'; }
    prepareWorkerForRestore() { this.prepared = 'restore'; }
    importFile(options) { return this.run(options.taskId, 'IMPORT_CANCELED'); }
    restoreDatabase(options) { return this.run(options.taskId, 'RESTORE_CANCELED'); }
    run(taskId, code) {
      this.activeTask = { id: taskId };
      return new Promise((resolve, reject) => { finish = resolve; this.reject = () => reject(Object.assign(new Error('Canceled'), { code })); });
    }
    cancelTask(taskId) {
      if (this.activeTask?.id !== taskId) return false;
      this.canceled.push(taskId); this.reject(); return true;
    }
  }
  const app = { requestSingleInstanceLock: () => true, on() {}, whenReady: () => new Promise(() => {}), getPath: () => '/review', getVersion: () => 'test-version' };
  const electron = {
    app,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    dialog: { showSaveDialog: (...args) => chooseFile(...args), showOpenDialog: (...args) => chooseOpen(...args),showMessageBox:(...args)=>reviewProduction(...args) }
  };
  const root = path.join(__dirname, '../electron');
  vm.runInNewContext(fs.readFileSync(path.join(root, 'main.cjs'), 'utf8'), {
    require(id) {
      if (id === 'electron') return electron;
      if (id === './database.cjs') return {
        DatabaseSession: Session,
        normalizeFileFormat: (format) => (['csv', 'tsv', 'json'].includes(format) ? format : 'csv')
      };
      if (id === './store.cjs') return { getWithSecrets: (id) => {
        if (removedProfiles.includes(id)) throw new Error('Không tìm thấy kết nối.');
        return { id, ssh: {}, readOnly: readOnlyProfiles.includes(id), environment:productionProfiles.includes(id)?'production':'local', ...profiles[id] };
      }, resetLocalData: reset };
      if (id === './backup-scheduler.cjs' && scheduleHarness) {
        const scheduler = require(path.join(root, id));
        return { ...scheduler, createScheduleStore: () => scheduleHarness.repository, BackupScheduler: class {
          constructor(options) { scheduleHarness.engine = new scheduler.BackupScheduler({ ...options, now: scheduleHarness.now }); return scheduleHarness.engine; }
        } };
      }
      if (id === './restore-trial-journal.cjs' && trialRecovery) return {
        ...require(path.join(root, id)), createTrialJournal: () => trialRecovery.journal,
        cleanupTrialDatabase: trialRecovery.cleanup
      };
      if (id === './sync.cjs') return sync;
      if (id === './navicat.cjs') return {};
      if (id === './backup-file.cjs') return { fileIdentity: require(path.join(root, id)).fileIdentity, saveBackupFile: (_file, run, options) => { savedBackupOptions = options; return run(async () => {}); } };
      if (id === './backup-catalog.cjs') return { backupDirectory: () => '/review/backups', backupName: () => 'test.sql', ...backupCatalog };
      if (id === './backup-retention-store.cjs' && retentionStore) return { createRetentionStore: () => retentionStore };
      if (id === './backup-retention-apply.cjs' && retentionApply) return { BackupRetentionApply: class { constructor() { return retentionApply; } } };
      if (id === './backup-retention-history.cjs') return { createRetentionHistory: () => retentionHistory };
      if (id === './backup-retention-export.cjs' && retentionExport) return { exportRetentionHistory: retentionExport };
      if (id === './backup-retention-auto.cjs' && retentionAuto) return { runAutomaticRetention: retentionAuto };
      if (id === './backup-inspection.cjs' && inspection) return { BackupInspection: class { constructor() { return inspection; } } };
      if (id === 'node:fs') return { ...fs, mkdirSync() {}, writeFileSync() {}, renameSync() {}, promises: { ...fs.promises, mkdir: async () => {} } };
      return require(id.startsWith('./') ? path.join(root, id) : id);
    }, __dirname: root, process, Buffer, console, setTimeout: timers?.setTimeout || setTimeout, clearTimeout: timers?.clearTimeout || clearTimeout, AbortController
  });
  return {
    call: (name, payload, options) => handlers.get(name)({ sender: null }, payload, options),
    sessions,
    backupOptions: () => savedBackupOptions,
    dialog: (callback) => { chooseFile = callback; },
    openDialog: (callback) => { chooseOpen = callback; },
    productionDialog:(callback)=>{reviewProduction=callback;},
    finish: (value) => finish(value)
  };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test('a pending row write excludes SQL and database switches on that session while other profiles remain available', async () => {
  const r = setup();
  await r.call('db:connect', 'p1'); await r.call('db:connect', 'p2');
  const [first, other] = r.sessions;
  let finish, writes = 0, uses = 0;
  first.deleteRows = () => new Promise(resolve => { finish = resolve; });
  first.runQueryScript = async () => { writes++; return {}; };
  first.useDatabase = async () => { uses++; };
  const pending = r.call('db:delete-rows', { profileId: 'p1', database: 'demo', table: 'items', keysList: [{ id: 1 }] });
  await waitFor(() => typeof finish === 'function');
  assert.equal((await r.call('db:query', { profileId: 'p1', sql: 'COMMIT', confirmed: true })).error?.code, 'SESSION_BUSY');
  assert.equal((await r.call('db:use-database', { profileId: 'p1', database: 'other' })).error?.code, 'SESSION_BUSY');
  assert.equal(writes, 0); assert.equal(uses, 0);
  other.runQueryScript = async () => ({ kind: 'ok' });
  assert.equal((await r.call('db:query', { profileId: 'p2', sql: 'SELECT 1' })).ok, true);
  finish({ affectedRows: 1 }); assert.equal((await pending).ok, true);
  assert.equal((await r.call('db:query', { profileId: 'p1', sql: 'SELECT 1' })).ok, true);
});

test('query database binding is exclusive before the SQL task starts, and errors release the gate', async () => {
  const r = setup(); await r.call('db:connect', 'p1');
  const session = r.sessions[0]; let finish;
  session.useDatabase = database => new Promise(resolve => { finish = () => { session.database = database; resolve(); }; });
  session.runQueryScript = async () => { throw new Error('expected SQL failure'); };
  const first = r.call('db:query', { profileId: 'p1', database: 'first', sql: 'SELECT 1' });
  await waitFor(() => typeof finish === 'function');
  assert.equal((await r.call('db:query', { profileId: 'p1', database: 'second', sql: 'SELECT 2' })).error?.code, 'SESSION_BUSY');
  finish(); assert.equal((await first).ok, false); assert.equal(session.database, 'first');
  session.runQueryScript = async () => ({ kind: 'ok' });
  assert.equal((await r.call('db:query', { profileId: 'p1', sql: 'SELECT 3' })).ok, true);
});

test('a synced endpoint change blocks cached-session writes and COMMIT while preserving explicit rollback', async () => {
  const profiles = { p1: { host: 'original.example' } };
  const r = setup({ profiles }); await r.call('db:connect', 'p1');
  const session = r.sessions[0]; let commands = 0;
  session.inTransaction = true;
  session.runQueryScript = async () => { commands++; session.inTransaction = false; return {}; };
  const state = (await r.call('db:session-state', 'p1')).data;
  profiles.p1.host = 'changed.example';
  assert.equal((await r.call('db:query', { profileId: 'p1', sql: 'UPDATE items SET n=1', confirmed: true })).error?.code, 'PROFILE_TARGET_CHANGED');
  assert.equal((await r.call('db:transaction', { ...state, action: 'commit' })).error?.code, 'PROFILE_TARGET_CHANGED');
  assert.equal(commands, 0); assert.equal(session.dead, undefined); assert.equal(session.inTransaction, true);
  assert.equal((await r.call('db:transaction', { ...state, action: 'rollback' })).ok, true);
  assert.equal(commands, 1);
});

test('endpoint drift during connect closes the new socket; cosmetic/policy sync changes keep the target session', async () => {
  const changed = { p1: { host: 'first.example' } };
  const stale = setup({ profiles: changed, onConnect: () => { changed.p1.host = 'second.example'; } });
  assert.equal((await stale.call('db:connect', 'p1')).error?.code, 'PROFILE_TARGET_CHANGED');
  assert.equal(stale.sessions[0].dead, true);
  const profiles = { p1: { host: 'same.example', name: 'Old' } };
  const r = setup({ profiles }); await r.call('db:connect', 'p1');
  r.sessions[0].runQueryScript = async () => ({ kind: 'rows' });
  Object.assign(profiles.p1, { name: 'New', environment: 'production', readOnly: true, updatedAt: 'new-time' });
  assert.equal((await r.call('db:query', { profileId: 'p1', sql: 'SELECT 1' })).ok, true);
  assert.equal((await r.call('db:query', { profileId: 'p1', sql: 'DELETE FROM items' })).error?.code, 'CONNECTION_READ_ONLY');
  assert.equal(r.sessions.length, 1);
});

test('explicit rollback still uses the observed session when sync removed its stored profile', async () => {
  const removedProfiles = [];
  const r = setup({ removedProfiles }); await r.call('db:connect', 'p1');
  const session = r.sessions[0], commands = [];
  session.inTransaction = true;
  session.runQueryScript = async sql => { commands.push(sql); session.inTransaction = false; };
  const state = (await r.call('db:session-state', 'p1')).data;
  removedProfiles.push('p1');
  assert.equal((await r.call('db:transaction', { ...state, action: 'commit' })).ok, false);
  assert.equal((await r.call('db:transaction', { ...state, action: 'rollback' })).ok, true);
  assert.deepEqual(commands, ['ROLLBACK']);
  assert.equal(r.sessions.length, 1);
});

test('selected-table preview derives scope from main inventory, never connects or executes restore', async () => {
  const requests = [];
  const data = { version: 1, database: 'demo', tables: [{ name: 't', createStatements: 1, dataStatements: 2, dropStatements: 0, dependencies: [] }], findings: [], opaqueObjects: [], truncated: false };
  const r = setup({ readOnlyProfiles: ['p1'], inspection: { inspect: async request => { requests.push(request); return { selectionPreview: data, checksum: 'a'.repeat(64), cached: true }; } },
    backupCatalog: { resolveBackup: async (_root, profileId, database, id) => {
      assert.equal(profileId, 'p1'); assert.equal(database, 'demo'); assert.equal(id, 'fixture'); return '/review/fixture.sql';
    } } });
  const result = (await r.call('db:preview-backup-selection', { profileId: 'p1', database: 'demo', id: 'fixture', taskId: 'selection-test', tables: ['t'], canExecute: true, inventory: 'forged' })).data;
  assert.equal(result.canExecute, false); assert.equal(result.targetReviewed, false);
  assert.equal(result.totals.dataStatements, 2); assert.equal(result.checksum, 'a'.repeat(64));
  assert.equal(requests[0].taskId, 'selection-test'); assert.equal(r.sessions.length, 0);
  assert.equal((await r.call('db:preview-backup-selection', { profileId: 'p1', database: 'demo', id: 'fixture', taskId: 'selection-test', tables: ['forged'] })).ok, false);
});

test('selected-table preview rejects late results after logout', async () => {
  let finish;
  const r = setup({ sync: { logout() {} }, inspection: { inspect: () => new Promise(resolve => { finish = resolve; }) },
    backupCatalog: { resolveBackup: async () => '/review/fixture.sql' } });
  const pending = r.call('db:preview-backup-selection', { profileId: 'p1', database: 'demo', id: 'fixture', taskId: 'selection-late', tables: ['t'] });
  await tick(); await r.call('account:logout'); finish({});
  assert.equal((await pending).ok, false); assert.equal(r.sessions.length, 0);
});

test('initial inspection rejects late results after logout and invalidates local scan evidence', async () => {
  let finish, invalidated = 0;
  const r = setup({ backupCatalog: { resolveBackup: async () => '/fixture' }, sync: { logout() {} },
    inspection: { inspect: () => new Promise(resolve => { finish = resolve; }), invalidate: () => { invalidated++; } } });
  const pending = r.call('db:inspect-backup', { profileId: 'p1', database: 'demo', id: 'fixture', taskId: 'initial-late' });
  await waitFor(() => typeof finish === 'function');
  await r.call('account:logout'); finish({ selectionPreview: { private: 'old-account' } });
  const result = await pending;
  assert.equal(result.ok, false); assert.match(result.error.message, /Phiên ứng dụng đã thay đổi/);
  assert.equal(invalidated, 1); assert.equal(r.sessions.length, 0);
});

function targetFixture(t, { scanDelayMs = 0, ...overrides } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-target-preview-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'backup.sql'); fs.writeFileSync(filePath, 'source backup fixture');
  const inspected = { selectionPreview: { version: 1, database: 'demo', tables: [{ name: 'items', createStatements: 1, dataStatements: 1, dropStatements: 0, dependencies: [] }], findings: [], opaqueObjects: [], truncated: false }, checksum: 'a'.repeat(64), cached: false };
  const request = { profileId: 'p1', database: 'demo', id: 'fixture', taskId: 'target-fixture', tables: ['items'], targetDatabase: 'destination' };
  const calls = [];
  const r = setup({ readOnlyProfiles: ['p1'], backupCatalog: { resolveBackup: async () => filePath },
    inspection: { inspect: async payload => {
      assert.equal(payload.fresh, true);
      if (scanDelayMs) await new Promise(resolve => setTimeout(resolve, scanDelayMs));
      return inspected;
    }, cancel: () => ({ canceled: true }) },
    onRaw: async (sql, params) => {
      calls.push({ sql, params }); assert.match(sql, /^SELECT /);
      if (sql.includes('VERSION()')) return { rows: [{ version: '8.4', lowerCaseTableNames: 0 }] };
      if (sql.includes('AS foreignKeyChecks')) return { rows: [{ foreignKeyChecks: 1, autocommit: 1, sqlMode: 'STRICT_TRANS_TABLES', charsetClient: 'utf8mb4', charsetConnection: 'utf8mb4', charsetResults: 'utf8mb4', maxAllowedPacket: 67108864 }] };
    if (sql.includes('SCHEMATA')) return { rows: [{ name: 'destination' }] };
      return { rows: [] };
    }, ...overrides });
  return { ...r, request, filePath, calls };
}

test('target metadata preview reserves its own slot, performs only reads and always closes the independent session', async t => {
  const r = targetFixture(t);
  const result = await r.call('db:preview-backup-selection-target', { ...r.request, targetIdentity: 'forged', checksum: 'forged', draftPlan: { canExecute: true, planId: 'forged' } });
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.data.canExecute, false); assert.equal(result.data.targetReview.canExecute, false);
  assert.equal(result.data.draftPlan.canExecute, false); assert.equal(result.data.draftPlan.status, 'blocked');
  assert.equal(result.data.draftPlan.checksum, 'a'.repeat(64));
  assert.equal(result.data.draftPlan.targetSnapshotId, result.data.targetReview.snapshotId);
  assert.ok(result.data.draftPlan.blockers.some(item => item.code === 'STATEMENT_LEDGER_INCOMPLETE'));
  assert.equal(result.data.checksum, 'a'.repeat(64)); assert.match(result.data.targetReview.snapshotId, /^[a-f0-9]{64}$/);
  assert.equal(result.data.targetReview.database, 'destination'); assert.equal(r.calls.length, 9);
  assert.equal(r.sessions.length, 1); assert.equal(r.sessions[0].dead, true);
  assert.equal((await r.call('db:preview-backup-selection-target', { ...r.request, targetDatabase: '' })).ok, false);
  assert.equal(r.sessions.length, 1);
});

test('conflict policy is validated before I/O, captured before await and never trusts a renderer policy report', async t => {
  const r = targetFixture(t, { scanDelayMs: 5, onRaw: async sql => {
    assert.match(sql, /^SELECT /);
    if (sql.includes('VERSION()')) return { rows: [{ version: '8.4', lowerCaseTableNames: 0 }] };
    if (sql.includes('AS foreignKeyChecks')) return { rows: [{ foreignKeyChecks: 1, autocommit: 1, sqlMode: 'STRICT_TRANS_TABLES', charsetClient: 'utf8mb4', charsetConnection: 'utf8mb4', charsetResults: 'utf8mb4', maxAllowedPacket: 67108864 }] };
    if (sql.includes('SCHEMATA')) return { rows: [{ name: 'destination' }] };
    if (sql.includes('information_schema.TABLES')) return { rows: [{ name: 'items', type: 'BASE TABLE' }] };
    return { rows: [] };
  } });
  for (const conflictPolicy of ['replace', {}, true, null]) {
    const result = await r.call('db:preview-backup-selection-target', { ...r.request, conflictPolicy });
    assert.equal(result.error?.code, 'INVALID_RESTORE_CONFLICT_POLICY');
  }
  assert.equal(r.sessions.length, 0);
  const request = { ...r.request, conflictPolicy: 'skip-existing', conflictPolicyReview: { canExecute: true, rows: [] } };
  const pending = r.call('db:preview-backup-selection-target', request); request.conflictPolicy = 'replace';
  const result = await pending;
  assert.equal(result.ok, true, result.error?.message);
  const review = result.data.draftPlan.conflictPolicyReview;
  assert.equal(review.policy, 'skip-existing'); assert.equal(review.canExecute, false);
  assert.equal(review.rows[0].disposition, 'skip'); assert.equal(result.data.draftPlan.canExecute, false);
  assert.equal(r.sessions.length, 1); assert.equal(r.sessions[0].dead, true);
});

test('target metadata cancellation is task scoped and prevents publication or overlapping backup', async t => {
  let finish;
  const r = targetFixture(t, { scanDelayMs: 25, onRaw: () => new Promise(resolve => { finish = resolve; }) });
  const pending = r.call('db:preview-backup-selection-target', r.request); await waitFor(() => typeof finish === 'function');
  assert.equal((await r.call('db:backup', { profileId: 'p1', database: 'demo' })).ok, false);
  assert.equal((await r.call('db:cancel-task', { profileId: 'other', taskId: r.request.taskId })).data.canceled, false);
  assert.equal((await r.call('db:cancel-task', { profileId: 'p1', taskId: r.request.taskId })).data.canceled, true);
  finish({ rows: [] }); const result = await pending;
  assert.equal(result.ok, false); assert.equal(result.error.code, 'SELECTION_PREVIEW_CANCELED');
  assert.equal(r.sessions[0].dead, true);
});

test('target preview rejects profile drift, file changes and logout without publishing stale observations', async t => {
  const profiles = { p1: { host: 'original' } };
  const drift = targetFixture(t, { profiles, onConnect: () => { profiles.p1.host = 'changed'; } });
  assert.equal((await drift.call('db:preview-backup-selection-target', drift.request)).ok, false);
  assert.equal(drift.calls.length, 0); assert.equal(drift.sessions[0].dead, true);
  let changed;
  const file = targetFixture(t, { onRaw: async () => { if (!changed) { changed = true; fs.appendFileSync(file.filePath, 'change'); } return { rows: [] }; } });
  const result = await file.call('db:preview-backup-selection-target', file.request);
  assert.equal(result.ok, false); assert.match(result.error.message, /backup đã thay đổi/);
  assert.equal(file.sessions[0].dead, true);
  let finish;
  const loggedOut = targetFixture(t, { sync: { logout() {} }, onRaw: () => new Promise(resolve => { finish = resolve; }) });
  const pending = loggedOut.call('db:preview-backup-selection-target', loggedOut.request); await waitFor(() => typeof finish === 'function');
  await loggedOut.call('account:logout'); finish({ rows: [] });
  assert.equal((await pending).ok, false); assert.equal(loggedOut.sessions[0].dead, true);
});

test('target metadata deadline aborts its session and reports a timeout without waiting 60 seconds', async t => {
  let deadline, finish, cleared = false;
  const r = targetFixture(t, { onRaw: () => new Promise(resolve => { finish = resolve; }), timers: {
    setTimeout: (callback, delay) => { assert.equal(delay, 60000); deadline = callback; return 1; },
    clearTimeout: () => { cleared = true; }
  } });
  const pending = r.call('db:preview-backup-selection-target', r.request); await waitFor(() => typeof finish === 'function');
  deadline(); finish({ rows: [] });
  const result = await pending;
  assert.equal(result.ok, false); assert.equal(result.error.code, 'SELECTION_PREVIEW_TIMEOUT');
  assert.equal(r.sessions[0].dead, true); assert.equal(cleared, true);
});

test('main publishes catalog backups exclusively and derives target identity from trusted profile', async () => {
  const profile = { id: 'p1', host: 'trusted-host', ssh: {}, readOnly: false, environment: 'local' };
  const r = setup({ profiles: { p1: { host: profile.host } } });
  const pending = r.call('db:backup', { profileId: 'p1', database: 'demo', taskId: 'review-exclusive', exclusive: false, source: { target: 'forged' } });
  await tick();
  assert.equal(r.backupOptions().exclusive, true);
  assert.equal(r.backupOptions().source.target, require('../electron/restore-trial-journal.cjs').targetIdentity(profile));
  r.finish({ bytes: 9 }); assert.equal((await pending).data.canceled, false);
});

test('logout invalidates pending retention enable, delete confirmation and history export', async () => {
  let saves = 0, applies = 0, exports = 0;
  const r = setup({ sync: { logout() {} },
    retentionStore: { read: () => ({ policy: null, automaticAfterBackup: false }), save: () => { saves++; } },
    retentionApply: { consume: () => ({ database: 'demo', plan: { removeBytes: 1, policy: { maxCount: 1 }, rows: [{ id: '20260101000000-aaaaaaaa.sql', action: 'remove' }] } }), apply: async () => { applies++; } },
    retentionExport: async () => { exports++; }
  });
  r.productionDialog(async () => { await r.call('account:logout'); return { response: 1 }; });
  assert.equal((await r.call('db:save-backup-retention-policy', { profileId: 'p1', database: 'demo', policy: { maxCount: 1 }, automaticAfterBackup: true })).ok, false);
  assert.equal((await r.call('db:apply-backup-retention', { profileId: 'p1', database: 'demo', taskId: 'review-confirm', token: 'token' })).ok, false);
  r.dialog(async () => { await r.call('account:logout'); return { filePath: '/outside/report.json' }; });
  assert.equal((await r.call('db:export-backup-retention-history', { profileId: 'p1', database: 'demo' })).ok, false);
  assert.equal(saves + applies + exports, 0);
});

test('logout aborts active manual retention and prevents auto deletion after a manual backup finishes', async () => {
  let finishApply, captured;
  const r = setup({ sync: { logout() {} }, retentionApply: {
    consume: () => ({ database: 'demo', plan: { removeBytes: 1, policy: { maxCount: 1 }, rows: [{ id: '20260101000000-aaaaaaaa.sql', action: 'remove' }] } }),
    apply: async (_entry, options) => { captured = options; return new Promise(resolve => { finishApply = resolve; }); }
  } });
  r.productionDialog(async () => ({ response: 1 }));
  const pending = r.call('db:apply-backup-retention', { profileId: 'p1', database: 'demo', taskId: 'review-logout', token: 'token' });
  await tick(); await r.call('account:logout');
  assert.equal(captured.isCanceled(), true); assert.equal(captured.signal.aborted, true);
  finishApply({ stopped: true, deleted: [], remaining: [], failed: [], reclaimedBytes: 0 }); await pending;
  const s = setup({ sync: { logout() {} }, retentionStore: { read: () => ({ policy: { maxCount: 1 }, automaticAfterBackup: true }) },
    retentionAuto: async options => { assert.equal(options.isCanceled(), true); return { status: 'stopped' }; }
  });
  const backup = s.call('db:backup', { profileId: 'p1', database: 'demo', taskId: 'review-auto-logout' });
  await tick(); await s.call('account:logout'); s.finish({ bytes: 9 });
  const result = (await backup).data;
  assert.equal(result.canceled, false); assert.equal(result.retention.status, 'stopped');
});

test('manual retention checks connection drift during apply instead of deleting further backups', async () => {
  const profiles = { p1: { host: 'original' } };
  const r = setup({ profiles, retentionApply: {
    consume: () => ({ database: 'demo', plan: { removeBytes: 1, policy: { maxCount: 1 }, rows: [{ id: '20260101000000-aaaaaaaa.sql', action: 'remove' }] } }),
    apply: async (_entry, options) => {
      options.checkContext(); profiles.p1.host = 'changed';
      assert.throws(() => options.checkContext(), { code: 'BACKUP_RETENTION_CHANGED' });
      return { stopped: false, deleted: [], remaining: [], failed: [], reclaimedBytes: 0 };
    }
  } });
  r.productionDialog(async () => ({ response: 1 }));
  assert.equal((await r.call('db:apply-backup-retention', { profileId: 'p1', database: 'demo', taskId: 'review-drift', token: 'token' })).ok, true);
});

function scheduleFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-main-scheduler-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.now() + 3600000;
  const harness = { repository: require('../electron/backup-scheduler.cjs').createScheduleStore(root), now: () => now };
  const payload = { profileId: 'p1', database: 'demo', intervalHours: 24, nextRunAt: new Date(now).toISOString(), timeZone: 'Asia/Bangkok' };
  return { harness, payload };
}

test('schedule IPC requires native consent, ignores forged scope identity and refuses drift after dialog', async t => {
  const { harness, payload } = scheduleFixture(t);
  const profiles = { p1: { host: 'original' } };
  const r = setup({ scheduleHarness: harness, profiles });
  r.productionDialog(async (_window, options) => {
    assert.equal(options.defaultId, 0); assert.match(options.detail, /không chạy bù/); return { response: 0 };
  });
  assert.equal((await r.call('db:save-backup-schedule', payload)).data.canceled, true);
  assert.equal(harness.repository.read().length, 0);
  r.productionDialog(async () => ({ response: 1 }));
  const result = (await r.call('db:save-backup-schedule', { ...payload, target: 'forged', enabled: false })).data;
  assert.equal(result.schedule.enabled, true); assert.equal(result.schedule.target, undefined);
  assert.equal(result.schedule.targetMatches, true); assert.equal(r.sessions.length, 0);
  assert.equal((await r.call('db:get-backup-schedule', payload)).data.schedule.intervalHours, 24);
  r.productionDialog(async () => { profiles.p1.host = 'changed'; return { response: 1 }; });
  assert.equal((await r.call('db:save-backup-schedule', payload)).ok, false);
  assert.equal((await r.call('db:get-backup-schedule', payload)).data.schedule.targetMatches, false);
});

test('logout invalidates pending schedule consent, reset disables persisted schedules', async t => {
  const { harness, payload } = scheduleFixture(t);
  const r = setup({ scheduleHarness: harness, sync: { logout() {} } });
  r.productionDialog(async () => ({ response: 1 }));
  await r.call('db:save-backup-schedule', payload);
  r.productionDialog(async () => { await r.call('account:logout'); return { response: 1 }; });
  assert.equal((await r.call('db:save-backup-schedule', payload)).ok, false);
  assert.equal((await r.call('db:get-backup-schedule', payload)).data.paused, true);
  await r.call('account:reset-local');
  assert.equal(harness.repository.read()[0].enabled, false);
});

test('scheduled backup uses independent full metadata session and can be paused without deleting backups', async t => {
  const { harness, payload } = scheduleFixture(t);
  const r = setup({ scheduleHarness: harness, backupCatalog: { backupName: () => '20261112130000-abcdef01.sql' } });
  r.productionDialog(async () => ({ response: 1 }));
  await r.call('db:save-backup-schedule', payload);
  const pending = harness.engine.tick(); await tick();
  assert.equal(r.sessions.length, 1);
  const options = r.sessions[0].backupOptions;
  assert.equal(options.tables.join(','), 'items,item_view');
  assert.equal(options.routines.join(','), 'function:count_items');
  assert.equal(options.events.join(','), 'refresh_items');
  assert.equal(options.includeStructure, true); assert.equal(options.includeData, true);
  assert.equal((await r.call('db:save-backup-schedule', payload)).ok, false);
  assert.equal((await r.call('db:delete-backup-schedule', payload)).ok, false);
  assert.equal((await r.call('db:pause-backup-schedule', payload)).data.paused, true);
  await pending;
  assert.equal(harness.repository.read()[0].lastRun.status, 'canceled');
  assert.equal(harness.repository.read()[0].enabled, false);
  assert.equal(r.sessions[0].dead, true);
  assert.equal((await r.call('db:delete-backup-schedule', payload)).data.deleted, true);
  assert.equal(harness.repository.read().length, 0);
});

test('scheduled backup records success; changed target fails before opening any session', async t => {
  const { harness, payload } = scheduleFixture(t);
  const profiles = { p1: { host: 'original' } };
  const r = setup({ scheduleHarness: harness, profiles, backupCatalog: { backupName: () => '20261112130000-abcdef01.sql' } });
  r.productionDialog(async () => ({ response: 1 }));
  await r.call('db:save-backup-schedule', payload);
  const pending = harness.engine.tick(); await tick(); r.finish({ bytes: 9 }); await pending;
  assert.equal(harness.repository.read()[0].lastRun.status, 'completed');
  assert.equal(harness.repository.read()[0].lastRun.backupId, '20261112130000-abcdef01.sql');
  await r.call('db:save-backup-schedule', payload);
  profiles.p1.host = 'different'; await harness.engine.tick();
  assert.equal(r.sessions.length, 1);
  assert.equal(harness.repository.read()[0].enabled, false);
  assert.equal(harness.repository.read()[0].lastRun.errorCode, 'SCHEDULE_TARGET_CHANGED');
});

test('automatic retention enable needs native opt-in; unchanged policy and disabling do not reconfirm', async () => {
  let saved = { policy: null, automaticAfterBackup: false, updatedAt: null }, confirmations = 0;
  const r = setup({ retentionStore: {
    read: () => saved,
    save: (_profileId, _db, policy, options) => { saved = { policy, ...options }; return saved; }
  } });
  const request = { profileId: 'p1', database: 'demo', policy: { maxCount: 3 }, automaticAfterBackup: true };
  r.productionDialog(async (_window, options) => {
    confirmations++; assert.equal(options.defaultId, 0); assert.match(options.detail, /không hỏi lại/); return { response: 0 };
  });
  assert.equal((await r.call('db:save-backup-retention-policy', request)).data.canceled, true);
  assert.equal(saved.automaticAfterBackup, false);
  r.productionDialog(async () => { confirmations++; return { response: 1 }; });
  assert.equal((await r.call('db:save-backup-retention-policy', request)).data.automaticAfterBackup, true);
  assert.equal((await r.call('db:save-backup-retention-policy', request)).data.automaticAfterBackup, true);
  assert.equal(confirmations, 2);
  assert.equal((await r.call('db:save-backup-retention-policy', { ...request, automaticAfterBackup: false })).data.automaticAfterBackup, false);
  assert.equal(confirmations, 2);
});

test('auto cleanup runs after backup success and a cleanup error keeps the backup result successful', async () => {
  let ran = 0;
  const r = setup({ retentionStore: { read: () => ({ policy: { maxCount: 1 }, automaticAfterBackup: true }) },
    retentionAuto: async options => {
      ran++; assert.equal(options.backupId, 'test.sql'); assert.equal(options.database, 'demo');
      assert.equal(options.isCanceled(), false); options.checkContext();
      return { status: 'failed', reason: 'cleanup fixture failure' };
    }
  });
  const pending = r.call('db:backup', { profileId: 'p1', database: 'demo', taskId: 'auto-backup' });
  await tick(); assert.equal(ran, 0);
  r.finish({ bytes: 9 });
  const result = (await pending).data;
  assert.equal(ran, 1); assert.equal(result.canceled, false); assert.equal(result.id, 'test.sql');
  assert.equal(result.retention.status, 'failed'); assert.equal(r.sessions[0].dead, true);
});

test('history export honors dialog Cancel, reads main-owned records and never opens a database session', async () => {
  let writes = 0;
  const records = [{ id: 'main-owned' }];
  const r = setup({ retentionHistory: { read: (profileId, database) => {
    assert.equal(profileId, 'p1'); assert.equal(database, 'demo'); return records;
  } }, retentionExport: async options => {
    writes++; assert.equal(options.records, records);
    assert.equal(options.userData, '/review'); assert.equal(options.appVersion, 'test-version');
    assert.equal(options.filePath, '/outside/report.json'); return { canceled: false, records: 1 };
  } });
  r.dialog(async (_window, options) => {
    assert.equal(options.filters[0].extensions[0], 'json'); return { canceled: true };
  });
  assert.equal((await r.call('db:export-backup-retention-history', { profileId: 'p1', database: 'demo' })).data.canceled, true);
  assert.equal(writes, 0);
  r.dialog(async () => ({ canceled: false, filePath: '/outside/report.json' }));
  assert.equal((await r.call('db:export-backup-retention-history', { profileId: 'p1', database: 'demo', records: ['forged'] })).data.records, 1);
  assert.equal(writes, 1); assert.equal(r.sessions.length, 0);
});

test('history export refuses a changed profile after native Save dialog', async () => {
  const readOnlyProfiles = [];
  let writes = 0;
  const r = setup({ readOnlyProfiles, retentionExport: async () => { writes++; } });
  r.dialog(async () => { readOnlyProfiles.push('p1'); return { filePath: '/outside/report.json' }; });
  assert.equal((await r.call('db:export-backup-retention-history', { profileId: 'p1', database: 'demo' })).ok, false);
  assert.equal(writes, 0);
});

test('trial rechecks read-only policy after asynchronous connection opens', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-review-trial-policy-'));
  const file = path.join(directory, 'backup.sql');
  fs.writeFileSync(file, 'SELECT 1;');
  try {
    const readOnlyProfiles = [];
    const r = setup({ readOnlyProfiles, onConnect: () => { readOnlyProfiles.push('p1'); }, backupCatalog: { resolveBackup: async () => file } });
    r.productionDialog(async () => ({ response: 1 }));
    const result = await r.call('db:trial-backup', { profileId: 'p1', database: 'demo', id: 'fixture', taskId: 'trial-policy' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'CONNECTION_READ_ONLY');
    assert.equal(r.sessions.length, 1);
    assert.equal(r.sessions[0].dead, true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('retention history starts before apply, preserves results when report save fails and marks old running records incomplete', async () => {
  const events = [];
  const id = '20260101000000-aaaaaaaa.sql';
  const record = { id: 'history-id', state: 'running' };
  const r = setup({ retentionHistory: {
    read: () => [record],
    begin: () => { events.push('begin'); return record.id; },
    finish: () => { events.push('finish'); throw new Error('report disk full'); }
  }, retentionApply: {
    consume: () => ({ database: 'demo', plan: { policy: { maxCount: 1 }, removeBytes: 9, rows: [{ id, name: 'Old', action: 'remove' }] } }),
    apply: async () => { events.push('apply'); return { deleted: [id], remaining: [], failed: [], reclaimedBytes: 9 }; }
  } });
  r.productionDialog(async () => ({ response: 1 }));
  const result = (await r.call('db:apply-backup-retention', { profileId: 'p1', database: 'demo', token: 'token', taskId: 'history-task' })).data;
  assert.deepEqual(events, ['begin', 'apply', 'finish']);
  assert.equal(result.deleted[0], id);
  assert.equal(result.historySaveError, 'report disk full');
  const records = (await r.call('db:backup-retention-history', { profileId: 'p1', database: 'demo' })).data;
  assert.equal(records[0].state, 'incomplete');
  assert.equal(record.state, 'running', 'display state must not rewrite stored evidence');
});

test('history write failure prevents cleanup from starting', async () => {
  let applied = false;
  const r = setup({ retentionHistory: { begin: () => { throw new Error('disk full'); } }, retentionApply: {
    consume: () => ({ database: 'demo', plan: { rows: [{ id: 'old', action: 'remove' }] } }),
    apply: async () => { applied = true; }
  } });
  r.productionDialog(async () => ({ response: 1 }));
  assert.equal((await r.call('db:apply-backup-retention', { profileId: 'p1', database: 'demo', taskId: 'history-task', token: 'token' })).ok, false);
  assert.equal(applied, false);
});

test('retention apply requires native confirmation, consumes before confirmation and releases transfer on failure', async () => {
  let used = false, applied = 0;
  const entry = { database: 'demo', plan: { removeBytes: 9, rows: [{ id: 'old', name: 'Old backup', action: 'remove' }] } };
  const r = setup({ retentionApply: {
    consume: (profileId, database, token) => {
      assert.equal(profileId, 'p1'); assert.equal(database, 'demo'); assert.equal(token, 'issued');
      if (used) throw new Error('consumed'); used = true; return entry;
    },
    apply: async () => { applied++; throw new Error('fixture changed'); }
  } });
  const payload = { profileId: 'p1', database: 'demo', token: 'issued', taskId: 'retention-fixture', ids: ['forged'] };
  assert.equal((await r.call('db:apply-backup-retention', payload)).data.canceled, true);
  assert.equal(applied, 0);
  assert.equal((await r.call('db:apply-backup-retention', payload)).ok, false);
  used = false;
  r.productionDialog(async (_window, options) => {
    assert.equal(options.defaultId, 0); assert.match(options.detail, /Old backup/);
    return { response: 1 };
  });
  assert.equal((await r.call('db:apply-backup-retention', payload)).ok, false);
  assert.equal(applied, 1);
  used = false;
  assert.equal((await r.call('db:apply-backup-retention', payload)).ok, false);
  assert.equal(applied, 2, 'prior failure must release transfer slot');
  assert.equal(r.sessions.length, 0, 'local cleanup must not commit or open a DB session');
});

test('retention status and cancel are scoped and abort only the cleanup stream', async () => {
  let finish, options;
  const r = setup({ retentionApply: {
    consume: () => ({ database: 'demo', plan: { removeBytes: 9, rows: [{ id: 'old', name: 'Old', action: 'remove' }] } }),
    apply: async (_entry, control) => {
      options = control;
      control.onProgress({ phase: 'hashing', bytesRead: 64, totalBytes: 128, deleted: 0, total: 1, reclaimedBytes: 0 });
      return new Promise(resolve => { finish = resolve; });
    }
  } });
  r.productionDialog(async () => ({ response: 1 }));
  const payload = { profileId: 'p1', database: 'demo', token: 'issued', taskId: 'cleanup-task' };
  const pending = r.call('db:apply-backup-retention', payload);
  await tick();
  assert.equal((await r.call('db:backup-retention-status', { ...payload, taskId: 'other' })).data.running, false);
  assert.equal((await r.call('db:backup-retention-status', { ...payload, database: 'other' })).data.running, false);
  const status = (await r.call('db:backup-retention-status', payload)).data;
  assert.equal(status.phase, 'hashing'); assert.equal(status.bytesRead, 64);
  assert.equal((await r.call('db:cancel-task', { ...payload, profileId: 'other' })).data.canceled, false);
  assert.equal(options.signal.aborted, false);
  assert.equal((await r.call('db:cancel-task', payload)).data.canceled, true);
  assert.equal(options.signal.aborted, true); assert.equal(options.isCanceled(), true);
  assert.equal((await r.call('db:backup-retention-status', payload)).data.stopping, true);
  finish({ stopped: true, deleted: [], remaining: ['old'], failed: [], reclaimedBytes: 0 });
  await pending;
  assert.equal((await r.call('db:backup-retention-status', payload)).data.running, false);
  assert.equal(r.sessions.length, 0);
});

test('retention policy IPC uses captured profile and database for local settings', async () => {
  const calls = [];
  const r = setup({ retentionStore: {
    read: (...args) => { calls.push(['read', ...args]); return { policy: null }; },
    save: (...args) => { calls.push(['save', ...args]); return { policy: args[2] }; },
    clear: (...args) => { calls.push(['clear', ...args]); return { policy: null }; }
  } });
  for (const operation of ['get', 'save', 'clear']) {
    const result = await r.call(`db:${operation}-backup-retention-policy`, { profileId: 'p1', database: 'demo', policy: { maxCount: 4 } });
    assert.equal(result.ok, true);
    assert.equal(calls.at(-1)[1], 'p1');
    assert.equal(calls.at(-1)[2], 'demo');
  }
  assert.equal((await r.call('db:save-backup-retention-policy', { profileId: 'p1', database: '' })).ok, false);
  assert.equal(calls.length, 4);
});

test('retention preview reads the scoped catalog, ignores renderer inventory and performs no writes', async () => {
  const catalogCalls = [];
  const r = setup({ retentionApply: { preview: async (profileId, database, policy) => {
    catalogCalls.push([profileId, database]);
    return require('../electron/backup-retention.cjs').planBackupRetention([
      { id: 'only', name: 'Keep me', bytes: 100, createdAt: '2026-01-01T00:00:00Z', verification: { fileWritten: true, checksum: 'verified' } }
    ], policy);
  } } });
  const result = await r.call('db:preview-backup-retention', { profileId: 'p1', database: 'demo',
    policy: { maxCount: 1 }, entries: [{ id: 'forged' }] });
  assert.equal(result.ok, true);
  assert.equal(result.data.totalCount, 1);
  assert.equal(result.data.rows[0].id, 'only');
  assert.equal(result.data.removeCount, 0);
  assert.deepEqual(catalogCalls[0], ['p1', 'demo']);
  assert.equal((await r.call('db:preview-backup-retention', { profileId: 'p1', database: '', policy: { maxCount: 1 } })).ok, false);
});

test('trial recovery requires policy and confirmation, and closes only its own session', async () => {
  const { targetIdentity } = require('../electron/restore-trial-journal.cjs');
  const profile = { id: 'p1', ssh: {}, readOnly: false, environment: 'local' };
  const record = { id: 'a'.repeat(32), profileId: 'p1', database: 'sqlpro_trial_fixture', target: targetIdentity(profile) };
  let cleaned = 0, removed = 0;
  const trialRecovery = {
    journal: { read: () => record, remove: () => { removed++; } },
    cleanup: async (session, value, actual) => {
      assert.equal(value, record); assert.equal(actual.id, 'p1');
      assert.equal(session.profile.id, 'p1'); cleaned++;
      return { cleanup: 'removed' };
    }
  };
  const denied = setup({ readOnlyProfiles: ['p1'], trialRecovery });
  assert.equal((await denied.call('db:cleanup-trial-recovery', { profileId: 'p1', id: record.id })).ok, false);
  assert.equal(denied.sessions.length, 0);
  const r = setup({ trialRecovery });
  assert.equal((await r.call('db:cleanup-trial-recovery', { profileId: 'p1', id: record.id })).data.canceled, true);
  assert.equal(cleaned, 0);
  await r.call('db:connect', 'p1');
  r.sessions[0].inTransaction = true;
  r.productionDialog(async () => ({ response: 1 }));
  assert.equal((await r.call('db:cleanup-trial-recovery', { profileId: 'p2', id: record.id })).ok, false);
  assert.equal((await r.call('db:cleanup-trial-recovery', { profileId: 'p1', id: record.id })).data.cleanup, 'removed');
  assert.equal(cleaned, 1); assert.equal(removed, 1);
  assert.equal(r.sessions[0].dead, undefined);
  assert.equal(r.sessions[0].inTransaction, true);
  assert.equal(r.sessions[1].dead, true);
});
const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  throw new Error('Timed out waiting for fixture state.');
};

test('transaction controls pin the observed session, reject busy/stale state and do not reconnect', async () => {
  const r = setup();
  await r.call('db:connect', 'p1');
  const session = r.sessions[0];
  session.inTransaction = true;
  session.autocommit = false;
  session.transactionRevision = 3;
  const state = (await r.call('db:session-state', 'p1')).data;
  assert.ok(state.sessionId);
  const payload = { profileId: 'p1', sessionId: state.sessionId, transactionRevision: 3, action: 'commit' };
  const commands = [];
  session.runQueryScript = async (sql) => { commands.push(sql); session.inTransaction = false; };
  session.activeTask = { id: 'busy' };
  assert.equal((await r.call('db:transaction', payload)).error.code, 'SESSION_BUSY');
  session.activeTask = null;
  assert.equal((await r.call('db:transaction', { ...payload, transactionRevision: 2 })).error.code, 'TRANSACTION_CONTEXT_CHANGED');
  assert.equal((await r.call('db:transaction', { ...payload, action: 'DROP' })).error.code, 'INVALID_TRANSACTION_ACTION');
  await r.call('db:connect', 'p2');
  assert.equal((await r.call('db:transaction', payload)).ok, true);
  assert.deepEqual(commands, ['COMMIT']);
  assert.equal(session.autocommit, false);
  session.inTransaction = true;
  assert.equal((await r.call('db:transaction', { ...payload, action: 'rollback' })).ok, true);
  assert.deepEqual(commands, ['COMMIT', 'ROLLBACK']);
  await r.call('db:disconnect', 'p1', { force: true });
  await r.call('db:connect', 'p1');
  assert.equal((await r.call('db:transaction', payload)).error.code, 'TRANSACTION_CONTEXT_CHANGED');
  const count = r.sessions.length;
  await r.call('db:disconnect', 'p1', { force: true });
  assert.equal((await r.call('db:transaction', payload)).error.code, 'TRANSACTION_CONTEXT_CHANGED');
  assert.equal(r.sessions.length, count);
});

test('main blocks every DB write on read-only profiles before opening sessions or file dialogs', async () => {
  const r = setup({readOnlyProfiles:['read']});
  let dialogs = 0;
  r.dialog(async () => { dialogs += 1; return {canceled:true}; });
  r.openDialog(async () => { dialogs += 1; return {canceled:true}; });
  const base = {profileId:'read',database:'demo',table:'items',filePath:'/test.csv'};
  for (const [channel, payload] of [
    ['db:insert-row',base], ['db:update-row',base], ['db:delete-rows',base], ['db:import-file',base],
    ['db:restore',{...base,profileId:'write',targetProfileId:'read'}],
    ['db:query',{...base,sql:'SELECT 1; DROP TABLE items',confirmed:true}],
    ['db:export-query',{...base,sql:'SELECT custom_write()',taskId:'export'}]
  ]) {
    const result = await r.call(channel,payload);
    assert.equal(result.ok,false,channel);
    assert.ok(['CONNECTION_READ_ONLY','READ_ONLY_SQL_UNSUPPORTED'].includes(result.error.code),channel);
  }
  assert.equal(r.sessions.length,0);
  assert.equal(dialogs,0);
});

test('main checks trusted profile, supports active-session fallback and keeps writable targets usable', async () => {
  const r = setup({readOnlyProfiles:['read']});
  await r.call('db:connect','read');
  const reader = r.sessions[0];
  reader.runQueryScript = async (sql) => ({sql});
  assert.equal((await r.call('db:query',{sql:'DELETE FROM items',readOnly:false,confirmed:true})).error.code,'CONNECTION_READ_ONLY');
  assert.equal((await r.call('db:query',{sql:'SELECT 1'})).ok,true);
  await r.call('db:connect','write');
  r.sessions[1].runQueryScript = async (sql) => ({sql});
  assert.equal((await r.call('db:query',{profileId:'write',sql:'UPDATE items SET id=1',confirmed:true})).ok,true);
  assert.equal((await r.call('db:query',{profileId:'read',sql:'DELETE FROM items',confirmed:true})).error.code,'CONNECTION_READ_ONLY');
});

test('changing connection policy cannot silently roll back a transaction or interrupt a busy session', async () => {
  const r = setup();
  await r.call('db:connect','write');
  const session = r.sessions[0];
  session.inTransaction = true;
  assert.equal((await r.call('connections:save',{id:'write',readOnly:true})).error.code,'PROFILE_TRANSACTION_OPEN');
  assert.equal(session.dead,undefined);
  session.inTransaction = false;
  session.autocommit = false;
  assert.equal((await r.call('connections:save',{id:'write',readOnly:true})).error.code,'PROFILE_TRANSACTION_OPEN');
  session.autocommit = true;
  session.activeTask = {id:'busy'};
  assert.equal((await r.call('connections:save',{id:'write',readOnly:true})).error.code,'SESSION_BUSY');
  assert.equal(session.dead,undefined);
});

test('export rechecks read-only policy after the save dialog and before executing SQL', async () => {
  const readOnlyProfiles = [];
  const r = setup({readOnlyProfiles});
  r.dialog(async () => { readOnlyProfiles.push('write'); return {filePath:'/review/query.csv'}; });
  const result = await r.call('db:export-query',{profileId:'write',database:'demo',sql:'SELECT custom_write()',taskId:'export-policy'});
  assert.equal(result.ok,false);
  assert.equal(result.error.code,'READ_ONLY_SQL_UNSUPPORTED');
  assert.equal(r.sessions.length,1);
  assert.equal(r.sessions[0].activeTask,undefined);
});

test('production write approval binds an immutable request, never trusts confirmed and is single use',async () => {
  const r = setup({productionProfiles:['prod']});
  await r.call('db:connect','prod');
  const writes = [];
  r.sessions[0].updateRow = async (payload) => {writes.push(payload);return {affectedRows:1};};
  const payload = {profileId:'prod',database:'demo',table:'items',keys:{id:1},values:{name:'private-value'},confirmed:true};
  const result = await r.call('db:update-row',payload);
  assert.equal(result.error.code,'PRODUCTION_CONFIRM_REQUIRED');
  assert.equal(writes.length,0);
  assert.equal(JSON.stringify(result.error.preview).includes('private-value'),false);
  payload.values.name = 'mutated';
  const token = result.error.preview.token;
  assert.equal((await r.call('db:confirm-production',token)).ok,true);
  assert.equal(writes[0].values.name,'private-value');
  assert.equal((await r.call('db:confirm-production',token)).error.code,'PRODUCTION_APPROVAL_EXPIRED');
});

test('production approvals reject changed session, transaction, schema or policy',async () => {
  for (const change of ['session','transaction','schema','readonly']) {
    const readonly = [];
    const r = setup({productionProfiles:['prod'],readOnlyProfiles:readonly});
    await r.call('db:connect','prod');
    let writes = 0;
    r.sessions[0].updateRow = async () => {writes += 1;};
    const result = await r.call('db:update-row',{profileId:'prod',database:'demo',table:'items',keys:{id:1},values:{name:'new'}});
    const token = result.error.preview.token;
    if (change === 'session') {await r.call('db:disconnect','prod',{force:true});await r.call('db:connect','prod');}
    if (change === 'transaction') r.sessions[0].transactionRevision = 1;
    if (change === 'schema') r.sessions[0].columns = [{name:'id',type:'bigint'}];
    if (change === 'readonly') readonly.push('prod');
    assert.equal((await r.call('db:confirm-production',token)).ok,false,change);
    assert.equal(writes,0,change);
  }
});

test('production SQL reads remain usable while writes are reviewed before any statement runs',async () => {
  const r = setup({productionProfiles:['prod']});
  await r.call('db:connect','prod');
  const queries = [];
  r.sessions[0].runQueryScript = async (sql,_timeout,confirmed) => {queries.push({sql,confirmed});return {};};
  assert.equal((await r.call('db:query',{profileId:'prod',sql:'SELECT 1'})).ok,true);
  const result = await r.call('db:query',{profileId:'prod',sql:"SELECT 1; DELETE FROM users WHERE name='private'",confirmed:true});
  assert.equal(result.error.code,'PRODUCTION_CONFIRM_REQUIRED');
  assert.equal(queries.length,1);
  assert.equal(result.error.preview.sql.includes('private'),false);
  assert.equal((await r.call('db:confirm-production',result.error.preview.token)).ok,true);
  assert.equal(queries[1].confirmed,true);
});

test('production export cannot bypass SQL review by executing an unclassified SELECT function',async () => {
  const r = setup({productionProfiles:['prod']});
  let dialogs = 0;
  r.dialog(async () => {dialogs += 1;return {canceled:true};});
  const result = await r.call('db:export-query',{profileId:'prod',sql:'SELECT custom_write()',taskId:'export'});
  assert.equal(result.error.code,'READ_ONLY_SQL_UNSUPPORTED');
  assert.equal(dialogs,0);
  assert.equal(r.sessions.length,0);
});

test('confirmed production writes retain their session lease until execution settles',async () => {
  const r = setup({productionProfiles:['prod']});
  await r.call('db:connect','prod');
  let finishWrite;
  r.sessions[0].updateRow = () => new Promise(resolve => {finishWrite=resolve;});
  const request = {profileId:'prod',database:'demo',table:'items',keys:{id:1},values:{name:'new'}};
  const review = await r.call('db:update-row',request);
  const pending = r.call('db:confirm-production',review.error.preview.token);
  await waitFor(()=>Boolean(finishWrite));
  assert.equal((await r.call('connections:save',{id:'prod'})).error.code,'SESSION_BUSY');
  assert.equal((await r.call('db:query',{profileId:'prod',sql:'SELECT 1'})).error.code,'SESSION_BUSY');
  assert.equal((await r.call('db:update-row',request)).error.code,'SESSION_BUSY');
  finishWrite({affectedRows:1});
  assert.equal((await pending).ok,true);
  assert.equal((await r.call('db:session-state','prod')).data.busy,false);
});

test('production Commit requires a one-use approval pinned to the exact transaction',async () => {
  const r = setup({productionProfiles:['prod']});
  await r.call('db:connect','prod');
  const session = r.sessions[0];
  session.inTransaction = true;
  session.transactionRevision = 4;
  session.database = 'demo';
  const commands = [];
  session.runQueryScript = async (sql) => {commands.push(sql);session.inTransaction=false;};
  const state = (await r.call('db:session-state','prod')).data;
  const payload = {profileId:'prod',action:'commit',sessionId:state.sessionId,transactionRevision:4,confirmed:true};
  const review = await r.call('db:transaction',payload);
  assert.equal(review.error.code,'PRODUCTION_CONFIRM_REQUIRED');
  assert.equal(review.error.preview.sql,'COMMIT');
  assert.match(review.error.preview.note,/mọi tab/);
  assert.equal(commands.length,0);
  const token = review.error.preview.token;
  assert.equal((await r.call('db:confirm-production',token)).ok,true);
  assert.deepEqual(commands,['COMMIT']);
  assert.equal((await r.call('db:confirm-production',token)).error.code,'PRODUCTION_APPROVAL_EXPIRED');
});

test('production Commit is cancelled by revision change, reconnect, busy state or read-only policy',async () => {
  for (const change of ['revision','reconnect','busy','readonly','cancel']) {
    const readonly = [];
    const r = setup({productionProfiles:['prod'],readOnlyProfiles:readonly});
    await r.call('db:connect','prod');
    const session = r.sessions[0];
    session.inTransaction=true;
    let commands = 0;
    session.runQueryScript=async ()=>{commands += 1;};
    const state=(await r.call('db:session-state','prod')).data;
    const review=await r.call('db:transaction',{profileId:'prod',action:'commit',sessionId:state.sessionId,transactionRevision:0});
    const token=review.error.preview.token;
    if (change==='revision') session.transactionRevision=1;
    if (change==='reconnect') {await r.call('db:disconnect','prod',{force:true});await r.call('db:connect','prod');}
    if (change==='busy') session.activeTask={id:'busy'};
    if (change==='readonly') readonly.push('prod');
    if (change==='cancel') await r.call('db:cancel-production',token);
    assert.equal((await r.call('db:confirm-production',token)).ok,false,change);
    assert.equal(commands,0,change);
  }
});

test('production Rollback remains available without the production Commit challenge',async () => {
  const r=setup({productionProfiles:['prod'],readOnlyProfiles:['prod']});
  await r.call('db:connect','prod');
  const session=r.sessions[0];session.inTransaction=true;
  const commands=[];session.runQueryScript=async sql=>{commands.push(sql);};
  const state=(await r.call('db:session-state','prod')).data;
  assert.equal((await r.call('db:transaction',{profileId:'prod',action:'rollback',sessionId:state.sessionId,transactionRevision:0})).ok,true);
  assert.deepEqual(commands,['ROLLBACK']);
});

test('production import requires native confirmation before creating a worker and detects changed files',async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sqlpro-production-import-'));
  const filePath=path.join(dir,'data.csv');
  fs.writeFileSync(filePath,'id\n1\n');
  try {
    const r=setup({productionProfiles:['prod']});
    const payload={profileId:'prod',database:'demo',table:'items',filePath,taskId:'production-import'};
    let seen;
    r.productionDialog(async (_win,options)=>{seen=options;return {response:0};});
    assert.equal((await r.call('db:import-file',payload)).data.canceled,true);
    assert.match(seen.detail,/Database đích: demo/);
    assert.match(seen.detail,/Bảng đích: items/);
    assert.equal(seen.defaultId,0);
    assert.equal(r.sessions.length,0);
    r.productionDialog(async ()=>{fs.appendFileSync(filePath,'2\n');return {response:1};});
    assert.equal((await r.call('db:import-file',payload)).error.code,'PRODUCTION_CONTEXT_CHANGED');
    assert.equal(r.sessions.length,0);
    r.productionDialog(async ()=>({response:1}));
    const pending=r.call('db:import-file',payload);
    await waitFor(()=>r.sessions.length===1 && r.sessions[0].activeTask);
    r.finish({written:2});
    assert.equal((await pending).ok,true);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('production restore confirms the resolved file and target before starting its worker',async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sqlpro-production-restore-'));
  const filePath=path.join(dir,'backup.sql');fs.writeFileSync(filePath,'SELECT 1;');
  try {
    const r=setup({productionProfiles:['target']});
    r.openDialog(async ()=>({canceled:false,filePaths:[filePath]}));
    let seen;
    r.productionDialog(async (_win,options)=>{seen=options;return {response:0};});
    const result=await r.call('db:restore',{profileId:'source',targetProfileId:'target',database:'target_db',dropExisting:true});
    assert.equal(result.data.canceled,true);
    assert.match(seen.detail,/Database đích: target_db/);
    assert.match(seen.detail,/Xóa đối tượng hiện có: Có/);
    assert.equal(r.sessions.length,0);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('transaction controls reject overlapping actions and never replay a failed commit', async () => {
  const r = setup();
  await r.call('db:connect', 'p1');
  const session = r.sessions[0];
  session.inTransaction = true;
  const state = (await r.call('db:session-state', 'p1')).data;
  const payload = { profileId:'p1', sessionId:state.sessionId, transactionRevision:0, action:'commit' };
  let rejectCommit;
  let attempts = 0;
  session.runQueryScript = () => { attempts += 1; return new Promise((_resolve, reject) => { rejectCommit = reject; }); };
  const pending = r.call('db:transaction', payload);
  assert.equal((await r.call('db:transaction', payload)).error.code, 'SESSION_BUSY');
  rejectCommit(Object.assign(new Error('lost connection'), {code:'PROTOCOL_CONNECTION_LOST'}));
  assert.equal((await pending).ok, false);
  assert.equal(attempts, 1);
  assert.equal(r.sessions.length, 1);
  assert.equal((await r.call('db:session-state', 'p1')).data.busy, false);
});

test('reset invalidates sync before waiting for database shutdown or replacing local data', async () => {
  const events = [];
  let finish;
  const r = setup({ sync: { logout: async () => { events.push('logout'); } }, reset: () => { events.push('reset'); return { backupName: 'fixture.json' }; } });
  await r.call('db:connect', 'p1');
  r.sessions[0].close = () => { events.push('close'); return new Promise((resolve) => { finish = resolve; }); };
  const pending = r.call('account:reset-local'); await tick();
  assert.deepEqual(events, ['logout', 'close']);
  finish();
  assert.equal((await pending).ok, true);
  assert.deepEqual(events, ['logout', 'close', 'reset']);
});

test('backup uses and cancels its own session without touching the SQL editor session', async () => {
  const r = setup();
  await r.call('db:connect', 'p1');
  const parent = r.sessions[0];
  parent.userTransaction = true;
  const pending = r.call('db:backup', { profileId: 'p1', database: 'demo', taskId: 'backup-1' });
  await tick();
  assert.equal(r.sessions.length, 2);
  const worker = r.sessions[1];
  assert.equal(worker.activeTask.id, 'backup-1');
  assert.equal((await r.call('db:connect', 'p2')).ok, true);
  assert.equal(r.sessions.length, 3);
  assert.equal((await r.call('db:cancel-task', { profileId: 'p1', taskId: 'backup-1' })).data.canceled, true);
  assert.equal((await pending).data.canceled, true);
  assert.deepEqual(worker.canceled, ['backup-1']);
  assert.equal(worker.dead, true);
  assert.equal(parent.dead, undefined);
  assert.equal(parent.userTransaction, true);
  assert.deepEqual(parent.canceled, []);
});

test('import và restore dùng phiên riêng, không đụng transaction của SQL editor', async () => {
  const r = setup();
  await r.call('db:connect', 'p1');
  const parent = r.sessions[0];
  parent.inTransaction = true;
  parent.autocommit = false;
  const { profileId, connected, inTransaction, autocommit } = (await r.call('db:session-state', 'p1')).data;
  assert.deepEqual({ profileId, connected, inTransaction, autocommit }, {
    profileId: 'p1',
    connected: true,
    inTransaction: true,
    autocommit: false
  });
  assert.equal(JSON.stringify((await r.call('db:disconnect', 'p1')).data), JSON.stringify({
    disconnected: false,
    needsConfirmation: true,
    profileId: 'p1'
  }));

  const importing = r.call('db:import-file', {
    profileId: 'p1',
    database: 'demo',
    table: 'items',
    filePath: '/review/items.csv',
    format: 'csv',
    taskId: 'import-worker'
  });
  await tick();
  assert.equal(r.sessions.length, 2);
  const importWorker = r.sessions[1];
  assert.notEqual(importWorker, parent);
  assert.equal(importWorker.prepared, 'import');
  assert.equal(importWorker.activeTask.id, 'import-worker');
  assert.deepEqual(parent.canceled, []);
  r.finish({ rows: 1, written: 1, committed: 1 });
  const importResult = await importing;
  assert.equal(importResult.ok, true);
  assert.equal(importResult.data.written, 1);
  assert.equal(importWorker.dead, true);
  assert.equal(parent.dead, undefined);

  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-main-restore-'));
  const filePath = path.join(folder, 'backup.sql');
  fs.writeFileSync(filePath, 'SELECT 1;\n');
  r.openDialog(async () => ({ canceled: false, filePaths: [filePath] }));
  try {
    const restoring = r.call('db:restore', { profileId: 'p1', database: 'demo', taskId: 'restore-worker' });
    await waitFor(() => r.sessions.length === 3);
    const restoreWorker = r.sessions[2];
    assert.notEqual(restoreWorker, parent);
    assert.equal(restoreWorker.prepared, 'restore');
    assert.equal(restoreWorker.activeTask.id, 'restore-worker');
    r.finish({ statements: 1, verification: { status: 'verified' } });
    const restoreResult = await restoring;
    assert.equal(restoreResult.ok, true);
    assert.equal(restoreResult.data.statements, 1);
    assert.equal(restoreWorker.dead, true);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }

  assert.equal(parent.dead, undefined);
  assert.equal(parent.inTransaction, true);
  assert.equal(parent.autocommit, false);
  assert.deepEqual(parent.canceled, []);
  assert.equal(JSON.stringify((await r.call('db:disconnect', 'p1', { force: true })).data), JSON.stringify({
    disconnected: true,
    openProfiles: []
  }));
});

test('query export reserves its task before the save dialog and supports cancel during preparation', async () => {
  const r = setup();
  let choose;
  r.dialog(() => new Promise((resolve) => { choose = resolve; }));
  const pending = r.call('db:export-query', { profileId: 'p1', sql: 'SELECT 1', format: 'json', taskId: 'export-1' });
  await tick();
  const competing = await r.call('db:export-query', { profileId: 'p1', sql: 'SELECT 2', taskId: 'export-2' });
  assert.equal(competing.ok, false);
  assert.equal((await r.call('db:cancel-task', { profileId: 'other', taskId: 'export-1' })).data.canceled, false);
  assert.equal((await r.call('db:cancel-task', { profileId: 'p1', taskId: 'export-1' })).data.canceled, true);
  choose({ filePath: '/review/export.json' });
  assert.equal((await pending).data.canceled, true);
  assert.equal(r.sessions[0].activeTask, undefined);
  r.dialog(async () => ({ canceled: true }));
  assert.equal((await r.call('db:export-query', { profileId: 'p1', sql: 'SELECT 1', taskId: 'export-3' })).data.dialog, true);
});

for (const outcome of ['metadata-error', 'connection-error', 'success']) {
  test(`stale connect ${outcome} does not close or replace a new busy session`, async () => {
    const r = setup();
    // Opening yields before metadata, allowing us to hold that session's response.
    const old = r.call('db:connect', 'p1');
    let finish, fail;
    r.sessions[0].listDatabases = () => new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    await tick();
    await r.call('db:disconnect', 'p1');
    assert.equal((await r.call('db:connect', 'p1')).ok, true);
    const current = r.sessions[1];
    current.inTransaction = true; current.activeTask = { id: 'busy' };
    if (outcome === 'success') finish(['old']);
    else fail(Object.assign(new Error('old metadata failure'), { code: outcome === 'connection-error' ? 'ECONNRESET' : 'OLD_METADATA_ERROR' }));
    assert.equal((await old).ok, false);
    assert.equal(current.dead, undefined);
    assert.equal(r.sessions.length, 2);
    assert.equal(JSON.stringify((await r.call('db:open-profiles')).data), '["p1"]');
    assert.equal((await r.call('db:connect', 'p1')).data.reused, true);
  });
}

test('query export cancels the matching stream and releases the transfer slot', async () => {
  const r = setup();
  const pending = r.call('db:export-query', { profileId: 'p1', sql: 'SELECT 1', format: 'json', taskId: 'export-1' });
  await tick();
  assert.equal(r.sessions[0].activeTask.id, 'export-1');
  assert.equal((await r.call('db:cancel-task', { profileId: 'p1', taskId: 'wrong' })).data.canceled, false);
  assert.equal((await r.call('db:cancel-task', { profileId: 'p1', taskId: 'export-1' })).data.canceled, true);
  assert.equal((await pending).data.canceled, true);
  r.dialog(async () => ({ canceled: true }));
  assert.equal((await r.call('db:export-query', { profileId: 'p1', sql: 'SELECT 1', taskId: 'export-2' })).ok, true);
});
