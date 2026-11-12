'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createTrialJournal, cleanupTrialDatabase } = require('../electron/restore-trial-journal.cjs');

const profile = { id: 'fixture', host: 'localhost', user: 'tester', ssh: { enabled: false }, ssl: { enabled: false } };
const ownership = { database: `sqlpro_trial_${'a'.repeat(32)}`, marker: `owner_${'b'.repeat(24)}`, token: 'c'.repeat(64) };

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-journal-'));
  const key = crypto.randomBytes(32);
  const options = { directory,
    seal(text) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return { iv: iv.toString('hex'), data: data.toString('hex'), tag: cipher.getAuthTag().toString('hex') };
    },
    unseal(value) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'hex'));
      decipher.setAuthTag(Buffer.from(value.tag, 'hex'));
      return Buffer.concat([decipher.update(Buffer.from(value.data, 'hex')), decipher.final()]).toString('utf8');
    }
  };
  return { directory, journal: createTrialJournal(options), reopen: () => createTrialJournal(options), close: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

test('journal survives restart, hides ownership, binds target and preserves corrupt evidence', () => {
  const r = fixture();
  try {
    const id = r.journal.prepare(profile, ownership);
    const file = path.join(r.directory, `${id}.json`);
    assert.equal(fs.readFileSync(file, 'utf8').includes(ownership.token), false);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const journal = r.reopen();
    const [summary] = journal.list({ ...profile, name: 'renamed' });
    assert.equal(summary.targetMatches, true);
    assert.equal('token' in summary, false);
    assert.equal('marker' in summary, false);
    assert.equal(journal.list({ ...profile, host: 'another-server' })[0].targetMatches, false);
    assert.deepEqual(journal.list({ ...profile, id: 'other' }), []);
    assert.equal(journal.read(id).token, ownership.token);
    const encrypted = JSON.parse(fs.readFileSync(file, 'utf8'));
    encrypted.tag = '0'.repeat(32);
    fs.writeFileSync(file, JSON.stringify(encrypted));
    assert.throws(() => journal.read(id));
    assert.equal(fs.existsSync(file), true);
    assert.throws(() => journal.read('../outside'));
  } finally { r.close(); }
});

test('recovery drops only matching owned schema and rejects target drift, read-only and missing marker', async () => {
  const r = fixture();
  try {
    const record = r.journal.read(r.journal.prepare(profile, ownership));
    for (const variant of ['owned', 'wrong', 'missing', 'absent', 'denied', 'target', 'readonly']) {
      const commands = [];
      const session = { profile: { ...profile, ...(variant === 'target' ? { host: 'other' } : {}), readOnly: variant === 'readonly' },
        async raw(sql, params, timeout) {
          commands.push(sql); assert.equal(timeout, 15000);
          if (sql.startsWith('SELECT token')) {
            if (['missing', 'absent', 'denied'].includes(variant)) throw Object.assign(new Error('fixture'), { code: variant === 'denied' ? 'ER_TABLEACCESS_DENIED_ERROR' : 'ER_NO_SUCH_TABLE' });
            return { rows: [{ token: variant === 'wrong' ? 'wrong' : record.token }] };
          }
          return { rows: variant === 'absent' ? [] : [{ SCHEMA_NAME: record.database }] };
        } };
      if (['owned', 'absent'].includes(variant)) {
        assert.equal((await cleanupTrialDatabase(session, record)).cleanup, variant === 'owned' ? 'removed' : 'already-removed');
      } else await assert.rejects(() => cleanupTrialDatabase(session, record));
      assert.equal(commands.some(sql => sql.startsWith('DROP DATABASE')), variant === 'owned');
    }
  } finally { r.close(); }
});
