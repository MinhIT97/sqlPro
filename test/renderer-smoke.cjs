'use strict';

// Runs the real HTML, renderer and preload in a hidden Electron window.
// Only IPC handlers are replaced; no database or account is contacted.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
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
let rowEditorFailure = false;
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
handle('workspaces:list', () => ok([{ id: 'ws-personal', name: 'Personal' }]));
handle('connections:list', () => ok([]));
handle('db:open-profiles', () => ok([]));
handle('account:status', () => ok({ loggedIn: false }));
handle('db:use-database', () => ok({}));
handle('db:databases', () => ok(['test']));
handle('db:tables', () => ok(tables));
handle('db:columns', () => ok(rowEditorColumns));
handle('db:indexes', () => ok([]));
handle('db:relations', () => ok({ outbound: [{ table: 'users', column: 'id', refTable: 'table_1', refColumn: 'id', refDatabase: 'test' }], inbound: [] }));
handle('db:table-data', () => ok({ columns, primaryKey: ['id'], rows: [{ id: 1, name: 'Alice' }], total: 1, page: 1, pageSize: 100 }));
handle('db:delete-rows', () => ok({ affectedRows: 1 }));
handle('db:update-row', () => rowEditorFailure ? { ok: false, error: { message: 'Expected row save failure' } } : ok({ affectedRows: 1, changedRows: 1 }));
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
  return ok({
    canceled: false, id: '20261023120000-smoke.sql', filePath: '/tmp/20261023120000-smoke.sql',
    tables: 1, views: 0, triggers: 0, procedures: 1, functions: 1, events: 1, rows: 1, bytes: 128
  });
});
handle('db:list-backups', () => ok([]));
handle('file:save-text', () => ({ canceled: false }));
handle('db:query', (payload) => {
  if (!payload || typeof payload.sql !== 'string') return { ok: false, error: { message: 'Invalid query payload' } };
  const sql = payload.sql.trim();
  if (/FAIL_TEST/.test(sql)) return { ok: false, error: { message: 'Expected SQL failure', code: 'TEST_ERROR' } };
  if (/^(UPDATE|DELETE|ALTER|DROP|KILL)\b/i.test(sql) && !payload.confirmed) {
    return { ok: false, error: { code: 'CONFIRM_REQUIRED', message: 'Confirmation required' } };
  }
  if (/^SHOW FULL PROCESSLIST/i.test(sql)) return ok(rows(['Id', 'User', 'Host', 'db', 'Command', 'Time', 'State', 'Info'], [[42, 'test', 'localhost', 'test', 'Query', 8, '', 'SELECT 1']]));
  if (/^SHOW (VARIABLES|STATUS)/i.test(sql)) return ok(rows(['Variable_name', 'Value'], [['max_connections', '151']]));
  if (/^EXPLAIN/i.test(sql)) return ok(rows(['table', 'type', 'Extra'], [['users', 'ALL', 'Using filesort']]));
  if (/^(CHECK|OPTIMIZE|ANALYZE|REPAIR) TABLE/i.test(sql)) return ok(rows(['Table', 'Op', 'Msg_type', 'Msg_text'], [['test.users', 'check', 'status', 'OK']]));
  if (/^SELECT/i.test(sql)) return ok(rows(['value', 'type'], [['ALL', 'ALL'], ['2', 'REF']]));
  return ok({ kind: 'ok', affectedRows: 1, insertId: null, durationMs: 1 });
});

const evaluate = (code) => win.webContents.executeJavaScript(code);
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
  await fn();
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
  win = new BrowserWindow({ show: false, width: 1360, height: 900, webPreferences: {
    preload: path.join(root, 'electron/preload.cjs'), contextIsolation: true, backgroundThrottling: false
  } });
  win.webContents.on('preload-error', (_event, _file, error) => errors.push(error.message));
  await win.loadFile(path.join(root, 'index.html'));
  await until('app.workspaces.length > 0');
  await evaluate("window.addEventListener('error', event => { window.rendererErrors.push(event.message); }); window.addEventListener('unhandledrejection', event => { window.rendererErrors.push(String(event.reason)); }); window.rendererErrors = []; app.connection = {id:'test', name:'Mock', host:'localhost', port:3306, ssh:{enabled:false}}; app.database='test'; table='users'; app.tables=[{name:'users',type:'table'}]; mode='query'; renderQueryView();");

  await check('formatter button is bound after rendering', async () => {
    assert.equal(await evaluate("$('#sql').value='select 1'; $('#formatSqlBtn').click(); $('#sql').value"), 'SELECT 1');
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
    assert.equal(await evaluate("Boolean($('#queryResult .explain-badge.bad'))"), true);
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
    assert.equal(await evaluate("(singleQueryResultHtml({kind:'rows',isExplain:true,columns:[{name:'table'},{name:'type'}],rows:[['ALL','ALL']],durationMs:1}).match(/explain-badge bad/g)||[]).length"), 1);
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
    assert.match(await evaluate("$('#modal').textContent"), /bộ lọc “Alice”/);
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
  await check('backup includes routines, events and the strip-DEFINER option', async () => {
    const before = calls.filter((call) => call.name === 'db:backup').length;
    await evaluate('backupDatabase()');
    await until("Boolean(document.querySelector('#backupRoutineList .backup-routine'))");
    await until("Boolean(document.querySelector('#backupEventList .backup-event'))");
    assert.equal(await evaluate("document.querySelectorAll('#backupRoutineList .backup-routine').length"), 2);
    assert.equal(await evaluate("document.querySelectorAll('#backupEventList .backup-event').length"), 1);
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
    await until("$('#modal').textContent.includes('Sao lưu hoàn tất')");
    assert.match(await evaluate("$('#modal').textContent"), /1 procedure, 1 function, 1 event/);
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
