'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { captureExplain, compareExplain } = require('../query-results.js');
const { loadRenderer } = require('./helpers/renderer.cjs');
const request = { profileId: 'p1', database: 'demo', taskId: 'q1', explainFormat: 'DEFAULT' };
const context = (changes = {}) => ({ version: 1, profileId: 'p1', database: 'demo', sessionId: 'session-1',
  sqlHash: 'a'.repeat(64), taskId: 'q1', checkedAt: '2026-11-16T00:00:00.000Z', ...changes });
const result = (rows = [['items', 'ALL', null, 10, '50.0', 'Using filesort']], extra = {}) => ({ kind: 'rows', isExplain: true,
  columns: ['table', 'type', 'key', 'rows', 'filtered', 'Extra'].map(name => ({ name })), rows, explainContext: context(), ...extra });
const capture = (value = result(), change = {}) => captureExplain(value, { ...request, ...change });

test('captures a frozen bounded observation without SQL or private context fields in comparison output', () => {
  const input = result(), before = structuredClone(input);
  input.explainContext.secret = 'private-secret'; input.rawSql = "SELECT 'private-sql'";
  const observation = capture(input);
  assert.equal(Object.isFrozen(observation), true); assert.equal(Object.isFrozen(observation.rows), true);
  assert.equal(Object.isFrozen(observation.rows[0]), true);
  assert.equal(compareExplain(null, observation).status, 'baseline');
  const same = compareExplain(observation, capture()); assert.equal(same.status, 'unchanged'); assert.deepEqual(same.changes, []);
  assert.doesNotMatch(JSON.stringify(observation), /private-secret|private-sql/);
  assert.doesNotMatch(JSON.stringify(same), /session-1|aaaaaaaa|sqlHash|scope|profileId/);
  input.rows[0][0] = 'mutated'; assert.equal(observation.rows[0].table, 'items');
  assert.equal(observation.evidence, capture(before).evidence);
});

test('exact SQL hash, profile, session, database and selected format partition scopes without merging identifiers', () => {
  const baseline = capture();
  for (const [change, requested] of [[{ sqlHash: 'b'.repeat(64) }, {}], [{ sessionId: 'reconnect' }, {}],
    [{ database: 'other' }, { database: 'other' }], [{ profileId: 'p2' }, { profileId: 'p2' }], [{}, { explainFormat: 'JSON' }]]) {
    const current = capture(result(undefined, { explainContext: context(change) }), requested);
    assert.equal(compareExplain(baseline, current).status, 'different-scope');
  }
  const implicit = capture(result(), { database: null }); assert.equal(compareExplain(baseline, implicit).status, 'unchanged');
  const timed = capture(result(undefined, { explainContext: context({ checkedAt: '2026-11-16T00:01:00Z', taskId: 'q2' }) }), { taskId: 'q2' });
  assert.equal(compareExplain(baseline, timed).status, 'unchanged');
});

test('missing/legacy/mismatched metadata, malformed or incomplete result never becomes a comparison baseline', () => {
  for (const value of [null, result(undefined, { explainContext: null }), result(undefined, { isExplain: false }),
    result(undefined, { truncated: true }), result([[true]]), result([['wrong shape']]),
    result(Array.from({ length: 201 }, () => ['t', 'ALL', null, 1, 100, ''])), result([['t', 'ALL', null, 1, 100, 'x'.repeat(262145)]])]) {
    assert.equal(capture(value), null);
  }
  for (const change of [{ version: 0 }, { profileId: 'wrong' }, { taskId: 'wrong' }, { database: 'wrong' },
    { sessionId: '' }, { database: {} }, { sqlHash: 'bad' }, { sqlHash: 'a'.repeat(64) + '\n' }, { checkedAt: 'bad' }, { sessionId: 's'.repeat(161) }]) {
    assert.equal(capture(result(undefined, { explainContext: context(change) })), null);
  }
  assert.equal(compareExplain(capture(), null).status, 'unknown');
  assert.equal(compareExplain({}, capture()).status, 'unknown'); assert.equal(compareExplain(capture(), {}).status, 'unknown');
});

test('compares all received cells but summarizes steps by ordinal without assuming JOIN identity or speed', () => {
  const before = capture(), changed = capture(result([['items', 'ref', 'idx_x', 2, '100', 'Using index'], ['items', 'ALL', null, 20, 1, '']]));
  const diff = compareExplain(before, changed);
  assert.equal(diff.status, 'changed'); assert.equal(diff.changes.length, 2);
  assert.equal(diff.changes[0].before.access, 'ALL'); assert.equal(diff.changes[0].after.key, 'idx_x');
  assert.equal(diff.changes[1].before, null);
  const extraOnly = compareExplain(before, capture(result([['items', 'ALL', null, 10, '50.0', 'Using temporary']])));
  assert.equal(extraOnly.status, 'changed'); assert.equal(extraOnly.changes.length, 1);
  assert.equal(extraOnly.changes[0].before.extra, 'Using filesort'); assert.equal(extraOnly.changes[0].after.extra, 'Using temporary');
  const many = Array.from({ length: 100 }, (_, index) => ['t', 'ALL', null, index, 10, '']);
  const more = many.map(row => [...row.slice(0, 3), 200, ...row.slice(4)]);
  const limited = compareExplain(capture(result(many)), capture(result(more)));
  assert.equal(limited.changes.length, 50); assert.equal(limited.rowsLimited, true);
  assert.equal(compareExplain(capture(result(many)), capture(result(many))).rowsLimited, false);
});

test('JSON/TREE comparison is literal evidence, preserving numbers and reporting whitespace/shape changes', () => {
  const document = text => ({ kind: 'rows', isExplain: true, columns: [{ name: 'EXPLAIN' }], rows: [[text]], explainContext: context() });
  const json = capture(document('{"rows":90071992547409931234}'));
  const diff = compareExplain(json, capture(document('{"rows":90071992547409931235}')));
  assert.equal(diff.status, 'changed'); assert.match(diff.beforeText, /90071992547409931234/); assert.match(diff.afterText, /90071992547409931235/);
  assert.equal(compareExplain(json, capture(document('{ "rows" : 90071992547409931234 }'))).status, 'changed');
  assert.equal(compareExplain(json, capture(document('-> Table scan on t'))).status, 'different-scope');
  assert.equal(capture(document('{bad}')), null); assert.equal(capture(document('unknown native format')), null);
  assert.equal(capture(document('['.repeat(65) + '1' + ']'.repeat(65))), null);
});

test('comparison renderer escapes both observations and explains scope, quotas and limits', () => {
  const r = loadRenderer();
  const baseline = capture(result([['<img src=x>', 'ALL', null, 10, 50, '']]));
  r.context.comparison = compareExplain(baseline, capture(result([['<script>x</script>', 'ref', 'idx', 1, 100, '']])));
  const html = r.evaluate('explainComparisonHtml(comparison)');
  assert.match(html, /&lt;img/); assert.match(html, /&lt;script/); assert.doesNotMatch(html, /<img|<script/);
  assert.match(html, /Không xác nhận schema/); assert.match(html, /Ghép bước theo vị trí/);
  assert.match(html, /không kết luận nhanh\/chậm/);
  r.context.comparison = { version: 1, status: 'unknown' }; assert.match(r.evaluate('explainComparisonHtml(comparison)'), /Chưa đủ bằng chứng/);
  r.context.comparison = { version: 1, status: 'forged' }; assert.equal(r.evaluate('explainComparisonHtml(comparison)'), '');
});
