'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { splitSqlStatements, stripLeadingComments } = require('../electron/sql-script.cjs');

test('tách nhiều statement theo dấu chấm phẩy', () => {
  assert.deepEqual(
    splitSqlStatements('SELECT * FROM users;\nSELECT * FROM messages;'),
    ['SELECT * FROM users', 'SELECT * FROM messages']
  );
});

test('không tách dấu chấm phẩy trong quote, identifier và comment', () => {
  const sql = [
    "SELECT 'a; b', \"c; d\", `semi;colon`;",
    '-- comment; vẫn cùng statement',
    'SELECT 2 /* block; comment */;',
    '# comment; cuối file'
  ].join('\n');
  assert.deepEqual(splitSqlStatements(sql), [
    "SELECT 'a; b', \"c; d\", `semi;colon`",
    '-- comment; vẫn cùng statement\nSELECT 2 /* block; comment */'
  ]);
});

test('giữ nguyên comment và optimizer hint trong statement gửi tới server', () => {
  const [statement] = splitSqlStatements('/*+ MAX_EXECUTION_TIME(10) */ SELECT /* keep */ 1;');
  assert.equal(statement, '/*+ MAX_EXECUTION_TIME(10) */ SELECT /* keep */ 1');
});

test('chỉ coi -- là comment khi ký tự sau là whitespace/control hoặc hết chuỗi', () => {
  assert.deepEqual(splitSqlStatements('SELECT 5--2; SELECT 3;'), ['SELECT 5--2', 'SELECT 3']);
  assert.deepEqual(splitSqlStatements('SELECT 5-- comment;\n + 2; SELECT 3;'), [
    'SELECT 5-- comment;\n + 2',
    'SELECT 3'
  ]);
  assert.equal(stripLeadingComments('--not_a_comment'), '--not_a_comment');
  assert.equal(stripLeadingComments('-- a comment\nSELECT 1'), 'SELECT 1');
  assert.equal(stripLeadingComments('-- a comment\rSELECT 1'), 'SELECT 1');
});

test('hỗ trợ escape và quote kép liền nhau', () => {
  assert.deepEqual(splitSqlStatements("SELECT 'it\\\'s;ok', 'a'';b', `a``;b`; SELECT 2;"), [
    "SELECT 'it\\\'s;ok', 'a'';b', `a``;b`",
    'SELECT 2'
  ]);
});

test('từ chối script có quote hoặc block comment chưa đóng', () => {
  assert.throws(() => splitSqlStatements("SELECT 'missing;"), /chưa được đóng/);
  assert.throws(() => splitSqlStatements('SELECT 1 /* missing;'), /chưa được đóng/);
});

