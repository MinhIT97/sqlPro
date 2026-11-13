'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewDumpContext, projectContextReview, reviewContextSequence } = require('../electron/restore-selection-context.cjs');
const { RestoreSelectionInventory } = require('../electron/restore-selection.cjs');
const { SqlScriptParser, assertStatementScope } = require('../electron/sql-script.cjs');
const HEADER = ['SET NAMES utf8mb4;', 'SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0;', "SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO';"];
const FOOTER = ['SET SQL_MODE=@OLD_SQL_MODE;', 'SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS;'];
const body = 'CREATE TABLE `items` (`id` int) ENGINE=InnoDB;';
function ledger(statements) {
  const collector = new RestoreSelectionInventory('demo'), parser = new SqlScriptParser();
  for (const [index, sql] of [...parser.push(statements.join('\n')), ...parser.end()].entries()) collector.add(sql, assertStatementScope(sql, 'demo'), index + 1);
  return collector.finish().statementLedger;
}

test('context recognizes only native dump forms with bounded metadata and ASCII whitespace/case variants', () => {
  const actions = ['set-names-utf8mb4', 'save-disable-foreign-keys', 'save-set-sql-mode', 'restore-sql-mode', 'restore-foreign-keys'];
  for (const [index, sql] of [...HEADER, ...FOOTER].entries()) {
    assert.deepEqual(reviewDumpContext(sql), { version: 1, status: 'matched', code: 'DUMP_CONTEXT_MATCHED', action: actions[index] });
  }
  assert.equal(reviewDumpContext(" \nset\tnames\r\nUTF8MB4 ; \n").status, 'matched');
  assert.equal(reviewDumpContext("set @old_sql_mode = @@sql_mode , sql_mode = 'no_auto_value_on_zero'").status, 'matched');
});

test('context rejects globals, altered captures, expressions, SQL modes, additional settings and appended SQL', () => {
  for (const sql of ['SET GLOBAL FOREIGN_KEY_CHECKS=0', 'SET @@GLOBAL.sql_mode=\'NO_AUTO_VALUE_ON_ZERO\'', 'SET PERSIST sql_mode=\'\'',
    'SET FOREIGN_KEY_CHECKS=0', 'SET FOREIGN_KEY_CHECKS=1', 'SET @OLD_FOREIGN_KEY_CHECKS=@@GLOBAL.FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0',
    'SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=udf()', 'SET @OTHER=@@SQL_MODE, SQL_MODE=\'NO_AUTO_VALUE_ON_ZERO\'',
    "SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='ANSI_QUOTES'", "SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO,ANSI_QUOTES'",
    'SET SQL_MODE=(SELECT value FROM secrets)', 'SET SQL_MODE=@OTHER', 'SET @secret=udf()', 'SET AUTOCOMMIT=0', 'SET UNIQUE_CHECKS=0',
    'SET NAMES latin1', 'SET NAMES utf8mb4 COLLATE utf8mb4_bin', 'SET NAMES utf8mb4; DROP TABLE items', 'SET NAMES utf8mb4;;',
    'SET SQL_MODE=@OLD_SQL_MODE, SQL_NOTES=0', 'SET NAMES utf8mb4 INTO OUTFILE \'/secret\'']) {
    assert.equal(reviewDumpContext(sql).status, 'unsupported', sql);
  }
});

test('comments, ambiguous quoting, Unicode whitespace, escapes and transaction controls remain unsupported', () => {
  for (const sql of ['/*!80000 SET NAMES utf8mb4 */', 'SET /* ordinary */ NAMES utf8mb4', 'SET NAMES utf8mb4-- comment',
    'SET NAMES utf8mb4#comment', 'SET NAMES "utf8mb4"', 'SET NAMES `utf8mb4`', 'SET\u00a0NAMES utf8mb4', '\u00a0SET NAMES utf8mb4',
    "SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO\\'", 'SET NAMES utf8mb4\0', 'BEGIN', 'START TRANSACTION', 'COMMIT', 'ROLLBACK', 'UNLOCK TABLES']) {
    assert.equal(reviewDumpContext(sql).status, 'unsupported', sql);
  }
  assert.equal(reviewDumpContext('COMMIT').code, 'CONTEXT_TRANSACTION_UNSUPPORTED');
  for (const sql of [null, 'SET NAMES ' + 'x'.repeat(16385)]) assert.ok(JSON.stringify(reviewDumpContext(sql)).length < 150);
});

test('sequence covers the whole ledger, keeps effects visible and never authorizes execution', () => {
  const data = ledger([...HEADER, body, 'INSERT INTO items VALUES(1);', ...FOOTER]);
  const report = reviewContextSequence(data);
  assert.equal(report.total, 5); assert.equal(report.matched, 5); assert.equal(report.sequenceMatched, true);
  assert.deepEqual(report.findings, []); assert.equal(report.canExecute, false); assert.equal(report.requiresDedicatedSession, true);
  assert.equal(report.foreignKeyRecheckRequired, true); assert.equal(report.sqlModeReviewRequired, true);
  assert.equal(JSON.stringify(report).includes('NO_AUTO_VALUE_ON_ZERO'), false);
  assert.equal(JSON.stringify(report).includes('SET '), false);
});

test('missing saves/restores, reverse-order mistakes, duplicate actions and context after data are reported', () => {
  const cases = [
    [[...HEADER, body], 'CONTEXT_SETTINGS_NOT_RESTORED'],
    [[FOOTER[0], body], 'CONTEXT_RESTORE_WITHOUT_SAVE'],
    [[...HEADER, body, FOOTER[1], FOOTER[0]], 'CONTEXT_RESTORE_ORDER'],
    [[HEADER[0], HEADER[0], body], 'CONTEXT_DUPLICATE_ACTION'],
    [[...HEADER, body, ...FOOTER, 'INSERT INTO items VALUES(1);'], 'CONTEXT_BODY_AFTER_RESTORE'],
    [[body, ...HEADER, ...FOOTER], 'CONTEXT_HEADER_AFTER_BODY'],
    [[...HEADER, body, 'SET @secret=1;', ...FOOTER], 'CONTEXT_SET_UNSUPPORTED'],
    [[body, 'COMMIT;'], 'CONTEXT_TRANSACTION_UNSUPPORTED']
  ];
  for (const [statements, code] of cases) {
    const report = reviewContextSequence(ledger(statements));
    assert.equal(report.sequenceMatched, false, code); assert.ok(report.findings.some(item => item.code === code), code);
  }
});

test('missing/forged reviews, gaps and truncated ledgers fail closed and findings stay bounded', () => {
  const data = ledger([...HEADER, body, ...FOOTER]);
  const original = data.entries[0].contextReview;
  original.rawSql = 'private-sql'; original.value = 'private-value';
  assert.equal(JSON.stringify(projectContextReview(data.entries[0])).includes('private-'), false);
  original.action = '<img src=x>';
  assert.equal(projectContextReview(data.entries[0]), null);
  assert.equal(reviewContextSequence(data).notReviewed, 1);
  data.entries[0].contextReview = { version: 1, status: 'matched', code: 'DUMP_CONTEXT_MATCHED', action: 'set-names-utf8mb4' };
  data.entries[0].command = 'COMMIT'; assert.equal(projectContextReview(data.entries[0]), null);
  for (const change of [value => { delete value.entries[1].contextReview; }, value => { value.entries[1].number = 99; }, value => { value.truncated = true; },
    value => { value.entries[1].kind = 'unclassified'; }]) {
    const copy = ledger([...HEADER, body, ...FOOTER]); change(copy); assert.equal(reviewContextSequence(copy).sequenceMatched, false);
  }
  const bounded = reviewContextSequence(ledger(Array(100).fill('SET @secret=1;')));
  assert.equal(bounded.findings.length, 50); assert.equal(bounded.findingsTruncated, true);
  assert.equal(reviewContextSequence(null).sequenceMatched, false);
  assert.equal(reviewContextSequence(ledger([body])).sequenceMatched, false);
  const oversized = ledger([...HEADER, body, ...FOOTER]);
  while (oversized.entries.length <= 10000) oversized.entries.push({ number: oversized.entries.length + 1, kind: 'skipped', command: 'DIRECTIVE' });
  oversized.total = 10000;
  assert.ok(reviewContextSequence(oversized).findings.some(item => item.code === 'CONTEXT_LEDGER_INCOMPLETE'));
});

test('collector shares syntax budget with INSERT/CREATE and never stores unknown SET values', () => {
  const collector = new RestoreSelectionInventory('demo');
  const sql = "SET @private_name='private-value';";
  collector.add(sql, assertStatementScope(sql, 'demo'), 1);
  assert.equal(collector.finish().statementLedger.entries[0].contextReview.status, 'unsupported');
  assert.equal(JSON.stringify(collector.finish()).includes('private-'), false);
  collector.syntaxValidationBytes = 32 * 1024 * 1024;
  const names = HEADER[0].replace(/;$/, '');
  collector.add(names, assertStatementScope(names, 'demo'), 2);
  assert.equal(collector.finish().statementLedger.entries[1].contextReview.code, 'CONTEXT_VALIDATION_LIMIT');
});
