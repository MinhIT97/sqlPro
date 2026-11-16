'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { DatabaseSession } = require('../electron/database.cjs');
const { RestoreSelectionInventory, previewRestoreSelection } = require('../electron/restore-selection.cjs');
const { assertStatementScope } = require('../electron/sql-script.cjs');
const { collectSelectionTargetFacts, buildSelectionTargetPreview } = require('../electron/restore-selection-target.cjs');
const { buildSelectionDraft } = require('../electron/restore-selection-plan.cjs');
const { captureObservation, compareObservations } = require('../restore-review.js');

test('target engine integration: observations never authorize writes or guarantee rollback of indirect effects', {
  skip: !process.env.SQLPRO_TEST_ENGINE_PORT, timeout: 30000
}, async t => {
  const database = `sqlpro_engines_${Date.now()}_${process.pid}`;
  const profile = { host: '127.0.0.1', port: Number(process.env.SQLPRO_TEST_ENGINE_PORT), user: 'root', password: '', database,
    ssl: { enabled: false }, ssh: { enabled: false } };
  const admin = await mysql.createConnection({ host: profile.host, port: profile.port, user: profile.user });
  const reader = new DatabaseSession(profile), editor = new DatabaseSession(profile);
  let created = false;
  try {
    await admin.query(`CREATE DATABASE \`${database}\``); created = true; await admin.query(`USE \`${database}\``);
    await admin.query('CREATE TABLE items (v INT) ENGINE=InnoDB');
    await reader.connect(); await editor.connect(); await editor.runQuery('START TRANSACTION');
    const settings = session => session.raw('SELECT CONNECTION_ID() AS id, @@SESSION.sql_mode AS mode, @@SESSION.autocommit AS auto, @@SESSION.time_zone AS zone');
    const beforeReader = (await settings(reader)).rows, beforeEditor = (await settings(editor)).rows;
    const queries = [], raw = reader.raw.bind(reader);
    reader.raw = async (sql, ...args) => { queries.push(sql); return raw(sql, ...args); };
    const recorded = reader.raw;
    const collector = new RestoreSelectionInventory(database);
    ['CREATE TABLE `items` (`v` INT) ENGINE=InnoDB', 'INSERT INTO items VALUES(1)']
      .forEach((sql, i) => collector.add(sql, assertStatementScope(sql, database), i + 1));
    const inventory = collector.finish(), source = previewRestoreSelection(inventory, { tables: ['items'], includeStructure: false });
    const build = async () => {
      const facts = await collectSelectionTargetFacts(reader, database, () => {}, source.selectedTables);
      const target = buildSelectionTargetPreview({ source, checksum: 'a'.repeat(64), targetIdentity: 'b'.repeat(64), facts });
      const plan = buildSelectionDraft({ inventory, source, checksum: 'a'.repeat(64), targetIdentity: 'b'.repeat(64), targetReview: target });
      return { facts, target, plan };
    };
    const count = async table => Number((await admin.query(`SELECT COUNT(*) AS n FROM \`${table}\``))[0][0].n);
    const observation = result => captureObservation({ profileId: 'fixture', id: 'backup.sql', database, targetDatabase: database,
      conflictPolicy: 'stop-on-conflict', includeStructure: false, includeData: true, tables: ['items'] },
    { checksum: 'a'.repeat(64), targetReview: result.target, draftPlan: result.plan });

    await t.test('InnoDB is observed through the existing SELECT, without removing execution or indirect-write gates', async () => {
      const result = await build(); assert.deepEqual(result.facts.errors, []);
      assert.equal(result.facts.objects[0].engine, 'InnoDB'); assert.equal(result.target.rows[0].engineReview.reason, 'TARGET_ENGINE_INNODB_OBSERVED');
      assert.equal(result.plan.targetEngineReview.rows[0].engine, 'InnoDB'); assert.equal(result.plan.steps[1].decision, 'candidate');
      assert.equal(result.plan.canExecute, false); assert.ok(result.plan.blockers.some(item => item.code === 'TARGET_INDIRECT_WRITES_NOT_REVIEWED'));
      assert.equal(await count('items'), 0);
    });

    await t.test('two fresh observations ignore read time and row writes remain outside metadata comparison', async () => {
      const initial = await build(), again = await build();
      assert.equal(compareObservations(observation(initial), observation(again)).status, 'unchanged');
      await admin.query('INSERT INTO items VALUES(42)');
      try {
        const changedData = await build(); assert.equal(await count('items'), 1);
        const comparison = compareObservations(observation(initial), observation(changedData));
        assert.equal(comparison.status, 'unchanged'); assert.equal(comparison.metadataChanged, false); assert.equal(comparison.canExecute, false);
        // This is intentionally metadata-only: equal identities do not certify
        // unchanged rows, consistency or authority to execute the draft.
        assert.equal(changedData.plan.canExecute, false);
      } finally { await admin.query('DELETE FROM items'); }
    });

    await t.test('changing the existing target to MyISAM changes snapshot/plan and blocks the data-only INSERT', async () => {
      const initial = await build();
      await admin.query('ALTER TABLE items ENGINE=MyISAM');
      const changed = await build(); assert.deepEqual(changed.facts.errors, []);
      assert.equal(changed.facts.objects[0].engine, 'MyISAM'); assert.notEqual(initial.target.snapshotId, changed.target.snapshotId);
      assert.notEqual(initial.plan.planId, changed.plan.planId); assert.equal(changed.plan.steps[1].reason, 'TARGET_ENGINE_UNSUPPORTED');
      assert.equal(compareObservations(observation(initial), observation(changed)).metadataChanged, true);
      assert.equal(changed.plan.canExecute, false); assert.equal(await count('items'), 0);
      await admin.beginTransaction();
      try { await admin.query('INSERT INTO items VALUES(1)'); } finally { await admin.rollback(); }
      // This explicit writer fixture proves why a transaction alone is not a
      // rollback guarantee. The preview reader performs no writes.
      try { assert.equal(await count('items'), 1); } finally { await admin.query('DELETE FROM items'); }
      await admin.query('ALTER TABLE items ENGINE=InnoDB');
      assert.equal((await build()).target.snapshotId, initial.target.snapshotId);
    });

    await t.test('an InnoDB table with a trigger writing MyISAM keeps the indirect-effects gate', async () => {
      await admin.query('CREATE TABLE audit_fixture (v INT) ENGINE=MyISAM');
      await admin.query('CREATE TRIGGER after_items AFTER INSERT ON items FOR EACH ROW INSERT INTO audit_fixture VALUES(NEW.v)');
      try {
        const result = await build(); assert.equal(result.target.rows[0].engineReview.engine, 'InnoDB');
        assert.ok(result.target.findings.some(item => item.code === 'TARGET_TRIGGERS_PRESENT')); assert.equal(result.plan.canExecute, false);
        assert.equal(result.target.targetTriggerReview.complete, true); assert.equal(result.target.targetTriggerReview.totals.observed, 1);
        assert.equal(result.target.targetTriggerReview.rows[0].timing, 'AFTER'); assert.equal(result.target.targetTriggerReview.rows[0].actionOrder, 1);
        assert.ok(result.plan.blockers.some(item => item.code === 'TARGET_INDIRECT_WRITES_NOT_REVIEWED'));
        assert.equal(await count('items'), 0); assert.equal(await count('audit_fixture'), 0);
        await admin.beginTransaction();
        try { await admin.query('INSERT INTO items VALUES(2)'); } finally { await admin.rollback(); }
        assert.equal(await count('items'), 0); assert.equal(await count('audit_fixture'), 1);
      } finally {
        await admin.query('DROP TRIGGER after_items'); await admin.query('DROP TABLE audit_fixture');
      }
    });

    await t.test('trigger body and creation context changes with the same name are bound without exposing definitions or accounts', async () => {
      await admin.query('CREATE TABLE audit_fixture (v INT) ENGINE=InnoDB');
      const originalMode = (await admin.query('SELECT @@SESSION.sql_mode AS mode'))[0][0].mode;
      const create = addition => admin.query(`CREATE TRIGGER after_items AFTER INSERT ON items FOR EACH ROW INSERT INTO audit_fixture VALUES(NEW.v + ${addition})`);
      try {
        await create(1); const initial = await build(); assert.equal(initial.target.targetTriggerReview.complete, true);
        await admin.query('DROP TRIGGER after_items'); await create(2);
        const bodyChanged = await build(); assert.notEqual(initial.facts.triggers[0].actionDigest, bodyChanged.facts.triggers[0].actionDigest);
        assert.notEqual(initial.target.snapshotId, bodyChanged.target.snapshotId); assert.notEqual(initial.plan.planId, bodyChanged.plan.planId);
        const drift = compareObservations(observation(initial), observation(bodyChanged));
        assert.equal(drift.status, 'changed'); assert.equal(drift.metadataChanged, true); assert.equal(drift.sourceChanged, false);
        await admin.query('DROP TRIGGER after_items');
        const flags = originalMode.split(',').filter(Boolean), flag = 'NO_UNSIGNED_SUBTRACTION';
        await admin.query('SET SESSION sql_mode = ?', [flags.includes(flag) ? flags.filter(value => value !== flag).join(',') : [...flags, flag].join(',')]);
        await create(2);
        const contextChanged = await build(); assert.equal(contextChanged.facts.triggers[0].actionDigest, bodyChanged.facts.triggers[0].actionDigest);
        assert.notEqual(contextChanged.facts.triggers[0].contextDigest, bodyChanged.facts.triggers[0].contextDigest);
        assert.notEqual(contextChanged.target.snapshotId, bodyChanged.target.snapshotId); assert.notEqual(contextChanged.plan.planId, bodyChanged.plan.planId);
        assert.equal(compareObservations(observation(bodyChanged), observation(contextChanged)).metadataChanged, true);
        await admin.query('CREATE TRIGGER second_items AFTER INSERT ON items FOR EACH ROW FOLLOWS after_items INSERT INTO audit_fixture VALUES(NEW.v)');
        const ordered = await build(); assert.equal(ordered.target.targetTriggerReview.complete, true);
        assert.deepEqual(ordered.target.targetTriggerReview.rows.map(row => row.actionOrder), [1, 2]);
        assert.equal(ordered.plan.canExecute, false); assert.equal(await count('items'), 0); assert.equal(await count('audit_fixture'), 0);
        const json = JSON.stringify({ target: ordered.target, plan: ordered.plan });
        for (const trigger of ordered.facts.triggers) {
          assert.equal(json.includes(trigger.actionDigest), false); assert.equal(json.includes(trigger.contextDigest), false);
        }
        assert.equal(json.includes('NEW.v'), false); assert.equal(json.includes('root@'), false);
      } finally {
        await admin.query('SET SESSION sql_mode = ?', [originalMode]);
        await admin.query('DROP TRIGGER IF EXISTS second_items'); await admin.query('DROP TRIGGER IF EXISTS after_items'); await admin.query('DROP TABLE audit_fixture');
      }
    });

    await t.test('denied or incomplete trigger definitions retain unknown and all side-effect gates', async () => {
      await admin.query('CREATE TRIGGER after_items BEFORE INSERT ON items FOR EACH ROW SET NEW.v=NEW.v');
      try {
        reader.raw = async (sql, ...args) => {
          const result = await recorded(sql, ...args);
          if (sql.includes('FROM information_schema.TRIGGERS')) result.rows = result.rows.map(row => ({ ...row, actionDigest: null, contextDigest: null }));
          return result;
        };
        const unknown = await build(); assert.equal(unknown.target.targetTriggerReview.complete, false); assert.equal(unknown.target.targetTriggerReview.totals.unknown, 1);
        assert.ok(unknown.plan.blockers.some(item => item.code === 'TARGET_TRIGGER_EFFECTS_NOT_VALIDATED')); assert.equal(unknown.plan.canExecute, false);
        reader.raw = async (sql, ...args) => {
          if (sql.includes('FROM information_schema.TRIGGERS')) throw Object.assign(new Error('private-trigger-error'), { code: 'ER_TABLEACCESS_DENIED_ERROR' });
          return recorded(sql, ...args);
        };
        const denied = await build(); assert.equal(denied.target.targetTriggerReview.complete, false); assert.equal(denied.plan.canExecute, false);
        assert.equal(JSON.stringify(denied).includes('private-trigger-error'), false);
        assert.ok(denied.plan.blockers.some(item => item.code === 'TARGET_TRIGGER_METADATA_INCOMPLETE'));
      } finally { reader.raw = recorded; await admin.query('DROP TRIGGER after_items'); }
    });

    await t.test('missing/malformed/denied table metadata stays unknown without an engine fallback', async () => {
      try {
        for (const engine of [null, undefined, '<private-engine>']) {
          reader.raw = async (sql, ...args) => {
            const result = await recorded(sql, ...args);
            if (sql.includes('FROM information_schema.TABLES')) result.rows = result.rows.map(row => ({ ...row, engine }));
            return result;
          };
          const missing = await build(); assert.equal(missing.target.rows[0].engineReview.status, 'unknown');
          assert.equal(missing.plan.steps[1].reason, 'TARGET_ENGINE_NOT_REVIEWED'); assert.equal(missing.plan.canExecute, false);
          assert.equal(JSON.stringify(missing).includes('private-engine'), false);
        }
        reader.raw = async (sql, ...args) => {
          if (sql.includes('FROM information_schema.TABLES')) throw Object.assign(new Error('private-engine-error'), { code: 'ER_TABLEACCESS_DENIED_ERROR' });
          return recorded(sql, ...args);
        };
        const denied = await build(); assert.equal(denied.target.rows[0].engineReview.status, 'unknown');
        assert.equal(denied.plan.steps[1].reason, 'POLICY_METADATA_INCOMPLETE'); assert.equal(denied.plan.canExecute, false);
        assert.equal(JSON.stringify(denied).includes('private-engine-error'), false);
      } finally { reader.raw = recorded; }
    });

    await t.test('all preview queries are SELECT and Reader/Editor settings, connection and transaction are preserved', async () => {
      assert.ok(queries.length); assert.ok(queries.every(sql => /^SELECT /.test(sql)));
      assert.deepEqual((await settings(reader)).rows, beforeReader); assert.deepEqual((await settings(editor)).rows, beforeEditor);
      assert.equal(editor.inTransaction, true); assert.equal(await count('items'), 0);
    });
  } finally {
    try { if (editor.inTransaction) await editor.runQuery('ROLLBACK'); }
    finally {
      await Promise.allSettled([reader.close(), editor.close()]);
      try { if (created) await admin.query(`DROP DATABASE \`${database}\``); } finally { await admin.end(); }
    }
  }
});
