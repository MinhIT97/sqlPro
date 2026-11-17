'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Preferences = require('../table-preferences.js');
const { createTablePreferences } = require('../electron/table-preferences.cjs');
const { loadRenderer } = require('./helpers/renderer.cjs');
const columns = [{ name: 'id', type: 'bigint', key: 'PRI' }, { name: 'name', type: 'varchar(255)' }];
const scope = { profileId: 'profile', database: 'db', table: 'users' };
const filterTree = { version: 1, op: 'AND', items: [{ column: 'id', operator: 'between', value: ['9007199254740992', '9007199254740993'] },
  { op: 'OR', items: [{ column: 'name', operator: 'eq', value: '' }, { column: 'name', operator: 'prefix', value: ' sensitive_% ' }] }] };
const state = { visibleColumns: ['name'], sorts: [{ column: 'name', direction: 'DESC' }], search: ' secret ', searchColumn: 'name', searchMode: 'contains', filterTree };
const copy = value => JSON.parse(JSON.stringify(value));

test('view capture excludes all filter values by default; opt-in round trips exact typed trees', () => {
  const plain = Preferences.capture(state, columns);
  assert.equal(plain.filters, null);
  assert.doesNotMatch(JSON.stringify(plain), /sensitive|secret|900719925474099/);
  assert.equal(Preferences.capture({ ...state, filterTree: 'malformed' }, columns).filters, null);
  const saved = Preferences.capture(state, columns, true);
  assert.equal(saved.filters.search, 'secret');
  assert.deepEqual(saved.filters.filterTree, filterTree);
  assert.deepEqual(Preferences.normalize(copy(saved), columns), saved);
  assert.ok(Object.isFrozen(saved.filters.filterTree.items[1].items[0]));
  assert.deepEqual(state.filterTree, filterTree);
});

test('preferences fail as a whole for metadata drift, inherited/unknown fields and invalid filters', () => {
  const saved = Preferences.capture(state, columns, true);
  for (const drift of [columns.slice(1), [...columns].reverse(), columns.map(c => ({ ...c, type: 'text' })), [...columns, { name: 'new', type: 'int' }]]) {
    assert.throws(() => Preferences.normalize(saved, drift), /Cấu trúc bảng/);
  }
  const bad = [Object.create(saved), { ...saved, version: 2 }, { ...saved, rawSql: 'DROP TABLE t' }, { ...saved, visibleColumns: [] },
    { ...saved, visibleColumns: ['missing'] }, { ...saved, visibleColumns: ['name', 'name'] }, { ...saved, visibleColumns: Array(1) },
    { ...saved, columns: Array(1) }, { ...saved, sorts: [{ column: 'Name', direction: 'ASC' }] },
    ...[{ search: 'x'.repeat(201) }, { search: '  ' }, { searchColumn: 'missing' }, { searchMode: 'raw' },
      { searchMode: 'is-null', search: 'ignored' }, { filterTree: { version: 1, op: 'OR', items: [] } },
      { filterTree: { version: 1, op: 'AND', items: Array(1) } },
      { filterTree: { version: 1, op: 'AND', items: [{ column: 'id', operator: 'between', value: Array(2) }] } }]
      .map(change => ({ ...saved, filters: { ...saved.filters, ...change } }))];
  for (const input of bad) assert.throws(() => Preferences.normalize(input));
  assert.throws(() => Preferences.scope(Object.create(scope)));
  assert.throws(() => Preferences.scope({ ...scope, table: '../x\0' }));
});

test('disk repository persists exact tuple/case scopes, opt-out overwrite removes values, and clear leaves other scopes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-table-preferences-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = createTablePreferences(root);
  assert.equal(repository.read(scope), null);
  const scopes = [scope, { ...scope, database: 'DB' }, { profileId: 'profile.db', database: 'users', table: 'x' },
    { profileId: 'profile', database: 'db.users', table: 'x' }, { ...scope, table: '__proto__' }, { ...scope, table: '../../outside' }];
  scopes.forEach(target => repository.save(target, Preferences.capture(state, columns, true)));
  assert.equal(fs.readdirSync(path.join(root, 'table-preferences')).length, scopes.length);
  assert.deepEqual(createTablePreferences(root).read(scope).view.filters.filterTree, filterTree);
  repository.save(scope, Preferences.capture(state, columns));
  assert.equal(repository.read(scope).view.filters, null);
  const files = fs.readdirSync(path.join(root, 'table-preferences'));
  const file = files.map(name => path.join(root, 'table-preferences', name)).find(file => JSON.parse(fs.readFileSync(file)).scope.database === 'db' && JSON.parse(fs.readFileSync(file)).scope.table === 'users');
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /sensitive|secret|900719925474099/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  repository.remove(scope);
  assert.equal(repository.read(scope), null);
  assert.ok(repository.read(scopes[1]));
  assert.equal(fs.readdirSync(path.join(root, 'table-preferences')).some(name => name.endsWith('.part')), false);
  const wide = Array.from({ length: 1024 }, (_, index) => ({ name: `column_${index}`, type: `varchar(255)${' '.repeat(480)}` }));
  assert.throws(() => repository.save(scope, Preferences.capture({}, wide)), /128 KiB/);
  assert.equal(repository.read(scope), null);
  assert.throws(() => Preferences.capture({}, [...wide, { name: 'extra', type: 'int' }]), /giới hạn/);
});

test('corrupt, future, mismatched, oversized and symlink files are preserved on read/save/remove', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-table-preferences-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = createTablePreferences(root), saved = Preferences.capture(state, columns);
  repository.save(scope, saved);
  const file = path.join(root, 'table-preferences', fs.readdirSync(path.join(root, 'table-preferences'))[0]);
  const original = JSON.parse(fs.readFileSync(file));
  for (const content of ['{invalid', JSON.stringify({ ...original, version: 2 }), JSON.stringify({ ...original, scope: { ...scope, table: 'other' } }), ' '.repeat(128 * 1024 + 1)]) {
    fs.writeFileSync(file, content);
    for (const operation of [() => repository.read(scope), () => repository.save(scope, saved), () => repository.remove(scope)]) assert.throws(operation);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
  }
  fs.rmSync(file);
  const target = path.join(root, 'preserve.json'); fs.writeFileSync(target, JSON.stringify(original)); fs.symlinkSync(target, file);
  assert.throws(() => repository.save(scope, saved)); assert.throws(() => repository.remove(scope));
  assert.ok(fs.lstatSync(file).isSymbolicLink());
});

test('renderer only applies filters when present and resets all paging state without touching row snapshots', () => {
  const renderer = loadRenderer();
  renderer.evaluate("app.rows=[{id:1,name:'kept'}];app.search='active';app.filterTree={active:true};app.page=9;app.pageCursor={old:true};app.nextCursor={};app.previousCursor={};app.total=99");
  renderer.context.preference = Preferences.capture(state, columns);
  renderer.evaluate('applyTablePreference(preference)');
  assert.equal(renderer.evaluate("app.search==='active' && app.filterTree.active && app.rows[0].id===1 && app.page===1 && app.pageCursor===null && app.nextCursor===null && app.previousCursor===null && app.total===null"), true);
  renderer.context.preference = Preferences.capture(state, columns, true);
  renderer.evaluate('applyTablePreference(preference)');
  assert.equal(renderer.evaluate("app.search==='secret' && app.filterTree.version===1 && app.orderBy===null && app.sorts[0].direction==='DESC'"), true);
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.ok(html.indexOf('src="table-preferences.js"') > html.indexOf('src="table-view.js"'));
  assert.ok(html.indexOf('src="table-preferences.js"') < html.indexOf('src="app.js"'));
  assert.ok(require('../package.json').build.files.includes('table-preferences.js'));
});
