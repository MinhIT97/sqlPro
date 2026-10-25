const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const userDataDir = path.join(process.env.APPDATA, 'SqlPro');
const keyFile = path.join(userDataDir, '.key');
const connectionsFile = path.join(userDataDir, 'connections.json');

function getLocalKey() {
  if (fs.existsSync(keyFile)) {
    const raw = fs.readFileSync(keyFile, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(keyFile, key.toString('hex'), { encoding: 'utf8' });
  return key;
}

function seal(val, key) {
  if (!val) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(val), 'utf8'), cipher.final()]);
  return {
    alg: 'local',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64')
  };
}

async function run() {
  console.log('Extracting passwords from Navicat Registry...');
  const pythonScript = path.join(__dirname, 'import-navicat-passwords.py');
  const output = execSync(`python "${pythonScript}"`, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const navicatConns = JSON.parse(output);
  console.log(`Found ${navicatConns.length} connections in Navicat.`);

  if (!fs.existsSync(connectionsFile)) {
    console.error('connections.json does not exist!');
    return;
  }

  const key = getLocalKey();
  const store = JSON.parse(fs.readFileSync(connectionsFile, 'utf8'));
  let updatedCount = 0;

  for (const conn of store.connections) {
    const match = navicatConns.find(n => n.name.toLowerCase() === conn.name.toLowerCase());
    if (match) {
      if (match.password) {
        conn.password = seal(match.password, key);
        updatedCount++;
      }
      if (match.ssh_password && conn.ssh) {
        conn.sshPassword = seal(match.ssh_password, key);
        updatedCount++;
      }
    }

    // Pre-trust known SSH server 192.168.50.93:22
    if (conn.ssh && conn.ssh.host === '192.168.50.93') {
      conn.ssh.knownHostKey = {
        host: '192.168.50.93',
        port: 22,
        fingerprint: 'SHA256:bNRgjhqDuV2RB/SkYk2i+1u2pVDYChlC2bpkB9T+7ss'
      };
    }
  }

  fs.writeFileSync(connectionsFile, JSON.stringify(store, null, 2), 'utf8');
  console.log(`Successfully updated ${updatedCount} password fields in connections.json!`);
}

run().catch(console.error);
