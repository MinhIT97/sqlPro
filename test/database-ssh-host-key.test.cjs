'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sshHostKeyFingerprint, verifySshHostKey } = require('../electron/database.cjs');

const key = Buffer.from('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestOnlyKeyMaterial');
const otherKey = Buffer.from('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherKeyMaterial');
const fingerprint = sshHostKeyFingerprint(key);

test('SSH fingerprint is stable SHA-256 and strips base64 padding', () => {
  assert.match(fingerprint, /^SHA256:[A-Za-z0-9+/]+$/);
  assert.equal(fingerprint, sshHostKeyFingerprint(Buffer.from(key)));
  assert.notEqual(fingerprint, sshHostKeyFingerprint(otherKey));
});

test('unknown SSH host key stops before trust and returns fingerprint', () => {
  const result = verifySshHostKey(null, 'jump.example', 22, key);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SSH_HOST_KEY_UNKNOWN');
  assert.equal(result.fingerprint, fingerprint);
  assert.match(result.message, /Chưa tin cậy/);
});

test('trusted SSH host key is accepted for the same host and port', () => {
  const result = verifySshHostKey(
    { host: 'jump.example', port: 22, fingerprint },
    'jump.example',
    22,
    key
  );
  assert.equal(result.ok, true);
  assert.equal(result.fingerprint, fingerprint);
});

test('changed SSH host key is blocked and reports both fingerprints', () => {
  const result = verifySshHostKey(
    { host: 'jump.example', port: 22, fingerprint },
    'jump.example',
    22,
    otherKey
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SSH_HOST_KEY_CHANGED');
  assert.equal(result.fingerprint, sshHostKeyFingerprint(otherKey));
  assert.equal(result.expectedFingerprint, fingerprint);
});

test('changing host or port requires a new trust decision', () => {
  const known = { host: 'jump.example', port: 22, fingerprint };
  assert.equal(verifySshHostKey(known, 'other.example', 22, key).code, 'SSH_HOST_KEY_UNKNOWN');
  assert.equal(verifySshHostKey(known, 'jump.example', 2222, key).code, 'SSH_HOST_KEY_UNKNOWN');
  assert.equal(verifySshHostKey({ ...known, host: 'JUMP.Example' }, 'jump.example', 22, key).ok, true);
});
