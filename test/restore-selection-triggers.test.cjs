'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTargetTrigger, reviewTargetTriggers, projectTargetTriggerReview } = require('../electron/restore-selection-triggers.cjs');
const { collectSelectionTargetFacts, buildSelectionTargetPreview } = require('../electron/restore-selection-target.cjs');
const { RestoreSelectionInventory, previewRestoreSelection } = require('../electron/restore-selection.cjs');
const { assertStatementScope } = require('../electron/sql-script.cjs');
const { buildSelectionDraft } = require('../electron/restore-selection-plan.cjs');
const raw = (extra = {}) => ({ name: 'after_items', tableName: 'items', triggerSchema: 'demo', tableSchema: 'demo', event: 'INSERT', timing: 'AFTER',
  orientation: 'ROW', actionOrder: '1', actionDigest: 'a'.repeat(64), contextDigest: 'b'.repeat(64), privateValue: 'private-trigger', ...extra });
const trigger = extra => normalizeTargetTrigger(raw(extra));
const facts = (extra = {}) => ({ triggerMetadataVersion: 1, database: 'demo', databaseVisible: true, lowerCaseTableNames: 0,
  objects: [{ name: 'items', type: 'table', engine: 'InnoDB' }], triggers: [trigger()], errors: [], truncated: [], ...extra });

test('trigger normalization validates identity, bounds optional metadata and strips private fields', () => {
  const input = raw(), before = structuredClone(input), result = normalizeTargetTrigger(input);
  assert.equal(result.actionOrder, 1); assert.equal(result.actionDigest, 'a'.repeat(64)); assert.equal(JSON.stringify(result).includes('private-trigger'), false);
  assert.deepEqual(input, before);
  for (const extra of [{ tableName: '' }, { triggerSchema: 'a'.repeat(65) }, { name: 'a\0b' }, { event: 'INSERT,UPDATE' }, { tableSchema: null }]) assert.equal(normalizeTargetTrigger(raw(extra)), null);
  for (const extra of [{ actionOrder: '1\n' }, { actionOrder: true }, { actionOrder: 5001 }, { actionOrder: 0 }, { orientation: 'STATEMENT' },
    { timing: 'during' }, { actionDigest: 'a'.repeat(64) + '\n' }, { contextDigest: '<private-trigger>' }]) {
    assert.equal(reviewTargetTriggers(facts({ triggers: [trigger(extra)] }), ['items']).complete, false);
  }
});

test('selected trigger review is bounded, metadata-only and never certifies indirect effects or absence', () => {
  const input = facts(), before = structuredClone(input), report = reviewTargetTriggers(input, ['items']);
  assert.equal(report.complete, true); assert.deepEqual(report.totals, { observed: 1, unknown: 0, insert: 1 });
  assert.equal(report.rows[0].status, 'requires-review'); assert.equal(report.canExecute, false);
  assert.ok(report.requires.includes('TARGET_TRIGGER_VISIBILITY_NOT_PROVEN'));
  assert.equal(JSON.stringify(report).includes('a'.repeat(64)), false); assert.equal(JSON.stringify(report).includes('b'.repeat(64)), false);
  assert.deepEqual(input, before); assert.deepEqual(projectTargetTriggerReview(report), report);
  const empty = reviewTargetTriggers(facts({ triggers: [] }), ['items']);
  assert.equal(empty.complete, true); assert.ok(empty.requires.includes('TARGET_TRIGGER_VISIBILITY_NOT_PROVEN'));
  const many = reviewTargetTriggers(facts({ triggers: Array.from({ length: 201 }, (_, i) => trigger({ name: `t${i}`, actionOrder: i + 1 })) }), ['items']);
  assert.equal(many.complete, true); assert.equal(many.truncated, true); assert.equal(many.rows.length, 200); assert.equal(many.totals.observed, 201);
  assert.deepEqual(projectTargetTriggerReview(many), many);
});

test('legacy, denied, wrong schema/case, view, duplicate and quota observations remain unknown', () => {
  for (const extra of [{ triggerMetadataVersion: undefined }, { errors: [{ section: 'triggers' }] }, { truncated: ['triggers'] },
    { databaseVisible: false }, { lowerCaseTableNames: null }, { objects: [] }, { objects: [{ name: 'items', type: 'view' }] },
    { triggers: [trigger(), trigger()] }, { triggers: [trigger({ triggerSchema: 'other' })] }, { triggers: [trigger({ tableSchema: 'other' })] },
    { triggers: [{ name: 'old', table: 'items', event: 'INSERT' }] }, { triggers: Array(5001).fill(trigger()) }]) {
    const report = reviewTargetTriggers(facts(extra), ['items']); assert.equal(report.complete, false); assert.equal(report.totals.observed, 0);
    assert.ok(report.rows.every(row => row.status === 'unknown')); assert.equal(report.canExecute, false);
  }
  const folded = facts({ objects: [{ name: 'ITEMS', type: 'table' }], triggers: [trigger({ tableName: 'ITEMS' })] });
  assert.equal(reviewTargetTriggers(folded, ['items']).totals.observed, 0);
  assert.equal(reviewTargetTriggers({ ...folded, lowerCaseTableNames: 1 }, ['items']).totals.observed, 1);
  const mixed = facts({ triggers: [trigger(), trigger({ name: 'other', actionOrder: 2, actionDigest: null })] });
  assert.equal(reviewTargetTriggers(mixed, ['items']).rows[0].status, 'unknown');
});

test('plan projection rejects malformed/legacy reports and cannot retain expressions, accounts or digests', () => {
  const report = reviewTargetTriggers(facts(), ['items']);
  const forged = structuredClone(report); forged.actionDigest = 'a'.repeat(64); forged.definer = 'private-account'; forged.rows[0].sql = 'private-body';
  assert.deepEqual(projectTargetTriggerReview(forged), report);
  for (const value of [undefined, { ...report, version: 0 }, { ...report, canExecute: true }, { ...report, totals: { observed: 2, unknown: 0, insert: 1 } },
    { ...report, findings: ['private-body'] }, { ...report, rows: [{ ...report.rows[0], actionOrder: '1' }] },
    { ...report, rows: [{ ...report.rows[0], contextObserved: false }] }]) {
    assert.equal(projectTargetTriggerReview(value).complete, false); assert.equal(projectTargetTriggerReview(value).canExecute, false);
  }
});

test('collector uses one fixed bounded SELECT, binds schema and preserves cancel/error behavior', async () => {
  const queries = [];
  const session = { raw: async (sql, params, timeout) => {
    queries.push(sql); assert.match(sql, /^SELECT /); assert.equal(timeout, 10000);
    if (sql.includes('FROM information_schema.TRIGGERS')) {
      assert.deepEqual(params, ["db'quoted", "db'quoted"]); assert.equal(sql.includes("db'quoted"), false);
      assert.match(sql, /SHA2\(ACTION_STATEMENT,256\)/); assert.match(sql, /BETWEEN 1 AND 65536/); assert.match(sql, /AS contextDigest/); assert.match(sql, /LIMIT 5001/);
      return { rows: [raw()] };
    }
    return { rows: [] };
  } };
  const result = await collectSelectionTargetFacts(session, "db'quoted"); assert.equal(result.triggerMetadataVersion, 1);
  assert.deepEqual(result.triggers, [trigger()]); assert.equal(queries.filter(sql => sql.includes('FROM information_schema.TRIGGERS')).length, 1);
  let canceled = false;
  await assert.rejects(() => collectSelectionTargetFacts({ raw: async sql => {
    if (sql.includes('FROM information_schema.TRIGGERS')) canceled = true; return { rows: [] };
  } }, 'demo', () => { if (canceled) throw new Error('cancel-trigger'); }), /cancel-trigger/);
  const denied = await collectSelectionTargetFacts({ raw: async sql => {
    if (sql.includes('FROM information_schema.TRIGGERS')) throw Object.assign(new Error('private-trigger-error'), { code: 'ER_TABLEACCESS_DENIED_ERROR' });
    return { rows: [] };
  } }, 'demo');
  assert.ok(denied.errors.some(error => error.section === 'triggers')); assert.equal(JSON.stringify(denied).includes('private-trigger-error'), false);
});

test('trigger projection rejects an INSERT count inconsistent with retained events, including truncated reports', () => {
  const report = reviewTargetTriggers(facts(), ['items']);
  for (const insert of [0, 2]) assert.equal(projectTargetTriggerReview({ ...report, totals: { ...report.totals, insert } }).complete, false);
  const truncated = { ...report, truncated: true, totals: { observed: 3, unknown: 0, insert: 0 } };
  assert.equal(projectTargetTriggerReview(truncated).complete, false);
  const update = { ...report, rows: [{ ...report.rows[0], event: 'UPDATE' }], truncated: true,
    totals: { observed: 3, unknown: 0, insert: 3 } };
  assert.equal(projectTargetTriggerReview(update).complete, false);
  assert.equal(projectTargetTriggerReview({ ...update, totals: { observed: 3, unknown: 0, insert: 2 } }).complete, true);
});

test('trigger body/context/timing/order bind target snapshot and immutable plan without exposing individual digests', () => {
  const collector = new RestoreSelectionInventory('demo');
  ['CREATE TABLE `items` (`v` INT) ENGINE=InnoDB', 'INSERT INTO items VALUES(1)'].forEach((sql, i) => collector.add(sql, assertStatementScope(sql, 'demo'), i + 1));
  const inventory = collector.finish(), source = previewRestoreSelection(inventory, { tables: ['items'], includeStructure: false });
  const build = extra => {
    const target = buildSelectionTargetPreview({ source, checksum: 'c'.repeat(64), targetIdentity: 'd'.repeat(64),
      facts: facts({ checkedAt: '2026-11-16', version: '8.4', foreignKeys: [], columns: [], indexes: [], ...extra }) });
    return { target, plan: buildSelectionDraft({ inventory, source, targetReview: target, checksum: 'c'.repeat(64), targetIdentity: 'd'.repeat(64) }) };
  };
  const initial = build(); assert.equal(initial.target.version, 16); assert.equal(initial.plan.version, 29);
  for (const change of [{ actionDigest: 'e'.repeat(64) }, { contextDigest: 'e'.repeat(64) }, { timing: 'BEFORE' }, { actionOrder: 2 }]) {
    const next = build({ triggers: [trigger(change)] }); assert.notEqual(next.target.snapshotId, initial.target.snapshotId); assert.notEqual(next.plan.planId, initial.plan.planId);
    assert.equal(next.plan.canExecute, false);
  }
  assert.equal(Object.isFrozen(initial.plan.targetTriggerReview.rows[0]), true);
  assert.equal(JSON.stringify(initial.target).includes('a'.repeat(64)), false); assert.equal(JSON.stringify(initial.plan).includes('b'.repeat(64)), false);
  assert.ok(initial.plan.blockers.some(item => item.code === 'TARGET_TRIGGER_EFFECTS_NOT_VALIDATED'));
});
