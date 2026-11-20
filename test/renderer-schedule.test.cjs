'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRenderer } = require('./helpers/renderer.cjs');
const ok = data => ({ ok: true, data });
const saved = { enabled: true, intervalHours: 12, nextRunAt: '2027-01-01T12:00:00Z', timeZone: 'Asia/Bangkok', targetMatches: true,
  lastRun: { status: 'completed', scheduledFor: '2026-11-12T12:00:00Z', backupId: '<img src=x>', warnings: ['RETENTION_FAILED'] } };

function setup(overrides = {}) {
  const elements = new Map();
  for (const selector of ['#backupScheduleEditor', '#backupScheduleState', '#backupScheduleMessage', '#backupScheduleMode', '#backupScheduleTime', '#backupScheduleZone', '#backupScheduleHours', '#backupScheduleStart', '#saveBackupSchedule', '#pauseBackupSchedule', '#deleteBackupSchedule', '#refreshBackupSchedule']) {
    elements.set(selector, { value: '', innerHTML: '', textContent: '', disabled: false, validity: { valid: true },
      listeners: {}, addEventListener(name, handler) { this.listeners[name] = handler; }, focus() { this.focused = true; } });
  }
  elements.get('#backupScheduleMode').value = 'interval';
  elements.get('#backupScheduleTime').value = '02:00';
  elements.get('#backupScheduleZone').value = 'UTC';
  const calls = [];
  const r = loadRenderer({ elements, desktop: { db: {
    getBackupSchedule: async () => ok({ schedule: saved }),
    saveBackupSchedule: async payload => { calls.push(['save', payload]); return ok({ canceled: true }); },
    pauseBackupSchedule: async payload => { calls.push(['pause', payload]); return ok({ paused: true }); },
    deleteBackupSchedule: async payload => { calls.push(['delete', payload]); return ok({ deleted: true }); }, ...overrides
  } } });
  r.evaluate("modal=()=>{};app.connection={id:'p1'};app.database='demo'");
  const ready = r.evaluate('showBackupSchedule()');
  return { ...r, ready, calls, get: selector => elements.get(selector), click: selector => elements.get(selector).listeners.click() };
}

test('schedule dialog escapes status, captures scope, validates and preserves draft on native Cancel', async () => {
  const r = setup(); await r.ready;
  assert.match(r.get('#backupScheduleState').innerHTML, /&lt;img src=x&gt;/);
  assert.match(r.get('#backupScheduleState').innerHTML, /Tự dọn có lỗi/);
  assert.equal(r.get('#backupScheduleHours').value, '12');
  assert.equal(r.get('#backupScheduleHours').focused, true);
  r.get('#backupScheduleHours').value = '0';
  await r.click('#saveBackupSchedule'); assert.equal(r.calls.length, 0);
  r.get('#backupScheduleHours').value = '8'; r.get('#backupScheduleStart').value = 'invalid';
  await r.click('#saveBackupSchedule'); assert.equal(r.calls.length, 0);
  r.get('#backupScheduleStart').value = '2027-01-01T12:00';
  await r.click('#saveBackupSchedule');
  assert.equal(r.calls[0][1].profileId, 'p1'); assert.equal(r.calls[0][1].database, 'demo');
  assert.equal(r.calls[0][1].intervalHours, 8);
  assert.equal(r.get('#backupScheduleHours').value, '8');
  assert.match(r.get('#backupScheduleMessage').textContent, /Đã hủy lưu/);
  r.evaluate("app.database='other'"); await r.click('#saveBackupSchedule'); assert.equal(r.calls.length, 1);
});

test('schedule mutation is single-flight, pause/delete do not send a backup-delete operation', async () => {
  let finish, saves = 0;
  const r = setup({ saveBackupSchedule: async () => { saves++; return new Promise(resolve => { finish = resolve; }); } });
  await r.ready;
  const pending = r.click('#saveBackupSchedule'); await r.click('#saveBackupSchedule'); await r.click('#deleteBackupSchedule');
  assert.equal(saves, 1); assert.equal(r.calls.length, 0);
  finish(ok({ schedule: saved })); await pending;
  await r.click('#pauseBackupSchedule');
  assert.equal(r.calls[0][0], 'pause'); assert.equal(r.get('#pauseBackupSchedule').disabled, true);
  await r.click('#deleteBackupSchedule');
  assert.equal(r.calls[1][0], 'delete'); assert.match(r.get('#backupScheduleState').textContent, /Chưa có lịch/);
  assert.equal(r.get('#deleteBackupSchedule').disabled, true);
});

test('late schedule load or save cannot modify a replacement dialog', async () => {
  let finish;
  const r = setup({ getBackupSchedule: () => new Promise(resolve => { finish = resolve; }) });
  r.elements.set('#backupScheduleEditor', { innerHTML: 'replacement' });
  finish(ok({ schedule: saved })); await r.ready;
  assert.equal(r.get('#backupScheduleHours').value, '');
  const s = setup({ saveBackupSchedule: () => new Promise(resolve => { finish = resolve; }) });
  await s.ready;
  const pending = s.click('#saveBackupSchedule');
  s.elements.set('#backupScheduleEditor', { innerHTML: 'replacement' });
  s.get('#backupScheduleMessage').textContent = 'keep';
  finish(ok({ schedule: saved })); await pending;
  assert.equal(s.get('#backupScheduleMessage').textContent, 'keep');
});

test('refresh preserves edited inputs and unreadable config locks writes but permits retry', async () => {
  let reads = 0;
  const r = setup({ getBackupSchedule: async () => ++reads === 1 ? { ok: false, error: { message: 'corrupt schedule' } } : ok({ schedule: saved }) });
  await r.ready;
  assert.equal(r.get('#saveBackupSchedule').disabled, true);
  assert.equal(r.get('#refreshBackupSchedule').disabled, false);
  await r.click('#saveBackupSchedule'); assert.equal(r.calls.length, 0);
  r.get('#backupScheduleHours').value = '5';
  await r.click('#refreshBackupSchedule');
  assert.equal(r.get('#backupScheduleHours').value, '5'); assert.equal(r.get('#saveBackupSchedule').disabled, false);
});


test('daily timing sends no interval timestamp and preserves timezone and draft after cancel', async () => {
  const r = setup(); await r.ready;
  r.get('#backupScheduleMode').value = 'daily';
  r.get('#backupScheduleMode').listeners.change();
  r.get('#backupScheduleTime').value = '03:45';
  r.get('#backupScheduleZone').value = 'Invalid/Zone';
  assert.equal(r.get('#backupScheduleHours').disabled, true);
  await r.click('#saveBackupSchedule'); assert.equal(r.calls.length, 0);
  r.get('#backupScheduleZone').value = 'Asia/Bangkok';
  await r.click('#saveBackupSchedule');
  assert.deepEqual(JSON.parse(JSON.stringify(r.calls[0][1])), {
    profileId: 'p1', database: 'demo', mode: 'daily', timeOfDay: '03:45', timeZone: 'Asia/Bangkok'
  });
  assert.equal(r.get('#backupScheduleTime').value, '03:45');
  assert.match(r.get('#backupScheduleMessage').textContent, /Đã hủy lưu/);
});
