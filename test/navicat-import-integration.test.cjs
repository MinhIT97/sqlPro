'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');

test('real MySQL authentication accepts a Navicat-imported empty password after replacing a saved nonempty password', {
  skip: !process.env.SQLPRO_TEST_MYSQL_PORT, timeout: 30000
}, async () => {
  const port = Number(process.env.SQLPRO_TEST_MYSQL_PORT), host = '127.0.0.1';
  const username = `sqlpro_import_${crypto.randomBytes(8).toString('hex')}`;
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-navicat-auth-'));
  const directory = path.join(__dirname, '../electron'), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(directory, 'store.cjs'), 'utf8'), {
    module, Buffer, require: id => id === 'electron'
      ? { app: { getPath: () => userData }, safeStorage: { isEncryptionAvailable: () => false } }
      : require(id.startsWith('./') ? path.join(directory, id) : id)
  });
  const store = module.exports, secret = 'synthetic-original-password';
  const imported = password => {
    const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from('libcckeylibcckey'), Buffer.from('libcciv libcciv '));
    const encoded = Buffer.concat([cipher.update(password), cipher.final()]).toString('hex');
    const text = JSON.stringify({ Connections: [{ Name: 'fixture', Hostname: host, Port: port, Username: username, Password: encoded }] });
    const parser = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(directory, 'navicat.cjs'), 'utf8'), {
      module: parser, Buffer, require: id => id === 'node:fs' ? { readFileSync: () => text } : require(id)
    });
    return parser.exports.parseNavicatFile('fixture.json').connections;
  };
  let admin, connection, created = false;
  try {
    admin = await mysql.createConnection({ host, port, user: 'root', connectTimeout: 5000 });
    await admin.query('CREATE USER ?@? IDENTIFIED BY ?', [username, host, secret]); created = true;
    const first = store.importMany(imported(secret)).connections[0];
    connection = await mysql.createConnection({ host, port, user: username, password: store.getWithSecrets(first.id).password });
    await connection.query('SELECT 1'); await connection.end(); connection = null;
    await admin.query('ALTER USER ?@? IDENTIFIED BY ?', [username, host, '']);
    const result = store.importMany(imported(''));
    assert.equal(result.updated, 1);
    const current = store.getWithSecrets(first.id);
    assert.equal(current.password, ''); assert.equal(result.connections[0].hasPassword, false);
    connection = await mysql.createConnection({ host, port, user: username, password: current.password });
    const [rows] = await connection.query('SELECT 1 AS verified'); assert.equal(rows[0].verified, 1);
  } finally {
    try { await connection?.end(); }
    finally {
      try { if (created) await admin.query('DROP USER ?@?', [username, host]); }
      finally { await admin?.end(); fs.rmSync(userData, { recursive: true, force: true }); }
    }
  }
});
