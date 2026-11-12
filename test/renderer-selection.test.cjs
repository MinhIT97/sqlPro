'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRenderer } = require('./helpers/renderer.cjs');
const ok = data => ({ ok: true, data });
const inventory = { version: 1, tables: [{ name: '<img src=x>' }, { name: 'parent' }], truncated: false };
const response = { rows: [{ name: '<img src=x>', createStatements: 1, dropStatements: 0, dataStatements: 2, dependencies: [{ schema: null, table: 'parent' }] }],
  totals: { createStatements: 1, dropStatements: 0, dataStatements: 2 }, checksum: 'abc', cached: true,
  excludedTables: 1, excludedDefinitions: 0, order: ['<img src=x>'], unresolvedOrder: [], findings: [{ code: 'MISSING_DEPENDENCY', table: '<img src=x>', dependency: 'parent' }] };

function setup(overrides = {}) {
  const elements = new Map();
  for (const selector of ['#backupSelectionEditor', '#backupSelectionStatus', '#backupSelectionForm', '#backupSelectionTables', '#backupSelectionResult', '#previewBackupSelection', '#reviewBackupSelectionTarget', '#selectionTargetDatabase', '#cancelSelectionScan', '#selectionStructure', '#selectionData']) {
    elements.set(selector, { value: 'demo', innerHTML: '', textContent: '', disabled: false, hidden: false, checked: true,
      listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; } });
  }
  const selected = [{ dataset: { selectionIndex: '0' }, focus() { this.focused = true; } }];
  elements.get('#backupSelectionTables').querySelectorAll = () => selected;
  elements.get('#backupSelectionTables').querySelector = () => selected[0];
  const calls = [], canceled = [];
  const r = loadRenderer({ elements, desktop: { db: {
    inspectBackup: async () => ok({ selectionPreview: inventory }),
    previewBackupSelection: async payload => { calls.push(payload); return ok(response); },
    cancelInspectBackup: async payload => { canceled.push(payload); return ok({ canceled: true }); }, ...overrides
  } } });
  r.evaluate("modal=()=>{};app.connection={id:'p1'};app.database='demo';app.selectedBackupId='fixture'");
  const ready = r.evaluate('showBackupSelectionPreview()');
  return { ...r, ready, calls, canceled, selected, get: selector => elements.get(selector), click: selector => elements.get(selector).listeners.click() };
}

test('selection preview captures scope, escapes names and sends selected tables with explicit flags', async () => {
  const r = setup(); await r.ready;
  assert.match(r.get('#backupSelectionTables').innerHTML, /&lt;img src=x&gt;/);
  assert.equal(r.selected[0].focused, true);
  r.get('#selectionStructure').checked = false;
  await r.click('#previewBackupSelection');
  assert.equal(r.calls[0].profileId, 'p1'); assert.equal(r.calls[0].database, 'demo'); assert.equal(r.calls[0].id, 'fixture');
  assert.equal(JSON.stringify(r.calls[0].tables), JSON.stringify(['<img src=x>']));
  assert.equal(r.calls[0].includeStructure, false); assert.equal(r.calls[0].includeData, true);
  assert.match(r.get('#backupSelectionResult').innerHTML, /Chưa chọn bảng/);
  assert.match(r.get('#backupSelectionResult').innerHTML, /&lt;img src=x&gt;/);
  assert.match(r.get('#backupSelectionResult').innerHTML, /Chưa có thao tác thực thi/);
  r.evaluate("app.selectedBackupId='other'"); await r.click('#previewBackupSelection'); assert.equal(r.calls.length, 1);
});

test('selection validation prevents empty scope and stale results after edit or replacement are ignored', async () => {
  let finish;
  const r = setup({ previewBackupSelection: () => new Promise(resolve => { finish = resolve; }) });
  await r.ready;
  r.get('#selectionStructure').checked = r.get('#selectionData').checked = false;
  await r.click('#previewBackupSelection'); assert.match(r.get('#backupSelectionStatus').textContent, /cấu trúc hoặc dữ liệu/);
  r.get('#selectionData').checked = true;
  const pending = r.click('#previewBackupSelection');
  await r.click('#previewBackupSelection');
  r.get('#backupSelectionForm').listeners.change();
  finish(ok(response)); await pending;
  assert.equal(r.get('#backupSelectionResult').innerHTML, '');
  assert.match(r.get('#backupSelectionStatus').textContent, /Lựa chọn đã đổi/);
  const second = r.click('#previewBackupSelection');
  r.elements.set('#backupSelectionEditor', { textContent: 'new dialog' });
  r.get('#backupSelectionStatus').textContent = 'keep';
  finish(ok(response)); await second;
  assert.equal(r.get('#backupSelectionStatus').textContent, 'keep');
});

test('initial scan supports captured cancellation and refuses late inventory after switching database', async () => {
  let finish;
  const r = setup({ inspectBackup: () => new Promise(resolve => { finish = resolve; }) });
  await r.click('#cancelSelectionScan');
  assert.equal(r.canceled[0].profileId, 'p1'); assert.match(r.canceled[0].taskId, /^inspect-selection-/);
  r.evaluate("app.database='different'");
  finish(ok({ selectionPreview: inventory })); await r.ready;
  assert.equal(r.get('#backupSelectionTables').innerHTML, '');
});

test('target review captures database, escapes metadata and target edits discard old observations', async () => {
  let finish, payload;
  const r = setup({ previewBackupSelectionTarget: request => { payload = request; return new Promise(resolve => { finish = resolve; }); } });
  await r.ready;
  r.get('#selectionTargetDatabase').value = 'destination';
  const pending = r.click('#reviewBackupSelectionTarget');
  assert.equal(payload.targetDatabase, 'destination'); assert.equal(payload.database, 'demo'); assert.equal(payload.id, 'fixture');
  assert.equal(r.get('#previewBackupSelection').disabled, true);
  r.get('#selectionTargetDatabase').value = 'changed'; r.get('#selectionTargetDatabase').listeners.input();
  finish(ok(response)); await pending;
  assert.equal(r.get('#backupSelectionResult').innerHTML, '');
  assert.match(r.get('#backupSelectionStatus').textContent, /Đích đã đổi/);
  const second = r.click('#reviewBackupSelectionTarget');
  finish(ok({ ...response, targetReview: { database: '<img src=x>', serverVersion: '8.4', checkedAt: '2026-11-12T00:00:00Z', snapshotId: 'a'.repeat(64),
    findings: [{ code: 'TARGET_STRUCTURE_CONFLICT', table: '<img src=x>' }], findingsTruncated: false, foreignKeys: [],
    rows: [{ name: '<img src=x>', objects: [{ name: '<img src=x>', type: 'view' }], triggers: [], objectCount: 1, triggerCount: 0 }] } }));
  await second;
  assert.match(r.get('#backupSelectionResult').innerHTML, /&lt;img src=x&gt;/);
  assert.match(r.get('#backupSelectionResult').innerHTML, /không phải quyền chạy/);
  assert.match(r.get('#backupSelectionStatus').textContent, /metadata đích một phần/);
});

test('target cancellation addresses its independent metadata task, not the SQL editor or source-only cancel API', async () => {
  let finish, canceled;
  const r = setup({ previewBackupSelectionTarget: () => new Promise(resolve => { finish = resolve; }),
    cancelTask: async (profileId, taskId) => { canceled = { profileId, taskId }; return ok({ canceled: true }); }
  });
  await r.ready;
  const pending = r.click('#reviewBackupSelectionTarget');
  await r.click('#cancelSelectionScan');
  assert.equal(canceled.profileId, 'p1'); assert.match(canceled.taskId, /^inspect-selection-/);
  assert.equal(r.canceled.length, 0);
  finish({ ok: false, error: { message: 'Đã hủy kiểm tra đích.' } }); await pending;
  assert.equal(r.get('#reviewBackupSelectionTarget').disabled, false);
});

test('late cancel success/error cannot replace completed or newer preview status and controls', async () => {
  for (const fails of [false, true]) {
    let finishPreview, finishCancel;
    const r = setup({ previewBackupSelectionTarget: () => new Promise(resolve => { finishPreview = resolve; }),
      cancelTask: () => new Promise((resolve, reject) => { finishCancel = () => fails ? reject(new Error('old cancel error')) : resolve(ok({ canceled: true })); }) });
    await r.ready;
    const first = r.click('#reviewBackupSelectionTarget');
    const canceled = r.click('#cancelSelectionScan');
    finishPreview(ok(response)); await first;
    const next = r.click('#reviewBackupSelectionTarget');
    const status = r.get('#backupSelectionStatus').textContent;
    r.get('#cancelSelectionScan').disabled = true;
    finishCancel(); await canceled;
    assert.equal(r.get('#backupSelectionStatus').textContent, status);
    assert.equal(r.get('#cancelSelectionScan').disabled, true);
    finishPreview(ok(response)); await next;
  }
});

test('column comparison HTML escapes column names and reports precision/positional/generated limitations', () => {
  const r = setup();
  r.context.columnRow = { name: '<img src=table>', columnReview: { status: 'partial', sourceColumnCount: 1, targetColumnCount: 2, truncated: true,
    findings: [{ code: 'POSITIONAL_COLUMN_ORDER_OR_COUNT_DIFFERS' }, { code: 'GENERATED_EXPRESSION_NOT_COMPARED', column: '<img src=column>' }],
    fields: [{ name: '<img src=column>', sourceType: 'decimal(20,6)', targetType: 'decimal(10,2)', differences: ['COLUMN_TYPE_DIFFERS'] }] } };
  const html = r.evaluate('backupSelectionColumnsHtml(columnRow)');
  assert.equal(html.includes('<img'), false); assert.match(html, /&lt;img/);
  assert.match(html, /Thứ tự hoặc số cột/); assert.match(html, /Chưa đối chiếu biểu thức generated/); assert.match(html, /precision khác nhau/);
  assert.match(html, /ngoài giới hạn/);
});

test('draft HTML escapes steps and blockers, shows review-only status and truncated limits', () => {
  const r = setup();
  r.context.plan = { statementCount: 300, targetDatabase: '<img src=db>', planId: 'a'.repeat(64),
    totals: { candidate: 200, excluded: 20, blocked: 79, skipped: 1 }, stepsTruncated: true, blockersTruncated: true,
    blockers: [{ code: 'DESTRUCTIVE_POLICY_REQUIRED', table: '<img src=table>', detail: '#5' }],
    steps: [{ number: 5, command: 'DROP', table: '<img src=table>', schema: null, decision: 'blocked', reason: 'DESTRUCTIVE_POLICY_REQUIRED' }] };
  const html = r.evaluate('backupSelectionDraftHtml(plan)');
  assert.equal(html.includes('<img'), false); assert.match(html, /&lt;img/);
  assert.match(html, /Chưa thể thực thi/); assert.match(html, /DROP cần chính sách/); assert.match(html, /200 câu lệnh/);
  assert.match(html, /ngoài giới hạn 100/); assert.equal(html.includes('<button'), false);
});

test('draft distinguishes literal syntax recognition from unsupported INSERT and write compatibility', () => {
  const r = setup();
  r.context.plan = { statementCount: 2, targetDatabase: 'demo', planId: 'a'.repeat(64), syntaxTotals: { matched: 1, unsupported: 1, notReviewed: 0 },
    totals: { candidate: 1, excluded: 0, blocked: 1, skipped: 0 }, stepsTruncated: false, blockersTruncated: false, blockers: [], steps: [
      { number: 1, command: 'INSERT', table: '<img src=x>', decision: 'candidate', reason: 'LITERAL_INSERT_MATCHED', syntaxReview: { status: 'matched', rows: 2, valuesPerRow: 3 } },
      { number: 2, command: 'INSERT', table: 'demo', decision: 'blocked', reason: 'INSERT_VALUE_EXPRESSION', syntaxReview: { status: 'unsupported', code: 'INSERT_VALUE_EXPRESSION' } }
    ] };
  const html = r.evaluate('backupSelectionDraftHtml(plan)');
  assert.match(html, /1 khớp cú pháp literal/); assert.match(html, /2 bộ VALUES × 3 giá trị/);
  assert.match(html, /biểu thức hoặc cú pháp chưa hỗ trợ/); assert.match(html, /chưa xác nhận chuyển đổi giá trị/);
  assert.equal(html.includes('<img'), false); assert.equal(html.includes('<button'), false);
});
