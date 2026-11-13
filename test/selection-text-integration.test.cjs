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

test('text preview integration: Unicode length, encoded bytes, charset and native backup', {
  skip: !process.env.SQLPRO_TEST_TEXT_PORT, timeout: 30000
}, async t => {
  const database = `sqlpro_text_${Date.now()}_${process.pid}`;
  const profile = { host: '127.0.0.1', port: Number(process.env.SQLPRO_TEST_TEXT_PORT), user: 'root', password: '', database,
    ssl: { enabled: false }, ssh: { enabled: false } };
  const admin = await mysql.createConnection({ host: profile.host, port: profile.port, user: profile.user });
  const reader = new DatabaseSession(profile), editor = new DatabaseSession(profile);
  let created = false;
  try {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`); created = true; await admin.query(`USE \`${database}\``);
    await reader.connect(); await editor.connect(); await editor.runQuery('START TRANSACTION');
    const editorSettings = () => editor.raw('SELECT CONNECTION_ID() AS id, @@SESSION.sql_mode AS mode, @@SESSION.autocommit AS auto');
    const beforeEditor = (await editorSettings()).rows;
    const build = async (inventory, table, checksum = 'a'.repeat(64)) => {
      const source = previewRestoreSelection(inventory, { tables: [table], includeStructure: false });
      const facts = await collectSelectionTargetFacts(reader, database, () => {}, source.selectedTables);
      assert.deepEqual(facts.errors, []);
      const targetIdentity = 'b'.repeat(64), targetReview = buildSelectionTargetPreview({ source, checksum, targetIdentity, facts });
      return { targetReview, draft: buildSelectionDraft({ inventory, source, checksum, targetIdentity, targetReview }) };
    };
    const preview = (table, type, values, sourceCharset = 'utf8mb4') => {
      const collector = new RestoreSelectionInventory(database);
      [`CREATE TABLE \`${table}\` (\`v\` ${type} CHARACTER SET ${sourceCharset}) ENGINE=InnoDB`,
        ...values.map(value => `INSERT INTO \`${table}\` VALUES('${value.replaceAll("'", "''")}')`)].forEach((sql, index) => collector.add(sql, assertStatementScope(sql, database), index + 1));
      return build(collector.finish(), table);
    };

    await t.test('VARCHAR character endpoints and TINYTEXT byte endpoints match real storage without preview writes', async () => {
      for (const [table, type, sourceType, values] of [
        ['varchar_sample', 'VARCHAR(2)', 'VARCHAR(10)', ['a😀', 'é', '😀😀😀']],
        ['text_sample', 'TINYTEXT', 'TEXT', ['é'.repeat(127), 'x'.repeat(255), 'é'.repeat(128)]]
      ]) {
        await admin.query(`CREATE TABLE \`${table}\` (v ${type} CHARACTER SET utf8mb4) ENGINE=InnoDB`);
        const report = await preview(table, sourceType, values);
        assert.equal(report.targetReview.version, 7); assert.equal(report.draft.version, 16);
        assert.deepEqual(report.draft.valueReview.rows.map(row => row.status), ['basic-checked', 'basic-checked', 'issues']);
        assert.equal(String((await admin.query(`SELECT COUNT(*) AS n FROM \`${table}\``))[0][0].n), '0');
        await admin.query(`INSERT INTO \`${table}\` VALUES (?)`, [values[0]]); await admin.query(`INSERT INTO \`${table}\` VALUES (?)`, [values[1]]);
        // MariaDB may report an incomplete UTF8 sequence after the byte limit
        // cuts a multibyte character; both servers must reject the value.
        await assert.rejects(admin.query(`INSERT INTO \`${table}\` VALUES (?)`, [values[2]]), error => error.code === 'ER_DATA_TOO_LONG' || table === 'text_sample' && error.errno === 1366);
        const stored = (await admin.query(`SELECT v, CHAR_LENGTH(v) AS characters, LENGTH(v) AS bytes FROM \`${table}\``))[0];
        assert.deepEqual(stored.map(row => row.v), values.slice(0, 2));
        if (table === 'varchar_sample') assert.deepEqual(stored.map(row => [Number(row.characters), Number(row.bytes)]), [[2, 5], [2, 3]]);
        else assert.deepEqual(stored.map(row => [Number(row.characters), Number(row.bytes)]), [[127, 254], [255, 255]]);
        assert.equal(report.draft.canExecute, false);
      }
    });

    await t.test('charset loss and ALTER drift change the report while visible fixture data stays intact', async () => {
      await admin.query('CREATE TABLE charset_sample (v VARCHAR(10) CHARACTER SET ascii) ENGINE=InnoDB');
      const values = ['ASCII', 'Việt', '😀'], initial = await preview('charset_sample', 'VARCHAR(10)', values);
      assert.deepEqual(initial.draft.valueReview.rows.map(row => row.status), ['basic-checked', 'issues', 'issues']);
      await admin.query('INSERT INTO charset_sample VALUES (?)', [values[0]]);
      for (const value of values.slice(1)) await assert.rejects(admin.query('INSERT INTO charset_sample VALUES (?)', [value]), error => [1300, 1366].includes(error.errno));
      await admin.query('ALTER TABLE charset_sample MODIFY v VARCHAR(10) CHARACTER SET utf8mb3');
      const changed = await preview('charset_sample', 'VARCHAR(10)', values);
      assert.notEqual(changed.targetReview.snapshotId, initial.targetReview.snapshotId); assert.notEqual(changed.draft.planId, initial.draft.planId);
      assert.deepEqual(changed.draft.valueReview.rows.map(row => row.status), ['basic-checked', 'basic-checked', 'issues']);
      await admin.query('INSERT INTO charset_sample VALUES (?)', [values[1]]);
      await assert.rejects(admin.query('INSERT INTO charset_sample VALUES (?)', [values[2]]), error => [1300, 1366].includes(error.errno));
      assert.deepEqual((await admin.query('SELECT v FROM charset_sample'))[0].map(row => row.v), values.slice(0, 2));
      if (changed.targetReview.serverVersion.includes('MariaDB')) {
        const oldMode = (await admin.query('SELECT @@SESSION.old_mode AS mode'))[0][0].mode;
        const otherModes = oldMode.split(',').filter(mode => mode && mode !== 'UTF8_IS_UTF8MB3');
        try {
          for (const mb3 of [false, true]) {
            const table = mb3 ? 'alias_three' : 'alias_four';
            await admin.query('SET SESSION old_mode = ?', [[...otherModes, ...(mb3 ? ['UTF8_IS_UTF8MB3'] : [])].join(',')]);
            await admin.query(`CREATE TABLE \`${table}\` (v VARCHAR(10) CHARACTER SET utf8) ENGINE=InnoDB`);
            const report = await preview(table, 'VARCHAR(10)', ['😀'], 'utf8');
            const field = report.draft.valueReview.rows[0].fields[0];
            assert.equal(report.targetReview.rows[0].valueColumns.columns[0].charset, mb3 ? 'utf8mb3' : 'utf8mb4');
            assert.ok(field.source.findings.includes('VALUE_TEXT_CHARSET_NOT_REVIEWED'));
            assert.equal(field.target.status, mb3 ? 'issues' : 'basic-checked');
            if (mb3) await assert.rejects(admin.query(`INSERT INTO \`${table}\` VALUES (?)`, ['😀']), error => [1300, 1366].includes(error.errno));
            else await admin.query(`INSERT INTO \`${table}\` VALUES (?)`, ['😀']);
          }
        } finally { await admin.query('SET SESSION old_mode = ?', [oldMode]); }
      }
    });

    await t.test('CHAR trailing-space behavior remains flagged separately from VARCHAR/TEXT length checks', async () => {
      await admin.query('CREATE TABLE char_sample (v CHAR(5) CHARACTER SET utf8mb4) ENGINE=InnoDB');
      const report = await preview('char_sample', 'VARCHAR(10)', ['abc', 'abc ']);
      assert.deepEqual(report.draft.valueReview.rows.map(row => row.status), ['unknown', 'issues']);
      assert.ok(report.draft.valueReview.rows[0].fields[0].target.findings.includes('VALUE_CHAR_PADDING_NOT_REVIEWED'));
      assert.ok(report.draft.valueReview.rows[1].fields[0].target.findings.includes('VALUE_CHAR_TRAILING_SPACES'));
      await admin.query("INSERT INTO char_sample VALUES('abc ')");
      assert.equal((await admin.query('SELECT HEX(v) AS value FROM char_sample'))[0][0].value, '616263');
      assert.equal(report.draft.canExecute, false);
    });

    await t.test('native text backup/worker retains only statistics and preview leaves rows and Editor session unchanged', async () => {
      await admin.query('CREATE TABLE native_text (v VARCHAR(100), body TEXT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
      const values = ['Việt 😀 ', 'private-text-é trailing '];
      await admin.query('INSERT INTO native_text VALUES (?,?)', values);
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-text-worker-'));
      try {
        const filePath = path.join(directory, 'native.sql');
        const saved = await saveBackupFile(filePath, write => reader.backupDatabase({ database, tables: ['native_text'], includeStructure: true, includeData: true }, write, () => {}));
        const scanner = new DatabaseSession({});
        const scanned = await scanner.scanRestoreInventoryInWorker({ filePath, database, selectionPreview: true, totalBytes: saved.bytes });
        const inventory = scanned.inventory.selectionPreview, result = await build(inventory, 'native_text', saved.checksum);
        assert.ok(result.draft.valueReview.rows.length > 0); assert.ok(result.draft.valueReview.rows.every(row => row.status === 'basic-checked'));
        const entries = inventory.statementLedger.entries.filter(entry => entry.command === 'INSERT');
        assert.ok(entries.every(entry => entry.syntaxReview.valueReview?.version === 4 && entry.syntaxReview.valueReview.fields.every(field => field.text.count === 1)));
        for (const value of values) assert.equal(JSON.stringify(result).includes(value), false);
        assert.deepEqual((await admin.query('SELECT v,body FROM native_text'))[0].map(row => [row.v, row.body]), [values]);
        assert.equal(result.draft.canExecute, false); assert.ok(result.draft.blockers.some(item => item.code === 'VALUE_FULL_VALIDATION_REQUIRED'));
      } finally { await fs.rm(directory, { recursive: true, force: true }); }
      assert.equal(editor.inTransaction, true); assert.deepEqual((await editorSettings()).rows, beforeEditor);
    });
  } finally {
    await Promise.allSettled([reader.close(), editor.close()]);
    try { if (created) await admin.query(`DROP DATABASE \`${database}\``); } finally { await admin.end(); }
  }
});
