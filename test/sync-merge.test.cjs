'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_WORKSPACE_ID,
  DEFAULT_TIMESTAMP,
  normalizeStore,
  normalizeVault,
  fingerprint,
  mergeVaults,
  mergeVaultsWithBase
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

function vault(entries, extra = {}) {
  return normalizeVault({ connections: entries, ...extra });
}

function baseConnection() {
  return connection('c1', '2026-01-01T00:00:00.000Z', {
    name: 'Prod',
    host: 'db.example',
    password: 'base-secret'
  });
}

test('ba chiều hợp nhất từng trường: đổi mật khẩu và đổi tên ở hai máy không ghi đè nhau', () => {
  const base = vault([baseConnection()]);
  const local = vault([connection('c1', '2026-01-01T00:00:00.000Z', {
    name: 'Prod',
    host: 'db.example',
    password: 'local-secret'
  })]);
  const remote = vault([connection('c1', '2026-01-05T00:00:00.000Z', {
    name: 'Production',
    host: 'db.example',
    password: 'base-secret'
  })]);
  const result = mergeVaultsWithBase(local, remote, base);
  assert.equal(result.vault.connections[0].name, 'Production');
  assert.equal(result.vault.connections[0].password, 'local-secret');
  assert.equal(result.vault.connections[0].host, 'db.example');
  assert.equal(result.requiresResolution, false);
});

test('thay đổi độc lập được hợp nhất ngay cả khi timestamp của bản ghi ngược nhau', () => {
  const base = vault([baseConnection()]);
  const local = vault([connection('c1', '2026-01-01T00:00:00.000Z', {
    name: 'Prod',
    host: 'local.example',
    password: 'base-secret'
  })]);
  const remote = vault([connection('c1', '2030-01-01T00:00:00.000Z', {
    name: 'Prod',
    host: 'db.example',
    password: 'base-secret'
  })]);
  const result = mergeVaultsWithBase(local, remote, base);
  assert.equal(result.vault.connections[0].host, 'local.example');
  assert.equal(result.vault.connections[0].password, 'base-secret');
  assert.equal(result.requiresResolution, false);
});

test('xung đột mật khẩu bị che giá trị và bắt buộc người dùng chọn', () => {
  const base = vault([baseConnection()]);
  const local = vault([connection('c1', '2026-01-02T00:00:00.000Z', { ...baseConnection(), password: 'local-secret' })]);
  const remote = vault([connection('c1', '2026-01-03T00:00:00.000Z', { ...baseConnection(), password: 'remote-secret' })]);
  const result = mergeVaultsWithBase(local, remote, base);
  assert.equal(result.requiresResolution, true);
  const entry = result.conflicts.find((conflict) => conflict.id === 'c1');
  assert.equal(entry.requiresChoice, true);
  const field = entry.fields.find((item) => item.path === 'password');
  assert.equal(field.secret, true);
  assert.equal(field.requiresChoice, true);
  assert.equal('local' in field, false);
  assert.equal('remote' in field, false);
  assert.equal(JSON.stringify(result.conflicts).includes('local-secret'), false);
  assert.equal(JSON.stringify(result.conflicts).includes('remote-secret'), false);
});

test('xung đột host/user hiển thị giá trị nhưng vẫn cần chọn một bên', () => {
  const base = vault([baseConnection()]);
  const local = vault([connection('c1', '2026-01-02T00:00:00.000Z', {
    ...baseConnection(),
    host: 'local.example',
    user: 'local_user'
  })]);
  const remote = vault([connection('c1', '2026-01-03T00:00:00.000Z', {
    ...baseConnection(),
    host: 'remote.example',
    user: 'remote_user'
  })]);
  const result = mergeVaultsWithBase(local, remote, base);
  assert.equal(result.requiresResolution, true);
  const entry = result.conflicts.find((conflict) => conflict.id === 'c1');
  const host = entry.fields.find((item) => item.path === 'host');
  assert.equal(host.secret, false);
  assert.equal(host.requiresChoice, true);
  assert.equal(host.local, 'local.example');
  assert.equal(host.remote, 'remote.example');
  assert.equal(result.vault.connections[0].host, 'local.example');
});

test('lựa chọn remote thắng và xóa yêu cầu chọn cho đúng trường', () => {
  const base = vault([baseConnection()]);
  const local = vault([connection('c1', '2026-01-02T00:00:00.000Z', { ...baseConnection(), password: 'local-secret' })]);
  const remote = vault([connection('c1', '2026-01-03T00:00:00.000Z', { ...baseConnection(), password: 'remote-secret' })]);
  const choices = new Map([['c1\u0000password', 'remote']]);
  const result = mergeVaultsWithBase(local, remote, base, { choices });
  assert.equal(result.vault.connections[0].password, 'remote-secret');
  assert.equal(result.requiresResolution, false);
  assert.equal(result.conflicts.find((conflict) => conflict.id === 'c1').fields[0].requiresChoice, false);
});

test('không có base vẫn hợp nhất trường không nhạy cảm và yêu cầu chọn trường nhạy cảm', () => {
  const local = vault([connection('c1', '2026-01-01T00:00:00.000Z', {
    name: 'Local name',
    host: 'same.example',
    password: 'local-secret'
  })]);
  const remote = vault([connection('c1', '2026-01-02T00:00:00.000Z', {
    name: 'Remote name',
    host: 'same.example',
    password: 'remote-secret'
  })]);
  const result = mergeVaultsWithBase(local, remote, null);
  assert.equal(result.vault.connections[0].name, 'Local name');
  assert.equal(result.vault.connections[0].password, 'local-secret');
  assert.equal(result.requiresResolution, true);
});

test('workspace cũng được hợp nhất theo từng trường', () => {
  const base = vault([], { workspaces: [{ id: 'ws1', name: 'Base', description: 'old', createdAt: DEFAULT_TIMESTAMP, updatedAt: DEFAULT_TIMESTAMP }] });
  const local = vault([], { workspaces: [{ id: 'ws1', name: 'Base', description: 'local', createdAt: DEFAULT_TIMESTAMP, updatedAt: '2026-01-02T00:00:00.000Z' }] });
  const remote = vault([], { workspaces: [{ id: 'ws1', name: 'Remote', description: 'old', createdAt: DEFAULT_TIMESTAMP, updatedAt: '2026-01-03T00:00:00.000Z' }] });
  const result = mergeVaultsWithBase(local, remote, base);
  const workspace = result.vault.workspaces.find((entry) => entry.id === 'ws1');
  assert.equal(workspace.name, 'Remote');
  assert.equal(workspace.description, 'local');
});

test('xung đột mật khẩu đã chọn không làm rò mật khẩu vào metadata conflict', () => {
  const base = vault([baseConnection()]);
  const local = vault([connection('c1', '2026-01-02T00:00:00.000Z', { ...baseConnection(), password: 'synthetic-one' })]);
  const remote = vault([connection('c1', '2026-01-03T00:00:00.000Z', { ...baseConnection(), password: 'synthetic-two' })]);
  const withoutChoice = mergeVaultsWithBase(local, remote, base);
  assert.equal(JSON.stringify(withoutChoice.conflicts).includes('synthetic-one'), false);
  const withChoice = mergeVaultsWithBase(local, remote, base, { choices: new Map([['c1\u0000password', 'local']]) });
  assert.equal(JSON.stringify(withChoice.conflicts).includes('synthetic-one'), false);
  assert.equal(withChoice.requiresResolution, false);
});

test('three-way merge preserves special own keys without following or changing prototypes', () => {
  const record = JSON.parse('{"id":"fixture","host":"fixture.example","__proto__":{"sqlpro_merge_marker":"safe"},"constructor":{"prototype":{"sqlpro_merge_marker":"safe"}},"prototype":{"x":1},"dot.name":{"back\\\\slash":2},"ssl":{"enabled":false,"__proto__":{"nested":3}},"empty":{}}');
  const before = Object.getOwnPropertyDescriptors(Object.prototype);
  try {
    const result = mergeVaultsWithBase(vault([record]), vault([record]), vault([record]));
    const merged = result.vault.connections[0];
    for (const key of ['__proto__', 'constructor', 'prototype', 'dot.name', 'ssl', 'empty']) {
      assert.equal(Object.hasOwn(merged, key), true);
      assert.deepEqual(merged[key], record[key]);
    }
    assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), before);
    assert.equal(Object.hasOwn(merged, 'dot'), false);
    assert.equal(Object.hasOwn(merged.ssl, 'nested'), false);
    assert.equal(result.requiresResolution, false);
  } finally { delete Object.prototype.sqlpro_merge_marker; }
});

test('literal dotted keys cannot replace known nested connection settings during merge', () => {
  const record = { id: 'fixture', host: 'fixture.example', ssl: { enabled: false }, 'ssl.enabled': true, '': { host: 'shadow.example' } };
  const result = mergeVaultsWithBase(vault([record]), vault([record]), null);
  assert.equal(result.vault.connections[0].ssl.enabled, false);
  assert.equal(result.vault.connections[0]['ssl.enabled'], true);
  assert.equal(result.vault.connections[0].host, 'fixture.example');
  assert.equal(result.vault.connections[0][''].host, 'shadow.example');
});

test('merge does not mutate source containers when a field changes from empty to nested', () => {
  const local = { id: 'fixture', host: 'fixture.example', ssl: Object.freeze({}), extra: Object.freeze([{ x: 1 }]) };
  const remote = { id: 'fixture', host: 'fixture.example', ssl: { enabled: true }, extra: [{ x: 1 }] };
  const result = mergeVaultsWithBase(vault([local]), vault([remote]), null, { choices: new Map([['fixture\u0000ssl.enabled', 'remote']]) });
  assert.deepEqual(local.ssl, {});
  assert.equal(result.vault.connections[0].ssl.enabled, true);
  result.vault.connections[0].extra[0].x = 2;
  assert.equal(local.extra[0].x, 1);
  assert.equal(remote.extra[0].x, 1);
});
