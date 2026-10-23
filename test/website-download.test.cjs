'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../website/app.js'), 'utf8');
const coreSource = fs.readFileSync(path.join(__dirname, '../website/core.js'), 'utf8');
const releasesUrl = 'https://github.com/MinhIT97/sqlPro/releases';

function downloadLink() {
  const label = { textContent: 'Kiểm tra bản phát hành…' };
  return {
    href: releasesUrl,
    hidden: true,
    label,
    querySelector: (selector) => selector === 'strong' ? label : null
  };
}

async function renderDownloads(fetch, overrides = {}, language = 'vi') {
  const elements = new Map([
    ['#downloadLinux', downloadLink()],
    ['#downloadWindows', downloadLink()],
    ['#downloadAppImage', downloadLink()],
    ['#downloadPortable', downloadLink()],
    ['#downloadAlternatives', { hidden: true }],
    ['#downloadStatus', { textContent: '' }]
  ]);
  for (const id of ['downloadLinux', 'downloadWindows', 'downloadAppImage', 'downloadPortable']) {
    elements.set(`[data-release-meta="${id}"]`, { textContent: '' });
    elements.set(`[data-checksum="${id}"]`, { hidden: true });
    elements.set(`#digest-${id}`, { textContent: '' });
    elements.set(`[data-download-card="${id}"]`, { hidden: true });
  }
  const document = {
    documentElement: { lang: language },
    querySelector: (selector) => elements.get(selector) || null,
    querySelectorAll: () => []
  };
  vm.runInNewContext(`${coreSource}\n${source}`, {
    document, window: { location: { hash: '' }, addEventListener() {} }, fetch, URL, AbortController, setTimeout, clearTimeout, ...overrides
  }, { filename: 'website/app.js' });
  await new Promise((resolve) => setImmediate(resolve));
  return elements;
}

function asset(name) {
  return {
    name,
    browser_download_url: `https://github.com/MinhIT97/sqlPro/releases/download/v0.3.5/${name}`
  };
}

test('download buttons link directly to the matching release assets', async () => {
  const assets = [
    asset('SqlPro-0.3.5-amd64.deb'),
    asset('SqlPro-0.3.5-x86_64.AppImage'),
    asset('SqlPro-Setup-0.3.5-x64.exe'),
    asset('SqlPro-Portable-0.3.5-x64.exe'),
    { name: 'SqlPro-Setup-0.3.5-x64.exe', browser_download_url: 'https://example.com/fake.exe' }
  ];
  const elements = await renderDownloads(async () => ({
    ok: true,
    json: async () => ({ tag_name: 'v0.3.5', assets })
  }));

  assert.equal(elements.get('#downloadLinux').href, assets[0].browser_download_url);
  assert.equal(elements.get('#downloadWindows').href, assets[2].browser_download_url);
  assert.equal(elements.get('#downloadAppImage').href, assets[1].browser_download_url);
  assert.equal(elements.get('#downloadPortable').href, assets[3].browser_download_url);
  assert.equal(elements.get('#downloadAppImage').label.textContent, 'Tải AppImage');
  assert.equal(elements.get('#downloadPortable').label.textContent, 'Tải Windows Portable');
  assert.equal(elements.get('#downloadAlternatives').hidden, false);
  assert.match(elements.get('#downloadStatus').textContent, /v0\.3\.5/);
});

test('without a GitHub Release, buttons lead to the release page with a clear status', async () => {
  const elements = await renderDownloads(async () => ({ status: 404, ok: false }));

  assert.equal(elements.get('#downloadLinux').href, releasesUrl);
  assert.equal(elements.get('#downloadWindows').href, releasesUrl);
  assert.equal(elements.get('#downloadLinux').label.textContent, 'Xem GitHub Releases');
  assert.equal(elements.get('#downloadAlternatives').hidden, true);
  assert.match(elements.get('#downloadStatus').textContent, /Chưa có bộ cài phù hợp/);
});

test('download selection ignores malformed assets and links outside the repository', async () => {
  const expected = asset('SqlPro-Setup-0.3.5-x64.exe');
  const unsafe = [
    null, {}, { name: 123 },
    { ...expected, browser_download_url: 'javascript:alert(1)' },
    { ...expected, browser_download_url: 'https://github.com.evil.example/MinhIT97/sqlPro/releases/download/v1/fake.exe' },
    { ...expected, browser_download_url: 'https://github.com/other/repo/releases/download/v1/fake.exe' },
    { ...expected, browser_download_url: 'https://username:password@github.com/MinhIT97/sqlPro/releases/download/v1/fake.exe' }
  ];
  const elements = await renderDownloads(async () => ({
    ok: true, json: async () => ({ assets: [...unsafe, expected] })
  }));

  assert.equal(elements.get('#downloadWindows').href, expected.browser_download_url);
  assert.equal(elements.get('#downloadLinux').href, releasesUrl);
  assert.doesNotMatch(elements.get('#downloadStatus').textContent, /undefined/);
});

test('network, HTTP and JSON errors keep working release-page links', async (t) => {
  for (const [name, fetch] of [
    ['network', async () => { throw new Error('offline'); }],
    ['rate limit', async () => ({ ok: false, status: 403 })],
    ['invalid JSON', async () => ({ ok: true, json: async () => { throw new SyntaxError('JSON'); } })]
  ]) {
    await t.test(name, async () => {
      const elements = await renderDownloads(fetch);
      assert.equal(elements.get('#downloadWindows').href, releasesUrl);
      assert.equal(elements.get('#downloadLinux').label.textContent, 'Xem GitHub Releases');
      assert.equal(elements.get('#downloadAlternatives').hidden, true);
      assert.match(elements.get('#downloadStatus').textContent, /Không kiểm tra được/);
    });
  }
});

test('a stalled release request is aborted and the timeout is cleaned up', async () => {
  let signal;
  let cleared = false;
  const elements = await renderDownloads((_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  }, {
    setTimeout: (callback) => setImmediate(callback),
    clearTimeout: (timer) => { cleared = true; clearImmediate(timer); }
  });

  assert.equal(signal.aborted, true);
  assert.equal(cleared, true);
  assert.match(elements.get('#downloadStatus').textContent, /Không kiểm tra được/);
});

test('download metadata displays the API digest, size and publication date', async () => {
  const file = { ...asset('SqlPro-Setup-0.3.5-x64.exe'), size: 2097152, digest: `sha256:${'a'.repeat(64)}` };
  const elements = await renderDownloads(async () => ({ ok: true, json: async () => ({ tag_name: 'v0.3.5', published_at: '2026-10-23T12:00:00Z', assets: [file] }) }));
  assert.equal(elements.get('#digest-downloadWindows').textContent, 'a'.repeat(64));
  assert.equal(elements.get('[data-checksum="downloadWindows"]').hidden, false);
  assert.match(elements.get('[data-release-meta="downloadWindows"]').textContent, /2 MiB/);
  assert.match(elements.get('[data-release-meta="downloadWindows"]').textContent, /2026/);
});

test('English fallback states are localized and absent digests remain hidden', async () => {
  const elements = await renderDownloads(async () => ({ ok: true, json: async () => ({ assets: [asset('SqlPro-Setup-0.3.5-x64.exe')] }) }), {}, 'en');
  assert.equal(elements.get('#downloadWindows').label.textContent, 'Download installer');
  assert.match(elements.get('[data-release-meta="downloadWindows"]').textContent, /does not provide a SHA-256/);
  assert.equal(elements.get('[data-checksum="downloadWindows"]').hidden, true);
});
