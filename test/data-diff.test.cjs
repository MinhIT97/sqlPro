'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const SqlDataDiff = require('../data-diff.js');

test('compareCanonicalValues strictly distinguishes NULL, empty strings, numbers, and booleans', () => {
  // NULL equality
  assert.equal(SqlDataDiff.compareCanonicalValues(null, null), true);
  assert.equal(SqlDataDiff.compareCanonicalValues(undefined, null), true);
  assert.equal(SqlDataDiff.compareCanonicalValues(null, ''), false);
  assert.equal(SqlDataDiff.compareCanonicalValues(null, 0), false);
  assert.equal(SqlDataDiff.compareCanonicalValues(null, 'NULL'), false);

  // Booleans
  assert.equal(SqlDataDiff.compareCanonicalValues(1, true, 'TINYINT(1)'), true);
  assert.equal(SqlDataDiff.compareCanonicalValues('1', true, 'BOOLEAN'), true);
  assert.equal(SqlDataDiff.compareCanonicalValues(0, false, 'TINYINT(1)'), true);
  assert.equal(SqlDataDiff.compareCanonicalValues(1, 0, 'BOOLEAN'), false);

  // Numbers
  assert.equal(SqlDataDiff.compareCanonicalValues(100, '100', 'INT'), true);
  assert.equal(SqlDataDiff.compareCanonicalValues(45.50, '45.5', 'DECIMAL(10,2)'), true);
  assert.equal(SqlDataDiff.compareCanonicalValues(45.5, 45.6, 'FLOAT'), false);

  // Dates
  assert.equal(SqlDataDiff.compareCanonicalValues('2026-11-17 14:00:00', '2026-11-17T14:00:00.000Z', 'DATETIME'), true);
  assert.equal(SqlDataDiff.compareCanonicalValues('2026-11-17', '2026-11-18', 'DATE'), false);

  // JSON
  assert.equal(SqlDataDiff.compareCanonicalValues('{"b":2,"a":1}', '{"a":1,"b":2}', 'JSON'), true);
  assert.equal(SqlDataDiff.compareCanonicalValues('{"a":1}', '{"a":2}', 'JSON'), false);
});

test('extractRowKey creates canonical keys for single and composite primary keys', () => {
  const columns = ['id', 'user_id', 'role', 'name'];

  // Array row single PK
  assert.equal(SqlDataDiff.extractRowKey([101, 1, 'admin', 'Alice'], ['id'], columns), '101');

  // Array row composite PK
  assert.equal(SqlDataDiff.extractRowKey([101, 55, 'editor', 'Bob'], ['id', 'user_id'], columns), '101::55');

  // Object row composite PK
  const objRow = { id: 202, user_id: 88, role: 'viewer', name: 'Charlie' };
  assert.equal(SqlDataDiff.extractRowKey(objRow, ['id', 'user_id']), '202::88');

  // Missing or NULL PK returns null
  assert.equal(SqlDataDiff.extractRowKey({ id: null, user_id: 88 }, ['id', 'user_id']), null);
});

test('compareTableData categorizes identical, added, modified, and deleted rows with metrics', () => {
  const columns = [
    { name: 'id', type: 'INT' },
    { name: 'username', type: 'VARCHAR(50)' },
    { name: 'email', type: 'VARCHAR(100)' },
    { name: 'balance', type: 'DECIMAL(10,2)' }
  ];
  const primaryKeys = ['id'];

  const sourceRows = [
    [1, 'alice', 'alice@company.com', 100.50], // identical
    [2, 'bob_new', 'bob@company.com', 250.00],  // modified in source
    [3, 'charlie', 'charlie@company.com', 0]   // only in source (added)
  ];

  const targetRows = [
    [1, 'alice', 'alice@company.com', 100.50], // identical
    [2, 'bob_old', 'bob@company.com', 200.00], // modified (different username and balance)
    [4, 'david', 'david@company.com', 50.00]   // only in target (extra / deleted in source)
  ];

  const diff = SqlDataDiff.compareTableData({
    sourceRows,
    targetRows,
    primaryKeys,
    columns
  });

  assert.equal(diff.summary.totalSource, 3);
  assert.equal(diff.summary.totalTarget, 3);
  assert.equal(diff.summary.identicalCount, 1);
  assert.equal(diff.summary.onlyInSourceCount, 1);
  assert.equal(diff.summary.differentCount, 1);
  assert.equal(diff.summary.onlyInTargetCount, 1);

  // Check identical
  assert.equal(diff.identical[0].rowKey, '1');

  // Check onlyInSource
  assert.equal(diff.onlyInSource[0].rowKey, '3');
  assert.equal(diff.onlyInSource[0].row[1], 'charlie');

  // Check onlyInTarget
  assert.equal(diff.onlyInTarget[0].rowKey, '4');
  assert.equal(diff.onlyInTarget[0].row[1], 'david');

  // Check different details
  assert.equal(diff.different[0].rowKey, '2');
  assert.equal(diff.different[0].differences.length, 2); // username and balance
  assert.equal(diff.different[0].differences[0].column, 'username');
  assert.equal(diff.different[0].differences[0].sourceValue, 'bob_new');
  assert.equal(diff.different[0].differences[0].targetValue, 'bob_old');
});

test('generateSyncSql generates safe INSERT, UPDATE, and guarded DELETE statements', () => {
  const columns = [
    { name: 'id', type: 'INT' },
    { name: 'title', type: 'VARCHAR(100)' },
    { name: 'price', type: 'DECIMAL(10,2)' }
  ];
  const primaryKeys = ['id'];

  const diff = SqlDataDiff.compareTableData({
    sourceRows: [
      [10, 'Book A', 15.00], // identical
      [20, 'Book B Updated', 25.00], // modified
      [30, 'Book C New', 35.00] // added
    ],
    targetRows: [
      [10, 'Book A', 15.00],
      [20, 'Book B Old', 20.00],
      [99, 'Old Deleted Book', 5.00] // extra in target
    ],
    primaryKeys,
    columns
  });

  // Default: deletes false
  const syncDefault = SqlDataDiff.generateSyncSql({
    targetTable: 'products',
    diffResult: diff
  });

  assert.equal(syncDefault.statements.length, 2); // 1 INSERT + 1 UPDATE
  assert.equal(syncDefault.statements[0].type, 'INSERT');
  assert.equal(syncDefault.statements[0].severity, 'safe');
  assert.ok(syncDefault.statements[0].sql.includes("INSERT INTO `products` (`id`, `title`, `price`) VALUES (30, 'Book C New', 35);"));

  assert.equal(syncDefault.statements[1].type, 'UPDATE');
  assert.equal(syncDefault.statements[1].severity, 'warning');
  assert.ok(syncDefault.statements[1].sql.includes("UPDATE `products` SET `title` = 'Book B Updated', `price` = 25 WHERE `id` = 20;"));

  // With DELETE enabled explicitly
  const syncWithDelete = SqlDataDiff.generateSyncSql({
    targetTable: 'products',
    diffResult: diff,
    options: { includeDeletes: true }
  });

  assert.equal(syncWithDelete.statements.length, 3);
  assert.equal(syncWithDelete.statements[2].type, 'DELETE');
  assert.equal(syncWithDelete.statements[2].severity, 'destructive');
  assert.ok(syncWithDelete.statements[2].sql.includes("DELETE FROM `products` WHERE `id` = 99;"));
  assert.ok(syncWithDelete.script.includes('-- Total Statements: 3'));
});

test('generateSyncSql handles composite primary keys in WHERE clause', () => {
  const columns = [
    { name: 'tenant_id', type: 'INT' },
    { name: 'order_id', type: 'INT' },
    { name: 'amount', type: 'DECIMAL(10,2)' }
  ];
  const primaryKeys = ['tenant_id', 'order_id'];

  const diff = SqlDataDiff.compareTableData({
    sourceRows: [
      [1, 1001, 500.00]
    ],
    targetRows: [
      [1, 1001, 450.00]
    ],
    primaryKeys,
    columns
  });

  const sync = SqlDataDiff.generateSyncSql({
    targetTable: 'tenant_orders',
    diffResult: diff
  });

  assert.equal(sync.statements.length, 1);
  assert.ok(sync.statements[0].sql.includes("WHERE `tenant_id` = 1 AND `order_id` = 1001;"));
});
