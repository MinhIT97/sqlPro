'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSession } = require('../electron/database.cjs');

test('backup chia INSERT theo dung lượng khi mỗi dòng lớn', async () => {
  const session = new DatabaseSession({});
  session.connection = {
    query() {
      return {
        async *stream() {
          for (let index = 0; index < 4; index += 1) yield ['x'.repeat(400000)];
        }
      };
    }
  };
  session.listTables = async () => [{ name: 'items', type: 'table' }];
  session.listColumns = async () => [{ name: 'value', extra: '' }];
  const chunks = [];
  const result = await session.writeBackup(
    { database: 'sample', tables: ['items'], includeStructure: false, includeData: true },
    async (chunk) => { chunks.push(chunk); }
  );
  const inserts = chunks.filter((chunk) => chunk.startsWith('INSERT INTO'));
  assert.equal(result.rows, 4);
  assert.equal(inserts.length, 2);
  assert.ok(inserts.every((chunk) => Buffer.byteLength(chunk) < 1024 * 1024));
  assert.equal(result.bytes, Buffer.byteLength(chunks.join('')));
});

test('backup báo phần trăm ước tính và giữ dưới 100 cho đến khi tệp hoàn tất', async () => {
  const session = new DatabaseSession({});
  session.connection = {
    query() {
      return { async *stream() { for (let index = 0; index < 4; index += 1) yield [index]; } };
    }
  };
  session.listTables = async () => [{ name: 'items', type: 'table', rowEstimate: 4 }];
  session.listColumns = async () => [{ name: 'id', extra: '' }];
  const progress = [];
  await session.writeBackup(
    { database: 'sample', tables: ['items'], includeStructure: false },
    async () => {},
    (entry) => progress.push(entry)
  );
  assert.ok(progress.length > 0);
  assert.ok(progress.every((entry) => Number.isInteger(entry.percent) && entry.percent >= 0 && entry.percent < 100));
  assert.ok(progress.at(-1).percent > 0);
  assert.ok(progress.some((entry) => entry.stage === 'table-data' && entry.objectName === 'items' && entry.objectIndex === 1 && entry.objectTotal === 1));
  assert.ok(progress.some((entry) => entry.events.some((event) => event.stage === 'table-data' && event.objectName === 'items')));
  assert.equal(progress.at(-1).stage, 'finishing');
});

test('backup nhiều dòng vẫn nhường event loop cho thao tác khác', async () => {
  const session = new DatabaseSession({});
  session.connection = {
    query() {
      return { async *stream() { for (let index = 0; index < 2000; index += 1) yield [index]; } };
    }
  };
  session.listTables = async () => [{ name: 'items', type: 'table', rowEstimate: 2000 }];
  session.listColumns = async () => [{ name: 'id', extra: '' }];
  let timerFired = false;
  setTimeout(() => { timerFired = true; }, 0);
  const result = await session.writeBackup(
    { database: 'sample', tables: ['items'], includeStructure: false },
    async () => {}
  );
  assert.equal(result.rows, 2000);
  assert.equal(timerFired, true);
});

test('backup không bịa phần trăm khi chưa có ước tính khối lượng', async () => {
  const session = new DatabaseSession({});
  session.connection = {};
  session.listTables = async () => [{ name: 'only_view', type: 'view' }];
  const progress = [];
  const result = await session.writeBackup(
    { database: 'sample', tables: ['only_view'], includeStructure: false, includeData: true },
    async () => {},
    (entry) => progress.push(entry)
  );
  assert.equal(result.rows, 0);
  assert.ok(progress.length > 0);
  assert.ok(progress.every((entry) => entry.percent === null));
  assert.ok(progress.every((entry) => entry.estimated === true));
});

function routineSession() {
  const session = new DatabaseSession({});
  session.connection = {};
  session.metadata = new Map();
  session.listTables = async () => [{ name: 'items', type: 'table' }];
  session.listColumns = async () => [{ name: 'id', extra: '' }];
  session.listRoutines = async () => [
    { name: 'p_one', type: 'procedure' },
    { name: 'f_one', type: 'function' }
  ];
  session.listEvents = async () => [{ name: 'e_one', type: 'RECURRING' }];
  session.raw = async (sql) => {
    if (/^SHOW CREATE PROCEDURE/.test(sql)) {
      return { result: [{ 'Create Procedure': 'CREATE DEFINER=`root`@`localhost` PROCEDURE `p_one`()\nBEGIN\n  SELECT 1;\nEND' }] };
    }
    if (/^SHOW CREATE FUNCTION/.test(sql)) {
      return { result: [{ 'Create Function': "CREATE DEFINER=`root`@`localhost` FUNCTION `f_one`() RETURNS int\nRETURN 1" }] };
    }
    if (/^SHOW CREATE EVENT/.test(sql)) {
      return { result: [{ 'Create Event': "CREATE DEFINER=`root`@`localhost` EVENT `e_one` ON SCHEDULE EVERY 1 DAY DO SELECT 1" }] };
    }
    if (/information_schema\.TRIGGERS/.test(sql)) return { result: [], rows: [] };
    if (/^SHOW CREATE TABLE/.test(sql)) {
      return { result: [{ 'Create Table': 'CREATE TABLE `items` (`id` int)' }] };
    }
    return { result: [], rows: [] };
  };
  return session;
}

function snapshotSession(engine) {
  const session = new DatabaseSession({});
  const rawCalls = [];
  session.version = '8.0-test';
  session.metadata = new Map();
  session.connection = {
    query() {
      return {
        async *stream() {
          yield [1];
        }
      };
    }
  };
  session.listTables = async () => [
    { name: 'items', type: 'table', engine },
    { name: 'logs', type: 'table', engine }
  ];
  session.listColumns = async () => [{ name: 'id', extra: '' }];
  session.raw = async (sql) => {
    rawCalls.push(sql);
    return { result: [], rows: [] };
  };
  return { session, rawCalls };
}

test('backup nhiều bảng InnoDB dùng một consistent snapshot và rollback sau khi đọc', async () => {
  const { session, rawCalls } = snapshotSession('InnoDB');
  const result = await session.writeBackup(
    { database: 'sample', includeStructure: false, includeData: true },
    async () => {}
  );
  assert.equal(result.rows, 2);
  assert.equal(result.snapshot, true);
  assert.deepEqual(rawCalls.slice(0, 2), [
    'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
    'START TRANSACTION WITH CONSISTENT SNAPSHOT'
  ]);
  assert.equal(rawCalls.at(-1), 'ROLLBACK');
});

test('backup bảng không phải InnoDB không mở snapshot giả', async () => {
  const { session, rawCalls } = snapshotSession('MyISAM');
  const result = await session.writeBackup(
    { database: 'sample', includeStructure: false, includeData: true },
    async () => {}
  );
  assert.equal(result.rows, 2);
  assert.equal(result.snapshot, false);
  assert.match(result.warnings[0], /không dùng InnoDB/);
  assert.deepEqual(rawCalls, []);
});

test('backup rollback snapshot ngay cả khi ghi tệp thất bại', async () => {
  const { session, rawCalls } = snapshotSession('InnoDB');
  await assert.rejects(
    session.writeBackup(
      { database: 'sample', includeStructure: false, includeData: true },
      async () => { throw new Error('disk full'); }
    ),
    /disk full/
  );
  assert.equal(rawCalls.at(-1), 'ROLLBACK');
  assert.equal(session.activeTask, null);
});

test('backup routine, function và event bằng SHOW CREATE trong khối DELIMITER', async () => {
  const session = routineSession();
  const chunks = [];
  const result = await session.writeBackup(
    {
      database: 'sample',
      tables: ['items'],
      routines: ['procedure:p_one', 'function:f_one'],
      events: ['e_one'],
      includeStructure: true,
      includeData: false,
      dropTables: true,
      stripDefiner: true
    },
    async (chunk) => { chunks.push(chunk); }
  );
  const text = chunks.join('');
  assert.match(text, /DELIMITER \$\$/);
  assert.match(text, /DROP PROCEDURE IF EXISTS `p_one`\$\$/);
  assert.match(text, /DROP FUNCTION IF EXISTS `f_one`\$\$/);
  assert.match(text, /DROP EVENT IF EXISTS `e_one`\$\$/);
  assert.match(text, /CREATE PROCEDURE `p_one`\(\)/);
  assert.match(text, /CREATE FUNCTION `f_one`\(\)/);
  assert.match(text, /CREATE EVENT `e_one`/);
  assert.doesNotMatch(text, /DEFINER=/);
  assert.equal(result.procedures, 1);
  assert.equal(result.functions, 1);
  assert.equal(result.events, 1);
});

test('giữ DEFINER khi không yêu cầu loại bỏ', async () => {
  const session = routineSession();
  const chunks = [];
  await session.writeBackup(
    {
      database: 'sample',
      tables: [],
      routines: ['procedure:p_one'],
      events: [],
      includeStructure: true,
      includeData: false,
      stripDefiner: false
    },
    async (chunk) => { chunks.push(chunk); }
  );
  assert.match(chunks.join(''), /CREATE DEFINER=`root`@`localhost` PROCEDURE `p_one`/);
});

test('hủy backup trả BACKUP_CANCELED kèm số liệu một phần và giải phóng tác vụ', async () => {
  const session = routineSession();
  const chunks = [];
  let canceled = false;
  await assert.rejects(
    session.writeBackup(
      { database: 'sample', tables: ['items'], includeStructure: false, includeData: true },
      async (chunk) => {
        chunks.push(chunk);
        if (!canceled) {
          canceled = true;
          session.cancelTask();
        }
      }
    ),
    (error) => {
      assert.equal(error.code, 'BACKUP_CANCELED');
      assert.ok(error.partial);
      assert.equal(typeof error.partial.bytes, 'number');
      return true;
    }
  );
  assert.equal(session.activeTask, null);
  assert.ok(chunks.length >= 1);
});
