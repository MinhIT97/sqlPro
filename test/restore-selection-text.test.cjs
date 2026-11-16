'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewTextLiteral, projectText } = require('../electron/restore-selection-text.cjs');
const { reviewLiteralInsert } = require('../electron/restore-selection-syntax.cjs');
const { projectValueEvidence, projectValueColumns } = require('../electron/restore-selection-values.cjs');
const { RestoreSelectionInventory, previewRestoreSelection } = require('../electron/restore-selection.cjs');
const { assertStatementScope } = require('../electron/sql-script.cjs');
const { normalizeColumnType } = require('../electron/restore-selection-columns.cjs');
const { buildSelectionDraft } = require('../electron/restore-selection-plan.cjs');

function fixture(type, values, targetType = type, charset = 'utf8mb4', targetCharset = charset) {
  const collector = new RestoreSelectionInventory('demo');
  [`CREATE TABLE \`items\` (\`value\` ${type} CHARACTER SET ${charset}) ENGINE=InnoDB`,
    ...values.map(value => `INSERT INTO items VALUES(${value})`)].forEach((sql, index) => collector.add(sql, assertStatementScope(sql, 'demo'), index + 1));
  const inventory = collector.finish(), source = previewRestoreSelection(inventory, { tables: ['items'], includeStructure: false });
  const columns = structuredClone(source.rows[0].columnSchema.columns);
  Object.assign(columns[0], normalizeColumnType(targetType), { charset: targetCharset });
  const targetReview = { canExecute: false, snapshotId: 'a'.repeat(64), database: 'demo', lowerCaseTableNames: 0, findings: [],
    metadataStatus: { complete: true, databaseVisible: true }, rows: [{ name: 'items', objects: [{ name: 'items', type: 'table' }], objectCount: 1,
      columnReview: { findings: [], truncated: false }, valueColumns: projectValueColumns(columns, true) }] };
  const build = () => buildSelectionDraft({ inventory, source, targetReview, checksum: 'b'.repeat(64), targetIdentity: 'c'.repeat(64) });
  return { inventory, targetReview, build };
}

test('counts Unicode scalars and UTF8 bytes, handles doubled quotes/empty text and retains no contents', () => {
  const body = "a😀e\u0301'' ", shape = reviewTextLiteral(body, 0, body.length);
  assert.deepEqual(shape, { characters: 6, utf8Bytes: 10, ascii: false, bmp: false, wellFormed: true, trailingSpace: true });
  assert.deepEqual(reviewTextLiteral('', 0, 0), { characters: 0, utf8Bytes: 0, ascii: true, bmp: true, wellFormed: true, trailingSpace: false });
  assert.equal(reviewTextLiteral('\ud800', 0, 1).wellFormed, false);
  for (const [value, start, end] of [["a'b", 0, 3], ['a\\n', 0, 3], ['a', -1, 1], ['a', 0, 2], ['a', 1, 0]]) assert.equal(reviewTextLiteral(value, start, end), null);
  const sql = "INSERT INTO items VALUES('private-value'),('a''b'),('😀'),(NULL),(X'ff'),('123')";
  const syntax = reviewLiteralInsert(sql, { collectValues: true });
  assert.equal(syntax.valueReview.version, 7); assert.equal(syntax.valueReview.fields[0].text.count, 4);
  assert.equal(syntax.valueReview.fields[0].text.maxCharacters, 13); assert.equal(syntax.valueReview.fields[0].text.bmp, false);
  assert.equal(JSON.stringify(syntax).includes('private-value'), false); assert.equal(JSON.stringify(syntax).includes('😀'), false);
  assert.equal(reviewLiteralInsert("INSERT INTO items VALUES('a\\n')", { collectValues: true }).status, 'unsupported');
});

test('VARCHAR counts code points rather than UTF16 units or graphemes, with independent target limits', () => {
  const result = fixture('VARCHAR(5)', ["'😀😀'", "'é'", "'123'", "''"], 'varchar(1)').build();
  assert.deepEqual(result.valueReview.rows.map(row => row.status), ['issues', 'issues', 'issues', 'basic-checked']);
  assert.ok(result.valueReview.rows[0].fields[0].target.findings.includes('VALUE_TEXT_TOO_LONG'));
  assert.equal(result.valueReview.rows[0].fields[0].source.status, 'basic-checked');
  const exact = fixture('VARCHAR(2)', ["'😀😀'", "'é'", "'a''b'"]).build();
  assert.deepEqual(exact.valueReview.rows.map(row => row.status), ['basic-checked', 'basic-checked', 'issues']);
  assert.equal(fixture('VARCHAR(10)', ['123']).build().valueReview.rows[0].status, 'unknown');
});

test('TEXT uses encoded byte limits; unsupported charset and Unicode representations remain explicit', () => {
  const input = fixture('TEXT', [`'${'é'.repeat(128)}'`, `'${'x'.repeat(255)}'`, `'${'x'.repeat(256)}'`], 'tinytext');
  assert.deepEqual(input.build().valueReview.rows.map(row => row.status), ['issues', 'basic-checked', 'issues']);
  assert.equal(fixture('VARCHAR(10)', ["'😀'"], 'varchar(10)', 'utf8mb4', 'utf8mb3').build().valueReview.rows[0].status, 'issues');
  const ascii = fixture('VARCHAR(10)', ["'Việt'"], 'varchar(10)', 'utf8mb4', 'ascii').build();
  assert.ok(ascii.valueReview.rows[0].fields[0].target.findings.includes('VALUE_TEXT_CHARSET_LOSS'));
  assert.equal(fixture('VARCHAR(10)', ["'ascii'"], 'varchar(10)', 'utf8mb4', 'ascii').build().valueReview.rows[0].status, 'basic-checked');
  for (const charset of [null, 'latin1', 'binary', 'utf8']) assert.equal(fixture('VARCHAR(10)', ["'ascii'"], 'varchar(10)', 'utf8mb4', charset).build().valueReview.rows[0].status, 'unknown');
  const invalid = fixture('VARCHAR(10)', ["'\ud800'"]).build();
  assert.ok(invalid.valueReview.rows[0].fields[0].target.findings.includes('VALUE_TEXT_ENCODING_NOT_REVIEWED'));
});

test('CHAR padding and trailing spaces stay reviewed while VARCHAR/TEXT preserve them in local checks', () => {
  const result = fixture('CHAR(5)', ["'abc'", "'abc '"]).build();
  assert.deepEqual(result.valueReview.rows.map(row => row.status), ['unknown', 'issues']);
  assert.ok(result.valueReview.rows[0].fields[0].target.findings.includes('VALUE_CHAR_PADDING_NOT_REVIEWED'));
  assert.ok(result.valueReview.rows[1].fields[0].target.findings.includes('VALUE_CHAR_TRAILING_SPACES'));
  assert.equal(fixture('VARCHAR(5)', ["'abc '"]).build().valueReview.rows[0].status, 'basic-checked');
  assert.equal(fixture('TEXT', ["'abc '"]).build().valueReview.rows[0].status, 'basic-checked');
});

test('projection validates profiles, numeric-string subset and byte/character consistency, stripping private values', () => {
  const syntax = reviewLiteralInsert("INSERT INTO items VALUES('123'),('😀'),(1.25)", { collectValues: true });
  const field = syntax.valueReview.fields[0];
  for (const changes of [{ count: 0 }, { count: 3 }, { maxCharacters: -1 }, { maxUtf8Bytes: 2 }, { ascii: true }, { trailingSpaces: 3 }, { bmp: null },
    { bmp: true, maxCharacters: 1, maxUtf8Bytes: 4 }]) assert.equal(projectText({ ...field.text, ...changes }, field), null);
  assert.deepEqual(projectText({ ...field.text, rawText: 'private' }, field), field.text);
  const missing = structuredClone(syntax.valueReview); delete missing.fields[0].text;
  assert.equal(projectValueEvidence(missing, syntax), null);
  const legacy = structuredClone(syntax.valueReview); legacy.version = 3; delete legacy.fields[0].text; delete legacy.fields[0].temporal; delete legacy.fields[0].year;
  assert.deepEqual(projectValueEvidence(legacy, syntax), legacy);
  const old = fixture('VARCHAR(10)', ["'plain'"]);
  old.inventory.statementLedger.entries[1].syntaxReview.valueReview.version = 3;
  delete old.inventory.statementLedger.entries[1].syntaxReview.valueReview.fields[0].text;
  assert.equal(old.build().valueReview.rows[0].status, 'unknown');
});

test('long text profiles stay bounded, reports freeze/bind observations and known loss blocks INSERT without execution', () => {
  const body = 'é'.repeat(100000), syntax = reviewLiteralInsert(`INSERT INTO items VALUES('${body}')`, { collectValues: true });
  assert.equal(syntax.valueReview.fields[0].text.maxCharacters, 100000); assert.equal(syntax.valueReview.fields[0].text.maxUtf8Bytes, 200000);
  assert.ok(JSON.stringify(syntax).length < 1500);
  const larger = reviewLiteralInsert(`INSERT INTO items VALUES('${body + body}')`, { collectValues: true });
  assert.ok(Math.abs(JSON.stringify(larger).length - JSON.stringify(syntax).length) < 20);
  const input = fixture('VARCHAR(10)', ["'😀'"]), initial = input.build();
  assert.equal(initial.version, 29); assert.equal(initial.valueReview.version, 8); assert.equal(initial.canExecute, false);
  assert.equal(Object.isFrozen(initial.valueReview.rows[0].fields[0]), true);
  input.targetReview.rows[0].valueColumns.columns[0].charset = 'ascii';
  const changed = input.build(); assert.notEqual(initial.planId, changed.planId);
  assert.equal(changed.steps[1].reason, 'VALUE_BASIC_ISSUES'); assert.equal(changed.steps[1].decision, 'blocked');
  assert.ok(changed.blockers.some(item => item.code === 'VALUE_FULL_VALIDATION_REQUIRED'));
});
