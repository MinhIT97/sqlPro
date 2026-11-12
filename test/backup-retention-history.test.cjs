'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { backupDirectory } = require('../electron/backup-catalog.cjs');
const { createRetentionHistory } = require('../electron/backup-retention-history.cjs');

const id = '20260101000000-aaaaaaaa.sql';
const plan = { policy: { maxCount: 1 }, rows: [{ id, action: 'remove' }] };
const success = { deleted: [id], remaining: [], failed: [], reclaimedBytes: 9 };

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-retention-history-'));
  return { root, history: createRetentionHistory(root),
    file: path.join(backupDirectory(root, 'p1', 'db'), 'retention-history.json'),
    close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('history survives reopen, isolates scope and records completion without raw errors or secrets', () => {
  const r = fixture();
  try {
    assert.deepEqual(r.history.read('p1', 'db'), []);
    const recordId = r.history.begin('p1', 'db', { ...plan, token: 'secret-token', sql: 'secret-sql' });
    assert.equal(createRetentionHistory(r.root).read('p1', 'db')[0].state, 'running');
    r.history.finish('p1', 'db', recordId, { ...success, failed: [{ id, code: 'EACCES', message: '/secret-path/password', sqlDeleted: true }] });
    const record = r.history.read('p1', 'db')[0];
    assert.equal(record.state, 'failed');
    assert.deepEqual(record.deleted, [id]);
    assert.equal(record.reclaimedBytes, 9);
    assert.equal(record.failed[0].code, 'EACCES');
    assert.equal(fs.readFileSync(r.file, 'utf8').includes('secret'), false);
    assert.deepEqual(r.history.read('other', 'db'), []);
    assert.deepEqual(r.history.read('p1', 'other'), []);
    if (process.platform !== 'win32') assert.equal(fs.statSync(r.file).mode & 0o777, 0o600);
    assert.throws(() => r.history.finish('p1', 'db', recordId, success));
  } finally { r.close(); }
});

test('history retains incomplete evidence while pruning oldest completed reports to 50', () => {
  const r = fixture();
  try {
    const incomplete = r.history.begin('p1', 'db', plan);
    for (let index = 0; index < 55; index++) {
      const current = r.history.begin('p1', 'db', plan);
      r.history.finish('p1', 'db', current, success);
    }
    const records = r.history.read('p1', 'db');
    assert.equal(records.length, 50);
    assert.ok(records.some(record => record.id === incomplete && record.state === 'running'));
    for (let index = records.filter(record => record.state === 'running').length; index < 50; index++) r.history.begin('p1', 'db', plan);
    assert.throws(() => r.history.begin('p1', 'db', plan), /quá nhiều lượt/);
    assert.equal(r.history.read('p1', 'db').length, 50);
  } finally { r.close(); }
});

test('failed publication preserves prior record and corrupted history never gets overwritten', () => {
  const r = fixture();
  const originalRename = fs.renameSync;
  try {
    const record = r.history.begin('p1', 'db', plan);
    const before = fs.readFileSync(r.file, 'utf8');
    fs.renameSync = () => { throw Object.assign(new Error('disk full fixture'), { code: 'ENOSPC' }); };
    assert.throws(() => r.history.finish('p1', 'db', record, success), { code: 'ENOSPC' });
    fs.renameSync = originalRename;
    assert.equal(fs.readFileSync(r.file, 'utf8'), before);
    assert.equal(fs.readdirSync(path.dirname(r.file)).some(file => file.endsWith('.part')), false);
    for (const text of ['{broken', JSON.stringify({ version: 99, records: [] }), 'x'.repeat(1024 * 1024 + 1)]) {
      fs.writeFileSync(r.file, text);
      assert.throws(() => r.history.read('p1', 'db'));
      assert.throws(() => r.history.begin('p1', 'db', plan));
      assert.equal(fs.readFileSync(r.file, 'utf8'), text);
    }
  } finally { fs.renameSync = originalRename; r.close(); }
});

test('history rejects a completed status with missing results and contradictions about deleted SQL', () => {
  const r = fixture();
  try {
    const record = r.history.begin('p1', 'db', plan);
    assert.throws(() => r.history.finish('p1', 'db', record, { ...success, deleted: [] }));
    assert.throws(() => r.history.finish('p1', 'db', record, { ...success, failed: [{ id, code: 'EACCES', sqlDeleted: false }] }));
    assert.equal(r.history.read('p1', 'db')[0].state, 'running');
    r.history.finish('p1', 'db', record, success);
    assert.equal(r.history.read('p1', 'db')[0].state, 'completed');
  } finally { r.close(); }
});
