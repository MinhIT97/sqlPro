'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRenderer } = require('./helpers/renderer.cjs');

function fixture(disconnect, connect = async id => ({ ok: true, data: { profileId: id, databases: [], openProfiles: [id], server: 'fixture' } })) {
  const calls = [], r = loadRenderer({ desktop: { db: {
    disconnect: (id, options) => { calls.push({ id, options }); return disconnect(id, options); }, connect
  } } });
  r.evaluate(`
    app.connections = [{id:'a', name:'A'}, {id:'b', name:'B'}]; app.connection = app.connections[0];
    app.database = 'db_a'; app.rows = [{id:'a'}];
    for (const id of ['a', 'b']) { openConnectionIds.add(id); connectionViews.set(id, {database:'db_' + id}); }
    invalidateSqlAutocomplete = resetObjectMetadata = setConnectionState = renderSidebar = view = persistState = () => {};
    updateChrome = renderConnectionLoading = setStatus = renderEmptyTable = () => {};
    refreshSessionState = async () => {};
  `);
  return { ...r, calls };
}

const success = () => ({ ok: true, data: { disconnected: true } });

test('late disconnect replies clear only the old cache and preserve the newly selected connection and grid', async () => {
  const reply = Promise.withResolvers(), r = fixture(() => reply.promise);
  const pending = r.evaluate('disconnect()');
  r.evaluate("app.connection = app.connections[1]; app.database='db_b'; app.rows=[{id:'b'}]");
  reply.resolve(success()); await pending;
  assert.equal(r.evaluate('app.connection.id'), 'b');
  assert.equal(r.evaluate('app.database'), 'db_b');
  assert.equal(r.evaluate('app.rows[0].id'), 'b');
  assert.equal(r.evaluate("openConnectionIds.has('a') || connectionViews.has('a')"), false);
  assert.equal(r.evaluate("openConnectionIds.has('b') && connectionViews.has('b')"), true);
});

test('late disconnect errors and confirmation requests cannot affect a different active connection', async () => {
  for (const response of [{ ok: false, error: { message: 'stale failure' } },
    { ok: true, data: { needsConfirmation: true, profileId: 'a' } }]) {
    const reply = Promise.withResolvers(), r = fixture(() => reply.promise);
    r.evaluate("confirmAction = async () => { throw new Error('stale confirmation must not open'); }");
    const pending = r.evaluate('disconnect()');
    r.evaluate('app.connection=app.connections[1]');
    reply.resolve(response); await pending;
    assert.equal(r.calls.length, 1);
    assert.equal(r.evaluate('app.connection.id'), 'b');
    assert.deepEqual(r.messages, []);
  }
});

test('disconnect confirmation is cancelled or abandoned when the active connection changes before acceptance', async () => {
  for (const change of ['cancel', 'switch']) {
    const confirmation = Promise.withResolvers(), entered = Promise.withResolvers();
    const r = fixture(async () => ({ ok: true, data: { needsConfirmation: true, profileId: 'a', sessionId: 'observed', transactionRevision: 4 } }));
    r.context.confirmFixture = () => { entered.resolve(); return confirmation.promise; };
    r.evaluate('confirmAction=confirmFixture');
    const pending = r.evaluate('disconnect()'); await entered.promise;
    if (change === 'switch') r.evaluate('app.connection=app.connections[1]');
    confirmation.resolve(change === 'switch'); await pending;
    assert.equal(r.calls.length, 1);
    assert.equal(r.evaluate('app.connection.id'), change === 'switch' ? 'b' : 'a');
  }
});

test('accepted disconnect uses the captured target and successful completion clears that current view', async () => {
  const r = fixture(async (_id, options) => options?.force ? success()
    : { ok: true, data: { needsConfirmation: true, profileId: 'a', sessionId: 'observed', transactionRevision: 4 } });
  r.evaluate('confirmAction=async()=>true');
  await r.evaluate('disconnect()');
  assert.equal(r.calls.length, 2);
  assert.equal(r.calls[0].id, 'a'); assert.equal(r.calls[0].options, undefined);
  assert.equal(r.calls[1].id, 'a'); assert.equal(r.calls[1].options.force, true);
  assert.equal(r.calls[1].options.sessionId, 'observed'); assert.equal(r.calls[1].options.transactionRevision, 4);
  assert.equal(r.evaluate('app.connection'), null);
  assert.equal(r.evaluate('app.rows.length'), 0);
});

test('reconnecting the same profile invalidates an older disconnect reply even when the profile object is reused', async () => {
  const reply = Promise.withResolvers(), r = fixture(() => reply.promise);
  const pending = r.evaluate('disconnect()');
  await r.evaluate("connectTo('a', {silent:true})");
  r.evaluate("app.rows=[{id:'fresh'}]; openConnectionIds.add('a'); connectionViews.set('a', {fresh:true})");
  reply.resolve(success()); await pending;
  assert.equal(r.evaluate('app.connection.id'), 'a');
  assert.equal(r.evaluate('app.rows[0].id'), 'fresh');
  assert.equal(r.evaluate("connectionViews.get('a').fresh && openConnectionIds.has('a')"), true);
});

test('disconnect during a connection attempt ignores both late success and late failure from that attempt', async () => {
  for (const late of [{ ok: true, data: { databases: [], openProfiles: ['b'], server: 'late' } },
    { ok: false, error: { message: 'late connect failure' } }]) {
    const reply = Promise.withResolvers(), entered = Promise.withResolvers();
    const r = fixture(async () => success(), () => { entered.resolve(); return reply.promise; });
    r.evaluate("openConnectionIds.delete('b'); connectionViews.delete('b')");
    const connecting = r.evaluate("connectTo('b', {silent:true})"); await entered.promise;
    await r.evaluate('disconnect()'); reply.resolve(late); await connecting;
    assert.equal(r.evaluate('app.connection'), null);
    assert.equal(r.evaluate('connectionSwitching'), false);
    assert.deepEqual(r.messages, []);
  }
});

test('an unbound renderer never disconnects the main process active session by fallback', async () => {
  const r = fixture(async () => success());
  r.evaluate('app.connection=null'); await r.evaluate('disconnect()');
  assert.deepEqual(r.calls, []);
});

test('a cached profile requiring a fresh connection keeps switching single-flight while loading the database', async () => {
  const entered = Promise.withResolvers(), loaded = Promise.withResolvers(), connects = [];
  const r = fixture(async () => success(), async id => {
    connects.push(id);
    return { ok: true, data: { profileId: id, databases: ['db_a'], openProfiles: [id], reused: false } };
  });
  r.context.selectFixture = () => { entered.resolve(); return loaded.promise; };
  r.evaluate('app.connection=app.connections[1]; selectDatabase=selectFixture');
  const pending = r.evaluate("connectTo('a', {database:'db_a', silent:true})"); await entered.promise;
  assert.equal(r.evaluate('connectionSwitching'), true);
  await r.evaluate("connectTo('b', {silent:true})"); assert.deepEqual(connects, ['a']);
  loaded.resolve(); await pending;
  assert.equal(r.evaluate('connectionSwitching'), false);
  assert.equal(r.evaluate('app.connection.id'), 'a');
});

test('missing disconnect context or a rejected stale approval preserves the current connection', async () => {
  for (const missing of [true, false]) {
    const r = fixture(async (_id, options) => options?.force
      ? { ok: false, error: { code: 'DISCONNECT_CONTEXT_CHANGED', message: 'Changed session' } }
      : { ok: true, data: { needsConfirmation: true, ...(missing ? {} : { sessionId: 'observed', transactionRevision: 1 }) } });
    r.evaluate('confirmAction=async()=>true'); await r.evaluate('disconnect()');
    assert.equal(r.evaluate('app.connection.id'), 'a');
    assert.equal(r.evaluate('app.rows[0].id'), 'a');
    assert.equal(r.calls.length, missing ? 1 : 2);
    assert.equal(r.messages.length, 1);
  }
});
