'use strict';

const { Transform } = require('node:stream');
const { normalizeAnnotations } = require('./backup-annotations.cjs');

const PREFIX = Buffer.from('SQLPRO_META_V1\0');
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const fail = () => Object.assign(new Error('Metadata backup mã hóa không hợp lệ hoặc vượt giới hạn.'), { code: 'BACKUP_METADATA_INVALID' });
const plain = value => value && typeof value === 'object' && !Array.isArray(value);

function text(value, max) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw fail();
  return value;
}

function normalizeManifest(value) {
  if (value === null) return null;
  if (!plain(value) || value.version !== 1 || value.kind !== 'sqlpro-backup-manifest'
      || value.checksum?.algorithm !== 'sha256' || !/^[a-f0-9]{64}$/i.test(value.checksum.value || '')
      || typeof value.createdAt !== 'string' || value.createdAt.length > 40 || !Number.isFinite(Date.parse(value.createdAt))) throw fail();
  const source = value.source || {}, selection = value.selection || {}, result = value.result || {};
  const list = key => {
    const items = selection[key] || [];
    if (!Array.isArray(items) || items.length > 2000) throw fail();
    return items.map(item => { if (typeof item !== 'string' || !item || item.length > 200 || item.includes('\0')) throw fail(); return item; });
  };
  const flags = {};
  for (const key of ['includeStructure', 'includeData', 'dropTables', 'stripDefiner']) {
    if (selection[key] !== undefined && typeof selection[key] !== 'boolean') throw fail();
    flags[key] = selection[key] ?? ['includeStructure', 'includeData'].includes(key);
  }
  const counts = {};
  for (const key of ['bytes', 'rows', 'objects', 'tables', 'views', 'triggers', 'procedures', 'functions', 'events']) {
    const count = result[key] ?? 0;
    if (!Number.isSafeInteger(count) || count < 0) throw fail();
    counts[key] = count;
  }
  if (source.target != null && (typeof source.target !== 'string' || !/^[a-f0-9]{64}$/.test(source.target))) throw fail();
  return {
    version: 1, kind: 'sqlpro-backup-manifest', createdAt: value.createdAt,
    app: { name: text(value.app?.name, 80), version: text(value.app?.version, 40) },
    source: { profileId: text(source.profileId, 120), database: text(source.database, 64),
      serverVersion: text(source.serverVersion, 120), target: source.target || null },
    selection: { ...flags, tables: list('tables'), routines: list('routines'), events: list('events') },
    result: counts, checksum: { algorithm: 'sha256', value: value.checksum.value.toLowerCase() }
  };
}

function normalizeArchiveMetadata(value) {
  if (!plain(value) || value.version !== 1 || value.kind !== 'sqlpro-backup-archive-metadata'
      || typeof value.sourceId !== 'string' || !/^\d{14}-[a-f0-9]{8}\.sql$/.test(value.sourceId)) throw fail();
  return { version: 1, kind: value.kind, sourceId: value.sourceId,
    manifest: normalizeManifest(value.manifest), annotations: normalizeAnnotations(value.annotations) };
}

function encodeMetadata(value) {
  const body = Buffer.from(JSON.stringify(normalizeArchiveMetadata(value)));
  if (!body.length || body.length > MAX_METADATA_BYTES) throw fail();
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([PREFIX, length, body]);
}

function createMetadataReader() {
  let buffered = Buffer.alloc(0), needed = PREFIX.length + 4, metadata = null;
  const stream = new Transform({
    transform(chunk, encoding, callback) {
      try {
        if (metadata) { callback(null, chunk); return; }
        let offset = 0;
        while (!metadata && offset < chunk.length) {
          const count = Math.min(needed - buffered.length, chunk.length - offset);
          buffered = Buffer.concat([buffered, chunk.subarray(offset, offset + count)]);
          offset += count;
          if (buffered.length < needed) break;
          if (needed === PREFIX.length + 4) {
            if (!buffered.subarray(0, PREFIX.length).equals(PREFIX)) throw fail();
            const length = buffered.readUInt32BE(PREFIX.length);
            if (!length || length > MAX_METADATA_BYTES) throw fail();
            needed += length;
          } else {
            metadata = normalizeArchiveMetadata(JSON.parse(buffered.subarray(PREFIX.length + 4).toString('utf8')));
            buffered = Buffer.alloc(0);
          }
        }
        if (metadata && offset < chunk.length) this.push(chunk.subarray(offset));
        callback();
      } catch (error) { callback(error.code ? error : fail()); }
    },
    flush(callback) { callback(metadata ? null : fail()); }
  });
  return { stream, getMetadata: () => metadata };
}

module.exports = { normalizeArchiveMetadata, normalizeManifest, encodeMetadata, createMetadataReader, MAX_METADATA_BYTES };
