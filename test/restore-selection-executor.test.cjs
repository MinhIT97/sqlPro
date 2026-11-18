'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { RestoreSelectionExecutor } = require('../electron/restore-selection-executor.cjs');
const { computeSchemaFingerprint } = require('../electron/schema-snapshot.cjs');

function makeTempSql(content) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-restore-exec-'));
  const filePath = path.join(tmpDir, 'test-dump.sql');
  fs.writeFileSync(filePath, content, 'utf8');
  return {
    filePath,
    cleanup: () => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  };
}

const sampleDumpSql = `
-- MySQL dump 10.13
USE test_db;
SET NAMES utf8mb4;

CREATE TABLE \`users\` (
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`name\` varchar(100) DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB;

INSERT INTO \`users\` VALUES (1,'Alice'),(2,'Bob');

CREATE TABLE \`secret_tokens\` (
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`token\` varchar(255) NOT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB;

INSERT INTO \`secret_tokens\` VALUES (1,'SECRET_KEY_12345');

CREATE TABLE \`logs\` (
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`msg\` text,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB;

INSERT INTO \`logs\` VALUES (1,'Log line 1');
`;

test('RestoreSelectionExecutor: executes selected tables and proves unselected objects are completely untouched', async () => {
  const { filePath, cleanup } = makeTempSql(sampleDumpSql);

  try {
    const stat = fs.statSync(filePath);
    const profile = { id: 'prof_test', name: 'Test Target', engine: 'MySQL', readOnly: false, environment: 'local' };
    const queries = [];
    let workerClosed = false;

    const fakeWorker = {
      async connect() {},
      async useDatabase() {},
      async close() { workerClosed = true; },
      async raw(sql) {
        queries.push(sql);
        if (sql.includes('SELECT @@SESSION.foreign_key_checks')) {
          return { rows: [{ foreignKeys: 1, sqlMode: '', autocommit: 1 }] };
        }
        return { result: [], rows: [] };
      }
    };

    const plan = {
      planId: 'plan_sel_1',
      planToken: 't'.repeat(64),
      filePath,
      fileStats: { size: stat.size, mtimeMs: stat.mtimeMs },
      targetScope: {
        profileId: 'prof_test',
        database: 'target_db',
        engine: 'MySQL',
        profileFingerprint: computeSchemaFingerprint({ id: 'prof_test' })
      },
      selection: {
        tables: ['users'], // ONLY users is selected!
        includeStructure: true,
        includeData: true
      },
      dropExisting: false,
      status: 'ready',
      canExecute: true,
      applySupported: true,
      expiresAt: Date.now() + 60000
    };

    const executor = new RestoreSelectionExecutor({
      consumePlan: async () => plan,
      getProfileWithSecrets: () => profile,
      fingerprintProfile: p => computeSchemaFingerprint({ id: p.id }),
      createSession: () => fakeWorker
    });

    const result = await executor.executePlan({ planToken: plan.planToken });

    assert.equal(result.success, true);
    assert.equal(result.executedCount, 2); // 1 CREATE TABLE users + 1 INSERT INTO users
    assert.ok(result.skippedCount > 0);

    // Verify executed queries contain users statements:
    assert.ok(queries.some(q => q.includes('CREATE TABLE `users`')));
    assert.ok(queries.some(q => q.includes("INSERT INTO `users` VALUES (1,'Alice')")));

    // CRITICAL PROOF: verify secret_tokens and logs were NEVER executed!
    assert.ok(!queries.some(q => q.includes('secret_tokens')), 'Unselected table secret_tokens must never be executed');
    assert.ok(!queries.some(q => q.includes('SECRET_KEY_12345')), 'Unselected data must never be executed');
    assert.ok(!queries.some(q => q.includes('`logs`')), 'Unselected table logs must never be executed');

    assert.equal(workerClosed, true);
  } finally {
    cleanup();
  }
});

test('RestoreSelectionExecutor: structure-only selection skips data statements', async () => {
  const { filePath, cleanup } = makeTempSql(sampleDumpSql);

  try {
    const stat = fs.statSync(filePath);
    const profile = { id: 'prof_test', name: 'Test Target', engine: 'MySQL', readOnly: false, environment: 'local' };
    const queries = [];

    const fakeWorker = {
      async connect() {},
      async useDatabase() {},
      async close() {},
      async raw(sql) {
        queries.push(sql);
        if (sql.includes('SELECT @@SESSION.foreign_key_checks')) {
          return { rows: [{ foreignKeys: 1, sqlMode: '', autocommit: 1 }] };
        }
        return { result: [], rows: [] };
      }
    };

    const plan = {
      planId: 'plan_struct_only',
      planToken: 's'.repeat(64),
      filePath,
      fileStats: { size: stat.size, mtimeMs: stat.mtimeMs },
      targetScope: {
        profileId: 'prof_test',
        database: 'target_db',
        engine: 'MySQL',
        profileFingerprint: computeSchemaFingerprint({ id: 'prof_test' })
      },
      selection: {
        tables: ['users'],
        includeStructure: true,
        includeData: false // DATA EXCLUDED
      },
      dropExisting: false,
      status: 'ready',
      canExecute: true,
      applySupported: true,
      expiresAt: Date.now() + 60000
    };

    const executor = new RestoreSelectionExecutor({
      consumePlan: async () => plan,
      getProfileWithSecrets: () => profile,
      fingerprintProfile: p => computeSchemaFingerprint({ id: p.id }),
      createSession: () => fakeWorker
    });

    const result = await executor.executePlan({ planToken: plan.planToken });

    assert.equal(result.success, true);
    assert.equal(result.executedCount, 1); // Only CREATE TABLE users, NOT INSERT
    assert.ok(queries.some(q => q.includes('CREATE TABLE `users`')));
    assert.ok(!queries.some(q => q.includes('INSERT INTO `users`')));
  } finally {
    cleanup();
  }
});

test('RestoreSelectionExecutor: rejects when backup file is modified before restore', async () => {
  const { filePath, cleanup } = makeTempSql(sampleDumpSql);

  try {
    const stat = fs.statSync(filePath);
    const profile = { id: 'prof_test', name: 'Test Target', engine: 'MySQL', readOnly: false, environment: 'local' };

    const plan = {
      planId: 'plan_tampered',
      planToken: 't'.repeat(64),
      filePath,
      fileStats: { size: stat.size + 100, mtimeMs: stat.mtimeMs }, // Mismatched size!
      targetScope: {
        profileId: 'prof_test',
        database: 'target_db',
        engine: 'MySQL',
        profileFingerprint: computeSchemaFingerprint({ id: 'prof_test' })
      },
      selection: { tables: ['users'] },
      status: 'ready',
      canExecute: true,
      applySupported: true,
      expiresAt: Date.now() + 60000
    };

    const executor = new RestoreSelectionExecutor({
      consumePlan: async () => plan,
      getProfileWithSecrets: () => profile,
      fingerprintProfile: p => computeSchemaFingerprint({ id: p.id })
    });

    await assert.rejects(
      executor.executePlan({ planToken: plan.planToken }),
      { code: 'RESTORE_FILE_CHANGED' }
    );
  } finally {
    cleanup();
  }
});

test('RestoreSelectionExecutor: read-only target profile is rejected with CONNECTION_READ_ONLY', async () => {
  const { filePath, cleanup } = makeTempSql(sampleDumpSql);

  try {
    const stat = fs.statSync(filePath);
    const readOnlyProfile = { id: 'prof_ro', name: 'RO Target', engine: 'MySQL', readOnly: true };

    const plan = {
      planId: 'plan_ro',
      planToken: 'r'.repeat(64),
      filePath,
      fileStats: { size: stat.size, mtimeMs: stat.mtimeMs },
      targetScope: {
        profileId: 'prof_ro',
        database: 'target_db',
        engine: 'MySQL',
        profileFingerprint: computeSchemaFingerprint({ id: 'prof_ro' })
      },
      selection: { tables: ['users'] },
      status: 'ready',
      canExecute: true,
      applySupported: true,
      expiresAt: Date.now() + 60000
    };

    const executor = new RestoreSelectionExecutor({
      consumePlan: async () => plan,
      getProfileWithSecrets: () => readOnlyProfile,
      fingerprintProfile: p => computeSchemaFingerprint({ id: p.id })
    });

    await assert.rejects(
      executor.executePlan({ planToken: plan.planToken }),
      { code: 'CONNECTION_READ_ONLY' }
    );
  } finally {
    cleanup();
  }
});

test('RestoreSelectionExecutor: production target requires approvalToken', async () => {
  const { filePath, cleanup } = makeTempSql(sampleDumpSql);

  try {
    const stat = fs.statSync(filePath);
    const prodProfile = { id: 'prof_prod', name: 'Prod Target', engine: 'MySQL', readOnly: false, environment: 'production' };

    const plan = {
      planId: 'plan_prod',
      planToken: 'p'.repeat(64),
      filePath,
      fileStats: { size: stat.size, mtimeMs: stat.mtimeMs },
      targetScope: {
        profileId: 'prof_prod',
        database: 'target_db',
        engine: 'MySQL',
        profileFingerprint: computeSchemaFingerprint({ id: 'prof_prod' })
      },
      selection: { tables: ['users'] },
      status: 'ready',
      canExecute: true,
      applySupported: true,
      expiresAt: Date.now() + 60000
    };

    const executor = new RestoreSelectionExecutor({
      consumePlan: async () => plan,
      getProfileWithSecrets: () => prodProfile,
      fingerprintProfile: p => computeSchemaFingerprint({ id: p.id })
    });

    await assert.rejects(
      executor.executePlan({ planToken: plan.planToken }),
      { code: 'PRODUCTION_APPROVAL_REQUIRED' }
    );
  } finally {
    cleanup();
  }
});
