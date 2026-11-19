'use strict';

// Disposable loopback DBs only. All schemas are owned and cleaned by this test.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const { DatabaseSession } = require('../electron/database.cjs');
const { SchemaSnapshotCollector, computeSchemaFingerprint, projectSnapshotForRenderer } = require('../electron/schema-snapshot.cjs');
const { SchemaMigrationService } = require('../electron/schema-migration-service.cjs');
const { DataSyncPlanService } = require('../electron/data-sync-plan-service.cjs');
const { DataSyncExecutor } = require('../electron/data-sync-executor.cjs');
const { splitSqlStatements } = require('../electron/sql-script.cjs');
const { loadRenderer } = require('./helpers/renderer.cjs');

for (const engine of ['MYSQL', 'MARIA']) {
  const port = Number(process.env[`SQLPRO_REVIEW_${engine}_PORT`]);
  test(`F01-F06 ${engine}: UI Main preview and sync dependency/policy safety`, { skip: !port, timeout: 60000 }, async t => {
    const admin = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root' });
    const prefix = 'sqlpro_f_' + crypto.randomBytes(6).toString('hex'), src = prefix + '_src', dst = prefix + '_dst', created = [], sessions = [], users = [];
    let profile = { id: 'p', host: '127.0.0.1', port, user: 'root', database: dst, environment: 'local' };
    const session = new DatabaseSession(profile); let denyColumns = false;
    const collector = new SchemaSnapshotCollector(session, { profileId: 'p', sessionId: 'editor', generation: 0, profileFingerprint: computeSchemaFingerprint(profile) });
    const service = new SchemaMigrationService();
    async function uiPreview() {
      const elements = new Map(), calls = [];
      for (const id of ['modal', 'diffTabContent', 'diffSourceProfile', 'diffTargetProfile', 'diffSourceDb', 'diffTargetDb', 'diffSwapBtn', 'diffIgnoreComments', 'diffIgnoreCollation', 'diffRunCompareBtn', 'diffGoMigrationBtn', 'diffGoTablesBtn', 'diffCopySqlBtn', 'diffDownloadSqlBtn', 'diffOpenEditorBtn', 'diffApplyTargetBtn']) {
        elements.set('#' + id, { open: false, innerHTML: '', listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; }, showModal() { this.open = true; }, close() { this.open = false; } });
      }
      const ok = data => ({ ok: true, data }); let plan;
      const r = loadRenderer({ elements, desktop: { db: {
        databases: async () => ok([src, dst]),
        schemaSnapshot: async ({ database }) => {
          calls.push('snapshot'); const snapshot = await collector.collect(database);
          return ok({ ...projectSnapshotForRenderer(snapshot), snapshotId: service.storeSnapshot(snapshot) });
        },
        createMigrationPlan: async payload => { calls.push('plan'); plan = service.createMigrationPlan(payload); return ok(plan); }
      } } });
      r.context.fixtureDb = src;
      r.evaluate("app.connection={id:'p'};app.connections=[app.connection];app.database=fixtureDb");
      await r.evaluate('showSchemaDiffModal()'); await new Promise(resolve => setImmediate(resolve));
      await elements.get('#diffRunCompareBtn').listeners.click();
      if (plan?.exportSupported) await elements.get('#diffGoMigrationBtn').listeners.click();
      return { plan, calls, html: elements.get('#diffTabContent').innerHTML };
    }
    async function syncPlan(table, op = 'DELETE', twoRows = false) {
      const columns = await session.listColumns(dst, table, { fresh: true });
      const report = { primaryKeys: ['id'], columns, onlyInTarget: op === 'DELETE' ? [{ rowKey: '[1]', row: { id: 1 } }] : [],
        onlyInSource: op === 'INSERT' ? [1, ...(twoRows ? [2] : [])].map(id => ({ rowKey: `[${id}]`, row: { id } })) : [],
        different: op === 'UPDATE' ? [{ rowKey: '[1]', targetRow: { id: 1 }, sourceRow: { id: 2 }, differences: [{ column: 'id' }] }] : [] };
      const plans = new DataSyncPlanService();
      const plan = plans.createSyncPlan({ sourceScope: { profileId: 'src', database: src, table }, targetScope: { profileId: 'p', database: dst, table }, diffReport: report, options: { includeDeletes: true } });
      return { plan, executor: new DataSyncExecutor({ consumePlan: token => plans.consumePlan(token), getProfileWithSecrets: () => profile }) };
    }
    try {
      for (const db of [src, dst]) { await admin.query(`CREATE DATABASE \`${db}\``); created.push(db); }
      await session.connect(); sessions.push(session);
      const listColumns = session.listColumns.bind(session);
      session.listColumns = (db, ...args) => {
        if (denyColumns && db === src) throw Object.assign(new Error('fixture denied'), { code: 'ER_TABLEACCESS_DENIED_ERROR' });
        return listColumns(db, ...args);
      };
      await t.test('UI uses real Main collector/service, preserves nonunique indexes and settings on success or error', async () => {
        await admin.query(`CREATE TABLE \`${src}\`.indexed(id INT PRIMARY KEY,label VARCHAR(30),KEY idx_label(label)) ENGINE=InnoDB`);
        const result = await uiPreview();
        assert.deepEqual(result.calls, ['snapshot', 'snapshot', 'plan']); assert.equal(result.plan.status, 'preview', result.plan.blockReason);
        assert.equal(result.plan.applySupported, false); assert.ok(result.plan.sqlScript.includes('KEY `idx_label`')); assert.equal(result.plan.sqlScript.includes('UNIQUE KEY'), false);
        const settings = async () => (await admin.query('SELECT @@SESSION.foreign_key_checks AS fk,@@SESSION.unique_checks AS uq,@@SESSION.sql_mode AS mode'))[0][0];
        const before = await settings(); await admin.query(`USE \`${dst}\``);
        const statements = splitSqlStatements(result.plan.sqlScript);
        for (const sql of statements) await admin.query(sql);
        assert.deepEqual(await settings(), before);
        await admin.query(`INSERT INTO \`${dst}\`.indexed VALUES(1,'same'),(2,'same')`);
        assert.equal((await session.listIndexes(dst, 'indexed', { fresh: true })).find(i => i.name === 'idx_label').unique, false);
        await assert.rejects(admin.query(statements[0]), { code: 'ER_TABLE_EXISTS_ERROR' }); assert.deepEqual(await settings(), before);
      });
      await t.test('unknown source columns blocks UI before plan and never produces destructive SQL', async () => {
        denyColumns = true;
        const result = await uiPreview();
        assert.equal(result.plan, undefined); assert.deepEqual(result.calls, ['snapshot']);
        assert.ok(result.html.includes('Metadata nguồn chưa đầy đủ')); assert.equal(result.html.includes('DROP TABLE'), false);
        denyColumns = false;
      });
      await t.test('CHECK and MariaDB default unsupported gates agree across UI preview and candidate', async () => {
        await admin.query(`ALTER TABLE \`${src}\`.indexed ADD CONSTRAINT positive CHECK(id>0)`);
        let result = await uiPreview(); assert.equal(result.plan.blockReason, 'CHECK_CONSTRAINT_REVIEW_REQUIRED'); assert.equal(result.plan.sqlScript, '');
        await admin.query(`DROP TABLE \`${src}\`.indexed`); await admin.query(`DROP TABLE \`${dst}\`.indexed`);
        await admin.query(`CREATE TABLE \`${src}\`.defaults(id INT PRIMARY KEY,v VARCHAR(30) DEFAULT 'pending') ENGINE=InnoDB`);
        const sourceSnapshotId = service.storeSnapshot(await collector.collect(src)), targetSnapshotId = service.storeSnapshot(await collector.collect(dst));
        const request = { sourceSnapshotId, targetSnapshotId };
        const preview = service.createMigrationPlan(request), candidate = service.createCandidatePlan(request);
        assert.equal(preview.blockReason, candidate.blockReason);
        if (engine === 'MARIA') { assert.equal(preview.blockReason, 'MARIADB_DEFAULT_REVIEW_REQUIRED'); assert.equal(preview.exportSupported, false); assert.equal(preview.sqlScript, ''); }
        else {
          assert.equal(preview.status, 'preview');
          for (const sql of splitSqlStatements(preview.sqlScript)) await admin.query(sql);
          await admin.query(`INSERT INTO \`${dst}\`.defaults(id) VALUES(1)`);
          assert.equal((await admin.query(`SELECT v FROM \`${dst}\`.defaults`))[0][0].v, 'pending');
          await admin.query(`DROP TABLE \`${dst}\`.defaults`);
        }
        await admin.query(`DROP TABLE \`${src}\`.defaults`);
      });
      await t.test('CASCADE/SET NULL inbound FKs block parent DELETE and PK UPDATE, preserving outside rows', async () => {
        for (const action of ['CASCADE', 'SET NULL']) {
          await admin.query(`CREATE TABLE \`${dst}\`.parent(id INT PRIMARY KEY) ENGINE=InnoDB`);
          await admin.query(`CREATE TABLE \`${dst}\`.child(id INT PRIMARY KEY,pid INT,FOREIGN KEY(pid) REFERENCES \`${dst}\`.parent(id) ON DELETE ${action} ON UPDATE CASCADE) ENGINE=InnoDB`);
          await admin.query(`INSERT INTO \`${dst}\`.parent VALUES(1)`); await admin.query(`INSERT INTO \`${dst}\`.child VALUES(10,1)`);
          for (const op of ['DELETE', 'UPDATE']) {
            const { executor, plan } = await syncPlan('parent', op);
            await assert.rejects(executor.executeSyncPlan({ planToken: plan.planToken }), { code: 'SYNC_FOREIGN_KEY_DEPENDENCY_UNSUPPORTED' });
            assert.deepEqual((await admin.query(`SELECT id,pid FROM \`${dst}\`.child`))[0], [{ id: 10, pid: 1 }]);
            assert.deepEqual((await admin.query(`SELECT id FROM \`${dst}\`.parent`))[0], [{ id: 1 }]);
          }
          await admin.query(`DROP TABLE \`${dst}\`.child`); await admin.query(`DROP TABLE \`${dst}\`.parent`);
        }
      });
      await t.test('revoked profile stops the second batch and preserves the first acknowledged commit', async () => {
        await admin.query(`CREATE TABLE \`${dst}\`.policy(id INT PRIMARY KEY) ENGINE=InnoDB`);
        const { executor, plan } = await syncPlan('policy', 'INSERT', true);
        await assert.rejects(executor.executeSyncPlan({ planToken: plan.planToken, batchSize: 1, onProgress: () => { profile = { ...profile, readOnly: true }; } }), err => err.code === 'CONNECTION_READ_ONLY' && err.committedCount === 1 && err.partialCommit === true);
        assert.deepEqual((await admin.query(`SELECT id FROM \`${dst}\`.policy`))[0], [{ id: 1 }]);
        profile = { ...profile, readOnly: false };
      });
      await t.test('FK added immediately before DELETE is either locked out or causes rollback before commit', async () => {
        await admin.query(`CREATE TABLE \`${dst}\`.race_parent(id INT PRIMARY KEY) ENGINE=InnoDB`);
        await admin.query(`CREATE TABLE \`${src}\`.race_child(id INT PRIMARY KEY,pid INT) ENGINE=InnoDB`);
        await admin.query(`INSERT INTO \`${dst}\`.race_parent VALUES(1)`); await admin.query(`INSERT INTO \`${src}\`.race_child VALUES(10,1)`);
        await admin.query('SET SESSION lock_wait_timeout=1');
        const columns = await session.listColumns(dst, 'race_parent', { fresh: true });
        const plans = new DataSyncPlanService();
        const plan = plans.createSyncPlan({ sourceScope: { profileId: 'p', database: src, table: 'race_parent' }, targetScope: { profileId: 'p', database: dst, table: 'race_parent' },
          options: { includeDeletes: true }, diffReport: { columns, primaryKeys: ['id'], onlyInTarget: [{ rowKey: '[1]', row: { id: 1 } }] } });
        let added = false, locked = false;
        const executor = new DataSyncExecutor({ consumePlan: token => plans.consumePlan(token), getProfileWithSecrets: () => profile, createSession: p => {
          const worker = new DatabaseSession(p), raw = worker.raw.bind(worker);
          worker.raw = async (sql, ...args) => {
            if (sql.startsWith('DELETE FROM')) {
              try { await admin.query(`ALTER TABLE \`${src}\`.race_child ADD CONSTRAINT late_fk FOREIGN KEY(pid) REFERENCES \`${dst}\`.race_parent(id) ON DELETE CASCADE`); added = true; }
              catch (err) { assert.equal(err.code, 'ER_LOCK_WAIT_TIMEOUT'); locked = true; }
            }
            return raw(sql, ...args);
          };
          return worker;
        } });
        let failure;
        try { await executor.executeSyncPlan({ planToken: plan.planToken }); } catch (err) { failure = err; }
        assert.equal(added || locked, true);
        if (added) assert.equal(failure?.code, 'SYNC_FOREIGN_KEY_DEPENDENCY_UNSUPPORTED');
        else assert.equal(failure, undefined);
        assert.deepEqual((await admin.query(`SELECT id,pid FROM \`${src}\`.race_child`))[0], [{ id: 10, pid: 1 }]);
        assert.equal((await admin.query(`SELECT COUNT(*) AS n FROM \`${dst}\`.race_parent`))[0][0].n, added ? 1 : 0);
        await admin.query(`DROP TABLE \`${src}\`.race_child`); await admin.query(`DROP TABLE \`${dst}\`.race_parent`);
      });
      await t.test('limited account cannot infer no dependencies from hidden FK metadata', async () => {
        await admin.query(`CREATE TABLE \`${dst}\`.hidden_parent(id INT PRIMARY KEY) ENGINE=InnoDB`);
        await admin.query(`CREATE TABLE \`${src}\`.hidden_child(id INT PRIMARY KEY,pid INT,FOREIGN KEY(pid) REFERENCES \`${dst}\`.hidden_parent(id) ON DELETE CASCADE) ENGINE=InnoDB`);
        await admin.query(`INSERT INTO \`${dst}\`.hidden_parent VALUES(1)`); await admin.query(`INSERT INTO \`${src}\`.hidden_child VALUES(10,1)`);
        const user = prefix + '_user';
        await admin.query(`CREATE USER '${user}'@'%'`); users.push(user);
        await admin.query(`GRANT SELECT, DELETE ON \`${dst}\`.hidden_parent TO '${user}'@'%'`);
        const plans = new DataSyncPlanService();
        const columns = await session.listColumns(dst, 'hidden_parent', { fresh: true });
        const plan = plans.createSyncPlan({ sourceScope: { profileId: 'p', database: src, table: 'hidden_parent' },
          targetScope: { profileId: 'limited', database: dst, table: 'hidden_parent' }, options: { includeDeletes: true },
          diffReport: { columns, primaryKeys: ['id'], onlyInTarget: [{ rowKey: '[1]', row: { id: 1 } }] } });
        const executor = new DataSyncExecutor({ consumePlan: token => plans.consumePlan(token),
          getProfileWithSecrets: () => ({ id: 'limited', host: '127.0.0.1', port, user, database: dst }) });
        await assert.rejects(executor.executeSyncPlan({ planToken: plan.planToken }), { code: 'SYNC_METADATA_VISIBILITY_UNVERIFIED' });
        assert.equal((await admin.query(`SELECT COUNT(*) AS n FROM \`${src}\`.hidden_child`))[0][0].n, 1);
        assert.equal((await admin.query(`SELECT COUNT(*) AS n FROM \`${dst}\`.hidden_parent`))[0][0].n, 1);
      });
    } finally {
      for (const session of sessions) await session.close();
      try {
        // Cross-schema fixture FK must be removed before dropping its parent DB.
        if (created.includes(src)) await admin.query(`DROP TABLE IF EXISTS \`${src}\`.hidden_child`);
        if (created.includes(src)) await admin.query(`DROP TABLE IF EXISTS \`${src}\`.race_child`);
        for (const db of created.reverse()) await admin.query(`DROP DATABASE \`${db}\``);
        for (const user of users) await admin.query(`DROP USER '${user}'@'%'`);
      } finally { await admin.end(); }
    }
  });
}
