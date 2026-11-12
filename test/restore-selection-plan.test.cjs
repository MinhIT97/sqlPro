'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RestoreSelectionInventory, previewRestoreSelection } = require('../electron/restore-selection.cjs');
const { SqlScriptParser, assertStatementScope, skipReason } = require('../electron/sql-script.cjs');
const { buildSelectionDraft } = require('../electron/restore-selection-plan.cjs');
const { buildSelectionTargetPreview } = require('../electron/restore-selection-target.cjs');

function inventory(sql) {
  const collector = new RestoreSelectionInventory('demo'), parser = new SqlScriptParser();
  for (const [index, statement] of [...parser.push(sql), ...parser.end()].entries()) {
    const reason = skipReason(statement);
    if (reason) collector.recordSkipped(index + 1, reason);
    else collector.add(statement, assertStatementScope(statement, 'demo', index + 1), index + 1);
  }
  return collector.finish();
}
function draft(data, options = {}, overrides = {}) {
  const source = previewRestoreSelection(data, { tables: ['items'], ...options });
  const checksum = 'a'.repeat(64), targetIdentity = 'b'.repeat(64);
  const facts = { database: 'demo', checkedAt: '2026-11-12T12:00:00Z', version: '8.4', lowerCaseTableNames: 0,
    databaseVisible: true, objects: [], triggers: [], foreignKeys: [], columns: [], errors: [], truncated: [] };
  const targetReview = buildSelectionTargetPreview({ source, checksum, targetIdentity, facts });
  return buildSelectionDraft({ inventory: data, source, checksum, targetIdentity, targetReview, ...overrides });
}
const sql = "USE demo; CREATE TABLE items(id int); CREATE TABLE other(id int); INSERT INTO items VALUES(1); INSERT INTO other VALUES(2); DROP TABLE items; SET @saved=1; SELECT 1;";

test('draft attributes bounded statements in source order, marks DROP/context/unknown and preserves all gates', () => {
  const data = inventory(sql), before = structuredClone(data);
  const plan = draft(data);
  assert.equal(plan.canExecute, false); assert.equal(plan.status, 'blocked'); assert.equal(plan.policy, 'review-only');
  assert.deepEqual(plan.steps.map(step => step.number), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(plan.steps.map(step => step.decision), ['skipped', 'candidate', 'excluded', 'candidate', 'excluded', 'blocked', 'blocked', 'blocked']);
  assert.deepEqual(plan.totals, { candidate: 2, excluded: 2, blocked: 3, skipped: 1 });
  for (const code of ['EXECUTION_NOT_IMPLEMENTED', 'SOURCE_SUBSET_NOT_VALIDATED', 'WRITE_PRIVILEGES_NOT_REVIEWED', 'DESTRUCTIVE_POLICY_REQUIRED', 'SESSION_CONTEXT_NOT_PLANNED', 'STATEMENT_NOT_CLASSIFIED']) assert.ok(plan.blockers.some(item => item.code === code), code);
  assert.deepEqual(data, before);
  assert.equal(Object.isFrozen(plan.steps[0]), true); assert.equal(Object.isFrozen(plan.selection.tables), true);
  assert.throws(() => { plan.steps[0].decision = 'candidate'; }, TypeError);
  assert.throws(() => { plan.selection.tables.push('other'); }, TypeError);
});

test('data-only and structure-only selections exclude the other part without accepting DROP', () => {
  const data = inventory(sql);
  const onlyData = draft(data, { includeStructure: false });
  assert.equal(onlyData.steps[1].reason, 'PART_NOT_SELECTED'); assert.equal(onlyData.steps[5].reason, 'PART_NOT_SELECTED');
  assert.equal(onlyData.totals.candidate, 1);
  const onlyStructure = draft(data, { includeData: false });
  assert.equal(onlyStructure.steps[3].reason, 'PART_NOT_SELECTED'); assert.equal(onlyStructure.steps[5].reason, 'DESTRUCTIVE_POLICY_REQUIRED');
});

test('quoted names are exact; schema-qualified steps require mapping when the target differs', () => {
  const data = inventory('CREATE TABLE ` a.``b ` (id int); INSERT INTO `demo`.` a.``b ` VALUES(1); CREATE TABLE `A`(id int); CREATE TABLE `a`(id int);');
  const targetReview = { canExecute: false, snapshotId: 'c'.repeat(64), database: 'destination', findings: [], rows: [] };
  const plan = draft(data, { tables: [' a.`b ', 'A'] }, { targetReview });
  assert.equal(plan.steps[0].table, ' a.`b '); assert.equal(plan.steps[1].reason, 'SCHEMA_MAPPING_REQUIRED');
  assert.equal(plan.steps[2].decision, 'candidate'); assert.equal(plan.steps[3].decision, 'excluded');
});

test('ambiguous/multi-table or opaque SQL stays unclassified and never silently excluded', () => {
  const data = inventory('CREATE TABLE items(id int); CREATE TABLE other(id int); DROP TABLE items,other; RENAME TABLE items TO other; INSERT INTO items SELECT 1;');
  const plan = draft(data);
  assert.equal(plan.steps[2].reason, 'STATEMENT_NOT_CLASSIFIED'); assert.equal(plan.steps[3].reason, 'STATEMENT_NOT_CLASSIFIED');
  assert.equal(plan.steps[4].decision, 'blocked');
  assert.equal(plan.steps[4].syntaxReview.status, 'unsupported');
  assert.ok(plan.blockers.some(item => item.code === 'SOURCE_SUBSET_NOT_VALIDATED'));
  assert.ok(plan.blockers.some(item => item.detail === 'DATA_DEPENDENCIES_NOT_ANALYZED'));
});

test('draft surfaces matched literal syntax without dropping execution gates; old INSERT reviews stay blocked', () => {
  const data = inventory('CREATE TABLE items(id int); INSERT INTO items VALUES(1),(2); INSERT INTO items VALUES(NOW());');
  const plan = draft(data);
  assert.deepEqual(plan.syntaxTotals, { matched: 1, unsupported: 1, notReviewed: 0 });
  assert.equal(plan.steps[1].reason, 'LITERAL_INSERT_MATCHED');
  assert.equal(plan.steps[1].syntaxReview.rows, 2);
  assert.equal(plan.steps[2].decision, 'blocked');
  assert.equal(Object.isFrozen(data.statementLedger.entries[1].syntaxReview), false);
  assert.equal(plan.canExecute, false); assert.ok(plan.blockers.some(item => item.code === 'SOURCE_SUBSET_NOT_VALIDATED'));
  delete data.statementLedger.entries[1].syntaxReview;
  const older = draft(data);
  assert.equal(older.steps[1].reason, 'INSERT_SYNTAX_NOT_REVIEWED'); assert.equal(older.steps[1].decision, 'blocked');
  assert.notEqual(older.planId, plan.planId);
});

test('draft checks syntax evidence target/shape and projects only the review fields', () => {
  const data = inventory('CREATE TABLE items(id int); INSERT INTO items VALUES(1);');
  const evidence = data.statementLedger.entries[1].syntaxReview;
  evidence.rawSql = 'sensitive-value';
  assert.equal(JSON.stringify(draft(data)).includes('sensitive-value'), false);
  evidence.table = 'different';
  assert.equal(draft(data).steps[1].reason, 'INSERT_TARGET_MISMATCH');
  evidence.table = 'items'; evidence.rows = 0;
  assert.equal(draft(data).steps[1].reason, 'INSERT_SYNTAX_NOT_REVIEWED');
});

test('draft identity binds file, selection flags, target identity/snapshot and the full ledger', () => {
  const data = inventory(sql), first = draft(data);
  assert.equal(draft(data).planId, first.planId);
  for (const other of [draft(data, { tables: ['other'] }), draft(data, { includeData: false }), draft(data, {}, { checksum: 'c'.repeat(64) }), draft(data, {}, { targetIdentity: 'd'.repeat(64) }), draft(data, {}, { targetReview: { canExecute: false, snapshotId: 'e'.repeat(64), database: 'demo', findings: [], rows: [] } })]) assert.notEqual(other.planId, first.planId);
  const changed = structuredClone(data); changed.statementLedger.entries[1].schema = 'demo';
  assert.notEqual(draft(changed).planId, first.planId);
  assert.throws(() => draft(data, {}, { checksum: 'forged' }), /Thiếu/);
  assert.throws(() => draft(data, {}, { targetReview: { canExecute: true } }), /Thiếu/);
});

test('old inventories, gaps, truncated ledger and truncated observations never imply a complete plan', () => {
  const old = inventory('CREATE TABLE items(id int);'); delete old.statementLedger;
  assert.ok(draft(old).blockers.some(item => item.code === 'STATEMENT_LEDGER_INCOMPLETE'));
  const gap = inventory('CREATE TABLE items(id int); INSERT INTO items VALUES(1);');
  gap.statementLedger.entries[1].number = 4;
  assert.equal(draft(gap).steps[1].decision, 'blocked');
  gap.statementLedger.truncated = true; gap.truncated = true;
  const plan = draft(gap);
  assert.equal(plan.stepsTruncated, true); assert.ok(plan.blockers.some(item => item.code === 'SOURCE_REVIEW_INCOMPLETE'));
});

test('ledger and response quotas are explicit, counts include retained entries beyond the UI', () => {
  const data = inventory(`CREATE TABLE items(id int);${'INSERT INTO items VALUES(1);'.repeat(10001)}`);
  assert.equal(data.statementLedger.entries.length, 10000); assert.equal(data.statementLedger.total, 10002); assert.equal(data.statementLedger.truncated, true);
  const plan = draft(data);
  assert.equal(plan.steps.length, 200); assert.equal(plan.stepsTruncated, true); assert.equal(plan.totals.candidate, 10000);
  assert.ok(plan.blockers.some(item => item.code === 'STATEMENT_LEDGER_INCOMPLETE'));
  const unknown = inventory(`CREATE TABLE items(id int);${'SELECT 1;'.repeat(110)}`);
  const bounded = draft(unknown);
  assert.equal(bounded.blockers.length, 100); assert.equal(bounded.blockersTruncated, true);
});

test('ledger and draft never retain row/default/generated literals or raw SQL', () => {
  const data = inventory("CREATE TABLE items(id int DEFAULT 123456789); INSERT INTO items VALUES('private-row');");
  for (const value of [data.statementLedger, draft(data)]) {
    const serialized = JSON.stringify(value);
    assert.equal(serialized.includes('private-row'), false); assert.equal(serialized.includes('123456789'), false);
    assert.equal(serialized.includes('CREATE TABLE'), false); assert.equal(serialized.includes('token'), false);
  }
});
