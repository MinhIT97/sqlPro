'use strict';

// Opt in against an isolated test server. Creates and removes only its own database.
const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSession } = require('../electron/database.cjs');
const { saveBackupFile, readManifest } = require('../electron/backup-file.cjs');

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

    await t.test('updates confirm matched rows even for unchanged values and reject deleted or moved keys', async () => {
      await admin.query('CREATE TABLE update_outcomes (id INT PRIMARY KEY, label VARCHAR(30))');
      await admin.query("INSERT INTO update_outcomes VALUES (1,'same')");
      const reader = await session();
      const input = { database, table: 'update_outcomes', keys: { id: 1 }, values: { label: 'same' } };
      const unchanged = await reader.updateRow(input);
      assert.equal(unchanged.status, 'unchanged');
      assert.equal(unchanged.matchedRows, 1);
      assert.equal((await reader.updateRow({ ...input, values: { label: 'new' } })).status, 'updated');
      await admin.query('UPDATE update_outcomes SET id=2 WHERE id=1');
      await assert.rejects(reader.updateRow(input), { code: 'ROW_NOT_FOUND' });
      await admin.query('DELETE FROM update_outcomes');
      await assert.rejects(reader.updateRow({ ...input, keys: { id: 2 } }), { code: 'ROW_NOT_FOUND' });
      await reader.close();
    });

    await t.test('guarded deletes respect autocommit off and only roll back their own savepoint', async () => {
      await admin.query('CREATE TABLE guarded_deletes (id INT PRIMARY KEY, label VARCHAR(30)) ENGINE=InnoDB');
      await admin.query("INSERT INTO guarded_deletes VALUES (1,'one'),(2,'two')");
      const reader = await session();
      const input = { database, table: 'guarded_deletes', keysList: [{ id: 1 }], originalValues: [{ id: 1, label: 'one' }] };
      await reader.raw('SET autocommit=0');
      await reader.deleteRows(input);
      assert.equal(reader.autocommit, false);
      assert.equal(reader.inTransaction, true);
      assert.equal((await admin.query('SELECT COUNT(*) AS n FROM guarded_deletes'))[0][0].n, 2);
      await reader.raw('ROLLBACK');
      assert.equal((await admin.query('SELECT COUNT(*) AS n FROM guarded_deletes'))[0][0].n, 2);

      await reader.raw("UPDATE guarded_deletes SET label='pending' WHERE id=2");
      await assert.rejects(reader.deleteRows({ ...input, originalValues: [{ id: 1, label: 'stale' }] }), { code: 'ROW_CONFLICT' });
      assert.equal((await reader.raw('SELECT label FROM guarded_deletes WHERE id=2')).rows[0].label, 'pending');
      assert.equal((await admin.query('SELECT label FROM guarded_deletes WHERE id=2'))[0][0].label, 'two');
      assert.equal(reader.autocommit, false);
      const raw = reader.raw.bind(reader);
      // Force a failure after DELETE executes; rollback must preserve the caller's prior UPDATE.
      reader.raw = async (sql, params) => {
        const result = await raw(sql, params);
        if (/^DELETE/.test(sql)) result.result.affectedRows = 0;
        return result;
      };
      await assert.rejects(reader.deleteRows(input), { code: 'ROW_CONFLICT' });
      reader.raw = raw;
      assert.equal(Number((await reader.raw('SELECT COUNT(*) AS n FROM guarded_deletes')).rows[0].n), 2);
      assert.equal((await reader.raw('SELECT label FROM guarded_deletes WHERE id=2')).rows[0].label, 'pending');
      await reader.raw('COMMIT');
      assert.equal((await admin.query('SELECT label FROM guarded_deletes WHERE id=2'))[0][0].label, 'pending');
      assert.equal(reader.autocommit, false);
      await reader.close();
    });

    await t.test('original text guards distinguish case, accents, spaces and literal ellipses', async () => {
      await admin.query('CREATE TABLE guarded_text (id INT PRIMARY KEY, label VARCHAR(30) COLLATE utf8mb4_0900_ai_ci)');
      await admin.query("INSERT INTO guarded_text VALUES (1,'alice')");
      const reader = await session();
      for (const [before, after] of [['alice', 'ALICE'], ['cafe', 'café'], ['alice', 'alice '], ['complete…text', 'changed elsewhere']]) {
        await admin.query('UPDATE guarded_text SET label=? WHERE id=1', [before]);
        const original = (await reader.tableData({ database, table: 'guarded_text' })).rows[0];
        await admin.query('UPDATE guarded_text SET label=? WHERE id=1', [after]);
        await assert.rejects(reader.updateRow({ database, table: 'guarded_text', keys: { id: 1 }, original, values: { label: 'draft' } }), { code: 'ROW_CONFLICT' });
        await assert.rejects(reader.deleteRows({ database, table: 'guarded_text', keysList: [{ id: 1 }], originalValues: [original] }), { code: 'ROW_CONFLICT' });
        assert.equal((await admin.query('SELECT label FROM guarded_text'))[0][0].label, after);
      }
      await reader.close();
    });

    await t.test('JSON document originals match unchanged objects, arrays, scalars and SQL/JSON null', async () => {
      await admin.query('CREATE TABLE guarded_json (id INT PRIMARY KEY, payload JSON, label VARCHAR(30))');
      const documents = ['{"n":18446744073709551615,"__proto__":{"safe":true}}', '[1,"x",null]', '"text"', 'null', null, '9007199254740993'];
      for (let index = 0; index < documents.length; index += 1) await admin.query('INSERT INTO guarded_json VALUES (?, ?, ?)', [index + 1, documents[index], 'before']);
      const reader = await session();
      const rows = (await reader.tableData({ database, table: 'guarded_json' })).rows;
      for (const original of rows) {
        const result = await reader.updateRow({ database, table: 'guarded_json', keys: { id: original.id }, original, values: { label: 'after' } });
        assert.equal(result.status, 'updated');
      }
      const original = (await reader.tableData({ database, table: 'guarded_json' })).rows[0];
      await admin.query("UPDATE guarded_json SET payload=JSON_OBJECT('n',1) WHERE id=1");
      await assert.rejects(reader.updateRow({ database, table: 'guarded_json', keys: { id: 1 }, original, values: { label: 'stale' } }), { code: 'ROW_CONFLICT' });
      await reader.close();
    });

    await t.test('full binary hashes guard changes hidden behind identical grid and SQL previews', async () => {
      await admin.query('CREATE TABLE guarded_blob (id INT PRIMARY KEY, payload BLOB, label VARCHAR(30))');
      const bytes = Buffer.alloc(64, 1);
      await admin.query('INSERT INTO guarded_blob VALUES (1, ?, ?)', [bytes, 'before']);
      const reader = await session();
      const data = await reader.tableData({ database, table: 'guarded_blob' });
      const query = await reader.runQuery('SELECT id, payload, label FROM guarded_blob');
      assert.equal(data.originalHashes[0].payload.kind, 'sha256');
      assert.deepEqual(query.originalHashes[0][1], data.originalHashes[0].payload);
      const original = { ...data.rows[0], ...data.originalHashes[0] };
      await reader.updateRow({ database, table: 'guarded_blob', keys: { id: 1 }, original, values: { label: 'after' } });
      original.label = 'after';
      const changed = Buffer.from(bytes); changed[63] = 2;
      await admin.query('UPDATE guarded_blob SET payload=? WHERE id=1', [changed]);
      const current = await reader.tableData({ database, table: 'guarded_blob' });
      assert.equal(current.rows[0].payload, data.rows[0].payload);
      await assert.rejects(reader.updateRow({ database, table: 'guarded_blob', keys: { id: 1 }, original, values: { label: 'stale' } }), { code: 'ROW_CONFLICT' });
      await assert.rejects(reader.deleteRows({ database, table: 'guarded_blob', keysList: [{ id: 1 }], originalValues: [original] }), { code: 'ROW_CONFLICT' });
      await reader.close();
    });

    await t.test('restore rejects database/global changes before writing and verifies clean row counts', async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-restore-safe-'));
      const filePath = path.join(directory, 'fixture.sql');
      const reader = await session();
      try {
        for (const statement of ['ALTER DATABASE mysql DEFAULT CHARACTER SET latin1', 'SET GLOBAL max_connections=25', 'SET PERSIST sql_mode=""', 'FLUSH TABLES WITH READ LOCK']) {
          await fs.writeFile(filePath, `CREATE TABLE never_written (id INT);\n${statement};\n`);
          await assert.rejects(reader.restoreDatabase({ database, filePath }), { code: 'RESTORE_SCOPE_REJECTED' });
          assert.equal((await admin.query("SHOW TABLES LIKE 'never_written'"))[0].length, 0);
        }
        await fs.writeFile(filePath, 'SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE="NO_AUTO_VALUE_ON_ZERO";\nCREATE TABLE verified_rows (id INT PRIMARY KEY);\nINSERT INTO verified_rows VALUES (1),(2);\nSET SQL_MODE=@OLD_SQL_MODE;\n');
        const result = await reader.restoreDatabase({ database, filePath });
        assert.equal(result.verification.status, 'verified');
        assert.equal(result.verification.checks.rowCounts.checked, 1);
        assert.equal(result.verification.limitations.length, 0);
      } finally { await reader.close(); await fs.rm(directory, { recursive: true, force: true }); }
    });

    await t.test('backup manifest checksum and restore round-trip preserve schema, FK and sample values', async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-roundtrip-'));
      const targetDb = `${database}_rt`;
      const backupPath = path.join(directory, 'roundtrip.sql');
      const reader = await session();
      try {
        await admin.query('CREATE TABLE rt_parents (id INT PRIMARY KEY, name VARCHAR(30)) ENGINE=InnoDB');
        await admin.query('CREATE TABLE rt_children (id INT PRIMARY KEY, parent_id INT, note VARCHAR(30), CONSTRAINT fk_rt_parent FOREIGN KEY (parent_id) REFERENCES rt_parents(id)) ENGINE=InnoDB');
        await admin.query("INSERT INTO rt_parents VALUES (1,'alpha'),(2,'beta')");
        await admin.query("INSERT INTO rt_children VALUES (10,1,'one'),(11,1,'two'),(12,2,'three')");
        const saved = await saveBackupFile(backupPath, (write) =>
          reader.writeBackup({ database, tables: ['rt_parents', 'rt_children'] }, write), {
          source: { database }
        });
        assert.equal(saved.verification.checksum, 'verified');
        assert.equal(saved.verification.restore, 'not-tested');
        const manifest = await readManifest(backupPath);
        assert.equal(manifest.error, null);
        assert.equal(manifest.manifest.checksum.value, saved.checksum);
        assert.deepEqual(manifest.manifest.selection.tables, ['rt_parents', 'rt_children']);

        await admin.query(`DROP DATABASE IF EXISTS \`${targetDb}\``);
        const result = await reader.restoreDatabase({ database: targetDb, filePath: backupPath, createDatabaseIfNotExists: true });
        assert.equal(result.verification.status, 'verified');
        assert.equal(result.preflight.canProceed, true);
        const [values] = await admin.query(`SELECT p.name, SUM(c.id) AS child_sum, COUNT(*) AS child_count
          FROM \`${targetDb}\`.rt_parents p JOIN \`${targetDb}\`.rt_children c ON c.parent_id = p.id
          GROUP BY p.id ORDER BY p.id`);
        assert.deepEqual(values, [
          { name: 'alpha', child_sum: '21', child_count: 2 },
          { name: 'beta', child_sum: '12', child_count: 1 }
        ]);
        const [fk] = await admin.query(`SELECT CONSTRAINT_NAME AS name FROM information_schema.REFERENTIAL_CONSTRAINTS
          WHERE CONSTRAINT_SCHEMA=? AND TABLE_NAME='rt_children'`, [targetDb]);
        assert.equal(fk.length, 1);
        assert.equal(fk[0].name, 'fk_rt_parent');
      } finally {
        await reader.close();
        await admin.query(`DROP DATABASE IF EXISTS \`${targetDb}\``);
        await fs.rm(directory, { recursive: true, force: true });
      }
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
