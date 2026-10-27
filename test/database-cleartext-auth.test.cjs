'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSession, classifyConnectionError, sshErrorCode } = require('../electron/database.cjs');

test('mysql_clear_password chỉ bật khi TLS xác thực chứng chỉ', () => {
  const profile = { host: 'db.example', port: 3306, user: 'user', allowCleartextPassword: true };
  assert.throws(
    () => new DatabaseSession(profile).buildMysqlOptions(),
    /TLS đã xác thực/
  );
  assert.throws(
    () => new DatabaseSession({ ...profile, ssl: { enabled: true, verify: false } }).buildMysqlOptions(),
    /TLS đã xác thực/
  );
  const options = new DatabaseSession({ ...profile, ssl: { enabled: true, verify: true } }).buildMysqlOptions();
  assert.equal(options.enableCleartextPlugin, true);
  assert.equal(options.ssl.rejectUnauthorized, true);
  assert.equal(new DatabaseSession({ ...profile, allowCleartextPassword: false }).buildMysqlOptions().enableCleartextPlugin, undefined);
});

test('mysql_clear_password chấp nhận SSH tunnel tới MySQL trên chính máy SSH', () => {
  const base = {
    host: '127.0.0.1',
    port: 3306,
    user: 'user',
    allowCleartextPassword: true,
    ssh: { enabled: true, host: 'jump.example', port: 22, knownHostKey: { host: 'jump.example', port: 22, fingerprint: 'SHA256:trusted' } }
  };
  const options = new DatabaseSession(base).buildMysqlOptions({});
  assert.equal(options.enableCleartextPlugin, true);
  assert.equal(options.ssl, undefined);
  assert.throws(
    () => new DatabaseSession({ ...base, host: 'db.internal' }).buildMysqlOptions({}),
    /SSH tunnel đã xác thực host key/
  );
  assert.throws(
    () => new DatabaseSession({ ...base, ssh: { enabled: true, host: 'jump.example', port: 22 } }).buildMysqlOptions({}),
    /SSH tunnel đã xác thực host key/
  );
  assert.throws(
    () => new DatabaseSession({ ...base, host: 'db.internal' }).buildMysqlOptions({}),
    (error) => error.code === 'CLEARTEXT_AUTH_INSECURE_TRANSPORT'
  );
});

test('legacy TLS profiles without verify keep unverified behavior; explicit values are honored', () => {
  const base = { host: 'db.example', port: 3306, user: 'user' };
  assert.equal(new DatabaseSession({ ...base, ssl: { enabled: true } }).buildMysqlOptions().ssl.rejectUnauthorized, false);
  assert.equal(new DatabaseSession({ ...base, ssl: { enabled: true, verify: false } }).buildMysqlOptions().ssl.rejectUnauthorized, false);
  assert.equal(new DatabaseSession({ ...base, ssl: { enabled: true, verify: true } }).buildMysqlOptions().ssl.rejectUnauthorized, true);
  assert.equal(new DatabaseSession(base).buildMysqlOptions().ssl, undefined);
  assert.throws(
    () => new DatabaseSession({ ...base, ssl: { enabled: true, verify: true, ca: '/nonexistent/sqlpro-ca.pem' } }).buildMysqlOptions(),
    (error) => error.code === 'SSL_FILE_READ_FAILED'
  );
});

test('connection errors distinguish TLS certificate, handshake, cleartext, MySQL auth and SSH failures', () => {
  const cases = [
    [{ code: 'CERT_HAS_EXPIRED', message: 'certificate has expired' }, 'TLS_CERT_EXPIRED'],
    [{ code: 'HANDSHAKE_SSL_ERROR', message: 'certificate is not yet valid' }, 'TLS_CERT_EXPIRED'],
    [{ code: 'HANDSHAKE_SSL_ERROR', message: "Hostname/IP does not match certificate's altnames: Host: db.example" }, 'TLS_CERT_HOSTNAME_MISMATCH'],
    [{ code: 'HANDSHAKE_SSL_ERROR', message: 'self-signed certificate in certificate chain' }, 'TLS_CERT_UNTRUSTED'],
    [{ code: 'HANDSHAKE_SSL_ERROR', message: 'wrong version number' }, 'TLS_HANDSHAKE_FAILED'],
    [{ code: 'HANDSHAKE_NO_SSL_SUPPORT', message: 'Server does not support secure connection' }, 'TLS_NOT_SUPPORTED'],
    [{ code: 'MYSQL_CLEAR_PASSWORD_NOT_ENABLED', message: 'Server requested authentication using mysql_clear_password' }, 'MYSQL_CLEARTEXT_AUTH_REQUIRED']
  ];
  for (const [input, expected] of cases) {
    const error = Object.assign(new Error(input.message), { code: input.code });
    const classified = classifyConnectionError(error);
    assert.equal(classified.code, expected, input.message);
    assert.equal(classified.originalCode, input.code);
    assert.equal(classified.cause, error);
  }
  const mysqlAuth = Object.assign(new Error('Access denied for user'), { code: 'ER_ACCESS_DENIED_ERROR' });
  assert.equal(classifyConnectionError(mysqlAuth), mysqlAuth);
  const network = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  assert.equal(classifyConnectionError(network), network);

  assert.equal(sshErrorCode({ level: 'client-authentication', message: 'All configured authentication methods failed' }), 'SSH_AUTH_FAILED');
  assert.equal(sshErrorCode({ message: 'Timed out while waiting for handshake' }), 'SSH_TIMEOUT');
  assert.equal(sshErrorCode({ message: 'connect ECONNREFUSED' }), 'SSH_CONNECTION_FAILED');
});
