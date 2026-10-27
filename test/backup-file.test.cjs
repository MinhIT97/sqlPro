'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { saveBackupFile, manifestPathFor, readManifest } = require('../electron/backup-file.cjs');

test('ghi đầy đủ backup, checksum và manifest bên cạnh tệp SQL', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-backup-'));
  const target = path.join(folder, 'sample.sql');
  const content = 'CREATE TABLE t (id int);\nINSERT INTO t VALUES (1);\n';
  try {
    const stats = await saveBackupFile(target, async (write) => {
      await write('CREATE TABLE t (id int);\n');
      await write('INSERT INTO t VALUES (1);\n');
      return { bytes: Buffer.byteLength(content), rows: 1, objects: 1 };
    }, {
      source: { database: 'sample', serverVersion: '8.4.0' },
      selection: { tables: ['t'] }
    });
    assert.equal((await fs.stat(target)).size, stats.bytes);
    assert.equal(stats.checksum, crypto.createHash('sha256').update(content).digest('hex'));
    assert.deepEqual(stats.verification, { fileWritten: true, checksum: 'verified', restore: 'not-tested' });
    assert.deepEqual((await fs.readdir(folder)).sort(), ['sample.sql', 'sample.sql.json']);
    assert.equal(await fs.readFile(manifestPathFor(target), 'utf8').then((text) => JSON.parse(text).checksum.value), stats.checksum);
    const { manifest, error } = await readManifest(target);
    assert.equal(error, null);
    assert.equal(manifest.source.database, 'sample');
    assert.equal(manifest.selection.tables[0], 't');
    assert.equal(manifest.verification.restore, 'not-tested');
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test('không ghi manifest khi tắt tùy chọn manifest', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-backup-'));
  const target = path.join(folder, 'export.csv');
  try {
    const stats = await saveBackupFile(target, async (write) => {
      await write('id\n1\n');
      return { bytes: 5 };
    }, { manifest: false });
    assert.equal(stats.manifestPath, undefined);
    assert.deepEqual(await fs.readdir(folder), ['export.csv']);
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test('giữ file cũ khi backup mới bị lỗi', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-backup-'));
  const target = path.join(folder, 'sample.sql');
  try {
    await fs.writeFile(target, 'old backup');
    await assert.rejects(saveBackupFile(target, async (write) => {
      await write('partial');
      throw new Error('database disconnected');
    }), /database disconnected/);
    assert.equal(await fs.readFile(target, 'utf8'), 'old backup');
    assert.deepEqual(await fs.readdir(folder), ['sample.sql']);
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});
