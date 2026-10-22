'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, request, randomProof } = require('./helpers.cjs');

async function account(context, email) {
  const response = await request(context.baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { email, authProof: randomProof() }
  });
  assert.equal(response.status, 201);
  return response.data;
}

test('vault starts empty and stores revisions', async (t) => {
  const context = await startServer();
  t.after(() => context.close());
  const user = await account(context, 'vault@example.com');

  const empty = await request(context.baseUrl, '/api/vault', { token: user.token });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data, { revision: 0, envelope: null, updatedAt: null });

  const first = await request(context.baseUrl, '/api/vault', {
    method: 'PUT',
    token: user.token,
    body: { baseRevision: 0, envelope: 'v1.aaaa.bbbb.cccc' }
  });
  assert.equal(first.status, 200);
  assert.equal(first.data.revision, 1);

  const read = await request(context.baseUrl, '/api/vault', { token: user.token });
  assert.equal(read.status, 200);
  assert.equal(read.data.revision, 1);
  assert.equal(read.data.envelope, 'v1.aaaa.bbbb.cccc');

  const second = await request(context.baseUrl, '/api/vault', {
    method: 'PUT',
    token: user.token,
    body: { baseRevision: 1, envelope: 'v1.dddd.eeee.ffff' }
  });
  assert.equal(second.status, 200);
  assert.equal(second.data.revision, 2);
});

test('stale revision returns current envelope', async (t) => {
  const context = await startServer();
  t.after(() => context.close());
  const user = await account(context, 'conflict@example.com');
  const first = await request(context.baseUrl, '/api/vault', {
    method: 'PUT',
    token: user.token,
    body: { baseRevision: 0, envelope: 'current-envelope' }
  });
  assert.equal(first.status, 200);
  const conflict = await request(context.baseUrl, '/api/vault', {
    method: 'PUT',
    token: user.token,
    body: { baseRevision: 0, envelope: 'stale-envelope' }
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.error.code, 'REVISION_CONFLICT');
  assert.equal(conflict.data.revision, 1);
  assert.equal(conflict.data.envelope, 'current-envelope');
  const read = await request(context.baseUrl, '/api/vault', { token: user.token });
  assert.equal(read.data.envelope, 'current-envelope');
});

test('vaults are isolated per user', async (t) => {
  const context = await startServer();
  t.after(() => context.close());
  const alice = await account(context, 'alice@example.com');
  const bob = await account(context, 'bob@example.com');
  const put = await request(context.baseUrl, '/api/vault', {
    method: 'PUT',
    token: alice.token,
    body: { baseRevision: 0, envelope: 'alice-secret' }
  });
  assert.equal(put.status, 200);
  const bobVault = await request(context.baseUrl, '/api/vault', { token: bob.token });
  assert.equal(bobVault.status, 200);
  assert.equal(bobVault.data.envelope, null);
});

test('vault size and payload validation', async (t) => {
  const context = await startServer({ maxVaultBytes: 1024 });
  t.after(() => context.close());
  const user = await account(context, 'large@example.com');
  const tooLarge = await request(context.baseUrl, '/api/vault', {
    method: 'PUT',
    token: user.token,
    body: { baseRevision: 0, envelope: 'x'.repeat(2048) }
  });
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.data.error.code, 'VAULT_TOO_LARGE');

  const invalidRevision = await request(context.baseUrl, '/api/vault', {
    method: 'PUT',
    token: user.token,
    body: { baseRevision: 'zero', envelope: 'small' }
  });
  assert.equal(invalidRevision.status, 400);
  assert.equal(invalidRevision.data.error.code, 'INVALID_REVISION');
});
