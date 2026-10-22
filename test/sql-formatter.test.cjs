'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRenderer } = require('./helpers/renderer.cjs');
const { splitSqlStatements } = require('../electron/sql-script.cjs');
const renderer = loadRenderer();
const formatSql = renderer.evaluate('formatSql');
const tokenizeSql = renderer.evaluate('tokenizeSql');

test('formatter: formats SELECT and JOIN clauses', () => {
  const output = formatSql("select id, name from users left join orders on users.id = orders.user_id where status = 1 and email like '%@gmail.com' order by id desc limit 10;");
  assert.match(output, /^SELECT id, name\nFROM users\nLEFT JOIN orders ON/);
  assert.match(output, /\nWHERE status = 1 AND email LIKE '%@gmail.com'\nORDER BY id DESC\nLIMIT 10;$/);
});

test('formatter: preserves all literals, comments and statement boundaries', () => {
  const inputs = [
    "select 1; -- keep; select 2\nselect 3;",
    "select 'it\\'s from users' as message;",
    'select 1 # from nowhere\nfrom users;',
    'select 1 --\u0001select from ignored\nfrom users;',
    "select 'line 1\n  from line 2', '__SQL_LIT_0__', `from``table` from t;",
    'select "say ""select""; hi", "a\\\"b"; /* from; where */ select 2;',
    '/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE */; select 1;',
    'select 4--2, 1e-5, 0xCAFE from t;',
    "select 'O''Brien', 'a; b'; -- trailing comment"
  ];
  const semanticTokens = (sql) => Array.from(tokenizeSql(sql)).filter((token) => token.type !== 'space')
    .map((token) => [token.type, token.type === 'word' ? token.text.toUpperCase() : token.text]);
  for (const input of inputs) {
    const output = formatSql(input);
    assert.deepEqual(semanticTokens(output), semanticTokens(input), input);
    assert.equal(splitSqlStatements(output).length, splitSqlStatements(input).length, input);
    assert.equal(formatSql(output), output, `formatter must be idempotent: ${input}`);
  }
});

test('formatter: rejects unclosed tokens and leaves the editor unchanged', () => {
  for (const input of ["select 'oops", 'select `oops', 'select 1 /* oops']) {
    assert.throws(() => formatSql(input), /chưa được đóng/);
  }
  const editor = { value: "select 'oops", selectionStart: 0, selectionEnd: 0 };
  renderer.elements.set('#sql', editor);
  renderer.evaluate('formatCurrentSql()');
  assert.equal(editor.value, "select 'oops");
  assert.match(renderer.messages.at(-1).message, /chưa được đóng/);
});
