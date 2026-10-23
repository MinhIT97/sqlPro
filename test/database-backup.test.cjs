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
