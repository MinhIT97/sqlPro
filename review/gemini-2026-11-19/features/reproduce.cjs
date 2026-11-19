'use strict';

// Observations only, not an acceptance suite. DB must be disposable loopback.
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../../..');
const load = name => require(path.join(root, name));
const mysql = load('node_modules/mysql2/promise');
const SchemaDiff = load('schema-diff.js');
const { DatabaseSession } = load('electron/database.cjs');
const { SchemaSnapshotCollector, computeSchemaFingerprint } = load('electron/schema-snapshot.cjs');
const { SchemaMigrationGenerator } = load('electron/schema-migration-generator.cjs');
const { SchemaMigrationService } = load('electron/schema-migration-service.cjs');
const { DataSyncPlanService } = load('electron/data-sync-plan-service.cjs');
const { DataSyncExecutor } = load('electron/data-sync-executor.cjs');
const { loadRenderer } = load('test/helpers/renderer.cjs');

async function rendererSchema(sourceDb, targetDb, session, { failSourceColumns = false, drops = false } = {}) {
  const elements = new Map();
  for (const id of ['modal', 'diffTabContent', 'diffSourceProfile', 'diffSourceDb', 'diffTargetProfile', 'diffTargetDb', 'diffSwapBtn', 'diffAllowDropTables', 'diffAllowDropColumns', 'diffIgnoreComments', 'diffIgnoreCollation', 'diffRunCompareBtn', 'diffGoTablesBtn', 'diffGoMigrationBtn', 'diffSelectAllStmts', 'diffCopySqlBtn', 'diffDownloadSqlBtn', 'diffOpenEditorBtn', 'diffApplyTargetBtn']) {
    elements.set('#' + id, { innerHTML: '', open: false, listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; }, showModal() { this.open = true; }, close() { this.open = false; } });
  }
  const ok = data => ({ ok: true, data }); let schemaSnapshotCalls = 0, statements, captured;
  const desktop = { db: {
    databases: async () => ok([sourceDb, targetDb]),
    tables: async db => ok(await session.listTables(db, { fresh: true })),
    columns: async (db, table) => {
      if (failSourceColumns && db === sourceDb) return { ok: false, error: { message: 'fixture permission failure', code: 'ER_TABLEACCESS_DENIED_ERROR' } };
      return ok(await session.listColumns(db, table, { fresh: true }));
    },
    indexes: async (db, table) => ok(await session.listIndexes(db, table, { fresh: true })),
    relations: async (db, table) => ok(await session.listRelations(db, table, { fresh: true })),
    routines: async () => ok([]),
    schemaSnapshot: async () => { schemaSnapshotCalls++; throw new Error('not called'); }
  } };
  const r = loadRenderer({ desktop, elements });
  r.context.window.SchemaDiff = { ...SchemaDiff,
    compareSchemas: (s, t, options) => { captured = { s, t }; return SchemaDiff.compareSchemas(s, t, options); },
    generateMigrationSql: (...args) => { statements = SchemaDiff.generateMigrationSql(...args); return statements; }
  };
  r.context.console = { ...console, warn() {} };
  r.context.fixtureSource = sourceDb;
  r.evaluate("app.connection={id:'fixture',host:'localhost'};app.connections=[app.connection];app.database=fixtureSource");
  await r.evaluate('showSchemaDiffModal()');
  await new Promise(resolve => setImmediate(resolve));
  if (drops) elements.get('#diffAllowDropTables').listeners.change({ target: { checked: true } });
  await elements.get('#diffRunCompareBtn').listeners.click();
  await elements.get('#diffGoMigrationBtn').listeners.click();
  const sql = SchemaDiff.formatMigrationScript(statements, { sourceName: sourceDb, targetName: targetDb });
  return { schemaSnapshotCalls, statements, sql, engineClaim: captured.s.engine,
    checkInventoryPresent: captured.s.tables.some(t => Object.hasOwn(t, 'checkConstraints')),
    footerClaimsFkProtected: elements.get('#diffTabContent').innerHTML.includes('Ràng buộc khóa ngoại luôn được bảo vệ') };
}

async function policyDrift() {
  const columns = [{ name: 'id', type: 'int', key: 'PRI' }], calls = [];
  let profile = { id: 'dst', environment: 'local', readOnly: false }, profileReads = 0;
  const plan = { targetScope: { profileId: 'dst', database: 'fixture', table: 't' }, primaryKeys: ['id'], columns,
    operations: [{ type: 'INSERT', values: { id: 1 } }, { type: 'INSERT', values: { id: 2 } }] };
  const worker = { connect: async () => {}, useDatabase: async () => {}, close: async () => {}, listColumns: async () => columns,
    raw: async sql => { calls.push(sql); return { result: sql.includes('SELECT ENGINE') ? [{ ENGINE: 'InnoDB' }] : sql.includes('SELECT TRIGGER_NAME') ? [] : { affectedRows: 1 } }; } };
  const executor = new DataSyncExecutor({ consumePlan: () => plan, getProfileWithSecrets: () => { profileReads++; return profile; }, createSession: () => worker });
  const result = await executor.executeSyncPlan({ planToken: 'internal-fixture', batchSize: 1,
    onProgress: () => { profile = { ...profile, readOnly: true, environment: 'production' }; } });
  return { success: result.success, committedCount: result.committedCount, profileReads,
    finalReadOnly: profile.readOnly, finalEnvironment: profile.environment, insertCount: calls.filter(sql => sql.startsWith('INSERT')).length };
}

async function dbProbe(port) {
  const admin = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root' });
  const prefix = 'sqlpro_fr_' + crypto.randomBytes(6).toString('hex'), src = prefix + '_src', dst = prefix + '_dst', created = [], sessions = [], profiles = {};
  const open = async (id, database) => {
    const profile = profiles[id] = { id, host: '127.0.0.1', port, user: 'root', database, environment: 'local' };
    const session = new DatabaseSession(profile); await session.connect(); sessions.push(session);
    return { session, collector: new SchemaSnapshotCollector(session, { profileId: id, sessionId: 'editor_' + id, generation: 0, profileFingerprint: computeSchemaFingerprint(profile) }) };
  };
  const result = {};
  try {
    for (const db of [src, dst]) { await admin.query(`CREATE DATABASE \`${db}\``); created.push(db); }
    const source = await open('src', src), target = await open('dst', dst);
    result.version = (await admin.query('SELECT VERSION() AS version'))[0][0].version;
    await admin.query(`CREATE TABLE \`${src}\`.indexed(id INT PRIMARY KEY, qty INT CHECK(qty>0), label VARCHAR(30), KEY idx_label(label)) ENGINE=InnoDB`);
    await admin.query(`INSERT INTO \`${src}\`.indexed VALUES(1,1,'same'),(2,2,'same')`);
    const renderer = await rendererSchema(src, dst, source.session);
    const create = renderer.statements.find(s => s.type === 'CREATE_TABLE');
    await admin.query(`USE \`${dst}\``);
    let createError = null, duplicateCode = null, targetIndexUnique = null;
    try {
      await admin.query(create.sql);
      const indexes = await target.session.listIndexes(dst, 'indexed', { fresh: true });
      targetIndexUnique = indexes.find(i => i.name === 'idx_label').unique;
      try { await admin.query(`INSERT INTO \`${dst}\`.indexed VALUES(1,1,'same'),(2,2,'same')`); }
      catch (err) { duplicateCode = err.code; }
    } catch (err) { createError = err.code; }
    result.rendererFidelity = { ...renderer, targetIndexUnique, duplicateCode, createError };
    if (createError) await admin.query(`CREATE TABLE \`${dst}\`.indexed(id INT PRIMARY KEY, qty INT, label VARCHAR(30)) ENGINE=InnoDB`);
    const scriptSession = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', database: dst });
    try {
      const settings = async () => (await scriptSession.query('SELECT @@SESSION.foreign_key_checks AS fk, @@SESSION.unique_checks AS uq, @@SESSION.sql_mode AS sqlMode'))[0][0];
      const before = await settings();
      const prefixes = renderer.sql.split('\n').filter(line => line.startsWith('SET @OLD_'));
      for (const statement of prefixes) await scriptSession.query(statement);
      let errorCode = null;
      try { await scriptSession.query(create.sql); } catch (err) { errorCode = err.code; }
      result.scriptSettings = { footerClaimsFkProtected: renderer.footerClaimsFkProtected, before, afterDdlError: await settings(), errorCode };
    } finally { await scriptSession.end(); }
    const partial = await rendererSchema(src, dst, source.session, { failSourceColumns: true, drops: true });
    result.partialCapture = { schemaSnapshotCalls: partial.schemaSnapshotCalls, enabledDrops: partial.statements.filter(s => s.type === 'DROP_TABLE' && s.enabled).map(s => s.sql) };
    await admin.query(`DROP TABLE \`${src}\`.indexed`); await admin.query(`DROP TABLE \`${dst}\`.indexed`);

    await admin.query(`CREATE TABLE \`${src}\`.defaults(id INT PRIMARY KEY, v VARCHAR(30) DEFAULT 'pending') ENGINE=InnoDB`);
    const service = new SchemaMigrationService();
    const sourceId = service.storeSnapshot(await source.collector.collect(src)), targetId = service.storeSnapshot(await target.collector.collect(dst));
    const preview = service.createMigrationPlan({ sourceSnapshotId: sourceId, targetSnapshotId: targetId });
    const candidate = service.createCandidatePlan({ sourceSnapshotId: sourceId, targetSnapshotId: targetId });
    const ddl = preview.statements.find(s => s.type === 'CREATE_TABLE');
    let defaultError = null, storedDefault = null;
    try {
      await admin.query(ddl.sql); await admin.query(`INSERT INTO \`${dst}\`.defaults(id) VALUES(1)`);
      storedDefault = (await admin.query(`SELECT v FROM \`${dst}\`.defaults`))[0][0].v;
    } catch (err) { defaultError = err.code; }
    result.previewDefault = { previewStatus: preview.status, candidateStatus: candidate.status, candidateBlock: candidate.blockReason,
      sourceDefault: (await source.session.listColumns(src, 'defaults', { fresh: true })).find(c => c.name === 'v').defaultValue,
      storedDefault, defaultError, sql: ddl.sql };
    await admin.query(`DROP TABLE \`${src}\`.defaults`); await admin.query(`DROP TABLE IF EXISTS \`${dst}\`.defaults`);

    await admin.query(`CREATE TABLE \`${dst}\`.parent(id INT PRIMARY KEY) ENGINE=InnoDB`);
    await admin.query(`CREATE TABLE \`${dst}\`.outside_plan(id INT PRIMARY KEY,pid INT,FOREIGN KEY(pid) REFERENCES \`${dst}\`.parent(id) ON DELETE CASCADE) ENGINE=InnoDB`);
    await admin.query(`INSERT INTO \`${dst}\`.parent VALUES(1)`); await admin.query(`INSERT INTO \`${dst}\`.outside_plan VALUES(10,1)`);
    const columns = await target.session.listColumns(dst, 'parent', { fresh: true }), sync = new DataSyncPlanService();
    const plan = sync.createSyncPlan({ sourceScope: { profileId: 'src', database: src, table: 'parent' }, targetScope: { profileId: 'dst', database: dst, table: 'parent' },
      diffReport: { primaryKeys: ['id'], columns, onlyInTarget: [{ rowKey: '[1]', row: { id: 1 } }] }, options: { includeDeletes: true } });
    const executor = new DataSyncExecutor({ consumePlan: token => sync.consumePlan(token), getProfileWithSecrets: () => profiles.dst });
    const applied = await executor.executeSyncPlan({ planToken: plan.planToken });
    result.cascade = { success: applied.success, committedCount: applied.committedCount, targetTable: 'parent', outsidePlanBefore: 1,
      outsidePlanAfter: (await admin.query(`SELECT COUNT(*) AS n FROM \`${dst}\`.outside_plan`))[0][0].n };
    return result;
  } finally {
    for (const session of sessions) await session.close();
    for (const db of created.reverse()) await admin.query(`DROP DATABASE \`${db}\``);
    await admin.end();
  }
}

(async () => {
  const observed = { policyDrift: await policyDrift() };
  for (const engine of ['MYSQL', 'MARIA']) {
    const port = Number(process.env[`SQLPRO_REVIEW_${engine}_PORT`]);
    if (port) observed[engine] = await dbProbe(port);
  }
  console.log(JSON.stringify(observed, null, 2));
})().catch(err => { console.error(err.code || err.message); process.exitCode = 1; });
