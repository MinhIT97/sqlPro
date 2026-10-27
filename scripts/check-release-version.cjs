'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw new Error(`Không đọc được ${path.basename(filePath)}.`);
  }
}

function verifyVersionFiles(root = path.join(__dirname, '..')) {
  const pkg = readJson(path.join(root, 'package.json'));
  const lock = readJson(path.join(root, 'package-lock.json'));
  if (typeof pkg.version !== 'string' || !SEMVER.test(pkg.version)) {
    throw new Error('package.json có version không hợp lệ.');
  }
  if (lock.version !== pkg.version) {
    throw new Error(`package-lock.json (${lock.version}) không khớp package.json (${pkg.version}).`);
  }
  if (lock.packages?.['']?.version !== pkg.version) {
    throw new Error(`package-lock.json packages[""].version (${lock.packages?.['']?.version}) không khớp package.json (${pkg.version}).`);
  }
  return pkg.version;
}

function verifyTag(ref, version) {
  if (typeof ref !== 'string' || !ref.startsWith('refs/tags/')) return null;
  const tag = ref.slice('refs/tags/'.length);
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
    throw new Error(`Tag "${tag}" không có dạng vX.Y.Z.`);
  }
  if (tag.slice(1) !== version) {
    throw new Error(`Tag "${tag}" không khớp version ${version} trong package.json.`);
  }
  return tag;
}

function checkReleaseVersion({ root = path.join(__dirname, '..'), ref = process.env.GITHUB_REF } = {}) {
  const version = verifyVersionFiles(root);
  const tag = verifyTag(ref, version);
  return { version, tag };
}

if (require.main === module) {
  try {
    const { version, tag } = checkReleaseVersion();
    console.log(tag ? `Version ${version} khớp tag ${tag}.` : `package.json và package-lock.json cùng version ${version}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { SEMVER, verifyVersionFiles, verifyTag, checkReleaseVersion };
