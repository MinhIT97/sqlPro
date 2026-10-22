'use strict';

const fs = require('node:fs');
const mysql = require('mysql2');
const { Client: SshClient } = require('ssh2');
const { SqlScriptParser, splitSqlStatements, stripLeadingComments, createTarget, skipReason } = require('./sql-script.cjs');

const MAX_QUERY_ROWS = 5000;
const MAX_QUERY_BATCH_ROWS = 10000;
const MAX_QUERY_STATEMENTS = 100;
const MAX_EXPORT_ROWS = 20000;
const MAX_IMPORT_ROWS = 5000;
const MAX_PAGE_SIZE = 500;
const MAX_BACKUP_BYTES = 1024 * 1024 * 1024;
const MAX_RESTORE_BYTES = 1024 * 1024 * 1024;
const BACKUP_INSERT_ROWS = 200;

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
  if (value === null || value === undefined) return null;
  if (value === '' && column && column.nullable === 'YES' && (isNumericType(column.type) || isDateType(column.type))) {
    return null;
  }
  return value;
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

class DatabaseSession {
  constructor(profile) {
    this.profile = profile;
    this.connection = null;
    this.ssh = null;
    this.dead = false;
    this.version = null;
    this.cancelQuery = null;
    this.metadata = new Map();
  }

  async openSshTunnel() {
    const ssh = this.profile.ssh;
    return new Promise((resolve, reject) => {
      const client = new SshClient();
      let settled = false;
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
      client.on('error', (error) => failConnect(fail(`SSH: ${error.message}`)));
      const options = {
        host: ssh.host,
        port: ssh.port,
        username: ssh.user,
        readyTimeout: 15000,
        keepaliveInterval: 15000,
        keepaliveCountMax: 3
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

  async runQueryScript(sql, timeoutMs = 30000, confirmed = false) {
    this.ensureOpen();
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

    if (statements.length === 1) return this.runQuery(statements[0], timeoutMs);

    const startedAt = Date.now();
    const deadline = startedAt + Math.max(1, Number(timeoutMs) || 30000);
    const results = [];
    let storedRows = 0;
    for (let index = 0; index < statements.length; index += 1) {
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
    return {
      kind: 'batch',
      statementCount: statements.length,
      executedCount: results.length,
      succeededCount: results.filter((entry) => entry.ok).length,
      failedCount: results.filter((entry) => !entry.ok).length,
      stopped: results.length < statements.length || results.some((entry) => !entry.ok),
      truncated: results.some((entry) => entry.ok && entry.result?.truncated),
      results,
      durationMs: Date.now() - startedAt
    };
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
      ...pkColumns.map((name) => keys[name])
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

  async importRows({ database, table, rows }) {
    if (!Array.isArray(rows) || !rows.length) throw fail('Không có bản ghi nào để nhập.', 'NO_ROWS');
    if (rows.length > MAX_IMPORT_ROWS) throw fail(`Mỗi lần chỉ nhập tối đa ${MAX_IMPORT_ROWS} bản ghi.`, 'TOO_MANY_ROWS');
    const columns = await this.listColumns(database, table);
    const allowed = new Set(columns.map((column) => column.name));
    const keys = [];
    for (const row of rows) {
      for (const key of Object.keys(row || {})) {
        if (allowed.has(key) && !keys.includes(key)) keys.push(key);
      }
    }
    if (!keys.length) throw fail('Không có cột nào khớp với bảng đích.', 'NO_MATCHING_COLUMNS');
    await new Promise((resolve, reject) => {
      this.connection.beginTransaction((error) => (error ? reject(error) : resolve()));
    });
    try {
      for (let offset = 0; offset < rows.length; offset += 100) {
        const batch = rows.slice(offset, offset + 100).map((row) => keys.map((key) => {
          const value = row[key];
          return value === undefined ? null : value;
        }));
        await this.raw(
          `INSERT INTO ${tableRef(database, table)} (${keys.map(quoteId).join(', ')}) VALUES ?`,
          [batch]
        );
      }
      await new Promise((resolve, reject) => {
        this.connection.commit((error) => (error ? reject(error) : resolve()));
      });
    } catch (error) {
      await new Promise((resolve) => {
        this.connection.rollback(() => resolve());
      });
      throw error;
    }
    return { inserted: rows.length };
  }

  async exportTable({ database, table }) {
    const { result, fields } = await this.raw(
      `SELECT * FROM ${tableRef(database, table)} LIMIT ?`,
      [MAX_EXPORT_ROWS + 1]
    );
    const truncated = result.length > MAX_EXPORT_ROWS;
    const rows = (truncated ? result.slice(0, MAX_EXPORT_ROWS) : result).map(serializeRow);
    return {
      columns: (fields || []).map((field) => field.name),
      rows,
      truncated
    };
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
    { database, tables, includeStructure = true, includeData = true, dropTables = false },
    write,
    onProgress
  ) {
    this.ensureOpen();
    if (typeof database !== 'string' || !database) throw fail('Database không hợp lệ.', 'INVALID_DATABASE');
    if (!includeStructure && !includeData) throw fail('Hãy chọn cấu trúc hoặc dữ liệu để sao lưu.', 'EMPTY_BACKUP');
    const available = await this.listTables(database);
    let selected;
    if (Array.isArray(tables) && tables.length) {
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
    if (!selected.length) throw fail('Database không có bảng hoặc view nào để sao lưu.', 'NO_TABLES');

    const dataTables = selected.filter((entry) => entry.type === 'table');
    const views = selected.filter((entry) => entry.type === 'view');
    const startedAt = Date.now();
    let bytes = 0;
    let rows = 0;
    let objects = 0;
    let triggerCount = 0;
    let lastReport = 0;

    const report = (force = false) => {
      const now = Date.now();
      if (!force && now - lastReport < 300) return;
      lastReport = now;
      if (typeof onProgress === 'function') onProgress({ operation: 'backup', bytes, rows, objects });
    };
    const emit = async (text) => {
      const chunk = String(text);
      const size = Buffer.byteLength(chunk);
      if (bytes + size > MAX_BACKUP_BYTES) {
        throw fail('Bản sao lưu vượt quá giới hạn 1 GB.', 'BACKUP_TOO_LARGE');
      }
      bytes += size;
      await write(chunk);
    };

    const header = [
      '-- SqlPro database backup',
      `-- Database: ${quoteId(database)}`,
      `-- Server: ${this.version}`,
      `-- Created: ${new Date().toISOString()}`,
      `-- Structure: ${includeStructure ? 'yes' : 'no'} · Data: ${includeData ? 'yes' : 'no'}`,
      '',
      'SET NAMES utf8mb4;',
      'SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0;',
      "SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO';",
      ''
    ].join('\n');
    await emit(`${header}\n`);

    if (includeStructure) {
      for (const entry of dataTables) {
        const created = await this.raw(`SHOW CREATE TABLE ${tableRef(database, entry.name)}`);
        const ddl = created.result[0] && created.result[0]['Create Table'];
        if (!ddl) throw fail(`Không đọc được cấu trúc bảng ${entry.name}.`, 'SHOW_CREATE_FAILED');
        await emit(`-- Table ${quoteId(entry.name)}${dropTables ? ' (drop first)' : ''}\n`);
        if (dropTables) await emit(`DROP TABLE IF EXISTS ${quoteId(entry.name)};\n`);
        await emit(`${String(ddl).replace(/;\s*$/, '')};\n\n`);
        objects += 1;
        report();
      }
    }

    if (includeData) {
      for (const entry of dataTables) {
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
        const rowValues = (row) => `(${row.map((value) => mysql.escape(value === undefined ? null : value)).join(', ')})`;
        const flush = async () => {
          if (!batch.length) return;
          const values = batch.map(rowValues).join(',\n  ');
          batch = [];
          await emit(`INSERT INTO ${quoteId(entry.name)} (${names.join(', ')}) VALUES\n  ${values};\n`);
          report();
        };
        for await (const row of query.stream()) {
          batch.push(row);
          rows += 1;
          if (batch.length >= BACKUP_INSERT_ROWS) await flush();
        }
        await flush();
        await emit('\n');
      }
    }

    if (includeStructure) {
      for (const entry of views) {
        const created = await this.raw(`SHOW CREATE VIEW ${tableRef(database, entry.name)}`);
        const ddl = created.result[0] && created.result[0]['Create View'];
        if (!ddl) throw fail(`Không đọc được cấu trúc view ${entry.name}.`, 'SHOW_CREATE_FAILED');
        await emit(`-- View ${quoteId(entry.name)}\n`);
        if (dropTables) await emit(`DROP VIEW IF EXISTS ${quoteId(entry.name)};\n`);
        await emit(`${String(ddl).replace(/;\s*$/, '')};\n\n`);
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

    await emit([
      'SET SQL_MODE=@OLD_SQL_MODE;',
      'SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS;',
      '-- End of backup',
      ''
    ].join('\n'));
    report(true);
    return {
      database,
      tables: dataTables.length,
      views: views.length,
      triggers: triggerCount,
      rows,
      bytes,
      durationMs: Date.now() - startedAt
    };
  }

  async restoreDatabase({ database, filePath, dropExisting = false }, onProgress) {
    this.ensureOpen();
    if (typeof database !== 'string' || !database) throw fail('Database đích không hợp lệ.', 'INVALID_DATABASE');
    if (typeof filePath !== 'string' || !filePath) throw fail('Tệp SQL không hợp lệ.', 'INVALID_FILE');
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) throw fail('Đường dẫn phục hồi không phải là tệp.', 'INVALID_FILE');
    if (stat.size > MAX_RESTORE_BYTES) throw fail('Tệp SQL vượt quá giới hạn 1 GB.', 'RESTORE_TOO_LARGE');

    const startedAt = Date.now();
    const previous = await this.raw('SELECT @@FOREIGN_KEY_CHECKS AS value');
    const previousForeignKeys = Number(previous.rows[0]?.value) === 0 ? 0 : 1;
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

    const execute = async (rawStatement) => {
      const sql = String(rawStatement || '').trim();
      if (!sql) return;
      statements += 1;
      if (skipReason(sql)) {
        skipped += 1;
        return;
      }
      if (dropExisting) {
        const target = createTarget(sql);
        if (target && target.name) {
          const kind = target.type === 'view' ? 'VIEW' : target.type === 'trigger' ? 'TRIGGER' : 'TABLE';
          await this.raw(`DROP ${kind} IF EXISTS ${quoteId(target.name)}`);
        }
      }
      try {
        await this.raw(sql);
        executed += 1;
      } catch (error) {
        const summary = sql.replace(/\s+/g, ' ').slice(0, 120);
        let message = `Lỗi ở câu lệnh #${statements}: ${error.message}`;
        if (summary) message += `\n${summary}${sql.length > 120 ? '…' : ''}`;
        if (error.code === 'ER_TABLE_EXISTS_ERROR' && !dropExisting) {
          message += '\nBật tùy chọn "Xóa bảng/view/trigger trùng tên" nếu muốn ghi đè.';
        }
        error.message = message;
        throw error;
      }
    };

    try {
      for await (const chunk of stream) {
        bytes += Buffer.byteLength(chunk);
        for (const statement of parser.push(chunk)) await execute(statement);
        report();
      }
      for (const statement of parser.end()) await execute(statement);
      report(true);
    } finally {
      try {
        await this.raw(`SET FOREIGN_KEY_CHECKS=${previousForeignKeys}`);
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

module.exports = { DatabaseSession, testConnection, quoteId, MAX_RESTORE_BYTES };
