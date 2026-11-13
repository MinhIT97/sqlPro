'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRenderer } = require('./helpers/renderer.cjs');

function fixture() {
  const events = new Map(), queued = [], buttons = new Map();
  const button = name => ({ addEventListener: (type, fn) => buttons.set(`${name}:${type}`, fn) });
  const dialog = {
    open: false, innerHTML: '', className: '',
    showModal() { this.open = true; },
    close() { this.open = false; queued.push(() => { for (const fn of [...(events.get('close') || [])]) fn(); }); },
    addEventListener(type, fn) { const list = events.get(type) || new Set(); list.add(fn); events.set(type, list); },
    removeEventListener(type, fn) { events.get(type)?.delete(fn); }
  };
  const elements = new Map([['#modal', dialog], ['#confirmOk', button('ok')], ['#confirmCancel', button('cancel')]]);
  const r = loadRenderer({ elements });
  return { ...r, dialog, closeListenerCount: () => events.get('close')?.size || 0,
    flushClose: () => { while (queued.length) queued.shift()(); }, click: name => buttons.get(`${name}:click`)() };
}

test('a queued close from the previous modal must not cancel a reopened confirmation', async () => {
  const r = fixture();
  r.evaluate("modal('<p>Earlier form</p>');closeModal()");
  let settled = false;
  const pending = r.evaluate("confirmAction('Delete?', 'Delete this row?', 'Delete')");
  pending.then(() => { settled = true; });
  r.flushClose(); await Promise.resolve();
  assert.equal(r.dialog.open, true); assert.equal(settled, false);
  r.click('ok'); assert.equal(await pending, true); assert.equal(r.dialog.open, false);
  r.flushClose();
});

test('closing or canceling the current confirmation still rejects the write request', async () => {
  for (const action of ['close', 'cancel']) {
    const r = fixture(), pending = r.evaluate("confirmAction('Delete?', 'Delete this row?')");
    if (action === 'close') { r.dialog.close(); r.flushClose(); }
    else r.click('cancel');
    assert.equal(await pending, false); assert.equal(r.dialog.open, false);
    assert.equal(r.closeListenerCount(), 0);
  }
});
