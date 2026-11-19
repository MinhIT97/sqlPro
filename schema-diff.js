/**
 * Schema Diff & Migration Generator Module
 *
 * Implements pure schema comparison and safe DDL migration generation
 * for MySQL and MariaDB databases.
 *
 * Architecture:
 * - Pure Universal Module Definition (UMD)
 * - Zero DOM / Electron / Database dependencies
 * - Topologically sorted migration execution order
 * - Explicit safety classifications (safe, warning, destructive)
 */
(function (root, factory) {
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    root.SchemaDiff = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function escapeIdentifier(identifier) {
    if (typeof identifier !== 'string') return '';
    return '`' + identifier.replace(/`/g, '``') + '`';
  }

  function deepClone(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    return JSON.parse(JSON.stringify(obj));
  }

  // Change SQL keywords without touching quoted ENUM/SET members or escapes.
  function normalizeColumnType(type, upper = false) {
    const value = String(type).trim();
    let output = '', quote = null;
    for (let i = 0; i < value.length; i++) {
      const char = value[i];
      if (quote) {
        output += char;
        if (char === '\\' && i + 1 < value.length) output += value[++i];
        else if (char === quote) {
          if (value[i + 1] === quote) output += value[++i];
          else quote = null;
        }
      } else if (["'", '"', '`'].includes(char)) { quote = char; output += char; }
      else output += upper ? char.toUpperCase() : char.toLowerCase();
    }
    return output;
  }

  /**
   * Normalizes a column definition into a canonical form
   */
  function normalizeColumn(col, dialect = 'MySQL') {
    if (!col || typeof col !== 'object') return null;
    const name = String(col.name || '').trim();
    if (!name) return null;

    const type = normalizeColumnType(col.type || col.dataType || 'varchar(255)');
    const nullable = col.nullable === true || col.nullable === 'YES' || col.isNullable === true || col.isNullable === 'YES';
    
    let defaultValue = col.defaultValue !== undefined ? col.defaultValue : col.default;
    if (defaultValue === null || dialect === 'MariaDB' && defaultValue === 'NULL') {
      defaultValue = null;
    } else if (defaultValue !== undefined) {
      defaultValue = String(defaultValue);
    }

    const extra = String(col.extra || '').trim().toLowerCase();
    const isAutoIncrement = extra.includes('auto_increment') || Boolean(col.autoIncrement || col.isAutoIncrement);
    const comment = String(col.comment || '');
    const charset = col.charset ? String(col.charset).trim().toLowerCase() : null;
    const collation = col.collation ? String(col.collation).trim().toLowerCase() : null;

    return {
      name,
      type,
      nullable,
      default: defaultValue,
      isAutoIncrement,
      extra,
      comment,
      charset,
      collation
    };
  }

  /**
   * Normalizes an index definition
   */
  function normalizeIndex(idx) {
    if (!idx || typeof idx !== 'object') return null;
    const name = String(idx.name || '').trim();
    if (!name) return null;

    const isPrimary = name.toUpperCase() === 'PRIMARY' || Boolean(idx.isPrimary);
    const isUnique = isPrimary || Boolean(idx.isUnique) || idx.nonUnique === 0 || idx.nonUnique === false;
    const type = String(idx.type || idx.indexType || 'BTREE').trim().toUpperCase();

    let columns = [];
    if (Array.isArray(idx.columns)) {
      columns = idx.columns.map((c) => {
        if (typeof c === 'string') return { name: c.trim(), order: 'ASC', length: null };
        if (c && typeof c === 'object') {
          return {
            name: String(c.name || '').trim(),
            order: String(c.order || 'ASC').toUpperCase(),
            length: c.length ? parseInt(c.length, 10) : null
          };
        }
        return null;
      }).filter((c) => c && c.name);
    }

    if (!columns.length) return null;

    return {
      name: isPrimary ? 'PRIMARY' : name,
      isPrimary,
      isUnique,
      type,
      columns
    };
  }

  /**
   * Normalizes a foreign key constraint definition
   */
  function normalizeForeignKey(fk) {
    if (!fk || typeof fk !== 'object') return null;
    const name = String(fk.name || fk.constraintName || '').trim();
    const referencedTable = String(fk.referencedTable || fk.referencedTableName || '').trim();
    if (!referencedTable) return null;

    let columns = [];
    if (Array.isArray(fk.columns)) {
      columns = fk.columns.map((c) => String(c).trim()).filter(Boolean);
    } else if (typeof fk.column === 'string') {
      columns = [fk.column.trim()];
    }

    let referencedColumns = [];
    if (Array.isArray(fk.referencedColumns)) {
      referencedColumns = fk.referencedColumns.map((c) => String(c).trim()).filter(Boolean);
    } else if (typeof fk.referencedColumn === 'string') {
      referencedColumns = [fk.referencedColumn.trim()];
    }

    if (!columns.length || columns.length !== referencedColumns.length) return null;

    const onDelete = String(fk.onDelete || 'RESTRICT').trim().toUpperCase();
    const onUpdate = String(fk.onUpdate || 'RESTRICT').trim().toUpperCase();

    return {
      name: name || `fk_${columns.join('_')}`,
      columns,
      referencedTable,
      referencedColumns,
      onDelete: ['CASCADE', 'SET NULL', 'NO ACTION', 'RESTRICT'].includes(onDelete) ? onDelete : 'RESTRICT',
      onUpdate: ['CASCADE', 'SET NULL', 'NO ACTION', 'RESTRICT'].includes(onUpdate) ? onUpdate : 'RESTRICT'
    };
  }

  /**
   * Normalizes a table definition
   */
  function normalizeTable(tbl, dialect = 'MySQL') {
    if (!tbl || typeof tbl !== 'object') return null;
    const name = String(tbl.name || tbl.tableName || '').trim();
    if (!name) return null;

    const engine = String(tbl.engine || 'InnoDB').trim();
    const charset = tbl.charset ? String(tbl.charset).trim().toLowerCase() : null;
    const collation = tbl.collation ? String(tbl.collation).trim().toLowerCase() : null;
    const comment = String(tbl.comment || '');

    const columns = [];
    const colMap = new Map();
    for (const c of Array.isArray(tbl.columns) ? tbl.columns : []) {
      const col = normalizeColumn(c, dialect);
      if (col && !colMap.has(col.name)) {
        colMap.set(col.name, col);
        columns.push(col);
      }
    }

    const indexes = [];
    const idxMap = new Map();
    for (const i of Array.isArray(tbl.indexes) ? tbl.indexes : []) {
      const idx = normalizeIndex(i);
      if (idx && !idxMap.has(idx.name)) {
        idxMap.set(idx.name, idx);
        indexes.push(idx);
      }
    }

    const foreignKeys = [];
    const fkMap = new Map();
    for (const f of Array.isArray(tbl.foreignKeys) ? tbl.foreignKeys : []) {
      const fk = normalizeForeignKey(f);
      if (fk && !fkMap.has(fk.name)) {
        fkMap.set(fk.name, fk);
        foreignKeys.push(fk);
      }
    }

    return {
      name,
      engine,
      charset,
      collation,
      comment,
      columns,
      indexes,
      foreignKeys
    };
  }

  /**
   * Normalizes an entire database schema snapshot
   */
  function normalizeSchemaSnapshot(raw) {
    if (!raw || typeof raw !== 'object') {
      return {
        database: '',
        engine: 'MySQL',
        tables: [],
        views: [],
        routines: [],
        triggers: [],
        events: []
      };
    }

    const database = String(raw.database || '').trim();
    const engine = String(raw.engine || 'MySQL').trim();

    const tables = [];
    const tableMap = new Map();
    for (const t of Array.isArray(raw.tables) ? raw.tables : []) {
      const tbl = normalizeTable(t, engine);
      if (tbl && !tableMap.has(tbl.name)) {
        tableMap.set(tbl.name, tbl);
        tables.push(tbl);
      }
    }

    const views = [];
    for (const v of Array.isArray(raw.views) ? raw.views : []) {
      if (v && v.name) {
        views.push({
          name: String(v.name).trim(),
          definition: String(v.definition || '').trim()
        });
      }
    }

    const routines = [];
    for (const r of Array.isArray(raw.routines) ? raw.routines : []) {
      if (r && r.name) {
        routines.push({
          name: String(r.name).trim(),
          type: String(r.type || 'PROCEDURE').toUpperCase(),
          sql: String(r.sql || r.definition || '').trim()
        });
      }
    }

    const triggers = [];
    for (const tr of Array.isArray(raw.triggers) ? raw.triggers : []) {
      if (tr && tr.name) {
        triggers.push({
          name: String(tr.name).trim(),
          table: String(tr.table || '').trim(),
          timing: String(tr.timing || 'BEFORE').toUpperCase(),
          event: String(tr.event || 'INSERT').toUpperCase(),
          statement: String(tr.statement || '').trim()
        });
      }
    }

    const events = [];
    for (const ev of Array.isArray(raw.events) ? raw.events : []) {
      if (ev && ev.name) {
        events.push({
          name: String(ev.name).trim(),
          status: String(ev.status || 'ENABLED').toUpperCase(),
          statement: String(ev.statement || '').trim()
        });
      }
    }

    return {
      database,
      engine,
      tables,
      views,
      routines,
      triggers,
      events
    };
  }

  /**
   * Compares two columns and identifies specific attribute differences
   */
  function compareColumns(srcCol, tgtCol, options = {}) {
    const changes = [];

    // Compare data types
    if (srcCol.type !== tgtCol.type) {
      changes.push('type');
    }

    // Compare nullability
    if (srcCol.nullable !== tgtCol.nullable) {
      changes.push('nullable');
    }

    // Compare defaults
    if (srcCol.default !== tgtCol.default) {
      changes.push('default');
    }

    // Compare auto increment
    if (!options.ignoreAutoIncrement && srcCol.isAutoIncrement !== tgtCol.isAutoIncrement) {
      changes.push('auto_increment');
    }

    // Compare comment
    if (!options.ignoreComments && srcCol.comment !== tgtCol.comment) {
      changes.push('comment');
    }

    // Compare collation
    if (!options.ignoreCollation && srcCol.collation && tgtCol.collation && srcCol.collation !== tgtCol.collation) {
      changes.push('collation');
    }

    return changes;
  }

  /**
   * Compares two indexes
   */
  function compareIndexes(srcIdx, tgtIdx) {
    if (srcIdx.isUnique !== tgtIdx.isUnique) return true;
    if (srcIdx.type !== tgtIdx.type) return true;
    if (srcIdx.columns.length !== tgtIdx.columns.length) return true;

    for (let i = 0; i < srcIdx.columns.length; i++) {
      const sc = srcIdx.columns[i];
      const tc = tgtIdx.columns[i];
      if (sc.name !== tc.name) return true;
      if (sc.order !== tc.order) return true;
      if (sc.length !== tc.length) return true;
    }

    return false;
  }

  /**
   * Compares two foreign keys
   */
  function compareForeignKeys(srcFk, tgtFk) {
    if (srcFk.referencedTable !== tgtFk.referencedTable) return true;
    if (srcFk.onDelete !== tgtFk.onDelete) return true;
    if (srcFk.onUpdate !== tgtFk.onUpdate) return true;
    if (srcFk.columns.length !== tgtFk.columns.length) return true;

    for (let i = 0; i < srcFk.columns.length; i++) {
      if (srcFk.columns[i] !== tgtFk.columns[i]) return true;
      if (srcFk.referencedColumns[i] !== tgtFk.referencedColumns[i]) return true;
    }

    return false;
  }

  /**
   * Compares two schema snapshots: source (desired state) vs target (current state)
   *
   * @param {Object} sourceSnapshot Desired schema
   * @param {Object} targetSnapshot Current schema
   * @param {Object} options Configuration flags
   * @returns {Object} Structured diff report
   */
  function compareSchemas(sourceSnapshot, targetSnapshot, options = {}) {
    const source = normalizeSchemaSnapshot(sourceSnapshot);
    const target = normalizeSchemaSnapshot(targetSnapshot);

    const diff = {
      sourceDatabase: source.database,
      targetDatabase: target.database,
      tables: {
        added: [],
        dropped: [],
        modified: []
      },
      views: {
        added: [],
        dropped: [],
        modified: []
      },
      routines: {
        added: [],
        dropped: [],
        modified: []
      },
      triggers: {
        added: [],
        dropped: [],
        modified: []
      },
      events: {
        added: [],
        dropped: [],
        modified: []
      },
      summary: {
        totalChanges: 0,
        safeCount: 0,
        warningCount: 0,
        destructiveCount: 0
      }
    };

    const targetTableMap = new Map();
    for (const t of target.tables) {
      targetTableMap.set(t.name, t);
    }

    const sourceTableMap = new Map();
    for (const t of source.tables) {
      sourceTableMap.set(t.name, t);
    }

    // 1. Check added tables (in source, not in target)
    for (const srcTable of source.tables) {
      const tgtTable = targetTableMap.get(srcTable.name);
      if (!tgtTable) {
        diff.tables.added.push(deepClone(srcTable));
        diff.summary.safeCount++;
        diff.summary.totalChanges++;
      } else {
        // Compare table details
        const tableDiff = {
          name: srcTable.name,
          columns: {
            added: [],
            dropped: [],
            modified: []
          },
          indexes: {
            added: [],
            dropped: [],
            modified: []
          },
          foreignKeys: {
            added: [],
            dropped: [],
            modified: []
          },
          attributes: {}
        };

        let hasChanges = false;

        // Compare engine
        if (!options.ignoreEngine && srcTable.engine && tgtTable.engine && srcTable.engine.toLowerCase() !== tgtTable.engine.toLowerCase()) {
          tableDiff.attributes.engine = { from: tgtTable.engine, to: srcTable.engine };
          hasChanges = true;
          diff.summary.warningCount++;
          diff.summary.totalChanges++;
        }

        // Compare columns
        const tgtColMap = new Map();
        for (const c of tgtTable.columns) tgtColMap.set(c.name, c);

        const srcColMap = new Map();
        for (const c of srcTable.columns) srcColMap.set(c.name, c);

        for (const sc of srcTable.columns) {
          const tc = tgtColMap.get(sc.name);
          if (!tc) {
            tableDiff.columns.added.push(deepClone(sc));
            hasChanges = true;
            // Adding a NOT NULL column without a default value is a warning
            if (!sc.nullable && sc.default === null && !sc.isAutoIncrement) {
              diff.summary.warningCount++;
            } else {
              diff.summary.safeCount++;
            }
            diff.summary.totalChanges++;
          } else {
            const changes = compareColumns(sc, tc, options);
            if (changes.length > 0) {
              tableDiff.columns.modified.push({
                name: sc.name,
                from: deepClone(tc),
                to: deepClone(sc),
                changes
              });
              hasChanges = true;
              diff.summary.warningCount++;
              diff.summary.totalChanges++;
            }
          }
        }

        for (const tc of tgtTable.columns) {
          if (!srcColMap.has(tc.name)) {
            tableDiff.columns.dropped.push(deepClone(tc));
            hasChanges = true;
            diff.summary.destructiveCount++;
            diff.summary.totalChanges++;
          }
        }

        // Compare indexes
        const tgtIdxMap = new Map();
        for (const i of tgtTable.indexes) tgtIdxMap.set(i.name, i);

        const srcIdxMap = new Map();
        for (const i of srcTable.indexes) srcIdxMap.set(i.name, i);

        for (const si of srcTable.indexes) {
          const ti = tgtIdxMap.get(si.name);
          if (!ti) {
            tableDiff.indexes.added.push(deepClone(si));
            hasChanges = true;
            diff.summary.safeCount++;
            diff.summary.totalChanges++;
          } else if (compareIndexes(si, ti)) {
            tableDiff.indexes.modified.push({
              name: si.name,
              from: deepClone(ti),
              to: deepClone(si)
            });
            hasChanges = true;
            diff.summary.warningCount++;
            diff.summary.totalChanges++;
          }
        }

        for (const ti of tgtTable.indexes) {
          if (!srcIdxMap.has(ti.name)) {
            tableDiff.indexes.dropped.push(deepClone(ti));
            hasChanges = true;
            diff.summary.warningCount++;
            diff.summary.totalChanges++;
          }
        }

        // Compare foreign keys
        const tgtFkMap = new Map();
        for (const f of tgtTable.foreignKeys) tgtFkMap.set(f.name, f);

        const srcFkMap = new Map();
        for (const f of srcTable.foreignKeys) srcFkMap.set(f.name, f);

        for (const sf of srcTable.foreignKeys) {
          const tf = tgtFkMap.get(sf.name);
          if (!tf) {
            tableDiff.foreignKeys.added.push(deepClone(sf));
            hasChanges = true;
            diff.summary.safeCount++;
            diff.summary.totalChanges++;
          } else if (compareForeignKeys(sf, tf)) {
            tableDiff.foreignKeys.modified.push({
              name: sf.name,
              from: deepClone(tf),
              to: deepClone(sf)
            });
            hasChanges = true;
            diff.summary.warningCount++;
            diff.summary.totalChanges++;
          }
        }

        for (const tf of tgtTable.foreignKeys) {
          if (!srcFkMap.has(tf.name)) {
            tableDiff.foreignKeys.dropped.push(deepClone(tf));
            hasChanges = true;
            diff.summary.safeCount++;
            diff.summary.totalChanges++;
          }
        }

        if (hasChanges) {
          diff.tables.modified.push(tableDiff);
        }
      }
    }

    // 2. Check dropped tables (in target, not in source)
    for (const tgtTable of target.tables) {
      if (!sourceTableMap.has(tgtTable.name)) {
        diff.tables.dropped.push(deepClone(tgtTable));
        diff.summary.destructiveCount++;
        diff.summary.totalChanges++;
      }
    }

    // 3. Views
    const tgtViewMap = new Map(target.views.map((v) => [v.name, v]));
    const srcViewMap = new Map(source.views.map((v) => [v.name, v]));

    for (const sv of source.views) {
      const tv = tgtViewMap.get(sv.name);
      if (!tv) {
        diff.views.added.push(deepClone(sv));
        diff.summary.safeCount++;
        diff.summary.totalChanges++;
      } else if (sv.definition !== tv.definition) {
        diff.views.modified.push({ name: sv.name, from: tv.definition, to: sv.definition });
        diff.summary.warningCount++;
        diff.summary.totalChanges++;
      }
    }

    for (const tv of target.views) {
      if (!srcViewMap.has(tv.name)) {
        diff.views.dropped.push(deepClone(tv));
        diff.summary.destructiveCount++;
        diff.summary.totalChanges++;
      }
    }

    // 4. Routines (Procedures / Functions)
    const tgtRoutineMap = new Map(target.routines.map((r) => [r.name, r]));
    const srcRoutineMap = new Map(source.routines.map((r) => [r.name, r]));

    for (const sr of source.routines) {
      const tr = tgtRoutineMap.get(sr.name);
      if (!tr) {
        diff.routines.added.push(deepClone(sr));
        diff.summary.safeCount++;
        diff.summary.totalChanges++;
      } else if (sr.sql !== tr.sql) {
        diff.routines.modified.push({ name: sr.name, type: sr.type, from: tr.sql, to: sr.sql });
        diff.summary.warningCount++;
        diff.summary.totalChanges++;
      }
    }

    for (const tr of target.routines) {
      if (!srcRoutineMap.has(tr.name)) {
        diff.routines.dropped.push(deepClone(tr));
        diff.summary.destructiveCount++;
        diff.summary.totalChanges++;
      }
    }

    return diff;
  }

  /**
   * Generates a column definition clause (e.g. `col` VARCHAR(255) NOT NULL DEFAULT 'abc')
   */
  function formatColumnClause(col) {
    let sql = `${escapeIdentifier(col.name)} ${normalizeColumnType(col.type, true)}`;

    if (col.charset) {
      sql += ` CHARACTER SET ${col.charset}`;
    }
    if (col.collation) {
      sql += ` COLLATE ${col.collation}`;
    }

    if (!col.nullable) {
      sql += ' NOT NULL';
    } else {
      sql += ' NULL';
    }

    if (col.default !== null && col.default !== undefined) {
      const defUpper = String(col.default).toUpperCase();
      if (/^(?:timestamp|datetime)\b/i.test(col.type)
          && /^(?:CURRENT_TIMESTAMP(?:\([0-6]?\))?|NOW\(\))$/.test(defUpper)) {
        sql += ` DEFAULT ${col.default}`;
      } else {
        const value = String(col.default);
        // A charset-qualified hex literal keeps escapes, quotes and Unicode
        // independent of NO_BACKSLASH_ESCAPES on the destination connection.
        if (/[\\\u0000-\u001f\u007f-\uffff]/.test(value)) {
          const bytes = new TextEncoder().encode(value);
          sql += ` DEFAULT _utf8mb4 0x${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
        } else sql += ` DEFAULT '${value.replace(/'/g, "''")}'`;
      }
    } else if (col.nullable) {
      sql += ' DEFAULT NULL';
    }

    if (col.isAutoIncrement) {
      sql += ' AUTO_INCREMENT';
    }

    if (col.comment) {
      if (/[\\\x00-\x1f\x7f]/.test(col.comment)) throw new Error('COMMENT_LITERAL_UNSUPPORTED');
      sql += ` COMMENT '${col.comment.replace(/'/g, "''")}'`;
    }

    return sql;
  }

  /**
   * Generates a CREATE TABLE DDL statement
   */
  function formatCreateTableSql(table, { includeForeignKeys = true } = {}) {
    const lines = [];

    // Columns
    for (const col of table.columns) {
      lines.push('  ' + formatColumnClause(col));
    }

    // Primary Key & Indexes
    for (const idx of table.indexes) {
      const colList = idx.columns.map((c) => {
        let part = escapeIdentifier(c.name);
        if (c.length) part += `(${c.length})`;
        if (c.order === 'DESC') part += ' DESC';
        return part;
      }).join(', ');

      if (idx.isPrimary) {
        lines.push(`  PRIMARY KEY (${colList})`);
      } else if (idx.isUnique) {
        lines.push(`  UNIQUE KEY ${escapeIdentifier(idx.name)} (${colList})`);
      } else if (idx.type === 'FULLTEXT') {
        lines.push(`  FULLTEXT KEY ${escapeIdentifier(idx.name)} (${colList})`);
      } else if (idx.type === 'SPATIAL') {
        lines.push(`  SPATIAL KEY ${escapeIdentifier(idx.name)} (${colList})`);
      } else {
        lines.push(`  KEY ${escapeIdentifier(idx.name)} (${colList})`);
      }
    }

    // Foreign Keys (if requested)
    if (includeForeignKeys) {
      for (const fk of table.foreignKeys) {
        const cols = fk.columns.map(escapeIdentifier).join(', ');
        const refCols = fk.referencedColumns.map(escapeIdentifier).join(', ');
        let fkLine = `  CONSTRAINT ${escapeIdentifier(fk.name)} FOREIGN KEY (${cols}) REFERENCES ${escapeIdentifier(fk.referencedTable)} (${refCols})`;
        if (fk.onDelete && fk.onDelete !== 'RESTRICT') fkLine += ` ON DELETE ${fk.onDelete}`;
        if (fk.onUpdate && fk.onUpdate !== 'RESTRICT') fkLine += ` ON UPDATE ${fk.onUpdate}`;
        lines.push(fkLine);
      }
    }

    let sql = `CREATE TABLE ${escapeIdentifier(table.name)} (\n` + lines.join(',\n') + '\n)';

    const tableOpts = [];
    if (table.engine) tableOpts.push(`ENGINE=${table.engine}`);
    if (table.charset) tableOpts.push(`DEFAULT CHARSET=${table.charset}`);
    if (table.collation) tableOpts.push(`COLLATE=${table.collation}`);
    if (table.comment) {
      if (/[\\\x00-\x1f\x7f]/.test(table.comment)) throw new Error('COMMENT_LITERAL_UNSUPPORTED');
      tableOpts.push(`COMMENT='${table.comment.replace(/'/g, "''")}'`);
    }

    if (tableOpts.length) {
      sql += ' ' + tableOpts.join(' ');
    }

    sql += ';';
    return sql;
  }

  /**
   * Generates safe migration DDL statements from a schema diff
   *
   * @param {Object} diff The diff generated by compareSchemas
   * @param {Object} options Configuration flags
   * @returns {Array<Object>} Sorted list of migration statement objects
   */
  function generateMigrationSql(diff, options = {}) {
    const allowDropTables = Boolean(options.allowDropTables);
    const allowDropColumns = Boolean(options.allowDropColumns);
    const statements = [];
    let stmtIndex = 0;

    function addStatement({ sql, type, table, severity = 'safe', warning = null, enabled = true }) {
      stmtIndex++;
      statements.push({
        id: `stmt-${stmtIndex}`,
        sql: sql.trim(),
        type,
        table: table || null,
        severity,
        warning,
        enabled
      });
    }

    // Phase 1: Pre-drop foreign keys on tables that are being dropped or modified
    for (const tableDiff of diff.tables.modified) {
      for (const fk of tableDiff.foreignKeys.dropped) {
        addStatement({
          sql: `ALTER TABLE ${escapeIdentifier(tableDiff.name)} DROP FOREIGN KEY ${escapeIdentifier(fk.name)};`,
          type: 'DROP_FK',
          table: tableDiff.name,
          severity: 'safe',
          enabled: true
        });
      }
      for (const fkMod of tableDiff.foreignKeys.modified) {
        addStatement({
          sql: `ALTER TABLE ${escapeIdentifier(tableDiff.name)} DROP FOREIGN KEY ${escapeIdentifier(fkMod.from.name)};`,
          type: 'DROP_FK',
          table: tableDiff.name,
          severity: 'warning',
          warning: `Ràng buộc khóa ngoại ${fkMod.name} sẽ được xóa và tạo lại theo cấu trúc mới.`,
          enabled: true
        });
      }
    }

    // Phase 2: Create new tables (without foreign keys first to prevent dependency deadlocks)
    for (const newTable of diff.tables.added) {
      addStatement({
        sql: formatCreateTableSql(newTable, { includeForeignKeys: false }),
        type: 'CREATE_TABLE',
        table: newTable.name,
        severity: 'safe',
        enabled: true
      });
    }

    // Phase 3: Alter existing tables
    for (const tableDiff of diff.tables.modified) {
      const tblName = tableDiff.name;

      // 3.1 Drop indexes being modified or dropped
      for (const idx of tableDiff.indexes.dropped) {
        if (idx.isPrimary) {
          addStatement({
            sql: `ALTER TABLE ${escapeIdentifier(tblName)} DROP PRIMARY KEY;`,
            type: 'DROP_INDEX',
            table: tblName,
            severity: 'warning',
            warning: 'Xóa khóa chính (PRIMARY KEY) có thể ảnh hưởng đến hiệu năng và tính toàn vẹn dữ liệu.',
            enabled: true
          });
        } else {
          addStatement({
            sql: `ALTER TABLE ${escapeIdentifier(tblName)} DROP INDEX ${escapeIdentifier(idx.name)};`,
            type: 'DROP_INDEX',
            table: tblName,
            severity: 'safe',
            enabled: true
          });
        }
      }

      for (const idxMod of tableDiff.indexes.modified) {
        if (idxMod.from.isPrimary) {
          addStatement({
            sql: `ALTER TABLE ${escapeIdentifier(tblName)} DROP PRIMARY KEY;`,
            type: 'DROP_INDEX',
            table: tblName,
            severity: 'warning',
            warning: 'Khóa chính đang được thay đổi cấu trúc.',
            enabled: true
          });
        } else {
          addStatement({
            sql: `ALTER TABLE ${escapeIdentifier(tblName)} DROP INDEX ${escapeIdentifier(idxMod.from.name)};`,
            type: 'DROP_INDEX',
            table: tblName,
            severity: 'safe',
            enabled: true
          });
        }
      }

      // 3.2 Add new columns
      for (const newCol of tableDiff.columns.added) {
        const isDangerous = !newCol.nullable && newCol.default === null && !newCol.isAutoIncrement;
        addStatement({
          sql: `ALTER TABLE ${escapeIdentifier(tblName)} ADD COLUMN ${formatColumnClause(newCol)};`,
          type: 'ADD_COLUMN',
          table: tblName,
          severity: isDangerous ? 'warning' : 'safe',
          warning: isDangerous ? `Thêm cột ${newCol.name} kiểu NOT NULL không có DEFAULT có thể làm lỗi các bản ghi hiện tại.` : null,
          enabled: true
        });
      }

      // 3.3 Modify existing columns
      for (const modCol of tableDiff.columns.modified) {
        addStatement({
          sql: `ALTER TABLE ${escapeIdentifier(tblName)} MODIFY COLUMN ${formatColumnClause(modCol.to)};`,
          type: 'MODIFY_COLUMN',
          table: tblName,
          severity: 'warning',
          warning: `Thay đổi cột ${modCol.name} (${modCol.changes.join(', ')}) có thể gây mất hoặc ép kiểu dữ liệu.`,
          enabled: true
        });
      }

      // 3.4 Drop removed columns (if allowed)
      for (const dropCol of tableDiff.columns.dropped) {
        addStatement({
          sql: `ALTER TABLE ${escapeIdentifier(tblName)} DROP COLUMN ${escapeIdentifier(dropCol.name)};`,
          type: 'DROP_COLUMN',
          table: tblName,
          severity: 'destructive',
          warning: `CẢNH BÁO MẤT DỮ LIỆU: Cột ${dropCol.name} cùng toàn bộ dữ liệu trong cột sẽ bị xóa vĩnh viễn!`,
          enabled: allowDropColumns
        });
      }

      // 3.5 Add/Recreate indexes
      for (const newIdx of tableDiff.indexes.added) {
        const colList = newIdx.columns.map((c) => {
          let part = escapeIdentifier(c.name);
          if (c.length) part += `(${c.length})`;
          if (c.order === 'DESC') part += ' DESC';
          return part;
        }).join(', ');

        if (newIdx.isPrimary) {
          addStatement({
            sql: `ALTER TABLE ${escapeIdentifier(tblName)} ADD PRIMARY KEY (${colList});`,
            type: 'ADD_INDEX',
            table: tblName,
            severity: 'safe',
            enabled: true
          });
        } else if (newIdx.isUnique) {
          addStatement({
            sql: `ALTER TABLE ${escapeIdentifier(tblName)} ADD UNIQUE KEY ${escapeIdentifier(newIdx.name)} (${colList});`,
            type: 'ADD_INDEX',
            table: tblName,
            severity: 'safe',
            enabled: true
          });
        } else {
          addStatement({
            sql: `ALTER TABLE ${escapeIdentifier(tblName)} ADD KEY ${escapeIdentifier(newIdx.name)} (${colList});`,
            type: 'ADD_INDEX',
            table: tblName,
            severity: 'safe',
            enabled: true
          });
        }
      }

      for (const idxMod of tableDiff.indexes.modified) {
        const newIdx = idxMod.to;
        const colList = newIdx.columns.map((c) => {
          let part = escapeIdentifier(c.name);
          if (c.length) part += `(${c.length})`;
          if (c.order === 'DESC') part += ' DESC';
          return part;
        }).join(', ');

        if (newIdx.isPrimary) {
          addStatement({
            sql: `ALTER TABLE ${escapeIdentifier(tblName)} ADD PRIMARY KEY (${colList});`,
            type: 'ADD_INDEX',
            table: tblName,
            severity: 'safe',
            enabled: true
          });
        } else if (newIdx.isUnique) {
          addStatement({
            sql: `ALTER TABLE ${escapeIdentifier(tblName)} ADD UNIQUE KEY ${escapeIdentifier(newIdx.name)} (${colList});`,
            type: 'ADD_INDEX',
            table: tblName,
            severity: 'safe',
            enabled: true
          });
        } else {
          addStatement({
            sql: `ALTER TABLE ${escapeIdentifier(tblName)} ADD KEY ${escapeIdentifier(newIdx.name)} (${colList});`,
            type: 'ADD_INDEX',
            table: tblName,
            severity: 'safe',
            enabled: true
          });
        }
      }

      // 3.6 Change table attributes (e.g. Engine)
      if (tableDiff.attributes?.engine) {
        addStatement({
          sql: `ALTER TABLE ${escapeIdentifier(tblName)} ENGINE = ${tableDiff.attributes.engine.to};`,
          type: 'ALTER_TABLE',
          table: tblName,
          severity: 'warning',
          warning: `Đổi ENGINE từ ${tableDiff.attributes.engine.from} sang ${tableDiff.attributes.engine.to} có thể khóa bảng trong thời gian dài.`,
          enabled: true
        });
      }
    }

    // Phase 4: Add foreign keys (for both newly created tables and modified tables)
    for (const newTable of diff.tables.added) {
      for (const fk of newTable.foreignKeys) {
        const cols = fk.columns.map(escapeIdentifier).join(', ');
        const refCols = fk.referencedColumns.map(escapeIdentifier).join(', ');
        let sql = `ALTER TABLE ${escapeIdentifier(newTable.name)} ADD CONSTRAINT ${escapeIdentifier(fk.name)} FOREIGN KEY (${cols}) REFERENCES ${escapeIdentifier(fk.referencedTable)} (${refCols})`;
        if (fk.onDelete && fk.onDelete !== 'RESTRICT') sql += ` ON DELETE ${fk.onDelete}`;
        if (fk.onUpdate && fk.onUpdate !== 'RESTRICT') sql += ` ON UPDATE ${fk.onUpdate}`;
        sql += ';';

        addStatement({
          sql,
          type: 'ADD_FK',
          table: newTable.name,
          severity: 'safe',
          enabled: true
        });
      }
    }

    for (const tableDiff of diff.tables.modified) {
      for (const fk of tableDiff.foreignKeys.added) {
        const cols = fk.columns.map(escapeIdentifier).join(', ');
        const refCols = fk.referencedColumns.map(escapeIdentifier).join(', ');
        let sql = `ALTER TABLE ${escapeIdentifier(tableDiff.name)} ADD CONSTRAINT ${escapeIdentifier(fk.name)} FOREIGN KEY (${cols}) REFERENCES ${escapeIdentifier(fk.referencedTable)} (${refCols})`;
        if (fk.onDelete && fk.onDelete !== 'RESTRICT') sql += ` ON DELETE ${fk.onDelete}`;
        if (fk.onUpdate && fk.onUpdate !== 'RESTRICT') sql += ` ON UPDATE ${fk.onUpdate}`;
        sql += ';';

        addStatement({
          sql,
          type: 'ADD_FK',
          table: tableDiff.name,
          severity: 'safe',
          enabled: true
        });
      }

      for (const fkMod of tableDiff.foreignKeys.modified) {
        const fk = fkMod.to;
        const cols = fk.columns.map(escapeIdentifier).join(', ');
        const refCols = fk.referencedColumns.map(escapeIdentifier).join(', ');
        let sql = `ALTER TABLE ${escapeIdentifier(tableDiff.name)} ADD CONSTRAINT ${escapeIdentifier(fk.name)} FOREIGN KEY (${cols}) REFERENCES ${escapeIdentifier(fk.referencedTable)} (${refCols})`;
        if (fk.onDelete && fk.onDelete !== 'RESTRICT') sql += ` ON DELETE ${fk.onDelete}`;
        if (fk.onUpdate && fk.onUpdate !== 'RESTRICT') sql += ` ON UPDATE ${fk.onUpdate}`;
        sql += ';';

        addStatement({
          sql,
          type: 'ADD_FK',
          table: tableDiff.name,
          severity: 'safe',
          enabled: true
        });
      }
    }

    // Phase 5: Views
    for (const view of diff.views.added) {
      addStatement({
        sql: `CREATE OR REPLACE VIEW ${escapeIdentifier(view.name)} AS ${view.definition};`,
        type: 'CREATE_VIEW',
        table: view.name,
        severity: 'safe',
        enabled: true
      });
    }

    for (const viewMod of diff.views.modified) {
      addStatement({
        sql: `CREATE OR REPLACE VIEW ${escapeIdentifier(viewMod.name)} AS ${viewMod.to};`,
        type: 'ALTER_VIEW',
        table: viewMod.name,
        severity: 'warning',
        enabled: true
      });
    }

    for (const view of diff.views.dropped) {
      addStatement({
        sql: `DROP VIEW IF EXISTS ${escapeIdentifier(view.name)};`,
        type: 'DROP_VIEW',
        table: view.name,
        severity: 'destructive',
        warning: `Xóa view ${view.name}`,
        enabled: allowDropTables
      });
    }

    // Phase 6: Routines
    for (const r of diff.routines.added) {
      addStatement({
        sql: r.sql + (r.sql.endsWith(';') ? '' : ';'),
        type: 'CREATE_ROUTINE',
        table: r.name,
        severity: 'safe',
        enabled: true
      });
    }

    for (const rMod of diff.routines.modified) {
      addStatement({
        sql: `DROP ${rMod.type} IF EXISTS ${escapeIdentifier(rMod.name)};\n` + rMod.to + (rMod.to.endsWith(';') ? '' : ';'),
        type: 'ALTER_ROUTINE',
        table: rMod.name,
        severity: 'warning',
        enabled: true
      });
    }

    for (const r of diff.routines.dropped) {
      addStatement({
        sql: `DROP ${r.type} IF EXISTS ${escapeIdentifier(r.name)};`,
        type: 'DROP_ROUTINE',
        table: r.name,
        severity: 'destructive',
        enabled: allowDropTables
      });
    }

    // Phase 7: Drop removed tables (only if explicitly enabled)
    for (const dropTable of diff.tables.dropped) {
      addStatement({
        sql: `DROP TABLE IF EXISTS ${escapeIdentifier(dropTable.name)};`,
        type: 'DROP_TABLE',
        table: dropTable.name,
        severity: 'destructive',
        warning: `CẢNH BÁO NGUY HIỂM: Bảng ${dropTable.name} cùng toàn bộ dữ liệu bên trong sẽ bị xóa vĩnh viễn!`,
        enabled: allowDropTables
      });
    }

    return statements;
  }

  /**
   * Formats a list of migration statements into a complete runnable script
   */
  function formatMigrationScript(statements, { sourceName = 'Source', targetName = 'Target', wrapForeignKeys = false } = {}) {
    if (wrapForeignKeys) throw new Error('FOREIGN_KEY_CHECKS_OVERRIDE_UNSUPPORTED');
    const commentName = value => String(value).replace(/[\r\n\u2028\u2029]/g, ' ');
    const lines = [];
    const timestamp = new Date().toISOString();

    lines.push('-- ====================================================================');
    lines.push(`-- SqlPro Schema Migration Script`);
    lines.push(`-- Generated: ${timestamp}`);
    lines.push(`-- Target Database: ${commentName(targetName)} -> Synchronizing with: ${commentName(sourceName)}`);
    lines.push('-- ====================================================================');
    lines.push('');

    const enabledStatements = (statements || []).filter((s) => s && s.enabled !== false);

    if (!enabledStatements.length) {
      lines.push('-- Không có thay đổi nào cần áp dụng.');
    } else {
      for (const stmt of enabledStatements) {
        if (stmt.warning) {
          lines.push(`-- [WARNING] ${stmt.warning}`);
        }
        lines.push(stmt.sql);
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  return {
    escapeIdentifier,
    normalizeColumn,
    normalizeIndex,
    normalizeForeignKey,
    normalizeTable,
    normalizeSchemaSnapshot,
    normalizeColumnType,
    compareColumns,
    compareIndexes,
    compareForeignKeys,
    compareSchemas,
    formatColumnClause,
    formatCreateTableSql,
    generateMigrationSql,
    formatMigrationScript
  };
});
