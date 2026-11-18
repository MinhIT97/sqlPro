'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { RestorePlanService } = require('../electron/restore-plan-service.cjs');
const { computeSchemaFingerprint } = require('../electron/schema-snapshot.cjs');

function makeTempSql(content) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-restore-plan-'));
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

CREATE TABLE \`users\` (
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`name\` varchar(100) DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB;

INSERT INTO \`users\` VALUES (1,'Alice'),(2,'Bob');

CREATE TABLE \`orders\` (
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`user_id\` int NOT NULL,
  \`amount\` decimal(10,2) DEFAULT '0.00',
  PRIMARY KEY (\`id\`),
  CONSTRAINT \`fk_user\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`)
) ENGINE=InnoDB;

INSERT INTO \`orders\` VALUES (101,1,99.50),(102,2,150.00);

CREATE TABLE \`logs\` (
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`message\` text,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB;

INSERT INTO \`logs\` VALUES (1,'System started');
`;

test('RestorePlanService: creates selective restore plan with authoritative facts and one-time token', async () => {
  const { filePath, cleanup } = makeTempSql(sampleDumpSql);

  try {
    const profile = { id: 'prof_test', name: 'Test Server', engine: 'MySQL', readOnly: false };
    const store = { getWithSecrets: () => profile };

    let factsCollected = false;
    const fakeSession = {
      async connect() {},
      async close() {},
      async collectRestoreTargetFacts(db) {
        factsCollected = true;
        return {
          database: db,
          objects: [{ name: 'users', type: 'table' }],
          errors: []
        };
      }
    };

    const service = new RestorePlanService({
      store,
      createSession: () => fakeSession,
      fingerprintProfile: p => computeSchemaFingerprint({ id: p.id })
    });

    // Select only 'orders' and 'users' (orders depends on users, both selected)
    const planResult = await service.createSelectiveRestorePlan({
      filePath,
      targetProfileId: 'prof_test',
      targetDatabase: 'target_db',
      selection: {
        tables: ['orders', 'users'],
        includeStructure: true,
        includeData: true
      },
      dropExisting: false
    });

    assert.ok(factsCollected, 'Target facts must be collected at Main');
    assert.equal(planResult.status, 'ready');
    assert.equal(planResult.canExecute, true);
    assert.equal(planResult.applySupported, true);
    assert.ok(planResult.planToken);
    assert.ok(planResult.planId);
    assert.equal(planResult.sourceDatabase, 'target_db');
    assert.deepEqual(planResult.blockers, []);

    // One-time consumption contract
    const consumed = service.consumePlan(planResult.planToken);
    assert.equal(consumed.planId, planResult.planId);
    assert.equal(consumed.targetScope.profileId, 'prof_test');

    // Replay attempt must fail
    assert.throws(
      () => service.consumePlan(planResult.planToken),
      { code: 'RESTORE_PLAN_NOT_FOUND' }
    );
  } finally {
    cleanup();
  }
});

test('RestorePlanService: missing foreign key dependency blocks plan execution', async () => {
  const { filePath, cleanup } = makeTempSql(sampleDumpSql);

  try {
    const profile = { id: 'prof_test', name: 'Test Server', engine: 'MySQL', readOnly: false };
    const store = { getWithSecrets: () => profile };

    // Target DB does NOT have users table, and user only selects orders
    const fakeSession = {
      async connect() {},
      async close() {},
      async collectRestoreTargetFacts(db) {
        return { database: db, objects: [], errors: [] };
      }
    };

    const service = new RestorePlanService({
      store,
      createSession: () => fakeSession,
      fingerprintProfile: p => computeSchemaFingerprint({ id: p.id })
    });

    // Select ONLY 'orders' (missing 'users' table dependency)
    const planResult = await service.createSelectiveRestorePlan({
      filePath,
      targetProfileId: 'prof_test',
      targetDatabase: 'target_db',
      selection: {
        tables: ['orders'],
        includeStructure: true,
        includeData: true
      }
    });

    assert.equal(planResult.status, 'blocked');
    assert.equal(planResult.canExecute, false);
    assert.equal(planResult.applySupported, false);
    assert.ok(planResult.blockers.some(b => b.code === 'MISSING_DEPENDENCY' && b.requiredDependency === 'users'));
  } finally {
    cleanup();
  }
});

test('RestorePlanService: plan expires after TTL', async () => {
  const { filePath, cleanup } = makeTempSql(sampleDumpSql);

  try {
    const profile = { id: 'prof_test', name: 'Test Server', engine: 'MySQL', readOnly: false };
    const store = { getWithSecrets: () => profile };
    const service = new RestorePlanService({
      store,
      planTtlMs: 10, // 10 ms TTL
      createSession: () => ({ async close() {}, async collectRestoreTargetFacts() { return { objects: [] }; } }),
      fingerprintProfile: p => computeSchemaFingerprint({ id: p.id })
    });

    const planResult = await service.createSelectiveRestorePlan({
      filePath,
      targetProfileId: 'prof_test',
      targetDatabase: 'target_db',
      selection: { tables: ['logs'] }
    });

    await new Promise(r => setTimeout(r, 20));

    assert.throws(
      () => service.consumePlan(planResult.planToken),
      { code: 'RESTORE_PLAN_EXPIRED' }
    );
  } finally {
    cleanup();
  }
});

test('RestorePlanService: rejects non-existent file or missing store', async () => {
  const service = new RestorePlanService();
  await assert.rejects(
    service.createSelectiveRestorePlan({ filePath: '/non/existent/dump.sql', targetProfileId: 'p1', targetDatabase: 'db' }),
    { code: 'RESTORE_FILE_NOT_FOUND' }
  );
});
