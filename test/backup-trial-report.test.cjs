'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { buildManifest, writeManifest, readManifest, fileIdentity } = require('../electron/backup-file.cjs');
const { backupName, listBackups, verifyBackup } = require('../electron/backup-catalog.cjs');
const { recordBackupTrial } = require('../electron/backup-trial-report.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-trial-report-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const id = backupName(), directory = require('../electron/backup-catalog.cjs').backupDirectory(root, 'p', 'd');
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, id), sql = 'CREATE TABLE tested (id INT);';
  await fs.writeFile(file, sql);
  const checksum = crypto.createHash('sha256').update(sql).digest('hex');
  await writeManifest(file, buildManifest(checksum, { bytes: Buffer.byteLength(sql) }));
  return { root, id, file, checksum, identity: fileIdentity(await fs.stat(file)),
    report: { status: 'verified', cleanup: 'removed', checksum, finishedAt: new Date().toISOString() } };
}

test('only a successful matching trial and confirmed cleanup promotes the current SQL manifest', async t => {
  const r = await fixture(t);
  await recordBackupTrial(r.file, r.report, r.identity);
  let entry = (await listBackups(r.root, 'p', 'd'))[0];
  assert.equal(entry.verification.restore, 'verified');
  assert.equal(entry.verification.checksum, 'verified');
  await fs.appendFile(r.file, '-- changed');
  entry = (await listBackups(r.root, 'p', 'd'))[0];
  assert.equal(entry.verification.restore, 'not-tested');
  assert.equal(entry.verification.checksum, 'unverified');
  const mismatch = await verifyBackup(r.root, 'p', 'd', r.id);
  assert.equal(mismatch.match, false);
  assert.equal(mismatch.verification.restore, 'not-tested');
});

test('drift, wrong checksum, unsuccessful trial or cleanup never promotes restore verification', async t => {
  const r = await fixture(t);
  for (const change of [{ checksum: '0'.repeat(64) }, { cleanup: 'manual-required' }, { status: 'failed' }]) {
    await recordBackupTrial(r.file, { ...r.report, ...change }, r.identity);
    assert.equal((await readManifest(r.file)).manifest.verification.restore, 'not-tested');
  }
  await fs.appendFile(r.file, '-- changed');
  const report = await recordBackupTrial(r.file, { ...r.report }, r.identity);
  assert.equal(report.sourceChanged, true);
  assert.equal((await readManifest(r.file)).manifest.verification.restore, 'not-tested');
});

test('a corrupt manifest remains untouched and trial evidence does not claim complete persistence', async t => {
  const r = await fixture(t), text = '{broken-manifest';
  await fs.writeFile(r.file + '.json', text);
  const report = await recordBackupTrial(r.file, r.report, r.identity);
  assert.ok(report.reportSaveError);
  assert.equal(await fs.readFile(r.file + '.json', 'utf8'), text);
  assert.equal(JSON.parse(await fs.readFile(r.file + '.trial.json', 'utf8')).checksum, r.checksum);
});
