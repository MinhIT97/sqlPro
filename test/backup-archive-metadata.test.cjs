'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { backupName, backupDirectory, listBackups } = require('../electron/backup-catalog.cjs');
const { buildManifest, writeManifest, readManifest } = require('../electron/backup-file.cjs');
const { writeAnnotations } = require('../electron/backup-annotations.cjs');
const { createEncryptedCatalog } = require('../electron/backup-encrypted-catalog.cjs');
const { encryptBackupFile, inspectBackupContainer } = require('../electron/backup-crypto.cjs');
const { encodeMetadata, createMetadataReader, MAX_METADATA_BYTES } = require('../electron/backup-archive-metadata.cjs');

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-archive-meta-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profileId = 'p', database = 'Exact_DB', id = backupName();
  const directory = backupDirectory(root, profileId, database), sql = 'CREATE TABLE preserved (id BIGINT);\n';
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, id);
  await fs.writeFile(file, sql);
  const checksum = crypto.createHash('sha256').update(sql).digest('hex');
  const manifest = buildManifest(checksum, { bytes: Buffer.byteLength(sql), tables: 1, objects: 1 }, {
    source: { profileId, database, serverVersion: 'fixture', target: 'a'.repeat(64) }, selection: { tables: ['preserved'] }
  });
  manifest.verification.restore = 'verified';
  await writeManifest(file, manifest);
  await writeAnnotations(file, { name: 'Bản trước nâng cấp', note: 'secret-note-marker', pinned: true });
  return { root, profileId, database, id, directory, file, sql, checksum, manifest,
    catalog: createEncryptedCatalog({ root, profileId, database, ...options }) };
}

test('V3 keeps metadata encrypted and restores a verified file with independent trial status', async t => {
  const r = await fixture(t), before = await fs.readFile(r.file + '.json');
  const encrypted = await r.catalog.encrypt(r.id, 'fixture-password');
  const archive = path.join(r.directory, encrypted.id), bytes = await fs.readFile(archive);
  assert.equal((await inspectBackupContainer(archive)).version, 3);
  assert.equal(bytes.includes(Buffer.from('secret-note-marker')), false);
  const restored = await r.catalog.decrypt(encrypted.id, 'fixture-password');
  const entry = (await listBackups(r.root, r.profileId, r.database)).find(item => item.id === restored.id);
  assert.equal(entry.legacy, false);
  assert.equal(entry.name, 'Bản trước nâng cấp');
  assert.equal(entry.note, 'secret-note-marker');
  assert.equal(entry.pinned, true);
  assert.equal(entry.verification.checksum, 'verified');
  assert.equal(entry.verification.restore, 'not-tested');
  assert.equal(entry.trial, null);
  assert.deepEqual(entry.selection.tables, ['preserved']);
  assert.equal(entry.source.target, 'a'.repeat(64));
  assert.equal(await fs.readFile(path.join(r.directory, restored.id), 'utf8'), r.sql);
  assert.deepEqual(await fs.readFile(r.file + '.json'), before);
  assert.equal((await readManifest(path.join(r.directory, restored.id))).manifest.origin.archiveId, encrypted.id);
});

test('V2 SQL-only archives receive a fresh manifest without invented source authority', async t => {
  const r = await fixture(t), archiveId = r.id + '.enc';
  await encryptBackupFile(r.file, path.join(r.directory, archiveId), { passphrase: 'fixture-password' });
  const restored = await r.catalog.decrypt(archiveId, 'fixture-password');
  const { manifest } = await readManifest(path.join(r.directory, restored.id));
  assert.equal(restored.metadataRestored, false);
  assert.equal(manifest.checksum.value, r.checksum);
  assert.equal(manifest.source.target, null);
  assert.equal(manifest.source.profileId, null);
  assert.equal(manifest.verification.restore, 'not-tested');
});

test('source checksum or metadata drift blocks archive publication', async t => {
  const r = await fixture(t);
  await fs.appendFile(r.file, '-- drift');
  await assert.rejects(r.catalog.encrypt(r.id, 'fixture-password'), { code: 'BACKUP_CHECKSUM_MISMATCH' });
  await fs.writeFile(r.file, r.sql);
  let checks = 0;
  const catalog = createEncryptedCatalog({ ...r, checkContext: () => {
    if (++checks === 3) require('node:fs').appendFileSync(r.file + '.name.json', ' ');
  } });
  await assert.rejects(catalog.encrypt(r.id, 'fixture-password'), { code: 'BACKUP_FILE_CHANGED' });
  assert.equal((await r.catalog.list()).length, 0);
});

test('metadata pair is removed if SQL cannot be published, retaining the original and archive', async t => {
  const r = await fixture(t), archive = await r.catalog.encrypt(r.id, 'fixture-password');
  const before = (await fs.readdir(r.directory)).sort(), link = fs.link;
  fs.link = async (source, destination) => {
    if (path.dirname(destination) === r.directory && destination.endsWith('.sql')) {
      throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' });
    }
    return link(source, destination);
  };
  try { await assert.rejects(r.catalog.decrypt(archive.id, 'fixture-password'), { code: 'ENOSPC' }); }
  finally { fs.link = link; }
  assert.deepEqual((await fs.readdir(r.directory)).sort(), before);
  assert.equal(await fs.readFile(r.file, 'utf8'), r.sql);
});

test('metadata decoder handles split bytes, empty SQL and rejects truncation, future versions and quotas', async () => {
  const metadata = { version: 1, kind: 'sqlpro-backup-archive-metadata', sourceId: backupName(), manifest: null, annotations: {} };
  const encoded = encodeMetadata(metadata), sql = Buffer.from('SELECT "tiếng Việt";');
  const reader = createMetadataReader(), output = [];
  reader.stream.on('data', chunk => output.push(chunk));
  const bytes = Buffer.concat([encoded, sql]);
  await pipeline(Readable.from(Array.from(bytes, byte => Buffer.from([byte]))), reader.stream);
  assert.deepEqual(Buffer.concat(output), sql);
  assert.equal(reader.getMetadata().sourceId, metadata.sourceId);
  const empty = createMetadataReader(); empty.stream.resume();
  await pipeline(Readable.from([encoded]), empty.stream);
  const truncated = createMetadataReader(); truncated.stream.resume();
  await assert.rejects(pipeline(Readable.from([encoded.subarray(0, encoded.length - 1)]), truncated.stream), { code: 'BACKUP_METADATA_INVALID' });
  assert.throws(() => encodeMetadata({ ...metadata, version: 99 }), { code: 'BACKUP_METADATA_INVALID' });
  const huge = Buffer.from(encoded); huge.writeUInt32BE(MAX_METADATA_BYTES + 1, Buffer.byteLength('SQLPRO_META_V1\0'));
  const quota = createMetadataReader(); quota.stream.resume();
  await assert.rejects(pipeline(Readable.from([huge]), quota.stream), { code: 'BACKUP_METADATA_INVALID' });
});
