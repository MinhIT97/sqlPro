'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_WORKSPACE_ID,
  DEFAULT_TIMESTAMP,
  normalizeStore,
  normalizeVault,
  fingerprint,
  mergeVaults
} = require('../electron/store-schema.cjs');

function workspace(id, updatedAt = '2026-01-01T00:00:00.000Z') {
  return { id, name: id, description: '', createdAt: updatedAt, updatedAt };
}

function connection(id, updatedAt = '2026-01-01T00:00:00.000Z', extra = {}) {
  return {
    id,
    workspaceId: DEFAULT_WORKSPACE_ID,
    name: id,
    host: 'localhost',
    updatedAt,
    ...extra
  };
}

test('migrates v1 store to v2 and assigns default workspace', () => {
  const migrated = normalizeStore({
    version: 1,
    connections: [
      { id: 'c1', name: 'One', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'c2', name: 'Two', updatedAt: '2026-01-02T00:00:00.000Z' }
    ]
  });
  assert.equal(migrated.version, 2);
  assert.equal(migrated.workspaces[0].id, DEFAULT_WORKSPACE_ID);
  assert.equal(migrated.connections[0].workspaceId, DEFAULT_WORKSPACE_ID);
  assert.equal(migrated.connections[1].workspaceId, DEFAULT_WORKSPACE_ID);
  assert.deepEqual(migrated.tombstones, []);
});

test('newer connection wins regardless of merge order', () => {
  const old = connection('c1', '2026-01-01T00:00:00.000Z', { name: 'Old' });
  const fresh = connection('c1', '2026-01-02T00:00:00.000Z', { name: 'New' });
  const left = mergeVaults({ connections: [old] }, { connections: [fresh] });
  const right = mergeVaults({ connections: [fresh] }, { connections: [old] });
  assert.equal(left.connections[0].name, 'New');
  assert.equal(right.connections[0].name, 'New');
  assert.equal(fingerprint(left), fingerprint(right));
});

test('equal timestamps converge deterministically', () => {
  const one = connection('c1', '2026-01-01T00:00:00.000Z', { name: 'A' });
  const two = connection('c1', '2026-01-01T00:00:00.000Z', { name: 'B' });
  const left = mergeVaults({ connections: [one] }, { connections: [two] });
  const right = mergeVaults({ connections: [two] }, { connections: [one] });
  assert.equal(left.connections[0].name, right.connections[0].name);
  assert.equal(fingerprint(left), fingerprint(right));
});

test('tombstones delete newer or equal records and are retained', () => {
  const victim = connection('c1', '2026-01-01T00:00:00.000Z');
  const tombstone = { type: 'connection', id: 'c1', updatedAt: '2026-01-01T00:00:00.000Z' };
  const merged = mergeVaults(
    { connections: [victim], tombstones: [tombstone] },
    { connections: [victim] },
    { now: new Date('2026-02-01T00:00:00.000Z') }
  );
  assert.equal(merged.connections.length, 0);
  assert.deepEqual(merged.tombstones, [tombstone]);
});

test('newer connection survives an older tombstone', () => {
  const victim = connection('c1', '2026-01-05T00:00:00.000Z');
  const tombstone = { type: 'connection', id: 'c1', updatedAt: '2026-01-01T00:00:00.000Z' };
  const merged = mergeVaults(
    { connections: [victim] },
    { tombstones: [tombstone] },
    { now: new Date('2026-02-01T00:00:00.000Z') }
  );
  assert.equal(merged.connections.length, 1);
});

test('tombstones older than 180 days are purged', () => {
  const merged = mergeVaults(
    {},
    { tombstones: [{ type: 'connection', id: 'c1', updatedAt: '2025-01-01T00:00:00.000Z' }] },
    { now: new Date('2026-01-01T00:00:00.000Z') }
  );
  assert.deepEqual(merged.tombstones, []);
});

test('deleted workspace moves its connections to the default workspace', () => {
  const project = workspace('project-1', '2026-01-01T00:00:00.000Z');
  const item = connection('c1', '2026-01-01T00:00:00.000Z', { workspaceId: 'project-1' });
  const merged = mergeVaults(
    { workspaces: [project], connections: [item] },
    { tombstones: [{ type: 'workspace', id: 'project-1', updatedAt: '2026-01-02T00:00:00.000Z' }] },
    { now: new Date('2026-02-01T00:00:00.000Z') }
  );
  assert.equal(merged.workspaces.some((entry) => entry.id === 'project-1'), false);
  assert.equal(merged.connections[0].workspaceId, DEFAULT_WORKSPACE_ID);
});

test('orphan connection and default workspace are repaired', () => {
  const merged = mergeVaults(
    {
      workspaces: [workspace('project-1')],
      connections: [connection('c1', '2026-01-01T00:00:00.000Z', { workspaceId: 'missing' })]
    },
    {},
    { now: new Date('2026-02-01T00:00:00.000Z') }
  );
  assert.equal(merged.workspaces[0].id, DEFAULT_WORKSPACE_ID);
  assert.equal(merged.connections[0].workspaceId, DEFAULT_WORKSPACE_ID);
  assert.equal(merged.defaultWorkspaceId, DEFAULT_WORKSPACE_ID);
});

test('default workspace cannot be deleted and has stable metadata', () => {
  const merged = mergeVaults(
    { workspaces: [workspace(DEFAULT_WORKSPACE_ID)] },
    { tombstones: [{ type: 'workspace', id: DEFAULT_WORKSPACE_ID, updatedAt: '2030-01-01T00:00:00.000Z' }] }
  );
  assert.equal(merged.workspaces[0].id, DEFAULT_WORKSPACE_ID);
  assert.equal(merged.workspaces[0].createdAt, DEFAULT_TIMESTAMP);
  assert.deepEqual(merged.tombstones, []);
});

test('fingerprint ignores object key order but changes with content', () => {
  const a = normalizeVault({ connections: [connection('c1')] });
  const b = normalizeVault({ connections: [{ updatedAt: '2026-01-01T00:00:00.000Z', host: 'localhost', name: 'c1', workspaceId: DEFAULT_WORKSPACE_ID, id: 'c1' }] });
  assert.equal(fingerprint(a), fingerprint(b));
  const changed = normalizeVault({ connections: [connection('c1', '2026-01-02T00:00:00.000Z', { name: 'Changed' })] });
  assert.notEqual(fingerprint(a), fingerprint(changed));
});
