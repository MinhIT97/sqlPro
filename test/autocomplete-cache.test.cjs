'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createColumnCache, rankSuggestions } = require('../sql-autocomplete.js');
const { loadRenderer } = require('./helpers/renderer.cjs');

const identity = table => ['profile', 'demo', table];
const columns = (name = 'id') => [{ name, type: 'int', defaultValue: 'private', comment: 'private' }];

test('column cache coalesces reads, projects immutable name/type only and retains exact tuple identities', async () => {
  const cache = createColumnCache(); let reads = 0;
  const read = async () => { reads++; return columns(); };
  const first = cache.load(identity('Items'), read);
  assert.equal(cache.load(identity('Items'), read), first);
  const value = await first;
  assert.deepEqual(value, [{ name: 'id', type: 'int' }]); assert.ok(Object.isFrozen(value)); assert.ok(Object.isFrozen(value[0]));
  assert.equal(await cache.load(identity('Items'), read), value); assert.equal(reads, 1);
  await cache.load(identity('items'), read);
  await cache.load(['profile', 'a.b', 'c'], read); await cache.load(['profile', 'a', 'b.c'], read);
  await cache.load(['other-profile', 'demo', 'Items'], read);
  assert.equal(reads, 5); assert.equal(cache.stats().entries, 5);
  assert.doesNotMatch(JSON.stringify(value), /private/);
});

test('column cache expires 60 seconds after completion, does not extend TTL on hits and invalidates backwards clocks', async () => {
  let time = 1000, finish, reads = 0;
  const cache = createColumnCache({ now: () => time });
  const pending = cache.load(identity('a'), () => new Promise(resolve => { finish = resolve; reads++; }));
  await Promise.resolve(); time = 5000; finish(columns()); await pending;
  time = 64999; await cache.load(identity('a'), async () => { throw Error('unexpected hit'); }); assert.equal(reads, 1);
  time = 65000; await cache.load(identity('a'), async () => { reads++; return columns('new'); }); assert.equal(reads, 2);
  time = 500; await cache.load(identity('a'), async () => { reads++; return columns('back'); }); assert.equal(reads, 3);
});

test('invalidation before a deferred reader starts prevents that metadata request', async () => {
  const cache = createColumnCache(); let reads = 0;
  const pending = cache.load(identity('a'), async () => { reads++; return columns(); });
  cache.clear(); assert.deepEqual(await pending, []); assert.equal(reads, 0); assert.equal(cache.stats().inFlight, 0);
});

test('column cache bounds entries with LRU eviction and accounts for the total retained character budget', async () => {
  const cache = createColumnCache(); let reloads = 0;
  for (let i = 0; i < 64; i++) await cache.load(identity(`t${i}`), async () => columns());
  await cache.load(identity('t0'), async () => { throw Error('must hit'); });
  await cache.load(identity('t64'), async () => columns()); assert.equal(cache.stats().entries, 64);
  await cache.load(identity('t1'), async () => { reloads++; return columns(); }); assert.equal(reloads, 1);
  cache.clear();
  const large = Array.from({ length: 110 }, (_, i) => ({ name: `col_${i}`, type: 'x'.repeat(512) }));
  for (let i = 0; i < 20; i++) {
    assert.equal((await cache.load(identity(`large_${i}`), async () => large)).length, 110);
    assert.ok(cache.stats().characters <= 262144);
  }
  assert.ok(cache.stats().entries <= 4); cache.clear(); assert.deepEqual(cache.stats(), { entries: 0, characters: 0, inFlight: 0 });
});

test('malformed/oversized metadata, invalid identities and rejected readers do not become cached evidence or auto retry', async () => {
  const cache = createColumnCache(); let reads = 0;
  const invalid = [null, [], {}, columns('\0'), columns('x'.repeat(65)), [{ name: 'id', type: 'x'.repeat(513) }],
    [{ name: 'id', type: 4 }], [...columns(), ...columns()], Array.from({ length: 1025 }, (_, i) => ({ name: `c${i}` })),
    Array.from({ length: 130 }, (_, i) => ({ name: `c${i}`, type: 'x'.repeat(512) }))];
  for (const value of invalid) {
    assert.deepEqual(await cache.load(identity('bad'), async () => { reads++; return value; }), []);
    assert.equal(cache.stats().entries, 0);
  }
  await cache.load(identity('bad'), () => { reads++; throw Error('private failure'); });
  assert.equal(reads, invalid.length + 1); assert.equal(cache.stats().inFlight, 0);
  for (const key of [[], ['p', 'db'], ['p', 'db', '\0'], ['p', 'x'.repeat(65), 't'], [null, 'db', 't']]) {
    assert.deepEqual(await cache.load(key, () => { throw Error('not called'); }), []);
  }
  assert.equal((await cache.load(identity('bad'), async () => columns('recovered')))[0].name, 'recovered');
});

test('clearing drops late successes/rejections without deleting a newer same-key read and keeps all old reads within the admission cap', async () => {
  const cache = createColumnCache(); let finish, rejectOld, finishNew;
  const old = cache.load(identity('same'), () => new Promise(resolve => { finish = resolve; }));
  const failed = cache.load(identity('failed'), () => new Promise((_resolve, reject) => { rejectOld = reject; }));
  await Promise.resolve(); cache.clear();
  const next = cache.load(identity('same'), () => new Promise(resolve => { finishNew = resolve; }));
  await Promise.resolve();
  finish(columns('old')); rejectOld(Error('old error')); assert.deepEqual(await old, []); assert.deepEqual(await failed, []);
  assert.equal(cache.load(identity('same'), async () => columns('wrong')), next);
  finishNew(columns('fresh')); assert.equal((await next)[0].name, 'fresh'); assert.equal(cache.stats().entries, 1);
  cache.clear();
  const finishers = [];
  const pending = Array.from({ length: 4 }, (_, i) => cache.load(identity(`busy${i}`), () => new Promise(resolve => { finishers.push(resolve); })));
  await Promise.resolve(); cache.clear();
  let extra = 0;
  for (let i = 0; i < 20; i++) assert.deepEqual(await cache.load(identity(`extra${i}`), async () => { extra++; return columns(); }), []);
  assert.equal(extra, 0); assert.equal(cache.stats().inFlight, 4);
  finishers.forEach(finish => finish(columns())); await Promise.all(pending);
  assert.equal(cache.stats().inFlight, 0); assert.equal(cache.stats().entries, 0);
  assert.equal((await cache.load(identity('admitted'), async () => columns()))[0].name, 'id');
});

test('suggestion ranking keeps identifiers that differ only by case and deduplicates case-insensitive SQL keywords', () => {
  const result = rankSuggestions([
    { type: 'table', insertText: '`Items`', label: 'Items' }, { type: 'table', insertText: '`items`', label: 'items' },
    { type: 'column', insertText: '`Name`', label: 'Name' }, { type: 'column', insertText: '`name`', label: 'name' },
    { type: 'keyword', insertText: 'SELECT', label: 'SELECT' }, { type: 'keyword', insertText: 'select', label: 'select' }
  ], '', 60);
  assert.equal(result.length, 5); assert.deepEqual(result.filter(value => value.type === 'column').map(value => value.label), ['Name', 'name']);
});

test('an old same-key rejection cannot evict or release admission for its replacement', async () => {
  const cache = createColumnCache(); let fail, finish;
  const old = cache.load(identity('same'), () => new Promise((_resolve, reject) => { fail = reject; }));
  await Promise.resolve(); cache.clear();
  const replacement = cache.load(identity('same'), () => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve(); fail(Error('old failure')); assert.deepEqual(await old, []);
  assert.equal(cache.stats().inFlight, 1); assert.equal(cache.load(identity('same'), async () => columns('wrong')), replacement);
  finish(columns('new')); await replacement; assert.equal((await cache.load(identity('same'), async () => []))[0].name, 'new');
});

function renderer(read) {
  const editor = { value: 'SELECT * FROM Items a JOIN items b ON a.id=b.id WHERE ', isConnected: true, selectionStart: 0,
    setAttribute() {}, removeAttribute() {} };
  editor.selectionStart = editor.value.length;
  const calls = [];
  const r = loadRenderer({ desktop: { db: { columns: async (...args) => { calls.push(args); return { ok: true, data: await read(...args) }; } } },
    elements: new Map([['#sql', editor]]) });
  r.evaluate("app.connection={id:'p'};app.database='demo';mode='query';rendered=[];renderSqlSuggestions=(editor,context,items)=>{rendered.push(items)}");
  return { ...r, editor, calls, refresh: () => r.evaluate("refreshSqlSuggestions($('#sql'),true)") };
}

test('renderer projects case-sensitive tables and both self-join aliases, coalescing the same source and preserving captured profile', async () => {
  const r = renderer(async (_db, name) => columns(name === 'Items' ? 'upper_key' : 'lower_key'));
  await r.refresh(); assert.equal(r.calls.length, 2);
  assert.deepEqual(r.calls.map(call => call[1]), ['Items', 'items']);
  assert.match(r.evaluate('JSON.stringify(rendered.at(-1))'), /a.upper_key.*b.lower_key/);
  r.editor.value = 'SELECT * FROM Items a JOIN Items b ON a.id=b.id WHERE '; r.editor.selectionStart = r.editor.value.length;
  await r.refresh(); assert.equal(r.calls.length, 2);
  assert.match(r.evaluate('JSON.stringify(rendered.at(-1))'), /a.upper_key.*b.upper_key/);
  r.evaluate("invalidateSqlAutocomplete();pending=loadAutocompleteColumns('demo','Items');app.connection={id:'other'}");
  await r.evaluate('pending'); assert.equal(r.calls.at(-1)[2], 'p');
});

test('renderer invalidation discards late metadata, keeps the new cache and does not redraw suggestions after caret/target changes', async () => {
  const readers = [];
  const r = renderer(() => new Promise(resolve => { readers.push(resolve); }));
  const pending = r.refresh(); await new Promise(resolve => setImmediate(resolve));
  r.evaluate('invalidateSqlAutocomplete()');
  readers.splice(0).forEach(resolve => resolve(columns('stale'))); await pending;
  assert.equal(r.evaluate('rendered.length'), 1); assert.equal(r.evaluate('sqlAutocomplete.columnCache.stats().entries'), 0);
  const fresh = r.refresh(); await new Promise(resolve => setImmediate(resolve));
  r.editor.selectionStart--;
  readers.splice(0).forEach(resolve => resolve(columns('fresh'))); await fresh;
  assert.equal(r.evaluate('rendered.length'), 2);
  assert.equal(r.evaluate('sqlAutocomplete.columnCache.stats().entries'), 2);
});

test('qualified suggestions prefer exact aliases, reject ambiguity and do not silently resolve a differently cased table', () => {
  const r = loadRenderer(); r.evaluate("app.tables=[{name:'Items'},{name:'items'}]");
  assert.equal(r.evaluate("resolveAutocompleteReference({references:[{table:'Items',alias:'a'}]},'A')"), null);
  assert.equal(r.evaluate("resolveAutocompleteReference({references:[{table:'Items',alias:'a'},{table:'items',alias:'a'}]},'a')"), null);
  assert.equal(r.evaluate("resolveAutocompleteReference({references:[]},'ITEMS')"), null);
  assert.equal(r.evaluate("resolveAutocompleteReference({references:[]},'Items').table"), 'Items');
  assert.equal(r.evaluate("resolveAutocompleteReference({references:[{table:'Items',alias:'a'}]},'Items')"), null);
});

test('refreshing connection profiles invalidates same-ID metadata started before the refresh', async () => {
  const readers = [];
  const r = renderer(() => new Promise(resolve => { readers.push(resolve); }));
  r.context.window.sqlProDesktop.connections = { list: async () => ({ ok: true, data: [{ id: 'p', host: 'new-host' }] }) };
  r.evaluate('ensureDefaultWorkspace=()=>{};renderWorkspaceSwitcher=()=>{};renderSidebar=()=>{}');
  const old = r.evaluate("loadAutocompleteColumns('demo','Items')");
  await new Promise(resolve => setImmediate(resolve));
  await r.evaluate('refreshConnections()'); assert.equal(r.evaluate('app.connection.host'), 'new-host');
  readers.shift()(columns('old-host')); assert.equal((await old).length, 0);
  const next = r.evaluate("loadAutocompleteColumns('demo','Items')");
  await new Promise(resolve => setImmediate(resolve)); readers.shift()(columns('new-host'));
  assert.equal((await next)[0].name, 'new-host'); assert.equal(r.calls.length, 2);
});

test('autocomplete reads the bound tab target and never borrows tables or a missing database/profile from the sidebar', async () => {
  const r = renderer(async () => columns('bound_column'));
  r.evaluate("app.connections=[{id:'bound'}];app.query.profileId='bound';app.query.database='bound_db';app.tables=[{name:'sidebar_only'}]");
  await r.refresh();
  assert.deepEqual(r.calls, [['bound_db', 'Items', 'bound'], ['bound_db', 'items', 'bound']]);
  r.editor.value = 'SELECT * FROM '; r.editor.selectionStart = r.editor.value.length; await r.refresh();
  assert.equal(r.evaluate('rendered.at(-1).some(item=>item.label===\'sidebar_only\')'), false);
  r.evaluate('app.query.database=null');
  r.editor.value = 'SELECT * FROM Items WHERE '; r.editor.selectionStart = r.editor.value.length; await r.refresh();
  assert.equal(r.calls.length, 2);
  r.editor.value = 'SELECT * FROM explicit_db.Items WHERE '; r.editor.selectionStart = r.editor.value.length; await r.refresh();
  assert.deepEqual(r.calls.at(-1), ['explicit_db', 'Items', 'bound']);
  r.evaluate("app.query.profileId='deleted-profile';app.query.database='demo'");
  await r.refresh(); assert.equal(r.calls.length, 3);
});

test('a tab target changed during a metadata read cannot redraw stale columns even when the sidebar stays unchanged', async () => {
  const readers = [];
  const r = renderer(() => new Promise(resolve => { readers.push(resolve); }));
  r.evaluate("app.connections=[{id:'bound'},{id:'other'}];app.query.profileId='bound';app.query.database='one'");
  const pending = r.refresh(); await new Promise(resolve => setImmediate(resolve));
  r.evaluate("app.query.profileId='other';app.query.database='two'");
  readers.splice(0).forEach(resolve => resolve(columns('old-target'))); await pending;
  assert.equal(r.evaluate('rendered.length'), 1);
});
