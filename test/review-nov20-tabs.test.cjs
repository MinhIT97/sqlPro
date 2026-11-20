'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadRenderer } = require('./helpers/renderer.cjs');

function fixture() {
  const elements = new Map([
    ['#sql', { value: 'SELECT active_draft' }],
    ['#savedQueryName', { value: 'Saved draft' }],
    ['#savedQueryGo', { addEventListener(_name, fn) { this.click = fn; } }]
  ]);
  const r = loadRenderer({ elements, desktop: { saveState: async () => ({}) } });
  r.evaluate(`
    app.connection = {id:'sidebar'}; app.database = 'sidebar_db'; mode = 'query';
    queryTabs = [
      {id:1,title:'One',sql:'SELECT one',profileId:'p1',database:'d1'},
      {id:2,title:'Two',sql:'SELECT two',profileId:'p2',database:'d2'},
      {id:3,title:'Three',sql:'SELECT three',profileId:'p3',database:'d3',running:true},
      {id:4,title:'Four',sql:'SELECT four',profileId:'p4',database:'d4',running:true}
    ]; activeQuery = 1; app.query = queryTabs[1];
    updateChrome = () => {}; renderSidebar = () => {};
    renderQueryView = () => { $('#sql').value = app.query.sql; };
    modal = () => {}; closeModal = () => {};
    renderQueryTabs = () => {};
  `);
  return r;
}

test('bulk close others keeps editor, result and target on the selected tab before persistence', () => {
  const r = fixture();
  r.evaluate('closeOtherQueryTabs(0)');
  assert.equal(r.elements.get('#sql').value, 'SELECT one');
  assert.equal(r.evaluate('app.query.sql'), 'SELECT one');
  assert.equal(r.evaluate('app.query.profileId'), 'p1');
  assert.equal(r.evaluate('app.query.database'), 'd1');
  assert.equal(r.evaluate('queryTabs.map(t=>t.id).join()'), '1,3,4');
});

test('close right retains an active running tab by identity as indexes shift', () => {
  const r = fixture();
  r.evaluate("activeQuery=2;app.query=queryTabs[2];$('#sql').value='SELECT running_draft';closeQueryTabsToRight(0)");
  assert.equal(r.evaluate('app.query.id'), 3);
  assert.equal(r.evaluate('activeQuery'), 1);
  assert.equal(r.evaluate('app.query.sql'), 'SELECT running_draft');
  assert.equal(r.evaluate('queryTabs[2].sql'), 'SELECT four');
});

test('closing right of an earlier tab renders the fallback without copying the removed editor', () => {
  const r = fixture();
  r.evaluate('closeQueryTabsToRight(0)');
  assert.equal(r.evaluate('app.query.id'), 1);
  assert.equal(r.evaluate('app.query.sql'), 'SELECT one');
  assert.equal(r.elements.get('#sql').value, 'SELECT one');
});

test('saving a query during tab switch keeps SQL, saved identity and database bound to original tab', () => {
  const r = fixture();
  r.evaluate('saveQuery(); activeQuery=0;app.query=queryTabs[0];');
  r.elements.get('#savedQueryGo').click();
  assert.equal(r.evaluate('savedQueries[0].profileId'), 'p2');
  assert.equal(r.evaluate('savedQueries[0].database'), 'd2');
  assert.equal(r.evaluate('savedQueries[0].sql'), 'SELECT active_draft');
  assert.equal(r.evaluate('queryTabs[0].savedQueryId || null'), null);
  assert.equal(r.evaluate('queryTabs[1].savedQueryId'), r.evaluate('savedQueries[0].id'));
  assert.equal(r.evaluate('queryTabs[0].title'), 'One');
});

test('opening a saved query at the tab limit cannot relabel the existing tab or attach its save identity', () => {
  const r = fixture();
  r.evaluate("savedQueries=[{id:'saved',name:'Other query',sql:'SELECT other',profileId:'other',database:'other'}];while(queryTabs.length<50)queryTabs.push({id:queryTabs.length+1,title:'Extra',sql:''});openSavedQuery('saved')");
  assert.equal(r.evaluate('app.query.title'), 'Two');
  assert.equal(r.evaluate('app.query.savedQueryId || null'), null);
  assert.equal(r.evaluate('queryTabs.length'), 50);
});

test('desktop beforeunload persists the same complete scoped workspace as normal autosave', () => {
  const r = fixture();
  const saved = [], listeners = new Map();
  r.context.window.addEventListener = (name, fn) => listeners.set(name, fn);
  Object.assign(r.context.window.sqlProDesktop, {
    saveState: async state => saved.push(state), onMenuCommand() {}, getMetadata: async () => ({version:'test'})
  });
  r.context.document.body = { classList: { add() {} } };
  r.evaluate("savedQueries=[{id:'saved',name:'Keep',sql:'SELECT 5'}];snippets=[{id:'snippet',sql:'SELECT 6'}];app.maskData=true");
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../desktop.js'), 'utf8'), r.context);
  listeners.get('beforeunload')();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].queryTabs[1].profileId, 'p2');
  assert.equal(saved[0].queryTabs[1].database, 'd2');
  assert.equal(saved[0].queryTabs[1].sql, 'SELECT active_draft');
  assert.equal(saved[0].savedQueries[0].id, 'saved');
  assert.equal(saved[0].snippets[0].id, 'snippet');
  assert.equal(saved[0].maskData, true);
});


test('restored missing or explicit-null targets stay unbound instead of inheriting the sidebar', () => {
  const r = fixture();
  for (const expression of ["{}", "{profileId:null,database:null}", "{profileId:7,database:7}"]) {
    const tab = r.evaluate(`restoreQueryTab(${expression}, 0)`);
    assert.equal(tab.profileId, null); assert.equal(tab.database, null);
  }
  const tab = r.evaluate("restoreQueryTab({title:'Query 99999999999999999999999999999999999999',sql:'SELECT 1',profileId:'p',database:'Exact_DB'}, 2)");
  assert.equal(tab.profileId, 'p'); assert.equal(tab.database, 'Exact_DB'); assert.equal(tab.id, 3);
});

test('explicit Save waits for disk acknowledgement, retains the form on failure, and retries without duplicate entries', async () => {
  const r = fixture(); let succeed = false;
  r.context.window.sqlProDesktop.saveState = async () => {
    if (!succeed) throw new Error('Disk full fixture');
    return { saved: true };
  };
  r.evaluate('saveQuery()');
  await r.elements.get('#savedQueryGo').click();
  assert.equal(r.evaluate('savedQueries.length'), 1);
  assert.equal(r.messages.some(m => m.message === 'Đã lưu truy vấn trên máy.'), false);
  assert.ok(r.messages.some(m => m.message.includes('Chưa lưu được trạng thái')));
  succeed = true;
  await r.elements.get('#savedQueryGo').click();
  assert.equal(r.evaluate('savedQueries.length'), 1);
  assert.equal(r.messages.at(-1).message, 'Đã lưu truy vấn trên máy.');
});

test('late save acknowledgement cannot close a replacement modal or rename another tab', async () => {
  const r = fixture(); let complete;
  r.context.window.sqlProDesktop.saveState = () => new Promise(resolve => { complete = resolve; });
  r.evaluate('saveQuery(); closeModal = () => { throw new Error("Must not close the next dialog"); }');
  const pending = r.elements.get('#savedQueryGo').click();
  r.evaluate('modalRevision += 1; activeQuery=0;app.query=queryTabs[0]');
  complete({ saved: true }); await pending;
  assert.equal(r.evaluate('app.query.title'), 'One');
  assert.equal(r.messages.some(m => m.message === 'Đã lưu truy vấn trên máy.'), false);
});
