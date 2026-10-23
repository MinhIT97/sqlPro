'use strict';

const express = require('express');
const path = require('node:path');
const { ApiError } = require('./errors.cjs');
const { authContext } = require('./db.cjs');
const { readConfig } = require('./config.cjs');
const { createRateLimiter } = require('./ratelimit.cjs');
const { registerAuthRoutes } = require('./auth.cjs');
const { registerVaultRoutes } = require('./vault.cjs');

const WEBSITE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src https://api.github.com",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ');

function securityHeaders(_request, response, next) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  next();
}

function createApp({ db, config = readConfig() }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy !== false) app.set('trust proxy', config.trustProxy);
  app.use(securityHeaders);
  app.use((request, response, next) => {
    if (request.path.startsWith('/api/')) response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '6mb' }));

  const limiter = createRateLimiter({ enabled: config.rateLimit.enabled });

  app.get('/api/meta', (_request, response) => {
    response.json({
      authContext: authContext(db),
      kdfVersion: 1,
      minPasswordLength: config.minPasswordLength,
      maxVaultBytes: config.maxVaultBytes,
      registrationAllowed: config.allowRegistration
    });
  });

  app.get('/healthz', (_request, response) => {
    db.prepare('SELECT 1').get();
    response.json({ ok: true });
  });

  registerAuthRoutes(app, { db, config, limiter });
  registerVaultRoutes(app, { db, config, limiter });

  app.use('/api', (_request, response) => {
    response.status(404).json({
      error: { code: 'NOT_FOUND', message: 'API không tồn tại.' }
    });
  });

  app.use(express.static(config.websiteDir, {
    index: 'index.html',
    extensions: ['html'],
    setHeaders(response, filePath) {
      if (path.extname(filePath) === '.html') {
        response.setHeader('Content-Security-Policy', WEBSITE_CSP);
        response.setHeader('Cache-Control', 'no-cache');
      } else {
        response.setHeader('Cache-Control', 'public, max-age=3600');
      }
    }
  }));

  app.use((error, _request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    let status = error instanceof ApiError ? error.status : (error.status || 500);
    let code = error instanceof ApiError ? error.code : 'INTERNAL_ERROR';
    let message = error instanceof ApiError ? error.message : 'Đã xảy ra lỗi trên server.';
    if (error && error.type === 'entity.too.large') {
      status = 413;
      code = 'PAYLOAD_TOO_LARGE';
      message = 'Dữ liệu gửi lên quá lớn.';
    } else if (error instanceof SyntaxError && error.status === 400) {
      status = 400;
      code = 'INVALID_JSON';
      message = 'Dữ liệu JSON không hợp lệ.';
    } else if (!(error instanceof ApiError) && status >= 500 && config.logErrors) {
      console.error('[sqlpro-server]', error && error.stack ? error.stack : error);
    }
    const body = { error: { code, message } };
    if (error && error.details && typeof error.details === 'object') {
      Object.assign(body, error.details);
    }
    response.status(status).json(body);
  });

  return app;
}

module.exports = { createApp, WEBSITE_CSP };
