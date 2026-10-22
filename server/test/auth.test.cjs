'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, request, randomProof } = require('./helpers.cjs');

async function register(context, email, proof = randomProof()) {
  return request(context.baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { email, authProof: proof }
  });
}

test('meta exposes auth context and limits', async (t) => {
  const context = await startServer();
  t.after(() => context.close());
  const first = await request(context.baseUrl, '/api/meta');
  const second = await request(context.baseUrl, '/api/meta');
  assert.equal(first.status, 200);
  assert.equal(typeof first.data.authContext, 'string');
  assert.equal(first.data.authContext, second.data.authContext);
  assert.equal(first.data.kdfVersion, 1);
  assert.equal(first.data.minPasswordLength, 10);
  assert.equal(first.data.maxVaultBytes, 5 * 1024 * 1024);
});

test('register, login, me and logout', async (t) => {
  const context = await startServer();
  t.after(() => context.close());
  const proof = randomProof();
  const registered = await register(context, ' User@Example.com ', proof);
  assert.equal(registered.status, 201);
  assert.equal(registered.data.user.email, 'user@example.com');
  assert.equal(registered.data.revision, 0);
  assert.equal(typeof registered.data.token, 'string');
  assert.equal(typeof registered.data.vaultSalt, 'string');

  const me = await request(context.baseUrl, '/api/auth/me', { token: registered.data.token });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.email, 'user@example.com');
  assert.equal(me.data.vaultSalt, registered.data.vaultSalt);

  const login = await request(context.baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: 'user@example.com', authProof: proof }
  });
  assert.equal(login.status, 200);
  assert.notEqual(login.data.token, registered.data.token);

  const logout = await request(context.baseUrl, '/api/auth/logout', {
    method: 'POST',
    token: login.data.token
  });
  assert.equal(logout.status, 204);
  const afterLogout = await request(context.baseUrl, '/api/auth/me', { token: login.data.token });
  assert.equal(afterLogout.status, 401);
});

test('duplicate email and wrong proof are rejected', async (t) => {
  const context = await startServer();
  t.after(() => context.close());
  const proof = randomProof();
  assert.equal((await register(context, 'same@example.com', proof)).status, 201);
  const duplicate = await register(context, 'SAME@example.com');
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.data.error.code, 'EMAIL_TAKEN');

  const wrong = await request(context.baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: 'same@example.com', authProof: randomProof() }
  });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.data.error.code, 'INVALID_CREDENTIALS');
});

test('invalid auth proof and unknown session are rejected', async (t) => {
  const context = await startServer();
  t.after(() => context.close());
  const invalid = await register(context, 'bad@example.com', 'short');
  assert.equal(invalid.status, 400);
  assert.equal(invalid.data.error.code, 'INVALID_AUTH_PROOF');
  const unknown = await request(context.baseUrl, '/api/auth/me', { token: 'a'.repeat(43) });
  assert.equal(unknown.status, 401);
});

test('expired session is rejected even if token exists', async (t) => {
  const context = await startServer();
  t.after(() => context.close());
  const registered = await register(context, 'expired@example.com');
  assert.equal(registered.status, 201);
  context.db.prepare('UPDATE sessions SET expires_at = ?').run('2000-01-01T00:00:00.000Z');
  const me = await request(context.baseUrl, '/api/auth/me', { token: registered.data.token });
  assert.equal(me.status, 401);
  assert.equal(me.data.error.code, 'SESSION_EXPIRED');
});

test('auth rate limit returns retry-after', async (t) => {
  const context = await startServer({
    rateLimit: { enabled: true, authIp: 2, authEmail: 2, vaultUser: 100, windowMs: 60_000 }
  });
  t.after(() => context.close());
  const registered = await register(context, 'limit@example.com');
  assert.equal(registered.status, 201);
  const second = await request(context.baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: 'limit@example.com', authProof: randomProof() }
  });
  assert.equal(second.status, 401);
  const third = await request(context.baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: 'limit@example.com', authProof: randomProof() }
  });
  assert.equal(third.status, 429);
  assert.equal(third.data.error.code, 'RATE_LIMITED');
  assert.ok(Number(third.headers.get('retry-after')) >= 1);
});

test('registration can be disabled', async (t) => {
  const context = await startServer({ allowRegistration: false });
  t.after(() => context.close());
  const response = await register(context, 'closed@example.com');
  assert.equal(response.status, 403);
  assert.equal(response.data.error.code, 'REGISTRATION_DISABLED');
});
