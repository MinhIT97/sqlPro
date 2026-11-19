'use strict';

// Observation probe, not an acceptance suite. Only disposable loopback DBs.
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const root = path.resolve(__dirname, '../../..');
const fromRoot = name => require(path.join(root, name));
const mysql = fromRoot('node_modules/mysql2');
const { DatabaseSession } = fromRoot('electron/database.cjs');
const { SchemaSnapshotCollector, computeSchemaFingerprint } = fromRoot('electron/schema-snapshot.cjs');
const { SchemaMigrationGenerator } = fromRoot('electron/schema-migration-generator.cjs');
const { SchemaMigrationAdmission } = fromRoot('electron/schema-migration-admission.cjs');
const { SchemaMigrationExecutor } = fromRoot('electron/schema-migration-executor.cjs');
const { DataSyncPlanService } = fromRoot('electron/data-sync-plan-service.cjs');
const { DataSyncExecutor } = fromRoot('electron/data-sync-executor.cjs');

async function connectionMetadata() {
  const original = mysql.createConnection, connections = [];
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  mysql.createConnection = () => {
    const c = new EventEmitter();
    c.connect = callback => callback(); c.end = callback => callback(); c.destroy = () => {};
    connections.push(c); return c;
  };
  const session = new DatabaseSession({});
  try {
    let reads = 0;
    session.raw = async () => {
      if (++reads === 1) { entered(); return new Promise(resolve => { release = resolve; }); }
      return { rows: [{ version: '8.4-new' }] };
    };
    session.readTlsState = async () => ({ encrypted: true });
    const first = session.connect(); await ready;
    await session.connect();
    const before = session.version;
    release({ rows: [{ version: '5.7-old' }] }); await first;
    return { before, after: session.version, currentConnectionUnchanged: session.connection === connections[1], staleConnectResolved: true };
  } finally { await session.close(); mysql.createConnection = original; }
}

async function database(port) {
  const admin = await fromRoot('node_modules/mysql2/promise').createConnection({ host: '127.0.0.1', port, user: 'root' });
  const prefix = 'sqlpro_pc_' + crypto.randomBytes(6).toString('hex');
  const sourceDb = prefix + '_src', targetDb = prefix + '_tgt', created = [], sessions = [];
  const profile = (database, id) => ({ id, host: '127.0.0.1', port, user: 'root', database, environment: 'local' });
  const open = async (database, id) => {
    const p = profile(database, id), session = new DatabaseSession(p);
    await session.connect(); sessions.push(session);
    return { profile: p, session, collector: new SchemaSnapshotCollector(session, { profileId: id, sessionId: 'editor_' + id, generation: 0, profileFingerprint: computeSchemaFingerprint(p) }) };
  };
  const result = {};
  try {
    for (const name of [sourceDb, targetDb]) { await admin.query(`CREATE DATABASE \`${name}\``); created.push(name); }
    const source = await open(sourceDb, 'src'), target = await open(targetDb, 'tgt');
    result.engineVersion = (await admin.query('SELECT VERSION() AS version'))[0][0].version;
    await admin.query(`CREATE TABLE \`${sourceDb}\`.column_order(id INT PRIMARY KEY, added INT, tail INT) ENGINE=InnoDB`);
    await admin.query(`CREATE TABLE \`${targetDb}\`.column_order(id INT PRIMARY KEY, tail INT) ENGINE=InnoDB`);
    const candidate = new SchemaMigrationGenerator().generateCandidatePlan({ sourceSnapshot: await source.collector.collect(sourceDb), targetSnapshot: await target.collector.collect(targetDb) });
    assert.equal(candidate.status, 'ready');
    const admission = new SchemaMigrationAdmission(), admitted = admission.admitCandidate(candidate), profiles = { src: source.profile, tgt: target.profile };
    const executor = new SchemaMigrationExecutor({ consumePlan: token => admission.consumePlan(token), getProfileWithSecrets: id => profiles[id], fingerprintProfile: computeSchemaFingerprint, checkContext: async () => true, verifySource: () => source.collector.collect(sourceDb) });
    const applied = await executor.executePlan({ planToken: admitted.planToken });
    const cols = async db => (await admin.query('SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [db, 'column_order']))[0].map(c => c.name);
    result.columnOrder = { success: applied.success, sql: candidate.statements[0].sql, source: await cols(sourceDb), target: await cols(targetDb) };

    const service = new DataSyncPlanService();
    const makePlan = (name, columns, insert) => service.createSyncPlan({
      sourceScope: { profileId: 'src', database: sourceDb, table: name }, targetScope: { profileId: 'tgt', database: targetDb, table: name },
      diffReport: { primaryKeys: ['id'], columns, onlyInSource: insert ? [{ rowKey: '[1]', row: { id: 1, v: 'pending' } }] : [], different: insert ? [] : [{ rowKey: '[1]', sourceRow: { id: 1, v: 'new' }, targetRow: { id: 1, v: 'old' }, differences: [{ column: 'v' }] }] }
    });
    await admin.query(`CREATE TABLE \`${targetDb}\`.enum_drift(id INT PRIMARY KEY, v ENUM('pending','done') COLLATE utf8mb4_unicode_ci) ENGINE=InnoDB`);
    const enumColumns = await target.session.listColumns(targetDb, 'enum_drift', { fresh: true });
    const enumPlan = makePlan('enum_drift', enumColumns, true);
    await admin.query(`ALTER TABLE \`${targetDb}\`.enum_drift MODIFY v ENUM('PENDING','DONE') COLLATE utf8mb4_unicode_ci`);
    const enumExecutor = new DataSyncExecutor({ consumePlan: token => service.consumePlan(token), getProfileWithSecrets: () => target.profile });
    const enumApplied = await enumExecutor.executeSyncPlan({ planToken: enumPlan.planToken });
    result.enumDrift = { success: enumApplied.success, requested: 'pending', stored: (await admin.query(`SELECT v FROM \`${targetDb}\`.enum_drift`))[0][0].v };

    await admin.query(`CREATE TABLE \`${targetDb}\`.pk_race(id INT PRIMARY KEY, v VARCHAR(20)) ENGINE=InnoDB`);
    await admin.query(`INSERT INTO \`${targetDb}\`.pk_race VALUES(1,'old')`);
    const pkColumns = await target.session.listColumns(targetDb, 'pk_race', { fresh: true });
    const pkPlan = makePlan('pk_race', pkColumns, false);
    let affectedRows, raced = false;
    const pkExecutor = new DataSyncExecutor({ consumePlan: token => service.consumePlan(token), getProfileWithSecrets: () => target.profile, createSession: p => {
      const worker = new DatabaseSession(p), raw = worker.raw.bind(worker);
      worker.raw = async (sql, ...args) => {
        if (sql === 'START TRANSACTION' && !raced) {
          raced = true;
          await admin.query(`ALTER TABLE \`${targetDb}\`.pk_race DROP PRIMARY KEY`);
          await admin.query(`INSERT INTO \`${targetDb}\`.pk_race VALUES(1,'old')`);
        }
        const response = await raw(sql, ...args);
        if (sql.startsWith('UPDATE ')) affectedRows = response.result.affectedRows;
        return response;
      };
      return worker;
    } });
    const pkApplied = await pkExecutor.executeSyncPlan({ planToken: pkPlan.planToken });
    result.pkRace = { success: pkApplied.success, committedCount: pkApplied.committedCount, affectedRows, rows: (await admin.query(`SELECT id,v FROM \`${targetDb}\`.pk_race`))[0] };
    return result;
  } finally {
    for (const session of sessions) await session.close();
    for (const name of created.reverse()) await admin.query(`DROP DATABASE \`${name}\``);
    await admin.end();
  }
}

(async () => {
  const observed = { connectionMetadata: await connectionMetadata() };
  const port = Number(process.env.SQLPRO_REVIEW_MYSQL_PORT);
  if (port) observed.database = await database(port);
  console.log(JSON.stringify(observed, null, 2));
})().catch(err => { console.error(err.code || 'PROBE_FAILED'); process.exitCode = 1; });
