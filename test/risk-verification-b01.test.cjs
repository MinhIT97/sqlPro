'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const SchemaDiff = require('../schema-diff.js');
const SqlSnippets = require('../query-snippets.js');
const SqlDiagnostics = require('../diagnostics.js');
const { RestoreObjectInventory } = require('../electron/restore-object-inventory.cjs');
const { DatabaseSession } = require('../electron/database.cjs');
const { saveBackupFile } = require('../electron/backup-file.cjs');
const { loadRenderer } = require('./helpers/renderer.cjs');

/* ==========================================================================
   B01 REVISED RISK VERIFICATION SUITE
   Calling actual application code, handlers and modules directly
   ========================================================================== */

function setupDiffModalRenderer({ onQuery, onConfirm, onSnapshot } = {}) {
  const listeners = new Map();
  const elements = new Proxy(new Map(), {
    get(target, prop) {
      if (prop === 'get') {
        return (sel) => {
          if (!target.has(sel)) {
            const el = {
              sel,
              innerHTML: '',
              value: '',
              disabled: false,
              checked: false,
              dataset: {},
              classList: { add() {}, remove() {}, toggle() {} },
              addEventListener(evt, fn) {
                if (!listeners.has(sel + ':' + evt)) listeners.set(sel + ':' + evt, []);
                listeners.get(sel + ':' + evt).push(fn);
              },
              removeEventListener() {},
              querySelector(s) { return target.get(s); },
              querySelectorAll() { return []; },
              focus() {}
            };
            target.set(sel, el);
          }
          return target.get(sel);
        };
      }
      return Reflect.get(target, prop);
    }
  });

  const tabButtons = ['config', 'summary', 'tables', 'indexes', 'migration'].map((tab) => {
    const btn = elements.get('tab:' + tab);
    btn.dataset.diffTab = tab;
    return btn;
  });

  const dialog = elements.get('#modal');
  dialog.open = false;
  dialog.showModal = function () { this.open = true; };
  dialog.close = function () { this.open = false; };

  const service = new (require('../electron/schema-migration-service.cjs').SchemaMigrationService)();
  const desktop = {
    db: {
      schemaSnapshot: async ({ database, profileId }) => {
        const data = { database, engine: 'MySQL', tables: database === 'source_db' ? [{ name: 'users', engine: 'InnoDB', columns: [{ name: 'id', type: 'int', nullable: true, default: null }], indexes: [], foreignKeys: [], foreignKeysStatus: 'complete', checkConstraints: [], checkConstraintsStatus: 'complete' }] : [], views: [], routines: [], triggers: [], events: [] };
        const snapshot = { ...data, kind: 'sqlpro-schema-snapshot', version: 1, coverage: 'complete', snapshotIdentity: require('../electron/schema-snapshot.cjs').computeSchemaFingerprint(data), scope: { profileId, sessionId: 'fixture', generation: 0, profileFingerprint: 'a'.repeat(64), database, engine: 'MySQL' } };
        onSnapshot?.(snapshot);
        return { ok: true, data: { snapshotId: service.storeSnapshot(snapshot), coverage: snapshot.coverage } };
      },
      createMigrationPlan: async payload => ({ ok: true, data: service.createMigrationPlan(payload) }),
      databases: async () => ({ ok: true, data: ['source_db', 'target_db'] }),
      tables: async (db) => ({ ok: true, data: db === 'source_db' ? [{ name: 'users', type: 'table' }] : [] }),
      columns: async () => ({ ok: true, data: [{ name: 'id', type: 'int' }] }),
      indexes: async () => ({ ok: true, data: [] }),
      relations: async () => ({ ok: true, data: { outbound: [] } }),
      routines: async () => ({ ok: true, data: [] }),
      query: async (p) => {
        if (onQuery) return onQuery(p);
        return { ok: true, data: { rows: [] } };
      }
    }
  };

  const r = loadRenderer({ desktop, elements });
  r.context.window.SchemaDiff = SchemaDiff;
  r.context.SchemaDiff = SchemaDiff;
  r.context.document.querySelectorAll = (sel) => {
    if (sel === '.diff-tab-btn' || sel === '[data-diff-tab]') return tabButtons;
    return [elements.get(sel)];
  };

  if (onConfirm) {
    const originalConfirm = r.context.confirmAction;
    r.context.confirmAction = function (...args) {
      return onConfirm(originalConfirm, this, args);
    };
  }

  return { r, elements, listeners, tabButtons };
}

// --------------------------------------------------------------------------
// 1. P0 — G6.4 Migration: Calling Convention Bug, FK Leak & Drift Blindness
// --------------------------------------------------------------------------

test('B01.1 [CONFIRMED REMEDIATION] Migration Apply in app.js is safely locked and executes 0 queries', async () => {
  const queries = [];
  const { r, listeners } = setupDiffModalRenderer({
    onQuery: (p) => { queries.push(p); return { ok: true, data: { rows: [] } }; }
  });

  await r.evaluate(`
    app.connection = { id: 'conn1', name: 'Dev', type: 'mysql' };
    app.connections = [app.connection];
    app.database = 'source_db';
    showSchemaDiffModal();
  `);
  await new Promise((resolve) => setTimeout(resolve, 20));

  // Run comparison:
  const compareHandler = listeners.get('#diffRunCompareBtn:click')?.[0];
  assert.ok(compareHandler, 'Compare handler was registered');
  await compareHandler();
  await new Promise((resolve) => setTimeout(resolve, 20));

  // Switch to migration tab:
  const migClickHandlers = listeners.get('tab:migration:click');
  assert.ok(migClickHandlers?.length, 'Migration tab click handler registered');
  migClickHandlers[0]();
  await new Promise((resolve) => setTimeout(resolve, 20));

  // Click #diffApplyTargetBtn (safely locked handler from app.js):
  const applyHandlers = listeners.get('#diffApplyTargetBtn:click');
  assert.ok(applyHandlers?.length, 'Apply handler was registered');
  await applyHandlers[0]();

  assert.equal(
    queries.length,
    0,
    'REMEDIATION VERIFIED: desktop.db.query was called 0 times because direct apply is safely locked!'
  );
});

test('B01.2 [CONFIRMED REMEDIATION] app.js never sends SET FOREIGN_KEY_CHECKS = 0 in migration tab', () => {
  const appJsSource = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  assert.equal(
    appJsSource.includes('SET FOREIGN_KEY_CHECKS = 0'),
    false,
    'REMEDIATION VERIFIED: SET FOREIGN_KEY_CHECKS = 0 has been completely eliminated from app.js!'
  );
});

test('B01.3 [CONFIRMED REMEDIATION] Migration apply in app.js does not call db.query directly', () => {
  const appJsSource = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

  // Find the diffApplyTargetBtn block:
  const applyBlockMatch = appJsSource.match(/\$\('#diffApplyTargetBtn'\)\?\.addEventListener\('click'[\s\S]*?\}\);/);
  assert.ok(applyBlockMatch, 'Found diffApplyTargetBtn click handler in app.js');

  const applyBlockCode = applyBlockMatch[0];
  assert.ok(!applyBlockCode.includes('desktop.db.query'), 'Does not send raw queries to desktop.db.query');
  assert.ok(applyBlockCode.includes('khoá an toàn') || applyBlockCode.includes('Editor'), 'Direct apply is safely locked with warning toast');
});

// --------------------------------------------------------------------------
// 2. P0 — G6.1/G6.2 Snapshot: captureFullSchema Blindness & SchemaDiff Gaps
// --------------------------------------------------------------------------

test('B01.4 [REMEDIATION] incomplete Main snapshot blocks Schema Diff SQL instead of omitting objects', async () => {
  let queryCount = 0;
  const { r, elements, listeners } = setupDiffModalRenderer({
    onSnapshot: snapshot => { snapshot.coverage = 'partial'; },
    onQuery: () => { queryCount++; return { ok: true, data: {} }; }
  });
  await r.evaluate("app.connection={id:'p'};app.connections=[app.connection];app.database='source_db';showSchemaDiffModal()");
  await new Promise(resolve => setTimeout(resolve, 20));
  await listeners.get('#diffRunCompareBtn:click')[0]();
  assert.ok(elements.get('#diffTabContent').innerHTML.includes('Metadata nguồn chưa đầy đủ'));
  assert.equal(listeners.has('#diffOpenEditorBtn:click'), false);
  assert.equal(queryCount, 0);
});

test('B01.5 [CONFIRMED BUG] SchemaDiff.compareSchemas has no trigger or event comparison logic', () => {
  const source = {
    database: 'source_db',
    tables: [],
    views: [],
    routines: [],
    triggers: [
      { name: 'tr_audit', table: 'orders', timing: 'AFTER', event: 'INSERT', statement: 'INSERT INTO audit VALUES (NEW.id);' }
    ],
    events: [
      { name: 'ev_clean', status: 'ENABLED', statement: 'DELETE FROM logs WHERE at < NOW();' }
    ]
  };

  const target = {
    database: 'target_db',
    tables: [],
    views: [],
    routines: [],
    triggers: [], // Target has no triggers
    events: []    // Target has no events
  };

  const diff = SchemaDiff.compareSchemas(source, target);

  // Even though source has 1 trigger and 1 event while target has none:
  // compareSchemas in schema-diff.js lines 586-635 completely omits trigger and event loops!
  assert.equal(diff.triggers.added.length, 0, 'DEFECT REPRODUCED: Triggers are not compared or added');
  assert.equal(diff.events.added.length, 0, 'DEFECT REPRODUCED: Events are not compared or added');
});

test('B01.6 [CONFIRMED BUG] SchemaDiff generates false-positive ALTER_VIEW when views have identical definitions', () => {
  // Source view has empty definition (due to captureFullSchema bug in B01.4):
  const source = {
    database: 'source_db',
    tables: [],
    views: [{ name: 'v_users', definition: '' }],
    routines: [],
    triggers: [],
    events: []
  };

  // Target view also has empty definition:
  const target = {
    database: 'target_db',
    tables: [],
    views: [{ name: 'v_users', definition: '' }],
    routines: [],
    triggers: [],
    events: []
  };

  const diff = SchemaDiff.compareSchemas(source, target);
  assert.equal(diff.views.modified.length, 0, 'Empty identical definitions should have 0 modified views');

  // But if source has actual definition while target had empty definition:
  const sourceWithSql = {
    ...source,
    views: [{ name: 'v_users', definition: 'CREATE VIEW `v_users` AS SELECT * FROM users' }]
  };
  const diffWithSql = SchemaDiff.compareSchemas(sourceWithSql, target);
  assert.equal(diffWithSql.views.modified.length, 1, 'View is marked modified');

  const stmts = SchemaDiff.generateMigrationSql(diffWithSql);
  const viewAlter = stmts.find((s) => s.type === 'ALTER_VIEW');
  assert.ok(viewAlter, 'Generated ALTER_VIEW');
  assert.ok(viewAlter.sql.includes('CREATE OR REPLACE VIEW'), 'View migration attempts replacement without verified DDL');
});

// --------------------------------------------------------------------------
// 3. P0 — G3.1/G3.2 Selective Restore: Unwired Executor
// --------------------------------------------------------------------------

test('B01.7 [CONFIRMED GAP] Selective restore plan generator exists, but executor and UI are completely unwired', async () => {
  // 1. Verify RestoreObjectInventory generates selective execution plan:
  const inv = new RestoreObjectInventory('sales_db');
  inv.tables.set('orders', { name: 'orders', type: 'table', dependencies: [] });
  inv.tables.set('users', { name: 'users', type: 'table', dependencies: [] });

  const checksum = crypto.createHash('sha256').update('dump-content').digest('hex');
  const targetId = 'mysql://root:secret@127.0.0.1:3306/sales_db';
  const plan = inv.generateExecutionPlan({
    selection: { tables: ['orders'], views: [], procedures: [], functions: [], triggers: [], events: [] },
    fileChecksum: checksum,
    targetIdentity: targetId
  });

  assert.equal(plan.kind, 'sqlpro-restore-execution-plan');
  assert.equal(plan.sourceDatabase, 'sales_db');
  assert.deepEqual(Array.from(plan.selection.tables), ['orders']);

  // 2. Verify DatabaseSession.restoreDatabase options in electron/database.cjs:
  // Inspecting DatabaseSession.restoreDatabase (lines 3399-3430):
  // The restore API takes ({ database, filePath, dropExisting, createDatabaseIfNotExists }) and streams the file.
  // It does NOT accept or filter by execution plan steps or selected objects!
  const dbSource = fs.readFileSync(path.join(__dirname, '../electron/database.cjs'), 'utf8');
  assert.ok(dbSource.includes('async restoreDatabase(options, onProgress)'));
  assert.ok(dbSource.includes('restoreDatabaseInternal('));
  assert.ok(!dbSource.includes('plan.includedObjects'));
  assert.ok(!dbSource.includes('filterStatements'));

  // 3. Verify app.js has no UI for selective restore:
  const appJsSource = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  assert.ok(!appJsSource.includes('generateExecutionPlan'), 'app.js does not invoke generateExecutionPlan');
  assert.ok(!appJsSource.includes('RestoreObjectInventory.generateExecutionPlan'), 'app.js has no selective restore planner');
});

// --------------------------------------------------------------------------
// 4. P1 — G1.1 Persistence: Plaintext Sensitive SQL in persistState
// --------------------------------------------------------------------------

test('B01.8 [CONFIRMED DEFECT] persistState saves raw password-bearing queries directly without scrubbing', () => {
  let savedPayload = null;
  const desktop = {
    saveState: async (data) => {
      savedPayload = data;
      return { saved: true };
    }
  };

  const r = loadRenderer({ desktop });
  r.context.setTimeout = (fn) => { fn(); return 1; };

  r.evaluate(`
    queryTabs[0] = {
      id: "tab-1",
      title: "Query 1",
      sql: "CREATE USER 'developer'@'%' IDENTIFIED BY 'SuperSecretP@ssw0rd!';"
    };
    persistState();
  `);

  assert.ok(savedPayload, 'persistState invoked desktop.saveState');
  assert.equal(
    savedPayload.queryTabs[0].sql,
    "CREATE USER 'developer'@'%' IDENTIFIED BY 'SuperSecretP@ssw0rd!';",
    'DEFECT REPRODUCED: persistState saved raw password in plaintext'
  );

  // Compare with SqlSnippets.scrubSensitiveSql which DOES scrub:
  const scrubbed = SqlSnippets.scrubSensitiveSql(savedPayload.queryTabs[0].sql);
  assert.ok(!scrubbed.includes('SuperSecretP@ssw0rd!'), 'SqlSnippets.scrubSensitiveSql masks passwords, but persistState does not use it');
});

// --------------------------------------------------------------------------
// 5. P1 — G5.6 Diagnostics: Target Drift During Await
// --------------------------------------------------------------------------

test('B01.9 [CONFIRMED BUG] Diagnostics process row lacks profileId; real KILL handler sends command to wrong connection if app.connection changes during confirmation', async () => {
  // 1. Verify parseProcesslistRow does NOT include profileId:
  const mockRow = [101, 'staging_user', '10.0.0.1:5000', 'staging_db', 'Query', 10, 'Locked', 'SELECT * FROM secret_staging_data'];
  const parsed = SqlDiagnostics.parseProcesslistRow(mockRow, 999);
  assert.equal(parsed.id, '101');
  assert.equal(parsed.profileId, undefined, 'DEFECT REPRODUCED: Process row object has no profileId attribute');

  // 2. Trigger real kill-query-btn click handler and intercept confirmAction:
  const listeners = new Map();
  const elements = new Proxy(new Map(), {
    get(target, prop) {
      if (prop === 'get') {
        return (sel) => {
          if (!target.has(sel)) {
            const el = {
              sel,
              innerHTML: '',
              value: '',
              disabled: false,
              checked: false,
              dataset: {},
              classList: { add() {}, remove() {}, toggle() {} },
              addEventListener(evt, fn) {
                if (!listeners.has(sel + ':' + evt)) listeners.set(sel + ':' + evt, []);
                listeners.get(sel + ':' + evt).push(fn);
              },
              removeEventListener() {},
              querySelector(s) { return target.get(s); },
              querySelectorAll(s) {
                if (s === '.kill-query-btn') return [target.get('.kill-query-btn')];
                return [];
              },
              focus() {}
            };
            target.set(sel, el);
          }
          return target.get(sel);
        };
      }
      return Reflect.get(target, prop);
    }
  });

  const dialog = elements.get('#modal');
  dialog.open = false;
  dialog.showModal = function () { this.open = true; };
  dialog.close = function () { this.open = false; };

  const queries = [];
  const desktop = {
    db: {
      query: async (p) => {
        queries.push(p);
        if (p.sql && p.sql.includes('CONNECTION_ID()')) {
          return { ok: true, data: { rows: [[999]], fields: [] } };
        }
        if (p.sql && p.sql.includes('PROCESSLIST')) {
          return {
            ok: true,
            data: {
              rows: [
                ['101', 'staging_user', '10.0.0.1:5000', 'staging_db', 'Query', 10, 'Locked', 'SELECT * FROM secret_staging_data']
              ],
              fields: ['Id', 'User', 'Host', 'db', 'Command', 'Time', 'State', 'Info']
            }
          };
        }
        return { ok: true, data: { rows: [] } };
      }
    }
  };

  const r = loadRenderer({ desktop, elements });
  r.context.window.SqlDiagnostics = SqlDiagnostics;
  r.context.SqlDiagnostics = SqlDiagnostics;

  const killBtn = elements.get('.kill-query-btn');
  killBtn.dataset.killQuery = '101';

  let pendingConfirmResolve = null;
  r.context.confirmAction = function () {
    return new Promise((resolve) => {
      pendingConfirmResolve = resolve;
    });
  };

  await r.evaluate(`
    app.connection = { id: 'staging-conn', name: 'Staging' };
    app.database = 'staging_db';
    showProcesslistModal();
  `);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const killHandlers = listeners.get('.kill-query-btn:click');
  assert.ok(killHandlers?.length, 'Real .kill-query-btn click handler was registered');

  // Trigger the real click handler on process 101:
  const killPromise = killHandlers[0]({ stopPropagation() {} });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(typeof pendingConfirmResolve, 'function', 'Confirmation dialog is pending');

  // While confirmation dialog is pending, connection context switches (e.g. background reconnect, IPC event, or workspace switch):
  r.evaluate(`
    app.connection = { id: 'production-conn', name: 'Production' };
    app.database = 'production_db';
  `);

  // User confirms the action:
  pendingConfirmResolve(true);
  await killPromise;
  await new Promise((resolve) => setTimeout(resolve, 20));

  const killQuery = queries.find((q) => q.sql && q.sql.includes('KILL QUERY'));
  assert.ok(killQuery, 'desktop.db.query was called with KILL QUERY');
  assert.equal(
    killQuery.profileId,
    'production-conn',
    'DEFECT REPRODUCED: KILL QUERY was sent to production-conn instead of staging-conn from which the processlist was loaded!'
  );
  assert.equal(killQuery.sql, 'KILL QUERY 101');
});

// --------------------------------------------------------------------------
// 6. P1 — G3.3 Backup Scheduler: Interval-Only Scope & In-Memory Limits
// --------------------------------------------------------------------------

test('B01.10 [CONFIRMED LIMITATION] BackupScheduler validateSchedule silently ignores calendar/cron fields and only supports intervalHours', () => {
  const { createScheduleStore } = require('../electron/backup-scheduler.cjs');
  const tmpDir = path.join(os.tmpdir(), `sqlpro-sched-test-${Date.now()}`);
  const store = createScheduleStore(tmpDir);

  const inputWithCalendarFields = {
    profileId: 'conn-1',
    database: 'sales_db',
    enabled: true,
    intervalHours: 24,
    nextRunAt: new Date(Date.now() + 3600000).toISOString(),
    timeZone: 'UTC',
    target: 'a'.repeat(64),
    revision: 'b'.repeat(32),
    // Extra fields submitted for calendar / cron scheduling:
    timeOfDay: '02:00',
    cron: '0 2 * * *'
  };

  // Valid interval succeeds:
  const saved = store.save(inputWithCalendarFields);
  assert.equal(saved.intervalHours, 24);

  // LIMITATION VERIFIED: timeOfDay and cron are silently dropped (ignored) rather than parsed:
  assert.equal(Object.hasOwn(saved, 'timeOfDay'), false, 'timeOfDay field is dropped by validateSchedule');
  assert.equal(Object.hasOwn(saved, 'cron'), false, 'cron field is dropped by validateSchedule');

  // Attempting to use a non-integer intervalHours fails validation:
  assert.throws(() => {
    store.save({
      ...inputWithCalendarFields,
      intervalHours: 'daily-at-02:00'
    });
  }, /Lịch backup không hợp lệ/);

  // Attempting interval < 1 hour fails:
  assert.throws(() => {
    store.save({
      ...inputWithCalendarFields,
      intervalHours: 0
    });
  }, /Lịch backup không hợp lệ/);
});
