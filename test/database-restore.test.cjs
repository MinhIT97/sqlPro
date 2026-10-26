'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSession } = require('../electron/database.cjs');

test('quét tệp restore lớn trong worker để tiến trình chính vẫn phản hồi', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-restore-yield-'));
  const filePath = path.join(folder, 'large.sql');
  const statement = `INSERT INTO items VALUES ('${'x'.repeat(16000)}');\n`;
  await fs.writeFile(filePath, statement.repeat(256));
  const session = new DatabaseSession({});
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 5);
  try {
    const result = await session.scanRestoreInventoryInWorker({
      filePath,
      database: 'sample',
      totalBytes: (await fs.stat(filePath)).size,
      dropExisting: false
    });
    assert.equal(result.inventory.statements, 256);
    assert.equal(result.inventory.tables instanceof Map, true);
    assert.ok(ticks > 0);
  } finally {
    clearInterval(timer);
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test('có thể hủy worker đang quét restore', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-restore-worker-cancel-'));
  const filePath = path.join(folder, 'large.sql');
  await fs.writeFile(filePath, `INSERT INTO items VALUES ('${'x'.repeat(16000)}');\n`.repeat(256));
  const session = new DatabaseSession({});
  const task = { canceled: false };
  try {
    await assert.rejects(session.scanRestoreInventoryInWorker({
      filePath,
      database: 'sample',
      totalBytes: (await fs.stat(filePath)).size,
      dropExisting: false,
      task,
      onProgress: () => {
        task.canceled = true;
        Atomics.store(task.scanCancelFlag, 0, 1);
      }
    }), { code: 'RESTORE_CANCELED' });
    assert.equal(task.scanCancelFlag, null);
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test('restore không ghi vào database nếu tệp SQL đổi sau khi quét', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-restore-changed-'));
  const filePath = path.join(folder, 'backup.sql');
  await fs.writeFile(filePath, 'CREATE TABLE `items` (`id` int);\n');
  const session = new DatabaseSession({});
  session.connection = {};
  const queries = [];
  session.raw = async (sql) => { queries.push(sql); return { rows: [] }; };
  session.scanRestoreInventoryInWorker = async () => {
    await fs.writeFile(filePath, 'CREATE TABLE `items` (`id` int, `name` text);\n');
    return { inventory: { tables: new Map(), warnings: [] } };
  };
  try {
    await assert.rejects(session.restoreDatabase({
      database: 'sample',
      filePath,
      createDatabaseIfNotExists: true
    }), { code: 'RESTORE_FILE_CHANGED' });
    assert.deepEqual(queries, []);
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test('restore đọc đúng tệp đã kiểm tra nếu đường dẫn bị thay sau khi mở', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows có thể khóa tệp đang mở, không thể mô phỏng thay thế đường dẫn.');
    return;
  }
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-restore-replaced-'));
  const filePath = path.join(folder, 'backup.sql');
  const replacementPath = path.join(folder, 'replacement.sql');
  await fs.writeFile(filePath, 'CREATE TABLE `original` (`id` int);\n');
  await fs.writeFile(replacementPath, 'CREATE TABLE `replacement` (`id` int);\n');
  const session = new DatabaseSession({});
  session.connection = {};
  session.metadata = new Map();
  session.scanRestoreInventoryInWorker = async () => ({ inventory: {
    tables: new Map(), warnings: [], rowCountsReliable: true
  } });
  const queries = [];
  session.raw = async (sql) => {
    queries.push(sql);
    if (sql.startsWith('SELECT @@FOREIGN_KEY_CHECKS')) {
      await fs.rename(replacementPath, filePath);
      return { rows: [{ foreignKeys: 1, sqlMode: '' }] };
    }
    return { rows: [] };
  };
  session.useDatabase = async () => {};
  session.verifyRestore = async () => ({ status: 'verified' });
  try {
    await session.restoreDatabase({ database: 'sample', filePath });
    assert.ok(queries.some((sql) => sql.includes('CREATE TABLE `original`')));
    assert.equal(queries.some((sql) => sql.includes('CREATE TABLE `replacement`')), false);
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test('restore báo bảng đang kiểm tra và đang thực thi để ghi nhật ký', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-restore-log-'));
  const filePath = path.join(folder, 'backup.sql');
  await fs.writeFile(filePath, 'CREATE TABLE `items` (`id` int);\nINSERT INTO `items` VALUES (1);\n');
  const session = new DatabaseSession({});
  session.connection = {};
  session.metadata = new Map();
  session.raw = async (sql) => sql.startsWith('SELECT @@FOREIGN_KEY_CHECKS')
    ? { rows: [{ foreignKeys: 1, sqlMode: '' }] } : { rows: [] };
  session.useDatabase = async () => {};
  session.verifyRestore = async () => ({ status: 'verified' });
  const progress = [];
  try {
    await session.restoreDatabase({ database: 'sample', filePath }, (entry) => progress.push(entry));
    assert.ok(progress.some((entry) => entry.phase === 'scan'
      && entry.events.some((event) => event.objectName === 'items')));
    assert.ok(progress.some((entry) => entry.phase === 'execute'
      && entry.events.some((event) => event.command === 'INSERT' && event.objectName === 'items')));
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});

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

test('restore chặn ghi ngoài database đích trước khi chạy bất kỳ câu lệnh nào', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-restore-scope-'));
  const filePath = path.join(folder, 'backup.sql');
  await fs.writeFile(filePath, [
    'CREATE TABLE `items` (`id` int);',
    'INSERT INTO `other_db`.`items` VALUES (1);',
    ''
  ].join('\n'));
  const session = new DatabaseSession({});
  session.connection = {};
  session.metadata = new Map();
  const calls = [];
  let usedDatabase = null;
  session.raw = async (sql) => { calls.push(sql); return { rows: [] }; };
  session.useDatabase = async (database) => { usedDatabase = database; };
  try {
    await assert.rejects(
      session.restoreDatabase({ database: 'target_db', filePath, createDatabaseIfNotExists: true }),
      (error) => {
        assert.equal(error.code, 'RESTORE_SCOPE_REJECTED');
        assert.equal(error.schema, 'other_db');
        assert.equal(error.table, 'items');
        assert.equal(error.statementNumber, 2);
        return true;
      }
    );
    assert.deepEqual(calls, []);
    assert.equal(usedDatabase, null);
    assert.equal(session.activeTask, null);
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});

function restoreInventory({ tables = {}, warnings = [], reliable = true, limitations = [] } = {}) {
  return {
    tables: new Map(Object.entries(tables).map(([name, entry]) => [name.toLowerCase(), {
      name,
      expectedRows: entry.expectedRows ?? 0,
      canCount: entry.canCount !== false,
      reason: entry.reason || null
    }])),
    rowCountsReliable: reliable,
    rowCountLimitations: limitations,
    warnings,
    statements: 0,
    skipped: 0
  };
}

function verifySession({ foreignKeys = [], orphan = 0, rows = 1, countError = null, metadataError = null, settings = 1 } = {}) {
  const session = new DatabaseSession({});
  session.connection = {};
  session.dead = false;
  const queries = [];
  session.raw = async (sql, params) => {
    queries.push({ sql, params });
    if (/information_schema\.KEY_COLUMN_USAGE/.test(sql)) {
      if (metadataError) throw metadataError;
      return { rows: foreignKeys };
    }
    if (/LEFT JOIN/.test(sql)) return { rows: [{ orphans: orphan }] };
    if (/^SELECT COUNT\(\*\) AS rowCount/.test(sql)) {
      if (countError) throw countError;
      return { rows: [{ rowCount: rows }] };
    }
    if (/@@FOREIGN_KEY_CHECKS/.test(sql)) return { rows: [{ foreignKeys: settings }] };
    throw new Error(`Unexpected verification query: ${sql}`);
  };
  return { session, queries };
}

const foreignKey = (overrides = {}) => ({
  tableName: 'child',
  constraintName: 'fk_parent',
  referencedSchema: 'sample',
  referencedTable: 'parent',
  columnName: 'parent_id',
  referencedColumn: 'id',
  position: 1,
  ...overrides
});

test('verifyRestore phát hiện khóa ngoại mồ côi với composite và NULL đúng ngữ nghĩa', async () => {
  const inventory = restoreInventory({ tables: { child: { expectedRows: 2 } } });
  const { session, queries } = verifySession({
    foreignKeys: [
      foreignKey({ columnName: 'parent_id', referencedColumn: 'id', position: 1 }),
      foreignKey({ columnName: 'parent_region', referencedColumn: 'region', position: 2 })
    ],
    orphan: 1
  });
  const result = await session.verifyRestore('sample', inventory);
  assert.equal(result.status, 'failed');
  assert.equal(result.verified, false);
  assert.deepEqual(result.checks.foreignKeys.orphans, [{
    table: 'child',
    constraint: 'fk_parent',
    referencedTable: 'parent',
    orphans: 1
  }]);
  const orphanQuery = queries.find((entry) => /LEFT JOIN/.test(entry.sql));
  assert.match(orphanQuery.sql, /c\.`parent_id` <=> p\.`id` AND c\.`parent_region` <=> p\.`region`/);
  assert.match(orphanQuery.sql, /c\.`parent_id` IS NOT NULL AND c\.`parent_region` IS NOT NULL/);
  assert.match(orphanQuery.sql, /WHERE .* AND p\.`id` IS NULL$/);
  assert.equal(queries.some((entry) => /^DELETE /i.test(entry.sql)), false);
});

test('verifyRestore coi dữ liệu sạch là verified và đối chiếu số dòng', async () => {
  const inventory = restoreInventory({ tables: { child: { expectedRows: 2 } } });
  const { session } = verifySession({ foreignKeys: [foreignKey()], orphan: 0, rows: 2 });
  const result = await session.verifyRestore('sample', inventory);
  assert.equal(result.status, 'verified');
  assert.equal(result.verified, true);
  assert.equal(result.checks.foreignKeys.status, 'checked');
  assert.equal(result.checks.rowCounts.status, 'checked');
  assert.equal(result.checks.rowCounts.checked, 1);
  assert.equal(result.checks.warnings.status, 'clean');
  assert.equal(result.checks.settings.status, 'ok');
});

test('verifyRestore báo lệch số dòng sau phục hồi', async () => {
  const inventory = restoreInventory({ tables: { child: { expectedRows: 3 } } });
  const { session } = verifySession({ foreignKeys: [foreignKey()], orphan: 0, rows: 1 });
  const result = await session.verifyRestore('sample', inventory);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.checks.rowCounts.mismatches, [{ table: 'child', expected: 3, actual: 1 }]);
});

test('verifyRestore đánh dấu data-loss khi database đã cắt dữ liệu', async () => {
  const inventory = restoreInventory({
    tables: { child: { expectedRows: 1 } },
    warnings: [{ statement: 2, code: 1265, level: 'Warning', message: 'Data truncated' }]
  });
  const { session } = verifySession({ foreignKeys: [], orphan: 0, rows: 1 });
  const result = await session.verifyRestore('sample', inventory);
  assert.equal(result.status, 'failed');
  assert.equal(result.checks.warnings.status, 'data-loss');
  assert.equal(result.checks.warnings.count, 1);
});

test('verifyRestore đánh dấu unverified cho khóa ngoại chéo schema và lỗi metadata', async () => {
  const cross = restoreInventory({ tables: { child: { expectedRows: 1 } } });
  const crossSession = verifySession({
    foreignKeys: [foreignKey({ referencedSchema: 'other_db' })],
    orphan: 0,
    rows: 1
  });
  const crossResult = await crossSession.session.verifyRestore('sample', cross);
  assert.equal(crossResult.status, 'unverified');
  assert.equal(crossResult.checks.foreignKeys.status, 'unverified');
  assert.equal(crossResult.checks.foreignKeys.crossSchema.length, 1);
  assert.equal(crossSession.queries.some((entry) => /LEFT JOIN/.test(entry.sql)), false);
  assert.ok(crossResult.limitations.some((message) => message.includes('ngoài database đích')));

  const broken = restoreInventory({ tables: { child: { expectedRows: 1 } } });
  const brokenSession = verifySession({ metadataError: new Error('metadata unavailable') });
  const brokenResult = await brokenSession.session.verifyRestore('sample', broken);
  assert.equal(brokenResult.status, 'unverified');
  assert.equal(brokenResult.checks.foreignKeys.status, 'unverified');
  assert.ok(brokenResult.limitations.some((message) => message.includes('metadata')));
});

test('verifyRestore không đếm bảng vượt giới hạn và báo FOREIGN_KEY_CHECKS còn tắt', async () => {
  const inventory = restoreInventory({ tables: { huge: { expectedRows: 500001 } } });
  const { session, queries } = verifySession({ foreignKeys: [], orphan: 0, settings: 0 });
  const result = await session.verifyRestore('sample', inventory);
  assert.equal(result.status, 'failed');
  assert.equal(result.checks.rowCounts.status, 'checked');
  assert.equal(queries.some((entry) => /^SELECT COUNT\(\*\) AS rowCount/.test(entry.sql)), false);
  assert.ok(result.limitations.some((message) => message.includes('vượt giới hạn')));
  assert.equal(result.checks.settings.status, 'failed');
});
