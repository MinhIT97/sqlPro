'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseCron,
  calculateNextRun,
  evaluateMissedRuns,
  getTimeComponents
} = require('../electron/backup-calendar-calculator.cjs');
const { createScheduleStore, BackupScheduler, scheduleId } = require('../electron/backup-scheduler.cjs');

test('parseCron validates and parses 5-field cron syntax with step and ranges', () => {
  const cron = parseCron('*/15 2-4 1,15 * 1-5');
  assert.deepEqual([...cron.minutes].sort((a, b) => a - b), [0, 15, 30, 45]);
  assert.deepEqual([...cron.hours].sort((a, b) => a - b), [2, 3, 4]);
  assert.deepEqual([...cron.daysOfMonth].sort((a, b) => a - b), [1, 15]);
  assert.equal(cron.months.size, 12);
  assert.deepEqual([...cron.daysOfWeek].sort((a, b) => a - b), [1, 2, 3, 4, 5]);

  // Sunday = 0 and 7 normalizes to 0
  const sundayCron = parseCron('0 0 * * 7');
  assert.ok(sundayCron.daysOfWeek.has(0));

  // Invalid expressions throw INVALID_CRON_EXPRESSION or INVALID_CRON_FIELD
  assert.throws(() => parseCron('0 0 * *'), { code: 'INVALID_CRON_EXPRESSION' });
  assert.throws(() => parseCron('0 0 * * * *'), { code: 'INVALID_CRON_EXPRESSION' });
  assert.throws(() => parseCron('60 * * * *'), { code: 'INVALID_CRON_FIELD' });
  assert.throws(() => parseCron('* 25 * * *'), { code: 'INVALID_CRON_FIELD' });
  assert.throws(() => parseCron('* * 32 * *'), { code: 'INVALID_CRON_FIELD' });
  assert.throws(() => parseCron('* * * 13 *'), { code: 'INVALID_CRON_FIELD' });
  assert.throws(() => parseCron('* * * * 8'), { code: 'INVALID_CRON_FIELD' });
  assert.throws(() => parseCron('5-2 * * * *'), { code: 'INVALID_CRON_FIELD' });
});

test('calculateNextRun advances correctly in specific timezones', () => {
  // At 2026-11-18 10:00:00 UTC, next daily 02:00 in Asia/Bangkok (UTC+7)
  // Asia/Bangkok 02:00 corresponds to 19:00 UTC of previous calendar day
  const baseUtc = new Date('2026-11-18T10:00:00Z');
  const nextBangkok = calculateNextRun('0 2 * * *', baseUtc, 'Asia/Bangkok');
  const parts = getTimeComponents(nextBangkok, 'Asia/Bangkok');
  assert.equal(parts.hour, 2);
  assert.equal(parts.minute, 0);
  assert.equal(parts.year, 2026);
  assert.equal(parts.month, 11);
  assert.equal(parts.day, 19);

  // Invalid timezone throws INVALID_TIMEZONE
  assert.throws(() => calculateNextRun('0 0 * * *', baseUtc, 'Mars/Phobos'), { code: 'INVALID_TIMEZONE' });
});

test('calculateNextRun respects POSIX DOM/DOW OR semantics when neither is wildcard', () => {
  // If both DOM and DOW are specified (neither is *), either matching triggers the schedule
  // 15th of the month OR Friday (dow = 5)
  const base = new Date('2026-11-01T00:00:00Z');
  const next = calculateNextRun('0 12 15 * 5', base, 'UTC');
  const parts = getTimeComponents(next, 'UTC');
  // 2026-11-06 is Friday (comes before Nov 15)
  assert.equal(parts.day, 6);
  assert.equal(parts.dayOfWeek, 5);
});

test('evaluateMissedRuns distinguishes missed vs shouldCatchUp based on grace period', () => {
  const now = Date.now();
  const scheduleRecent = { nextRunAt: new Date(now - 60000).toISOString() }; // 1 min ago
  const resRecent = evaluateMissedRuns(scheduleRecent, null, now, 5 * 60 * 1000);
  assert.equal(resRecent.shouldCatchUp, true);
  assert.equal(resRecent.missed, false);

  const scheduleOld = { nextRunAt: new Date(now - 600000).toISOString() }; // 10 min ago
  const resOld = evaluateMissedRuns(scheduleOld, null, now, 5 * 60 * 1000);
  assert.equal(resOld.shouldCatchUp, false);
  assert.equal(resOld.missed, true);
});

test('calculateNextRun advances accurately across sequence of runs and month boundaries', () => {
  const baseTime = new Date('2026-11-18T10:00:00Z');

  // Next minute 15
  const run1 = calculateNextRun('15 * * * *', baseTime, 'UTC');
  assert.equal(run1.toISOString(), '2026-11-18T10:15:00.000Z');

  // Next after run1
  const run2 = calculateNextRun('15 * * * *', run1, 'UTC');
  assert.equal(run2.toISOString(), '2026-11-18T11:15:00.000Z');

  // End of month rollover (Nov 30 -> Dec 1)
  const endOfNov = new Date('2026-11-30T23:45:00Z');
  const runDec = calculateNextRun('0 0 1 * *', endOfNov, 'UTC');
  assert.equal(runDec.toISOString(), '2026-12-01T00:00:00.000Z');

  // Leap year check (2028-02-28 -> 2028-02-29)
  const feb2028 = new Date('2028-02-28T23:50:00Z');
  const leapRun = calculateNextRun('0 0 29 2 *', feb2028, 'UTC');
  assert.equal(leapRun.toISOString(), '2028-02-29T00:00:00.000Z');
});
