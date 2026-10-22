'use strict';

const crypto = require('node:crypto');

const DEFAULT_WORKSPACE_ID = 'ws-personal';
const DEFAULT_WORKSPACE_NAME = 'Cá nhân';
const DEFAULT_TIMESTAMP = '1970-01-01T00:00:00.000Z';
const STORE_VERSION = 2;
const VAULT_VERSION = 1;

function text(value, maxLength) {
  return String(value === undefined || value === null ? '' : value).trim().slice(0, maxLength);
}

function validTimestamp(value) {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function defaultWorkspace() {
  return {
    id: DEFAULT_WORKSPACE_ID,
    name: DEFAULT_WORKSPACE_NAME,
    description: '',
    createdAt: DEFAULT_TIMESTAMP,
    updatedAt: DEFAULT_TIMESTAMP
  };
}

function normalizeWorkspace(input) {
  const source = input && typeof input === 'object' ? input : {};
  if (source.id === DEFAULT_WORKSPACE_ID) return defaultWorkspace();
  const id = text(source.id, 80);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return null;
  const createdAt = validTimestamp(source.createdAt) ? source.createdAt : DEFAULT_TIMESTAMP;
  const updatedAt = validTimestamp(source.updatedAt) ? source.updatedAt : createdAt;
  return {
    id,
    name: text(source.name, 80) || 'Workspace',
    description: text(source.description, 500),
    createdAt,
    updatedAt
  };
}

function normalizeConnectionForStore(input) {
  if (!input || typeof input !== 'object' || typeof input.id !== 'string' || !input.id) return null;
  const workspaceId = typeof input.workspaceId === 'string' && input.workspaceId
    ? input.workspaceId
    : DEFAULT_WORKSPACE_ID;
  return {
    ...input,
    workspaceId,
    updatedAt: validTimestamp(input.updatedAt) ? input.updatedAt : DEFAULT_TIMESTAMP
  };
}

function ensureWorkspaces(workspaces) {
  const seen = new Set();
  const normalized = [];
  for (const entry of Array.isArray(workspaces) ? workspaces : []) {
    const workspace = normalizeWorkspace(entry);
    if (!workspace || seen.has(workspace.id)) continue;
    seen.add(workspace.id);
    normalized.push(workspace);
  }
  if (!seen.has(DEFAULT_WORKSPACE_ID)) normalized.unshift(defaultWorkspace());
  else {
    const index = normalized.findIndex((workspace) => workspace.id === DEFAULT_WORKSPACE_ID);
    normalized[index] = defaultWorkspace();
    normalized.unshift(normalized.splice(index, 1)[0]);
  }
  return normalized;
}

function normalizeTombstones(tombstones) {
  const merged = new Map();
  for (const entry of Array.isArray(tombstones) ? tombstones : []) {
    if (!entry || typeof entry !== 'object') continue;
    const type = entry.type === 'workspace' ? 'workspace' : entry.type === 'connection' ? 'connection' : '';
    const id = text(entry.id, 120);
    if (!type || !id) continue;
    if (type === 'workspace' && id === DEFAULT_WORKSPACE_ID) continue;
    const updatedAt = validTimestamp(entry.updatedAt) ? entry.updatedAt : DEFAULT_TIMESTAMP;
    const key = `${type}:${id}`;
    const current = merged.get(key);
    if (!current || updatedAt > current.updatedAt) merged.set(key, { type, id, updatedAt });
  }
  return [...merged.values()].sort((left, right) => {
    const leftKey = `${left.type}:${left.id}`;
    const rightKey = `${right.type}:${right.id}`;
    return leftKey.localeCompare(rightKey);
  });
}

function normalizeVault(input) {
  const source = input && typeof input === 'object' ? input : {};
  const workspaces = ensureWorkspaces(source.workspaces);
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  const connections = [];
  const seen = new Set();
  for (const entry of Array.isArray(source.connections) ? source.connections : []) {
    const connection = normalizeConnectionForStore(entry);
    if (!connection || seen.has(connection.id)) continue;
    seen.add(connection.id);
    if (!workspaceIds.has(connection.workspaceId)) connection.workspaceId = DEFAULT_WORKSPACE_ID;
    connections.push(connection);
  }
  return {
    version: VAULT_VERSION,
    defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
    workspaces,
    connections,
    tombstones: normalizeTombstones(source.tombstones)
  };
}

function normalizeStore(input) {
  const source = input && typeof input === 'object' ? input : {};
  const isV1 = !Array.isArray(source.workspaces);
  const migratedConnections = (Array.isArray(source.connections) ? source.connections : [])
    .map((connection) => (isV1 && connection && typeof connection === 'object'
      ? { ...connection, workspaceId: connection.workspaceId || DEFAULT_WORKSPACE_ID }
      : connection));
  return {
    version: STORE_VERSION,
    workspaces: ensureWorkspaces(source.workspaces),
    connections: migratedConnections.map(normalizeConnectionForStore).filter(Boolean),
    tombstones: normalizeTombstones(source.tombstones),
    meta: source.meta && typeof source.meta === 'object' ? { ...source.meta } : {}
  };
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function fingerprint(vault) {
  const normalized = normalizeVault(vault);
  return crypto.createHash('sha256').update(stableStringify(normalized), 'utf8').digest('hex');
}

function newer(left, right) {
  if (!right) return left;
  if (!left) return right;
  if (left.updatedAt > right.updatedAt) return left;
  if (right.updatedAt > left.updatedAt) return right;
  return stableStringify(left) >= stableStringify(right) ? left : right;
}

function mergeVaults(localInput, remoteInput, options = {}) {
  const local = normalizeVault(localInput);
  const remote = normalizeVault(remoteInput);
  const now = options.now instanceof Date ? options.now : new Date();
  const cutoff = now.getTime() - 180 * 24 * 60 * 60 * 1000;

  const workspaces = new Map();
  for (const workspace of [...local.workspaces, ...remote.workspaces]) {
    if (workspace.id === DEFAULT_WORKSPACE_ID) continue;
    workspaces.set(workspace.id, newer(workspaces.get(workspace.id), workspace));
  }

  const connections = new Map();
  for (const connection of [...local.connections, ...remote.connections]) {
    connections.set(connection.id, newer(connections.get(connection.id), connection));
  }

  const tombstones = new Map();
  for (const tombstone of [...local.tombstones, ...remote.tombstones]) {
    if (Date.parse(tombstone.updatedAt) < cutoff) continue;
    const key = `${tombstone.type}:${tombstone.id}`;
    const current = tombstones.get(key);
    if (!current || tombstone.updatedAt > current.updatedAt) tombstones.set(key, tombstone);
  }

  const workspaceTombstones = new Map();
  const connectionTombstones = new Map();
  for (const tombstone of tombstones.values()) {
    if (tombstone.type === 'workspace') workspaceTombstones.set(tombstone.id, tombstone);
    else connectionTombstones.set(tombstone.id, tombstone);
  }

  for (const [id, workspace] of [...workspaces]) {
    const tombstone = workspaceTombstones.get(id);
    if (tombstone && tombstone.updatedAt >= workspace.updatedAt) workspaces.delete(id);
  }
  const workspaceIds = new Set([DEFAULT_WORKSPACE_ID, ...workspaces.keys()]);
  for (const [id, connection] of [...connections]) {
    const tombstone = connectionTombstones.get(id);
    if (tombstone && tombstone.updatedAt >= connection.updatedAt) {
      connections.delete(id);
      continue;
    }
    if (!workspaceIds.has(connection.workspaceId)) connection.workspaceId = DEFAULT_WORKSPACE_ID;
  }

  return normalizeVault({
    version: VAULT_VERSION,
    defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
    workspaces: [defaultWorkspace(), ...workspaces.values()],
    connections: [...connections.values()],
    tombstones: [...tombstones.values()]
  });
}

module.exports = {
  DEFAULT_WORKSPACE_ID,
  DEFAULT_WORKSPACE_NAME,
  DEFAULT_TIMESTAMP,
  STORE_VERSION,
  VAULT_VERSION,
  defaultWorkspace,
  normalizeWorkspace,
  normalizeConnectionForStore,
  normalizeTombstones,
  normalizeVault,
  normalizeStore,
  stableStringify,
  fingerprint,
  mergeVaults
};
