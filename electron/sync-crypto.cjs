'use strict';

const crypto = require('node:crypto');

const KDF_VERSION = 1;
const MASTER_SALT_PREFIX = 'sqlpro-master-v1|';
const AUTH_INFO = 'sqlpro-auth-v1';
const VAULT_INFO = 'sqlpro-vault-v1';
const ENVELOPE_VERSION = 'v1';
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 128 * 1024 * 1024;
const AUTH_PROOF_BYTES = 32;
const VAULT_KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function masterSalt(email) {
  return crypto.createHash('sha256')
    .update(`${MASTER_SALT_PREFIX}${normalizeEmail(email)}`, 'utf8')
    .digest();
}

function deriveMasterKey(password, email) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Mật khẩu không hợp lệ.');
  }
  return crypto.scryptSync(Buffer.from(password, 'utf8'), masterSalt(email), 32, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM
  });
}

function hkdf(masterKey, salt, info, length) {
  return Buffer.from(crypto.hkdfSync('sha256', masterKey, salt, info, length));
}

function deriveAuthProof(masterKey, authContext) {
  const context = Buffer.from(String(authContext || ''), 'base64url');
  if (context.length < 8) throw new Error('Auth context không hợp lệ.');
  return hkdf(masterKey, context, AUTH_INFO, AUTH_PROOF_BYTES).toString('base64url');
}

function deriveVaultKey(masterKey, vaultSalt) {
  const salt = Buffer.from(String(vaultSalt || ''), 'base64url');
  if (salt.length < 8) throw new Error('Vault salt không hợp lệ.');
  return hkdf(masterKey, salt, VAULT_INFO, VAULT_KEY_BYTES);
}

function deriveKeys({ password, email, authContext, vaultSalt }) {
  const masterKey = deriveMasterKey(password, email);
  return {
    masterKey,
    authProof: deriveAuthProof(masterKey, authContext),
    vaultKey: deriveVaultKey(masterKey, vaultSalt)
  };
}

function aad(userId) {
  if (typeof userId !== 'string' || !userId) throw new Error('Thiếu user id.');
  return Buffer.from(`${VAULT_INFO}:${userId}`, 'utf8');
}

function encryptVault(vault, vaultKey, userId) {
  if (!Buffer.isBuffer(vaultKey) || vaultKey.length !== VAULT_KEY_BYTES) {
    throw new Error('Vault key không hợp lệ.');
  }
  const plaintext = Buffer.from(JSON.stringify(vault), 'utf8');
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', vaultKey, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(userId));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENVELOPE_VERSION}.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

function decryptVault(envelope, vaultKey, userId) {
  if (typeof envelope !== 'string') {
    const error = new Error('Vault không hợp lệ.');
    error.code = 'VAULT_DECRYPT_FAILED';
    throw error;
  }
  const parts = envelope.split('.');
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
    const error = new Error('Vault không hợp lệ.');
    error.code = 'VAULT_DECRYPT_FAILED';
    throw error;
  }
  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    const ciphertext = Buffer.from(parts[3], 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('invalid envelope');
    const decipher = crypto.createDecipheriv('aes-256-gcm', vaultKey, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(userId));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch {
    const error = new Error('Không thể giải mã dữ liệu đồng bộ. Mật khẩu hoặc dữ liệu không đúng.');
    error.code = 'VAULT_DECRYPT_FAILED';
    throw error;
  }
}

module.exports = {
  KDF_VERSION,
  ENVELOPE_VERSION,
  normalizeEmail,
  deriveMasterKey,
  deriveAuthProof,
  deriveVaultKey,
  deriveKeys,
  encryptVault,
  decryptVault
};
