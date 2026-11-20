'use strict';

const crypto = require('node:crypto');

function error(code, message) {
  return Object.assign(new Error(message), { code });
}

function generateRecoveryKey() {
  const bytes = crypto.randomBytes(32); // 256 bits of entropy
  const hex = bytes.toString('hex').toUpperCase();
  // Format into 8 chunks of 8 characters: XXXXXXXX-XXXXXXXX-...
  const chunks = [];
  for (let i = 0; i < hex.length; i += 8) {
    chunks.push(hex.slice(i, i + 8));
  }
  return chunks.join('-');
}

function normalizeRecoveryKey(formattedKey) {
  if (typeof formattedKey !== 'string' || formattedKey.length > 256 || /[^0-9A-Fa-f\s-]/.test(formattedKey)) {
    throw error('INVALID_RECOVERY_KEY', 'Khóa phục hồi không hợp lệ.');
  }
  const clean = formattedKey.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  if (clean.length !== 64) {
    throw error('INVALID_RECOVERY_KEY', 'Độ dài khóa phục hồi không đúng (phải có 256 bit / 64 ký tự hex).');
  }
  return Buffer.from(clean, 'hex');
}

function createRecoveryKit({ masterKey, userEmail }) {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) {
    throw error('INVALID_MASTER_KEY', 'Master key phải là Buffer 32 byte.');
  }
  if (!userEmail || typeof userEmail !== 'string' || userEmail.length > 254 || !userEmail.trim()) {
    throw error('INVALID_USER_EMAIL', 'Email tài khoản không hợp lệ.');
  }

  const recoveryKey = generateRecoveryKey();
  const rawRecoveryBytes = normalizeRecoveryKey(recoveryKey);

  // Derive wrap key from recovery key using scrypt
  const salt = crypto.randomBytes(16);
  const wrapKey = crypto.scryptSync(rawRecoveryBytes, salt, 32, { N: 16384, r: 8, p: 1 });

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', wrapKey, iv);
  const encryptedMasterKey = Buffer.concat([cipher.update(masterKey), cipher.final()]);
  const authTag = cipher.getAuthTag();
  rawRecoveryBytes.fill(0); wrapKey.fill(0);

  const generatedAt = new Date().toISOString();

  const kitData = {
    version: 1,
    userEmail: userEmail.trim().toLowerCase(),
    generatedAt,
    saltHex: salt.toString('hex'),
    ivHex: iv.toString('hex'),
    authTagHex: authTag.toString('hex'),
    encryptedMasterKeyHex: encryptedMasterKey.toString('hex')
  };

  const emergencySheet = [
    '================================================================================',
    '                   SQLPRO EMERGENCY ACCOUNT RECOVERY KIT                        ',
    '================================================================================',
    '',
    `Account Email: ${kitData.userEmail}`,
    `Generated At:  ${generatedAt}`,
    '',
    'RECOVERY KEY (KEEP SECRET & STORE SECURELY OFFLINE):',
    `  ${recoveryKey}`,
    '',
    'IMPORTANT SAFETY NOTICE:',
    '- SqlPro uses zero-knowledge end-to-end encryption.',
    '- Your connection credentials and vault are encrypted with your master key.',
    '- If you forget your password, this recovery key is the ONLY way to unlock',
    '  your vault on a new device.',
    '- SqlPro servers CANNOT decrypt, reset, or recover your vault without this key.',
    '- NEVER share this key with anyone or send it via email/untrusted chat.',
    '================================================================================'
  ].join('\n');

  return {
    recoveryKey,
    kitData,
    emergencySheet
  };
}

function recoverMasterKey({ recoveryKey, kitData }) {
  if (!kitData || kitData.version !== 1 || typeof kitData.userEmail !== 'string' || kitData.userEmail.length > 254
      || !['saltHex', 'ivHex', 'authTagHex', 'encryptedMasterKeyHex'].every((field, i) =>
        typeof kitData[field] === 'string' && new RegExp(`^[a-f0-9]{${[32, 24, 32, 64][i]}}$`, 'i').test(kitData[field]))) {
    throw error('INVALID_KIT_DATA', 'Dữ liệu recovery kit không hợp lệ hoặc không tương thích phiên bản.');
  }

  const rawRecoveryBytes = normalizeRecoveryKey(recoveryKey);
  const salt = Buffer.from(kitData.saltHex, 'hex');
  const iv = Buffer.from(kitData.ivHex, 'hex');
  const authTag = Buffer.from(kitData.authTagHex, 'hex');
  const encryptedMasterKey = Buffer.from(kitData.encryptedMasterKeyHex, 'hex');

  const wrapKey = crypto.scryptSync(rawRecoveryBytes, salt, 32, { N: 16384, r: 8, p: 1 });
  rawRecoveryBytes.fill(0);
  const decipher = crypto.createDecipheriv('aes-256-gcm', wrapKey, iv);
  decipher.setAuthTag(authTag);

  try {
    const masterKey = Buffer.concat([decipher.update(encryptedMasterKey), decipher.final()]);
    return masterKey;
  } catch {
    throw error('RECOVERY_KEY_MISMATCH', 'Khóa phục hồi không chính xác; không thể giải mã master key.');
  } finally { wrapKey.fill(0); }
}

module.exports = {
  generateRecoveryKey,
  normalizeRecoveryKey,
  createRecoveryKit,
  recoverMasterKey
};
