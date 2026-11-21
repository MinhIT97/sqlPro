'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRenderer } = require('./helpers/renderer.cjs');

function fixture(stage = null, outcome = 'success') {
  const entered = Promise.withResolvers(), reply = Promise.withResolvers(), calls = [], renders = [];
  let held = false;
  const result = operation => operation === 'tables' ? [{ name: 'items', type: 'table' }]
    : operation === 'backups' ? [{ id: 'backup-a' }]
    : operation === 'tableData' ? { columns: [{name:'id'}], primaryKey: ['id'], rows: [{id:'from-a'}], page: 1, pageSize: 25, total: 1 }
    : operation === 'useDatabase' || operation === 'disconnect' ? { disconnected: true } : [{ name: 'from-a' }];
  const endpoint = operation => async (...args) => {
    const database = operation === 'tableData' ? args[0].database : args[0];
    const profileId = operation === 'tableData' ? args[0].profileId : args.at(-1);
    calls.push({ operation, database, profileId });
    if (!held && operation === stage && database === 'db_a') {
      held = true;
      entered.resolve(); await reply.promise;
      if (outcome === 'error') return { ok: false, error: {message:'stale fixture failure'} };
    }
    return { ok: true, data: result(operation) };
  };
  const db = Object.fromEntries(['useDatabase','tables','listBackups','columns','indexes','relations','tableData','disconnect']
    .map(name => [name, endpoint(name === 'listBackups' ? 'backups' : name)]));
  const r = loadRenderer({ desktop: { db, tablePreferences: { read: async () => ({ ok:true, data:null }) } } });
  r.context.renders = renders;
  r.evaluate(`
    app.connection={id:'a'}; app.database='previous'; mode='data';
    app.rows=[{id:'old'}]; app.tables=[]; app.backups=[];
    invalidateSqlAutocomplete=resetObjectMetadata=renderSidebar=updateChrome=workspaceLoading=setConnectionState=setStatus=refreshSessionState=loadOpenObjectGroups=()=>{};
    renderDataView=()=>renders.push('data'); renderStructureView=()=>renders.push('columns');
    renderIndexesView=()=>renders.push('indexes'); renderRelationsView=()=>renders.push('relations');
    renderEmptyTable=()=>renders.push('empty'); renderError=()=>renders.push('error');
    renderWelcome=renderDatabasePicker=()=>{};
    persistState=()=>renders.push('persist');
  `);
  const mode = stage === 'columns' ? 'structure' : stage === 'indexes' || stage === 'relations' ? stage : 'data';
  return { ...r, entered, reply, calls, renders, select: () => r.evaluate(`selectDatabase('db_a', {table:'items',mode:'${mode}'})`) };
}

test('database selection pins every IPC target and discards stale success/error at every stage including real view/grid helpers', async () => {
  for (const stage of ['useDatabase','tables','backups','tableData','columns','indexes','relations']) {
    for (const outcome of ['success','error']) {
      const r = fixture(stage, outcome), pending = r.select(); await r.entered.promise;
      r.evaluate(`
        app.connection={id:'b'};app.database='db_b';app.rows=[{id:'retained'}];
        app.columns=[{name:'retained'}];app.indexes=[{name:'retained'}];app.relations=[{name:'retained'}];app.backups=[{id:'retained'}];
      `);
      r.reply.resolve(); assert.equal(await pending, false, `${stage}/${outcome}`);
      assert.equal(r.evaluate('app.connection.id'), 'b'); assert.equal(r.evaluate('app.database'), 'db_b');
      assert.equal(r.evaluate('app.rows[0].id'), 'retained');
      assert.equal(r.evaluate('app.columns[0].name'), 'retained'); assert.equal(r.evaluate('app.backups[0].id'), 'retained');
      assert.equal(r.calls.every(call => call.profileId === 'a'), true, stage);
      assert.deepEqual(r.messages, []); assert.deepEqual(r.renders, []);
    }
  }
});

test('a newer database choice wins even for the same profile or the same database name', async () => {
  for (const stage of ['useDatabase','tables','backups','tableData']) {
    for (const selectedDatabase of ['db_new','db_a']) {
    const r = fixture(stage), pending = r.select(); await r.entered.promise;
    assert.equal(await r.evaluate(`selectDatabase('${selectedDatabase}', {table:'items'})`), true);
    const before = r.evaluate('JSON.stringify({database:app.database,rows:app.rows,backups:app.backups,columns:app.columns})');
    const renderCount = r.renders.length;
    r.reply.resolve(); assert.equal(await pending, false);
    assert.equal(r.evaluate('JSON.stringify({database:app.database,rows:app.rows,backups:app.backups,columns:app.columns})'), before);
    assert.equal(r.renders.length, renderCount);
    }
  }
});

test('disconnect or reconnect during database reads cannot restore old table data even at the same profile/database', async () => {
  for (const change of ['disconnect','reconnect']) {
    const r = fixture('tableData'), pending = r.select(); await r.entered.promise;
    if (change === 'disconnect') await r.evaluate('disconnect()');
    else r.evaluate("++connectionNavigationRevision;app.rows=[{id:'fresh'}]");
    const before = r.evaluate('JSON.stringify({connection:app.connection,database:app.database,rows:app.rows})');
    r.reply.resolve(); assert.equal(await pending, false);
    assert.equal(r.evaluate('JSON.stringify({connection:app.connection,database:app.database,rows:app.rows})'), before);
  }
});

test('database selection succeeds through metadata, preferences and grid without stubbing the orchestration helpers', async () => {
  const r = fixture(); assert.equal(await r.select(), true);
  assert.equal(r.evaluate('app.database'), 'db_a'); assert.equal(r.evaluate('app.rows[0].id'), 'from-a');
  assert.equal(r.calls.every(call => call.profileId === 'a'), true);
  assert.equal(r.renders.includes('data'), true); assert.deepEqual(r.messages, []);
});

test('unbound selection cannot fall back to a main-process session', async () => {
  const r = fixture(); r.evaluate('app.connection=null');
  assert.equal(await r.select(), false); assert.deepEqual(r.calls, []);
});
