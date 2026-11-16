'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSession } = require('../electron/database.cjs');
const { SETTINGS_SQL, canObserveExplainSettings, captureSettings, runExplainWithContext } = require('../electron/explain-session.cjs');
const { explainSettingNames, explainSettings, captureExplain, compareExplain } = require('../query-results.js');

const settingsResult = (changes = {}) => ({ kind: 'rows', columns: explainSettingNames.map(name => ({ name })),
  rows: [explainSettingNames.map(name => Object.hasOwn(changes, name) ? changes[name] : ({ server_version: '8.4.13', database: 'demo',
    sql_mode: 'STRICT_TRANS_TABLES', optimizer_switch: 'index_merge=on', time_zone: 'SYSTEM', character_set_client: 'utf8mb4',
    character_set_connection: 'utf8mb4', character_set_results: null, collation_connection: 'utf8mb4_general_ci',
    autocommit: '1', sql_select_limit: '18446744073709551615' })[name])] });
const planResult = () => ({ kind: 'rows', columns: [{ name: 'EXPLAIN' }], rows: [['{"query_block":{}}']], durationMs: 1 });
const observed = (changes) => ({ version: 1, status: 'observed', fields: captureSettings(settingsResult(changes)) });

test('settings observation accepts only a single recognized nonexecuting EXPLAIN SELECT', () => {
  for (const sql of ['EXPLAIN SELECT 1', '/* note */ EXPLAIN FORMAT=JSON SELECT * FROM demo.items',
    'EXPLAIN FORMAT=TREE WITH x AS (SELECT 1 AS id) SELECT * FROM x;']) assert.equal(canObserveExplainSettings(sql), true);
  for (const sql of [null, '', 'SELECT 1', 'DESC items', 'EXPLAIN DELETE FROM items', 'EXPLAIN ANALYZE SELECT 1',
    'EXPLAIN SELECT f()', 'EXPLAIN SELECT 1; SELECT 2', 'EXPLAIN /*!80018 ANALYZE */ SELECT 1', 'EXPLAIN /*+ hint */ SELECT 1']) {
    assert.equal(canObserveExplainSettings(sql), false, String(sql));
  }
});

test('settings projection hashes exact bounded server values, distinguishes null and empty, strips raw fields and rejects partial shapes', () => {
  const input = settingsResult(), fields = captureSettings(input), evidence = observed();
  assert.equal(fields.length, 11); assert.doesNotMatch(JSON.stringify(fields), /STRICT_TRANS_TABLES|index_merge=on|8\.4\.13|general_ci/);
  assert.notDeepEqual(fields, captureSettings(settingsResult({ character_set_results: 'NULL' })));
  assert.notDeepEqual(fields, captureSettings(settingsResult({ sql_mode: '' })));
  evidence.secret = 'hidden'; evidence.fields[0].raw = 'hidden';
  assert.doesNotMatch(JSON.stringify(explainSettings(evidence)), /hidden/);
  for (const value of [null, { ...input, truncated: true }, { ...input, rows: [] }, { ...input, columns: { length: 11 } },
    settingsResult({ sql_mode: 'x'.repeat(8193) }), settingsResult({ server_version: '' }), settingsResult({ database: '' }),
    settingsResult({ autocommit: 1 }), settingsResult({ autocommit: '0x31' }), settingsResult({ time_zone: null }), settingsResult({ sql_select_limit: '1\n' })]) {
    assert.equal(captureSettings(value), null);
  }
  const duplicate = settingsResult(); duplicate.columns[0].name = duplicate.columns[1].name; assert.equal(captureSettings(duplicate), null);
  for (const fields of [[...evidence.fields].reverse(), evidence.fields.slice(1), evidence.fields.map(field => ({ ...field, digest: field.digest + '\n' }))]) {
    assert.equal(explainSettings({ version: 1, status: 'observed', fields }).status, 'unknown');
  }
});

function fixture(read) {
  const session = new DatabaseSession({ readOnly: true }); session.connection = {};
  const calls = [];
  session.runQuery = async (...args) => { calls.push(args); return read ? read(args[0], args[1], args[2], args[3], calls.length, session) : args[0] === SETTINGS_SQL ? settingsResult() : planResult(); };
  return { session, calls };
}

test('opt-in makes two bounded SELECT observations under one task, default and unsupported SQL add no queries', async () => {
  const r = fixture();
  const plain = await r.session.runQueryScript('EXPLAIN SELECT 1'); assert.equal(r.calls.length, 1); assert.equal(plain.explainSettings, undefined);
  r.calls.length = 0;
  const result = await r.session.runQueryScript('EXPLAIN SELECT 1', 30000, false, 'task', { explainSettings: true,
    checkExplainContext: () => assert.equal(r.session.activeTask.id, 'task') });
  assert.deepEqual(r.calls.map(call => call[0]), [SETTINGS_SQL, 'EXPLAIN SELECT 1', SETTINGS_SQL]);
  assert.equal(r.calls[0][2], 1); assert.equal(r.calls[0][3], 32768); assert.ok(r.calls[0][1] <= 2000);
  assert.equal(result.explainSettings.status, 'observed'); assert.deepEqual(result.rows, planResult().rows); assert.equal(r.session.activeTask, null);
  r.calls.length = 0;
  await r.session.runQueryScript('DESC items', 30000, false, null, { explainSettings: true }); assert.equal(r.calls.length, 1);
  await assert.rejects(r.session.runQueryScript('EXPLAIN ANALYZE SELECT 1', 30000, true, null, { explainSettings: true }));
  assert.equal(r.calls.length, 1);
});

test('changed/denied/invalid/canceled/timed-out metadata never certifies a comparison or retries the original plan', async () => {
  for (const variant of ['during-run', 'denied-before', 'invalid-before', 'denied-after', 'invalid-after', 'cancel-before', 'cancel-after', 'timeout-after', 'context-after']) {
    const r = fixture((sql, timeout, rows, bytes, count, session) => {
      if (count === 1 && variant === 'cancel-before') { session.cancelTask('task'); throw Object.assign(new Error('canceled'), { code: 'QUERY_CANCELED' }); }
      if (count === 1 && variant === 'denied-before' || count === 3 && variant === 'denied-after') throw new Error('sensitive server error');
      if (count === 1 && variant === 'invalid-before' || count === 3 && variant === 'invalid-after') return { ...settingsResult(), truncated: true };
      if (count === 3 && variant === 'cancel-after') { session.cancelTask('task'); throw Object.assign(new Error('canceled'), { code: 'QUERY_CANCELED' }); }
      if (count === 3 && variant === 'timeout-after') { session.dead = true; throw Object.assign(new Error('timeout'), { code: 'QUERY_TIMEOUT' }); }
      if (count === 2 && variant === 'context-after') session.scopeChanged = true;
      return sql === SETTINGS_SQL ? settingsResult(count === 3 && variant === 'during-run' ? { time_zone: '+07:00' } : {}) : planResult();
    });
    const pending = r.session.runQueryScript('EXPLAIN SELECT 1', 30000, false, 'task', { explainSettings: true,
      checkExplainContext: () => { if (r.session.scopeChanged) throw Object.assign(new Error('changed'), { code: 'EXPLAIN_CONTEXT_CHANGED' }); } });
    if (variant === 'cancel-before') await assert.rejects(pending);
    else {
      const result = await pending;
      assert.deepEqual(result.rows, planResult().rows); assert.notEqual(result.explainSettings.status, 'observed', variant);
      assert.doesNotMatch(JSON.stringify(result.explainSettings), /sensitive/);
      assert.equal(r.calls.filter(call => call[0] === 'EXPLAIN SELECT 1').length, 1);
    }
    assert.equal(r.session.activeTask, null);
  }
});

test('metadata uses the original deadline and leaves completed plans visible if remaining time expires', async () => {
  let now = 1000; const calls = [];
  const result = await runExplainWithContext({ sql: 'EXPLAIN SELECT 1', timeoutMs: 1000, rowLimit: 5000, now: () => now,
    check() {}, isDead: () => false, read: async (sql, timeout) => {
      calls.push([sql, timeout]); now += sql === SETTINGS_SQL ? 400 : 700; return sql === SETTINGS_SQL ? settingsResult() : planResult();
    } });
  assert.equal(calls.length, 2); assert.equal(calls[0][1], 1000); assert.equal(calls[1][1], 600);
  assert.equal(result.explainSettings.reason, 'timeout'); assert.deepEqual(result.rows, planResult().rows);
});

test('comparison requires opted-in observed settings, keeps scopes separate and reports changed names without plan diffs', () => {
  const request = { profileId: 'p', database: 'demo', taskId: 'task', explainSettings: true };
  const result = settings => ({ ...planResult(), isExplain: true,
    explainContext: { version: 1, profileId: 'p', database: 'demo', taskId: 'task', sessionId: 'session',
      sqlHash: 'a'.repeat(64), checkedAt: '2026-11-16T00:00:00Z', settings } });
  const first = captureExplain(result(observed()), request), same = captureExplain(result(observed()), request);
  assert.ok(first); assert.ok(Object.isFrozen(first.settings[0])); assert.equal(compareExplain(first, same).status, 'unchanged');
  const changed = captureExplain(result(observed({ sql_mode: '' })), request), comparison = compareExplain(first, changed);
  assert.equal(comparison.status, 'settings-changed'); assert.deepEqual(comparison.changedFields, ['sql_mode']);
  assert.equal(comparison.changes, undefined); assert.doesNotMatch(JSON.stringify(comparison), /digest|STRICT_TRANS_TABLES/);
  assert.equal(compareExplain(first, captureExplain(result(observed()), { ...request, explainSettings: false })).status, 'different-scope');
  for (const value of [undefined, { version: 1, status: 'unknown', reason: 'unavailable' },
    { version: 1, status: 'changed-during-run', changedFields: ['sql_mode'] }]) assert.equal(captureExplain(result(value), request), null);
  assert.equal(compareExplain(changed, captureExplain(result(observed({ sql_mode: '' })), request)).status, 'unchanged');
});
