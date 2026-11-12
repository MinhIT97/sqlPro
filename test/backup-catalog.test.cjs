'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { backupDirectory, backupName, listBackups, resolveBackup, copyBackup, verifyBackup } = require('../electron/backup-catalog.cjs');
const { saveBackupFile, readManifest } = require('../electron/backup-file.cjs');
const { renameBackup, updateBackupAnnotations, deleteBackup } = require('../electron/backup-catalog.cjs');

test('notes and pin migrate old names, survive concurrent edits and protect deletion', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-annotations-'));
  try {
    const directory = backupDirectory(root, 'conn', 'db');
    await fs.mkdir(directory, { recursive: true });
    const id = backupName();
    const file = path.join(directory, id);
    await saveBackupFile(file, async write => { await write('SELECT 1;'); return { bytes: 9 }; });
    await fs.writeFile(`${file}.name.json`, JSON.stringify({ name: 'Tên cũ' }));
    const originalManifest = await readManifest(file);
    assert.equal((await listBackups(root, 'conn', 'db'))[0].pinned, false);
    await Promise.all([
      updateBackupAnnotations(root, 'conn', 'db', id, { note: 'Trước nâng cấp\nGiữ đến cuối tháng <script>' }),
      updateBackupAnnotations(root, 'conn', 'db', id, { pinned: true }),
      renameBackup(root, 'conn', 'db', id, 'Tên mới')
    ]);
    const [entry] = await listBackups(root, 'conn', 'db');
    assert.equal(entry.name, 'Tên mới');
    assert.equal(entry.note, 'Trước nâng cấp\nGiữ đến cuối tháng <script>');
    assert.equal(entry.pinned, true);
    await assert.rejects(deleteBackup(root, 'conn', 'db', id), { code: 'BACKUP_PINNED' });
    assert.equal(await fs.readFile(file, 'utf8'), 'SELECT 1;');
    assert.deepEqual(await readManifest(file), originalManifest);
    const copied = await copyBackup(root, 'conn', 'other', 'db', 'target', id);
    assert.equal(copied.pinned, true);
    const [copy] = await listBackups(root, 'other', 'target');
    assert.equal(copy.name, entry.name); assert.equal(copy.note, entry.note); assert.equal(copy.pinned, true);
    await assert.rejects(deleteBackup(root, 'other', 'target', copied.id), { code: 'BACKUP_PINNED' });
    await updateBackupAnnotations(root, 'conn', 'db', id, { pinned: false, note: '' });
    await fs.writeFile(`${file}.trial.json`, '{}');
    assert.equal((await deleteBackup(root, 'conn', 'db', id)).deleted, true);
    assert.deepEqual(await fs.readdir(directory), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('invalid metadata fails closed; failed atomic writes retain prior notes and release the edit lock', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-annotation-errors-'));
  const originalRename = fs.rename;
  try {
    const directory = backupDirectory(root, 'conn', 'db');
    await fs.mkdir(directory, { recursive: true });
    const id = backupName();
    const file = path.join(directory, id);
    await fs.writeFile(file, 'SELECT 1;');
    for (const patch of [{ note: 'x'.repeat(2001) }, { note: '\0' }, { note: 7 }, { pinned: 'false' }, { name: '' }, { extra: 1 }, {}, { note: undefined }]) {
      await assert.rejects(updateBackupAnnotations(root, 'conn', 'db', id, patch));
    }
    await updateBackupAnnotations(root, 'conn', 'db', id, { note: 'Giữ nguyên', pinned: true });
    fs.rename = async (source, target) => {
      if (target === `${file}.name.json`) throw Object.assign(new Error('disk full fixture'), { code: 'ENOSPC' });
      return originalRename(source, target);
    };
    await assert.rejects(renameBackup(root, 'conn', 'db', id, 'Thất bại'), { code: 'ENOSPC' });
    fs.rename = originalRename;
    await renameBackup(root, 'conn', 'db', id, 'Thành công');
    assert.equal((await listBackups(root, 'conn', 'db'))[0].note, 'Giữ nguyên');
    assert.equal((await fs.readdir(directory)).some(name => name.endsWith('.part')), false);
    for (const metadata of ['{broken', JSON.stringify({ version: 99 }), JSON.stringify({ pinned: 'true' }), 'x'.repeat(16385)]) {
      await fs.writeFile(`${file}.name.json`, metadata);
      assert.ok((await listBackups(root, 'conn', 'db'))[0].annotationError);
      await assert.rejects(deleteBackup(root, 'conn', 'db', id));
      await assert.rejects(renameBackup(root, 'conn', 'db', id, 'Không ghi đè'));
      await assert.rejects(copyBackup(root, 'conn', 'other', 'db', 'target', id));
      assert.equal(await fs.readFile(`${file}.name.json`, 'utf8'), metadata);
      assert.equal(await fs.readFile(file, 'utf8'), 'SELECT 1;');
    }
  } finally { fs.rename = originalRename; await fs.rm(root, { recursive: true, force: true }); }
});

test('đổi tên backup lưu bền tên tiếng Việt và giữ nội dung, checksum, ID', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-rename-'));
  try {
    const directory = backupDirectory(root, 'conn', 'db');
    await fs.mkdir(directory, { recursive: true });
    for (const legacy of [false, true]) {
      const id = backupName();
      const file = path.join(directory, id);
      if (legacy) await fs.writeFile(file, 'SELECT 1;');
      else await saveBackupFile(file, async (write) => { await write('SELECT 1;'); return { bytes: 9 }; });
      const originalManifest = await readManifest(file);
      await renameBackup(root, 'conn', 'db', id, '  Trước cập nhật tháng 11  ');
      const entry = (await listBackups(root, 'conn', 'db')).find((entry) => entry.id === id);
      assert.equal(entry.name, 'Trước cập nhật tháng 11');
      assert.equal(entry.legacy, legacy);
      assert.equal(await fs.readFile(file, 'utf8'), 'SELECT 1;');
      assert.deepEqual(await readManifest(file), originalManifest);
      for (const name of ['', '   ', 'x'.repeat(121), 'a\nb', null]) {
        await assert.rejects(renameBackup(root, 'conn', 'db', id, name), { code: 'INVALID_BACKUP_NAME' });
      }
      await assert.rejects(renameBackup(root, 'conn', 'db', '../outside.sql', 'test'), /không hợp lệ/);
      await assert.rejects(renameBackup(root, 'other', 'db', id, 'test'), { code: 'ENOENT' });
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('copy does not publish an unpinned backup when metadata or SQL publication fails', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-annotation-copy-failure-'));
  const originalLink = fs.link;
  try {
    const directory = backupDirectory(root, 'conn', 'source');
    await fs.mkdir(directory, { recursive: true });
    const id = backupName();
    await fs.writeFile(path.join(directory, id), 'SELECT 1;');
    await updateBackupAnnotations(root, 'conn', 'source', id, { name: 'Bản quan trọng', note: 'Giữ lại', pinned: true });
    for (const stage of ['metadata', 'sql']) {
      const destination = backupDirectory(root, 'conn', stage);
      fs.link = async (source, target) => {
        if (path.dirname(target) === destination && target.endsWith(stage === 'metadata' ? '.name.json' : '.sql')) throw new Error('publication failed');
        return originalLink(source, target);
      };
      await assert.rejects(copyBackup(root, 'conn', 'conn', 'source', stage, id), /publication failed/);
      assert.deepEqual(await fs.readdir(destination), []);
      assert.deepEqual(await listBackups(root, 'conn', stage), []);
    }
    assert.equal((await listBackups(root, 'conn', 'source'))[0].pinned, true);
  } finally { fs.link = originalLink; await fs.rm(root, { recursive: true, force: true }); }
});

test('copy publication never overwrites a colliding SQL or pin sidecar', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-copy-collision-'));
  const originalLink = fs.link;
  try {
    const source = backupDirectory(root, 'p1', 'source');
    const target = backupDirectory(root, 'p1', 'target');
    await fs.mkdir(source, { recursive: true });
    const id = backupName();
    await fs.writeFile(path.join(source, id), 'SELECT 1;');
    for (const stage of ['metadata', 'sql']) {
      let collision;
      fs.link = async (from, to) => {
        if (to.endsWith(stage === 'metadata' ? '.name.json' : '.sql')) {
          collision = to;
          await fs.writeFile(to, stage === 'metadata' ? '{"pinned":true}' : 'ORIGINAL BACKUP', { flag: 'wx' });
        }
        return originalLink(from, to);
      };
      await assert.rejects(copyBackup(root, 'p1', 'p1', 'source', 'target', id), { code: 'EEXIST' });
      assert.equal(await fs.readFile(collision, 'utf8'), stage === 'metadata' ? '{"pinned":true}' : 'ORIGINAL BACKUP');
      if (stage === 'sql') await assert.rejects(fs.stat(`${collision}.name.json`), { code: 'ENOENT' });
      await fs.rm(target, { recursive: true, force: true });
    }
  } finally { fs.link = originalLink; await fs.rm(root, { recursive: true, force: true }); }
});

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

test('catalog quota is checked before reading per-backup metadata', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-catalog-quota-'));
  const originalRead = fs.readFile;
  let reads = 0;
  try {
    const directory = backupDirectory(root, 'p1', 'db');
    await fs.mkdir(directory, { recursive: true });
    for (let index = 0; index < 3; index++) await fs.writeFile(path.join(directory, backupName()), 'SELECT 1;');
    fs.readFile = (...args) => { reads++; return originalRead(...args); };
    await assert.rejects(listBackups(root, 'p1', 'db', { maxEntries: 2 }), /vượt giới hạn 2/);
    assert.equal(reads, 0);
  } finally { fs.readFile = originalRead; await fs.rm(root, { recursive: true, force: true }); }
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
