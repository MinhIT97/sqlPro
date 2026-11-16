'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SqlQueryResults = api;
}(typeof globalThis === 'object' ? globalThis : this, () => {
  const compareText = new Intl.Collator(undefined, { numeric: true }).compare;
  function orderedRows(rows, column, direction = 'ASC') {
    const indexed = rows.map((row, origIndex) => ({ row, origIndex }));
    if (!Number.isInteger(column) || column < 0) return indexed;
    const sign = direction === 'DESC' ? -1 : 1;
    return indexed.sort((a, b) => {
      const left = a.row[column], right = b.row[column];
      if (left == null) return right == null ? 0 : -sign;
      if (right == null) return sign;
      if (typeof left === 'number' && typeof right === 'number') return (left - right) * sign;
      return compareText(String(left), String(right)) * sign;
    });
  }
  const accessDescriptions = Object.freeze({
    ALL: ['warn', 'Quét toàn bộ bảng; có thể phù hợp với bảng nhỏ hoặc khi cần phần lớn dữ liệu.'],
    INDEX: ['warn', 'Quét toàn bộ chỉ mục; vẫn cần xét số dòng và chi phí đọc.'],
    RANGE: ['info', 'Đọc một hoặc nhiều khoảng chỉ mục; chưa chứng minh thời gian chạy.'],
    CONST: ['info', 'Tra cứu tối đa một dòng bằng khóa; đánh giá cùng các bước còn lại.'],
    EQ_REF: ['info', 'Tra cứu khóa duy nhất cho mỗi tổ hợp dòng trước đó; chi phí còn phụ thuộc số lần lặp.'],
    REF: ['info', 'Tra cứu theo chỉ mục không duy nhất; có thể khớp nhiều dòng mỗi lần.']
  });
  function explainAccess(value) {
    if (typeof value !== 'string' || value.length > 64) return null;
    const description = Object.hasOwn(accessDescriptions, value.toUpperCase()) ? accessDescriptions[value.toUpperCase()] : null;
    return description ? { tone: description[0], description: description[1] } : null;
  }

  // Read only traditional EXPLAIN columns. Never inspect SQL, run another query,
  // add estimates across join steps or infer performance from one access method.
  function reviewExplain(result) {
    if (result?.isExplain !== true || result.kind !== 'rows' || !Array.isArray(result.columns)
        || result.columns.length > 64 || !Array.isArray(result.rows)) return null;
    const columns = new Map();
    for (let index = 0; index < result.columns.length; index += 1) {
      const name = result.columns[index]?.name;
      if (typeof name !== 'string' || name.length > 64 || columns.has(name.toLowerCase())) return null;
      columns.set(name.toLowerCase(), index);
    }
    if (!columns.has('table') || !columns.has('type') || !['rows', 'extra'].some(name => columns.has(name))) return null;
    const text = (value, maximum = 256) => typeof value === 'string' && value.length <= maximum ? value : null;
    const estimate = (value, percentage = false) => {
      if (typeof value !== 'number' && !(typeof value === 'string' && value.length <= 32
          && (percentage ? /^\d+(?:\.\d+)?$/ : /^\d+$/).test(value) && !/[\r\n]/.test(value))) return null;
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 && (percentage ? number <= 100 : Number.isSafeInteger(number)) ? number : null;
    };
    const rows = result.rows.slice(0, 200).map((row, index) => {
      const read = name => Array.isArray(row) && columns.has(name) ? row[columns.get(name)] : undefined;
      const access = text(read('type'), 64), extra = text(read('extra'), 4096), signals = [];
      if (access?.toUpperCase() === 'ALL') signals.push('FULL_TABLE_SCAN');
      if (access?.toUpperCase() === 'INDEX') signals.push('FULL_INDEX_SCAN');
      if (extra && /\bUsing filesort\b/i.test(extra)) signals.push('FILESORT');
      if (extra && /\bUsing temporary\b/i.test(extra)) signals.push('TEMPORARY_TABLE');
      return { number: index + 1, table: text(read('table')), access, key: text(read('key')),
        estimatedRows: estimate(read('rows')), filteredPercent: estimate(read('filtered'), true), signals };
    });
    return { version: 1, rows, truncated: result.rows.length > rows.length || result.truncated === true };
  }
  function explainFormat(value) {
    return ['JSON', 'TREE'].includes(value) ? value : 'DEFAULT';
  }
  const explainSettingNames = Object.freeze(['server_version', 'database', 'sql_mode', 'optimizer_switch', 'time_zone',
    'character_set_client', 'character_set_connection', 'character_set_results', 'collation_connection', 'autocommit', 'sql_select_limit']);
  function explainSettings(value) {
    const unknown = { version: 1, status: 'unknown', reason: 'invalid' };
    if (value?.version !== 1) return unknown;
    if (value.status === 'unknown' && ['unsupported-sql', 'unavailable', 'invalid', 'canceled', 'timeout', 'context-changed'].includes(value.reason)) {
      return { version: 1, status: 'unknown', reason: value.reason };
    }
    if (value.status === 'changed-during-run' && Array.isArray(value.changedFields) && value.changedFields.length > 0
        && value.changedFields.length <= explainSettingNames.length && new Set(value.changedFields).size === value.changedFields.length
        && value.changedFields.every(name => explainSettingNames.includes(name))) {
      return { version: 1, status: value.status, changedFields: [...value.changedFields] };
    }
    if (value.status !== 'observed' || !Array.isArray(value.fields) || value.fields.length !== explainSettingNames.length
        || value.fields.some((field, index) => field?.name !== explainSettingNames[index]
          || typeof field.digest !== 'string' || field.digest.length !== 64 || !/^[a-f0-9]{64}$/.test(field.digest))) return unknown;
    return { version: 1, status: 'observed', fields: value.fields.map(field => ({ name: field.name, digest: field.digest })) };
  }
  function explainSchema(value) {
    const unknown = { version: 1, status: 'unknown', reason: 'invalid' };
    if (value?.version !== 1) return unknown;
    if (value.status === 'unknown' && ['unsupported-sql', 'unavailable', 'invalid', 'canceled', 'timeout', 'context-changed'].includes(value.reason)) {
      return { version: 1, status: 'unknown', reason: value.reason };
    }
    const name = text => typeof text === 'string' && text.length > 0 && text.length <= 64 && !text.includes('\0');
    if (!['observed', 'changed-during-run'].includes(value.status) || !name(value.database) || !name(value.table)) return unknown;
    const identity = { version: 1, status: value.status, database: value.database, table: value.table };
    if (value.status === 'changed-during-run') return identity;
    if (typeof value.digest !== 'string' || value.digest.length !== 64 || !/^[a-f0-9]{64}$/.test(value.digest)) return unknown;
    return { ...identity, digest: value.digest };
  }

  // Indent JSON tokens without reserializing numbers or object members. Parsing
  // validates syntax only: no schema equivalence or cross-engine normalization.
  function explainDocument(result) {
    if (result?.isExplain !== true || result.kind !== 'rows' || !Array.isArray(result.columns) || result.columns.length !== 1
        || typeof result.columns[0]?.name !== 'string' || !['EXPLAIN', ...(result.isAnalyze === true ? ['ANALYZE'] : [])].includes(result.columns[0].name.toUpperCase())
        || !Array.isArray(result.rows) || result.rows.length !== 1 || !Array.isArray(result.rows[0])
        || result.rows[0].length !== 1 || typeof result.rows[0][0] !== 'string') return null;
    const original = result.rows[0][0], maximum = 262144, raw = original.slice(0, maximum);
    const trimmed = raw.trimStart(), json = /^(?:\{|\[)/.test(trimmed), tree = /^->/.test(trimmed);
    const format = json ? 'JSON' : tree || result.explainFormat === 'TREE' ? 'TREE' : 'TEXT';
    const truncated = original.length > maximum || result.truncated === true;
    const response = (text, status) => ({ version: 1, format, text, status, truncated: truncated || status === 'limit' });
    if (truncated) return response(raw, 'limit');
    if (!json) return response(raw, result.explainFormat === 'JSON' ? 'invalid-json' : 'raw');
    let depth = 0, quoted = false, escaped = false;
    for (const character of raw) {
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === '{' || character === '[') { depth += 1; if (depth > 64) return response(raw, 'limit'); }
      else if (character === '}' || character === ']') depth -= 1;
    }
    try { JSON.parse(raw); } catch { return response(raw, 'invalid-json'); }
    const tokens = raw.match(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\],:]/g) || [];
    if (tokens.length > 10000) return response(raw, 'limit');
    const output = []; let length = 0;
    const append = text => { output.push(text); length += text.length; };
    const newline = () => append('\n' + '  '.repeat(depth));
    depth = 0;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token === '{' || token === '[') { append(token); depth += 1; if (!['}', ']'].includes(tokens[index + 1])) newline(); }
      else if (token === '}' || token === ']') { depth -= 1; if (!['{', '['].includes(tokens[index - 1])) newline(); append(token); }
      else if (token === ',') { append(token); newline(); }
      else if (token === ':') append(': ');
      else append(token);
      if (length > 524288) return response(raw, 'limit');
    }
    return response(output.join(''), 'formatted');
  }
  function captureExplain(result, request) {
    const context = result?.explainContext;
    const settings = request?.explainSettings === true ? explainSettings(context?.settings) : null;
    const schema = request?.explainSchema === true ? explainSchema(context?.schema) : null;
    if (settings && settings.status !== 'observed') return null;
    if (schema && schema.status !== 'observed') return null;
    const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !value.includes('\0');
    if (result?.isAnalyze === true || context?.version !== 1 || !identifier(context.profileId) || context.profileId !== request?.profileId
        || !identifier(context.sessionId) || !identifier(context.taskId) || context.taskId !== request?.taskId
        || context.database !== null && (typeof context.database !== 'string' || !context.database || context.database.length > 64 || context.database.includes('\0'))
        || request.database !== null && request.database !== context.database
        || typeof context.sqlHash !== 'string' || context.sqlHash.length !== 64 || !/^[a-f0-9]{64}$/.test(context.sqlHash)
        || typeof context.checkedAt !== 'string' || context.checkedAt.length > 32 || !Number.isFinite(Date.parse(context.checkedAt))
        || result?.isExplain !== true || result.kind !== 'rows' || result.truncated === true) return null;
    const document = explainDocument(result), review = document ? null : reviewExplain(result);
    if (document && (document.truncated || !['JSON', 'TREE'].includes(document.format)
        || document.format === 'JSON' && document.status !== 'formatted') || !document && (!review || review.truncated)) return null;
    if (result.rows.length > 200 || !Array.isArray(result.columns) || result.columns.length > 64) return null;
    const names = result.columns.map(column => column.name);
    if (names.some(name => typeof name !== 'string' || name.length > 64)) return null;
    let budget = 262144;
    for (const row of result.rows) {
      if (!Array.isArray(row) || row.length !== names.length) return null;
      for (const value of row) {
        if (value !== null && typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) return null;
        budget -= typeof value === 'string' ? value.length : 32;
        if (budget < 0) return null;
      }
    }
    const evidence = JSON.stringify([names, result.rows]);
    if (evidence.length > 262144) return null;
    const extraIndex = names.findIndex(name => name.toLowerCase() === 'extra');
    const rows = review ? review.rows.map(({ number, table, access, key, estimatedRows, filteredPercent }, index) => {
      const value = result.rows[index][extraIndex];
      return Object.freeze({ number, table, access, key, estimatedRows, filteredPercent,
        extra: typeof value === 'string' ? value.slice(0, 4096) : null });
    }) : [];
    return Object.freeze({ version: 1, scope: JSON.stringify([context.profileId, context.sessionId, context.database,
      context.sqlHash, explainFormat(request.explainFormat), Boolean(settings), Boolean(schema)]), checkedAt: context.checkedAt,
      settings: settings ? Object.freeze(settings.fields.map(field => Object.freeze(field))) : null,
      schema: schema ? Object.freeze(schema) : null,
      format: document?.format || 'TRADITIONAL', evidence, text: document?.text || null, rows: Object.freeze(rows) });
  }

  function compareExplain(previous, current) {
    const valid = value => value?.version === 1 && typeof value.scope === 'string' && value.scope.length <= 1024
      && typeof value.checkedAt === 'string' && Number.isFinite(Date.parse(value.checkedAt))
      && ['TRADITIONAL', 'JSON', 'TREE'].includes(value.format) && typeof value.evidence === 'string' && value.evidence.length <= 262144
      && Array.isArray(value.rows) && value.rows.length <= 200 && value.rows.every(row => row && typeof row === 'object')
      && (value.settings == null || explainSettings({ version: 1, status: 'observed', fields: value.settings }).status === 'observed')
      && (value.schema == null || explainSchema(value.schema).status === 'observed')
      && (value.text === null || typeof value.text === 'string' && value.text.length <= 524288);
    if (!valid(current) || previous && !valid(previous)) return { version: 1, status: 'unknown' };
    if (!previous) return { version: 1, status: 'baseline', currentAt: current.checkedAt };
    if (previous.version !== current.version || previous.scope !== current.scope || previous.format !== current.format) {
      return { version: 1, status: 'different-scope', currentAt: current.checkedAt };
    }
    if (Boolean(previous.settings) !== Boolean(current.settings)) return { version: 1, status: 'unknown' };
    if (Boolean(previous.schema) !== Boolean(current.schema)) return { version: 1, status: 'unknown' };
    if (current.schema && (previous.schema.database !== current.schema.database || previous.schema.table !== current.schema.table)) {
      return { version: 1, status: 'different-scope', currentAt: current.checkedAt };
    }
    if (current.schema && previous.schema.digest !== current.schema.digest) {
      return { version: 1, status: 'schema-changed', previousAt: previous.checkedAt, currentAt: current.checkedAt };
    }
    if (current.settings) {
      const changedFields = current.settings.filter((field, index) => field.digest !== previous.settings[index].digest).map(field => field.name);
      if (changedFields.length) return { version: 1, status: 'settings-changed', changedFields,
        previousAt: previous.checkedAt, currentAt: current.checkedAt };
    }
    const changes = []; let changedRows = 0;
    for (let index = 0; index < Math.max(previous.rows.length, current.rows.length); index += 1) {
      const before = previous.rows[index] || null, after = current.rows[index] || null;
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        changedRows += 1;
        if (changes.length < 50) changes.push({ number: index + 1, before, after });
      }
    }
    return { version: 1, status: previous.evidence === current.evidence ? 'unchanged' : 'changed',
      previousAt: previous.checkedAt, currentAt: current.checkedAt, format: current.format, changes,
      beforeText: previous.text, afterText: current.text, rowsLimited: changedRows > 50 };
  }
  return Object.freeze({ orderedRows, explainAccess, reviewExplain, explainFormat, explainDocument, captureExplain, compareExplain,
    explainSettingNames, explainSettings, explainSchema });
}));
