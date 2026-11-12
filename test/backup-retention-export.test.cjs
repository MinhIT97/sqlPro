'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRetentionHistory, buildRetentionHistoryReport } = require('../electron/backup-retention-history.cjs');
const { exportRetentionHistory } = require('../electron/backup-retention-export.cjs');

const backupId = '20260101000000-aaaaaaaa.sql';
const plan = { policy: { maxCount: 1 }, rows: [{ id: backupId, action: 'remove' }] };

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-retention-export-'));
  const userData = path.join(root, 'userData');
  await fs.mkdir(userData);
  const history = createRetentionHistory(userData);
  const id = history.begin('p1', 'db', plan);
  return { root, userData, history, id, filePath: path.join(root, 'report.json'), close: () => fs.rm(root, { recursive: true, force: true }) };
}

test('export produces versioned JSON and projects only safe fields with incomplete/active state', async () => {
  const r = await fixture();
  try {
    const records = r.history.read('p1', 'db');
    records[0].token = 'secret-token'; records[0].sql = 'secret-sql'; records[0].host = 'secret-host';
    const before = structuredClone(records);
    const result = await exportRetentionHistory({ ...r, records, appVersion: '0.3.12' });
    assert.equal(result.records, 1);
    const text = await fs.readFile(r.filePath, 'utf8');
    assert.equal(text.includes('secret'), false);
    const report = JSON.parse(text);
    assert.equal(report.kind, 'sqlpro-backup-retention-history');
    assert.equal(report.version, 1);
    assert.equal(report.appVersion, '0.3.12');
    assert.equal(report.records[0].state, 'incomplete');
    assert.deepEqual(report.records[0].planned, [backupId]);
    assert.equal(buildRetentionHistoryReport(records, { activeHistoryId: r.id }).records[0].state, 'running');
    assert.deepEqual(records, before);
    assert.equal(r.history.read('p1', 'db')[0].state, 'running');
    if (process.platform !== 'win32') assert.equal((await fs.stat(r.filePath)).mode & 0o777, 0o600);
  } finally { await r.close(); }
});

test('export refuses destinations inside userData including directory symlink aliases', async t => {
  const r = await fixture();
  try {
    const original = path.join(r.userData, 'original.json');
    await fs.writeFile(original, 'DO NOT MODIFY');
    const records = r.history.read('p1', 'db');
    await assert.rejects(() => exportRetentionHistory({ ...r, filePath: original, records }), /bên ngoài/);
    assert.equal(await fs.readFile(original, 'utf8'), 'DO NOT MODIFY');
    try { await fs.symlink(r.userData, path.join(r.root, 'alias'), 'dir'); }
    catch (error) { if (['EPERM', 'ENOTSUP'].includes(error.code)) { t.diagnostic('directory symlink unavailable'); return; } throw error; }
    await assert.rejects(() => exportRetentionHistory({ ...r, filePath: path.join(r.root, 'alias', 'original.json'), records }), /bên ngoài/);
    assert.equal(await fs.readFile(original, 'utf8'), 'DO NOT MODIFY');
  } finally { await r.close(); }
});

test('failed publication preserves existing export and removes temporary file', async () => {
  const r = await fixture();
  const originalRename = fs.rename;
  try {
    await fs.writeFile(r.filePath, 'existing report');
    fs.rename = async () => { throw Object.assign(new Error('disk full fixture'), { code: 'ENOSPC' }); };
    await assert.rejects(() => exportRetentionHistory({ ...r, records: r.history.read('p1', 'db') }), { code: 'ENOSPC' });
    assert.equal(await fs.readFile(r.filePath, 'utf8'), 'existing report');
    assert.deepEqual((await fs.readdir(r.root)).sort(), ['report.json', 'userData']);
  } finally { fs.rename = originalRename; await r.close(); }
});
