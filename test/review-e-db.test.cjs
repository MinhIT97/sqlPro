'use strict';

// Disposable loopback databases only; never point this at a user database.
const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const crypto = require('node:crypto');
const { DatabaseSession } = require('../electron/database.cjs');
const { DataSyncPlanService } = require('../electron/data-sync-plan-service.cjs');
const { DataSyncExecutor } = require('../electron/data-sync-executor.cjs');
const { SchemaSnapshotCollector, computeSchemaFingerprint } = require('../electron/schema-snapshot.cjs');
const { SchemaMigrationGenerator } = require('../electron/schema-migration-generator.cjs');
const { SchemaMigrationAdmission } = require('../electron/schema-migration-admission.cjs');
const { SchemaMigrationExecutor } = require('../electron/schema-migration-executor.cjs');

for (const engine of ['MYSQL', 'MARIA']) {
  const port = Number(process.env[`SQLPRO_REVIEW_${engine}_PORT`]);
  test(`E01-E03 ${engine}: schema locks, exact writes and column order`, { skip: !port, timeout: 60000 }, async t => {
    const admin = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root' });
    const prefix = 'sqlpro_e_' + crypto.randomBytes(6).toString('hex'), src = prefix + '_src', dst = prefix + '_dst';
    const created = [], sessions = [], profiles = {};
    const open = async (id, database) => {
      const profile = profiles[id] = { id, host: '127.0.0.1', port, user: 'root', database, environment: 'local' };
      const session = new DatabaseSession(profile); await session.connect(); sessions.push(session);
      return { session, collector: new SchemaSnapshotCollector(session, { profileId: id, sessionId: 'editor_' + id, generation: 0, profileFingerprint: computeSchemaFingerprint(profile) }) };
    };
    const report = (columns, rows, type = 'UPDATE') => ({ columns, primaryKeys: ['id'],
      different: type === 'UPDATE' ? rows.map(id => ({ rowKey: `[${id}]`, sourceRow: { id, v: 'new' }, targetRow: { id, v: 'old' }, differences: [{ column: 'v' }] })) : [],
      onlyInTarget: type === 'DELETE' ? rows.map(id => ({ rowKey: `[${id}]`, row: { id, v: 'old' } })) : [],
      onlyInSource: type === 'INSERT' ? [{ rowKey: '[1]', row: { id: 1, v: 'pending' } }] : [] });
    const execute = async (name, columns, rows, type, { atStart, batchSize = 50, countWrite } = {}) => {
      const service = new DataSyncPlanService();
      const plan = service.createSyncPlan({ sourceScope: { profileId: 'src', database: src, table: name }, targetScope: { profileId: 'dst', database: dst, table: name }, diffReport: report(columns, rows, type), options: { includeDeletes: true } });
      let starts = 0;
      const executor = new DataSyncExecutor({ consumePlan: token => service.consumePlan(token), getProfileWithSecrets: () => profiles.dst, createSession: profile => {
        const worker = new DatabaseSession(profile), raw = worker.raw.bind(worker);
        worker.raw = async (sql, ...args) => {
          if (sql === 'START TRANSACTION') await atStart?.(++starts);
          if (/^(UPDATE|DELETE|INSERT)\b/.test(sql)) countWrite?.();
          return raw(sql, ...args);
        };
        return worker;
      } });
      return executor.executeSyncPlan({ planToken: plan.planToken, batchSize });
    };
    try {
      for (const db of [src, dst]) { await admin.query(`CREATE DATABASE \`${db}\``); created.push(db); }
      const source = await open('src', src), target = await open('dst', dst);
      await t.test('PK drift before the first lock blocks UPDATE and DELETE without changing duplicates', async () => {
        for (const type of ['UPDATE', 'DELETE']) {
          await admin.query(`DROP TABLE IF EXISTS \`${dst}\`.raced`);
          await admin.query(`CREATE TABLE \`${dst}\`.raced(id INT PRIMARY KEY, v VARCHAR(20)) ENGINE=InnoDB`);
          await admin.query(`INSERT INTO \`${dst}\`.raced VALUES(1,'old')`);
          const columns = await target.session.listColumns(dst, 'raced', { fresh: true }); let writes = 0;
          await assert.rejects(execute('raced', columns, [1], type, { countWrite: () => { writes++; }, atStart: async () => {
            await admin.query(`ALTER TABLE \`${dst}\`.raced DROP PRIMARY KEY`);
            await admin.query(`INSERT INTO \`${dst}\`.raced VALUES(1,'old')`);
          } }), { code: 'TARGET_SCHEMA_DRIFT' });
          assert.equal(writes, 0);
          assert.deepEqual((await admin.query(`SELECT id,v FROM \`${dst}\`.raced`))[0], [{ id: 1, v: 'old' }, { id: 1, v: 'old' }]);
        }
        await admin.query(`DROP TABLE \`${dst}\`.raced`);
      });
      await t.test('PK drift between batches preserves the first commit and never updates the second batch', async () => {
        await admin.query(`CREATE TABLE \`${dst}\`.batches(id INT PRIMARY KEY, v VARCHAR(20)) ENGINE=InnoDB`);
        await admin.query(`INSERT INTO \`${dst}\`.batches VALUES(1,'old'),(2,'old')`);
        const columns = await target.session.listColumns(dst, 'batches', { fresh: true }); let writes = 0;
        await assert.rejects(execute('batches', columns, [1, 2], 'UPDATE', { batchSize: 1, countWrite: () => { writes++; }, atStart: async n => {
          if (n !== 2) return;
          await admin.query(`ALTER TABLE \`${dst}\`.batches DROP PRIMARY KEY`);
          await admin.query(`INSERT INTO \`${dst}\`.batches VALUES(2,'old')`);
        } }), err => err.code === 'TARGET_SCHEMA_DRIFT' && err.partialCommit === true && err.committedCount === 1);
        assert.equal(writes, 1);
        assert.deepEqual((await admin.query(`SELECT id,v FROM \`${dst}\`.batches ORDER BY id`))[0], [{ id: 1, v: 'new' }, { id: 2, v: 'old' }, { id: 2, v: 'old' }]);
        await admin.query(`DROP TABLE \`${dst}\`.batches`);
      });
      await t.test('ENUM and SET literal drift blocks INSERT before DML', async () => {
        for (const kind of ['ENUM', 'SET']) {
          await admin.query(`CREATE TABLE \`${dst}\`.choices(id INT PRIMARY KEY, v ${kind}('pending','done') COLLATE utf8mb4_unicode_ci) ENGINE=InnoDB`);
          const columns = await target.session.listColumns(dst, 'choices', { fresh: true }); let writes = 0;
          await admin.query(`ALTER TABLE \`${dst}\`.choices MODIFY v ${kind}('PENDING','DONE') COLLATE utf8mb4_unicode_ci`);
          await assert.rejects(execute('choices', columns, [1], 'INSERT', { countWrite: () => { writes++; } }), { code: 'TARGET_SCHEMA_DRIFT' });
          assert.equal(writes, 0); assert.equal((await admin.query(`SELECT COUNT(*) AS n FROM \`${dst}\`.choices`))[0][0].n, 0);
          await admin.query(`DROP TABLE \`${dst}\`.choices`);
        }
      });
      await t.test('non-append addition is blocked; multiple append additions preserve verified order', async () => {
        await admin.query(`CREATE TABLE \`${src}\`.ordered(id INT PRIMARY KEY, added INT, tail INT) ENGINE=InnoDB`);
        await admin.query(`CREATE TABLE \`${dst}\`.ordered(id INT PRIMARY KEY, tail INT) ENGINE=InnoDB`);
        const generate = async () => new SchemaMigrationGenerator().generateCandidatePlan({ sourceSnapshot: await source.collector.collect(src), targetSnapshot: await target.collector.collect(dst) });
        assert.equal((await generate()).blockReason, 'COLUMN_ORDER_REVIEW_REQUIRED');
        await admin.query(`DROP TABLE \`${src}\`.ordered`);
        await admin.query(`CREATE TABLE \`${src}\`.ordered(id INT PRIMARY KEY, tail INT, a INT, b INT) ENGINE=InnoDB`);
        const candidate = await generate(); assert.equal(candidate.status, 'ready', candidate.blockReason);
        const admission = new SchemaMigrationAdmission(), admitted = admission.admitCandidate(candidate);
        const executor = new SchemaMigrationExecutor({ consumePlan: token => admission.consumePlan(token), getProfileWithSecrets: id => profiles[id], fingerprintProfile: computeSchemaFingerprint, checkContext: async () => true, verifySource: () => source.collector.collect(src) });
        assert.equal((await executor.executePlan({ planToken: admitted.planToken })).executedCount, 2);
        assert.deepEqual((await target.session.listColumns(dst, 'ordered', { fresh: true })).map(c => c.name), ['id', 'tail', 'a', 'b']);
      });
    } finally {
      for (const session of sessions) await session.close();
      for (const db of created.reverse()) await admin.query(`DROP DATABASE \`${db}\``);
      await admin.end();
    }
  });
}
