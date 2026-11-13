'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewTargetIndexes, reviewTargetReferencedIndex } = require('../electron/restore-selection-target-indexes.cjs');
const options = { metadataComplete: true, tableObserved: true, visibilityKind: 'mysql-visible' };
const part = (overrides = {}) => ({ name: 'pair_unique', ordinal: 1, column: 'a', prefixLength: null, direction: 'A', type: 'BTREE', nonUnique: false, visibility: 'visible', ...overrides });
const pair = () => [part(), part({ ordinal: 2, column: 'b' })];

test('ordered target key observations match full unique columns without certifying visibility, data or server rules', () => {
  const statistics = pair().reverse(), before = structuredClone(statistics);
  statistics[0].expression = 'private-expression';
  const report = reviewTargetIndexes(statistics, options);
  assert.equal(report.complete, true); assert.equal(report.canExecute, false);
  assert.deepEqual(report.indexes[0].columns.map(column => column.name), ['a', 'b']);
  assert.equal(JSON.stringify(report).includes('private-'), false);
  assert.deepEqual(reviewTargetReferencedIndex(report, ['A', 'b']), { status: 'observed-match', code: 'FK_TARGET_UNIQUE_KEY_OBSERVED', name: 'pair_unique', kind: 'unique', columns: ['a', 'b'] });
  assert.equal(reviewTargetReferencedIndex(report, ['b', 'a']).code, 'FK_TARGET_UNIQUE_KEY_NOT_OBSERVED');
  assert.equal(reviewTargetReferencedIndex(report, ['a']).code, 'FK_TARGET_UNIQUE_KEY_NOT_OBSERVED');
  assert.deepEqual(statistics.map(({ expression, ...row }) => row), before);
  assert.deepEqual(report.requires, ['TARGET_INDEX_SERVER_RULES_NOT_VALIDATED', 'TARGET_INDEX_DATA_NOT_CHECKED']);
});

test('ordinary and prefix indexes remain observations but cannot satisfy the conservative full unique key check', () => {
  for (const changes of [{ nonUnique: true }, { prefixLength: 10 }]) {
    const report = reviewTargetIndexes([part(changes)], options);
    assert.equal(report.complete, true);
    assert.equal(reviewTargetReferencedIndex(report, ['a']).status, 'not-observed');
  }
  const primary = reviewTargetIndexes([part({ name: 'PRIMARY' })], options);
  assert.equal(reviewTargetReferencedIndex(primary, ['a']).kind, 'primary');
});

test('expressions, descending/unknown direction, non-BTREE, gaps, duplicates and inconsistent rows remain unknown', () => {
  for (const rows of [[part({ column: null })], [part({ direction: 'D' })], [part({ direction: null })], [part({ type: 'HASH' })],
    [part({ ordinal: 2 })], [part(), part()], [part(), part({ ordinal: 2, column: 'A' })],
    [part(), part({ ordinal: 2, column: 'b', nonUnique: true })], [part({ name: 'PRIMARY', nonUnique: true })],
    [part(), part({ name: 'PAIR_UNIQUE', column: 'b' })]]) {
    const report = reviewTargetIndexes(rows, options);
    assert.equal(report.complete, false, JSON.stringify(rows));
    assert.equal(reviewTargetReferencedIndex(report, ['a']).status, 'unknown');
  }
  for (const reviewOptions of [{}, { ...options, metadataComplete: false }, { ...options, tableObserved: false }]) {
    assert.equal(reviewTargetReferencedIndex(reviewTargetIndexes(pair(), reviewOptions), ['a', 'b']).status, 'unknown');
  }
  assert.equal(reviewTargetReferencedIndex(null, ['a']).status, 'unknown');
  const malformed = reviewTargetIndexes([part()], options); malformed.indexes[0] = null;
  assert.equal(reviewTargetReferencedIndex(malformed, ['a']).status, 'unknown');
});

test('metadata and display limits never produce complete index evidence', () => {
  for (const limits of [{ limit: 0 }, { partLimit: 1 }, { limit: -1 }, { partLimit: NaN }]) {
    const report = reviewTargetIndexes(pair(), { ...options, ...limits });
    assert.equal(report.truncated, true); assert.equal(report.complete, false);
    assert.equal(reviewTargetReferencedIndex(report, ['a', 'b']).status, 'unknown');
  }
  const many = Array.from({ length: 129 }, (_, i) => part({ name: `key${i}` }));
  const report = reviewTargetIndexes(many, options);
  assert.equal(report.indexes.length, 50); assert.equal(report.truncated, true);
  assert.equal(report.canExecute, false);
  assert.equal(reviewTargetIndexes(null, options).complete, false);
  assert.equal(reviewTargetIndexes([part({ name: '\u0000' })], options).complete, false);
  const wide = reviewTargetIndexes(Array.from({ length: 17 }, (_, i) => part({ column: `c${i}`, ordinal: i + 1 })), options);
  assert.equal(wide.complete, false);
});

test('visibility and ignored observations require consistent flags and never equate optimizer status with FK validity', () => {
  for (const [visibilityKind, active, hidden] of [['mysql-visible', 'visible', 'invisible'], ['mariadb-ignored', 'not-ignored', 'ignored']]) {
    const currentOptions = { ...options, visibilityKind };
    const report = reviewTargetIndexes([part({ visibility: hidden })], currentOptions);
    assert.equal(report.version, 2); assert.equal(report.complete, true); assert.equal(report.canExecute, false);
    assert.deepEqual(reviewTargetReferencedIndex(report, ['a']), { status: 'requires-review', code: 'FK_TARGET_KEY_INVISIBLE_OR_IGNORED', name: 'pair_unique', kind: 'unique', columns: ['a'], visibility: hidden });
    const alternative = reviewTargetIndexes([part({ visibility: hidden }), part({ name: 'other_key', visibility: active })], currentOptions);
    assert.equal(reviewTargetReferencedIndex(alternative, ['a']).name, 'other_key');
    assert.equal(reviewTargetReferencedIndex(alternative, ['a']).status, 'observed-match');
    const forged = structuredClone(alternative); forged.indexes[1].name = forged.indexes[0].name;
    assert.equal(reviewTargetReferencedIndex(forged, ['a']).status, 'unknown');
    for (const visibility of ['unknown', undefined, 'private-state']) {
      const unknown = reviewTargetIndexes([part({ visibility })], currentOptions);
      assert.equal(unknown.complete, false); assert.equal(unknown.indexes[0].visibility, 'unknown');
      assert.equal(reviewTargetReferencedIndex(unknown, ['a']).status, 'unknown');
    }
    const mixed = reviewTargetIndexes([part({ visibility: active }), part({ ordinal: 2, column: 'b', visibility: hidden })], currentOptions);
    assert.equal(reviewTargetReferencedIndex(mixed, ['a', 'b']).status, 'unknown');
  }
  const old = reviewTargetIndexes([part()], options); old.version = 1;
  assert.equal(reviewTargetReferencedIndex(old, ['a']).status, 'unknown');
  const noCapability = reviewTargetIndexes([part()], { ...options, visibilityKind: null });
  assert.equal(noCapability.complete, false); assert.ok(noCapability.requires.includes('TARGET_INDEX_VISIBILITY_NOT_REVIEWED'));
});
