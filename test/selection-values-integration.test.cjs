'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { saveBackupFile } = require('../electron/backup-file.cjs');
const { DatabaseSession } = require('../electron/database.cjs');
const { RestoreSelectionInventory, previewRestoreSelection } = require('../electron/restore-selection.cjs');
const { assertStatementScope } = require('../electron/sql-script.cjs');
const { collectSelectionTargetFacts, buildSelectionTargetPreview } = require('../electron/restore-selection-target.cjs');
const { buildSelectionDraft } = require('../electron/restore-selection-plan.cjs');

test('value bounds integration: read-only preview agrees with strict integer ranges on real server', {
  skip: !process.env.SQLPRO_TEST_VALUE_PORT, timeout: 30000
}, async t => {
  const database = `sqlpro_values_${Date.now()}_${process.pid}`;
  const profile = { host: '127.0.0.1', port: Number(process.env.SQLPRO_TEST_VALUE_PORT), user: 'root', password: '', database,
    ssl: { enabled: false }, ssh: { enabled: false } };
  const admin = await mysql.createConnection({ host: profile.host, port: profile.port, user: profile.user });
  const reader = new DatabaseSession(profile), editor = new DatabaseSession(profile);
  let created = false;
  try {
    await admin.query(`CREATE DATABASE \`${database}\``); created = true; await admin.query(`USE \`${database}\``);
    await admin.query('CREATE TABLE items (id TINYINT NOT NULL, n INT NOT NULL) ENGINE=InnoDB');
    await reader.connect(); await editor.connect(); await editor.runQuery('START TRANSACTION');
    const editorBefore = (await editor.raw('SELECT CONNECTION_ID() AS id, @@SESSION.sql_mode AS mode')).rows;
    const make = async (table, definition, inserts) => {
      const collector = new RestoreSelectionInventory(database);
      [`CREATE TABLE \`${table}\` (${definition}) ENGINE=InnoDB`, ...inserts].forEach((sql, index) => collector.add(sql, assertStatementScope(sql, database), index + 1));
      const inventory = collector.finish(), source = previewRestoreSelection(inventory, { tables: [table], includeStructure: false });
      const facts = await collectSelectionTargetFacts(reader, database, () => {}, source.selectedTables);
      assert.deepEqual(facts.errors, []);
      const checksum = 'a'.repeat(64), targetIdentity = 'b'.repeat(64);
      const targetReview = buildSelectionTargetPreview({ source, checksum, targetIdentity, facts });
      return { facts, targetReview, draft: buildSelectionDraft({ inventory, source, checksum, targetIdentity, targetReview }) };
    };
    let initial;
    await t.test('source-wide integers and NULL report narrower target issues without writes or editor changes', async () => {
      initial = await make('items', '`id` BIGINT UNSIGNED, `n` INT', ['INSERT INTO items VALUES(18446744073709551615,NULL)']);
      const report = initial.draft.valueReview, row = report.rows[0];
      assert.equal(initial.targetReview.version, 16); assert.equal(initial.draft.version, 29);
      assert.equal(initial.targetReview.rows[0].valueColumns.complete, true);
      assert.equal(report.canExecute, false); assert.equal(row.status, 'issues');
      assert.equal(row.fields[0].source.status, 'basic-checked'); assert.equal(row.fields[1].source.status, 'basic-checked');
      assert.deepEqual(row.fields[0].target.findings, ['VALUE_INTEGER_OUT_OF_RANGE']);
      assert.deepEqual(row.fields[1].target.findings, ['VALUE_NULL_NOT_ALLOWED']);
      assert.equal(initial.draft.steps[1].decision, 'blocked');
      assert.equal(String((await admin.query('SELECT COUNT(*) AS n FROM items'))[0][0].n), '0');
      await assert.rejects(admin.query('INSERT INTO items VALUES(18446744073709551615,1)'), error => error.code === 'ER_WARN_DATA_OUT_OF_RANGE');
      await assert.rejects(admin.query('INSERT INTO items VALUES(1,NULL)'), error => error.code === 'ER_BAD_NULL_ERROR');
      assert.equal(editor.inTransaction, true); assert.deepEqual((await editor.raw('SELECT CONNECTION_ID() AS id, @@SESSION.sql_mode AS mode')).rows, editorBefore);
    });

    await t.test('each signed/unsigned width accepts endpoints and rejects adjacent values, matching preview', async () => {
      for (const [type, bits] of [['TINYINT', 8], ['SMALLINT', 16], ['MEDIUMINT', 24], ['INT', 32], ['BIGINT', 64]]) {
        for (const unsigned of [false, true]) {
          const half = 1n << BigInt(bits - 1), min = unsigned ? 0n : -half, max = unsigned ? half * 2n - 1n : half - 1n;
          const declared = type + (unsigned ? ' UNSIGNED' : '');
          await admin.query(`CREATE TABLE sample (v ${declared}) ENGINE=InnoDB`);
          try {
            const values = [min, max, min - 1n, max + 1n], raw = values.map(String);
            const inserts = [...raw, ...raw.map(value => `'${value}'`)].map(value => `INSERT INTO sample VALUES(${value})`);
            const result = await make('sample', `\`v\` ${declared}`, inserts);
            assert.deepEqual(result.draft.valueReview.rows.map(row => row.status), ['basic-checked', 'basic-checked', 'issues', 'issues', 'basic-checked', 'basic-checked', 'issues', 'issues'], declared);
            for (const offset of [0, 4]) {
              await admin.query(inserts[offset]); await admin.query(inserts[offset + 1]);
              await assert.rejects(admin.query(inserts[offset + 2]), error => error.code === 'ER_WARN_DATA_OUT_OF_RANGE');
              await assert.rejects(admin.query(inserts[offset + 3]), error => error.code === 'ER_WARN_DATA_OUT_OF_RANGE');
            }
            assert.equal(String((await admin.query('SELECT COUNT(*) AS n FROM sample'))[0][0].n), '4');
            assert.equal(result.draft.canExecute, false);
          } finally { await admin.query('DROP TABLE sample'); }
        }
      }
    });

    await t.test('target drift updates bounds and plan identity while strings and auto-generated NULL remain unreviewed', async () => {
      await admin.query('ALTER TABLE items MODIFY id BIGINT UNSIGNED NULL, MODIFY n INT NULL');
      const changed = await make('items', '`id` BIGINT UNSIGNED, `n` INT', ['INSERT INTO items VALUES(18446744073709551615,NULL)']);
      assert.notEqual(changed.targetReview.snapshotId, initial.targetReview.snapshotId); assert.notEqual(changed.draft.planId, initial.draft.planId);
      assert.equal(changed.draft.valueReview.rows[0].status, 'basic-checked'); assert.equal(changed.draft.canExecute, false);
      await admin.query('CREATE TABLE auto_sample (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB');
      const special = await make('auto_sample', '`id` INT NOT NULL AUTO_INCREMENT, PRIMARY KEY (`id`)', ["INSERT INTO auto_sample VALUES(NULL)", "INSERT INTO auto_sample VALUES('1')"]);
      assert.deepEqual(special.draft.valueReview.rows.map(row => row.status), ['unknown', 'unknown']);
      await admin.query('INSERT INTO auto_sample VALUES(NULL)');
      assert.equal(String((await admin.query('SELECT id FROM auto_sample'))[0][0].id), '1');
      assert.equal(editor.inTransaction, true); assert.deepEqual((await editor.raw('SELECT CONNECTION_ID() AS id, @@SESSION.sql_mode AS mode')).rows, editorBefore);
      assert.equal(String((await admin.query('SELECT COUNT(*) AS n FROM items'))[0][0].n), '0');
    });

    await t.test('DECIMAL exact endpoints retain all digits and trailing zeros do not imply value loss', async () => {
      const large = '9'.repeat(35) + '.' + '9'.repeat(30);
      for (const [type, accepted, rejected] of [
        ['DECIMAL(5,2)', ['999.99', '-999.99', '1.2300', '-0.00'], ['1000', '-1000']],
        ['DECIMAL(2,2)', ['.99', '-.99', '0'], ['1', '-1']],
        ['DECIMAL(65,30)', [large, '-' + large], ['1' + '0'.repeat(35)]],
        ['NUMERIC', ['9999999999', 'TRUE'], ['10000000000']],
        ['DECIMAL(5,2) UNSIGNED', ['999.99', '-0.00'], ['-0.01', '1000']]
      ]) {
        await admin.query(`CREATE TABLE decimal_sample (v ${type}) ENGINE=InnoDB`);
        try {
          const inserts = [...accepted, ...rejected].map(value => `INSERT INTO decimal_sample VALUES(${value})`);
          const result = await make('decimal_sample', `\`v\` ${type}`, inserts);
          assert.deepEqual(result.draft.valueReview.rows.map(row => row.status), [...accepted.map(() => 'basic-checked'), ...rejected.map(() => 'issues')], type);
          assert.equal(String((await admin.query('SELECT COUNT(*) AS n FROM decimal_sample'))[0][0].n), '0');
          for (const sql of inserts.slice(0, accepted.length)) await admin.query(sql);
          for (const sql of inserts.slice(accepted.length)) await assert.rejects(admin.query(sql), error => error.code === 'ER_WARN_DATA_OUT_OF_RANGE');
          assert.equal(String((await admin.query('SELECT COUNT(*) AS n FROM decimal_sample'))[0][0].n), String(accepted.length));
          if (type === 'DECIMAL(65,30)') {
            assert.deepEqual((await admin.query('SELECT CAST(v AS CHAR) AS value FROM decimal_sample ORDER BY v DESC'))[0].map(row => row.value), [large, '-' + large]);
            const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-decimal-worker-'));
            try {
              const filePath = path.join(directory, 'decimal.sql');
              const saved = await saveBackupFile(filePath, write => reader.backupDatabase({ database, tables: ['decimal_sample'], includeStructure: true, includeData: true }, write, () => {}));
              const scanner = new DatabaseSession({});
              const scanned = await scanner.scanRestoreInventoryInWorker({ filePath, database, selectionPreview: true, totalBytes: saved.bytes });
              const inventory = scanned.inventory.selectionPreview;
              const entries = inventory.statementLedger.entries.filter(entry => entry.command === 'INSERT');
              assert.ok(entries.length > 0);
              // Native dump keeps quoted mysql2 decimal strings. Review only
              // the exact numeric subset without changing the backup format.
              assert.ok(entries.every(entry => entry.syntaxReview.valueReview?.version === 7
                && entry.syntaxReview.valueReview.fields[0].fixedPoint.count === 0
                && entry.syntaxReview.valueReview.fields[0].numericStrings.count > 0));
              const source = previewRestoreSelection(inventory, { tables: ['decimal_sample'], includeStructure: false });
              const draft = buildSelectionDraft({ inventory, source, checksum: saved.checksum, targetIdentity: 'b'.repeat(64), targetReview: result.targetReview });
              assert.ok(draft.valueReview.rows.every(row => row.status === 'basic-checked'));
              assert.equal(JSON.stringify(draft).includes(large), false); assert.equal(draft.canExecute, false);
            } finally { await fs.rm(directory, { recursive: true, force: true }); }
          }
          assert.equal(result.draft.canExecute, false);
        } finally { await admin.query('DROP TABLE decimal_sample'); }
      }
      assert.equal(editor.inTransaction, true); assert.deepEqual((await editor.raw('SELECT CONNECTION_ID() AS id, @@SESSION.sql_mode AS mode')).rows, editorBefore);
    });

    await t.test('DECIMAL scale loss is blocked before silent rounding and target drift updates the proposal', async () => {
      await admin.query('CREATE TABLE decimal_sample (v DECIMAL(5,2)) ENGINE=InnoDB');
      try {
        const inserts = ['INSERT INTO decimal_sample VALUES(1.234)', 'INSERT INTO decimal_sample VALUES(999.999)',
          "INSERT INTO decimal_sample VALUES('1.234')", "INSERT INTO decimal_sample VALUES('999.999')"];
        const initial = await make('decimal_sample', '`v` DECIMAL(10,4)', inserts);
        assert.ok(initial.draft.valueReview.rows.every(row => row.fields[0].target.findings.includes('VALUE_DECIMAL_SCALE_LOSS')));
        assert.ok(initial.draft.steps.filter(step => step.command === 'INSERT').every(step => step.decision === 'blocked'));
        assert.equal(String((await admin.query('SELECT COUNT(*) AS n FROM decimal_sample'))[0][0].n), '0');
        await admin.query(inserts[0]);
        await admin.query(inserts[2]);
        assert.equal((await admin.query('SELECT CAST(v AS CHAR) AS value FROM decimal_sample'))[0][0].value, '1.23');
        await assert.rejects(admin.query(inserts[1]), error => error.code === 'ER_WARN_DATA_OUT_OF_RANGE');
        await assert.rejects(admin.query(inserts[3]), error => error.code === 'ER_WARN_DATA_OUT_OF_RANGE');
        await admin.query('ALTER TABLE decimal_sample MODIFY v DECIMAL(10,4)');
        const changed = await make('decimal_sample', '`v` DECIMAL(10,4)', inserts);
        assert.notEqual(initial.targetReview.snapshotId, changed.targetReview.snapshotId); assert.notEqual(initial.draft.planId, changed.draft.planId);
        assert.deepEqual(changed.draft.valueReview.rows.map(row => row.status), ['basic-checked', 'basic-checked', 'basic-checked', 'basic-checked']);
        assert.equal(changed.draft.canExecute, false);
        assert.equal((await admin.query('SELECT CAST(v AS CHAR) AS value FROM decimal_sample'))[0][0].value, '1.2300');
      } finally { await admin.query('DROP TABLE decimal_sample'); }
      assert.equal(editor.inTransaction, true); assert.deepEqual((await editor.raw('SELECT CONNECTION_ID() AS id, @@SESSION.sql_mode AS mode')).rows, editorBefore);
    });

    await t.test('strict numeric strings preserve native BIGINT/DECIMAL backups and leave other conversion forms unknown', async () => {
      const definition = '`id` BIGINT UNSIGNED NOT NULL, `amount` DECIMAL(65,30)';
      await admin.query(`CREATE TABLE native_numeric (${definition}) ENGINE=InnoDB`);
      const exact = '9'.repeat(35) + '.' + '9'.repeat(30), largest = '18446744073709551615';
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-numeric-strings-worker-'));
      try {
        const inserts = [`INSERT INTO native_numeric VALUES('${largest}','${exact}')`,
          "INSERT INTO native_numeric VALUES('+0001','+.25000')", "INSERT INTO native_numeric VALUES('1.0','1e0')",
          "INSERT INTO native_numeric VALUES(' 1','1.23suffix')"];
        const result = await make('native_numeric', definition, inserts);
        assert.deepEqual(result.draft.valueReview.rows.map(row => row.status), ['basic-checked', 'basic-checked', 'unknown', 'unknown']);
        assert.equal(String((await admin.query('SELECT COUNT(*) AS n FROM native_numeric'))[0][0].n), '0');
        await admin.query(inserts[0]); await admin.query(inserts[1]);
        const observed = (await admin.query('SELECT CAST(id AS CHAR) AS id, CAST(amount AS CHAR) AS amount FROM native_numeric ORDER BY id DESC'))[0];
        assert.equal(observed[0].id, largest); assert.equal(observed[0].amount, exact);
        assert.equal(observed[1].id, '1'); assert.equal(observed[1].amount, '0.25' + '0'.repeat(28));
        const filePath = path.join(directory, 'native.sql');
        const saved = await saveBackupFile(filePath, write => reader.backupDatabase({ database, tables: ['native_numeric'], includeStructure: true, includeData: true }, write, () => {}));
        const scanner = new DatabaseSession({});
        const scanned = await scanner.scanRestoreInventoryInWorker({ filePath, database, selectionPreview: true, totalBytes: saved.bytes });
        const inventory = scanned.inventory.selectionPreview;
        const source = previewRestoreSelection(inventory, { tables: ['native_numeric'], includeStructure: false });
        const draft = buildSelectionDraft({ inventory, source, checksum: saved.checksum, targetIdentity: 'b'.repeat(64), targetReview: result.targetReview });
        assert.ok(draft.valueReview.rows.length > 0); assert.ok(draft.valueReview.rows.every(row => row.status === 'basic-checked'));
        assert.ok(draft.valueReview.rows.every(row => row.fields.every(field => field.counts.numericStrings > 0)));
        assert.equal(JSON.stringify(draft).includes(exact), false); assert.equal(JSON.stringify(draft).includes(largest), false);
        assert.equal(draft.canExecute, false); assert.ok(draft.blockers.some(item => item.code === 'VALUE_FULL_VALIDATION_REQUIRED'));
        assert.deepEqual((await admin.query('SELECT CAST(id AS CHAR) AS id, CAST(amount AS CHAR) AS amount FROM native_numeric ORDER BY id DESC'))[0], observed);
      } finally {
        await fs.rm(directory, { recursive: true, force: true }); await admin.query('DROP TABLE native_numeric');
      }
      assert.equal(editor.inTransaction, true); assert.deepEqual((await editor.raw('SELECT CONNECTION_ID() AS id, @@SESSION.sql_mode AS mode')).rows, editorBefore);
    });
  } finally {
    await Promise.allSettled([reader.close(), editor.close()]);
    try { if (created) await admin.query(`DROP DATABASE \`${database}\``); } finally { await admin.end(); }
  }
});
