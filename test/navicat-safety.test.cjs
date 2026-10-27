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
