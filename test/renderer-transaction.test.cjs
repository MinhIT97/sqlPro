'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRenderer } = require('./helpers/renderer.cjs');

function setup(transaction) {
  const host = { innerHTML: '', classList: { toggle() {} } };
  const r = loadRenderer({
    desktop: { db: { transaction } }, elements: new Map([['#transactionBar', host]])
  });
  r.evaluate(`mode='query'; app.connection={id:'other',name:'Other'};
    app.connections=[{id:'target',name:'Target <db>',environment:'production'}];
    app.query.profileId='target'; app.transactionState={profileId:'target',sessionId:'session-one',connected:true,inTransaction:true,autocommit:false,transactionRevision:7};`);
  return { ...r, host };
}

test('transaction UI names the query session and escapes profile names', () => {
  const r = setup();
  r.evaluate('renderTransactionBar()');
  assert.match(r.host.innerHTML, /Target &lt;db&gt;/);
  assert.match(r.host.innerHTML, /PRODUCTION/);
  assert.match(r.host.innerHTML, /dùng chung phiên/);
  assert.doesNotMatch(r.host.innerHTML, /data-transaction-action="commit" disabled/);
  r.evaluate('app.transactionState.busy=true; renderTransactionBar()');
  assert.match(r.host.innerHTML, /data-transaction-action="commit" disabled/);
});

test('confirmation cannot commit a newly selected target', async () => {
  let calls = 0;
  const r = setup(() => { calls += 1; });
  r.evaluate(`confirmAction=async () => {app.query.profileId='other'; return true;}`);
  await r.evaluate("finishTransaction('commit')");
  assert.equal(calls, 0);
});

test('transaction action submits the captured session identity and respects cancellation', async () => {
  const calls = [];
  const r = setup(async (payload) => { calls.push(payload); return {ok:true,data:{}}; });
  r.evaluate('confirmAction=async () => false');
  await r.evaluate("finishTransaction('rollback')");
  assert.equal(calls.length, 0);
  r.evaluate('confirmAction=async () => true');
  await r.evaluate("finishTransaction('rollback')");
  assert.equal(calls[0].profileId, 'target');
  assert.equal(calls[0].sessionId, 'session-one');
  assert.equal(calls[0].transactionRevision, 7);
});

test('environment labels use a fixed allowlist', () => {
  const r = loadRenderer();
  assert.match(r.evaluate("connectionEnvironmentBadge({environment:'production'})"), /environment-production/);
  assert.match(r.evaluate("connectionEnvironmentBadge({environment:'<script>'})"), /CHƯA PHÂN LOẠI/);
  assert.match(r.evaluate("connectionEnvironmentBadge({environment:'__proto__'})"), /environment-unclassified/);
});

test('read-only connection is labeled and commit is disabled while rollback stays available', () => {
  const r = setup();
  r.evaluate('app.connections[0].readOnly=true; renderTransactionBar()');
  assert.match(r.host.innerHTML,/CHỈ ĐỌC/);
  assert.match(r.host.innerHTML,/data-transaction-action="commit" disabled/);
  assert.doesNotMatch(r.host.innerHTML,/data-transaction-action="rollback" disabled/);
});
