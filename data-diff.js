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

  const fail = message => { throw Object.assign(new Error(message), { code: 'DATA_DIFF_UNVERIFIED' }); };

  // Decimal normalization uses strings only: never round BIGINT/DECIMAL via Number.
  function decimal(value) {
    if (typeof value === 'number' && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) fail('Giá trị số đã mất độ chính xác; cần đọc lại dạng chuỗi.');
    const text = String(value).trim();
    if (text.length > 1024) fail('Giá trị số vượt giới hạn so sánh.');
    const match = /^([+-]?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]{1,4}))?$/.exec(text);
    if (!match) fail('Giá trị số không hợp lệ trong kết quả so sánh.');
    let digits = (match[2] + (match[3] || '')).replace(/^0+/, '');
    let scale = (match[3] || '').length - Number(match[4] || 0);
    if (!digits) return '0';
    while (digits.endsWith('0')) { digits = digits.slice(0, -1); scale--; }
    return `${match[1] === '-' ? '-' : ''}${digits}e${-scale}`;
  }

  // Parse JSON ourselves so numeric lexemes and duplicate keys are not lost by
  // JSON.parse. Tagged canonical nodes also distinguish JSON strings/numbers.
  function canonicalJson(value) {
    if (typeof value !== 'string') {
      const seen = new Set();
      const check = (node, depth = 0) => {
        if (depth > 32 || node === undefined || ['function', 'symbol', 'bigint'].includes(typeof node) || typeof node === 'number' && (!Number.isFinite(node) || Number.isInteger(node) && !Number.isSafeInteger(node))) fail('JSON có giá trị không thể kiểm chứng chính xác.');
        if (node && typeof node === 'object') {
          if (seen.has(node)) fail('JSON có cấu trúc vòng hoặc dùng chung node.');
          seen.add(node); Object.keys(node).forEach(key => check(node[key], depth + 1));
        }
      };
      check(value);
      value = JSON.stringify(value);
    }
    if (typeof value !== 'string' || value.length > 65536) fail('JSON vượt giới hạn so sánh 65.536 ký tự.');
    let offset = 0, count = 0;
    const space = () => { while (/[ \t\r\n]/.test(value[offset] || 'x')) offset++; };
    const string = () => {
      const start = offset++;
      while (offset < value.length) {
        const char = value[offset++];
        if (char === '\\') offset++;
        else if (char === '"') {
          try { return JSON.parse(value.slice(start, offset)); } catch { fail('Chuỗi JSON không hợp lệ.'); }
        }
      }
      fail('Chuỗi JSON chưa đóng.');
    };
    const read = (depth = 0) => {
      if (++count > 10000 || depth > 32) fail('JSON vượt giới hạn node hoặc độ sâu.');
      space(); const char = value[offset];
      if (char === '"') return ['string', string()];
      if (char === '[') {
        offset++; space(); const items = [];
        if (value[offset] !== ']') do { items.push(read(depth + 1)); space(); if (value[offset] !== ',') break; offset++; } while (true);
        if (value[offset++] !== ']') fail('Mảng JSON không hợp lệ.');
        return ['array', items];
      }
      if (char === '{') {
        offset++; space(); const pairs = [], keys = new Set();
        if (value[offset] !== '}') do {
          space(); if (value[offset] !== '"') fail('Tên thuộc tính JSON không hợp lệ.');
          const key = string(); if (keys.has(key)) fail('JSON trùng tên thuộc tính; chưa hỗ trợ đối chiếu.'); keys.add(key);
          space(); if (value[offset++] !== ':') fail('JSON thiếu dấu hai chấm.');
          pairs.push([key, read(depth + 1)]); space(); if (value[offset] !== ',') break; offset++;
        } while (true);
        if (value[offset++] !== '}') fail('Object JSON không hợp lệ.');
        return ['object', pairs.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)];
      }
      for (const literal of ['true', 'false', 'null']) if (value.startsWith(literal, offset)) { offset += literal.length; return [literal]; }
      const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(value.slice(offset));
      if (!match) fail('Giá trị JSON không hợp lệ.');
      offset += match[0].length; return ['number', decimal(match[0])];
    };
    const result = read(); space(); if (offset !== value.length) fail('JSON có nội dung thừa.');
    return JSON.stringify(result);
  }

  function compareCanonicalValues(a, b, columnType) {
    if (a === undefined || b === undefined) fail('Thiếu giá trị cột; không thể coi là NULL.');
    if (a === null || b === null) return a === b;
    const type = String(columnType || '').toLowerCase().split('(')[0].trim().replace(/\s+(?:unsigned|zerofill).*$/, '');
    if (/^(?:binary|varbinary|tinyblob|blob|mediumblob|longblob|bit|geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection)$/.test(type)) fail('Kiểu nhị phân/không gian chưa có dữ liệu đầy đủ để so sánh.');
    if (type === 'json') return canonicalJson(a) === canonicalJson(b);
    if (/^(?:bool|boolean)$/.test(type)) {
      const boolean = value => value === true || value === 'true' ? '1' : value === false || value === 'false' ? '0' : value;
      return decimal(boolean(a)) === decimal(boolean(b));
    }
    if (/^(?:tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|year)$/.test(type)) return decimal(typeof a === 'boolean' ? Number(a) : a) === decimal(typeof b === 'boolean' ? Number(b) : b);
    // No timezone/collation guessing. SQL temporal strings are compared exactly.
    if (typeof a === 'object' || typeof b === 'object') fail('Dạng dữ liệu object/nhị phân chưa được hỗ trợ trong báo cáo.');
    return String(a) === String(b);
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
        if (!Object.hasOwn(row, colRef)) return null;
        val = row[colRef];
      }

      if (val === null || val === undefined) return null; // Primary keys cannot have NULL components
      if (typeof val === 'object' || typeof val === 'number' && !Number.isSafeInteger(val)) fail('Khóa không thể kiểm chứng chính xác.');
      keyParts.push(String(val));
    }

    return JSON.stringify(keyParts);
  }

  /**
   * Normalize column definition array.
   * @param {Array} columns
   * @returns {Array<{ name: string, type: string }>}
   */
  function normalizeColumns(columns) {
    if (!Array.isArray(columns) || !columns.length || columns.length > 1024) fail('Metadata cột thiếu hoặc vượt giới hạn.');
    const seen = new Set();
    return Array.from(columns, column => {
      if (!column || typeof column.name !== 'string' || !column.name || seen.has(column.name) || typeof column.type !== 'string' || !column.type) fail('Metadata cột không hợp lệ hoặc trùng tên.');
      seen.add(column.name);
      return Object.freeze({ name: column.name, type: column.type });
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
    if (!Array.isArray(params.sourceRows) || !Array.isArray(params.targetRows)) fail('Thiếu kết quả dòng ở một phía.');
    var sourceRows = Array.isArray(params.sourceRows) ? params.sourceRows : [];
    var targetRows = Array.isArray(params.targetRows) ? params.targetRows : [];
    var primaryKeys = Array.isArray(params.primaryKeys) ? params.primaryKeys : [];
    var columns = normalizeColumns(params.columns);
    var colNames = columns.map(function (c) { return c.name; });

    if (!primaryKeys.length || new Set(primaryKeys).size !== primaryKeys.length || primaryKeys.some(key => !colNames.includes(key))) {
      throw new Error('So sánh dữ liệu yêu cầu ít nhất một cột Khóa chính (Primary Key) hoặc Khóa duy nhất (Unique Key).');
    }

    if (sourceRows.length > 2000 || targetRows.length > 2000) fail('Báo cáo chỉ đọc tối đa 2.000 dòng mỗi phía.');
    const snapshot = rows => Array.from(rows, row => {
      if (!row || typeof row !== 'object') fail('Dòng so sánh không hợp lệ.');
      const cell = (value, column) => {
        compareCanonicalValues(value, value, column.type);
        if (typeof value === 'object' && value !== null) return JSON.stringify(value);
        if (typeof value === 'string' && value.length > 65536) fail('Giá trị cột vượt giới hạn so sánh.');
        return value;
      };
      if (Array.isArray(row)) {
        if (row.length !== columns.length || columns.some((_column, index) => !Object.hasOwn(row, index) || row[index] === undefined)) fail('Dòng thiếu giá trị cột.');
        return Object.freeze(columns.map((column, index) => cell(row[index], column)));
      }
      const result = Object.create(null);
      for (const column of columns) {
        if (!Object.hasOwn(row, column.name) || row[column.name] === undefined) fail('Dòng thiếu giá trị cột.');
        result[column.name] = cell(row[column.name], column);
      }
      return Object.freeze(result);
    });
    sourceRows = snapshot(sourceRows); targetRows = snapshot(targetRows);
    var sourceMap = new Map();
    var targetMap = new Map();

    // Index source rows
    for (var i = 0; i < sourceRows.length; i++) {
      var sRow = sourceRows[i];
      var sKey = extractRowKey(sRow, primaryKeys, colNames);
      if (sKey === null || sourceMap.has(sKey)) fail('Khóa nguồn thiếu, NULL hoặc trùng; không thể đối chiếu.');
      sourceMap.set(sKey, sRow);
    }

    // Index target rows
    for (var j = 0; j < targetRows.length; j++) {
      var tRow = targetRows[j];
      var tKey = extractRowKey(tRow, primaryKeys, colNames);
      if (tKey === null || targetMap.has(tKey)) fail('Khóa đích thiếu, NULL hoặc trùng; không thể đối chiếu.');
      targetMap.set(tKey, tRow);
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
      coverage: Object.freeze({ version: 1, kind: 'bounded-observation', complete: false, consistent: false, canSynchronize: false }),
      primaryKeys: Object.freeze([...primaryKeys]),
      columns: Object.freeze(columns),
      summary: Object.freeze({
        totalSource: sourceRows.length,
        totalTarget: targetRows.length,
        identicalCount: identical.length,
        onlyInSourceCount: onlyInSource.length,
        differentCount: different.length,
        onlyInTargetCount: onlyInTarget.length
      }),
      identical: Object.freeze(identical.map(Object.freeze)),
      onlyInSource: Object.freeze(onlyInSource.map(Object.freeze)),
      different: Object.freeze(different.map(item => Object.freeze({ ...item, differences: Object.freeze(item.differences.map(Object.freeze)) }))),
      onlyInTarget: Object.freeze(onlyInTarget.map(Object.freeze))
    });
  }

  // Bounded SELECT results do not prove absence or establish a source/target
  // snapshot. Keep every script/execution path closed until main owns evidence,
  // drift checks and guarded writes; renderer flags cannot grant this authority.
  function generateSyncSql() {
    return Object.freeze({ statements: Object.freeze([]), script: '', blocked: true,
      reason: 'Báo cáo chỉ gồm các dòng đã đọc, chưa có snapshot nhất quán hoặc kiểm tra thay đổi trước ghi. Đồng bộ và xuất SQL đang bị khóa.' });
  }

  return Object.freeze({ compareCanonicalValues, extractRowKey, compareTableData, generateSyncSql });
}));
