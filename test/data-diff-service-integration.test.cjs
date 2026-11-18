'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const { DataDiffService } = require('../electron/data-diff-service.cjs');

test('Data Diff service on a disposable engine: cloneable status, numeric keys, snapshot proof and blocked text keys', {
  skip: !process.env.SQLPRO_DIFF_SERVICE_PORT, timeout: 30000
}, async () => {
  const profile = { id: 'diff-fixture', host: '127.0.0.1', port: Number(process.env.SQLPRO_DIFF_SERVICE_PORT), user: 'root', password: '', readOnly: true };
  const admin = await mysql.createConnection({ host: profile.host, port: profile.port, user: profile.user, password: profile.password });
  const database = `sqlpro_diff_service_${crypto.randomBytes(8).toString('hex')}`;
  const service = new DataDiffService({ store: { getWithSecrets: () => profile } });
  let created = false;
  const run = async (sourceTable, targetTable) => {
    const { jobId } = await service.startDiff({ sourceProfileId: profile.id, targetProfileId: profile.id,
      sourceDb: database, targetDb: database, sourceTable, targetTable });
    await service.jobs.get(jobId).promise;
    const result = service.getDiffStatus(jobId);
    assert.doesNotThrow(() => structuredClone(result));
    return result;
  };
  try {
    await admin.query(`CREATE DATABASE \`${database}\``); created = true;
    await admin.query(`USE \`${database}\``);
    for (const table of ['src', 'dst']) await admin.query(`CREATE TABLE ${table} (id BIGINT PRIMARY KEY, amount DECIMAL(30,8), value VARCHAR(100)) ENGINE=InnoDB`);
    await admin.query("INSERT INTO src VALUES (9007199254740993,123456789012345.12345678,'same'),(9007199254740994,2,'source')");
    await admin.query("INSERT INTO dst VALUES (9007199254740993,123456789012345.12345678,'same'),(9007199254740995,3,'target')");
    const report = await run('src', 'dst');
    assert.equal(report.status, 'completed');
    assert.equal(report.report.summary.identicalCount, 1);
    assert.equal(report.report.summary.onlyInSourceCount, 1);
    assert.equal(report.report.summary.onlyInTargetCount, 1);
    assert.equal(report.report.coverage.consistent, true);
    assert.equal(report.report.coverage.canSynchronize, false);
    await admin.query('CREATE TABLE nontransactional LIKE src');
    await admin.query('ALTER TABLE nontransactional ENGINE=MyISAM');
    assert.equal((await run('src', 'nontransactional')).report.coverage.consistent, false);
    await admin.query('CREATE TABLE text_keys (id VARCHAR(50) PRIMARY KEY) ENGINE=InnoDB');
    assert.equal((await run('text_keys', 'text_keys')).error.code, 'DATA_DIFF_UNSUPPORTED_PK_TYPE');
    assert.equal((await admin.query('SELECT COUNT(*) AS n FROM src'))[0][0].n, 2);
    assert.equal((await admin.query('SELECT COUNT(*) AS n FROM dst'))[0][0].n, 2);
  } finally {
    await service.clear();
    try { if (created) await admin.query(`DROP DATABASE \`${database}\``); } finally { await admin.end(); }
  }
});
