'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSession } = require('../electron/database.cjs');

test('restore khôi phục FOREIGN_KEY_CHECKS và SQL_MODE khi một lệnh bị lỗi', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-restore-'));
  const filePath = path.join(folder, 'backup.sql');
  await fs.writeFile(filePath, "SET SQL_MODE='NO_AUTO_VALUE_ON_ZERO';\nCREATE TABLE `items` (`id` int);\n");
  const session = new DatabaseSession({});
  session.connection = {};
  session.metadata = new Map();
  const calls = [];
  session.raw = async (sql, params) => {
    calls.push([sql, params]);
    if (sql.startsWith('SELECT @@FOREIGN_KEY_CHECKS')) {
      return { rows: [{ foreignKeys: 1, sqlMode: 'STRICT_TRANS_TABLES' }] };
    }
    if (sql.startsWith('CREATE TABLE')) throw new Error('table already exists');
    return { rows: [] };
  };
  session.useDatabase = async () => {};
  try {
    await assert.rejects(
      session.restoreDatabase({ database: 'sample', filePath }),
      /Lỗi ở câu lệnh #2: table already exists/
    );
    assert.ok(calls.some(([sql]) => sql === 'SET FOREIGN_KEY_CHECKS=1'));
    assert.ok(calls.some(([sql, params]) => sql === 'SET SESSION SQL_MODE=?'
      && params[0] === 'STRICT_TRANS_TABLES'));
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test('restore tự động tạo database đích khi createDatabaseIfNotExists = true', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-restore-create-'));
  const filePath = path.join(folder, 'backup.sql');
  await fs.writeFile(filePath, 'SELECT 1;\n');
  const session = new DatabaseSession({});
  session.connection = {};
  session.metadata = new Map();
  const calls = [];
  session.raw = async (sql, params) => {
    calls.push([sql, params]);
    if (sql.startsWith('SELECT @@FOREIGN_KEY_CHECKS')) {
      return { rows: [{ foreignKeys: 1, sqlMode: '' }] };
    }
    return { rows: [] };
  };
  session.useDatabase = async () => {};
  try {
    const stats = await session.restoreDatabase({
      database: 'new_target_db',
      filePath,
      createDatabaseIfNotExists: true
    });
    assert.equal(stats.database, 'new_target_db');
    assert.ok(calls.some(([sql]) => sql.includes('CREATE DATABASE IF NOT EXISTS `new_target_db`')));
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test('dropExisting xóa đúng loại bảng, view, trigger, routine, function và event', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-restore-drops-'));
  const filePath = path.join(folder, 'backup.sql');
  await fs.writeFile(filePath, [
    'DELIMITER $$',
    'CREATE PROCEDURE `p_one`() BEGIN SELECT 1; END$$',
    'CREATE FUNCTION `f_one`() RETURNS int RETURN 1$$',
    'CREATE EVENT `e_one` ON SCHEDULE EVERY 1 DAY DO SELECT 1$$',
    'DELIMITER ;',
    'CREATE TABLE `t_one` (`id` int);',
    'CREATE VIEW `v_one` AS SELECT 1;',
    'CREATE TRIGGER `tr_one` BEFORE INSERT ON `t_one` FOR EACH ROW SET @x = 1;',
    ''
  ].join('\n'));
  const session = new DatabaseSession({});
  session.connection = {};
  session.metadata = new Map();
  const drops = [];
  session.raw = async (sql) => {
    if (/^DROP /.test(sql)) drops.push(sql);
    if (sql.startsWith('SELECT @@FOREIGN_KEY_CHECKS')) {
      return { rows: [{ foreignKeys: 1, sqlMode: '' }] };
    }
    return { rows: [] };
  };
  session.useDatabase = async () => {};
  try {
    await session.restoreDatabase({ database: 'sample', filePath, dropExisting: true });
    assert.deepEqual(drops, [
      'DROP PROCEDURE IF EXISTS `p_one`',
      'DROP FUNCTION IF EXISTS `f_one`',
      'DROP EVENT IF EXISTS `e_one`',
      'DROP TABLE IF EXISTS `t_one`',
      'DROP VIEW IF EXISTS `v_one`',
      'DROP TRIGGER IF EXISTS `tr_one`'
    ]);
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test('hủy restore trả RESTORE_CANCELED kèm số câu đã chạy', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-restore-cancel-'));
  const filePath = path.join(folder, 'backup.sql');
  await fs.writeFile(filePath, 'SELECT 1;\nSELECT 2;\nSELECT 3;\n');
  const session = new DatabaseSession({});
  session.connection = { destroy() {} };
  session.metadata = new Map();
  let executedStatements = 0;
  session.raw = async (sql) => {
    if (sql.startsWith('SELECT @@FOREIGN_KEY_CHECKS')) {
      return { rows: [{ foreignKeys: 1, sqlMode: '' }] };
    }
    if (/^SELECT \d/.test(sql)) {
      executedStatements += 1;
      if (executedStatements === 1) session.cancelTask();
    }
    return { rows: [] };
  };
  session.useDatabase = async () => {};
  try {
    await assert.rejects(
      session.restoreDatabase({ database: 'sample', filePath }),
      (error) => {
        assert.equal(error.code, 'RESTORE_CANCELED');
        assert.equal(error.partial.executed, 1);
        return true;
      }
    );
    assert.equal(session.activeTask, null);
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});
