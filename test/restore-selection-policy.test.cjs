'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeConflictPolicy, reviewConflictPolicy } = require('../electron/restore-selection-policy.cjs');
const source = (overrides = {}) => ({ canExecute: false, sourceDatabase: 'source_db', includeStructure: true, includeData: true,
  rows: ['items', 'new_table'].map(name => ({ name, dependencies: [] })), ...overrides });
const target = (overrides = {}) => ({ canExecute: false, lowerCaseTableNames: 0, metadataStatus: { complete: true, databaseVisible: true },
  findingsTruncated: false, rows: [{ name: 'items', objects: [{ name: 'items', type: 'table' }], objectCount: 1 },
    { name: 'new_table', objects: [], objectCount: 0 }], ...overrides });
const review = (conflictPolicy, selected = source(), observed = target()) => reviewConflictPolicy({ source: selected, targetReview: observed, conflictPolicy });

test('default policy blocks existing structure and only proposes unseen creation with absence/recheck requirements', () => {
  const first = source(), second = target(), before = structuredClone({ first, second });
  const result = review(undefined, first, second);
  assert.equal(result.policy, 'stop-on-conflict'); assert.equal(result.canExecute, false); assert.equal(result.destructiveChangesAllowed, false);
  assert.equal(result.rows[0].disposition, 'blocked'); assert.equal(result.rows[0].reason, 'POLICY_TABLE_EXISTS');
  assert.equal(result.rows[1].observed, 'not-seen'); assert.equal(result.rows[1].proposal, 'create-table');
  assert.deepEqual(result.rows[1].requires, ['POLICY_TARGET_RECHECK_REQUIRED', 'POLICY_ABSENCE_NOT_PROVEN']);
  assert.deepEqual({ first, second }, before);
});

test('skip-existing excludes the whole observed table but never replaces or silently skips a view', () => {
  const result = review('skip-existing');
  assert.equal(result.rows[0].disposition, 'skip'); assert.equal(result.rows[0].proposal, 'skip-table');
  assert.deepEqual(result.totals, { skip: 1, review: 1, blocked: 0 });
  const observed = target(); observed.rows[0].objects[0].type = 'view';
  assert.equal(review('skip-existing', source(), observed).rows[0].reason, 'POLICY_VIEW_CONFLICT');
});

test('data-only requires a visible table and reports append risks, while skip still skips existing data', () => {
  const selected = source({ includeStructure: false });
  const result = review(undefined, selected);
  assert.equal(result.rows[0].proposal, 'append-data'); assert.equal(result.rows[0].disposition, 'review');
  assert.ok(result.rows[0].requires.includes('POLICY_APPEND_VALUES_NOT_VALIDATED'));
  assert.equal(result.rows[1].reason, 'POLICY_DATA_TABLE_NOT_SEEN'); assert.equal(result.rows[1].disposition, 'blocked');
  assert.equal(review('skip-existing', selected).rows[0].disposition, 'skip');
});

test('unknown case/database, errors, truncation and old observations do not authorize skip or creation', () => {
  for (const overrides of [{ lowerCaseTableNames: null }, { metadataStatus: undefined }, { metadataStatus: { complete: false, databaseVisible: true } },
    { metadataStatus: { complete: true, databaseVisible: false } }, { findingsTruncated: true }, { rows: [] }, { rows: {} }, { rows: Array(1001).fill({}) }]) {
    const result = review('skip-existing', source(), target(overrides));
    assert.ok(result.rows.every(row => row.disposition === 'blocked'), JSON.stringify(overrides));
    assert.equal(result.rows[0].reason, 'POLICY_METADATA_INCOMPLETE');
  }
});

test('case-folded collisions, duplicate observations and incomplete object lists are blocked', () => {
  const selected = source({ rows: [{ name: 'Items', dependencies: [] }, { name: 'items', dependencies: [] }] });
  assert.ok(review('skip-existing', selected, target({ lowerCaseTableNames: 1 })).rows.every(row => row.reason === 'POLICY_SOURCE_NAME_AMBIGUOUS'));
  const variants = [
    { name: 'items', objects: [{ name: 'items', type: 'table' }, { name: 'ITEMS', type: 'table' }], objectCount: 2 },
    { name: 'items', objects: [{ name: 'other', type: 'table' }], objectCount: 1 },
    { name: 'items', objects: [{ name: 'items', type: 'table' }], objectCount: 2 },
    { name: 'items', objects: [{ name: 'items', type: 'unknown' }], objectCount: 1 }
  ];
  for (const row of variants) assert.equal(review('skip-existing', source(), target({ lowerCaseTableNames: 1, rows: [row] })).rows[0].disposition, 'blocked');
  const repeated = target(); repeated.rows.push(repeated.rows[0]);
  assert.equal(review('skip-existing', source(), repeated).rows[0].disposition, 'blocked');
  const folded = target({ lowerCaseTableNames: 1 }); folded.rows[0].objects[0].name = 'ITEMS';
  assert.equal(review('skip-existing', source(), folded).rows[0].disposition, 'skip');
});

test('a new selected table depending on a skipped table requires dependency review', () => {
  const selected = source(); selected.rows[1].dependencies = [{ schema: null, table: 'items' }];
  const result = review('skip-existing', selected);
  assert.equal(result.rows[1].disposition, 'blocked'); assert.equal(result.rows[1].reason, 'POLICY_DEPENDENCY_SKIPPED');
  selected.rows[1].dependencies = undefined;
  assert.equal(review('skip-existing', selected).rows[1].reason, 'POLICY_DEPENDENCIES_UNKNOWN');
  selected.rows[1].dependencies = [null];
  assert.equal(review('skip-existing', selected).rows[1].reason, 'POLICY_DEPENDENCIES_UNKNOWN');
});

test('policies reject destructive/forged inputs, keep arbitrary names safe and enforce source quota', () => {
  for (const value of ['replace', 'drop', 'overwrite', '__proto__', null, false, {}, { confirmed: true }]) assert.throws(() => normalizeConflictPolicy(value), { code: 'INVALID_RESTORE_CONFLICT_POLICY' });
  assert.throws(() => review(undefined, source({ rows: [] })));
  assert.throws(() => review(undefined, source({ includeStructure: false, includeData: false })));
  assert.throws(() => review(undefined, source({ rows: Array.from({ length: 1001 }, (_, i) => ({ name: `t${i}`, dependencies: [] })) })));
  const selected = source({ rows: [{ name: '__proto__', dependencies: [] }] });
  const observed = target({ rows: [{ name: '__proto__', objects: [], objectCount: 0 }] });
  assert.equal(review(undefined, selected, observed).rows[0].proposal, 'create-table');
  observed.rows[0].privateValue = 'private-metadata';
  assert.equal(JSON.stringify(review(undefined, selected, observed)).includes('private-metadata'), false);
});
