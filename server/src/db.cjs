'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 1;

function openDatabase(filePath) {
  if (filePath !== ':memory:') {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (filePath !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  migrate(db);
  ensureAuthContext(db);
  return db;
}

function migrate(db) {
  const row = db.prepare('PRAGMA user_version').get();
  const version = Number(row && row.user_version) || 0;
  if (version >= SCHEMA_VERSION) return;
  db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      verifier TEXT NOT NULL,
      vault_salt TEXT NOT NULL,
      created_at TEXT NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS vaults (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      envelope TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    PRAGMA user_version = ${SCHEMA_VERSION};
    COMMIT;
  `);
}

function ensureAuthContext(db) {
  const existing = db.prepare('SELECT value FROM meta WHERE key = ?').get('auth_context');
  if (existing && existing.value) return existing.value;
  const value = crypto.randomBytes(16).toString('base64url');
  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('auth_context', value);
  return db.prepare('SELECT value FROM meta WHERE key = ?').get('auth_context').value;
}

function authContext(db) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get('auth_context').value;
}

function transaction(db, handler) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = handler();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore rollback failure
    }
    throw error;
  }
}

module.exports = {
  openDatabase,
  authContext,
  transaction
};
