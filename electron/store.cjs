'use strict';

const { app, safeStorage } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const STORE_VERSION = 1;

function storePath() {
  return path.join(app.getPath('userData'), 'connections.json');
}

function keyPath() {
  return path.join(app.getPath('userData'), '.connections-key');
}

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    if (parsed && Array.isArray(parsed.connections)) return parsed;
  } catch {
    // missing or malformed store
  }
  return { version: STORE_VERSION, connections: [] };
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  const temporary = `${storePath()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, storePath());
}

function safeStorageAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function localKey() {
  try {
    const stored = fs.readFileSync(keyPath(), 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(stored)) return Buffer.from(stored, 'hex');
  } catch {
    // generate below
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(keyPath()), { recursive: true });
  fs.writeFileSync(keyPath(), key.toString('hex'), { encoding: 'utf8', mode: 0o600 });
  return key;
}

function seal(secret) {
  if (secret === undefined || secret === null || secret === '') return null;
  const value = String(secret);
  if (safeStorageAvailable()) {
    try {
      return { alg: 'safeStorage', data: safeStorage.encryptString(value).toString('base64') };
    } catch {
      // fall through to local encryption
    }
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', localKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    alg: 'local',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64')
  };
}

function unseal(sealed) {
  if (!sealed || typeof sealed !== 'object') return '';
  try {
    if (sealed.alg === 'safeStorage') {
      return safeStorage.decryptString(Buffer.from(sealed.data, 'base64'));
    }
    if (sealed.alg === 'local') {
      const decipher = crypto.createDecipheriv('aes-256-gcm', localKey(), Buffer.from(sealed.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(sealed.data, 'base64')),
        decipher.final()
      ]).toString('utf8');
    }
  } catch {
    return '';
  }
  return '';
}

function text(value, maxLength) {
  return String(value === undefined || value === null ? '' : value).trim().slice(0, maxLength);
}

function port(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
}

function normalizeSsl(input) {
  const ssl = input && typeof input === 'object' ? input : {};
  return {
    enabled: Boolean(ssl.enabled),
    verify: ssl.verify === undefined ? false : Boolean(ssl.verify),
    ca: text(ssl.ca, 1024),
    cert: text(ssl.cert, 1024),
    key: text(ssl.key, 1024)
  };
}

function normalizeSsh(input) {
  const ssh = input && typeof input === 'object' ? input : {};
  return {
    enabled: Boolean(ssh.enabled),
    host: text(ssh.host, 255),
    port: port(ssh.port, 22),
    user: text(ssh.user, 128),
    authMethod: ssh.authMethod === 'key' ? 'key' : 'password',
    privateKeyPath: text(ssh.privateKeyPath, 1024)
  };
}

function normalizeProfile(input, existing) {
  if (!input || typeof input !== 'object') throw new Error('Thông tin kết nối không hợp lệ.');
  const host = text(input.host, 255);
  if (!host) throw new Error('Host không được để trống.');
  const ssh = normalizeSsh(input.ssh);
  if (ssh.enabled && !ssh.host) throw new Error('SSH host không được để trống.');
  const type = input.type === 'mariadb' ? 'mariadb' : 'mysql';
  const ssl = normalizeSsl(input.ssl);
  ssl.passphrase = input.ssl && input.ssl.passphrase !== undefined
    ? seal(input.ssl.passphrase)
    : (existing && existing.ssl ? existing.ssl.passphrase : null);
  const password = input.password === undefined
    ? (existing ? existing.password : null)
    : seal(input.password);
  const sshPassword = input.sshPassword === undefined
    ? (existing ? existing.sshPassword : null)
    : seal(input.sshPassword);
  const sshPassphrase = input.sshPassphrase === undefined
    ? (existing ? existing.sshPassphrase : null)
    : seal(input.sshPassphrase);
  const now = new Date().toISOString();
  return {
    id: existing ? existing.id : crypto.randomUUID(),
    name: text(input.name, 120) || `${text(input.user, 128) || 'root'}@${host}`,
    type,
    host,
    port: port(input.port, 3306),
    user: text(input.user, 128),
    database: text(input.database, 128),
    ssl,
    ssh,
    password,
    sshPassword,
    sshPassphrase,
    source: input.source === 'navicat' ? 'navicat' : (existing ? existing.source : 'manual'),
    importKey: input.importKey === undefined
      ? (existing ? existing.importKey : null)
      : (text(input.importKey, 512) || null),
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now
  };
}

function sanitize(profile) {
  return {
    id: profile.id,
    name: profile.name,
    type: profile.type,
    host: profile.host,
    port: profile.port,
    user: profile.user,
    database: profile.database,
    ssl: { enabled: profile.ssl.enabled, verify: profile.ssl.verify, ca: profile.ssl.ca, cert: profile.ssl.cert, key: profile.ssl.key },
    ssh: {
      enabled: profile.ssh.enabled,
      host: profile.ssh.host,
      port: profile.ssh.port,
      user: profile.ssh.user,
      authMethod: profile.ssh.authMethod,
      privateKeyPath: profile.ssh.privateKeyPath
    },
    hasPassword: Boolean(profile.password),
    hasSslPassphrase: Boolean(profile.ssl.passphrase),
    hasSshPassword: Boolean(profile.sshPassword),
    hasSshPassphrase: Boolean(profile.sshPassphrase),
    source: profile.source,
    updatedAt: profile.updatedAt
  };
}

function list() {
  return readStore().connections.map(sanitize);
}

function save(input) {
  const store = readStore();
  const existing = input && input.id
    ? store.connections.find((profile) => profile.id === input.id)
    : null;
  if (input && input.id && !existing) throw new Error('Không tìm thấy kết nối cần cập nhật.');
  const profile = normalizeProfile(input, existing);
  if (existing) {
    const index = store.connections.indexOf(existing);
    store.connections[index] = profile;
  } else {
    store.connections.push(profile);
  }
  writeStore(store);
  return sanitize(profile);
}

function remove(id) {
  const store = readStore();
  const next = store.connections.filter((profile) => profile.id !== id);
  if (next.length === store.connections.length) throw new Error('Không tìm thấy kết nối cần xóa.');
  writeStore({ version: STORE_VERSION, connections: next });
}

function getWithSecrets(id) {
  const profile = readStore().connections.find((entry) => entry.id === id);
  if (!profile) throw new Error('Không tìm thấy kết nối.');
  return {
    ...profile,
    password: unseal(profile.password),
    sshPassword: unseal(profile.sshPassword),
    sshPassphrase: unseal(profile.sshPassphrase),
    ssl: {
      ...profile.ssl,
      passphrase: unseal(profile.ssl.passphrase)
    }
  };
}

function importMany(imported) {
  const store = readStore();
  let added = 0;
  let updated = 0;
  for (const input of imported) {
    const importKey = input.importKey;
    const existing = importKey
      ? store.connections.find((profile) => profile.importKey === importKey)
      : null;
    const sshPassword = input.sshPassword !== undefined ? input.sshPassword : input.ssh?.password;
    const sshPassphrase = input.sshPassphrase !== undefined ? input.sshPassphrase : input.ssh?.passphrase;
    const payload = {
      ...input,
      password: input.password || undefined,
      sshPassword: sshPassword || undefined,
      sshPassphrase: sshPassphrase || undefined,
      ssl: input.ssl
        ? { ...input.ssl, passphrase: input.ssl.passphrase || undefined }
        : input.ssl
    };
    const profile = normalizeProfile(payload, existing);
    profile.source = 'navicat';
    profile.importKey = importKey || null;
    if (existing) {
      store.connections[store.connections.indexOf(existing)] = profile;
      updated += 1;
    } else {
      store.connections.push(profile);
      added += 1;
    }
  }
  writeStore(store);
  return { added, updated, connections: store.connections.map(sanitize) };
}

module.exports = { list, save, remove, getWithSecrets, importMany };
