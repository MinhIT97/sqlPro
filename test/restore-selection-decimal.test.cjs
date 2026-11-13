'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixedPointShape, emptyFixedPoint, addFixedPoint, projectFixedPoint, decimalType } = require('../electron/restore-selection-decimal.cjs');
const { reviewLiteralInsert } = require('../electron/restore-selection-syntax.cjs');
const { projectValueEvidence, projectValueColumns } = require('../electron/restore-selection-values.cjs');
const { RestoreSelectionInventory, previewRestoreSelection } = require('../electron/restore-selection.cjs');
const { assertStatementScope } = require('../electron/sql-script.cjs');
const { buildSelectionDraft } = require('../electron/restore-selection-plan.cjs');
const { normalizeColumnType } = require('../electron/restore-selection-columns.cjs');

function fixture(type, values, targetType = type) {
  const collector = new RestoreSelectionInventory('demo');
  const sql = [`CREATE TABLE \`items\` (\`value\` ${type}) ENGINE=InnoDB`, ...values.map(value => `INSERT INTO items VALUES(${value})`)];
  sql.forEach((statement, index) => collector.add(statement, assertStatementScope(statement, 'demo'), index + 1));
  const inventory = collector.finish(), source = previewRestoreSelection(inventory, { tables: ['items'], includeStructure: false });
  const columns = structuredClone(source.rows[0].columnSchema.columns); Object.assign(columns[0], normalizeColumnType(targetType));
  const targetReview = { canExecute: false, snapshotId: 'a'.repeat(64), database: 'demo', lowerCaseTableNames: 0, findings: [],
    metadataStatus: { complete: true, databaseVisible: true }, rows: [{ name: 'items', objects: [{ name: 'items', type: 'table' }], objectCount: 1,
      columnReview: { findings: [], truncated: false }, valueColumns: projectValueColumns(columns, true) }] };
  const build = () => buildSelectionDraft({ inventory, source, targetReview, checksum: 'b'.repeat(64), targetIdentity: 'c'.repeat(64) });
  return { inventory, source, targetReview, build };
}

test('fixed-point shapes preserve exact digit requirements, zero and trailing zeros without retaining digits', () => {
  assert.deepEqual(fixedPointShape('000123.45000', true), { integerDigits: 3, scale: 2, literalDigits: 8, negative: true });
  assert.deepEqual(fixedPointShape('.0001'), { integerDigits: 0, scale: 4, literalDigits: 4, negative: false });
  assert.deepEqual(fixedPointShape('0000.0000', true), { integerDigits: 0, scale: 0, literalDigits: 4, negative: false });
  assert.equal(fixedPointShape('0'.repeat(100000) + '1').integerDigits, 1);
  assert.equal(fixedPointShape('9'.repeat(100000)).integerDigits, 66);
  assert.equal(fixedPointShape('0.' + '0'.repeat(100000) + '1').scale, 31);
  for (const raw of ['1e2', '1E-2', '+1', '-1', '1.', "'1.23'", 'NaN', '', null]) assert.equal(fixedPointShape(raw), null);
  const summary = emptyFixedPoint(); addFixedPoint(summary, fixedPointShape('123')); addFixedPoint(summary, fixedPointShape('.0001', true));
  assert.deepEqual(summary, { count: 2, integerDigits: 3, scale: 4, literalDigits: 4, negativeCount: 1 });
});

test('DECIMAL and NUMERIC defaults, common precision/scale limits and unsigned flags are explicit', () => {
  assert.deepEqual(decimalType('decimal'), { precision: 10, scale: 0, unsigned: false });
  assert.deepEqual(decimalType('numeric(20)'), { precision: 20, scale: 0, unsigned: false });
  assert.deepEqual(decimalType('decimal(65,30) unsigned zerofill'), { precision: 65, scale: 30, unsigned: true });
  for (const type of ['decimal(0,0)', 'decimal(66,0)', 'decimal(5,6)', 'decimal(40,31)', 'decimal(65,38)', 'decimal(5,2);sql', 'float', 'decimal(-1)']) assert.equal(decimalType(type), null);
});

test('value evidence projects bounded fixed-point aggregates and rejects inconsistent/forged stats; v1 remains explicit', () => {
  const syntax = reviewLiteralInsert("INSERT INTO items VALUES(123.4500),(-0.001),(TRUE),(NULL),(1e2),('private-value')", { collectValues: true });
  const evidence = syntax.valueReview; assert.equal(evidence.version, 7);
  assert.deepEqual(evidence.fields[0].fixedPoint, { count: 3, integerDigits: 3, scale: 3, literalDigits: 7, negativeCount: 1 });
  assert.deepEqual(projectValueEvidence({ ...evidence, rawSql: 'private-sql' }, syntax), evidence);
  assert.equal(JSON.stringify(evidence).includes('private-'), false); assert.equal(JSON.stringify(evidence).includes('123.45'), false);
  const field = evidence.fields[0];
  for (const changes of [{ count: 0 }, { count: 99 }, { integerDigits: 67 }, { scale: 32 }, { negativeCount: 4 }, { literalDigits: 0 }]) assert.equal(projectFixedPoint({ ...field.fixedPoint, ...changes }, field), null);
  const legacy = structuredClone(evidence); legacy.version = 1; delete legacy.fields[0].fixedPoint; delete legacy.fields[0].numericStrings; delete legacy.fields[0].text; delete legacy.fields[0].temporal; delete legacy.fields[0].year;
  assert.deepEqual(projectValueEvidence(legacy, syntax), legacy);
  const invalid = structuredClone(evidence); delete invalid.fields[0].fixedPoint;
  assert.equal(projectValueEvidence(invalid, syntax), null);
  const integer = reviewLiteralInsert('INSERT INTO items VALUES(1)', { collectValues: true });
  integer.valueReview.fields[0].fixedPoint.scale = 1;
  assert.equal(projectValueEvidence(integer.valueReview, integer), null);
});

test('decimal endpoints and exact zero fit, excess integer digits and negative unsigned remain issues', () => {
  const values = ['999.99', '-999.99', '1000', '-1000', '.01', '-0.00', '1.2300', '0'];
  const result = fixture('DECIMAL(5,2)', values).build();
  assert.equal(result.version, 23); assert.equal(result.valueReview.version, 8); assert.equal(result.canExecute, false);
  assert.deepEqual(result.valueReview.rows.map(row => row.status), ['basic-checked', 'basic-checked', 'issues', 'issues', 'basic-checked', 'basic-checked', 'basic-checked', 'basic-checked']);
  assert.ok(result.valueReview.rows[2].fields[0].target.findings.includes('VALUE_DECIMAL_OUT_OF_RANGE'));
  const unsigned = fixture('DECIMAL(5,2)', ['-0.00', '-0.01'], 'decimal(5,2) unsigned').build();
  assert.deepEqual(unsigned.valueReview.rows.map(row => row.status), ['basic-checked', 'issues']);
  assert.ok(unsigned.valueReview.rows[1].fields[0].target.findings.includes('VALUE_DECIMAL_UNSIGNED_NEGATIVE'));
  const subunit = fixture('DECIMAL(2,2)', ['.99', '1', '0.00']).build();
  assert.deepEqual(subunit.valueReview.rows.map(row => row.status), ['basic-checked', 'issues', 'basic-checked']);
});

test('scale loss is a stop condition including round-up overflow; approximate/quoted numbers and old evidence stay unknown', () => {
  const input = fixture('DECIMAL(10,4)', ['1.234', '999.999', '1e0', "'1.23'", "X'01'"], 'decimal(5,2)');
  const result = input.build();
  assert.deepEqual(result.valueReview.rows.map(row => row.status), ['issues', 'issues', 'unknown', 'basic-checked', 'unknown']);
  assert.ok(result.valueReview.rows[0].fields[0].target.findings.includes('VALUE_DECIMAL_SCALE_LOSS'));
  assert.equal(result.steps[1].decision, 'blocked'); assert.equal(result.steps[2].decision, 'blocked');
  const old = fixture('DECIMAL(5,2)', ['12']);
  old.inventory.statementLedger.entries[1].syntaxReview.valueReview.version = 1;
  delete old.inventory.statementLedger.entries[1].syntaxReview.valueReview.fields[0].fixedPoint;
  assert.ok(old.build().valueReview.rows[0].fields[0].target.findings.includes('VALUE_DECIMAL_EVIDENCE_NOT_REVIEWED'));
  assert.equal(fixture('DECIMAL(5,2)', ['1'], 'decimal(65,38)').build().valueReview.rows[0].status, 'unknown');
});

test('65-digit values stay exact, literal precision saturation stays unknown and reports are immutable/bound', () => {
  const exact = '9'.repeat(35) + '.' + '9'.repeat(30);
  const input = fixture('DECIMAL(65,30)', [exact]);
  const initial = input.build(); assert.equal(initial.valueReview.rows[0].status, 'basic-checked');
  assert.equal(JSON.stringify(initial).includes(exact), false); assert.equal(Object.isFrozen(initial.valueReview.rows[0].fields[0]), true);
  assert.ok(initial.blockers.some(item => item.code === 'VALUE_FULL_VALIDATION_REQUIRED'));
  input.targetReview.rows[0].valueColumns.columns[0].type = 'decimal(64,30)';
  const changed = input.build(); assert.notEqual(initial.planId, changed.planId); assert.equal(changed.valueReview.rows[0].status, 'issues');
  const long = fixture('DECIMAL(5,2)', ['1.' + '0'.repeat(100)]).build();
  assert.equal(long.valueReview.rows[0].status, 'unknown');
  assert.ok(long.valueReview.rows[0].fields[0].target.findings.includes('VALUE_NUMERIC_LITERAL_PRECISION_NOT_REVIEWED'));
});
