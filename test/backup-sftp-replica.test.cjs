'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { encryptBackupFile } = require('../electron/backup-crypto.cjs');
const { sshHostKeyFingerprint } = require('../electron/database.cjs');
const { replicateEncryptedArchive, validateRemoteDirectory } = require('../electron/backup-sftp-replica.cjs');

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-sftp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.sql'), archive = source + '.enc', remote = path.join(root, 'remote');
  fs.mkdirSync(remote); fs.writeFileSync(source, 'CREATE TABLE retained (id BIGINT);');
  await encryptBackupFile(source, archive, { passphrase: 'fixture-password' });
  const key = Buffer.from('fixture SSH host key'), ssh = { enabled: true, host: 'fixture', port: 22, user: 'fixture', password: 'secret-marker',
    knownHostKey: { host: 'fixture', port: 22, fingerprint: sshHostKeyFingerprint(key) } };
  const local = value => path.join(remote, path.posix.relative('/remote', value));
  const cb = (pending, done) => Promise.resolve(pending).then(value => done(null, value), done);
  let heldRead = null, writes = 0;
  const sftp = {
    stat(file, done) { cb(fs.promises.stat(local(file)), done); },
    mkdir(file, attrs, done) { cb(fs.promises.mkdir(local(file), attrs), done); },
    createWriteStream(file, attrs) { writes++; assert.equal(attrs.flags, 'wx'); return fs.createWriteStream(local(file), attrs); },
    createReadStream(file) {
      if (options.holdRead) { heldRead = new PassThrough(); return heldRead; }
      if (options.corrupt) fs.appendFileSync(local(file), 'corrupt');
      return fs.createReadStream(local(file));
    },
    open(file, flags, done) {
      assert.equal(flags, 'r+');
      cb(fs.promises.open(local(file), flags), done);
    },
    ext_openssh_fsync(handle, done) {
      if (options.noFsync) throw new Error('Server does not support this extended request');
      cb(handle.sync(), done);
    },
    close(handle, done) { cb(handle.close(), done); },
    rename(from, to, done) {
      cb((async () => {
        await fs.promises.link(local(from), local(to)); await fs.promises.unlink(local(from));
        if (options.lostAck) throw new Error('fixture lost ACK');
      })(), done);
    },
    unlink(file, done) { cb(fs.promises.unlink(local(file)), done); },
    rmdir(file, done) { cb(fs.promises.rmdir(local(file)), done); }, end() {}
  };
  class FakeClient extends EventEmitter {
    connect(config) {
      this.config = config;
      if (!config.hostVerifier(options.wrongKey ? Buffer.from('different key') : key)) {
        queueMicrotask(() => this.emit('error', new Error('fixture rejected host'))); return;
      }
      if (!options.hang) queueMicrotask(() => this.emit('ready'));
    }
    sftp(done) { done(null, sftp); }
    destroy() { this.destroyed = true; }
    end() { this.ended = true; }
  }
  const client = new FakeClient();
  const run = additions => replicateEncryptedArchive({ sourceFile: archive, ssh, destinationDir: '/remote',
    createClient: () => client, timeoutMs: 2000, ...additions });
  return { root, remote, source, archive, client, run, get heldRead() { return heldRead; }, get writes() { return writes; } };
}

test('SFTP publishes a verified archive in its own directory and retains every local byte', async t => {
  const r = await fixture(t), before = fs.readFileSync(r.archive);
  const result = await r.run();
  assert.equal(result.verified, true); assert.equal(result.durability, 'fsync');
  assert.equal(result.restore, 'not-tested');
  const directory = fs.readdirSync(r.remote)[0];
  assert.deepEqual(fs.readdirSync(path.join(r.remote, directory)), [path.basename(r.archive)]);
  assert.deepEqual(fs.readFileSync(path.join(r.remote, directory, path.basename(r.archive))), before);
  assert.deepEqual(fs.readFileSync(r.archive), before);
  assert.equal(r.client.ended, true);
});

test('readback corruption blocks publication and unsupported fsync is reported honestly', async t => {
  const corrupt = await fixture(t, { corrupt: true });
  await assert.rejects(corrupt.run(), { code: 'REPLICA_CHECKSUM_MISMATCH' });
  assert.deepEqual(fs.readdirSync(corrupt.remote), []);
  const r = await fixture(t, { noFsync: true });
  assert.equal((await r.run()).durability, 'server-acknowledged');
});

test('unknown host, timeout and cancellation terminate before publication', async t => {
  const wrong = await fixture(t, { wrongKey: true });
  await assert.rejects(wrong.run(), { code: 'SSH_HOST_KEY_CHANGED' });
  assert.equal(wrong.writes, 0);
  const hung = await fixture(t, { hang: true });
  await assert.rejects(hung.run({ timeoutMs: 15 }), { code: 'REPLICA_TIMEOUT' });
  assert.equal(hung.client.destroyed, true);
  const r = await fixture(t, { holdRead: true }), controller = new AbortController();
  const pending = r.run({ signal: controller.signal });
  while (!r.heldRead) await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(pending, { code: 'REPLICA_CANCELLED' });
  assert.equal(r.heldRead.destroyed, true);
  assert.equal(fs.existsSync(r.archive), true);
});

test('lost publication ACK preserves the possible completed replica and never retries', async t => {
  const r = await fixture(t, { lostAck: true });
  await assert.rejects(r.run(), { code: 'REPLICA_COMMIT_UNCERTAIN' });
  assert.equal(r.writes, 1);
  const directory = fs.readdirSync(r.remote)[0];
  assert.deepEqual(fs.readFileSync(path.join(r.remote, directory, path.basename(r.archive))), fs.readFileSync(r.archive));
});

test('invalid remote paths cannot become shell commands or escape relative scope', () => {
  for (const value of ['relative', '/backups/../other', '/backups\nrm', '/backups\\other', '']) {
    assert.throws(() => validateRemoteDirectory(value), { code: 'INVALID_REPLICA_DIRECTORY' });
  }
  assert.equal(validateRemoteDirectory('/backups with spaces/'), '/backups with spaces/');
});
