'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createScheduleStore, BackupScheduler } = require('../electron/backup-scheduler.cjs');
const { nextScheduledAt, scheduleTiming } = require('../electron/backup-schedule-timing.cjs');
const at = value => Date.parse(value);
const input = { profileId: 'p', database: 'd', mode: 'daily', timeOfDay: '02:00', enabled: true,
  timeZone: 'Asia/Bangkok', target: 'a'.repeat(64) };

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-daily-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, repository: createScheduleStore(dir) };
}

test('daily next run follows timezone, skips DST gaps and explicitly permits both fold instants', () => {
  assert.equal(nextScheduledAt(input, at('2026-11-20T19:00:00Z')), '2026-11-21T19:00:00.000Z');
  const ny = { ...input, timeZone: 'America/New_York', timeOfDay: '02:30' };
  assert.equal(nextScheduledAt(ny, at('2026-03-08T06:00:00Z')), '2026-03-09T06:30:00.000Z');
  const fold = { ...ny, timeOfDay: '01:30' };
  assert.equal(nextScheduledAt(fold, at('2026-11-01T05:00:00Z')), '2026-11-01T05:30:00.000Z');
  assert.equal(nextScheduledAt(fold, at('2026-11-01T05:30:00Z')), '2026-11-01T06:30:00.000Z');
  for (const timeZone of ['', 'x'.repeat(101), 'Invalid/Zone']) {
    assert.throws(() => nextScheduledAt({ ...input, timeZone }, at('2026-11-20T00:00:00Z')));
  }
  for (const change of [{ timeOfDay: '24:00' }, { timeOfDay: '2:00' }, { mode: 'cron' }, { cron: '0 2 * * *' }]) {
    assert.throws(() => scheduleTiming({ ...input, ...change }));
  }
});

test('schedule store retains v1 intervals and writes calendar v2 without changing prior target or history', t => {
  const r = fixture(t), now = at('2026-11-20T00:00:00Z');
  const interval = r.repository.save({ ...input, mode: undefined, timeOfDay: undefined,
    intervalHours: 24, nextRunAt: new Date(now + 3600000).toISOString() }, now);
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.dir, 'backup-schedules.json'), 'utf8')).version, 1);
  const history = { status: 'completed', scheduledFor: '2026-11-19T00:00:00.000Z',
    startedAt: '2026-11-19T00:00:01.000Z', finishedAt: '2026-11-19T00:00:02.000Z',
    taskId: 'scheduled-' + 'b'.repeat(32), backupId: '20261119000000-1234abcd.sql', errorCode: null, warnings: [] };
  r.repository.update(interval.id, interval.revision, value => ({ ...value, lastRun: history }));
  const daily = r.repository.save({ ...input, nextRunAt: nextScheduledAt(input, now) }, now);
  assert.equal(daily.mode, 'daily');
  assert.equal(Object.hasOwn(daily, 'intervalHours'), false);
  assert.equal(daily.target, interval.target);
  assert.deepEqual(daily.lastRun, history);
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.dir, 'backup-schedules.json'), 'utf8')).version, 2);
  assert.deepEqual(createScheduleStore(r.dir).read()[0], daily);
  const file = path.join(r.dir, 'backup-schedules.json');
  for (const version of [1, 99]) {
    const text = JSON.stringify({ version, schedules: [daily] });
    fs.writeFileSync(file, text);
    assert.throws(() => r.repository.read());
    assert.throws(() => r.repository.save({ ...input, nextRunAt: nextScheduledAt(input, now) }, now));
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
});

test('daily claim persists next local run before executing, does not duplicate and skips missed runs after sleep', async t => {
  const r = fixture(t);
  let now = at('2026-11-20T00:00:00Z');
  const next = nextScheduledAt(input, now);
  r.repository.save({ ...input, nextRunAt: next }, now);
  now = at(next);
  let runs = 0;
  const scheduler = new BackupScheduler({ repository: r.repository, now: () => now, isBusy: () => false,
    run: async schedule => {
      runs++;
      assert.equal(r.repository.read()[0].lastRun.status, 'running');
      assert.equal(schedule.nextRunAt, '2026-11-21T19:00:00.000Z');
      return { id: '20261120190000-1234abcd.sql' };
    }
  });
  await scheduler.tick();
  await scheduler.tick();
  assert.equal(runs, 1);
  now = at('2026-11-25T20:00:00Z');
  await scheduler.tick();
  assert.equal(runs, 1);
  assert.equal(r.repository.read()[0].lastRun.status, 'missed');
  assert.equal(r.repository.read()[0].nextRunAt, '2026-11-26T19:00:00.000Z');
});
