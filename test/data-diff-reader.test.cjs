'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  quoteId,
  parseDecimal,
  compareDecimalStrings,
  isNumericColumnType,
  compareKeyTuples,
  extractRowKeyTuple,
  buildKeysetQuery,
  validateTableForDiff,
  TableKeysetReader
} = require('../electron/data-diff-reader.cjs');

test('quoteId escapes backticks safely', () => {
  assert.equal(quoteId('users'), '`users`');
  assert.equal(quoteId('user`table'), '`user``table`');
  assert.equal(quoteId('123'), '`123`');
});

test('compareDecimalStrings compares arbitrary precision decimals without Number precision loss', () => {
  // Edge cases and large integers
  assert.equal(compareDecimalStrings('9007199254740993', '9007199254740992'), 1);
  assert.equal(compareDecimalStrings('9007199254740992', '9007199254740993'), -1);
  assert.equal(compareDecimalStrings('9007199254740992', '9007199254740992'), 0);

  // Decimals with trailing zeroes, different scale
  assert.equal(compareDecimalStrings('1.5', '1.500'), 0);
  assert.equal(compareDecimalStrings('1.50', '1.51'), -1);
  assert.equal(compareDecimalStrings('1.52', '1.51999999999999999999'), 1);

  // Negative and zeroes
  assert.equal(compareDecimalStrings('-0.0', '0'), 0);
  assert.equal(compareDecimalStrings('-5.2', '-5.1'), -1);
  assert.equal(compareDecimalStrings('-5.1', '-5.2'), 1);
  assert.equal(compareDecimalStrings('-1', '1'), -1);
  assert.equal(compareDecimalStrings('0', '-1'), 1);

  // Exponents
  assert.equal(compareDecimalStrings('1e3', '1000'), 0);
  assert.equal(compareDecimalStrings('1e3', '999'), 1);
  assert.equal(compareDecimalStrings('-1e2', '-100'), 0);

  // Micro decimals
  assert.equal(compareDecimalStrings('0.000000000000000001', '0.000000000000000002'), -1);
  assert.equal(compareDecimalStrings('0.000000000000000002', '0.000000000000000001'), 1);
});

test('compareKeyTuples handles numeric and string primary keys correctly', () => {
  // Numeric PK comparison
  assert.equal(compareKeyTuples([2], [10], ['int']), -1);
  assert.equal(compareKeyTuples([10], [2], ['int']), 1);
  assert.equal(compareKeyTuples([10], [10], ['int']), 0);

  // Composite PK: [tenant_id (int), user_id (int)]
  assert.equal(compareKeyTuples([1, 2], [1, 10], ['int', 'int']), -1);
  assert.equal(compareKeyTuples([2, 1], [1, 10], ['int', 'int']), 1);
  assert.equal(compareKeyTuples([1, 10], [1, 10], ['int', 'int']), 0);

  // Composite PK: [org (varchar), id (bigint)]
  assert.equal(compareKeyTuples(['alpha', '2'], ['alpha', '10'], ['varchar', 'bigint']), -1);
  assert.equal(compareKeyTuples(['alpha', '10'], ['beta', '1'], ['varchar', 'bigint']), -1);
  assert.equal(compareKeyTuples(['beta', '1'], ['alpha', '10'], ['varchar', 'bigint']), 1);

  // Rejection of null/undefined in PK
  assert.throws(() => compareKeyTuples([null], [1], ['int']), { code: 'DATA_DIFF_NULL_KEY' });
  assert.throws(() => compareKeyTuples([1], [undefined], ['int']), { code: 'DATA_DIFF_NULL_KEY' });
  assert.throws(() => compareKeyTuples([1], [1, 2], ['int']), { code: 'DATA_DIFF_KEY_MISMATCH' });
});

test('extractRowKeyTuple extracts values from object and array rows', () => {
  const pks = ['tenant_id', 'user_id'];
  const cols = ['tenant_id', 'user_id', 'name'];

  // From object row
  const objRow = { tenant_id: 1, user_id: 100, name: 'Alice' };
  assert.deepEqual(extractRowKeyTuple(objRow, pks, cols), [1, 100]);

  // From array row
  const arrRow = [1, 100, 'Alice'];
  assert.deepEqual(extractRowKeyTuple(arrRow, pks, cols), [1, 100]);

  // Missing or NULL PK throws DATA_DIFF_NULL_KEY
  assert.throws(() => extractRowKeyTuple({ tenant_id: null, user_id: 100 }, pks, cols), { code: 'DATA_DIFF_NULL_KEY' });
  assert.throws(() => extractRowKeyTuple({ tenant_id: 1 }, pks, cols), { code: 'DATA_DIFF_NULL_KEY' });
});

test('buildKeysetQuery builds valid parameterized SQL for single and composite keys', () => {
  const cols = [{ name: 'id' }, { name: 'name' }];
  const pks = ['id'];

  // Chunk 1 (no previous key)
  const q1 = buildKeysetQuery('testdb', 'users', cols, pks, null, 100);
  assert.equal(q1.sql, 'SELECT `id`, `name` FROM `testdb`.`users` ORDER BY `id` ASC LIMIT ?');
  assert.deepEqual(q1.params, [100]);

  // Chunk 2 (after id = 42)
  const q2 = buildKeysetQuery('testdb', 'users', cols, pks, [42], 100);
  assert.equal(q2.sql, 'SELECT `id`, `name` FROM `testdb`.`users` WHERE `id` > ? ORDER BY `id` ASC LIMIT ?');
  assert.deepEqual(q2.params, [42, 100]);

  // Composite 2-column keyset
  const compCols = [{ name: 'tenant_id' }, { name: 'user_id' }, { name: 'email' }];
  const compPks = ['tenant_id', 'user_id'];
  const q3 = buildKeysetQuery('testdb', 'members', compCols, compPks, [5, 120], 50);
  assert.equal(
    q3.sql,
    'SELECT `tenant_id`, `user_id`, `email` FROM `testdb`.`members` WHERE (`tenant_id` > ?) OR (`tenant_id` = ? AND `user_id` > ?) ORDER BY `tenant_id` ASC, `user_id` ASC LIMIT ?'
  );
  assert.deepEqual(q3.params, [5, 5, 120, 50]);
});

test('validateTableForDiff rejects tables without PK or with unsupported types', async () => {
  const fakeSession = {
    async listColumns(database, table) {
      if (table === 'no_pk') {
        return [{ name: 'name', type: 'varchar(50)', key: '' }];
      }
      if (table === 'unsupported_blob') {
        return [
          { name: 'id', type: 'int', key: 'PRI' },
          { name: 'data', type: 'blob', key: '' }
        ];
      }
      if (table === 'unsupported_float_pk') {
        return [{ name: 'id', type: 'float', key: 'PRI' }];
      }
      if (table === 'varchar_ci_pk') {
        return [{ name: 'code', type: 'varchar(64)', key: 'PRI', collation: 'utf8mb4_general_ci' }];
      }
      if (table === 'varchar_bin_pk') {
        return [{ name: 'code', type: 'varchar(64)', key: 'PRI', collation: 'utf8mb4_bin' }];
      }
      if (table === 'composite_bin_pk') {
        return [
          { name: 'tenant_id', type: 'int', key: 'PRI' },
          { name: 'uuid', type: 'varchar(36)', key: 'PRI', collation: 'utf8mb4_bin' }
        ];
      }
      if (table === 'valid') {
        return [
          { name: 'id', type: 'int', key: 'PRI' },
          { name: 'name', type: 'varchar(100)', key: '' }
        ];
      }
      return [];
    },
    async raw() {
      return { result: [{ engine: 'InnoDB' }] };
    }
  };

  await assert.rejects(
    () => validateTableForDiff(fakeSession, 'db', 'no_pk'),
    { code: 'DATA_DIFF_NO_PRIMARY_KEY' }
  );

  await assert.rejects(
    () => validateTableForDiff(fakeSession, 'db', 'unsupported_blob'),
    { code: 'DATA_DIFF_UNSUPPORTED_COLUMN_TYPE' }
  );

  await assert.rejects(
    () => validateTableForDiff(fakeSession, 'db', 'unsupported_float_pk'),
    { code: 'DATA_DIFF_UNSUPPORTED_PK_TYPE' }
  );

  await assert.rejects(
    () => validateTableForDiff(fakeSession, 'db', 'varchar_ci_pk'),
    { code: 'DATA_DIFF_UNSUPPORTED_PK_TYPE' }
  );

  const binValid = await validateTableForDiff(fakeSession, 'db', 'varchar_bin_pk');
  assert.deepEqual(binValid.primaryKeys, ['code']);

  const compValid = await validateTableForDiff(fakeSession, 'db', 'composite_bin_pk');
  assert.deepEqual(compValid.primaryKeys, ['tenant_id', 'uuid']);

  const valid = await validateTableForDiff(fakeSession, 'db', 'valid');
  assert.deepEqual(valid.primaryKeys, ['id']);
  assert.equal(valid.engine, 'InnoDB');
});

test('TableKeysetReader streams chunks, obeys quotas and rolls back snapshot on close', async () => {
  const queries = [];
  const fakeSession = {
    async listColumns() {
      return [
        { name: 'id', type: 'int', key: 'PRI' },
        { name: 'value', type: 'varchar(50)', key: '' }
      ];
    },
    async raw(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('information_schema.TABLES')) {
        return { result: [{ engine: 'InnoDB' }] };
      }
      if (sql.startsWith('START TRANSACTION') || sql.startsWith('ROLLBACK')) {
        return { result: [] };
      }
      // Return chunks of 2 rows
      if (params?.[0] === 50) { // limit 50, first query
        return {
          rows: [
            { id: 1, value: 'one' },
            { id: 2, value: 'two' }
          ]
        };
      }
      if (params?.[0] === 2) { // after id = 2
        return {
          rows: [
            { id: 3, value: 'three' }
          ]
        };
      }
      return { rows: [] };
    }
  };

  const reader = new TableKeysetReader(fakeSession, 'app_db', 'items', {
    chunkSize: 50,
    maxRows: 100
  });

  await reader.init();
  assert.equal(reader.inTransaction, true);
  assert.ok(queries.some(q => q.sql === 'START TRANSACTION WITH CONSISTENT SNAPSHOT'));

  // First chunk
  const chunk1 = await reader.readNextChunk();
  assert.equal(chunk1.rows.length, 2);
  assert.equal(chunk1.hasMore, false); // because 2 < chunkSize (50)
  assert.deepEqual(chunk1.lastKeyValues, [2]);

  await reader.close();
  assert.equal(reader.inTransaction, false);
  assert.ok(queries.some(q => q.sql === 'ROLLBACK'));
});

test('TableKeysetReader enforces maxBytes quota and AbortSignal cancellation', async () => {
  const fakeSession = {
    async listColumns() {
      return [{ name: 'id', type: 'int', key: 'PRI' }, { name: 'txt', type: 'text', key: '' }];
    },
    async raw(sql) {
      if (sql.includes('information_schema.TABLES')) return { result: [{ engine: 'MyISAM' }] };
      return {
        rows: [{ id: 1, txt: 'x'.repeat(1024) }]
      };
    }
  };

  // Quota test: maxBytes = 500 bytes, row has 1024 bytes
  const reader = new TableKeysetReader(fakeSession, 'db', 'tbl', {
    chunkSize: 10,
    maxBytes: 500
  });
  await reader.init();
  await assert.rejects(() => reader.readNextChunk(), { code: 'DATA_DIFF_BUDGET_EXCEEDED' });
  await reader.close();

  // AbortSignal test
  const controller = new AbortController();
  const reader2 = new TableKeysetReader(fakeSession, 'db', 'tbl', {
    signal: controller.signal
  });
  await reader2.init();
  controller.abort();
  await assert.rejects(() => reader2.readNextChunk(), { code: 'DATA_DIFF_CANCELLED' });
  await reader2.close();
});
