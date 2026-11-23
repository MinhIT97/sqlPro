'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { loadRenderer } = require('./helpers/renderer.cjs');

function fixture(t) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-connections-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const root = path.join(__dirname, '../electron'), handlers = new Map(), closed = [];
  const app = { requestSingleInstanceLock: () => true, on() {}, whenReady: () => new Promise(() => {}), getPath: () => userData };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'store.cjs'), 'utf8'), {
    module, Buffer, require: id => id === 'electron' ? { app, safeStorage: { isEncryptionAvailable: () => false } }
      : require(id.startsWith('./') ? path.join(root, id) : id)
  });
  const store = module.exports;
  const input = { name: 'fixture', host: 'fixture.example', importKey: 'fixture', password: 'original' };
  const id = store.importMany([input]).connections[0].id;
  const unrelated = store.save({ name: 'unrelated', host: 'unrelated.example' }).id;
  const controls = { connections: [{ ...input, name: 'updated', password: 'replacement' }], canceled: false, duringDialog() {} };
  let syncs = 0;
  const context = vm.createContext({
    require(id) {
      if (id === 'electron') return { app, ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
        dialog: { showOpenDialog: async () => { controls.duringDialog(); return { canceled: controls.canceled, filePaths: ['fixture.ncx'] }; } } };
      if (id === './store.cjs') return store;
      if (id === './sync.cjs') return { schedule: () => { syncs++; } };
      if (id === './navicat.cjs') return { parseNavicatFile: () => ({ connections: controls.connections, skipped: 0 }) };
      return require(id.startsWith('./') ? path.join(root, id) : id);
    }, __dirname: root, process, Buffer, console, setTimeout, clearTimeout, AbortController
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'main.cjs'), 'utf8'), context);
  const evaluate = code => vm.runInContext(code, context), registry = evaluate('sessionRegistry');
  function attach(profileId, state = {}) {
    const entry = { profileId, sessionId: crypto.randomUUID(), session: { autocommit: true, inTransaction: false,
      close: async () => { closed.push(profileId); }, ...state } };
    registry.entries.set(profileId, entry);
    return entry;
  }
  return { id, unrelated, store, controls, registry, closed, attach, evaluate, syncs: () => syncs,
    contents: () => fs.readFileSync(path.join(userData, 'connections.json'), 'utf8'),
    call: (name, payload, options) => handlers.get(name)({ sender: null }, payload, options) };
}

test('connection update/delete/import reject transactions and busy targets before writing or closing', async t => {
  for (const operation of ['connections:save', 'connections:remove', 'connections:import-navicat']) {
    for (const condition of ['transaction', 'autocommit', 'task', 'lease', 'opening', 'transfer', 'exclusive', 'production']) {
      const r = fixture(t), entry = r.attach(r.id);
      if (condition === 'transaction') entry.session.inTransaction = true;
      if (condition === 'autocommit') entry.session.autocommit = false;
      if (condition === 'task') entry.session.activeTask = { id: 'fixture-task' };
      if (condition === 'lease') r.registry.acquire(entry);
      if (condition === 'opening') r.registry.opening.set(r.id, Promise.resolve());
      if (condition === 'transfer') r.evaluate(`activeDatabaseTransfer = { profileId: '${r.id}' }`);
      if (condition === 'exclusive') entry.exclusiveOperation = true;
      if (condition === 'production') entry.productionWriteInProgress = true;
      const before = r.contents();
      const payload = operation === 'connections:save' ? { id: r.id, host: 'changed.example' } : r.id;
      const result = await r.call(operation, payload);
      assert.equal(result.ok, false, `${operation}/${condition}`);
      assert.equal(result.error.code, ['transaction', 'autocommit'].includes(condition) ? 'PROFILE_TRANSACTION_OPEN' : 'SESSION_BUSY');
      assert.equal(r.contents(), before);
      assert.deepEqual(r.closed, []);
      assert.equal(r.syncs(), 0);
    }
  }
});

test('Navicat checks transaction state after the file dialog and leaves the entire batch unchanged', async t => {
  const r = fixture(t), entry = r.attach(r.id), before = r.contents();
  r.controls.connections.unshift({ name: 'new', host: 'new.example', importKey: 'new' });
  r.controls.duringDialog = () => { entry.session.inTransaction = true; };
  const result = await r.call('connections:import-navicat', 'ws-personal');
  assert.equal(result.error.code, 'PROFILE_TRANSACTION_OPEN');
  assert.equal(r.contents(), before);
  assert.deepEqual(r.closed, []);
});

test('Navicat updates only its own idle session and retains unrelated transactions', async t => {
  const r = fixture(t);
  r.attach(r.id);
  const other = r.attach(r.unrelated, { inTransaction: true, autocommit: false });
  const result = await r.call('connections:import-navicat', 'ws-personal');
  assert.equal(result.ok, true);
  assert.equal(result.data.updated, 1);
  assert.deepEqual([...result.data.closedProfileIds], [r.id]);
  assert.deepEqual(r.closed, [r.id]);
  assert.equal(r.registry.entries.get(r.unrelated), other);
  assert.equal(r.store.getWithSecrets(r.id).password, 'replacement');
  assert.equal(r.syncs(), 1);
});

test('a busy second Navicat target blocks the entire batch without closing the first idle target', async t => {
  const r = fixture(t);
  r.store.save({ id: r.unrelated, host: 'other.example', importKey: 'second' });
  r.attach(r.id);
  r.attach(r.unrelated, { inTransaction: true });
  r.controls.connections.push({ name: 'second', host: 'other.example', importKey: 'second', password: 'replacement' });
  const before = r.contents();
  const result = await r.call('connections:import-navicat');
  assert.equal(result.error.code, 'PROFILE_TRANSACTION_OPEN');
  assert.equal(r.contents(), before);
  assert.deepEqual(r.closed, []);
  assert.equal(r.syncs(), 0);
});

test('Navicat additions/cancel never close sessions and failed profile writes retain idle sessions', async t => {
  const r = fixture(t);
  r.attach(r.id, { inTransaction: true });
  r.controls.connections = [{ name: 'new', host: 'new.example', importKey: 'new' }];
  assert.equal((await r.call('connections:import-navicat')).data.added, 1);
  assert.deepEqual(r.closed, []);
  const before = r.contents();
  r.controls.canceled = true;
  assert.equal((await r.call('connections:import-navicat')).data.canceled, true);
  assert.equal(r.contents(), before);
  r.controls.canceled = false;
  r.registry.entries.get(r.id).session.inTransaction = false;
  r.store.remove = () => { throw new Error('fixture write failed'); };
  assert.equal((await r.call('connections:remove', r.id)).ok, false);
  assert.equal(r.contents(), before);
  assert.deepEqual(r.closed, []);
});

test('removing an idle profile invalidates it before waiting for session disposal', async t => {
  const r = fixture(t), disposed = Promise.withResolvers(), entered = Promise.withResolvers();
  r.attach(r.id, { close: () => { entered.resolve(); return disposed.promise; } });
  const pending = r.call('connections:remove', r.id);
  await entered.promise;
  assert.equal(r.registry.entries.has(r.id), false);
  assert.throws(() => r.store.getWithSecrets(r.id));
  disposed.resolve();
  assert.equal((await pending).data.removed, true);
});

test('renderer Navicat import clears only updated profile caches and disconnects only an updated active profile', async () => {
  for (const activeId of ['updated', 'unrelated']) {
    const events = [];
    const r = loadRenderer({ desktop: { connections: { importNavicat: async () => ({ ok: true,
      data: { canceled: false, updated: 1, sessionsClosed: true, closedProfileIds: ['updated'] } }) } } });
    r.context.events = events;
    r.context.activeId = activeId;
    r.evaluate(`
      app.connection = { id: activeId };
      for (const id of ['updated', 'unrelated']) { openConnectionIds.add(id); connectionViews.set(id, {}); }
      disconnect = async () => { events.push('disconnect'); };
      refreshWorkspaces = refreshConnections = async () => {};
      renderSidebar = () => {};
    `);
    await r.evaluate('importNavicat()');
    assert.deepEqual(events, activeId === 'updated' ? ['disconnect'] : []);
    assert.equal(r.evaluate("openConnectionIds.has('updated') || connectionViews.has('updated')"), false);
    assert.equal(r.evaluate("openConnectionIds.has('unrelated') && connectionViews.has('unrelated')"), true);
  }
});

test('disconnect approval is bound to the exact session and transaction revision and cannot close a replacement', async t => {
  for (const change of ['replace', 'revision', 'missing', 'busy', 'lease', 'closed']) {
    const r = fixture(t), old = r.attach(r.id, { inTransaction: true, autocommit: false, transactionRevision: 2 });
    const review = (await r.call('db:disconnect', r.id)).data;
    assert.equal(review.needsConfirmation, true); assert.equal(review.sessionId, old.sessionId);
    assert.equal(review.transactionRevision, 2); assert.deepEqual(r.closed, []);
    let target = old;
    if (change === 'replace') target = r.attach(r.id, { inTransaction: true, autocommit: false, transactionRevision: 2 });
    if (change === 'revision') old.session.transactionRevision = 3;
    if (change === 'busy') old.session.activeTask = { id: 'new-task' };
    if (change === 'lease') r.registry.acquire(old);
    if (change === 'closed') r.registry.entries.delete(r.id);
    const options = change === 'missing' ? { force: true } : { force: true, sessionId: review.sessionId, transactionRevision: review.transactionRevision };
    const result = await r.call('db:disconnect', r.id, options);
    assert.equal(result.ok, false, change);
    assert.equal(result.error.code, ['busy', 'lease'].includes(change) ? 'SESSION_BUSY' : 'DISCONNECT_CONTEXT_CHANGED');
    assert.deepEqual(r.closed, [], change);
    if (change !== 'closed') assert.equal(r.registry.entries.get(r.id), target);
  }
});

test('confirmed disconnect closes only the observed transaction; autocommit OFF also requires confirmation', async t => {
  const r = fixture(t), entry = r.attach(r.id, { inTransaction: false, autocommit: false });
  const review = (await r.call('db:disconnect', r.id)).data;
  assert.equal(review.needsConfirmation, true); assert.equal(review.sessionId, entry.sessionId);
  const result = await r.call('db:disconnect', r.id, { force: true, sessionId: review.sessionId, transactionRevision: review.transactionRevision });
  assert.equal(result.data.disconnected, true); assert.deepEqual(r.closed, [r.id]);
  assert.equal((await r.call('db:disconnect', r.id, { force: true, sessionId: review.sessionId, transactionRevision: review.transactionRevision })).error.code, 'DISCONNECT_CONTEXT_CHANGED');
});

test('real renderer-to-main disconnect protocol rejects drift during confirmation and closes only a fresh approval', async t => {
  for (const change of ['replace','revision','unchanged']) {
    const main = fixture(t), original = main.attach(main.id, { inTransaction: true, autocommit: false, transactionRevision: 2 });
    const entered = Promise.withResolvers(), confirmation = Promise.withResolvers();
    const r = loadRenderer({ desktop: { db: { disconnect: (id, options) => main.call('db:disconnect', id, options) } } });
    r.context.targetId = main.id;
    r.context.confirmFixture = () => { entered.resolve(); return confirmation.promise; };
    r.evaluate(`app.connection={id:targetId};app.rows=[{id:'retained'}];confirmAction=confirmFixture;
      invalidateSqlAutocomplete=resetObjectMetadata=setConnectionState=renderSidebar=view=persistState=()=>{};`);
    const pending = r.evaluate('disconnect()'); await entered.promise;
    let replacement;
    if (change === 'replace') replacement = main.attach(main.id, { inTransaction: true, autocommit: false, transactionRevision: 2 });
    if (change === 'revision') original.session.transactionRevision++;
    confirmation.resolve(true); await pending;
    if (change === 'unchanged') {
      assert.deepEqual(main.closed, [main.id]); assert.equal(r.evaluate('app.connection'), null);
    } else {
      assert.deepEqual(main.closed, []); assert.equal(r.evaluate('app.connection.id'), main.id);
      assert.equal(r.evaluate('app.rows[0].id'), 'retained'); assert.equal(r.messages[0].type, 'error');
      assert.equal(main.registry.entries.get(main.id), replacement || original);
    }
  }
});
