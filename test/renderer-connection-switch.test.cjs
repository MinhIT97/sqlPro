'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRenderer } = require('./helpers/renderer.cjs');

test('đổi kết nối nhớ database/bảng và giữ dấu hiệu các phiên đang mở', async () => {
  const selected = [];
  const r = loadRenderer({ desktop: { db: { connect: async (id) => ({ ok: true, data: {
    profileId: id, server: '8.0', databases: ['one'], openProfiles: ['a', 'b']
  } }) } } });
  r.context.selected = selected;
  r.evaluate(`
    app.connections = [{ id:'a', name:'A', type:'mysql', database:'one' },
      { id:'b', name:'B', type:'mysql', database:'one' }];
    app.connection = app.connections[0]; app.database='one'; table='items'; mode='data';
    renderSidebar=()=>{}; view=()=>{}; updateChrome=()=>{}; renderConnectionLoading=()=>{};
    setConnectionState=()=>{}; setStatus=()=>{};
    selectDatabase=async(database, options)=>selected.push({database, table:options.table});
    persistState=()=>{};
  `);
  await r.evaluate("connectTo('b', { silent:true })");
  await r.evaluate("connectTo('a', { silent:true })");
  assert.equal(selected.at(-1).table, 'items');
  assert.equal(r.evaluate("openConnectionIds.has('a') && openConnectionIds.has('b')"), true);
});

test('quay lại phiên đang mở khôi phục bảng ngay và không hiện đang kết nối', async () => {
  const events = [];
  const r = loadRenderer({ desktop: { db: { connect: async (id) => ({ ok: true, data: {
    profileId: id, server: '8.0', databases: ['one'], openProfiles: ['a', 'b'], reused: id === 'a'
  } }) } } });
  r.context.events = events;
  r.evaluate(`
    app.connections = [{ id:'a', name:'A', type:'mysql', database:'one' },
      { id:'b', name:'B', type:'mysql', database:'one' }];
    app.connection=app.connections[0]; app.database='one'; app.databases=['one'];
    app.columns=[{name:'id'}]; app.rows=[{id:1}]; app.tables=[{name:'items',type:'table'}];
    table='items'; mode='data'; openConnectionIds.add('a');
    renderSidebar=()=>{}; view=()=>{}; updateChrome=()=>{}; renderConnectionLoading=()=>{};
    renderDataView=()=>events.push('cached grid');
    setConnectionState=(state)=>events.push(state);
    setStatus=()=>{}; selectDatabase=async()=>{}; persistState=()=>{};
  `);
  await r.evaluate("connectTo('b', { silent:true })");
  events.length = 0;
  await r.evaluate("connectTo('a', { silent:true })");
  assert.deepEqual(events, ['connected', 'cached grid']);
  assert.equal(r.evaluate("app.database === 'one' && table === 'items' && app.rows[0].id === 1"), true);
});

test('kết nối mới hiện loading trong lúc chờ máy chủ', async () => {
  let finishConnect;
  const workspace = { innerHTML: '' };
  const r = loadRenderer({
    elements: new Map([['#workspace', workspace]]),
    desktop: { db: { connect: () => new Promise((resolve) => { finishConnect = resolve; }) } }
  });
  r.evaluate(`
    app.connections = [{ id:'slow', name:'Máy chủ chậm', type:'mysql' }];
    renderSidebar=()=>{}; updateChrome=()=>{}; setConnectionState=()=>{};
    setStatus=()=>{}; view=()=>{}; selectDatabase=async()=>{}; persistState=()=>{};
  `);
  const connecting = r.evaluate("connectTo('slow', { silent:true })");
  assert.match(workspace.innerHTML, /connection-loading-spinner/);
  assert.match(workspace.innerHTML, /Đang kết nối Máy chủ chậm/);
  finishConnect({ ok: true, data: { server:'8.0', databases:[], openProfiles:['slow'] } });
  await connecting;
});
