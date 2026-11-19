'use strict';
// Historical reproduction on cf907bd, before N01-N07 fixes. For current
// acceptance run test/review-nov19-regressions.test.cjs and the opt-in DB suite.
// Review probes only. Own temporary DBs, real services; Main VM uses a fake SQL driver.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const root = path.resolve(__dirname, '../..');
const req = relative => require(path.join(root, relative));
const { DatabaseSession } = req('electron/database.cjs');
const { DataDiffService } = req('electron/data-diff-service.cjs');
const { SchemaSnapshotCollector, computeSchemaFingerprint } = req('electron/schema-snapshot.cjs');
const { SchemaMigrationService } = req('electron/schema-migration-service.cjs');
const { SchemaMigrationAdmission } = req('electron/schema-migration-admission.cjs');
const { SchemaMigrationExecutor } = req('electron/schema-migration-executor.cjs');
const out = {};
async function mainProbe() {
  const filename = path.join(root, 'test/main-schema-migration.test.cjs');
  const source = fs.readFileSync(filename, 'utf8');
  const body = source.slice(source.indexOf('function fixture()'), source.indexOf('\ntest('));
  const makeMain = new Function('require', 'path', 'vm', 'fs', 'crypto', 'DatabaseSession', '__dirname', body + ';return fixture;')(
    require('node:module').createRequire(filename), path, vm, fs, crypto, DatabaseSession, path.dirname(filename));
  const r = makeMain();
  r.profiles.src = { readOnly: true }; r.profiles.tgt = { readOnly: false };
  r.controls.onRaw = sql => sql.includes('FROM information_schema.COLUMNS') && sql.includes('COLUMN_NAME AS name')
    ? { result: [{ name: 'id', type: 'int', nullable: 'NO', keyType: 'PRI', extra: '', position: 1 }] } : undefined;
  const started = await r.call('db:start-data-diff', { sourceProfileId: 'src', targetProfileId: 'tgt', sourceDb: 'source', targetDb: 'target', sourceTable: 'users', targetTable: 'users' });
  const service = r.evaluate('dataDiffService');
  await service.jobs.get(started.data.jobId).promise;
  out.mainOwnedSync = { realGetJobType: typeof service.getJob,
    diffStatus: service.getDiffStatus(started.data.jobId).status,
    scopesStored: { source: service.jobs.get(started.data.jobId).sourceScope || null, target: service.jobs.get(started.data.jobId).targetScope || null },
    legitimatePlan: await r.call('db:create-data-sync-plan', { jobId: started.data.jobId }) };
  const forged = await r.call('db:create-data-sync-plan', { jobId: 'not-a-real-main-job',
    sourceScope: { profileId: 'src', database: 'made_up_source', table: 'users' }, targetScope: { profileId: 'tgt', database: 'made_up_target', table: 'users' },
    diffReport: { primaryKeys: ['id'], columns: [{ name: 'id', type: 'int' }], onlyInSource: [{ rowKey: '["42"]', row: { id: 42 } }], different: [], onlyInTarget: [] } });
  out.mainOwnedSync.forgedPlan = { ok: forged.ok, inserts: forged.data?.counts?.inserts, database: forged.data?.targetScope?.database, error: forged.error };
  out.mainOwnedSync.apply = await r.call('db:apply-data-sync-plan', { planToken: forged.data?.planToken });
  await service.clear();
}
async function databaseProbe(port, maria) {
  const admin = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root' });
  const suffix = crypto.randomBytes(6).toString('hex'), db = `sqlpro_r19_${suffix}`, targetDb = db + '_target';
  const sessions = [], created = [];
  const open = async (database, id) => { const p = { id, host: '127.0.0.1', port, user: 'root', password: '', database, environment: 'local', readOnly: false };
    const s = new DatabaseSession(p); sessions.push(s); await s.connect(); return { s, p }; };
  try {
    for (const name of [db, targetDb]) { await admin.query(`CREATE DATABASE \`${name}\``); created.push(name); }
    await admin.query(`USE \`${db}\``);
    if (!maria) {
      for (const name of ['pad_src','pad_dst']) await admin.query(`CREATE TABLE ${name}(id VARCHAR(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin PRIMARY KEY, val INT) ENGINE=InnoDB`);
      await admin.query("INSERT INTO pad_src VALUES('key',1)"); await admin.query("INSERT INTO pad_dst VALUES('key ',2)");
      const p = { id: 'diff', host: '127.0.0.1', port, user: 'root', password: '', readOnly: true };
      const diff = new DataDiffService({ store: { getWithSecrets: () => p } });
      try {
        const { jobId } = await diff.startDiff({ sourceProfileId: 'diff', targetProfileId: 'diff', sourceDb: db, targetDb: db, sourceTable: 'pad_src', targetTable: 'pad_dst' });
        await diff.jobs.get(jobId).promise;
        const result = diff.getDiffStatus(jobId);
        const equality = (await admin.query('SELECT s.id=t.id AS sameKey FROM pad_src s JOIN pad_dst t ON s.id=t.id'))[0];
        out.binaryCollation = { serverEquality: equality, jobStatus: result.status, summary: result.report?.summary, coverage: result.report?.coverage };
      } finally { await diff.clear(); }
      // Only the actual collector -> generator -> admission -> internal executor path below writes targetDb.
      await admin.query('CREATE TABLE ddl_source (id INT PRIMARY KEY, value VARCHAR(100) DEFAULT ?) ENGINE=InnoDB', ['C:\\new']);
      const { s: src, p: srcProfile } = await open(db, 'source');
      const { s: tgt, p: tgtProfile } = await open(targetDb, 'target');
      const profiles = { source: srcProfile, target: tgtProfile };
      const context = profile => ({ profileId: profile.id, sessionId: `editor_${profile.id}`, generation: 0, profileFingerprint: computeSchemaFingerprint(profile) });
      const srcCollector = new SchemaSnapshotCollector(src, context(srcProfile));
      const sourceSnapshot = await srcCollector.collect(db), targetSnapshot = await new SchemaSnapshotCollector(tgt, context(tgtProfile)).collect(targetDb);
      // Exclude the independent Data Diff fixtures from the migration scenario by dropping before recapture.
      await admin.query('DROP TABLE pad_src,pad_dst');
      const freshSource = await srcCollector.collect(db);
      const service = new SchemaMigrationService();
      const candidate = service.createCandidatePlan({ sourceSnapshotId: service.storeSnapshot(freshSource), targetSnapshotId: service.storeSnapshot(targetSnapshot) });
      const admission = new SchemaMigrationAdmission();
      const admitted = admission.admitCandidate(candidate);
      const executor = new SchemaMigrationExecutor({ consumePlan: token => admission.consumePlan(token), getProfileWithSecrets: id => profiles[id], fingerprintProfile: computeSchemaFingerprint,
        checkContext: async () => true, verifySource: async () => srcCollector.collect(db) });
      let execution;
      try { execution = await executor.executePlan({ planToken: admitted.planToken }); } catch (e) { execution = { code: e.code, executedCount: e.executedCount }; }
      const defaults = (await admin.query('SELECT TABLE_SCHEMA AS db,COLUMN_DEFAULT AS value FROM information_schema.COLUMNS WHERE TABLE_SCHEMA IN (?,?) AND TABLE_NAME=? AND COLUMN_NAME=? ORDER BY TABLE_SCHEMA', [db,targetDb,'ddl_source','value']))[0];
      out.generatorDefault = { sourceCoverage: sourceSnapshot.coverage, planStatus: candidate.status, sql: candidate.statements.map(s => s.sql), internalExecution: { success: execution.success, code: execution.code, executedCount: execution.executedCount }, defaults };
    } else {
      await admin.query("CREATE TABLE optional_json (id INT PRIMARY KEY, payload LONGTEXT, CHECK(JSON_VALID(payload) OR payload='plain')) ENGINE=InnoDB");
      await admin.query("INSERT INTO optional_json VALUES(1,'plain')");
      const { s } = await open(db, 'maria');
      const cols = await s.listColumns(db, 'optional_json', { fresh: true });
      const col = cols.find(c => c.name === 'payload');
      let normalize;
      try { normalize = { value: req('row-values.js').normalizeValue(col, 'plain') }; } catch(e) { normalize = { error: e.message }; }
      out.jsonConstraint = { serverAcceptsPlain: (await admin.query('SELECT payload FROM optional_json WHERE id=1'))[0][0].payload, metadata: col, normalize };
    }
  } finally {
    for (const session of sessions) await session.close().catch(() => {});
    for (const name of created.reverse()) await admin.query(`DROP DATABASE \`${name}\``);
    await admin.end();
  }
}
async function main() {
  await mainProbe();
  const { DataSyncExecutor } = req('electron/data-sync-executor.cjs');
  const statements = [];
  const columns = [{ name: 'id', type: 'int', key: 'PRI' }];
  const worker = {
    connect: async () => {}, useDatabase: async () => {}, close: async () => {},
    listColumns: async () => columns,
    raw: async sql => { statements.push(sql); return { result: [] }; }
  };
  const syncExecutor = new DataSyncExecutor({
    consumePlan: () => ({ targetScope: { profileId: 'target', database: 'review', table: 'items' }, columns, primaryKeys: ['id'], operations: [{ type: 'INSERT', values: { id: 42 } }] }),
    getProfileWithSecrets: () => ({ readOnly: false, environment: 'local' }),
    createSession: () => worker
  });
  const syncResult = await syncExecutor.executeSyncPlan({ planToken: 'review-only' });
  out.syncUnknownEngine = { result: syncResult, insertIssued: statements.some(sql => sql.startsWith('INSERT')), commitIssued: statements.includes('COMMIT') };
  const sandbox = vm.createContext({}); vm.runInContext(fs.readFileSync(path.join(root,'row-values.js'),'utf8'), sandbox);
  try { sandbox.SqlRowValues.normalizeValue({ name: 'text', type: 'varchar(10)', nullable: 'YES' }, {}); }
  catch(e) { out.rendererNoBuffer = { name: e.name, message: e.message }; }
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const sanitized = req('audit-log.js').sanitizeAuditSummary(pem);
  out.auditPrivateKey = { retainsHeader: sanitized.includes('BEGIN PRIVATE KEY'), retainsKeyBytes: sanitized.includes(pem.split('\n')[1]), entireKeyLength: pem.trim().length, summaryLength: sanitized.length };
  if (process.env.REVIEW_MYSQL_PORT) await databaseProbe(Number(process.env.REVIEW_MYSQL_PORT), false);
  if (process.env.REVIEW_MARIA_PORT) await databaseProbe(Number(process.env.REVIEW_MARIA_PORT), true);
  console.log(JSON.stringify(out, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
