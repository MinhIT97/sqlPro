'use strict';

const crypto = require('node:crypto');
const { ApiError, badRequest, conflict, forbidden, unauthorized } = require('./errors.cjs');
const { createTaskGate } = require('./async-gate.cjs');

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const TOKEN_BYTES = 32;

function normalizeEmail(value) {
  if (typeof value !== 'string') throw badRequest('INVALID_EMAIL', 'Email không hợp lệ.');
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || /\s/.test(email) || !email.includes('@')) {
    throw badRequest('INVALID_EMAIL', 'Email không hợp lệ.');
  }
  return email;
}

function parseAuthProof(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw badRequest('INVALID_AUTH_PROOF', 'Thông tin xác thực không hợp lệ.');
  }
  const buffer = Buffer.from(value, 'base64url');
  if (buffer.length !== 32) {
    throw badRequest('INVALID_AUTH_PROOF', 'Thông tin xác thực không hợp lệ.');
  }
  return value;
}

const hashGate = createTaskGate();
function scrypt(secret, salt) {
  return hashGate.run(() => new Promise((resolve, reject) => crypto.scrypt(secret, salt, 32, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM
  }, (error, result) => error ? reject(error) : resolve(result))));
}

async function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(Buffer.from(secret, 'utf8'), salt);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

async function verifySecret(secret, encoded) {
  if (typeof encoded !== 'string') return false;
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (N !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return false;
  try {
    const salt = Buffer.from(parts[4], 'base64url');
    const expected = Buffer.from(parts[5], 'base64url');
    if (salt.length < 8 || expected.length !== 32) return false;
    const actual = await scrypt(Buffer.from(secret, 'utf8'), salt);
    return crypto.timingSafeEqual(actual, expected);
  } catch (error) {
    if (error.code === 'AUTH_BUSY') throw error;
    return false;
  }
}

const DUMMY_VERIFIER = `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${crypto.randomBytes(16).toString('base64url')}$${crypto.randomBytes(32).toString('base64url')}`;

function verifyDummy(secret) {
  return verifySecret(secret, DUMMY_VERIFIER);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function bearerToken(request) {
  const header = request.get('authorization') || '';
  const match = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/i.exec(header);
  return match ? match[1] : '';
}

function createSession(db, userId, ttlDays) {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
  db.prepare(`
    INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_used_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(hashToken(token), userId, now.toISOString(), expiresAt.toISOString(), now.toISOString());
  return token;
}

function purgeExpiredSessions(db, now = new Date().toISOString()) {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
}

function requireAuth(db, request) {
  const token = bearerToken(request);
  if (!token) throw unauthorized('UNAUTHORIZED', 'Thiếu phiên đăng nhập.');
  const tokenHash = hashToken(token);
  const row = db.prepare(`
    SELECT s.token_hash, s.expires_at, u.id, u.email, u.disabled
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `).get(tokenHash);
  if (!row) throw unauthorized('INVALID_TOKEN', 'Phiên đăng nhập không hợp lệ.');
  if (Date.parse(row.expires_at) <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    throw unauthorized('SESSION_EXPIRED', 'Phiên đăng nhập đã hết hạn.');
  }
  if (row.disabled) throw unauthorized('ACCOUNT_DISABLED', 'Tài khoản đã bị khóa.');
  db.prepare('UPDATE sessions SET last_used_at = ? WHERE token_hash = ?')
    .run(new Date().toISOString(), tokenHash);
  return {
    tokenHash,
    user: { id: row.id, email: row.email }
  };
}

function vaultInfo(db, userId) {
  const row = db.prepare('SELECT revision, updated_at FROM vaults WHERE user_id = ?').get(userId);
  return {
    revision: row ? row.revision : 0,
    updatedAt: row ? row.updated_at : null
  };
}

function enforceAuthLimit(limiter, key, limit, windowMs, response) {
  const result = limiter.check(key, limit, windowMs);
  if (result.allowed) return;
  response.set('Retry-After', String(result.retryAfter));
  throw new ApiError(429, 'RATE_LIMITED', 'Bạn thao tác quá nhanh. Hãy thử lại sau.');
}

function sendSession(response, db, config, user, vaultSalt, status = 200) {
  const token = createSession(db, user.id, config.sessionTtlDays);
  const vault = vaultInfo(db, user.id);
  response.status(status).json({
    token,
    user,
    vaultSalt,
    revision: vault.revision,
    updatedAt: vault.updatedAt
  });
}

function registerAuthRoutes(app, { db, config, limiter }) {
  app.post('/api/auth/register', async (request, response) => {
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const email = normalizeEmail(body.email);
    const authProof = parseAuthProof(body.authProof);
    if (!config.allowRegistration) {
      throw forbidden('REGISTRATION_DISABLED', 'Server này không mở đăng ký tài khoản.');
    }
    enforceAuthLimit(limiter, `auth-ip:${request.ip}`, config.rateLimit.authIp, config.rateLimit.windowMs, response);
    enforceAuthLimit(limiter, `auth-email:${email}`, config.rateLimit.authEmail, config.rateLimit.windowMs, response);
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) throw conflict('EMAIL_TAKEN', 'Email đã được đăng ký.');

    const user = { id: crypto.randomUUID(), email };
    const vaultSalt = crypto.randomBytes(16).toString('base64url');
    const createdAt = new Date().toISOString();
    const verifier = await hashSecret(authProof);
    try {
      db.prepare(`
        INSERT INTO users (id, email, verifier, vault_salt, created_at, disabled)
        VALUES (?, ?, ?, ?, ?, 0)
      `).run(user.id, user.email, verifier, vaultSalt, createdAt);
    } catch (error) {
      if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
        throw conflict('EMAIL_TAKEN', 'Email đã được đăng ký.');
      }
      throw error;
    }
    purgeExpiredSessions(db);
    sendSession(response, db, config, user, vaultSalt, 201);
  });

  app.post('/api/auth/login', async (request, response) => {
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const email = normalizeEmail(body.email);
    const authProof = parseAuthProof(body.authProof);
    enforceAuthLimit(limiter, `auth-ip:${request.ip}`, config.rateLimit.authIp, config.rateLimit.windowMs, response);
    enforceAuthLimit(limiter, `auth-email:${email}`, config.rateLimit.authEmail, config.rateLimit.windowMs, response);
    const row = db.prepare(`
      SELECT id, email, verifier, vault_salt, disabled FROM users WHERE email = ?
    `).get(email);
    if (!row) {
      await verifyDummy(authProof);
      throw unauthorized('INVALID_CREDENTIALS', 'Email hoặc mật khẩu không đúng.');
    }
    if (!await verifySecret(authProof, row.verifier)) {
      throw unauthorized('INVALID_CREDENTIALS', 'Email hoặc mật khẩu không đúng.');
    }
    if (row.disabled) throw forbidden('ACCOUNT_DISABLED', 'Tài khoản đã bị khóa.');
    purgeExpiredSessions(db);
    sendSession(response, db, config, { id: row.id, email: row.email }, row.vault_salt);
  });

  app.get('/api/auth/me', (request, response) => {
    const auth = requireAuth(db, request);
    const row = db.prepare('SELECT vault_salt FROM users WHERE id = ?').get(auth.user.id);
    if (!row) throw unauthorized('INVALID_TOKEN', 'Phiên đăng nhập không hợp lệ.');
    const vault = vaultInfo(db, auth.user.id);
    response.set('Cache-Control', 'no-store');
    response.json({
      user: auth.user,
      vaultSalt: row.vault_salt,
      revision: vault.revision,
      updatedAt: vault.updatedAt,
      maxVaultBytes: config.maxVaultBytes
    });
  });

  app.post('/api/auth/logout', (request, response) => {
    const auth = requireAuth(db, request);
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(auth.tokenHash);
    response.status(204).end();
  });
}

module.exports = {
  normalizeEmail,
  parseAuthProof,
  hashSecret,
  verifySecret,
  verifyDummy,
  hashToken,
  createSession,
  purgeExpiredSessions,
  requireAuth,
  registerAuthRoutes
};
