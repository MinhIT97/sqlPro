'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const SqlDiagnostics = require('../diagnostics.js');

test('formatDuration converts seconds to human readable strings', () => {
  assert.equal(SqlDiagnostics.formatDuration(0), '0s');
  assert.equal(SqlDiagnostics.formatDuration(42), '42s');
  assert.equal(SqlDiagnostics.formatDuration(65), '1m 5s');
  assert.equal(SqlDiagnostics.formatDuration(3665), '1h 1m 5s');
  assert.equal(SqlDiagnostics.formatDuration(-10), '0s');
  assert.equal(SqlDiagnostics.formatDuration(null), '0s');
});

test('isSystemThread detects daemon, binlog, and system user threads', () => {
  assert.equal(SqlDiagnostics.isSystemThread({ user: 'system user', command: 'Connect' }), true);
  assert.equal(SqlDiagnostics.isSystemThread({ user: 'event_scheduler', command: 'Daemon' }), true);
  assert.equal(SqlDiagnostics.isSystemThread({ user: 'root', command: 'Binlog Dump' }), true);
  assert.equal(SqlDiagnostics.isSystemThread({ user: 'app_user', command: 'Query' }), false);
  assert.equal(SqlDiagnostics.isSystemThread({ user: 'root', command: 'Sleep' }), false);
});

test('isMyConnection checks matching thread id against active session', () => {
  assert.equal(SqlDiagnostics.isMyConnection({ id: '42' }, 42), true);
  assert.equal(SqlDiagnostics.isMyConnection({ id: 42 }, '42'), true);
  assert.equal(SqlDiagnostics.isMyConnection({ id: '42' }, 43), false);
  assert.equal(SqlDiagnostics.isMyConnection({ id: '42' }, null), false);
});

test('parseProcesslistRow normalizes process data and identifies slow and locked queries', () => {
  const normalRow = [101, 'app', 'localhost:54321', 'shop', 'Query', 2, 'executing', 'SELECT * FROM orders'];
  const p1 = SqlDiagnostics.parseProcesslistRow(normalRow, 102);
  assert.equal(p1.id, '101');
  assert.equal(p1.user, 'app');
  assert.equal(p1.timeSec, 2);
  assert.equal(p1.timeFormatted, '2s');
  assert.equal(p1.isSlow, false);
  assert.equal(p1.isSystem, false);
  assert.equal(p1.isSelf, false);

  const slowRow = [102, 'app', 'localhost:54322', 'shop', 'Query', 15, 'Waiting for table metadata lock', 'ALTER TABLE orders ADD COLUMN x INT'];
  const p2 = SqlDiagnostics.parseProcesslistRow(slowRow, 102);
  assert.equal(p2.id, '102');
  assert.equal(p2.isSlow, true);
  assert.equal(p2.isLocked, true);
  assert.equal(p2.isSelf, true);
  assert.ok(Object.isFrozen(p2));
});

test('filterProcesses filters by text search and command type', () => {
  const processes = [
    SqlDiagnostics.parseProcesslistRow([1, 'admin', '10.0.0.1', 'main', 'Query', 8, 'executing', 'SELECT 1']),
    SqlDiagnostics.parseProcesslistRow([2, 'worker', '10.0.0.2', 'jobs', 'Sleep', 120, '', '']),
    SqlDiagnostics.parseProcesslistRow([3, 'app', '10.0.0.3', 'shop', 'Query', 1, 'Waiting for lock', 'UPDATE t SET c=1'])
  ];

  assert.equal(SqlDiagnostics.filterProcesses(processes, { query: 'admin' }).length, 1);
  assert.equal(SqlDiagnostics.filterProcesses(processes, { query: 'jobs' }).length, 1);
  assert.equal(SqlDiagnostics.filterProcesses(processes, { filterType: 'query' }).length, 2);
  assert.equal(SqlDiagnostics.filterProcesses(processes, { filterType: 'sleep' }).length, 1);
  assert.equal(SqlDiagnostics.filterProcesses(processes, { filterType: 'slow' }).length, 1);
  assert.equal(SqlDiagnostics.filterProcesses(processes, { filterType: 'locked' }).length, 1);
});

test('detectServerEngine recognizes MariaDB vs MySQL and extracts major/minor version', () => {
  const maria = SqlDiagnostics.detectServerEngine('10.5.12-MariaDB-1:10.5.12+maria~focal');
  assert.equal(maria.engine, 'mariadb');
  assert.equal(maria.isMariaDB, true);
  assert.equal(maria.major, 10);
  assert.equal(maria.minor, 5);

  const my8 = SqlDiagnostics.detectServerEngine('8.4.3');
  assert.equal(my8.engine, 'mysql');
  assert.equal(my8.isMariaDB, false);
  assert.equal(my8.major, 8);
  assert.equal(my8.minor, 4);

  const my57 = SqlDiagnostics.detectServerEngine('5.7.35');
  assert.equal(my57.engine, 'mysql');
  assert.equal(my57.isMariaDB, false);
  assert.equal(my57.major, 5);
  assert.equal(my57.minor, 7);
});

test('getLockWaitersQuery selects appropriate schema based on engine version', () => {
  const q8 = SqlDiagnostics.getLockWaitersQuery({ engine: 'mysql', major: 8 });
  assert.ok(q8.includes('performance_schema.data_lock_waits'));

  const q57 = SqlDiagnostics.getLockWaitersQuery({ engine: 'mysql', major: 5 });
  assert.ok(q57.includes('information_schema.innodb_lock_waits'));

  const qMaria = SqlDiagnostics.getLockWaitersQuery({ engine: 'mariadb', major: 10 });
  assert.ok(qMaria.includes('information_schema.innodb_lock_waits'));
});

test('safeKillQuerySql and safeKillConnectionSql validate thread id and build correct SQL', () => {
  assert.equal(SqlDiagnostics.safeKillQuerySql(123), 'KILL QUERY 123');
  assert.equal(SqlDiagnostics.safeKillQuerySql('456'), 'KILL QUERY 456');
  assert.throws(() => SqlDiagnostics.safeKillQuerySql('123; DROP TABLE users;'), /hợp lệ/);
  assert.throws(() => SqlDiagnostics.safeKillQuerySql(''), /hợp lệ/);

  assert.equal(SqlDiagnostics.safeKillConnectionSql(789), 'KILL 789');
  assert.equal(SqlDiagnostics.safeKillConnectionSql('999'), 'KILL 999');
  assert.throws(() => SqlDiagnostics.safeKillConnectionSql('abc'), /hợp lệ/);
});
