(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SqlDataDiff = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Check if a value represents database NULL.
   * @param {*} val
   * @returns {boolean}
   */
  function isNullValue(val) {
    return val === null || val === undefined;
  }

  /**
   * Deep canonical comparison for JSON values.
   * @param {*} a
   * @param {*} b
   * @returns {boolean}
   */
  function compareJsonValues(a, b) {
    var objA = typeof a === 'string' ? safeJsonParse(a) : a;
    var objB = typeof b === 'string' ? safeJsonParse(b) : b;

    if (objA === null && objB === null) return true;
    if (objA === null || objB === null) return false;

    try {
      return JSON.stringify(canonicalizeJson(objA)) === JSON.stringify(canonicalizeJson(objB));
    } catch {
      return String(a) === String(b);
    }
  }

  function safeJsonParse(str) {
    try {
      return JSON.parse(str);
    } catch {
      return null;
    }
  }

  function canonicalizeJson(val) {
    if (val === null || typeof val !== 'object') return val;
    if (Array.isArray(val)) return val.map(canonicalizeJson);

    var sorted = {};
    var keys = Object.keys(val).sort();
    for (var i = 0; i < keys.length; i++) {
      sorted[keys[i]] = canonicalizeJson(val[keys[i]]);
    }
    return sorted;
  }

  /**
   * Canonical comparison of two cell values taking database types into account.
   * Ensures strict distinction between NULL, empty strings, numbers, and booleans.
   * @param {*} valA
   * @param {*} valB
   * @param {string} [columnType]
   * @returns {boolean}
   */
  function compareCanonicalValues(valA, valB, columnType) {
    // Both NULL
    if (isNullValue(valA) && isNullValue(valB)) return true;
    // Exactly one NULL
    if (isNullValue(valA) || isNullValue(valB)) return false;

    var type = columnType ? String(columnType).toLowerCase() : '';

    // Booleans / Tinyint(1)
    if (type.indexOf('bool') !== -1 || type === 'tinyint(1)') {
      var boolA = valA === true || valA === 1 || valA === '1' || String(valA).toLowerCase() === 'true';
      var boolB = valB === true || valB === 1 || valB === '1' || String(valB).toLowerCase() === 'true';
      return boolA === boolB;
    }

    // JSON
    if (type.indexOf('json') !== -1) {
      return compareJsonValues(valA, valB);
    }

    // Numbers: integer, decimal, bigint, float, double
    if (type.indexOf('int') !== -1 || type.indexOf('decimal') !== -1 || type.indexOf('numeric') !== -1 || type.indexOf('float') !== -1 || type.indexOf('double') !== -1) {
      if (typeof valA === 'number' && typeof valB === 'number') {
        if (isNaN(valA) && isNaN(valB)) return true;
        return valA === valB;
      }
      var strA = String(valA).trim();
      var strB = String(valB).trim();
      if (strA === strB) return true;

      var numA = Number(strA);
      var numB = Number(strB);
      if (!isNaN(numA) && !isNaN(numB)) {
        return numA === numB;
      }
      return strA === strB;
    }

    // Temporal / Dates
    if (type.indexOf('date') !== -1 || type.indexOf('time') !== -1 || type.indexOf('year') !== -1) {
      var normDateA = String(valA).replace(/[TZ]/g, ' ').trim().replace(/\.000$/, '');
      var normDateB = String(valB).replace(/[TZ]/g, ' ').trim().replace(/\.000$/, '');
      if (normDateA === normDateB) return true;

      var timeA = Date.parse(String(valA));
      var timeB = Date.parse(String(valB));
      if (!isNaN(timeA) && !isNaN(timeB)) {
        return timeA === timeB;
      }
      return String(valA) === String(valB);
    }

    // Fallback: direct string comparison (NULL vs empty string is already handled above)
    return String(valA) === String(valB);
  }

  /**
   * Escape an identifier (table or column) with backticks.
   * @param {string} name
   * @returns {string}
   */
  function quoteIdent(name) {
    if (!name || typeof name !== 'string') return '``';
    return '`' + name.replace(/`/g, '``') + '`';
  }

  /**
   * Format a JavaScript value into safe SQL literal for synchronization statements.
   * @param {*} val
   * @param {string} [columnType]
   * @returns {string}
   */
  function formatSqlValue(val, columnType) {
    if (isNullValue(val)) return 'NULL';

    var type = columnType ? String(columnType).toLowerCase() : '';

    if (typeof val === 'number') {
      return isFinite(val) ? String(val) : 'NULL';
    }

    if (typeof val === 'boolean') {
      return val ? '1' : '0';
    }

    if (type.indexOf('int') !== -1 || type.indexOf('decimal') !== -1 || type.indexOf('numeric') !== -1) {
      var num = Number(val);
      if (!isNaN(num) && String(val).trim() !== '') {
        return String(val).trim();
      }
    }

    if (type.indexOf('json') !== -1 && typeof val === 'object') {
      return "'" + JSON.stringify(val).replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
    }

    var strVal = String(val);
    return "'" + strVal.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
  }

  /**
   * Extract unique composite row key for matching across tables.
   * @param {Array|Object} row
   * @param {Array<number|string>} primaryKeyColumns
   * @param {Array<string>} [columnNames]
   * @returns {string}
   */
  function extractRowKey(row, primaryKeyColumns, columnNames) {
    if (!row || !Array.isArray(primaryKeyColumns) || !primaryKeyColumns.length) {
      return null;
    }

    var keyParts = [];

    for (var i = 0; i < primaryKeyColumns.length; i++) {
      var colRef = primaryKeyColumns[i];
      var val;

      if (Array.isArray(row)) {
        var colIndex = typeof colRef === 'number'
          ? colRef
          : (columnNames ? columnNames.indexOf(colRef) : -1);

        if (colIndex === -1) return null;
        val = row[colIndex];
      } else if (typeof row === 'object') {
        val = row[colRef];
      }

      if (isNullValue(val)) return null; // Primary keys cannot have NULL components
      keyParts.push(String(val));
    }

    return keyParts.join('::');
  }

  /**
   * Normalize column definition array.
   * @param {Array} columns
   * @returns {Array<{ name: string, type: string }>}
   */
  function normalizeColumns(columns) {
    if (!Array.isArray(columns)) return [];
    return columns.map(function (col, idx) {
      if (typeof col === 'string') {
        return { name: col, type: 'VARCHAR' };
      }
      return {
        name: col && col.name ? String(col.name) : 'col_' + idx,
        type: col && col.type ? String(col.type) : 'VARCHAR'
      };
    });
  }

  /**
   * Deep structural comparison between source rows and target rows of a table.
   * @param {Object} params
   * @param {Array} params.sourceRows
   * @param {Array} params.targetRows
   * @param {Array<string>} params.primaryKeys
   * @param {Array<Object|string>} params.columns
   * @param {Object} [params.options]
   * @returns {Object}
   */
  function compareTableData(params) {
    params = params || {};
    var sourceRows = Array.isArray(params.sourceRows) ? params.sourceRows : [];
    var targetRows = Array.isArray(params.targetRows) ? params.targetRows : [];
    var primaryKeys = Array.isArray(params.primaryKeys) ? params.primaryKeys : [];
    var columns = normalizeColumns(params.columns);
    var colNames = columns.map(function (c) { return c.name; });

    if (!primaryKeys.length) {
      throw new Error('So sánh dữ liệu yêu cầu ít nhất một cột Khóa chính (Primary Key) hoặc Khóa duy nhất (Unique Key).');
    }

    var sourceMap = new Map();
    var targetMap = new Map();

    // Index source rows
    for (var i = 0; i < sourceRows.length; i++) {
      var sRow = sourceRows[i];
      var sKey = extractRowKey(sRow, primaryKeys, colNames);
      if (sKey !== null) {
        sourceMap.set(sKey, sRow);
      }
    }

    // Index target rows
    for (var j = 0; j < targetRows.length; j++) {
      var tRow = targetRows[j];
      var tKey = extractRowKey(tRow, primaryKeys, colNames);
      if (tKey !== null) {
        targetMap.set(tKey, tRow);
      }
    }

    var identical = [];
    var onlyInSource = [];
    var onlyInTarget = [];
    var different = [];

    // Compare from Source perspective
    sourceMap.forEach(function (sRow, key) {
      if (!targetMap.has(key)) {
        onlyInSource.push({
          rowKey: key,
          row: sRow
        });
      } else {
        var tRow = targetMap.get(key);
        var diffCols = [];

        for (var c = 0; c < columns.length; c++) {
          var colName = columns[c].name;
          var colType = columns[c].type;

          var valA = Array.isArray(sRow) ? sRow[c] : sRow[colName];
          var valB = Array.isArray(tRow) ? tRow[c] : tRow[colName];

          if (!compareCanonicalValues(valA, valB, colType)) {
            diffCols.push({
              column: colName,
              columnIndex: c,
              columnType: colType,
              sourceValue: valA,
              targetValue: valB
            });
          }
        }

        if (diffCols.length > 0) {
          different.push({
            rowKey: key,
            sourceRow: sRow,
            targetRow: tRow,
            differences: diffCols
          });
        } else {
          identical.push({
            rowKey: key,
            row: sRow
          });
        }
      }
    });

    // Check target rows missing from source (Deleted / Extra in target)
    targetMap.forEach(function (tRow, key) {
      if (!sourceMap.has(key)) {
        onlyInTarget.push({
          rowKey: key,
          row: tRow
        });
      }
    });

    return Object.freeze({
      primaryKeys: primaryKeys,
      columns: columns,
      summary: Object.freeze({
        totalSource: sourceRows.length,
        totalTarget: targetRows.length,
        identicalCount: identical.length,
        onlyInSourceCount: onlyInSource.length,
        differentCount: different.length,
        onlyInTargetCount: onlyInTarget.length
      }),
      identical: identical,
      onlyInSource: onlyInSource,
      different: different,
      onlyInTarget: onlyInTarget
    });
  }

  /**
   * Generate executable synchronization SQL statements.
   * @param {Object} params
   * @param {string} params.targetTable
   * @param {Object} params.diffResult
   * @param {Object} [params.options]
   * @returns {Object}
   */
  function generateSyncSql(params) {
    params = params || {};
    var targetTable = params.targetTable || 'target_table';
    var diff = params.diffResult;
    var options = params.options || {};

    var includeInserts = options.includeInserts !== false;
    var includeUpdates = options.includeUpdates !== false;
    var includeDeletes = Boolean(options.includeDeletes); // Safety: deletes false by default

    if (!diff || !diff.summary) {
      return { statements: [], script: '' };
    }

    var statements = [];
    var columns = diff.columns || [];
    var colNames = columns.map(function (c) { return c.name; });
    var pkNames = diff.primaryKeys || [];

    // Helper to get value from row
    function getVal(row, colIndex, colName) {
      if (Array.isArray(row)) return row[colIndex];
      if (row && typeof row === 'object') return row[colName];
      return null;
    }

    // Helper to build PK WHERE clause
    function buildPkWhereClause(row) {
      var conditions = [];
      for (var k = 0; k < pkNames.length; k++) {
        var pk = pkNames[k];
        var pkIdx = colNames.indexOf(pk);
        var colType = pkIdx !== -1 ? columns[pkIdx].type : '';
        var val = getVal(row, pkIdx, pk);
        conditions.push(quoteIdent(pk) + ' = ' + formatSqlValue(val, colType));
      }
      return conditions.join(' AND ');
    }

    // 1. INSERT missing rows
    if (includeInserts && diff.onlyInSource.length > 0) {
      for (var i = 0; i < diff.onlyInSource.length; i++) {
        var sItem = diff.onlyInSource[i];
        var vals = [];

        for (var c = 0; c < columns.length; c++) {
          var val = getVal(sItem.row, c, columns[c].name);
          vals.push(formatSqlValue(val, columns[c].type));
        }

        var quotedCols = colNames.map(quoteIdent).join(', ');
        var insertSql = 'INSERT INTO ' + quoteIdent(targetTable) + ' (' + quotedCols + ') VALUES (' + vals.join(', ') + ');';

        statements.push({
          type: 'INSERT',
          severity: 'safe',
          rowKey: sItem.rowKey,
          sql: insertSql,
          enabled: true
        });
      }
    }

    // 2. UPDATE modified rows
    if (includeUpdates && diff.different.length > 0) {
      for (var u = 0; u < diff.different.length; u++) {
        var dItem = diff.different[u];
        var setClauses = [];

        for (var d = 0; d < dItem.differences.length; d++) {
          var diffCol = dItem.differences[d];
          var colIdent = quoteIdent(diffCol.column);
          var formattedVal = formatSqlValue(diffCol.sourceValue, diffCol.columnType);
          setClauses.push(colIdent + ' = ' + formattedVal);
        }

        var whereClause = buildPkWhereClause(dItem.sourceRow);
        var updateSql = 'UPDATE ' + quoteIdent(targetTable) + ' SET ' + setClauses.join(', ') + ' WHERE ' + whereClause + ';';

        statements.push({
          type: 'UPDATE',
          severity: 'warning',
          rowKey: dItem.rowKey,
          changedColumns: dItem.differences.map(function (x) { return x.column; }),
          sql: updateSql,
          enabled: true
        });
      }
    }

    // 3. DELETE extra rows (Optional Safety Gate)
    if (includeDeletes && diff.onlyInTarget.length > 0) {
      for (var del = 0; del < diff.onlyInTarget.length; del++) {
        var tItem = diff.onlyInTarget[del];
        var delWhere = buildPkWhereClause(tItem.row);
        var deleteSql = 'DELETE FROM ' + quoteIdent(targetTable) + ' WHERE ' + delWhere + ';';

        statements.push({
          type: 'DELETE',
          severity: 'destructive',
          rowKey: tItem.rowKey,
          sql: deleteSql,
          enabled: true
        });
      }
    }

    var scriptLines = [
      '-- =========================================================================',
      '-- SqlPro Data Synchronization Script',
      '-- Generated: ' + new Date().toISOString(),
      '-- Target Table: ' + targetTable,
      '-- Total Statements: ' + statements.length,
      '-- =========================================================================',
      ''
    ];

    statements.forEach(function (s) {
      scriptLines.push(s.sql);
    });

    return Object.freeze({
      statements: statements,
      script: scriptLines.join('\n')
    });
  }

  return Object.freeze({
    compareCanonicalValues: compareCanonicalValues,
    extractRowKey: extractRowKey,
    compareTableData: compareTableData,
    generateSyncSql: generateSyncSql,
    formatSqlValue: formatSqlValue
  });
}));
