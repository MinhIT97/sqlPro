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
  for (const selector of ['#backupSelectionEditor', '#backupSelectionStatus', '#backupSelectionForm', '#backupSelectionTables', '#backupSelectionResult', '#previewBackupSelection', '#reviewBackupSelectionTarget', '#selectionTargetDatabase', '#selectionConflictPolicy', '#cancelSelectionScan', '#selectionStructure', '#selectionData']) {
    elements.set(selector, { value: 'demo', innerHTML: '', textContent: '', disabled: false, hidden: false, checked: true,
      listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; } });
  }
  elements.get('#selectionConflictPolicy').value = 'stop-on-conflict';
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

test('value review HTML escapes names and reasons, limits detail and offers no execution controls', () => {
  const r = setup();
  r.context.values = { version: 1, totals: { statements: 25, basicChecked: 0, issues: 25, unknown: 0, excluded: 0 },
    findings: ['VALUE_BASIC_ISSUES'], requires: ['VALUE_FULL_VALIDATION_REQUIRED'], truncated: false,
    rows: Array.from({ length: 25 }, (_, index) => ({ number: index + 1, table: '<img src=table>', status: 'issues', reasons: ['<img src=reason>'],
      fields: [{ position: 1, column: '<img src=column>', sourceColumn: '<img src=source>', targetColumn: '<img src=target>',
        counts: { nulls: 1, integers: 0, other: 0 }, source: { status: 'issues', findings: ['VALUE_NULL_NOT_ALLOWED'] },
        target: { status: 'unknown', findings: ['<img src=finding>'] } }] })) };
  const html = r.evaluate('backupSelectionValuesHtml(values)');
  assert.equal(html.includes('<img'), false); assert.equal(html.includes('<button'), false);
  assert.match(html, /&lt;img/); assert.match(html, /Có NULL/); assert.match(html, /tối đa 20 câu/);
  assert.equal((html.match(/<table>/g) || []).length, 20); assert.equal(r.evaluate('backupSelectionValuesHtml({version:0})'), '');
});

test('decimal value review v2 shows scale-loss and unsigned findings without raw literals or write controls', () => {
  const r = setup();
  r.context.values = { version: 2, totals: { statements: 1, basicChecked: 0, issues: 1, unknown: 0, excluded: 0 },
    findings: ['VALUE_BASIC_ISSUES'], requires: ['VALUE_FULL_VALIDATION_REQUIRED'], truncated: false,
    rows: [{ number: 2, table: '<img src=decimal>', status: 'issues', reasons: [], fields: [{ position: 1, column: 'amount',
      sourceColumn: 'amount', targetColumn: 'amount', counts: { nulls: 0, integers: 0, other: 1, fixedDecimals: 1 },
      source: { status: 'basic-checked', findings: [] }, target: { status: 'issues', findings: ['VALUE_DECIMAL_SCALE_LOSS', 'VALUE_DECIMAL_UNSIGNED_NEGATIVE'] } }] }] };
  const html = r.evaluate('backupSelectionValuesHtml(values)');
  assert.match(html, /không tự làm tròn/i); assert.match(html, /không thể lưu nguyên vẹn/); assert.match(html, /số âm/);
  assert.match(html, /1 DECIMAL cố định/); assert.match(html, /&lt;img/);
  assert.equal(html.includes('<img'), false); assert.equal(html.includes('<button'), false);
});

test('numeric-string report v3 explains the subset and displays counts without raw string contents or write actions', () => {
  const r = setup();
  r.context.values = { version: 3, totals: { statements: 1, basicChecked: 1, issues: 0, unknown: 0, excluded: 0 },
    findings: [], requires: ['VALUE_FULL_VALIDATION_REQUIRED'], truncated: false,
    rows: [{ number: 2, table: '<img src=numeric>', status: 'basic-checked', reasons: [], fields: [{ position: 1, column: 'amount',
      sourceColumn: 'amount', targetColumn: 'amount', counts: { nulls: 0, integers: 0, other: 3, fixedDecimals: 0, numericStrings: 3 },
      source: { status: 'basic-checked', findings: [] }, target: { status: 'basic-checked', findings: [] } }] }] };
  const html = r.evaluate('backupSelectionValuesHtml(values)');
  assert.match(html, /Chuỗi số đúng mẫu: 3/); assert.match(html, /tối đa 256 ký tự/); assert.match(html, /không tự làm tròn/i);
  assert.match(html, /&lt;img/); assert.match(html, /Vẫn cần kiểm chứng đầy đủ/);
  assert.equal(html.includes('<img'), false); assert.equal(html.includes('<button'), false);
});

test('text report v4 explains length/charset and CHAR findings while escaping names and hiding literal contents', () => {
  const r = setup();
  r.context.values = { version: 4, totals: { statements: 1, basicChecked: 0, issues: 1, unknown: 0, excluded: 0 },
    findings: ['VALUE_BASIC_ISSUES'], requires: ['VALUE_FULL_VALIDATION_REQUIRED'], truncated: false,
    rows: [{ number: 2, table: '<img src=text>', status: 'issues', reasons: [], fields: [{ position: 1, column: '<img src=column>',
      sourceColumn: 'title', targetColumn: 'title', counts: { nulls: 0, integers: 0, other: 1, fixedDecimals: 0, numericStrings: 0, text: 1 },
      source: { status: 'basic-checked', findings: [] }, target: { status: 'issues', findings: ['VALUE_TEXT_TOO_LONG', 'VALUE_TEXT_CHARSET_LOSS', 'VALUE_CHAR_TRAILING_SPACES'] } }] }] };
  const html = r.evaluate('backupSelectionValuesHtml(values)');
  assert.match(html, /Literal chuỗi: 1/); assert.match(html, /VARCHAR đếm ký tự Unicode/); assert.match(html, /không biểu diễn được/);
  assert.match(html, /khoảng trắng cuối/); assert.match(html, /&lt;img/);
  assert.equal(html.includes('<img'), false); assert.equal(html.includes('<button'), false);
});

test('session policy HTML escapes observations and proposals and exposes no execution controls', () => {
  const r = setup();
  r.context.sessionReview = { version: 1, observations: { foreignKeyChecks: false, autocommit: true,
    sqlMode: { flags: ['<img src=mode>'], unreviewedCount: 1 } }, proposedMode: { flags: ['<img src=proposed>'] },
    findings: [{ code: '<img src=finding>' }], requires: ['SESSION_CLEANUP_NOT_IMPLEMENTED'],
    actions: [{ number: 1, proposal: '<img src=action>' }], lifecycle: ['<img src=lifecycle>'] };
  const html = r.evaluate('backupSelectionSessionPolicyHtml(sessionReview)');
  assert.equal(html.includes('<img'), false); assert.equal(html.includes('<button'), false);
  assert.match(html, /&lt;img/); assert.match(html, /Chưa/);
  assert.equal(r.evaluate('backupSelectionSessionPolicyHtml({version:0})'), '');
});

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

test('changing conflict policy invalidates the pending report and the next target review sends the new choice', async () => {
  const payloads = []; let finish;
  const r = setup({ previewBackupSelectionTarget: payload => { payloads.push(payload); return new Promise(resolve => { finish = resolve; }); } });
  await r.ready;
  const first = r.click('#reviewBackupSelectionTarget');
  assert.equal(payloads[0].conflictPolicy, 'stop-on-conflict');
  r.get('#selectionConflictPolicy').value = 'skip-existing'; r.get('#backupSelectionForm').listeners.change();
  finish(ok(response)); await first;
  assert.equal(r.get('#backupSelectionResult').innerHTML, ''); assert.match(r.get('#backupSelectionStatus').textContent, /Lựa chọn đã đổi/);
  const second = r.click('#reviewBackupSelectionTarget');
  assert.equal(payloads[1].conflictPolicy, 'skip-existing'); finish(ok(response)); await second;
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

test('draft shows CREATE syntax counts separately, explains unsupported engines and preserves read-only actions', () => {
  const r = setup();
  r.context.plan = { statementCount: 2, targetDatabase: 'demo', planId: 'a'.repeat(64), createSyntaxTotals: { matched: 1, unsupported: 1, notReviewed: 0 },
    totals: { candidate: 1, excluded: 0, blocked: 1, skipped: 0 }, blockers: [], steps: [
      { number: 1, command: 'CREATE', table: '<img src=x>', decision: 'candidate', reason: 'BASIC_CREATE_MATCHED', syntaxReview: { status: 'matched', columns: 2, indexes: 1 } },
      { number: 2, command: 'CREATE', table: 'other', decision: 'blocked', reason: 'CREATE_ENGINE_UNSUPPORTED', syntaxReview: { status: 'unsupported', code: 'CREATE_ENGINE_UNSUPPORTED' } }
    ] };
  const html = r.evaluate('backupSelectionDraftHtml(plan)');
  assert.match(html, /CREATE trong lựa chọn: 1 khớp cú pháp cơ bản/);
  assert.match(html, /CREATE TABLE cơ bản · 2 cột · 1 chỉ mục · InnoDB/);
  assert.match(html, /chỉ hỗ trợ ENGINE=InnoDB/); assert.match(html, /Chưa xác nhận quyền/);
  assert.equal(html.includes('INSERT literal'), false); assert.equal(html.includes('NaN'), false);
  assert.equal(html.includes('<img'), false); assert.equal(html.includes('<button'), false);
});

test('draft shows session context for the whole file and keeps recognized SET blocked by session policy', () => {
  const r = setup();
  r.context.plan = { statementCount: 2, targetDatabase: 'demo', planId: 'a'.repeat(64),
    totals: { candidate: 0, excluded: 0, blocked: 2, skipped: 0 },
    sessionContextReview: { total: 2, matched: 1, unsupported: 1, notReviewed: 0, sequenceMatched: false },
    blockers: [{ code: 'CONTEXT_SETTINGS_NOT_RESTORED' }, { code: 'CONTEXT_FOREIGN_KEYS_RECHECK_REQUIRED' }], steps: [
      { number: 1, command: 'SET', decision: 'blocked', reason: 'DUMP_CONTEXT_REQUIRES_POLICY', contextReview: { status: 'matched', action: 'save-disable-foreign-keys' } },
      { number: 2, command: 'SET', decision: 'blocked', reason: '<img src=x>', contextReview: { status: 'unsupported', code: '<img src=x>' } }
    ] };
  const html = r.evaluate('backupSelectionDraftHtml(plan)');
  assert.match(html, /Thiết lập session toàn tệp: 1 khớp mẫu dump/); assert.match(html, /Trình tự lưu\/khôi phục: cần kiểm tra/);
  assert.match(html, /Lưu và tạm tắt kiểm tra FK/); assert.match(html, /Thiếu bước khôi phục/);
  assert.match(html, /cần chính sách phiên riêng/); assert.match(html, /không xác nhận dữ liệu đã hợp lệ/);
  assert.equal(html.includes('<img'), false); assert.equal(html.includes('<button'), false);
});

test('conflict policy HTML escapes observations and explains skip/unknown without offering writes', () => {
  const r = setup();
  r.context.policyReview = { policy: 'skip-existing', totals: { review: 1, skip: 1, blocked: 1 }, rows: [
    { name: '<img src=x>', observed: 'table', disposition: 'skip', proposal: 'skip-table', reason: 'POLICY_SKIP_EXISTING_TABLE', requires: [] },
    { name: 'missing', observed: 'not-seen', disposition: 'review', proposal: 'create-table', reason: 'POLICY_CREATE_REQUIRES_REVIEW', requires: ['POLICY_ABSENCE_NOT_PROVEN'] },
    { name: 'view', observed: 'view', disposition: 'blocked', proposal: null, reason: 'POLICY_VIEW_CONFLICT', requires: [] }
  ] };
  const html = r.evaluate('backupSelectionConflictPolicyHtml(policyReview)');
  assert.match(html, /Bỏ qua cả cấu trúc\/dữ liệu/); assert.match(html, /chưa chứng minh đối tượng không tồn tại/);
  assert.match(html, /không thay hoặc tự bỏ qua view/); assert.equal(html.includes('<img'), false); assert.equal(html.includes('<button'), false);
  r.context.policyReview.rows = Array(101).fill(r.context.policyReview.rows[0]);
  assert.match(r.evaluate('backupSelectionConflictPolicyHtml(policyReview)'), /Chỉ hiện 100 bảng/);
});

test('source FK report escapes names/pairs/actions, distinguishes skipped parents and never offers execution', () => {
  const r = setup();
  r.context.fkReport = { rows: [{ table: '<img src=x>', name: '<img src=fk>', referencedSchema: 'demo', referencedTable: '<img src=parent>',
    pairs: [{ column: '<img src=c>', referencedColumn: '<img src=r>' }], onDelete: 'SET NULL', onUpdate: 'CASCADE', status: 'blocked', reason: 'FK_PARENT_SKIPPED', requires: [] }],
    totals: { review: 0, blocked: 1, excluded: 0 }, tablesNotReviewed: 0, findings: [], truncated: false };
  const html = r.evaluate('backupSelectionForeignKeysHtml(fkReport)');
  assert.match(html, /Khóa ngoại nguồn · 1 định nghĩa/); assert.match(html, /DELETE: SET NULL/); assert.match(html, /UPDATE: CASCADE/);
  assert.match(html, /Bảng được tham chiếu bị bỏ qua/); assert.match(html, /chưa xác nhận chỉ mục ở đích/);
  assert.equal(html.includes('<img'), false); assert.equal(html.includes('<button'), false);
  r.context.fkReport.rows = Array(101).fill(r.context.fkReport.rows[0]); r.context.fkReport.truncated = true;
  assert.match(r.evaluate('backupSelectionForeignKeysHtml(fkReport)'), /chỉ hiện 100 định nghĩa/);
});


test('source FK HTML shows matched source key with escaped names and retains data/server caveats', () => {
  const r = setup();
  r.context.fkReport = { rows: [{ table: 'child', name: 'fk', referencedTable: 'parent', pairs: [{ column: 'pid', referencedColumn: 'id' }],
    status: 'review', reason: 'FK_DEFINITION_REQUIRES_REVIEW', requires: ['FK_DATA_NOT_CHECKED', 'FK_SERVER_RULES_NOT_VALIDATED'],
    referencedIndexReview: { status: 'matched', kind: 'unique', name: '<img src=key>', columns: ['<img src=col>'] } }],
    totals: { review: 1, blocked: 0, excluded: 0 }, tablesNotReviewed: 0, findings: [], truncated: false };
  const html = r.evaluate('backupSelectionForeignKeysHtml(fkReport)');
  assert.match(html, /Khóa nguồn: UNIQUE KEY &lt;img/); assert.match(html, /Chưa kiểm tra dòng mồ côi/);
  assert.match(html, /Chưa xác nhận quy tắc FK/); assert.equal(html.includes('<img'), false); assert.equal(html.includes('<button'), false);
});

test('target index HTML displays ordered prefix/direction observations, limits and unknown definitions with escaped names', () => {
  const r = setup();
  r.context.indexRow = { name: '<img src=table>', indexReview: { definitionCount: 51, truncated: true,
    findings: ['TARGET_INDEX_DEFINITION_UNSUPPORTED', 'TARGET_INDEX_REVIEW_LIMIT'], indexes: [
      { name: '<img src=index>', kind: 'unique', type: 'BTREE', supported: true, columns: [{ name: '<img src=column>', prefixLength: 10, direction: 'A' }] },
      { name: 'descending', kind: 'index', type: 'BTREE', supported: false, visibility: 'invisible', columns: [{ name: 'id', prefixLength: null, direction: 'D' }] },
      { name: 'expression', kind: 'index', type: 'BTREE', supported: false, columns: [{ name: null, prefixLength: null, direction: null }] }
    ] } };
  const html = r.evaluate('backupSelectionTargetIndexesHtml(indexRow)');
  assert.match(html, /3\/51 định nghĩa/); assert.match(html, /\(10\) ASC/); assert.match(html, /id DESC/); assert.match(html, /Invisible \(optimizer\)/);
  assert.match(html, /Cột\/biểu thức chưa nhận diện/); assert.match(html, /invisible\/ignored/); assert.match(html, /cần giảm phạm vi chọn/);
  assert.equal(html.includes('<img'), false); assert.equal(html.includes('<button'), false);
});

test('target key observations on skipped parent HTML retain the blocked reason and visibility/data caveats', () => {
  const r = setup();
  r.context.fkReport = { rows: [{ table: 'child', name: 'fk', referencedTable: 'parent', pairs: [{ column: 'pid', referencedColumn: 'id' }],
    status: 'blocked', reason: 'FK_PARENT_SKIPPED', requires: [], targetReferencedIndexReview: { status: 'observed-match', code: 'FK_TARGET_UNIQUE_KEY_OBSERVED', name: '<img src=key>', columns: ['<img src=col>'] } }],
    totals: { review: 0, blocked: 1, excluded: 0 }, tablesNotReviewed: 0, findings: [], truncated: false };
  const html = r.evaluate('backupSelectionForeignKeysHtml(fkReport)');
  assert.match(html, /Bảng được tham chiếu bị bỏ qua/); assert.match(html, /Thấy PRIMARY\/UNIQUE KEY đích khớp/);
  assert.match(html, /chưa xác nhận dữ liệu hoặc quy tắc server/); assert.equal(html.includes('<img'), false); assert.equal(html.includes('<button'), false);
  Object.assign(r.context.fkReport.rows[0].targetReferencedIndexReview, { status: 'requires-review', code: 'FK_TARGET_KEY_INVISIBLE_OR_IGNORED', visibility: 'invisible' });
  const hidden = r.evaluate('backupSelectionForeignKeysHtml(fkReport)');
  assert.match(hidden, /Bảng được tham chiếu bị bỏ qua/); assert.match(hidden, /đang Invisible\/IGNORED/); assert.match(hidden, /Invisible \(optimizer\)/);
  assert.equal(hidden.includes('<img'), false);
});

test('grouped target FK HTML shows ordered composite pairs, actions, inbound scope and limits without allowing writes', () => {
  const r = setup();
  r.context.targetFK = { version: 1, definitionCount: 201, pairCount: 402, totals: { observed: 200, unknown: 1 }, findings: [{ code: 'TARGET_FK_ACTIONS_INCONSISTENT', table: '<img src=t>' }], truncated: true,
    rows: [{ name: '<img src=fk>', tableSchema: 'other', table: '<img src=child>', referencedSchema: 'demo', referencedTable: '<img src=parent>',
      pairs: [{ ordinal: 1, column: '<img src=c1>', referencedColumn: 'a' }, { ordinal: 2, column: 'pb', referencedColumn: '<img src=c2>' }], pairCount: 2,
      onDelete: 'SET NULL', onUpdate: 'CASCADE', match: 'NONE', relation: 'inbound', reason: 'TARGET_FK_DEFINITION_OBSERVED' }] };
  const html = r.evaluate('backupSelectionTargetForeignKeysHtml(targetFK)');
  assert.match(html, /201 định nghĩa · 402 cặp cột/); assert.match(html, /1: &lt;img/); assert.match(html, /2: pb/);
  assert.match(html, /DELETE: SET NULL/); assert.match(html, /UPDATE: CASCADE/); assert.match(html, /Bảng ngoài lựa chọn tham chiếu vào/);
  assert.match(html, /không nhất quán/); assert.match(html, /chưa thấy FK không chứng minh không tồn tại/); assert.match(html, /Hiện tối đa 100/);
  assert.equal(html.includes('<img'), false); assert.equal(html.includes('<button'), false);
  r.context.targetFK.rows[0].onDelete = null;
  assert.match(r.evaluate('backupSelectionTargetForeignKeysHtml(targetFK)'), /DELETE: Chưa xác định/);
  r.context.targetFK.version = 0;
  assert.match(r.evaluate('backupSelectionTargetForeignKeysHtml(targetFK)'), /cần kiểm tra lại metadata/);
});

test('source/target FK comparison HTML escapes both definitions and reports differences and remaining checks', () => {
  const r = setup();
  const definition = { table: '<img src=t>', name: '<img src=fk>', referencedSchema: 'demo', referencedTable: '<img src=p>',
    pairs: [{ column: '<img src=c>', referencedColumn: 'id' }], onDelete: null, onUpdate: 'CASCADE' };
  r.context.comparison = { version: 1, totals: { matched: 0, differs: 1, unknown: 1, notObserved: 0, targetOnly: 0, notApplicable: 0 },
    findings: [{ code: 'FK_COMPARE_TARGET_INCOMPLETE' }], truncated: true,
    rows: [{ source: definition, target: { ...definition, onDelete: 'RESTRICT' }, reason: 'FK_COMPARE_DEFINITION_DIFFERS', nameDiffers: true, differences: ['FK_COMPARE_DELETE_DIFFERS'] }] };
  const html = r.evaluate('backupSelectionForeignKeyComparisonHtml(comparison)');
  assert.match(html, /Đối chiếu FK nguồn \/ đích/); assert.match(html, /Khác ON DELETE/); assert.match(html, /Tên FK khác nhau/);
  assert.match(html, /DELETE: Không ghi rõ/); assert.match(html, /không gỡ các chặn/); assert.match(html, /không suy action mặc định/);
  assert.match(html, /tối đa 100 mục/); assert.equal(html.includes('<img'), false); assert.equal(html.includes('<button'), false);
});
