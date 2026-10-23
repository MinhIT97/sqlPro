'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../website/app.js'), 'utf8');
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

async function renderDownloads(fetch) {
  const elements = new Map([
    ['#downloadLinux', downloadLink()],
    ['#downloadWindows', downloadLink()],
    ['#downloadAppImage', downloadLink()],
    ['#downloadPortable', downloadLink()],
    ['#downloadAlternatives', { hidden: true }],
    ['#downloadStatus', { textContent: '' }]
  ]);
  const document = {
    querySelector: (selector) => elements.get(selector) || null,
    querySelectorAll: () => []
  };
  vm.runInNewContext(source, { document, fetch, URL }, { filename: 'website/app.js' });
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
  assert.equal(elements.get('#downloadAlternatives').hidden, false);
  assert.match(elements.get('#downloadStatus').textContent, /v0\.3\.5/);
});

test('without a GitHub Release, buttons lead to the release page with a clear status', async () => {
  const elements = await renderDownloads(async () => ({ status: 404, ok: false }));

  assert.equal(elements.get('#downloadLinux').href, releasesUrl);
  assert.equal(elements.get('#downloadWindows').href, releasesUrl);
  assert.equal(elements.get('#downloadLinux').label.textContent, 'Xem GitHub Releases');
  assert.equal(elements.get('#downloadAlternatives').hidden, true);
  assert.match(elements.get('#downloadStatus').textContent, /Chưa có bộ cài công khai/);
});
