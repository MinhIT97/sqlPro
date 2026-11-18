'use strict';

const crypto = require('node:crypto');
const SchemaDiff = require('../schema-diff.js');

const ALLOWLIST_STATEMENT_TYPES = Object.freeze(['CREATE_TABLE', 'ADD_COLUMN', 'ADD_INDEX']);

const DEFAULT_GENERATOR_OPTIONS = Object.freeze({
  maxStatements: 500,
  maxPlanBytes: 1024 * 1024,
  defaultTtlMs: 5 * 60 * 1000
});

const error = (code, message) => Object.assign(new Error(message), { code });

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function inspectSnapshotMetadata(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return 'INVALID_SNAPSHOT';
  if (snapshot.coverage !== 'complete') return 'SCHEMA_COVERAGE_INCOMPLETE';
  if (!['MySQL', 'MariaDB'].includes(snapshot.engine)) return 'ENGINE_UNSUPPORTED';
  if (['views', 'routines', 'triggers', 'events'].some(kind => Array.isArray(snapshot[kind]) && snapshot[kind].length)) {
    return 'OBJECT_DEPENDENCY_REVIEW_REQUIRED';
  }
  const blocked = item => !item || typeof item !== 'object' || item.status === 'unknown'
    || item.coverageStatus === 'unknown' || item.migrationStatus === 'blocked';

  if (!Array.isArray(snapshot.tables)) return 'TABLE_METADATA_INCOMPLETE';
  for (const table of snapshot.tables) {
    if (blocked(table) || table.foreignKeysStatus === 'unknown'
        || !Array.isArray(table.columns) || !table.columns.length
        || !Array.isArray(table.indexes) || !Array.isArray(table.foreignKeys)) {
      return 'TABLE_METADATA_INCOMPLETE';
    }
    if (table.foreignKeys.length) return 'FOREIGN_KEY_DEPENDENCY_REVIEW_REQUIRED';
    for (const column of table.columns) {
      if (blocked(column)) return column.migrationBlockReason || 'COLUMN_METADATA_INCOMPLETE';
      if (column.isGenerated || column.generationExpression || /generated|virtual|stored|persistent/i.test(column.extra || '')) {
        return 'COLUMN_EXPRESSION_UNSUPPORTED';
      }
    }
    for (const index of table.indexes) {
      if (blocked(index)) return index.migrationBlockReason || 'INDEX_METADATA_INCOMPLETE';
      if (!Array.isArray(index.columns) || !index.columns.length || index.columns.some(col =>
        !col || typeof col !== 'object' || !col.name || col.expression || col.subPart || col.direction === 'DESC')) {
        return 'INDEX_DEFINITION_UNSUPPORTED';
      }
      if (index.visibilityKind === 'mysql-visible' && index.visibility !== 'YES'
          || index.visibilityKind === 'mariadb-ignored' && index.visibility !== 'NO') {
        return 'INDEX_VISIBILITY_UNSUPPORTED';
      }
    }
  }
  return null;
}

function formatAddIndexSql(tableName, index) {
  const colList = index.columns.map(c => {
    let part = SchemaDiff.escapeIdentifier(c.name);
    if (c.length) part += `(${c.length})`;
    if (c.order === 'DESC') part += ' DESC';
    return part;
  }).join(', ');
  const escapedTable = SchemaDiff.escapeIdentifier(tableName);
  const escapedIndex = SchemaDiff.escapeIdentifier(index.name);
  if (index.isPrimary) {
    return `ALTER TABLE ${escapedTable} ADD PRIMARY KEY (${colList});`;
  }
  const type = (index.type || '').toUpperCase();
  if (type === 'FULLTEXT') {
    return `ALTER TABLE ${escapedTable} ADD FULLTEXT KEY ${escapedIndex} (${colList});`;
  }
  if (type === 'SPATIAL') {
    return `ALTER TABLE ${escapedTable} ADD SPATIAL KEY ${escapedIndex} (${colList});`;
  }
  if (index.isUnique) {
    return `ALTER TABLE ${escapedTable} ADD UNIQUE KEY ${escapedIndex} (${colList});`;
  }
  return `ALTER TABLE ${escapedTable} ADD KEY ${escapedIndex} (${colList});`;
}

class SchemaMigrationGenerator {
  constructor(options = {}) {
    this.options = { ...DEFAULT_GENERATOR_OPTIONS, ...options };
  }

  generateMigrationPlan({ sourceSnapshot, targetSnapshot, options = {} } = {}) {
    if (!sourceSnapshot || typeof sourceSnapshot !== 'object' || !targetSnapshot || typeof targetSnapshot !== 'object') {
      throw error('INVALID_SNAPSHOT', 'Snapshot nguồn và đích bắt buộc phải được cung cấp.');
    }
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw error('INVALID_PLAN_OPTIONS', 'Tùy chọn migration không hợp lệ.');
    }

    let blockReason = inspectSnapshotMetadata(sourceSnapshot) || inspectSnapshotMetadata(targetSnapshot);
    if (!blockReason) {
      if (sourceSnapshot.scope?.profileId === targetSnapshot.scope?.profileId && sourceSnapshot.database === targetSnapshot.database) {
        blockReason = 'SAME_DATABASE';
      } else if (sourceSnapshot.engine !== targetSnapshot.engine) {
        blockReason = 'CROSS_ENGINE_MIGRATION_UNSUPPORTED';
      } else if (options.wrapForeignKeys === true) {
        blockReason = 'FOREIGN_KEY_CHECKS_OVERRIDE_UNSUPPORTED';
      }
    }

    if (blockReason) {
      return freeze({
        status: 'blocked',
        blockReason,
        applySupported: false,
        applyBlockReason: blockReason,
        statements: [],
        summary: { total: 0, executable: 0, blocked: 0 }
      });
    }

    const diff = SchemaDiff.compareSchemas(sourceSnapshot, targetSnapshot, {
      ignoreComments: options.ignoreComments === true,
      ignoreCollation: options.ignoreCollation === true
    });

    // Check for blocked object dependencies: views, routines, triggers, events
    if (['views', 'routines', 'triggers', 'events'].some(kind =>
      diff[kind]?.added?.length || diff[kind]?.dropped?.length || diff[kind]?.modified?.length)) {
      return freeze({
        status: 'blocked',
        blockReason: 'OBJECT_DEPENDENCY_REVIEW_REQUIRED',
        applySupported: false,
        applyBlockReason: 'OBJECT_DEPENDENCY_REVIEW_REQUIRED',
        statements: [],
        summary: { total: 0, executable: 0, blocked: 0 }
      });
    }

    // Check for dropped tables (destructive)
    if (diff.tables?.dropped?.length) {
      return freeze({
        status: 'blocked',
        blockReason: 'DESTRUCTIVE_DDL_BLOCKED',
        applySupported: false,
        applyBlockReason: 'DESTRUCTIVE_DDL_BLOCKED',
        statements: [],
        summary: { total: 0, executable: 0, blocked: 0 }
      });
    }

    const targetDatabase = targetSnapshot.database;
    const statements = [];
    let statementIndex = 0;

    // 1. Process added tables (CREATE TABLE)
    for (const newTable of diff.tables?.added || []) {
      if (newTable.foreignKeys && newTable.foreignKeys.length > 0) {
        blockReason = 'FOREIGN_KEY_DEPENDENCY_REVIEW_REQUIRED';
        break;
      }
      for (const column of newTable.columns || []) {
        if (column.isGenerated || column.generationExpression || /generated|virtual|stored|persistent/i.test(column.extra || '')) {
          blockReason = 'COLUMN_EXPRESSION_UNSUPPORTED';
          break;
        }
      }
      if (blockReason) break;

      for (const index of newTable.indexes || []) {
        if (index.columns && index.columns.some(c => c.expression || c.subPart || c.direction === 'DESC')) {
          blockReason = 'INDEX_DEFINITION_UNSUPPORTED';
          break;
        }
      }
      if (blockReason) break;

      statementIndex++;
      const sql = SchemaDiff.formatCreateTableSql(newTable, { includeForeignKeys: false });
      statements.push({
        id: `stmt_${statementIndex}`,
        type: 'CREATE_TABLE',
        table: newTable.name,
        sql,
        severity: 'safe',
        status: 'executable',
        enabled: true,
        preCondition: {
          type: 'TABLE_NOT_EXISTS',
          table: newTable.name,
          checkSql: 'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
          params: [targetDatabase, newTable.name],
          expectedCount: 0
        },
        postCondition: {
          type: 'TABLE_EXISTS',
          table: newTable.name,
          checkSql: 'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
          params: [targetDatabase, newTable.name],
          expectedCount: 1
        }
      });
    }

    // 2. Process modified tables
    if (!blockReason) {
      for (const tableDiff of diff.tables?.modified || []) {
        const tblName = tableDiff.name;

        // Disallow dropped columns
        if (tableDiff.columns?.dropped?.length) {
          blockReason = 'DESTRUCTIVE_DDL_BLOCKED';
          break;
        }
        // Disallow modified column types
        if (tableDiff.columns?.modified?.length) {
          blockReason = 'TYPE_MUTATION_REVIEW_REQUIRED';
          break;
        }
        // Disallow dropped indexes
        if (tableDiff.indexes?.dropped?.length) {
          blockReason = 'DESTRUCTIVE_DDL_BLOCKED';
          break;
        }
        // Disallow modified indexes
        if (tableDiff.indexes?.modified?.length) {
          blockReason = 'INDEX_MUTATION_REVIEW_REQUIRED';
          break;
        }
        // Disallow foreign keys
        if (tableDiff.foreignKeys?.added?.length || tableDiff.foreignKeys?.dropped?.length || tableDiff.foreignKeys?.modified?.length) {
          blockReason = 'FOREIGN_KEY_DEPENDENCY_REVIEW_REQUIRED';
          break;
        }
        // Disallow engine or attribute mutation
        if (tableDiff.attributes?.engine) {
          blockReason = 'ENGINE_MUTATION_REVIEW_REQUIRED';
          break;
        }

        // 2.1 Add columns
        for (const newCol of tableDiff.columns?.added || []) {
          if (newCol.isGenerated || newCol.generationExpression || /generated|virtual|stored|persistent/i.test(newCol.extra || '')) {
            blockReason = 'COLUMN_EXPRESSION_UNSUPPORTED';
            break;
          }
          if (!newCol.nullable && (newCol.default === null || newCol.default === undefined) && !newCol.isAutoIncrement) {
            blockReason = 'UNSAFE_COLUMN_ADD_REVIEW_REQUIRED';
            break;
          }

          statementIndex++;
          const sql = `ALTER TABLE ${SchemaDiff.escapeIdentifier(tblName)} ADD COLUMN ${SchemaDiff.formatColumnClause(newCol)};`;
          statements.push({
            id: `stmt_${statementIndex}`,
            type: 'ADD_COLUMN',
            table: tblName,
            column: newCol.name,
            sql,
            severity: 'safe',
            status: 'executable',
            enabled: true,
            preCondition: {
              type: 'COLUMN_NOT_EXISTS',
              table: tblName,
              column: newCol.name,
              checkSql: 'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?',
              params: [targetDatabase, tblName, newCol.name],
              expectedCount: 0
            },
            postCondition: {
              type: 'COLUMN_EXISTS',
              table: tblName,
              column: newCol.name,
              checkSql: 'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?',
              params: [targetDatabase, tblName, newCol.name],
              expectedCount: 1
            }
          });
        }
        if (blockReason) break;

        // 2.2 Add indexes
        for (const newIdx of tableDiff.indexes?.added || []) {
          if (newIdx.columns && newIdx.columns.some(c => c.expression || c.subPart || c.direction === 'DESC')) {
            blockReason = 'INDEX_DEFINITION_UNSUPPORTED';
            break;
          }

          statementIndex++;
          const sql = formatAddIndexSql(tblName, newIdx);
          statements.push({
            id: `stmt_${statementIndex}`,
            type: 'ADD_INDEX',
            table: tblName,
            index: newIdx.name,
            sql,
            severity: 'safe',
            status: 'executable',
            enabled: true,
            preCondition: {
              type: 'INDEX_NOT_EXISTS',
              table: tblName,
              index: newIdx.name,
              checkSql: 'SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?',
              params: [targetDatabase, tblName, newIdx.name],
              expectedCount: 0
            },
            postCondition: {
              type: 'INDEX_EXISTS',
              table: tblName,
              index: newIdx.name,
              indexType: (newIdx.type || (newIdx.isPrimary ? 'PRIMARY' : 'BTREE')).toUpperCase(),
              checkSql: (newIdx.type === 'FULLTEXT' || newIdx.type === 'SPATIAL')
                ? 'SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? AND UPPER(INDEX_TYPE) = ?'
                : 'SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?',
              params: (newIdx.type === 'FULLTEXT' || newIdx.type === 'SPATIAL')
                ? [targetDatabase, tblName, newIdx.name, newIdx.type.toUpperCase()]
                : [targetDatabase, tblName, newIdx.name],
              expectedCount: 1
            }
          });
        }
        if (blockReason) break;
      }
    }

    if (blockReason) {
      return freeze({
        status: 'blocked',
        blockReason,
        applySupported: false,
        applyBlockReason: blockReason,
        statements: statements.map(s => ({ ...s, status: 'blocked', enabled: false })),
        summary: { total: statements.length, executable: 0, blocked: statements.length }
      });
    }

    // Check statement quota
    if (statements.length > this.options.maxStatements || Buffer.byteLength(JSON.stringify(statements)) > this.options.maxPlanBytes) {
      return freeze({
        status: 'blocked',
        blockReason: 'MIGRATION_PLAN_QUOTA_EXCEEDED',
        applySupported: false,
        applyBlockReason: 'MIGRATION_PLAN_QUOTA_EXCEEDED',
        statements: [],
        summary: { total: 0, executable: 0, blocked: 0 }
      });
    }

    return freeze({
      status: 'ready',
      blockReason: null,
      applySupported: true,
      applyBlockReason: null,
      statements,
      summary: { total: statements.length, executable: statements.length, blocked: 0 }
    });
  }

  generateCandidatePlan({ sourceSnapshot, targetSnapshot, options = {}, ttlMs } = {}) {
    const planResult = this.generateMigrationPlan({ sourceSnapshot, targetSnapshot, options });
    const now = Date.now();
    const effectiveTtl = Number.isSafeInteger(ttlMs) && ttlMs > 0 ? ttlMs : this.options.defaultTtlMs;
    const planToken = crypto.randomBytes(32).toString('hex');
    const planId = `plan_${crypto.randomBytes(16).toString('hex')}`;

    return freeze({
      planId,
      planToken,
      sourceSnapshotId: options.sourceSnapshotId || null,
      targetSnapshotId: options.targetSnapshotId || null,
      sourceScope: { ...structuredClone(sourceSnapshot.scope), snapshotIdentity: sourceSnapshot.snapshotIdentity },
      targetScope: { ...structuredClone(targetSnapshot.scope), snapshotIdentity: targetSnapshot.snapshotIdentity },
      options: structuredClone(options),
      statements: structuredClone(planResult.statements),
      status: planResult.status,
      blockReason: planResult.blockReason,
      applySupported: planResult.applySupported,
      applyBlockReason: planResult.applyBlockReason,
      summary: structuredClone(planResult.summary),
      createdAt: new Date(now).toISOString(),
      expiresAt: now + effectiveTtl
    });
  }
}

function generateSafeMigrationPlan({ sourceSnapshot, targetSnapshot, options = {} } = {}) {
  const generator = new SchemaMigrationGenerator();
  return generator.generateMigrationPlan({ sourceSnapshot, targetSnapshot, options });
}

module.exports = {
  SchemaMigrationGenerator,
  generateSafeMigrationPlan,
  inspectSnapshotMetadata,
  ALLOWLIST_STATEMENT_TYPES,
  DEFAULT_GENERATOR_OPTIONS
};
