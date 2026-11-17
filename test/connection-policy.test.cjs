'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertWritable, assertReadOnlySql } = require('../electron/connection-policy.cjs');
const { DatabaseSession } = require('../electron/database.cjs');
const readOnly = {readOnly:true};

test('read-only policy allows ordinary reads, safe CTEs, metadata, quoted identifiers and whole read batches', () => {
  for (const sql of [
    'SELECT * FROM users WHERE id=1', 'SELECT (1 + 2)',
    "SELECT 'DELETE; UPDATE; /*! comment */' AS message", 'SELECT `delete`, `cột` FROM `bảng`',
    'SELECT COUNT(*), SUM(price), COALESCE(name, \'unknown\') FROM items',
    'WITH cte AS (SELECT id FROM users) SELECT * FROM cte',
    'SELECT * FROM (SELECT 1 AS id) AS x WHERE (id IN (1,2))',
    'SELECT u.id FROM users u JOIN items i ON (i.user_id=u.id)',
    'SELECT REPLACE(name, \'a\', \'b\'), TRUNCATE(price, 2) FROM items',
    'EXPLAIN SELECT * FROM users', 'EXPLAIN FORMAT=JSON SELECT * FROM users',
    'SHOW TABLES; SHOW CREATE TABLE `users`; DESCRIBE `users`; USE `test`; ROLLBACK;',
    'SHOW FULL COLUMNS FROM `users`', 'SHOW CHARACTER SET', 'SHOW GLOBAL STATUS',
    '# note\nSELECT 1; -- note\nSELECT 2', 'SELECT /* ordinary note */ 1',
    'SELECT ROW_NUMBER() OVER (ORDER BY id) FROM users'
  ]) assert.doesNotThrow(() => assertReadOnlySql(readOnly, sql), sql);
});

test('read-only policy blocks mutations anywhere in a batch, locking reads, file output and transaction commit', () => {
  for (const sql of [
    'UPDATE users SET id=1', 'SELECT 1; DELETE FROM users', 'SELECT 1; COMMIT',
    'WITH x AS (SELECT 1) UPDATE users SET id=1',
    "SELECT * FROM users INTO OUTFILE '/tmp/out'", "SELECT 1 INTO DUMPFILE '/tmp/out'",
    'SELECT * FROM users FOR UPDATE', 'SELECT * FROM users LOCK IN SHARE MODE',
    'SELECT @counter := 1', 'SET GLOBAL read_only=0', 'CALL change_data()',
    'CREATE TABLE x(id int)', 'DROP DATABASE x', 'KILL 1', 'BEGIN',
    'EXPLAIN ANALYZE SELECT * FROM users', 'EXPLAIN DELETE FROM users'
  ]) assert.throws(() => assertReadOnlySql(readOnly, sql), (error) => error.code.startsWith('READ_ONLY_') || error.code === 'CONNECTION_READ_ONLY', sql);
});

test('ambiguous syntax, executable comments and unrecognized functions fail closed without relying on SQL mode', () => {
  for (const sql of [
    'SELECT change_data()', 'SELECT app.COUNT(*)', 'SELECT `COUNT`(*)',
    "SELECT LOAD_FILE('/etc/passwd')", "SELECT GET_LOCK('x',1)", 'SELECT SLEEP(1)',
    'SELECT 1 /*!; DELETE FROM users */', 'SELECT 1 /*M!; DELETE FROM users */',
    'SELECT 1 /*+ SET_VAR(x=1) */', 'SELECT 1 /* nested /*! ; DELETE */ */',
    "SELECT 'a\\'; DELETE FROM users; -- '", 'SELECT "a\\"',
    'SELECT 1 /* unfinished', "SELECT 'unfinished", 'VALUES ROW(1)',
    'SELECT 1; DELIMITER $$', 'SELECT 1\0', 'SHOW SOMETHING_NEW',
    'WITH x AS (SELECT 1) SELECT unknown_function()'
  ]) assert.throws(() => assertReadOnlySql(readOnly, sql), (error) => error.code.startsWith('READ_ONLY_') || error.code === 'CONNECTION_READ_ONLY', sql);
  assert.throws(() => assertReadOnlySql(readOnly, 'x'.repeat(1024 * 1024 + 1)), {code:'READ_ONLY_SQL_UNSUPPORTED'});
});

test('writable profiles keep existing SQL behavior', () => {
  for (const profile of [{}, {readOnly:false}]) {
    assert.doesNotThrow(() => assertWritable(profile));
    assert.doesNotThrow(() => assertReadOnlySql(profile, 'DROP DATABASE test'));
  }
  assert.throws(() => assertWritable(readOnly), {code:'CONNECTION_READ_ONLY'});
});

test('DatabaseSession blocks all public write paths before using the connection', async () => {
  const session = new DatabaseSession(readOnly);
  for (const run of [
    () => session.insertRow({}), () => session.updateRow({}), () => session.deleteRows({}),
    () => session.importFile({}), () => session.restoreDatabase({}),
    () => session.analyzeQuery('SELECT 1'),
    () => session.runQueryScript('SELECT 1; DELETE FROM users', 30000, true),
    () => session.exportQueryFile({sql:'SELECT change_data()'}, () => {})
  ]) await assert.rejects(run(), (error) => ['CONNECTION_READ_ONLY', 'READ_ONLY_SQL_UNSUPPORTED'].includes(error.code));
});

test('read-only policy supports CTE with column lists, recursive CTE, JOIN subqueries, CASE WHEN, and safe metadata', () => {
  for (const sql of [
    'WITH cte(col1, col2) AS (SELECT 1, 2) SELECT * FROM cte',
    'WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 5) SELECT * FROM seq',
    'WITH a(x) AS (SELECT 1), b(y) AS (SELECT 2) SELECT * FROM a JOIN b ON a.x = b.y',
    'SELECT * FROM a JOIN (SELECT id FROM b) x ON a.id = x.id',
    'SELECT * FROM a LEFT JOIN (SELECT id FROM b) x ON a.id = x.id',
    'SELECT * FROM a STRAIGHT_JOIN (SELECT id FROM b) x ON a.id = x.id',
    'SELECT CASE WHEN (status = 1) THEN (10) ELSE (20) END FROM orders',
    'SELECT CASE status WHEN 1 THEN 10 ELSE 20 END FROM orders',
    'SELECT * FROM orders WHERE amount BETWEEN (10) AND (50)',
    'SELECT * FROM users WHERE name LIKE (\'%test%\')',
    'SHOW TABLE STATUS',
    'SHOW PROCEDURE STATUS',
    'SHOW FUNCTION STATUS',
    'SHOW TRIGGERS',
    'SHOW EVENTS',
    'SHOW OPEN TABLES',
    'SHOW PLUGINS',
    'SHOW PRIVILEGES',
    'SHOW PROFILES',
    'SHOW SLAVE STATUS',
    'SHOW REPLICA STATUS',
    'SELECT JSON_ARRAYAGG(name), JSON_PRETTY(data) FROM items',
    'SELECT ASCII(\'a\'), BIT_COUNT(15), LAST_DAY(NOW()) FROM tbl',
    'SELECT NOW(), LOCALTIME(), SYSDATE() FROM tbl'
  ]) assert.doesNotThrow(() => assertReadOnlySql(readOnly, sql), sql);
});

test('read-only policy strictly blocks CTE attempts to mutate or call unrecognized routines', () => {
  for (const sql of [
    'WITH cte(col1) AS (SELECT 1) SELECT dangerous_func(1)',
    'WITH x(y) AS (SELECT 1) UPDATE users SET id = 1',
    'WITH func(x) AS (SELECT 1) DELETE FROM users',
    'WITH cte(x) AS (SELECT 1) INSERT INTO users(id) VALUES(2)',
    'WITH cte(x) AS (SELECT 1) DROP TABLE users',
    'WITH cte(col1) AS (SELECT 1) CALL my_procedure()'
  ]) assert.throws(() => assertReadOnlySql(readOnly, sql), (error) => ['READ_ONLY_SQL_UNSUPPORTED', 'CONNECTION_READ_ONLY'].includes(error.code), sql);
});
