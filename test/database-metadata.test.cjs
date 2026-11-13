'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSession } = require('../electron/database.cjs');

test('column and index caches keep database/table boundaries when identifiers contain dots', async () => {
  const session = new DatabaseSession({});
  let calls = 0;
  session.raw = async (sql, [database, table]) => {
    calls++;
    const name = database === 'a.b' ? 'first_key' : 'second_key';
    return { result: sql.includes('COLUMNS')
      ? [{ name, type: 'int', nullable: 'NO', keyType: 'PRI', extra: '', position: 1 }]
      : [{ name: `idx_${name}`, nonUnique: 0, sequence: 1, columnName: name, type: 'BTREE', cardinality: 1 }] };
  };
  assert.equal((await session.listColumns('a.b', 'c'))[0].name, 'first_key');
  assert.equal((await session.listColumns('a', 'b.c'))[0].name, 'second_key');
  assert.equal((await session.listIndexes('a.b', 'c'))[0].name, 'idx_first_key');
  assert.equal((await session.listIndexes('a', 'b.c'))[0].name, 'idx_second_key');
  await session.listColumns('a.b', 'c'); await session.listIndexes('a', 'b.c');
  assert.equal(calls, 4);
});
