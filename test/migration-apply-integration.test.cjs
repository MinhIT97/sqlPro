'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const mysql = require('mysql2/promise');

test('public Migration Apply: real MySQL DDL, native approval, drift, transaction, replay and partial failure', {
  skip: !process.env.SQLPRO_TEST_MYSQL_PORT, timeout: 90000
}, async t => {
  const port = Number(process.env.SQLPRO_TEST_MYSQL_PORT), nonce = crypto.randomBytes(12).toString('hex');
  const source = `sqlpro_mig_source_${nonce}`, target = `sqlpro_mig_target_${nonce}`;
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-mig-apply-'));
  const root = path.join(__dirname, '../electron'), handlers = new Map();
  const profile = { id: 'fixture', name: 'isolated fixture', host: '127.0.0.1', port, user: 'root', password: '',
    environment: 'local', ssl: { enabled: false }, ssh: { enabled: false } };
  let confirmations = 0, confirm = async () => ({ response: 1 });
  const context = vm.createContext({
    require(id) {
      if (id === 'electron') return {
        app: { requestSingleInstanceLock: () => true, on() {}, whenReady: () => new Promise(() => {}), getPath: () => userData },
        ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
        dialog: { showMessageBox: (...args) => { confirmations++; return confirm(args.at(-1)); } }
      };
      if (id === './store.cjs') return { getWithSecrets: () => structuredClone(profile) };
      if (id === './sync.cjs' || id === './navicat.cjs') return {};
      return require(id.startsWith('./') ? path.join(root, id) : id);
    }, __dirname: root, process, Buffer, console, setTimeout, clearTimeout, AbortController
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'main.cjs'), 'utf8'), context);
  const call = (name, ...args) => handlers.get(name)({ sender: null }, ...args);
  const registry = vm.runInContext('sessionRegistry', context);
  let admin, createdSource = false, createdTarget = false;
  const query = sql => admin.query(sql);
  async function plan() {
    const a = await call('db:schema-snapshot', { profileId: profile.id, database: source });
    const b = await call('db:schema-snapshot', { profileId: profile.id, database: target });
    assert.equal(a.ok, true, JSON.stringify(a.error)); assert.equal(b.ok, true, JSON.stringify(b.error));
    const result = await call('db:create-migration-plan', { sourceSnapshotId: a.data.snapshotId, targetSnapshotId: b.data.snapshotId });
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(result.data.applySupported, true, JSON.stringify(result.data));
    return result.data;
  }
  const apply = p => call('db:apply-migration-plan', { planToken: p.planToken, taskId: `migration-${crypto.randomBytes(8).toString('hex')}` });
  const columns = async () => (await admin.query('SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [target, 'existing']))[0].map(row => row.COLUMN_NAME);
  async function resetTarget() {
    await query(`DROP TABLE IF EXISTS \`${target}\`.created`);
    await query(`DROP TABLE IF EXISTS \`${target}\`.existing`);
    await query(`CREATE TABLE \`${target}\`.existing (id INT NOT NULL PRIMARY KEY, email VARCHAR(100) NULL) ENGINE=InnoDB`);
  }
  try {
    admin = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root' });
    await query(`CREATE DATABASE \`${source}\``); createdSource = true;
    await query(`CREATE DATABASE \`${target}\``); createdTarget = true;
    await query(`CREATE TABLE \`${source}\`.existing (id INT NOT NULL PRIMARY KEY, email VARCHAR(100) NULL, extra VARCHAR(30) NULL, UNIQUE KEY unique_email(email)) ENGINE=InnoDB`);
    await query(`CREATE TABLE \`${source}\`.created (id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB`);
    await resetTarget();
    assert.equal((await call('db:connect', profile.id)).ok, true);
    const entry = registry.entries.get(profile.id), sessionId = entry.sessionId, threadId = entry.session.connection.threadId;

    await t.test('native Cancel consumes preview without DDL; caller SQL cannot bypass the dialog', async () => {
      const p = await plan(); const before = confirmations;
      const forged = await call('db:apply-migration-plan', { planToken: p.planToken, sql: 'DROP DATABASE anything', confirmed: true });
      assert.equal(forged.error.code, 'INVALID_MIGRATION_APPLY'); assert.equal(confirmations, before);
      confirm = async options => { assert.equal(options.defaultId, 0); assert.match(options.detail, new RegExp(target)); return { response: 0 }; };
      const result = await apply(p); assert.equal(result.ok, true); assert.equal(result.data.canceled, true);
      assert.deepEqual(await columns(), ['id', 'email']);
      assert.equal((await apply(p)).error.code, 'MIGRATION_PLAN_NOT_FOUND');
      assert.equal(vm.runInContext('activeDatabaseTransfer', context), null);
    });

    await t.test('Editor transaction blocks before confirmation and is preserved', async () => {
      const p = await plan(), before = confirmations;
      await entry.session.runQueryScript('START TRANSACTION', 30000, true);
      assert.equal((await apply(p)).error.code, 'SESSION_BUSY'); assert.equal(confirmations, before);
      assert.equal(entry.session.inTransaction, true);
      await entry.session.runQueryScript('ROLLBACK', 30000, true);
    });

    await t.test('policy and generation changes while confirming cause zero DDL', async () => {
      let p = await plan();
      confirm = async () => { profile.readOnly = true; return { response: 1 }; };
      assert.equal((await apply(p)).ok, false); delete profile.readOnly;
      assert.deepEqual(await columns(), ['id', 'email']);
      p = await plan(); confirm = async () => { vm.runInContext('stopBackupSchedules()', context); return { response: 1 }; };
      assert.equal((await apply(p)).ok, false); assert.deepEqual(await columns(), ['id', 'email']);
      assert.equal(vm.runInContext('activeDatabaseTransfer', context), null);
    });

    await t.test('source and target schema drift reject before generated DDL', async () => {
      confirm = async () => ({ response: 1 });
      for (const database of [source, target]) {
        const p = await plan();
        await query(`ALTER TABLE \`${database}\`.existing ADD COLUMN drift INT NULL`);
        const result = await apply(p);
        assert.equal(result.ok, true, JSON.stringify(result.error));
        assert.equal(result.data.job.status, 'failed', JSON.stringify(result.data.job));
        assert.equal(result.data.job.executedCount, 0);
        await query(`ALTER TABLE \`${database}\`.existing DROP COLUMN drift`);
      }
    });

    await t.test('canceling the matching pending task prevents writes', async () => {
      const p = await plan(); let release, entered;
      const waiting = new Promise(resolve => { entered = resolve; });
      confirm = () => new Promise(resolve => { release = resolve; entered(); });
      const taskId = `migration-${nonce}`;
      const pending = call('db:apply-migration-plan', { planToken: p.planToken, taskId }); await waiting;
      const canceled = await call('db:cancel-task', { profileId: profile.id, taskId });
      assert.equal(canceled.ok, true); release({ response: 1 });
      const result = await pending; assert.equal(result.error.code, 'QUERY_CANCELED');
      assert.deepEqual(await columns(), ['id', 'email']);
      assert.equal(vm.runInContext('activeDatabaseTransfer', context), null);
    });

    await t.test('confirmed MySQL 8 plan executes all allowlisted DDL on workers and preserves Editor', async () => {
      confirm = async () => ({ response: 1 });
      const p = await plan();
      assert.deepEqual(new Set(p.statements.map(s => s.type)), new Set(['CREATE_TABLE', 'ADD_COLUMN', 'ADD_INDEX']));
      const result = await apply(p); assert.equal(result.ok, true, JSON.stringify(result.error));
      assert.equal(result.data.job.status, 'completed', JSON.stringify(result.data.job));
      assert.equal(result.data.job.executedCount, p.statements.length);
      assert.ok(result.data.job.statements.every(s => s.status === 'executed'));
      assert.deepEqual(await columns(), ['id', 'email', 'extra']);
      assert.equal(entry.sessionId, sessionId); assert.equal(entry.session.connection.threadId, threadId);
      assert.equal(registry.leases.size, 0); assert.equal(entry.exclusiveOperation, false);
      assert.equal((await apply(p)).error.code, 'MIGRATION_PLAN_NOT_FOUND');
    });

    await t.test('duplicate target values produce a truthful partial-commit ledger', async () => {
      await resetTarget(); await query(`INSERT INTO \`${target}\`.existing VALUES (1,'duplicate'),(2,'duplicate')`);
      const result = await apply(await plan()); assert.equal(result.ok, true, JSON.stringify(result.error));
      const job = result.data.job;
      assert.equal(job.status, 'failed', JSON.stringify(job));
      assert.equal(job.partialCommit, true); assert.ok(job.executedCount > 0);
      assert.ok(job.statements.some(s => s.status === 'failed'));
      assert.deepEqual(await columns(), ['id', 'email', 'extra']);
      assert.equal(registry.leases.size, 0);
    });

    await t.test('Production requires native confirmation and supports explicit Cancel and success', async () => {
      await resetTarget(); profile.environment = 'production';
      confirm = async options => { assert.match(options.title, /Production/); return { response: 0 }; };
      assert.equal((await apply(await plan())).data.canceled, true);
      assert.deepEqual(await columns(), ['id', 'email']);
      confirm = async options => { assert.match(options.title, /Production/); return { response: 1 }; };
      const result = await apply(await plan()); assert.equal(result.ok, true, JSON.stringify(result.error));
      assert.equal(result.data.job.status, 'completed', JSON.stringify(result.data.job));
      assert.equal(vm.runInContext('schemaMigrationApproval.pending.size', context), 0);
      assert.equal(vm.runInContext('schemaMigrationAdmission.admittedPlans.size', context), 0);
    });
  } finally {
    await registry.closeAll();
    try {
      // Both identifiers contain a cryptographic per-run nonce and were created above.
      if (createdTarget) await query(`DROP DATABASE \`${target}\``);
      if (createdSource) await query(`DROP DATABASE \`${source}\``);
    } finally { await admin?.end(); fs.rmSync(userData, { recursive: true, force: true }); }
  }
});
