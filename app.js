'use strict';

let table = null;
let mode = 'data';
let historyRows = [];
let savedQueries = [];
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
  if (!html.includes('data-transfer-running')) {
    clearTimeout(window.__sqlproTaskTimer);
    window.__sqlproTaskTimer = null;
  }
  dialog.className = wide ? 'wide' : '';
  dialog.innerHTML = html;
  if (!dialog.open) dialog.showModal();
}

function closeModal() {
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
      currentObject.textContent = progress.stage === 'finishing' ? 'Đang hoàn tất tệp backup…'
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
    if (step) step.textContent = progress.stage === 'finishing' ? '● Đang hoàn tất'
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

function queryTargetLabel(tab) {
  const connection = queryTargetConnection(tab);
  const name = connection && connection.name
    ? connection.name
    : (tab && tab.profileId ? 'kết nối không còn tồn tại' : 'chưa gắn kết nối');
  return `${name} · ${(tab && tab.database) || 'không chọn database'}`;
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

function autocompleteCacheKey(database, tableName) {
  return `${app.connection?.id || ''}\u0000${database || ''}\u0000${tableName || ''}`.toLocaleLowerCase();
}

function loadAutocompleteColumns(database, tableName) {
  if (!desktop || !app.connection || !database || !tableName) return Promise.resolve([]);
  const key = autocompleteCacheKey(database, tableName);
  const cached = sqlAutocomplete.columnCache.get(key);
  if (cached) return cached;
  const pending = call(desktop.db.columns(database, tableName, app.connection?.id || null))
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
  const before = sqlEditorSnapshot(editor);
  const insertText = String(item.insertText ?? item.label);
  editor.setRangeText(insertText, context.start, context.end, 'end');
  if (/\(\)$/.test(insertText)) {
    const caret = editor.selectionStart - 1;
    editor.setSelectionRange(caret, caret);
  }
  recordSqlEditorChange(editor, { before });
  closeSqlSuggestions();
  editor.focus();
}

function normalizeHistory(item) {
  if (typeof item === 'string') return { sql: item, ok: true, at: '', durationMs: null, profileId: null, database: null };
  if (!item || typeof item !== 'object' || typeof item.sql !== 'string') return null;
  return {
    sql: item.sql,
    ok: item.ok !== false,
    at: typeof item.at === 'string' ? item.at : '',
    durationMs: Number.isFinite(item.durationMs) ? item.durationMs : null,
    message: typeof item.message === 'string' ? item.message : '',
    profileId: typeof item.profileId === 'string' ? item.profileId : null,
    database: typeof item.database === 'string' ? item.database : null
  };
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
      mode: mode === 'transfer' ? 'backups' : mode,
      savedQuery: app.query?.sql ?? (sessionStorage.getItem('query') || ''),
      queryTabs: queryTabs.map((tab) => ({
        title: tab.title,
        sql: tab.sql ?? '',
        profileId: tab.profileId || null,
        database: tab.database || null
      })),
      activeQuery,
      history: historyRows.slice(0, 100),
      savedQueries: savedQueries.slice(0, 200)
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

async function init() {
  initTheme();
  setupContextMenu();
  $('#treeSearch').addEventListener('input', debounce(renderSidebar, 180));
  $('#workspaceSelect').addEventListener('change', (event) => switchWorkspace(event.target.value));
  $('#connectionList').addEventListener('click', onConnectionClick);
  $('#connectionList').addEventListener('keydown', activateSidebarItem);
  $('#workspace').addEventListener('click', onBackupManagerClick);
  $('#workspace').addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-backup-row]')) {
      event.preventDefault();
      app.selectedBackupId = event.target.dataset.backupRow;
      renderBackupsView();
      renderSidebar();
    }
  });
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
      running: false,
      profileId: tab && typeof tab.profileId === 'string' && tab.profileId
        ? tab.profileId
        : (typeof saved.connectionId === 'string' ? saved.connectionId : null),
      database: tab && typeof tab.database === 'string' && tab.database
        ? tab.database
        : (typeof saved.database === 'string' ? saved.database : null),
      taskId: null
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
  if (saved && Array.isArray(saved.savedQueries)) {
    savedQueries = saved.savedQueries.map(normalizeSavedQuery).filter(Boolean).slice(0, 200);
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
  if (desktop.db?.openProfiles) {
    const ids = await call(desktop.db.openProfiles());
    openConnectionIds.clear();
    for (const id of ids) openConnectionIds.add(id);
  }
  ensureDefaultWorkspace();
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
        <div class="connmeta" title="${esc(connection.user || 'root')}@${esc(connection.host)}:${connection.port} · ${esc(connectionSecuritySummary(connection))}">${esc(connection.user || 'root')}@${esc(connection.host)}:${connection.port}${connection.ssh?.enabled ? ' · SSH' : ''} · ${esc(connectionTransportBadge(connection))}</div>
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
  newQuery(entry.sql, { profileId: entry.profileId, database: entry.database });
  app.query.savedQueryId = entry.id;
  app.query.title = entry.name.slice(0, 40);
  updateChrome();
  persistState();
}

function saveQuery() {
  const editor = $('#sql');
  if (editor && app.query) app.query.sql = editor.value;
  const sql = app.query?.sql || '';
  if (!sql.trim()) {
    toast('Câu lệnh SQL đang trống.', 'error');
    return;
  }
  sessionStorage.setItem('query', sql);
  const existing = app.query.savedQueryId
    ? savedQueries.find((entry) => entry.id === app.query.savedQueryId)
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
  $('#savedQueryGo').addEventListener('click', () => {
    const name = $('#savedQueryName').value.trim();
    if (!name) {
      toast('Tên truy vấn không được để trống.', 'error');
      return;
    }
    const now = new Date().toISOString();
    const target = { profileId: app.query.profileId || null, database: app.query.database || null };
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
      app.query.savedQueryId = entry.id;
    }
    savedQueries = savedQueries.slice(0, 200);
    openTreeGroups.add('queries');
    persistState();
    renderSidebar();
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
  if (targetSql && typeof desktop.db?.exportQuery === 'function') {
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
    toast('Kết quả chỉ có bản xem trước. Hãy chạy lại SQL để xuất dữ liệu đầy đủ.', 'error');
    return;
  }
  const cols = target.columns.map((c) => c.name);
  if (format === 'csv') {
    const csvContent = '\uFEFF' + [
      cols.map((name) => ExportValues.csvField(name, ',')).join(','),
      ...target.rows.map((row) => row.map((value) => ExportValues.csvField(value, ',')).join(','))
    ].join('\r\n');
    desktop.saveTextFile({
      suggestedName: 'query-result.csv',
      contents: csvContent,
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    }).then((res) => {
      if (!res.canceled) {
        toast('Đã xuất ' + target.rows.length + ' dòng ra CSV'
          + (target.truncated ? ' (chỉ các dòng đang hiển thị)' : ''));
      }
    }).catch((err) => toast(err.message, 'error'));
  } else {
    const names = ExportValues.uniqueColumnNames(cols);
    const json = '[\n' + target.rows.map((row) => '{' + names.map((name, index) =>
      `${JSON.stringify(name)}:${ExportValues.jsonField(row[index], target.columns[index])}`).join(',') + '}').join(',\n') + '\n]';
    desktop.saveTextFile({
      suggestedName: 'query-result.json',
      contents: json,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    }).then((res) => {
      if (!res.canceled) {
        toast('Đã xuất ' + target.rows.length + ' dòng ra JSON'
          + (target.truncated ? ' (chỉ các dòng đang hiển thị)' : ''));
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
          <h3>🖥️ Quản Lý Tiến Trình <span class="modal-title-tag">Processlist</span></h3>
          <button class="refresh-header-btn" id="refreshProcesslistBtn" title="Làm mới danh sách tiến trình">↻ Làm mới</button>
        </div>
        <button class="close-btn" data-click="close-modal" title="Đóng (Esc)" aria-label="Đóng">✕</button>
      </div>
      <div class="modal-body">
        <div class="processlist-toolbar">
          <div class="processlist-search-wrap">
            <span class="processlist-search-icon">🔍</span>
            <input type="search" id="processlistFilter" class="processlist-search-input" placeholder="Lọc theo ID, user, host, database, lệnh, câu lệnh SQL..." autocomplete="off">
          </div>
          <div class="processlist-metrics" id="processlistMetrics">
            <button type="button" class="metric-chip active" data-filter="all">Tất cả <strong id="metricTotal">0</strong></button>
            <button type="button" class="metric-chip chip-query" data-filter="query">Đang chạy <strong id="metricQuery">0</strong></button>
            <button type="button" class="metric-chip chip-sleep" data-filter="sleep">Đang chờ <strong id="metricSleep">0</strong></button>
            <button type="button" class="metric-chip chip-slow" data-filter="slow">Chậm (>5s) <strong id="metricSlow">0</strong></button>
          </div>
        </div>
        <div id="processlistContainer" class="processlist-table-container">
          <div class="processlist-loading">Đang truy vấn SHOW FULL PROCESSLIST...</div>
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

  let activeQuickFilter = 'all';

  async function loadProcesslist() {
    const container = $('#processlistContainer');
    if (!container) return;
    try {
      const res = await call(desktop.db.query({ ...activeQueryTarget(), sql: 'SHOW FULL PROCESSLIST' }));
      if (container !== $('#processlistContainer')) return;
      const rows = res.rows || [];
      const filterVal = ($('#processlistFilter')?.value || '').toLowerCase().trim();

      let queryCount = 0;
      let sleepCount = 0;
      let slowCount = 0;
      for (const r of rows) {
        const cmd = String(r[4] || '');
        const timeSec = Number(r[5] || 0);
        if (cmd === 'Query') queryCount++;
        else if (cmd === 'Sleep') sleepCount++;
        if (timeSec > 5 && cmd === 'Query') slowCount++;
      }

      const totalEl = $('#metricTotal');
      const queryEl = $('#metricQuery');
      const sleepEl = $('#metricSleep');
      const slowEl = $('#metricSlow');
      if (totalEl) totalEl.textContent = rows.length;
      if (queryEl) queryEl.textContent = queryCount;
      if (sleepEl) sleepEl.textContent = sleepCount;
      if (slowEl) slowEl.textContent = slowCount;

      const filtered = rows.filter((r) => {
        const cmd = String(r[4] || '');
        const timeSec = Number(r[5] || 0);

        if (activeQuickFilter === 'query' && cmd !== 'Query') return false;
        if (activeQuickFilter === 'sleep' && cmd !== 'Sleep') return false;
        if (activeQuickFilter === 'slow' && !(timeSec > 5 && cmd === 'Query')) return false;

        if (!filterVal) return true;
        const id = String(r[0] || '').toLowerCase();
        const user = String(r[1] || '').toLowerCase();
        const host = String(r[2] || '').toLowerCase();
        const db = String(r[3] || '').toLowerCase();
        const state = String(r[6] || '').toLowerCase();
        const info = String(r[7] || '').toLowerCase();
        return id.includes(filterVal) || user.includes(filterVal) || host.includes(filterVal) ||
               db.includes(filterVal) || cmd.toLowerCase().includes(filterVal) ||
               state.includes(filterVal) || info.includes(filterVal);
      });

      if (!filtered.length) {
        container.innerHTML = '<div class="processlist-empty">Không có tiến trình nào phù hợp với bộ lọc.</div>';
        return;
      }

      container.innerHTML = `
        <table class="processlist-table">
          <thead>
            <tr>
              <th style="width:75px;">ID</th>
              <th style="width:130px;">User</th>
              <th style="width:130px;">Host</th>
              <th style="width:120px;">Database</th>
              <th style="width:90px;">Lệnh</th>
              <th style="width:110px;">Thời gian</th>
              <th style="width:120px;">Trạng thái</th>
              <th>Câu lệnh SQL</th>
              <th style="width:80px; text-align:center;">Thao tác</th>
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

              let timeFormatted = `${timeSec}s`;
              if (timeSec >= 60) {
                const mins = Math.floor(timeSec / 60);
                const secs = timeSec % 60;
                timeFormatted = `${timeSec}s (${mins}m ${secs}s)`;
              }

              const cmdClass = command === 'Query' ? 'active' : (command === 'Sleep' ? 'sleep' : '');

              return `
                <tr class="${isSlow ? 'slow-process-row' : ''}">
                  <td class="proc-id mono">#${esc(String(id))}</td>
                  <td class="proc-user" title="${esc(user)}"><strong>${esc(user)}</strong></td>
                  <td class="proc-host mono" title="${esc(host)}">${esc(host.length > 20 ? host.slice(0, 20) + '…' : host)}</td>
                  <td class="proc-db" title="${esc(dbName || '—')}">${dbName ? `<span class="proc-db-badge">${esc(dbName)}</span>` : '<span class="muted">—</span>'}</td>
                  <td><span class="command-badge ${cmdClass}">${esc(command)}</span></td>
                  <td>
                    <span class="time-badge ${isSlow ? 'time-warn' : ''}">
                      ${isSlow ? '⚠️ ' : ''}${timeFormatted}
                    </span>
                  </td>
                  <td class="proc-state" title="${esc(state || '—')}"><small>${esc(state || '—')}</small></td>
                  <td class="proc-sql-cell" title="${esc(info ? `${info}\n\n(Nhấp chuột để sao chép SQL)` : 'Không có câu lệnh thực thi')}">
                    ${info ? `<code class="process-sql" data-full-sql="${esc(info)}">${esc(info.length > 85 ? info.slice(0, 85) + '…' : info)}</code>` : '<span class="muted">—</span>'}
                  </td>
                  <td style="text-align:center;">
                    <button class="danger kill-btn" data-kill-id="${id}" title="Hủy tiến trình #${id}">✕ Kill</button>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      `;

      container.querySelectorAll('.process-sql').forEach((codeEl) => {
        codeEl.addEventListener('click', async (e) => {
          e.stopPropagation();
          const sql = codeEl.dataset.fullSql;
          if (sql) {
            try {
              await writeClipboardText(sql);
              toast('Đã sao chép câu lệnh SQL vào bộ nhớ tạm', 'success');
            } catch {}
          }
        });
      });

      container.querySelectorAll('.kill-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const killId = btn.dataset.killId;
          if (!/^\d+$/.test(killId)) return;
          const confirmed = await confirmAction(`Hủy tiến trình #${killId}?`, 'Kết nối hoặc truy vấn của tiến trình này sẽ bị dừng.', 'Hủy tiến trình');
          if (!confirmed) return;
          try {
            await call(desktop.db.query({ ...activeQueryTarget(), sql: `KILL ${killId}`, confirmed: true }));
            toast(`Đã hủy tiến trình #${killId}`, 'success');
            await showProcesslistModal();
          } catch (err) {
            toast(err.message || 'Lỗi khi hủy tiến trình', 'error');
          }
        });
      });
    } catch (err) {
      container.innerHTML = `<div class="processlist-error">Lỗi: ${esc(err.message)}</div>`;
    }
  }

  loadProcesslist();
  $('#refreshProcesslistBtn')?.addEventListener('click', loadProcesslist);
  $('#processlistFilter')?.addEventListener('input', debounce(loadProcesslist, 300));
  $('#processlistMetrics')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.metric-chip');
    if (!chip) return;
    $('#processlistMetrics').querySelectorAll('.metric-chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    activeQuickFilter = chip.dataset.filter || 'all';
    loadProcesslist();
  });
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
  const cacheKey = `${target.profileId || ''}.${target.database}.${target.targetTable}`;
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
      const cellEditable = selectedIndexes.length === 1 && !queryTd.classList.contains('muted')
        && !result.isExplain && Boolean(source.orgTable || source.table);
      menu.innerHTML = queryResultContextMenuHtml({ source, cellEditable, tableTarget, rowEditable: false,
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
          const cacheKey = `${tableTarget.profileId || ''}.${tableTarget.database}.${tableTarget.targetTable}`;
          queryTablePkCache.set(cacheKey, columns.filter((column) => column.key === 'PRI').map((column) => column.name));
          const editable = queryResultPrimaryKeyIndexes(result, tableTarget).length > 0;
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
  if (app.connection?.id && app.connection.id !== id && app.database) {
    connectionLocations.set(app.connection.id, { database: app.database, table, mode });
    connectionViews.set(app.connection.id, {
      server: app.server, databases: app.databases, database: app.database,
      tables: app.tables, backups: app.backups, selectedBackupId: app.selectedBackupId,
      columns: app.columns, primaryKey: app.primaryKey, rows: app.rows,
      total: app.total, page: app.page, search: app.search,
      searchColumn: app.searchColumn, searchMode: app.searchMode,
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
          if (table && app.columns.length) renderDataView();
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

function renderBackupsView() {
  const selected = app.backups.find((entry) => entry.id === app.selectedBackupId);
  const rows = app.backups.map((entry) => `
    <tr class="backup-row ${entry.id === app.selectedBackupId ? 'selected' : ''}" data-backup-row="${esc(entry.id)}" tabindex="0" aria-selected="${entry.id === app.selectedBackupId}">
      <td>◴ &nbsp; ${esc(entry.name)}</td>
      <td>${esc(new Date(entry.createdAt).toLocaleString('vi-VN'))}</td>
      <td>${formatBytes(entry.bytes)}</td>
      <td title="${esc(entry.checksum || '')}">${esc(backupChecksumNote(entry))}</td>
    </tr>`).join('');
  $('#workspace').innerHTML = `
    <section class="backup-manager" aria-label="Quản lý bản sao lưu">
      <div class="backup-manager-toolbar">
        <button data-backup-action="create" class="primary">＋ Tạo bản sao lưu</button>
        <button data-backup-action="restore" ${selected ? '' : 'disabled'}>↶ Phục hồi</button>
        <button data-backup-action="verify" ${selected ? '' : 'disabled'}>✓ Xác minh checksum</button>
        <button data-backup-action="copy-backup" ${selected ? '' : 'disabled'}>⎘ Sao chép (Ctrl+C)</button>
        <button data-backup-action="paste-backup" ${app.copiedBackup ? '' : 'disabled'}>📋 Dán (Ctrl+V)</button>
        <button data-backup-action="copy-to-db" ${selected ? '' : 'disabled'}>⧉ Sao chép sang DB khác…</button>
        <button data-backup-action="delete" class="danger" ${selected ? '' : 'disabled'}>⌫ Xóa bản sao lưu</button>
        <button data-backup-action="export" ${selected ? '' : 'disabled'}>⇩ Xuất tệp SQL</button>
        <button data-backup-action="refresh">↻ Làm mới</button>
      </div>
      <div class="backup-manager-table"><table><thead><tr><th>Tên</th><th>Ngày tạo</th><th>Dung lượng</th><th>Ghi chú</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="backup-manager-empty">Chưa có bản sao lưu. Bấm “Tạo bản sao lưu” để bắt đầu.</td></tr>'}</tbody>
      </table></div>
      <div class="backup-manager-footer">${app.backups.length} bản sao lưu · ${esc(app.database || '')}</div>
    </section>`;
}

function backupContextMenuHtml(hasSelection) {
  const item = (action, icon, label, disabled = false) => `<div class="context-menu-item ${disabled ? 'disabled' : ''}" ${disabled ? '' : `data-backup-menu="${action}"`}><span class="c-icon">${icon}</span>${label}</div>`;
  const canPaste = Boolean(app.copiedBackup);
  return `
    ${item('restore', '↶', 'Phục hồi bản sao lưu', !hasSelection)}
    ${item('verify', '✓', 'Xác minh checksum', !hasSelection)}
    ${item('copy-backup', '⎘', 'Sao chép bản sao lưu (Ctrl+C)', !hasSelection)}
    ${item('paste-backup', '📋', 'Dán bản sao lưu vào đây (Ctrl+V)', !canPaste)}
    ${item('copy-to-db', '⧉', 'Sao chép sang Database khác…', !hasSelection)}
    ${item('create', '＋', 'Tạo bản sao lưu mới')}
    ${item('delete', '⌫', 'Xóa bản sao lưu', !hasSelection)}
    <div class="context-menu-sep"></div>
    ${item('restore-file', '⇧', 'Phục hồi từ tệp SQL…')}
    ${item('export', '⇩', 'Xuất tệp SQL…', !hasSelection)}
    ${item('copy', '⧉', 'Sao chép tên', !hasSelection)}
    <div class="context-menu-sep"></div>
    ${item('folder', '▣', 'Mở thư mục chứa backup')}
    ${item('refresh', '↻', 'Làm mới')}`;
}

async function runBackupManagerAction(action) {
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
  if (action === 'copy-backup' && app.selectedBackupId) return copySelectedBackupToClipboard(app.selectedBackupId);
  if (action === 'paste-backup' && app.copiedBackup) return pasteBackupModal();
  if (action === 'copy-to-db' && app.selectedBackupId) return copyBackupToDatabaseModal(app.selectedBackupId);
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
    const confirmed = await confirmAction('Xóa bản sao lưu?', `Tệp backup ${id} sẽ bị xóa khỏi máy.`, 'Xóa');
    if (!confirmed) return;
    try {
      await call(desktop.db.deleteBackup({
        profileId: app.connection?.id || null,
        database: app.database,
        id
      }));
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
  table = name;
  app.page = 1;
  app.search = '';
  app.searchColumn = null;
  app.searchMode = 'contains';
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
    const data = await call(desktop.db.tableData({
      profileId: app.connection?.id || null,
      database,
      table: targetTable,
      page: app.page,
      pageSize: app.pageSize,
      search: app.search,
      searchColumn: app.searchColumn || null,
      searchMode: app.searchMode || 'contains',
      cursor: app.pageCursor || null,
      orderBy: app.orderBy,
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
  sessionStorage.setItem('query', editor.value);
}

function renderQueryTabs() {
  const host = $('#queryTabs');
  if (!host) return;
  host.innerHTML = queryTabs.map((tab, index) => {
    const target = queryTargetLabel(tab);
    return `
    <button class="querytab${mode === 'query' && index === activeQuery ? ' selected' : ''}" data-query-tab="${index}" title="${esc(`${tab.title} · ${target}`)}">
      ⌑ &nbsp; ${esc(tab.title)}${tab.running ? ' <span class="tabrunning">…</span>' : ''} &nbsp; <span class="tabclose" data-close-query="${index}" title="Đóng tab">×</span>
      <span class="querytab-target">${esc(target)}</span>
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

function newQuery(sql = '', target = null) {
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
  const tab = {
    id: queryId,
    title: `Query ${queryId}`,
    sql: String(sql ?? ''),
    result: null,
    error: null,
    running: false,
    profileId: profileId || null,
    database: database || null,
    taskId: null,
    savedQueryId: null
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
  if (mode === 'query' && wasActive) syncActiveQuery();
  queryTabs.splice(index, 1);
  if (!queryTabs.length) {
    queryId += 1;
    queryTabs.push({
      id: queryId,
      title: `Query ${queryId}`,
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
  const label = mode === 'query' ? 'QUERY' : mode === 'history' ? 'WORKSPACE' : mode === 'data' ? 'TABLE' : mode.toUpperCase();
  const title = mode === 'transfer' ? 'Tác vụ database' : mode === 'backups' ? 'Backups' : mode === 'query' ? 'SQL Editor' : mode === 'history' ? 'Lịch sử truy vấn' : (table || app.database || 'Workspace');
  $('#title').innerHTML = `${esc(title)} <span>${label}</span>`;
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
  $('#crumbServer').textContent = app.connection ? `${app.serverType === 'mariadb' ? 'MARIADB' : 'MYSQL'}${app.server ? ` ${app.server}` : ''}` : 'CHƯA KẾT NỐI';
  $('#tabName').textContent = mode === 'backups' ? 'Backups' : mode === 'transfer' ? 'Tác vụ' : (table || '—');
  $('#dataTab').classList.toggle('selected', mode !== 'query' && mode !== 'transfer');
  renderQueryTabs();
  renderTransferTab();
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
  const cancel = () => {
    if (finished || saving) return;
    finished = true; td.classList.remove('editing-cell'); td.innerHTML = originalDisplay;
  };
  const commit = async () => {
    if (finished || saving) return false;
    let change;
    try { change = editor.read(); }
    catch (error) { editor.showError(error.message); return false; }
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
    setTimeout(() => { if (!editor.element.contains(document.activeElement)) void commit(); }, 0);
  });
  editor.focus();
}

async function inlineEditCell(td) {
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

function renderDataView() {
  const editable = app.primaryKey.length > 0;
  $('#workspace').innerHTML = `
    <div class="toolbar">
      <input class="filter" id="filter" placeholder="⌕  Tìm trong bảng…" value="${esc(app.search)}">
      <select id="filterColumn" aria-label="Cột tìm kiếm"><option value="">Tất cả cột</option>${app.columns.map((column) => `<option value="${esc(column.name)}" ${app.searchColumn === column.name ? 'selected' : ''}>${esc(column.name)}</option>`).join('')}</select>
      <select id="filterMode" aria-label="Cách tìm kiếm"><option value="contains">Chứa</option><option value="exact" ${app.searchMode === 'exact' ? 'selected' : ''}>Bằng</option></select>
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
    app.pageCursor = null;
    loadData().then(() => {
      const next = $('#filter');
      if (next) {
        next.focus();
        next.setSelectionRange(next.value.length, next.value.length);
      }
    });
  }, 350));
  for (const selector of ['#filterColumn', '#filterMode']) $(selector).addEventListener('change', () => {
    app.searchColumn = $('#filterColumn').value || null;
    app.searchMode = $('#filterMode').value;
    app.page = 1; app.pageCursor = null; void loadData();
  });
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
    const target = { profileId: app.connection?.id, database: app.database, table, search: app.search, searchColumn: app.searchColumn || null, searchMode: app.searchMode || 'contains', force: true };
    const button = $('#countRowsBtn');
    button.disabled = true;
    try {
      const result = await call(desktop.db.tableCount(target));
      if (target.profileId !== app.connection?.id || target.database !== app.database || target.table !== table || target.search !== app.search || target.searchColumn !== (app.searchColumn || null) || target.searchMode !== (app.searchMode || 'contains')) return;
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
  const previous = before || { ...history.current };
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
  sessionStorage.setItem('query', editor.value);
  persistState();
}

function restoreSqlEditorSnapshot(editor, snapshot) {
  editor.value = snapshot.value;
  editor.setSelectionRange(snapshot.start, snapshot.end);
  app.query.sql = snapshot.value;
  sessionStorage.setItem('query', snapshot.value);
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
  const target = await ensureQueryTarget(tab);
  if (!target) return;
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
    tab.taskId = newQueryTaskId();
    tab.error = null;
    closeSqlSuggestions();
    updateQueryButtons();
    renderQueryTabs();
    setStatus('Đang phân tích kế hoạch thực thi (EXPLAIN)...');
    const result = await call(desktop.db.query({
      sql: explainSql,
      timeoutMs: 30000,
      profileId: target.profileId,
      database: tab.database || null,
      taskId: tab.taskId
    }));
    result.isExplain = true;
    tab.result = result;
    tab.lastSql = explainSql;
    tab.resultContext = { profileId: target.profileId, database: tab.database || null };
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
    tab.taskId = null;
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
      const cacheKey = `${profileId || ''}.${targetDb}.${targetTable}`;
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
  const selection = queryGridSelection(result);
  if (selection.deleting) return;
  const indexes = [...new Set(rowIndexes)].filter((index) => Number.isInteger(index) && result.rows[index]);
  if (!indexes.length) return;
  selection.deleting = true;
  try {
    const columns = await call(desktop.db.columns(target.database, target.targetTable, target.profileId));
    if (getActiveQueryResult() !== result) return;
    queryTablePkCache.set(`${target.profileId || ''}.${target.database}.${target.targetTable}`,
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
          return `<td class="${isNull ? 'nullcell' : ''}" data-col="${esc(colMeta?.name || '')}" data-col-idx="${colIdx}" title="${esc(text.slice(0, 500))}">${cellDisplay}</td>`;
        }).join('')}
      </tr>`;
  }).join('') + (virtual ? spacer(Math.max(0, rows.length - start - visible.length)) : '')
    || `<tr><td colspan="${result.columns.length + 1}" class="empty">Không có dòng nào.</td></tr>`;
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
  const isEditable = !result.isExplain && (hasPk || (hasTable && Boolean(table) && app.primaryKey?.length));

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
        <button type="button" data-click="export-result" data-format="csv" title="Xuất kết quả truy vấn ra CSV">↧ Xuất CSV</button>
        <button type="button" data-click="export-result" data-format="json" title="Xuất kết quả truy vấn ra JSON">↧ Xuất JSON</button>
      </div>
    </div>`;

  return `
    ${compact ? '' : exportToolbar}
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
  if (cancel) cancel.style.display = running ? 'inline-block' : 'none';
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
      timeoutMs: 30000,
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
    historyRows.unshift({
      sql: sqlToRun,
      ok: !batchFailed,
      at: new Date().toISOString(),
      durationMs: result.durationMs,
      message: historyMessage,
      profileId: target.profileId,
      database: tab.database || null
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
      message: error.message,
      profileId: target.profileId,
      database: tab.database || null
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
  $('#workspace').innerHTML = `
    <div class="toolbar"><strong>${historyRows.length} truy vấn</strong><span class="spacer"></span><button id="clearHistory">⌫ Xóa lịch sử</button></div>
    ${historyRows.map((entry, index) => `
      <div class="historyrow" data-history="${index}">
        <span class="badge ${entry.ok ? '' : 'pending'}">${entry.ok ? 'OK' : 'Lỗi'}</span>
        <span class="mono history-sql">${esc(entry.sql.slice(0, 300))}</span>
        <span class="muted">${esc(connectionName(entry.profileId))} · ${esc(entry.database || '—')} · ${entry.durationMs === null ? '' : `${entry.durationMs} ms`} ${entry.at ? esc(new Date(entry.at).toLocaleString('vi-VN')) : ''}</span>
      </div>
    `).join('') || '<div class="empty">Chưa có truy vấn. Mở SQL Editor để bắt đầu.</div>'}
  `;
  $('#workspace').querySelectorAll('[data-history]').forEach((row) => {
    row.addEventListener('click', () => {
      const entry = historyRows[Number(row.dataset.history)];
      if (!entry) return;
      newQuery(entry.sql, { profileId: entry.profileId, database: entry.database });
    });
  });
  $('#clearHistory').addEventListener('click', () => {
    historyRows = [];
    persistState();
    renderHistoryView();
  });
}

async function editRow(index, target = null) {
  const profileId = target?.profileId || app.connection?.id || null;
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
      if (settled) return;
      settled = true;
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
    <div class="accountnote">Connection và workspace được mã hóa trên máy trước khi gửi lên server. Server không đọc được host, user hay mật khẩu. Mật khẩu không thể khôi phục.</div>
    <div class="actions">
      <button type="button" id="accountLogout">Đăng xuất</button>
      <span class="spacer"></span>
      <button type="button" id="accountClose">Đóng</button>
      <button type="button" class="primary" id="accountSync" ${status.state === 'syncing' ? 'disabled' : ''}>${reauth ? 'Đăng nhập lại' : needsChoice ? 'Áp dụng lựa chọn' : 'Đồng bộ ngay'}</button>
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

async function refreshSessionState(profileId = app.connection?.id || null) {
  if (!desktop || !profileId || typeof desktop.db.sessionState !== 'function') return;
  try {
    const state = await call(desktop.db.sessionState(profileId));
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
    <div class="actions">
      <button data-click="close-modal">Hủy</button>
      <button class="primary" id="restoreGo">${backupId ? 'Phục hồi bản này' : 'Chọn tệp .sql…'}</button>
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
    if (existing) {
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
    const isNew = dbSelect.value === '__NEW__';
    const finalTargetDb = isNew ? ($('#pasteNewDbName').value || '').trim() : dbSelect.value;
    if (!finalTargetDb) {
      toast('Hãy chọn hoặc nhập tên Database đích.', 'error');
      return;
    }
    const doRestore = actionRestore.checked;
    const doCatalog = $('#pasteActionCatalog').checked;
    const dropExisting = actionDrop.checked;

    if (!doRestore && !doCatalog) {
      toast('Hãy chọn ít nhất một thao tác (Khôi phục dữ liệu hoặc Lưu vào danh mục).', 'error');
      return;
    }

    const targetConnObj = allConnections.find((c) => c.id === targetConnId);
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

    if (!doRestore && !doCatalog) {
      toast('Hãy chọn ít nhất một thao tác (Khôi phục dữ liệu hoặc Lưu vào danh mục).', 'error');
      return;
    }

    const targetConnObj = allConnections.find((c) => c.id === targetConnId);
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
    const hasSearch = Boolean(String(app.search || '').trim());
    modal(`
      <h2>Xuất dữ liệu</h2>
      <p>${esc(database)}.${esc(targetTable)}</p>
      <p class="hint">Phạm vi: ${hasSearch ? `các dòng khớp bộ lọc “${esc(app.search)}” nếu chọn bên dưới, ngược lại toàn bộ bảng` : 'toàn bộ bảng'}${app.orderBy ? ` · sắp xếp theo ${esc(app.orderBy)} ${esc(app.orderDir || 'ASC')}` : ''}.</p>
      <label>Định dạng</label>
      <select id="exportFormat">
        <option value="csv">CSV — UTF-8, có dòng tiêu đề</option>
        <option value="tsv">TSV — phân tách bằng tab</option>
        <option value="json">JSON — mảng đối tượng</option>
      </select>
      <label class="check-row" style="margin-top:12px">
        <input type="checkbox" id="exportFiltered" ${hasSearch ? '' : 'disabled'}>
        Chỉ xuất các dòng khớp bộ lọc hiện tại${hasSearch ? ` (“${esc(app.search)}”)` : ''}
      </label>
      <div class="hint">Tác vụ chạy theo luồng, không giới hạn 20.000 dòng và có thể hủy giữa chừng. CSV/TSV dùng <code>\\N</code> cho NULL và <code>0x…</code> cho dữ liệu nhị phân; JSON giữ nguyên <code>null</code>.</div>
      <div class="actions">
        <button data-click="close-modal">Hủy</button>
        <button class="primary" id="exportGo">Chọn nơi lưu…</button>
      </div>
    `);
    $('#exportGo').addEventListener('click', async () => {
      const format = $('#exportFormat').value;
      const useFilter = $('#exportFiltered')?.checked === true;
      const taskId = newTransferTaskId('export');
      const profileId = app.connection?.id || null;
      showTransferProgress('export', `${database}.${targetTable}`, { taskId, profileId });
      try {
        const result = await call(desktop.db.exportFile({
          profileId,
          database,
          table: targetTable,
          format,
          taskId,
          search: useFilter ? app.search : '',
          searchColumn: useFilter ? app.searchColumn : null,
          searchMode: useFilter ? app.searchMode : 'contains',
          orderBy: app.orderBy ? { column: app.orderBy, direction: app.orderDir } : null
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
  'shortcuts': () => showShortcutsModal(),
  'toggle-theme': () => toggleTheme(),
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
