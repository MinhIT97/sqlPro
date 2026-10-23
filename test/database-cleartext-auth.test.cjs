'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSession } = require('../electron/database.cjs');

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
});
