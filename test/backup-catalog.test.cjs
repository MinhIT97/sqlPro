'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { backupDirectory, backupName, listBackups, resolveBackup, copyBackup } = require('../electron/backup-catalog.cjs');

test('backup được liệt kê riêng theo kết nối và database', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-catalog-'));
  try {
    const directory = backupDirectory(root, 'conn-a', 'database-a');
    await fs.mkdir(directory, { recursive: true });
    const id = backupName();
    await fs.writeFile(path.join(directory, id), 'SELECT 1;');
    await fs.writeFile(path.join(directory, 'unfinished.part'), 'partial');
    assert.equal((await listBackups(root, 'conn-a', 'database-a')).length, 1);
    assert.deepEqual(await listBackups(root, 'conn-b', 'database-a'), []);
    assert.deepEqual(await listBackups(root, 'conn-a', 'database-b'), []);
    assert.equal(await resolveBackup(root, 'conn-a', 'database-a', id), path.join(directory, id));
    await assert.rejects(resolveBackup(root, 'conn-a', 'database-a', '../outside.sql'), /không hợp lệ/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('copyBackup sao chép bản sao lưu sang database khác', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-catalog-copy-'));
  try {
    const dirA = backupDirectory(root, 'conn-1', 'db-source');
    await fs.mkdir(dirA, { recursive: true });
    const id = backupName();
    await fs.writeFile(path.join(dirA, id), 'CREATE TABLE sample (id int);');

    const copied = await copyBackup(root, 'conn-1', 'db-source', 'db-target', id);
    assert.ok(copied.id);
    assert.notEqual(copied.id, id);
    assert.equal(copied.bytes, (await fs.stat(path.join(dirA, id))).size);

    const listTarget = await listBackups(root, 'conn-1', 'db-target');
    assert.equal(listTarget.length, 1);
    assert.equal(listTarget[0].id, copied.id);

    const targetContent = await fs.readFile(copied.filePath, 'utf8');
    assert.equal(targetContent, 'CREATE TABLE sample (id int);');

    // Test cross-connection copy: conn-source -> conn-dest
    const crossCopied = await copyBackup(root, 'conn-1', 'conn-2', 'db-source', 'db-cross', id);
    assert.ok(crossCopied.id);
    const listCross = await listBackups(root, 'conn-2', 'db-cross');
    assert.equal(listCross.length, 1);
    assert.equal(listCross[0].id, crossCopied.id);
    assert.deepEqual(await listBackups(root, 'conn-1', 'db-cross'), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
