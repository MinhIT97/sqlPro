'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewExplain, explainAccess, explainDocument, explainFormat } = require('../query-results.js');
const { loadRenderer } = require('./helpers/renderer.cjs');
const result = (rows, names = ['table', 'type', 'key', 'rows', 'filtered', 'Extra']) => ({
  kind: 'rows', isExplain: true, columns: names.map(name => ({ name })), rows, durationMs: 1
});

test('EXPLAIN review preserves per-step estimates and neutral signals without changing source data', () => {
  const input = result([['small', 'ALL', null, '5', '80.50', 'Using where; Using filesort; Using temporary'],
    ['joined', 'ref', 'idx_parent', 1200, 5, 'Using index'], ['cover', 'index', 'idx_cover', 0, 0, null]]);
  const before = structuredClone(input), report = reviewExplain(input);
  assert.equal(report.version, 1); assert.equal(report.truncated, false);
  assert.deepEqual(report.rows[0], { number: 1, table: 'small', access: 'ALL', key: null, estimatedRows: 5,
    filteredPercent: 80.5, signals: ['FULL_TABLE_SCAN', 'FILESORT', 'TEMPORARY_TABLE'] });
  assert.equal(report.rows[1].estimatedRows, 1200); assert.deepEqual(report.rows[1].signals, []);
  assert.equal(report.rows[2].filteredPercent, 0); assert.deepEqual(report.rows[2].signals, ['FULL_INDEX_SCAN']);
  assert.deepEqual(input, before); assert.equal(Object.hasOwn(report, 'totalRows'), false);
  assert.equal(Object.hasOwn(report, 'durationMs'), false);
  for (const value of ['ALL', 'index', 'RANGE', 'const', 'eq_ref', 'ref']) {
    const access = explainAccess(value); assert.ok(['info', 'warn'].includes(access.tone)); assert.ok(access.description.length);
  }
  for (const value of [null, {}, 1, '__proto__', 'constructor', 'ALL\n', '<img>']) assert.equal(explainAccess(value), null);
});

test('EXPLAIN review requires an explicit traditional result and unambiguous column metadata', () => {
  for (const value of [null, {}, { ...result([]), isExplain: false }, { ...result([]), kind: 'ok' },
    result([['ALL']], ['EXPLAIN']), result([['ALL']], ['Field', 'Type', 'Null']), result([], ['table', 'type']),
    result([], ['table', 'type', 'rows', 'ROWS']), result([], ['table', null, 'rows']),
    { ...result([]), columns: Array.from({ length: 65 }, (_, i) => ({ name: String(i) })) }, { ...result([]), rows: null }]) {
    assert.equal(reviewExplain(value), null);
  }
  assert.equal(reviewExplain(result([['ALL', 'users', 7]], ['TYPE', 'TABLE', 'ROWS'])).rows[0].estimatedRows, 7);
  assert.deepEqual(reviewExplain(result([[null, null, null]])).rows[0].signals, []);
});

test('malformed, unsafe, missing estimates remain unknown; zero, percentages and row limits are explicit', () => {
  for (const value of [null, undefined, true, {}, [], '', ' 2', '2 ', '2\n', '2\r', '1e3', '-1', NaN, Infinity, -1]) {
    const row = reviewExplain(result([['t', 'ref', null, value, value, null]])).rows[0];
    assert.equal(row.estimatedRows, null); assert.equal(row.filteredPercent, null);
  }
  assert.equal(reviewExplain(result([['t', 'ref', null, Number.MAX_SAFE_INTEGER + 1, 100.01]])).rows[0].estimatedRows, null);
  assert.equal(reviewExplain(result([['t', 'ref', null, '9007199254740993', 101]])).rows[0].filteredPercent, null);
  assert.equal(reviewExplain(result([['t', 'ref', null, 1.1, '0.01']])).rows[0].estimatedRows, null);
  assert.equal(reviewExplain(result([['t', 'ref', null, 1.1, '0.01']])).rows[0].filteredPercent, 0.01);
  const bounded = reviewExplain(result(Array.from({ length: 201 }, () => ['t', 'ALL', null, 1, 100, 'using filesort'])));
  assert.equal(bounded.rows.length, 200); assert.equal(bounded.truncated, true);
  assert.equal(reviewExplain({ ...result([]), truncated: true }).truncated, true);
  const invalid = reviewExplain(result([{}, null, ['t'.repeat(257), 'ALL', 'k'.repeat(257), 0, 0, 'Using filesort'.repeat(400)]]));
  assert.equal(invalid.rows[2].table, null); assert.equal(invalid.rows[2].key, null); assert.deepEqual(invalid.rows[2].signals, ['FULL_TABLE_SCAN']);
});

test('renderer explains estimates and escapes labels without recommending indexes or claiming fast access', () => {
  const renderer = loadRenderer();
  renderer.context.plan = result([['<img src=x onerror=alert(1)>', 'ALL', '<script>x</script>', '5', 80, 'Using filesort; Using temporary']]);
  const html = renderer.evaluate('explainReviewHtml(plan)');
  assert.match(html, /rows và filtered là ước lượng/); assert.match(html, /không phải thời gian chạy truy vấn gốc/);
  assert.match(html, /có thể thực hiện trong RAM/); assert.match(html, /chưa cho biết dùng RAM hay đĩa/);
  assert.match(html, /có thể phù hợp với bảng nhỏ/); assert.match(html, /Không cộng rows/);
  assert.match(html, /&lt;img/); assert.match(html, /&lt;script/); assert.doesNotMatch(html, /<img|<script|Nên thêm Index|Cần đánh thêm Index/);
  renderer.context.plan = result(Array.from({ length: 201 }, () => ['t', 'ref', null, 1, null, '']));
  const limited = renderer.evaluate('explainReviewHtml(plan)');
  assert.equal((limited.match(/<tr>/g) || []).length, 51); assert.match(limited, /đã giới hạn/);
  assert.match(limited, /chưa đủ để kết luận kế hoạch tối ưu/);
  renderer.context.plan = result([['json']], ['other']);
  assert.equal(renderer.evaluate('explainReviewHtml(plan)'), '');
});

const documentResult = (text, format = 'DEFAULT') => ({ ...result([[text]], ['EXPLAIN']), explainFormat: format });
test('JSON viewer indents original tokens without rounding large numbers, removing duplicate keys or changing escapes', () => {
  const raw = '{"query_block":{"table":{"rows":90071992547409931234,"cost":1.234567890123456789,"a":1,"a":2,"condition":"a\\nb\\\"c\\u0041"}},"arrays":[[],{},true,false,null,-2.1e-4]}';
  const input = documentResult(raw), before = structuredClone(input), report = explainDocument(input);
  assert.equal(report.format, 'JSON'); assert.equal(report.status, 'formatted'); assert.equal(report.truncated, false);
  assert.match(report.text, /90071992547409931234/); assert.match(report.text, /1\.234567890123456789/);
  assert.match(report.text, /"a": 1,\n\s+"a": 2/); assert.match(report.text, /\\u0041/);
  assert.match(report.text, /-2\.1e-4/); assert.deepEqual(JSON.parse(report.text), JSON.parse(raw)); assert.deepEqual(input, before);
  assert.equal(explainFormat('JSON'), 'JSON'); assert.equal(explainFormat('TREE'), 'TREE');
  for (const value of [null, {}, 'json', 'TREE\n', 'ANALYZE', 'JSON;DROP']) assert.equal(explainFormat(value), 'DEFAULT');
});

test('document viewer accepts only one EXPLAIN string cell and never interprets JSON/tree semantics', () => {
  for (const value of [null, {}, { ...documentResult('{}'), isExplain: false }, result([['{}']], ['other']),
    result([['{}'], ['{}']], ['EXPLAIN']), result([[{}]], ['EXPLAIN']), result([['{}', 'x']], ['EXPLAIN']),
    { ...documentResult('{}'), columns: { 0: { name: 'EXPLAIN' }, length: 1 } },
    result([['{}']], ['EXPLAIN', 'EXPLAIN']), { ...documentResult('{}'), kind: 'ok' }]) assert.equal(explainDocument(value), null);
  const tree = '-> Table scan on items  (cost=0.35 rows=1)\n';
  assert.deepEqual(explainDocument(documentResult(tree)), { version: 1, format: 'TREE', text: tree, status: 'raw', truncated: false });
  assert.equal(explainDocument(documentResult('{broken}', 'JSON')).status, 'invalid-json');
  assert.equal(explainDocument(documentResult('not json', 'JSON')).status, 'invalid-json');
  assert.equal(explainDocument(documentResult('server text')).format, 'TEXT');
  assert.equal(explainDocument(documentResult('{"query_plan":{"inputs":[]}}')).status, 'formatted');
});

test('document quotas bound characters, depth, tokens and expansion while preserving raw evidence', () => {
  const long = 'x'.repeat(262145), limited = explainDocument(documentResult(long, 'TREE'));
  assert.equal(limited.text.length, 262144); assert.equal(limited.status, 'limit'); assert.equal(limited.truncated, true);
  const deep = '['.repeat(65) + '1' + ']'.repeat(65);
  assert.equal(explainDocument(documentResult(deep)).text, deep); assert.equal(explainDocument(documentResult(deep)).status, 'limit');
  const tokens = '[' + Array.from({ length: 6000 }, () => '1').join(',') + ']';
  assert.equal(explainDocument(documentResult(tokens)).status, 'limit');
  const expanded = '['.repeat(63) + '[' + Array.from({ length: 4100 }, () => '1').join(',') + ']' + ']'.repeat(63);
  const expansion = explainDocument(documentResult(expanded)); assert.equal(expansion.status, 'limit'); assert.equal(expansion.text, expanded);
  assert.equal(explainDocument({ ...documentResult('{}'), truncated: true }).status, 'limit');
});

test('document HTML escapes server text and explains truncation/invalid JSON without extra controls', () => {
  const renderer = loadRenderer(); renderer.context.plan = documentResult('{"condition":"<img src=x onerror=alert(1)>"}');
  const html = renderer.evaluate('explainReviewHtml(plan)');
  assert.match(html, /Xem plan JSON/); assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img|<script|<button/);
  assert.match(html, /tabindex="0"/);
  renderer.context.plan = documentResult('{bad}', 'JSON'); assert.match(renderer.evaluate('explainReviewHtml(plan)'), /Không đọc được JSON hợp lệ/);
  renderer.context.plan = documentResult('x'.repeat(262145), 'TREE'); assert.match(renderer.evaluate('explainReviewHtml(plan)'), /Đã giới hạn/);
});
