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
    const beforeEditor = (await editor.raw('SELECT @@SESSION.sql_mode AS mode, @@SESSION.foreign_key_checks AS fk, CONNECTION_ID() AS id')).rows;
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
      assert.deepEqual(initialFacts.errors, []); assert.equal(initial.version, 7); assert.equal(draft.version, 16);
      assert.deepEqual(draft.sessionPolicyReview.findings, []); assert.equal(draft.canExecute, false);
      assert.equal(draft.sessionPolicyReview.foreignKeys, 'keep-enabled');
      assert.ok(draft.sessionPolicyReview.proposedMode.flags.includes('NO_AUTO_VALUE_ON_ZERO'));
      assert.ok(draft.sessionPolicyReview.proposedMode.flags.some(flag => /^STRICT_/.test(flag)));
      assert.deepEqual((await read()).sessionSettings, initialFacts.sessionSettings);
      assert.deepEqual((await reader.raw('SHOW TABLES')).rows, []);
      assert.equal(editor.inTransaction, true);
      assert.deepEqual((await editor.raw('SELECT @@SESSION.sql_mode AS mode, @@SESSION.foreign_key_checks AS fk, CONNECTION_ID() AS id')).rows, beforeEditor);
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
      assert.deepEqual((await editor.raw('SELECT @@SESSION.sql_mode AS mode, @@SESSION.foreign_key_checks AS fk, CONNECTION_ID() AS id')).rows, beforeEditor);
    });
  } finally {
    await Promise.allSettled([reader.close(), editor.close()]);
    try { if (created) await admin.query(`DROP DATABASE \`${database}\``); } finally { await admin.end(); }
  }
});
