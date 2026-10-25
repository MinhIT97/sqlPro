'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2');
const { Client: SshClient } = require('ssh2');
const { SqlScriptParser, splitSqlStatements, stripLeadingComments, createTarget, skipReason, assertStatementScope, countInsertRows } = require('./sql-script.cjs');
const { CsvStreamParser } = require('./csv-stream.cjs');
const { JsonArrayStreamParser, isJsonNumber, stringifyJsonValue } = require('./json-array-stream.cjs');
const RowValues = require('../row-values.js');
const ExportValues = require('../export-values.js');
const { ResultBudget } = require('./result-budget.cjs');
const { TableDataService } = require('./table-data.cjs');

const MAX_QUERY_ROWS = 5000;
const MAX_QUERY_BATCH_ROWS = 10000;
const MAX_QUERY_BYTES = 8 * 1024 * 1024;
const MAX_QUERY_BATCH_BYTES = 16 * 1024 * 1024;
const MAX_QUERY_STATEMENTS = 100;
const MAX_PAGE_SIZE = 500;
const BACKUP_INSERT_ROWS = 200;
const BACKUP_INSERT_BYTES = 1024 * 1024;
const FILE_WRITE_CHUNK_BYTES = 1024 * 1024;
const IMPORT_BATCH_ROWS = 200;
const IMPORT_MAX_PARAMS = 10000;
const PREVIEW_ROW_LIMIT = 20;
const PREVIEW_MAX_ROWS = 100;
const IMPORT_FORMATS = new Set(['csv', 'tsv', 'json']);
const TRANSACTIONAL_ENGINES = new Set(['innodb', 'ndb', 'ndbcluster', 'tokudb', 'rocksdb']);
const DATA_LOSS_WARNING_CODES = new Set([1264, 1265, 1292, 1366, 1406]);
const TEXT_BYTE_LIMITS = {
  tinytext: 255,
  text: 65535,
  mediumtext: 16777215,
  longtext: 4294967295
};
const BLOB_BYTE_LIMITS = {
  tinyblob: 255,
  blob: 65535,
  mediumblob: 16777215,
  longblob: 4294967295
};
const RESTORE_ROWCOUNT_LIMIT = 500000;
const WORKER_LOCK_WAIT_SECONDS = 15;

const TYPE_NAMES = (() => {
  const names = {};
  for (const [name, value] of Object.entries(mysql.Types || {})) names[value] = name;
  return names;
})();

function fail(message, code) {
  const error = new Error(message);
  if (code) error.code = code;
  return error;
}

function quoteId(name) {
  return `\`${String(name).replace(/`/g, '``')}\``;
}

function tableRef(database, table) {
  return `${quoteId(database)}.${quoteId(table)}`;
}

function stripDefinerClause(ddl) {
  const definer = 'DEFINER\\s*=\\s*(?:`(?:[^`]|``)*`|\'(?:[^\'\\\\]|\\\\.|\'\')*\'|"(?:[^"\\\\]|\\\\.|"")*"|\\S+)';
  const pattern = new RegExp(
    `^(\\s*CREATE\\s+)(?:(?:OR\\s+REPLACE|ALGORITHM\\s*=\\s*\\w+|SQL\\s+SECURITY\\s+(?:DEFINER|INVOKER))\\s+)*${definer}\\s+`,
    'i'
  );
  return String(ddl || '').replace(pattern, '$1');
}

function showCreateDdl(result, label) {
  const row = (Array.isArray(result) ? result[0] : result && result[0]) || {};
  const key = Object.keys(row).find((name) => /^Create /i.test(name));
  const ddl = key ? String(row[key] || '').trim() : '';
  if (!ddl) throw fail(`Không đọc được DDL của ${label}.`, 'SHOW_CREATE_FAILED');
  return ddl;
}

function serializeValue(value) {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) {
    const preview = value.subarray(0, 32).toString('hex');
    const suffix = value.length > 32 ? `… (${value.length} bytes)` : '';
    return `0x${preview}${suffix}`;
  }
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return value;
}

function serializeRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, serializeValue(value)]));
}

function originalHashes(row) {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => Buffer.isBuffer(value) && value.length > 32)
    .map(([name, value]) => [name, { kind: 'sha256', value: crypto.createHash('sha256').update(value).digest('hex') }]));
}

function isNumericType(type) {
  return /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|bit|year)\b/i.test(type);
}

function isDateType(type) {
  return /^(date|datetime|timestamp|time)\b/i.test(type);
}

function coerceValue(value, column) {
  if (ArrayBuffer.isView(value) && !Buffer.isBuffer(value)) {
    value = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  const spec = RowValues.describe(column, value);
  if (Buffer.isBuffer(value) && (spec.kind === 'binary' || spec.kind === 'bit')) return value;
  let normalized;
  try {
    normalized = RowValues.normalizeValue(column, value);
  } catch (error) {
    throw fail(error.message, 'ROW_VALUE_INVALID');
  }
  if (normalized === null) return null;
  if (spec.kind === 'binary') return Buffer.from(normalized.slice(2), 'hex');
  if (spec.kind === 'bit') {
    let hex = BigInt(`0b${normalized}`).toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    return Buffer.from(hex, 'hex');
  }
  return normalized;
}

function rowKeyParameter(value, column) {
  if (Buffer.isBuffer(value)) return value;
  const kind = RowValues.describe(column).kind;
  if (kind !== 'binary' && kind !== 'bit') return value;
  return coerceValue(RowValues.displayValue(column, value), column);
}

function normalizeFileFormat(format, filePath) {
  const value = String(format || '').toLowerCase();
  if (IMPORT_FORMATS.has(value)) return value;
  const extension = path.extname(String(filePath || '')).toLowerCase();
  if (extension === '.json') return 'json';
  if (extension === '.tsv' || extension === '.tab') return 'tsv';
  return 'csv';
}

function normalizeDelimiter(format, delimiter) {
  if (format === 'tsv') return '\t';
  if (delimiter === '\\t' || delimiter === '\t') return '\t';
  const value = delimiter === undefined || delimiter === null || delimiter === '' ? ',' : String(delimiter);
  if (value.length !== 1) throw fail('Dấu phân cách phải là đúng một ký tự.', 'INVALID_DELIMITER');
  return value;
}

function exportTextValue(value) {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return `0x${value.toString('hex')}`;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function exportJsonValue(value) {
  if (value === undefined) return null;
  if (Buffer.isBuffer(value)) return `0x${value.toString('hex')}`;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  return value;
}

function exportJsonField(value, column) {
  // jsonStrings prevents numeric rounding in the driver. Keep JSON columns as
  // JSON values in exports rather than encoding their source text a second time.
  if (isJsonColumn(column.type) && typeof value === 'string') {
    try { JSON.parse(value); return value; } catch { /* Handle non-JSON legacy values as text. */ }
  }
  return JSON.stringify(exportJsonValue(value));
}

function resolveFileColumns(columns, requested) {
  if (!Array.isArray(requested) || !requested.length) return columns;
  const byName = new Map(columns.map((column) => [column.name, column]));
  const selected = [];
  for (const input of requested) {
    const name = String(input);
    const column = byName.get(name);
    if (!column) throw fail(`Không tìm thấy cột "${name}" trong bảng.`, 'COLUMN_NOT_FOUND');
    if (!selected.some((entry) => entry.name === column.name)) selected.push(column);
  }
  return selected;
}

function buildFileWhere(filters, columns, search = '', { searchColumn, searchMode } = {}) {
  const filterParts = [];
  const searchParts = [];
  const params = [];
  if (Array.isArray(filters) && filters.length > 20) throw fail('Chỉ hỗ trợ tối đa 20 điều kiện lọc.', 'TOO_MANY_FILTERS');
  const byName = new Map(columns.map((column) => [column.name, column]));
  for (const filter of Array.isArray(filters) ? filters : []) {
    if (!filter || typeof filter !== 'object') throw fail('Điều kiện lọc không hợp lệ.', 'INVALID_FILTER');
    const column = byName.get(String(filter.column || ''));
    if (!column) throw fail(`Không tìm thấy cột "${filter.column}" để lọc.`, 'COLUMN_NOT_FOUND');
    const operator = String(filter.operator || '=').trim().toUpperCase();
    const reference = quoteId(column.name);
    if (operator === 'IS NULL' || operator === 'IS NOT NULL') {
      filterParts.push(`${reference} ${operator}`);
      continue;
    }
    if (operator === 'IN' || operator === 'NOT IN') {
      const values = Array.isArray(filter.value) ? filter.value : [];
      if (!values.length) throw fail(`Điều kiện ${operator} cần ít nhất một giá trị.`, 'INVALID_FILTER');
      if (values.length > 1000) throw fail(`Điều kiện ${operator} hỗ trợ tối đa 1000 giá trị.`, 'INVALID_FILTER');
      filterParts.push(`${reference} ${operator} (${values.map(() => '?').join(', ')})`);
      params.push(...values);
      continue;
    }
    if (operator === 'BETWEEN') {
      const values = Array.isArray(filter.value) ? filter.value : [];
      if (values.length !== 2) throw fail('Điều kiện BETWEEN cần đúng hai giá trị.', 'INVALID_FILTER');
      filterParts.push(`${reference} BETWEEN ? AND ?`);
      params.push(values[0], values[1]);
      continue;
    }
    if (!['=', '!=', '<>', '>', '>=', '<', '<=', 'LIKE', 'NOT LIKE'].includes(operator)) {
      throw fail(`Toán tử lọc "${operator}" không được hỗ trợ.`, 'INVALID_FILTER');
    }
    const value = filter.value;
    if (value === null || value === undefined) {
      if (operator === '=') filterParts.push(`${reference} IS NULL`);
      else if (operator === '!=' || operator === '<>') filterParts.push(`${reference} IS NOT NULL`);
      else throw fail(`Không thể dùng ${operator} với giá trị NULL.`, 'INVALID_FILTER');
      continue;
    }
    filterParts.push(`${reference} ${operator} ?`);
    params.push(value);
  }
  const term = String(search || '').trim().slice(0, 200);
  if (term) {
    const selected = searchColumn ? columns.filter((column) => column.name === searchColumn) : columns;
    if (!selected.length) throw fail('Cột tìm kiếm không hợp lệ.', 'COLUMN_NOT_FOUND');
    for (const column of selected) {
      searchParts.push(searchMode === 'exact' ? `${searchColumn ? quoteId(column.name) : `CAST(${quoteId(column.name)} AS CHAR)`} = ?` : `CAST(${quoteId(column.name)} AS CHAR) LIKE ?`);
      params.push(searchMode === 'exact' ? (searchColumn ? coerceValue(term, column) : term) : `%${term}%`);
    }
  }
  let sql = '';
  if (filterParts.length && searchParts.length) {
    sql = ` WHERE (${filterParts.join(' AND ')}) AND (${searchParts.join(' OR ')})`;
  } else if (filterParts.length) {
    sql = ` WHERE ${filterParts.join(' AND ')}`;
  } else if (searchParts.length) {
    sql = ` WHERE (${searchParts.join(' OR ')})`;
  }
  return { sql, params };
}

function buildFileOrder(orderBy, columns) {
  if (!orderBy) return '';
  const entries = Array.isArray(orderBy) ? orderBy : [orderBy];
  if (!entries.length) return '';
  if (entries.length > 5) throw fail('Chỉ hỗ trợ tối đa 5 cột sắp xếp.', 'INVALID_ORDER');
  const byName = new Map(columns.map((column) => [column.name, column]));
  const parts = [];
  for (const entry of entries) {
    const value = typeof entry === 'string' ? { column: entry } : entry;
    if (!value || typeof value !== 'object') throw fail('Cột sắp xếp không hợp lệ.', 'INVALID_ORDER');
    const column = byName.get(String(value.column || ''));
    if (!column) throw fail(`Không tìm thấy cột "${value.column}" để sắp xếp.`, 'COLUMN_NOT_FOUND');
    const direction = String(value.direction || 'ASC').toUpperCase();
    if (direction !== 'ASC' && direction !== 'DESC') throw fail('Hướng sắp xếp phải là ASC hoặc DESC.', 'INVALID_ORDER');
    parts.push(`${quoteId(column.name)} ${direction}`);
  }
  return parts.length ? ` ORDER BY ${parts.join(', ')}` : '';
}

function parseDuplicateCount(info) {
  const match = /Duplicates:\s*(\d+)/i.exec(String(info || ''));
  return match ? Number(match[1]) : 0;
}

function isBinaryColumn(type) {
  return /^(binary|varbinary|tinyblob|blob|mediumblob|longblob)\b/i.test(type);
}

function isJsonColumn(type) {
  return /^json\b/i.test(type);
}

function isTextColumn(type) {
  return /^(tinytext|text|mediumtext|longtext|char|varchar)\b/i.test(type);
}

function binaryLimit(type) {
  const match = /^(binary|varbinary)\s*\(\s*(\d+)\s*\)/i.exec(type);
  if (match) return Number(match[2]);
  const base = /^(tinyblob|blob|mediumblob|longblob)\b/i.exec(type);
  return base ? BLOB_BYTE_LIMITS[base[1].toLowerCase()] : null;
}

function textLimit(type) {
  const base = /^(tinytext|text|mediumtext|longtext)\b/i.exec(type);
  return base ? TEXT_BYTE_LIMITS[base[1].toLowerCase()] : null;
}

function ensureImportByteLength(length, limit, rowNumber, column, label) {
  if (limit && length > limit) {
    throw importValueError(rowNumber, column, `${label} ${length} byte vượt giới hạn ${limit} byte của ${column.type}.`);
  }
}

function originalValuesPredicate(columns, original) {
  const byName = new Map(columns.map((column) => [column.name, column]));
  const parts = [];
  const params = [];
  const names = [];
  for (const [name, rawValue] of Object.entries(original && typeof original === 'object' ? original : {})) {
    const column = byName.get(name);
    if (!column || rawValue === undefined) continue;
    if (/(virtual|stored) generated/i.test(column.extra || '')) continue;
    const spec = RowValues.describe(column);
    if (spec.kind === 'binary' && rawValue && typeof rawValue === 'object' && rawValue.kind === 'sha256') {
      if (!/^[a-f0-9]{64}$/.test(rawValue.value || '')) throw fail('Hash dữ liệu gốc không hợp lệ. Hãy tải lại bản ghi.', 'ROW_ORIGINAL_INCOMPLETE');
      parts.push(`SHA2(${quoteId(name)}, 256) <=> ?`);
      params.push(rawValue.value);
      names.push(name);
      continue;
    }
    if (spec.kind === 'binary' && typeof rawValue === 'string' && rawValue.includes('…')) {
      throw fail('Bản xem trước nhị phân thiếu hash dữ liệu gốc. Hãy tải lại bản ghi trước khi sửa/xóa.', 'ROW_ORIGINAL_INCOMPLETE');
    }
    let value = rawValue;
    if (value && typeof value === 'object' && !Buffer.isBuffer(value) && !ArrayBuffer.isView(value)) {
      value = isJsonColumn(column.type) ? JSON.stringify(value) : String(value);
    }
    if (spec.kind === 'json') {
      // Parse both operands as documents; binary comparison also works with MariaDB's JSON text representation.
      parts.push(`CAST(JSON_EXTRACT(${quoteId(name)}, '$') AS BINARY) <=> CAST(JSON_EXTRACT(?, '$') AS BINARY)`);
    } else if (['text', 'enum', 'set'].includes(spec.kind)) {
      parts.push(`CAST(${quoteId(name)} AS BINARY) <=> CAST(? AS BINARY)`);
    } else {
      parts.push(`${quoteId(name)} <=> ?`);
    }
    params.push(spec.kind === 'bit' ? rowKeyParameter(value, column) : coerceValue(value, column));
    names.push(name);
  }
  return { sql: parts.join(' AND '), params, names };
}

function rowKeySignature(row, pkColumns, byName) {
  return pkColumns.map((name) => {
    const value = row[name];
    if (value === null || value === undefined) return 'null';
    try {
      const parameter = rowKeyParameter(value, byName.get(name));
      if (Buffer.isBuffer(parameter)) return `0x${parameter.toString('hex')}`;
      return `${typeof parameter}:${String(parameter)}`;
    } catch {
      return `${typeof value}:${String(value)}`;
    }
  }).join('\u0000');
}

function importValueError(rowNumber, column, message) {
  const error = fail(`Dòng ${rowNumber}, cột "${column.name}": ${message}`, 'IMPORT_VALUE_INVALID');
  error.row = rowNumber;
  error.column = column.name;
  return error;
}

function validateImportValue(raw, column, rowNumber, nullSentinel) {
  let value = raw;
  if (nullSentinel && typeof value === 'string') {
    if (value === '\\N') value = null;
    else if (value === '\\\\N') value = '\\N';
  }
  if (isJsonNumber(value)) value = value.raw;
  if (value === undefined || value === null) {
    if (column.nullable !== 'YES' && !/auto_increment/i.test(column.extra)) {
      throw importValueError(rowNumber, column, 'không cho phép NULL.');
    }
    return null;
  }
  if (Buffer.isBuffer(value)) return value;
  if (isJsonColumn(column.type)) {
    if (typeof value === 'string') {
      const text = value.trim();
      if (!text) {
        if (column.nullable === 'YES') return null;
        throw importValueError(rowNumber, column, 'không được để trống.');
      }
      try {
        JSON.parse(text);
      } catch {
        throw importValueError(rowNumber, column, 'không phải JSON hợp lệ.');
      }
      return text;
    }
    if (typeof value === 'object') {
      try {
        return stringifyJsonValue(value);
      } catch {
        throw importValueError(rowNumber, column, 'không thể chuyển thành JSON.');
      }
    }
    throw importValueError(rowNumber, column, 'phải là chuỗi JSON.');
  }
  if (isBinaryColumn(column.type) && typeof value === 'string') {
    const match = /^0x([0-9a-f]*)$/i.exec(value.trim());
    if (match) {
      if (match[1].length % 2 !== 0) throw importValueError(rowNumber, column, 'dữ liệu hex có số ký tự lẻ.');
      const buffer = Buffer.from(match[1], 'hex');
      ensureImportByteLength(buffer.length, binaryLimit(column.type), rowNumber, column, 'Dữ liệu nhị phân');
      return buffer;
    }
    ensureImportByteLength(Buffer.byteLength(value, 'utf8'), binaryLimit(column.type), rowNumber, column, 'Dữ liệu nhị phân');
    return value;
  }
  if (typeof value === 'object') throw importValueError(rowNumber, column, 'không hỗ trợ giá trị object.');
  if (typeof value === 'boolean' && isNumericType(column.type)) return value ? 1 : 0;
  const text = typeof value === 'string' ? value : String(value);
  if (!text.trim() && (isNumericType(column.type) || isDateType(column.type))) {
    if (column.nullable === 'YES') return null;
    throw importValueError(rowNumber, column, 'không được để trống.');
  }
  try {
    const coerced = coerceValue(text, column);
    if (isTextColumn(column.type) && typeof coerced === 'string') {
      ensureImportByteLength(Buffer.byteLength(coerced, 'utf8'), textLimit(column.type), rowNumber, column, 'Chuỗi');
    }
    return coerced;
  } catch (error) {
    if (error && error.code === 'ROW_VALUE_INVALID') {
      const message = String(error.message || '').replace(/^Cột "[^"]*":\s*/, '');
      throw importValueError(rowNumber, column, message);
    }
    throw error;
  }
}

function resolveImportTargets(columns, headers, mapping) {
  const byExact = new Map(columns.map((column) => [column.name, column]));
  const byLower = new Map();
  for (const column of columns) {
    const key = column.name.toLowerCase();
    if (!byLower.has(key)) byLower.set(key, column);
  }
  const findTarget = (name) => byExact.get(name) || byLower.get(String(name).toLowerCase());
  const sourceIndex = new Map(headers.map((header, index) => [header, index]));
  const findSource = (name) => {
    const key = String(name);
    if (sourceIndex.has(key)) return key;
    const trimmed = key.trim();
    if (sourceIndex.has(trimmed)) return trimmed;
    throw fail(`Không tìm thấy cột nguồn "${key}" trong tệp.`, 'UNKNOWN_SOURCE_COLUMN');
  };
  const targets = [];
  const add = (column, source) => {
    if (/(virtual|stored) generated/i.test(column.extra)) {
      throw fail(`Cột "${column.name}" là cột sinh tự động nên không thể nhập.`, 'GENERATED_COLUMN');
    }
    if (targets.some((entry) => entry.column.name === column.name)) {
      throw fail(`Cột đích "${column.name}" được ánh xạ nhiều lần.`, 'DUPLICATE_MAPPING');
    }
    targets.push({ column, source, index: sourceIndex.get(source) });
  };
  if (mapping && typeof mapping === 'object' && !Array.isArray(mapping)) {
    for (const [targetName, sourceName] of Object.entries(mapping)) {
      if (sourceName === null || sourceName === undefined || sourceName === '') continue;
      const column = findTarget(targetName);
      if (!column) throw fail(`Không tìm thấy cột đích "${targetName}".`, 'UNKNOWN_COLUMN');
      add(column, findSource(sourceName));
    }
  } else {
    for (const header of headers) {
      const column = findTarget(String(header).trim());
      if (!column) continue;
      if (/(virtual|stored) generated/i.test(column.extra)) continue;
      if (targets.some((entry) => entry.column.name === column.name)) continue;
      add(column, header);
    }
  }
  if (!targets.length) throw fail('Không có cột nào khớp với bảng đích. Hãy chọn cột để nhập.', 'NO_MATCHING_COLUMNS');
  return targets;
}

function assertUniqueHeaders(headers) {
  const seen = new Set();
  for (const header of headers) {
    if (seen.has(header)) throw fail(`Tệp có cột trùng tên "${header}".`, 'DUPLICATE_HEADERS');
    seen.add(header);
  }
}

async function* readImportFile({ filePath, format, delimiter, hasHeader }, onBytes) {
  const parser = format === 'json'
    ? new JsonArrayStreamParser({ preserveNumbers: true })
    : new CsvStreamParser({ delimiter });
  const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
  let first = true;
  let headers = null;
  let rowNumber = 0;
  const consume = function* (entry) {
    if (format === 'json') {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || isJsonNumber(entry)) {
        throw fail('Mỗi phần tử JSON phải là một object.', 'INVALID_JSON_ROW');
      }
      rowNumber += 1;
      yield { kind: 'row', values: entry, rowNumber };
      return;
    }
    if (first) {
      first = false;
      if (hasHeader) {
        headers = entry.map((name) => String(name).trim());
        assertUniqueHeaders(headers);
        yield { kind: 'header', headers };
        return;
      }
      headers = entry.map((_value, index) => String(index));
      yield { kind: 'header', headers };
    }
    rowNumber += 1;
    if (entry.length !== headers.length) {
      throw fail(
        `Dòng dữ liệu ${rowNumber} có ${entry.length} cột nhưng cần ${headers.length} cột.`,
        'COLUMN_COUNT_MISMATCH'
      );
    }
    yield { kind: 'row', values: entry, rowNumber };
  };
  try {
    for await (const chunk of stream) {
      if (typeof onBytes === 'function') onBytes(Buffer.byteLength(chunk));
      for (const entry of parser.push(chunk)) yield* consume(entry);
    }
    for (const entry of parser.end()) yield* consume(entry);
  } finally {
    stream.destroy();
  }
}

function previewImportValue(value) {
  if (isJsonNumber(value)) {
    const numeric = Number(value.raw);
    return Number.isFinite(numeric) && String(numeric) === value.raw ? numeric : value.raw;
  }
  if (value && typeof value === 'object') return stringifyJsonValue(value);
  return value;
}

async function previewImportFile(options) {
  const settings = options && typeof options === 'object' ? options : {};
  if (typeof settings.filePath !== 'string' || !settings.filePath) {
    throw fail('Chưa chọn tệp để nhập.', 'INVALID_FILE');
  }
  const stat = await fs.promises.stat(settings.filePath);
  if (!stat.isFile()) throw fail('Đường dẫn đã chọn không phải là tệp.', 'INVALID_FILE');
  const format = normalizeFileFormat(settings.format, settings.filePath);
  const delimiter = normalizeDelimiter(format, settings.delimiter);
  const hasHeader = settings.hasHeader !== false;
  const limit = Math.min(PREVIEW_MAX_ROWS, Math.max(1, Number(settings.limit) || PREVIEW_ROW_LIMIT));
  const parser = format === 'json'
    ? new JsonArrayStreamParser({ preserveNumbers: true })
    : new CsvStreamParser({ delimiter });
  const stream = fs.createReadStream(settings.filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
  let bytes = 0;
  let headers = null;
  let first = true;
  let truncated = false;
  let done = false;
  const rows = [];
  const addHeader = (name) => {
    if (headers.includes(name)) return;
    headers.push(name);
    for (const row of rows) row.push(null);
  };
  const consume = (entry) => {
    if (format === 'json') {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || isJsonNumber(entry)) {
        throw fail('Mỗi phần tử JSON phải là một object.', 'INVALID_JSON_ROW');
      }
      if (!headers) headers = [];
      for (const key of Object.keys(entry)) addHeader(key);
      if (rows.length >= limit) {
        truncated = true;
        done = true;
        return;
      }
      rows.push(headers.map((key) => (entry[key] === undefined ? null : previewImportValue(entry[key]))));
      return;
    }
    if (first) {
      first = false;
      if (hasHeader) {
        headers = entry.map((name) => String(name).trim());
        assertUniqueHeaders(headers);
        return;
      }
      headers = entry.map((_value, index) => String(index));
    }
    if (entry.length !== headers.length) {
      throw fail(`Dòng dữ liệu ${rows.length + 1} có ${entry.length} cột nhưng cần ${headers.length} cột.`, 'COLUMN_COUNT_MISMATCH');
    }
    if (rows.length >= limit) {
      truncated = true;
      done = true;
      return;
    }
    rows.push(entry);
  };
  try {
    for await (const chunk of stream) {
      bytes += Buffer.byteLength(chunk);
      for (const entry of parser.push(chunk)) {
        consume(entry);
        if (done) break;
      }
      if (done) break;
    }
    if (!done) {
      for (const entry of parser.end()) {
        consume(entry);
        if (done) break;
      }
    }
  } finally {
    stream.destroy();
  }
  if (!headers) throw fail('Tệp không có dòng tiêu đề hoặc dữ liệu.', 'EMPTY_FILE');
  return {
    format,
    delimiter,
    hasHeader,
    headers,
    rows,
    sampledBytes: bytes,
    totalBytes: stat.size,
    truncated
  };
}

function statementCommand(sql) {
  const source = stripLeadingComments(sql).replace(
    /\/\*!\d{0,6}\s*([\s\S]*?)\*\//g,
    ' $1 '
  );
  const words = [];
  let state = 'normal';
  let escaped = false;
  let depth = 0;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === 'lineComment') {
      if (character === '\n' || character === '\r') state = 'normal';
      continue;
    }
    if (state === 'blockComment') {
      if (character === '*' && next === '/') {
        index += 1;
        state = 'normal';
      }
      continue;
    }
    if (state === 'single' || state === 'double') {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === (state === 'single' ? "'" : '"')) {
        if (next === character) index += 1;
        else state = 'normal';
      }
      continue;
    }
    if (state === 'backtick') {
      if (character === '`') {
        if (next === '`') index += 1;
        else state = 'normal';
      }
      continue;
    }
    if (character === "'") state = 'single';
    else if (character === '"') state = 'double';
    else if (character === '`') state = 'backtick';
    else if (character === '#') state = 'lineComment';
    else if (character === '-' && next === '-'
      && (source[index + 2] === undefined || source.charCodeAt(index + 2) <= 32)) {
      index += 1;
      state = 'lineComment';
    } else if (character === '/' && next === '*') {
      index += 1;
      state = 'blockComment';
    } else if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && /[A-Za-z_]/.test(character)) {
      let end = index + 1;
      while (end < source.length && /[A-Za-z0-9_$]/.test(source[end])) end += 1;
      words.push(source.slice(index, end).toUpperCase());
      index = end - 1;
    }
  }

  if (!words.length) return '';
  if (words[0] !== 'WITH') return words[0];
  const commands = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'TABLE']);
  return words.slice(1).find((word) => commands.has(word)) || 'WITH';
}

function isReadStatement(sql) {
  return /^(?:SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|TABLE)$/.test(statementCommand(sql));
}

function isConfirmationRequired(sql) {
  return /^(?:DROP|TRUNCATE|DELETE|UPDATE|ALTER|RENAME|REPLACE|GRANT|REVOKE)$/.test(statementCommand(sql));
}

function queryError(error) {
  return {
    message: error?.message || 'Đã xảy ra lỗi khi chạy truy vấn.',
    code: error?.code ? String(error.code) : '',
    sqlState: error?.sqlState ? String(error.sqlState) : ''
  };
}

function sshHostKeyFingerprint(key) {
  const value = Buffer.isBuffer(key) ? key : Buffer.from(key || '');
  return `SHA256:${crypto.createHash('sha256').update(value).digest('base64').replace(/=+$/, '')}`;
}

function verifySshHostKey(known, host, port, key) {
  const fingerprint = sshHostKeyFingerprint(key);
  const normalizedHost = String(host || '').trim().toLowerCase();
  const normalizedPort = Number(port) || 22;
  if (!known || typeof known !== 'object' || !known.fingerprint) {
    return {
      ok: false,
      code: 'SSH_HOST_KEY_UNKNOWN',
      fingerprint,
      message: `Chưa tin cậy SSH host key của ${normalizedHost}:${normalizedPort}. Fingerprint ${fingerprint}. Hãy xác nhận trước khi gửi thông tin đăng nhập.`
    };
  }
  if (String(known.host || '').trim().toLowerCase() !== normalizedHost || (Number(known.port) || 22) !== normalizedPort) {
    return {
      ok: false,
      code: 'SSH_HOST_KEY_UNKNOWN',
      fingerprint,
      message: `SSH host/port đã thay đổi so với khóa đã tin cậy. Fingerprint mới ${fingerprint}. Hãy xác nhận lại.`
    };
  }
  if (known.fingerprint !== fingerprint) {
    return {
      ok: false,
      code: 'SSH_HOST_KEY_CHANGED',
      fingerprint,
      expectedFingerprint: known.fingerprint,
      message: `SSH host key đã thay đổi! Fingerprint mới ${fingerprint}, trước đó ${known.fingerprint}. Không kết nối cho đến khi bạn xác nhận.`
    };
  }
  return { ok: true, fingerprint };
}

class DatabaseSession {
  constructor(profile) {
    this.profile = profile;
    this.database = profile.database || null;
    this.connection = null;
    this.ssh = null;
    this.dead = false;
    this.version = null;
    this.cancelQuery = null;
    this.activeTask = null;
    this.inTransaction = false;
    this.autocommit = true;
    this.metadata = new Map();
    this.tableDataService = new TableDataService({
      columns: (...args) => this.listColumns(...args), raw: (...args) => this.raw(...args),
      quoteId, tableRef, serializeRow, originalHashes, keyParameter: rowKeyParameter, searchParameter: coerceValue
    });
  }

  setActiveTask(taskId, cancel) {
    const task = { id: taskId || null, cancel, canceled: false };
    this.activeTask = task;
    return task;
  }

  clearActiveTask(task) {
    if (this.activeTask === task) this.activeTask = null;
  }

  cancelTask(taskId) {
    const task = this.activeTask;
    if (!task) return false;
    if (taskId && task.id !== taskId) return false;
    task.canceled = true;
    try {
      task.cancel();
    } catch {
      // the task owner reports the failure
    }
    return true;
  }

  async openSshTunnel() {
    const ssh = this.profile.ssh;
    return new Promise((resolve, reject) => {
      const client = new SshClient();
      let settled = false;
      let hostKeyFailure = null;
      const failConnect = (error) => {
        if (settled) return;
        settled = true;
        try {
          client.end();
        } catch {
          // ignore
        }
        reject(error);
      };
      client.on('ready', () => {
        client.forwardOut('127.0.0.1', 0, this.profile.host, this.profile.port, (error, stream) => {
          if (error) {
            failConnect(fail(`Không tạo được SSH tunnel: ${error.message}`));
            return;
          }
          if (settled) {
            stream.destroy();
            return;
          }
          settled = true;
          this.ssh = client;
          resolve(stream);
        });
      });
      client.on('error', (error) => failConnect(hostKeyFailure || fail(`SSH: ${error.message}`)));
      const options = {
        host: ssh.host,
        port: ssh.port,
        username: ssh.user,
        readyTimeout: 15000,
        keepaliveInterval: 15000,
        keepaliveCountMax: 3,
        hostVerifier: (key) => {
          const result = verifySshHostKey(ssh.knownHostKey, ssh.host, ssh.port, key);
          if (result.ok) return true;
          hostKeyFailure = fail(result.message, result.code);
          hostKeyFailure.fingerprint = result.fingerprint;
          if (result.expectedFingerprint) hostKeyFailure.expectedFingerprint = result.expectedFingerprint;
          return false;
        }
      };
      if (ssh.authMethod === 'key') {
        try {
          options.privateKey = fs.readFileSync(ssh.privateKeyPath);
        } catch {
          failConnect(fail(`Không đọc được SSH private key: ${ssh.privateKeyPath}`));
          return;
        }
        if (ssh.passphrase) options.passphrase = ssh.passphrase;
      } else {
        options.password = ssh.password || '';
      }
      try {
        client.connect(options);
      } catch (error) {
        failConnect(error);
      }
    });
  }

  buildMysqlOptions(stream) {
    const profile = this.profile;
    const options = {
      user: profile.user,
      password: profile.password || '',
      connectTimeout: 15000,
      charset: 'utf8mb4',
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
      jsonStrings: true,
      // UPDATE affectedRows counts matched rows, including assignments to the same value.
      flags: ['FOUND_ROWS'],
      multipleStatements: false,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000
    };
    if (stream) {
      options.stream = stream;
    } else {
      options.host = profile.host;
      options.port = profile.port;
    }
    if (profile.database) options.database = profile.database;
    if (profile.ssl && profile.ssl.enabled) {
      options.ssl = { rejectUnauthorized: profile.ssl.verify === true };
      if (profile.ssl.passphrase) options.ssl.passphrase = profile.ssl.passphrase;
      for (const [key, filePath] of [['ca', profile.ssl.ca], ['cert', profile.ssl.cert], ['key', profile.ssl.key]]) {
        if (!filePath) continue;
        try {
          options.ssl[key] = fs.readFileSync(filePath);
        } catch {
          throw fail(`Không đọc được tệp SSL ${key}: ${filePath}`);
        }
      }
    }
    if (profile.allowCleartextPassword === true) {
      const verifiedTls = options.ssl && options.ssl.rejectUnauthorized === true;
      const sshToLocalMysql = profile.ssh?.enabled === true
        && Boolean(profile.ssh.knownHostKey && profile.ssh.knownHostKey.fingerprint)
        && ['localhost', '127.0.0.1', '::1'].includes(String(profile.host || '').toLowerCase());
      if (!verifiedTls && !sshToLocalMysql) {
        throw fail('mysql_clear_password yêu cầu TLS đã xác thực hoặc SSH tunnel đã xác thực host key tới MySQL trên chính máy SSH (host localhost/127.0.0.1/::1).');
      }
      options.enableCleartextPlugin = true;
    }
    return options;
  }

  async connect() {
    if (this.connection) await this.close();
    this.dead = false;
    let stream = null;
    if (this.profile.ssh && this.profile.ssh.enabled) stream = await this.openSshTunnel();
    let connection;
    try {
      connection = mysql.createConnection(this.buildMysqlOptions(stream));
      await new Promise((resolve, reject) => {
        connection.connect((error) => (error ? reject(error) : resolve()));
      });
      this.connection = connection;
      const result = await this.raw('SELECT VERSION() AS version');
      this.version = result.rows[0] ? result.rows[0].version : '';
    } catch (error) {
      this.dead = true;
      try {
        connection?.destroy();
      } catch {
        // ignore
      }
      this.closeSsh();
      throw error;
    }
  }

  closeSsh() {
    if (!this.ssh) return;
    try {
      this.ssh.end();
    } catch {
      // ignore
    }
    this.ssh = null;
  }

  async close() {
    if (this.cancelQuery) {
      try {
        this.cancelQuery();
      } catch {
        // ignore
      }
    }
    const connection = this.connection;
    this.connection = null;
    this.dead = true;
    if (connection) {
      await new Promise((resolve) => {
        let finished = false;
        const finish = (force = false) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          if (force) { try { connection.destroy(); } catch { /* Already closed. */ } }
          resolve();
        };
        const timer = setTimeout(() => finish(true), 1000);
        try {
          connection.end(() => {
            finish();
          });
        } catch {
          finish(true);
        }
      });
    }
    this.closeSsh();
  }

  ensureOpen() {
    if (!this.connection || this.dead) throw fail('Phiên kết nối đã đóng. Hãy kết nối lại.', 'SESSION_CLOSED');
  }

  updateServerStatus(result) {
    if (!Number.isInteger(result?.serverStatus)) return;
    this.inTransaction = Boolean(result.serverStatus & 1);
    this.autocommit = Boolean(result.serverStatus & 2);
  }

  raw(sql, params = []) {
    this.ensureOpen();
    return new Promise((resolve, reject) => {
      this.connection.query(sql, params, (error, result, fields) => {
        if (error) {
          reject(error);
          return;
        }
        this.updateServerStatus(result);
        if (/^(INSERT|UPDATE|DELETE|REPLACE|TRUNCATE|ALTER|DROP|CREATE|RENAME)$/.test(statementCommand(sql))) this.tableDataService.invalidate();
        resolve({ result, fields, rows: Array.isArray(result) ? result : [] });
      });
    });
  }

  async serverInfo() {
    return { version: this.version, database: this.profile.database || null };
  }

  async listDatabases() {
    const { result } = await this.raw('SHOW DATABASES');
    return result.map((row) => Object.values(row)[0]).filter((name) => typeof name === 'string');
  }

  async useDatabase(database) {
    if (typeof database !== 'string' || !database) throw fail('Database không hợp lệ.', 'INVALID_DATABASE');
    await this.raw(`USE ${quoteId(database)}`);
    this.database = database;
    return { database };
  }

  async listTables(database) {
    const { result } = await this.raw(
      `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine,
              TABLE_ROWS AS rowEstimate, TABLE_COMMENT AS comment
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME`,
      [database]
    );
    return result.map((row) => ({
      name: row.name,
      type: /view/i.test(row.type) ? 'view' : 'table',
      engine: row.engine || '',
      rowEstimate: row.rowEstimate === null ? null : Number(row.rowEstimate),
      comment: row.comment || ''
    }));
  }

  async listRoutines(database) {
    const { result } = await this.raw(
      `SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type, DATA_TYPE AS returnType,
              IS_DETERMINISTIC AS \`deterministic\`, SECURITY_TYPE AS security,
              DEFINER AS definer, ROUTINE_COMMENT AS comment,
              CREATED AS createdAt, LAST_ALTERED AS updatedAt
         FROM information_schema.ROUTINES
        WHERE ROUTINE_SCHEMA = ?
        ORDER BY ROUTINE_TYPE, ROUTINE_NAME`,
      [database]
    );
    return result.map((row) => ({
      name: row.name,
      type: String(row.type || '').toLowerCase() === 'function' ? 'function' : 'procedure',
      returnType: row.returnType || null,
      deterministic: String(row.deterministic || '').toUpperCase() === 'YES',
      security: row.security || '',
      definer: row.definer || '',
      comment: row.comment || '',
      createdAt: row.createdAt || null,
      updatedAt: row.updatedAt || null
    }));
  }

  async listEvents(database) {
    const { result } = await this.raw(
      `SELECT EVENT_NAME AS name, STATUS AS status, EVENT_TYPE AS type,
              ON_COMPLETION AS onCompletion, INTERVAL_VALUE AS intervalValue,
              INTERVAL_FIELD AS intervalField, STARTS AS starts, ENDS AS ends,
              LAST_EXECUTED AS lastExecuted, DEFINER AS definer, EVENT_COMMENT AS comment
         FROM information_schema.EVENTS
        WHERE EVENT_SCHEMA = ?
        ORDER BY EVENT_NAME`,
      [database]
    );
    return result.map((row) => ({
      name: row.name,
      status: row.status || '',
      type: row.type || '',
      onCompletion: row.onCompletion || '',
      intervalValue: row.intervalValue === null ? null : String(row.intervalValue),
      intervalField: row.intervalField || '',
      starts: row.starts || null,
      ends: row.ends || null,
      lastExecuted: row.lastExecuted || null,
      definer: row.definer || '',
      comment: row.comment || ''
    }));
  }

  async showCreate(database, name, kind) {
    const allowed = ['procedure', 'function', 'event', 'trigger', 'view', 'table'];
    if (!allowed.includes(kind)) throw fail('Loại đối tượng không hỗ trợ SHOW CREATE.', 'INVALID_OBJECT_TYPE');
    if (typeof database !== 'string' || !database || typeof name !== 'string' || !name) {
      throw fail('Tham số SHOW CREATE không hợp lệ.', 'INVALID_DATABASE');
    }
    const { result } = await this.raw(`SHOW CREATE ${kind.toUpperCase()} ${quoteId(database)}.${quoteId(name)}`);
    const row = result[0] || {};
    const sqlKey = Object.keys(row).find((key) => /^Create /i.test(key));
    return {
      kind,
      database,
      name,
      sql: sqlKey ? String(row[sqlKey]) : '',
      meta: Object.fromEntries(Object.entries(row).filter(([key]) => key !== sqlKey))
    };
  }

  async listColumns(database, table) {
    const cacheKey = `columns:${database}.${table}`;
    if (this.metadata.has(cacheKey)) return this.metadata.get(cacheKey);
    const { result } = await this.raw(
      `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable,
              COLUMN_DEFAULT AS defaultValue, COLUMN_KEY AS keyType, EXTRA AS extra,
              COLUMN_COMMENT AS comment, ORDINAL_POSITION AS position
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION`,
      [database, table]
    );
    const columns = result.map((row) => ({
      name: row.name,
      type: row.type,
      nullable: row.nullable,
      defaultValue: row.defaultValue,
      key: row.keyType,
      extra: row.extra || '',
      comment: row.comment || '',
      position: Number(row.position)
    }));
    this.metadata.set(cacheKey, columns);
    return columns;
  }

  async listIndexes(database, table) {
    const cacheKey = `indexes:${database}.${table}`;
    if (this.metadata.has(cacheKey)) return this.metadata.get(cacheKey);
    const { result } = await this.raw(
      `SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique, SEQ_IN_INDEX AS sequence,
              COLUMN_NAME AS columnName, INDEX_TYPE AS type, CARDINALITY AS cardinality
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
      [database, table]
    );
    const indexes = new Map();
    for (const row of result) {
      if (!indexes.has(row.name)) {
        indexes.set(row.name, {
          name: row.name,
          unique: Number(row.nonUnique) === 0,
          type: row.type,
          cardinality: row.cardinality === null ? null : Number(row.cardinality),
          columns: []
        });
      }
      indexes.get(row.name).columns.push({ name: row.columnName, sequence: Number(row.sequence) });
    }
    const value = [...indexes.values()];
    this.metadata.set(cacheKey, value);
    return value;
  }

  async listRelations(database, table) {
    const outboundSql = `SELECT CONSTRAINT_NAME AS name, TABLE_NAME AS tableName, COLUMN_NAME AS columnName,
                                REFERENCED_TABLE_SCHEMA AS refDatabase, REFERENCED_TABLE_NAME AS refTable,
                                REFERENCED_COLUMN_NAME AS refColumn
                           FROM information_schema.KEY_COLUMN_USAGE
                          WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL
                            ${table ? 'AND TABLE_NAME = ?' : ''}
                          ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`;
    const outboundParams = table ? [database, table] : [database];
    const { result } = await this.raw(outboundSql, outboundParams);
    let inbound = [];
    if (table) {
      const inboundResult = await this.raw(
        `SELECT CONSTRAINT_NAME AS name, TABLE_NAME AS tableName, COLUMN_NAME AS columnName,
                REFERENCED_TABLE_SCHEMA AS refDatabase, REFERENCED_TABLE_NAME AS refTable,
                REFERENCED_COLUMN_NAME AS refColumn
           FROM information_schema.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME = ?
          ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`,
        [database, database, table]
      );
      inbound = inboundResult.result;
    }
    const normalize = (row) => ({
      name: row.name,
      table: row.tableName,
      column: row.columnName,
      refTable: row.refTable,
      refColumn: row.refColumn,
      refDatabase: row.refDatabase
    });
    return {
      outbound: result.map(normalize),
      inbound: inbound.map(normalize)
    };
  }

  async primaryKey(database, table) {
    const columns = await this.listColumns(database, table);
    return columns.filter((column) => column.key === 'PRI').map((column) => column.name);
  }

  tableData(options) {
    return this.tableDataService.read(options);
  }

  countTableRows(options) {
    return this.tableDataService.count(options);
  }

  async interruptRead(connection) {
    if (!Number.isInteger(connection.threadId) || connection.threadId <= 0) return false;
    const control = new DatabaseSession({ ...this.profile, database: null });
    try {
      await control.connect();
      if (this.dead || this.connection !== connection) return false;
      await control.raw(`KILL QUERY ${connection.threadId}`);
      return true;
    } finally { await control.close(); }
  }

  async runQuery(sql, timeoutMs = 30000, rowLimit = MAX_QUERY_ROWS, byteLimit = MAX_QUERY_BYTES) {
    this.ensureOpen();
    const statement = String(sql || '').trim();
    if (!statement) throw fail('Câu lệnh SQL đang trống.', 'EMPTY_QUERY');
    if (statement.length > 1024 * 1024) throw fail('Câu lệnh SQL vượt quá 1 MB.', 'QUERY_TOO_LARGE');
    const startedAt = Date.now();
    if (!isReadStatement(statement)) {
      return new Promise((resolve, reject) => {
        const connection = this.connection;
        let settled = false;
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.cancelQuery = null;
          fn(value);
        };
        const timer = setTimeout(() => {
          this.dead = true;
          try {
            connection.destroy();
          } catch {
            // ignore
          }
          finish(reject, fail('Truy vấn quá thời gian cho phép.', 'QUERY_TIMEOUT'));
        }, timeoutMs);
        this.cancelQuery = () => {
          this.dead = true;
          try {
            connection.destroy();
          } catch {
            // ignore
          }
          finish(reject, fail('Đã hủy truy vấn.', 'QUERY_CANCELED'));
        };
        connection.query(statement, (error, result) => {
          if (settled) return;
          if (error) {
            finish(reject, error);
            return;
          }
          this.metadata.clear();
          this.tableDataService.invalidate();
          this.updateServerStatus(result);
          finish(resolve, {
            kind: 'ok',
            affectedRows: result?.affectedRows ?? 0,
            changedRows: result?.changedRows ?? 0,
            insertId: result?.insertId !== undefined ? String(result.insertId) : null,
            info: result?.info || '',
            durationMs: Date.now() - startedAt
          });
        });
      });
    }
    return new Promise((resolve, reject) => {
      const connection = this.connection;
      let settled = false;
      let columns = [];
      const budget = new ResultBudget({ rows: Math.max(0, Math.min(MAX_QUERY_ROWS, Number(rowLimit) || 0)), bytes: Math.max(0, Math.min(MAX_QUERY_BYTES, Number(byteLimit) || 0)) });
      const rows = budget.rows;
      const hashes = [];
      let truncated = false;
      let stopping = null;
      let stoppedEarly = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.cancelQuery = null;
        fn(value);
      };
      const stopConnection = () => {
        this.dead = true;
        try {
          connection.destroy();
        } catch {
          // ignore
        }
      };
      const timer = setTimeout(() => {
        stopConnection();
        finish(reject, fail('Truy vấn quá thời gian cho phép.', 'QUERY_TIMEOUT'));
      }, timeoutMs);
      this.cancelQuery = () => {
        stopConnection();
        finish(reject, fail('Đã hủy truy vấn.', 'QUERY_CANCELED'));
      };
      let query;
      try {
        // Static array parsing also accepts column aliases such as __proto__.
        query = connection.query({ sql: statement, rowsAsArray: true, disableEval: true });
      } catch (error) {
        finish(reject, error);
        return;
      }
      query.on('fields', (fields) => {
        columns = fields.map((field) => ({
          name: field.name,
          orgName: field.orgName || field.name,
          table: field.table || '',
          orgTable: field.orgTable || field.table || '',
          db: field.schema || field.db || '',
          flags: typeof field.flags === 'number' ? field.flags : 0,
          type: TYPE_NAMES[field.columnType] || String(field.columnType)
        }));
      });
      const complete = () => {
        const done = () => finish(resolve, {
          kind: 'rows', columns, rows, originalHashes: hashes, truncated, bytes: budget.bytes,
          truncationReason: budget.reason, stoppedEarly, durationMs: Date.now() - startedAt
        });
        if (stopping) stopping.then(done);
        else done();
      };
      query.on('result', (row) => {
        if (settled) return;
        if (truncated) return;
        const values = Array.isArray(row) ? row : Object.values(row || {});
        if (budget.add(values.map(serializeValue))) { hashes.push(originalHashes(values)); return; }
        truncated = true;
        if (Number.isInteger(connection.threadId) && connection.pause && connection.resume) {
          connection.pause();
          stopping = this.interruptRead(connection).then((stopped) => { stoppedEarly = stopped; }, () => {})
            .finally(() => { if (!settled && !this.dead) connection.resume(); });
        }
      });
      query.on('error', (error) => {
        if (stopping && error.code === 'ER_QUERY_INTERRUPTED') complete();
        else finish(reject, error);
      });
      query.on('end', complete);
    });
  }

  async runQueryScript(sql, timeoutMs = 30000, confirmed = false, taskId = null) {
    this.ensureOpen();
    if (this.activeTask) throw fail('Phiên kết nối đang chạy một tác vụ khác.', 'SESSION_BUSY');
    const source = String(sql || '').trim();
    if (!source) throw fail('Câu lệnh SQL đang trống.', 'EMPTY_QUERY');
    if (source.length > 1024 * 1024) throw fail('Nội dung SQL vượt quá 1 MB.', 'QUERY_TOO_LARGE');

    let statements;
    try {
      statements = splitSqlStatements(source);
    } catch (error) {
      throw fail(error.message, 'INVALID_SQL_SCRIPT');
    }
    if (!statements.length) throw fail('Không tìm thấy câu lệnh SQL để chạy.', 'EMPTY_QUERY');
    if (statements.length > MAX_QUERY_STATEMENTS) {
      throw fail(`Mỗi lần chỉ được chạy tối đa ${MAX_QUERY_STATEMENTS} câu lệnh.`, 'TOO_MANY_STATEMENTS');
    }
    if (!confirmed) {
      const dangerous = statements
        .map((statement, index) => ({ statement, index }))
        .filter(({ statement }) => isConfirmationRequired(statement));
      if (dangerous.length) {
        const numbers = dangerous.map(({ index }) => index + 1).join(', ');
        throw fail(`Câu lệnh #${numbers} có thể thay đổi hoặc xóa dữ liệu.`, 'CONFIRM_REQUIRED');
      }
    }

    const task = this.setActiveTask(taskId, () => {
      if (this.cancelQuery) this.cancelQuery();
    });
    try {
      if (statements.length === 1) {
        const result = await this.runQuery(statements[0], timeoutMs);
        if (statementCommand(statements[0]) === 'USE') {
          try {
            const current = await this.raw('SELECT DATABASE() AS value');
            result.activeDatabase = current.rows[0]?.value || null;
            this.database = result.activeDatabase;
          } catch {
            // Preserve the successful USE result if metadata cannot be read.
          }
        }
        return result;
      }

      const startedAt = Date.now();
      const deadline = startedAt + Math.max(1, Number(timeoutMs) || 30000);
      const results = [];
      let storedRows = 0;
      let storedBytes = 0;
      for (let index = 0; index < statements.length; index += 1) {
        if (task.canceled) break;
        const statement = statements[index];
        const database = this.database;
        try {
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) throw fail('Truy vấn quá thời gian cho phép.', 'QUERY_TIMEOUT');
          const result = await this.runQuery(
            statement,
            remainingMs,
            Math.max(0, MAX_QUERY_BATCH_ROWS - storedRows),
            Math.max(0, MAX_QUERY_BATCH_BYTES - storedBytes)
          );
          if (result.kind === 'rows') storedRows += result.rows.length;
          if (result.kind === 'rows') storedBytes += result.bytes || 0;
          results.push({ index: index + 1, sql: statement, database, ok: true, result });
          if (statementCommand(statement) === 'USE') {
            try {
              const current = await this.raw('SELECT DATABASE() AS value');
              this.database = current.rows[0]?.value || null;
            } catch {
              this.database = null;
            }
          }
        } catch (error) {
          results.push({ index: index + 1, sql: statement, ok: false, error: queryError(error) });
          break;
        }
      }
      if (task.canceled) {
        const error = fail('Đã hủy tác vụ SQL.', 'QUERY_CANCELED');
        error.partial = { executedCount: results.length, statementCount: statements.length };
        throw error;
      }
      let activeDatabase;
      if (results.some((entry) => entry.ok && statementCommand(entry.sql) === 'USE')) {
        try {
          const current = await this.raw('SELECT DATABASE() AS value');
          activeDatabase = current.rows[0]?.value || null;
        } catch {
          // The original statement results remain useful if the session closed.
        }
      }
      return {
        kind: 'batch',
        statementCount: statements.length,
        executedCount: results.length,
        succeededCount: results.filter((entry) => entry.ok).length,
        failedCount: results.filter((entry) => !entry.ok).length,
        stopped: results.length < statements.length || results.some((entry) => !entry.ok),
        truncated: results.some((entry) => entry.ok && entry.result?.truncated),
        ...(activeDatabase !== undefined ? { activeDatabase } : {}),
        results,
        durationMs: Date.now() - startedAt
      };
    } finally {
      this.clearActiveTask(task);
    }
  }

  async insertRow({ database, table, values }) {
    const columns = await this.listColumns(database, table);
    const byName = new Map(columns.map((column) => [column.name, column]));
    const entries = Object.entries(values || {})
      .filter(([name]) => byName.has(name))
      .filter(([name]) => !/auto_increment/i.test(byName.get(name).extra) && !/(virtual|stored) generated/i.test(byName.get(name).extra));
    if (!entries.length) {
      const { result } = await this.raw(`INSERT INTO ${tableRef(database, table)} () VALUES ()`);
      return { insertId: String(result.insertId), affectedRows: result.affectedRows };
    }
    const names = entries.map(([name]) => name);
    const params = entries.map(([name, value]) => coerceValue(value, byName.get(name)));
    const placeholders = names.map(() => '?').join(', ');
    const { result } = await this.raw(
      `INSERT INTO ${tableRef(database, table)} (${names.map(quoteId).join(', ')}) VALUES (${placeholders})`,
      params
    );
    return { insertId: String(result.insertId), affectedRows: result.affectedRows };
  }

  async updateRow({ database, table, keys, values, original }) {
    const columns = await this.listColumns(database, table);
    const byName = new Map(columns.map((column) => [column.name, column]));
    const pkColumns = columns.filter((column) => column.key === 'PRI').map((column) => column.name);
    if (!pkColumns.length) throw fail('Bảng không có khóa chính nên không thể sửa trực tiếp.', 'NO_PRIMARY_KEY');
    for (const pk of pkColumns) {
      if (!keys || !(pk in keys)) throw fail('Thiếu giá trị khóa chính để cập nhật.', 'MISSING_PRIMARY_KEY');
    }
    const changes = Object.entries(values || {})
      .filter(([name]) => byName.has(name))
      .filter(([name]) => !/(virtual|stored) generated/i.test(byName.get(name).extra));
    if (!changes.length) throw fail('Không có cột hợp lệ để cập nhật.', 'NO_ROW_CHANGES');
    const guard = originalValuesPredicate(columns, original);
    const setSql = changes.map(([name]) => `${quoteId(name)} = ?`).join(', ');
    const whereSql = [
      pkColumns.map((name) => `${quoteId(name)} <=> ?`).join(' AND '),
      guard.sql
    ].filter(Boolean).join(' AND ');
    const pkParams = pkColumns.map((name) => rowKeyParameter(keys[name], byName.get(name)));
    const params = [
      ...changes.map(([name, value]) => coerceValue(value, byName.get(name))),
      ...pkParams,
      ...guard.params
    ];
    const { result } = await this.raw(
      `UPDATE ${tableRef(database, table)} SET ${setSql} WHERE ${whereSql} LIMIT 1`,
      params
    );
    if (Number(result.affectedRows) !== 1) {
      if (!guard.sql) {
        throw fail('Bản ghi không còn tồn tại hoặc khóa chính đã thay đổi. Nội dung đang sửa được giữ lại; hãy hủy chỉnh sửa và tải lại dữ liệu để kiểm tra.', 'ROW_NOT_FOUND');
      }
      const wherePk = pkColumns.map((name) => `${quoteId(name)} <=> ?`).join(' AND ');
      const exists = await this.raw(
        `SELECT 1 AS present FROM ${tableRef(database, table)} WHERE ${wherePk} LIMIT 1`,
        pkParams
      );
      if (!(exists.rows || []).length) {
        throw fail('Bản ghi đã bị xóa bởi kết nối khác. Nội dung đang sửa được giữ lại; hãy hủy chỉnh sửa và tải lại dữ liệu.', 'ROW_NOT_FOUND');
      }
      const current = await this.raw(
        `SELECT * FROM ${tableRef(database, table)} WHERE ${wherePk} LIMIT 1`,
        pkParams
      );
      const columnNames = new Set(guard.names);
      const details = Object.fromEntries(Object.entries(original || {}).filter(([name]) => columnNames.has(name)));
      const error = fail(
        'Bản ghi đã thay đổi bởi kết nối khác từ lúc bạn mở. Nội dung đang sửa được giữ lại; hãy xem khác biệt và tải lại trước khi ghi tiếp.',
        'ROW_CONFLICT'
      );
      error.conflict = {
        table,
        database,
        original: details,
        current: current.rows?.[0] ? serializeRow(current.rows[0]) : null
      };
      throw error;
    }
    return {
      status: result.changedRows ? 'updated' : 'unchanged',
      matchedRows: 1,
      affectedRows: result.affectedRows,
      changedRows: result.changedRows,
      ...(guard.sql ? { guardedBy: 'original-values' } : {})
    };
  }

  async deleteRows({ database, table, keysList, originalValues }) {
    if (!Array.isArray(keysList) || !keysList.length) throw fail('Chưa chọn bản ghi cần xóa.', 'NO_ROWS');
    if (keysList.length > 1000) throw fail('Chỉ có thể xóa tối đa 1000 bản ghi mỗi lần.', 'TOO_MANY_ROWS');
    const columns = await this.listColumns(database, table);
    const byName = new Map(columns.map((column) => [column.name, column]));
    const pkColumns = columns.filter((column) => column.key === 'PRI').map((column) => column.name);
    if (!pkColumns.length) throw fail('Bảng không có khóa chính nên không thể xóa trực tiếp.', 'NO_PRIMARY_KEY');
    const groups = [];
    const params = [];
    for (const keys of keysList) {
      if (!keys || pkColumns.some((name) => !(name in keys))) continue;
      groups.push(`(${pkColumns.map((name) => `${quoteId(name)} <=> ?`).join(' AND ')})`);
      for (const name of pkColumns) params.push(rowKeyParameter(keys[name], byName.get(name)));
    }
    if (!groups.length) throw fail('Không xác định được khóa chính của bản ghi.', 'MISSING_PRIMARY_KEY');
    const originals = Array.isArray(originalValues) ? originalValues : [];
    const guarded = originals.some((entry) => entry && typeof entry === 'object');
    if (!guarded) {
      const { result } = await this.raw(
        `DELETE FROM ${tableRef(database, table)} WHERE ${groups.join(' OR ')}`,
        params
      );
      return { affectedRows: result.affectedRows, guardedBy: 'primary-key' };
    }

    const expected = [];
    const seen = new Set();
    for (let index = 0; index < keysList.length; index += 1) {
      const keys = keysList[index];
      if (!keys || pkColumns.some((name) => !(name in keys))) continue;
      const signature = rowKeySignature(keys, pkColumns, byName);
      if (seen.has(signature)) continue;
      seen.add(signature);
      expected.push({ keys, original: originals[index], signature });
    }
    if (!expected.length) throw fail('Không xác định được khóa chính của bản ghi.', 'MISSING_PRIMARY_KEY');
    const matchExpressions = expected.map((entry) => {
      const guard = originalValuesPredicate(columns, entry.original);
      const pkPredicate = pkColumns.map((name) => `${quoteId(name)} <=> ?`).join(' AND ');
      const all = [pkPredicate, guard.sql].filter(Boolean).join(' AND ');
      return { sql: `(${all})`, params: [...pkColumns.map((name) => rowKeyParameter(entry.keys[name], byName.get(name))), ...guard.params] };
    });
    const aliasParams = matchExpressions.flatMap((entry) => entry.params);
    const whereParams = expected.flatMap((entry) => pkColumns.map((name) => rowKeyParameter(entry.keys[name], byName.get(name))));
    const uniqueGroups = expected.map(() => `(${pkColumns.map((name) => `${quoteId(name)} <=> ?`).join(' AND ')})`);
    const selectSql = `SELECT ${pkColumns.map(quoteId).join(', ')}, ${matchExpressions.map((entry, index) => `(${entry.sql}) AS m${index}`).join(', ')} FROM ${tableRef(database, table)} WHERE ${uniqueGroups.join(' OR ')} FOR UPDATE`;
    const ownTransaction = !this.inTransaction && this.autocommit !== false;
    const savepoint = quoteId(`sqlpro_delete_${crypto.randomBytes(12).toString('hex')}`);
    let transactionOpen = false;
    let savepointOpen = false;
    const transactionCommand = (method) => new Promise((resolve, reject) => {
      this.connection[method]((error, result) => {
        if (error) { reject(error); return; }
        this.updateServerStatus(result);
        resolve();
      });
    });
    try {
      if (ownTransaction) {
        await transactionCommand('beginTransaction');
        transactionOpen = true;
        this.inTransaction = true;
      } else {
        await this.raw(`SAVEPOINT ${savepoint}`);
        savepointOpen = true;
      }
      const rows = (await this.raw(selectSql, [...aliasParams, ...whereParams])).rows || [];
      this.inTransaction = true;
      const bySignature = new Map();
      for (const row of rows) {
        bySignature.set(rowKeySignature(row, pkColumns, byName), row);
      }
      const missing = [];
      const conflicts = [];
      for (let index = 0; index < expected.length; index += 1) {
        const row = bySignature.get(expected[index].signature);
        if (!row) {
          missing.push(expected[index].keys);
        } else if (Number(row[`m${index}`]) !== 1) {
          conflicts.push(expected[index].keys);
        }
      }
      if (missing.length || conflicts.length) {
        const error = fail(
          missing.length
            ? `${missing.length} bản ghi đã bị xóa bởi kết nối khác; không có bản ghi nào bị xóa. Hãy tải lại dữ liệu.`
            : `${conflicts.length} bản ghi đã thay đổi bởi kết nối khác; không có bản ghi nào bị xóa. Hãy tải lại dữ liệu.`,
          missing.length ? 'ROW_NOT_FOUND' : 'ROW_CONFLICT'
        );
        error.missing = missing;
        error.conflicts = conflicts;
        throw error;
      }
      const { result } = await this.raw(
        `DELETE FROM ${tableRef(database, table)} WHERE ${uniqueGroups.join(' OR ')}`,
        whereParams
      );
      if (Number(result.affectedRows) !== expected.length) {
        const error = fail('Số bản ghi xóa không khớp với dữ liệu đã kiểm tra; thao tác đã dừng.', 'ROW_CONFLICT');
        error.affectedRows = result.affectedRows;
        throw error;
      }
      if (transactionOpen) {
        await transactionCommand('commit');
        transactionOpen = false;
        this.inTransaction = false;
      } else if (savepointOpen) {
        await this.raw(`RELEASE SAVEPOINT ${savepoint}`);
        savepointOpen = false;
      }
      return { affectedRows: result.affectedRows, guardedBy: 'original-values', transaction: ownTransaction ? 'statement' : 'existing' };
    } catch (error) {
      if (transactionOpen) {
        try { await transactionCommand('rollback'); this.inTransaction = false; }
        catch (cleanupError) { error.rollbackCode = cleanupError.code || 'ROLLBACK_FAILED'; }
      } else if (savepointOpen) {
        try {
          await this.raw(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await this.raw(`RELEASE SAVEPOINT ${savepoint}`);
        } catch (cleanupError) { error.rollbackCode = cleanupError.code || 'ROLLBACK_FAILED'; }
      }
      if (error.rollbackCode) error.message += ' Không xác nhận được việc hoàn tác phạm vi xóa. Hãy kiểm tra transaction trước khi thao tác tiếp.';
      throw error;
    }
  }

  async exportTableFile(options, write, onProgress) {
    this.ensureOpen();
    const settings = options && typeof options === 'object' ? options : {};
    const database = settings.database;
    const table = settings.table;
    if (typeof database !== 'string' || !database) throw fail('Database không hợp lệ.', 'INVALID_DATABASE');
    if (typeof table !== 'string' || !table) throw fail('Bảng hoặc view không hợp lệ.', 'INVALID_TABLE');
    if (typeof write !== 'function') throw fail('Không có đích ghi tệp xuất.', 'INVALID_OUTPUT');
    if (this.activeTask) throw fail('Phiên kết nối đang chạy một tác vụ khác.', 'SESSION_BUSY');
    const format = normalizeFileFormat(settings.format, settings.filePath);
    const delimiter = format === 'tsv' ? '\t' : ',';
    const task = this.setActiveTask(
      typeof settings.taskId === 'string' ? settings.taskId : null,
      () => {
        task.canceled = true;
        this.dead = true;
        try {
          this.connection?.destroy();
        } catch {
          // cancellation is reported by the row loop
        }
      }
    );
    const startedAt = Date.now();
    let selected = [];
    let rows = 0;
    let bytes = 0;
    let lastReport = 0;
    const partialState = () => ({ rows, bytes, format, columns: selected.map((column) => column.name) });
    const throwIfCanceled = () => {
      if (!task.canceled) return;
      const error = fail('Đã hủy xuất dữ liệu.', 'EXPORT_CANCELED');
      error.partial = partialState();
      throw error;
    };
    const report = (force = false) => {
      const now = Date.now();
      if (!force && now - lastReport < 300) return;
      lastReport = now;
      if (typeof onProgress === 'function') {
        onProgress({ operation: 'export', rows, bytes, format, table });
      }
    };
    let pending = '';
    let pendingBytes = 0;
    const flush = async () => {
      if (!pending) return;
      throwIfCanceled();
      const chunk = pending;
      pending = '';
      pendingBytes = 0;
      const size = Buffer.byteLength(chunk);
      await write(chunk);
      bytes += size;
      throwIfCanceled();
    };
    const emit = async (text) => {
      throwIfCanceled();
      pending += text;
      pendingBytes += Buffer.byteLength(text);
      if (pendingBytes >= FILE_WRITE_CHUNK_BYTES) await flush();
    };
    try {
      const available = await this.listColumns(database, table);
      if (!available.length) throw fail(`Không tìm thấy cột của bảng "${table}".`, 'TABLE_NOT_FOUND');
      selected = resolveFileColumns(available, settings.columns);
      const where = buildFileWhere(settings.filters, available, settings.search, settings);
      const order = buildFileOrder(settings.orderBy, available);
      const names = selected.map((column) => quoteId(column.name));
      const sql = `SELECT ${names.join(', ')} FROM ${tableRef(database, table)}${where.sql}${order}`;
      if (format === 'json') {
        await emit('[\n');
      } else {
        await emit(`${selected.map((column) => ExportValues.csvField(column.name, delimiter)).join(delimiter)}\n`);
      }
      throwIfCanceled();
      const query = this.connection.query({ sql, values: where.params, rowsAsArray: true, disableEval: true });
      let firstRow = true;
      try {
        for await (const row of query.stream()) {
          throwIfCanceled();
          if (format === 'json') {
            const fields = selected.map((column, index) => `${JSON.stringify(column.name)}:${exportJsonField(row[index], column)}`);
            await emit(`${firstRow ? '' : ',\n'}{${fields.join(',')}}`);
            firstRow = false;
          } else {
            await emit(`${selected.map((_column, index) => ExportValues.csvField(exportTextValue(row[index]), delimiter)).join(delimiter)}\n`);
          }
          rows += 1;
          report();
        }
      } catch (error) {
        throwIfCanceled();
        throw error;
      }
      throwIfCanceled();
      if (format === 'json') await emit('\n]\n');
      await flush();
      report(true);
      return {
        database,
        table,
        format,
        rows,
        bytes,
        columns: selected.map((column) => column.name),
        durationMs: Date.now() - startedAt
      };
    } catch (error) {
      if (task.canceled && (!error || error.code !== 'EXPORT_CANCELED')) {
        const canceled = fail('Đã hủy xuất dữ liệu.', 'EXPORT_CANCELED');
        canceled.partial = partialState();
        throw canceled;
      }
      throw error;
    } finally {
      this.clearActiveTask(task);
    }
  }

  async exportQueryFile(options, write, onProgress) {
    this.ensureOpen();
    const settings = options && typeof options === 'object' ? options : {};
    const statement = String(settings.sql || '').trim();
    if (!statement) throw fail('Câu lệnh SQL đang trống.', 'EMPTY_QUERY');
    if (statement.length > 1024 * 1024) throw fail('Câu lệnh SQL vượt quá 1 MB.', 'QUERY_TOO_LARGE');
    let statements;
    try {
      statements = splitSqlStatements(statement);
    } catch (error) {
      throw fail(error.message, 'INVALID_SQL_SCRIPT');
    }
    if (statements.length !== 1 || !isReadStatement(statements[0])) {
      throw fail('Chỉ có thể xuất toàn bộ kết quả cho một câu lệnh đọc dữ liệu.', 'INVALID_EXPORT_QUERY');
    }
    if (typeof write !== 'function') throw fail('Không có đích ghi tệp xuất.', 'INVALID_OUTPUT');
    if (this.activeTask) throw fail('Phiên kết nối đang chạy một tác vụ khác.', 'SESSION_BUSY');
    const format = normalizeFileFormat(settings.format, settings.filePath);
    const delimiter = format === 'tsv' ? '\t' : ',';
    const task = this.setActiveTask(
      typeof settings.taskId === 'string' ? settings.taskId : null,
      () => {
        task.canceled = true;
        this.dead = true;
        try {
          this.connection?.destroy();
        } catch {
          // cancellation is reported by the row loop
        }
      }
    );
    const startedAt = Date.now();
    let rows = 0;
    let bytes = 0;
    let columns = [];
    let names = [];
    let outputStarted = false;
    let lastReport = 0;
    const partialState = () => ({ rows, bytes, format, columns: columns.map((column) => column.name) });
    const throwIfCanceled = () => {
      if (!task.canceled) return;
      const error = fail('Đã hủy xuất dữ liệu.', 'EXPORT_CANCELED');
      error.partial = partialState();
      throw error;
    };
    const report = (force = false) => {
      const now = Date.now();
      if (!force && now - lastReport < 300) return;
      lastReport = now;
      if (typeof onProgress === 'function') {
        onProgress({ operation: 'export', rows, bytes, format });
      }
    };
    let pending = '';
    let pendingBytes = 0;
    const flush = async () => {
      if (!pending) return;
      throwIfCanceled();
      const chunk = pending;
      pending = '';
      pendingBytes = 0;
      const size = Buffer.byteLength(chunk);
      await write(chunk);
      bytes += size;
      throwIfCanceled();
    };
    const emit = async (text) => {
      throwIfCanceled();
      pending += text;
      pendingBytes += Buffer.byteLength(text);
      if (pendingBytes >= FILE_WRITE_CHUNK_BYTES) await flush();
    };
    const startOutput = async () => {
      if (outputStarted) return;
      outputStarted = true;
      names = format === 'json'
        ? ExportValues.uniqueColumnNames(columns.map((column) => column.name))
        : columns.map((column) => column.name);
      if (format === 'json') await emit('[\n');
      else await emit(`${names.map((name) => ExportValues.csvField(name, delimiter)).join(delimiter)}\n`);
    };
    try {
      const query = this.connection.query({ sql: statements[0], rowsAsArray: true, disableEval: true });
      query.on('fields', (fields) => {
        columns = fields.map((field) => ({
          name: field.name,
          type: TYPE_NAMES[field.columnType] || String(field.columnType)
        }));
      });
      let firstRow = true;
      try {
        for await (const row of query.stream()) {
          throwIfCanceled();
          if (!columns.length) {
            columns = row.map((_value, index) => ({ name: `column_${index + 1}`, type: '' }));
          }
          await startOutput();
          if (format === 'json') {
            const fields = columns.map((column, index) => `${JSON.stringify(names[index])}:${exportJsonField(row[index], column)}`);
            await emit(`${firstRow ? '' : ',\n'}{${fields.join(',')}}`);
            firstRow = false;
          } else {
            await emit(`${columns.map((_column, index) => ExportValues.csvField(exportTextValue(row[index]), delimiter)).join(delimiter)}\n`);
          }
          rows += 1;
          report();
        }
      } catch (error) {
        throwIfCanceled();
        throw error;
      }
      if (!columns.length) throw fail('Không đọc được metadata cột của kết quả truy vấn.', 'EXPORT_NO_COLUMNS');
      await startOutput();
      throwIfCanceled();
      if (format === 'json') await emit('\n]\n');
      await flush();
      report(true);
      return {
        format,
        rows,
        bytes,
        columns: names,
        durationMs: Date.now() - startedAt
      };
    } catch (error) {
      if (task.canceled && (!error || error.code !== 'EXPORT_CANCELED')) {
        const canceled = fail('Đã hủy xuất dữ liệu.', 'EXPORT_CANCELED');
        canceled.partial = partialState();
        throw canceled;
      }
      throw error;
    } finally {
      this.clearActiveTask(task);
    }
  }

  async importFile(options, onProgress) {
    this.ensureOpen();
    const settings = options && typeof options === 'object' ? options : {};
    const database = settings.database;
    const table = settings.table;
    if (typeof database !== 'string' || !database) throw fail('Database không hợp lệ.', 'INVALID_DATABASE');
    if (typeof table !== 'string' || !table) throw fail('Bảng đích không hợp lệ.', 'INVALID_TABLE');
    if (typeof settings.filePath !== 'string' || !settings.filePath) throw fail('Chưa chọn tệp để nhập.', 'INVALID_FILE');
    const stat = await fs.promises.stat(settings.filePath);
    if (!stat.isFile()) throw fail('Đường dẫn đã chọn không phải là tệp.', 'INVALID_FILE');
    const format = normalizeFileFormat(settings.format, settings.filePath);
    const delimiter = normalizeDelimiter(format, settings.delimiter);
    const hasHeader = settings.hasHeader !== false;
    const mode = ['insert', 'skip', 'upsert'].includes(settings.mode) ? settings.mode : 'insert';
    const transaction = ['none', 'batch', 'all'].includes(settings.transaction) ? settings.transaction : 'batch';
    if (this.activeTask) throw fail('Phiên kết nối đang chạy một tác vụ khác.', 'SESSION_BUSY');
    const task = this.setActiveTask(
      typeof settings.taskId === 'string' ? settings.taskId : null,
      () => {
        task.canceled = true;
        this.dead = true;
        try {
          this.connection?.destroy();
        } catch {
          // cancellation is reported by the row loop
        }
      }
    );
    const startedAt = Date.now();
    let targets = [];
    let bytes = 0;
    let rowsRead = 0;
    let written = 0;
    let committed = 0;
    let affectedRows = 0;
    let duplicates = 0;
    let batches = 0;
    let transactionOpen = false;
    let warningCount = 0;
    let lastReport = 0;
    let previousSqlMode = null;
    let strictModeChanged = false;
    const partialState = () => ({
      rows: rowsRead,
      written,
      committed,
      affectedRows,
      duplicates,
      batches,
      bytes,
      warnings: warningCount,
      resumable: false
    });
    const canceledError = () => {
      const error = fail('Đã hủy nhập dữ liệu.', 'IMPORT_CANCELED');
      error.partial = partialState();
      error.resumable = false;
      return error;
    };
    const throwIfCanceled = () => {
      if (task.canceled) throw canceledError();
    };
    const report = (force = false) => {
      const now = Date.now();
      if (!force && now - lastReport < 300) return;
      lastReport = now;
      if (typeof onProgress === 'function') {
        onProgress({
          operation: 'import',
          bytes,
          totalBytes: stat.size,
          rows: rowsRead,
          written,
          committed,
          affectedRows,
          duplicates,
          batches,
          format,
          mode,
          transaction
        });
      }
    };
    const begin = () => new Promise((resolve, reject) => {
      this.connection.beginTransaction((error) => (error ? reject(error) : resolve()));
    });
    const commit = () => new Promise((resolve, reject) => {
      this.connection.commit((error) => (error ? reject(error) : resolve()));
    });
    const rollback = async () => {
      try {
        await new Promise((resolve) => this.connection.rollback(() => resolve()));
      } catch {
        // the connection may already be destroyed by cancellation
      }
    };
    const batch = [];
    let maxRows = IMPORT_BATCH_ROWS;
    const dataLossWarnings = async () => {
      try {
        const { rows } = await this.raw('SHOW WARNINGS');
        return (rows || [])
          .map((row) => ({ code: Number(row.Code ?? row.code), level: row.Level ?? row.level, message: String(row.Message ?? row.message ?? '') }))
          .filter((row) => DATA_LOSS_WARNING_CODES.has(row.code));
      } catch {
        return [];
      }
    };
    const flush = async () => {
      if (!batch.length) return;
      throwIfCanceled();
      const rowStart = rowsRead - batch.length + 1;
      const rowCount = batch.length;
      const placeholders = `(${targets.map(() => '?').join(', ')})`;
      const valuesSql = batch.map(() => placeholders).join(', ');
      let sql = `INSERT INTO ${tableRef(database, table)} (${targets.map((entry) => quoteId(entry.column.name)).join(', ')}) VALUES ${valuesSql}`;
      if (mode === 'upsert') {
        sql += ` ON DUPLICATE KEY UPDATE ${targets.map((entry) => `${quoteId(entry.column.name)} = VALUES(${quoteId(entry.column.name)})`).join(', ')}`;
      } else if (mode === 'skip') {
        const noop = targets.find((entry) => entry.column.key === 'PRI') || targets[0];
        sql += ` ON DUPLICATE KEY UPDATE ${quoteId(noop.column.name)} = ${quoteId(noop.column.name)}`;
      }
      const params = batch.flat();
      try {
        if (transaction !== 'none' && !transactionOpen) {
          await begin();
          transactionOpen = true;
        }
        const { result } = await this.raw(sql, params);
        const warningStatus = Number(result.warningStatus || 0);
        if (warningStatus > 0) {
          warningCount += warningStatus;
          const loss = await dataLossWarnings();
          if (loss.length) {
            const error = fail(
              `Database báo mất hoặc cắt dữ liệu ở dòng ${rowStart}: ${loss.map((entry) => entry.message).join('; ')}`,
              'IMPORT_DATA_TRUNCATED'
            );
            error.warnings = loss;
            error.row = rowStart;
            error.partiallyCommitted = transaction === 'none';
            throw error;
          }
        }
        affectedRows += Number(result.affectedRows || 0);
        duplicates += parseDuplicateCount(result.info);
        written += rowCount;
        batches += 1;
        if (transaction === 'batch') {
          await commit();
          transactionOpen = false;
          committed += rowCount;
        } else if (transaction === 'none') {
          committed += rowCount;
        }
        batch.length = 0;
        report(true);
      } catch (error) {
        if (transactionOpen) {
          await rollback();
          transactionOpen = false;
        }
        if (task.canceled) throw canceledError();
        if (error && typeof error === 'object' && !error.partial) {
          error.partial = partialState();
          error.row = rowStart;
          error.resumable = false;
        }
        throw error;
      }
    };
    let engine = null;
    try {
      if (settings.strictMode !== false) {
        const modeResult = await this.raw('SELECT @@SESSION.sql_mode AS sqlMode');
        previousSqlMode = String(modeResult.rows?.[0]?.sqlMode ?? '');
        if (!/\bSTRICT_(?:ALL|TRANS)_TABLES\b/i.test(previousSqlMode)) {
          const nextMode = previousSqlMode ? `${previousSqlMode},STRICT_ALL_TABLES` : 'STRICT_ALL_TABLES';
          await this.raw('SET SESSION sql_mode = ?', [nextMode]);
          strictModeChanged = true;
        }
      }
    } catch {
      previousSqlMode = null;
      strictModeChanged = false;
    }
    try {
      const available = await this.listColumns(database, table);
      if (!available.length) throw fail(`Không tìm thấy bảng hoặc cột của "${table}".`, 'TABLE_NOT_FOUND');
      try {
        const engineResult = await this.raw(
          'SELECT ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=? LIMIT 1',
          [database, table]
        );
        engine = engineResult.rows?.[0]?.engine ? String(engineResult.rows[0].engine) : null;
      } catch {
        engine = null;
      }
      if (engine && !TRANSACTIONAL_ENGINES.has(engine.toLowerCase()) && settings.allowNonTransactional !== true) {
        throw fail(
          `Bảng "${table}" dùng engine ${engine} không hỗ trợ rollback transaction. Hãy xác nhận "Cho phép engine không transaction" trước khi nhập.`,
          'IMPORT_NON_TRANSACTIONAL_ENGINE'
        );
      }
      const reader = readImportFile({ filePath: settings.filePath, format, delimiter, hasHeader }, (size) => {
        bytes += size;
        report();
      });
      for await (const item of reader) {
        throwIfCanceled();
        if (item.kind === 'header') {
          targets = resolveImportTargets(available, item.headers, settings.mapping);
          maxRows = Math.max(1, Math.min(IMPORT_BATCH_ROWS, Math.floor(IMPORT_MAX_PARAMS / targets.length)));
          continue;
        }
        rowsRead += 1;
        if (!targets.length) {
          if (format !== 'json') throw fail('Tệp không có dòng tiêu đề để ánh xạ cột.', 'MISSING_HEADER');
          targets = resolveImportTargets(available, Object.keys(item.values), settings.mapping);
          maxRows = Math.max(1, Math.min(IMPORT_BATCH_ROWS, Math.floor(IMPORT_MAX_PARAMS / targets.length)));
        }
        const values = targets.map((entry) => {
          const raw = format === 'json' ? item.values[entry.source] : item.values[entry.index];
          return validateImportValue(raw, entry.column, item.rowNumber, format !== 'json');
        });
        batch.push(values);
        if (batch.length >= maxRows) await flush();
        report();
      }
      if (!rowsRead) throw fail('Tệp không có dòng dữ liệu để nhập.', 'NO_ROWS');
      await flush();
      if (transactionOpen) {
        await commit();
        transactionOpen = false;
        committed = written;
      }
      report(true);
      return {
        database,
        table,
        format,
        mode,
        transaction,
        engine,
        warnings: warningCount,
        rows: rowsRead,
        written,
        committed,
        affectedRows,
        duplicates,
        batches,
        bytes,
        durationMs: Date.now() - startedAt,
        resumable: false
      };
    } catch (error) {
      if (transactionOpen) {
        await rollback();
        transactionOpen = false;
      }
      if (task.canceled) {
        if (error && error.code === 'IMPORT_CANCELED') throw error;
        throw canceledError();
      }
      if (error && typeof error === 'object' && !error.partial) {
        error.partial = partialState();
        error.resumable = false;
      }
      throw error;
    } finally {
      if (strictModeChanged) {
        try {
          await this.raw('SET SESSION sql_mode = ?', [previousSqlMode || '']);
        } catch {
          // the worker connection may already be unusable
        }
      }
      this.clearActiveTask(task);
    }
  }

  async prepareWorkerForImport() {
    this.ensureOpen();
    await this.raw(`SET SESSION innodb_lock_wait_timeout = ${WORKER_LOCK_WAIT_SECONDS}`);
  }

  async prepareWorkerForRestore() {
    this.ensureOpen();
    await this.raw(`SET SESSION innodb_lock_wait_timeout = ${WORKER_LOCK_WAIT_SECONDS}`);
  }

  async backupDatabase(options, write, onProgress) {
    this.ensureOpen();
    const database = options && options.database;
    if (typeof database !== 'string' || !database) throw fail('Database không hợp lệ.', 'INVALID_DATABASE');
    const previous = await this.raw('SELECT DATABASE() AS value');
    const previousDatabase = previous.rows[0]?.value || null;
    await this.useDatabase(database);
    try {
      return await this.writeBackup(options, write, onProgress);
    } finally {
      if (previousDatabase && previousDatabase !== database) {
        try {
          await this.useDatabase(previousDatabase);
        } catch {
          // keep the selected database if it cannot be restored
        }
      }
    }
  }

  async writeBackup(
    {
      database,
      tables,
      routines,
      events,
      includeStructure = true,
      includeData = true,
      dropTables = false,
      stripDefiner = false,
      taskId = null
    },
    write,
    onProgress
  ) {
    this.ensureOpen();
    if (typeof database !== 'string' || !database) throw fail('Database không hợp lệ.', 'INVALID_DATABASE');
    if (!includeStructure && !includeData) throw fail('Hãy chọn cấu trúc hoặc dữ liệu để sao lưu.', 'EMPTY_BACKUP');
    if (this.activeTask) throw fail('Phiên kết nối đang chạy một tác vụ khác.', 'SESSION_BUSY');
    const task = this.setActiveTask(taskId, () => {
      task.canceled = true;
      this.dead = true;
      try {
        this.connection?.destroy();
      } catch {
        // cancellation still propagates through the task flag
      }
    });
    let snapshotOpen = false;
    try {
      const available = await this.listTables(database);
      let selected;
      if (Array.isArray(tables)) {
        const requested = [...new Set(tables.map((name) => String(name)))];
        if (requested.length > 2000) throw fail('Chọn tối đa 2000 bảng mỗi lần.', 'TOO_MANY_TABLES');
        selected = requested.map((name) => {
          const entry = available.find((item) => item.name === name);
          if (!entry) throw fail(`Không tìm thấy bảng hoặc view "${name}".`, 'TABLE_NOT_FOUND');
          return entry;
        });
      } else {
        selected = available;
      }

      const requestedRoutines = includeStructure && Array.isArray(routines) ? routines.filter(Boolean) : [];
      const requestedEvents = includeStructure && Array.isArray(events) ? events.filter(Boolean) : [];
      let routineEntries = [];
      if (requestedRoutines.length) {
        const availableRoutines = await this.listRoutines(database);
        for (const input of requestedRoutines) {
          let name = '';
          let type = '';
          if (typeof input === 'string') {
            const match = /^(procedure|function):([\s\S]+)$/i.exec(input);
            name = match ? match[2] : input;
            type = match ? match[1].toLowerCase() : '';
          } else if (input && typeof input === 'object') {
            name = typeof input.name === 'string' ? input.name : '';
            type = typeof input.type === 'string' ? input.type.toLowerCase() : '';
          }
          if (!name) continue;
          const entry = availableRoutines.find((item) => item.name === name && (!type || item.type === type));
          if (!entry) throw fail(`Không tìm thấy routine "${name}".`, 'ROUTINE_NOT_FOUND');
          if (!routineEntries.some((item) => item.name === entry.name && item.type === entry.type)) {
            routineEntries.push(entry);
          }
        }
      }
      let eventEntries = [];
      if (requestedEvents.length) {
        const availableEvents = await this.listEvents(database);
        for (const input of requestedEvents) {
          const name = typeof input === 'string' ? input : (input && typeof input.name === 'string' ? input.name : '');
          if (!name) continue;
          const entry = availableEvents.find((item) => item.name === name);
          if (!entry) throw fail(`Không tìm thấy event "${name}".`, 'EVENT_NOT_FOUND');
          if (!eventEntries.some((item) => item.name === entry.name)) eventEntries.push(entry);
        }
      }

      if (!selected.length && !routineEntries.length && !eventEntries.length) {
        throw fail('Database không có bảng, view, routine hoặc event nào để sao lưu.', 'NO_OBJECTS');
      }

      const routineDdl = [];
      for (const entry of routineEntries) {
        if (task.canceled) break;
        const created = await this.raw(
          `SHOW CREATE ${entry.type.toUpperCase()} ${tableRef(database, entry.name)}`
        );
        let ddl = showCreateDdl(created.result, `${entry.type} ${entry.name}`);
        if (stripDefiner) ddl = stripDefinerClause(ddl);
        routineDdl.push({ entry, ddl });
      }
      const eventDdl = [];
      for (const entry of eventEntries) {
        if (task.canceled) break;
        const created = await this.raw(`SHOW CREATE EVENT ${tableRef(database, entry.name)}`);
        let ddl = showCreateDdl(created.result, `event ${entry.name}`);
        if (stripDefiner) ddl = stripDefinerClause(ddl);
        eventDdl.push({ entry, ddl });
      }

      const dataTables = selected.filter((entry) => entry.type === 'table');
      const views = selected.filter((entry) => entry.type === 'view');
      const transactional = dataTables.length > 0
        && dataTables.every((entry) => String(entry.engine || '').toLowerCase() === 'innodb');
      const warnings = includeData && dataTables.length && !transactional
        ? ['Có bảng không dùng InnoDB: bản sao lưu không có snapshot chung; hãy tạm dừng ghi dữ liệu trong lúc sao lưu.'] : [];
      if (includeData && transactional) {
        try {
          await this.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
          await this.raw('START TRANSACTION WITH CONSISTENT SNAPSHOT');
        } catch (error) {
          throw fail(`Không tạo được snapshot nhất quán cho bản sao lưu: ${error.message}`, 'BACKUP_SNAPSHOT_FAILED');
        }
        snapshotOpen = true;
        this.metadata.clear();
      }
      const startedAt = Date.now();
      let bytes = 0;
      let rows = 0;
      let objects = 0;
      let triggerCount = 0;
      let lastReport = 0;

      const throwIfCanceled = () => {
        if (!task.canceled) return;
        const error = fail('Đã hủy sao lưu.', 'BACKUP_CANCELED');
        error.partial = { rows, objects, bytes };
        throw error;
      };
      const report = (force = false) => {
        const now = Date.now();
        if (!force && now - lastReport < 300) return;
        lastReport = now;
        if (typeof onProgress === 'function') onProgress({ operation: 'backup', bytes, rows, objects });
      };
      const emit = async (text) => {
        throwIfCanceled();
        const chunk = String(text);
        const size = Buffer.byteLength(chunk);
        bytes += size;
        await write(chunk);
      };
      throwIfCanceled();

      const header = [
        '-- SqlPro database backup',
        `-- Database: ${quoteId(database)}`,
        `-- Server: ${this.version}`,
        `-- Created: ${new Date().toISOString()}`,
        `-- Structure: ${includeStructure ? 'yes' : 'no'} · Data: ${includeData ? 'yes' : 'no'}`,
        `-- DEFINER: ${stripDefiner ? 'removed' : 'kept'}`,
        `-- Consistency: ${snapshotOpen ? 'InnoDB consistent snapshot' : includeData ? 'no shared data snapshot' : 'structure only'}`,
        '',
        'SET NAMES utf8mb4;',
        'SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0;',
        "SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO';",
        ''
      ].join('\n');
      await emit(`${header}\n`);

      if (includeStructure) {
        for (const entry of dataTables) {
          throwIfCanceled();
          const created = await this.raw(`SHOW CREATE TABLE ${tableRef(database, entry.name)}`);
          const ddl = showCreateDdl(created.result, `table ${entry.name}`);
          await emit(`-- Table ${quoteId(entry.name)}${dropTables ? ' (drop first)' : ''}\n`);
          if (dropTables) await emit(`DROP TABLE IF EXISTS ${quoteId(entry.name)};\n`);
          await emit(`${String(ddl).replace(/;\s*$/, '')};\n\n`);
          objects += 1;
          report();
        }
      }

      if (includeData) {
        for (const entry of dataTables) {
          throwIfCanceled();
          const columns = (await this.listColumns(database, entry.name))
            .filter((column) => !/(virtual|stored) generated/i.test(column.extra));
          if (!columns.length) continue;
          const names = columns.map((column) => quoteId(column.name));
          await emit(`-- Data ${quoteId(entry.name)}\n`);
          const query = this.connection.query({
            sql: `SELECT ${names.join(', ')} FROM ${tableRef(database, entry.name)}`,
            rowsAsArray: true,
            disableEval: true
          });
          let batch = [];
          let batchBytes = 0;
          const escapeSqlValue = (value) => {
            if (value === undefined || value === null) return 'NULL';
            if (Buffer.isBuffer(value)) return `X'${value.toString('hex')}'`;
            if (value instanceof Date) return mysql.escape(value);
            if (typeof value === 'object') return mysql.escape(JSON.stringify(value));
            if (typeof value === 'boolean') return value ? '1' : '0';
            return mysql.escape(value);
          };
          const rowValues = (row) => `(${row.map(escapeSqlValue).join(', ')})`;
          const flush = async () => {
            if (!batch.length) return;
            throwIfCanceled();
            const values = batch.join(',\n  ');
            batch = [];
            batchBytes = 0;
            await emit(`INSERT INTO ${quoteId(entry.name)} (${names.join(', ')}) VALUES\n  ${values};\n`);
            report();
          };
          try {
            for await (const row of query.stream()) {
              throwIfCanceled();
              const value = rowValues(row);
              const valueBytes = Buffer.byteLength(value);
              if (batch.length && (batch.length >= BACKUP_INSERT_ROWS || batchBytes + valueBytes > BACKUP_INSERT_BYTES)) {
                await flush();
              }
              batch.push(value);
              batchBytes += valueBytes;
              rows += 1;
              if (batch.length >= BACKUP_INSERT_ROWS || batchBytes >= BACKUP_INSERT_BYTES) await flush();
            }
          } catch (error) {
            throwIfCanceled();
            throw error;
          }
          throwIfCanceled();
          await flush();
          await emit('\n');
        }
      }

      if (includeStructure && routineDdl.length) {
        let delimiter = '$$';
        while (routineDdl.some(({ ddl }) => ddl.includes(delimiter))) delimiter += '$';
        await emit(`DELIMITER ${delimiter}\n`);
        for (const { entry, ddl } of routineDdl) {
          throwIfCanceled();
          await emit(`-- ${entry.type === 'function' ? 'Function' : 'Procedure'} ${quoteId(entry.name)}\n`);
          if (dropTables) await emit(`DROP ${entry.type.toUpperCase()} IF EXISTS ${quoteId(entry.name)}${delimiter}\n`);
          await emit(`${ddl}${ddl.endsWith(delimiter) ? '' : delimiter}\n\n`);
          objects += 1;
          report();
        }
        await emit('DELIMITER ;\n\n');
      }

      if (includeStructure) {
        for (const entry of views) {
          throwIfCanceled();
          const created = await this.raw(`SHOW CREATE VIEW ${tableRef(database, entry.name)}`);
          let ddl = showCreateDdl(created.result, `view ${entry.name}`);
          if (stripDefiner) ddl = stripDefinerClause(ddl);
          await emit(`-- View ${quoteId(entry.name)}\n`);
          if (dropTables) await emit(`DROP VIEW IF EXISTS ${quoteId(entry.name)};\n`);
          await emit(`${ddl.replace(/;\s*$/, '')};\n\n`);
          objects += 1;
          report();
        }

        const selectedTables = new Set(dataTables.map((entry) => entry.name));
        const triggerResult = await this.raw(
          `SELECT TRIGGER_NAME AS name, ACTION_TIMING AS timing, EVENT_MANIPULATION AS event,
                  EVENT_OBJECT_TABLE AS tableName, ACTION_STATEMENT AS statement
             FROM information_schema.TRIGGERS
            WHERE TRIGGER_SCHEMA = ?
            ORDER BY EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, TRIGGER_NAME`,
          [database]
        );
        const triggers = triggerResult.rows.filter((row) => selectedTables.has(row.tableName));
        if (triggers.length) {
          const bodies = triggers.map((trigger) => String(trigger.statement || '').trim().replace(/;\s*$/, ''));
          let delimiter = '$$';
          while (bodies.some((body) => body.includes(delimiter))) delimiter += '$';
          await emit(`DELIMITER ${delimiter}\n`);
          for (const [index, trigger] of triggers.entries()) {
            throwIfCanceled();
            const statement = bodies[index];
            await emit(`-- Trigger ${quoteId(trigger.name)} on ${quoteId(trigger.tableName)}\n`);
            if (dropTables) await emit(`DROP TRIGGER IF EXISTS ${quoteId(trigger.name)}${delimiter}\n`);
            await emit(`CREATE TRIGGER ${quoteId(trigger.name)} ${trigger.timing} ${trigger.event} ON ${quoteId(trigger.tableName)} FOR EACH ROW ${statement}${delimiter}\n\n`);
            objects += 1;
            report();
          }
          await emit('DELIMITER ;\n\n');
        }
        triggerCount = triggers.length;
      }

      if (includeStructure && eventDdl.length) {
        let delimiter = '$$';
        while (eventDdl.some(({ ddl }) => ddl.includes(delimiter))) delimiter += '$';
        await emit(`DELIMITER ${delimiter}\n`);
        for (const { entry, ddl } of eventDdl) {
          throwIfCanceled();
          await emit(`-- Event ${quoteId(entry.name)}\n`);
          if (dropTables) await emit(`DROP EVENT IF EXISTS ${quoteId(entry.name)}${delimiter}\n`);
          await emit(`${ddl}${ddl.endsWith(delimiter) ? '' : delimiter}\n\n`);
          objects += 1;
          report();
        }
        await emit('DELIMITER ;\n\n');
      }

      await emit([
        'SET SQL_MODE=@OLD_SQL_MODE;',
        'SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS;',
        '-- End of backup',
        ''
      ].join('\n'));
      throwIfCanceled();
      report(true);
      return {
        database,
        tables: dataTables.length,
        views: views.length,
        triggers: triggerCount,
        procedures: routineDdl.filter(({ entry }) => entry.type === 'procedure').length,
        functions: routineDdl.filter(({ entry }) => entry.type === 'function').length,
        events: eventDdl.length,
        rows,
        bytes,
        snapshot: snapshotOpen,
        warnings,
        durationMs: Date.now() - startedAt
      };
    } finally {
      if (snapshotOpen) {
        try {
          await this.raw('ROLLBACK');
        } catch {
          // the connection may already be destroyed by cancellation
        }
        this.metadata.clear();
      }
      this.clearActiveTask(task);
    }
  }

  async scanRestoreInventory({ filePath, database, totalBytes, dropExisting, onProgress, task }) {
    const inventory = {
      tables: new Map(),
      rowCountsReliable: true,
      rowCountLimitations: [],
      warnings: [],
      statements: 0,
      skipped: 0
    };
    const limit = (message) => {
      if (!inventory.rowCountLimitations.includes(message)) inventory.rowCountLimitations.push(message);
    };
    const disableRowCounts = (message) => {
      inventory.rowCountsReliable = false;
      limit(message);
    };
    const entryFor = (name) => {
      const key = String(name).toLowerCase();
      let entry = inventory.tables.get(key);
      if (!entry) {
        entry = { name, expectedRows: 0, canCount: false, reason: 'Bảng không được tạo mới trong tệp nên không thể đối chiếu số dòng.' };
        inventory.tables.set(key, entry);
      }
      return entry;
    };
    const unverifiable = (entry, reason) => {
      entry.canCount = false;
      entry.reason = reason;
    };
    const processStatement = (statement) => {
      const sql = String(statement || '').trim();
      if (!sql) return;
      inventory.statements += 1;
      if (skipReason(sql)) {
        inventory.skipped += 1;
        return;
      }
      const analysis = assertStatementScope(sql, database, inventory.statements);
      const command = analysis.command;
      const target = createTarget(sql);
      if (command === 'CREATE') {
        if (target && target.type === 'table') {
          const ifNotExists = /\bIF\s+NOT\s+EXISTS\b/i.test(analysis.sql);
          const temporary = /^CREATE\s+TEMPORARY\b/i.test(analysis.sql);
          let reason = null;
          if (temporary) reason = 'Bảng tạm không được đối chiếu số dòng sau khi phục hồi.';
          else if (ifNotExists && !dropExisting) reason = 'CREATE TABLE IF NOT EXISTS có thể giữ lại dữ liệu cũ nên không thể đối chiếu số dòng.';
          else if (/\bSELECT\b/i.test(analysis.sql)) reason = 'CREATE TABLE ... SELECT không xác định trước được số dòng.';
          inventory.tables.set(target.name.toLowerCase(), {
            name: target.name,
            expectedRows: 0,
            canCount: !reason,
            reason
          });
        } else if (target && ['trigger', 'procedure', 'function', 'event'].includes(target.type)) {
          disableRowCounts('Tệp tạo trigger/routine/event nên số dòng có thể thay đổi ngoài các câu INSERT.');
        }
      } else if (command === 'INSERT' || command === 'REPLACE') {
        const ref = analysis.refs[0];
        if (!ref) return;
        const entry = entryFor(ref.table);
        const counted = countInsertRows(sql);
        const head = analysis.sql.slice(0, 80);
        if (command === 'REPLACE') unverifiable(entry, 'REPLACE có thể gộp dòng nên không thể đối chiếu số dòng.');
        else if (/\bIGNORE\b/i.test(head)) unverifiable(entry, 'INSERT IGNORE có thể bỏ dòng nên không thể đối chiếu số dòng.');
        else if (/\bDELAYED\b/i.test(head)) unverifiable(entry, 'INSERT DELAYED ghi bất đồng bộ nên không thể đối chiếu số dòng.');
        else if (!counted.reliable) unverifiable(entry, 'INSERT ... SELECT hoặc VALUES không phân tích được nên không thể đối chiếu số dòng.');
        else if (entry.canCount) entry.expectedRows += counted.rows;
      } else if (command === 'DELETE') {
        for (const ref of analysis.refs) unverifiable(entryFor(ref.table), 'Tệp có câu DELETE nên số dòng cuối không còn khớp số dòng đã chèn.');
      } else if (command === 'TRUNCATE') {
        for (const ref of analysis.refs) {
          inventory.tables.set(ref.table.toLowerCase(), { name: ref.table, expectedRows: 0, canCount: true, reason: null });
        }
      } else if (command === 'LOAD') {
        for (const ref of analysis.refs) unverifiable(entryFor(ref.table), 'LOAD DATA không xác định trước được số dòng.');
      } else if (command === 'DROP' && /^DROP\s+(?:TEMPORARY\s+)?TABLES?\b/i.test(analysis.sql)) {
        for (const ref of analysis.refs) {
          const key = ref.table.toLowerCase();
          const entry = inventory.tables.get(key);
          if (!entry) continue;
          if (entry.expectedRows > 0) unverifiable(entry, 'Bảng bị xóa sau khi đã chèn dữ liệu.');
          else inventory.tables.delete(key);
        }
      } else if (command === 'RENAME' && analysis.refs.length >= 2) {
        for (let index = 0; index + 1 < analysis.refs.length; index += 2) {
          const from = analysis.refs[index];
          const to = analysis.refs[index + 1];
          const entry = inventory.tables.get(from.table.toLowerCase());
          if (!entry) continue;
          inventory.tables.delete(from.table.toLowerCase());
          entry.name = to.table;
          inventory.tables.set(to.table.toLowerCase(), entry);
        }
      }
    };
    const parser = new SqlScriptParser();
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    let bytes = 0;
    let lastReport = 0;
    const canceled = () => {
      const error = fail('Đã hủy phục hồi.', 'RESTORE_CANCELED');
      error.partial = { statements: inventory.statements, executed: 0, skipped: inventory.skipped, phase: 'scan' };
      return error;
    };
    for await (const chunk of stream) {
      if (task && task.canceled) throw canceled();
      bytes += Buffer.byteLength(chunk);
      for (const statement of parser.push(chunk)) processStatement(statement);
      const now = Date.now();
      if (now - lastReport >= 300) {
        lastReport = now;
        if (typeof onProgress === 'function') {
          onProgress({
            operation: 'restore',
            phase: 'scan',
            bytes,
            totalBytes,
            statements: inventory.statements,
            executed: 0,
            skipped: inventory.skipped
          });
        }
      }
    }
    for (const statement of parser.end()) processStatement(statement);
    if (task && task.canceled) throw canceled();
    return { inventory, bytes };
  }

  async verifyRestore(database, inventory, task) {
    const checks = {
      foreignKeys: { status: 'skipped', checked: 0, orphans: [], crossSchema: [], errors: [] },
      rowCounts: { status: 'skipped', checked: 0, mismatches: [] },
      warnings: { status: 'clean', count: inventory.warnings.length, items: inventory.warnings },
      settings: { status: 'ok' }
    };
    const limitations = [...inventory.rowCountLimitations];
    let failed = false;
    try {
      const result = await this.raw(
        `SELECT k.TABLE_NAME AS tableName, k.CONSTRAINT_NAME AS constraintName,
                k.REFERENCED_TABLE_SCHEMA AS referencedSchema, k.REFERENCED_TABLE_NAME AS referencedTable,
                k.COLUMN_NAME AS columnName, k.REFERENCED_COLUMN_NAME AS referencedColumn,
                k.ORDINAL_POSITION AS position
           FROM information_schema.KEY_COLUMN_USAGE k
          WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
          ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
        [database]
      );
      const groups = new Map();
      for (const row of result.rows || []) {
        const key = [row.tableName, row.constraintName, row.referencedSchema, row.referencedTable].join('\u0000');
        if (!groups.has(key)) {
          groups.set(key, {
            table: row.tableName,
            constraint: row.constraintName,
            referencedSchema: row.referencedSchema,
            referencedTable: row.referencedTable,
            columns: [],
            referencedColumns: []
          });
        }
        const group = groups.get(key);
        group.columns.push(row.columnName);
        group.referencedColumns.push(row.referencedColumn);
      }
      checks.foreignKeys.status = 'checked';
      for (const group of groups.values()) {
        if (String(group.referencedSchema || '').toLowerCase() !== String(database).toLowerCase()) {
          checks.foreignKeys.crossSchema.push({
            table: group.table,
            constraint: group.constraint,
            referencedSchema: group.referencedSchema,
            referencedTable: group.referencedTable
          });
          limitations.push(`Khóa ngoại ${group.table}.${group.constraint} tham chiếu ${group.referencedSchema}.${group.referencedTable} nằm ngoài database đích nên không kiểm chứng được.`);
          continue;
        }
        if (task && task.canceled) throw fail('Đã hủy phục hồi.', 'RESTORE_CANCELED');
        const joins = group.columns.map((column, index) =>
          `c.${quoteId(column)} <=> p.${quoteId(group.referencedColumns[index])}`).join(' AND ');
        const nulls = group.columns.map((column) => `c.${quoteId(column)} IS NOT NULL`).join(' AND ');
        const orphanQuery = `SELECT COUNT(*) AS orphans FROM ${quoteId(database)}.${quoteId(group.table)} c
          LEFT JOIN ${quoteId(database)}.${quoteId(group.referencedTable)} p ON ${joins}
          WHERE ${nulls} AND p.${quoteId(group.referencedColumns[0])} IS NULL`;
        try {
          const orphanResult = await this.raw(orphanQuery);
          const orphans = Number(orphanResult.rows?.[0]?.orphans || 0);
          checks.foreignKeys.checked += 1;
          if (orphans > 0) {
            failed = true;
            checks.foreignKeys.orphans.push({
              table: group.table,
              constraint: group.constraint,
              referencedTable: group.referencedTable,
              orphans
            });
          }
        } catch (error) {
          checks.foreignKeys.errors.push({ table: group.table, constraint: group.constraint, message: error.message });
          limitations.push(`Không kiểm tra được khóa ngoại ${group.table}.${group.constraint}: ${error.message}`);
        }
      }
      if (checks.foreignKeys.errors.length || checks.foreignKeys.crossSchema.length) {
        checks.foreignKeys.status = 'unverified';
      }
      if (checks.foreignKeys.orphans.length) checks.foreignKeys.status = 'failed';
    } catch (error) {
      checks.foreignKeys.status = 'unverified';
      checks.foreignKeys.errors.push({ message: error.message });
      limitations.push(`Không đọc được metadata khóa ngoại: ${error.message}`);
    }

    const tables = [...inventory.tables.values()].filter((entry) => entry.canCount);
    if (!inventory.rowCountsReliable) {
      checks.rowCounts.status = 'unverified';
    } else if (!tables.length) {
      checks.rowCounts.status = 'unverified';
      if (!limitations.length) limitations.push('Tệp không có bảng nào đủ điều kiện để đối chiếu số dòng.');
    } else {
      checks.rowCounts.status = 'checked';
      for (const entry of tables) {
        if (task && task.canceled) throw fail('Đã hủy phục hồi.', 'RESTORE_CANCELED');
        if (entry.expectedRows > RESTORE_ROWCOUNT_LIMIT) {
          limitations.push(`Bảng ${entry.name} có ${entry.expectedRows} dòng dự kiến, vượt giới hạn đối chiếu ${RESTORE_ROWCOUNT_LIMIT}.`);
          continue;
        }
        try {
          const counted = await this.raw(`SELECT COUNT(*) AS rowCount FROM ${quoteId(database)}.${quoteId(entry.name)}`);
          const actual = Number(counted.rows?.[0]?.rowCount || 0);
          checks.rowCounts.checked += 1;
          if (actual !== entry.expectedRows) {
            failed = true;
            checks.rowCounts.mismatches.push({ table: entry.name, expected: entry.expectedRows, actual });
          }
        } catch (error) {
          checks.rowCounts.status = 'unverified';
          limitations.push(`Không đếm được số dòng của ${entry.name}: ${error.message}`);
        }
      }
      const unverifiable = [...inventory.tables.values()].filter((entry) => !entry.canCount);
      for (const entry of unverifiable.slice(0, 20)) {
        if (entry.reason) limitations.push(`${entry.name}: ${entry.reason}`);
      }
      if (unverifiable.length > 20) limitations.push(`Còn ${unverifiable.length - 20} bảng khác không đối chiếu được số dòng.`);
      if (checks.rowCounts.mismatches.length) checks.rowCounts.status = 'failed';
    }

    if (inventory.warnings.length) {
      failed = true;
      checks.warnings.status = 'data-loss';
    }
    try {
      const settings = await this.raw('SELECT @@FOREIGN_KEY_CHECKS AS foreignKeys');
      if (Number(settings.rows?.[0]?.foreignKeys) === 0) {
        failed = true;
        checks.settings = { status: 'failed', message: 'FOREIGN_KEY_CHECKS vẫn đang tắt sau khi phục hồi.' };
      }
    } catch (error) {
      checks.settings = { status: 'unverified', message: error.message };
      limitations.push(`Không xác minh được FOREIGN_KEY_CHECKS: ${error.message}`);
    }

    const status = failed ? 'failed' : (limitations.length ? 'unverified' : 'verified');
    return {
      status,
      executed: true,
      verified: status === 'verified',
      checks,
      limitations: [...new Set(limitations)]
    };
  }

  async restoreDatabase(options, onProgress) {
    const settings = options && typeof options === 'object' ? options : {};
    if (this.activeTask) throw fail('Phiên kết nối đang chạy một tác vụ khác.', 'SESSION_BUSY');
    const task = this.setActiveTask(
      typeof settings.taskId === 'string' ? settings.taskId : null,
      () => {
        task.canceled = true;
        this.dead = true;
        try {
          this.connection?.destroy();
        } catch {
          // the restore loop reports cancellation at the next boundary
        }
      }
    );
    try {
      return await this.restoreDatabaseInternal(settings, onProgress, task);
    } finally {
      this.clearActiveTask(task);
    }
  }

  async restoreDatabaseInternal(
    { database, filePath, dropExisting = false, createDatabaseIfNotExists = false },
    onProgress,
    task
  ) {
    this.ensureOpen();
    if (typeof database !== 'string' || !database) throw fail('Database đích không hợp lệ.', 'INVALID_DATABASE');
    if (typeof filePath !== 'string' || !filePath) throw fail('Tệp SQL không hợp lệ.', 'INVALID_FILE');
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) throw fail('Đường dẫn phục hồi không phải là tệp.', 'INVALID_FILE');

    const { inventory } = await this.scanRestoreInventory({
      filePath,
      database,
      totalBytes: stat.size,
      dropExisting,
      onProgress,
      task
    });

    if (createDatabaseIfNotExists) {
      await this.raw(`CREATE DATABASE IF NOT EXISTS ${quoteId(database)} DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    }

    const startedAt = Date.now();
    const previous = await this.raw('SELECT @@FOREIGN_KEY_CHECKS AS foreignKeys, @@SQL_MODE AS sqlMode');
    const previousForeignKeys = Number(previous.rows[0]?.foreignKeys) === 0 ? 0 : 1;
    const previousSqlMode = String(previous.rows[0]?.sqlMode ?? '');
    await this.useDatabase(database);
    await this.raw('SET FOREIGN_KEY_CHECKS=0');

    const parser = new SqlScriptParser();
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    let bytes = 0;
    let statements = 0;
    let executed = 0;
    let skipped = 0;
    let lastReport = 0;
    const report = (force = false) => {
      const now = Date.now();
      if (!force && now - lastReport < 300) return;
      lastReport = now;
      if (typeof onProgress === 'function') {
        onProgress({
          operation: 'restore',
          phase: 'execute',
          bytes,
          totalBytes: stat.size,
          statements,
          executed,
          skipped,
          warnings: inventory.warnings.length
        });
      }
    };

    const partialState = () => ({ statements, executed, skipped });
    const canceledError = () => {
      const error = fail('Đã hủy phục hồi.', 'RESTORE_CANCELED');
      error.partial = partialState();
      return error;
    };
    const throwIfCanceled = () => {
      if (task && task.canceled) throw canceledError();
    };

    const captureWarnings = async (statementNumber) => {
      let warnings = [];
      try {
        warnings = (await this.raw('SHOW WARNINGS')).rows || [];
      } catch {
        return;
      }
      for (const warning of warnings) {
        const code = Number(warning.Code);
        if (!DATA_LOSS_WARNING_CODES.has(code)) continue;
        if (inventory.warnings.length < 50) {
          inventory.warnings.push({
            statement: statementNumber,
            code,
            level: warning.Level,
            message: warning.Message
          });
        }
      }
    };

    const execute = async (rawStatement) => {
      const sql = String(rawStatement || '').trim();
      if (!sql) return;
      statements += 1;
      if (task && task.canceled) throw canceledError();
      if (skipReason(sql)) {
        skipped += 1;
        return;
      }
      try {
        if (dropExisting) {
          const target = createTarget(sql);
          const dropKinds = {
            table: 'TABLE',
            view: 'VIEW',
            trigger: 'TRIGGER',
            procedure: 'PROCEDURE',
            function: 'FUNCTION',
            event: 'EVENT'
          };
          if (target && target.name && dropKinds[target.type]) {
            await this.raw(`DROP ${dropKinds[target.type]} IF EXISTS ${quoteId(target.name)}`);
          }
        }
        throwIfCanceled();
        const result = await this.raw(sql);
        executed += 1;
        if (result && Number(result.warningStatus) > 0) await captureWarnings(statements);
      } catch (error) {
        if (task && task.canceled) throw canceledError();
        if (!error.partial) error.partial = partialState();
        const summary = sql.replace(/\s+/g, ' ').slice(0, 120);
        let message = `Lỗi ở câu lệnh #${statements}: ${error.message}`;
        if (summary) message += `\n${summary}${sql.length > 120 ? '…' : ''}`;
        if (error.code === 'ER_TABLE_EXISTS_ERROR' && !dropExisting) {
          message += '\nBật tùy chọn "Xóa bảng/view/routine/event trùng tên" nếu muốn ghi đè.';
        }
        error.message = message;
        throw error;
      }
    };

    try {
      for await (const chunk of stream) {
        throwIfCanceled();
        bytes += Buffer.byteLength(chunk);
        for (const statement of parser.push(chunk)) await execute(statement);
        report();
      }
      for (const statement of parser.end()) await execute(statement);
      throwIfCanceled();
      report(true);
    } finally {
      try {
        await this.raw(`SET FOREIGN_KEY_CHECKS=${previousForeignKeys}`);
      } catch {
        // session may already be unusable
      }
      try {
        await this.raw('SET SESSION SQL_MODE=?', [previousSqlMode]);
      } catch {
        // session may already be unusable
      }
      this.metadata.clear();
    }

    throwIfCanceled();
    const verification = await this.verifyRestore(database, inventory, task);
    return {
      database,
      statements: executed,
      skipped,
      bytes,
      durationMs: Date.now() - startedAt,
      warnings: inventory.warnings.length,
      verification,
      inventory: {
        tables: inventory.tables.size,
        expectedRows: [...inventory.tables.values()].reduce((total, entry) => total + (entry.canCount ? entry.expectedRows : 0), 0),
        rowCountsReliable: inventory.rowCountsReliable
      }
    };
  }
}

async function testConnection(profile) {
  const session = new DatabaseSession(profile);
  try {
    await session.connect();
    return { version: session.version };
  } finally {
    await session.close();
  }
}

module.exports = {
  DatabaseSession,
  testConnection,
  quoteId,
  previewImportFile,
  normalizeFileFormat,
  sshHostKeyFingerprint,
  verifySshHostKey
};
