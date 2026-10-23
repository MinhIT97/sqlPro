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
  orderBy: null,
  orderDir: 'ASC',
  query: { sql: '', result: null, error: null, running: false },
  indexes: null,
  relations: null
};

let queryTabs = [{ id: 1, title: 'Query 1', sql: null, result: null, error: null, running: false }];
let activeQuery = 0;
let queryId = 1;
let dataRequestId = 0;
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
  element.setAttribute('role', type === 'error' ? 'alert' : 'status');
  element.textContent = message;
  element.className = type === 'error' ? 'toast-error' : '';
  element.style.display = 'block';
  clearTimeout(window.__sqlproToast);
  window.__sqlproToast = setTimeout(() => { element.style.display = 'none'; }, type === 'error' ? 8000 : 4000);
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

function quoteSqlString(value) {
  return "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
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

function initTheme() {
  const saved = localStorage.getItem('sqlpro-theme');
  const isLight = document.body.classList.toggle('light-theme', saved === 'light');
  const btn = $('#themeToggleBtn');
  if (btn) btn.textContent = isLight ? '🌙 Tối' : '☀️ Sáng';
}

function toggleTheme() {
  const isLight = document.body.classList.toggle('light-theme');
  localStorage.setItem('sqlpro-theme', isLight ? 'light' : 'dark');
  const btn = $('#themeToggleBtn');
  if (btn) btn.textContent = isLight ? '🌙 Tối' : '☀️ Sáng';
  toast(`Giao diện: ${isLight ? 'Sáng (Light)' : 'Tối (Dark)'}`, 'info');
}

async function showErDiagramModal() {
  if (!desktop || !app.connection || !app.database) {
    toast('Vui lòng chọn CSDL để xem sơ đồ quan hệ ERD.', 'error');
    return;
  }

  const database = app.database;
  const connectionId = app.connection.id;
  setStatus('Đang tải dữ liệu cấu trúc và quan hệ ERD...');
  let tablesList = [];
  let relationsData = { outbound: [], inbound: [] };
  const tableColumns = new Map();

  try {
    [tablesList, relationsData] = await Promise.all([
      call(desktop.db.tables(database)), call(desktop.db.relations(database, null))
    ]);

    // Load columns for each table (up to 30 tables to avoid overload)
    const tablesToLoad = tablesList.slice(0, 30);
    await Promise.all(tablesToLoad.map(async (t) => {
      try {
        const cols = await call(desktop.db.columns(database, t.name));
        tableColumns.set(t.name, cols);
      } catch (e) {
        tableColumns.set(t.name, []);
      }
    }));
  } catch (err) {
    toast(err.message || 'Lỗi khi nạp dữ liệu ERD', 'error');
    setStatus('Lỗi ERD');
    return;
  }

  if (database !== app.database || connectionId !== app.connection?.id) return;
  setStatus('Sẵn sàng');

  modal(`
    <div class="modal-card erd-modal-card">
      <div class="modal-header">
        <div style="display:flex; align-items:center; gap:12px;">
          <h3>📊 Sơ Đồ Quan Hệ Thực Thể (ERD) · ${esc(database)}</h3>
          <span style="font-size:0.85em; color:#9ca3af;">${Math.min(tablesList.length, 30)} / ${tablesList.length} bảng · ${relationsData.outbound.length} khóa ngoại</span>
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
          <button class="primary" id="exportErdPngBtn" style="padding:4px 10px; font-size:0.8em;">↧ Xuất PNG</button>
          <button class="close-btn" onclick="closeModal()">✕</button>
        </div>
      </div>
      <div class="modal-body" style="padding:0; position:relative; overflow:auto; background:#0b0f19; height:72vh;">
        <canvas id="erdCanvas" style="display:block; width:100%; height:100%; cursor:grab;"></canvas>
        <div style="position:absolute; bottom:12px; left:12px; background:rgba(0,0,0,0.6); padding:6px 12px; border-radius:6px; font-size:0.8em; color:#94a3b8; pointer-events:none;">
          💡 Kéo thả bảng để sắp xếp · Lăn chuột để cuộn
        </div>
      </div>
    </div>
  `);

  const canvas = $('#erdCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  // Set canvas logical size
  const rect = canvas.getBoundingClientRect();

  // Position tables in grid
  const CARD_WIDTH = 200;
  const HEADER_HEIGHT = 32;
  const ROW_HEIGHT = 22;
  const GAP_X = 60;
  const GAP_Y = 50;
  const COLS_COUNT = Math.max(1, Math.floor((rect.width - 60) / (CARD_WIDTH + GAP_X)));

  const nodes = tablesList.slice(0, 30).map((t, i) => {
    const colIdx = i % COLS_COUNT;
    const rowIdx = Math.floor(i / COLS_COUNT);
    const cols = tableColumns.get(t.name) || [];
    const height = HEADER_HEIGHT + Math.min(cols.length, 10) * ROW_HEIGHT + 8;
    return {
      name: t.name,
      x: 30 + colIdx * (CARD_WIDTH + GAP_X),
      y: 30 + rowIdx * (HEADER_HEIGHT + 10 * ROW_HEIGHT + 8 + GAP_Y),
      width: CARD_WIDTH,
      height,
      cols
    };
  });

  const nodeMap = new Map(nodes.map((n) => [n.name, n]));
  const width = Math.max(rect.width, ...nodes.map((node) => node.x + node.width + 30));
  const height = Math.max(rect.height, ...nodes.map((node) => node.y + node.height + 30));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.style.touchAction = 'none';
  const pixelRatio = window.devicePixelRatio || 1;
  canvas.width = Math.ceil(width * pixelRatio);
  canvas.height = Math.ceil(height * pixelRatio);
  ctx.scale(pixelRatio, pixelRatio);

  function draw() {
    ctx.fillStyle = '#0b0f19';
    ctx.fillRect(0, 0, width, height);

    // Draw background grid dots
    ctx.fillStyle = '#1e293b';
    for (let x = 15; x < width; x += 30) {
      for (let y = 15; y < height; y += 30) {
        ctx.fillRect(x, y, 1.5, 1.5);
      }
    }

    // Draw relation lines (Bezier curves)
    (relationsData.outbound || []).forEach((rel) => {
      const srcNode = nodeMap.get(rel.table);
      const dstNode = nodeMap.get(rel.refTable);
      if (!srcNode || !dstNode || rel.refDatabase !== database) return;

      const x1 = srcNode.x + srcNode.width;
      const y1 = srcNode.y + HEADER_HEIGHT + 15;
      const x2 = dstNode.x;
      const y2 = dstNode.y + HEADER_HEIGHT + 15;

      ctx.beginPath();
      ctx.moveTo(x1, y1);
      const cp1x = x1 + (x2 - x1) / 2;
      const cp1y = y1;
      const cp2x = x1 + (x2 - x1) / 2;
      const cp2y = y2;
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x2, y2);
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.8;
      ctx.stroke();

      // Arrow head at target
      ctx.beginPath();
      ctx.arc(x2, y2, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#38bdf8';
      ctx.fill();
    });

    // Draw table cards
    nodes.forEach((n) => {
      // Card Shadow & Box
      ctx.fillStyle = '#111827';
      ctx.strokeStyle = '#374151';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.roundRect(n.x, n.y, n.width, n.height, 6);
      ctx.fill();
      ctx.stroke();

      // Card Header
      ctx.fillStyle = '#1f2937';
      ctx.beginPath();
      ctx.roundRect(n.x, n.y, n.width, HEADER_HEIGHT, [6, 6, 0, 0]);
      ctx.fill();

      // Table Icon & Name
      ctx.fillStyle = '#f3f4f6';
      ctx.font = 'bold 12px sans-serif';
      ctx.fillText('▦ ' + (n.name.length > 20 ? n.name.slice(0, 18) + '…' : n.name), n.x + 8, n.y + 20);

      // Columns list
      ctx.font = '11px monospace';
      const visibleCols = n.cols.slice(0, 10);
      visibleCols.forEach((col, idx) => {
        const itemY = n.y + HEADER_HEIGHT + (idx + 1) * ROW_HEIGHT - 6;
        const isPk = col.key === 'PRI';
        ctx.fillStyle = isPk ? '#fbbf24' : '#94a3b8';
        const prefix = isPk ? '🔑 ' : '• ';
        const colText = prefix + col.name;
        ctx.fillText(colText.length > 22 ? colText.slice(0, 20) + '…' : colText, n.x + 8, itemY);
      });
      if (n.cols.length > 10) {
        ctx.fillStyle = '#6b7280';
        ctx.font = 'italic 10px sans-serif';
        ctx.fillText(`+ ${n.cols.length - 10} cột khác...`, n.x + 8, n.y + n.height - 4);
      }
    });
  }

  draw();

  // Drag interaction
  let draggedNode = null;
  let offsetX = 0;
  let offsetY = 0;

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const mouseX = e.offsetX;
    const mouseY = e.offsetY;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (mouseX >= n.x && mouseX <= n.x + n.width && mouseY >= n.y && mouseY <= n.y + n.height) {
        draggedNode = n;
        offsetX = mouseX - n.x;
        offsetY = mouseY - n.y;
        canvas.style.cursor = 'grabbing';
        canvas.setPointerCapture(e.pointerId);
        break;
      }
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!draggedNode) return;
    const canvasBounds = canvas.getBoundingClientRect();
    const mouseX = e.clientX - canvasBounds.left;
    const mouseY = e.clientY - canvasBounds.top;
    draggedNode.x = Math.max(0, Math.min(width - draggedNode.width, mouseX - offsetX));
    draggedNode.y = Math.max(0, Math.min(height - draggedNode.height, mouseY - offsetY));
    draw();
  });

  const stopDragging = () => {
    if (draggedNode) {
      draggedNode = null;
      canvas.style.cursor = 'grab';
    }
  };
  canvas.addEventListener('pointerup', stopDragging);
  canvas.addEventListener('pointercancel', stopDragging);
  canvas.addEventListener('lostpointercapture', stopDragging);

  // Export PNG button
  $('#exportErdPngBtn')?.addEventListener('click', () => {
    const dataUrl = canvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.download = `ERD-${database}.png`;
    link.href = dataUrl;
    link.click();
    toast('Đã xuất sơ đồ ERD thành công!', 'success');
  });
}

async function init() {
  initTheme();
  setupContextMenu();
  $('#treeSearch').addEventListener('input', debounce(renderSidebar, 180));
  $('#workspaceSelect').addEventListener('change', (event) => switchWorkspace(event.target.value));
  $('#connectionList').addEventListener('click', onConnectionClick);
  $('#databaseTree').addEventListener('click', onTreeClick);
  $('#databaseTree').addEventListener('keydown', activateSidebarItem);
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
        <div class="connhead">
          <button class="conn-open" data-connection="${esc(connection.id)}" aria-label="Kết nối ${esc(connection.name)}"${active ? ' aria-current="true"' : ''}>
            <i class="dot" style="background:${active ? '#24a68b' : '#c9d3db'}"></i>
            <span class="name">${esc(connection.name)}</span>
            <span class="badge type">${typeLabel}</span>
          </button>
          <button class="more" data-menu="${esc(connection.id)}" title="Tùy chọn" aria-label="Tùy chọn kết nối ${esc(connection.name)}">···</button>
        </div>
        <div class="connmeta">${esc(connection.user || 'root')}@${esc(connection.host)}:${connection.port}${connection.ssh.enabled ? ' · SSH' : ''}</div>
      </div>
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
      <div class="sideheading sub" data-databases-heading="1">DATABASE
        <span class="headingactions">
          <button id="createDbBtn" title="Tạo database mới">＋</button>
          <button data-refresh-dbs="1" title="Làm mới">↻</button>
        </span>
      </div>
      ${databases.length
        ? databases.map((name) => `<div class="database dbitem" data-db="${esc(name)}" role="button" tabindex="0" aria-label="Mở database ${esc(name)}">▱ &nbsp; ${esc(name)}</div>`).join('')
        : '<div class="empty small">Không có database phù hợp.</div>'}
    `;
    return;
  }

  const tables = app.tables.filter((entry) => entry.type === 'table' && (!term || entry.name.toLowerCase().includes(term)));
  const views = app.tables.filter((entry) => entry.type === 'view' && (!term || entry.name.toLowerCase().includes(term)));
  tree.innerHTML = `
    <div class="database" data-db-list="1" role="button" tabindex="0" title="Chọn database khác" aria-label="Chọn database khác, hiện tại ${esc(app.database)}">⌄ &nbsp;▱ &nbsp; ${esc(app.database)} <span>${app.tables.length}</span></div>
    <div class="dbactions">
      <button data-backup-db="1" title="Sao lưu database ra tệp .sql">⇩ Sao lưu</button>
      <button data-restore-db="1" title="Phục hồi database từ tệp .sql">⇧ Phục hồi</button>
    </div>
    <div class="sideheading sub">BẢNG <span>${tables.length}</span>
      <span class="headingactions">
        <button id="createTableBtn" title="Tạo bảng mới">＋</button>
      </span>
    </div>
    <div id="tree">
      ${tables.map((entry) => `
        <div class="treeitem ${entry.name === table ? 'selected' : ''}" data-table="${esc(entry.name)}" role="button" tabindex="0" aria-label="Mở bảng ${esc(entry.name)}"${entry.name === table ? ' aria-current="true"' : ''}>
          <span>▦</span>${esc(entry.name)}${entry.rowEstimate !== null ? `<span class="rowcount">${entry.rowEstimate}</span>` : ''}
        </div>
      `).join('') || '<div class="empty small">Không có bảng.</div>'}
    </div>
    <div class="sideheading sub">VIEW <span>${views.length}</span></div>
    ${views.map((entry) => `
      <div class="treeitem ${entry.name === table ? 'selected' : ''}" data-table="${esc(entry.name)}" role="button" tabindex="0" aria-label="Mở view ${esc(entry.name)}"${entry.name === table ? ' aria-current="true"' : ''}>
        <span>◫</span>${esc(entry.name)}
      </div>
    `).join('') || '<div class="empty small">Không có view.</div>'}
  `;
}

// ==========================================
// SQLPRO ENHANCED CORE FEATURES (P0)
// ==========================================

function exportCurrentResult(format) {
  const result = app.query?.result;
  if (!result) {
    toast('Không có kết quả truy vấn để xuất.', 'error');
    return;
  }
  let target = null;
  if (result.kind === 'rows') {
    target = result;
  } else if (result.kind === 'batch') {
    const tabKey = app.query.resultTab;
    const entry = (result.results || []).find((item) => item.index === Number(String(tabKey).replace('result-', '')));
    if (entry && entry.result && entry.result.kind === 'rows') {
      target = entry.result;
    } else {
      const first = (result.results || []).find((item) => item.ok && item.result?.kind === 'rows');
      if (first) target = first.result;
    }
  }
  if (!target || !target.rows || !target.rows.length) {
    toast('Không tìm thấy dữ liệu dòng để xuất.', 'error');
    return;
  }
  const cols = target.columns.map((c) => c.name);
  if (format === 'csv') {
    const escapeCsv = (val) => '"' + String(val ?? '').replace(/"/g, '""') + '"';
    const csvContent = '\uFEFF' + [
      cols.map(escapeCsv).join(','),
      ...target.rows.map((row) => row.map(escapeCsv).join(','))
    ].join('\r\n');
    desktop.saveTextFile({
      suggestedName: 'query-result.csv',
      contents: csvContent,
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    }).then((res) => {
      if (!res.canceled) toast('Đã xuất ' + target.rows.length + ' dòng ra CSV');
    }).catch((err) => toast(err.message, 'error'));
  } else {
    const jsonRows = target.rows.map((row) => {
      const obj = {};
      cols.forEach((col, idx) => { obj[col] = row[idx]; });
      return obj;
    });
    desktop.saveTextFile({
      suggestedName: 'query-result.json',
      contents: JSON.stringify(jsonRows, null, 2),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    }).then((res) => {
      if (!res.canceled) toast('Đã xuất ' + target.rows.length + ' dòng ra JSON');
    }).catch((err) => toast(err.message, 'error'));
  }
}

function parseCsv(text) {
  const content = String(text ?? '').replace(/^\uFEFF/, '');
  if (!content.trim()) return { headers: [], rows: [] };
  // Inspect the first logical record; separators inside quotes are data.
  const counts = new Map([[',', 0], [';', 0], ['\t', 0]]);
  let quoted = false;
  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    if (char === '"') {
      if (quoted && content[i + 1] === '"') i += 1;
      else quoted = !quoted;
    } else if (!quoted) {
      if (char === '\r' || char === '\n') {
        if ([...counts.values()].some(Boolean) || content.slice(0, i).trim()) break;
      } else if (counts.has(char)) counts.set(char, counts.get(char) + 1);
    }
  }
  const delimiter = [...counts].sort((a, b) => b[1] - a[1])[0][0];

  const rows = [];
  let currentRow = [];
  let currentCell = '';
  let state = 'start';
  let recordStarted = false;
  const finishRecord = () => {
    currentRow.push(currentCell);
    if (recordStarted) rows.push(currentRow);
    currentRow = [];
    currentCell = '';
    state = 'start';
    recordStarted = false;
  };

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    const nextChar = content[i + 1];
    if (state === 'quoted') {
      if (char === '"' && nextChar === '"') {
        currentCell += '"';
        i += 1;
      } else if (char === '"') state = 'afterQuote';
      else currentCell += char;
    } else if (char === delimiter) {
      currentRow.push(currentCell);
      currentCell = '';
      state = 'start';
      recordStarted = true;
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && nextChar === '\n') i += 1;
      finishRecord();
    } else if (char === '"' && state === 'start') {
      state = 'quoted';
      recordStarted = true;
    } else if (state === 'afterQuote') {
      if (char !== ' ' && char !== '\t') throw new Error('CSV không hợp lệ: ký tự sau dấu nháy đóng.');
    } else {
      if (char === '"') throw new Error('CSV không hợp lệ: dấu nháy trong ô chưa được escape.');
      currentCell += char;
      state = 'unquoted';
      recordStarted = true;
    }
  }
  if (state === 'quoted') throw new Error('CSV không hợp lệ: ô có dấu nháy chưa được đóng.');
  if (recordStarted) finishRecord();
  if (!rows.length) return { headers: [], rows: [] };
  const headers = rows[0];
  const dataRows = rows.slice(1);
  const invalidRow = dataRows.findIndex((row) => row.length !== headers.length);
  if (invalidRow !== -1) throw new Error(`CSV không hợp lệ: bản ghi ${invalidRow + 2} có số cột khác tiêu đề.`);
  return { headers, rows: dataRows };
}

async function importCsvModal() {
  if (!app.database || !table) {
    toast('Hãy chọn một bảng trước khi nhập.', 'error');
    return;
  }
  const database = app.database;
  const targetTable = table;
  const targetCols = app.columns.filter((c) => !/auto_increment|(?:virtual|stored) generated/i.test(c.extra));
  try {
    const file = await desktop.openTextFile({
      title: 'Chọn tệp CSV / TSV để nhập',
      filters: [{ name: 'CSV / TSV / Văn bản', extensions: ['csv', 'tsv', 'txt'] }]
    });
    if (file.canceled) return;
    const parsed = parseCsv(file.contents);
    if (!parsed.headers.length || !parsed.rows.length) {
      toast('Tệp không có dữ liệu hợp lệ.', 'error');
      return;
    }
    if (parsed.rows.length > 5000) {
      throw new Error('Chỉ nhập tối đa 5000 bản ghi mỗi lần. Hãy chia tệp CSV thành các tệp nhỏ hơn.');
    }
    const previewRows = parsed.rows.slice(0, 5);

    const mappingHtml = targetCols.map((col) => {
      const matchedIdx = parsed.headers.findIndex(
        (h) => h.toLowerCase().trim() === col.name.toLowerCase().trim()
      );
      const options = [
        '<option value="-1">-- Bỏ qua cột này --</option>',
        ...parsed.headers.map((h, i) => `<option value="${i}" ${i === matchedIdx ? 'selected' : ''}>${esc(h)}</option>`)
      ].join('');
      return `
        <div class="csv-mapping-row">
          <span><strong>${esc(col.name)}</strong> <small class="muted">${esc(col.type)}</small></span>
          <span>→</span>
          <select data-db-col="${esc(col.name)}">${options}</select>
        </div>
      `;
    }).join('');

    const previewHeader = `<tr>${parsed.headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>`;
    const previewBody = previewRows.map((r) => `
      <tr>${parsed.headers.map((_, i) => `<td>${esc(r[i] ?? '')}</td>`).join('')}</tr>
    `).join('');

    modal(`
      <div class="dialog wide extra-wide">
        <h2>Nhập CSV vào ${esc(database)}.${esc(targetTable)}</h2>
        <p>Phát hiện <strong>${parsed.rows.length}</strong> dòng dữ liệu • Ghép các cột tệp CSV với cột trong bảng MySQL:</p>
        <label>Ánh xạ cột (Column Mapping)</label>
        <div class="csv-mapping-grid">${mappingHtml}</div>
        <label style="margin-top:14px">Xem trước 5 dòng đầu tiên từ tệp CSV</label>
        <div class="csv-preview-table"><table><thead>${previewHeader}</thead><tbody>${previewBody}</tbody></table></div>
        <div class="actions">
          <button onclick="closeModal()">Hủy</button>
          <button class="primary" id="doCsvImportBtn">Bắt đầu nhập (${parsed.rows.length} dòng)</button>
        </div>
      </div>
    `, true);

    const importButton = $('#doCsvImportBtn');
    importButton.addEventListener('click', async () => {
      const mappings = [];
      document.querySelectorAll('.csv-mapping-row select').forEach((sel) => {
        const fileIdx = Number(sel.value);
        if (fileIdx >= 0) mappings.push({ dbCol: sel.dataset.dbCol, fileIdx });
      });
      if (!mappings.length) {
        toast('Hãy chọn ít nhất 1 cột để nhập dữ liệu.', 'error');
        return;
      }
      if (importButton.disabled) return;
      importButton.disabled = true;
      importButton.textContent = 'Đang nhập…';
      try {
        const rowsToImport = parsed.rows.map((r) => {
          const rowObj = {};
          mappings.forEach((m) => {
            const raw = r[m.fileIdx];
            rowObj[m.dbCol] = raw;
          });
          return rowObj;
        });
        const res = await call(desktop.db.importRows({ database, table: targetTable, rows: rowsToImport }));
        closeModal();
        toast(`Đã nhập thành công ${res.inserted} bản ghi!`);
        await loadData();
      } catch (err) {
        toast(err.message, 'error');
        importButton.disabled = false;
        importButton.textContent = 'Bắt đầu nhập';
      }
    });
  } catch (err) {
    toast(err.message, 'error');
  }
}

function createDatabaseModal() {
  if (!app.connection) {
    toast('Chưa kết nối tới máy chủ.', 'error');
    return;
  }
  modal(`
    <h2>Tạo Database mới</h2>
    <p>Máy chủ: ${esc(app.connection.name)} (${esc(app.connection.host)})</p>
    <label>Tên database</label>
    <input id="newDbName" placeholder="ví dụ: my_project_db" autofocus autocomplete="off">
    <div class="formrow" style="margin-top:10px">
      <div>
        <label>Bảng mã (Charset)</label>
        <select id="newDbCharset">
          <option value="utf8mb4" selected>utf8mb4 (Khuyên dùng)</option>
          <option value="utf8">utf8</option>
          <option value="latin1">latin1</option>
        </select>
      </div>
      <div>
        <label>Sắp xếp (Collation)</label>
        <select id="newDbCollate">
          <option value="utf8mb4_unicode_ci" selected>utf8mb4_unicode_ci</option>
          <option value="utf8mb4_general_ci">utf8mb4_general_ci</option>
          <option value="utf8mb4_0900_ai_ci">utf8mb4_0900_ai_ci</option>
        </select>
      </div>
    </div>
    <div class="actions">
      <button onclick="closeModal()">Hủy</button>
      <button class="primary" id="btnSubmitCreateDb">Tạo Database</button>
    </div>
  `);

  $('#btnSubmitCreateDb').addEventListener('click', async () => {
    const dbName = ($('#newDbName').value || '').trim();
    if (!dbName) {
      toast('Tên database không được để trống.', 'error');
      return;
    }
    const charset = $('#newDbCharset').value;
    const collate = $('#newDbCollate').value;
    $('#btnSubmitCreateDb').disabled = true;
    $('#btnSubmitCreateDb').textContent = 'Đang tạo…';
    try {
      const sql = 'CREATE DATABASE `' + dbName.replace(/`/g, '``') + '` DEFAULT CHARACTER SET ' + charset + ' COLLATE ' + collate + ';';
      await call(desktop.db.query({ sql, timeoutMs: 15000, confirmed: true }));
      closeModal();
      toast('Đã tạo database ' + dbName + ' thành công!');
      await refreshDatabases();
      await selectDatabase(dbName);
    } catch (err) {
      toast(err.message, 'error');
      $('#btnSubmitCreateDb').disabled = false;
      $('#btnSubmitCreateDb').textContent = 'Tạo Database';
    }
  });
}

async function dropDatabaseAction(dbName) {
  const targetDb = dbName || app.database;
  if (!targetDb) return;
  const confirmed = await confirmAction(
    'XÓA VĨNH VIỄN database "' + targetDb + '"?',
    'CẢNH BÁO: Toàn bộ bảng, dữ liệu và view trong database "' + targetDb + '" sẽ bị xóa hoàn toàn và không thể hoàn tác!',
    'Xóa Database'
  );
  if (!confirmed) return;
  try {
    const sql = 'DROP DATABASE `' + targetDb.replace(/`/g, '``') + '`;';
    await call(desktop.db.query({ sql, timeoutMs: 15000, confirmed: true }));
    toast('Đã xóa database ' + targetDb + '.');
    if (app.database === targetDb) {
      app.database = null;
      table = null;
      app.tables = [];
    }
    await refreshDatabases();
    renderSidebar();
    renderDatabasePicker();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function createTableModal() {
  if (!app.database) {
    toast('Hãy chọn một database trước.', 'error');
    return;
  }
  let columnRows = [
    { name: 'id', type: 'INT', length: '', nullable: false, pk: true, ai: true, def: '' },
    { name: 'name', type: 'VARCHAR', length: '255', nullable: false, pk: false, ai: false, def: '' },
    { name: 'created_at', type: 'DATETIME', length: '', nullable: true, pk: false, ai: false, def: 'CURRENT_TIMESTAMP' }
  ];

  function renderRowsHtml() {
    return columnRows.map((col, idx) => `
      <tr data-col-idx="${idx}">
        <td><input class="col-name" value="${esc(col.name)}" placeholder="tên_cột" style="width:100%"></td>
        <td>
          <select class="col-type" style="width:100%">
            <option ${col.type === 'INT' ? 'selected' : ''}>INT</option>
            <option ${col.type === 'BIGINT' ? 'selected' : ''}>BIGINT</option>
            <option ${col.type === 'VARCHAR' ? 'selected' : ''}>VARCHAR</option>
            <option ${col.type === 'TEXT' ? 'selected' : ''}>TEXT</option>
            <option ${col.type === 'LONGTEXT' ? 'selected' : ''}>LONGTEXT</option>
            <option ${col.type === 'TINYINT' ? 'selected' : ''}>TINYINT</option>
            <option ${col.type === 'DECIMAL' ? 'selected' : ''}>DECIMAL</option>
            <option ${col.type === 'DATETIME' ? 'selected' : ''}>DATETIME</option>
            <option ${col.type === 'DATE' ? 'selected' : ''}>DATE</option>
            <option ${col.type === 'TIMESTAMP' ? 'selected' : ''}>TIMESTAMP</option>
            <option ${col.type === 'JSON' ? 'selected' : ''}>JSON</option>
          </select>
        </td>
        <td><input class="col-len" value="${esc(col.length)}" placeholder="ví dụ: 255" style="width:70px"></td>
        <td style="text-align:center"><input type="checkbox" class="col-pk" ${col.pk ? 'checked' : ''}></td>
        <td style="text-align:center"><input type="checkbox" class="col-ai" ${col.ai ? 'checked' : ''}></td>
        <td style="text-align:center"><input type="checkbox" class="col-null" ${col.nullable ? 'checked' : ''}></td>
        <td><input class="col-def" value="${esc(col.def)}" placeholder="Mặc định" style="width:100%"></td>
        <td><button type="button" class="danger del-col-btn" data-del="${idx}" style="padding:4px 8px">✕</button></td>
      </tr>
    `).join('');
  }

  function showDesignerModal() {
    modal(`
      <div class="dialog wide extra-wide">
        <h2>Thiết kế Bảng mới (Table Designer)</h2>
        <p>Database: <strong>${esc(app.database)}</strong></p>
        <label>Tên bảng</label>
        <input id="newTableName" placeholder="ví dụ: users, products, orders…" autofocus style="width:320px">
        <table class="designer-table">
          <thead>
            <tr>
              <th>Tên cột</th>
              <th>Kiểu dữ liệu</th>
              <th>Độ dài</th>
              <th title="Khóa chính">PK</th>
              <th title="Tự động tăng">A_I</th>
              <th title="Cho phép NULL">Null</th>
              <th>Mặc định</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="designerTableBody">${renderRowsHtml()}</tbody>
        </table>
        <div class="designer-actions">
          <button type="button" id="btnAddColRow">＋ Thêm cột</button>
          <span class="muted">Storage engine: InnoDB • Charset: utf8mb4</span>
        </div>
        <div class="actions">
          <button onclick="closeModal()">Hủy</button>
          <button class="primary" id="btnSaveNewTable">Tạo bảng</button>
        </div>
      </div>
    `, true);

    $('#btnAddColRow').addEventListener('click', () => {
      readCurrentForm();
      columnRows.push({ name: '', type: 'VARCHAR', length: '255', nullable: true, pk: false, ai: false, def: '' });
      $('#designerTableBody').innerHTML = renderRowsHtml();
      bindRowEvents();
    });

    bindRowEvents();

    $('#btnSaveNewTable').addEventListener('click', async () => {
      readCurrentForm();
      const tableName = ($('#newTableName').value || '').trim();
      if (!tableName) {
        toast('Tên bảng không được để trống.', 'error');
        return;
      }
      if (!columnRows.length || !columnRows.some((c) => c.name)) {
        toast('Bảng phải có ít nhất 1 cột.', 'error');
        return;
      }
      const colDefs = [];
      const pkCols = [];
      for (const col of columnRows) {
        if (!col.name) continue;
        let typeStr = col.type;
        if (col.length) typeStr += '(' + col.length + ')';
        else if (col.type === 'DECIMAL') typeStr += '(10,2)';
        let defPart = '`' + col.name.replace(/`/g, '``') + '` ' + typeStr;
        if (!col.nullable) defPart += ' NOT NULL';
        if (col.ai) defPart += ' AUTO_INCREMENT';
        if (col.def) {
          defPart += col.def.toUpperCase() === 'CURRENT_TIMESTAMP' ? ' DEFAULT CURRENT_TIMESTAMP' : " DEFAULT '" + col.def.replace(/'/g, "''") + "'";
        }
        colDefs.push(defPart);
        if (col.pk) pkCols.push('`' + col.name.replace(/`/g, '``') + '`');
      }
      if (pkCols.length) {
        colDefs.push('PRIMARY KEY (' + pkCols.join(', ') + ')');
      }
    const ddl = `CREATE TABLE ${quoteId(app.database)}.${quoteId(tableName)} (\n  ${colDefs.join(',\n  ')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;
      $('#btnSaveNewTable').disabled = true;
      $('#btnSaveNewTable').textContent = 'Đang tạo…';
      try {
        await call(desktop.db.query({ sql: ddl, timeoutMs: 20000, confirmed: true }));
        closeModal();
        toast('Đã tạo bảng ' + tableName + ' thành công!');
        await selectDatabase(app.database);
        await selectTable(tableName);
      } catch (err) {
        toast(err.message, 'error');
        $('#btnSaveNewTable').disabled = false;
        $('#btnSaveNewTable').textContent = 'Tạo bảng';
      }
    });
  }

  function readCurrentForm() {
    const rows = document.querySelectorAll('#designerTableBody tr');
    columnRows = [];
    rows.forEach((r) => {
      columnRows.push({
        name: (r.querySelector('.col-name')?.value || '').trim(),
        type: r.querySelector('.col-type')?.value || 'VARCHAR',
        length: (r.querySelector('.col-len')?.value || '').trim(),
        pk: Boolean(r.querySelector('.col-pk')?.checked),
        ai: Boolean(r.querySelector('.col-ai')?.checked),
        nullable: Boolean(r.querySelector('.col-null')?.checked),
        def: (r.querySelector('.col-def')?.value || '').trim()
      });
    });
  }

  function bindRowEvents() {
    document.querySelectorAll('.del-col-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        readCurrentForm();
        const idx = Number(btn.dataset.del);
        columnRows.splice(idx, 1);
        $('#designerTableBody').innerHTML = renderRowsHtml();
        bindRowEvents();
      });
    });
  }

  showDesignerModal();
}

async function truncateTableAction(tableName) {
  const targetTable = tableName || table;
  if (!app.database || !targetTable) return;
  const confirmed = await confirmAction(
    'XÓA SẠCH DỮ LIỆU trong bảng "' + targetTable + '"?',
    'Lệnh TRUNCATE TABLE sẽ xóa tất cả bản ghi và reset bộ đếm auto-increment của bảng "' + targetTable + '".',
    'Xóa sạch dữ liệu'
  );
  if (!confirmed) return;
  try {
    const sql = `TRUNCATE TABLE ${quoteId(app.database)}.${quoteId(targetTable)};`;
    await call(desktop.db.query({ sql, timeoutMs: 15000, confirmed: true }));
    toast('Đã xóa sạch dữ liệu bảng ' + targetTable + '.');
    if (table === targetTable) await loadData();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function dropTableAction(tableName) {
  const targetTable = tableName || table;
  if (!app.database || !targetTable) return;
  const confirmed = await confirmAction(
    'XÓA BẢNG "' + targetTable + '"?',
    'Bảng "' + targetTable + '" và toàn bộ dữ liệu bên trong sẽ bị xóa vĩnh viễn khỏi database ' + app.database + '.',
    'Xóa Bảng'
  );
  if (!confirmed) return;
  try {
    const sql = `DROP TABLE ${quoteId(app.database)}.${quoteId(targetTable)};`;
    await call(desktop.db.query({ sql, timeoutMs: 15000, confirmed: true }));
    toast('Đã xóa bảng ' + targetTable + '.');
    if (table === targetTable) table = null;
    await selectDatabase(app.database);
    if (!table) renderEmptyTable();
  } catch (err) {
    toast(err.message, 'error');
  }
}


async function showProcesslistModal() {
  if (!desktop || !app.connection) {
    toast('Chưa kết nối CSDL.', 'error');
    return;
  }

  modal(`
    <div class="modal-card processlist-card">
      <div class="modal-header">
        <div style="display:flex; align-items:center; gap:10px;">
          <h3>🖥️ Quản Lý Tiến Trình (Processlist)</h3>
          <button class="primary" id="refreshProcesslistBtn" style="padding:3px 10px; font-size:0.85em;">↻ Làm mới</button>
        </div>
        <button class="close-btn" onclick="closeModal()">✕</button>
      </div>
      <div class="modal-body" style="padding:12px 16px;">
        <div style="margin-bottom:10px; display:flex; gap:10px;">
          <input type="search" id="processlistFilter" placeholder="🔍 Lọc theo user, db, câu lệnh..." style="flex:1; padding:6px 10px; background:#111827; border:1px solid #374151; border-radius:4px; color:#fff;">
          <span id="processlistCount" style="align-self:center; color:#9ca3af; font-size:0.9em;">Đang tải...</span>
        </div>
        <div id="processlistContainer" style="max-height: 480px; overflow: auto; border:1px solid rgba(255,255,255,0.08); border-radius:4px;">
          <div style="padding:20px; text-align:center; color:#9ca3af;">Đang truy vấn SHOW FULL PROCESSLIST...</div>
        </div>
      </div>
      <div class="modal-footer" style="text-align: right; margin-top: 12px;">
        <button class="primary" onclick="closeModal()">Đóng (Esc)</button>
      </div>
    </div>
  `);

  async function loadProcesslist() {
    const container = $('#processlistContainer');
    const countEl = $('#processlistCount');
    if (!container) return;
    try {
      const res = await call(desktop.db.query({ sql: 'SHOW FULL PROCESSLIST' }));
      if (container !== $('#processlistContainer')) return;
      const rows = res.rows || [];
      const filterVal = ($('#processlistFilter')?.value || '').toLowerCase().trim();

      const filtered = rows.filter((r) => {
        if (!filterVal) return true;
        const user = String(r[1] || '').toLowerCase();
        const db = String(r[3] || '').toLowerCase();
        const info = String(r[7] || '').toLowerCase();
        return user.includes(filterVal) || db.includes(filterVal) || info.includes(filterVal);
      });

      if (countEl) countEl.textContent = `${filtered.length} / ${rows.length} tiến trình`;

      if (!filtered.length) {
        container.innerHTML = '<div style="padding:20px; text-align:center; color:#9ca3af;">Không có tiến trình nào phù hợp.</div>';
        return;
      }

      container.innerHTML = `
        <table class="processlist-table">
          <thead>
            <tr>
              <th style="width:60px;">ID</th>
              <th style="width:100px;">User</th>
              <th style="width:120px;">Host</th>
              <th style="width:100px;">DB</th>
              <th style="width:90px;">Command</th>
              <th style="width:80px;">Thời gian</th>
              <th style="width:100px;">State</th>
              <th>Câu lệnh SQL</th>
              <th style="width:70px; text-align:center;">Hành động</th>
            </tr>
          </thead>
          <tbody>
            ${filtered.map((r) => {
              const id = r[0];
              const user = r[1] || '';
              const host = r[2] || '';
              const dbName = r[3] || '';
              const command = r[4] || '';
              const timeSec = Number(r[5] || 0);
              const state = r[6] || '';
              const info = r[7] || '';
              const isSlow = timeSec > 5 && command === 'Query';

              return `
                <tr class="${isSlow ? 'slow-process-row' : ''}">
                  <td><strong>${esc(String(id))}</strong></td>
                  <td>${esc(user)}</td>
                  <td title="${esc(host)}">${esc(host.length > 18 ? host.slice(0, 18) + '…' : host)}</td>
                  <td>${esc(dbName || '—')}</td>
                  <td><span class="command-badge ${command === 'Query' ? 'active' : ''}">${esc(command)}</span></td>
                  <td>${timeSec}s ${isSlow ? '⚠️' : ''}</td>
                  <td><small>${esc(state || '—')}</small></td>
                  <td title="${esc(info)}"><code class="process-sql">${esc(info ? (info.length > 90 ? info.slice(0, 90) + '…' : info) : '—')}</code></td>
                  <td style="text-align:center;">
                    <button class="danger kill-btn" data-kill-id="${id}" style="padding:2px 8px; font-size:0.75em;" title="Hủy tiến trình #${id}">🛑 Kill</button>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      `;

      container.querySelectorAll('.kill-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const killId = btn.dataset.killId;
          if (!/^\d+$/.test(killId)) return;
          const confirmed = await confirmAction(`Hủy tiến trình #${killId}?`, 'Kết nối hoặc truy vấn của tiến trình này sẽ bị dừng.', 'Hủy tiến trình');
          if (!confirmed) return;
          try {
            await call(desktop.db.query({ sql: `KILL ${killId}`, confirmed: true }));
            toast(`Đã hủy tiến trình #${killId}`, 'success');
            await showProcesslistModal();
          } catch (err) {
            toast(err.message || 'Lỗi khi hủy tiến trình', 'error');
          }
        });
      });
    } catch (err) {
      container.innerHTML = `<div style="padding:20px; color:#f87171;">Lỗi: ${esc(err.message)}</div>`;
    }
  }

  loadProcesslist();
  $('#refreshProcesslistBtn')?.addEventListener('click', loadProcesslist);
  $('#processlistFilter')?.addEventListener('input', debounce(loadProcesslist, 300));
}

async function showServerVarsModal(defaultTab = 'variables') {
  if (!desktop || !app.connection) {
    toast('Chưa kết nối CSDL.', 'error');
    return;
  }

  modal(`
    <div class="modal-card vars-modal-card">
      <div class="modal-header">
        <div style="display:flex; align-items:center; gap:12px;">
          <h3 id="varsModalTitle">⚙️ Cấu Hình Máy Chủ MySQL</h3>
          <div class="vars-tabs">
            <button class="vars-tab-btn ${defaultTab === 'variables' ? 'active' : ''}" id="tabVarsBtn">Biến hệ thống (VARIABLES)</button>
            <button class="vars-tab-btn ${defaultTab === 'status' ? 'active' : ''}" id="tabStatusBtn">Trạng thái máy chủ (STATUS)</button>
          </div>
        </div>
        <button class="close-btn" onclick="closeModal()">✕</button>
      </div>
      <div class="modal-body" style="padding:12px 16px;">
        <div style="margin-bottom:10px; display:flex; gap:10px;">
          <input type="search" id="varsFilterInput" placeholder="🔍 Tìm biến (vd: max_connections, buffer, version...)" style="flex:1; padding:6px 10px; background:#111827; border:1px solid #374151; border-radius:4px; color:#fff;">
          <span id="varsItemCount" style="align-self:center; color:#9ca3af; font-size:0.9em;">Đang nạp...</span>
        </div>
        <div id="varsTableContainer" style="max-height: 480px; overflow: auto; border:1px solid rgba(255,255,255,0.08); border-radius:4px;">
          <div style="padding:20px; text-align:center; color:#9ca3af;">Đang tải dữ liệu cấu hình...</div>
        </div>
      </div>
      <div class="modal-footer" style="text-align: right; margin-top: 12px;">
        <button class="primary" onclick="closeModal()">Đóng (Esc)</button>
      </div>
    </div>
  `);

  let currentMode = defaultTab;
  let cachedData = { variables: null, status: null };

  async function loadData() {
    const container = $('#varsTableContainer');
    const countEl = $('#varsItemCount');
    if (!container) return;

    try {
      if (!cachedData[currentMode]) {
        const querySql = currentMode === 'variables' ? 'SHOW VARIABLES' : 'SHOW STATUS';
        const modeToLoad = currentMode;
        const res = await call(desktop.db.query({ sql: querySql }));
        cachedData[modeToLoad] = res.rows || [];
        if (currentMode !== modeToLoad || container !== $('#varsTableContainer')) return;
      }

      const rows = cachedData[currentMode];
      const filterVal = ($('#varsFilterInput')?.value || '').toLowerCase().trim();

      const filtered = rows.filter((r) => {
        if (!filterVal) return true;
        const name = String(r[0] || '').toLowerCase();
        const val = String(r[1] || '').toLowerCase();
        return name.includes(filterVal) || val.includes(filterVal);
      });

      if (countEl) countEl.textContent = `${filtered.length} / ${rows.length} mục`;

      container.innerHTML = `
        <table class="vars-table">
          <thead>
            <tr>
              <th style="width:340px;">Tên biến / Chỉ số</th>
              <th>Giá trị hiện tại</th>
            </tr>
          </thead>
          <tbody>
            ${filtered.map((r) => `
              <tr>
                <td><code>${esc(String(r[0]))}</code></td>
                <td><span class="var-value">${esc(String(r[1]))}</span></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    } catch (err) {
      container.innerHTML = `<div style="padding:20px; color:#f87171;">Lỗi: ${esc(err.message)}</div>`;
    }
  }

  loadData();

  $('#tabVarsBtn')?.addEventListener('click', () => {
    currentMode = 'variables';
    $('#tabVarsBtn').classList.add('active');
    $('#tabStatusBtn').classList.remove('active');
    loadData();
  });

  $('#tabStatusBtn')?.addEventListener('click', () => {
    currentMode = 'status';
    $('#tabStatusBtn').classList.add('active');
    $('#tabVarsBtn').classList.remove('active');
    loadData();
  });

  $('#varsFilterInput')?.addEventListener('input', debounce(loadData, 250));
}

async function runTableMaintenance(tableName, operation) {
  if (!desktop || !app.connection || !app.database) {
    toast('Chưa chọn CSDL.', 'error');
    return;
  }
  const opName = operation.toUpperCase();
  setStatus(`Đang thực thi ${opName} TABLE...`);
  try {
    if (!['OPTIMIZE', 'CHECK', 'ANALYZE', 'REPAIR'].includes(opName)) throw new Error('Thao tác bảo trì không hợp lệ.');
    const res = await call(desktop.db.query({ sql: `${opName} TABLE ${quoteId(app.database)}.${quoteId(tableName)}`, confirmed: true }));
    const rows = res.rows || [];

    modal(`
      <div class="modal-card" style="max-width:620px;">
        <div class="modal-header">
          <h3>🛠️ Kết Quả Bảo Trì: ${esc(opName)} TABLE</h3>
          <button class="close-btn" onclick="closeModal()">✕</button>
        </div>
        <div class="modal-body" style="padding:16px;">
          <p style="margin-bottom:12px; color:#9ca3af;">Đã thực thi trên bảng <strong>${esc(app.database)}.${esc(tableName)}</strong>:</p>
          <table class="shortcuts-table">
            <thead>
              <tr>
                <th>Bảng</th>
                <th>Thao tác</th>
                <th>Trạng thái</th>
                <th>Thông báo</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map((r) => `
                <tr>
                  <td>${esc(String(r[0] || ''))}</td>
                  <td>${esc(String(r[1] || ''))}</td>
                  <td><span class="explain-badge ${String(r[2]).toLowerCase() === 'status' ? 'good' : 'warn'}">${esc(String(r[2] || ''))}</span></td>
                  <td>${esc(String(r[3] || ''))}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        <div class="modal-footer" style="text-align: right; margin-top: 16px;">
          <button class="primary" onclick="closeModal()">Đóng</button>
        </div>
      </div>
    `);
    toast(`Hoàn tất ${opName} bảng ${tableName}`, 'success');
    setStatus('Sẵn sàng');
  } catch (err) {
    toast(err.message || `Lỗi khi ${opName} TABLE`, 'error');
    setStatus('Lỗi');
  }
}

function setupContextMenu() {
  const menu = $('#contextMenu');
  if (!menu) return;

  function closeMenu() {
    menu.classList.add('hidden');
    menu.innerHTML = '';
  }

  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });

  document.addEventListener('contextmenu', (event) => {
    const gridTd = event.target.closest('#grid table tbody td');
    if (gridTd) {
      const row = gridTd.closest('tr[data-row]');
      if (!row) return;
      event.preventDefault();
      const rowIdx = Number(row.dataset.row);
      const colName = gridTd.dataset.col;
      const rowData = app.rows[rowIdx];
      if (!rowData) return;

      const cellVal = colName ? rowData[colName] : '';
      const editable = app.primaryKey && app.primaryKey.length > 0;

      menu.innerHTML = `
        ${colName ? `<div class="context-menu-item" data-action="copy-cell"><span class="c-icon">📋</span> Sao chép ô (${esc(colName)})</div>` : ''}
        <div class="context-menu-item" data-action="copy-row-json"><span class="c-icon">📑</span> Sao chép dòng dạng JSON</div>
        <div class="context-menu-item" data-action="copy-row-insert"><span class="c-icon">📥</span> Sao chép dòng dạng INSERT SQL</div>
        ${(colName && editable) ? `<div class="context-menu-item" data-action="set-cell-null"><span class="c-icon">⊘</span> Đặt ô thành NULL</div>` : ''}
        <div class="context-menu-divider"></div>
        ${editable ? `<div class="context-menu-item" data-action="edit-row"><span class="c-icon">✏️</span> Sửa dòng (Modal)...</div>` : ''}
        ${editable ? `<div class="context-menu-item text-danger" data-action="delete-row"><span class="c-icon">🗑️</span> Xóa dòng này</div>` : ''}
      `;
      positionMenu(event.clientX, event.clientY);

      menu.querySelectorAll('.context-menu-item').forEach((item) => {
        item.addEventListener('click', async () => {
          const action = item.dataset.action;
          closeMenu();
          if (action === 'copy-cell') {
            await navigator.clipboard.writeText(cellVal === null || cellVal === undefined ? '' : String(cellVal));
            toast('Đã sao chép giá trị ô', 'success');
          } else if (action === 'copy-row-json') {
            await navigator.clipboard.writeText(JSON.stringify(rowData, null, 2));
            toast('Đã sao chép dòng dạng JSON', 'success');
          } else if (action === 'copy-row-insert') {
            const cols = Object.keys(rowData).map(quoteId).join(', ');
            const vals = Object.values(rowData).map((v) => {
              if (v === null || v === undefined) return 'NULL';
              if (typeof v === 'number') return v;
              return quoteSqlString(v);
            }).join(', ');
            const insertSql = `INSERT INTO ${quoteId(table)} (${cols}) VALUES (${vals});`;
            await navigator.clipboard.writeText(insertSql);
            toast('Đã sao chép câu lệnh INSERT', 'success');
          } else if (action === 'set-cell-null') {
            const keys = {};
            for (const pk of app.primaryKey) keys[pk] = rowData[pk];
            try {
              await call(desktop.db.updateRow({
                database: app.database,
                table,
                keys,
                values: { [colName]: null }
              }));
              rowData[colName] = null;
              gridTd.className = 'nullcell cell-flash-saved';
              gridTd.innerHTML = '<span class="null-badge">NULL</span>';
              setTimeout(() => gridTd.classList.remove('cell-flash-saved'), 1500);
              toast(`Đã đặt "${colName}" thành NULL`, 'success');
            } catch (err) {
              toast(err.message, 'error');
            }
          } else if (action === 'edit-row') {
            editRow(rowIdx);
          } else if (action === 'delete-row') {
            const keys = {};
            for (const pk of app.primaryKey) keys[pk] = rowData[pk];
            const database = app.database;
            const targetTable = table;
            const confirmed = await confirmAction('Xóa dòng này?', 'Bản ghi sẽ bị xóa khỏi database.', 'Xóa');
            if (!confirmed) return;
            try {
              await call(desktop.db.deleteRows({ database, table: targetTable, keysList: [keys] }));
              toast('Đã xóa dòng thành công', 'success');
              await loadData({ keepScroll: true });
            } catch (err) {
              toast(err.message, 'error');
            }
          }
        });
      });
      return;
    }
  });

  const sidebar = $('.sidebar');
  if (!sidebar) return;

  sidebar.addEventListener('contextmenu', (event) => {
    const tableItem = event.target.closest('.treeitem[data-table]');
    const dbItem = event.target.closest('.database.dbitem[data-db]');
    const dbsHeading = event.target.closest('.sideheading');

    if (tableItem) {
      event.preventDefault();
      const tableName = tableItem.dataset.table;
      menu.innerHTML = `
        <div class="context-menu-item" data-action="open-table"><span class="c-icon">▦</span> Mở bảng (Dữ liệu)</div>
        <div class="context-menu-item" data-action="structure-table"><span class="c-icon">⌑</span> Xem cấu trúc bảng</div>
        <div class="context-menu-item" data-action="query-table"><span class="c-icon">⌘</span> Mở trong SQL Editor</div>
        <div class="context-menu-item" data-action="copy-name"><span class="c-icon">📋</span> Sao chép tên bảng</div>
        <div class="context-menu-sep"></div>
        <div class="context-menu-item danger" data-action="truncate-table"><span class="c-icon">⌫</span> Xóa sạch dữ liệu (Truncate)</div>
        <div class="context-menu-item danger" data-action="drop-table"><span class="c-icon">🗑</span> Xóa bảng (Drop Table)</div>
        <div class="context-menu-divider"></div>
        <div class="context-menu-item" data-action="optimize-table"><span class="c-icon">⚡</span> Tối ưu hóa bảng (OPTIMIZE)</div>
        <div class="context-menu-item" data-action="check-table"><span class="c-icon">🔍</span> Kiểm tra toàn vẹn (CHECK)</div>
        <div class="context-menu-item" data-action="analyze-table"><span class="c-icon">📊</span> Phân tích chỉ mục (ANALYZE)</div>
        <div class="context-menu-item" data-action="repair-table"><span class="c-icon">🔧</span> Sửa chữa bảng (REPAIR)</div>
      `;
      positionMenu(event.clientX, event.clientY);
      menu.querySelectorAll('.context-menu-item').forEach((item) => {
        item.addEventListener('click', () => {
          closeMenu();
          const act = item.dataset.action;
          if (act === 'open-table') selectTable(tableName, { mode: 'data' });
          else if (act === 'structure-table') selectTable(tableName, { mode: 'structure' });
          else if (act === 'query-table') newQuery(`SELECT * FROM ${quoteId(app.database)}.${quoteId(tableName)} LIMIT 100;`);
          else if (act === 'copy-name') { navigator.clipboard.writeText(tableName); toast('Đã sao chép: ' + tableName); }
          else if (act === 'truncate-table') truncateTableAction(tableName);
          else if (act === 'drop-table') dropTableAction(tableName);
          else if (act === 'optimize-table') runTableMaintenance(tableName, 'OPTIMIZE');
          else if (act === 'check-table') runTableMaintenance(tableName, 'CHECK');
          else if (act === 'analyze-table') runTableMaintenance(tableName, 'ANALYZE');
          else if (act === 'repair-table') runTableMaintenance(tableName, 'REPAIR');
        });
      });
      return;
    }

    if (dbItem) {
      event.preventDefault();
      const dbName = dbItem.dataset.db;
      menu.innerHTML = `
        <div class="context-menu-item" data-action="select-db"><span class="c-icon">▱</span> Chọn database này</div>
        <div class="context-menu-item" data-action="create-table"><span class="c-icon">＋</span> Tạo bảng mới</div>
        <div class="context-menu-item" data-action="backup-db"><span class="c-icon">⇩</span> Sao lưu database…</div>
        <div class="context-menu-item" data-action="restore-db"><span class="c-icon">⇧</span> Phục hồi database…</div>
        <div class="context-menu-sep"></div>
        <div class="context-menu-item danger" data-action="drop-db"><span class="c-icon">🗑</span> Xóa database (Drop)</div>
      `;
      positionMenu(event.clientX, event.clientY);
      menu.querySelectorAll('.context-menu-item').forEach((item) => {
        item.addEventListener('click', () => {
          closeMenu();
          const act = item.dataset.action;
          if (act === 'select-db') selectDatabase(dbName);
          else if (act === 'create-table') { selectDatabase(dbName).then(() => createTableModal()); }
          else if (act === 'backup-db') selectDatabase(dbName).then(() => { if (app.database === dbName) backupDatabase(); });
          else if (act === 'restore-db') selectDatabase(dbName).then(() => { if (app.database === dbName) restoreDatabase(); });
          else if (act === 'drop-db') dropDatabaseAction(dbName);
        });
      });
      return;
    }

    if (dbsHeading?.matches('[data-databases-heading]')) {
      event.preventDefault();
      menu.innerHTML = `
        <div class="context-menu-item" data-action="create-db"><span class="c-icon">＋</span> Tạo Database mới…</div>
        <div class="context-menu-item" data-action="refresh-dbs"><span class="c-icon">↻</span> Làm mới danh sách</div>
      `;
      positionMenu(event.clientX, event.clientY);
      menu.querySelectorAll('.context-menu-item').forEach((item) => {
        item.addEventListener('click', () => {
          closeMenu();
          if (item.dataset.action === 'create-db') createDatabaseModal();
          else refreshDatabases();
        });
      });
    }
  });

  function positionMenu(x, y) {
    menu.classList.remove('hidden');
    const maxX = window.innerWidth - menu.offsetWidth - 10;
    const maxY = window.innerHeight - menu.offsetHeight - 10;
    menu.style.left = Math.min(x, maxX) + 'px';
    menu.style.top = Math.min(y, maxY) + 'px';
  }
}


function activateSidebarItem(event) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  if (!event.target.matches('[role="button"][data-db], [role="button"][data-db-list], [role="button"][data-table]')) return;
  event.preventDefault();
  event.target.click();
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
  if (event.target.closest('#createDbBtn')) {
    createDatabaseModal();
    return;
  }
  if (event.target.closest('#createTableBtn')) {
    createTableModal();
    return;
  }
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
  app.orderBy = null;
  app.orderDir = 'ASC';
  renderSidebar();
  const nextMode = options.mode && options.mode !== 'history' ? options.mode : 'data';
  await view(nextMode);
  persistState();
}

async function loadData({ keepScroll = false } = {}) {
  if (!app.connection || !app.database || !table) {
    renderEmptyTable();
    return;
  }
  const requestId = ++dataRequestId;
  const database = app.database;
  const targetTable = table;
  const connectionId = app.connection.id;
  const box = keepScroll ? $('#grid .tablebox') : null;
  const scroll = box ? { left: box.scrollLeft, top: box.scrollTop } : null;
  if (box) box.classList.add('loading-soft');
  else workspaceLoading();
  updateChrome();
  try {
    const data = await call(desktop.db.tableData({
      database,
      table: targetTable,
      page: app.page,
      pageSize: app.pageSize,
      search: app.search,
      orderBy: app.orderBy,
      orderDir: app.orderDir
    }));
    if (requestId !== dataRequestId || database !== app.database || targetTable !== table || connectionId !== app.connection?.id || mode !== 'data') return;
    app.columns = data.columns;
    app.primaryKey = data.primaryKey;
    app.rows = data.rows;
    app.total = data.total;
    app.page = data.page;
    app.pageSize = data.pageSize;
    renderDataView();
    if (scroll) {
      const nextBox = $('#grid .tablebox');
      if (nextBox) { nextBox.scrollLeft = scroll.left; nextBox.scrollTop = scroll.top; }
    }
    setStatus(`Đã tải ${data.rows.length} dòng • ${app.database}.${table}`);
  } catch (error) {
    if (requestId === dataRequestId && mode === 'data' && database === app.database && targetTable === table && connectionId === app.connection?.id) renderError(error);
  } finally {
    box?.classList.remove('loading-soft');
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
  $('#eyebrow').textContent = `${(app.database || 'CHƯA CHỌN DATABASE').toUpperCase()} / ${mode === 'query' ? 'TRUY VẤN' : mode === 'history' ? 'LỊCH SỬ' : 'BẢNG'}`;
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
  $('#crumbServer').textContent = app.connection ? `${app.serverType === 'mariadb' ? 'MARIADB' : 'MYSQL'}${app.server ? ` ${app.server}` : ''}` : 'CHƯA KẾT NỐI';
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


async function inlineEditCell(td) {
  if (!td || td.classList.contains('editing-cell')) return;
  const colName = td.dataset.col;
  const rowIdx = Number(td.dataset.row);
  if (!colName || isNaN(rowIdx) || !app.rows[rowIdx]) return;

  if (!app.primaryKey || !app.primaryKey.length) {
    toast('Bảng không có khóa chính nên không thể sửa trực tiếp.', 'error');
    return;
  }

  const colMeta = (app.columns || []).find((c) => c.name === colName);
  if (colMeta && /(virtual|stored) generated/i.test(colMeta.extra)) {
    toast(`Cột "${colName}" là cột tự động tính toán (generated), không thể sửa.`, 'error');
    return;
  }

  const rowData = app.rows[rowIdx];
  const database = app.database;
  const targetTable = table;
  const keys = Object.fromEntries(app.primaryKey.map((pk) => [pk, rowData[pk]]));
  const originalVal = rowData[colName];
  const originalDisplay = td.innerHTML;
  td.classList.add('editing-cell');

  const cellHeight = td.offsetHeight || 0;
  const initialHeight = Math.max(cellHeight, 38);

  const input = document.createElement('textarea');
  input.className = 'inline-cell-editor';
  input.value = originalVal === null || originalVal === undefined ? '' : String(originalVal);
  input.style.minHeight = `${initialHeight}px`;
  input.style.height = `${initialHeight}px`;
  input.placeholder = (colMeta && colMeta.nullable === 'YES') ? 'Gõ NULL để gán null...' : 'Nhập giá trị...';
  input.title = 'Enter: Lưu · Esc: Hủy · Shift+Enter: Xuống dòng';

  const autoResize = () => {
    input.style.height = 'auto';
    const nextHeight = Math.min(Math.max(input.scrollHeight, initialHeight), 220);
    input.style.height = `${nextHeight}px`;
  };
  input.addEventListener('input', autoResize);

  td.innerHTML = '';
  td.appendChild(input);
  autoResize();
  input.focus();
  input.select();

  let committed = false;
  const cancel = () => {
    if (committed) return;
    committed = true;
    td.classList.remove('editing-cell');
    td.innerHTML = originalDisplay;
  };

  const commit = async () => {
    if (committed) return;
    committed = true;
    const newVal = input.value;
    const isOriginalNull = originalVal === null || originalVal === undefined;
    const isUnchanged = (isOriginalNull && newVal === '') || (!isOriginalNull && String(originalVal) === newVal);

    if (isUnchanged) {
      td.classList.remove('editing-cell');
      td.innerHTML = originalDisplay;
      return;
    }

    let valToSave = newVal;
    if (colMeta && colMeta.nullable === 'YES' && newVal.toUpperCase() === 'NULL') {
      valToSave = null;
    }

    try {
      await call(desktop.db.updateRow({
        database,
        table: targetTable,
        keys,
        values: { [colName]: valToSave }
      }));

      rowData[colName] = valToSave;
      td.classList.remove('editing-cell');
      const isNull = valToSave === null || valToSave === undefined;
      const text = isNull ? 'NULL' : String(valToSave);
      const shown = text.length > 180 ? `${text.slice(0, 180)}…` : text;
      td.className = `${isNull ? 'nullcell ' : ''}cell-flash-saved`;
      td.title = text.slice(0, 500);
      td.innerHTML = isNull ? '<span class="null-badge">NULL</span>' : esc(shown);
      setTimeout(() => td.classList.remove('cell-flash-saved'), 1500);
      toast(`Đã lưu cột "${colName}"`, 'success');
    } catch (err) {
      td.classList.remove('editing-cell');
      td.innerHTML = originalDisplay;
      toast(err.message || 'Lỗi khi cập nhật dữ liệu', 'error');
    }
  };

  input.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' && !e.shiftKey) || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      commit().then(() => {
        const targetCell = e.shiftKey ? td.previousElementSibling : td.nextElementSibling;
        if (targetCell && targetCell.dataset && targetCell.dataset.col) {
          inlineEditCell(targetCell);
        }
      });
    }
  });

  input.addEventListener('blur', () => {
    commit();
  });
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
    const td = event.target.closest('td[data-col]');
    if (td) {
      inlineEditCell(td);
      return;
    }
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
      ${app.columns.map((column) => {
        const isSorted = app.orderBy === column.name;
        const sortClass = isSorted ? (app.orderDir === 'ASC' ? 'sortable sorted-asc' : 'sortable sorted-desc') : 'sortable';
        const sortArrow = isSorted ? (app.orderDir === 'ASC' ? '<span class="sort-arrow">▲</span>' : '<span class="sort-arrow">▼</span>') : '';
        return `<th class="${sortClass}" data-sort="${esc(column.name)}" title="Bấm để sắp xếp theo cột ${esc(column.name)}">${esc(column.name)} <small>${esc(column.type)}</small>${sortArrow}</th>`;
      }).join('')}
    </tr>
  `;
  const body = app.rows.map((row, index) => `
    <tr data-row="${index}">
      <td>${editable ? `<input class="rowcheck" type="checkbox" value="${index}" aria-label="Chọn bản ghi ${index + 1}">` : ''}</td>
      ${app.columns.map((column) => {
        const value = row[column.name];
        const isNull = value === null || value === undefined;
        const text = isNull ? 'NULL' : String(value);
        const shown = text.length > 180 ? `${text.slice(0, 180)}…` : text;
        const cellDisplay = isNull ? '<span class="null-badge">NULL</span>' : esc(shown);
        return `<td class="${isNull ? 'nullcell' : ''}" data-row="${index}" data-col="${esc(column.name)}" title="${esc(text.slice(0, 500))}">${cellDisplay}</td>`;
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
  document.querySelectorAll('th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (app.orderBy === col) {
        if (app.orderDir === 'ASC') {
          app.orderDir = 'DESC';
        } else {
          app.orderBy = null;
          app.orderDir = 'ASC';
        }
      } else {
        app.orderBy = col;
        app.orderDir = 'ASC';
      }
      app.page = 1;
      loadData({ keepScroll: true });
    });
  });
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


function addColumnModal(targetTable) {
  const currentTable = targetTable || table;
  const database = app.database;
  if (!desktop || !app.connection || !app.database || !currentTable) return;

  const cols = app.columns || [];
  const colOptions = cols.map((c) => `<option value="${esc(c.name)}">Sau cột: ${esc(c.name)}</option>`).join('');

  modal(`
    <div class="modal-card" style="max-width:540px;">
      <div class="modal-header">
        <h3>➕ Thêm Cột Mới Vào Bảng "${esc(currentTable)}"</h3>
        <button class="close-btn" onclick="closeModal()">✕</button>
      </div>
      <div class="modal-body" style="padding:16px;">
        <div class="form-group" style="margin-bottom:12px;">
          <label style="display:block; margin-bottom:4px; font-weight:500;">Tên cột:</label>
          <input type="text" id="newColName" placeholder="vd: phone_number, status..." style="width:100%; padding:7px 10px; background:#111827; border:1px solid #374151; border-radius:4px; color:#fff;" required>
        </div>
        <div style="display:flex; gap:12px; margin-bottom:12px;">
          <div style="flex:1;">
            <label style="display:block; margin-bottom:4px; font-weight:500;">Kiểu dữ liệu:</label>
            <select id="newColType" style="width:100%; padding:7px 10px; background:#111827; border:1px solid #374151; border-radius:4px; color:#fff;">
              <option value="INT">INT</option>
              <option value="BIGINT">BIGINT</option>
              <option value="VARCHAR(255)" selected>VARCHAR(255)</option>
              <option value="TEXT">TEXT</option>
              <option value="LONGTEXT">LONGTEXT</option>
              <option value="TINYINT(1)">TINYINT(1) (Boolean)</option>
              <option value="DECIMAL(10,2)">DECIMAL(10,2)</option>
              <option value="DATETIME">DATETIME</option>
              <option value="TIMESTAMP">TIMESTAMP</option>
              <option value="DATE">DATE</option>
              <option value="JSON">JSON</option>
            </select>
          </div>
          <div style="flex:1;">
            <label style="display:block; margin-bottom:4px; font-weight:500;">Vị trí cột:</label>
            <select id="newColPos" style="width:100%; padding:7px 10px; background:#111827; border:1px solid #374151; border-radius:4px; color:#fff;">
              <option value="">Cuối bảng (Mặc định)</option>
              <option value="FIRST">Đầu bảng (FIRST)</option>
              ${colOptions}
            </select>
          </div>
        </div>
        <div style="display:flex; gap:12px; margin-bottom:12px;">
          <div style="flex:1;">
            <label style="display:block; margin-bottom:4px; font-weight:500;">Giá trị mặc định:</label>
            <input type="text" id="newColDefault" placeholder="NULL hoặc giá trị mặc định" style="width:100%; padding:7px 10px; background:#111827; border:1px solid #374151; border-radius:4px; color:#fff;">
          </div>
          <div style="flex:1; display:flex; align-items:center; gap:8px; margin-top:20px;">
            <input type="checkbox" id="newColNullable" checked>
            <label for="newColNullable">Cho phép NULL</label>
          </div>
        </div>
      </div>
      <div class="modal-footer" style="text-align: right; margin-top: 16px;">
        <button onclick="closeModal()">Hủy</button>
        <button class="primary" id="confirmAddColBtn">➕ Thêm cột</button>
      </div>
    </div>
  `);

  $('#confirmAddColBtn')?.addEventListener('click', async () => {
    const colName = $('#newColName')?.value.trim();
    if (!colName) {
      toast('Vui lòng nhập tên cột.', 'error');
      return;
    }
    const colType = $('#newColType')?.value || 'VARCHAR(255)';
    const pos = $('#newColPos')?.value;
    const isNullable = $('#newColNullable')?.checked;
    const defVal = $('#newColDefault')?.value.trim();

    let sql = `ALTER TABLE ${quoteId(database)}.${quoteId(currentTable)} ADD COLUMN ${quoteId(colName)} ${colType}`;
    if (!isNullable) sql += ' NOT NULL';
    if (defVal) {
      if (defVal.toUpperCase() === 'NULL' || defVal.toUpperCase() === 'CURRENT_TIMESTAMP') {
        sql += ` DEFAULT ${defVal}`;
      } else {
        sql += ` DEFAULT ${quoteSqlString(defVal)}`;
      }
    }
    if (pos === 'FIRST') {
      sql += ' FIRST';
    } else if (pos) {
      sql += ` AFTER ${quoteId(pos)}`;
    }

    try {
      await call(desktop.db.query({ sql, confirmed: true }));
      toast(`Đã thêm cột "${colName}" vào bảng ${currentTable}`, 'success');
      closeModal();
      view('structure');
    } catch (err) {
      toast(err.message || 'Lỗi khi thêm cột', 'error');
    }
  });
}

function modifyColumnModal(targetTable, colName) {
  const currentTable = targetTable || table;
  const database = app.database;
  const colMeta = (app.columns || []).find((c) => c.name === colName);
  if (!colMeta) return;
  if (/(virtual|stored) generated/i.test(colMeta.extra)) {
    toast('Hãy sửa biểu thức cột generated bằng SQL Editor.', 'error');
    return;
  }

  modal(`
    <div class="modal-card" style="max-width:540px;">
      <div class="modal-header">
        <h3>✏️ Sửa Kiểu / Thuộc Tính Cột "${esc(colName)}"</h3>
        <button class="close-btn" onclick="closeModal()">✕</button>
      </div>
      <div class="modal-body" style="padding:16px;">
        <div style="display:flex; gap:12px; margin-bottom:12px;">
          <div style="flex:1;">
            <label style="display:block; margin-bottom:4px; font-weight:500;">Kiểu dữ liệu mới:</label>
            <input type="text" id="modColType" value="${esc(colMeta.type)}" style="width:100%; padding:7px 10px; background:#111827; border:1px solid #374151; border-radius:4px; color:#fff;" required>
          </div>
          <div style="flex:1;">
            <label style="display:block; margin-bottom:4px; font-weight:500;">Giá trị mặc định:</label>
            <input type="text" id="modColDefault" value="${esc(colMeta.defaultValue === null ? '' : String(colMeta.defaultValue))}" style="width:100%; padding:7px 10px; background:#111827; border:1px solid #374151; border-radius:4px; color:#fff;">
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:12px;">
          <input type="checkbox" id="modColNullable" ${colMeta.nullable === 'YES' ? 'checked' : ''}>
          <label for="modColNullable">Cho phép NULL</label>
        </div>
      </div>
      <div class="modal-footer" style="text-align: right; margin-top: 16px;">
        <button onclick="closeModal()">Hủy</button>
        <button class="primary" id="confirmModColBtn">Lưu thay đổi</button>
      </div>
    </div>
  `);

  $('#confirmModColBtn')?.addEventListener('click', async () => {
    const colType = $('#modColType')?.value.trim();
    if (!colType) {
      toast('Vui lòng nhập kiểu dữ liệu.', 'error');
      return;
    }
    const isNullable = $('#modColNullable')?.checked;
    const defVal = $('#modColDefault')?.value.trim();

    let sql = `ALTER TABLE ${quoteId(database)}.${quoteId(currentTable)} MODIFY COLUMN ${quoteId(colName)} ${colType}`;
    if (!isNullable) sql += ' NOT NULL';
    if (defVal) {
      if (defVal.toUpperCase() === 'NULL' || defVal.toUpperCase() === 'CURRENT_TIMESTAMP') {
        sql += ` DEFAULT ${defVal}`;
      } else {
        sql += ` DEFAULT ${quoteSqlString(defVal)}`;
      }
    } else if (colMeta.defaultValue === '') {
      sql += " DEFAULT ''";
    }
    if (/auto_increment/i.test(colMeta.extra)) sql += ' AUTO_INCREMENT';
    const onUpdate = /\bon update current_timestamp(?:\(\d*\))?/i.exec(colMeta.extra);
    if (onUpdate) sql += ` ${onUpdate[0]}`;
    if (/\binvisible\b/i.test(colMeta.extra)) sql += ' INVISIBLE';
    if (colMeta.comment) sql += ` COMMENT ${quoteSqlString(colMeta.comment)}`;

    try {
      await call(desktop.db.query({ sql, confirmed: true }));
      toast(`Đã sửa thuộc tính cột "${colName}"`, 'success');
      closeModal();
      view('structure');
    } catch (err) {
      toast(err.message || 'Lỗi khi sửa cột', 'error');
    }
  });
}

function renameColumnModal(targetTable, oldName) {
  const currentTable = targetTable || table;
  const database = app.database;
  modal(`
    <div class="modal-card" style="max-width:440px;">
      <div class="modal-header">
        <h3>🏷️ Đổi Tên Cột "${esc(oldName)}"</h3>
        <button class="close-btn" onclick="closeModal()">✕</button>
      </div>
      <div class="modal-body" style="padding:16px;">
        <div class="form-group">
          <label style="display:block; margin-bottom:4px; font-weight:500;">Tên mới:</label>
          <input type="text" id="renamedColName" value="${esc(oldName)}" style="width:100%; padding:7px 10px; background:#111827; border:1px solid #374151; border-radius:4px; color:#fff;" required>
        </div>
      </div>
      <div class="modal-footer" style="text-align: right; margin-top: 16px;">
        <button onclick="closeModal()">Hủy</button>
        <button class="primary" id="confirmRenameColBtn">Đổi tên</button>
      </div>
    </div>
  `);

  $('#confirmRenameColBtn')?.addEventListener('click', async () => {
    const newName = $('#renamedColName')?.value.trim();
    if (!newName || newName === oldName) {
      closeModal();
      return;
    }
    try {
      await call(desktop.db.query({ sql: `ALTER TABLE ${quoteId(database)}.${quoteId(currentTable)} RENAME COLUMN ${quoteId(oldName)} TO ${quoteId(newName)}`, confirmed: true }));
      toast(`Đã đổi tên cột thành "${newName}"`, 'success');
      closeModal();
      view('structure');
    } catch (err) {
      toast(err.message || 'Lỗi khi đổi tên cột', 'error');
    }
  });
}

async function dropColumnAction(targetTable, colName) {
  const currentTable = targetTable || table;
  const database = app.database;
  const confirmed = await confirmAction(`Xóa cột "${colName}" khỏi bảng "${currentTable}"?`, 'Dữ liệu trong cột này sẽ bị mất vĩnh viễn!', 'Xóa cột');
  if (!confirmed) return;
  try {
    await call(desktop.db.query({ sql: `ALTER TABLE ${quoteId(database)}.${quoteId(currentTable)} DROP COLUMN ${quoteId(colName)}`, confirmed: true }));
    toast(`Đã xóa cột "${colName}"`, 'success');
    await view('structure');
  } catch (err) {
    toast(err.message || 'Lỗi khi xóa cột', 'error');
  }
}

function createIndexModal(targetTable) {
  const currentTable = targetTable || table;
  const database = app.database;
  if (!currentTable) return;
  const cols = app.columns || [];

  modal(`
    <div class="modal-card" style="max-width:540px;">
      <div class="modal-header">
        <h3>➕ Thêm Chỉ Mục (Index) Mới</h3>
        <button class="close-btn" onclick="closeModal()">✕</button>
      </div>
      <div class="modal-body" style="padding:16px;">
        <div style="display:flex; gap:12px; margin-bottom:12px;">
          <div style="flex:1;">
            <label style="display:block; margin-bottom:4px; font-weight:500;">Tên Index:</label>
            <input type="text" id="newIndexName" placeholder="vd: idx_user_email" style="width:100%; padding:7px 10px; background:#111827; border:1px solid #374151; border-radius:4px; color:#fff;" required>
          </div>
          <div style="flex:1;">
            <label style="display:block; margin-bottom:4px; font-weight:500;">Loại Index:</label>
            <select id="newIndexType" style="width:100%; padding:7px 10px; background:#111827; border:1px solid #374151; border-radius:4px; color:#fff;">
              <option value="INDEX">INDEX (Bình thường)</option>
              <option value="UNIQUE">UNIQUE (Không trùng lặp)</option>
              <option value="FULLTEXT">FULLTEXT (Tìm kiếm văn bản)</option>
            </select>
          </div>
        </div>
        <div>
          <label style="display:block; margin-bottom:6px; font-weight:500;">Chọn các cột tham gia Index:</label>
          <div style="max-height: 180px; overflow: auto; background:#111827; border:1px solid #374151; border-radius:4px; padding:8px;">
            ${cols.map((c) => `
              <label style="display:flex; align-items:center; gap:8px; padding:3px 0; cursor:pointer;">
                <input type="checkbox" class="index-col-check" value="${esc(c.name)}">
                <span>${esc(c.name)} <small style="color:#9ca3af;">(${esc(c.type)})</small></span>
              </label>
            `).join('')}
          </div>
        </div>
      </div>
      <div class="modal-footer" style="text-align: right; margin-top: 16px;">
        <button onclick="closeModal()">Hủy</button>
        <button class="primary" id="confirmCreateIndexBtn">Tạo Index</button>
      </div>
    </div>
  `);

  $('#confirmCreateIndexBtn')?.addEventListener('click', async () => {
    const idxName = $('#newIndexName')?.value.trim();
    const idxType = $('#newIndexType')?.value || 'INDEX';
    const selectedCols = [...document.querySelectorAll('.index-col-check:checked')].map((cb) => cb.value);

    if (!idxName) {
      toast('Vui lòng nhập tên Index.', 'error');
      return;
    }
    if (!selectedCols.length) {
      toast('Vui lòng chọn ít nhất một cột.', 'error');
      return;
    }

    const typePrefix = idxType === 'UNIQUE' ? 'UNIQUE ' : (idxType === 'FULLTEXT' ? 'FULLTEXT ' : '');
    const sql = `CREATE ${typePrefix}INDEX ${quoteId(idxName)} ON ${quoteId(database)}.${quoteId(currentTable)} (${selectedCols.map(quoteId).join(', ')})`;

    try {
      await call(desktop.db.query({ sql, confirmed: true }));
      toast(`Đã tạo Index "${idxName}" thành công`, 'success');
      closeModal();
      view('indexes');
    } catch (err) {
      toast(err.message || 'Lỗi khi tạo Index', 'error');
    }
  });
}

async function dropIndexAction(indexName) {
  if (!table) return;
  const target = `${quoteId(app.database)}.${quoteId(table)}`;
  const confirmed = await confirmAction(`Xóa Index "${indexName}"?`, 'Thao tác này có thể ảnh hưởng đến tốc độ truy vấn.', 'Xóa Index');
  if (!confirmed) return;
  try {
    await call(desktop.db.query({ sql: `DROP INDEX ${quoteId(indexName)} ON ${target}`, confirmed: true }));
    toast(`Đã xóa Index "${indexName}"`, 'success');
    await view('indexes');
  } catch (err) {
    toast(err.message || 'Lỗi khi xóa Index', 'error');
  }
}

async function createRelationModal(targetTable) {
  const currentTable = targetTable || table;
  const database = app.database;
  if (!currentTable || !desktop || !app.database) return;

  const cols = app.columns || [];
  let tablesList = [];
  try {
    tablesList = await call(desktop.db.tables(database));
  } catch (err) {
    tablesList = [];
  }

  modal(`
    <div class="modal-card" style="max-width:580px;">
      <div class="modal-header">
        <h3>➕ Thêm Khóa Ngoại (Foreign Key)</h3>
        <button class="close-btn" onclick="closeModal()">✕</button>
      </div>
      <div class="modal-body" style="padding:16px;">
        <div style="margin-bottom:12px;">
          <label style="display:block; margin-bottom:4px; font-weight:500;">Tên Khóa ngoại (Constraint Name):</label>
          <input type="text" id="newFkName" placeholder="vd: fk_${esc(currentTable)}_ref" style="width:100%; padding:7px 10px; background:#111827; border:1px solid #374151; border-radius:4px; color:#fff;" required>
        </div>
        <div style="display:flex; gap:12px; margin-bottom:12px;">
          <div style="flex:1;">
            <label style="display:block; margin-bottom:4px; font-weight:500;">Cột bảng hiện tại (${esc(currentTable)}):</label>
            <select id="fkLocalCol" style="width:100%; padding:7px 10px; background:#111827; border:1px solid #374151; border-radius:4px; color:#fff;">
              ${cols.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('')}
            </select>
          </div>
          <div style="flex:1;">
            <label style="display:block; margin-bottom:4px; font-weight:500;">Bảng tham chiếu (Ref Table):</label>
            <select id="fkRefTable" style="width:100%; padding:7px 10px; background:#111827; border:1px solid #374151; border-radius:4px; color:#fff;">
              ${tablesList.map((t) => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div style="margin-bottom:12px;">
          <label style="display:block; margin-bottom:4px; font-weight:500;">Cột tham chiếu (Ref Column):</label>
          <input type="text" id="fkRefCol" placeholder="vd: id" value="id" style="width:100%; padding:7px 10px; background:#111827; border:1px solid #374151; border-radius:4px; color:#fff;" required>
        </div>
        <div style="display:flex; gap:12px; margin-bottom:12px;">
          <div style="flex:1;">
            <label style="display:block; margin-bottom:4px; font-weight:500;">ON DELETE:</label>
            <select id="fkOnDelete" style="width:100%; padding:7px 10px; background:#111827; border:1px solid #374151; border-radius:4px; color:#fff;">
              <option value="RESTRICT">RESTRICT (Chặn xóa)</option>
              <option value="CASCADE">CASCADE (Xóa theo)</option>
              <option value="SET NULL">SET NULL (Gán NULL)</option>
              <option value="NO ACTION">NO ACTION</option>
            </select>
          </div>
          <div style="flex:1;">
            <label style="display:block; margin-bottom:4px; font-weight:500;">ON UPDATE:</label>
            <select id="fkOnUpdate" style="width:100%; padding:7px 10px; background:#111827; border:1px solid #374151; border-radius:4px; color:#fff;">
              <option value="CASCADE" selected>CASCADE (Cập nhật theo)</option>
              <option value="RESTRICT">RESTRICT (Chặn sửa)</option>
              <option value="SET NULL">SET NULL (Gán NULL)</option>
              <option value="NO ACTION">NO ACTION</option>
            </select>
          </div>
        </div>
      </div>
      <div class="modal-footer" style="text-align: right; margin-top: 16px;">
        <button onclick="closeModal()">Hủy</button>
        <button class="primary" id="confirmCreateFkBtn">Tạo Khóa Ngoại</button>
      </div>
    </div>
  `);

  $('#confirmCreateFkBtn')?.addEventListener('click', async () => {
    const fkName = $('#newFkName')?.value.trim();
    const localCol = $('#fkLocalCol')?.value;
    const refTable = $('#fkRefTable')?.value;
    const refCol = $('#fkRefCol')?.value.trim();
    const onDel = $('#fkOnDelete')?.value || 'RESTRICT';
    const onUpd = $('#fkOnUpdate')?.value || 'CASCADE';

    if (!fkName || !localCol || !refTable || !refCol) {
      toast('Vui lòng điền đầy đủ các thông tin.', 'error');
      return;
    }

    const sql = `ALTER TABLE ${quoteId(database)}.${quoteId(currentTable)} ADD CONSTRAINT ${quoteId(fkName)} FOREIGN KEY (${quoteId(localCol)}) REFERENCES ${quoteId(database)}.${quoteId(refTable)}(${quoteId(refCol)}) ON DELETE ${onDel} ON UPDATE ${onUpd}`;

    try {
      await call(desktop.db.query({ sql, confirmed: true }));
      toast(`Đã tạo Khóa ngoại "${fkName}" thành công`, 'success');
      closeModal();
      view('relations');
    } catch (err) {
      toast(err.message || 'Lỗi khi tạo Khóa ngoại', 'error');
    }
  });
}

async function dropRelationAction(constraintName) {
  if (!table) return;
  const target = `${quoteId(app.database)}.${quoteId(table)}`;
  const confirmed = await confirmAction(`Xóa Khóa ngoại "${constraintName}"?`, 'Bảng sẽ không còn kiểm tra ràng buộc tham chiếu này.', 'Xóa khóa ngoại');
  if (!confirmed) return;
  try {
    await call(desktop.db.query({ sql: `ALTER TABLE ${target} DROP FOREIGN KEY ${quoteId(constraintName)}`, confirmed: true }));
    toast(`Đã xóa Khóa ngoại "${constraintName}"`, 'success');
    await view('relations');
  } catch (err) {
    toast(err.message || 'Lỗi khi xóa Khóa ngoại', 'error');
  }
}

function renderStructureView() {
  $('#workspace').innerHTML = `
    <div class="toolbar">
      <strong>${app.columns.length} cột</strong>
      <button class="primary" id="addColBtn" style="margin-left:12px;">➕ Thêm cột</button>
      <span class="spacer"></span>
      <button id="refreshStructure">↻ Làm mới</button>
      <button id="showDdl">⌑ Xem DDL</button>
      <button id="openInEditor">⌘ Mở SQL Editor</button>
    </div>
    <div class="tablebox"><table>
      <thead><tr><th></th><th>Tên cột</th><th>Kiểu dữ liệu</th><th>Null</th><th>Mặc định</th><th>Khóa</th><th>Extra</th><th style="width:130px; text-align:center;">Hành động</th></tr></thead>
      <tbody>
        ${app.columns.map((column) => `
          <tr>
            <td></td>
            <td class="mono"><strong>${esc(column.name)}</strong></td>
            <td class="mono">${esc(column.type)}</td>
            <td>${column.nullable === 'YES' ? 'YES' : 'NO'}</td>
            <td class="muted">${column.defaultValue === null ? 'NULL' : esc(column.defaultValue)}</td>
            <td>${column.key === 'PRI' ? '🔑 PRIMARY' : column.key === 'UNI' ? 'UNIQUE' : column.key === 'MUL' ? 'INDEX' : '—'}</td>
            <td class="muted">${esc(column.extra || '')}</td>
            <td style="text-align:center; white-space:nowrap;">
              <button class="struct-action-btn" data-action="modify" data-col="${esc(column.name)}" title="Sửa kiểu / thuộc tính" style="padding:2px 6px; font-size:0.75em;">✏️</button>
              <button class="struct-action-btn" data-action="rename" data-col="${esc(column.name)}" title="Đổi tên cột" style="padding:2px 6px; font-size:0.75em;">🏷️</button>
              <button class="danger struct-action-btn" data-action="drop" data-col="${esc(column.name)}" title="Xóa cột" style="padding:2px 6px; font-size:0.75em;">🗑️</button>
            </td>
          </tr>
        `).join('') || '<tr><td colspan="8" class="empty">Không có cột.</td></tr>'}
      </tbody>
    </table></div>
  `;
  $('#refreshStructure').addEventListener('click', () => view('structure'));
  $('#showDdl').addEventListener('click', showDdl);
  $('#openInEditor').addEventListener('click', openTableInEditor);
  $('#addColBtn')?.addEventListener('click', () => addColumnModal(table));
  document.querySelectorAll('.struct-action-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.action;
      const col = btn.dataset.col;
      if (act === 'modify') modifyColumnModal(table, col);
      else if (act === 'rename') renameColumnModal(table, col);
      else if (act === 'drop') dropColumnAction(table, col);
    });
  });
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
      <button class="primary" id="addIndexBtn" style="margin-left:12px;">➕ Thêm Index</button>
      <span class="spacer"></span>
      <button id="refreshIndexes">↻ Làm mới</button>
    </div>
    <div class="tablebox"><table>
      <thead><tr><th></th><th>Tên index</th><th>Cột</th><th>Loại</th><th>Unique</th><th>Cardinality</th><th style="width:90px; text-align:center;">Hành động</th></tr></thead>
      <tbody>
        ${indexes.map((index) => `
          <tr>
            <td></td>
            <td class="mono"><strong>${esc(index.name)}</strong></td>
            <td class="mono">${index.columns.map((column) => esc(column.name)).join(', ')}</td>
            <td>${esc(index.type)}</td>
            <td>${index.unique ? 'YES' : 'NO'}</td>
            <td class="muted">${index.cardinality === null ? 'NULL' : index.cardinality}</td>
            <td style="text-align:center;">
              ${index.name !== 'PRIMARY' ? `<button class="danger drop-index-btn" data-index="${esc(index.name)}" style="padding:2px 8px; font-size:0.75em;" title="Xóa Index">🗑️ Xóa</button>` : '<span style="color:#6b7280; font-size:0.8em;">Khóa chính</span>'}
            </td>
          </tr>
        `).join('') || '<tr><td colspan="7" class="empty">Không có index.</td></tr>'}
      </tbody>
    </table></div>
  `;
  $('#refreshIndexes').addEventListener('click', () => view('indexes'));
  $('#addIndexBtn')?.addEventListener('click', () => createIndexModal(table));
  document.querySelectorAll('.drop-index-btn').forEach((btn) => {
    btn.addEventListener('click', () => dropIndexAction(btn.dataset.index));
  });
}

function renderRelationsView() {
  const outbound = app.relations?.outbound || [];
  const inbound = app.relations?.inbound || [];
  const relationRow = (relation, direction) => `
    <tr>
      <td>${esc(direction)}</td>
      <td class="mono"><strong>${esc(relation.table)}.${esc(relation.column)}</strong></td>
      <td>→</td>
      <td class="mono">${esc(relation.refDatabase)}.${esc(relation.refTable)}.${esc(relation.refColumn)}</td>
      <td class="muted">${esc(relation.name)}</td>
      <td style="text-align:center;">
        ${direction === 'Đi' ? `<button class="danger drop-fk-btn" data-fk="${esc(relation.name)}" style="padding:2px 8px; font-size:0.75em;" title="Xóa Khóa ngoại">🗑️</button>` : ''}
      </td>
    </tr>
  `;
  const rows = [
    ...outbound.map((relation) => relationRow(relation, 'Đi')),
    ...inbound.map((relation) => relationRow(relation, 'Đến'))
  ].join('');
  $('#workspace').innerHTML = `
    <div class="toolbar">
      <strong>${outbound.length + inbound.length} quan hệ</strong>
      <button class="primary" id="addRelationBtn" style="margin-left:12px;">➕ Thêm Khóa ngoại</button>
      <span class="spacer"></span>
      <button id="refreshRelations">↻ Làm mới</button>
    </div>
    <div class="tablebox"><table>
      <thead><tr><th>Hướng</th><th>Bảng.cột</th><th></th><th>Tham chiếu</th><th>Constraint</th><th style="width:80px; text-align:center;">Hành động</th></tr></thead>
      <tbody>
        ${rows || '<tr><td colspan="6" class="empty">Không có khóa ngoại.</td></tr>'}
      </tbody>
    </table></div>
  `;
  $('#refreshRelations').addEventListener('click', () => view('relations'));
  $('#addRelationBtn')?.addEventListener('click', () => createRelationModal(table));
  document.querySelectorAll('.drop-fk-btn').forEach((btn) => {
    btn.addEventListener('click', () => dropRelationAction(btn.dataset.fk));
  });
}


function tokenizeSql(sql) {
  const tokens = [];
  for (let i = 0; i < sql.length;) {
    const start = i;
    const char = sql[i];
    let type;
    if (/\s/.test(char)) {
      while (i < sql.length && /\s/.test(sql[i])) i += 1;
      type = 'space';
    } else if (char === '#' || (char === '-' && sql[i + 1] === '-' && (i + 2 === sql.length || sql.charCodeAt(i + 2) <= 32))) {
      while (i < sql.length && !/[\r\n]/.test(sql[i])) i += 1;
      type = 'lineComment';
    } else if (char === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) throw new Error('SQL không hợp lệ: block comment chưa được đóng.');
      i = end + 2;
      type = 'comment';
    } else if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      i += 1;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === '\\' && quote !== '`') i += Math.min(2, sql.length - i);
        else if (sql[i] === quote) {
          i += 1;
          if (sql[i] === quote) i += 1;
          else { closed = true; break; }
        } else i += 1;
      }
      if (!closed) throw new Error('SQL không hợp lệ: chuỗi hoặc identifier chưa được đóng.');
      type = 'literal';
    } else if (/[\p{L}\p{N}_$]/u.test(char)) {
      while (i < sql.length && /[\p{L}\p{N}_$]/u.test(sql[i])) i += 1;
      type = 'word';
    } else {
      i += 1;
      type = 'symbol';
    }
    tokens.push({ type, text: sql.slice(start, i) });
  }
  return tokens;
}

function formatSql(sql) {
  if (!sql || typeof sql !== 'string') return sql;

  const KEYWORDS = new Set([
    'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'BETWEEN',
    'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'ON', 'USING',
    'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET',
    'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
    'CREATE', 'TABLE', 'ALTER', 'DROP', 'INDEX', 'VIEW', 'DATABASE',
    'UNION', 'ALL', 'DISTINCT', 'AS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
    'ASC', 'DESC', 'SHOW', 'DESCRIBE', 'EXPLAIN', 'DEFAULT', 'PRIMARY', 'KEY',
    'FOREIGN', 'REFERENCES', 'AUTO_INCREMENT', 'CONSTRAINT', 'CASCADE'
  ]);

  const clauses = [
    'INSERT INTO', 'DELETE FROM', 'LEFT OUTER JOIN', 'RIGHT OUTER JOIN',
    'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'CROSS JOIN', 'GROUP BY', 'ORDER BY',
    'UNION ALL', 'SELECT', 'JOIN', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'VALUES', 'UPDATE', 'SET', 'FROM', 'WHERE'
  ].map((clause) => clause.split(' '));
  const tokens = tokenizeSql(sql);
  const output = [];
  let clauseEnd = -1;
  const newline = (text = '\n') => {
    while (output.length && /^\s+$/.test(output[output.length - 1])) output.pop();
    if (output.length) output.push(text);
  };
  tokens.forEach((token, index) => {
    if (token.type === 'space') {
      if (output.length && !/\s$/.test(output[output.length - 1])) output.push(' ');
      return;
    }
    if (token.type === 'word' && index > clauseEnd) {
      for (const words of clauses) {
        let cursor = index;
        const matches = words.every((word, offset) => {
          if (offset) {
            if (tokens[cursor]?.type !== 'space') return false;
            cursor += 1;
          }
          if (tokens[cursor]?.type !== 'word' || tokens[cursor].text.toUpperCase() !== word) return false;
          cursor += 1;
          return true;
        });
        if (matches) { newline(); clauseEnd = cursor - 1; break; }
      }
    }
    output.push(token.type === 'word' && KEYWORDS.has(token.text.toUpperCase()) ? token.text.toUpperCase() : token.text);
    if (token.type === 'lineComment') output.push('\n');
    else if (token.type === 'symbol' && token.text === ';') output.push('\n\n');
  });
  return output.join('').trim();
}

function formatCurrentSql() {
  const editor = $('#sql');
  if (!editor) return;
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const hasSelection = start !== end;

  try {
    const formatted = formatSql(hasSelection ? editor.value.slice(start, end) : editor.value);
    if (hasSelection) editor.setRangeText(formatted, start, end, 'select');
    else editor.value = formatted;
    app.query.sql = editor.value;
    sessionStorage.setItem('query', editor.value);
    persistState();
    toast(hasSelection ? 'Đã định dạng đoạn SQL được chọn ✨' : 'Đã định dạng toàn bộ câu lệnh SQL ✨', 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function runExplainQuery() {
  if (!desktop || !app.connection) {
    toast('Chưa kết nối CSDL.', 'error');
    return;
  }
  if (queryTabs.some((tab) => tab.running)) {
    toast('Một truy vấn khác đang chạy. Hãy chờ hoặc hủy trước.', 'error');
    return;
  }
  const tab = app.query;
  try {
    const editor = $('#sql');
    const rawSql = editor ? editor.value : (tab.sql || '');
    let sqlToRun;
    if (editor && editor.selectionStart !== editor.selectionEnd) {
      sqlToRun = rawSql.slice(editor.selectionStart, editor.selectionEnd).trim();
    } else {
      sqlToRun = window.SqlAutocomplete.getContext(rawSql, editor?.selectionStart ?? 0).statement.trim();
    }
    const tokens = tokenizeSql(sqlToRun);
    const meaningful = tokens.filter((token) => !['space', 'comment', 'lineComment'].includes(token.type));
    while (meaningful.at(-1)?.text === ';') meaningful.pop();
    if (!meaningful.length) throw new Error('Vui lòng nhập câu lệnh SQL để EXPLAIN.');
    if (meaningful.some((token) => token.type === 'symbol' && token.text === ';')) {
      throw new Error('Chỉ chọn một câu lệnh SQL để EXPLAIN.');
    }
    const firstWord = meaningful[0].text.toUpperCase();
    if (!['SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'EXPLAIN', 'DESCRIBE', 'DESC'].includes(firstWord)) {
      throw new Error('Câu lệnh này không hỗ trợ EXPLAIN.');
    }
    const explainSql = ['EXPLAIN', 'DESCRIBE', 'DESC'].includes(firstWord) ? sqlToRun : 'EXPLAIN ' + sqlToRun;
    tab.running = true;
    tab.error = null;
    closeSqlSuggestions();
    updateQueryButtons();
    renderQueryTabs();
    setStatus('Đang phân tích kế hoạch thực thi (EXPLAIN)...');
    const result = await call(desktop.db.query({ sql: explainSql, timeoutMs: 30000 }));
    result.isExplain = true;
    tab.result = result;
    tab.resultTab = null;
    tab.resultView = 'data';
    tab.sortCol = null;
    tab.sortDir = 'ASC';
    let hasFullScan = false;
    let fullScanTable = '';
    if (result.kind === 'rows') {
      const typeColIdx = result.columns.findIndex((c) => c.name.toLowerCase() === 'type');
      const tableColIdx = result.columns.findIndex((c) => c.name.toLowerCase() === 'table');
      if (typeColIdx !== -1) {
        for (const row of result.rows) {
          if (String(row[typeColIdx]).toUpperCase() === 'ALL') {
            hasFullScan = true;
            if (tableColIdx !== -1) fullScanTable = row[tableColIdx];
            break;
          }
        }
      }
    }

    if (hasFullScan) {
      toast(`⚠️ Cảnh báo: Full Table Scan trên bảng "${fullScanTable}". Nên thêm Index!`, 'error');
    } else {
      toast('Đã phân tích kế hoạch thực thi (EXPLAIN) thành công!', 'success');
    }
    setStatus('Hoàn tất EXPLAIN');
  } catch (error) {
    toast(error.message || 'Lỗi khi chạy EXPLAIN', 'error');
    setStatus('Lỗi EXPLAIN');
  } finally {
    tab.running = false;
    updateQueryButtons();
    renderQueryTabs();
    const output = $('#queryResult');
    if (app.query === tab && output) output.innerHTML = queryResultHtml();
  }
}

function showShortcutsModal() {
  modal(`
    <div class="modal-card shortcuts-modal-card">
      <div class="modal-header">
        <h3>⌨️ Bảng Tra Cứu Phím Tắt SqlPro</h3>
        <button class="close-btn" onclick="closeModal()">✕</button>
      </div>
      <div class="modal-body">
        <table class="shortcuts-table">
          <thead>
            <tr>
              <th style="width: 220px;">Phím tắt</th>
              <th>Chức năng</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><kbd>F5</kbd> / <kbd>Ctrl</kbd>+<kbd>Enter</kbd></td>
              <td><strong>Thực thi SQL</strong> (toàn bộ hoặc đoạn đang bôi đen)</td>
            </tr>
            <tr>
              <td><kbd>Ctrl</kbd> + <kbd>E</kbd></td>
              <td><strong>Phân tích EXPLAIN</strong> kế hoạch thực thi câu lệnh</td>
            </tr>
            <tr>
              <td><kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>F</kbd></td>
              <td><strong>Định dạng SQL (Beautifier)</strong> tự động căn lề chuẩn đẹp</td>
            </tr>
            <tr>
              <td><kbd>Ctrl</kbd> + <kbd>T</kbd></td>
              <td><strong>Mở tab truy vấn mới</strong></td>
            </tr>
            <tr>
              <td><kbd>Ctrl</kbd> + <kbd>W</kbd></td>
              <td><strong>Đóng tab truy vấn hiện tại</strong></td>
            </tr>
            <tr>
              <td><kbd>Ctrl</kbd> + <kbd>Space</kbd></td>
              <td>Bật menu <strong>Autocomplete từ khóa & bảng/cột</strong></td>
            </tr>
            <tr>
              <td><kbd>Nhấp đúp chuột vào ô</kbd></td>
              <td><strong>Chỉnh sửa ô trực tiếp</strong> (Inline Cell Editing) trên lưới</td>
            </tr>
            <tr>
              <td><kbd>Enter</kbd> (trong ô sửa)</td>
              <td><strong>Lưu giá trị ô</strong> (thực thi UPDATE tự động theo Primary Key)</td>
            </tr>
            <tr>
              <td><kbd>Esc</kbd></td>
              <td>Hủy sửa ô / Đóng hộp thoại Modal / Đóng Context Menu</td>
            </tr>
            <tr>
              <td><kbd>Chuột phải trên ô/dòng</kbd></td>
              <td>Sao chép giá trị, sao chép JSON, xuất lệnh INSERT, đặt NULL...</td>
            </tr>
            <tr>
              <td><kbd>F1</kbd></td>
              <td>Mở bảng tra cứu phím tắt này</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="modal-footer" style="text-align: right; margin-top: 16px;">
        <button class="primary" onclick="closeModal()">Đóng (Esc)</button>
      </div>
    </div>
  `);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'F1') {
    e.preventDefault();
    showShortcutsModal();
  }
});

function renderQueryView() {
  sqlAutocomplete.requestId += 1;
  const value = app.query.sql === null || app.query.sql === undefined ? defaultSql() : app.query.sql;
  app.query.sql = value;
  sessionStorage.setItem('query', value);
  updateChrome();
  $('#workspace').innerHTML = `
    <div class="toolbar">
      <button class="primary" id="runQueryBtn">▷ Chạy (F5)</button>
      <button id="explainQueryBtn" title="Phân tích kế hoạch thực thi (Ctrl+E)">⚡ EXPLAIN</button>
      <button id="formatSqlBtn" title="Định dạng SQL chuẩn đẹp (Ctrl+Shift+F)">🪄 Định dạng</button>
      <button id="saveQueryBtn">⌑ Lưu</button>
      <button class="danger" id="cancelQueryBtn" style="display:${app.query.running ? 'inline-block' : 'none'}">■ Hủy</button>
      <span class="spacer"></span>
      <span class="subtle">${esc(app.database || 'chưa chọn database')}${table ? ` · ${esc(table)}` : ''} &nbsp; · &nbsp; Ctrl+Enter / Ctrl+E</span>
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
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === 'F' || event.key === 'f')) {
      event.preventDefault();
      formatCurrentSql();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && (event.key === 'e' || event.key === 'E')) {
      event.preventDefault();
      runExplainQuery();
      return;
    }
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
  $('#explainQueryBtn').addEventListener('click', runExplainQuery);
  $('#formatSqlBtn').addEventListener('click', formatCurrentSql);
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
  $('#queryResult').addEventListener('click', (event) => {
    const sortTh = event.target.closest('th[data-query-sort]');
    if (sortTh) {
      const colName = Number(sortTh.dataset.querySort);
      if (app.query.sortCol === colName) {
        if (app.query.sortDir === 'ASC') {
          app.query.sortDir = 'DESC';
        } else {
          app.query.sortCol = null;
          app.query.sortDir = 'ASC';
        }
      } else {
        app.query.sortCol = colName;
        app.query.sortDir = 'ASC';
      }
      $('#queryResult').innerHTML = queryResultHtml();
      return;
    }
    const td = event.target.closest('td');
    if (td && !td.classList.contains('muted') && event.detail === 2) {
      const rawText = td.getAttribute('title') || td.textContent.trim();
      if (rawText && rawText !== 'NULL') {
        navigator.clipboard.writeText(rawText);
        toast('Đã sao chép: ' + rawText.slice(0, 40) + (rawText.length > 40 ? '…' : ''));
      }
    }
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
  const sortCol = app.query.sortCol;
  const sortDir = app.query.sortDir === 'DESC' ? -1 : 1;
  const compareText = new Intl.Collator(undefined, { numeric: true }).compare;
  const header = `<tr><th></th>${result.columns.map((column, index) => {
    const sorted = sortCol === index;
    return `<th class="sortable${sorted ? (sortDir === 1 ? ' sorted-asc' : ' sorted-desc') : ''}" data-query-sort="${index}">${esc(column.name)} <small>${esc(column.type)}</small>${sorted ? `<span class="sort-arrow">${sortDir === 1 ? '▲' : '▼'}</span>` : ''}</th>`;
  }).join('')}</tr>`;
  const rows = Number.isInteger(sortCol) && sortCol >= 0 && sortCol < result.columns.length ? [...result.rows].sort((a, b) => {
    const left = a[sortCol];
    const right = b[sortCol];
    if (left == null) return right == null ? 0 : -sortDir;
    if (right == null) return sortDir;
    if (typeof left === 'number' && typeof right === 'number') return (left - right) * sortDir;
    return compareText(String(left), String(right)) * sortDir;
  }) : result.rows;
  const body = rows.map((row, index) => `
    <tr>
      <td class="muted">${index + 1}</td>
      ${row.map((value, colIdx) => {
        const isNull = value === null || value === undefined;
        const text = isNull ? 'NULL' : String(value);
        const shown = text.length > 180 ? `${text.slice(0, 180)}…` : text;
        let cellDisplay = isNull ? '<span class="null-badge">NULL</span>' : esc(shown);
        const colMeta = result.columns[colIdx];
        const colName = colMeta ? colMeta.name.toLowerCase() : '';
        if (result.isExplain && colName === 'type' && !isNull) {
          const uType = String(value).toUpperCase();
          if (uType === 'ALL') cellDisplay = '<span class="explain-badge bad" title="Quét toàn bộ bảng - Cần đánh thêm Index!">ALL ⚠️</span>';
          else if (uType === 'INDEX') cellDisplay = '<span class="explain-badge warn" title="Quét toàn bộ chỉ mục">index</span>';
          else if (uType === 'RANGE') cellDisplay = '<span class="explain-badge info" title="Quét trong khoảng">range</span>';
          else if (['CONST', 'EQ_REF', 'REF'].includes(uType)) cellDisplay = `<span class="explain-badge good">${esc(value)} ✓</span>`;
        } else if (result.isExplain && colName === 'extra' && !isNull) {
          cellDisplay = cellDisplay
            .replace(/Using filesort/g, '<span class="explain-extra-warn">Using filesort</span>')
            .replace(/Using temporary/g, '<span class="explain-extra-warn">Using temporary</span>');
        }
        return `<td class="${isNull ? 'nullcell' : ''}" title="${esc(text.slice(0, 500))}">${cellDisplay}</td>`;
      }).join('')}
    </tr>
  `).join('') || `<tr><td colspan="${result.columns.length + 1}" class="empty">Không có dòng nào.</td></tr>`;
  const exportToolbar = `
    <div class="query-grid-toolbar">
      <div class="actions-left">
        <span class="resulttitle">✓ ${result.rows.length} dòng · ${result.durationMs} ms${result.truncated ? ' · giới hạn 5000 dòng' : ''}</span>
      </div>
      <div class="actions-right">
        <button type="button" onclick="exportCurrentResult('csv')" title="Xuất kết quả truy vấn ra CSV">↧ Xuất CSV</button>
        <button type="button" onclick="exportCurrentResult('json')" title="Xuất kết quả truy vấn ra JSON">↧ Xuất JSON</button>
      </div>
    </div>`;
  return `
    ${compact ? '' : exportToolbar}
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
  const explain = $('#explainQueryBtn');
  if (explain) explain.disabled = running;
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
  const rawSql = (editor?.value || tab.sql || '').trim();
  if (!rawSql) {
    toast('Câu lệnh SQL đang trống.', 'error');
    return;
  }
  let sqlToRun = rawSql;
  let isSelection = false;
  if (editor && editor.selectionStart !== editor.selectionEnd) {
    const selected = editor.value.slice(editor.selectionStart, editor.selectionEnd).trim();
    if (selected) {
      sqlToRun = selected;
      isSelection = true;
    }
  }
  tab.sql = rawSql;
  tab.running = true;
  tab.error = null;
  updateQueryButtons();
  renderQueryTabs();
  if (app.query === tab && $('#queryResult')) {
    $('#queryResult').innerHTML = `<div class="empty">${isSelection ? 'Đang chạy đoạn mã được chọn…' : 'Đang chạy truy vấn…'}</div>`;
  }
  try {
    let result;
    try {
      result = await call(desktop.db.query({ sql: sqlToRun, timeoutMs: 30000 }));
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
      result = await call(desktop.db.query({ sql: sqlToRun, timeoutMs: 30000, confirmed: true }));
    }
    tab.result = result;
    tab.error = null;
    tab.resultTab = result.kind === 'batch'
      ? (result.failedCount ? 'message' : queryBatchTabs(result).find((item) => item.entry)?.key || 'message')
      : null;
    tab.resultView = 'data';
    tab.sortCol = null;
    tab.sortDir = 'ASC';
    await refreshQueryMetadata(result);
    const batchFailed = result.kind === 'batch' && result.failedCount > 0;
    const historyMessage = result.kind === 'batch'
      ? `${result.succeededCount}/${result.statementCount} câu lệnh`
      : (result.kind === 'ok' ? `${result.affectedRows} dòng` : `${result.rows.length} dòng`);
    historyRows.unshift({
      sql: sqlToRun,
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
      sql: sqlToRun,
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
    if (app.query === tab && $('#queryResult')) $('#queryResult').innerHTML = queryResultHtml();
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
      <div class="successbox hidden" id="connSuccess"></div>
      <div class="errorbox hidden" id="connError"></div>
      <div class="actions">
        ${existing ? '<button type="button" class="danger" id="connDelete">Xóa kết nối</button><span class="spacer"></span>' : '<span class="spacer"></span>'}
        <button type="button" id="connCancel">Hủy</button>
        <button type="button" id="connTest">Kiểm tra kết nối</button>
        <button type="submit" class="primary" id="connSubmit">${existing ? 'Lưu &amp; kết nối' : 'Lưu &amp; kết nối'}</button>
      </div>
    </form>
  `, true);

  const form = $('#connectionForm');
  const errorBox = $('#connError');
  const successBox = $('#connSuccess');
  const testButton = $('#connTest');
  const submitButton = $('#connSubmit');

  const showSuccess = (message) => {
    errorBox.classList.add('hidden');
    errorBox.innerHTML = '';
    successBox.textContent = message;
    successBox.classList.remove('hidden');
  };

  const showError = (message, allowForceSave = false, payloadToSave = null) => {
    successBox.classList.add('hidden');
    errorBox.innerHTML = '';
    const textNode = document.createElement('div');
    textNode.textContent = message;
    errorBox.appendChild(textNode);

    if (allowForceSave && payloadToSave) {
      const forceWrap = document.createElement('div');
      forceWrap.style.marginTop = '8px';
      const forceButton = document.createElement('button');
      forceButton.type = 'button';
      forceButton.textContent = 'Vẫn lưu cấu hình này (không kết nối ngay)';
      forceButton.addEventListener('click', async () => {
        try {
          forceButton.disabled = true;
          forceButton.textContent = 'Đang lưu…';
          const saved = await call(desktop.connections.save(payloadToSave));
          closeModal();
          if (saved.workspaceId) app.activeWorkspaceId = saved.workspaceId;
          await refreshConnections();
          toast('Đã lưu kết nối');
        } catch (err) {
          showError(err.message);
        }
      });
      forceWrap.appendChild(forceButton);
      errorBox.appendChild(forceWrap);
    }

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
  testButton.addEventListener('click', async () => {
    errorBox.classList.add('hidden');
    successBox.classList.add('hidden');
    testButton.disabled = true;
    testButton.textContent = 'Đang kiểm tra…';
    try {
      const payload = readForm();
      const result = await call(desktop.connections.test(payload));
      showSuccess(`✓ Kết nối thành công! Phiên bản: MySQL ${result.version || ''}`);
    } catch (error) {
      showError(error.message);
    } finally {
      testButton.disabled = false;
      testButton.textContent = 'Kiểm tra kết nối';
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.classList.add('hidden');
    successBox.classList.add('hidden');
    submitButton.disabled = true;
    testButton.disabled = true;
    const originalText = submitButton.textContent;
    submitButton.textContent = 'Đang kiểm tra kết nối…';

    const payload = readForm();
    try {
      // 1. Kiểm tra kết nối trước khi lưu
      await call(desktop.connections.test(payload));

      // 2. Kết nối thành công -> Lưu cấu hình và mở kết nối
      submitButton.textContent = 'Đang lưu…';
      const saved = await call(desktop.connections.save(payload));
      closeModal();
      if (saved.workspaceId) app.activeWorkspaceId = saved.workspaceId;
      await refreshConnections();
      await connectTo(saved.id);
    } catch (error) {
      showError(`Không thể kết nối đến cơ sở dữ liệu:\n${error.message}`, true, payload);
    } finally {
      submitButton.disabled = false;
      testButton.disabled = false;
      submitButton.textContent = originalText;
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
    <h2>Nhập dữ liệu vào bảng</h2>
    <p>${esc(app.database)}.${esc(table)}</p>
    <label>Chọn định dạng tệp</label>
    <select id="importFormatSelect">
      <option value="csv">CSV / TSV (Tự động map cột & Xem trước dữ liệu)</option>
      <option value="json">JSON (Mảng đối tượng, tối đa 5000 dòng)</option>
    </select>
    <div class="hint">Tệp CSV cho phép xem trước 5 dòng dữ liệu mẫu và ghép từng cột vào bảng MySQL tương ứng.</div>
    <div class="actions">
      <button onclick="closeModal()">Hủy</button>
      <button class="primary" id="importGo">Tiếp tục chọn tệp…</button>
    </div>
  `);
  $('#importGo').addEventListener('click', async () => {
    const fmt = $('#importFormatSelect')?.value || 'csv';
    if (fmt === 'csv') {
      closeModal();
      importCsvModal();
      return;
    }
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
