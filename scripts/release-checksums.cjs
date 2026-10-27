'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ARTIFACT = /^SqlPro(?:-Setup|-Portable)?-.+\.(?:deb|AppImage|exe|zip)$/;
const CHECKSUM_LINE = /^([a-f0-9]{64}) {2}([^/\\]+)$/;

function listArtifacts(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && ARTIFACT.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.once('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

async function writeChecksums(directory, outputPath) {
  const names = listArtifacts(directory);
  if (!names.length) throw new Error(`Không tìm thấy bộ cài nào trong ${directory}.`);
  const lines = [];
  for (const name of names) {
    lines.push(`${await hashFile(path.join(directory, name))}  ${name}`);
  }
  fs.writeFileSync(outputPath, `${lines.join('\n')}\n`);
  await verifyChecksums(outputPath, { requireAllArtifacts: true });
  return { file: outputPath, count: names.length };
}

function readChecksums(checksumPath) {
  const content = fs.readFileSync(checksumPath, 'utf8');
  if (!content.trim()) throw new Error('Tệp checksum rỗng.');
  const entries = [];
  const names = new Set();
  for (const line of content.split(/\r?\n/)) {
    if (!line) continue;
    const match = CHECKSUM_LINE.exec(line);
    if (!match) throw new Error(`Dòng checksum không hợp lệ: ${line.slice(0, 120)}`);
    if (names.has(match[2])) throw new Error(`Tệp ${match[2]} xuất hiện nhiều lần trong checksum.`);
    names.add(match[2]);
    entries.push({ hash: match[1], name: match[2] });
  }
  return entries;
}

async function verifyChecksums(checksumPath, { requireAllArtifacts = false } = {}) {
  const directory = path.dirname(path.resolve(checksumPath));
  const entries = readChecksums(checksumPath);
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (path.dirname(filePath) !== directory) throw new Error(`Đường dẫn checksum không an toàn: ${entry.name}`);
    let actual;
    try {
      actual = await hashFile(filePath);
    } catch {
      throw new Error(`Thiếu tệp được liệt kê trong checksum: ${entry.name}`);
    }
    if (actual !== entry.hash) throw new Error(`SHA-256 không khớp cho ${entry.name}.`);
  }
  if (requireAllArtifacts) {
    const listed = new Set(entries.map((entry) => entry.name));
    for (const name of listArtifacts(directory)) {
      if (!listed.has(name)) throw new Error(`Bộ cài chưa có checksum: ${name}`);
    }
  }
  return { file: checksumPath, count: entries.length };
}

async function main(argv) {
  if (argv[0] === '--verify') {
    const file = argv[1];
    if (!file) throw new Error('Thiếu đường dẫn tệp checksum cần kiểm tra.');
    const result = await verifyChecksums(path.resolve(file), { requireAllArtifacts: true });
    console.log(`Đã xác minh ${result.count} tệp trong ${file}.`);
    return;
  }
  const outputPath = path.resolve(argv[0] || path.join('release', 'SHA256SUMS.txt'));
  const result = await writeChecksums(path.dirname(outputPath), outputPath);
  console.log(`Đã ghi SHA-256 cho ${result.count} bộ cài vào ${outputPath}.`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { ARTIFACT, listArtifacts, hashFile, writeChecksums, verifyChecksums };
