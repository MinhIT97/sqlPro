'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { BackupRetentionApply } = require('../electron/backup-retention-apply.cjs');
const { backupDirectory, listBackups, updateBackupAnnotations } = require('../electron/backup-catalog.cjs');
const { saveBackupFile } = require('../electron/backup-file.cjs');

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-retention-apply-'));
  const directory = backupDirectory(root, 'p1', 'db');
  await fs.mkdir(directory, { recursive: true });
  const ids = ['20260101000000-aaaaaaaa.sql', '20260201000000-bbbbbbbb.sql', '20260301000000-cccccccc.sql'];
  for (const [index, id] of ids.entries()) {
    await saveBackupFile(path.join(directory, id), async write => { await write(`SELECT ${index};`); return { bytes: 9 }; });
  }
  let now = Date.parse('2026-11-12T12:00:00Z');
  const service = new BackupRetentionApply({ root, now: () => now });
  return { root, directory, ids, service, advance: ms => { now += ms; }, close: () => fs.rm(root, { recursive: true, force: true }) };
}

test('retention applies exactly the preview once, preserves anchor and removes sidecars', async () => {
  const r = await fixture();
  try {
    const preview = await r.service.preview('p1', 'db', { maxCount: 1 });
    assert.equal(preview.removeCount, 2);
    const anchor = preview.rows.find(row => row.action === 'keep').id;
    const entry = r.service.consume('p1', 'db', preview.token);
    assert.throws(() => r.service.consume('p1', 'db', preview.token));
    const result = await r.service.apply(entry);
    assert.equal(result.deleted.length, 2); assert.deepEqual(result.failed, []);
    assert.equal(result.reclaimedBytes, 18);
    assert.deepEqual((await listBackups(r.root, 'p1', 'db')).map(row => row.id), [anchor]);
    assert.deepEqual((await fs.readdir(r.directory)).sort(), [anchor, `${anchor}.json`].sort());
  } finally { await r.close(); }
});

test('preview rejects concurrent scans and releases admission after completion', async () => {
  const r = await fixture();
  try {
    const pending = r.service.preview('p1', 'db', { maxCount: 1 });
    await assert.rejects(() => r.service.preview('p1', 'db', { maxCount: 1 }), { code: 'SESSION_BUSY' });
    await pending;
    assert.ok((await r.service.preview('p1', 'db', { maxCount: 1 })).token);
  } finally { await r.close(); }
});

test('changed pin, SQL, sidecar or new backup invalidates the entire plan before any deletion', async () => {
  for (const change of ['pin', 'sql', 'manifest', 'addition']) {
    const r = await fixture();
    try {
      const preview = await r.service.preview('p1', 'db', { maxCount: 1 });
      const candidate = preview.rows.find(row => row.action === 'remove').id;
      if (change === 'pin') await updateBackupAnnotations(r.root, 'p1', 'db', candidate, { pinned: true });
      if (change === 'sql') await fs.appendFile(path.join(r.directory, candidate), '-- changed');
      if (change === 'manifest') await fs.appendFile(path.join(r.directory, `${candidate}.json`), ' ');
      if (change === 'addition') await fs.writeFile(path.join(r.directory, '20260401000000-dddddddd.sql'), 'SELECT 4;');
      const entry = r.service.consume('p1', 'db', preview.token);
      await assert.rejects(() => r.service.apply(entry), { code: 'BACKUP_RETENTION_CHANGED' });
      assert.ok((await listBackups(r.root, 'p1', 'db')).length >= 3);
    } finally { await r.close(); }
  }
});

test('tokens are scoped, expire and bounded; protected backups are never candidates', async () => {
  const r = await fixture();
  try {
    const preview = await r.service.preview('p1', 'db', { maxCount: 1 });
    assert.throws(() => r.service.consume('p2', 'db', preview.token));
    assert.throws(() => r.service.consume('p1', 'other', preview.token));
    r.advance(120001);
    assert.throws(() => r.service.consume('p1', 'db', preview.token), /hết hạn/);
    for (const id of r.ids) await updateBackupAnnotations(r.root, 'p1', 'db', id, { pinned: true });
    const pinned = await r.service.preview('p1', 'db', { maxCount: 1 });
    assert.equal(pinned.token, undefined);
    assert.equal(pinned.removeCount, 0);
  } finally { await r.close(); }
});

test('a deletion error stops the rest and reports confirmed partial completion', async () => {
  const r = await fixture();
  const originalUnlink = fs.unlink;
  try {
    const preview = await r.service.preview('p1', 'db', { maxCount: 1 });
    let count = 0;
    fs.unlink = async file => { if (++count === 2) throw Object.assign(new Error('permission fixture'), { code: 'EACCES' }); return originalUnlink(file); };
    const result = await r.service.apply(r.service.consume('p1', 'db', preview.token));
    assert.equal(result.deleted.length, 1);
    assert.equal(result.failed[0].code, 'EACCES');
    assert.equal(result.failed[0].sqlDeleted, false);
    assert.equal(result.remaining.length, 1);
    assert.equal((await listBackups(r.root, 'p1', 'db')).length, 2);
  } finally { fs.unlink = originalUnlink; await r.close(); }
});

test('retention rehashes the protected anchor and refuses a dishonest verified manifest', async () => {
  const r = await fixture();
  try {
    for (const id of r.ids) {
      const file = path.join(r.directory, `${id}.json`);
      const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
      manifest.checksum.value = '0'.repeat(64);
      await fs.writeFile(file, JSON.stringify(manifest));
    }
    const preview = await r.service.preview('p1', 'db', { maxCount: 1 });
    await assert.rejects(() => r.service.apply(r.service.consume('p1', 'db', preview.token)), /không khớp checksum/);
    assert.equal((await listBackups(r.root, 'p1', 'db')).length, 3);
  } finally { await r.close(); }
});

test('metadata cleanup errors report SQL already deleted and stop subsequent files', async () => {
  const r = await fixture();
  const originalRm = fs.rm;
  try {
    const preview = await r.service.preview('p1', 'db', { maxCount: 1 });
    fs.rm = async (file, options) => { if (file.endsWith('.sql.json')) throw Object.assign(new Error('metadata locked'), { code: 'EACCES' }); return originalRm(file, options); };
    const result = await r.service.apply(r.service.consume('p1', 'db', preview.token));
    assert.equal(result.deleted.length, 1);
    assert.equal(result.failed[0].sqlDeleted, true);
    assert.equal(result.remaining.length, 1);
  } finally { fs.rm = originalRm; await r.close(); }
});

test('cancellation between files stops after confirmed deletions and preview response cannot change the plan', async () => {
  const r = await fixture();
  const originalUnlink = fs.unlink;
  let canceled = false;
  try {
    const preview = await r.service.preview('p1', 'db', { maxCount: 1 });
    preview.rows.forEach(row => { row.action = 'remove'; });
    fs.unlink = async file => { await originalUnlink(file); canceled = true; };
    const result = await r.service.apply(r.service.consume('p1', 'db', preview.token), { isCanceled: () => canceled });
    assert.equal(result.deleted.length, 1);
    assert.equal(result.failed[0].code, 'BACKUP_RETENTION_CANCELLED');
    assert.equal(result.remaining.length, 1);
    assert.equal((await listBackups(r.root, 'p1', 'db')).length, 2);
  } finally { fs.unlink = originalUnlink; await r.close(); }
});

test('abort interrupts the anchor hash with progress and deletes no candidate', async () => {
  const r = await fixture();
  try {
    const anchor = r.ids.at(-1);
    await saveBackupFile(path.join(r.directory, anchor), async write => {
      const text = `-- ${'x'.repeat(4 * 1024 * 1024)}`;
      await write(text); return { bytes: Buffer.byteLength(text) };
    });
    const preview = await r.service.preview('p1', 'db', { maxCount: 1 });
    const controller = new AbortController();
    const updates = [];
    const result = await r.service.apply(r.service.consume('p1', 'db', preview.token), {
      signal: controller.signal, onProgress: update => {
        updates.push(update);
        if (update.phase === 'hashing' && update.bytesRead > 0) controller.abort();
      }
    });
    assert.equal(result.stopped, true);
    assert.equal(result.deleted.length, 0);
    assert.equal(result.remaining.length, 2);
    assert.equal(updates.at(-1).phase, 'stopped');
    const hashed = updates.find(update => update.phase === 'hashing' && update.bytesRead > 0);
    assert.ok(hashed.bytesRead < hashed.totalBytes);
    assert.equal((await listBackups(r.root, 'p1', 'db')).length, 3);
  } finally { await r.close(); }
});
