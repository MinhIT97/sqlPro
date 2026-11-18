'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { DatabaseSession } = require('../electron/database.cjs');
const { RestorePlanService } = require('../electron/restore-plan-service.cjs');
const { RestoreSelectionExecutor } = require('../electron/restore-selection-executor.cjs');
const { createRestoreContextPolicy } = require('../electron/restore-context-policy.cjs');
const { SqlScriptParser } = require('../electron/sql-script.cjs');

const create = 'CREATE TABLE `users` (`id` int PRIMARY KEY);';
const insert = 'INSERT INTO `users` VALUES (1);';
const facts = { foreignKeys: 1, sqlMode: '', autocommit: 1 };

async function fixture(t, sql, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-restore-fixes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'dump.sql');
  fs.writeFileSync(filePath, sql);
  const profile = { id: 'p', readOnly: false };
  const service = new RestorePlanService({
    store: { getWithSecrets: () => profile }, fingerprintProfile: () => 'fp',
    createSession: () => ({ async connect() {}, async close() {},
      async collectRestoreTargetFacts(database) { return { database, objects: [{ name: 'users', type: 'table' }], errors: [] }; } })
  });
  const plan = await service.createSelectiveRestorePlan({ filePath, targetProfileId: 'p', targetDatabase: 'sample',
    selection: { tables: ['users'], includeStructure: options.includeStructure !== false }, dropExisting: Boolean(options.dropExisting) });
  const queries = [];
  const state = { open: false, closeCount: 0 };
  const worker = {
    async connect() { await options.connect?.(); state.open = true; },
    async useDatabase() {},
    async raw(sql) {
      queries.push(sql);
      if (sql.startsWith('SELECT @@SESSION.foreign_key_checks')) return { result: [options.sessionState ?? facts] };
      await options.raw?.(sql);
      return { result: [] };
    },
    async close() { state.closeCount++; await options.close?.(); state.open = false; }
  };
  const executor = new RestoreSelectionExecutor({ consumePlan: () => {
    const admitted = service.consumePlan(plan.planToken);
    return options.bypassPlan ? { ...admitted, status: 'ready', canExecute: true, applySupported: true } : admitted;
  },
    getProfileWithSecrets: () => profile, fingerprintProfile: () => 'fp', createSession: () => worker,
    statementTimeoutMs: options.timeout ?? 2000 });
  return { plan, queries, state, executor, run: (args = {}) => executor.executePlan({ planToken: plan.planToken, ...args }) };
}

test('V01: unsafe dump context is blocked before even a pre-drop, including a forged ready plan', async t => {
  const attack = "ALTER TABLE `users` COMMENT='x\\', RENAME TO `other_db`.`victim` -- '\n;";
  for (const mode of ['NO_BACKSLASH_ESCAPES', 'ANSI_QUOTES', 'ANSI']) {
    const f = await fixture(t, create + `SET SQL_MODE='${mode}';` + attack, { dropExisting: true, bypassPlan: true });
    assert.equal(f.plan.status, 'blocked');
    assert.ok(f.plan.blockers.some(b => b.code === 'RESTORE_CONTEXT_UNSUPPORTED'));
    await assert.rejects(f.run, { code: 'RESTORE_CONTEXT_UNSUPPORTED' });
    assert.deepEqual(f.queries, []);
  }
});

test('V01: incompatible or missing initial session facts cause zero writes', async t => {
  for (const sessionState of [{ ...facts, sqlMode: 'NO_BACKSLASH_ESCAPES' }, { ...facts, sqlMode: 'ANSI_QUOTES' }, {}, { ...facts, autocommit: null }]) {
    const f = await fixture(t, create, { sessionState, dropExisting: true });
    await assert.rejects(f.run, e => ['RESTORE_CONTEXT_UNSUPPORTED', 'RESTORE_SESSION_STATE_UNKNOWN'].includes(e.code));
    assert.equal(f.queries.length, 1);
    assert.match(f.queries[0], /^SELECT/);
    assert.equal(f.state.open, false);
  }
});

test('V01: saved mysqldump mode/charset context remains supported, dynamic expressions and unsafe charsets do not', async () => {
  const policy = createRestoreContextPolicy();
  for (const sql of ["SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO'", 'SET SQL_MODE=@old_sql_mode',
    'SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT', "SET CHARACTER_SET_CLIENT='utf8mb4'", 'SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT',
    'SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci']) policy.validate(sql);
  for (const sql of ["SET SQL_MODE=CONCAT('NO_', 'BACKSLASH_ESCAPES')", "SET CHARACTER_SET_CLIENT='gbk'", 'SET NAMES gbk',
    'SET NAMES utf8mb4 COLLATE', 'SET CHARACTER SET utf8mb4 COLLATE utf8mb4_bin',
    'SET AUTOCOMMIT=0,AUTOCOMMIT=1', 'SET AUTOCOMMIT=DEFAULT']) {
    assert.throws(() => createRestoreContextPolicy().validate(sql));
  }
});

test('V01: version-dependent comments/hints fail before planning, including split chunk prefixes', async t => {
  for (const comment of ['/*!40101 SET SQL_MODE=\'NO_BACKSLASH_ESCAPES\' */;', '/*M!100100 SET SQL_MODE=\'NO_BACKSLASH_ESCAPES\' */;', '/*+ SET_VAR(sql_mode=ANSI_QUOTES) */ SELECT 1;']) {
    await assert.rejects(() => fixture(t, create + comment), { code: 'RESTORE_CONTEXT_UNSUPPORTED' });
    const parser = new SqlScriptParser({ rejectDialectComments: true });
    assert.throws(() => { for (const char of comment) parser.push(char); parser.end(); }, { code: 'RESTORE_CONTEXT_UNSUPPORTED' });
  }
  const literal = new SqlScriptParser({ rejectDialectComments: true });
  assert.deepEqual([...literal.push("INSERT INTO users VALUES ('/*! literal only */');"), ...literal.end()], ["INSERT INTO users VALUES ('/*! literal only */')"]);
});

test('plan creation cannot republish stale evidence after reset or target profile drift', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-restore-plan-reset-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'backup.sql');
  fs.writeFileSync(filePath, create);
  for (const reset of [true, false]) {
    const profile = { id: 'p', host: 'before' };
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    const service = new RestorePlanService({ store: { getWithSecrets: () => profile }, fingerprintProfile: p => p.host,
      createSession: () => ({ async connect() {}, async close() {}, async collectRestoreTargetFacts(database) {
        entered(); await new Promise(resolve => { release = resolve; }); return { database, objects: [], errors: [] };
      } }) });
    const pending = service.createSelectiveRestorePlan({ filePath, targetProfileId: 'p', targetDatabase: 'sample', selection: { tables: ['users'] } });
    const rejected = assert.rejects(pending, { code: reset ? 'RESTORE_CONTEXT_CHANGED' : 'TARGET_CONTEXT_DRIFT' });
    await started;
    if (reset) service.clear(); else profile.host = 'after';
    release();
    await rejected;
    assert.equal(service.pendingPlans.size, 0);
  }
});

test('SQL stream does not turn -- without whitespace into a comment and silently rewrite a statement', () => {
  const parser = new SqlScriptParser();
  const output = [];
  for (const char of 'INSERT INTO users VALUES(5--1); -- actual comment\nSELECT 1;') output.push(...parser.push(char));
  output.push(...parser.end());
  assert.deepEqual(output, ['INSERT INTO users VALUES(5--1)', 'SELECT 1']);
  const cr = new SqlScriptParser();
  assert.deepEqual([...cr.push('-- comment\rSELECT 2;'), ...cr.end()], ['SELECT 2']);
  const emptyCr = new SqlScriptParser();
  assert.deepEqual([...emptyCr.push('--\rSELECT 2;'), ...emptyCr.end()], ['SELECT 2']);
});

test('V02: a user variable named autocommit cannot hide pending writes', async t => {
  const f = await fixture(t, 'SET AUTOCOMMIT=0;SET @autocommit=1;' + insert, { includeStructure: false });
  await assert.rejects(f.run, e => e.code === 'RESTORE_UNCOMMITTED_TRANSACTION' && e.targetChanged === true && !e.executionUncertain);
  assert.ok(f.queries.includes('SET @autocommit=1'));
  assert.equal(f.state.open, false);
});

test('V02: AUTOCOMMIT DEFAULT is rejected before writes and inherited autocommit=0 is tracked', async t => {
  const f = await fixture(t, create + 'SET AUTOCOMMIT=DEFAULT;' + insert);
  assert.equal(f.plan.status, 'blocked');
  await assert.rejects(f.run, { code: 'RESTORE_PLAN_BLOCKED' });
  assert.deepEqual(f.queries, []);
  const inherited = await fixture(t, insert, { sessionState: { ...facts, autocommit: 0 }, includeStructure: false });
  await assert.rejects(inherited.run, { code: 'RESTORE_UNCOMMITTED_TRANSACTION' });
});

test('V03: COMMIT and implicit commit lost acknowledgements preserve uncertain execution', async t => {
  for (const [prefix, commit] of [['START TRANSACTION;', 'COMMIT'], ['SET AUTOCOMMIT=0;', 'SET AUTOCOMMIT=1']]) {
    const f = await fixture(t, prefix + insert + commit + ';', { includeStructure: false,
      raw: sql => { if (sql === commit) throw Object.assign(new Error('lost acknowledgement'), { code: 'ECONNRESET' }); } });
    await assert.rejects(f.run, e => e.code === 'ECONNRESET' && e.executionUncertain === true && e.partialCommit === true && e.targetChanged === true);
    assert.equal(f.state.open, false);
  }
});

test('V03: explicit and implicit commit ACKs complete writes; a later error retains committed ledger', async t => {
  for (const [prefix, commit] of [['START TRANSACTION;', 'COMMIT'], ['SET AUTOCOMMIT=0;', 'SET AUTOCOMMIT=1']]) {
    const f = await fixture(t, prefix + insert + commit + ';', { includeStructure: false });
    assert.equal((await f.run()).success, true);
    const later = await fixture(t, prefix + insert + commit + ';' + insert, { includeStructure: false,
      raw: sql => { if (sql === insert.slice(0, -1) && later.queries.filter(q => q === sql).length === 2) throw Object.assign(new Error('later failure'), { code: 'FAIL_LATER' }); } });
    await assert.rejects(later.run, e => e.code === 'FAIL_LATER' && e.partialCommit === true);
  }
});

test('V02: enabling autocommit closes an empty explicit transaction before the next write', async t => {
  const f = await fixture(t, 'START TRANSACTION;SET AUTOCOMMIT=0;SET AUTOCOMMIT=1;' + insert, { includeStructure: false });
  assert.equal((await f.run()).success, true);
});

test('V04: late connect after timeout is closed again without an AbortSignal', async t => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, create, { timeout: 25, connect: () => { entered(); return new Promise(resolve => { release = resolve; }); } });
  const pending = assert.rejects(f.run, { code: 'STATEMENT_TIMEOUT' });
  await started;
  await pending;
  const closes = f.state.closeCount;
  release();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.state.closeCount > closes);
  assert.equal(f.state.open, false);
  assert.deepEqual(f.queries, []);
});

test('V04: late connect after cancellation closes; cleanup failure never returns success', async t => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const controller = new AbortController();
  const f = await fixture(t, create, { connect: () => { entered(); return new Promise(resolve => { release = resolve; }); } });
  const pending = assert.rejects(() => f.run({ signal: controller.signal }), { code: 'QUERY_CANCELED' });
  await started;
  controller.abort();
  await pending;
  const closes = f.state.closeCount;
  release();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.state.closeCount > closes);
  assert.equal(f.state.open, false);
  const brokenClose = await fixture(t, create, { close: () => { throw new Error('close failed'); } });
  await assert.rejects(brokenClose.run, e => e.code === 'RESTORE_WORKER_CLOSE_FAILED' && e.cleanupError === e.code && e.partialCommit === true);
});

test('V04: a close that never resolves is bounded and cannot produce success', { timeout: 5000 }, async t => {
  const f = await fixture(t, create, { close: () => new Promise(() => {}) });
  await assert.rejects(f.run, { code: 'RESTORE_WORKER_CLOSE_FAILED' });
});

test('Main IPC: unsafe mode is blocked with zero SQL; lost COMMIT ACK keeps partial outcome', async t => {
  const source = fs.readFileSync(path.join(__dirname, 'main-schema-migration.test.cjs'), 'utf8');
  const body = source.slice(source.indexOf('function fixture()'), source.indexOf('\ntest('));
  const makeMain = new Function('require', 'path', 'vm', 'fs', 'crypto', 'DatabaseSession', '__dirname', body + ';return fixture;')(
    require, path, vm, fs, crypto, DatabaseSession, __dirname);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-restore-main-fixes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'dump.sql');
  for (const unsafe of [true, false]) {
    const r = makeMain();
    r.profiles.p = { environment: 'local', readOnly: false };
    r.evaluate(`restorePlanService.createSession = () => ({ async connect() {}, async close() {},
      async collectRestoreTargetFacts(database) { return { database, objects: [{ type: 'table', name: 'users' }], errors: [] }; } });`);
    fs.writeFileSync(filePath, unsafe ? create + "SET SQL_MODE='NO_BACKSLASH_ESCAPES';" : 'START TRANSACTION;' + insert + 'COMMIT;');
    const plan = await r.evaluate('restorePlanService').createSelectiveRestorePlan({ filePath, targetProfileId: 'p', targetDatabase: 'sample', selection: { tables: ['users'] } });
    r.controls.onRaw = sql => { if (sql === 'COMMIT') throw Object.assign(new Error('lost ACK'), { code: 'ECONNRESET' }); };
    const result = await r.call('db:apply-selective-restore-plan', { planToken: plan.planToken, profileId: 'p' });
    assert.equal(result.ok, false);
    if (unsafe) {
      assert.equal(result.error.code, 'RESTORE_PLAN_BLOCKED');
      assert.equal(r.queries.length, 0);
    } else {
      assert.equal(result.error.code, 'ECONNRESET');
      for (const key of ['partialCommit', 'executionUncertain', 'targetChanged']) assert.equal(result.error[key], true);
      assert.equal(result.error.executedCount, 1);
    }
  }
});
