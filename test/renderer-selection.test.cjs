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

test('DEFAULT/generated report is bounded, escapes identifiers and never renders values, expressions or individual digests', () => {
  const r = setup();
  r.context.expressionReport = { version: 1, totals: { observed: 201, unknown: 0 }, findings: [], truncated: true,
    requires: ['TARGET_DEFAULT_VALUES_NOT_VALIDATED', 'TARGET_GENERATED_VALUES_NOT_VALIDATED'],
    rows: Array.from({ length: 200 }, () => ({ table: '<img src=table>', column: '<img src=column>', status: 'metadata-observed',
      defaultStatus: 'observed', generatedStatus: 'observed', defaultValue: 'private-default', expression: 'private-expression', defaultDigest: 'a'.repeat(64) })) };
  const html = r.evaluate('backupSelectionTargetExpressionsHtml(expressionReport)');
  assert.match(html, /201 cột có metadata đã quan sát/); assert.match(html, /100 cột/); assert.match(html, /&lt;img/);
  assert.match(html, /chưa đối chiếu DEFAULT\/generated nguồn và đích/); assert.equal((html.match(/<tr><td>/g) || []).length, 100);
  for (const value of ['<img', '<button', 'private-default', 'private-expression', 'a'.repeat(64)]) assert.equal(html.includes(value), false);
  r.context.expressionReport.rows = [{ table: 'items', column: 'v', defaultStatus: 'null-metadata', generatedStatus: 'not-reported', status: 'metadata-observed' }];
  const missing = r.evaluate('backupSelectionTargetExpressionsHtml(expressionReport)');
  assert.match(missing, /NULL trong metadata; chưa kết luận không có DEFAULT/); assert.match(missing, /Không có biểu thức được công bố/);
  assert.match(r.evaluate('backupSelectionTargetExpressionsHtml({version:0})'), /cần kiểm tra lại đích/);
});

test('trigger report is bounded, escapes names and never renders expressions, accounts or individual digests', () => {
  const r = setup();
  r.context.triggerReport = { version: 1, totals: { observed: 201, unknown: 0, insert: 201 }, findings: ['TARGET_TRIGGERS_REQUIRE_REVIEW'],
    requires: ['TARGET_TRIGGER_EFFECTS_NOT_VALIDATED', 'TARGET_TRIGGER_VISIBILITY_NOT_PROVEN'], truncated: true,
    rows: Array.from({ length: 200 }, () => ({ name: '<img src=trigger>', table: '<img src=table>', event: 'INSERT', timing: 'BEFORE', actionOrder: 1,
      definitionObserved: true, contextObserved: true, reason: 'TARGET_TRIGGER_EFFECTS_NOT_VALIDATED', actionDigest: 'a'.repeat(64), contextDigest: 'b'.repeat(64), body: 'private-body', definer: 'private-account' })) };
  const html = r.evaluate('backupSelectionTargetTriggersHtml(triggerReport)');
  assert.match(html, /201 định nghĩa quan sát được/); assert.match(html, /BEFORE INSERT/); assert.match(html, /Chưa thấy không chứng minh/);
  assert.match(html, /100 trigger/); assert.match(html, /&lt;img/); assert.equal((html.match(/<tr><td>/g) || []).length, 100);
  for (const value of ['<img', '<button', 'private-body', 'private-account', 'a'.repeat(64), 'b'.repeat(64)]) assert.equal(html.includes(value), false);
  assert.match(r.evaluate('backupSelectionTargetTriggersHtml({version:0})'), /cần kiểm tra lại metadata/);
});

test('target engine report is bounded, escapes names, treats legacy/missing observations as unknown and grants no rollback guarantee', () => {
  const r = setup();
  r.context.engineRows = Array.from({ length: 101 }, () => ({ name: '<img src=engine>', engineReview: { version: 1, status: 'observed', engine: 'MyISAM', reason: 'TARGET_ENGINE_UNSUPPORTED', privateValue: 'private-value' } }));
  const html = r.evaluate('backupSelectionTargetEnginesHtml(engineRows)');
  assert.match(html, /Storage engine bảng đích/); assert.match(html, /InnoDB chưa bảo đảm rollback toàn bộ/); assert.match(html, /MyISAM/);
  assert.match(html, /100 bảng/); assert.match(html, /&lt;img/); assert.equal((html.match(/<tr><td>/g) || []).length, 100);
  assert.equal(html.includes('<img'), false); assert.equal(html.includes('<button'), false); assert.equal(html.includes('private-value'), false);
  for (const profile of [undefined, { version: 0, status: 'observed', engine: 'InnoDB' }, { version: 1, status: 'unknown', engine: 'InnoDB' }]) {
    r.context.engineRows = [{ name: 'items', engineReview: profile }];
    assert.match(r.evaluate('backupSelectionTargetEnginesHtml(engineRows)'), /Chưa đủ metadata engine/);
  }
});

test('target CHECK report escapes names, bounds detail and never displays expressions or write controls', () => {
  const r = setup();
  r.context.checks = { version: 1, totals: { observed: 201, unknown: 0 }, findings: ['TARGET_CHECK_DATA_NOT_VALIDATED'],
    requires: ['TARGET_CHECK_EXPRESSION_NOT_EVALUATED', 'TARGET_CHECK_SESSION_NOT_REVIEWED'], truncated: true,
    rows: Array.from({ length: 200 }, () => ({ table: '<img src=table>', name: '<img src=check>', clauseObserved: true,
      declaredEnforcement: 'yes', reason: 'TARGET_CHECK_DATA_NOT_VALIDATED', expression: 'private-expression', clauseDigest: 'c'.repeat(64) })) };
  const html = r.evaluate('backupSelectionTargetChecksHtml(checks)');
  assert.match(html, /201 định nghĩa quan sát được/); assert.match(html, /100 CHECK/); assert.match(html, /chưa kiểm chứng dữ liệu phục hồi/);
  assert.match(html, /ENFORCED chỉ là metadata/); assert.match(html, /YES \(metadata\)/); assert.match(html, /&lt;img/);
  assert.equal((html.match(/<tr><td>/g) || []).length, 100); assert.equal(html.includes('<img'), false); assert.equal(html.includes('<button'), false);
  assert.equal(html.includes('private-expression'), false); assert.equal(html.includes('c'.repeat(64)), false);
  assert.match(r.evaluate('backupSelectionTargetChecksHtml({version:0})'), /cần kiểm tra lại metadata/);
});

test('CHECK v2 displays session state separately from ENFORCED; legacy and malformed observations remain unknown', () => {
  const r = setup();
  r.context.checks = { version: 2, totals: { observed: 0, unknown: 0 }, findings: ['TARGET_CHECK_SESSION_DISABLED'], requires: [], truncated: false, rows: [],
    sessionSettings: { version: 1, status: 'observed', enabled: false, reason: 'TARGET_CHECK_SESSION_OBSERVED' } };
  const disabled = r.evaluate('backupSelectionTargetChecksHtml(checks)');
  assert.match(disabled, /check_constraint_checks của phiên kiểm tra: tắt/); assert.match(disabled, /Phiên đích đang tắt check_constraint_checks/);
  assert.match(disabled, /Trạng thái bật không chứng minh dữ liệu thỏa CHECK/); assert.equal(disabled.includes('<button'), false);
  r.context.checks.sessionSettings.enabled = true;
  assert.match(r.evaluate('backupSelectionTargetChecksHtml(checks)'), /check_constraint_checks của phiên kiểm tra: bật/);
  r.context.checks.sessionSettings.status = 'unknown';
  assert.match(r.evaluate('backupSelectionTargetChecksHtml(checks)'), /check_constraint_checks của phiên kiểm tra: chưa xác định/);
  r.context.checks.sessionSettings.status = 'observed'; r.context.checks.version = 1;
  assert.match(r.evaluate('backupSelectionTargetChecksHtml(checks)'), /check_constraint_checks của phiên kiểm tra: chưa xác định/);
});

test('packet report escapes names, bounds detail and never represents within-limit as permission to restore', () => {
  const r = setup();
  r.context.packets = { version: 1, settings: { version: 1, maxAllowedPacket: 1024 },
    totals: { statements: 201, withinObserved: 0, oversized: 201, unknown: 0, excluded: 0 }, findings: ['PACKET_STATEMENT_TOO_LARGE'],
    requires: ['PACKET_CLIENT_PROTOCOL_NOT_VALIDATED'], truncated: true,
    rows: Array.from({ length: 200 }, (_, i) => ({ number: i + 1, command: 'INSERT', table: '<img src=table>', utf8Bytes: 1200, status: 'oversized', reason: 'PACKET_STATEMENT_TOO_LARGE' })) };
  const html = r.evaluate('backupSelectionPacketsHtml(packets)');
  assert.match(html, /max_allowed_packet/); assert.match(html, /không bảo đảm/i); assert.match(html, /100 câu đầu/);
  assert.match(html, /&lt;img/); assert.equal((html.match(/<tr><td>/g) || []).length, 100);
  assert.equal(html.includes('<img'), false); assert.equal(html.includes('<button'), false);
  assert.equal(r.evaluate('backupSelectionPacketsHtml({version:0})'), '');
});

test('temporal value report v5 describes calendar/precision risks without exposing dates or write controls', () => {
  const r = setup();
  r.context.values = { version: 5, totals: { statements: 1, basicChecked: 0, issues: 1, unknown: 0, excluded: 0 },
    findings: ['VALUE_BASIC_ISSUES'], requires: ['VALUE_FULL_VALIDATION_REQUIRED'], truncated: false,
    rows: [{ number: 2, table: '<img src=date>', status: 'issues', reasons: [], fields: [{ position: 1, column: '<img src=column>',
      sourceColumn: 'event_date', targetColumn: 'event_date', counts: { nulls: 0, integers: 0, other: 1, temporalStrings: 1 },
      source: { status: 'issues', findings: ['VALUE_TEMPORAL_INVALID_CALENDAR', 'VALUE_TEMPORAL_ZERO_REQUIRES_POLICY'] },
      target: { status: 'issues', findings: ['VALUE_TEMPORAL_PRECISION_LOSS', 'VALUE_TEMPORAL_INVALID_TIME'] } }] }] };
  const html = r.evaluate('backupSelectionValuesHtml(values)');
  assert.match(html, /lịch Gregorian/); assert.match(html, /phần lẻ giây không thể lưu nguyên vẹn/);
  assert.match(html, /Chuỗi ngày giờ đúng mẫu: 1/); assert.match(html, /cần chính sách riêng/);
  assert.match(html, /TIMESTAMP/); assert.match(html, /&lt;img/);
  assert.equal(html.includes('<img'), false); assert.equal(html.includes('<button'), false);
});

test('TIME report v6 describes signed durations and precision risks with no literal values or write action', () => {
  const r = setup();
  r.context.values = { version: 6, totals: { statements: 1, basicChecked: 0, issues: 1, unknown: 0, excluded: 0 },
    findings: ['VALUE_BASIC_ISSUES'], requires: ['VALUE_FULL_VALIDATION_REQUIRED'], truncated: false,
    rows: [{ number: 3, table: '<img src=time>', status: 'issues', reasons: [], fields: [{ position: 1, column: 'duration',
      sourceColumn: 'duration', targetColumn: 'duration', counts: { nulls: 0, integers: 0, other: 1, temporalStrings: 1 },
      source: { status: 'basic-checked', findings: [] }, target: { status: 'issues', findings: ['VALUE_TEMPORAL_PRECISION_LOSS'] } }] }] };
  const html = r.evaluate('backupSelectionValuesHtml(values)');
  assert.match(html, /TIME nhận thời lượng/); assert.match(html, /giờ trên 23 và dấu âm/);
  assert.match(html, /phần lẻ giây không thể lưu nguyên vẹn/); assert.match(html, /TIMESTAMP/);
  assert.match(html, /&lt;img/); assert.equal(html.includes('<img'), false); assert.equal(html.includes('<button'), false);
});

test('YEAR report v7 distinguishes zero/short-year conversion and range issues without raw values or write controls', () => {
  const r = setup();
  r.context.values = { version: 7, totals: { statements: 1, basicChecked: 0, issues: 1, unknown: 0, excluded: 0 },
    findings: ['VALUE_BASIC_ISSUES'], requires: ['VALUE_FULL_VALIDATION_REQUIRED'], truncated: false,
    rows: [{ number: 2, table: '<img src=year>', status: 'issues', reasons: [], fields: [{ position: 1, column: 'yr', sourceColumn: 'yr', targetColumn: 'yr',
      counts: { nulls: 0, integers: 1, other: 0, yearLiterals: 1 }, source: { status: 'unknown', findings: ['VALUE_YEAR_CONVERSION_NOT_REVIEWED'] },
      target: { status: 'issues', findings: ['VALUE_YEAR_OUT_OF_RANGE'] } }] }] };
  const html = r.evaluate('backupSelectionValuesHtml(values)');
  assert.match(html, /YEAR có giá trị rút gọn/); assert.match(html, /ngoài phạm vi YEAR/); assert.match(html, /Literal YEAR được phân loại: 1/);
  assert.match(html, /&lt;img/); assert.equal(html.includes('<img'), false); assert.equal(html.includes('<button'), false);
});

test('TIMESTAMP report v8 explains local checks and mandatory zone/range review without write controls', () => {
  const r = setup();
  r.context.values = { version: 8, totals: { statements: 1, basicChecked: 0, issues: 1, unknown: 0, excluded: 0 },
    findings: ['VALUE_BASIC_ISSUES'], requires: ['VALUE_FULL_VALIDATION_REQUIRED'], truncated: false,
    rows: [{ number: 2, table: '<img src=timestamp>', status: 'issues', reasons: [], fields: [{ position: 1, column: '<img src=column>',
      sourceColumn: 'ts', targetColumn: 'ts', counts: { nulls: 0, integers: 0, other: 1, temporalStrings: 1 },
      source: { status: 'unknown', findings: ['VALUE_TIMESTAMP_ZONE_RANGE_NOT_REVIEWED'] },
      target: { status: 'issues', findings: ['VALUE_TEMPORAL_PRECISION_LOSS', 'VALUE_TIMESTAMP_ZONE_RANGE_NOT_REVIEWED'] } }] }] };
  const html = r.evaluate('backupSelectionValuesHtml(values)');
  assert.match(html, /TIMESTAMP kiểm tra lịch và phần lẻ giây/); assert.match(html, /múi giờ nguồn\/đích, DST và phạm vi lưu của server/);
  assert.match(html, /Chuỗi ngày giờ đúng mẫu: 1/); assert.match(html, /phần lẻ giây không thể lưu nguyên vẹn/);
  assert.match(html, /&lt;img/); assert.equal(html.includes('<img'), false); assert.equal(html.includes('<button'), false);
});

test('omitted-column review escapes names, limits both sides and presents no default contents or write controls', () => {
  const r = setup();
  const side = { status: 'unknown', omittedCount: 4, findings: ['OMITTED_DEFAULT_VALUES_NOT_VALIDATED'],
    columns: Array.from({ length: 4 }, () => ({ name: '<img src=column>', invisible: true, code: 'OMITTED_DEFAULT_NOT_REVIEWED' })) };
  r.context.omitted = { version: 1, totals: { statements: 25, checked: 0, issues: 0, unknown: 25, excluded: 0 }, findings: [],
    requires: ['OMITTED_SERVER_RULES_NOT_VALIDATED'], truncated: false,
    rows: Array.from({ length: 25 }, (_, i) => ({ number: i + 1, table: '<img src=table>', status: 'unknown', reasons: ['<img src=reason>'], source: side, target: side })) };
  const html = r.evaluate('backupSelectionOmittedHtml(omitted)');
  assert.equal(html.includes('<img'), false); assert.equal(html.includes('<button'), false);
  assert.match(html, /&lt;img/); assert.match(html, /Có DEFAULT nhưng chưa kiểm chứng/); assert.match(html, /Invisible/);
  assert.match(html, /20 câu \/ 100 cột/);
  assert.equal((html.match(/<tr><td>/g) || []).length, 100);
  assert.equal(r.evaluate('backupSelectionOmittedHtml({version:0})'), '');
});

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

test('session policy v2 displays unique_checks on/off/unknown while legacy reports cannot assert it is enabled', () => {
  const r = setup();
  r.context.sessionReview = { version: 2, observations: { version: 2, foreignKeyChecks: true, uniqueChecks: false, autocommit: true,
    sqlMode: { flags: ['STRICT_TRANS_TABLES'], unreviewedCount: 0 } }, proposedMode: null,
    findings: [{ code: 'SESSION_UNIQUE_CHECKS_DISABLED' }], requires: ['SESSION_UNIQUE_DATA_NOT_VALIDATED', 'SESSION_UNIQUE_CHECKS_RECHECK_REQUIRED'],
    actions: [], lifecycle: ['verify-unique-checks-enabled'] };
  const disabled = r.evaluate('backupSelectionSessionPolicyHtml(sessionReview)');
  assert.match(disabled, /unique_checks tắt/); assert.match(disabled, /đang tắt unique_checks/);
  assert.match(disabled, /Bật unique_checks không chứng minh dữ liệu không trùng khóa/); assert.match(disabled, /đúng phiên trước khi ghi/);
  assert.equal(disabled.includes('<button'), false);
  r.context.sessionReview.observations.uniqueChecks = true;
  assert.match(r.evaluate('backupSelectionSessionPolicyHtml(sessionReview)'), /unique_checks bật/);
  r.context.sessionReview.observations.uniqueChecks = null;
  assert.match(r.evaluate('backupSelectionSessionPolicyHtml(sessionReview)'), /unique_checks chưa xác định/);
  r.context.sessionReview.version = 1; r.context.sessionReview.observations.uniqueChecks = true;
  assert.match(r.evaluate('backupSelectionSessionPolicyHtml(sessionReview)'), /unique_checks chưa xác định/);
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

test('two fresh target reviews compare metadata/source/plan and invalidated or failed requests discard the baseline', async () => {
  let answer, fail = false;
  const r = setup({ previewBackupSelectionTarget: async payload => {
    if (fail) throw new Error('fixture canceled');
    return ok({ ...response, checksum: answer.checksum, targetReview: { ...answer.targetReview, database: payload.targetDatabase, findings: [], rows: [] },
      draftPlan: { ...answer.draftPlan, sourceDatabase: payload.database, targetDatabase: payload.targetDatabase,
        selection: { tables: [...payload.tables], includeStructure: payload.includeStructure, includeData: payload.includeData }, conflictPolicyReview: { policy: payload.conflictPolicy } } });
  } });
  answer = { checksum: 'a'.repeat(64), targetReview: { version: 15, canExecute: false, metadataId: 'b'.repeat(64), snapshotId: 'c'.repeat(64), checkedAt: '2026-11-16T00:00:00Z' },
    draftPlan: { version: 28, canExecute: false, checksum: 'a'.repeat(64), targetSnapshotId: 'c'.repeat(64), planId: 'd'.repeat(64) } };
  r.evaluate('backupSelectionDraftHtml=()=>\'\''); await r.ready;
  const html = () => r.get('#backupSelectionResult').innerHTML;
  await r.click('#reviewBackupSelectionTarget'); assert.match(html(), /Đã ghi nhận mốc so sánh/);
  await r.click('#reviewBackupSelectionTarget'); assert.match(html(), /Chưa thấy thay đổi trong tệp và metadata/);
  answer.targetReview.metadataId = 'e'.repeat(64); answer.targetReview.snapshotId = answer.draftPlan.targetSnapshotId = 'f'.repeat(64); answer.draftPlan.planId = 'e'.repeat(64);
  await r.click('#reviewBackupSelectionTarget'); assert.match(html(), /Có thay đổi kể từ lần/); assert.match(html(), /Metadata\/ngữ cảnh đích đã quan sát: đã thay đổi/);
  assert.match(html(), /Tệp backup: chưa thấy thay đổi/); assert.match(html(), /không theo dõi dữ liệu dòng/);
  answer.checksum = answer.draftPlan.checksum = 'f'.repeat(64); answer.targetReview.snapshotId = answer.draftPlan.targetSnapshotId = 'a'.repeat(64); answer.draftPlan.planId = 'b'.repeat(64);
  await r.click('#reviewBackupSelectionTarget'); assert.match(html(), /Tệp backup: đã thay đổi/);
  r.get('#selectionTargetDatabase').listeners.input(); await r.click('#reviewBackupSelectionTarget'); assert.match(html(), /Đã ghi nhận mốc so sánh/);
  r.get('#backupSelectionForm').listeners.change(); await r.click('#reviewBackupSelectionTarget'); assert.match(html(), /Đã ghi nhận mốc so sánh/);
  fail = true; await r.click('#reviewBackupSelectionTarget'); fail = false;
  await r.click('#reviewBackupSelectionTarget'); assert.match(html(), /Đã ghi nhận mốc so sánh/);
  await r.click('#previewBackupSelection'); await r.click('#reviewBackupSelectionTarget'); assert.match(html(), /Đã ghi nhận mốc so sánh/);
});

test('drift report text is bounded to known statuses and contains no identities, HTML or write controls', () => {
  const r = setup();
  r.context.drift = { version: 1, status: '<img src=x>', sourceChanged: false, metadataChanged: false, planChanged: false, sql: 'private-query', token: 'private-token' };
  const html = r.evaluate('backupSelectionDriftHtml(drift)');
  assert.match(html, /Chưa đủ thông tin để so sánh/);
  for (const value of ['<img', '<button', 'private-query', 'private-token']) assert.equal(html.includes(value), false);
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
