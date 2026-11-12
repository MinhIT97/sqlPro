'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSession } = require('../electron/database.cjs');

test('explicit cleanup timeout is passed to the driver without changing ordinary raw SQL', async () => {
  const session = new DatabaseSession({});
  const commands = [];
  session.connection = {query(command,params,done) {commands.push(command);done(null,{serverStatus:2},[]);}};
  await session.raw('SELECT 1');
  await session.raw('SELECT token FROM temporary_owner',[],15000);
  assert.equal(commands[0],'SELECT 1');
  assert.deepEqual(commands[1],{sql:'SELECT token FROM temporary_owner',timeout:15000});
});

test('server status tracks observed transaction start, completion and autocommit without guessing', () => {
  const session = new DatabaseSession({});
  session.updateServerStatus({serverStatus:3});
  assert.equal(session.inTransaction, true);
  assert.equal(session.autocommit, true);
  assert.ok(Number.isFinite(Date.parse(session.transactionObservedAt)));
  const revision = session.transactionRevision;
  const observed = session.transactionObservedAt;
  session.updateServerStatus({serverStatus:3});
  assert.equal(session.transactionRevision, revision);
  assert.equal(session.transactionObservedAt, observed);
  session.updateServerStatus({});
  assert.equal(session.inTransaction, true);
  session.updateServerStatus({serverStatus:0});
  assert.equal(session.inTransaction, false);
  assert.equal(session.autocommit, false);
  assert.equal(session.transactionObservedAt, null);
  assert.ok(session.transactionRevision > revision);
});

test('a command inside the same transaction invalidates a previous confirmation revision', async () => {
  const session = new DatabaseSession({});
  session.connection = {query(_sql, _params, done) {done(null, {serverStatus:3}, []);}};
  session.updateServerStatus({serverStatus:3});
  const revision = session.transactionRevision;
  await session.raw('SELECT 1');
  assert.ok(session.transactionRevision > revision);
  assert.equal(session.inTransaction, true);
});
