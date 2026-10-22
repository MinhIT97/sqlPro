'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  deriveKeys,
  deriveMasterKey,
  deriveAuthProof,
  encryptVault,
  decryptVault
} = require('../../electron/sync-crypto.cjs');
const { normalizeVault, mergeVaults } = require('../../electron/store-schema.cjs');
const { startServer, request } = require('./helpers.cjs');

const EMAIL = 'Sync.User@Example.com';
const PASSWORD = 'correct horse battery staple';
const SECRETS = [
  'db.secret.internal',
  'sqlpro_test_user',
  'super-secret-password',
  'Production DB',
  'Công ty Bí Mật'
];

function connection(overrides = {}) {
  return {
    id: 'conn-production',
    workspaceId: 'ws-company',
    name: 'Production DB',
    host: 'db.secret.internal',
    port: 3306,
    user: 'sqlpro_test_user',
    password: 'super-secret-password',
    database: 'shop',
    ssl: false,
    sshEnabled: false,
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
    ...overrides
  };
}

function companyWorkspace() {
  const createdAt = new Date(Date.now() - 120_000).toISOString();
  return {
    id: 'ws-company',
    name: 'Công ty Bí Mật',
    description: 'Dự án thử nghiệm',
    createdAt,
    updatedAt: createdAt
  };
}

function deviceVault(overrides = {}) {
  return normalizeVault({
    version: 1,
    workspaces: [companyWorkspace()],
    connections: [connection()],
    tombstones: [],
    ...overrides
  });
}

async function serverMeta(baseUrl) {
  const meta = await request(baseUrl, '/api/meta');
  assert.equal(meta.status, 200);
  return meta.data;
}

test('two devices register, encrypt, sync, and propagate deletions', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const meta = await serverMeta(server.baseUrl);
  assert.equal(meta.kdfVersion, 1);

  const email = EMAIL.trim().toLowerCase();
  const masterKey = deriveMasterKey(PASSWORD, email);
  const authProof = deriveAuthProof(masterKey, meta.authContext);

  const registered = await request(server.baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { email, authProof }
  });
  assert.equal(registered.status, 201);
  const userId = registered.data.user.id;
  const vaultKey = deriveKeys({
    password: PASSWORD,
    email,
    authContext: meta.authContext,
    vaultSalt: registered.data.vaultSalt
  }).vaultKey;

  const vaultA = deviceVault();
  const envelopeA = encryptVault(vaultA, vaultKey, userId);
  const putA = await request(server.baseUrl, '/api/vault', {
    method: 'PUT',
    token: registered.data.token,
    body: { baseRevision: 0, envelope: envelopeA }
  });
  assert.equal(putA.status, 200);
  assert.equal(putA.data.revision, 1);

  const stored = server.db.prepare('SELECT envelope FROM vaults WHERE user_id = ?').get(userId);
  for (const secret of SECRETS) {
    assert.equal(stored.envelope.includes(secret), false, `server vault leaked ${secret}`);
  }
  for (const secret of ['super-secret-password', 'db.secret.internal', 'sqlpro_test_user']) {
    assert.equal(JSON.stringify(server.db.prepare('SELECT * FROM users').all()).includes(secret), false);
  }
  const sessionRows = JSON.stringify(server.db.prepare('SELECT * FROM sessions').all());
  assert.equal(sessionRows.includes(registered.data.token), false, 'raw session token stored');
  assert.match(sessionRows, /[a-f0-9]{64}/);

  const loginB = await request(server.baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email, authProof }
  });
  assert.equal(loginB.status, 200);
  assert.equal(loginB.data.user.id, userId);
  assert.equal(loginB.data.vaultSalt, registered.data.vaultSalt);

  const remote = await request(server.baseUrl, '/api/vault', {
    token: loginB.data.token
  });
  assert.equal(remote.status, 200);
  assert.equal(remote.data.revision, 1);
  const decryptedRemote = normalizeVault(decryptVault(remote.data.envelope, vaultKey, userId));
  assert.equal(decryptedRemote.connections.length, 1);
  assert.equal(decryptedRemote.connections[0].password, 'super-secret-password');
  assert.equal(decryptedRemote.connections[0].host, 'db.secret.internal');
  assert.equal(decryptedRemote.workspaces.some((entry) => entry.name === 'Công ty Bí Mật'), true);

  const pulledOnB = mergeVaults(normalizeVault({}), decryptedRemote);
  assert.equal(pulledOnB.connections[0].id, 'conn-production');
  assert.equal(pulledOnB.connections[0].password, 'super-secret-password');

  const tombstoneAt = new Date().toISOString();
  const deletedOnB = normalizeVault({
    ...pulledOnB,
    connections: [],
    tombstones: [{ type: 'connection', id: 'conn-production', updatedAt: tombstoneAt }]
  });
  const envelopeB = encryptVault(deletedOnB, vaultKey, userId);
  const putB = await request(server.baseUrl, '/api/vault', {
    method: 'PUT',
    token: loginB.data.token,
    body: { baseRevision: 1, envelope: envelopeB }
  });
  assert.equal(putB.status, 200);
  assert.equal(putB.data.revision, 2);

  const remoteForA = await request(server.baseUrl, '/api/vault', {
    token: registered.data.token
  });
  const decryptedForA = normalizeVault(decryptVault(remoteForA.data.envelope, vaultKey, userId));
  const mergedOnA = mergeVaults(vaultA, decryptedForA);
  assert.equal(mergedOnA.connections.length, 0, 'deletion did not propagate to device A');
  assert.equal(
    mergedOnA.tombstones.some((entry) => entry.type === 'connection' && entry.id === 'conn-production'),
    true
  );
  assert.equal(mergedOnA.workspaces.some((entry) => entry.id === 'ws-company'), true);

  const newerEdit = deviceVault({
    connections: [
      connection({ host: 'db.recovered.internal', updatedAt: new Date(Date.parse(tombstoneAt) + 1000).toISOString() })
    ],
    tombstones: []
  });
  const mergedAfterEdit = mergeVaults(newerEdit, decryptedForA);
  assert.equal(mergedAfterEdit.connections.length, 1, 'newer offline edit should survive an older tombstone');
  assert.equal(mergedAfterEdit.connections[0].host, 'db.recovered.internal');

  const conflict = await request(server.baseUrl, '/api/vault', {
    method: 'PUT',
    token: loginB.data.token,
    body: { baseRevision: 1, envelope: envelopeA }
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.error.code, 'REVISION_CONFLICT');
  assert.equal(conflict.data.revision, 2);
  assert.equal(conflict.data.envelope, envelopeB);

  const wrongPassword = await request(server.baseUrl, '/api/auth/login', {
    method: 'POST',
    body: {
      email,
      authProof: deriveAuthProof(
        deriveMasterKey('wrong password entirely', email),
        meta.authContext
      )
    }
  });
  assert.equal(wrongPassword.status, 401);
  assert.equal(wrongPassword.data.error.code, 'INVALID_CREDENTIALS');

  const otherVaultKey = deriveKeys({
    password: 'another account password',
    email: 'other@example.test',
    authContext: meta.authContext,
    vaultSalt: registered.data.vaultSalt
  }).vaultKey;
  assert.throws(() => decryptVault(stored.envelope, otherVaultKey, userId), /Không thể giải mã/);
});

test('login from a second device fails with the wrong password', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const meta = await serverMeta(server.baseUrl);
  const email = 'device-b@example.test';
  const master = deriveMasterKey(PASSWORD, email);
  const registered = await request(server.baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { email, authProof: deriveAuthProof(master, meta.authContext) }
  });
  assert.equal(registered.status, 201);
  const wrong = await request(server.baseUrl, '/api/auth/login', {
    method: 'POST',
    body: {
      email,
      authProof: deriveAuthProof(deriveMasterKey('not the same password', email), meta.authContext)
    }
  });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.data.error.code, 'INVALID_CREDENTIALS');
});
