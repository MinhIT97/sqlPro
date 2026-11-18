'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  inspectBackupContainer,
  encryptBackupFile,
  decryptBackupFile,
  MAGIC
} = require('../electron/backup-crypto.cjs');

const {
  BackupReplicaManager,
  computeFileSha256
} = require('../electron/backup-replica-manager.cjs');

const {
  parseCron,
  calculateNextRun,
  evaluateMissedRuns
} = require('../electron/backup-calendar-calculator.cjs');

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  };
}

// -----------------------------------------------------------------------------
// B10 (G3.5): Backup Crypto & AEAD Authenticated Encryption
// -----------------------------------------------------------------------------
test('Backup Crypto: AEAD stream encryption, gzip compression, dual checksums and integrity verification', async () => {
  const { dir, cleanup } = makeTempDir('sqlpro-crypto-');
  try {
    const rawSqlPath = path.join(dir, 'sample.sql');
    const encPath = path.join(dir, 'sample.sql.enc');
    const decPath = path.join(dir, 'decrypted.sql');

    const sqlContent = 'CREATE TABLE users (id INT PRIMARY KEY, name VARCHAR(50));\n' +
      'INSERT INTO users VALUES (1, "Alice");\n'.repeat(50);
    fs.writeFileSync(rawSqlPath, sqlContent, 'utf8');

    // 1. Inspect unencrypted raw SQL
    const rawInspection = await inspectBackupContainer(rawSqlPath);
    assert.equal(rawInspection.format, 'sql');
    assert.equal(rawInspection.encrypted, false);

    // 2. Encrypt with compression and passphrase
    const encResult = await encryptBackupFile(rawSqlPath, encPath, {
      passphrase: 'superSecretPassword123!',
      compress: true
    });

    assert.equal(encResult.format, 'encrypted');
    assert.equal(encResult.compressed, true);
    assert.equal(encResult.cipher, 'aes-256-gcm');
    assert.ok(encResult.contentChecksum);
    assert.ok(encResult.fileChecksum);

    // 3. Inspect encrypted container without password
    const encInspection = await inspectBackupContainer(encPath);
    assert.equal(encInspection.format, 'encrypted');
    assert.equal(encInspection.encrypted, true);
    assert.equal(encInspection.compressed, true);
    assert.equal(encInspection.cipher, 'aes-256-gcm');

    // 4. Decrypt with correct password
    const decResult = await decryptBackupFile(encPath, decPath, {
      passphrase: 'superSecretPassword123!'
    });

    const decryptedContent = fs.readFileSync(decPath, 'utf8');
    assert.equal(decryptedContent, sqlContent);
    assert.equal(decResult.contentChecksum, encResult.contentChecksum);

    // 5. Decrypt with wrong password fails closed with BACKUP_DECRYPTION_FAILED
    const badDecPath = path.join(dir, 'bad.sql');
    await assert.rejects(
      () => decryptBackupFile(encPath, badDecPath, { passphrase: 'WrongPassword456!' }),
      { code: 'BACKUP_DECRYPTION_FAILED' }
    );
    // Plaintext file must NOT remain on disk when decryption fails
    assert.equal(fs.existsSync(badDecPath), false);

    // 6. Tampered ciphertext fails authentication
    const tamperedPath = path.join(dir, 'tampered.sql.enc');
    const encBytes = fs.readFileSync(encPath);
    // Corrupt one byte in the middle of ciphertext
    encBytes[encBytes.length - 30] ^= 0xff;
    fs.writeFileSync(tamperedPath, encBytes);

    await assert.rejects(
      () => decryptBackupFile(tamperedPath, path.join(dir, 'tampered_out.sql'), { passphrase: 'superSecretPassword123!' }),
      { code: 'BACKUP_DECRYPTION_FAILED' }
    );
  } finally {
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// B11 (G3.6): Off-Host Replica Manager
// -----------------------------------------------------------------------------
test('Backup Replica Manager: atomic copy, checksum verification and integrity check', async () => {
  const { dir, cleanup } = makeTempDir('sqlpro-replica-');
  try {
    const sourceDir = path.join(dir, 'primary');
    const replicaDir = path.join(dir, 'secondary_offhost');
    fs.mkdirSync(sourceDir, { recursive: true });

    const sourceFile = path.join(sourceDir, 'backup-20261118-test.sql');
    const content = '-- SqlPro Backup Test Replica\nSELECT 42;\n';
    fs.writeFileSync(sourceFile, content, 'utf8');

    // Write sidecar manifest
    const manifestFile = `${sourceFile}.manifest.json`;
    fs.writeFileSync(manifestFile, JSON.stringify({ version: 1, database: 'test_db' }), 'utf8');

    const replicaManager = new BackupReplicaManager({ maxRetries: 2 });

    // 1. Create replica
    const result = await replicaManager.createReplica({
      sourceFilePath: sourceFile,
      destinationDir: replicaDir
    });

    assert.equal(result.verified, true);
    assert.equal(result.manifestCopied, true);
    assert.ok(fs.existsSync(result.replicaPath));
    assert.ok(fs.existsSync(`${result.replicaPath}.manifest.json`));

    // 2. Verify replica checksum
    const verifyResult = await replicaManager.verifyReplica({
      replicaPath: result.replicaPath,
      expectedFileChecksum: result.fileChecksum
    });
    assert.equal(verifyResult.valid, true);

    // 3. Corrupt replica detection
    const badVerify = await replicaManager.verifyReplica({
      replicaPath: result.replicaPath,
      expectedFileChecksum: '0'.repeat(64)
    });
    assert.equal(badVerify.valid, false);
  } finally {
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// B12 (G3.3): Advanced Calendar & Cron Schedule Calculator
// -----------------------------------------------------------------------------
test('Backup Calendar Calculator: cron parsing, timezone-aware next run calculation and missed runs', () => {
  // 1. Cron parsing
  const cron = parseCron('*/15 2 1 * 1-5'); // Every 15 mins at 2 AM on the 1st of month on Mon-Fri
  assert.equal(cron.minutes.has(0), true);
  assert.equal(cron.minutes.has(15), true);
  assert.equal(cron.minutes.has(30), true);
  assert.equal(cron.hours.has(2), true);
  assert.equal(cron.hours.has(3), false);

  // 2. Calculate next run in UTC
  // Starting from 2026-11-18 10:00:00 UTC
  const fromDate = new Date('2026-11-18T10:00:00.000Z');
  const nextRunDaily2AM = calculateNextRun('0 2 * * *', fromDate, 'UTC');
  // Next 2 AM UTC is on 2026-11-19
  assert.equal(nextRunDaily2AM.toISOString(), '2026-11-19T02:00:00.000Z');

  // Next run in Asia/Ho_Chi_Minh (UTC+7)
  // 2 AM in Ho Chi Minh is 19:00 previous day UTC
  const nextRunVN = calculateNextRun('0 2 * * *', fromDate, 'Asia/Ho_Chi_Minh');
  assert.equal(nextRunVN.toISOString(), '2026-11-18T19:00:00.000Z');

  // 3. Missed runs evaluation
  const now = Date.now();
  // Scheduled 2 minutes ago (within 5-min grace): should catch up!
  const scheduleRecent = { nextRunAt: new Date(now - 2 * 60 * 1000).toISOString() };
  const resRecent = evaluateMissedRuns(scheduleRecent, now - 60000, now, 5 * 60 * 1000);
  assert.equal(resRecent.shouldCatchUp, true);
  assert.equal(resRecent.missed, false);

  // Scheduled 2 hours ago (outside 5-min grace): marked missed!
  const scheduleOld = { nextRunAt: new Date(now - 120 * 60 * 1000).toISOString() };
  const resOld = evaluateMissedRuns(scheduleOld, now - 60000, now, 5 * 60 * 1000);
  assert.equal(resOld.shouldCatchUp, false);
  assert.equal(resOld.missed, true);
});
