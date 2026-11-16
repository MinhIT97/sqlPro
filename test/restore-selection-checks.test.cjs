'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewTargetChecks, collectCheckSessionSettings, projectCheckSessionSettings } = require('../electron/restore-selection-checks.cjs');
const { collectSelectionTargetFacts, buildSelectionTargetPreview } = require('../electron/restore-selection-target.cjs');
const { RestoreSelectionInventory, previewRestoreSelection } = require('../electron/restore-selection.cjs');
const { assertStatementScope } = require('../electron/sql-script.cjs');
const { buildSelectionDraft } = require('../electron/restore-selection-plan.cjs');

const capabilityRows = tableColumn => ['CONSTRAINT_SCHEMA', 'CONSTRAINT_NAME', 'CHECK_CLAUSE', ...(tableColumn ? ['TABLE_NAME'] : [])]
  .map(name => ({ tableName: 'CHECK_CONSTRAINTS', name }));
const check = changes => ({ constraintSchema: 'demo', tableSchema: 'demo', table: 'items', name: 'positive',
  clauseDigest: 'c'.repeat(64), declaredEnforcement: 'yes', ...changes });
function facts(changes = {}) {
  return { database: 'demo', databaseVisible: true, lowerCaseTableNames: 0, errors: [], truncated: [],
    objects: [{ name: 'items', type: 'table' }], checks: [check()],
    checkCapabilities: { version: 1, status: 'observed', tableColumn: false, enforcedColumn: true }, ...changes };
}
const report = input => reviewTargetChecks(input, ['items']);

test('CHECK report distinguishes observed metadata from validated data and never retains expression/digest fields', () => {
  const input = facts(); input.checks[0].expression = 'private-check-expression';
  const before = structuredClone(input), result = report(input);
  assert.equal(result.canExecute, false); assert.equal(result.complete, true); assert.deepEqual(result.totals, { observed: 1, unknown: 0 });
  assert.equal(result.rows[0].status, 'requires-review'); assert.equal(result.rows[0].declaredEnforcement, 'yes');
  assert.equal(result.rows[0].reason, 'TARGET_CHECK_DATA_NOT_VALIDATED');
  assert.equal(JSON.stringify(result).includes('private'), false); assert.equal(JSON.stringify(result).includes('c'.repeat(64)), false);
  assert.deepEqual(input, before);
  const maria = facts({ checkCapabilities: { version: 1, status: 'observed', tableColumn: true, enforcedColumn: false } });
  assert.equal(report(maria).rows[0].declaredEnforcement, 'unknown');
});

test('missing capability/definitions, malformed metadata, duplicates and visibility failures cannot certify even an empty set', () => {
  for (const changes of [{ checkCapabilities: null }, { checks: null }, { checks: {} }, { checks: [check({ clauseDigest: null })] },
    { databaseVisible: false }, { lowerCaseTableNames: null }, { errors: [{ section: 'checks', code: 'DENIED' }] }, { truncated: ['checks'] },
    { checks: [check(), check()] }, { checks: [check({ clauseDigest: 'malformed' })] }, { objects: [] }]) {
    const result = report(facts(changes));
    assert.equal(result.complete, false); assert.equal(result.totals.observed, 0); assert.ok(result.rows.every(row => row.status === 'unknown'));
    assert.ok(result.findings.includes('TARGET_CHECK_METADATA_INCOMPLETE'));
  }
  assert.equal(report(facts({ checks: [] })).complete, true);
  assert.equal(report(facts({ checks: [], checkCapabilities: null })).complete, false);
});

test('CHECK identities preserve schema/table boundaries, respect observed case policy, and reject schema leakage', () => {
  const input = facts({ checks: [check({ table: 'ITEMS' })], objects: [{ name: 'ITEMS', type: 'table' }], lowerCaseTableNames: 1 });
  assert.equal(report(input).totals.observed, 1);
  input.lowerCaseTableNames = 0; assert.equal(report(input).rows.length, 0);
  const foreign = report(facts({ checks: [check({ constraintSchema: 'other' })] }));
  assert.equal(foreign.complete, false); assert.ok(foreign.findings.includes('TARGET_CHECK_SCHEMA_MISMATCH')); assert.equal(foreign.rows.length, 0);
  const two = facts({ checks: [check(), check({ table: 'a.b' })], objects: [{ name: 'items', type: 'table' }, { name: 'a.b', type: 'table' }] });
  assert.equal(reviewTargetChecks(two, ['items', 'a.b']).totals.observed, 2);
});

test('CHECK analysis and report quotas remain explicit rather than dropping unknown work', () => {
  const rows = Array.from({ length: 201 }, (_, i) => check({ name: `c${i}` }));
  const result = report(facts({ checks: rows }));
  assert.equal(result.rows.length, 200); assert.equal(result.totals.observed, 201); assert.equal(result.truncated, true);
  assert.ok(result.findings.includes('TARGET_CHECK_REPORT_LIMIT'));
  assert.equal(report(facts({ checks: Array(2001).fill(check()) })).complete, false);
});

test('collector probes capabilities then selects only fixed identifiers and bounded hashes with parameter bindings', async () => {
  for (const tableColumn of [false, true]) {
    const queries = [], database = 'db`name', table = '<img src=table>';
    const result = await collectSelectionTargetFacts({ raw: async (sql, params, timeout) => {
      assert.match(sql, /^SELECT /); assert.equal(timeout, 10000); queries.push({ sql, params });
      if (sql.includes('AS tableName, COLUMN_NAME AS name FROM')) return { rows: [...capabilityRows(tableColumn), ...(!tableColumn ? [{ tableName: 'TABLE_CONSTRAINTS', name: 'ENFORCED' }] : [])] };
      if (sql.includes('FROM information_schema.TABLE_CONSTRAINTS t')) return { rows: [{ constraintSchema: database, tableSchema: database, tableName: table,
        name: 'constraint', clauseDigest: 'a'.repeat(64), declaredEnforcement: tableColumn ? null : 'NO', rawExpression: 'private-expression' }] };
      return { rows: [] };
    } }, database, () => {}, [table]);
    const query = queries.find(item => item.sql.includes('FROM information_schema.TABLE_CONSTRAINTS t'));
    assert.ok(query); assert.deepEqual(query.params, [database, database, table]); assert.equal(query.sql.includes(table), false);
    assert.match(query.sql, /LEFT JOIN/); assert.match(query.sql, /OCTET_LENGTH.*65536.*SHA2/); assert.match(query.sql, /LIMIT 2001/);
    assert.equal(query.sql.includes('BINARY c.TABLE_NAME'), tableColumn); assert.equal(query.sql.includes('t.ENFORCED'), !tableColumn);
    assert.equal(result.checkCapabilities.status, 'observed'); assert.equal(result.checks[0].declaredEnforcement, tableColumn ? 'unknown' : 'no');
    assert.equal(JSON.stringify(result).includes('private-expression'), false);
  }
});

test('denied/unknown CHECK metadata stays unknown and raw errors are redacted; context cancellation propagates', async () => {
  const queries = [];
  const unknown = await collectSelectionTargetFacts({ raw: async sql => { queries.push(sql); return { rows: [] }; } }, 'demo');
  assert.equal(unknown.checkCapabilities.status, 'unknown'); assert.equal(queries.some(sql => sql.includes('FROM information_schema.TABLE_CONSTRAINTS t')), false);
  const denied = await collectSelectionTargetFacts({ raw: async sql => {
    if (sql.includes('AS tableName, COLUMN_NAME AS name FROM')) return { rows: capabilityRows(false) };
    if (sql.includes('FROM information_schema.TABLE_CONSTRAINTS t')) throw Object.assign(new Error('private-check-error'), { code: 'ER_TABLEACCESS_DENIED_ERROR' });
    return { rows: [] };
  } }, 'demo');
  assert.ok(denied.errors.some(error => error.section === 'checks')); assert.equal(JSON.stringify(denied).includes('private-check-error'), false);
  let canceled = false;
  await assert.rejects(collectSelectionTargetFacts({ raw: async sql => {
    if (sql.includes('AS tableName, COLUMN_NAME AS name FROM')) { canceled = true; return { rows: capabilityRows(false) }; }
    return { rows: [] };
  } }, 'demo', () => { if (canceled) throw new Error('canceled-checks'); }), /canceled-checks/);
});

test('snapshot and plan bind CHECK metadata drift without returning expressions or enabling execution', () => {
  const collector = new RestoreSelectionInventory('demo');
  ['CREATE TABLE `items` (`v` INT) ENGINE=InnoDB', 'INSERT INTO items VALUES(-1)']
    .forEach((sql, i) => collector.add(sql, assertStatementScope(sql, 'demo'), i + 1));
  const inventory = collector.finish(), source = previewRestoreSelection(inventory, { tables: ['items'], includeStructure: false });
  const input = { ...facts(), checkedAt: '2026-11-13T00:00:00Z', version: '8.4', foreignKeys: [], triggers: [], foreignKeyMetadataVersion: 2, columns: [], indexes: [] };
  const build = () => {
    const target = buildSelectionTargetPreview({ source, facts: input, checksum: 'a'.repeat(64), targetIdentity: 'b'.repeat(64) });
    return { target, plan: buildSelectionDraft({ inventory, source, targetReview: target, checksum: 'a'.repeat(64), targetIdentity: 'b'.repeat(64) }) };
  };
  const first = build(); assert.equal(first.target.version, 16); assert.equal(first.plan.version, 29); assert.equal(first.plan.canExecute, false);
  assert.ok(first.plan.blockers.some(item => item.detail === 'TARGET_CHECKS_PRESENT'));
  input.checks[0].clauseDigest = 'd'.repeat(64);
  const second = build(); assert.notEqual(first.target.snapshotId, second.target.snapshotId); assert.notEqual(first.plan.planId, second.plan.planId);
  assert.equal(JSON.stringify(second.target).includes('d'.repeat(64)), false);
  input.checkSessionSettings = { version: 1, status: 'observed', enabled: false, reason: 'TARGET_CHECK_SESSION_OBSERVED' };
  const disabled = build();
  assert.notEqual(second.target.snapshotId, disabled.target.snapshotId); assert.notEqual(second.plan.planId, disabled.plan.planId);
  assert.ok(disabled.plan.blockers.some(item => item.detail === 'TARGET_CHECK_SESSION_DISABLED'));
  assert.equal(disabled.target.targetCheckReview.version, 2); assert.equal(disabled.target.targetCheckReview.sessionSettings.enabled, false);
  assert.equal(disabled.plan.canExecute, false);
  input.checkSessionSettings.enabled = true;
  const enabled = build(); assert.notEqual(disabled.plan.planId, enabled.plan.planId);
  assert.equal(enabled.target.targetCheckReview.rows[0].status, 'requires-review'); assert.equal(enabled.plan.canExecute, false);
});

test('CHECK session probe is one fixed SELECT, normalizes only binary values, and projects no raw fields', async () => {
  for (const value of [0, 1, '0', '1']) {
    let calls = 0;
    const result = await collectCheckSessionSettings({ raw: async (sql, params, timeout) => {
      calls++; assert.equal(sql, 'SELECT @@SESSION.check_constraint_checks AS enabled'); assert.deepEqual(params, []); assert.equal(timeout, 10000);
      return { rows: [{ enabled: value, private: 'private-expression' }] };
    } });
    assert.equal(calls, 1); assert.equal(result.enabled, Number(value) === 1); assert.equal(result.status, 'observed');
    assert.deepEqual(projectCheckSessionSettings({ ...result, rawSql: 'private-sql' }), result);
    assert.equal(JSON.stringify(result).includes('private'), false);
  }
  for (const rows of [null, [], [{ enabled: 1 }, { enabled: 0 }], [null], ...[null, true, false, 'ON', '1suffix', '1\n', [], {}, -1, 2].map(enabled => [{ enabled }])]) {
    const result = await collectCheckSessionSettings({ raw: async () => ({ rows }) });
    assert.equal(result.enabled, null); assert.equal(result.reason, 'TARGET_CHECK_SESSION_RESULT_INVALID');
  }
});

test('unavailable, denied or stale CHECK session observations remain unknown and cancellation propagates', async () => {
  for (const [code, reason] of [['ER_UNKNOWN_SYSTEM_VARIABLE', 'TARGET_CHECK_SESSION_VARIABLE_UNAVAILABLE'],
    ['ER_SPECIFIC_ACCESS_DENIED_ERROR', 'TARGET_CHECK_SESSION_QUERY_FAILED'], ['ECONNRESET', 'TARGET_CHECK_SESSION_QUERY_FAILED']]) {
    const result = await collectCheckSessionSettings({ raw: async () => { throw Object.assign(new Error('private-error'), { code }); } });
    assert.equal(result.status, 'unknown'); assert.equal(result.enabled, null); assert.equal(result.reason, reason);
    assert.equal(JSON.stringify(result).includes('private'), false);
  }
  for (const value of [null, { version: 0, status: 'observed', enabled: true },
    { version: 1, status: 'unknown', enabled: true, reason: 'TARGET_CHECK_SESSION_VARIABLE_UNAVAILABLE' },
    { version: 1, status: 'observed', enabled: '1', reason: 'TARGET_CHECK_SESSION_OBSERVED' }]) {
    assert.deepEqual(projectCheckSessionSettings(value), { version: 1, status: 'unknown', enabled: null, reason: 'TARGET_CHECK_SESSION_NOT_REVIEWED' });
  }
  let called = false;
  await assert.rejects(collectCheckSessionSettings({ raw: async () => { called = true; return { rows: [{ enabled: 1 }] }; } },
    () => { if (called) throw new Error('canceled-after-read'); }), /canceled-after-read/);
  await assert.rejects(collectCheckSessionSettings({ raw: async () => { throw new Error('should-not-run'); } },
    () => { throw new Error('canceled-before-read'); }), /canceled-before-read/);
});
