'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  normalizeEmail,
  deriveMasterKey,
  deriveAuthProof,
  deriveVaultKey,
  deriveKeys,
  encryptVault,
  decryptVault
} = require('../electron/sync-crypto.cjs');

const password = 'correct horse battery staple';
const email = ' User@Example.com ';
const authContext = crypto.randomBytes(16).toString('base64url');
const vaultSalt = crypto.randomBytes(16).toString('base64url');
const userId = 'user-123';

test('email normalization and master key are deterministic', () => {
  assert.equal(normalizeEmail(email), 'user@example.com');
  const first = deriveMasterKey(password, email);
  const second = deriveMasterKey(password, 'user@example.com');
  assert.equal(first.toString('hex'), second.toString('hex'));
  assert.notEqual(first.toString('hex'), deriveMasterKey('other password', email).toString('hex'));
});

test('auth proof and vault key depend on their contexts', () => {
  const master = deriveMasterKey(password, email);
  const proof = deriveAuthProof(master, authContext);
  const otherContext = crypto.randomBytes(16).toString('base64url');
  assert.match(proof, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(proof, deriveAuthProof(master, authContext));
  assert.notEqual(proof, deriveAuthProof(master, otherContext));
  const key = deriveVaultKey(master, vaultSalt);
  const otherSalt = crypto.randomBytes(16).toString('base64url');
  assert.equal(key.length, 32);
  assert.notEqual(key.toString('hex'), deriveVaultKey(master, otherSalt).toString('hex'));
});

test('deriveKeys returns both client keys', () => {
  const keys = deriveKeys({ password, email, authContext, vaultSalt });
  assert.match(keys.authProof, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(keys.vaultKey.length, 32);
});

test('vault encrypt/decrypt roundtrip hides plaintext', () => {
  const { vaultKey } = deriveKeys({ password, email, authContext, vaultSalt });
  const vault = {
    version: 1,
    workspaces: [{ id: 'ws-personal', name: 'Cá nhân' }],
    connections: [{ id: 'c1', host: 'db.internal', password: 'super-secret' }]
  };
  const envelope = encryptVault(vault, vaultKey, userId);
  assert.match(envelope, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(envelope.includes('db.internal'), false);
  assert.equal(envelope.includes('super-secret'), false);
  assert.deepEqual(decryptVault(envelope, vaultKey, userId), vault);
});

test('wrong key, wrong user and tampering fail', () => {
  const { vaultKey } = deriveKeys({ password, email, authContext, vaultSalt });
  const envelope = encryptVault({ hello: 'world' }, vaultKey, userId);
  assert.throws(() => decryptVault(envelope, crypto.randomBytes(32), userId), /Không thể giải mã/);
  assert.throws(() => decryptVault(envelope, vaultKey, 'someone-else'), /Không thể giải mã/);
  const parts = envelope.split('.');
  const data = Buffer.from(parts[3], 'base64url');
  data[0] ^= 1;
  parts[3] = data.toString('base64url');
  assert.throws(() => decryptVault(parts.join('.'), vaultKey, userId), /Không thể giải mã/);
  assert.throws(() => decryptVault('not-an-envelope', vaultKey, userId), /Vault không hợp lệ/);
});
