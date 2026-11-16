'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewYearDigits, projectYear } = require('../electron/restore-selection-year.cjs');
const { reviewLiteralInsert } = require('../electron/restore-selection-syntax.cjs');
const { projectValueColumns, projectValueEvidence } = require('../electron/restore-selection-values.cjs');
const { RestoreSelectionInventory, previewRestoreSelection } = require('../electron/restore-selection.cjs');
const { assertStatementScope } = require('../electron/sql-script.cjs');
const { buildSelectionDraft } = require('../electron/restore-selection-plan.cjs');

function fixture(values, type = 'YEAR', targetType = 'year') {
  const collector = new RestoreSelectionInventory('demo');
  [`CREATE TABLE \`items\` (\`v\` ${type}) ENGINE=InnoDB`, ...values.map(value => `INSERT INTO items VALUES(${value})`)]
    .forEach((sql, i) => collector.add(sql, assertStatementScope(sql, 'demo'), i + 1));
  const inventory = collector.finish(), source = previewRestoreSelection(inventory, { tables: ['items'], includeStructure: false });
  const columns = structuredClone(source.rows[0].columnSchema.columns); columns[0].type = targetType;
  const targetReview = { canExecute: false, snapshotId: 'a'.repeat(64), database: 'demo', lowerCaseTableNames: 0, findings: [],
    metadataStatus: { complete: true, databaseVisible: true }, rows: [{ name: 'items', objects: [{ name: 'items', type: 'table' }], objectCount: 1,
      columnReview: { findings: [], truncated: false }, valueColumns: projectValueColumns(columns, true) }] };
  return { inventory, targetReview, build: () => buildSelectionDraft({ inventory, source, targetReview, checksum: 'b'.repeat(64), targetIdentity: 'c'.repeat(64) }) };
}

test('YEAR recognizes exact four-digit bounds, separates numeric zero from quoted zero, and never infers a century', () => {
  for (const value of ['1901', '2000', '2155']) for (const quoted of [false, true]) assert.equal(reviewYearDigits(value, quoted), 'valid');
  for (const value of ['1000', '1900', '2156', '9999']) for (const quoted of [false, true]) assert.equal(reviewYearDigits(value, quoted), 'outOfRange');
  assert.equal(reviewYearDigits('0'), 'zero'); assert.equal(reviewYearDigits('0', true), 'conversion');
  for (const value of ['00', '0000', '0001', '1', '69', '70', '99', '100']) for (const quoted of [false, true]) assert.equal(reviewYearDigits(value, quoted), 'conversion');
  for (const value of [null, true, '', '+1901', '-1901', '1901.0', '1.901e3', ' 1901', '1901\n', '1901\r', '１９０１', '1901suffix', '1'.repeat(100000)]) assert.equal(reviewYearDigits(value), null);
});

test('source and target YEAR bounds are reviewed without accepting conversions or changing NULL handling', () => {
  const input = fixture(['0', '1901', "'2155'", '1900', "'2156'", "'0'", "'0000'", '99', '+2000', '-1', '2000.0', 'TRUE', 'NULL']);
  const report = input.build().valueReview;
  assert.deepEqual(report.rows.map(row => row.status), ['basic-checked', 'basic-checked', 'basic-checked', 'issues', 'issues', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'basic-checked']);
  assert.deepEqual(report.rows[3].fields[0].target.findings, ['VALUE_YEAR_OUT_OF_RANGE']);
  assert.deepEqual(report.rows[5].fields[0].target.findings, ['VALUE_YEAR_CONVERSION_NOT_REVIEWED']);
  assert.equal(report.rows[0].fields[0].counts.yearLiterals, 1);
  const narrow = fixture(['1900'], 'INT');
  assert.equal(narrow.build().valueReview.rows[0].fields[0].source.status, 'basic-checked');
  assert.equal(narrow.build().valueReview.rows[0].fields[0].target.status, 'issues');
  assert.equal(fixture(['2000'], 'YEAR', 'year(2)').build().valueReview.rows[0].fields[0].target.status, 'unknown');
  assert.equal(fixture(['2000'], 'YEAR', 'year(4)').build().valueReview.rows[0].fields[0].target.status, 'basic-checked');
});

test('profiles are counted separately for raw integers and numeric strings, bounded and projected without private values', () => {
  const syntax = reviewLiteralInsert("INSERT INTO items VALUES(0),(2000),('1901'),('99'),(1900)", { collectValues: true });
  const field = syntax.valueReview.fields[0];
  assert.equal(syntax.valueReview.version, 7);
  assert.deepEqual(field.year.raw, { count: 3, valid: 1, zero: 1, outOfRange: 1, conversion: 0 });
  assert.deepEqual(field.year.quoted, { count: 2, valid: 1, zero: 0, outOfRange: 0, conversion: 1 });
  assert.deepEqual(projectYear({ ...field.year, rawValue: 'private-year' }, field), field.year);
  for (const changes of [{ count: 4 }, { valid: -1 }, { zero: 10001 }, { conversion: 1 }]) assert.equal(projectYear({ ...field.year, raw: { ...field.year.raw, ...changes } }, field), null);
  assert.equal(projectYear(field.year, { ...field, integers: 2 }), null);
  assert.equal(projectYear(field.year, { ...field, numericStrings: { integers: 1 } }), null);
  const bad = structuredClone(field.year); bad.quoted.valid--; bad.quoted.zero++;
  assert.equal(projectYear(bad, field), null);
  const missing = structuredClone(syntax.valueReview); delete missing.fields[0].year;
  assert.equal(projectValueEvidence(missing, syntax), null);
  for (const version of [1, 2, 3, 4, 5, 6]) {
    const old = fixture(['2000']); old.inventory.statementLedger.entries[1].syntaxReview.valueReview.version = version;
    delete old.inventory.statementLedger.entries[1].syntaxReview.valueReview.fields[0].year;
    assert.deepEqual(old.build().valueReview.rows[0].fields[0].source.findings, ['VALUE_YEAR_EVIDENCE_NOT_REVIEWED']);
  }
});

test('known YEAR issues block the draft, binding and freeze include the report with no original value or execution authority', () => {
  const input = fixture(['2156']), first = input.build();
  assert.equal(first.version, 29); assert.equal(first.canExecute, false); assert.equal(first.valueReview.version, 8);
  assert.equal(first.steps[1].reason, 'VALUE_BASIC_ISSUES');
  assert.equal(Object.isFrozen(first.valueReview.rows[0].fields[0].target), true);
  assert.equal(JSON.stringify(first).includes('2156'), false);
  input.targetReview.rows[0].valueColumns.columns[0].type = 'int';
  assert.notEqual(first.planId, input.build().planId);
  assert.ok(first.blockers.some(item => item.code === 'VALUE_FULL_VALIDATION_REQUIRED'));
  assert.ok(first.blockers.some(item => item.code === 'OMITTED_DEFAULT_VALUES_NOT_VALIDATED'));
});
