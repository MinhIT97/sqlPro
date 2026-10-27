'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { backupDirectory, backupName, listBackups, resolveBackup, copyBackup, verifyBackup } = require('../electron/backup-catalog.cjs');
const { saveBackupFile, readManifest } = require('../electron/backup-file.cjs');

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

test('backup cũ không có manifest được nhận diện là chưa có checksum', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-catalog-legacy-'));
  try {
    const directory = backupDirectory(root, 'conn', 'database');
    await fs.mkdir(directory, { recursive: true });
    const id = backupName();
    await fs.writeFile(path.join(directory, id), 'SELECT 1;');
    const [entry] = await listBackups(root, 'conn', 'database');
    assert.equal(entry.legacy, true);
    assert.equal(entry.checksum, null);
    assert.equal(entry.verification.checksum, 'missing');
    const verified = await verifyBackup(root, 'conn', 'database', id);
    assert.equal(verified.legacy, true);
    assert.equal(verified.match, null);
    assert.equal(verified.verification.checksum, 'missing');
    assert.equal(verified.checksum, crypto.createHash('sha256').update('SELECT 1;').digest('hex'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('copyBackup xác minh checksum nguồn/đích và ghi manifest cho bản sao', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-catalog-checksum-'));
  try {
    const directory = backupDirectory(root, 'conn', 'source');
    await fs.mkdir(directory, { recursive: true });
    const id = backupName();
    const content = 'CREATE TABLE sample (id int);\n';
    const source = await saveBackupFile(path.join(directory, id), async (write) => {
      await write(content);
      return { bytes: Buffer.byteLength(content) };
    }, { source: { database: 'source' } });
    const verified = await verifyBackup(root, 'conn', 'source', id);
    assert.equal(verified.match, true);

    const copied = await copyBackup(root, 'conn', 'conn', 'source', 'target', id);
    assert.equal(copied.checksum, source.checksum);
    assert.equal(copied.verification.checksum, 'verified');
    const copiedManifest = await readManifest(copied.filePath);
    assert.equal(copiedManifest.error, null);
    assert.equal(copiedManifest.manifest.checksum.value, source.checksum);
    assert.equal(copiedManifest.manifest.copiedFrom.id, id);
    assert.equal(copiedManifest.manifest.source.database, 'source');

    await fs.appendFile(path.join(directory, id), '-- tampered\n');
    const sourceAfter = await verifyBackup(root, 'conn', 'source', id);
    assert.equal(sourceAfter.match, false);
    assert.equal(sourceAfter.verification.checksum, 'mismatch');
    assert.equal((await listBackups(root, 'conn', 'source'))[0].verification.checksum, 'mismatch');
    // A subsequent edit invalidates the last result, even if the byte length stays the same.
    await fs.writeFile(path.join(directory, id), content.replace('sample', 'edited'));
    assert.equal((await listBackups(root, 'conn', 'source'))[0].verification.checksum, 'unverified');
    await assert.rejects(
      copyBackup(root, 'conn', 'conn', 'source', 'target-2', id),
      (error) => error.code === 'BACKUP_CHECKSUM_MISMATCH'
    );
    assert.deepEqual(await listBackups(root, 'conn', 'target-2'), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('checksum thành công được giữ qua refresh nhưng vô hiệu hóa khi tệp đổi cùng kích thước', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-catalog-refresh-'));
  try {
    const directory = backupDirectory(root, 'conn', 'db');
    await fs.mkdir(directory, { recursive: true });
    const id = backupName();
    const filePath = path.join(directory, id);
    await saveBackupFile(filePath, async (write) => { await write('SELECT 1;'); return { bytes: 9 }; });
    assert.equal((await listBackups(root, 'conn', 'db'))[0].verification.checksum, 'verified');
    assert.equal((await verifyBackup(root, 'conn', 'db', id)).match, true);
    await fs.writeFile(filePath, 'SELECT 2;');
    await fs.utimes(filePath, new Date(0), new Date(0));
    assert.equal((await listBackups(root, 'conn', 'db'))[0].verification.checksum, 'unverified');
    assert.equal((await verifyBackup(root, 'conn', 'db', id)).match, false);
    assert.equal((await listBackups(root, 'conn', 'db'))[0].verification.checksum, 'mismatch');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('copyBackup dọn bản sao chưa hoàn tất và không công bố nó trong catalog', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-catalog-partial-'));
  const sourceDir = backupDirectory(root, 'source', 'database');
  const targetDir = backupDirectory(root, 'target', 'database');
  const id = backupName();
  const originalCopyFile = fs.copyFile;
  try {
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, id), 'CREATE TABLE example (id int);');
    fs.copyFile = async (_source, destination) => {
      await fs.writeFile(destination, 'incomplete');
      throw new Error('copy interrupted');
    };
    await assert.rejects(copyBackup(root, 'source', 'target', 'database', 'database', id), /copy interrupted/);
    assert.deepEqual(await listBackups(root, 'target', 'database'), []);
    assert.deepEqual(await fs.readdir(targetDir), []);
  } finally {
    fs.copyFile = originalCopyFile;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('resolveBackup từ chối symbolic link thay cho tệp sao lưu', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-catalog-link-'));
  try {
    const directory = backupDirectory(root, 'source', 'database');
    await fs.mkdir(directory, { recursive: true });
    const external = path.join(root, 'external.sql');
    await fs.writeFile(external, 'SELECT 1;');
    const id = backupName();
    try {
      await fs.symlink(external, path.join(directory, id));
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'ENOTSUP') {
        t.skip('Hệ thống tệp không hỗ trợ symbolic link.');
        return;
      }
      throw error;
    }
    await assert.rejects(resolveBackup(root, 'source', 'database', id), /Không tìm thấy tệp sao lưu/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
