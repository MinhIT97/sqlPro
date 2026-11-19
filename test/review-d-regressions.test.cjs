'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const SchemaDiff = require('../schema-diff.js');
const { SchemaMigrationGenerator } = require('../electron/schema-migration-generator.cjs');
const { SchemaSnapshotCollector } = require('../electron/schema-snapshot.cjs');
const { DataSyncExecutor } = require('../electron/data-sync-executor.cjs');
const { DatabaseSession } = require('../electron/database.cjs');
const { BackupReplicaManager } = require('../electron/backup-replica-manager.cjs');
const { saveBackupFile, readManifest } = require('../electron/backup-file.cjs');
const { writeAnnotations, readAnnotations } = require('../electron/backup-annotations.cjs');
const { loadRenderer } = require('./helpers/renderer.cjs');

const table = (name, extra = {}) => ({ name, columns: [{ name: 'id', type: 'int', nullable: false, default: null }], indexes: [], foreignKeys: [], foreignKeysStatus: 'complete', checkConstraintsStatus: 'complete', checkConstraints: [], ...extra });
const snapshot = (id, tables) => ({ engine: 'MySQL', database: id, coverage: 'complete', scope: { profileId: id, lowerCaseTableNames: 0 }, tables, views: [], routines: [], triggers: [], events: [] });
const planFor = t => new SchemaMigrationGenerator().generateMigrationPlan({ sourceSnapshot: snapshot('src', [t]), targetSnapshot: snapshot('tgt', []) });

test('D01: normalize/format preserve case and quotes of ENUM/SET members; type comparison sees changed members', () => {
  for (const type of ["ENUM('pending','Done')", "SET('a','B','O''Reilly')", "ENUM('Việt','日本')"]) {
    const normalized = SchemaDiff.normalizeColumn({ name: 'v', type, nullable: true });
    const sql = SchemaDiff.formatColumnClause(normalized);
    assert.ok(sql.includes(type));
    assert.ok(SchemaDiff.compareColumns(normalized, SchemaDiff.normalizeColumn({ name: 'v', type: type.toUpperCase(), nullable: true })).includes('type'));
  }
  assert.equal(planFor(table('t', { columns: [{ name: 'v', type: "ENUM('C:\\new')", nullable: true }] })).blockReason, 'COLUMN_TYPE_SQL_MODE_UNSUPPORTED');
});

test('D02: schema diff retains both case-only table names and distinguishes case-only changes', () => {
  const source = snapshot('src', [table('Twin'), table('twin')]), target = snapshot('tgt', []);
  const normalized = SchemaDiff.normalizeSchemaSnapshot(source);
  assert.deepEqual(normalized.tables.map(t => t.name), ['Twin', 'twin']);
  const result = new SchemaMigrationGenerator().generateMigrationPlan({ sourceSnapshot: source, targetSnapshot: target });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.statements.map(s => s.table), ['Twin', 'twin']);
  const diff = SchemaDiff.compareSchemas(snapshot('src', [table('Twin')]), snapshot('tgt', [table('twin')]));
  assert.equal(diff.tables.added.length, 1); assert.equal(diff.tables.dropped.length, 1);
  for (const mode of [null, 1, 2]) {
    const ambiguousTarget = { ...target, scope: { ...target.scope, lowerCaseTableNames: mode } };
    assert.equal(new SchemaMigrationGenerator().generateMigrationPlan({ sourceSnapshot: source, targetSnapshot: ambiguousTarget }).blockReason, 'TABLE_NAME_CASE_UNVERIFIED');
  }
});

test('D03: collector records CHECK inventory; unknown/denied/malformed CHECK metadata never admits migration', async () => {
  for (const variant of ['check', 'none', 'denied', 'malformed']) {
    const session = {
      version: '8.4.13', profile: {},
      listTables: async () => [{ name: 't', type: 'table', engine: 'InnoDB' }],
      listColumns: async () => [{ name: 'id', type: 'int', nullable: 'NO' }],
      listIndexes: async () => [], listRelations: async () => ({ outbound: [] }),
      listRoutines: async () => [], listEvents: async () => [],
      raw: async sql => {
        if (sql.includes('TABLE_CONSTRAINTS')) {
          if (variant === 'denied') throw new Error('denied');
          return { result: variant === 'check' ? [{ tableName: 't', name: 'positive' }] : variant === 'malformed' ? [{}] : [] };
        }
        return { result: [] };
      }
    };
    const source = await new SchemaSnapshotCollector(session, { profileId: 'src', sessionId: 's', generation: 0, profileFingerprint: 'a'.repeat(64) }).collect('src');
    const result = new SchemaMigrationGenerator().generateMigrationPlan({ sourceSnapshot: source, targetSnapshot: snapshot('tgt', []) });
    if (variant === 'none') assert.equal(result.status, 'ready');
    else {
      assert.equal(result.status, 'blocked');
      assert.equal(source.tables[0].checkConstraintsStatus, variant === 'check' ? 'complete' : 'unknown');
    }
  }
  assert.equal(planFor(table('t', { checkConstraintsStatus: undefined })).blockReason, 'CHECK_METADATA_INCOMPLETE');
});

test('D04: text original guards use byte comparison and missing snapshots stop before UPDATE/DELETE', async () => {
  for (const operation of ['UPDATE', 'DELETE']) {
    for (const complete of [true, false]) {
      const sql = [], columns = [{ name: 'id', type: 'int', key: 'PRI' }, { name: 'val', type: 'varchar(20)' }];
      const worker = { connect: async () => {}, close: async () => {}, useDatabase: async () => {}, listColumns: async () => columns,
        raw: async query => { sql.push(query); return { result: query === 'SHOW GRANTS' ? [{ grants: "GRANT SELECT, TRIGGER ON *.* TO 'fixture'@'%'" }] : query.includes('SELECT ENGINE') ? [{ ENGINE: 'InnoDB' }] : (query.includes('SELECT TRIGGER_NAME') || query.includes('REFERENTIAL_CONSTRAINTS')) ? [] : { affectedRows: 0 } }; } };
      const executor = new DataSyncExecutor({ consumePlan: () => ({ targetScope: { profileId: 'p', database: 'd', table: 't' }, primaryKeys: ['id'], columns, operations: [{ type: operation, values: { id: 1, val: 'new' }, pkValues: [1], originalValues: complete ? { id: 1, val: 'old' } : { id: 1 } }] }), getProfileWithSecrets: () => ({}), createSession: () => worker });
      await assert.rejects(executor.executeSyncPlan({ planToken: 'fixture' }), { code: complete ? 'SYNC_CONFLICT_DETECTED' : 'SYNC_ORIGINAL_INCOMPLETE' });
      const write = sql.find(q => q.startsWith(operation));
      if (complete) assert.ok(write.includes('CAST(`val` AS BINARY) <=> CAST(? AS BINARY)'));
      else assert.equal(write, undefined);
      assert.ok(sql.includes('ROLLBACK')); assert.equal(sql.includes('COMMIT'), false);
    }
  }
});

test('D05: production fatal handlers log no arbitrary secret and exit before continuing', () => {
  const modulePath = path.join(__dirname, '../electron/main-errors.cjs');
  for (const mode of ['exception', 'rejection']) {
    const marker = crypto.randomBytes(16).toString('hex');
    const source = `require(${JSON.stringify(modulePath)}).installMainErrorHandlers(); const e=Object.assign(new Error(${JSON.stringify(marker)}),{sql:${JSON.stringify(marker)}}); ${mode === 'exception' ? 'setTimeout(()=>{throw e},0)' : 'Promise.reject(e)'}; setTimeout(()=>console.log('continued'),30);`;
    const child = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', timeout: 3000 });
    assert.equal(child.status, 1); assert.equal(child.stderr.includes(marker), false); assert.equal(child.stdout.includes('continued'), false);
  }
  assert.ok(fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8').includes("require('./main-errors.cjs').installMainErrorHandlers()"));
});

test('D06: comments requiring SQL-mode escaping block generation/preview instead of silently changing', () => {
  for (const comment of ['C:\\new', 'a\nb', "a\\'b"]) {
    assert.equal(planFor(table('t', { comment })).blockReason, 'COMMENT_LITERAL_UNSUPPORTED');
    assert.equal(planFor(table('t', { columns: [{ name: 'v', type: 'int', comment }] })).blockReason, 'COMMENT_LITERAL_UNSUPPORTED');
    assert.throws(() => SchemaDiff.formatColumnClause({ name: 'v', type: 'int', nullable: true, comment }), /COMMENT_LITERAL_UNSUPPORTED/);
  }
  assert.ok(SchemaDiff.formatColumnClause({ name: 'v', type: 'int', nullable: true, comment: " O'Reilly " }).includes("COMMENT ' O''Reilly '"));
});

test('D07: replica publishes the canonical manifest and annotations under the same nonconflicting basename', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-d07-'));
  try {
    const source = path.join(dir, 'source.sql'), dest = path.join(dir, 'dest');
    fs.mkdirSync(dest);
    await saveBackupFile(source, async write => { await write('SELECT 1;'); return { bytes: 9 }; });
    await writeAnnotations(source, { name: 'Remember', pinned: true });
    fs.writeFileSync(source + '.manifest.json', JSON.stringify({ tag: 'source-legacy' }));
    fs.writeFileSync(path.join(dest, 'source.sql.json'), 'unrelated');
    fs.writeFileSync(path.join(dest, 'source.sql.manifest.json'), JSON.stringify({ tag: 'unrelated-legacy' }));
    const result = await new BackupReplicaManager().createReplica({ sourceFilePath: source, destinationDir: dest });
    assert.equal(result.verified, true); assert.equal(result.manifestCopied, true); assert.equal(result.annotationsCopied, true);
    assert.notEqual(result.replicaPath, path.join(dest, 'source.sql'));
    assert.equal(fs.readFileSync(path.join(dest, 'source.sql.json'), 'utf8'), 'unrelated');
    assert.equal((await readManifest(result.replicaPath)).manifest.checksum.value, result.fileChecksum);
    assert.equal((await readAnnotations(result.replicaPath)).pinned, true);
    assert.equal(JSON.parse(fs.readFileSync(result.replicaPath + '.manifest.json', 'utf8')).tag, 'source-legacy');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dest, 'source.sql.manifest.json'), 'utf8')).tag, 'unrelated-legacy');
    fs.writeFileSync(source + '.json', 'broken');
    const before = fs.readdirSync(dest);
    await assert.rejects(new BackupReplicaManager().createReplica({ sourceFilePath: source, destinationDir: dest }), { code: 'REPLICA_MANIFEST_INVALID' });
    assert.deepEqual(fs.readdirSync(dest), before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('D07: metadata publication failure leaves no discoverable SQL; transient retry is confined to staging', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-d07-fault-')), link = fs.promises.link;
  try {
    const source = path.join(dir, 'source.sql'), dest = path.join(dir, 'dest');
    await saveBackupFile(source, async write => { await write('SELECT 1;'); return { bytes: 9 }; });
    await writeAnnotations(source, { pinned: true });
    fs.promises.link = async (from, to) => {
      if (to === path.join(dest, 'source.sql.name.json')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return link(from, to);
    };
    const manager = new BackupReplicaManager({ retryDelayMs: 0 });
    await assert.rejects(manager.createReplica({ sourceFilePath: source, destinationDir: dest }), { code: 'EACCES' });
    assert.deepEqual(fs.readdirSync(dest), []);
    fs.promises.link = link;
    let attempts = 0;
    const copy = manager.copyAtomic.bind(manager);
    manager.copyAtomic = (...args) => {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error('transient'), { code: 'EIO' });
      return copy(...args);
    };
    const result = await manager.createReplica({ sourceFilePath: source, destinationDir: dest });
    assert.equal(result.attempts, 2); assert.equal(result.manifestCopied, true);
    assert.equal((await readManifest(result.replicaPath)).manifest.checksum.value, result.fileChecksum);
  } finally { fs.promises.link = link; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('D08: delayed replica/container results do not touch a new dialog or changed profile', async () => {
  let resolveReplica, resolveInfo, click;
  const input = { value: '/tmp/fixture' }, button = { disabled: false, addEventListener: (_, fn) => { click = fn; } };
  const dialog = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
  const r = loadRenderer({ elements: new Map([['#modal', dialog], ['#replicaDestDirInput', input], ['#confirmCreateReplicaBtn', button]]), desktop: { db: { createBackupReplica: () => new Promise(resolve => { resolveReplica = resolve; }), inspectBackupContainer: () => new Promise(resolve => { resolveInfo = resolve; }) } } });
  r.evaluate("app.connection={id:'p'}; app.database='d'; app.selectedBackupId='b'; app.backups=[{id:'b'}]");
  await r.evaluate("runBackupManagerAction('create-replica')"); const pending = click();
  r.evaluate("closeModal(); modal('new-dialog')"); resolveReplica({ ok: true, data: { replicaPath: 'fixture' } }); await pending;
  assert.equal(dialog.open, true); assert.equal(dialog.innerHTML, 'new-dialog');
  const info = r.evaluate("runBackupManagerAction('container-info')");
  r.evaluate("app.connection={id:'changed'}; modal('other-profile-dialog')"); resolveInfo({ ok: true, data: {} }); await info;
  assert.equal(dialog.innerHTML, 'other-profile-dialog'); assert.equal(r.messages.length, 0);
});

test('D09: actual connect listeners ignore old connection errors but current errors invalidate the session', async () => {
  const mysql = require('mysql2'), original = mysql.createConnection, connections = [];
  mysql.createConnection = () => {
    const connection = new EventEmitter(); connection.connect = cb => cb(); connection.end = cb => cb(); connection.destroy = () => {};
    connections.push(connection); return connection;
  };
  try {
    const session = new DatabaseSession({}); session.raw = async () => ({ rows: [{ version: 'fixture' }] }); session.readTlsState = async () => ({});
    await session.connect(); await session.connect();
    let sshClosed = 0;
    const tunnel = { end() { sshClosed++; } }; session.ssh = tunnel;
    connections[0].emit('error', new Error('old')); assert.equal(session.dead, false); session.ensureOpen();
    assert.equal(session.ssh, tunnel); assert.equal(sshClosed, 0);
    connections[1].emit('error', new Error('current')); assert.equal(session.dead, true);
    assert.equal(sshClosed, 1); assert.equal(session.ssh, null);
    assert.throws(() => session.ensureOpen(), { code: 'SESSION_CLOSED' }); await session.close();
  } finally { mysql.createConnection = original; }
});

test('D09: old SSH client/stream events never invalidate a replacement tunnel', async () => {
  const clients = [];
  class Client extends EventEmitter {
    constructor() { super(); clients.push(this); this.stream = new EventEmitter(); this.stream.destroy = () => {}; }
    connect() { queueMicrotask(() => this.emit('ready')); }
    forwardOut(_host, _port, _dest, _dport, cb) { cb(null, this.stream); }
    end() { this.emit('close'); }
  }
  const filename = path.join(__dirname, '../electron/database.cjs'), nodeRequire = createRequire(filename), module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, require: id => id === 'ssh2' ? { Client } : nodeRequire(id), Buffer, process, console, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const session = new module.exports.DatabaseSession({ host: 'db', port: 3306, ssh: { enabled: true } });
  await session.openSshTunnel(); session.closeSsh(); ++session.connectionGeneration;
  await session.openSshTunnel();
  clients[0].emit('close'); clients[0].emit('error', new Error('old')); clients[0].stream.emit('error', new Error('old stream'));
  assert.equal(session.dead, false); assert.equal(session.ssh, clients[1]);
  clients[1].stream.emit('error', new Error('current stream')); assert.equal(session.dead, true); session.closeSsh();
});
