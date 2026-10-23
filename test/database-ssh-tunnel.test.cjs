'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const key = Buffer.from('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestOnlyKeyMaterial');
const otherKey = Buffer.from('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherKeyMaterial');

class FakeSshClient {
  static instances = [];
  static accepted = true;

  constructor() {
    this.handlers = {};
    this.ended = false;
    this.forwarded = null;
    FakeSshClient.instances.push(this);
  }

  on(event, handler) {
    this.handlers[event] = handler;
    return this;
  }

  connect(options) {
    this.options = options;
    FakeSshClient.accepted = options.hostVerifier(key);
    if (!FakeSshClient.accepted) {
      setImmediate(() => this.handlers.error?.(new Error('Host key verification failed')));
      return;
    }
    setImmediate(() => this.handlers.ready?.());
  }

  forwardOut(sourceHost, sourcePort, targetHost, targetPort, callback) {
    this.forwarded = { sourceHost, sourcePort, targetHost, targetPort };
    callback(null, { destroy() {} });
  }

  end() {
    this.ended = true;
  }
}

const sshPath = require.resolve('ssh2');
const originalSshModule = require.cache[sshPath];
require.cache[sshPath] = {
  id: sshPath,
  filename: sshPath,
  loaded: true,
  exports: { Client: FakeSshClient }
};
const databasePath = require.resolve('../electron/database.cjs');
delete require.cache[databasePath];
const { DatabaseSession, sshHostKeyFingerprint } = require('../electron/database.cjs');
if (originalSshModule) require.cache[sshPath] = originalSshModule;
else delete require.cache[sshPath];
delete require.cache[databasePath];

function profile(knownHostKey) {
  return {
    host: '127.0.0.1',
    port: 3306,
    user: 'db',
    ssh: { enabled: true, host: 'jump.example', port: 22, user: 'ssh', password: 'secret', knownHostKey }
  };
}

test('SSH tunnel dừng trước khi forward khi khóa lần đầu chưa được tin cậy', async () => {
  const session = new DatabaseSession(profile(null));
  await assert.rejects(session.openSshTunnel(), (error) => {
    assert.equal(error.code, 'SSH_HOST_KEY_UNKNOWN');
    assert.equal(error.fingerprint, sshHostKeyFingerprint(key));
    return true;
  });
  const client = FakeSshClient.instances.at(-1);
  assert.equal(client.forwarded, null);
  assert.equal(client.ended, true);
});

test('SSH tunnel chặn host key thay đổi và giữ fingerprint cũ để so sánh', async () => {
  const knownHostKey = { host: 'jump.example', port: 22, fingerprint: sshHostKeyFingerprint(otherKey) };
  const session = new DatabaseSession(profile(knownHostKey));
  await assert.rejects(session.openSshTunnel(), (error) => {
    assert.equal(error.code, 'SSH_HOST_KEY_CHANGED');
    assert.equal(error.fingerprint, sshHostKeyFingerprint(key));
    assert.equal(error.expectedFingerprint, knownHostKey.fingerprint);
    return true;
  });
  assert.equal(FakeSshClient.instances.at(-1).forwarded, null);
});

test('SSH tunnel đã tin cậy mở forward tới đúng host/port MySQL', async () => {
  const knownHostKey = { host: 'jump.example', port: 22, fingerprint: sshHostKeyFingerprint(key) };
  const session = new DatabaseSession(profile(knownHostKey));
  const stream = await session.openSshTunnel();
  assert.ok(stream);
  const client = FakeSshClient.instances.at(-1);
  assert.deepEqual(client.forwarded, {
    sourceHost: '127.0.0.1',
    sourcePort: 0,
    targetHost: '127.0.0.1',
    targetPort: 3306
  });
  assert.equal(client.ended, false);
});

test('đổi SSH host hoặc port yêu cầu tin cậy lại', async () => {
  const knownHostKey = { host: 'other.example', port: 22, fingerprint: sshHostKeyFingerprint(key) };
  await assert.rejects(new DatabaseSession(profile(knownHostKey)).openSshTunnel(), (error) => {
    assert.equal(error.code, 'SSH_HOST_KEY_UNKNOWN');
    return true;
  });
  const otherPort = { host: 'jump.example', port: 2222, fingerprint: sshHostKeyFingerprint(key) };
  await assert.rejects(new DatabaseSession(profile(otherPort)).openSshTunnel(), (error) => {
    assert.equal(error.code, 'SSH_HOST_KEY_UNKNOWN');
    return true;
  });
});
