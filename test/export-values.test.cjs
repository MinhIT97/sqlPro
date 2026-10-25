'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { csvField, uniqueColumnNames } = require('../export-values.js');

test('CSV export distinguishes NULL, empty string and a literal backslash-N', () => {
  assert.equal(csvField(null), '\\N');
  assert.equal(csvField(undefined), '\\N');
  assert.equal(csvField(''), '');
  assert.equal(csvField('\\N'), '\\\\N');
});

test('CSV export quotes delimiters, quotes, newlines and surrounding spaces', () => {
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('line\nbreak'), '"line\nbreak"');
  assert.equal(csvField(' padded '), '" padded "');
  assert.equal(csvField('plain'), 'plain');
  assert.equal(csvField('a;b', ';'), '"a;b"');
  assert.equal(csvField('a,b', ';'), 'a,b');
});

test('duplicate JSON column names get stable collision-safe suffixes', () => {
  assert.deepEqual(
    uniqueColumnNames(['id', 'id', 'id_2', 'id', '']),
    ['id', 'id_2', 'id_2_2', 'id_3', '']
  );
});
