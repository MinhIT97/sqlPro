'use strict';

const crypto = require('node:crypto');

/**
 * ============================================================================
 * SCHEMA SNAPSHOT COLLECTOR (Main Process Service — G6.1 / G6.2)
 *
 * Runs strictly within the Electron Main Process.
 * Gathers complete, faithful database schema metadata including:
 * - Engine & Version detection (MySQL vs MariaDB)
 * - Tables, Columns, Indexes, Foreign Keys, Collations, Comments
 * - Views with real definitions (via SHOW CREATE VIEW or information_schema)
 * - Stored Procedures & Functions with real definitions
 * - Triggers with real definitions, timing, events, and statements
 * - Scheduled Events with real definitions, status, and intervals
 *
 * Safety & Integrity Guarantees:
 * 1. Missing privileges / errors do NOT become silent empty arrays ([]).
 *    Inaccessible layers are explicitly marked with `status: 'unknown'` and
 *    recorded in `warnings`.
 * 2. Bypasses session metadata cache to guarantee drift detection.
 * 3. Binds real session identity & generation context from Main Process.
 * 4. Deterministic canonical representation and SHA-256 fingerprint.
 * 5. Projections for Renderer bound quotas and keep full definitions at Main.
 * ============================================================================
 */

const DEFAULT_QUOTAS = {
  maxObjects: 2000,
  maxDdlBytes: 8 * 1024 * 1024, // 8 MB
  timeoutMs: 30000 // 30 seconds
};

const DEFAULT_PROJECTION_LIMITS = {
  maxTables: 100,
  maxViews: 100,
  maxRoutines: 100,
  maxTriggers: 100,
  maxEvents: 100,
  maxWarnings: 50
};

function detectEngine(versionString = '', profileType = '') {
  const v = String(versionString).toLowerCase();
  const t = String(profileType).toLowerCase();
  if (v.includes('mariadb') || t === 'mariadb') {
    return 'MariaDB';
  }
  return 'MySQL';
}

function splitViewDdl(ddl = '') {
  if (!ddl || typeof ddl !== 'string') return null;
  const len = ddl.length;
  let inQuote = null; // "'", '"', or '`'
  let inLineComment = false;
  let inBlockComment = false;
  let parenDepth = 0;
  let seenView = false;
  let asIndex = -1;

  for (let i = 0; i < len; i++) {
    const ch = ddl[i];
    const next = i + 1 < len ? ddl[i + 1] : '';

    if (inLineComment) {
      if (ch === '\n' || ch === '\r') {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++; // skip /
      }
      continue;
    }

    if (inQuote) {
      if (ch === '\\') {
        i++; // skip escaped char
        continue;
      }
      if (ch === inQuote) {
        if (next === inQuote) {
          i++; // skip doubled quote
          continue;
        }
        inQuote = null;
      }
      continue;
    }

    // Outside quotes and comments:
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if ((ch === '-' && next === '-' && (i + 2 < len && /\s/.test(ddl[i + 2]))) || ch === '#') {
      inLineComment = true;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      inQuote = ch;
      continue;
    }

    if (ch === '(') {
      parenDepth++;
      continue;
    }
    if (ch === ')') {
      if (parenDepth > 0) parenDepth--;
      continue;
    }

    if (parenDepth === 0) {
      // Check for keyword VIEW outside quotes
      if (!seenView) {
        if ((i === 0 || /[\s\(\),;]/.test(ddl[i - 1])) &&
            ddl.slice(i, i + 4).toUpperCase() === 'VIEW' &&
            (i + 4 >= len || /[\s\(\),;`]/.test(ddl[i + 4]))) {
          seenView = true;
          i += 3;
          continue;
        }
      } else {
        // Seen VIEW, now looking for standalone AS keyword outside quotes/comments/parens
        if ((i === 0 || /[\s\(\),;`]/.test(ddl[i - 1])) &&
            ddl.slice(i, i + 2).toUpperCase() === 'AS' &&
            (i + 2 >= len || /[\s\(\),;`]/.test(ddl[i + 2]))) {
          asIndex = i;
          break;
        }
      }
    }
  }

  if (asIndex === -1) {
    return null;
  }

  const header = ddl.slice(0, asIndex).trim();
  const rawBody = ddl.slice(asIndex + 2).trim();

  return { header, rawBody };
}

function tokenizeHeader(header = '') {
  const tokens = [];
  let i = 0;
  const n = header.length;

  while (i < n) {
    const ch = header[i];

    // Whitespace
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Line comment: -- or #
    if (ch === '#' || (ch === '-' && header[i + 1] === '-' && (i + 2 >= n || /\s/.test(header[i + 2])))) {
      i++;
      while (i < n && header[i] !== '\n' && header[i] !== '\r') i++;
      continue;
    }

    // Block comment: /* ... */
    if (ch === '/' && header[i + 1] === '*') {
      i += 2;
      while (i < n && !(header[i] === '*' && header[i + 1] === '/')) i++;
      if (i < n) i += 2;
      continue;
    }

    // Quoted strings/identifiers: `...`, '...', "..."
    if (ch === '`' || ch === "'" || ch === '"') {
      const quoteChar = ch;
      const start = i;
      i++;
      while (i < n) {
        if (header[i] === '\\') {
          i += 2; // skip escaped character
          continue;
        }
        if (header[i] === quoteChar) {
          if (i + 1 < n && header[i + 1] === quoteChar) {
            i += 2; // doubled quote escape (e.g. `` or '')
            continue;
          }
          i++; // close quote
          break;
        }
        i++;
      }
      const raw = header.slice(start, i);
      const inner = raw.slice(1, raw.endsWith(quoteChar) ? -1 : undefined);
      tokens.push({ type: 'quoted', quoteChar, raw, value: inner });
      continue;
    }

    // Punctuation / Operators: =, @, (, ), ,, ., ;
    if (/^[=@(),.;]$/.test(ch)) {
      tokens.push({ type: 'punct', raw: ch, value: ch });
      i++;
      continue;
    }

    // Words / Identifiers / Keywords (including %, -, :, $ in unquoted identifiers/hosts)
    if (/[a-zA-Z0-9_$%:-]/.test(ch)) {
      const start = i;
      while (i < n && /[a-zA-Z0-9_$%:-]/.test(header[i])) {
        i++;
      }
      const raw = header.slice(start, i);
      tokens.push({ type: 'word', raw, value: raw });
      continue;
    }

    // Fallback single character
    tokens.push({ type: 'unknown', raw: ch, value: ch });
    i++;
  }

  return tokens;
}

function parseHeaderAttributes(header = '') {
  const tokens = tokenizeHeader(header);
  let algorithm = null;
  let definer = null;
  let security = null;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    if (t.type === 'word' && t.value.toUpperCase() === 'ALGORITHM') {
      let nextIdx = i + 1;
      if (nextIdx < tokens.length && tokens[nextIdx].type === 'punct' && tokens[nextIdx].value === '=') {
        nextIdx++;
      }
      if (nextIdx < tokens.length && (tokens[nextIdx].type === 'word' || tokens[nextIdx].type === 'quoted')) {
        algorithm = tokens[nextIdx].value.toUpperCase();
        i = nextIdx;
      }
    } else if (t.type === 'word' && t.value.toUpperCase() === 'DEFINER') {
      let nextIdx = i + 1;
      if (nextIdx < tokens.length && tokens[nextIdx].type === 'punct' && tokens[nextIdx].value === '=') {
        nextIdx++;
      }
      if (nextIdx < tokens.length) {
        const userTok = tokens[nextIdx];
        if (userTok.type === 'word' && userTok.value.toUpperCase() === 'CURRENT_USER') {
          let defStr = 'CURRENT_USER';
          if (nextIdx + 2 < tokens.length && tokens[nextIdx + 1].value === '(' && tokens[nextIdx + 2].value === ')') {
            defStr = 'CURRENT_USER()';
            nextIdx += 2;
          }
          definer = defStr;
          i = nextIdx;
        } else if (userTok.type === 'word' || userTok.type === 'quoted') {
          let defStr = userTok.raw;
          if (nextIdx + 2 < tokens.length && tokens[nextIdx + 1].value === '@') {
            const hostTok = tokens[nextIdx + 2];
            if (hostTok.type === 'word' || hostTok.type === 'quoted') {
              defStr = `${userTok.raw}@${hostTok.raw}`;
              nextIdx += 2;
            }
          }
          definer = defStr;
          i = nextIdx;
        }
      }
    } else if (t.type === 'word' && t.value.toUpperCase() === 'SQL') {
      if (i + 2 < tokens.length &&
          tokens[i + 1].type === 'word' && tokens[i + 1].value.toUpperCase() === 'SECURITY' &&
          tokens[i + 2].type === 'word' && /^(DEFINER|INVOKER)$/i.test(tokens[i + 2].value)) {
        security = tokens[i + 2].value.toUpperCase();
        i += 2;
      }
    }
  }

  return { algorithm, definer, security };
}

function parseViewDdl(ddl = '') {
  if (!ddl || typeof ddl !== 'string') return {};
  const trimmed = ddl.trim();
  const split = splitViewDdl(trimmed);
  if (!split) {
    return {
      syntaxError: true,
      status: 'unknown',
      migrationStatus: 'blocked',
      migrationBlockReason: 'UNRECOGNIZED_VIEW_SYNTAX',
      ddl: trimmed
    };
  }

  const { header, rawBody } = split;

  // Extract ALGORITHM, DEFINER, SQL SECURITY via lexical tokenizer:
  const { algorithm, definer, security } = parseHeaderAttributes(header);

  // Extract WITH CHECK OPTION from rawBody:
  let definition = rawBody;
  let checkOption = null;

  const checkMatch = /\bWITH\s+(CASCADED|LOCAL)\s+CHECK\s+OPTION\s*$/i.exec(rawBody);
  const simpleCheckMatch = !checkMatch && /\bWITH\s+CHECK\s+OPTION\s*$/i.exec(rawBody);
  if (checkMatch) {
    checkOption = checkMatch[1].toUpperCase();
    definition = rawBody.slice(0, checkMatch.index).trim();
  } else if (simpleCheckMatch) {
    checkOption = 'CASCADED';
    definition = rawBody.slice(0, simpleCheckMatch.index).trim();
  }

  return {
    algorithm,
    definer,
    security,
    checkOption,
    definition,
    ddl: trimmed
  };
}

function canonicalStringify(obj) {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalStringify).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(obj[k])).join(',') + '}';
}

function computeSchemaFingerprint(canonicalData) {
  const json = canonicalStringify(canonicalData);
  return crypto.createHash('sha256').update(json).digest('hex');
}

class SchemaSnapshotCollector {
  /**
   * @param {object} session - DatabaseSession instance or session-like driver
   * @param {object} options - Options including optional session context and quotas
   */
  constructor(session, options = {}) {
    if (!session) throw new Error('DatabaseSession bắt buộc phải được cung cấp.');
    this.session = session;
    this.options = options;
    this.quotas = Object.assign({}, DEFAULT_QUOTAS, options.quotas || {});
  }

  _isTimedOut(quotas, state) {
    if (state.timedOut) return true;
    if (Date.now() - state.startTime > quotas.timeoutMs) {
      state.timedOut = true;
      return true;
    }
    return false;
  }

  _checkTimeout(category, warnings, quotas, state) {
    if (this._isTimedOut(quotas, state)) {
      if (!warnings.some((w) => w.code === 'SNAPSHOT_TIMEOUT')) {
        warnings.push({
          code: 'SNAPSHOT_TIMEOUT',
          category: category || 'general',
          message: `Quá thời gian cho phép khi thu thập snapshot (${quotas.timeoutMs}ms).`
        });
      }
      return true;
    }
    return false;
  }

  _getRemainingTimeout(quotas, state) {
    const elapsed = Date.now() - state.startTime;
    const remaining = quotas.timeoutMs - elapsed;
    return remaining > 0 ? remaining : 1;
  }

  async collect(database, options = {}) {
    if (typeof database !== 'string' || !database.trim()) {
      throw new Error('Tên database không hợp lệ.');
    }

    if (this.session.dead) {
      throw Object.assign(
        new Error('Phiên kết nối đã bị đóng hoặc mất kết nối trong quá trình thu thập snapshot.'),
        { code: 'SESSION_DEAD' }
      );
    }

    // Always clear session metadata cache to ensure fresh read and prevent stale drift blindness:
    if (this.session.metadata && typeof this.session.metadata.clear === 'function') {
      this.session.metadata.clear();
    }

    const quotas = Object.assign({}, this.quotas, options.quotas || {});
    const state = {
      startTime: Date.now(),
      cumulativeDdlBytes: 0,
      totalObjects: 0,
      timedOut: false
    };

    const context = {
      sessionId: options.sessionId || this.options.sessionId || this.session.sessionId || null,
      profileId: options.profileId || this.options.profileId || this.session.profile?.id || null,
      profileFingerprint: options.profileFingerprint || this.options.profileFingerprint || null,
      generation: options.generation ?? this.options.generation ?? 0
    };

    const startedAt = new Date().toISOString();
    const warnings = [];

    const engine = detectEngine(this.session.version, this.session.profile?.type);
    const serverVersion = this.session.version || '';

    // Check timeout before starting collection:
    this._checkTimeout('general', warnings, quotas, state);

    let tablesResult = { coverage: 'unknown', items: [] };
    let viewsResult = { coverage: 'unknown', items: [] };
    let routinesResult = { coverage: 'unknown', items: [] };
    let triggersResult = { coverage: 'unknown', items: [] };
    let eventsResult = { coverage: 'unknown', items: [] };

    if (!state.timedOut) {
      // 1. Collect Tables & Structural Components (bypassing cache)
      tablesResult = await this.collectTables(database, warnings, quotas, state);
    }

    if (!this._checkTimeout('views', warnings, quotas, state)) {
      // 2. Collect Views
      viewsResult = await this.collectViews(database, warnings, quotas, state);
    }

    if (!this._checkTimeout('routines', warnings, quotas, state)) {
      // 3. Collect Routines (Procedures & Functions)
      routinesResult = await this.collectRoutines(database, warnings, quotas, state);
    }

    if (!this._checkTimeout('triggers', warnings, quotas, state)) {
      // 4. Collect Triggers
      triggersResult = await this.collectTriggers(database, warnings, quotas, state);
    }

    if (!this._checkTimeout('events', warnings, quotas, state)) {
      // 5. Collect Events
      eventsResult = await this.collectEvents(database, warnings, quotas, state);
    }

    // Verify session did not die during collection:
    if (this.session.dead) {
      throw Object.assign(
        new Error('Phiên kết nối đã bị ngắt trong quá trình thu thập metadata.'),
        { code: 'SESSION_DEAD' }
      );
    }

    // 6. Assess Overall Coverage
    const categoryCoverages = [
      tablesResult.coverage,
      viewsResult.coverage,
      routinesResult.coverage,
      triggersResult.coverage,
      eventsResult.coverage
    ];

    let overallCoverage = 'complete';
    if (categoryCoverages.every((c) => c === 'unknown')) {
      overallCoverage = 'unknown';
    } else if (categoryCoverages.some((c) => c === 'partial' || c === 'unknown') || state.timedOut) {
      overallCoverage = 'partial';
    }

    // 7. Build Canonical Schema Representation (for diff & fingerprint)
    const canonicalData = {
      database,
      engine,
      tables: tablesResult.items.map((t) => ({
        name: t.name,
        engine: t.engine,
        collation: t.collation || null,
        comment: t.comment,
        foreignKeysStatus: t.foreignKeysStatus || 'complete',
        columns: t.columns.map((c) => ({
          name: c.name,
          type: c.type,
          nullable: c.nullable,
          default: c.default,
          extra: c.extra,
          comment: c.comment,
          collation: c.collation || null,
          isGenerated: Boolean(c.isGenerated),
          generationExpression: c.generationExpression || null,
          isDefaultGenerated: Boolean(c.isDefaultGenerated)
        })),
        indexes: t.indexes.map((i) => ({
          name: i.name,
          isPrimary: i.isPrimary,
          isUnique: i.isUnique,
          type: i.type,
          visibilityKind: i.visibilityKind,
          visibility: i.visibility,
          status: i.status,
          migrationStatus: i.migrationStatus,
          migrationBlockReason: i.migrationBlockReason,
          columns: i.columns.map((col) => ({
            name: col.name,
            expression: col.expression,
            subPart: col.subPart || null,
            direction: col.direction || null
          }))
        })),
        foreignKeys: t.foreignKeys.map((fk) => ({
          name: fk.name,
          columns: fk.columns,
          referencedDatabase: fk.referencedDatabase || null,
          referencedTable: fk.referencedTable || null,
          referencedColumns: fk.referencedColumns,
          onDelete: fk.onDelete || null,
          onUpdate: fk.onUpdate || null
        }))
      })),
      views: viewsResult.items.map((v) => ({
        name: v.name,
        status: v.status,
        reason: v.reason || null,
        algorithm: v.algorithm || null,
        definer: v.definer || null,
        security: v.security || null,
        checkOption: v.checkOption || null,
        definition: v.definition || null,
        ddl: v.ddl || null,
        migrationStatus: v.migrationStatus || (v.status === 'unknown' ? 'blocked' : 'supported'),
        migrationBlockReason: v.migrationBlockReason || (v.status === 'unknown' ? (v.reason || 'METADATA_INCOMPLETE') : null)
      })),
      routines: routinesResult.items.map((r) => ({
        name: r.name,
        type: r.type,
        status: r.status,
        reason: r.reason || null,
        sql: r.sql
      })),
      triggers: triggersResult.items.map((tr) => ({
        name: tr.name,
        table: tr.table,
        timing: tr.timing,
        event: tr.event,
        statement: tr.statement,
        definer: tr.definer || null,
        sqlMode: tr.sqlMode ?? null,
        characterSetClient: tr.characterSetClient || null,
        collationConnection: tr.collationConnection || null,
        databaseCollation: tr.databaseCollation || null,
        actionOrder: tr.actionOrder ?? null,
        status: tr.status || 'complete',
        reason: tr.reason || null,
        migrationStatus: tr.migrationStatus || (tr.status === 'unknown' ? 'blocked' : 'supported'),
        migrationBlockReason: tr.migrationBlockReason || (tr.status === 'unknown' ? (tr.reason || 'METADATA_INCOMPLETE') : null)
      })),
      events: eventsResult.items.map((ev) => ({
        name: ev.name,
        status: ev.status,
        statement: ev.statement,
        coverageStatus: ev.coverageStatus || (ev.statement ? 'complete' : 'unknown'),
        reason: ev.reason || null
      }))
    };

    const snapshotIdentity = computeSchemaFingerprint(canonicalData);
    const finishedAt = new Date().toISOString();

    return {
      kind: 'sqlpro-schema-snapshot',
      version: 1,
      scope: {
        profileId: context.profileId,
        sessionId: context.sessionId,
        generation: context.generation,
        profileFingerprint: context.profileFingerprint,
        database,
        engine,
        serverVersion
      },
      snapshotIdentity,
      startedAt,
      finishedAt,
      coverage: overallCoverage,
      warnings,
      categories: {
        tables: { coverage: tablesResult.coverage, count: tablesResult.items.length },
        views: { coverage: viewsResult.coverage, count: viewsResult.items.length },
        routines: { coverage: routinesResult.coverage, count: routinesResult.items.length },
        triggers: { coverage: triggersResult.coverage, count: triggersResult.items.length },
        events: { coverage: eventsResult.coverage, count: eventsResult.items.length }
      },
      // Flattened metadata compatible with SchemaDiff:
      database,
      engine,
      tables: canonicalData.tables,
      views: canonicalData.views,
      routines: canonicalData.routines,
      triggers: canonicalData.triggers,
      events: canonicalData.events
    };
  }

  async collectTables(database, warnings, quotas = DEFAULT_QUOTAS, state = { startTime: Date.now(), cumulativeDdlBytes: 0, totalObjects: 0 }) {
    let rawTables = [];
    let coverage = 'complete';

    if (this._checkTimeout('tables', warnings, quotas, state)) {
      return { coverage: 'partial', items: [] };
    }

    try {
      const remainingTimeout = this._getRemainingTimeout(quotas, state);
      rawTables = await this.session.listTables(database, { fresh: true, timeoutMs: remainingTimeout });
    } catch (err) {
      if (this._isTimedOut(quotas, state) || /timeout/i.test(err.message || err.code || '')) {
        state.timedOut = true;
        warnings.push({
          code: 'SNAPSHOT_TIMEOUT',
          category: 'tables',
          message: `Quá thời gian cho phép khi thu thập bảng (${quotas.timeoutMs}ms).`
        });
        return { coverage: 'partial', items: [] };
      }
      warnings.push({
        code: 'TABLES_READ_FAILED',
        category: 'tables',
        message: `Không đọc được danh sách bảng: ${err.message}`
      });
      return { coverage: 'unknown', items: [] };
    }

    if (this._checkTimeout('tables', warnings, quotas, state)) {
      return { coverage: 'partial', items: [] };
    }

    const baseTables = (rawTables || []).filter((t) => t.type !== 'view');
    const fullTables = [];

    for (const t of baseTables) {
      if (this._checkTimeout('tables', warnings, quotas, state)) {
        coverage = 'partial';
        break;
      }

      if (state.totalObjects >= quotas.maxObjects) {
        coverage = 'partial';
        warnings.push({
          code: 'OBJECT_QUOTA_EXCEEDED',
          category: 'tables',
          message: `Số lượng đối tượng vượt quá quota cho phép (${quotas.maxObjects}).`
        });
        break;
      }
      state.totalObjects++;

      try {
        // Explicitly request fresh metadata bypassing session cache:
        let rels = null;
        let relsError = null;

        const tableTimeout = this._getRemainingTimeout(quotas, state);
        const [cols, idxs] = await Promise.all([
          this.session.listColumns(database, t.name, { fresh: true, timeoutMs: tableTimeout }),
          this.session.listIndexes(database, t.name, { fresh: true, includeDefinition: true, timeoutMs: tableTimeout })
        ]);

        if (this._checkTimeout('tables', warnings, quotas, state)) {
          coverage = 'partial';
          break;
        }

        try {
          const relTimeout = this._getRemainingTimeout(quotas, state);
          rels = await this.session.listRelations(database, t.name, { fresh: true, timeoutMs: relTimeout });
        } catch (err) {
          if (this._isTimedOut(quotas, state) || /timeout/i.test(err.message || err.code || '')) {
            state.timedOut = true;
            warnings.push({
              code: 'SNAPSHOT_TIMEOUT',
              category: 'tables',
              message: `Quá thời gian cho phép khi thu thập bảng (${quotas.timeoutMs}ms).`
            });
            coverage = 'partial';
            break;
          }
          relsError = err;
          coverage = 'partial';
          warnings.push({
            code: 'TABLE_RELATIONS_FAILED',
            category: 'tables',
            objectName: t.name,
            message: `Không đọc được khóa ngoại của bảng ${t.name}: ${err.message}`
          });
        }

        if (this._checkTimeout('tables', warnings, quotas, state)) {
          coverage = 'partial';
          break;
        }

        const outbound = rels?.outbound || [];
        const fkMap = new Map();
        for (const r of outbound) {
          if (!fkMap.has(r.name)) {
            const refDb = r.refDatabase || r.referencedDatabase || null;
            const onDelete = r.onDelete !== undefined ? r.onDelete : (r.deleteRule !== undefined ? r.deleteRule : null);
            const onUpdate = r.onUpdate !== undefined ? r.onUpdate : (r.updateRule !== undefined ? r.updateRule : null);

            if (onDelete === null || onUpdate === null) {
              coverage = 'partial';
              warnings.push({
                code: 'FK_ACTION_UNKNOWN',
                category: 'tables',
                objectName: t.name,
                message: `Khóa ngoại ${r.name} trên bảng ${t.name} thiếu thông tin ON DELETE hoặc ON UPDATE.`
              });
            }

            fkMap.set(r.name, {
              name: r.name,
              columns: [],
              referencedDatabase: refDb,
              referencedTable: r.refTable || r.referencedTable || null,
              referencedColumns: [],
              onDelete,
              onUpdate
            });
          }
          const fk = fkMap.get(r.name);
          // API returns r.column (normalized in database.cjs:1371), fallback to r.columnName
          const colName = r.column || r.columnName;
          const refColName = r.refColumn || r.referencedColumn;
          fk.columns.push(colName);
          fk.referencedColumns.push(refColName);
        }

        fullTables.push({
          name: t.name,
          engine: t.engine || 'InnoDB',
          collation: t.collation || null,
          comment: t.comment || '',
          foreignKeysStatus: relsError ? 'unknown' : 'complete',
          columns: (cols || []).map((c) => {
            const extra = c.extra || '';
            const isDefaultGenerated = Boolean(/\bDEFAULT_GENERATED\b/i.test(extra));
            const isGenerated = Boolean(
              (/\b(VIRTUAL|STORED|PERSISTENT)\s+GENERATED\b/i.test(extra)) ||
              (/\b(VIRTUAL|STORED|PERSISTENT)\b/i.test(extra) && !isDefaultGenerated) ||
              (c.generationExpression != null && c.generationExpression !== '')
            );
            const genExpr = c.generationExpression != null && c.generationExpression !== ''
              ? String(c.generationExpression).trim()
              : null;

            if (isGenerated && !genExpr) {
              coverage = 'partial';
              warnings.push({
                code: 'GENERATED_COLUMN_EXPRESSION_MISSING',
                category: 'tables',
                objectName: `${t.name}.${c.name}`,
                message: `Cột generated ${t.name}.${c.name} thiếu biểu thức GENERATION_EXPRESSION.`
              });
            }

            return {
              name: c.name,
              type: c.type,
              nullable: c.nullable,
              default: c.defaultValue ?? c.default ?? null,
              extra,
              comment: c.comment || '',
              collation: c.collation || null,
              isGenerated,
              generationExpression: genExpr,
              isDefaultGenerated
            };
          }),
          indexes: (idxs || []).map((i) => {
            let complete = i.definitionStatus === 'complete';
            const columns = (i.columns || []).map(col => {
              let expression = typeof col.expression === 'string' && col.expression.trim() ? col.expression.trim() : null;
              const name = typeof col === 'string' ? col : col.name;
              if (expression) {
                const bytes = Buffer.byteLength(expression, 'utf8');
                if (state.cumulativeDdlBytes + bytes > quotas.maxDdlBytes) {
                  complete = false;
                  expression = null;
                } else state.cumulativeDdlBytes += bytes;
              }
              if (!name && !expression) complete = false;
              return {
                name: name || null, expression,
                subPart: typeof col === 'object' && col.subPart != null ? Number(col.subPart) : null,
                direction: typeof col === 'object' ? col.direction || null : null
              };
            });
            if (!complete) {
              coverage = 'partial';
              warnings.push({ code: 'INDEX_DEFINITION_UNKNOWN', category: 'tables', objectName: t.name,
                message: `Metadata index ${i.name} chưa đầy đủ hoặc vượt quota.` });
            }
            const specialVisibility = i.visibilityKind === 'mysql-visible' && i.visibility === 'NO'
              || i.visibilityKind === 'mariadb-ignored' && i.visibility === 'YES';
            const blockReason = !complete ? 'METADATA_INCOMPLETE'
              : columns.some(col => col.expression) ? 'UNSUPPORTED_FUNCTIONAL_INDEX'
                : specialVisibility ? 'UNSUPPORTED_INDEX_VISIBILITY' : null;
            return {
              name: i.name, isPrimary: i.name === 'PRIMARY',
              isUnique: Boolean(i.unique !== undefined ? i.unique : Number(i.nonUnique) === 0),
              type: i.type, columns,
              visibilityKind: i.visibilityKind || null, visibility: i.visibility ?? null,
              status: complete ? 'complete' : 'unknown',
              migrationStatus: blockReason ? 'blocked' : 'supported', migrationBlockReason: blockReason
            };
          }),
          foreignKeys: Array.from(fkMap.values()).sort((a, b) => a.name.localeCompare(b.name))
        });
      } catch (err) {
        coverage = 'partial';
        warnings.push({
          code: 'TABLE_METADATA_PARTIAL',
          category: 'tables',
          objectName: t.name,
          message: `Lỗi đọc cấu trúc bảng ${t.name}: ${err.message}`
        });
      }
    }

    fullTables.sort((a, b) => a.name.localeCompare(b.name));
    return { coverage, items: fullTables };
  }

  async collectViews(database, warnings, quotas = DEFAULT_QUOTAS, state = { startTime: Date.now(), cumulativeDdlBytes: 0, totalObjects: 0 }) {
    let rawTables = [];
    if (this._checkTimeout('views', warnings, quotas, state)) {
      return { coverage: 'unknown', items: [] };
    }

    try {
      const remainingTimeout = this._getRemainingTimeout(quotas, state);
      rawTables = await this.session.listTables(database, { fresh: true, timeoutMs: remainingTimeout });
    } catch (err) {
      if (this._isTimedOut(quotas, state) || /timeout/i.test(err.message || err.code || '')) {
        state.timedOut = true;
        warnings.push({
          code: 'SNAPSHOT_TIMEOUT',
          category: 'views',
          message: `Quá thời gian cho phép khi thu thập views (${quotas.timeoutMs}ms).`
        });
        return { coverage: 'partial', items: [] };
      }
      warnings.push({
        code: 'VIEWS_LIST_FAILED',
        category: 'views',
        message: `Không đọc được danh sách views: ${err.message}`
      });
      return { coverage: 'unknown', items: [] };
    }

    if (this._checkTimeout('views', warnings, quotas, state)) {
      return { coverage: 'partial', items: [] };
    }

    const viewEntries = (rawTables || []).filter((t) => t.type === 'view');
    const views = [];
    let coverage = 'complete';

    for (const v of viewEntries) {
      if (this._checkTimeout('views', warnings, quotas, state)) {
        coverage = 'partial';
        break;
      }

      if (state.totalObjects >= quotas.maxObjects) {
        coverage = 'partial';
        warnings.push({
          code: 'OBJECT_QUOTA_EXCEEDED',
          category: 'views',
          message: `Số lượng đối tượng vượt quá quota cho phép (${quotas.maxObjects}).`
        });
        break;
      }
      state.totalObjects++;

      try {
        let ddl = null;
        const queryTimeout = this._getRemainingTimeout(quotas, state);
        if (typeof this.session.showCreate === 'function') {
          const res = await this.session.showCreate(database, v.name, 'view', { timeoutMs: queryTimeout });
          ddl = res.sql;
        } else if (typeof this.session.raw === 'function') {
          const { result } = await this.session.raw(`SHOW CREATE VIEW \`${database}\`.\`${v.name}\``, [], queryTimeout);
          const row = result && result[0];
          const key = row && Object.keys(row).find((k) => /^Create /i.test(k));
          ddl = key ? String(row[key]) : null;
        }

        if (this._checkTimeout('views', warnings, quotas, state)) {
          coverage = 'partial';
          break;
        }

        if (ddl) {
          const ddlBytes = Buffer.byteLength(ddl, 'utf8');
          if (state.cumulativeDdlBytes + ddlBytes > quotas.maxDdlBytes) {
            coverage = 'partial';
            warnings.push({
              code: 'BYTE_QUOTA_EXCEEDED',
              category: 'views',
              objectName: v.name,
              message: `Vượt quá giới hạn dung lượng DDL (${quotas.maxDdlBytes} bytes).`
            });
            views.push({
              name: v.name,
              status: 'unknown',
              reason: 'BYTE_QUOTA_EXCEEDED',
              algorithm: null,
              definer: null,
              security: null,
              checkOption: null,
              definition: null,
              ddl: null,
              migrationStatus: 'blocked',
              migrationBlockReason: 'BYTE_QUOTA_EXCEEDED'
            });
            continue;
          }
          state.cumulativeDdlBytes += ddlBytes;

          const parsed = parseViewDdl(ddl);
          if (parsed.syntaxError) {
            coverage = 'partial';
            warnings.push({
              code: 'VIEW_SYNTAX_UNRECOGNIZED',
              category: 'views',
              objectName: v.name,
              message: `Cú pháp DDL của view ${v.name} không nhận dạng được.`
            });
            views.push({
              name: v.name,
              status: 'unknown',
              reason: 'UNRECOGNIZED_VIEW_SYNTAX',
              algorithm: null,
              definer: null,
              security: null,
              checkOption: null,
              definition: null,
              ddl: ddl.trim(),
              migrationStatus: 'blocked',
              migrationBlockReason: 'UNRECOGNIZED_VIEW_SYNTAX'
            });
            continue;
          }

          views.push({
            name: v.name,
            status: 'complete',
            algorithm: v.algorithm || parsed.algorithm || null,
            definer: v.definer || parsed.definer || null,
            security: v.security || parsed.security || null,
            checkOption: v.checkOption || parsed.checkOption || null,
            definition: v.definition || parsed.definition || ddl.trim(),
            ddl: v.ddl || parsed.ddl || ddl.trim(),
            migrationStatus: 'supported',
            migrationBlockReason: null
          });
        } else if (v.definition) {
          views.push({
            name: v.name,
            status: 'complete',
            algorithm: v.algorithm || null,
            definer: v.definer || null,
            security: v.security || null,
            checkOption: v.checkOption || null,
            definition: v.definition.trim(),
            ddl: v.ddl || null,
            migrationStatus: 'supported',
            migrationBlockReason: null
          });
        } else {
          coverage = 'partial';
          warnings.push({
            code: 'VIEW_DDL_EMPTY',
            category: 'views',
            objectName: v.name,
            message: `Không đọc được nội dung DDL của view ${v.name}`
          });
          views.push({
            name: v.name,
            status: 'unknown',
            reason: 'EMPTY_DEFINITION',
            algorithm: null,
            definer: null,
            security: null,
            checkOption: null,
            definition: null,
            ddl: null,
            migrationStatus: 'blocked',
            migrationBlockReason: 'METADATA_INCOMPLETE'
          });
        }
      } catch (err) {
        coverage = 'partial';
        warnings.push({
          code: 'VIEW_ACCESS_DENIED',
          category: 'views',
          objectName: v.name,
          message: `Không có quyền đọc DDL của view ${v.name}: ${err.message}`
        });
        views.push({
          name: v.name,
          status: 'unknown',
          reason: 'ACCESS_DENIED',
          algorithm: null,
          definer: null,
          security: null,
          checkOption: null,
          definition: null,
          ddl: null,
          migrationStatus: 'blocked',
          migrationBlockReason: 'ACCESS_DENIED'
        });
      }
    }

    if (views.some((v) => v.status === 'unknown')) {
      coverage = 'partial';
    }

    views.sort((a, b) => a.name.localeCompare(b.name));
    return { coverage, items: views };
  }

  async collectRoutines(database, warnings, quotas = DEFAULT_QUOTAS, state = { startTime: Date.now(), cumulativeDdlBytes: 0, totalObjects: 0 }) {
    let list = [];
    let coverage = 'complete';

    if (this._checkTimeout('routines', warnings, quotas, state)) {
      return { coverage: 'unknown', items: [] };
    }

    try {
      const remainingTimeout = this._getRemainingTimeout(quotas, state);
      if (typeof this.session.listRoutines === 'function') {
        list = await this.session.listRoutines(database, { timeoutMs: remainingTimeout });
      } else if (typeof this.session.raw === 'function') {
        const { result } = await this.session.raw(
          `SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type
             FROM information_schema.ROUTINES
            WHERE ROUTINE_SCHEMA = ?
            ORDER BY ROUTINE_TYPE, ROUTINE_NAME`,
          [database],
          remainingTimeout,
          { prepared: true }
        );
        list = result || [];
      }
    } catch (err) {
      if (this._isTimedOut(quotas, state) || /timeout/i.test(err.message || err.code || '')) {
        state.timedOut = true;
        warnings.push({
          code: 'SNAPSHOT_TIMEOUT',
          category: 'routines',
          message: `Quá thời gian cho phép khi thu thập routines (${quotas.timeoutMs}ms).`
        });
        return { coverage: 'partial', items: [] };
      }
      warnings.push({
        code: 'ROUTINES_LIST_FAILED',
        category: 'routines',
        message: `Không thể đọc danh sách routines: ${err.message}`
      });
      return { coverage: 'unknown', items: [] };
    }

    if (this._checkTimeout('routines', warnings, quotas, state)) {
      return { coverage: 'partial', items: [] };
    }

    const routines = [];
    for (const r of list || []) {
      if (this._checkTimeout('routines', warnings, quotas, state)) {
        coverage = 'partial';
        break;
      }

      if (state.totalObjects >= quotas.maxObjects) {
        coverage = 'partial';
        warnings.push({
          code: 'OBJECT_QUOTA_EXCEEDED',
          category: 'routines',
          message: `Số lượng đối tượng vượt quá quota cho phép (${quotas.maxObjects}).`
        });
        break;
      }
      state.totalObjects++;

      const type = String(r.type || 'procedure').toLowerCase();
      try {
        let sql = null;
        const queryTimeout = this._getRemainingTimeout(quotas, state);
        if (typeof this.session.showCreate === 'function') {
          const res = await this.session.showCreate(database, r.name, type, { timeoutMs: queryTimeout });
          sql = res.sql;
        } else if (typeof this.session.raw === 'function') {
          const { result } = await this.session.raw(`SHOW CREATE ${type.toUpperCase()} \`${database}\`.\`${r.name}\``, [], queryTimeout);
          const row = result && result[0];
          const key = row && Object.keys(row).find((k) => /^Create /i.test(k));
          sql = key ? String(row[key]) : null;
        }

        if (this._checkTimeout('routines', warnings, quotas, state)) {
          coverage = 'partial';
          break;
        }

        if (sql) {
          const ddlBytes = Buffer.byteLength(sql, 'utf8');
          if (state.cumulativeDdlBytes + ddlBytes > quotas.maxDdlBytes) {
            coverage = 'partial';
            warnings.push({
              code: 'BYTE_QUOTA_EXCEEDED',
              category: 'routines',
              objectName: r.name,
              message: `Vượt quá giới hạn dung lượng DDL (${quotas.maxDdlBytes} bytes).`
            });
            routines.push({
              name: r.name,
              type,
              status: 'unknown',
              reason: 'BYTE_QUOTA_EXCEEDED',
              sql: null
            });
            continue;
          }
          state.cumulativeDdlBytes += ddlBytes;

          routines.push({
            name: r.name,
            type,
            status: 'complete',
            sql: sql.trim()
          });
        } else {
          coverage = 'partial';
          warnings.push({
            code: 'ROUTINE_SQL_EMPTY',
            category: 'routines',
            objectName: r.name,
            message: `Không đọc được SQL của routine ${r.name}`
          });
          routines.push({
            name: r.name,
            type,
            status: 'unknown',
            reason: 'EMPTY_DEFINITION',
            sql: null
          });
        }
      } catch (err) {
        if (this._isTimedOut(quotas, state) || /timeout/i.test(err.message || err.code || '')) {
          state.timedOut = true;
          warnings.push({
            code: 'SNAPSHOT_TIMEOUT',
            category: 'routines',
            message: `Quá thời gian cho phép khi thu thập routines (${quotas.timeoutMs}ms).`
          });
          coverage = 'partial';
          break;
        }
        coverage = 'partial';
        warnings.push({
          code: 'ROUTINE_ACCESS_DENIED',
          category: 'routines',
          objectName: r.name,
          message: `Không có quyền đọc DDL routine ${r.name}: ${err.message}`
        });
        routines.push({
          name: r.name,
          type,
          status: 'unknown',
          reason: 'ACCESS_DENIED',
          sql: null
        });
      }
    }

    if (routines.some((r) => r.status === 'unknown')) {
      coverage = 'partial';
    }

    routines.sort((a, b) => a.name.localeCompare(b.name));
    return { coverage, items: routines };
  }

  async collectTriggers(database, warnings, quotas = DEFAULT_QUOTAS, state = { startTime: Date.now(), cumulativeDdlBytes: 0, totalObjects: 0 }) {
    let triggers = [];
    let coverage = 'complete';

    if (this._checkTimeout('triggers', warnings, quotas, state)) {
      return { coverage: 'unknown', items: [] };
    }

    try {
      if (typeof this.session.raw === 'function') {
        const remainingTimeout = this._getRemainingTimeout(quotas, state);
        const { result } = await this.session.raw(
          `SELECT TRIGGER_NAME AS name, ACTION_TIMING AS timing, EVENT_MANIPULATION AS event,
                  EVENT_OBJECT_TABLE AS \`table\`, ACTION_STATEMENT AS statement,
                  DEFINER AS definer, SQL_MODE AS sqlMode, ACTION_ORDER AS actionOrder,
                  CHARACTER_SET_CLIENT AS characterSetClient,
                  COLLATION_CONNECTION AS collationConnection, DATABASE_COLLATION AS databaseCollation
             FROM information_schema.TRIGGERS
            WHERE TRIGGER_SCHEMA = ?
            ORDER BY EVENT_OBJECT_TABLE, TRIGGER_NAME`,
          [database],
          remainingTimeout,
          { prepared: true }
        );

        if (this._checkTimeout('triggers', warnings, quotas, state)) {
          return { coverage: 'partial', items: [] };
        }

        for (const row of result || []) {
          if (this._checkTimeout('triggers', warnings, quotas, state)) {
            coverage = 'partial';
            break;
          }

          if (state.totalObjects >= quotas.maxObjects) {
            coverage = 'partial';
            warnings.push({
              code: 'OBJECT_QUOTA_EXCEEDED',
              category: 'triggers',
              message: `Số lượng đối tượng vượt quá quota cho phép (${quotas.maxObjects}).`
            });
            break;
          }
          state.totalObjects++;

          const stmt = String(row.statement || '').trim();
          if (!stmt) {
            coverage = 'partial';
            warnings.push({
              code: 'TRIGGER_STATEMENT_EMPTY',
              category: 'triggers',
              objectName: row.name,
              message: `Không đọc được nội dung câu lệnh của trigger ${row.name}`
            });
            triggers.push({
              name: row.name,
              table: row.table,
              timing: String(row.timing || 'AFTER').toUpperCase(),
              event: String(row.event || 'INSERT').toUpperCase(),
              statement: null,
              status: 'unknown',
              reason: 'EMPTY_DEFINITION',
              migrationStatus: 'blocked',
              migrationBlockReason: 'METADATA_INCOMPLETE'
            });
            continue;
          }

          const context = {
            definer: row.definer, sqlMode: row.sqlMode,
            characterSetClient: row.characterSetClient, collationConnection: row.collationConnection,
            databaseCollation: row.databaseCollation, actionOrder: Number(row.actionOrder)
          };
          const contextKnown = ['definer', 'characterSetClient', 'collationConnection', 'databaseCollation']
            .every(key => typeof context[key] === 'string' && context[key].length > 0)
            && typeof context.sqlMode === 'string' && Number.isSafeInteger(context.actionOrder) && context.actionOrder > 0;
          const stmtBytes = Buffer.byteLength(stmt, 'utf8') + Buffer.byteLength(JSON.stringify(context), 'utf8');
          if (state.cumulativeDdlBytes + stmtBytes > quotas.maxDdlBytes) {
            coverage = 'partial';
            warnings.push({
              code: 'BYTE_QUOTA_EXCEEDED',
              category: 'triggers',
              objectName: row.name,
              message: `Vượt quá giới hạn dung lượng DDL (${quotas.maxDdlBytes} bytes).`
            });
            triggers.push({
              name: row.name,
              table: row.table,
              timing: String(row.timing || 'AFTER').toUpperCase(),
              event: String(row.event || 'INSERT').toUpperCase(),
              statement: null,
              status: 'unknown',
              reason: 'BYTE_QUOTA_EXCEEDED',
              migrationStatus: 'blocked',
              migrationBlockReason: 'BYTE_QUOTA_EXCEEDED'
            });
            continue;
          }

          state.cumulativeDdlBytes += stmtBytes;
          if (!contextKnown) {
            coverage = 'partial';
            warnings.push({ code: 'TRIGGER_CONTEXT_UNKNOWN', category: 'triggers', objectName: row.name,
              message: `Không đọc đầy đủ quyền thực thi hoặc ngữ cảnh SQL của trigger ${row.name}.` });
          }
          triggers.push({
            name: row.name,
            table: row.table,
            timing: String(row.timing || 'AFTER').toUpperCase(),
            event: String(row.event || 'INSERT').toUpperCase(),
            statement: stmt,
            ...context,
            status: contextKnown ? 'complete' : 'unknown',
            reason: contextKnown ? null : 'TRIGGER_CONTEXT_UNKNOWN',
            // Capturing a DEFINER is evidence, not permission to replay its privileges.
            migrationStatus: 'blocked',
            migrationBlockReason: contextKnown ? 'TRIGGER_CONTEXT_REVIEW_REQUIRED' : 'METADATA_INCOMPLETE'
          });
        }
      }
    } catch (err) {
      if (this._isTimedOut(quotas, state) || /timeout/i.test(err.message || err.code || '')) {
        state.timedOut = true;
        warnings.push({
          code: 'SNAPSHOT_TIMEOUT',
          category: 'triggers',
          message: `Quá thời gian cho phép khi thu thập triggers (${quotas.timeoutMs}ms).`
        });
        return { coverage: 'partial', items: [] };
      }
      coverage = 'unknown';
      warnings.push({
        code: 'TRIGGERS_READ_FAILED',
        category: 'triggers',
        message: `Không đọc được triggers của database ${database}: ${err.message}`
      });
      return { coverage: 'unknown', items: [] };
    }

    if (triggers.some((tr) => tr.status === 'unknown')) {
      coverage = 'partial';
    }

    triggers.sort((a, b) => a.name.localeCompare(b.name));
    return { coverage, items: triggers };
  }

  async collectEvents(database, warnings, quotas = DEFAULT_QUOTAS, state = { startTime: Date.now(), cumulativeDdlBytes: 0, totalObjects: 0 }) {
    let events = [];
    let coverage = 'complete';

    if (this._checkTimeout('events', warnings, quotas, state)) {
      return { coverage: 'unknown', items: [] };
    }

    try {
      let rawEvents = [];
      const remainingTimeout = this._getRemainingTimeout(quotas, state);
      if (typeof this.session.listEvents === 'function') {
        rawEvents = await this.session.listEvents(database, { timeoutMs: remainingTimeout });
      } else if (typeof this.session.raw === 'function') {
        const { result } = await this.session.raw(
          `SELECT EVENT_NAME AS name, STATUS AS status
             FROM information_schema.EVENTS
            WHERE EVENT_SCHEMA = ?
            ORDER BY EVENT_NAME`,
          [database],
          remainingTimeout,
          { prepared: true }
        );
        rawEvents = result || [];
      }

      if (this._checkTimeout('events', warnings, quotas, state)) {
        return { coverage: 'partial', items: [] };
      }

      for (const ev of rawEvents || []) {
        if (this._checkTimeout('events', warnings, quotas, state)) {
          coverage = 'partial';
          break;
        }

        if (state.totalObjects >= quotas.maxObjects) {
          coverage = 'partial';
          warnings.push({
            code: 'OBJECT_QUOTA_EXCEEDED',
            category: 'events',
            message: `Số lượng đối tượng vượt quá quota cho phép (${quotas.maxObjects}).`
          });
          break;
        }
        state.totalObjects++;

        try {
          let sql = null;
          const queryTimeout = this._getRemainingTimeout(quotas, state);
          if (typeof this.session.showCreate === 'function') {
            const res = await this.session.showCreate(database, ev.name, 'event', { timeoutMs: queryTimeout });
            sql = res.sql;
          } else if (typeof this.session.raw === 'function') {
            const { result } = await this.session.raw(`SHOW CREATE EVENT \`${database}\`.\`${ev.name}\``, [], queryTimeout);
            const row = result && result[0];
            const key = row && Object.keys(row).find((k) => /^Create /i.test(k));
            sql = key ? String(row[key]) : null;
          }

          if (this._checkTimeout('events', warnings, quotas, state)) {
            coverage = 'partial';
            break;
          }

          if (sql) {
            const ddlBytes = Buffer.byteLength(sql, 'utf8');
            if (state.cumulativeDdlBytes + ddlBytes > quotas.maxDdlBytes) {
              coverage = 'partial';
              warnings.push({
                code: 'BYTE_QUOTA_EXCEEDED',
                category: 'events',
                objectName: ev.name,
                message: `Vượt quá giới hạn dung lượng DDL (${quotas.maxDdlBytes} bytes).`
              });
              events.push({
                name: ev.name,
                status: ev.status || 'ENABLED',
                statement: null,
                coverageStatus: 'unknown',
                reason: 'BYTE_QUOTA_EXCEEDED'
              });
              continue;
            }
            state.cumulativeDdlBytes += ddlBytes;

            events.push({
              name: ev.name,
              status: ev.status || 'ENABLED',
              statement: sql.trim(),
              coverageStatus: 'complete'
            });
          } else {
            coverage = 'partial';
            warnings.push({
              code: 'EVENT_DDL_EMPTY',
              category: 'events',
              objectName: ev.name,
              message: `Không đọc được DDL của event ${ev.name}`
            });
            events.push({
              name: ev.name,
              status: ev.status || 'ENABLED',
              statement: null,
              coverageStatus: 'unknown',
              reason: 'EMPTY_DEFINITION'
            });
          }
        } catch (err) {
          if (this._isTimedOut(quotas, state) || /timeout/i.test(err.message || err.code || '')) {
            state.timedOut = true;
            warnings.push({
              code: 'SNAPSHOT_TIMEOUT',
              category: 'events',
              message: `Quá thời gian cho phép khi thu thập events (${quotas.timeoutMs}ms).`
            });
            coverage = 'partial';
            break;
          }
          coverage = 'partial';
          warnings.push({
            code: 'EVENT_ACCESS_DENIED',
            category: 'events',
            objectName: ev.name,
            message: `Không đọc được DDL của event ${ev.name}: ${err.message}`
          });
          events.push({
            name: ev.name,
            status: ev.status || 'ENABLED',
            statement: null,
            coverageStatus: 'unknown',
            reason: 'ACCESS_DENIED'
          });
        }
      }
    } catch (err) {
      if (this._isTimedOut(quotas, state) || /timeout/i.test(err.message || err.code || '')) {
        state.timedOut = true;
        warnings.push({
          code: 'SNAPSHOT_TIMEOUT',
          category: 'events',
          message: `Quá thời gian cho phép khi thu thập events (${quotas.timeoutMs}ms).`
        });
        return { coverage: 'partial', items: [] };
      }
      coverage = 'unknown';
      warnings.push({
        code: 'EVENTS_READ_FAILED',
        category: 'events',
        message: `Không đọc được events của database ${database}: ${err.message}`
      });
      return { coverage: 'unknown', items: [] };
    }

    if (events.some((ev) => ev.coverageStatus === 'unknown')) {
      coverage = 'partial';
    }

    events.sort((a, b) => a.name.localeCompare(b.name));
    return { coverage, items: events };
  }
}

function projectSnapshotForRenderer(snapshot, options = {}) {
  if (!snapshot) return null;
  const limits = Object.assign({}, DEFAULT_PROJECTION_LIMITS, options.limits || {});

  const tables = snapshot.tables || [];
  const views = snapshot.views || [];
  const routines = snapshot.routines || [];
  const triggers = snapshot.triggers || [];
  const events = snapshot.events || [];
  const warnings = snapshot.warnings || [];

  const projectedTables = tables.slice(0, limits.maxTables).map((t) => ({
    name: t.name,
    engine: t.engine,
    collation: t.collation || null,
    foreignKeysStatus: t.foreignKeysStatus || 'complete',
    columnCount: t.columns ? t.columns.length : 0,
    indexCount: t.indexes ? t.indexes.length : 0,
    blockedIndexCount: (t.indexes || []).filter(index => index.migrationStatus === 'blocked').length,
    foreignKeyCount: t.foreignKeys ? t.foreignKeys.length : 0
  }));

  const projectedViews = views.slice(0, limits.maxViews).map((v) => ({
    name: v.name,
    status: v.status,
    algorithm: v.algorithm || null,
    security: v.security || null,
    migrationStatus: v.migrationStatus || 'supported'
  }));

  const projectedRoutines = routines.slice(0, limits.maxRoutines).map((r) => ({
    name: r.name,
    type: r.type,
    status: r.status
  }));

  const projectedTriggers = triggers.slice(0, limits.maxTriggers).map((tr) => ({
    name: tr.name,
    table: tr.table,
    event: tr.event,
    status: tr.status || 'complete',
    migrationStatus: tr.migrationStatus || 'supported'
  }));

  const projectedEvents = events.slice(0, limits.maxEvents).map((ev) => ({
    name: ev.name,
    status: ev.status,
    coverageStatus: ev.coverageStatus
  }));

  const projectedWarnings = warnings.slice(0, limits.maxWarnings);

  return {
    kind: 'sqlpro-schema-snapshot-projection',
    scope: snapshot.scope,
    snapshotIdentity: snapshot.snapshotIdentity,
    createdAt: snapshot.finishedAt,
    coverage: snapshot.coverage,
    summary: {
      tableCount: snapshot.categories ? snapshot.categories.tables.count : tables.length,
      viewCount: snapshot.categories ? snapshot.categories.views.count : views.length,
      routineCount: snapshot.categories ? snapshot.categories.routines.count : routines.length,
      triggerCount: snapshot.categories ? snapshot.categories.triggers.count : triggers.length,
      eventCount: snapshot.categories ? snapshot.categories.events.count : events.length,
      warningCount: warnings.length
    },
    tables: projectedTables,
    tablesTruncated: tables.length > limits.maxTables,
    totalTables: tables.length,
    views: projectedViews,
    viewsTruncated: views.length > limits.maxViews,
    totalViews: views.length,
    routines: projectedRoutines,
    routinesTruncated: routines.length > limits.maxRoutines,
    totalRoutines: routines.length,
    triggers: projectedTriggers,
    triggersTruncated: triggers.length > limits.maxTriggers,
    totalTriggers: triggers.length,
    events: projectedEvents,
    eventsTruncated: events.length > limits.maxEvents,
    totalEvents: events.length,
    warnings: projectedWarnings,
    warningsTruncated: warnings.length > limits.maxWarnings,
    totalWarnings: warnings.length
  };
}

module.exports = {
  SchemaSnapshotCollector,
  detectEngine,
  splitViewDdl,
  parseViewDdl,
  tokenizeHeader,
  parseHeaderAttributes,
  computeSchemaFingerprint,
  projectSnapshotForRenderer,
  DEFAULT_QUOTAS,
  DEFAULT_PROJECTION_LIMITS
};
