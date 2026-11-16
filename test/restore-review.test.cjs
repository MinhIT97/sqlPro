'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { captureObservation, compareObservations } = require('../restore-review.js');

function fixture() {
  const request = { profileId: 'p1', database: 'demo', id: 'backup.sql', targetDatabase: 'target', conflictPolicy: 'stop-on-conflict',
    includeStructure: false, includeData: true, tables: ['b', 'a'], password: 'private-password' };
  const result = { checksum: 'a'.repeat(64), rawSQL: 'private-sql', targetReview: { version: 15, canExecute: false, database: 'target',
    metadataId: 'b'.repeat(64), snapshotId: 'c'.repeat(64), checkedAt: '2026-11-16T00:00:00Z', expression: 'private-body' },
    draftPlan: { version: 28, canExecute: false, planId: 'd'.repeat(64), targetSnapshotId: 'c'.repeat(64), checksum: 'a'.repeat(64),
      sourceDatabase: 'demo', targetDatabase: 'target', selection: { tables: ['a', 'b'], includeStructure: false, includeData: true }, conflictPolicyReview: { policy: 'stop-on-conflict' } } };
  return { request, result };
}

test('observations copy only bounded identities, normalize table order, remain immutable and keep no SQL or secret', () => {
  const { request, result } = fixture(), before = structuredClone({ request, result });
  const observation = captureObservation(request, result); assert.ok(observation); assert.equal(Object.isFrozen(observation), true);
  const reordered = captureObservation({ ...request, tables: ['a', 'b'] }, result); assert.deepEqual(observation, reordered);
  assert.equal(JSON.stringify(observation).includes('private-'), false); assert.deepEqual({ request, result }, before);
  assert.throws(() => { observation.planId = 'e'.repeat(64); }, TypeError);
  for (const tables of [['__proto__', 'a.b', ' a ', 'a\\b'], ['A', 'a']]) {
    const data = fixture(); data.request.tables = tables; data.result.draftPlan.selection.tables = [...tables];
    assert.ok(captureObservation(data.request, data.result));
  }
});

test('malformed/old/unbound replies cannot become a comparison baseline', () => {
  const { request, result } = fixture();
  for (const change of [{ tables: [] }, { tables: ['a', 'a'] }, { tables: Array(1001).fill('a') }, { tables: ['a\0b'] }, { profileId: '' },
    { targetDatabase: 'x'.repeat(65) }, { id: 'x'.repeat(129) }, { includeData: 1 }, { includeData: false }, { conflictPolicy: 'replace' }]) {
    assert.equal(captureObservation({ ...request, ...change }, result), null);
  }
  for (const key of ['metadataId', 'snapshotId']) for (const value of [null, '', 'b'.repeat(64) + '\n', 1]) {
    const data = fixture(); data.result.targetReview[key] = value; assert.equal(captureObservation(data.request, data.result), null);
  }
  for (const change of [{ canExecute: true }, { database: 'other' }, { checkedAt: 'invalid' }, { checkedAt: 'x'.repeat(41) }, { version: null }]) {
    assert.equal(captureObservation(request, { ...result, targetReview: { ...result.targetReview, ...change } }), null);
  }
  for (const change of [{ canExecute: true }, { checksum: 'e'.repeat(64) }, { targetSnapshotId: 'e'.repeat(64) }, { targetDatabase: 'other' },
    { sourceDatabase: 'other' }, { selection: { tables: ['a'], includeStructure: false, includeData: true } }, { conflictPolicyReview: { policy: 'skip-existing' } }]) {
    assert.equal(captureObservation(request, { ...result, draftPlan: { ...result.draftPlan, ...change } }), null);
  }
  assert.equal(captureObservation(request, {}), null); assert.equal(captureObservation(null, result), null);
});

test('comparison distinguishes baseline, source, metadata, plan, scope and version without granting execution', () => {
  const { request, result } = fixture(), initial = captureObservation(request, result);
  assert.equal(compareObservations(null, initial).status, 'baseline'); assert.equal(compareObservations(initial, null).status, 'unknown');
  assert.equal(compareObservations(initial, { ...initial, checkedAt: '2026-11-17T00:00:00Z' }).status, 'unchanged');
  for (const changes of [{ checksum: 'e'.repeat(64) }, { metadataId: 'e'.repeat(64) }, { checksum: 'e'.repeat(64), metadataId: 'f'.repeat(64) }]) {
    const comparison = compareObservations(initial, { ...initial, ...changes, snapshotId: 'e'.repeat(64), planId: 'f'.repeat(64) });
    assert.equal(comparison.status, 'changed'); assert.equal(comparison.sourceChanged, !!changes.checksum); assert.equal(comparison.metadataChanged, !!changes.metadataId);
    assert.equal(comparison.canExecute, false);
  }
  const planOnly = compareObservations(initial, { ...initial, planId: 'f'.repeat(64) }); assert.equal(planOnly.planChanged, true); assert.equal(planOnly.metadataChanged, false);
  for (const changes of [{ scope: 'other' }, { targetVersion: 16 }, { planVersion: 29 }]) {
    assert.match(compareObservations(initial, { ...initial, ...changes }).status, /^different-/);
  }
  for (const changes of [{ snapshotId: 'e'.repeat(64) }, { metadataId: 'f'.repeat(64) }, { checksum: 'f'.repeat(64) }]) {
    assert.equal(compareObservations(initial, { ...initial, ...changes }).status, 'unknown');
  }
  for (const field of ['profileId', 'database', 'id', 'targetDatabase', 'conflictPolicy', 'includeStructure', 'includeData', 'tables']) {
    const data = fixture();
    if (field === 'conflictPolicy') { data.request[field] = 'skip-existing'; data.result.draftPlan.conflictPolicyReview.policy = data.request[field]; }
    else if (field === 'includeStructure') { data.request[field] = true; data.result.draftPlan.selection[field] = true; }
    else if (field === 'includeData') { data.request.includeStructure = true; data.request.includeData = false; Object.assign(data.result.draftPlan.selection, { includeStructure: true, includeData: false }); }
    else if (field === 'tables') { data.request.tables = ['a']; data.result.draftPlan.selection.tables = ['a']; }
    else { data.request[field] += '2'; if (field === 'database') data.result.draftPlan.sourceDatabase = data.request[field];
      if (field === 'targetDatabase') { data.result.draftPlan.targetDatabase = data.request[field]; data.result.targetReview.database = data.request[field]; } }
    assert.equal(compareObservations(initial, captureObservation(data.request, data.result)).status, 'different-scope', field);
  }
});

test('renderer asset is included before app.js and in the packaging allowlist', () => {
  const root = path.join(__dirname, '..'), config = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(config.build.files.includes('restore-review.js'));
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(html.indexOf('src="restore-review.js"') > 0); assert.ok(html.indexOf('src="restore-review.js"') < html.indexOf('src="app.js"'));
});
