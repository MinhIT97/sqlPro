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
  connect: (profileId) => ipcRenderer.invoke('db:connect', profileId),
  disconnect: () => ipcRenderer.invoke('db:disconnect'),
  databases: () => ipcRenderer.invoke('db:databases'),
  useDatabase: (database) => ipcRenderer.invoke('db:use-database', database),
  tables: (database) => ipcRenderer.invoke('db:tables', database),
  columns: (database, table) => ipcRenderer.invoke('db:columns', database, table),
  indexes: (database, table) => ipcRenderer.invoke('db:indexes', database, table),
  relations: (database, table) => ipcRenderer.invoke('db:relations', database, table),
  tableData: (payload) => ipcRenderer.invoke('db:table-data', payload),
  query: (payload) => ipcRenderer.invoke('db:query', payload),
  cancelQuery: () => ipcRenderer.invoke('db:cancel-query'),
  insertRow: (payload) => ipcRenderer.invoke('db:insert-row', payload),
  updateRow: (payload) => ipcRenderer.invoke('db:update-row', payload),
  deleteRows: (payload) => ipcRenderer.invoke('db:delete-rows', payload),
  exportTable: (payload) => ipcRenderer.invoke('db:export-table', payload),
  importRows: (payload) => ipcRenderer.invoke('db:import-rows', payload),
  backup: (payload) => ipcRenderer.invoke('db:backup', payload),
  restore: (payload) => ipcRenderer.invoke('db:restore', payload)
});

const account = Object.freeze({
  status: () => ipcRenderer.invoke('account:status'),
  register: (payload) => ipcRenderer.invoke('account:register', payload),
  login: (payload) => ipcRenderer.invoke('account:login', payload),
  logout: () => ipcRenderer.invoke('account:logout'),
  resetLocal: () => ipcRenderer.invoke('account:reset-local'),
  syncNow: () => ipcRenderer.invoke('account:sync-now'),
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
  getMetadata: () => ipcRenderer.invoke('app:metadata'),
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state) => ipcRenderer.invoke('state:save', state),
  saveTextFile: (payload) => ipcRenderer.invoke('file:save-text', payload),
  openJsonFile: () => ipcRenderer.invoke('file:open-json'),
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
