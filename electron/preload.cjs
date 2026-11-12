'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const allowedCommands = new Set([
  'new-connection',
  'import-navicat',
  'disconnect',
  'new-query',
  'save-query',
  'import',
  'export',
  'backup',
  'restore',
  'toggle-sidebar',
  'run-query',
  'cancel-query',
  'refresh-data'
]);

async function invoke(channel, ...args) {
  const response = await ipcRenderer.invoke(channel, ...args);
  if (response && response.ok === false) {
    const error = new Error(response.error?.message || 'Yêu cầu không hợp lệ.');
    error.code = response.error?.code || '';
    throw error;
  }
  return response && response.ok === true ? response.data : response;
}

const connections = Object.freeze({
  list: () => ipcRenderer.invoke('connections:list'),
  save: (profile) => ipcRenderer.invoke('connections:save', profile),
  remove: (id) => ipcRenderer.invoke('connections:remove', id),
  test: (profile) => ipcRenderer.invoke('connections:test', profile),
  importNavicat: (workspaceId) => ipcRenderer.invoke('connections:import-navicat', workspaceId)
});

const workspaces = Object.freeze({
  list: () => ipcRenderer.invoke('workspaces:list'),
  save: (workspace) => ipcRenderer.invoke('workspaces:save', workspace),
  remove: (id) => ipcRenderer.invoke('workspaces:remove', id)
});

const db = Object.freeze({
  connect: (profileId, options) => ipcRenderer.invoke('db:connect', profileId, options),
  disconnect: (profileId, options) => ipcRenderer.invoke('db:disconnect', profileId, options),
  sessionState: (profileId) => ipcRenderer.invoke('db:session-state', profileId),
  transaction: (payload) => ipcRenderer.invoke('db:transaction', payload),
  openProfiles: () => ipcRenderer.invoke('db:open-profiles'),
  databases: (profileId) => ipcRenderer.invoke('db:databases', { profileId }),
  useDatabase: (database, profileId) => ipcRenderer.invoke('db:use-database', { database, profileId }),
  tables: (database, profileId) => ipcRenderer.invoke('db:tables', { database, profileId }),
  columns: (database, table, profileId) => ipcRenderer.invoke('db:columns', { database, table, profileId }),
  indexes: (database, table, profileId) => ipcRenderer.invoke('db:indexes', { database, table, profileId }),
  relations: (database, table, profileId) => ipcRenderer.invoke('db:relations', { database, table, profileId }),
  routines: (database, profileId) => ipcRenderer.invoke('db:routines', { database, profileId }),
  events: (database, profileId) => ipcRenderer.invoke('db:events', { database, profileId }),
  showCreate: (payload) => ipcRenderer.invoke('db:show-create', payload),
  tableData: (payload) => ipcRenderer.invoke('db:table-data', payload),
  tableCount: (payload) => ipcRenderer.invoke('db:table-count', payload),
  query: (payload) => ipcRenderer.invoke('db:query', payload),
  confirmProduction: (token) => ipcRenderer.invoke('db:confirm-production', token),
  cancelProduction: (token) => ipcRenderer.invoke('db:cancel-production', token),
  cancelQuery: (profileId, taskId) => ipcRenderer.invoke('db:cancel-query', { profileId, taskId }),
  insertRow: (payload) => ipcRenderer.invoke('db:insert-row', payload),
  updateRow: (payload) => ipcRenderer.invoke('db:update-row', payload),
  deleteRows: (payload) => ipcRenderer.invoke('db:delete-rows', payload),
  pickImportFile: (payload) => ipcRenderer.invoke('db:pick-import-file', payload),
  previewImport: (payload) => ipcRenderer.invoke('db:preview-import', payload),
  exportFile: (payload) => ipcRenderer.invoke('db:export-file', payload),
  exportQuery: (payload) => ipcRenderer.invoke('db:export-query', payload),
  importFile: (payload) => ipcRenderer.invoke('db:import-file', payload),
  backup: (payload) => ipcRenderer.invoke('db:backup', payload),
  getBackupSchedule: (payload) => ipcRenderer.invoke('db:get-backup-schedule', payload),
  saveBackupSchedule: (payload) => ipcRenderer.invoke('db:save-backup-schedule', payload),
  pauseBackupSchedule: (payload) => ipcRenderer.invoke('db:pause-backup-schedule', payload),
  deleteBackupSchedule: (payload) => ipcRenderer.invoke('db:delete-backup-schedule', payload),
  cancelTask: (profileId, taskId) => ipcRenderer.invoke('db:cancel-task', { profileId, taskId }),
  listBackups: (database, profileId) => ipcRenderer.invoke('db:list-backups', { database, profileId }),
  verifyBackup: (payload) => ipcRenderer.invoke('db:verify-backup', payload),
  inspectBackup: (payload) => ipcRenderer.invoke('db:inspect-backup', payload),
  cancelInspectBackup: (payload) => ipcRenderer.invoke('db:cancel-inspect-backup', payload),
  inspectBackupStatus: (payload) => ipcRenderer.invoke('db:inspect-backup-status', payload),
  trialBackup: (payload) => ipcRenderer.invoke('db:trial-backup', payload),
  listTrialRecovery: (profileId) => ipcRenderer.invoke('db:list-trial-recovery', { profileId }),
  cleanupTrialRecovery: (payload) => ipcRenderer.invoke('db:cleanup-trial-recovery', payload),
  deleteBackup: (payload) => ipcRenderer.invoke('db:delete-backup', payload),
  updateBackupAnnotations: (payload) => ipcRenderer.invoke('db:update-backup-annotations', payload),
  previewBackupRetention: (payload) => ipcRenderer.invoke('db:preview-backup-retention', payload),
  applyBackupRetention: (payload) => ipcRenderer.invoke('db:apply-backup-retention', payload),
  backupRetentionStatus: (payload) => ipcRenderer.invoke('db:backup-retention-status', payload),
  backupRetentionHistory: (payload) => ipcRenderer.invoke('db:backup-retention-history', payload),
  exportBackupRetentionHistory: (payload) => ipcRenderer.invoke('db:export-backup-retention-history', payload),
  getBackupRetentionPolicy: (payload) => ipcRenderer.invoke('db:get-backup-retention-policy', payload),
  saveBackupRetentionPolicy: (payload) => ipcRenderer.invoke('db:save-backup-retention-policy', payload),
  clearBackupRetentionPolicy: (payload) => ipcRenderer.invoke('db:clear-backup-retention-policy', payload),
  renameBackup: (payload) => ipcRenderer.invoke('db:rename-backup', payload),
  exportBackup: (payload) => ipcRenderer.invoke('db:export-backup', payload),
  showBackupFolder: (payload) => ipcRenderer.invoke('db:show-backup-folder', payload),
  copyBackup: (payload) => ipcRenderer.invoke('db:copy-backup', payload),
  restore: (payload) => ipcRenderer.invoke('db:restore', payload)
});

const account = Object.freeze({
  status: () => ipcRenderer.invoke('account:status'),
  register: (payload) => ipcRenderer.invoke('account:register', payload),
  login: (payload) => ipcRenderer.invoke('account:login', payload),
  logout: () => ipcRenderer.invoke('account:logout'),
  resetLocal: () => ipcRenderer.invoke('account:reset-local'),
  syncNow: () => ipcRenderer.invoke('account:sync-now'),
  resolveConflicts: (choices) => ipcRenderer.invoke('account:resolve-conflicts', choices),
  listRecovery: () => ipcRenderer.invoke('account:list-recovery'),
  restoreRecovery: (id) => ipcRenderer.invoke('account:restore-recovery', id),
  onStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('sync:status', listener);
    return () => ipcRenderer.removeListener('sync:status', listener);
  },
  onApplied: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('sync:applied', listener);
    return () => ipcRenderer.removeListener('sync:applied', listener);
  }
});

contextBridge.exposeInMainWorld('sqlProDesktop', Object.freeze({
  writeClipboardText: (text) => invoke('clipboard:write-text', text),
  readClipboardText: () => invoke('clipboard:read-text'),
  getMetadata: () => invoke('app:metadata'),
  loadState: () => invoke('state:load'),
  saveState: (state) => invoke('state:save', state),
  saveTextFile: (payload) => invoke('file:save-text', payload),
  openJsonFile: () => invoke('file:open-json'),
  openTextFile: (payload) => invoke('file:open-text', payload),
  onMenuCommand: (callback) => {
    const listener = (_event, command) => {
      if (allowedCommands.has(command)) callback(command);
    };
    ipcRenderer.on('menu:command', listener);
    return () => ipcRenderer.removeListener('menu:command', listener);
  },
  onDbProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('db:progress', listener);
    return () => ipcRenderer.removeListener('db:progress', listener);
  },
  connections,
  workspaces,
  account,
  db
}));
