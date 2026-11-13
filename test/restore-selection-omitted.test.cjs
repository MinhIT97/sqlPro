'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewOmittedValues } = require('../electron/restore-selection-omitted.cjs');
const { projectValueColumns } = require('../electron/restore-selection-values.cjs');
const { RestoreSelectionInventory, previewRestoreSelection } = require('../electron/restore-selection.cjs');
const { assertStatementScope } = require('../electron/sql-script.cjs');
const { buildSelectionDraft } = require('../electron/restore-selection-plan.cjs');

function fixture(definition = '`id` INT, `required` INT NOT NULL', inserts = ['INSERT INTO items (`id`) VALUES(1)']) {
  const collector = new RestoreSelectionInventory('demo');
  [`CREATE TABLE \`items\` (${definition}) ENGINE=InnoDB`, ...inserts].forEach((sql, index) => collector.add(sql, assertStatementScope(sql, 'demo'), index + 1));
  const inventory = collector.finish(), source = previewRestoreSelection(inventory, { tables: ['items'], includeStructure: false });
  const columns = structuredClone(source.rows[0].columnSchema.columns);
  const targetReview = { canExecute: false, snapshotId: 'a'.repeat(64), database: 'demo', lowerCaseTableNames: 0, findings: [],
    metadataStatus: { complete: true, databaseVisible: true }, rows: [{ name: 'items', objects: [{ name: 'items', type: 'table' }], objectCount: 1,
      columnReview: { findings: [], truncated: false }, valueColumns: projectValueColumns(columns, true) }] };
  return { inventory, ledger: inventory.statementLedger, source, targetReview, policyReview: { rows: [{ name: 'items', disposition: 'review' }] } };
}
const review = input => reviewOmittedValues(input);
const targetColumns = input => input.targetReview.rows[0].valueColumns.columns;
const draft = input => buildSelectionDraft({ ...input, checksum: 'b'.repeat(64), targetIdentity: 'c'.repeat(64) });

test('missing required columns are checked per INSERT on both sides, with case-insensitive explicit mapping', () => {
  const input = fixture(undefined, ['INSERT INTO items (`ID`) VALUES(1)', 'INSERT INTO items (`id`,`required`) VALUES(2,3)']);
  const before = structuredClone(input), result = review(input);
  assert.equal(result.canExecute, false); assert.equal(result.totals.issues, 1); assert.equal(result.totals.checked, 1);
  for (const side of ['source', 'target']) {
    assert.equal(result.rows[0][side].columns[0].code, 'OMITTED_REQUIRED_COLUMN');
    assert.equal(result.rows[1][side].omittedCount, 0);
  }
  assert.deepEqual(input, before);
});

test('nullable implicit NULL is distinguished from unreviewed DEFAULT values without exposing defaults', () => {
  const input = fixture("`id` INT, `optional` INT NULL, `with_default` VARCHAR(20) DEFAULT 'private-default'");
  const result = review(input);
  for (const side of ['source', 'target']) {
    assert.deepEqual(result.rows[0][side].columns.map(column => column.code), ['OMITTED_IMPLICIT_NULL', 'OMITTED_DEFAULT_NOT_REVIEWED']);
    assert.equal(result.rows[0][side].status, 'unknown');
  }
  assert.equal(JSON.stringify(result).includes('private-default'), false);
  assert.equal(JSON.stringify(draft(input)).includes('private-default'), false);
  assert.ok(result.requires.includes('OMITTED_DEFAULT_VALUES_NOT_VALIDATED'));
});

test('auto-increment, generated, TIMESTAMP, unsupported attributes and missing default metadata stay unknown', () => {
  for (const [changes, code] of [
    [{ autoIncrement: true }, 'OMITTED_AUTO_INCREMENT_NOT_REVIEWED'],
    [{ generated: true }, 'OMITTED_GENERATED_NOT_REVIEWED'],
    [{ type: 'timestamp(6)' }, 'OMITTED_TIMESTAMP_NOT_REVIEWED'],
    [{ attributesKnown: false }, 'OMITTED_SEMANTICS_NOT_REVIEWED'],
    [{ typeKnown: false }, 'OMITTED_SEMANTICS_NOT_REVIEWED'],
    [{ hasDefault: null }, 'OMITTED_DEFAULT_METADATA_UNKNOWN'],
    [{ hasDefault: true }, 'OMITTED_DEFAULT_NOT_REVIEWED']
  ]) {
    const input = fixture(); Object.assign(targetColumns(input)[1], changes);
    const result = review(input).rows[0].target;
    assert.equal(result.status, 'unknown'); assert.equal(result.columns[0].code, code);
  }
});

test('positional INSERT omits invisible columns; missing positional fields or unknown explicit names do not infer omissions', () => {
  const input = fixture('`id` INT', ['INSERT INTO items VALUES(1)']);
  targetColumns(input).push({ ...targetColumns(input)[0], name: 'hidden', ordinal: 2, invisible: true, nullable: false, hasDefault: false });
  assert.equal(review(input).rows[0].target.columns[0].code, 'OMITTED_REQUIRED_COLUMN');
  targetColumns(input)[1].nullable = true;
  assert.equal(review(input).rows[0].target.columns[0].code, 'OMITTED_IMPLICIT_NULL');
  targetColumns(input)[1].invisible = false;
  assert.deepEqual(review(input).rows[0].target.findings, ['OMITTED_MAPPING_UNKNOWN']);
  const missing = fixture(undefined, ['INSERT INTO items (`missing`) VALUES(1)']);
  assert.deepEqual(review(missing).rows[0].source.findings, ['OMITTED_MAPPING_UNKNOWN']);
});

test('old projections, incomplete CREATE/metadata/evidence, schema mapping, skips and structure-only scopes remain explicit', () => {
  for (const change of [r => { r.targetReview.rows[0].valueColumns.version = 1; },
    r => { r.targetReview.rows[0].valueColumns.complete = false; }]) {
    const input = fixture(); change(input);
    assert.deepEqual(review(input).rows[0].target.findings, ['OMITTED_COLUMNS_NOT_REVIEWED']);
  }
  for (const change of [r => { r.ledger.entries[0].syntaxReview.version = 2; },
    r => { r.source.rows[0].columnSchema.complete = false; },
    r => { r.ledger.entries.push({ ...r.ledger.entries[0], number: 3 }); r.ledger.total++; },
    r => { r.ledger.entries[0].schema = 'elsewhere'; r.ledger.entries[0].syntaxReview.schema = 'elsewhere'; }]) {
    const input = fixture(); change(input);
    assert.deepEqual(review(input).rows[0].source.findings, ['OMITTED_COLUMNS_NOT_REVIEWED']);
  }
  const skipped = fixture(); skipped.policyReview.rows[0].disposition = 'skip';
  assert.equal(review(skipped).totals.excluded, 1);
  skipped.ledger.entries[1].schema = 'elsewhere'; skipped.ledger.entries[1].syntaxReview.schema = 'elsewhere';
  assert.equal(review(skipped).totals.excluded, 0);
  assert.ok(review(skipped).rows[0].reasons.includes('OMITTED_SCHEMA_MAPPING_REQUIRED'));
  skipped.source.includeData = false;
  assert.equal(review(skipped).totals.excluded, 1);
  const missing = fixture(); delete missing.ledger.entries[1].syntaxReview.valueReview;
  assert.deepEqual(review(missing).rows[0].reasons, ['OMITTED_INSERT_NOT_REVIEWED']);
  missing.ledger.truncated = true;
  assert.ok(review(missing).findings.includes('OMITTED_LEDGER_INCOMPLETE'));
});

test('draft binds/freezes omission observations and blocks known issues and omitted quota rows', () => {
  const input = fixture(), first = draft(input);
  assert.equal(first.version, 23); assert.equal(first.canExecute, false);
  assert.equal(first.steps[1].reason, 'OMITTED_REQUIRED_COLUMN');
  assert.equal(Object.isFrozen(first.omittedValueReview.rows[0].target.columns[0]), true);
  targetColumns(input)[1].hasDefault = true;
  assert.notEqual(draft(input).planId, first.planId);
  const wide = fixture(Array.from({ length: 101 }, (_, i) => `\`c${i}\` INT NOT NULL`).join(','), Array(8).fill('INSERT INTO items (`c0`) VALUES(1)'));
  const result = draft(wide);
  assert.equal(result.omittedValueReview.rows.length, 5);
  assert.equal(result.omittedValueReview.totals.issues, 8);
  assert.equal(result.omittedValueReview.truncated, true);
  assert.equal(result.steps[6].reason, 'OMITTED_REPORT_LIMIT');
  assert.equal(result.omittedValueReview.rows.reduce((sum, row) => sum + row.source.columns.length + row.target.columns.length, 0), 1000);
  const many = fixture('`id` INT', Array(110).fill('INSERT INTO items VALUES(1)'));
  assert.equal(review(many).rows.length, 100); assert.equal(review(many).totals.statements, 110);
  const analysis = fixture(Array.from({ length: 100 }, (_, i) => `\`c${i}\` INT`).join(','), Array(51).fill(`INSERT INTO items VALUES(${Array(100).fill('1').join(',')})`));
  assert.ok(review(analysis).findings.includes('OMITTED_ANALYSIS_LIMIT'));
});

test('value column projection retains only nullable default-presence metadata and discards arbitrary expressions', () => {
  const input = fixture(), column = targetColumns(input)[0];
  const result = projectValueColumns([{ ...column, defaultValue: 'private-expression', hasDefault: true }], true);
  assert.equal(result.version, 2); assert.equal(result.columns[0].hasDefault, true);
  assert.equal(JSON.stringify(result).includes('private-expression'), false);
  delete column.hasDefault;
  assert.equal(projectValueColumns([column], true).columns[0].hasDefault, null);
});
