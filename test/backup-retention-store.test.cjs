'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { backupDirectory } = require('../electron/backup-catalog.cjs');
const { createRetentionStore } = require('../electron/backup-retention-store.cjs');

test('retention policy persists independently per profile/database and clear preserves backup files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-retention-store-'));
  try {
    const store = createRetentionStore(root);
    assert.equal(store.read('p1', 'db').policy, null);
    const policy = { maxCount: 7, maxAgeDays: 30, maxBytes: 1048577 };
    store.save('p1', 'db', policy);
    assert.deepEqual(createRetentionStore(root).read('p1', 'db').policy, policy);
    assert.equal(store.read('p2', 'db').policy, null);
    assert.equal(store.read('p1', 'other').policy, null);
    const directory = backupDirectory(root, 'p1', 'db');
    const file = path.join(directory, 'retention-policy.json');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.writeFileSync(path.join(directory, 'backup.sql'), 'SELECT 1;');
    store.clear('p1', 'db');
    assert.deepEqual(fs.readdirSync(directory), ['backup.sql']);
    assert.equal(store.read('p1', 'db').policy, null);
    assert.throws(() => store.save('p1', 'db', {}));
    assert.throws(() => store.read('', 'db'));
    assert.throws(() => store.read({}, 'db'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('retention store preserves corrupt/future metadata and prior policy after atomic write failure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-retention-failure-'));
  const originalRename = fs.renameSync;
  try {
    const store = createRetentionStore(root);
    store.save('p1', 'db', { maxCount: 3 });
    const directory = backupDirectory(root, 'p1', 'db');
    const file = path.join(directory, 'retention-policy.json');
    const original = fs.readFileSync(file, 'utf8');
    fs.renameSync = () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
    assert.throws(() => store.save('p1', 'db', { maxCount: 1 }), { code: 'ENOSPC' });
    fs.renameSync = originalRename;
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(directory), ['retention-policy.json']);
    for (const value of ['{broken', JSON.stringify({ version: 2 }), 'x'.repeat(4097), JSON.stringify({ version: 1, updatedAt: 'invalid', policy: { maxCount: 2 } })]) {
      fs.writeFileSync(file, value);
      assert.throws(() => store.read('p1', 'db'));
      assert.throws(() => store.save('p1', 'db', { maxCount: 1 }));
      assert.throws(() => store.clear('p1', 'db'));
      assert.equal(fs.readFileSync(file, 'utf8'), value);
    }
  } finally { fs.renameSync = originalRename; fs.rmSync(root, { recursive: true, force: true }); }
});
