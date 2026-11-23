'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

function parserFixture(readFileSync) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/navicat.cjs'), 'utf8'), {
    module, Buffer,
    require: (id) => id === 'node:fs' ? { readFileSync } : require(id)
  });
  return module.exports;
}

test('retired Navicat writer never loads filesystem, child process, keys or profiles and emits no secret', () => {
  const messages = [];
  const module = { exports: {} };
  const request = () => { throw new Error('Legacy entry must not load dependencies'); };
  request.main = module;
  const processStub = { stderr: { write: (text) => messages.push(text) } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../scripts/sync-navicat-passwords.cjs'), 'utf8'), {
    module, require: request, process: processStub
  });
  assert.equal(processStub.exitCode, 1);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /disabled.*Import Navicat connections/);
});

test('Python Navicat diagnostic cannot disclose profile/credential fixtures through stdout, errors or options', (t) => {
  const candidates = process.platform === 'win32' ? [['python', []], ['py', ['-3']]] : [['python3', []], ['python', []]];
  const python = candidates.find(([name, args]) => spawnSync(name, [...args, '--version'], { windowsHide: true }).status === 0);
  if (!python) { t.skip('Python 3 is not installed'); return; }
  const result = spawnSync(python[0], [...python[1], '-I', path.join(__dirname, 'navicat-scripts-safety.py')], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Ran 4 tests/);
});

test('Navicat parse/I/O errors never expose malformed plaintext, exception strings or private paths', () => {
  const marker = 'synthetic-credential-canary';
  for (const read of [() => `{"Password":"${marker}",BROKEN}`, () => { throw new Error(marker); }]) {
    const parser = parserFixture(read);
    assert.throws(() => parser.parseNavicatFile(marker), (error) => {
      assert.equal(error.code, 'NAVICAT_IMPORT_FAILED');
      assert.equal(String(error).includes(marker), false);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test('supported encrypted Navicat imports still decode only in memory without logging', () => {
  const marker = 'synthetic-import-fixture';
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from('libcckeylibcckey'), Buffer.from('libcciv libcciv '));
  const encrypted = Buffer.concat([cipher.update(marker, 'utf8'), cipher.final()]).toString('hex');
  const parser = parserFixture(() => JSON.stringify({ Connections: [{ Name: 'fixture', Hostname: 'fixture.example', Username: 'fixture', Password: encrypted }] }));
  const imported = parser.parseNavicatFile('fixture.json');
  assert.equal(imported.connections[0].password, marker);
  assert.equal(imported.connections.length, 1);
});

test('new Navicat imports require TLS certificate verification unless the file explicitly disables it', () => {
  const base = { Hostname: 'db.example', Username: 'fixture', UseSSL: true };
  const parser = parserFixture(() => JSON.stringify({ Connections: [
    { ...base, Name: 'implicit' },
    { ...base, Name: 'explicit-off', SSL: { VerifyCA: false } },
    { ...base, Name: 'explicit-on', SSL: { VerifyCA: true } }
  ] }));
  const imported = parser.parseNavicatFile('fixture.json').connections;
  assert.equal(imported.find((entry) => entry.name === 'implicit').ssl.verify, true);
  assert.equal(imported.find((entry) => entry.name === 'explicit-off').ssl.verify, false);
  assert.equal(imported.find((entry) => entry.name === 'explicit-on').ssl.verify, true);
});

test('Navicat TLS weak-validation flags preserve verification unless explicitly enabled', () => {
  for (const [verifyCa, weak, expected] of [
    [undefined, false, true], [undefined, '0', true], [undefined, true, false],
    [true, false, true], [true, true, false], [false, false, false],
    [null, false, true], ['', false, true], ['unknown', false, true], [0, false, false], ['FALSE', false, false]
  ]) {
    const parser = parserFixture(() => JSON.stringify({ Connections: [{ Hostname: 'db.example', UseSSL: true,
      SSL: { VerifyCA: verifyCa, WeakCertValidation: weak } }] }));
    assert.equal(parser.parseNavicatFile('fixture.json').connections[0].ssl.verify, expected);
  }
  for (const [weak, expected] of [['false', true], ['0', true], ['true', false]]) {
    const parser = parserFixture(() => `<Connections><Connection Host='db.example' SSL='true' SSL_WeakCertValidation='${weak}' /></Connections>`);
    assert.equal(parser.parseNavicatFile('fixture.ncx').connections[0].ssl.verify, expected);
  }
});

test('Navicat XML supports quoted >, both attribute quotes and exactly one entity decoding pass', () => {
  const parser = parserFixture(() => `<?xml version="1.0"?><Connections>
    <!-- <Connection Host="comment.invalid" /> -->
    <![CDATA[<Connection Host="cdata.invalid" />]]>
    <Connection ConnectionName="prod > standby &amp; &quot;report&quot;" Host='db.example' UserName="fixture" />
    <Connection ConnectionName='it&apos;s > &#x42; &#67; &#38;quot;' Host="other.example" UserName='fixture'></Connection>
    <Connection ConnType="POSTGRESQL" Host="unsupported.example" />
  </Connections>`);
  const result = parser.parseNavicatFile('fixture.ncx');
  assert.equal(result.connections.length, 2);
  assert.equal(result.skipped, 1);
  assert.equal(result.connections[0].name, 'prod > standby & "report"');
  assert.equal(result.connections[0].host, 'db.example');
  assert.equal(result.connections[1].name, "it's > B C &quot;");
  assert.equal(result.connections[1].host, 'other.example');
});

test('Navicat password decoding preserves data resembling padding and rejects invalid UTF-8', () => {
  const parser = parserFixture(() => '');
  const encrypt = bytes => {
    const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from('libcckeylibcckey'), Buffer.from('libcciv libcciv '));
    return Buffer.concat([cipher.update(bytes), cipher.final()]);
  };
  const passwords = ['', 'fixture\u0000', 'fixture�', 'mật khẩu'];
  for (let pad = 1; pad <= 16; pad++) passwords.push('fixture' + String.fromCharCode(pad).repeat(pad));
  for (const password of passwords) {
    const encrypted = encrypt(Buffer.from(password));
    for (const encoding of ['hex', 'base64']) assert.equal(parser.decryptPassword(encrypted.toString(encoding)), password);
  }
  assert.equal(parser.decryptPassword(encrypt(Buffer.from([0xff])).toString('hex')), '');
  assert.equal(parser.decryptPassword('invalid-ciphertext'), '');
});
