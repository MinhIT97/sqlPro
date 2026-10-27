'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkReleaseVersion, verifyVersionFiles } = require('../scripts/check-release-version.cjs');
const { writeChecksums, verifyChecksums } = require('../scripts/release-checksums.cjs');

async function withTempDir(run) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sqlpro-release-'));
  try {
    return await run(directory);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

function writeVersionFiles(directory, version = '1.2.3', lockVersion = version, rootLockVersion = version) {
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'sqlpro', version }));
  fs.writeFileSync(path.join(directory, 'package-lock.json'), JSON.stringify({
    name: 'sqlpro', version: lockVersion, lockfileVersion: 3, packages: { '': { name: 'sqlpro', version: rootLockVersion } }
  }));
}

test('repository package.json and package-lock.json versions stay in sync', () => {
  assert.match(verifyVersionFiles(), /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
});

test('release check accepts a matching vX.Y.Z tag and only checks tags', async () => {
  await withTempDir((directory) => {
    writeVersionFiles(directory);
    assert.deepEqual(checkReleaseVersion({ root: directory, ref: 'refs/tags/v1.2.3' }), { version: '1.2.3', tag: 'v1.2.3' });
    assert.deepEqual(checkReleaseVersion({ root: directory, ref: 'refs/heads/master' }), { version: '1.2.3', tag: null });
    assert.deepEqual(checkReleaseVersion({ root: directory, ref: '' }), { version: '1.2.3', tag: null });
  });
});

test('release check rejects mismatched lockfiles, tags and malformed versions', async () => {
  await withTempDir((directory) => {
    writeVersionFiles(directory, '1.2.3', '1.2.2');
    assert.throws(() => checkReleaseVersion({ root: directory, ref: 'refs/tags/v1.2.3' }), /package-lock\.json/);
    writeVersionFiles(directory, '1.2.3', '1.2.3', '1.2.2');
    assert.throws(() => checkReleaseVersion({ root: directory }), /packages\[""\]/);
    writeVersionFiles(directory, '1.2.3');
    assert.throws(() => checkReleaseVersion({ root: directory, ref: 'refs/tags/v1.2.4' }), /không khớp version/);
    assert.throws(() => checkReleaseVersion({ root: directory, ref: 'refs/tags/release-1.2.3' }), /vX\.Y\.Z/);
    writeVersionFiles(directory, '1.2');
    assert.throws(() => checkReleaseVersion({ root: directory }), /version không hợp lệ/);
  });
});

test('checksum generation covers every installer and verifies the exact bytes', async () => {
  await withTempDir(async (directory) => {
    const names = [
      'SqlPro-1.2.3-amd64.deb',
      'SqlPro-1.2.3-x86_64.AppImage',
      'SqlPro-Setup-1.2.3-x64.exe',
      'SqlPro-Portable-1.2.3-x64.exe'
    ];
    for (const name of names) fs.writeFileSync(path.join(directory, name), `content:${name}`);
    const checksumPath = path.join(directory, 'SHA256SUMS-linux.txt');
    const written = await writeChecksums(directory, checksumPath);
    assert.equal(written.count, 4);
    const content = fs.readFileSync(checksumPath, 'utf8');
    for (const name of names) assert.match(content, new RegExp(`^[a-f0-9]{64} {2}${name.replace('.', '\\.')}$`, 'm'));
    assert.equal((await verifyChecksums(checksumPath, { requireAllArtifacts: true })).count, 4);

    fs.appendFileSync(path.join(directory, names[0]), 'tampered');
    await assert.rejects(verifyChecksums(checksumPath), /SHA-256 không khớp/);

    fs.writeFileSync(path.join(directory, names[0]), `content:${names[0]}`);
    fs.writeFileSync(path.join(directory, 'SqlPro-1.2.3-extra.deb'), 'extra');
    await assert.rejects(verifyChecksums(checksumPath, { requireAllArtifacts: true }), /chưa có checksum/);
  });
});

test('checksum verification rejects unsafe or malformed entries and empty builds', async () => {
  await withTempDir(async (directory) => {
    await assert.rejects(writeChecksums(directory, path.join(directory, 'SHA256SUMS.txt')), /Không tìm thấy bộ cài/);
    fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), `${'a'.repeat(64)}  ../outside.deb\n`);
    await assert.rejects(verifyChecksums(path.join(directory, 'SHA256SUMS.txt')), /không hợp lệ/);
    fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), '');
    await assert.rejects(verifyChecksums(path.join(directory, 'SHA256SUMS.txt')), /rỗng/);
  });
});
