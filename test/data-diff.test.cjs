'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Diff = require('../data-diff.js');
const columns = [{ name: 'id', type: 'bigint' }, { name: 'value', type: 'decimal(30,6)' }];
const compare = (sourceRows, targetRows, extra = {}) => Diff.compareTableData({ sourceRows, targetRows, primaryKeys: ['id'], columns, ...extra });

test('decimal comparisons retain every digit, normalize decimal notation and reject already lossy values', () => {
  for (const [a, b] of [['9007199254740992', '9007199254740993'], ['12345678901234567890.01', '12345678901234567890.02'], ['0.000000000000000001', '0.000000000000000002']]) assert.equal(Diff.compareCanonicalValues(a, b, 'decimal(65,30)'), false);
  for (const [a, b] of [['1.00', '01'], ['-0.0', '0'], ['1000', '1e3'], ['-12.50', '-1.250e1']]) assert.equal(Diff.compareCanonicalValues(a, b, 'decimal'), true);
  assert.equal(Diff.compareCanonicalValues(1, true, 'tinyint(1)'), true);
  assert.equal(Diff.compareCanonicalValues(2, 0, 'tinyint(1)'), false);
  for (const value of [9007199254740992, NaN, Infinity, 'abc', '', '1; DROP TABLE x']) assert.throws(() => Diff.compareCanonicalValues(value, value, 'int'), { code: 'DATA_DIFF_UNVERIFIED' });
  assert.equal(Diff.compareCanonicalValues(null, null), true);
  assert.equal(Diff.compareCanonicalValues(null, ''), false);
  assert.throws(() => Diff.compareCanonicalValues(undefined, null));
});

test('JSON preserves large numbers, keys, string/number distinctions and rejects malformed/ambiguous documents', () => {
  const equal = (a, b) => Diff.compareCanonicalValues(a, b, 'json');
  assert.equal(equal('{"b":2,"a":1.00}', '{"a":1,"b":2e0}'), true);
  assert.equal(equal('{"n":9007199254740992}', '{"n":9007199254740993}'), false);
  assert.equal(equal('{"__proto__":{"admin":true}}', '{}'), false);
  assert.equal(equal('"1"', '1'), false);
  assert.equal(equal('null', '"null"'), false);
  assert.equal(equal('[1,2]', '[2,1]'), false);
  assert.equal(equal('{"x":"a\\\"b"}', '{"x":"a\\u0022b"}'), true);
  for (const value of ['{bad', '{"x":1,"x":2}', '[1,]', '{"x":}', '01', 'true false', '"a\nb"', '['.repeat(34) + '0' + ']'.repeat(34), ' '.repeat(65537), { n: 9007199254740992 }]) assert.throws(() => equal(value, value), { code: 'DATA_DIFF_UNVERIFIED' });
});

test('temporal comparison never guesses timezone or discards subsecond differences', () => {
  assert.equal(Diff.compareCanonicalValues('2026-11-17 14:00:00', '2026-11-17T14:00:00.000Z', 'datetime'), false);
  assert.equal(Diff.compareCanonicalValues('2026-11-17 14:00:00.123456', '2026-11-17 14:00:00.123457', 'timestamp'), false);
  assert.equal(Diff.compareCanonicalValues('2026-11-17', '2026-11-17', 'date'), true);
});

test('composite key tuples do not collide on delimiters, quotes or empty components', () => {
  assert.notEqual(Diff.extractRowKey({ a: 'x::y', b: 'z' }, ['a', 'b']), Diff.extractRowKey({ a: 'x', b: 'y::z' }, ['a', 'b']));
  assert.equal(Diff.extractRowKey(['a', ''], ['a', 'b'], ['a', 'b']), '["a",""]');
  assert.equal(Diff.extractRowKey(Object.create({ id: 1 }), ['id']), null);
  const metadata = [{ name: 'a', type: 'text' }, { name: 'b', type: 'text' }];
  const report = compare([['x::y', 'z'], ['x', 'y::z']], [['x', 'y::z']], { columns: metadata, primaryKeys: ['a', 'b'] });
  assert.equal(report.summary.identicalCount, 1); assert.equal(report.summary.onlyInSourceCount, 1);
});

test('comparison rejects duplicates, missing values, NULL keys and incompatible row/metadata shapes', () => {
  for (const rows of [[[1, '1'], [1, '2']], [[null, '1']], [[undefined, '1']], [[1]], [Array(2)], [{ id: 1 }], [Object.create({ id: 1, value: '1' })], [[1, undefined]], Array(1)]) {
    assert.throws(() => compare(rows, []), { code: 'DATA_DIFF_UNVERIFIED' });
    assert.throws(() => compare([], rows), { code: 'DATA_DIFF_UNVERIFIED' });
  }
  for (const extra of [{ primaryKeys: ['missing'] }, { primaryKeys: ['id', 'id'] }, { columns: [columns[0], columns[0]] }, { columns: [] }, { sourceRows: null }]) assert.throws(() => compare([], [], extra));
  assert.throws(() => compare(Array.from({ length: 2001 }, (_, i) => [i, '1']), []));
  assert.throws(() => compare([[1, '1']], [], { columns: [{ name: 'id', type: 'int' }, { name: 'value', type: 'blob' }], sourceRows: [[1, { type: 'Buffer', data: [1] }]] }));
});

test('reports freeze snapshots and distinguish categories without granting write or script authority', () => {
  const source = [['1', '1.00'], ['2', '9007199254740993'], ['3', '2']];
  const report = compare(source, [['1', '1'], ['2', '9007199254740992'], ['4', '2']]);
  assert.deepEqual(report.summary, { totalSource: 3, totalTarget: 3, identicalCount: 1, differentCount: 1, onlyInSourceCount: 1, onlyInTargetCount: 1 });
  source[0][1] = 'changed'; assert.equal(report.identical[0].row[1], '1.00');
  assert.ok(Object.isFrozen(report.different[0].differences[0]));
  assert.equal(report.coverage.complete, false); assert.equal(report.coverage.consistent, false); assert.equal(report.coverage.canSynchronize, false);
  for (const input of [undefined, { diffResult: report, options: { includeDeletes: true } }, { diffResult: { ...report, coverage: { complete: true, consistent: true, canSynchronize: true } } }]) {
    const result = Diff.generateSyncSql(input);
    assert.equal(result.blocked, true); assert.equal(result.script, ''); assert.deepEqual(result.statements, []);
  }
});
