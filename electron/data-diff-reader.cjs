'use strict';

const UNSUPPORTED_COL_TYPES = /^(?:binary|varbinary|tinyblob|blob|mediumblob|longblob|bit|geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection)$/i;

function error(code, message) {
  return Object.assign(new Error(message), { code });
}

function quoteId(name) {
  return `\`${String(name).replace(/`/g, '``')}\``;
}

function parseDecimal(value) {
  if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
    throw error('DATA_DIFF_UNVERIFIED', 'Giá trị số đã mất độ chính xác; cần đọc lại dạng chuỗi.');
  }
  const text = String(value).trim();
  if (text.length > 1024) throw error('DATA_DIFF_UNVERIFIED', 'Giá trị số vượt giới hạn so sánh 1024 ký tự.');
  const match = /^([+-]?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]{1,4}))?$/.exec(text);
  if (!match) throw error('DATA_DIFF_UNVERIFIED', `Giá trị số không hợp lệ trong kết quả so sánh: ${text}`);

  const signChar = match[1];
  let intPart = match[2];
  let fracPart = match[3] || '';
  const exp = Number(match[4] || 0);

  if (exp > 0) {
    if (fracPart.length <= exp) {
      intPart = intPart + fracPart + '0'.repeat(exp - fracPart.length);
      fracPart = '';
    } else {
      intPart = intPart + fracPart.slice(0, exp);
      fracPart = fracPart.slice(exp);
    }
  } else if (exp < 0) {
    const shift = -exp;
    if (intPart.length <= shift) {
      fracPart = '0'.repeat(shift - intPart.length) + intPart + fracPart;
      intPart = '0';
    } else {
      fracPart = intPart.slice(intPart.length - shift) + fracPart;
      intPart = intPart.slice(0, intPart.length - shift);
    }
  }

  intPart = intPart.replace(/^0+/, '');
  if (!intPart) intPart = '0';
  fracPart = fracPart.replace(/0+$/, '');

  if (intPart === '0' && fracPart === '') {
    return { sign: 0, intPart: '0', fracPart: '' };
  }

  const sign = signChar === '-' ? -1 : 1;
  return { sign, intPart, fracPart };
}

function compareDecimalStrings(a, b) {
  const da = parseDecimal(a);
  const db = parseDecimal(b);

  if (da.sign !== db.sign) {
    return da.sign < db.sign ? -1 : 1;
  }
  if (da.sign === 0) return 0;

  let cmp = 0;
  if (da.intPart.length !== db.intPart.length) {
    cmp = da.intPart.length < db.intPart.length ? -1 : 1;
  } else if (da.intPart !== db.intPart) {
    cmp = da.intPart < db.intPart ? -1 : 1;
  } else {
    const maxLen = Math.max(da.fracPart.length, db.fracPart.length);
    const fa = da.fracPart.padEnd(maxLen, '0');
    const fb = db.fracPart.padEnd(maxLen, '0');
    if (fa < fb) cmp = -1;
    else if (fa > fb) cmp = 1;
    else cmp = 0;
  }

  if (cmp === 0) return 0;
  return da.sign === -1 ? -cmp : cmp;
}

function isNumericColumnType(type) {
  const base = String(type || '').toLowerCase().split('(')[0].trim().replace(/\s+(?:unsigned|zerofill).*$/, '');
  return /^(?:tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|year)$/.test(base);
}

function compareKeyTuples(tupleA, tupleB, pkTypes = []) {
  if (!Array.isArray(tupleA) || !Array.isArray(tupleB) || tupleA.length !== tupleB.length) {
    throw error('DATA_DIFF_KEY_MISMATCH', 'Độ dài khóa không khớp nhau khi so sánh.');
  }

  for (let i = 0; i < tupleA.length; i++) {
    const valA = tupleA[i];
    const valB = tupleB[i];
    const type = pkTypes[i] || '';

    if (valA === null || valB === null || valA === undefined || valB === undefined) {
      throw error('DATA_DIFF_NULL_KEY', 'Khóa chính không được chứa giá trị NULL.');
    }

    let cmp = 0;
    if (isNumericColumnType(type)) {
      cmp = compareDecimalStrings(valA, valB);
    } else {
      const sa = String(valA);
      const sb = String(valB);
      if (sa < sb) cmp = -1;
      else if (sa > sb) cmp = 1;
      else cmp = 0;
    }

    if (cmp !== 0) return cmp;
  }

  return 0;
}

function extractRowKeyTuple(row, primaryKeys, columnNames) {
  if (!row || !Array.isArray(primaryKeys) || !primaryKeys.length) return null;
  const tuple = [];
  for (let i = 0; i < primaryKeys.length; i++) {
    const colName = primaryKeys[i];
    let val;
    if (Array.isArray(row)) {
      const idx = columnNames ? columnNames.indexOf(colName) : -1;
      if (idx === -1) throw error('DATA_DIFF_NULL_KEY', `Không tìm thấy vị trí cột "${colName}" trong dòng.`);
      val = row[idx];
    } else if (typeof row === 'object') {
      if (!Object.hasOwn(row, colName)) {
        throw error('DATA_DIFF_NULL_KEY', `Thiếu trường khóa chính "${colName}" trong dữ liệu dòng.`);
      }
      val = row[colName];
    }
    if (val === null || val === undefined) {
      throw error('DATA_DIFF_NULL_KEY', `Khóa chính "${colName}" chứa giá trị NULL hoặc undefined.`);
    }
    if (typeof val === 'number' && (!Number.isFinite(val) || (Number.isInteger(val) && !Number.isSafeInteger(val)))) {
      throw error('DATA_DIFF_UNVERIFIED', `Khóa chính "${colName}" có giá trị số mất chính xác.`);
    }
    tuple.push(val);
  }
  return tuple;
}

function buildKeysetQuery(database, table, columns, primaryKeys, lastKeyValues, limit) {
  const colList = columns.map(c => quoteId(c.name)).join(', ');
  const orderList = primaryKeys.map(k => `${quoteId(k)} ASC`).join(', ');
  const fromClause = `${quoteId(database)}.${quoteId(table)}`;

  if (!lastKeyValues || !lastKeyValues.length) {
    return {
      sql: `SELECT ${colList} FROM ${fromClause} ORDER BY ${orderList} LIMIT ?`,
      params: [limit]
    };
  }

  const orClauses = [];
  const params = [];

  for (let i = 0; i < primaryKeys.length; i++) {
    const andParts = [];
    for (let j = 0; j < i; j++) {
      andParts.push(`${quoteId(primaryKeys[j])} = ?`);
      params.push(lastKeyValues[j]);
    }
    andParts.push(`${quoteId(primaryKeys[i])} > ?`);
    params.push(lastKeyValues[i]);

    if (andParts.length === 1) {
      orClauses.push(andParts[0]);
    } else {
      orClauses.push(andParts.join(' AND '));
    }
  }

  const whereClause = orClauses.length === 1 ? orClauses[0] : orClauses.map(c => `(${c})`).join(' OR ');
  params.push(limit);

  return {
    sql: `SELECT ${colList} FROM ${fromClause} WHERE ${whereClause} ORDER BY ${orderList} LIMIT ?`,
    params
  };
}

async function validateTableForDiff(session, database, table) {
  if (typeof database !== 'string' || !database.trim()) throw error('INVALID_DATABASE', 'Tên cơ sở dữ liệu không hợp lệ.');
  if (typeof table !== 'string' || !table.trim()) throw error('INVALID_TABLE', 'Tên bảng không hợp lệ.');

  const columns = await session.listColumns(database, table, { fresh: true });
  if (!Array.isArray(columns) || !columns.length) {
    throw error('DATA_DIFF_TABLE_NOT_FOUND', `Không tìm thấy thông tin cột cho bảng ${database}.${table}.`);
  }

  for (const col of columns) {
    const baseType = String(col.type || '').toLowerCase().split('(')[0].trim();
    if (UNSUPPORTED_COL_TYPES.test(baseType)) {
      throw error('DATA_DIFF_UNSUPPORTED_COLUMN_TYPE', `Cột "${col.name}" có kiểu "${col.type}" nhị phân hoặc không gian chưa hỗ trợ so sánh.`);
    }
  }

  const primaryKeys = columns.filter(c => c.key === 'PRI').map(c => c.name);
  if (!primaryKeys.length) {
    throw error('DATA_DIFF_NO_PRIMARY_KEY', `Bảng ${database}.${table} không có Khóa chính (Primary Key); chưa thể so sánh keyset.`);
  }

  const pkTypes = primaryKeys.map(pkName => {
    const col = columns.find(c => c.name === pkName);
    const baseType = String(col?.type || '').toLowerCase().split(/[ (]/)[0];
    // Text key ordering depends on server collation; the JS merge has no such proof.
    if (!/^(?:tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric)$/.test(baseType)) {
      throw error('DATA_DIFF_UNSUPPORTED_PK_TYPE', `Khóa chính "${pkName}" có kiểu "${col?.type}" không hỗ trợ keyset pagination an toàn.`);
    }
    return col?.type || '';
  });

  let engine = null;
  try {
    const { result } = await session.raw(
      `SELECT ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [database, table],
      10000,
      { prepared: true }
    );
    if (result && result[0] && (result[0].engine || result[0].ENGINE)) {
      engine = result[0].engine || result[0].ENGINE;
    }
  } catch {
    // Missing engine evidence must never be promoted to a transactional engine.
  }

  return {
    columns: columns.map(c => ({ name: c.name, type: c.type })),
    primaryKeys,
    pkTypes,
    engine
  };
}

class TableKeysetReader {
  constructor(session, database, table, options = {}) {
    this.session = session;
    this.database = database;
    this.table = table;
    this.chunkSize = Math.max(10, Math.min(1000, Number(options.chunkSize) || 200));
    this.maxRows = Math.max(1, Math.min(2000, Number(options.maxRows || options.rowLimit) || 2000));
    this.maxBytes = Number(options.maxBytes) || 10 * 1024 * 1024;
    this.signal = options.signal || null;
    this.columns = [];
    this.primaryKeys = [];
    this.pkTypes = [];
    this.engine = '';
    this.lastKeyValues = null;
    this.rowsRead = 0;
    this.bytesRead = 0;
    this.hasMore = true;
    this.exhausted = false;
    this.quotaReached = false;
    this.inTransaction = false;
    this.closed = false;
  }

  async init() {
    const meta = await validateTableForDiff(this.session, this.database, this.table);
    this.columns = meta.columns;
    this.primaryKeys = meta.primaryKeys;
    this.pkTypes = meta.pkTypes;
    this.engine = meta.engine;

    if (/^innodb$/i.test(this.engine)) {
      try {
        await this.session.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await this.session.raw('START TRANSACTION WITH CONSISTENT SNAPSHOT');
        this.inTransaction = true;
      } catch {
        // Not fatal, proceed with read-committed observation
      }
    }
  }

  async readNextChunk() {
    if (this.closed || !this.hasMore) {
      return { rows: [], hasMore: false, exhausted: this.exhausted, quotaReached: this.quotaReached, lastKeyValues: this.lastKeyValues, chunkRowCount: 0, totalRowsRead: this.rowsRead };
    }
    if (this.signal?.aborted) {
      throw error('DATA_DIFF_CANCELLED', 'Thao tác so sánh dữ liệu đã bị hủy.');
    }

    const remainingRows = this.maxRows - this.rowsRead;
    if (remainingRows <= 0) {
      this.hasMore = false;
      this.quotaReached = true;
      return { rows: [], hasMore: false, exhausted: this.exhausted, quotaReached: true, lastKeyValues: this.lastKeyValues, chunkRowCount: 0, totalRowsRead: this.rowsRead };
    }

    const limit = Math.min(this.chunkSize, remainingRows);
    const { sql, params } = buildKeysetQuery(
      this.database,
      this.table,
      this.columns,
      this.primaryKeys,
      this.lastKeyValues,
      limit
    );

    const result = await this.session.raw(sql, params, 30000, { prepared: true });
    const rows = result.rows || [];

    let chunkBytes = 0;
    for (const r of rows) {
      if (typeof r === 'object' && r !== null) {
        for (const k of Object.keys(r)) {
          const v = r[k];
          if (typeof v === 'string') chunkBytes += Buffer.byteLength(v);
          else if (typeof v === 'number') chunkBytes += 8;
          else if (v instanceof Date) chunkBytes += 24;
          else if (Buffer.isBuffer(v)) chunkBytes += v.length;
          else chunkBytes += 16;
        }
      }
    }

    this.bytesRead += chunkBytes;
    if (this.bytesRead > this.maxBytes) {
      throw error('DATA_DIFF_BUDGET_EXCEEDED', `Dữ liệu đọc vượt hạn mức ${Math.round(this.maxBytes / (1024 * 1024))} MB.`);
    }

    this.rowsRead += rows.length;

    if (rows.length < limit) {
      this.hasMore = false;
      this.exhausted = true;
    } else if (this.rowsRead >= this.maxRows) {
      this.hasMore = false;
      this.quotaReached = true;
    }

    if (rows.length > 0) {
      const lastRow = rows[rows.length - 1];
      this.lastKeyValues = extractRowKeyTuple(lastRow, this.primaryKeys, this.columns.map(c => c.name));
    }

    return {
      rows,
      hasMore: this.hasMore,
      exhausted: this.exhausted,
      quotaReached: this.quotaReached,
      lastKeyValues: this.lastKeyValues,
      chunkRowCount: rows.length,
      totalRowsRead: this.rowsRead
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.inTransaction) {
      try {
        await this.session.raw('ROLLBACK');
      } catch {
        // ignore
      }
      this.inTransaction = false;
    }
  }
}

module.exports = {
  quoteId,
  parseDecimal,
  compareDecimalStrings,
  isNumericColumnType,
  compareKeyTuples,
  extractRowKeyTuple,
  buildKeysetQuery,
  validateTableForDiff,
  TableKeysetReader
};
