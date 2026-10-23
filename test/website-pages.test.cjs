'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const core = require('../website/core.js');
const root = path.join(__dirname, '../website');
const pages = fs.readdirSync(root).filter((name) => name.endsWith('.html'));

test('localized pages match their shared source templates', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/build-website.cjs'), '--check'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(pages.length, 6);
  assert.deepEqual(Object.keys(core.MESSAGES.en).sort(), Object.keys(core.MESSAGES.vi).sort());
});

test('every local link, fragment and asset exists on all localized pages', () => {
  for (const page of pages) {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    assert.doesNotMatch(html, /[\x00-\x08\x0b\x0c\x0e-\x1f]/, `${page}: unexpected control character`);
    const ids = Array.from(html.matchAll(/\bid="([^"]+)"/g), (match) => match[1]);
    assert.equal(new Set(ids).size, ids.length, `${page}: duplicate IDs`);
    for (const [, value] of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
      const url = new URL(value, `https://local.example/${page}`);
      if (url.origin !== 'https://local.example') continue;
      const targetPath = path.join(root, decodeURIComponent(url.pathname.slice(1)));
      assert.ok(fs.existsSync(targetPath), `${page}: missing ${value}`);
      if (url.hash && targetPath.endsWith('.html')) {
        const target = fs.readFileSync(targetPath, 'utf8');
        assert.ok(target.includes(`id="${decodeURIComponent(url.hash.slice(1))}"`), `${page}: missing fragment ${value}`);
      }
    }
    for (const [img] of html.matchAll(/<img\b[^>]*>/g)) {
      assert.match(img, /\balt="[^"]*"/, `${page}: image without alt`);
      assert.match(img, /\bwidth="\d+"/, `${page}: image without dimensions`);
      assert.match(img, /\bheight="\d+"/, `${page}: image without dimensions`);
    }
  }
});

test('documentation preserves literal Windows paths and CSV NULL notation', () => {
  const english = fs.readFileSync(path.join(root, 'docs.en.html'), 'utf8');
  assert.ok(english.includes('Get-FileHash .\\filename.exe -Algorithm SHA256'));
  assert.ok(english.includes('<code>\\N</code>'));
});

test('screenshots are actual PNG assets with declared intrinsic dimensions', () => {
  for (const name of ['editor', 'connection', 'backup']) {
    const png = fs.readFileSync(path.join(root, `assets/screenshots/${name}.png`));
    assert.equal(png.toString('hex', 0, 8), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), 1344);
    assert.equal(png.readUInt32BE(20), 835);
  }
});
