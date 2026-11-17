'use strict';

// Runs the real HTML, renderer and preload in a hidden Electron window.
// Only IPC handlers are replaced; no database or account is contacted.
const { app, BrowserWindow, ipcMain, Menu, clipboard } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const root = process.env.SQLPRO_RENDERER_APP_ROOT ? path.resolve(process.env.SQLPRO_RENDERER_APP_ROOT) : path.join(__dirname, '..');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-smoke-')));
app.commandLine.appendSwitch('disable-gpu');
const calls = [];
const errors = [];
let win;
let checks = 0;
const columns = [
  { name: 'id', type: 'int', key: 'PRI', extra: 'auto_increment', nullable: 'NO', defaultValue: null },
  { name: 'name', type: 'varchar(255)', key: '', extra: '', nullable: 'YES', defaultValue: null }
];
let rowEditorColumns = columns;
let autocompleteColumns = null;
let rowEditorFailure = false;
let rowEditorResult = { affectedRows: 1, changedRows: 1 };
let sshTestResponses = [];
let pendingQueryExport = null;
let explainTreeUnsupported = false;
let analyzeCanceled = false;
let explainAccessMethod = 'ALL';
let explainSessionId = 'smoke-explain-session';
let explainSettingsDigest = 'a';
let explainSettingsMissing = false;
let explainSchemaDigest = 'a';
let explainSchemaMissing = false;
const tables = Array.from({ length: 14 }, (_, i) => ({ name: i ? `table_${i}` : 'users', type: 'table' }));
const ok = (data) => ({ ok: true, data });
const rows = (names, data) => ({ kind: 'rows', columns: names.map((name) => ({ name, type: 'TEXT' })), rows: data, durationMs: 1 });
const handle = (name, fn) => ipcMain.handle(name, async (_event, ...args) => {
  calls.push({ name, args });
  return fn(...args);
});
handle('app:metadata', () => ({ version: 'test', platform: process.platform }));
handle('state:load', () => ({}));
handle('state:save', () => ({}));
const tablePreferencesRepository = require(path.join(root, 'electron/table-preferences.cjs')).createTablePreferences(app.getPath('userData'));
let pendingTablePreferenceRead = null;
handle('table-preferences:read', scope => pendingTablePreferenceRead ? pendingTablePreferenceRead(scope) : ok(tablePreferencesRepository.read(scope)));
handle('table-preferences:save', (scope, value) => ok(tablePreferencesRepository.save(scope, value)));
handle('table-preferences:remove', scope => ok(tablePreferencesRepository.remove(scope)));
const auditLogRepository = require(path.join(root, 'electron/audit-log.cjs')).createAuditLogStore(app.getPath('userData'));
handle('audit-log:read', (filter) => auditLogRepository.read(filter));
handle('audit-log:append', (entry) => auditLogRepository.append(entry));
handle('audit-log:prune', (options) => auditLogRepository.prune(options));
handle('audit-log:clear', () => auditLogRepository.clear());
handle('clipboard:write-text', async (text) => { await clipboard.writeText(text); return ok({ written: true }); });
handle('clipboard:read-text', async () => ok(await clipboard.readText()));
handle('workspaces:list', () => ok([{ id: 'ws-personal', name: 'Personal' }]));
handle('connections:list', () => ok([]));
handle('connections:test', () => sshTestResponses.shift() || ok({ version: '8.4-test' }));
handle('connections:save', (payload) => ok({ ...payload, id: payload.id || 'saved-test' }));
handle('db:open-profiles', () => ok([]));
handle('db:session-state', (profileId) => ok({ profileId, connected: true, inTransaction: false, autocommit: true }));
handle('db:confirm-production', () => ok({affectedRows:1}));
handle('db:cancel-production', () => ok({cancelled:true}));
handle('db:disconnect', () => ok({ disconnected: true, openProfiles: [] }));
handle('account:list-recovery', () => ok([]));
handle('account:resolve-conflicts', () => ok({ state: 'synced', conflicts: [], conflictCount: 0 }));
handle('account:restore-recovery', (id) => ok({ restored: true, id }));
handle('account:status', () => ok({ loggedIn: false }));
handle('db:use-database', () => ok({}));
handle('db:databases', () => ok(['test']));
handle('db:tables', () => ok(tables));
handle('db:columns', payload => ok(autocompleteColumns?.get(payload?.table) || rowEditorColumns));
handle('db:indexes', () => ok([]));
handle('db:relations', () => ok({ outbound: [{ table: 'users', column: 'id', refTable: 'table_1', refColumn: 'id', refDatabase: 'test' }], inbound: [] }));
handle('db:table-data', () => ok({ columns, primaryKey: ['id'], rows: [{ id: 1, name: 'Alice' }], total: 1, page: 1, pageSize: 100 }));
handle('db:table-count', () => ok({ total: 42 }));
handle('db:delete-rows', (payload) => ok({ affectedRows: payload.keysList.length }));
handle('db:update-row', () => rowEditorFailure ? { ok: false, error: { message: 'Expected row save failure' } } : ok(rowEditorResult));
handle('db:insert-row', () => ok({ affectedRows: 1, insertId: 2 }));
handle('db:import-file', (payload) => ok({
  database: payload.database,
  table: payload.table,
  format: payload.format,
  mode: payload.mode,
  transaction: payload.transaction,
  rows: 2,
  written: 2,
  committed: 2,
  affectedRows: 2,
  duplicates: 0,
  batches: 1,
  bytes: 18,
  durationMs: 1,
  resumable: false
}));
handle('db:export-file', (payload) => ok({
  database: payload.database,
  table: payload.table,
  format: payload.format,
  rows: 2,
  bytes: 64,
  columns: ['id', 'name'],
  filePath: `/tmp/${payload.database}.${payload.table}.${payload.format}`,
  durationMs: 1
}));
handle('db:pick-import-file', () => ok({
  canceled: false,
  filePath: '/tmp/sqlpro-smoke-import.csv',
  name: 'sqlpro-smoke-import.csv',
  size: 18,
  format: 'csv'
}));
handle('db:preview-import', () => ok({
  format: 'csv',
  delimiter: ',',
  hasHeader: true,
  headers: ['name'],
  rows: [['Alice'], ['Binh']],
  sampledBytes: 18,
  totalBytes: 18,
  truncated: false
}));
const routines = [
  { name: 'p_one', type: 'procedure', returnType: null, deterministic: false, security: 'DEFINER', definer: 'root@%', comment: '', createdAt: null, updatedAt: null },
  { name: 'f_one', type: 'function', returnType: 'int', deterministic: true, security: 'INVOKER', definer: 'root@%', comment: '', createdAt: null, updatedAt: null }
];
const routineEvents = [
  { name: 'e_one', status: 'ENABLED', type: 'RECURRING', onCompletion: 'NOT PRESERVE', intervalValue: '1', intervalField: 'DAY', starts: null, ends: null, lastExecuted: null, definer: 'root@%', comment: '' }
];
const backupCalls = [];
let pendingBackup = null;
let holdBackup = false;
handle('db:routines', () => ok(routines));
handle('db:events', () => ok(routineEvents));
handle('db:show-create', (payload) => ok({
  kind: payload.kind,
  database: payload.database,
  name: payload.name,
  sql: `CREATE ${payload.kind.toUpperCase()} \`${payload.name}\`() BEGIN SELECT 1; END`,
  meta: { Database: payload.database }
}));
handle('db:backup', (payload) => {
  backupCalls.push(payload);
  const result = ok({
    canceled: false, id: '20261023120000-smoke.sql', filePath: '/tmp/20261023120000-smoke.sql',
    tables: 1, views: 0, triggers: 0, procedures: 1, functions: 1, events: 1, rows: 1, bytes: 128
  });
  if (holdBackup) return new Promise((resolve) => { pendingBackup = () => resolve(result); });
  return result;
});
handle('db:list-backups', () => ok([]));
let savedSchedule = null;
let cancelScheduleSave = true;
handle('db:get-backup-schedule', () => ok({ schedule: savedSchedule, paused: false }));
handle('db:save-backup-schedule', payload => {
  if (cancelScheduleSave) return ok({ canceled: true });
  savedSchedule = { ...payload, enabled: true, targetMatches: true, lastRun: null };
  return ok({ schedule: savedSchedule });
});
handle('db:pause-backup-schedule', () => { savedSchedule.enabled = false; return ok({ paused: true }); });
handle('db:delete-backup-schedule', () => { savedSchedule = null; return ok({ deleted: true }); });
const retentionCalls = [];
let savedRetentionPolicy = null;
let savedRetentionAutomatic = false;
handle('db:get-backup-retention-policy', () => ok({ policy: savedRetentionPolicy, automaticAfterBackup: savedRetentionAutomatic }));
handle('db:save-backup-retention-policy', payload => { savedRetentionPolicy = payload.policy; savedRetentionAutomatic = payload.automaticAfterBackup; return ok({ policy: savedRetentionPolicy, automaticAfterBackup: savedRetentionAutomatic }); });
handle('db:clear-backup-retention-policy', () => { savedRetentionPolicy = null; savedRetentionAutomatic = false; return ok({ policy: null, automaticAfterBackup: false }); });
let holdRetention = false;
let pendingRetention;
const retentionFixture = {
  token: 'retention-smoke-token',
  plannedAt: '2026-11-12T12:00:00Z', removeCount: 1, totalCount: 3, remainingCount: 2,
  removeBytes: 100, remainingBytes: 200, warnings: ['count-unmet'], rows: [
    { id: 'old', name: '<img src=x onerror=alert(1)>', bytes: 100, action: 'remove', reasons: ['age'], protectedReasons: [] },
    { id: 'pin', name: 'Quan trọng', bytes: 100, action: 'keep', reasons: [], protectedReasons: ['pinned'] },
    { id: 'new', name: 'Mới nhất', bytes: 100, action: 'keep', reasons: [], protectedReasons: ['newest', 'latest-verified'] }
  ]
};
handle('db:preview-backup-retention', payload => {
  retentionCalls.push(payload);
  if (holdRetention) return new Promise(resolve => { pendingRetention = resolve; });
  return ok(retentionFixture);
});
let holdRetentionApply = false;
let pendingRetentionApply;
handle('db:apply-backup-retention', payload => holdRetentionApply
  ? new Promise(resolve => { pendingRetentionApply = { payload, resolve }; }) : ok({ canceled: true }));
handle('db:backup-retention-status', payload => ok({ running: Boolean(pendingRetentionApply && payload.taskId === pendingRetentionApply.payload.taskId),
  phase: 'hashing', bytesRead: 64, totalBytes: 128, deleted: 0, total: 1, reclaimedBytes: 0 }));
handle('db:backup-retention-history', () => ok([{ id: 'history-fixture', state: 'incomplete', startedAt: '2026-11-12T12:00:00Z', finishedAt: null,
  planned: ['20260101000000-aaaaaaaa.sql'], deleted: [], remaining: ['20260101000000-aaaaaaaa.sql'], failed: [], reclaimedBytes: 0,
  policy: { maxCount: 1, maxAgeDays: null, maxBytes: null } }]));
const historyExportCalls = [];
handle('db:export-backup-retention-history', payload => { historyExportCalls.push(payload); return ok({ canceled: false, records: 1 }); });
const annotationCalls = [];
let annotationFailure = false;
let holdAnnotations = false;
let pendingAnnotations;
handle('db:update-backup-annotations', payload => {
  annotationCalls.push(payload);
  if (annotationFailure) return { ok: false, error: { code: 'ENOSPC', message: 'Không đủ dung lượng lưu ghi chú.' } };
  if (holdAnnotations) return new Promise(resolve => { pendingAnnotations = resolve; });
  return ok({ id: payload.id, ...payload.patch });
});
let pendingInspection;
let pendingTrial;
const trialRecoveryCalls = [];
handle('db:list-trial-recovery', () => ok([
  { id: 'a'.repeat(32), database: 'sqlpro_trial_owned', startedAt: '2026-11-12T00:00:00Z', targetMatches: true },
  { id: 'b'.repeat(32), database: 'sqlpro_trial_changed', startedAt: '2026-11-12T00:00:00Z', targetMatches: false }
]));
handle('db:cleanup-trial-recovery', payload => { trialRecoveryCalls.push(payload); return ok({ cleanup: 'removed' }); });
handle('db:trial-backup',payload=>new Promise(resolve=>{pendingTrial={payload,resolve};}));
handle('db:inspect-backup',()=>new Promise(resolve=>{pendingInspection=resolve;}));
const selectionColumns = new (require('../electron/restore-selection.cjs').RestoreSelectionInventory)('test');
for (const [index, sql] of [
  'SET NAMES utf8mb4', 'SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0',
  "SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO'",
  'CREATE TABLE `users` (`id` bigint unsigned NOT NULL, `email` varchar(100), PRIMARY KEY (`id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin',
  'CREATE TABLE `<img src=x>` (`id` bigint unsigned, CONSTRAINT `fk_source` FOREIGN KEY (`id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE) ENGINE=InnoDB',
  "INSERT INTO users VALUES (1,'one')", 'INSERT INTO users VALUES (2,NOW())', 'INSERT INTO `<img src=x>` VALUES (1)', 'DROP TABLE users',
  'SET SQL_MODE=@OLD_SQL_MODE', 'SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS'
].entries()) selectionColumns.add(sql, require('../electron/sql-script.cjs').assertStatementScope(sql, 'test', index + 1), index + 1);
const selectionInventory = selectionColumns.finish();
const decimalCollector = new (require('../electron/restore-selection.cjs').RestoreSelectionInventory)('test');
for (const [index, sql] of [
  'CREATE TABLE `users` (`amount` DECIMAL(10,4)) ENGINE=InnoDB',
  'CREATE TABLE `<img src=x>` (`id` INT) ENGINE=InnoDB',
  "INSERT INTO users VALUES(1.234),(-0.01),(1000),('1.234'),('-0.01'),('1000')"
].entries()) decimalCollector.add(sql, require('../electron/sql-script.cjs').assertStatementScope(sql, 'test', index + 1), index + 1);
const decimalInventory = decimalCollector.finish();
const textCollector = new (require('../electron/restore-selection.cjs').RestoreSelectionInventory)('test');
for (const [index, sql] of [
  'CREATE TABLE `users` (`title` VARCHAR(100), `code` VARCHAR(10)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
  'CREATE TABLE `<img src=x>` (`id` INT) ENGINE=InnoDB',
  "INSERT INTO users VALUES('Việt😀','abc ')"
].entries()) textCollector.add(sql, require('../electron/sql-script.cjs').assertStatementScope(sql, 'test', index + 1), index + 1);
const textInventory = textCollector.finish();
const omittedCollector = new (require('../electron/restore-selection.cjs').RestoreSelectionInventory)('test');
for (const [index, sql] of [
  "CREATE TABLE `users` (`id` INT, `required` INT NOT NULL, `<img src=default>` VARCHAR(30) DEFAULT 'private-default', `optional` INT NULL) ENGINE=InnoDB",
  'CREATE TABLE `<img src=x>` (`id` INT) ENGINE=InnoDB',
  'INSERT INTO users (`id`) VALUES(1)'
].entries()) omittedCollector.add(sql, require('../electron/sql-script.cjs').assertStatementScope(sql, 'test', index + 1), index + 1);
const omittedInventory = omittedCollector.finish();
const temporalCollector = new (require('../electron/restore-selection.cjs').RestoreSelectionInventory)('test');
for (const [index, sql] of [
  'CREATE TABLE `users` (`d` DATE, `dt` DATETIME(6)) ENGINE=InnoDB',
  'CREATE TABLE `<img src=x>` (`id` INT) ENGINE=InnoDB',
  "INSERT INTO users VALUES('1900-02-29','2024-02-29 01:02:03.123456'),('0000-00-00','2024-02-29 24:00:00')"
].entries()) temporalCollector.add(sql, require('../electron/sql-script.cjs').assertStatementScope(sql, 'test', index + 1), index + 1);
const temporalInventory = temporalCollector.finish();
const packetCollector = new (require('../electron/restore-selection.cjs').RestoreSelectionInventory)('test');
for (const [index, sql] of [
  'CREATE TABLE `users` (`value` TEXT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
  'CREATE TABLE `<img src=x>` (`id` INT) ENGINE=InnoDB',
  `INSERT INTO users VALUES('${'private-packet-'.repeat(100)}')`
].entries()) packetCollector.add(sql, require('../electron/sql-script.cjs').assertStatementScope(sql, 'test', index + 1), index + 1);
const packetInventory = packetCollector.finish();
const timeCollector = new (require('../electron/restore-selection.cjs').RestoreSelectionInventory)('test');
for (const [index, sql] of [
  'CREATE TABLE `users` (`duration` TIME(6), `overflow` TIME(6)) ENGINE=InnoDB',
  'CREATE TABLE `<img src=x>` (`id` INT) ENGINE=InnoDB',
  "INSERT INTO users VALUES('-123:45:56.123456','839:00:00')"
].entries()) timeCollector.add(sql, require('../electron/sql-script.cjs').assertStatementScope(sql, 'test', index + 1), index + 1);
const timeInventory = timeCollector.finish();
const yearCollector = new (require('../electron/restore-selection.cjs').RestoreSelectionInventory)('test');
for (const [index, sql] of [
  'CREATE TABLE `users` (`yr` YEAR) ENGINE=InnoDB', 'CREATE TABLE `<img src=x>` (`id` INT) ENGINE=InnoDB',
  "INSERT INTO users VALUES(2156),('0'),('99')"
].entries()) yearCollector.add(sql, require('../electron/sql-script.cjs').assertStatementScope(sql, 'test', index + 1), index + 1);
const yearInventory = yearCollector.finish();
const timestampCollector = new (require('../electron/restore-selection.cjs').RestoreSelectionInventory)('test');
for (const [index, sql] of [
  'CREATE TABLE `users` (`ts` TIMESTAMP(6) NULL) ENGINE=InnoDB', 'CREATE TABLE `<img src=x>` (`id` INT) ENGINE=InnoDB',
  "INSERT INTO users VALUES('2024-02-29 01:02:03.123456')"
].entries()) timestampCollector.add(sql, require('../electron/sql-script.cjs').assertStatementScope(sql, 'test', index + 1), index + 1);
const timestampInventory = timestampCollector.finish();
const selectionInventories = new Map([
  ['unique_destination', timestampInventory], ['checks_destination', timestampInventory], ['timestamp_destination', timestampInventory], ['year_destination', yearInventory],
  ['time_destination', timeInventory], ['packet_destination', packetInventory], ['temporal_destination', temporalInventory],
  ['omitted_destination', omittedInventory], ['text_destination', textInventory], ['decimal_destination', decimalInventory]
]);
handle('db:preview-backup-selection', payload => ok({
  ...require('../electron/restore-selection.cjs').previewRestoreSelection(selectionInventory, payload), checksum: 'a'.repeat(64), cached: true
}));
let holdSelectionTarget = false, pendingSelectionTarget, selectionMetadataChanged = false;
handle('db:preview-backup-selection-target', payload => {
  if (holdSelectionTarget) return new Promise(resolve => { pendingSelectionTarget = { payload, resolve }; });
  const currentInventory = selectionInventories.get(payload.targetDatabase) || selectionInventory;
  const source = require('../electron/restore-selection.cjs').previewRestoreSelection(currentInventory, payload);
  const checksum = 'a'.repeat(64);
  const facts = { sessionSettings: require('../electron/restore-selection-session-policy.cjs').normalizeSessionSettings({ foreignKeyChecks: 1, uniqueChecks: 1, autocommit: 1, sqlMode: 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION', charsetClient: 'utf8mb4', charsetConnection: 'utf8mb4', charsetResults: 'utf8mb4' }), indexVisibility: { version: 1, status: 'observed', kind: 'mysql-visible' }, indexes: [{ table: 'users', name: 'PRIMARY', nonUnique: false, ordinal: 1, column: 'id', prefixLength: null, direction: 'A', type: 'BTREE', visibility: 'visible' }, { table: 'users', name: '<img src=index>', nonUnique: true, ordinal: 1, column: 'email', prefixLength: 10, direction: 'A', type: 'BTREE', visibility: 'invisible' }], database: payload.targetDatabase, checkedAt: '2026-11-12T12:00:00Z', version: '8.4', lowerCaseTableNames: 0, databaseVisible: true,
    objects: [{ name: 'users', type: 'table' }, { name: '<img src=x>', type: 'view' }], triggers: [{ name: '<img src=trigger>', table: 'users', event: 'INSERT' }],
    foreignKeyMetadataVersion: 2, foreignKeys: [{ ordinal: 1, onDelete: 'SET NULL', onUpdate: 'CASCADE', match: 'NONE', name: 'fk_outside', tableSchema: 'other', table: 'external_child', column: 'user_id', referencedSchema: payload.targetDatabase, referencedTable: 'users', referencedColumn: 'id' },
      { ordinal: 2, onDelete: 'SET NULL', onUpdate: 'CASCADE', match: 'NONE', name: 'fk_outside', tableSchema: 'other', table: 'external_child', column: 'owner_email', referencedSchema: payload.targetDatabase, referencedTable: 'users', referencedColumn: 'email' },
      { ordinal: 1, onDelete: 'CASCADE', onUpdate: 'CASCADE', match: 'NONE', name: 'fk_live', tableSchema: payload.targetDatabase, table: '<img src=x>', column: 'id', referencedSchema: payload.targetDatabase, referencedTable: 'users', referencedColumn: 'id' }],
    columns: [...selectionInventory.tables[0].columnSchema.columns].reverse().map((column, i) => ({ ...column, table: 'users', ordinal: i + 1,
      ...(column.name === 'id' ? require('../electron/restore-selection-columns.cjs').normalizeColumnType('int') : {}) })), errors: [], truncated: [] };
  if (payload.targetDatabase === 'comparison_destination') facts.objects[1].type = 'table';
  if (payload.targetDatabase === 'decimal_destination') {
    facts.objects = [{ name: 'users', type: 'table' }]; facts.triggers = []; facts.foreignKeys = []; facts.indexes = [];
    facts.columns = decimalInventory.tables[0].columnSchema.columns.map(column => ({ ...column, table: 'users',
      ...require('../electron/restore-selection-columns.cjs').normalizeColumnType('decimal(5,2) unsigned') }));
  }
  if (payload.targetDatabase === 'text_destination') {
    facts.objects = [{ name: 'users', type: 'table' }]; facts.triggers = []; facts.foreignKeys = []; facts.indexes = [];
    facts.columns = textInventory.tables[0].columnSchema.columns.map(column => ({ ...column, table: 'users',
      ...require('../electron/restore-selection-columns.cjs').normalizeColumnType(column.name === 'title' ? 'varchar(2)' : 'char(5)'),
      charset: column.name === 'title' ? 'ascii' : 'utf8mb4' }));
  }
  if (payload.targetDatabase === 'empty_destination') {
    facts.objects = []; facts.triggers = []; facts.foreignKeys = []; facts.columns = []; facts.indexes = [];
  }
  if (payload.targetDatabase === 'omitted_destination') {
    facts.objects = [{ name: 'users', type: 'table' }]; facts.triggers = []; facts.foreignKeys = []; facts.indexes = [];
    facts.columns = omittedInventory.tables[0].columnSchema.columns.map(column => ({ ...column, table: 'users' }));
  }
  if (payload.targetDatabase === 'temporal_destination') {
    facts.objects = [{ name: 'users', type: 'table' }]; facts.triggers = []; facts.foreignKeys = []; facts.indexes = [];
    facts.columns = temporalInventory.tables[0].columnSchema.columns.map(column => ({ ...column, table: 'users',
      ...(column.name === 'dt' ? require('../electron/restore-selection-columns.cjs').normalizeColumnType('datetime(3)') : {}) }));
  }
  if (payload.targetDatabase === 'unique_destination') facts.sessionSettings.uniqueChecks = false;
  facts.checkSessionSettings = payload.targetDatabase === 'checks_destination' ? { version: 1, status: 'observed', enabled: false, reason: 'TARGET_CHECK_SESSION_OBSERVED' } : { version: 1, status: 'unknown', enabled: null, reason: 'TARGET_CHECK_SESSION_VARIABLE_UNAVAILABLE' };
  facts.checks = []; facts.checkCapabilities = { version: 1, status: 'observed', tableColumn: false, enforcedColumn: true };
  if (payload.targetDatabase === 'checks_destination') facts.checks = [{ constraintSchema: payload.targetDatabase, tableSchema: payload.targetDatabase, table: 'users', name: '<img src=check>', clauseDigest: 'c'.repeat(64), declaredEnforcement: 'yes' }];
  facts.packetSettings = { version: 1, maxAllowedPacket: 67108864 };
  if (payload.targetDatabase === 'packet_destination') {
    facts.packetSettings.maxAllowedPacket = 1024;
    facts.objects = [{ name: 'users', type: 'table' }]; facts.triggers = []; facts.foreignKeys = []; facts.indexes = [];
    facts.columns = packetInventory.tables[0].columnSchema.columns.map(column => ({ ...column, table: 'users' }));
  }
  if (payload.targetDatabase === 'time_destination') {
    facts.objects = [{ name: 'users', type: 'table' }]; facts.triggers = []; facts.foreignKeys = []; facts.indexes = [];
    facts.columns = timeInventory.tables[0].columnSchema.columns.map(column => ({ ...column, table: 'users',
      ...require('../electron/restore-selection-columns.cjs').normalizeColumnType('time(3)') }));
  }
  if (payload.targetDatabase === 'year_destination') {
    facts.objects = [{ name: 'users', type: 'table' }]; facts.triggers = []; facts.foreignKeys = []; facts.indexes = [];
    facts.columns = yearInventory.tables[0].columnSchema.columns.map(column => ({ ...column, table: 'users' }));
  }
  if (payload.targetDatabase === 'timestamp_destination') {
    facts.objects = [{ name: 'users', type: 'table' }]; facts.triggers = []; facts.foreignKeys = []; facts.indexes = [];
    facts.columns = timestampInventory.tables[0].columnSchema.columns.map(column => ({ ...column, table: 'users',
      ...require('../electron/restore-selection-columns.cjs').normalizeColumnType('timestamp(3)') }));
  }
  const targetIdentity = 'b'.repeat(64);
  facts.triggerMetadataVersion = 1;
  facts.columns = facts.columns.map(column => ({ ...column, expressionProfile: { version: 1,
    defaultStatus: column.hasDefault ? 'observed' : 'null-metadata', defaultDigest: column.hasDefault ? '7'.repeat(64) : null,
    generatedStatus: column.generated ? 'observed' : 'not-reported', generatedDigest: column.generated ? '8'.repeat(64) : null } }));
  facts.triggers = facts.triggers.map(trigger => ({ ...trigger, triggerSchema: payload.targetDatabase, tableSchema: payload.targetDatabase,
    timing: 'AFTER', orientation: 'ROW', actionOrder: 1, actionDigest: (selectionMetadataChanged ? 'f' : 'd').repeat(64), contextDigest: 'e'.repeat(64) }));
  facts.objects = facts.objects.map(object => ({ ...object, engine: object.type === 'table' ? payload.targetDatabase === 'checks_destination' ? 'MyISAM' : 'InnoDB' : null }));
  const targetReview = require('../electron/restore-selection-target.cjs').buildSelectionTargetPreview({ source, checksum, targetIdentity, facts });
  const draftPlan = require('../electron/restore-selection-plan.cjs').buildSelectionDraft({ inventory: currentInventory, source, checksum, targetIdentity, targetReview, conflictPolicy: payload.conflictPolicy });
  return ok({ ...source, checksum, cached: false, targetReview, draftPlan });
});
handle('db:inspect-backup-status',()=>ok({running:true,cancelling:false,bytes:50,totalBytes:100,statements:3}));
handle('db:cancel-inspect-backup',()=>{pendingInspection?.({ok:false,error:{code:'BACKUP_SCAN_CANCELLED',message:'Đã hủy quét backup.'}});return ok({canceled:true});});
handle('file:save-text', () => ({ canceled: false }));
handle('db:export-query', (payload) => new Promise((resolve) => { pendingQueryExport = { payload, resolve }; }));
handle('db:cancel-task', (payload) => {
  if (pendingSelectionTarget && payload.taskId === pendingSelectionTarget.payload.taskId && payload.profileId === pendingSelectionTarget.payload.profileId) {
    pendingSelectionTarget.resolve({ ok: false, error: { code: 'SELECTION_PREVIEW_CANCELED', message: 'Đã hủy kiểm tra đích.' } });
    pendingSelectionTarget = null; return ok({ canceled: true });
  }
  if (pendingRetentionApply && payload.taskId === pendingRetentionApply.payload.taskId && payload.profileId === pendingRetentionApply.payload.profileId) {
    pendingRetentionApply.resolve(ok({ stopped: true, deleted: [], remaining: ['old'], failed: [], reclaimedBytes: 0 }));
    pendingRetentionApply = null; return ok({ canceled: true });
  }
  if(pendingTrial && payload.taskId===pendingTrial.payload.taskId && payload.profileId===pendingTrial.payload.profileId){
    pendingTrial.resolve(ok({report:{status:'cancelled',cleanup:'removed',database:'sqlpro_trial_fixture',checksum:'abc'}}));pendingTrial=null;return ok({canceled:true});
  }
  if (!pendingQueryExport || payload.taskId !== pendingQueryExport.payload.taskId || payload.profileId !== pendingQueryExport.payload.profileId) return ok({ canceled: false });
  pendingQueryExport.resolve(ok({ canceled: true }));
  pendingQueryExport = null;
  return ok({ canceled: true });
});
handle('db:analyze-query', () => analyzeCanceled ? ok({ canceled: true }) : ok({
  ...rows(['ANALYZE'], [['{"query_block":{"r_rows":2,"r_total_time_ms":0.12,"condition":"<img src=x onerror=alert(1)>"}}']]),
  isAnalyze: true, isExplain: true, explainFormat: 'JSON', analysis: { version: 1, executed: true, engine: 'MariaDB' }
}));
handle('db:query', (payload) => {
  if (!payload || typeof payload.sql !== 'string') return { ok: false, error: { message: 'Invalid query payload' } };
  const sql = payload.sql.trim();
  const explainResult = (names, data) => ok({ ...rows(names, data), explainContext: { version: 1,
    profileId: payload.profileId, database: payload.database ?? null, taskId: payload.taskId,
    sessionId: explainSessionId, sqlHash: crypto.createHash('sha256').update(payload.sql).digest('hex'), checkedAt: new Date().toISOString(),
    ...(payload.explainSettings === true ? { settings: explainSettingsMissing ? null : { version: 1, status: 'observed',
      fields: require(path.join(root, 'query-results.js')).explainSettingNames.map(name => ({ name,
        digest: (name === 'time_zone' ? explainSettingsDigest : 'a').repeat(64) })) } } : {}),
    ...(payload.explainSchema === true ? { schema: explainSchemaMissing ? null : { version: 1, status: 'observed',
      database: payload.database, table: '<img src=table>', digest: explainSchemaDigest.repeat(64) } } : {}) } });
  if (/FAIL_TEST/.test(sql)) return { ok: false, error: { message: 'Expected SQL failure', code: 'TEST_ERROR' } };
  if (/^(UPDATE|DELETE|ALTER|DROP|KILL)\b/i.test(sql) && !payload.confirmed) {
    return { ok: false, error: { code: 'CONFIRM_REQUIRED', message: 'Confirmation required' } };
  }
  if (/^SHOW FULL PROCESSLIST/i.test(sql)) return ok(rows(['Id', 'User', 'Host', 'db', 'Command', 'Time', 'State', 'Info'], [[42, 'test', 'localhost', 'test', 'Query', 8, '', 'SELECT 1']]));
  if (/^SHOW (VARIABLES|STATUS)/i.test(sql)) return ok(rows(['Variable_name', 'Value'], [['max_connections', '151']]));
  if (/^EXPLAIN FORMAT=JSON /i.test(sql)) return explainResult(['EXPLAIN'], [['{"query_block":{"rows":90071992547409931234,"condition":"<img src=x onerror=alert(1)>","table_name":"users"}}']]);
  if (/^EXPLAIN FORMAT=TREE /i.test(sql)) return explainTreeUnsupported
    ? { ok: false, error: { code: 'ER_UNKNOWN_EXPLAIN_FORMAT', message: 'Server không hỗ trợ TREE' } }
    : explainResult(['EXPLAIN'], [['-> Table scan on users  (cost=0.35 rows=1)\n']]);
  if (/^EXPLAIN/i.test(sql)) return explainResult(['table', 'type', 'Extra'], [['users', explainAccessMethod, 'Using filesort']]);
  if (/^(CHECK|OPTIMIZE|ANALYZE|REPAIR) TABLE/i.test(sql)) return ok(rows(['Table', 'Op', 'Msg_type', 'Msg_text'], [['test.users', 'check', 'status', 'OK']]));
  if (/^SELECT/i.test(sql)) return ok(rows(['value', 'type'], [['ALL', 'ALL'], ['2', 'REF']]));
  return ok({ kind: 'ok', affectedRows: 1, insertId: null, durationMs: 1 });
});

const evaluate = (code) => win.webContents.executeJavaScript(code);
async function captureReview(name, prepare) {
  const { width, height } = win.getContentBounds();
  await until(`innerWidth===${width} && innerHeight===${height}`);
  if (!process.env.SQLPRO_REVIEW_SCREENSHOT_DIR) {
    if (prepare) await prepare();
    return;
  }
  win.setContentSize(width + 2, height + 2);
  await new Promise((resolve) => setTimeout(resolve, 120));
  win.setContentSize(width, height);
  await new Promise((resolve) => setTimeout(resolve, 120));
  if (prepare) {
    await prepare();
    win.webContents.invalidate();
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  fs.mkdirSync(process.env.SQLPRO_REVIEW_SCREENSHOT_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.SQLPRO_REVIEW_SCREENSHOT_DIR, `${name}.png`), (await win.webContents.capturePage()).toPNG());
}
async function until(code) {
  const deadline = Date.now() + 5000;
  while (!await evaluate(code)) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${code}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function untilNode(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for Node-side condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function check(name, fn) {
  try { await fn(); } catch (error) { error.message = `${name}: ${error.message}`; throw error; }
  checks += 1;
  console.log(`PASS ${name}`);
}
async function confirmPending(expression, accept = true) {
  await evaluate(`window.pendingAction = ${expression}; void 0`);
  await until("document.querySelector('#modal').open");
  await evaluate(`document.querySelector('${accept ? '#confirmOk' : '#confirmCancel'}').click()`);
  await evaluate('window.pendingAction');
}

async function captureProductShots() {
  const directory = process.env.SQLPRO_SCREENSHOT_DIR;
  if (!directory) return;
  fs.mkdirSync(directory, { recursive: true });
  const capture = async (name) => {
    // Resizing forces a fresh compositor frame in a hidden window on Windows.
    win.setContentSize(1346, 837);
    await new Promise((resolve) => setTimeout(resolve, 120));
    win.setContentSize(1344, 835);
    await new Promise((resolve) => setTimeout(resolve, 120));
    fs.writeFileSync(path.join(directory, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  await evaluate(`
    closeModal();
    $('#toast').style.display = 'none';
    app.tables = ${JSON.stringify(tables.map((entry) => ({ ...entry, rowEstimate: entry.name === 'users' ? 3 : 0 })))};
    app.connections = [{ id: 'test', name: 'Demo workspace', host: 'localhost', port: 3306, user: 'demo', ssh: { enabled: false }, workspaceId: app.activeWorkspaceId }];
    app.connection = app.connections[0]; app.database = 'test';
    app.query.sql = 'SELECT id, name, email FROM users LIMIT 100;';
    app.query.result = { kind: 'rows', columns: [{ name: 'id', type: 'INT' }, { name: 'name', type: 'VARCHAR' }, { name: 'email', type: 'VARCHAR' }], rows: [[1, 'Alex', 'alex@example.com'], [2, 'Linh', 'linh@example.com'], [3, 'Sam', 'sam@example.com']], durationMs: 4 };
    app.query.error = ''; mode = 'query'; renderSidebar(); renderQueryView(); setConnectionState('connected', 'Demo local');
  `);
  await capture('editor');
  await evaluate('connection(app.connections[0])');
  await capture('connection');
  await evaluate('closeModal(); backupDatabase()');
  await until("Boolean($('#backupRoutineList .backup-routine'))");
  await capture('backup');
  await evaluate('closeModal()');
  await require('../scripts/encode-website-demo.cjs')(directory);
}

app.whenReady().then(async () => {
  win = new BrowserWindow({ show: Boolean(process.env.SQLPRO_REVIEW_VISIBLE), width: 1360, height: 900, webPreferences: {
    preload: path.join(root, 'electron/preload.cjs'), contextIsolation: true, backgroundThrottling: false
  } });
  win.webContents.on('preload-error', (_event, _file, error) => errors.push(error.message));
  await win.loadFile(path.join(root, 'index.html'));
  // Account refresh is the final step of init(). Waiting only for workspaces
  // races its later view('data'), which can remove the query DOM under a test.
  await until('app.workspaces.length > 0 && app.account !== null');
  await evaluate("window.addEventListener('error', event => { window.rendererErrors.push(event.message); }); window.addEventListener('unhandledrejection', event => { window.rendererErrors.push(String(event.reason)); }); window.rendererErrors = []; app.connection = {id:'test', name:'Mock', host:'localhost', port:3306, ssh:{enabled:false}}; app.database='test'; table='users'; app.tables=[{name:'users',type:'table'}]; mode='query'; renderQueryView();");

  await check('formatter button is bound after rendering', async () => {
    assert.equal(await evaluate("$('#queryTimeout').value"), '300000');
    assert.equal(await evaluate("$('#queryRowLimit').value"), '50000');
    await evaluate("$('#queryRowLimit').value='100000'; $('#queryRowLimit').dispatchEvent(new Event('change')); renderQueryView()");
    assert.equal(await evaluate("$('#queryRowLimit').value"), '100000');
    await evaluate("$('#queryRowLimit').value='50000'; $('#queryRowLimit').dispatchEvent(new Event('change'))");
    await evaluate("$('#queryTimeout').value='900000'; $('#queryTimeout').dispatchEvent(new Event('change')); renderQueryView()");
    assert.equal(await evaluate("$('#queryTimeout').value"), '900000');
    await evaluate("$('#queryTimeout').value='300000'; $('#queryTimeout').dispatchEvent(new Event('change'))");
    assert.equal(await evaluate("$('#sql').value='select 1'; $('#formatSqlBtn').click(); $('#sql').value"), 'SELECT 1');
  });
  await check('SQL editor undo and redo survive formatting and tab switches', async () => {
    const result = await evaluate(`(() => {
      app.query.sql = 'select';
      renderQueryView();
      let editor = $('#sql');
      editor.focus();
      editor.setSelectionRange(6, 6);
      editor.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: ' 1', bubbles: true, cancelable: true }));
      editor.value = 'select 1';
      editor.setSelectionRange(8, 8);
      editor.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: ' 1', bubbles: true }));
      const key = (name, shiftKey = false) => editor.dispatchEvent(new KeyboardEvent('keydown', {
        key: name, ctrlKey: true, shiftKey, bubbles: true, cancelable: true
      }));
      key('z');
      const undoTyping = editor.value;
      key('y');
      const redoTyping = editor.value;
      formatCurrentSql();
      const formatted = editor.value;
      key('z');
      const undoFormat = editor.value;
      newQuery('SELECT 2');
      selectQueryTab(0);
      editor = $('#sql');
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true, cancelable: true }));
      return { undoTyping, redoTyping, formatted, undoFormat, redoAfterTab: editor.value };
    })()`);
    assert.deepEqual(result, {
      undoTyping: 'select', redoTyping: 'select 1', formatted: 'SELECT 1',
      undoFormat: 'select 1', redoAfterTab: 'SELECT 1'
    });
  });
  await check('Electron delivers Ctrl+Z to the focused SQL editor', async () => {
    await evaluate(`(() => {
      app.query.sql = 'SELECT A';
      renderQueryView();
      const editor = $('#sql');
      editor.focus();
      editor.setSelectionRange(editor.value.length, editor.value.length);
      editor.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', bubbles: true, cancelable: true }));
      editor.value = 'SELECT AB';
      editor.setSelectionRange(editor.value.length, editor.value.length);
      editor.dispatchEvent(new InputEvent('input', { inputType: 'insertText', bubbles: true }));
    })()`);
    win.webContents.focus();
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control'] });
    await until("$('#sql').value === 'SELECT A'");
  });
  await check('autocomplete keeps case-sensitive sources and self-join aliases, caches bounded metadata and accepts columns with keyboard/undo', async () => {
    autocompleteColumns = new Map([
      ['Items', [{ name: 'Name', type: 'varchar(50)' }, { name: 'name', type: 'varchar(50)' }, { name: '<img src=x>', type: 'text' }]],
      ['items', [{ name: 'lower_key', type: 'int' }]]
    ]);
    await evaluate("invalidateSqlAutocomplete();app.query.sql='SELECT * FROM Items a JOIN items b ON a.Name=b.lower_key WHERE ';renderQueryView();$('#sql').focus();$('#sql').setSelectionRange($('#sql').value.length,$('#sql').value.length)");
    const count = calls.filter(call => call.name === 'db:columns').length;
    await evaluate("refreshSqlSuggestions($('#sql'),true)");
    assert.equal(calls.filter(call => call.name === 'db:columns').length, count + 2);
    const labels = await evaluate('sqlAutocomplete.items.map(item=>item.label)');
    assert.deepEqual(labels, ['a.Name', 'a.name', 'a.<img src=x>', 'b.lower_key']);
    assert.equal(await evaluate("$('#sqlSuggestions img')===null"), true);
    await evaluate("refreshSqlSuggestions($('#sql'),true)");
    assert.equal(calls.filter(call => call.name === 'db:columns').length, count + 2);
    win.setContentSize(900, 650);
    win.webContents.focus();
    await evaluate("$('#sql').style.height='75px';$('#toast').style.display='none';$('#sql').focus();setSqlSuggestionSelection(0)");
    await captureReview('autocomplete-cache-small', () => evaluate("clearTimeout(sqlAutocomplete.blurTimer);$('#sql').focus();refreshSqlSuggestions($('#sql'),true)"));
    assert.equal(await evaluate("$('#sqlSuggestions').classList.contains('hidden')"), false);
    assert.equal(await evaluate("$('#sqlSuggestions').getBoundingClientRect().right<=innerWidth"), true);
    assert.equal(await evaluate("$('#sqlSuggestions').getBoundingClientRect().bottom<=innerHeight"), true);
    win.webContents.focus();
    for (const type of ['keyDown', 'char', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Return' });
    await until("$('#sql').value.endsWith('WHERE `a`.`Name`')");
    assert.equal(await evaluate("document.activeElement===$('#sql')"), true);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control'] });
    await until("$('#sql').value.endsWith('WHERE ')");
    await evaluate("app.query.sql='SELECT * FROM Items a JOIN Items b ON a.Name=b.Name WHERE ';renderQueryView();$('#sql').setSelectionRange($('#sql').value.length,$('#sql').value.length);refreshSqlSuggestions($('#sql'),true)");
    assert.equal(calls.filter(call => call.name === 'db:columns').length, count + 2);
    assert.equal(await evaluate("sqlAutocomplete.items.some(item=>item.label==='b.Name')"), true);
    await evaluate("invalidateSqlAutocomplete();refreshSqlSuggestions($('#sql'),true)");
    assert.equal(calls.filter(call => call.name === 'db:columns').length, count + 3);
    assert.equal(await evaluate('sqlAutocomplete.columnCache.stats().entries'), 1);
    await evaluate("window.autocompleteSavedTarget={profileId:app.query.profileId,database:app.query.database,connections:app.connections};app.connections=[...app.connections,{id:'autocomplete-bound'}];app.query.profileId='autocomplete-bound';app.query.database='bound-db';refreshSqlSuggestions($('#sql'),true)");
    assert.deepEqual(calls.filter(call => call.name === 'db:columns').at(-1).args[0], { database: 'bound-db', table: 'Items', profileId: 'autocomplete-bound' });
    await evaluate("app.query.profileId=autocompleteSavedTarget.profileId;app.query.database=autocompleteSavedTarget.database;app.connections=autocompleteSavedTarget.connections;delete window.autocompleteSavedTarget;invalidateSqlAutocomplete()");
    await evaluate("closeSqlSuggestions();$('#sql').style.height='';app.query.sql='SELECT 1';renderQueryView()");
    win.setContentSize(1344, 835); autocompleteColumns = null;
  });
  await check('autocomplete isolates nested SELECT blocks and never fetches CTE/derived names as physical tables', async () => {
    autocompleteColumns = new Map([
      ['accounts', [{ name: 'outer_key', type: 'int' }]], ['invoices', [{ name: 'inner_key', type: 'int' }]],
      ['recent', [{ name: 'wrong_physical_key', type: 'int' }]]
    ]);
    await evaluate("invalidateSqlAutocomplete();window.autocompleteSavedTables=app.tables;app.tables=[...app.tables,{name:'recent',type:'table'}]");
    const queries = calls.filter(call => call.name === 'db:query').length;
    const set = async marked => {
      const caret = marked.indexOf('|'), sql = marked.replace('|', '');
      await evaluate(`app.query.sql=${JSON.stringify(sql)};renderQueryView();$('#sql').focus();$('#sql').setSelectionRange(${caret},${caret});refreshSqlSuggestions($('#sql'),true)`);
    };
    await set('SELECT * FROM accounts a WHERE EXISTS (SELECT 1 FROM invoices i WHERE i.id=a.id) AND |');
    assert.equal(calls.filter(call => call.name === 'db:columns').at(-1).args[0].table, 'accounts');
    assert.deepEqual(await evaluate('sqlAutocomplete.items.map(item=>item.label)'), ['outer_key']);
    const inner = 'SELECT * FROM accounts a WHERE EXISTS (SELECT 1 FROM invoices i WHERE | = a.id)';
    await set(inner);
    assert.equal(calls.filter(call => call.name === 'db:columns').at(-1).args[0].table, 'invoices');
    assert.deepEqual(await evaluate('sqlAutocomplete.items.map(item=>item.label)'), ['inner_key']);
    const count = calls.filter(call => call.name === 'db:columns').length;
    await set('WITH recent AS (SELECT * FROM invoices) SELECT * FROM recent r WHERE r.|');
    assert.equal(calls.filter(call => call.name === 'db:columns').length, count);
    assert.equal(await evaluate('sqlAutocomplete.items.length'), 0);
    await set('SELECT * FROM (SELECT * FROM invoices) r WHERE r.|');
    assert.equal(calls.filter(call => call.name === 'db:columns').length, count);
    assert.equal(await evaluate('sqlAutocomplete.items.length'), 0);
    await set('WITH recent AS (SELECT * FROM invoices) SELECT * FROM recent r JOIN accounts a ON a.id=r.id WHERE |');
    assert.deepEqual(await evaluate('sqlAutocomplete.items.map(item=>item.label)'), ['a.outer_key']);
    await set(inner);
    win.setContentSize(900, 650); win.webContents.focus();
    await evaluate("$('#sql').style.height='75px';$('#toast').style.display='none'");
    await captureReview('autocomplete-scope-small', () => evaluate("clearTimeout(sqlAutocomplete.blurTimer);$('#sql').focus();refreshSqlSuggestions($('#sql'),true)"));
    if (!process.env.SQLPRO_REVIEW_SCREENSHOT_DIR) {
      await new Promise(resolve => setTimeout(resolve, 150));
      await evaluate("clearTimeout(sqlAutocomplete.blurTimer);$('#sql').focus();refreshSqlSuggestions($('#sql'),true)");
    }
    assert.equal(await evaluate("$('#sqlSuggestions').classList.contains('hidden')"), false);
    assert.equal(await evaluate("$('#sqlSuggestions').getBoundingClientRect().bottom<=innerHeight"), true);
    for (const type of ['keyDown', 'char', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Return' });
    await until("$('#sql').value.includes('WHERE `inner_key` = a.id)')");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control'] });
    await until(`$('#sql').value===${JSON.stringify(inner.replace('|', ''))}`);
    assert.equal(calls.filter(call => call.name === 'db:query').length, queries);
    await evaluate("app.tables=autocompleteSavedTables;delete window.autocompleteSavedTables;invalidateSqlAutocomplete();app.query.sql='SELECT 1';renderQueryView()");
    win.setContentSize(1344, 835); autocompleteColumns = null;
  });
  await check('explicit CTE column suggestions stay local, escape names and support keyboard insertion and undo', async () => {
    autocompleteColumns = new Map([['recent', [{ name: 'wrong_physical_key', type: 'int' }]]]);
    await evaluate("invalidateSqlAutocomplete();window.cteSavedTables=app.tables;app.tables=[...app.tables,{name:'recent',type:'table'}]");
    const columns = calls.filter(call => call.name === 'db:columns').length;
    const queries = calls.filter(call => call.name === 'db:query').length;
    const set = async marked => {
      const caret = marked.indexOf('|'), sql = marked.replace('|', '');
      await evaluate(`app.query.sql=${JSON.stringify(sql)};renderQueryView();clearTimeout(sqlAutocomplete.blurTimer);$('#sql').focus();$('#sql').setSelectionRange(${caret},${caret});refreshSqlSuggestions($('#sql'),true)`);
    };
    await set('WITH recent(id, `tên cột`, `a``b`, `<img src=x onerror=alert(1)>`) AS (SELECT id,total,memo,extra FROM invoices) SELECT * FROM recent r WHERE r.|');
    assert.deepEqual(await evaluate('sqlAutocomplete.items.map(item=>item.label)'), ['r.id', 'r.tên cột', 'r.a`b', 'r.<img src=x onerror=alert(1)>']);
    assert.equal(await evaluate("$('#sqlSuggestions img')===null"), true);
    assert.equal(await evaluate("sqlAutocomplete.items.every(item=>item.detail==='CTE · recent · cột khai báo')"), true);
    await set('WITH RECURSIVE chain(id,parent_id) AS (SELECT * FROM chain c WHERE c.|) SELECT * FROM chain');
    assert.deepEqual(await evaluate('sqlAutocomplete.items.map(item=>item.label)'), ['c.id', 'c.parent_id']);
    await set('WITH recent(id) AS (SELECT 1) SELECT * FROM (WITH recent AS (SELECT 2) SELECT * FROM recent r WHERE r.|) d');
    assert.equal(await evaluate('sqlAutocomplete.items.length'), 0);
    const marked = 'WITH recent(id, `tên cột`) AS (SELECT id,total FROM invoices)\nSELECT * FROM recent r WHERE r.`tê|n khác`=1';
    win.setContentSize(900, 650); win.webContents.focus();
    await until('innerWidth===900 && innerHeight===650');
    await set(marked);
    await evaluate("$('#sql').style.height='130px';$('#toast').style.display='none'");
    await captureReview('autocomplete-cte-small', () => evaluate("clearTimeout(sqlAutocomplete.blurTimer);$('#sql').focus();refreshSqlSuggestions($('#sql'),true)"));
    assert.deepEqual(await evaluate('sqlAutocomplete.items.map(item=>item.label)'), ['r.tên cột']);
    assert.equal(await evaluate("$('#sqlSuggestions').getBoundingClientRect().bottom<=innerHeight"), true);
    for (const type of ['keyDown', 'char', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Return' });
    await until(`$('#sql').value===${JSON.stringify(marked.replace('tê|n khác', 'tên cột'))}`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control'] });
    await until(`$('#sql').value===${JSON.stringify(marked.replace('|', ''))} && $('#sql').selectionStart===${marked.indexOf('|')}`);
    assert.equal(calls.filter(call => call.name === 'db:columns').length, columns);
    assert.equal(calls.filter(call => call.name === 'db:query').length, queries);
    await evaluate("app.tables=cteSavedTables;delete window.cteSavedTables;invalidateSqlAutocomplete();app.query.sql='SELECT 1';renderQueryView()");
    win.setContentSize(1344, 835); autocompleteColumns = null;
  });
  await check('SELECT output names for CTE and derived sources need no metadata reads and support keyboard/undo', async () => {
    autocompleteColumns = new Map([['recent', [{ name: 'wrong_physical_key', type: 'int' }]], ['d', [{ name: 'wrong_derived_key', type: 'int' }]]]);
    await evaluate("invalidateSqlAutocomplete();window.projectionSavedTables=app.tables;app.tables=[...app.tables,{name:'recent',type:'table'},{name:'d',type:'table'}]");
    const columns = calls.filter(call => call.name === 'db:columns').length;
    const queries = calls.filter(call => call.name === 'db:query').length;
    const set = async marked => {
      const caret = marked.indexOf('|'), sql = marked.replace('|', '');
      await evaluate(`app.query.sql=${JSON.stringify(sql)};renderQueryView();clearTimeout(sqlAutocomplete.blurTimer);$('#sql').focus();$('#sql').setSelectionRange(${caret},${caret});refreshSqlSuggestions($('#sql'),true)`);
    };
    await set('WITH recent AS (SELECT i.id, COUNT(*) AS total, i.name AS `<img src=x onerror=alert(1)>` FROM invoices i) SELECT * FROM recent r WHERE r.|');
    assert.deepEqual(await evaluate('sqlAutocomplete.items.map(item=>item.label)'), ['r.id', 'r.total', 'r.<img src=x onerror=alert(1)>']);
    assert.equal(await evaluate("$('#sqlSuggestions img')===null"), true);
    assert.equal(await evaluate("sqlAutocomplete.items.every(item=>item.detail==='CTE · recent · tên từ SELECT')"), true);
    await set('SELECT * FROM (SELECT i.id AS item_id, COUNT(*) AS total FROM invoices i) d WHERE d.|');
    assert.deepEqual(await evaluate('sqlAutocomplete.items.map(item=>item.label)'), ['d.item_id', 'd.total']);
    assert.equal(await evaluate("sqlAutocomplete.items.every(item=>item.detail==='Derived · d · tên từ SELECT')"), true);
    for (const marked of [
      'WITH recent AS (SELECT i.id, i.* FROM invoices i) SELECT * FROM recent r WHERE r.|',
      'SELECT * FROM (SELECT i.id, i.id AS ID FROM invoices i) d WHERE d.|'
    ]) { await set(marked); assert.equal(await evaluate('sqlAutocomplete.items.length'), 0); }
    const marked = 'WITH recent AS (SELECT i.id AS item_id, COUNT(*) AS `tổng` FROM invoices i)\nSELECT * FROM recent r WHERE r.`tổ|ng cũ`>0';
    win.setContentSize(900, 650); win.webContents.focus();
    await until('innerWidth===900 && innerHeight===650');
    await set(marked);
    await evaluate("$('#sql').style.height='150px';$('#toast').style.display='none'");
    await captureReview('autocomplete-projection-small', () => evaluate("clearTimeout(sqlAutocomplete.blurTimer);$('#sql').focus();refreshSqlSuggestions($('#sql'),true)"));
    assert.deepEqual(await evaluate('sqlAutocomplete.items.map(item=>item.label)'), ['r.tổng']);
    assert.equal(await evaluate("$('#sqlSuggestions').getBoundingClientRect().bottom<=innerHeight"), true);
    for (const type of ['keyDown', 'char', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Return' });
    await until(`$('#sql').value===${JSON.stringify(marked.replace('tổ|ng cũ', 'tổng'))}`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control'] });
    await until(`$('#sql').value===${JSON.stringify(marked.replace('|', ''))} && $('#sql').selectionStart===${marked.indexOf('|')}`);
    assert.equal(calls.filter(call => call.name === 'db:columns').length, columns);
    assert.equal(calls.filter(call => call.name === 'db:query').length, queries);
    await evaluate("app.tables=projectionSavedTables;delete window.projectionSavedTables;invalidateSqlAutocomplete();app.query.sql='SELECT 1';renderQueryView()");
    win.setContentSize(1344, 835); autocompleteColumns = null;
  });
  await check('implicit SELECT aliases stay local, escape names and preserve keyboard insertion/undo', async () => {
    autocompleteColumns = new Map([['recent', [{ name: 'wrong_physical_key', type: 'int' }]], ['d', [{ name: 'wrong_derived_key', type: 'int' }]]]);
    await evaluate("invalidateSqlAutocomplete();window.implicitSavedTables=app.tables;app.tables=[...app.tables,{name:'recent',type:'table'},{name:'d',type:'table'}]");
    const columns = calls.filter(call => call.name === 'db:columns').length;
    const queries = calls.filter(call => call.name === 'db:query').length;
    const set = async marked => {
      const caret = marked.indexOf('|'), sql = marked.replace('|', '');
      await evaluate(`app.query.sql=${JSON.stringify(sql)};renderQueryView();clearTimeout(sqlAutocomplete.blurTimer);$('#sql').focus();$('#sql').setSelectionRange(${caret},${caret});refreshSqlSuggestions($('#sql'),true)`);
    };
    await set('WITH recent AS (SELECT i.id item_id, COUNT(*) total, i.name `<img src=x onerror=alert(1)>` FROM invoices i) SELECT * FROM recent r WHERE r.|');
    assert.deepEqual(await evaluate('sqlAutocomplete.items.map(item=>item.label)'), ['r.item_id', 'r.total', 'r.<img src=x onerror=alert(1)>']);
    assert.equal(await evaluate("$('#sqlSuggestions img')===null"), true);
    await set('SELECT * FROM (SELECT i.id item_id, COUNT(*) total FROM invoices i) d WHERE d.|');
    assert.deepEqual(await evaluate('sqlAutocomplete.items.map(item=>item.label)'), ['d.item_id', 'd.total']);
    assert.equal(await evaluate("sqlAutocomplete.items.every(item=>item.detail==='Derived · d · tên từ SELECT')"), true);
    await set('SELECT * FROM (SELECT i.id COLLATE FROM invoices i) d WHERE d.|');
    assert.equal(await evaluate('sqlAutocomplete.items.length'), 0);
    const marked = 'WITH recent AS (SELECT i.id item_id, COUNT(*) `tổng` FROM invoices i)\nSELECT * FROM recent r WHERE r.`tổ|ng cũ`>0';
    win.setContentSize(900, 650); win.webContents.focus();
    await until('innerWidth===900 && innerHeight===650');
    await set(marked);
    await evaluate("$('#sql').style.height='150px';$('#toast').style.display='none'");
    await captureReview('autocomplete-implicit-small', () => evaluate("clearTimeout(sqlAutocomplete.blurTimer);$('#sql').focus();refreshSqlSuggestions($('#sql'),true)"));
    assert.deepEqual(await evaluate('sqlAutocomplete.items.map(item=>item.label)'), ['r.tổng']);
    assert.equal(await evaluate("$('#sqlSuggestions').getBoundingClientRect().bottom<=innerHeight"), true);
    for (const type of ['keyDown', 'char', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Return' });
    await until(`$('#sql').value===${JSON.stringify(marked.replace('tổ|ng cũ', 'tổng'))}`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control'] });
    await until(`$('#sql').value===${JSON.stringify(marked.replace('|', ''))} && $('#sql').selectionStart===${marked.indexOf('|')}`);
    assert.equal(calls.filter(call => call.name === 'db:columns').length, columns);
    assert.equal(calls.filter(call => call.name === 'db:query').length, queries);
    await evaluate("app.tables=implicitSavedTables;delete window.implicitSavedTables;invalidateSqlAutocomplete();app.query.sql='SELECT 1';renderQueryView()");
    win.setContentSize(1344, 835); autocompleteColumns = null;
  });
  await check('set output suggestions use first-arm names with no metadata reads and preserve keyboard/undo', async () => {
    autocompleteColumns = new Map([['recent', [{ name: 'wrong_physical_key', type: 'int' }]], ['d', [{ name: 'wrong_derived_key', type: 'int' }]]]);
    await evaluate("invalidateSqlAutocomplete();window.setOutputSavedTables=app.tables;app.tables=[...app.tables,{name:'recent',type:'table'},{name:'d',type:'table'}]");
    const columns = calls.filter(call => call.name === 'db:columns').length;
    const queries = calls.filter(call => call.name === 'db:query').length;
    const set = async marked => {
      const caret = marked.indexOf('|'), sql = marked.replace('|', '');
      await evaluate(`app.query.sql=${JSON.stringify(sql)};renderQueryView();clearTimeout(sqlAutocomplete.blurTimer);$('#sql').focus();$('#sql').setSelectionRange(${caret},${caret});refreshSqlSuggestions($('#sql'),true)`);
    };
    for (const operator of ['UNION ALL', 'INTERSECT', 'EXCEPT']) {
      await set(`WITH recent AS (SELECT id AS item_id FROM invoices ${operator} SELECT id AS ignored FROM archive) SELECT * FROM recent r WHERE r.|`);
      assert.deepEqual(await evaluate('sqlAutocomplete.items.map(item=>item.label)'), ['r.item_id']);
    }
    for (const body of ['SELECT id FROM invoices UNION SELECT * FROM archive', 'SELECT id FROM invoices UNION SELECT id,name FROM archive']) {
      await set(`WITH recent AS (${body}) SELECT * FROM recent r WHERE r.|`);
      assert.equal(await evaluate('sqlAutocomplete.items.length'), 0);
    }
    const marked = 'SELECT * FROM (SELECT i.id AS `mã` FROM invoices i\nUNION ALL SELECT a.id AS ignored FROM archive a) d\nWHERE d.`m|ã cũ`>0';
    win.setContentSize(900, 650); win.webContents.focus();
    await until('innerWidth===900 && innerHeight===650');
    await set(marked);
    await evaluate("$('#sql').style.height='180px';$('#toast').style.display='none'");
    await captureReview('autocomplete-set-output-small', () => evaluate("clearTimeout(sqlAutocomplete.blurTimer);$('#sql').focus();refreshSqlSuggestions($('#sql'),true)"));
    assert.deepEqual(await evaluate('sqlAutocomplete.items.map(item=>item.label)'), ['d.mã']);
    assert.equal(await evaluate("sqlAutocomplete.items[0].detail==='Derived · d · tên từ SELECT'"), true);
    assert.equal(await evaluate("$('#sqlSuggestions').getBoundingClientRect().bottom<=innerHeight"), true);
    for (const type of ['keyDown', 'char', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Return' });
    await until(`$('#sql').value===${JSON.stringify(marked.replace('m|ã cũ', 'mã'))}`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control'] });
    await until(`$('#sql').value===${JSON.stringify(marked.replace('|', ''))} && $('#sql').selectionStart===${marked.indexOf('|')}`);
    assert.equal(calls.filter(call => call.name === 'db:columns').length, columns);
    assert.equal(calls.filter(call => call.name === 'db:query').length, queries);
    await evaluate("app.tables=setOutputSavedTables;delete window.setOutputSavedTables;invalidateSqlAutocomplete();app.query.sql='SELECT 1';renderQueryView()");
    win.setContentSize(1344, 835); autocompleteColumns = null;
  });
  await check('local star output stays inside CTE/derived names without metadata and preserves keyboard/undo', async () => {
    autocompleteColumns = new Map([['source', [{ name: 'wrong_source_key', type: 'int' }]], ['recent', [{ name: 'wrong_recent_key', type: 'int' }]], ['d', [{ name: 'wrong_derived_key', type: 'int' }]]]);
    await evaluate("invalidateSqlAutocomplete();window.localStarSavedTables=app.tables;app.tables=[...app.tables,{name:'source',type:'table'},{name:'recent',type:'table'},{name:'d',type:'table'}]");
    const columns = calls.filter(call => call.name === 'db:columns').length;
    const queries = calls.filter(call => call.name === 'db:query').length;
    const set = async marked => {
      const caret = marked.indexOf('|'), sql = marked.replace('|', '');
      await evaluate(`app.query.sql=${JSON.stringify(sql)};renderQueryView();clearTimeout(sqlAutocomplete.blurTimer);$('#sql').focus();$('#sql').setSelectionRange(${caret},${caret});refreshSqlSuggestions($('#sql'),true)`);
    };
    await set('WITH source(id, `<img src=x onerror=alert(1)>`) AS (SELECT * FROM invoices), recent AS (SELECT s.* FROM source s) SELECT * FROM recent r WHERE r.|');
    assert.deepEqual(await evaluate('sqlAutocomplete.items.map(item=>item.label)'), ['r.id', 'r.<img src=x onerror=alert(1)>']);
    assert.equal(await evaluate("$('#sqlSuggestions img')===null"), true);
    await set('SELECT * FROM (SELECT x.* FROM (SELECT id item_id FROM invoices) x) d WHERE d.|');
    assert.deepEqual(await evaluate('sqlAutocomplete.items.map(item=>item.label)'), ['d.item_id']);
    assert.equal(await evaluate("sqlAutocomplete.items[0].detail==='Derived · d · tên từ SELECT'"), true);
    for (const marked of [
      'WITH c AS (SELECT * FROM c) SELECT * FROM c WHERE c.|',
      'SELECT * FROM (SELECT * FROM invoices) d WHERE d.|',
      'WITH c(id) AS (SELECT 1) SELECT * FROM (SELECT c.* FROM c JOIN invoices i ON 1=1) d WHERE d.|'
    ]) { await set(marked); assert.equal(await evaluate('sqlAutocomplete.items.length'), 0); }
    const marked = 'WITH source(id, `tên cột`) AS (SELECT id,name FROM invoices),\nrecent AS (SELECT s.* FROM source s)\nSELECT * FROM recent r WHERE r.`tê|n cũ`=1';
    win.setContentSize(900, 650); win.webContents.focus();
    await until('innerWidth===900 && innerHeight===650');
    await set(marked);
    await evaluate("$('#sql').style.height='180px';$('#toast').style.display='none'");
    await captureReview('autocomplete-local-star-small', () => evaluate("clearTimeout(sqlAutocomplete.blurTimer);$('#sql').focus();refreshSqlSuggestions($('#sql'),true)"));
    assert.deepEqual(await evaluate('sqlAutocomplete.items.map(item=>item.label)'), ['r.tên cột']);
    assert.equal(await evaluate("sqlAutocomplete.items[0].detail==='CTE · recent · tên từ SELECT'"), true);
    assert.equal(await evaluate("$('#sqlSuggestions').getBoundingClientRect().bottom<=innerHeight"), true);
    for (const type of ['keyDown', 'char', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Return' });
    await until(`$('#sql').value===${JSON.stringify(marked.replace('tê|n cũ', 'tên cột'))}`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control'] });
    await until(`$('#sql').value===${JSON.stringify(marked.replace('|', ''))} && $('#sql').selectionStart===${marked.indexOf('|')}`);
    assert.equal(calls.filter(call => call.name === 'db:columns').length, columns);
    assert.equal(calls.filter(call => call.name === 'db:query').length, queries);
    await evaluate("app.tables=localStarSavedTables;delete window.localStarSavedTables;invalidateSqlAutocomplete();app.query.sql='SELECT 1';renderQueryView()");
    win.setContentSize(1344, 835); autocompleteColumns = null;
  });
  await check('qualified local join stars preserve owner and keyboard editing without reading source metadata', async () => {
    autocompleteColumns = new Map([['source', [{ name: 'wrong_source', type: 'int' }]], ['recent', [{ name: 'wrong_recent', type: 'int' }]]]);
    await evaluate("invalidateSqlAutocomplete();window.joinStarSavedTables=app.tables;app.tables=[...app.tables,{name:'source',type:'table'},{name:'recent',type:'table'}]");
    const columns = calls.filter(call => call.name === 'db:columns').length;
    const queries = calls.filter(call => call.name === 'db:query').length;
    const set = async marked => {
      const caret = marked.indexOf('|');
      await evaluate(`app.query.sql=${JSON.stringify(marked.replace('|', ''))};renderQueryView();clearTimeout(sqlAutocomplete.blurTimer);$('#sql').focus();$('#sql').setSelectionRange(${caret},${caret});refreshSqlSuggestions($('#sql'),true)`);
    };
    await set('WITH source(id) AS (SELECT * FROM invoices), recent AS (SELECT y.* FROM source x LEFT JOIN (SELECT 1 AS `<img src=x onerror=alert(1)>`) y ON x.id=1) SELECT * FROM recent r WHERE r.|');
    assert.deepEqual(await evaluate('sqlAutocomplete.items.map(item=>item.label)'), ['r.<img src=x onerror=alert(1)>']);
    assert.equal(await evaluate("$('#sqlSuggestions img')===null"), true);
    await set('WITH source(id) AS (SELECT 1) SELECT * FROM (SELECT b.* FROM source a, (SELECT 2 AS other_id) b) d WHERE d.|');
    assert.deepEqual(await evaluate('sqlAutocomplete.items.map(item=>item.label)'), ['d.other_id']);
    for (const projection of ['* FROM source a JOIN source b ON 1=1', 'a.* FROM source a JOIN source A ON 1=1', 'a.* FROM source a JOIN source b USING(id)', 'a.* FROM source a LEFT JOIN source b']) {
      await set(`WITH source(id) AS (SELECT 1), recent AS (SELECT ${projection}) SELECT * FROM recent r WHERE r.|`);
      assert.equal(await evaluate('sqlAutocomplete.items.length'), 0);
    }
    const marked = 'WITH source(id) AS (SELECT id FROM invoices),\nrecent AS (SELECT y.* FROM source x\nLEFT JOIN (SELECT 1 AS `tên cột`) y ON x.id=1)\nSELECT * FROM recent r WHERE r.`tê|n cũ`=1';
    win.setContentSize(900, 650); win.webContents.focus();
    await until('innerWidth===900 && innerHeight===650');
    await set(marked);
    await evaluate("$('#sql').style.height='180px';$('#toast').style.display='none'");
    await captureReview('autocomplete-local-join-star-small', () => evaluate("clearTimeout(sqlAutocomplete.blurTimer);$('#sql').focus();refreshSqlSuggestions($('#sql'),true)"));
    assert.deepEqual(await evaluate('sqlAutocomplete.items.map(item=>item.label)'), ['r.tên cột']);
    assert.equal(await evaluate("sqlAutocomplete.items[0].detail==='CTE · recent · tên từ SELECT'"), true);
    assert.equal(await evaluate("$('#sqlSuggestions').getBoundingClientRect().bottom<=innerHeight"), true);
    for (const type of ['keyDown', 'char', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Return' });
    await until(`$('#sql').value===${JSON.stringify(marked.replace('tê|n cũ', 'tên cột'))}`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control'] });
    await until(`$('#sql').value===${JSON.stringify(marked.replace('|', ''))} && $('#sql').selectionStart===${marked.indexOf('|')}`);
    assert.equal(calls.filter(call => call.name === 'db:columns').length, columns);
    assert.equal(calls.filter(call => call.name === 'db:query').length, queries);
    await evaluate("app.tables=joinStarSavedTables;delete window.joinStarSavedTables;invalidateSqlAutocomplete();app.query.sql='SELECT 1';renderQueryView()");
    win.setContentSize(1344, 835); autocompleteColumns = null;
  });
  await check('autocomplete replaces complete tokens at the caret, supports undo and ignores stale suggestions', async () => {
    autocompleteColumns = new Map([['users', [{ name: 'name', type: 'text' }]]]);
    await evaluate('invalidateSqlAutocomplete()');
    const queries = calls.filter(call => call.name === 'db:query').length;
    const markedSql = [
      'SELECT 1; SELECT * FROM users u WHERE u.na|me=1; SELECT 2',
      'SELECT 1; SELECT * FROM users u WHERE u.`na|mx`=1; SELECT 2',
      'SELECT 1; SELECT * FROM users u WHERE u.|`namx`=1; SELECT 2'
    ];
    win.setContentSize(900, 650); win.webContents.focus();
    await until('innerWidth===900 && innerHeight===650');
    for (const [index, marked] of markedSql.entries()) {
      const caret = marked.indexOf('|'), sql = marked.replace('|', '');
      await evaluate(`app.query.sql=${JSON.stringify(sql)};renderQueryView();$('#sql').style.height='75px';$('#sql').focus();$('#sql').setSelectionRange(${caret},${caret});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(sqlAutocomplete.blurTimer);resolve(refreshSqlSuggestions($('#sql'),true))})))`);
      assert.deepEqual(await evaluate('sqlAutocomplete.items.map(item=>item.label)'), ['u.name']);
      if (index === 1) await captureReview('autocomplete-range-small', () => evaluate("clearTimeout(sqlAutocomplete.blurTimer);$('#sql').focus();refreshSqlSuggestions($('#sql'),true)"));
      assert.equal(await evaluate("$('#sqlSuggestions').getBoundingClientRect().bottom<=innerHeight"), true);
      for (const type of ['keyDown', 'char', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Return' });
      await until("$('#sql').value==='SELECT 1; SELECT * FROM users u WHERE u.`name`=1; SELECT 2'");
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['control'] });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control'] });
      await until(`$('#sql').value===${JSON.stringify(sql)}`);
      assert.deepEqual(await evaluate("[$('#sql').selectionStart,$('#sql').selectionEnd]"), [caret, caret], marked);
    }
    await evaluate("clearTimeout(sqlAutocomplete.blurTimer);refreshSqlSuggestions($('#sql'),true)");
    assert.equal(await evaluate('sqlAutocomplete.items.length'), 1);
    await evaluate("$('#sql').setSelectionRange(0,0);acceptSqlSuggestion($('#sql'),0)");
    assert.equal(await evaluate("$('#sql').value"), markedSql.at(-1).replace('|', ''));
    await evaluate(`$('#sql').setSelectionRange(${markedSql.at(-1).indexOf('|')},${markedSql.at(-1).indexOf('|')});refreshSqlSuggestions($('#sql'),true)`);
    assert.equal(await evaluate('sqlAutocomplete.items.length'), 1);
    await evaluate("{const database=app.query.database;app.query.database='changed-autocomplete-target';try{acceptSqlSuggestion($('#sql'),0)}finally{app.query.database=database}}");
    assert.equal(await evaluate('sqlAutocomplete.context'), null);
    assert.equal(await evaluate("$('#sql').value"), markedSql.at(-1).replace('|', ''));
    assert.equal(calls.filter(call => call.name === 'db:query').length, queries);
    await evaluate("invalidateSqlAutocomplete();app.query.sql='SELECT 1';renderQueryView()");
    win.setContentSize(1344, 835); autocompleteColumns = null;
  });
  await check('review regressions preserve function arguments and block ambiguous qualified owners', async () => {
    win.webContents.focus();
    autocompleteColumns = new Map([['accounts', [{ name: 'good_key', type: 'int' }]]]);
    await evaluate('invalidateSqlAutocomplete()');
    const columns = calls.filter(call => call.name === 'db:columns').length;
    const queries = calls.filter(call => call.name === 'db:query').length;
    const set = async marked => {
      const caret = marked.indexOf('|'), sql = marked.replace('|', '');
      await evaluate(`app.query.sql=${JSON.stringify(sql)};renderQueryView();$('#sql').focus();$('#sql').setSelectionRange(${caret},${caret});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(sqlAutocomplete.blurTimer);resolve(refreshSqlSuggestions($('#sql'),true))})))`);
    };
    await set('SELECT * FROM accounts x JOIN x ON 1=1 WHERE x.|');
    assert.equal(await evaluate('sqlAutocomplete.items.length'), 0);
    await set('WITH c(id) AS (SELECT 1) SELECT * FROM c accounts JOIN accounts ON 1=1 WHERE accounts.|');
    assert.equal(await evaluate('sqlAutocomplete.items.length'), 0);
    assert.equal(calls.filter(call => call.name === 'db:columns').length, columns);
    const marked = 'SELECT COU|NTA(id) FROM users';
    await set(marked);
    await evaluate("setSqlSuggestionSelection(sqlAutocomplete.items.findIndex(item=>item.type==='function' && item.insertText==='COUNT()'))");
    assert.equal(await evaluate('sqlAutocomplete.items[sqlAutocomplete.selected].insertText'), 'COUNT()');
    win.webContents.focus();
    for (const type of ['keyDown', 'char', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Return' });
    await until("$('#sql').value==='SELECT COUNT(id) FROM users' && $('#sql').selectionStart===13");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control'] });
    await until(`$('#sql').value===${JSON.stringify(marked.replace('|', ''))} && $('#sql').selectionStart===${marked.indexOf('|')}`);
    assert.equal(calls.filter(call => call.name === 'db:query').length, queries);
    await evaluate("invalidateSqlAutocomplete();app.query.sql='SELECT 1';renderQueryView()");
    autocompleteColumns = null;
  });
  await check('selected SQL and success/failure history contain strings', async () => {
    await evaluate("$('#sql').value='select 1; select 2;'; $('#sql').setSelectionRange(10,19); runQuery()");
    assert.equal(calls.filter((call) => call.name === 'db:query').at(-1).args[0].sql, 'select 2;');
    assert.equal(await evaluate("historyRows[0].sql"), 'select 2;');
    await evaluate("$('#sql').value='SELECT FAIL_TEST'; $('#sql').setSelectionRange(0,0); runQuery()");
    assert.equal(await evaluate('app.query.error'), 'Expected SQL failure');
    assert.equal(await evaluate('historyRows[0].ok'), false);
    assert.equal(await evaluate('typeof historyRows[0].sql'), 'string');
  });
  await check('query confirmation executes only after acceptance', async () => {
    await evaluate("$('#sql').value=\"UPDATE users SET name='x'\"; $('#sql').setSelectionRange(0,0)");
    await confirmPending('runQuery()');
    assert.equal(calls.filter((call) => call.name === 'db:query').at(-1).args[0].confirmed, true);
    const count = calls.filter((call) => call.name === 'db:query').length;
    await confirmPending('runQuery()', false);
    assert.equal(calls.filter((call) => call.name === 'db:query').length, count + 1);
  });
  await check('EXPLAIN button uses the active statement and displays its result', async () => {
    await evaluate("$('#sql').value='SELECT 1; SELECT * FROM users'; $('#sql').setSelectionRange(15,15); $('#explainQueryBtn').click()");
    await until('app.query.result?.isExplain && !app.query.running');
    assert.equal(calls.filter((call) => call.name === 'db:query').at(-1).args[0].sql, 'EXPLAIN SELECT * FROM users');
    assert.equal(await evaluate("Boolean($('#queryResult .explain-badge.warn'))"), true);
    assert.equal(await evaluate("$('#queryResult').textContent.includes('Cần đánh thêm Index')"), false);
    assert.equal(await evaluate("$('#toast').textContent.includes('Nên thêm Index')"), false);
    assert.equal(await evaluate("$('#queryResult .explain-review:not(.explain-comparison)').textContent.includes('Ước lượng')"), true);
    const count = calls.filter((call) => call.name === 'db:query').length;
    await evaluate("$('#sql').select(); runExplainQuery()");
    assert.equal(calls.filter((call) => call.name === 'db:query').length, count);
  });
  await check('result sorting is reversible and does not mutate source rows', async () => {
    await evaluate("app.query.result={kind:'rows', columns:[{name:'n',type:'INT'}], rows:[[3],[1],[2]],durationMs:1}; $('#queryResult').innerHTML=queryResultHtml(); $('#queryResult th[data-query-sort]').click()");
    assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('#queryResult tbody tr'), row=>row.cells[1].textContent)"), ['1', '2', '3']);
    assert.deepEqual(await evaluate('app.query.result.rows'), [[3], [1], [2]]);
    await evaluate("$('#queryResult th[data-query-sort]').click(); $('#queryResult th[data-query-sort]').click()");
    assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('#queryResult tbody tr'), row=>row.cells[1].textContent)"), ['3', '1', '2']);
  });
  await check('duplicate EXPLAIN values use their own column metadata', async () => {
    assert.equal(await evaluate("(singleQueryResultHtml({kind:'rows',isExplain:true,columns:[{name:'table'},{name:'type'}],rows:[['ALL','ALL']],durationMs:1}).match(/explain-badge warn/g)||[]).length"), 1);
  });
  await check('EXPLAIN explanations support keyboard, escaped labels and small dark windows without extra queries', async () => {
    const count = calls.filter(call => call.name === 'db:query').length;
    await evaluate(`app.query.result={kind:'rows',isExplain:true,durationMs:1,
      columns:['table','type','key','rows','filtered','Extra'].map(name=>({name,type:'TEXT'})),
      rows:[['<img src=x onerror=alert(1)>','ALL',null,'5','80.5','Using filesort; Using temporary'],
        ['items','ref','idx_parent',1200,5,'Using index']]};
      $('#queryResult').innerHTML=queryResultHtml(); $('#queryResult .explain-review summary').focus()`);
    win.webContents.focus();
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until("$('#queryResult .explain-review details').open");
    assert.equal(await evaluate("$('#queryResult .explain-review').textContent.includes('<img src=x')"), true);
    assert.equal(await evaluate("$('#queryResult .explain-review img')===null"), true);
    assert.equal(await evaluate("$('#queryResult .explain-badge.good')===null"), true);
    assert.equal(await evaluate("$('#queryResult .explain-extra-warn').title.includes('chưa chứng minh')"), true);
    await evaluate("$('#toast').style.display='none'");
    await captureReview('explain-context');
    win.setContentSize(900, 650);
    await evaluate("document.body.classList.add('dark-theme'); document.body.classList.remove('light-theme')");
    await captureReview('explain-context-small-dark');
    const layout = await evaluate(`(()=>{ const box=$('#queryResult .explain-review');
      const table=box.querySelector('.explain-review-table');
      const bounds=box.getBoundingClientRect(), container=$('#queryResult').getBoundingClientRect();
      return {fits:bounds.right<=innerWidth && bounds.bottom<=container.bottom+1,bounds:bounds.toJSON(),container:container.toJSON(),scrolls:table.scrollWidth>table.clientWidth,
        vertical:box.scrollHeight>box.clientHeight && getComputedStyle(box).overflowY==='auto',
        keyboard:document.activeElement===box.querySelector('summary')}; })()`);
    assert.equal(layout.fits, true, JSON.stringify(layout)); assert.equal(layout.scrolls, true, JSON.stringify(layout));
    assert.equal(layout.vertical, true, JSON.stringify(layout)); assert.equal(layout.keyboard, true, JSON.stringify(layout));
    assert.equal(calls.filter(call => call.name === 'db:query').length, count);
    await evaluate("document.body.classList.remove('dark-theme'); document.body.classList.add('light-theme')");
    await captureReview('explain-context-small-light');
    win.setContentSize(1344, 835);
  });
  await check('EXPLAIN JSON/TREE selector preserves native text, rejects ANALYZE and never retries unsupported formats', async () => {
    await evaluate("$('#sql').value='SELECT * FROM users';$('#sql').setSelectionRange(0,0);$('#explainFormat').value='JSON';$('#explainFormat').dispatchEvent(new Event('change'));runExplainQuery()");
    await until("!app.query.running && Boolean($('#queryResult .explain-document'))");
    assert.equal(calls.filter(call => call.name === 'db:query').at(-1).args[0].sql, 'EXPLAIN FORMAT=JSON SELECT * FROM users');
    assert.equal(await evaluate("$('#queryResult .explain-document pre').textContent.includes('90071992547409931234')"), true);
    assert.equal(await evaluate("$('#queryResult .explain-document img')===null"), true);
    await evaluate("$('#queryResult .explain-document summary').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until("$('#queryResult .explain-document details').open");
    win.setContentSize(900, 650);
    await evaluate("$('#sql').style.height='75px';$('#queryResult .explain-document pre').focus();$('#toast').style.display='none'");
    await captureReview('explain-json-small');
    assert.equal(await evaluate("document.activeElement.matches('.explain-document pre')"), true);
    assert.equal(await evaluate("$('#queryResult .explain-document').getBoundingClientRect().right<=innerWidth"), true);
    await evaluate("renderQueryView()");
    assert.equal(await evaluate("$('#explainFormat').value"), 'JSON');
    await evaluate("$('#explainFormat').value='TREE';$('#explainFormat').dispatchEvent(new Event('change'));runExplainQuery()");
    await until("!app.query.running && Boolean($('#queryResult .explain-document'))");
    assert.equal(await evaluate("$('#queryResult .explain-document pre').textContent.startsWith('-> Table scan')"), true);
    explainTreeUnsupported = true;
    let count = calls.filter(call => call.name === 'db:query').length;
    await evaluate('runExplainQuery()');
    assert.equal(calls.filter(call => call.name === 'db:query').length, count + 1);
    assert.match(await evaluate("$('#queryResult .errorbox').textContent"), /không hỗ trợ TREE/);
    assert.equal(await evaluate("$('#explainFormat').value"), 'TREE');
    count += 1;
    await evaluate("$('#sql').value='EXPLAIN ANALYZE SELECT * FROM users';runExplainQuery()");
    assert.equal(calls.filter(call => call.name === 'db:query').length, count);
    assert.match(await evaluate("$('#toast').textContent"), /ANALYZE thực thi/);
    explainTreeUnsupported = false;
    await evaluate("$('#sql').value='SELECT * FROM users';$('#sql').setSelectionRange(0,0);$('#explainFormat').value='DEFAULT';$('#explainFormat').dispatchEvent(new Event('change'));runExplainQuery()");
    win.setContentSize(1344, 835);
  });
  await check('ANALYZE named action preserves cancel output, opens native plan with keyboard and exports cached results without replay', async () => {
    await evaluate("app.query.sql='SELECT * FROM users';$('#sql').value=app.query.sql;$('#sql').setSelectionRange(0,0)");
    const prior = await evaluate('app.query.result');
    delete prior.explainComparison;
    analyzeCanceled = true;
    await evaluate("$('#analyzeQueryBtn').click()"); await until('!app.query.running');
    assert.deepEqual(await evaluate('app.query.result'), prior);
    analyzeCanceled = false;
    const queries = calls.filter(call => call.name === 'db:query' || call.name === 'db:export-query').length;
    await evaluate("$('#analyzeQueryBtn').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until("!app.query.running && Boolean($('#queryResult .analyze-review'))");
    assert.equal(calls.filter(call => call.name === 'db:analyze-query').at(-1).args[0].sql, 'SELECT * FROM users');
    assert.equal(await evaluate("$('#queryResult .analyze-review img')===null"), true);
    assert.equal(await evaluate("$('#queryResult .explain-comparison')===null"), true);
    await evaluate("$('#queryResult .analyze-review summary').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until("$('#queryResult .analyze-review details').open");
    win.setContentSize(900, 650);
    await evaluate("$('#sql').style.height='75px';$('#toast').style.display='none';$('#queryResult .analyze-review').scrollTop=0");
    await captureReview('analyze-summary-small');
    await evaluate("$('#queryResult .analyze-review pre').focus()");
    assert.equal(await evaluate("document.activeElement.matches('.analyze-review pre')"), true);
    assert.equal(await evaluate("$('#queryResult .analyze-review').getBoundingClientRect().right<=innerWidth"), true);
    await captureReview('analyze-native-small');
    await evaluate("exportCurrentResult('json')");
    assert.equal(calls.filter(call => call.name === 'db:query' || call.name === 'db:export-query').length, queries);
    const saved = calls.filter(call => call.name === 'file:save-text').at(-1).args[0];
    assert.equal(JSON.parse(saved.contents)[0].ANALYZE.includes('r_rows'), true);
    win.setContentSize(1344, 835);
    await evaluate("$('#sql').style.height='';runExplainQuery()");
    await until('!app.query.running');
  });
  await check('EXPLAIN compares consecutive plans with bounded details, keyboard and reconnect/scope resets', async () => {
    await evaluate("$('#sql').value='SELECT * FROM users';$('#sql').setSelectionRange(0,0)");
    const run = async () => {
      await evaluate('runExplainQuery()');
      await until("!app.query.running && Boolean($('#queryResult .explain-comparison'))");
    };
    const status = () => evaluate('app.query.result.explainComparison.status');
    await evaluate('resetExplainComparisons()'); await run(); assert.equal(await status(), 'baseline');
    await run(); assert.equal(await status(), 'unchanged');
    explainAccessMethod = 'ref'; await run(); assert.equal(await status(), 'changed');
    await evaluate("$('#queryResult .explain-comparison summary').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until("$('#queryResult .explain-comparison details').open");
    assert.match(await evaluate("$('#queryResult .explain-comparison').textContent"), /ALL.*ref/);
    assert.match(await evaluate("$('#queryResult .explain-comparison').textContent"), /Không xác nhận schema/);
    win.setContentSize(900, 650);
    await evaluate("$('#sql').style.height='75px';$('#toast').style.display='none'");
    await captureReview('explain-comparison-small');
    assert.equal(await evaluate("$('#queryResult .explain-comparison').getBoundingClientRect().right<=innerWidth"), true);
    await evaluate("$('#queryResult .explain-comparison .explain-review-table').focus();$('#queryResult .explain-comparison .explain-review-table').scrollIntoView({block:'nearest'})");
    assert.equal(await evaluate("document.activeElement.getAttribute('aria-label')"), 'Các bước plan thay đổi');
    await captureReview('explain-comparison-steps-small');
    await run(); assert.equal(await status(), 'unchanged');
    explainSessionId = 'smoke-reconnected'; await run(); assert.equal(await status(), 'different-scope');
    await evaluate("$('#sql').value='SELECT * FROM users WHERE id=2';$('#sql').setSelectionRange(0,0)");
    await run(); assert.equal(await status(), 'different-scope');
    await evaluate("$('#explainFormat').value='JSON';$('#explainFormat').dispatchEvent(new Event('change'))");
    await run(); assert.equal(await status(), 'different-scope');
    await run(); assert.equal(await status(), 'unchanged');
    explainAccessMethod = 'ALL';
    await evaluate("$('#explainFormat').value='DEFAULT';$('#explainFormat').dispatchEvent(new Event('change'));resetExplainComparisons()");
    win.setContentSize(1344, 835);
  });
  await check('EXPLAIN settings opt-in supports keyboard, blocks comparisons after drift/missing evidence and fits small windows', async () => {
    assert.equal(await evaluate("$('#explainSettings').checked"), false);
    await evaluate("$('#explainSettings').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    await until("$('#explainSettings').checked");
    const run = async () => { await evaluate('runExplainQuery()'); await until('!app.query.running'); };
    await run(); assert.equal(await evaluate('app.query.result.explainComparison.status'), 'baseline');
    assert.equal(calls.filter(call => call.name === 'db:query').at(-1).args[0].explainSettings, true);
    await run(); assert.equal(await evaluate('app.query.result.explainComparison.status'), 'unchanged');
    explainSettingsDigest = 'b'; await run();
    assert.equal(await evaluate('app.query.result.explainComparison.status'), 'settings-changed');
    await evaluate("$('#queryResult .explain-comparison summary').focus()");
    for (const type of ['keyDown', 'char', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Return' });
    await until("$('#queryResult .explain-comparison details').open");
    assert.match(await evaluate("$('#queryResult .explain-comparison').textContent"), /time_zone/);
    assert.equal(await evaluate("$('#queryResult .explain-comparison .explain-review-table')===null"), true);
    await evaluate("$('#queryResult .explain-settings-review summary').focus()");
    for (const type of ['keyDown', 'char', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Return' });
    await until("$('#queryResult .explain-settings-review details').open");
    win.setContentSize(900, 650);
    await evaluate("$('#sql').style.height='75px';$('#toast').style.display='none'");
    await evaluate("$('#queryResult .explain-settings-review p').scrollIntoView({block:'nearest'})");
    await captureReview('explain-settings-small');
    assert.equal(await evaluate("$('#queryResult .explain-settings-review').getBoundingClientRect().right<=innerWidth"), true);
    assert.equal(await evaluate("$('#queryResult .explain-settings-review').textContent.includes('bbbbbbbbbbbb')"), false);
    assert.match(await evaluate("$('#queryResult .explain-settings-review').textContent"), /Chưa xác nhận schema/);
    explainSettingsMissing = true; await run();
    assert.equal(await evaluate('app.query.result.explainComparison.status'), 'unknown');
    assert.match(await evaluate("$('#queryResult .explain-settings-review summary').textContent"), /Chưa đủ thông tin/);
    explainSettingsMissing = false;
    await evaluate("$('#explainSettings').click();$('#sql').style.height='';renderQueryView()");
    assert.equal(await evaluate("$('#explainSettings').checked"), false);
    win.setContentSize(1344, 835);
  });
  await check('EXPLAIN table definition opt-in resets scopes, blocks drift comparisons and keeps metadata escaped and usable with keyboard', async () => {
    await evaluate("app.query.sql='SELECT * FROM users';$('#sql').value=app.query.sql;$('#sql').setSelectionRange(0,0)");
    assert.equal(await evaluate("$('#explainSchema').checked"), false);
    await evaluate("$('#explainSchema').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    await until("$('#explainSchema').checked");
    const run = async () => { await evaluate('runExplainQuery()'); await until('!app.query.running'); };
    await run(); assert.equal(await evaluate('app.query.result.explainComparison.status'), 'baseline');
    assert.equal(calls.filter(call => call.name === 'db:query').at(-1).args[0].explainSchema, true);
    assert.equal(calls.filter(call => call.name === 'db:query').at(-1).args[0].sql, 'EXPLAIN SELECT * FROM users');
    await run(); assert.equal(await evaluate('app.query.result.explainComparison.status'), 'unchanged');
    explainSchemaDigest = 'b'; await run(); assert.equal(await evaluate('app.query.result.explainComparison.status'), 'schema-changed');
    await evaluate("$('#queryResult .explain-comparison summary').focus()");
    for (const type of ['keyDown', 'char', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Return' });
    await until("$('#queryResult .explain-comparison details').open");
    await evaluate("$('#queryResult .explain-schema-review summary').focus()");
    for (const type of ['keyDown', 'char', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Return' });
    await until("$('#queryResult .explain-schema-review details').open");
    assert.equal(await evaluate("$('#queryResult .explain-schema-review img')===null"), true);
    assert.match(await evaluate("$('#queryResult .explain-schema-review').textContent"), /<img src=table>/);
    assert.equal(await evaluate("$('#queryResult .explain-comparison .explain-review-table')===null"), true);
    win.setContentSize(900, 650);
    await evaluate("$('#sql').style.height='75px';$('#toast').style.display='none';$('#queryResult .explain-comparison').scrollTop=0");
    await captureReview('explain-schema-summary-small');
    await evaluate("$('#queryResult .explain-schema-review p').scrollIntoView({block:'nearest'})");
    await captureReview('explain-schema-small');
    assert.equal(await evaluate("$('#queryResult .explain-schema-review').getBoundingClientRect().right<=innerWidth"), true);
    assert.equal(await evaluate("$('#queryResult .explain-schema-review').textContent.includes('bbbbbbbbbbbb')"), false);
    explainSchemaMissing = true; await run(); assert.equal(await evaluate('app.query.result.explainComparison.status'), 'unknown');
    explainSchemaMissing = false;
    await evaluate("$('#explainSchema').click();$('#sql').style.height='';renderQueryView()");
    assert.equal(await evaluate("$('#explainSchema').checked"), false); win.setContentSize(1344, 835);
  });
  await check('drop actions honor confirmation and use object query payloads', async () => {
    await confirmPending("dropColumnAction('users','name')");
    assert.match(calls.filter((call) => call.name === 'db:query').at(-1).args[0].sql, /ALTER TABLE `test`.`users` DROP COLUMN `name`/);
    const count = calls.filter((call) => call.name === 'db:query').length;
    await confirmPending("dropIndexAction('idx_name')", false);
    assert.equal(calls.filter((call) => call.name === 'db:query').length, count);
    await confirmPending("dropRelationAction('fk_user')");
    assert.match(calls.filter((call) => call.name === 'db:query').at(-1).args[0].sql, /DROP FOREIGN KEY `fk_user`/);
  });
  await check('column/index/FK forms submit valid query payloads', async () => {
    for (const [open, fill, button, expected] of [
      ["addColumnModal('users')", "$('#newColName').value='phone'", '#confirmAddColBtn', /ADD COLUMN `phone`/],
      ["modifyColumnModal('users','name')", "$('#modColType').value='VARCHAR(100)'", '#confirmModColBtn', /MODIFY COLUMN `name` VARCHAR\(100\)/],
      ["renameColumnModal('users','name')", "$('#renamedColName').value='full_name'", '#confirmRenameColBtn', /RENAME COLUMN `name` TO `full_name`/],
      ["createIndexModal('users')", "$('#newIndexName').value='idx_name'; $('.index-col-check').checked=true", '#confirmCreateIndexBtn', /CREATE INDEX `idx_name`/],
      ["createRelationModal('users')", "$('#newFkName').value='fk_user'", '#confirmCreateFkBtn', /ADD CONSTRAINT `fk_user`/]
    ]) {
      await evaluate(open);
      const count = calls.filter((call) => call.name === 'db:query').length;
      await evaluate(`${fill}; $('${button}').click()`);
      await until('!$("#modal").open');
      const queries = calls.filter((call) => call.name === 'db:query');
      assert.equal(queries.length, count + 1);
      assert.match(queries.at(-1).args[0].sql, expected);
    }
  });
  await check('context menu initializes and deleting a row honors confirmation', async () => {
    await evaluate("selectTable('users')");
    await evaluate("$('#grid td[data-col]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:100})); $('#contextMenu [data-action=\"delete-row\"]').click()");
    await until("$('#modal').open");
    await evaluate("$('#confirmOk').click()");
    await until("!$('#modal').open");
    assert.equal(calls.filter((call) => call.name === 'db:delete-rows').length, 1);
  });
  await check('inline edit preserves empty strings', async () => {
    await evaluate("inlineEditCell($('#grid td[data-col=\"name\"]')); $('.inline-cell-editor').value=''; $('.inline-cell-editor').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
    await until("!$('#grid td[data-col=\"name\"]').classList.contains('editing-cell')");
    assert.equal(calls.filter((call) => call.name === 'db:update-row').at(-1).args[0].values.name, '');
  });

  await check('table filters and explicit row counts remain usable in a smaller window', async () => {
    await evaluate("closeModal(); mode='data'; app.columns=" + JSON.stringify(columns) + "; app.primaryKey=['id']; app.rows=[{id:1,name:'Alice'}]; app.total=null; app.search=''; app.hasMore=false; renderDataView()");
    win.setContentSize(940, 700);
    assert.equal(await evaluate("$('#nextPage').disabled"), true);
    assert.equal(await evaluate("$('#workspace .toolbar').scrollWidth <= $('#workspace .toolbar').clientWidth"), true);
    await evaluate("$('#countRowsBtn').click()");
    await until("app.total === 42");
    await evaluate("$('#filterColumn').value='name'; $('#filterColumn').dispatchEvent(new Event('change'))");
    await until("$('#filterColumn').value === 'name'");
    await evaluate("$('#filterMode').value='exact'; $('#filterMode').dispatchEvent(new Event('change'))");
    await until("$('#filterMode').value === 'exact'");
    await untilNode(() => calls.filter((call) => call.name === 'db:table-data').at(-1)?.args[0].searchMode === 'exact');
    const payload = calls.filter((call) => call.name === 'db:table-data').at(-1).args[0];
    assert.equal(payload.searchColumn, 'name'); assert.equal(payload.searchMode, 'exact');
    await captureReview('table-filters');
    await evaluate("app.searchColumn=null; app.searchMode='contains'");
    win.setContentSize(1344, 835);
  });
  await check('prefix and NULL filters keep count/export scope and reset using the keyboard', async () => {
    await evaluate("mode='data';app.search='';app.searchColumn='name';app.searchMode='contains';renderDataView()");
    win.setContentSize(940, 700); win.webContents.focus();
    await until('innerWidth===940 && innerHeight===700');
    await evaluate("$('#filter').value='%_=';$('#filter').dispatchEvent(new Event('input'));$('#filterMode').value='prefix';$('#filterMode').dispatchEvent(new Event('change'))");
    await until("$('#filterMode')?.value==='prefix' && $('#filter')?.value==='%_='");
    let payload = calls.filter(call => call.name === 'db:table-data').at(-1).args[0];
    assert.equal(payload.search, '%_='); assert.equal(payload.searchMode, 'prefix'); assert.equal(payload.page, 1); assert.equal(payload.cursor, null);
    await captureReview('table-search-prefix-small', () => evaluate("renderDataView();$('#toast').style.display='none';$('#filterMode').focus()"));
    assert.ok(await evaluate("$('#filterMode').getBoundingClientRect().width>=140"));
    assert.equal(await evaluate("$('#workspace .toolbar').scrollWidth<=$('#workspace .toolbar').clientWidth"), true);
    for (const searchMode of ['is-null', 'not-null']) {
      await evaluate(`$('#filterMode').value=${JSON.stringify(searchMode)};$('#filterMode').dispatchEvent(new Event('change'))`);
      await until(`$('#filterMode')?.value===${JSON.stringify(searchMode)} && $('#filter')?.disabled===true`);
      assert.equal(await evaluate("$('#filter').value"), '');
      await evaluate("$('#countRowsBtn').click()"); await until('app.total===42');
      payload = calls.filter(call => call.name === 'db:table-count').at(-1).args[0];
      assert.equal(payload.searchMode, searchMode); assert.equal(payload.searchColumn, 'name'); assert.equal(payload.search, '');
    }
    await captureReview('table-search-null-small', () => evaluate("renderDataView();$('#toast').style.display='none';$('#filterMode').focus()"));
    assert.equal(await evaluate("$('#filter').disabled && $('#filter').value===''"), true);
    await evaluate("transfer('export')");
    assert.equal(await evaluate("$('#exportFiltered').disabled"), false);
    assert.match(await evaluate("$('#modal').textContent"), /name khác NULL/);
    // The dialog's displayed target/filter remain authoritative if sidebar or
    // underlying state changes before the user confirms the export.
    await evaluate("window.searchExportSavedConnection=app.connection;app.connection={...app.connection,id:'changed-profile'};app.search='changed';app.searchColumn='id';app.searchMode='exact';$('#exportFiltered').checked=true;$('#exportGo').click()");
    await until("!$('#modal').open");
    payload = calls.filter(call => call.name === 'db:export-file').at(-1).args[0];
    assert.equal(payload.profileId, 'test'); assert.equal(payload.searchMode, 'not-null'); assert.equal(payload.searchColumn, 'name'); assert.equal(payload.search, '');
    await evaluate("app.connection=searchExportSavedConnection;delete window.searchExportSavedConnection;app.search='';app.searchColumn='name';app.searchMode='not-null';renderDataView();$('#filterColumn').value='';$('#filterColumn').dispatchEvent(new Event('change'))");
    await until("$('#filterMode')?.value==='contains' && $('#filter')?.disabled===false");
    assert.equal(await evaluate("$('#filterMode option[value=\"is-null\"]').disabled"), true);
    await evaluate("app.search='reset me';app.searchColumn='name';app.searchMode='prefix';app.page=3;renderDataView();$('#clearFilterBtn').focus()");
    for (const type of ['keyDown', 'char', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Return' });
    await until("$('#clearFilterBtn')?.disabled===true && app.search==='' && app.page===1 && app.searchColumn===null && app.searchMode==='contains'");
    await evaluate("app.search='   ';renderDataView()");
    assert.equal(await evaluate("$('#clearFilterBtn').disabled"), false);
    await evaluate("$('#clearFilterBtn').click()");
    await until("$('#clearFilterBtn')?.disabled===true && app.search===''");
    win.setContentSize(1344, 835);
  });
  await check('detached search debounce cannot change another table or overwrite a newer filter mode', async () => {
    const before = calls.filter(call => call.name === 'db:table-data').length;
    await evaluate("app.search='';app.searchColumn=null;app.searchMode='contains';renderDataView();$('#filter').value='stale-filter-marker';$('#filter').dispatchEvent(new Event('input'));selectTable('users')");
    await until("Boolean($('#filter')) && $('#filter').value===''");
    await evaluate('new Promise(resolve=>setTimeout(resolve,450))');
    assert.equal(await evaluate('app.search'), '');
    assert.equal(calls.filter(call => call.name === 'db:table-data').slice(before).some(call => call.args[0].search === 'stale-filter-marker'), false);
  });
  await check('grouped filters preview safely, apply with keyboard and keep count/export predicates identical', async () => {
    await evaluate("mode='data';app.filterTree=null;app.search='';app.searchColumn=null;app.searchMode='contains';renderDataView();$('#groupFilterBtn').click()");
    const queries = calls.filter(call => call.name === 'db:query').length;
    const reads = calls.filter(call => call.name === 'db:table-data').length;
    const edit = async (path, field, value, index = 0) => evaluate(`(() => {const element=$(${JSON.stringify(`[data-filter-field="${field}"][data-filter-path="${path}"]${field === 'value' ? `[data-filter-index="${index}"]` : ''}`)});element.value=${JSON.stringify(value)};element.dispatchEvent(new Event(${JSON.stringify(field === 'value' ? 'input' : 'change')},{bubbles:true}));})()`);
    assert.equal(await evaluate("$('#applyGroupFilter').disabled"), true);
    await edit('0', 'operator', 'gte'); await edit('0', 'value', '2');
    await evaluate("$('[data-filter-action=\"group\"][data-filter-path=\"\"]').click()");
    await edit('1', 'op', 'OR'); await edit('1.0', 'column', 'name');
    await edit('1.0', 'value', '<img src=x onerror=alert(1)>');
    await evaluate("$('[data-filter-action=\"rule\"][data-filter-path=\"1\"]').click()");
    await edit('1.1', 'operator', 'between'); await edit('1.1', 'value', '1'); await edit('1.1', 'value', '3', 1);
    assert.equal(await evaluate("$('#applyGroupFilter').disabled"), false);
    assert.equal(await evaluate("$('#tableFilterEditor img')===null"), true);
    assert.match(await evaluate("$('#groupFilterPreview').textContent"), /`id` >= \? AND \(`name` = \? OR `id` BETWEEN \? AND \?\)/);
    assert.doesNotMatch(await evaluate("$('#groupFilterPreview').textContent"), /img src/);
    assert.equal(calls.filter(call => call.name === 'db:table-data').length, reads);
    win.setContentSize(940, 700); win.webContents.focus(); await until('innerWidth===940 && innerHeight===700');
    await captureReview('table-filter-groups-small', () => evaluate("$('#toast').style.display='none';$('#tableFilterEditor select').focus()"));
    assert.equal(await evaluate("$('#modal').getBoundingClientRect().right<=innerWidth && $('#applyGroupFilter').getBoundingClientRect().bottom<=innerHeight"), true);
    assert.equal(await evaluate("$('#groupFilterPreview').getBoundingClientRect().bottom<=$('#applyGroupFilter').getBoundingClientRect().top"), true);
    assert.equal(await evaluate("$('#tableFilterEditor').scrollWidth<=$('#tableFilterEditor').clientWidth"), true);
    await evaluate("document.body.classList.add('dark-theme');document.body.classList.remove('light-theme')");
    await captureReview('table-filter-groups-small-dark', () => evaluate("$('#tableFilterEditor select').focus()"));
    assert.equal(await evaluate("getComputedStyle($('#modal')).backgroundColor"), 'rgb(24, 38, 53)');
    await evaluate("document.body.classList.remove('dark-theme');document.body.classList.add('light-theme')");
    for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Return', modifiers: ['control'] });
    await until("!$('#modal').open && Boolean($('#groupFilterBtn')) && Boolean(app.filterTree)");
    const expected = { version: 1, op: 'AND', items: [{ column: 'id', operator: 'gte', value: '2' }, { op: 'OR', items: [{ column: 'name', operator: 'eq', value: '<img src=x onerror=alert(1)>' }, { column: 'id', operator: 'between', value: ['1', '3'] }] }] };
    assert.deepEqual(calls.filter(call => call.name === 'db:table-data').at(-1).args[0].filterTree, expected);
    await evaluate("$('#countRowsBtn').click()"); await until('app.total===42');
    assert.deepEqual(calls.filter(call => call.name === 'db:table-count').at(-1).args[0].filterTree, expected);
    await evaluate("$('#groupFilterBtn').click()"); await edit('0', 'value', '5');
    for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Escape' });
    await until("!$('#modal').open");
    assert.deepEqual(await evaluate('JSON.parse(JSON.stringify(app.filterTree))'), expected);
    await evaluate("transfer('export')");
    assert.equal(await evaluate("$('#exportFiltered').disabled"), false);
    assert.match(await evaluate("$('#modal').textContent"), /Nhóm AND\/OR/);
    await evaluate("app.filterTree=null;$('#exportFiltered').checked=true;$('#exportGo').click()");
    await until("!$('#modal').open");
    assert.deepEqual(calls.filter(call => call.name === 'db:export-file').at(-1).args[0].filterTree, expected);
    assert.equal(calls.filter(call => call.name === 'db:query').length, queries);
    await evaluate("renderDataView();$('#groupFilterBtn').click();$('#removeGroupFilter').click()");
    await until("!$('#modal').open && Boolean($('#groupFilterBtn')) && app.filterTree===null");
    win.setContentSize(1344, 835);
  });
  await check('empty, stale-target and changed-metadata filter drafts stay open without issuing reads', async () => {
    await evaluate("app.filterTree=null;renderDataView();$('#groupFilterBtn').click();$('[data-filter-action=\"remove\"][data-filter-path=\"0\"]').click()");
    const before = calls.filter(call => call.name === 'db:table-data').length;
    assert.equal(await evaluate("$('#applyGroupFilter').disabled"), true);
    await evaluate("$('#tableFilterEditor').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true}))");
    assert.equal(await evaluate("$('#modal').open && app.filterTree===null"), true);
    await evaluate("{ $('[data-filter-action=\"rule\"][data-filter-path=\"\"]').click();const value=$('[data-filter-field=\"value\"]');value.value='1';value.dispatchEvent(new Event('input',{bubbles:true}));window.groupSavedConnection=app.connection;app.connection={...app.connection,id:'other-profile'};$('#applyGroupFilter').click(); }");
    assert.match(await evaluate("$('#groupFilterError').textContent"), /Đích hoặc bộ lọc đã thay đổi/);
    assert.equal(await evaluate('app.filterTree===null'), true);
    await evaluate("{ app.connection=groupSavedConnection;delete window.groupSavedConnection;closeModal();tableFilterDialog();const value=$('[data-filter-field=\"value\"]');value.value='1';value.dispatchEvent(new Event('input',{bubbles:true}));window.groupSavedColumns=app.columns;app.columns=app.columns.filter(column=>column.name!=='id');$('#applyGroupFilter').click(); }");
    assert.equal(await evaluate("$('#modal').open && $('#applyGroupFilter').disabled && app.filterTree===null"), true);
    assert.match(await evaluate("$('#groupFilterError').textContent"), /Cột hoặc toán tử/);
    assert.equal(calls.filter(call => call.name === 'db:table-data').length, before);
    await evaluate("app.columns=groupSavedColumns;delete window.groupSavedColumns;closeModal();renderDataView()");
  });
  await check('IN lists support exact individual values, keyboard apply, count/export and opt-in restart restoration', async () => {
    const values = ['', 'NULL', 'a,b', "x') OR 1=1 --", ...Array.from({ length: 16 }, (_, index) => `item_${index}`)];
    await evaluate("app.filterTree=null;app.search='';app.searchColumn=null;app.searchMode='contains';renderDataView();tableFilterDialog();{let c=$('[data-filter-field=\"column\"]');c.value='name';c.dispatchEvent(new Event('change',{bubbles:true}));let o=$('[data-filter-field=\"operator\"]');o.value='in';o.dispatchEvent(new Event('change',{bubbles:true}));}");
    for (let index = 0; index < values.length; index++) {
      if (index) await evaluate("$('[data-filter-action=\"add-value\"]').click()");
      await evaluate(`{const input=$('[data-filter-field="value"][data-filter-index="${index}"]');input.value=${JSON.stringify(values[index])};input.dispatchEvent(new Event('input',{bubbles:true}));}`);
    }
    assert.equal(await evaluate("$('[data-filter-action=\"add-value\"]').disabled && !$('#applyGroupFilter').disabled"), true);
    assert.equal(await evaluate("$('#groupFilterPreview').textContent.includes('OR 1=1')"), false);
    await evaluate("$('[data-filter-action=\"remove-value\"][data-filter-index=\"19\"]').click()");
    assert.equal(await evaluate("document.activeElement===$('[data-filter-action=\"add-value\"]') && !$('[data-filter-action=\"add-value\"]').disabled"), true);
    await evaluate(`$('[data-filter-action="add-value"]').click();{const input=$('[data-filter-field="value"][data-filter-index="19"]');input.value=${JSON.stringify(values[19])};input.dispatchEvent(new Event('input',{bubbles:true}));}`);
    win.setContentSize(940, 700);
    await evaluate("document.body.classList.remove('dark-theme')");
    await captureReview('filter-list-small', () => evaluate("$('#toast').style.display='none';$('[data-filter-field=\"value\"][data-filter-index=\"19\"]').focus()"));
    assert.equal(await evaluate("$('#tableFilterEditor').scrollWidth<=$('#tableFilterEditor').clientWidth && $('#applyGroupFilter').getBoundingClientRect().bottom<=innerHeight"), true);
    await evaluate("document.body.classList.add('dark-theme')");
    await captureReview('filter-list-small-dark', () => evaluate("$('[data-filter-field=\"value\"][data-filter-index=\"19\"]').focus()"));
    for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Return', modifiers: ['control'] });
    await until("!$('#modal').open && Boolean($('#groupFilterBtn')) && app.filterTree?.items[0].operator==='in'");
    const expected = { version: 1, op: 'AND', items: [{ column: 'name', operator: 'in', value: values }] };
    assert.deepEqual(calls.filter(call => call.name === 'db:table-data').at(-1).args[0].filterTree, expected);
    await evaluate("$('#countRowsBtn').click()");
    await until("!$('#countRowsBtn') || !$('#countRowsBtn').disabled");
    assert.deepEqual(calls.filter(call => call.name === 'db:table-count').at(-1).args[0].filterTree, expected);
    await evaluate("transfer('export');$('#exportFiltered').checked=true;$('#exportGo').click()");
    await until("!$('#modal').open");
    assert.deepEqual(calls.filter(call => call.name === 'db:export-file').at(-1).args[0].filterTree, expected);
    await evaluate("renderDataView();tablePreferenceDialog()");
    await until("!$('#saveTablePreference').disabled");
    assert.equal(await evaluate("$('#saveTableFilterValues').checked"), false);
    await evaluate("$('#saveTableFilterValues').checked=true;$('#saveTablePreference').click()");
    await until("$('#tablePreferenceStatus').textContent.includes('Đã lưu')");
    const saved = calls.filter(call => call.name === 'table-preferences:save').at(-1);
    assert.deepEqual(saved.args[1].filters.filterTree, expected);
    await evaluate("closeModal();selectTable('users')");
    await until("Boolean($('#groupFilterBtn')) && app.filterTree?.items[0].operator==='in'");
    assert.deepEqual(await evaluate('app.filterTree'), expected);
    tablePreferencesRepository.remove(saved.args[0]);
    await evaluate("app.filterTree=null;app.sorts=null;renderDataView()");
    win.setContentSize(1344, 835);
  });
  await check('empty and invalid numeric lists block apply; value budgets and Escape preserve the active predicate', async () => {
    await evaluate("tableFilterDialog();{const o=$('[data-filter-field=\"operator\"]');o.value='not-in';o.dispatchEvent(new Event('change',{bubbles:true}));}$('[data-filter-action=\"remove-value\"]').click()");
    const before = calls.filter(call => call.name === 'db:table-data').length;
    assert.equal(await evaluate("$('#applyGroupFilter').disabled"), true);
    await evaluate("$('[data-filter-action=\"add-value\"]').click();{const v=$('[data-filter-field=\"value\"]');v.value='1.5';v.dispatchEvent(new Event('input',{bubbles:true}));}$('#tableFilterEditor').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true}))");
    assert.equal(await evaluate("$('#modal').open && app.filterTree===null && $('#applyGroupFilter').disabled"), true);
    await evaluate("closeModal();app.filterTree=SqlTableFilters.compile({version:1,op:'AND',items:Array.from({length:5},()=>({column:'id',operator:'in',value:Array.from({length:20},(_,i)=>String(i))}))},app.columns).tree;renderDataView();tableFilterDialog();$('[data-filter-action=\"rule\"][data-filter-path=\"\"]').click();{const v=$('[data-filter-field=\"value\"][data-filter-path=\"5\"]');v.value='1';v.dispatchEvent(new Event('input',{bubbles:true}));}$('#applyGroupFilter').click()");
    assert.match(await evaluate("$('#groupFilterError').textContent"), /100 giá trị/);
    assert.equal(await evaluate("$('#applyGroupFilter').disabled && app.filterTree.items.length===5"), true);
    assert.equal(calls.filter(call => call.name === 'db:table-data').length, before);
    for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Escape' });
    await until("!$('#modal').open");
    assert.equal(await evaluate("app.filterTree.items.length"), 5);
    await evaluate("app.filterTree=null;renderDataView()");
  });
  await check('column visibility and mixed sorts preserve hidden PK editing, export snapshot and keyboard control', async () => {
    await evaluate("mode='data';app.visibleColumns=null;app.sorts=null;app.orderBy=null;app.orderDir='ASC';renderDataView();$('#tableViewBtn').click()");
    const reads = calls.filter(call => call.name === 'db:table-data').length;
    await evaluate("$('#hideAllViewColumns').click()");
    assert.equal(await evaluate("$('#applyTableView').disabled"), true);
    await evaluate("const checkbox=$('[data-view-column=\"1\"]');checkbox.checked=true;checkbox.dispatchEvent(new Event('change',{bubbles:true}));$('#addViewSort').click();$('#addViewSort').click()");
    await evaluate("{const direction=$('[data-view-sort=\"0\"] [data-view-sort-field=\"direction\"]');direction.value='DESC';direction.dispatchEvent(new Event('change',{bubbles:true}));$('[data-view-sort=\"1\"] [data-view-sort-action=\"up\"]').click();}");
    assert.equal(calls.filter(call => call.name === 'db:table-data').length, reads);
    win.setContentSize(940, 700); win.webContents.focus(); await until('innerWidth===940 && innerHeight===700');
    await captureReview('table-view-small', () => evaluate("$('#toast').style.display='none';$('#tableViewEditor input').focus()"));
    assert.equal(await evaluate("$('#tableViewEditor').scrollWidth<=$('#tableViewEditor').clientWidth && $('#applyTableView').getBoundingClientRect().bottom<=innerHeight"), true);
    await evaluate("document.body.classList.add('dark-theme');document.body.classList.remove('light-theme')");
    await captureReview('table-view-small-dark', () => evaluate("$('#tableViewEditor input').focus()"));
    await evaluate("document.body.classList.remove('dark-theme');document.body.classList.add('light-theme')");
    for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Return', modifiers: ['control'] });
    await until("!$('#modal').open && Boolean($('#tableViewBtn')) && app.sorts?.length===2");
    const sorts = [{ column: 'name', direction: 'ASC' }, { column: 'id', direction: 'DESC' }];
    assert.deepEqual(calls.filter(call => call.name === 'db:table-data').at(-1).args[0].sorts, sorts);
    assert.deepEqual(await evaluate("[...document.querySelectorAll('#grid th[data-sort]')].map(th=>th.dataset.sort)"), ['name']);
    assert.equal(await evaluate("app.rows[0].id===1 && app.primaryKey[0]==='id' && app.columns.length===2"), true);
    assert.match(await evaluate("$('#grid th[data-sort]').textContent"), /▲1/);
    await evaluate("inlineEditCell($('#grid td[data-col=\"name\"]'))");
    await until("Boolean($('#grid .inline-cell-editor'))");
    await evaluate("$('#grid .inline-cell-editor').value='Hidden PK saved';$('#grid .inline-cell-editor').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
    await until("!$('#grid td[data-col=\"name\"]').classList.contains('editing-cell')");
    assert.deepEqual(calls.filter(call => call.name === 'db:update-row').at(-1).args[0].keys, { id: 1 });
    await evaluate("transfer('export')");
    assert.equal(await evaluate("$('#exportVisibleColumns').checked"), false);
    assert.match(await evaluate("$('#modal').textContent"), /name ASC, id DESC/);
    await evaluate("app.visibleColumns=null;app.sorts=[];$('#exportVisibleColumns').checked=true;$('#exportGo').click()");
    await until("!$('#modal').open");
    const payload = calls.filter(call => call.name === 'db:export-file').at(-1).args[0];
    assert.deepEqual(payload.columns, ['name']); assert.deepEqual(payload.sorts, sorts);
    await evaluate("app.visibleColumns=Object.freeze(['name']);app.sorts=Object.freeze([]);renderDataView();$('#grid th[data-sort]').focus()");
    for (const type of ['keyDown', 'char', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Return' });
    await until("app.orderBy==='name' && app.sorts===null && Boolean($('#tableViewBtn'))");
    await evaluate("selectTable('users')");
    await until("app.visibleColumns===null && app.sorts===null && Boolean($('#grid th[data-sort=\"id\"]'))");
    win.setContentSize(1344, 835);
  });
  await check('view drafts reject duplicate/empty/stale metadata and Escape keeps the previous configuration', async () => {
    await evaluate("$('#tableViewBtn').click();$('#addViewSort').click();$('#addViewSort').click();{const column=$('[data-view-sort=\"1\"] [data-view-sort-field=\"column\"]');column.value='id';column.dispatchEvent(new Event('change',{bubbles:true}));}");
    assert.equal(await evaluate("$('#applyTableView').disabled"), true);
    assert.match(await evaluate("$('#viewConfigError').textContent"), /khác nhau/);
    const before = calls.filter(call => call.name === 'db:table-data').length;
    await evaluate("$('#clearViewSort').click();$('#hideAllViewColumns').click();$('#tableViewEditor').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true}))");
    assert.equal(await evaluate("$('#modal').open && app.visibleColumns===null && app.sorts===null"), true);
    await evaluate("$('#showAllViewColumns').click();window.viewSavedConnection=app.connection;app.connection={...app.connection,id:'changed'};$('#applyTableView').click()");
    assert.match(await evaluate("$('#viewConfigError').textContent"), /Đích hoặc cấu hình/);
    await evaluate("app.connection=viewSavedConnection;delete window.viewSavedConnection;closeModal();tableViewDialog();$('#addViewSort').click();window.viewSavedColumns=app.columns;app.columns=[];$('#applyTableView').click()");
    assert.equal(await evaluate("$('#modal').open && $('#applyTableView').disabled"), true);
    await evaluate("app.columns=viewSavedColumns;delete window.viewSavedColumns");
    for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Escape' });
    await until("!$('#modal').open");
    assert.equal(calls.filter(call => call.name === 'db:table-data').length, before);
    assert.equal(await evaluate('app.visibleColumns===null && app.sorts===null'), true);
  });
  await check('table preferences save layout locally with filter persistence off by default and keyboard access', async () => {
    await evaluate("app.visibleColumns=Object.freeze(['name']);app.sorts=Object.freeze([{column:'name',direction:'DESC'}]);app.search='private-value';app.searchColumn='name';app.searchMode='prefix';renderDataView();$('#tablePreferenceBtn').click()");
    await until("!$('#saveTablePreference').disabled");
    assert.equal(await evaluate("$('#saveTableFilterValues').checked"), false);
    win.setContentSize(940, 700);
    await evaluate("document.body.classList.remove('dark-theme')");
    await captureReview('table-preferences-small', () => evaluate("$('#toast').style.display='none';$('#saveTablePreference').focus()"));
    assert.equal(await evaluate("$('#tablePreferenceEditor').scrollWidth<=$('#tablePreferenceEditor').clientWidth && $('#saveTablePreference').getBoundingClientRect().bottom<=innerHeight"), true);
    await evaluate("document.body.classList.add('dark-theme')");
    await captureReview('table-preferences-small-dark', () => evaluate("$('#saveTablePreference').focus()"));
    for (const type of ['keyDown', 'char', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Return' });
    await until("$('#tablePreferenceStatus').textContent.includes('Đã lưu')");
    const saved = calls.filter(call => call.name === 'table-preferences:save').at(-1);
    assert.equal(saved.args[1].filters, null);
    assert.doesNotMatch(JSON.stringify(saved.args), /private-value/);
    assert.deepEqual(saved.args[1].visibleColumns, ['name']);
    await evaluate("closeModal();selectTable('users')");
    await until("Boolean($('#tablePreferenceBtn')) && app.visibleColumns?.[0]==='name'");
    assert.equal(await evaluate("app.search==='' && app.filterTree===null && app.sorts[0].direction==='DESC' && app.rows[0].id===1"), true);
    win.setContentSize(1344, 835);
  });
  await check('opt-in filter persistence restores before the first SELECT and stays scoped to the exact database', async () => {
    await evaluate("app.search='Alice';app.searchColumn='name';app.searchMode='exact';app.filterTree=SqlTableFilters.compile({version:1,op:'AND',items:[{column:'id',operator:'gt',value:'0'}]},app.columns).tree;renderDataView();tablePreferenceDialog()");
    await until("!$('#saveTablePreference').disabled");
    await evaluate("$('#saveTableFilterValues').checked=true;$('#saveTablePreference').click()");
    await until("$('#tablePreferenceStatus').textContent.includes('Đã lưu')");
    const before = calls.filter(call => call.name === 'db:table-data').length;
    await evaluate("closeModal();selectTable('users')");
    await until("Boolean($('#tablePreferenceBtn')) && app.search==='Alice'");
    const queries = calls.filter(call => call.name === 'db:table-data').slice(before);
    assert.equal(queries.length, 1);
    assert.equal(queries[0].args[0].search, 'Alice');
    assert.equal(queries[0].args[0].filterTree.items[0].operator, 'gt');
    await evaluate("window.preferenceDatabase=app.database;app.database='Other';selectTable('users')");
    await until("Boolean($('#tablePreferenceBtn')) && app.sorts===null");
    assert.equal(await evaluate("app.search==='' && app.filterTree===null && app.visibleColumns===null"), true);
    await evaluate("app.database=preferenceDatabase;delete window.preferenceDatabase;selectTable('users')");
    await until("Boolean($('#tablePreferenceBtn')) && app.search==='Alice'");
  });
  await check('schema drift blocks saved filters without SELECT until the user chooses defaults', async () => {
    rowEditorColumns = columns.map(column => ({ ...column, type: column.name === 'id' ? 'bigint' : column.type }));
    const before = calls.filter(call => call.name === 'db:table-data').length;
    await evaluate("selectTable('users')");
    await until("Boolean($('#skipTablePreference'))");
    assert.match(await evaluate("$('#workspace').textContent"), /Cấu trúc bảng đã thay đổi/);
    assert.equal(calls.filter(call => call.name === 'db:table-data').length, before);
    await evaluate("$('#retryTablePreference').click()");
    await until("Boolean($('#skipTablePreference'))");
    assert.equal(calls.filter(call => call.name === 'db:table-data').length, before);
    rowEditorColumns = columns;
    await evaluate("$('#skipTablePreference').click()");
    await until("Boolean($('#tablePreferenceBtn'))");
    assert.equal(calls.filter(call => call.name === 'db:table-data').at(-1).args[0].filterTree, null);
  });
  await check('saved preference dialog blocks stale scopes, applies explicitly, and deletion preserves the active view', async () => {
    await evaluate("tablePreferenceDialog()");
    await until("!$('#restoreTablePreference').disabled");
    const before = calls.filter(call => call.name === 'table-preferences:save').length;
    await evaluate("window.preferenceConnection=app.connection;app.connection={...app.connection,id:'changed'};$('#saveTablePreference').click()");
    assert.match(await evaluate("$('#tablePreferenceStatus').textContent"), /Đích hoặc cấu hình/);
    assert.equal(calls.filter(call => call.name === 'table-preferences:save').length, before);
    await evaluate("app.connection=preferenceConnection;delete window.preferenceConnection;closeModal();tablePreferenceDialog()");
    await until("!$('#restoreTablePreference').disabled");
    await evaluate("$('#restoreTablePreference').click()");
    await until("!$('#modal').open && Boolean($('#tablePreferenceBtn')) && app.search==='Alice'");
    await evaluate("tablePreferenceDialog()");
    await until("!$('#removeTablePreference').disabled");
    await evaluate("$('#removeTablePreference').click()");
    await until("$('#tablePreferenceStatus').textContent.includes('Đã xóa')");
    assert.equal(await evaluate("app.search==='Alice' && app.filterTree.items[0].operator==='gt'"), true);
    await evaluate("closeModal();selectTable('users')");
    await until("Boolean($('#tablePreferenceBtn')) && app.sorts===null");
  });
  await check('late saved preferences cannot replace another table or resume an obsolete SELECT', async () => {
    let release;
    pendingTablePreferenceRead = scope => new Promise(resolve => { release = () => resolve(ok(tablePreferencesRepository.read(scope))); });
    const before = calls.filter(call => call.name === 'db:table-data').length;
    await evaluate("void selectTable('users')");
    const deadline = Date.now() + 5000;
    while (!release && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(release, 'preference read must start within five seconds');
    pendingTablePreferenceRead = null;
    await evaluate("selectTable('table_1')");
    release();
    await until("table==='table_1' && Boolean($('#tablePreferenceBtn'))");
    const queries = calls.filter(call => call.name === 'db:table-data').slice(before);
    assert.equal(queries.length, 1); assert.equal(queries[0].args[0].table, 'table_1');
    await evaluate("selectTable('users')");
    await until("table==='users' && Boolean($('#tablePreferenceBtn'))");
  });
  await check('file import previews mapping and sends a streaming payload', async () => {
    const before = calls.filter((call) => call.name === 'db:import-file').length;
    await evaluate('importFileModal()');
    await until("Boolean($('#doFileImportBtn'))");
    const preview = calls.filter((call) => call.name === 'db:preview-import').at(-1).args[0];
    assert.deepEqual(preview, {
      filePath: '/tmp/sqlpro-smoke-import.csv',
      format: 'csv',
      delimiter: ',',
      hasHeader: true,
      limit: 20
    });
    assert.match(await evaluate("$('#modal').textContent"), /không giới hạn 5\.000 dòng/);
    assert.equal(
      await evaluate("document.querySelector('.csv-mapping-row select[data-db-col=\"name\"]').selectedOptions[0].dataset.source"),
      'name'
    );
    await evaluate("$('#importMode').value='upsert'; $('#importTransaction').value='all'; $('#doFileImportBtn').click()");
    await until("!$('#modal').open");
    await untilNode(() => calls.filter((call) => call.name === 'db:import-file').length > before);
    const payload = calls.filter((call) => call.name === 'db:import-file').at(-1).args[0];
    assert.equal(payload.profileId, 'test');
    assert.equal(payload.database, 'test');
    assert.equal(payload.table, 'users');
    assert.equal(payload.filePath, '/tmp/sqlpro-smoke-import.csv');
    assert.equal(payload.format, 'csv');
    assert.equal(payload.hasHeader, true);
    assert.equal(payload.mode, 'upsert');
    assert.equal(payload.transaction, 'all');
    assert.deepEqual(payload.mapping, { name: 'name' });
    assert.match(payload.taskId, /^import-/);
    assert.match(await evaluate("$('#toast').textContent"), /Đã nhập 2 dòng/);
  });
  await check('file export sends task, filter and order and reports the result', async () => {
    await evaluate("app.search='Alice'; app.orderBy='name'; app.orderDir='DESC'; transfer('export')");
    await until("Boolean($('#exportGo'))");
    assert.match(await evaluate("$('#modal').textContent"), /không giới hạn 20\.000 dòng/);
    assert.match(await evaluate("$('#modal').textContent"), /bộ lọc “Alice · Chứa”/);
    assert.match(await evaluate("$('#modal').textContent"), /sắp xếp theo name DESC/);
    await evaluate("$('#exportFormat').value='json'; $('#exportFiltered').checked=true; $('#exportGo').click()");
    await untilNode(() => calls.some((call) => call.name === 'db:export-file'));
    const payload = calls.filter((call) => call.name === 'db:export-file').at(-1).args[0];
    assert.equal(payload.profileId, 'test');
    assert.equal(payload.database, 'test');
    assert.equal(payload.table, 'users');
    assert.equal(payload.format, 'json');
    assert.equal(payload.search, 'Alice');
    assert.deepEqual(payload.orderBy, { column: 'name', direction: 'DESC' });
    assert.match(payload.taskId, /^export-/);
    await until("!$('#modal').open");
    assert.match(await evaluate("$('#toast').textContent"), /Đã xuất 2 dòng/);
  });
  await check('server variables and processlist load; kill confirms then refreshes', async () => {
    await evaluate('showServerVarsModal()');
    await until("Boolean($('#varsTableContainer tbody tr'))");
    assert.match(await evaluate("$('#varsTableContainer').textContent"), /max_connections/);
    await evaluate('showProcesslistModal()');
    await until("Boolean($('.kill-btn'))");
    await evaluate("$('.kill-btn').click()");
    await until("Boolean($('#confirmOk'))");
    await evaluate("$('#confirmOk').click()");
    await until("Boolean($('.kill-btn'))");
    assert.ok(calls.some((call) => call.name === 'db:query' && call.args[0].sql === 'KILL 42' && call.args[0].confirmed));
  });
  await check('diagnostic dashboard switches between processlist, locks and slow queries tabs', async () => {
    await evaluate('showProcesslistModal()');
    await until("Boolean($('.diag-tabs'))");
    assert.equal(await evaluate("Boolean($('#diagAutoRefreshSelect'))"), true);

    // Switch to Locks tab
    await evaluate("document.querySelector('[data-diag-tab=\"locks\"]').click()");
    await until("document.querySelector('[data-diag-tab=\"locks\"]').classList.contains('active')");
    await until("!$('#diagTabContent').textContent.includes('Đang phân tích')");
    assert.match(await evaluate("$('#diagTabContent').textContent"), /Khóa & Giao dịch|Active Transactions/i);

    // Switch to Slow Queries tab
    await evaluate("document.querySelector('[data-diag-tab=\"slow\"]').click()");
    await until("document.querySelector('[data-diag-tab=\"slow\"]').classList.contains('active')");
    await until("!$('#diagTabContent').textContent.includes('Đang đọc')");
    assert.match(await evaluate("$('#diagTabContent').textContent"), /Slow Query Log/i);

    // Switch back to processlist and test safe kill query button
    await evaluate("document.querySelector('[data-diag-tab=\"processlist\"]').click()");
    await until("Boolean($('.kill-query-btn'))");
    await evaluate("$('.kill-query-btn').click()");
    await until("Boolean($('#confirmOk'))");
    await evaluate("$('#confirmOk').click()");
    assert.ok(calls.some((call) => call.name === 'db:query' && call.args[0].sql === 'KILL QUERY 42' && call.args[0].confirmed));

    await evaluate('closeModal()');
  });
  await check('smart data masking toggles and masks sensitive PII columns in data grid and query grid', async () => {
    // 1. Table grid masking test
    await evaluate(`(() => {
      app.columns = [
        { name: 'id', type: 'int' },
        { name: 'email', type: 'varchar(255)' },
        { name: 'phone', type: 'varchar(50)' }
      ];
      app.rows = [
        { id: 1, email: 'secret.user@company.com', phone: '0912345678' }
      ];
      app.maskData = false;
      renderDataView();
    })()`);

    let emailCell = await evaluate("document.querySelector('td[data-col=\"email\"]').textContent");
    assert.equal(emailCell, 'secret.user@company.com');

    // Click toggle mask button
    await evaluate("$('#maskDataBtn').click()");
    emailCell = await evaluate("document.querySelector('td[data-col=\"email\"]').textContent");
    assert.equal(emailCell, 's***r@company.com');

    let phoneCell = await evaluate("document.querySelector('td[data-col=\"phone\"]').textContent");
    assert.equal(phoneCell, '091****678');

    // Toggle off
    await evaluate("$('#maskDataBtn').click()");
    emailCell = await evaluate("document.querySelector('td[data-col=\"email\"]').textContent");
    assert.equal(emailCell, 'secret.user@company.com');
  });
  await check('schema diff modal opens, configures source/target, and navigates tabs', async () => {
    await evaluate('showSchemaDiffModal()');
    await until("Boolean($('#modal .schema-diff-card'))");
    assert.equal(await evaluate("Boolean($('#diffSourceProfile'))"), true);
    assert.equal(await evaluate("Boolean($('#diffTargetProfile'))"), true);
    assert.equal(await evaluate("Boolean($('#diffRunCompareBtn'))"), true);

    await evaluate('closeModal()');
  });
  await check('data diff modal opens, configures source/target tables, and navigates tabs', async () => {
    await evaluate('showDataDiffModal()');
    await until("Boolean($('#modal .data-diff-card'))");
    assert.equal(await evaluate("Boolean($('#dataDiffSourceProfile'))"), true);
    assert.equal(await evaluate("Boolean($('#dataDiffTargetProfile'))"), true);
    assert.equal(await evaluate("Boolean($('#dataDiffRunCompareBtn'))"), true);

    await evaluate('closeModal()');
    await until("!$('#modal').open");
  });
  await check('audit log modal opens, displays disclaimer, filters entries, and exports', async () => {
    await evaluate(`(async () => {
      await recordAudit({
        profileId: 'smoke-profile',
        profileName: 'Smoke Test DB',
        database: 'test_db',
        table: 'users',
        actionType: 'INSERT',
        summary: 'Thêm bản ghi vào bảng users',
        affectedRows: 1,
        durationMs: 8,
        status: 'success'
      });
      await recordAudit({
        profileId: 'smoke-profile',
        profileName: 'Smoke Test DB',
        database: 'test_db',
        actionType: 'QUERY',
        summary: 'SELECT FROM users',
        durationMs: 4,
        status: 'error',
        errorCode: 'ER_NO_SUCH_TABLE',
        errorSummary: 'Table does not exist'
      });
    })()`);

    await evaluate("$('button[data-click=\"audit-log\"]').click()");
    await until("Boolean($('#modal .audit-modal-card'))");

    assert.equal(await evaluate("Boolean($('.audit-disclaimer-banner'))"), true);
    assert.equal(await evaluate("Boolean($('#auditSearchInput'))"), true);
    assert.equal(await evaluate("Boolean($('#auditActionSelect'))"), true);
    assert.equal(await evaluate("Boolean($('#auditExportCsvBtn'))"), true);

    await until("document.querySelectorAll('.audit-row').length >= 2");
    const summaries = await evaluate("Array.from(document.querySelectorAll('.audit-summary-cell')).map(el => el.textContent.trim())");
    assert.ok(summaries.some(s => s.includes('users')));

    await evaluate(`(() => {
      const select = $('#auditActionSelect');
      select.value = 'INSERT';
      select.dispatchEvent(new Event('change'));
    })()`);
    await until("document.querySelectorAll('.audit-row').length === 1");

    await evaluate('closeModal()');
    await until("!$('#modal').open");
  });
  await check('query snippets modal opens, filters by search, and inserts into editor at caret with undo', async () => {
    await evaluate(`(() => {
      mode = 'query';
      app.query.sql = 'SELECT 1;';
      renderQueryView();
      $('#snippetsBtn').click();
    })()`);
    await until("Boolean($('#modal .snippets-modal-card'))");
    assert.equal(await evaluate("Boolean($('#snippetSearchInput'))"), true);
    assert.ok(await evaluate("document.querySelectorAll('.snippet-card').length >= 4"));

    // Filter snippets
    await evaluate(`(() => {
      const input = $('#snippetSearchInput');
      input.value = 'CTE';
      input.dispatchEvent(new Event('input'));
    })()`);
    await until("document.querySelectorAll('.snippet-card').length === 1");
    assert.match(await evaluate("document.querySelector('.snippet-title').textContent"), /CTE/);

    // Insert snippet into editor
    await evaluate("document.querySelector('[data-snippet-action=\"insert\"]').click()");
    await until("!$('#modal').open");
    assert.match(await evaluate("$('#sql').value"), /WITH cte AS/);

    // Test undo reverts insertion
    win.webContents.focus();
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control'] });
    await until("$('#sql').value === 'SELECT 1;'");
  });
  await check('query history view searches queries, scrubs sensitive SQL and prunes history', async () => {
    await evaluate(`(() => {
      historyRows = [
        normalizeHistory({ sql: 'SELECT * FROM users;', ok: true, durationMs: 12 }),
        normalizeHistory({ sql: 'CREATE USER test IDENTIFIED BY \\'secret_pass\\';', ok: true, durationMs: 45 }),
        normalizeHistory({ sql: 'SELECT * FROM missing_table;', ok: false, durationMs: null, message: 'Table not found' })
      ];
      mode = 'history';
      renderHistoryView();
    })()`);
    assert.equal(await evaluate("document.querySelectorAll('.historyrow').length"), 3);

    // Filter by search query
    await evaluate(`(() => {
      const input = $('#historySearchInput');
      input.value = 'users';
      input.dispatchEvent(new Event('input'));
    })()`);
    await until("document.querySelectorAll('.historyrow').length === 1");

    // Status filter
    await evaluate(`(() => {
      $('#historySearchInput').value = '';
      $('#historySearchInput').dispatchEvent(new Event('input'));
      $('#historyStatusFilter').value = 'error';
      $('#historyStatusFilter').dispatchEvent(new Event('change'));
    })()`);
    await until("document.querySelectorAll('.historyrow').length === 1");
    assert.match(await evaluate("document.querySelector('.history-sql').textContent"), /missing_table/);

    // Reset status filter and test sensitive scrub
    await evaluate(`(() => {
      $('#historyStatusFilter').value = 'all';
      $('#historyStatusFilter').dispatchEvent(new Event('change'));
      const scrubCheckbox = $('#scrubSensitiveCheckbox');
      scrubCheckbox.checked = true;
      scrubCheckbox.dispatchEvent(new Event('change'));
    })()`);
    await until("document.querySelectorAll('.historyrow').length === 3");
    const historyText = await evaluate("document.querySelector('.history-list').textContent");
    assert.ok(historyText.includes("***"));
    assert.ok(!historyText.includes("secret_pass"));

    // Clear history
    await evaluate("$('#clearHistory').click()");
    await until("document.querySelectorAll('.historyrow').length === 0");
    assert.equal(await evaluate("historyRows.length"), 0);

    // Return to previous view
    await evaluate("view('data')");
  });
  await check('maintenance renders server response', async () => {
    await evaluate("runTableMaintenance('users','CHECK')");
    assert.match(await evaluate("$('#modal').textContent"), /OK/);
  });
  await check('ERD scrolls all loaded nodes and adds no window drag handlers', async () => {
    await evaluate("window.dragHandlers=0; window.originalAddEventListener=window.addEventListener; window.addEventListener=function(name,...args){if(['mousemove','mouseup'].includes(name))window.dragHandlers++;return window.originalAddEventListener.call(this,name,...args)}; showErDiagramModal()");
    assert.equal(await evaluate("$('#erdCanvas').getBoundingClientRect().height > $('#erdCanvas').parentElement.clientHeight"), true);
    await evaluate('closeModal(); showErDiagramModal()');
    assert.equal(await evaluate('window.dragHandlers'), 0);
    await evaluate('window.addEventListener=window.originalAddEventListener; closeModal()');
  });
  await check('theme initializes immediately from saved preference', async () => {
    assert.equal(await evaluate("localStorage.setItem('sqlpro-theme','light'); initTheme(); document.body.classList.contains('light-theme') && $('#themeToggleBtn').textContent.includes('Tối')"), true);
  });
  await check('sidebar items support keyboard activation and clear labels', async () => {
    const result = await evaluate(`(() => {
      const previousConnections = app.connections;
      const previousSelectTable = selectTable;
      app.connections = [{id:'mock',name:'Mock',host:'localhost',port:3306,user:'root',ssh:{enabled:false},workspaceId:app.activeWorkspaceId}];
      renderSidebar();
      const connectionButton = document.querySelector('.conn-open[data-connection="mock"]');
      const tableItem = document.querySelector('.treeitem[data-table="users"]');
      selectTable = (name) => { window.selectedByKeyboard = name; };
      tableItem.focus();
      tableItem.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true}));
      const result = {
        connectionLabel: connectionButton?.getAttribute('aria-label'),
        tableFocusable: tableItem?.tabIndex === 0,
        selected: window.selectedByKeyboard,
        toastRole: (toast('Lỗi kiểm tra', 'error'), document.querySelector('#toast').getAttribute('role'))
      };
      app.connections = previousConnections;
      selectTable = previousSelectTable;
      return result;
    })()`);
    assert.equal(result.connectionLabel, 'Kết nối Mock');
    assert.equal(result.tableFocusable, true);
    assert.equal(result.selected, 'users');
    assert.equal(result.toastRole, 'alert');
  });
  await check('routines and events load lazily and render in the sidebar', async () => {
    await evaluate("loadObjectMetadata('routines')");
    await until('app.routineState.loaded && !app.routineState.loading');
    assert.equal(await evaluate('app.routineState.data.length'), 2);
    await evaluate("loadObjectMetadata('events')");
    await until('app.eventState.loaded && !app.eventState.loading');
    assert.equal(await evaluate('app.eventState.data.length'), 1);
    const html = await evaluate(`(() => {
      const previousConnections = app.connections;
      app.connections = [{id:'test',name:'Mock',host:'localhost',port:3306,user:'root',ssh:{enabled:false},workspaceId:app.activeWorkspaceId}];
      openTreeGroups.add('routines');
      openTreeGroups.add('events');
      renderSidebar();
      const result = document.querySelector('#connectionList').innerHTML;
      app.connections = previousConnections;
      return result;
    })()`);
    assert.match(html, /p_one/);
    assert.match(html, /f_one/);
    assert.match(html, /e_one/);
  });
  await check('routine details use SHOW CREATE and drop against the captured target', async () => {
    await evaluate("openRoutineDetails('procedure','p_one')");
    await until("$('#modal').open && Boolean($('#routineDrop'))");
    assert.match(await evaluate("$('#modal').textContent"), /CREATE PROCEDURE `p_one`/);
    await evaluate("$('#routineDrop').click()");
    await until("$('#modal').open && Boolean($('#confirmOk'))");
    await evaluate("$('#confirmOk').click()");
    await until("!$('#modal').open");
    const query = calls.filter((call) => call.name === 'db:query').at(-1).args[0];
    assert.equal(query.profileId, 'test');
    assert.equal(query.database, 'test');
    assert.equal(query.confirmed, true);
    assert.match(query.sql, /DROP PROCEDURE IF EXISTS `test`\.`p_one`/);
  });
  await check('saved queries save, reopen, rename and delete locally', async () => {
    await evaluate("app.query.sql='SELECT 42 AS answer'; app.query.profileId='test'; app.query.database='test'; app.query.savedQueryId=null; saveQuery()");
    await until("Boolean($('#savedQueryGo'))");
    await evaluate("$('#savedQueryName').value='Truy vấn kiểm tra'; $('#savedQueryGo').click()");
    await until('savedQueries.length === 1');
    assert.equal(await evaluate('savedQueries[0].sql'), 'SELECT 42 AS answer');
    assert.equal(await evaluate('savedQueries[0].profileId'), 'test');
    assert.equal(await evaluate('savedQueries[0].database'), 'test');
    const id = await evaluate('savedQueries[0].id');
    await evaluate(`openSavedQuery(${JSON.stringify(id)})`);
    assert.equal(await evaluate('app.query.sql'), 'SELECT 42 AS answer');
    assert.equal(await evaluate('app.query.savedQueryId'), id);
    await evaluate(`renameSavedQuery(${JSON.stringify(id)})`);
    await until("Boolean($('#renameSavedQueryGo'))");
    await evaluate("$('#renameSavedQueryName').value='Truy vấn đổi tên'; $('#renameSavedQueryGo').click()");
    assert.equal(await evaluate('savedQueries[0].name'), 'Truy vấn đổi tên');
    await evaluate(`void deleteSavedQuery(${JSON.stringify(id)})`);
    await until("Boolean($('#confirmOk'))");
    await evaluate("$('#confirmOk').click()");
    await until('savedQueries.length === 0');
  });
  await check('SSH trust preserves the connection form and accepted key for Save', async () => {
    sshTestResponses = [{ ok: false, error: { code: 'SSH_HOST_KEY_UNKNOWN', fingerprint: 'SHA256:test', message: 'Unknown key' } }];
    await evaluate("connection(); window.__sshForm=$('#connectionForm'); $('#connHost').value='localhost'; $('#connSsh').checked=true; $('#sshHost').value='ssh.test'; $('#connPassword').value='test-only'; $('#connTest').click()");
    await until("Boolean(document.querySelector('.confirmation-dialog'))");
    assert.equal(await evaluate("$('#connectionForm') === window.__sshForm && $('#modal').open"), true);
    await captureReview('ssh-trust');
    await evaluate("document.querySelector('.confirmation-dialog #confirmOk').click()");
    await until("!$('#connTest').disabled");
    assert.equal(await evaluate("$('#connPassword').value"), 'test-only');
    assert.equal(await evaluate("$('#connectionForm') === window.__sshForm && $('#modal').open"), true);
    assert.equal(await evaluate("document.querySelector('.confirmation-dialog') === null"), true);
    await evaluate("window.__connectTo=connectTo; window.__refreshConnections=refreshConnections; connectTo=async()=>{}; refreshConnections=async()=>{}; $('#connectionForm').requestSubmit()");
    await until("!$('#modal').open");
    const saved = calls.filter((call) => call.name === 'connections:save').at(-1).args[0];
    assert.equal(saved.ssh.knownHostKey.fingerprint, 'SHA256:test');
    await evaluate("connectTo=window.__connectTo; refreshConnections=window.__refreshConnections; delete window.__sshForm");
  });

  await check('canceling SSH trust and failing a retry both leave the form editable', async () => {
    const unknown = { ok: false, error: { code: 'SSH_HOST_KEY_CHANGED', fingerprint: 'SHA256:new', expectedFingerprint: 'SHA256:old', message: 'Changed key' } };
    sshTestResponses = [unknown];
    await evaluate("connection(); window.__sshForm=$('#connectionForm'); $('#connSsh').checked=true; $('#sshHost').value='ssh.test'; $('#connTest').click()");
    await until("Boolean(document.querySelector('.confirmation-dialog'))");
    await evaluate("document.querySelector('.confirmation-dialog #confirmCancel').click()");
    await until("!$('#connTest').disabled");
    assert.equal(await evaluate("$('#connectionForm') === window.__sshForm && $('#modal').open"), true);
    sshTestResponses = [unknown, { ok: false, error: { message: 'Expected authentication failure' } }];
    await evaluate("$('#connTest').click()");
    await until("Boolean(document.querySelector('.confirmation-dialog'))");
    await evaluate("document.querySelector('.confirmation-dialog #confirmOk').click()");
    await until("!$('#connTest').disabled");
    assert.match(await evaluate("$('#connError').textContent"), /Expected authentication failure/);
    assert.equal(await evaluate("$('#connectionForm') === window.__sshForm && !$('#connSubmit').disabled"), true);
    sshTestResponses = [unknown];
    await evaluate("$('#connTest').click()");
    await until("Boolean(document.querySelector('.confirmation-dialog'))");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await until("!document.querySelector('.confirmation-dialog') && !$('#connTest').disabled");
    assert.equal(await evaluate("$('#connectionForm') === window.__sshForm && $('#modal').open"), true);
    await evaluate("closeModal(); delete window.__sshForm");
  });

  await check('new connections default to verified TLS and every unverified mode is visible', async () => {
    await evaluate("window.__securityState={connections:app.connections,connection:app.connection,serverType:app.serverType,server:app.server,database:app.database,sessionState:app.sessionState}; connection(); $('#connSsl').checked=true; $('#connSsl').dispatchEvent(new Event('change'))");
    assert.equal(await evaluate("$('#connSslVerify').checked"), true);
    assert.equal(await evaluate("$('#connEnvironment').value"), 'unclassified');
    assert.equal(await evaluate("$('#connReadOnly').checked"), false);
    await evaluate("$('#connReadOnly').checked=true");
    await evaluate("$('#connEnvironment').value='production'");
    assert.equal(await evaluate("$('#connTlsWarning').classList.contains('hidden')"), true);
    await evaluate("$('#connSslVerify').checked=false; $('#connSslVerify').dispatchEvent(new Event('change'))");
    assert.match(await evaluate("$('#connTlsWarning').textContent"), /tắt xác thực chứng chỉ/i);
    await evaluate("$('#connSsh').checked=true; $('#connSsh').dispatchEvent(new Event('change'))");
    assert.match(await evaluate("$('#connSshWarning').textContent"), /chỉ bảo vệ đoạn từ máy này tới SSH host/i);
    await evaluate("$('#connHost').value='db.internal'; $('#connHost').dispatchEvent(new Event('input'))");
    assert.match(await evaluate("$('#connSshWarning').textContent"), /không mặc định an toàn toàn tuyến/i);
    await evaluate("closeModal(); connection({id:'legacy',name:'Legacy',host:'db.example',port:3306,user:'root',ssl:{enabled:true,verify:false,legacyUnverified:true},ssh:{enabled:false}});");
    assert.equal(await evaluate("$('#connSslVerify').checked"), false);
    assert.match(await evaluate("$('#connTlsWarning').textContent"), /phiên bản cũ/i);
    await evaluate("closeModal(); app.connections=[{id:'tls',name:'TLS',host:'db.example',port:3306,user:'root',ssl:{enabled:true,verify:false},ssh:{enabled:false},workspaceId:app.activeWorkspaceId}]; app.connection=app.connections[0]; app.serverType='mysql'; app.server='8.0'; app.database='test'; app.sessionState=null; setConnectionState('connected','Đã kết nối');");
    assert.match(await evaluate("$('#serverInfo').textContent"), /TLS chưa xác thực/);
    await evaluate("Object.assign(app, window.__securityState); delete window.__securityState; renderSidebar();");
  });

  await check('small SQL exports use the cancellable full-data task instead of a BLOB preview', async () => {
    await evaluate("app.query.result={kind:'rows',columns:[{name:'raw',type:'BLOB'}],rows:[['0x00… (64 bytes)']],truncated:false}; app.query.lastSql='SELECT raw FROM items'; app.query.profileId='test'; app.query.database='test'; window.__exportPromise=exportCurrentResult('json'); void 0");
    await until("Boolean(document.querySelector('[data-cancel-transfer]'))");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const payload = calls.filter((call) => call.name === 'db:export-query').at(-1).args[0];
    assert.match(payload.taskId, /^export-/);
    assert.match(await evaluate("$('#modal').textContent"), /SQL được chạy lại/);
    await captureReview('query-export');
    await evaluate("document.querySelector('[data-cancel-transfer]').click(); window.__exportPromise");
    await until("!$('#modal').open");
    assert.equal(await evaluate('activeTransfer'), null);
    assert.equal(calls.filter((call) => call.name === 'db:cancel-task').at(-1).args[0].taskId, payload.taskId);
  });

  await check('production review preserves the underlying draft and supports cancel, keyboard and exact-token approval', async () => {
    await evaluate(`modal('<h2>Draft</h2><input id="productionDraft" value="unsaved draft">');
      window.__productionResponse={ok:false,error:{code:'PRODUCTION_CONFIRM_REQUIRED',preview:{token:'review-fixture',connectionName:'Production <db>',host:'db.example',database:'sample',table:'users',operation:'update-row',selectedRows:1,columns:['name'],sql:'UPDATE sample.users SET name=? WHERE id=?',parameters:[{position:1,type:'string',value:'Đã ẩn'}],parameterCount:2,note:'Kiểm tra dữ liệu gốc trước khi ghi.'}}};
      window.__productionPending=call(Promise.resolve(window.__productionResponse)).catch(error=>({code:error.code}));void 0;`);
    await until("Boolean(document.querySelector('.production-confirmation[open]'))");
    assert.equal(await evaluate('document.activeElement.id'),'productionCancel');
    assert.match(await evaluate("document.querySelector('.production-confirmation').textContent"),/Production <db>/);
    assert.equal(await evaluate("document.querySelector('.production-confirmation').scrollWidth<=document.querySelector('.production-confirmation').clientWidth"),true);
    await captureReview('production-review');
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
    assert.equal((await evaluate('window.__productionPending')).code,'PRODUCTION_WRITE_CANCELLED');
    assert.equal(await evaluate("$('#productionDraft').value"),'unsaved draft');
    await evaluate('window.__productionPending=call(Promise.resolve(window.__productionResponse));void 0;');
    await until("Boolean(document.querySelector('.production-confirmation[open]'))");
    await evaluate("document.querySelector('#productionConfirm').click()");
    assert.equal((await evaluate('window.__productionPending')).affectedRows,1);
    assert.equal(calls.filter(call=>call.name==='db:confirm-production').at(-1).args[0],'review-fixture');
    await evaluate('closeModal()');
  });

  await check('production Commit preview explains that it applies to all tabs and is cancellable', async () => {
    await evaluate(`window.__commitPreviewPromise=confirmProductionWrite({token:'commit-fixture',connectionName:'Production',host:'root@db:3306',database:'sample',operation:'commit',selectedRows:null,sql:'COMMIT',parameters:[],parameterCount:0,inTransaction:true,autocommit:false,note:'Commit toàn bộ thay đổi của mọi tab dùng chung phiên.'});void 0;`);
    await until("Boolean(document.querySelector('.production-confirmation[open]'))");
    assert.match(await evaluate("document.querySelector('.production-confirmation').textContent"),/Commit toàn phiên/);
    assert.match(await evaluate("document.querySelector('.production-confirmation').textContent"),/mọi tab/);
    assert.equal(await evaluate('document.activeElement.id'),'productionCancel');
    await evaluate("document.querySelector('#productionCancel').click()");
    assert.equal(await evaluate('window.__commitPreviewPromise'),false);
  });

  await check('transaction toolbar identifies the session and protects busy actions', async () => {
    await evaluate(`window.__transactionReviewState={connection:app.connection,connections:app.connections,queryProfile:app.query.profileId,transactionState:app.transactionState};
      app.connection={id:'test',name:'Production',environment:'production'};app.connections=[app.connection];app.query.profileId='test';
      app.transactionState={profileId:'test',sessionId:'fixture-session',connected:true,inTransaction:true,autocommit:false,transactionRevision:1};renderTransactionBar();`);
    assert.match(await evaluate("$('#transactionBar').textContent"), /PRODUCTION/);
    assert.equal(await evaluate("document.querySelector('[data-transaction-action=commit]').disabled"), false);
    await evaluate("document.querySelector('[data-transaction-action=commit]').focus()");
    assert.equal(await evaluate("document.activeElement.dataset.transactionAction"), 'commit');
    await evaluate('app.transactionState.busy=true;renderTransactionBar()');
    assert.equal(await evaluate("document.querySelector('[data-transaction-action=commit]').disabled"), true);
    assert.equal(await evaluate("$('#transactionBar').scrollWidth <= $('#transactionBar').clientWidth"), true);
    await captureReview('transaction-toolbar');
    await evaluate('app.connection=window.__transactionReviewState.connection;app.connections=window.__transactionReviewState.connections;app.query.profileId=window.__transactionReviewState.queryProfile;app.transactionState=window.__transactionReviewState.transactionState;renderTransactionBar();');
  });

  await check('read-only connections display their policy and disable table writes', async () => {
    await evaluate(`window.__readOnlyState={connection:app.connection,connections:app.connections,primaryKey:app.primaryKey,mode};
      app.connection={id:'test',name:'Read only',environment:'production',readOnly:true};app.connections=[app.connection];
      app.primaryKey=['id']; mode='data'; renderDataView();`);
    for (const selector of ['#addRowBtn','#deleteRowsBtn','#importBtn']) assert.equal(await evaluate(`document.querySelector('${selector}').disabled`),true);
    assert.equal(await evaluate("$('#exportBtn').disabled"),false);
    assert.match(await evaluate("$('#workspace').textContent"),/Kết nối chỉ đọc/);
    await evaluate('renderTransactionBar()');
    await captureReview('read-only-table');
    await evaluate('app.connection=window.__readOnlyState.connection;app.connections=window.__readOnlyState.connections;app.primaryKey=window.__readOnlyState.primaryKey;mode=window.__readOnlyState.mode;renderQueryView();');
  });

  await check('backup details open by keyboard and fit a smaller window', async () => {
    await evaluate(`mode='backups'; app.selectedBackupId=null; app.backups=[{
      id:'20261111000000-1234abcd.sql',name:'Trước cập nhật',bytes:2048,createdAt:'2026-11-11T00:00:00Z',
      source:{database:'test'},selection:{includeStructure:true,includeData:true,tables:['users','items'],routines:['rebuild'],events:[]},
      result:{tables:2,rows:100},verification:{checksum:'verified'}
    }]; renderBackupsView(); document.querySelector('[data-backup-row]').focus();`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until("Boolean(document.querySelector('.backup-details'))");
    assert.match(await evaluate("document.querySelector('.backup-details').textContent"), /users/);
    assert.equal(await evaluate("document.querySelector('.backup-details').scrollWidth <= document.querySelector('.backup-details').clientWidth"), true);
    await captureReview('backup-details');
    await evaluate("window.__trialPromise=runBackupManagerAction('trial');void 0;");
    await until("Boolean($('#backupTrialReport [data-backup-action=cancel-trial]'))");
    await evaluate("$('#backupTrialReport [data-backup-action=cancel-trial]').click()");
    await evaluate('window.__trialPromise');
    assert.match(await evaluate("$('#backupTrialReport').textContent"),/Đã hủy/);
    assert.match(await evaluate("$('#backupTrialReport').textContent"),/Đã xóa/);
    await evaluate("window.__inspectionPromise=runBackupManagerAction('inspect');void 0;");
    await until("$('#backupInventory [data-inspection-progress]')?.textContent.includes('50%')");
    assert.match(await evaluate("$('#backupInventory').textContent"),/3 câu lệnh/);
    await evaluate("$('#backupInventory [data-backup-action=cancel-inspect]').click()");
    await evaluate('window.__inspectionPromise');
    assert.match(await evaluate("$('#backupInventory').textContent"),/Đã hủy quét/);
    await evaluate("runBackupManagerAction('trial-recovery')");
    assert.equal(await evaluate("document.querySelectorAll('[data-trial-cleanup]:disabled').length"), 1);
    await evaluate("document.querySelector('[data-trial-cleanup]:not(:disabled)').focus()");
    assert.equal(await evaluate("document.activeElement.hasAttribute('data-trial-cleanup')"), true);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until("$('#trialRecoveryStatus').textContent.includes('Đã xác nhận')");
    assert.equal(trialRecoveryCalls.length, 1);
    assert.equal(trialRecoveryCalls[0].id, 'a'.repeat(32));
    assert.equal(await evaluate("$('#modal .modal-card').scrollWidth <= $('#modal .modal-card').clientWidth"), true);
    await evaluate('closeModal()');
    await evaluate("app.backups=[]; app.selectedBackupId=null; mode='query'; renderQueryView();");
  });

  await check('selected-table source preview supports keyboard, flags missing FK, escapes names and never restores', async () => {
    const writesBefore = calls.filter(call => call.name === 'db:restore').length;
    await evaluate(`window.__selectionState={backups:app.backups,id:app.selectedBackupId};mode='backups';app.backups=[{id:'20261111000000-1234abcd.sql',name:'Selection',verification:{checksum:'verified'}}];app.selectedBackupId=app.backups[0].id;renderBackupsView();`);
    await evaluate("window.__selectionPromise=runBackupManagerAction('selection-preview');void 0");
    await untilNode(() => calls.at(-1)?.name === 'db:inspect-backup');
    pendingInspection(ok({ selectionPreview: selectionInventory }));
    await evaluate('window.__selectionPromise');
    assert.equal(await evaluate("document.activeElement.dataset.selectionIndex"), '0');
    assert.equal(await evaluate("$('#backupSelectionTables').querySelectorAll('img').length"), 0);
    assert.equal(await evaluate("$('#backupSelectionTables').querySelectorAll('input:checked').length"), 0);
    await evaluate("$('#backupSelectionTables input[data-selection-index=\"1\"]').click();$('#backupSelectionTables input[data-selection-index=\"1\"]').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return', modifiers: ['control'] });
    await until("$('#backupSelectionResult').textContent.includes('Chưa chọn bảng')");
    assert.equal(await evaluate("$('#backupSelectionResult').querySelectorAll('img').length"), 0);
    assert.match(await evaluate("$('#backupSelectionResult').textContent"), /Chưa có thao tác thực thi/);
    const request = calls.filter(call => call.name === 'db:preview-backup-selection').at(-1).args[0];
    assert.deepEqual(request.tables, ['<img src=x>']);
    assert.equal(request.profileId, await evaluate('app.connection.id'));
    await evaluate("$('#backupSelectionTables input[data-selection-index=\"0\"]').click();$('#previewBackupSelection').click()");
    await until("$('#backupSelectionResult').textContent.includes('users → <img src=x>')");
    assert.equal(await evaluate("$('#backupSelectionEditor').scrollWidth <= $('#backupSelectionEditor').clientWidth"), true);
    assert.equal(await evaluate("$('#backupSelectionEditor [data-click=close-modal]').getBoundingClientRect().bottom <= innerHeight"), true);
    await captureReview('backup-selection-preview');
    await evaluate("$('#selectionTargetDatabase').value='destination';$('#selectionTargetDatabase').dispatchEvent(new Event('input',{bubbles:true}));$('#reviewBackupSelectionTarget').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until("$('#backupSelectionResult').textContent.includes('Đối chiếu đích: destination')");
    assert.match(await evaluate("$('#backupSelectionResult').textContent"), /trùng view/);
    assert.match(await evaluate("$('#backupSelectionResult').textContent"), /ngoài lựa chọn tham chiếu/);
    assert.match(await evaluate("$('#backupSelectionResult').textContent"), /không phải quyền chạy/);
    assert.equal(await evaluate("$('#backupSelectionResult').querySelectorAll('img').length"), 0);
    await captureReview('backup-selection-target');
    await evaluate("$('#backupSelectionResult .backup-selection-draft summary').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until("$('#backupSelectionResult .backup-selection-draft').open");
    assert.match(await evaluate("$('#backupSelectionResult .backup-selection-draft').textContent"), /DROP cần chính sách/);
    assert.match(await evaluate("$('#backupSelectionResult .backup-selection-draft').textContent"), /Chưa thể thực thi/);
    assert.match(await evaluate("$('#backupSelectionResult .backup-selection-draft').textContent"), /2 khớp cú pháp literal/);
    assert.match(await evaluate("$('#backupSelectionResult .backup-selection-draft').textContent"), /1 chưa hỗ trợ/);
    assert.match(await evaluate("$('#backupSelectionResult .backup-selection-draft').textContent"), /biểu thức hoặc cú pháp chưa hỗ trợ/);
    assert.match(await evaluate("$('#backupSelectionResult .backup-selection-draft').textContent"), /1 bộ VALUES × 2 giá trị/);
    assert.match(await evaluate("$('#backupSelectionResult .backup-selection-draft').textContent"), /CREATE trong lựa chọn: 2 khớp cú pháp cơ bản/);
    assert.match(await evaluate("$('#backupSelectionResult .backup-selection-draft').textContent"), /CREATE TABLE cơ bản · 2 cột · 1 chỉ mục · InnoDB/);
    assert.match(await evaluate("$('#backupSelectionResult .backup-selection-draft').textContent"), /Khóa ngoại nguồn · 1 định nghĩa/);
    assert.match(await evaluate("$('#backupSelectionResult .backup-selection-draft').textContent"), /Thiết lập session toàn tệp: 5 khớp mẫu dump/);
    assert.match(await evaluate("$('#backupSelectionResult .backup-selection-draft').textContent"), /Trình tự lưu\/khôi phục: khớp mẫu/);
    assert.match(await evaluate("$('#backupSelectionResult .backup-selection-draft').textContent"), /Lưu và tạm tắt kiểm tra FK/);
    assert.match(await evaluate("$('#backupSelectionResult .backup-selection-draft').textContent"), /không xác nhận dữ liệu đã hợp lệ/);
    assert.equal(await evaluate("$('#backupSelectionResult .backup-selection-draft').querySelectorAll('button,img').length"), 0);
    await evaluate("$('#backupSelectionResult .backup-selection-draft').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-draft');
    await evaluate("[...$('#backupSelectionResult .backup-selection-draft').querySelectorAll('tbody tr')].find(row=>row.textContent.includes('INSERT literal')).scrollIntoView({block:'center'})");
    await captureReview('backup-selection-insert-syntax');
    await evaluate("[...$('#backupSelectionResult .backup-selection-draft').querySelectorAll('tbody tr')].find(row=>row.textContent.includes('CREATE TABLE cơ bản')).scrollIntoView({block:'center'})");
    await captureReview('backup-selection-create-syntax');
    await evaluate("[...$('#backupSelectionResult .backup-selection-draft').querySelectorAll('tbody tr')].find(row=>row.textContent.includes('SET dump')).scrollIntoView({block:'center'})");
    await captureReview('backup-selection-session-context');
    await evaluate("$('#backupSelectionResult .backup-selection-session-policy summary').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until("$('#backupSelectionResult .backup-selection-session-policy').open");
    assert.match(await evaluate("$('#backupSelectionResult .backup-selection-session-policy').textContent"), /Giữ kiểm tra FK bật/);
    assert.match(await evaluate("$('#backupSelectionResult .backup-selection-session-policy').textContent"), /NO_AUTO_VALUE_ON_ZERO, NO_ENGINE_SUBSTITUTION, STRICT_TRANS_TABLES/);
    assert.match(await evaluate("$('#backupSelectionResult .backup-selection-session-policy').textContent"), /không cam kết rollback toàn bộ DDL/);
    assert.equal(await evaluate("$('#backupSelectionResult .backup-selection-session-policy').querySelectorAll('button,img').length"), 0);
    await evaluate("$('#backupSelectionResult .backup-selection-session-policy').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-session-policy');
    await evaluate("$('#backupSelectionResult .backup-selection-values summary').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until("$('#backupSelectionResult .backup-selection-values').open");
    assert.match(await evaluate("$('#backupSelectionResult .backup-selection-values').textContent"), /Chưa kiểm chứng chuyển đổi kiểu/);
    assert.match(await evaluate("$('#backupSelectionResult .backup-selection-values').textContent"), /Chưa ánh xạ được vị trí vào cột/);
    assert.equal(await evaluate("$('#backupSelectionResult .backup-selection-values').querySelectorAll('button,img').length"), 0);
    await evaluate("$('#backupSelectionResult .backup-selection-values').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-values');
    win.setContentSize(900, 650);
    await until("innerWidth === 900 && innerHeight === 650");
    assert.equal(await evaluate("$('#backupSelectionEditor').scrollWidth <= $('#backupSelectionEditor').clientWidth"), true);
    assert.equal(await evaluate("$('#backupSelectionEditor [data-click=close-modal]').getBoundingClientRect().bottom <= innerHeight"), true);
    await captureReview('backup-selection-draft-small');
    await evaluate("[...$('#backupSelectionResult .backup-selection-draft').querySelectorAll('tbody tr')].find(row=>row.textContent.includes('INSERT literal')).scrollIntoView({block:'center'})");
    await captureReview('backup-selection-insert-syntax-small');
    await evaluate("[...$('#backupSelectionResult .backup-selection-draft').querySelectorAll('tbody tr')].find(row=>row.textContent.includes('CREATE TABLE cơ bản')).scrollIntoView({block:'center'})");
    await captureReview('backup-selection-create-syntax-small');
    await evaluate("[...$('#backupSelectionResult .backup-selection-draft').querySelectorAll('tbody tr')].find(row=>row.textContent.includes('SET dump')).scrollIntoView({block:'center'})");
    await captureReview('backup-selection-session-context-small');
    await evaluate("$('#backupSelectionResult .backup-selection-session-policy').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-session-policy-small');
    await evaluate("$('#backupSelectionResult .backup-selection-values').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-values-small');
    win.setContentSize(1344, 835);
    await until("innerWidth === 1344 && innerHeight === 835");
    await evaluate("$('#backupSelectionResult .backup-selection-draft').open=false");
    await evaluate("$('#backupSelectionResult .backup-column-review summary').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until("$('#backupSelectionResult .backup-column-review').open");
    assert.match(await evaluate("$('#backupSelectionResult .backup-column-review').textContent"), /Kiểu\/độ dài\/precision khác nhau/);
    assert.match(await evaluate("$('#backupSelectionResult .backup-column-review').textContent"), /Thứ tự hoặc số cột khác nhau/);
    assert.equal(await evaluate("$('#backupSelectionEditor').scrollWidth <= $('#backupSelectionEditor').clientWidth"), true);
    assert.equal(await evaluate("$('#backupSelectionEditor [data-click=close-modal]').getBoundingClientRect().bottom <= innerHeight"), true);
    await evaluate("$('#backupSelectionResult .backup-column-review').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-columns');
    win.setContentSize(900, 650);
    await until("innerWidth === 900 && innerHeight === 650");
    assert.equal(await evaluate("$('#backupSelectionEditor').scrollWidth <= $('#backupSelectionEditor').clientWidth"), true);
    assert.equal(await evaluate("$('#backupSelectionEditor [data-click=close-modal]').getBoundingClientRect().bottom <= innerHeight"), true);
    await captureReview('backup-selection-columns-small');
    win.setContentSize(1344, 835);
    await until("innerWidth === 1344 && innerHeight === 835");
    const stopPlanId = await evaluate("$('#backupSelectionResult .backup-selection-draft code').textContent");
    await evaluate("$('#selectionConflictPolicy').value='skip-existing';$('#selectionConflictPolicy').dispatchEvent(new Event('change',{bubbles:true}))");
    assert.equal(await evaluate("$('#backupSelectionResult').textContent"), '');
    await evaluate("$('#reviewBackupSelectionTarget').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until("Boolean($('#backupSelectionResult .backup-selection-policy'))");
    assert.equal(calls.filter(call => call.name === 'db:preview-backup-selection-target').at(-1).args[0].conflictPolicy, 'skip-existing');
    assert.notEqual(await evaluate("$('#backupSelectionResult .backup-selection-draft code').textContent"), stopPlanId);
    await evaluate("$('#backupSelectionResult .backup-selection-draft').open=true;$('#backupSelectionResult .backup-selection-policy summary').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until("$('#backupSelectionResult .backup-selection-policy').open");
    assert.match(await evaluate("$('#backupSelectionResult .backup-selection-policy').textContent"), /1 bảng dự kiến bỏ qua/);
    assert.match(await evaluate("$('#backupSelectionResult .backup-selection-policy').textContent"), /không thay hoặc tự bỏ qua view/);
    assert.equal(await evaluate("$('#backupSelectionResult .backup-selection-policy').querySelectorAll('button,img').length"), 0);
    await evaluate("$('#backupSelectionResult .backup-selection-policy').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-conflict-policy');
    await evaluate("$('#backupSelectionResult .backup-selection-source-fk summary').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until("$('#backupSelectionResult .backup-selection-source-fk').open");
    assert.match(await evaluate("$('#backupSelectionResult .backup-selection-source-fk').textContent"), /DELETE: SET NULL/);
    assert.match(await evaluate("$('#backupSelectionResult .backup-selection-source-fk').textContent"), /UPDATE: CASCADE/);
    assert.match(await evaluate("$('#backupSelectionResult .backup-selection-source-fk').textContent"), /Bảng được tham chiếu bị bỏ qua/);
    assert.match(await evaluate("$('#backupSelectionResult .backup-selection-source-fk').textContent"), /Thấy PRIMARY\/UNIQUE KEY đích khớp metadata cột/);
    assert.equal(await evaluate("$('#backupSelectionResult .backup-selection-source-fk').querySelectorAll('button,img').length"), 0);
    await evaluate("$('#backupSelectionResult .backup-selection-source-fk').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-source-foreign-keys');
    await evaluate("$('#backupSelectionResult .backup-target-foreign-keys summary').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until("$('#backupSelectionResult .backup-target-foreign-keys').open");
    assert.match(await evaluate("$('#backupSelectionResult .backup-target-foreign-keys').textContent"), /2 định nghĩa · 3 cặp cột/);
    assert.match(await evaluate("$('#backupSelectionResult .backup-target-foreign-keys').textContent"), /1: user_id → id/);
    assert.match(await evaluate("$('#backupSelectionResult .backup-target-foreign-keys').textContent"), /2: owner_email → email/);
    assert.match(await evaluate("$('#backupSelectionResult .backup-target-foreign-keys').textContent"), /DELETE: SET NULL/);
    assert.match(await evaluate("$('#backupSelectionResult .backup-target-foreign-keys').textContent"), /UPDATE: CASCADE/);
    assert.match(await evaluate("$('#backupSelectionResult .backup-target-foreign-keys').textContent"), /Bảng ngoài lựa chọn tham chiếu vào/);
    assert.equal(await evaluate("$('#backupSelectionResult .backup-target-foreign-keys').querySelectorAll('button,img').length"), 0);
    await evaluate("$('#backupSelectionResult .backup-target-foreign-keys').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-target-foreign-keys');
    await evaluate("$('#backupSelectionResult .backup-target-indexes summary').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until("$('#backupSelectionResult .backup-target-indexes').open");
    assert.match(await evaluate("$('#backupSelectionResult .backup-target-indexes').textContent"), /PRIMARY KEY/);
    assert.match(await evaluate("$('#backupSelectionResult .backup-target-indexes').textContent"), /email \(10\) ASC/);
    assert.match(await evaluate("$('#backupSelectionResult .backup-target-indexes').textContent"), /invisible\/ignored/);
    assert.match(await evaluate("$('#backupSelectionResult .backup-target-indexes').textContent"), /Visible \(optimizer\)/);
    assert.match(await evaluate("$('#backupSelectionResult .backup-target-indexes').textContent"), /Invisible \(optimizer\)/);
    assert.equal(await evaluate("$('#backupSelectionResult .backup-target-indexes').querySelectorAll('button,img').length"), 0);
    await evaluate("$('#backupSelectionResult .backup-target-indexes').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-target-indexes');
    win.setContentSize(900, 650);
    await until("innerWidth === 900 && innerHeight === 650");
    assert.equal(await evaluate("$('#backupSelectionEditor').scrollWidth <= $('#backupSelectionEditor').clientWidth"), true);
    assert.equal(await evaluate("$('#backupSelectionEditor [data-click=close-modal]').getBoundingClientRect().bottom <= innerHeight"), true);
    await captureReview('backup-selection-conflict-policy-small');
    await evaluate("$('#backupSelectionResult .backup-target-indexes').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-target-indexes-small');
    await evaluate("$('#backupSelectionResult .backup-target-foreign-keys').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-target-foreign-keys-small');
    await evaluate("$('#selectionTargetDatabase').value='comparison_destination';$('#selectionTargetDatabase').dispatchEvent(new Event('input',{bubbles:true}));$('#reviewBackupSelectionTarget').click()");
    await until("Boolean($('#backupSelectionResult .backup-fk-comparison'))");
    await evaluate("$('#backupSelectionResult .backup-selection-draft').open=true;$('#backupSelectionResult .backup-fk-comparison summary').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until("$('#backupSelectionResult .backup-fk-comparison').open");
    assert.match(await evaluate("$('#backupSelectionResult .backup-fk-comparison').textContent"), /Khác ON DELETE/);
    assert.match(await evaluate("$('#backupSelectionResult .backup-fk-comparison').textContent"), /Tên FK khác nhau/);
    assert.equal(await evaluate("$('#backupSelectionResult .backup-fk-comparison').querySelectorAll('button,img').length"), 0);
    assert.equal(await evaluate("$('#backupSelectionEditor').scrollWidth <= $('#backupSelectionEditor').clientWidth"), true);
    await evaluate("$('#backupSelectionResult .backup-fk-comparison').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-fk-comparison-small');
    win.setContentSize(1344, 835);
    await until("innerWidth === 1344 && innerHeight === 835");
    await evaluate("$('#backupSelectionResult .backup-fk-comparison').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-fk-comparison');
    win.setContentSize(900, 650);
    await until("innerWidth === 900 && innerHeight === 650");
    await evaluate("$('#backupSelectionResult .backup-selection-source-fk').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-source-foreign-keys-small');
    await evaluate("$('#selectionTargetDatabase').value='empty_destination';$('#selectionTargetDatabase').dispatchEvent(new Event('input',{bubbles:true}));$('#reviewBackupSelectionTarget').click()");
    await until("Boolean($('#backupSelectionResult .backup-selection-source-fk'))");
    await evaluate("$('#backupSelectionResult .backup-selection-draft').open=true;$('#backupSelectionResult .backup-selection-source-fk summary').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until("$('#backupSelectionResult .backup-selection-source-fk').open");
    assert.match(await evaluate("$('#backupSelectionResult .backup-selection-source-fk').textContent"), /Khóa nguồn: PRIMARY KEY \(id\)/);
    assert.match(await evaluate("$('#backupSelectionResult .backup-selection-source-fk').textContent"), /Chưa kiểm tra dòng mồ côi/);
    assert.equal(await evaluate("$('#backupSelectionResult .backup-selection-source-fk').querySelectorAll('button,img').length"), 0);
    assert.equal(await evaluate("$('#backupSelectionEditor').scrollWidth <= $('#backupSelectionEditor').clientWidth"), true);
    await evaluate("$('#backupSelectionResult .backup-selection-source-fk').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-referenced-key-small');
    win.setContentSize(1344, 835);
    await until("innerWidth === 1344 && innerHeight === 835");
    await evaluate("$('#backupSelectionResult .backup-selection-source-fk').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-referenced-key');
    await evaluate("$('#selectionConflictPolicy').value='stop-on-conflict';$('#selectionConflictPolicy').dispatchEvent(new Event('change',{bubbles:true}));$('#selectionStructure').click();$('#selectionTargetDatabase').value='decimal_destination';$('#selectionTargetDatabase').dispatchEvent(new Event('input',{bubbles:true}));$('#reviewBackupSelectionTarget').click()");
    await until("Boolean($('#backupSelectionResult .backup-selection-values'))");
    await evaluate("$('#backupSelectionResult .backup-selection-draft').open=true;$('#backupSelectionResult .backup-selection-values summary').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until("$('#backupSelectionResult .backup-selection-values').open");
    assert.match(await evaluate("$('#backupSelectionResult .backup-selection-values').textContent"), /không thể lưu nguyên vẹn/);
    assert.match(await evaluate("$('#backupSelectionResult .backup-selection-values').textContent"), /Có số âm ở cột DECIMAL UNSIGNED/);
    assert.match(await evaluate("$('#backupSelectionResult .backup-selection-values').textContent"), /Có số vượt phần nguyên của DECIMAL/);
    assert.match(await evaluate("$('#backupSelectionResult .backup-selection-values').textContent"), /2 DECIMAL cố định/);
    assert.match(await evaluate("$('#backupSelectionResult .backup-selection-values').textContent"), /Chuỗi số đúng mẫu: 3/);
    assert.equal(await evaluate("$('#backupSelectionResult .backup-selection-values').querySelectorAll('button,img').length"), 0);
    assert.equal((await evaluate("$('#backupSelectionResult .backup-selection-values').textContent")).includes('1.234'), false);
    await evaluate("$('#backupSelectionResult .backup-selection-values').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-decimal');
    await captureReview('backup-selection-numeric-strings');
    win.setContentSize(900, 650);
    await until("innerWidth === 900 && innerHeight === 650");
    assert.equal(await evaluate("$('#backupSelectionEditor').scrollWidth <= $('#backupSelectionEditor').clientWidth"), true);
    await evaluate("$('#backupSelectionResult .backup-selection-values').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-decimal-small');
    await captureReview('backup-selection-numeric-strings-small');
    win.setContentSize(1344, 835);
    await until("innerWidth === 1344 && innerHeight === 835");
    await evaluate("$('#selectionTargetDatabase').value='text_destination';$('#selectionTargetDatabase').dispatchEvent(new Event('input',{bubbles:true}));$('#reviewBackupSelectionTarget').click()");
    await until("Boolean($('#backupSelectionResult .backup-selection-values'))");
    await evaluate("$('#backupSelectionResult .backup-selection-draft').open=true;$('#backupSelectionResult .backup-selection-values summary').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until("$('#backupSelectionResult .backup-selection-values').open");
    const textReview = await evaluate("$('#backupSelectionResult .backup-selection-values').textContent");
    assert.match(textReview, /Có chuỗi vượt độ dài/); assert.match(textReview, /Có ký tự không biểu diễn được/);
    assert.match(textReview, /Có khoảng trắng cuối chuỗi/); assert.match(textReview, /Literal chuỗi: 1/);
    assert.equal(textReview.includes('Việt😀'), false); assert.equal(textReview.includes('abc '), false);
    assert.equal(await evaluate("$('#backupSelectionResult .backup-selection-values').querySelectorAll('button,img').length"), 0);
    await evaluate("$('#backupSelectionResult .backup-selection-values').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-text');
    win.setContentSize(900, 650);
    await until("innerWidth === 900 && innerHeight === 650");
    assert.equal(await evaluate("$('#backupSelectionEditor').scrollWidth <= $('#backupSelectionEditor').clientWidth"), true);
    await evaluate("$('#backupSelectionResult .backup-selection-values').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-text-small');
    await evaluate("$('#selectionTargetDatabase').value='omitted_destination';$('#selectionTargetDatabase').dispatchEvent(new Event('input',{bubbles:true}));$('#reviewBackupSelectionTarget').click()");
    await until("Boolean($('#backupSelectionResult .backup-selection-omitted'))");
    await evaluate("$('#backupSelectionResult .backup-selection-draft').open=true;$('#backupSelectionResult .backup-selection-omitted summary').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until("$('#backupSelectionResult .backup-selection-omitted').open");
    const omittedText = await evaluate("$('#backupSelectionResult .backup-selection-omitted').textContent");
    assert.match(omittedText, /Cột bắt buộc bị bỏ khỏi INSERT/);
    assert.match(omittedText, /Có DEFAULT nhưng chưa kiểm chứng/); assert.match(omittedText, /dự kiến NULL/);
    assert.equal(omittedText.includes('private-default'), false);
    assert.equal(await evaluate("$('#backupSelectionResult .backup-selection-omitted').querySelectorAll('button,img').length"), 0);
    assert.equal(await evaluate("$('#backupSelectionEditor').scrollWidth <= $('#backupSelectionEditor').clientWidth"), true);
    await evaluate("$('#backupSelectionResult .backup-selection-omitted').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-omitted-small');
    win.setContentSize(1344, 835);
    await until("innerWidth === 1344 && innerHeight === 835");
    await evaluate("$('#backupSelectionResult .backup-selection-omitted').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-omitted');
    await evaluate("$('#selectionTargetDatabase').value='temporal_destination';$('#selectionTargetDatabase').dispatchEvent(new Event('input',{bubbles:true}));$('#reviewBackupSelectionTarget').click()");
    await until("Boolean($('#backupSelectionResult .backup-selection-values'))");
    await evaluate("$('#backupSelectionResult .backup-selection-draft').open=true;$('#backupSelectionResult .backup-selection-values summary').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until("$('#backupSelectionResult .backup-selection-values').open");
    const temporalText = await evaluate("$('#backupSelectionResult .backup-selection-values').textContent");
    assert.match(temporalText, /lịch Gregorian/); assert.match(temporalText, /thành phần ngày bằng 0/);
    assert.match(temporalText, /phần lẻ giây không thể lưu nguyên vẹn/); assert.match(temporalText, /Chuỗi ngày giờ đúng mẫu: 2/);
    assert.equal(temporalText.includes('1900-02-29'), false); assert.equal(temporalText.includes('2024-02-29'), false);
    assert.equal(await evaluate("$('#backupSelectionResult .backup-selection-values').querySelectorAll('button,img').length"), 0);
    await evaluate("$('#backupSelectionResult .backup-selection-values').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-temporal');
    win.setContentSize(900, 650);
    await until("innerWidth === 900 && innerHeight === 650");
    assert.equal(await evaluate("$('#backupSelectionEditor').scrollWidth <= $('#backupSelectionEditor').clientWidth"), true);
    await evaluate("$('#backupSelectionResult .backup-selection-values').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-temporal-small');
    await evaluate("$('#selectionTargetDatabase').value='packet_destination';$('#selectionTargetDatabase').dispatchEvent(new Event('input',{bubbles:true}));$('#reviewBackupSelectionTarget').click()");
    await until("Boolean($('#backupSelectionResult .backup-selection-packets'))");
    await evaluate("$('#backupSelectionResult .backup-selection-draft').open=true;$('#backupSelectionResult .backup-selection-packets summary').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until("$('#backupSelectionResult .backup-selection-packets').open");
    const packetText = await evaluate("$('#backupSelectionResult .backup-selection-packets').textContent");
    assert.match(packetText, /vượt max_allowed_packet/); assert.match(packetText, /Chưa kiểm chứng giới hạn client/);
    assert.equal(packetText.includes('private-packet-'), false);
    assert.equal(await evaluate("$('#backupSelectionResult .backup-selection-packets').querySelectorAll('button,img').length"), 0);
    assert.equal(await evaluate("$('#backupSelectionEditor').scrollWidth <= $('#backupSelectionEditor').clientWidth"), true);
    await evaluate("$('#backupSelectionResult .backup-selection-packets').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-packets-small');
    win.setContentSize(1344, 835);
    await until("innerWidth === 1344 && innerHeight === 835");
    await evaluate("$('#backupSelectionResult .backup-selection-packets').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-packets');
    await evaluate("$('#selectionTargetDatabase').value='time_destination';$('#selectionTargetDatabase').dispatchEvent(new Event('input',{bubbles:true}));$('#reviewBackupSelectionTarget').click()");
    await until("Boolean($('#backupSelectionResult .backup-selection-values'))");
    await evaluate("$('#backupSelectionResult .backup-selection-draft').open=true;$('#backupSelectionResult .backup-selection-values summary').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until("$('#backupSelectionResult .backup-selection-values').open");
    const timeText = await evaluate("$('#backupSelectionResult .backup-selection-values').textContent");
    assert.match(timeText, /TIME nhận thời lượng/); assert.match(timeText, /giờ trên 23 và dấu âm/);
    assert.match(timeText, /ngoài phạm vi kiểu ngày giờ/); assert.match(timeText, /phần lẻ giây không thể lưu nguyên vẹn/);
    assert.equal(timeText.includes('123:45:56'), false); assert.equal(timeText.includes('839:00:00'), false);
    assert.equal(await evaluate("$('#backupSelectionResult .backup-selection-values').querySelectorAll('button,img').length"), 0);
    await evaluate("$('#backupSelectionResult .backup-selection-values').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-time');
    win.setContentSize(900, 650);
    await until("innerWidth === 900 && innerHeight === 650");
    assert.equal(await evaluate("$('#backupSelectionEditor').scrollWidth <= $('#backupSelectionEditor').clientWidth"), true);
    await evaluate("$('#backupSelectionResult .backup-selection-values').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-time-small');
    await evaluate("$('#selectionTargetDatabase').value='year_destination';$('#selectionTargetDatabase').dispatchEvent(new Event('input',{bubbles:true}));$('#reviewBackupSelectionTarget').click()");
    await until("Boolean($('#backupSelectionResult .backup-selection-values'))");
    await evaluate("$('#backupSelectionResult .backup-selection-draft').open=true;$('#backupSelectionResult .backup-selection-values summary').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until("$('#backupSelectionResult .backup-selection-values').open");
    const yearText = await evaluate("$('#backupSelectionResult .backup-selection-values').textContent");
    assert.match(yearText, /ngoài phạm vi YEAR/); assert.match(yearText, /YEAR có giá trị rút gọn/); assert.match(yearText, /Literal YEAR được phân loại: 3/);
    assert.equal(yearText.includes('2156'), false); assert.equal(yearText.includes('2069'), false);
    assert.equal(await evaluate("$('#backupSelectionResult .backup-selection-values').querySelectorAll('button,img').length"), 0);
    assert.equal(await evaluate("$('#backupSelectionEditor').scrollWidth <= $('#backupSelectionEditor').clientWidth"), true);
    await evaluate("$('#backupSelectionResult .backup-selection-values').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-year-small');
    win.setContentSize(1344, 835);
    await until("innerWidth === 1344 && innerHeight === 835");
    await evaluate("$('#backupSelectionResult .backup-selection-values').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-year');
    await evaluate("$('#selectionTargetDatabase').value='timestamp_destination';$('#selectionTargetDatabase').dispatchEvent(new Event('input',{bubbles:true}));$('#reviewBackupSelectionTarget').click()");
    await until("Boolean($('#backupSelectionResult .backup-selection-values'))");
    await evaluate("$('#backupSelectionResult .backup-selection-draft').open=true;$('#backupSelectionResult .backup-selection-values summary').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until("$('#backupSelectionResult .backup-selection-values').open");
    const timestampText = await evaluate("$('#backupSelectionResult .backup-selection-values').textContent");
    assert.match(timestampText, /TIMESTAMP kiểm tra lịch và phần lẻ giây/);
    assert.match(timestampText, /TIMESTAMP cần kiểm chứng múi giờ nguồn\/đích, DST và phạm vi lưu của server/);
    assert.match(timestampText, /phần lẻ giây không thể lưu nguyên vẹn/); assert.match(timestampText, /Chuỗi ngày giờ đúng mẫu: 1/);
    assert.equal(timestampText.includes('2024-02-29'), false);
    assert.equal(await evaluate("$('#backupSelectionResult .backup-selection-values').querySelectorAll('button,img').length"), 0);
    await evaluate("$('#backupSelectionResult .backup-selection-values').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-timestamp');
    win.setContentSize(900, 650);
    await until("innerWidth === 900 && innerHeight === 650");
    assert.equal(await evaluate("$('#backupSelectionEditor').scrollWidth <= $('#backupSelectionEditor').clientWidth"), true);
    await evaluate("$('#backupSelectionResult .backup-selection-values').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-timestamp-small');
    await evaluate("$('#selectionTargetDatabase').value='checks_destination';$('#selectionTargetDatabase').dispatchEvent(new Event('input',{bubbles:true}));$('#reviewBackupSelectionTarget').click()");
    await until("Boolean($('#backupSelectionResult .backup-selection-checks'))");
    await evaluate("$('#backupSelectionResult .backup-selection-checks summary').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until("$('#backupSelectionResult .backup-selection-checks').open");
    const checksText = await evaluate("$('#backupSelectionResult .backup-selection-checks').textContent");
    assert.match(checksText, /CHECK ở đích/); assert.match(checksText, /1 định nghĩa quan sát được/);
    assert.match(checksText, /ENFORCED chỉ là metadata/); assert.match(checksText, /chưa kiểm chứng dữ liệu phục hồi/);
    assert.match(checksText, /check_constraint_checks của phiên kiểm tra: tắt/); assert.match(checksText, /Phiên đích đang tắt check_constraint_checks/);
    assert.equal(checksText.includes('c'.repeat(64)), false);
    assert.equal(await evaluate("$('#backupSelectionResult .backup-selection-checks').querySelectorAll('button,img').length"), 0);
    assert.equal(await evaluate("$('#backupSelectionEditor').scrollWidth <= $('#backupSelectionEditor').clientWidth"), true);
    await evaluate("$('#backupSelectionResult .backup-selection-checks').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-checks-small');
    win.setContentSize(1344, 835);
    await until("innerWidth === 1344 && innerHeight === 835");
    await evaluate("$('#backupSelectionResult .backup-selection-checks').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-checks');
    await evaluate("$('#backupSelectionResult .backup-selection-engines summary').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until("$('#backupSelectionResult .backup-selection-engines').open");
    const enginesText = await evaluate("$('#backupSelectionResult .backup-selection-engines').textContent");
    assert.match(enginesText, /MyISAM/); assert.match(enginesText, /Engine ngoài phạm vi/); assert.match(enginesText, /InnoDB chưa bảo đảm rollback toàn bộ/);
    assert.equal(await evaluate("$('#backupSelectionResult .backup-selection-engines').querySelectorAll('button,img').length"), 0);
    await evaluate("$('#backupSelectionResult .backup-selection-engines').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-engines');
    win.setContentSize(900, 650);
    await until("innerWidth === 900 && innerHeight === 650");
    assert.equal(await evaluate("$('#backupSelectionEditor').scrollWidth <= $('#backupSelectionEditor').clientWidth"), true);
    await evaluate("$('#backupSelectionResult .backup-selection-engines').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-engines-small');
    win.setContentSize(1344, 835);
    await until("innerWidth === 1344 && innerHeight === 835");
    await evaluate("$('#backupSelectionResult .backup-selection-triggers summary').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until("$('#backupSelectionResult .backup-selection-triggers').open");
    const triggerText = await evaluate("$('#backupSelectionResult .backup-selection-triggers').textContent");
    assert.match(triggerText, /Trigger ở đích/); assert.match(triggerText, /AFTER INSERT/); assert.match(triggerText, /Chưa phân tích nội dung và tác động gián tiếp/);
    assert.match(triggerText, /1 định nghĩa quan sát được/); assert.equal(triggerText.includes('d'.repeat(64)), false); assert.equal(triggerText.includes('e'.repeat(64)), false);
    assert.equal(await evaluate("$('#backupSelectionResult .backup-selection-triggers').querySelectorAll('button,img').length"), 0);
    await evaluate("$('#backupSelectionResult .backup-selection-triggers').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-triggers');
    win.setContentSize(900, 650);
    await until("innerWidth === 900 && innerHeight === 650");
    assert.equal(await evaluate("$('#backupSelectionEditor').scrollWidth <= $('#backupSelectionEditor').clientWidth"), true);
    await evaluate("$('#backupSelectionResult .backup-selection-triggers').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-triggers-small');
    win.setContentSize(1344, 835);
    await until("innerWidth === 1344 && innerHeight === 835");
    await evaluate("$('#backupSelectionResult .backup-selection-expressions summary').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until("$('#backupSelectionResult .backup-selection-expressions').open");
    const expressionText = await evaluate("$('#backupSelectionResult .backup-selection-expressions').textContent");
    assert.match(expressionText, /DEFAULT\/generated ở đích/); assert.match(expressionText, /chưa đối chiếu DEFAULT\/generated nguồn và đích/);
    assert.match(expressionText, /Chưa kiểm chứng giá trị và ngữ nghĩa DEFAULT/); assert.match(expressionText, /Chưa kiểm chứng giá trị do generated tạo ra/);
    assert.equal(expressionText.includes('7'.repeat(64)), false); assert.equal(expressionText.includes('8'.repeat(64)), false);
    assert.equal(await evaluate("$('#backupSelectionResult .backup-selection-expressions').querySelectorAll('button,img').length"), 0);
    await evaluate("$('#backupSelectionResult .backup-selection-expressions').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-expressions');
    win.setContentSize(900, 650);
    await until("innerWidth === 900 && innerHeight === 650");
    assert.equal(await evaluate("$('#backupSelectionEditor').scrollWidth <= $('#backupSelectionEditor').clientWidth"), true);
    await evaluate("$('#backupSelectionResult .backup-selection-expressions').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-expressions-small');
    win.setContentSize(1344, 835);
    await until("innerWidth === 1344 && innerHeight === 835");
    await evaluate("$('#selectionTargetDatabase').value='unique_destination';$('#selectionTargetDatabase').dispatchEvent(new Event('input',{bubbles:true}));$('#reviewBackupSelectionTarget').click()");
    await until("Boolean($('#backupSelectionResult .backup-selection-session-policy'))");
    await evaluate("$('#backupSelectionResult .backup-selection-draft').open=true;$('#backupSelectionResult .backup-selection-session-policy summary').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until("$('#backupSelectionResult .backup-selection-session-policy').open");
    const uniqueText = await evaluate("$('#backupSelectionResult .backup-selection-session-policy').textContent");
    assert.match(uniqueText, /unique_checks tắt/); assert.match(uniqueText, /đang tắt unique_checks/);
    assert.match(uniqueText, /Bật unique_checks không chứng minh dữ liệu không trùng khóa/);
    assert.equal(await evaluate("$('#backupSelectionResult .backup-selection-session-policy').querySelectorAll('button,img').length"), 0);
    await evaluate("$('#backupSelectionResult .backup-selection-session-policy').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-unique-checks');
    win.setContentSize(900, 650);
    await until("innerWidth === 900 && innerHeight === 650");
    assert.equal(await evaluate("$('#backupSelectionEditor').scrollWidth <= $('#backupSelectionEditor').clientWidth"), true);
    await evaluate("$('#backupSelectionResult .backup-selection-session-policy').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-unique-checks-small');
    win.setContentSize(1344, 835);
    await until("innerWidth === 1344 && innerHeight === 835");
    assert.match(await evaluate("$('#backupSelectionResult .backup-selection-drift').textContent"), /Đã ghi nhận mốc so sánh/);
    await evaluate("$('#reviewBackupSelectionTarget').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until("$('#backupSelectionResult .backup-selection-drift')?.textContent.includes('Chưa thấy thay đổi trong tệp và metadata')");
    // unique_destination has no visible triggers, so use checks_destination to
    // observe an actual same-name body digest change across fresh fixtures.
    await evaluate("$('#selectionTargetDatabase').value='checks_destination';$('#selectionTargetDatabase').dispatchEvent(new Event('input',{bubbles:true}));$('#reviewBackupSelectionTarget').click()");
    await until("$('#backupSelectionResult .backup-selection-drift')?.textContent.includes('Đã ghi nhận mốc so sánh')");
    selectionMetadataChanged = true;
    await evaluate("$('#reviewBackupSelectionTarget').click()");
    await until("$('#backupSelectionResult .backup-selection-drift')?.textContent.includes('Metadata/ngữ cảnh đích đã quan sát: đã thay đổi')");
    const driftText = await evaluate("$('#backupSelectionResult .backup-selection-drift').textContent");
    assert.match(driftText, /Tệp backup: chưa thấy thay đổi/); assert.match(driftText, /Bản nháp kế hoạch: đã thay đổi/);
    assert.match(driftText, /không theo dõi dữ liệu dòng/);
    assert.equal(await evaluate("$('#backupSelectionResult .backup-selection-drift').querySelectorAll('button,img').length"), 0);
    await evaluate("$('#backupSelectionResult .backup-selection-drift').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-drift');
    win.setContentSize(900, 650);
    await until("innerWidth === 900 && innerHeight === 650");
    assert.equal(await evaluate("$('#backupSelectionEditor').scrollWidth <= $('#backupSelectionEditor').clientWidth"), true);
    await evaluate("$('#backupSelectionResult .backup-selection-drift').scrollIntoView({block:'start'})");
    await captureReview('backup-selection-drift-small');
    selectionMetadataChanged = false;
    holdSelectionTarget = true;
    await evaluate("$('#reviewBackupSelectionTarget').click()");
    await untilNode(() => Boolean(pendingSelectionTarget));
    await evaluate("$('#cancelSelectionScan').click()");
    await until("$('#backupSelectionStatus').textContent.includes('Đã hủy kiểm tra đích')");
    holdSelectionTarget = false;
    await evaluate("$('#selectionData').click()");
    assert.equal(await evaluate("$('#backupSelectionResult').textContent"), '');
    assert.equal(calls.filter(call => call.name === 'db:restore').length, writesBefore);
    await evaluate("closeModal();app.backups=window.__selectionState.backups;app.selectedBackupId=window.__selectionState.id;mode='query';renderQueryView()");
  });

  await check('backup notes save by keyboard, pin protects deletion and failures preserve the draft', async () => {
    await evaluate(`window.__annotationDatabase=app.database; mode='backups';
      app.selectedBackupId='20261111000000-1234abcd.sql'; app.backups=[{
        id:app.selectedBackupId,name:'Trước nâng cấp',bytes:2048,createdAt:'2026-11-11T00:00:00Z',note:'',pinned:false
      }];renderBackupsView();runBackupManagerAction('annotations');`);
    assert.equal(await evaluate('document.activeElement.id'), 'backupNoteInput');
    await evaluate(`$('#backupNoteInput').value='Trước nâng cấp\\n<img src=x onerror=alert(1)>';$('#backupPinnedInput').checked=true;`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return', modifiers: ['control'] });
    await until("!$('#modal').open");
    assert.equal(annotationCalls.at(-1).patch.pinned, true);
    assert.equal(await evaluate("document.querySelector('[data-backup-action=delete]').disabled"), true);
    assert.equal(await evaluate("Boolean(document.querySelector('[data-backup-row] [aria-label=\"Đã ghim\"]'))"), true);
    assert.equal(await evaluate("document.querySelectorAll('.backup-user-note img').length"), 0);
    assert.equal(await evaluate("document.activeElement.dataset.backupRow"), '20261111000000-1234abcd.sql');
    assert.equal(await evaluate("document.querySelector('.backup-details').scrollWidth <= document.querySelector('.backup-details').clientWidth"), true);
    annotationFailure = true;
    await evaluate("runBackupManagerAction('annotations');$('#backupNoteInput').value='Bản nháp chưa lưu';$('#backupPinnedInput').checked=false;$('#saveBackupAnnotations').click()");
    await until("$('#backupAnnotationStatus').textContent.includes('Không đủ dung lượng')");
    assert.equal(await evaluate("$('#backupNoteInput').value"), 'Bản nháp chưa lưu');
    assert.equal(await evaluate('app.backups[0].pinned'), true);
    assert.equal(await evaluate("$('#saveBackupAnnotations').disabled"), false);
    annotationFailure = false;
    await evaluate("$('#saveBackupAnnotations').click()");
    await until("!$('#modal').open");
    assert.equal(await evaluate("document.querySelector('[data-backup-action=delete]').disabled"), false);
    holdAnnotations = true;
    await evaluate("runBackupManagerAction('annotations');$('#saveBackupAnnotations').click()");
    await until("$('#saveBackupAnnotations').disabled");
    await evaluate("app.database='other-database';modal('<h2 id=annotationReplacement>Hộp thoại mới</h2>')");
    pendingAnnotations(ok({ note: 'late result', pinned: true }));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(await evaluate("Boolean($('#annotationReplacement')) && $('#modal').open"), true);
    assert.equal(await evaluate('app.backups[0].pinned'), false);
    holdAnnotations = false;
    await evaluate("closeModal();app.database=window.__annotationDatabase;app.backups=[];app.selectedBackupId=null;mode='query';renderQueryView()");
  });

  await check('retention preview explains protected backups, validates limits and discards stale results', async () => {
    const deletedBefore = calls.filter(call => call.name === 'db:delete-backup').length;
    await evaluate("mode='backups';renderBackupsView();runBackupManagerAction('retention-preview')");
    assert.equal(await evaluate('document.activeElement.id'), 'retentionCount');
    await evaluate("$('#retentionCount').value='1';$('#retentionAge').value='30';$('#retentionMiB').value='2'");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return', modifiers: ['control'] });
    await until("Boolean($('#backupRetentionResult table'))");
    assert.deepEqual(retentionCalls.at(-1).policy, { maxCount: 1, maxAgeDays: 30, maxBytes: 2097152 });
    assert.match(await evaluate("$('#backupRetentionResult').textContent"), /Đã ghim/);
    assert.match(await evaluate("$('#backupRetentionResult').textContent"), /Chưa có tệp nào bị xóa/);
    assert.equal(await evaluate("$('#backupRetentionResult').querySelectorAll('img').length"), 0);
    assert.equal(await evaluate("$('#backupRetentionEditor').scrollWidth <= $('#backupRetentionEditor').clientWidth"), true);
    assert.equal(await evaluate("$('#applyRetentionBtn').disabled"), false);
    await evaluate("$('#applyRetentionBtn').click()");
    await until("$('#backupRetentionResult').textContent.includes('Đã hủy')");
    assert.equal(calls.filter(call => call.name === 'db:apply-backup-retention').at(-1).args[0].token, 'retention-smoke-token');
    assert.equal(await evaluate("$('#applyRetentionBtn').disabled"), true);
    holdRetentionApply = true;
    await evaluate("$('#previewRetentionBtn').click()");
    await until("!$('#applyRetentionBtn').disabled");
    await evaluate("$('#applyRetentionBtn').click()");
    await until("!$('#stopRetentionBtn').disabled");
    assert.match(await evaluate("$('#retentionTaskStatus').textContent"), /Đang xác minh/);
    await evaluate("$('#stopRetentionBtn').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until("$('#retentionTaskStatus').textContent.includes('Đã dừng')");
    await until("$('#stopRetentionBtn').hidden");
    holdRetentionApply = false;
    await until("!$('#saveRetentionPolicyBtn').disabled");
    assert.equal(await evaluate("$('#retentionAutomatic').checked"), false);
    await evaluate("$('#retentionAutomatic').checked=true;$('#retentionAutomatic').dispatchEvent(new Event('input',{bubbles:true}))");
    await evaluate("$('#saveRetentionPolicyBtn').click()");
    await until("$('#backupRetentionPolicyStatus').textContent.includes('Đã lưu chính sách')");
    assert.deepEqual(savedRetentionPolicy, { maxCount: 1, maxAgeDays: 30, maxBytes: 2097152 });
    await evaluate("closeModal();runBackupManagerAction('retention-preview')");
    await until("!$('#saveRetentionPolicyBtn').disabled");
    assert.equal(await evaluate("$('#retentionCount').value"), '1');
    assert.equal(await evaluate("$('#retentionAge').value"), '30');
    assert.equal(await evaluate("$('#retentionMiB').value"), '2');
    assert.equal(await evaluate("$('#retentionAutomatic').checked"), true);
    await evaluate("$('#clearRetentionPolicyBtn').click()");
    await until("$('#backupRetentionPolicyStatus').textContent.includes('Đã xóa chính sách')");
    assert.equal(savedRetentionPolicy, null);
    assert.equal(savedRetentionAutomatic, false);
    const before = retentionCalls.length;
    await evaluate("$('#retentionCount').value='0';$('#previewRetentionBtn').click()");
    await until("$('#backupRetentionResult').textContent.includes('số nguyên dương')");
    assert.equal(retentionCalls.length, before);
    holdRetention = true;
    await evaluate("$('#retentionCount').value='2';$('#previewRetentionBtn').click()");
    await until("$('#previewRetentionBtn').disabled");
    await evaluate("$('#retentionCount').value='5';$('#retentionCount').dispatchEvent(new Event('input',{bubbles:true}))");
    pendingRetention(ok(retentionFixture));
    await until("!$('#previewRetentionBtn').disabled");
    assert.match(await evaluate("$('#backupRetentionResult').textContent"), /Giới hạn đã thay đổi/);
    await evaluate("$('#previewRetentionBtn').click()");
    await until("$('#previewRetentionBtn').disabled");
    await evaluate("modal('<h2 id=retentionReplacement>Hộp thoại mới</h2>')");
    pendingRetention(ok(retentionFixture));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(await evaluate("Boolean($('#retentionReplacement')) && $('#modal').open"), true);
    assert.equal(calls.filter(call => call.name === 'db:delete-backup').length, deletedBefore);
    holdRetention = false;
    await evaluate("closeModal();mode='query';renderQueryView()");
  });

  await check('retention history distinguishes incomplete reports and expands with the keyboard', async () => {
    await evaluate("mode='backups';renderBackupsView();runBackupManagerAction('retention-history')");
    await until("Boolean($('#retentionHistoryResult details'))");
    assert.match(await evaluate("$('#retentionHistoryResult').textContent"), /Chưa xác nhận kết thúc/);
    assert.equal(await evaluate("$('#retentionHistoryView').scrollWidth <= $('#retentionHistoryView').clientWidth"), true);
    await evaluate("$('#retentionHistoryResult summary').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until("$('#retentionHistoryResult details').open");
    assert.match(await evaluate("$('#retentionHistoryResult details').textContent"), /20260101000000-aaaaaaaa.sql/);
    await evaluate("$('#exportRetentionHistoryBtn').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until("$('#retentionHistoryExportStatus').textContent.includes('Đã xuất 1')");
    assert.equal(historyExportCalls.length, 1);
    assert.equal(historyExportCalls[0].database, await evaluate('app.database'));
    await evaluate("closeModal();mode='query';renderQueryView()");
  });

  await check('backup schedule supports keyboard save, native Cancel, pause, reload and deleting only the schedule', async () => {
    const deletesBefore = calls.filter(call => call.name === 'db:delete-backup').length;
    await evaluate("mode='backups';renderBackupsView();runBackupManagerAction('schedule')");
    await until("!$('#saveBackupSchedule').disabled");
    assert.equal(await evaluate('document.activeElement.id'), 'backupScheduleHours');
    assert.equal(await evaluate("$('#backupScheduleEditor').scrollWidth <= $('#backupScheduleEditor').clientWidth"), true);
    await captureReview('backup-schedule');
    await evaluate("$('#backupScheduleHours').value='8';$('#backupScheduleHours').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return', modifiers: ['control'] });
    await until("$('#backupScheduleMessage').textContent.includes('Đã hủy lưu')");
    assert.equal(await evaluate("$('#backupScheduleHours').value"), '8');
    cancelScheduleSave = false;
    await evaluate("$('#saveBackupSchedule').click()");
    await until("$('#backupScheduleMessage').textContent.includes('Đã lưu và bật')");
    assert.equal(savedSchedule.intervalHours, 8);
    assert.equal(savedSchedule.profileId, await evaluate('app.connection.id'));
    assert.equal(savedSchedule.database, await evaluate('app.database'));
    await evaluate("closeModal();runBackupManagerAction('schedule')");
    await until("!$('#saveBackupSchedule').disabled");
    assert.equal(await evaluate("$('#backupScheduleHours').value"), '8');
    await evaluate("$('#pauseBackupSchedule').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until("$('#backupScheduleMessage').textContent.includes('Đã tạm dừng lịch')");
    assert.equal(savedSchedule.enabled, false);
    await evaluate("$('#deleteBackupSchedule').click()");
    await until("$('#backupScheduleMessage').textContent.includes('Đã xóa lịch')");
    assert.equal(savedSchedule, null);
    assert.equal(calls.filter(call => call.name === 'db:delete-backup').length, deletesBefore);
    win.webContents.send('db:progress', { scheduled: true, operation: 'backup', stage: 'scheduled-finish', status: 'completed', database: 'scheduled-db' });
    await until("$('#status').textContent.includes('Đã lưu backup theo lịch · scheduled-db')");
    await evaluate("closeModal();mode='query';renderQueryView()");
  });

  await check('backup includes routines, events and the strip-DEFINER option', async () => {
    const before = calls.filter((call) => call.name === 'db:backup').length;
    holdBackup = true;
    await evaluate('backupDatabase()');
    await until("Boolean(document.querySelector('#backupRoutineList .backup-routine'))");
    await until("Boolean(document.querySelector('#backupEventList .backup-event'))");
    assert.equal(await evaluate("document.querySelectorAll('#backupRoutineList .backup-routine').length"), 2);
    assert.equal(await evaluate("document.querySelectorAll('#backupEventList .backup-event').length"), 1);
    await evaluate("$('#backupTableSearch').value='TABLE_1'; $('#backupTableSearch').dispatchEvent(new Event('input', { bubbles: true }))");
    assert.equal(await evaluate("document.querySelectorAll('#backupTableList .backup-table').length"), tables.length);
    assert.equal(await evaluate("[...document.querySelectorAll('#backupTableList .backup-table')].filter(box => !box.closest('label').hidden).length"), 5);
    await evaluate("$('#backupDeselectVisible').click()");
    assert.equal(await evaluate("[...document.querySelectorAll('#backupTableList .backup-table')].filter(box => !box.closest('label').hidden && box.checked).length"), 0);
    assert.equal(await evaluate("[...document.querySelectorAll('#backupTableList .backup-table')].filter(box => box.closest('label').hidden && box.checked).length"), tables.length - 5);
    await evaluate("$('#backupTableSearch').value=''; $('#backupTableSearch').dispatchEvent(new Event('input', { bubbles: true })); $('#backupAll').click()");
    assert.equal(await evaluate("document.querySelectorAll('#backupTableList .backup-table:checked').length"), tables.length);
    await evaluate("$('#backupStripDefiner').checked=true; $('#backupGo').click()");
    await untilNode(() => calls.filter((call) => call.name === 'db:backup').length > before);
    const payload = calls.filter((call) => call.name === 'db:backup').at(-1).args[0];
    assert.equal(payload.profileId, 'test');
    assert.equal(payload.database, 'test');
    assert.ok(payload.tables.includes('users'));
    assert.equal(payload.tables.length, tables.length);
    assert.deepEqual([...payload.routines].sort(), ['function:f_one', 'procedure:p_one']);
    assert.deepEqual(payload.events, ['e_one']);
    assert.equal(payload.stripDefiner, true);
    assert.equal(payload.includeStructure, true);
    assert.equal(payload.includeData, true);
    assert.match(payload.taskId, /^backup-/);
    await until("mode === 'transfer' && $('#workspace').textContent.includes('Đang sao lưu database')");
    assert.equal(await evaluate("$('#modal').open"), false);
    await captureReview('backup-task');
    await evaluate("view('query')");
    assert.equal(await evaluate('mode'), 'query');
    const queryBefore = calls.filter((call) => call.name === 'db:query').length;
    await evaluate("newQuery('SELECT 1', { profileId: 'test', database: 'test' }); runQuery()");
    assert.ok(calls.filter((call) => call.name === 'db:query').length > queryBefore);
    assert.equal(await evaluate('transferView.state'), 'running');
    pendingBackup();
    pendingBackup = null;
    holdBackup = false;
    await until("transferView?.state === 'success'");
    assert.equal(await evaluate('mode'), 'query');
    assert.equal(await evaluate("$('#modal').open"), false);
    await evaluate("view('transfer')");
    assert.match(await evaluate("$('#workspace').textContent"), /1 procedure, 1 function, 1 event/);
  });
  const typedColumns = [
    { name: 'id', type: 'int', nullable: 'NO', key: 'PRI', extra: '' },
    { name: 'name', type: 'varchar(50)', nullable: 'YES', extra: '' },
    { name: 'due', type: 'date', nullable: 'YES', extra: '' },
    { name: 'recorded_at', type: 'datetime(6)', nullable: 'NO', extra: '' },
    { name: 'duration', type: 'time(6)', nullable: 'NO', extra: '' },
    { name: 'year', type: 'year', nullable: 'YES', extra: '' },
    { name: 'amount', type: 'decimal(30,6)', nullable: 'NO', extra: '' },
    { name: 'count', type: 'bigint unsigned', nullable: 'NO', extra: '' },
    { name: 'enabled', type: 'bit(1)', nullable: 'NO', extra: '' },
    { name: 'status', type: "enum('new','active','done')", nullable: 'NO', extra: '' },
    { name: 'roles', type: "set('read','write','admin')", nullable: 'NO', extra: '' },
    { name: 'payload', type: 'json', nullable: 'YES', extra: '' },
    { name: 'bytes', type: 'varbinary(8)', nullable: 'YES', extra: '' },
    { name: 'preview', type: 'blob', nullable: 'YES', extra: '' },
    { name: 'zero_date', type: 'date', nullable: 'NO', extra: '' },
    { name: 'computed', type: 'int', nullable: 'NO', extra: 'STORED GENERATED' }
  ];
  const typedRow = {
    id: 1, name: 'Alice', due: '2026-10-24', recorded_at: '2026-10-24 12:34:56.123456',
    duration: '-125:04:03.123456', year: '2026', amount: '12345678901234567890.123456',
    count: '18446744073709551614', enabled: '0x00', status: 'new', roles: 'read',
    payload: '{"n":18446744073709551615}', bytes: '0x0012', preview: '0x1234… (100 bytes)', zero_date: '0000-00-00', computed: 42
  };
  const setupTypedRows = async () => {
    rowEditorColumns = typedColumns;
    await evaluate(`closeModal(); app.connection={id:'test',name:'Demo',ssh:{enabled:false}}; app.database='test'; table='users'; mode='data'; app.columns=${JSON.stringify(typedColumns)}; app.primaryKey=['id']; app.rows=[${JSON.stringify(typedRow)}]; app.total=1; app.page=1; app.pageSize=100; app.search=''; renderDataView();`);
  };

  await check('row form uses schema controls and saves only changed values without losing precision', async () => {
    await setupTypedRows();
    await evaluate('editRow(0)');
    assert.deepEqual(await evaluate("[...document.querySelectorAll('#rowForm .sql-value-picker')].map(el=>el.type)"), ['date', 'datetime-local', 'time', 'date']);
    assert.equal(await evaluate("document.querySelector('[data-field=status]').tagName"), 'SELECT');
    assert.equal(await evaluate("document.querySelector('[data-field=roles]').multiple"), true);
    assert.equal(await evaluate("document.querySelector('[data-field=count]').type"), 'text');
    assert.equal(await evaluate("document.querySelector('[data-field=payload]').tagName"), 'TEXTAREA');
    for (const name of ['id', 'preview', 'computed']) assert.equal(await evaluate(`document.querySelector('[data-field=${name}]').disabled`), true);
    await evaluate(`
      const due = document.querySelector('[data-field=due]').closest('.sql-value-editor').querySelector('.sql-value-picker');
      due.value='2026-11-02'; due.dispatchEvent(new Event('change'));
      const recorded = document.querySelector('[data-field=recorded_at]').closest('.sql-value-editor').querySelector('.sql-value-picker');
      recorded.value='2026-11-03T21:45:56.123'; recorded.dispatchEvent(new Event('change'));
      document.querySelector('[data-field=name]').value='NULL';
      document.querySelector('[data-field=count]').value='18446744073709551615';
      document.querySelector('[data-field=status]').value='done';
      for (const option of document.querySelector('[data-field=roles]').options) option.selected=['read','write'].includes(option.value);
      document.querySelector('[data-field=enabled]').value='1';
      document.querySelector('[data-field=bytes]').value='0x00ff';
    `);
    if (process.env.SQLPRO_ROW_EDITOR_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.SQLPRO_ROW_EDITOR_SCREENSHOT_DIR, { recursive: true });
      win.setContentSize(1320, 900);
      await new Promise((resolve) => setTimeout(resolve, 150));
      fs.writeFileSync(path.join(process.env.SQLPRO_ROW_EDITOR_SCREENSHOT_DIR, 'row-form.png'), (await win.webContents.capturePage()).toPNG());
    }
    const before = calls.filter((call) => call.name === 'db:update-row').length;
    await evaluate("$('#rowSave').click()");
    await until("!$('#modal').open");
    const updates = calls.filter((call) => call.name === 'db:update-row');
    assert.equal(updates.length, before + 1);
    assert.deepEqual(updates.at(-1).args[0].values, { name: 'NULL', due: '2026-11-02', recorded_at: '2026-11-03 21:45:56.123456', count: '18446744073709551615', enabled: '1', status: 'done', roles: 'read,write', bytes: '0x00ff' });
    assert.deepEqual(updates.at(-1).args[0].keys, { id: 1 });
  });

  await check('row form rejects invalid dates and JSON, and untouched zero dates do not get rewritten', async () => {
    await setupTypedRows();
    await evaluate('editRow(0)');
    const before = calls.filter((call) => call.name === 'db:update-row').length;
    await evaluate("document.querySelector('[data-field=due]').value='2026-02-30'; $('#rowSave').click()");
    assert.equal(calls.filter((call) => call.name === 'db:update-row').length, before);
    assert.match(await evaluate("$('#rowError').textContent"), /ngày không hợp lệ/);
    await evaluate("document.querySelector('[data-field=due]').value='2026-10-24'; document.querySelector('[data-field=payload]').value='{bad}'; $('#rowSave').click()");
    assert.match(await evaluate("$('#rowError').textContent"), /JSON không hợp lệ/);
    assert.equal(calls.filter((call) => call.name === 'db:update-row').length, before);
    await evaluate("$('#rowCancel').click(); editRow(0); $('#rowSave').click()");
    assert.equal(calls.filter((call) => call.name === 'db:update-row').length, before);
  });

  await check('inserting allows manual primary keys and distinguishes DEFAULT, NULL and empty strings', async () => {
    rowEditorColumns = [
      { name: 'id', type: 'int', key: 'PRI', nullable: 'NO', extra: '' },
      { name: 'name', type: 'varchar(50)', nullable: 'NO', extra: '' },
      { name: 'notes', type: 'text', nullable: 'YES', extra: '' },
      { name: 'created', type: 'datetime', nullable: 'NO', extra: '', defaultValue: 'CURRENT_TIMESTAMP' }
    ];
    await evaluate(`app.columns=${JSON.stringify(rowEditorColumns)}; editRow(null)`);
    assert.equal(await evaluate("document.querySelector('[data-field=id]').disabled"), false);
    await evaluate("document.querySelector('[data-field=id]').value='2'; const notes=document.querySelector('[data-field=notes]').closest('.sql-value-editor').querySelector('.sql-value-mode'); notes.value='null'; notes.dispatchEvent(new Event('change')); $('#rowSave').click()");
    await until("!$('#modal').open");
    const payload = calls.filter((call) => call.name === 'db:insert-row').at(-1).args[0];
    assert.deepEqual(payload.values, { id: '2', name: '', notes: null });
  });

  await check('inline date picker keeps focus transitions from saving prematurely and preserves calendar dates', async () => {
    await setupTypedRows();
    const before = calls.filter((call) => call.name === 'db:update-row').length;
    await evaluate("inlineEditCell($('#grid td[data-col=due]')); document.querySelector('.sql-value-picker').focus()");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(calls.filter((call) => call.name === 'db:update-row').length, before);
    await evaluate("document.querySelector('.sql-value-picker').value='2026-12-31'; document.querySelector('.sql-value-picker').dispatchEvent(new Event('change')); document.querySelector('.sql-inline-actions button').click()");
    await until("!$('#grid td[data-col=due]').classList.contains('editing-cell')");
    assert.equal(calls.filter((call) => call.name === 'db:update-row').at(-1).args[0].values.due, '2026-12-31');
    await evaluate("inlineEditCell($('#grid td[data-col=preview]'))");
    assert.equal(await evaluate("$('#grid td[data-col=preview]').classList.contains('editing-cell')"), false);
  });

  await check('inline NULL mode keeps SQL NULL, literal NULL and empty text distinct', async () => {
    await setupTypedRows();
    await evaluate("inlineEditCell($('#grid td[data-col=name]')); document.querySelector('.inline-cell-editor').value='NULL'; document.querySelector('.sql-inline-actions button').click()");
    await until("!$('#grid td[data-col=name]').classList.contains('editing-cell')");
    assert.equal(calls.filter((call) => call.name === 'db:update-row').at(-1).args[0].values.name, 'NULL');
    await evaluate("inlineEditCell($('#grid td[data-col=name]')); document.querySelector('.sql-value-inline .sql-value-mode').value='null'; document.querySelector('.sql-value-inline .sql-value-mode').dispatchEvent(new Event('change')); document.querySelector('.sql-inline-actions button').click()");
    await until("!$('#grid td[data-col=name]').classList.contains('editing-cell')");
    assert.equal(calls.filter((call) => call.name === 'db:update-row').at(-1).args[0].values.name, null);
    await evaluate("inlineEditCell($('#grid td[data-col=name]')); document.querySelector('.sql-value-inline .sql-value-mode').value='value'; document.querySelector('.sql-value-inline .sql-value-mode').dispatchEvent(new Event('change')); document.querySelector('.sql-inline-actions button').click()");
    await until("!$('#grid td[data-col=name]').classList.contains('editing-cell')");
    assert.equal(calls.filter((call) => call.name === 'db:update-row').at(-1).args[0].values.name, '');
  });

  await check('failed inline saves retain user input and Escape cancels without another write', async () => {
    await setupTypedRows();
    rowEditorFailure = true;
    const before = calls.filter((call) => call.name === 'db:update-row').length;
    await evaluate("inlineEditCell($('#grid td[data-col=name]')); document.querySelector('.inline-cell-editor').value='Retry me'; document.querySelector('.sql-inline-actions button').click()");
    await until("!document.querySelector('.sql-value-error').hidden");
    assert.equal(await evaluate("document.querySelector('.inline-cell-editor').value"), 'Retry me');
    assert.equal(await evaluate('app.rows[0].name'), 'Alice');
    await evaluate("document.querySelector('.inline-cell-editor').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls.filter((call) => call.name === 'db:update-row').length, before + 1);
    rowEditorFailure = false;
  });

  await check('failed or zero-row inline saves never retry on focusout and an explicit retry saves exactly once', async () => {
    try {
      for (const variant of ['error', 'zero']) {
        await setupTypedRows();
        rowEditorFailure = variant === 'error'; rowEditorResult = { affectedRows: variant === 'zero' ? 0 : 1, changedRows: 0 };
        const before = calls.filter(call => call.name === 'db:update-row').length;
        await evaluate("inlineEditCell($('#grid td[data-col=name]'));document.querySelector('.inline-cell-editor').value='Retry allowed';document.querySelector('.sql-inline-actions button').click()");
        await until("!document.querySelector('.sql-value-error').hidden");
        await evaluate("document.querySelector('#conflictStay')?.click();$('#treeSearch').focus();document.querySelector('.sql-value-inline').dispatchEvent(new FocusEvent('focusout',{bubbles:true,relatedTarget:$('#treeSearch')}))");
        await new Promise(resolve => setTimeout(resolve, 40));
        assert.equal(calls.filter(call => call.name === 'db:update-row').length, before + 1, variant);
        assert.equal(await evaluate("document.querySelector('.inline-cell-editor').value"), 'Retry allowed');
        assert.equal(await evaluate('app.rows[0].name'), 'Alice');
        rowEditorFailure = false; rowEditorResult = { affectedRows: 1, changedRows: 1 };
        await evaluate("document.querySelector('.sql-inline-actions button').click()");
        await until("!$('#grid td[data-col=name]').classList.contains('editing-cell')");
        assert.equal(calls.filter(call => call.name === 'db:update-row').length, before + 2);
        assert.equal(await evaluate('app.rows[0].name'), 'Retry allowed');
      }
    } finally { rowEditorFailure = false; rowEditorResult = { affectedRows: 1, changedRows: 1 }; }
  });

  await check('zero-row inline saves retain input and never update the displayed row', async () => {
    await setupTypedRows();
    rowEditorResult = { affectedRows: 0, changedRows: 0 };
    try {
      await evaluate("inlineEditCell($('#grid td[data-col=name]')); document.querySelector('.inline-cell-editor').value='Keep this draft'; document.querySelector('.sql-inline-actions button').click()");
      await until("!document.querySelector('.sql-value-error').hidden");
      assert.equal(await evaluate("document.querySelector('.inline-cell-editor').value"), 'Keep this draft');
      assert.equal(await evaluate('app.rows[0].name'), 'Alice');
      assert.equal(await evaluate("$('#grid td[data-col=name]').classList.contains('editing-cell')"), true);
      assert.match(await evaluate("document.querySelector('.sql-value-error').textContent"), /tải lại dữ liệu/);
      await evaluate("document.querySelector('.inline-cell-editor').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    } finally { rowEditorResult = { affectedRows: 1, changedRows: 1 }; }
  });

  await check('zero-row form saves keep the draft and unchanged matched rows can be saved with the keyboard', async () => {
    await setupTypedRows();
    rowEditorResult = { affectedRows: 0, changedRows: 0 };
    try {
      await evaluate("editRow(0); document.querySelector('[data-field=name]').value='Keep form draft'; $('#rowSave').click()");
      await until("!$('#rowError').classList.contains('hidden')");
      assert.equal(await evaluate("$('#modal').open"), true);
      assert.equal(await evaluate("document.querySelector('[data-field=name]').value"), 'Keep form draft');
      assert.equal(await evaluate("$('#rowSave').disabled"), false);
      rowEditorResult = { status: 'unchanged', matchedRows: 1, affectedRows: 1, changedRows: 0 };
      await evaluate("document.querySelector('[data-field=name]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true}))");
      await until("!$('#modal').open");
    } finally { rowEditorResult = { affectedRows: 1, changedRows: 1 }; }
  });

  await check('table and SQL row editors send binary original hashes separately from visible previews', async () => {
    await setupTypedRows();
    const hash = { kind: 'sha256', value: 'ab'.repeat(32) };
    await evaluate(`rowOriginalHashes.set(app.rows[0],{preview:${JSON.stringify(hash)}}); inlineEditCell($('#grid td[data-col=name]')); document.querySelector('.inline-cell-editor').value='with hash'; document.querySelector('.sql-inline-actions button').click()`);
    await until("!$('#grid td[data-col=name]').classList.contains('editing-cell')");
    assert.deepEqual(calls.filter((call) => call.name === 'db:update-row').at(-1).args[0].original.preview, hash);
    await evaluate(`app.query.profileId='test'; app.query.database='test'; app.query.result={kind:'rows',columns:[{name:'id',orgName:'id',table:'u',orgTable:'users',db:'test',type:'LONG',flags:2},{name:'name',orgName:'name',table:'u',orgTable:'users',db:'test',type:'TEXT',flags:0},{name:'preview',orgName:'preview',table:'u',orgTable:'users',db:'test',type:'BLOB',flags:0}],rows:[[1,'before','0x0012… (100 bytes)']],originalHashes:[{'2':${JSON.stringify(hash)}}],durationMs:1}; mode='query'; renderQueryView();`);
    await evaluate("inlineEditQueryResultCell(document.querySelector('td[data-col-idx=\"1\"]'))");
    await evaluate("document.querySelector('.inline-cell-editor').value='query with hash'; document.querySelector('.sql-inline-actions button').click()");
    await until("!document.querySelector('td[data-col-idx=\"1\"]').classList.contains('editing-cell')");
    assert.deepEqual(calls.filter((call) => call.name === 'db:update-row').at(-1).args[0].original.preview, hash);
  });

  await check('query-result editors use full schema metadata and keep the captured connection target', async () => {
    await setupTypedRows();
    await evaluate(`app.query.profileId='test'; app.query.database='test'; app.query.result={kind:'rows',columns:[{name:'id',orgName:'id',table:'u',orgTable:'users',db:'test',type:'LONG',flags:2},{name:'recorded',orgName:'recorded_at',table:'u',orgTable:'users',db:'test',type:'DATETIME',flags:0}],rows:[[1,'2026-10-24 12:34:56.123456']],durationMs:1}; mode='query'; renderQueryView();`);
    await evaluate("inlineEditQueryResultCell(document.querySelector('td[data-col-idx=\"1\"]'))");
    assert.equal(await evaluate("document.querySelector('.sql-value-picker').type"), 'datetime-local');
    await evaluate("document.querySelector('.sql-value-picker').value='2026-11-04T23:00:56.123'; document.querySelector('.sql-value-picker').dispatchEvent(new Event('change')); app.query.profileId='other'; document.querySelector('.sql-inline-actions button').click()");
    await until("!document.querySelector('td[data-col-idx=\"1\"]').classList.contains('editing-cell')");
    const payload = calls.filter((call) => call.name === 'db:update-row').at(-1).args[0];
    assert.equal(payload.profileId, 'test');
    assert.deepEqual(payload.values, { recorded_at: '2026-11-04 23:00:56.123456' });
    assert.deepEqual(payload.keys, { id: 1 });
    rowEditorColumns = columns;
  });

  await check('a queued close from a reused modal does not cancel the next confirmation', async () => {
    await evaluate(`modal('<p>Previous form</p>');
      window.__previousModalClosed=new Promise(resolve=>$('#modal').addEventListener('close',resolve,{once:true}));
      closeModal(); window.__reopenedSettled=false;
      window.__reopenedConfirmation=confirmAction('New confirmation','Keep this choice open').then(value=>{window.__reopenedSettled=true;return value;});void 0`);
    await evaluate('window.__previousModalClosed.then(()=>undefined)');
    assert.equal(await evaluate("$('#modal').open && !window.__reopenedSettled"), true);
    await evaluate("$('#confirmOk').click()");
    assert.equal(await evaluate('window.__reopenedConfirmation'), true);
    await until("!$('#modal').open");
  });

  await check('query result context menu exposes copy formats and safe record actions', async () => {
    await evaluate(`document.querySelectorAll('.confirmation-dialog').forEach((dialog) => { dialog.close(); dialog.remove(); });
      app.query.profileId='test'; app.query.database='test';
      app.query.resultContext={profileId:'test',database:'test'};
      app.query.result={kind:'rows',columns:[
        {name:'id',orgName:'id',orgTable:'users',db:'test',type:'INT',flags:2},
        {name:'name',orgName:'name',orgTable:'users',db:'test',type:'VARCHAR',flags:0}
      ],rows:[[1,'Alice']],durationMs:1}; mode='query'; renderQueryView();
      $('#queryResult td[data-col-idx="1"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:100}));`);
    assert.equal(await evaluate("Boolean($('#contextMenu [data-query-action=\"csv-all\"]'))"), true);
    await until("Boolean($('#contextMenu [data-query-action=\"update\"]:not(:disabled)'))");
    await evaluate("$('#contextMenu [data-query-submenu]').click()");
    await captureReview('query-context-menu');
    await evaluate("$('#contextMenu [data-query-action=\"zoom-125\"]').click()");
    assert.equal(await evaluate("$('#queryResult').style.getPropertyValue('--query-grid-zoom')"), '1.25');
    await evaluate("$('#queryResult td[data-col-idx=\"1\"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:100})); $('#contextMenu [data-query-action=\"empty\"]').click()");
    await until("app.query.result.rows[0][1] === ''");
    assert.deepEqual(calls.filter((call) => call.name === 'db:update-row').at(-1).args[0].values, { name: '' });
    await evaluate("$('#queryResult td[data-col-idx=\"1\"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:100})); $('#contextMenu [data-query-action=\"null\"]').click()");
    await until('app.query.result.rows[0][1] === null');
    assert.deepEqual(calls.filter((call) => call.name === 'db:update-row').at(-1).args[0].values, { name: null });
    await evaluate("$('#queryResult td[data-col-idx=\"1\"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:100}))");
    await evaluate("$('#contextMenu [data-query-action=\"add\"]').click()");
    await until("Boolean($('#rowForm'))");
    assert.match(await evaluate("$('#modal').textContent"), /test\.users/);
    await evaluate("closeModal(); $('#queryResult td[data-col-idx=\"1\"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:100}))");
    await until("Boolean($('#contextMenu [data-query-action=\"delete\"]:not(:disabled)'))");
    await evaluate("$('#contextMenu [data-query-action=\"delete\"]').click()");
    await until("$('#modal').open");
    await evaluate("$('#confirmOk').click()");
    await until('app.query.result.rows.length === 0');
    const deletion = calls.filter((call) => call.name === 'db:delete-rows').at(-1).args[0];
    assert.equal(deletion.database, 'test');
    assert.equal(deletion.table, 'users');
    assert.deepEqual(deletion.keysList, [{ id: 1 }]);
  });

  await check('query result menu disables writes for JOIN results', async () => {
    await evaluate(`app.query.result={kind:'rows',columns:[
      {name:'id',orgName:'id',orgTable:'users',db:'test',type:'INT',flags:2},
      {name:'team',orgName:'name',orgTable:'teams',db:'test',type:'VARCHAR'}
    ],rows:[[1,'Ops']],durationMs:1}; renderQueryView();
    $('#queryResult td[data-col-idx="1"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:100}));`);
    assert.equal(await evaluate("$('#contextMenu [data-query-action=\"add\"]').disabled"), true);
    assert.equal(await evaluate("$('#contextMenu [data-query-action=\"delete\"]').disabled"), true);
    assert.equal(await evaluate("$('#contextMenu [data-query-action=\"insert\"]').disabled"), true);
    assert.equal(await evaluate("$('#contextMenu [data-query-action=\"update\"]').disabled"), true);
    assert.equal(await evaluate("$('#contextMenu [data-query-action=\"json\"]').disabled"), false);
  });

  await check('result grid selects ranges and disjoint rows, preserves selection on right-click and copies all selected rows', async () => {
    rowEditorColumns = columns;
    await evaluate(`app.query.profileId='test';app.query.database='test';
      app.query.resultContext={profileId:'test',database:'test'};
      app.query.sortCol=0;app.query.sortDir='ASC';
      app.query.result={kind:'rows',columns:[
        {name:'id',orgName:'id',orgTable:'users',db:'test',type:'INT',flags:2},
        {name:'name',orgName:'name',orgTable:'users',db:'test',type:'VARCHAR'}
      ],rows:[[5,'E'],[1,'A'],[3,'C'],[2,'B'],[4,'D']],durationMs:1};
      mode='query';renderQueryView();
      window.gridMouse=(index,options={})=>{
        const td=document.querySelector('#queryResult tr[data-query-row="'+index+'"] td[data-col-idx="1"]');
        td.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,buttons:1,...options}));
        document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0}));
      };
      gridMouse(1);gridMouse(2,{shiftKey:true});`);
    assert.equal(await evaluate("JSON.stringify(queryGridSelectedIndexes(app.query.result))"), '[1,3,2]');
    await evaluate('gridMouse(0,{ctrlKey:true}); gridMouse(3,{ctrlKey:true})');
    assert.equal(await evaluate("JSON.stringify(queryGridSelectedIndexes(app.query.result))"), '[1,2,0]');
    await evaluate(`$('#queryResult tr[data-query-row="2"] td[data-col-idx="1"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:100}));`);
    assert.match(await evaluate("$('#contextMenu [data-query-action=\"delete\"]').textContent"), /3 dòng/);
    assert.equal(await evaluate("document.querySelectorAll('#queryResult tr.query-row-selected').length"), 3);
    assert.equal(await evaluate("$('#contextMenu [data-query-action=\"empty\"]').disabled"), true);
    await until("!$('#contextMenu [data-query-action=\"delete\"]').disabled");
    assert.equal(await evaluate("$('#contextMenu [data-query-action=\"delete\"]').classList.contains('disabled')"), false);
    await evaluate("$('#contextMenu [data-query-submenu]').click()");
    assert.match(await evaluate("$('#contextMenu').textContent"), /Copy As/);
    await evaluate("$('#contextMenu [data-query-action=\"insert\"]').click()");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(await clipboard.readText(), /INSERT INTO `test`\.`users`/);
    assert.equal((await clipboard.readText()).split('\n').length, 3);
    await evaluate(`$('#queryResult tr[data-query-row="2"] td[data-col-idx="1"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:100}));`);
    await until("!$('#contextMenu [data-query-action=\"update\"]').disabled");
    await evaluate("$('#contextMenu [data-query-action=\"update\"]').click()");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(await clipboard.readText(), /UPDATE `test`\.`users` SET `name`/);
    assert.equal((await clipboard.readText()).split('\n').length, 3);
    await evaluate(`$('#queryResult tr[data-query-row="2"] td[data-col-idx="1"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:100}));`);
    await captureReview('query-multi-selection');
    await evaluate("$('#contextMenu [data-query-action=\"csv-all\"]').click()");
    await until("$('#contextMenu').classList.contains('hidden')");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await clipboard.readText(), 'id,name\r\n1,A\r\n3,C\r\n5,E');
    assert.equal(await evaluate("document.querySelectorAll('#queryResult tr.query-row-selected').length"), 3);
    await evaluate("$('#queryResult th[data-query-sort=\"0\"]').click()");
    assert.equal(await evaluate("JSON.stringify(queryGridSelectedIndexes(app.query.result))"), '[0,2,1]');
  });

  await check('Electron Ctrl+A and Ctrl+C act on focused result rows while SQL editor keeps native select-all', async () => {
    const previousMenu = Menu.getApplicationMenu();
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Edit', submenu: [
      { role: 'copy' }, { role: 'selectAll' }
    ] }]));
    try {
      await evaluate("$('#queryResult [data-query-grid]').focus()");
      win.webContents.focus();
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
      await until('queryGridSelection(app.query.result).rows.size === 5');
      await evaluate("$('#queryResult tr[data-query-row=\"0\"] td[data-col-idx=\"1\"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:550,clientY:450}))");
      win.setContentSize(900, 650);
      await evaluate("$('#contextMenu').classList.add('hidden')");
      assert.equal(await evaluate("$('#queryResult').scrollWidth <= $('#queryResult').clientWidth"), true);
      await captureReview('query-multi-selection-small');
      win.setContentSize(1344, 835);
      await evaluate("$('#queryResult [data-query-grid]').focus()");
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'C', modifiers: ['control'] });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'C', modifiers: ['control'] });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(await clipboard.readText(), '5\tE\r\n4\tD\r\n3\tC\r\n2\tB\r\n1\tA');
      await evaluate("$('#sql').value='SELECT 123'; $('#sql').focus(); $('#sql').setSelectionRange(0,0)");
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
      await until("$('#sql').selectionEnd === $('#sql').value.length");
      assert.equal(await evaluate('queryGridSelection(app.query.result).rows.size'), 5);
    } finally { Menu.setApplicationMenu(previousMenu); }
  });

  await check('drag selection highlights rows and bulk Delete confirms once with the selected primary keys', async () => {
    await evaluate("$('#queryResult tr[data-query-row=\"2\"]').scrollIntoView({block:'center'}); $('#contextMenu').classList.add('hidden')");
    await until(`(() => {const cell=$('#queryResult tr[data-query-row="2"] td[data-col-idx="1"]');const r=cell.getBoundingClientRect();return document.elementFromPoint(r.x+5,r.y+5)?.closest('tr')===cell.closest('tr');})()`);
    await evaluate(`gridMouse(0);
      const first=$('#queryResult tr[data-query-row="0"] td[data-col-idx="1"]');
      const last=$('#queryResult tr[data-query-row="2"] td[data-col-idx="1"]');
      const a=first.getBoundingClientRect(),b=last.getBoundingClientRect();
      first.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,buttons:1,button:0,clientX:a.x+5,clientY:a.y+5}));
      document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,buttons:1,clientX:b.x+5,clientY:b.y+5}));`);
    await until('queryGridSelection(app.query.result).rows.size === 3');
    await evaluate("document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); $('#queryResult [data-query-grid]').dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true,cancelable:true}))");
    await until("Boolean($('#confirmOk'))");
    assert.match(await evaluate("$('#modal').textContent"), /3 bản ghi/);
    const before = calls.filter((call) => call.name === 'db:delete-rows').length;
    await evaluate("$('#confirmOk').click()");
    await until('app.query.result.rows.length === 2');
    assert.equal(calls.filter((call) => call.name === 'db:delete-rows').length, before + 1);
    const request = calls.filter((call) => call.name === 'db:delete-rows').at(-1).args[0];
    assert.deepEqual(request.keysList, [{ id: 5 }, { id: 4 }, { id: 3 }]);
    assert.equal(request.originalValues.length, 3);
    assert.equal(await evaluate("document.querySelectorAll('#queryResult tr.query-row-selected').length"), 0);
    await evaluate('delete window.gridMouse');
  });

  await check('large results keep a bounded DOM, scroll to the final record and preserve position across renders', async () => {
    await evaluate(`app.query.result={kind:'rows',columns:[{name:'id',type:'INT'},{name:'value',type:'TEXT'}],
      rows:Array.from({length:5000},(_,i)=>[i,'value '+i]),durationMs:1};
      app.query.sortCol=null;app.query.sortDir='ASC';renderQueryView();`);
    assert.ok(await evaluate("document.querySelectorAll('#queryResult tr[data-query-row]').length") <= 80);
    await evaluate("const box=$('#queryResult [data-query-grid]');box.scrollTop=box.scrollHeight;box.dispatchEvent(new Event('scroll'))");
    await until("Boolean($('#queryResult tr[data-query-row=\"4999\"]'))");
    const top = await evaluate("$('#queryResult [data-query-grid]').scrollTop");
    await evaluate('renderQueryView()');
    assert.ok(Math.abs(await evaluate("$('#queryResult [data-query-grid]').scrollTop") - top) < 3);
    await evaluate("$('#queryResult [data-query-grid]').dispatchEvent(new KeyboardEvent('keydown',{key:'a',ctrlKey:true,bubbles:true,cancelable:true}))");
    assert.equal(await evaluate('queryGridSelection(app.query.result).rows.size'), 5000);
    assert.ok(await evaluate("document.querySelectorAll('#queryResult tr[data-query-row]').length") <= 80);
    await evaluate("$('#queryResult [data-query-grid]').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true,cancelable:true}))");
    await until("Boolean($('#queryResult tr[data-query-row=\"0\"]'))");
    assert.equal(await evaluate('queryGridSelection(app.query.result).focus'), 0);
    await evaluate(`app.query.result={kind:'rows',columns:Array.from({length:40},(_,i)=>({name:'column_'+i,type:'INT'})),
      rows:Array.from({length:5000},(_,i)=>Array.from({length:40},()=>i)),durationMs:1}; app.query.gridZoom=100;renderQueryView();`);
    await evaluate(`const wide=$('#queryResult [data-query-grid]');wide.scrollTop=1920*42;wide.dispatchEvent(new Event('scroll'));`);
    await until('queryGridViewport(app.query.result).start > 1800');
    const geometry = await evaluate(`(()=>{
      const box=$('#queryResult [data-query-grid]');
      const table=box.querySelector('table');
      const header=table.querySelector('th[data-query-sort="0"]').getBoundingClientRect();
      const cell=table.querySelector('tr[data-query-row] td[data-col-idx="0"]').getBoundingClientRect();
      return {headerWidth:header.width,cellWidth:cell.width,delta:Math.abs(header.left-cell.left),
        top:header.top,boxTop:box.getBoundingClientRect().top,scrollHeight:box.scrollHeight};
    })()`);
    assert.ok(Math.abs(geometry.headerWidth - 170) < 2);
    assert.ok(Math.abs(geometry.cellWidth - 170) < 2);
    assert.ok(geometry.delta < 2);
    await captureReview('query-wide-scrolled');
    assert.ok(Math.abs(geometry.top - geometry.boxTop) < 3, JSON.stringify(geometry));
  });

  await check('typed row form remains usable in dark theme and a smaller window', async () => {
    await setupTypedRows();
    win.setContentSize(940, 700);
    await evaluate("document.body.classList.add('dark-theme'); document.body.classList.remove('light-theme'); editRow(0)");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await evaluate("document.querySelector('#rowForm').scrollWidth <= document.querySelector('#rowForm').clientWidth"), true);
    assert.ok(await evaluate("document.querySelector('.sql-value-picker').getBoundingClientRect().width") >= 32);
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.sql-value-picker')).colorScheme"), 'dark');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.sql-value-picker')).backgroundColor"), 'rgb(30, 41, 59)');
    if (process.env.SQLPRO_ROW_EDITOR_SCREENSHOT_DIR) {
      fs.writeFileSync(path.join(process.env.SQLPRO_ROW_EDITOR_SCREENSHOT_DIR, 'row-form-dark.png'), (await win.webContents.capturePage()).toPNG());
    }
    await evaluate("closeModal(); document.body.classList.remove('dark-theme'); document.body.classList.add('light-theme')");
    win.setContentSize(1344, 835);
    rowEditorColumns = columns;
  });

  await check('no renderer exceptions or unhandled rejections', async () => {
    await evaluate('new Promise(resolve => setTimeout(resolve, 200))');
    errors.push(...await evaluate('window.rendererErrors'));
    assert.deepEqual(errors, []);
    const saved = calls.filter((call) => call.name === 'state:save').at(-1)?.args[0];
    assert.ok(saved);
    assert.ok(saved.history.every((entry) => typeof entry.sql === 'string'));
  });
  await captureProductShots();
  console.log(`Renderer smoke: ${checks}/${checks} passed`);
  win.destroy();
  app.exit(0);
}).catch((error) => {
  console.error(error.stack || error);
  win?.destroy();
  app.exit(1);
});
