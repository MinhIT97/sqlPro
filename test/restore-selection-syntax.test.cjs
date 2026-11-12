'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewLiteralInsert } = require('../electron/restore-selection-syntax.cjs');
const { RestoreSelectionInventory } = require('../electron/restore-selection.cjs');
const { assertStatementScope } = require('../electron/sql-script.cjs');

test('literal INSERT recognizes exact names and explicit tuple shape without retaining values', () => {
  const sql = "INSERT INTO `demo`.` a.``b ` (`ID`, `text`) VALUES (12345678901234567890.1234567890,'private-value ''quoted'''),(-1e-10,'NULL /* comment */');";
  assert.deepEqual(reviewLiteralInsert(sql), { version: 1, status: 'matched', code: 'LITERAL_INSERT_MATCHED', table: ' a.`b ', schema: 'demo', rows: 2, valuesPerRow: 2, columnMode: 'explicit' });
  assert.equal(JSON.stringify(reviewLiteralInsert(sql)).includes('private-value'), false);
  assert.equal(JSON.stringify(reviewLiteralInsert(sql)).includes('12345678901234567890'), false);
});

test('positional literal grammar supports NULL, booleans, signed numbers, exponent, hex and bits', () => {
  for (const value of ['NULL', 'TRUE', 'FALSE', '+1', '-.25', '1.2e-10', '0xabc', '0b001', "X'00ff'", "x''", "B'1010'", "''", "'Việt Nam; -- /* */'"]) {
    const result = reviewLiteralInsert(`INSERT INTO items VALUES (${value})`);
    assert.equal(result.status, 'matched', value); assert.equal(result.columnMode, 'positional');
    assert.equal(result.valuesPerRow, 1); assert.equal(result.rows, 1);
  }
});

test('expressions, functions, variables, subqueries, DEFAULT and appended operations are unsupported', () => {
  for (const value of ['NOW()', '`udf`()', '(SELECT 1)', '1+2', "CONCAT('a','b')", '@variable', 'DEFAULT', 'CURRENT_TIMESTAMP', "'a' COLLATE utf8mb4_bin", "_utf8mb4'a'", "N'a'", "'a' 'b'", '++1', '-0x1']) {
    assert.equal(reviewLiteralInsert(`INSERT INTO items VALUES (${value})`).status, 'unsupported', value);
  }
  for (const sql of ['INSERT INTO items SELECT 1', 'INSERT INTO items SET id=1', 'INSERT IGNORE INTO items VALUES(1)', 'INSERT LOW_PRIORITY INTO items VALUES(1)',
    'INSERT items VALUES(1)', 'REPLACE INTO items VALUES(1)', 'INSERT INTO items VALUES(1) ON DUPLICATE KEY UPDATE id=2',
    'INSERT INTO items VALUES(1) RETURNING id', 'INSERT INTO items VALUES(1); DROP TABLE other;', 'INSERT INTO items VALUES ROW(1)']) {
    assert.equal(reviewLiteralInsert(sql).status, 'unsupported', sql);
  }
});

test('ambiguous quoting, comments, malformed strings, invalid binary/hex and NUL never match', () => {
  for (const sql of ["INSERT INTO items VALUES('a\\n')", 'INSERT INTO items VALUES("text")', 'INSERT INTO "items" VALUES(1)',
    '/*!80000 INSERT INTO items VALUES(1) */', 'INSERT /* ordinary */ INTO items VALUES(1)', 'INSERT INTO items VALUES(1)-- comment',
    'INSERT INTO items VALUES(1)# comment', 'INSERT INTO items VALUES(1)/*M! UPDATE items SET id=2 */',
    "INSERT INTO items VALUES('unterminated)", "INSERT INTO items VALUES(X'f')", "INSERT INTO items VALUES(B'102')", "INSERT INTO items VALUES(B'')",
    'INSERT INTO items VALUES(0x)', 'INSERT INTO items VALUES(0b2)', 'INSERT INTO items VALUES(1e)', 'INSERT INTO items VALUES(1.2.3)',
    "INSERT INTO items VALUES('a\0b')", 'INSERT INTO `back\\slash` VALUES(1)', 'INSERT\u00a0INTO items VALUES(1)']) assert.equal(reviewLiteralInsert(sql).status, 'unsupported', sql);
});

test('column lists and every VALUES tuple require consistent nonempty arity', () => {
  for (const sql of ['INSERT INTO items(id,name) VALUES(1)', 'INSERT INTO items VALUES(1),(2,3)', 'INSERT INTO items(id,ID) VALUES(1,2)',
    'INSERT INTO items() VALUES()', 'INSERT INTO items VALUES()', 'INSERT INTO items(id,) VALUES(1)', 'INSERT INTO items VALUES(1,)', 'INSERT INTO items VALUES(1),',
    'INSERT INTO items(a.b) VALUES(1)']) assert.equal(reviewLiteralInsert(sql).status, 'unsupported', sql);
  assert.equal(reviewLiteralInsert('INSERT INTO `bảng` (`a,``b`, `select`) VALUES(1,2)').status, 'matched');
  assert.equal(reviewLiteralInsert('INSERT INTO `db`.`items`.`other` VALUES(1)').status, 'unsupported');
});

test('byte, name, column and row quotas return a bounded unknown report', () => {
  for (const sql of [`INSERT INTO items VALUES('${'x'.repeat(2 * 1024 * 1024)}')`, `INSERT INTO items VALUES('${'ự'.repeat(800000)}')`,
    `INSERT INTO \`${'a'.repeat(65)}\` VALUES(1)`, `INSERT INTO items VALUES(${Array(257).fill('1').join(',')})`,
    `INSERT INTO items VALUES${Array(10001).fill('(1)').join(',')}`]) {
    const result = reviewLiteralInsert(sql);
    assert.equal(result.status, 'unsupported'); assert.ok(JSON.stringify(result).length < 150);
  }
  assert.equal(reviewLiteralInsert(null).status, 'unsupported');
});

test('collector validates original SQL, attaches no values and stops at the per-file syntax budget', () => {
  const collector = new RestoreSelectionInventory('demo');
  for (const [index, sql] of ["INSERT INTO items VALUES('secret-row')", 'INSERT INTO items VALUES(NOW())'].entries()) collector.add(sql, assertStatementScope(sql, 'demo'), index + 1);
  assert.equal(collector.finish().statementLedger.entries[0].syntaxReview.status, 'matched');
  assert.equal(collector.finish().statementLedger.entries[1].syntaxReview.status, 'unsupported');
  collector.literalValidationBytes = 32 * 1024 * 1024;
  collector.add('INSERT INTO items VALUES(1)', assertStatementScope('INSERT INTO items VALUES(1)', 'demo'), 3);
  assert.equal(collector.finish().statementLedger.entries[2].syntaxReview.code, 'INSERT_VALIDATION_LIMIT');
  assert.equal(JSON.stringify(collector.finish()).includes('secret-row'), false);
});
