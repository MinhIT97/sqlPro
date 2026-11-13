'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewTargetForeignKeys } = require('../electron/restore-selection-target-foreign-keys.cjs');
const options = { database: 'demo', selectedTables: ['parent', 'child'], lowerCaseTableNames: 0, metadataComplete: true };
const part = (changes = {}) => ({ name: 'fk_pair', tableSchema: 'demo', table: 'child', column: 'pa', referencedSchema: 'demo', referencedTable: 'parent', referencedColumn: 'a',
  ordinal: 1, onDelete: 'SET NULL', onUpdate: 'CASCADE', match: 'NONE', ...changes });
const pair = () => [part(), part({ ordinal: 2, column: 'pb', referencedColumn: 'b' })];

test('groups exact qualified FK identities, preserves ordered pairs/actions and distinguishes relation scope', () => {
  const input = pair().reverse(), before = structuredClone(input);
  const report = reviewTargetForeignKeys(input, options);
  assert.equal(report.canExecute, false); assert.equal(report.complete, true); assert.equal(report.definitionCount, 1); assert.equal(report.pairCount, 2);
  assert.deepEqual(report.rows[0].pairs, [{ ordinal: 1, column: 'pa', referencedColumn: 'a' }, { ordinal: 2, column: 'pb', referencedColumn: 'b' }]);
  assert.equal(report.rows[0].relation, 'internal'); assert.equal(report.rows[0].onDelete, 'SET NULL'); assert.equal(report.rows[0].onUpdate, 'CASCADE');
  assert.deepEqual(input, before);
  assert.equal(reviewTargetForeignKeys(input, { ...options, selectedTables: ['parent'] }).rows[0].relation, 'inbound');
  assert.equal(reviewTargetForeignKeys(input, { ...options, selectedTables: ['child'] }).rows[0].relation, 'outbound');
  const sameName = [...pair(), ...pair().map(row => ({ ...row, tableSchema: 'external' }))];
  const two = reviewTargetForeignKeys(sameName, options);
  assert.equal(two.rows.length, 2); assert.equal(two.rows[1].relation, 'inbound'); assert.equal(two.totals.inbound, 1); assert.equal(two.totals.internal, 1);
});

test('gaps, duplicates, missing/unsupported or inconsistent actions and references cannot become observed definitions', () => {
  for (const [changes, reason] of [[{ ordinal: 3 }, 'TARGET_FK_PAIRS_INVALID'], [{ ordinal: 1 }, 'TARGET_FK_PAIRS_INVALID'],
    [{ column: 'PA' }, 'TARGET_FK_PAIRS_INVALID'], [{ referencedColumn: 'A' }, 'TARGET_FK_PAIRS_INVALID'],
    [{ onDelete: null, onUpdate: null, match: null }, 'TARGET_FK_ACTIONS_NOT_REVIEWED'],
    [{ onDelete: 'SET DEFAULT' }, 'TARGET_FK_ACTIONS_NOT_REVIEWED'], [{ match: 'FULL' }, 'TARGET_FK_ACTIONS_NOT_REVIEWED']]) {
    const rows = pair(); Object.assign(rows[1], changes);
    if (['onDelete', 'onUpdate', 'match'].some(key => Object.hasOwn(changes, key))) Object.assign(rows[0], changes);
    const report = reviewTargetForeignKeys(rows, options);
    assert.equal(report.rows[0].reason, reason); assert.equal(report.complete, false); assert.equal(report.rows[0].status, 'unknown');
  }
  const mixed = pair(); mixed[1].onDelete = 'CASCADE';
  assert.equal(reviewTargetForeignKeys(mixed, options).rows[0].onDelete, null);
  const cross = pair(); cross[1].referencedSchema = 'unselected';
  const incomplete = reviewTargetForeignKeys(cross, { ...options, selectedTables: ['parent'] });
  assert.equal(incomplete.rows[0].reason, 'TARGET_FK_REFERENCE_INCONSISTENT'); assert.equal(incomplete.rows[0].referencedTable, null);
  assert.equal(incomplete.rows[0].relation, 'inconsistent'); assert.equal(incomplete.rows[0].pairs.length, 2);
});

test('metadata/case uncertainty and folded identity collisions remain unknown; dotted and prototype-like names stay distinct', () => {
  for (const changes of [{ metadataComplete: false }, { lowerCaseTableNames: null }, { selectedTables: ['parent', 'PARENT'], lowerCaseTableNames: 1 }]) {
    assert.equal(reviewTargetForeignKeys(pair(), { ...options, ...changes }).complete, false);
  }
  const ambiguous = [part(), part({ table: 'CHILD' })];
  const folded = reviewTargetForeignKeys(ambiguous, { ...options, lowerCaseTableNames: 1 });
  assert.equal(folded.rows[0].reason, 'TARGET_FK_IDENTITY_AMBIGUOUS'); assert.equal(folded.rows[1].reason, 'TARGET_FK_IDENTITY_AMBIGUOUS');
  const exact = reviewTargetForeignKeys(ambiguous, options); assert.equal(exact.complete, true);
  const dotted = [part({ tableSchema: 'a.b', table: 'c', name: '__proto__' }), part({ tableSchema: 'a', table: 'b.c', name: '__proto__' })];
  assert.equal(reviewTargetForeignKeys(dotted, { ...options, selectedTables: ['parent'] }).rows.length, 2);
  assert.equal(reviewTargetForeignKeys([part({ name: '\u0000' })], options).complete, false);
});

test('definition, pair, finding and input quotas are explicit; projection never retains SQL/private fields', () => {
  const wide = Array.from({ length: 17 }, (_, i) => part({ column: `c${i}`, referencedColumn: `r${i}`, ordinal: i + 1 }));
  const report = reviewTargetForeignKeys(wide, options);
  assert.equal(report.rows[0].pairs.length, 16); assert.equal(report.rows[0].pairCount, 17); assert.equal(report.complete, false);
  const many = reviewTargetForeignKeys(Array.from({ length: 300 }, (_, i) => part({ name: `fk${i}` })), options);
  assert.equal(many.definitionCount, 300); assert.equal(many.rows.length, 200); assert.equal(many.truncated, true); assert.equal(many.totals.observed, 300);
  const pairs = reviewTargetForeignKeys(Array.from({ length: 100 }, (_, i) => wide.slice(0, 16).map(row => ({ ...row, name: `fk${i}` }))).flat(), options);
  assert.ok(pairs.retainedPairs <= 1000); assert.equal(pairs.pairCount, 1600); assert.equal(pairs.truncated, true);
  const invalid = reviewTargetForeignKeys(Array(5001).fill(part({ name: '' })), options);
  assert.equal(invalid.findings.length, 50); assert.equal(invalid.truncated, true); assert.equal(invalid.complete, false);
  const secret = reviewTargetForeignKeys([part({ rawSql: 'private-sql', default: 'private-value' })], options);
  assert.equal(JSON.stringify(secret).includes('private-'), false);
  assert.equal(reviewTargetForeignKeys(null, options).complete, false);
});
