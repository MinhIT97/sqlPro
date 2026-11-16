'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { DatabaseSession } = require('../electron/database.cjs');
const { RestoreSelectionInventory, previewRestoreSelection } = require('../electron/restore-selection.cjs');
const { assertStatementScope } = require('../electron/sql-script.cjs');
const { collectSelectionTargetFacts, buildSelectionTargetPreview } = require('../electron/restore-selection-target.cjs');
const { reviewTargetReferencedIndex } = require('../electron/restore-selection-target-indexes.cjs');
const { buildSelectionDraft } = require('../electron/restore-selection-plan.cjs');

test('index visibility integration: capability, drift and conservative observation on an isolated database', {
  skip: !process.env.SQLPRO_TEST_INDEX_PORT,
  timeout: 30000
}, async t => {
  const database = `sqlpro_visibility_${Date.now()}_${process.pid}`;
  const profile = { host: '127.0.0.1', port: Number(process.env.SQLPRO_TEST_INDEX_PORT), user: 'root', password: '', database,
    ssl: { enabled: false }, ssh: { enabled: false } };
  const admin = await mysql.createConnection({ host: profile.host, port: profile.port, user: profile.user });
  const reader = new DatabaseSession(profile), editor = new DatabaseSession(profile);
  let created = false;
  try {
    await admin.query(`CREATE DATABASE \`${database}\``); created = true;
    await admin.query(`USE \`${database}\``);
    const ddl = 'CREATE TABLE `visibility_parent` (`id` INT NOT NULL, `a` INT, `b` INT, PRIMARY KEY (`id`), UNIQUE KEY `pair_unique` (`a`,`b`)) ENGINE=InnoDB';
    await admin.query(ddl); await admin.query('INSERT INTO visibility_parent VALUES (1,10,20)');
    await reader.connect(); await editor.connect(); await editor.runQuery('START TRANSACTION');
    const inventory = new RestoreSelectionInventory(database); inventory.add(ddl, assertStatementScope(ddl, database), 1);
    const data = inventory.finish(), source = previewRestoreSelection(data, { tables: ['visibility_parent'], includeData: false });
    const preview = facts => buildSelectionTargetPreview({ source, checksum: 'a'.repeat(64), targetIdentity: 'b'.repeat(64), facts });
    const plan = targetReview => buildSelectionDraft({ inventory: data, source, checksum: 'a'.repeat(64), targetIdentity: 'b'.repeat(64), targetReview });
    const read = () => collectSelectionTargetFacts(reader, database, () => {}, source.selectedTables);
    let initial, kind;

    await t.test('reads supported flag metadata and leaves the editor transaction and fixture untouched', async () => {
      const facts = await read(); kind = facts.indexVisibility.kind;
      assert.deepEqual(facts.errors, []); assert.equal(facts.indexVisibility.status, 'observed');
      assert.ok(['mysql-visible', 'mariadb-ignored'].includes(kind));
      if (process.env.SQLPRO_TEST_INDEX_KIND) assert.equal(kind, process.env.SQLPRO_TEST_INDEX_KIND);
      initial = preview(facts);
      assert.equal(initial.version, 16); assert.equal(initial.rows[0].indexReview.complete, true);
      assert.equal(reviewTargetReferencedIndex(initial.rows[0].indexReview, ['a', 'b']).status, 'observed-match');
      assert.equal(plan(initial).canExecute, false); assert.equal(editor.inTransaction, true);
      assert.deepEqual((await admin.query('SELECT * FROM visibility_parent'))[0].map(row => [row.id, row.a, row.b]), [[1, 10, 20]]);
    });

    await t.test('hidden/ignored flags change the digest and require review; uniqueness remains enforced', async () => {
      assert.ok(['mysql-visible', 'mariadb-ignored'].includes(kind));
      await admin.query(`ALTER TABLE visibility_parent ALTER INDEX pair_unique ${kind === 'mysql-visible' ? 'INVISIBLE' : 'IGNORED'}`);
      const hidden = preview(await read()), observation = reviewTargetReferencedIndex(hidden.rows[0].indexReview, ['a', 'b']);
      assert.equal(observation.status, 'requires-review'); assert.equal(observation.code, 'FK_TARGET_KEY_INVISIBLE_OR_IGNORED');
      assert.equal(observation.visibility, kind === 'mysql-visible' ? 'invisible' : 'ignored');
      assert.notEqual(hidden.snapshotId, initial.snapshotId); assert.notEqual(plan(hidden).planId, plan(initial).planId);
      assert.equal(plan(hidden).canExecute, false); assert.equal(editor.inTransaction, true);
      await assert.rejects(() => admin.query('INSERT INTO visibility_parent VALUES (2,10,20)'), error => error.code === 'ER_DUP_ENTRY');
      await admin.query(`ALTER TABLE visibility_parent ALTER INDEX pair_unique ${kind === 'mysql-visible' ? 'VISIBLE' : 'NOT IGNORED'}`);
      assert.equal(reviewTargetReferencedIndex(preview(await read()).rows[0].indexReview, ['a', 'b']).status, 'observed-match');
      assert.deepEqual((await admin.query('SELECT * FROM visibility_parent'))[0].map(row => [row.id, row.a, row.b]), [[1, 10, 20]]);
    });

    await t.test('denied or missing capabilities retain unknown observations while basic metadata is still readable', async () => {
      for (const denied of [false, true]) {
        const facts = await collectSelectionTargetFacts({ raw: async (sql, params, timeout) => {
          if (sql.includes('COLUMN_NAME AS name FROM information_schema.COLUMNS')) {
            if (denied) throw Object.assign(new Error('private-error'), { code: 'ER_TABLEACCESS_DENIED_ERROR' });
            return { rows: [] };
          }
          return reader.raw(sql, params, timeout);
        } }, database, () => {}, source.selectedTables);
        assert.equal(facts.indexVisibility.kind, null); assert.equal(facts.indexes[0].visibility, 'unknown');
        assert.equal(reviewTargetReferencedIndex(preview(facts).rows[0].indexReview, ['a', 'b']).status, 'unknown');
        assert.equal(JSON.stringify(facts).includes('private-'), false);
        if (denied) assert.equal(preview(facts).metadataStatus.complete, false);
      }
      assert.equal(editor.inTransaction, true);
    });
  } finally {
    await Promise.allSettled([reader.close(), editor.close()]);
    try { if (created) await admin.query(`DROP DATABASE \`${database}\``); }
    finally { await admin.end(); }
  }
});
