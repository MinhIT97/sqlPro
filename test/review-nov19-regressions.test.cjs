'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const SchemaDiff = require('../schema-diff.js');
const RowValues = require('../row-values.js');
const Audit = require('../audit-log.js');
const { createAuditLogStore } = require('../electron/audit-log.cjs');
const { DatabaseSession } = require('../electron/database.cjs');
const { validateTableForDiff } = require('../electron/data-diff-reader.cjs');
const { DataSyncExecutor } = require('../electron/data-sync-executor.cjs');
const { DataSyncPlanService } = require('../electron/data-sync-plan-service.cjs');

test('N01: DEFAULT literals retain NULL/keyword strings and use mode-independent hex for escapes', () => {
  for (const value of ['NULL', 'CURRENT_TIMESTAMP', 'NOW()']) {
    const col = SchemaDiff.normalizeColumn({ name: 'v', type: 'varchar(100)', nullable: true, default: value });
    assert.equal(col.default, value);
    assert.match(SchemaDiff.formatColumnClause(col), new RegExp(`DEFAULT '${value.replace(/[()]/g, '\\$&')}'`));
  }
  for (const value of ['C:\\new', 'a\nb', 'a\0b', 'tiếng Việt']) {
    const sql = SchemaDiff.formatColumnClause({ name: 'v', type: 'varchar(100)', nullable: true, default: value });
    assert.ok(sql.includes(`DEFAULT _utf8mb4 0x${Buffer.from(value).toString('hex')}`));
  }
});

test('N02: text PK admission requires explicit UTF-8 NO PAD proof and rejects CHAR/PAD/unknown', async () => {
  for (const variant of ['pad', 'missing', 'wrong-charset', 'char', 'ok']) {
    const session = {
      listColumns: async () => [{ name: 'id', type: variant === 'char' ? 'char(20)' : 'varchar(20)', key: 'PRI', collation: variant === 'pad' ? 'utf8mb4_bin' : 'utf8mb4_0900_bin' }],
      raw: async sql => sql.includes('PAD_ATTRIBUTE')
        ? { result: variant === 'missing' ? [] : [{ name: 'utf8mb4_0900_bin', charset: variant === 'wrong-charset' ? 'latin1' : 'utf8mb4', padAttribute: 'NO PAD' }] }
        : { result: [{ engine: 'InnoDB' }] }
    };
    if (variant === 'ok') assert.deepEqual((await validateTableForDiff(session, 'db', 't')).primaryKeys, ['id']);
    else await assert.rejects(validateTableForDiff(session, 'db', 't'), { code: 'DATA_DIFF_UNSUPPORTED_PK_TYPE' }, variant);
  }
});

test('N03: private keys never reach new audit entries, disk or exports', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-n03-'));
  try {
    const store = createAuditLogStore(directory);
    for (const label of ['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'ENCRYPTED PRIVATE KEY']) {
      const secret = crypto.randomBytes(32).toString('base64');
      const block = `-----BEGIN ${label}-----\n${secret}\n-----END ${label}-----`;
      const entry = store.append({ summary: block, errorSummary: block });
      const outputs = [JSON.stringify(entry), fs.readFileSync(store.filePath, 'utf8'), Audit.exportAuditCsv(store.read()), Audit.exportAuditJson(store.read())];
      for (const output of outputs) assert.equal(output.includes(secret), false, label);
      assert.equal(Audit.sanitizeAuditSummary(block.split('-----END')[0]).includes(secret), false, 'truncated block');
    }
    const oldSecret = crypto.randomBytes(32).toString('base64');
    fs.writeFileSync(store.filePath, JSON.stringify({ version: 1, entries: [{ summary: `-----BEGIN PRIVATE KEY----- ${oldSecret} -----END PRIVATE KEY-----` }] }));
    assert.equal(JSON.stringify(store.read()).includes(oldSecret), false, 'legacy read is sanitized');
    store.append({ summary: 'new entry' });
    assert.equal(fs.readFileSync(store.filePath, 'utf8').includes(oldSecret), false, 'next rewrite removes legacy key');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('N04: public plan boundary rejects caller reports/scopes and missing Main service', () => {
  const service = new DataSyncPlanService();
  assert.throws(() => service.createSyncPlanFromJob({ jobId: 'forged', diffReport: {} }), { code: 'CALLER_FIELDS_REJECTED' });
  assert.throws(() => service.createSyncPlanFromJob({ jobId: 'missing' }), { code: 'DIFF_JOB_SERVICE_UNAVAILABLE' });
  assert.throws(() => service.createSyncPlanFromJob({}), { code: 'DIFF_JOB_NOT_FOUND' });
});

test('N05: only a whole unconditional JSON_VALID constraint proves JSON for its exact column', async () => {
  const positive = ['JSON_VALID(`payload`)', '(json_valid(payload))', '((json_valid(`payload`)))'];
  const negative = ["json_valid(`payload`) OR payload='plain'", 'NOT json_valid(payload)', 'json_valid(other)', "payload='json_valid(payload)'", 'json_valid(payload) AND id > 0', 'json_valid(payload))', '(json_valid(payload)'];
  for (const clause of [...positive, ...negative]) {
    const session = new DatabaseSession({}); session.version = '11.4-MariaDB';
    session.raw = async sql => ({ result: sql.includes('CHECK_CONSTRAINTS') ? [{ checkClause: clause }]
      : [{ name: 'payload', type: 'longtext', nullable: 'YES', position: 1 }] });
    const [column] = await session.listColumns('db', 't', { fresh: true });
    assert.equal(column.isJson === true, positive.includes(clause), clause);
    assert.equal(RowValues.describe({ name: 'payload', type: 'longtext', checkClause: clause }).kind === 'json', positive.includes(clause), clause);
    if (!positive.includes(clause)) assert.equal(RowValues.normalizeValue(column, 'plain'), 'plain');
  }
  assert.equal(RowValues.jsonConstraintColumn('json_valid(`a``b`)'), 'a`b');
});

test('N06: browser normalizer without Buffer returns validation errors for object inputs', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../row-values.js'), 'utf8'), context);
  for (const raw of [{}, []]) assert.throws(() => context.SqlRowValues.normalizeValue({ name: 'v', type: 'varchar(20)' }, raw), /object\/mảng/);
  assert.equal(context.SqlRowValues.normalizeValue({ name: 'v', type: 'json' }, { ok: true }), '{"ok":true}');
  assert.equal(context.SqlRowValues.normalizeValue({ name: 'v', type: 'varchar(20)' }, 'plain'), 'plain');
  assert.equal(vm.runInContext("SqlRowValues.normalizeValue({name:'v',type:'varchar(20)'},new Uint8Array([1]))", context), '1');
});

test('N07: unknown/malformed engine or trigger metadata stops all DML and rolls back', async () => {
  for (const variant of ['empty-engine', 'malformed-engine', 'duplicate-engine', 'malformed-triggers', 'ok']) {
    const calls = [], columns = [{ name: 'id', type: 'int', key: 'PRI' }];
    const worker = {
      connect: async () => {}, useDatabase: async () => {}, close: async () => {}, listColumns: async () => columns,
      raw: async sql => {
        calls.push(sql);
        if (sql === 'SHOW GRANTS') return { result: [{ grants: "GRANT SELECT, TRIGGER ON *.* TO 'fixture'@'%'" }] };
        if (sql.includes('SELECT ENGINE')) return { result: variant === 'empty-engine' ? [] : variant === 'malformed-engine' ? {} : variant === 'duplicate-engine' ? [{ ENGINE: 'InnoDB' }, { ENGINE: 'InnoDB' }] : [{ ENGINE: 'InnoDB' }] };
        if (sql.includes('SELECT TRIGGER_NAME')) return { result: variant === 'malformed-triggers' ? {} : [] };
        if (sql.includes('REFERENTIAL_CONSTRAINTS')) return { result: [] };
        return { result: { affectedRows: 1 } };
      }
    };
    const executor = new DataSyncExecutor({ consumePlan: () => ({ targetScope: { profileId: 'p', database: 'db', table: 't' }, columns, primaryKeys: ['id'], operations: [{ type: 'INSERT', values: { id: 1 } }] }), getProfileWithSecrets: () => ({ readOnly: false }), createSession: () => worker });
    const pending = executor.executeSyncPlan({ planToken: 'test' });
    if (variant === 'ok') {
      assert.equal((await pending).success, true);
      assert.ok(calls.indexOf('START TRANSACTION') < calls.findIndex(sql => sql.startsWith('SELECT 1 FROM')));
      assert.ok(calls.findIndex(sql => sql.startsWith('SELECT 1 FROM')) < calls.findIndex(sql => sql.includes('SELECT ENGINE')));
    } else {
      await assert.rejects(pending, { code: 'SYNC_METADATA_UNVERIFIED' }, variant);
      assert.equal(calls.some(sql => /^INSERT|^UPDATE|^DELETE|^COMMIT/.test(sql)), false);
      assert.ok(calls.includes('ROLLBACK'));
    }
  }
});
