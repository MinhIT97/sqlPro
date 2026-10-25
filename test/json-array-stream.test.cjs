'use strict';


const test = require('node:test');
const assert = require('node:assert/strict');
const { JsonArrayStreamParser, JsonNumber, stringifyJsonValue } = require('../electron/json-array-stream.cjs');

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

function parseNumbers(chunks) {
  const parser = new JsonArrayStreamParser({ preserveNumbers: true });
  const values = [];
  for (const chunk of chunks) values.push(...parser.push(chunk));
  values.push(...parser.end());
  return values;
}

test('JSON: preserves special own keys without changing object prototypes', () => {
  for (const value of ['123', '{"keep":9007199254740993}', 'null', '[1,{"__proto__":2}]']) {
    const source = `{"__proto__":${value},"constructor":3,"nested":{"__proto__":${value}},"id":1}`;
    const [row] = parseNumbers([`[${source}]`]);
    assert.equal(Object.getPrototypeOf(row), Object.prototype);
    assert.equal(Object.hasOwn(row, '__proto__'), true);
    assert.equal(Object.hasOwn(row.nested, '__proto__'), true);
    assert.equal(row instanceof JsonNumber, false);
    assert.equal(stringifyJsonValue(row), source);
  }
});

test('JSON: a prototype inheriting JsonNumber cannot impersonate a numeric token', () => {
  const { isJsonNumber } = require('../electron/json-array-stream.cjs');
  assert.equal(isJsonNumber(new JsonNumber('123')), true);
  assert.equal(isJsonNumber(Object.create(new JsonNumber('123'))), false);
});

test('JSON: preserves raw number tokens outside strings when requested', () => {
  const [row] = parseNumbers(['[{"id":9007199254740993,"amount":-1.25e+30,"nested":[18446744073709551615,"123"],"text":"1.0"}]']);
  assert.ok(row.id instanceof JsonNumber);
  assert.equal(row.id.raw, '9007199254740993');
  assert.equal(row.amount.raw, '-1.25e+30');
  assert.equal(row.nested[0].raw, '18446744073709551615');
  assert.equal(row.nested[1], '123');
  assert.equal(row.text, '1.0');
  assert.equal(String(row.id), '9007199254740993');
});

test('JSON: number preservation rejects malformed numeric literals', () => {
  assert.throws(() => parseNumbers(['[01]']));
  assert.throws(() => parseNumbers(['[1.]']));
  assert.throws(() => parseNumbers(['[.5]']));
  assert.throws(() => parseNumbers(['[1e]']));
});

test('JSON: serializes JsonNumber values without rounding', () => {
  const [value] = parseNumbers(['[{"id":9007199254740993,"list":[1.0,{"n":18446744073709551615}],"s":"x"}]']);
  assert.equal(
    stringifyJsonValue(value),
    '{"id":9007199254740993,"list":[1.0,{"n":18446744073709551615}],"s":"x"}'
  );
});
