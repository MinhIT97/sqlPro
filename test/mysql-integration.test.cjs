'use strict';

// Opt in against an isolated test server. Creates and removes only its own database.
const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSession } = require('../electron/database.cjs');

test('MySQL integration: snapshots, precise import, typed keys, full export and cancellation', {
  skip: !process.env.SQLPRO_TEST_MYSQL_PORT,
  timeout: 30000
}, async (t) => {
  const database = `sqlpro_test_${Date.now()}_${process.pid}`;
  const profile = { host: '127.0.0.1', port: Number(process.env.SQLPRO_TEST_MYSQL_PORT), user: 'root', password: '', database, ssl: { enabled: false }, ssh: { enabled: false } };
  const admin = await mysql.createConnection({ host: profile.host, port: profile.port, user: profile.user, jsonStrings: true });
  const sessions = [];
  const session = async () => { const value = new DatabaseSession(profile); sessions.push(value); await value.connect(); return value; };
  await admin.query(`CREATE DATABASE \`${database}\``);
  try {
    await admin.query(`USE \`${database}\``);
    await admin.query('CREATE TABLE parents (id INT PRIMARY KEY, value VARCHAR(50)) ENGINE=InnoDB');
    await admin.query('CREATE TABLE children (id INT PRIMARY KEY, value VARCHAR(50)) ENGINE=InnoDB');
    await admin.query("INSERT INTO parents VALUES (1,'before-parent')");
    await admin.query("INSERT INTO children VALUES (1,'before-child')");

    await t.test('backup sees one snapshot while another connection commits changes to both tables', async () => {
      const reader = await session();
      const raw = reader.raw.bind(reader);
      reader.raw = async (sql, params) => {
        const result = await raw(sql, params);
        if (sql === 'START TRANSACTION WITH CONSISTENT SNAPSHOT') {
          await admin.beginTransaction();
          await admin.query("UPDATE parents SET value='after-parent'");
          await admin.query("UPDATE children SET value='after-child'");
          await admin.commit();
        }
        return result;
      };
      let output = '';
      const result = await reader.writeBackup({ database, includeStructure: false }, async (chunk) => { output += chunk; });
      assert.equal(result.snapshot, true);
      assert.ok(output.includes('before-parent') && output.includes('before-child'));
      assert.ok(!output.includes('after-parent') && !output.includes('after-child'));
      assert.equal((await admin.query('SELECT value FROM parents'))[0][0].value, 'after-parent');
      await reader.close();
    });

    await t.test('independent backup does not commit or roll back the caller transaction', async () => {
      await admin.beginTransaction();
      await admin.query("UPDATE parents SET value='pending-parent'");
      const reader = await session();
      let output = '';
      await reader.writeBackup({ database, tables: ['parents'], includeStructure: false }, async (chunk) => { output += chunk; });
      assert.ok(output.includes('after-parent') && !output.includes('pending-parent'));
      assert.equal((await admin.query('SELECT value FROM parents'))[0][0].value, 'pending-parent');
      await admin.rollback();
      assert.equal((await admin.query('SELECT value FROM parents'))[0][0].value, 'after-parent');
      await reader.close();
    });

    await admin.query('CREATE TABLE items (id BIGINT UNSIGNED PRIMARY KEY, payload JSON, flags BIT(4), raw VARBINARY(128))');
    await t.test('import keeps special JSON keys, nested large numbers and BIT bytes', async () => {
      const reader = await session();
      const filePath = path.join(os.tmpdir(), `${database}.json`);
      await fs.writeFile(filePath, '[{"id":9007199254740993,"payload":{"__proto__":{"keep":18446744073709551615},"n":9007199254740993},"flags":"1010","raw":"0x00ff"}]');
      try {
        await reader.importFile({ database, table: 'items', filePath, format: 'json', transaction: 'all' });
        const [rows] = await admin.query('SELECT CAST(id AS CHAR) AS id, payload, HEX(flags) AS flags, HEX(raw) AS raw FROM items');
        assert.equal(rows[0].id, '9007199254740993');
        assert.equal(rows[0].flags, 'A');
        assert.equal(rows[0].raw, '00FF');
        assert.match(rows[0].payload, /18446744073709551615/);
        assert.match(rows[0].payload, /9007199254740993/);
        assert.equal(Object.hasOwn(JSON.parse(rows[0].payload), '__proto__'), true);
      } finally { await fs.unlink(filePath); await reader.close(); }
    });

    await t.test('binary primary keys round-trip through insert, grid, update and delete', async () => {
      await admin.query('CREATE TABLE typed_keys (id VARBINARY(8) PRIMARY KEY, flags BIT(4), label VARCHAR(30))');
      const reader = await session();
      await reader.insertRow({ database, table: 'typed_keys', values: { id: '0x00ff', flags: '1010', label: 'old' } });
      const grid = await reader.tableData({ database, table: 'typed_keys' });
      assert.equal(grid.rows[0].id, '0x00ff');
      await reader.updateRow({ database, table: 'typed_keys', keys: { id: grid.rows[0].id }, values: { label: 'new', flags: '0101' } });
      assert.equal((await admin.query('SELECT label, HEX(flags) AS flags FROM typed_keys'))[0][0].flags, '5');
      assert.equal((await reader.deleteRows({ database, table: 'typed_keys', keysList: [{ id: grid.rows[0].id }] })).affectedRows, 1);
      await reader.close();
    });

    await t.test('keyset pages and exact filters preserve composite order in both directions', async () => {
      await admin.query('CREATE TABLE pages (tenant INT, id INT, label VARCHAR(20), PRIMARY KEY(tenant,id))');
      await admin.query("INSERT INTO pages VALUES (1,1,'same'),(1,2,'same'),(1,3,'same'),(2,1,'same'),(2,2,'other')");
      const reader = await session();
      const options = { database, table: 'pages', pageSize: 2 };
      const first = await reader.tableData(options);
      assert.equal(first.total, null);
      const second = await reader.tableData({ ...options, page: 2, cursor: first.nextCursor });
      assert.equal(second.pagination, 'keyset');
      assert.deepEqual(second.rows.map((row) => [row.tenant, row.id]), [[1, 3], [2, 1]]);
      const back = await reader.tableData({ ...options, page: 1, cursor: second.previousCursor });
      assert.deepEqual(back.rows, first.rows);
      assert.equal((await reader.countTableRows(options)).total, 5);
      assert.equal((await reader.tableData({ ...options, orderBy: 'label' })).total, 5);
      const exact = await reader.tableData({ ...options, searchColumn: 'label', searchMode: 'exact', search: 'other' });
      assert.equal(exact.rows.length, 1); assert.equal(exact.rows[0].tenant, 2);
      await reader.close();
    });

    await t.test('row/byte limits stop a real query while retaining the connection and caller transaction', async () => {
      const reader = await session();
      await reader.runQuery('START TRANSACTION');
      await reader.runQuery("UPDATE parents SET value='limited-pending'");
      const result = await reader.runQuery("WITH RECURSIVE seq AS (SELECT 1 AS n UNION ALL SELECT n+1 FROM seq WHERE n<1000) SELECT n,SLEEP(0.001),REPEAT('x',100) FROM seq", 5000, 2);
      assert.equal(result.rows.length, 2); assert.equal(result.truncationReason, 'row-limit');
      assert.equal(result.stoppedEarly, true); assert.equal(reader.dead, false); assert.equal(reader.inTransaction, true);
      assert.equal((await reader.raw('SELECT value FROM parents')).rows[0].value, 'limited-pending');
      await reader.runQuery('ROLLBACK');
      assert.equal(reader.inTransaction, false);
      assert.equal((await reader.raw('SELECT value FROM parents')).rows[0].value, 'after-parent');
      const large = await reader.runQuery("SELECT REPEAT('x',1000) AS value", 5000, 10, 100);
      assert.equal(large.rows.length, 0); assert.equal(large.truncationReason, 'byte-limit');
      assert.equal(String((await reader.runQuery('SELECT 1')).rows[0][0]), '1');
      await reader.close();
    });

    await t.test('one-row SQL export keeps full BLOB, native JSON and special/duplicate column names', async () => {
      const bytes = Buffer.alloc(64, 0xab);
      await admin.query('UPDATE items SET raw=?', [bytes]);
      const reader = await session();
      let output = '';
      await reader.exportQueryFile({ sql: 'SELECT raw, payload, id AS same, flags AS same, payload AS `__proto__` FROM items', format: 'json' }, async (chunk) => { output += chunk; });
      const row = JSON.parse(output)[0];
      assert.equal(row.raw, `0x${bytes.toString('hex')}`);
      assert.equal(typeof row.payload, 'object');
      assert.equal(Object.hasOwn(row, '__proto__'), true);
      assert.equal(Object.hasOwn(row, 'same_2'), true);
      assert.ok(output.includes('18446744073709551615'));
      await reader.close();
    });

    await t.test('mixed storage engines expose the lack of a shared snapshot', async () => {
      await admin.query('CREATE TABLE legacy (id INT PRIMARY KEY) ENGINE=MyISAM');
      const reader = await session();
      const result = await reader.writeBackup({ database, tables: ['parents', 'legacy'], includeStructure: false }, async () => {});
      assert.equal(result.snapshot, false);
      assert.equal(result.warnings.length, 1);
      await reader.close();
    });

    await t.test('canceling a streamed export stops work and clears the active task', async () => {
      const reader = await session();
      await assert.rejects(reader.exportQueryFile({
        sql: "WITH RECURSIVE seq AS (SELECT 1 AS n UNION ALL SELECT n+1 FROM seq WHERE n<500) SELECT REPEAT('x',4096) AS value FROM seq",
        format: 'csv', taskId: 'cancel-export'
      }, async () => { reader.cancelTask('cancel-export'); }), { code: 'EXPORT_CANCELED' });
      assert.equal(reader.activeTask, null);
      assert.equal(reader.dead, true);
      await reader.close();
    });
  } finally {
    await admin.rollback();
    await Promise.allSettled(sessions.map((value) => value.close()));
    await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});
