'use strict';

let table = null;
let mode = 'data';
let historyRows = [];

const desktop = window.sqlProDesktop;

const app = {
  connections: [],
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
  if (dialog.open) dialog.close();
  dialog.className = wide ? 'wide' : '';
  dialog.innerHTML = html;
  dialog.showModal();
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
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    desktop.saveState({
      connectionId: app.connection ? app.connection.id : null,
      database: app.database,
      table,
      mode,
      savedQuery: sessionStorage.getItem('query') || '',
      history: historyRows.slice(0, 100)
    }).catch(() => undefined);
  }, 150);
}

async function init() {
  $('#treeSearch').addEventListener('input', debounce(renderSidebar, 180));
  $('#connectionList').addEventListener('click', onConnectionClick);
  $('#databaseTree').addEventListener('click', onTreeClick);

  if (!desktop) {
    renderSidebar();
    view('data');
    return;
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
  if (saved && typeof saved.savedQuery === 'string' && saved.savedQuery) {
    app.query.sql = saved.savedQuery;
    sessionStorage.setItem('query', saved.savedQuery);
  }
  if (saved && Array.isArray(saved.history)) {
    historyRows = saved.history.map(normalizeHistory).filter(Boolean).slice(0, 100);
  }
  if (saved && typeof saved.table === 'string') table = saved.table;

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
}

async function refreshConnections() {
  if (!desktop) {
    app.connections = [];
    return;
  }
  app.connections = await call(desktop.connections.list());
  renderSidebar();
}

function renderSidebar() {
  const term = ($('#treeSearch').value || '').trim().toLowerCase();
  const connections = app.connections.filter((connection) => {
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
      Chưa có kết nối.<br>
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
  if (app.connection && app.connection.id === id && app.database && options.keepSession) {
    renderSidebar();
    return;
  }
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

function updateChrome() {
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
  $('#queryTab').classList.toggle('selected', mode === 'query');
  $('#subnav').style.display = ['query', 'history'].includes(mode) ? 'none' : 'flex';
  [...$('#subnav').children].forEach((button, index) => {
    button.classList.toggle('current', ['data', 'structure', 'indexes', 'relations'][index] === mode);
  });
  document.title = `${mode === 'query' ? 'SQL Editor' : mode === 'history' ? 'Lịch sử' : (table || 'Workspace')} — ${app.database || 'SqlPro'} — SqlPro`;
}

async function view(nextMode) {
  mode = nextMode;
  updateChrome();
  if (!app.connection) {
    renderWelcome();
    return;
  }
  if (!app.database) {
    renderDatabasePicker();
    return;
  }
  if (nextMode === 'data') {
    if (table) await loadData();
    else renderEmptyTable();
  } else if (nextMode === 'query') {
    renderQueryView();
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
  app.query.sql = defaultSql();
  sessionStorage.setItem('query', app.query.sql);
  view('query');
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
  const value = $('#sql')?.value ?? (app.query.sql || sessionStorage.getItem('query') || defaultSql());
  app.query.sql = value;
  $('#workspace').innerHTML = `
    <div class="toolbar">
      <button class="primary" id="runQueryBtn">▷ Chạy truy vấn</button>
      <button id="saveQueryBtn">⌑ Lưu truy vấn</button>
      <button class="danger" id="cancelQueryBtn" style="display:${app.query.running ? 'inline-block' : 'none'}">■ Hủy</button>
      <span class="spacer"></span>
      <span class="subtle">${esc(app.database)}${table ? ` · ${esc(table)}` : ''} &nbsp; · &nbsp; Ctrl + Enter</span>
    </div>
    <textarea class="editor" id="sql" spellcheck="false"></textarea>
    <div id="queryResult">${queryResultHtml()}</div>
  `;
  const editor = $('#sql');
  editor.value = value;
  editor.addEventListener('input', () => {
    app.query.sql = editor.value;
    sessionStorage.setItem('query', editor.value);
    persistState();
  });
  editor.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      runQuery();
    }
  });
  $('#runQueryBtn').addEventListener('click', runQuery);
  $('#saveQueryBtn').addEventListener('click', saveQuery);
  $('#cancelQueryBtn').addEventListener('click', cancelQuery);
  updateQueryButtons();
}

function queryResultHtml() {
  if (app.query.error) {
    return `<div class="errorbox">${esc(app.query.error)}</div>`;
  }
  const result = app.query.result;
  if (!result) {
    return `<div class="empty">▷<br><br>Chạy truy vấn để xem kết quả.<br><br>Kết nối đang dùng: ${esc(app.connection?.name || '—')}</div>`;
  }
  if (result.kind === 'ok') {
    return `<div class="resulttitle">✓ Thành công · ${result.affectedRows} dòng bị ảnh hưởng${result.insertId !== null ? ` · insert id ${esc(result.insertId)}` : ''} · ${result.durationMs} ms</div>`;
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
    <div class="resulttitle">✓ ${result.rows.length} dòng · ${result.durationMs} ms${result.truncated ? ' · đã giới hạn 5000 dòng' : ''}</div>
    <div class="tablebox"><table><thead>${header}</thead><tbody>${body}</tbody></table></div>
    ${result.truncated ? '<div class="hint">Kết quả vượt quá 5000 dòng nên đã bị cắt và kết nối được làm mới ở lần chạy sau.</div>' : ''}
  `;
}

function updateQueryButtons() {
  const run = $('#runQueryBtn');
  const cancel = $('#cancelQueryBtn');
  if (run) run.disabled = app.query.running;
  if (cancel) cancel.style.display = app.query.running ? 'inline-block' : 'none';
}

function saveQuery() {
  const editor = $('#sql');
  if (editor) app.query.sql = editor.value;
  sessionStorage.setItem('query', app.query.sql);
  persistState();
  toast('Đã lưu truy vấn trên máy');
}

async function runQuery() {
  if (app.query.running) return;
  const editor = $('#sql');
  const sql = (editor?.value || app.query.sql || '').trim();
  if (!sql) {
    toast('Câu lệnh SQL đang trống.', 'error');
    return;
  }
  if (/^\s*(drop|truncate|delete|update|alter|rename|grant|revoke)\b/i.test(sql)) {
    const confirmed = await confirmAction('Chạy lệnh có thể thay đổi dữ liệu?', 'Câu lệnh này có thể sửa hoặc xóa dữ liệu thật trong database.', 'Chạy');
    if (!confirmed) return;
  }
  app.query.sql = sql;
  app.query.running = true;
  app.query.error = null;
  updateQueryButtons();
  $('#queryResult').innerHTML = '<div class="empty">Đang chạy truy vấn…</div>';
  try {
    const result = await call(desktop.db.query({ sql, timeoutMs: 30000 }));
    app.query.result = result;
    app.query.error = null;
    historyRows.unshift({
      sql,
      ok: true,
      at: new Date().toISOString(),
      durationMs: result.durationMs,
      message: result.kind === 'ok' ? `${result.affectedRows} rows` : `${result.rows.length} rows`
    });
    historyRows = historyRows.slice(0, 100);
    setStatus(`Truy vấn hoàn tất • ${result.durationMs} ms`);
  } catch (error) {
    app.query.error = error.message;
    app.query.result = null;
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
    app.query.running = false;
    updateQueryButtons();
    $('#queryResult').innerHTML = queryResultHtml();
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
      app.query.sql = entry.sql;
      sessionStorage.setItem('query', entry.sql);
      view('query');
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
      <label>Database mặc định (tùy chọn)</label>
      <input id="connDatabase" value="${esc(p.database || '')}" placeholder="Bỏ trống để chọn sau">
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
    const result = await call(desktop.connections.importNavicat());
    if (result.canceled) return;
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
    <label class="checkline"><input type="checkbox" id="backupDrop"> Thêm DROP TABLE/VIEW IF EXISTS</label>
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
      toast(`Đã sao lưu ${result.tables} bảng, ${result.views} view (${result.rows} dòng) · ${formatBytes(result.bytes)}`);
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
    <label class="checkline"><input type="checkbox" id="restoreDrop"> Xóa bảng/view trùng tên trước khi tạo lại</label>
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
      `Tệp SQL sẽ được chạy vào "${app.database}"${dropExisting ? ', xóa các bảng/view trùng tên trước khi tạo lại' : ''}. Thao tác này có thể thay đổi dữ liệu hiện có.`,
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
