'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTargetEngine, reviewTargetEngine } = require('../electron/restore-selection-engines.cjs');
const { collectSelectionTargetFacts, buildSelectionTargetPreview } = require('../electron/restore-selection-target.cjs');
const { RestoreSelectionInventory, previewRestoreSelection } = require('../electron/restore-selection.cjs');
const { assertStatementScope } = require('../electron/sql-script.cjs');
const { buildSelectionDraft } = require('../electron/restore-selection-plan.cjs');
const options = { lowerCaseTableNames: 0, metadataComplete: true, databaseVisible: true };
const row = (engine = 'InnoDB') => ({ name: 'items', objectCount: 1, objects: [{ name: 'items', type: 'table', engine, privateValue: 'private-engine-field' }] });

function fixture(engine = 'InnoDB', flags = {}) {
  const collector = new RestoreSelectionInventory('demo');
  ['CREATE TABLE `items` (`v` INT) ENGINE=InnoDB', 'INSERT INTO items VALUES(1)'].forEach((sql, i) => collector.add(sql, assertStatementScope(sql, 'demo'), i + 1));
  const inventory = collector.finish(), source = previewRestoreSelection(inventory, { tables: ['items'], includeStructure: false, ...flags });
  const targetReview = { canExecute: false, database: 'demo', snapshotId: 'c'.repeat(64), findings: [],
    metadataStatus: { complete: true, databaseVisible: true }, lowerCaseTableNames: 0, rows: [row(engine)] };
  const build = conflictPolicy => buildSelectionDraft({ inventory, source, targetReview, checksum: 'a'.repeat(64), targetIdentity: 'b'.repeat(64), conflictPolicy });
  return { inventory, source, targetReview, build };
}

test('engine normalization bounds names and rejects coerced/SQL/HTML values without guessing transaction support', () => {
  assert.equal(normalizeTargetEngine('innodb'), 'InnoDB');
  for (const name of ['MyISAM', 'Aria', 'MEMORY', 'Custom_engine']) assert.equal(normalizeTargetEngine(name), name);
  for (const value of [null, undefined, 1, true, {}, '', ' InnoDB', 'InnoDB\n', '<img>', 'InnoDB;DROP', 'a'.repeat(65)]) assert.equal(normalizeTargetEngine(value), null);
  const input = row(), before = structuredClone(input), review = reviewTargetEngine(input, options);
  assert.equal(review.reason, 'TARGET_ENGINE_INNODB_OBSERVED'); assert.equal(review.status, 'observed');
  assert.equal(JSON.stringify(review).includes('private-engine-field'), false); assert.deepEqual(input, before);
  for (const engine of ['MyISAM', 'Aria', 'MEMORY', 'Custom_engine']) assert.equal(reviewTargetEngine(row(engine), options).reason, 'TARGET_ENGINE_UNSUPPORTED');
});

test('missing, old, mismatched, ambiguous, invisible or incomplete metadata remains unknown', () => {
  for (const input of [row(null), { ...row(), objectCount: 2 }, { ...row(), objects: [] }, null,
    { ...row(), objects: [{ name: 'another', type: 'table', engine: 'InnoDB' }] },
    { ...row(), objects: [{ name: 'items', type: 'view', engine: 'InnoDB' }] },
    { ...row(), objects: [{ name: 'items', type: 'table' }] }]) {
    assert.equal(reviewTargetEngine(input, options).reason, 'TARGET_ENGINE_NOT_REVIEWED');
  }
  for (const change of [{ lowerCaseTableNames: null }, { metadataComplete: false }, { databaseVisible: false }]) {
    assert.equal(reviewTargetEngine(row(), { ...options, ...change }).status, 'unknown');
  }
  const folded = { ...row(), objects: [{ name: 'ITEMS', type: 'table', engine: 'InnoDB' }] };
  assert.equal(reviewTargetEngine(folded, options).status, 'unknown');
  assert.equal(reviewTargetEngine(folded, { ...options, lowerCaseTableNames: 1 }).status, 'observed');
});

test('collector adds engine to the existing bounded SELECT and strips malformed/view/extra data', async () => {
  for (const value of ['InnoDB', 'MyISAM', null, undefined, '<private-engine>', 'a'.repeat(100)]) {
    const queries = [];
    const facts = await collectSelectionTargetFacts({ raw: async (sql, params, timeout) => {
      queries.push(sql); assert.match(sql, /^SELECT /); assert.equal(timeout, 10000);
      if (sql.includes('FROM information_schema.TABLES')) {
        assert.match(sql, /ENGINE AS engine/); assert.deepEqual(params, ['demo']);
        return { rows: [{ name: 'items', type: 'BASE TABLE', engine: value, privateValue: 'private-engine-field' }, { name: 'v', type: 'VIEW', engine: 'InnoDB' }] };
      }
      return { rows: [] };
    } }, 'demo');
    assert.equal(queries.filter(sql => sql.includes('FROM information_schema.TABLES')).length, 1);
    assert.equal(facts.objects[0].engine, normalizeTargetEngine(value)); assert.equal(facts.objects[1].engine, null);
    assert.equal(JSON.stringify(facts).includes('private-engine'), false);
  }
});

test('engine changes bind snapshot and immutable plan independently; data-only unsupported/unknown never becomes candidate', () => {
  const initial = fixture(), first = initial.build();
  assert.equal(first.steps[1].decision, 'candidate'); assert.equal(first.canExecute, false);
  assert.equal(Object.isFrozen(first.targetEngineReview.rows[0].requires), true);
  for (const engine of ['MyISAM', null]) {
    initial.targetReview.rows = [row(engine)]; initial.targetReview.rows[0].engineReview = { version: 1, status: 'observed', engine: 'InnoDB', reason: 'TARGET_ENGINE_INNODB_OBSERVED' };
    const changed = initial.build(); assert.equal(changed.steps[1].decision, 'blocked');
    assert.equal(changed.steps[1].reason, engine ? 'TARGET_ENGINE_UNSUPPORTED' : 'TARGET_ENGINE_NOT_REVIEWED');
    assert.notEqual(changed.planId, first.planId); assert.equal(changed.canExecute, false);
  }
  assert.equal(JSON.stringify(first).includes('private-engine-field'), false);
  for (const code of ['EXECUTION_NOT_IMPLEMENTED', 'TARGET_ENGINE_RECHECK_REQUIRED', 'TARGET_INDIRECT_WRITES_NOT_REVIEWED']) assert.ok(first.blockers.some(item => item.code === code));
  const facts = { database: 'demo', checkedAt: '2026-11-16', version: '8.4', lowerCaseTableNames: 0, databaseVisible: true,
    objects: row().objects, triggers: [], foreignKeys: [], columns: [], indexes: [], errors: [], truncated: [] };
  const preview = () => buildSelectionTargetPreview({ source: initial.source, checksum: 'a'.repeat(64), targetIdentity: 'b'.repeat(64), facts });
  const before = preview(); facts.objects = row('MyISAM').objects;
  assert.notEqual(before.snapshotId, preview().snapshotId); assert.equal(preview().rows[0].engineReview.reason, 'TARGET_ENGINE_UNSUPPORTED');
});

test('skip, structure-only and schema/policy guards keep their priority over engine review', () => {
  const skipped = fixture('MyISAM').build('skip-existing');
  assert.equal(skipped.steps[1].reason, 'POLICY_SKIP_EXISTING_TABLE'); assert.equal(skipped.steps[1].decision, 'excluded');
  const structure = fixture('MyISAM', { includeStructure: true, includeData: false }).build();
  assert.equal(structure.steps[0].reason, 'POLICY_TABLE_EXISTS'); assert.equal(structure.steps[1].reason, 'PART_NOT_SELECTED');
  const unknown = fixture(); unknown.targetReview.metadataStatus.complete = false;
  assert.equal(unknown.build().steps[1].reason, 'POLICY_METADATA_INCOMPLETE');
});
