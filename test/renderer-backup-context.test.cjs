'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRenderer } = require('./helpers/renderer.cjs');

function setup(db) {
  const input = { value: 'Renamed' };
  const button = { disabled: false, addEventListener(_event, callback) { this.click = callback; } };
  const elements = new Map([['#renameBackupInput', input], ['#confirmRenameBackupBtn', button]]);
  const r = loadRenderer({ desktop: { db }, elements });
  r.context.closed = 0;
  r.evaluate("modal=()=>{};closeModal=()=>{closed++};refreshBackupList=async()=>{};app.connection={id:'p1'};app.database='demo';app.selectedBackupId='a';app.backups=[{id:'a',name:'A'},{id:'b',name:'B'}]");
  return { ...r, input, button };
}

test('rename captures backup identity and ignores results for a replaced dialog', async () => {
  const calls = [];
  let finish;
  const r = setup({ renameBackup: payload => { calls.push(payload); return new Promise(resolve => { finish = resolve; }); } });
  await r.evaluate("runBackupManagerAction('rename')");
  r.evaluate("app.selectedBackupId='b'");
  const pending = r.button.click();
  assert.equal(calls[0].id, 'a');
  assert.equal(calls[0].profileId, 'p1');
  r.elements.set('#renameBackupInput', { value: 'another dialog' });
  finish({ ok: true, data: {} }); await pending;
  assert.equal(r.context.closed, 0);
});

test('rename and delete refuse a database changed during confirmation', async () => {
  let calls = 0;
  const r = setup({ renameBackup: async () => { calls++; }, deleteBackup: async () => { calls++; } });
  await r.evaluate("runBackupManagerAction('rename')");
  r.evaluate("app.database='other'");
  await r.button.click();
  r.evaluate("app.database='demo';confirmAction=async()=>{app.database='other';return true;}");
  await r.evaluate("runBackupManagerAction('delete')");
  assert.equal(calls, 0);
});

test('delete completion never clears a newly selected database backup', async () => {
  let finish;
  const r = setup({ deleteBackup: () => new Promise(resolve => { finish = resolve; }) });
  r.evaluate('confirmAction=async()=>true');
  const pending = r.evaluate("runBackupManagerAction('delete')");
  await new Promise(resolve => setImmediate(resolve));
  r.evaluate("app.database='other';app.selectedBackupId='new-selection'");
  finish({ ok: true, data: { deleted: true } }); await pending;
  assert.equal(r.evaluate('app.selectedBackupId'), 'new-selection');
});

test('late trial recovery lookup does not replace a newer modal', async () => {
  let finish;
  const r = setup({ listTrialRecovery: () => new Promise(resolve => { finish = resolve; }) });
  let rendered = 0;
  r.context.recordModal = () => { rendered++; };
  r.evaluate('modal=recordModal');
  r.elements.set('#trialRecoveryLoading', { textContent: '' });
  const pending = r.evaluate("runBackupManagerAction('trial-recovery')");
  r.elements.set('#trialRecoveryLoading', null);
  finish({ ok: true, data: [] }); await pending;
  assert.equal(rendered, 1);
});
