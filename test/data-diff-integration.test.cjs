'use strict';

// This opt-in suite only creates/removes its own marked schema on a disposable server.
const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { DatabaseSession } = require('../electron/database.cjs');
const Diff = require('../data-diff.js');

test('data diff observes exact typed rows without treating a LIMIT sample as synchronization authority', {
  skip: !process.env.SQLPRO_DATA_DIFF_PORT, timeout: 30000
}, async t => {
  const database = `sqlpro_diff_${Date.now()}_${process.pid}`;
  assert.match(database, /^sqlpro_diff_[0-9]+_[0-9]+$/);
  const port = Number(process.env.SQLPRO_DATA_DIFF_PORT);
  const admin = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root' });
  const session = new DatabaseSession({ host: '127.0.0.1', port, user: 'root', database, ssl: { enabled: false }, ssh: { enabled: false } });
  const marker = `data-diff-${process.pid}`;
  await admin.query(`CREATE DATABASE \`${database}\``);
  try {
    await admin.query(`USE \`${database}\``);
    await admin.query('CREATE TABLE __sqlpro_fixture_marker (marker VARCHAR(80))');
    await admin.execute('INSERT INTO __sqlpro_fixture_marker VALUES (?)', [marker]);
    for (const table of ['src', 'dst']) await admin.query(`CREATE TABLE ${table} (a VARCHAR(50), b VARCHAR(50), amount DECIMAL(40,6), doc JSON, happened DATETIME(6), PRIMARY KEY(a,b)) ENGINE=InnoDB`);
    const first = ['a::b', 'c', '12345678901234567890.000001', '{"n":9007199254740993}', '2026-11-17 12:00:00.123456'];
    const second = ['a', 'b::c', '1.000000', '{"n":1}', '2026-11-17 12:00:00.123456'];
    await admin.execute('INSERT INTO src VALUES (?,?,?,?,?)', first);
    await admin.execute('INSERT INTO src VALUES (?,?,?,?,?)', second);
    await admin.execute('INSERT INTO dst VALUES (?,?,?,?,?)', [...first.slice(0, 2), '12345678901234567890.000002', '{"n":9007199254740992}', '2026-11-17 12:00:00.123457']);
    await admin.execute('INSERT INTO dst VALUES (?,?,?,?,?)', second);
    await session.connect();
    const metadata = await session.listColumns(database, 'src');
    const query = table => `SELECT a,b,amount,doc,happened FROM \`${database}\`.${table} ORDER BY a,b LIMIT 200`;
    const source = await session.runQuery(query('src'));
    const target = await session.runQuery(query('dst'));
    await t.test('real driver retains decimal, JSON numeric lexemes and temporal microseconds', () => {
      const report = Diff.compareTableData({ sourceRows: source.rows, targetRows: target.rows, primaryKeys: ['a', 'b'], columns: metadata });
      assert.equal(report.summary.identicalCount, 1);
      assert.equal(report.summary.differentCount, 1);
      assert.deepEqual(report.different[0].differences.map(column => column.column), ['amount', 'doc', 'happened']);
      assert.equal(report.different[0].differences[0].sourceValue, first[2]);
      assert.equal(report.different[0].differences[0].targetValue, '12345678901234567890.000002');
      assert.equal(report.coverage.canSynchronize, false);
    });
    await t.test('different LIMIT samples never authorize DELETE or other generated writes', () => {
      const report = Diff.compareTableData({ sourceRows: source.rows.slice(0, 1), targetRows: target.rows, primaryKeys: ['a', 'b'], columns: metadata });
      assert.equal(report.summary.onlyInTargetCount, 1);
      assert.equal(report.coverage.complete, false);
      assert.equal(Diff.generateSyncSql({ diffResult: report, options: { includeDeletes: true } }).statements.length, 0);
    });
    assert.equal((await admin.query('SELECT COUNT(*) AS n FROM dst'))[0][0].n, 2);
  } finally {
    await session.close();
    const record = (await admin.query(`SELECT marker FROM \`${database}\`.__sqlpro_fixture_marker`))[0][0];
    assert.equal(record.marker, marker);
    await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});
