'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const electronPath = require.resolve('electron');
const storePath = require.resolve('../electron/store.cjs');
const originalElectron = require.cache[electronPath];

function loadStore(userData) {
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      app: { getPath: () => userData },
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: (value) => Buffer.from(value, 'utf8'),
        decryptString: (value) => value.toString('utf8')
      }
    }
  };
  delete require.cache[storePath];
  return require(storePath);
}

function restore() {
  delete require.cache[storePath];
  if (originalElectron) require.cache[electronPath] = originalElectron;
  else delete require.cache[electronPath];
}

async function withTempDir(run) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sqlpro-store-'));
  try {
    return await run(directory);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

test('store missing on first run returns defaults', async () => {
  await withTempDir(async (directory) => {
    try {
      const store = loadStore(directory);
      assert.deepEqual(store.list(), []);
      assert.equal(store.listWorkspaces().length, 1);
    } finally {
      restore();
    }
  });
});

test('corrupt store throws STORE_READ_FAILED and is never overwritten', async () => {
  await withTempDir(async (directory) => {
    const filePath = path.join(directory, 'connections.json');
    const corrupt = '{"version":3,"connections":[';
    await fs.promises.writeFile(filePath, corrupt, 'utf8');
    try {
      const store = loadStore(directory);
      assert.throws(() => store.list(), (error) => error.code === 'STORE_READ_FAILED');
      assert.equal(await fs.promises.readFile(filePath, 'utf8'), corrupt);
      assert.throws(() => store.save({ host: 'db.example', user: 'root' }), (error) => error.code === 'STORE_READ_FAILED');
      assert.equal(await fs.promises.readFile(filePath, 'utf8'), corrupt);
    } finally {
      restore();
    }
  });
});

test('non-object store content is rejected instead of replaced', async () => {
  await withTempDir(async (directory) => {
    const filePath = path.join(directory, 'connections.json');
    const content = '[]';
    await fs.promises.writeFile(filePath, content, 'utf8');
    try {
      const store = loadStore(directory);
      assert.throws(() => store.getMeta(), (error) => error.code === 'STORE_READ_FAILED');
      assert.equal(await fs.promises.readFile(filePath, 'utf8'), content);
    } finally {
      restore();
    }
  });
});

test('store I/O errors are reported as STORE_READ_FAILED', async () => {
  await withTempDir(async (directory) => {
    const filePath = path.join(directory, 'connections.json');
    await fs.promises.mkdir(filePath);
    try {
      const store = loadStore(directory);
      assert.throws(
        () => store.list(),
        (error) => error.code === 'STORE_READ_FAILED' && Boolean(error.causeCode)
      );
      assert.ok((await fs.promises.stat(filePath)).isDirectory());
    } finally {
      restore();
    }
  });
});

test('invalid store schemas cannot be migrated or overwritten by saving', async () => {
  const valid = { version: 2, connections: [{ id: 'old', host: 'db.example' }], workspaces: [], tombstones: [] };
  const samples = [
    { ...valid, connections: { old: { id: 'old' } } },
    { ...valid, connections: [{ host: 'db.example' }] },
    { ...valid, connections: [null] },
    { ...valid, connections: [{ id: 'same' }, { id: 'same' }] },
    { ...valid, connections: [{ id: 'old', workspaceId: 'missing' }] },
    { ...valid, workspaces: [{ id: 'bad id' }] },
    { ...valid, workspaces: null },
    { ...valid, tombstones: [{ id: 'old', type: 'unknown' }] },
    { ...valid, version: 99 },
    { version: 2, connections: [] }
  ];
  for (const sample of samples) {
    await withTempDir(async (directory) => {
      const file = path.join(directory, 'connections.json');
      const original = JSON.stringify(sample);
      await fs.promises.writeFile(file, original);
      try {
        const store = loadStore(directory);
        assert.throws(() => store.list(), { code: 'STORE_READ_FAILED' });
        assert.throws(() => store.save({ host: 'new.example' }), { code: 'STORE_READ_FAILED' });
        assert.equal(await fs.promises.readFile(file, 'utf8'), original);
      } finally { restore(); }
    });
  }
});

test('supported v1 stores migrate without dropping connections or secrets', async () => {
  await withTempDir(async (directory) => {
    const file = path.join(directory, 'connections.json');
    const connection = { id: 'old', host: 'db.example', ssl: { enabled: false }, ssh: { enabled: false }, password: { alg: 'test', data: 'sealed' } };
    await fs.promises.writeFile(file, JSON.stringify({ version: 1, connections: [connection] }));
    try {
      const store = loadStore(directory);
      assert.equal(store.list().length, 1);
      const saved = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      assert.equal(saved.version, 2);
      assert.deepEqual(saved.connections[0].password, connection.password);
      assert.equal(saved.connections[0].workspaceId, 'ws-personal');
    } finally { restore(); }
  });
});

test('new profiles default to TLS certificate verification while legacy verify values are preserved', async () => {
  await withTempDir(async (directory) => {
    const file = path.join(directory, 'connections.json');
    const legacy = {
      id: 'legacy',
      workspaceId: 'ws-personal',
      name: 'Legacy',
      host: 'db.example',
      port: 3306,
      user: 'root',
      ssl: { enabled: true },
      ssh: { enabled: false },
      updatedAt: '2026-01-01T00:00:00.000Z'
    };
    await fs.promises.writeFile(file, JSON.stringify({ version: 2, connections: [legacy], workspaces: [], tombstones: [] }));
    try {
      const store = loadStore(directory);
      const listed = store.list()[0];
      assert.equal(listed.ssl.verify, false);
      assert.equal(listed.ssl.legacyUnverified, true);
      assert.equal(store.getWithSecrets('legacy').ssl.verify, undefined);

      const updated = store.save({ id: 'legacy', host: 'db2.example' });
      assert.equal(updated.ssl.verify, false);
      assert.equal(updated.ssl.legacyUnverified, false);
      assert.equal(store.getWithSecrets('legacy').ssl.verify, false);

      const created = store.save({ host: 'new.example', user: 'root', ssl: { enabled: true } });
      assert.equal(created.ssl.verify, true);
      assert.equal(created.ssl.legacyUnverified, false);

      const optedOut = store.save({ host: 'manual.example', user: 'root', ssl: { enabled: true, verify: false } });
      assert.equal(optedOut.ssl.verify, false);
    } finally { restore(); }
  });
});

test('legacy profiles without ssl or ssh objects remain readable and do not crash runtime loading', async () => {
  await withTempDir(async (directory) => {
    const file = path.join(directory, 'connections.json');
    const bare = { id: 'bare', workspaceId: 'ws-personal', host: 'db.example', updatedAt: '2026-01-01T00:00:00.000Z' };
    await fs.promises.writeFile(file, JSON.stringify({ version: 2, connections: [bare], workspaces: [], tombstones: [] }));
    try {
      const store = loadStore(directory);
      const listed = store.list()[0];
      assert.equal(listed.ssl.enabled, false);
      assert.equal(listed.ssl.verify, false);
      assert.equal(listed.ssl.legacyUnverified, true);
      assert.equal(listed.ssh.enabled, false);
      const runtime = store.getWithSecrets('bare');
      assert.deepEqual(runtime.ssl, { passphrase: '' });
      assert.equal(runtime.ssh, undefined);
    } finally { restore(); }
  });
});
