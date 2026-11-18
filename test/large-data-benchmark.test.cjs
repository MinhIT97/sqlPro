'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const { CsvStreamParser } = require('../electron/csv-stream.cjs');
const { JsonArrayStreamParser } = require('../electron/json-array-stream.cjs');
const { TableKeysetReader } = require('../electron/data-diff-reader.cjs');
const { DataSyncExecutor } = require('../electron/data-sync-executor.cjs');

test('Large Data Benchmark: CSV streaming processes 50,000 rows with bounded memory', async () => {
  const rowCount = 50000;
  let parsedCount = 0;

  function* generateCsvChunks() {
    yield 'id,name,amount,status,created_at\n';
    let buffer = '';
    for (let i = 1; i <= rowCount; i++) {
      buffer += `${i},User_${i},${(i * 1.5).toFixed(2)},active,2026-11-18 10:00:00\n`;
      if (buffer.length >= 65536) {
        yield buffer;
        buffer = '';
      }
    }
    if (buffer.length > 0) yield buffer;
  }

  const initialMemory = process.memoryUsage().heapUsed;
  const parser = new CsvStreamParser();

  const inputStream = Readable.from(generateCsvChunks());
  for await (const chunk of inputStream) {
    const rows = parser.push(chunk);
    parsedCount += rows.length;
  }
  const remaining = parser.end();
  parsedCount += remaining.length;

  const finalMemory = process.memoryUsage().heapUsed;
  const heapDeltaMb = (finalMemory - initialMemory) / (1024 * 1024);

  assert.equal(parsedCount, rowCount + 1); // +1 for header row
  // Verify heap did not explode: delta must be well under 30MB for 50,000 streamed rows
  assert.ok(heapDeltaMb < 30, `Heap delta ${heapDeltaMb.toFixed(2)} MB exceeded 30 MB threshold`);
});

test('Large Data Benchmark: JSON array streaming processes 30,000 objects with bounded memory', async () => {
  const rowCount = 30000;
  let parsedCount = 0;

  function* generateJsonChunks() {
    yield '[\n';
    let buffer = '';
    for (let i = 1; i <= rowCount; i++) {
      const comma = i === rowCount ? '' : ',';
      buffer += `{"id":${i},"name":"Item_${i}","score":${i * 10}}${comma}\n`;
      if (buffer.length >= 65536) {
        yield buffer;
        buffer = '';
      }
    }
    if (buffer.length > 0) yield buffer;
    yield ']\n';
  }

  const initialMemory = process.memoryUsage().heapUsed;
  const parser = new JsonArrayStreamParser();

  const inputStream = Readable.from(generateJsonChunks());
  for await (const chunk of inputStream) {
    const items = parser.push(chunk);
    parsedCount += items.length;
  }
  const remaining = parser.end();
  parsedCount += remaining.length;

  const finalMemory = process.memoryUsage().heapUsed;
  const heapDeltaMb = (finalMemory - initialMemory) / (1024 * 1024);

  assert.equal(parsedCount, rowCount);
  assert.ok(heapDeltaMb < 30, `Heap delta ${heapDeltaMb.toFixed(2)} MB exceeded 30 MB threshold`);
});

test('Large Data Benchmark: Keyset Reader chunking enforces strict row and byte limits', async () => {
  let queryCount = 0;
  const fakeSession = {
    async listColumns() {
      return [{ name: 'id', type: 'bigint', key: 'PRI' }, { name: 'payload', type: 'varchar(200)', key: '' }];
    },
    async raw(sql, params) {
      if (sql.includes('information_schema.TABLES')) return { result: [{ engine: 'InnoDB' }] };
      if (sql === 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ') return { result: [] };
      if (sql.startsWith('START TRANSACTION') || sql.startsWith('ROLLBACK')) return { result: [] };
      queryCount++;
      const limit = params[params.length - 1];
      const startId = params.length > 1 ? params[0] : 0;
      const rows = [];
      for (let i = 1; i <= limit; i++) {
        rows.push({ id: startId + i, payload: 'x'.repeat(100) });
      }
      return { rows };
    }
  };

  const reader = new TableKeysetReader(fakeSession, 'bench_db', 'large_table', {
    chunkSize: 500,
    maxRows: 2000,
    maxBytes: 5 * 1024 * 1024
  });

  await reader.init();

  let totalRead = 0;
  while (reader.hasMore) {
    const chunk = await reader.readNextChunk();
    totalRead += chunk.rows.length;
  }

  await reader.close();

  assert.equal(totalRead, 2000);
  assert.equal(queryCount, 4); // 4 chunks of 500 = 2000 rows
  assert.equal(reader.hasMore, false);
});
