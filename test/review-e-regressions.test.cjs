'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { DataSyncExecutor } = require('../electron/data-sync-executor.cjs');
const { SchemaMigrationGenerator } = require('../electron/schema-migration-generator.cjs');
const { DatabaseSession } = require('../electron/database.cjs');

const columns = () => [{ name: 'id', type: 'int', key: 'PRI' }, { name: 'v', type: 'varchar(20)', key: '' }];
const operation = type => ({ type, values: { id: 1, v: 'new' }, originalValues: { id: 1, v: 'old' }, changedColumns: ['v'], pkValues: [1] });
function syncFixture(type = 'UPDATE') {
  const calls = [], meta = columns();
  const plan = { targetScope: { profileId: 'p', database: 'd', table: 't' }, primaryKeys: ['id'], columns: meta, operations: [operation(type)] };
  const worker = { connect: async () => {}, useDatabase: async () => {}, close: async () => {}, listColumns: async () => meta,
    raw: async sql => { calls.push(sql); return { result: sql.includes('SELECT ENGINE') ? [{ ENGINE: 'InnoDB' }] : sql.includes('SELECT TRIGGER_NAME') ? [] : { affectedRows: 1 } }; } };
  const executor = new DataSyncExecutor({ consumePlan: () => plan, getProfileWithSecrets: () => ({ id: 'p' }), createSession: () => worker });
  return { plan, worker, calls, run: args => executor.executeSyncPlan({ planToken: 'internal', ...args }) };
}

test('E01: schema/PK is revalidated after locks and before UPDATE/DELETE', async () => {
  for (const type of ['UPDATE', 'DELETE']) {
    const f = syncFixture(type); let inTransaction = false;
    const raw = f.worker.raw;
    f.worker.raw = async (...args) => { if (args[0] === 'START TRANSACTION') inTransaction = true; return raw(...args); };
    f.worker.listColumns = async () => inTransaction ? columns().map(c => ({ ...c, key: '' })) : columns();
    await assert.rejects(f.run(), { code: 'TARGET_SCHEMA_DRIFT' });
    assert.equal(f.calls.some(sql => sql.startsWith(type)), false);
    assert.equal(f.calls.includes('COMMIT'), false); assert.ok(f.calls.includes('ROLLBACK'));
  }
});

test('E01: schema is revalidated for every batch and reports earlier commits', async () => {
  const f = syncFixture(); f.plan.operations.push(operation('UPDATE'));
  let changed = false;
  f.worker.listColumns = async () => changed ? columns().map(c => ({ ...c, key: '' })) : columns();
  await assert.rejects(f.run({ batchSize: 1, onProgress: () => { changed = true; } }), err => {
    assert.equal(err.code, 'TARGET_SCHEMA_DRIFT'); assert.equal(err.committedCount, 1); assert.equal(err.partialCommit, true); return true;
  });
  assert.equal(f.calls.filter(sql => sql.startsWith('UPDATE')).length, 1);
  assert.equal(f.calls.filter(sql => sql === 'COMMIT').length, 1); assert.ok(f.calls.includes('ROLLBACK'));
});

test('E01: multiple matched rows never count as one successful UPDATE/DELETE', async () => {
  for (const type of ['UPDATE', 'DELETE']) {
    const f = syncFixture(type), raw = f.worker.raw;
    f.worker.raw = async (...args) => args[0].startsWith(type) ? (f.calls.push(args[0]), { result: { affectedRows: 2 } }) : raw(...args);
    await assert.rejects(f.run(), { code: 'SYNC_ROW_COUNT_MISMATCH' });
    assert.ok(f.calls.includes('ROLLBACK')); assert.equal(f.calls.includes('COMMIT'), false);
  }
});

test('E02: ENUM/SET literal changes are drift in single and multi-table plans', async () => {
  for (const type of ["enum('pending','Done')", "set('a','B')", "enum('Việt','O''Reilly')"]) {
    for (const multi of [false, true]) {
      const f = syncFixture('INSERT'); f.plan.columns[1].type = type;
      if (multi) f.plan.tables = { t: { columns: f.plan.columns, primaryKeys: ['id'] } };
      f.worker.listColumns = async () => [{ ...f.plan.columns[0] }, { ...f.plan.columns[1], type: type.toUpperCase() }];
      await assert.rejects(f.run(), { code: 'TARGET_SCHEMA_DRIFT' });
      assert.equal(f.calls.some(sql => sql.startsWith('INSERT')), false);
    }
  }
});

test('E01/E02: column semantics changed after locking stop DML, while keyword case alone is allowed', async () => {
  for (const [field, before, after] of [['nullable', 'YES', 'NO'], ['default', 'a', 'b'], ['extra', '', 'INVISIBLE'], ['collation', 'utf8mb4_bin', 'utf8mb4_unicode_ci'], ['charset', 'utf8mb4', 'latin1']]) {
    const f = syncFixture(); f.plan.columns[1][field] = before; let locked = false;
    const raw = f.worker.raw;
    f.worker.raw = async (...args) => { if (args[0].startsWith('SELECT 1 FROM')) locked = true; return raw(...args); };
    f.worker.listColumns = async () => f.plan.columns.map(c => ({ ...c, ...(locked && c.name === 'v' ? { [field]: after } : {}) }));
    await assert.rejects(f.run(), { code: 'TARGET_SCHEMA_DRIFT' });
    assert.equal(f.calls.some(sql => sql.startsWith('UPDATE')), false);
  }
  const f = syncFixture('INSERT'); f.plan.columns[1].type = "enum('pending','O''Reilly','Việt')";
  f.worker.listColumns = async () => f.plan.columns.map(c => ({ ...c, type: c.name === 'v' ? "ENUM('pending','O''Reilly','Việt')" : c.type }));
  assert.equal((await f.run()).success, true);
  const escaped = syncFixture('INSERT'); escaped.plan.columns[1].type = "enum('C:\\new')";
  await assert.rejects(escaped.run(), { code: 'SYNC_TYPE_SQL_MODE_UNSUPPORTED' });
  assert.equal(escaped.calls.some(sql => sql.startsWith('INSERT')), false);
});

const table = names => ({ name: 't', engine: 'InnoDB', columns: names.map(name => ({ name, type: 'int', nullable: true, default: null })), indexes: [], foreignKeys: [], foreignKeysStatus: 'complete', checkConstraintsStatus: 'complete', checkConstraints: [] });
const snapshot = (id, names) => ({ database: id, engine: 'MySQL', scope: { profileId: id }, coverage: 'complete', tables: [table(names)], views: [], routines: [], triggers: [], events: [] });
test('E03: non-append additions and reordered existing columns block before DDL', () => {
  for (const [src, tgt] of [[['id', 'added', 'tail'], ['id', 'tail']], [['added', 'id'], ['id']], [['tail', 'id'], ['id', 'tail']]]) {
    const p = new SchemaMigrationGenerator().generateMigrationPlan({ sourceSnapshot: snapshot('s', src), targetSnapshot: snapshot('t', tgt) });
    assert.equal(p.status, 'blocked'); assert.equal(p.blockReason, 'COLUMN_ORDER_REVIEW_REQUIRED'); assert.deepEqual(p.statements, []);
  }
});

test('E03: append-only column plans bind expected order after every statement', () => {
  const p = new SchemaMigrationGenerator().generateMigrationPlan({ sourceSnapshot: snapshot('s', ['id', 'a', 'b']), targetSnapshot: snapshot('t', ['id']) });
  assert.equal(p.status, 'ready');
  assert.deepEqual(p.statements.map(s => s.postCondition.expectedColumnOrder), [['id', 'a'], ['id', 'a', 'b']]);
});

test('E04: stale VERSION/TLS completion rejects without publishing metadata on the new connection', async () => {
  const mysql = require('mysql2'), original = mysql.createConnection;
  try {
    for (const phase of ['version', 'tls']) {
      const connections = []; let release, entered;
      const ready = new Promise(resolve => { entered = resolve; });
      mysql.createConnection = () => { const c = new EventEmitter(); c.connect = cb => cb(); c.end = cb => cb(); c.destroy = () => {}; connections.push(c); return c; };
      const session = new DatabaseSession({}); let reads = 0, tlsReads = 0;
      session.raw = async () => {
        if (++reads === 1 && phase === 'version') { entered(); return new Promise(resolve => { release = resolve; }); }
        return { rows: [{ version: reads === 1 ? 'old-version' : 'new-version' }] };
      };
      session.readTlsState = async () => {
        if (++tlsReads === 1 && phase === 'tls') { entered(); return new Promise(resolve => { release = resolve; }); }
        return { cipher: 'new-tls' };
      };
      const first = session.connect(); const rejected = assert.rejects(first, { code: 'SESSION_CLOSED' });
      await ready; await session.connect();
      const current = session.connection;
      release(phase === 'version' ? { rows: [{ version: 'old-version' }] } : { cipher: 'old-tls' });
      await rejected;
      assert.equal(session.connection, current); assert.equal(current, connections[1]);
      assert.equal(session.version, 'new-version'); assert.equal(session.tls.cipher, 'new-tls'); assert.equal(session.dead, false);
      if (phase === 'version') assert.equal(tlsReads, 1);
      await session.close();
    }
  } finally { mysql.createConnection = original; }
});

test('E04: late raw command callback cannot publish transaction status on a replacement connection', async () => {
  const mysql = require('mysql2'), original = mysql.createConnection; let release;
  mysql.createConnection = () => {
    const c = new EventEmitter(); c.connect = cb => cb(); c.end = cb => cb(); c.destroy = () => {};
    c.query = (sql, _params, cb) => {
      if (sql === 'START TRANSACTION') { release = cb; return; }
      cb(null, sql.startsWith('SELECT VERSION') ? [{ version: 'current' }] : sql.startsWith('SHOW SESSION') ? [] : { serverStatus: 2 });
    };
    return c;
  };
  const session = new DatabaseSession({});
  try {
    await session.connect();
    const old = session.raw('START TRANSACTION'), rejected = assert.rejects(old, { code: 'SESSION_CLOSED' });
    await session.connect(); await session.raw('COMMIT');
    release(null, { serverStatus: 1 }); await rejected;
    assert.equal(session.inTransaction, false); assert.equal(session.autocommit, true);
    assert.equal(session.version, 'current'); session.ensureOpen();
  } finally { await session.close(); mysql.createConnection = original; }
});
