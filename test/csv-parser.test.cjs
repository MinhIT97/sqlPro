'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CsvStreamParser } = require('../electron/csv-stream.cjs');

function parse(text, options = {}) {
  const parser = new CsvStreamParser(options);
  return [...parser.push(text), ...parser.end()];
}

test('CSV: handles comma, semicolon and tab separators', () => {
  for (const delimiter of [',', ';', '\t']) {
    assert.deepEqual(parse(`name${delimiter}age\r\nAn${delimiter}25`, { delimiter }), [['name', 'age'], ['An', '25']]);
  }
});

test('CSV: ignores delimiters and newlines inside quoted headers and values', () => {
  assert.deepEqual(parse('﻿"a;b;c",id\r\n"Said ""Hi""\r\nnext",1'), [
    ['a;b;c', 'id'],
    ['Said "Hi"\r\nnext', '1']
  ]);
  assert.deepEqual(parse('"first\nline";id\nvalue;1', { delimiter: ';' })[0], ['first\nline', 'id']);
});

test('CSV: preserves whitespace, empty quoted records and trailing empty cells', () => {
  assert.deepEqual(parse('name\n"  Alice  "\n""\n  Bob  \n'), [['name'], ['  Alice  '], [''], ['  Bob  ']]);
  assert.deepEqual(parse('a,b\n,\n1,\n\n'), [['a', 'b'], ['', ''], ['1', '']]);
});

test('CSV: streams rows split across chunks', () => {
  const parser = new CsvStreamParser();
  const rows = [...parser.push('a,"b'), ...parser.push('c"\n1,'), ...parser.push('2')];
  assert.deepEqual(rows, [['a', 'bc']]);
  assert.deepEqual(parser.end(), [['1', '2']]);
});

test('CSV: rejects malformed quotes', () => {
  for (const source of ['a,b\n"unterminated,2', 'a,b\n"x"oops,2', 'a,b\nx"y,2']) {
    const parser = new CsvStreamParser();
    assert.throws(() => {
      parser.push(source);
      parser.end();
    }, /CSV/);
  }
});

test('CSV: blank files produce no rows', () => {
  assert.deepEqual(parse('﻿\r\n'), []);
});
