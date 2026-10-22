'use strict';

const path = require('node:path');

const SERVER_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

function positiveInteger(value, fallback, minimum = 1) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

function booleanEnvironment(value, fallback) {
  if (value === undefined) return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

function trustProxyValue(value) {
  if (value === undefined || value === '') return false;
  const text = String(value).toLowerCase();
  if (text === 'true') return true;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : false;
}

function readConfig(environment = process.env) {
  return {
    host: environment.HOST || '0.0.0.0',
    port: positiveInteger(environment.PORT, 8080, 0),
    databasePath: environment.SQLPRO_DB || path.join(SERVER_ROOT, 'data', 'sqlpro.db'),
    websiteDir: environment.WEBSITE_DIR || path.join(REPO_ROOT, 'website'),
    allowRegistration: booleanEnvironment(environment.ALLOW_REGISTRATION, true),
    sessionTtlDays: positiveInteger(environment.SESSION_TTL_DAYS, 30),
    maxVaultBytes: positiveInteger(environment.MAX_VAULT_BYTES, 5 * 1024 * 1024, 1024),
    minPasswordLength: positiveInteger(environment.MIN_PASSWORD_LENGTH, 10, 8),
    trustProxy: trustProxyValue(environment.TRUST_PROXY),
    logErrors: environment.NODE_ENV !== 'test',
    rateLimit: {
      enabled: booleanEnvironment(environment.RATE_LIMIT_DISABLED, false) === false,
      windowMs: positiveInteger(environment.RATE_LIMIT_WINDOW_MS, 60_000, 1000),
      authIp: positiveInteger(environment.RATE_LIMIT_AUTH_IP, 10),
      authEmail: positiveInteger(environment.RATE_LIMIT_AUTH_EMAIL, 5),
      vaultUser: positiveInteger(environment.RATE_LIMIT_VAULT_USER, 60)
    }
  };
}

module.exports = { readConfig, SERVER_ROOT, REPO_ROOT };
