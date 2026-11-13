'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewTemporalString, projectTemporal } = require('../electron/restore-selection-temporal.cjs');
const { reviewLiteralInsert } = require('../electron/restore-selection-syntax.cjs');
const { projectValueEvidence, projectValueColumns } = require('../electron/restore-selection-values.cjs');
const { RestoreSelectionInventory, previewRestoreSelection } = require('../electron/restore-selection.cjs');
const { assertStatementScope } = require('../electron/sql-script.cjs');
const { normalizeColumnType } = require('../electron/restore-selection-columns.cjs');
const { buildSelectionDraft } = require('../electron/restore-selection-plan.cjs');

function fixture(type, values, targetType = type) {
  const collector = new RestoreSelectionInventory('demo');
  [`CREATE TABLE \`items\` (\`value\` ${type}) ENGINE=InnoDB`, ...values.map(value => `INSERT INTO items VALUES(${value})`)]
    .forEach((sql, index) => collector.add(sql, assertStatementScope(sql, 'demo'), index + 1));
  const inventory = collector.finish(), source = previewRestoreSelection(inventory, { tables: ['items'], includeStructure: false });
  const columns = structuredClone(source.rows[0].columnSchema.columns);
  Object.assign(columns[0], normalizeColumnType(targetType));
  const targetReview = { canExecute: false, snapshotId: 'a'.repeat(64), database: 'demo', lowerCaseTableNames: 0, findings: [],
    metadataStatus: { complete: true, databaseVisible: true }, rows: [{ name: 'items', objects: [{ name: 'items', type: 'table' }], objectCount: 1,
      columnReview: { findings: [], truncated: false }, valueColumns: projectValueColumns(columns, true) }] };
  return { inventory, targetReview, build: () => buildSelectionDraft({ inventory, source, targetReview, checksum: 'b'.repeat(64), targetIdentity: 'c'.repeat(64) }) };
}

test('canonical calendar shape uses Gregorian leap years and retains no original date or components', () => {
  for (const value of ['1000-01-01', '2000-02-29', '2024-02-29', '9999-12-31']) {
    const shape = reviewTemporalString(value);
    assert.equal(shape.kind, 'date'); assert.equal(shape.problem, null);
    assert.equal(JSON.stringify(shape).includes(value), false);
    assert.equal(Object.hasOwn(shape, 'year'), false);
  }
  for (const value of ['1900-02-29', '2023-02-29', '2024-04-31', '2024-13-01', '2024-01-32']) assert.equal(reviewTemporalString(value).problem, 'calendar');
  for (const value of ['0000-00-00', '2024-00-01', '2024-01-00']) assert.equal(reviewTemporalString(value).problem, 'zero');
  assert.equal(reviewTemporalString('0999-01-01').problem, 'year');
  assert.equal(reviewTemporalString('2024-02-29 23:59:60').invalidTime, true);
  assert.equal(reviewTemporalString('2024-02-29 24:00:00').invalidTime, true);
  assert.equal(reviewTemporalString('2024-02-29 00:60:00').invalidTime, true);
  assert.equal(reviewTemporalString('2024-02-29 23:59:59.120000').scale, 2);
  assert.equal(reviewTemporalString('9999-12-31 23:59:59.999999').upperBoundary, true);
});

test('relaxed formats, timezone strings, trailing characters/line terminators, escape bodies and long values stay outside the grammar', () => {
  for (const value of [null, '', '24-02-29', '20240229', '2024/02/29', '2024-2-29', '2024-02-29T00:00:00',
    '2024-02-29 00:00', '2024-02-29 00:00:00.1234567', '2024-02-29 00:00:00Z', '2024-02-29 00:00:00+00:00',
    '２０２４-02-29', ' 2024-02-29', '2024-02-29 ', '2024-02-29\n', '2024-02-29\r', '2024-02-29\u2028', '2024-02-29\\n', 'x'.repeat(200000)]) {
    assert.equal(reviewTemporalString(value), null);
  }
});

test('DATE and DATETIME review identifies calendar/zero/time risks independently from unsupported conversions', () => {
  const dates = fixture('DATE', ["'2000-02-29'", "'1900-02-29'", "'0000-00-00'", "'0999-01-01'", "'20240229'", 'NULL']).build().valueReview;
  assert.deepEqual(dates.rows.map(row => row.status), ['basic-checked', 'issues', 'issues', 'unknown', 'unknown', 'basic-checked']);
  assert.ok(dates.rows[1].fields[0].target.findings.includes('VALUE_TEMPORAL_INVALID_CALENDAR'));
  assert.ok(dates.rows[2].fields[0].source.findings.includes('VALUE_TEMPORAL_ZERO_REQUIRES_POLICY'));
  assert.ok(dates.rows[3].fields[0].target.findings.includes('VALUE_TEMPORAL_YEAR_NOT_REVIEWED'));
  const times = fixture('DATETIME(6)', ["'2024-02-29 23:59:59.123456'", "'2024-02-29 24:00:00'", "'9999-12-31 23:59:59.999999'"]).build();
  assert.deepEqual(times.valueReview.rows.map(row => row.status), ['basic-checked', 'issues', 'unknown']);
  assert.equal(times.valueReview.rows[0].fields[0].counts.temporalStrings, 1);
  assert.ok(times.valueReview.rows[1].fields[0].target.findings.includes('VALUE_TEMPORAL_INVALID_TIME'));
  for (const [type, value] of [['DATE', "'2024-02-29 00:00:00'"], ['DATETIME', "'2024-02-29'"], ['TIMESTAMP', "'2024-02-29 00:00:00'"]]) {
    assert.equal(fixture(type, [value]).build().valueReview.rows[0].status, 'unknown');
  }
});

test('fraction loss is flagged without rounding; trailing zeroes do not require extra precision', () => {
  const result = fixture('DATETIME(6)', ["'2024-02-29 01:02:03.123400'", "'2024-02-29 01:02:03.123000'", "'2024-02-29 01:02:03.000000'"], 'DATETIME(3)').build();
  assert.deepEqual(result.valueReview.rows.map(row => row.fields[0].target.status), ['issues', 'basic-checked', 'basic-checked']);
  assert.equal(result.valueReview.rows[0].fields[0].source.status, 'basic-checked');
  assert.deepEqual(result.valueReview.rows[0].fields[0].target.findings, ['VALUE_TEMPORAL_PRECISION_LOSS']);
  assert.equal(result.steps[1].reason, 'VALUE_BASIC_ISSUES');
});

test('projection checks counts/disjoint profiles and strips private fields; old evidence cannot certify dates', () => {
  const syntax = reviewLiteralInsert("INSERT INTO items VALUES('2024-02-29'),('123'),('2024-02-29 01:02:03.12')", { collectValues: true });
  assert.equal(syntax.valueReview.version, 7);
  const field = syntax.valueReview.fields[0], temporal = field.temporal;
  assert.deepEqual(projectTemporal({ ...temporal, raw: 'private-date' }, field), temporal);
  for (const changes of [{ count: 4 }, { invalidDates: 2 }, { zeroComponents: 1, invalidDates: 1 }, { maxScale: 1 }, { invalidTimes: 1 }, { count: -1 }, { upperBoundary: 1 }]) {
    assert.equal(projectTemporal({ ...temporal, date: { ...temporal.date, ...changes } }, field), null);
  }
  assert.equal(projectTemporal(temporal, {}), null);
  assert.equal(projectTemporal(temporal, { text: { count: 3 }, numericStrings: { count: -1 } }), null);
  const malformed = structuredClone(syntax.valueReview); delete malformed.fields[0].temporal;
  assert.equal(projectValueEvidence(malformed, syntax), null);
  for (const version of [1, 2, 3, 4]) {
    const input = fixture('DATE', ["'2024-02-29'"]);
    input.inventory.statementLedger.entries[1].syntaxReview.valueReview.version = version;
    delete input.inventory.statementLedger.entries[1].syntaxReview.valueReview.fields[0].temporal;
    assert.equal(input.build().valueReview.rows[0].status, 'unknown');
    assert.ok(input.build().valueReview.rows[0].fields[0].target.findings.includes('VALUE_TEMPORAL_EVIDENCE_NOT_REVIEWED'));
  }
});

test('calendar report is bound/frozen with no raw dates/SQL and preserves execution/session/omission gates', () => {
  const input = fixture('DATETIME(6)', ["'2024-02-29 01:02:03.123456'"]), first = input.build();
  assert.equal(first.version, 22); assert.equal(first.valueReview.version, 8); assert.equal(first.canExecute, false);
  assert.equal(Object.isFrozen(first.valueReview.rows[0].fields[0].counts), true);
  assert.equal(JSON.stringify(first).includes('2024-02-29'), false);
  assert.ok(first.blockers.some(item => item.code === 'SESSION_EXECUTION_NOT_IMPLEMENTED'));
  assert.ok(first.blockers.some(item => item.code === 'OMITTED_DEFAULT_VALUES_NOT_VALIDATED'));
  input.targetReview.rows[0].valueColumns.columns[0].type = 'datetime(3)';
  const changed = input.build();
  assert.notEqual(first.planId, changed.planId); assert.equal(changed.steps[1].reason, 'VALUE_BASIC_ISSUES');
});

test('TIME distinguishes durations from clock times, supports negative/zero and checks the symmetric hour range', () => {
  for (const value of ['00:00:00', '-00:00:00', '24:01:02', '-123:45:56.120000', '838:59:59', '-838:59:59.000000']) {
    const shape = reviewTemporalString(value);
    assert.equal(shape.kind, 'time'); assert.equal(shape.problem, null); assert.equal(shape.invalidTime, false);
    assert.equal(JSON.stringify(shape).includes(value), false);
  }
  for (const value of ['839:00:00', '-839:00:00', '999:00:00', '12:60:00', '-12:34:60']) assert.equal(reviewTemporalString(value).invalidTime, true);
  for (const value of ['+12:34:56', '1:23:45', '12:34', '123456', '2 12:34:56', '12:34:56Z', '12:34:56\n', '12:34:56\r', '12:34:56.1234567', '1000:00:00']) assert.equal(reviewTemporalString(value), null);
  assert.equal(reviewTemporalString('-123:45:56.120000').scale, 2);
  assert.equal(reviewTemporalString('-838:59:59.000001').upperBoundary, true);
  const result = fixture('TIME(6)', ['838:59:59', '-838:59:59', '00:00:00', '-24:01:02.120000', '839:00:00', '12:60:00', '838:59:59.000001', '12:34'].map(value => `'${value}'`)).build();
  assert.deepEqual(result.valueReview.rows.map(row => row.status), ['basic-checked', 'basic-checked', 'basic-checked', 'basic-checked', 'issues', 'issues', 'unknown', 'unknown']);
  assert.equal(result.valueReview.rows[2].fields[0].source.findings.length, 0); // TIME zero is a valid duration.
  assert.equal(result.steps[5].reason, 'VALUE_BASIC_ISSUES');
});

test('TIME precision is checked independently at source and target without rounding, sign changes or timezone conversion', () => {
  const input = fixture('TIME(6)', ["'-123:45:56.123456'", "'123:45:56.120000'"], 'TIME(3)');
  const first = input.build();
  assert.deepEqual(first.valueReview.rows.map(row => row.fields[0].target.status), ['issues', 'basic-checked']);
  assert.equal(first.valueReview.rows[0].fields[0].source.status, 'basic-checked');
  assert.deepEqual(first.valueReview.rows[0].fields[0].target.findings, ['VALUE_TEMPORAL_PRECISION_LOSS']);
  assert.equal(first.valueReview.rows[0].fields[0].counts.temporalStrings, 1);
  input.targetReview.rows[0].valueColumns.columns[0].type = 'time(6)';
  assert.notEqual(input.build().planId, first.planId);
  assert.equal(input.build().valueReview.rows[0].status, 'basic-checked');
  assert.equal(first.canExecute, false); assert.equal(JSON.stringify(first).includes('123:45:56'), false);
});

test('v6 projection adds a disjoint TIME group; v5 keeps DATE/DATETIME compatibility and cannot certify TIME', () => {
  const syntax = reviewLiteralInsert("INSERT INTO items VALUES('12:34:56.12'),('2024-02-29'),('123')", { collectValues: true });
  const field = syntax.valueReview.fields[0];
  assert.equal(syntax.valueReview.version, 7); assert.equal(field.temporal.time.count, 1);
  assert.deepEqual(projectTemporal({ ...field.temporal, raw: 'private-time' }, field, 6), field.temporal);
  for (const change of [{ count: 2 }, { invalidDates: 1 }, { zeroComponents: 1 }, { unknownYears: 1 }, { maxScale: 7 }, { upperBoundary: 2 }]) {
    assert.equal(projectTemporal({ ...field.temporal, time: { ...field.temporal.time, ...change } }, field, 6), null);
  }
  const legacy = structuredClone(syntax.valueReview); legacy.version = 5; delete legacy.fields[0].temporal.time; delete legacy.fields[0].year;
  assert.deepEqual(projectValueEvidence(legacy, syntax), legacy);
  const time = fixture('TIME(6)', ["'12:34:56.12'"]);
  time.inventory.statementLedger.entries[1].syntaxReview.valueReview.version = 5;
  delete time.inventory.statementLedger.entries[1].syntaxReview.valueReview.fields[0].temporal.time;
  assert.ok(time.build().valueReview.rows[0].fields[0].target.findings.includes('VALUE_TEMPORAL_EVIDENCE_NOT_REVIEWED'));
  const date = fixture('DATE', ["'2024-02-29'"]);
  date.inventory.statementLedger.entries[1].syntaxReview.valueReview.version = 5;
  delete date.inventory.statementLedger.entries[1].syntaxReview.valueReview.fields[0].temporal.time;
  assert.equal(date.build().valueReview.rows[0].status, 'basic-checked');
});
