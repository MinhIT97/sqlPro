'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { projectIndexes, reviewReferencedIndex } = require('../electron/restore-selection-indexes.cjs');
const { reviewBasicCreate } = require('../electron/restore-selection-create.cjs');
const index = (columns = ['a', 'b'], overrides = {}) => ({ name: 'pair_unique', kind: 'unique',
  columns: columns.map(name => ({ name, prefixLength: null })), ...overrides });

test('only full PRIMARY/UNIQUE keys with matching ordered columns provide source evidence', () => {
  for (const definition of [index(), index(['a', 'b'], { name: 'PRIMARY', kind: 'primary' })]) {
    const before = structuredClone(definition);
    const result = reviewReferencedIndex([definition], ['A', 'b']);
    assert.equal(result.status, 'matched'); assert.equal(result.name, definition.name);
    assert.deepEqual(result.columns, ['a', 'b']); assert.deepEqual(definition, before);
  }
  for (const definition of [index(['b', 'a']), index(['a']), index(['a', 'b', 'c']), index(['a', 'b'], { kind: 'index' }),
    index(['a', 'b'], { columns: [{ name: 'a', prefixLength: 10 }, { name: 'b', prefixLength: null }] })]) {
    assert.deepEqual(reviewReferencedIndex([definition], ['a', 'b']), { status: 'blocked', code: 'FK_REFERENCED_UNIQUE_KEY_NOT_FOUND' });
  }
  assert.equal(reviewReferencedIndex([index(['wrong'], { name: 'other_key' }), index()], ['a', 'b']).name, 'pair_unique');
});

test('projection rejects malformed, duplicated and oversized definitions and strips private fields', () => {
  const source = index(['a'], { name: 'key.` Việt', rawSql: 'private-sql' }); source.columns[0].default = 'private-default';
  const projected = projectIndexes([source]);
  assert.equal(projected[0].name, 'key.` Việt'); assert.equal(JSON.stringify(projected).includes('private-'), false);
  const invalid = [null, {}, Array(129).fill(index()), [index(), index(['other'])], [index([], {})],
    [index(['a', 'A'])], [index(['a'], { name: 'PRIMARY' })], [index(['a'], { kind: 'primary' })],
    [index(['a'], { kind: 'fulltext' })], [index(['a'], { name: '\u0000' })], [index(Array.from({ length: 17 }, (_, i) => `c${i}`))]];
  for (const prefixLength of [undefined, 0, -1, 65536, 1.5, '4', NaN]) invalid.push([index(['a'], { columns: [{ name: 'a', prefixLength }] })]);
  for (const definitions of invalid) {
    assert.equal(projectIndexes(definitions), null);
    assert.equal(reviewReferencedIndex(definitions, ['a']).code, 'FK_REFERENCED_INDEX_NOT_REVIEWED');
  }
  for (const columns of [null, [], ['a', 'A'], [''], ['a'.repeat(65)]]) assert.equal(reviewReferencedIndex([index()], columns).code, 'FK_REFERENCED_INDEX_NOT_REVIEWED');
});

test('CREATE parser preserves exact index names, part order and prefix lengths for conservative FK checks', () => {
  const reviewed = reviewBasicCreate('CREATE TABLE `parent` (`a` int, `b` varchar(40), PRIMARY KEY (`a`), UNIQUE KEY `pair.``key` (`b`(12),`a` ASC), KEY `ordinary` (`b`)) ENGINE=InnoDB');
  assert.equal(reviewed.version, 3); assert.equal(reviewed.status, 'matched');
  assert.deepEqual(reviewed.indexDefinitions, [
    { name: 'PRIMARY', kind: 'primary', columns: [{ name: 'a', prefixLength: null }] },
    { name: 'pair.`key', kind: 'unique', columns: [{ name: 'b', prefixLength: 12 }, { name: 'a', prefixLength: null }] },
    { name: 'ordinary', kind: 'index', columns: [{ name: 'b', prefixLength: null }] }
  ]);
  assert.equal(reviewReferencedIndex(reviewed.indexDefinitions, ['a']).status, 'matched');
  assert.equal(reviewReferencedIndex(reviewed.indexDefinitions, ['b', 'a']).code, 'FK_REFERENCED_UNIQUE_KEY_NOT_FOUND');
});
