'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRenderer } = require('./helpers/renderer.cjs');

function setup(preview, overrides = {}) {
  const elements = new Map();
  for (const selector of ['#backupRetentionEditor', '#backupRetentionResult', '#previewRetentionBtn', '#retentionCount', '#retentionAge', '#retentionMiB', '#backupRetentionPolicyStatus', '#saveRetentionPolicyBtn', '#clearRetentionPolicyBtn', '#applyRetentionBtn', '#stopRetentionBtn', '#retentionTaskStatus']) {
    elements.set(selector, { value: '', validity: { valid: true }, innerHTML: '', textContent: '', disabled: false,
      listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; }, focus() { this.focused = true; } });
  }
  const r = loadRenderer({ desktop: { db: { previewBackupRetention: preview,
    getBackupRetentionPolicy: async () => ({ ok: true, data: { policy: null } }), ...overrides } }, elements });
  r.evaluate("modal=()=>{};app.connection={id:'p1',name:'Example'};app.database='demo';previewBackupRetention()");
  return { ...r, get: selector => elements.get(selector), submit: () => elements.get('#previewRetentionBtn').listeners.click() };
}

const response = { ok: true, data: { removeCount: 1, totalCount: 2, remainingCount: 1, removeBytes: 100, remainingBytes: 100,
  plannedAt: '2026-11-12T00:00:00Z', warnings: [], rows: [{ name: '<img src=x>', bytes: 100, action: 'remove', reasons: ['age'], protectedReasons: [] }] } };

test('renderer sends limits against captured target and escapes backup names', async () => {
  const calls = [];
  const r = setup(async payload => { calls.push(payload); return response; });
  r.get('#retentionCount').value = '2'; r.get('#retentionMiB').value = '3';
  await r.submit();
  assert.equal(JSON.stringify(calls[0]), JSON.stringify({ profileId: 'p1', database: 'demo', policy: { maxCount: 2, maxAgeDays: null, maxBytes: 3145728 } }));
  assert.match(r.get('#backupRetentionResult').innerHTML, /&lt;img src=x&gt;/);
  assert.equal(r.get('#previewRetentionBtn').disabled, false);
});

test('apply uses only the issued token, consumes the visible plan and invalidates it on edits', async () => {
  const calls = [];
  const r = setup(async () => ({ ok: true, data: { ...response.data, token: 'one-use' } }), {
    applyBackupRetention: async payload => { calls.push(payload); return { ok: true, data: { canceled: true } }; }
  });
  await new Promise(resolve => setImmediate(resolve));
  r.get('#retentionCount').value = '1';
  await r.submit();
  assert.equal(r.get('#applyRetentionBtn').disabled, false);
  await r.get('#applyRetentionBtn').listeners.click();
  assert.equal(calls[0].profileId, 'p1'); assert.equal(calls[0].database, 'demo'); assert.equal(calls[0].token, 'one-use');
  assert.match(calls[0].taskId, /^retention-/);
  assert.match(r.get('#backupRetentionResult').innerHTML, /Đã hủy/);
  await r.get('#applyRetentionBtn').listeners.click();
  assert.equal(calls.length, 1);
  await r.submit();
  r.get('#retentionCount').listeners.input();
  assert.equal(r.get('#applyRetentionBtn').disabled, true);
  await r.get('#applyRetentionBtn').listeners.click();
  assert.equal(calls.length, 1);
});

test('late policy load cannot enable policy writes while cleanup is waiting or running', async () => {
  let load, finish, saves = 0;
  const r = setup(async () => ({ ok: true, data: { ...response.data, token: 'one-use' } }), {
    getBackupRetentionPolicy: () => new Promise(resolve => { load = resolve; }),
    applyBackupRetention: () => new Promise(resolve => { finish = resolve; }),
    saveBackupRetentionPolicy: async () => { saves++; return { ok: true, data: { policy: null } }; }
  });
  r.get('#retentionCount').value = '1'; await r.submit();
  const pending = r.get('#applyRetentionBtn').listeners.click();
  load({ ok: true, data: { policy: { maxCount: 3, maxAgeDays: null, maxBytes: null } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(r.get('#saveRetentionPolicyBtn').disabled, true);
  assert.equal(r.get('#clearRetentionPolicyBtn').disabled, true);
  await r.get('#saveRetentionPolicyBtn').listeners.click();
  assert.equal(saves, 0);
  finish({ ok: true, data: { canceled: true } }); await pending;
  assert.equal(r.get('#saveRetentionPolicyBtn').disabled, false);
  assert.equal(r.get('#clearRetentionPolicyBtn').disabled, false);
});

test('retention UI polls once per cycle and stops the captured task without touching later dialogs', async () => {
  let finish;
  const requests = [], canceled = [], timers = [];
  const r = setup(async () => ({ ok: true, data: { ...response.data, token: 'one-use' } }), {
    applyBackupRetention: () => new Promise(resolve => { finish = resolve; }),
    backupRetentionStatus: async payload => { requests.push(payload); return { ok: true, data: {
      running: true, phase: 'hashing', bytesRead: 64, totalBytes: 128, deleted: 0, total: 1, reclaimedBytes: 0
    } }; },
    cancelTask: async (profileId, taskId) => { canceled.push({ profileId, taskId }); return { ok: true, data: { canceled: true } }; }
  });
  r.context.setTimeout = fn => { timers.push(fn); return timers.length; };
  await new Promise(resolve => setImmediate(resolve));
  r.get('#retentionCount').value = '1'; await r.submit();
  const pending = r.get('#applyRetentionBtn').listeners.click();
  await timers.shift()();
  assert.match(r.get('#retentionTaskStatus').textContent, /Đang xác minh/);
  assert.equal(r.get('#stopRetentionBtn').disabled, false);
  await r.get('#stopRetentionBtn').listeners.click();
  assert.equal(canceled[0].profileId, 'p1');
  assert.equal(canceled[0].taskId, requests[0].taskId);
  r.elements.set('#backupRetentionResult', { textContent: 'new dialog' });
  const count = requests.length;
  await timers.shift()();
  assert.equal(requests.length, count);
  finish({ ok: true, data: { stopped: true, deleted: [], remaining: ['old'], failed: [], reclaimedBytes: 0 } });
  await pending;
  assert.equal(r.get('#backupRetentionResult').textContent, 'new dialog');
});

test('saved policy loads exact byte limits, saves captured target and clears without deleting backups', async () => {
  const calls = [];
  const policy = { maxCount: 7, maxAgeDays: null, maxBytes: 1048577 };
  const r = setup(async () => response, {
    getBackupRetentionPolicy: async () => ({ ok: true, data: { policy } }),
    saveBackupRetentionPolicy: async payload => { calls.push(payload); return { ok: true, data: { policy: payload.policy } }; },
    clearBackupRetentionPolicy: async payload => { calls.push(payload); return { ok: true, data: { policy: null } }; }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(Number(r.get('#retentionCount').value), 7);
  assert.equal(Number(r.get('#retentionMiB').value) * 1048576, 1048577);
  await r.get('#saveRetentionPolicyBtn').listeners.click();
  assert.equal(JSON.stringify(calls[0]), JSON.stringify({ profileId: 'p1', database: 'demo', policy }));
  await r.get('#clearRetentionPolicyBtn').listeners.click();
  assert.equal(calls[1].database, 'demo');
  assert.equal(r.get('#retentionCount').value, '10');
  assert.match(r.get('#backupRetentionPolicyStatus').textContent, /Backup được giữ nguyên/);
});

test('late policy load preserves edited draft, and save failure preserves fields', async () => {
  let finish;
  const r = setup(async () => response, {
    getBackupRetentionPolicy: () => new Promise(resolve => { finish = resolve; }),
    saveBackupRetentionPolicy: async () => ({ ok: false, error: { code: 'ENOSPC', message: 'disk full' } })
  });
  r.get('#retentionCount').value = '99';
  r.get('#retentionCount').listeners.input();
  finish({ ok: true, data: { policy: { maxCount: 2, maxAgeDays: null, maxBytes: null } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(r.get('#retentionCount').value, '99');
  await r.get('#saveRetentionPolicyBtn').listeners.click();
  assert.match(r.get('#backupRetentionPolicyStatus').textContent, /disk full/);
  assert.equal(r.get('#retentionCount').value, '99');
  assert.equal(r.get('#retentionCount').disabled, false);
});

test('renderer invalidates in-flight plans after editing limits or replacing context', async () => {
  for (const change of ['input', 'database', 'dialog']) {
    let finish;
    const r = setup(() => new Promise(resolve => { finish = resolve; }));
    r.get('#retentionCount').value = '2';
    const pending = r.submit();
    assert.equal(r.get('#previewRetentionBtn').disabled, true);
    if (change === 'input') r.get('#retentionCount').listeners.input();
    if (change === 'database') r.evaluate("app.database='other'");
    if (change === 'dialog') r.elements.set('#backupRetentionResult', {});
    finish(response); await pending;
    assert.equal(r.get('#backupRetentionEditor').innerHTML, '');
    if (change !== 'dialog') assert.equal(r.get('#backupRetentionResult').innerHTML, '');
  }
});

test('renderer rejects invalid input and target changes before IPC', async () => {
  let calls = 0;
  const r = setup(async () => { calls++; return response; });
  r.get('#retentionCount').validity.valid = false;
  await r.submit();
  assert.match(r.get('#backupRetentionResult').textContent, /số nguyên dương/);
  assert.equal(calls, 0);
  r.get('#retentionCount').validity.valid = true;
  r.evaluate("app.database='other'");
  await r.submit();
  assert.match(r.get('#backupRetentionResult').textContent, /đã thay đổi/);
  assert.equal(calls, 0);
});

test('retention history escapes records and rejects late results after switching databases', async () => {
  for (const stale of [false, true]) {
    let finish;
    const output = { innerHTML: '', textContent: '' };
    const elements = new Map([['#retentionHistoryResult', output]]);
    const r = loadRenderer({ desktop: { db: { backupRetentionHistory: () => new Promise(resolve => { finish = resolve; }) } }, elements });
    r.evaluate("modal=()=>{};app.connection={id:'p1'};app.database='demo'");
    const pending = r.evaluate('showBackupRetentionHistory()');
    if (stale) r.evaluate("app.database='other'");
    finish({ ok: true, data: [{ startedAt: '2026-11-12T00:00:00Z', finishedAt: null, state: 'incomplete',
      planned: ['<img>'], deleted: [], remaining: ['<img>'], failed: [], policy: { maxCount: 1, maxAgeDays: null, maxBytes: null }, reclaimedBytes: 0 }] });
    await pending;
    if (stale) assert.equal(output.innerHTML, '');
    else {
      assert.match(output.innerHTML, /Chưa xác nhận kết thúc/);
      assert.match(output.innerHTML, /&lt;img&gt;/);
      assert.doesNotMatch(output.innerHTML, /<img>/);
    }
  }
});
