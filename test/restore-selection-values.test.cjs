'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewLiteralInsert } = require('../electron/restore-selection-syntax.cjs');
const { integerRangeMask, projectValueEvidence, projectValueColumns, reviewSelectionValues } = require('../electron/restore-selection-values.cjs');
const { RestoreSelectionInventory, previewRestoreSelection } = require('../electron/restore-selection.cjs');
const { assertStatementScope } = require('../electron/sql-script.cjs');
const { buildSelectionDraft } = require('../electron/restore-selection-plan.cjs');

function fixture(definition, inserts, targetTypes = null) {
  const collector = new RestoreSelectionInventory('demo');
  [`CREATE TABLE \`items\` (${definition}) ENGINE=InnoDB`, ...inserts].forEach((sql, index) => collector.add(sql, assertStatementScope(sql, 'demo'), index + 1));
  const inventory = collector.finish(), source = previewRestoreSelection(inventory, { tables: ['items'] });
  const columns = structuredClone(source.rows[0].columnSchema.columns);
  if (targetTypes) columns.forEach((column, index) => { column.type = targetTypes[index]; });
  const targetReview = { canExecute: false, snapshotId: 'a'.repeat(64), database: 'demo', lowerCaseTableNames: 0, findings: [],
    metadataStatus: { complete: true, databaseVisible: true }, rows: [{ name: 'items', objects: [{ name: 'items', type: 'table' }], objectCount: 1,
      columnReview: { findings: [], truncated: false }, valueColumns: projectValueColumns(columns, true) }] };
  return { inventory, ledger: inventory.statementLedger, source, targetReview,
    policyReview: { rows: [{ name: 'items', disposition: 'review' }] }, sessionPolicyReview: { observations: {}, findings: [] } };
}
const review = input => reviewSelectionValues(input);
const fields = input => review(input).rows[0].fields;

test('all ten signed/unsigned integer boundaries use exact arithmetic, ignoring display width and handling ZEROFILL', () => {
  for (const [index, bits] of [8, 16, 24, 32, 64].entries()) {
    const half = 1n << BigInt(bits - 1), full = half * 2n;
    const signed = value => Boolean(integerRangeMask(String(value < 0n ? -value : value), value < 0n) & (1 << (index * 2)));
    const unsigned = value => Boolean(integerRangeMask(String(value < 0n ? -value : value), value < 0n) & (1 << (index * 2 + 1)));
    assert.equal(signed(-half), true); assert.equal(signed(half - 1n), true);
    assert.equal(signed(-half - 1n), false); assert.equal(signed(half), false);
    assert.equal(unsigned(0n), true); assert.equal(unsigned(full - 1n), true);
    assert.equal(unsigned(-1n), false); assert.equal(unsigned(full), false);
  }
  assert.equal(integerRangeMask('0'.repeat(100000) + '1'), 1023); assert.equal(integerRangeMask('9'.repeat(100000)), 0);
  assert.equal(fields(fixture('`id` INT(1)', ['INSERT INTO items VALUES(1000)']))[0].source.status, 'basic-checked');
  assert.ok(fields(fixture('`id` INT', ['INSERT INTO items VALUES(-1)'], ['int zerofill']))[0].target.findings.includes('VALUE_INTEGER_OUT_OF_RANGE'));
});

test('lexer emits only bounded aggregate counts/masks, retaining no literal contents', () => {
  const result = reviewLiteralInsert("INSERT INTO items(`X`,`y`) VALUES(-128,'secret-value'),(+127,0xabcdef),(TRUE,1e2),(NULL,18446744073709551615)", { collectValues: true });
  assert.equal(result.status, 'matched'); assert.deepEqual(result.valueReview.columns, ['X', 'y']);
  assert.deepEqual(result.valueReview.fields.map(({ fitMask, fixedPoint, numericStrings, text, ...rest }) => rest), [{ nulls: 1, integers: 3, other: 0 }, { nulls: 0, integers: 1, other: 3 }]);
  const serialized = JSON.stringify(result);
  for (const value of ['secret-value', '18446744073709551615', 'abcdef', '-128', 'numericText']) assert.equal(serialized.includes(value), false);
  assert.deepEqual(projectValueEvidence({ ...result.valueReview, privateSql: 'secret' }, result), result.valueReview);
  const changed = structuredClone(result); changed.valueReview.fields[0].integers++;
  assert.equal(projectValueEvidence(changed.valueReview, changed), null);
  assert.equal(reviewLiteralInsert('INSERT INTO items VALUES(1)').valueReview, undefined);
});

test('source and target integer checks are independent and report NULL violations without claiming conversions', () => {
  const input = fixture('`id` BIGINT UNSIGNED NOT NULL, `n` INT NOT NULL', ['INSERT INTO items VALUES(18446744073709551615,NULL)'], ['tinyint', 'int']);
  const result = review(input);
  assert.equal(result.canExecute, false); assert.equal(result.rows[0].status, 'issues');
  assert.equal(result.rows[0].fields[0].source.status, 'basic-checked');
  assert.deepEqual(result.rows[0].fields[0].target.findings, ['VALUE_INTEGER_OUT_OF_RANGE']);
  assert.deepEqual(result.rows[0].fields[1].source.findings, ['VALUE_NULL_NOT_ALLOWED']);
  assert.equal(result.totals.issues, 1); assert.ok(result.requires.includes('VALUE_FULL_VALIDATION_REQUIRED'));
  const other = fixture('`id` INT', ["INSERT INTO items VALUES('123'),(1.0),(1e0),(X'01'),(B'1')"]);
  assert.equal(fields(other)[0].source.status, 'unknown'); assert.equal(fields(other)[0].counts.other, 5);
  const special = fixture('`id` INT NOT NULL AUTO_INCREMENT, PRIMARY KEY (`id`)', ['INSERT INTO items VALUES(NULL),(0)']);
  assert.equal(fields(special)[0].source.status, 'unknown');
  assert.ok(fields(special)[0].source.findings.includes('VALUE_NULL_SPECIAL_SEMANTICS'));
  special.targetReview.rows[0].valueColumns.columns[0].nullable = true;
  assert.equal(fields(special)[0].target.status, 'unknown');
});

test('explicit names and independent positional order map correctly, missing and invisible columns remain explicit', () => {
  const explicit = fixture('`a` TINYINT, `b` BIGINT', ['INSERT INTO items (`b`,`A`) VALUES(9999,1)']);
  assert.deepEqual(fields(explicit).map(field => field.sourceColumn), ['b', 'a']);
  const positional = fixture('`a` TINYINT, `b` BIGINT', ['INSERT INTO items VALUES(1,9999)']);
  const columns = positional.targetReview.rows[0].valueColumns.columns;
  [columns[0].name, columns[1].name] = [columns[1].name, columns[0].name];
  assert.deepEqual(fields(positional).map(field => field.targetColumn), ['b', 'a']);
  assert.equal(fields(positional)[1].target.status, 'basic-checked'); // range follows target position/type, not source column name
  columns[0].invisible = true;
  assert.ok(fields(positional).every(field => field.target.status === 'unknown'));
  explicit.ledger.entries[1].syntaxReview.valueReview.columns[0] = 'missing';
  assert.equal(fields(explicit)[0].source.status, 'unknown');
});

test('legacy/malformed evidence, schema mapping and incomplete columns never become checked', () => {
  for (const change of [r => { delete r.ledger.entries[1].syntaxReview.valueReview; },
    r => { r.ledger.entries[1].syntaxReview.valueReview.fields[0].fitMask = 1024; },
    r => { r.ledger.entries[1].syntaxReview.valueReview.rows = 9; },
    r => { r.ledger.entries[1].syntaxReview.valueReview.columns = ['id']; }]) {
    const input = fixture('`id` INT', ['INSERT INTO items VALUES(1)']); change(input);
    assert.equal(review(input).rows[0].status, 'unknown');
  }
  const input = fixture('`id` INT', ['INSERT INTO demo.items VALUES(1)']);
  input.targetReview.database = 'other'; input.policyReview.rows[0].disposition = 'skip';
  assert.equal(review(input).totals.excluded, 0); assert.ok(review(input).rows[0].reasons.includes('VALUE_SCHEMA_REQUIRES_MAPPING'));
  const old = fixture('`id` INT', ['INSERT INTO items VALUES(1)']);
  old.targetReview.rows[0].valueColumns.version = 0;
  old.ledger.entries[0].syntaxReview.version = 0;
  assert.ok(fields(old).every(field => field.source.status === 'unknown' && field.target.status === 'unknown'));
  for (const bad of [{ ordinal: 2 }, { nullable: null }, { name: '\0' }, { attributesKnown: null }]) {
    assert.equal(projectValueColumns([{ ...old.source.rows[0].columnSchema.columns[0], ...bad }], true).complete, false);
  }
});

test('skip and structure-only selections exclude value work; invalid ledger and session remain blocking', () => {
  const input = fixture('`id` INT NOT NULL', ['INSERT INTO items VALUES(NULL)']);
  input.policyReview.rows[0].disposition = 'skip'; assert.equal(review(input).totals.excluded, 1); assert.equal(review(input).rows.length, 0);
  input.policyReview.rows[0].disposition = 'review'; input.source.includeData = false;
  assert.equal(review(input).totals.excluded, 1);
  input.source.includeData = true; input.ledger.truncated = true; input.sessionPolicyReview.findings.push({ code: 'SESSION_STRICT_MODE_NOT_ENABLED' });
  assert.ok(review(input).findings.includes('VALUE_LEDGER_INCOMPLETE')); assert.ok(review(input).findings.includes('VALUE_SESSION_NOT_REVIEWED'));
});

test('collector and report quotas bound retained evidence and descriptions without weakening full validation gates', () => {
  const collector = new RestoreSelectionInventory('demo');
  const sql = `INSERT INTO items VALUES(${Array(256).fill('1').join(',')})`;
  for (let index = 0; index < 40; index++) collector.add(sql, assertStatementScope(sql, 'demo'), index + 1);
  assert.equal(collector.valueEvidenceFields, 9984);
  assert.equal(collector.finish().statementLedger.entries[39].syntaxReview.valueReview, undefined);
  const input = fixture('`id` INT', Array(110).fill('INSERT INTO items VALUES(1)'));
  const result = review(input); assert.equal(result.rows.length, 100); assert.equal(result.totals.statements, 110);
  assert.equal(result.truncated, true); assert.ok(result.findings.includes('VALUE_REPORT_LIMIT'));
  const wide = fixture(Array.from({ length: 100 }, (_, index) => `\`c${index}\` INT`).join(','),
    Array(11).fill(`INSERT INTO items VALUES(${Array(100).fill('1').join(',')})`));
  const bounded = review(wide);
  assert.equal(bounded.rows.reduce((sum, row) => sum + row.fields.length, 0), 1000);
  assert.equal(bounded.totals.statements, 11); assert.equal(bounded.truncated, true);
});

test('plan blocks known bad value statements, freezes reports and binds changes without retaining raw SQL', () => {
  const input = fixture('`id` BIGINT UNSIGNED', ['INSERT INTO items VALUES(18446744073709551615)'], ['tinyint']);
  input.source.includeStructure = false;
  const build = () => buildSelectionDraft({ ...input, checksum: 'b'.repeat(64), targetIdentity: 'c'.repeat(64) });
  const first = build(); assert.equal(first.version, 16); assert.equal(first.canExecute, false);
  assert.equal(first.steps[1].reason, 'VALUE_BASIC_ISSUES'); assert.equal(first.steps[1].decision, 'blocked');
  assert.equal(Object.isFrozen(first.valueReview.rows[0].fields[0].source), true);
  assert.equal(JSON.stringify(first).includes('18446744073709551615'), false);
  assert.ok(first.blockers.some(item => item.code === 'VALUE_FULL_VALIDATION_REQUIRED'));
  input.targetReview.rows[0].valueColumns.columns[0].type = 'bigint unsigned';
  const changed = build(); assert.notEqual(first.planId, changed.planId); assert.equal(changed.steps[1].decision, 'candidate');
  assert.equal(changed.canExecute, false);
});
