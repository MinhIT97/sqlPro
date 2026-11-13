'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewNumericString, projectNumericStrings } = require('../electron/restore-selection-numeric-strings.cjs');
const { reviewLiteralInsert } = require('../electron/restore-selection-syntax.cjs');
const { projectValueEvidence, projectValueColumns } = require('../electron/restore-selection-values.cjs');
const { RestoreSelectionInventory, previewRestoreSelection } = require('../electron/restore-selection.cjs');
const { assertStatementScope } = require('../electron/sql-script.cjs');
const { buildSelectionDraft } = require('../electron/restore-selection-plan.cjs');
const { normalizeColumnType } = require('../electron/restore-selection-columns.cjs');

function fixture(type, values, targetType = type) {
  const collector = new RestoreSelectionInventory('demo');
  [`CREATE TABLE \`items\` (\`value\` ${type}) ENGINE=InnoDB`, ...values.map(value => `INSERT INTO items VALUES${(Array.isArray(value) ? value : [value]).map(item => `(${item})`).join(',')}`)]
    .forEach((sql, index) => collector.add(sql, assertStatementScope(sql, 'demo'), index + 1));
  const inventory = collector.finish(), source = previewRestoreSelection(inventory, { tables: ['items'], includeStructure: false });
  const columns = structuredClone(source.rows[0].columnSchema.columns); Object.assign(columns[0], normalizeColumnType(targetType));
  const targetReview = { canExecute: false, snapshotId: 'a'.repeat(64), database: 'demo', lowerCaseTableNames: 0, findings: [],
    metadataStatus: { complete: true, databaseVisible: true }, rows: [{ name: 'items', objects: [{ name: 'items', type: 'table' }], objectCount: 1,
      columnReview: { findings: [], truncated: false }, valueColumns: projectValueColumns(columns, true) }] };
  const build = () => buildSelectionDraft({ inventory, source, targetReview, checksum: 'b'.repeat(64), targetIdentity: 'c'.repeat(64) });
  return { inventory, targetReview, build };
}

test('strict numeric strings recognize complete ASCII values, signs and zeroes without returning digits', () => {
  for (const value of ['0', '-0', '+1', '-0012', '.25', '+.25', '-0.0000', '123.45000', '18446744073709551615']) assert.ok(reviewNumericString(value), value);
  for (const value of ['', ' ', ' 1', '1 ', '\n1', '1\n', '1\r', '1\r\n', '1\u2028', '1\u2029', '1\t', '1e2', '1E-2', '1,23', '1_000', 'NaN', 'Infinity', '0xFF', 'NULL', 'true', '١٢', '１２', '1.', '1abc', '--1', '+-1', '1\0', '9'.repeat(257), null]) assert.equal(reviewNumericString(value), null);
  assert.ok(reviewNumericString('0'.repeat(255) + '1'));
  assert.equal(reviewNumericString('9'.repeat(256)).shape.integerDigits, 66);
  assert.equal(JSON.stringify(reviewNumericString('987654321.123456789')).includes('987654321'), false);
});

test('lexer profiles only unescaped single-quoted numeric strings, keeps ordinary strings and nonstrings separate', () => {
  const sql = "INSERT INTO items VALUES('123'),('-0.2500'),(''),('private-value'),('1''2'),(X'1234'),(B'101'),(0x12),(1.23),(1e2),(NULL)";
  const syntax = reviewLiteralInsert(sql, { collectValues: true }), field = syntax.valueReview.fields[0];
  assert.equal(syntax.valueReview.version, 4); assert.equal(field.numericStrings.count, 2); assert.equal(field.numericStrings.integers, 1);
  assert.equal(field.fixedPoint.count, 1); assert.equal(field.numericStrings.fixedPoint.count, 2);
  assert.equal(field.numericStrings.fixedPoint.scale, 2); assert.equal(field.numericStrings.fixedPoint.negativeCount, 1);
  assert.equal(JSON.stringify(syntax).includes('private-value'), false); assert.equal(JSON.stringify(syntax).includes('-0.2500'), false);
  assert.deepEqual(projectValueEvidence({ ...syntax.valueReview, privateSql: sql }, syntax), syntax.valueReview);
  assert.equal(reviewLiteralInsert("INSERT INTO items VALUES('1\\n')", { collectValues: true }).status, 'unsupported');
  assert.equal(reviewLiteralInsert('INSERT INTO items VALUES("123")', { collectValues: true }).status, 'unsupported');
  const long = reviewLiteralInsert(`INSERT INTO items VALUES('${'0'.repeat(100000)}1')`, { collectValues: true });
  assert.equal(long.status, 'matched'); assert.equal(long.valueReview.fields[0].numericStrings.count, 0);
});

test('integer strings use exact BIGINT bounds and remain distinct from decimal strings and textual columns', () => {
  const input = fixture('BIGINT UNSIGNED', ["'18446744073709551615'", "'18446744073709551616'", "'-1'", "'+0001'", "'1.0'", "'1e0'" ]);
  const result = input.build();
  assert.deepEqual(result.valueReview.rows.map(row => row.status), ['basic-checked', 'issues', 'issues', 'basic-checked', 'unknown', 'unknown']);
  assert.equal(result.valueReview.rows[0].fields[0].counts.numericStrings, 1);
  assert.equal(result.valueReview.rows[0].fields[0].counts.integers, 0); // quoted values stay in the literal-other count
  assert.equal(fixture('VARCHAR(100)', ["'123'"]).build().valueReview.rows[0].status, 'unknown');
  const auto = fixture('INT', ["'0'"], 'int'); auto.targetReview.rows[0].valueColumns.columns[0].autoIncrement = true;
  assert.ok(auto.build().valueReview.rows[0].fields[0].target.findings.includes('VALUE_AUTO_INCREMENT_NOT_REVIEWED'));
});

test('decimal string profiles combine with numeric literals and report bounds/unsigned/scale loss independently', () => {
  const input = fixture('DECIMAL(10,4)', ["'1.2300'", "'1.234'", "'-0.01'", "'1000'", "'0.00'", "'-0.0000'", "' 1.2'"], 'decimal(5,2) unsigned');
  const result = input.build();
  assert.deepEqual(result.valueReview.rows.map(row => row.status), ['basic-checked', 'issues', 'issues', 'issues', 'basic-checked', 'basic-checked', 'unknown']);
  assert.ok(result.valueReview.rows[1].fields[0].target.findings.includes('VALUE_DECIMAL_SCALE_LOSS'));
  const sql = "INSERT INTO items VALUES(1),('2.50'),(3.75),('4'),('private')";
  const collector = new RestoreSelectionInventory('demo');
  ['CREATE TABLE items(value DECIMAL(5,2)) ENGINE=InnoDB', sql].forEach((text, index) => collector.add(text, assertStatementScope(text, 'demo'), index + 1));
  const fields = collector.finish().statementLedger.entries[1].syntaxReview.valueReview.fields;
  assert.equal(fields[0].fixedPoint.count, 2); assert.equal(fields[0].numericStrings.fixedPoint.count, 2);
  const mixed = fixture('DECIMAL(5,2)', [['1', "'2.50'", '3.75', "'4'", "'private'"]]).build();
  assert.equal(mixed.valueReview.rows[0].status, 'unknown');
  const numeric = fixture('DECIMAL(5,2)', [['1', "'2.50'", '3.75', "'4'"]]).build();
  assert.equal(numeric.valueReview.rows[0].status, 'basic-checked');
  const large = '9'.repeat(35) + '.' + '9'.repeat(30);
  const exact = fixture('DECIMAL(65,30)', [`'${large}'`]).build();
  assert.equal(exact.valueReview.rows[0].status, 'basic-checked'); assert.equal(JSON.stringify(exact).includes(large), false);
});

test('numeric-string projection rejects overlap, invalid counts/masks/missing profile and strips private properties', () => {
  const syntax = reviewLiteralInsert("INSERT INTO items VALUES('123'),(1.25)", { collectValues: true }), field = syntax.valueReview.fields[0];
  const profile = field.numericStrings;
  for (const changes of [{ count: -1 }, { count: 2 }, { integers: 2 }, { fitMask: 1024 }, { fixedPoint: null },
    { fixedPoint: { ...profile.fixedPoint, count: 2 } }]) assert.equal(projectNumericStrings({ ...profile, ...changes }, field, field.fixedPoint), null);
  const invalid = structuredClone(syntax.valueReview); delete invalid.fields[0].numericStrings;
  assert.equal(projectValueEvidence(invalid, syntax), null);
  const privateProfile = { ...profile, raw: 'private-value' };
  assert.deepEqual(projectNumericStrings(privateProfile, field, field.fixedPoint), profile);
  const v2 = structuredClone(syntax.valueReview); v2.version = 2; delete v2.fields[0].numericStrings; delete v2.fields[0].text;
  assert.deepEqual(projectValueEvidence(v2, syntax), v2);
});

test('older evidence cannot certify quoted numbers; checked numeric strings keep all write gates and immutable bindings', () => {
  const input = fixture('DECIMAL(5,2)', ["'999.99'"]);
  const initial = input.build(); assert.equal(initial.version, 16); assert.equal(initial.valueReview.version, 4);
  assert.equal(initial.valueReview.rows[0].status, 'basic-checked'); assert.equal(initial.canExecute, false);
  assert.ok(initial.blockers.some(item => item.code === 'VALUE_FULL_VALIDATION_REQUIRED'));
  assert.equal(Object.isFrozen(initial.valueReview.rows[0].fields[0].counts), true);
  const evidence = input.inventory.statementLedger.entries[1].syntaxReview.valueReview;
  evidence.version = 2; delete evidence.fields[0].numericStrings;
  const old = input.build(); assert.equal(old.valueReview.rows[0].status, 'unknown'); assert.notEqual(old.planId, initial.planId);
  evidence.version = 1; delete evidence.fields[0].fixedPoint;
  assert.equal(input.build().valueReview.rows[0].status, 'unknown');
});
