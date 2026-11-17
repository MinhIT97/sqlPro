'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createAuditLogStore } = require('../electron/audit-log.cjs');

function withTempDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-audit-test-'));
  try {
    return fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('audit log store reads empty list initially and appends atomically', () => {
  withTempDir((dir) => {
    const store = createAuditLogStore(dir);
    assert.deepEqual(store.read(), []);

    const appended = store.append({
      profileId: 'local-test',
      profileName: 'Local MySQL',
      database: 'shop',
      table: 'items',
      actionType: 'INSERT',
      summary: 'Thêm bản ghi vào bảng items',
      affectedRows: 1,
      durationMs: 4,
      status: 'success'
    });

    assert.equal(appended.profileId, 'local-test');
    assert.equal(appended.status, 'success');

    const read = store.read();
    assert.equal(read.length, 1);
    assert.equal(read[0].id, appended.id);
    assert.equal(read[0].table, 'items');
  });
});

test('audit log store prunes by age and clears', () => {
  withTempDir((dir) => {
    const store = createAuditLogStore(dir);
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    // Direct write to test prune
    const entries = [
      { id: '1', version: 1, timestamp: new Date(now - 40 * dayMs).toISOString(), profileId: 'p', actionType: 'QUERY', summary: 'old', status: 'success', durationMs: 1, affectedRows: 0, errorCode: null, errorSummary: null, sensitiveScrubbed: true },
      { id: '2', version: 1, timestamp: new Date(now - 2 * dayMs).toISOString(), profileId: 'p', actionType: 'QUERY', summary: 'recent', status: 'success', durationMs: 1, affectedRows: 0, errorCode: null, errorSummary: null, sensitiveScrubbed: true }
    ];
    fs.writeFileSync(path.join(dir, 'audit-log.json'), JSON.stringify({ version: 1, entries }));

    const res = store.prune({ maxAgeDays: 30 });
    assert.equal(res.prunedCount, 1);
    assert.equal(res.remainingCount, 1);

    const afterPrune = store.read();
    assert.equal(afterPrune.length, 1);
    assert.equal(afterPrune[0].id, '2');

    store.clear();
    assert.deepEqual(store.read(), []);
  });
});

test('audit log store preserves corrupt file and throws clear error', () => {
  withTempDir((dir) => {
    const store = createAuditLogStore(dir);
    fs.writeFileSync(path.join(dir, 'audit-log.json'), '{ broken json ...');

    assert.throws(() => store.read(), /bị hỏng cú pháp/);
    assert.throws(() => store.append({ actionType: 'QUERY' }), /bị hỏng cú pháp/);

    // Corrupt file remains untouched
    assert.equal(fs.readFileSync(path.join(dir, 'audit-log.json'), 'utf8'), '{ broken json ...');
  });
});
