'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SqlScriptParser, splitSqlStatements, stripLeadingComments, createTarget } = require('../electron/sql-script.cjs');

test('tách INSERT lớn qua nhiều chunk rồi nhận DELIMITER tiếp theo', () => {
  const parser = new SqlScriptParser();
  const values = Array.from({ length: 8000 }, () => `('${'x'.repeat(120)}')`).join(',\n  ');
  const sql = `INSERT INTO items VALUES\n  ${values};\nDELIMITER $$\nSELECT 2$$\n`;
  const midpoint = Math.floor(sql.length / 2);
  const statements = [...parser.push(sql.slice(0, midpoint)), ...parser.push(sql.slice(midpoint)), ...parser.end()];
  assert.equal(statements.length, 2);
  assert.match(statements[0], /^INSERT INTO items VALUES/);
  assert.match(statements[0], /\('x+'\)$/);
  assert.equal(statements[1], 'SELECT 2');
});

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

test('nhận diện đúng loại đối tượng khi CREATE có DEFINER và ALGORITHM', () => {
  assert.deepEqual(
    createTarget('CREATE DEFINER=`root`@`localhost` PROCEDURE `p1`() BEGIN SELECT 1; END'),
    { type: 'procedure', name: 'p1' }
  );
  assert.deepEqual(
    createTarget('CREATE OR REPLACE DEFINER="root"@"%" FUNCTION `f1`(x INT) RETURNS INT RETURN 1'),
    { type: 'function', name: 'f1' }
  );
  assert.deepEqual(
    createTarget("CREATE DEFINER='root'@'localhost' EVENT `e1` ON SCHEDULE EVERY 1 DAY DO SELECT 1"),
    { type: 'event', name: 'e1' }
  );
  assert.deepEqual(
    createTarget('CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `v1` AS SELECT 1'),
    { type: 'view', name: 'v1' }
  );
  assert.deepEqual(
    createTarget('CREATE TRIGGER `tr1` BEFORE INSERT ON `t1` FOR EACH ROW SET @x = 1'),
    { type: 'trigger', name: 'tr1' }
  );
  assert.deepEqual(
    createTarget('CREATE TEMPORARY TABLE IF NOT EXISTS `db`.`t1` (`id` int)'),
    { type: 'table', name: 't1' }
  );
});

