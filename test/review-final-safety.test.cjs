'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { encryptBackupFile, decryptBackupFile, inspectBackupContainer, deriveKey, MAGIC, HEADER_SIZE } = require('../electron/backup-crypto.cjs');
const { parseCron, calculateNextRun } = require('../electron/backup-calendar-calculator.cjs');
const { DataDiffService, sanitizeDiffError } = require('../electron/data-diff-service.cjs');
const { TableKeysetReader, validateTableForDiff } = require('../electron/data-diff-reader.cjs');

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-final-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('encryption and successful decryption never overwrite an existing destination', async t => {
  const dir = directory(t), sql = path.join(dir, 'source.sql'), enc = path.join(dir, 'copy.enc'), out = path.join(dir, 'existing.sql');
  fs.writeFileSync(sql, 'SELECT 123;');
  fs.writeFileSync(enc, 'old encrypted backup');
  await assert.rejects(() => encryptBackupFile(sql, enc, { passphrase: 'review-passphrase' }), { code: 'BACKUP_DESTINATION_EXISTS' });
  assert.equal(fs.readFileSync(enc, 'utf8'), 'old encrypted backup');
  fs.unlinkSync(enc);
  await encryptBackupFile(sql, enc, { passphrase: 'review-passphrase' });
  fs.writeFileSync(out, 'old plaintext backup');
  await assert.rejects(() => decryptBackupFile(enc, out, { passphrase: 'review-passphrase' }), { code: 'BACKUP_DESTINATION_EXISTS' });
  assert.equal(fs.readFileSync(out, 'utf8'), 'old plaintext backup');
  assert.equal(fs.readdirSync(dir).some(name => name.endsWith('.part')), false);
});

test('publication collision at the final instant preserves the concurrent destination', async t => {
  const dir = directory(t), sql = path.join(dir, 'input.sql'), dest = path.join(dir, 'output.enc');
  fs.writeFileSync(sql, 'SELECT 1;');
  const originalLink = fs.promises.link;
  fs.promises.link = async (source, target) => {
    if (target === dest) fs.writeFileSync(dest, 'concurrent backup', { flag: 'wx' });
    return originalLink(source, target);
  };
  try {
    await assert.rejects(() => encryptBackupFile(sql, dest, { passphrase: 'review-passphrase' }), { code: 'BACKUP_DESTINATION_EXISTS' });
    assert.equal(fs.readFileSync(dest, 'utf8'), 'concurrent backup');
  } finally { fs.promises.link = originalLink; }
});

test('new encrypted container authenticates header flags; unknown versions/ciphers and truncation fail closed', async t => {
  const dir = directory(t), sql = path.join(dir, 'input.sql'), enc = path.join(dir, 'input.enc');
  fs.writeFileSync(sql, 'SELECT 1;');
  await encryptBackupFile(sql, enc, { passphrase: 'review-passphrase' });
  assert.equal((await inspectBackupContainer(enc)).version, 2);
  const original = fs.readFileSync(enc);
  for (const [offset, value] of [[14, 99], [15, 2], [16, 0]]) {
    const bytes = Buffer.from(original); bytes[offset] = value;
    const input = path.join(dir, `tampered-${offset}.enc`), output = input + '.sql';
    fs.writeFileSync(input, bytes);
    await assert.rejects(() => decryptBackupFile(input, output, { passphrase: 'review-passphrase' }));
    assert.equal(fs.existsSync(output), false);
  }
  const short = path.join(dir, 'short.enc'); fs.writeFileSync(short, original.subarray(0, 20));
  await assert.rejects(() => inspectBackupContainer(short), { code: 'BACKUP_FILE_CORRUPT' });
});

test('legacy V1 containers remain readable without changing their bytes', async t => {
  const dir = directory(t), input = path.join(dir, 'legacy.enc'), output = path.join(dir, 'legacy.sql');
  const header = Buffer.alloc(HEADER_SIZE); MAGIC.copy(header); header[14] = 1; header[15] = 1;
  crypto.randomBytes(32).copy(header, 17); crypto.randomBytes(12).copy(header, 49);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey('legacy-passphrase', header.subarray(17, 49)), header.subarray(49, 61));
  fs.writeFileSync(input, Buffer.concat([header, cipher.update('SELECT 42;'), cipher.final(), cipher.getAuthTag()]));
  const before = fs.readFileSync(input);
  await decryptBackupFile(input, output, { passphrase: 'legacy-passphrase' });
  assert.equal(fs.readFileSync(output, 'utf8'), 'SELECT 42;');
  assert.deepEqual(fs.readFileSync(input), before);
});

test('empty backups round-trip with and without compression', async t => {
  const dir = directory(t), sql = path.join(dir, 'empty.sql');
  fs.writeFileSync(sql, '');
  for (const compress of [true, false]) {
    const enc = path.join(dir, `empty-${compress}.enc`), out = enc + '.sql';
    await encryptBackupFile(sql, enc, { passphrase: 'empty-passphrase', compress });
    await decryptBackupFile(enc, out, { passphrase: 'empty-passphrase' });
    assert.equal(fs.statSync(out).size, 0);
  }
});

test('cron rejects partial numbers and malformed ranges instead of scheduling a different time', () => {
  for (const field of ['1junk', '*/2x', '1-2-3', '1,', '-1', '*/0', '70', '1/2']) {
    assert.throws(() => parseCron(`${field} * * * *`), { code: 'INVALID_CRON_FIELD' });
  }
  assert.deepEqual([...parseCron('1-5/2 * * * *').minutes], [1, 3, 5]);
});

test('cron day fields use OR when both restricted; Sunday 7 and DST transitions are supported', () => {
  const from = new Date('2026-11-18T14:00:00Z');
  assert.equal(calculateNextRun('0 14 1 * 1', from).toISOString(), '2026-11-23T14:00:00.000Z');
  assert.equal(calculateNextRun('0 14 * * 7', from).toISOString(), '2026-11-22T14:00:00.000Z');
  assert.equal(calculateNextRun('30 1 * * *', new Date('2026-11-01T05:31:00Z'), 'America/New_York').toISOString(), '2026-11-01T06:30:00.000Z');
  assert.throws(() => calculateNextRun('* * * * *', new Date('invalid')), { code: 'INVALID_SCHEDULE_DATE' });
});

test('Data Diff never exposes raw error messages even when the code is allowed', () => {
  for (const code of ['ER_PARSE_ERROR', 'DATA_DIFF_SCHEMA_MISMATCH']) {
    assert.equal(JSON.stringify(sanitizeDiffError({ code, message: 'private SQL password row-data' })).includes('private SQL'), false);
  }
});

function diffFixture(options = {}) {
  const profile = { id: 'p', host: 'before' }, state = { closes: 0, open: false, queries: [] };
  const service = new DataDiffService({ store: { getWithSecrets: () => profile }, timeoutMs: options.timeoutMs ?? 2000,
    createSession: () => ({
      async connect() { await options.connect?.(); state.open = true; },
      async useDatabase() {},
      async listColumns() { return [{ name: 'id', type: 'int', key: 'PRI' }]; },
      async raw(sql) { state.queries.push(sql); return sql.includes('information_schema.TABLES') ? { result: [{ engine: 'InnoDB' }] } : { rows: [{ id: 1 }] }; },
      async close() { state.closes++; await options.close?.(); state.open = false; }
    }) });
  const start = () => service.startDiff({ sourceProfileId: 'p', targetProfileId: 'p', sourceDb: 'db', targetDb: 'db', sourceTable: 'a', targetTable: 'b' });
  return { service, state, profile, start };
}

test('completed Data Diff status crosses structured-clone IPC and callers cannot mutate its stored report', async () => {
  const f = diffFixture(), { jobId } = await f.start();
  await f.service.jobs.get(jobId).promise;
  const status = f.service.getDiffStatus(jobId);
  assert.equal(status.status, 'completed');
  assert.doesNotThrow(() => structuredClone(status));
  status.report.identical.length = 0;
  assert.equal(f.service.getDiffStatus(jobId).report.identical.length, 1);
  assert.equal(f.service.getDiffStatus(jobId).report.coverage.canSynchronize, false);
  await f.service.clear();
});

test('Data Diff exposes no completed report while closing, and a failed close never becomes success', async () => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  let closeCount = 0;
  const f = diffFixture({ close: () => {
    if (++closeCount === 1) { entered(); return new Promise(resolve => { release = resolve; }); }
  } });
  const { jobId } = await f.start(); await started;
  assert.equal(f.service.getDiffStatus(jobId).status, 'running');
  assert.equal(f.service.getDiffStatus(jobId).report, null);
  release(); await f.service.jobs.get(jobId).promise;
  assert.equal(f.service.getDiffStatus(jobId).status, 'completed');
  await f.service.clear();
  const broken = diffFixture({ close: () => { throw new Error('private close error'); } });
  const failed = await broken.start(); await broken.service.jobs.get(failed.jobId).promise;
  assert.equal(broken.service.getDiffStatus(failed.jobId).status, 'failed');
  assert.equal(broken.service.getDiffStatus(failed.jobId).report, null);
  assert.equal(broken.service.getDiffStatus(failed.jobId).error.code, 'DATA_DIFF_WORKER_CLOSE_FAILED');
  await broken.service.clear();
});

test('Data Diff reset invalidates immediately and closes a connect that completes late', async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = diffFixture({ connect: () => { entered(); return new Promise(resolve => { release = resolve; }); } });
  const { jobId } = await f.start(); await started;
  const clearing = f.service.clear();
  assert.throws(() => f.service.getDiffStatus(jobId), { code: 'DATA_DIFF_JOB_NOT_FOUND' });
  await clearing;
  const closes = f.state.closes;
  release(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.state.closes > closes); assert.equal(f.state.open, false); assert.deepEqual(f.state.queries, []);
});

test('Data Diff deadlines and target drift prevent further database reads', async () => {
  const hung = diffFixture({ timeoutMs: 20, connect: () => new Promise(() => {}) });
  const { jobId } = await hung.start(); await hung.service.jobs.get(jobId).promise;
  assert.equal(hung.service.getDiffStatus(jobId).error.code, 'QUERY_TIMEOUT');
  await hung.service.clear();
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const drift = diffFixture({ connect: () => { entered(); return new Promise(resolve => { release = resolve; }); } });
  const result = await drift.start(); await started; drift.profile.host = 'after'; release();
  await drift.service.jobs.get(result.jobId).promise;
  assert.equal(drift.service.getDiffStatus(result.jobId).error.code, 'DATA_DIFF_CONTEXT_CHANGED');
  assert.deepEqual(drift.state.queries, []); await drift.service.clear();
});

test('missing engine proof never becomes InnoDB and collation-dependent primary keys are blocked', async () => {
  const queries = [];
  const session = { async listColumns() { return [{ name: 'id', type: 'int', key: 'PRI' }]; },
    async raw(sql) { queries.push(sql); throw new Error('metadata denied'); } };
  const reader = new TableKeysetReader(session, 'db', 'table'); await reader.init();
  assert.equal(reader.engine, null); assert.equal(reader.inTransaction, false);
  assert.equal(queries.some(sql => sql.startsWith('START TRANSACTION')), false);
  for (const type of ['varchar(50)', 'enum(\'b\',\'a\')', 'time']) {
    await assert.rejects(() => validateTableForDiff({ ...session, async listColumns() { return [{ name: 'id', type, key: 'PRI' }]; } }, 'db', 'table'), { code: 'DATA_DIFF_UNSUPPORTED_PK_TYPE' });
  }
});
