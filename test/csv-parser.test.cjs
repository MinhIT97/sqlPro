'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRenderer } = require('./helpers/renderer.cjs');
const parseCsv = loadRenderer().evaluate('parseCsv');
const parse = (text) => structuredClone(parseCsv(text));

test('CSV: handles comma, semicolon and tab separators', () => {
  for (const delimiter of [',', ';', '\t']) {
    assert.deepEqual(parse(`name${delimiter}age\r\nAn${delimiter}25`), { headers: ['name', 'age'], rows: [['An', '25']] });
  }
});

test('CSV: ignores delimiters and newlines inside quoted headers and values', () => {
  assert.deepEqual(parse('\uFEFF"a;b;c",id\r\n"Said ""Hi""\r\nnext",1'), {
    headers: ['a;b;c', 'id'], rows: [['Said "Hi"\r\nnext', '1']]
  });
  assert.deepEqual(parse('"first\nline";id\nvalue;1').headers, ['first\nline', 'id']);
});

test('CSV: preserves whitespace, empty quoted records and trailing empty cells', () => {
  assert.deepEqual(parse('name\n"  Alice  "\n""\n  Bob  \n'), { headers: ['name'], rows: [['  Alice  '], [''], ['  Bob  ']] });
  assert.deepEqual(parse('a,b\n,\n1,\n\n').rows, [['', ''], ['1', '']]);
});

test('CSV: rejects malformed quotes and inconsistent column counts', () => {
  for (const source of ['a,b\n"unterminated,2', 'a,b\n"x"oops,2', 'a,b\nx"y,2', 'a,b\n1', 'a,b\n1,2,3']) {
    assert.throws(() => parseCsv(source), /CSV/);
  }
});

test('CSV: blank files and header-only files contain no data rows', () => {
  assert.deepEqual(parse('\uFEFF\r\n'), { headers: [], rows: [] });
  assert.deepEqual(parse('a,b\n'), { headers: ['a', 'b'], rows: [] });
});
