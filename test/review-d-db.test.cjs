'use strict';

// Opt-in disposable loopback DBs. Only schemas created by this test are removed.
const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const crypto = require('node:crypto');
const { DatabaseSession } = require('../electron/database.cjs');
const { SchemaSnapshotCollector, computeSchemaFingerprint } = require('../electron/schema-snapshot.cjs');
const { SchemaMigrationGenerator } = require('../electron/schema-migration-generator.cjs');
const { SchemaMigrationAdmission } = require('../electron/schema-migration-admission.cjs');
const { SchemaMigrationExecutor } = require('../electron/schema-migration-executor.cjs');
const { DataSyncExecutor } = require('../electron/data-sync-executor.cjs');

for (const engine of ['MYSQL', 'MARIA']) {
  const port = Number(process.env[`SQLPRO_REVIEW_${engine}_PORT`]);
  test(`D01-D04/D06 ${engine}: schema fidelity and exact conflict guards`, { skip: !port, timeout: 60000 }, async t => {
    const admin = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root' });
    const prefix = `sqlpro_d_${crypto.randomBytes(6).toString('hex')}`, sourceDb = prefix + '_src', targetDb = prefix + '_tgt', created = [], sessions = [];
    const open = async (database, id) => {
      const profile = { id, host: '127.0.0.1', port, user: 'root', database, environment: 'local' };
      const session = new DatabaseSession(profile); await session.connect(); sessions.push(session);
      const collector = new SchemaSnapshotCollector(session, { profileId: id, sessionId: `editor_${id}`, generation: 0, profileFingerprint: computeSchemaFingerprint(profile) });
      return { profile, session, collector };
    };
    try {
      for (const name of [sourceDb, targetDb]) { await admin.query(`CREATE DATABASE \`${name}\``); created.push(name); }
      await admin.query(`USE \`${sourceDb}\``);
      const source = await open(sourceDb, 'src'), target = await open(targetDb, 'tgt');
      await t.test('ENUM/SET retain literal case, case-only tables both migrate and safe comments round-trip', async () => {
        await admin.query("CREATE TABLE enums(id INT PRIMARY KEY, v ENUM('pending','Done','O''Reilly','Việt') COLLATE utf8mb4_bin, s SET('a','B') COLLATE utf8mb4_bin, note INT COMMENT ' O''Reilly ') ENGINE=InnoDB");
        await admin.query('CREATE TABLE `Twin`(id INT PRIMARY KEY) ENGINE=InnoDB');
        await admin.query('CREATE TABLE `twin`(other_id INT PRIMARY KEY) ENGINE=InnoDB');
        const candidate = new SchemaMigrationGenerator().generateCandidatePlan({ sourceSnapshot: await source.collector.collect(sourceDb), targetSnapshot: await target.collector.collect(targetDb) });
        assert.equal(candidate.status, 'ready', candidate.blockReason);
        assert.equal(candidate.statements.length, 3);
        const admission = new SchemaMigrationAdmission(), admitted = admission.admitCandidate(candidate), profiles = { src: source.profile, tgt: target.profile };
        const executor = new SchemaMigrationExecutor({ consumePlan: token => admission.consumePlan(token), getProfileWithSecrets: id => profiles[id], fingerprintProfile: computeSchemaFingerprint, checkContext: async () => true, verifySource: () => source.collector.collect(sourceDb) });
        assert.equal((await executor.executePlan({ planToken: admitted.planToken })).executedCount, 3);
        for (const db of [sourceDb, targetDb]) {
          for (const [index, value] of ['pending', 'Done', "O'Reilly", 'Việt'].entries()) {
            await admin.execute(`INSERT INTO \`${db}\`.enums(id,v,s) VALUES(?,?,?)`, [index + 1, value, 'a,B']);
          }
        }
        assert.deepEqual((await admin.query(`SELECT id,v,s FROM \`${sourceDb}\`.enums ORDER BY id`))[0], (await admin.query(`SELECT id,v,s FROM \`${targetDb}\`.enums ORDER BY id`))[0]);
        const sourceColumns = await source.session.listColumns(sourceDb, 'enums', { fresh: true }), targetColumns = await target.session.listColumns(targetDb, 'enums', { fresh: true });
        assert.deepEqual(targetColumns.map(c => [c.name, c.type, c.comment]), sourceColumns.map(c => [c.name, c.type, c.comment]));
      });
      await t.test('CHECK inventory blocks before DDL; unsafe comments are rejected before execution', async () => {
        await admin.query('CREATE TABLE checked(id INT PRIMARY KEY, qty INT CHECK(qty > 0)) ENGINE=InnoDB');
        const snapshot = await source.collector.collect(sourceDb);
        assert.equal(snapshot.tables.find(table => table.name === 'checked').checkConstraints.length, 1);
        let candidate = new SchemaMigrationGenerator().generateCandidatePlan({ sourceSnapshot: snapshot, targetSnapshot: await target.collector.collect(targetDb) });
        assert.equal(candidate.status, 'blocked'); assert.equal(candidate.blockReason, 'CHECK_CONSTRAINT_REVIEW_REQUIRED');
        await admin.query('DROP TABLE checked');
        await admin.query("ALTER TABLE enums MODIFY note INT COMMENT 'C:\\\\new'");
        candidate = new SchemaMigrationGenerator().generateCandidatePlan({ sourceSnapshot: await source.collector.collect(sourceDb), targetSnapshot: await target.collector.collect(targetDb) });
        assert.equal(candidate.status, 'blocked'); assert.equal(candidate.blockReason, 'COMMENT_LITERAL_UNSUPPORTED');
        const [rows] = await admin.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?', [targetDb, 'checked']);
        assert.equal(rows.length, 0);
      });
      await t.test('UPDATE/DELETE reject case/accent/trailing-space concurrent changes and preserve exact target bytes', async () => {
        await admin.query(`CREATE TABLE \`${targetDb}\`.conflict(id INT PRIMARY KEY, v VARCHAR(40) COLLATE utf8mb4_unicode_ci) ENGINE=InnoDB`);
        const columns = await target.session.listColumns(targetDb, 'conflict', { fresh: true });
        for (const op of ['UPDATE', 'DELETE']) {
          for (const [original, current] of [['old', 'OLD'], ['cafe', 'café'], ['old', 'old ']]) {
            await admin.execute(`REPLACE INTO \`${targetDb}\`.conflict VALUES(1,?)`, [current]);
            const executor = new DataSyncExecutor({ consumePlan: () => ({ targetScope: { profileId: 'tgt', database: targetDb, table: 'conflict' }, columns, primaryKeys: ['id'], operations: [{ type: op, values: { id: 1, v: 'new' }, originalValues: { id: 1, v: original }, pkValues: [1] }] }), getProfileWithSecrets: () => target.profile });
            await assert.rejects(executor.executeSyncPlan({ planToken: 'internal-test' }), { code: 'SYNC_CONFLICT_DETECTED' });
            assert.equal((await admin.query(`SELECT v FROM \`${targetDb}\`.conflict`))[0][0].v, current);
          }
        }
      });
    } finally {
      for (const session of sessions) await session.close();
      for (const name of created.reverse()) await admin.query(`DROP DATABASE \`${name}\``);
      await admin.end();
    }
  });
}
