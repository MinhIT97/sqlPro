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
    () => session.runQueryScript('SELECT 1; DELETE FROM users', 30000, true),
    () => session.exportQueryFile({sql:'SELECT change_data()'}, () => {})
  ]) await assert.rejects(run(), (error) => ['CONNECTION_READ_ONLY', 'READ_ONLY_SQL_UNSUPPORTED'].includes(error.code));
});
