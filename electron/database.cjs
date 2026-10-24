'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2');
const { Client: SshClient } = require('ssh2');
const { SqlScriptParser, splitSqlStatements, stripLeadingComments, createTarget, skipReason } = require('./sql-script.cjs');
const { CsvStreamParser } = require('./csv-stream.cjs');
const { JsonArrayStreamParser } = require('./json-array-stream.cjs');
const RowValues = require('../row-values.js');

const MAX_QUERY_ROWS = 5000;
const MAX_QUERY_BATCH_ROWS = 10000;
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
  const serialized = {};
  for (const [key, value] of Object.entries(row)) serialized[key] = serializeValue(value);
  return serialized;
}

function isNumericType(type) {
  return /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|bit|year)\b/i.test(type);
}

function isDateType(type) {
  return /^(date|datetime|timestamp|time)\b/i.test(type);
}

function coerceValue(value, column) {
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

function csvField(value, delimiter) {
  if (value === null || value === undefined) return '\\N';
  let text = String(value);
  if (text === '\\N') text = '\\\\N';
  if (text.includes('"') || text.includes(delimiter) || /[\r\n]/.test(text) || /^\s|\s$/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
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

function buildFileWhere(filters, columns, search = '') {
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
    for (const column of columns) {
      searchParts.push(`CAST(${quoteId(column.name)} AS CHAR) LIKE ?`);
      params.push(`%${term}%`);
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

function isIntegerColumn(type) {
  return /^(tinyint|smallint|mediumint|int|integer|bigint)\b/i.test(type);
}

function isDecimalColumn(type) {
  return /^(decimal|numeric|float|double|real)\b/i.test(type);
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
        return JSON.stringify(value);
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
      return Buffer.from(match[1], 'hex');
    }
  }
  if (isNumericType(column.type)) {
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'object') throw importValueError(rowNumber, column, 'phải là số.');
    const text = String(value).trim();
    if (!text) {
      if (column.nullable === 'YES') return null;
      throw importValueError(rowNumber, column, 'không được để trống.');
    }
    if (/^bit\b/i.test(column.type)) {
      if (!/^[01]+$/.test(text)) throw importValueError(rowNumber, column, 'phải là chuỗi bit 0/1.');
      return text;
    }
    if (isIntegerColumn(column.type)) {
      if (!/^[+-]?\d+$/.test(text)) throw importValueError(rowNumber, column, 'phải là số nguyên.');
      return text;
    }
    if (isDecimalColumn(column.type)) {
      if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) {
        throw importValueError(rowNumber, column, 'phải là số hợp lệ.');
      }
      return text;
    }
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) {
      throw importValueError(rowNumber, column, 'phải là số hợp lệ.');
    }
    return text;
  }
  if (isDateType(column.type)) {
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) throw importValueError(rowNumber, column, 'ngày giờ không hợp lệ.');
      return value;
    }
    if (typeof value === 'object') throw importValueError(rowNumber, column, 'phải là ngày giờ dạng chuỗi.');
    const text = String(value).trim();
    if (!text) {
      if (column.nullable === 'YES') return null;
      throw importValueError(rowNumber, column, 'không được để trống.');
    }
    let pattern;
    if (/^date\b/i.test(column.type)) pattern = /^\d{4}-\d{2}-\d{2}$/;
    else if (/^time\b/i.test(column.type)) pattern = /^-?\d{1,3}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?$/;
    else if (/^year\b/i.test(column.type)) pattern = /^\d{4}$/;
    else pattern = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?)?$/;
    if (!pattern.test(text)) throw importValueError(rowNumber, column, 'không đúng định dạng ngày giờ.');
    return text;
  }
  if (typeof value === 'object') throw importValueError(rowNumber, column, 'không hỗ trợ giá trị object.');
  return String(value);
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
    ? new JsonArrayStreamParser()
    : new CsvStreamParser({ delimiter });
  const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
  let first = true;
  let headers = null;
  let rowNumber = 0;
  const consume = function* (entry) {
    if (format === 'json') {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
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
  const parser = format === 'json' ? new JsonArrayStreamParser() : new CsvStreamParser({ delimiter });
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
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw fail('Mỗi phần tử JSON phải là một object.', 'INVALID_JSON_ROW');
      }
      if (!headers) headers = [];
      for (const key of Object.keys(entry)) addHeader(key);
      if (rows.length >= limit) {
        truncated = true;
        done = true;
        return;
      }
      rows.push(headers.map((key) => (entry[key] === undefined ? null : entry[key])));
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
    this.connection = null;
    this.ssh = null;
    this.dead = false;
    this.version = null;
    this.cancelQuery = null;
    this.activeTask = null;
    this.metadata = new Map();
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
        const timer = setTimeout(resolve, 1000);
        try {
          connection.end(() => {
            clearTimeout(timer);
            resolve();
          });
        } catch {
          clearTimeout(timer);
          resolve();
        }
      });
    }
    this.closeSsh();
  }

  ensureOpen() {
    if (!this.connection || this.dead) throw fail('Phiên kết nối đã đóng. Hãy kết nối lại.', 'SESSION_CLOSED');
  }

  raw(sql, params = []) {
    this.ensureOpen();
    return new Promise((resolve, reject) => {
      this.connection.query(sql, params, (error, result, fields) => {
        if (error) {
          reject(error);
          return;
        }
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

  async tableData({ database, table, page = 1, pageSize = 100, search = '', orderBy = null, orderDir = 'ASC' }) {
    const columns = await this.listColumns(database, table);
    if (!columns.length) throw fail(`Không tìm thấy bảng ${table}.`, 'TABLE_NOT_FOUND');
    const safePage = Math.max(1, Math.min(1000000, Number(page) || 1));
    const safePageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Number(pageSize) || 100));
    const columnNames = new Set(columns.map((column) => column.name));
    const conditions = [];
    const params = [];
    const term = String(search || '').trim().slice(0, 200);
    if (term) {
      for (const column of columns) {
        conditions.push(`CAST(${quoteId(column.name)} AS CHAR) LIKE ?`);
        params.push(`%${term}%`);
      }
    }
    const where = conditions.length ? `WHERE ${conditions.join(' OR ')}` : '';
    let order = '';
    if (orderBy && columnNames.has(orderBy)) {
      order = `ORDER BY ${quoteId(orderBy)} ${String(orderDir).toUpperCase() === 'DESC' ? 'DESC' : 'ASC'}`;
    } else {
      const pk = columns.filter((column) => column.key === 'PRI').map((column) => column.name);
      if (pk.length === 1) order = `ORDER BY ${quoteId(pk[0])} ASC`;
    }
    let total = null;
    try {
      const count = await this.raw(
        `SELECT /*+ MAX_EXECUTION_TIME(3000) */ COUNT(*) AS total FROM ${tableRef(database, table)} ${where}`,
        params
      );
      total = Number(count.rows[0]?.total ?? 0);
    } catch {
      total = null;
    }
    const offset = (safePage - 1) * safePageSize;
    const { result } = await this.raw(
      `SELECT * FROM ${tableRef(database, table)} ${where} ${order} LIMIT ? OFFSET ?`,
      [...params, safePageSize, offset]
    );
    return {
      columns,
      primaryKey: columns.filter((column) => column.key === 'PRI').map((column) => column.name),
      rows: result.map(serializeRow),
      total,
      page: safePage,
      pageSize: safePageSize
    };
  }

  async runQuery(sql, timeoutMs = 30000, rowLimit = MAX_QUERY_ROWS) {
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
      const rows = [];
      let truncated = false;
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
        query = connection.query({ sql: statement, rowsAsArray: true });
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
      const safeRowLimit = Math.max(0, Math.min(MAX_QUERY_ROWS, Number(rowLimit) || 0));
      query.on('result', (row) => {
        if (settled) return;
        if (rows.length >= safeRowLimit) {
          truncated = true;
          return;
        }
        const values = Array.isArray(row) ? row : Object.values(row || {});
        rows.push(values.map(serializeValue));
      });
      query.on('error', (error) => finish(reject, error));
      query.on('end', () => {
        finish(resolve, {
          kind: 'rows',
          columns,
          rows,
          truncated,
          durationMs: Date.now() - startedAt
        });
      });
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
      for (let index = 0; index < statements.length; index += 1) {
        if (task.canceled) break;
        const statement = statements[index];
        try {
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) throw fail('Truy vấn quá thời gian cho phép.', 'QUERY_TIMEOUT');
          const result = await this.runQuery(
            statement,
            remainingMs,
            Math.max(0, MAX_QUERY_BATCH_ROWS - storedRows)
          );
          if (result.kind === 'rows') storedRows += result.rows.length;
          results.push({ index: index + 1, sql: statement, ok: true, result });
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

  async updateRow({ database, table, keys, values }) {
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
    if (!changes.length) return { affectedRows: 0, changedRows: 0 };
    const setSql = changes.map(([name]) => `${quoteId(name)} = ?`).join(', ');
    const whereSql = pkColumns.map((name) => `${quoteId(name)} <=> ?`).join(' AND ');
    const params = [
      ...changes.map(([name, value]) => coerceValue(value, byName.get(name))),
      ...pkColumns.map((name) => {
        const column = byName.get(name);
        const kind = RowValues.describe(column).kind;
        return kind === 'binary' || kind === 'bit'
          ? coerceValue(Buffer.isBuffer(keys[name]) ? keys[name] : RowValues.displayValue(column, keys[name]), column) : keys[name];
      })
    ];
    const { result } = await this.raw(
      `UPDATE ${tableRef(database, table)} SET ${setSql} WHERE ${whereSql} LIMIT 1`,
      params
    );
    return { affectedRows: result.affectedRows, changedRows: result.changedRows };
  }

  async deleteRows({ database, table, keysList }) {
    if (!Array.isArray(keysList) || !keysList.length) throw fail('Chưa chọn bản ghi cần xóa.', 'NO_ROWS');
    if (keysList.length > 1000) throw fail('Chỉ có thể xóa tối đa 1000 bản ghi mỗi lần.', 'TOO_MANY_ROWS');
    const columns = await this.listColumns(database, table);
    const pkColumns = columns.filter((column) => column.key === 'PRI').map((column) => column.name);
    if (!pkColumns.length) throw fail('Bảng không có khóa chính nên không thể xóa trực tiếp.', 'NO_PRIMARY_KEY');
    const groups = [];
    const params = [];
    for (const keys of keysList) {
      if (!keys || pkColumns.some((name) => !(name in keys))) continue;
      groups.push(`(${pkColumns.map((name) => `${quoteId(name)} <=> ?`).join(' AND ')})`);
      for (const name of pkColumns) params.push(keys[name]);
    }
    if (!groups.length) throw fail('Không xác định được khóa chính của bản ghi.', 'MISSING_PRIMARY_KEY');
    const { result } = await this.raw(
      `DELETE FROM ${tableRef(database, table)} WHERE ${groups.join(' OR ')}`,
      params
    );
    return { affectedRows: result.affectedRows };
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
      const where = buildFileWhere(settings.filters, available, settings.search);
      const order = buildFileOrder(settings.orderBy, available);
      const names = selected.map((column) => quoteId(column.name));
      const sql = `SELECT ${names.join(', ')} FROM ${tableRef(database, table)}${where.sql}${order}`;
      if (format === 'json') {
        await emit('[\n');
      } else {
        await emit(`${selected.map((column) => csvField(column.name, delimiter)).join(delimiter)}\n`);
      }
      throwIfCanceled();
      const query = this.connection.query({ sql, values: where.params, rowsAsArray: true });
      let firstRow = true;
      try {
        for await (const row of query.stream()) {
          throwIfCanceled();
          if (format === 'json') {
            const fields = selected.map((column, index) => `${JSON.stringify(column.name)}:${exportJsonField(row[index], column)}`);
            await emit(`${firstRow ? '' : ',\n'}{${fields.join(',')}}`);
            firstRow = false;
          } else {
            await emit(`${selected.map((_column, index) => csvField(exportTextValue(row[index]), delimiter)).join(delimiter)}\n`);
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
    let lastReport = 0;
    const partialState = () => ({
      rows: rowsRead,
      written,
      committed,
      affectedRows,
      duplicates,
      batches,
      bytes,
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
    try {
      const available = await this.listColumns(database, table);
      if (!available.length) throw fail(`Không tìm thấy bảng hoặc cột của "${table}".`, 'TABLE_NOT_FOUND');
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
      this.clearActiveTask(task);
    }
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
            rowsAsArray: true
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
        durationMs: Date.now() - startedAt
      };
    } finally {
      this.clearActiveTask(task);
    }
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
          bytes,
          totalBytes: stat.size,
          statements,
          executed,
          skipped
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
        await this.raw(sql);
        executed += 1;
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

    return {
      database,
      statements: executed,
      skipped,
      bytes,
      durationMs: Date.now() - startedAt
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
