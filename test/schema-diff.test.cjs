'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const SchemaDiff = require('../schema-diff.js');

test('normalizeSchemaSnapshot normalizes raw tables, columns, indexes, and FKs', () => {
  const raw = {
    database: 'test_db',
    tables: [
      {
        name: 'users',
        engine: 'InnoDB',
        columns: [
          { name: 'id', type: 'INT', nullable: 'NO', extra: 'auto_increment' },
          { name: 'email', type: 'VARCHAR(255)', nullable: false, default: 'test@example.com' },
          { name: 'bio', type: 'TEXT', nullable: true, default: null }
        ],
        indexes: [
          { name: 'PRIMARY', isPrimary: true, columns: ['id'] },
          { name: 'idx_email', isUnique: true, columns: [{ name: 'email', order: 'ASC' }] }
        ],
        foreignKeys: []
      }
    ]
  };

  const normalized = SchemaDiff.normalizeSchemaSnapshot(raw);
  assert.equal(normalized.database, 'test_db');
  assert.equal(normalized.tables.length, 1);

  const table = normalized.tables[0];
  assert.equal(table.name, 'users');
  assert.equal(table.columns.length, 3);
  assert.equal(table.columns[0].isAutoIncrement, true);
  assert.equal(table.columns[0].nullable, false);
  assert.equal(table.columns[1].default, 'test@example.com');
  assert.equal(table.columns[2].nullable, true);
  assert.equal(table.indexes.length, 2);
  assert.equal(table.indexes[0].isPrimary, true);
  assert.equal(table.indexes[1].isUnique, true);
});

test('compareSchemas returns zero changes for identical schemas', () => {
  const schema = {
    database: 'production',
    tables: [
      {
        name: 'orders',
        columns: [
          { name: 'id', type: 'int', nullable: false, extra: 'auto_increment' },
          { name: 'total', type: 'decimal(10,2)', nullable: false, default: '0.00' }
        ],
        indexes: [{ name: 'PRIMARY', isPrimary: true, columns: ['id'] }]
      }
    ]
  };

  const diff = SchemaDiff.compareSchemas(schema, schema);
  assert.equal(diff.summary.totalChanges, 0);
  assert.equal(diff.tables.added.length, 0);
  assert.equal(diff.tables.dropped.length, 0);
  assert.equal(diff.tables.modified.length, 0);
});

test('compareSchemas detects added and dropped tables', () => {
  const source = {
    database: 'staging',
    tables: [
      {
        name: 'customers',
        columns: [{ name: 'id', type: 'int', nullable: false }]
      },
      {
        name: 'products',
        columns: [{ name: 'id', type: 'int', nullable: false }]
      }
    ]
  };

  const target = {
    database: 'production',
    tables: [
      {
        name: 'customers',
        columns: [{ name: 'id', type: 'int', nullable: false }]
      },
      {
        name: 'legacy_data',
        columns: [{ name: 'id', type: 'int', nullable: false }]
      }
    ]
  };

  const diff = SchemaDiff.compareSchemas(source, target);
  assert.equal(diff.tables.added.length, 1);
  assert.equal(diff.tables.added[0].name, 'products');
  assert.equal(diff.tables.dropped.length, 1);
  assert.equal(diff.tables.dropped[0].name, 'legacy_data');
  assert.equal(diff.summary.safeCount, 1); // added table
  assert.equal(diff.summary.destructiveCount, 1); // dropped table
});

test('compareSchemas detects column additions, modifications and removals', () => {
  const target = {
    database: 'db',
    tables: [
      {
        name: 'users',
        columns: [
          { name: 'id', type: 'int', nullable: false },
          { name: 'name', type: 'varchar(50)', nullable: true },
          { name: 'deprecated_col', type: 'text', nullable: true }
        ]
      }
    ]
  };

  const source = {
    database: 'db',
    tables: [
      {
        name: 'users',
        columns: [
          { name: 'id', type: 'int', nullable: false },
          { name: 'name', type: 'varchar(100)', nullable: false }, // modified: length & nullability
          { name: 'age', type: 'int', nullable: true, default: '18' } // added
        ]
      }
    ]
  };

  const diff = SchemaDiff.compareSchemas(source, target);
  assert.equal(diff.tables.modified.length, 1);
  const tblMod = diff.tables.modified[0];

  assert.equal(tblMod.columns.added.length, 1);
  assert.equal(tblMod.columns.added[0].name, 'age');

  assert.equal(tblMod.columns.dropped.length, 1);
  assert.equal(tblMod.columns.dropped[0].name, 'deprecated_col');

  assert.equal(tblMod.columns.modified.length, 1);
  assert.equal(tblMod.columns.modified[0].name, 'name');
  assert.ok(tblMod.columns.modified[0].changes.includes('type'));
  assert.ok(tblMod.columns.modified[0].changes.includes('nullable'));
});

test('compareSchemas detects index and foreign key changes', () => {
  const target = {
    database: 'db',
    tables: [
      {
        name: 'orders',
        columns: [
          { name: 'id', type: 'int', nullable: false },
          { name: 'user_id', type: 'int', nullable: false }
        ],
        indexes: [
          { name: 'PRIMARY', isPrimary: true, columns: ['id'] },
          { name: 'idx_old', isUnique: false, columns: ['user_id'] }
        ],
        foreignKeys: []
      }
    ]
  };

  const source = {
    database: 'db',
    tables: [
      {
        name: 'orders',
        columns: [
          { name: 'id', type: 'int', nullable: false },
          { name: 'user_id', type: 'int', nullable: false }
        ],
        indexes: [
          { name: 'PRIMARY', isPrimary: true, columns: ['id'] },
          { name: 'idx_user_id', isUnique: false, columns: ['user_id'] }
        ],
        foreignKeys: [
          {
            name: 'fk_orders_user',
            columns: ['user_id'],
            referencedTable: 'users',
            referencedColumns: ['id'],
            onDelete: 'CASCADE'
          }
        ]
      }
    ]
  };

  const diff = SchemaDiff.compareSchemas(source, target);
  const tblMod = diff.tables.modified[0];

  assert.equal(tblMod.indexes.dropped.length, 1);
  assert.equal(tblMod.indexes.dropped[0].name, 'idx_old');
  assert.equal(tblMod.indexes.added.length, 1);
  assert.equal(tblMod.indexes.added[0].name, 'idx_user_id');

  assert.equal(tblMod.foreignKeys.added.length, 1);
  assert.equal(tblMod.foreignKeys.added[0].name, 'fk_orders_user');
  assert.equal(tblMod.foreignKeys.added[0].onDelete, 'CASCADE');
});

test('generateMigrationSql creates statements with topological ordering and safe defaults', () => {
  const target = {
    database: 'db',
    tables: [
      {
        name: 'items',
        columns: [
          { name: 'id', type: 'int', nullable: false },
          { name: 'old_tag', type: 'varchar(20)', nullable: true }
        ],
        indexes: [{ name: 'PRIMARY', isPrimary: true, columns: ['id'] }],
        foreignKeys: []
      }
    ]
  };

  const source = {
    database: 'db',
    tables: [
      {
        name: 'categories',
        columns: [
          { name: 'id', type: 'int', nullable: false },
          { name: 'name', type: 'varchar(50)', nullable: false }
        ],
        indexes: [{ name: 'PRIMARY', isPrimary: true, columns: ['id'] }],
        foreignKeys: []
      },
      {
        name: 'items',
        columns: [
          { name: 'id', type: 'int', nullable: false },
          { name: 'category_id', type: 'int', nullable: false }
        ],
        indexes: [{ name: 'PRIMARY', isPrimary: true, columns: ['id'] }],
        foreignKeys: [
          {
            name: 'fk_items_category',
            columns: ['category_id'],
            referencedTable: 'categories',
            referencedColumns: ['id'],
            onDelete: 'CASCADE'
          }
        ]
      }
    ]
  };

  const diff = SchemaDiff.compareSchemas(source, target);
  const statements = SchemaDiff.generateMigrationSql(diff, { allowDropColumns: false });

  // Verify that categories (new table) is created BEFORE the foreign key is added to items
  const createCategoryIdx = statements.findIndex((s) => s.type === 'CREATE_TABLE' && s.table === 'categories');
  const addFkIdx = statements.findIndex((s) => s.type === 'ADD_FK' && s.table === 'items');
  assert.ok(createCategoryIdx >= 0);
  assert.ok(addFkIdx >= 0);
  assert.ok(createCategoryIdx < addFkIdx, 'CREATE_TABLE categories must precede ADD_FK items');

  // Verify DROP COLUMN is disabled by default for safety
  const dropColStmt = statements.find((s) => s.type === 'DROP_COLUMN');
  assert.ok(dropColStmt);
  assert.equal(dropColStmt.enabled, false);
  assert.equal(dropColStmt.severity, 'destructive');

  // Verify ADD COLUMN
  const addColStmt = statements.find((s) => s.type === 'ADD_COLUMN' && s.table === 'items');
  assert.ok(addColStmt);
  assert.match(addColStmt.sql, /ALTER TABLE `items` ADD COLUMN `category_id` INT NOT NULL/);
});

test('formatMigrationScript generates clean script with foreign key checks wrappers', () => {
  const statements = [
    {
      id: 'stmt-1',
      sql: 'CREATE TABLE `posts` (`id` INT NOT NULL PRIMARY KEY);',
      enabled: true,
      severity: 'safe'
    },
    {
      id: 'stmt-2',
      sql: 'ALTER TABLE `posts` DROP COLUMN `secret`;',
      enabled: false, // disabled statement should be skipped
      severity: 'destructive',
      warning: 'Data loss'
    }
  ];

  const script = SchemaDiff.formatMigrationScript(statements, {
    sourceName: 'Staging',
    targetName: 'Production',
    wrapForeignKeys: true
  });

  assert.match(script, /SqlPro Schema Migration Script/);
  assert.match(script, /SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0;/);
  assert.match(script, /CREATE TABLE `posts`/);
  assert.ok(!script.includes('DROP COLUMN `secret`'), 'Disabled statements should not appear in final output');
  assert.match(script, /SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;/);
});
