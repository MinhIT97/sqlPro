'use strict';

// Source-only preview. This inventory is never an authorization or execution
// plan: target schema, triggers, permissions and file hash need fresh checks
// before any future selective restore implementation can write to a database.
const VERSION = 1;
const { analyzeTableColumns } = require('./restore-selection-columns.cjs');
const { reviewLiteralInsert } = require('./restore-selection-syntax.cjs');
const MAX_TABLES = 1000;
const MAX_DEPENDENCIES = 10000;
const MAX_FINDINGS = 50;
const WORD = /[\p{L}\p{N}_$]+/uy;
const IDENTIFIER = '(?:`(?:[^`]|``)+`|[\\p{L}\\p{N}_$]+)';
const REFERENCE = `${IDENTIFIER}(?:\\s*\\.\\s*${IDENTIFIER})?`;
const INSERT_TARGET = new RegExp(`^INSERT\\s+(?:(?:LOW_PRIORITY|DELAYED|HIGH_PRIORITY|IGNORE)\\s+)*(?:INTO\\s+)?(${REFERENCE})`, 'iu');
const DROP_TARGET = new RegExp(`^DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(${REFERENCE})`, 'iu');
const INSERT_COLUMN_LIST = new RegExp(`^\\s*\\((\\s*${IDENTIFIER}(?:\\s*,\\s*${IDENTIFIER})*\\s*)\\)\\s*(?:VALUES?|SELECT)\\b`, 'iu');

function tokenizeDefinition(sql) {
  if (Buffer.byteLength(sql) > 2 * 1024 * 1024) throw new Error('DEFINITION_LIMIT');
  const tokens = [];
  let i = 0;
  while (i < sql.length) {
    if (tokens.length >= 65536) throw new Error('DEFINITION_LIMIT');
    const c = sql[i], next = sql[i + 1];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '#' || c === '-' && next === '-' && (!sql[i + 2] || /\s/.test(sql[i + 2]))) {
      while (i < sql.length && !/[\r\n]/.test(sql[i])) i++;
      continue;
    }
    if (c === '/' && next === '*') {
      if (sql[i + 2] === '!' || /^\/\*M!/i.test(sql.slice(i, i + 4))) throw new Error('EXECUTABLE_COMMENT');
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) throw new Error('DEFINITION_SYNTAX');
      i = end + 2; continue;
    }
    if (c === '`' || c === "'" || c === '"') {
      const quote = c; let value = '', closed = false; i++;
      while (i < sql.length) {
        const character = sql[i++];
        if (quote !== '`' && character === '\\') { i++; continue; }
        if (character === quote) {
          if (sql[i] === quote) { value += quote; i++; continue; }
          closed = true; break;
        }
        if (quote === '`') value += character;
      }
      if (!closed) throw new Error('DEFINITION_SYNTAX');
      tokens.push({ kind: quote === '`' ? 'identifier' : 'literal', value });
      continue;
    }
    WORD.lastIndex = i;
    const word = WORD.exec(sql);
    if (word) { tokens.push({ kind: 'word', value: word[0] }); i += word[0].length; continue; }
    tokens.push({ kind: 'symbol', value: c }); i++;
  }
  return tokens;
}

const keyword = (token, word) => token?.kind === 'word' && token.value.toUpperCase() === word;
const identifier = token => ['word', 'identifier'].includes(token?.kind);
function reference(tokens, index) {
  if (!identifier(tokens[index])) return null;
  const first = tokens[index++].value;
  if (tokens[index]?.value !== '.') return { schema: null, table: first, next: index };
  if (!identifier(tokens[index + 1])) return null;
  return { schema: first, table: tokens[index + 1].value, next: index + 2 };
}

class RestoreSelectionInventory {
  constructor(database) {
    this.database = database;
    this.tables = new Map(); this.opaqueObjects = []; this.findings = [];
    this.dependencies = 0; this.truncated = false;
    this.columnCount = 0;
    this.insertColumnCount = 0;
    this.statements = [];
    this.statementCount = 0;
    this.statementsTruncated = false;
    this.literalValidationBytes = 0;
  }

  recordStatement(statement) {
    this.statementCount++;
    if (this.statements.length < 10000) this.statements.push(statement);
    else this.statementsTruncated = true;
  }

  recordSkipped(statementNumber, reason) {
    this.recordStatement({ number: statementNumber, command: 'DIRECTIVE', kind: 'skipped', table: null, schema: null,
      reason: reason === 'USE' ? 'USE' : 'database' });
  }

  finding(code, statementNumber, table = null) {
    if (!this.findings.some(item => item.code === code && item.table === table)) {
      if (this.findings.length < MAX_FINDINGS) this.findings.push({ code, statementNumber, table });
      else this.truncated = true;
    }
  }

  table(name) {
    if (typeof name !== 'string' || !name || name.length > 64) { this.truncated = true; return null; }
    if (!this.tables.has(name)) {
      if (this.tables.size >= MAX_TABLES) { this.truncated = true; return null; }
      this.tables.set(name, { name, createStatements: 0, dataStatements: 0, dropStatements: 0, dependencies: [],
        columnSchema: null, insertColumnMode: 'none', insertColumnSets: [] });
    }
    return this.tables.get(name);
  }

  add(sql, analysis, statementNumber) {
    const statement = { number: statementNumber, command: analysis.command, kind: 'unclassified', table: null, schema: null };
    this.recordStatement(statement);
    this.analyze(sql, analysis, statementNumber, statement);
    if (analysis.command === 'INSERT' && this.statementCount <= 10000) {
      const bytes = sql.length > 2 * 1024 * 1024 ? Infinity : Buffer.byteLength(sql);
      if (bytes > 2 * 1024 * 1024 || this.literalValidationBytes + bytes > 32 * 1024 * 1024) {
        statement.syntaxReview = { version: 1, status: 'unsupported', code: 'INSERT_VALIDATION_LIMIT' };
      } else {
        this.literalValidationBytes += bytes;
        statement.syntaxReview = reviewLiteralInsert(sql);
        if (statement.syntaxReview.status === 'matched' && (statement.kind !== 'data'
            || statement.table !== statement.syntaxReview.table || statement.schema !== statement.syntaxReview.schema)) {
          statement.syntaxReview = { version: 1, status: 'unsupported', code: 'INSERT_TARGET_MISMATCH' };
        }
      }
    }
  }

  analyze(sql, analysis, statementNumber, statement) {
    const { command, refs } = analysis;
    if (command === 'CREATE') {
      let tokens;
      try { tokens = tokenizeDefinition(sql); }
      catch (error) { this.finding(error.message, statementNumber); return; }
      if (!keyword(tokens[0], 'CREATE') || !keyword(tokens[1], 'TABLE')) {
        this.finding('NON_TABLE_DEFINITION', statementNumber);
        if (this.opaqueObjects.length < MAX_TABLES) this.opaqueObjects.push({ name: String(refs[0]?.table || '').slice(0, 64), command: 'CREATE' });
        else this.truncated = true;
        return;
      }
      let index = 2;
      if (keyword(tokens[index], 'IF') && keyword(tokens[index + 1], 'NOT') && keyword(tokens[index + 2], 'EXISTS')) {
        this.finding('CONDITIONAL_CREATE', statementNumber); index += 3;
      }
      const target = reference(tokens, index);
      if (!target || tokens[target.next]?.value !== '(' || target.schema && target.schema !== this.database) {
        this.finding('UNSUPPORTED_TABLE_DEFINITION', statementNumber); return;
      }
      const entry = this.table(target.table);
      if (!entry) return;
      Object.assign(statement, { kind: 'structure', table: target.table, schema: target.schema });
      if (++entry.createStatements > 1) this.finding('REPEATED_CREATE', statementNumber, entry.name);
      const columns = analyzeTableColumns(tokens, target.next, Math.max(0, 10000 - this.columnCount));
      this.columnCount += columns.columns.length;
      if (entry.createStatements === 1) entry.columnSchema = columns;
      else entry.columnSchema.complete = false;
      if (!columns.complete) this.finding('SOURCE_COLUMNS_INCOMPLETE', statementNumber, entry.name);
      for (let i = target.next + 1; i < tokens.length; i++) {
        if (['SELECT', 'LIKE', 'DIRECTORY', 'TABLESPACE', 'UNION', 'CONNECTION'].some(word => keyword(tokens[i], word))) this.finding('UNSUPPORTED_TABLE_DEFINITION', statementNumber, entry.name);
        if (!keyword(tokens[i], 'REFERENCES')) continue;
        const ref = reference(tokens, i + 1);
        if (!ref || !ref.table || ref.table.length > 64 || ref.schema?.length > 64 || tokens[ref.next]?.value !== '(') { this.finding('UNKNOWN_DEPENDENCY', statementNumber, entry.name); continue; }
        const dependency = { schema: ref.schema, table: ref.table };
        if (entry.dependencies.some(item => item.schema === dependency.schema && item.table === dependency.table)) continue;
        if (this.dependencies >= MAX_DEPENDENCIES) { this.truncated = true; continue; }
        entry.dependencies.push(dependency); this.dependencies++;
      }
    } else if (command === 'INSERT') {
      const match = INSERT_TARGET.exec(analysis.sql);
      const target = match && reference(tokenizeDefinition(match[1]), 0);
      const entry = this.table(target?.table);
      if (entry) {
        Object.assign(statement, { kind: 'data', table: target.table, schema: target.schema });
        entry.dataStatements++;
        const tail = analysis.sql.slice(match[0].length);
        const list = INSERT_COLUMN_LIST.exec(tail.slice(0, 65536));
        let mode = /^\s*VALUES?\b/i.test(tail) ? 'positional' : 'unknown';
        if (list) {
          mode = 'explicit';
          const names = tokenizeDefinition(list[1]).filter(identifier).map(token => token.value);
          const exists = entry.insertColumnSets.some(set => JSON.stringify(set) === JSON.stringify(names));
          if (names.length > 256 || names.some(name => name.length > 64) || new Set(names.map(name => name.toLowerCase())).size !== names.length) mode = 'unknown';
          else if (!exists) {
            if (entry.insertColumnSets.length >= 8 || this.insertColumnCount + names.length > 10000) mode = 'unknown';
            else { entry.insertColumnSets.push(names); this.insertColumnCount += names.length; }
          }
        }
        entry.insertColumnMode = entry.insertColumnMode === 'none' ? mode : entry.insertColumnMode === mode ? mode : 'mixed';
      }
      if (/\bSELECT\b/i.test(analysis.sql)) this.finding('DATA_DEPENDENCIES_NOT_ANALYZED', statementNumber, entry?.name || null);
      // INSERT expressions, functions and triggers are not proven side-effect
      // free. Counts describe statements, never guaranteed restored rows.
    } else if (command === 'DROP' && /^DROP\s+TABLE\b/i.test(analysis.sql) && refs.length === 1) {
      const match = DROP_TARGET.exec(analysis.sql);
      const target = match && reference(tokenizeDefinition(match[1]), 0);
      const entry = this.table(target?.table);
      if (entry) {
        entry.dropStatements++;
        Object.assign(statement, { kind: 'structure', table: target.table, schema: target.schema });
      }
    } else if (command === 'SET' && /\bSQL_MODE\b/i.test(analysis.sql)) {
      this.finding('SQL_MODE_CONTEXT', statementNumber);
    } else if (!['SET', 'BEGIN', 'START', 'COMMIT', 'ROLLBACK', 'UNLOCK'].includes(command)) {
      this.finding('UNSUPPORTED_STATEMENT', statementNumber);
    }
    if (['SET', 'BEGIN', 'START', 'COMMIT', 'ROLLBACK', 'UNLOCK'].includes(command)) statement.kind = 'context';
  }

  finish() {
    const folded = new Set();
    for (const table of this.tables.values()) {
      const key = table.name.toLowerCase();
      if (folded.has(key)) this.finding('CASE_AMBIGUITY', null, table.name);
      folded.add(key);
    }
    return { version: VERSION, database: this.database, tables: [...this.tables.values()],
      opaqueObjects: this.opaqueObjects, findings: this.findings, truncated: this.truncated,
      statementLedger: { version: 1, total: this.statementCount, entries: this.statements, truncated: this.statementsTruncated } };
  }
}

function previewRestoreSelection(inventory, { tables, includeStructure = true, includeData = true } = {}) {
  if (!inventory || inventory.version !== VERSION || !Array.isArray(inventory.tables) || inventory.tables.length > MAX_TABLES) throw new Error('Backup chưa có inventory lựa chọn; hãy quét lại tệp.');
  if (!Array.isArray(tables) || !tables.length || tables.length > MAX_TABLES || tables.some(name => typeof name !== 'string') || new Set(tables).size !== tables.length) throw new Error('Chọn từ 1 đến 1.000 bảng, không trùng tên.');
  if (typeof includeStructure !== 'boolean' || typeof includeData !== 'boolean' || !includeStructure && !includeData) throw new Error('Hãy chọn cấu trúc hoặc dữ liệu.');
  const byName = new Map(inventory.tables.map(table => [table.name, table]));
  if (tables.some(name => !byName.has(name))) throw new Error('Có bảng không thuộc inventory backup hiện tại. Hãy quét lại.');
  const selected = new Set(tables);
  const findings = [...inventory.findings];
  let findingsTruncated = false;
  const add = (code, table, dependency = null) => {
    if (findings.length < 100) findings.push({ code, table, dependency });
    else findingsTruncated = true;
  };
  const rows = tables.map(name => {
    const entry = byName.get(name);
    if (includeStructure && entry.createStatements !== 1) add('STRUCTURE_UNAVAILABLE', name);
    for (const ref of entry.dependencies) {
      if (ref.schema && ref.schema !== inventory.database) add('EXTERNAL_DEPENDENCY', name, ref.table);
      else if (!selected.has(ref.table)) add(byName.has(ref.table) ? 'MISSING_DEPENDENCY' : 'DEPENDENCY_NOT_IN_BACKUP', name, ref.table);
    }
    return { name, createStatements: includeStructure ? entry.createStatements : 0,
      dataStatements: includeData ? entry.dataStatements : 0, dropStatements: includeStructure ? entry.dropStatements : 0,
      dependencies: entry.dependencies, columnSchema: entry.columnSchema || null,
      insertColumnMode: includeData ? entry.insertColumnMode || 'unknown' : 'none', insertColumnSets: includeData ? entry.insertColumnSets || [] : [] };
  });
  // Iterative topological sort keeps a bounded stack even for long FK chains.
  const remaining = new Map(rows.map(row => [row.name, new Set(row.dependencies.filter(ref => (!ref.schema || ref.schema === inventory.database) && selected.has(ref.table)).map(ref => ref.table))]));
  const order = [];
  while (remaining.size) {
    const ready = [...remaining].filter(([, refs]) => !refs.size).map(([name]) => name);
    if (!ready.length) break;
    for (const name of ready) { order.push(name); remaining.delete(name); }
    for (const refs of remaining.values()) for (const name of ready) refs.delete(name);
  }
  if (remaining.size) add('FK_CYCLE_OR_BLOCKED', null);
  if (inventory.truncated) add('INVENTORY_TRUNCATED', null);
  if (!includeStructure) add('TARGET_STRUCTURE_NOT_CHECKED', null);
  return { version: VERSION, mode: 'source-only', sourceDatabase: inventory.database, canExecute: false, targetReviewed: false,
    selectedTables: tables, includeStructure, includeData, rows, order,
    unresolvedOrder: [...remaining.keys()], findings, findingsTruncated,
    excludedTables: inventory.tables.length - rows.length, excludedDefinitions: inventory.opaqueObjects.length,
    totals: rows.reduce((sum, row) => ({ createStatements: sum.createStatements + row.createStatements,
      dataStatements: sum.dataStatements + row.dataStatements, dropStatements: sum.dropStatements + row.dropStatements }),
    { createStatements: 0, dataStatements: 0, dropStatements: 0 }) };
}

module.exports = { RestoreSelectionInventory, previewRestoreSelection };
