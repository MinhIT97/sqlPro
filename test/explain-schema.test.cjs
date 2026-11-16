'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSession } = require('../electron/database.cjs');
const { SCHEMA_BYTES, singleTableSource, showCreateSql, captureTableDefinition } = require('../electron/explain-schema.cjs');
const { explainSettingNames, explainSchema, captureExplain, compareExplain } = require('../query-results.js');

const ddl = (text = 'CREATE TABLE `items` (`id` int PRIMARY KEY) ENGINE=InnoDB') => ({ kind: 'rows',
  columns: [{ name: 'Table' }, { name: 'Create Table' }], rows: [['items', text]] });
const plan = () => ({ kind: 'rows', columns: [{ name: 'EXPLAIN' }], rows: [['{}']] });
const evidence = (digest = 'a'.repeat(64)) => ({ version: 1, status: 'observed', database: 'demo', table: 'items', digest });

test('single-table source recognizes exact quoted/qualified names and aliases without using renderer table hints', () => {
  for (const sql of ['EXPLAIN SELECT * FROM items', '/* note */ EXPLAIN FORMAT=JSON SELECT id, COUNT(*) FROM items AS t WHERE id IN (1,2) GROUP BY id',
    "EXPLAIN FORMAT=TREE SELECT 'JOIN FROM SELECT' AS text FROM items t ORDER BY t.id LIMIT 2;"]) {
    assert.deepEqual(singleTableSource(sql, 'demo'), { database: 'demo', table: 'items' });
  }
  const source = singleTableSource('EXPLAIN SELECT * FROM `a.b`.`c``d` AS `WHERE` WHERE id=1', null);
  assert.deepEqual(source, { database: 'a.b', table: 'c`d' }); assert.ok(Object.isFrozen(source));
  assert.equal(showCreateSql(source), 'SHOW CREATE TABLE `a.b`.`c``d`');
  assert.deepEqual(singleTableSource('EXPLAIN SELECT * FROM `bảng`', 'demo'), { database: 'demo', table: 'bảng' });
  assert.equal(showCreateSql({ database: 'a', table: 'x`;DROP TABLE y;#' }), 'SHOW CREATE TABLE `a`.`x``;DROP TABLE y;#`');
});

test('JOIN/CTE/subqueries/multiple tables, dialect ambiguity, batches, hints and missing scope never claim single-table coverage', () => {
  for (const sql of ['SELECT * FROM items', 'DESC items', 'EXPLAIN ANALYZE SELECT * FROM items', 'EXPLAIN SELECT 1',
    'EXPLAIN SELECT * FROM a JOIN b ON a.id=b.id', 'EXPLAIN SELECT * FROM a,b', 'EXPLAIN SELECT * FROM a x, b y',
    'EXPLAIN WITH x AS (SELECT * FROM a) SELECT * FROM x', 'EXPLAIN SELECT * FROM (SELECT * FROM a) x',
    'EXPLAIN SELECT * FROM a WHERE id IN (SELECT id FROM b)', 'EXPLAIN SELECT (SELECT COUNT(*) FROM b) FROM a',
    'EXPLAIN SELECT * FROM a WHERE id IN (TABLE b)', 'EXPLAIN SELECT * FROM a UNION SELECT * FROM b',
    'EXPLAIN SELECT * FROM a PARTITION(p0)', 'EXPLAIN SELECT * FROM a USE INDEX (idx)',
    'EXPLAIN SELECT * FROM "a"', 'EXPLAIN SELECT * FROM a; SELECT 1', 'EXPLAIN SELECT /*+ HINT */ * FROM a',
    'EXPLAIN SELECT * FROM a /*!80000 JOIN b */', 'EXPLAIN SELECT f() FROM a', 'EXPLAIN SELECT * FROM a WHERE id=(1',
    'EXPLAIN SELECT * FROM a.b.c', 'EXPLAIN SELECT * FROM ' + '`x'.padEnd(67, 'x') + '`', 'EXPLAIN '.padEnd(65537, 'x')]) {
    assert.equal(singleTableSource(sql, 'demo'), null, sql.slice(0, 100));
  }
  assert.equal(singleTableSource('EXPLAIN SELECT * FROM items', null), null);
  assert.equal(showCreateSql({ database: 'demo', table: '\0' }), null);
});

test('DDL capture hashes complete native table output only, rejecting views, binary preview and quotas without exposing definition values', () => {
  const raw = "CREATE TABLE `items` (`id` int DEFAULT 12345) COMMENT='private-comment'", hash = captureTableDefinition(ddl(raw));
  assert.match(hash, /^[a-f0-9]{64}$/); assert.notEqual(hash, captureTableDefinition(ddl(raw + ' ')));
  assert.equal(captureTableDefinition(ddl('CREATE TEMPORARY TABLE `items` (`id` int)')).length, 64);
  for (const value of [null, { ...ddl(), truncated: true }, { ...ddl(), columns: [] }, { ...ddl(), rows: [] },
    { ...ddl(), columns: [{ name: 'View' }, { name: 'Create View' }] }, ddl('CREATE VIEW `items` AS SELECT 1'),
    ddl('0x435245415445… (500 bytes)'), ddl('CREATE TABLE x '.padEnd(262145, 'x')), ddl('CREATE TABLE x ' + '中'.repeat(90000))]) {
    assert.equal(captureTableDefinition(value), null);
  }
  const projected = explainSchema({ ...evidence(hash), raw, password: 'private', extra: 'private' });
  assert.doesNotMatch(JSON.stringify(projected), /private|DEFAULT/);
  assert.equal(explainSchema({ ...projected, digest: hash + '\n' }).status, 'unknown');
  assert.equal(explainSchema({ version: 1, status: 'changed-during-run', database: 'demo', table: 'items', digest: hash }).digest, undefined);
});

function fixture(run) {
  const session = new DatabaseSession({ readOnly: true, database: 'demo' }); session.connection = {};
  const calls = [];
  session.runQuery = async (...args) => { calls.push(args); return run ? run(args, calls.length, session)
    : args[0].startsWith('SHOW CREATE TABLE') ? ddl() : plan(); };
  return { session, calls };
}

test('schema opt-in reads before/after under the existing task and applies row/byte/time budgets; default/unsupported source add no SHOW', async () => {
  const r = fixture();
  await r.session.runQueryScript('EXPLAIN SELECT * FROM items'); assert.equal(r.calls.length, 1);
  r.calls.length = 0;
  const result = await r.session.runQueryScript('EXPLAIN SELECT * FROM items', 30000, false, 'task', { explainSchema: true });
  assert.deepEqual(r.calls.map(call => call[0]), ['SHOW CREATE TABLE `demo`.`items`', 'EXPLAIN SELECT * FROM items', 'SHOW CREATE TABLE `demo`.`items`']);
  assert.equal(r.calls[0][2], 1); assert.equal(r.calls[0][3], SCHEMA_BYTES); assert.ok(r.calls[0][1] <= 2000);
  assert.equal(result.explainSettings, undefined); assert.equal(result.explainSchema.status, 'observed'); assert.equal(r.session.activeTask, null);
  r.calls.length = 0;
  const unknown = await r.session.runQueryScript('EXPLAIN SELECT * FROM items JOIN other USING(id)', 30000, false, 'task', { explainSchema: true });
  assert.equal(unknown.explainSchema.reason, 'unsupported-sql'); assert.equal(r.calls.length, 1);
});

test('DDL drift, denied metadata, cancel/timeout and changed connection preserve completed plans but cannot provide schema evidence', async () => {
  for (const variant of ['drift', 'denied-before', 'denied-after', 'cancel-before', 'cancel-after', 'timeout-after', 'connection-after']) {
    const r = fixture((args, count, session) => {
      if (count === 1 && variant === 'denied-before' || count === 3 && variant === 'denied-after') throw new Error('private-server-error');
      if (count === 1 && variant === 'cancel-before' || count === 3 && variant === 'cancel-after') {
        session.cancelTask('task'); throw Object.assign(new Error('canceled'), { code: 'QUERY_CANCELED' });
      }
      if (count === 3 && variant === 'timeout-after') { session.dead = true; throw Object.assign(new Error('timeout'), { code: 'QUERY_TIMEOUT' }); }
      if (count === 2 && variant === 'connection-after') session.connection = {};
      return args[0].startsWith('SHOW CREATE TABLE') ? ddl(count === 3 && variant === 'drift' ? 'CREATE TABLE items(id bigint)' : undefined) : plan();
    });
    const pending = r.session.runQueryScript('EXPLAIN SELECT * FROM items', 30000, false, 'task', { explainSchema: true });
    if (variant === 'cancel-before') await assert.rejects(pending);
    else {
      const result = await pending; assert.deepEqual(result.rows, plan().rows); assert.notEqual(result.explainSchema.status, 'observed', variant);
      assert.doesNotMatch(JSON.stringify(result.explainSchema), /private|CREATE TABLE/);
      assert.equal(r.calls.filter(call => call[0].startsWith('EXPLAIN')).length, 1);
    }
    assert.equal(r.session.activeTask, null);
  }
});

test('enabling settings and schema shares one task/deadline and reads only the requested metadata around one EXPLAIN', async () => {
  const values = ['8.4.13', 'demo', '', 'index_merge=on', 'SYSTEM', 'utf8mb4', 'utf8mb4', null, 'utf8mb4_general_ci', '1', '18446744073709551615'];
  const r = fixture(args => args[0].startsWith('SHOW CREATE TABLE') ? ddl() : args[0].startsWith('SELECT ')
    ? { kind: 'rows', columns: explainSettingNames.map(name => ({ name })), rows: [values] } : plan());
  const result = await r.session.runQueryScript('EXPLAIN SELECT * FROM items', 30000, false, 'combined', { explainSettings: true, explainSchema: true });
  assert.equal(r.calls.length, 5); assert.equal(result.explainSettings.status, 'observed'); assert.equal(result.explainSchema.status, 'observed');
  assert.equal(r.calls.filter(call => call[0].startsWith('EXPLAIN')).length, 1); assert.equal(r.session.activeTask, null);
});

test('comparison binds schema mode and identity, reports changed definition without a plan diff, and rejects incomplete evidence', () => {
  const request = { profileId: 'p', database: 'demo', taskId: 'task', explainSchema: true };
  const result = schema => ({ ...plan(), isExplain: true, explainContext: { version: 1, profileId: 'p', database: 'demo', taskId: 'task',
    sessionId: 'session', sqlHash: 'a'.repeat(64), checkedAt: '2026-11-16T00:00:00Z', schema } });
  const first = captureExplain(result(evidence()), request); assert.ok(first); assert.ok(Object.isFrozen(first.schema));
  assert.equal(compareExplain(first, captureExplain(result(evidence()), request)).status, 'unchanged');
  const changed = compareExplain(first, captureExplain(result(evidence('b'.repeat(64))), request));
  assert.equal(changed.status, 'schema-changed'); assert.equal(changed.changes, undefined); assert.doesNotMatch(JSON.stringify(changed), /digest|bbbbbbbb/);
  assert.equal(compareExplain(first, captureExplain(result({ ...evidence(), table: 'other' }), request)).status, 'different-scope');
  assert.equal(compareExplain(first, captureExplain(result(evidence()), { ...request, explainSchema: false })).status, 'different-scope');
  for (const value of [undefined, { version: 1, status: 'unknown', reason: 'unavailable' },
    { version: 1, status: 'changed-during-run', database: 'demo', table: 'items' }]) assert.equal(captureExplain(result(value), request), null);
});
