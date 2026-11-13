'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { DatabaseSession } = require('../electron/database.cjs');
const { RestoreSelectionInventory, previewRestoreSelection } = require('../electron/restore-selection.cjs');
const { assertStatementScope } = require('../electron/sql-script.cjs');
const { collectSelectionTargetFacts, buildSelectionTargetPreview } = require('../electron/restore-selection-target.cjs');
const { buildSelectionDraft } = require('../electron/restore-selection-plan.cjs');

test('CHECK metadata integration: observed constraints are never a proof that restored data satisfies them', {
  skip: !process.env.SQLPRO_TEST_CHECKS_PORT, timeout: 30000
}, async t => {
  const database = `sqlpro_checks_${Date.now()}_${process.pid}`;
  const profile = { host: '127.0.0.1', port: Number(process.env.SQLPRO_TEST_CHECKS_PORT), user: 'root', password: '', database,
    ssl: { enabled: false }, ssh: { enabled: false } };
  const admin = await mysql.createConnection({ host: profile.host, port: profile.port, user: profile.user });
  const reader = new DatabaseSession(profile), editor = new DatabaseSession(profile);
  let created = false;
  try {
    await admin.query(`CREATE DATABASE \`${database}\``); created = true; await admin.query(`USE \`${database}\``);
    await admin.query('CREATE TABLE items (v INT, CONSTRAINT positive CHECK (v >= 0)) ENGINE=InnoDB');
    await reader.connect(); await editor.connect(); await editor.runQuery('START TRANSACTION');
    const settings = session => session.raw('SELECT CONNECTION_ID() AS id, @@SESSION.sql_mode AS mode, @@SESSION.autocommit AS auto, @@SESSION.time_zone AS zone');
    const beforeReader = (await settings(reader)).rows, beforeEditor = (await settings(editor)).rows;
    const queries = [], raw = reader.raw.bind(reader);
    reader.raw = async (sql, ...args) => { queries.push(sql); return raw(sql, ...args); };
    const recorded = reader.raw;
    const collector = new RestoreSelectionInventory(database);
    ['CREATE TABLE `items` (`v` INT) ENGINE=InnoDB', 'INSERT INTO items VALUES(-1)']
      .forEach((sql, i) => collector.add(sql, assertStatementScope(sql, database), i + 1));
    const inventory = collector.finish(), source = previewRestoreSelection(inventory, { tables: ['items'], includeStructure: false });
    const build = async () => {
      const facts = await collectSelectionTargetFacts(reader, database, () => {}, source.selectedTables);
      const target = buildSelectionTargetPreview({ source, checksum: 'a'.repeat(64), targetIdentity: 'b'.repeat(64), facts });
      const plan = buildSelectionDraft({ inventory, source, checksum: 'a'.repeat(64), targetIdentity: 'b'.repeat(64), targetReview: target });
      return { facts, target, plan };
    };

    await t.test('real CHECK rejects an in-range integer even when basic value bounds pass; preview writes no rows', async () => {
      const result = await build(); assert.deepEqual(result.facts.errors, []);
      assert.equal(result.target.targetCheckReview.complete, true); assert.equal(result.target.targetCheckReview.totals.observed, 1);
      assert.equal(result.target.targetCheckReview.rows[0].name, 'positive');
      assert.equal(result.target.targetCheckReview.rows[0].status, 'requires-review');
      assert.equal(result.target.targetCheckReview.rows[0].declaredEnforcement, result.facts.checkCapabilities.enforcedColumn ? 'yes' : 'unknown');
      assert.equal(result.plan.valueReview.rows[0].status, 'basic-checked'); assert.equal(result.plan.canExecute, false);
      assert.ok(result.plan.blockers.some(item => item.detail === 'TARGET_CHECKS_PRESENT'));
      assert.equal(Number((await admin.query('SELECT COUNT(*) AS n FROM items'))[0][0].n), 0);
      await assert.rejects(admin.query('INSERT INTO items VALUES(-1)'), error => [3819, 4025].includes(error.errno));
      assert.ok(result.facts.checks[0].clauseDigest); assert.equal(JSON.stringify(result.target).includes(result.facts.checks[0].clauseDigest), false);
    });

    await t.test('changing the expression with the same CHECK name changes snapshot and plan identity', async () => {
      const initial = await build();
      await admin.query('ALTER TABLE items DROP CONSTRAINT positive');
      await admin.query('ALTER TABLE items ADD CONSTRAINT positive CHECK (v >= 10)');
      const changed = await build(); assert.deepEqual(changed.facts.errors, []);
      assert.notEqual(initial.facts.checks[0].clauseDigest, changed.facts.checks[0].clauseDigest);
      assert.notEqual(initial.target.snapshotId, changed.target.snapshotId); assert.notEqual(initial.plan.planId, changed.plan.planId);
      assert.equal(changed.target.targetCheckReview.rows[0].name, 'positive'); assert.equal(changed.plan.canExecute, false);
      assert.equal(Number((await admin.query('SELECT COUNT(*) AS n FROM items'))[0][0].n), 0);
      await assert.rejects(admin.query('INSERT INTO items VALUES(5)'), error => [3819, 4025].includes(error.errno));
    });

    await t.test('declared enforcement is capability-based and never certifies restored values or session behavior', async () => {
      const initial = await build();
      if (initial.facts.checkCapabilities.enforcedColumn) {
        await admin.query('ALTER TABLE items ALTER CHECK positive NOT ENFORCED');
        try {
          const changed = await build();
          assert.equal(changed.target.targetCheckReview.rows[0].declaredEnforcement, 'no');
          assert.notEqual(initial.target.snapshotId, changed.target.snapshotId); assert.equal(changed.plan.canExecute, false);
          assert.ok(changed.target.targetCheckReview.requires.includes('TARGET_CHECK_SESSION_NOT_REVIEWED'));
        } finally { await admin.query('ALTER TABLE items ALTER CHECK positive ENFORCED'); }
      } else {
        assert.equal(initial.target.targetCheckReview.rows[0].declaredEnforcement, 'unknown');
        assert.ok(initial.target.targetCheckReview.requires.includes('TARGET_CHECK_SESSION_NOT_REVIEWED'));
      }
    });

    await t.test('unknown capability and denied queries keep the CHECK gate and redact errors', async () => {
      try {
        reader.raw = async (sql, ...args) => sql.includes('AS tableName, COLUMN_NAME AS name FROM') ? { rows: [] } : recorded(sql, ...args);
        const unknown = await build(); assert.equal(unknown.target.targetCheckReview.complete, false);
        assert.ok(unknown.plan.blockers.some(item => item.detail === 'TARGET_CHECKS_REQUIRE_REVIEW'));
        reader.raw = async (sql, ...args) => {
          if (sql.includes('FROM information_schema.TABLE_CONSTRAINTS t')) throw Object.assign(new Error('private-check-error'), { code: 'ER_TABLEACCESS_DENIED_ERROR' });
          return recorded(sql, ...args);
        };
        const denied = await build(); assert.equal(denied.target.targetCheckReview.complete, false);
        assert.equal(JSON.stringify(denied).includes('private-check-error'), false); assert.equal(denied.plan.canExecute, false);
      } finally { reader.raw = recorded; }
    });

    await t.test('preview uses only SELECT and preserves Reader/Editor settings and the Editor transaction', async () => {
      assert.ok(queries.length > 0); assert.ok(queries.every(sql => /^SELECT /.test(sql)));
      assert.deepEqual((await settings(reader)).rows, beforeReader); assert.deepEqual((await settings(editor)).rows, beforeEditor);
      assert.equal(editor.inTransaction, true); await editor.runQuery('ROLLBACK');
      assert.equal(Number((await admin.query('SELECT COUNT(*) AS n FROM items'))[0][0].n), 0);
    });
  } finally {
    await Promise.allSettled([reader.close(), editor.close()]);
    try { if (created) await admin.query(`DROP DATABASE \`${database}\``); } finally { await admin.end(); }
  }
});
