'use strict';

// Opt-in: disposable loopback servers only. All schemas belong to this test.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const { DatabaseSession } = require('../electron/database.cjs');
const { SchemaSnapshotCollector, computeSchemaFingerprint } = require('../electron/schema-snapshot.cjs');
const { SchemaMigrationGenerator } = require('../electron/schema-migration-generator.cjs');
const { SchemaMigrationAdmission } = require('../electron/schema-migration-admission.cjs');
const { SchemaMigrationExecutor } = require('../electron/schema-migration-executor.cjs');
const { DataDiffService } = require('../electron/data-diff-service.cjs');
const { DataSyncExecutor } = require('../electron/data-sync-executor.cjs');
const RowValues = require('../row-values.js');

for (const engine of ['MYSQL', 'MARIA']) {
  const port = Number(process.env[`SQLPRO_REVIEW_${engine}_PORT`]);
  test(`N01/N02/N05 real ${engine}: default fidelity, collation admission and conditional JSON`, { skip: !port, timeout: 60000 }, async t => {
    const admin = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root' });
    const prefix = `sqlpro_n19_${crypto.randomBytes(6).toString('hex')}`, names = [], sessions = [];
    const createDb = async suffix => { const name = `${prefix}_${suffix}`; await admin.query(`CREATE DATABASE \`${name}\``); names.push(name); return name; };
    const open = async (database, id) => {
      const profile = { id, host: '127.0.0.1', port, user: 'root', database, readOnly: false, environment: 'local' };
      const session = new DatabaseSession(profile); sessions.push(session); await session.connect();
      const scope = { profileId: id, sessionId: `editor_${id}`, generation: 0, profileFingerprint: computeSchemaFingerprint(profile) };
      return { profile, session, collector: new SchemaSnapshotCollector(session, scope) };
    };
    try {
      const sourceDb = await createDb('src');
      await admin.query(`USE \`${sourceDb}\``);
      if (engine === 'MYSQL') {
        const values = ['C:\\new', "O'Reilly", 'NULL', 'CURRENT_TIMESTAMP', 'tiếng Việt', '', null];
        const definition = 'id INT PRIMARY KEY,' + values.map((value, i) => `v${i} VARCHAR(100) DEFAULT ${value === null ? 'NULL' : value === '' ? "''" : '_utf8mb4 0x' + Buffer.from(value).toString('hex')}`).join(',');
        for (const table of ['created', 'altered']) await admin.query(`CREATE TABLE ${table} (${definition}) ENGINE=InnoDB COLLATE=utf8mb4_bin`);
        const source = await open(sourceDb, 'source');
        for (const [index, mode] of ['', 'NO_BACKSLASH_ESCAPES'].entries()) {
          await t.test(`CREATE_TABLE and ADD_COLUMN preserve defaults with sql_mode=${mode || '(empty)'}`, async () => {
            const targetDb = await createDb(`t${index}`);
            await admin.query(`CREATE TABLE \`${targetDb}\`.altered (id INT PRIMARY KEY) ENGINE=InnoDB COLLATE=utf8mb4_bin`);
            const target = await open(targetDb, 'target');
            const sourceSnapshot = await source.collector.collect(sourceDb), targetSnapshot = await target.collector.collect(targetDb);
            const candidate = new SchemaMigrationGenerator().generateCandidatePlan({ sourceSnapshot, targetSnapshot });
            assert.equal(candidate.status, 'ready', candidate.blockReason);
            const admission = new SchemaMigrationAdmission();
            const admitted = admission.admitCandidate(candidate);
            const profiles = { source: source.profile, target: target.profile };
            const executor = new SchemaMigrationExecutor({
              consumePlan: token => admission.consumePlan(token), getProfileWithSecrets: id => profiles[id], fingerprintProfile: computeSchemaFingerprint,
              checkContext: async () => true, verifySource: () => source.collector.collect(sourceDb),
              createSession: profile => {
                const worker = new DatabaseSession(profile), connect = worker.connect.bind(worker);
                worker.connect = async () => { await connect(); await worker.raw('SET SESSION sql_mode = ?', [mode], null, { prepared: true }); };
                return worker;
              }
            });
            assert.equal((await executor.executePlan({ planToken: admitted.planToken })).success, true);
            for (const table of ['created', 'altered']) {
              const columns = await target.session.listColumns(targetDb, table, { fresh: true });
              assert.deepEqual(columns.slice(1).map(column => column.defaultValue), values);
              await target.session.raw(`INSERT INTO \`${targetDb}\`.\`${table}\` (id) VALUES (1)`);
              const result = await target.session.raw(`SELECT ${values.map((_, i) => `v${i}`).join(',')} FROM \`${targetDb}\`.\`${table}\``);
              assert.deepEqual(values.map((_, i) => result.rows[0][`v${i}`]), values);
            }
          });
        }
        await t.test('PAD SPACE is blocked; verified utf8mb4_0900_bin keeps trailing-space keys distinct across chunks', async () => {
          for (const table of ['pad_src', 'pad_dst']) await admin.query(`CREATE TABLE ${table}(id VARCHAR(20) COLLATE utf8mb4_bin PRIMARY KEY, v INT) ENGINE=InnoDB`);
          await admin.query("INSERT INTO pad_src VALUES ('key',1)"); await admin.query("INSERT INTO pad_dst VALUES ('key ',2)");
          assert.equal((await admin.query('SELECT a.id=b.id AS sameKey FROM pad_src a JOIN pad_dst b ON a.id=b.id'))[0][0].sameKey, 1);
          const profile = { ...source.profile, readOnly: true };
          const diff = new DataDiffService({ store: { getWithSecrets: () => profile } });
          try {
            const args = { sourceProfileId: 'source', targetProfileId: 'source', sourceDb, targetDb: sourceDb, sourceTable: 'pad_src', targetTable: 'pad_dst', chunkSize: 10 };
            let started = await diff.startDiff(args); await diff.jobs.get(started.jobId).promise;
            assert.equal(diff.getDiffStatus(started.jobId).error.code, 'DATA_DIFF_UNSUPPORTED_PK_TYPE');
            for (const table of ['pad_src', 'pad_dst']) {
              await admin.query(`ALTER TABLE ${table} MODIFY id VARCHAR(20) COLLATE utf8mb4_0900_bin`);
              for (let i = 0; i < 21; i++) await admin.execute(`INSERT INTO ${table} VALUES (?,?)`, [`z${String(i).padStart(2, '0')}`, i]);
            }
            started = await diff.startDiff(args); await diff.jobs.get(started.jobId).promise;
            const result = diff.getDiffStatus(started.jobId);
            assert.equal(result.status, 'completed', JSON.stringify(result.error));
            assert.equal(result.report.coverage.complete, true);
            assert.equal(result.report.summary.onlyInSourceCount, 1);
            assert.equal(result.report.summary.onlyInTargetCount, 1);
            assert.equal(result.report.summary.identicalCount, 21);
          } finally { await diff.clear(); }
        });
      } else {
        await t.test('JSON alias is recognized but conditional LONGTEXT remains text', async () => {
          await admin.query("CREATE TABLE optional_json(id INT PRIMARY KEY, payload LONGTEXT, CHECK(JSON_VALID(payload) OR payload='plain')) ENGINE=InnoDB");
          await admin.query('CREATE TABLE actual_json(id INT PRIMARY KEY, payload JSON) ENGINE=InnoDB');
          await admin.query("INSERT INTO optional_json VALUES(1,'plain')");
          const source = await open(sourceDb, 'source');
          const optional = (await source.session.listColumns(sourceDb, 'optional_json', { fresh: true })).find(column => column.name === 'payload');
          const actual = (await source.session.listColumns(sourceDb, 'actual_json', { fresh: true })).find(column => column.name === 'payload');
          assert.equal(optional.isJson, undefined);
          assert.equal(RowValues.normalizeValue(optional, 'plain'), 'plain');
          assert.equal(actual.isJson, true);
          assert.throws(() => RowValues.normalizeValue(actual, 'plain'), /JSON/);
        });
        await t.test('MariaDB expression defaults remain blocked until dialect contract is implemented', async () => {
          await admin.query('DROP TABLE optional_json, actual_json');
          await admin.query("CREATE TABLE defaults(id INT PRIMARY KEY, v VARCHAR(20) DEFAULT 'NULL') ENGINE=InnoDB");
          const source = await open(sourceDb, 'source'), targetDb = await createDb('target'), target = await open(targetDb, 'target');
          const plan = new SchemaMigrationGenerator().generateCandidatePlan({ sourceSnapshot: await source.collector.collect(sourceDb), targetSnapshot: await target.collector.collect(targetDb) });
          assert.equal(plan.status, 'blocked');
          assert.equal(plan.blockReason, 'MARIADB_DEFAULT_REVIEW_REQUIRED');
        });
      }
      await t.test('N07 internal executor: metadata lock blocks concurrent engine change, MyISAM/triggers block writes', async () => {
        await admin.query('CREATE TABLE guarded (id INT PRIMARY KEY) ENGINE=InnoDB');
        const target = await open(sourceDb, 'guard_target');
        const columns = await target.session.listColumns(sourceDb, 'guarded', { fresh: true });
        let verifyLock = true;
        const execute = async () => {
          const executor = new DataSyncExecutor({
            consumePlan: () => ({ targetScope: { profileId: 'guard_target', database: sourceDb, table: 'guarded' }, columns, primaryKeys: ['id'], operations: [{ type: 'INSERT', values: { id: verifyLock ? 1 : 2 } }] }),
            getProfileWithSecrets: () => target.profile,
            createSession: profile => {
              const worker = new DatabaseSession(profile), raw = worker.raw.bind(worker);
              worker.raw = async (...args) => {
                if (verifyLock && args[0].includes('SELECT ENGINE FROM')) {
                  verifyLock = false;
                  await admin.query('SET SESSION lock_wait_timeout=1');
                  await assert.rejects(admin.query('ALTER TABLE guarded ENGINE=MyISAM'), { code: 'ER_LOCK_WAIT_TIMEOUT' });
                }
                return raw(...args);
              };
              return worker;
            }
          });
          return executor.executeSyncPlan({ planToken: 'internal-test' });
        };
        assert.equal((await execute()).success, true);
        await admin.query('ALTER TABLE guarded ENGINE=MyISAM');
        await assert.rejects(execute(), { code: 'UNSUPPORTED_TABLE_ENGINE' });
        await admin.query('ALTER TABLE guarded ENGINE=InnoDB');
        await admin.query('CREATE TRIGGER guard_trigger BEFORE INSERT ON guarded FOR EACH ROW SET NEW.id=NEW.id');
        await assert.rejects(execute(), { code: 'TARGET_TABLE_TRIGGERS_DETECTED' });
        assert.equal((await admin.query('SELECT COUNT(*) AS count FROM guarded'))[0][0].count, 1);
      });
    } finally {
      for (const session of sessions) await session.close();
      for (const name of names.reverse()) await admin.query(`DROP DATABASE \`${name}\``);
      await admin.end();
    }
  });
}
