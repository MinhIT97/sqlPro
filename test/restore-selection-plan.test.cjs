'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RestoreSelectionInventory, previewRestoreSelection } = require('../electron/restore-selection.cjs');
const { SqlScriptParser, assertStatementScope, skipReason } = require('../electron/sql-script.cjs');
const { buildSelectionDraft } = require('../electron/restore-selection-plan.cjs');
const { buildSelectionTargetPreview } = require('../electron/restore-selection-target.cjs');
const { normalizeSessionSettings } = require('../electron/restore-selection-session-policy.cjs');

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
  const facts = { checks: [], checkCapabilities: { version: 1, status: 'observed', tableColumn: false, enforcedColumn: true }, database: 'demo', checkedAt: '2026-11-12T12:00:00Z', version: '8.4', lowerCaseTableNames: 0,
    databaseVisible: true, objects: options.includeStructure === false ? [{ name: 'items', type: 'table', engine: 'InnoDB' }] : [], triggers: [], foreignKeys: [], foreignKeyMetadataVersion: 2, columns: [], indexes: [], errors: [], truncated: [] };
  const targetReview = buildSelectionTargetPreview({ source, checksum, targetIdentity, facts });
  return buildSelectionDraft({ inventory: data, source, checksum, targetIdentity, targetReview, ...overrides });
}
const sql = "USE demo; CREATE TABLE `items`(`id` int) ENGINE=InnoDB; CREATE TABLE `other`(`id` int) ENGINE=InnoDB; INSERT INTO items VALUES(1); INSERT INTO other VALUES(2); DROP TABLE items; SET @saved=1; SELECT 1;";

test('session proposal is immutable, bound independently of supplied snapshot and retains context/execution gates', () => {
  const data = inventory("SET NAMES utf8mb4; SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0; SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO'; CREATE TABLE `items` (`id` INT) ENGINE=InnoDB; SET SQL_MODE=@OLD_SQL_MODE; SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS;");
  const targetReview = { canExecute: false, snapshotId: 'c'.repeat(64), database: 'demo', findings: [], lowerCaseTableNames: 0,
    metadataStatus: { complete: true, databaseVisible: true }, rows: [{ name: 'items', objects: [], objectCount: 0 }],
    sessionSettings: normalizeSessionSettings({ foreignKeyChecks: 1, uniqueChecks: 1, autocommit: 1, sqlMode: 'STRICT_TRANS_TABLES',
      charsetClient: 'utf8mb4', charsetConnection: 'utf8mb4', charsetResults: 'utf8mb4' }) };
  const first = draft(data, {}, { targetReview });
  assert.deepEqual(first.sessionPolicyReview.findings, []); assert.equal(first.canExecute, false);
  assert.ok(first.blockers.some(item => item.code === 'SESSION_CLEANUP_NOT_IMPLEMENTED'));
  assert.ok(first.blockers.some(item => item.code === 'DUMP_CONTEXT_REQUIRES_POLICY'));
  assert.equal(first.steps.filter(step => step.command === 'SET').every(step => step.decision === 'blocked'), true);
  assert.equal(Object.isFrozen(first.sessionPolicyReview.proposedMode.flags), true);
  assert.throws(() => first.sessionPolicyReview.requires.pop(), TypeError);
  const changed = structuredClone(targetReview); changed.sessionSettings.foreignKeyChecks = false;
  const second = draft(data, {}, { targetReview: changed });
  assert.notEqual(first.planId, second.planId); assert.ok(second.blockers.some(item => item.code === 'SESSION_FK_CHECKS_DISABLED'));
  for (const value of [false, null]) {
    const uniqueTarget = structuredClone(targetReview); uniqueTarget.sessionSettings.uniqueChecks = value;
    const uniquePlan = draft(data, {}, { targetReview: uniqueTarget });
    assert.notEqual(first.planId, uniquePlan.planId); assert.equal(uniquePlan.canExecute, false);
    assert.ok(uniquePlan.blockers.some(item => item.code === (value === false ? 'SESSION_UNIQUE_CHECKS_DISABLED' : 'SESSION_UNIQUE_CHECKS_NOT_REVIEWED')));
    assert.equal(Object.isFrozen(uniquePlan.sessionPolicyReview.observations), true);
  }
});

test('draft attributes bounded statements in source order, marks DROP/context/unknown and preserves all gates', () => {
  const data = inventory(sql), before = structuredClone(data);
  const plan = draft(data);
  assert.equal(plan.canExecute, false); assert.equal(plan.status, 'blocked'); assert.equal(plan.policy, 'review-only');
  assert.deepEqual(plan.steps.map(step => step.number), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(plan.steps.map(step => step.decision), ['skipped', 'candidate', 'excluded', 'candidate', 'excluded', 'blocked', 'blocked', 'blocked']);
  assert.deepEqual(plan.totals, { candidate: 2, excluded: 2, blocked: 3, skipped: 1 });
  for (const code of ['EXECUTION_NOT_IMPLEMENTED', 'SOURCE_SUBSET_NOT_VALIDATED', 'WRITE_PRIVILEGES_NOT_REVIEWED', 'DESTRUCTIVE_POLICY_REQUIRED', 'CONTEXT_SET_UNSUPPORTED', 'STATEMENT_NOT_CLASSIFIED']) assert.ok(plan.blockers.some(item => item.code === code), code);
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
  const data = inventory('CREATE TABLE ` a.``b ` (`id` int) ENGINE=InnoDB; INSERT INTO `demo`.` a.``b ` VALUES(1); CREATE TABLE `A`(`id` int) ENGINE=InnoDB; CREATE TABLE `a`(`id` int) ENGINE=InnoDB;');
  const targetReview = { canExecute: false, snapshotId: 'c'.repeat(64), database: 'destination', findings: [], lowerCaseTableNames: 0,
    metadataStatus: { complete: true, databaseVisible: true }, rows: [' a.`b ', 'A'].map(name => ({ name, objects: [], objectCount: 0 })) };
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

test('CREATE evidence is required, bound to target/shape and projected without defaults or extra fields', () => {
  const data = inventory("CREATE TABLE `items` (`id` int DEFAULT 123456789, PRIMARY KEY (`id`)) ENGINE=InnoDB; CREATE TABLE `other` (`id` int) ENGINE=MyISAM;");
  const first = draft(data);
  assert.equal(first.version, 29); assert.equal(first.canExecute, false);
  assert.equal(first.steps[0].reason, 'BASIC_CREATE_MATCHED');
  assert.deepEqual(first.createSyntaxTotals, { matched: 1, unsupported: 0, notReviewed: 0 });
  assert.equal(first.steps[0].syntaxReview.columns, 1); assert.equal(first.steps[0].syntaxReview.indexes, 1);
  assert.equal(first.steps[1].decision, 'excluded');
  const evidence = data.statementLedger.entries[0].syntaxReview;
  evidence.rawSql = 'private-sql'; evidence.default = 'private-default';
  assert.equal(JSON.stringify(draft(data)).includes('private-'), false);
  evidence.table = 'other'; assert.equal(draft(data).steps[0].reason, 'CREATE_TARGET_MISMATCH');
  evidence.table = 'items'; evidence.columns = 0; assert.equal(draft(data).steps[0].reason, 'CREATE_SYNTAX_NOT_REVIEWED');
  evidence.columns = 1; evidence.engine = 'MyISAM'; assert.equal(draft(data).steps[0].decision, 'blocked');
  delete data.statementLedger.entries[0].syntaxReview;
  const old = draft(data); assert.equal(old.steps[0].reason, 'CREATE_SYNTAX_NOT_REVIEWED');
  assert.equal(old.createSyntaxTotals.notReviewed, 1); assert.notEqual(old.planId, first.planId);
  const unsupported = draft(inventory('CREATE TABLE `items` (`id` int, CHECK (`id`>0)) ENGINE=InnoDB;'));
  assert.equal(unsupported.steps[0].decision, 'blocked'); assert.equal(unsupported.createSyntaxTotals.unsupported, 1);
});

test('session context is projected and bound, never becomes executable and includes unselected-table order', () => {
  const header = "SET NAMES utf8mb4; SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0; SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO';";
  const footer = 'SET SQL_MODE=@OLD_SQL_MODE; SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS;';
  const data = inventory(`${header} CREATE TABLE \`items\` (\`id\` int) ENGINE=InnoDB; ${footer}`);
  const plan = draft(data);
  assert.equal(plan.sessionContextReview.sequenceMatched, true); assert.equal(plan.sessionContextReview.matched, 5);
  assert.equal(plan.sessionContextReview.canExecute, false); assert.equal(plan.canExecute, false);
  assert.ok(plan.steps.filter(step => step.command === 'SET').every(step => step.decision === 'blocked' && step.reason === 'DUMP_CONTEXT_REQUIRES_POLICY'));
  for (const code of ['DUMP_CONTEXT_REQUIRES_POLICY', 'CONTEXT_FOREIGN_KEYS_RECHECK_REQUIRED', 'CONTEXT_SQL_MODE_REVIEW_REQUIRED', 'EXECUTION_NOT_IMPLEMENTED']) assert.ok(plan.blockers.some(item => item.code === code), code);
  assert.equal(Object.isFrozen(plan.sessionContextReview.findings), true);
  data.statementLedger.entries[0].contextReview.rawSql = 'private-sql';
  assert.equal(JSON.stringify(draft(data)).includes('private-sql'), false);
  delete data.statementLedger.entries[0].contextReview;
  const older = draft(data); assert.equal(older.sessionContextReview.notReviewed, 1);
  assert.equal(older.steps[0].reason, 'CONTEXT_NOT_REVIEWED'); assert.notEqual(older.planId, plan.planId);
  const outside = draft(inventory(`${header} CREATE TABLE \`items\` (\`id\` int) ENGINE=InnoDB; ${footer} INSERT INTO other VALUES(1);`));
  assert.equal(outside.steps.at(-1).decision, 'excluded'); assert.equal(outside.sessionContextReview.sequenceMatched, false);
  assert.ok(outside.blockers.some(item => item.code === 'CONTEXT_BODY_AFTER_RESTORE'));
});

test('FK source evidence binds pairs/actions to the draft and reports parent selection/skip without granting writes', () => {
  const sql = 'CREATE TABLE `parent` (`id` int, PRIMARY KEY (`id`)) ENGINE=InnoDB; CREATE TABLE `items` (`pid` int, CONSTRAINT `fk_items` FOREIGN KEY (`pid`) REFERENCES `parent` (`id`) ON DELETE SET NULL) ENGINE=InnoDB;';
  const data = inventory(sql), onlyChild = draft(data);
  assert.equal(onlyChild.foreignKeyReview.rows[0].reason, 'FK_PARENT_NOT_SELECTED');
  const both = draft(data, { tables: ['items', 'parent'] });
  assert.equal(both.foreignKeyReview.rows[0].status, 'review'); assert.equal(both.canExecute, false);
  assert.deepEqual(both.foreignKeyReview.rows[0].pairs, [{ column: 'pid', referencedColumn: 'id' }]);
  assert.equal(both.foreignKeyReview.rows[0].referencedIndexReview.name, 'PRIMARY');
  assert.ok(both.blockers.some(item => item.code === 'FK_DATA_NOT_CHECKED'));
  assert.equal(both.blockers.some(item => item.code === 'FK_REFERENCED_INDEX_NOT_REVIEWED'), false);
  assert.ok(Object.isFrozen(both.foreignKeyReview.rows[0].pairs[0]));
  const evidence = data.statementLedger.entries[1].syntaxReview;
  evidence.foreignKeys[0].rawSql = 'private-fk-expression';
  assert.equal(JSON.stringify(draft(data, { tables: ['items', 'parent'] })).includes('private-fk-expression'), false);
  evidence.foreignKeys[0].onDelete = 'CASCADE';
  assert.notEqual(draft(data, { tables: ['items', 'parent'] }).planId, both.planId);
  evidence.foreignKeys[0].columns = [];
  assert.equal(draft(data).steps[1].syntaxReview, null);
  const old = inventory(sql); old.statementLedger.entries[1].syntaxReview.version = 1;
  assert.equal(draft(old).steps[1].reason, 'CREATE_SYNTAX_NOT_REVIEWED');
  const targetReview = { canExecute: false, snapshotId: 'a'.repeat(64), database: 'demo', lowerCaseTableNames: 0,
    metadataStatus: { complete: true, databaseVisible: true }, findings: [], rows: [
      { name: 'items', objects: [], objectCount: 0 }, { name: 'parent', objects: [{ name: 'parent', type: 'table' }], objectCount: 1 }
    ] };
  const skippedParent = draft(inventory(sql), { tables: ['items', 'parent'] }, { targetReview, conflictPolicy: 'skip-existing' });
  assert.equal(skippedParent.foreignKeyReview.rows[0].reason, 'FK_PARENT_SKIPPED');
  assert.equal(skippedParent.steps[1].reason, 'POLICY_DEPENDENCY_SKIPPED');
});

test('recognized self/cyclic FK still preserves unresolved-order gates', () => {
  const sql = 'CREATE TABLE `items` (`id` int, PRIMARY KEY (`id`), FOREIGN KEY (`id`) REFERENCES `items` (`id`)) ENGINE=InnoDB;';
  const plan = draft(inventory(sql));
  assert.equal(plan.steps[0].syntaxReview.status, 'matched');
  assert.equal(plan.foreignKeyReview.rows[0].status, 'review');
  assert.ok(plan.blockers.some(item => item.detail === 'FK_CYCLE_OR_BLOCKED')); assert.equal(plan.canExecute, false);
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

test('conflict policy binds identity and excludes all statements for skipped tables without accepting DROP or unknown SQL', () => {
  const data = inventory('CREATE TABLE `items` (`id` int) ENGINE=InnoDB; INSERT INTO items VALUES(1); DROP TABLE items; SET @anything=1;');
  const targetReview = { canExecute: false, snapshotId: 'a'.repeat(64), database: 'demo', lowerCaseTableNames: 0,
    metadataStatus: { complete: true, databaseVisible: true }, findings: [], rows: [{ name: 'items', objects: [{ name: 'items', type: 'table' }], objectCount: 1 }] };
  const stop = draft(data, {}, { targetReview });
  assert.ok(stop.steps.slice(0, 3).every(step => step.reason === 'POLICY_TABLE_EXISTS'));
  const skip = draft(data, {}, { targetReview, conflictPolicy: 'skip-existing' });
  assert.ok(skip.steps.slice(0, 3).every(step => step.decision === 'excluded' && step.reason === 'POLICY_SKIP_EXISTING_TABLE'));
  assert.equal(skip.steps[3].decision, 'blocked'); assert.equal(skip.canExecute, false);
  assert.equal(skip.conflictPolicyReview.destructiveChangesAllowed, false); assert.notEqual(skip.planId, stop.planId);
  assert.equal(Object.isFrozen(skip.conflictPolicyReview.rows[0]), true);
  const missing = draft(data, {}, { targetReview: { ...targetReview, metadataStatus: undefined }, conflictPolicy: 'skip-existing' });
  assert.equal(missing.steps[0].decision, 'blocked'); assert.notEqual(missing.planId, skip.planId);
  const mapped = draft(inventory('CREATE TABLE `demo`.`items` (`id` int) ENGINE=InnoDB;'), {}, {
    targetReview: { ...targetReview, database: 'destination' }, conflictPolicy: 'skip-existing'
  });
  assert.equal(mapped.steps[0].reason, 'SCHEMA_MAPPING_REQUIRED');
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
  const data = inventory(`CREATE TABLE \`items\`(\`id\` int) ENGINE=InnoDB;${'INSERT INTO items VALUES(1);'.repeat(10001)}`);
  assert.equal(data.statementLedger.entries.length, 10000); assert.equal(data.statementLedger.total, 10002); assert.equal(data.statementLedger.truncated, true);
  const plan = draft(data);
  assert.equal(plan.steps.length, 200); assert.equal(plan.stepsTruncated, true); assert.equal(plan.totals.candidate, 101);
  assert.equal(plan.steps[101].reason, 'VALUE_REPORT_LIMIT');
  assert.ok(plan.blockers.some(item => item.code === 'STATEMENT_LEDGER_INCOMPLETE'));
  const unknown = inventory(`CREATE TABLE items(id int);${'SELECT 1;'.repeat(110)}`);
  const bounded = draft(unknown);
  assert.equal(bounded.blockers.length, 100); assert.equal(bounded.blockersTruncated, true);
});

test('omitted wide value rows stay blocked even when a known issue is outside the report field budget', () => {
  const columns = Array.from({ length: 100 }, (_, index) => `\`c${index}\` tinyint`);
  const values = Array(100).fill('1').join(',');
  const invalid = ['999', ...Array(99).fill('1')].join(',');
  const data = inventory(`CREATE TABLE \`items\` (${columns.join(',')}) ENGINE=InnoDB;${`INSERT INTO items VALUES(${values});`.repeat(10)}INSERT INTO items VALUES(${invalid});`);
  const plan = draft(data);
  assert.equal(plan.valueReview.rows.length, 10);
  assert.equal(plan.valueReview.totals.issues, 1);
  assert.equal(plan.valueReview.truncated, true);
  assert.equal(plan.valueReview.rows.some(row => row.number === 12), false);
  assert.equal(plan.steps[11].decision, 'blocked');
  assert.equal(plan.steps[11].reason, 'VALUE_REPORT_LIMIT');
  assert.equal(plan.canExecute, false);
});

test('ledger and draft never retain row/default/generated literals or raw SQL', () => {
  const data = inventory("CREATE TABLE items(id int DEFAULT 123456789); INSERT INTO items VALUES('private-row');");
  for (const value of [data.statementLedger, draft(data)]) {
    const serialized = JSON.stringify(value);
    assert.equal(serialized.includes('private-row'), false); assert.equal(serialized.includes('123456789'), false);
    assert.equal(serialized.includes('CREATE TABLE'), false); assert.equal(serialized.includes('token'), false);
  }
});


test('index evidence is projected, bound to plan identity and never reused from old CREATE versions', () => {
  const sql = 'CREATE TABLE `parent` (`id` int, UNIQUE KEY `source_key` (`id`)) ENGINE=InnoDB; CREATE TABLE `items` (`pid` int, FOREIGN KEY (`pid`) REFERENCES `parent` (`id`)) ENGINE=InnoDB;';
  const data = inventory(sql), options = { tables: ['items', 'parent'] }, first = draft(data, options);
  const evidence = data.statementLedger.entries[0].syntaxReview;
  evidence.indexDefinitions[0].rawSql = 'private-index'; evidence.indexDefinitions[0].columns[0].default = 'private-default';
  assert.equal(JSON.stringify(draft(data, options)).includes('private-'), false);
  evidence.indexDefinitions[0].name = 'renamed_key';
  assert.notEqual(draft(data, options).planId, first.planId);
  evidence.indexDefinitions[0].kind = 'index';
  const noUnique = draft(data, options);
  assert.equal(noUnique.foreignKeyReview.rows[0].reason, 'FK_REFERENCED_UNIQUE_KEY_NOT_FOUND');
  assert.equal(noUnique.canExecute, false);
  evidence.indexes = 0;
  assert.equal(draft(data, options).steps[0].reason, 'CREATE_SYNTAX_NOT_REVIEWED');
  for (const version of [1, 2]) {
    const old = inventory(sql); old.statementLedger.entries[0].syntaxReview.version = version;
    const plan = draft(old, options);
    assert.equal(plan.steps[0].reason, 'CREATE_SYNTAX_NOT_REVIEWED');
    assert.equal(plan.foreignKeyReview.rows[0].reason, 'FK_PARENT_CREATE_NOT_REVIEWED');
  }
});

test('FK comparison binds observations while existing-table policy and execution gates stay blocked', () => {
  const data = inventory('CREATE TABLE `parent` (`id` int, PRIMARY KEY (`id`)) ENGINE=InnoDB; CREATE TABLE `items` (`pid` int, CONSTRAINT `fk_item` FOREIGN KEY (`pid`) REFERENCES `parent` (`id`) ON DELETE SET NULL ON UPDATE CASCADE) ENGINE=InnoDB;');
  const targetReview = { canExecute: false, snapshotId: 'a'.repeat(64), database: 'demo', lowerCaseTableNames: 0, metadataStatus: { complete: true, databaseVisible: true }, findings: [], rows: [
    { name: 'items', objects: [{ name: 'items', type: 'table' }], objectCount: 1 }, { name: 'parent', objects: [{ name: 'parent', type: 'table' }], objectCount: 1 }
  ], targetForeignKeyReview: { version: 1, canExecute: false, complete: true, truncated: false, definitionCount: 1, rows: [{ name: 'fk_item', tableSchema: 'demo', table: 'items', referencedSchema: 'demo', referencedTable: 'parent',
    status: 'observed', pairCount: 1, pairs: [{ ordinal: 1, column: 'pid', referencedColumn: 'id' }], onDelete: 'SET NULL', onUpdate: 'CASCADE', match: 'NONE' }] } };
  const options = { tables: ['items', 'parent'] }, first = draft(data, options, { targetReview });
  assert.equal(first.foreignKeyComparison.totals.matched, 1); assert.equal(first.canExecute, false);
  assert.equal(first.steps.find(step => step.table === 'items').reason, 'POLICY_TABLE_EXISTS');
  assert.equal(Object.isFrozen(first.foreignKeyComparison.rows[0].target.pairs), true);
  const skip = draft(data, options, { targetReview, conflictPolicy: 'skip-existing' });
  assert.equal(skip.foreignKeyComparison.totals.matched, 1); assert.equal(skip.canExecute, false);
  assert.equal(skip.foreignKeyReview.rows[0].status, 'excluded');
  targetReview.targetForeignKeyReview.rows[0].onDelete = 'CASCADE';
  const changed = draft(data, options, { targetReview });
  assert.equal(changed.foreignKeyComparison.totals.differs, 1); assert.notEqual(changed.planId, first.planId);
});
