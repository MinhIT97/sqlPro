'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  analyzeCreateObject,
  analyzeRoutineCharacteristics,
  buildRestorePreflight,
  parseDefiner
} = require('../electron/restore-preflight.cjs');

const SPLIT_STR = [
  'CREATE DEFINER=`root`@`localhost` FUNCTION `SPLIT_STR`(input VARCHAR(255), delimiter VARCHAR(12), part INT)',
  'RETURNS varchar(255) CHARSET utf8mb4',
  'BEGIN',
  '  RETURN SUBSTRING_INDEX(input, delimiter, part);',
  'END'
].join('\n');

function inventoryOf(...statements) {
  return {
    statements: statements.length,
    skipped: 0,
    createdObjects: statements.map((sql) => analyzeCreateObject(sql)).filter(Boolean)
  };
}

test('table và view dùng chung namespace kể cả khi bật dropExisting hoặc IF NOT EXISTS', () => {
  for (const [existing, creating] of [['view', 'table'], ['table', 'view']]) {
    for (const dropExisting of [false, true]) {
      const result = buildRestorePreflight({
        inventory: { statements: 1, createdObjects: [{ type: creating, name: 'items', ifNotExists: true }] },
        target: { databaseExists: true, objects: [{ type: existing, name: 'items' }], lowerCaseTableNames: 0 },
        options: { database: 'sample', dropExisting }
      });
      assert.equal(result.canProceed, false);
      assert.equal(result.blocking[0].code, 'TARGET_OBJECT_TYPE_MISMATCH');
    }
  }
});

test('preflight thực hiện DROP/CREATE theo thứ tự và không dùng DROP sai loại để bỏ xung đột', () => {
  const build = (operations) => buildRestorePreflight({
    inventory: { statements: operations.length, objectOperations: operations,
      createdObjects: operations.filter((entry) => entry.command === 'CREATE') },
    target: { databaseExists: true, objects: [{ type: 'table', name: 'items' }], lowerCaseTableNames: 0 },
    options: { database: 'sample' }
  });
  const drop = { command: 'DROP', type: 'table', name: 'items' };
  const create = { command: 'CREATE', type: 'table', name: 'items' };
  assert.equal(build([drop, create]).canProceed, true);
  assert.equal(build([create, drop]).canProceed, false);
  assert.equal(build([{ ...drop, type: 'view' }, create]).canProceed, false);
  assert.equal(build([drop, create, create]).canProceed, false);
  assert.equal(build([drop, { ...create, type: 'view' }]).canProceed, true);
});

test('preflight không gộp hai tên bảng khác hoa/thường trên Linux', () => {
  const result = buildRestorePreflight({
    inventory: inventoryOf('CREATE TABLE `Items` (`id` INT)', 'CREATE TABLE `items` (`id` INT)'),
    target: { databaseExists: true, objects: [{ type: 'table', name: 'items' }], lowerCaseTableNames: 0 },
    options: { database: 'sample' }
  });
  assert.equal(result.canProceed, false);
  assert.equal(result.blocking[0].objectName, 'items');
});

test('function thiếu DETERMINISTIC/NO SQL/READS SQL DATA bị đánh dấu không hợp lệ với binary logging', () => {
  const object = analyzeCreateObject(SPLIT_STR);
  assert.equal(object.type, 'function');
  assert.equal(object.name, 'SPLIT_STR');
  assert.equal(object.binlogCompliant, false);
  assert.equal(object.definer, 'root@localhost');
  assert.equal(object.characteristics.deterministic, false);
});

test('function có DETERMINISTIC được coi là hợp lệ với binary logging', () => {
  const object = analyzeCreateObject(SPLIT_STR.replace('RETURNS varchar(255)', 'RETURNS varchar(255) DETERMINISTIC'));
  assert.equal(object.binlogCompliant, true);
  assert.equal(analyzeRoutineCharacteristics(SPLIT_STR.replace('RETURNS varchar(255)', 'RETURNS varchar(255) NO SQL')).noSql, true);
  assert.equal(analyzeRoutineCharacteristics(SPLIT_STR.replace('RETURNS varchar(255)', 'RETURNS varchar(255) READS SQL DATA')).readsSqlData, true);
});

test('từ khóa trong thân function không được tính là đặc tính routine', () => {
  const object = analyzeCreateObject(
    'CREATE FUNCTION `f`() RETURNS int\nBEGIN\n  -- DETERMINISTIC\n  RETURN 1;\nEND'
  );
  assert.equal(object.binlogCompliant, false);
});

test('preflight chặn SPLIT_STR trước khi ghi khi log_bin bật và không tin function creator', () => {
  const preflight = buildRestorePreflight({
    filePath: '/tmp/restore-routines.sql',
    fileSize: 1234,
    inventory: inventoryOf(
      'CREATE TABLE `restore_items` (`id` int)',
      'INSERT INTO `restore_items` VALUES (1)',
      SPLIT_STR
    ),
    target: {
      database: 'sample',
      databaseExists: true,
      objects: [],
      objectsComplete: true,
      version: '8.4.0',
      flavor: 'MySQL',
      logBin: 1,
      logBinTrustFunctionCreators: 0,
      lowerCaseTableNames: 0,
      currentUser: 'root@localhost'
    },
    options: { database: 'sample' }
  });
  assert.equal(preflight.canProceed, false);
  assert.equal(preflight.status, 'blocking');
  const finding = preflight.blocking.find((entry) => entry.code === 'BINARY_LOG_FUNCTION_NOT_COMPLIANT');
  assert.ok(finding);
  assert.equal(finding.objectName, 'SPLIT_STR');
  assert.match(finding.action, /bỏ chọn function/i);
  assert.equal(preflight.impact.createCounts.functions, 1);
  assert.equal(preflight.impact.objects, 2);
});

test('preflight không chặn function không hợp lệ khi binary logging tắt hoặc target tin function creator', () => {
  const base = {
    inventory: inventoryOf(SPLIT_STR),
    options: { database: 'sample' }
  };
  const logOff = buildRestorePreflight({
    ...base,
    target: { databaseExists: true, objects: [], objectsComplete: true, logBin: 0, logBinTrustFunctionCreators: 0 }
  });
  assert.equal(logOff.canProceed, true);
  assert.deepEqual(logOff.blocking, []);

  const trusted = buildRestorePreflight({
    ...base,
    target: { databaseExists: true, objects: [], objectsComplete: true, logBin: 1, logBinTrustFunctionCreators: 1 }
  });
  assert.equal(trusted.canProceed, true);
  assert.deepEqual(trusted.blocking, []);
});

test('thiếu thông tin binary logging trả unknown, không âm thầm cho là an toàn', () => {
  const preflight = buildRestorePreflight({
    inventory: inventoryOf(SPLIT_STR),
    target: {
      databaseExists: null,
      objectsComplete: false,
      errors: [{ check: 'server', message: 'access denied' }]
    },
    options: { database: 'sample' }
  });
  assert.equal(preflight.canProceed, true);
  assert.equal(preflight.status, 'unknown');
  assert.ok(preflight.unknown.some((entry) => entry.code === 'BINARY_LOG_FUNCTION_UNVERIFIED'
    && entry.objectName === 'SPLIT_STR'));
  assert.ok(preflight.unknown.some((entry) => entry.code === 'TARGET_FACTS_INCOMPLETE'));
  assert.ok(preflight.unknown.some((entry) => entry.code === 'TARGET_OBJECTS_UNKNOWN'));
});

test('đối tượng trùng tên là blocking trừ khi bật xóa hoặc câu lệnh IF NOT EXISTS', () => {
  const inventory = inventoryOf('CREATE TABLE `items` (`id` int)');
  const target = {
    databaseExists: true,
    objects: [{ type: 'table', name: 'items' }],
    objectsComplete: true,
    logBin: 0
  };
  const blocked = buildRestorePreflight({ inventory, target, options: { database: 'sample' } });
  assert.equal(blocked.canProceed, false);
  assert.equal(blocked.blocking[0].code, 'TARGET_OBJECT_EXISTS');
  assert.equal(blocked.blocking[0].objectName, 'items');

  const dropped = buildRestorePreflight({ inventory, target, options: { database: 'sample', dropExisting: true } });
  assert.equal(dropped.canProceed, true);
  assert.equal(dropped.impact.overwritten, 1);
  assert.equal(dropped.impact.conflicts, 1);

  const ifNotExists = buildRestorePreflight({
    inventory: inventoryOf('CREATE TABLE IF NOT EXISTS `items` (`id` int)'),
    target,
    options: { database: 'sample' }
  });
  assert.equal(ifNotExists.canProceed, true);
  assert.equal(ifNotExists.warning[0].code, 'TARGET_OBJECT_EXISTS_IF_NOT_EXISTS');
});

test('không rõ lower_case_table_names thì báo xung đột tên chưa xác minh thay vì bỏ qua', () => {
  const preflight = buildRestorePreflight({
    inventory: inventoryOf('CREATE TABLE `Items` (`id` int)'),
    target: {
      databaseExists: true,
      objects: [{ type: 'table', name: 'items' }],
      objectsComplete: true,
      lowerCaseTableNames: null,
      logBin: 0
    },
    options: { database: 'sample' }
  });
  assert.equal(preflight.canProceed, true);
  assert.ok(preflight.unknown.some((entry) => entry.code === 'TARGET_OBJECT_CASE_AMBIGUOUS'
    && entry.objectName === 'Items'));
});

test('parseDefiner đọc được definer có quote và CURRENT_USER', () => {
  assert.equal(parseDefiner("CREATE DEFINER='app'@'%' PROCEDURE p() SELECT 1"), 'app@%');
  assert.equal(parseDefiner('CREATE DEFINER=CURRENT_USER PROCEDURE p() SELECT 1'), 'CURRENT_USER');
  assert.equal(parseDefiner('CREATE PROCEDURE p() SELECT 1'), null);
});
