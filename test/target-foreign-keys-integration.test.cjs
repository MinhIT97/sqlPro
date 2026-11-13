'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { DatabaseSession } = require('../electron/database.cjs');
const { RestoreSelectionInventory, previewRestoreSelection } = require('../electron/restore-selection.cjs');
const { assertStatementScope } = require('../electron/sql-script.cjs');
const { collectSelectionTargetFacts, buildSelectionTargetPreview } = require('../electron/restore-selection-target.cjs');
const { buildSelectionDraft } = require('../electron/restore-selection-plan.cjs');

test('target FK integration: ordered composite pairs, rules, external dependencies and drift', {
  skip: !process.env.SQLPRO_TEST_FK_PORT,
  timeout: 30000
}, async t => {
  const database = `sqlpro_fk_${Date.now()}_${process.pid}`, external = `${database}_outside`;
  const profile = { host: '127.0.0.1', port: Number(process.env.SQLPRO_TEST_FK_PORT), user: 'root', password: '', database,
    ssl: { enabled: false }, ssh: { enabled: false } };
  const admin = await mysql.createConnection({ host: profile.host, port: profile.port, user: profile.user });
  const reader = new DatabaseSession(profile), editor = new DatabaseSession(profile);
  let created = false, externalCreated = false;
  try {
    await admin.query(`CREATE DATABASE \`${database}\``); created = true;
    await admin.query(`CREATE DATABASE \`${external}\``); externalCreated = true;
    await admin.query(`USE \`${database}\``);
    const parent = 'CREATE TABLE `parent` (`a` INT NOT NULL, `b` INT NOT NULL, PRIMARY KEY (`a`,`b`)) ENGINE=InnoDB';
    const child = 'CREATE TABLE `child` (`id` INT NOT NULL, `pa` INT, `pb` INT, PRIMARY KEY (`id`), CONSTRAINT `fk_pair` FOREIGN KEY (`pa`,`pb`) REFERENCES `parent` (`a`,`b`) ON DELETE SET NULL ON UPDATE CASCADE) ENGINE=InnoDB';
    await admin.query(parent); await admin.query(child);
    await admin.query(`CREATE TABLE \`${external}\`.child (id INT PRIMARY KEY, pa INT, pb INT, CONSTRAINT fk_pair FOREIGN KEY (pa,pb) REFERENCES \`${database}\`.parent(a,b) ON DELETE RESTRICT ON UPDATE CASCADE) ENGINE=InnoDB`);
    await admin.query('INSERT INTO parent VALUES (10,20)'); await admin.query('INSERT INTO child VALUES (1,10,20)');
    await admin.query(`INSERT INTO \`${external}\`.child VALUES (2,10,20)`);
    await reader.connect(); await editor.connect(); await editor.runQuery('START TRANSACTION');
    const collector = new RestoreSelectionInventory(database);
    collector.add(parent, assertStatementScope(parent, database), 1); collector.add(child, assertStatementScope(child, database), 2);
    const inventory = collector.finish();
    const selected = tables => previewRestoreSelection(inventory, { tables, includeData: false });
    const source = selected(['parent', 'child']);
    const review = (facts, current = source) => buildSelectionTargetPreview({ source: current, checksum: 'a'.repeat(64), targetIdentity: 'b'.repeat(64), facts });
    const plan = targetReview => buildSelectionDraft({ inventory, source, checksum: 'a'.repeat(64), targetIdentity: 'b'.repeat(64), targetReview });
    const read = () => collectSelectionTargetFacts(reader, database, () => {}, source.selectedTables);
    let initial;

    await t.test('qualified joins preserve two same-name composite constraints with distinct actions/scopes', async () => {
      const facts = await read(); assert.deepEqual(facts.errors, []); initial = review(facts);
      const report = initial.targetForeignKeyReview;
      assert.equal(report.complete, true); assert.equal(report.canExecute, false); assert.equal(report.definitionCount, 2); assert.equal(report.pairCount, 4);
      const inside = report.rows.find(row => row.tableSchema === database), outside = report.rows.find(row => row.tableSchema === external);
      assert.equal(inside.name, outside.name); assert.equal(inside.relation, 'internal'); assert.equal(outside.relation, 'inbound');
      assert.equal(inside.onDelete, 'SET NULL'); assert.equal(outside.onDelete, 'RESTRICT'); assert.equal(inside.onUpdate, 'CASCADE');
      assert.deepEqual(inside.pairs, [{ ordinal: 1, column: 'pa', referencedColumn: 'a' }, { ordinal: 2, column: 'pb', referencedColumn: 'b' }]);
      assert.equal(inside.match, 'NONE'); assert.equal(plan(initial).canExecute, false); assert.equal(editor.inTransaction, true);
      const compared = plan(initial).foreignKeyComparison;
      assert.equal(compared.canExecute, false); assert.equal(compared.totals.matched, 1);
      assert.equal(compared.rows[0].target.schema, database);
      const parentOnly = review(facts, selected(['parent']));
      assert.equal(parentOnly.targetForeignKeyReview.totals.inbound, 2);
      assert.equal(parentOnly.findings.filter(item => item.code === 'TARGET_INBOUND_FK_FROM_UNSELECTED_TABLE').length, 2);
    });

    await t.test('changing FK rules changes snapshot/plan identity while fixture rows and editor transaction remain intact', async () => {
      await admin.query('ALTER TABLE child DROP FOREIGN KEY fk_pair');
      await admin.query('ALTER TABLE child ADD CONSTRAINT fk_pair FOREIGN KEY (pa,pb) REFERENCES parent(a,b) ON DELETE CASCADE ON UPDATE RESTRICT');
      const changed = review(await read());
      assert.notEqual(changed.snapshotId, initial.snapshotId); assert.notEqual(plan(changed).planId, plan(initial).planId);
      const definition = changed.targetForeignKeyReview.rows.find(row => row.tableSchema === database);
      assert.equal(definition.onDelete, 'CASCADE'); assert.equal(definition.onUpdate, 'RESTRICT'); assert.equal(plan(changed).canExecute, false);
      const comparison = plan(changed).foreignKeyComparison;
      assert.equal(comparison.totals.differs, 1);
      assert.ok(comparison.rows[0].differences.includes('FK_COMPARE_DELETE_DIFFERS'));
      assert.ok(comparison.rows[0].differences.includes('FK_COMPARE_UPDATE_DIFFERS'));
      assert.equal(editor.inTransaction, true);
      assert.deepEqual((await admin.query('SELECT * FROM child'))[0].map(row => [row.id, row.pa, row.pb]), [[1, 10, 20]]);
      assert.equal((await admin.query('SELECT COUNT(*) AS n FROM parent'))[0][0].n, 1);
      assert.equal((await admin.query(`SELECT COUNT(*) AS n FROM \`${external}\`.child`))[0][0].n, 1);
    });

    await t.test('missing rules and denied metadata cannot become a complete FK report or enable restore', async () => {
      for (const denied of [false, true]) {
        const facts = await collectSelectionTargetFacts({ raw: async (sql, params, timeout) => {
          if (sql.includes('KEY_COLUMN_USAGE') && denied) throw Object.assign(new Error('private-error'), { code: 'ER_TABLEACCESS_DENIED_ERROR' });
          const result = await reader.raw(sql, params, timeout);
          if (sql.includes('KEY_COLUMN_USAGE')) result.rows = result.rows.map(row => ({ ...row, onDelete: null, onUpdate: null, matchOption: null }));
          return result;
        } }, database, () => {}, source.selectedTables);
        const result = review(facts);
        assert.equal(result.targetForeignKeyReview.complete, false); assert.equal(result.metadataStatus.complete, false);
        assert.equal(plan(result).canExecute, false); assert.equal(JSON.stringify(result).includes('private-'), false);
      }
    });
  } finally {
    await Promise.allSettled([reader.close(), editor.close()]);
    try {
      if (externalCreated) await admin.query(`DROP DATABASE \`${external}\``);
      if (created) await admin.query(`DROP DATABASE \`${database}\``);
    } finally { await admin.end(); }
  }
});
