'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JsonArrayStreamParser } = require('../electron/json-array-stream.cjs');

function parse(chunks) {
  const parser = new JsonArrayStreamParser();
  const values = [];
  for (const chunk of chunks) values.push(...parser.push(chunk));
  values.push(...parser.end());
  return values;
}

test('JSON: parses an array split across chunks with nested values', () => {
  assert.deepEqual(parse([
    '[{"a":1,"s":"x,]","nested":{"b":[2,3]}},',
    '{"a":2}, 3, "four", [5,6]\n]'
  ]), [
    { a: 1, s: 'x,]', nested: { b: [2, 3] } },
    { a: 2 },
    3,
    'four',
    [5, 6]
  ]);
});

test('JSON: strips a BOM and tolerates whitespace around values', () => {
  assert.deepEqual(parse(['﻿ \n[\n  {"id": 1}\n]\n']), [{ id: 1 }]);
});

test('JSON: rejects invalid or incomplete arrays', () => {
  assert.throws(() => parse(['{"a":1}']), /mảng/);
  assert.throws(() => parse(['[{"a":1}']), /mảng chưa được đóng/);
  assert.throws(() => parse(['[1] x']), /dữ liệu ngoài mảng/);
  assert.throws(() => parse(['[1,]']), /dấu phẩy thừa/);
  assert.throws(() => parse(['[,1]']), /dấu phẩy thừa|phần tử rỗng/);
  assert.throws(() => parse(['[{"a":1}{"b":2}]']), /thiếu dấu phẩy/);
  assert.throws(() => parse(['["unterminated]']), /chuỗi chưa đóng/);
});

test('JSON: empty array and empty input', () => {
  assert.deepEqual(parse(['[]']), []);
  assert.throws(() => parse(['   ']), /rỗng/);
});
