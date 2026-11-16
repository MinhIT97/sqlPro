'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { validateAnalyzeSource, buildAnalyzeQuery, assertPlanExport } = require('../electron/query-analyze.cjs');
const { DatabaseSession } = require('../electron/database.cjs');
const { explainDocument, captureExplain } = require('../query-results.js');

test('ANALYZE accepts one simple SELECT/CTE and rejects writes, locks, mode ambiguity and executable comments before execution', () => {
  for (const sql of ['SELECT * FROM `items` WHERE id=1;', '/* comment */ SELECT COUNT(*) FROM items',
    "SELECT 'DELETE; UPDATE', `update` FROM items", 'WITH x AS (SELECT 1 AS n) SELECT * FROM x']) {
    assert.ok(validateAnalyzeSource(sql));
  }
  for (const sql of [null, '', 'SELECT 1; SELECT 2', 'DELETE FROM items', 'EXPLAIN ANALYZE SELECT 1',
    'ANALYZE SELECT 1', 'SHOW TABLES', 'WITH x AS (SELECT 1) DELETE FROM items',
    'SELECT * FROM items FOR UPDATE', 'SELECT * INTO OUTFILE \'/tmp/data\' FROM items',
    'SELECT f()', 'SELECT db.f()', 'SELECT SLEEP(1)', 'SELECT @x:=1',
    'SELECT /*!50000 f() */ 1', 'SELECT /*M! f() */ 1', 'SELECT /*+ HINT */ 1',
    "SELECT 'a\\\'b'", 'SELECT `a\\b` FROM items', 'SELECT 1\0', 'SELECT '.padEnd(65537, '1')]) {
    assert.throws(() => validateAnalyzeSource(sql), error => error.code === 'ANALYZE_INVALID_SQL', String(sql));
  }
});

test('ANALYZE builds native syntax from recognized server version only, without guessing unsupported forks', () => {
  for (const version of ['8.0.18', '8.4.7', '8.0.36-0ubuntu0.22.04.1', '8.4.3-commercial']) {
    assert.equal(buildAnalyzeQuery('SELECT 1', version).sql, 'EXPLAIN ANALYZE FORMAT=TREE SELECT 1');
  }
  for (const version of ['10.1.48-MariaDB', '11.4.9-MariaDB-ubu2404', '5.5.5-10.11.14-MariaDB']) {
    assert.equal(buildAnalyzeQuery('SELECT 1', version).sql, 'ANALYZE FORMAT=JSON SELECT 1');
  }
  for (const version of [null, '', '5.7.44', '8.0.17', '10.0.38-MariaDB', '8.0.36-TiDB', '8.0.36-Percona', '9.0.1', '8.4.3\n']) {
    assert.throws(() => buildAnalyzeQuery('SELECT 1', version), error => error.code === 'ANALYZE_UNSUPPORTED', String(version));
  }
});

function sessionFixture(version = '11.4.9-MariaDB-ubu2404') {
  const session = new DatabaseSession({ readOnly: false });
  session.version = version;
  const statements = [];
  session.connection = { query(options) {
    statements.push(options.sql);
    const emitter = new EventEmitter();
    queueMicrotask(() => {
      if (options.sql === 'SELECT @@SESSION.autocommit AS value') {
        emitter.emit('fields', [{ name: 'value', columnType: 3 }]);
        emitter.emit('result', [1]); emitter.emit('end'); return;
      }
      emitter.emit('fields', [{ name: version.includes('MariaDB') ? 'ANALYZE' : 'EXPLAIN', columnType: 253 }]);
      emitter.emit('result', [version.includes('MariaDB') ? '{"query_block":{"r_rows":2}}' : '-> Table scan (actual time=0.1..0.2 rows=2 loops=1)']);
      emitter.emit('end');
    });
    return emitter;
  } };
  return { session, statements };
}

test('validated ANALYZE streams MariaDB/MySQL rows, preserves raw statistics and never creates an EXPLAIN baseline', async () => {
  for (const version of ['11.4.9-MariaDB-ubu2404', '8.4.7']) {
    const { session, statements } = sessionFixture(version);
    const result = await session.analyzeQuery('SELECT * FROM items', 30000, 'analyze-1');
    assert.equal(result.kind, 'rows'); assert.equal(result.isAnalyze, true); assert.equal(result.analysis.executed, true);
    assert.ok(explainDocument(result)); assert.equal(captureExplain(result, {}), null);
    assert.equal(statements.length, 2); assert.equal(session.activeTask, null);
    assert.equal(result.explainContext, undefined);
  }
});

test('session guard blocks active transactions, actual autocommit defaults, cancellation and drift before running ANALYZE', async () => {
  for (const flags of [{ inTransaction: true }, { autocommit: false }, { activeTask: { id: 'other' } }, { profile: { readOnly: true } }]) {
    const { session, statements } = sessionFixture(); Object.assign(session, flags);
    await assert.rejects(session.analyzeQuery('SELECT 1')); assert.equal(statements.length, 0);
  }
  for (const variant of ['server-autocommit-off', 'canceled', 'profile-drift', 'context-drift', 'raw-error']) {
    const { session, statements } = sessionFixture();
    const read = session.runQuery.bind(session);
    session.runQuery = async (...args) => {
      if (args[0] !== 'SELECT @@SESSION.autocommit AS value') return read(...args);
      if (variant === 'raw-error') throw new Error('preflight failed');
      if (variant === 'canceled') session.cancelTask('task');
      if (variant === 'profile-drift') session.profile.readOnly = true;
      return { rows: [[variant === 'server-autocommit-off' ? 0 : 1]] };
    };
    await assert.rejects(session.analyzeQuery('SELECT 1', 30000, 'task', () => {
      if (variant === 'context-drift') throw new Error('scope changed');
    }));
    assert.equal(statements.length, 0); assert.equal(session.activeTask, null);
  }
});

test('ANALYZE cancellation/timeout destroys the executing connection and never retries', async () => {
  for (const mode of ['cancel', 'timeout', 'server-error']) {
    const { session } = sessionFixture();
    let runs = 0, destroyed = 0;
    const preflight = session.connection.query;
    session.connection = { destroy() { destroyed++; }, query(options) {
      if (options.sql === 'SELECT @@SESSION.autocommit AS value') return preflight(options);
      runs++; const emitter = new EventEmitter();
      if (mode === 'cancel') setImmediate(() => session.cancelTask('task'));
      if (mode === 'server-error') queueMicrotask(() => emitter.emit('error', new Error('unsupported')));
      return emitter;
    } };
    // Exercise the existing execution timeout without waiting the public 1s floor.
    const run = session.runQuery.bind(session);
    if (mode === 'timeout') session.runQuery = (sql, timeout, rows, bytes, token) => run(sql, sql.startsWith('SELECT @@') ? timeout : 5, rows, bytes, token);
    await assert.rejects(session.analyzeQuery('SELECT 1', 1000, 'task'));
    assert.equal(runs, 1); assert.equal(destroyed, mode === 'server-error' ? 0 : 1); assert.equal(session.activeTask, null);
  }
});

test('ANALYZE result budget stays bounded and does not broaden ordinary read-only script policy', async () => {
  const { session } = sessionFixture();
  const preflight = session.connection.query;
  session.connection.query = options => {
    if (options.sql === 'SELECT @@SESSION.autocommit AS value') return preflight(options);
    const emitter = new EventEmitter();
    queueMicrotask(() => {
      emitter.emit('fields', [{ name: 'ANALYZE', columnType: 253 }]);
      emitter.emit('result', ['x'.repeat(1024 * 1024 + 1)]); emitter.emit('end');
    });
    return emitter;
  };
  const result = await session.analyzeQuery('SELECT 1'); assert.equal(result.truncated, true); assert.equal(result.rows.length, 0);
  session.profile.readOnly = true;
  await assert.rejects(session.runQueryScript('ANALYZE FORMAT=JSON SELECT 1'), error => error.code === 'CONNECTION_READ_ONLY');
  const ordinary = { kind: 'rows', isExplain: true, columns: [{ name: 'ANALYZE' }], rows: [['{}']] };
  assert.equal(explainDocument(ordinary), null); assert.ok(explainDocument({ ...ordinary, isAnalyze: true }));
});

test('cancel during autocommit preflight closes the reader and never sends ANALYZE', async () => {
  const { session, statements } = sessionFixture(); let destroyed = 0;
  session.connection = { destroy() { destroyed++; }, query(options) {
    statements.push(options.sql); const emitter = new EventEmitter();
    setImmediate(() => session.cancelTask('task')); return emitter;
  } };
  await assert.rejects(session.analyzeQuery('SELECT 1', 1000, 'task'), error => error.code === 'QUERY_CANCELED');
  assert.deepEqual(statements, ['SELECT @@SESSION.autocommit AS value']); assert.equal(destroyed, 1); assert.equal(session.activeTask, null);
});

test('export cannot replay manually entered EXPLAIN ANALYZE, including executable comments and aliases', async () => {
  for (const sql of ['EXPLAIN ANALYZE SELECT 1', 'DESC ANALYZE SELECT 1', 'DESCRIBE ANALYZE SELECT 1',
    'ANALYZE FORMAT=JSON SELECT 1', '/* comment */ EXPLAIN /* comment */ ANALYZE SELECT 1',
    '/*!80018 EXPLAIN ANALYZE */ SELECT 1']) {
    assert.throws(() => assertPlanExport(sql), error => error.code === 'ANALYZE_EXPORT_REPLAY_BLOCKED');
    const { session, statements } = sessionFixture('8.4.7');
    await assert.rejects(session.exportQueryFile({ sql, format: 'json' }, async () => {}));
    assert.equal(statements.length, 0);
  }
  assert.doesNotThrow(() => assertPlanExport('EXPLAIN FORMAT=JSON SELECT 1'));
  assert.doesNotThrow(() => assertPlanExport("SELECT 'ANALYZE' AS label"));
});
