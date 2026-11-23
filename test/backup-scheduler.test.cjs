'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createScheduleStore, BackupScheduler, scheduleId, validateSchedule } = require('../electron/backup-scheduler.cjs');

const HOUR = 3600000;
const BASE = Date.parse('2026-11-12T12:00:00Z');
const ID = '20261112130000-abcdef01.sql';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-schedule-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = createScheduleStore(root);
  const input = { profileId: 'p1', database: 'demo', enabled: true, intervalHours: 24,
    nextRunAt: new Date(BASE + HOUR).toISOString(), timeZone: 'Asia/Bangkok', target: 'a'.repeat(64) };
  const saved = repository.save(input, BASE);
  return { root, repository, input, saved, file: path.join(root, 'backup-schedules.json') };
}

test('schedule store validates, scopes, projects and persists schedules with optimistic revisions', t => {
  const f = fixture(t);
  const reread = createScheduleStore(f.root).read()[0];
  assert.deepEqual(reread, f.saved);
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  const changed = f.repository.save({ ...f.input, password: 'must-not-persist', intervalHours: 12 }, BASE);
  assert.notEqual(changed.revision, f.saved.revision);
  assert.equal(fs.readFileSync(f.file, 'utf8').includes('must-not-persist'), false);
  assert.throws(() => f.repository.update(f.saved.id, f.saved.revision, value => value), /thay đổi/);
  f.repository.save({ ...f.input, database: 'another' }, BASE);
  assert.equal(f.repository.read().length, 2);
  assert.notEqual(scheduleId('p1', 'demo'), scheduleId('p2', 'demo'));
  assert.notEqual(scheduleId('p1', 'demo'), scheduleId('p1', 'Demo'));
  for (const change of [{ intervalHours: 0 }, { intervalHours: 169 }, { intervalHours: 1.5 }, { timeZone: 'invalid/time' }, { enabled: 'yes' }, { target: 'fake' }, { nextRunAt: 'invalid' }]) {
    assert.throws(() => f.repository.save({ ...f.input, ...change }, BASE));
  }
  assert.throws(() => f.repository.save({ ...f.input, nextRunAt: new Date(BASE).toISOString() }, BASE), /tương lai/);
  assert.throws(() => f.repository.save({ ...f.input, nextRunAt: new Date(BASE + 367 * 24 * HOUR).toISOString() }, BASE));
  f.repository.remove(changed.id);
  assert.equal(f.repository.read().length, 1);
});

test('corrupt, unsupported and symlink schedule files are preserved instead of overwritten', t => {
  const f = fixture(t);
  for (const content of ['broken-json', JSON.stringify({ version: 9, schedules: [] }), JSON.stringify({ version: 1, schedules: [f.saved, f.saved] }), 'a'.repeat(256 * 1024 + 1)]) {
    fs.writeFileSync(f.file, content);
    assert.throws(() => f.repository.save(f.input, BASE));
    assert.equal(fs.readFileSync(f.file, 'utf8'), content);
  }
  fs.unlinkSync(f.file);
  const destination = path.join(f.root, 'original.json');
  fs.writeFileSync(destination, 'original');
  try {
    fs.symlinkSync(destination, f.file);
  } catch (err) {
    if (['EPERM', 'ENOTSUP'].includes(err.code)) {
      if (t && t.skip) t.skip('Symlinks unavailable');
      return;
    }
    throw err;
  }
  assert.throws(() => f.repository.read());
  assert.equal(fs.readFileSync(destination, 'utf8'), 'original');
});

test('failed atomic publication preserves previous schedule and cleans temporary files', t => {
  const f = fixture(t);
  const original = fs.readFileSync(f.file, 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '../electron/backup-scheduler.cjs'), 'utf8');
  const context = { module: { exports: {} }, Buffer, require: id => id === 'node:fs' ? { ...fs, renameSync() { throw new Error('publish failure'); } } : require(id.startsWith('./') ? path.join(__dirname, '../electron', id) : id) };
  vm.runInNewContext(source, context);
  assert.throws(() => context.module.exports.createScheduleStore(f.root).save(f.input, BASE), /publish failure/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(f.root), ['backup-schedules.json']);
});

test('schedule limit is enforced without dropping prior entries', t => {
  const f = fixture(t);
  for (let i = 1; i < 50; i++) f.repository.save({ ...f.input, database: `db${i}` }, BASE);
  assert.throws(() => f.repository.save({ ...f.input, database: 'overflow' }, BASE), /50 lịch/);
  assert.equal(f.repository.read().length, 50);
});

test('due run claims persist before execution, is single-flight and records backup warnings separately', async t => {
  const f = fixture(t);
  let now = BASE, runs = 0, finish;
  const scheduler = new BackupScheduler({ repository: f.repository, now: () => now, isBusy: () => false,
    run: async (schedule, taskId) => {
      runs++;
      assert.equal(f.repository.read()[0].lastRun.status, 'running');
      assert.equal(schedule.lastRun.taskId, taskId);
      assert.equal(Date.parse(schedule.nextRunAt), BASE + 25 * HOUR);
      return new Promise(resolve => { finish = resolve; });
    } });
  await scheduler.tick(); assert.equal(runs, 0);
  now = BASE + HOUR;
  const pending = scheduler.tick(); await scheduler.tick(); assert.equal(runs, 1);
  finish({ id: ID, manifestError: 'not persisted raw', retention: { status: 'failed', historySaveError: 'private path' } });
  await pending;
  const run = f.repository.read()[0].lastRun;
  assert.equal(run.status, 'completed'); assert.equal(run.backupId, ID);
  assert.deepEqual(run.warnings, ['MANIFEST_WRITE_FAILED', 'RETENTION_FAILED', 'RETENTION_HISTORY_FAILED']);
  assert.equal(fs.readFileSync(f.file, 'utf8').includes('private path'), false);
  await scheduler.tick(); assert.equal(runs, 1);
});

test('busy admission retries inside grace then marks one missed interval without catch-up', async t => {
  const f = fixture(t);
  let now = BASE + HOUR, busy = true, runs = 0;
  const scheduler = new BackupScheduler({ repository: f.repository, now: () => now, isBusy: () => busy,
    run: async () => { runs++; return { id: ID }; } });
  await scheduler.tick(); assert.equal(f.repository.read()[0].lastRun, null);
  now += 60001;
  await scheduler.tick(); assert.equal(runs, 0);
  assert.equal(f.repository.read()[0].lastRun.status, 'busy');
  now = BASE + 10 * 24 * HOUR + 2 * HOUR; busy = false;
  await scheduler.tick(); assert.equal(runs, 0);
  assert.equal(f.repository.read()[0].lastRun.status, 'missed');
  assert.equal(Date.parse(f.repository.read()[0].nextRunAt), BASE + 11 * 24 * HOUR + HOUR);
  await scheduler.tick(); assert.equal(runs, 0);
});

test('busy task released within grace can run, failures wait for next period and target drift disables schedule', async t => {
  const f = fixture(t);
  let now = BASE + HOUR, busy = true, runs = 0;
  const scheduler = new BackupScheduler({ repository: f.repository, now: () => now, isBusy: () => busy,
    run: async () => { runs++; throw Object.assign(new Error('password must not persist'), { code: 'ECONNREFUSED' }); } });
  await scheduler.tick(); busy = false; now += 30000; await scheduler.tick();
  assert.equal(runs, 1); assert.equal(f.repository.read()[0].lastRun.status, 'failed');
  assert.equal(f.repository.read()[0].lastRun.errorCode, 'ECONNREFUSED');
  assert.equal(fs.readFileSync(f.file, 'utf8').includes('password'), false);
  await scheduler.tick(); assert.equal(runs, 1);
  now = Date.parse(f.repository.read()[0].nextRunAt);
  scheduler.run = async () => { throw Object.assign(new Error('target drift'), { code: 'SCHEDULE_TARGET_CHANGED' }); };
  await scheduler.tick(); assert.equal(f.repository.read()[0].enabled, false);
});

test('recovery marks an interrupted claim incomplete, skips old intervals and never replays it', async t => {
  const f = fixture(t);
  let now = BASE + HOUR, runs = 0;
  const started = Promise.withResolvers();
  const before = new BackupScheduler({ repository: f.repository, now: () => now, isBusy: () => false,
    run: () => { started.resolve(); return new Promise(() => {}); } });
  void before.tick();
  await started.promise;
  assert.equal(f.repository.read()[0].lastRun.status, 'running');
  const restarted = new BackupScheduler({ repository: createScheduleStore(f.root), now: () => now, isBusy: () => false, run: async () => { runs++; return { id: ID }; } });
  restarted.recover(); await restarted.tick();
  assert.equal(f.repository.read()[0].lastRun.status, 'incomplete'); assert.equal(runs, 0);
  now += 24 * HOUR; await restarted.tick(); assert.equal(runs, 1);
});

test('pause and delete while another schedule awaits prevent stale queued work', async t => {
  const f = fixture(t);
  const second = f.repository.save({ ...f.input, database: 'second' }, BASE);
  const third = f.repository.save({ ...f.input, database: 'third' }, BASE);
  let runs = 0;
  const started = Promise.withResolvers(), completion = Promise.withResolvers();
  const scheduler = new BackupScheduler({ repository: f.repository, now: () => BASE + HOUR, isBusy: () => false,
    run: async () => { runs++; started.resolve(); return completion.promise; } });
  const pending = scheduler.tick();
  await started.promise;
  f.repository.update(second.id, second.revision, item => ({ ...item, enabled: false }));
  f.repository.remove(third.id);
  completion.resolve({ canceled: true }); await pending;
  assert.equal(runs, 1); assert.equal(f.repository.read()[0].lastRun.status, 'canceled');
});

test('elapsed intervals remain exact across DST and malformed run state fails closed', async t => {
  const f = fixture(t);
  const saved = f.repository.save({ ...f.input, timeZone: 'America/New_York', nextRunAt: '2027-03-13T14:00:00Z' }, BASE);
  const scheduler = new BackupScheduler({ repository: f.repository, now: () => Date.parse(saved.nextRunAt), isBusy: () => false, run: async () => ({ id: ID }) });
  await scheduler.tick();
  const after = f.repository.read()[0];
  assert.equal(Date.parse(after.nextRunAt) - Date.parse(saved.nextRunAt), 24 * HOUR);
  assert.throws(() => validateSchedule({ ...after, lastRun: { ...after.lastRun, finishedAt: null } }));
});

test('stop and restart while a cycle awaits cannot enqueue stale work or duplicate timers', async t => {
  const f = fixture(t), timers = [];
  const source = fs.readFileSync(path.join(__dirname, '../electron/backup-scheduler.cjs'), 'utf8');
  const context = { module: { exports: {} }, require: id => require(id.startsWith('./') ? path.join(__dirname, '../electron', id) : id), clearTimeout: timer => { if (timer) timer.cleared = true; },
    setTimeout: callback => { const timer = { callback, unref() {} }; timers.push(timer); return timer; } };
  vm.runInNewContext(source, context);
  const started = Promise.withResolvers(), completion = Promise.withResolvers();
  const scheduler = new context.module.exports.BackupScheduler({ repository: f.repository, now: () => BASE + HOUR, isBusy: () => false,
    run: () => { started.resolve(); return completion.promise; } });
  scheduler.start(); const old = timers[0].callback();
  await started.promise;
  scheduler.stop(); scheduler.start();
  completion.resolve({ canceled: true }); await old;
  assert.equal(timers.length, 2);
  await timers[1].callback(); assert.equal(timers.length, 3);
  scheduler.stop(); assert.equal(timers[2].cleared, true);
});

test('failed result persistence pauses scheduler and preserves incomplete evidence instead of claiming backup failed', async t => {
  const f = fixture(t);
  let updates = 0, runs = 0;
  const repository = { ...f.repository, update(...args) {
    if (++updates === 2) throw new Error('disk full');
    return f.repository.update(...args);
  } };
  const scheduler = new BackupScheduler({ repository, now: () => BASE + HOUR, isBusy: () => false,
    run: async () => { runs++; return { id: ID }; } });
  await scheduler.tick();
  assert.equal(scheduler.stopped, true); assert.equal(scheduler.error, 'disk full');
  assert.equal(f.repository.read()[0].lastRun.status, 'running');
  await scheduler.tick(); assert.equal(runs, 1);
  scheduler.recover(); assert.equal(f.repository.read()[0].lastRun.status, 'incomplete');
});

test('clock moving backward while another backup awaits does not run queued work early', async t => {
  const f = fixture(t);
  f.repository.save({ ...f.input, database: 'second' }, BASE);
  let now = BASE + HOUR, runs = 0;
  const scheduler = new BackupScheduler({ repository: f.repository, now: () => now, isBusy: () => false,
    run: async () => { runs++; now = BASE; return { id: ID }; } });
  await scheduler.tick();
  assert.equal(runs, 1); assert.equal(f.repository.read()[1].lastRun, null);
});

test('busy admission after calendar calculation keeps the due slot inside grace and runs when released', async t => {
  const f = fixture(t), entered = Promise.withResolvers(), calculated = Promise.withResolvers();
  let busy = false, now = BASE + HOUR, runs = 0;
  const scheduler = new BackupScheduler({ repository: f.repository, now: () => now, isBusy: () => busy,
    nextRun: () => { entered.resolve(); return calculated.promise; },
    run: async () => { assert.equal(busy, false); runs++; return { id: ID }; } });
  const pending = scheduler.tick(); await entered.promise;
  busy = true; now += 60000; calculated.resolve(new Date(BASE + 25 * HOUR).toISOString());
  await pending;
  assert.equal(runs, 0); assert.equal(f.repository.read()[0].lastRun, null);
  assert.equal(f.repository.read()[0].nextRunAt, f.saved.nextRunAt);
  busy = false; await scheduler.tick();
  assert.equal(runs, 1); assert.equal(f.repository.read()[0].lastRun.status, 'completed');
  assert.equal(f.repository.read()[0].lastRun.startedAt, new Date(now).toISOString());
});

test('calendar calculation rechecks grace expiry and backwards clocks before any claim or backup', async t => {
  for (const outcome of ['missed', 'busy', 'backwards', 'next-run-elapsed']) {
    const f = fixture(t), entered = Promise.withResolvers(), calculated = Promise.withResolvers();
    let now = BASE + HOUR, busy = false, runs = 0;
    const scheduler = new BackupScheduler({ repository: f.repository, now: () => now, isBusy: () => busy,
      nextRun: () => { entered.resolve(); return calculated.promise; }, run: async () => { runs++; return { id: ID }; } });
    const pending = scheduler.tick(); await entered.promise;
    now = outcome === 'backwards' ? BASE : outcome === 'next-run-elapsed' ? BASE + 25 * HOUR : now + 60001;
    busy = outcome === 'busy'; calculated.resolve(new Date(BASE + 25 * HOUR).toISOString()); await pending;
    const after = f.repository.read()[0];
    assert.equal(runs, 0, outcome);
    if (['missed', 'busy'].includes(outcome)) {
      assert.equal(after.lastRun.status, outcome);
      assert.equal(after.lastRun.startedAt, new Date(now).toISOString());
    } else {
      assert.equal(after.lastRun, null);
      assert.equal(after.nextRunAt, f.saved.nextRunAt);
    }
  }
});

test('pause, deletion, revision changes and stop during calendar calculation cannot claim a stale slot', async t => {
  for (const change of ['pause', 'delete', 'edit', 'stop']) {
    const f = fixture(t), entered = Promise.withResolvers(), calculated = Promise.withResolvers();
    let runs = 0;
    const scheduler = new BackupScheduler({ repository: f.repository, now: () => BASE + HOUR, isBusy: () => false,
      nextRun: () => { entered.resolve(); return calculated.promise; }, run: async () => { runs++; return { id: ID }; } });
    const pending = scheduler.tick(); await entered.promise;
    if (change === 'pause') f.repository.update(f.saved.id, f.saved.revision, item => ({ ...item, enabled: false }));
    if (change === 'delete') f.repository.remove(f.saved.id);
    if (change === 'edit') f.repository.save({ ...f.input, intervalHours: 12 }, BASE);
    if (change === 'stop') scheduler.stop();
    calculated.resolve(new Date(BASE + 25 * HOUR).toISOString()); await pending;
    assert.equal(runs, 0, change);
    assert.equal(f.repository.read()[0]?.lastRun || null, null);
  }
});
