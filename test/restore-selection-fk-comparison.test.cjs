'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compareSelectedForeignKeys } = require('../electron/restore-selection-fk-comparison.cjs');
const fk = (changes = {}) => ({ name: 'fk_pair', columns: ['pa', 'pb'], referencedSchema: null, referencedTable: 'parent', referencedColumns: ['a', 'b'], onDelete: 'SET NULL', onUpdate: 'CASCADE', ...changes });
const target = (changes = {}) => ({ name: 'fk_pair', tableSchema: 'demo', table: 'child', referencedSchema: 'demo', referencedTable: 'parent',
  status: 'observed', match: 'NONE', onDelete: 'SET NULL', onUpdate: 'CASCADE', pairCount: 2,
  pairs: [{ ordinal: 1, column: 'pa', referencedColumn: 'a' }, { ordinal: 2, column: 'pb', referencedColumn: 'b' }], ...changes });
function fixture() {
  return { source: { rows: [{ name: 'child' }] }, targetReview: { database: 'demo', lowerCaseTableNames: 0,
    rows: [{ name: 'child', objectCount: 1, objects: [{ name: 'child', type: 'table' }] }],
    targetForeignKeyReview: { version: 1, canExecute: false, complete: true, truncated: false, definitionCount: 1, rows: [target()] } },
  creates: [{ table: 'child', schema: null, review: { version: 3, status: 'matched', foreignKeys: [fk()] } }] };
}
const compare = input => compareSelectedForeignKeys(input);

test('matches ordered metadata with explicit actions and projects without SQL or write authority', () => {
  const input = fixture(), before = structuredClone(input), report = compare(input);
  assert.equal(report.canExecute, false); assert.equal(report.rows[0].status, 'matched'); assert.equal(report.totals.matched, 1);
  assert.equal(report.rows[0].source.pairs[1].referencedColumn, 'b'); assert.deepEqual(input, before);
  input.creates[0].review.foreignKeys[0].rawSql = 'private-sql'; input.targetReview.targetForeignKeyReview.rows[0].secret = 'private-secret';
  assert.equal(JSON.stringify(compare(input)).includes('private-'), false);
  input.targetReview.targetForeignKeyReview.rows[0].name = 'other_name';
  const renamed = compare(input).rows[0]; assert.equal(renamed.status, 'matched'); assert.equal(renamed.nameDiffers, true);
  input.creates[0].review.foreignKeys[0].name = null;
  assert.equal(compare(input).rows[0].status, 'matched'); assert.equal(compare(input).rows[0].nameDiffers, false);
});

test('different local/remote order, references and actions remain explicit differences', () => {
  for (const [change, code] of [
    [row => row.pairs.reverse().forEach((part, index) => { part.ordinal = index + 1; }), 'FK_COMPARE_LOCAL_COLUMNS_DIFFER'],
    [row => { row.pairs[0].referencedColumn = 'other'; }, 'FK_COMPARE_REMOTE_COLUMNS_DIFFER'],
    [row => { row.referencedTable = 'other'; }, 'FK_COMPARE_REFERENCE_DIFFERS'],
    [row => { row.onDelete = 'CASCADE'; }, 'FK_COMPARE_DELETE_DIFFERS'],
    [row => { row.onUpdate = 'NO ACTION'; }, 'FK_COMPARE_UPDATE_DIFFERS']]) {
    const input = fixture(); change(input.targetReview.targetForeignKeyReview.rows[0]);
    const row = compare(input).rows[0]; assert.equal(row.status, 'differs'); assert.ok(row.differences.includes(code));
  }
  const omitted = fixture(); omitted.creates[0].review.foreignKeys[0].onDelete = null;
  assert.equal(compare(omitted).rows[0].reason, 'FK_COMPARE_SOURCE_ACTION_UNSPECIFIED');
  assert.equal(compare(omitted).rows[0].status, 'unknown');
});

test('absence, extra target constraints, unseen owners and ambiguous matches are observations only', () => {
  const missing = fixture(); missing.targetReview.targetForeignKeyReview.rows = []; missing.targetReview.targetForeignKeyReview.definitionCount = 0;
  assert.equal(compare(missing).rows[0].status, 'notObserved'); assert.equal(compare(missing).canExecute, false);
  const unseen = fixture(); unseen.targetReview.rows[0] = { name: 'child', objectCount: 0, objects: [] };
  assert.equal(compare(unseen).rows[0].status, 'notApplicable');
  const extra = fixture(); extra.creates[0].review.foreignKeys = [];
  assert.equal(compare(extra).rows[0].status, 'targetOnly');
  const view = fixture(); view.creates[0].review.foreignKeys = []; view.targetReview.rows[0].objects[0].type = 'view';
  assert.equal(compare(view).totals.targetOnly, 0);
  extra.creates = []; assert.equal(compare(extra).rows.length, 0); assert.ok(compare(extra).findings.some(item => item.code === 'FK_COMPARE_SOURCE_INCOMPLETE'));
  const ambiguous = fixture(); ambiguous.creates[0].review.foreignKeys[0].name = null;
  ambiguous.targetReview.targetForeignKeyReview.rows.push(target({ name: 'second' })); ambiguous.targetReview.targetForeignKeyReview.definitionCount = 2;
  const report = compare(ambiguous); assert.equal(report.rows[0].reason, 'FK_COMPARE_AMBIGUOUS'); assert.equal(report.totals.targetOnly, 0);
});

test('unknown, old, malformed or truncated target evidence cannot imply a match or extra constraint', () => {
  for (const change of [r => { r.version = 0; }, r => { r.complete = false; }, r => { r.truncated = true; }, r => { r.definitionCount = 2; },
    r => { r.rows[0].pairs[0].ordinal = 0; }, r => { r.rows[0].onDelete = null; }, r => { r.rows[0].status = 'unknown'; },
    r => { r.rows.push(target()); r.definitionCount = 2; }]) {
    const input = fixture(); change(input.targetReview.targetForeignKeyReview);
    const report = compare(input); assert.equal(report.rows[0].status, 'unknown'); assert.equal(report.totals.targetOnly, 0);
  }
  const old = fixture(); old.creates[0].review.version = 2;
  assert.equal(compare(old).rows.length, 0); assert.equal(compare(old).canExecute, false);
});

test('case policy and explicit schema mapping remain bounded and conservative', () => {
  const folded = fixture(); folded.targetReview.lowerCaseTableNames = 1; folded.targetReview.targetForeignKeyReview.rows[0].table = 'CHILD';
  folded.targetReview.targetForeignKeyReview.rows[0].referencedTable = 'PARENT';
  assert.equal(compare(folded).rows[0].status, 'matched');
  folded.targetReview.lowerCaseTableNames = 0; assert.equal(compare(folded).rows[0].status, 'notObserved');
  for (const change of [r => { r.targetReview.lowerCaseTableNames = null; }, r => { r.creates[0].schema = 'other'; },
    r => { r.creates[0].review.foreignKeys[0].referencedSchema = 'other'; }, r => { r.source.rows.push({ name: 'child' }); }]) {
    const input = fixture(); change(input); assert.equal(compare(input).rows[0].reason, 'FK_COMPARE_SCHEMA_OR_CASE_UNKNOWN');
  }
});

test('source and response quotas retain explicit limits without partial proof', () => {
  const input = fixture(); input.source.rows = []; input.creates = []; input.targetReview.targetForeignKeyReview.rows = []; input.targetReview.targetForeignKeyReview.definitionCount = 0;
  for (let i = 0; i < 40; i++) {
    const table = `t${i}`; input.source.rows.push({ name: table });
    input.targetReview.rows.push({ name: table, objectCount: 1, objects: [{ name: table, type: 'table' }] });
    input.creates.push({ table, schema: null, review: { version: 3, status: 'matched', foreignKeys: Array.from({ length: 64 }, (_, n) => fk({ name: `fk${n}` })) } });
  }
  const report = compare(input); assert.equal(report.sourceCount, 2000); assert.equal(report.rows.length, 200); assert.equal(report.truncated, true);
  assert.ok(report.findings.some(item => item.code === 'FK_COMPARE_LIMIT'));
  assert.equal(report.canExecute, false);
  const columns = Array.from({ length: 16 }, (_, i) => `c${i}`);
  for (const entry of input.creates) for (const key of entry.review.foreignKeys) { key.columns = columns; key.referencedColumns = columns; }
  const wide = compare(input);
  assert.equal(wide.pairs, 10000); assert.equal(wide.sourceCount, 625); assert.equal(wide.retainedPairs, 2000); assert.equal(wide.truncated, true);
});
