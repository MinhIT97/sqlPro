'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { saveBackupFile } = require('../electron/backup-file.cjs');
const { backupDirectory, listBackups, updateBackupAnnotations } = require('../electron/backup-catalog.cjs');
const { BackupRetentionApply } = require('../electron/backup-retention-apply.cjs');
const { createRetentionHistory } = require('../electron/backup-retention-history.cjs');
const { runAutomaticRetention } = require('../electron/backup-retention-auto.cjs');

const ids = ['20260101000000-aaaaaaaa.sql', '20260201000000-bbbbbbbb.sql', '20260301000000-cccccccc.sql'];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-retention-auto-'));
  const directory = backupDirectory(root, 'p1', 'db');
  await fs.mkdir(directory, { recursive: true });
  let stats;
  for (let index = 0; index < ids.length; index++) {
    const file = path.join(directory, ids[index]);
    stats = await saveBackupFile(file, async write => { await write('SELECT 1;'); return { bytes: 9, tables: 1 }; },
      { source: { profileId: 'p1', database: 'db', target: 'a'.repeat(64) }, selection: { tables: ['items'] } });
    const manifest = JSON.parse(await fs.readFile(`${file}.json`, 'utf8'));
    manifest.createdAt = new Date(Date.UTC(2026, index, 1)).toISOString();
    await fs.writeFile(`${file}.json`, JSON.stringify(manifest));
  }
  const options = { root, profileId: 'p1', database: 'db', backupId: ids[2], stats,
    settings: { policy: { maxCount: 1 }, automaticAfterBackup: true }, service: new BackupRetentionApply({ root }) };
  return { root, directory, options, close: () => fs.rm(root, { recursive: true, force: true }) };
}

test('automatic cleanup runs only after verified backup, preserves new anchor and records its trigger', async () => {
  const r = await fixture();
  try {
    const result = await runAutomaticRetention(r.options);
    assert.equal(result.status, 'completed');
    assert.equal(result.deleted.length, 2);
    assert.deepEqual((await listBackups(r.root, 'p1', 'db')).map(row => row.id), [ids[2]]);
    const [history] = createRetentionHistory(r.root).read('p1', 'db');
    assert.equal(history.mode, 'automatic'); assert.equal(history.triggerBackupId, ids[2]);
    assert.equal(history.state, 'completed');
  } finally { await r.close(); }
});

test('missing/failed manifest, disabled setting or cancellation never deletes old backups', async () => {
  const r = await fixture();
  try {
    for (const overrides of [{ settings: { automaticAfterBackup: false } }, { stats: { ...r.options.stats, manifestError: 'disk full' } },
      { stats: { ...r.options.stats, verification: { checksum: 'mismatch' } } }, { isCanceled: () => true }]) {
      const result = await runAutomaticRetention({ ...r.options, ...overrides });
      assert.ok(['disabled', 'skipped', 'stopped'].includes(result.status));
      assert.equal((await listBackups(r.root, 'p1', 'db')).length, 3);
    }
    assert.deepEqual(createRetentionHistory(r.root).read('p1', 'db'), []);
  } finally { await r.close(); }
});

test('partial scope, foreign source, unknown metadata and pinned backups are protected', async () => {
  for (const variant of ['scope', 'source', 'target', 'legacy-target', 'missing', 'pin', 'empty-list', 'counts', 'routine-kind']) {
    const r = await fixture();
    try {
      const file = path.join(r.directory, `${ids[0]}.json`);
      const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
      if (variant === 'scope') manifest.selection.tables = ['items', 'other'];
      if (variant === 'source') manifest.source.profileId = 'other-profile';
      if (variant === 'target') manifest.source.target = 'b'.repeat(64);
      if (variant === 'legacy-target') delete manifest.source.target;
      if (variant === 'missing') delete manifest.selection;
      if (variant === 'pin') await updateBackupAnnotations(r.root, 'p1', 'db', ids[0], { pinned: true });
      if (variant === 'empty-list') manifest.selection.tables = [];
      if (variant === 'counts') manifest.result.views = 1;
      if (variant === 'routine-kind') { manifest.selection.routines = ['procedure:r']; manifest.result.functions = 1; }
      await fs.writeFile(file, JSON.stringify(manifest));
      const result = await runAutomaticRetention(r.options);
      assert.equal(result.status, 'completed');
      assert.deepEqual(result.deleted, [ids[1]]);
      const remaining = (await listBackups(r.root, 'p1', 'db')).map(row => row.id);
      assert.ok(remaining.includes(ids[0])); assert.ok(remaining.includes(ids[2]));
    } finally { await r.close(); }
  }
});

test('unknown source or incomplete object inventory in new backup never authorizes automatic deletion', async () => {
  for (const variant of ['target', 'inventory']) {
    const r = await fixture();
    try {
      const file = path.join(r.directory, `${ids[2]}.json`);
      const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
      if (variant === 'target') delete manifest.source.target;
      else manifest.selection.tables = [];
      await fs.writeFile(file, JSON.stringify(manifest));
      const result = await runAutomaticRetention(r.options);
      assert.equal(result.status, 'failed');
      assert.equal((await listBackups(r.root, 'p1', 'db')).length, 3);
    } finally { await r.close(); }
  }
});

test('context change before apply and history publication failure stop without deleting', async () => {
  const r = await fixture();
  try {
    let checks = 0;
    const result = await runAutomaticRetention({ ...r.options, checkContext: () => { if (++checks > 1) throw new Error('policy changed'); } });
    assert.equal(result.status, 'failed'); assert.match(result.reason, /policy changed/);
    const history = path.join(r.directory, 'retention-history.json');
    await fs.writeFile(history, '{broken');
    const failed = await runAutomaticRetention(r.options);
    assert.equal(failed.status, 'failed');
    assert.equal((await listBackups(r.root, 'p1', 'db')).length, 3);
    assert.equal(await fs.readFile(history, 'utf8'), '{broken');
  } finally { await r.close(); }
});

test('a policy change after first deletion stops the rest and retains the confirmed partial report', async () => {
  const r = await fixture();
  let changed = false;
  try {
    const result = await runAutomaticRetention({ ...r.options,
      onProgress: update => { if (update.phase === 'deleting') changed = true; },
      checkContext: () => { if (changed) throw new Error('policy changed after first delete'); }
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.deleted.length, 1); assert.equal(result.remaining.length, 1);
    const [history] = createRetentionHistory(r.root).read('p1', 'db');
    assert.equal(history.state, 'failed'); assert.equal(history.deleted.length, 1);
    assert.equal((await listBackups(r.root, 'p1', 'db')).length, 2);
  } finally { await r.close(); }
});
