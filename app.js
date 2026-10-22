'use strict';

let table = null;
let mode = 'data';
let historyRows = [];

const desktop = window.sqlProDesktop;

const DEFAULT_WORKSPACE_ID = 'ws-personal';

const app = {
  connections: [],
  workspaces: [],
  activeWorkspaceId: DEFAULT_WORKSPACE_ID,
  account: null,
  connection: null,
  databases: [],
  database: null,
  tables: [],
  server: '',
  serverType: 'mysql',
  columns: [],
  primaryKey: [],
  rows: [],
  total: null,
  page: 1,
  pageSize: 100,
  search: '',
  query: { sql: '', result: null, error: null, running: false },
  indexes: null,
  relations: null
};

let queryTabs = [{ id: 1, title: 'Query 1', sql: null, result: null, error: null, running: false }];
let activeQuery = 0;
let queryId = 1;
app.query = queryTabs[0];

const sqlAutocomplete = {
  items: [],
  selected: 0,
  context: null,
  requestId: 0,
  columnCache: new Map(),
  blurTimer: null,
  composing: false
};

const $ = (selector) => document.querySelector(selector);

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[character]));
}

function debounce(fn, delay = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function toast(message, type = 'info') {
  const element = $('#toast');
  element.textContent = message;
  element.className = type === 'error' ? 'toast-error' : '';
  element.style.display = 'block';
  clearTimeout(window.__sqlproToast);
  window.__sqlproToast = setTimeout(() => { element.style.display = 'none'; }, 4000);
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function modal(html, wide = false) {
  const dialog = $('#modal');
  dialog.className = wide ? 'wide' : '';
  dialog.innerHTML = html;
  if (!dialog.open) dialog.showModal();
}

function closeModal() {
  const dialog = $('#modal');
  if (dialog.open) dialog.close();
}

function setStatus(text) {
  $('#status').textContent = text;
}

function setConnectionState(kind, detail = '') {
  const dot = $('#connDot');
  const label = $('#connState');
  const serverInfo = $('#serverInfo');
  if (kind === 'connected') {
    dot.style.background = '#24a68b';
    label.textContent = detail || 'Đã kết nối';
    serverInfo.textContent = `${app.serverType.toUpperCase()} ${app.server || ''} • ${app.database || 'chưa chọn database'}`;
  } else if (kind === 'connecting') {
    dot.style.background = '#c9a227';
    label.textContent = 'Đang kết nối…';
    serverInfo.textContent = 'Đang kết nối…';
  } else if (kind === 'error') {
    dot.style.background = '#c24b4b';
    label.textContent = detail || 'Lỗi kết nối';
    serverInfo.textContent = 'Chưa kết nối';
  } else {
    dot.style.background = '#c9d3db';
    label.textContent = detail || 'Chưa kết nối';
    serverInfo.textContent = 'Chưa kết nối';
  }
}

async function call(promise) {
  const response = await promise;
  if (!response) throw new Error('Không có phản hồi từ ứng dụng.');
  if (!response.ok) {
    const error = new Error(response.error?.message || 'Đã xảy ra lỗi.');
    error.code = response.error?.code || '';
    throw error;
  }
  return response.data;
}

function quoteId(name) {
  return `\`${String(name).replace(/`/g, '``')}\``;
}

function defaultSql() {
  if (!table || !app.database) return 'SELECT 1;';
  return `SELECT *\nFROM ${quoteId(app.database)}.${quoteId(table)}\nLIMIT 100;`;
}

function closeSqlSuggestions() {
  sqlAutocomplete.requestId += 1;
  sqlAutocomplete.items = [];
  sqlAutocomplete.context = null;
  sqlAutocomplete.selected = 0;
  const host = $('#sqlSuggestions');
  const editor = $('#sql');
  if (host) {
    host.classList.add('hidden');
    host.innerHTML = '';
  }
  if (editor) {
    editor.setAttribute('aria-expanded', 'false');
    editor.removeAttribute('aria-activedescendant');
  }
}

function invalidateSqlAutocomplete() {
  sqlAutocomplete.columnCache.clear();
  closeSqlSuggestions();
}

function autocompleteCacheKey(database, tableName) {
  return `${app.connection?.id || ''}\u0000${database || ''}\u0000${tableName || ''}`.toLocaleLowerCase();
}

function loadAutocompleteColumns(database, tableName) {
  if (!desktop || !app.connection || !database || !tableName) return Promise.resolve([]);
  const key = autocompleteCacheKey(database, tableName);
  const cached = sqlAutocomplete.columnCache.get(key);
  if (cached) return cached;
  const pending = call(desktop.db.columns(database, tableName))
    .catch(() => {
      sqlAutocomplete.columnCache.delete(key);
      return [];
    });
  sqlAutocomplete.columnCache.set(key, pending);
  return pending;
}

function autocompleteTypeLabel(type) {
  return ({ keyword: 'SQL', function: 'Hàm', snippet: 'Mẫu', table: 'Bảng', view: 'View', column: 'Cột' })[type] || type || 'SQL';
}

function setSqlSuggestionSelection(index) {
  if (!sqlAutocomplete.items.length) return;
  const count = sqlAutocomplete.items.length;
  sqlAutocomplete.selected = ((index % count) + count) % count;
  const host = $('#sqlSuggestions');
  if (!host) return;
  host.querySelectorAll('[data-sql-suggestion]').forEach((element, itemIndex) => {
    const selected = itemIndex === sqlAutocomplete.selected;
    element.classList.toggle('selected', selected);
    element.setAttribute('aria-selected', selected ? 'true' : 'false');
    if (selected) {
      $('#sql')?.setAttribute('aria-activedescendant', element.id);
      element.scrollIntoView({ block: 'nearest' });
    }
  });
}

function positionSqlSuggestions(editor, host) {
  const wrapper = editor.closest('.sql-editor-wrap');
  if (!wrapper) return;
  const computed = getComputedStyle(editor);
  const mirror = document.createElement('div');
  Object.assign(mirror.style, {
    position: 'absolute',
    visibility: 'hidden',
    pointerEvents: 'none',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
    wordBreak: computed.wordBreak,
    boxSizing: computed.boxSizing,
    width: `${editor.offsetWidth}px`,
    padding: computed.padding,
    border: computed.border,
    font: computed.font,
    lineHeight: computed.lineHeight,
    letterSpacing: computed.letterSpacing
  });
  mirror.textContent = editor.value.slice(0, editor.selectionStart);
  const marker = document.createElement('span');
  marker.textContent = '\u200b';
  mirror.appendChild(marker);
  wrapper.appendChild(mirror);
  const lineHeight = Number.parseFloat(computed.lineHeight) || 23;
  const rawLeft = marker.offsetLeft - editor.scrollLeft;
  const rawTop = marker.offsetTop - editor.scrollTop + lineHeight + 4;
  mirror.remove();
  const maxLeft = Math.max(8, wrapper.clientWidth - Math.min(host.offsetWidth || 360, 560) - 8);
  host.style.left = `${Math.max(8, Math.min(rawLeft, maxLeft))}px`;
  host.style.top = `${Math.max(8, rawTop)}px`;
}

function renderSqlSuggestions(editor, context, items) {
  const host = $('#sqlSuggestions');
  if (!host) return;
  if (!items.length) {
    sqlAutocomplete.items = [];
    sqlAutocomplete.context = context;
    sqlAutocomplete.selected = 0;
    host.classList.add('hidden');
    host.innerHTML = '';
    editor.setAttribute('aria-expanded', 'false');
    editor.removeAttribute('aria-activedescendant');
    return;
  }
  sqlAutocomplete.items = items;
  sqlAutocomplete.context = context;
  sqlAutocomplete.selected = Math.min(sqlAutocomplete.selected, items.length - 1);
  host.innerHTML = items.map((item, index) => `
    <div class="sql-suggestion${index === sqlAutocomplete.selected ? ' selected' : ''}"
         id="sqlSuggestion${index}" data-sql-suggestion="${index}" role="option"
         aria-selected="${index === sqlAutocomplete.selected ? 'true' : 'false'}">
      <span class="sql-suggestion-main">
        <span class="sql-suggestion-kind">${esc(autocompleteTypeLabel(item.type))}</span>
        <span class="sql-suggestion-label">${esc(item.label)}</span>
      </span>
      <span class="sql-suggestion-detail">${esc(item.detail || '')}</span>
    </div>
  `).join('');
  host.classList.remove('hidden');
  editor.setAttribute('aria-expanded', 'true');
  editor.setAttribute('aria-activedescendant', `sqlSuggestion${sqlAutocomplete.selected}`);
  positionSqlSuggestions(editor, host);
}

function resolveAutocompleteReference(context, qualifier) {
  const lower = String(qualifier || '').toLocaleLowerCase();
  const reference = context.references.find((entry) =>
    String(entry.alias || '').toLocaleLowerCase() === lower
      || String(entry.table || '').toLocaleLowerCase() === lower
  );
  if (reference) return reference;
  const object = app.tables.find((entry) => entry.name.toLocaleLowerCase() === lower);
  return object ? { table: object.name } : null;
}

function tableAutocompleteItems() {
  return app.tables.map((entry) => ({
    label: entry.name,
    insertText: quoteId(entry.name),
    type: entry.type === 'view' ? 'view' : 'table',
    detail: `${entry.type === 'view' ? 'View' : 'Bảng'} · ${app.database || ''}`
  }));
}

async function refreshSqlSuggestions(editor, force = false) {
  const api = window.SqlAutocomplete;
  if (!api || !editor || sqlAutocomplete.composing || editor !== $('#sql')) return;
  const context = api.getContext(editor.value, editor.selectionStart);
  const localCaret = editor.selectionStart - context.statementStart;
  const beforeCaret = context.statement.slice(0, Math.max(0, localCaret));
  const expectsTable = /\b(?:FROM|JOIN|UPDATE|INTO|TABLE|DESCRIBE|DESC)\s+(?:`[^`]*|[A-Za-z0-9_$]*)$/i.test(beforeCaret);
  if (context.disabled || (!force && !context.qualifier && !context.prefix && !expectsTable)) {
    closeSqlSuggestions();
    return;
  }

  const requestId = ++sqlAutocomplete.requestId;
  const captured = {
    tabId: app.query?.id,
    connectionId: app.connection?.id,
    database: app.database,
    value: editor.value,
    caret: editor.selectionStart
  };
  const tables = tableAutocompleteItems();
  let baseItems;
  if (context.qualifier) {
    baseItems = [];
  } else if (expectsTable) {
    baseItems = tables;
  } else {
    baseItems = [...api.SQL_SUGGESTIONS, ...tables];
  }
  const rankedBase = api.rankSuggestions(baseItems, context.prefix, 60);
  renderSqlSuggestions(editor, context, rankedBase);

  let targets = [];
  if (context.qualifier) {
    const reference = resolveAutocompleteReference(context, context.qualifier);
    if (reference) targets = [reference];
  } else if (!expectsTable) {
    const seen = new Set();
    targets = context.references.filter((reference) => {
      const key = `${reference.database || app.database || ''}\u0000${reference.table}`.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 5);
  }
  if (!targets.length) return;

  const columnGroups = await Promise.all(targets.map(async (reference) => ({
    reference,
    columns: await loadAutocompleteColumns(reference.database || app.database, reference.table)
  })));
  if (requestId !== sqlAutocomplete.requestId
      || editor !== $('#sql')
      || !editor.isConnected
      || mode !== 'query'
      || app.query?.id !== captured.tabId
      || app.connection?.id !== captured.connectionId
      || app.database !== captured.database
      || editor.value !== captured.value
      || editor.selectionStart !== captured.caret) return;

  const multipleReferences = context.references.length > 1;
  const columnItems = columnGroups.flatMap(({ reference, columns }) => columns.map((column) => {
    const owner = reference.alias || reference.table;
    const qualified = !context.qualifier && multipleReferences;
    return {
      label: context.qualifier || qualified ? `${owner}.${column.name}` : column.name,
      insertText: context.qualifier
        ? quoteId(column.name)
        : (qualified ? `${quoteId(owner)}.${quoteId(column.name)}` : quoteId(column.name)),
      type: 'column',
      detail: `${reference.table} · ${column.type || 'column'}`
    };
  }));
  renderSqlSuggestions(editor, context, api.rankSuggestions([...columnItems, ...baseItems], context.prefix, 60));
}

function acceptSqlSuggestion(editor, index = sqlAutocomplete.selected) {
  const item = sqlAutocomplete.items[index];
  const context = sqlAutocomplete.context;
  if (!editor || !item || !context) return;
  const insertText = String(item.insertText ?? item.label);
  editor.setRangeText(insertText, context.start, context.end, 'end');
  if (/\(\)$/.test(insertText)) {
    const caret = editor.selectionStart - 1;
    editor.setSelectionRange(caret, caret);
  }
  app.query.sql = editor.value;
  sessionStorage.setItem('query', editor.value);
  persistState();
  closeSqlSuggestions();
  editor.focus();
}

function normalizeHistory(item) {
  if (typeof item === 'string') return { sql: item, ok: true, at: '', durationMs: null };
  if (!item || typeof item !== 'object' || typeof item.sql !== 'string') return null;
  return {
    sql: item.sql,
    ok: item.ok !== false,
    at: typeof item.at === 'string' ? item.at : '',
    durationMs: Number.isFinite(item.durationMs) ? item.durationMs : null,
    message: typeof item.message === 'string' ? item.message : ''
  };
}

let persistTimer;
function persistState() {
  if (!desktop) return;
  const editor = $('#sql');
  if (mode === 'query' && editor && app.query) app.query.sql = editor.value;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    desktop.saveState({
      connectionId: app.connection ? app.connection.id : null,
      workspaceId: app.activeWorkspaceId,
      database: app.database,
      table,
      mode,
      savedQuery: app.query?.sql ?? (sessionStorage.getItem('query') || ''),
      queryTabs: queryTabs.map((tab) => ({ title: tab.title, sql: tab.sql ?? '' })),
      activeQuery,
      history: historyRows.slice(0, 100)
    }).catch(() => undefined);
  }, 150);
}

async function init() {
  $('#treeSearch').addEventListener('input', debounce(renderSidebar, 180));
  $('#workspaceSelect').addEventListener('change', (event) => switchWorkspace(event.target.value));
  $('#connectionList').addEventListener('click', onConnectionClick);
  $('#databaseTree').addEventListener('click', onTreeClick);
  $('#tabs').addEventListener('click', onTabClick);

  if (!desktop) {
    ensureDefaultWorkspace();
    renderWorkspaceSwitcher();
    renderSidebar();
    view('data');
    return;
  }

  if (desktop.account?.onStatus) {
    desktop.account.onStatus((status) => {
      app.account = status;
      renderAccountChrome();
      if (status.loggedIn && $('#accountSync')) renderAccountPanel(status);
    });
  }
  if (desktop.account?.onApplied) {
    desktop.account.onApplied(onSyncApplied);
  }

  desktop.onDbProgress?.((progress) => {
    if (!progress || typeof progress !== 'object') return;
    if (progress.operation === 'backup') {
      setStatus(`Đang sao lưu… ${progress.rows || 0} dòng · ${formatBytes(progress.bytes)}`);
    } else if (progress.operation === 'restore') {
      setStatus(`Đang phục hồi… ${progress.executed || 0} câu lệnh · ${formatBytes(progress.bytes)}`);
    }
  });

  let saved = {};
  try {
    saved = await desktop.loadState();
  } catch {
    saved = {};
  }
  if (saved && Array.isArray(saved.queryTabs) && saved.queryTabs.length) {
    queryTabs = saved.queryTabs.slice(0, 50).map((tab, index) => ({
      id: index + 1,
      title: tab && typeof tab.title === 'string' && tab.title.trim()
        ? tab.title.trim().slice(0, 40)
        : `Query ${index + 1}`,
      sql: tab && typeof tab.sql === 'string' ? tab.sql : '',
      result: null,
      error: null,
      running: false
    }));
    queryId = queryTabs.reduce((max, tab) => {
      const match = /(\d+)\s*$/.exec(tab.title);
      return Math.max(max, match ? Number(match[1]) : 0);
    }, queryTabs.length);
    activeQuery = Number.isInteger(saved.activeQuery)
      ? Math.min(Math.max(saved.activeQuery, 0), queryTabs.length - 1)
      : 0;
    app.query = queryTabs[activeQuery];
  }
  if (saved && typeof saved.savedQuery === 'string' && saved.savedQuery) {
    if (!Array.isArray(saved.queryTabs) || !saved.queryTabs.length) queryTabs[0].sql = saved.savedQuery;
    sessionStorage.setItem('query', saved.savedQuery);
  }
  if (saved && Array.isArray(saved.history)) {
    historyRows = saved.history.map(normalizeHistory).filter(Boolean).slice(0, 100);
  }
  if (saved && typeof saved.table === 'string') table = saved.table;
  if (saved && typeof saved.workspaceId === 'string') app.activeWorkspaceId = saved.workspaceId;

  try {
    await refreshWorkspaces();
  } catch (error) {
    toast(error.message, 'error');
  }

  try {
    await refreshConnections();
  } catch (error) {
    toast(error.message, 'error');
  }

  if (saved && saved.connectionId && app.connections.some((connection) => connection.id === saved.connectionId)) {
    await connectTo(saved.connectionId, {
      database: saved.database,
      table: saved.table,
      mode: saved.mode,
      silent: true
    });
  } else {
    renderSidebar();
    view('data');
  }
  await refreshAccountStatus();
}

function ensureDefaultWorkspace() {
  if (!Array.isArray(app.workspaces) || !app.workspaces.length) {
    app.workspaces = [{
      id: DEFAULT_WORKSPACE_ID,
      name: 'Cá nhân',
      description: '',
      isDefault: true,
      connectionCount: 0
    }];
  }
  if (!app.workspaces.some((workspace) => workspace.id === app.activeWorkspaceId)) {
    const fallback = app.workspaces.find((workspace) => workspace.isDefault || workspace.id === DEFAULT_WORKSPACE_ID);
    app.activeWorkspaceId = (fallback || app.workspaces[0]).id;
  }
}

function activeWorkspace() {
  ensureDefaultWorkspace();
  return app.workspaces.find((workspace) => workspace.id === app.activeWorkspaceId) || app.workspaces[0];
}

function workspaceConnectionCount(workspaceId) {
  return app.connections.filter((connection) => (connection.workspaceId || DEFAULT_WORKSPACE_ID) === workspaceId).length;
}

function renderWorkspaceSwitcher() {
  const select = $('#workspaceSelect');
  if (!select) return;
  ensureDefaultWorkspace();
  select.innerHTML = app.workspaces.map((workspace) => (
    `<option value="${esc(workspace.id)}">${esc(workspace.name)} · ${workspaceConnectionCount(workspace.id)}</option>`
  )).join('');
  select.value = app.activeWorkspaceId;
  select.title = activeWorkspace().description || 'Chọn workspace';
}

async function refreshWorkspaces() {
  if (desktop?.workspaces) {
    const workspaces = await call(desktop.workspaces.list());
    if (Array.isArray(workspaces) && workspaces.length) app.workspaces = workspaces;
  }
  ensureDefaultWorkspace();
  renderWorkspaceSwitcher();
}

async function switchWorkspace(workspaceId) {
  if (!workspaceId || !app.workspaces.some((workspace) => workspace.id === workspaceId)) {
    renderWorkspaceSwitcher();
    return;
  }
  if (workspaceId === app.activeWorkspaceId) return;
  if (app.connection) {
    const current = app.connections.find((connection) => connection.id === app.connection.id);
    const currentWorkspace = current ? current.workspaceId : app.connection.workspaceId;
    if ((currentWorkspace || DEFAULT_WORKSPACE_ID) !== workspaceId) await disconnect();
  }
  app.activeWorkspaceId = workspaceId;
  renderWorkspaceSwitcher();
  renderSidebar();
  view('data');
  persistState();
}

async function refreshConnections() {
  if (!desktop) {
    app.connections = [];
    ensureDefaultWorkspace();
    renderWorkspaceSwitcher();
    renderSidebar();
    return;
  }
  app.connections = await call(desktop.connections.list());
  ensureDefaultWorkspace();
  if (app.connection) {
    const current = app.connections.find((connection) => connection.id === app.connection.id);
    if (current) app.connection = current;
  }
  renderWorkspaceSwitcher();
  renderSidebar();
}

function renderSidebar() {
  const term = ($('#treeSearch').value || '').trim().toLowerCase();
  const workspaceConnections = app.connections.filter((connection) => (
    connection.workspaceId || DEFAULT_WORKSPACE_ID
  ) === app.activeWorkspaceId);
  const connections = workspaceConnections.filter((connection) => {
    if (!term) return true;
    return [connection.name, connection.host, connection.user, connection.database]
      .some((value) => String(value || '').toLowerCase().includes(term));
  });

  const connectionHtml = connections.map((connection) => {
    const active = app.connection && app.connection.id === connection.id;
    const typeLabel = connection.type === 'mariadb' ? 'MARIA' : 'MYSQL';
    return `
      <div class="connitem ${active ? 'active' : ''}" data-connection="${esc(connection.id)}">
        <i class="dot" style="background:${active ? '#24a68b' : '#c9d3db'}"></i>
        <span class="name">${esc(connection.name)}</span>
        <span class="badge type">${typeLabel}</span>
        <button class="more" data-menu="${esc(connection.id)}" title="Tùy chọn">···</button>
      </div>
      <div class="connmeta">${esc(connection.user || 'root')}@${esc(connection.host)}:${connection.port}${connection.ssh.enabled ? ' · SSH' : ''}</div>
    `;
  }).join('');

  $('#connectionList').innerHTML = connectionHtml || `
    <div class="empty small">
      ${term ? 'Không có kết nối phù hợp.' : `Workspace <strong>${esc(activeWorkspace().name)}</strong> chưa có kết nối.`}<br>
      <button onclick="connection()">Kết nối mới</button>
      <button onclick="importNavicat()">Nhập Navicat</button>
    </div>
  `;

  const tree = $('#databaseTree');
  if (!app.connection) {
    tree.innerHTML = '<div class="empty small">Chọn hoặc tạo kết nối để bắt đầu.</div>';
    return;
  }
  if (!app.database) {
    const databases = app.databases.filter((name) => !term || name.toLowerCase().includes(term));
    tree.innerHTML = `
      <div class="sideheading sub">DATABASES <button data-refresh-dbs="1" title="Làm mới">↻</button></div>
      ${databases.length
        ? databases.map((name) => `<div class="database dbitem" data-db="${esc(name)}">▱ &nbsp; ${esc(name)}</div>`).join('')
        : '<div class="empty small">Không có database phù hợp.</div>'}
    `;
    return;
  }

  const tables = app.tables.filter((entry) => entry.type === 'table' && (!term || entry.name.toLowerCase().includes(term)));
  const views = app.tables.filter((entry) => entry.type === 'view' && (!term || entry.name.toLowerCase().includes(term)));
  tree.innerHTML = `
    <div class="database" data-db-list="1" title="Chọn database khác">⌄ &nbsp;▱ &nbsp; ${esc(app.database)} <span>${app.tables.length}</span></div>
    <div class="dbactions">
      <button data-backup-db="1" title="Sao lưu database ra tệp .sql">⇩ Sao lưu</button>
      <button data-restore-db="1" title="Phục hồi database từ tệp .sql">⇧ Phục hồi</button>
    </div>
    <div class="sideheading sub">TABLES <span>${tables.length}</span></div>
    <div id="tree">
      ${tables.map((entry) => `
        <div class="treeitem ${entry.name === table ? 'selected' : ''}" data-table="${esc(entry.name)}">
          <span>▦</span>${esc(entry.name)}${entry.rowEstimate !== null ? `<span class="rowcount">${entry.rowEstimate}</span>` : ''}
        </div>
      `).join('') || '<div class="empty small">Không có bảng.</div>'}
    </div>
    <div class="sideheading sub">VIEWS <span>${views.length}</span></div>
    ${views.map((entry) => `
      <div class="treeitem ${entry.name === table ? 'selected' : ''}" data-table="${esc(entry.name)}">
        <span>◫</span>${esc(entry.name)}
      </div>
    `).join('') || '<div class="empty small">Không có view.</div>'}
  `;
}

function onConnectionClick(event) {
  const menuButton = event.target.closest('[data-menu]');
  if (menuButton) {
    event.stopPropagation();
    connectionMenu(menuButton.dataset.menu);
    return;
  }
  const item = event.target.closest('[data-connection]');
  if (item) connectTo(item.dataset.connection);
}

function onTreeClick(event) {
  if (event.target.closest('[data-backup-db]')) {
    backupDatabase();
    return;
  }
  if (event.target.closest('[data-restore-db]')) {
    restoreDatabase();
    return;
  }
  if (event.target.closest('[data-refresh-dbs]')) {
    refreshDatabases();
    return;
  }
  if (event.target.closest('[data-db-list]')) {
    invalidateSqlAutocomplete();
    app.database = null;
    app.tables = [];
    table = null;
    app.rows = [];
    renderSidebar();
    view('data');
    return;
  }
  const databaseItem = event.target.closest('[data-db]');
  if (databaseItem) {
    selectDatabase(databaseItem.dataset.db);
    return;
  }
  const tableItem = event.target.closest('[data-table]');
  if (tableItem) selectTable(tableItem.dataset.table);
}

async function refreshDatabases() {
  if (!desktop || !app.connection) return;
  try {
    app.databases = await call(desktop.db.databases());
    renderSidebar();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function connectTo(id, options = {}) {
  const profile = app.connections.find((connection) => connection.id === id);
  if (!profile) return;
  if (profile.workspaceId && profile.workspaceId !== app.activeWorkspaceId) {
    app.activeWorkspaceId = profile.workspaceId;
    renderWorkspaceSwitcher();
  }
  if (app.connection && app.connection.id === id && app.database && options.keepSession) {
    renderSidebar();
    return;
  }
  invalidateSqlAutocomplete();
  app.connection = profile;
  app.serverType = profile.type;
  app.server = '';
  app.databases = [];
  app.database = null;
  app.tables = [];
  app.columns = [];
  app.rows = [];
  app.total = null;
  table = null;
  setConnectionState('connecting');
  renderSidebar();
  view('data');
  try {
    const data = await call(desktop.db.connect(id));
    app.server = data.server;
    app.databases = data.databases;
    setConnectionState('connected', 'Đã kết nối');
    const preferred = options.database && app.databases.includes(options.database)
      ? options.database
      : (profile.database && app.databases.includes(profile.database) ? profile.database : null);
    if (preferred) {
      await selectDatabase(preferred, options);
    } else if (app.databases.length === 1) {
      await selectDatabase(app.databases[0], options);
    } else {
      renderSidebar();
      view('data');
    }
    setStatus(`Kết nối thành công • ${app.server}`);
    if (!options.silent) toast(`Đã kết nối ${profile.name}`);
    persistState();
  } catch (error) {
    app.connection = null;
    app.server = '';
    app.databases = [];
    app.database = null;
    app.tables = [];
    app.columns = [];
    app.rows = [];
    table = null;
    setStatus('Chưa kết nối');
    toast(error.message, 'error');
    renderSidebar();
    await view('data');
    setConnectionState('error', error.message);
  }
}

async function selectDatabase(database, options = {}) {
  invalidateSqlAutocomplete();
  try {
    await call(desktop.db.useDatabase(database));
  } catch (error) {
    toast(error.message, 'error');
    return;
  }
  app.database = database;
  table = null;
  app.tables = [];
  app.columns = [];
  app.rows = [];
  app.total = null;
  try {
    app.tables = await call(desktop.db.tables(database));
  } catch (error) {
    toast(error.message, 'error');
    app.tables = [];
  }
  renderSidebar();
  setConnectionState('connected', 'Đã kết nối');
  const candidate = options.table && app.tables.find((entry) => entry.name === options.table)
    ? options.table
    : (app.tables.find((entry) => entry.type === 'table')?.name || app.tables[0]?.name || null);
  if (candidate) {
    await selectTable(candidate, { mode: options.mode, silent: options.silent });
  } else {
    view(options.mode || 'data');
  }
  persistState();
}

async function selectTable(name, options = {}) {
  table = name;
  app.page = 1;
  app.search = '';
  renderSidebar();
  const nextMode = options.mode && options.mode !== 'history' ? options.mode : 'data';
  if (nextMode === 'data') {
    await loadData();
  } else {
    await view(nextMode);
  }
  persistState();
}

async function loadData() {
  if (!app.connection || !app.database || !table) {
    renderEmptyTable();
    return;
  }
  workspaceLoading();
  updateChrome();
  try {
    const data = await call(desktop.db.tableData({
      database: app.database,
      table,
      page: app.page,
      pageSize: app.pageSize,
      search: app.search
    }));
    app.columns = data.columns;
    app.primaryKey = data.primaryKey;
    app.rows = data.rows;
    app.total = data.total;
    app.page = data.page;
    app.pageSize = data.pageSize;
    renderDataView();
    setStatus(`Đã tải ${data.rows.length} dòng • ${app.database}.${table}`);
  } catch (error) {
    renderError(error);
  }
}

function syncActiveQuery() {
  if (mode !== 'query') return;
  const editor = $('#sql');
  if (!editor || !app.query) return;
  app.query.sql = editor.value;
  sessionStorage.setItem('query', editor.value);
}

function renderQueryTabs() {
  const host = $('#queryTabs');
  if (!host) return;
  host.innerHTML = queryTabs.map((tab, index) => `
    <button class="querytab${mode === 'query' && index === activeQuery ? ' selected' : ''}" data-query-tab="${index}" title="${esc(tab.title)}">
      ⌑ &nbsp; ${esc(tab.title)}${tab.running ? ' <span class="tabrunning">…</span>' : ''} &nbsp; <span class="tabclose" data-close-query="${index}" title="Đóng tab">×</span>
    </button>
  `).join('');
}

function onTabClick(event) {
  const close = event.target.closest('[data-close-query]');
  if (close) {
    event.preventDefault();
    event.stopPropagation();
    closeQueryTab(Number(close.dataset.closeQuery));
    return;
  }
  const tab = event.target.closest('[data-query-tab]');
  if (tab) selectQueryTab(Number(tab.dataset.queryTab));
}

function newQuery(sql = '') {
  if (!desktop || !app.connection) {
    toast('Chọn kết nối trước khi mở truy vấn.', 'error');
    view('query');
    return;
  }
  if (queryTabs.length >= 50) {
    toast('Đã mở tối đa 50 tab truy vấn.', 'error');
    return;
  }
  syncActiveQuery();
  queryId += 1;
  const tab = { id: queryId, title: `Query ${queryId}`, sql: String(sql ?? ''), result: null, error: null, running: false };
  queryTabs.push(tab);
  activeQuery = queryTabs.length - 1;
  app.query = tab;
  mode = 'query';
  updateChrome();
  renderQueryView();
  persistState();
  $('#sql')?.focus();
}

function selectQueryTab(index) {
  if (index < 0 || index >= queryTabs.length) return;
  if (index === activeQuery && mode === 'query') {
    $('#sql')?.focus();
    return;
  }
  syncActiveQuery();
  activeQuery = index;
  app.query = queryTabs[index];
  mode = 'query';
  updateChrome();
  if (!app.connection) renderWelcome();
  else renderQueryView();
  persistState();
  $('#sql')?.focus();
}

function closeQueryTab(index) {
  if (index < 0 || index >= queryTabs.length) return;
  const tab = queryTabs[index];
  if (tab.running) {
    toast('Không thể đóng tab khi truy vấn đang chạy.', 'error');
    return;
  }
  const wasActive = index === activeQuery;
  if (mode === 'query' && wasActive) syncActiveQuery();
  queryTabs.splice(index, 1);
  if (!queryTabs.length) {
    queryId += 1;
    queryTabs.push({ id: queryId, title: `Query ${queryId}`, sql: '', result: null, error: null, running: false });
    activeQuery = 0;
  } else if (index < activeQuery) {
    activeQuery -= 1;
  } else if (wasActive) {
    activeQuery = Math.min(activeQuery, queryTabs.length - 1);
  }
  app.query = queryTabs[activeQuery];
  updateChrome();
  if (mode === 'query' && wasActive) {
    if (!app.connection) renderWelcome();
    else renderQueryView();
  }
  persistState();
}

function updateChrome() {
  document.body.classList.toggle('query-mode', mode === 'query');
  const label = mode === 'query' ? 'QUERY' : mode === 'history' ? 'WORKSPACE' : mode === 'data' ? 'TABLE' : mode.toUpperCase();
  const title = mode === 'query' ? 'SQL Editor' : mode === 'history' ? 'Lịch sử truy vấn' : (table || app.database || 'Workspace');
  $('#title').innerHTML = `${esc(title)} <span>${label}</span>`;
  $('#eyebrow').textContent = `${(app.database || 'NO DATABASE').toUpperCase()} / ${mode === 'query' ? 'QUERY' : mode === 'history' ? 'WORKSPACE' : 'TABLES'}`;
  const subtitles = {
    data: table ? `Bảng ${table} trong ${app.database}.` : 'Chọn một bảng để xem dữ liệu thật.',
    structure: table ? `Cấu trúc cột của ${app.database}.${table}.` : 'Chọn một bảng để xem cấu trúc.',
    indexes: table ? `Indexes của ${app.database}.${table}.` : 'Chọn một bảng để xem indexes.',
    relations: table ? `Quan hệ khóa ngoại của ${app.database}.${table}.` : 'Chọn một bảng để xem quan hệ.',
    query: 'Soạn và chạy truy vấn thật trên kết nối đang mở.',
    history: 'Các truy vấn đã chạy trong phiên làm việc.'
  };
  $('#subtitle').textContent = subtitles[mode] || '';
  $('#crumbDb').textContent = app.database || '—';
  $('#crumbServer').textContent = app.connection ? `${app.serverType === 'mariadb' ? 'MARIADB' : 'MYSQL'}${app.server ? ` ${app.server}` : ''}` : 'NO CONNECTION';
  $('#tabName').textContent = table || '—';
  $('#dataTab').classList.toggle('selected', mode !== 'query');
  renderQueryTabs();
  $('#subnav').style.display = ['query', 'history'].includes(mode) ? 'none' : 'flex';
  [...$('#subnav').children].forEach((button, index) => {
    button.classList.toggle('current', ['data', 'structure', 'indexes', 'relations'][index] === mode);
  });
  document.title = `${mode === 'query' ? 'SQL Editor' : mode === 'history' ? 'Lịch sử' : (table || 'Workspace')} — ${app.database || 'SqlPro'} — SqlPro`;
}

async function view(nextMode) {
  if (mode === 'query' && nextMode !== 'query') syncActiveQuery();
  mode = nextMode;
  updateChrome();
  if (!app.connection) {
    renderWelcome();
    return;
  }
  if (nextMode === 'query') {
    app.query = queryTabs[activeQuery];
    renderQueryView();
    persistState();
    return;
  }
  if (!app.database) {
    renderDatabasePicker();
    return;
  }
  if (nextMode === 'data') {
    if (table) await loadData();
    else renderEmptyTable();
  } else if (nextMode === 'history') {
    renderHistoryView();
  } else if (nextMode === 'structure') {
    if (!table) {
      renderEmptyTable('Chọn một bảng để xem cấu trúc.');
      return;
    }
    workspaceLoading();
    try {
      app.columns = await call(desktop.db.columns(app.database, table));
      renderStructureView();
    } catch (error) {
      renderError(error);
    }
  } else if (nextMode === 'indexes') {
    if (!table) {
      renderEmptyTable('Chọn một bảng để xem indexes.');
      return;
    }
    workspaceLoading();
    try {
      app.indexes = await call(desktop.db.indexes(app.database, table));
      renderIndexesView();
    } catch (error) {
      renderError(error);
    }
  } else if (nextMode === 'relations') {
    if (!table) {
      renderEmptyTable('Chọn một bảng để xem quan hệ.');
      return;
    }
    workspaceLoading();
    try {
      app.relations = await call(desktop.db.relations(app.database, table));
      renderRelationsView();
    } catch (error) {
      renderError(error);
    }
  }
  persistState();
}

function workspaceLoading() {
  $('#workspace').innerHTML = '<div class="empty">Đang tải dữ liệu…</div>';
}

function renderWelcome() {
  const hasConnections = app.connections.length > 0;
  $('#workspace').innerHTML = `
    <div class="welcome">
      <h2>${hasConnections ? 'Chọn một kết nối để bắt đầu' : 'Kết nối database đầu tiên'}</h2>
      <p>SqlPro chạy truy vấn thật trên MySQL/MariaDB. Thông số kết nối tương thích Navicat, bao gồm SSH tunnel và SSL.</p>
      <div class="welcome-actions">
        <button class="primary" onclick="connection()">＋ Kết nối mới</button>
        <button onclick="importNavicat()">⇩ Nhập kết nối Navicat</button>
      </div>
      ${hasConnections ? '<div class="hint">Chọn kết nối ở thanh bên trái, hoặc nhấn Ctrl+N để tạo mới.</div>' : ''}
    </div>
  `;
  setConnectionState('idle');
}

function renderDatabasePicker() {
  $('#workspace').innerHTML = `
    <div class="welcome">
      <h2>Chọn database</h2>
      <p>Đã kết nối ${esc(app.connection.name)}. Chọn database để xem bảng.</p>
      <div class="dblist">
        ${app.databases.map((name) => `<button class="dbpick" data-pick-db="${esc(name)}">▱ ${esc(name)}</button>`).join('') || '<div class="empty">Không có database.</div>'}
      </div>
    </div>
  `;
  $('#workspace').querySelectorAll('[data-pick-db]').forEach((button) => {
    button.addEventListener('click', () => selectDatabase(button.dataset.pickDb));
  });
}

function renderEmptyTable(message = 'Chưa chọn bảng.') {
  $('#workspace').innerHTML = `<div class="empty">${esc(message)}</div>`;
}

function renderError(error) {
  $('#workspace').innerHTML = `
    <div class="empty">
      <div class="errorbox">${esc(error.message || 'Đã xảy ra lỗi.')}</div>
      <button onclick="loadData()">Thử lại</button>
    </div>
  `;
  setStatus(error.message || 'Lỗi');
}

function renderDataView() {
  const editable = app.primaryKey.length > 0;
  $('#workspace').innerHTML = `
    <div class="toolbar">
      <input class="filter" id="filter" placeholder="⌕  Tìm trong bảng…" value="${esc(app.search)}">
      <button id="addRowBtn">＋ Thêm bản ghi</button>
      <button class="danger" id="deleteRowsBtn" ${editable ? '' : 'disabled title="Bảng không có khóa chính"'}>⌫ Xóa</button>
      <button id="refreshBtn">↻</button>
      <button id="importBtn">↥ Nhập</button>
      <button id="exportBtn">↧ Xuất</button>
    </div>
    <div id="grid">${dataGridHtml()}</div>
    <div class="hint">
      ${editable
        ? 'ⓘ <span><strong>Chỉnh sửa thật</strong> &nbsp; Nhấp đúp vào một dòng để sửa. Thay đổi ghi trực tiếp vào database.</span>'
        : 'ⓘ <span><strong>Chỉ đọc</strong> &nbsp; Bảng không có khóa chính nên không thể sửa/xóa trực tiếp từ lưới.</span>'}
    </div>
  `;
  const filter = $('#filter');
  filter.addEventListener('input', debounce(() => {
    app.search = filter.value;
    app.page = 1;
    loadData().then(() => {
      const next = $('#filter');
      if (next) {
        next.focus();
        next.setSelectionRange(next.value.length, next.value.length);
      }
    });
  }, 350));
  $('#addRowBtn').addEventListener('click', () => editRow(null));
  $('#deleteRowsBtn').addEventListener('click', deleteSelectedRows);
  $('#refreshBtn').addEventListener('click', () => loadData());
  $('#importBtn').addEventListener('click', () => transfer('import'));
  $('#exportBtn').addEventListener('click', () => transfer('export'));
  const grid = $('#grid');
  grid.addEventListener('dblclick', (event) => {
    const row = event.target.closest('tr[data-row]');
    if (!row) return;
    if (!editable) {
      toast('Bảng không có khóa chính nên không thể sửa trực tiếp.', 'error');
      return;
    }
    editRow(Number(row.dataset.row));
  });
  positionPagination();
}

function dataGridHtml() {
  const editable = app.primaryKey.length > 0;
  const pageCount = app.total === null ? null : Math.max(1, Math.ceil(app.total / app.pageSize));
  const header = `
    <tr>
      <th>${editable ? '<input type="checkbox" id="selectAllRows" aria-label="Chọn tất cả">' : ''}</th>
      ${app.columns.map((column) => `<th>${esc(column.name)} <small>${esc(column.type)}</small></th>`).join('')}
    </tr>
  `;
  const body = app.rows.map((row, index) => `
    <tr data-row="${index}">
      <td>${editable ? `<input class="rowcheck" type="checkbox" value="${index}" aria-label="Chọn bản ghi ${index + 1}">` : ''}</td>
      ${app.columns.map((column) => {
        const value = row[column.name];
        const text = value === null || value === undefined ? 'NULL' : String(value);
        const shown = text.length > 180 ? `${text.slice(0, 180)}…` : text;
        return `<td class="${value === null || value === undefined ? 'nullcell' : ''}" title="${esc(text.slice(0, 500))}">${esc(shown)}</td>`;
      }).join('')}
    </tr>
  `).join('') || `<tr><td colspan="${app.columns.length + 1}" class="empty">Không có dữ liệu phù hợp.</td></tr>`;
  return `<div class="tablebox"><table><thead>${header}</thead><tbody>${body}</tbody></table></div>
    <div class="pagination">
      <span>${app.total === null ? 'Không rõ tổng số' : `${app.total} bản ghi`} <span style="margin:0 10px">·</span> ${app.pageSize} dòng / trang</span>
      <div>
        <button id="prevPage" ${app.page <= 1 ? 'disabled' : ''}>‹</button>
        <span class="pageinfo">${app.page}${pageCountText()}</span>
        <button id="nextPage" ${pageCount !== null && app.page >= pageCount ? 'disabled' : ''}>›</button>
      </div>
    </div>`;
}

function pageCountText() {
  const count = app.total === null ? null : Math.max(1, Math.ceil(app.total / app.pageSize));
  return count === null ? '' : ` / ${count}`;
}

function positionPagination() {
  const selectAll = $('#selectAllRows');
  if (selectAll) {
    selectAll.addEventListener('change', () => {
      document.querySelectorAll('.rowcheck').forEach((checkbox) => { checkbox.checked = selectAll.checked; });
    });
  }
  const previous = $('#prevPage');
  const next = $('#nextPage');
  if (previous) previous.addEventListener('click', () => {
    if (app.page <= 1) return;
    app.page -= 1;
    loadData();
  });
  if (next) next.addEventListener('click', () => {
    const count = app.total === null ? null : Math.max(1, Math.ceil(app.total / app.pageSize));
    if (count !== null && app.page >= count) return;
    app.page += 1;
    loadData();
  });
}

function renderStructureView() {
  $('#workspace').innerHTML = `
    <div class="toolbar">
      <strong>${app.columns.length} cột</strong>
      <span class="spacer"></span>
      <button id="refreshStructure">↻ Làm mới</button>
      <button id="showDdl">⌑ Xem DDL</button>
      <button id="openInEditor">⌘ Mở SQL Editor</button>
    </div>
    <div class="tablebox"><table>
      <thead><tr><th></th><th>Tên cột</th><th>Kiểu dữ liệu</th><th>Null</th><th>Mặc định</th><th>Khóa</th><th>Extra</th></tr></thead>
      <tbody>
        ${app.columns.map((column) => `
          <tr>
            <td></td>
            <td class="mono">${esc(column.name)}</td>
            <td class="mono">${esc(column.type)}</td>
            <td>${column.nullable === 'YES' ? 'YES' : 'NO'}</td>
            <td class="muted">${column.defaultValue === null ? 'NULL' : esc(column.defaultValue)}</td>
            <td>${column.key === 'PRI' ? '🔑 PRIMARY' : column.key === 'UNI' ? 'UNIQUE' : column.key === 'MUL' ? 'INDEX' : '—'}</td>
            <td class="muted">${esc(column.extra || '')}</td>
          </tr>
        `).join('') || '<tr><td colspan="7" class="empty">Không có cột.</td></tr>'}
      </tbody>
    </table></div>
  `;
  $('#refreshStructure').addEventListener('click', () => view('structure'));
  $('#showDdl').addEventListener('click', showDdl);
  $('#openInEditor').addEventListener('click', openTableInEditor);
}

function showDdl() {
  const lines = app.columns.map((column) => {
    const parts = [`  ${quoteId(column.name)} ${column.type}`];
    if (column.nullable === 'NO') parts.push('NOT NULL');
    if (column.defaultValue !== null) parts.push(`DEFAULT ${column.defaultValue === 'CURRENT_TIMESTAMP' ? 'CURRENT_TIMESTAMP' : `'${String(column.defaultValue).replace(/'/g, "''")}'`}`);
    if (/auto_increment/i.test(column.extra)) parts.push('AUTO_INCREMENT');
    return parts.join(' ');
  });
  const primary = app.primaryKey.length ? `,\n  PRIMARY KEY (${app.primaryKey.map(quoteId).join(', ')})` : '';
  const ddl = `CREATE TABLE ${quoteId(table)} (\n${lines.join(',\n')}${primary}\n);`;
  modal(`<h2>DDL · ${esc(table)}</h2><p>SQL minh họa cấu trúc bảng.</p><pre class="mono ddl">${esc(ddl)}</pre><div class="actions"><button onclick="closeModal()">Đóng</button></div>`, true);
}

function openTableInEditor() {
  newQuery(defaultSql());
}

function renderIndexesView() {
  const indexes = app.indexes || [];
  $('#workspace').innerHTML = `
    <div class="toolbar">
      <strong>${indexes.length} index</strong>
      <span class="spacer"></span>
      <button id="refreshIndexes">↻ Làm mới</button>
    </div>
    <div class="tablebox"><table>
      <thead><tr><th></th><th>Tên index</th><th>Cột</th><th>Loại</th><th>Unique</th><th>Cardinality</th></tr></thead>
      <tbody>
        ${indexes.map((index) => `
          <tr>
            <td></td>
            <td class="mono">${esc(index.name)}</td>
            <td class="mono">${index.columns.map((column) => esc(column.name)).join(', ')}</td>
            <td>${esc(index.type)}</td>
            <td>${index.unique ? 'YES' : 'NO'}</td>
            <td class="muted">${index.cardinality === null ? 'NULL' : index.cardinality}</td>
          </tr>
        `).join('') || '<tr><td colspan="6" class="empty">Không có index.</td></tr>'}
      </tbody>
    </table></div>
  `;
  $('#refreshIndexes').addEventListener('click', () => view('indexes'));
}

function renderRelationsView() {
  const outbound = app.relations?.outbound || [];
  const inbound = app.relations?.inbound || [];
  const relationRow = (relation, direction) => `
    <tr>
      <td>${esc(direction)}</td>
      <td class="mono">${esc(relation.table)}.${esc(relation.column)}</td>
      <td>→</td>
      <td class="mono">${esc(relation.refDatabase)}.${esc(relation.refTable)}.${esc(relation.refColumn)}</td>
      <td class="muted">${esc(relation.name)}</td>
    </tr>
  `;
  const rows = [
    ...outbound.map((relation) => relationRow(relation, 'Đi')),
    ...inbound.map((relation) => relationRow(relation, 'Đến'))
  ].join('');
  $('#workspace').innerHTML = `
    <div class="toolbar">
      <strong>${outbound.length + inbound.length} quan hệ</strong>
      <span class="spacer"></span>
      <button id="refreshRelations">↻ Làm mới</button>
    </div>
    <div class="tablebox"><table>
      <thead><tr><th>Hướng</th><th>Bảng.cột</th><th></th><th>Tham chiếu</th><th>Constraint</th></tr></thead>
      <tbody>
        ${rows || '<tr><td colspan="5" class="empty">Không có khóa ngoại.</td></tr>'}
      </tbody>
    </table></div>
  `;
  $('#refreshRelations').addEventListener('click', () => view('relations'));
}

function renderQueryView() {
  sqlAutocomplete.requestId += 1;
  const value = app.query.sql === null || app.query.sql === undefined ? defaultSql() : app.query.sql;
  app.query.sql = value;
  sessionStorage.setItem('query', value);
  updateChrome();
  $('#workspace').innerHTML = `
    <div class="toolbar">
      <button class="primary" id="runQueryBtn">▷ Chạy truy vấn</button>
      <button id="saveQueryBtn">⌑ Lưu truy vấn</button>
      <button class="danger" id="cancelQueryBtn" style="display:${app.query.running ? 'inline-block' : 'none'}">■ Hủy</button>
      <span class="spacer"></span>
      <span class="subtle">${esc(app.database || 'chưa chọn database')}${table ? ` · ${esc(table)}` : ''} &nbsp; · &nbsp; Ctrl + Enter</span>
    </div>
    <div class="sql-editor-wrap">
      <textarea class="editor" id="sql" spellcheck="false" autocomplete="off" aria-label="SQL editor" aria-autocomplete="list" aria-controls="sqlSuggestions"></textarea>
      <div class="sql-suggestions hidden" id="sqlSuggestions" role="listbox" aria-label="Gợi ý SQL"></div>
    </div>
    <div id="queryResult">${queryResultHtml()}</div>
  `;
  const editor = $('#sql');
  editor.value = value;
  editor.addEventListener('input', () => {
    app.query.sql = editor.value;
    sessionStorage.setItem('query', editor.value);
    persistState();
    void refreshSqlSuggestions(editor);
  });
  editor.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      closeSqlSuggestions();
      runQuery();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.code === 'Space') {
      event.preventDefault();
      void refreshSqlSuggestions(editor, true);
      return;
    }
    const suggestionsOpen = !$('#sqlSuggestions').classList.contains('hidden');
    if (!suggestionsOpen) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSqlSuggestionSelection(sqlAutocomplete.selected + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSqlSuggestionSelection(sqlAutocomplete.selected - 1);
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      acceptSqlSuggestion(editor);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeSqlSuggestions();
    }
  });
  editor.addEventListener('keyup', (event) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
      void refreshSqlSuggestions(editor);
    }
  });
  editor.addEventListener('click', () => void refreshSqlSuggestions(editor));
  editor.addEventListener('scroll', closeSqlSuggestions);
  editor.addEventListener('compositionstart', () => {
    sqlAutocomplete.composing = true;
    closeSqlSuggestions();
  });
  editor.addEventListener('compositionend', () => {
    sqlAutocomplete.composing = false;
    void refreshSqlSuggestions(editor);
  });
  editor.addEventListener('blur', () => {
    clearTimeout(sqlAutocomplete.blurTimer);
    sqlAutocomplete.blurTimer = setTimeout(closeSqlSuggestions, 120);
  });
  const suggestions = $('#sqlSuggestions');
  suggestions.addEventListener('mousedown', (event) => {
    event.preventDefault();
    clearTimeout(sqlAutocomplete.blurTimer);
  });
  suggestions.addEventListener('mousemove', (event) => {
    const option = event.target.closest('[data-sql-suggestion]');
    if (option) setSqlSuggestionSelection(Number(option.dataset.sqlSuggestion));
  });
  suggestions.addEventListener('click', (event) => {
    const option = event.target.closest('[data-sql-suggestion]');
    if (option) acceptSqlSuggestion(editor, Number(option.dataset.sqlSuggestion));
  });
  $('#runQueryBtn').addEventListener('click', runQuery);
  $('#saveQueryBtn').addEventListener('click', saveQuery);
  $('#cancelQueryBtn').addEventListener('click', cancelQuery);
  $('#queryResult').addEventListener('click', (event) => {
    const resultTab = event.target.closest('[data-result-tab]');
    if (resultTab) {
      const result = app.query.result;
      const key = resultTab.dataset.resultTab;
      if (!result || result.kind !== 'batch' || !queryBatchTabs(result).some((item) => item.key === key)) return;
      app.query.resultTab = key;
      app.query.resultView = 'data';
      $('#queryResult').innerHTML = queryResultHtml();
      $('#queryResult [role="tab"][aria-selected="true"]')?.focus();
      return;
    }
    const detailTab = event.target.closest('[data-result-view]');
    if (!detailTab) return;
    const viewName = detailTab.dataset.resultView;
    if (viewName !== 'data' && viewName !== 'information') return;
    app.query.resultView = viewName;
    $('#queryResult').innerHTML = queryResultHtml();
    $(`#queryResult [data-result-view="${viewName}"]`)?.focus();
  });
  $('#queryResult').addEventListener('keydown', (event) => {
    const resultTab = event.target.closest('[data-result-tab]');
    if (!resultTab || !['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    const result = app.query.result;
    const tabs = result?.kind === 'batch' ? queryBatchTabs(result) : [];
    if (!tabs.length) return;
    event.preventDefault();
    const current = tabs.findIndex((item) => item.key === resultTab.dataset.resultTab);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? tabs.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    $(`#queryResult [data-result-tab="${tabs[next].key}"]`)?.click();
  });
  updateQueryButtons();
}

function singleQueryResultHtml(result, compact = false) {
  if (result.kind === 'ok') {
    return `<div class="resulttitle">✓ Thành công · ${result.affectedRows} dòng bị ảnh hưởng${result.insertId !== null ? ` · insert id ${esc(result.insertId)}` : ''} · ${result.durationMs} ms</div>`;
  }
  if (result.kind !== 'rows') {
    return '<div class="errorbox">Kết quả truy vấn không hợp lệ.</div>';
  }
  const header = `<tr><th></th>${result.columns.map((column) => `<th>${esc(column.name)} <small>${esc(column.type)}</small></th>`).join('')}</tr>`;
  const body = result.rows.map((row, index) => `
    <tr>
      <td class="muted">${index + 1}</td>
      ${row.map((value) => {
        const text = value === null || value === undefined ? 'NULL' : String(value);
        const shown = text.length > 180 ? `${text.slice(0, 180)}…` : text;
        return `<td class="${value === null || value === undefined ? 'nullcell' : ''}" title="${esc(text.slice(0, 500))}">${esc(shown)}</td>`;
      }).join('')}
    </tr>
  `).join('') || `<tr><td colspan="${result.columns.length + 1}" class="empty">Không có dòng nào.</td></tr>`;
  return `
    ${compact ? '' : `<div class="resulttitle">✓ ${result.rows.length} dòng · ${result.durationMs} ms${result.truncated ? ' · đã giới hạn 5000 dòng' : ''}</div>`}
    <div class="tablebox"><table><thead>${header}</thead><tbody>${body}</tbody></table></div>
    ${compact ? `<div class="query-grid-status">${result.rows.length} dòng · ${result.durationMs} ms${result.truncated ? ' · đã giới hạn dữ liệu hiển thị' : ''}</div>` : ''}
    ${!compact && result.truncated ? '<div class="hint">Kết quả hiển thị đã đạt giới hạn dòng. Truy vấn vẫn chạy hết và kết nối vẫn được giữ.</div>' : ''}
  `;
}

function queryBatchTabs(result) {
  const output = [
    { key: 'message', label: 'Message' },
    { key: 'summary', label: 'Summary' }
  ];
  let number = 0;
  for (const entry of result.results || []) {
    if (!entry.ok || entry.result?.kind !== 'rows') continue;
    number += 1;
    output.push({ key: `result-${entry.index}`, label: `Result ${number}`, entry });
  }
  return output;
}

function queryBatchMessageHtml(result) {
  const messages = result.results.map((entry) => {
    const detail = !entry.ok
      ? entry.error?.message || 'Không thể chạy câu lệnh.'
      : entry.result.kind === 'rows'
        ? `${entry.result.rows.length} dòng${entry.result.truncated ? ' (đã giới hạn hiển thị)' : ''}`
        : `${entry.result.affectedRows} dòng bị ảnh hưởng`;
    return `<div class="query-message-row ${entry.ok ? '' : 'failed'}">
      <span class="query-message-mark">${entry.ok ? '✓' : '✕'}</span>
      <span><strong>Câu lệnh #${entry.index}</strong> · ${esc(detail)}
        <small>${esc(entry.sql.slice(0, 240))}</small>
      </span>
      <span class="query-message-time">${entry.ok ? `${entry.result.durationMs} ms` : 'Lỗi'}</span>
    </div>`;
  }).join('');
  const remaining = result.statementCount - result.executedCount;
  return `<div class="query-message-overview ${result.failedCount ? 'failed' : ''}">
    ${result.failedCount ? 'Có lỗi' : 'Hoàn tất'} · ${result.succeededCount}/${result.statementCount} câu lệnh thành công · ${result.durationMs} ms
  </div>${messages}${remaining > 0 ? `<div class="query-message-remaining">${remaining} câu lệnh phía sau chưa được chạy.</div>` : ''}`;
}

function queryBatchSummaryHtml(result) {
  const rows = result.results.map((entry) => {
    const count = !entry.ok ? '—' : entry.result.kind === 'rows'
      ? `${entry.result.rows.length} dòng`
      : `${entry.result.affectedRows} dòng ảnh hưởng`;
    return `<tr>
      <td>${entry.index}</td>
      <td><span class="query-summary-status ${entry.ok ? '' : 'failed'}">${entry.ok ? 'Thành công' : 'Lỗi'}</span></td>
      <td>${esc(count)}</td>
      <td>${entry.ok ? `${entry.result.durationMs} ms` : '—'}</td>
      <td class="mono" title="${esc(entry.sql.slice(0, 500))}">${esc(entry.sql.replace(/\s+/g, ' ').slice(0, 180))}</td>
    </tr>`;
  }).join('');
  return `<div class="query-summary-line">${result.succeededCount}/${result.statementCount} câu lệnh thành công · ${result.durationMs} ms</div>
    <div class="tablebox"><table>
      <thead><tr><th>#</th><th>Trạng thái</th><th>Kết quả</th><th>Thời gian</th><th>SQL</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

function queryResultInformationHtml(entry) {
  const result = entry.result;
  return `<div class="query-result-information">
    <div class="query-summary-line">Câu lệnh #${entry.index} · ${result.rows.length} dòng · ${result.durationMs} ms</div>
    <div class="tablebox"><table>
      <thead><tr><th>#</th><th>Tên cột</th><th>Kiểu dữ liệu</th><th>Bảng</th></tr></thead>
      <tbody>${result.columns.map((column, index) => `<tr>
        <td>${index + 1}</td><td class="mono">${esc(column.name)}</td>
        <td>${esc(column.type)}</td><td>${esc(column.table || '—')}</td>
      </tr>`).join('')}</tbody>
    </table></div>
  </div>`;
}

function queryResultHtml() {
  if (app.query.error) {
    return `<div class="errorbox">${esc(app.query.error)}</div>`;
  }
  const result = app.query.result;
  if (!result) {
    return `<div class="empty">▷<br><br>Chạy truy vấn để xem kết quả.<br><br>Kết nối đang dùng: ${esc(app.connection?.name || '—')}</div>`;
  }
  if (result.kind !== 'batch') return singleQueryResultHtml(result);
  if (!Array.isArray(result.results) || !result.results.length) {
    return '<div class="errorbox">Không có kết quả câu lệnh để hiển thị.</div>';
  }

  const tabs = queryBatchTabs(result);
  const selected = tabs.find((item) => item.key === app.query.resultTab) || tabs.find((item) => item.entry) || tabs[0];
  const tabBar = tabs.map((item) => `<button type="button" role="tab" id="queryOutputTab-${item.key}"
    aria-controls="queryOutputPanel" aria-selected="${item.key === selected.key ? 'true' : 'false'}"
    tabindex="${item.key === selected.key ? '0' : '-1'}"
    class="query-output-tab ${item.key === selected.key ? 'selected' : ''}"
    data-result-tab="${item.key}">${item.label}</button>`).join('');
  let content;
  if (selected.key === 'message') content = queryBatchMessageHtml(result);
  else if (selected.key === 'summary') content = queryBatchSummaryHtml(result);
  else {
    const information = app.query.resultView === 'information';
    content = `<div class="query-result-view-tabs">
      <button type="button" class="${information ? '' : 'selected'}" data-result-view="data">Data</button>
      <button type="button" class="${information ? 'selected' : ''}" data-result-view="information">Information</button>
    </div>${information ? queryResultInformationHtml(selected.entry) : singleQueryResultHtml(selected.entry.result, true)}`;
  }
  return `
    <div class="query-output">
      <div class="query-output-tabs" role="tablist" aria-label="Kết quả truy vấn">${tabBar}</div>
      <div class="query-output-panel" id="queryOutputPanel" role="tabpanel" aria-labelledby="queryOutputTab-${selected.key}">${content}</div>
    </div>
  `;
}

async function refreshQueryMetadata(result) {
  const entries = result.kind === 'batch'
    ? result.results.filter((entry) => entry.ok).map((entry) => entry.result)
    : [result];
  const changedDatabase = typeof result.activeDatabase === 'string'
    && result.activeDatabase !== app.database;
  if (!changedDatabase && !entries.some((entry) => entry.kind === 'ok')) return;
  invalidateSqlAutocomplete();
  if (changedDatabase) {
    app.database = result.activeDatabase;
    table = null;
    app.columns = [];
    app.rows = [];
    app.total = null;
    updateChrome();
  }
  if (!app.connection || !app.database) return;
  try {
    app.tables = await call(desktop.db.tables(app.database));
    renderSidebar();
  } catch {
    // A successful query result must remain visible if metadata refresh fails.
  }
}

function updateQueryButtons() {
  const run = $('#runQueryBtn');
  const cancel = $('#cancelQueryBtn');
  const running = queryTabs.some((tab) => tab.running);
  if (run) run.disabled = running;
  if (cancel) cancel.style.display = running ? 'inline-block' : 'none';
}

function saveQuery() {
  const editor = $('#sql');
  if (editor) app.query.sql = editor.value;
  sessionStorage.setItem('query', app.query.sql);
  persistState();
  toast('Đã lưu truy vấn trên máy');
}

async function runQuery() {
  const tab = app.query;
  if (!tab || tab.running) return;
  if (queryTabs.some((item) => item.running)) {
    toast('Một truy vấn khác đang chạy. Hãy chờ hoặc hủy trước.', 'error');
    return;
  }
  const editor = $('#sql');
  const sql = (editor?.value || tab.sql || '').trim();
  if (!sql) {
    toast('Câu lệnh SQL đang trống.', 'error');
    return;
  }
  tab.sql = sql;
  tab.running = true;
  tab.error = null;
  updateQueryButtons();
  renderQueryTabs();
  if (app.query === tab) $('#queryResult').innerHTML = '<div class="empty">Đang chạy truy vấn…</div>';
  try {
    let result;
    try {
      result = await call(desktop.db.query({ sql, timeoutMs: 30000 }));
    } catch (error) {
      if (error.code !== 'CONFIRM_REQUIRED') throw error;
      const confirmed = await confirmAction(
        'Chạy lệnh có thể thay đổi dữ liệu?',
        `${error.message}\n\nSqlPro sẽ chạy tuần tự và dừng ngay tại câu lệnh đầu tiên bị lỗi.`,
        'Chạy'
      );
      if (!confirmed) {
        setStatus('Đã hủy chạy truy vấn');
        return;
      }
      result = await call(desktop.db.query({ sql, timeoutMs: 30000, confirmed: true }));
    }
    tab.result = result;
    tab.error = null;
    tab.resultTab = result.kind === 'batch'
      ? (result.failedCount ? 'message' : queryBatchTabs(result).find((item) => item.entry)?.key || 'message')
      : null;
    tab.resultView = 'data';
    await refreshQueryMetadata(result);
    const batchFailed = result.kind === 'batch' && result.failedCount > 0;
    const historyMessage = result.kind === 'batch'
      ? `${result.succeededCount}/${result.statementCount} câu lệnh`
      : (result.kind === 'ok' ? `${result.affectedRows} dòng` : `${result.rows.length} dòng`);
    historyRows.unshift({
      sql,
      ok: !batchFailed,
      at: new Date().toISOString(),
      durationMs: result.durationMs,
      message: historyMessage
    });
    historyRows = historyRows.slice(0, 100);
    if (batchFailed) {
      const failed = result.results.find((entry) => !entry.ok);
      setStatus(`Lỗi ở câu lệnh #${failed?.index || result.executedCount} • ${result.durationMs} ms`);
      toast(failed?.error?.message || 'Một câu lệnh SQL bị lỗi.', 'error');
    } else if (result.kind === 'batch') {
      setStatus(`${result.succeededCount} câu lệnh hoàn tất • ${result.durationMs} ms`);
    } else {
      setStatus(`Truy vấn hoàn tất • ${result.durationMs} ms`);
    }
  } catch (error) {
    tab.error = error.message;
    tab.result = null;
    historyRows.unshift({
      sql,
      ok: false,
      at: new Date().toISOString(),
      durationMs: null,
      message: error.message
    });
    historyRows = historyRows.slice(0, 100);
    setStatus(error.message);
    if (error.code === 'SESSION_CLOSED' || error.code === 'QUERY_TIMEOUT' || error.code === 'QUERY_CANCELED') {
      toast(`${error.message} Kết nối sẽ tự thiết lập lại ở lần chạy sau.`, 'error');
    } else {
      toast(error.message, 'error');
    }
  } finally {
    tab.running = false;
    updateQueryButtons();
    renderQueryTabs();
    if (app.query === tab) $('#queryResult').innerHTML = queryResultHtml();
    persistState();
  }
}

async function cancelQuery() {
  try {
    await desktop.db.cancelQuery();
    toast('Đã yêu cầu hủy truy vấn');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function renderHistoryView() {
  $('#workspace').innerHTML = `
    <div class="toolbar"><strong>${historyRows.length} truy vấn</strong><span class="spacer"></span><button id="clearHistory">⌫ Xóa lịch sử</button></div>
    ${historyRows.map((entry, index) => `
      <div class="historyrow" data-history="${index}">
        <span class="badge ${entry.ok ? '' : 'pending'}">${entry.ok ? 'OK' : 'Lỗi'}</span>
        <span class="mono history-sql">${esc(entry.sql.slice(0, 300))}</span>
        <span class="muted">${entry.durationMs === null ? '' : `${entry.durationMs} ms`} ${entry.at ? esc(new Date(entry.at).toLocaleString('vi-VN')) : ''}</span>
      </div>
    `).join('') || '<div class="empty">Chưa có truy vấn. Mở SQL Editor để bắt đầu.</div>'}
  `;
  $('#workspace').querySelectorAll('[data-history]').forEach((row) => {
    row.addEventListener('click', () => {
      const entry = historyRows[Number(row.dataset.history)];
      if (!entry) return;
      newQuery(entry.sql);
    });
  });
  $('#clearHistory').addEventListener('click', () => {
    historyRows = [];
    persistState();
    renderHistoryView();
  });
}

async function editRow(index) {
  if (!desktop || !app.database || !table) return;
  let columns = app.columns;
  if (!columns.length) {
    try {
      columns = await call(desktop.db.columns(app.database, table));
      app.columns = columns;
      app.primaryKey = columns.filter((column) => column.key === 'PRI').map((column) => column.name);
    } catch (error) {
      toast(error.message, 'error');
      return;
    }
  }
  const editing = Number.isInteger(index) && index >= 0 && index < app.rows.length;
  const row = editing ? app.rows[index] : null;
  if (editing && !app.primaryKey.length) {
    toast('Bảng không có khóa chính nên không thể sửa trực tiếp.', 'error');
    return;
  }
  const fields = columns.filter((column) => {
    if (/(virtual|stored) generated/i.test(column.extra)) return false;
    if (!editing && /auto_increment/i.test(column.extra)) return false;
    return true;
  });
  const fieldsHtml = fields.map((column) => {
    const isPrimary = column.key === 'PRI';
    const value = row && row[column.name] !== null && row[column.name] !== undefined ? String(row[column.name]) : '';
    const isNull = row ? row[column.name] === null || row[column.name] === undefined : false;
    return `
      <div class="field">
        <label>${esc(column.name)} <small class="mono">${esc(column.type)}</small></label>
        <div class="fieldinput">
          <input data-field="${esc(column.name)}" value="${esc(value)}" ${isPrimary ? 'disabled' : ''} ${isNull ? 'disabled' : ''}>
          ${column.nullable === 'YES' && !isPrimary ? `<label class="nulltoggle"><input type="checkbox" data-null="${esc(column.name)}" ${isNull ? 'checked' : ''}> NULL</label>` : ''}
        </div>
      </div>
    `;
  }).join('');
  modal(`
    <h2>${editing ? 'Sửa bản ghi' : 'Thêm bản ghi'}</h2>
    <p>${esc(app.database)}.${esc(table)} — thay đổi ghi trực tiếp vào database.</p>
    <form id="rowForm" class="fieldgrid">${fieldsHtml}</form>
    <div class="errorbox hidden" id="rowError"></div>
    <div class="actions">
      <button type="button" id="rowCancel">Hủy</button>
      <button type="button" class="primary" id="rowSave">${editing ? 'Lưu thay đổi' : 'Thêm bản ghi'}</button>
    </div>
  `, true);
  const form = $('#rowForm');
  form.querySelectorAll('[data-null]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const input = form.querySelector(`[data-field="${CSS.escape(checkbox.dataset.null)}"]`);
      if (input) input.disabled = checkbox.checked;
    });
  });
  $('#rowCancel').addEventListener('click', closeModal);
  $('#rowSave').addEventListener('click', async () => {
    const values = {};
    form.querySelectorAll('[data-field]').forEach((input) => {
      const name = input.dataset.field;
      const nullToggle = form.querySelector(`[data-null="${CSS.escape(name)}"]`);
      if (nullToggle && nullToggle.checked) {
        values[name] = null;
        return;
      }
      if (input.disabled && editing && app.primaryKey.includes(name)) return;
      if (!editing && input.value === '') return;
      values[name] = input.value;
    });
    try {
      if (editing) {
        const keys = Object.fromEntries(app.primaryKey.map((name) => [name, row[name]]));
        const changes = {};
        for (const [name, value] of Object.entries(values)) {
          if (app.primaryKey.includes(name)) continue;
          changes[name] = value;
        }
        await call(desktop.db.updateRow({ database: app.database, table, keys, values: changes }));
        toast('Đã cập nhật bản ghi');
      } else {
        await call(desktop.db.insertRow({ database: app.database, table, values }));
        toast('Đã thêm bản ghi');
      }
      closeModal();
      await loadData();
    } catch (error) {
      $('#rowError').textContent = error.message;
      $('#rowError').classList.remove('hidden');
    }
  });
}

async function deleteSelectedRows() {
  const indexes = [...document.querySelectorAll('.rowcheck:checked')].map((checkbox) => Number(checkbox.value));
  if (!indexes.length) {
    toast('Chọn bản ghi cần xóa trước.', 'error');
    return;
  }
  if (!app.primaryKey.length) {
    toast('Bảng không có khóa chính nên không thể xóa trực tiếp.', 'error');
    return;
  }
  const confirmed = await confirmAction(`Xóa ${indexes.length} bản ghi?`, 'Các bản ghi sẽ bị xóa vĩnh viễn khỏi database.', 'Xóa');
  if (!confirmed) return;
  const keysList = indexes.map((index) => {
    const row = app.rows[index];
    return Object.fromEntries(app.primaryKey.map((name) => [name, row[name]]));
  });
  try {
    const result = await call(desktop.db.deleteRows({ database: app.database, table, keysList }));
    toast(`Đã xóa ${result.affectedRows} bản ghi`);
    await loadData();
  } catch (error) {
    toast(error.message, 'error');
  }
}

function confirmAction(title, message, confirmLabel = 'Xác nhận') {
  return new Promise((resolve) => {
    modal(`
      <h2>${esc(title)}</h2>
      <p>${esc(message)}</p>
      <div class="actions">
        <button id="confirmCancel">Hủy</button>
        <button class="danger" id="confirmOk">${esc(confirmLabel)}</button>
      </div>
    `);
    const dialog = $('#modal');
    let settled = false;
    const onClose = () => {
      if (settled) return;
      settled = true;
      resolve(false);
    };
    dialog.addEventListener('close', onClose);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      dialog.removeEventListener('close', onClose);
      resolve(value);
      closeModal();
    };
    $('#confirmCancel').addEventListener('click', () => finish(false));
    $('#confirmOk').addEventListener('click', () => finish(true));
  });
}

function workspaceForm(existing) {
  if (!desktop?.workspaces) {
    toast('Workspace chỉ khả dụng trong bản desktop.', 'error');
    return;
  }
  const workspace = existing || null;
  modal(`
    <h2>${workspace ? 'Sửa workspace' : 'Workspace mới'}</h2>
    <p>Workspace giúp nhóm các kết nối theo dự án và được đồng bộ cùng tài khoản.</p>
    <form id="workspaceForm">
      <label>Tên workspace</label>
      <input id="wsName" required maxlength="80" value="${esc(workspace?.name || '')}" placeholder="Ví dụ: Dự án website">
      <label>Mô tả (tùy chọn)</label>
      <input id="wsDescription" maxlength="500" value="${esc(workspace?.description || '')}" placeholder="Ghi chú ngắn về workspace">
      <div class="errorbox hidden" id="wsError"></div>
      <div class="actions">
        <button type="button" id="wsCancel">Hủy</button>
        <button type="submit" class="primary">${workspace ? 'Lưu' : 'Tạo workspace'}</button>
      </div>
    </form>
  `);
  const form = $('#workspaceForm');
  const errorBox = $('#wsError');
  $('#wsCancel').addEventListener('click', closeModal);
  $('#wsName').focus();
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.classList.add('hidden');
    try {
      const saved = await call(desktop.workspaces.save({
        id: workspace ? workspace.id : undefined,
        name: $('#wsName').value,
        description: $('#wsDescription').value
      }));
      closeModal();
      await refreshWorkspaces();
      renderSidebar();
      if (!workspace && !app.connection) {
        await switchWorkspace(saved.id);
      }
      toast(workspace ? 'Đã cập nhật workspace' : `Đã tạo workspace "${saved.name}"`);
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.classList.remove('hidden');
    }
  });
}

function workspaceManager() {
  if (!desktop?.workspaces) {
    toast('Workspace chỉ khả dụng trong bản desktop.', 'error');
    return;
  }
  ensureDefaultWorkspace();
  const rows = app.workspaces.map((workspace) => {
    const isDefault = workspace.isDefault || workspace.id === DEFAULT_WORKSPACE_ID;
    const active = workspace.id === app.activeWorkspaceId;
    return `
      <div class="workspacerow ${active ? 'active' : ''}">
        <div class="workspaceinfo">
          <strong>${esc(workspace.name)}${isDefault ? '<span class="badge">Mặc định</span>' : ''}</strong>
          <div class="muted">${esc(workspace.description || 'Không có mô tả')}</div>
        </div>
        <span class="workspacecount">${workspaceConnectionCount(workspace.id)} kết nối</span>
        <div class="workspaceactions">
          <button type="button" data-ws-open="${esc(workspace.id)}" ${active ? 'disabled' : ''}>Mở</button>
          ${isDefault ? '' : `
            <button type="button" data-ws-edit="${esc(workspace.id)}">Sửa</button>
            <button type="button" class="danger" data-ws-delete="${esc(workspace.id)}">Xóa</button>
          `}
        </div>
      </div>
    `;
  }).join('');
  modal(`
    <h2>Workspace</h2>
    <p>Chọn workspace đang làm việc. Xóa workspace sẽ chuyển các kết nối về workspace mặc định.</p>
    <div class="workspacelist">${rows}</div>
    <div class="actions">
      <button type="button" id="wsNew">＋ Workspace mới</button>
      <span class="spacer"></span>
      <button type="button" id="wsClose">Đóng</button>
    </div>
  `);
  $('#wsClose').addEventListener('click', closeModal);
  $('#wsNew').addEventListener('click', () => workspaceForm());
  document.querySelectorAll('[data-ws-open]').forEach((button) => {
    button.addEventListener('click', async () => {
      const workspaceId = button.dataset.wsOpen;
      closeModal();
      await switchWorkspace(workspaceId);
    });
  });
  document.querySelectorAll('[data-ws-edit]').forEach((button) => {
    button.addEventListener('click', () => {
      const workspace = app.workspaces.find((entry) => entry.id === button.dataset.wsEdit);
      if (workspace) workspaceForm(workspace);
    });
  });
  document.querySelectorAll('[data-ws-delete]').forEach((button) => {
    button.addEventListener('click', () => {
      const workspace = app.workspaces.find((entry) => entry.id === button.dataset.wsDelete);
      if (workspace) removeWorkspace(workspace);
    });
  });
}

async function removeWorkspace(workspace) {
  const count = workspaceConnectionCount(workspace.id);
  const confirmed = await confirmAction(
    'Xóa workspace?',
    `Workspace "${workspace.name}" sẽ bị xóa.${count ? ` ${count} kết nối sẽ được chuyển về workspace "Cá nhân".` : ''}`,
    'Xóa workspace'
  );
  if (!confirmed) return;
  try {
    const result = await call(desktop.workspaces.remove(workspace.id));
    await refreshWorkspaces();
    await refreshConnections();
    if (!app.connection) view('data');
    toast(`Đã xóa workspace "${result.name}"${result.moved ? `, chuyển ${result.moved} kết nối về Cá nhân` : ''}.`);
    workspaceManager();
  } catch (error) {
    toast(error.message, 'error');
  }
}

function readSyncServerUrl() {
  try {
    return localStorage.getItem('sqlpro.syncServerUrl') || '';
  } catch {
    return '';
  }
}

function saveSyncServerUrl(value) {
  try {
    if (value) localStorage.setItem('sqlpro.syncServerUrl', value);
  } catch {
    // localStorage can be unavailable; the URL is only a convenience
  }
}

function isInsecureHttpServer(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'http:') return false;
    return !['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

function accountInitials(email) {
  const value = String(email || '').trim();
  return value ? value.slice(0, 2).toUpperCase() : 'SP';
}

function accountStateLabel(status) {
  if (!status || !status.loggedIn) return 'Chưa đăng nhập';
  const labels = {
    idle: 'Sẵn sàng',
    pending: 'Chờ đồng bộ',
    syncing: 'Đang đồng bộ…',
    synced: 'Đã đồng bộ',
    offline: 'Ngoại tuyến',
    error: 'Lỗi đồng bộ',
    'reauth-required': 'Cần đăng nhập lại'
  };
  return labels[status.state] || 'Sẵn sàng';
}

function accountStateClass(status) {
  if (!status || !status.loggedIn) return 'signed-out';
  if (status.state === 'reauth-required') return 'reauth';
  if (['pending', 'syncing', 'synced', 'offline', 'error'].includes(status.state)) return status.state;
  return 'idle';
}

function formatSyncTime(value) {
  if (!value) return 'Chưa đồng bộ';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Chưa đồng bộ';
  return date.toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
}

function renderAccountChrome() {
  const loggedIn = Boolean(app.account && app.account.loggedIn);
  const email = loggedIn ? app.account.email : '';
  const initials = accountInitials(email);
  const label = accountStateLabel(app.account);
  const initialsElement = $('#accountInitials');
  const avatarElement = $('#accountAvatar');
  if (initialsElement) initialsElement.textContent = initials;
  if (avatarElement) avatarElement.textContent = initials;
  const dot = $('#syncDot');
  if (dot) {
    dot.className = `syncdot ${accountStateClass(app.account)}`;
    dot.title = label;
  }
  const accountButton = $('#accountButton');
  if (accountButton) accountButton.title = loggedIn ? `${email} · ${label}` : 'Tài khoản và đồng bộ';
  if (avatarElement) avatarElement.title = loggedIn ? `${email} · ${label}` : 'Tài khoản và đồng bộ';
}

async function refreshAccountStatus() {
  if (!desktop?.account) {
    renderAccountChrome();
    return;
  }
  try {
    app.account = await call(desktop.account.status());
  } catch {
    // keep the last known status when the main process is unavailable
  }
  renderAccountChrome();
}

let syncRefreshTimer;
function onSyncApplied() {
  clearTimeout(syncRefreshTimer);
  syncRefreshTimer = setTimeout(async () => {
    const openConnectionId = app.connection ? app.connection.id : null;
    try {
      await refreshWorkspaces();
      await refreshConnections();
    } catch (error) {
      toast(error.message, 'error');
    }
    if (openConnectionId && !app.connections.some((connection) => connection.id === openConnectionId)) {
      toast('Kết nối đang mở đã bị xóa từ thiết bị khác.');
      await disconnect();
    } else {
      renderWorkspaceSwitcher();
      renderSidebar();
    }
    await refreshAccountStatus();
  }, 250);
}

async function accountModal() {
  if (!desktop?.account) {
    modal(`
      <h2>Tài khoản &amp; đồng bộ</h2>
      <p>Tính năng đồng bộ chỉ khả dụng trong bản desktop của SqlPro.</p>
      <div class="actions"><button type="button" onclick="closeModal()">Đóng</button></div>
    `);
    return;
  }
  try {
    app.account = await call(desktop.account.status());
  } catch (error) {
    toast(error.message, 'error');
  }
  renderAccountChrome();
  if (app.account && app.account.loggedIn) renderAccountPanel(app.account);
  else accountAuthModal(false);
}

function accountAuthModal(registerMode, prefill = {}) {
  if (!desktop?.account) return;
  const serverUrl = prefill.serverUrl || readSyncServerUrl() || app.account?.defaultServerUrl || 'http://localhost:8080';
  const email = prefill.email || '';
  modal(`
    <h2>${registerMode ? 'Tạo tài khoản đồng bộ' : 'Đăng nhập đồng bộ'}</h2>
    <p>Đồng bộ connection và workspace giữa các máy. Dữ liệu được mã hóa ngay trên máy trước khi gửi lên server.</p>
    <div class="accounttabs">
      <button type="button" id="accountTabLogin" class="${registerMode ? '' : 'selected'}">Đăng nhập</button>
      <button type="button" id="accountTabRegister" class="${registerMode ? 'selected' : ''}">Tạo tài khoản</button>
    </div>
    <form id="accountForm">
      <label>Server đồng bộ</label>
      <input id="accountServer" type="url" required autocomplete="url" value="${esc(serverUrl)}" placeholder="https://sync.example.com">
      <div class="accounthint">Tự host bằng Docker: <span class="mono">docker compose up -d</span> · mặc định <span class="mono">http://localhost:8080</span></div>
      <div class="accountwarn hidden" id="insecureWarning">Server dùng HTTP không mã hóa. Chỉ dùng trong mạng tin cậy hoặc khi đang thử nghiệm.</div>
      <label class="checkline hidden" id="allowInsecureRow"><input type="checkbox" id="allowInsecure"> Tôi hiểu rủi ro khi dùng HTTP không an toàn</label>
      <label>Email</label>
      <input id="accountEmail" type="email" required autocomplete="username" value="${esc(email)}" placeholder="ban@example.com">
      <label>${registerMode ? 'Mật khẩu đồng bộ' : 'Mật khẩu'}</label>
      <input id="accountPassword" type="password" required ${registerMode ? 'minlength="10"' : ''} autocomplete="${registerMode ? 'new-password' : 'current-password'}" placeholder="${registerMode ? 'Ít nhất 10 ký tự' : 'Mật khẩu của bạn'}">
      ${registerMode ? `
        <label>Nhập lại mật khẩu</label>
        <input id="accountPasswordConfirm" type="password" required minlength="10" autocomplete="new-password" placeholder="Nhập lại mật khẩu">
        <div class="accountwarn">Mật khẩu này tạo khóa mã hóa dữ liệu đồng bộ và <strong>không thể khôi phục</strong>. Nếu quên mật khẩu, dữ liệu trên server sẽ không thể giải mã.</div>
      ` : `
        <label class="checkline"><input type="checkbox" id="accountRemember" checked> Ghi nhớ đăng nhập trên máy này</label>
      `}
      <div class="errorbox hidden" id="accountError"></div>
      <div class="actions">
        <button type="button" id="accountOffline">Dùng offline</button>
        <span class="spacer"></span>
        <button type="submit" class="primary" id="accountSubmit">${registerMode ? 'Tạo tài khoản' : 'Đăng nhập'}</button>
      </div>
    </form>
  `);
  const form = $('#accountForm');
  const errorBox = $('#accountError');
  const serverInput = $('#accountServer');
  const updateInsecure = () => {
    const insecure = isInsecureHttpServer(serverInput.value);
    $('#allowInsecureRow').classList.toggle('hidden', !insecure);
    $('#insecureWarning').classList.toggle('hidden', !insecure);
    if (!insecure) $('#allowInsecure').checked = false;
  };
  serverInput.addEventListener('input', updateInsecure);
  updateInsecure();
  $('#accountTabLogin').addEventListener('click', () => {
    accountAuthModal(false, { serverUrl: serverInput.value, email: $('#accountEmail').value });
  });
  $('#accountTabRegister').addEventListener('click', () => {
    accountAuthModal(true, { serverUrl: serverInput.value, email: $('#accountEmail').value });
  });
  $('#accountOffline').addEventListener('click', closeModal);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.classList.add('hidden');
    const password = $('#accountPassword').value;
    if (registerMode && password !== $('#accountPasswordConfirm').value) {
      errorBox.textContent = 'Mật khẩu nhập lại không khớp.';
      errorBox.classList.remove('hidden');
      return;
    }
    const submit = $('#accountSubmit');
    submit.disabled = true;
    submit.textContent = 'Đang kết nối…';
    try {
      saveSyncServerUrl(serverInput.value.trim());
      const payload = {
        email: $('#accountEmail').value.trim(),
        password,
        serverUrl: serverInput.value.trim(),
        allowInsecure: $('#allowInsecure').checked
      };
      if (registerMode) await call(desktop.account.register(payload));
      else await call(desktop.account.login({ ...payload, remember: $('#accountRemember').checked }));
      closeModal();
      toast(registerMode ? 'Đã tạo tài khoản. Đang đồng bộ dữ liệu…' : 'Đã đăng nhập. Đang đồng bộ dữ liệu…');
      await refreshAccountStatus();
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.classList.remove('hidden');
      if (error.code === 'SYNC_ACCOUNT_MISMATCH') {
        const reset = document.createElement('button');
        reset.type = 'button';
        reset.className = 'danger';
        reset.id = 'accountResetLocal';
        reset.textContent = 'Sao lưu & xóa dữ liệu local…';
        errorBox.appendChild(document.createElement('br'));
        errorBox.appendChild(reset);
        reset.addEventListener('click', () => resetLocalAccountData({
          registerMode,
          serverUrl: serverInput.value,
          email: $('#accountEmail').value
        }));
      }
      submit.disabled = false;
      submit.textContent = registerMode ? 'Tạo tài khoản' : 'Đăng nhập';
    }
  });
  $('#accountEmail').focus();
}

async function resetLocalAccountData(prefill) {
  const confirmed = await confirmAction(
    'Đổi tài khoản đồng bộ?',
    'Dữ liệu local sẽ được sao lưu tự động rồi xóa khỏi SqlPro, sau đó bạn có thể đăng nhập tài khoản khác. Các thay đổi chưa đồng bộ chỉ còn trong tệp sao lưu.',
    'Sao lưu & xóa'
  );
  if (!confirmed) {
    accountAuthModal(prefill.registerMode, prefill);
    return;
  }
  try {
    await disconnect();
    const result = await call(desktop.account.resetLocal());
    app.activeWorkspaceId = DEFAULT_WORKSPACE_ID;
    closeModal();
    await refreshWorkspaces();
    await refreshConnections();
    renderWorkspaceSwitcher();
    renderSidebar();
    view('data');
    persistState();
    await refreshAccountStatus();
    toast(result.backupName
      ? `Đã sao lưu dữ liệu cũ vào ${result.backupName} và xóa dữ liệu local.`
      : 'Đã xóa dữ liệu local.');
    accountAuthModal(prefill.registerMode, prefill);
  } catch (error) {
    toast(error.message, 'error');
  }
}

function renderAccountPanel(status) {
  const email = status.email || '';
  const label = accountStateLabel(status);
  const errorHtml = status.error?.message
    ? `<div class="errorbox">${esc(status.error.message)}</div>`
    : '';
  const reauth = status.state === 'reauth-required';
  modal(`
    <h2>Tài khoản &amp; đồng bộ</h2>
    <div class="accountidentity">
      <div class="accountbigavatar">${esc(accountInitials(email))}</div>
      <div>
        <strong>${esc(email)}</strong>
        <div class="muted">${esc(status.serverUrl || '')}</div>
      </div>
      <span class="syncpill ${accountStateClass(status)}">${esc(label)}</span>
    </div>
    <div class="accountgrid">
      <div><span>Lần đồng bộ cuối</span><strong>${esc(formatSyncTime(status.lastSyncAt))}</strong></div>
      <div><span>Revision</span><strong>${esc(status.revision ?? 0)}</strong></div>
      <div><span>Ghi nhớ đăng nhập</span><strong>${status.remember ? 'Có' : 'Không'}</strong></div>
      <div><span>Mã hóa</span><strong>Đầu cuối</strong></div>
    </div>
    ${errorHtml}
    <div class="accountnote">Connection và workspace được mã hóa trên máy trước khi gửi lên server. Server không đọc được host, user hay mật khẩu. Mật khẩu không thể khôi phục.</div>
    <div class="actions">
      <button type="button" id="accountLogout">Đăng xuất</button>
      <span class="spacer"></span>
      <button type="button" id="accountClose">Đóng</button>
      <button type="button" class="primary" id="accountSync" ${status.state === 'syncing' ? 'disabled' : ''}>${reauth ? 'Đăng nhập lại' : 'Đồng bộ ngay'}</button>
    </div>
  `);
  $('#accountClose').addEventListener('click', closeModal);
  $('#accountSync').addEventListener('click', async () => {
    if (reauth) {
      closeModal();
      accountAuthModal(false, { serverUrl: status.serverUrl, email });
      return;
    }
    const button = $('#accountSync');
    button.disabled = true;
    button.textContent = 'Đang đồng bộ…';
    try {
      await call(desktop.account.syncNow());
      await refreshAccountStatus();
      if (app.account?.loggedIn) renderAccountPanel(app.account);
      else closeModal();
      toast('Đã đồng bộ dữ liệu');
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Đồng bộ ngay';
      await refreshAccountStatus();
      toast(error.message, 'error');
    }
  });
  $('#accountLogout').addEventListener('click', async () => {
    try {
      await call(desktop.account.logout());
      closeModal();
      await refreshAccountStatus();
      toast('Đã đăng xuất. Dữ liệu local vẫn được giữ.');
    } catch (error) {
      toast(error.message, 'error');
    }
  });
}

function connection(profile) {
  const existing = profile || null;
  const p = existing || {};
  const savedPassword = existing ? existing.hasPassword : false;
  const savedSslPassphrase = existing ? existing.hasSslPassphrase : false;
  const savedSshPassword = existing ? existing.hasSshPassword : false;
  const savedPassphrase = existing ? existing.hasSshPassphrase : false;
  modal(`
    <h2>${existing ? 'Sửa kết nối' : 'Kết nối mới'}</h2>
    <p>MySQL/MariaDB · thông số tương thích Navicat, hỗ trợ SSL và SSH tunnel.</p>
    <form id="connectionForm">
      <div class="formrow">
        <div><label>Tên kết nối</label><input id="connName" value="${esc(p.name || '')}" placeholder="Local development"></div>
        <div><label>Loại database</label><select id="connType">
          <option value="mysql" ${p.type !== 'mariadb' ? 'selected' : ''}>MySQL</option>
          <option value="mariadb" ${p.type === 'mariadb' ? 'selected' : ''}>MariaDB</option>
        </select></div>
      </div>
      <div class="formrow">
        <div><label>Host</label><input id="connHost" value="${esc(p.host || 'localhost')}" required></div>
        <div><label>Port</label><input id="connPort" type="number" min="1" max="65535" value="${p.port || 3306}" required></div>
      </div>
      <div class="formrow">
        <div><label>Username</label><input id="connUser" value="${esc(p.user || 'root')}"></div>
        <div><label>Password</label><input id="connPassword" type="password" placeholder="${savedPassword ? 'Để trống = giữ mật khẩu đã lưu' : 'Nhập mật khẩu'}"></div>
      </div>
      <div class="formrow">
        <div><label>Workspace</label><select id="connWorkspace">
          ${app.workspaces.map((workspace) => `
            <option value="${esc(workspace.id)}" ${(p.workspaceId || app.activeWorkspaceId) === workspace.id ? 'selected' : ''}>${esc(workspace.name)}</option>
          `).join('')}
        </select></div>
        <div><label>Database mặc định (tùy chọn)</label><input id="connDatabase" value="${esc(p.database || '')}" placeholder="Bỏ trống để chọn sau"></div>
      </div>
      <label class="checkline"><input type="checkbox" id="connSsl" ${p.ssl?.enabled ? 'checked' : ''}> Dùng SSL/TLS</label>
      <div id="sslFields" class="optionbox ${p.ssl?.enabled ? '' : 'hidden'}">
        <label class="checkline"><input type="checkbox" id="connSslVerify" ${p.ssl?.verify ? 'checked' : ''}> Xác thực chứng chỉ (mặc định chấp nhận cert tự ký như Navicat)</label>
        <label>CA cert (đường dẫn)</label><input id="connSslCa" value="${esc(p.ssl?.ca || '')}">
        <div class="formrow">
          <div><label>Client cert (đường dẫn)</label><input id="connSslCert" value="${esc(p.ssl?.cert || '')}"></div>
          <div><label>Client key (đường dẫn)</label><input id="connSslKey" value="${esc(p.ssl?.key || '')}"></div>
        </div>
        <label>Client key passphrase</label>
        <input id="connSslPassphrase" type="password" placeholder="${savedSslPassphrase ? 'Để trống = giữ passphrase đã lưu' : 'Passphrase (nếu có)'}">
      </div>
      <label class="checkline"><input type="checkbox" id="connSsh" ${p.ssh?.enabled ? 'checked' : ''}> Kết nối qua SSH tunnel</label>
      <div id="sshFields" class="optionbox ${p.ssh?.enabled ? '' : 'hidden'}">
        <div class="formrow">
          <div><label>SSH host</label><input id="sshHost" value="${esc(p.ssh?.host || '')}"></div>
          <div><label>SSH port</label><input id="sshPort" type="number" min="1" max="65535" value="${p.ssh?.port || 22}"></div>
        </div>
        <div class="formrow">
          <div><label>SSH username</label><input id="sshUser" value="${esc(p.ssh?.user || '')}"></div>
          <div><label>Xác thực</label><select id="sshAuthMethod">
            <option value="password" ${p.ssh?.authMethod !== 'key' ? 'selected' : ''}>Mật khẩu</option>
            <option value="key" ${p.ssh?.authMethod === 'key' ? 'selected' : ''}>Private key</option>
          </select></div>
        </div>
        <div id="sshPasswordRow">
          <label>SSH password</label><input id="sshPassword" type="password" placeholder="${savedSshPassword ? 'Để trống = giữ mật khẩu đã lưu' : 'Nhập mật khẩu SSH'}">
        </div>
        <div id="sshKeyRows" class="${p.ssh?.authMethod === 'key' ? '' : 'hidden'}">
          <label>Private key (đường dẫn)</label><input id="sshKeyPath" value="${esc(p.ssh?.privateKeyPath || '')}" placeholder="/home/user/.ssh/id_rsa">
          <label>Passphrase</label><input id="sshPassphrase" type="password" placeholder="${savedPassphrase ? 'Để trống = giữ passphrase đã lưu' : 'Passphrase (nếu có)'}">
        </div>
      </div>
      <div class="errorbox hidden" id="connError"></div>
      <div class="actions">
        ${existing ? '<button type="button" class="danger" id="connDelete">Xóa kết nối</button><span class="spacer"></span>' : '<span class="spacer"></span>'}
        <button type="button" id="connCancel">Hủy</button>
        <button type="button" id="connTest">Kiểm tra</button>
        <button type="submit" class="primary">${existing ? 'Lưu &amp; kết nối' : 'Lưu &amp; kết nối'}</button>
      </div>
    </form>
  `, true);

  const form = $('#connectionForm');
  const errorBox = $('#connError');
  const showError = (message) => {
    errorBox.textContent = message;
    errorBox.classList.remove('hidden');
  };
  const toggleOptions = () => {
    $('#sslFields').classList.toggle('hidden', !$('#connSsl').checked);
    $('#sshFields').classList.toggle('hidden', !$('#connSsh').checked);
    const useKey = $('#sshAuthMethod').value === 'key';
    $('#sshPasswordRow').classList.toggle('hidden', useKey);
    $('#sshKeyRows').classList.toggle('hidden', !useKey);
  };
  $('#connSsl').addEventListener('change', toggleOptions);
  $('#connSsh').addEventListener('change', toggleOptions);
  $('#sshAuthMethod').addEventListener('change', toggleOptions);

  const readForm = () => {
    const payload = {
      id: existing ? existing.id : undefined,
      workspaceId: $('#connWorkspace').value,
      name: $('#connName').value,
      type: $('#connType').value,
      host: $('#connHost').value,
      port: Number($('#connPort').value),
      user: $('#connUser').value,
      database: $('#connDatabase').value,
      ssl: {
        enabled: $('#connSsl').checked,
        verify: $('#connSslVerify').checked,
        ca: $('#connSslCa').value,
        cert: $('#connSslCert').value,
        key: $('#connSslKey').value,
        passphrase: $('#connSslPassphrase').value || undefined
      },
      ssh: {
        enabled: $('#connSsh').checked,
        host: $('#sshHost').value,
        port: Number($('#sshPort').value),
        user: $('#sshUser').value,
        authMethod: $('#sshAuthMethod').value,
        privateKeyPath: $('#sshKeyPath').value
      }
    };
    const password = $('#connPassword').value;
    const sshPassword = $('#sshPassword').value;
    const passphrase = $('#sshPassphrase').value;
    if (password) payload.password = password;
    else if (!existing) payload.password = '';
    if (sshPassword) payload.sshPassword = sshPassword;
    else if (!existing) payload.sshPassword = '';
    if (passphrase) payload.sshPassphrase = passphrase;
    else if (!existing) payload.sshPassphrase = '';
    return payload;
  };

  $('#connCancel').addEventListener('click', closeModal);
  $('#connTest').addEventListener('click', async () => {
    errorBox.classList.add('hidden');
    $('#connTest').disabled = true;
    $('#connTest').textContent = 'Đang kiểm tra…';
    try {
      const result = await call(desktop.connections.test(readForm()));
      toast(`Kết nối thành công · MySQL ${result.version}`);
    } catch (error) {
      showError(error.message);
    } finally {
      $('#connTest').disabled = false;
      $('#connTest').textContent = 'Kiểm tra';
    }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.classList.add('hidden');
    try {
      const saved = await call(desktop.connections.save(readForm()));
      closeModal();
      if (saved.workspaceId) app.activeWorkspaceId = saved.workspaceId;
      await refreshConnections();
      await connectTo(saved.id);
    } catch (error) {
      showError(error.message);
    }
  });
  const deleteButton = $('#connDelete');
  if (deleteButton) {
    deleteButton.addEventListener('click', async () => {
      const confirmed = await confirmAction('Xóa kết nối?', `Kết nối "${existing.name}" sẽ bị xóa khỏi SqlPro.`, 'Xóa');
      if (!confirmed) return;
      try {
        await call(desktop.connections.remove(existing.id));
        if (app.connection && app.connection.id === existing.id) {
          app.connection = null;
          app.database = null;
          table = null;
          app.databases = [];
          app.tables = [];
          setConnectionState('idle');
        }
        closeModal();
        await refreshConnections();
        renderSidebar();
        view('data');
        toast('Đã xóa kết nối');
      } catch (error) {
        showError(error.message);
      }
    });
  }
}

function connectionMenu(id) {
  const profile = app.connections.find((connection) => connection.id === id);
  if (!profile) return;
  modal(`
    <h2>${esc(profile.name)}</h2>
    <p>${esc(profile.user || 'root')}@${esc(profile.host)}:${profile.port} · ${profile.type === 'mariadb' ? 'MariaDB' : 'MySQL'}${profile.ssh.enabled ? ' · SSH tunnel' : ''}</p>
    <div class="hint">${profile.hasPassword ? 'Mật khẩu đã lưu an toàn bằng OS keychain.' : 'Chưa lưu mật khẩu.'}</div>
    <div class="actions">
      <button class="danger" id="menuDelete">Xóa</button>
      <span class="spacer"></span>
      <button id="menuEdit">Chỉnh sửa</button>
      <button class="primary" id="menuConnect">Kết nối</button>
    </div>
  `);
  $('#menuEdit').addEventListener('click', () => connection(profile));
  $('#menuConnect').addEventListener('click', () => { closeModal(); connectTo(profile.id); });
  $('#menuDelete').addEventListener('click', async () => {
    const confirmed = await confirmAction('Xóa kết nối?', `Kết nối "${profile.name}" sẽ bị xóa khỏi SqlPro.`, 'Xóa');
    if (!confirmed) return;
    try {
      await call(desktop.connections.remove(profile.id));
      if (app.connection && app.connection.id === profile.id) {
        app.connection = null;
        app.database = null;
        table = null;
        app.databases = [];
        app.tables = [];
        setConnectionState('idle');
      }
      closeModal();
      await refreshConnections();
      renderSidebar();
      view('data');
      toast('Đã xóa kết nối');
    } catch (error) {
      toast(error.message, 'error');
    }
  });
}

async function importNavicat() {
  if (!desktop) return;
  try {
    const result = await call(desktop.connections.importNavicat(app.activeWorkspaceId));
    if (result.canceled) return;
    await refreshWorkspaces();
    await refreshConnections();
    renderSidebar();
    const parts = [];
    if (result.added) parts.push(`${result.added} mới`);
    if (result.updated) parts.push(`${result.updated} cập nhật`);
    if (result.skipped) parts.push(`${result.skipped} bỏ qua`);
    toast(`Đã nhập kết nối Navicat: ${parts.join(', ') || 'không có thay đổi'}`);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function disconnect() {
  if (!desktop) return;
  invalidateSqlAutocomplete();
  try {
    await call(desktop.db.disconnect());
  } catch {
    // ignore
  }
  app.connection = null;
  app.database = null;
  app.databases = [];
  app.tables = [];
  app.columns = [];
  app.rows = [];
  table = null;
  setConnectionState('idle');
  renderSidebar();
  view('data');
  persistState();
}

function backupDatabase() {
  if (!desktop) return;
  if (!app.connection || !app.database) {
    toast('Chọn một database trước khi sao lưu.', 'error');
    return;
  }
  const objects = app.tables;
  if (!objects.length) {
    toast('Database không có bảng hoặc view nào để sao lưu.', 'error');
    return;
  }
  modal(`
    <h2>Sao lưu database</h2>
    <p><strong>${esc(app.database)}</strong> · ${objects.length} đối tượng</p>
    <label class="checkline"><input type="checkbox" id="backupStructure" checked> Cấu trúc bảng và view (CREATE)</label>
    <label class="checkline"><input type="checkbox" id="backupData" checked> Dữ liệu (INSERT)</label>
    <label class="checkline"><input type="checkbox" id="backupDrop"> Thêm DROP TABLE/VIEW/TRIGGER IF EXISTS</label>
    <label>Đối tượng cần sao lưu</label>
    <div class="optionbox">
      <label class="checkline"><input type="checkbox" id="backupAll" checked> Chọn tất cả</label>
      <div class="backup-tables">
        ${objects.map((entry) => `
          <label class="checkline">
            <input type="checkbox" class="backup-table" value="${esc(entry.name)}" checked>
            <span>${entry.type === 'view' ? '◫' : '▦'} ${esc(entry.name)}</span>
          </label>
        `).join('')}
      </div>
    </div>
    <div class="hint">Tệp .sql có thể phục hồi bằng SqlPro, mysql client hoặc Navicat. Giới hạn 1 GB mỗi lần.</div>
    <div class="actions">
      <button onclick="closeModal()">Hủy</button>
      <button class="primary" id="backupGo">Chọn nơi lưu…</button>
    </div>
  `, true);

  const all = $('#backupAll');
  const boxes = [...document.querySelectorAll('.backup-table')];
  const syncAll = () => {
    const checked = boxes.filter((box) => box.checked).length;
    all.checked = checked === boxes.length;
    all.indeterminate = checked > 0 && checked < boxes.length;
  };
  all.addEventListener('change', () => {
    boxes.forEach((box) => { box.checked = all.checked; });
  });
  boxes.forEach((box) => box.addEventListener('change', syncAll));
  $('#backupStructure').addEventListener('change', () => {
    $('#backupDrop').disabled = !$('#backupStructure').checked;
  });

  $('#backupGo').addEventListener('click', async () => {
    const selected = boxes.filter((box) => box.checked).map((box) => box.value);
    if (!selected.length) {
      toast('Chọn ít nhất một bảng hoặc view.', 'error');
      return;
    }
    const includeStructure = $('#backupStructure').checked;
    const includeData = $('#backupData').checked;
    if (!includeStructure && !includeData) {
      toast('Hãy chọn cấu trúc hoặc dữ liệu để sao lưu.', 'error');
      return;
    }
    const payload = {
      database: app.database,
      tables: selected,
      includeStructure,
      includeData,
      dropTables: includeStructure && $('#backupDrop').checked
    };
    closeModal();
    setStatus('Đang sao lưu…');
    try {
      const result = await call(desktop.db.backup(payload));
      if (result.canceled) {
        setStatus('Đã hủy sao lưu');
        return;
      }
      const parts = [`${result.tables} bảng`, `${result.views} view`];
      if (result.triggers) parts.push(`${result.triggers} trigger`);
      toast(`Đã sao lưu ${parts.join(', ')} (${result.rows} dòng) · ${formatBytes(result.bytes)}`);
      setStatus(`Sao lưu hoàn tất • ${formatBytes(result.bytes)}`);
    } catch (error) {
      toast(error.message, 'error');
      setStatus('Sao lưu thất bại');
    }
  });
}

function restoreDatabase() {
  if (!desktop) return;
  if (!app.connection || !app.database) {
    toast('Chọn database đích trước khi phục hồi.', 'error');
    return;
  }
  modal(`
    <h2>Phục hồi database</h2>
    <p>Đích: <strong>${esc(app.database)}</strong></p>
    <label class="checkline"><input type="checkbox" id="restoreDrop"> Xóa bảng/view/trigger trùng tên trước khi tạo lại</label>
    <div class="hint">Tệp .sql được chạy tuần tự vào database đích. Các lệnh USE và CREATE/DROP DATABASE trong tệp sẽ bị bỏ qua; khóa ngoại tạm thời tắt trong lúc phục hồi.</div>
    <div class="hint"><strong>Chỉ phục hồi tệp bạn tin cậy</strong> — nội dung tệp có thể thay đổi dữ liệu.</div>
    <div class="actions">
      <button onclick="closeModal()">Hủy</button>
      <button class="primary" id="restoreGo">Chọn tệp .sql…</button>
    </div>
  `);

  $('#restoreGo').addEventListener('click', async () => {
    const dropExisting = $('#restoreDrop').checked;
    const confirmed = await confirmAction(
      'Phục hồi database?',
      `Tệp SQL sẽ được chạy vào "${app.database}"${dropExisting ? ', xóa các bảng/view/trigger trùng tên trước khi tạo lại' : ''}. Thao tác này có thể thay đổi dữ liệu hiện có.`,
      'Tiếp tục'
    );
    if (!confirmed) return;
    closeModal();
    setStatus('Đang phục hồi…');
    try {
      const result = await call(desktop.db.restore({ database: app.database, dropExisting }));
      if (result.canceled) {
        setStatus('Đã hủy phục hồi');
        return;
      }
      toast(`Đã phục hồi ${result.statements} câu lệnh${result.skipped ? `, bỏ qua ${result.skipped}` : ''}`);
      setStatus(`Phục hồi hoàn tất • ${result.statements} câu lệnh`);
      const current = table;
      try {
        app.tables = await call(desktop.db.tables(app.database));
      } catch {
        // keep the previous list if metadata cannot be refreshed
      }
      renderSidebar();
      if (current && app.tables.some((entry) => entry.name === current)) {
        table = current;
        await loadData();
      } else {
        table = null;
        app.rows = [];
        app.columns = [];
        await view('data');
      }
      persistState();
    } catch (error) {
      toast(error.message, 'error');
      setStatus('Phục hồi thất bại');
      try {
        app.tables = await call(desktop.db.tables(app.database));
        renderSidebar();
      } catch {
        // ignore refresh failure
      }
    }
  });
}

async function transfer(type) {
  if (!app.database || !table) {
    toast('Chọn một bảng trước.', 'error');
    return;
  }
  if (type === 'export') {
    modal(`
      <h2>Xuất dữ liệu</h2>
      <p>${esc(app.database)}.${esc(table)}</p>
      <label>Định dạng</label>
      <select id="format"><option>JSON</option><option>CSV</option></select>
      <div class="hint">Xuất tối đa 20000 dòng. Dùng hộp thoại của hệ điều hành để chọn nơi lưu.</div>
      <div class="actions">
        <button onclick="closeModal()">Hủy</button>
        <button class="primary" id="exportGo">Chọn nơi lưu…</button>
      </div>
    `);
    $('#exportGo').addEventListener('click', async () => {
      const format = $('#format').value;
      $('#exportGo').disabled = true;
      $('#exportGo').textContent = 'Đang xuất…';
      try {
        const data = await call(desktop.db.exportTable({ database: app.database, table }));
        const contents = format === 'CSV' ? toCsv(data.columns, data.rows) : JSON.stringify(data.rows, null, 2);
        const result = await desktop.saveTextFile({
          suggestedName: `${table}.${format === 'CSV' ? 'csv' : 'json'}`,
          contents,
          filters: format === 'CSV'
            ? [{ name: 'CSV', extensions: ['csv'] }]
            : [{ name: 'JSON', extensions: ['json'] }]
        });
        closeModal();
        if (!result.canceled) toast(`Đã xuất ${data.rows.length} bản ghi${data.truncated ? ' (giới hạn 20000 dòng)' : ''}`);
      } catch (error) {
        toast(error.message, 'error');
        $('#exportGo').disabled = false;
        $('#exportGo').textContent = 'Chọn nơi lưu…';
      }
    });
    return;
  }

  modal(`
    <h2>Nhập dữ liệu</h2>
    <p>${esc(app.database)}.${esc(table)}</p>
    <div class="hint">Chọn tệp JSON là mảng đối tượng. Mỗi đối tượng tương ứng một dòng; tối đa 5000 dòng mỗi lần.</div>
    <div class="actions">
      <button onclick="closeModal()">Hủy</button>
      <button class="primary" id="importGo">Chọn tệp JSON…</button>
    </div>
  `);
  $('#importGo').addEventListener('click', async () => {
    try {
      const file = await desktop.openJsonFile();
      if (file.canceled) return;
      const rows = JSON.parse(file.contents);
      if (!Array.isArray(rows) || !rows.every((row) => row && typeof row === 'object' && !Array.isArray(row))) {
        throw new Error('Tệp phải là mảng JSON các đối tượng.');
      }
      if (!rows.length) throw new Error('Tệp không có bản ghi nào.');
      if (rows.length > 5000) throw new Error('Chỉ nhập tối đa 5000 bản ghi mỗi lần.');
      const confirmed = await confirmAction(`Nhập ${rows.length} bản ghi?`, 'Dữ liệu sẽ được ghi trực tiếp vào bảng đích.', 'Nhập');
      if (!confirmed) return;
      const result = await call(desktop.db.importRows({ database: app.database, table, rows }));
      closeModal();
      toast(`Đã nhập ${result.inserted} bản ghi`);
      await loadData();
    } catch (error) {
      toast(error.message, 'error');
    }
  });
}

function toCsv(columns, rows) {
  const escapeCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  return `﻿${[columns.map(escapeCell).join(','), ...rows.map((row) => columns.map((column) => escapeCell(row[column])).join(','))].join('\r\n')}`;
}

window.addEventListener('DOMContentLoaded', init);
