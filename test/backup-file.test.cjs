'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { saveBackupFile } = require('../electron/backup-file.cjs');

test('ghi đầy đủ backup vào đường dẫn đã chọn và xóa file tạm', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-backup-'));
  const target = path.join(folder, 'sample.sql');
  try {
    const stats = await saveBackupFile(target, async (write) => {
      await write('CREATE TABLE t (id int);\n');
      await write('INSERT INTO t VALUES (1);\n');
      return { bytes: Buffer.byteLength('CREATE TABLE t (id int);\nINSERT INTO t VALUES (1);\n') };
    });
    assert.equal((await fs.stat(target)).size, stats.bytes);
    assert.equal((await fs.readdir(folder)).length, 1);
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
