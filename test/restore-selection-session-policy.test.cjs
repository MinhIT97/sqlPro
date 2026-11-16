'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSessionSettings, projectSessionSettings, buildSelectionSessionPolicy } = require('../electron/restore-selection-session-policy.cjs');
const { reviewDumpContext } = require('../electron/restore-selection-context.cjs');
const settings = (changes = {}) => ({ foreignKeyChecks: 1, uniqueChecks: 1, autocommit: 1, sqlMode: 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION',
  charsetClient: 'utf8mb4', charsetConnection: 'utf8mb4', charsetResults: 'utf8mb4', ...changes });
function fixture() {
  const sql = ['SET NAMES utf8mb4', 'SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0',
    "SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO'", null, 'SET SQL_MODE=@OLD_SQL_MODE', 'SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS'];
  return { ledger: { version: 1, total: sql.length, truncated: false, entries: sql.map((text, index) => text
    ? { number: index + 1, kind: 'context', command: 'SET', contextReview: reviewDumpContext(text) }
    : { number: index + 1, kind: 'structure', command: 'CREATE', table: 'items' }) },
  source: { unresolvedOrder: [] }, targetReview: { sessionSettings: normalizeSessionSettings(settings()) } };
}

test('normalizes exact bounded settings, canonicalizes mode order and strips unknown flags and private fields', () => {
  const normalized = normalizeSessionSettings(settings({ sqlMode: 'STRICT_TRANS_TABLES,PRIVATE_FLAG', secret: 'private-value' }));
  assert.deepEqual(normalized.sqlMode.flags, ['STRICT_TRANS_TABLES']); assert.equal(normalized.sqlMode.unreviewedCount, 1);
  assert.equal(JSON.stringify(normalized).includes('PRIVATE_FLAG'), false); assert.equal(JSON.stringify(normalized).includes('private-value'), false);
  assert.deepEqual(projectSessionSettings({ ...normalized, rawSql: 'private-sql' }), normalized);
  assert.equal(normalizeSessionSettings(settings({ sqlMode: 'NO_ENGINE_SUBSTITUTION,STRICT_TRANS_TABLES' })).sqlMode.fingerprint,
    normalizeSessionSettings(settings()).sqlMode.fingerprint);
  for (const changes of [{ foreignKeyChecks: true }, { autocommit: null }, { sqlMode: null }, { sqlMode: 'A,A' }, { sqlMode: 'a'.repeat(4097) },
    { sqlMode: "'private-mode'" }, { sqlMode: 'STRICT_TRANS_TABLES;SELECT' }, { charsetClient: 'utf8mb4;sql' }, { charsetResults: null }]) assert.equal(normalizeSessionSettings(settings(changes)), null);
  const invalid = normalizeSessionSettings(settings()); invalid.sqlMode.fingerprint = 'a'.repeat(64);
  assert.equal(projectSessionSettings(invalid), null);
});

test('proposes preserved strict mode plus zero flag and enabled FK checks, never raw SET execution', () => {
  const input = fixture(), before = structuredClone(input), report = buildSelectionSessionPolicy(input);
  assert.equal(report.canExecute, false); assert.equal(report.status, 'blocked'); assert.equal(report.foreignKeys, 'keep-enabled');
  assert.deepEqual(report.findings, []); assert.equal(report.actions.length, 5);
  assert.deepEqual(report.proposedMode.flags, ['NO_AUTO_VALUE_ON_ZERO', 'NO_ENGINE_SUBSTITUTION', 'STRICT_TRANS_TABLES']);
  assert.equal(report.proposedMode.changed, true); assert.equal(report.observations.sqlMode.flags.includes('NO_AUTO_VALUE_ON_ZERO'), false);
  assert.equal(report.actions[1].proposal, 'keep-foreign-key-checks-enabled');
  assert.equal(report.rollbackAllDdlGuaranteed, false); assert.equal(report.failurePolicy, 'stop-report-partial-never-auto-retry');
  assert.ok(report.requires.includes('SESSION_EXECUTION_NOT_IMPLEMENTED')); assert.ok(report.lifecycle.includes('restore-captured-settings-in-finally'));
  assert.equal(JSON.stringify(report).includes('SET '), false); assert.deepEqual(input, before);
});

test('disabled FK/autocommit, non-UTF8MB4, unknown modes, weak mode and unresolved order retain findings', () => {
  for (const [changes, code] of [[{ foreignKeyChecks: 0 }, 'SESSION_FK_CHECKS_DISABLED'], [{ autocommit: 0 }, 'SESSION_AUTOCOMMIT_DISABLED'],
    [{ charsetResults: 'latin1' }, 'SESSION_CHARSET_REQUIRES_REVIEW'], [{ sqlMode: 'STRICT_TRANS_TABLES,UNKNOWN_FLAG' }, 'SESSION_SQL_MODE_FLAGS_NOT_REVIEWED'],
    [{ sqlMode: '' }, 'SESSION_STRICT_MODE_NOT_ENABLED']]) {
    const input = fixture(); input.targetReview.sessionSettings = normalizeSessionSettings(settings(changes));
    const report = buildSelectionSessionPolicy(input); assert.ok(report.findings.some(finding => finding.code === code)); assert.equal(report.canExecute, false);
    if (code === 'SESSION_SQL_MODE_FLAGS_NOT_REVIEWED') assert.equal(report.proposedMode, null);
  }
  const input = fixture(); input.source.unresolvedOrder = ['items'];
  assert.ok(buildSelectionSessionPolicy(input).findings.some(finding => finding.code === 'SESSION_DEPENDENCY_ORDER_NOT_PROVEN'));
});

test('old/forged target settings, missing context, malformed sequence, quotas and absent SET stay explicit', () => {
  const old = fixture(); old.targetReview.sessionSettings.version = 0;
  assert.equal(buildSelectionSessionPolicy(old).observations, null); assert.equal(buildSelectionSessionPolicy(old).proposedMode, null);
  for (const change of [r => { r.ledger.truncated = true; }, r => { r.ledger.entries[0].number = 90; },
    r => { r.ledger.entries[0].contextReview.action = 'private-action'; }, r => { r.ledger.entries.splice(4, 1); }, r => { r.ledger = null; }]) {
    const input = fixture(); change(input);
    const report = buildSelectionSessionPolicy(input); assert.ok(report.findings.some(finding => finding.code === 'SESSION_CONTEXT_REQUIRES_REVIEW'));
    assert.equal(JSON.stringify(report).includes('private-action'), false); assert.equal(report.canExecute, false);
  }
  const noContext = fixture(); noContext.ledger.entries = [noContext.ledger.entries[3]]; noContext.ledger.entries[0].number = 1; noContext.ledger.total = 1;
  const report = buildSelectionSessionPolicy(noContext); assert.equal(report.contextPresent, false); assert.equal(report.proposedMode.changed, false);
  const many = fixture(); many.ledger.entries = Array.from({ length: 60 }, (_, index) => ({ ...many.ledger.entries[0], number: index + 1 })); many.ledger.total = 60;
  assert.equal(buildSelectionSessionPolicy(many).actions.length, 50); assert.ok(buildSelectionSessionPolicy(many).findings.some(finding => finding.code === 'SESSION_ACTION_LIMIT'));
});

test('unique_checks accepts only observed binary values and keeps missing/legacy metadata unknown', () => {
  for (const value of [0, 1, '0', '1']) {
    const normalized = normalizeSessionSettings(settings({ uniqueChecks: value }));
    assert.equal(normalized.version, 2); assert.equal(normalized.uniqueChecks, Number(value) === 1);
    assert.deepEqual(projectSessionSettings({ ...normalized, private: 'secret' }), normalized);
  }
  for (const value of [true, false, null, '', 'ON', '1suffix', '1\n', -1, 2, [], {}]) {
    assert.equal(normalizeSessionSettings(settings({ uniqueChecks: value })), null);
  }
  for (const value of [undefined, '', 'ON', '0', '1', 0, 1, -1, 2, [], {}]) {
    assert.equal(projectSessionSettings({ ...normalizeSessionSettings(settings()), uniqueChecks: value }), null);
  }
  const missing = settings(); delete missing.uniqueChecks;
  const normalized = normalizeSessionSettings(missing);
  assert.equal(normalized.uniqueChecks, null); assert.deepEqual(projectSessionSettings(normalized), normalized);
  const legacy = { ...normalizeSessionSettings(settings()), version: 1, uniqueChecks: true };
  assert.equal(projectSessionSettings(legacy).uniqueChecks, null);
  const forged = { ...normalizeSessionSettings(settings()) }; delete forged.uniqueChecks;
  assert.equal(projectSessionSettings(forged), null);
});

test('disabled and unknown unique checks retain explicit findings and never become duplicate-data validation', () => {
  for (const [value, code] of [[false, 'SESSION_UNIQUE_CHECKS_DISABLED'], [null, 'SESSION_UNIQUE_CHECKS_NOT_REVIEWED']]) {
    const input = fixture(); input.targetReview.sessionSettings.uniqueChecks = value;
    const before = structuredClone(input), report = buildSelectionSessionPolicy(input);
    assert.equal(report.version, 2); assert.equal(report.uniqueChecks, 'keep-enabled');
    assert.ok(report.findings.some(item => item.code === code));
    assert.ok(report.requires.includes('SESSION_UNIQUE_DATA_NOT_VALIDATED'));
    assert.ok(report.requires.includes('SESSION_UNIQUE_CHECKS_RECHECK_REQUIRED'));
    assert.ok(report.lifecycle.includes('verify-unique-checks-enabled'));
    assert.equal(report.canExecute, false); assert.deepEqual(input, before);
  }
  const legacy = fixture(); legacy.targetReview.sessionSettings.version = 1;
  assert.ok(buildSelectionSessionPolicy(legacy).findings.some(item => item.code === 'SESSION_UNIQUE_CHECKS_NOT_REVIEWED'));
  const observed = buildSelectionSessionPolicy(fixture());
  assert.equal(observed.observations.uniqueChecks, true); assert.deepEqual(observed.findings, []);
  assert.ok(observed.requires.includes('SESSION_UNIQUE_DATA_NOT_VALIDATED'));
});
