'use strict';

// Opt in against a disposable server. Only this test's uniquely named database is changed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const { DatabaseSession } = require('../electron/database.cjs');
const { RestorePlanService } = require('../electron/restore-plan-service.cjs');
const { RestoreSelectionExecutor } = require('../electron/restore-selection-executor.cjs');

test('restore safety on real MySQL: context, selection markers and commit outcomes', {
  skip: !process.env.SQLPRO_RESTORE_TEST_SOCKET && !process.env.SQLPRO_RESTORE_TEST_PORT, timeout: 30000
}, async t => {
  const socketPath = process.env.SQLPRO_RESTORE_TEST_SOCKET;
  const connection = socketPath ? { socketPath } : { host: '127.0.0.1', port: Number(process.env.SQLPRO_RESTORE_TEST_PORT) };
  const admin = await mysql.createConnection({ ...connection, user: 'root', password: '' });
  const database = `sqlpro_restore_${crypto.randomBytes(10).toString('hex')}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-restore-db-fixes-'));
  const filePath = path.join(dir, 'backup.sql');
  const profile = { ...connection, id: 'restore-test', user: 'root', password: '', database, readOnly: false, ssh: { enabled: false } };
  let workerOptions = {};
  class SocketSession extends DatabaseSession {
    buildMysqlOptions(stream) { return { ...super.buildMysqlOptions(stream), ...connection }; }
    async collectRestoreTargetFacts(db) {
      const rows = (await this.raw('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=?', [db])).rows;
      return { database: db, objects: rows.map(row => ({ name: row.name, type: 'table' })), errors: [] };
    }
  }
  class RestoreSession extends SocketSession {
    async connect() {
      await super.connect();
      if (workerOptions.mode) await super.raw('SET SESSION sql_mode=?', [workerOptions.mode]);
      if (workerOptions.autocommit === 0) await super.raw('SET SESSION autocommit=0');
      if (workerOptions.completionType === 1) await super.raw('SET SESSION completion_type=1');
    }
    async raw(sql, ...args) {
      const result = await super.raw(sql, ...args);
      // Simulate loss of ACK after the server really commits, rather than mocking the write.
      if (workerOptions.lostAck === sql) throw Object.assign(new Error('lost commit ACK'), { code: 'ECONNRESET' });
      return result;
    }
  }
  const service = new RestorePlanService({ store: { getWithSecrets: () => profile }, fingerprintProfile: () => 'socket-test',
    createSession: p => new SocketSession(p) });
  const executor = new RestoreSelectionExecutor({ consumePlan: token => service.consumePlan(token),
    getProfileWithSecrets: () => profile, fingerprintProfile: () => 'socket-test', createSession: p => new RestoreSession(p) });
  const run = async (sql, options = {}) => {
    workerOptions = options;
    fs.writeFileSync(filePath, sql);
    const plan = await service.createSelectiveRestorePlan({ filePath, targetProfileId: profile.id, targetDatabase: database,
      selection: { tables: ['users'], includeStructure: options.structure === true }, dropExisting: options.dropExisting === true });
    return executor.executePlan({ planToken: plan.planToken });
  };
  const ids = async () => (await admin.query('SELECT id FROM users ORDER BY id'))[0].map(row => row.id);
  let created = false;
  try {
    await admin.query(`CREATE DATABASE \`${database}\``);
    created = true;
    await admin.query(`USE \`${database}\``);
    await admin.query('CREATE TABLE users (id int PRIMARY KEY) ENGINE=InnoDB');
    await admin.query('CREATE TABLE untouched (id int PRIMARY KEY, marker varchar(100)) ENGINE=InnoDB');
    await admin.query("INSERT INTO untouched VALUES (7,'must survive restore')");
    await admin.query('INSERT INTO users VALUES (99)');

    await t.test('unsafe dump mode and initial worker mode cannot drop existing data', async () => {
      const create = 'CREATE TABLE `users` (`id` int PRIMARY KEY);';
      await assert.rejects(() => run(create + "SET SQL_MODE='NO_BACKSLASH_ESCAPES';", { structure: true, dropExisting: true }), { code: 'RESTORE_PLAN_BLOCKED' });
      await assert.rejects(() => run(create, { structure: true, dropExisting: true, mode: 'NO_BACKSLASH_ESCAPES' }), { code: 'RESTORE_CONTEXT_UNSUPPORTED' });
      assert.deepEqual(await ids(), [99]);
    });
    await admin.query('DELETE FROM users');

    await t.test('a user variable cannot disguise a rolled-back uncommitted insert', async () => {
      await assert.rejects(() => run('SET AUTOCOMMIT=0; SET @autocommit=1; INSERT INTO users VALUES (1);'), { code: 'RESTORE_UNCOMMITTED_TRANSACTION' });
      assert.deepEqual(await ids(), []);
      await assert.rejects(() => run('INSERT INTO users VALUES (2);', { autocommit: 0 }), { code: 'RESTORE_UNCOMMITTED_TRANSACTION' });
      assert.deepEqual(await ids(), []);
      await assert.rejects(() => run('SET AUTOCOMMIT=DEFAULT; INSERT INTO users VALUES (3);'), { code: 'RESTORE_PLAN_BLOCKED' });
      assert.deepEqual(await ids(), []);
    });

    await t.test('native dump save/restore context and selective data commit work', async () => {
      const result = await run("SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT; SET NAMES utf8mb4; SET @OLD_SQL_MODE=@@SQL_MODE,SQL_MODE='NO_AUTO_VALUE_ON_ZERO'; START TRANSACTION; INSERT INTO users VALUES (4); INSERT INTO untouched VALUES (8,'excluded'); COMMIT; SET SQL_MODE=@OLD_SQL_MODE; SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT;");
      assert.equal(result.success, true);
      assert.deepEqual(await ids(), [4]);
      assert.deepEqual((await admin.query('SELECT * FROM untouched ORDER BY id'))[0], [{ id: 7, marker: 'must survive restore' }]);
    });

    await t.test('lost explicit/implicit commit ACK reports uncertainty for actually persisted data', async () => {
      for (const [id, prefix, commit] of [[5, 'START TRANSACTION;', 'COMMIT'], [6, 'SET AUTOCOMMIT=0;', 'SET AUTOCOMMIT=1']]) {
        await assert.rejects(() => run(`${prefix} INSERT INTO users VALUES (${id}); ${commit};`, { lostAck: commit }),
          e => e.code === 'ECONNRESET' && e.partialCommit === true && e.executionUncertain === true && e.targetChanged === true);
        assert.ok((await ids()).includes(id));
      }
      assert.deepEqual((await admin.query('SELECT * FROM untouched'))[0], [{ id: 7, marker: 'must survive restore' }]);
    });

    await t.test('inherited completion_type=CHAIN cannot silently open an untracked transaction', async () => {
      assert.equal((await run('START TRANSACTION; INSERT INTO users VALUES (10); COMMIT; INSERT INTO users VALUES (11);', { completionType: 1 })).success, true);
      assert.ok((await ids()).includes(11));
      assert.equal((await run('START TRANSACTION; SET AUTOCOMMIT=0; SET AUTOCOMMIT=1; INSERT INTO users VALUES (12);')).success, true);
      assert.ok((await ids()).includes(12));
    });
  } finally {
    try { if (created) await admin.query(`DROP DATABASE \`${database}\``); }
    finally { await admin.end(); fs.rmSync(dir, { recursive: true, force: true }); }
  }
});
