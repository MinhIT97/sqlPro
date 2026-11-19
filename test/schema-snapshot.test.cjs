'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSession } = require('../electron/database.cjs');
const {
  SchemaSnapshotCollector,
  detectEngine,
  splitViewDdl,
  parseViewDdl,
  computeSchemaFingerprint,
  projectSnapshotForRenderer,
  DEFAULT_QUOTAS,
  DEFAULT_PROJECTION_LIMITS
} = require('../electron/schema-snapshot.cjs');

/* ==========================================================================
   B02 — SCHEMA SNAPSHOT COLLECTOR TEST SUITE (G6.1 & G6.2)
   ========================================================================== */

function createMockSession({
  version = '8.0.35-mysql',
  profileType = 'mysql',
  tables = [],
  columns = {},
  indexes = {},
  relations = {},
  routines = [],
  events = [],
  triggers = [],
  customSql = {},
  showCreateFailures = new Set(),
  routineListFails = false,
  eventListFails = false,
  triggerQueryFails = false,
  tableListFails = false,
  relationFailsFor = new Set(),
  dead = false
} = {}) {
  const metadata = new Map();

  return {
    dead,
    version,
    metadata,
    tables,
    columns,
    indexes,
    relations,
    customSql,
    showCreateFailures,
    profile: { id: 'test-profile-1', type: profileType, name: 'Test Connection' },
    async listTables(db) {
      if (tableListFails) throw new Error('Access denied for listTables');
      return this.tables || tables;
    },
    async listColumns(db, table, options = {}) {
      const cacheKey = JSON.stringify(['columns', db, table]);
      if (!options?.fresh && metadata.has(cacheKey)) {
        return metadata.get(cacheKey);
      }
      const cols = columns[table] || [];
      metadata.set(cacheKey, cols);
      return cols;
    },
    async listIndexes(db, table, options = {}) {
      const cacheKey = JSON.stringify(['indexes', db, table]);
      if (!options?.fresh && metadata.has(cacheKey)) {
        return metadata.get(cacheKey);
      }
      const idxs = (indexes[table] || []).map(index => ({
        visibilityKind: 'unsupported', visibility: 'unsupported', definitionStatus: 'complete', ...index
      }));
      metadata.set(cacheKey, idxs);
      return idxs;
    },
    async listRelations(db, table, options = {}) {
      if (relationFailsFor.has(table)) {
        throw new Error(`Access denied for table ${table} foreign keys`);
      }
      return relations[table] || { outbound: [], inbound: [] };
    },
    async listRoutines(db) {
      if (routineListFails) throw new Error('Access denied for table information_schema.ROUTINES');
      return routines;
    },
    async listEvents(db) {
      if (eventListFails) throw new Error('Access denied for table information_schema.EVENTS');
      return events;
    },
    async showCreate(db, name, kind) {
      if (showCreateFailures.has(`${kind}:${name}`)) {
        const err = new Error(`SHOW CREATE ${kind.toUpperCase()} access denied for user`);
        err.code = 'ER_TABLEACCESS_DENIED_ERROR';
        throw err;
      }
      if (customSql[`${kind}:${name}`]) {
        return { sql: customSql[`${kind}:${name}`] };
      }
      if (kind === 'view') {
        return { sql: `CREATE VIEW \`${name}\` AS SELECT id, name FROM base_table` };
      }
      if (kind === 'procedure' || kind === 'function') {
        return { sql: `CREATE ${kind.toUpperCase()} \`${name}\`() BEGIN SELECT 1; END` };
      }
      if (kind === 'event') {
        return { sql: `CREATE EVENT \`${name}\` ON SCHEDULE EVERY 1 HOUR DO DELETE FROM logs` };
      }
      return { sql: `CREATE TABLE \`${name}\` (id INT PRIMARY KEY)` };
    },
    async raw(sql, params) {
      if (/information_schema\.TRIGGERS/i.test(sql)) {
        if (triggerQueryFails) throw new Error('Access denied for table information_schema.TRIGGERS');
        return { result: triggers.map(trigger => ({
          definer: 'fixture@localhost', sqlMode: '', actionOrder: 1,
          characterSetClient: 'utf8mb4', collationConnection: 'utf8mb4_bin', databaseCollation: 'utf8mb4_bin',
          ...trigger
        })) };
      }
      if (/information_schema\.EVENTS/i.test(sql)) {
        if (eventListFails) throw new Error('Access denied for table information_schema.EVENTS');
        return { result: events };
      }
      return { result: [] };
    }
  };
}

test('detectEngine identifies MariaDB vs MySQL faithfully from version string and profile', () => {
  assert.equal(detectEngine('11.4.2-MariaDB-ubu2404', 'mariadb'), 'MariaDB');
  assert.equal(detectEngine('10.11.6-MariaDB-log', 'mysql'), 'MariaDB');
  assert.equal(detectEngine('8.4.0', 'mysql'), 'MySQL');
  assert.equal(detectEngine('5.7.44', 'mysql'), 'MySQL');
  assert.equal(detectEngine('', ''), 'MySQL');
});

test('SchemaSnapshotCollector maps real DatabaseSession index unique and FK column properties faithfully', async () => {
  // Test Finding 1: DatabaseSession returns `unique: true/false` on indexes (not nonUnique),
  // and `column: 'user_id'` on relations (not columnName).
  const session = createMockSession({
    tables: [
      { name: 'orders', type: 'table', engine: 'InnoDB' }
    ],
    columns: {
      orders: [
        { name: 'id', type: 'int', nullable: false },
        { name: 'user_id', type: 'int', nullable: false },
        { name: 'created_at', type: 'datetime', nullable: false }
      ]
    },
    indexes: {
      orders: [
        // Index with unique: false (NON-UNIQUE index):
        { name: 'idx_created', unique: false, type: 'BTREE', columns: [{ name: 'created_at', sequence: 1 }] },
        // Index with unique: true (UNIQUE index):
        { name: 'idx_order_user', unique: true, type: 'BTREE', columns: [{ name: 'id', sequence: 1 }, { name: 'user_id', sequence: 2 }] }
      ]
    },
    relations: {
      orders: {
        // Real DatabaseSession.listRelations format (database.cjs:1368):
        outbound: [
          {
            name: 'fk_orders_user',
            table: 'orders',
            column: 'user_id',
            refTable: 'users',
            refColumn: 'id',
            refDatabase: 'shop_db',
            onDelete: 'RESTRICT',
            onUpdate: 'CASCADE'
          }
        ]
      }
    }
  });

  const collector = new SchemaSnapshotCollector(session);
  const snapshot = await collector.collect('shop_db');

  const ordersTable = snapshot.tables[0];
  assert.equal(ordersTable.name, 'orders');

  // Verify index unique mapping:
  const idxCreated = ordersTable.indexes.find((i) => i.name === 'idx_created');
  assert.ok(idxCreated);
  assert.equal(idxCreated.isUnique, false, 'Non-unique index MUST have isUnique: false');

  const idxOrderUser = ordersTable.indexes.find((i) => i.name === 'idx_order_user');
  assert.ok(idxOrderUser);
  assert.equal(idxOrderUser.isUnique, true, 'Unique index MUST have isUnique: true');

  // Verify foreign key column, database, and action mapping:
  const fk = ordersTable.foreignKeys[0];
  assert.ok(fk);
  assert.equal(fk.name, 'fk_orders_user');
  assert.deepEqual(fk.columns, ['user_id'], 'FK column name MUST be "user_id", not null or undefined');
  assert.deepEqual(fk.referencedColumns, ['id']);
  assert.equal(fk.referencedDatabase, 'shop_db');
  assert.equal(fk.onDelete, 'RESTRICT');
  assert.equal(fk.onUpdate, 'CASCADE');
});

test('SchemaSnapshotCollector records partial coverage and warnings when FK, view list, or event DDL fails', async () => {
  // Test Finding 2: Errors during metadata reading must NOT be treated as complete or empty
  const session = createMockSession({
    tables: [
      { name: 'orders', type: 'table', engine: 'InnoDB' },
      { name: 'v_summary', type: 'view' }
    ],
    columns: { orders: [{ name: 'id', type: 'int' }] },
    // FK read fails on orders:
    relationFailsFor: new Set(['orders']),
    // View SHOW CREATE fails on v_summary:
    showCreateFailures: new Set(['view:v_summary', 'event:ev_monthly_cleanup']),
    events: [
      { name: 'ev_monthly_cleanup', status: 'ENABLED' }
    ]
  });

  const collector = new SchemaSnapshotCollector(session);
  const snapshot = await collector.collect('app_db');

  // 1. Check FK failure on table:
  const table = snapshot.tables[0];
  assert.equal(table.foreignKeysStatus, 'unknown', 'Table FK status must be unknown due to error');
  assert.ok(snapshot.warnings.some((w) => w.code === 'TABLE_RELATIONS_FAILED' && w.objectName === 'orders'));

  // 2. Check view DDL failure:
  const view = snapshot.views[0];
  assert.equal(view.status, 'unknown');
  assert.equal(view.reason, 'ACCESS_DENIED');
  assert.equal(view.definition, null, 'View definition must be null, not empty string');
  assert.equal(snapshot.categories.views.coverage, 'partial');

  // 3. Check event DDL failure:
  const event = snapshot.events[0];
  assert.equal(event.coverageStatus, 'unknown');
  assert.equal(event.statement, null);
  assert.equal(snapshot.categories.events.coverage, 'partial', 'Events coverage must be partial');

  // 4. Overall coverage MUST be partial:
  assert.equal(snapshot.coverage, 'partial');
});

test('SchemaSnapshotCollector marks views coverage as unknown when listTables throws', async () => {
  // Test Finding 2b: If reading tables/views throws, coverage must be unknown, not complete with empty items
  const session = createMockSession({
    tableListFails: true
  });

  const collector = new SchemaSnapshotCollector(session);
  const snapshot = await collector.collect('secret_db');

  assert.equal(snapshot.categories.tables.coverage, 'unknown');
  assert.equal(snapshot.categories.views.coverage, 'unknown');
  assert.ok(snapshot.warnings.some((w) => w.code === 'TABLES_READ_FAILED'));
  assert.ok(snapshot.warnings.some((w) => w.code === 'VIEWS_LIST_FAILED'));
});

test('SchemaSnapshotCollector bypasses session metadata cache and detects schema drift between collections', async () => {
  // Test Finding 3: Cache metadata must not mask drift between two snapshot collections
  const session = createMockSession({
    tables: [{ name: 'products', type: 'table', engine: 'InnoDB' }],
    columns: {
      products: [{ name: 'id', type: 'int', nullable: false }]
    }
  });

  const collector = new SchemaSnapshotCollector(session);

  // Snapshot 1: products.id is INT
  const snapshot1 = await collector.collect('catalog_db');
  assert.equal(snapshot1.tables[0].columns[0].type, 'int');
  const fingerprint1 = snapshot1.snapshotIdentity;

  // Driver alters products.id to BIGINT:
  session.columns.products = [{ name: 'id', type: 'bigint', nullable: false }];

  // Snapshot 2: products.id must be fresh BIGINT without stale cache
  const snapshot2 = await collector.collect('catalog_db');
  assert.equal(snapshot2.tables[0].columns[0].type, 'bigint');
  const fingerprint2 = snapshot2.snapshotIdentity;

  assert.notEqual(
    fingerprint1,
    fingerprint2,
    'DRIFT DETECTED: Fingerprint must differ when column definition changes between snapshot runs'
  );
});

test('SchemaSnapshotCollector binds trusted session context from Main Process and aborts if session is dead', async () => {
  // Test Finding 4: Binds sessionId, profileFingerprint, and generation from Main Process
  const session = createMockSession();

  const collector = new SchemaSnapshotCollector(session, {
    sessionId: 'session-uuid-456',
    profileId: 'prod-profile-789',
    profileFingerprint: 'a'.repeat(64),
    generation: 3
  });

  const snapshot = await collector.collect('main_db');
  assert.equal(snapshot.scope.sessionId, 'session-uuid-456');
  assert.equal(snapshot.scope.profileId, 'prod-profile-789');
  assert.equal(snapshot.scope.profileFingerprint, 'a'.repeat(64));
  assert.equal(snapshot.scope.generation, 3);

  // If session is marked dead (disconnected), collection must throw:
  session.dead = true;
  await assert.rejects(async () => {
    await collector.collect('main_db');
  }, /Phiên kết nối đã bị đóng hoặc mất kết nối/);
});

test('computeSchemaFingerprint produces identical hash for identical schemas regardless of insertion order', () => {
  const schemaA = {
    database: 'db',
    tables: [
      { name: 't2', columns: [{ name: 'c1', type: 'int' }] },
      { name: 't1', columns: [{ name: 'c1', type: 'int' }] }
    ]
  };

  const schemaB = {
    database: 'db',
    tables: [
      { name: 't1', columns: [{ name: 'c1', type: 'int' }] },
      { name: 't2', columns: [{ name: 'c1', type: 'int' }] }
    ]
  };

  // When sorted deterministically:
  schemaA.tables.sort((a, b) => a.name.localeCompare(b.name));
  schemaB.tables.sort((a, b) => a.name.localeCompare(b.name));

  const hashA = computeSchemaFingerprint(schemaA);
  const hashB = computeSchemaFingerprint(schemaB);

  assert.equal(hashA, hashB, 'Deterministic canonical stringify yields identical SHA-256');
});

test('projectSnapshotForRenderer strips unbounded SQL blobs and projects compact metadata for UI', async () => {
  const session = createMockSession({
    tables: [
      { name: 'orders', type: 'table', engine: 'InnoDB' },
      { name: 'v_orders', type: 'view' }
    ],
    columns: {
      orders: [{ name: 'id', type: 'int' }, { name: 'total', type: 'decimal(10,2)' }]
    },
    indexes: {
      orders: [{ name: 'PRIMARY', isPrimary: true, columns: ['id'] }]
    },
    routines: [{ name: 'sp_proc', type: 'procedure' }],
    triggers: [{ name: 'tr_insert', table: 'orders', timing: 'AFTER', event: 'INSERT', statement: 'DO 1;' }],
    events: [{ name: 'ev_clean', status: 'ENABLED' }]
  });

  const collector = new SchemaSnapshotCollector(session);
  const snapshot = await collector.collect('ecommerce_db');
  const projection = projectSnapshotForRenderer(snapshot);

  assert.equal(projection.kind, 'sqlpro-schema-snapshot-projection');
  assert.equal(projection.summary.tableCount, 1);
  assert.equal(projection.summary.viewCount, 1);
  assert.equal(projection.summary.routineCount, 1);
  assert.equal(projection.summary.triggerCount, 1);
  assert.equal(projection.summary.eventCount, 1);
  assert.equal(projection.tables[0].name, 'orders');
  assert.equal(projection.tables[0].columnCount, 2);
  assert.equal(projection.tables[0].indexCount, 1);

  // Crucially: full view definition / routine SQL is not exposed in the compact projection:
  assert.equal(projection.views[0].definition, undefined);
  assert.equal(projection.routines[0].sql, undefined);
});

test('SchemaSnapshotCollector captures FK referencedDatabase and action rules faithfully and detects drift on changes', async () => {
  // Test Finding 1: Changing refDatabase or FK action rules MUST produce distinct fingerprints
  // and missing action metadata MUST NOT silently default to RESTRICT.
  const session = createMockSession({
    tables: [{ name: 'orders', type: 'table', engine: 'InnoDB' }],
    columns: {
      orders: [
        { name: 'id', type: 'int', nullable: false },
        { name: 'user_id', type: 'int', nullable: false }
      ]
    },
    relations: {
      orders: {
        outbound: [
          {
            name: 'fk_orders_user',
            table: 'orders',
            column: 'user_id',
            refTable: 'users',
            refColumn: 'id',
            refDatabase: 'shop_db',
            onDelete: 'RESTRICT',
            onUpdate: 'RESTRICT'
          }
        ]
      }
    }
  });

  const collector = new SchemaSnapshotCollector(session);

  // Snapshot 1: refDatabase = 'shop_db', onDelete = 'RESTRICT'
  const snap1 = await collector.collect('orders_db');
  assert.equal(snap1.coverage, 'complete');
  assert.equal(snap1.tables[0].foreignKeys[0].referencedDatabase, 'shop_db');
  assert.equal(snap1.tables[0].foreignKeys[0].onDelete, 'RESTRICT');
  const hash1 = snap1.snapshotIdentity;

  // Drift 1: Change referenced database to 'archive_db'
  session.relations.orders = {
    outbound: [
      {
        name: 'fk_orders_user',
        table: 'orders',
        column: 'user_id',
        refTable: 'users',
        refColumn: 'id',
        refDatabase: 'archive_db',
        onDelete: 'RESTRICT',
        onUpdate: 'RESTRICT'
      }
    ]
  };
  const snap2 = await collector.collect('orders_db');
  assert.equal(snap2.tables[0].foreignKeys[0].referencedDatabase, 'archive_db');
  const hash2 = snap2.snapshotIdentity;
  assert.notEqual(hash1, hash2, 'DRIFT DETECTED: Changing FK referencedDatabase must change snapshot fingerprint');

  // Drift 2: Change onDelete from RESTRICT to CASCADE
  session.relations.orders = {
    outbound: [
      {
        name: 'fk_orders_user',
        table: 'orders',
        column: 'user_id',
        refTable: 'users',
        refColumn: 'id',
        refDatabase: 'archive_db',
        onDelete: 'CASCADE',
        onUpdate: 'RESTRICT'
      }
    ]
  };
  const snap3 = await collector.collect('orders_db');
  assert.equal(snap3.tables[0].foreignKeys[0].onDelete, 'CASCADE');
  const hash3 = snap3.snapshotIdentity;
  assert.notEqual(hash2, hash3, 'DRIFT DETECTED: Changing FK onDelete rule must change snapshot fingerprint');

  // Finding 1 safeguard: Missing onDelete / onUpdate must NOT default to RESTRICT;
  // it must be kept as null, mark coverage partial, and record a warning.
  session.relations.orders = {
    outbound: [
      {
        name: 'fk_orders_user',
        table: 'orders',
        column: 'user_id',
        refTable: 'users',
        refColumn: 'id',
        refDatabase: 'archive_db',
        onDelete: null,
        onUpdate: null
      }
    ]
  };
  const snap4 = await collector.collect('orders_db');
  assert.equal(snap4.coverage, 'partial', 'Missing FK action rules must mark coverage partial');
  assert.equal(snap4.tables[0].foreignKeys[0].onDelete, null, 'Must NOT invent RESTRICT when action is unknown');
  assert.equal(snap4.tables[0].foreignKeys[0].onUpdate, null);
  assert.ok(
    snap4.warnings.some((w) => w.code === 'FK_ACTION_UNKNOWN' && w.objectName === 'orders'),
    'Must record FK_ACTION_UNKNOWN warning'
  );
});

test('SchemaSnapshotCollector captures view DEFINER, SQL SECURITY, ALGORITHM and detects drift on changes', async () => {
  // Test Finding 2: Retains full view attributes (DEFINER, SQL SECURITY, ALGORITHM)
  // and detects drift when execution rights change from DEFINER to INVOKER.
  const session = createMockSession({
    tables: [{ name: 'v_users', type: 'view' }]
  });

  // Initial DDL: SQL SECURITY DEFINER, ALGORITHM=UNDEFINED, DEFINER=`root`@`localhost`
  session.customSql['view:v_users'] =
    'CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v_users` AS SELECT id, name FROM users';

  const collector = new SchemaSnapshotCollector(session);

  // Snapshot 1:
  const snap1 = await collector.collect('users_db');
  assert.equal(snap1.coverage, 'complete');
  const view1 = snap1.views[0];
  assert.equal(view1.algorithm, 'UNDEFINED');
  assert.equal(view1.definer, '`root`@`localhost`');
  assert.equal(view1.security, 'DEFINER');
  assert.equal(view1.definition, 'SELECT id, name FROM users');
  const hash1 = snap1.snapshotIdentity;

  // Drift 1: Change SQL SECURITY DEFINER -> INVOKER
  session.customSql['view:v_users'] =
    'CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY INVOKER VIEW `v_users` AS SELECT id, name FROM users';
  const snap2 = await collector.collect('users_db');
  const view2 = snap2.views[0];
  assert.equal(view2.security, 'INVOKER');
  const hash2 = snap2.snapshotIdentity;
  assert.notEqual(
    hash1,
    hash2,
    'DRIFT DETECTED: Changing SQL SECURITY from DEFINER to INVOKER must change snapshot fingerprint'
  );

  // Drift 2: Change ALGORITHM UNDEFINED -> MERGE
  session.customSql['view:v_users'] =
    'CREATE ALGORITHM=MERGE DEFINER=`root`@`localhost` SQL SECURITY INVOKER VIEW `v_users` AS SELECT id, name FROM users';
  const snap3 = await collector.collect('users_db');
  assert.equal(snap3.views[0].algorithm, 'MERGE');
  const hash3 = snap3.snapshotIdentity;
  assert.notEqual(
    hash2,
    hash3,
    'DRIFT DETECTED: Changing view ALGORITHM must change snapshot fingerprint'
  );

  // Drift 3: Change DEFINER `root`@`localhost` -> `app`@`%`
  session.customSql['view:v_users'] =
    'CREATE ALGORITHM=MERGE DEFINER=`app`@`%` SQL SECURITY INVOKER VIEW `v_users` AS SELECT id, name FROM users';
  const snap4 = await collector.collect('users_db');
  assert.equal(snap4.views[0].definer, '`app`@`%`');
  const hash4 = snap4.snapshotIdentity;
  assert.notEqual(
    hash3,
    hash4,
    'DRIFT DETECTED: Changing view DEFINER must change snapshot fingerprint'
  );

  // Finding 2 safeguard: View with missing DDL / ACCESS_DENIED must be marked blocked for migration
  session.showCreateFailures.add('view:v_users');
  const snap5 = await collector.collect('users_db');
  assert.equal(snap5.coverage, 'partial');
  assert.equal(snap5.views[0].status, 'unknown');
  assert.equal(snap5.views[0].migrationStatus, 'blocked');
  assert.equal(snap5.views[0].migrationBlockReason, 'ACCESS_DENIED');
});

test('SchemaSnapshotCollector captures generated column expressions and detects drift on formula changes', async () => {
  // Test Finding 3: Captures generationExpression for virtual/stored generated columns
  // and detects drift when calculation expression changes (e.g. price * 2 to price * 3).
  const session = createMockSession({
    tables: [{ name: 'products', type: 'table', engine: 'InnoDB' }],
    columns: {
      products: [
        { name: 'id', type: 'int', nullable: false },
        { name: 'price', type: 'decimal(10,2)', nullable: false },
        {
          name: 'total_with_tax',
          type: 'decimal(10,2)',
          extra: 'STORED GENERATED',
          generationExpression: 'price * 1.10'
        }
      ]
    }
  });

  const collector = new SchemaSnapshotCollector(session);

  // Snapshot 1: generationExpression is price * 1.10
  const snap1 = await collector.collect('shop_db');
  assert.equal(snap1.coverage, 'complete');
  const col1 = snap1.tables[0].columns.find((c) => c.name === 'total_with_tax');
  assert.ok(col1);
  assert.equal(col1.isGenerated, true);
  assert.equal(col1.generationExpression, 'price * 1.10');
  const hash1 = snap1.snapshotIdentity;

  // Drift 1: Tax formula changes from price * 1.10 to price * 1.15
  session.columns.products = [
    { name: 'id', type: 'int', nullable: false },
    { name: 'price', type: 'decimal(10,2)', nullable: false },
    {
      name: 'total_with_tax',
      type: 'decimal(10,2)',
      extra: 'STORED GENERATED',
      generationExpression: 'price * 1.15'
    }
  ];
  const snap2 = await collector.collect('shop_db');
  const col2 = snap2.tables[0].columns.find((c) => c.name === 'total_with_tax');
  assert.equal(col2.generationExpression, 'price * 1.15');
  const hash2 = snap2.snapshotIdentity;
  assert.notEqual(
    hash1,
    hash2,
    'DRIFT DETECTED: Changing generated column formula must change snapshot fingerprint'
  );

  // Finding 3 safeguard: Column with STORED GENERATED but missing expression must mark coverage partial
  // and record GENERATED_COLUMN_EXPRESSION_MISSING warning.
  session.columns.products = [
    { name: 'id', type: 'int', nullable: false },
    { name: 'price', type: 'decimal(10,2)', nullable: false },
    {
      name: 'total_with_tax',
      type: 'decimal(10,2)',
      extra: 'STORED GENERATED',
      generationExpression: null
    }
  ];
  const snap3 = await collector.collect('shop_db');
  assert.equal(snap3.coverage, 'partial', 'Missing generated expression must mark coverage partial');
  assert.ok(
    snap3.warnings.some(
      (w) => w.code === 'GENERATED_COLUMN_EXPRESSION_MISSING' && w.objectName === 'products.total_with_tax'
    ),
    'Must record GENERATED_COLUMN_EXPRESSION_MISSING warning'
  );
});

test('SchemaSnapshotCollector captures table/column collation and index prefix/direction, detecting drift on changes', async () => {
  // Test Finding 1: Table collation, column collation, index subPart (prefix), and direction (ASC/DESC)
  // must be captured in canonical data and alter the SHA-256 fingerprint upon change.
  const session = createMockSession({
    tables: [{ name: 'articles', type: 'table', engine: 'InnoDB', collation: 'utf8mb4_0900_ai_ci' }],
    columns: {
      articles: [
        { name: 'id', type: 'int', nullable: false },
        { name: 'title', type: 'varchar(255)', nullable: false, collation: 'utf8mb4_0900_ai_ci' }
      ]
    },
    indexes: {
      articles: [
        {
          name: 'idx_title',
          unique: false,
          type: 'BTREE',
          columns: [{ name: 'title', sequence: 1, subPart: 20, direction: 'ASC' }]
        }
      ]
    }
  });

  const collector = new SchemaSnapshotCollector(session);

  // Baseline Snapshot:
  const snap1 = await collector.collect('blog_db');
  assert.equal(snap1.coverage, 'complete');
  assert.equal(snap1.tables[0].collation, 'utf8mb4_0900_ai_ci');
  assert.equal(snap1.tables[0].columns[1].collation, 'utf8mb4_0900_ai_ci');
  assert.equal(snap1.tables[0].indexes[0].columns[0].subPart, 20);
  assert.equal(snap1.tables[0].indexes[0].columns[0].direction, 'ASC');
  const hash1 = snap1.snapshotIdentity;

  // Drift 1a: Table collation changes to utf8mb4_bin
  session.tables = [{ name: 'articles', type: 'table', engine: 'InnoDB', collation: 'utf8mb4_bin' }];
  const snap2 = await collector.collect('blog_db');
  assert.equal(snap2.tables[0].collation, 'utf8mb4_bin');
  const hash2 = snap2.snapshotIdentity;
  assert.notEqual(hash1, hash2, 'DRIFT DETECTED: Changing table collation must change fingerprint');

  // Drift 1b: Column collation changes to utf8mb4_vietnamese_ci
  session.columns.articles = [
    { name: 'id', type: 'int', nullable: false },
    { name: 'title', type: 'varchar(255)', nullable: false, collation: 'utf8mb4_vietnamese_ci' }
  ];
  const snap3 = await collector.collect('blog_db');
  assert.equal(snap3.tables[0].columns[1].collation, 'utf8mb4_vietnamese_ci');
  const hash3 = snap3.snapshotIdentity;
  assert.notEqual(hash2, hash3, 'DRIFT DETECTED: Changing column collation must change fingerprint');

  // Drift 1c: Index prefix length changes from 20 to 50
  session.indexes.articles = [
    {
      name: 'idx_title',
      unique: false,
      type: 'BTREE',
      columns: [{ name: 'title', sequence: 1, subPart: 50, direction: 'ASC' }]
    }
  ];
  const snap4 = await collector.collect('blog_db');
  assert.equal(snap4.tables[0].indexes[0].columns[0].subPart, 50);
  const hash4 = snap4.snapshotIdentity;
  assert.notEqual(hash3, hash4, 'DRIFT DETECTED: Changing index subPart (prefix) must change fingerprint');

  // Drift 1d: Index direction changes from ASC to DESC
  session.indexes.articles = [
    {
      name: 'idx_title',
      unique: false,
      type: 'BTREE',
      columns: [{ name: 'title', sequence: 1, subPart: 50, direction: 'DESC' }]
    }
  ];
  const snap5 = await collector.collect('blog_db');
  assert.equal(snap5.tables[0].indexes[0].columns[0].direction, 'DESC');
  const hash5 = snap5.snapshotIdentity;
  assert.notEqual(hash4, hash5, 'DRIFT DETECTED: Changing index direction to DESC must change fingerprint');
});

test('SchemaSnapshotCollector distinguishes DEFAULT_GENERATED from VIRTUAL/STORED generated columns without false positives', async () => {
  // Test Finding 2: Columns with DEFAULT_GENERATED (e.g. DEFAULT (now())) must NOT be misidentified
  // as VIRTUAL/STORED generated columns or raise false GENERATED_COLUMN_EXPRESSION_MISSING warnings.
  const session = createMockSession({
    tables: [{ name: 'audit_events', type: 'table', engine: 'InnoDB' }],
    columns: {
      audit_events: [
        {
          name: 'id',
          type: 'bigint',
          nullable: false,
          defaultValue: null
        },
        {
          name: 'created_at',
          type: 'timestamp',
          nullable: false,
          defaultValue: 'CURRENT_TIMESTAMP',
          extra: 'DEFAULT_GENERATED',
          generationExpression: null
        },
        {
          name: 'total_vat',
          type: 'decimal(10,2)',
          nullable: false,
          extra: 'STORED GENERATED',
          generationExpression: 'amount * 0.1'
        }
      ]
    }
  });

  const collector = new SchemaSnapshotCollector(session);
  const snap = await collector.collect('analytics_db');

  assert.equal(snap.coverage, 'complete', 'Coverage must be complete when DEFAULT_GENERATED has no generationExpression');
  assert.equal(snap.warnings.length, 0, 'No warning must be raised for DEFAULT_GENERATED column');

  const createdAtCol = snap.tables[0].columns.find((c) => c.name === 'created_at');
  assert.ok(createdAtCol);
  assert.equal(createdAtCol.isDefaultGenerated, true);
  assert.equal(createdAtCol.isGenerated, false, 'DEFAULT_GENERATED column must have isGenerated: false');
  assert.equal(createdAtCol.generationExpression, null);

  const totalVatCol = snap.tables[0].columns.find((c) => c.name === 'total_vat');
  assert.ok(totalVatCol);
  assert.equal(totalVatCol.isDefaultGenerated, false);
  assert.equal(totalVatCol.isGenerated, true);
  assert.equal(totalVatCol.generationExpression, 'amount * 0.1');
});

test('SchemaSnapshotCollector parses complex view DDL with quote/comment awareness without misidentifying keywords', async () => {
  // Test Finding 3: Views with names containing 'AS' (e.g. `sales AS report`),
  // or containing 'SQL SECURITY INVOKER' inside SQL string literals/comments,
  // must be parsed correctly without token hijacking or corrupting the view definition.
  const session = createMockSession({
    tables: [
      { name: 'sales AS report', type: 'view' },
      { name: 'v_literal', type: 'view' },
      { name: 'v_malformed', type: 'view' }
    ]
  });

  // View 1: View name has backticked AS
  session.customSql['view:sales AS report'] =
    'CREATE VIEW `sales AS report` AS SELECT 1 AS n';

  // View 2: SQL string literal contains 'SQL SECURITY INVOKER' and comment block
  session.customSql['view:v_literal'] =
    "CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` VIEW `v_literal` AS SELECT 'SQL SECURITY INVOKER' AS note, /* ALGORITHM=MERGE */ 42 AS val";

  // View 3: Malformed view syntax (missing AS)
  session.customSql['view:v_malformed'] =
    'CREATE VIEW `v_malformed` INVALID_NO_AS_SYNTAX';

  const collector = new SchemaSnapshotCollector(session);
  const snap = await collector.collect('reports_db');

  // Verify View 1:
  const view1 = snap.views.find((v) => v.name === 'sales AS report');
  assert.ok(view1);
  assert.equal(view1.status, 'complete');
  assert.equal(view1.definition, 'SELECT 1 AS n', 'Definition must NOT be corrupted into report` AS ...');
  assert.equal(view1.security, null);
  assert.equal(view1.algorithm, null);

  // Verify View 2:
  const view2 = snap.views.find((v) => v.name === 'v_literal');
  assert.ok(view2);
  assert.equal(view2.status, 'complete');
  assert.equal(view2.algorithm, 'UNDEFINED', 'Algorithm must be UNDEFINED, not hijacked by comment');
  assert.equal(view2.definer, '`root`@`localhost`');
  assert.equal(view2.security, null, 'Security must be null; literal in SELECT must not become view security');
  assert.equal(view2.definition, "SELECT 'SQL SECURITY INVOKER' AS note, /* ALGORITHM=MERGE */ 42 AS val");

  // Verify View 3 (unrecognized syntax):
  const view3 = snap.views.find((v) => v.name === 'v_malformed');
  assert.ok(view3);
  assert.equal(view3.status, 'unknown');
  assert.equal(view3.migrationStatus, 'blocked');
  assert.equal(view3.migrationBlockReason, 'UNRECOGNIZED_VIEW_SYNTAX');
  assert.ok(snap.warnings.some((w) => w.code === 'VIEW_SYNTAX_UNRECOGNIZED' && w.objectName === 'v_malformed'));

  // Overall coverage must reflect partial due to unrecognized syntax:
  assert.equal(snap.coverage, 'partial');
});

test('SchemaSnapshotCollector enforces object, DDL byte, and timeout quotas and bounds renderer projection lists', async () => {
  // Test Finding 4: Bounded quotas on collector and bounded list projections for UI.
  // 1. Collector object quota:
  const sessionMany = createMockSession({
    tables: [
      { name: 't1', type: 'table', engine: 'InnoDB' },
      { name: 't2', type: 'table', engine: 'InnoDB' },
      { name: 't3', type: 'table', engine: 'InnoDB' },
      { name: 't4', type: 'table', engine: 'InnoDB' }
    ]
  });

  const collectorWithObjectCap = new SchemaSnapshotCollector(sessionMany, {
    quotas: { maxObjects: 2 }
  });
  const snapCapped = await collectorWithObjectCap.collect('quota_db');
  assert.equal(snapCapped.coverage, 'partial');
  assert.equal(snapCapped.tables.length, 2, 'Must stop collecting tables when maxObjects quota is reached');
  assert.ok(snapCapped.warnings.some((w) => w.code === 'OBJECT_QUOTA_EXCEEDED'));

  // 2. Collector DDL byte quota:
  const sessionDdlCap = createMockSession({
    tables: [{ name: 'v_large', type: 'view' }]
  });
  // DDL size is > 50 bytes:
  sessionDdlCap.customSql['view:v_large'] =
    'CREATE VIEW `v_large` AS SELECT 1234567890, 1234567890, 1234567890, 1234567890, 1234567890';
  const collectorWithByteCap = new SchemaSnapshotCollector(sessionDdlCap, {
    quotas: { maxDdlBytes: 40 }
  });
  const snapByteCapped = await collectorWithByteCap.collect('quota_db');
  assert.equal(snapByteCapped.coverage, 'partial');
  assert.equal(snapByteCapped.views[0].status, 'unknown');
  assert.equal(snapByteCapped.views[0].reason, 'BYTE_QUOTA_EXCEEDED');
  assert.equal(snapByteCapped.views[0].migrationStatus, 'blocked');
  assert.ok(snapByteCapped.warnings.some((w) => w.code === 'BYTE_QUOTA_EXCEEDED'));

  // 3. Renderer projection bounding:
  // Build a snapshot with 120 tables and 60 warnings:
  const largeTables = [];
  for (let i = 1; i <= 120; i++) {
    largeTables.push({
      name: `tbl_${i}`,
      engine: 'InnoDB',
      foreignKeysStatus: 'complete',
      columns: [{ name: 'id', type: 'int' }],
      indexes: [],
      foreignKeys: []
    });
  }
  const largeWarnings = [];
  for (let i = 1; i <= 60; i++) {
    largeWarnings.push({ code: `WARN_${i}`, message: `Warning ${i}` });
  }

  const mockSnapshot = {
    kind: 'sqlpro-schema-snapshot',
    scope: { database: 'big_db' },
    snapshotIdentity: 'abc123hash',
    finishedAt: new Date().toISOString(),
    coverage: 'complete',
    categories: {
      tables: { count: 120 },
      views: { count: 0 },
      routines: { count: 0 },
      triggers: { count: 0 },
      events: { count: 0 }
    },
    tables: largeTables,
    views: [],
    routines: [],
    triggers: [],
    events: [],
    warnings: largeWarnings
  };

  const projection = projectSnapshotForRenderer(mockSnapshot);
  assert.equal(projection.kind, 'sqlpro-schema-snapshot-projection');
  // Tables bounded to DEFAULT_PROJECTION_LIMITS.maxTables (100):
  assert.equal(projection.tables.length, 100);
  assert.equal(projection.tablesTruncated, true);
  assert.equal(projection.totalTables, 120);
  assert.equal(projection.summary.tableCount, 120);

  // Warnings bounded to DEFAULT_PROJECTION_LIMITS.maxWarnings (50):
  assert.equal(projection.warnings.length, 50);
  assert.equal(projection.warningsTruncated, true);
  assert.equal(projection.totalWarnings, 60);
  assert.equal(projection.summary.warningCount, 60);
});

test('B02.29 — Continuous timeout enforcement stops subsequent queries and marks partial coverage', async () => {
  let listRoutinesCalled = 0;
  let listEventsCalled = 0;
  let rawCallsAfterTables = 0;
  let listTablesCount = 0;

  const mockSession = {
    version: '8.0.35',
    profile: { id: 'slow-sess', type: 'mysql' },
    metadata: new Map(),
    async listTables() {
      listTablesCount++;
      // Simulate slow read taking 50ms with empty tables:
      await new Promise((resolve) => setTimeout(resolve, 50));
      return [];
    },
    async listRoutines() {
      listRoutinesCalled++;
      return [];
    },
    async listEvents() {
      listEventsCalled++;
      return [];
    },
    async raw() {
      if (listTablesCount > 0) rawCallsAfterTables++;
      return { result: [] };
    }
  };

  const collector = new SchemaSnapshotCollector(mockSession, {
    quotas: { timeoutMs: 1 } // 1ms timeout deadline
  });

  const snapshot = await collector.collect('slow_db');

  // Must detect timeout even though tables were empty:
  assert.equal(snapshot.coverage, 'partial', 'Snapshot coverage must be partial when timeout occurs');
  const timeoutWarning = snapshot.warnings.find((w) => w.code === 'SNAPSHOT_TIMEOUT');
  assert.ok(timeoutWarning, 'Snapshot warnings must include SNAPSHOT_TIMEOUT');

  // Must not call subsequent phases after timeout expired:
  assert.equal(listRoutinesCalled, 0, 'listRoutines must not be called after deadline passed');
  assert.equal(listEventsCalled, 0, 'listEvents must not be called after deadline passed');
  assert.equal(rawCallsAfterTables, 0, 'raw (triggers/events) must not be called after deadline passed');

  // Driver timeout verification: listRelations must immediately rethrow PROTOCOL_SEQUENCE_TIMEOUT
  // without executing fallback or inbound queries.
  const outboundExecuted = [];
  const sessionOutboundTimeout = new DatabaseSession({ id: 'test-driver-timeout', type: 'mysql' });
  sessionOutboundTimeout.raw = async (sql, params, timeoutMs) => {
    outboundExecuted.push({ sql, params, timeoutMs });
    const timeoutErr = new Error('Query execution was interrupted by timeout');
    timeoutErr.code = 'PROTOCOL_SEQUENCE_TIMEOUT';
    throw timeoutErr;
  };

  await assert.rejects(
    async () => {
      await sessionOutboundTimeout.listRelations('test_db', 'users', { timeoutMs: 5000 });
    },
    (err) => {
      assert.equal(err.code, 'PROTOCOL_SEQUENCE_TIMEOUT');
      return true;
    }
  );

  // Assert that exactly 1 query was executed — NO fallback query, and NO inbound query!
  assert.equal(outboundExecuted.length, 1, 'Exactly one query must be executed before timeout aborts');
  assert.ok(
    /REFERENTIAL_CONSTRAINTS/.test(outboundExecuted[0].sql),
    'The executed query should be the initial outbound query'
  );
  assert.ok(
    !outboundExecuted.some((q) => !/REFERENTIAL_CONSTRAINTS/.test(q.sql)),
    'Fallback query must NOT be executed after PROTOCOL_SEQUENCE_TIMEOUT'
  );

  // Inbound query timeout verification:
  const inboundExecuted = [];
  const sessionInboundTimeout = new DatabaseSession({ id: 'test-driver-timeout-2', type: 'mysql' });
  sessionInboundTimeout.raw = async (sql, params, timeoutMs) => {
    inboundExecuted.push({ sql, params, timeoutMs });
    if (inboundExecuted.length === 1) {
      return { result: [] }; // outbound succeeds
    }
    const timeoutErr = new Error('Inbound timeout');
    timeoutErr.code = 'PROTOCOL_SEQUENCE_TIMEOUT';
    throw timeoutErr;
  };

  await assert.rejects(
    async () => {
      await sessionInboundTimeout.listRelations('test_db', 'users', { timeoutMs: 5000 });
    },
    (err) => {
      assert.equal(err.code, 'PROTOCOL_SEQUENCE_TIMEOUT');
      return true;
    }
  );

  assert.equal(inboundExecuted.length, 2, 'Exactly 2 queries executed (outbound + first inbound), no fallback inbound');
  assert.ok(inboundExecuted.every((q) => /REFERENTIAL_CONSTRAINTS/.test(q.sql)), 'Must not call fallback query without REFERENTIAL_CONSTRAINTS');
});

test('B02.30 — Trigger statements enforce cumulative byte quota and block migration if exceeded', async () => {
  const largeTriggerStatement = `
    BEGIN
      INSERT INTO system_audit_logs (event_type, target_table, details, recorded_at)
      VALUES ('INSERT', 'users', CONCAT('User record created with ID: ', NEW.id, ' and email: ', NEW.email), NOW());
    END
  `.trim();

  assert.ok(Buffer.byteLength(largeTriggerStatement, 'utf8') > 100);

  const mockSession = createMockSession({
    tables: [{ name: 'users', type: 'table' }],
    columns: { users: [{ name: 'id', type: 'int' }, { name: 'email', type: 'varchar(255)' }] },
    indexes: {},
    relations: {},
    triggers: [
      {
        name: 'trg_users_audit',
        table: 'users',
        timing: 'AFTER',
        event: 'INSERT',
        statement: largeTriggerStatement
      }
    ]
  });

  // Collect with maxDdlBytes quota = 32 bytes (trigger statement is ~190 bytes):
  const collector = new SchemaSnapshotCollector(mockSession, {
    quotas: { maxDdlBytes: 32 }
  });

  const snapshot = await collector.collect('capped_db');

  assert.equal(snapshot.coverage, 'partial', 'Coverage must be partial when trigger exceeds byte quota');
  assert.equal(snapshot.categories.triggers.coverage, 'partial');

  const byteWarning = snapshot.warnings.find((w) => w.code === 'BYTE_QUOTA_EXCEEDED' && w.category === 'triggers');
  assert.ok(byteWarning, 'Must record BYTE_QUOTA_EXCEEDED warning for triggers');
  assert.equal(byteWarning.objectName, 'trg_users_audit');

  const trg = snapshot.triggers.find((t) => t.name === 'trg_users_audit');
  assert.ok(trg, 'Trigger must exist in snapshot');
  assert.equal(trg.statement, null, 'Statement must be truncated to null on byte quota exceed');
  assert.equal(trg.status, 'unknown', 'Status must be unknown');
  assert.equal(trg.reason, 'BYTE_QUOTA_EXCEEDED');
  assert.equal(trg.migrationStatus, 'blocked', 'Migration must be blocked');
  assert.equal(trg.migrationBlockReason, 'BYTE_QUOTA_EXCEEDED');

  // Verify renderer projection reflects status and migrationStatus:
  const projection = projectSnapshotForRenderer(snapshot);
  const projTrg = projection.triggers.find((t) => t.name === 'trg_users_audit');
  assert.equal(projTrg.status, 'unknown');
  assert.equal(projTrg.migrationStatus, 'blocked');
});

test('B02.31 — View header tokenizer correctly handles definer with quoted keywords, spaces, and escaped characters', async () => {
  // Case 1: Codex reproducer — DEFINER contains "SQL SECURITY INVOKER" as quoted username:
  const ddl1 = 'CREATE ALGORITHM=UNDEFINED DEFINER=`SQL SECURITY INVOKER`@`localhost` SQL SECURITY DEFINER VIEW `v_reports` AS SELECT 1 AS id';
  const parsed1 = parseViewDdl(ddl1);

  assert.equal(parsed1.algorithm, 'UNDEFINED');
  assert.equal(parsed1.definer, '`SQL SECURITY INVOKER`@`localhost`');
  assert.equal(parsed1.security, 'DEFINER', 'Must match actual SQL SECURITY DEFINER, not the username string');
  assert.equal(parsed1.definition, 'SELECT 1 AS id');

  // Case 2: Username and host with single quotes and spaces:
  const ddl2 = "CREATE DEFINER='sales admin'@'192.168.1.%' SQL SECURITY INVOKER VIEW `v_sales` AS SELECT amount FROM sales";
  const parsed2 = parseViewDdl(ddl2);

  assert.equal(parsed2.definer, "'sales admin'@'192.168.1.%'");
  assert.equal(parsed2.security, 'INVOKER');
  assert.equal(parsed2.definition, 'SELECT amount FROM sales');

  // Case 3: Username with doubled backtick escape:
  const ddl3 = 'CREATE ALGORITHM=MERGE DEFINER=`admin``special`@`localhost` SQL SECURITY DEFINER VIEW `v_esc` AS SELECT 42';
  const parsed3 = parseViewDdl(ddl3);

  assert.equal(parsed3.algorithm, 'MERGE');
  assert.equal(parsed3.definer, '`admin``special`@`localhost`');
  assert.equal(parsed3.security, 'DEFINER');
  assert.equal(parsed3.definition, 'SELECT 42');

  // Case 4: Verify fingerprint detects change in SQL SECURITY even with tricky username:
  const ddl1Alt = 'CREATE ALGORITHM=UNDEFINED DEFINER=`SQL SECURITY INVOKER`@`localhost` SQL SECURITY INVOKER VIEW `v_reports` AS SELECT 1 AS id';
  const parsed1Alt = parseViewDdl(ddl1Alt);

  assert.equal(parsed1Alt.security, 'INVOKER');

  const fp1 = computeSchemaFingerprint({ views: [{ name: 'v_reports', ...parsed1 }] });
  const fp1Alt = computeSchemaFingerprint({ views: [{ name: 'v_reports', ...parsed1Alt }] });

  assert.notEqual(fp1, fp1Alt, 'Fingerprint must differentiate DEFINER vs INVOKER security even with keywords in definer');
});
