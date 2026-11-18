'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  generateRecoveryKey,
  normalizeRecoveryKey,
  createRecoveryKit,
  recoverMasterKey
} = require('../electron/recovery-kit.cjs');

test('Recovery Kit: key generation, wrapping round-trip and zero-knowledge master key recovery', () => {
  const masterKey = crypto.randomBytes(32);
  const userEmail = 'user@example.com';

  // 1. Create recovery kit
  const { recoveryKey, kitData, emergencySheet } = createRecoveryKit({ masterKey, userEmail });

  assert.ok(recoveryKey);
  assert.equal(recoveryKey.split('-').length, 8);
  assert.ok(emergencySheet.includes(userEmail));
  assert.ok(emergencySheet.includes(recoveryKey));

  // 2. Recover master key with correct recovery key
  const recovered = recoverMasterKey({ recoveryKey, kitData });
  assert.deepEqual(recovered, masterKey);

  // 3. Reject wrong recovery key
  const wrongKey = generateRecoveryKey();
  assert.throws(
    () => recoverMasterKey({ recoveryKey: wrongKey, kitData }),
    { code: 'RECOVERY_KEY_MISMATCH' }
  );

  // 4. Reject tampered kit data
  const tamperedKit = {
    ...kitData,
    authTagHex: '0'.repeat(32)
  };
  assert.throws(
    () => recoverMasterKey({ recoveryKey, kitData: tamperedKit }),
    { code: 'RECOVERY_KEY_MISMATCH' }
  );
});

test('Recovery Kit: key normalization handles spaces, hyphens and case-insensitivity', () => {
  const key = generateRecoveryKey();
  const rawBytes = normalizeRecoveryKey(key);
  assert.equal(rawBytes.length, 32);

  // With extra whitespace and lower case
  const formatted = `  ${key.toLowerCase()}  `;
  const normalized = normalizeRecoveryKey(formatted);
  assert.deepEqual(normalized, rawBytes);

  // Invalid length
  assert.throws(() => normalizeRecoveryKey('ABCD-1234'), { code: 'INVALID_RECOVERY_KEY' });
});
