'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSession } = require('../electron/database.cjs');
const { saveBackupFile } = require('../electron/backup-file.cjs');
const { RestoreSelectionInventory, previewRestoreSelection } = require('../electron/restore-selection.cjs');
const { assertStatementScope } = require('../electron/sql-script.cjs');
const { collectSelectionTargetFacts, buildSelectionTargetPreview } = require('../electron/restore-selection-target.cjs');
const { buildSelectionDraft } = require('../electron/restore-selection-plan.cjs');

test('temporal preview integration: calendar and precision review without date conversion or writes', {
  skip: !process.env.SQLPRO_TEST_TEMPORAL_PORT, timeout: 30000
}, async t => {
  const database = `sqlpro_temporal_${Date.now()}_${process.pid}`;
  const profile = { host: '127.0.0.1', port: Number(process.env.SQLPRO_TEST_TEMPORAL_PORT), user: 'root', password: '', database,
    ssl: { enabled: false }, ssh: { enabled: false } };
  const admin = await mysql.createConnection({ host: profile.host, port: profile.port, user: profile.user });
  const reader = new DatabaseSession(profile), editor = new DatabaseSession(profile), backup = new DatabaseSession(profile);
  let created = false;
  const strictMode = 'STRICT_ALL_TABLES,NO_ZERO_DATE,NO_ZERO_IN_DATE,NO_ENGINE_SUBSTITUTION';
  try {
    await admin.query(`CREATE DATABASE \`${database}\``); created = true; await admin.query(`USE \`${database}\``);
    await admin.query('SET SESSION sql_mode=?', [strictMode]);
    await reader.connect(); await editor.connect(); await backup.connect(); await editor.runQuery('START TRANSACTION');
    const settings = session => session.raw('SELECT CONNECTION_ID() AS id, @@SESSION.sql_mode AS mode, @@SESSION.autocommit AS auto, @@SESSION.time_zone AS zone');
    const beforeReader = (await settings(reader)).rows, beforeEditor = (await settings(editor)).rows;
    const queries = [], raw = reader.raw.bind(reader);
    reader.raw = async (sql, ...args) => { queries.push(sql); return raw(sql, ...args); };
    const build = async (inventory, table, checksum = 'a'.repeat(64)) => {
      const source = previewRestoreSelection(inventory, { tables: [table], includeStructure: false });
      const facts = await collectSelectionTargetFacts(reader, database, () => {}, source.selectedTables);
      assert.deepEqual(facts.errors, []);
      const targetIdentity = 'b'.repeat(64), targetReview = buildSelectionTargetPreview({ source, checksum, targetIdentity, facts });
      const draft = buildSelectionDraft({ inventory, source, checksum, targetIdentity, targetReview });
      assert.equal(draft.canExecute, false);
      return { draft, targetReview };
    };
    const preview = (table, type, values) => {
      const collector = new RestoreSelectionInventory(database);
      [`CREATE TABLE \`${table}\` (\`v\` ${type}) ENGINE=InnoDB`, ...values.map(value => `INSERT INTO \`${table}\` VALUES('${value}')`)]
        .forEach((sql, i) => collector.add(sql, assertStatementScope(sql, database), i + 1));
      return build(collector.finish(), table);
    };

    await t.test('DATE endpoints and Gregorian leap days agree with strict storage; preview writes no rows', async () => {
      await admin.query('CREATE TABLE dates_sample (v DATE) ENGINE=InnoDB');
      const valid = ['1000-01-01', '2000-02-29', '2024-02-29', '9999-12-31'], invalid = ['1900-02-29', '2024-04-31', '2024-13-01'];
      const result = await preview('dates_sample', 'DATE', [...valid, ...invalid]);
      assert.deepEqual(result.draft.valueReview.rows.map(row => row.status), [...valid.map(() => 'basic-checked'), ...invalid.map(() => 'issues')]);
      assert.equal(Number((await admin.query('SELECT COUNT(*) AS n FROM dates_sample'))[0][0].n), 0);
      for (const value of valid) await admin.query('INSERT INTO dates_sample VALUES(?)', [value]);
      assert.deepEqual((await admin.query('SELECT CAST(v AS CHAR) AS v FROM dates_sample ORDER BY v'))[0].map(row => row.v), valid);
      for (const value of invalid) await assert.rejects(admin.query('INSERT INTO dates_sample VALUES(?)', [value]), error => error.errno === 1292);
      assert.equal(JSON.stringify(result.draft).includes('2000-02-29'), false);
    });

    await t.test('zero and invalid dates remain policy issues even when a relaxed fixture accepts them', async () => {
      const values = ['0000-00-00', '2024-00-01', '2024-02-30'];
      const result = await preview('dates_sample', 'DATE', values);
      assert.ok(result.draft.valueReview.rows.every(row => row.status === 'issues'));
      for (const value of values) await assert.rejects(admin.query('INSERT INTO dates_sample VALUES(?)', [value]), error => error.errno === 1292);
      try {
        await admin.query("SET SESSION sql_mode='ALLOW_INVALID_DATES,NO_ENGINE_SUBSTITUTION'");
        for (const value of values) await admin.query('INSERT INTO dates_sample VALUES(?)', [value]);
        const observed = (await admin.query("SELECT CAST(v AS CHAR) AS v FROM dates_sample WHERE v IN ('0000-00-00','2024-00-01','2024-02-30') ORDER BY v"))[0].map(row => row.v);
        assert.deepEqual(observed, values);
        assert.ok((await preview('dates_sample', 'DATE', values)).draft.valueReview.rows.every(row => row.status === 'issues'));
      } finally { await admin.query('SET SESSION sql_mode=?', [strictMode]); }
    });

    await t.test('DATETIME precision loss is blocked; trailing-zero fractions remain exact and ALTER changes binding', async () => {
      await admin.query('CREATE TABLE datetimes_sample (v DATETIME(3)) ENGINE=InnoDB');
      const values = ['2024-02-29 01:02:03.123456', '2024-02-29 01:02:03.120000', '2024-02-29 24:00:00'];
      const initial = await preview('datetimes_sample', 'DATETIME(6)', values);
      assert.deepEqual(initial.draft.valueReview.rows.map(row => row.fields[0].target.status), ['issues', 'basic-checked', 'issues']);
      assert.equal(Number((await admin.query('SELECT COUNT(*) AS n FROM datetimes_sample'))[0][0].n), 0);
      await admin.query('INSERT INTO datetimes_sample VALUES(?)', [values[0]]);
      assert.notEqual((await admin.query('SELECT CAST(v AS CHAR) AS v FROM datetimes_sample'))[0][0].v, values[0]);
      await assert.rejects(admin.query('INSERT INTO datetimes_sample VALUES(?)', [values[2]]), error => error.errno === 1292);
      await admin.query('ALTER TABLE datetimes_sample MODIFY v DATETIME(6)');
      const changed = await preview('datetimes_sample', 'DATETIME(6)', values);
      assert.equal(changed.draft.valueReview.rows[0].status, 'basic-checked');
      assert.notEqual(initial.targetReview.snapshotId, changed.targetReview.snapshotId); assert.notEqual(initial.draft.planId, changed.draft.planId);
      const unsupported = await preview('datetimes_sample', 'DATETIME(6)', ['20240229010203', '2024-02-29T01:02:03Z', '9999-12-31 23:59:59.999999']);
      assert.ok(unsupported.draft.valueReview.rows.every(row => row.status === 'unknown'));
    });

    await t.test('TIME durations preserve negative values, hours above 23 and exact endpoints without preview writes', async () => {
      await admin.query('CREATE TABLE times_sample (v TIME(6)) ENGINE=InnoDB');
      const values = ['00:00:00.000000', '24:01:02.123456', '-123:45:56.120000', '838:59:59.000000', '-838:59:59.000000'];
      const result = await preview('times_sample', 'TIME(6)', values);
      assert.ok(result.draft.valueReview.rows.every(row => row.status === 'basic-checked'));
      assert.equal(Number((await admin.query('SELECT COUNT(*) AS n FROM times_sample'))[0][0].n), 0);
      for (const value of values) await admin.query('INSERT INTO times_sample VALUES(?)', [value]);
      assert.deepEqual(new Set((await admin.query('SELECT CAST(v AS CHAR) AS v FROM times_sample'))[0].map(row => row.v)), new Set(values));
      assert.equal(JSON.stringify(result.draft).includes('123:45:56'), false);
    });

    await t.test('out-of-range TIME is rejected under strict mode and remains an issue when a relaxed server clips it', async () => {
      const values = ['839:00:00', '-839:00:00', '12:60:00'];
      const result = await preview('times_sample', 'TIME(6)', values);
      assert.ok(result.draft.valueReview.rows.every(row => row.status === 'issues'));
      for (const value of values) await assert.rejects(admin.query('INSERT INTO times_sample VALUES(?)', [value]), error => [1264, 1292].includes(error.errno));
      assert.equal(Number((await admin.query('SELECT COUNT(*) AS n FROM times_sample'))[0][0].n), 5);
      await admin.query('CREATE TABLE time_clipping (v TIME(6)) ENGINE=InnoDB');
      try {
        await admin.query("SET SESSION sql_mode=''");
        await admin.query("INSERT INTO time_clipping VALUES('839:00:00')");
        const clipped = (await admin.query('SELECT CAST(v AS CHAR) AS v FROM time_clipping'))[0][0].v;
        // MySQL 8.4 clips at a whole second; MariaDB 11.4 keeps its fractional endpoint.
        assert.ok(['838:59:59.000000', '838:59:59.999999'].includes(clipped));
        assert.equal((await preview('time_clipping', 'TIME(6)', [clipped])).draft.valueReview.rows[0].status,
          clipped.endsWith('.999999') ? 'unknown' : 'basic-checked');
        assert.equal((await preview('time_clipping', 'TIME(6)', ['839:00:00'])).draft.valueReview.rows[0].status, 'issues');
      } finally { await admin.query('SET SESSION sql_mode=?', [strictMode]); }
    });

    await t.test('TIME precision loss and ALTER precision bind the report, while abbreviated/boundary formats stay unknown', async () => {
      await admin.query('CREATE TABLE time_precision (v TIME(3)) ENGINE=InnoDB');
      const values = ['-123:45:56.123456', '24:01:02.120000'];
      const initial = await preview('time_precision', 'TIME(6)', values);
      assert.deepEqual(initial.draft.valueReview.rows.map(row => row.fields[0].target.status), ['issues', 'basic-checked']);
      assert.equal(Number((await admin.query('SELECT COUNT(*) AS n FROM time_precision'))[0][0].n), 0);
      await admin.query('INSERT INTO time_precision VALUES(?)', [values[0]]);
      assert.notEqual((await admin.query('SELECT CAST(v AS CHAR) AS v FROM time_precision'))[0][0].v, values[0]);
      await admin.query('ALTER TABLE time_precision MODIFY v TIME(6)');
      const changed = await preview('time_precision', 'TIME(6)', values);
      assert.ok(changed.draft.valueReview.rows.every(row => row.status === 'basic-checked'));
      assert.notEqual(initial.targetReview.snapshotId, changed.targetReview.snapshotId); assert.notEqual(initial.draft.planId, changed.draft.planId);
      const unknown = await preview('time_precision', 'TIME(6)', ['12:34', '123456', '838:59:59.000001', '-838:59:59.000001']);
      assert.ok(unknown.draft.valueReview.rows.every(row => row.status === 'unknown'));
    });

    await t.test('YEAR exact endpoints and numeric zero agree with storage, with no writes during preview', async () => {
      await admin.query('CREATE TABLE years_sample (v YEAR) ENGINE=InnoDB');
      const collector = new RestoreSelectionInventory(database), inserts = ['0', '1901', '2155', "'1901'", "'2155'"].map(value => `INSERT INTO years_sample VALUES(${value})`);
      ['CREATE TABLE `years_sample` (`v` YEAR) ENGINE=InnoDB', ...inserts].forEach((sql, i) => collector.add(sql, assertStatementScope(sql, database), i + 1));
      const result = await build(collector.finish(), 'years_sample');
      assert.ok(result.draft.valueReview.rows.every(row => row.status === 'basic-checked'));
      assert.equal(Number((await admin.query('SELECT COUNT(*) AS n FROM years_sample'))[0][0].n), 0);
      for (const sql of inserts) await admin.query(sql);
      assert.deepEqual((await admin.query('SELECT v FROM years_sample ORDER BY v'))[0].map(row => Number(row.v)), [0, 1901, 1901, 2155, 2155]);
    });

    await t.test('YEAR rejects four-digit out-of-range values under strict mode and never certifies relaxed zero substitution', async () => {
      const values = ['1900', '2156'];
      const result = await preview('years_sample', 'YEAR', values);
      assert.ok(result.draft.valueReview.rows.every(row => row.status === 'issues'));
      for (const value of values) await assert.rejects(admin.query('INSERT INTO years_sample VALUES(?)', [value]), error => [1264, 1292].includes(error.errno));
      await admin.query('CREATE TABLE year_relaxed (v YEAR) ENGINE=InnoDB');
      try {
        await admin.query("SET SESSION sql_mode=''");
        await admin.query('INSERT INTO year_relaxed VALUES(2156)');
        assert.equal(Number((await admin.query('SELECT v FROM year_relaxed'))[0][0].v), 0);
        assert.equal((await preview('year_relaxed', 'YEAR', ['2156'])).draft.valueReview.rows[0].status, 'issues');
      } finally { await admin.query('SET SESSION sql_mode=?', [strictMode]); }
    });

    await t.test('short years and quoted zero remain unreviewed even when the server maps them to a century', async () => {
      const values = ['0', '00', '0000', '69', '70', '99'];
      const result = await preview('years_sample', 'YEAR', values);
      assert.ok(result.draft.valueReview.rows.every(row => row.status === 'unknown'));
      await admin.query('CREATE TABLE year_conversions (k INT, v YEAR) ENGINE=InnoDB');
      for (const [i, value] of values.entries()) await admin.query('INSERT INTO year_conversions VALUES(?,?)', [i, value]);
      const converted = (await admin.query('SELECT k, v FROM year_conversions ORDER BY k'))[0];
      assert.equal(Number(converted[0].v), 2000); assert.equal(Number(converted[1].v), 2000);
      assert.equal(Number(converted[3].v), 2069); assert.equal(Number(converted[4].v), 1970); assert.equal(Number(converted[5].v), 1999);
      assert.equal(result.draft.canExecute, false); assert.equal(JSON.stringify(result.draft).includes('2069'), false);
    });

    await t.test('TIMESTAMP flags calendar/zero/clock risks while valid local values still require zone and range proof', async () => {
      await admin.query('CREATE TABLE timestamps_sample (v TIMESTAMP(6) NULL DEFAULT NULL) ENGINE=InnoDB');
      const valid = '2024-02-29 01:02:03.123456', invalid = ['1900-02-29 01:02:03', '0000-00-00 00:00:00', '2024-02-29 24:00:00'];
      const result = await preview('timestamps_sample', 'TIMESTAMP(6)', [valid, ...invalid]);
      assert.deepEqual(result.draft.valueReview.rows.map(row => row.status), ['unknown', 'issues', 'issues', 'issues']);
      assert.ok(result.draft.valueReview.rows.every(row => row.fields[0].target.findings.includes('VALUE_TIMESTAMP_ZONE_RANGE_NOT_REVIEWED')));
      assert.equal(Number((await admin.query('SELECT COUNT(*) AS n FROM timestamps_sample'))[0][0].n), 0);
      for (const value of invalid) await assert.rejects(admin.query('INSERT INTO timestamps_sample VALUES(?)', [value]), error => [1264, 1292].includes(error.errno));
      await admin.query('INSERT INTO timestamps_sample VALUES(?)', [valid]);
      assert.equal((await admin.query('SELECT CAST(v AS CHAR) AS v FROM timestamps_sample'))[0][0].v, valid);
    });

    await t.test('TIMESTAMP precision drift changes the snapshot and plan without clearing the timezone gate', async () => {
      await admin.query('CREATE TABLE timestamp_precision (v TIMESTAMP(3) NULL DEFAULT NULL) ENGINE=InnoDB');
      const value = '2024-02-29 01:02:03.123456';
      const initial = await preview('timestamp_precision', 'TIMESTAMP(6)', [value]);
      assert.equal(initial.draft.valueReview.rows[0].fields[0].source.status, 'unknown');
      assert.equal(initial.draft.valueReview.rows[0].fields[0].target.status, 'issues');
      assert.equal(initial.draft.steps[1].reason, 'VALUE_BASIC_ISSUES');
      assert.equal(Number((await admin.query('SELECT COUNT(*) AS n FROM timestamp_precision'))[0][0].n), 0);
      await admin.query('INSERT INTO timestamp_precision VALUES(?)', [value]);
      assert.notEqual((await admin.query('SELECT CAST(v AS CHAR) AS v FROM timestamp_precision'))[0][0].v, value);
      await admin.query('ALTER TABLE timestamp_precision MODIFY v TIMESTAMP(6) NULL DEFAULT NULL');
      const changed = await preview('timestamp_precision', 'TIMESTAMP(6)', [value]);
      assert.equal(changed.draft.valueReview.rows[0].status, 'unknown');
      assert.notEqual(initial.targetReview.snapshotId, changed.targetReview.snapshotId); assert.notEqual(initial.draft.planId, changed.draft.planId);
      assert.ok(changed.draft.valueReview.rows[0].fields[0].target.findings.includes('VALUE_TIMESTAMP_ZONE_RANGE_NOT_REVIEWED'));
    });

    await t.test('the same TIMESTAMP text stores different instants across zones; preview never infers that instant or server range', async () => {
      const zone = (await admin.query('SELECT @@SESSION.time_zone AS zone'))[0][0].zone;
      await admin.query('CREATE TABLE timestamp_zones (v TIMESTAMP(6) NULL DEFAULT NULL) ENGINE=InnoDB');
      try {
        const value = '2024-02-29 01:02:03';
        await admin.query("SET SESSION time_zone='+00:00'");
        await admin.query('INSERT INTO timestamp_zones VALUES(?)', [value]);
        await admin.query("SET SESSION time_zone='+07:00'");
        await admin.query('INSERT INTO timestamp_zones VALUES(?)', [value]);
        const stored = (await admin.query('SELECT UNIX_TIMESTAMP(v) AS epoch FROM timestamp_zones ORDER BY epoch DESC'))[0];
        assert.equal(Number(stored[0].epoch) - Number(stored[1].epoch), 7 * 3600);
        const result = await preview('timestamp_zones', 'TIMESTAMP(6)', [value, '1970-01-01 00:00:00', '2038-01-19 03:14:07', '2106-02-07 06:28:15', '2024-03-10 02:30:00']);
        assert.ok(result.draft.valueReview.rows.every(row => row.status === 'unknown'));
        assert.ok(result.draft.valueReview.rows.every(row => row.fields[0].target.findings.includes('VALUE_TIMESTAMP_ZONE_RANGE_NOT_REVIEWED')));
        assert.equal(Number((await admin.query('SELECT COUNT(*) AS n FROM timestamp_zones'))[0][0].n), 2);
      } finally { await admin.query('SET SESSION time_zone=?', [zone]); }
    });

    await t.test('native TIMESTAMP backup keeps microsecond evidence but cannot certify the timezone or range', async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-timestamp-'));
      try {
        await admin.query('CREATE TABLE native_timestamp (v TIMESTAMP(6) NULL DEFAULT NULL) ENGINE=InnoDB');
        const value = '2024-02-29 01:02:03.123456';
        await admin.query('INSERT INTO native_timestamp VALUES(?)', [value]);
        const filePath = path.join(directory, 'backup.sql');
        const saved = await saveBackupFile(filePath, write => backup.backupDatabase({ database, tables: ['native_timestamp'], includeStructure: true, includeData: true }, write, () => {}));
        const scanner = new DatabaseSession({});
        const scanned = await scanner.scanRestoreInventoryInWorker({ filePath, database, selectionPreview: true, totalBytes: saved.bytes });
        const result = await build(scanned.inventory.selectionPreview, 'native_timestamp', saved.checksum);
        assert.ok(result.draft.valueReview.rows.length > 0);
        assert.ok(result.draft.valueReview.rows.every(row => row.status === 'unknown'));
        assert.ok(result.draft.valueReview.rows.every(row => row.fields[0].source.findings.includes('VALUE_TIMESTAMP_ZONE_RANGE_NOT_REVIEWED')));
        assert.ok(result.draft.valueReview.rows.every(row => row.fields[0].target.findings.includes('VALUE_TIMESTAMP_ZONE_RANGE_NOT_REVIEWED')));
        assert.ok(result.draft.valueReview.rows.some(row => row.fields.some(field => field.counts.temporalStrings > 0)));
        assert.equal(JSON.stringify(result.draft).includes(value), false); assert.equal(result.draft.canExecute, false);
        assert.equal((await admin.query('SELECT CAST(v AS CHAR) AS v FROM native_timestamp'))[0][0].v, value);
      } finally { await fs.rm(directory, { recursive: true, force: true }); }
    });

    await t.test('native backup and scan preserve DATE, TIME, YEAR and microseconds without exposing values in the draft', async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-temporal-'));
      try {
        await admin.query('CREATE TABLE native_temporal (d DATE, dt DATETIME(6), duration TIME(6), yr YEAR) ENGINE=InnoDB');
        await admin.query("INSERT INTO native_temporal VALUES('2024-02-29','2024-02-29 01:02:03.123456','-123:45:56.123456',2000)");
        const filePath = path.join(directory, 'backup.sql');
        const saved = await saveBackupFile(filePath, write => backup.backupDatabase({ database, tables: ['native_temporal'], includeStructure: true, includeData: true }, write, () => {}));
        const scanner = new DatabaseSession({});
        const scanned = await scanner.scanRestoreInventoryInWorker({ filePath, database, selectionPreview: true, totalBytes: saved.bytes });
        const result = await build(scanned.inventory.selectionPreview, 'native_temporal', saved.checksum);
        assert.ok(result.draft.valueReview.rows.length > 0);
        assert.ok(result.draft.valueReview.rows.every(row => row.status === 'basic-checked'), JSON.stringify(result.draft.valueReview.rows));
        assert.equal(JSON.stringify(result.draft).includes('2024-02-29'), false);
        assert.equal(JSON.stringify(result.draft).includes('123:45:56'), false);
        assert.ok(result.draft.valueReview.rows.some(row => row.fields.some(field => field.counts.temporalStrings > 0)));
        assert.ok(result.draft.valueReview.rows.some(row => row.fields.some(field => field.counts.yearLiterals > 0)));
        assert.equal(Number((await admin.query('SELECT yr FROM native_temporal'))[0][0].yr), 2000);
        assert.equal((await admin.query('SELECT CAST(dt AS CHAR) AS dt FROM native_temporal'))[0][0].dt, '2024-02-29 01:02:03.123456');
        assert.equal((await admin.query('SELECT CAST(duration AS CHAR) AS duration FROM native_temporal'))[0][0].duration, '-123:45:56.123456');
      } finally { await fs.rm(directory, { recursive: true, force: true }); }
    });

    await t.test('preview uses only SELECT and keeps reader/editor settings and editor transaction unchanged', async () => {
      assert.ok(queries.length > 0); assert.ok(queries.every(sql => /^SELECT /.test(sql)));
      assert.deepEqual((await settings(reader)).rows, beforeReader); assert.deepEqual((await settings(editor)).rows, beforeEditor);
      assert.equal(editor.inTransaction, true); await editor.runQuery('ROLLBACK');
    });
  } finally {
    await Promise.allSettled([reader.close(), editor.close(), backup.close()]);
    try { if (created) await admin.query(`DROP DATABASE \`${database}\``); } finally { await admin.end(); }
  }
});
