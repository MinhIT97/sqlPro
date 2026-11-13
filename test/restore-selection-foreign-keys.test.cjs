'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { projectForeignKeys, reviewSelectedForeignKeys } = require('../electron/restore-selection-foreign-keys.cjs');
const column = (name, overrides = {}) => ({ name, type: 'int', typeKnown: true, attributesKnown: true, nullable: true, ...overrides });
const fk = (overrides = {}) => ({ name: 'fk_parent', columns: ['parent_id'], referencedSchema: null, referencedTable: 'parent', referencedColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE', ...overrides });
function fixture() {
  return {
    source: { includeStructure: true, sourceDatabase: 'demo', rows: [
      { name: 'child', columnSchema: { complete: true, columns: [column('parent_id')] } },
      { name: 'parent', columnSchema: { complete: true, columns: [column('id')] } }
    ] },
    targetReview: { database: 'demo', lowerCaseTableNames: 0 },
    policyReview: { rows: [{ name: 'child', disposition: 'review' }, { name: 'parent', disposition: 'review' }] },
    creates: [
      { table: 'child', schema: null, review: { version: 3, status: 'matched', indexDefinitions: [{ name: 'child_unique', kind: 'unique', columns: [{ name: 'parent_id', prefixLength: null }] }], foreignKeys: [fk()] } },
      { table: 'parent', schema: null, review: { version: 3, status: 'matched', indexDefinitions: [{ name: 'PRIMARY', kind: 'primary', columns: [{ name: 'id', prefixLength: null }] }], foreignKeys: [] } }
    ]
  };
}

test('FK review preserves exact pairs/actions but matches a source key but still requires data and server checks', () => {
  const input = fixture(), before = structuredClone(input);
  const result = reviewSelectedForeignKeys(input);
  assert.equal(result.canExecute, false); assert.deepEqual(result.totals, { review: 1, blocked: 0, excluded: 0 });
  assert.deepEqual(result.rows[0].pairs, [{ column: 'parent_id', referencedColumn: 'id' }]);
  assert.equal(result.rows[0].onDelete, 'SET NULL'); assert.equal(result.rows[0].onUpdate, 'CASCADE');
  assert.deepEqual(result.rows[0].requires, ['FK_DATA_NOT_CHECKED', 'FK_SERVER_RULES_NOT_VALIDATED']);
  assert.equal(result.rows[0].referencedIndexReview.name, 'PRIMARY');
  assert.equal(result.rows[0].referencedIndexReview.status, 'matched');
  assert.deepEqual(input, before);
});

test('parent scope, unknown case, skipped owners/parents and ambiguous names remain explicit', () => {
  const cases = [
    [r => { r.targetReview.lowerCaseTableNames = null; }, 'FK_CASE_POLICY_UNKNOWN'],
    [r => { r.creates[0].review.foreignKeys[0].referencedSchema = 'other'; }, 'FK_SCHEMA_MAPPING_REQUIRED'],
    [r => { r.source.rows.pop(); }, 'FK_PARENT_NOT_SELECTED'],
    [r => { r.policyReview.rows[1].disposition = 'skip'; }, 'FK_PARENT_SKIPPED'],
    [r => { r.policyReview.rows[1].disposition = 'blocked'; }, 'FK_PARENT_POLICY_BLOCKED'],
    [r => { r.policyReview.rows[0].disposition = 'blocked'; }, 'FK_OWNER_POLICY_BLOCKED'],
    [r => { r.source.rows.push({ ...r.source.rows[1], name: 'PARENT' }); r.targetReview.lowerCaseTableNames = 1; }, 'FK_PARENT_NAME_AMBIGUOUS'],
    [r => { r.creates[1].review.version = 1; }, 'FK_PARENT_CREATE_NOT_REVIEWED']
  ];
  for (const [change, code] of cases) {
    const input = fixture(); change(input);
    assert.equal(reviewSelectedForeignKeys(input).rows[0].reason, code);
  }
  const skipped = fixture(); skipped.policyReview.rows[0].disposition = 'skip';
  assert.equal(reviewSelectedForeignKeys(skipped).rows[0].status, 'excluded');
  const folded = fixture(); folded.targetReview.lowerCaseTableNames = 1; folded.creates[0].review.foreignKeys[0].referencedTable = 'PARENT';
  assert.equal(reviewSelectedForeignKeys(folded).rows[0].status, 'review');
});

test('missing column, unknown types/attributes, differing types/collations and SET NULL on NOT NULL are blocked', () => {
  const cases = [
    [r => { r.source.rows[1].columnSchema.complete = false; }, 'FK_COLUMN_METADATA_UNKNOWN'],
    [r => { r.source.rows[1].columnSchema.columns[0].name = 'other'; }, 'FK_COLUMN_NOT_FOUND'],
    [r => { r.source.rows[0].columnSchema.columns[0].typeKnown = false; }, 'FK_COLUMN_METADATA_UNKNOWN'],
    [r => { r.source.rows[0].columnSchema.columns[0].attributesKnown = false; }, 'FK_COLUMN_METADATA_UNKNOWN'],
    [r => { r.source.rows[1].columnSchema.columns[0].type = 'bigint'; }, 'FK_COLUMN_TYPE_REQUIRES_REVIEW'],
    [r => { r.source.rows[0].columnSchema.columns[0].nullable = false; }, 'FK_SET_NULL_REQUIRES_NULLABLE'],
    [r => { for (const row of r.source.rows) row.columnSchema.columns[0].type = 'varchar(20)'; }, 'FK_COLUMN_METADATA_UNKNOWN'],
    [r => { for (const row of r.source.rows) Object.assign(row.columnSchema.columns[0], { type: 'varchar(20)', charset: 'utf8mb4', collation: row.name === 'child' ? 'utf8mb4_bin' : 'utf8mb4_general_ci' }); }, 'FK_COLLATION_REQUIRES_REVIEW']
  ];
  for (const [change, code] of cases) {
    const input = fixture(); change(input);
    assert.equal(reviewSelectedForeignKeys(input).rows[0].reason, code);
  }
});

test('qualified CREATE mapping blocks FK review before owner skip and before accepting a parent definition', () => {
  for (const index of [0, 1]) {
    for (const schema of ['other', 'DEMO']) {
      const input = fixture();
      input.targetReview.lowerCaseTableNames = 1;
      input.creates[index].schema = schema;
      if (index === 0) input.policyReview.rows[0].disposition = 'skip';
      const result = reviewSelectedForeignKeys(input);
      assert.equal(result.rows[0].status, 'blocked');
      assert.equal(result.rows[0].reason, 'FK_SCHEMA_MAPPING_REQUIRED');
      assert.equal(result.canExecute, false);
    }
  }
  const exact = fixture(); exact.creates[1].schema = 'demo';
  assert.equal(reviewSelectedForeignKeys(exact).rows[0].status, 'review');
});

test('self references are reviewed without claiming cycles can execute; data-only excludes source CREATE review', () => {
  const input = fixture(); input.creates[0].review.foreignKeys[0].referencedTable = 'child';
  input.creates[0].review.foreignKeys[0].referencedColumns = ['parent_id'];
  const result = reviewSelectedForeignKeys(input);
  assert.equal(result.rows[0].status, 'review'); assert.equal(result.canExecute, false);
  input.source.includeStructure = false;
  assert.equal(reviewSelectedForeignKeys(input).rows.length, 0);
});

test('projection rejects malformed/oversized evidence and discards SQL/default/private fields', () => {
  const original = fk({ privateSQL: 'private-value' });
  assert.equal(JSON.stringify(projectForeignKeys([original])).includes('private-'), false);
  for (const list of [null, [fk({ referencedTable: '' })], [fk({ onDelete: 'SET DEFAULT' })], [fk({ columns: [] })],
    [fk({ referencedColumns: ['id', 'other'] })], [fk({ columns: ['id', 'ID'], referencedColumns: ['a', 'b'] })],
    [fk(), fk({ name: 'FK_PARENT' })], Array(65).fill(fk())]) assert.equal(projectForeignKeys(list), null);
  const input = fixture(); input.creates[0].review.version = 1;
  assert.equal(reviewSelectedForeignKeys(input).tablesNotReviewed, 1);
  input.creates[0].review.version = 3; input.creates.push(input.creates[0]);
  assert.equal(reviewSelectedForeignKeys(input).tablesNotReviewed, 1);
});

test('result rows, pair totals and findings are bounded with explicit truncation', () => {
  const input = fixture(); input.source.rows = []; input.policyReview.rows = []; input.creates = [];
  for (let i = 0; i < 40; i++) {
    const name = `child${i}`;
    input.source.rows.push({ name }); input.policyReview.rows.push({ name, disposition: 'skip' });
    input.creates.push({ table: name, schema: null, review: { version: 3, status: 'matched', foreignKeys: Array.from({ length: 64 }, (_, n) => fk({ name: `fk${n}` })) } });
  }
  const result = reviewSelectedForeignKeys(input);
  assert.equal(result.rows.length, 2000); assert.equal(result.truncated, true);
  assert.ok(result.findings.some(item => item.code === 'FK_REVIEW_LIMIT'));
  const columns = Array.from({ length: 16 }, (_, i) => `c${i}`);
  for (const entry of input.creates) for (const fk of entry.review.foreignKeys) { fk.columns = columns; fk.referencedColumns = columns; }
  const pairLimited = reviewSelectedForeignKeys(input);
  assert.equal(pairLimited.pairs, 10000); assert.equal(pairLimited.rows.length, 625); assert.equal(pairLimited.truncated, true);
  const noReview = fixture(); noReview.source.rows = Array.from({ length: 150 }, (_, i) => ({ name: `unknown${i}` })); noReview.creates = [];
  const findings = reviewSelectedForeignKeys(noReview);
  assert.equal(findings.findings.length, 100); assert.equal(findings.truncated, true);
});


test('missing or malformed parent indexes block FK review, even when columns match', () => {
  for (const [definitions, reason] of [[[], 'FK_REFERENCED_UNIQUE_KEY_NOT_FOUND'], [null, 'FK_REFERENCED_INDEX_NOT_REVIEWED'],
    [[{ name: 'ordinary', kind: 'index', columns: [{ name: 'id', prefixLength: null }] }], 'FK_REFERENCED_UNIQUE_KEY_NOT_FOUND']]) {
    const input = fixture(); input.creates[1].review.indexDefinitions = definitions;
    const row = reviewSelectedForeignKeys(input).rows[0];
    assert.equal(row.status, 'blocked'); assert.equal(row.reason, reason);
    assert.equal(row.referencedIndexReview.status, 'blocked');
  }
});

test('observed target key on a skipped parent is informative and never removes dependency/policy blocks', () => {
  const { reviewTargetIndexes } = require('../electron/restore-selection-target-indexes.cjs');
  const input = fixture(); input.policyReview.rows[1].disposition = 'skip';
  const indexReview = reviewTargetIndexes([{ name: 'PRIMARY', nonUnique: false, ordinal: 1, column: 'id', prefixLength: null, direction: 'A', type: 'BTREE', visibility: 'visible' }],
    { metadataComplete: true, tableObserved: true, visibilityKind: 'mysql-visible' });
  input.targetReview.rows = [{ name: 'parent', objectCount: 1, objects: [{ name: 'parent', type: 'table' }], indexReview }];
  const report = reviewSelectedForeignKeys(input), row = report.rows[0];
  assert.equal(report.version, 4); assert.equal(report.canExecute, false);
  assert.equal(row.reason, 'FK_PARENT_SKIPPED'); assert.equal(row.status, 'blocked');
  assert.equal(row.targetReferencedIndexReview.status, 'observed-match'); assert.equal(row.targetReferencedIndexReview.name, 'PRIMARY');
  Object.assign(input.targetReview.rows[0].indexReview.indexes[0], { name: 'id_unique', kind: 'unique', visibility: 'invisible' });
  const hidden = reviewSelectedForeignKeys(input).rows[0];
  assert.equal(hidden.targetReferencedIndexReview.status, 'requires-review'); assert.equal(hidden.reason, 'FK_PARENT_SKIPPED');
  input.targetReview.rows[0].indexReview.complete = false;
  assert.equal(reviewSelectedForeignKeys(input).rows[0].targetReferencedIndexReview.status, 'unknown');
  input.targetReview.rows.push(input.targetReview.rows[0]);
  assert.equal(reviewSelectedForeignKeys(input).rows[0].targetReferencedIndexReview, null);
});
