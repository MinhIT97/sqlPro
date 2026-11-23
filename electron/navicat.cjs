'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const AES_KEY = Buffer.from('libcckeylibcckey', 'utf8');
const AES_IV = Buffer.from('libcciv libcciv ', 'utf8');

function decodeXml(value) {
  const entities = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' };
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|quot|apos|lt|gt|amp);/gi, (match, entity) => {
    if (/^#x/i.test(entity)) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number(entity.slice(1)));
    return entities[entity] ?? match;
  });
}

function decodePassword(encoded) {
  if (typeof encoded !== 'string') return undefined;
  if (encoded.length === 0) return '';
  const candidates = [];
  if (encoded.length % 2 === 0 && /^[0-9a-f]+$/i.test(encoded)) {
    candidates.push(Buffer.from(encoded, 'hex'));
  }
  try {
    const base64 = Buffer.from(encoded, 'base64');
    if (base64.length && base64.length % 16 === 0) candidates.push(base64);
  } catch {
    // ignore malformed base64
  }
  for (const ciphertext of candidates) {
    if (!ciphertext.length || ciphertext.length % 16 !== 0) continue;
    try {
      const decipher = crypto.createDecipheriv('aes-128-cbc', AES_KEY, AES_IV);
      // Node removes PKCS padding in final(); all remaining bytes are password data.
      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const text = plain.toString('utf8');
      if (Buffer.from(text, 'utf8').equals(plain)) return text;
    } catch {
      // try the next encoding
    }
  }
  return undefined;
}

function decryptPassword(encoded) {
  // Keep the diagnostic API compatible; imports preserve the missing/error state.
  return decodePassword(encoded) ?? '';
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  return String(value).toLowerCase() === 'true' || String(value) === '1';
}

function verifyCertificateValue(verifyCa, weakValidation) {
  if (verifyCa === undefined && weakValidation === undefined) return undefined;
  const explicitlyDisabled = ['false', '0'].includes(String(verifyCa).toLowerCase());
  return !explicitlyDisabled && !toBoolean(weakValidation);
}

function toPort(value, fallback) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
}

function normalizeType(value) {
  const type = String(value || '').toUpperCase();
  if (type === 'MARIADB') return 'mariadb';
  if (type === 'MYSQL' || type === '') return 'mysql';
  return null;
}

function buildConnection(raw) {
  const type = normalizeType(raw.type);
  if (!type || !raw.host) return null;
  const sshEnabled = raw.sshEnabled && raw.sshHost;
  return {
    name: String(raw.name || `${raw.user || 'root'}@${raw.host}`).slice(0, 120),
    type,
    host: String(raw.host).slice(0, 255),
    port: toPort(raw.port, 3306),
    user: String(raw.user || '').slice(0, 128),
    password: raw.password,
    database: String(raw.database || '').slice(0, 128),
    ssl: {
      enabled: Boolean(raw.sslEnabled),
      verify: raw.sslVerify === undefined ? true : Boolean(raw.sslVerify),
      ca: raw.sslCa || '',
      cert: raw.sslCert || '',
      key: raw.sslKey || '',
      passphrase: raw.sslKeyPassword
    },
    ssh: {
      enabled: Boolean(sshEnabled),
      host: sshEnabled ? String(raw.sshHost).slice(0, 255) : '',
      port: toPort(raw.sshPort, 22),
      user: sshEnabled ? String(raw.sshUser || '').slice(0, 128) : '',
      authMethod: raw.sshAuthMethod === 'key' ? 'key' : 'password',
      password: sshEnabled ? raw.sshPassword : undefined,
      privateKeyPath: sshEnabled ? raw.sshKeyPath || '' : '',
      passphrase: sshEnabled ? raw.sshPassphrase : undefined
    },
    source: 'navicat',
    importKey: [
      type,
      String(raw.name || ''),
      String(raw.host),
      toPort(raw.port, 3306),
      String(raw.user || ''),
      sshEnabled ? String(raw.sshHost) : ''
    ].join('|')
  };
}

function fromJsonServer(server) {
  const ssl = server.SSL || {};
  const ssh = server.SSH || {};
  const authMethod = String(ssh.AuthMethod || '').toLowerCase();
  return buildConnection({
    name: server.Name,
    type: server.ConnType,
    host: server.Hostname,
    port: server.Port,
    user: server.Username,
    password: decodePassword(server.Password),
    database: server.Database || server.DefaultDatabase || '',
    sslEnabled: toBoolean(server.UseSSL),
    sslVerify: verifyCertificateValue(ssl.VerifyCA, ssl.WeakCertValidation),
    sslCa: ssl.CACert || ssl.RootCert || '',
    sslCert: ssl.ClientCertFile || '',
    sslKey: ssl.ClientKeyFile || '',
    sslKeyPassword: decodePassword(ssl.ClientKeyPassword),
    sshEnabled: toBoolean(server.UseSSH),
    sshHost: ssh.Host || '',
    sshPort: ssh.Port,
    sshUser: ssh.UserName || '',
    sshAuthMethod: authMethod.includes('key') || authMethod.includes('public') ? 'key' : 'password',
    sshPassword: decodePassword(ssh.Password),
    sshKeyPath: ssh.PrivateKeyPath || '',
    sshPassphrase: decodePassword(ssh.Passphrase)
  });
}

function fromXmlAttributes(attrs) {
  const authMethod = String(attrs.SSH_AuthenMethod || '').toLowerCase();
  return buildConnection({
    name: attrs.ConnectionName,
    type: attrs.ConnType,
    host: attrs.Host,
    port: attrs.Port,
    user: attrs.UserName,
    password: decodePassword(attrs.Password),
    database: attrs.Database || '',
    sslEnabled: toBoolean(attrs.SSL),
    sslVerify: verifyCertificateValue(attrs.SSL_VerifyCA, attrs.SSL_WeakCertValidation),
    sslCa: attrs.SSL_CACert || attrs.SSL_RootCert || '',
    sslCert: attrs.SSL_ClientCert || '',
    sslKey: attrs.SSL_ClientKey || '',
    sslKeyPassword: decodePassword(attrs.SSL_PEMClientKeyPassword),
    sshEnabled: toBoolean(attrs.SSH),
    sshHost: attrs.SSH_Host || '',
    sshPort: attrs.SSH_Port,
    sshUser: attrs.SSH_UserName || '',
    sshAuthMethod: authMethod.includes('key') || authMethod.includes('public') ? 'key' : 'password',
    sshPassword: decodePassword(attrs.SSH_Password),
    sshKeyPath: attrs.SSH_PrivateKey || '',
    sshPassphrase: decodePassword(attrs.SSH_Passphrase)
  });
}

function parseJson(text) {
  const data = JSON.parse(text);
  const servers = [];
  const pushServer = (server) => {
    if (server && typeof server === 'object') servers.push(server);
  };
  if (Array.isArray(data)) {
    data.forEach(pushServer);
  } else if (Array.isArray(data.Connections)) {
    data.Connections.forEach(pushServer);
  } else if (Array.isArray(data.Users)) {
    for (const user of data.Users) {
      for (const project of user.Projects || []) {
        for (const server of project.Servers || []) pushServer(server);
      }
    }
  } else if (Array.isArray(data.Servers)) {
    data.Servers.forEach(pushServer);
  }
  return servers.map(fromJsonServer);
}

function parseXml(text) {
  const connections = [];
  // Quoted attribute values may contain >; comments/CDATA are not connections.
  const connectionPattern = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<Connection(?=[\s/>])((?:[^<>"']|"[^"]*"|'[^']*')*)\/?>/g;
  let match;
  while ((match = connectionPattern.exec(text)) !== null) {
    if (match[1] === undefined) continue;
    const attributes = Object.create(null);
    const attributePattern = /([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let attribute;
    while ((attribute = attributePattern.exec(match[1])) !== null) {
      attributes[attribute[1]] = decodeXml(attribute[2] ?? attribute[3]);
    }
    connections.push(fromXmlAttributes(attributes));
  }
  return connections;
}

function parseNavicatFile(filePath) {
  let parsed;
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const trimmed = text.trimStart();
    if (!trimmed) throw new Error('empty');
    parsed = trimmed.startsWith('<') ? parseXml(text) : parseJson(text);
  } catch {
    // JSON/OS exceptions may contain credential-bearing input or private file paths.
    const error = new Error('Không đọc được tệp Navicat hoặc định dạng tệp không hợp lệ. Hãy kiểm tra tệp và quyền truy cập.');
    error.code = 'NAVICAT_IMPORT_FAILED';
    throw error;
  }
  const connections = [];
  let skipped = 0;
  for (const connection of parsed) {
    if (connection) connections.push(connection);
    else skipped += 1;
  }
  if (!connections.length && !skipped) {
    throw new Error('Không tìm thấy kết nối MySQL/MariaDB trong tệp Navicat.');
  }
  return { connections, skipped };
}

module.exports = { decryptPassword, parseNavicatFile };
