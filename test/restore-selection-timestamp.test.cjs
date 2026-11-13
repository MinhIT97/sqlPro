'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewTimestampColumn } = require('../electron/restore-selection-temporal.cjs');
const { projectValueColumns } = require('../electron/restore-selection-values.cjs');
const { normalizeColumnType } = require('../electron/restore-selection-columns.cjs');
const { RestoreSelectionInventory, previewRestoreSelection } = require('../electron/restore-selection.cjs');
const { assertStatementScope } = require('../electron/sql-script.cjs');
const { buildSelectionDraft } = require('../electron/restore-selection-plan.cjs');

const zoneGate = 'VALUE_TIMESTAMP_ZONE_RANGE_NOT_REVIEWED';
function fixture(values, sourceType = 'TIMESTAMP(6)', targetType = sourceType) {
  const collector = new RestoreSelectionInventory('demo');
  [`CREATE TABLE \`items\` (\`v\` ${sourceType} NULL) ENGINE=InnoDB`, ...values.map(value => `INSERT INTO items VALUES(${value})`)]
    .forEach((sql, i) => collector.add(sql, assertStatementScope(sql, 'demo'), i + 1));
  const inventory = collector.finish(), source = previewRestoreSelection(inventory, { tables: ['items'], includeStructure: false });
  const columns = structuredClone(source.rows[0].columnSchema.columns);
  Object.assign(columns[0], normalizeColumnType(targetType));
  const targetReview = { canExecute: false, snapshotId: 'a'.repeat(64), database: 'demo', lowerCaseTableNames: 0, findings: [],
    metadataStatus: { complete: true, databaseVisible: true }, rows: [{ name: 'items', objects: [{ name: 'items', type: 'table' }], objectCount: 1,
      columnReview: { findings: [], truncated: false }, valueColumns: projectValueColumns(columns, true) }] };
  return { inventory, targetReview, build: () => buildSelectionDraft({ inventory, source, targetReview, checksum: 'b'.repeat(64), targetIdentity: 'c'.repeat(64) }) };
}

test('TIMESTAMP reviews local calendar and clock risks but never certifies the zone or UTC range', () => {
  const input = fixture(["'2024-02-29 01:02:03.123456'", "'1900-02-29 01:02:03'", "'0000-00-00 00:00:00'",
    "'2024-02-29 24:00:00'", "'0999-01-01 00:00:00'", "'9999-12-31 23:59:59.999999'", 'NULL']);
  const report = input.build().valueReview;
  assert.deepEqual(report.rows.map(row => row.status), ['unknown', 'issues', 'issues', 'issues', 'unknown', 'unknown', 'basic-checked']);
  const expected = [null, 'VALUE_TEMPORAL_INVALID_CALENDAR', 'VALUE_TEMPORAL_ZERO_REQUIRES_POLICY', 'VALUE_TEMPORAL_INVALID_TIME',
    'VALUE_TEMPORAL_YEAR_NOT_REVIEWED', 'VALUE_TEMPORAL_UPPER_BOUNDARY_NOT_REVIEWED'];
  for (const [i, code] of expected.entries()) {
    for (const side of ['source', 'target']) {
      assert.ok(report.rows[i].fields[0][side].findings.includes(zoneGate));
      if (code) assert.ok(report.rows[i].fields[0][side].findings.includes(code));
    }
  }
  assert.deepEqual(report.rows[0].fields[0].source.findings, [zoneGate]);
  assert.equal(report.rows[0].fields[0].counts.temporalStrings, 1);
  assert.equal(JSON.stringify(report).includes('2024-02-29'), false);
});

test('TIMESTAMP precision loss blocks the draft independently on either side and trailing zeroes do not hide the zone gate', () => {
  const input = fixture(["'2024-02-29 01:02:03.123456'", "'2024-02-29 01:02:03.123000'"], 'TIMESTAMP(6)', 'TIMESTAMP(3)');
  const first = input.build();
  assert.deepEqual(first.valueReview.rows.map(row => row.status), ['issues', 'unknown']);
  assert.deepEqual(first.valueReview.rows[0].fields[0].target.findings, ['VALUE_TEMPORAL_PRECISION_LOSS', zoneGate]);
  assert.deepEqual(first.valueReview.rows[0].fields[0].source.findings, [zoneGate]);
  assert.equal(first.steps[1].reason, 'VALUE_BASIC_ISSUES');
  input.targetReview.rows[0].valueColumns.columns[0].type = 'timestamp(6)';
  const changed = input.build();
  assert.notEqual(first.planId, changed.planId); assert.equal(changed.valueReview.rows[0].status, 'unknown');
  const reversed = fixture(["'2024-02-29 01:02:03.123456'"], 'TIMESTAMP(3)', 'TIMESTAMP(6)').build();
  assert.equal(reversed.valueReview.rows[0].fields[0].source.status, 'issues');
  assert.equal(reversed.valueReview.rows[0].fields[0].target.status, 'unknown');
  assert.equal(first.version, 22); assert.equal(first.valueReview.version, 8); assert.equal(first.canExecute, false);
  assert.equal(Object.isFrozen(first.valueReview.rows[0].fields[0].target.findings), true);
});

test('TIMESTAMP conversion, DST, endpoints and server-specific ranges remain unknown without guessing the stored instant', () => {
  const values = ["'2024-02-29'", "'12:34:56'", '20240229010203', '0', 'TRUE', "'2024-03-10 02:30:00'",
    "'1970-01-01 00:00:00'", "'2038-01-19 03:14:07'", "'2106-02-07 06:28:15'", "'2024-02-29 01:02:03Z'"];
  const draft = fixture(values).build();
  assert.ok(draft.valueReview.rows.every(row => row.status === 'unknown'));
  assert.ok(draft.valueReview.rows.every(row => row.fields[0].target.findings.includes(zoneGate)));
  assert.equal(draft.canExecute, false);
  assert.ok(draft.blockers.some(item => item.code === 'SESSION_EXECUTION_NOT_IMPLEMENTED'));
  assert.ok(draft.blockers.some(item => item.code === 'OMITTED_DEFAULT_VALUES_NOT_VALIDATED'));
  for (const type of ['timestamp(7)', 'timestamp(30)', 'timestamp(3) unsigned']) assert.deepEqual(reviewTimestampColumn({}, type), ['VALUE_TEMPORAL_TYPE_NOT_REVIEWED']);
});

test('legacy temporal profiles can review only their recorded calendar facts; missing profiles never clear TIMESTAMP gates', () => {
  for (const version of [1, 2, 3, 4, 5, 6, 7]) {
    const input = fixture(["'2024-02-29 01:02:03.123456'"]);
    const evidence = input.inventory.statementLedger.entries[1].syntaxReview.valueReview;
    evidence.version = version;
    if (version < 7) delete evidence.fields[0].year;
    if (version < 6) delete evidence.fields[0].temporal.time;
    if (version < 5) delete evidence.fields[0].temporal;
    const side = input.build().valueReview.rows[0].fields[0].target;
    assert.equal(side.status, 'unknown'); assert.ok(side.findings.includes(zoneGate));
    assert.equal(side.findings.includes('VALUE_TEMPORAL_EVIDENCE_NOT_REVIEWED'), version < 5);
  }
  const input = fixture(['NULL']);
  input.targetReview.rows[0].valueColumns.columns[0].nullable = false;
  assert.deepEqual(input.build().valueReview.rows[0].fields[0].target.findings, ['VALUE_NULL_SPECIAL_SEMANTICS']);
});
