'use strict';

let table = null;
let mode = 'data';
let historyRows = [];
let savedQueries = [];
let snippets = [];
let queryDraftCache = '';
// Remove the old plaintext browser cache; durable drafts belong to Main's encrypted state.
try { sessionStorage.removeItem('query'); } catch {}
let snippetSearchTerm = '';
let snippetFilterTag = '';
let historyFilter = { query: '', status: 'all', scrubSensitive: false };
let activeTransfer = null;
let transferView = null;
let transferTaskSeq = 0;
const rowOriginalHashes = new WeakMap();

function originalRow(row) {
  return { ...row, ...(rowOriginalHashes.get(row) || {}) };
}

const desktop = window.sqlProDesktop;
const RowValues = window.SqlRowValues;
const ExportValues = window.SqlExportValues;
const QueryResults = window.SqlQueryResults;
const QuerySnippets = window.QuerySnippets;
const SqlDiagnostics = window.SqlDiagnostics;

const DEFAULT_WORKSPACE_ID = 'ws-personal';
const openTreeGroups = new Set(['tables']);
const collapsedDbs = new Set();
const collapsedConnections = new Set();
const openConnectionIds = new Set();
const connectionLocations = new Map();
const connectionViews = new Map();
let connectionSwitching = false;

const app = {
  connections: [],
  workspaces: [],
  activeWorkspaceId: DEFAULT_WORKSPACE_ID,
  account: null,
  connection: null,
  databases: [],
  database: null,
  tables: [],
  backups: [],
  selectedBackupId: null,
  routineState: { loading: false, loaded: false, error: '', data: [] },
  eventState: { loading: false, loaded: false, error: '', data: [] },
  server: '',
  serverType: 'mysql',
  columns: [],
  primaryKey: [],
  rows: [],
  total: null,
  page: 1,
  pageSize: 100,
  search: '',
  filterTree: null,
  visibleColumns: null,
  sorts: null,
  orderBy: null,
  orderDir: 'ASC',
  query: { sql: '', result: null, error: null, running: false },
  indexes: null,
  relations: null
};

let queryTabs = [{
  id: 1,
  title: 'Query 1',
  sql: null,
  result: null,
  error: null,
  running: false,
  profileId: null,
  database: null,
  taskId: null
}];
let activeQuery = 0;
let queryId = 1;
let queryTaskSeq = 0;
let explainObservations = new WeakMap();
let explainGeneration = 0;
function resetExplainComparisons() {
  explainGeneration += 1;
  explainObservations = new WeakMap();
  for (const tab of queryTabs) {
    if (tab.result?.explainComparison) delete tab.result.explainComparison;
  }
}
let dataRequestId = 0;
app.query = queryTabs[0];

const sqlAutocomplete = {
  items: [],
  selected: 0,
  context: null,
  requestId: 0,
  columnCache: window.SqlAutocomplete.createColumnCache(),
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

let modalRevision = 0;
function modal(html, wide = false) {
  ++modalRevision;
  const dialog = $('#modal');
  if (!html.includes('data-transfer-running')) {
    clearTimeout(window.__sqlproTaskTimer);
    window.__sqlproTaskTimer = null;
  }
  dialog.className = wide ? 'wide' : '';
  dialog.innerHTML = html;
  if (!dialog.open) dialog.showModal();
}

function closeModal() {
  ++modalRevision;
  const dialog = $('#modal');
  if ($('#modal [data-transfer-running]')) {
    clearTimeout(window.__sqlproTaskTimer);
    window.__sqlproTaskTimer = null;
  }
  if (dialog.open) dialog.close();
}

function taskProgressHtml(operation, target) {
  const title = operation === 'backup' ? 'Đang sao lưu database'
    : operation === 'restore' ? 'Đang phục hồi database'
      : operation === 'export' ? 'Đang xuất dữ liệu'
        : operation === 'import' ? 'Đang nhập dữ liệu' : 'Đang xóa bảng';
  const icon = operation === 'backup' ? '↓'
    : operation === 'restore' ? '↑'
      : operation === 'export' ? '↗'
        : operation === 'import' ? '↘' : '×';
  const label = operation === 'backup' ? 'Đã ghi'
    : operation === 'restore' ? 'Đã đọc'
      : operation === 'export' ? 'Đã ghi tệp'
        : operation === 'import' ? 'Đã đọc tệp' : 'Đang xử lý';
  const cancellable = operation !== 'drop-table';
  const percent = operation === 'backup' || operation === 'restore' || operation === 'import' ? 'max="100"' : '';
  return `
    <div class="transfer-progress transfer-${operation}" data-transfer-running="${operation}" role="status" aria-live="polite">
      <div class="task-heading"><span class="task-icon" aria-hidden="true">${icon}</span><div>
        <span class="task-eyebrow">TÁC VỤ DATABASE</span><h2>${title}</h2>
      </div><span class="task-running">Đang chạy</span></div>
      <div class="task-target" title="${esc(target)}">${esc(target)}</div>
      ${operation === 'backup' || operation === 'restore' ? '<div class="task-object"><span>ĐANG XỬ LÝ</span><strong id="transferObject">Đang chuẩn bị…</strong></div>' : ''}
      <div class="task-steps"><span class="done">✓ Chuẩn bị</span><span class="active" id="taskCurrentStep">● Đang xử lý</span><span>○ Hoàn tất</span></div>
      ${operation === 'backup' || operation === 'restore' ? '<div class="task-percent" id="transferPercent" aria-live="off">Đang ước tính tiến độ…</div>' : ''}
      <progress id="transferBar" ${percent} aria-label="Tiến độ ${title.toLowerCase()}"></progress>
      <div class="task-metrics"><div><span>TIẾN TRÌNH</span><strong id="transferDetail">Đang chuẩn bị…</strong></div>
        <div><span>${label.toUpperCase()}</span><strong id="transferSize">${operation === 'drop-table' ? 'Đang chờ máy chủ' : '0 B'}</strong></div></div>
      ${operation === 'backup' || operation === 'restore' ? '<div class="task-log-section"><div class="task-log-heading">Nhật ký tác vụ <span id="transferLogCount"></span></div><div class="task-log" id="transferLog" role="log" aria-label="Nhật ký backup và restore"></div></div>' : ''}
      <div class="task-footer"><span>Giữ SqlPro mở cho đến khi tác vụ hoàn tất.</span><span id="taskElapsed">00:00</span>
        ${cancellable ? '<button type="button" class="task-cancel-btn" data-cancel-transfer>Hủy tác vụ</button>' : ''}
      </div>
    </div>`;
}

function startTaskClock() {
  clearTimeout(window.__sqlproTaskTimer);
  const startedAt = mode === 'transfer' && transferView ? transferView.startedAt : Date.now();
  const tick = () => {
    const elapsed = $('#taskElapsed');
    if (!($('#modal [data-transfer-running]') || $('#workspace [data-transfer-running]')) || !elapsed) return;
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    elapsed.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    window.__sqlproTaskTimer = setTimeout(tick, 1000);
  };
  tick();
}

function newTransferTaskId(operation) {
  transferTaskSeq += 1;
  return `${operation}-${Date.now()}-${transferTaskSeq}`;
}

function cancelActiveTransfer() {
  const transfer = activeTransfer;
  if (!transfer || !transfer.taskId) {
    toast('Không xác định được tác vụ cần hủy.', 'error');
    return Promise.resolve();
  }
  if (transfer.canceling) return Promise.resolve();
  transfer.canceling = true;
  const button = document.querySelector('[data-cancel-transfer]');
  if (button) {
    button.disabled = true;
    button.textContent = 'Đang hủy…';
  }
  return call(desktop.db.cancelTask(transfer.profileId, transfer.taskId))
    .then((result) => {
      if (result && result.canceled) {
        toast('Đã gửi yêu cầu hủy. Tab tác vụ chỉ chuyển sang trạng thái đã hủy khi main xác nhận tác vụ đã dừng.');
        return;
      }
      transfer.canceling = false;
      if (button) {
        button.disabled = false;
        button.textContent = 'Hủy tác vụ';
      }
      toast('Tác vụ đã dừng trước khi yêu cầu hủy được xử lý.');
    })
    .catch((error) => {
      transfer.canceling = false;
      if (button) {
        button.disabled = false;
        button.textContent = 'Hủy tác vụ';
      }
      toast(error.message, 'error');
    });
}

function showTransferProgress(operation, database, context = {}) {
  activeTransfer = {
    operation,
    database,
    taskId: context.taskId || null,
    profileId: context.profileId || null,
    canceling: false
  };
  if (operation === 'backup' || operation === 'restore') {
    transferView = { ...activeTransfer, startedAt: Date.now(), progress: null, state: 'running', note: context.note || '', logs: [] };
    closeModal();
    renderTransferTab();
    void view('transfer');
    return;
  }
  modal(`
    ${taskProgressHtml(operation, database)}
    ${context.note ? `<p class="hint">${esc(context.note)}</p>` : ''}
  `);
  const cancelButton = document.querySelector('[data-cancel-transfer]');
  if (cancelButton) cancelButton.addEventListener('click', cancelActiveTransfer);
  startTaskClock();
}

function renderTransferTab() {
  const tab = $('#transferTab');
  if (!tab) return;
  tab.hidden = !transferView;
  if (!transferView) return;
  const title = transferView.operation === 'backup' ? 'Sao lưu' : 'Phục hồi';
  const symbol = transferView.state === 'running' ? '●' : transferView.state === 'success' ? '✓' : '⚠';
  const connectionName = app.connections.find((connection) => connection.id === transferView.profileId)?.name || transferView.profileId || '';
  tab.textContent = `${symbol} ${title} · ${transferView.database}`;
  tab.title = `${title} ${connectionName} / ${transferView.database}`;
  tab.classList.toggle('selected', mode === 'transfer');
  tab.classList.toggle('running', transferView.state === 'running');
}

function renderTransferView() {
  if (!transferView) {
    renderEmptyTable('Chưa có tác vụ sao lưu hoặc phục hồi.');
    return;
  }
  const transfer = transferView;
  $('#workspace').innerHTML = transfer.state === 'running'
    ? `${taskProgressHtml(transfer.operation, transfer.database)}
      ${transfer.note ? `<p class="hint">${esc(transfer.note)}</p>` : ''}
      <p class="hint">Tác vụ chạy bằng kết nối riêng. Bạn có thể chuyển sang tab SQL Editor và quay lại tab này để xem tiến độ.</p>`
    : `<div class="transfer-result transfer-${transfer.state}" role="status">
        <h2>${esc(transfer.title)}</h2>${transfer.resultHtml}
        <div class="task-log-section"><div class="task-log-heading">Nhật ký tác vụ <span id="transferLogCount"></span></div><div class="task-log" id="transferLog" role="log" aria-label="Nhật ký backup và restore"></div></div>
        <div class="actions"><button type="button" id="transferClose">Đóng tab tác vụ</button></div>
      </div>`;
  renderTransferLog();
  if (transfer.state === 'running') {
    $('#workspace [data-cancel-transfer]')?.addEventListener('click', cancelActiveTransfer);
    if (transfer.progress) updateTransferProgress(transfer.progress);
    startTaskClock();
  } else {
    $('#workspace [data-transfer-open-db]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const profileId = button.dataset.transferProfile;
        const database = button.dataset.transferOpenDb;
        if (profileId !== app.connection?.id) await connectTo(profileId, { database });
        else await selectDatabase(database);
      } catch (error) {
        toast(error.message, 'error');
        button.disabled = false;
      }
    });
    $('#transferClose')?.addEventListener('click', () => {
      transferView = null;
      renderTransferTab();
      void view(app.database ? 'backups' : 'data');
    });
  }
}

function transferEventLabel(event, operation) {
  const name = typeof event.objectName === 'string' ? event.objectName : '';
  if (operation === 'backup') {
    const labels = {
      'table-structure': 'Sao lưu cấu trúc bảng', 'table-data': 'Sao lưu dữ liệu bảng',
      view: 'Sao lưu view', procedure: 'Sao lưu procedure', function: 'Sao lưu function',
      trigger: 'Sao lưu trigger', event: 'Sao lưu event', finishing: 'Đang hoàn tất tệp backup'
    };
    const label = labels[event.stage] || 'Đang sao lưu';
    return name ? `${label}: ${name}` : label;
  }
  const command = typeof event.command === 'string' ? event.command : 'SQL';
  const action = event.phase === 'scan' ? 'Kiểm tra' : 'Thực thi';
  return name ? `${action} ${command} trên ${name}` : `${action} tệp SQL`;
}

function renderTransferLog() {
  const log = $('#transferLog');
  if (!log || !transferView) return;
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 30;
  log.innerHTML = (transferView.logs || []).map((entry) => `<div class="task-log-entry"><time>${esc(entry.time)}</time><span>${esc(entry.text)}</span></div>`).join('')
    || '<div class="task-log-empty">Đang chờ nhật ký tiến trình…</div>';
  const count = $('#transferLogCount');
  if (count) count.textContent = `${transferView.logs?.length || 0} mục gần nhất`;
  if (nearBottom) log.scrollTop = log.scrollHeight;
}

function recordTransferLogs(progress) {
  if (!transferView || transferView.state !== 'running' || transferView.lastLoggedProgress === progress) return;
  transferView.lastLoggedProgress = progress;
  const events = [];
  if (progress.operation === 'restore' && progress.phase !== transferView.lastPhase) {
    transferView.lastPhase = progress.phase;
    events.push({ phase: progress.phase });
  }
  if (Array.isArray(progress.events) && progress.events.length) events.push(...progress.events);
  else if (progress.operation === 'backup' && progress.stage && progress.objectName) {
    events.push({ stage: progress.stage, objectName: progress.objectName });
  }
  let changed = false;
  for (const event of events) {
    const key = [event.phase || '', event.stage || '', event.command || '', event.objectName || ''].join(':');
    if (key === transferView.lastLogKey) continue;
    transferView.lastLogKey = key;
    transferView.logs.push({ time: new Date().toLocaleTimeString('vi-VN', { hour12: false }), text: transferEventLabel(event, progress.operation) });
    if (transferView.logs.length > 200) transferView.logs.shift();
    changed = true;
  }
  if (changed && mode === 'transfer') renderTransferLog();
}

function finishBackgroundTransfer(state, title, resultHtml, taskId) {
  if (!transferView || transferView.taskId !== taskId) return;
  transferView.state = state;
  transferView.title = title;
  transferView.resultHtml = resultHtml;
  activeTransfer = null;
  clearTimeout(window.__sqlproTaskTimer);
  renderTransferTab();
  if (mode === 'transfer') renderTransferView();
}

function showTableDropProgress(database, tableName) {
  modal(taskProgressHtml('drop-table', `${database}.${tableName}`));
  startTaskClock();
}

function setProgressValue(bar, value) {
  if (!bar) return;
  if (Number.isFinite(value)) {
    bar.value = Math.max(0, Math.min(100, value));
    return;
  }
  if (typeof bar.removeAttribute === 'function') bar.removeAttribute('value');
  else bar.value = 0;
}

function updateTransferProgress(progress) {
  if (!progress || !['backup', 'restore', 'import', 'export'].includes(progress.operation)) return;
  if (!activeTransfer || activeTransfer.operation !== progress.operation) return;
  if (activeTransfer.taskId && progress.taskId !== activeTransfer.taskId) return;
  if (progress.profileId && activeTransfer.profileId && progress.profileId !== activeTransfer.profileId) return;
  if (transferView?.state === 'running' && transferView.taskId === activeTransfer.taskId) {
    transferView.progress = progress;
    recordTransferLogs(progress);
  }
  const running = mode === 'transfer' && transferView
    ? $('#workspace [data-transfer-running]') : $('#modal [data-transfer-running]');
  if (!running || running.dataset.transferRunning !== progress.operation) return;
  const detail = $('#transferDetail');
  const size = $('#transferSize');
  const bar = $('#transferBar');
  const step = $('#taskCurrentStep');
  if (progress.operation === 'backup') {
    detail.textContent = `${Number(progress.rows || 0).toLocaleString()} dòng · ${Number(progress.objects || 0).toLocaleString()} đối tượng`;
    size.textContent = `Đã ghi ${formatBytes(progress.bytes)}`;
    const stageLabels = {
      'table-structure': 'Cấu trúc bảng',
      'table-data': 'Dữ liệu bảng',
      view: 'View',
      procedure: 'Procedure',
      function: 'Function',
      trigger: 'Trigger',
      event: 'Event'
    };
    const currentObject = $('#transferObject');
    if (currentObject) {
      const stage = stageLabels[progress.stage];
      const name = typeof progress.objectName === 'string' ? progress.objectName : '';
      const index = Number(progress.objectIndex) || 0;
      const total = Number(progress.objectTotal) || 0;
      currentObject.textContent = progress.stage === 'retention' ? String(progress.message || 'Đang tự dọn backup cũ…') : progress.stage === 'finishing' ? 'Đang hoàn tất tệp backup…'
        : stage && name ? `${stage}: ${name}${index && total ? ` (${index}/${total})` : ''}`
          : 'Đang chuẩn bị danh sách bảng…';
      currentObject.title = currentObject.textContent;
    }
    const percent = Number(progress.percent);
    const percentLabel = $('#transferPercent');
    if (progress.percent !== null && progress.percent !== undefined && Number.isFinite(percent) && percent >= 0) {
      const value = Math.max(0, Math.min(99, Math.floor(percent)));
      setProgressValue(bar, value);
      if (percentLabel) percentLabel.textContent = `~${value}% · ước tính theo số dòng của MySQL`;
    } else {
      setProgressValue(bar, null);
      if (percentLabel) percentLabel.textContent = 'Tiến độ ước tính: chưa đủ dữ liệu';
    }
    if (step) step.textContent = progress.stage === 'retention' ? '● Backup đã ghi xong · Đang tự dọn'
      : progress.stage === 'finishing' ? '● Đang hoàn tất'
      : progress.stage === 'table-data' ? '● Đang xuất dữ liệu' : '● Đang xuất cấu trúc';
  } else if (progress.operation === 'export') {
    detail.textContent = `${Number(progress.rows || 0).toLocaleString()} dòng đã xuất`;
    size.textContent = `Đã ghi ${formatBytes(progress.bytes)}`;
    if (step) step.textContent = '● Đang ghi tệp';
  } else if (progress.operation === 'import') {
    const written = progress.transaction === 'all'
      ? Number(progress.written || 0)
      : Number(progress.committed ?? progress.written ?? 0);
    const duplicates = Number(progress.duplicates || 0);
    detail.textContent = `${Number(progress.rows || 0).toLocaleString()} dòng đã đọc · ${written.toLocaleString()} đã ghi${duplicates ? ` · ${duplicates.toLocaleString()} trùng` : ''}`;
    size.textContent = `${formatBytes(progress.bytes)} / ${formatBytes(progress.totalBytes)}`;
    setProgressValue(bar, progress.totalBytes ? Math.min(100, Math.round(progress.bytes / progress.totalBytes * 100)) : null);
    if (step) step.textContent = '● Đang nhập dữ liệu';
  } else {
    const scanning = progress.phase === 'scan';
    detail.textContent = scanning
      ? `${Number(progress.statements || 0).toLocaleString()} câu lệnh đã kiểm tra${progress.skipped ? ` · ${progress.skipped} bỏ qua` : ''}`
      : `${Number(progress.executed || 0).toLocaleString()} câu lệnh đã chạy${progress.skipped ? ` · ${progress.skipped} bỏ qua` : ''}`;
    size.textContent = `${formatBytes(progress.bytes)} / ${formatBytes(progress.totalBytes)} · ${scanning ? 'lượt kiểm tra' : 'lượt phục hồi'}`;
    const totalBytes = Number(progress.totalBytes) || 0;
    if (totalBytes > 0) {
      setProgressValue(bar, Math.min(scanning ? 50 : 99, Math.round((scanning ? 0 : 50) + progress.bytes / totalBytes * 50)));
    } else {
      setProgressValue(bar, null);
    }
    const percentLabel = $('#transferPercent');
    if (percentLabel) {
      percentLabel.textContent = totalBytes > 0
        ? `~${bar?.value || 0}% tổng tiến trình · ước tính theo dung lượng tệp · ${scanning ? 'đã kiểm tra' : 'đã chạy'} ${Math.min(100, Math.round(progress.bytes / totalBytes * 100))}% tệp`
        : `Tiến độ không xác định · ${scanning ? 'đang kiểm tra' : 'đang chạy SQL'} tệp`;
    }
    const currentObject = $('#transferObject');
    if (currentObject) {
      const name = typeof progress.currentObject === 'string' ? progress.currentObject : '';
      const command = typeof progress.currentCommand === 'string' ? progress.currentCommand : 'SQL';
      currentObject.textContent = name ? `${scanning ? 'Kiểm tra' : 'Thực thi'} ${command}: ${name}`
        : scanning ? 'Đang kiểm tra tệp SQL…' : 'Đang chạy SQL…';
      currentObject.title = currentObject.textContent;
    }
    if (step) step.textContent = scanning ? '● Đang kiểm tra tệp SQL' : '● Đang chạy SQL';
  }
}

function setStatus(text) {
  $('#status').textContent = text;
}

function connectionTlsStatus(profile, tls = null) {
  if (!profile) return '';
  const ssl = profile.ssl || {};
  if (tls && tls.active === true) {
    const label = tls.version || tls.cipher || 'TLS';
    return `${ssl.verify === true ? 'TLS ✓' : '⚠ TLS chưa xác thực'} (${label})`;
  }
  if (tls && tls.active === false && tls.unknown !== true) {
    return ssl.enabled ? '⚠ TLS cấu hình nhưng phiên không mã hóa' : 'Không TLS';
  }
  if (ssl.enabled) return ssl.verify === true ? 'TLS ✓' : '⚠ TLS chưa xác thực';
  return profile.ssh?.enabled ? 'SSH · Không TLS' : 'Không TLS';
}

function connectionTransportBadge(profile) {
  if (!profile) return '';
  if (profile.ssl?.enabled) return profile.ssl.verify === true ? 'TLS ✓' : '⚠ TLS chưa xác thực';
  return profile.ssh?.enabled ? 'SSH · Không TLS' : 'Không TLS';
}

function connectionSecuritySummary(profile, tls = null) {
  if (!profile) return '';
  const ssl = profile.ssl || {};
  const ssh = profile.ssh || {};
  const notes = [];
  if (tls && tls.active === true) {
    const cipher = [tls.version, tls.cipher].filter(Boolean).join('/');
    notes.push(`Phiên hiện tại dùng TLS${cipher ? ` (${cipher})` : ''}${ssl.verify === true ? ' và đã xác thực chứng chỉ' : ', nhưng chưa xác thực chứng chỉ máy chủ'}.`);
  } else if (tls && tls.active === false && tls.unknown !== true && ssl.enabled) {
    notes.push('Đã cấu hình TLS nhưng phiên hiện tại không báo cáo mã hóa.');
  } else if (ssl.enabled) {
    notes.push(ssl.verify === true
      ? 'TLS có xác thực chứng chỉ máy chủ.'
      : 'TLS đang tắt xác thực chứng chỉ: kết nối có thể bị nghe lén hoặc giả mạo máy chủ.');
  } else {
    notes.push('Kết nối MySQL không dùng TLS: mật khẩu và dữ liệu có thể bị đọc trên đường truyền.');
  }
  if (ssh.enabled) {
    const local = ['localhost', '127.0.0.1', '::1'].includes(String(profile.host || '').toLowerCase());
    notes.push(local
      ? 'SSH tunnel chỉ bảo vệ đoạn từ máy này tới SSH host; SqlPro không thể xác minh MySQL chỉ nghe loopback, không có proxy chuyển tiếp, hoặc đoạn nội bộ được mã hóa.'
      : `SSH tunnel chỉ bảo vệ đoạn từ máy này tới SSH host; đoạn từ SSH host tới MySQL (${profile.host || 'đích'}) phụ thuộc địa chỉ và cấu hình thực tế, không mặc định an toàn toàn tuyến.`);
  }
  if (profile.allowCleartextPassword === true) {
    notes.push(ssl.enabled && ssl.verify === true
      ? 'mysql_clear_password sẽ được gửi trong TLS đã xác thực chứng chỉ.'
      : 'mysql_clear_password chỉ được cho phép nhờ đích loopback trên máy SSH với host key đã xác minh; cấu hình mạng thực tế của máy đó không thể xác minh từ SqlPro.');
  }
  return notes.join(' ');
}

function activeSessionTls() {
  return app.sessionState && app.sessionState.profileId === app.connection?.id
    ? app.sessionState.tls || null
    : null;
}

function setConnectionState(kind, detail = '') {
  const dot = $('#connDot');
  const label = $('#connState');
  const serverInfo = $('#serverInfo');
  if (kind === 'connected') {
    dot.style.background = '#24a68b';
    label.textContent = detail || 'Đã kết nối';
    serverInfo.textContent = `${app.serverType.toUpperCase()} ${app.server || ''} • ${app.database || 'chưa chọn database'} • ${connectionTlsStatus(app.connection, activeSessionTls())}`;
    serverInfo.title = connectionSecuritySummary(app.connection, activeSessionTls());
  } else if (kind === 'connecting') {
    dot.style.background = '#c9a227';
    label.textContent = 'Đang kết nối…';
    serverInfo.textContent = 'Đang kết nối…';
    serverInfo.title = '';
  } else if (kind === 'error') {
    dot.style.background = '#c24b4b';
    label.textContent = detail || 'Lỗi kết nối';
    serverInfo.textContent = 'Chưa kết nối';
    serverInfo.title = '';
  } else {
    dot.style.background = '#c9d3db';
    label.textContent = detail || 'Chưa kết nối';
    serverInfo.textContent = 'Chưa kết nối';
    serverInfo.title = '';
  }
}

async function call(promise) {
  const response = await promise;
  if (!response) throw new Error('Không có phản hồi từ ứng dụng.');
  if (!response.ok) {
    if (response.error?.code === 'PRODUCTION_CONFIRM_REQUIRED' && desktop?.db?.confirmProduction) {
      const preview = response.error.preview;
      const accepted = await confirmProductionWrite(preview);
      if (!accepted) {
        if (desktop.db.cancelProduction) await desktop.db.cancelProduction(preview.token);
        throw Object.assign(new Error('Đã hủy thao tác trên Production. Nội dung đang sửa được giữ lại.'), {code:'PRODUCTION_WRITE_CANCELLED'});
      }
      return call(desktop.db.confirmProduction(preview.token));
    }
    const error = new Error(response.error?.message || 'Đã xảy ra lỗi.');
    error.code = response.error?.code || '';
    if (response.error?.fingerprint) error.fingerprint = response.error.fingerprint;
    if (response.error?.expectedFingerprint) error.expectedFingerprint = response.error.expectedFingerprint;
    if (response.error?.partial) error.partial = response.error.partial;
    if (response.error?.impact) error.impact = response.error.impact;
    if (response.error?.preflight) error.preflight = response.error.preflight;
    if (response.error?.conflict) error.conflict = response.error.conflict;
    throw error;
  }
  return response.data;
}

async function writeClipboardText(text) {
  if (desktop?.writeClipboardText) return desktop.writeClipboardText(String(text));
  return navigator.clipboard.writeText(String(text));
}

async function readClipboardText() {
  if (desktop?.readClipboardText) return desktop.readClipboardText();
  return navigator.clipboard.readText();
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

function newQueryTaskId() {
  queryTaskSeq += 1;
  return `query-${Date.now()}-${queryTaskSeq}`;
}

function activeQueryTarget() {
  return {
    profileId: app.connection ? app.connection.id : null,
    database: app.database || null
  };
}

function queryTargetConnection(tab) {
  if (!tab || !tab.profileId) return null;
  if (app.connection && app.connection.id === tab.profileId) return app.connection;
  return app.connections.find((connection) => connection.id === tab.profileId) || null;
}

function connectionEnvironment(profile) {
  const labels = { local: 'LOCAL', staging: 'STAGING', production: 'PRODUCTION' };
  const value = profile?.environment;
  return Object.hasOwn(labels, value) ? { value, label: labels[value] } : { value: 'unclassified', label: 'CHƯA PHÂN LOẠI' };
}

function connectionEnvironmentBadge(profile) {
  const environment = connectionEnvironment(profile);
  return `<span class="connection-environment environment-${environment.value}">${environment.label}</span>${profile?.readOnly === true ? ' <span class="connection-environment connection-readonly">CHỈ ĐỌC</span>' : ''}`;
}

function connectionIsReadOnly(profileId = app.connection?.id) {
  const profile = app.connections.find((entry) => entry.id === profileId) || (app.connection?.id === profileId ? app.connection : null);
  return profile?.readOnly === true;
}

function queryTargetLabel(tab, includeEnvironment = true) {
  const connection = queryTargetConnection(tab);
  const name = connection && connection.name
    ? connection.name
    : (tab && tab.profileId ? 'kết nối không còn tồn tại' : 'chưa gắn kết nối');
  const env = connection ? connectionEnvironment(connection) : null;
  const envLabel = env && env.value !== 'unclassified' ? ` · ${env.label}` : '';
  return `${name} · ${(tab && tab.database) || 'không chọn database'}${connection && includeEnvironment ? `${envLabel}${connection.readOnly ? ' · CHỈ ĐỌC' : ''}` : ''}`;
}

async function ensureQueryTarget(tab) {
  const connection = queryTargetConnection(tab);
  if (connection) {
    return { profileId: connection.id, database: tab.database || null, connection };
  }
  if (!tab.profileId && app.connection) {
    tab.profileId = app.connection.id;
    tab.database = tab.database || app.database || null;
    renderQueryTabs();
    const label = $('#queryTargetLabel');
    if (label) label.textContent = `${queryTargetLabel(tab)}${table ? ` · ${table}` : ''} · Ctrl+Enter / Ctrl+E`;
    const bindButton = $('#bindQueryTargetBtn');
    if (bindButton) bindButton.style.display = 'none';
    persistState();
    return { profileId: tab.profileId, database: tab.database, connection: app.connection };
  }
  if (!app.connection) {
    toast('Tab này chưa có kết nối hợp lệ. Hãy kết nối một máy chủ trong sidebar trước.', 'error');
    return null;
  }
  const bound = await bindQueryTargetToActive(tab);
  if (!bound) return null;
  return { profileId: tab.profileId, database: tab.database, connection: app.connection };
}

async function bindQueryTargetToActive(tab = app.query) {
  if (!tab) return false;
  if (!app.connection) {
    toast('Chưa có kết nối đang mở để gắn tab.', 'error');
    return false;
  }
  const confirmed = await confirmAction(
    'Gắn tab truy vấn vào kết nối?',
    `Tab "${tab.title}" ${tab.profileId ? 'đang trỏ tới kết nối không còn tồn tại' : 'chưa được gắn kết nối'}.\n\nChạy trên: ${app.connection.name} · ${app.database || 'không chọn database'}.`,
    'Gắn'
  );
  if (!confirmed) return false;
  tab.profileId = app.connection.id;
  tab.database = app.database || null;
  renderQueryTabs();
  const label = $('#queryTargetLabel');
  if (label) label.textContent = `${queryTargetLabel(tab)}${table ? ` · ${table}` : ''} · Ctrl+Enter / Ctrl+E`;
  const bindButton = $('#bindQueryTargetBtn');
  if (bindButton) bindButton.style.display = 'none';
  persistState();
  return true;
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

function loadAutocompleteColumns(database, tableName, profileId = app.connection?.id) {
  if (!desktop || !profileId || !database || !tableName) return Promise.resolve([]);
  return sqlAutocomplete.columnCache.load([profileId, database, tableName],
    () => call(desktop.db.columns(database, tableName, profileId)));
}

function autocompleteTarget() {
  const tab = app.query;
  const connection = queryTargetConnection(tab) || (!tab?.profileId ? app.connection : null);
  return { profileId: connection?.id || null,
    database: tab?.profileId ? tab.database || null : tab?.database || app.database || null };
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
  context.scrollTop = editor.scrollTop;
  context.scrollLeft = editor.scrollLeft;
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

function autocompleteReferenceHasColumns(reference) {
  return !reference.local || Array.isArray(reference.columnNames) && reference.columnNames.length > 0;
}

function resolveAutocompleteReference(context, qualifier, useCurrentTables = true) {
  if (context.scopeKnown === false) return null;
  const references = context.references.filter(entry => (entry.alias || entry.table) === qualifier);
  if (references.length) return references.length === 1 && autocompleteReferenceHasColumns(references[0]) ? references[0] : null;
  if (context.references.length || context.allowQualifierCatalog === false || !useCurrentTables) return null;
  const objects = app.tables.filter(entry => entry.name === qualifier);
  return objects.length === 1 ? { table: objects[0].name } : null;
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
  if (context.disabled || Number.isFinite(editor.selectionEnd) && editor.selectionEnd !== editor.selectionStart
      || (!force && !context.qualifier && !context.prefix && !expectsTable && !context.expectsColumn)) {
    closeSqlSuggestions();
    return;
  }

  const requestId = ++sqlAutocomplete.requestId;
  const target = autocompleteTarget();
  context.tab = app.query;
  context.target = target;
  const captured = {
    tabId: app.query?.id,
    connectionId: app.connection?.id,
    database: app.database,
    value: editor.value,
    caret: editor.selectionStart
  };
  const useCurrentTables = context.scopeKnown !== false && target.profileId === app.connection?.id && target.database === app.database;
  const tables = useCurrentTables ? tableAutocompleteItems() : [];
  let baseItems;
  if (context.qualifier) {
    baseItems = [];
  } else if (context.expectsColumn) {
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
    const reference = resolveAutocompleteReference(context, context.qualifier, useCurrentTables);
    if (reference) targets = [reference];
  } else if (!expectsTable) {
    const seen = new Set();
    const owners = new Map();
    for (const reference of context.references) {
      const owner = reference.alias || reference.table;
      owners.set(owner, (owners.get(owner) || 0) + 1);
    }
    targets = context.references.filter((reference) => {
      if (!autocompleteReferenceHasColumns(reference) || owners.get(reference.alias || reference.table) !== 1) return false;
      const key = JSON.stringify([reference.database || target.database || '', reference.table, reference.alias || null]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 5);
  }
  if (!targets.length) return;

  const columnGroups = await Promise.all(targets.map(async (reference) => ({
    reference,
    columns: reference.local ? reference.columnNames.map(name => ({ name, type: '' }))
      : await loadAutocompleteColumns(reference.database || target.database, reference.table, target.profileId)
  })));
  if (requestId !== sqlAutocomplete.requestId
      || editor !== $('#sql')
      || !editor.isConnected
      || mode !== 'query'
      || app.query?.id !== captured.tabId
      || app.connection?.id !== captured.connectionId
      || app.database !== captured.database
      || autocompleteTarget().profileId !== target.profileId
      || autocompleteTarget().database !== target.database
      || editor.value !== captured.value
      || editor.selectionStart !== captured.caret
      || Number.isFinite(editor.selectionEnd) && editor.selectionEnd !== captured.caret) return;

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
      detail: reference.local
        ? `${reference.columnSource === 'derived-select' ? 'Derived' : 'CTE'} · ${reference.table} · ${reference.columnSource ? 'tên từ SELECT' : 'cột khai báo'}`
        : `${reference.table} · ${column.type || 'column'}`
    };
  }));
  renderSqlSuggestions(editor, context, api.rankSuggestions([...columnItems, ...baseItems], context.prefix, 60));
}

function acceptSqlSuggestion(editor, index = sqlAutocomplete.selected) {
  const item = sqlAutocomplete.items[index];
  const context = sqlAutocomplete.context;
  if (!editor || !item || !context) return;
  const target = autocompleteTarget();
  if (context.disabled || sqlAutocomplete.composing || editor !== $('#sql') || !editor.isConnected || mode !== 'query'
      || context.tab !== app.query || context.target?.profileId !== target.profileId || context.target?.database !== target.database
      || editor.value !== context.value || editor.selectionStart !== context.caret
      || editor.selectionEnd !== context.caret
      || !Number.isInteger(context.start) || !Number.isInteger(context.end)
      || context.start < 0 || context.start > context.caret || context.end < context.caret
      || context.end > editor.value.length) {
    closeSqlSuggestions();
    return;
  }
  const before = sqlEditorSnapshot(editor);
  let insertText = String(item.insertText ?? item.label);
  const existingCall = item.type === 'function' && /\(\)$/.test(insertText)
    ? /^[ \t\n\r\f]*\(/.exec(editor.value.slice(context.end)) : null;
  if (existingCall) insertText = insertText.slice(0, -2);
  editor.setRangeText(insertText, context.start, context.end, 'end');
  if (existingCall || /\(\)$/.test(insertText)) {
    const caret = existingCall ? editor.selectionStart + existingCall[0].length : editor.selectionStart - 1;
    editor.setSelectionRange(caret, caret);
  }
  recordSqlEditorChange(editor, { before });
  closeSqlSuggestions();
  editor.focus();
}

function normalizeHistory(item) {
  if (typeof QuerySnippets !== 'undefined' && typeof QuerySnippets.normalizeHistoryEntry === 'function') {
    return QuerySnippets.normalizeHistoryEntry(item);
  }
  if (typeof item === 'string') return { id: `h_${Date.now()}`, sql: item, ok: true, at: '', durationMs: null, message: '', profileId: null, database: null, tags: [] };
  if (!item || typeof item !== 'object' || typeof item.sql !== 'string') return null;
  return {
    id: typeof item.id === 'string' && item.id ? item.id : `h_${Date.now()}`,
    sql: item.sql,
    ok: item.ok !== false,
    at: typeof item.at === 'string' ? item.at : '',
    durationMs: Number.isFinite(item.durationMs) ? item.durationMs : null,
    message: typeof item.message === 'string' ? item.message : '',
    profileId: typeof item.profileId === 'string' ? item.profileId : null,
    database: typeof item.database === 'string' ? item.database : null,
    tags: Array.isArray(item.tags) ? item.tags : []
  };
}

function normalizeSnippetItem(item) {
  if (typeof QuerySnippets !== 'undefined' && typeof QuerySnippets.normalizeSnippet === 'function') {
    return QuerySnippets.normalizeSnippet(item);
  }
  return null;
}

function normalizeSavedQuery(item) {
  if (!item || typeof item !== 'object' || typeof item.sql !== 'string') return null;
  const name = typeof item.name === 'string' && item.name.trim()
    ? item.name.trim().slice(0, 80)
    : 'Truy vấn không tên';
  return {
    id: typeof item.id === 'string' && item.id ? item.id : `saved-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name,
    sql: item.sql,
    profileId: typeof item.profileId === 'string' ? item.profileId : null,
    database: typeof item.database === 'string' ? item.database : null,
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString()
  };
}

function captureRendererState() {
  syncActiveQuery();
  return {
    connectionId: app.connection ? app.connection.id : null,
    workspaceId: app.activeWorkspaceId,
    database: app.database,
    table,
    mode: mode === 'transfer' ? 'backups' : mode,
    savedQuery: app.query?.sql ?? queryDraftCache,
    queryTabs: queryTabs.map((tab) => ({
      timeoutMs: queryTimeoutMs(tab),
      rowLimit: queryRowLimit(tab),
      title: tab.title,
      sql: tab.sql ?? '',
      profileId: tab.profileId || null,
      database: tab.database || null
    })),
    activeQuery,
    history: historyRows.slice(0, 500),
    savedQueries: savedQueries.slice(0, 200),
    snippets: snippets.slice(0, 200),
    maskData: Boolean(app.maskData)
  };
}

let stateSaveErrorShown = false;
async function saveRendererStateNow() {
  if (!desktop) return false;
  try {
    await desktop.saveState(captureRendererState());
    stateSaveErrorShown = false;
    return true;
  } catch (error) {
    if (!stateSaveErrorShown) toast('Chưa lưu được trạng thái: ' + (error.message || 'Hãy kiểm tra quyền truy cập và dung lượng ổ đĩa.'), 'error');
    stateSaveErrorShown = true;
    return false;
  }
}

let persistTimer;
function persistState() {
  if (!desktop) return;
  syncActiveQuery();
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    void saveRendererStateNow();
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
      call(desktop.db.tables(database, connectionId)), call(desktop.db.relations(database, null, connectionId))
    ]);

    // Load columns for each table (up to 30 tables to avoid overload)
    const tablesToLoad = tablesList.slice(0, 30);
    await Promise.all(tablesToLoad.map(async (t) => {
      try {
        const cols = await call(desktop.db.columns(database, t.name, connectionId));
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
          <button class="close-btn" data-click="close-modal">✕</button>
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

function restoreQueryTab(tab, index) {
  return {
    id: index + 1,
    title: tab && typeof tab.title === 'string' && tab.title.trim()
      ? tab.title.trim().slice(0, 40) : `Query ${index + 1}`,
    sql: tab && typeof tab.sql === 'string' ? tab.sql : '',
    timeoutMs: queryTimeoutMs(tab),
    rowLimit: queryRowLimit(tab),
    result: null,
    error: null,
    running: false,
    // Legacy/missing targets remain unbound. A sidebar choice cannot prove
    // where a recovered SQL draft was intended to execute.
    profileId: tab && typeof tab.profileId === 'string' && tab.profileId ? tab.profileId : null,
    database: tab && typeof tab.database === 'string' && tab.database ? tab.database : null,
    taskId: null
  };
}

async function init() {
  initTheme();
  setupContextMenu();
  $('#treeSearch').addEventListener('input', debounce(renderSidebar, 180));
  $('#workspaceSelect').addEventListener('change', (event) => switchWorkspace(event.target.value));
  $('#connectionList').addEventListener('click', onConnectionClick);
  $('#connectionList').addEventListener('keydown', activateSidebarItem);
  $('#workspace').addEventListener('click', onBackupManagerClick);
  $('#transactionBar')?.addEventListener('click', (event) => {
    const action = event.target.closest('[data-transaction-action]')?.dataset.transactionAction;
    if (action) void finishTransaction(action);
  });
  $('#workspace').addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-backup-row]')) {
      event.preventDefault();
      app.selectedBackupId = event.target.dataset.backupRow;
      renderBackupsView();
      renderSidebar();
    }
  });
  $('#tabs').addEventListener('click', onTabClick);
  $('#tabs').addEventListener('dblclick', onTabDblClick);

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
    if (progress.scheduled && progress.stage === 'scheduled-finish') {
      const labels = { completed: 'Đã lưu backup theo lịch', canceled: 'Đã hủy backup theo lịch', failed: 'Backup theo lịch có lỗi' };
      setStatus(`${labels[progress.status] || 'Backup theo lịch đã kết thúc'} · ${progress.database || ''}${progress.needsReview ? ' · Cần xem lại kết quả' : ''}`);
      return;
    }
    updateTransferProgress(progress);
    if (progress.operation === 'backup') {
      setStatus(`Đang sao lưu… ${progress.rows || 0} dòng · ${formatBytes(progress.bytes)}`);
    } else if (progress.operation === 'restore') {
      if (progress.phase === 'scan') {
        setStatus(`Đang kiểm tra phạm vi tệp… ${progress.statements || 0} câu lệnh · ${formatBytes(progress.bytes)}`);
      } else {
        setStatus(`Đang phục hồi… ${progress.executed || 0} câu lệnh · ${formatBytes(progress.bytes)}`);
      }
    } else if (progress.operation === 'export') {
      setStatus(`Đang xuất… ${progress.rows || 0} dòng · ${formatBytes(progress.bytes)}`);
    } else if (progress.operation === 'import') {
      setStatus(`Đang nhập… ${progress.rows || 0} dòng đã đọc · ${formatBytes(progress.bytes)}`);
    }
  });
  $('#modal').addEventListener('cancel', (event) => {
    if ($('#modal [data-transfer-running]')) event.preventDefault();
  });

  let saved = {};
  try {
    saved = await desktop.loadState();
  } catch (error) {
    saved = {};
    toast(error.message || 'Không đọc được trạng thái đã lưu. Tệp được giữ nguyên.', 'error');
  }
  if (saved && Array.isArray(saved.queryTabs) && saved.queryTabs.length) {
    queryTabs = saved.queryTabs.slice(0, 50).map(restoreQueryTab);
    queryId = queryTabs.length;
    activeQuery = Number.isInteger(saved.activeQuery)
      ? Math.min(Math.max(saved.activeQuery, 0), queryTabs.length - 1)
      : 0;
    app.query = queryTabs[activeQuery];
  }
  if (saved && typeof saved.savedQuery === 'string' && saved.savedQuery) {
    if (!Array.isArray(saved.queryTabs) || !saved.queryTabs.length) queryTabs[0].sql = saved.savedQuery;
    queryDraftCache = saved.savedQuery;
  }
  if (saved && Array.isArray(saved.history)) {
    historyRows = saved.history.map(normalizeHistory).filter(Boolean).slice(0, 500);
  }
  if (saved && Array.isArray(saved.savedQueries)) {
    savedQueries = saved.savedQueries.map(normalizeSavedQuery).filter(Boolean).slice(0, 200);
  }
  if (saved && Array.isArray(saved.snippets)) {
    snippets = saved.snippets.map(normalizeSnippetItem).filter(Boolean).slice(0, 200);
  }
  if (!snippets.length && typeof QuerySnippets !== 'undefined' && typeof QuerySnippets.defaultSnippets === 'function') {
    snippets = QuerySnippets.defaultSnippets();
  }
  if (saved && typeof saved.table === 'string') table = saved.table;
  if (saved && typeof saved.workspaceId === 'string') app.activeWorkspaceId = saved.workspaceId;
  app.maskData = Boolean(saved && saved.maskData);

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
  invalidateSqlAutocomplete();
  if (!desktop) {
    app.connections = [];
    ensureDefaultWorkspace();
    renderWorkspaceSwitcher();
    renderSidebar();
    return;
  }
  app.connections = await call(desktop.connections.list());
  if (desktop.db?.openProfiles) {
    const ids = await call(desktop.db.openProfiles());
    openConnectionIds.clear();
    for (const id of ids) openConnectionIds.add(id);
  }
  ensureDefaultWorkspace();
  invalidateSqlAutocomplete();
  if (app.connection) {
    const current = app.connections.find((connection) => connection.id === app.connection.id);
    if (current) app.connection = current;
  }
  renderWorkspaceSwitcher();
  renderSidebar();
}

function renderSidebar() {
  const list = $('#connectionList');
  if (!list) return;
  const scrollTop = list.scrollTop;
  const term = ($('#treeSearch').value || '').trim().toLowerCase();
  const workspaceConnections = app.connections.filter((connection) => (
    connection.workspaceId || DEFAULT_WORKSPACE_ID
  ) === app.activeWorkspaceId);
  const connections = workspaceConnections.filter((connection) => {
    if (!term) return true;
    return [connection.name, connection.host, connection.user, connection.database,
      ...(app.connection?.id === connection.id ? app.databases : []),
      ...(app.connection?.id === connection.id ? app.tables.map((entry) => entry.name) : [])]
      .some((value) => String(value || '').toLowerCase().includes(term));
  });

  const activeBranch = app.connection ? renderDatabaseBranch(term) : '';
  const chevronSvg = `<svg class="tree-chevron-svg" viewBox="0 0 16 16" width="9" height="9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5l4.5 4.5-4.5 4.5"/></svg>`;

  const activeConnectionId = app.connection?.id;
  const hasActiveInList = Boolean(activeConnectionId && connections.some((c) => c.id === activeConnectionId));

  const connectionHtml = connections.map((connection) => {
    const active = Boolean(
      app.connection && (
        connection.id === activeConnectionId ||
        (!hasActiveInList && connections.length === 1)
      )
    );
    const isExpanded = active && !collapsedConnections.has(connection.id);
    const typeLabel = connection.type === 'mariadb' ? 'MARIA' : 'MYSQL';
    return `
      <div class="connitem ${active ? 'active' : ''}" data-connection-id="${esc(connection.id)}">
        <div class="connhead">
          <button class="conn-open" data-connection="${esc(connection.id)}" aria-label="Kết nối ${esc(connection.name)}"${active ? ' aria-current="true"' : ''}${active ? ` aria-expanded="${isExpanded}"` : ''}>
            <span class="tree-chevron ${isExpanded ? 'open' : ''}" data-toggle-conn="${esc(connection.id)}">${chevronSvg}</span>
            <i class="dot ${active || openConnectionIds.has(connection.id) ? 'connected' : ''}"></i>
            <span class="name" title="${esc(connection.name)}">${esc(connection.name)}</span>
            <span class="badge type">${typeLabel}</span>
          </button>
          <button class="more" data-menu="${esc(connection.id)}" title="Tùy chọn" aria-label="Tùy chọn kết nối ${esc(connection.name)}">···</button>
        </div>
        <div class="connmeta" title="${esc(connection.user || 'root')}@${esc(connection.host)}:${connection.port} · ${esc(connectionSecuritySummary(connection))}">${connectionEnvironmentBadge(connection)} ${esc(connection.user || 'root')}@${esc(connection.host)}:${connection.port}${connection.ssh?.enabled ? ' · SSH' : ''} · ${esc(connectionTransportBadge(connection))}</div>
        ${isExpanded ? `<div class="conn-children">${activeBranch}</div>` : ''}
      </div>
    `;
  }).join('');

  list.innerHTML = connectionHtml || `
    <div class="empty small">
      ${term ? 'Không có kết nối phù hợp.' : `Workspace <strong>${esc(activeWorkspace().name)}</strong> chưa có kết nối.`}<br>
      <button data-click="new-connection">Kết nối mới</button>
      <button data-click="import-navicat">Nhập Navicat</button>
    </div>
  `;
  list.scrollTop = scrollTop;

}

function routineGroupContent(term) {
  const state = app.routineState;
  const actions = `
    <div class="tree-actions-row">
      <button class="tree-action" data-new-routine="procedure">＋ Procedure</button>
      <button class="tree-action" data-new-routine="function">＋ Function</button>
      <button class="tree-action" data-refresh-routines="1" title="Làm mới routines">↻</button>
    </div>`;
  if (state.loading) return `${actions}<div class="tree-empty">Đang tải routines…</div>`;
  if (state.error) return `${actions}<div class="tree-empty tree-error">${esc(state.error)}</div><button class="tree-action" data-refresh-routines="1">↻ Thử lại</button>`;
  if (!state.loaded) return `${actions}<div class="tree-empty">Đang chờ tải routines…</div>`;
  if (!state.data.length) return `${actions}<div class="tree-empty">Database không có procedure/function.</div>`;
  const entries = state.data.filter((entry) => !term || entry.name.toLowerCase().includes(term) || entry.type.includes(term));
  return `${actions}${entries.map((entry) => `
    <button class="tree-action routine-entry" data-routine="${esc(entry.name)}" data-routine-kind="${esc(entry.type)}" title="${esc(`${entry.type.toUpperCase()} ${entry.name}${entry.comment ? ` · ${entry.comment}` : ''}`)}">
      <span class="tree-item-icon">ƒ</span>${esc(entry.name)}<span class="tree-kind">${entry.type === 'function' ? 'FUNC' : 'PROC'}</span>
    </button>`).join('') || '<div class="tree-empty">Không có routine phù hợp.</div>'}`;
}

function eventGroupContent(term) {
  const state = app.eventState;
  const actions = `
    <div class="tree-actions-row">
      <button class="tree-action" data-new-event="1">＋ Event</button>
      <button class="tree-action" data-refresh-events="1" title="Làm mới events">↻</button>
    </div>`;
  if (state.loading) return `${actions}<div class="tree-empty">Đang tải events…</div>`;
  if (state.error) return `${actions}<div class="tree-empty tree-error">${esc(state.error)}</div><button class="tree-action" data-refresh-events="1">↻ Thử lại</button>`;
  if (!state.loaded) return `${actions}<div class="tree-empty">Đang chờ tải events…</div>`;
  if (!state.data.length) return `${actions}<div class="tree-empty">Database không có event.</div>`;
  const entries = state.data.filter((entry) => !term || entry.name.toLowerCase().includes(term));
  return `${actions}${entries.map((entry) => `
    <button class="tree-action routine-entry" data-event="${esc(entry.name)}" title="${esc(`${entry.status} · ${entry.definer || ''}`)}">
      <span class="tree-item-icon">◷</span>${esc(entry.name)}<span class="tree-kind">${esc(entry.status || 'EVENT')}</span>
    </button>`).join('') || '<div class="tree-empty">Không có event phù hợp.</div>'}`;
}

function savedQueriesGroupContent(term) {
  const entries = savedQueries.filter((entry) => (
    !term || entry.name.toLowerCase().includes(term) || entry.sql.toLowerCase().includes(term)
  ));
  const connectionName = (profileId) => {
    if (!profileId) return 'không rõ connection';
    const connection = app.connections.find((item) => item.id === profileId);
    return connection ? connection.name : 'connection đã xóa';
  };
  return `<div class="tree-actions-row">
      <button class="tree-action" data-new-query="1">＋ Truy vấn mới</button>
      <button class="tree-action" data-save-query="1">⌑ Lưu tab…</button>
    </div>
    ${entries.map((entry) => `
      <div class="tree-action saved-query-entry" data-saved-query="${esc(entry.id)}" role="button" tabindex="0" title="${esc(`${entry.name} · ${connectionName(entry.profileId)} · ${entry.database || 'không chọn database'}`)}">
        <span class="saved-query-name">⌑ ${esc(entry.name)}</span>
        <span class="saved-query-target">${esc(connectionName(entry.profileId))} · ${esc(entry.database || '—')}</span>
        <button class="saved-query-action" data-rename-saved-query="${esc(entry.id)}" title="Đổi tên" aria-label="Đổi tên ${esc(entry.name)}">✎</button>
        <button class="saved-query-action" data-delete-saved-query="${esc(entry.id)}" title="Xóa" aria-label="Xóa ${esc(entry.name)}">×</button>
      </div>`).join('') || '<div class="tree-empty">Chưa có truy vấn đã lưu.</div>'}`;
}

function renderDatabaseBranch(term) {
  const dbList = (app.database && !app.databases.includes(app.database)) ? [app.database, ...app.databases] : app.databases;
  const databases = dbList.filter((name) => !term || name.toLowerCase().includes(term) ||
    (name === app.database && app.tables.some((entry) => entry.name.toLowerCase().includes(term))));

  const tables = app.tables.filter((entry) => entry.type === 'table' && (!term || entry.name.toLowerCase().includes(term)));
  const views = app.tables.filter((entry) => entry.type === 'view' && (!term || entry.name.toLowerCase().includes(term)));

  const chevronSvg = `<svg class="tree-chevron-svg" viewBox="0 0 16 16" width="9" height="9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5l4.5 4.5-4.5 4.5"/></svg>`;

  const group = (id, iconSvg, label, content, count = null) => `
    <div class="treegroup-block">
      <button class="treegroup-toggle" data-tree-group="${id}" aria-expanded="${openTreeGroups.has(id)}">
        <span class="tree-chevron ${openTreeGroups.has(id) ? 'open' : ''}">${chevronSvg}</span>
        <span class="tree-icon">${iconSvg}</span>
        <span class="tree-group-label">${label}</span>
        ${count === null ? '' : `<span class="tree-count">${count}</span>`}
      </button>
      ${openTreeGroups.has(id) ? `<div class="treegroup-children">${content}</div>` : ''}
    </div>`;

  const objectItem = (entry, iconSvg) => `
    <div class="treeitem ${entry.name === table ? 'selected' : ''}" data-table="${esc(entry.name)}" role="button" tabindex="0" title="${esc(entry.name)}" aria-label="Mở ${entry.type === 'view' ? 'view' : 'bảng'} ${esc(entry.name)}"${entry.name === table ? ' aria-current="true"' : ''}>
      <span class="tree-item-icon">${iconSvg}</span>
      <span class="tree-object-name">${esc(entry.name)}</span>
      ${entry.rowEstimate !== null && entry.type === 'table' ? `<span class="rowcount" title="${entry.rowEstimate} bản ghi">${Number(entry.rowEstimate).toLocaleString()}</span>` : ''}
    </div>`;

  const tableIcon = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><line x1="2" y1="6.5" x2="14" y2="6.5"/><line x1="6.5" y1="6.5" x2="6.5" y2="13.5"/></svg>`;
  const viewIcon = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="2.5" width="12" height="11" rx="1.5" stroke-dasharray="2 1.5"/><line x1="2" y1="6.5" x2="14" y2="6.5"/><line x1="7" y1="6.5" x2="7" y2="13.5"/></svg>`;
  const fnIcon = `<span style="font-style:italic;font-weight:bold;font-family:serif;font-size:12px;line-height:1">ƒ</span>`;
  const eventIcon = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="8" r="5.5"/><polyline points="8 4.5 8 8 10.5 9.5"/></svg>`;
  const queryIcon = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6"><polyline points="4 6 7 8.5 4 11"/><line x1="8" y1="11" x2="12" y2="11"/></svg>`;
  const backupIcon = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 2.5v7m-3-3l3 3 3-3M2.5 13h11"/></svg>`;

  const groups = `
    ${group('tables', tableIcon, 'Tables', `<button class="tree-action" id="createTableBtn">＋ Tạo bảng</button>${tables.map((entry) => objectItem(entry, tableIcon)).join('') || '<div class="tree-empty">Không có bảng</div>'}`, tables.length)}
    ${group('views', viewIcon, 'Views', views.map((entry) => objectItem(entry, viewIcon)).join('') || '<div class="tree-empty">Không có view</div>', views.length)}
    ${group('routines', fnIcon, 'Routines', routineGroupContent(term), app.routineState.loaded ? app.routineState.data.length : null)}
    ${group('events', eventIcon, 'Events', eventGroupContent(term), app.eventState.loaded ? app.eventState.data.length : null)}
    ${group('queries', queryIcon, 'Queries', savedQueriesGroupContent(term), savedQueries.length)}
    ${group('backups', backupIcon, 'Backups', `${app.backups.map((backup) => `<button class="tree-action backup-entry ${app.selectedBackupId === backup.id && mode === 'backups' ? 'selected' : ''}" data-restore-backup="${esc(backup.id)}" title="${esc(backup.createdAt)} · ${formatBytes(backup.bytes)}">◴ ${esc(backup.name)}</button>`).join('') || '<div class="tree-empty">Chưa có bản sao lưu</div>'}`, app.backups.length)}`;

  const dbSvg = `<svg class="db-svg-icon" viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
    <ellipse cx="8" cy="3.5" rx="5.5" ry="2"/>
    <path d="M2.5 3.5v3.5c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V3.5"/>
    <path d="M2.5 7v3.5c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V7"/>
    <path d="M2.5 10.5v2c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-2"/>
  </svg>`;

  return `<div class="sideheading sub">DATABASE <span class="headingactions"><button id="createDbBtn" title="Tạo database mới">＋</button><button data-refresh-dbs="1" title="Làm mới">↻</button></span></div>
    ${databases.map((name) => {
      const isSelected = name === app.database;
      const isExpanded = isSelected && !collapsedDbs.has(name);
      return `<div class="database dbitem ${isSelected ? 'selected' : ''}" data-db="${esc(name)}" role="button" tabindex="0" title="${esc(name)}" aria-label="Mở database ${esc(name)}"${isExpanded ? ' aria-expanded="true"' : ''}>
        <span class="tree-chevron ${isExpanded ? 'open' : ''}" data-toggle-db="${esc(name)}">${chevronSvg}</span>
        <span class="tree-db-icon">${dbSvg}</span>
        <span class="db-name">${esc(name)}</span>
      </div>${isExpanded ? `<div class="db-children">${groups}</div>` : ''}`;
    }).join('') || '<div class="tree-empty">Không có database phù hợp.</div>'}`;
}

function emptyObjectState() {
  return { loading: false, loaded: false, error: '', data: [] };
}

function resetObjectMetadata() {
  app.routineState = emptyObjectState();
  app.eventState = emptyObjectState();
}

function loadOpenObjectGroups() {
  if (!app.connection || !app.database) return;
  if (openTreeGroups.has('routines')) loadObjectMetadata('routines');
  if (openTreeGroups.has('events')) loadObjectMetadata('events');
}

async function loadObjectMetadata(kind, { force = false } = {}) {
  if (!desktop?.db || !app.connection || !app.database) return;
  const state = kind === 'events' ? app.eventState : app.routineState;
  if (!force && (state.loading || state.loaded)) return;
  const profileId = app.connection.id;
  const database = app.database;
  const stateRef = state;
  state.loading = true;
  state.error = '';
  renderSidebar();
  try {
    const data = kind === 'events'
      ? await call(desktop.db.events(database, profileId))
      : await call(desktop.db.routines(database, profileId));
    if (stateRef !== (kind === 'events' ? app.eventState : app.routineState)) return;
    stateRef.data = Array.isArray(data) ? data : [];
    stateRef.loaded = true;
    stateRef.error = '';
  } catch (error) {
    if (stateRef !== (kind === 'events' ? app.eventState : app.routineState)) return;
    stateRef.data = [];
    stateRef.loaded = false;
    stateRef.error = error.message || 'Không tải được metadata.';
  } finally {
    stateRef.loading = false;
    renderSidebar();
  }
}

async function openRoutineDetails(kind, name) {
  if (!app.connection || !app.database) {
    toast('Chưa chọn database.', 'error');
    return;
  }
  const profileId = app.connection.id;
  const database = app.database;
  let detail;
  try {
    detail = await call(desktop.db.showCreate({ profileId, database, name, kind }));
  } catch (error) {
    modal(`
      <h2>Không đọc được ${esc(kind)} ${esc(name)}</h2>
      <div class="errorbox">${esc(error.message)}</div>
      <p class="hint">Lỗi quyền truy cập được hiển thị riêng, không được coi là “chưa có đối tượng”.</p>
      <div class="actions"><button class="primary" data-click="close-modal">Đóng</button></div>
    `);
    return;
  }
  const metaRows = Object.entries(detail.meta || {})
    .filter(([, value]) => value !== null && value !== undefined && String(value) !== '')
    .map(([key, value]) => `<tr><th>${esc(key)}</th><td>${esc(String(value))}</td></tr>`)
    .join('');
  modal(`
    <h2>${esc(kind.toUpperCase())} · ${esc(name)}</h2>
    <p class="hint">${esc(database)} · ${esc(profileId ? (app.connections.find((item) => item.id === profileId)?.name || profileId) : '')}</p>
    ${metaRows ? `<div class="object-meta"><table>${metaRows}</table></div>` : ''}
    <label>SHOW CREATE</label>
    <pre class="object-sql">${esc(detail.sql || 'Không có nội dung SHOW CREATE.')}</pre>
    <div class="actions">
      <button class="danger" id="routineDrop" ${detail.sql ? '' : 'disabled'}>Xóa ${esc(kind)}</button>
      <span class="spacer"></span>
      <button data-click="close-modal">Đóng</button>
      <button class="primary" id="routineEdit" ${detail.sql ? '' : 'disabled'}>Mở trong SQL Editor</button>
    </div>
  `, true);
  $('#routineEdit').addEventListener('click', () => {
    closeModal();
    openRoutineEditor(kind, name, detail.sql);
  });
  $('#routineDrop').addEventListener('click', async () => {
    const confirmed = await confirmAction(
      `Xóa ${kind} ${name}?`,
      `Lệnh DROP ${kind.toUpperCase()} sẽ chạy trên ${database}. Thao tác không thể hoàn tác.`,
      'Xóa'
    );
    if (!confirmed) return;
    try {
      await call(desktop.db.query({
        profileId,
        database,
        sql: `DROP ${kind.toUpperCase()} IF EXISTS ${quoteId(database)}.${quoteId(name)}`,
        confirmed: true
      }));
      closeModal();
      toast(`Đã xóa ${kind} ${name}.`, 'success');
      await loadObjectMetadata(kind === 'event' ? 'events' : 'routines', { force: true });
    } catch (error) {
      toast(error.message, 'error');
    }
  });
}

function stripTrailingSemicolon(sql) {
  return String(sql || '').trim().replace(/\s*;\s*$/, '');
}

function routineEditorSql(kind, database, name, createSql) {
  if (!createSql) return '';
  return `DROP ${kind.toUpperCase()} IF EXISTS ${quoteId(database)}.${quoteId(name)};\n\nDELIMITER $$\n${stripTrailingSemicolon(createSql)}$$\nDELIMITER ;\n`;
}

function openRoutineEditor(kind, name, createSql) {
  if (!app.connection || !app.database) return;
  const target = { profileId: app.connection.id, database: app.database };
  const sql = routineEditorSql(kind, target.database, name, createSql);
  if (!sql) {
    toast('Không có DDL để mở trong SQL Editor.', 'error');
    return;
  }
  newQuery(sql, target);
  app.query.title = `${kind === 'event' ? 'Event' : kind === 'function' ? 'Function' : 'Procedure'} ${name}`.slice(0, 40);
  updateChrome();
  persistState();
}

function newRoutineModal(kind) {
  if (!app.connection || !app.database) {
    toast('Chọn database trước khi tạo routine.', 'error');
    return;
  }
  const target = { profileId: app.connection.id, database: app.database };
  const label = kind === 'event' ? 'Event' : kind === 'function' ? 'Function' : 'Procedure';
  modal(`
    <h2>Tạo ${label.toLowerCase()}</h2>
    <p class="hint">SqlPro mở mẫu SQL trong editor; đây là thao tác bằng SQL, không phải form đồ họa đầy đủ.</p>
    <label>Tên ${label.toLowerCase()}</label>
    <input id="newRoutineName" value="${kind === 'event' ? 'event_moi' : kind === 'function' ? 'function_moi' : 'procedure_moi'}" maxlength="64">
    <div class="actions">
      <button data-click="close-modal">Hủy</button>
      <button class="primary" id="newRoutineGo">Mở SQL Editor</button>
    </div>
  `);
  $('#newRoutineGo').addEventListener('click', () => {
    const name = $('#newRoutineName').value.trim();
    if (!name) {
      toast('Tên không được để trống.', 'error');
      return;
    }
    const database = target.database;
    let sql;
    if (kind === 'event') {
      sql = `DELIMITER $$\nCREATE EVENT ${quoteId(database)}.${quoteId(name)}\nON SCHEDULE EVERY 1 DAY\nDO BEGIN\n  -- Viết nội dung event tại đây\nEND$$\nDELIMITER ;\n`;
    } else if (kind === 'function') {
      sql = `DELIMITER $$\nCREATE FUNCTION ${quoteId(database)}.${quoteId(name)}()\nRETURNS INT\nDETERMINISTIC\nBEGIN\n  RETURN 1;\nEND$$\nDELIMITER ;\n`;
    } else {
      sql = `DELIMITER $$\nCREATE PROCEDURE ${quoteId(database)}.${quoteId(name)}()\nBEGIN\n  SELECT 1;\nEND$$\nDELIMITER ;\n`;
    }
    closeModal();
    newQuery(sql, target);
  });
}

function openSavedQuery(id) {
  const entry = savedQueries.find((item) => item.id === id);
  if (!entry) return;
  newQuery(entry.sql, { profileId: entry.profileId, database: entry.database }, {
    title: entry.name, savedQueryId: entry.id
  });
}

function saveQuery() {
  const editor = $('#sql');
  if (editor && app.query) app.query.sql = editor.value;
  const query = app.query;
  const sql = query?.sql || '';
  const target = { profileId: query?.profileId || null, database: query?.database || null };
  if (!sql.trim()) {
    toast('Câu lệnh SQL đang trống.', 'error');
    return;
  }
  queryDraftCache = sql;
  let existing = query.savedQueryId
    ? savedQueries.find((entry) => entry.id === query.savedQueryId)
    : null;
  const suggested = existing
    ? existing.name
    : (app.query.title && !/^Query \d+$/.test(app.query.title) ? app.query.title : 'Truy vấn mới');
  modal(`
    <h2>${existing ? 'Cập nhật truy vấn đã lưu' : 'Lưu truy vấn'}</h2>
    <p class="hint">Lưu cục bộ trên máy này cùng connection/database đích. SQL không được đưa vào vault đồng bộ.</p>
    <label>Tên truy vấn</label>
    <input id="savedQueryName" value="${esc(suggested)}" maxlength="80">
    <div class="actions">
      <button data-click="close-modal">Hủy</button>
      <button class="primary" id="savedQueryGo">Lưu</button>
    </div>
  `);
  const revision = modalRevision;
  let saving = false;
  $('#savedQueryGo').addEventListener('click', async () => {
    if (saving || revision !== modalRevision) return;
    const name = $('#savedQueryName').value.trim();
    if (!name) {
      toast('Tên truy vấn không được để trống.', 'error');
      return;
    }
    const now = new Date().toISOString();
    if (!queryTabs.includes(query) || query.profileId !== target.profileId || query.database !== target.database
      || (existing && !savedQueries.includes(existing))) {
      toast('Tab hoặc đích truy vấn đã thay đổi. Hãy mở lại thao tác lưu.', 'error');
      return;
    }
    if (existing) {
      existing.name = name.slice(0, 80);
      existing.sql = sql;
      existing.profileId = target.profileId;
      existing.database = target.database;
      existing.updatedAt = now;
    } else {
      const entry = {
        id: `saved-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: name.slice(0, 80),
        sql,
        ...target,
        createdAt: now,
        updatedAt: now
      };
      savedQueries.unshift(entry);
      existing = entry;
      query.savedQueryId = entry.id;
    }
    query.title = name.slice(0, 40);
    renderQueryTabs();
    savedQueries = savedQueries.slice(0, 200);
    openTreeGroups.add('queries');
    renderSidebar();
    saving = true;
    const saved = await saveRendererStateNow();
    saving = false;
    if (!saved || revision !== modalRevision) return;
    closeModal();
    toast('Đã lưu truy vấn trên máy.');
  });
}

function renameSavedQuery(id) {
  const entry = savedQueries.find((item) => item.id === id);
  if (!entry) return;
  modal(`
    <h2>Đổi tên truy vấn</h2>
    <label>Tên mới</label>
    <input id="renameSavedQueryName" value="${esc(entry.name)}" maxlength="80">
    <div class="actions">
      <button data-click="close-modal">Hủy</button>
      <button class="primary" id="renameSavedQueryGo">Đổi tên</button>
    </div>
  `);
  $('#renameSavedQueryGo').addEventListener('click', () => {
    const name = $('#renameSavedQueryName').value.trim();
    if (!name) {
      toast('Tên truy vấn không được để trống.', 'error');
      return;
    }
    entry.name = name.slice(0, 80);
    entry.updatedAt = new Date().toISOString();
    persistState();
    renderSidebar();
    closeModal();
  });
}

async function deleteSavedQuery(id) {
  const entry = savedQueries.find((item) => item.id === id);
  if (!entry) return;
  const confirmed = await confirmAction('Xóa truy vấn đã lưu?', `"${entry.name}" sẽ bị xóa khỏi danh sách cục bộ.`, 'Xóa');
  if (!confirmed) return;
  savedQueries = savedQueries.filter((item) => item.id !== id);
  persistState();
  renderSidebar();
  toast('Đã xóa truy vấn đã lưu.');
}

function maybeRefreshObjectMetadata(sql, tab) {
  if (!app.connection || tab.profileId !== app.connection.id) return;
  if ((tab.database || null) !== (app.database || null)) return;
  if (!/\b(?:CREATE|ALTER|DROP)\s+(?:PROCEDURE|FUNCTION|EVENT)\b/i.test(sql)) return;
  if (/\b(?:PROCEDURE|FUNCTION)\b/i.test(sql)) loadObjectMetadata('routines', { force: true });
  if (/\bEVENT\b/i.test(sql)) loadObjectMetadata('events', { force: true });
}

// ==========================================
// SQLPRO ENHANCED CORE FEATURES (P0)
// ==========================================

async function exportCurrentResult(format) {
  if (activeTransfer) { toast('Một tác vụ database đang chạy. Hãy đợi hoặc hủy trước.', 'error'); return; }
  const query = app.query;
  const result = query?.result;
  if (!result) {
    toast('Không có kết quả truy vấn để xuất.', 'error');
    return;
  }
  let target = null;
  let targetSql = result.kind === 'rows' ? (app.query?.lastSql || null) : null;
  let targetDatabase;
  if (result.kind === 'rows') {
    target = result;
  } else if (result.kind === 'batch') {
    const tabKey = app.query.resultTab;
    const entry = (result.results || []).find((item) => item.index === Number(String(tabKey).replace('result-', '')));
    if (entry && entry.result && entry.result.kind === 'rows') {
      target = entry.result;
      targetSql = entry.sql || null;
      targetDatabase = entry.database;
    } else {
      const first = (result.results || []).find((item) => item.ok && item.result?.kind === 'rows');
      if (first) {
        target = first.result;
        targetSql = first.sql || null;
        targetDatabase = first.database;
      }
    }
  }
  if (!target || !target.rows || (!target.rows.length && !target.truncated)) {
    toast('Không tìm thấy dữ liệu dòng để xuất.', 'error');
    return;
  }
  if (!target.isAnalyze && targetSql && typeof desktop.db?.exportQuery === 'function') {
    const taskId = newTransferTaskId('export');
    const profileId = query.resultContext?.profileId || query.profileId || app.connection?.id || null;
    const database = targetDatabase !== undefined ? targetDatabase : (query.resultContext ? query.resultContext.database : (query.database || null));
    showTransferProgress('export', database || 'Kết quả truy vấn', {
      taskId, profileId,
      note: 'SQL được chạy lại để xuất đầy đủ dữ liệu tại thời điểm xuất; không dùng bản xem trước của ô.'
    });
    const transfer = activeTransfer;
    try {
      const response = await call(desktop.db.exportQuery({
        sql: targetSql,
        profileId, database, format, taskId
      }));
      if (response.canceled) {
        if (!response.dialog) toast('Đã hủy xuất dữ liệu. Tệp tạm đã được dọn.');
      } else {
        toast('Đã xuất toàn bộ ' + response.rows + ' dòng ra ' + format.toUpperCase());
      }
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      if (activeTransfer === transfer) { activeTransfer = null; closeModal(); }
    }
    return;
  }
  if (target.truncated || target.rows.some((row) => row.some((value, index) =>
    /^(?:tinyblob|blob|mediumblob|longblob|binary|varbinary|bit)\b/i.test(target.columns[index]?.type || '')
      && typeof value === 'string' && value.includes('…')))) {
    toast(target.isAnalyze ? 'Kết quả ANALYZE bị cắt, chưa đủ để xuất đầy đủ. Có thể sao chép phần đã nhận; thao tác xuất không tự chạy lại truy vấn.'
      : 'Kết quả chỉ có bản xem trước. Hãy chạy lại SQL để xuất dữ liệu đầy đủ.', 'error');
    return;
  }
  const cols = target.columns.map((c) => c.name);
  const rowsToExport = app.maskData && typeof SqlDataMasking !== 'undefined'
    ? SqlDataMasking.maskRows(target.rows, target.columns, SqlDataMasking.createMaskingConfig(target.columns))
    : target.rows;
  if (format === 'csv') {
    const csvContent = '\uFEFF' + [
      cols.map((name) => ExportValues.csvField(name, ',')).join(','),
      ...rowsToExport.map((row) => row.map((value) => ExportValues.csvField(value, ',')).join(','))
    ].join('\r\n');
    desktop.saveTextFile({
      suggestedName: 'query-result.csv',
      contents: csvContent,
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    }).then((res) => {
      if (!res.canceled) {
        toast('Đã xuất ' + target.rows.length + ' dòng ra CSV'
          + (target.truncated ? ' (chỉ các dòng đang hiển thị)' : ''));
        void recordAudit({
          database: targetDatabase || app.database,
          actionType: 'EXPORT',
          summary: `Xuất CSV (${target.rows.length} dòng)`,
          affectedRows: target.rows.length,
          status: 'success'
        });
      }
    }).catch((err) => toast(err.message, 'error'));
  } else {
    const names = ExportValues.uniqueColumnNames(cols);
    const json = '[\n' + rowsToExport.map((row) => '{' + names.map((name, index) =>
      `${JSON.stringify(name)}:${ExportValues.jsonField(row[index], target.columns[index])}`).join(',') + '}').join(',\n') + '\n]';
    desktop.saveTextFile({
      suggestedName: 'query-result.json',
      contents: json,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    }).then((res) => {
      if (!res.canceled) {
        toast('Đã xuất ' + target.rows.length + ' dòng ra JSON'
          + (target.truncated ? ' (chỉ các dòng đang hiển thị)' : ''));
        void recordAudit({
          database: targetDatabase || app.database,
          actionType: 'EXPORT',
          summary: `Xuất JSON (${target.rows.length} dòng)`,
          affectedRows: target.rows.length,
          status: 'success'
        });
      }
    }).catch((err) => toast(err.message, 'error'));
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
      <button data-click="close-modal">Hủy</button>
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
      await call(desktop.db.query({ ...activeQueryTarget(), sql, timeoutMs: 15000, confirmed: true }));
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
    await call(desktop.db.query({ ...activeQueryTarget(), sql, timeoutMs: 15000, confirmed: true }));
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
          <button data-click="close-modal">Hủy</button>
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
        await call(desktop.db.query({ ...activeQueryTarget(), sql: ddl, timeoutMs: 20000, confirmed: true }));
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
    await call(desktop.db.query({ ...activeQueryTarget(), sql, timeoutMs: 15000, confirmed: true }));
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
  const database = app.database;
  showTableDropProgress(database, targetTable);
  setStatus(`Đang xóa bảng ${targetTable}…`);
  try {
    const sql = `DROP TABLE ${quoteId(database)}.${quoteId(targetTable)};`;
    await call(desktop.db.query({ ...activeQueryTarget(), sql, timeoutMs: 300000, confirmed: true }));
    if (table === targetTable) table = null;
    await selectDatabase(database);
    setStatus(`Đã xóa bảng ${targetTable}`);
    modal(`
      <h2>Đã xóa bảng</h2>
      <p>Bảng <strong>${esc(database)}.${esc(targetTable)}</strong> đã được xóa.</p>
      <div class="actions"><button class="primary" data-click="close-modal">Đóng</button></div>
    `);
  } catch (err) {
    setStatus(`Xóa bảng ${targetTable} thất bại`);
    modal(`
      <h2>Xóa bảng thất bại</h2>
      <p>${esc(database)}.${esc(targetTable)}</p>
      <div class="errorbox">${esc(err.message)}</div>
      <div class="actions"><button class="primary" data-click="close-modal">Đóng</button></div>
    `);
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
        <div class="modal-header-left">
          <h3>🖥️ Bảng Điều Khiển Chẩn Đoán <span class="modal-title-tag">Diagnostics</span></h3>
          <div class="diag-tabs" role="tablist">
            <button class="diag-tab-btn active" data-diag-tab="processlist">🖥️ Tiến trình</button>
            <button class="diag-tab-btn" data-diag-tab="locks">🔒 Khóa & Giao dịch</button>
            <button class="diag-tab-btn" data-diag-tab="slow">🐢 Truy vấn chậm</button>
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
          <select id="diagAutoRefreshSelect" class="diag-auto-refresh-select" aria-label="Tự động làm mới" title="Tự động làm mới dữ liệu chẩn đoán">
            <option value="0">Tự động: Tắt</option>
            <option value="3">Tự động: 3s</option>
            <option value="5">Tự động: 5s</option>
            <option value="10">Tự động: 10s</option>
          </select>
          <button class="refresh-header-btn" id="refreshDiagBtn" title="Làm mới dữ liệu chẩn đoán">↻ Làm mới</button>
          <button class="close-btn" data-click="close-modal" title="Đóng (Esc)" aria-label="Đóng">✕</button>
        </div>
      </div>
      <div class="modal-body" id="diagModalBody">
        <div id="diagTabContent">
          <div class="processlist-loading">Đang tải dữ liệu chẩn đoán...</div>
        </div>
      </div>
      <div class="modal-footer">
        <div class="modal-footer-hint">
          <span>💡 <em>Nhấp vào câu lệnh SQL để sao chép nhanh vào bộ nhớ tạm.</em></span>
        </div>
        <button class="secondary" data-click="close-modal">Đóng (Esc)</button>
      </div>
    </div>
  `);

  const target = activeQueryTarget();
  const profileName = app.connection.name || app.connection.host || target.profileId;
  const revision = modalRevision;
  let invalidated = false;
  const isCurrent = () => {
    if (revision !== modalRevision || !$('#modal')?.open
      || target.profileId !== app.connection?.id || target.database !== (app.database || null)) {
      invalidated = true;
      onModalClose();
    }
    return !invalidated;
  };
  const queryDiagnostic = async (payload) => {
    if (!isCurrent()) throw new Error('Đích chẩn đoán đã thay đổi. Hãy mở lại bảng chẩn đoán.');
    const result = await call(desktop.db.query({ ...payload, ...target }));
    if (!isCurrent()) throw new Error('Đích chẩn đoán đã thay đổi. Hãy mở lại bảng chẩn đoán.');
    return result;
  };

  let currentTab = 'processlist';
  let activeQuickFilter = 'all';
  let autoRefreshTimer = null;
  let currentConnectionId = null;
  let serverEngine = null;
  let isFetching = false;
  let processFilterVal = '';

  const dialog = $('#modal');
  const onModalClose = () => {
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
    document.removeEventListener?.('visibilitychange', onVisibilityChange);
  };
  dialog.addEventListener('close', onModalClose, { once: true });

  const onVisibilityChange = () => {
    if (document.hidden) {
      if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
      }
    } else {
      setupAutoRefresh();
    }
  };
  document.addEventListener('visibilitychange', onVisibilityChange);

  function setupAutoRefresh() {
    if (!isCurrent()) return;
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
    const select = $('#diagAutoRefreshSelect');
    const intervalSec = Number(select?.value) || 0;
    if (intervalSec > 0) {
      autoRefreshTimer = setInterval(() => {
        if (!document.hidden && !isFetching && isCurrent()) {
          void refreshCurrentTab();
        }
      }, intervalSec * 1000);
    }
  }

  $('#diagAutoRefreshSelect')?.addEventListener('change', () => {
    setupAutoRefresh();
  });

  async function ensureServerInfo() {
    if (currentConnectionId !== null && serverEngine !== null) return;
    try {
      const res = await queryDiagnostic({ sql: 'SELECT CONNECTION_ID() AS my_id, VERSION() AS ver' });
      if (res && Array.isArray(res.rows) && res.rows.length) {
        currentConnectionId = String(res.rows[0][0]);
        if (typeof SqlDiagnostics !== 'undefined') {
          serverEngine = SqlDiagnostics.detectServerEngine(res.rows[0][1]);
        }
      }
    } catch {
      // ignore
    }
  }

  async function refreshCurrentTab() {
    if (currentTab === 'processlist') await loadProcesslist();
    else if (currentTab === 'locks') await loadLocksAndTransactions();
    else if (currentTab === 'slow') await loadSlowQueries();
  }

  async function loadProcesslist() {
    const container = $('#diagTabContent');
    if (!container || isFetching || !isCurrent()) return;
    isFetching = true;
    try {
      await ensureServerInfo();
      const res = await queryDiagnostic({ sql: 'SHOW FULL PROCESSLIST' });
      if (!isCurrent() || container !== $('#diagTabContent') || currentTab !== 'processlist') return;

      const rawRows = res.rows || [];
      const processes = rawRows.map((r) => {
        if (typeof SqlDiagnostics !== 'undefined') {
          return SqlDiagnostics.parseProcesslistRow(r, currentConnectionId);
        }
        return {
          id: String(r[0]),
          user: String(r[1] || ''),
          host: String(r[2] || ''),
          db: String(r[3] || ''),
          command: String(r[4] || ''),
          timeSec: Number(r[5]) || 0,
          timeFormatted: `${r[5]}s`,
          state: String(r[6] || ''),
          info: String(r[7] || ''),
          isSystem: false,
          isSelf: String(r[0]) === String(currentConnectionId),
          isSlow: Number(r[5]) > 5 && r[4] === 'Query',
          isLocked: /lock/i.test(r[6] || '')
        };
      });

      let queryCount = 0;
      let sleepCount = 0;
      let slowCount = 0;
      let lockedCount = 0;
      for (const p of processes) {
        if (p.command.toLowerCase() === 'query') queryCount++;
        else if (p.command.toLowerCase() === 'sleep') sleepCount++;
        if (p.isSlow) slowCount++;
        if (p.isLocked) lockedCount++;
      }

      const filtered = typeof SqlDiagnostics !== 'undefined'
        ? SqlDiagnostics.filterProcesses(processes, { query: processFilterVal, filterType: activeQuickFilter })
        : processes;

      container.innerHTML = `
        <div class="processlist-toolbar">
          <div class="processlist-search-wrap">
            <span class="processlist-search-icon">🔍</span>
            <input type="search" id="processlistFilter" class="processlist-search-input" placeholder="Lọc theo ID, user, host, database, lệnh, câu lệnh SQL..." value="${esc(processFilterVal)}" autocomplete="off">
          </div>
          <div class="processlist-metrics" id="processlistMetrics">
            <button type="button" class="metric-chip ${activeQuickFilter === 'all' ? 'active' : ''}" data-filter="all">Tất cả <strong>${processes.length}</strong></button>
            <button type="button" class="metric-chip chip-query ${activeQuickFilter === 'query' ? 'active' : ''}" data-filter="query">Đang chạy <strong>${queryCount}</strong></button>
            <button type="button" class="metric-chip chip-sleep ${activeQuickFilter === 'sleep' ? 'active' : ''}" data-filter="sleep">Đang chờ <strong>${sleepCount}</strong></button>
            <button type="button" class="metric-chip chip-slow ${activeQuickFilter === 'slow' ? 'active' : ''}" data-filter="slow">Chậm (>5s) <strong>${slowCount}</strong></button>
            <button type="button" class="metric-chip ${activeQuickFilter === 'locked' ? 'active' : ''}" data-filter="locked">Chờ khóa <strong>${lockedCount}</strong></button>
          </div>
        </div>
        <div class="processlist-table-container">
          ${filtered.length > 0 ? `
            <table class="processlist-table">
              <thead>
                <tr>
                  <th style="width:110px;">ID</th>
                  <th style="width:130px;">User</th>
                  <th style="width:130px;">Host</th>
                  <th style="width:120px;">Database</th>
                  <th style="width:90px;">Lệnh</th>
                  <th style="width:110px;">Thời gian</th>
                  <th style="width:120px;">Trạng thái</th>
                  <th>Câu lệnh SQL</th>
                  <th style="width:160px; text-align:center;">Thao tác an toàn</th>
                </tr>
              </thead>
              <tbody>
                ${filtered.map((p) => {
                  const cmdClass = p.command === 'Query' ? 'active' : (p.command === 'Sleep' ? 'sleep' : '');
                  return `
                    <tr class="${p.isSlow ? 'slow-process-row' : ''}">
                      <td class="proc-id mono">
                        #${esc(p.id)}
                        ${p.isSelf ? '<span class="badge self-badge">Phiên của bạn</span>' : ''}
                        ${p.isSystem ? '<span class="badge system-badge">Hệ thống</span>' : ''}
                      </td>
                      <td class="proc-user" title="${esc(p.user)}"><strong>${esc(p.user)}</strong></td>
                      <td class="proc-host mono" title="${esc(p.host)}">${esc(p.host.length > 20 ? p.host.slice(0, 20) + '…' : p.host)}</td>
                      <td class="proc-db" title="${esc(p.db || '—')}">${p.db ? `<span class="proc-db-badge">${esc(p.db)}</span>` : '<span class="muted">—</span>'}</td>
                      <td><span class="command-badge ${cmdClass}">${esc(p.command)}</span></td>
                      <td>
                        <span class="time-badge ${p.isSlow ? 'time-warn' : ''}">
                          ${p.isSlow ? '⚠️ ' : ''}${p.timeFormatted}
                        </span>
                      </td>
                      <td class="proc-state" title="${esc(p.state || '—')}"><small>${esc(p.state || '—')}</small></td>
                      <td class="proc-sql-cell" title="${esc(p.info ? `${p.info}\n\n(Nhấp chuột để sao chép SQL)` : 'Không có câu lệnh thực thi')}">
                        ${p.info ? `<code class="process-sql" data-full-sql="${esc(p.info)}">${esc(p.info.length > 80 ? p.info.slice(0, 80) + '…' : p.info)}</code>` : '<span class="muted">—</span>'}
                      </td>
                      <td style="text-align:center;">
                        <button class="small-btn kill-query-btn" data-kill-query="${esc(p.id)}" title="Chỉ hủy câu lệnh đang chạy (KILL QUERY), giữ kết nối mở">Dừng SQL</button>
                        <button class="danger small-btn kill-conn-btn kill-btn" data-kill-id="${esc(p.id)}" data-kill-conn="${esc(p.id)}" title="Ngắt kết nối hoàn toàn (KILL CONNECTION)">✕ Kill</button>
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          ` : `
            <div class="processlist-empty">Không có tiến trình nào phù hợp với bộ lọc.</div>
          `}
        </div>
      `;

      const searchInput = $('#processlistFilter');
      if (searchInput) {
        searchInput.addEventListener('input', (e) => {
          processFilterVal = e.target.value;
          loadProcesslist();
          const nextInput = $('#processlistFilter');
          if (nextInput) {
            nextInput.focus();
            nextInput.setSelectionRange(processFilterVal.length, processFilterVal.length);
          }
        });
      }

      $('#processlistMetrics')?.addEventListener('click', (e) => {
        const chip = e.target.closest('.metric-chip');
        if (!chip) return;
        activeQuickFilter = chip.dataset.filter || 'all';
        loadProcesslist();
      });

      container.querySelectorAll('.process-sql').forEach((codeEl) => {
        codeEl.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!isCurrent()) return;
          const sql = codeEl.dataset.fullSql;
          if (sql) {
            if (navigator.clipboard?.writeText) {
              navigator.clipboard.writeText(sql);
            }
            toast('Đã sao chép câu lệnh SQL vào bộ nhớ tạm', 'info');
          }
        });
      });

      container.querySelectorAll('.kill-query-btn').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const killId = btn.dataset.killQuery;
          const p = processes.find((item) => item.id === killId);
          if (!p) return;

          let msg = `Bạn có chắc muốn dừng câu lệnh SQL đang chạy của tiến trình #${killId}?\n` +
            `• User: ${p.user} | Host: ${p.host} | DB: ${p.db || '—'}\n` +
            `• SQL: ${(p.info || '').slice(0, 100) || '—'}`;
          if (p.isSelf) msg += '\n\n⚠️ Chú ý: Đây là phiên SqlPro hiện tại của bạn.';
          if (p.isSystem) msg += '\n\n⚠️ CẢNH BÁO: Đây là tiến trình hệ thống MySQL!';

          const confirmed = await confirmAction(`Dừng câu lệnh SQL #${killId}?`, msg, 'Dừng SQL (KILL QUERY)', { separate: true });
          if (!confirmed || !isCurrent() || container !== $('#diagTabContent')) return;

          try {
            const sql = typeof SqlDiagnostics !== 'undefined' ? SqlDiagnostics.safeKillQuerySql(killId) : `KILL QUERY ${killId}`;
            await queryDiagnostic({ sql, confirmed: true });
            toast(`Đã gửi lệnh dừng SQL cho tiến trình #${killId}`, 'success');
            void recordAudit({ ...target, profileName, actionType: 'KILL', summary: `Dừng câu lệnh SQL (KILL QUERY #${killId})`, status: 'success' });
            await loadProcesslist();
          } catch (err) {
            toast(err.message || 'Lỗi khi dừng câu lệnh SQL', 'error');
            void recordAudit({ ...target, profileName, actionType: 'KILL', summary: `Lỗi khi dừng câu lệnh SQL #${killId}`, status: 'error', errorSummary: err.message });
          }
        });
      });

      container.querySelectorAll('.kill-conn-btn').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const killId = btn.dataset.killConn || btn.dataset.killId;
          const p = processes.find((item) => item.id === killId);
          if (!p) return;

          let msg = `Đóng kết nối của tiến trình #${killId}?\n` +
            `• User: ${p.user} | Host: ${p.host} | DB: ${p.db || '—'}\n` +
            `• SQL: ${(p.info || '').slice(0, 100) || '—'}`;
          if (p.isSelf) msg += '\n\n⚠️ CẢNH BÁO: Đây là phiên kết nối SqlPro hiện tại của bạn! Ngắt kết nối sẽ làm ngắt phiên làm việc đang mở.';
          if (p.isSystem) msg += '\n\n⚠️ CẢNH BÁO NGUY HIỂM: Đây là tiến trình nội bộ hệ thống MySQL (replication/scheduler)! Hủy tiến trình này có thể gây lỗi hệ thống.';

          const confirmed = await confirmAction(`Hủy kết nối #${killId}?`, msg, 'Đóng kết nối (KILL)', { separate: true });
          if (!confirmed || !isCurrent() || container !== $('#diagTabContent')) return;

          try {
            const sql = typeof SqlDiagnostics !== 'undefined' ? SqlDiagnostics.safeKillConnectionSql(killId) : `KILL ${killId}`;
            await queryDiagnostic({ sql, confirmed: true });
            toast(`Đã hủy tiến trình #${killId}`, 'success');
            void recordAudit({ ...target, profileName, actionType: 'KILL', summary: `Đóng kết nối tiến trình (KILL #${killId})`, status: 'success' });
            await loadProcesslist();
          } catch (err) {
            toast(err.message || 'Lỗi khi hủy tiến trình', 'error');
            void recordAudit({ ...target, profileName, actionType: 'KILL', summary: `Lỗi khi hủy tiến trình #${killId}`, status: 'error', errorSummary: err.message });
          }
        });
      });
    } catch (err) {
      if (!isCurrent() || container !== $('#diagTabContent')) return;
      container.innerHTML = `<div class="processlist-error">Lỗi khi đọc Processlist: ${esc(err.message)}</div>`;
    } finally {
      isFetching = false;
    }
  }

  async function loadLocksAndTransactions() {
    const container = $('#diagTabContent');
    if (!container || isFetching || !isCurrent()) return;
    isFetching = true;
    container.innerHTML = '<div class="processlist-loading">Đang phân tích giao dịch và khóa InnoDB...</div>';

    try {
      await ensureServerInfo();
      let trxRows = [];
      try {
        const trxSql = typeof SqlDiagnostics !== 'undefined' ? SqlDiagnostics.getLongTransactionsQuery() : 'SELECT * FROM information_schema.innodb_trx LIMIT 100';
        const resTrx = await queryDiagnostic({ sql: trxSql });
        trxRows = (resTrx.rows || []).map((r) => (typeof SqlDiagnostics !== 'undefined' ? SqlDiagnostics.parseTransactionRow(r) : r));
      } catch {
        // ignore
      }

      let lockRows = [];
      let lockError = null;
      try {
        const lockSql = typeof SqlDiagnostics !== 'undefined' ? SqlDiagnostics.getLockWaitersQuery(serverEngine) : '';
        if (lockSql) {
          const resLock = await queryDiagnostic({ sql: lockSql });
          lockRows = (resLock.rows || []).map((r) => (typeof SqlDiagnostics !== 'undefined' ? SqlDiagnostics.parseLockWaiterRow(r) : r));
        }
      } catch (err) {
        lockError = err.message;
      }

      if (!isCurrent() || container !== $('#diagTabContent') || currentTab !== 'locks') return;

      container.innerHTML = `
        <div class="diag-section">
          <div class="diag-section-header">
            <h4>🔒 Hàng đợi khóa & Tiến trình chặn (Lock Waiters & Blockers)</h4>
            <span class="subtle">${lockRows.length} xung đột khóa</span>
          </div>
          ${lockError ? `
            <div class="diag-notice-box">
              ⚠️ Không thể truy vấn bảng khóa InnoDB (${esc(lockError)}). Tài khoản kết nối hiện tại cần có quyền <code>PROCESS</code> hoặc quyền <code>SELECT</code> trên schema <code>information_schema</code> / <code>performance_schema</code> để xem thông tin khóa.
            </div>
          ` : (lockRows.length > 0 ? `
            <div class="diag-blocker-list">
              ${lockRows.map((w) => `
                <div class="diag-blocker-card">
                  <div class="diag-blocker-header">
                    <strong>⚠️ Tiến trình #${esc(w.blockingThreadId)} đang chặn Tiến trình #${esc(w.waitingThreadId)}</strong>
                    <span class="time-badge time-warn">Đã chờ: ${esc(w.waitTimeFormatted)}</span>
                    <button class="danger small-btn" data-kill-blocker="${esc(w.blockingThreadId)}" title="Dừng tiến trình đang giữ khóa">✕ Kill Blocker #${esc(w.blockingThreadId)}</button>
                  </div>
                  <div style="font-size: 11px; margin-top: 4px;">
                    <div><strong>Câu lệnh đang chờ (Waiter):</strong> <code class="mono">${esc(w.waitingQuery || '(không rõ query)')}</code></div>
                    <div style="margin-top: 2px;"><strong>Câu lệnh đang chặn (Blocker):</strong> <code class="mono">${esc(w.blockingQuery || '(đang giữ transaction / rảnh)')}</code></div>
                  </div>
                </div>
              `).join('')}
            </div>
          ` : `
            <div class="diag-notice-box" style="border-left: 3px solid #10b981; background: #ecfdf5; color: #065f46;">
              ✓ Hệ thống đang hoạt động ổn định. Không phát hiện xung đột khóa (Lock Waits) giữa các tiến trình.
            </div>
          `)}
        </div>

        <div class="diag-section">
          <div class="diag-section-header">
            <h4>⏱️ Giao dịch InnoDB đang hoạt động (Active Transactions)</h4>
            <span class="subtle">${trxRows.length} giao dịch</span>
          </div>
          ${trxRows.length > 0 ? `
            <div class="processlist-table-container" style="max-height: 280px;">
              <table class="processlist-table">
                <thead>
                  <tr>
                    <th style="width:100px;">Trx ID</th>
                    <th style="width:90px;">Thread ID</th>
                    <th style="width:110px;">Trạng thái</th>
                    <th style="width:100px;">Thời gian</th>
                    <th style="width:90px;">Dòng khóa</th>
                    <th style="width:90px;">Dòng sửa</th>
                    <th>Câu lệnh SQL</th>
                  </tr>
                </thead>
                <tbody>
                  ${trxRows.map((t) => `
                    <tr>
                      <td class="mono">#${esc(t.trxId)}</td>
                      <td class="mono">#${esc(t.threadId)}</td>
                      <td><span class="badge ${t.state === 'RUNNING' ? '' : 'pending'}">${esc(t.state)}</span></td>
                      <td><span class="time-badge">${esc(t.durationFormatted)}</span></td>
                      <td class="mono">${esc(String(t.rowsLocked))}</td>
                      <td class="mono">${esc(String(t.rowsModified))}</td>
                      <td class="proc-sql-cell"><code class="process-sql mono">${esc(t.query || '(không có active SQL)')}</code></td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          ` : `
            <div class="processlist-empty">Không có giao dịch InnoDB nào đang hoạt động.</div>
          `}
        </div>
      `;

      container.querySelectorAll('[data-kill-blocker]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const blockerId = btn.dataset.killBlocker;
          const confirmed = await confirmAction(`Hủy tiến trình chặn #${blockerId}?`, `Tiến trình #${blockerId} đang giữ khóa khiến các truy vấn khác phải chờ. Hủy tiến trình này sẽ giải phóng khóa.`, 'Hủy Blocker', { separate: true });
          if (!confirmed || !isCurrent() || container !== $('#diagTabContent')) return;

          try {
            const sql = typeof SqlDiagnostics !== 'undefined' ? SqlDiagnostics.safeKillConnectionSql(blockerId) : `KILL ${blockerId}`;
            await queryDiagnostic({ sql, confirmed: true });
            toast(`Đã hủy tiến trình blocker #${blockerId}`, 'success');
            await loadLocksAndTransactions();
          } catch (err) {
            toast(err.message || 'Lỗi khi hủy tiến trình blocker', 'error');
          }
        });
      });
    } catch (err) {
      if (!isCurrent() || container !== $('#diagTabContent')) return;
      container.innerHTML = `<div class="processlist-error">Lỗi khi phân tích khóa: ${esc(err.message)}</div>`;
    } finally {
      isFetching = false;
    }
  }

  async function loadSlowQueries() {
    const container = $('#diagTabContent');
    if (!container || isFetching || !isCurrent()) return;
    isFetching = true;
    container.innerHTML = '<div class="processlist-loading">Đang đọc cấu hình và lịch sử truy vấn chậm...</div>';

    try {
      let slowLogEnabled = 'OFF';
      let longQueryTime = '—';
      let slowQueriesCount = '0';
      let uptime = '—';

      try {
        const resVars = await queryDiagnostic({ sql: "SHOW GLOBAL VARIABLES WHERE Variable_name IN ('slow_query_log', 'long_query_time', 'log_output', 'slow_query_log_file')" });
        for (const r of (resVars.rows || [])) {
          const key = String(r[0]).toLowerCase();
          const val = String(r[1]);
          if (key === 'slow_query_log') slowLogEnabled = val.toUpperCase();
          else if (key === 'long_query_time') longQueryTime = `${val}s`;
        }
      } catch {}

      try {
        const resStatus = await queryDiagnostic({ sql: "SHOW GLOBAL STATUS WHERE Variable_name IN ('Slow_queries', 'Uptime')" });
        for (const r of (resStatus.rows || [])) {
          const key = String(r[0]).toLowerCase();
          const val = String(r[1]);
          if (key === 'slow_queries') slowQueriesCount = val;
          else if (key === 'uptime' && typeof SqlDiagnostics !== 'undefined') uptime = SqlDiagnostics.formatDuration(val);
        }
      } catch {}

      let slowLogRows = [];
      let slowLogError = null;
      try {
        const slowSql = typeof SqlDiagnostics !== 'undefined' ? SqlDiagnostics.getSlowQueriesQuery() : 'SELECT * FROM mysql.slow_log ORDER BY start_time DESC LIMIT 50';
        const resSlow = await queryDiagnostic({ sql: slowSql });
        slowLogRows = (resSlow.rows || []).map((r) => (typeof SqlDiagnostics !== 'undefined' ? SqlDiagnostics.parseSlowQueryRow(r) : r));
      } catch (err) {
        slowLogError = err.message;
      }

      if (!isCurrent() || container !== $('#diagTabContent') || currentTab !== 'slow') return;

      container.innerHTML = `
        <div class="diag-stat-grid">
          <div class="diag-stat-card">
            <div class="diag-stat-label">Slow Query Log</div>
            <div class="diag-stat-value" style="color: ${slowLogEnabled === 'ON' ? '#10b981' : '#f59e0b'};">${esc(slowLogEnabled)}</div>
          </div>
          <div class="diag-stat-card">
            <div class="diag-stat-label">Ngưỡng thời gian (long_query_time)</div>
            <div class="diag-stat-value">${esc(longQueryTime)}</div>
          </div>
          <div class="diag-stat-card">
            <div class="diag-stat-label">Tổng số truy vấn chậm ghi nhận</div>
            <div class="diag-stat-value">${esc(slowQueriesCount)}</div>
          </div>
          <div class="diag-stat-card">
            <div class="diag-stat-label">Thời gian máy chủ chạy (Uptime)</div>
            <div class="diag-stat-value" style="font-size:14px; font-weight:600;">${esc(uptime)}</div>
          </div>
        </div>

        <div class="diag-section">
          <div class="diag-section-header">
            <h4>📋 Nhật ký truy vấn chậm gần đây (mysql.slow_log)</h4>
            <span class="subtle">${slowLogRows.length} câu lệnh</span>
          </div>
          ${slowLogRows.length > 0 ? `
            <div class="processlist-table-container" style="max-height: 320px;">
              <table class="processlist-table">
                <thead>
                  <tr>
                    <th style="width:140px;">Thời gian bắt đầu</th>
                    <th style="width:130px;">User & Host</th>
                    <th style="width:100px;">Query Time</th>
                    <th style="width:90px;">Lock Time</th>
                    <th style="width:90px;">Dòng gửi</th>
                    <th style="width:90px;">Dòng quét</th>
                    <th>Câu lệnh SQL</th>
                  </tr>
                </thead>
                <tbody>
                  ${slowLogRows.map((s) => `
                    <tr>
                      <td class="mono"><small>${esc(s.startTime)}</small></td>
                      <td title="${esc(s.userHost)}"><small>${esc(s.userHost)}</small></td>
                      <td><span class="time-badge time-warn">${esc(s.queryTime)}</span></td>
                      <td class="mono"><small>${esc(s.lockTime)}</small></td>
                      <td class="mono">${esc(String(s.rowsSent))}</td>
                      <td class="mono">${esc(String(s.rowsExamined))}</td>
                      <td class="proc-sql-cell"><code class="process-sql mono" data-full-sql="${esc(s.sql)}">${esc(s.sql.length > 80 ? s.sql.slice(0, 80) + '…' : s.sql)}</code></td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          ` : `
            <div class="diag-notice-box">
              ${slowLogEnabled === 'OFF' ? `
                <p><strong>ℹ️ Slow Query Log hiện đang TẮT (OFF) trên máy chủ MySQL.</strong></p>
                <p>Để lưu nhật ký truy vấn chậm vào bảng, quản trị viên máy chủ có thể cấu hình:<br>
                <code>SET GLOBAL slow_query_log = 'ON';</code><br>
                <code>SET GLOBAL log_output = 'TABLE';</code><br>
                <code>SET GLOBAL long_query_time = 2.0;</code></p>
                <p class="muted"><em>Lưu ý: SqlPro không tự ý thay đổi cấu hình global của máy chủ để đảm bảo an toàn cho môi trường production.</em></p>
              ` : `
                <p>Chưa có bản ghi truy vấn chậm nào trong bảng <code>mysql.slow_log</code>${slowLogError ? ` (Lỗi: ${esc(slowLogError)})` : ''}.</p>
              `}
            </div>
          `}
        </div>
      `;

      container.querySelectorAll('.process-sql').forEach((codeEl) => {
        codeEl.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!isCurrent()) return;
          const sql = codeEl.dataset.fullSql;
          if (sql && navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(sql);
            toast('Đã sao chép SQL', 'info');
          }
        });
      });
    } catch (err) {
      if (!isCurrent() || container !== $('#diagTabContent')) return;
      container.innerHTML = `<div class="processlist-error">Lỗi khi đọc nhật ký truy vấn chậm: ${esc(err.message)}</div>`;
    } finally {
      isFetching = false;
    }
  }

  $('#modal').querySelectorAll('[data-diag-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!isCurrent()) return;
      $('#modal').querySelectorAll('[data-diag-tab]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentTab = btn.dataset.diagTab;
      void refreshCurrentTab();
    });
  });

  $('#refreshDiagBtn')?.addEventListener('click', refreshCurrentTab);

  await loadProcesslist();
  setupAutoRefresh();
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
        <button class="close-btn" data-click="close-modal" title="Đóng (Esc)" aria-label="Đóng">✕</button>
      </div>
      <div class="modal-body">
        <div style="margin-bottom:12px; display:flex; gap:10px;">
          <input type="search" id="varsFilterInput" class="processlist-search-input" placeholder="🔍 Tìm biến (vd: max_connections, buffer, version...)" style="flex:1;">
          <span id="varsItemCount" style="align-self:center; color:#9ca3af; font-size:0.85em;">Đang nạp...</span>
        </div>
        <div id="varsTableContainer" style="max-height: 480px; overflow: auto; border:1px solid #e2e8f0; border-radius:8px;">
          <div style="padding:20px; text-align:center; color:#9ca3af;">Đang tải dữ liệu cấu hình...</div>
        </div>
      </div>
      <div class="modal-footer">
        <div style="font-size:11px; color:#64748b;">
          <span>💡 <em>Chế độ xem thông tin cấu hình và trạng thái của server MySQL.</em></span>
        </div>
        <button class="secondary" data-click="close-modal">Đóng (Esc)</button>
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
        const res = await call(desktop.db.query({ ...activeQueryTarget(), sql: querySql }));
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

async function showSchemaDiffModal() {
  if (!desktop || !app.connection) {
    toast('Chưa kết nối CSDL.', 'error');
    return;
  }

  const profiles = app.connections?.length ? app.connections : (app.connection ? [app.connection] : []);
  const currentProfileId = app.connection.id;
  const currentDb = app.database || '';

  modal(`
    <div class="modal-card schema-diff-card">
      <div class="modal-header">
        <div class="modal-header-left">
          <h3>🔄 So sánh & Đồng bộ Lược đồ <span class="modal-title-tag">Schema Diff</span></h3>
          <div class="schema-diff-tabs" role="tablist">
            <button class="diff-tab-btn active" data-diff-tab="config">⚙️ Cấu hình</button>
            <button class="diff-tab-btn" data-diff-tab="summary" disabled>📊 Tổng quan</button>
            <button class="diff-tab-btn" data-diff-tab="tables" disabled>▦ Bảng & Cột</button>
            <button class="diff-tab-btn" data-diff-tab="indexes" disabled>🔑 Chỉ mục & FK</button>
            <button class="diff-tab-btn" data-diff-tab="migration" disabled>📝 Mã Migration SQL</button>
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
          <button class="close-btn" data-click="close-modal" title="Đóng (Esc)" aria-label="Đóng">✕</button>
        </div>
      </div>
      <div class="modal-body" id="diffModalBody">
        <div id="diffTabContent">
          <div class="processlist-loading">Đang tải danh sách kết nối và cơ sở dữ liệu...</div>
        </div>
      </div>
      <div class="modal-footer" id="diffModalFooter">
        <div class="modal-footer-hint">
          <span id="diffFooterHint">💡 <em>Chọn CSDL Nguồn (chuẩn) và CSDL Đích (cần đồng bộ), sau đó nhấn "So sánh Lược đồ".</em></span>
        </div>
        <button class="secondary" data-click="close-modal">Đóng (Esc)</button>
      </div>
    </div>
  `);

  const openedRevision = modalRevision, dialog = $('#modal');
  const current = () => modalRevision === openedRevision && $('#modal') === dialog && dialog.open
    && app.connection?.id === currentProfileId && (app.database || '') === currentDb;
  let revision = 0, isComparing = false, migrationPlan = null;
  let currentTab = 'config';
  let diffResult = null;
  let migrationStatements = [];
  let sourceSnapshot = null;
  let targetSnapshot = null;

  let sourceProfileId = currentProfileId;
  let sourceDb = currentDb;
  let targetProfileId = currentProfileId;
  let targetDb = '';

  let ignoreComments = false;
  let ignoreCollation = false;

  let sourceDatabases = [];
  let targetDatabases = [];

  async function loadDatabasesFor(profileId) {
    try {
      const dbs = await call(desktop.db.databases(profileId));
      return Array.isArray(dbs) ? dbs : [];
    } catch {
      return [];
    }
  }

  async function initConfigTab() {
    const container = $('#diffTabContent');
    if (!container) return;

    const version = revision;
    sourceDatabases = await loadDatabasesFor(sourceProfileId);
    if (!current() || version !== revision) return;
    targetDatabases = sourceProfileId === targetProfileId ? sourceDatabases : await loadDatabasesFor(targetProfileId);

    if (!current() || version !== revision) return;
    if (!targetDb && targetDatabases.length > 1) {
      targetDb = targetDatabases.find((d) => d !== sourceDb) || targetDatabases[0] || '';
    } else if (!targetDb && targetDatabases.length === 1) {
      targetDb = targetDatabases[0];
    }

    renderConfigView();
  }

  function invalidateComparison() {
    ++revision; isComparing = false; migrationPlan = null; diffResult = null; migrationStatements = [];
    document.querySelectorAll('[data-diff-tab]').forEach(btn => { if (btn.dataset.diffTab !== 'config') btn.disabled = true; });
  }

  function renderConfigView() {
    if (!current()) return;
    const container = $('#diffTabContent');
    if (!container) return;

    container.innerHTML = `
      <div class="diff-config-pane">
        <div class="diff-compare-grid">
          <div class="diff-side-box">
            <div class="diff-side-title">
              <span>🔵</span> <strong>CSDL NGUỒN (Chuẩn / Mong muốn)</strong>
            </div>
            <label style="font-size:0.85em; color:#64748b;">Kết nối:</label>
            <select id="diffSourceProfile" style="width:100%;">
              ${profiles.map((p) => `<option value="${esc(p.id)}" ${p.id === sourceProfileId ? 'selected' : ''}>${esc(p.name || p.host)} (${esc(p.host)}:${p.port || 3306})</option>`).join('')}
            </select>
            <label style="font-size:0.85em; color:#64748b; margin-top:4px;">Cơ sở dữ liệu:</label>
            <select id="diffSourceDb" style="width:100%;">
              ${sourceDatabases.map((db) => `<option value="${esc(db)}" ${db === sourceDb ? 'selected' : ''}>${esc(db)}</option>`).join('')}
            </select>
          </div>

          <div style="display:flex; flex-direction:column; align-items:center; gap:8px;">
            <button type="button" class="diff-swap-btn" id="diffSwapBtn" title="Đổi chiều Nguồn ⇄ Đích">⇄</button>
            <span style="font-size:0.75em; color:#94a3b8;">So sánh</span>
          </div>

          <div class="diff-side-box">
            <div class="diff-side-title">
              <span>🎯</span> <strong>CSDL ĐÍCH (Cần đồng bộ / Cũ)</strong>
            </div>
            <label style="font-size:0.85em; color:#64748b;">Kết nối:</label>
            <select id="diffTargetProfile" style="width:100%;">
              ${profiles.map((p) => `<option value="${esc(p.id)}" ${p.id === targetProfileId ? 'selected' : ''}>${esc(p.name || p.host)} (${esc(p.host)}:${p.port || 3306})</option>`).join('')}
            </select>
            <label style="font-size:0.85em; color:#64748b; margin-top:4px;">Cơ sở dữ liệu:</label>
            <select id="diffTargetDb" style="width:100%;">
              ${targetDatabases.map((db) => `<option value="${esc(db)}" ${db === targetDb ? 'selected' : ''}>${esc(db)}</option>`).join('')}
            </select>
          </div>
        </div>

        <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:14px;">
          <div style="font-weight:600; font-size:0.9em; margin-bottom:10px;">⚙️ Tùy chọn so sánh & an toàn:</div>
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; font-size:0.88em;">
            <p style="grid-column:1/-1; margin:0;">Xuất SQL chỉ hỗ trợ các thay đổi đã kiểm chứng. DROP và thay đổi chưa hỗ trợ sẽ bị chặn.</p>
            <label style="display:flex; align-items:center; gap:6px;">
              <input type="checkbox" id="diffIgnoreComments" ${ignoreComments ? 'checked' : ''}>
              <span>Bỏ qua khác biệt ghi chú (Comments)</span>
            </label>
            <label style="display:flex; align-items:center; gap:6px;">
              <input type="checkbox" id="diffIgnoreCollation" ${ignoreCollation ? 'checked' : ''}>
              <span>Bỏ qua khác biệt Collation</span>
            </label>
          </div>
        </div>

        <div style="text-align:center; margin-top:8px;">
          <button type="button" class="primary" id="diffRunCompareBtn" style="padding:10px 28px; font-size:1em;">
            ⚡ Bắt đầu so sánh lược đồ
          </button>
        </div>
      </div>
    `;

    $('#diffSourceProfile')?.addEventListener('change', async (e) => {
      if (!current()) return;
      invalidateComparison();
      sourceProfileId = e.target.value;
      const version = revision, profileId = sourceProfileId;
      const databases = await loadDatabasesFor(profileId);
      if (!current() || version !== revision || sourceProfileId !== profileId) return;
      sourceDatabases = databases;
      sourceDb = databases[0] || '';
      renderConfigView();
    });

    $('#diffSourceDb')?.addEventListener('change', (e) => {
      if (!current()) return;
      invalidateComparison();
      sourceDb = e.target.value;
    });

    $('#diffTargetProfile')?.addEventListener('change', async (e) => {
      if (!current()) return;
      invalidateComparison();
      targetProfileId = e.target.value;
      const version = revision, profileId = targetProfileId;
      const databases = await loadDatabasesFor(profileId);
      if (!current() || version !== revision || targetProfileId !== profileId) return;
      targetDatabases = databases;
      targetDb = databases[0] || '';
      renderConfigView();
    });

    $('#diffTargetDb')?.addEventListener('change', (e) => {
      if (!current()) return;
      invalidateComparison();
      targetDb = e.target.value;
    });

    $('#diffSwapBtn')?.addEventListener('click', () => {
      if (!current()) return;
      invalidateComparison();
      const tempP = sourceProfileId;
      sourceProfileId = targetProfileId;
      targetProfileId = tempP;

      const tempDb = sourceDb;
      sourceDb = targetDb;
      targetDb = tempDb;

      const tempDbs = sourceDatabases;
      sourceDatabases = targetDatabases;
      targetDatabases = tempDbs;

      renderConfigView();
    });

    $('#diffIgnoreComments')?.addEventListener('change', (e) => {
      if (!current()) return;
      invalidateComparison();
      ignoreComments = e.target.checked;
    });
    $('#diffIgnoreCollation')?.addEventListener('change', (e) => {
      if (!current()) return;
      invalidateComparison();
      ignoreCollation = e.target.checked;
    });

    $('#diffRunCompareBtn')?.addEventListener('click', executeCompare);
  }

  async function executeCompare() {
    if (!current() || isComparing) return;
    if (!sourceDb || !targetDb) {
      toast('Vui lòng chọn cả CSDL Nguồn và CSDL Đích.', 'error');
      return;
    }
    if (sourceProfileId === targetProfileId && sourceDb === targetDb) {
      toast('CSDL Nguồn và Đích không được trùng nhau.', 'error');
      return;
    }

    invalidateComparison();
    const version = revision, scope = { sourceProfileId, sourceDb, targetProfileId, targetDb };
    const valid = () => current() && revision === version;
    isComparing = true;
    const container = $('#diffTabContent');
    container.innerHTML = `
      <div class="processlist-loading">
        <div style="font-weight:600; margin-bottom:8px;">Đang trích xuất và phân tích lược đồ...</div>
        <div style="font-size:0.85em; color:#9ca3af;">Đang nạp cấu trúc ${esc(sourceDb)} và ${esc(targetDb)}...</div>
      </div>
    `;

    try {
      sourceSnapshot = await call(desktop.db.schemaSnapshot({ profileId: scope.sourceProfileId, database: scope.sourceDb }));
      if (!valid()) return;
      if (sourceSnapshot.coverage !== 'complete' || !sourceSnapshot.snapshotId) throw new Error('Metadata nguồn chưa đầy đủ; không xuất SQL.');
      targetSnapshot = await call(desktop.db.schemaSnapshot({ profileId: scope.targetProfileId, database: scope.targetDb }));
      if (!valid()) return;
      if (targetSnapshot.coverage !== 'complete' || !targetSnapshot.snapshotId) throw new Error('Metadata đích chưa đầy đủ; không xuất SQL.');
      const plan = await call(desktop.db.createMigrationPlan({ sourceSnapshotId: sourceSnapshot.snapshotId,
        targetSnapshotId: targetSnapshot.snapshotId, options: { ignoreComments, ignoreCollation } }));
      if (!valid()) return;
      if (plan.status !== 'preview' || !plan.exportSupported || !plan.comparison || typeof plan.sqlScript !== 'string') {
        const reasons = {
          CHECK_CONSTRAINT_REVIEW_REQUIRED: 'Chưa hỗ trợ sinh SQL bảo toàn ràng buộc CHECK.',
          MARIADB_DEFAULT_REVIEW_REQUIRED: 'Chưa hỗ trợ sinh SQL bảo toàn DEFAULT này trên MariaDB.',
          FOREIGN_KEY_DEPENDENCY_REVIEW_REQUIRED: 'Cần kiểm chứng đầy đủ phụ thuộc khóa ngoại trước khi xuất SQL.',
          COLUMN_ORDER_REVIEW_REQUIRED: 'Chưa hỗ trợ thay đổi vị trí cột hoặc thêm cột vào giữa bảng.',
          DESTRUCTIVE_DDL_BLOCKED: 'Chưa hỗ trợ xuất SQL xóa bảng, cột hoặc chỉ mục trong luồng này.'
        };
        throw new Error(reasons[plan.blockReason] || `Không xuất SQL cho schema chưa được hỗ trợ: ${plan.blockReason || 'MIGRATION_PLAN_BLOCKED'}`);
      }
      migrationPlan = plan;
      diffResult = plan.comparison;
      migrationStatements = plan.statements;

      document.querySelectorAll('[data-diff-tab]').forEach((btn) => {
        btn.disabled = false;
      });

      switchTab('summary');
    } catch (err) {
      if (!valid()) return;
      migrationPlan = null; diffResult = null; migrationStatements = [];
      container.innerHTML = `<div class="processlist-error">Lỗi khi so sánh schema: ${esc(err.message)}</div>`;
    } finally { if (valid()) isComparing = false; }
  }

  function switchTab(tabName) {
    if (!current()) return;
    currentTab = tabName;
    document.querySelectorAll('[data-diff-tab]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.diffTab === tabName);
    });

    if (tabName === 'config') renderConfigView();
    else if (tabName === 'summary') renderSummaryTab();
    else if (tabName === 'tables') renderTablesTab();
    else if (tabName === 'indexes') renderIndexesTab();
    else if (tabName === 'migration') renderMigrationTab();
  }

  function renderSummaryTab() {
    const container = $('#diffTabContent');
    if (!container || !diffResult) return;

    const { summary, tables, views, routines } = diffResult;

    container.innerHTML = `
      <div style="padding:16px;">
        <div class="diff-stat-cards">
          <div class="diff-stat-card diff-stat-total">
            <span class="diff-stat-num">${summary.totalChanges}</span>
            <span class="diff-stat-label">Tổng số thay đổi</span>
          </div>
          <div class="diff-stat-card diff-stat-safe">
            <span class="diff-stat-num">${summary.safeCount}</span>
            <span class="diff-stat-label">An toàn (Thêm mới)</span>
          </div>
          <div class="diff-stat-card diff-stat-warning">
            <span class="diff-stat-num">${summary.warningCount}</span>
            <span class="diff-stat-label">Cảnh báo (Sửa đổi)</span>
          </div>
          <div class="diff-stat-card diff-stat-destructive">
            <span class="diff-stat-num">${summary.destructiveCount}</span>
            <span class="diff-stat-label">Nguy hiểm (Xóa bỏ)</span>
          </div>
        </div>

        <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:14px; margin-bottom:14px;">
          <h4 style="margin:0 0 10px 0; font-size:0.95em;">📋 Tóm tắt phân loại đối tượng:</h4>
          <div style="display:grid; grid-template-columns:repeat(2, 1fr); gap:8px; font-size:0.88em;">
            <div>• Bảng mới cần tạo: <strong>${tables.added.length}</strong></div>
            <div>• Bảng cũ cần xóa: <strong>${tables.dropped.length}</strong></div>
            <div>• Bảng có thay đổi cột / chỉ mục: <strong>${tables.modified.length}</strong></div>
            <div>• Views & Thủ tục thay đổi: <strong>${views.added.length + views.modified.length + routines.added.length}</strong></div>
          </div>
        </div>

        <div style="display:flex; justify-content:flex-end; gap:8px;">
          <button type="button" class="secondary" id="diffGoTablesBtn">Xem chi tiết Bảng & Cột →</button>
          <button type="button" class="primary" id="diffGoMigrationBtn">Xem Script Migration SQL →</button>
        </div>
      </div>
    `;

    $('#diffGoTablesBtn')?.addEventListener('click', () => switchTab('tables'));
    $('#diffGoMigrationBtn')?.addEventListener('click', () => switchTab('migration'));
  }

  function renderTablesTab() {
    const container = $('#diffTabContent');
    if (!container || !diffResult) return;

    const { tables } = diffResult;

    if (!tables.added.length && !tables.modified.length && !tables.dropped.length) {
      container.innerHTML = '<div class="processlist-empty">Không có sự khác biệt nào về bảng hoặc cột.</div>';
      return;
    }

    container.innerHTML = `
      <div style="padding:14px;">
        <div class="diff-items-list">
          ${tables.added.map((t) => `
            <div class="diff-item-row">
              <div>
                <strong>${esc(t.name)}</strong>
                <span style="color:#64748b; font-size:0.82em; margin-left:8px;">(${t.columns.length} cột, ${t.indexes.length} chỉ mục)</span>
              </div>
              <span class="diff-tag-added">＋ TẠO MỚI</span>
            </div>
          `).join('')}

          ${tables.modified.map((tm) => `
            <div style="border:1px solid #e2e8f0; border-radius:6px; padding:10px 14px; background:#fff; margin-bottom:8px;">
              <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">
                <strong>${esc(tm.name)}</strong>
                <span class="diff-tag-modified">~ SỬA ĐỔI</span>
              </div>
              <div style="font-size:0.84em; color:#475569; display:flex; flex-direction:column; gap:4px; margin-left:12px;">
                ${tm.columns.added.map((c) => `<div><span style="color:#16a34a; font-weight:600;">[+]</span> Thêm cột <code>${esc(c.name)}</code> (${esc(c.type)})</div>`).join('')}
                ${tm.columns.modified.map((c) => `<div><span style="color:#d97706; font-weight:600;">[~]</span> Sửa cột <code>${esc(c.name)}</code>: ${esc(c.changes.join(', '))}</div>`).join('')}
                ${tm.columns.dropped.map((c) => `<div><span style="color:#dc2626; font-weight:600;">[-]</span> Xóa cột <code>${esc(c.name)}</code></div>`).join('')}
              </div>
            </div>
          `).join('')}

          ${tables.dropped.map((t) => `
            <div class="diff-item-row">
              <div>
                <strong>${esc(t.name)}</strong>
                <span style="color:#64748b; font-size:0.82em; margin-left:8px;">(Bảng sẽ bị xóa nếu cho phép)</span>
              </div>
              <span class="diff-tag-dropped">✕ XÓA BẢNG</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  function renderIndexesTab() {
    const container = $('#diffTabContent');
    if (!container || !diffResult) return;

    const { tables } = diffResult;
    const modifiedWithKeys = tables.modified.filter((t) => t.indexes.added.length || t.indexes.modified.length || t.indexes.dropped.length || t.foreignKeys.added.length || t.foreignKeys.modified.length || t.foreignKeys.dropped.length);

    if (!modifiedWithKeys.length && !tables.added.some((t) => t.foreignKeys.length)) {
      container.innerHTML = '<div class="processlist-empty">Không có sự khác biệt nào về chỉ mục hoặc khóa ngoại.</div>';
      return;
    }

    container.innerHTML = `
      <div style="padding:14px;">
        <div class="diff-items-list">
          ${modifiedWithKeys.map((tm) => `
            <div style="border:1px solid #e2e8f0; border-radius:6px; padding:10px 14px; background:#fff; margin-bottom:8px;">
              <div style="font-weight:600; margin-bottom:6px;">Bảng: ${esc(tm.name)}</div>
              <div style="font-size:0.84em; display:flex; flex-direction:column; gap:4px; margin-left:12px;">
                ${tm.indexes.added.map((i) => `<div><span style="color:#16a34a; font-weight:600;">[+]</span> Thêm chỉ mục <code>${esc(i.name)}</code> (${esc(i.type)})</div>`).join('')}
                ${tm.indexes.modified.map((i) => `<div><span style="color:#d97706; font-weight:600;">[~]</span> Sửa chỉ mục <code>${esc(i.name)}</code></div>`).join('')}
                ${tm.indexes.dropped.map((i) => `<div><span style="color:#dc2626; font-weight:600;">[-]</span> Xóa chỉ mục <code>${esc(i.name)}</code></div>`).join('')}
                ${tm.foreignKeys.added.map((f) => `<div><span style="color:#16a34a; font-weight:600;">[+]</span> Thêm khóa ngoại <code>${esc(f.name)}</code> -> ${esc(f.referencedTable)}</div>`).join('')}
                ${tm.foreignKeys.modified.map((f) => `<div><span style="color:#d97706; font-weight:600;">[~]</span> Sửa khóa ngoại <code>${esc(f.name)}</code></div>`).join('')}
                ${tm.foreignKeys.dropped.map((f) => `<div><span style="color:#dc2626; font-weight:600;">[-]</span> Xóa khóa ngoại <code>${esc(f.name)}</code></div>`).join('')}
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  function renderMigrationTab() {
    const container = $('#diffTabContent');
    if (!current() || !container || !diffResult || !migrationPlan?.exportSupported) return;

    const version = revision, plan = migrationPlan;
    const valid = () => current() && revision === version && migrationPlan === plan && plan.exportSupported
      && Date.parse(plan.expiresAt) > Date.now();
    if (!valid()) {
      container.innerHTML = '<div class="processlist-error">Kết quả so sánh đã hết hạn. Hãy so sánh lại.</div>';
      return;
    }
    function getFormattedScript() {
      if (!valid()) throw new Error('Kết quả so sánh đã thay đổi hoặc hết hạn. Hãy so sánh lại.');
      return plan.sqlScript;
    }

    container.innerHTML = `
      <div style="padding:14px; display:flex; flex-direction:column; gap:10px;">
        <div class="diff-options-bar">
          <div style="display:flex; align-items:center; gap:14px;">
            <label style="display:flex; align-items:center; gap:5px; font-weight:500;">
              <span>${migrationStatements.length} lệnh SQL để xem xét</span>
            </label>
            <span style="font-size:0.85em; color:#64748b;">🔒 Giữ nguyên thiết lập kiểm tra ràng buộc của phiên</span>
          </div>
          <div style="display:flex; gap:6px;">
            <button type="button" class="secondary" id="diffCopySqlBtn">📋 Sao chép</button>
            <button type="button" class="secondary" id="diffDownloadSqlBtn">💾 Tải file .sql</button>
            <button type="button" class="primary" id="diffOpenEditorBtn">▷ Mở trong Editor</button>
          </div>
        </div>

        <textarea class="diff-sql-script-area" id="diffSqlScriptArea" readonly>${esc(getFormattedScript())}</textarea>

        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:4px;">
          <span style="font-size:0.82em; color:#64748b;">
            🔒 Luồng áp dụng trực tiếp đang khóa an toàn. Vui lòng bấm “▷ Mở trong Editor” để xem xét và thực thi từng lệnh DDL có kiểm soát.
          </span>
          <button type="button" class="secondary" id="diffApplyTargetBtn" disabled style="cursor:not-allowed; opacity:0.6;">
            🔒 Áp dụng trực tiếp đang khóa an toàn
          </button>
        </div>
      </div>
    `;

    $('#diffCopySqlBtn')?.addEventListener('click', async () => {
      if (!valid()) return;
      try {
        await writeClipboardText(getFormattedScript());
        if (!valid()) return;
        toast('Đã sao chép mã Migration SQL vào clipboard', 'success');
      } catch (err) {
        if (current()) toast(err.message, 'error');
      }
    });

    $('#diffDownloadSqlBtn')?.addEventListener('click', () => {
      if (!valid()) return;
      try {
        const text = getFormattedScript();
        const blob = new Blob([text], { type: 'text/sql;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `migration_${sourceDb}_to_${targetDb}_${Date.now()}.sql`;
        link.click();
        URL.revokeObjectURL(url);
        toast('Đã tải xuống tệp Migration SQL', 'success');
      } catch (err) {
        if (current()) toast(err.message, 'error');
      }
    });

    $('#diffOpenEditorBtn')?.addEventListener('click', () => {
      if (!valid()) return;
      const sql = getFormattedScript();
      closeModal();
      newQuery(sql, { profileId: targetProfileId, database: targetDb });
      toast(`Đã mở mã Migration vào SQL Editor cho ${targetDb}`, 'info');
    });

    $('#diffApplyTargetBtn')?.addEventListener('click', () => {
      toast('Thao tác áp dụng tự động đang tạm khóa để thẩm định an toàn DDL. Vui lòng bấm "▷ Mở trong Editor" để xem xét từng câu lệnh.', 'warning');
    });
  }

  document.querySelectorAll('[data-diff-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!btn.disabled) switchTab(btn.dataset.diffTab);
    });
  });

  initConfigTab();
}

/* ==========================================================================
   G7 — DATA DIFF & TABLE SYNCHRONIZATION MODAL
   ========================================================================== */

async function showDataDiffModal(initialTable = null) {
  if (!desktop || !app.connection) {
    toast('Chưa kết nối CSDL.', 'error');
    return;
  }
  if (typeof SqlDataDiff === 'undefined') {
    toast('Module Data Diff chưa được tải.', 'error');
    return;
  }

  modal(`
    <div class="modal-card schema-diff-card data-diff-card">
      <div class="modal-header">
        <div class="modal-header-left">
          <h3>⚖️ So sánh dữ liệu đã đọc <span class="modal-title-tag">Data Diff</span></h3>
          <div class="diff-tabs" role="tablist">
            <button class="diff-tab-btn active" data-data-diff-tab="config">⚙️ Cấu hình</button>
            <button class="diff-tab-btn" data-data-diff-tab="overview" id="dataDiffOverviewTabBtn" disabled>📊 Tổng quan</button>
            <button class="diff-tab-btn" data-data-diff-tab="differences" id="dataDiffDiffTabBtn" disabled>🔍 Dòng khác biệt</button>
            <button class="diff-tab-btn" data-data-diff-tab="missing" id="dataDiffMissingTabBtn" disabled>➕➖ Chỉ thấy ở một mẫu</button>
            <button class="diff-tab-btn" data-data-diff-tab="sync" id="dataDiffSyncTabBtn" disabled>Giới hạn đồng bộ</button>
          </div>
        </div>
        <button class="close-btn" data-click="close-modal" title="Đóng (Esc)" aria-label="Đóng">✕</button>
      </div>

      <div class="modal-body schema-diff-body" id="dataDiffModalBody">
        <div id="dataDiffTabContent">
          <div class="processlist-loading">Đang khởi tạo cấu hình so sánh dữ liệu...</div>
        </div>
      </div>

      <div class="modal-footer">
        <div class="modal-footer-hint">
          <span>💡 <em>Đọc theo từng phần bằng kết nối riêng. Phạm vi và snapshot được báo rõ; đồng bộ vẫn khóa.</em></span>
        </div>
        <button class="secondary" data-click="close-modal">Đóng (Esc)</button>
      </div>
    </div>
  `);

  const modalRoot = $('#dataDiffModalBody');
  const modalCurrent = () => $('#modal')?.open && modalRoot?.isConnected && $('#dataDiffModalBody') === modalRoot;
  let revision = 0, configRequest = 0;
  let currentTab = 'config';
  let diffResult = null;
  let primaryKeys = [];

  let sourceProfileId = app.connection?.id || null;
  let sourceDb = app.database || '';
  let sourceTable = initialTable || table || '';

  let targetProfileId = app.connection?.id || null;
  let targetDb = app.database || '';
  let targetTable = initialTable || table || '';

  let rowLimit = 500;
  let isComparing = false;
  let activeJob = null;
  function invalidateComparison() {
    revision++; diffResult = null; isComparing = false;
    void activeJob?.cancel().catch(() => {});
    activeJob = null;
    const button = $('#dataDiffRunCompareBtn');
    if (button && modalCurrent()) { button.disabled = false; button.textContent = 'Đọc và so sánh'; }
    modalRoot?.closest('.data-diff-card')?.querySelectorAll('[data-data-diff-tab]:not([data-data-diff-tab="config"])').forEach(button => { button.disabled = true; });
  }

  const lifecycle = new MutationObserver(() => {
    if (!modalCurrent()) { invalidateComparison(); lifecycle.disconnect(); }
  });
  lifecycle.observe($('#modal'), { childList: true, attributes: true, attributeFilter: ['open'] });

  function switchTab(tabName) {
    if (!modalCurrent()) return;
    currentTab = tabName;
    document.querySelectorAll('[data-data-diff-tab]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.dataDiffTab === tabName);
    });

    switch (tabName) {
      case 'config': renderConfigTab(); break;
      case 'overview': renderOverviewTab(); break;
      case 'differences': renderDifferencesTab(); break;
      case 'missing': renderMissingTab(); break;
      case 'sync': renderSyncTab(); break;
    }
  }

  async function renderConfigTab() {
    const container = $('#dataDiffTabContent');
    if (!container || !modalCurrent()) return;
    const request = ++configRequest;
    const current = () => modalCurrent() && currentTab === 'config' && request === configRequest;

    const connections = app.connections || [];
    let sourceDatabases = [];
    let targetDatabases = [];
    let sourceTables = [];
    let targetTables = [];

    try {
      sourceDatabases = await call(desktop.db.databases(sourceProfileId));
      if (!current()) return;
      if (!sourceDb && sourceDatabases.length) sourceDb = sourceDatabases[0];
      if (sourceDb) sourceTables = await call(desktop.db.tables(sourceDb, sourceProfileId));
      if (!current()) return;
      if (!sourceTable && sourceTables.length) sourceTable = sourceTables[0].name;

      targetDatabases = targetProfileId === sourceProfileId
        ? sourceDatabases
        : await call(desktop.db.databases(targetProfileId));
      if (!current()) return;
      if (!targetDb && targetDatabases.length) targetDb = targetDatabases[0];
      if (targetDb) targetTables = await call(desktop.db.tables(targetDb, targetProfileId));
      if (!current()) return;
      if (!targetTable && targetTables.length) targetTable = targetTables[0].name;
    } catch {
      // Ignore initial loading errors
    }

    if (!current()) return;
    container.innerHTML = `
      <div class="diff-config-container">
        <div class="diff-config-columns">
          <div class="diff-config-card source-card">
            <div class="diff-side-badge source-badge">CSDL NGUỒN (Source / Desired Data)</div>
            <div class="formrow" style="margin-top:12px;">
              <label>Kết nối máy chủ:</label>
              <select id="dataDiffSourceProfile">
                ${connections.map((c) => `<option value="${esc(c.id)}" ${c.id === sourceProfileId ? 'selected' : ''}>${esc(c.name || c.host)}</option>`).join('')}
              </select>
            </div>
            <div class="formrow">
              <label>Database:</label>
              <select id="dataDiffSourceDb">
                ${sourceDatabases.map((db) => `<option value="${esc(db)}" ${db === sourceDb ? 'selected' : ''}>${esc(db)}</option>`).join('')}
              </select>
            </div>
            <div class="formrow">
              <label>Bảng dữ liệu:</label>
              <select id="dataDiffSourceTable">
                ${sourceTables.map((t) => `<option value="${esc(t.name)}" ${t.name === sourceTable ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
              </select>
            </div>
          </div>

          <div class="diff-config-divider">
            <span style="font-size:1.8em;">➔</span>
            <span style="font-size:0.8em; color:#64748b; font-weight:600;">So sánh với</span>
          </div>

          <div class="diff-config-card target-card">
            <div class="diff-side-badge target-badge">CSDL ĐÍCH (Target / Existing Data)</div>
            <div class="formrow" style="margin-top:12px;">
              <label>Kết nối máy chủ:</label>
              <select id="dataDiffTargetProfile">
                ${connections.map((c) => `<option value="${esc(c.id)}" ${c.id === targetProfileId ? 'selected' : ''}>${esc(c.name || c.host)}</option>`).join('')}
              </select>
            </div>
            <div class="formrow">
              <label>Database:</label>
              <select id="dataDiffTargetDb">
                ${targetDatabases.map((db) => `<option value="${esc(db)}" ${db === targetDb ? 'selected' : ''}>${esc(db)}</option>`).join('')}
              </select>
            </div>
            <div class="formrow">
              <label>Bảng dữ liệu:</label>
              <select id="dataDiffTargetTable">
                ${targetTables.map((t) => `<option value="${esc(t.name)}" ${t.name === targetTable ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
              </select>
            </div>
          </div>
        </div>

        <div class="diff-options-bar" style="margin-top:16px;">
          <div style="display:flex; align-items:center; gap:10px;">
            <label style="font-weight:600; color:#475569;">Số dòng so sánh tối đa:</label>
            <select id="dataDiffRowLimitSelect" style="padding:4px 8px; border-radius:4px; border:1px solid #cbd5e1;">
              <option value="200" ${rowLimit === 200 ? 'selected' : ''}>200 dòng</option>
              <option value="500" ${rowLimit === 500 ? 'selected' : ''}>500 dòng</option>
              <option value="1000" ${rowLimit === 1000 ? 'selected' : ''}>1.000 dòng</option>
              <option value="2000" ${rowLimit === 2000 ? 'selected' : ''}>2.000 dòng</option>
            </select>
          </div>
          <button class="primary" id="dataDiffRunCompareBtn" style="padding:8px 20px; font-weight:600;">
            ${isComparing ? '⏳ Đang so sánh...' : '⚖️ Bắt đầu so sánh dữ liệu'}
          </button>
          <button id="dataDiffCancelBtn" ${isComparing ? '' : 'hidden'}>Hủy so sánh</button>
          <span id="dataDiffProgress" role="status" aria-live="polite"></span>
        </div>

        ${diffResult ? `
          <div style="margin-top:16px; padding:12px; background:#f0fdf4; border:1px solid #bbf7d0; border-radius:6px; color:#166534; font-size:0.9em; display:flex; justify-content:space-between; align-items:center;">
            <span>✓ Đã so sánh xong <strong>${diffResult.summary.totalSource}</strong> dòng Nguồn và <strong>${diffResult.summary.totalTarget}</strong> dòng Đích. Khóa chính: <code>${esc(diffResult.primaryKeys.join(', '))}</code></span>
            <button class="small-btn primary" id="dataDiffViewOverviewQuickBtn">Xem kết quả chi tiết ➔</button>
          </div>
        ` : ''}
      </div>
    `;

    $('#dataDiffSourceProfile')?.addEventListener('change', async (e) => {
      if (!current()) return;
      invalidateComparison();
      sourceProfileId = e.target.value;
      sourceDb = '';
      sourceTable = '';
      await renderConfigTab();
    });

    $('#dataDiffSourceDb')?.addEventListener('change', async (e) => {
      if (!current()) return;
      invalidateComparison();
      sourceDb = e.target.value;
      sourceTable = '';
      await renderConfigTab();
    });

    $('#dataDiffSourceTable')?.addEventListener('change', (e) => {
      if (!current()) return;
      invalidateComparison();
      sourceTable = e.target.value;
    });

    $('#dataDiffTargetProfile')?.addEventListener('change', async (e) => {
      if (!current()) return;
      invalidateComparison();
      targetProfileId = e.target.value;
      targetDb = '';
      targetTable = '';
      await renderConfigTab();
    });

    $('#dataDiffTargetDb')?.addEventListener('change', async (e) => {
      if (!current()) return;
      invalidateComparison();
      targetDb = e.target.value;
      targetTable = '';
      await renderConfigTab();
    });

    $('#dataDiffTargetTable')?.addEventListener('change', (e) => {
      if (!current()) return;
      invalidateComparison();
      targetTable = e.target.value;
    });

    $('#dataDiffRowLimitSelect')?.addEventListener('change', (e) => {
      if (!current()) return;
      invalidateComparison();
      rowLimit = Number(e.target.value) || 500;
    });

    $('#dataDiffViewOverviewQuickBtn')?.addEventListener('click', () => switchTab('overview'));

    $('#dataDiffCancelBtn')?.addEventListener('click', () => {
      if (!current()) return;
      invalidateComparison();
      $('#dataDiffCancelBtn').hidden = true;
      $('#dataDiffProgress').textContent = 'Đã yêu cầu hủy so sánh.';
    });
    $('#dataDiffRunCompareBtn')?.addEventListener('click', async () => {
      if (isComparing || !current()) return;
      if (!sourceProfileId || !targetProfileId || !sourceDb || !sourceTable || !targetDb || !targetTable) {
        toast('Vui lòng chọn đầy đủ kết nối, database và bảng ở hai phía.', 'error'); return;
      }
      invalidateComparison();
      const version = revision;
      const scope = { sourceProfileId, sourceDb, sourceTable, targetProfileId, targetDb, targetTable, rowLimit };
      const valid = () => current() && revision === version;
      const job = window.SqlDataDiffJob.createJob({ db: desktop.db, unwrap: call, isCurrent: valid,
        onProgress: progress => {
          if (!valid()) return;
          const count = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString() : '—';
          $('#dataDiffProgress').textContent = `Đã đọc ${count(progress.totalSource)} dòng nguồn / ${count(progress.totalTarget)} dòng đích.`;
        }
      });
      activeJob = job;
      isComparing = true;
      $('#dataDiffRunCompareBtn').textContent = 'Đang đọc và so sánh…';
      $('#dataDiffRunCompareBtn').disabled = true;
      $('#dataDiffCancelBtn').hidden = false;
      try {
        if (![200, 500, 1000, 2000].includes(scope.rowLimit)) throw new Error('Giới hạn dòng không hợp lệ.');
        const report = await job.run(scope);
        if (!valid()) return;
        primaryKeys = report.primaryKeys;
        diffResult = report;
        for (const selector of ['#dataDiffOverviewTabBtn', '#dataDiffDiffTabBtn', '#dataDiffMissingTabBtn', '#dataDiffSyncTabBtn']) $(selector).disabled = false;
        switchTab('overview');
      } catch (error) {
        if (!valid()) return;
        toast(error.message, 'error');
        isComparing = false;
        await renderConfigTab();
      } finally {
        if (activeJob === job) activeJob = null;
        if (modalCurrent() && revision === version) isComparing = false;
      }
    });
  }

  function renderOverviewTab() {
    const container = $('#dataDiffTabContent');
    if (!container || !diffResult) return;

    const { summary, coverage } = diffResult;
    const range = coverage.complete
      ? 'Đã đi đến cuối hai luồng đọc trong hạn mức của lượt này.'
      : `Báo cáo giới hạn tối đa ${rowLimit} dòng mỗi phía; chưa chứng minh dòng vắng mặt ở toàn bảng.`;
    const snapshot = coverage.consistent
      ? 'Mỗi phía dùng snapshot riêng; hai snapshot không cùng thời điểm.'
      : 'Không có snapshot được xác minh cho cả hai phía.';

    container.innerHTML = `
      <div style="padding:16px;">
        <p class="data-diff-limit" role="status">${esc(range)} ${esc(snapshot)} Đồng bộ và xuất SQL bị khóa.</p>
        <div class="diff-summary-cards" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:12px; margin-bottom:20px;">
          <div class="stat-card" style="border-left:4px solid #16a34a;">
            <div class="stat-number" style="color:#16a34a;">${summary.identicalCount}</div>
            <div class="stat-label">Dòng giống nhau hoàn toàn</div>
          </div>
          <div class="stat-card" style="border-left:4px solid #ca8a04;">
            <div class="stat-number" style="color:#ca8a04;">${summary.differentCount}</div>
            <div class="stat-label">Dòng khác biệt giá trị</div>
          </div>
          <div class="stat-card" style="border-left:4px solid #2563eb;">
            <div class="stat-number" style="color:#2563eb;">${summary.onlyInSourceCount}</div>
            <div class="stat-label">Chỉ thấy trong mẫu nguồn</div>
          </div>
          <div class="stat-card" style="border-left:4px solid #dc2626;">
            <div class="stat-number" style="color:#dc2626;">${summary.onlyInTargetCount}</div>
            <div class="stat-label">Chỉ thấy trong mẫu đích</div>
          </div>
        </div>

        <div style="background:#fff; border:1px solid #e2e8f0; border-radius:6px; padding:16px; margin-bottom:16px;">
          <h4 style="margin:0 0 10px 0; font-size:1em; color:#334155;">Thông tin so sánh bảng</h4>
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; font-size:0.9em;">
            <div>
              <p><strong>Nguồn:</strong> <code>${esc(sourceDb)}.${esc(sourceTable)}</code> (${summary.totalSource} dòng đã nạp)</p>
              <p><strong>Khóa chính:</strong> <code>${esc(primaryKeys.join(', '))}</code></p>
            </div>
            <div>
              <p><strong>Đích:</strong> <code>${esc(targetDb)}.${esc(targetTable)}</code> (${summary.totalTarget} dòng đã nạp)</p>
              <p><strong>Cột so sánh:</strong> ${diffResult.columns.length} cột</p>
            </div>
          </div>
        </div>

        <div style="display:flex; gap:10px;">
          <button class="primary" id="dataDiffGoDiffBtn">🔍 Xem các dòng khác biệt (${summary.differentCount})</button>
          <button class="secondary" id="dataDiffGoSyncBtn">Xem giới hạn đồng bộ</button>
        </div>
      </div>
    `;

    $('#dataDiffGoDiffBtn')?.addEventListener('click', () => switchTab('differences'));
    $('#dataDiffGoSyncBtn')?.addEventListener('click', () => switchTab('sync'));
  }

  function formatVal(val, colName) {
    if (val === null || val === undefined) return '<span style="color:#94a3b8; font-style:italic;">NULL</span>';
    if (app.maskData && typeof SqlDataMasking !== 'undefined') {
      const type = SqlDataMasking.detectMaskType(colName);
      if (type) {
        switch (type) {
          case 'email': return esc(SqlDataMasking.maskEmail(String(val)));
          case 'phone': return esc(SqlDataMasking.maskPhone(String(val)));
          case 'card': return esc(SqlDataMasking.maskCardNumber(String(val)));
          case 'secret': return esc(SqlDataMasking.maskSecret(String(val)));
          case 'id': return esc(SqlDataMasking.maskIdNumber(String(val)));
        }
      }
    }
    return esc(String(val));
  }

  function renderDifferencesTab() {
    const container = $('#dataDiffTabContent');
    if (!container || !diffResult) return;

    const diffs = diffResult.different;

    if (!diffs.length) {
      container.innerHTML = `
        <div class="processlist-empty">
          <div style="font-size:2em; margin-bottom:8px;">✓</div>
          <div>Không thấy giá trị khác biệt trong các dòng ghép khóa của hai mẫu.</div>
        </div>
      `;
      return;
    }


    container.innerHTML = `
      <div style="padding:14px; max-height:450px; overflow-y:auto;">
        <div style="margin-bottom:12px; font-size:0.88em; color:#64748b;">
          Hiển thị <strong>${diffs.length}</strong> dòng có sự khác biệt về dữ liệu giữa Nguồn và Đích:
        </div>
        <table class="audit-table data-diff-table">
          <thead>
            <tr>
              <th style="width:120px;">Khóa (PK)</th>
              <th style="width:140px;">Cột khác biệt</th>
              <th>Giá trị Nguồn (Desired)</th>
              <th>Giá trị Đích (Existing)</th>
            </tr>
          </thead>
          <tbody>
            ${diffs.map((d) => `
              <tr class="audit-row">
                <td style="font-family:monospace; font-weight:600; color:#0f766e;">${app.maskData ? '•••' : esc(d.rowKey)}</td>
                <td colspan="3" style="padding:0;">
                  <table style="width:100%; border-collapse:collapse; background:transparent;">
                    ${d.differences.map((diffCol) => `
                      <tr style="border-bottom:1px solid #f1f5f9;">
                        <td style="width:140px; font-weight:600; color:#334155; padding:6px 10px;">${esc(diffCol.column)}</td>
                        <td style="color:#15803d; background:#f0fdf4; padding:6px 10px;" title="Giá trị CSDL Nguồn">
                          ${formatVal(diffCol.sourceValue, diffCol.column)}
                        </td>
                        <td style="color:#b91c1c; background:#fef2f2; padding:6px 10px;" title="Giá trị CSDL Đích">
                          ${formatVal(diffCol.targetValue, diffCol.column)}
                        </td>
                      </tr>
                    `).join('')}
                  </table>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderMissingTab() {
    const container = $('#dataDiffTabContent');
    if (!container || !diffResult) return;

    const onlySrc = diffResult.onlyInSource;
    const onlyTgt = diffResult.onlyInTarget;
    const cols = diffResult.columns;

    container.innerHTML = `
      <div style="padding:14px; max-height:450px; overflow-y:auto;">
        <h4 style="margin:0 0 8px 0; color:#2563eb;">Dòng chỉ thấy trong mẫu nguồn (${onlySrc.length})</h4>
        ${onlySrc.length ? `
          <div style="max-height:180px; overflow:auto; border:1px solid #e2e8f0; border-radius:6px; margin-bottom:20px;">
            <table class="audit-table">
              <thead>
                <tr>
                  <th style="width:120px;">Khóa (PK)</th>
                  ${cols.map((c) => `<th>${esc(c.name)}</th>`).join('')}
                </tr>
              </thead>
              <tbody>
                ${onlySrc.slice(0, 100).map((item) => `
                  <tr>
                    <td style="font-family:monospace; font-weight:600; color:#2563eb;">${app.maskData ? '•••' : esc(item.rowKey)}</td>
                    ${cols.map((c, i) => `<td>${formatVal(Array.isArray(item.row) ? item.row[i] : item.row[c.name], c.name)}</td>`).join('')}
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : '<p style="color:#64748b; font-size:0.9em; margin-bottom:20px;">Không thấy dòng riêng ở mẫu nguồn.</p>'}

        <h4 style="margin:0 0 8px 0; color:#dc2626;">Dòng chỉ thấy trong mẫu đích (${onlyTgt.length})</h4>
        ${onlyTgt.length ? `
          <div style="max-height:180px; overflow:auto; border:1px solid #e2e8f0; border-radius:6px;">
            <table class="audit-table">
              <thead>
                <tr>
                  <th style="width:120px;">Khóa (PK)</th>
                  ${cols.map((c) => `<th>${esc(c.name)}</th>`).join('')}
                </tr>
              </thead>
              <tbody>
                ${onlyTgt.slice(0, 100).map((item) => `
                  <tr>
                    <td style="font-family:monospace; font-weight:600; color:#dc2626;">${app.maskData ? '•••' : esc(item.rowKey)}</td>
                    ${cols.map((c, i) => `<td>${formatVal(Array.isArray(item.row) ? item.row[i] : item.row[c.name], c.name)}</td>`).join('')}
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : '<p style="color:#64748b; font-size:0.9em;">Không thấy dòng riêng ở mẫu đích.</p>'}
      </div>
    `;
  }

  function renderSyncTab() {
    const container = $('#dataDiffTabContent');
    if (!container || !diffResult || !modalCurrent()) return;
    const result = SqlDataDiff.generateSyncSql({ targetTable, diffResult });
    container.innerHTML = `<div class="data-diff-limit" role="status"><h3>Chưa thể đồng bộ từ báo cáo này</h3>
      <p>${esc(result.reason)}</p><p>Cần đọc đủ phạm vi, kiểm chứng khóa/kiểu và snapshot, kiểm tra thay đổi trước ghi cùng cơ chế ghi có điều kiện.</p>
      <button id="syncApplyBtn" disabled>Đồng bộ đang bị khóa</button></div>`;
  }

  document.querySelectorAll('[data-data-diff-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!btn.disabled) switchTab(btn.dataset.dataDiffTab);
    });
  });

  await renderConfigTab();
}

/* ==========================================================================
   G8.1 — LOCAL AUDIT LOGGING & AUDIT VIEWER MODAL
   ========================================================================== */

async function recordAudit(entryInput) {
  if (typeof SqlAuditLog === 'undefined' || !entryInput) return;
  const profileId = entryInput.profileId || app.connection?.id || null;
  const profileName = entryInput.profileName || app.connection?.name || app.connection?.host || 'Chưa kết nối';
  const database = entryInput.database !== undefined ? entryInput.database : (app.database || '');
  const input = Object.assign({ profileId, profileName, database }, entryInput);

  try {
    if (desktop?.auditLog?.append) {
      await desktop.auditLog.append(input);
    } else {
      const entry = SqlAuditLog.createAuditEntry(input);
      let localEntries = [];
      try {
        localEntries = JSON.parse(localStorage.getItem('sqlpro-audit-log') || '[]');
        if (!Array.isArray(localEntries)) localEntries = [];
      } catch {
        localEntries = [];
      }
      localEntries.unshift(entry);
      const pruned = SqlAuditLog.pruneAuditEntries(localEntries, { maxEntries: 1000 });
      localStorage.setItem('sqlpro-audit-log', JSON.stringify(pruned));
    }
  } catch (error) {
    console.warn('Không thể ghi nhật ký thao tác:', error);
  }
}

async function getAuditLogs(filter) {
  if (typeof SqlAuditLog === 'undefined') return [];
  try {
    if (desktop?.auditLog?.read) {
      return await desktop.auditLog.read(filter);
    }
    const local = JSON.parse(localStorage.getItem('sqlpro-audit-log') || '[]');
    return SqlAuditLog.filterAuditEntries(local, filter);
  } catch {
    return [];
  }
}

async function showAuditLogModal() {
  if (typeof SqlAuditLog === 'undefined') {
    toast('Module Audit Log chưa được tải.', 'error');
    return;
  }

  modal(`
    <div class="modal-card audit-modal-card">
      <div class="modal-header">
        <div class="modal-header-left">
          <h3>📋 Nhật ký thao tác <span class="modal-title-tag">Local Audit Log</span></h3>
          <span class="subtle" id="auditHeaderCount">Đang tải...</span>
        </div>
        <button class="close-btn" data-click="close-modal" title="Đóng (Esc)" aria-label="Đóng">✕</button>
      </div>

      <div class="audit-disclaimer-banner">
        <span class="audit-disclaimer-icon">ℹ️</span>
        <span class="audit-disclaimer-text">${esc(SqlAuditLog.AUDIT_DISCLAIMER)}</span>
      </div>

      <div class="audit-toolbar">
        <div class="audit-filters-row">
          <input type="search" id="auditSearchInput" class="audit-search-input" placeholder="🔍 Tìm kiếm thao tác, bảng, CSDL, mã lỗi..." autofocus>
          <select id="auditActionSelect" class="audit-select" title="Lọc theo loại thao tác">
            <option value="ALL">Tất cả thao tác</option>
            <option value="QUERY">Truy vấn (QUERY/SELECT)</option>
            <option value="INSERT">Thêm bản ghi (INSERT)</option>
            <option value="UPDATE">Cập nhật (UPDATE)</option>
            <option value="DELETE">Xóa (DELETE)</option>
            <option value="DDL">Cấu trúc (DDL/ALTER/DROP)</option>
            <option value="EXPORT">Xuất file (EXPORT)</option>
            <option value="IMPORT">Nhập file (IMPORT)</option>
            <option value="BACKUP">Sao lưu (BACKUP)</option>
            <option value="RESTORE">Phục hồi (RESTORE)</option>
            <option value="KILL">Hủy tiến trình (KILL)</option>
            <option value="SCHEMA_DIFF">Đồng bộ Schema</option>
          </select>
          <select id="auditStatusSelect" class="audit-select" title="Lọc theo trạng thái">
            <option value="ALL">Tất cả trạng thái</option>
            <option value="success">✓ Thành công</option>
            <option value="error">✕ Lỗi</option>
          </select>
          <select id="auditTimeSelect" class="audit-select" title="Lọc theo thời gian">
            <option value="ALL">Mọi thời điểm</option>
            <option value="today">Hôm nay</option>
            <option value="7days">7 ngày gần nhất</option>
            <option value="30days">30 ngày gần nhất</option>
          </select>
        </div>

        <div class="audit-actions-row">
          <div class="audit-actions-left">
            <button class="audit-btn" id="auditExportCsvBtn" title="Xuất toàn bộ nhật ký đang lọc ra tệp CSV">📥 Xuất CSV</button>
            <button class="audit-btn" id="auditExportJsonBtn" title="Xuất toàn bộ nhật ký đang lọc ra tệp JSON">📥 Xuất JSON</button>
          </div>
          <div class="audit-actions-right">
            <button class="audit-btn secondary" id="auditPrune30Btn" title="Xóa các bản ghi cũ hơn 30 ngày để tiết kiệm dung lượng">🧹 Dọn >30 ngày</button>
            <button class="audit-btn danger" id="auditClearBtn" title="Xóa toàn bộ lịch sử nhật ký thao tác">🗑️ Xóa toàn bộ</button>
          </div>
        </div>
      </div>

      <div class="modal-body audit-modal-body" id="auditModalBody">
        <div id="auditTableContainer" class="audit-table-container">
          <div class="processlist-loading">Đang tải dữ liệu nhật ký...</div>
        </div>
      </div>

      <div class="modal-footer">
        <div class="modal-footer-hint">
          <span>💡 <em>Dữ liệu nhạy cảm và mật khẩu đã được tự động che giấu bằng ký tự hoa thị (***).</em></span>
        </div>
        <button class="secondary" data-click="close-modal">Đóng (Esc)</button>
      </div>
    </div>
  `);

  let allEntries = [];
  let expandedEntryId = null;

  async function loadData() {
    try {
      allEntries = await getAuditLogs();
      renderEntries();
    } catch (err) {
      const container = $('#auditTableContainer');
      if (container) container.innerHTML = `<div class="processlist-empty" style="color:#ef4444;">Lỗi khi đọc nhật ký thao tác: ${esc(err.message)}</div>`;
    }
  }

  function getFilteredEntries() {
    const search = $('#auditSearchInput')?.value.trim() || '';
    const actionType = $('#auditActionSelect')?.value || 'ALL';
    const status = $('#auditStatusSelect')?.value || 'ALL';
    const timeFilter = $('#auditTimeSelect')?.value || 'ALL';

    let fromTime = null;
    const now = Date.now();
    if (timeFilter === 'today') {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      fromTime = startOfDay.toISOString();
    } else if (timeFilter === '7days') {
      fromTime = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    } else if (timeFilter === '30days') {
      fromTime = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    }

    return SqlAuditLog.filterAuditEntries(allEntries, {
      search,
      actionType: actionType === 'ALL' ? null : actionType,
      status: status === 'ALL' ? null : status,
      fromTime
    });
  }

  function renderEntries() {
    const container = $('#auditTableContainer');
    const headerCount = $('#auditHeaderCount');
    if (!container) return;

    const filtered = getFilteredEntries();
    if (headerCount) {
      headerCount.textContent = `${filtered.length} / ${allEntries.length} bản ghi`;
    }

    if (!filtered.length) {
      container.innerHTML = `
        <div class="processlist-empty">
          <div style="font-size:2em; margin-bottom:8px;">📋</div>
          <div>Không tìm thấy nhật ký thao tác nào phù hợp.</div>
        </div>
      `;
      return;
    }

    function formatTime(isoString) {
      if (!isoString) return '—';
      const d = new Date(isoString);
      if (isNaN(d.getTime())) return isoString;
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
    }

    container.innerHTML = `
      <table class="audit-table">
        <thead>
          <tr>
            <th style="width:130px;">Thời gian</th>
            <th style="width:140px;">Kết nối / CSDL</th>
            <th style="width:90px;">Thao tác</th>
            <th>Tóm tắt thao tác</th>
            <th style="width:70px; text-align:right;">Số dòng</th>
            <th style="width:80px; text-align:right;">Thời lượng</th>
            <th style="width:100px; text-align:center;">Trạng thái</th>
          </tr>
        </thead>
        <tbody>
          ${filtered.map((entry) => {
            const isExpanded = expandedEntryId === entry.id;
            const statusClass = entry.status === 'success' ? 'audit-status-success' : 'audit-status-error';
            const statusText = entry.status === 'success' ? '✓ Thành công' : '✕ Lỗi';
            const actionBadgeClass = `audit-badge audit-badge-${entry.actionType.toLowerCase()}`;
            const targetLabel = [entry.profileName, entry.database].filter(Boolean).join(' / ') || '—';

            return `
              <tr class="audit-row ${isExpanded ? 'expanded' : ''}" data-entry-id="${esc(entry.id)}" style="cursor:pointer;">
                <td style="font-family:monospace; font-size:0.85em; color:#64748b;">${formatTime(entry.timestamp)}</td>
                <td style="max-width:140px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${esc(targetLabel)}">${esc(targetLabel)}</td>
                <td><span class="${actionBadgeClass}">${esc(entry.actionType)}</span></td>
                <td class="audit-summary-cell" title="${esc(entry.summary)}">
                  ${esc(entry.summary)}
                  ${entry.errorCode ? `<span class="audit-error-code">[${esc(entry.errorCode)}]</span>` : ''}
                </td>
                <td style="text-align:right; font-family:monospace;">${entry.affectedRows !== null ? entry.affectedRows : '—'}</td>
                <td style="text-align:right; font-family:monospace; font-size:0.85em; color:#64748b;">${entry.durationMs} ms</td>
                <td style="text-align:center;"><span class="${statusClass}">${statusText}</span></td>
              </tr>
              ${isExpanded ? `
                <tr class="audit-detail-row">
                  <td colspan="7">
                    <div class="audit-detail-card">
                      <div class="audit-detail-grid">
                        <div><strong>Mã bản ghi:</strong> <code>${esc(entry.id)}</code></div>
                        <div><strong>Thời điểm ISO:</strong> <code>${esc(entry.timestamp)}</code></div>
                        <div><strong>Kết nối:</strong> ${esc(entry.profileName)} (${esc(entry.profileId)})</div>
                        <div><strong>CSDL:</strong> ${esc(entry.database || '—')}</div>
                        ${entry.table ? `<div><strong>Bảng:</strong> <code>${esc(entry.table)}</code></div>` : ''}
                        ${entry.errorCode ? `<div><strong style="color:#ef4444;">Mã lỗi:</strong> <code>${esc(entry.errorCode)}</code></div>` : ''}
                        ${entry.errorSummary ? `<div style="grid-column:1 / -1;"><strong style="color:#ef4444;">Chi tiết lỗi:</strong> <div class="audit-error-box">${esc(entry.errorSummary)}</div></div>` : ''}
                      </div>
                    </div>
                  </td>
                </tr>
              ` : ''}
            `;
          }).join('')}
        </tbody>
      </table>
    `;

    container.querySelectorAll('.audit-row').forEach((row) => {
      row.addEventListener('click', () => {
        const id = row.dataset.entryId;
        expandedEntryId = expandedEntryId === id ? null : id;
        renderEntries();
      });
    });
  }

  $('#auditSearchInput')?.addEventListener('input', debounce(renderEntries, 200));
  $('#auditActionSelect')?.addEventListener('change', renderEntries);
  $('#auditStatusSelect')?.addEventListener('change', renderEntries);
  $('#auditTimeSelect')?.addEventListener('change', renderEntries);

  $('#auditExportCsvBtn')?.addEventListener('click', async () => {
    const filtered = getFilteredEntries();
    if (!filtered.length) {
      toast('Không có bản ghi nào để xuất.', 'info');
      return;
    }
    const csvData = SqlAuditLog.exportAuditCsv(filtered);
    try {
      if (desktop?.saveTextFile) {
        const res = await desktop.saveTextFile({
          suggestedName: `sqlpro-audit-log-${Date.now()}.csv`,
          contents: csvData,
          filters: [{ name: 'CSV File', extensions: ['csv'] }]
        });
        if (!res.canceled) toast(`Đã xuất ${filtered.length} bản ghi audit ra CSV`, 'success');
      } else {
        const blob = new Blob([csvData], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `sqlpro-audit-log-${Date.now()}.csv`;
        link.click();
        URL.revokeObjectURL(url);
        toast(`Đã xuất ${filtered.length} bản ghi audit ra CSV`, 'success');
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#auditExportJsonBtn')?.addEventListener('click', async () => {
    const filtered = getFilteredEntries();
    if (!filtered.length) {
      toast('Không có bản ghi nào để xuất.', 'info');
      return;
    }
    const jsonData = SqlAuditLog.exportAuditJson(filtered);
    try {
      if (desktop?.saveTextFile) {
        const res = await desktop.saveTextFile({
          suggestedName: `sqlpro-audit-log-${Date.now()}.json`,
          contents: jsonData,
          filters: [{ name: 'JSON File', extensions: ['json'] }]
        });
        if (!res.canceled) toast(`Đã xuất ${filtered.length} bản ghi audit ra JSON`, 'success');
      } else {
        const blob = new Blob([jsonData], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `sqlpro-audit-log-${Date.now()}.json`;
        link.click();
        URL.revokeObjectURL(url);
        toast(`Đã xuất ${filtered.length} bản ghi audit ra JSON`, 'success');
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#auditPrune30Btn')?.addEventListener('click', async () => {
    const confirmed = await confirmAction(
      'Dọn dẹp nhật ký cũ hơn 30 ngày?',
      'Các bản ghi thao tác được tạo cách đây hơn 30 ngày sẽ bị xóa vĩnh viễn khỏi thiết bị để giải phóng dung lượng.',
      'Dọn dẹp'
    );
    if (!confirmed) return;

    try {
      if (desktop?.auditLog?.prune) {
        const res = await desktop.auditLog.prune({ maxAgeDays: 30 });
        toast(`Đã dọn dẹp ${res.prunedCount} bản ghi cũ`, 'success');
      } else {
        const pruned = SqlAuditLog.pruneAuditEntries(allEntries, { maxAgeDays: 30 });
        localStorage.setItem('sqlpro-audit-log', JSON.stringify(pruned));
        toast('Đã dọn dẹp nhật ký cũ', 'success');
      }
      await loadData();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#auditClearBtn')?.addEventListener('click', async () => {
    const confirmed = await confirmAction(
      'Xóa toàn bộ nhật ký thao tác?',
      'Toàn bộ lịch sử nhật ký thao tác cục bộ trên máy này sẽ bị xóa sạch. Thao tác này không thể hoàn tác.',
      'Xóa sạch'
    );
    if (!confirmed) return;

    try {
      if (desktop?.auditLog?.clear) {
        await desktop.auditLog.clear();
      } else {
        localStorage.removeItem('sqlpro-audit-log');
      }
      toast('Đã xóa toàn bộ nhật ký thao tác', 'success');
      await loadData();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  await loadData();
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
    const res = await call(desktop.db.query({ ...activeQueryTarget(), sql: `${opName} TABLE ${quoteId(app.database)}.${quoteId(tableName)}`, confirmed: true }));
    const rows = res.rows || [];

    modal(`
      <div class="modal-card" style="max-width:620px;">
        <div class="modal-header">
          <h3>🛠️ Kết Quả Bảo Trì: ${esc(opName)} TABLE</h3>
          <button class="close-btn" data-click="close-modal">✕</button>
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
          <button class="primary" data-click="close-modal">Đóng</button>
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

function queryResultTableTarget(result) {
  if (result?.isExplain || !result?.columns?.length) return null;
  const first = result.columns[0];
  const targetTable = first.orgTable || first.table;
  const database = first.db || app.query?.resultContext?.database || app.query?.database || app.database;
  if (!targetTable || !database) return null;
  if (result.columns.some((column) => (column.orgTable || column.table) !== targetTable
    || (column.db && column.db !== database)
    || (first.table && column.table && column.table !== first.table))) return null;
  return { targetTable, database, profileId: app.query?.resultContext?.profileId || app.query?.profileId || app.connection?.id || null };
}

function queryResultPrimaryKeyIndexes(result, target) {
  const cacheKey = JSON.stringify([target.profileId || '', target.database, target.targetTable]);
  const cached = queryTablePkCache.get(cacheKey);
  const currentTable = target.targetTable === table && target.database === app.database
    && target.profileId === app.connection?.id ? app.primaryKey : null;
  const keys = cached || currentTable || [];
  if (!keys.length) return [];
  const indexes = keys.map((key) => result.columns.findIndex((column) =>
    (column.orgName || column.name).toLowerCase() === key.toLowerCase()
    && (column.orgTable || column.table) === target.targetTable
    && (!column.db || column.db === target.database)));
  return indexes.every((index) => index >= 0) ? indexes : [];
}

function queryResultSqlValue(value, column) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (/^(?:tinyblob|blob|mediumblob|longblob|binary|varbinary|bit)\b/i.test(column.type || '')
    && /^0x[0-9a-f]*$/i.test(String(value))) return String(value);
  return quoteSqlString(value);
}

function queryResultStatement(result, rowIndex, kind) {
  const target = queryResultTableTarget(result);
  const row = result?.rows?.[rowIndex];
  if (!target || !row || result.columns.some((column) => !column.orgName || /\bgenerated\b/i.test(column.extra || ''))
    || result.columns.some((column, index) => /… \(\d+ bytes\)$/.test(String(row[index])))) return null;
  const names = result.columns.map((column) => column.orgName);
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) return null;
  const tableName = `${quoteId(target.database)}.${quoteId(target.targetTable)}`;
  const values = row.map((value, index) => queryResultSqlValue(value, result.columns[index]));
  if (kind === 'insert') {
    return `INSERT INTO ${tableName} (${names.map(quoteId).join(', ')}) VALUES (${values.join(', ')});`;
  }
  if (kind !== 'update') return null;
  const keys = queryResultPrimaryKeyIndexes(result, target);
  if (!keys.length || keys.some((index) => row[index] === null || row[index] === undefined)) return null;
  const changes = names.map((name, index) => keys.includes(index) ? null : `${quoteId(name)} = ${values[index]}`).filter(Boolean);
  if (!changes.length) return null;
  const where = keys.map((index) => `${quoteId(names[index])} = ${values[index]}`).join(' AND ');
  return `UPDATE ${tableName} SET ${changes.join(', ')} WHERE ${where} LIMIT 1;`;
}

function queryResultCopyText(result, rowIndex, colIndex, kind) {
  const row = result?.rows?.[rowIndex];
  if (!row || !result.columns?.[colIndex]) return null;
  if (kind === 'cell') return row[colIndex] === null || row[colIndex] === undefined ? '' : String(row[colIndex]);
  if (kind === 'field') return result.columns[colIndex].name;
  if (kind === 'insert' || kind === 'update') return queryResultStatement(result, rowIndex, kind);
  const names = ExportValues.uniqueColumnNames(result.columns.map((column) => column.name));
  if (kind === 'json') {
    const object = Object.create(null);
    names.forEach((name, index) => { object[name] = row[index]; });
    return JSON.stringify(object, null, 2);
  }
  const match = /^(tsv|csv)-(data|fields|all)$/.exec(kind);
  if (!match) return null;
  const delimiter = match[1] === 'tsv' ? '\t' : ',';
  const fields = names.map((name) => ExportValues.csvField(name, delimiter)).join(delimiter);
  const data = row.map((value) => ExportValues.csvField(value, delimiter)).join(delimiter);
  return match[2] === 'fields' ? fields : match[2] === 'data' ? data : `${fields}\r\n${data}`;
}

const queryGridSelections = new WeakMap();
const queryGridOrderCache = new WeakMap();

function queryGridOrderedRows(result) {
  const column = app.query.sortCol;
  const direction = app.query.sortDir;
  const cached = queryGridOrderCache.get(result);
  if (cached && cached.rows === result.rows && cached.length === result.rows.length
    && cached.column === column && cached.direction === direction) return cached.ordered;
  const ordered = QueryResults.orderedRows(result.rows, column < result.columns.length ? column : null, direction);
  queryGridOrderCache.set(result, { rows: result.rows, length: result.rows.length, column, direction, ordered });
  return ordered;
}

function queryGridSelection(result) {
  if (!queryGridSelections.has(result)) queryGridSelections.set(result, { rows: new Set(), anchor: null, focus: null });
  return queryGridSelections.get(result);
}

function queryGridRowOrder(result) {
  return queryGridOrderedRows(result).map(({ origIndex }) => origIndex);
}

function queryGridSelectedIndexes(result) {
  const selected = queryGridSelection(result).rows;
  return queryGridRowOrder(result).filter((index) => selected.has(index));
}

function selectQueryGridRows(result, index, { toggle = false, range = false, base = null, order = null } = {}) {
  const selection = queryGridSelection(result);
  if (!result.rows[index]) return;
  if (range && selection.anchor !== null) {
    const indexes = order || queryGridRowOrder(result);
    const start = indexes.indexOf(selection.anchor);
    const end = indexes.indexOf(index);
    if (start < 0 || end < 0) return;
    selection.rows = new Set(base || []);
    indexes.slice(Math.min(start, end), Math.max(start, end) + 1).forEach((row) => selection.rows.add(row));
  } else if (toggle) {
    if (selection.rows.has(index)) selection.rows.delete(index);
    else selection.rows.add(index);
    selection.anchor = index;
  } else {
    selection.rows = new Set([index]);
    selection.anchor = index;
  }
  selection.focus = index;
}

function updateQueryGridSelection(result) {
  if (getActiveQueryResult() !== result) return;
  const selected = queryGridSelection(result).rows;
  document.querySelectorAll('#queryResult tr[data-query-row]').forEach((row) => {
    const active = selected.has(Number(row.dataset.queryRow));
    if (row.classList.contains('query-row-selected') !== active) {
      row.classList.toggle('query-row-selected', active);
      row.setAttribute('aria-selected', String(active));
    }
  });
  const status = $('#queryResult [data-query-selection-count]');
  if (status) status.textContent = `${selected.size.toLocaleString()} dòng đã chọn`;
}

function queryGridCopyText(result, indexes, colIndex, kind) {
  if (!indexes.length) return null;
  if (kind === 'field' || /^(tsv|csv)-fields$/.test(kind)) return queryResultCopyText(result, indexes[0], colIndex, kind);
  if (kind === 'cell' && indexes.length === 1) return queryResultCopyText(result, indexes[0], colIndex, kind);
  if (kind === 'json') {
    const objects = indexes.map((index) => JSON.parse(queryResultCopyText(result, index, colIndex, kind)));
    return indexes.length === 1 ? JSON.stringify(objects[0], null, 2) : JSON.stringify(objects, null, 2);
  }
  const format = kind === 'cell' ? 'tsv-data' : kind;
  const texts = indexes.map((index, position) => queryResultCopyText(result, index, colIndex,
    position > 0 ? format.replace(/-all$/, '-data') : format));
  return texts.some((text) => text === null) ? null : texts.join(kind === 'insert' || kind === 'update' ? '\n' : '\r\n');
}

function setupQueryGridSelection(output) {
  setupQueryGridViewport(output);
  let drag = null;
  let frame = null;
  const isEditor = (target) => target.closest('input, textarea, select, button, [contenteditable="true"], .editing-cell');
  const stopDrag = () => {
    drag = null;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    document.removeEventListener('mousemove', moveDrag);
    document.removeEventListener('mouseup', stopDrag);
    window.removeEventListener('blur', stopDrag);
  };
  const drawDrag = () => {
    frame = null;
    if (!drag || !output.isConnected || getActiveQueryResult() !== drag.result) { stopDrag(); return; }
    const { box, x, y } = drag;
    const bounds = box.getBoundingClientRect();
    const scroll = y < bounds.top + 24 ? -18 : y > bounds.bottom - 24 ? 18 : 0;
    const oldScroll = box.scrollTop;
    if (scroll) box.scrollTop += scroll;
    const target = document.elementFromPoint(Math.max(bounds.left + 2, Math.min(x, bounds.right - 2)),
      Math.max(bounds.top + 2, Math.min(y, bounds.bottom - 2)))?.closest('tr[data-query-row]');
    if (target && box.contains(target)) {
      const index = Number(target.dataset.queryRow);
      if (index !== drag.last) {
        drag.last = index;
        selectQueryGridRows(drag.result, index, { range: true, base: drag.base, order: drag.order });
        updateQueryGridSelection(drag.result);
      }
    }
    if (scroll && oldScroll !== box.scrollTop) frame = requestAnimationFrame(drawDrag);
  };
  const moveDrag = (event) => {
    if (!drag) return;
    if (!(event.buttons & 1)) { stopDrag(); return; }
    event.preventDefault();
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (frame === null) frame = requestAnimationFrame(drawDrag);
  };
  output.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || isEditor(event.target)) return;
    const row = event.target.closest('tr[data-query-row]');
    if (!row) return;
    const result = getActiveQueryResult();
    if (!result?.rows) return;
    event.preventDefault();
    stopDrag();
    const box = row.closest('.tablebox');
    box.focus({ preventScroll: true });
    const index = Number(row.dataset.queryRow);
    const toggle = event.ctrlKey || event.metaKey;
    const selection = queryGridSelection(result);
    const base = toggle ? new Set(selection.rows) : null;
    const order = queryGridRowOrder(result);
    selectQueryGridRows(result, index, { toggle, range: event.shiftKey, base, order });
    updateQueryGridSelection(result);
    if (event.detail > 1 || (toggle && !event.shiftKey)) return;
    drag = { result, box, base, order, last: index, x: event.clientX, y: event.clientY };
    document.addEventListener('mousemove', moveDrag, { passive: false });
    document.addEventListener('mouseup', stopDrag);
    window.addEventListener('blur', stopDrag);
  });
  output.addEventListener('keydown', (event) => {
    if (isEditor(event.target) || !event.target.closest('[data-query-grid]')) return;
    const result = getActiveQueryResult();
    if (!result?.rows) return;
    const selection = queryGridSelection(result);
    const command = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (command && key === 'a') {
      event.preventDefault(); event.stopPropagation();
      const order = queryGridRowOrder(result);
      selection.rows = new Set(order);
      selection.anchor = order[0] ?? null;
      selection.focus = order.at(-1) ?? null;
      updateQueryGridSelection(result);
    } else if (command && key === 'c' && selection.rows.size) {
      event.preventDefault(); event.stopPropagation();
      const text = queryGridCopyText(result, queryGridSelectedIndexes(result), 0, 'tsv-data');
      void writeClipboardText(text).catch((error) => toast(error.message, 'error'));
    } else if (event.key === 'Delete' && selection.rows.size) {
      event.preventDefault(); event.stopPropagation();
      void deleteQueryResultRows(result, queryGridSelectedIndexes(result));
    } else if (event.key === 'Escape') {
      event.preventDefault();
      selection.rows.clear(); selection.anchor = null; selection.focus = null;
      updateQueryGridSelection(result);
    } else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const order = queryGridRowOrder(result);
      if (!order.length) return;
      const current = order.indexOf(selection.focus);
      const position = event.key === 'Home' ? 0 : event.key === 'End' ? order.length - 1
        : Math.max(0, Math.min(order.length - 1, current < 0 ? 0 : current + (event.key === 'ArrowDown' ? 1 : -1)));
      selectQueryGridRows(result, order[position], { range: event.shiftKey });
      updateQueryGridSelection(result);
      const box = output.querySelector('[data-query-grid]');
      if (result.rows.length > 200 && box) {
        box.scrollTop = Math.max(0, position * QUERY_GRID_ROW_HEIGHT * ((app.query.gridZoom || 100) / 100));
        renderQueryGridWindow(box, result);
      }
      output.querySelector(`tr[data-query-row="${order[position]}"]`)?.scrollIntoView({ block: 'nearest' });
    }
  });
}

function queryResultContextMenuHtml({ source, cellEditable, tableTarget, rowEditable, canInsertSql, canUpdateSql, selectedCount = 1 }) {
  const item = (action, label, enabled = true, icon = '') => `<button type="button" class="context-menu-item${enabled ? '' : ' disabled'}" data-query-action="${action}" ${enabled ? '' : 'disabled'}>${icon ? `<span class="c-icon">${icon}</span>` : ''}${label}</button>`;
  return `
    ${item('empty', 'Đặt chuỗi rỗng', cellEditable, '∅')}
    ${item('null', 'Đặt NULL', cellEditable, '⊘')}
    ${item('edit', `Sửa ô (${esc(source.name)})`, cellEditable, '✎')}
    <div class="context-menu-divider"></div>
    ${item('add', 'Thêm bản ghi…', Boolean(tableTarget), '+')}
    ${item('delete', selectedCount > 1 ? `Xóa ${selectedCount.toLocaleString()} dòng đã chọn…` : 'Xóa bản ghi…', rowEditable, '⌫')}
    <div class="context-menu-divider"></div>
    ${item('cell', selectedCount > 1 ? `Sao chép ${selectedCount.toLocaleString()} dòng đã chọn` : 'Sao chép giá trị ô', true, '⧉')}
    ${item('field', 'Sao chép tên cột', true, '⌑')}
    ${item('paste', 'Dán vào ô sửa…', cellEditable, '⇥')}
    <div class="context-submenu-wrap">
      <button type="button" class="context-menu-item context-submenu-trigger" data-query-submenu aria-haspopup="true" aria-expanded="false">Copy As · Sao chép dạng… <span aria-hidden="true">›</span></button>
      <div class="context-submenu" role="menu" aria-label="Định dạng sao chép">
        ${item('insert', 'INSERT Statement', canInsertSql)}
        ${item('update', 'UPDATE Statement', canUpdateSql)}
        <div class="context-menu-divider"></div>
        ${item('tsv-data', 'TSV · chỉ dữ liệu')}
        ${item('tsv-fields', 'TSV · chỉ tên cột')}
        ${item('tsv-all', 'TSV · tên cột và dữ liệu')}
        ${item('csv-data', 'CSV · chỉ dữ liệu')}
        ${item('csv-fields', 'CSV · chỉ tên cột')}
        ${item('csv-all', 'CSV · tên cột và dữ liệu')}
        ${item('json', 'JSON')}
      </div>
    </div>
    <div class="context-menu-divider"></div>
    <div class="context-submenu-wrap">
      <button type="button" class="context-menu-item context-submenu-trigger" data-query-submenu aria-haspopup="true" aria-expanded="false">Thu phóng bảng <span aria-hidden="true">›</span></button>
      <div class="context-submenu" role="menu" aria-label="Thu phóng bảng kết quả">
        ${item('zoom-90', '90%')}
        ${item('zoom-100', '100%')}
        ${item('zoom-125', '125%')}
      </div>
    </div>`;
}

function setupContextMenu() {
  const menu = $('#contextMenu');
  if (!menu) return;

  function closeMenu() {
    menu.classList.add('hidden');
    menu.innerHTML = '';
    document.querySelectorAll('#queryResult tr.query-context-selected').forEach((row) => row.classList.remove('query-context-selected'));
  }

  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();

    const isInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    if (isInput) return;

    const isCmdOrCtrl = e.ctrlKey || e.metaKey;
    if (isCmdOrCtrl && e.key.toLowerCase() === 'c') {
      if (app.selectedBackupId && (mode === 'backups' || document.activeElement?.closest('[data-restore-backup]'))) {
        e.preventDefault();
        copySelectedBackupToClipboard(app.selectedBackupId);
      }
    } else if (isCmdOrCtrl && e.key.toLowerCase() === 'v') {
      if (app.copiedBackup) {
        e.preventDefault();
        pasteBackupModal();
      }
    }
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
            await writeClipboardText(cellVal === null || cellVal === undefined ? '' : String(cellVal));
            toast('Đã sao chép giá trị ô', 'success');
          } else if (action === 'copy-row-json') {
            await writeClipboardText(JSON.stringify(rowData, null, 2));
            toast('Đã sao chép dòng dạng JSON', 'success');
          } else if (action === 'copy-row-insert') {
            const cols = Object.keys(rowData).map(quoteId).join(', ');
            const vals = Object.values(rowData).map((v) => {
              if (v === null || v === undefined) return 'NULL';
              if (typeof v === 'number') return v;
              return quoteSqlString(v);
            }).join(', ');
            const insertSql = `INSERT INTO ${quoteId(table)} (${cols}) VALUES (${vals});`;
            await writeClipboardText(insertSql);
            toast('Đã sao chép câu lệnh INSERT', 'success');
          } else if (action === 'set-cell-null') {
            const keys = {};
            for (const pk of app.primaryKey) keys[pk] = rowData[pk];
            try {
              requireRowUpdate(await call(desktop.db.updateRow({
                profileId: app.connection?.id || null,
                database: app.database,
                table,
                keys,
                values: { [colName]: null },
                original: originalRow(rowData)
              })));
              rowData[colName] = null;
              gridTd.className = 'nullcell cell-flash-saved';
              gridTd.innerHTML = '<span class="null-badge">NULL</span>';
              setTimeout(() => gridTd.classList.remove('cell-flash-saved'), 1500);
              toast(`Đã đặt "${colName}" thành NULL`, 'success');
            } catch (err) {
              if (err.code === 'ROW_CONFLICT' || err.code === 'ROW_NOT_FOUND') {
                showRowConflict(err, { reload: () => loadData({ keepScroll: true }) });
              } else toast(err.message, 'error');
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
              await call(desktop.db.deleteRows({
                profileId: app.connection?.id || null,
                database,
                table: targetTable,
                keysList: [keys],
                originalValues: [originalRow(rowData)]
              }));
              toast('Đã xóa dòng thành công', 'success');
              await loadData({ keepScroll: true });
            } catch (err) {
              if (err.code === 'ROW_CONFLICT' || err.code === 'ROW_NOT_FOUND') {
                showRowConflict(err, { reload: () => loadData({ keepScroll: true }) });
              } else toast(err.message, 'error');
            }
          }
        });
      });
      return;
    }

    const queryTd = event.target.closest('#queryResult tr[data-query-row] td');
    if (queryTd && !queryTd.classList.contains('editing-cell')) {
      const tr = queryTd.closest('tr[data-query-row]');
      if (!tr) return;
      event.preventDefault();
      const colIdx = Number(queryTd.dataset.colIdx ?? 0);
      const rowIdx = Number(tr.dataset.queryRow);
      const result = getActiveQueryResult();
      if (!result?.rows?.[rowIdx] || !Number.isInteger(colIdx) || !result.columns?.[colIdx]) return;
      document.querySelectorAll('#queryResult tr.query-context-selected').forEach((row) => row.classList.remove('query-context-selected'));
      tr.classList.add('query-context-selected');
      if (!queryGridSelection(result).rows.has(rowIdx)) selectQueryGridRows(result, rowIdx);
      updateQueryGridSelection(result);
      queryTd.closest('.tablebox').focus({ preventScroll: true });
      const selectedIndexes = queryGridSelectedIndexes(result);
      const source = result.columns[colIdx];
      const tableTarget = queryResultTableTarget(result);
      const isReadOnly = connectionIsReadOnly(tableTarget?.profileId || app.query?.resultContext?.profileId || app.query?.profileId || app.connection?.id);
      const cellEditable = !isReadOnly && selectedIndexes.length === 1 && !queryTd.classList.contains('muted')
        && !result.isExplain && Boolean(source.orgTable || source.table);
      menu.innerHTML = queryResultContextMenuHtml({ source, cellEditable, tableTarget: isReadOnly ? null : tableTarget, rowEditable: false,
        selectedCount: selectedIndexes.length,
        canInsertSql: selectedIndexes.every((index) => Boolean(queryResultStatement(result, index, 'insert'))),
        canUpdateSql: false });
      const menuContent = menu.firstElementChild;
      positionMenu(event.clientX, event.clientY);
      menu.querySelectorAll('[data-query-submenu]').forEach((trigger) => {
        const fitSubmenu = () => {
          const submenu = trigger.nextElementSibling;
          submenu.style.top = '-5px';
          const bounds = submenu.getBoundingClientRect();
          if (bounds.bottom > window.innerHeight - 8) {
            submenu.style.top = `${-5 - (bounds.bottom - window.innerHeight + 8)}px`;
          }
        };
        trigger.parentElement.addEventListener('mouseenter', fitSubmenu);
        trigger.addEventListener('click', (click) => {
          click.stopPropagation();
          const open = trigger.parentElement.classList.toggle('open');
          trigger.setAttribute('aria-expanded', String(open));
          if (open) fitSubmenu();
        });
      });
      menu.querySelectorAll('[data-query-action]').forEach((item) => item.addEventListener('click', async () => {
        const action = item.dataset.queryAction;
        if (item.disabled) return;
        closeMenu();
        try {
          if (action === 'edit') return void inlineEditQueryResultCell(queryTd);
          if (action === 'paste') return void pasteQueryResultCell(queryTd);
          if (action === 'empty' || action === 'null') return void setQueryResultCellValue(queryTd, action === 'null' ? null : '');
          if (action === 'add') return void editRow(null, { result, ...tableTarget });
          if (action === 'delete') return void deleteQueryResultRows(result, selectedIndexes);
          if (action.startsWith('zoom-')) {
            const zoom = Number(action.slice(5));
            app.query.gridZoom = zoom;
            $('#queryResult')?.style.setProperty('--query-grid-zoom', String(zoom / 100));
            return;
          }
          const text = queryGridCopyText(result, selectedIndexes, colIdx, action);
          if (text === null) throw new Error('Không thể tạo nội dung sao chép từ kết quả này.');
          await writeClipboardText(text);
          toast('Đã sao chép vào clipboard', 'success');
        } catch (error) { toast(error.message || 'Không thể sao chép dữ liệu.', 'error'); }
      }));
      if (tableTarget && desktop?.db?.columns) {
        void call(desktop.db.columns(tableTarget.database, tableTarget.targetTable, tableTarget.profileId)).then((columns) => {
          if (menu.firstElementChild !== menuContent || menu.classList.contains('hidden') || !tr.classList.contains('query-context-selected')
            || getActiveQueryResult() !== result) return;
          const cacheKey = JSON.stringify([tableTarget.profileId || '', tableTarget.database, tableTarget.targetTable]);
          queryTablePkCache.set(cacheKey, columns.filter((column) => column.key === 'PRI').map((column) => column.name));
          const editable = !isReadOnly && queryResultPrimaryKeyIndexes(result, tableTarget).length > 0;
          const deleteButton = menu.querySelector('[data-query-action="delete"]');
          const updateButton = menu.querySelector('[data-query-action="update"]');
          if (deleteButton) {
            deleteButton.disabled = !editable;
            deleteButton.classList.toggle('disabled', deleteButton.disabled);
          }
          if (updateButton) {
            updateButton.disabled = !editable || !selectedIndexes.every((index) => queryResultStatement(result, index, 'update'));
            updateButton.classList.toggle('disabled', updateButton.disabled);
          }
        }).catch(() => undefined);
      }
      return;
    }

    const tabBtn = event.target.closest('#tabs [data-query-tab]');
    if (tabBtn) {
      event.preventDefault();
      const tabIndex = Number(tabBtn.dataset.queryTab);
      if (tabIndex < 0 || tabIndex >= queryTabs.length) return;
      menu.innerHTML = `
        <div class="context-menu-item" data-tab-action="rename"><span class="c-icon">✎</span> Đổi tên tab…</div>
        <div class="context-menu-item" data-tab-action="reindex"><span class="c-icon">🔢</span> Đánh số lại các tab (Query 1, 2…)</div>
        <div class="context-menu-item" data-tab-action="duplicate"><span class="c-icon">⎘</span> Nhân bản tab</div>
        <div class="context-menu-divider"></div>
        <div class="context-menu-item" data-tab-action="close"><span class="c-icon">✕</span> Đóng tab</div>
        <div class="context-menu-item" data-tab-action="close-others"><span class="c-icon">✕</span> Đóng các tab khác</div>
        <div class="context-menu-item" data-tab-action="close-right"><span class="c-icon">⇥</span> Đóng các tab bên phải</div>
      `;
      positionMenu(event.clientX, event.clientY);
      menu.querySelectorAll('.context-menu-item').forEach((item) => {
        item.addEventListener('click', () => {
          const act = item.dataset.tabAction;
          closeMenu();
          if (act === 'rename') promptRenameQueryTab(tabIndex);
          else if (act === 'reindex') reindexQueryTabs();
          else if (act === 'duplicate') duplicateQueryTab(tabIndex);
          else if (act === 'close') closeQueryTab(tabIndex);
          else if (act === 'close-others') closeOtherQueryTabs(tabIndex);
          else if (act === 'close-right') closeQueryTabsToRight(tabIndex);
        });
      });
      return;
    }
  });

  const sidebar = $('.sidebar');
  if (!sidebar) return;

  sidebar.addEventListener('contextmenu', (event) => {
    const backupEntry = event.target.closest('[data-restore-backup]');
    const backupGroup = event.target.closest('[data-tree-group="backups"]');
    if (backupEntry || backupGroup) {
      event.preventDefault();
      app.selectedBackupId = backupEntry?.dataset.restoreBackup || null;
      openTreeGroups.add('backups');
      if (mode !== 'backups') view('backups');
      else renderBackupsView();
      renderSidebar();
      menu.innerHTML = backupContextMenuHtml(Boolean(backupEntry));
      positionMenu(event.clientX, event.clientY);
      menu.querySelectorAll('[data-backup-menu]').forEach((item) => {
        item.addEventListener('click', () => {
          closeMenu();
          runBackupManagerAction(item.dataset.backupMenu);
        });
      });
      return;
    }
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
          else if (act === 'copy-name') { writeClipboardText(tableName); toast('Đã sao chép: ' + tableName); }
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
      const dbConnId = dbItem.closest('[data-connection-id]')?.dataset.connectionId || app.connection?.id;
      const canPaste = Boolean(app.copiedBackup);
      menu.innerHTML = `
        <div class="context-menu-item" data-action="select-db"><span class="c-icon">▱</span> Chọn database này</div>
        <div class="context-menu-item" data-action="create-table"><span class="c-icon">＋</span> Tạo bảng mới</div>
        <div class="context-menu-item" data-action="backup-db"><span class="c-icon">⇩</span> Sao lưu database…</div>
        <div class="context-menu-item" data-action="restore-db"><span class="c-icon">⇧</span> Phục hồi database…</div>
        ${canPaste ? `<div class="context-menu-item" data-action="paste-db"><span class="c-icon">📋</span> Dán bản sao lưu vào Database này (Ctrl+V)</div>` : ''}
        <div class="context-menu-item" data-action="copy-db"><span class="c-icon">⧉</span> Sao chép sang Database khác…</div>
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
          else if (act === 'paste-db') pasteBackupModal(dbName, dbConnId);
          else if (act === 'copy-db') copyDatabaseAction(dbName, dbConnId);
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
    const left = Math.max(8, Math.min(x, maxX));
    menu.style.left = left + 'px';
    menu.style.top = Math.max(8, Math.min(y, maxY)) + 'px';
    menu.classList.toggle('submenu-left', Boolean(menu.querySelector('.context-submenu'))
      && left + menu.offsetWidth + 275 > window.innerWidth);
  }
}


function activateSidebarItem(event) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  if (!event.target.matches('[role="button"][data-db], [role="button"][data-db-list], [role="button"][data-table]')) return;
  event.preventDefault();
  event.target.click();
}

function onConnectionClick(event) {
  if (event.target.closest('.conn-children')) {
    onTreeClick(event);
    return;
  }
  const menuButton = event.target.closest('[data-menu]');
  if (menuButton) {
    event.stopPropagation();
    connectionMenu(menuButton.dataset.menu);
    return;
  }
  const item = event.target.closest('[data-connection]');
  if (!item) return;

  const connId = item.dataset.connection;
  const isCurrent = Boolean(
    app.connection && (
      app.connection.id === connId ||
      (!app.connections.some((c) => c.id === app.connection.id) && app.connections.length === 1)
    )
  );

  if (isCurrent) {
    if (collapsedConnections.has(connId)) {
      collapsedConnections.delete(connId);
    } else {
      collapsedConnections.add(connId);
    }
    renderSidebar();
    return;
  }

  collapsedConnections.delete(connId);
  connectTo(connId);
}

function onTreeClick(event) {
  const renameSaved = event.target.closest('[data-rename-saved-query]');
  if (renameSaved) {
    event.stopPropagation();
    renameSavedQuery(renameSaved.dataset.renameSavedQuery);
    return;
  }
  const deleteSaved = event.target.closest('[data-delete-saved-query]');
  if (deleteSaved) {
    event.stopPropagation();
    deleteSavedQuery(deleteSaved.dataset.deleteSavedQuery);
    return;
  }
  const savedQuery = event.target.closest('[data-saved-query]');
  if (savedQuery) {
    openSavedQuery(savedQuery.dataset.savedQuery);
    return;
  }
  const group = event.target.closest('[data-tree-group]');
  if (group) {
    const id = group.dataset.treeGroup;
    if (id === 'backups') {
      openTreeGroups.add(id);
      app.selectedBackupId = null;
      view('backups');
    } else if (id === 'routines' || id === 'events') {
      const opening = !openTreeGroups.has(id);
      if (opening) openTreeGroups.add(id);
      else openTreeGroups.delete(id);
      renderSidebar();
      if (opening) loadObjectMetadata(id);
      return;
    } else if (openTreeGroups.has(id)) openTreeGroups.delete(id);
    else openTreeGroups.add(id);
    renderSidebar();
    return;
  }
  if (event.target.closest('[data-refresh-routines]')) {
    loadObjectMetadata('routines', { force: true });
    return;
  }
  if (event.target.closest('[data-refresh-events]')) {
    loadObjectMetadata('events', { force: true });
    return;
  }
  const newRoutine = event.target.closest('[data-new-routine]');
  if (newRoutine) {
    newRoutineModal(newRoutine.dataset.newRoutine);
    return;
  }
  if (event.target.closest('[data-new-event]')) {
    newRoutineModal('event');
    return;
  }
  const routine = event.target.closest('[data-routine]');
  if (routine) {
    openRoutineDetails(routine.dataset.routineKind === 'function' ? 'function' : 'procedure', routine.dataset.routine);
    return;
  }
  const eventObject = event.target.closest('[data-event]');
  if (eventObject) {
    openRoutineDetails('event', eventObject.dataset.event);
    return;
  }
  if (event.target.closest('[data-save-query]')) {
    saveQuery();
    return;
  }
  if (event.target.closest('[data-new-query]')) {
    newQuery();
    return;
  }
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
  const savedBackup = event.target.closest('[data-restore-backup]');
  if (savedBackup) {
    app.selectedBackupId = savedBackup.dataset.restoreBackup;
    view('backups');
    renderSidebar();
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
  const chevronToggle = event.target.closest('[data-toggle-db]');
  const databaseItem = event.target.closest('[data-db]');
  if (databaseItem) {
    const dbName = databaseItem.dataset.db;
    if (chevronToggle || dbName === app.database) {
      if (collapsedDbs.has(dbName)) {
        collapsedDbs.delete(dbName);
      } else {
        collapsedDbs.add(dbName);
      }
      renderSidebar();
      return;
    }
    collapsedDbs.delete(dbName);
    selectDatabase(dbName);
    return;
  }
  const tableItem = event.target.closest('[data-table]');
  if (tableItem) selectTable(tableItem.dataset.table);
}

async function refreshDatabases() {
  if (!desktop || !app.connection) return;
  try {
    app.databases = await call(desktop.db.databases(app.connection?.id || null));
    renderSidebar();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function connectProfile(id) {
  const profile = app.connections.find((connection) => connection.id === id);
  try {
    return await call(desktop.db.connect(id));
  } catch (error) {
    if (!profile || !profile.ssh?.enabled
        || !['SSH_HOST_KEY_UNKNOWN', 'SSH_HOST_KEY_CHANGED'].includes(error.code)
        || !error.fingerprint) {
      throw error;
    }
    const changed = error.code === 'SSH_HOST_KEY_CHANGED';
    const fingerprint = String(error.fingerprint);
    const expected = error.expectedFingerprint ? String(error.expectedFingerprint) : '';
    const accepted = await confirmAction(
      changed ? 'SSH host key đã thay đổi' : 'Tin cậy SSH host key lần đầu?',
      changed
        ? `Không kết nối tới ${profile.ssh.host}:${profile.ssh.port} trước khi bạn xác minh.\n\nFingerprint trước: ${expected}\nFingerprint mới: ${fingerprint}\n\nChỉ tin cậy nếu khóa mới khớp với quản trị viên máy chủ.`
        : `Chưa có SSH host key được tin cậy cho ${profile.ssh.host}:${profile.ssh.port}.\n\nFingerprint SHA-256: ${fingerprint}\n\nSo sánh với fingerprint do quản trị viên máy chủ cung cấp trước khi tin cậy.`,
      changed ? 'Tin cậy khóa mới' : 'Tin cậy và kết nối'
    );
    if (!accepted) {
      const rejected = new Error('Bạn đã từ chối SSH host key. Không có thông tin đăng nhập MySQL nào được gửi.');
      rejected.code = 'SSH_HOST_KEY_REJECTED';
      throw rejected;
    }
    return call(desktop.db.connect(id, {
      sshHostKey: {
        host: profile.ssh.host,
        port: profile.ssh.port,
        fingerprint
      }
    }));
  }
}

async function connectTo(id, options = {}) {
  if (connectionSwitching) return;
  const profile = app.connections.find((connection) => connection.id === id);
  if (!profile) return;
  invalidateSqlAutocomplete();
  if (app.connection?.id && app.connection.id !== id && app.database) {
    connectionLocations.set(app.connection.id, { database: app.database, table, mode });
    connectionViews.set(app.connection.id, {
      server: app.server, databases: app.databases, database: app.database,
      tables: app.tables, backups: app.backups, selectedBackupId: app.selectedBackupId,
      columns: app.columns, primaryKey: app.primaryKey, rows: app.rows,
      total: app.total, page: app.page, search: app.search,
      searchColumn: app.searchColumn, searchMode: app.searchMode,
      filterTree: app.filterTree,
      visibleColumns: app.visibleColumns, sorts: app.sorts,
      tablePreferencePending: app.tablePreferencePending,
      pageCursor: app.pageCursor, nextCursor: app.nextCursor, previousCursor: app.previousCursor, hasMore: app.hasMore,
      orderBy: app.orderBy, orderDir: app.orderDir,
      indexes: app.indexes, relations: app.relations, table, mode
    });
  }
  const remembered = connectionLocations.get(id) || {};
  const savedView = openConnectionIds.has(id) ? connectionViews.get(id) : null;
  let connectedData = null;
  collapsedConnections.delete(id);
  if (profile.workspaceId && profile.workspaceId !== app.activeWorkspaceId) {
    app.activeWorkspaceId = profile.workspaceId;
    renderWorkspaceSwitcher();
  }
  if (app.connection && app.connection.id === id && app.database && options.keepSession) {
    renderSidebar();
    return;
  }
  connectionSwitching = true;
  if (savedView) {
    try {
      const data = await connectProfile(id);
      connectedData = data;
      openConnectionIds.clear();
      for (const profileId of data.openProfiles || [id]) openConnectionIds.add(profileId);
      if (data.reused && (!options.database || options.database === savedView.database)) {
        resetObjectMetadata();
        invalidateSqlAutocomplete();
        app.connection = profile;
        app.serverType = profile.type;
        Object.assign(app, savedView);
        app.server = data.server;
        app.databases = data.databases;
        table = savedView.table;
        mode = savedView.mode;
        setConnectionState('connected', 'Đã kết nối');
        void refreshSessionState(id);
        renderSidebar();
        loadOpenObjectGroups();
        updateChrome();
        if (mode === 'data') {
          if (table && app.tablePreferencePending) await loadData();
          else if (table && app.columns.length) renderDataView();
          else renderEmptyTable();
        } else if (mode === 'backups') renderBackupsView();
        else if (mode === 'query') renderQueryView();
        else if (mode === 'history') renderHistoryView();
        else if (mode === 'structure' && app.columns.length) renderStructureView();
        else if (mode === 'indexes' && app.indexes) renderIndexesView();
        else if (mode === 'relations' && app.relations) renderRelationsView();
        else await view(mode);
        setStatus(`Đã chuyển sang ${profile.name} • ${app.server}`);
        persistState();
        return;
      }
    } catch (error) {
      openConnectionIds.delete(id);
      connectionViews.delete(id);
      toast(error.message, 'error');
      return;
    } finally {
      connectionSwitching = false;
    }
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
  resetObjectMetadata();
  table = null;
  setConnectionState('connecting');
  setStatus(`Đang kết nối ${profile.name}…`);
  renderSidebar();
  mode = 'data';
  updateChrome();
  renderConnectionLoading(profile);
  try {
    const data = connectedData || await connectProfile(id);
    openConnectionIds.clear();
    for (const profileId of data.openProfiles || [id]) openConnectionIds.add(profileId);
    app.server = data.server;
    app.databases = data.databases;
    setConnectionState('connected', 'Đã kết nối');
    void refreshSessionState(id);
    const preferredDatabase = options.database || remembered.database;
    const preferred = preferredDatabase && app.databases.includes(preferredDatabase)
      ? preferredDatabase
      : (profile.database && app.databases.includes(profile.database) ? profile.database : null);
    if (preferred) {
      await selectDatabase(preferred, { ...remembered, ...options });
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
    openConnectionIds.delete(id);
    app.connection = null;
    app.sessionState = null;
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
  } finally {
    connectionSwitching = false;
  }
}

async function selectDatabase(database, options = {}) {
  invalidateSqlAutocomplete();
  try {
    await call(desktop.db.useDatabase(database, app.connection?.id || null));
  } catch (error) {
    toast(error.message, 'error');
    return;
  }
  app.database = database;
  app.backups = [];
  app.selectedBackupId = null;
  resetObjectMetadata();
  table = null;
  app.tables = [];
  app.columns = [];
  app.rows = [];
  app.total = null;
  try {
    app.tables = await call(desktop.db.tables(database, app.connection?.id || null));
  } catch (error) {
    toast(error.message, 'error');
    app.tables = [];
  }
  await refreshBackupList(database);
  renderSidebar();
  setConnectionState('connected', 'Đã kết nối');
  void refreshSessionState();
  const candidate = options.table && app.tables.find((entry) => entry.name === options.table)
    ? options.table
    : (app.tables.find((entry) => entry.type === 'table')?.name || app.tables[0]?.name || null);
  if (candidate) {
    await selectTable(candidate, { mode: options.mode, silent: options.silent });
  } else {
    view(options.mode || 'data');
  }
  loadOpenObjectGroups();
  persistState();
}

function backupChecksumNote(entry) {
  const checksum = entry?.verification?.checksum;
  if (checksum === 'verified') return '✓ checksum khớp';
  if (checksum === 'mismatch') return '⚠ checksum không khớp';
  if (entry?.manifestError) return '⚠ manifest không đọc được';
  if (entry?.legacy) return 'chưa có checksum';
  return 'chưa xác minh';
}

function backupObjectSummary(entry) {
  const result = entry?.result;
  if (!result) return '';
  const parts = [];
  if (result.tables) parts.push(`${Number(result.tables).toLocaleString()} bảng`);
  if (result.views) parts.push(`${Number(result.views).toLocaleString()} view`);
  if (result.procedures) parts.push(`${Number(result.procedures).toLocaleString()} procedure`);
  if (result.functions) parts.push(`${Number(result.functions).toLocaleString()} function`);
  if (result.triggers) parts.push(`${Number(result.triggers).toLocaleString()} trigger`);
  if (result.events) parts.push(`${Number(result.events).toLocaleString()} event`);
  if (result.rows) parts.push(`${Number(result.rows).toLocaleString()} dòng`);
  return parts.join(' · ');
}

async function refreshBackupList(database = app.database, connectionId = app.connection?.id) {
  if (!desktop?.db?.listBackups || !database) return;
  try {
    const backups = await call(desktop.db.listBackups(database, connectionId));
    if (app.database === database && app.connection?.id === connectionId) {
      app.backups = backups;
      if (app.selectedBackupId && !backups.some((entry) => entry.id === app.selectedBackupId)) app.selectedBackupId = null;
      renderSidebar();
      if (mode === 'backups') renderBackupsView();
    }
  } catch (error) {
    toast(`Không đọc được danh sách backup: ${error.message}`, 'error');
  }
}

function backupDetailsHtml(entry) {
  if (!entry) return '';
  const selection = entry.selection;
  const names = (label, values) => Array.isArray(values) && values.length
    ? `<h4>${esc(label)} (${values.length})</h4><ul class="backup-object-list">${values.map((name) => `<li>${esc(name)}</li>`).join('')}</ul>` : '';
  return `<section class="backup-details" aria-label="Chi tiết bản sao lưu">
    <h3>${entry.pinned ? '📌 ' : ''}${esc(entry.name)}</h3>
    ${entry.note ? `<p class="backup-user-note">${esc(entry.note)}</p>` : ''}
    ${entry.annotationError ? `<p class="errorbox" role="alert">Không đọc được ghi chú/ghim: ${esc(entry.annotationError)}</p>` : ''}
    <dl class="backup-details-grid">
      <div><dt>Ngày tạo</dt><dd>${esc(new Date(entry.createdAt).toLocaleString('vi-VN'))}</dd></div>
      <div><dt>Dung lượng</dt><dd>${formatBytes(entry.bytes)}</dd></div>
      <div><dt>Database nguồn</dt><dd>${esc(entry.source?.database || 'Không có thông tin')}</dd></div>
      <div><dt>Phiên bản máy chủ nguồn</dt><dd>${esc(entry.source?.serverVersion || 'Không có thông tin')}</dd></div>
      <div><dt>Nội dung sao lưu</dt><dd>${selection ? [selection.includeStructure ? 'Cấu trúc' : '', selection.includeData ? 'Dữ liệu' : '', selection.dropTables ? 'Có lệnh DROP' : ''].filter(Boolean).join(' · ') : 'Không có metadata'}</dd></div>
      <div><dt>Thống kê</dt><dd>${esc(backupObjectSummary(entry) || 'Không có thông tin')}</dd></div>
      <div><dt>Xác minh</dt><dd>${esc(backupChecksumNote(entry))} · ${entry.verification?.restore === 'verified' ? 'Đã phục hồi thử' : 'Chưa xác nhận phục hồi thử'}</dd></div>
      <div><dt>Mã tệp</dt><dd>${esc(entry.id)}</dd></div>
    </dl>
    ${entry.checksum ? `<p class="backup-checksum">SHA-256: ${esc(entry.checksum)}</p>` : ''}
    ${entry.trial?`<p>Lần thử gần nhất: ${esc(entry.trial.finishedAt || '')} · ${esc(entry.trial.status || 'unknown')} · Dọn: ${esc(entry.trial.cleanup || 'unknown')}${entry.trial.checksum!==entry.checksum || entry.verification?.checksum!=='verified'?' · Chưa đối chiếu báo cáo với tệp hiện tại':''}</p>`:''}
    <p class="hint">Danh sách theo metadata lúc tạo backup. Việc phục hồi còn phụ thuộc lựa chọn và kết quả kiểm tra trước khi phục hồi.</p>
    ${names('Bảng / view', selection?.tables)}${names('Procedure / function', selection?.routines)}${names('Event', selection?.events)}
    ${!selection ? '<p class="hint">Backup cũ chưa có danh sách đối tượng. Đọc tệp SQL để xem nội dung.</p>' : ''}
    <button data-backup-action="inspect">⌕ Đọc danh sách từ tệp SQL</button>
    <button data-backup-action="selection-preview">Xem phạm vi chọn bảng…</button>
    <button data-backup-action="create-replica">⧉ Tạo bản sao (Replica)…</button>
    <button data-backup-action="container-info">🔒 Kiểm tra container…</button>
    <button data-backup-action="trial" ${connectionIsReadOnly()?'disabled':''}>↶ Phục hồi thử vào database tạm</button>
    <div id="backupTrialReport" role="status" aria-live="polite"></div>
    <div id="backupInventory" role="status" aria-live="polite"></div>
  </section>`;
}

function renderBackupsView() {
  const selected = app.backups.find((entry) => entry.id === app.selectedBackupId);
  const rows = app.backups.map((entry) => `
    <tr class="backup-row ${entry.id === app.selectedBackupId ? 'selected' : ''}" data-backup-row="${esc(entry.id)}" tabindex="0" aria-selected="${entry.id === app.selectedBackupId}">
      <td>${entry.pinned ? '<span aria-label="Đã ghim">📌</span>' : '◴'} &nbsp; ${esc(entry.name)}</td>
      <td>${esc(new Date(entry.createdAt).toLocaleString('vi-VN'))}</td>
      <td>${formatBytes(entry.bytes)}</td>
      <td title="${esc(entry.checksum || '')}">${esc(backupChecksumNote(entry))}${entry.note ? `<br><span class="backup-note-preview">${esc(entry.note.slice(0, 120))}${entry.note.length > 120 ? '…' : ''}</span>` : ''}${entry.annotationError ? '<br>⚠ Không đọc được ghi chú/ghim' : ''}</td>
    </tr>`).join('');
  $('#workspace').innerHTML = `
    <section class="backup-manager" aria-label="Quản lý bản sao lưu">
      <div class="backup-manager-toolbar">
        <button data-backup-action="create" class="primary">＋ Tạo bản sao lưu</button>
        <button data-backup-action="restore" ${selected ? '' : 'disabled'}>↶ Phục hồi</button>
        <button data-backup-action="verify" ${selected ? '' : 'disabled'}>✓ Xác minh checksum</button>
        <button data-backup-action="rename" ${selected ? '' : 'disabled'}>✎ Đổi tên</button>
        <button data-backup-action="annotations" ${selected ? '' : 'disabled'}>✎ Ghi chú / Ghim</button>
        <button data-backup-action="copy-backup" ${selected ? '' : 'disabled'}>⎘ Sao chép (Ctrl+C)</button>
        <button data-backup-action="paste-backup" ${app.copiedBackup ? '' : 'disabled'}>📋 Dán (Ctrl+V)</button>
        <button data-backup-action="copy-to-db" ${selected ? '' : 'disabled'}>⧉ Sao chép sang DB khác…</button>
        <button data-backup-action="create-replica" ${selected ? '' : 'disabled'}>⧉ Tạo Replica…</button>
        <button data-backup-action="container-info" ${selected ? '' : 'disabled'}>🔒 Kiểm tra container…</button>
        <button data-backup-action="encrypt" ${selected ? '' : 'disabled'}>Mã hóa bản sao…</button>
        <button data-backup-action="encrypted-list">Bản mã hóa / Giải mã…</button>
        <button data-backup-action="delete" class="danger" ${selected && !selected.pinned && !selected.annotationError ? '' : 'disabled'}>⌫ Xóa bản sao lưu</button>
        <button data-backup-action="export" ${selected ? '' : 'disabled'}>⇩ Xuất tệp SQL</button>
        <button data-backup-action="refresh">↻ Làm mới</button>
        <button data-backup-action="schedule">◷ Lịch backup…</button>
        <button data-backup-action="trial-recovery">Database thử còn sót…</button>
        <button data-backup-action="retention-preview">Xem trước dọn backup…</button>
        <button data-backup-action="retention-history">Lịch sử dọn backup…</button>
      </div>
      <div class="backup-manager-table"><table><thead><tr><th>Tên</th><th>Ngày tạo</th><th>Dung lượng</th><th>Ghi chú</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="backup-manager-empty">Chưa có bản sao lưu. Bấm “Tạo bản sao lưu” để bắt đầu.</td></tr>'}</tbody>
      </table></div>
      ${backupDetailsHtml(selected)}
      <div class="backup-manager-footer">${app.backups.length} bản sao lưu · ${esc(app.database || '')}</div>
    </section>`;
}

function backupContextMenuHtml(hasSelection) {
  const item = (action, icon, label, disabled = false) => `<div class="context-menu-item ${disabled ? 'disabled' : ''}" ${disabled ? '' : `data-backup-menu="${action}"`}><span class="c-icon">${icon}</span>${label}</div>`;
  const canPaste = Boolean(app.copiedBackup);
  const selected = app.backups.find(entry => entry.id === app.selectedBackupId);
  return `
    ${item('restore', '↶', 'Phục hồi bản sao lưu', !hasSelection)}
    ${item('verify', '✓', 'Xác minh checksum', !hasSelection)}
    ${item('rename', '✎', 'Đổi tên bản sao lưu…', !hasSelection)}
    ${item('copy-backup', '⎘', 'Sao chép bản sao lưu (Ctrl+C)', !hasSelection)}
    ${item('paste-backup', '📋', 'Dán bản sao lưu vào đây (Ctrl+V)', !canPaste)}
    ${item('copy-to-db', '⧉', 'Sao chép sang Database khác…', !hasSelection)}
    ${item('create-replica', '⧉', 'Tạo bản sao (Replica)…', !hasSelection)}
    ${item('container-info', '🔒', 'Kiểm tra container / Mã hóa…', !hasSelection)}
    ${item('create', '＋', 'Tạo bản sao lưu mới')}
    ${item('delete', '⌫', 'Xóa bản sao lưu', !hasSelection || selected?.pinned || selected?.annotationError)}
    <div class="context-menu-sep"></div>
    ${item('restore-file', '⇧', 'Phục hồi từ tệp SQL…')}
    ${item('export', '⇩', 'Xuất tệp SQL…', !hasSelection)}
    ${item('copy', '⧉', 'Sao chép tên', !hasSelection)}
    <div class="context-menu-sep"></div>
    ${item('folder', '▣', 'Mở thư mục chứa backup')}
    ${item('refresh', '↻', 'Làm mới')}`;
}

function backupSelectionColumnsHtml(row) {
  const review = row.columnReview;
  if (!review) return '';
  const labels = { SOURCE_COLUMNS_INCOMPLETE: 'Chưa đọc đủ định nghĩa cột nguồn', TARGET_COLUMNS_INCOMPLETE: 'Chưa đọc đủ metadata cột đích',
    COLUMN_NOT_SEEN_AT_TARGET: 'Không thấy cột ở đích', COLUMN_TYPE_NOT_ANALYZED: 'Kiểu dữ liệu chưa được phân tích', COLUMN_TYPE_DIFFERS: 'Kiểu/độ dài/precision khác nhau; cần kiểm tra chuyển đổi giá trị', COLUMN_ATTRIBUTES_NOT_ANALYZED: 'Có thuộc tính cột chưa được phân tích',
    COLUMN_NULLABILITY_DIFFERS: 'Khác quy định NULL', COLUMN_AUTO_INCREMENT_DIFFERS: 'Khác auto-increment', COLUMN_GENERATED_DIFFERS: 'Khác trạng thái generated',
    COLUMN_GENERATED_STORAGE_DIFFERS: 'Khác cách lưu generated (stored/virtual)', COLUMN_VISIBILITY_DIFFERS: 'Khác trạng thái invisible',
    COLUMN_DEFAULT_PRESENCE_DIFFERS: 'Khác thông tin có default', GENERATED_EXPRESSION_NOT_COMPARED: 'Chưa đối chiếu biểu thức generated',
    DEFAULT_VALUE_NOT_COMPARED: 'Chưa đối chiếu giá trị/biểu thức default', COLUMN_CHARSET_OR_COLLATION_UNKNOWN: 'Chưa xác định charset/collation',
    COLUMN_CHARSET_DIFFERS: 'Khác charset', COLUMN_COLLATION_DIFFERS: 'Khác collation', POSITIONAL_INSERT_REQUIRES_REVIEW: 'INSERT theo vị trí cần đối chiếu cả thứ tự và giá trị',
    POSITIONAL_COLUMN_ORDER_OR_COUNT_DIFFERS: 'Thứ tự hoặc số cột khác nhau với INSERT theo vị trí', INSERT_COLUMNS_UNKNOWN: 'Chưa xác định đầy đủ cột được INSERT',
    EXTRA_TARGET_COLUMN: 'Đích có cột ngoài định nghĩa nguồn', REQUIRED_TARGET_COLUMN_NOT_SUPPLIED: 'INSERT thiếu cột bắt buộc ở đích',
    INSERT_COLUMN_NOT_IN_SOURCE_DEFINITION: 'INSERT nêu cột không thấy trong định nghĩa nguồn' };
  return `<details class="backup-column-review"><summary>Đối chiếu cột: ${esc(row.name)} · ${Number(review.sourceColumnCount)} nguồn / ${Number(review.targetColumnCount)} đích</summary>
    <p class="hint">Chỉ so metadata đã nhận diện. Chưa xác nhận giá trị INSERT chuyển đổi được, biểu thức/default giống nhau hoặc phục hồi an toàn.</p>
    <ul>${review.findings.map(item => `<li>${esc(labels[item.code] || item.code)}${item.column ? ` · ${esc(item.column)}` : ''}</li>`).join('') || '<li>Chưa thấy khác biệt trong thuộc tính đã so; chưa phải xác nhận tương thích đầy đủ.</li>'}</ul>
    ${review.truncated ? '<p>Còn cột/cảnh báo ngoài giới hạn phân tích hoặc hiển thị. Hãy giảm phạm vi chọn để đối chiếu.</p>' : ''}
    <div class="backup-selection-table"><table><thead><tr><th>Cột</th><th>Kiểu nguồn</th><th>Kiểu đích</th><th>Quan sát</th></tr></thead><tbody>${review.fields.map(field => `<tr><td>${esc(field.name)}</td><td>${esc(field.sourceType)}</td><td>${esc(field.targetType || 'Chưa thấy')}</td><td>${field.differences.map(code => esc(labels[code] || code)).join('; ') || (field.targetType ? 'Chưa thấy khác biệt trong thuộc tính đã so' : 'Chưa đủ metadata để so')}</td></tr>`).join('')}</tbody></table></div></details>`;
}

const BACKUP_SELECTION_INDEX_VISIBILITY_LABELS = Object.freeze({
  visible: 'Visible (optimizer)', invisible: 'Invisible (optimizer)', 'not-ignored': 'NOT IGNORED (optimizer)', ignored: 'IGNORED (optimizer)', unknown: 'Chưa xác định'
});

const BACKUP_SELECTION_TARGET_INDEX_LABELS = Object.freeze({
  TARGET_INDEX_METADATA_INCOMPLETE: 'Chưa đọc đủ metadata chỉ mục đích', TARGET_INDEX_TABLE_NOT_OBSERVED: 'Chưa xác định đúng một bảng đích thấy được',
  TARGET_INDEX_METADATA_INVALID: 'Metadata chỉ mục không nhất quán', TARGET_INDEX_DEFINITION_UNSUPPORTED: 'Có chỉ mục, thứ tự hoặc dạng cột chưa hỗ trợ đối chiếu',
  TARGET_INDEX_REVIEW_LIMIT: 'Chỉ mục vượt giới hạn phân tích/hiển thị', TARGET_INDEX_VISIBILITY_NOT_REVIEWED: 'Chưa xác định trạng thái invisible/ignored của chỉ mục'
});

function backupSelectionTargetIndexesHtml(row) {
  const review = row.indexReview;
  if (!review) return '';
  const kinds = { primary: 'PRIMARY KEY', unique: 'UNIQUE KEY', index: 'INDEX' };
  return `<details class="backup-target-indexes"><summary>Chỉ mục đích: ${esc(row.name)} · ${review.indexes.length}/${Number(review.definitionCount)} định nghĩa thấy được</summary>
    <p>Chỉ quan sát metadata trong quyền tài khoản, chưa chứng minh tương thích phục hồi. Trạng thái invisible/ignored chỉ mô tả optimizer; chưa xác nhận FK, dữ liệu hoặc quy tắc server. Không thấy chỉ mục không chứng minh chỉ mục không tồn tại.</p>
    <ul>${review.findings.map(code => `<li>${esc(BACKUP_SELECTION_TARGET_INDEX_LABELS[code] || code)}</li>`).join('')}</ul>
    <div class="backup-selection-table"><table><thead><tr><th>Tên / loại khóa</th><th>Cột theo thứ tự</th><th>Loại chỉ mục</th><th>Trạng thái optimizer</th><th>Quan sát</th></tr></thead><tbody>${review.indexes.map(index => `<tr><td>${esc(index.name)} · ${esc(kinds[index.kind] || index.kind)}</td><td>${index.columns.map(part => `${esc(part.name || 'Cột/biểu thức chưa nhận diện')}${part.prefixLength !== null ? ` (${Number(part.prefixLength)})` : ''} ${esc(part.direction === 'A' ? 'ASC' : part.direction === 'D' ? 'DESC' : 'Chưa rõ chiều')}`).join('<br>')}</td><td>${esc(index.type || 'Chưa rõ')}</td><td>${esc(BACKUP_SELECTION_INDEX_VISIBILITY_LABELS[index.visibility] || BACKUP_SELECTION_INDEX_VISIBILITY_LABELS.unknown)}</td><td>${index.supported ? 'Đã nhận diện định nghĩa cơ bản; chưa xác nhận quy tắc server' : 'Chưa đủ bằng chứng đối chiếu'}</td></tr>`).join('') || '<tr><td colspan="5">Chưa thấy trong metadata đọc được.</td></tr>'}</tbody></table></div>
    ${review.truncated ? '<p>Còn chỉ mục/cột ngoài giới hạn; cần giảm phạm vi chọn và kiểm tra lại.</p>' : ''}</details>`;
}

const BACKUP_SELECTION_POLICY_LABELS = Object.freeze({
  POLICY_METADATA_INCOMPLETE: 'Metadata đích thiếu/không đầy đủ; chưa áp dụng được chính sách',
  POLICY_SOURCE_NAME_AMBIGUOUS: 'Tên nguồn bị trùng theo chính sách hoa/thường của đích', POLICY_TARGET_NAME_AMBIGUOUS: 'Tên đích chưa xác định duy nhất',
  POLICY_VIEW_CONFLICT: 'Trùng view; chính sách không thay hoặc tự bỏ qua view', POLICY_TABLE_EXISTS: 'Bảng đã có; chính sách chặn tạo trùng cấu trúc',
  POLICY_SKIP_EXISTING_TABLE: 'Bỏ qua toàn bộ bảng đã thấy theo chính sách', POLICY_DATA_TABLE_NOT_SEEN: 'Chỉ chọn dữ liệu nhưng chưa thấy bảng đích',
  POLICY_APPEND_REQUIRES_REVIEW: 'Dự kiến thêm dữ liệu vào bảng đã có; cần kiểm tra thêm', POLICY_CREATE_REQUIRES_REVIEW: 'Dự kiến tạo bảng chưa thấy; phải xác minh lại',
  POLICY_ABSENCE_NOT_PROVEN: 'Metadata không thấy đối tượng chưa chứng minh đối tượng không tồn tại',
  POLICY_TARGET_RECHECK_REQUIRED: 'Phải kiểm tra lại đích sát lúc ghi', POLICY_APPEND_VALUES_NOT_VALIDATED: 'Chưa kiểm tra khóa trùng, giá trị, constraints và trigger khi thêm dữ liệu',
  POLICY_DEPENDENCIES_UNKNOWN: 'Chưa đủ dependency để bỏ qua bảng liên quan', POLICY_DEPENDENCY_SKIPPED: 'Phụ thuộc bảng được bỏ qua; cần đối chiếu cấu trúc/dữ liệu của bảng đó'
});

function backupSelectionConflictPolicyHtml(review) {
  if (!review) return '';
  const policies = { 'stop-on-conflict': 'Chặn khi trùng cấu trúc', 'skip-existing': 'Bỏ qua bảng đã thấy ở đích' };
  const observations = { table: 'Bảng', view: 'View', 'not-seen': 'Chưa thấy trong metadata', unknown: 'Chưa xác định' };
  const proposals = { 'create-table': 'Xem xét tạo bảng', 'append-data': 'Xem xét thêm dữ liệu', 'skip-table': 'Bỏ qua cả cấu trúc/dữ liệu' };
  return `<details class="backup-selection-policy"><summary>Chính sách xung đột · ${esc(policies[review.policy] || review.policy)} · Chỉ xem trước</summary>
    <p>${Number(review.totals.review)} cần review · ${Number(review.totals.skip)} bảng dự kiến bỏ qua · ${Number(review.totals.blocked)} bảng bị chặn. Chưa cấp quyền chạy; chính sách không cho phép DROP hoặc ghi đè. Bảng chưa thấy có thể do thiếu quyền; chỉ chọn dữ liệu vẫn cần kiểm tra khóa trùng và tác động ghi.</p>
    <div class="backup-selection-table"><table><thead><tr><th>Bảng chọn</th><th>Thấy ở đích</th><th>Dự kiến</th><th>Điều kiện còn thiếu</th></tr></thead><tbody>${review.rows.slice(0, 100).map(row => `<tr><td>${esc(row.name)}</td><td>${esc(observations[row.observed] || row.observed)}</td><td>${esc(proposals[row.proposal] || 'Chưa xử lý')}</td><td>${esc(BACKUP_SELECTION_POLICY_LABELS[row.reason] || row.reason)}${row.disposition === 'review' ? row.requires.map(code => ` · ${esc(BACKUP_SELECTION_POLICY_LABELS[code] || code)}`).join('') : ''}</td></tr>`).join('')}</tbody></table></div>
    ${review.rows.length > 100 ? '<p>Chỉ hiện 100 bảng đầu; tổng thống kê tính toàn bộ lựa chọn.</p>' : ''}</details>`;
}

const BACKUP_SELECTION_FK_LABELS = Object.freeze({
  FK_CREATE_NOT_REVIEWED: 'Chưa có đúng một CREATE với bằng chứng FK đầy đủ', FK_REVIEW_LIMIT: 'Bằng chứng hoặc báo cáo FK vượt giới hạn',
  FK_OWNER_POLICY_BLOCKED: 'Bảng chứa FK đang bị chính sách đích chặn', FK_OWNER_SKIPPED: 'Bảng chứa FK được bỏ qua theo chính sách',
  FK_CASE_POLICY_UNKNOWN: 'Chưa xác định chính sách hoa/thường của đích', FK_SCHEMA_MAPPING_REQUIRED: 'Schema ghi rõ trong FK/CREATE cần ánh xạ và kiểm chứng',
  FK_PARENT_NOT_SELECTED: 'Bảng được tham chiếu chưa nằm trong lựa chọn', FK_PARENT_NAME_AMBIGUOUS: 'Tên bảng được tham chiếu chưa xác định duy nhất',
  FK_PARENT_SKIPPED: 'Bảng được tham chiếu bị bỏ qua; chưa xác nhận cấu trúc và dữ liệu ở đích', FK_PARENT_POLICY_BLOCKED: 'Bảng được tham chiếu đang bị chính sách đích chặn',
  FK_PARENT_CREATE_NOT_REVIEWED: 'Chưa có đúng một CREATE được nhận diện cho bảng được tham chiếu', FK_COLUMN_METADATA_UNKNOWN: 'Chưa đủ metadata cột để đối chiếu FK',
  FK_COLUMN_NOT_FOUND: 'Không thấy một cột FK trong định nghĩa nguồn', FK_COLUMN_TYPE_REQUIRES_REVIEW: 'Kiểu cột FK khác nhau; cần kiểm tra khả năng tương thích',
  FK_COLLATION_REQUIRES_REVIEW: 'Charset/collation của cột FK khác nhau', FK_SET_NULL_REQUIRES_NULLABLE: 'FK dùng SET NULL nhưng cột nguồn không cho NULL',
  FK_DEFINITION_REQUIRES_REVIEW: 'Đã đối chiếu thuộc tính nguồn cơ bản; vẫn cần kiểm tra thêm', FK_REFERENCED_INDEX_NOT_REVIEWED: 'Chưa xác nhận chỉ mục/unique key được tham chiếu',
  FK_REFERENCED_UNIQUE_KEY_NOT_FOUND: 'Chưa tìm thấy PRIMARY/UNIQUE KEY nguồn khớp đủ cột, đúng thứ tự và không dùng prefix',
  FK_REFERENCED_UNIQUE_KEY_MATCHED: 'Khớp PRIMARY/UNIQUE KEY trong bản backup',
  FK_TARGET_INDEX_NOT_REVIEWED: 'Chưa đủ metadata chỉ mục đích để đối chiếu',
  FK_TARGET_UNIQUE_KEY_NOT_OBSERVED: 'Chưa thấy full PRIMARY/UNIQUE KEY đích khớp cột, đúng thứ tự và không prefix',
  FK_TARGET_UNIQUE_KEY_OBSERVED: 'Thấy PRIMARY/UNIQUE KEY đích khớp metadata cột và đã đọc cờ optimizer; chưa xác nhận dữ liệu hoặc quy tắc server',
  FK_TARGET_KEY_INVISIBLE_OR_IGNORED: 'Khóa đích khớp cột nhưng đang Invisible/IGNORED; cần review theo server, chưa xác nhận FK',
  FK_DATA_NOT_CHECKED: 'Chưa kiểm tra dòng mồ côi hoặc tác động ghi/xóa theo FK', FK_SERVER_RULES_NOT_VALIDATED: 'Chưa xác nhận quy tắc FK theo phiên bản server'
});

function backupSelectionForeignKeysHtml(review) {
  if (!review || !review.rows.length && !review.tablesNotReviewed && !review.truncated) return '';
  const statuses = { review: 'Cần kiểm tra thêm', blocked: 'Bị chặn', excluded: 'Ngoài phạm vi theo chính sách' };
  return `<details class="backup-selection-source-fk"><summary>Khóa ngoại nguồn · ${review.rows.length} định nghĩa · Chỉ xem trước</summary>
    <p>${Number(review.totals.review)} cần review · ${Number(review.totals.blocked)} bị chặn · ${Number(review.totals.excluded)} ngoài phạm vi · ${Number(review.tablesNotReviewed)} bảng chưa đủ bằng chứng CREATE. Chỉ đối chiếu FK trong CREATE đã nhận diện, chưa phải kế hoạch thực thi. Chỉ đối chiếu PRIMARY/UNIQUE KEY trong nguồn; chưa xác nhận chỉ mục ở đích, dữ liệu hoặc quy tắc server. Vòng FK và thứ tự phục hồi vẫn cần xử lý riêng.</p>
    <ul>${review.findings.map(item => `<li>${esc(BACKUP_SELECTION_FK_LABELS[item.code] || item.code)}${item.table ? ` · ${esc(item.table)}` : ''}</li>`).join('')}</ul>
    <div class="backup-selection-table"><table><thead><tr><th>Bảng / FK</th><th>Tham chiếu</th><th>Hành vi</th><th>Quan sát</th></tr></thead><tbody>${review.rows.slice(0, 100).map(row => `<tr><td>${esc(row.table)} · ${esc(row.name || 'Không ghi tên')}</td><td>${esc(`${row.referencedSchema ? `${row.referencedSchema}.` : ''}${row.referencedTable}`)}<br>${row.pairs.map(pair => `${esc(pair.column)} → ${esc(pair.referencedColumn)}`).join('<br>')}</td><td>DELETE: ${esc(row.onDelete || 'Không ghi rõ')}<br>UPDATE: ${esc(row.onUpdate || 'Không ghi rõ')}</td><td>${esc(statuses[row.status] || row.status)} · ${esc(BACKUP_SELECTION_FK_LABELS[row.reason] || row.reason)}${row.referencedIndexReview?.status === 'matched' ? `<br>Khóa nguồn: ${esc(row.referencedIndexReview.kind === 'primary' ? 'PRIMARY KEY' : `UNIQUE KEY ${row.referencedIndexReview.name}`)} (${row.referencedIndexReview.columns.map(esc).join(', ')})` : ''}${row.targetReferencedIndexReview ? `<br>Khóa đích: ${esc(BACKUP_SELECTION_FK_LABELS[row.targetReferencedIndexReview.code] || row.targetReferencedIndexReview.code)}${['observed-match', 'requires-review'].includes(row.targetReferencedIndexReview.status) ? ` · ${esc(row.targetReferencedIndexReview.name)} (${row.targetReferencedIndexReview.columns.map(esc).join(', ')})${row.targetReferencedIndexReview.visibility ? ` · ${esc(BACKUP_SELECTION_INDEX_VISIBILITY_LABELS[row.targetReferencedIndexReview.visibility] || BACKUP_SELECTION_INDEX_VISIBILITY_LABELS.unknown)}` : ''}` : ''}` : ''}${row.requires.map(code => ` · ${esc(BACKUP_SELECTION_FK_LABELS[code] || code)}`).join('')}</td></tr>`).join('')}</tbody></table></div>
    ${review.rows.length > 100 || review.truncated ? '<p>Báo cáo có giới hạn: chỉ hiện 100 định nghĩa đầu; quota hoặc bằng chứng bị cắt không đủ căn cứ phục hồi.</p>' : ''}</details>`;
}

const BACKUP_SELECTION_FK_COMPARISON_LABELS = Object.freeze({
  FK_COMPARE_TARGET_INCOMPLETE: 'Chưa đủ metadata FK đích', FK_COMPARE_SOURCE_INCOMPLETE: 'Chưa có đúng một CREATE nguồn đã nhận diện',
  FK_COMPARE_SCHEMA_OR_CASE_UNKNOWN: 'Schema hoặc chính sách hoa/thường cần kiểm tra', FK_COMPARE_OWNER_UNKNOWN: 'Bảng đích chưa xác định duy nhất',
  FK_COMPARE_OWNER_NOT_OBSERVED: 'Chưa thấy bảng đích để so constraints', FK_COMPARE_NOT_OBSERVED: 'Chưa thấy FK đích tương ứng; không chứng minh không tồn tại',
  FK_COMPARE_AMBIGUOUS: 'Nhiều FK đích có thể tương ứng', FK_COMPARE_SOURCE_ACTION_UNSPECIFIED: 'Nguồn không ghi rõ đủ action; chưa tự suy giá trị mặc định',
  FK_COMPARE_METADATA_MATCHED: 'Khớp metadata đã so; chưa xác nhận dữ liệu hoặc khả năng phục hồi', FK_COMPARE_DEFINITION_DIFFERS: 'Metadata nguồn và đích khác nhau',
  FK_COMPARE_LOCAL_COLUMNS_DIFFER: 'Khác cột local hoặc thứ tự', FK_COMPARE_REFERENCE_DIFFERS: 'Khác bảng/schema tham chiếu',
  FK_COMPARE_REMOTE_COLUMNS_DIFFER: 'Khác cột được tham chiếu hoặc thứ tự', FK_COMPARE_DELETE_DIFFERS: 'Khác ON DELETE', FK_COMPARE_UPDATE_DIFFERS: 'Khác ON UPDATE',
  FK_COMPARE_TARGET_ONLY: 'Có FK đích chưa ghép với định nghĩa nguồn đã nhận diện', FK_COMPARE_LIMIT: 'Báo cáo đối chiếu vượt giới hạn'
});

function backupSelectionForeignKeyComparisonHtml(review) {
  if (review?.version !== 1) return '';
  const definition = value => value ? `${esc(value.table)} · ${esc(value.name || 'Không ghi tên')}<br>→ ${esc(`${value.referencedSchema}.${value.referencedTable}`)}<br>${value.pairs.map(pair => `${esc(pair.column)} → ${esc(pair.referencedColumn)}`).join('<br>')}<br>DELETE: ${esc(value.onDelete || 'Không ghi rõ')} · UPDATE: ${esc(value.onUpdate || 'Không ghi rõ')}` : 'Chưa có đối chiếu';
  return `<details class="backup-fk-comparison"><summary>Đối chiếu FK nguồn / đích · Chỉ xem trước</summary>
    <p>${Number(review.totals.matched)} khớp metadata · ${Number(review.totals.differs)} khác · ${Number(review.totals.unknown)} chưa xác định · ${Number(review.totals.notObserved)} chưa thấy FK đích · ${Number(review.totals.targetOnly)} FK chỉ thấy ở đích · ${Number(review.totals.notApplicable)} chưa thấy bảng đích. Tên khác vẫn có thể khớp cặp cột; không suy action mặc định khi nguồn không ghi rõ. Chưa kiểm tra dữ liệu, index, cascade hoặc quy tắc server. Kết quả không gỡ các chặn của chính sách xung đột và chưa cho phép thực thi.</p>
    <ul>${review.findings.map(item => `<li>${esc(BACKUP_SELECTION_FK_COMPARISON_LABELS[item.code] || item.code)}</li>`).join('')}</ul>
    <div class="backup-selection-table"><table><thead><tr><th>Nguồn</th><th>Đích</th><th>Quan sát</th></tr></thead><tbody>${review.rows.slice(0, 100).map(row => `<tr><td>${definition(row.source)}</td><td>${definition(row.target)}</td><td>${esc(BACKUP_SELECTION_FK_COMPARISON_LABELS[row.reason] || row.reason)}${row.nameDiffers ? '<br>Tên FK khác nhau' : ''}${row.differences.map(code => `<br>${esc(BACKUP_SELECTION_FK_COMPARISON_LABELS[code] || code)}`).join('')}</td></tr>`).join('') || '<tr><td colspan="3">Chưa có cặp định nghĩa để đối chiếu.</td></tr>'}</tbody></table></div>
    ${review.truncated || review.rows.length > 100 ? '<p>Chỉ hiện tối đa 100 mục; còn định nghĩa/cặp cột ngoài giới hạn. Hãy giảm phạm vi và kiểm tra lại.</p>' : ''}</details>`;
}

const BACKUP_SELECTION_VALUE_LABELS = Object.freeze({
  VALUE_YEAR_OUT_OF_RANGE: 'Có năm ngoài phạm vi YEAR 1901–2155 hoặc số 0', VALUE_YEAR_CONVERSION_NOT_REVIEWED: 'YEAR có giá trị rút gọn, chuỗi zero hoặc chuyển đổi chưa kiểm chứng',
  VALUE_YEAR_EVIDENCE_NOT_REVIEWED: 'Thiếu thống kê YEAR, cần quét lại nguồn', VALUE_YEAR_TYPE_NOT_REVIEWED: 'Dạng YEAR hoặc độ rộng hiển thị chưa được kiểm chứng',
  VALUE_TEMPORAL_ZERO_REQUIRES_POLICY: 'Có thành phần ngày bằng 0 cần chính sách riêng', VALUE_TEMPORAL_INVALID_CALENDAR: 'Có ngày không hợp lệ theo lịch Gregorian',
  VALUE_TEMPORAL_INVALID_TIME: 'Có giờ, phút hoặc giây ngoài phạm vi kiểu ngày giờ', VALUE_TEMPORAL_PRECISION_LOSS: 'Có phần lẻ giây không thể lưu nguyên vẹn',
  VALUE_TEMPORAL_YEAR_NOT_REVIEWED: 'Năm ngoài phạm vi ngày đã kiểm chứng', VALUE_TEMPORAL_UPPER_BOUNDARY_NOT_REVIEWED: 'Phần lẻ giây tại biên TIME/DATETIME cần kiểm chứng riêng',
  VALUE_TEMPORAL_TYPE_NOT_REVIEWED: 'Kiểu hoặc độ chính xác ngày giờ chưa hỗ trợ', VALUE_TEMPORAL_EVIDENCE_NOT_REVIEWED: 'Thiếu thống kê ngày giờ, cần quét lại nguồn',
  VALUE_TIMESTAMP_ZONE_RANGE_NOT_REVIEWED: 'TIMESTAMP cần kiểm chứng múi giờ nguồn/đích, DST và phạm vi lưu của server',
  VALUE_TEXT_TOO_LONG: 'Có chuỗi vượt độ dài ký tự hoặc số byte cho phép', VALUE_TEXT_CHARSET_LOSS: 'Có ký tự không biểu diễn được trong charset cột',
  VALUE_TEXT_EVIDENCE_NOT_REVIEWED: 'Thiếu thống kê chuỗi, cần quét lại nguồn', VALUE_TEXT_TYPE_NOT_REVIEWED: 'Kiểu hoặc độ dài chuỗi ngoài phạm vi đã kiểm chứng',
  VALUE_TEXT_CHARSET_NOT_REVIEWED: 'Charset cột chưa đủ căn cứ để kiểm chứng chuỗi', VALUE_TEXT_ENCODING_NOT_REVIEWED: 'Có chuỗi Unicode chưa hợp lệ',
  VALUE_CHAR_PADDING_NOT_REVIEWED: 'Chưa kiểm chứng padding và cách đọc lại CHAR theo SQL mode', VALUE_CHAR_TRAILING_SPACES: 'Có khoảng trắng cuối chuỗi có nguy cơ bị CHAR loại bỏ',
  VALUE_DECIMAL_OUT_OF_RANGE: 'Có số vượt phần nguyên của DECIMAL', VALUE_DECIMAL_UNSIGNED_NEGATIVE: 'Có số âm ở cột DECIMAL UNSIGNED',
  VALUE_DECIMAL_SCALE_LOSS: 'Có phần thập phân không thể lưu nguyên vẹn, cần xử lý trước khi phục hồi',
  VALUE_DECIMAL_TYPE_NOT_REVIEWED: 'Precision/scale DECIMAL ngoài phạm vi đã kiểm chứng',
  VALUE_DECIMAL_EVIDENCE_NOT_REVIEWED: 'Thiếu thống kê DECIMAL, cần quét lại nguồn',
  VALUE_NUMERIC_LITERAL_PRECISION_NOT_REVIEWED: 'Literal số vượt 65 chữ số, cần kiểm chứng theo server',
  VALUE_NULL_NOT_ALLOWED: 'Có NULL ở cột không cho phép NULL', VALUE_INTEGER_OUT_OF_RANGE: 'Có số nguyên vượt phạm vi kiểu cột',
  VALUE_CONVERSION_NOT_REVIEWED: 'Chưa kiểm chứng chuyển đổi kiểu của literal', VALUE_NULL_SPECIAL_SEMANTICS: 'NULL cần xem xét cơ chế tự sinh giá trị',
  VALUE_AUTO_INCREMENT_NOT_REVIEWED: 'Chưa kiểm chứng tác động AUTO_INCREMENT', VALUE_COLUMN_SEMANTICS_NOT_REVIEWED: 'Kiểu hoặc thuộc tính cột chưa đủ căn cứ',
  VALUE_COLUMN_MAPPING_UNKNOWN: 'Chưa ánh xạ được vị trí vào cột', VALUE_SOURCE_COLUMNS_NOT_REVIEWED: 'Chưa có đầy đủ định nghĩa cột nguồn được nhận diện',
  VALUE_TARGET_COLUMNS_NOT_REVIEWED: 'Chưa đọc đủ cột của bảng đích đã thấy', VALUE_SCHEMA_REQUIRES_MAPPING: 'Cần đối chiếu schema ghi rõ trong INSERT',
  VALUE_EVIDENCE_NOT_REVIEWED: 'Thiếu thống kê giá trị, cần quét lại hoặc vượt giới hạn', VALUE_LEDGER_INCOMPLETE: 'Danh sách câu lệnh chưa đầy đủ',
  VALUE_SESSION_NOT_REVIEWED: 'Chính sách SQL mode/session chưa đủ căn cứ', VALUE_BASIC_ISSUES: 'Phát hiện vấn đề NULL, kiểu số, chuỗi hoặc ngày giờ',
  VALUE_REVIEW_INCOMPLETE: 'Một phần giá trị chưa được kiểm chứng', VALUE_EVIDENCE_LIMIT: 'Vượt giới hạn 10.000 vị trí giá trị được kiểm tra',
  VALUE_REPORT_LIMIT: 'Báo cáo giá trị bị giới hạn', VALUE_FULL_VALIDATION_REQUIRED: 'Vẫn cần kiểm chứng đầy đủ kiểu và giá trị',
  VALUE_CONSTRAINTS_NOT_REVIEWED: 'Chưa kiểm chứng khóa trùng, FK, CHECK và trigger theo dữ liệu', VALUE_TARGET_RECHECK_REQUIRED: 'Phải đọc lại cột và trạng thái đích trước khi ghi'
});

function backupSelectionValuesHtml(review) {
  if (![1, 2, 3, 4, 5, 6, 7, 8].includes(review?.version)) return '';
  const status = { 'basic-checked': 'Qua kiểm tra cơ bản', issues: 'Có vấn đề', unknown: 'Chưa đủ căn cứ' };
  const codes = values => values.map(code => esc(BACKUP_SELECTION_VALUE_LABELS[code] || code)).join('; ');
  const side = value => `${esc(status[value.status] || value.status)}${value.findings.length ? `<br>${codes(value.findings)}` : ''}`;
  let visibleFields = 0;
  const items = review.rows.slice(0, 20).map(row => {
    const fields = row.fields.slice(0, Math.max(0, 100 - visibleFields)); visibleFields += fields.length;
    return `<p><strong>#${Number(row.number)} · ${esc(row.table)} · ${esc(status[row.status] || row.status)}</strong>${row.reasons.length ? `<br>${codes(row.reasons)}` : ''}</p>
      ${fields.length ? `<div class="backup-selection-table"><table><thead><tr><th>Vị trí / cột</th><th>Định nghĩa nguồn</th><th>Cột đích đã thấy</th></tr></thead><tbody>${fields.map(field => `<tr><td>${Number(field.position)} · ${esc(field.column || '?')}<br>NULL: ${Number(field.counts.nulls)} · Số nguyên: ${Number(field.counts.integers)} · Khác: ${Number(field.counts.other)}${field.counts.fixedDecimals > 0 ? `<br>Trong literal khác: ${Number(field.counts.fixedDecimals)} DECIMAL cố định` : ''}${field.counts.numericStrings > 0 ? `<br>Chuỗi số đúng mẫu: ${Number(field.counts.numericStrings)}` : ''}${field.counts.text > 0 ? `<br>Literal chuỗi: ${Number(field.counts.text)}` : ''}${field.counts.temporalStrings > 0 ? `<br>Chuỗi ngày giờ đúng mẫu: ${Number(field.counts.temporalStrings)}` : ''}${field.counts.yearLiterals > 0 ? `<br>Literal YEAR được phân loại: ${Number(field.counts.yearLiterals)}` : ''}</td><td>${esc(field.sourceColumn || '?')}<br>${side(field.source)}</td><td>${esc(field.targetColumn || '?')}<br>${side(field.target)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
  }).join('');
  return `<details class="backup-selection-values"><summary>Kiểm tra giá trị cơ bản · Chỉ đọc</summary>
    <p>Kiểm tra NULL, số nguyên, DECIMAL cố định và độ dài chuỗi theo cột nguồn/đích. Chuỗi số ASCII đúng mẫu, tối đa 256 ký tự, được đối chiếu theo kiểu số. VARCHAR đếm ký tự Unicode; TEXT đếm byte, kiểm tra charset utf8mb4/utf8mb3/ASCII. CHAR cần xem xét padding và khoảng trắng cuối. DATE nhận YYYY-MM-DD; DATETIME nhận YYYY-MM-DD hh:mm:ss và tối đa 6 chữ số phần lẻ giây. TIME nhận thời lượng [-]hh:mm:ss hoặc [-]hhh:mm:ss và phần lẻ giây, hỗ trợ giờ trên 23 và dấu âm. Kiểm tra lịch, ngày bằng 0, phạm vi giờ theo kiểu và nguy cơ mất phần lẻ giây. Không tự làm tròn, cắt chuỗi hoặc bỏ khoảng trắng. YEAR kiểm tra số/chuỗi năm 4 chữ số 1901–2155 và số 0; chuỗi zero hoặc năm rút gọn cần kiểm chứng riêng. TIMESTAMP kiểm tra lịch và phần lẻ giây theo cùng mẫu DATETIME, nhưng vẫn cần kiểm chứng múi giờ nguồn/đích, DST và phạm vi lưu của server. Chưa kiểm chứng escape, định dạng ngày giờ khác, chuyển đổi kiểu khác hoặc ràng buộc dữ liệu. Qua kiểm tra cơ bản chưa đủ điều kiện phục hồi; không hiển thị giá trị gốc.</p>
    <p>${Number(review.totals.statements)} INSERT · ${Number(review.totals.basicChecked)} qua cơ bản · ${Number(review.totals.issues)} có vấn đề · ${Number(review.totals.unknown)} chưa đủ căn cứ · ${Number(review.totals.excluded)} loại khỏi lựa chọn.</p>
    <ul>${[...review.findings, ...review.requires].map(code => `<li>${codes([code])}</li>`).join('')}</ul>
    ${items || '<p>Không có INSERT đang được xem xét.</p>'}
    ${review.truncated || review.rows.length > 20 || review.rows.reduce((sum, row) => sum + row.fields.length, 0) > visibleFields ? '<p>Đang hiển thị tối đa 20 câu / 100 vị trí; báo cáo có giới hạn.</p>' : ''}</details>`;
}

const BACKUP_SELECTION_PACKET_LABELS = Object.freeze({
  PACKET_LIMIT_NOT_OBSERVED: 'Chưa đọc được max_allowed_packet của phiên đích', PACKET_ENCODING_NOT_REVIEWED: 'Chưa xác nhận charset client utf8mb4 để đối chiếu byte',
  PACKET_SIZE_NOT_REVIEWED: 'Thiếu thống kê kích thước hoặc vượt quota 16 MiB/câu', PACKET_LEDGER_INCOMPLETE: 'Danh sách câu lệnh chưa đầy đủ',
  PACKET_SCHEMA_MAPPING_REQUIRED: 'Schema ghi rõ cần đối chiếu trước khi đánh giá câu lệnh đích',
  PACKET_STATEMENT_TOO_LARGE: 'Câu SQL nguồn vượt max_allowed_packet đã đọc ở đích', PACKET_BOUNDARY_REQUIRES_REVIEW: 'Kích thước sát ngưỡng; cần kiểm chứng overhead giao thức',
  PACKET_WITHIN_OBSERVED_LIMIT: 'Chưa vượt ngưỡng quan sát; chưa bảo đảm gửi hoặc phục hồi được', PACKET_REPORT_LIMIT: 'Báo cáo kích thước SQL vượt giới hạn',
  PACKET_CLIENT_PROTOCOL_NOT_VALIDATED: 'Chưa kiểm chứng giới hạn client/giao thức', PACKET_REWRITE_NOT_VALIDATED: 'Phải tính lại kích thước nếu sửa SQL hoặc chia batch',
  PACKET_STORAGE_ROW_LIMITS_NOT_REVIEWED: 'Chưa kiểm chứng giới hạn hàng lưu trữ, bộ nhớ hoặc dung lượng', PACKET_TARGET_RECHECK_REQUIRED: 'Phải đọc lại giới hạn trên đúng phiên trước khi ghi'
});

function backupSelectionPacketsHtml(review) {
  if (review?.version !== 1) return '';
  const codes = values => values.map(code => esc(BACKUP_SELECTION_PACKET_LABELS[code] || code)).join('; ');
  return `<details class="backup-selection-packets"><summary>Kích thước SQL và giới hạn packet · Chỉ đọc</summary>
    <p>max_allowed_packet của phiên đích: ${review.settings ? `${Number(review.settings.maxAllowedPacket).toLocaleString()} byte` : 'Chưa xác định'}.</p>
    <p>${Number(review.totals.statements)} câu thuộc phạm vi · ${Number(review.totals.withinObserved)} chưa vượt ngưỡng quan sát · ${Number(review.totals.oversized)} vượt giới hạn · ${Number(review.totals.unknown)} chưa đủ căn cứ · ${Number(review.totals.excluded)} loại khỏi lựa chọn.</p>
    <p>Đếm byte UTF-8 của câu SQL nguồn đã đọc, không phải dung lượng backup hoặc số dòng. Câu vượt giới hạn bị chặn; sát ngưỡng giữ trạng thái cần kiểm chứng giao thức. Chưa vượt ngưỡng không bảo đảm client/server nhận được hoặc phục hồi thành công. Không tự chia INSERT, sửa SQL hoặc đổi cấu hình server.</p>
    <ul>${[...review.findings, ...review.requires].map(code => `<li>${codes([code])}</li>`).join('')}</ul>
    <div class="backup-selection-table"><table><thead><tr><th># nguồn / Lệnh / Bảng</th><th>Byte UTF-8</th><th>Quan sát</th></tr></thead><tbody>${review.rows.slice(0, 100).map(row => `<tr><td>${Number(row.number)} · ${esc(row.command)} · ${esc(row.table)}</td><td>${row.utf8Bytes === null ? 'Chưa xác định' : Number(row.utf8Bytes).toLocaleString()}</td><td>${codes([row.reason])}</td></tr>`).join('') || '<tr><td colspan="3">Không có câu SQL đang được xem xét.</td></tr>'}</tbody></table></div>
    ${review.truncated || review.rows.length > 100 ? '<p>Chỉ hiện 100 câu đầu; báo cáo có giới hạn. Câu thiếu chi tiết vì quota vẫn bị chặn trong bản nháp.</p>' : ''}</details>`;
}

const BACKUP_SELECTION_OMITTED_LABELS = Object.freeze({
  OMITTED_REQUIRED_COLUMN: 'Cột bắt buộc bị bỏ khỏi INSERT, chưa thấy DEFAULT hay cơ chế tự sinh',
  OMITTED_IMPLICIT_NULL: 'Cột nullable không có DEFAULT được quan sát: dự kiến NULL',
  OMITTED_DEFAULT_NOT_REVIEWED: 'Có DEFAULT nhưng chưa kiểm chứng giá trị hoặc biểu thức',
  OMITTED_DEFAULT_METADATA_UNKNOWN: 'Thiếu metadata về việc có DEFAULT', OMITTED_GENERATED_NOT_REVIEWED: 'Cột generated cần kiểm chứng biểu thức và tác động',
  OMITTED_AUTO_INCREMENT_NOT_REVIEWED: 'Bỏ cột tự tăng: chưa kiểm chứng giá trị tự sinh', OMITTED_TIMESTAMP_NOT_REVIEWED: 'Bỏ TIMESTAMP: cần kiểm chứng thiết lập phiên và default',
  OMITTED_SEMANTICS_NOT_REVIEWED: 'Kiểu hoặc thuộc tính cột chưa đủ căn cứ', OMITTED_COLUMNS_NOT_REVIEWED: 'Chưa có metadata cột đầy đủ cho kiểm tra cột bị bỏ',
  OMITTED_MAPPING_UNKNOWN: 'Chưa ánh xạ được toàn bộ danh sách cột INSERT', OMITTED_INSERT_NOT_REVIEWED: 'INSERT thiếu bằng chứng cú pháp/giá trị, cần quét lại',
  OMITTED_SCHEMA_MAPPING_REQUIRED: 'Schema ghi rõ cần được đối chiếu', OMITTED_LEDGER_INCOMPLETE: 'Danh sách câu lệnh chưa đầy đủ',
  OMITTED_ANALYSIS_LIMIT: 'Vượt giới hạn 10.000 vị trí metadata được kiểm tra', OMITTED_REPORT_LIMIT: 'Báo cáo cột bị bỏ vượt giới hạn; câu thiếu chi tiết bị chặn',
  OMITTED_REVIEW_INCOMPLETE: 'Một phần cột bị bỏ chưa được kiểm chứng', OMITTED_DEFAULT_VALUES_NOT_VALIDATED: 'Chưa xác minh đầy đủ giá trị DEFAULT và biểu thức tự sinh',
  OMITTED_SERVER_RULES_NOT_VALIDATED: 'Chưa kiểm chứng đầy đủ SQL mode, constraints và quy tắc server', OMITTED_TARGET_RECHECK_REQUIRED: 'Phải đọc lại metadata đích trước khi ghi'
});

function backupSelectionOmittedHtml(review) {
  if (review?.version !== 1) return '';
  const statuses = { checked: 'Đã kiểm tra phạm vi cột bị bỏ', issues: 'Có vấn đề', unknown: 'Chưa đủ căn cứ' };
  const codes = values => values.map(code => esc(BACKUP_SELECTION_OMITTED_LABELS[code] || code)).join('; ');
  let visible = 0;
  const items = review.rows.slice(0, 20).map(row => {
    const columns = ['source', 'target'].flatMap(side => row[side].columns.map(column => ({ ...column, side })));
    const shown = columns.slice(0, Math.max(0, 100 - visible)); visible += shown.length;
    return `<p><strong>#${Number(row.number)} · ${esc(row.table)} · ${esc(statuses[row.status] || row.status)}</strong>${row.reasons.length ? `<br>${codes(row.reasons)}` : ''}</p>
      ${['source', 'target'].map(side => `<p>${side === 'source' ? 'Nguồn' : 'Đích'}: ${esc(statuses[row[side].status] || row[side].status)} · ${row[side].omittedCount === null ? 'Chưa xác định số' : Number(row[side].omittedCount)} cột bị bỏ${row[side].findings.length ? `<br>${codes(row[side].findings)}` : ''}.</p>`).join('')}
      ${shown.length ? `<div class="backup-selection-table"><table><thead><tr><th>Phía / Cột bị bỏ</th><th>Quan sát</th></tr></thead><tbody>${shown.map(column => `<tr><td>${column.side === 'source' ? 'Nguồn' : 'Đích'} · ${esc(column.name)}${column.invisible ? ' · Invisible' : ''}</td><td>${codes([column.code])}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
  }).join('');
  return `<details class="backup-selection-omitted"><summary>Cột bị bỏ khỏi INSERT · Chỉ đọc</summary>
    <p>${Number(review.totals.statements)} INSERT · ${Number(review.totals.checked)} đã kiểm tra phạm vi cột bị bỏ · ${Number(review.totals.issues)} có vấn đề · ${Number(review.totals.unknown)} chưa đủ căn cứ · ${Number(review.totals.excluded)} loại khỏi lựa chọn.</p>
    <p>Đối chiếu riêng từng câu INSERT với cột nguồn và đích. INSERT theo vị trí bỏ các cột Invisible; số vị trí phải khớp trước khi nhận định cột nào bị bỏ. Không hiển thị hoặc tự áp dụng giá trị DEFAULT. Tự tăng, generated và TIMESTAMP cần kiểm chứng riêng; chưa xác nhận đủ điều kiện phục hồi.</p>
    <ul>${[...review.findings, ...review.requires].map(code => `<li>${codes([code])}</li>`).join('')}</ul>${items || '<p>Không có INSERT đang được xem xét.</p>'}
    ${review.truncated || review.rows.length > 20 || review.rows.reduce((sum, row) => sum + row.source.columns.length + row.target.columns.length, 0) > visible ? '<p>Hiện tối đa 20 câu / 100 cột ở hai phía; báo cáo có giới hạn.</p>' : ''}</details>`;
}

const BACKUP_SELECTION_SESSION_LABELS = Object.freeze({
  SESSION_UNIQUE_CHECKS_DISABLED: 'Phiên kiểm tra đích đang tắt unique_checks', SESSION_UNIQUE_CHECKS_NOT_REVIEWED: 'Chưa đọc được unique_checks; cần kiểm tra lại phiên đích',
  SESSION_UNIQUE_DATA_NOT_VALIDATED: 'Chưa kiểm chứng dữ liệu có trùng khóa duy nhất', SESSION_UNIQUE_CHECKS_RECHECK_REQUIRED: 'Phải đọc lại unique_checks trên đúng phiên trước khi ghi',
  SESSION_SETTINGS_NOT_REVIEWED: 'Chưa đọc đủ thiết lập phiên đích', SESSION_FK_CHECKS_DISABLED: 'Phiên kiểm tra đích đang tắt kiểm tra FK',
  SESSION_AUTOCOMMIT_DISABLED: 'Phiên kiểm tra đích đang tắt autocommit', SESSION_CHARSET_REQUIRES_REVIEW: 'Charset của phiên chưa đồng nhất utf8mb4',
  SESSION_SQL_MODE_FLAGS_NOT_REVIEWED: 'Có SQL mode chưa nhận diện', SESSION_STRICT_MODE_NOT_ENABLED: 'Phiên đích chưa bật strict mode',
  SESSION_CONTEXT_REQUIRES_REVIEW: 'Trình tự thiết lập trong tệp chưa đủ căn cứ', SESSION_ACTION_LIMIT: 'Danh sách thiết lập vượt giới hạn 50 bước',
  SESSION_DEPENDENCY_ORDER_NOT_PROVEN: 'Thứ tự dependency/FK chưa được chứng minh khi giữ kiểm tra FK bật',
  SESSION_DEDICATED_CONNECTION_REQUIRED: 'Phải dùng kết nối phục hồi riêng', SESSION_RECHECK_REQUIRED: 'Phải đọc lại thiết lập trên đúng phiên thực thi',
  SESSION_VALUES_NOT_VALIDATED: 'Chưa xác minh giá trị theo SQL mode đề xuất', SESSION_FK_DATA_RECHECK_REQUIRED: 'Cần kiểm tra kết quả và dữ liệu FK sau ghi',
  SESSION_CLEANUP_NOT_IMPLEMENTED: 'Chưa có luồng khôi phục thiết lập sau khi chạy', SESSION_EXECUTION_NOT_IMPLEMENTED: 'Chưa có luồng thực thi chính sách phiên'
});

function backupSelectionSessionPolicyHtml(review) {
  if (![1, 2].includes(review?.version)) return '';
  const lifecycle = { 'open-dedicated-connection': 'Mở kết nối riêng', 'capture-and-recheck-settings': 'Chụp và kiểm tra lại thiết lập',
    'validate-selection-and-values': 'Kiểm tra lựa chọn và giá trị', 'apply-reviewed-mode': 'Áp dụng mode đã kiểm chứng', 'verify-unique-checks-enabled': 'Xác nhận unique_checks vẫn bật',
    'execute-reviewed-statements-with-fk-enabled': 'Chạy câu đã duyệt với kiểm tra FK bật', 'check-result-and-foreign-keys': 'Đối chiếu kết quả và FK',
    'restore-captured-settings-in-finally': 'Khôi phục thiết lập khi kết thúc', 'close-dedicated-connection': 'Đóng kết nối riêng' };
  const proposals = { 'require-utf8mb4-connection': 'Yêu cầu phiên sẵn có utf8mb4', 'keep-foreign-key-checks-enabled': 'Giữ kiểm tra FK bật',
    'preserve-mode-add-zero-flag': 'Giữ SQL mode đích, chỉ bổ sung NO_AUTO_VALUE_ON_ZERO', 'restore-captured-mode': 'Khôi phục SQL mode đã chụp',
    'verify-foreign-key-checks-enabled': 'Xác nhận kiểm tra FK vẫn bật' };
  const observed = review.observations;
  return `<details class="backup-selection-session-policy"><summary>Chính sách phiên phục hồi · Đề xuất, chưa thực thi</summary>
    <p>Giữ kiểm tra FK bật và yêu cầu unique_checks bật, yêu cầu utf8mb4 và giữ SQL mode đích; chỉ đề xuất thêm NO_AUTO_VALUE_ON_ZERO khi dump yêu cầu. Không chạy trực tiếp các SET nguồn từ bản nháp. Dừng khi lỗi/hủy, báo phần đã ghi, không tự retry; không cam kết rollback toàn bộ DDL.</p>
    <p>Phiên kiểm tra hiện tại: FK ${observed ? observed.foreignKeyChecks ? 'bật' : 'tắt' : 'chưa xác định'} · unique_checks ${review.version === 2 && typeof observed?.uniqueChecks === 'boolean' ? observed.uniqueChecks ? 'bật' : 'tắt' : 'chưa xác định'} · autocommit ${observed ? observed.autocommit ? 'bật' : 'tắt' : 'chưa xác định'}. Bật unique_checks không chứng minh dữ liệu không trùng khóa. Đây chưa phải trạng thái được bảo đảm cho phiên thực thi tương lai.</p>
    <p>SQL mode hiện tại: ${observed ? esc(observed.sqlMode.flags.join(', ') || 'Không có cờ đã nhận diện') : 'Chưa xác định'}${observed?.sqlMode.unreviewedCount ? ` · ${Number(observed.sqlMode.unreviewedCount)} cờ chưa nhận diện` : ''}<br>SQL mode đề xuất: ${review.proposedMode ? esc(review.proposedMode.flags.join(', ') || 'Không có cờ') : 'Chưa đủ metadata để đề xuất'}</p>
    <ul>${[...review.findings.map(item => item.code), ...review.requires].map(code => `<li>${esc(BACKUP_SELECTION_SESSION_LABELS[code] || code)}</li>`).join('')}</ul>
    <div class="backup-selection-table"><table><thead><tr><th># câu nguồn</th><th>Xử lý được đề xuất</th></tr></thead><tbody>${review.actions.map(action => `<tr><td>${Number.isInteger(action.number) ? action.number : '?'}</td><td>${esc(proposals[action.proposal] || action.proposal)}</td></tr>`).join('') || '<tr><td colspan="2">Không có SET được nhận diện để ánh xạ.</td></tr>'}</tbody></table></div>
    <p>Các bước cần triển khai: ${review.lifecycle.map(step => esc(lifecycle[step] || step)).join(' → ')}.</p></details>`;
}

function backupSelectionDraftHtml(plan) {
  if (!plan) return '';
  const labels = { ...BACKUP_SELECTION_EXPRESSION_LABELS, ...BACKUP_SELECTION_TRIGGER_LABELS, ...BACKUP_SELECTION_PACKET_LABELS, ...BACKUP_SELECTION_OMITTED_LABELS, ...BACKUP_SELECTION_VALUE_LABELS, ...BACKUP_SELECTION_SESSION_LABELS, ...BACKUP_SELECTION_POLICY_LABELS, ...BACKUP_SELECTION_FK_LABELS, EXECUTION_NOT_IMPLEMENTED: 'Chưa có luồng thực thi chọn bảng', SOURCE_SUBSET_NOT_VALIDATED: 'Chưa kiểm chứng cú pháp được hỗ trợ và tác động SQL',
    TARGET_ENGINE_NOT_REVIEWED: 'Chưa đủ metadata storage engine bảng đích', TARGET_ENGINE_UNSUPPORTED: 'Storage engine bảng đích ngoài phạm vi hiện tại',
    TARGET_ENGINE_RECHECK_REQUIRED: 'Phải đọc lại engine bảng đích trước khi ghi', TARGET_INDIRECT_WRITES_NOT_REVIEWED: 'Chưa kiểm chứng trigger và tác động ghi gián tiếp; chưa bảo đảm rollback toàn bộ',
    TARGET_RECHECK_REQUIRED: 'Phải kiểm tra lại đích sát lúc ghi', WRITE_PRIVILEGES_NOT_REVIEWED: 'Chưa kiểm tra quyền ghi', STATEMENT_LEDGER_INCOMPLETE: 'Danh sách câu lệnh chưa đầy đủ',
    SOURCE_REVIEW_INCOMPLETE: 'Phân tích nguồn chưa đầy đủ', SOURCE_REVIEW_FINDING: 'Cảnh báo nguồn cần xử lý', TARGET_REVIEW_FINDING: 'Cảnh báo đích cần xử lý',
    TARGET_REVIEW_INCOMPLETE: 'Đối chiếu đích chưa đầy đủ', TARGET_INDEXES_REQUIRE_REVIEW: 'Chưa đủ bằng chứng chỉ mục đích; cần đối chiếu thêm', TARGET_FOREIGN_KEYS_REQUIRE_REVIEW: 'Chưa đủ metadata FK đích; cần kiểm tra lại', COLUMNS_REQUIRE_REVIEW: 'Cột cần đối chiếu thêm', STATEMENT_NOT_CLASSIFIED: 'Chưa phân loại được phạm vi câu lệnh',
    TABLE_NOT_SELECTED: 'Bảng ngoài lựa chọn', PART_NOT_SELECTED: 'Phần cấu trúc/dữ liệu ngoài lựa chọn', SCHEMA_MAPPING_REQUIRED: 'Schema ghi rõ chưa được ánh xạ sang đích',
    DESTRUCTIVE_POLICY_REQUIRED: 'DROP cần chính sách thay/xóa đối tượng', SOURCE_SQL_REQUIRES_VALIDATION: 'Thuộc lựa chọn; SQL chưa được kiểm chứng để chạy',
    SESSION_CONTEXT_NOT_PLANNED: 'Chưa lập phạm vi thiết lập session/transaction', DIRECTIVE_SKIPPED_BY_CURRENT_RESTORE: 'Luồng restore hiện có bỏ qua chỉ thị USE/DATABASE',
    TARGET_STRUCTURE_CONFLICT: 'Trùng bảng đã có', TARGET_VIEW_CONFLICT: 'Trùng tên view', TARGET_AMBIGUOUS_OBJECT: 'Tên đối tượng đích chưa phân biệt chắc chắn',
    TARGET_TRIGGERS_PRESENT: 'Bảng đích có trigger', TARGET_FOREIGN_KEYS_PRESENT: 'Có khóa ngoại liên quan',
    TARGET_INBOUND_FK_FROM_UNSELECTED_TABLE: 'Có bảng ngoài lựa chọn tham chiếu vào bảng đích', TARGET_DATABASE_NOT_VISIBLE: 'Chưa thấy database đích trong quyền tài khoản',
    TARGET_METADATA_ERROR: 'Có metadata đích chưa đọc được', TARGET_METADATA_TRUNCATED: 'Metadata đích vượt giới hạn', TARGET_CASE_POLICY_UNKNOWN: 'Chưa xác định chính sách hoa/thường',
    TARGET_DATA_TABLE_NOT_VISIBLE: 'Chưa thấy bảng để ghi dữ liệu', TARGET_DATA_SCHEMA_NOT_VALIDATED: 'Chưa xác nhận khả năng ghi giá trị vào đích',
    SOURCE_DROP_REQUIRES_EXPLICIT_POLICY: 'DROP cần chính sách thay/xóa đối tượng', SOURCE_SCHEMA_MAPPING_NOT_VALIDATED: 'Chưa kiểm chứng ánh xạ database nguồn sang đích',
    CONDITIONAL_CREATE: 'CREATE có điều kiện IF NOT EXISTS', REPEATED_CREATE: 'Nhiều CREATE cho cùng bảng', NON_TABLE_DEFINITION: 'Có định nghĩa ngoài bảng',
    UNSUPPORTED_TABLE_DEFINITION: 'Định nghĩa bảng ngoài phạm vi phân tích', UNKNOWN_DEPENDENCY: 'Có phụ thuộc chưa phân tích được', UNSUPPORTED_STATEMENT: 'Có câu lệnh ngoài phạm vi phân tích',
    CASE_AMBIGUITY: 'Tên bảng chỉ khác hoa/thường', STRUCTURE_UNAVAILABLE: 'Chưa có đúng một CREATE cho bảng', EXTERNAL_DEPENDENCY: 'FK tham chiếu database khác',
    MISSING_DEPENDENCY: 'Chưa chọn bảng được FK tham chiếu', DEPENDENCY_NOT_IN_BACKUP: 'Bảng được FK tham chiếu chưa có trong backup', FK_CYCLE_OR_BLOCKED: 'Có vòng FK hoặc phụ thuộc chưa xếp được',
    INVENTORY_TRUNCATED: 'Inventory vượt giới hạn', TARGET_STRUCTURE_NOT_CHECKED: 'Cấu trúc đích cần đối chiếu', DEFINITION_LIMIT: 'Định nghĩa vượt giới hạn phân tích',
    EXECUTABLE_COMMENT: 'Có executable comment', DEFINITION_SYNTAX: 'Định nghĩa chưa phân tích được', DATA_DEPENDENCIES_NOT_ANALYZED: 'INSERT có phụ thuộc chưa phân tích',
    SQL_MODE_CONTEXT: 'SQL_MODE cần đối chiếu', SOURCE_COLUMNS_INCOMPLETE: 'Chưa đọc đủ định nghĩa cột nguồn',
    LITERAL_INSERT_MATCHED: 'Khớp cú pháp INSERT literal; chưa xác nhận khả năng ghi vào đích', INSERT_SYNTAX_NOT_REVIEWED: 'Chưa kiểm tra cú pháp INSERT',
    INSERT_FORM_UNSUPPORTED: 'Dạng INSERT chưa hỗ trợ', INSERT_VALUE_EXPRESSION: 'Giá trị có biểu thức hoặc cú pháp chưa hỗ trợ', INSERT_TRAILING_SQL: 'Có phần SQL nối sau VALUES chưa hỗ trợ',
    INSERT_QUOTING_UNSUPPORTED: 'Có kiểu quote/escape chưa hỗ trợ', INSERT_COMMENT_UNSUPPORTED: 'Có comment cần phân tích thêm',
    INSERT_LITERAL_UNSUPPORTED: 'Literal chưa hỗ trợ hoặc chưa đúng định dạng', INSERT_IDENTIFIER_UNSUPPORTED: 'Tên đối tượng chưa hỗ trợ',
    INSERT_COLUMN_LIST_INVALID: 'Danh sách cột chưa hợp lệ hoặc vượt giới hạn', INSERT_ARITY_MISMATCH: 'Số giá trị giữa các bộ VALUES hoặc danh sách cột không khớp',
    INSERT_VALIDATION_LIMIT: 'Kiểm tra cú pháp INSERT vượt giới hạn', INSERT_TARGET_MISMATCH: 'Các bước phân tích chưa thống nhất bảng/schema của INSERT',
    BASIC_CREATE_MATCHED: 'Khớp cú pháp CREATE TABLE cơ bản; chưa xác nhận khả năng tạo bảng ở đích', CREATE_SYNTAX_NOT_REVIEWED: 'Chưa kiểm tra cú pháp CREATE TABLE',
    CREATE_FORM_UNSUPPORTED: 'Dạng CREATE TABLE chưa hỗ trợ', CREATE_IDENTIFIER_UNSUPPORTED: 'CREATE cần tên được quote bằng backtick, trong giới hạn hỗ trợ',
    CREATE_QUOTING_UNSUPPORTED: 'CREATE có kiểu quote/escape chưa hỗ trợ', CREATE_COMMENT_UNSUPPORTED: 'CREATE có comment cần phân tích thêm',
    CREATE_TYPE_OR_LENGTH_UNSUPPORTED: 'CREATE có kiểu dữ liệu hoặc tham số kiểu chưa hỗ trợ', CREATE_COLUMN_ATTRIBUTE_UNSUPPORTED: 'CREATE có thuộc tính cột chưa hỗ trợ',
    CREATE_DEFAULT_UNSUPPORTED: 'DEFAULT có biểu thức hoặc cú pháp chưa hỗ trợ', CREATE_INDEX_UNSUPPORTED: 'CREATE có chỉ mục chưa hỗ trợ hoặc tham chiếu cột không hợp lệ',
    CREATE_DUPLICATE_NAME: 'CREATE có tên cột hoặc chỉ mục trùng', CREATE_DEFINITION_UNSUPPORTED: 'CREATE có định nghĩa/FK/constraint chưa hỗ trợ',
    CREATE_OPTION_UNSUPPORTED: 'CREATE có tùy chọn bảng chưa hỗ trợ hoặc trùng', CREATE_ENGINE_REQUIRED: 'CREATE chưa ghi rõ ENGINE=InnoDB',
    CREATE_ENGINE_UNSUPPORTED: 'Kiểm tra CREATE cơ bản hiện chỉ hỗ trợ ENGINE=InnoDB', CREATE_TRAILING_SQL: 'Có SQL nối sau CREATE chưa hỗ trợ',
    CREATE_VALIDATION_LIMIT: 'Kiểm tra cú pháp CREATE vượt giới hạn', CREATE_TARGET_MISMATCH: 'Các bước phân tích chưa thống nhất bảng/schema của CREATE',
    CREATE_FOREIGN_KEY_COLUMNS_INVALID: 'Danh sách cột FK trùng, rỗng hoặc vượt giới hạn', CREATE_FOREIGN_KEY_ARITY_MISMATCH: 'Số cột hai phía FK không khớp',
    CREATE_FOREIGN_KEY_ACTION_UNSUPPORTED: 'Action FK chưa hỗ trợ hoặc bị lặp', CREATE_FOREIGN_KEY_FORM_UNSUPPORTED: 'FK có cú pháp chưa hỗ trợ',
    CREATE_FOREIGN_KEY_COLUMN_UNKNOWN: 'FK nêu cột không thấy trong bảng nguồn', CREATE_FOREIGN_KEY_LIMIT: 'Quá 64 FK trong một CREATE',
    CREATE_INDEX_EVIDENCE_LIMIT: 'Bằng chứng chỉ mục toàn inventory vượt giới hạn',
    CREATE_FOREIGN_KEY_EVIDENCE_LIMIT: 'Bằng chứng FK toàn inventory vượt giới hạn',
    DUMP_CONTEXT_REQUIRES_POLICY: 'Thiết lập session cần chính sách phiên riêng trước khi chạy', CONTEXT_NOT_REVIEWED: 'Chưa nhận diện thiết lập session',
    CONTEXT_FOREIGN_KEYS_RECHECK_REQUIRED: 'Bật lại kiểm tra FK không xác nhận dữ liệu đã hợp lệ; cần kiểm tra riêng',
    CONTEXT_SQL_MODE_REVIEW_REQUIRED: 'SQL_MODE bị thay tạm thời; cần kiểm tra chuyển đổi giá trị và chế độ đích',
    CONTEXT_VALIDATION_LIMIT: 'Thiết lập session vượt giới hạn kiểm tra', CONTEXT_SET_UNSUPPORTED: 'Dạng SET ngoài mẫu dump được hỗ trợ',
    CONTEXT_TRANSACTION_UNSUPPORTED: 'Chưa lập chính sách transaction/UNLOCK của tệp nguồn', CONTEXT_QUOTING_UNSUPPORTED: 'SET có quote/escape chưa hỗ trợ',
    CONTEXT_COMMENT_UNSUPPORTED: 'SET có comment cần phân tích thêm', CONTEXT_LEDGER_INCOMPLETE: 'Thiếu danh sách đầy đủ để đối chiếu trình tự session',
    CONTEXT_BODY_AFTER_RESTORE: 'Có câu lệnh sau bước khôi phục thiết lập session', CONTEXT_HEADER_AFTER_BODY: 'Có thiết lập đầu tệp sau khi phần SQL đã bắt đầu',
    CONTEXT_RESTORE_WITHOUT_SAVE: 'Khôi phục thiết lập nhưng chưa thấy bước lưu gốc', CONTEXT_RESTORE_ORDER: 'Thứ tự khôi phục khác mẫu đảo thứ tự lưu',
    CONTEXT_DUPLICATE_ACTION: 'Lặp bước thiết lập/lưu/khôi phục session', CONTEXT_SETTINGS_NOT_RESTORED: 'Thiếu bước khôi phục thiết lập đã lưu' };
  const decisions = { candidate: 'Thuộc lựa chọn', excluded: 'Ngoài lựa chọn', blocked: 'Chưa xử lý', skipped: 'Chỉ thị được bỏ qua' };
  const contextActions = { 'set-names-utf8mb4': 'Chọn charset utf8mb4', 'save-disable-foreign-keys': 'Lưu và tạm tắt kiểm tra FK',
    'save-set-sql-mode': 'Lưu và tạm thay SQL_MODE', 'restore-sql-mode': 'Khôi phục SQL_MODE đã lưu', 'restore-foreign-keys': 'Khôi phục thiết lập kiểm tra FK đã lưu' };
  const syntaxHtml = step => {
    if (step.contextReview?.status === 'matched') return `SET dump · ${esc(contextActions[step.contextReview.action] || 'Chưa nhận diện')}`;
    if (step.contextReview) return esc(labels[step.contextReview.code] || step.contextReview.code);
    const review = step.syntaxReview;
    if (review?.status === 'matched' && step.command === 'CREATE') return `CREATE TABLE cơ bản · ${Number(review.columns)} cột · ${Number(review.indexes)} chỉ mục · InnoDB${review.foreignKeys ? ` · ${review.foreignKeys.length} FK` : ''}`;
    if (review?.status === 'matched' && step.command === 'INSERT') return `INSERT literal · ${Number(review.rows)} bộ VALUES × ${Number(review.valuesPerRow)} giá trị`;
    return review ? esc(labels[review.code] || review.code) : 'Chưa kiểm tra';
  };
  return `<details class="backup-selection-draft"><summary>Bản nháp kế hoạch · ${Number(plan.statementCount)} câu lệnh nguồn · Chưa thể thực thi</summary>
    <p>Đích: ${esc(plan.targetDatabase)}. Chỉ để review; chưa cấp quyền chạy. Thứ tự bên dưới giữ theo tệp nguồn, chưa phải thứ tự phục hồi được xác nhận. Không tự bỏ qua câu chưa xử lý hoặc tự chấp thuận DROP.</p>
    <p>Mã bản nháp: <code>${esc(plan.planId)}</code></p>
    ${backupSelectionConflictPolicyHtml(plan.conflictPolicyReview)}${backupSelectionSessionPolicyHtml(plan.sessionPolicyReview)}${backupSelectionValuesHtml(plan.valueReview)}${backupSelectionOmittedHtml(plan.omittedValueReview)}${backupSelectionPacketsHtml(plan.packetReview)}
    ${backupSelectionForeignKeysHtml(plan.foreignKeyReview)}${backupSelectionForeignKeyComparisonHtml(plan.foreignKeyComparison)}
    ${plan.syntaxTotals ? `<p>INSERT trong lựa chọn: ${Number(plan.syntaxTotals.matched)} khớp cú pháp literal · ${Number(plan.syntaxTotals.unsupported)} chưa hỗ trợ · ${Number(plan.syntaxTotals.notReviewed)} chưa kiểm tra. Chỉ kiểm tra cú pháp, chưa xác nhận chuyển đổi giá trị hoặc tác động trigger/FK. Số bộ VALUES không phải số dòng đã ghi.</p>` : ''}
    ${plan.createSyntaxTotals ? `<p>CREATE trong lựa chọn: ${Number(plan.createSyntaxTotals.matched)} khớp cú pháp cơ bản · ${Number(plan.createSyntaxTotals.unsupported)} chưa hỗ trợ · ${Number(plan.createSyntaxTotals.notReviewed)} chưa kiểm tra. Chưa xác nhận quyền, tính hợp lệ theo server, charset/collation, xung đột hoặc tác động tạo bảng. Nhận diện cú pháp FK chưa xác nhận chỉ mục đích/dữ liệu; generated, CHECK và chính sách context SQL chưa được kiểm chứng.</p>` : ''}
    ${plan.sessionContextReview?.total ? `<p>Thiết lập session toàn tệp: ${Number(plan.sessionContextReview.matched)} khớp mẫu dump · ${Number(plan.sessionContextReview.unsupported)} chưa hỗ trợ · ${Number(plan.sessionContextReview.notReviewed)} chưa kiểm tra. Trình tự lưu/khôi phục: ${plan.sessionContextReview.sequenceMatched ? 'khớp mẫu' : 'cần kiểm tra'}. Phải dùng phiên riêng; nhận diện mẫu chưa cấp quyền thực thi hoặc chứng minh tác động SQL.</p>` : ''}
    <p>${Number(plan.totals.candidate)} thuộc lựa chọn · ${Number(plan.totals.excluded)} ngoài lựa chọn · ${Number(plan.totals.blocked)} chưa xử lý · ${Number(plan.totals.skipped)} chỉ thị được luồng hiện có bỏ qua${plan.stepsTruncated ? ' (danh sách có giới hạn)' : ''}.</p>
    <h4>Các phần còn chặn thực thi</h4><ul>${plan.blockers.map(item => `<li>${esc(labels[item.code] || item.code)}${item.table ? ` · ${esc(item.table)}` : ''}${item.detail ? ` · ${esc(labels[item.detail] || item.detail)}` : ''}</li>`).join('')}</ul>
    ${plan.blockersTruncated ? '<p>Còn lý do ngoài giới hạn 100 mục.</p>' : ''}
    <div class="backup-selection-table"><table><thead><tr><th># nguồn</th><th>Lệnh / bảng</th><th>Phạm vi</th><th>Kiểm tra cú pháp</th><th>Lý do</th></tr></thead><tbody>${plan.steps.map(step => `<tr><td>${Number(step.number)}</td><td>${esc(step.command)}${step.table ? ` · ${esc(`${step.schema ? `${step.schema}.` : ''}${step.table}`)}` : ''}</td><td>${esc(decisions[step.decision] || step.decision)}</td><td>${syntaxHtml(step)}</td><td>${esc(labels[step.reason] || step.reason)}</td></tr>`).join('')}</tbody></table></div>
    ${plan.stepsTruncated ? '<p>Chỉ hiện tối đa 200 câu lệnh; inventory giữ tối đa 10.000. Danh sách bị cắt không đủ căn cứ thực thi.</p>' : ''}</details>`;
}

const BACKUP_SELECTION_TARGET_FK_LABELS = Object.freeze({
  TARGET_FK_METADATA_INCOMPLETE: 'Chưa đọc đủ metadata FK đích; cần kiểm tra lại', TARGET_FK_SCOPE_UNKNOWN: 'Chưa xác định phạm vi hoặc chính sách hoa/thường',
  TARGET_FK_METADATA_INVALID: 'Metadata FK không hợp lệ', TARGET_FK_IDENTITY_AMBIGUOUS: 'Tên FK bị mơ hồ theo schema/bảng và chính sách hoa/thường',
  TARGET_FK_REFERENCE_INCONSISTENT: 'Các cặp cột không thống nhất bảng/schema được tham chiếu', TARGET_FK_PAIR_LIMIT: 'FK vượt giới hạn 16 cặp cột',
  TARGET_FK_PAIRS_INVALID: 'Thứ tự cặp cột bị gãy/trùng hoặc tên cột lặp', TARGET_FK_ACTIONS_NOT_REVIEWED: 'Chưa đủ metadata action/MATCH hoặc dạng chưa hỗ trợ',
  TARGET_FK_ACTIONS_INCONSISTENT: 'Metadata ON DELETE/ON UPDATE/MATCH không nhất quán', TARGET_FK_REVIEW_LIMIT: 'Báo cáo FK vượt giới hạn',
  TARGET_FK_DEFINITION_OBSERVED: 'Đã ghép metadata; chưa xác nhận dữ liệu, chỉ mục và quy tắc server'
});

function backupSelectionTargetForeignKeysHtml(review) {
  if (review?.version !== 1) return '<p>Chưa có báo cáo FK đích đầy đủ; cần kiểm tra lại metadata.</p>';
  const relations = { internal: 'Trong lựa chọn', inbound: 'Bảng ngoài lựa chọn tham chiếu vào', outbound: 'Tham chiếu ra ngoài lựa chọn', inconsistent: 'Quan hệ chưa nhất quán' };
  return `<details class="backup-target-foreign-keys"><summary>Khóa ngoại đích · ${Number(review.definitionCount)} định nghĩa · ${Number(review.pairCount)} cặp cột thấy được</summary>
    <p>${Number(review.totals.observed)} đã ghép metadata · ${Number(review.totals.unknown)} chưa đủ bằng chứng. Chỉ đọc metadata trong quyền tài khoản; chưa thấy FK không chứng minh không tồn tại. Chưa kiểm tra dữ liệu mồ côi, chỉ mục, tác động cascade hoặc quy tắc server; phải đọc lại sát lúc ghi. Không thay đổi hay thực thi ràng buộc từ báo cáo này.</p>
    <ul>${review.findings.map(item => `<li>${esc(BACKUP_SELECTION_TARGET_FK_LABELS[item.code] || item.code)}${item.table ? ` · ${esc(item.table)}` : ''}</li>`).join('')}</ul>
    <div class="backup-selection-table"><table><thead><tr><th>FK / Bảng → Tham chiếu</th><th>Cặp cột theo thứ tự</th><th>Hành vi</th><th>Phạm vi / Quan sát</th></tr></thead><tbody>${review.rows.slice(0, 100).map(row => `<tr><td>${esc(row.name)}<br>${esc(`${row.tableSchema}.${row.table}`)} → ${esc(row.referencedTable ? `${row.referencedSchema}.${row.referencedTable}` : 'Chưa xác định')}</td><td>${row.pairs.map(pair => `${Number.isInteger(pair.ordinal) ? pair.ordinal : '?'}: ${esc(pair.column)} → ${esc(pair.referencedColumn)}`).join('<br>')}${row.pairCount > row.pairs.length ? '<br>Còn cặp cột chưa hiển thị.' : ''}</td><td>DELETE: ${esc(row.onDelete || 'Chưa xác định')}<br>UPDATE: ${esc(row.onUpdate || 'Chưa xác định')}<br>MATCH: ${esc(row.match || 'Chưa xác định')}</td><td>${esc(relations[row.relation] || row.relation)}<br>${esc(BACKUP_SELECTION_TARGET_FK_LABELS[row.reason] || row.reason)}</td></tr>`).join('') || '<tr><td colspan="4">Chưa thấy trong metadata đọc được.</td></tr>'}</tbody></table></div>
    ${review.truncated || review.rows.length > 100 ? '<p>Hiện tối đa 100 định nghĩa; báo cáo hoặc cặp cột còn ngoài giới hạn. Hãy giảm phạm vi chọn và kiểm tra lại.</p>' : ''}</details>`;
}

const BACKUP_SELECTION_CHECK_LABELS = Object.freeze({
  TARGET_CHECK_SESSION_DISABLED: 'Phiên đích đang tắt check_constraint_checks', TARGET_CHECK_SESSION_OBSERVED: 'Đã đọc check_constraint_checks của phiên kiểm tra',
  TARGET_CHECK_SESSION_VARIABLE_UNAVAILABLE: 'Server không cung cấp check_constraint_checks qua truy vấn này; chưa xác định trạng thái phiên',
  TARGET_CHECK_SESSION_QUERY_FAILED: 'Không đọc được check_constraint_checks; cần kiểm tra lại phiên đích', TARGET_CHECK_SESSION_RESULT_INVALID: 'Kết quả check_constraint_checks chưa đủ căn cứ',
  TARGET_CHECK_CAPABILITY_UNKNOWN: 'Chưa xác nhận được khả năng đọc metadata CHECK', TARGET_CHECK_METADATA_INVALID: 'Metadata CHECK không hợp lệ',
  TARGET_CHECK_SCHEMA_MISMATCH: 'Schema của CHECK chưa khớp đích', TARGET_CHECK_DUPLICATE_METADATA: 'Có metadata CHECK trùng, chưa xác định được định nghĩa',
  TARGET_CHECK_DEFINITION_UNKNOWN: 'Chưa đọc được định nghĩa CHECK trong giới hạn', TARGET_CHECK_TABLE_NOT_OBSERVED: 'Chưa xác nhận đúng bảng chứa CHECK',
  TARGET_CHECK_METADATA_INCOMPLETE: 'Metadata CHECK chưa đầy đủ', TARGET_CHECK_DATA_NOT_VALIDATED: 'Có CHECK ở đích; chưa kiểm chứng dữ liệu phục hồi thỏa điều kiện',
  TARGET_CHECK_REPORT_LIMIT: 'Báo cáo CHECK vượt giới hạn', TARGET_CHECK_EXPRESSION_NOT_EVALUATED: 'Chưa đánh giá biểu thức CHECK trên dữ liệu',
  TARGET_CHECK_SESSION_NOT_REVIEWED: 'Cần kiểm chứng thiết lập phiên và hiệu lực CHECK trên server', TARGET_CHECK_RECHECK_REQUIRED: 'Phải đọc lại CHECK trước khi ghi'
});

function backupSelectionTargetChecksHtml(review) {
  if (![1, 2].includes(review?.version)) return '<p>Chưa có báo cáo CHECK; cần kiểm tra lại metadata đích.</p>';
  const code = value => esc(BACKUP_SELECTION_CHECK_LABELS[value] || value);
  const enforcement = { yes: 'YES (metadata)', no: 'NO (metadata)', unknown: 'Chưa xác định' };
  const session = review.version === 2 && review.sessionSettings?.version === 1 && review.sessionSettings.status === 'observed' ? review.sessionSettings : null;
  return `<details class="backup-selection-checks"><summary>Ràng buộc CHECK ở đích · Chỉ xem trước</summary>
    <p>${Number(review.totals.observed)} định nghĩa quan sát được · ${Number(review.totals.unknown)} chưa đủ căn cứ. Chỉ thấy trong quyền tài khoản; kết quả trống không chứng minh không có CHECK.</p>
    <p>Không hiển thị hoặc thực thi biểu thức CHECK. Cờ ENFORCED chỉ là metadata, chưa chứng minh hiệu lực trên phiên thực thi hoặc dữ liệu phục hồi thỏa điều kiện.</p>
    <p>check_constraint_checks của phiên kiểm tra: ${typeof session?.enabled === 'boolean' ? session.enabled ? 'bật' : 'tắt' : 'chưa xác định'}. Trạng thái bật không chứng minh dữ liệu thỏa CHECK; phải đọc lại trên đúng phiên trước khi ghi.</p>
    <ul>${[...review.findings, ...review.requires].map(item => `<li>${code(item)}</li>`).join('')}</ul>
    <div class="backup-selection-table"><table><thead><tr><th>Bảng / CHECK</th><th>Định nghĩa</th><th>ENFORCED</th><th>Quan sát</th></tr></thead><tbody>${review.rows.slice(0, 100).map(row => `<tr><td>${esc(row.table)} · ${esc(row.name)}</td><td>${row.clauseObserved ? 'Đã quan sát; không hiển thị biểu thức' : 'Chưa xác định'}</td><td>${esc(enforcement[row.declaredEnforcement] || enforcement.unknown)}</td><td>${code(row.reason)}</td></tr>`).join('') || '<tr><td colspan="4">Chưa thấy trong metadata đọc được.</td></tr>'}</tbody></table></div>
    ${review.truncated || review.rows.length > 100 ? '<p>Chỉ hiện tối đa 100 CHECK; báo cáo có giới hạn.</p>' : ''}</details>`;
}

const BACKUP_SELECTION_EXPRESSION_LABELS = Object.freeze({
  TARGET_COLUMN_EXPRESSIONS_INCOMPLETE: 'Chưa đủ quan sát DEFAULT/generated của cột đích', TARGET_COLUMN_EXPRESSIONS_REPORT_LIMIT: 'Báo cáo DEFAULT/generated vượt giới hạn',
  TARGET_DEFAULT_VALUES_NOT_VALIDATED: 'Chưa kiểm chứng giá trị và ngữ nghĩa DEFAULT', TARGET_GENERATED_VALUES_NOT_VALIDATED: 'Chưa kiểm chứng giá trị do generated tạo ra',
  TARGET_COLUMN_EXPRESSIONS_RECHECK_REQUIRED: 'Phải đọc lại DEFAULT/generated sát lúc ghi'
});

function backupSelectionTargetExpressionsHtml(review) {
  if (review?.version !== 1) return '<p>Chưa có báo cáo DEFAULT/generated; cần kiểm tra lại đích.</p>';
  const defaults = { observed: 'Đã quan sát (không hiển thị giá trị)', 'null-metadata': 'NULL trong metadata; chưa kết luận không có DEFAULT', unknown: 'Chưa xác định' };
  const generated = { observed: 'Đã quan sát (không hiển thị biểu thức)', 'not-reported': 'Không có biểu thức được công bố', unknown: 'Chưa xác định' };
  return `<details class="backup-selection-expressions"><summary>DEFAULT/generated ở đích · Chỉ xem trước</summary>
    <p>${Number(review.totals.observed)} cột có metadata đã quan sát · ${Number(review.totals.unknown)} chưa đủ căn cứ.</p>
    <p>Chỉ phát hiện thay đổi trong giới hạn quan sát. Không hiển thị hoặc đánh giá giá trị/biểu thức, chưa đối chiếu DEFAULT/generated nguồn và đích hoặc chứng minh dữ liệu được phục hồi tương thích.</p>
    <ul>${[...review.findings, ...review.requires].map(code => `<li>${esc(BACKUP_SELECTION_EXPRESSION_LABELS[code] || code)}</li>`).join('')}</ul>
    <div class="backup-selection-table"><table><thead><tr><th>Bảng / Cột</th><th>DEFAULT</th><th>Generated</th><th>Quan sát</th></tr></thead><tbody>${review.rows.slice(0, 100).map(row => `<tr><td>${esc(row.table)} · ${esc(row.column)}</td><td>${esc(defaults[row.defaultStatus] || defaults.unknown)}</td><td>${esc(generated[row.generatedStatus] || generated.unknown)}</td><td>${row.status === 'metadata-observed' ? 'Metadata; chưa kiểm chứng ngữ nghĩa' : 'Chưa đủ căn cứ'}</td></tr>`).join('') || '<tr><td colspan="4">Chưa thấy trong metadata đọc được.</td></tr>'}</tbody></table></div>
    ${review.truncated || review.rows.length > 100 ? '<p>Chỉ hiện tối đa 100 cột; giảm phạm vi để xem đầy đủ.</p>' : ''}</details>`;
}

const BACKUP_SELECTION_TRIGGER_LABELS = Object.freeze({
  TARGET_TRIGGER_METADATA_INCOMPLETE: 'Chưa đủ metadata trigger; cần đọc lại đích', TARGET_TRIGGER_SCHEMA_MISMATCH: 'Schema trigger chưa khớp database đích',
  TARGET_TRIGGER_DUPLICATE_METADATA: 'Tên hoặc thứ tự trigger bị trùng trong metadata', TARGET_TRIGGER_TABLE_NOT_OBSERVED: 'Chưa xác nhận bảng gắn trigger',
  TARGET_TRIGGER_DEFINITION_UNKNOWN: 'Chưa quan sát được định nghĩa trigger trong giới hạn', TARGET_TRIGGER_CONTEXT_UNKNOWN: 'Chưa quan sát được ngữ cảnh tạo trigger',
  TARGET_TRIGGER_REPORT_LIMIT: 'Báo cáo trigger bị giới hạn', TARGET_TRIGGERS_REQUIRE_REVIEW: 'Trigger đích cần kiểm chứng trước phục hồi',
  TARGET_TRIGGER_EFFECTS_NOT_VALIDATED: 'Chưa phân tích nội dung và tác động gián tiếp của trigger', TARGET_TRIGGER_VISIBILITY_NOT_PROVEN: 'Metadata trong quyền tài khoản không chứng minh không có trigger',
  TARGET_TRIGGER_RECHECK_REQUIRED: 'Phải đọc lại trigger sát lúc ghi'
});

function backupSelectionTargetTriggersHtml(review) {
  if (review?.version !== 1) return '<p>Chưa có báo cáo trigger; cần kiểm tra lại metadata đích.</p>';
  const label = code => esc(BACKUP_SELECTION_TRIGGER_LABELS[code] || code);
  return `<details class="backup-selection-triggers"><summary>Trigger ở đích · Chỉ xem trước</summary>
    <p>${Number(review.totals.observed)} định nghĩa quan sát được · ${Number(review.totals.unknown)} chưa đủ căn cứ · ${Number(review.totals.insert)} trigger INSERT thấy được. Chưa thấy không chứng minh không có trigger.</p>
    <p>Chỉ quan sát metadata, chưa phân tích tác động hoặc bảo đảm rollback. Không hiển thị hoặc thực thi nội dung trigger hay tài khoản DEFINER. Ngữ cảnh tạo đã quan sát cũng chưa chứng minh tương thích phiên phục hồi.</p>
    <ul>${[...review.findings, ...review.requires].map(label).map(text => `<li>${text}</li>`).join('')}</ul>
    <div class="backup-selection-table"><table><thead><tr><th>Bảng / Trigger</th><th>Sự kiện / Thứ tự</th><th>Định nghĩa / Ngữ cảnh</th><th>Đánh giá</th></tr></thead><tbody>${review.rows.slice(0, 100).map(row => `<tr><td>${esc(row.table)} · ${esc(row.name)}</td><td>${esc(row.timing || 'Chưa rõ')} ${esc(row.event)} · ${Number.isSafeInteger(row.actionOrder) ? row.actionOrder : '?'}</td><td>${row.definitionObserved ? 'Đã quan sát' : 'Chưa rõ'} / ${row.contextObserved ? 'Đã quan sát' : 'Chưa rõ'}</td><td>${label(row.reason)}</td></tr>`).join('') || '<tr><td colspan="4">Chưa thấy trong metadata đọc được.</td></tr>'}</tbody></table></div>
    ${review.truncated || review.rows.length > 100 ? '<p>Chỉ hiện tối đa 100 trigger; giảm phạm vi để xem đầy đủ.</p>' : ''}</details>`;
}

function backupSelectionTargetEnginesHtml(rows) {
  const reason = review => review?.version !== 1 || review.status !== 'observed' ? 'Chưa đủ metadata engine'
    : review.engine === 'InnoDB' && review.reason === 'TARGET_ENGINE_INNODB_OBSERVED' ? 'Đã quan sát InnoDB; cần kiểm tra lại trước khi ghi'
      : 'Engine ngoài phạm vi phục hồi chọn bảng hiện tại';
  return `<details class="backup-selection-engines"><summary>Storage engine bảng đích</summary>
    <p>Đây là quan sát metadata. InnoDB chưa bảo đảm rollback toàn bộ: còn trigger, tác động gián tiếp và DDL cần kiểm chứng. Chưa thực thi phục hồi.</p>
    <div class="backup-selection-table"><table><thead><tr><th>Bảng</th><th>Engine quan sát</th><th>Đánh giá</th></tr></thead><tbody>${rows.slice(0, 100).map(row => {
      const review = row.engineReview;
      return `<tr><td>${esc(row.name)}</td><td>${esc(review?.version === 1 && review.status === 'observed' ? review.engine : 'Chưa xác định')}</td><td>${esc(reason(review))}</td></tr>`;
    }).join('')}</tbody></table></div>${rows.length > 100 ? '<p>Chỉ hiện 100 bảng; giảm phạm vi để xem đầy đủ.</p>' : ''}</details>`;
}

function backupSelectionTargetHtml(review) {
  if (!review) return '';
  const labels = { ...BACKUP_SELECTION_EXPRESSION_LABELS, ...BACKUP_SELECTION_TRIGGER_LABELS, ACCOUNT_VISIBLE_METADATA_ONLY: 'Chỉ thấy metadata trong quyền tài khoản; kết quả trống không chứng minh đối tượng không tồn tại',
    TARGET_RECHECK_REQUIRED: 'Phải đọc lại đích sát lúc chạy; đây chưa phải xác nhận thực thi', TARGET_METADATA_NOT_ATOMIC: 'Metadata được đọc qua nhiều truy vấn, có thể thay đổi giữa các lần đọc',
    SOURCE_SQL_EFFECTS_NOT_VALIDATED: 'Chưa chứng minh tác động của toàn bộ SQL nguồn', TARGET_CASE_POLICY_UNKNOWN: 'Chưa đọc được chính sách hoa/thường của máy chủ',
    TARGET_DATABASE_NOT_VISIBLE: 'Không thấy database đích; có thể chưa có hoặc thiếu quyền', TARGET_METADATA_ERROR: 'Có phần metadata chưa đọc được',
    TARGET_ENGINE_NOT_REVIEWED: 'Chưa xác định engine bảng đích; chặn bản nháp ghi dữ liệu', TARGET_ENGINE_UNSUPPORTED: 'Engine bảng đích ngoài phạm vi phục hồi chọn bảng hiện tại',
    TARGET_METADATA_TRUNCATED: 'Metadata vượt giới hạn đọc', TARGET_INDEXES_REQUIRE_REVIEW: 'Chưa đủ bằng chứng chỉ mục đích; cần đối chiếu thêm', TARGET_FOREIGN_KEYS_REQUIRE_REVIEW: 'Chưa đủ metadata FK đích; cần kiểm tra lại', TARGET_AMBIGUOUS_OBJECT: 'Tên đối tượng đích chưa phân biệt được chắc chắn',
    TARGET_VIEW_CONFLICT: 'Tên bảng được chọn trùng view ở đích', TARGET_STRUCTURE_CONFLICT: 'Cấu trúc được chọn trùng bảng đã có ở đích',
    TARGET_DATA_TABLE_NOT_VISIBLE: 'Chọn dữ liệu nhưng chưa thấy bảng đích', TARGET_DATA_SCHEMA_NOT_VALIDATED: 'Chưa xác nhận đầy đủ khả năng ghi giá trị vào cấu trúc đích',
    TARGET_TRIGGERS_PRESENT: 'Bảng đích có trigger, ghi dữ liệu có thể tác động gián tiếp', TARGET_FOREIGN_KEYS_PRESENT: 'Có khóa ngoại liên quan ở đích',
    TARGET_CHECKS_PRESENT: 'Bảng đích có CHECK; cần kiểm chứng dữ liệu trước phục hồi', TARGET_CHECKS_REQUIRE_REVIEW: 'Chưa đủ metadata CHECK đích', TARGET_CHECK_REPORT_LIMIT: 'Báo cáo CHECK bị giới hạn',
    TARGET_CHECK_SESSION_DISABLED: 'Phiên đích đang tắt check_constraint_checks', TARGET_CHECK_SESSION_NOT_REVIEWED: 'Chưa xác định trạng thái kiểm tra CHECK của phiên đích',
    TARGET_INBOUND_FK_FROM_UNSELECTED_TABLE: 'Có bảng ngoài lựa chọn tham chiếu vào bảng đích', SOURCE_DROP_REQUIRES_EXPLICIT_POLICY: 'Tệp nguồn có DROP, chưa có chính sách chấp thuận thay/xóa đối tượng',
    SOURCE_SCHEMA_MAPPING_NOT_VALIDATED: 'Database nguồn và đích khác nhau; chưa kiểm chứng ánh xạ schema ghi rõ trong SQL' };
  return `<section class="backup-target-review"><h3>Đối chiếu đích: ${esc(review.database)}</h3>
    <p>Máy chủ ${esc(review.serverVersion || 'chưa xác định')} · ${esc(new Date(review.checkedAt).toLocaleString('vi-VN'))}. Kiểm tra metadata một phần, chưa thực thi phục hồi.</p>
    <p>Mã đối chiếu snapshot (không phải quyền chạy): <code>${esc(review.snapshotId)}</code></p>
    <ul>${review.findings.map(item => `<li>${esc(labels[item.code] || item.code)}${item.table ? ` · ${esc(item.table)}` : ''}${item.detail ? ` · ${esc(item.detail)}` : ''}</li>`).join('')}</ul>
    ${review.findingsTruncated ? '<p>Còn cảnh báo ngoài giới hạn 100 mục; hãy giảm phạm vi để đối chiếu.</p>' : ''}
    <div class="backup-selection-table"><table><thead><tr><th>Bảng chọn</th><th>Đối tượng thấy ở đích</th><th>Trigger thấy ở đích</th></tr></thead><tbody>${review.rows.map(row => `<tr><td>${esc(row.name)}</td><td>${row.objects.map(object => `${esc(object.type)}: ${esc(object.name)}`).join(', ') || 'Chưa thấy'}${row.objectCount > row.objects.length ? ` · Chỉ hiện ${row.objects.length}/${Number(row.objectCount)}` : ''}</td><td>${row.triggers.map(trigger => `${esc(trigger.name)} (${esc(trigger.event)})`).join(', ') || 'Chưa thấy'}${row.triggerCount > row.triggers.length ? ` · Chỉ hiện ${row.triggers.length}/${Number(row.triggerCount)}` : ''}</td></tr>`).join('')}</tbody></table></div>
    ${backupSelectionTargetEnginesHtml(review.rows)}${backupSelectionTargetExpressionsHtml(review.targetExpressionReview)}${backupSelectionTargetTriggersHtml(review.targetTriggerReview)}${backupSelectionTargetChecksHtml(review.targetCheckReview)}${backupSelectionTargetForeignKeysHtml(review.targetForeignKeyReview)}${review.rows.map(row => backupSelectionColumnsHtml(row) + backupSelectionTargetIndexesHtml(row)).join('')}</section>`;
}

function backupSelectionDriftHtml(report) {
  const labels = { baseline: 'Đã ghi nhận mốc so sánh trong hộp thoại này. Kiểm tra đích lần nữa để đối chiếu.',
    changed: 'Có thay đổi kể từ lần kiểm tra thành công gần nhất.', unchanged: 'Chưa thấy thay đổi trong tệp và metadata đã quan sát.',
    unknown: 'Chưa đủ thông tin để so sánh hai lần kiểm tra.', 'different-scope': 'Phạm vi khác nhau; bắt đầu mốc so sánh mới.',
    'different-version': 'Phiên bản báo cáo khác nhau; bắt đầu mốc so sánh mới.' };
  if (!report || report.version !== 1) return '';
  return `<section class="backup-selection-drift"><h3>So sánh lần kiểm tra</h3><p>${esc(labels[report.status] || labels.unknown)}</p>
    ${['changed', 'unchanged'].includes(report.status) ? `<ul><li>Tệp backup: ${report.sourceChanged ? 'đã thay đổi' : 'chưa thấy thay đổi'}</li><li>Metadata/ngữ cảnh đích đã quan sát: ${report.metadataChanged ? 'đã thay đổi' : 'chưa thấy thay đổi'}</li><li>Bản nháp kế hoạch: ${report.planChanged ? 'đã thay đổi' : 'chưa thấy thay đổi'}</li></ul>` : ''}
    <p class="hint">Chỉ so dấu vân tay từ hai lượt đọc mới, không theo dõi dữ liệu dòng hoặc thay đổi ngoài phạm vi/quota. Chưa xác nhận dữ liệu đích không đổi hoặc đủ điều kiện phục hồi; vẫn phải kiểm tra lại sát lúc ghi.</p></section>`;
}

async function showBackupSelectionPreview() {
  const profileId = app.connection?.id;
  const database = app.database;
  const id = app.selectedBackupId;
  if (!profileId || !database || !id) return;
  modal(`<section id="backupSelectionEditor"><h2>Xem phạm vi chọn bảng</h2><p>${esc(app.connection?.name || profileId)} · ${esc(database)} · ${esc(id)}</p>
    <div class="backup-selection-body" role="region" aria-label="Nội dung xem trước phạm vi bảng" tabindex="0">
    <p class="hint">Chọn bảng để đọc phạm vi SQL nguồn; có thể kiểm tra metadata đích bằng phiên riêng chỉ đọc. Chưa thực thi phục hồi từng bảng. Khóa ngoại nguồn chỉ được phân tích từ CREATE TABLE; các phụ thuộc khác chưa đầy đủ. Lựa chọn ở đây không thay đổi nút Phục hồi toàn bộ hiện có.</p>
    <p id="backupSelectionStatus" role="status" aria-live="polite">Đang đọc tệp SQL…</p>
    <button id="cancelSelectionScan">Hủy quét</button>
    <div id="backupSelectionForm" hidden>
      <fieldset><legend>Bảng có trong tệp SQL</legend><div id="backupSelectionTables" class="backup-object-list"></div></fieldset>
      <label class="checkline"><input id="selectionStructure" type="checkbox" checked> Xem phần cấu trúc (CREATE/DROP)</label>
      <label class="checkline"><input id="selectionData" type="checkbox" checked> Xem phần ghi dữ liệu (số câu INSERT, không phải số dòng)</label>
      <button id="previewBackupSelection" class="primary">Xem phạm vi (Ctrl+Enter)</button>
      <label for="selectionTargetDatabase">Database đích trên cùng kết nối</label><input id="selectionTargetDatabase" value="${esc(database)}" maxlength="64" autocomplete="off">
      <label for="selectionConflictPolicy">Chính sách xung đột (chỉ xem trước)</label><select id="selectionConflictPolicy"><option value="stop-on-conflict">Chặn khi trùng cấu trúc</option><option value="skip-existing">Bỏ qua toàn bộ bảng đã thấy ở đích</option></select>
      <button id="reviewBackupSelectionTarget">Kiểm tra đích (chỉ đọc)</button>
    </div>
    <div id="backupSelectionResult" role="status" aria-live="polite"></div>
    </div><div class="actions"><button data-click="close-modal">Đóng</button></div></section>`, true);
  const editor = $('#backupSelectionEditor');
  const status = $('#backupSelectionStatus');
  const form = $('#backupSelectionForm');
  const list = $('#backupSelectionTables');
  const output = $('#backupSelectionResult');
  const button = $('#previewBackupSelection');
  const targetButton = $('#reviewBackupSelectionTarget');
  const targetInput = $('#selectionTargetDatabase');
  const policyInput = $('#selectionConflictPolicy');
  const cancel = $('#cancelSelectionScan');
  const structure = $('#selectionStructure');
  const data = $('#selectionData');
  let busy = true, generation = 0, taskId = newTransferTaskId('inspect-selection'), entries = [], reviewingTarget = false;
  let previousObservation = null;
  const matches = () => $('#backupSelectionEditor') === editor && app.connection?.id === profileId && app.database === database && app.selectedBackupId === id;
  cancel.addEventListener('click', async () => {
    if (!busy || !matches() || cancel.disabled) return;
    const canceledTaskId = taskId, canceledGeneration = generation;
    const current = () => matches() && busy && taskId === canceledTaskId && generation === canceledGeneration;
    previousObservation = null;
    cancel.disabled = true;
    try {
      const result = await call(reviewingTarget ? desktop.db.cancelTask(profileId, taskId) : desktop.db.cancelInspectBackup({ profileId, taskId }));
      if (current()) status.textContent = result.canceled ? 'Đã gửi yêu cầu hủy kiểm tra.' : 'Lượt kiểm tra đã kết thúc hoặc chưa bắt đầu; đang đợi kết quả.';
    } catch (error) { if (current()) status.textContent = error.message; }
    finally { if (matches() && taskId === canceledTaskId) cancel.disabled = false; }
  });
  const labels = { CONDITIONAL_CREATE: 'CREATE IF NOT EXISTS cần đối chiếu bảng đích', REPEATED_CREATE: 'Có nhiều CREATE cho cùng bảng',
    NON_TABLE_DEFINITION: 'Có đối tượng ngoài bảng; phụ thuộc chưa phân tích đầy đủ', UNSUPPORTED_TABLE_DEFINITION: 'Định nghĩa bảng nằm ngoài phạm vi phân tích',
    UNKNOWN_DEPENDENCY: 'Không phân tích được một phụ thuộc', UNSUPPORTED_STATEMENT: 'Có câu lệnh ngoài phạm vi xem trước chọn bảng',
    CASE_AMBIGUITY: 'Tên bảng khác nhau chỉ bởi hoa/thường; cần kiểm tra cấu hình đích', STRUCTURE_UNAVAILABLE: 'Không có đúng một CREATE cho bảng đã chọn',
    EXTERNAL_DEPENDENCY: 'Khóa ngoại tham chiếu database khác', MISSING_DEPENDENCY: 'Chưa chọn bảng được khóa ngoại tham chiếu',
    DEPENDENCY_NOT_IN_BACKUP: 'Bảng được khóa ngoại tham chiếu không có trong inventory', FK_CYCLE_OR_BLOCKED: 'Có vòng FK hoặc bảng bị phụ thuộc vào vòng FK',
    INVENTORY_TRUNCATED: 'Inventory vượt giới hạn, chưa đầy đủ', TARGET_STRUCTURE_NOT_CHECKED: 'Chọn dữ liệu: chưa kiểm tra cấu trúc và trigger ở đích',
    DEFINITION_LIMIT: 'Định nghĩa vượt giới hạn phân tích', EXECUTABLE_COMMENT: 'Có executable comment trong định nghĩa', DEFINITION_SYNTAX: 'Định nghĩa chưa phân tích được',
    DATA_DEPENDENCIES_NOT_ANALYZED: 'INSERT có SELECT; phụ thuộc dữ liệu chưa phân tích', SQL_MODE_CONTEXT: 'Tệp có SQL_MODE; cần đối chiếu chế độ phân tích trên server đích', SOURCE_COLUMNS_INCOMPLETE: 'Chưa đọc đầy đủ định nghĩa cột nguồn' };
  const preview = async (withTarget = false) => {
    if (busy || !matches() || !entries.length) return;
    const tables = [...list.querySelectorAll('input[data-selection-index]:checked')].map(input => entries[Number(input.dataset.selectionIndex)]?.name);
    if (!tables.length) { status.textContent = 'Hãy chọn ít nhất một bảng.'; return; }
    if (!structure.checked && !data.checked) { status.textContent = 'Hãy chọn cấu trúc hoặc dữ liệu.'; return; }
    const targetDatabase = targetInput.value;
    if (withTarget && (!targetDatabase || targetDatabase.length > 64 || targetDatabase.includes('\0'))) { status.textContent = 'Hãy nhập database đích hợp lệ (1–64 ký tự).'; targetInput.focus(); return; }
    const request = ++generation;
    taskId = newTransferTaskId('inspect-selection');
    reviewingTarget = withTarget;
    busy = true; button.disabled = targetButton.disabled = true; cancel.hidden = false; cancel.disabled = false;
    status.textContent = withTarget ? 'Đang quét lại tệp nguồn và đọc metadata đích bằng phiên riêng…' : 'Đang kiểm tra phạm vi lựa chọn…'; output.textContent = '';
    try {
      const api = withTarget ? 'previewBackupSelectionTarget' : 'previewBackupSelection';
      const payload = { profileId, database, id, taskId, tables,
        includeStructure: structure.checked, includeData: data.checked, ...(withTarget ? { targetDatabase, conflictPolicy: policyInput.value } : {}) };
      const result = await call(desktop.db[api](payload));
      if (!matches() || request !== generation) return;
      const observation = withTarget ? window.SqlRestoreReview.captureObservation(payload, result) : null;
      const drift = withTarget ? window.SqlRestoreReview.compareObservations(previousObservation, observation) : null;
      previousObservation = observation;
      status.textContent = withTarget ? 'Đã đối chiếu metadata đích một phần. Chưa ghi vào database.' : 'Đã xem phạm vi từ tệp nguồn. Chưa ghi vào database.';
      output.innerHTML = `${backupSelectionDriftHtml(drift)}${backupSelectionDraftHtml(result.draftPlan)}${backupSelectionTargetHtml(result.targetReview)}<p>${result.rows.length} bảng đã chọn · ${Number(result.totals.createStatements)} CREATE · ${Number(result.totals.dropStatements)} DROP trong tệp · ${Number(result.totals.dataStatements)} INSERT. Bỏ ngoài lựa chọn ${Number(result.excludedTables)} bảng; ${Number(result.excludedDefinitions)} định nghĩa ngoài bảng chưa được phân tích đầy đủ.</p>
        <p class="hint">Đây là số câu lệnh nguồn, không phải cam kết số dòng phục hồi. Biểu thức INSERT và trigger có thể có tác động gián tiếp; SQL nguồn chưa được chứng minh an toàn. Đối chiếu metadata đích nếu có chưa xác nhận đủ quyền, cấu trúc cột hay dung lượng để phục hồi. Chưa có thao tác thực thi từ bản xem trước này.</p>
        <p>SHA-256 nguồn${result.cached ? ' (inventory cache còn khớp file identity)' : ''}: <code>${esc(result.checksum)}</code></p>
        ${result.findings.length ? `<ul>${result.findings.map(item => `<li>${esc(labels[item.code] || item.code)}${item.table ? ` · ${esc(item.table)}` : ''}${item.dependency ? ` → ${esc(item.dependency)}` : ''}</li>`).join('')}</ul>` : '<p>Chưa phát hiện phụ thuộc FK thiếu trong các CREATE TABLE đã phân tích. Điều này chưa xác nhận phục hồi được.</p>'}
        ${result.findingsTruncated ? '<p>Có thêm cảnh báo ngoài giới hạn 100 mục hiển thị. Hãy giảm số bảng được chọn để xem chi tiết.</p>' : ''}
        <p>Thứ tự FK tham khảo (bảng được tham chiếu trước): ${result.order.map(esc).join(' → ') || 'Chưa xác định'}.</p>
        ${result.unresolvedOrder.length ? `<p>Chưa xếp được: ${result.unresolvedOrder.map(esc).join(', ')}.</p>` : ''}
        <div class="backup-selection-table"><table><thead><tr><th>Bảng</th><th>CREATE / DROP / INSERT</th><th>FK tham chiếu</th></tr></thead><tbody>${result.rows.map(row => `<tr><td>${esc(row.name)}</td><td>${Number(row.createStatements)} / ${Number(row.dropStatements)} / ${Number(row.dataStatements)}</td><td>${row.dependencies.map(ref => esc(`${ref.schema ? `${ref.schema}.` : ''}${ref.table}`)).join(', ') || 'Chưa phát hiện'}</td></tr>`).join('')}</tbody></table></div>`;
    } catch (error) { if (matches() && request === generation) { previousObservation = null; status.textContent = error.message; } }
    finally { busy = false; reviewingTarget = false; if (matches()) { button.disabled = targetButton.disabled = false; cancel.hidden = true; } }
  };
  form.addEventListener('change', () => { generation++; previousObservation = null; output.textContent = ''; status.textContent = 'Lựa chọn đã đổi. Hãy xem phạm vi lại.'; });
  targetInput.addEventListener('input', () => { generation++; previousObservation = null; output.textContent = ''; status.textContent = 'Đích đã đổi. Hãy kiểm tra lại.'; });
  button.addEventListener('click', () => preview());
  targetButton.addEventListener('click', () => preview(true));
  editor.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void preview(); }
  });
  try {
    const result = await call(desktop.db.inspectBackup({ profileId, database, id, taskId }));
    if (!matches()) return;
    const inventory = result.selectionPreview;
    if (!inventory || inventory.version !== 1 || !Array.isArray(inventory.tables)) throw new Error('Chưa có inventory chọn bảng. Hãy đóng và quét lại sau khi cập nhật ứng dụng.');
    entries = inventory.tables;
    list.innerHTML = entries.map((entry, index) => `<label class="checkline"><input type="checkbox" data-selection-index="${index}"> ${esc(entry.name)}</label>`).join('');
    form.hidden = !entries.length;
    status.textContent = entries.length ? `Đã đọc ${entries.length} bảng${inventory.truncated ? '; inventory chưa đầy đủ do vượt giới hạn' : ''}. Chọn bảng để xem phạm vi.` : 'Không tìm thấy bảng trong phạm vi phân tích. Chưa hỗ trợ chọn view/routine/trigger/event.';
    list.querySelector('input')?.focus();
  } catch (error) { if (matches()) status.textContent = error.message; }
  finally { busy = false; if (matches()) cancel.hidden = true; }
}

async function showBackupSchedule() {
  const profileId = app.connection?.id;
  const database = app.database;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const localInput = date => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  modal(`<section id="backupScheduleEditor"><h2>Lịch backup</h2><p>${esc(app.connection?.name || profileId || '')} · ${esc(database || '')}</p>
    <p>Sao lưu cấu trúc và dữ liệu của toàn bộ bảng, view, routine và event mà tài khoản nhìn thấy bằng phiên riêng, vào catalog trên máy này. Chính sách tự dọn đã bật sẽ áp dụng sau khi backup thành công.</p>
    <label for="backupScheduleMode">Kiểu lịch</label><select id="backupScheduleMode"><option value="interval">Theo chu kỳ giờ</option><option value="daily">Hằng ngày theo múi giờ</option></select>
    <label for="backupScheduleTime">Giờ hằng ngày (HH:mm)</label><input id="backupScheduleTime" type="time" value="02:00" disabled>
    <label for="backupScheduleZone">Múi giờ IANA</label><input id="backupScheduleZone" value="${esc(timeZone)}" maxlength="100" disabled>
    <label for="backupScheduleHours">Chu kỳ (giờ trôi qua, 1–168)</label><input id="backupScheduleHours" type="number" min="1" max="168" step="1" value="24">
    <label for="backupScheduleStart">Lần chạy đầu (${esc(timeZone)})</label><input id="backupScheduleStart" type="datetime-local" value="${localInput(new Date(Date.now() + 3600000))}">
    <p class="hint">Lịch chu kỳ tính theo số giờ trôi qua, không cố định giờ địa phương khi đổi DST. Quá hạn 60 giây do đóng app, sleep hoặc tác vụ khác sẽ được ghi nhận bỏ lỡ; không chạy bù và không tự retry. Tối đa một tác vụ database cùng lúc.</p>
    <p>Lịch hằng ngày dùng múi giờ đã chọn: giờ không tồn tại khi đổi DST được bỏ qua; giờ lặp có thể chạy hai lần. Chỉ chạy khi app mở; không chạy bù hoặc tự retry.</p>
    <div id="backupScheduleState" role="status" aria-live="polite">Đang đọc lịch…</div>
    <p id="backupScheduleMessage" role="status" aria-live="polite"></p>
    <div class="actions"><button data-click="close-modal">Đóng</button><button id="refreshBackupSchedule" disabled>Cập nhật trạng thái</button><button id="pauseBackupSchedule" disabled>Tạm dừng lịch</button><button id="deleteBackupSchedule" disabled>Xóa lịch</button><button id="saveBackupSchedule" class="primary" disabled>Lưu và bật lịch (Ctrl+Enter)</button></div></section>`, true);
  const editor = $('#backupScheduleEditor');
  const state = $('#backupScheduleState');
  const message = $('#backupScheduleMessage');
  const hours = $('#backupScheduleHours');
  const timing = $('#backupScheduleMode'), dailyTime = $('#backupScheduleTime'), zone = $('#backupScheduleZone');
  const start = $('#backupScheduleStart');
  const save = $('#saveBackupSchedule');
  const pause = $('#pauseBackupSchedule');
  const remove = $('#deleteBackupSchedule');
  const refresh = $('#refreshBackupSchedule');
  let busy = false, loaded = false, schedule = null, edited = false;
  const matches = () => $('#backupScheduleEditor') === editor && app.connection?.id === profileId && app.database === database;
  const controls = () => {
    save.disabled = busy || !loaded;
    pause.disabled = busy || !loaded || !schedule?.enabled;
    remove.disabled = busy || !loaded || !schedule;
    refresh.disabled = busy;
    const daily = timing.value === 'daily';
    timing.disabled = busy;
    hours.disabled = start.disabled = busy || daily;
    dailyTime.disabled = zone.disabled = busy || !daily;
  };
  const renderState = result => {
    schedule = result.schedule;
    if (!schedule) { state.textContent = 'Chưa có lịch cho database này.'; return; }
    const labels = { running: 'Đang chạy', completed: 'Đã lưu backup', failed: 'Có lỗi', canceled: 'Đã hủy',
      missed: 'Bỏ lỡ do quá hạn', busy: 'Bỏ lỡ do có tác vụ khác', incomplete: 'Lần chạy trước bị gián đoạn' };
    const warnings = { MANIFEST_WRITE_FAILED: 'Manifest chưa ghi thành công; cần xác minh backup', RETENTION_FAILED: 'Tự dọn có lỗi',
      RETENTION_STOPPED: 'Tự dọn đã dừng', RETENTION_SKIPPED: 'Đã bỏ qua tự dọn', RETENTION_HISTORY_FAILED: 'Lịch sử dọn chưa lưu đầy đủ' };
    const format = value => new Intl.DateTimeFormat('vi-VN', { timeZone: schedule.timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
    const run = schedule.lastRun;
    state.innerHTML = `<p>${schedule.enabled ? 'Lịch đã bật' : 'Lịch đã tạm dừng'} · ${schedule.mode === 'daily' ? `Hằng ngày ${esc(schedule.timeOfDay)}` : `Mỗi ${esc(schedule.intervalHours)} giờ`} · Lần kế tiếp: ${esc(format(schedule.nextRunAt))} (${esc(schedule.timeZone)})</p>
      ${result.paused ? '<p class="errorbox">Bộ chạy lịch đang dừng trên phiên ứng dụng này. Lưu và bật lại để tiếp tục.</p>' : ''}
      ${schedule.targetMatches === false ? '<p class="errorbox">Đích kết nối đã thay đổi. Hãy kiểm tra kết nối và lưu lại lịch trước khi chạy tiếp.</p>' : ''}
      ${run ? `<p>Lần gần nhất: ${esc(labels[run.status] || run.status)} · Theo lịch ${esc(format(run.scheduledFor))}${run.backupId ? ` · ${esc(run.backupId)}` : ''}${run.errorCode ? ` · ${esc(run.errorCode)}` : ''}</p>` : '<p>Chưa có lần chạy được ghi nhận.</p>'}
      ${run?.warnings?.length ? `<p class="errorbox">${run.warnings.map(code => esc(warnings[code] || code)).join(' · ')}. Xem chi tiết trong catalog và lịch sử dọn.</p>` : ''}
      ${result.schedulerError ? `<p class="errorbox">Lỗi bộ chạy lịch: ${esc(result.schedulerError)}</p>` : ''}`;
  };
  const load = async (initial = false) => {
    if (busy || !matches()) return;
    busy = true; controls();
    try {
      const result = await call(desktop.db.getBackupSchedule({ profileId, database }));
      if (!matches()) return;
      renderState(result); loaded = true;
      if (initial && schedule && !edited) {
        timing.value = schedule.mode || 'interval';
        dailyTime.value = schedule.timeOfDay || '02:00';
        zone.value = schedule.timeZone;
        hours.value = String(schedule.intervalHours || 24);
        start.value = localInput(new Date(schedule.nextRunAt));
      }
    } catch (error) { if (matches()) message.textContent = error.message; }
    finally { busy = false; if (matches()) controls(); }
  };
  const mutate = async action => {
    if (busy || !loaded || !matches()) return;
    if (action === 'pause' && !schedule?.enabled || action === 'delete' && !schedule) return;
    let payload = { profileId, database };
    if (action === 'save') {
      const intervalHours = Number(hours.value);
      const next = new Date(start.value);
      if (timing.value !== 'daily' && (!Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 168 || !hours.validity.valid)) {
        message.textContent = 'Chu kỳ phải là số nguyên từ 1 đến 168 giờ.'; hours.focus(); return;
      }
      if (timing.value !== 'daily' && (!start.value || !start.validity.valid || !Number.isFinite(next.getTime()) || next.getTime() <= Date.now())) {
        message.textContent = 'Hãy chọn lần chạy đầu trong tương lai.'; start.focus(); return;
      }
      if (timing.value === 'daily') {
        if (!/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(dailyTime.value)) { message.textContent = 'Hãy nhập giờ HH:mm hợp lệ.'; dailyTime.focus(); return; }
        try { new Intl.DateTimeFormat('vi-VN', { timeZone: zone.value }).format(0); }
        catch { message.textContent = 'Múi giờ IANA không hợp lệ.'; zone.focus(); return; }
        payload = { ...payload, mode: 'daily', timeOfDay: dailyTime.value, timeZone: zone.value };
      } else payload = { ...payload, intervalHours, nextRunAt: next.toISOString(), timeZone };
    }
    busy = true; controls(); message.textContent = 'Đang xử lý…';
    try {
      const api = { save: 'saveBackupSchedule', pause: 'pauseBackupSchedule', delete: 'deleteBackupSchedule' }[action];
      const result = await call(desktop.db[api](payload));
      if (!matches()) return;
      if (result.canceled) { message.textContent = 'Đã hủy lưu lịch; nội dung nhập được giữ lại.'; return; }
      if (action === 'save') renderState({ schedule: result.schedule, paused: false });
      else if (action === 'delete') renderState({ schedule: null });
      else renderState({ schedule: { ...schedule, enabled: false } });
      message.textContent = { save: 'Đã lưu và bật lịch backup.', pause: 'Đã tạm dừng lịch. Nếu đang backup, yêu cầu hủy đã được gửi; cập nhật trạng thái để xem kết quả.', delete: 'Đã xóa lịch. Các tệp backup vẫn được giữ.' }[action];
    } catch (error) { if (matches()) message.textContent = error.message; }
    finally { busy = false; if (matches()) controls(); }
  };
  timing.addEventListener('change', () => { edited = true; controls(); });
  dailyTime.addEventListener('input', () => { edited = true; });
  zone.addEventListener('input', () => { edited = true; });
  hours.addEventListener('input', () => { edited = true; });
  start.addEventListener('input', () => { edited = true; });
  save.addEventListener('click', () => mutate('save'));
  pause.addEventListener('click', () => mutate('pause'));
  remove.addEventListener('click', () => mutate('delete'));
  refresh.addEventListener('click', () => load());
  editor.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void mutate('save'); }
  });
  await load(true);
  if (matches()) (timing.value === 'daily' ? dailyTime : hours).focus();
}

async function showBackupRetentionHistory() {
  const profileId = app.connection?.id;
  const database = app.database;
  modal(`<section id="retentionHistoryView"><h2>Lịch sử dọn backup</h2><p>${esc(app.connection?.name || profileId || '')} · ${esc(database || '')}</p>
    <p class="hint">Lưu tối đa 50 lượt trên máy này để đối chiếu. Lịch sử không khôi phục được các bản đã xóa và không phải log chống sửa đổi.</p>
    <div id="retentionHistoryResult" role="status" aria-live="polite">Đang đọc lịch sử…</div>
    <p id="retentionHistoryExportStatus" role="status" aria-live="polite"></p>
    <div class="actions"><button data-click="close-modal">Đóng</button><button id="exportRetentionHistoryBtn" disabled>Xuất báo cáo JSON…</button></div></section>`, true);
  const output = $('#retentionHistoryResult');
  const exportButton = $('#exportRetentionHistoryBtn');
  const exportStatus = $('#retentionHistoryExportStatus');
  const matches = () => $('#retentionHistoryResult') === output && app.connection?.id === profileId && app.database === database;
  let exporting = false;
  exportButton.addEventListener('click', async () => {
    if (exporting || exportButton.disabled) return;
    if (!matches()) { exportStatus.textContent = 'Kết nối hoặc database đã thay đổi. Hãy mở lại lịch sử.'; return; }
    exporting = true; exportButton.disabled = true;
    exportStatus.textContent = 'Đang chọn nơi lưu báo cáo…';
    try {
      const result = await call(desktop.db.exportBackupRetentionHistory({ profileId, database }));
      if (!matches()) return;
      exportStatus.textContent = result.canceled ? 'Đã hủy xuất báo cáo.' : `Đã xuất ${result.records} lượt lịch sử. Báo cáo lấy trạng thái tại thời điểm lưu; tác vụ đang chạy có thể chưa có đủ kết quả.`;
    } catch (error) { if (matches()) exportStatus.textContent = error.message; }
    finally { exporting = false; exportButton.disabled = false; }
  });
  try {
    const records = await call(desktop.db.backupRetentionHistory({ profileId, database }));
    if (!matches()) return;
    const labels = { running: 'Đang chạy', completed: 'Hoàn tất', stopped: 'Đã dừng', failed: 'Có lỗi', incomplete: 'Chưa xác nhận kết thúc' };
    output.innerHTML = records.map(record => `<details class="backup-retention-history"><summary>${esc(new Date(record.startedAt).toLocaleString('vi-VN'))} · ${esc(labels[record.state] || record.state)} · Đã ghi nhận xóa ${record.deleted.length}/${record.planned.length} bản</summary>
      ${record.state === 'incomplete' ? '<p class="errorbox">Báo cáo chưa hoàn tất hoặc ứng dụng đã bị gián đoạn. Số bản hiển thị có thể chưa phản ánh các lần xóa đã thực hiện; hãy đối chiếu catalog. Không tự tiếp tục xóa.</p>' : ''}
      ${record.state === 'running' ? '<p class="hint">Tác vụ vẫn đang chạy. Kết quả chi tiết sẽ có sau khi kết thúc; mở lại lịch sử để cập nhật.</p>' : ''}
      <p>${record.mode === 'automatic' ? `Tự dọn sau backup ${esc(record.triggerBackupId || '')}` : 'Dọn thủ công'}</p>
      ${['running', 'incomplete'].includes(record.state) ? `<h4>Danh sách dự kiến (${record.planned.length})</h4><ul>${record.planned.map(id => `<li>${esc(id)}</li>`).join('')}</ul>` : ''}
      <p>Dung lượng SQL đã ghi nhận: ${formatBytes(record.reclaimedBytes)}${record.finishedAt ? ` · Kết thúc: ${esc(new Date(record.finishedAt).toLocaleString('vi-VN'))}` : ''}</p>
      <p>Giới hạn: ${record.policy.maxCount === null ? 'Không giới hạn số bản' : `${esc(record.policy.maxCount)} bản`} · ${record.policy.maxAgeDays === null ? 'Không giới hạn tuổi' : `${esc(record.policy.maxAgeDays)} ngày`} · ${record.policy.maxBytes === null ? 'Không giới hạn dung lượng' : formatBytes(record.policy.maxBytes)}</p>
      <h4>Đã xóa (${record.deleted.length})</h4><ul>${record.deleted.map(id => `<li>${esc(id)}</li>`).join('') || '<li>Chưa ghi nhận</li>'}</ul>
      <h4>Chưa xóa (${record.remaining.length})</h4><ul>${record.remaining.map(id => `<li>${esc(id)}</li>`).join('') || '<li>Không có bản được ghi nhận trong danh sách này</li>'}</ul>
      ${record.failed.length ? `<h4>Lỗi</h4><ul>${record.failed.map(error => `<li>${esc(error.id)} · ${esc(error.code)}${error.sqlDeleted ? ' · SQL đã xóa, cần kiểm tra metadata còn sót' : ''}</li>`).join('')}</ul>` : ''}</details>`).join('') || '<p>Chưa có lịch sử dọn backup cho database này.</p>';
    exportButton.disabled = false;
  } catch (error) { if (matches()) output.textContent = error.message; }
}

function previewBackupRetention() {
  const profileId = app.connection?.id;
  const database = app.database;
  modal(`<section id="backupRetentionEditor"><h2>Xem trước dọn backup</h2>
    <p>${esc(app.connection?.name || profileId || '')} · ${esc(database || '')}</p>
    <p>Nhập ít nhất một giới hạn. Công cụ đề xuất các bản cũ nhất để đáp ứng đồng thời các giới hạn, luôn giữ bản ghim, bản mới nhất và bản mới nhất đã xác minh checksum.</p>
    <label for="retentionCount">Số bản tối đa</label><input id="retentionCount" type="number" min="1" max="100000" step="1" value="10">
    <label for="retentionAge">Tuổi tối đa (ngày)</label><input id="retentionAge" type="number" min="1" max="36500" step="1" placeholder="Không giới hạn">
    <label for="retentionMiB">Tổng dung lượng tối đa (MiB)</label><input id="retentionMiB" type="number" min="0.00000095367431640625" max="8589934591" step="any" placeholder="Không giới hạn">
    <label class="checkline"><input id="retentionAutomatic" type="checkbox"> Tự dọn sau khi backup mới thành công</label>
    <p class="hint">Chỉ dọn bản cùng nguồn và cùng phạm vi lựa chọn với backup mới, giữ bản ghim. Bật tính năng cần xác nhận riêng; các lần backup sau sẽ tự áp dụng trên máy này. Xóa không thể hoàn tác.</p>
    <p class="hint">Xem trước không xóa tệp. Nút Dọn yêu cầu xác nhận riêng và kiểm tra lại backup. Dung lượng chỉ tính SQL; checksum không thay thế phục hồi thử.</p>
    <p id="backupRetentionPolicyStatus" role="status" aria-live="polite">Đang đọc chính sách đã lưu…</p>
    <div class="actions"><button data-click="close-modal">Đóng</button><button id="saveRetentionPolicyBtn" disabled>Lưu chính sách</button><button id="clearRetentionPolicyBtn" disabled>Xóa chính sách đã lưu</button><button id="previewRetentionBtn" class="primary">Xem trước (Ctrl+Enter)</button></div>
    <button id="applyRetentionBtn" class="danger" disabled>Dọn các bản đã xem trước…</button>
    <button id="stopRetentionBtn" disabled hidden>Dừng dọn backup</button>
    <p id="retentionTaskStatus" role="status" aria-live="polite"></p>
    <div id="backupRetentionResult" role="status" aria-live="polite"></div></section>`, true);
  const editor = $('#backupRetentionEditor');
  const output = $('#backupRetentionResult');
  const button = $('#previewRetentionBtn');
  const inputs = [$('#retentionCount'), $('#retentionAge'), $('#retentionMiB')];
  const automatic = $('#retentionAutomatic');
  const controls = [...inputs, automatic];
  const policyStatus = $('#backupRetentionPolicyStatus');
  const saveButton = $('#saveRetentionPolicyBtn');
  const clearButton = $('#clearRetentionPolicyBtn');
  const applyButton = $('#applyRetentionBtn');
  const stopButton = $('#stopRetentionBtn');
  const taskStatus = $('#retentionTaskStatus');
  let retentionTaskId = null;
  let stopRequested = false;
  let currentPlan = null;
  let generation = 0;
  let busy = false;
  let policyBusy = false;
  let policyLoaded = false;
  let hasSavedPolicy = false;
  const labels = { pinned: 'Đã ghim', active: 'Đang được dùng', newest: 'Bản mới nhất',
    'latest-verified': 'Bản mới nhất đã xác minh checksum', 'metadata-error': 'Metadata lỗi',
    'invalid-date': 'Ngày tạo không hợp lệ hoặc trong tương lai', 'invalid-size': 'Dung lượng không hợp lệ',
    'checksum-mismatch': 'Checksum không khớp — cần kiểm tra', age: 'Quá tuổi', count: 'Vượt số bản', bytes: 'Vượt dung lượng' };
  const warningLabels = { 'no-verified-backup': 'Chưa có bản ghi thành công và checksum đã xác minh: chưa đề xuất dọn. Hãy xác minh backup trước.',
    'unknown-size': 'Có bản chưa xác định dung lượng; tổng hiển thị chưa gồm các bản này.',
    'count-unmet': 'Chưa đạt giới hạn số bản vì có bản được bảo vệ.',
    'bytes-unmet': 'Chưa đạt giới hạn dung lượng vì có bản được bảo vệ.',
    'age-unmet': 'Còn bản quá tuổi được giữ lại.' };
  const contextMatches = () => $('#backupRetentionResult') === output && app.connection?.id === profileId && app.database === database;
  controls.forEach(input => input.addEventListener('input', () => {
    currentPlan = null; applyButton.disabled = true;
    generation++; output.textContent = 'Giới hạn đã thay đổi. Hãy xem trước lại.';
  }));
  const readInputPolicy = () => {
    const values = inputs.map(input => {
      if (!input.validity.valid) throw new Error('Số bản/ngày phải là số nguyên dương; dung lượng phải tương ứng số byte nguyên.');
      return input.value === '' ? null : Number(input.value);
    });
    const policy = { maxCount: values[0], maxAgeDays: values[1], maxBytes: values[2] === null ? null : values[2] * 1048576 };
    if (Object.values(policy).every(value => value === null)
        || Object.values(policy).some(value => value !== null && (!Number.isSafeInteger(value) || value < 1))) throw new Error('Hãy nhập ít nhất một giới hạn hợp lệ, dung lượng tương ứng số byte nguyên.');
    return policy;
  };
  const setInputPolicy = policy => {
    inputs[0].value = policy?.maxCount ?? (policy ? '' : '10');
    inputs[1].value = policy?.maxAgeDays ?? '';
    inputs[2].value = policy?.maxBytes === null || policy?.maxBytes === undefined ? '' : policy.maxBytes / 1048576;
  };
  const loadGeneration = generation;
  void (async () => {
    try {
      const saved = await call(desktop.db.getBackupRetentionPolicy({ profileId, database }));
      if (!contextMatches()) return;
      policyLoaded = true;
      hasSavedPolicy = Boolean(saved.policy);
      if (generation === loadGeneration) { setInputPolicy(saved.policy); automatic.checked = saved.automaticAfterBackup === true; }
      policyStatus.textContent = saved.policy ? `Có chính sách lưu cục bộ${generation !== loadGeneration ? '; giữ nguyên nội dung bạn đang nhập' : ''}. Tự dọn đã lưu: ${saved.automaticAfterBackup ? 'Bật' : 'Tắt'}.` : 'Chưa lưu chính sách cho database này.';
      saveButton.disabled = busy || policyBusy;
      clearButton.disabled = busy || policyBusy || !saved.policy;
    } catch (error) {
      if (contextMatches()) policyStatus.textContent = `Không đọc được chính sách: ${error.message}. Nội dung hiện tại vẫn có thể xem trước.`;
    }
  })();
  const changePolicy = async clear => {
    if (busy || policyBusy || !policyLoaded) return;
    if (!contextMatches()) { policyStatus.textContent = 'Kết nối hoặc database đã thay đổi. Hãy mở lại công cụ.'; return; }
    let policy;
    try { policy = clear ? null : readInputPolicy(); }
    catch (error) { policyStatus.textContent = error.message; return; }
    const request = ++generation;
    currentPlan = null; applyButton.disabled = true;
    const clearWasDisabled = clearButton.disabled;
    policyBusy = true;
    saveButton.disabled = clearButton.disabled = true;
    controls.forEach(input => { input.disabled = true; });
    try {
      const result = await call(clear
        ? desktop.db.clearBackupRetentionPolicy({ profileId, database })
        : desktop.db.saveBackupRetentionPolicy({ profileId, database, policy, automaticAfterBackup: automatic.checked }));
      if (!contextMatches() || request !== generation) return;
      if (result.canceled) { policyStatus.textContent = 'Đã hủy bật tự dọn. Chính sách cũ được giữ nguyên.'; clearButton.disabled = clearWasDisabled; return; }
      if (clear) setInputPolicy(null);
      automatic.checked = result.automaticAfterBackup === true;
      clearButton.disabled = !result.policy;
      hasSavedPolicy = Boolean(result.policy);
      policyStatus.textContent = clear ? 'Đã xóa chính sách lưu cục bộ. Backup được giữ nguyên.' : `Đã lưu chính sách cho database này. Tự dọn: ${result.automaticAfterBackup ? 'Bật' : 'Tắt'}.`;
      output.textContent = 'Hãy xem trước với giới hạn hiện tại.';
    } catch (error) {
      if (contextMatches() && request === generation) policyStatus.textContent = error.message;
      clearButton.disabled = clearWasDisabled;
    } finally {
      policyBusy = false;
      saveButton.disabled = false;
      controls.forEach(input => { input.disabled = false; });
    }
  };
  saveButton.addEventListener('click', () => changePolicy(false));
  clearButton.addEventListener('click', () => changePolicy(true));
  const preview = async () => {
    if (busy || policyBusy) return;
    if (!contextMatches()) { output.textContent = 'Kết nối hoặc database đã thay đổi. Hãy mở lại công cụ.'; return; }
    const request = ++generation;
    currentPlan = null; applyButton.disabled = true;
    busy = true; button.disabled = saveButton.disabled = clearButton.disabled = true;
    output.textContent = 'Đang đọc catalog backup…';
    try {
      const plan = await call(desktop.db.previewBackupRetention({ profileId, database,
        policy: readInputPolicy() }));
      if (!contextMatches() || request !== generation) return;
      currentPlan = plan;
      applyButton.disabled = !plan.token || plan.removeCount > 100;
      output.innerHTML = `<p><strong>Đề xuất dọn ${plan.removeCount}/${plan.totalCount} bản · ${formatBytes(plan.removeBytes)}</strong><br>Giữ ${plan.remainingCount} bản · ${formatBytes(plan.remainingBytes)}</p>
        ${plan.removeCount > 100 ? '<p class="hint">Mỗi lần áp dụng tối đa 100 bản; hãy điều chỉnh giới hạn và xem trước lại.</p>' : ''}
        ${plan.warnings.map(warning => `<p class="hint">${esc(warningLabels[warning] || warning)}</p>`).join('')}
        <p class="hint">Kết quả tại ${esc(new Date(plan.plannedAt).toLocaleString('vi-VN'))}. Chưa có tệp nào bị xóa.</p>
        ${plan.rows.length > 500 ? `<p class="hint">Hiển thị 500/${plan.rows.length} bản; thống kê tính trên toàn bộ catalog.</p>` : ''}
    <div class="backup-retention-table"><table><thead><tr><th>Bản backup</th><th>Dung lượng</th><th>Đề xuất</th><th>Lý do</th></tr></thead><tbody>
        ${plan.rows.slice(0, 500).map(row => `<tr><td>${esc(row.name)}</td><td>${row.protectedReasons.includes('invalid-size') ? 'Chưa xác định' : formatBytes(row.bytes)}</td><td>${row.action === 'remove' ? 'Có thể dọn' : 'Giữ'}</td><td>${esc([...row.protectedReasons, ...row.reasons].map(reason => labels[reason] || reason).join(' · ') || 'Trong giới hạn')}</td></tr>`).join('') || '<tr><td colspan="4">Chưa có backup.</td></tr>'}</tbody></table></div>`;
    } catch (error) { if (contextMatches() && request === generation) output.textContent = error.message; }
    finally {
      busy = false; button.disabled = false;
      saveButton.disabled = !policyLoaded;
      clearButton.disabled = !policyLoaded || !hasSavedPolicy;
    }
  };
  button.addEventListener('click', preview);
  stopButton.addEventListener('click', async () => {
    const taskId = retentionTaskId;
    if (!taskId || !contextMatches() || stopRequested) return;
    stopRequested = true; stopButton.disabled = true;
    taskStatus.textContent = 'Đang yêu cầu dừng; các bản đã xóa sẽ không được hoàn tác…';
    try {
      const result = await call(desktop.db.cancelTask(profileId, taskId));
      if (contextMatches() && retentionTaskId === taskId && !result.canceled) {
        stopRequested = false;
        taskStatus.textContent = 'Tác vụ đã kết thúc hoặc đang chờ xác nhận native.';
      }
    } catch (error) {
      if (contextMatches() && retentionTaskId === taskId) { stopRequested = false; taskStatus.textContent = error.message; }
    }
  });
  applyButton.addEventListener('click', async () => {
    if (busy || policyBusy || !currentPlan?.token || !contextMatches()) return;
    const token = currentPlan.token;
    currentPlan = null; applyButton.disabled = true;
    const request = ++generation;
    const taskId = `retention-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    retentionTaskId = taskId; stopRequested = false;
    stopButton.hidden = false; stopButton.disabled = true;
    taskStatus.textContent = 'Chờ xác nhận danh sách backup…';
    let finished = false, timer;
    const poll = async () => {
      if (finished || !contextMatches() || retentionTaskId !== taskId) return;
      try {
        const status = await call(desktop.db.backupRetentionStatus({ profileId, database, taskId }));
        if (finished || !contextMatches() || retentionTaskId !== taskId) return;
        if (status.running) {
          const labels = { checking: 'Đang kiểm tra catalog', hashing: 'Đang xác minh bản giữ lại', deleting: 'Đang dọn', stopped: 'Đã dừng', failed: 'Dừng do lỗi', finished: 'Hoàn tất' };
          taskStatus.textContent = `${status.stopping || stopRequested ? 'Đang dừng' : labels[status.phase] || 'Đang xử lý'} · Đã xóa ${status.deleted}/${status.total} bản · ${formatBytes(status.reclaimedBytes)} SQL${status.phase === 'hashing' ? ` · Đã đọc ${formatBytes(status.bytesRead || 0)}/${formatBytes(status.totalBytes || 0)}` : ''}`;
          stopButton.disabled = Boolean(stopRequested || status.stopping);
        }
      } catch (error) { if (!finished && contextMatches()) taskStatus.textContent = `Không đọc được tiến độ: ${error.message}`; }
      if (!finished && contextMatches() && retentionTaskId === taskId) timer = setTimeout(poll, 500);
    };
    busy = true; button.disabled = saveButton.disabled = clearButton.disabled = true;
    controls.forEach(input => { input.disabled = true; });
    output.textContent = 'Đang chờ xác nhận danh sách và kiểm tra lại backup…';
    try {
      const pending = call(desktop.db.applyBackupRetention({ profileId, database, token, taskId }));
      timer = setTimeout(poll, 500);
      const result = await pending;
      if (!contextMatches() || request !== generation) return;
      taskStatus.textContent = result.stopped ? 'Đã dừng. Những bản chưa xử lý được giữ lại.' : result.canceled ? 'Đã hủy xác nhận.' : 'Tác vụ đã kết thúc.';
      output.innerHTML = result.canceled ? '<p>Đã hủy. Hãy xem trước lại nếu muốn dọn.</p>'
        : `<p>Đã xóa ${result.deleted.length} bản · ${formatBytes(result.reclaimedBytes)} SQL. Còn ${result.remaining.length} bản trong danh sách chưa xóa.</p>${result.failed.map(error => `<p class="errorbox">${esc(error.id)}: ${esc(error.message)}${error.sqlDeleted ? ' (SQL đã xóa; metadata có thể còn sót)' : ''}</p>`).join('')}<p>Hãy xem trước lại để tiếp tục. Thao tác xóa không được hoàn tác.</p>`;
      if (result.historySaveError) output.innerHTML += `<p class="errorbox">Không lưu được báo cáo cuối: ${esc(result.historySaveError)}. Lịch sử có thể ghi nhận chưa kết thúc; hãy giữ kết quả hiện tại để đối chiếu.</p>`;
      if (!result.canceled) await refreshBackupList();
    } catch (error) { if (contextMatches() && request === generation) output.textContent = `${error.message} Hãy xem trước lại.`; }
    finally {
      finished = true; clearTimeout(timer);
      if (retentionTaskId === taskId) retentionTaskId = null;
      stopButton.hidden = true; stopButton.disabled = true;
      busy = false; button.disabled = false;
      saveButton.disabled = !policyLoaded;
      clearButton.disabled = !policyLoaded || !hasSavedPolicy;
      controls.forEach(input => { input.disabled = false; });
    }
  });
  editor.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void preview(); }
  });
  inputs[0].focus();
}

function editBackupAnnotations() {
  const current = app.backups.find(entry => entry.id === app.selectedBackupId);
  if (!current) return;
  const profileId = app.connection?.id;
  const database = app.database;
  const contextMatches = () => app.connection?.id === profileId && app.database === database;
  modal(`<section id="backupAnnotationEditor"><h2>Ghi chú và ghim backup</h2><p>${esc(current.name)}</p>
    <label for="backupNoteInput">Ghi chú (tối đa 2.000 ký tự)</label>
    <textarea id="backupNoteInput" rows="5" maxlength="2000">${esc(current.note || '')}</textarea>
    <label><input id="backupPinnedInput" type="checkbox" ${current.pinned ? 'checked' : ''}> Ghim bản sao lưu</label>
    <p class="hint">Bản ghim được bảo vệ khỏi thao tác xóa trong SqlPro. Muốn xóa, hãy bỏ ghim trước. Ghim và ghi chú được giữ khi sao chép sang database khác.</p>
    <p id="backupAnnotationStatus" role="status" aria-live="polite"></p>
    <div class="actions"><button data-click="close-modal">Hủy</button><button id="saveBackupAnnotations" class="primary">Lưu (Ctrl+Enter)</button></div></section>`);
  const note = $('#backupNoteInput');
  const pinned = $('#backupPinnedInput');
  const status = $('#backupAnnotationStatus');
  const button = $('#saveBackupAnnotations');
  const editor = $('#backupAnnotationEditor');
  let saving = false;
  const save = async () => {
    if (saving) return;
    if (!contextMatches()) { status.textContent = 'Kết nối hoặc database đã thay đổi. Hãy mở lại ghi chú.'; return; }
    saving = true;
    button.disabled = note.disabled = pinned.disabled = true;
    status.textContent = 'Đang lưu…';
    try {
      const result = await call(desktop.db.updateBackupAnnotations({ profileId, database, id: current.id,
        patch: { note: note.value, pinned: pinned.checked } }));
      if (!contextMatches() || $('#backupAnnotationStatus') !== status) return;
      app.backups = app.backups.map(entry => entry.id === current.id ? { ...entry, ...result, annotationError: undefined } : entry);
      closeModal();
      if (mode === 'backups') {
        const scrollTop = $('.backup-manager-table')?.scrollTop || 0;
        renderBackupsView();
        const table = $('.backup-manager-table');
        if (table) table.scrollTop = scrollTop;
        const row = [...document.querySelectorAll('[data-backup-row]')].find(element => element.dataset.backupRow === current.id);
        row?.focus({ preventScroll: true });
      }
      toast('Đã lưu ghi chú và trạng thái ghim.');
    } catch (error) {
      if ($('#backupAnnotationStatus') === status) status.textContent = error.message;
    } finally {
      saving = false;
      button.disabled = note.disabled = pinned.disabled = false;
    }
  };
  button.addEventListener('click', save);
  editor.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save(); }
  });
  note.focus();
}

async function showBackupCrypto(operation, id = null) {
  if (!desktop || !app.connection || !app.database) return;
  const profileId = app.connection.id, database = app.database;
  modal(`<h2>${operation === 'encrypt' ? 'Tạo bản sao mã hóa' : 'Bản mã hóa / Giải mã'}</h2>
    <p>${operation === 'encrypt' ? 'Giữ nguyên SQL gốc. Tên, ghi chú và manifest được mã hóa cùng SQL. Hãy cất mật khẩu ở nơi có thể lấy lại.' : 'Giải mã xác thực toàn bộ container và tạo SQL mới cùng manifest. Chọn phục hồi thử riêng sau khi giải mã; không tự ghi vào database.'}</p>
    ${operation === 'decrypt' ? '<label for="backupArchiveId">Bản mã hóa</label><select id="backupArchiveId" disabled><option>Đang đọc…</option></select><div class="actions"><button id="backupArchiveImport">Nhập archive…</button><button id="backupArchiveExport" disabled>Xuất archive…</button><button id="backupArchiveDelete" class="danger" disabled>Xóa archive…</button></div><label for="backupArchiveRemoteDir">Thư mục SFTP trên máy chủ SSH của kết nối</label><input id="backupArchiveRemoteDir" placeholder="/backups" maxlength="1024"><button id="backupArchiveSftp" disabled>Gửi replica qua SFTP…</button><p class="hint">Nhập/xuất chỉ kiểm tra container và bản sao byte; cần giải mã đúng mật khẩu để xác thực. Không tự xóa archive khi dọn SQL. SFTP cần SSH/host key đã tin cậy trong cấu hình kết nối, giữ bản local và không tự retry.</p>' : `<p>Mã nguồn: ${esc(id)}</p>`}
    <label for="backupCryptoPassword">Mật khẩu</label><input type="password" id="backupCryptoPassword" autocomplete="new-password" maxlength="1024">
    ${operation === 'encrypt' ? '<label for="backupCryptoConfirm">Nhập lại mật khẩu</label><input type="password" id="backupCryptoConfirm" autocomplete="new-password" maxlength="1024"><label><input type="checkbox" id="backupCryptoCompress" checked> Nén Gzip</label>' : ''}
    <p id="backupCryptoStatus" role="status" aria-live="polite">Giải mã giới hạn 10 GiB và tối đa 10 phút. Không lưu mật khẩu trong trạng thái ứng dụng.</p>
    <div class="actions"><button data-click="close-modal">Đóng</button><button id="backupCryptoStop" hidden>Hủy tác vụ</button><button id="backupCryptoTrial" hidden>Phục hồi thử SQL mới…</button><button class="primary" id="backupCryptoGo" ${operation === 'decrypt' ? 'disabled' : ''}>${operation === 'encrypt' ? 'Mã hóa bản sao' : 'Giải mã thành SQL mới'}</button></div>`);
  const root = $('#backupCryptoStatus'), dialog = $('#modal'), revision = modalRevision;
  const current = () => revision === modalRevision && dialog.open && root === $('#backupCryptoStatus')
    && profileId === app.connection?.id && database === app.database;
  let taskId = null, restoredId = null, hasArchives = false;
  const cancel = () => taskId ? call(desktop.db.cancelTask({ profileId, taskId })).catch(() => {}) : Promise.resolve();
  const lifecycle = new MutationObserver(() => {
    if (!current()) { void cancel(); lifecycle.disconnect(); }
  });
  lifecycle.observe(dialog, { childList: true, attributes: true, attributeFilter: ['open'] });
  const controls = () => {
    if (!current()) return;
    const busy = Boolean(taskId);
    $('#backupCryptoGo').disabled = busy || operation === 'decrypt' && !hasArchives;
    $('#backupCryptoStop').hidden = !busy;
    $('#backupCryptoTrial').hidden = !restoredId;
    $('#backupCryptoTrial').disabled = busy || connectionIsReadOnly();
    for (const selector of ['#backupArchiveExport', '#backupArchiveDelete', '#backupArchiveId']) {
      if ($(selector)) $(selector).disabled = busy || !hasArchives;
    }
    if ($('#backupArchiveImport')) $('#backupArchiveImport').disabled = busy;
    if ($('#backupArchiveSftp')) $('#backupArchiveSftp').disabled = busy || !hasArchives || !app.connection?.ssh?.enabled;
    if ($('#backupArchiveRemoteDir')) $('#backupArchiveRemoteDir').disabled = busy;
  };
  const loadArchives = async (selectedId = null) => {
    const archives = await call(desktop.db.listEncryptedBackups({ profileId, database }));
    if (!current()) return;
    const select = $('#backupArchiveId');
    select.innerHTML = archives.map(entry => `<option value="${esc(entry.id)}">${esc(entry.id)} · ${formatBytes(entry.bytes)}</option>`).join('');
    if (selectedId && archives.some(entry => entry.id === selectedId)) select.value = selectedId;
    hasArchives = archives.length > 0;
    controls();
    if (!hasArchives) root.textContent = 'Chưa có bản mã hóa trong catalog của database này.';
  };
  $('#backupCryptoStop').addEventListener('click', () => { if (current()) { void cancel(); root.textContent = 'Đã yêu cầu hủy tác vụ.'; } });
  $('#backupCryptoTrial').addEventListener('click', () => {
    if (!current() || taskId || !restoredId || connectionIsReadOnly()) return;
    app.selectedBackupId = restoredId;
    closeModal();
    mode = 'backups'; renderBackupsView();
    void runBackupManagerAction('trial');
  });
  $('#backupCryptoGo').addEventListener('click', async () => {
    if (!current() || taskId) return;
    const password = $('#backupCryptoPassword'), confirmation = $('#backupCryptoConfirm');
    const passphrase = password.value;
    if (!passphrase || passphrase.length > 1024 || (operation === 'encrypt' && (passphrase.length < 8 || passphrase !== confirmation.value))) {
      root.textContent = operation === 'encrypt' ? 'Nhập mật khẩu từ 8 đến 1.024 ký tự và xác nhận trùng khớp.' : 'Hãy nhập mật khẩu của bản mã hóa.'; return;
    }
    const archiveId = operation === 'decrypt' ? $('#backupArchiveId').value : id;
    const compress = $('#backupCryptoCompress')?.checked !== false;
    password.value = ''; if (confirmation) confirmation.value = '';
    taskId = `backup-crypto-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    controls(); root.textContent = 'Đang xử lý; bản gốc được giữ nguyên…';
    try {
      const result = await call(desktop.db[operation === 'encrypt' ? 'encryptBackup' : 'decryptBackup']({ profileId, database, id: archiveId, passphrase, compress, taskId }));
      if (!current()) return;
      root.textContent = `${operation === 'encrypt' ? 'Đã tạo bản mã hóa' : 'Đã xác thực và tạo SQL mới cùng manifest'}: ${result.id}. Chưa xác nhận phục hồi thử.${result.manifestError ? ` ${result.manifestError}` : ''}`;
      if (operation === 'decrypt') {
        restoredId = result.id; app.selectedBackupId = result.id;
        await refreshBackupList(database, profileId);
      }
    } catch (error) { if (current()) root.textContent = error.message; }
    finally { taskId = null; controls(); }
  });
  for (const [selector, api] of [['#backupArchiveImport', 'importEncryptedBackup'], ['#backupArchiveExport', 'exportEncryptedBackup'], ['#backupArchiveDelete', 'deleteEncryptedBackup'], ['#backupArchiveSftp', 'replicateEncryptedBackup']]) {
    $(selector)?.addEventListener('click', async () => {
      if (!current() || taskId) return;
      const archiveId = $('#backupArchiveId').value;
      taskId = `backup-archive-${Date.now()}-${Math.random().toString(16).slice(2)}`; controls();
      try {
        const result = await call(desktop.db[api]({ profileId, database, id: archiveId, taskId,
          ...(api === 'replicateEncryptedBackup' ? { destinationDir: $('#backupArchiveRemoteDir').value } : {}) }));
        if (!current()) return;
        if (!result.canceled) { await loadArchives(result.id); if (!current()) return; }
        root.textContent = result.canceled ? 'Đã hủy thao tác archive.' : api === 'importEncryptedBackup' ? 'Đã nhập archive. Hãy giải mã để xác thực mật khẩu và nội dung.' : api === 'exportEncryptedBackup' ? 'Đã xuất archive; bản gốc được giữ nguyên.' : api === 'replicateEncryptedBackup' ? `Đã đối chiếu SHA-256 replica: ${result.remotePath}. Chưa phục hồi thử.${result.durability === 'fsync' ? '' : ' Máy chủ chưa xác nhận fsync.'}` : 'Đã xóa archive. Các bản SQL vẫn được giữ.';
      } catch (error) { if (current()) root.textContent = error.message; }
      finally { taskId = null; controls(); }
    });
  }
  $('#backupCryptoPassword').focus();
  if (operation === 'decrypt') {
    try { await loadArchives(); }
    catch (error) { if (current()) root.textContent = error.message; }
  }
}

async function runBackupManagerAction(action) {
  if (action === 'encrypt' && app.selectedBackupId) return showBackupCrypto('encrypt', app.selectedBackupId);
  if (action === 'encrypted-list') return showBackupCrypto('decrypt');
  if (action === 'selection-preview') return showBackupSelectionPreview();
  if (action === 'schedule') return showBackupSchedule();
  if (action === 'retention-history') return showBackupRetentionHistory();
  if (action === 'retention-preview') return previewBackupRetention();
  if (action === 'annotations') return editBackupAnnotations();
  if (action === 'trial-recovery') {
    const profileId = app.connection?.id;
    modal('<h2>Database phục hồi thử cần kiểm tra</h2><p id="trialRecoveryLoading" role="status">Đang đọc nhật ký…</p><div class="actions"><button data-click="close-modal">Đóng</button></div>');
    const loading = $('#trialRecoveryLoading');
    let records;
    try { records = await call(desktop.db.listTrialRecovery(profileId)); }
    catch (error) { if ($('#trialRecoveryLoading') === loading) loading.textContent = error.message; return; }
    if (app.connection?.id !== profileId || $('#trialRecoveryLoading') !== loading) return;
    modal(`<div class="modal-card"><div class="modal-header"><h3>Database phục hồi thử cần kiểm tra (${records.length})</h3><button class="close-btn" data-click="close-modal" aria-label="Đóng">✕</button></div>
      <div class="modal-body"><p>Nhật ký cục bộ ghi trước khi tạo database. Mỗi lần dọn sẽ kiểm tra đúng đích và marker sở hữu. Database thiếu marker cần được kiểm tra thủ công.</p>
      ${records.map(record => `<p><strong>${esc(record.database)}</strong><br>${esc(record.startedAt)}<br><button data-trial-cleanup="${esc(record.id)}" ${!record.targetMatches || connectionIsReadOnly() ? 'disabled' : ''}>Kiểm tra và dọn</button> ${record.targetMatches ? '' : 'Đích kết nối đã thay đổi'}</p>`).join('') || '<p>Không có nhật ký database thử còn sót trên kết nối này.</p>'}
      <p id="trialRecoveryStatus" role="status" aria-live="polite"></p></div></div>`);
    const dialog = $('#modal');
    const status = $('#trialRecoveryStatus');
    dialog.querySelectorAll('[data-trial-cleanup]').forEach(button => button.addEventListener('click', async () => {
      if (app.connection?.id !== profileId) return;
      button.disabled = true;
      status.textContent = 'Đang kiểm tra…';
      try {
        const result = await call(desktop.db.cleanupTrialRecovery({ profileId, id: button.dataset.trialCleanup }));
        if ($('#trialRecoveryStatus') !== status || app.connection?.id !== profileId) return;
        status.textContent = result.canceled ? 'Đã hủy.' : 'Đã xác nhận database tạm được dọn.';
        if (!result.canceled) { button.textContent = 'Đã dọn'; return; }
      } catch (error) { if ($('#trialRecoveryStatus') === status) status.textContent = error.message; }
      button.disabled = false;
    }));
    return;
  }
  if(action==='cancel-trial'){
    const output=$('#backupTrialReport');
    if(output?.dataset.taskId){await call(desktop.db.cancelTask(output.dataset.profileId,output.dataset.taskId));
      const label=output.querySelector?.('[data-trial-status]');if(label)label.textContent='Đang dừng và kiểm tra dọn database tạm…';}
    return;
  }
  if(action==='trial' && app.selectedBackupId){
    const output=$('#backupTrialReport');
    if(!output || output.dataset.loading==='true')return;
    output.dataset.loading='true';
    const taskId=`trial-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    output.dataset.taskId=taskId;output.dataset.profileId=app.connection?.id;
    output.innerHTML='<span data-trial-status>Đang kiểm tra và phục hồi thử…</span> <button data-backup-action="cancel-trial">Hủy phục hồi thử</button>';
    try{
      const result=await call(desktop.db.trialBackup({profileId:app.connection?.id,database:app.database,id:app.selectedBackupId,taskId}));
      if($('#backupTrialReport')!==output)return;
      if(result.canceled){output.textContent='Đã hủy phục hồi thử.';return;}
      const report=result.report;
      const statuses={verified:'Đã đối chiếu thành công',unverified:'Chưa đủ điều kiện xác minh',failed:'Thất bại',cancelled:'Đã hủy',timeout:'Vượt thời gian cho phép'};
      const cleanups={removed:'Đã xóa', 'not-created':'Chưa tạo', 'manual-required':'Cần dọn thủ công', 'check-required':'Cần kiểm tra nhật ký database thử'};
      output.innerHTML=`<p>Kết quả: ${esc(statuses[report.status] || report.status)} · Dọn database tạm: ${esc(cleanups[report.cleanup] || report.cleanup)}</p>${report.error?`<p>${esc(report.error)}</p>`:''}${report.cleanup!=='removed'&&report.cleanup!=='not-created'?`<p>Database cần kiểm tra: <strong>${esc(report.database)}</strong> · ${esc(report.cleanupError || '')}</p>`:''}${report.journalError?`<p>Không dọn được nhật ký: ${esc(report.journalError)}. Kiểm tra mục Database thử còn sót.</p>`:''}${report.reportSaveError?`<p>Không lưu được báo cáo: ${esc(report.reportSaveError)}</p>`:''}<p class="backup-checksum">SHA-256: ${esc(report.checksum || 'Chưa xác định')}</p>`;
    }catch(error){if($('#backupTrialReport')===output)output.textContent=error.message;}
    finally{output.dataset.loading='false';}
    return;
  }
  if (action === 'cancel-inspect') {
    const output=$('#backupInventory');
    if (output?.dataset.taskId && desktop.db.cancelInspectBackup) {
      await call(desktop.db.cancelInspectBackup({profileId:output.dataset.profileId,taskId:output.dataset.taskId}));
    }
    return;
  }
  if (action === 'inspect' && app.selectedBackupId) {
    const id = app.selectedBackupId;
    const database = app.database;
    const profileId = app.connection?.id;
    const output = $('#backupInventory');
    if (!output || output.dataset.loading === 'true') return;
    output.dataset.loading = 'true';
    const taskId=`inspect-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    output.dataset.taskId=taskId;
    output.dataset.profileId=profileId;
    output.innerHTML='<span data-inspection-progress>Đang đọc tệp SQL…</span> <button data-backup-action="cancel-inspect">Hủy quét</button><p class="hint">Các lượt xem cùng backup dùng chung một lần quét. Hủy sẽ dừng lần quét chung.</p>';
    let progressTimer;
    const pollProgress=async()=>{
      if (output.dataset.loading!=='true' || $('#backupInventory')!==output) return;
      try {
        if (desktop.db.inspectBackupStatus) {
          const status=await call(desktop.db.inspectBackupStatus({profileId,taskId}));
          if (output.dataset.loading!=='true' || $('#backupInventory')!==output) return;
          const label=output.querySelector?.('[data-inspection-progress]');
          if (label && status.running) label.textContent=status.cancelling ? 'Đang hủy quét…' :
            `Đã đọc ${formatBytes(status.bytes)} / ${formatBytes(status.totalBytes)}${status.totalBytes ? ` (${Math.floor(status.bytes/status.totalBytes*100)}%)` : ''} · ${Number(status.statements).toLocaleString()} câu lệnh. Đang phân tích/kiểm tra tệp.`;
        }
      } catch { /* Progress is advisory; final scan errors remain visible. */ }
      if (output.dataset.loading==='true' && $('#backupInventory')===output) progressTimer=setTimeout(pollProgress,500);
    };
    progressTimer=setTimeout(pollProgress,500);
    try {
      const result = await call(desktop.db.inspectBackup({ id, database, profileId, taskId }));
      if (app.selectedBackupId !== id || app.database !== database || app.connection?.id !== profileId || $('#backupInventory') !== output) return;
      const objects = [...result.tables.map((entry) => ({ type: 'table', name: entry.name })), ...result.objects.filter((entry) => entry.type !== 'table')];
      output.innerHTML = `<p>${Number(result.statements).toLocaleString()} câu lệnh SQL · ${objects.length} đối tượng</p>
        <ul class="backup-object-list">${objects.map((entry) => `<li>${esc(entry.type)}: ${esc(entry.name)}</li>`).join('')}</ul>
        ${result.truncated ? '<p>Danh sách vượt giới hạn hiển thị; có thể còn đối tượng khác.</p>' : ''}`;
    } catch (error) {
      if ($('#backupInventory') === output) output.textContent = `Không đọc được nội dung: ${error.message}`;
    } finally {
      output.dataset.loading = 'false';
      clearTimeout(progressTimer);
    }
    return;
  }
  if (action === 'create') return backupDatabase();
  if (action === 'restore-file') return restoreDatabase();
  if (action === 'restore' && app.selectedBackupId) return restoreDatabase(app.selectedBackupId);
  if (action === 'verify' && app.selectedBackupId) {
    try {
      const id = app.selectedBackupId;
      const result = await call(desktop.db.verifyBackup({
        profileId: app.connection?.id || null,
        database: app.database,
        id
      }));
      const checksum = result.checksum ? String(result.checksum) : '';
      const expected = result.expected ? String(result.expected) : '';
      const heading = result.match === true
        ? 'Checksum khớp'
        : result.match === false
          ? 'Checksum không khớp'
          : 'Chưa có checksum để đối chiếu';
      const detail = result.legacy
        ? '<p class="hint">Bản sao lưu cũ chưa có manifest. Đây là SHA-256 của tệp hiện tại; hãy lưu lại giá trị này để đối chiếu thủ công ở lần sau.</p>'
        : result.match === true
          ? '<p class="hint">Tệp khớp checksum đã lưu. Đây chưa phải là bằng chứng đã phục hồi thử thành công.</p>'
          : '<div class="errorbox" role="alert">Tệp có thể đã bị sửa hoặc hỏng. Không nên phục hồi cho đến khi kiểm tra lại nguồn tệp.</div>';
      modal(`<h2>${esc(heading)}</h2>
        <label>SHA-256 hiện tại</label>
        <input value="${esc(checksum)}" readonly aria-label="SHA-256 hiện tại">
        ${expected ? `<label>SHA-256 trong manifest</label><input value="${esc(expected)}" readonly aria-label="SHA-256 trong manifest">` : ''}
        ${detail}
        <div class="actions"><button data-click="close-modal">Đóng</button></div>`);
      await refreshBackupList();
    } catch (error) {
      toast(error.message, 'error');
    }
    return;
  }
  if (action === 'rename' && app.selectedBackupId) {
    const current = app.backups.find((entry) => entry.id === app.selectedBackupId);
    if (!current) return;
    const profileId = app.connection?.id || null;
    const database = app.database;
    const id = current.id;
    modal(`<h2>Đổi tên bản sao lưu</h2>
      <label>Tên hiển thị mới</label>
      <input id="renameBackupInput" value="${esc(current.name)}" maxlength="120" autofocus>
      <p class="hint">Đổi tên hiển thị giúp bạn dễ nhận biết bản sao lưu. Tệp gốc và checksum vẫn được giữ nguyên.</p>
      <div class="actions">
        <button data-click="close-modal">Hủy</button>
        <button class="primary" id="confirmRenameBackupBtn">Đổi tên</button>
      </div>`);
    const input = $('#renameBackupInput');
    const button = $('#confirmRenameBackupBtn');
    const matches = () => $('#renameBackupInput') === input && app.connection?.id === profileId && app.database === database;
    let saving = false;
    button?.addEventListener('click', async () => {
      if (saving) return;
      if (!matches()) return toast('Kết nối hoặc database đã thay đổi. Hãy mở lại hộp thoại.', 'error');
      const name = input?.value.trim();
      if (!name) return toast('Vui lòng nhập tên bản sao lưu.', 'error');
      saving = true; button.disabled = true;
      try {
        await call(desktop.db.renameBackup({
          profileId,
          database,
          id,
          name
        }));
        if (!matches()) return;
        closeModal();
        toast('Đã đổi tên bản sao lưu.');
        await refreshBackupList();
      } catch (error) {
        if (matches()) toast(error.message, 'error');
      } finally { saving = false; button.disabled = false; }
    });
    return;
  }
  if (action === 'copy-backup' && app.selectedBackupId) return copySelectedBackupToClipboard(app.selectedBackupId);
  if (action === 'paste-backup' && app.copiedBackup) return pasteBackupModal();
  if (action === 'copy-to-db' && app.selectedBackupId) return copyBackupToDatabaseModal(app.selectedBackupId);
  if (action === 'create-replica' && app.selectedBackupId) {
    const current = app.backups.find((entry) => entry.id === app.selectedBackupId);
    if (!current) return;
    const profileId = app.connection?.id || null;
    const database = app.database;
    const id = current.id;
    modal(`<h2>Tạo bản sao (Replica)</h2>
      <p class="hint">Tạo bản sao độc lập của tệp backup sang thư mục khác và kiểm tra tính toàn vẹn checksum.</p>
      <label>Thư mục đích</label>
      <input id="replicaDestDirInput" placeholder="/path/to/destination" autofocus>
      <div class="actions">
        <button data-click="close-modal">Hủy</button>
        <button class="primary" id="confirmCreateReplicaBtn">Tạo Replica</button>
      </div>`);
    const input = $('#replicaDestDirInput');
    const button = $('#confirmCreateReplicaBtn');
    const revision = modalRevision;
    const matches = () => modalRevision === revision && $('#modal')?.open
      && $('#replicaDestDirInput') === input && app.connection?.id === profileId && app.database === database;
    let running = false;
    button?.addEventListener('click', async () => {
      if (running || !matches()) return;
      const destinationDir = input?.value.trim();
      if (!destinationDir) return toast('Vui lòng nhập đường dẫn thư mục đích.', 'error');
      running = true; button.disabled = true;
      try {
        const result = await call(desktop.db.createBackupReplica({
          profileId,
          database,
          id,
          destinationDir,
          expectedFileChecksum: current.checksum || null
        }));
        if (!matches()) return;
        closeModal();
        toast(`Đã tạo replica: ${result.replicaPath}`, 'success');
      } catch (error) {
        if (matches()) toast(error.message, 'error');
      } finally {
        running = false; if (matches()) button.disabled = false;
      }
    });
    return;
  }
  if (action === 'container-info' && app.selectedBackupId) {
    const current = app.backups.find((entry) => entry.id === app.selectedBackupId);
    if (!current) return;
    const profileId = app.connection?.id || null;
    const database = app.database;
    const id = current.id;
    const revision = modalRevision;
    const previousDialog = $('#modal'), wasOpen = previousDialog?.open;
    const matches = () => modalRevision === revision && $('#modal') === previousDialog && previousDialog?.open === wasOpen
      && app.connection?.id === profileId && app.database === database && app.selectedBackupId === id;
    try {
      const info = await call(desktop.db.inspectBackupContainer({
        profileId,
        database,
        id
      }));
      if (!matches()) return;
      modal(`<h2>Thông tin Container Backup</h2>
        <dl class="backup-details-grid">
          <div><dt>Định dạng container</dt><dd>${esc(info.format || 'V1 / Raw SQL')}</dd></div>
          <div><dt>Trạng thái mã hóa</dt><dd>${info.encrypted ? '🔒 Có mã hóa' : 'Không mã hóa'}</dd></div>
          <div><dt>Nén dữ liệu</dt><dd>${info.compressed ? '✓ GZIP / Nén' : 'Không nén'}</dd></div>
          <div><dt>Thuật toán</dt><dd>${esc(info.cipher || 'None')}</dd></div>
          <div><dt>Dung lượng tệp</dt><dd>${formatBytes(current.bytes)}</dd></div>
        </dl>
        <div class="actions"><button data-click="close-modal">Đóng</button></div>`);
    } catch (error) {
      if (matches()) toast(`Không kiểm tra được container: ${error.message}`, 'error');
    }
    return;
  }
  if (action === 'refresh') return refreshBackupList();
  if (action === 'copy' && app.selectedBackupId) {
    try {
      await writeClipboardText(app.selectedBackupId);
      toast('Đã sao chép tên bản backup.');
    } catch (error) {
      toast(error.message, 'error');
    }
  }
  if (action === 'folder') {
    try {
      await call(desktop.db.showBackupFolder({
        profileId: app.connection?.id || null,
        database: app.database,
        id: app.selectedBackupId
      }));
    } catch (error) {
      toast(error.message, 'error');
    }
  }
  if (action === 'export' && app.selectedBackupId) {
    try {
      const result = await call(desktop.db.exportBackup({
        profileId: app.connection?.id || null,
        database: app.database,
        id: app.selectedBackupId
      }));
      if (!result.canceled) toast(`Đã xuất tệp SQL: ${result.filePath}`);
    } catch (error) {
      toast(error.message, 'error');
    }
  }
  if (action === 'delete' && app.selectedBackupId) {
    const id = app.selectedBackupId;
    const profileId = app.connection?.id || null;
    const database = app.database;
    const contextMatches = () => app.connection?.id === profileId && app.database === database;
    const confirmed = await confirmAction('Xóa bản sao lưu?', `Tệp backup ${id} sẽ bị xóa khỏi máy.`, 'Xóa');
    if (!confirmed) return;
    if (!contextMatches()) return toast('Kết nối hoặc database đã thay đổi. Hãy chọn lại bản backup.', 'error');
    try {
      await call(desktop.db.deleteBackup({
        profileId,
        database,
        id
      }));
      if (!contextMatches()) return;
      app.selectedBackupId = null;
      await refreshBackupList();
      toast('Đã xóa bản sao lưu.');
    } catch (error) {
      toast(error.message, 'error');
    }
  }
}

async function onBackupManagerClick(event) {
  const row = event.target.closest('[data-backup-row]');
  if (row) {
    app.selectedBackupId = row.dataset.backupRow;
    renderBackupsView();
    renderSidebar();
    return;
  }
  const action = event.target.closest('[data-backup-action]')?.dataset.backupAction;
  if (!action) return;
  await runBackupManagerAction(action);
}

async function selectTable(name, options = {}) {
  ++dataRequestId;
  table = name;
  app.tablePreferencePending = true;
  app.page = 1;
  app.search = '';
  app.searchColumn = null;
  app.searchMode = 'contains';
  app.filterTree = null;
  app.visibleColumns = null; app.sorts = null;
  app.pageCursor = null;
  app.nextCursor = null;
  app.previousCursor = null;
  app.hasMore = undefined;
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
    if (app.tablePreferencePending) {
      const scope = { profileId: connectionId, database, table: targetTable };
      const current = () => requestId === dataRequestId && database === app.database && targetTable === table && connectionId === app.connection?.id && mode === 'data';
      try {
        const saved = await call(desktop.tablePreferences.read(scope));
        if (!current()) return;
        if (saved) {
          const columns = await call(desktop.db.columns(database, targetTable, connectionId));
          if (!current()) return;
          const preference = window.SqlTablePreferences.normalize(saved.view, columns);
          applyTablePreference(preference);
        }
        app.tablePreferencePending = false;
      } catch (error) {
        if (!current()) return;
        renderError(error);
        $('#workspace [data-click="load-data"]')?.remove();
        const actions = document.createElement('div');
        actions.className = 'actions';
        actions.innerHTML = '<button id="retryTablePreference">Thử đọc lại cấu hình</button><button id="skipTablePreference">Mở mặc định lần này</button>';
        $('#workspace').append(actions);
        $('#retryTablePreference').addEventListener('click', () => { if (current()) { app.tablePreferencePending = true; void loadData(); } });
        $('#skipTablePreference').addEventListener('click', () => { if (current()) { app.tablePreferencePending = false; void loadData(); } });
        return;
      }
    }
    const data = await call(desktop.db.tableData({
      profileId: app.connection?.id || null,
      database,
      table: targetTable,
      page: app.page,
      pageSize: app.pageSize,
      search: app.search,
      searchColumn: app.searchColumn || null,
      searchMode: app.searchMode || 'contains',
      filterTree: app.filterTree || null,
      cursor: app.pageCursor || null,
      orderBy: app.orderBy,
      sorts: app.sorts,
      orderDir: app.orderDir
    }));
    if (requestId !== dataRequestId || database !== app.database || targetTable !== table || connectionId !== app.connection?.id || mode !== 'data') return;
    app.columns = data.columns;
    app.primaryKey = data.primaryKey;
    app.rows = data.rows;
    app.rows.forEach((row, index) => rowOriginalHashes.set(row, data.originalHashes?.[index] || {}));
    app.total = data.total;
    app.page = data.page;
    app.pageSize = data.pageSize;
    app.nextCursor = data.nextCursor || null;
    app.previousCursor = data.previousCursor || null;
    app.hasMore = data.hasMore;
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
  queryDraftCache = editor.value;
}

function renderQueryTabs() {
  const host = $('#queryTabs');
  if (!host) return;
  host.innerHTML = queryTabs.map((tab, index) => {
    const target = queryTargetLabel(tab, false);
    return `
    <button class="querytab${mode === 'query' && index === activeQuery ? ' selected' : ''}" data-query-tab="${index}" title="${esc(`${tab.title} · ${target} (Nhấp đúp hoặc chuột phải để đổi tên)`)}">
      <span class="tab-icon"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5l4 3-4 3"></path><line x1="9" y1="11" x2="13" y2="11"></line></svg></span>
      <span class="tab-title-text">${esc(tab.title)}</span>${tab.running ? ' <span class="tabrunning">…</span>' : ''}
      <span class="querytab-target">${queryTargetConnection(tab) ? connectionEnvironmentBadge(queryTargetConnection(tab)) : ''} ${esc(target)}</span>
      <span class="tabclose" data-close-query="${index}" title="Đóng tab" aria-label="Đóng tab"><svg class="tab-close-icon" width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><line x1="2" y1="2" x2="8" y2="8"></line><line x1="8" y1="2" x2="2" y2="8"></line></svg></span>
    </button>`;
  }).join('');
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

function onTabDblClick(event) {
  const close = event.target.closest('[data-close-query]');
  if (close) return;
  const tab = event.target.closest('[data-query-tab]');
  if (tab) promptRenameQueryTab(Number(tab.dataset.queryTab));
}

function nextAvailableQueryTitle(sql = '', target = null, customTitle = null) {
  if (typeof customTitle === 'string' && customTitle.trim()) {
    return customTitle.trim().slice(0, 40);
  }
  if (typeof sql === 'string' && sql.trim()) {
    const fromMatch = /\bFROM\s+[`"']?(?:[a-zA-Z0-9_]+[.`"'])*([a-zA-Z0-9_]+)[`"']?/i.exec(sql);
    if (fromMatch && fromMatch[1]) {
      const candidate = fromMatch[1].trim();
      const exists = queryTabs.some((t) => t.title?.toLowerCase() === candidate.toLowerCase());
      if (!exists) return candidate.slice(0, 30);
    }
  }
  const usedNumbers = new Set();
  for (const tab of queryTabs) {
    const match = /(?:Query|\b)\s*(\d+)$/i.exec(tab.title?.trim() || '');
    if (match) {
      const num = parseInt(match[1], 10);
      if (Number.isInteger(num) && num > 0) {
        usedNumbers.add(num);
      }
    }
  }
  let n = 1;
  while (usedNumbers.has(n)) {
    n += 1;
  }
  return `Query ${n}`;
}

function promptRenameQueryTab(index) {
  if (index < 0 || index >= queryTabs.length) return;
  const tab = queryTabs[index];
  modal(`
    <h2>Đổi tên tab truy vấn</h2>
    <p class="hint">Nhập tên mới để phân biệt nội dung hoặc bảng bạn đang làm việc.</p>
    <label for="renameQueryTabInput">Tên tab</label>
    <input id="renameQueryTabInput" type="text" maxlength="40" value="${esc(tab.title)}" placeholder="Ví dụ: Báo cáo, Test API...">
    <div class="actions">
      <button data-click="close-modal">Hủy</button>
      <button class="primary" id="confirmRenameTabBtn">Lưu</button>
    </div>
  `);
  const input = $('#renameQueryTabInput');
  input?.focus();
  input?.select();
  const save = () => {
    const val = input.value.trim();
    if (val) {
      tab.title = val.slice(0, 40);
      renderQueryTabs();
      persistState();
    }
    closeModal();
  };
  $('#confirmRenameTabBtn')?.addEventListener('click', save);
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
    }
  });
}

function reindexQueryTabs() {
  let counter = 1;
  for (const tab of queryTabs) {
    if (/^Query\s+\d+$/i.test(tab.title?.trim() || '')) {
      tab.title = `Query ${counter}`;
      counter += 1;
    }
  }
  renderQueryTabs();
  persistState();
  toast('Đã đánh số lại các tab truy vấn bắt đầu từ 1.', 'info');
}

function duplicateQueryTab(index) {
  if (index < 0 || index >= queryTabs.length) return;
  const source = queryTabs[index];
  newQuery(source.sql || '', { profileId: source.profileId, database: source.database }, `${source.title} (bản sao)`);
}

function retainQueryTabs(keptTabs, nextActive) {
  const previous = app.query;
  syncActiveQuery();
  for (const tab of queryTabs) {
    if (!keptTabs.includes(tab)) explainObservations.delete(tab);
  }
  queryTabs = keptTabs;
  activeQuery = queryTabs.indexOf(nextActive);
  app.query = nextActive;
  updateChrome();
  if (mode === 'query' && previous !== nextActive) {
    if (!app.connection) renderWelcome();
    else renderQueryView();
  }
  persistState();
}

function closeOtherQueryTabs(index) {
  if (!Number.isInteger(index) || index < 0 || index >= queryTabs.length) return;
  const kept = queryTabs[index];
  if (queryTabs.some((tab) => tab !== kept && tab.running)) {
    toast('Các tab đang chạy truy vấn được giữ lại.', 'info');
  }
  retainQueryTabs(queryTabs.filter((tab) => tab === kept || tab.running), kept);
}

function closeQueryTabsToRight(index) {
  if (!Number.isInteger(index) || index < 0 || index >= queryTabs.length) return;
  const kept = queryTabs[index];
  const toKeep = queryTabs.filter((tab, i) => i <= index || tab.running);
  if (queryTabs.slice(index + 1).some((tab) => tab.running)) {
    toast('Các tab bên phải đang chạy truy vấn được giữ lại.', 'info');
  }
  retainQueryTabs(toKeep, toKeep.includes(app.query) ? app.query : kept);
}

function newQuery(sql = '', target = null, options = null) {
  const profileId = target && target.profileId !== undefined
    ? target.profileId
    : (app.connection ? app.connection.id : null);
  const database = target && target.database !== undefined
    ? target.database
    : (app.database || null);
  if (!desktop) {
    toast('Ứng dụng desktop chưa sẵn sàng.', 'error');
    return;
  }
  if (!profileId && !app.connection) {
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
  const customTitle = typeof options === 'string' ? options : options?.title;
  const title = nextAvailableQueryTitle(sql, target, customTitle);
  const tab = {
    id: queryId,
    title,
    sql: String(sql ?? ''),
    result: null,
    error: null,
    running: false,
    profileId: profileId || null,
    database: database || null,
    taskId: null,
    savedQueryId: typeof options === 'object' && options?.savedQueryId ? options.savedQueryId : null
  };
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
  explainObservations.delete(tab);
  if (mode === 'query' && wasActive) syncActiveQuery();
  queryTabs.splice(index, 1);
  if (!queryTabs.length) {
    const title = nextAvailableQueryTitle();
    queryId += 1;
    queryTabs.push({
      id: queryId,
      title,
      sql: '',
      result: null,
      error: null,
      running: false,
      profileId: app.connection ? app.connection.id : null,
      database: app.database || null,
      taskId: null
    });
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
  document.body.classList.toggle('transfer-mode', mode === 'transfer');
  const envValue = connectionEnvironment(app.connection).value;
  document.body.classList.toggle('env-production', envValue === 'production');
  document.body.classList.toggle('env-staging', envValue === 'staging');
  document.body.classList.toggle('env-local', envValue === 'local');
  document.body.classList.toggle('conn-readonly', connectionIsReadOnly(app.connection?.id));
  const label = mode === 'query' ? 'QUERY' : mode === 'history' ? 'WORKSPACE' : mode === 'data' ? 'TABLE' : mode.toUpperCase();
  const title = mode === 'transfer' ? 'Tác vụ database' : mode === 'backups' ? 'Backups' : mode === 'query' ? 'SQL Editor' : mode === 'history' ? 'Lịch sử truy vấn' : (table || app.database || 'Workspace');
  $('#title').innerHTML = `${esc(title)} <span>${label}</span> ${app.connection ? connectionEnvironmentBadge(app.connection) : ''}`;
  $('#eyebrow').textContent = `${(app.database || 'CHƯA CHỌN DATABASE').toUpperCase()} / ${mode === 'query' ? 'TRUY VẤN' : mode === 'history' ? 'LỊCH SỬ' : mode === 'backups' ? 'SAO LƯU' : mode === 'transfer' ? 'TÁC VỤ' : 'BẢNG'}`;
  const subtitles = {
    data: table ? `Bảng ${table} trong ${app.database}.` : 'Chọn một bảng để xem dữ liệu thật.',
    structure: table ? `Cấu trúc cột của ${app.database}.${table}.` : 'Chọn một bảng để xem cấu trúc.',
    indexes: table ? `Indexes của ${app.database}.${table}.` : 'Chọn một bảng để xem indexes.',
    relations: table ? `Quan hệ khóa ngoại của ${app.database}.${table}.` : 'Chọn một bảng để xem quan hệ.',
    query: 'Soạn và chạy truy vấn thật trên kết nối đang mở.',
    history: 'Các truy vấn đã chạy trong phiên làm việc.',
    backups: `Các bản sao lưu của database ${app.database || ''}.`,
    transfer: 'Theo dõi tác vụ sao lưu hoặc phục hồi đang chạy.'
  };
  $('#subtitle').textContent = subtitles[mode] || '';
  $('#crumbDb').textContent = app.database || '—';
  $('#crumbServer').textContent = app.connection ? `${app.connection.name || app.connection.host} · ${connectionEnvironment(app.connection).label} · ${app.serverType === 'mariadb' ? 'MARIADB' : 'MYSQL'}${app.server ? ` ${app.server}` : ''}` : 'CHƯA KẾT NỐI';
  $('#tabName').textContent = mode === 'backups' ? 'Backups' : mode === 'transfer' ? 'Tác vụ' : (table || '—');
  $('#dataTab').classList.toggle('selected', mode !== 'query' && mode !== 'transfer');
  renderQueryTabs();
  renderTransferTab();
  renderTransactionBar();
  void refreshSessionState(transactionProfileId());
  $('#subnav').style.display = ['query', 'history', 'backups', 'transfer'].includes(mode) ? 'none' : 'flex';
  [...$('#subnav').children].forEach((button, index) => {
    button.classList.toggle('current', ['data', 'structure', 'indexes', 'relations'][index] === mode);
  });
  document.title = `${mode === 'query' ? 'SQL Editor' : mode === 'history' ? 'Lịch sử' : mode === 'backups' ? 'Backups' : mode === 'transfer' ? 'Tác vụ' : (table || 'Workspace')} — ${app.database || 'SqlPro'} — SqlPro`;
}

async function view(nextMode) {
  if (mode === 'query' && nextMode !== 'query') syncActiveQuery();
  mode = nextMode;
  updateChrome();
  if (nextMode === 'transfer') {
    renderTransferView();
    return;
  }
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
  if (nextMode === 'backups') {
    renderBackupsView();
    refreshBackupList();
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
      app.columns = await call(desktop.db.columns(app.database, table, app.connection?.id || null));
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
      app.indexes = await call(desktop.db.indexes(app.database, table, app.connection?.id || null));
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
      app.relations = await call(desktop.db.relations(app.database, table, app.connection?.id || null));
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

function renderConnectionLoading(profile) {
  $('#workspace').innerHTML = `
    <div class="connection-loading" role="status" aria-live="polite">
      <span class="connection-loading-spinner" aria-hidden="true"></span>
      <strong>Đang kết nối ${esc(profile.name)}…</strong>
      <span>Đang xác thực và tải danh sách database</span>
    </div>
  `;
}

function renderWelcome() {
  const hasConnections = app.connections.length > 0;
  $('#workspace').innerHTML = `
    <div class="welcome">
      <h2>${hasConnections ? 'Chọn một kết nối để bắt đầu' : 'Kết nối database đầu tiên'}</h2>
      <p>SqlPro chạy truy vấn thật trên MySQL/MariaDB. Thông số kết nối tương thích Navicat, bao gồm SSH tunnel và SSL.</p>
      <div class="welcome-actions">
        <button class="primary" data-click="new-connection">＋ Kết nối mới</button>
        <button data-click="import-navicat">⇩ Nhập kết nối Navicat</button>
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
      <button data-click="load-data">Thử lại</button>
    </div>
  `;
  setStatus(error.message || 'Lỗi');
}


let rowValueEditorSequence = 0;

function createRowValueEditor(column, originalValue, { inline = false, inserting = false, disabled = false } = {}) {
  const spec = RowValues.describe(column, originalValue);
  const readOnly = disabled || spec.readOnly;
  const element = document.createElement('div');
  element.className = `sql-value-editor${inline ? ' sql-value-inline' : ''}`;
  const inputId = `sql-value-${++rowValueEditorSequence}`;
  const rawValue = RowValues.displayValue(column, originalValue);
  const modes = document.createElement('select');
  modes.className = 'sql-value-mode';
  modes.setAttribute('aria-label', `Chế độ giá trị cột ${column.name}`);
  const modeOptions = [['value', 'Giá trị'], ...(spec.nullable ? [['null', 'NULL']] : []), ...(inserting ? [['default', 'DEFAULT']] : [])];
  modeOptions.forEach(([value, label]) => {
    const option = document.createElement('option'); option.value = value; option.textContent = label; modes.appendChild(option);
  });
  const hasDefault = column.defaultValue !== null && column.defaultValue !== undefined;
  modes.value = inserting && (hasDefault || spec.nullable) ? 'default' : originalValue === null && spec.nullable ? 'null' : 'value';
  if (modeOptions.length > 1) element.appendChild(modes);

  let input;
  if (spec.kind === 'enum' || spec.kind === 'set' || spec.kind === 'boolean' || (spec.kind === 'bit' && spec.width === 1)) {
    input = document.createElement('select');
    const choices = spec.kind === 'bit' ? ['0', '1'] : spec.choices;
    const selected = spec.kind === 'set' ? (rawValue ? rawValue.split(',') : []) : [rawValue];
    if (spec.kind === 'set') { input.multiple = true; input.size = Math.min(5, Math.max(2, choices.length)); }
    if (spec.kind !== 'set' && !choices.includes(rawValue)) {
      const current = document.createElement('option'); current.value = rawValue;
      current.textContent = rawValue ? `${rawValue} (hiện tại)` : originalValue === '' ? "'' (hiện tại)" : 'Chọn giá trị…';
      current.disabled = inserting || originalValue === null || originalValue === undefined;
      input.appendChild(current);
    }
    const allChoices = [...choices, ...(spec.kind === 'set' ? selected.filter((value) => value && !choices.includes(value)) : [])];
    [...new Set(allChoices)].forEach((value) => {
      const option = document.createElement('option'); option.value = value;
      option.textContent = value === '' ? "'' (chuỗi rỗng)" : value;
      option.selected = selected.includes(value); input.appendChild(option);
    });
    if (!input.multiple) input.value = rawValue;
  } else {
    const multiline = spec.kind === 'json' || spec.kind === 'binary' || /text/.test(spec.base) || /[\r\n]/.test(rawValue) || (inline && spec.kind === 'text');
    input = document.createElement(multiline ? 'textarea' : 'input');
    if (!multiline) {
      input.type = (spec.kind === 'integer' && spec.base !== 'bigint') || spec.kind === 'year' ? 'number' : 'text';
      if (input.type === 'number') { input.step = '1'; if (spec.min) input.min = spec.min; if (spec.max) input.max = spec.max; }
      if (spec.kind === 'year') { input.min = '0'; input.max = '2155'; }
    } else input.rows = inline ? 1 : spec.kind === 'json' || spec.kind === 'binary' ? 4 : 2;
    if (['integer', 'decimal', 'float', 'year', 'bit'].includes(spec.kind)) input.inputMode = spec.kind === 'integer' || spec.kind === 'year' || spec.kind === 'bit' ? 'numeric' : 'decimal';
    input.value = rawValue;
  }
  input.id = inputId;
  input.className = inline ? 'inline-cell-editor sql-value-input' : 'sql-value-input';
  input.dataset.field = column.name;
  input.setAttribute('aria-label', `${column.name} (${column.type})`);
  input.spellcheck = false;
  if (inline) input.title = 'Enter: Lưu · Esc: Hủy · Shift+Enter: Xuống dòng';
  const control = document.createElement('div'); control.className = 'sql-value-control'; control.appendChild(input);
  element.appendChild(control);
  let picker = null;
  if (['date', 'datetime', 'time'].includes(spec.kind)) {
    picker = document.createElement('input');
    picker.className = 'sql-value-picker';
    picker.type = spec.kind === 'datetime' ? 'datetime-local' : spec.kind;
    picker.step = spec.precision ? '0.001' : '1';
    picker.title = spec.kind === 'date' ? 'Chọn ngày' : spec.kind === 'time' ? 'Chọn giờ trong ngày' : 'Chọn ngày và giờ';
    picker.setAttribute('aria-label', `${picker.title} — ${column.name}`);
    picker.value = RowValues.pickerValue(column, input.value);
    input.placeholder = spec.kind === 'date' ? 'YYYY-MM-DD' : spec.kind === 'time' ? 'HH:mm:ss' : 'YYYY-MM-DD HH:mm:ss';
    picker.addEventListener('click', () => { try { picker.showPicker?.(); } catch { /* Native keyboard editing remains available. */ } });
    picker.addEventListener('change', () => {
      input.value = RowValues.mergePickerValue(column, picker.value, input.value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    input.addEventListener('input', () => { picker.value = RowValues.pickerValue(column, input.value); });
    control.appendChild(picker);
  }
  if (!inline && (spec.hint || spec.kind === 'set')) {
    const hint = document.createElement('small'); hint.className = 'sql-value-hint'; hint.id = `${inputId}-hint`;
    hint.textContent = spec.hint || 'Chọn nhiều mục bằng Ctrl/Cmd hoặc Shift; bỏ chọn tất cả để lưu SET rỗng.';
    element.appendChild(hint); input.setAttribute('aria-describedby', hint.id);
  }
  const error = document.createElement('div'); error.className = 'sql-value-error'; error.hidden = true; error.setAttribute('role', 'alert'); element.appendChild(error);
  let busy = false;
  const updateDisabled = () => {
    modes.disabled = busy || readOnly;
    input.disabled = busy || readOnly || modes.value !== 'value';
    if (picker) picker.disabled = input.disabled;
    element.classList.toggle('sql-value-readonly', readOnly);
  };
  const clearError = () => { error.hidden = true; input.removeAttribute('aria-invalid'); };
  element.addEventListener('input', clearError);
  modes.addEventListener('change', () => { clearError(); updateDisabled(); if (!input.disabled) input.focus(); });
  updateDisabled();
  const currentRaw = () => input.multiple ? Array.from(input.selectedOptions, (option) => option.value).join(',') : input.value;
  const initialRaw = currentRaw();
  const initialMode = modes.value;
  return {
    element, input, spec, modes,
    setBusy(value) { busy = value; updateDisabled(); },
    showError(message) { error.textContent = message; error.hidden = false; input.setAttribute('aria-invalid', 'true'); },
    focus() { (input.disabled ? modes : input).focus(); if (input.tagName === 'TEXTAREA' || input.type === 'text') input.select(); },
    read() {
      if (readOnly) return { mode: 'readonly', value: originalValue, changed: false };
      if (modes.value === 'default') return { mode: 'default', changed: false };
      const raw = currentRaw();
      if (!inserting && raw === initialRaw && modes.value === initialMode) return { mode: modes.value, value: originalValue, changed: false };
      const value = RowValues.normalizeValue(column, modes.value === 'null' ? null : raw);
      return { mode: modes.value, value, changed: value !== originalValue };
    }
  };
}

function requireRowUpdate(result) {
  if (!result || Number(result.matchedRows ?? result.affectedRows) !== 1) {
    const error = new Error('Chưa xác nhận được bản ghi đã lưu. Nội dung đang sửa được giữ lại; hãy hủy chỉnh sửa và tải lại dữ liệu để kiểm tra.');
    error.code = 'ROW_NOT_FOUND';
    throw error;
  }
  return result;
}

function showRowConflict(error, { reload } = {}) {
  const conflict = error.conflict || {};
  const original = conflict.original || {};
  const current = conflict.current || {};
  const names = [...new Set([...Object.keys(original), ...Object.keys(current)])]
    .filter((name) => JSON.stringify(original[name]) !== JSON.stringify(current[name]));
  const describe = (value) => {
    if (value === null || value === undefined) return 'NULL';
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return text.length > 120 ? `${text.slice(0, 120)}…` : text;
  };
  const diffRows = names.slice(0, 15).map((name) => `
    <tr>
      <td class="mono">${esc(name)}</td>
      <td>${esc(describe(original[name]))}</td>
      <td>${esc(describe(current[name]))}</td>
    </tr>`).join('');
  const counts = [];
  if (Number(conflict.missing) > 0) counts.push(`${Number(conflict.missing)} bản ghi đã bị xóa`);
  if (Number(conflict.conflicts) > 0) counts.push(`${Number(conflict.conflicts)} bản ghi đã thay đổi`);
  const dialog = document.createElement('dialog');
  dialog.className = 'confirmation-dialog';
  dialog.innerHTML = `
    <h2>${error.code === 'ROW_NOT_FOUND' ? 'Bản ghi không còn tồn tại' : 'Bản ghi đã thay đổi'}</h2>
    <p>${esc(error.message)}</p>
    ${counts.length ? `<p class="hint">${esc(counts.join(' · '))}. Không có thay đổi nào được ghi.</p>` : ''}
    ${diffRows ? `
      <table class="mono" style="width:100%;border-collapse:collapse;margin:12px 0;font-size:12px">
        <thead><tr><th style="text-align:left">Cột</th><th style="text-align:left">Bản bạn mở</th><th style="text-align:left">Hiện tại</th></tr></thead>
        <tbody>${diffRows}</tbody>
      </table>
      ${names.length > 15 ? `<p class="hint">Còn ${names.length - 15} cột khác nhau chưa hiển thị.</p>` : ''}
    ` : ''}
    <div class="actions">
      <button type="button" id="conflictStay">Giữ nội dung đang sửa</button>
      ${reload ? '<button type="button" class="primary" id="conflictReload">Tải lại dữ liệu</button>' : '<button type="button" class="primary" id="conflictClose">Đóng</button>'}
    </div>
  `;
  document.body.appendChild(dialog);
  const close = () => { if (dialog.open) dialog.close(); dialog.remove(); };
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  dialog.querySelector('#conflictStay')?.addEventListener('click', close);
  dialog.querySelector('#conflictClose')?.addEventListener('click', close);
  dialog.querySelector('#conflictReload')?.addEventListener('click', () => {
    close();
    try { reload(); } catch { /* the grid keeps its current data if reload is unavailable */ }
  });
  dialog.showModal();
}

function startInlineValueEdit({ td, column, value, save, onSaved, next, reload }) {
  const originalDisplay = td.innerHTML;
  const editor = createRowValueEditor(column, value, { inline: true });
  if (editor.spec.readOnly) { toast(editor.spec.hint, 'error'); return; }
  td.classList.add('editing-cell');
  td.replaceChildren(editor.element);
  const actions = document.createElement('div'); actions.className = 'sql-inline-actions';
  const saveButton = document.createElement('button'); saveButton.type = 'button'; saveButton.textContent = 'Lưu';
  const cancelButton = document.createElement('button'); cancelButton.type = 'button'; cancelButton.textContent = 'Hủy';
  actions.append(saveButton, cancelButton); editor.element.appendChild(actions);
  let finished = false;
  let saving = false;
  let automaticSaveBlocked = false;
  const cancel = () => {
    if (finished || saving) return;
    finished = true; td.classList.remove('editing-cell'); td.innerHTML = originalDisplay;
  };
  const commit = async (automatic = false) => {
    if (finished || saving || automatic && automaticSaveBlocked) return false;
    let change;
    try { change = editor.read(); }
    catch (error) { automaticSaveBlocked = true; editor.showError(error.message); return false; }
    if (!change.changed) { cancel(); return true; }
    saving = true; editor.setBusy(true); saveButton.disabled = true; cancelButton.disabled = true;
    try {
      requireRowUpdate(await save(change.value));
      finished = true;
      onSaved(change.value);
      td.classList.remove('editing-cell');
      td.classList.toggle('nullcell', change.value === null);
      const text = change.value === null ? 'NULL' : String(change.value);
      td.title = text.slice(0, 500);
      td.innerHTML = change.value === null ? '<span class="null-badge">NULL</span>' : esc(text.length > 180 ? `${text.slice(0, 180)}…` : text);
      td.classList.add('cell-flash-saved'); setTimeout(() => td.classList.remove('cell-flash-saved'), 1500);
      toast(`Đã lưu cột "${column.name}"`, 'success');
      return true;
    } catch (error) {
      automaticSaveBlocked = true;
      editor.showError(error.message || 'Không lưu được dữ liệu.');
      if (error.code === 'ROW_CONFLICT' || error.code === 'ROW_NOT_FOUND') {
        showRowConflict(error, { reload: reload ? () => reload() : undefined });
      }
      return false;
    } finally { saving = false; editor.setBusy(false); saveButton.disabled = false; cancelButton.disabled = false; }
  };
  saveButton.addEventListener('click', () => { void commit(); });
  cancelButton.addEventListener('pointerdown', (event) => event.preventDefault());
  cancelButton.addEventListener('click', cancel);
  editor.element.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); }
    else if (event.key === 'Enter' && event.target.tagName !== 'BUTTON' && (!event.shiftKey || event.ctrlKey || event.metaKey)) { event.preventDefault(); void commit(); }
    else if (event.key === 'Tab') {
      const controls = Array.from(editor.element.querySelectorAll('input,textarea,select,button')).filter((control) => !control.disabled);
      if (event.target === (event.shiftKey ? controls[0] : controls.at(-1))) {
        event.preventDefault();
        void commit().then((saved) => { if (saved) next?.(event.shiftKey); });
      }
    }
  });
  editor.element.addEventListener('focusout', () => {
    if (finished || saving || automaticSaveBlocked) return;
    setTimeout(() => { if (!editor.element.contains(document.activeElement)) void commit(true); }, 0);
  });
  editor.focus();
}

async function inlineEditCell(td) {
  if (connectionIsReadOnly()) { toast('Kết nối đang ở chế độ chỉ đọc.', 'error'); return; }
  if (!td || td.classList.contains('editing-cell')) return;
  const name = td.dataset.col;
  const index = Number(td.dataset.row);
  const row = app.rows[index];
  if (!name || !row) return;
  if (!app.primaryKey.length) { toast('Bảng không có khóa chính nên không thể sửa trực tiếp.', 'error'); return; }
  const column = app.columns.find((entry) => entry.name === name);
  if (!column) { toast('Không đọc được kiểu dữ liệu của cột. Hãy làm mới bảng.', 'error'); return; }
  const profileId = app.connection?.id || null;
  const database = app.database;
  const targetTable = table;
  const keys = Object.fromEntries(app.primaryKey.map((key) => [key, row[key]]));
  startInlineValueEdit({
    td, column, value: row[name],
    save: (value) => call(desktop.db.updateRow({ profileId, database, table: targetTable, keys, values: { [name]: value }, original: originalRow(row) })),
    onSaved: (value) => { row[name] = value; },
    reload: () => loadData({ keepScroll: true }),
    next: (previous) => {
      const next = previous ? td.previousElementSibling : td.nextElementSibling;
      if (next?.dataset.col) void inlineEditCell(next);
    }
  });
}

function tableSorts() {
  return app.sorts || (app.orderBy ? [{ column: app.orderBy, direction: app.orderDir || 'ASC' }] : []);
}

function applyTablePreference(preference) {
  app.visibleColumns = preference.visibleColumns;
  app.sorts = preference.sorts;
  app.orderBy = null; app.orderDir = 'ASC';
  if (preference.filters) Object.assign(app, preference.filters);
  app.page = 1; app.pageCursor = null; app.nextCursor = null; app.previousCursor = null;
  app.hasMore = undefined; app.total = null;
}

function tablePreferenceDialog() {
  const Preferences = window.SqlTablePreferences;
  const scope = { profileId: app.connection?.id, database: app.database, table };
  const snapshot = { visibleColumns: app.visibleColumns, sorts: tableSorts(), search: app.search, searchColumn: app.searchColumn, searchMode: app.searchMode, filterTree: app.filterTree };
  const columns = app.columns;
  if (!columns.length) return;
  modal(`<div id="tablePreferenceEditor"><h2>Cấu hình bảng đã lưu</h2><p>${esc(scope.database)}.${esc(scope.table)}</p>
    <p>Lưu cục bộ cho kết nối và bảng này, tự áp dụng khi mở lại. Mỗi bảng giữ một cấu hình; lưu tiếp sẽ thay cấu hình cũ.</p>
    <p>Mặc định chỉ lưu cột hiển thị và sắp xếp. Chọn bên dưới để lưu cả tìm kiếm nhanh và bộ lọc AND/OR đang áp dụng.</p>
    <label><input type="checkbox" id="saveTableFilterValues"> Lưu cả bộ lọc và giá trị lọc vào tệp cục bộ (có thể chứa dữ liệu nhạy cảm)</label>
    <p id="tablePreferenceStatus" role="status" aria-live="polite">Đang đọc cấu hình…</p>
    <p>Nếu cấu hình không có bộ lọc, áp dụng tại đây giữ bộ lọc hiện tại. Xóa cấu hình đã lưu không thay đổi dữ liệu hoặc bộ lọc đang xem.</p>
    <div class="actions"><button type="button" id="removeTablePreference" disabled>Xóa cấu hình đã lưu</button><button type="button" data-click="close-modal">Đóng</button><button type="button" id="restoreTablePreference" disabled>Áp dụng bản đã lưu</button><button type="button" class="primary" id="saveTablePreference" disabled>Lưu cấu hình hiện tại</button></div></div>`, true);
  const editor = $('#tablePreferenceEditor');
  const current = () => editor.isConnected && $('#tablePreferenceEditor') === editor && mode === 'data'
    && scope.profileId === app.connection?.id && scope.database === app.database && scope.table === table
    && snapshot.visibleColumns === app.visibleColumns && snapshot.filterTree === app.filterTree
    && snapshot.search === app.search && snapshot.searchColumn === app.searchColumn && snapshot.searchMode === app.searchMode
    && JSON.stringify(snapshot.sorts) === JSON.stringify(tableSorts());
  let record = null, busy = false;
  const status = message => { editor.querySelector('#tablePreferenceStatus').textContent = message; };
  const buttons = enabled => {
    editor.querySelector('#saveTablePreference').disabled = !enabled;
    editor.querySelector('#restoreTablePreference').disabled = !enabled || !record;
    editor.querySelector('#removeTablePreference').disabled = !enabled || !record;
  };
  const run = async action => {
    if (busy) return;
    if (!current()) { buttons(false); status('Đích hoặc cấu hình đã thay đổi. Hãy đóng và mở lại.'); return; }
    busy = true; buttons(false);
    try {
      await action();
    } catch (error) { if (editor.isConnected && $('#tablePreferenceEditor') === editor) status(error.message); }
    finally { busy = false; if (current()) buttons(true); }
  };
  editor.querySelector('#saveTablePreference').addEventListener('click', () => void run(async () => {
    const preference = Preferences.capture(snapshot, columns, editor.querySelector('#saveTableFilterValues').checked);
    Preferences.normalize(preference, app.columns);
    const saved = await call(desktop.tablePreferences.save(scope, preference));
    if (!current()) return;
    record = saved; status(`Đã lưu ${saved.view.filters ? 'bố cục và bộ lọc' : 'bố cục, không lưu bộ lọc'}.`);
  }));
  editor.querySelector('#removeTablePreference').addEventListener('click', () => void run(async () => {
    await call(desktop.tablePreferences.remove(scope));
    if (!current()) return;
    record = null; status('Đã xóa cấu hình đã lưu. Cấu hình đang xem được giữ nguyên.');
  }));
  editor.querySelector('#restoreTablePreference').addEventListener('click', () => void run(async () => {
    const preference = Preferences.normalize(record.view, app.columns);
    applyTablePreference(preference); closeModal(); await loadData();
  }));
  void run(async () => {
    const saved = await call(desktop.tablePreferences.read(scope));
    if (!current()) return;
    record = saved;
    status(saved ? `Đã có cấu hình: ${saved.view.filters ? 'gồm bộ lọc và giá trị lọc' : 'chỉ bố cục'}. Lần lưu: ${saved.updatedAt}` : 'Chưa có cấu hình đã lưu cho bảng này.');
  });
}

function tableViewDialog() {
  const View = window.SqlTableView;
  const target = { profileId: app.connection?.id, database: app.database, table, visible: app.visibleColumns, sorts: app.sorts, orderBy: app.orderBy, orderDir: app.orderDir };
  const current = () => mode === 'data' && target.profileId === app.connection?.id && target.database === app.database && target.table === table
    && target.visible === app.visibleColumns && target.sorts === app.sorts && target.orderBy === app.orderBy && target.orderDir === app.orderDir;
  if (!app.columns.length) return;
  const selected = new Set(View.visible(app.visibleColumns, app.columns).map(column => column.name));
  const sorts = tableSorts().map(entry => ({ ...entry }));
  modal(`<div id="tableViewEditor"><h2>Cột và sắp xếp</h2><p>${esc(app.database)}.${esc(table)}</p>
    <h3>Cột hiển thị</h3><p>Ẩn cột chỉ thay cách hiển thị; dữ liệu dòng và khóa chính vẫn được giữ để chỉnh sửa.</p>
    <div class="table-view-actions"><button type="button" id="showAllViewColumns">Chọn tất cả</button><button type="button" id="hideAllViewColumns">Bỏ chọn tất cả</button></div>
    <div id="viewColumnChoices" class="view-column-choices">${app.columns.map((column, index) => `<label><input type="checkbox" data-view-column="${index}" ${selected.has(column.name) ? 'checked' : ''}><span>${esc(column.name)}</span></label>`).join('')}</div>
    <h3>Thứ tự ưu tiên sắp xếp</h3><p>Tối đa 5 cột. Khóa chính còn thiếu được thêm làm thứ tự phụ; không có khóa duy nhất thì thứ tự các dòng bằng nhau có thể thay đổi.</p>
    <div id="viewSortRows"></div><div class="table-view-actions"><button type="button" id="addViewSort">＋ Cột sắp xếp</button><button type="button" id="clearViewSort">Xóa sắp xếp</button></div>
    <p id="viewConfigError" role="status" aria-live="polite"></p><div class="actions"><button type="button" data-click="close-modal">Hủy</button><button type="button" class="primary" id="applyTableView">Áp dụng (Ctrl+Enter)</button></div></div>`, true);
  const editor = $('#tableViewEditor'), columns = [...app.columns];
  const validate = () => {
    try {
      if (!current()) throw new Error('Đích hoặc cấu hình đã thay đổi. Hãy đóng và mở lại.');
      const names = columns.filter(column => selected.has(column.name)).map(column => column.name);
      if (!names.length || names.some(name => !app.columns.some(column => column.name === name))) throw new Error('Chọn ít nhất một cột còn tồn tại.');
      const normalized = View.normalizeSorts(sorts, app.columns);
      $('#viewConfigError').textContent = ''; $('#applyTableView').disabled = false;
      return { names, normalized };
    } catch (error) { $('#viewConfigError').textContent = error.message; $('#applyTableView').disabled = true; return null; }
  };
  const renderSorts = () => {
    $('#viewSortRows').innerHTML = sorts.map((entry, index) => `<div class="view-sort-row" data-view-sort="${index}"><span>${index + 1}.</span>
      <select data-view-sort-field="column" aria-label="Cột sắp xếp ${index + 1}">${columns.map(column => `<option value="${esc(column.name)}" ${column.name === entry.column ? 'selected' : ''}>${esc(column.name)}</option>`).join('')}</select>
      <select data-view-sort-field="direction" aria-label="Hướng sắp xếp ${index + 1}"><option value="ASC" ${entry.direction === 'ASC' ? 'selected' : ''}>ASC — Tăng</option><option value="DESC" ${entry.direction === 'DESC' ? 'selected' : ''}>DESC — Giảm</option></select>
      <button type="button" data-view-sort-action="up" ${index ? '' : 'disabled'} aria-label="Ưu tiên cao hơn">↑</button><button type="button" data-view-sort-action="down" ${index < sorts.length - 1 ? '' : 'disabled'} aria-label="Ưu tiên thấp hơn">↓</button><button type="button" data-view-sort-action="remove" aria-label="Xóa cột sắp xếp">×</button></div>`).join('');
    $('#addViewSort').disabled = sorts.length >= 5 || sorts.length >= columns.length;
    validate();
  };
  editor.addEventListener('change', event => {
    const checkbox = event.target.closest('[data-view-column]');
    if (checkbox) {
      const name = columns[Number(checkbox.dataset.viewColumn)]?.name;
      if (name !== undefined) checkbox.checked ? selected.add(name) : selected.delete(name);
      validate(); return;
    }
    const control = event.target.closest('[data-view-sort-field]');
    const entry = control && sorts[Number(control.closest('[data-view-sort]').dataset.viewSort)];
    if (entry) { entry[control.dataset.viewSortField] = control.value; validate(); }
  });
  editor.addEventListener('click', event => {
    const button = event.target.closest('[data-view-sort-action]');
    if (!button) return;
    const index = Number(button.closest('[data-view-sort]').dataset.viewSort), action = button.dataset.viewSortAction;
    if (!sorts[index]) return;
    if (action === 'remove') sorts.splice(index, 1);
    else {
      const next = index + (action === 'up' ? -1 : 1);
      if (next >= 0 && next < sorts.length) [sorts[index], sorts[next]] = [sorts[next], sorts[index]];
    }
    renderSorts(); $('#addViewSort').focus();
  });
  const toggle = checked => { editor.querySelectorAll('[data-view-column]').forEach(input => { input.checked = checked; }); selected.clear(); if (checked) columns.forEach(column => selected.add(column.name)); validate(); };
  $('#showAllViewColumns').addEventListener('click', () => toggle(true));
  $('#hideAllViewColumns').addEventListener('click', () => toggle(false));
  $('#addViewSort').addEventListener('click', () => {
    const column = columns.find(column => !sorts.some(entry => entry.column === column.name));
    if (sorts.length >= 5 || !column) return;
    sorts.push({ column: column.name, direction: 'ASC' }); renderSorts();
    editor.querySelector(`[data-view-sort="${sorts.length - 1}"] select`)?.focus();
  });
  $('#clearViewSort').addEventListener('click', () => { sorts.length = 0; renderSorts(); });
  const apply = () => {
    const result = validate(); if (!result) return;
    app.visibleColumns = Object.freeze(result.names); app.sorts = result.normalized;
    app.orderBy = null; app.orderDir = 'ASC'; app.page = 1; app.pageCursor = null;
    closeModal(); void loadData();
  };
  $('#applyTableView').addEventListener('click', apply);
  editor.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); apply(); } });
  renderSorts(); editor.querySelector('input')?.focus();
}

function tableFilterDialog() {
  const Filters = window.SqlTableFilters;
  const target = { profileId: app.connection?.id, database: app.database, table, tree: app.filterTree };
  const current = () => mode === 'data' && target.profileId === app.connection?.id && target.database === app.database && target.table === table && target.tree === app.filterTree;
  if (!app.columns.length) return;
  const firstRule = () => {
    const column = app.columns[0], operator = Filters.operators(column)[0];
    return { column: column.name, operator, ...(!['is-null', 'not-null'].includes(operator) ? { value: '' } : {}) };
  };
  const draft = app.filterTree ? JSON.parse(JSON.stringify(app.filterTree)) : { version: 1, op: 'AND', items: [firstRule()] };
  modal(`<div id="tableFilterEditor"><h2>Bộ lọc AND/OR</h2><p>${esc(target.database)}.${esc(target.table)} · Tối đa 20 điều kiện, 8 nhóm, 3 mức.</p>
    <div id="filterGroups"></div><p class="hint">Kết hợp AND với tìm nhanh. IN/NOT IN: mỗi ô là một giá trị, tối đa 20 ô/danh sách, 100 giá trị/bộ lọc. Giữ khoảng trắng và chuỗi rỗng; IN/NOT IN không chọn dòng NULL, hãy thêm điều kiện Là NULL bằng OR nếu cần. Ngày giờ theo phiên database.</p>
    <pre id="groupFilterPreview" class="group-filter-preview" aria-label="Xem trước điều kiện"></pre><p id="groupFilterError" role="status" aria-live="polite"></p>
    <div class="actions"><button type="button" id="removeGroupFilter">Xóa bộ lọc AND/OR</button><button type="button" data-click="close-modal">Hủy</button><button type="button" class="primary" id="applyGroupFilter">Áp dụng (Ctrl+Enter)</button></div></div>`, true);
  const editor = $('#tableFilterEditor');
  const nodeAt = path => path.reduce((node, index) => node?.items?.[index], draft);
  const counts = (node = draft) => node.items ? node.items.reduce((total, item) => {
    const count = counts(item); return { groups: total.groups + count.groups, rules: total.rules + count.rules };
  }, { groups: 1, rules: 0 }) : { groups: 0, rules: 1 };
  const preview = () => {
    try {
      if (!current()) throw new Error('Đích hoặc bộ lọc đã thay đổi. Hãy đóng và mở lại hộp thoại.');
      const plan = Filters.compile(draft, app.columns);
      $('#groupFilterPreview').textContent = `WHERE ${plan.where}\n${plan.params.length} giá trị được truyền riêng.`;
      $('#groupFilterError').textContent = ''; $('#applyGroupFilter').disabled = false;
      return plan.tree;
    } catch (error) {
      $('#groupFilterPreview').textContent = ''; $('#groupFilterError').textContent = error.message; $('#applyGroupFilter').disabled = true;
      return null;
    }
  };
  const render = () => {
    const count = counts();
    const html = (node, path = []) => {
      const key = path.join('.');
      if (node.items) return `<fieldset class="filter-group" data-filter-path="${key}"><legend>${path.length ? 'Nhóm điều kiện' : 'Điều kiện gốc'}</legend>
        <div class="filter-group-actions"><select data-filter-field="op" data-filter-path="${key}" aria-label="Kết hợp nhóm"><option value="AND" ${node.op === 'AND' ? 'selected' : ''}>AND — Tất cả</option><option value="OR" ${node.op === 'OR' ? 'selected' : ''}>OR — Bất kỳ</option></select>
        <button type="button" data-filter-action="rule" data-filter-path="${key}" ${count.rules >= Filters.limits.rules ? 'disabled' : ''}>＋ Điều kiện</button>
        <button type="button" data-filter-action="group" data-filter-path="${key}" ${path.length >= 2 || count.groups >= Filters.limits.groups || count.rules >= Filters.limits.rules ? 'disabled' : ''}>＋ Nhóm</button>
        ${path.length ? `<button type="button" data-filter-action="remove" data-filter-path="${key}">Xóa nhóm</button>` : ''}</div>
        ${node.items.map((item, index) => html(item, [...path, index])).join('')}</fieldset>`;
      const column = app.columns.find(entry => entry.name === node.column), operators = Filters.operators(column || {});
      const isNull = ['is-null', 'not-null'].includes(node.operator), between = node.operator === 'between', list = ['in', 'not-in'].includes(node.operator);
      const values = between || list ? node.value : [node.value];
      const input = (value, index) => `<input type="text" maxlength="200" value="${esc(value ?? '')}" data-filter-field="value" data-filter-index="${index}" data-filter-path="${key}" aria-label="${list ? `Giá trị danh sách ${index + 1}` : between ? index ? 'Đến giá trị' : 'Từ giá trị' : 'Giá trị điều kiện'}" placeholder="${between ? index ? 'Đến' : 'Từ' : 'Giá trị'}">`;
      return `<div class="filter-rule"><select data-filter-field="column" data-filter-path="${key}" aria-label="Cột điều kiện">${app.columns.map(entry => `<option value="${esc(entry.name)}" ${node.column === entry.name ? 'selected' : ''}>${esc(entry.name)}</option>`).join('')}</select>
        <select data-filter-field="operator" data-filter-path="${key}" aria-label="Toán tử điều kiện">${operators.map(operator => `<option value="${operator}" ${node.operator === operator ? 'selected' : ''}>${esc(Filters.labels[operator])}</option>`).join('')}</select>
        ${isNull ? '<span class="muted">Không cần giá trị</span>' : list ? `<div class="filter-list-values">${(Array.isArray(values) ? values : []).map((value, index) => `<div class="filter-list-value">${input(value, index)}<button type="button" data-filter-action="remove-value" data-filter-index="${index}" data-filter-path="${key}" aria-label="Xóa giá trị ${index + 1}">×</button></div>`).join('')}<button type="button" data-filter-action="add-value" data-filter-path="${key}" ${values?.length >= Filters.limits.list ? 'disabled' : ''}>＋ Giá trị</button></div>` : (Array.isArray(values) ? values : ['', '']).map(input).join('')}
        <button type="button" data-filter-action="remove" data-filter-path="${key}" aria-label="Xóa điều kiện">×</button></div>`;
    };
    $('#filterGroups').innerHTML = html(draft); preview();
  };
  const pathOf = element => /^(?:[0-9]+(?:\.[0-9]+)*)?$/.test(element.dataset.filterPath || '')
    ? (element.dataset.filterPath ? element.dataset.filterPath.split('.').map(Number) : []) : null;
  editor.addEventListener('click', event => {
    const button = event.target.closest('[data-filter-action]');
    if (!button) return;
    const path = pathOf(button), node = path && nodeAt(path);
    if (!node || !current()) { preview(); return; }
    const action = button.dataset.filterAction, count = counts();
    if (action === 'rule' && node.items && count.rules < Filters.limits.rules) node.items.push(firstRule());
    else if (action === 'group' && node.items && path.length < 2 && count.groups < Filters.limits.groups && count.rules < Filters.limits.rules) node.items.push({ op: 'AND', items: [firstRule()] });
    else if (action === 'remove' && path.length) nodeAt(path.slice(0, -1)).items.splice(path.at(-1), 1);
    else if (['in', 'not-in'].includes(node.operator) && Array.isArray(node.value)) {
      if (action === 'add-value' && node.value.length < Filters.limits.list) node.value.push('');
      else if (action === 'remove-value') {
        const index = Number(button.dataset.filterIndex);
        if (Number.isInteger(index) && index >= 0 && index < node.value.length) node.value.splice(index, 1);
      }
    }
    render();
    if (action === 'add-value') editor.querySelector(`[data-filter-field="value"][data-filter-path="${path.join('.')}"][data-filter-index="${node.value.length - 1}"]`)?.focus();
    else if (action === 'remove-value') editor.querySelector(`[data-filter-action="add-value"][data-filter-path="${path.join('.')}"]`)?.focus();
  });
  const edit = event => {
    const control = event.target.closest('[data-filter-field]');
    if (!control) return;
    const path = pathOf(control), node = path && nodeAt(path), field = control.dataset.filterField;
    if (!node || !current()) { preview(); return; }
    if (field === 'value' && event.type === 'input') {
      if (['between', 'in', 'not-in'].includes(node.operator)) node.value[Number(control.dataset.filterIndex)] = control.value;
      else node.value = control.value;
      preview();
    } else if (event.type === 'change' && field !== 'value') {
      if (field === 'op') node.op = control.value;
      else {
        if (field === 'column') { node.column = control.value; node.operator = Filters.operators(app.columns.find(column => column.name === node.column) || {})[0]; }
        else node.operator = control.value;
        if (['is-null', 'not-null'].includes(node.operator)) delete node.value;
        else node.value = node.operator === 'between' ? ['', ''] : ['in', 'not-in'].includes(node.operator) ? [''] : '';
      }
      render();
      editor.querySelector(`[data-filter-field="${field}"][data-filter-path="${path.join('.')}"]`)?.focus();
    }
  };
  editor.addEventListener('input', edit); editor.addEventListener('change', edit);
  const apply = () => {
    const tree = preview(); if (!tree || !current()) return;
    app.filterTree = tree; app.page = 1; app.pageCursor = null; closeModal(); void loadData();
  };
  $('#applyGroupFilter').addEventListener('click', apply);
  $('#removeGroupFilter').addEventListener('click', () => {
    if (!current()) { preview(); return; }
    app.filterTree = null; app.page = 1; app.pageCursor = null; closeModal(); void loadData();
  });
  editor.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); apply(); }
  });
  render(); editor.querySelector('select')?.focus();
}

function tableSearchSummary(state) {
  if (state.searchMode === 'is-null' || state.searchMode === 'not-null') {
    return state.searchColumn ? `${state.searchColumn} ${state.searchMode === 'is-null' ? 'là NULL' : 'khác NULL'}` : '';
  }
  if (!String(state.search || '').trim()) return '';
  const label = { contains: 'Chứa', exact: 'Bằng', prefix: 'Bắt đầu bằng' }[state.searchMode] || 'Chứa';
  return `${state.search} · ${label}${state.searchColumn ? ` · ${state.searchColumn}` : ''}`;
}

function renderDataView() {
  const readOnly = connectionIsReadOnly();
  const editable = !readOnly && app.primaryKey.length > 0;
  const nullSearch = app.searchMode === 'is-null' || app.searchMode === 'not-null';
  const canResetSearch = Boolean(app.filterTree || app.search || app.searchColumn || app.searchMode && app.searchMode !== 'contains');
  $('#workspace').innerHTML = `
    <div class="toolbar">
      <input class="filter" id="filter" aria-label="Giá trị tìm kiếm" maxlength="200" placeholder="${nullSearch ? 'Không cần nhập giá trị' : '⌕  Tìm trong bảng…'}" value="${esc(app.search)}" ${nullSearch ? 'disabled' : ''} title="Tối đa 200 ký tự; % và _ là ký tự thường.">
      <select id="filterColumn" aria-label="Cột tìm kiếm"><option value="">Tất cả cột</option>${app.columns.map((column) => `<option value="${esc(column.name)}" ${app.searchColumn === column.name ? 'selected' : ''}>${esc(column.name)}</option>`).join('')}</select>
      <select id="filterMode" aria-label="Cách tìm kiếm"><option value="contains">Chứa</option><option value="exact" ${app.searchMode === 'exact' ? 'selected' : ''}>Bằng</option><option value="prefix" ${app.searchMode === 'prefix' ? 'selected' : ''}>Bắt đầu bằng</option><option value="is-null" ${nullSearch && app.searchMode === 'is-null' ? 'selected' : ''} ${app.searchColumn ? '' : 'disabled'}>Là NULL</option><option value="not-null" ${app.searchMode === 'not-null' ? 'selected' : ''} ${app.searchColumn ? '' : 'disabled'}>Khác NULL</option></select>
      <button id="clearFilterBtn" type="button" ${canResetSearch ? '' : 'disabled'}>Đặt lại bộ lọc</button>
      <button id="groupFilterBtn" type="button">Bộ lọc AND/OR${app.filterTree ? ' · đang bật' : ''}</button>
      <button id="tableViewBtn" type="button">Cột / Sắp xếp${tableSorts().length > 1 ? ` · ${tableSorts().length}` : ''}</button>
      <button id="tablePreferenceBtn" type="button">Cấu hình đã lưu</button>
      <button id="addRowBtn" ${readOnly ? 'disabled title="Kết nối chỉ đọc"' : ''}>＋ Thêm bản ghi</button>
      <button class="danger" id="deleteRowsBtn" ${editable ? '' : `disabled title="${readOnly ? 'Kết nối chỉ đọc' : 'Bảng không có khóa chính'}"`}>⌫ Xóa</button>
      <button id="refreshBtn">↻</button>
      <button id="importBtn" ${readOnly ? 'disabled title="Kết nối chỉ đọc"' : ''}>↥ Nhập</button>
      <button id="exportBtn">↧ Xuất</button>
      <button id="maskDataBtn" class="${app.maskData ? 'active' : ''}" title="Bật/Tắt che giấu dữ liệu nhạy cảm PII (Email, SĐT, Thẻ, Mật khẩu)">🎭 ${app.maskData ? 'Đang che PII' : 'Che PII'}</button>
    </div>
    <div id="grid">${dataGridHtml()}</div>
    <div class="hint">
      ${editable
        ? 'ⓘ <span><strong>Chỉnh sửa thật</strong> &nbsp; Nhấp đúp vào một dòng để sửa. Thay đổi ghi trực tiếp vào database.</span>'
        : readOnly ? 'ⓘ <span><strong>Kết nối chỉ đọc</strong> &nbsp; Có thể xem, lọc và xuất dữ liệu.</span>' : 'ⓘ <span><strong>Chỉ đọc</strong> &nbsp; Bảng không có khóa chính nên không thể sửa/xóa trực tiếp từ lưới.</span>'}
    </div>
  `;
  const filter = $('#filter');
  const target = { profileId: app.connection?.id, database: app.database, table };
  const current = () => mode === 'data' && target.profileId === app.connection?.id && target.database === app.database && target.table === table;
  filter.addEventListener('input', debounce(() => {
    if (!current() || $('#filter') !== filter || filter.disabled) return;
    app.search = filter.value;
    const search = app.search, searchColumn = app.searchColumn, searchMode = app.searchMode, filterTree = app.filterTree;
    app.page = 1;
    app.pageCursor = null;
    loadData().then(() => {
      if (!current() || search !== app.search || searchColumn !== app.searchColumn || searchMode !== app.searchMode || filterTree !== app.filterTree) return;
      const next = $('#filter');
      if (next && !next.disabled) {
        next.focus();
        next.setSelectionRange(next.value.length, next.value.length);
      }
    });
  }, 350));
  for (const selector of ['#filterColumn', '#filterMode']) $(selector).addEventListener('change', () => {
    if (!current() || $('#filter') !== filter) return;
    app.searchColumn = $('#filterColumn').value || null;
    app.searchMode = $('#filterMode').value;
    if (!app.searchColumn && ['is-null', 'not-null'].includes(app.searchMode)) app.searchMode = 'contains';
    app.search = ['is-null', 'not-null'].includes(app.searchMode) ? '' : filter.value;
    app.page = 1; app.pageCursor = null; void loadData();
  });
  $('#clearFilterBtn').addEventListener('click', () => {
    if (!current()) return;
    app.search = ''; app.searchColumn = null; app.searchMode = 'contains';
    app.filterTree = null;
    app.page = 1; app.pageCursor = null; void loadData();
  });
  $('#groupFilterBtn').addEventListener('click', tableFilterDialog);
  $('#tableViewBtn').addEventListener('click', tableViewDialog);
  $('#tablePreferenceBtn').addEventListener('click', tablePreferenceDialog);
  $('#addRowBtn').addEventListener('click', () => editRow(null));
  $('#deleteRowsBtn').addEventListener('click', deleteSelectedRows);
  $('#refreshBtn').addEventListener('click', () => loadData());
  $('#importBtn').addEventListener('click', () => transfer('import'));
  $('#exportBtn').addEventListener('click', () => transfer('export'));
  $('#maskDataBtn')?.addEventListener('click', () => {
    app.maskData = !app.maskData;
    $('#grid').innerHTML = dataGridHtml();
    const btn = $('#maskDataBtn');
    if (btn) {
      btn.className = app.maskData ? 'active' : '';
      btn.textContent = `🎭 ${app.maskData ? 'Đang che PII' : 'Che PII'}`;
    }
    toast(app.maskData ? 'Đã bật che giấu dữ liệu nhạy cảm PII' : 'Đã tắt che giấu dữ liệu', 'info');
    persistState();
  });
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
  const visible = window.SqlTableView.visible(app.visibleColumns, app.columns), sorts = tableSorts();
  const pageCount = app.total === null ? null : Math.max(1, Math.ceil(app.total / app.pageSize));
  const header = `
    <tr>
      <th>${editable ? '<input type="checkbox" id="selectAllRows" aria-label="Chọn tất cả">' : ''}</th>
      ${visible.map((column) => {
        const index = sorts.findIndex(entry => entry.column === column.name), direction = sorts[index]?.direction;
        const sortClass = direction ? direction === 'ASC' ? 'sortable sorted-asc' : 'sortable sorted-desc' : 'sortable';
        const sortArrow = direction ? `<span class="sort-arrow">${direction === 'ASC' ? '▲' : '▼'}${sorts.length > 1 ? index + 1 : ''}</span>` : '';
        return `<th class="${sortClass}" tabindex="0" data-sort="${esc(column.name)}" title="Bấm hoặc Enter để sắp xếp riêng cột ${esc(column.name)}">${esc(column.name)} <small>${esc(column.type)}</small>${sortArrow}</th>`;
      }).join('')}
    </tr>
  `;
  const body = app.rows.map((row, index) => `
    <tr data-row="${index}">
      <td>${editable ? `<input class="rowcheck" type="checkbox" value="${index}" aria-label="Chọn bản ghi ${index + 1}">` : ''}</td>
      ${visible.map((column) => {
        let value = row[column.name];
        if (app.maskData && typeof SqlDataMasking !== 'undefined') {
          const rule = SqlDataMasking.detectMaskType(column.name, column.type);
          if (rule) value = SqlDataMasking.maskValue(value, rule);
        }
        const isNull = value === null || value === undefined;
        const text = isNull ? 'NULL' : String(value);
        const shown = text.length > 180 ? `${text.slice(0, 180)}…` : text;
        const cellDisplay = isNull ? '<span class="null-badge">NULL</span>' : esc(shown);
        return `<td class="${isNull ? 'nullcell' : ''}" data-row="${index}" data-col="${esc(column.name)}" title="${esc(text.slice(0, 500))}">${cellDisplay}</td>`;
      }).join('')}
    </tr>
  `).join('') || `<tr><td colspan="${visible.length + 1}" class="empty">Không có dữ liệu phù hợp.</td></tr>`;
  return `<div class="tablebox"><table><thead>${header}</thead><tbody>${body}</tbody></table></div>
    <div class="pagination">
      <span>${app.total === null ? 'Chưa đếm tổng' : `${app.total} bản ghi`} <button id="countRowsBtn" type="button">${app.total === null ? 'Đếm tổng' : 'Đếm lại'}</button> <span style="margin:0 10px">·</span> ${app.pageSize} dòng / trang</span>
      <div>
        <button id="prevPage" ${app.page <= 1 ? 'disabled' : ''}>‹</button>
        <span class="pageinfo">${app.page}${pageCountText()}</span>
        <button id="nextPage" ${(app.hasMore === false || (app.hasMore !== true && pageCount !== null && app.page >= pageCount)) ? 'disabled' : ''}>›</button>
      </div>
    </div>`;
}

function pageCountText() {
  const count = app.total === null ? null : Math.max(1, Math.ceil(app.total / app.pageSize));
  return count === null ? '' : ` / ${count}`;
}

function positionPagination() {
  $('#countRowsBtn')?.addEventListener('click', async () => {
    const target = { profileId: app.connection?.id, database: app.database, table, search: app.search, searchColumn: app.searchColumn || null, searchMode: app.searchMode || 'contains', filterTree: app.filterTree || null, force: true };
    const button = $('#countRowsBtn');
    button.disabled = true;
    try {
      const result = await call(desktop.db.tableCount(target));
      if (target.profileId !== app.connection?.id || target.database !== app.database || target.table !== table || target.search !== app.search || target.searchColumn !== (app.searchColumn || null) || target.searchMode !== (app.searchMode || 'contains') || target.filterTree !== (app.filterTree || null)) return;
      app.total = result.total; renderDataView();
    } catch (error) { toast(error.message, 'error'); }
    finally { button.disabled = false; }
  });
  const selectAll = $('#selectAllRows');
  if (selectAll) {
    selectAll.addEventListener('change', () => {
      document.querySelectorAll('.rowcheck').forEach((checkbox) => { checkbox.checked = selectAll.checked; });
    });
  }
  document.querySelectorAll('th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      app.sorts = null;
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
      app.pageCursor = null;
      loadData({ keepScroll: true });
    });
    th.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); th.click(); } });
  });
  const previous = $('#prevPage');
  const next = $('#nextPage');
  if (previous) previous.addEventListener('click', () => {
    if (app.page <= 1) return;
    app.page -= 1;
    app.pageCursor = app.previousCursor || null;
    loadData();
  });
  if (next) next.addEventListener('click', () => {
    const count = app.total === null ? null : Math.max(1, Math.ceil(app.total / app.pageSize));
    if (app.hasMore === false || (app.hasMore !== true && count !== null && app.page >= count)) return;
    app.page += 1;
    app.pageCursor = app.nextCursor || null;
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
        <button class="close-btn" data-click="close-modal">✕</button>
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
        <button data-click="close-modal">Hủy</button>
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
      await call(desktop.db.query({ ...activeQueryTarget(), sql, confirmed: true }));
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
        <button class="close-btn" data-click="close-modal">✕</button>
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
        <button data-click="close-modal">Hủy</button>
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
      await call(desktop.db.query({ ...activeQueryTarget(), sql, confirmed: true }));
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
        <button class="close-btn" data-click="close-modal">✕</button>
      </div>
      <div class="modal-body" style="padding:16px;">
        <div class="form-group">
          <label style="display:block; margin-bottom:4px; font-weight:500;">Tên mới:</label>
          <input type="text" id="renamedColName" value="${esc(oldName)}" style="width:100%; padding:7px 10px; background:#111827; border:1px solid #374151; border-radius:4px; color:#fff;" required>
        </div>
      </div>
      <div class="modal-footer" style="text-align: right; margin-top: 16px;">
        <button data-click="close-modal">Hủy</button>
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
      await call(desktop.db.query({ ...activeQueryTarget(), sql: `ALTER TABLE ${quoteId(database)}.${quoteId(currentTable)} RENAME COLUMN ${quoteId(oldName)} TO ${quoteId(newName)}`, confirmed: true }));
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
    await call(desktop.db.query({ ...activeQueryTarget(), sql: `ALTER TABLE ${quoteId(database)}.${quoteId(currentTable)} DROP COLUMN ${quoteId(colName)}`, confirmed: true }));
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
        <button class="close-btn" data-click="close-modal">✕</button>
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
        <button data-click="close-modal">Hủy</button>
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
      await call(desktop.db.query({ ...activeQueryTarget(), sql, confirmed: true }));
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
    await call(desktop.db.query({ ...activeQueryTarget(), sql: `DROP INDEX ${quoteId(indexName)} ON ${target}`, confirmed: true }));
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
    tablesList = await call(desktop.db.tables(database, app.connection?.id || null));
  } catch (err) {
    tablesList = [];
  }

  modal(`
    <div class="modal-card" style="max-width:580px;">
      <div class="modal-header">
        <h3>➕ Thêm Khóa Ngoại (Foreign Key)</h3>
        <button class="close-btn" data-click="close-modal">✕</button>
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
        <button data-click="close-modal">Hủy</button>
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
      await call(desktop.db.query({ ...activeQueryTarget(), sql, confirmed: true }));
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
    await call(desktop.db.query({ ...activeQueryTarget(), sql: `ALTER TABLE ${target} DROP FOREIGN KEY ${quoteId(constraintName)}`, confirmed: true }));
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
  modal(`<h2>DDL · ${esc(table)}</h2><p>SQL minh họa cấu trúc bảng.</p><pre class="mono ddl">${esc(ddl)}</pre><div class="actions"><button data-click="close-modal">Đóng</button></div>`, true);
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

const SQL_UNDO_MAX_STEPS = 100;
const SQL_UNDO_MAX_CHARS = 2_000_000;

function sqlEditorSnapshot(editor) {
  return { value: editor.value, start: editor.selectionStart, end: editor.selectionEnd };
}

function sqlEditorHistory(tab, editor) {
  if (!tab.sqlHistory) {
    tab.sqlHistory = { past: [], current: sqlEditorSnapshot(editor), future: [], lastInput: null, beforeSelection: null };
  }
  return tab.sqlHistory;
}

function trimSqlEditorHistory(history) {
  while (history.past.length > SQL_UNDO_MAX_STEPS) history.past.shift();
  let size = history.past.reduce((total, item) => total + item.value.length, history.current.value.length);
  while (size > SQL_UNDO_MAX_CHARS && history.past.length > 1) {
    size -= history.past.shift().value.length;
  }
}

function recordSqlEditorChange(editor, { before, inputType } = {}) {
  const history = sqlEditorHistory(app.query, editor);
  const normalizedBefore = typeof before === 'string'
    ? { value: before, start: 0, end: before.length }
    : before;
  const previous = normalizedBefore || { ...history.current };
  if (history.beforeSelection && !before) {
    previous.start = history.beforeSelection.start;
    previous.end = history.beforeSelection.end;
  }
  history.beforeSelection = null;
  const next = sqlEditorSnapshot(editor);
  if (previous.value !== next.value) {
    const now = Date.now();
    const grouping = ['insertText', 'deleteContentBackward', 'deleteContentForward'].includes(inputType)
      && history.lastInput?.type === inputType
      && now - history.lastInput.at < 650
      && previous.start === previous.end
      && previous.start === history.lastInput.caret;
    if (!grouping) history.past.push(previous);
    history.current = next;
    history.future = [];
    history.lastInput = inputType ? { type: inputType, at: now, caret: next.end } : null;
    trimSqlEditorHistory(history);
  } else {
    history.current = next;
  }
  app.query.sql = editor.value;
  queryDraftCache = editor.value;
  persistState();
}

function restoreSqlEditorSnapshot(editor, snapshot) {
  editor.value = snapshot.value;
  editor.setSelectionRange(snapshot.start, snapshot.end);
  app.query.sql = snapshot.value;
  queryDraftCache = snapshot.value;
  closeSqlSuggestions();
  persistState();
}

function stepSqlEditorHistory(editor, direction) {
  const history = sqlEditorHistory(app.query, editor);
  const source = direction === 'undo' ? history.past : history.future;
  const target = direction === 'undo' ? history.future : history.past;
  if (!source.length) return false;
  target.push(sqlEditorSnapshot(editor));
  const snapshot = source.pop();
  history.current = snapshot;
  history.lastInput = null;
  history.beforeSelection = null;
  restoreSqlEditorSnapshot(editor, snapshot);
  return true;
}

function handleSqlEditorHistoryKeydown(editor, event) {
  if ((!event.ctrlKey && !event.metaKey) || event.altKey) return false;
  const key = event.key.toLowerCase();
  if (key === 'z') {
    event.preventDefault();
    stepSqlEditorHistory(editor, event.shiftKey ? 'redo' : 'undo');
    return true;
  }
  if (key === 'y' && !event.shiftKey) {
    event.preventDefault();
    stepSqlEditorHistory(editor, 'redo');
    return true;
  }
  return false;
}

function formatCurrentSql() {
  const editor = $('#sql');
  if (!editor) return;
  const before = sqlEditorSnapshot(editor);
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const hasSelection = start !== end;

  try {
    const formatted = formatSql(hasSelection ? editor.value.slice(start, end) : editor.value);
    if (hasSelection) editor.setRangeText(formatted, start, end, 'select');
    else editor.value = formatted;
    recordSqlEditorChange(editor, { before });
    toast(hasSelection ? 'Đã định dạng đoạn SQL được chọn ✨' : 'Đã định dạng toàn bộ câu lệnh SQL ✨', 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function runAnalyzeQuery() {
  if (!desktop?.db?.analyzeQuery) { toast('Phiên bản desktop này chưa hỗ trợ ANALYZE.', 'error'); return; }
  if (activeTransfer || queryTabs.some(tab => tab.running)) { toast('Một tác vụ đang chạy. Hãy đợi hoặc hủy trước.', 'error'); return; }
  const tab = app.query;
  if (!tab) return;
  const editor = $('#sql');
  const rawSql = editor ? editor.value : (tab.sql || '');
  const start = editor?.selectionStart ?? 0, end = editor?.selectionEnd ?? start;
  const sql = start !== end ? rawSql.slice(start, end).trim() : window.SqlAutocomplete.getContext(rawSql, start).statement.trim();
  const generation = explainGeneration;
  const target = await ensureQueryTarget(tab);
  if (!target || generation !== explainGeneration || app.query !== tab || !queryTabs.includes(tab)
      || activeTransfer || queryTabs.some(item => item.running)) return;
  if (target.connection?.readOnly) { toast('Kết nối chỉ đọc không cho phép ANALYZE.', 'error'); return; }
  const database = target.database || null;
  explainObservations.delete(tab);
  if (tab.result?.explainComparison) delete tab.result.explainComparison;
  tab.running = true;
  tab.taskId = newQueryTaskId();
  const ownedTaskId = tab.taskId;
  tab.error = null;
  closeSqlSuggestions();
  updateQueryButtons();
  renderQueryTabs();
  setStatus('Đang chờ xác nhận ANALYZE; thao tác sẽ thực thi SELECT…');
  try {
    const result = await call(desktop.db.analyzeQuery({ sql, database, profileId: target.profileId,
      timeoutMs: Math.min(60000, queryTimeoutMs(tab)), taskId: ownedTaskId }));
    if (generation !== explainGeneration || !queryTabs.includes(tab) || tab.taskId !== ownedTaskId || !tab.running) return;
    if (result.canceled) { setStatus('Đã hủy ANALYZE'); return; }
    tab.result = result;
    tab.lastSql = null;
    tab.resultContext = { profileId: target.profileId, database };
    tab.resultTab = null;
    tab.resultView = 'data';
    tab.sortCol = null;
    tab.sortDir = 'ASC';
    toast('Đã nhận ANALYZE. Truy vấn đã được thực thi; xem thống kê do server trả về.');
    setStatus('Hoàn tất ANALYZE');
  } catch (error) {
    if (generation !== explainGeneration || !queryTabs.includes(tab) || tab.taskId !== ownedTaskId || !tab.running) return;
    tab.error = error.message || 'Lỗi ANALYZE';
    toast(error.message || 'Lỗi ANALYZE', 'error');
    setStatus('Lỗi ANALYZE; không tự chạy lại');
  } finally {
    if (tab.taskId === ownedTaskId) {
      tab.running = false;
      tab.taskId = null;
      updateQueryButtons();
      renderQueryTabs();
      const output = $('#queryResult');
      if (app.query === tab && output) output.innerHTML = queryResultHtml();
      if (generation === explainGeneration && queryTabs.includes(tab)) void refreshSessionState(target.profileId);
    }
  }
}

async function runExplainQuery() {
  if (!desktop) {
    toast('Ứng dụng desktop chưa sẵn sàng.', 'error');
    return;
  }
  if (queryTabs.some((tab) => tab.running)) {
    toast('Một truy vấn khác đang chạy. Hãy chờ hoặc hủy trước.', 'error');
    return;
  }
  const tab = app.query;
  const editor = $('#sql');
  const rawSql = editor ? editor.value : (tab.sql || '');
  const format = window.SqlQueryResults.explainFormat(tab.explainFormat);
  const explainSettings = tab.explainSettings === true;
  const explainSchema = tab.explainSchema === true;
  const generation = explainGeneration;
  const start = editor?.selectionStart ?? 0, end = editor?.selectionEnd ?? start;
  const target = await ensureQueryTarget(tab);
  if (!target) return;
  if (generation !== explainGeneration || app.query !== tab || !queryTabs.includes(tab) || queryTabs.some(item => item.running)) return;
  const database = target.database || null;
  let ownedTaskId = null;
  try {
    const sqlToRun = start !== end ? rawSql.slice(start, end).trim()
      : window.SqlAutocomplete.getContext(rawSql, start).statement.trim();
    const tokens = tokenizeSql(sqlToRun);
    if (tokens.some(token => token.type === 'comment' && /^\/\*(?:[!+]|M!)/i.test(token.text))) {
      throw new Error('Nút EXPLAIN chưa hỗ trợ executable comment/optimizer hint. Hãy xem xét SQL và chạy riêng trong Editor.');
    }
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
    if (['EXPLAIN', 'DESCRIBE', 'DESC'].includes(firstWord)) {
      for (const token of meaningful.slice(1)) {
        const word = token.text.toUpperCase();
        if (['SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE'].includes(word)) break;
        if (word === 'ANALYZE') throw new Error('ANALYZE thực thi truy vấn. Hãy chạy riêng trong SQL Editor sau khi xem xét tác động; nút EXPLAIN chỉ xem kế hoạch.');
      }
    }
    const explainSql = ['EXPLAIN', 'DESCRIBE', 'DESC'].includes(firstWord) ? sqlToRun
      : `EXPLAIN ${format === 'DEFAULT' ? '' : `FORMAT=${format} `}${sqlToRun}`;
    tab.running = true;
    tab.taskId = newQueryTaskId();
    ownedTaskId = tab.taskId;
    tab.error = null;
    closeSqlSuggestions();
    updateQueryButtons();
    renderQueryTabs();
    setStatus('Đang phân tích kế hoạch thực thi (EXPLAIN)...');
    const request = {
      sql: explainSql,
      timeoutMs: queryTimeoutMs(tab),
      profileId: target.profileId,
      database,
      taskId: tab.taskId
    };
    if (explainSettings) request.explainSettings = true;
    if (explainSchema) request.explainSchema = true;
    const result = await call(desktop.db.query(request));
    if (generation !== explainGeneration || !queryTabs.includes(tab) || tab.taskId !== ownedTaskId || !tab.running) return;
    result.isExplain = true;
    result.explainFormat = format;
    result.explainSettingsRequested = explainSettings;
    result.explainSchemaRequested = explainSchema;
    const observation = window.SqlQueryResults.captureExplain(result, { ...request, explainFormat: format });
    result.explainComparison = window.SqlQueryResults.compareExplain(explainObservations.get(tab), observation);
    if (observation) explainObservations.set(tab, observation);
    else explainObservations.delete(tab);
    tab.result = result;
    tab.lastSql = explainSql;
    tab.resultContext = { profileId: target.profileId, database };
    tab.resultTab = null;
    tab.resultView = 'data';
    tab.sortCol = null;
    tab.sortDir = 'ASC';
    toast('Đã nhận kết quả EXPLAIN. Xem giải thích cùng kế hoạch bên dưới.', 'success');
    setStatus('Hoàn tất EXPLAIN');
  } catch (error) {
    if (generation !== explainGeneration || !queryTabs.includes(tab) || ownedTaskId !== null && tab.taskId !== ownedTaskId) return;
    explainObservations.delete(tab);
    if (tab.result?.explainComparison) tab.result.explainComparison = { version: 1, status: 'unknown' };
    if (tab.running) tab.error = error.message || 'Không nhận được plan. Server có thể không hỗ trợ định dạng đã chọn.';
    toast(error.message || 'Lỗi khi chạy EXPLAIN', 'error');
    setStatus('Lỗi EXPLAIN');
  } finally {
    if (ownedTaskId !== null && tab.taskId === ownedTaskId) {
      tab.running = false;
      tab.taskId = null;
      updateQueryButtons();
      renderQueryTabs();
      const output = $('#queryResult');
      if (app.query === tab && output) output.innerHTML = queryResultHtml();
    }
  }
}

function showShortcutsModal() {
  modal(`
    <div class="modal-card shortcuts-modal-card">
      <div class="modal-header">
        <h3>⌨️ Bảng Tra Cứu Phím Tắt SqlPro</h3>
        <button class="close-btn" data-click="close-modal">✕</button>
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
              <td><kbd>Ctrl</kbd> + <kbd>Z</kbd> / <kbd>Ctrl</kbd> + <kbd>Y</kbd></td>
              <td><strong>Hoàn tác / làm lại</strong> nội dung SQL trong tab hiện tại</td>
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
            <tr>
              <td><kbd>F2</kbd></td>
              <td><strong>Mở thư viện mẫu SQL (Snippets)</strong></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="modal-footer" style="text-align: right; margin-top: 16px;">
        <button class="primary" data-click="close-modal">Đóng (Esc)</button>
      </div>
    </div>
  `);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'F1') {
    e.preventDefault();
    showShortcutsModal();
  } else if (e.key === 'F2') {
    e.preventDefault();
    openSnippetsModal();
  }
});

function openSnippetsModal(modalMode = 'list', editingSnippet = null) {
  if (modalMode === 'edit' || modalMode === 'create') {
    renderSnippetFormModal(editingSnippet);
  } else {
    renderSnippetListModal();
  }
}

function renderSnippetListModal() {
  const filtered = QuerySnippets ? QuerySnippets.searchSnippets(snippets, {
    query: snippetSearchTerm,
    tag: snippetFilterTag
  }) : snippets;

  const allTags = new Set();
  snippets.forEach((s) => {
    if (Array.isArray(s.tags)) s.tags.forEach((t) => allTags.add(t));
  });

  modal(`
    <div class="modal-card snippets-modal-card">
      <div class="modal-header">
        <div class="modal-title-row">
          <h3>📋 Thư viện Mẫu SQL (Snippets)</h3>
          <span class="subtle">${filtered.length} / ${snippets.length} mẫu</span>
        </div>
        <button class="close-btn" data-click="close-modal" title="Đóng (Esc)">✕</button>
      </div>
      <div class="modal-body snippets-modal-body">
        <div class="snippets-toolbar">
          <input type="search" id="snippetSearchInput" class="snippet-search-input" placeholder="🔍 Tìm kiếm mẫu theo tên, phím tắt, nội dung SQL hoặc nhãn..." value="${esc(snippetSearchTerm)}" />
          <button class="primary" id="newSnippetBtn">＋ Thêm Snippet mới</button>
        </div>
        ${allTags.size > 0 ? `
          <div class="snippet-tag-filters" role="tablist">
            <button class="snippet-tag-chip ${!snippetFilterTag ? 'active' : ''}" data-snippet-tag="">Tất cả</button>
            ${Array.from(allTags).sort().map((tag) => `
              <button class="snippet-tag-chip ${snippetFilterTag === tag ? 'active' : ''}" data-snippet-tag="${esc(tag)}">#${esc(tag)}</button>
            `).join('')}
          </div>
        ` : ''}
        <div class="snippets-list">
          ${filtered.length > 0 ? filtered.map((snippet) => `
            <div class="snippet-card" data-snippet-id="${esc(snippet.id)}">
              <div class="snippet-card-header">
                <div class="snippet-title-group">
                  <strong class="snippet-title">${esc(snippet.title)}</strong>
                  ${snippet.shortcut ? `<span class="snippet-shortcut" title="Phím tắt">${esc(snippet.shortcut)}</span>` : ''}
                </div>
                <div class="snippet-card-actions">
                  <button class="primary small-btn" data-snippet-action="insert" data-snippet-id="${esc(snippet.id)}" title="Chèn vào SQL Editor tại vị trí con trỏ">▷ Chèn</button>
                  <button class="small-btn" data-snippet-action="copy" data-snippet-id="${esc(snippet.id)}" title="Sao chép SQL vào clipboard">📋 Chép</button>
                  <button class="small-btn" data-snippet-action="edit" data-snippet-id="${esc(snippet.id)}" title="Chỉnh sửa mẫu này">✏️ Sửa</button>
                  <button class="danger small-btn" data-snippet-action="delete" data-snippet-id="${esc(snippet.id)}" title="Xóa mẫu này">✕</button>
                </div>
              </div>
              ${Array.isArray(snippet.tags) && snippet.tags.length > 0 ? `
                <div class="snippet-tags">
                  ${snippet.tags.map((t) => `<span class="snippet-tag">#${esc(t)}</span>`).join('')}
                </div>
              ` : ''}
              <pre class="snippet-sql-preview mono">${esc(snippet.sql)}</pre>
            </div>
          `).join('') : `
            <div class="empty">
              <p>Không tìm thấy mẫu SQL nào phù hợp.</p>
              ${snippetSearchTerm || snippetFilterTag ? '<button id="resetSnippetSearchBtn">Xóa bộ lọc tìm kiếm</button>' : ''}
            </div>
          `}
        </div>
      </div>
    </div>
  `, true);

  const searchInput = $('#snippetSearchInput');
  if (searchInput) {
    searchInput.focus();
    searchInput.setSelectionRange(snippetSearchTerm.length, snippetSearchTerm.length);
    searchInput.addEventListener('input', (e) => {
      snippetSearchTerm = e.target.value;
      renderSnippetListModal();
    });
  }

  $('#newSnippetBtn')?.addEventListener('click', () => {
    renderSnippetFormModal(null);
  });

  $('#resetSnippetSearchBtn')?.addEventListener('click', () => {
    snippetSearchTerm = '';
    snippetFilterTag = '';
    renderSnippetListModal();
  });

  document.querySelectorAll('[data-snippet-tag]').forEach((btn) => {
    btn.addEventListener('click', () => {
      snippetFilterTag = btn.dataset.snippetTag || '';
      renderSnippetListModal();
    });
  });

  document.querySelectorAll('[data-snippet-action]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.dataset.snippetAction;
      const id = btn.dataset.snippetId;
      const snippet = snippets.find((s) => s.id === id);
      if (!snippet) return;

      if (action === 'insert') {
        insertSnippetIntoEditor(snippet);
      } else if (action === 'copy') {
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(snippet.sql);
        }
        toast(`Đã sao chép SQL mẫu "${snippet.title}"`, 'info');
      } else if (action === 'edit') {
        renderSnippetFormModal(snippet);
      } else if (action === 'delete') {
        snippets = snippets.filter((s) => s.id !== id);
        persistState();
        toast(`Đã xóa mẫu "${snippet.title}"`, 'info');
        renderSnippetListModal();
      }
    });
  });
}

function renderSnippetFormModal(editingSnippet = null) {
  const isEdit = Boolean(editingSnippet);
  const title = editingSnippet?.title || '';
  const shortcut = editingSnippet?.shortcut || '';
  const tagsStr = Array.isArray(editingSnippet?.tags) ? editingSnippet.tags.join(', ') : '';
  const sql = editingSnippet?.sql || '';

  modal(`
    <div class="modal-card snippets-form-modal-card">
      <div class="modal-header">
        <h3>${isEdit ? '✏️ Chỉnh sửa Snippet' : '＋ Thêm Snippet Mới'}</h3>
        <button class="close-btn" data-click="close-modal" title="Đóng (Esc)">✕</button>
      </div>
      <div class="modal-body">
        <label for="snippetTitleInput">Tiêu đề mẫu <span class="subtle">(bắt buộc, tối đa 100 ký tự)</span></label>
        <input id="snippetTitleInput" type="text" maxlength="100" placeholder="VD: Lọc đơn hàng gần đây" value="${esc(title)}" required />

        <div class="formrow">
          <div>
            <label for="snippetShortcutInput">Phím tắt viết tắt <span class="subtle">(tùy chọn, tối đa 30 ký tự)</span></label>
            <input id="snippetShortcutInput" type="text" maxlength="30" placeholder="VD: sel_recent" value="${esc(shortcut)}" />
          </div>
          <div>
            <label for="snippetTagsInput">Nhãn / Thẻ <span class="subtle">(cách nhau bằng dấu phẩy)</span></label>
            <input id="snippetTagsInput" type="text" placeholder="VD: select, orders, report" value="${esc(tagsStr)}" />
          </div>
        </div>

        <label for="snippetSqlInput">Nội dung SQL <span class="subtle">(bắt buộc)</span></label>
        <textarea id="snippetSqlInput" class="editor mono" rows="8" placeholder="SELECT * FROM table_name WHERE ..." style="height: 180px;">${esc(sql)}</textarea>
      </div>
      <div class="actions">
        <button id="cancelSnippetEditBtn">← Quay lại danh sách</button>
        <span class="spacer"></span>
        <button class="primary" id="saveSnippetFormBtn">Lưu Snippet</button>
      </div>
    </div>
  `, true);

  $('#snippetTitleInput')?.focus();

  $('#cancelSnippetEditBtn')?.addEventListener('click', () => {
    renderSnippetListModal();
  });

  $('#saveSnippetFormBtn')?.addEventListener('click', () => {
    const rawTitle = $('#snippetTitleInput').value.trim();
    const rawShortcut = $('#snippetShortcutInput').value.trim();
    const rawTags = $('#snippetTagsInput').value.split(',').map((s) => s.trim()).filter(Boolean);
    const rawSql = $('#snippetSqlInput').value.trim();

    if (!rawTitle) {
      toast('Vui lòng nhập tiêu đề cho Snippet.', 'error');
      $('#snippetTitleInput')?.focus();
      return;
    }
    if (!rawSql) {
      toast('Vui lòng nhập nội dung SQL cho Snippet.', 'error');
      $('#snippetSqlInput')?.focus();
      return;
    }

    const normalized = QuerySnippets ? QuerySnippets.normalizeSnippet({
      id: editingSnippet?.id || undefined,
      title: rawTitle,
      shortcut: rawShortcut,
      tags: rawTags,
      sql: rawSql,
      createdAt: editingSnippet?.createdAt || undefined,
      updatedAt: new Date().toISOString()
    }) : {
      id: editingSnippet?.id || `snip_${Date.now()}`,
      title: rawTitle,
      shortcut: rawShortcut,
      tags: rawTags,
      sql: rawSql
    };

    if (!normalized) {
      toast('Dữ liệu snippet không hợp lệ.', 'error');
      return;
    }

    if (isEdit) {
      const idx = snippets.findIndex((s) => s.id === editingSnippet.id);
      if (idx !== -1) snippets[idx] = normalized;
      else snippets.unshift(normalized);
    } else {
      snippets.unshift(normalized);
    }
    snippets = snippets.slice(0, 200);
    persistState();
    toast(`Đã lưu snippet "${normalized.title}"!`, 'info');
    renderSnippetListModal();
  });
}

function insertSnippetIntoEditor(snippet) {
  if (!snippet || !snippet.sql) return;
  closeModal();

  if (mode !== 'query') {
    mode = 'query';
    renderQueryView();
  }

  const editor = $('#sql');
  if (!editor) return;

  const before = sqlEditorSnapshot(editor);
  const start = editor.selectionStart ?? editor.value.length;
  const end = editor.selectionEnd ?? start;

  editor.setRangeText(snippet.sql, start, end, 'end');
  recordSqlEditorChange(editor, { before });
  if (app.query) app.query.sql = editor.value;
  editor.focus();
  toast(`Đã chèn mẫu "${snippet.title}" vào SQL Editor`, 'info');
}

function renderQueryView() {
  sqlAutocomplete.requestId += 1;
  const value = app.query.sql === null || app.query.sql === undefined ? defaultSql() : app.query.sql;
  app.query.sql = value;
  queryDraftCache = value;
  updateChrome();
  $('#workspace').innerHTML = `
    <div class="toolbar">
      <button class="primary" id="runQueryBtn">▷ Chạy (F5)</button>
      <button id="explainQueryBtn" title="Phân tích kế hoạch thực thi (Ctrl+E)">⚡ EXPLAIN</button>
      <button id="analyzeQueryBtn" title="Thực thi một SELECT/CTE để đo kế hoạch thực tế; luôn xác nhận, tối đa 60 giây, không dùng trong transaction hoặc chế độ chỉ đọc.">ANALYZE…</button>
      <select id="explainFormat" aria-label="Định dạng EXPLAIN" title="Chọn định dạng cho SQL chưa có EXPLAIN. Khả năng hỗ trợ do server quyết định; không tự thử lại hoặc chạy ANALYZE.">
        ${[['DEFAULT', 'Plan: Mặc định'], ['JSON', 'Plan: JSON'], ['TREE', 'Plan: TREE']].map(([value, label]) => `<option value="${value}" ${window.SqlQueryResults.explainFormat(app.query.explainFormat) === value ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
      <label class="explain-settings-option" title="Đọc một danh sách thiết lập trước/sau EXPLAIN SELECT để kiểm tra ngữ cảnh khi so sánh. Thêm tối đa hai SELECT metadata; chưa kiểm chứng schema hoặc mọi thiết lập."><input id="explainSettings" type="checkbox" ${app.query.explainSettings === true ? 'checked' : ''}> Kèm thiết lập phiên</label>
      <label class="explain-settings-option" title="Đọc SHOW CREATE TABLE trước/sau cho SELECT trên một bảng trực tiếp. Chưa hỗ trợ JOIN/CTE/subquery/view hoặc chứng nhận toàn schema."><input id="explainSchema" type="checkbox" ${app.query.explainSchema === true ? 'checked' : ''}> Kèm định nghĩa bảng</label>
      <button id="formatSqlBtn" title="Định dạng SQL chuẩn đẹp (Ctrl+Shift+F)">🪄 Định dạng</button>
      <button id="saveQueryBtn">⌑ Lưu</button>
      <button id="snippetsBtn" title="Quản lý và chèn mẫu truy vấn SQL (F2)">📋 Snippets</button>
      <select id="queryTimeout" aria-label="Thời gian chờ truy vấn" title="Giới hạn cho toàn bộ lượt chạy, gồm thực thi và nhận dữ liệu">
        ${[[30000, '30 giây'], [60000, '1 phút'], [300000, '5 phút'], [900000, '15 phút']].map(([value, label]) => `<option value="${value}" ${queryTimeoutMs(app.query) === value ? 'selected' : ''}>Chờ ${label}</option>`).join('')}
      </select>
      <button class="danger" id="cancelQueryBtn" style="display:${app.query.running ? 'inline-block' : 'none'}">■ Hủy</button>
      <select id="queryRowLimit" aria-label="Số dòng tối đa mỗi kết quả" title="Tối đa 32 MB mỗi kết quả; cả lượt chạy tối đa 100.000 dòng / 64 MB. Chạy lại SQL để áp dụng mức mới.">
        ${[5000, 20000, 50000, 100000].map((value) => `<option value="${value}" ${queryRowLimit(app.query) === value ? 'selected' : ''}>Tối đa ${value.toLocaleString()} dòng</option>`).join('')}
      </select>
      <button id="bindQueryTargetBtn" style="display:${queryTargetConnection(app.query) ? 'none' : 'inline-block'}">Gắn kết nối…</button>
      <span class="spacer"></span>
      <span class="subtle query-target-label" id="queryTargetLabel" title="Kết nối và database đích của tab này">${esc(queryTargetLabel(app.query))}${table ? ` · ${esc(table)}` : ''} &nbsp; · &nbsp; Ctrl+Enter / Ctrl+E</span>
    </div>
    <div class="sql-editor-wrap">
      <textarea class="editor" id="sql" spellcheck="false" autocomplete="off" aria-label="SQL editor" aria-autocomplete="list" aria-controls="sqlSuggestions"></textarea>
      <div class="sql-suggestions hidden" id="sqlSuggestions" role="listbox" aria-label="Gợi ý SQL"></div>
    </div>
    <div id="queryResult">${queryResultHtml()}</div>
  `;
  $('#queryResult').style.setProperty('--query-grid-zoom', String((app.query.gridZoom || 100) / 100));
  setupQueryGridSelection($('#queryResult'));
  const editor = $('#sql');
  editor.value = value;
  if (app.query.sqlHistory?.current.value !== value) app.query.sqlHistory = null;
  const history = sqlEditorHistory(app.query, editor);
  editor.setSelectionRange(history.current.start, history.current.end);
  editor.addEventListener('beforeinput', (event) => {
    if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
      event.preventDefault();
      stepSqlEditorHistory(editor, event.inputType === 'historyUndo' ? 'undo' : 'redo');
      return;
    }
    history.beforeSelection = { start: editor.selectionStart, end: editor.selectionEnd };
  });
  editor.addEventListener('input', (event) => {
    recordSqlEditorChange(editor, { inputType: event.inputType });
    void refreshSqlSuggestions(editor);
  });
  editor.addEventListener('keydown', (event) => {
    if (handleSqlEditorHistoryKeydown(editor, event)) return;
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
  editor.addEventListener('scroll', () => {
    if (editor !== $('#sql') || !editor.isConnected) return;
    const context = sqlAutocomplete.context;
    // Native scroll notifications may arrive after a new popup used the same viewport.
    if (context && editor.scrollTop === context.scrollTop && editor.scrollLeft === context.scrollLeft) return;
    closeSqlSuggestions();
  });
  editor.addEventListener('focus', () => clearTimeout(sqlAutocomplete.blurTimer));
  editor.addEventListener('compositionstart', () => {
    sqlAutocomplete.composing = true;
    closeSqlSuggestions();
  });
  editor.addEventListener('compositionend', () => {
    sqlAutocomplete.composing = false;
    void refreshSqlSuggestions(editor);
  });
  editor.addEventListener('blur', () => {
    if (editor !== $('#sql') || !editor.isConnected) return;
    clearTimeout(sqlAutocomplete.blurTimer);
    sqlAutocomplete.blurTimer = setTimeout(() => {
      if (editor === $('#sql') && editor.isConnected && document.activeElement !== editor) closeSqlSuggestions();
    }, 120);
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
  $('#explainSettings').addEventListener('change', (event) => {
    app.query.explainSettings = event.target.checked;
    explainObservations.delete(app.query);
    if (app.query.result?.explainComparison) delete app.query.result.explainComparison;
  });
  $('#explainSchema').addEventListener('change', (event) => {
    app.query.explainSchema = event.target.checked;
    explainObservations.delete(app.query);
    if (app.query.result?.explainComparison) delete app.query.result.explainComparison;
  });
  $('#analyzeQueryBtn').addEventListener('click', runAnalyzeQuery);
  $('#explainFormat').addEventListener('change', event => {
    app.query.explainFormat = window.SqlQueryResults.explainFormat(event.target.value);
  });
  $('#formatSqlBtn').addEventListener('click', formatCurrentSql);
  $('#saveQueryBtn').addEventListener('click', saveQuery);
  $('#snippetsBtn')?.addEventListener('click', () => openSnippetsModal());
  $('#queryTimeout').addEventListener('change', (event) => {
    app.query.timeoutMs = Number(event.target.value);
    persistState();
  });
  $('#queryRowLimit').addEventListener('change', (event) => {
    app.query.rowLimit = Number(event.target.value);
    persistState();
  });
  $('#cancelQueryBtn').addEventListener('click', cancelQuery);
  $('#bindQueryTargetBtn').addEventListener('click', bindQueryTargetToActive);
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
      inlineEditQueryResultCell(td);
    }
  });
  $('#queryResult').addEventListener('dblclick', (event) => {
    const td = event.target.closest('td[data-col-idx]');
    if (td && !td.classList.contains('muted')) {
      inlineEditQueryResultCell(td);
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

const queryTablePkCache = new Map();

function getActiveQueryResult() {
  const result = app.query.result;
  if (!result) return null;
  if (result.kind === 'rows') return result;
  if (result.kind === 'batch') {
    const tabs = queryBatchTabs(result);
    const selected = tabs.find((item) => item.key === app.query.resultTab) || tabs.find((item) => item.entry) || tabs[0];
    return selected?.entry?.result || null;
  }
  return null;
}

async function getQueryColumnPkInfo(result, colIdx, profileId = app.query?.profileId || app.connection?.id || null) {
  if (connectionIsReadOnly(profileId)) return {editable:false,reason:'Kết nối đang ở chế độ chỉ đọc.'};
  if (!result || !result.columns || !result.columns[colIdx]) return null;
  const colMeta = result.columns[colIdx];
  const targetTable = colMeta.orgTable || colMeta.table || table;
  if (!targetTable) {
    return { editable: false, reason: 'Cột này không thuộc bảng dữ liệu cụ thể nào.' };
  }
  const targetDb = colMeta.db || app.query?.resultContext?.database || app.query?.database || app.database;
  if (!targetDb) {
    return { editable: false, reason: 'Chưa xác định cơ sở dữ liệu.' };
  }

  if (/(virtual|stored) generated/i.test(colMeta.extra || '')) {
    return { editable: false, reason: `Cột "${colMeta.name}" là cột tự động tính toán (generated), không thể sửa.` };
  }

  // 1. Check if PK flags are present directly in result.columns
  let pkCols = result.columns
    .map((c, i) => ({ col: c, index: i }))
    .filter(({ col }) => ((col.flags & 2) || col.key === 'PRI')
      && (col.orgTable || col.table || targetTable) === targetTable && (!col.db || col.db === targetDb));

  // 2. If no PK flag found in columns, look up primary keys from table
  if (!pkCols.length) {
    let pks = (table === targetTable && app.database === targetDb && (app.connection?.id || null) === profileId && app.primaryKey?.length) ? app.primaryKey : null;
    if (!pks) {
      const cacheKey = JSON.stringify([profileId || '', targetDb, targetTable]);
      if (queryTablePkCache.has(cacheKey)) {
        pks = queryTablePkCache.get(cacheKey);
      } else if (desktop?.db?.columns) {
        try {
          const cols = await call(desktop.db.columns(targetDb, targetTable, profileId));
          pks = (cols || []).filter((c) => c.key === 'PRI').map((c) => c.name);
          queryTablePkCache.set(cacheKey, pks);
        } catch {
          pks = [];
        }
      }
    }
    if (pks && pks.length) {
      pkCols = [];
      for (const pkName of pks) {
        const foundIdx = result.columns.findIndex((c) =>
          (c.orgTable || c.table || targetTable) === targetTable && (!c.db || c.db === targetDb) &&
          (c.name.toLowerCase() === pkName.toLowerCase() || (c.orgName && c.orgName.toLowerCase() === pkName.toLowerCase()))
        );
        if (foundIdx === -1) {
          return { editable: false, reason: `Kết quả truy vấn thiếu cột khóa chính "${pkName}" của bảng "${targetTable}".` };
        }
        pkCols.push({ col: result.columns[foundIdx], index: foundIdx });
      }
    }
  }

  if (!pkCols.length) {
    return { editable: false, reason: `Bảng "${targetTable}" không có khóa chính nên không thể sửa trực tiếp.` };
  }

  return {
    editable: true,
    table: targetTable,
    database: targetDb,
    colName: colMeta.orgName || colMeta.name,
    pkCols
  };
}

async function queryResultWriteContext(result, rowIndex, colIdx, profileId) {
  if (connectionIsReadOnly(profileId)) throw new Error('Kết nối đang ở chế độ chỉ đọc.');
  const row = result?.rows?.[rowIndex];
  const source = result?.columns?.[colIdx];
  if (!row || !source || (!source.orgTable && !source.table) || result.isExplain) {
    throw new Error('Không xác định được bảng gốc để sửa bản ghi này.');
  }
  const info = await getQueryColumnPkInfo(result, colIdx, profileId);
  if (!info?.editable) throw new Error(info?.reason || 'Kết quả này chỉ đọc.');
  const columns = await call(desktop.db.columns(info.database, info.table, profileId));
  return queryResultRowWriteContext(result, rowIndex, columns, info);
}

function queryResultRowWriteContext(result, rowIndex, columns, info) {
  const row = result.rows[rowIndex];
  if (!row) throw new Error('Bản ghi không còn trong kết quả truy vấn.');
  const column = columns.find((entry) => entry.name === info.colName);
  if (!column) throw new Error('Không xác định được cột gốc để chỉnh sửa.');
  const primary = columns.filter((entry) => entry.key === 'PRI');
  if (!primary.length) throw new Error('Bảng không có khóa chính nên không thể sửa trực tiếp.');
  const keys = Object.create(null);
  for (const key of primary) {
    const index = result.columns.findIndex((entry) => (entry.orgName || entry.name) === key.name
      && (entry.orgTable || entry.table) === info.table && (!entry.db || entry.db === info.database));
    if (index === -1) throw new Error(`Kết quả thiếu khóa chính "${key.name}" của bảng "${info.table}".`);
    keys[key.name] = row[index];
  }
  const original = {};
  for (let index = 0; index < result.columns.length; index += 1) {
    const sourceColumn = result.columns[index];
    if ((sourceColumn.orgTable || sourceColumn.table) !== info.table) continue;
    if (sourceColumn.db && sourceColumn.db !== info.database) continue;
    const sourceName = sourceColumn.orgName || sourceColumn.name;
    if (sourceName) Object.defineProperty(original, sourceName, {
      value: result.originalHashes?.[rowIndex]?.[index] || row[index], enumerable: true, configurable: true, writable: true
    });
  }
  return { info, column, keys, original, row, columns };
}

async function inlineEditQueryResultCell(td) {
  if (!td || td.classList.contains('editing-cell') || td.dataset.editorLoading) return;
  const colIdx = Number(td.dataset.colIdx);
  const tr = td.closest('tr[data-query-row]');
  const result = getActiveQueryResult();
  if (!tr || !Number.isInteger(colIdx) || !result?.rows) return;
  const source = result.columns[colIdx];
  if (!source || (!source.orgTable && !source.table)) { toast('Cột tính toán không có bảng gốc để chỉnh sửa.', 'error'); return; }
  const row = result.rows[Number(tr.dataset.queryRow)];
  if (!row) return;
  const profileId = app.query?.resultContext?.profileId || app.query?.profileId || app.connection?.id || null;
  if (connectionIsReadOnly(profileId)) { toast('Kết nối đang ở chế độ chỉ đọc. Không thể sửa trực tiếp.', 'error'); return; }
  td.dataset.editorLoading = '1';
  try {
    const { info, column, keys, original } = await queryResultWriteContext(result, Number(tr.dataset.queryRow), colIdx, profileId);
    if (td.isConnected === false || getActiveQueryResult() !== result) return;
    startInlineValueEdit({
      td, column, value: row[colIdx],
      save: (value) => call(desktop.db.updateRow({ profileId, database: info.database, table: info.table, keys, values: { [column.name]: value }, original })),
      onSaved: (value) => { row[colIdx] = value; queryGridOrderCache.delete(result); },
      reload: () => runQuery(),
      next: (previous) => {
        const next = previous ? td.previousElementSibling : td.nextElementSibling;
        if (next?.dataset.colIdx !== undefined) void inlineEditQueryResultCell(next);
      }
    });
  } catch (error) { toast(error.message || 'Không tải được metadata của cột.', 'error'); }
  finally { delete td.dataset.editorLoading; }
}

async function pasteQueryResultCell(td) {
  const profileId = app.query?.resultContext?.profileId || app.query?.profileId || app.connection?.id || null;
  if (connectionIsReadOnly(profileId)) { toast('Kết nối đang ở chế độ chỉ đọc. Không thể dán dữ liệu.', 'error'); return; }
  let text;
  try { text = await readClipboardText(); }
  catch {
    await inlineEditQueryResultCell(td);
    toast('Không đọc được clipboard. Hãy dán bằng Ctrl+V trong ô đang sửa.');
    return;
  }
  await inlineEditQueryResultCell(td);
  const input = td.querySelector('.sql-value-inline input:not(.sql-value-picker), .sql-value-inline textarea');
  const modes = td.querySelector('.sql-value-inline .sql-value-mode');
  if (!input || !modes) {
    toast('Hãy chọn giá trị bằng bộ điều khiển của cột này.', 'error');
    return;
  }
  modes.value = 'value';
  modes.dispatchEvent(new Event('change', { bubbles: true }));
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
}

function refreshQueryResultAfterWrite(result) {
  queryGridOrderCache.delete(result);
  const output = $('#queryResult');
  if (!output || getActiveQueryResult() !== result) return;
  const previous = output.querySelector('.tablebox');
  const scrollLeft = previous?.scrollLeft || 0;
  const scrollTop = previous?.scrollTop || 0;
  output.innerHTML = queryResultHtml();
  const next = output.querySelector('.tablebox');
  if (next) { next.scrollLeft = scrollLeft; next.scrollTop = scrollTop; }
}

async function setQueryResultCellValue(td, value) {
  const tr = td?.closest('tr[data-query-row]');
  const rowIndex = Number(tr?.dataset.queryRow);
  const colIdx = Number(td?.dataset.colIdx);
  const result = getActiveQueryResult();
  if (!tr || !result?.rows?.[rowIndex] || !result.columns?.[colIdx]) return;
  const profileId = app.query?.resultContext?.profileId || app.query?.profileId || app.connection?.id || null;
  if (connectionIsReadOnly(profileId)) { toast('Kết nối đang ở chế độ chỉ đọc. Không thể sửa trực tiếp.', 'error'); return; }
  try {
    const { info, column, keys, original, row } = await queryResultWriteContext(result, rowIndex, colIdx, profileId);
    if (getActiveQueryResult() !== result || td.isConnected === false) return;
    requireRowUpdate(await call(desktop.db.updateRow({
      profileId, database: info.database, table: info.table, keys,
      values: { [column.name]: value }, original
    })));
    row[colIdx] = value;
    if (result.originalHashes?.[rowIndex]) delete result.originalHashes[rowIndex][colIdx];
    refreshQueryResultAfterWrite(result);
    toast(value === null ? 'Đã đặt giá trị thành NULL' : 'Đã đặt giá trị thành chuỗi rỗng', 'success');
  } catch (error) {
    if (error.code === 'ROW_CONFLICT' || error.code === 'ROW_NOT_FOUND') showRowConflict(error);
    else toast(error.message || 'Không cập nhật được ô.', 'error');
  }
}

async function deleteQueryResultRow(result, rowIndex) {
  return deleteQueryResultRows(result, [rowIndex]);
}

async function deleteQueryResultRows(result, rowIndexes) {
  if (getActiveQueryResult() !== result) return;
  const target = queryResultTableTarget(result);
  if (!target) { toast('Kết quả cần thuộc một bảng và có đầy đủ khóa chính để xóa.', 'error'); return; }
  if (connectionIsReadOnly(target.profileId)) { toast('Kết nối đang ở chế độ chỉ đọc. Không thể xóa bản ghi.', 'error'); return; }
  const selection = queryGridSelection(result);
  if (selection.deleting) return;
  const indexes = [...new Set(rowIndexes)].filter((index) => Number.isInteger(index) && result.rows[index]);
  if (!indexes.length) return;
  selection.deleting = true;
  try {
    const columns = await call(desktop.db.columns(target.database, target.targetTable, target.profileId));
    if (getActiveQueryResult() !== result) return;
    queryTablePkCache.set(JSON.stringify([target.profileId || '', target.database, target.targetTable]),
      columns.filter((column) => column.key === 'PRI').map((column) => column.name));
    const primaryIndexes = queryResultPrimaryKeyIndexes(result, target);
    if (!primaryIndexes.length) throw new Error('Kết quả cần có đầy đủ khóa chính để xóa bản ghi.');
    const source = result.columns[primaryIndexes[0]];
    const first = queryResultRowWriteContext(result, indexes[0], columns, {
      database: target.database, table: target.targetTable, colName: source.orgName || source.name
    });
    const entries = new Map();
    for (const index of indexes) {
      const context = queryResultRowWriteContext(result, index, first.columns, first.info);
      entries.set(JSON.stringify(context.keys), context);
    }
    const contexts = [...entries.values()];
    // Keep a single guarded request, so a conflict rolls back the whole selection.
    if (contexts.length > 1000) throw new Error('Chỉ có thể xóa tối đa 1.000 bản ghi mỗi lần. Hãy chọn ít dòng hơn.');
    if (getActiveQueryResult() !== result) return;
    const { info } = first;
    const count = contexts.length;
    const confirmed = await confirmAction(count === 1 ? 'Xóa bản ghi?' : `Xóa ${count.toLocaleString()} bản ghi?`,
      `Xóa ${count.toLocaleString()} bản ghi khỏi ${info.database}.${info.table}? Thao tác này ghi ngay vào database.`, 'Xóa');
    if (!confirmed || getActiveQueryResult() !== result) return;
    const outcome = await call(desktop.db.deleteRows({
      profileId: target.profileId, database: info.database, table: info.table,
      keysList: contexts.map(({ keys }) => keys), originalValues: contexts.map(({ original }) => original)
    }));
    if (Number(outcome.affectedRows) !== count) throw new Error('Không xác nhận được đầy đủ bản ghi đã xóa. Hãy chạy lại truy vấn để kiểm tra database.');
    const primary = first.columns.filter((column) => column.key === 'PRI');
    const keyIndexes = primary.map((key) => result.columns.findIndex((column) =>
      (column.orgName || column.name) === key.name && (column.orgTable || column.table) === info.table
      && (!column.db || column.db === info.database)));
    for (let index = result.rows.length - 1; index >= 0; index -= 1) {
      const keys = Object.fromEntries(primary.map((key, offset) => [key.name, result.rows[index][keyIndexes[offset]]]));
      if (!entries.has(JSON.stringify(keys))) continue;
      result.rows.splice(index, 1);
      result.originalHashes?.splice(index, 1);
    }
    selection.rows.clear(); selection.anchor = null; selection.focus = null;
    refreshQueryResultAfterWrite(result);
    toast(`Đã xóa ${count.toLocaleString()} bản ghi.`, 'success');
  } catch (error) {
    if (error.code === 'ROW_CONFLICT' || error.code === 'ROW_NOT_FOUND') showRowConflict(error);
    else toast(error.message || 'Không xóa được bản ghi.', 'error');
  } finally { selection.deleting = false; }
}

const QUERY_GRID_ROW_HEIGHT = 42;
const QUERY_GRID_WINDOW = 80;
const queryGridViewports = new WeakMap();

function renderQueryGridWindow(box, result) {
  if (!box?.isConnected || getActiveQueryResult() !== result) return;
  const viewport = queryGridViewport(result);
  viewport.top = box.scrollTop;
  viewport.left = box.scrollLeft;
  if (result.rows.length <= 200 || box.querySelector('.editing-cell')) return;
  const start = Math.max(0, Math.min(result.rows.length - QUERY_GRID_WINDOW,
    Math.floor(Math.max(0, box.scrollTop / (QUERY_GRID_ROW_HEIGHT * ((app.query.gridZoom || 100) / 100)) - 15) / 20) * 20));
  if (viewport.start === start && box.dataset.windowStart === String(start)) return;
  viewport.start = start;
  box.dataset.windowStart = String(start);
  box.querySelector('tbody').innerHTML = queryGridBodyHtml(result, start);
}

function setupQueryGridViewport(output) {
  let frame = null;
  const restore = () => {
    const result = getActiveQueryResult();
    const box = output.querySelector('[data-query-grid]');
    if (!result || !box) return;
    const viewport = queryGridViewport(result);
    box.scrollTop = viewport.top;
    box.scrollLeft = viewport.left;
    box.dataset.windowStart = String(viewport.start);
  };
  restore();
  const observer = new MutationObserver(() => {
    if (!output.isConnected) { observer.disconnect(); return; }
    restore();
  });
  observer.observe(output, { childList: true });
  output.addEventListener('scroll', (event) => {
    const box = event.target;
    if (!box.matches?.('[data-query-grid]')) return;
    const result = getActiveQueryResult();
    if (!result) return;
    const viewport = queryGridViewport(result);
    viewport.top = box.scrollTop; viewport.left = box.scrollLeft;
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      renderQueryGridWindow(box, result);
    });
  }, true);
}

function queryGridViewport(result) {
  if (!queryGridViewports.has(result)) queryGridViewports.set(result, { top: 0, left: 0, start: 0 });
  return queryGridViewports.get(result);
}

function queryGridBodyHtml(result, start = 0) {
  const rows = queryGridOrderedRows(result);
  const selection = queryGridSelection(result);
  const virtual = rows.length > 200;
  const visible = virtual ? rows.slice(start, start + QUERY_GRID_WINDOW) : rows;
  const spacer = (count) => count > 0 ? `<tr aria-hidden="true" class="query-grid-spacer"><td colspan="${result.columns.length + 1}" style="height:${count * QUERY_GRID_ROW_HEIGHT}px"></td></tr>` : '';
  return (virtual ? spacer(start) : '') + visible.map(({ row, origIndex }, offset) => {
    const index = start + offset;
    return `
      <tr data-query-row="${origIndex}" class="${selection.rows.has(origIndex) ? 'query-row-selected' : ''}" aria-selected="${selection.rows.has(origIndex)}">
        <td class="muted">${index + 1}</td>
        ${row.map((value, colIdx) => {
          let displayVal = value;
          const colMeta = result.columns[colIdx];
          if (app.maskData && !result.isExplain && typeof SqlDataMasking !== 'undefined') {
            const rule = SqlDataMasking.detectMaskType(colMeta?.name, colMeta?.type);
            if (rule) displayVal = SqlDataMasking.maskValue(value, rule);
          }
          const isNull = displayVal === null || displayVal === undefined;
          const text = isNull ? 'NULL' : String(displayVal);
          const shown = text.length > 180 ? `${text.slice(0, 180)}…` : text;
          let cellDisplay = isNull ? '<span class="null-badge">NULL</span>' : esc(shown);
          const colName = colMeta ? colMeta.name.toLowerCase() : '';
          if (result.isExplain && colName === 'type' && !isNull) {
            const access = window.SqlQueryResults.explainAccess(value);
            if (access) cellDisplay = `<span class="explain-badge ${access.tone}" title="${esc(access.description)}">${esc(shown)}</span>`;
          } else if (result.isExplain && colName === 'extra' && !isNull) {
            cellDisplay = cellDisplay
              .replace(/\bUsing filesort\b/gi, '<span class="explain-extra-warn" title="Có bước sắp xếp riêng; chưa chứng minh phải ghi tệp ra đĩa.">$&</span>')
              .replace(/\bUsing temporary\b/gi, '<span class="explain-extra-warn" title="Có bảng tạm; chưa xác định nằm trong RAM hay trên đĩa.">$&</span>');
          }
          return `<td class="${isNull ? 'nullcell' : ''}" data-col="${esc(colMeta?.name || '')}" data-col-idx="${colIdx}" title="${esc(text.slice(0, 500))}">${cellDisplay}</td>`;
        }).join('')}
      </tr>`;
  }).join('') + (virtual ? spacer(Math.max(0, rows.length - start - visible.length)) : '')
    || `<tr><td colspan="${result.columns.length + 1}" class="empty">Không có dòng nào.</td></tr>`;
}

function explainReviewHtml(result) {
  const document = window.SqlQueryResults.explainDocument(result);
  if (result.isAnalyze === true) return `<section class="explain-review explain-document analyze-review" aria-label="Kết quả ANALYZE đã thực thi">
    <p><strong>ANALYZE đã thực thi SELECT</strong> · ${esc(result.analysis?.engine || 'Server')} · ${esc(document?.format || 'Văn bản server')}</p>
    <p>Thống kê thực tế nằm trong plan gốc của server. Thời gian nhận kết quả của ứng dụng gồm thực thi và truyền dữ liệu; không cộng thời gian/dòng của các bước hoặc suy nhanh hơn từ một lần đo.</p>
    <p>Xuất CSV/JSON chỉ lưu kết quả đã nhận, không chạy lại ANALYZE. Không dùng kết quả này làm mốc so sánh EXPLAIN.</p>
    ${document ? `<details><summary>Xem plan ANALYZE ${esc(document.format)}</summary>
      ${document.truncated ? '<p>Nội dung viewer bị giới hạn; chưa đại diện toàn bộ plan đã nhận.</p>' : ''}
      ${document.status === 'invalid-json' ? '<p>JSON chưa hợp lệ; giữ văn bản server.</p>' : ''}
      <pre tabindex="0" aria-label="Plan ANALYZE thực tế">${esc(document.text)}</pre></details>` : '<p>Chưa nhận diện định dạng; xem bảng kết quả gốc bên dưới.</p>'}
    ${result.truncated ? '<p>Kết quả server bị cắt theo giới hạn nhận; không thể xuất bản đầy đủ từ lần chạy này.</p>' : ''}
  </section>`;
  if (document) return `<section class="explain-review explain-document" aria-label="Nội dung plan EXPLAIN">
    <details><summary>Xem plan ${esc(document.format)} · ${document.status === 'formatted' ? 'Đã thụt lề' : 'Văn bản server'}</summary>
      <p>Định dạng được nhận từ server; nội dung có thể chứa điều kiện và giá trị của truy vấn. Không quy đổi plan giữa MySQL/MariaDB hoặc kết luận thời gian chạy thực tế.</p>
      ${document.status === 'invalid-json' ? '<p>Không đọc được JSON hợp lệ; giữ văn bản đã nhận.</p>' : ''}
      ${document.truncated ? '<p>Đã giới hạn dung lượng/độ sâu/số phần tử hoặc kết quả server bị cắt. Nội dung chưa được xác nhận đầy đủ; dùng xuất kết quả để lấy dữ liệu.</p>' : ''}
      <pre tabindex="0" aria-label="Văn bản plan EXPLAIN">${esc(document.text)}</pre>
    </details></section>`;
  const review = window.SqlQueryResults.reviewExplain(result);
  if (!review) return '';
  const labels = {
    FULL_TABLE_SCAN: 'ALL: quét toàn bảng có thể phù hợp với bảng nhỏ hoặc khi cần phần lớn dữ liệu. Xem điều kiện lọc và index hiện có trước khi cân nhắc thay đổi.',
    FULL_INDEX_SCAN: 'index: quét toàn chỉ mục; có dùng index vẫn chưa chứng minh truy vấn nhanh.',
    FILESORT: 'Using filesort: có bước sắp xếp riêng; có thể thực hiện trong RAM, không tự chứng minh ghi ra đĩa.',
    TEMPORARY_TABLE: 'Using temporary: có bảng tạm để xử lý kết quả; chưa cho biết dùng RAM hay đĩa.'
  };
  const signals = [...new Set(review.rows.flatMap(row => row.signals))];
  const shown = review.rows.slice(0, 50);
  return `<section class="explain-review" aria-label="Giải thích EXPLAIN">
    <details><summary>Đọc kế hoạch EXPLAIN · Ước lượng · ${shown.length} bước</summary>
      <p>rows và filtered là ước lượng của optimizer. Thời gian nhận EXPLAIN không phải thời gian chạy truy vấn gốc.</p>
      <p>Đọc cùng điều kiện WHERE/JOIN/ORDER BY, lượng dữ liệu và thống kê hiện có. Không cộng rows của các bước JOIN thành tổng dòng thực tế; filtered không phải tỷ lệ hoàn thành.</p>
      <ul>${signals.map(code => `<li>${esc(labels[code])}</li>`).join('') || '<li>Chưa thấy ALL/index/filesort/temporary trong phần đã đọc; chưa đủ để kết luận kế hoạch tối ưu.</li>'}</ul>
      <div class="explain-review-table"><table><thead><tr><th>Bước</th><th>Bảng</th><th>Truy cập</th><th>Index đã chọn</th><th>rows ước lượng</th><th>filtered ước lượng</th></tr></thead><tbody>${shown.map(row => `<tr><td>${row.number}</td><td>${esc(row.table ?? 'Chưa xác định')}</td><td>${esc(row.access ?? 'Chưa xác định')}</td><td>${esc(row.key ?? 'Chưa xác định')}</td><td>${row.estimatedRows ?? 'Chưa xác định'}</td><td>${row.filteredPercent === null ? 'Chưa xác định' : `${row.filteredPercent}%`}</td></tr>`).join('')}</tbody></table></div>
      ${review.truncated || review.rows.length > shown.length ? '<p>Phần giải thích đã giới hạn; không đại diện toàn bộ kế hoạch. Bảng kết quả gốc bên dưới vẫn giữ dữ liệu đã nhận.</p>' : ''}
      <p>ALL/filesort/temporary là tín hiệu cần xem xét. Chỉ quyết định thêm index sau khi đối chiếu workload và đo kiểm; các kiểu truy cập khác cũng không bảo đảm nhanh.</p>
    </details></section>`;
}

function explainComparisonHtml(comparison, settingsContent = '') {
  if (comparison?.version !== 1) return settingsContent ? `<section class="explain-review">${settingsContent}</section>` : '';
  const labels = { unknown: 'Chưa đủ bằng chứng để so sánh', baseline: 'Đã tạo mốc đầu',
    'different-scope': 'Ngữ cảnh đổi · Đã tạo mốc mới', 'settings-changed': 'Thiết lập đã đổi · Không so plan · Đã tạo mốc mới',
    'schema-changed': 'Định nghĩa bảng đã nhận đổi · Không so plan · Đã tạo mốc mới',
    changed: 'Nội dung plan đã thay đổi', unchanged: 'Nội dung plan đã nhận giống nhau' };
  if (!Object.hasOwn(labels, comparison.status)) return '';
  const cell = row => row ? `${row.table ?? '?'} · ${row.access ?? '?'} · index ${row.key ?? '?'} · rows ${row.estimatedRows ?? '?'} · filtered ${row.filteredPercent ?? '?'}% · Extra ${row.extra ?? '?'}` : 'Không có bước này';
  return `<section class="explain-review explain-comparison" aria-label="So sánh EXPLAIN liên tiếp"><details>
    <summary>So sánh hai lần EXPLAIN · ${esc(labels[comparison.status])}</summary>
    <p>Chỉ so hai kết quả liên tiếp có cùng SQL chính xác (gồm literal), profile, database, phiên và lựa chọn định dạng. Không xác nhận schema, thống kê, thiết lập phiên hoặc dữ liệu không đổi; không kết luận nhanh/chậm hơn từ khác biệt plan.</p>
    ${comparison.currentAt ? `<p>Mốc trước: ${esc(comparison.previousAt || 'Chưa có')} · Lần này: ${esc(comparison.currentAt)}</p>` : ''}
    ${comparison.status === 'unknown' ? '<p>Kết quả cũ/thiếu context/sai định dạng/quá giới hạn/bị cắt không được dùng làm mốc. Chạy EXPLAIN hợp lệ để tạo mốc mới.</p>' : ''}
    ${comparison.status === 'settings-changed' ? `<p>Thiết lập quan sát khác nhau: ${esc((comparison.changedFields || []).filter(name => window.SqlQueryResults.explainSettingNames.includes(name)).join(', '))}. Không đối chiếu nội dung plan giữa hai ngữ cảnh này.</p>` : ''}
    ${comparison.status === 'schema-changed' ? '<p>Văn bản SHOW CREATE TABLE đã nhận khác nhau. Không đối chiếu nội dung plan giữa hai quan sát này; chưa kết luận nguyên nhân hoặc tác động hiệu năng.</p>' : ''}
    ${settingsContent}
    ${comparison.changes?.length ? `<div class="explain-review-table" tabindex="0" role="region" aria-label="Các bước plan thay đổi"><table><thead><tr><th>Bước theo thứ tự kết quả</th><th>Trước</th><th>Sau</th></tr></thead><tbody>${comparison.changes.map(change => `<tr><td>${Number(change.number)}</td><td>${esc(cell(change.before))}</td><td>${esc(cell(change.after))}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${comparison.status === 'changed' && comparison.format === 'TRADITIONAL' ? '<p>Các cột ngoài phần tóm tắt cũng có thể đổi; Extra hiện tối đa 4.096 ký tự mỗi bước. Ghép bước theo vị trí, chưa đối chiếu ngữ nghĩa JOIN hoặc chứng minh các bước tương đương.</p>' : ''}
    ${comparison.beforeText !== null && typeof comparison.beforeText === 'string' ? `<p>Plan trước</p><pre tabindex="0" aria-label="Plan trước">${esc(comparison.beforeText)}</pre><p>Plan sau</p><pre tabindex="0" aria-label="Plan sau">${esc(comparison.afterText || '')}</pre>` : ''}
    ${comparison.rowsLimited ? '<p>Hiện tối đa 50 bước khác biệt; kết luận dựa trên kết quả trong giới hạn quan sát.</p>' : ''}
    <p>Mốc chỉ nằm trong bộ nhớ tab; mỗi lần thành công thay mốc bằng kết quả mới. Lỗi/hủy, chạy SQL thường hoặc đóng tab xóa mốc. Không lưu thêm plan vào workspace/log. Chỉ khi bật các tùy chọn ngữ cảnh mới đọc thêm metadata trước/sau.</p>
    </details></section>`;
}

function explainSettingsHtml(result) {
  if (result.isAnalyze || !result.explainSettingsRequested) return '';
  const settings = window.SqlQueryResults.explainSettings(result.explainContext?.settings);
  const label = settings.status === 'observed' ? 'Khớp ở hai lần đọc trước/sau'
    : settings.status === 'changed-during-run' ? 'Phát hiện thay đổi trong lượt chạy · Bỏ mốc so sánh' : 'Chưa đủ thông tin · Bỏ mốc so sánh';
  return `<section class="explain-settings-review" aria-label="Thiết lập phiên của EXPLAIN"><details>
    <summary>Thiết lập phiên · ${esc(label)}</summary>
    <p>Đọc tối đa hai SELECT metadata trên cùng phiên với EXPLAIN. Chỉ đối chiếu danh sách: ${esc(window.SqlQueryResults.explainSettingNames.join(', '))}.</p>
    ${settings.status === 'changed-during-run' ? `<p>Thuộc tính đã đổi: ${esc(settings.changedFields.join(', '))}.</p>` : ''}
    <p>Hai lần đọc giống nhau không chứng minh thiết lập không đổi giữa chừng. Chưa xác nhận schema, thống kê, dữ liệu, mọi thiết lập riêng của engine hoặc ngữ cảnh bind parameter; không suy nhanh/chậm hơn.</p>
    <p>Chỉ giữ dấu vân tay tạm trong bộ nhớ, không hiển thị hoặc lưu thêm giá trị thiết lập. Lỗi metadata giữ kết quả EXPLAIN đã hoàn tất; không tự thử lại hoặc thay cấu hình phiên.</p>
    <p>Hủy/timeout trong lúc đọc metadata đóng phiên như truy vấn thường; transaction chưa commit có thể bị server rollback khi mất kết nối.</p>
    </details></section>`;
}

function explainSchemaHtml(result) {
  if (result.isAnalyze || !result.explainSchemaRequested) return '';
  const schema = window.SqlQueryResults.explainSchema(result.explainContext?.schema);
  const label = schema.status === 'observed' ? 'Văn bản khớp ở hai lần đọc trước/sau'
    : schema.status === 'changed-during-run' ? 'Văn bản đổi trong lượt chạy · Bỏ mốc' : 'Chưa đủ thông tin · Bỏ mốc';
  return `<section class="explain-schema-review" aria-label="Định nghĩa bảng của EXPLAIN"><details>
    <summary>Định nghĩa bảng · ${esc(label)}</summary>
    ${schema.status !== 'unknown' ? `<p>Bảng đã quan sát: ${esc(schema.database)} · ${esc(schema.table)}.</p>` : ''}
    <p>Chỉ nhận SELECT trên một bảng trực tiếp. JOIN/CTE/subquery/view, nguồn chưa nhận diện, thiếu quyền, binary hoặc quá giới hạn chưa đủ để tạo mốc; kết quả EXPLAIN vẫn được giữ.</p>
    <p>Đọc tối đa hai SHOW CREATE TABLE trên cùng phiên, tối đa 2 giây/1 dòng/512 KiB mỗi lần trong hạn chờ chung. Chỉ giữ dấu vân tay trong bộ nhớ; không hiển thị hoặc lưu thêm DDL/default/comment.</p>
    <p>Đây là văn bản server trả về, không phải snapshot nguyên tử hoặc xác minh toàn schema. SQL mode có thể ẩn thuộc tính; AUTO_INCREMENT và định dạng cũng có thể làm văn bản đổi. Chưa kiểm chứng dependency, trigger/routine, thống kê, dữ liệu hoặc đầy đủ thiết lập phiên. Hai quan sát khớp không chứng minh không đổi giữa chừng.</p>
    <p>Không tự SET, Commit/Rollback, sửa bảng hoặc chạy ANALYZE. Hủy/timeout có thể đóng phiên và rollback transaction chưa commit như truy vấn thường.</p>
    </details></section>`;
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
  const header = `<tr><th></th>${result.columns.map((column, index) => {
    const sorted = sortCol === index;
    return `<th class="sortable${sorted ? (sortDir === 1 ? ' sorted-asc' : ' sorted-desc') : ''}" data-query-sort="${index}">${esc(column.name)} <small>${esc(column.type)}</small>${sorted ? `<span class="sort-arrow">${sortDir === 1 ? '▲' : '▼'}</span>` : ''}</th>`;
  }).join('')}</tr>`;
  const selection = queryGridSelection(result);

  const hasPk = result.columns && result.columns.some((c) => (c.flags & 2) || c.key === 'PRI');
  const hasTable = result.columns && result.columns.some((c) => c.table || c.orgTable);
  const isEditable = !connectionIsReadOnly(app.query?.resultContext?.profileId || app.query?.profileId || app.connection?.id)
    && !result.isExplain && (hasPk || (hasTable && Boolean(table) && app.primaryKey?.length));

  const viewport = queryGridViewport(result);
  const virtual = result.rows.length > 200;
  const start = virtual ? Math.min(viewport.start, Math.max(0, result.rows.length - QUERY_GRID_WINDOW)) : 0;
  const body = queryGridBodyHtml(result, start);
  const colgroup = virtual ? `<colgroup><col style="width:48px">${result.columns.map(() => '<col style="width:170px">').join('')}</colgroup>` : '';

  const badgeHtml = isEditable
    ? '<span class="query-mode-badge editable" title="Kết quả có khóa chính — nhấp đúp vào ô để sửa trực tiếp và lưu vào CSDL">✎ Sửa trực tiếp: Bật</span>'
    : '<span class="query-mode-badge readonly" title="Truy vấn chỉ đọc hoặc thiếu khóa chính (nhấp đúp để sao chép)">Chỉ đọc</span>';

  const exportToolbar = `
    <div class="query-grid-toolbar">
      <div class="actions-left">
        <span class="resulttitle">✓ ${result.rows.length} dòng · ${result.durationMs} ms${result.truncated ? ' · đã giới hạn hiển thị' : ''}</span>
        ${badgeHtml}
      </div>
      <div class="actions-right">
        <button type="button" data-click="toggle-mask" class="${app.maskData ? 'active' : ''}" title="Bật/Tắt che giấu dữ liệu nhạy cảm PII (Email, SĐT, Số thẻ, Mật khẩu)">🎭 ${app.maskData ? 'Đang che PII' : 'Che PII'}</button>
        <button type="button" data-click="export-result" data-format="csv" title="Xuất kết quả truy vấn ra CSV">↧ Xuất CSV</button>
        <button type="button" data-click="export-result" data-format="json" title="Xuất kết quả truy vấn ra JSON">↧ Xuất JSON</button>
      </div>
    </div>`;

  return `
    ${compact ? '' : exportToolbar}
    ${result.isExplain && !result.isAnalyze ? explainComparisonHtml(result.explainComparison, explainSettingsHtml(result) + explainSchemaHtml(result)) : ''}
    ${explainReviewHtml(result)}
    <div class="tablebox query-selectable-grid${virtual ? ' query-virtual-grid' : ''}" data-query-grid tabindex="0" role="region" aria-label="Kết quả SQL. Ctrl+A chọn tất cả dòng, Ctrl+C sao chép, Shift và nhấp để chọn một khoảng."><table ${virtual ? `style="width:${48 + result.columns.length * 170}px"` : ''} role="grid" aria-rowcount="${result.rows.length}" aria-multiselectable="true" aria-label="Dữ liệu kết quả SQL">${colgroup}<thead>${header}</thead><tbody>${body}</tbody></table></div>
    <div class="query-selection-status"><span data-query-selection-count aria-live="polite">${selection.rows.size.toLocaleString()} dòng đã chọn</span><span>Kéo chuột / Shift+nhấp · Ctrl+A chọn tất cả · Ctrl+C sao chép</span></div>
    ${compact ? `<div class="query-grid-status">${result.rows.length} dòng · ${result.durationMs} ms${result.truncated ? ' · đã giới hạn dữ liệu hiển thị' : ''}</div>` : ''}
    ${!compact && result.truncated ? `<div class="hint">${result.truncationReason === 'byte-limit' ? 'Dữ liệu hiển thị đã đạt giới hạn dung lượng.' : 'Kết quả hiển thị đã đạt giới hạn dòng.'} ${result.stoppedEarly ? 'Đã gửi yêu cầu dừng đọc phần còn lại.' : 'Phần còn lại được đọc bỏ để giữ phiên kết nối.'} Chọn xuất để lấy đầy đủ dữ liệu.</div>` : ''}
    ${!compact ? `
      <div class="hint query-grid-hint">
        ${isEditable
          ? 'ⓘ <span><strong>Chỉnh sửa trực tiếp</strong> &nbsp; Nhấp đúp vào một ô để sửa giá trị và lưu ngay vào database. Hoặc chọn bảng bên trái để quản lý đầy đủ.</span>'
          : 'ⓘ <span><strong>Chế độ chỉ đọc</strong> &nbsp; Nhấp đúp vào một ô để sao chép giá trị nhanh.</span>'}
      </div>
    ` : ''}
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

async function refreshQueryMetadata(result, tab = app.query) {
  if (!tab) return;
  const entries = result.kind === 'batch'
    ? result.results.filter((entry) => entry.ok).map((entry) => entry.result)
    : [result];
  const changedDatabase = typeof result.activeDatabase === 'string'
    && result.activeDatabase !== (tab.database || null);
  if (changedDatabase) tab.database = result.activeDatabase;
  if (!changedDatabase && !entries.some((entry) => entry.kind === 'ok')) return;
  invalidateSqlAutocomplete();
  const isActiveTarget = Boolean(tab.profileId && app.connection && tab.profileId === app.connection.id);
  if (changedDatabase && isActiveTarget) {
    app.database = result.activeDatabase;
    table = null;
    app.columns = [];
    app.rows = [];
    app.total = null;
    updateChrome();
  }
  const database = tab.database || (isActiveTarget ? app.database : null);
  if (!tab.profileId || !database) return;
  try {
    const tables = await call(desktop.db.tables(database, tab.profileId));
    if (isActiveTarget) {
      app.tables = tables;
      renderSidebar();
    }
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
  const analyze = $('#analyzeQueryBtn');
  if (analyze) analyze.disabled = running || Boolean(activeTransfer) || connectionIsReadOnly(app.query?.profileId);
  const format = $('#explainFormat');
  if (format) format.disabled = running;
  const settings = $('#explainSettings');
  if (settings) settings.disabled = running;
  const schema = $('#explainSchema');
  if (schema) schema.disabled = running;
  const timeout = $('#queryTimeout');
  if (timeout) timeout.disabled = Boolean(app.query?.running);
  const rowLimit = $('#queryRowLimit');
  if (rowLimit) rowLimit.disabled = Boolean(app.query?.running);
  if (cancel) cancel.style.display = running ? 'inline-block' : 'none';
}

function queryRowLimit(tab) {
  const value = Number(tab?.rowLimit);
  return [5000, 20000, 50000, 100000].includes(value) ? value : 50000;
}

function queryTimeoutMs(tab) {
  const value = Number(tab?.timeoutMs);
  return [30000, 60000, 300000, 900000].includes(value) ? value : 300000;
}

async function runQuery() {
  const tab = app.query;
  if (!tab || tab.running) return;
  if (!desktop) {
    toast('Ứng dụng desktop chưa sẵn sàng.', 'error');
    return;
  }
  if (queryTabs.some((item) => item.running)) {
    toast('Một truy vấn khác đang chạy. Hãy chờ hoặc hủy trước.', 'error');
    return;
  }
  explainObservations.delete(tab);
  const editor = $('#sql');
  const rawSql = (editor?.value || tab.sql || '').trim();
  if (!rawSql) {
    toast('Câu lệnh SQL đang trống.', 'error');
    return;
  }
  const target = await ensureQueryTarget(tab);
  if (!target) return;
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
  tab.taskId = newQueryTaskId();
  tab.running = true;
  tab.error = null;
  updateQueryButtons();
  renderQueryTabs();
  if (app.query === tab && $('#queryResult')) {
    $('#queryResult').innerHTML = `<div class="empty">${isSelection ? 'Đang chạy đoạn mã được chọn…' : 'Đang chạy truy vấn…'}</div>`;
  }
  try {
    let result;
    const request = {
      sql: sqlToRun,
      timeoutMs: queryTimeoutMs(tab),
      rowLimit: queryRowLimit(tab),
      profileId: target.profileId,
      database: tab.database || null,
      taskId: tab.taskId
    };
    try {
      result = await call(desktop.db.query(request));
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
      result = await call(desktop.db.query({ ...request, confirmed: true }));
    }
    tab.result = result;
    tab.lastSql = sqlToRun;
    tab.resultContext = { profileId: target.profileId, database: request.database };
    tab.error = null;
    tab.resultTab = result.kind === 'batch'
      ? (result.failedCount ? 'message' : queryBatchTabs(result).find((item) => item.entry)?.key || 'message')
      : null;
    tab.resultView = 'data';
    tab.sortCol = null;
    tab.sortDir = 'ASC';
    await refreshQueryMetadata(result, tab);
    maybeRefreshObjectMetadata(sqlToRun, tab);
    const batchFailed = result.kind === 'batch' && result.failedCount > 0;
    const historyMessage = result.kind === 'batch'
      ? `${result.succeededCount}/${result.statementCount} câu lệnh`
      : (result.kind === 'ok' ? `${result.affectedRows} dòng` : `${result.rows.length} dòng`);
    historyRows.unshift(normalizeHistory({
      sql: sqlToRun,
      ok: !batchFailed,
      at: new Date().toISOString(),
      durationMs: result.durationMs,
      message: historyMessage,
      profileId: target.profileId,
      database: tab.database || null
    }));
    historyRows = historyRows.slice(0, 500);
    const classified = typeof SqlAuditLog !== 'undefined' ? SqlAuditLog.classifySqlAction(sqlToRun) : { actionType: 'QUERY', table: null };
    const affectedCount = result.kind === 'batch'
      ? result.succeededCount
      : (result.kind === 'ok' ? result.affectedRows : (result.rows ? result.rows.length : 0));
    void recordAudit({
      profileId: target.profileId,
      database: tab.database || null,
      table: classified.table,
      actionType: classified.actionType,
      affectedRows: affectedCount,
      durationMs: result.durationMs || 0,
      status: batchFailed ? 'error' : 'success',
      errorCode: batchFailed ? 'BATCH_FAILED' : null,
      errorSummary: batchFailed ? (result.results.find((entry) => !entry.ok)?.error?.message || 'Lỗi câu lệnh SQL') : null
    });
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
    historyRows.unshift(normalizeHistory({
      sql: sqlToRun,
      ok: false,
      at: new Date().toISOString(),
      durationMs: null,
      message: error.message,
      profileId: target.profileId,
      database: tab.database || null
    }));
    historyRows = historyRows.slice(0, 500);
    const classified = typeof SqlAuditLog !== 'undefined' ? SqlAuditLog.classifySqlAction(sqlToRun) : { actionType: 'QUERY', table: null };
    void recordAudit({
      profileId: target?.profileId || null,
      database: tab.database || null,
      table: classified.table,
      actionType: classified.actionType,
      durationMs: 0,
      status: 'error',
      errorCode: error.code || 'QUERY_ERROR',
      errorSummary: error.message
    });
    setStatus(error.message);
    if (error.code === 'SESSION_CLOSED' || error.code === 'QUERY_TIMEOUT' || error.code === 'QUERY_CANCELED') {
      toast(`${error.message} Kết nối sẽ tự thiết lập lại ở lần chạy sau.`, 'error');
    } else {
      toast(error.message, 'error');
    }
  } finally {
    tab.running = false;
    tab.taskId = null;
    updateQueryButtons();
    renderQueryTabs();
    if (app.query === tab && $('#queryResult')) $('#queryResult').innerHTML = queryResultHtml();
    void refreshSessionState(target.profileId);
    persistState();
  }
}

async function cancelQuery() {
  const tab = app.query;
  if (!tab || !tab.running) {
    toast('Không có truy vấn nào đang chạy.');
    return;
  }
  try {
    const result = await call(desktop.db.cancelQuery(tab.profileId || null, tab.taskId || null));
    if (result && result.canceled) toast('Đã yêu cầu hủy truy vấn');
    else toast('Truy vấn đã dừng trước khi yêu cầu hủy được xử lý.');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function renderHistoryView() {
  const connectionName = (profileId) => {
    if (!profileId) return 'không rõ connection';
    const connection = app.connections.find((item) => item.id === profileId);
    return connection ? connection.name : 'connection đã xóa';
  };

  const filteredRows = QuerySnippets ? QuerySnippets.searchHistory(historyRows, {
    query: historyFilter.query,
    status: historyFilter.status
  }) : historyRows;

  $('#workspace').innerHTML = `
    <div class="toolbar history-toolbar">
      <input type="search" id="historySearchInput" class="history-search-input" placeholder="🔍 Tìm kiếm trong lịch sử SQL..." value="${esc(historyFilter.query)}" />
      <select id="historyStatusFilter" aria-label="Bộ lọc trạng thái">
        <option value="all" ${historyFilter.status === 'all' ? 'selected' : ''}>Tất cả trạng thái</option>
        <option value="ok" ${historyFilter.status === 'ok' ? 'selected' : ''}>Thành công</option>
        <option value="error" ${historyFilter.status === 'error' ? 'selected' : ''}>Lỗi</option>
      </select>
      <label class="history-scrub-label" title="Tự động ẩn mật khẩu, token và khóa bí mật trong câu lệnh SQL">
        <input type="checkbox" id="scrubSensitiveCheckbox" ${historyFilter.scrubSensitive ? 'checked' : ''} /> Ẩn thông tin nhạy cảm
      </label>
      <span class="spacer"></span>
      <select id="historyPruneSelect" aria-label="Dọn dẹp lịch sử">
        <option value="">Dọn dẹp lịch sử…</option>
        <option value="7">Giữ 7 ngày gần nhất</option>
        <option value="30">Giữ 30 ngày gần nhất</option>
        <option value="clear">Xóa toàn bộ lịch sử</option>
      </select>
      <button id="clearHistory" class="small-btn danger" title="Xóa toàn bộ lịch sử truy vấn">⌫ Xóa</button>
      <span class="subtle"><strong>${filteredRows.length}</strong> / ${historyRows.length} truy vấn</span>
    </div>
    <div class="history-list">
      ${filteredRows.map((entry, index) => {
        const displaySql = historyFilter.scrubSensitive && QuerySnippets
          ? QuerySnippets.scrubSensitiveSql(entry.sql)
          : entry.sql;
        return `
          <div class="historyrow" data-history="${index}">
            <span class="badge ${entry.ok ? '' : 'pending'}">${entry.ok ? 'OK' : 'Lỗi'}</span>
            <span class="mono history-sql" title="${esc(displaySql)}">${esc(displaySql.slice(0, 300))}</span>
            <span class="muted">${esc(connectionName(entry.profileId))} · ${esc(entry.database || '—')} · ${entry.durationMs === null ? '' : `${entry.durationMs} ms`} ${entry.at ? esc(new Date(entry.at).toLocaleString('vi-VN')) : ''}</span>
            <div class="history-row-actions">
              <button class="small-btn" data-history-action="open" data-history-idx="${index}" title="Mở trong tab SQL Editor">▷ Mở</button>
              <button class="small-btn" data-history-action="copy" data-history-idx="${index}" title="Sao chép SQL">📋 Chép</button>
              <button class="small-btn" data-history-action="snippet" data-history-idx="${index}" title="Lưu câu lệnh này thành Snippet">＋ Snippet</button>
            </div>
          </div>
        `;
      }).join('') || '<div class="empty">Chưa có truy vấn nào phù hợp với bộ lọc.</div>'}
    </div>
  `;

  const searchInput = $('#historySearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      historyFilter.query = e.target.value;
      renderHistoryView();
      const updatedInput = $('#historySearchInput');
      if (updatedInput) {
        updatedInput.focus();
        updatedInput.setSelectionRange(historyFilter.query.length, historyFilter.query.length);
      }
    });
  }

  $('#historyStatusFilter')?.addEventListener('change', (e) => {
    historyFilter.status = e.target.value;
    renderHistoryView();
  });

  $('#scrubSensitiveCheckbox')?.addEventListener('change', (e) => {
    historyFilter.scrubSensitive = e.target.checked;
    renderHistoryView();
  });

  $('#historyPruneSelect')?.addEventListener('change', (e) => {
    const val = e.target.value;
    if (!val) return;
    if (val === 'clear') {
      historyRows = [];
      toast('Đã xóa toàn bộ lịch sử truy vấn.', 'info');
    } else if (val === '7' || val === '30') {
      const days = Number(val);
      historyRows = QuerySnippets ? QuerySnippets.pruneHistory(historyRows, { maxDays: days }) : historyRows;
      toast(`Đã dọn dẹp lịch sử, chỉ giữ ${days} ngày gần nhất.`, 'info');
    }
    persistState();
    renderHistoryView();
  });

  $('#clearHistory')?.addEventListener('click', () => {
    historyRows = [];
    persistState();
    renderHistoryView();
  });

  $('#workspace').querySelectorAll('[data-history-action]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.dataset.historyAction;
      const idx = Number(btn.dataset.historyIdx);
      const entry = filteredRows[idx];
      if (!entry) return;

      if (action === 'open') {
        newQuery(entry.sql, { profileId: entry.profileId, database: entry.database });
      } else if (action === 'copy') {
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(entry.sql);
        }
        toast('Đã sao chép SQL vào clipboard', 'info');
      } else if (action === 'snippet') {
        renderSnippetFormModal({
          title: `Truy vấn ${entry.database || 'SQL'} (${new Date().toLocaleDateString('vi-VN')})`,
          shortcut: '',
          tags: entry.database ? [entry.database] : [],
          sql: entry.sql
        });
      }
    });
  });

  $('#workspace').querySelectorAll('[data-history]').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      const entry = filteredRows[Number(row.dataset.history)];
      if (!entry) return;
      newQuery(entry.sql, { profileId: entry.profileId, database: entry.database });
    });
  });
}

async function editRow(index, target = null) {
  const profileId = target?.profileId || app.connection?.id || null;
  if (connectionIsReadOnly(profileId)) { toast('Kết nối đang ở chế độ chỉ đọc.', 'error'); return; }
  const database = target?.database || app.database;
  const targetTable = target?.targetTable || table;
  if (!desktop || !database || !targetTable || !profileId) return;
  const editing = !target && Number.isInteger(index) && index >= 0 && index < app.rows.length;
  const row = editing ? app.rows[index] : null;
  let columns = target ? [] : app.columns;
  if (!columns.length) {
    try { columns = await call(desktop.db.columns(database, targetTable, profileId)); }
    catch (error) { toast(error.message, 'error'); return; }
  }
  if (target ? getActiveQueryResult() !== target.result
    : (app.connection?.id || null) !== profileId || app.database !== database || table !== targetTable) return;
  const primary = columns.filter((column) => column.key === 'PRI').map((column) => column.name);
  if (editing && !primary.length) { toast('Bảng không có khóa chính nên không thể sửa trực tiếp.', 'error'); return; }
  const fields = columns.filter((column) => editing || !/auto_increment/i.test(column.extra || ''));
  modal(`
    <h2>${editing ? 'Sửa bản ghi' : 'Thêm bản ghi'}</h2>
    <p>${esc(database)}.${esc(targetTable)} — thay đổi ghi trực tiếp vào database.</p>
    <form id="rowForm" class="fieldgrid row-value-form"></form>
    <div class="errorbox hidden" id="rowError" role="alert"></div>
    <div class="actions"><button type="button" id="rowCancel">Hủy</button><button type="button" class="primary" id="rowSave">${editing ? 'Lưu thay đổi' : 'Thêm bản ghi'}</button></div>
  `, true);
  const form = $('#rowForm');
  const errorBox = $('#rowError');
  const saveButton = $('#rowSave');
  const editors = new Map();
  fields.forEach((column) => {
    const editor = createRowValueEditor(column, row?.[column.name], { inserting: !editing, disabled: editing && primary.includes(column.name) });
    const field = document.createElement('div'); field.className = 'field';
    const label = document.createElement('label'); label.htmlFor = editor.input.id;
    label.appendChild(document.createTextNode(`${column.name} `));
    const type = document.createElement('small'); type.className = 'mono'; type.textContent = column.type; label.appendChild(type);
    field.append(label, editor.element); form.appendChild(field); editors.set(column.name, editor);
  });
  $('#rowCancel').addEventListener('click', closeModal);
  const save = async () => {
    if (saveButton.disabled) return;
    errorBox.classList.add('hidden');
    const values = {};
    for (const [name, editor] of editors) {
      try {
        const change = editor.read();
        if (change.mode === 'default' || change.mode === 'readonly' || (editing && !change.changed)) continue;
        values[name] = change.value;
      } catch (error) {
        editor.showError(error.message); editor.focus();
        errorBox.textContent = error.message; errorBox.classList.remove('hidden'); return;
      }
    }
    if (editing && !Object.keys(values).length) { toast('Không có thay đổi để lưu.'); closeModal(); return; }
    saveButton.disabled = true;
    editors.forEach((editor) => editor.setBusy(true));
    try {
      if (editing) {
        const keys = Object.fromEntries(primary.map((name) => [name, row[name]]));
        requireRowUpdate(await call(desktop.db.updateRow({ profileId, database, table: targetTable, keys, values, original: originalRow(row) })));
      } else await call(desktop.db.insertRow({ profileId, database, table: targetTable, values }));
      toast(editing ? 'Đã cập nhật bản ghi'
        : target ? 'Đã thêm bản ghi. Chạy lại SELECT nếu muốn cập nhật kết quả.' : 'Đã thêm bản ghi');
      if (form.isConnected) closeModal();
      if (!target && (app.connection?.id || null) === profileId && app.database === database && table === targetTable) await loadData();
    } catch (error) {
      if (error.code === 'ROW_CONFLICT' || error.code === 'ROW_NOT_FOUND') {
        showRowConflict(error, {
          reload: () => { closeModal(); void loadData(); }
        });
      }
      errorBox.textContent = error.message; errorBox.classList.remove('hidden');
    }
    finally { saveButton.disabled = false; editors.forEach((editor) => editor.setBusy(false)); }
  };
  form.addEventListener('submit', (event) => { event.preventDefault(); void save(); });
  form.addEventListener('keydown', (event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save(); } });
  saveButton.addEventListener('click', () => { void save(); });
}

async function deleteSelectedRows() {
  if (connectionIsReadOnly()) { toast('Kết nối đang ở chế độ chỉ đọc.', 'error'); return; }
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
  const originalValues = indexes.map((index) => originalRow(app.rows[index]));
  try {
    const result = await call(desktop.db.deleteRows({
      profileId: app.connection?.id || null,
      database: app.database,
      table,
      keysList,
      originalValues
    }));
    toast(`Đã xóa ${result.affectedRows} bản ghi`);
    await loadData();
  } catch (error) {
    if (error.code === 'ROW_CONFLICT' || error.code === 'ROW_NOT_FOUND') {
      showRowConflict(error, { reload: () => loadData() });
      return;
    }
    toast(error.message, 'error');
  }
}

function productionPreviewHtml(preview) {
  const labels = {'insert-row':'Thêm bản ghi','update-row':'Cập nhật bản ghi','delete-rows':'Xóa bản ghi',query:'Chạy SQL',commit:'Commit toàn phiên'};
  const risksHtml = (preview.syntaxRisks || []).map((risk) => `
    <div class="production-risk-banner ${risk.severity === 'destructive' ? 'risk-destructive' : 'risk-warning'}">
      <strong>${risk.severity === 'destructive' ? '⚠️ NGUY HIỂM' : '⚠️ CẢNH BÁO'}:</strong> ${esc(risk.message)}
    </div>
  `).join('');

  return `<h2>Xác nhận ghi trên Production</h2>
    <p><strong>${esc(preview.connectionName)}</strong> · ${esc(preview.host || '')}</p>
    <p>Database: <strong>${esc(preview.database || 'Chưa chọn')}</strong>${preview.table ? ` · Bảng: <strong>${esc(preview.table)}</strong>` : ''}</p>
    <p>Thao tác: ${esc(labels[preview.operation] || 'Ghi dữ liệu')}${preview.selectedRows === null ? ' · Số dòng ảnh hưởng chưa xác định' : ` · ${Number(preview.selectedRows).toLocaleString()} dòng được chọn (không tính tác động trigger/cascade)`}</p>
    ${preview.rowCountNotice ? `<p class="hint" style="font-style: italic;">ℹ️ ${esc(preview.rowCountNotice)}</p>` : ''}
    ${risksHtml}
    ${preview.columns?.length ? `<p>Cột thay đổi: ${preview.columns.map(esc).join(', ')}</p>` : ''}
    <label>SQL dự kiến — giá trị đã che</label><pre class="production-sql-preview">${esc(preview.sql)}</pre>
    ${preview.parameterCount ? `<p>${Number(preview.parameterCount).toLocaleString()} tham số · giá trị được che</p><ul class="production-parameters">${preview.parameters.map((entry) => `<li>#${Number(entry.position)} · ${esc(entry.type)} · ${esc(entry.value)}</li>`).join('')}</ul>` : ''}
    ${preview.hasDestructiveRisk ? `
      <label class="checkline" style="margin: 10px 0; font-weight: 600; color: #dc2626;">
        <input type="checkbox" id="productionRiskAcknowledge"> Tôi đã kiểm tra đúng đích và chấp nhận rủi ro thực thi thao tác phá hủy trên Production
      </label>
    ` : ''}
    <p class="hint">${esc(preview.note)}</p>
    <p class="hint">Xác nhận có hiệu lực trong 2 phút và chỉ dùng một lần. Nếu phiên hoặc nội dung đã đổi, cần xem trước lại.</p>
    <p class="securitywarning">${preview.inTransaction || preview.autocommit === false ? 'Thao tác nằm trong phiên có transaction/autocommit OFF; Commit/Rollback áp dụng toàn phiên. ' : ''}DDL có thể tự commit. Xác nhận không bảo đảm mọi thay đổi có thể hoàn tác.</p>
    <div class="actions"><button id="productionCancel">Hủy</button><button class="danger" id="productionConfirm" ${preview.hasDestructiveRisk ? 'disabled' : ''}>Xác nhận đúng đích và thực hiện</button></div>`;
}

function confirmProductionWrite(preview) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'confirmation-dialog production-confirmation';
    dialog.innerHTML = productionPreviewHtml(preview);
    document.body.appendChild(dialog);
    let settled = false;
    const finish = (accepted) => {
      if (settled) return;
      settled = true;
      dialog.close();dialog.remove();resolve(accepted);
    };
    dialog.addEventListener('close',() => finish(false));
    dialog.addEventListener('cancel',(event) => {event.preventDefault();finish(false);});
    dialog.querySelector('#productionCancel').addEventListener('click',() => finish(false));
    dialog.querySelector('#productionConfirm').addEventListener('click',() => finish(true));
    const ack = dialog.querySelector('#productionRiskAcknowledge');
    const confirmBtn = dialog.querySelector('#productionConfirm');
    if (ack && confirmBtn) {
      ack.addEventListener('change', () => {
        confirmBtn.disabled = !ack.checked;
      });
    }
    dialog.showModal();
    dialog.querySelector('#productionCancel').focus();
  });
}

function confirmAction(title, message, confirmLabel = 'Xác nhận', { separate = false } = {}) {
  return new Promise((resolve) => {
    const html = `
      <h2>${esc(title)}</h2>
      <p>${esc(message)}</p>
      <div class="actions">
        <button id="confirmCancel">Hủy</button>
        <button class="danger" id="confirmOk">${esc(confirmLabel)}</button>
      </div>
    `;
    const dialog = separate ? document.createElement('dialog') : $('#modal');
    if (separate) {
      dialog.className = 'confirmation-dialog';
      dialog.innerHTML = html;
      document.body.appendChild(dialog);
      dialog.showModal();
    } else modal(html);
    let settled = false;
    const onClose = () => {
      // Native close is queued. A previous use of the shared modal can finish
      // closing after a new confirmation has already reopened it.
      if (settled || dialog.open) return;
      settled = true;
      dialog.removeEventListener('close', onClose);
      if (separate) dialog.remove();
      resolve(false);
    };
    dialog.addEventListener('close', onClose);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      dialog.removeEventListener('close', onClose);
      resolve(value);
      if (separate) { dialog.close(); dialog.remove(); }
      else closeModal();
    };
    const find = (selector) => separate ? dialog.querySelector(selector) : $(selector);
    find('#confirmCancel').addEventListener('click', () => finish(false));
    find('#confirmOk').addEventListener('click', () => finish(true));
    if (separate) {
      dialog.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault(); event.stopPropagation(); finish(false);
      });
      find('#confirmCancel').focus();
    }
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
    conflict: 'Cần xử lý xung đột',
    offline: 'Ngoại tuyến',
    error: 'Lỗi đồng bộ',
    'reauth-required': 'Cần đăng nhập lại'
  };
  return labels[status.state] || 'Sẵn sàng';
}

function accountStateClass(status) {
  if (!status || !status.loggedIn) return 'signed-out';
  if (status.state === 'reauth-required') return 'reauth';
  if (status.state === 'conflict') return 'error';
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
      <div class="actions"><button type="button" data-click="close-modal">Đóng</button></div>
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

function showLocalRecovery() {
  if (!desktop?.account) return;
  modal(`<section id="localRecoveryEditor"><h2>Bộ phục hồi cục bộ</h2>
    <p>Xuất kết nối và workspace thành tệp mã hóa, giữ mã khôi phục ở nơi riêng. Không gồm SQL, backup database hoặc nội dung tệp SSH key/chứng chỉ. Bộ này không đặt lại mật khẩu tài khoản đồng bộ hay mật khẩu archive.</p>
    <button id="localRecoveryExport">Xuất bộ phục hồi mã hóa…</button>
    <label for="localRecoveryGenerated">Mã của bộ vừa xuất — cất riêng trước khi đóng</label><input id="localRecoveryGenerated" type="password" readonly autocomplete="off">
    <div class="actions"><button id="localRecoveryReveal">Hiện / ẩn mã</button><button id="localRecoveryCopy" disabled>Sao chép mã</button></div>
    <hr><p>Nhập bộ phục hồi sẽ thêm các bản sao với ID mới và giữ dữ liệu hiện tại. Cần đăng xuất đồng bộ trước; không tự gửi dữ liệu lên server.</p>
    <label for="localRecoveryCode">Mã khôi phục của tệp cần nhập</label><input id="localRecoveryCode" type="password" maxlength="256" autocomplete="off">
    <div class="actions"><button id="localRecoveryPrepare">Chọn tệp và xem trước…</button><button id="localRecoveryApply" disabled>Thêm dữ liệu phục hồi…</button></div>
    <p id="localRecoveryStatus" role="status" aria-live="polite">Giữ cả tệp mã hóa và mã khôi phục; thiếu một trong hai sẽ không mở được bộ này.</p>
    <div class="actions"><button data-click="close-modal">Đóng</button></div></section>`, true);
  const editor = $('#localRecoveryEditor'), output = $('#localRecoveryStatus'), dialog = $('#modal'), revision = modalRevision;
  const current = () => modalRevision === revision && dialog.open && $('#localRecoveryEditor') === editor;
  let busy = false, token = null;
  const revoke = () => { const previous = token; token = null; if (previous) void call(desktop.account.cancelLocalKit({ token: previous })).catch(() => {}); };
  const controls = () => {
    if (!current()) return;
    $('#localRecoveryExport').disabled = $('#localRecoveryPrepare').disabled = busy;
    $('#localRecoveryCode').disabled = busy;
    $('#localRecoveryApply').disabled = busy || !token;
    $('#localRecoveryCopy').disabled = !$('#localRecoveryGenerated').value;
  };
  const lifecycle = new MutationObserver(() => {
    if (!current()) {
      revoke(); editor.querySelector('#localRecoveryGenerated').value = '';
      editor.querySelector('#localRecoveryCode').value = ''; lifecycle.disconnect();
    }
  });
  lifecycle.observe(dialog, { attributes: true, childList: true, attributeFilter: ['open'] });
  $('#localRecoveryCode').addEventListener('input', () => { revoke(); controls(); });
  $('#localRecoveryReveal').addEventListener('click', () => {
    if (!current()) return;
    const input = $('#localRecoveryGenerated'); input.type = input.type === 'password' ? 'text' : 'password';
  });
  $('#localRecoveryCopy').addEventListener('click', async () => {
    if (!current()) return;
    try { await writeClipboardText($('#localRecoveryGenerated').value); if (current()) output.textContent = 'Đã sao chép mã. Hãy cất riêng khỏi tệp mã hóa.'; }
    catch { if (current()) output.textContent = 'Không sao chép được mã; dùng Hiện mã để lưu thủ công.'; }
  });
  $('#localRecoveryExport').addEventListener('click', async () => {
    if (busy || !current()) return;
    busy = true; controls();
    try {
      const result = await call(desktop.account.exportLocalKit());
      if (!current()) return;
      if (result.canceled) { output.textContent = 'Đã hủy xuất bộ phục hồi.'; return; }
      $('#localRecoveryGenerated').value = result.recoveryKey; $('#localRecoveryGenerated').type = 'password';
      output.textContent = `Đã xuất ${result.connections} kết nối và ${result.workspaces} workspace. Cất mã khôi phục riêng trước khi đóng.`;
    } catch (error) { if (current()) output.textContent = error.message; }
    finally { busy = false; controls(); }
  });
  $('#localRecoveryPrepare').addEventListener('click', async () => {
    if (busy || !current()) return;
    const recoveryKey = $('#localRecoveryCode').value;
    if (!recoveryKey.trim()) { output.textContent = 'Hãy nhập mã khôi phục của tệp.'; return; }
    revoke(); $('#localRecoveryCode').value = ''; busy = true; controls();
    try {
      const result = await call(desktop.account.prepareLocalKit({ recoveryKey }));
      if (!current()) { if (result.token) void call(desktop.account.cancelLocalKit({ token: result.token })).catch(() => {}); return; }
      if (result.canceled) { output.textContent = 'Đã hủy chọn bộ phục hồi.'; return; }
      token = result.token;
      output.textContent = `Sẽ thêm ${result.connections} kết nối và ${result.workspaces} workspace với ID mới. Giữ dữ liệu hiện tại. Xem trước hết hạn sau hai phút; cần xác nhận riêng khi thêm.`;
    } catch (error) { if (current()) output.textContent = error.message; }
    finally { busy = false; controls(); }
  });
  $('#localRecoveryApply').addEventListener('click', async () => {
    if (busy || !token || !current()) return;
    busy = true; controls();
    try {
      const result = await call(desktop.account.applyLocalKit({ token }));
      if (!current()) return;
      output.textContent = result.canceled ? 'Đã hủy nhập. Chọn lại tệp nếu muốn xem trước lần nữa.' : `Đã thêm ${result.connections} kết nối và ${result.workspaces} workspace; dữ liệu hiện tại được giữ nguyên.`;
      if (result.imported) { await refreshWorkspaces(); if (current()) await refreshConnections(); }
    } catch (error) { if (current()) output.textContent = error.message; }
    finally { busy = false; revoke(); controls(); }
  });
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
    <button type="button" id="accountLocalRecovery">Bộ phục hồi cục bộ…</button>
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
  $('#accountLocalRecovery').addEventListener('click', showLocalRecovery);
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
    resetExplainComparisons();
    invalidateSqlAutocomplete();
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

const SYNC_FIELD_LABELS = {
  name: 'Tên',
  host: 'Host',
  port: 'Port',
  user: 'User',
  username: 'User',
  password: 'Mật khẩu',
  database: 'Database',
  description: 'Mô tả',
  workspaceId: 'Workspace',
  'ssh.host': 'SSH host',
  'ssh.port': 'SSH port',
  'ssh.user': 'SSH user',
  'ssh.password': 'Mật khẩu SSH',
  'ssh.privateKeyPath': 'Private key',
  'ssh.passphrase': 'Passphrase SSH',
  'ssl.ca': 'SSL CA',
  'ssl.cert': 'SSL cert',
  'ssl.key': 'SSL key',
  'ssl.passphrase': 'Passphrase SSL',
  'ssl.rejectUnauthorized': 'Kiểm tra SSL'
};

function syncFieldLabel(path) {
  if (SYNC_FIELD_LABELS[path]) return SYNC_FIELD_LABELS[path];
  const leaf = String(path).split('.').at(-1);
  return SYNC_FIELD_LABELS[leaf] || path;
}

function syncFieldValue(value) {
  if (value === null || value === undefined || value === '') return '(trống)';
  if (typeof value === 'boolean') return value ? 'Có' : 'Không';
  return String(value).slice(0, 120);
}

let syncChoiceCounter = 0;

function syncConflictFieldHtml(conflict, field) {
  const label = esc(syncFieldLabel(field.path));
  if (!field.requiresChoice) {
    const kept = field.localChanged ? field.local : field.remote;
    const value = field.secret
      ? '<em>Giá trị nhạy cảm không được hiển thị.</em>'
      : `<em>Giữ giá trị máy này: ${esc(syncFieldValue(kept))}</em>`;
    return `
      <div class="syncfield">
        <span>${label}</span>
        <div class="syncvalues">${value}</div>
      </div>`;
  }
  syncChoiceCounter += 1;
  const name = `syncChoice${syncChoiceCounter}`;
  const localLabel = field.secret ? 'Giữ giá trị trên máy này' : `Giữ của máy này: ${esc(syncFieldValue(field.local))}`;
  const remoteLabel = field.secret ? 'Dùng giá trị từ server' : `Dùng của server: ${esc(syncFieldValue(field.remote))}`;
  const values = field.secret
    ? '<div class="syncvalues"><em>Giá trị nhạy cảm không được hiển thị khi đồng bộ.</em></div>'
    : '';
  return `
    <div class="syncfield">
      <span>${label}</span>
      ${values}
      <div class="syncchoices">
        <label><input type="radio" name="${name}" data-sync-connection="${esc(conflict.id)}" data-sync-path="${esc(field.path)}" value="local" checked> ${localLabel}</label>
        <label><input type="radio" name="${name}" data-sync-connection="${esc(conflict.id)}" data-sync-path="${esc(field.path)}" value="remote"> ${remoteLabel}</label>
      </div>
    </div>`;
}

function syncConflictsHtml(status) {
  const conflicts = Array.isArray(status.conflicts) ? status.conflicts : [];
  if (!conflicts.length) return '';
  syncChoiceCounter = 0;
  const blocks = conflicts.map((conflict) => `
    <div class="syncconflict">
      <div class="syncconflicthead">
        <strong>${esc(conflict.name || conflict.id)}</strong>
        <span class="muted">${conflict.type === 'workspace' ? 'Workspace' : 'Kết nối'}</span>
      </div>
      ${(conflict.fields || []).map((field) => syncConflictFieldHtml(conflict, field)).join('')}
    </div>`).join('');
  return `
    <div class="syncsection">
      <h3>Xung đột cần xử lý</h3>
      <p class="accounthint">Các trường thay đổi ở cả hai máy được hợp nhất độc lập. Trường nhạy cảm (mật khẩu, khóa, host, user) cần bạn chọn một bên trước khi đồng bộ.</p>
      ${blocks}
    </div>`;
}

function syncRecoveryHtml(entries) {
  if (!entries.length) return '';
  const reasons = {
    'conflict-local': 'Bản trên máy này',
    'conflict-remote': 'Bản trên server',
    sync: 'Bản đồng bộ'
  };
  const rows = [...entries].reverse().map((entry) => `
    <div class="syncrecoveryrow">
      <div>
        <strong>${esc(reasons[entry.reason] || entry.reason || 'Bản phục hồi')}</strong>
        <span>${esc(formatSyncTime(entry.at))}</span>
      </div>
      <button type="button" data-recovery-id="${esc(entry.id)}">Khôi phục</button>
    </div>`).join('');
  return `
    <div class="syncsection">
      <h3>Bản phục hồi gần đây</h3>
      <p class="accounthint">Các bản snapshot được mã hóa trên máy trước mỗi lần ghi đè do xung đột.</p>
      <div class="syncrecovery">${rows}</div>
    </div>`;
}

async function renderAccountPanel(status) {
  const email = status.email || '';
  const label = accountStateLabel(status);
  const errorHtml = status.error?.message
    ? `<div class="errorbox">${esc(status.error.message)}</div>`
    : '';
  const reauth = status.state === 'reauth-required';
  const conflicts = Array.isArray(status.conflicts) ? status.conflicts : [];
  const needsChoice = Number(status.conflictCount) > 0
    || conflicts.some((conflict) => conflict.requiresChoice);
  let recovery = [];
  try {
    recovery = await call(desktop.account.listRecovery());
  } catch {
    recovery = [];
  }
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
    ${syncConflictsHtml(status)}
    ${syncRecoveryHtml(recovery)}
    <button type="button" id="accountLocalRecovery">Bộ phục hồi cục bộ…</button>
    <div class="accountnote">Connection và workspace được mã hóa trên máy trước khi gửi lên server. Server không đọc được host, user hay mật khẩu. Mật khẩu không thể khôi phục.</div>
    <div class="actions">
      <button type="button" id="accountLogout">Đăng xuất</button>
      <span class="spacer"></span>
      <button type="button" id="accountClose">Đóng</button>
      <button type="button" class="primary" id="accountSync" ${status.state === 'syncing' ? 'disabled' : ''}>${reauth ? 'Đăng nhập lại' : needsChoice ? 'Áp dụng lựa chọn' : 'Đồng bộ ngay'}</button>
    </div>
  `);
  $('#accountLocalRecovery').addEventListener('click', showLocalRecovery);
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
      if (needsChoice) {
        const fieldsByConnection = new Map();
        for (const input of document.querySelectorAll('#modal input[data-sync-path]:checked')) {
          const connectionId = input.dataset.syncConnection;
          if (!fieldsByConnection.has(connectionId)) fieldsByConnection.set(connectionId, {});
          fieldsByConnection.get(connectionId)[input.dataset.syncPath] = input.value;
        }
        await call(desktop.account.resolveConflicts(
          [...fieldsByConnection].map(([connectionId, fields]) => ({ connectionId, fields }))
        ));
      } else {
        await call(desktop.account.syncNow());
      }
      await refreshAccountStatus();
      if (app.account?.loggedIn) await renderAccountPanel(app.account);
      else closeModal();
      if (app.account?.state === 'conflict') {
        toast('Vẫn còn xung đột cần xử lý.', 'error');
        return;
      }
      toast('Đã đồng bộ dữ liệu');
    } catch (error) {
      button.disabled = false;
      button.textContent = needsChoice ? 'Áp dụng lựa chọn' : 'Đồng bộ ngay';
      await refreshAccountStatus();
      toast(error.message, 'error');
    }
  });
  document.querySelectorAll('#modal [data-recovery-id]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.dataset.recoveryId;
      const confirmed = await confirmAction(
        'Khôi phục bản đồng bộ',
        'Dữ liệu connection và workspace hiện tại sẽ được thay bằng bản phục hồi đã chọn. Bạn có chắc không?',
        'Khôi phục',
        { separate: true }
      );
      if (!confirmed) return;
      try {
        const result = await call(desktop.account.restoreRecovery(id));
        await refreshAccountStatus();
        if (app.account?.loggedIn) await renderAccountPanel(app.account);
        toast(`Đã khôi phục bản đồng bộ ${formatSyncTime(result.at)}`);
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  });
  $('#accountLogout').addEventListener('click', async () => {
    try {
      resetExplainComparisons();
      invalidateSqlAutocomplete();
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
  let trustedHostKey = existing?.ssh?.knownHostKey;
  const p = existing || {};
  const verifyChecked = existing ? p.ssl?.verify === true : true;
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
      <label for="connEnvironment">Môi trường</label>
      <select id="connEnvironment">
        ${[['unclassified', 'Chưa phân loại'], ['local', 'Local — phát triển'], ['staging', 'Staging — kiểm thử'], ['production', 'Production — dữ liệu thật']].map(([value, label]) => `<option value="${value}" ${connectionEnvironment(p).value === value ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
      <p class="hint">Nhãn giúp nhận biết đích thao tác; không thay đổi quyền truy cập database.</p>
      <label class="checkline"><input type="checkbox" id="connReadOnly" ${p.readOnly === true ? 'checked' : ''}> Chỉ đọc — chặn thao tác ghi trong SqlPro</label>
      <p class="hint">Nên dùng tài khoản database chỉ có quyền đọc. Cú pháp/hàm chưa được hỗ trợ sẽ bị chặn; quyền database bảo vệ cả tác động gián tiếp từ view/routine.</p>
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
        <label class="checkline"><input type="checkbox" id="connSslVerify" ${verifyChecked ? 'checked' : ''}> Xác thực chứng chỉ máy chủ</label>
        <div id="connTlsWarning" class="securitywarning hidden" role="status"></div>
        <label>CA cert (tùy chọn, nếu chứng chỉ máy chủ không được hệ thống tin cậy)</label><input id="connSslCa" value="${esc(p.ssl?.ca || '')}">
        <div class="formrow">
          <div><label>Client cert (chỉ khi máy chủ yêu cầu)</label><input id="connSslCert" value="${esc(p.ssl?.cert || '')}"></div>
          <div><label>Client key (chỉ khi máy chủ yêu cầu)</label><input id="connSslKey" value="${esc(p.ssl?.key || '')}"></div>
        </div>
        <label>Client key passphrase</label>
        <input id="connSslPassphrase" type="password" placeholder="${savedSslPassphrase ? 'Để trống = giữ passphrase đã lưu' : 'Passphrase (nếu có)'}">
      </div>
      <label class="checkline"><input type="checkbox" id="connCleartextPassword" ${p.allowCleartextPassword ? 'checked' : ''}> Cho phép xác thực mysql_clear_password</label>
      <div class="muted" style="font-size:11px;margin:0 0 12px 22px">Chỉ dùng khi máy chủ yêu cầu. Cần TLS đã xác thực hoặc SSH tunnel tới MySQL trên chính máy SSH (MySQL host localhost/127.0.0.1/::1).</div>
      <div id="connCleartextWarning" class="securitywarning hidden" role="status"></div>
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
        <div class="muted" style="font-size:11px">MySQL host ở trên là đích nhìn từ máy SSH. SSH host là máy trung gian SqlPro kết nối tới. Host key SSH được xác minh SHA-256 ở lần kết nối đầu tiên; thay đổi khóa sẽ bị chặn cho tới khi bạn xác nhận.</div>
        <div id="connSshWarning" class="securitywarning hidden" role="status"></div>
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
  const updateSecurityHints = () => {
    const setHint = (selector, text) => {
      const element = $(selector);
      if (!element) return;
      element.textContent = text || '';
      element.classList.toggle('hidden', !text);
    };
    const sslEnabled = $('#connSsl').checked;
    const verify = $('#connSslVerify').checked;
    const sshEnabled = $('#connSsh').checked;
    const cleartext = $('#connCleartextPassword').checked;
    const host = $('#connHost').value.trim() || 'host';
    const localTarget = ['localhost', '127.0.0.1', '::1'].includes(host.toLowerCase());

    let tlsWarning = '';
    if (sslEnabled && !verify) {
      const legacy = Boolean(existing && p.ssl?.legacyUnverified);
      tlsWarning = legacy
        ? '⚠ Cấu hình TLS này được lưu từ phiên bản cũ và chưa từng bật xác thực chứng chỉ. SqlPro giữ nguyên cách kết nối hiện tại để không làm gián đoạn công việc. Để nâng cấp, bật "Xác thực chứng chỉ máy chủ" và cung cấp CA nếu máy chủ dùng CA riêng.'
        : '⚠ TLS đang tắt xác thực chứng chỉ: SqlPro không kiểm tra chứng chỉ máy chủ nên kết nối có thể bị nghe lén hoặc giả mạo. Hãy bật "Xác thực chứng chỉ máy chủ" và cung cấp CA khi cần.';
    }
    setHint('#connTlsWarning', tlsWarning);

    let sshWarning = '';
    if (sshEnabled) {
      sshWarning = localTarget
        ? 'SSH tunnel chỉ bảo vệ đoạn từ máy này tới SSH host. MySQL đích là loopback nhìn từ SSH host, nhưng SqlPro không thể xác minh MySQL chỉ nghe loopback, không có proxy chuyển tiếp, hoặc đoạn nội bộ được mã hóa.'
        : `SSH tunnel chỉ bảo vệ đoạn từ máy này tới SSH host. Đoạn từ SSH host tới MySQL (${host}) phụ thuộc địa chỉ đích và cấu hình thực tế; không mặc định an toàn toàn tuyến.`;
      if (!sslEnabled) sshWarning += ' MySQL hiện không được TLS bảo vệ trên đoạn SSH host → MySQL.';
    }
    setHint('#connSshWarning', sshWarning);

    let cleartextWarning = '';
    if (cleartext) {
      if (sslEnabled && verify) {
        cleartextWarning = 'mysql_clear_password sẽ được gửi trong TLS đã xác thực chứng chỉ.';
      } else if (sshEnabled && localTarget) {
        cleartextWarning = '⚠ Chỉ được phép vì MySQL đích là loopback trên máy SSH và host key SSH phải được xác minh. SqlPro không thể xác minh cấu hình mạng thực tế của máy SSH hoặc rằng không có proxy chuyển tiếp.';
      } else {
        cleartextWarning = '⚠ Cấu hình này sẽ bị chặn: mysql_clear_password cần TLS đã xác thực chứng chỉ hoặc SSH tunnel tới MySQL loopback trên chính máy SSH với host key đã xác minh.';
      }
    }
    setHint('#connCleartextWarning', cleartextWarning);
  };

  const toggleOptions = () => {
    $('#sslFields').classList.toggle('hidden', !$('#connSsl').checked);
    $('#sshFields').classList.toggle('hidden', !$('#connSsh').checked);
    const useKey = $('#sshAuthMethod').value === 'key';
    $('#sshPasswordRow').classList.toggle('hidden', useKey);
    $('#sshKeyRows').classList.toggle('hidden', !useKey);
    updateSecurityHints();
  };
  $('#connSsl').addEventListener('change', toggleOptions);
  $('#connSsh').addEventListener('change', toggleOptions);
  $('#sshAuthMethod').addEventListener('change', toggleOptions);
  $('#connSslVerify').addEventListener('change', updateSecurityHints);
  $('#connCleartextPassword').addEventListener('change', updateSecurityHints);
  $('#connHost').addEventListener('input', updateSecurityHints);
  toggleOptions();

  const readForm = () => {
    const mysqlHost = $('#connHost').value.trim().toLowerCase();
    const sshToLocalMysql = $('#connSsh').checked && ['localhost', '127.0.0.1', '::1'].includes(mysqlHost);
    if ($('#connCleartextPassword').checked
      && !(($('#connSsl').checked && $('#connSslVerify').checked) || sshToLocalMysql)) {
      const error = new Error('mysql_clear_password yêu cầu TLS đã xác thực hoặc SSH tunnel tới MySQL trên chính máy SSH (MySQL host localhost/127.0.0.1/::1).');
      error.code = 'CLEARTEXT_AUTH_INSECURE_TRANSPORT';
      throw error;
    }
    const payload = {
      id: existing ? existing.id : undefined,
      workspaceId: $('#connWorkspace').value,
      name: $('#connName').value,
      environment: $('#connEnvironment').value,
      readOnly: $('#connReadOnly').checked,
      type: $('#connType').value,
      host: $('#connHost').value,
      port: Number($('#connPort').value),
      user: $('#connUser').value,
      database: $('#connDatabase').value,
      allowCleartextPassword: $('#connCleartextPassword').checked,
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
        privateKeyPath: $('#sshKeyPath').value,
        knownHostKey: trustedHostKey || undefined
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

  const handleHostKeyPrompt = async (error, payload) => {
    if (!payload?.ssh?.enabled || !['SSH_HOST_KEY_UNKNOWN', 'SSH_HOST_KEY_CHANGED'].includes(error?.code) || !error?.fingerprint) {
      return false;
    }
    const changed = error.code === 'SSH_HOST_KEY_CHANGED';
    const fingerprint = String(error.fingerprint);
    const expected = error.expectedFingerprint ? String(error.expectedFingerprint) : '';
    const accepted = await confirmAction(
      changed ? 'SSH host key đã thay đổi' : 'Tin cậy SSH host key lần đầu?',
      changed
        ? `Không kết nối tới ${payload.ssh.host}:${payload.ssh.port} trước khi bạn xác minh.\n\nFingerprint trước: ${expected}\nFingerprint mới: ${fingerprint}\n\nChỉ tin cậy nếu khóa mới khớp với quản trị viên máy chủ.`
        : `Chưa có SSH host key được tin cậy cho ${payload.ssh.host}:${payload.ssh.port}.\n\nFingerprint SHA-256: ${fingerprint}\n\nSo sánh với fingerprint do quản trị viên máy chủ cung cấp trước khi tin cậy.`,
      changed ? 'Tin cậy khóa mới' : 'Tin cậy và tiếp tục',
      { separate: true }
    );
    if (!accepted) return false;
    payload.ssh.knownHostKey = {
      host: payload.ssh.host,
      port: payload.ssh.port,
      fingerprint
    };
    trustedHostKey = payload.ssh.knownHostKey;
    return true;
  };

  $('#connCancel').addEventListener('click', closeModal);
  testButton.addEventListener('click', async () => {
    errorBox.classList.add('hidden');
    successBox.classList.add('hidden');
    testButton.disabled = true;
    testButton.textContent = 'Đang kiểm tra…';
    try {
      const payload = readForm();
      try {
        const result = await call(desktop.connections.test(payload));
        showSuccess(`✓ Kết nối thành công! Phiên bản: MySQL ${result.version || ''}\nBảo mật: ${connectionSecuritySummary(payload)}`);
      } catch (err) {
        if (await handleHostKeyPrompt(err, payload)) {
          testButton.textContent = 'Đang kiểm tra lại…';
          const result = await call(desktop.connections.test(payload));
          showSuccess(`✓ Đã tin cậy khóa! Kết nối thành công MySQL ${result.version || ''}\nBảo mật: ${connectionSecuritySummary(payload)}`);
        } else {
          throw err;
        }
      }
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

    let payload;
    try {
      payload = readForm();
      // 1. Kiểm tra kết nối trước khi lưu
      try {
        await call(desktop.connections.test(payload));
      } catch (err) {
        if (await handleHostKeyPrompt(err, payload)) {
          submitButton.textContent = 'Đang kiểm tra lại…';
          await call(desktop.connections.test(payload));
        } else {
          throw err;
        }
      }

      // 2. Kết nối thành công -> Lưu cấu hình và mở kết nối
      submitButton.textContent = 'Đang lưu…';
      const saved = await call(desktop.connections.save(payload));
      closeModal();
      if (saved.workspaceId) app.activeWorkspaceId = saved.workspaceId;
      await refreshConnections();
      await connectTo(saved.id);
    } catch (error) {
      showError(`Không thể kết nối đến cơ sở dữ liệu:\n${error.message}`, Boolean(payload), payload);
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
  const securityClass = profile.ssl?.enabled && profile.ssl.verify === true ? 'hint' : 'securitywarning';
  modal(`
    <h2>${esc(profile.name)}</h2>
    <p>${esc(profile.user || 'root')}@${esc(profile.host)}:${profile.port} · ${profile.type === 'mariadb' ? 'MariaDB' : 'MySQL'} · ${esc(connectionTransportBadge(profile))}${profile.ssh?.enabled ? ' · SSH tunnel' : ''}</p>
    <div class="${securityClass}">${esc(connectionSecuritySummary(profile))}</div>
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
    if (result.sessionsClosed) await disconnect();
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

let sessionStateRequestId = 0;
let transactionActionPending = false;

function transactionProfileId() {
  return mode === 'query' ? app.query?.profileId : app.connection?.id;
}

function renderTransactionBar() {
  const host = $('#transactionBar');
  if (!host) return;
  const profileId = transactionProfileId();
  const state = app.transactionState;
  const visible = Boolean(state?.connected && state.profileId === profileId);
  host.classList.toggle('hidden', !visible);
  if (!visible) return;
  const connection = app.connections.find((entry) => entry.id === profileId) || (app.connection?.id === profileId ? app.connection : null);
  const pending = state.inTransaction || state.autocommit === false;
  const disabled = !pending || state.busy || transactionActionPending;
  host.innerHTML = `${connectionEnvironmentBadge(connection)} <strong>${esc(connection?.name || profileId)}</strong>
    <span>Phiên ${esc(state.sessionId?.slice(0, 8) || '—')} · ${state.inTransaction ? 'Transaction đang mở' : 'Không có transaction đang mở'} · Autocommit ${state.autocommit ? 'ON' : 'OFF'}</span>
    ${state.transactionObservedAt ? `<span>Ghi nhận từ ${esc(new Date(state.transactionObservedAt).toLocaleTimeString('vi-VN'))}</span>` : ''}
    <button data-transaction-action="commit" ${disabled || connection?.readOnly ? 'disabled' : ''}>Commit</button>
    <button data-transaction-action="rollback" ${disabled ? 'disabled' : ''}>Rollback</button>
    <span class="hint">Các tab cùng kết nối dùng chung phiên. DDL có thể tự commit.</span>`;
}

async function finishTransaction(action) {
  if (!['commit', 'rollback'].includes(action) || transactionActionPending || !desktop?.db?.transaction) return;
  const state = app.transactionState;
  if (!state?.connected || state.profileId !== transactionProfileId() || state.busy) return;
  const profile = app.connections.find((entry) => entry.id === state.profileId) || app.connection;
  const payload = { action, profileId: state.profileId, sessionId: state.sessionId, transactionRevision: state.transactionRevision };
  transactionActionPending = true;
  renderTransactionBar();
  try {
    const accepted = await confirmAction(action === 'commit' ? 'Commit transaction?' : 'Rollback transaction?',
      `${profile?.name || state.profileId} · ${connectionEnvironment(profile).label}. Thao tác áp dụng cho toàn bộ transaction của phiên, gồm các tab dùng chung kết nối.`,
      action === 'commit' ? 'Commit' : 'Rollback');
    if (!accepted) return;
    // Changing the visible target while confirming invalidates this UI action.
    if (transactionProfileId() !== state.profileId || app.transactionState !== state) return;
    await call(desktop.db.transaction(payload));
    toast(action === 'commit' ? 'Đã commit transaction.' : 'Đã rollback transaction.');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    transactionActionPending = false;
    await refreshSessionState(transactionProfileId());
    renderTransactionBar();
  }
}

async function refreshSessionState(profileId = transactionProfileId() || app.connection?.id || null) {
  if (!desktop || !profileId || typeof desktop.db.sessionState !== 'function') return;
  const requestId = ++sessionStateRequestId;
  try {
    const state = await call(desktop.db.sessionState(profileId));
    if (requestId !== sessionStateRequestId) return;
    if (transactionProfileId() === profileId) {
      app.transactionState = state;
      renderTransactionBar();
    }
    if (app.connection?.id !== profileId || !state?.connected) return;
    app.sessionState = state;
    setConnectionState(
      'connected',
      state.inTransaction ? 'Đã kết nối · transaction' : (state.autocommit === false ? 'Đã kết nối · autocommit OFF' : 'Đã kết nối')
    );
  } catch {
    // session state is advisory; regular query errors still surface
  }
}

async function disconnect() {
  if (!desktop) return;
  invalidateSqlAutocomplete();
  const profileId = app.connection?.id || null;
  let result = null;
  try {
    result = await call(desktop.db.disconnect(profileId));
    if (result?.needsConfirmation) {
      const confirmed = await confirmAction(
        'Transaction chưa hoàn tất',
        'Phiên đang mở transaction chưa commit. Ngắt kết nối sẽ rollback các thay đổi chưa commit của transaction đó.',
        'Vẫn ngắt kết nối'
      );
      if (!confirmed) return;
      result = await call(desktop.db.disconnect(result.profileId || profileId, { force: true }));
    }
  } catch (error) {
    toast(error.message, 'error');
    return;
  }
  invalidateSqlAutocomplete();
  if (app.connection) {
    openConnectionIds.delete(app.connection.id);
    connectionViews.delete(app.connection.id);
  }
  app.sessionState = null;
  app.connection = null;
  app.database = null;
  app.databases = [];
  app.tables = [];
  app.columns = [];
  app.rows = [];
  resetObjectMetadata();
  table = null;
  setConnectionState('idle');
  renderSidebar();
  view('data');
  persistState();
}

function automaticRetentionResultHtml(result) {
  const retention = result?.retention;
  if (!retention || retention.status === 'disabled') return '';
  const status = { completed: 'Tự dọn hoàn tất', stopped: 'Đã dừng tự dọn', failed: 'Tự dọn có lỗi', skipped: 'Chưa tự dọn' }[retention.status] || 'Kết quả tự dọn';
  return `<section class="hint"><strong>${esc(status)}</strong><p>Bản backup mới đã được ghi thành công.${retention.reason ? ` ${esc(retention.reason)}` : ''}</p>
    ${Array.isArray(retention.deleted) ? `<p>Đã xóa ${retention.deleted.length} bản cũ · ${formatBytes(retention.reclaimedBytes || 0)} SQL; còn ${retention.remaining?.length || 0} bản trong kế hoạch chưa xóa.</p>` : ''}
    ${(retention.failed || []).map(error => `<p>${esc(error.id)}: ${esc(error.message || error.code)}${error.sqlDeleted ? ' · SQL đã xóa, cần kiểm tra metadata' : ''}</p>`).join('')}
    ${retention.historySaveError ? `<p>Không lưu được báo cáo cuối: ${esc(retention.historySaveError)}</p>` : ''}
    ${retention.warnings?.length ? '<p>Có giới hạn chưa đạt hoặc bản cần được giữ lại; xem trước retention để kiểm tra chi tiết.</p>' : ''}
    <p>Xem chi tiết trong Lịch sử dọn backup.</p></section>`;
}

function backupDatabase() {
  if (!desktop) return;
  if (!app.connection || !app.database) {
    toast('Chọn một database trước khi sao lưu.', 'error');
    return;
  }
  const profileId = app.connection.id;
  const database = app.database;
  const objects = app.tables || [];
  if (!objects.length) {
    toast('Database không có bảng hoặc view nào để sao lưu.', 'error');
    return;
  }
  modal(`
    <h2>Sao lưu database</h2>
    <p><strong>${esc(database)}</strong> · ${objects.length} đối tượng</p>
    <label class="checkline"><input type="checkbox" id="backupStructure" checked> Cấu trúc bảng, view, routine và event (CREATE)</label>
    <label class="checkline"><input type="checkbox" id="backupData" checked> Dữ liệu (INSERT)</label>
    <label class="checkline"><input type="checkbox" id="backupDrop"> Thêm DROP TABLE/VIEW/TRIGGER/ROUTINE/EVENT IF EXISTS</label>
    <label class="checkline"><input type="checkbox" id="backupStripDefiner"> Bỏ DEFINER khỏi view/routine/event để phục hồi bằng user hiện tại</label>
    <label>Đối tượng cần sao lưu</label>
    <div class="optionbox">
      <label class="checkline"><input type="checkbox" id="backupAll" checked> Chọn tất cả bảng và view (kể cả mục đang ẩn)</label>
      <div class="backup-search-row">
        <input type="search" id="backupTableSearch" placeholder="Tìm bảng hoặc view…" aria-label="Tìm bảng hoặc view" autocomplete="off">
        <button type="button" id="backupSelectVisible">Chọn kết quả</button>
        <button type="button" id="backupDeselectVisible">Bỏ chọn kết quả</button>
      </div>
      <div class="backup-search-count" id="backupTableCount" role="status" aria-live="polite"></div>
      <div class="backup-tables" id="backupTableList">
        ${objects.map((entry) => `
          <label class="checkline">
            <input type="checkbox" class="backup-table" value="${esc(entry.name)}" checked>
            <span>${entry.type === 'view' ? '◫' : '▦'} ${esc(entry.name)}</span>
          </label>
        `).join('')}
      </div>
      <div class="subtle backup-search-empty" id="backupTableEmpty" hidden>Không tìm thấy bảng hoặc view phù hợp.</div>
    </div>
    <div class="optionbox">
      <label class="checkline"><input type="checkbox" id="backupAllRoutines" checked disabled> Chọn tất cả routine và function</label>
      <div class="backup-tables" id="backupRoutineList"><span class="subtle">Đang đọc routine và function…</span></div>
      <div class="errorbox" id="backupRoutineError" hidden></div>
    </div>
    <div class="optionbox">
      <label class="checkline"><input type="checkbox" id="backupAllEvents" checked disabled> Chọn tất cả event</label>
      <div class="backup-tables" id="backupEventList"><span class="subtle">Đang đọc event…</span></div>
      <div class="errorbox" id="backupEventError" hidden></div>
    </div>
    <div class="hint">SqlPro tự lưu tệp .sql vào thư mục backup của ứng dụng và hiển thị trong nhánh Backups. Dung lượng phụ thuộc vào ổ đĩa và máy chủ MySQL.</div>
    <div class="hint">Backup dùng kết nối riêng và snapshot chung khi tất cả bảng dữ liệu là InnoDB. Với engine khác, hãy tạm dừng ghi dữ liệu. Tránh thay đổi cấu trúc bảng trong lúc sao lưu.</div>
    <div class="actions">
      <button data-click="close-modal">Hủy</button>
      <button class="primary" id="backupGo">Tạo bản sao lưu</button>
    </div>
  `, true);

  const all = $('#backupAll');
  const boxes = [...document.querySelectorAll('.backup-table')];
  const search = $('#backupTableSearch');
  const visibleBoxes = () => boxes.filter((box) => !box.closest('label').hidden);
  const syncAll = () => {
    const checked = boxes.filter((box) => box.checked).length;
    all.checked = checked === boxes.length;
    all.indeterminate = checked > 0 && checked < boxes.length;
    $('#backupTableCount').textContent = `Hiển thị ${visibleBoxes().length}/${boxes.length} · Đã chọn ${checked}`;
  };
  search.addEventListener('input', () => {
    const term = search.value.trim().toLocaleLowerCase();
    boxes.forEach((box) => {
      box.closest('label').hidden = !box.value.toLocaleLowerCase().includes(term);
    });
    $('#backupTableEmpty').hidden = visibleBoxes().length > 0;
    syncAll();
  });
  all.addEventListener('change', () => {
    boxes.forEach((box) => { box.checked = all.checked; });
    syncAll();
  });
  boxes.forEach((box) => box.addEventListener('change', syncAll));
  $('#backupSelectVisible').addEventListener('click', () => {
    visibleBoxes().forEach((box) => { box.checked = true; });
    syncAll();
  });
  $('#backupDeselectVisible').addEventListener('click', () => {
    visibleBoxes().forEach((box) => { box.checked = false; });
    syncAll();
  });
  syncAll();
  $('#backupStructure').addEventListener('change', () => {
    $('#backupDrop').disabled = !$('#backupStructure').checked;
  });

  let objectLoadPromise = Promise.resolve();
  const loadGroup = (kind, listSelector, errorSelector, emptyLabel) => {
    if (!$(listSelector)) return Promise.resolve();
    const api = kind === 'routine' ? desktop.db.routines : desktop.db.events;
    return call(api(database, profileId))
      .then((entries) => {
        if (!$(listSelector)) return;
        if (!entries.length) {
          $(listSelector).innerHTML = `<span class="subtle">${emptyLabel}</span>`;
          return;
        }
        $(listSelector).innerHTML = entries.map((entry) => {
          const value = kind === 'routine' ? `${entry.type}:${entry.name}` : entry.name;
          const icon = kind === 'routine' ? (entry.type === 'function' ? 'ƒ' : '⚙') : '◷';
          const suffix = kind === 'routine' ? (entry.type === 'function' ? 'function' : 'procedure') : 'event';
          return `
            <label class="checkline">
              <input type="checkbox" class="backup-${kind}" value="${esc(value)}" checked>
              <span>${icon} ${esc(entry.name)} <span class="tree-kind">${suffix}</span></span>
            </label>`;
        }).join('');
        const allBox = $(kind === 'routine' ? '#backupAllRoutines' : '#backupAllEvents');
        const groupBoxes = [...document.querySelectorAll(`.backup-${kind}`)];
        const syncGroup = () => {
          const checked = groupBoxes.filter((box) => box.checked).length;
          allBox.checked = checked === groupBoxes.length;
          allBox.indeterminate = checked > 0 && checked < groupBoxes.length;
        };
        allBox.disabled = false;
        allBox.checked = true;
        allBox.addEventListener('change', () => groupBoxes.forEach((box) => { box.checked = allBox.checked; }));
        groupBoxes.forEach((box) => box.addEventListener('change', syncGroup));
      })
      .catch((error) => {
        if (!$(errorSelector) || !$(listSelector)) return;
        $(listSelector).innerHTML = '';
        $(errorSelector).hidden = false;
        $(errorSelector).textContent = `Không đọc được ${kind === 'routine' ? 'routine/function' : 'event'}: ${error.message}. Các đối tượng này sẽ không được sao lưu.`;
      });
  };
  objectLoadPromise = Promise.all([
    loadGroup('routine', '#backupRoutineList', '#backupRoutineError', 'Database không có routine hoặc function.'),
    loadGroup('event', '#backupEventList', '#backupEventError', 'Database không có event.')
  ]);

  $('#backupGo').addEventListener('click', async () => {
    await objectLoadPromise;
    const selectedTables = boxes.filter((box) => box.checked).map((box) => box.value);
    const selectedRoutines = [...document.querySelectorAll('.backup-routine:checked')].map((box) => box.value);
    const selectedEvents = [...document.querySelectorAll('.backup-event:checked')].map((box) => box.value);
    if (!selectedTables.length && !selectedRoutines.length && !selectedEvents.length) {
      toast('Chọn ít nhất một bảng, view, routine hoặc event.', 'error');
      return;
    }
    const includeStructure = $('#backupStructure').checked;
    const includeData = $('#backupData').checked;
    if (!includeStructure && !includeData) {
      toast('Hãy chọn cấu trúc hoặc dữ liệu để sao lưu.', 'error');
      return;
    }
    if (!includeStructure && (selectedRoutines.length || selectedEvents.length)) {
      toast('Routine và event cần bật tùy chọn cấu trúc.', 'error');
      return;
    }
    const taskId = newTransferTaskId('backup');
    const payload = {
      profileId,
      database,
      taskId,
      tables: selectedTables,
      routines: selectedRoutines,
      events: selectedEvents,
      includeStructure,
      includeData,
      dropTables: includeStructure && $('#backupDrop').checked,
      stripDefiner: $('#backupStripDefiner').checked
    };
    closeModal();
    showTransferProgress('backup', database, { taskId, profileId });
    setStatus('Đang sao lưu…');
    try {
      const result = await call(desktop.db.backup(payload));
      if (result.canceled) {
        setStatus('Đã hủy sao lưu');
        finishBackgroundTransfer('canceled', 'Đã hủy sao lưu', `
          <p>Tệp tạm đã được xóa. Trước khi hủy, SqlPro đã đọc ${Number(result.rows || 0).toLocaleString()} dòng và ${Number(result.objects || 0).toLocaleString()} đối tượng (${formatBytes(result.bytes || 0)}).</p>
        `, taskId);
        return;
      }
      const parts = [];
      if (result.tables) parts.push(`${result.tables} bảng`);
      if (result.views) parts.push(`${result.views} view`);
      if (result.triggers) parts.push(`${result.triggers} trigger`);
      if (result.procedures) parts.push(`${result.procedures} procedure`);
      if (result.functions) parts.push(`${result.functions} function`);
      if (result.events) parts.push(`${result.events} event`);
      await refreshBackupList(payload.database, profileId);
      openTreeGroups.add('backups');
      renderSidebar();
      finishBackgroundTransfer('success', 'Sao lưu hoàn tất', `
        <p>Đã sao lưu ${parts.join(', ')} (${Number(result.rows || 0).toLocaleString()} dòng) · ${formatBytes(result.bytes)}.</p>
        ${(result.warnings || []).map((message) => `<div class="hint" role="status">${esc(message)}</div>`).join('')}
        ${backupIntegrityHtml(result)}
        ${automaticRetentionResultHtml(result)}
        <label>Đường dẫn tệp đã lưu</label>
        <input value="${esc(result.filePath)}" readonly aria-label="Đường dẫn tệp sao lưu">
      `, taskId);
      setStatus(`Sao lưu hoàn tất • ${formatBytes(result.bytes)}`);
    } catch (error) {
      finishBackgroundTransfer('error', 'Sao lưu thất bại', `
        <div class="errorbox">${esc(error.message)}</div>
      `, taskId);
      setStatus('Sao lưu thất bại');
    }
  });
}

function preflightFindingHtml(finding) {
  const label = finding.objectName
    ? `${finding.objectType ? `${finding.objectType} ` : ''}"${finding.objectName}"`
    : '';
  return `<li>${label ? `<strong>${esc(label)}</strong>: ` : ''}${esc(finding.message)}${finding.action ? `<br><span class="subtle">${esc(finding.action)}</span>` : ''}</li>`;
}

function restorePreflightHtml(preflight) {
  if (!preflight) return '';
  const groups = [
    { key: 'blocking', label: 'Vấn đề chặn phục hồi', className: 'errorbox' },
    { key: 'warning', label: 'Cảnh báo', className: 'hint' },
    { key: 'unknown', label: 'Chưa xác minh', className: 'hint' }
  ];
  const sections = groups.map((group) => {
    const findings = preflight[group.key] || [];
    if (!findings.length) return '';
    return `<div class="${group.className}" role="${group.key === 'blocking' ? 'alert' : 'status'}">
      <strong>${group.label} (${findings.length}):</strong>
      <ul>${findings.slice(0, 10).map(preflightFindingHtml).join('')}</ul>
      ${findings.length > 10 ? `<p>Còn ${findings.length - 10} vấn đề khác.</p>` : ''}
    </div>`;
  }).join('');
  const target = preflight.target || {};
  const impact = preflight.impact || {};
  const facts = [];
  if (target.version) facts.push(`${target.flavor ? `${target.flavor} ` : ''}${target.version}`);
  if (target.logBin !== null && target.logBin !== undefined) facts.push(`log_bin=${target.logBin ? 'ON' : 'OFF'}`);
  if (target.logBinTrustFunctionCreators !== null && target.logBinTrustFunctionCreators !== undefined) {
    facts.push(`log_bin_trust_function_creators=${target.logBinTrustFunctionCreators ? 'ON' : 'OFF'}`);
  }
  if (target.lowerCaseTableNames !== null && target.lowerCaseTableNames !== undefined) {
    facts.push(`lower_case_table_names=${target.lowerCaseTableNames}`);
  }
  const counts = [];
  if (impact.objects) counts.push(`${impact.objects} đối tượng`);
  if (impact.conflicts) counts.push(`${impact.conflicts} trùng tên`);
  if (impact.overwritten) counts.push(`${impact.overwritten} sẽ ghi đè`);
  return `
    <div class="preflight-report">
      <p><strong>Kiểm tra trước phục hồi:</strong> ${preflight.canProceed ? 'không có vấn đề chặn.' : 'đã dừng trước khi ghi câu lệnh đầu tiên.'}</p>
      ${sections}
      ${facts.length || counts.length ? `<p class="subtle">${esc([...facts, ...counts].join(' · '))}</p>` : ''}
      <p class="subtle">Kiểm tra này chỉ dựa trên thông tin đọc được trước khi chạy; không bảo đảm mọi câu lệnh SQL sẽ chạy thành công.</p>
    </div>`;
}

function restoreImpactHtml(impact) {
  if (!impact) return '';
  const executed = Number(impact.executed || 0);
  const statements = Number(impact.statements || 0);
  const skipped = Number(impact.skipped || 0);
  const dropped = Number(impact.droppedObjects || 0);
  const last = impact.lastObject
    ? ` Đối tượng gần nhất: ${impact.lastObject}${impact.lastCommand ? ` (${impact.lastCommand})` : ''}.`
    : '';
  if (impact.targetChanged === false) {
    return `<p class="hint">Chưa có thay đổi nào được ghi vào database đích.${executed ? ` Đã chạy ${executed.toLocaleString()} câu lệnh.` : ''}</p>`;
  }
  if (impact.targetChanged === true) {
    return `<div class="errorbox" role="alert">
      <strong>Database đích có thể đã thay đổi một phần.</strong>
      Đã chạy ${executed.toLocaleString()}${statements ? `/${statements.toLocaleString()}` : ''} câu lệnh${skipped ? `, bỏ qua ${skipped.toLocaleString()}` : ''}${dropped ? `, đã xóa ${dropped.toLocaleString()} đối tượng` : ''}.${esc(last)}
      SqlPro không tự động hoàn tác hoặc chạy lại; hãy kiểm tra dữ liệu thủ công trước khi tiếp tục.
    </div>`;
  }
  return `<p class="hint">Chưa xác định được chắc chắn database đích có thay đổi hay không.${executed ? ` Đã chạy ${executed.toLocaleString()} câu lệnh.` : ''}${esc(last)} Hãy kiểm tra dữ liệu trước khi chạy lại.</p>`;
}

function backupIntegrityHtml(backup) {
  if (!backup) return '';
  const checksum = backup.verification?.checksum;
  if (checksum === 'verified') {
    return `<p class="hint">✓ Checksum SHA-256 khớp${backup.checksum ? ` (${esc(String(backup.checksum).slice(0, 12))}…)` : ''}. Đây là mức “checksum khớp”, chưa phải “đã thử phục hồi”.</p>`;
  }
  if (checksum === 'mismatch') {
    return '<div class="errorbox" role="alert"><strong>Checksum không khớp.</strong> Tệp có thể đã bị sửa hoặc hỏng; không nên phục hồi cho đến khi kiểm tra lại.</div>';
  }
  if (backup.manifestError) {
    return `<p class="hint">Chưa xác minh được checksum: ${esc(backup.manifestError)}</p>`;
  }
  return '<p class="hint">Bản sao lưu này chưa có checksum (bản cũ). Có thể dùng “Xác minh” để tính SHA-256; manifest chỉ được tạo cho các bản sao lưu mới.</p>';
}

function restoreVerificationHtml(verification) {
  if (!verification) return '';
  const checks = verification.checks || {};
  if (verification.status === 'verified') {
    const fk = Number(checks.foreignKeys?.checked || 0);
    const rows = Number(checks.rowCounts?.checked || 0);
    return `<p class="hint">✓ <strong>Đã kiểm chứng:</strong> ${fk.toLocaleString()} khóa ngoại, ${rows.toLocaleString()} bảng đối chiếu số dòng, không có cảnh báo mất dữ liệu.</p>`;
  }
  if (verification.status === 'failed') {
    const problems = [];
    for (const orphan of checks.foreignKeys?.orphans || []) {
      problems.push(`${orphan.table} · ${orphan.constraint}: ${Number(orphan.orphans).toLocaleString()} dòng mồ côi tham chiếu ${orphan.referencedTable}`);
    }
    for (const mismatch of checks.rowCounts?.mismatches || []) {
      problems.push(`${mismatch.table}: dự kiến ${Number(mismatch.expected).toLocaleString()} dòng, thực tế ${Number(mismatch.actual).toLocaleString()}`);
    }
    for (const warning of checks.warnings?.items || []) {
      problems.push(`Câu #${warning.statement}: ${warning.code} ${warning.message}`);
    }
    if (checks.settings?.status === 'failed') problems.push(checks.settings.message);
    return `
      <div class="errorbox" role="alert">
        <strong>Đã chạy nhưng chưa kiểm chứng đạt.</strong>
        <ul>${problems.slice(0, 10).map((item) => `<li>${esc(item)}</li>`).join('')}</ul>
        ${problems.length > 10 ? `<p>Còn ${problems.length - 10} vấn đề khác.</p>` : ''}
      </div>
      <p class="hint">SqlPro không tự xóa hoặc sửa các dòng mồ côi. Hãy kiểm tra dữ liệu thủ công trước khi đưa database vào sử dụng.</p>`;
  }
  const limitations = (verification.limitations || []).slice(0, 8);
  return `
    <div class="hint">
      <strong>Đã chạy, chưa kiểm chứng đầy đủ.</strong>
      ${limitations.length ? `<ul>${limitations.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}
      ${(verification.limitations || []).length > limitations.length ? `<p>Còn ${verification.limitations.length - limitations.length} giới hạn khác.</p>` : ''}
    </div>`;
}

function restoreDatabase(backupId = null) {
  if (!desktop) return;
  if (!app.connection || !app.database) {
    toast('Chọn database trước khi phục hồi.', 'error');
    return;
  }
  const sourceDb = app.database;
  const sourceProfileId = app.connection.id;
  const isReadOnly = connectionIsReadOnly(sourceProfileId);
  const selectedBackup = backupId ? (app.backups || []).find((entry) => entry.id === backupId) : null;
  const backupSummary = backupObjectSummary(selectedBackup);
  const defaultNew = Boolean(backupId);
  const suggestedName = `${sourceDb}_copy`;
  const dbOptions = (app.databases || []).map((db) => `
    <option value="${esc(db)}" ${!defaultNew && db === sourceDb ? 'selected' : ''}>${esc(db)}${db === sourceDb ? ' (Hiện tại)' : ''}</option>
  `).join('');

  modal(`
    <h2>Phục hồi database</h2>
    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; margin: 10px 0;">
      <div>Nguồn: <strong>${esc(sourceDb)}</strong>${backupId ? ` · Bản sao lưu <code>${esc(backupId.slice(0, 14))}</code>` : ' · Tệp .sql bên ngoài'}</div>
      ${backupSummary ? `<div class="subtle">Dự kiến trong bản sao lưu: ${esc(backupSummary)}</div>` : ''}
    </div>
    <label for="restoreTargetDb" style="display:block; margin: 12px 0 4px; font-weight: 600;">Database đích:</label>
    <select id="restoreTargetDb" style="width: 100%;">
      ${dbOptions}
      <option value="__NEW__" ${defaultNew ? 'selected' : ''}>＋ Tạo database mới…</option>
    </select>
    <div id="restoreNewDbBox" style="display:none; margin-top: 8px;">
      <input id="restoreNewDbName" value="${defaultNew ? esc(suggestedName) : ''}" placeholder="Tên database mới (ví dụ: ${esc(suggestedName)})" style="width: 100%;">
    </div>
    <div id="restoreExistingWarning" class="errorbox" style="display:none;" role="alert">
      <strong>Database đích đã tồn tại.</strong> Ghi vào database hiện có có thể thay đổi dữ liệu đang dùng. Nhập đúng tên database bên dưới để xác nhận.
      <input id="restoreConfirmName" autocomplete="off" style="width: 100%; margin-top: 8px;" aria-label="Nhập tên database đích để xác nhận">
    </div>
    <div style="margin-top: 12px; display: flex; flex-direction: column; gap: 6px;">
      <label class="checkline"><input type="checkbox" id="restoreDrop"> Xóa bảng/view/trigger/routine/event trùng tên trước khi tạo lại</label>
      <label class="checkline" id="restoreCopyCatalogLine" style="display:none;">
        <input type="checkbox" id="restoreCopyCatalog" checked> Lưu bản sao lưu này vào danh mục của Database đích
      </label>
    </div>
    <div class="hint"><strong>Không có rollback toàn bộ:</strong> MySQL/MariaDB không bảo đảm hoàn tác DDL nếu lỗi giữa chừng. Nếu phục hồi thất bại hoặc bị hủy sau khi đã ghi, SqlPro sẽ báo phần đã chạy và không tự retry, tự xóa hay tự rollback database đích.</div>
    <div class="hint">Tệp .sql được chạy tuần tự vào database đích. Trước khi ghi, SqlPro kiểm tra toàn bộ tệp: câu lệnh ghi ra ngoài database đích, CALL/PREPARE/EXECUTE và câu lệnh không phân tích được sẽ bị chặn. Các lệnh USE và CREATE/DROP DATABASE trong tệp sẽ bị bỏ qua; khóa ngoại tạm thời tắt trong lúc phục hồi nhưng được kiểm tra lại sau đó. Trigger/routine trong tệp vẫn có thể ghi gián tiếp hoặc dùng SQL động ngoài phần đã phân tích, nên hãy dùng tài khoản chỉ có quyền trên database đích.</div>
    <div class="hint"><strong>Chỉ phục hồi tệp bạn tin cậy</strong> — nội dung tệp có thể thay đổi dữ liệu.</div>
    ${isReadOnly ? '<div class="errorbox" style="margin-top: 10px;"><strong>🔒 Kết nối đang ở chế độ chỉ đọc.</strong> Thao tác phục hồi database bị khóa để bảo vệ dữ liệu.</div>' : ''}
    <div class="actions">
      <button data-click="close-modal">Hủy</button>
      <button class="primary" id="restoreGo" ${isReadOnly ? 'disabled title="Kết nối đang ở chế độ chỉ đọc"' : ''}>${backupId ? 'Phục hồi bản này' : 'Chọn tệp .sql…'}</button>
    </div>
  `);

  const targetSelect = $('#restoreTargetDb');
  const newDbBox = $('#restoreNewDbBox');
  const copyCatalogLine = $('#restoreCopyCatalogLine');
  const existingWarning = $('#restoreExistingWarning');
  const confirmNameInput = $('#restoreConfirmName');
  const restoreGoBtn = $('#restoreGo');

  const updateTargetUi = () => {
    const isNew = targetSelect.value === '__NEW__';
    newDbBox.style.display = isNew ? 'block' : 'none';
    const isDifferent = isNew || targetSelect.value !== sourceDb;
    copyCatalogLine.style.display = (isDifferent && backupId) ? 'flex' : 'none';
    const existing = !isNew && (app.databases || []).includes(targetSelect.value);
    existingWarning.style.display = existing ? 'block' : 'none';
    if (isReadOnly) {
      restoreGoBtn.disabled = true;
      restoreGoBtn.title = 'Kết nối đang ở chế độ chỉ đọc';
    } else if (existing) {
      confirmNameInput.placeholder = `Nhập "${targetSelect.value}"`;
      restoreGoBtn.disabled = confirmNameInput.value.trim() !== targetSelect.value;
    } else {
      restoreGoBtn.disabled = false;
    }
    if (isDifferent) {
      restoreGoBtn.textContent = isNew ? 'Tạo mới & Phục hồi' : `Phục hồi sang ${targetSelect.value}`;
    } else {
      restoreGoBtn.textContent = backupId ? 'Phục hồi bản này' : 'Chọn tệp .sql…';
    }
  };
  targetSelect.addEventListener('change', updateTargetUi);
  confirmNameInput.addEventListener('input', updateTargetUi);
  updateTargetUi();

  $('#restoreGo').addEventListener('click', async () => {
    if (connectionIsReadOnly(sourceProfileId)) {
      toast('Kết nối đang ở chế độ chỉ đọc. Không thể phục hồi CSDL.', 'error');
      return;
    }
    const isNew = targetSelect.value === '__NEW__';
    const targetDb = isNew ? ($('#restoreNewDbName').value || '').trim() : targetSelect.value;
    if (!targetDb) {
      toast('Hãy chọn hoặc nhập tên database đích.', 'error');
      return;
    }
    if (!isNew && (app.databases || []).includes(targetDb) && $('#restoreConfirmName').value.trim() !== targetDb) {
      toast(`Nhập đúng tên database "${targetDb}" để xác nhận ghi đè.`, 'error');
      return;
    }
    const dropExisting = $('#restoreDrop').checked;
    const shouldCopyCatalog = Boolean(backupId && targetDb !== sourceDb && $('#restoreCopyCatalog')?.checked);

    const confirmed = await confirmAction(
      `Phục hồi vào "${targetDb}"?`,
      `Tệp SQL từ "${sourceDb}" sẽ được chạy vào "${targetDb}"${dropExisting ? ', xóa các bảng/view/trigger/routine/event trùng tên trước khi tạo lại' : ''}. Thao tác này có thể thay đổi dữ liệu hiện có.`,
      'Tiếp tục'
    );
    if (!confirmed) return;
    const taskId = newTransferTaskId('restore');
    closeModal();
    showTransferProgress('restore', targetDb, { taskId, profileId: sourceProfileId });
    setStatus(`Đang phục hồi vào ${targetDb}…`);
    try {
      const result = await call(desktop.db.restore({
        profileId: sourceProfileId,
        taskId,
        sourceDatabase: sourceDb,
        database: targetDb,
        backupId,
        dropExisting,
        createDatabaseIfNotExists: isNew || !app.databases.includes(targetDb),
        copyToTargetCatalog: shouldCopyCatalog
      }));
      if (result.canceled) {
        setStatus('Đã hủy phục hồi');
        finishBackgroundTransfer('canceled', 'Đã hủy phục hồi', `
          ${restoreImpactHtml(result) || `<p>Đã chạy ${Number(result.executed || 0).toLocaleString()} câu lệnh trước khi hủy. Các thay đổi đã áp dụng <strong>không được tự động hoàn tác</strong>.</p>`}
        `, taskId);
        return;
      }
      const verification = result.verification;
      const verificationFailed = verification?.status === 'failed';
      const verificationUnverified = verification?.status === 'unverified';
      toast(
        `Đã phục hồi ${result.statements} câu lệnh${result.skipped ? `, bỏ qua ${result.skipped}` : ''}${verificationFailed ? ' · cần kiểm tra dữ liệu' : verificationUnverified ? ' · chưa kiểm chứng đầy đủ' : ' · đã kiểm chứng'}`,
        verificationFailed ? 'error' : 'info'
      );
      setStatus(`Phục hồi hoàn tất • ${result.statements} câu lệnh${verificationFailed ? ' • có cảnh báo' : ''}`);
      if (app.connection?.id === sourceProfileId) {
        await refreshDatabases();
        if (app.database === targetDb) {
          app.tables = await call(desktop.db.tables(targetDb, sourceProfileId));
          renderSidebar();
          if (mode === 'data' && table && app.tables.some((entry) => entry.name === table)) await loadData();
          if (mode === 'backups') await refreshBackupList(targetDb, sourceProfileId);
        }
      }
      persistState();
      finishBackgroundTransfer(verificationFailed ? 'error' : 'success', verificationFailed ? 'Phục hồi đã chạy nhưng cần kiểm tra' : verificationUnverified ? 'Phục hồi hoàn tất (chưa kiểm chứng đầy đủ)' : 'Phục hồi hoàn tất', `
        <p>Đã chạy ${result.statements} câu lệnh${result.skipped ? `, bỏ qua ${result.skipped}` : ''} vào <strong>${esc(targetDb)}</strong>.</p>
        ${restorePreflightHtml(result.preflight)}
        ${restoreVerificationHtml(verification)}
        ${result.copiedBackup ? `<p class="subtle">Đã lưu bản sao lưu vào danh mục của <strong>${esc(targetDb)}</strong>.</p>` : ''}
      `, taskId);
    } catch (error) {
      const partial = error.partial;
      finishBackgroundTransfer('error', 'Phục hồi thất bại', `
        <div class="errorbox">${esc(error.message)}</div>
        ${restorePreflightHtml(error.preflight)}
        ${restoreImpactHtml(error.impact || partial) || '<div class="hint">Một số câu lệnh trước lỗi có thể đã được áp dụng. Kiểm tra database trước khi chạy lại tệp.</div>'}
      `, taskId);
      setStatus('Phục hồi thất bại');
      if (app.connection?.id === sourceProfileId) {
        try {
          app.tables = await call(desktop.db.tables(app.database, sourceProfileId));
          renderSidebar();
        } catch {
          // ignore refresh failure
        }
      }
    }
  });
}

function copySelectedBackupToClipboard(backupId = app.selectedBackupId, sourceDb = app.database, sourceConn = app.connection) {
  if (!backupId) {
    toast('Chưa chọn bản sao lưu nào để sao chép.', 'error');
    return;
  }
  const backup = (app.backups || []).find((b) => b.id === backupId);
  const connObj = sourceConn || app.connection;
  const connName = connObj?.name || connObj?.host || 'Kết nối hiện tại';
  const connId = connObj?.id || null;
  const dbName = sourceDb || app.database;

  app.copiedBackup = {
    id: backupId,
    name: backup?.name || backupId.slice(0, 14),
    bytes: backup?.bytes || 0,
    createdAt: backup?.createdAt || new Date().toISOString(),
    sourceConnectionId: connId,
    sourceConnectionName: connName,
    sourceDatabase: dbName
  };

  renderSidebar();
  if (mode === 'backups') renderBackupsView();
  toast(`Đã sao chép bản sao lưu "${app.copiedBackup.name}" (Ctrl+C). Chọn Database khác rồi nhấn Ctrl+V để dán.`);
}

async function pasteBackupModal(targetDb = null, targetConnectionId = null) {
  if (!desktop) return;
  const copied = app.copiedBackup;
  if (!copied) {
    toast('Chưa có bản sao lưu nào được sao chép. Hãy chọn 1 bản sao lưu và nhấn Ctrl+C trước.', 'error');
    return;
  }

  const allConnections = (app.connections && app.connections.length) ? app.connections : (app.connection ? [app.connection] : []);
  let selectedConnId = targetConnectionId || app.connection?.id || (allConnections[0] ? allConnections[0].id : null);
  let selectedDb = targetDb || '';

  let targetDatabases = [];
  try {
    if (selectedConnId === app.connection?.id && app.databases && app.databases.length) {
      targetDatabases = app.databases;
    } else if (selectedConnId) {
      targetDatabases = await call(desktop.db.databases(selectedConnId));
    }
  } catch {
    targetDatabases = app.databases || [];
  }

  const renderDbOptions = (dbs, currDb) => {
    const list = dbs.map((d) => `<option value="${esc(d)}" ${d === currDb ? 'selected' : ''}>${esc(d)}${d === copied.sourceDatabase && selectedConnId === copied.sourceConnectionId ? ' (Nguồn)' : ''}</option>`);
    return [
      `<option value="" ${!currDb ? 'selected' : ''} disabled>-- Chọn Database đích --</option>`,
      ...list,
      `<option value="__NEW__" ${!currDb ? 'selected' : ''}>＋ Tạo database mới…</option>`
    ].join('');
  };

  const connOptions = allConnections.map((c) => `
    <option value="${esc(c.id)}" ${c.id === selectedConnId ? 'selected' : ''}>
      ${esc(c.name || c.host || 'Kết nối')} (${esc(c.host || 'localhost')}${c.port ? `:${c.port}` : ''})
    </option>
  `).join('');

  modal(`
    <h2>Dán bản sao lưu (Ctrl+V)</h2>
    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 14px; margin: 10px 0; font-size: 11.5px; line-height: 1.6;">
      <div>Nguồn: <strong>${esc(copied.sourceConnectionName)}</strong> › <strong>${esc(copied.sourceDatabase)}</strong></div>
      <div>Bản sao lưu: <code style="font-family: monospace; color: #087f72; font-weight: 600;">🕒 ${esc(copied.name)}</code> (${formatBytes(copied.bytes)})</div>
    </div>

    ${allConnections.length > 1 ? `
    <label for="pasteTargetConnection" style="display:block; margin: 12px 0 4px; font-weight: 600;">Kết nối đích (Server / Connection):</label>
    <select id="pasteTargetConnection" style="width: 100%;">
      ${connOptions}
    </select>
    ` : ''}

    <label for="pasteTargetDb" style="display:block; margin: 12px 0 4px; font-weight: 600;">Database đích:</label>
    <select id="pasteTargetDb" style="width: 100%;">
      ${renderDbOptions(targetDatabases, selectedDb)}
    </select>
    <div id="pasteNewDbBox" style="display:${selectedDb ? 'none' : 'block'}; margin-top: 8px;">
      <input id="pasteNewDbName" value="${selectedDb ? '' : esc(`${copied.sourceDatabase}_copy`)}" placeholder="Tên database mới (ví dụ: ${esc(copied.sourceDatabase)}_copy)" style="width: 100%;">
    </div>

    <div style="margin-top: 14px; display: flex; flex-direction: column; gap: 8px;">
      <label class="checkline">
        <input type="checkbox" id="pasteActionRestore" checked>
        <span><strong>Khôi phục cấu trúc và dữ liệu vào Database đích</strong></span>
      </label>
      <label class="checkline" style="margin-left: 22px;">
        <input type="checkbox" id="pasteActionDrop">
        <span>Xóa bảng/view/trigger/routine/event trùng tên nếu đã tồn tại ở DB đích</span>
      </label>
      <label class="checkline">
        <input type="checkbox" id="pasteActionCatalog" checked>
        <span><strong>Lưu bản sao lưu vào danh mục của Database đích</strong> (Hiển thị trong Backups của DB đích)</span>
      </label>
    </div>

    <div class="hint" style="margin-top: 12px;">Dữ liệu sẽ được sao chép trực tiếp từ bản backup của <strong>${esc(copied.sourceConnectionName)}</strong> sang máy chủ và database đích đã chọn.</div>
    <div class="hint"><strong>Không có rollback toàn bộ:</strong> MySQL/MariaDB không bảo đảm hoàn tác DDL nếu lỗi giữa chừng. Nếu lỗi hoặc bị hủy sau khi đã ghi, SqlPro báo phần đã chạy và không tự retry, tự xóa hay tự rollback database đích.</div>

    <div class="actions">
      <button data-click="close-modal">Hủy</button>
      <button class="primary" id="pasteGoBtn">Dán ngay</button>
    </div>
  `);

  const connSelect = $('#pasteTargetConnection');
  const dbSelect = $('#pasteTargetDb');
  const newDbBox = $('#pasteNewDbBox');
  const actionRestore = $('#pasteActionRestore');
  const actionDrop = $('#pasteActionDrop');

  if (connSelect) {
    connSelect.addEventListener('change', async () => {
      selectedConnId = connSelect.value;
      dbSelect.disabled = true;
      dbSelect.innerHTML = '<option>Đang tải danh sách database…</option>';
      try {
        if (selectedConnId === app.connection?.id && app.databases && app.databases.length) {
          targetDatabases = app.databases;
        } else {
          targetDatabases = await call(desktop.db.databases(selectedConnId));
        }
      } catch (err) {
        targetDatabases = [];
        toast(`Không đọc được database của kết nối: ${err.message}`, 'error');
      }
      dbSelect.disabled = false;
      dbSelect.innerHTML = renderDbOptions(targetDatabases, '');
      newDbBox.style.display = 'block';
      const newDbName = $('#pasteNewDbName');
      if (newDbName) newDbName.value = `${copied.sourceDatabase}_copy`;
    });
  }

  dbSelect.addEventListener('change', () => {
    newDbBox.style.display = dbSelect.value === '__NEW__' ? 'block' : 'none';
  });

  actionRestore.addEventListener('change', () => {
    actionDrop.disabled = !actionRestore.checked;
    if (!actionRestore.checked) actionDrop.checked = false;
  });

  $('#pasteGoBtn').addEventListener('click', async () => {
    const targetConnId = connSelect ? connSelect.value : selectedConnId;
    const targetConnObj = allConnections.find((c) => c.id === targetConnId);
    const isNew = dbSelect.value === '__NEW__';
    const finalTargetDb = isNew ? ($('#pasteNewDbName').value || '').trim() : dbSelect.value;
    if (!finalTargetDb) {
      toast('Hãy chọn hoặc nhập tên Database đích.', 'error');
      return;
    }
    const doRestore = actionRestore.checked;
    const doCatalog = $('#pasteActionCatalog').checked;
    const dropExisting = actionDrop.checked;

    if (doRestore && targetConnObj?.readOnly) {
      toast('Kết nối đích đang ở chế độ chỉ đọc. Không thể phục hồi CSDL.', 'error');
      return;
    }

    if (!doRestore && !doCatalog) {
      toast('Hãy chọn ít nhất một thao tác (Khôi phục dữ liệu hoặc Lưu vào danh mục).', 'error');
      return;
    }

    const targetConnName = targetConnObj ? (targetConnObj.name || targetConnObj.host) : 'Kết nối đích';

    const confirmed = await confirmAction(
      `Dán bản sao lưu vào "${finalTargetDb}"?`,
      `Dữ liệu từ bản sao lưu "${copied.name}" (${copied.sourceConnectionName} › ${copied.sourceDatabase}) sẽ được chuyển sang ${targetConnName} › "${finalTargetDb}".`,
      'Tiếp tục dán'
    );
    if (!confirmed) return;

    closeModal();
    const taskId = newTransferTaskId('restore');
    if (doRestore) {
      showTransferProgress('restore', finalTargetDb, { taskId, profileId: targetConnId });
      setStatus(`Đang dán và phục hồi vào ${finalTargetDb}…`);
    } else {
      setStatus(`Đang dán tệp sao lưu vào ${finalTargetDb}…`);
    }

    try {
      let restoreResult = null;
      let catalogCopy = null;

      if (doRestore) {
        restoreResult = await call(desktop.db.restore({
          profileId: targetConnId,
          taskId,
          sourceProfileId: copied.sourceConnectionId,
          targetProfileId: targetConnId,
          sourceDatabase: copied.sourceDatabase,
          database: finalTargetDb,
          backupId: copied.id,
          dropExisting,
          createDatabaseIfNotExists: true,
          copyToTargetCatalog: doCatalog
        }));
        if (restoreResult.canceled) {
          setStatus('Đã hủy dán bản sao lưu');
          finishBackgroundTransfer('canceled', 'Đã hủy dán bản sao lưu', `
            ${restoreImpactHtml(restoreResult) || `<p>Đã chạy ${Number(restoreResult.executed || 0).toLocaleString()} câu lệnh trước khi hủy. Các thay đổi đã áp dụng <strong>không được tự động hoàn tác</strong>.</p>`}
          `, taskId);
          return;
        }
      } else if (doCatalog) {
        catalogCopy = await call(desktop.db.copyBackup({
          profileId: targetConnId,
          sourceProfileId: copied.sourceConnectionId,
          targetProfileId: targetConnId,
          sourceDatabase: copied.sourceDatabase,
          targetDatabase: finalTargetDb,
          id: copied.id
        }));
      }

      if (!doRestore) closeModal();
      const pastedFailed = restoreResult?.verification?.status === 'failed';
      const pastedTitle = pastedFailed ? 'Dán bản sao lưu đã chạy nhưng cần kiểm tra' : 'Dán bản sao lưu thành công';
      toast(`Đã dán bản sao lưu sang "${finalTargetDb}"${pastedFailed ? ' nhưng cần kiểm tra dữ liệu' : ' thành công!'}`, pastedFailed ? 'error' : 'info');
      setStatus(`Dán hoàn tất sang ${finalTargetDb}${pastedFailed ? ' • có cảnh báo' : ''}`);

      if (targetConnId === app.connection?.id) {
        await refreshDatabases();
        if (app.database === finalTargetDb) await refreshBackupList(finalTargetDb);
      }

      const outcomeHtml = `
        <p>Đã dán bản sao lưu từ <strong>${esc(copied.sourceConnectionName)} › ${esc(copied.sourceDatabase)}</strong> sang <strong>${esc(targetConnName)} › ${esc(finalTargetDb)}</strong>.</p>
        ${restoreResult ? `<p>Đã chạy ${restoreResult.statements} câu lệnh${restoreResult.skipped ? `, bỏ qua ${restoreResult.skipped}` : ''}.</p>` : ''}
        ${restorePreflightHtml(restoreResult?.preflight)}
        ${restoreVerificationHtml(restoreResult?.verification)}
        ${backupIntegrityHtml(catalogCopy || restoreResult?.copiedBackup)}
        ${(doCatalog || restoreResult?.copiedBackup) ? `<p class="subtle">Bản sao lưu đã được lưu vào danh mục của <strong>${esc(finalTargetDb)}</strong>.</p>` : ''}
        <div class="actions">
          <button class="primary" data-transfer-open-db="${esc(finalTargetDb)}" data-transfer-profile="${esc(targetConnId)}">Mở Database "${esc(finalTargetDb)}"</button>
        </div>
      `;
      if (doRestore) finishBackgroundTransfer(pastedFailed ? 'error' : 'success', pastedTitle, outcomeHtml, taskId);
      else modal(`<h2>${pastedTitle}</h2>${outcomeHtml}<div class="actions"><button data-click="close-modal">Đóng</button></div>`);

      $('#modal [data-transfer-open-db]')?.addEventListener('click', async () => {
        closeModal();
        if (targetConnId !== app.connection?.id) {
          await connectTo(targetConnId);
        }
        await selectDatabase(finalTargetDb);
      });
    } catch (error) {
      const partial = error.partial;
      const errorHtml = `
        <div class="errorbox">${esc(error.message)}</div>
        ${restorePreflightHtml(error.preflight)}
        ${restoreImpactHtml(error.impact || partial) || '<div class="hint">Một số câu lệnh trước lỗi có thể đã được áp dụng. Hãy kiểm tra database đích trước khi chạy lại.</div>'}
      `;
      if (doRestore) finishBackgroundTransfer('error', 'Dán bản sao lưu thất bại', errorHtml, taskId);
      else { closeModal(); modal(`<h2>Dán bản sao lưu thất bại</h2>${errorHtml}<div class="actions"><button data-click="close-modal">Đóng</button></div>`); }
      setStatus('Dán bản sao lưu thất bại');
    }
  });
}

function copyBackupToDatabaseModal(backupId, sourceDb = app.database, sourceConn = app.connection) {
  if (!desktop) return;
  if (!sourceDb) {
    toast('Chưa chọn database nguồn.', 'error');
    return;
  }
  const backup = (app.backups || []).find((b) => b.id === backupId);
  const backupLabel = backup ? `${backup.name} (${formatBytes(backup.bytes)})` : (backupId ? backupId.slice(0, 14) : 'Bản sao lưu');
  const allConnections = (app.connections && app.connections.length) ? app.connections : (app.connection ? [app.connection] : []);
  let selectedConnId = sourceConn?.id || app.connection?.id || (allConnections[0] ? allConnections[0].id : null);
  const sourceConnName = sourceConn?.name || sourceConn?.host || 'Kết nối nguồn';

  let targetDatabases = (selectedConnId === app.connection?.id && app.databases) ? app.databases : [];

  const renderDbOptions = (dbs, currDb) => {
    const list = dbs.map((d) => `<option value="${esc(d)}" ${d === currDb ? 'selected' : ''}>${esc(d)}${d === sourceDb && selectedConnId === sourceConn?.id ? ' (Nguồn)' : ''}</option>`);
    return [
      `<option value="" ${!currDb ? 'selected' : ''} disabled>-- Chọn Database đích --</option>`,
      ...list,
      `<option value="__NEW__" ${!currDb ? 'selected' : ''}>＋ Tạo database mới…</option>`
    ].join('');
  };

  const connOptions = allConnections.map((c) => `
    <option value="${esc(c.id)}" ${c.id === selectedConnId ? 'selected' : ''}>
      ${esc(c.name || c.host || 'Kết nối')} (${esc(c.host || 'localhost')}${c.port ? `:${c.port}` : ''})
    </option>
  `).join('');

  modal(`
    <h2>Sao chép sang Database khác</h2>
    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 14px; margin: 10px 0; font-size: 11.5px; line-height: 1.6;">
      <div>Nguồn: <strong>${esc(sourceConnName)}</strong> › <strong>${esc(sourceDb)}</strong></div>
      <div>Bản sao lưu: <code style="font-family: monospace; color: #087f72; font-weight: 600;">🕒 ${esc(backupLabel)}</code></div>
    </div>

    ${allConnections.length > 1 ? `
    <label for="copyTargetConnection" style="display:block; margin: 12px 0 4px; font-weight: 600;">Kết nối đích (Server / Connection):</label>
    <select id="copyTargetConnection" style="width: 100%;">
      ${connOptions}
    </select>
    ` : ''}

    <label for="copyTargetDb" style="display:block; margin: 12px 0 4px; font-weight: 600;">Database đích:</label>
    <select id="copyTargetDb" style="width: 100%;">
      ${renderDbOptions(targetDatabases, '')}
    </select>
    <div id="copyNewDbBox" style="display:block; margin-top: 8px;">
      <input id="copyNewDbName" value="${esc(`${sourceDb}_copy`)}" placeholder="Tên database mới (ví dụ: ${esc(sourceDb)}_copy)" style="width: 100%;">
    </div>

    <div style="margin-top: 14px; display: flex; flex-direction: column; gap: 8px;">
      <label class="checkline">
        <input type="checkbox" id="copyActionRestore" checked>
        <span><strong>Khôi phục cấu trúc và dữ liệu vào Database đích</strong></span>
      </label>
      <label class="checkline" style="margin-left: 22px;">
        <input type="checkbox" id="copyActionDrop">
        <span>Xóa bảng/view/trigger/routine/event trùng tên nếu đã tồn tại ở DB đích</span>
      </label>
      <label class="checkline">
        <input type="checkbox" id="copyActionCatalog" checked>
        <span><strong>Lưu bản sao lưu vào danh mục của Database đích</strong> (Hiển thị trong Backups của DB đích)</span>
      </label>
    </div>

    <div class="hint" style="margin-top: 12px;">Hệ thống sẽ sao chép toàn bộ bảng và dữ liệu từ bản backup này sang máy chủ và Database đích được chỉ định.</div>
    <div class="hint"><strong>Không có rollback toàn bộ:</strong> MySQL/MariaDB không bảo đảm hoàn tác DDL nếu lỗi giữa chừng. Nếu lỗi hoặc bị hủy sau khi đã ghi, SqlPro báo phần đã chạy và không tự retry, tự xóa hay tự rollback database đích.</div>

    <div class="actions">
      <button data-click="close-modal">Hủy</button>
      <button class="primary" id="copyGoBtn">Bắt đầu sao chép</button>
    </div>
  `);

  const connSelect = $('#copyTargetConnection');
  const copyTargetSelect = $('#copyTargetDb');
  const copyNewDbBox = $('#copyNewDbBox');
  const copyActionRestore = $('#copyActionRestore');
  const copyActionDrop = $('#copyActionDrop');

  if (connSelect) {
    connSelect.addEventListener('change', async () => {
      selectedConnId = connSelect.value;
      copyTargetSelect.disabled = true;
      copyTargetSelect.innerHTML = '<option>Đang tải danh sách database…</option>';
      try {
        if (selectedConnId === app.connection?.id && app.databases && app.databases.length) {
          targetDatabases = app.databases;
        } else {
          targetDatabases = await call(desktop.db.databases(selectedConnId));
        }
      } catch (err) {
        targetDatabases = [];
        toast(`Không đọc được database của kết nối: ${err.message}`, 'error');
      }
      copyTargetSelect.disabled = false;
      copyTargetSelect.innerHTML = renderDbOptions(targetDatabases, '');
      copyNewDbBox.style.display = 'block';
      const copyNewDbName = $('#copyNewDbName');
      if (copyNewDbName) copyNewDbName.value = `${sourceDb}_copy`;
    });
  }

  copyTargetSelect.addEventListener('change', () => {
    copyNewDbBox.style.display = copyTargetSelect.value === '__NEW__' ? 'block' : 'none';
  });

  copyActionRestore.addEventListener('change', () => {
    copyActionDrop.disabled = !copyActionRestore.checked;
    if (!copyActionRestore.checked) copyActionDrop.checked = false;
  });

  $('#copyGoBtn').addEventListener('click', async () => {
    const targetConnId = connSelect ? connSelect.value : selectedConnId;
    const targetConnObj = allConnections.find((c) => c.id === targetConnId);
    const isNew = copyTargetSelect.value === '__NEW__';
    const targetDb = isNew ? ($('#copyNewDbName').value || '').trim() : copyTargetSelect.value;
    if (!targetDb) {
      toast('Hãy chọn hoặc nhập tên Database đích.', 'error');
      return;
    }
    if (targetDb === sourceDb && targetConnId === sourceConn?.id) {
      toast('Database đích phải khác Database nguồn.', 'error');
      return;
    }
    const doRestore = copyActionRestore.checked;
    const doCatalog = $('#copyActionCatalog').checked;
    const dropExisting = copyActionDrop.checked;

    if (doRestore && targetConnObj?.readOnly) {
      toast('Kết nối đích đang ở chế độ chỉ đọc. Không thể phục hồi CSDL.', 'error');
      return;
    }

    if (!doRestore && !doCatalog) {
      toast('Hãy chọn ít nhất một thao tác (Khôi phục dữ liệu hoặc Lưu vào danh mục).', 'error');
      return;
    }

    const targetConnName = targetConnObj ? (targetConnObj.name || targetConnObj.host) : 'Kết nối đích';

    const confirmed = await confirmAction(
      `Sao chép sang "${targetDb}"?`,
      `Thao tác sẽ thực hiện sao chép từ bản sao lưu "${sourceDb}" sang ${targetConnName} › database "${targetDb}".`,
      'Tiếp tục'
    );
    if (!confirmed) return;

    closeModal();
    const taskId = newTransferTaskId('restore');
    if (doRestore) {
      showTransferProgress('restore', targetDb, { taskId, profileId: targetConnId });
      setStatus(`Đang sao chép sang ${targetDb}…`);
    } else {
      setStatus(`Đang lưu bản backup sang ${targetDb}…`);
    }

    try {
      let restoreResult = null;
      let catalogCopy = null;

      if (doRestore) {
        restoreResult = await call(desktop.db.restore({
          profileId: targetConnId,
          taskId,
          sourceProfileId: sourceConn?.id,
          targetProfileId: targetConnId,
          sourceDatabase: sourceDb,
          database: targetDb,
          backupId,
          dropExisting,
          createDatabaseIfNotExists: true,
          copyToTargetCatalog: doCatalog
        }));
        if (restoreResult.canceled) {
          setStatus('Đã hủy sao chép');
          finishBackgroundTransfer('canceled', 'Đã hủy sao chép', `
            ${restoreImpactHtml(restoreResult) || `<p>Đã chạy ${Number(restoreResult.executed || 0).toLocaleString()} câu lệnh trước khi hủy. Các thay đổi đã áp dụng <strong>không được tự động hoàn tác</strong>.</p>`}
          `, taskId);
          return;
        }
      } else if (doCatalog) {
        catalogCopy = await call(desktop.db.copyBackup({
          profileId: targetConnId,
          sourceProfileId: sourceConn?.id,
          targetProfileId: targetConnId,
          sourceDatabase: sourceDb,
          targetDatabase: targetDb,
          id: backupId
        }));
      }

      if (!doRestore) closeModal();
      const copiedFailed = restoreResult?.verification?.status === 'failed';
      const copiedTitle = copiedFailed ? 'Sao chép đã chạy nhưng cần kiểm tra' : 'Sao chép hoàn tất';
      toast(`Đã sao chép sang database "${targetDb}"${copiedFailed ? ' nhưng cần kiểm tra dữ liệu' : ' thành công!'}`, copiedFailed ? 'error' : 'info');
      setStatus(`Sao chép hoàn tất sang ${targetDb}${copiedFailed ? ' • có cảnh báo' : ''}`);
      if (targetConnId === app.connection?.id) {
        await refreshDatabases();
      }

      const outcomeHtml = `
        <p>Đã sao chép bản sao lưu từ <strong>${esc(sourceConnName)} › ${esc(sourceDb)}</strong> sang <strong>${esc(targetConnName)} › ${esc(targetDb)}</strong>.</p>
        ${restoreResult ? `<p>Đã chạy ${restoreResult.statements} câu lệnh${restoreResult.skipped ? `, bỏ qua ${restoreResult.skipped}` : ''}.</p>` : ''}
        ${restorePreflightHtml(restoreResult?.preflight)}
        ${restoreVerificationHtml(restoreResult?.verification)}
        ${backupIntegrityHtml(catalogCopy || restoreResult?.copiedBackup)}
        ${(doCatalog || restoreResult?.copiedBackup) ? `<p class="subtle">Bản sao lưu đã được lưu vào danh mục của <strong>${esc(targetDb)}</strong>.</p>` : ''}
        <div class="actions">
          <button class="primary" data-transfer-open-db="${esc(targetDb)}" data-transfer-profile="${esc(targetConnId)}">Mở Database "${esc(targetDb)}"</button>
        </div>
      `;
      if (doRestore) finishBackgroundTransfer(copiedFailed ? 'error' : 'success', copiedTitle, outcomeHtml, taskId);
      else modal(`<h2>${copiedTitle}</h2>${outcomeHtml}<div class="actions"><button data-click="close-modal">Đóng</button></div>`);

      $('#modal [data-transfer-open-db]')?.addEventListener('click', async () => {
        closeModal();
        if (targetConnId !== app.connection?.id) {
          await connectTo(targetConnId);
        }
        await selectDatabase(targetDb);
      });
    } catch (error) {
      const partial = error.partial;
      const errorHtml = `
        <div class="errorbox">${esc(error.message)}</div>
        ${restorePreflightHtml(error.preflight)}
        ${restoreImpactHtml(error.impact || partial) || '<div class="hint">Một số câu lệnh trước lỗi có thể đã được áp dụng. Hãy kiểm tra database đích trước khi chạy lại.</div>'}
      `;
      if (doRestore) finishBackgroundTransfer('error', 'Sao chép thất bại', errorHtml, taskId);
      else { closeModal(); modal(`<h2>Sao chép thất bại</h2>${errorHtml}<div class="actions"><button data-click="close-modal">Đóng</button></div>`); }
      setStatus('Sao chép thất bại');
    }
  });
}

async function copyDatabaseAction(dbName, dbConnId = app.connection?.id) {
  if (!app.connection) return;
  if (dbConnId && dbConnId !== app.connection.id) {
    await connectTo(dbConnId);
  }
  await selectDatabase(dbName);
  await refreshBackupList(dbName);
  if (app.backups && app.backups.length > 0) {
    copyBackupToDatabaseModal(app.selectedBackupId || app.backups[0].id, dbName);
  } else {
    const wantBackup = await confirmAction(
      `Sao chép Database "${dbName}"`,
      `Database "${dbName}" chưa có bản sao lưu nào. Bạn có muốn tạo một bản sao lưu ngay để sao chép sang database khác không?`,
      'Tạo bản sao lưu ngay'
    );
    if (!wantBackup) return;
    backupDatabase();
  }
}

function previewImportCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function transferPartialText(partial) {
  if (!partial) return '';
  const parts = [];
  if (partial.rows !== undefined) parts.push(`${Number(partial.rows || 0).toLocaleString()} dòng đã đọc`);
  if (partial.committed !== undefined) parts.push(`${Number(partial.committed || 0).toLocaleString()} dòng đã ghi`);
  else if (partial.written !== undefined) parts.push(`${Number(partial.written || 0).toLocaleString()} dòng đã xử lý`);
  if (partial.bytes !== undefined) parts.push(formatBytes(partial.bytes));
  return parts.length ? ` Đã xử lý: ${parts.join(' · ')}.` : '';
}

async function previewImportDialog(file, database, targetTable, options = {}) {
  const format = options.format || (['csv', 'tsv', 'json'].includes(file.format) ? file.format : 'csv');
  const delimiter = options.delimiter !== undefined
    ? options.delimiter
    : (format === 'tsv' ? '\t' : ',');
  const hasHeader = options.hasHeader !== undefined ? options.hasHeader : format !== 'json';
  const preview = await call(desktop.db.previewImport({
    filePath: file.filePath,
    format,
    delimiter,
    hasHeader,
    limit: 20
  }));
  const targetCols = app.columns.filter((column) => !/(virtual|stored) generated/i.test(column.extra));
  if (!targetCols.length) {
    toast('Bảng đích không có cột nào có thể nhập.', 'error');
    return;
  }
  const headers = Array.isArray(preview.headers) ? preview.headers : [];
  const sourceLabel = (header, index) => (format !== 'json' && preview.hasHeader === false ? `Cột ${index + 1}` : String(header));
  const headerIndex = new Map(headers.map((header, index) => [String(header).trim().toLowerCase(), index]));
  const mappingHtml = targetCols.map((column, columnIndex) => {
    let matched = headerIndex.has(column.name.toLowerCase()) ? headerIndex.get(column.name.toLowerCase()) : -1;
    if (matched === -1 && format !== 'json' && preview.hasHeader === false && columnIndex < headers.length) matched = columnIndex;
    const opts = [
      '<option value="-1">-- Bỏ qua cột này --</option>',
      ...headers.map((header, index) => `<option value="${index}" data-source="${esc(header)}" ${index === matched ? 'selected' : ''}>${esc(sourceLabel(header, index))}</option>`)
    ].join('');
    return `
      <div class="csv-mapping-row">
        <span><strong>${esc(column.name)}</strong> <small class="muted">${esc(column.type)}${column.nullable === 'NO' ? ' · bắt buộc' : ''}</small></span>
        <span>→</span>
        <select data-db-col="${esc(column.name)}">${opts}</select>
      </div>
    `;
  }).join('');
  const previewHeader = `<tr>${headers.map((header, index) => `<th>${esc(sourceLabel(header, index))}</th>`).join('')}</tr>`;
  const previewBody = preview.rows.length
    ? preview.rows.map((row) => `<tr>${headers.map((_header, index) => `<td>${esc(previewImportCell(row[index]))}</td>`).join('')}</tr>`).join('')
    : '<tr><td colspan="1" class="muted">Không có dòng dữ liệu mẫu.</td></tr>';
  const delimiterOptions = [['\t', 'Tab'], [',', 'Dấu phẩy'], [';', 'Dấu chấm phẩy'], ['|', 'Dấu gạch đứng']]
    .map(([value, label]) => `<option value="${esc(value)}" ${value === delimiter ? 'selected' : ''}>${label}</option>`)
    .join('');
  const isStructured = format === 'json';
  modal(`
    <div class="dialog wide extra-wide">
      <h2>Nhập dữ liệu vào ${esc(database)}.${esc(targetTable)}</h2>
      <p><strong>${esc(file.name || file.filePath)}</strong> · ${formatBytes(file.size)} · ${esc(format.toUpperCase())}</p>
      <div class="formrow">
        <div>
          <label>Định dạng</label>
          <select id="importFormat">
            <option value="csv" ${format === 'csv' ? 'selected' : ''}>CSV</option>
            <option value="tsv" ${format === 'tsv' ? 'selected' : ''}>TSV</option>
            <option value="json" ${format === 'json' ? 'selected' : ''}>JSON</option>
          </select>
        </div>
        <div>
          <label>Dấu phân cách</label>
          <select id="importDelimiter" ${isStructured ? 'disabled' : ''}>${delimiterOptions}</select>
        </div>
        <div>
          <label>&nbsp;</label>
          <label class="check-row"><input type="checkbox" id="importHasHeader" ${hasHeader ? 'checked' : ''} ${isStructured ? 'disabled' : ''}> Dòng đầu là tiêu đề</label>
        </div>
        <div>
          <label>&nbsp;</label>
          <button type="button" id="importRefresh">Xem lại dữ liệu</button>
        </div>
      </div>
      <div class="hint">Xem trước ${preview.rows.length.toLocaleString()} dòng${preview.truncated ? ' đầu tiên' : ''} · Tệp ${formatBytes(preview.totalBytes)}. Chạy theo luồng, không giới hạn 5.000 dòng.</div>
      <label>Ánh xạ cột (Column Mapping)</label>
      <div class="csv-mapping-grid">${mappingHtml}</div>
      <label style="margin-top:14px">Xem trước dữ liệu</label>
      <div class="csv-preview-table"><table><thead>${previewHeader}</thead><tbody>${previewBody}</tbody></table></div>
      <div class="formrow" style="margin-top:14px">
        <div>
          <label>Khi trùng khóa</label>
          <select id="importMode">
            <option value="insert">Dừng và báo lỗi</option>
            <option value="skip">Bỏ qua bản ghi trùng</option>
            <option value="upsert">Cập nhật bản ghi trùng</option>
          </select>
        </div>
        <div>
          <label>Transaction</label>
          <select id="importTransaction">
            <option value="batch" selected>Mỗi lô một transaction (khuyến nghị)</option>
            <option value="all">Toàn bộ trong một transaction</option>
            <option value="none">Không dùng transaction</option>
          </select>
        </div>
      </div>
      <div class="hint">Không hỗ trợ tiếp tục sau khi hủy hoặc lỗi: chạy lại sẽ bắt đầu từ đầu tệp. “Toàn bộ” có thể giữ transaction lâu trên tệp lớn; “Không dùng transaction” có thể để lại dữ liệu đã ghi khi lỗi. Rollback chỉ được bảo đảm với bảng InnoDB; engine khác như MyISAM có thể giữ lại các dòng đã ghi.</div>
      <label class="check-row"><input type="checkbox" id="importAllowNonTransactional"> Tôi hiểu và cho phép nhập vào bảng dùng engine không hỗ trợ transaction (ví dụ MyISAM)</label>
      <div class="actions">
        <button data-click="close-modal">Hủy</button>
        <button class="primary" id="doFileImportBtn">Bắt đầu nhập</button>
      </div>
    </div>
  `, true);

  $('#importRefresh').addEventListener('click', async () => {
    const nextFormat = $('#importFormat').value;
    const nextDelimiter = nextFormat === 'tsv' ? '\t' : ($('#importDelimiter').value || ',');
    const nextHasHeader = nextFormat === 'json' ? true : $('#importHasHeader').checked;
    try {
      await previewImportDialog(file, database, targetTable, {
        format: nextFormat,
        delimiter: nextDelimiter,
        hasHeader: nextHasHeader
      });
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  $('#doFileImportBtn').addEventListener('click', async () => {
    const chosenFormat = $('#importFormat').value;
    const chosenDelimiter = chosenFormat === 'tsv' ? '\t' : ($('#importDelimiter').value || ',');
    const chosenHasHeader = chosenFormat === 'json' ? true : $('#importHasHeader').checked;
    const mapping = {};
    document.querySelectorAll('.csv-mapping-row select').forEach((select) => {
      const index = Number(select.value);
      if (!Number.isInteger(index) || index < 0) return;
      const source = select.selectedOptions[0]?.dataset.source;
      if (source !== undefined) mapping[select.dataset.dbCol] = source;
    });
    if (!Object.keys(mapping).length) {
      toast('Hãy chọn ít nhất một cột để nhập dữ liệu.', 'error');
      return;
    }
    const mode = $('#importMode').value;
    const transaction = $('#importTransaction').value;
    const allowNonTransactional = $('#importAllowNonTransactional')?.checked === true;
    const taskId = newTransferTaskId('import');
    const profileId = app.connection?.id || null;
    showTransferProgress('import', `${database}.${targetTable}`, { taskId, profileId });
    try {
      const result = await call(desktop.db.importFile({
        profileId,
        database,
        table: targetTable,
        filePath: file.filePath,
        format: chosenFormat,
        delimiter: chosenDelimiter,
        hasHeader: chosenHasHeader,
        mapping,
        mode,
        transaction,
        allowNonTransactional,
        taskId
      }));
      activeTransfer = null;
      closeModal();
      if (result.canceled) {
        toast(`Đã hủy nhập dữ liệu.${transferPartialText(result)} Tệp chưa được nhập tiếp.`);
        return;
      }
      if (app.database === database && table === targetTable) await loadData();
      const duplicates = Number(result.duplicates || 0);
      const warnings = Number(result.warnings || 0);
      const warningText = warnings ? ` · database báo ${warnings.toLocaleString()} cảnh báo, hãy kiểm tra dữ liệu` : '';
      toast(`Đã nhập ${Number(result.committed ?? result.written ?? 0).toLocaleString()} dòng${duplicates ? `, xử lý ${duplicates.toLocaleString()} bản ghi trùng` : ''}${warningText}.`, warnings ? 'error' : 'info');
    } catch (error) {
      activeTransfer = null;
      closeModal();
      const rowText = error && error.row ? ` Lỗi tại dòng dữ liệu ${error.row}.` : '';
      toast(`${error.message}${rowText}${transferPartialText(error && error.partial)}`, 'error');
    }
  });
}

async function importFileModal() {
  if (!app.database || !table) {
    toast('Hãy chọn một bảng trước khi nhập.', 'error');
    return;
  }
  const database = app.database;
  const targetTable = table;
  try {
    const file = await call(desktop.db.pickImportFile({}));
    if (file.canceled) return;
    await previewImportDialog(file, database, targetTable);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function transfer(type) {
  if (!app.database || !table) {
    toast('Chọn một bảng trước.', 'error');
    return;
  }
  const database = app.database;
  const targetTable = table;
  if (type === 'export') {
    const profileId = app.connection?.id || null;
    const searchState = { search: app.search, searchColumn: app.searchColumn || null, searchMode: app.searchMode || 'contains' };
    const orderBy = app.orderBy ? { column: app.orderBy, direction: app.orderDir || 'ASC' } : null;
    const sorts = tableSorts().map(entry => ({ ...entry }));
    const visibleColumns = window.SqlTableView.visible(app.visibleColumns, app.columns).map(column => column.name);
    const filterTree = app.filterTree || null;
    const searchSummary = [tableSearchSummary(searchState), filterTree ? 'Nhóm AND/OR đang áp dụng' : ''].filter(Boolean).join(' AND ');
    const hasSearch = Boolean(searchSummary);
    modal(`
      <h2>Xuất dữ liệu</h2>
      <p>${esc(database)}.${esc(targetTable)}</p>
      <p class="hint">Phạm vi: ${hasSearch ? `các dòng khớp bộ lọc “${esc(searchSummary)}” nếu chọn bên dưới, ngược lại toàn bộ bảng` : 'toàn bộ bảng'}${sorts.length ? ` · sắp xếp theo ${sorts.map(entry => `${esc(entry.column)} ${esc(entry.direction)}`).join(', ')}` : ''}.</p>
      <label>Định dạng</label>
      <select id="exportFormat">
        <option value="csv">CSV — UTF-8, có dòng tiêu đề</option>
        <option value="tsv">TSV — phân tách bằng tab</option>
        <option value="json">JSON — mảng đối tượng</option>
      </select>
      <label class="check-row" style="margin-top:12px">
        <input type="checkbox" id="exportFiltered" ${hasSearch ? '' : 'disabled'}>
        Chỉ xuất các dòng khớp bộ lọc hiện tại${hasSearch ? ` (“${esc(searchSummary)}”)` : ''}
      </label>
      <label class="check-row"><input type="checkbox" id="exportVisibleColumns">Chỉ xuất ${visibleColumns.length} cột đang hiển thị</label>
      <div class="hint">Tác vụ chạy theo luồng, không giới hạn 20.000 dòng và có thể hủy giữa chừng. CSV/TSV dùng <code>\\N</code> cho NULL và <code>0x…</code> cho dữ liệu nhị phân; JSON giữ nguyên <code>null</code>.</div>
      <div class="actions">
        <button data-click="close-modal">Hủy</button>
        <button class="primary" id="exportGo">Chọn nơi lưu…</button>
      </div>
    `);
    $('#exportGo').addEventListener('click', async () => {
      const format = $('#exportFormat').value;
      const useFilter = $('#exportFiltered')?.checked === true;
      const onlyVisible = $('#exportVisibleColumns')?.checked === true;
      const taskId = newTransferTaskId('export');
      showTransferProgress('export', `${database}.${targetTable}`, { taskId, profileId });
      try {
        const result = await call(desktop.db.exportFile({
          profileId,
          database,
          table: targetTable,
          format,
          taskId,
          search: useFilter ? searchState.search : '',
          searchColumn: useFilter ? searchState.searchColumn : null,
          searchMode: useFilter ? searchState.searchMode : 'contains',
          filterTree: useFilter ? filterTree : null,
          columns: onlyVisible ? visibleColumns : undefined,
          sorts,
          orderBy
        }));
        activeTransfer = null;
        closeModal();
        if (result.canceled) {
          if (result.dialog) return;
          toast(`Đã hủy xuất dữ liệu.${transferPartialText(result)} Tệp tạm đã được dọn.`);
          return;
        }
        toast(`Đã xuất ${Number(result.rows || 0).toLocaleString()} dòng (${formatBytes(result.bytes)}) tới ${result.filePath}.`);
      } catch (error) {
        activeTransfer = null;
        closeModal();
        toast(`${error.message}${transferPartialText(error && error.partial)}`, 'error');
      }
    });
    return;
  }
  await importFileModal();
}

function toggleMaskData() {
  app.maskData = !app.maskData;
  if (mode === 'query') {
    renderQueryView();
  } else if (mode === 'data') {
    const grid = $('#grid');
    if (grid) grid.innerHTML = dataGridHtml();
    const btn = $('#maskDataBtn');
    if (btn) {
      btn.className = app.maskData ? 'active' : '';
      btn.textContent = `🎭 ${app.maskData ? 'Đang che PII' : 'Che PII'}`;
    }
  }
  toast(app.maskData ? 'Đã bật che giấu dữ liệu nhạy cảm PII' : 'Đã tắt che giấu dữ liệu', 'info');
  persistState();
}

const delegatedClickActions = {
  'close-modal': () => closeModal(),
  'new-connection': () => connection(),
  'import-navicat': () => importNavicat(),
  'new-query': () => newQuery(),
  'account': () => accountModal(),
  'workspace-form': () => workspaceForm(),
  'workspace-manager': () => workspaceManager(),
  'disconnect': () => disconnect(),
  'processlist': () => showProcesslistModal(),
  'server-vars': () => showServerVarsModal(),
  'schema-diff': () => showSchemaDiffModal(),
  'data-diff': () => showDataDiffModal(),
  'audit-log': () => showAuditLogModal(),
  'shortcuts': () => showShortcutsModal(),
  'snippets': () => openSnippetsModal(),
  'toggle-theme': () => toggleTheme(),
  'toggle-mask': () => toggleMaskData(),
  'erd': () => showErDiagramModal(),
  'load-data': () => loadData(),
  'view': (target) => view(target.dataset.view),
  'export-result': (target) => exportCurrentResult(target.dataset.format)
};

document.addEventListener('click', (event) => {
  const target = event.target && typeof event.target.closest === 'function'
    ? event.target.closest('[data-click]')
    : null;
  if (!target) return;
  const action = delegatedClickActions[target.dataset.click];
  if (!action) return;
  event.preventDefault();
  action(target);
});

window.addEventListener('DOMContentLoaded', init);
