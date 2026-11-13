'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { DatabaseSession } = require('../electron/database.cjs');
const { RestoreSelectionInventory, previewRestoreSelection } = require('../electron/restore-selection.cjs');
const { assertStatementScope } = require('../electron/sql-script.cjs');
const { collectSelectionTargetFacts, buildSelectionTargetPreview } = require('../electron/restore-selection-target.cjs');
const { buildSelectionDraft } = require('../electron/restore-selection-plan.cjs');

test('omitted values integration: metadata-only preview observes defaults and special columns without writing', {
  skip: !process.env.SQLPRO_TEST_OMITTED_PORT, timeout: 30000
}, async t => {
  const database = `sqlpro_omitted_${Date.now()}_${process.pid}`;
  const profile = { host: '127.0.0.1', port: Number(process.env.SQLPRO_TEST_OMITTED_PORT), user: 'root', password: '', database,
    ssl: { enabled: false }, ssh: { enabled: false } };
  const admin = await mysql.createConnection({ host: profile.host, port: profile.port, user: profile.user });
  const reader = new DatabaseSession(profile), editor = new DatabaseSession(profile);
  let created = false;
  try {
    await admin.query(`CREATE DATABASE \`${database}\``); created = true; await admin.query(`USE \`${database}\``);
    await admin.query("SET SESSION sql_mode='STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION'");
    await reader.connect(); await editor.connect(); await editor.runQuery('START TRANSACTION');
    const editorState = () => editor.raw('SELECT CONNECTION_ID() AS id, @@SESSION.sql_mode AS mode, @@SESSION.autocommit AS auto');
    const beforeEditor = (await editorState()).rows;
    const queries = [], raw = reader.raw.bind(reader);
    reader.raw = async (sql, ...args) => { queries.push(sql); return raw(sql, ...args); };
    const build = async (table, definition, insert) => {
      const collector = new RestoreSelectionInventory(database);
      [`CREATE TABLE \`${table}\` (${definition}) ENGINE=InnoDB`, insert].forEach((sql, index) => collector.add(sql, assertStatementScope(sql, database), index + 1));
      const inventory = collector.finish(), source = previewRestoreSelection(inventory, { tables: [table], includeStructure: false });
      const facts = await collectSelectionTargetFacts(reader, database, () => {}, source.selectedTables);
      assert.deepEqual(facts.errors, []);
      const checksum = 'a'.repeat(64), targetIdentity = 'b'.repeat(64);
      const targetReview = buildSelectionTargetPreview({ source, checksum, targetIdentity, facts });
      const draft = buildSelectionDraft({ inventory, source, checksum, targetIdentity, targetReview });
      assert.equal(draft.canExecute, false); assert.equal(draft.omittedValueReview.canExecute, false);
      return { draft, targetReview, row: draft.omittedValueReview.rows[0] };
    };

    await t.test('required omission fails under strict mode and DEFAULT drift changes the snapshot/draft', async () => {
      await admin.query('CREATE TABLE required_sample (id INT, required_value INT NOT NULL) ENGINE=InnoDB');
      const insert = 'INSERT INTO required_sample (id) VALUES(1)', definition = '`id` INT, `required_value` INT NOT NULL';
      const initial = await build('required_sample', definition, insert);
      assert.equal(initial.row.target.columns[0].code, 'OMITTED_REQUIRED_COLUMN');
      assert.equal(initial.draft.steps[1].reason, 'OMITTED_REQUIRED_COLUMN');
      assert.equal(Number((await admin.query('SELECT COUNT(*) AS n FROM required_sample'))[0][0].n), 0);
      await assert.rejects(admin.query(insert), error => error.errno === 1364);
      await admin.query('ALTER TABLE required_sample MODIFY required_value INT NOT NULL DEFAULT 7');
      const changed = await build('required_sample', definition, insert);
      assert.equal(changed.row.target.columns[0].code, 'OMITTED_DEFAULT_NOT_REVIEWED');
      assert.notEqual(changed.targetReview.snapshotId, initial.targetReview.snapshotId);
      assert.notEqual(changed.draft.planId, initial.draft.planId);
      await admin.query(insert);
      assert.equal((await admin.query('SELECT required_value FROM required_sample'))[0][0].required_value, 7);
    });

    await t.test('nullable NULL and literal DEFAULT are not confused or exposed', async () => {
      await admin.query("CREATE TABLE defaults_sample (id INT, optional_value INT NULL, label VARCHAR(30) NOT NULL DEFAULT 'private-default') ENGINE=InnoDB");
      const result = await build('defaults_sample', "`id` INT, `optional_value` INT NULL, `label` VARCHAR(30) NOT NULL DEFAULT 'private-default'", 'INSERT INTO defaults_sample (id) VALUES(1)');
      assert.equal(result.row.source.columns[0].code, 'OMITTED_IMPLICIT_NULL');
      // MariaDB may represent DEFAULT NULL as a non-null metadata string.
      // This report conservatively reviews any observed DEFAULT, never its text.
      assert.ok(['OMITTED_IMPLICIT_NULL', 'OMITTED_DEFAULT_NOT_REVIEWED'].includes(result.row.target.columns[0].code));
      assert.equal(result.row.target.columns[1].code, 'OMITTED_DEFAULT_NOT_REVIEWED');
      assert.equal(JSON.stringify(result).includes('private-default'), false);
      assert.equal(Number((await admin.query('SELECT COUNT(*) AS n FROM defaults_sample'))[0][0].n), 0);
      await admin.query('INSERT INTO defaults_sample (id) VALUES(1)');
      const row = (await admin.query('SELECT optional_value, label FROM defaults_sample'))[0][0];
      assert.equal(row.optional_value, null); assert.equal(row.label, 'private-default');
    });

    await t.test('positional INSERT leaves Invisible columns to their unreviewed defaults', async () => {
      await admin.query('CREATE TABLE invisible_sample (id INT, hidden_value INT NOT NULL DEFAULT 19 INVISIBLE) ENGINE=InnoDB');
      const result = await build('invisible_sample', '`id` INT', 'INSERT INTO invisible_sample VALUES(1)');
      assert.equal(result.row.source.omittedCount, 0);
      assert.equal(result.row.target.columns[0].invisible, true);
      assert.equal(result.row.target.columns[0].code, 'OMITTED_DEFAULT_NOT_REVIEWED');
      assert.equal(Number((await admin.query('SELECT COUNT(*) AS n FROM invisible_sample'))[0][0].n), 0);
      await admin.query('INSERT INTO invisible_sample VALUES(1)');
      assert.equal((await admin.query('SELECT hidden_value FROM invisible_sample'))[0][0].hidden_value, 19);
    });

    await t.test('auto-increment, TIMESTAMP expression and generated columns remain unreviewed', async () => {
      await admin.query('CREATE TABLE special_sample (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, supplied INT, ts TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP, computed INT GENERATED ALWAYS AS (supplied+1) STORED) ENGINE=InnoDB');
      const result = await build('special_sample', '`id` INT NOT NULL AUTO_INCREMENT, `supplied` INT, `ts` TIMESTAMP NULL, PRIMARY KEY (`id`)', 'INSERT INTO special_sample (supplied) VALUES(5)');
      assert.deepEqual(result.row.target.columns.map(column => column.code), ['OMITTED_AUTO_INCREMENT_NOT_REVIEWED', 'OMITTED_TIMESTAMP_NOT_REVIEWED', 'OMITTED_GENERATED_NOT_REVIEWED']);
      assert.equal(result.row.status, 'unknown');
      assert.equal(Number((await admin.query('SELECT COUNT(*) AS n FROM special_sample'))[0][0].n), 0);
      await admin.query('INSERT INTO special_sample (supplied) VALUES(5)');
      const row = (await admin.query('SELECT id, ts, computed FROM special_sample'))[0][0];
      assert.equal(row.id, 1); assert.ok(row.ts); assert.equal(row.computed, 6);
    });

    await t.test('preview uses only SELECT and leaves the editor transaction/session intact', async () => {
      assert.ok(queries.length > 0); assert.ok(queries.every(sql => /^SELECT /.test(sql)));
      assert.equal(editor.inTransaction, true); assert.deepEqual((await editorState()).rows, beforeEditor);
      await editor.runQuery('ROLLBACK');
    });
  } finally {
    await Promise.allSettled([reader.close(), editor.close()]);
    try { if (created) await admin.query(`DROP DATABASE \`${database}\``); } finally { await admin.end(); }
  }
});
