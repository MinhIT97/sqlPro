'use strict';

const { ApiError } = require('./errors.cjs');
const { requireAuth } = require('./auth.cjs');
const { transaction } = require('./db.cjs');

function vaultSummary(db, userId) {
  const row = db.prepare('SELECT revision, updated_at FROM vaults WHERE user_id = ?').get(userId);
  return {
    revision: row ? row.revision : 0,
    updatedAt: row ? row.updated_at : null
  };
}

function enforceLimit(limiter, key, limit, windowMs, response) {
  const result = limiter.check(key, limit, windowMs);
  if (result.allowed) return;
  response.set('Retry-After', String(result.retryAfter));
  throw new ApiError(429, 'RATE_LIMITED', 'Bạn thao tác quá nhanh. Hãy thử lại sau.');
}

function registerVaultRoutes(app, { db, config, limiter }) {
  app.get('/api/vault', (request, response) => {
    const auth = requireAuth(db, request);
    enforceLimit(limiter, `vault:${auth.user.id}`, config.rateLimit.vaultUser, config.rateLimit.windowMs, response);
    const row = db.prepare(`
      SELECT revision, envelope, size_bytes, updated_at
      FROM vaults WHERE user_id = ?
    `).get(auth.user.id);
    response.set('Cache-Control', 'no-store');
    if (!row) {
      response.json({ revision: 0, envelope: null, updatedAt: null });
      return;
    }
    response.json({
      revision: row.revision,
      envelope: row.envelope,
      updatedAt: row.updated_at
    });
  });

  app.put('/api/vault', (request, response) => {
    const auth = requireAuth(db, request);
    enforceLimit(limiter, `vault:${auth.user.id}`, config.rateLimit.vaultUser, config.rateLimit.windowMs, response);
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const baseRevision = Number(body.baseRevision);
    if (!Number.isInteger(baseRevision) || baseRevision < 0) {
      throw new ApiError(400, 'INVALID_REVISION', 'Revision không hợp lệ.');
    }
    if (typeof body.envelope !== 'string' || body.envelope.length === 0) {
      throw new ApiError(400, 'INVALID_VAULT', 'Vault không hợp lệ.');
    }
    const size = Buffer.byteLength(body.envelope, 'utf8');
    if (size > config.maxVaultBytes) {
      throw new ApiError(413, 'VAULT_TOO_LARGE', 'Dữ liệu đồng bộ vượt quá giới hạn cho phép.');
    }
    const updatedAt = new Date().toISOString();
    const result = transaction(db, () => {
      const current = db.prepare(`
        SELECT revision, envelope, updated_at FROM vaults WHERE user_id = ?
      `).get(auth.user.id);
      const currentRevision = current ? current.revision : 0;
      if (baseRevision !== currentRevision) {
        const error = new ApiError(409, 'REVISION_CONFLICT', 'Dữ liệu đã được cập nhật từ thiết bị khác.');
        error.details = {
          revision: currentRevision,
          envelope: current ? current.envelope : null,
          updatedAt: current ? current.updated_at : null
        };
        throw error;
      }
      const nextRevision = currentRevision + 1;
      if (current) {
        db.prepare(`
          UPDATE vaults
          SET revision = ?, envelope = ?, size_bytes = ?, updated_at = ?
          WHERE user_id = ?
        `).run(nextRevision, body.envelope, size, updatedAt, auth.user.id);
      } else {
        db.prepare(`
          INSERT INTO vaults (user_id, revision, envelope, size_bytes, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(auth.user.id, nextRevision, body.envelope, size, updatedAt);
      }
      return { revision: nextRevision, updatedAt };
    });
    response.set('Cache-Control', 'no-store');
    response.json(result);
  });
}

module.exports = { registerVaultRoutes, vaultSummary };
