'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { DatabaseSession } = require('../electron/database.cjs');
const { RestoreSelectionInventory, previewRestoreSelection } = require('../electron/restore-selection.cjs');
const { assertStatementScope } = require('../electron/sql-script.cjs');
const { collectSelectionTargetFacts, buildSelectionTargetPreview } = require('../electron/restore-selection-target.cjs');
const { buildSelectionDraft } = require('../electron/restore-selection-plan.cjs');

test('session policy integration: read-only proposal and isolated strict/FK/zero-mode semantics', {
  skip: !process.env.SQLPRO_TEST_SESSION_PORT, timeout: 30000
}, async t => {
  const database = `sqlpro_session_${Date.now()}_${process.pid}`;
  const profile = { host: '127.0.0.1', port: Number(process.env.SQLPRO_TEST_SESSION_PORT), user: 'root', password: '', database,
    ssl: { enabled: false }, ssh: { enabled: false } };
  const admin = await mysql.createConnection({ host: profile.host, port: profile.port, user: profile.user });
  const reader = new DatabaseSession(profile), editor = new DatabaseSession(profile);
  let created = false;
  try {
    await admin.query(`CREATE DATABASE \`${database}\``); created = true;
    await reader.connect(); await editor.connect();
    await editor.runQuery('START TRANSACTION');
    const editorSettings = () => editor.raw('SELECT @@SESSION.sql_mode AS mode, @@SESSION.foreign_key_checks AS fk, @@SESSION.unique_checks AS uq, CONNECTION_ID() AS id');
    const beforeEditor = (await editorSettings()).rows;
    const collector = new RestoreSelectionInventory(database);
    const statements = ['SET NAMES utf8mb4', 'SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0',
      "SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO'",
      'CREATE TABLE `items` (`id` INT NOT NULL AUTO_INCREMENT, `label` VARCHAR(2), PRIMARY KEY (`id`)) ENGINE=InnoDB',
      'SET SQL_MODE=@OLD_SQL_MODE', 'SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS'];
    statements.forEach((sql, index) => collector.add(sql, assertStatementScope(sql, database), index + 1));
    const inventory = collector.finish(), source = previewRestoreSelection(inventory, { tables: ['items'] });
    const read = () => collectSelectionTargetFacts(reader, database, () => {}, source.selectedTables);
    const review = facts => buildSelectionTargetPreview({ source, checksum: 'a'.repeat(64), targetIdentity: 'b'.repeat(64), facts });
    const plan = targetReview => buildSelectionDraft({ inventory, source, checksum: 'a'.repeat(64), targetIdentity: 'b'.repeat(64), targetReview });
    const initialFacts = await read(), initial = review(initialFacts), draft = plan(initial);

    await t.test('fresh settings bind preview without executing native SET or touching editor transaction', async () => {
      assert.deepEqual(initialFacts.errors, []); assert.equal(initial.version, 16); assert.equal(draft.version, 29);
      assert.deepEqual(draft.sessionPolicyReview.findings, []); assert.equal(draft.canExecute, false);
      assert.equal(draft.sessionPolicyReview.foreignKeys, 'keep-enabled');
      assert.equal(draft.sessionPolicyReview.uniqueChecks, 'keep-enabled');
      assert.equal(draft.sessionPolicyReview.observations.uniqueChecks, true);
      assert.ok(draft.sessionPolicyReview.proposedMode.flags.includes('NO_AUTO_VALUE_ON_ZERO'));
      assert.ok(draft.sessionPolicyReview.proposedMode.flags.some(flag => /^STRICT_/.test(flag)));
      assert.deepEqual((await read()).sessionSettings, initialFacts.sessionSettings);
      assert.deepEqual((await reader.raw('SHOW TABLES')).rows, []);
      assert.equal(editor.inTransaction, true);
      assert.deepEqual((await editorSettings()).rows, beforeEditor);
    });

    await t.test('proposed flags preserve explicit zero and reject truncation/orphans in test session only', async () => {
      const captured = (await reader.raw('SELECT @@SESSION.sql_mode AS mode')).rows[0].mode;
      try {
        await reader.raw('SET SESSION sql_mode = ?', [draft.sessionPolicyReview.proposedMode.flags.join(',')]);
        await reader.raw(statements[3]);
        await reader.raw('CREATE TABLE child (id INT PRIMARY KEY, parent_id INT, FOREIGN KEY (parent_id) REFERENCES items(id)) ENGINE=InnoDB');
        await reader.raw("INSERT INTO items(id,label) VALUES (0,'ok')");
        await assert.rejects(reader.raw("INSERT INTO items(id,label) VALUES (2,'too-long')"), error => error.code === 'ER_DATA_TOO_LONG');
        await assert.rejects(reader.raw('INSERT INTO child VALUES (1,99)'), error => error.code === 'ER_NO_REFERENCED_ROW_2');
        assert.deepEqual((await reader.raw('SELECT id,label FROM items')).rows.map(row => [row.id, row.label]), [[0, 'ok']]);
        assert.equal(String((await reader.raw('SELECT COUNT(*) AS n FROM child')).rows[0].n), '0');
        assert.equal(String((await reader.raw('SELECT @@SESSION.foreign_key_checks AS fk')).rows[0].fk), '1');
      } finally { await reader.raw('SET SESSION sql_mode = ?', [captured]); }
      assert.deepEqual((await read()).sessionSettings, initialFacts.sessionSettings);
    });

    await t.test('session drift changes snapshot and plan, disabled checks stay blocked, settings restore independently', async () => {
      const before = review(await read());
      try {
        await reader.raw('SET SESSION foreign_key_checks=0');
        await reader.raw('SET SESSION autocommit=0');
        const changed = review(await read()), changedDraft = plan(changed);
        assert.notEqual(before.snapshotId, changed.snapshotId); assert.notEqual(plan(before).planId, changedDraft.planId);
        for (const code of ['SESSION_FK_CHECKS_DISABLED', 'SESSION_AUTOCOMMIT_DISABLED']) assert.ok(changedDraft.sessionPolicyReview.findings.some(finding => finding.code === code));
        assert.equal(changedDraft.canExecute, false);
      } finally {
        await reader.raw('ROLLBACK'); await reader.raw('SET SESSION autocommit=1'); await reader.raw('SET SESSION foreign_key_checks=1');
      }
      assert.equal(review(await read()).snapshotId, before.snapshotId);
      assert.equal(editor.inTransaction, true);
      assert.deepEqual((await editorSettings()).rows, beforeEditor);
    });

    await t.test('unique_checks drift binds snapshots and plans; read-only preview never reenables it or validates duplicates', async () => {
      const before = review(await read()), captured = Number((await reader.raw('SELECT @@SESSION.unique_checks AS n')).rows[0].n);
      assert.ok([0, 1].includes(captured));
      const raw = reader.raw.bind(reader), queries = [];
      try {
        await raw('SET SESSION unique_checks=0');
        reader.raw = async (sql, ...args) => { queries.push(sql); return raw(sql, ...args); };
        const changedFacts = await read(), changed = review(changedFacts), changedDraft = plan(changed);
        assert.deepEqual(changedFacts.errors, []); assert.equal(changed.sessionSettings.version, 2);
        assert.equal(changed.sessionSettings.uniqueChecks, false); assert.notEqual(before.snapshotId, changed.snapshotId);
        assert.notEqual(plan(before).planId, changedDraft.planId); assert.equal(changedDraft.canExecute, false);
        assert.ok(changedDraft.sessionPolicyReview.findings.some(item => item.code === 'SESSION_UNIQUE_CHECKS_DISABLED'));
        assert.ok(changedDraft.blockers.some(item => item.code === 'SESSION_UNIQUE_CHECKS_DISABLED'));
        assert.ok(changedDraft.sessionPolicyReview.requires.includes('SESSION_UNIQUE_DATA_NOT_VALIDATED'));
        assert.ok(queries.length > 0); assert.ok(queries.every(sql => /^SELECT /.test(sql)));
        assert.equal(Number((await raw('SELECT @@SESSION.unique_checks AS n')).rows[0].n), 0);
        assert.equal(editor.inTransaction, true); assert.deepEqual((await editorSettings()).rows, beforeEditor);
      } finally {
        reader.raw = raw; await raw('SET SESSION unique_checks=?', [captured]);
      }
      assert.equal(review(await read()).snapshotId, before.snapshotId);
    });

    await t.test('enabled unique checks still require data validation; secondary unique duplicates are rejected in the isolated fixture', async () => {
      await admin.query(`USE \`${database}\``);
      await admin.query('CREATE TABLE unique_sample (id INT PRIMARY KEY, code INT, UNIQUE KEY uq_code (code)) ENGINE=InnoDB');
      await admin.query('INSERT INTO unique_sample VALUES(1,10)');
      await assert.rejects(admin.query('INSERT INTO unique_sample VALUES(2,10)'), error => error.code === 'ER_DUP_ENTRY');
      assert.equal(Number((await admin.query('SELECT COUNT(*) AS n FROM unique_sample'))[0][0].n), 1);
      const facts = await read(), result = plan(review(facts));
      assert.equal(result.sessionPolicyReview.observations.uniqueChecks, true);
      assert.ok(result.sessionPolicyReview.requires.includes('SESSION_UNIQUE_DATA_NOT_VALIDATED')); assert.equal(result.canExecute, false);
      const legacy = structuredClone(facts); legacy.sessionSettings.version = 1; legacy.sessionSettings.uniqueChecks = true;
      const legacyPlan = plan(review(legacy));
      assert.equal(legacyPlan.sessionPolicyReview.observations.uniqueChecks, null);
      assert.ok(legacyPlan.sessionPolicyReview.findings.some(item => item.code === 'SESSION_UNIQUE_CHECKS_NOT_REVIEWED'));
      assert.equal(editor.inTransaction, true); assert.deepEqual((await editorSettings()).rows, beforeEditor);
    });
  } finally {
    await Promise.allSettled([reader.close(), editor.close()]);
    try { if (created) await admin.query(`DROP DATABASE \`${database}\``); } finally { await admin.end(); }
  }
});
