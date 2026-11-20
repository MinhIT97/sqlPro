'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Server, utils } = require('ssh2');
const { STATUS_CODE, flagsToString } = utils.sftp;
const { sshHostKeyFingerprint } = require('../electron/database.cjs');
const { encryptBackupFile } = require('../electron/backup-crypto.cjs');
const { replicateEncryptedArchive } = require('../electron/backup-sftp-replica.cjs');

test('real SSH/SFTP loopback: trusted host, exclusive remote replica and readback SHA-256', {
  skip: process.env.SQLPRO_TEST_SFTP !== '1', timeout: 30000
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-sftp-wire-'));
  const remote = path.join(root, 'remote'); fs.mkdirSync(remote);
  const clients = new Set(), descriptors = new Set();
  const privateKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const publicKey = utils.parseKey(privateKey).getPublicSSH();
  let writes = 0;
  const local = value => {
    const relative = path.posix.relative('/replicas', value);
    if (relative === '..' || relative.startsWith('../')) throw new Error('fixture path outside root');
    return path.join(remote, relative);
  };
  const server = new Server({ hostKeys: [privateKey] }, client => {
    clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client));
    client.on('authentication', ctx => {
      if (ctx.method === 'password' && ctx.username === 'fixture' && ctx.password === 'fixture-password') ctx.accept();
      else ctx.reject();
    });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('sftp', acceptSftp => {
        const stream = acceptSftp(), handles = new Map(); let sequence = 0;
        const status = (id, error) => stream.status(id, error ? error.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE : STATUS_CODE.OK);
        const attributes = stat => ({ size: stat.size, mode: stat.mode, uid: stat.uid, gid: stat.gid,
          atime: Math.floor(stat.atimeMs / 1000), mtime: Math.floor(stat.mtimeMs / 1000) });
        stream.on('STAT', (id, file) => fs.stat(local(file), (error, stat) => error ? status(id, error) : stream.attrs(id, attributes(stat))));
        stream.on('MKDIR', (id, file, attrs) => fs.mkdir(local(file), { mode: attrs.mode }, error => status(id, error)));
        stream.on('OPEN', (id, file, flags, attrs) => fs.open(local(file), flagsToString(flags), attrs.mode || 0o600, (error, fd) => {
          if (error) return status(id, error);
          const handle = Buffer.alloc(4); handle.writeUInt32BE(++sequence);
          handles.set(sequence, fd); descriptors.add(fd); stream.handle(id, handle);
        }));
        stream.on('WRITE', (id, handle, offset, data) => {
          writes++;
          fs.write(handles.get(handle.readUInt32BE()), data, 0, data.length, offset, error => status(id, error));
        });
        stream.on('READ', (id, handle, offset, length) => {
          const data = Buffer.alloc(Math.min(length, 65536));
          fs.read(handles.get(handle.readUInt32BE()), data, 0, data.length, offset, (error, count) => {
            if (error) return status(id, error);
            if (!count) return stream.status(id, STATUS_CODE.EOF);
            stream.data(id, data.subarray(0, count));
          });
        });
        stream.on('FSTAT', (id, handle) => fs.fstat(handles.get(handle.readUInt32BE()), (error, stat) => error ? status(id, error) : stream.attrs(id, attributes(stat))));
        stream.on('CLOSE', (id, handle) => {
          const key = handle.readUInt32BE(), fd = handles.get(key); handles.delete(key); descriptors.delete(fd);
          fs.close(fd, error => status(id, error));
        });
        stream.on('RENAME', (id, from, to) => fs.link(local(from), local(to), error => {
          if (error) return status(id, error);
          fs.unlink(local(from), error => status(id, error));
        }));
        stream.on('REMOVE', (id, file) => fs.unlink(local(file), error => status(id, error)));
        stream.on('RMDIR', (id, file) => fs.rmdir(local(file), error => status(id, error)));
      });
    }));
  });
  t.after(async () => {
    for (const client of clients) client.end();
    await new Promise(resolve => server.close(resolve));
    for (const fd of descriptors) { try { fs.closeSync(fd); } catch {} }
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  const ssh = { enabled: true, host: '127.0.0.1', port, user: 'fixture', password: 'fixture-password',
    knownHostKey: { host: '127.0.0.1', port, fingerprint: sshHostKeyFingerprint(publicKey) } };
  const source = path.join(root, 'source.sql'), archive = source + '.enc';
  fs.writeFileSync(source, 'CREATE TABLE retained (id BIGINT);');
  await encryptBackupFile(source, archive, { passphrase: 'archive-password' });
  const before = fs.readFileSync(archive);
  await t.test('two sends use independent immutable destinations and keep the local archive', async () => {
    const first = await replicateEncryptedArchive({ sourceFile: archive, ssh, destinationDir: '/replicas', timeoutMs: 5000 });
    const second = await replicateEncryptedArchive({ sourceFile: archive, ssh, destinationDir: '/replicas', timeoutMs: 5000 });
    assert.notEqual(first.remotePath, second.remotePath);
    for (const result of [first, second]) {
      assert.deepEqual(fs.readFileSync(local(result.remotePath)), before);
      assert.equal(result.fileChecksum, crypto.createHash('sha256').update(before).digest('hex'));
      assert.equal(result.durability, 'server-acknowledged');
    }
    assert.deepEqual(fs.readFileSync(archive), before);
  });
  await t.test('an untrusted host is rejected before any SFTP write', async () => {
    const count = writes;
    await assert.rejects(replicateEncryptedArchive({ sourceFile: archive, ssh: { ...ssh,
      knownHostKey: { ...ssh.knownHostKey, fingerprint: 'SHA256:wrong' } }, destinationDir: '/replicas', timeoutMs: 5000 }), { code: 'SSH_HOST_KEY_CHANGED' });
    assert.equal(writes, count);
  });
});
