'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSession } = require('../electron/database.cjs');

test('listRoutines quotes the reserved deterministic alias for MySQL 8', async () => {
  const queries = [];
  const session = new DatabaseSession({});
  session.connection = {
    query(sql, params, callback) {
      queries.push(sql);
      callback(null, [{
        name: 'sp_demo',
        type: 'PROCEDURE',
        returnType: null,
        deterministic: 0,
        security: 'DEFINER',
        definer: 'root@localhost',
        comment: '',
        createdAt: null,
        updatedAt: null
      }], []);
    }
  };
  const routines = await session.listRoutines('sample');
  assert.equal(routines.length, 1);
  assert.equal(routines[0].type, 'procedure');
  assert.equal(routines[0].deterministic, false);
  assert.match(queries[0], /IS_DETERMINISTIC AS `deterministic`/);
});
