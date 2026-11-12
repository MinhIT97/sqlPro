'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { planBackupRetention, normalizeRetentionPolicy } = require('../electron/backup-retention.cjs');

const now = Date.parse('2026-11-12T12:00:00Z');
function entry(id, age, extra = {}) {
  return { id, name: id, bytes: 100, createdAt: new Date(now - age * 86400000).toISOString(),
    verification: { fileWritten: true, checksum: 'verified' }, ...extra };
}
const plan = (entries, policy, extra = {}) => planBackupRetention(entries, policy, { now, ...extra });

test('retention validates boundaries and never interprets empty or zero as delete everything', () => {
  for (const policy of [null, [], {}, { maxCount: 0 }, { maxCount: '2' }, { maxCount: 1.5 }, { maxAgeDays: -1 },
    { maxAgeDays: 36501 }, { maxBytes: Infinity }, { maxCount: 100001 }, { deleteAll: true }]) assert.throws(() => normalizeRetentionPolicy(policy));
  assert.deepEqual(normalizeRetentionPolicy({ maxCount: 1 }), { maxCount: 1, maxAgeDays: null, maxBytes: null });
  assert.equal(plan([], { maxCount: 1 }).removeCount, 0);
  assert.throws(() => plan([entry('same', 1), entry('same', 2)], { maxCount: 1 }));
  assert.throws(() => plan([entry('x', 1, { bytes: Number.MAX_SAFE_INTEGER }), entry('y', 2)], { maxCount: 1 }));
});

test('preview is deterministic, immutable and protects newest and latest verified even above quota', () => {
  const entries = [entry('old', 20), entry('recent-good', 3), entry('newest', 0, { verification: { checksum: 'unverified' } })];
  const before = structuredClone(entries);
  const result = plan(entries, { maxCount: 1 });
  assert.equal(result.removeCount, 1);
  assert.equal(result.rows.find(row => row.id === 'old').action, 'remove');
  assert.deepEqual(result.rows.find(row => row.id === 'recent-good').protectedReasons, ['latest-verified']);
  assert.deepEqual(result.rows.find(row => row.id === 'newest').protectedReasons, ['newest']);
  assert.ok(result.warnings.includes('count-unmet'));
  assert.deepEqual(entries, before);
  assert.deepEqual(plan([...entries].reverse(), { maxCount: 1 }), result);
});

test('count, age and byte policies remove oldest unprotected backups and report unsatisfied limits', () => {
  const entries = [entry('new', 0), entry('pin', 30, { pinned: true }), entry('old', 20), entry('mid', 2), entry('active', 40)];
  const result = plan(entries, { maxCount: 2, maxAgeDays: 10, maxBytes: 150 }, { activeIds: ['active'] });
  assert.equal(result.removeCount, 2);
  assert.equal(result.remainingCount, 3);
  assert.equal(result.removeBytes, 200);
  assert.equal(result.remainingBytes, 300);
  assert.equal(result.rows.find(row => row.id === 'pin').action, 'keep');
  assert.equal(result.rows.find(row => row.id === 'active').action, 'keep');
  assert.deepEqual(result.warnings, ['count-unmet', 'bytes-unmet', 'age-unmet']);
  assert.equal(plan([entry('new', 0), entry('boundary', 10)], { maxAgeDays: 10 }).removeCount, 0);
  assert.equal(plan([entry('new', 0), entry('old', 10.001)], { maxAgeDays: 10 }).removeCount, 1);
  const bytes = plan([entry('new', 0), entry('middle', 1), entry('old', 2)], { maxBytes: 200 });
  assert.equal(bytes.rows.find(row => row.id === 'old').action, 'remove');
  assert.equal(bytes.remainingBytes, 200);
});

test('unknown/mismatched evidence and future clocks fail conservatively without proposing all backups', () => {
  const entries = [entry('unknown', 0, { verification: { checksum: 'unverified' } }), entry('legacy', 20, { verification: { checksum: 'missing' } })];
  const blocked = plan(entries, { maxCount: 1 });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.removeCount, 0);
  assert.ok(blocked.warnings.includes('no-verified-backup'));
  const protectedEntries = [entry('new', 0), entry('metadata', 20, { annotationError: 'broken' }),
    entry('manifest', 30, { manifestError: 'broken' }), entry('wrong', 25, { verification: { checksum: 'mismatch' } }),
    entry('future', -1), entry('bad-date', 5, { createdAt: 'invalid' }), entry('numeric-date', 5, { createdAt: 12 }), entry('bad-size', 50, { bytes: -1 })];
  const result = plan(protectedEntries, { maxCount: 1 });
  assert.equal(result.removeCount, 0);
  assert.ok(result.rows.every(row => row.protectedReasons.length > 0));
  assert.equal(plan([entry('future-only', -1)], { maxCount: 1 }).blocked, true);
});
