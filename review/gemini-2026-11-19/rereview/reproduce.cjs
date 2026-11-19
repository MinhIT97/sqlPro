'use strict';

// Review-only observations on c7df696 + 2489b3a; no production data or runtime edits.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const req = relative => require(path.join(root, relative));
const { DatabaseSession } = req('electron/database.cjs');
const { SchemaSnapshotCollector, computeSchemaFingerprint } = req('electron/schema-snapshot.cjs');
const { SchemaMigrationGenerator } = req('electron/schema-migration-generator.cjs');
const { SchemaMigrationAdmission } = req('electron/schema-migration-admission.cjs');
const { SchemaMigrationExecutor } = req('electron/schema-migration-executor.cjs');
const { DataSyncPlanService } = req('electron/data-sync-plan-service.cjs');
const { DataSyncExecutor } = req('electron/data-sync-executor.cjs');
const { BackupReplicaManager } = req('electron/backup-replica-manager.cjs');
const { saveBackupFile, readManifest, manifestPathFor } = req('electron/backup-file.cjs');
const { loadRenderer } = req('test/helpers/renderer.cjs');
const out = {};

async function connectionProbe() {
  const mysql = require('mysql2'), createConnection = mysql.createConnection;
  const connections = [];
  mysql.createConnection = () => {
    const connection = new EventEmitter();
    connection.connect = done => done(); connection.end = done => done(); connection.destroy = () => {};
    connections.push(connection); return connection;
  };
  try {
    const session = new DatabaseSession({});
    session.raw = async () => ({ rows: [{ version: 'fixture' }] }); session.readTlsState = async () => ({});
    await session.connect(); await session.connect();
    const deadBeforeOldError = session.dead;
    connections[0].emit('error', Object.assign(new Error('late old-connection error'), { code: 'PROTOCOL_CONNECTION_LOST' }));
    let nextQueryError;
    try { session.ensureOpen(); } catch (error) { nextQueryError = error.code; }
    out.connectionLifecycle = { oldAndCurrentAreDistinct: connections[0] !== connections[1], currentConnectionStillInstalled: session.connection === connections[1], deadBeforeOldError, deadAfterOldError: session.dead, nextQueryError };
    await session.close();
  } finally { mysql.createConnection = createConnection; }
  const main = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8');
  const handlerSource = main.slice(0, main.indexOf("const { app, BrowserWindow"));
  const marker = crypto.randomBytes(12).toString('hex');
  const childSource = handlerSource + `\nPromise.reject(Object.assign(new Error('fixture rejection'), {sql: "UPDATE users SET password='${marker}'"}));\nsetTimeout(()=>{throw new Error('fixture fatal invariant');},5);\nsetTimeout(()=>console.log('continued-after-fatal'),20);`;
  const child = spawnSync(process.execPath, ['-e', childSource], { encoding: 'utf8', timeout: 3000 });
  out.globalErrors = { exitStatus: child.status, rawSqlSecretMarkerLogged: child.stderr.includes(marker), continuedAfterUnrecognizedException: child.stdout.includes('continued-after-fatal') };
}

async function dbProbe(port) {
  const mysql = require('mysql2/promise');
  const admin = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root' });
  const sourceDb = `sqlpro_deep_${crypto.randomBytes(6).toString('hex')}`, targetDb = sourceDb + '_target';
  const created = [], sessions = [];
  const open = async (database, id) => {
    const profile = { id, host: '127.0.0.1', port, user: 'root', database, readOnly: false, environment: 'local' };
    const session = new DatabaseSession(profile); sessions.push(session); await session.connect();
    const context = { profileId: id, sessionId: `editor_${id}`, generation: 0, profileFingerprint: computeSchemaFingerprint(profile) };
    return { profile, session, collector: new SchemaSnapshotCollector(session, context) };
  };
  try {
    out.server = (await admin.query('SELECT VERSION() AS version'))[0][0].version;
    for (const name of [sourceDb, targetDb]) { await admin.query(`CREATE DATABASE \`${name}\``); created.push(name); }
    await admin.query(`USE \`${sourceDb}\``);
    await admin.query("CREATE TABLE edge (id INT PRIMARY KEY, state ENUM('pending','Done') COLLATE utf8mb4_bin NULL, qty INT CHECK (qty > 0), note VARCHAR(30) COMMENT 'C:\\\\new') ENGINE=InnoDB COLLATE=utf8mb4_bin");
    await admin.query('CREATE TABLE `Twin` (id INT PRIMARY KEY) ENGINE=InnoDB');
    await admin.query('CREATE TABLE `twin` (other_id INT PRIMARY KEY) ENGINE=InnoDB');
    const source = await open(sourceDb, 'source'), target = await open(targetDb, 'target');
    const sourceSnapshot = await source.collector.collect(sourceDb), targetSnapshot = await target.collector.collect(targetDb);
    const candidate = new SchemaMigrationGenerator().generateCandidatePlan({ sourceSnapshot, targetSnapshot });
    const admission = new SchemaMigrationAdmission(), admitted = admission.admitCandidate(candidate);
    const profiles = { source: source.profile, target: target.profile };
    const executor = new SchemaMigrationExecutor({ consumePlan: token => admission.consumePlan(token), getProfileWithSecrets: id => profiles[id], fingerprintProfile: computeSchemaFingerprint, checkContext: async () => true, verifySource: () => source.collector.collect(sourceDb) });
    const result = await executor.executePlan({ planToken: admitted.planToken });
    const metadata = (await admin.query(`SELECT TABLE_SCHEMA AS db, COLUMN_NAME AS name, COLUMN_TYPE AS type, COLUMN_COMMENT AS comment FROM information_schema.COLUMNS WHERE TABLE_SCHEMA IN (?,?) AND TABLE_NAME='edge' AND COLUMN_NAME IN ('state','note') ORDER BY TABLE_SCHEMA,COLUMN_NAME`, [sourceDb, targetDb]))[0];
    const checks = (await admin.query("SELECT TABLE_SCHEMA AS db, COUNT(*) AS count FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA IN (?,?) AND TABLE_NAME='edge' AND CONSTRAINT_TYPE='CHECK' GROUP BY TABLE_SCHEMA", [sourceDb, targetDb]))[0];
    const insert = async db => {
      try { await admin.query(`INSERT INTO \`${db}\`.edge(id,qty) VALUES(1,-1)`); return { accepted: true }; }
      catch (error) { return { accepted: false, code: error.code }; }
    };
    const tableNames = (await admin.query('SELECT TABLE_SCHEMA AS db, TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA IN (?,?) ORDER BY TABLE_SCHEMA,TABLE_NAME', [sourceDb, targetDb]))[0];
    const insertEnum = async db => {
      try { await admin.query(`INSERT INTO \`${db}\`.edge(id,state,qty) VALUES(2,'pending',1)`); return { accepted: true }; }
      catch (error) { return { accepted: false, code: error.code }; }
    };
    out.migration = { sourceCoverage: sourceSnapshot.coverage, candidate: candidate.status, success: result.success, executedCount: result.executedCount, sourceTables: sourceSnapshot.tables.map(table => table.name), tableNames, generatedSql: candidate.statements.map(s => s.sql), metadata, checks, enumInsert: { source: await insertEnum(sourceDb), target: await insertEnum(targetDb) }, negativeQuantity: { source: await insert(sourceDb), target: await insert(targetDb) } };
    await admin.query(`CREATE TABLE \`${targetDb}\`.sync_guard (id INT PRIMARY KEY, val VARCHAR(20) COLLATE utf8mb4_0900_ai_ci) ENGINE=InnoDB`);
    await admin.query(`INSERT INTO \`${targetDb}\`.sync_guard VALUES(1,'OLD')`);
    const planService = new DataSyncPlanService();
    const preview = planService.createSyncPlan({
      sourceScope: { profileId: 'source', database: sourceDb, table: 'sync_guard' },
      targetScope: { profileId: 'target', database: targetDb, table: 'sync_guard' },
      diffReport: { primaryKeys: ['id'], columns: [{ name: 'id', type: 'int' }, { name: 'val', type: 'varchar(20)' }], different: [{ rowKey: '["1"]', sourceRow: { id: 1, val: 'new' }, targetRow: { id: 1, val: 'old' }, differences: [{ column: 'val' }] }] }
    });
    const sync = new DataSyncExecutor({ consumePlan: token => planService.consumePlan(token), getProfileWithSecrets: () => target.profile });
    const syncResult = await sync.executeSyncPlan({ planToken: preview.planToken });
    out.syncGuard = { originalAtPreview: 'old', concurrentValueBeforeApply: 'OLD', execution: syncResult, target: (await admin.query(`SELECT val FROM \`${targetDb}\`.sync_guard WHERE id=1`))[0][0] };
  } finally {
    for (const session of sessions) await session.close();
    for (const name of created.reverse()) await admin.query(`DROP DATABASE \`${name}\``);
    await admin.end();
  }
}

async function replicaProbe() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-deep-replica-'));
  try {
    const source = path.join(directory, 'source.sql'), destinationDir = path.join(directory, 'dest');
    const text = 'SELECT 1;\n';
    await saveBackupFile(source, async write => { await write(text); return { bytes: Buffer.byteLength(text) }; });
    const manager = new BackupReplicaManager();
    const result = await manager.createReplica({ sourceFilePath: source, destinationDir });
    out.replica = { sourceManifestExists: fs.existsSync(manifestPathFor(source)), result, destinationCanonicalManifestExists: fs.existsSync(manifestPathFor(result.replicaPath)), destinationRead: await readManifest(result.replicaPath) };
    // The legacy sidecar path also fails to keep a colliding manifest paired.
    fs.writeFileSync(`${source}.manifest.json`, JSON.stringify({ tag: 'source' }));
    const dest2 = path.join(directory, 'dest2'); fs.mkdirSync(dest2);
    fs.writeFileSync(path.join(dest2, 'source.sql.manifest.json'), JSON.stringify({ tag: 'unrelated' }));
    const collision = await manager.createReplica({ sourceFilePath: source, destinationDir: dest2 });
    out.replica.legacyCollision = { result: collision, pairedManifest: JSON.parse(fs.readFileSync(`${collision.replicaPath}.manifest.json`, 'utf8')), publishedFiles: fs.readdirSync(dest2) };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

async function rendererProbe() {
  let resolveReplica, resolveInfo, replicaClick;
  const input = { value: '/tmp/review-only' }, button = { disabled: false, addEventListener: (name, fn) => { replicaClick = fn; } };
  const dialog = { open: false, innerHTML: '', showModal() { this.open = true; }, close() { this.open = false; } };
  const elements = new Map([['#modal', dialog], ['#replicaDestDirInput', input], ['#confirmCreateReplicaBtn', button]]);
  const r = loadRenderer({ elements, desktop: { db: { createBackupReplica: () => new Promise(resolve => { resolveReplica = resolve; }), inspectBackupContainer: () => new Promise(resolve => { resolveInfo = resolve; }) } } });
  r.evaluate("app.connection={id:'p'}; app.database='db'; app.selectedBackupId='b'; app.backups=[{id:'b',checksum:'a',bytes:10}]");
  await r.evaluate("runBackupManagerAction('create-replica')");
  const pendingReplica = replicaClick();
  r.evaluate("closeModal(); modal('<h2>Unrelated dialog</h2>');");
  resolveReplica({ ok: true, data: { replicaPath: '/tmp/review-result' } });
  await pendingReplica;
  out.renderer = { replicaCompletionClosedNewDialog: !dialog.open };
  const pendingInfo = r.evaluate("runBackupManagerAction('container-info')");
  r.evaluate("app.connection={id:'other'}; app.database='other'; modal('<h2>Other profile dialog</h2>');");
  resolveInfo({ ok: true, data: { format: 'test', encrypted: false } });
  await pendingInfo;
  out.renderer.containerInfoReplacedNewDialog = dialog.innerHTML.includes('Thông tin Container Backup');
}

(async () => {
  await connectionProbe();
  await replicaProbe();
  await rendererProbe();
  if (process.env.REVIEW_MYSQL_PORT) await dbProbe(Number(process.env.REVIEW_MYSQL_PORT));
  console.log(JSON.stringify(out, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
