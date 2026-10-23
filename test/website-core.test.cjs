'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const core = require('../website/core.js');

test('localhost configuration binds only loopback and preserves data in a volume', () => {
  const config = core.buildHostConfiguration({ mode: 'local', port: '9090', registration: true });
  assert.equal(config.url, 'http://localhost:9090');
  assert.deepEqual(Object.keys(config.files), ['.env', 'compose.yaml']);
  assert.match(config.files['.env'], /^PORT=9090\n/);
  assert.match(config.files['.env'], /ALLOW_REGISTRATION=true\nTRUST_PROXY=0/);
  assert.match(config.files['compose.yaml'], /127\.0\.0\.1:\$\{PORT\}:\$\{PORT\}/);
  assert.match(config.files['compose.yaml'], /sqlpro-data:\/data/);
  assert.doesNotMatch(config.files['compose.yaml'], /caddy/);
});

test('HTTPS configuration exposes Caddy only and keeps service and proxy ports consistent', () => {
  const config = core.buildHostConfiguration({ mode: 'https', port: '3030', domain: 'SYNC.Example.com', registration: false });
  assert.equal(config.url, 'https://sync.example.com');
  assert.match(config.files['.env'], /ALLOW_REGISTRATION=false\nTRUST_PROXY=1/);
  assert.match(config.files.Caddyfile, /^sync\.example\.com \{\n  reverse_proxy sqlpro:3030\n\}\n$/);
  const appService = config.files['compose.yaml'].split('  caddy:')[0];
  assert.doesNotMatch(appService, /ports:/);
  assert.match(appService, /expose:/);
  assert.match(config.files['compose.yaml'], /"80:80"/);
  assert.match(config.files['compose.yaml'], /"443:443"/);
});

test('configuration rejects invalid ports, modes and domain injection', () => {
  for (const port of ['', 0, 65536, '1.5', '1e3', '8080\nTRUST_PROXY=true', '-1']) {
    assert.throws(() => core.buildHostConfiguration({ mode: 'local', port }), /invalidPort/);
  }
  for (const domain of ['', 'localhost', '127.0.0.1', 'https://example.com', 'example.com/path', 'a.com\n} :80 {', 'a.com:8080', '-a.com', 'a..com', '*.example.com']) {
    assert.throws(() => core.buildHostConfiguration({ mode: 'https', port: 8080, domain }), /invalidDomain/);
  }
  assert.throws(() => core.buildHostConfiguration({ mode: 'unknown', port: 8080 }), /invalidMode/);
});

test('documentation search matches Vietnamese without accents and multiple terms', () => {
  assert.equal(core.matchesSearch('Đồng bộ dữ liệu connection SSH', 'dong bo'), true);
  assert.equal(core.matchesSearch('SSH_HOST_KEY_CHANGED: kiểm tra host key', 'ssh changed'), true);
  assert.equal(core.matchesSearch('Backup database', 'backup ssl'), false);
  assert.equal(core.matchesSearch('Anything', '   '), true);
});

test('release metadata rejects malformed checksums and invalid values', () => {
  for (const digest of [null, 'sha256:123', `md5:${'a'.repeat(64)}`, '<script>']) assert.equal(core.releaseDigest({ digest }), '');
  assert.equal(core.releaseDigest({ digest: `sha256:${'A'.repeat(64)}` }), 'a'.repeat(64));
  assert.equal(core.formatDate('bad date'), '');
  assert.equal(core.formatBytes(0), '0 B');
  assert.equal(core.formatBytes(NaN, 'en'), 'File size not available');
  assert.equal(core.formatBytes(0.5, 'en'), '0.5 B');
});
