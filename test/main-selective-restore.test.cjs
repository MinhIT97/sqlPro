'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { RestorePlanService } = require('../electron/restore-plan-service.cjs');
const { RestoreSelectionExecutor } = require('../electron/restore-selection-executor.cjs');
const { computeSchemaFingerprint } = require('../electron/schema-snapshot.cjs');

function makeTempSql(content) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-main-restore-'));
  const filePath = path.join(tmpDir, 'backup.sql');
  fs.writeFileSync(filePath, content, 'utf8');
  return {
    filePath,
    cleanup: () => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  };
}

const dumpSql = `
USE target_db;
CREATE TABLE \`selected_table\` (\`id\` INT PRIMARY KEY, \`val\` VARCHAR(50));
INSERT INTO \`selected_table\` VALUES (1, 'val1');

CREATE TABLE \`unselected_table\` (\`id\` INT PRIMARY KEY, \`secret\` VARCHAR(50));
INSERT INTO \`unselected_table\` VALUES (99, 'SUPER_SECRET');
`;

test('Main Selective Restore: end-to-end plan creation, token handshake, and isolated selective execution', async () => {
  const { filePath, cleanup } = makeTempSql(dumpSql);

  try {
    const executedQueries = [];
    let workerClosed = false;

    const fakeWorker = {
      async connect() {},
      async useDatabase() {},
      async close() { workerClosed = true; },
      async raw(sql) {
        executedQueries.push(sql);
        if (sql.includes('SELECT @@SESSION.foreign_key_checks')) {
          return { rows: [{ foreignKeys: 1, sqlMode: '', autocommit: 1 }] };
        }
        return { result: [], rows: [] };
      },
      async collectRestoreTargetFacts(db) {
        return { database: db, objects: [], errors: [] };
      }
    };

    const targetProfile = {
      id: 'prof_main_test',
      name: 'Main Target',
      engine: 'MySQL',
      readOnly: false,
      environment: 'local'
    };

    const store = {
      getWithSecrets: (id) => (id === 'prof_main_test' ? targetProfile : null)
    };

    const service = new RestorePlanService({
      store,
      createSession: () => fakeWorker,
      fingerprintProfile: (p) => computeSchemaFingerprint({ id: p.id })
    });

    const executor = new RestoreSelectionExecutor({
      consumePlan: (token) => service.consumePlan(token),
      getProfileWithSecrets: (id) => store.getWithSecrets(id),
      fingerprintProfile: (p) => computeSchemaFingerprint({ id: p.id }),
      createSession: () => fakeWorker
    });

    // 1. Create selective restore plan (selecting ONLY 'selected_table')
    const planProjection = await service.createSelectiveRestorePlan({
      filePath,
      targetProfileId: 'prof_main_test',
      targetDatabase: 'target_db',
      selection: {
        tables: ['selected_table'],
        includeStructure: true,
        includeData: true
      },
      dropExisting: false
    });

    assert.equal(planProjection.status, 'ready');
    assert.equal(planProjection.canExecute, true);
    assert.equal(planProjection.applySupported, true);
    assert.ok(planProjection.planToken);

    // 2. Execute selective restore plan via executor
    const execResult = await executor.executePlan({
      planToken: planProjection.planToken
    });

    assert.equal(execResult.success, true);
    assert.equal(execResult.executedCount, 2); // 1 CREATE + 1 INSERT
    assert.equal(execResult.targetChanged, true);

    // 3. Verify executed queries:
    assert.ok(executedQueries.some(q => q.includes('CREATE TABLE `selected_table`')));
    assert.ok(executedQueries.some(q => q.includes("INSERT INTO `selected_table` VALUES (1, 'val1')")));

    // 4. PROOF OF ISOLATION: Unselected table statements MUST NEVER have been executed!
    assert.ok(!executedQueries.some(q => q.includes('unselected_table')), 'Unselected table must not be created or populated');
    assert.ok(!executedQueries.some(q => q.includes('SUPER_SECRET')), 'Unselected secret data must never touch target');

    assert.equal(workerClosed, true);

    // 5. Token cannot be reused (replay prevention)
    await assert.rejects(
      executor.executePlan({ planToken: planProjection.planToken }),
      { code: 'RESTORE_PLAN_NOT_FOUND' }
    );
  } finally {
    cleanup();
  }
});
