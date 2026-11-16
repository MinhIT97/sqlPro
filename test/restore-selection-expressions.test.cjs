'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeColumnExpressions, reviewTargetExpressions, projectTargetExpressions, COLUMN_EXPRESSION_SQL } = require('../electron/restore-selection-expressions.cjs');
const { collectSelectionTargetFacts, buildSelectionTargetPreview } = require('../electron/restore-selection-target.cjs');
const { RestoreSelectionInventory, previewRestoreSelection } = require('../electron/restore-selection.cjs');
const { assertStatementScope } = require('../electron/sql-script.cjs');
const { buildSelectionDraft } = require('../electron/restore-selection-plan.cjs');
const profile = (extra = {}) => ({ version: 1, defaultStatus: 'observed', defaultDigest: 'a'.repeat(64), generatedStatus: 'observed', generatedDigest: 'b'.repeat(64), ...extra });
const column = (extra = {}) => ({ table: 'items', name: 'computed', hasDefault: true, generated: true, expressionProfile: profile(), ...extra });
const facts = (extra = {}) => ({ database: 'demo', databaseVisible: true, lowerCaseTableNames: 0, objects: [{ name: 'items', type: 'table', engine: 'InnoDB' }],
  columns: [column()], errors: [], truncated: [], ...extra });

test('expression profiles validate status/digest/flags, distinguish NULL metadata from absence and strip all raw fields', () => {
  const raw = profile({ rawDefault: 'private-default', rawExpression: 'private-expression' }), before = structuredClone(raw);
  assert.deepEqual(normalizeColumnExpressions(raw, true, true), profile()); assert.deepEqual(raw, before);
  const none = normalizeColumnExpressions({ defaultStatus: 'null-metadata', defaultDigest: null, generatedStatus: 'not-reported', generatedDigest: null }, false, false);
  assert.equal(none.defaultStatus, 'null-metadata'); assert.equal(none.generatedStatus, 'not-reported');
  for (const extra of [{ defaultDigest: null }, { defaultDigest: 'a'.repeat(64) + '\n' }, { defaultStatus: true }, { defaultStatus: 'null-metadata' }]) {
    assert.equal(normalizeColumnExpressions(profile(extra), true, true).defaultStatus, 'unknown');
  }
  for (const extra of [{ generatedDigest: null }, { generatedDigest: 'b'.repeat(65) }, { generatedStatus: 'not-reported' }, { generatedStatus: 1 }]) {
    assert.equal(normalizeColumnExpressions(profile(extra), true, true).generatedStatus, 'unknown');
  }
  assert.equal(normalizeColumnExpressions(profile(), false, false).defaultStatus, 'unknown');
  assert.equal(normalizeColumnExpressions(profile(), true, false).generatedStatus, 'unknown');
  assert.equal(normalizeColumnExpressions({ ...none, generatedStatus: 'not-reported' }, false, true).generatedStatus, 'unknown');
  assert.equal(normalizeColumnExpressions(null).defaultStatus, 'unknown');
});

test('reports retain only statuses and exact identifiers, with no expression/digest or semantic approval', () => {
  const input = facts(), before = structuredClone(input), report = reviewTargetExpressions(input, ['items']);
  assert.equal(report.complete, true); assert.equal(report.rows[0].status, 'metadata-observed'); assert.equal(report.canExecute, false);
  assert.deepEqual(report.totals, { observed: 1, unknown: 0 }); assert.deepEqual(projectTargetExpressions(report), report);
  for (const text of ['a'.repeat(64), 'b'.repeat(64), 'expressionProfile']) assert.equal(JSON.stringify(report).includes(text), false);
  assert.deepEqual(input, before); assert.ok(report.requires.includes('TARGET_DEFAULT_VALUES_NOT_VALIDATED'));
  assert.ok(report.requires.includes('TARGET_GENERATED_VALUES_NOT_VALIDATED'));
});

test('missing/legacy/denied/malformed/ambiguous metadata and quotas never certify expressions', () => {
  for (const change of [{ columns: [] }, { columns: [column({ expressionProfile: undefined })] }, { columns: [column({ expressionProfile: { ...profile(), version: 0 } })] },
    { columns: [column(), column()] }, { objects: [] }, { objects: [{ name: 'items', type: 'view' }] }, { lowerCaseTableNames: null },
    { databaseVisible: false }, { errors: [{ section: 'columns' }] }, { truncated: ['columns'] }, { columns: Array(10001).fill(column()) }]) {
    const result = reviewTargetExpressions(facts(change), ['items']); assert.equal(result.complete, false); assert.equal(result.canExecute, false);
    assert.ok(result.findings.includes('TARGET_COLUMN_EXPRESSIONS_INCOMPLETE'));
  }
  const many = facts({ columns: Array.from({ length: 201 }, (_, index) => column({ name: `c${index}` })) });
  const bounded = reviewTargetExpressions(many, ['items']); assert.equal(bounded.rows.length, 200); assert.equal(bounded.totals.observed, 201);
  assert.equal(bounded.truncated, true); assert.deepEqual(projectTargetExpressions(bounded), bounded);
  const folded = facts({ columns: [column({ table: 'ITEMS' })], objects: [{ name: 'ITEMS', type: 'table' }] });
  assert.equal(reviewTargetExpressions(folded, ['items']).complete, false);
  assert.equal(reviewTargetExpressions({ ...folded, lowerCaseTableNames: 1 }, ['items']).complete, true);
});

test('malformed and forged report projections remain unknown and reject count/status inconsistencies', () => {
  const report = reviewTargetExpressions(facts(), ['items']);
  const extra = structuredClone(report); extra.sql = 'private-sql'; extra.rows[0].defaultDigest = 'a'.repeat(64); extra.requires = ['private-requirement'];
  assert.deepEqual(projectTargetExpressions(extra), report);
  for (const value of [undefined, { ...report, canExecute: true }, { ...report, version: 0 }, { ...report, findings: ['private'] },
    { ...report, totals: { observed: 2, unknown: 0 } }, { ...report, rows: [{ ...report.rows[0], status: 'unknown' }] },
    { ...report, rows: [{ ...report.rows[0], defaultStatus: 'unknown' }] }]) assert.equal(projectTargetExpressions(value).complete, false);
});

test('duplicate column identities invalidate both observations while unrelated columns remain independent', () => {
  const duplicate = column(), input = facts({ columns: [duplicate, column({ name: 'other' }), structuredClone(duplicate)] });
  const report = reviewTargetExpressions(input, ['items']);
  assert.equal(report.complete, false);
  assert.deepEqual(report.rows.filter(row => row.column === 'computed').map(row => row.status), ['unknown', 'unknown']);
  assert.equal(report.rows.find(row => row.column === 'other').status, 'metadata-observed');
  assert.deepEqual(report.totals, { observed: 1, unknown: 2 });
  assert.deepEqual(projectTargetExpressions(report), report);
});

test('collector hashes bounded default/generated metadata in the existing SELECT and never retains raw text', async () => {
  let query;
  const result = await collectSelectionTargetFacts({ raw: async (sql, params) => {
    if (!sql.includes('COLUMN_TYPE AS columnType')) return { rows: [] };
    query = { sql, params }; return { rows: [{ tableName: 'items', name: 'computed', ordinal: 1, columnType: 'int', nullable: 'YES',
      extra: 'STORED GENERATED', charset: null, collation: null, hasDefault: 1, ...profile(), defaultValue: 'private-default', generationExpression: 'private-expression' }] };
  } }, "db'quoted", () => {}, ["odd'name"]);
  assert.deepEqual(query.params, ["db'quoted", "odd'name"]); assert.equal(query.sql.includes("odd'name"), false);
  assert.ok(query.sql.includes(COLUMN_EXPRESSION_SQL)); assert.match(query.sql, /BETWEEN 0 AND 65536/); assert.match(query.sql, /BETWEEN 1 AND 65536/);
  assert.deepEqual(result.columns[0].expressionProfile, profile()); assert.equal(JSON.stringify(result).includes('private-'), false);
});

test('changes between two non-null defaults or two generated expressions bind all identities without exposing digests', () => {
  const collector = new RestoreSelectionInventory('demo');
  ['CREATE TABLE `items` (`v` INT) ENGINE=InnoDB', 'INSERT INTO items VALUES(1)'].forEach((sql, i) => collector.add(sql, assertStatementScope(sql, 'demo'), i + 1));
  const inventory = collector.finish(), source = previewRestoreSelection(inventory, { tables: ['items'], includeStructure: false });
  const build = (changes = {}) => {
    const target = buildSelectionTargetPreview({ source, checksum: 'c'.repeat(64), targetIdentity: 'd'.repeat(64), facts: facts({
      checkedAt: '2026-11-16', version: '8.4', triggers: [], foreignKeys: [], indexes: [], columns: [column({ expressionProfile: profile(changes) })] }) });
    return { target, plan: buildSelectionDraft({ inventory, source, targetReview: target, checksum: 'c'.repeat(64), targetIdentity: 'd'.repeat(64) }) };
  };
  const initial = build(); assert.equal(initial.target.version, 16); assert.equal(initial.plan.version, 29);
  for (const changes of [{ defaultDigest: 'e'.repeat(64) }, { generatedDigest: 'e'.repeat(64) }]) {
    const changed = build(changes); assert.notEqual(changed.target.metadataId, initial.target.metadataId); assert.notEqual(changed.target.snapshotId, initial.target.snapshotId);
    assert.notEqual(changed.plan.planId, initial.plan.planId); assert.equal(changed.plan.canExecute, false);
  }
  assert.equal(Object.isFrozen(initial.plan.targetExpressionReview.rows[0]), true);
  for (const text of ['a'.repeat(64), 'b'.repeat(64)]) assert.equal(JSON.stringify(initial).includes(text), false);
  for (const code of ['TARGET_DEFAULT_VALUES_NOT_VALIDATED', 'TARGET_GENERATED_VALUES_NOT_VALIDATED', 'TARGET_COLUMN_EXPRESSIONS_RECHECK_REQUIRED']) {
    assert.ok(initial.plan.blockers.some(item => item.code === code));
  }
});
