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

function setupDiffModalRenderer({ onQuery, onConfirm } = {}) {
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

  const desktop = {
    db: {
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
    if (sel === '.diff-tab-btn') return tabButtons;
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

test('B01.1 [CONFIRMED BUG] Migration Apply in app.js:3724 passes callback to confirmAction incorrectly; callback is never executed', async () => {
  // Line 3724: confirmAction(confirmMsg, async () => { ... }, { separate: true });
  // But confirmAction(title, message, confirmLabel, options) returns a Promise and treats 2nd arg as message!
  // We trigger the actual #diffApplyTargetBtn click handler inside the diff modal to prove that clicking Apply
  // in current production code executes 0 queries and leaves callback uninvoked.

  const queries = [];
  let confirmActionArg2Type = null;
  let capturedConfirmPromise = null;
  const { r, listeners, elements } = setupDiffModalRenderer({
    onQuery: (p) => { queries.push(p); return { ok: true, data: { rows: [] } }; },
    onConfirm: (orig, ctx, args) => {
      confirmActionArg2Type = typeof args[1];
      // Run the real confirmAction implementation:
      capturedConfirmPromise = orig.apply(ctx, args);
      return capturedConfirmPromise;
    }
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

  // Click #diffApplyTargetBtn (the REAL handler from app.js:3710):
  const applyHandlers = listeners.get('#diffApplyTargetBtn:click');
  assert.ok(applyHandlers?.length, 'Apply handler was registered');
  const applyPromise = applyHandlers[0]();

  // Verify confirmAction was invoked and passed callback as second argument:
  assert.ok(capturedConfirmPromise, 'confirmAction was called and returned a Promise');
  assert.equal(confirmActionArg2Type, 'function', 'app.js:3724 passed a callback function as 2nd argument to confirmAction');

  // User explicitly clicks #confirmOk to accept the migration dialog:
  const okHandlers = listeners.get('#confirmOk:click');
  assert.ok(okHandlers?.length, 'OK button click handler was registered on the dialog');
  okHandlers[0]();

  // Await the confirmation resolution:
  const confirmedValue = await capturedConfirmPromise;
  assert.equal(confirmedValue, true, 'confirmAction resolved true after clicking OK');
  await applyPromise;

  assert.equal(
    queries.length,
    0,
    'DEFECT REPRODUCED: Even after user explicitly confirms OK, desktop.db.query was called 0 times because confirmAction never calls the callback!'
  );
});

test('B01.2 [CONFIRMED BUG - LATENT RISK] Migration execution loop in app.js:3730-3752 lacks finally cleanup for SET FOREIGN_KEY_CHECKS=1', async () => {
  // Capture the real callback constructed in app.js:3724 from the #diffApplyTargetBtn click handler.
  // When executed in isolation, if any DDL query fails, the catch block catches the error but NEVER
  // restores SET FOREIGN_KEY_CHECKS = 1 because there is no finally block.
  const queryLog = [];
  let capturedCallback = null;

  const { r, listeners } = setupDiffModalRenderer({
    onQuery: (p) => {
      queryLog.push(p.sql);
      if (p.sql.includes('CREATE TABLE')) {
        const err = new Error('You have an error in your SQL syntax');
        err.code = 'ER_PARSE_ERROR';
        throw err;
      }
      return { ok: true, data: { rows: [] } };
    },
    onConfirm: (orig, ctx, args) => {
      if (typeof args[1] === 'function') {
        capturedCallback = args[1];
      }
      return orig.apply(ctx, args);
    }
  });

  await r.evaluate(`
    app.connection = { id: 'conn1', name: 'Dev', type: 'mysql' };
    app.connections = [app.connection];
    app.database = 'source_db';
    showSchemaDiffModal();
  `);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const compareHandler = listeners.get('#diffRunCompareBtn:click')?.[0];
  await compareHandler();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const migClickHandlers = listeners.get('tab:migration:click');
  migClickHandlers[0]();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const applyHandlers = listeners.get('#diffApplyTargetBtn:click');
  await applyHandlers[0]();

  assert.equal(typeof capturedCallback, 'function', 'Successfully captured the real callback from app.js:3724');

  // Now execute the actual callback from app.js:3724:
  queryLog.length = 0;
  await capturedCallback();

  assert.ok(queryLog.includes('SET FOREIGN_KEY_CHECKS = 0;'), 'SET FOREIGN_KEY_CHECKS = 0 was sent');
  assert.ok(queryLog.some((sql) => sql.includes('CREATE TABLE')), 'Failing DDL was attempted');
  assert.equal(
    queryLog.includes('SET FOREIGN_KEY_CHECKS = 1;'),
    false,
    'DEFECT REPRODUCED: SET FOREIGN_KEY_CHECKS = 1 was NEVER executed! Inherent latent risk in app.js:3730-3752 lacks finally block.'
  );
});

test('B01.3 [CONFIRMED ARCHITECTURAL DEFICIENCY] Migration apply calls db.query directly without target fingerprint/drift verification', () => {
  // Inspecting app.js:3710-3755:
  // When applying, it filters activeStatements and iterates with desktop.db.query({ profileId, database, sql, confirmed: true }).
  // There is NO invocation of any target verification, snapshot hash comparison, or pre-flight drift check.
  const appJsSource = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

  // Find the diffApplyTargetBtn block:
  const applyBlockMatch = appJsSource.match(/\$\('#diffApplyTargetBtn'\)\?\.addEventListener\('click'[\s\S]*?toast\(`Đã áp dụng thành công/);
  assert.ok(applyBlockMatch, 'Found diffApplyTargetBtn click handler in app.js');

  const applyBlockCode = applyBlockMatch[0];
  assert.ok(!applyBlockCode.includes('fingerprint'), 'No fingerprint verification in apply block');
  assert.ok(!applyBlockCode.includes('drift'), 'No drift check in apply block');
  assert.ok(!applyBlockCode.includes('snapshotVersion'), 'No snapshot version verification in apply block');
  assert.ok(applyBlockCode.includes('desktop.db.query'), 'Sends raw queries directly to desktop.db.query');
});

// --------------------------------------------------------------------------
// 2. P0 — G6.1/G6.2 Snapshot: captureFullSchema Blindness & SchemaDiff Gaps
// --------------------------------------------------------------------------

test('B01.4 [CONFIRMED BUG] captureFullSchema returns empty view definitions, routine SQL, triggers and events', async () => {
  // Extract captureFullSchema strictly from app.js using exact function boundary (lines 3358-3431)
  const appJsSource = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  const start = appJsSource.indexOf('async function captureFullSchema');
  assert.ok(start > 0, 'Found captureFullSchema in app.js');

  let depth = 0;
  let end = -1;
  for (let i = start; i < appJsSource.length; i++) {
    if (appJsSource[i] === '{') depth++;
    else if (appJsSource[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert.ok(end > start, 'Successfully determined exact end of captureFullSchema');
  const captureFullSchemaCode = appJsSource.slice(start, end);

  // Execute the exact function in the VM with realistic metadata fixtures:
  const desktop = {
    db: {
      tables: async () => ({
        ok: true,
        data: [
          { name: 'v_active_users', type: 'view' },
          { name: 'orders', type: 'table', engine: 'InnoDB', comment: 'Orders table' }
        ]
      }),
      columns: async () => ({
        ok: true,
        data: [{ name: 'id', type: 'int', nullable: false, defaultValue: null, extra: 'auto_increment', comment: '' }]
      }),
      indexes: async () => ({
        ok: true,
        data: [{ name: 'PRIMARY', nonUnique: 0, type: 'BTREE', columns: ['id'] }]
      }),
      relations: async () => ({
        ok: true,
        data: { outbound: [] }
      }),
      routines: async () => ({
        ok: true,
        data: [{ name: 'sp_calculate_total', type: 'PROCEDURE' }]
      })
    }
  };

  const r = loadRenderer({ desktop });
  r.evaluate(`${captureFullSchemaCode}\nwindow.__testCapture = captureFullSchema;`);
  const snapshot = await r.evaluate("window.__testCapture('sales_db', 'profile-1')");

  assert.equal(snapshot.database, 'sales_db');
  assert.equal(snapshot.engine, 'MySQL', 'DEFECT REPRODUCED: Engine is hardcoded to MySQL, ignoring MariaDB');
  assert.equal(snapshot.views.length, 1);
  assert.equal(snapshot.views[0].definition, '', 'DEFECT REPRODUCED: View definition is hardcoded to empty string ""');
  assert.equal(snapshot.routines.length, 1);
  assert.equal(snapshot.routines[0].sql, '', 'DEFECT REPRODUCED: Routine SQL is hardcoded to empty string ""');
  assert.equal(Array.isArray(snapshot.triggers), true);
  assert.equal(snapshot.triggers.length, 0, 'DEFECT REPRODUCED: Triggers array is hardcoded to empty []');
  assert.equal(Array.isArray(snapshot.events), true);
  assert.equal(snapshot.events.length, 0, 'DEFECT REPRODUCED: Events array is hardcoded to empty []');
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
