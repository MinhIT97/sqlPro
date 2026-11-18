(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SqlAuditLog = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var AUDIT_VERSION = 1;
  var MAX_STORED_ENTRIES = 1000;
  var MAX_SUMMARY_LENGTH = 300;

  var ACTION_TYPES = Object.freeze({
    QUERY: 'QUERY',
    INSERT: 'INSERT',
    UPDATE: 'UPDATE',
    DELETE: 'DELETE',
    DDL: 'DDL',
    EXPORT: 'EXPORT',
    IMPORT: 'IMPORT',
    BACKUP: 'BACKUP',
    RESTORE: 'RESTORE',
    KILL: 'KILL',
    SCHEMA_DIFF: 'SCHEMA_DIFF',
    AUTH: 'AUTH'
  });

  var AUDIT_DISCLAIMER = 'Nhật ký thao tác cục bộ trên thiết bị (Local Audit Log) được lưu tạm để hỗ trợ tra cứu lịch sử làm việc cá nhân. Đây không phải hệ thống audit log máy chủ bất biến (immutable audit log) và không thay thế nhật ký bảo mật của hệ thống cơ sở dữ liệu.';

  function extractTargetName(sql, keywordPattern) {
    var match = sql.match(keywordPattern);
    if (!match) return null;
    var raw = match[1].trim();
    var parsed = raw.match(/^(?:[`"']?([A-Za-z0-9_$]+)[`"']?\.)?[`"']?([A-Za-z0-9_$]+)[`"']?/);
    if (!parsed) return null;
    return parsed[1] ? parsed[1] + '.' + parsed[2] : parsed[2];
  }

  /**
   * Classify SQL statement into action category and extract main target table if identifiable.
   * @param {string} sql
   * @returns {{ actionType: string, table: string|null, ddlVerb: string|null }}
   */
  function classifySqlAction(sql) {
    if (!sql || typeof sql !== 'string') {
      return { actionType: ACTION_TYPES.QUERY, table: null, ddlVerb: null };
    }

    var cleanSql = sql.replace(/\/\*[\s\S]*?\*\/|--[^\n]*\n?|#[^\n]*\n?/g, ' ').trim();
    if (!cleanSql) {
      return { actionType: ACTION_TYPES.QUERY, table: null, ddlVerb: null };
    }

    var firstWordMatch = cleanSql.match(/^([A-Za-z]+)/i);
    var firstWord = firstWordMatch ? firstWordMatch[1].toUpperCase() : '';

    if (firstWord === 'SELECT' || firstWord === 'EXPLAIN' || firstWord === 'DESCRIBE' || firstWord === 'DESC' || firstWord === 'SHOW') {
      var tableName = extractTargetName(cleanSql, /\bFROM\s+([^\s,;()]+)/i);
      return { actionType: ACTION_TYPES.QUERY, table: tableName, ddlVerb: null };
    }

    if (firstWord === 'INSERT' || firstWord === 'REPLACE') {
      var insTable = extractTargetName(cleanSql, /\bINTO\s+([^\s,;()]+)/i);
      return { actionType: ACTION_TYPES.INSERT, table: insTable, ddlVerb: null };
    }

    if (firstWord === 'UPDATE') {
      var updTable = extractTargetName(cleanSql, /\bUPDATE\s+([^\s,;()]+)/i);
      return { actionType: ACTION_TYPES.UPDATE, table: updTable, ddlVerb: null };
    }

    if (firstWord === 'DELETE') {
      var delTable = extractTargetName(cleanSql, /\bFROM\s+([^\s,;()]+)/i);
      return { actionType: ACTION_TYPES.DELETE, table: delTable, ddlVerb: null };
    }

    if (firstWord === 'CREATE' || firstWord === 'ALTER' || firstWord === 'DROP' || firstWord === 'TRUNCATE' || firstWord === 'RENAME') {
      var ddlTable = extractTargetName(cleanSql, /\b(?:TABLE|VIEW|PROCEDURE|FUNCTION|TRIGGER|INDEX|DATABASE)\s+([^\s,;()]+)/i);
      return { actionType: ACTION_TYPES.DDL, table: ddlTable, ddlVerb: firstWord };
    }

    if (firstWord === 'KILL') {
      return { actionType: ACTION_TYPES.KILL, table: null, ddlVerb: null };
    }

    return { actionType: ACTION_TYPES.QUERY, table: null, ddlVerb: null };
  }

  /**
   * Sanitize text to remove passwords, tokens, API keys, and truncate excessive lengths.
   * @param {string} text
   * @returns {string}
   */
  function sanitizeAuditSummary(text) {
    if (!text || typeof text !== 'string') return '';

    // Strip passwords and secret keywords
    var scrubbed = text
      .replace(/((?:password|passwd|pwd|secret|token|api[_-]?key|mat_khau)\s*[:=]\s*['"]?)[^'"\s,;)]+/gi, '$1********')
      .replace(/(IDENTIFIED\s+(?:WITH\s+['"]?[a-zA-Z0-9_]+['"]?\s+)?BY\s+['"])[^'"]+(['"])/gi, '$1********$2')
      .replace(/(SET\s+PASSWORD(?:\s+FOR\s+[^=]+)?\s*=\s*(?:PASSWORD\s*\()?\s*['"])[^'"]+(['"]\)?)/gi, '$1********$2')
      .replace(/(PASSWORD\s*\(['"])[^'"]+(['"]\))/gi, '$1********$2')
      .replace(/(\/\*!\d+\s*IDENTIFIED\s+(?:WITH\s+['"]?[a-zA-Z0-9_]+['"]?\s+)?BY\s+['"])[^'"]+(['"])/gi, '$1********$2')
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1********')
      .replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, '********');

    // Replace linebreaks with spaces and trim
    scrubbed = scrubbed.replace(/\s+/g, ' ').trim();

    if (scrubbed.length > MAX_SUMMARY_LENGTH) {
      return scrubbed.slice(0, MAX_SUMMARY_LENGTH - 3) + '...';
    }
    return scrubbed;
  }

  /**
   * Create a safe, standardized audit summary for an action without logging raw row contents or secrets.
   * @param {string} actionType
   * @param {string} [table]
   * @param {Object} [details]
   * @returns {string}
   */
  function buildAuditSummary(actionType, table, details) {
    details = details || {};
    var prefix = '';

    switch (actionType) {
      case ACTION_TYPES.QUERY:
        prefix = table ? 'Truy vấn bảng `' + table + '`' : 'Thực thi câu truy vấn SQL';
        break;
      case ACTION_TYPES.INSERT:
        prefix = 'Thêm bản ghi vào bảng `' + (table || 'không xác định') + '`';
        break;
      case ACTION_TYPES.UPDATE:
        prefix = 'Cập nhật bản ghi trong bảng `' + (table || 'không xác định') + '`';
        break;
      case ACTION_TYPES.DELETE:
        prefix = 'Xóa bản ghi từ bảng `' + (table || 'không xác định') + '`';
        break;
      case ACTION_TYPES.DDL:
        var ddlVerb = details.ddlVerb ? details.ddlVerb.toUpperCase() + ' ' : '';
        prefix = ddlVerb + (table ? 'đối tượng `' + table + '`' : 'cấu trúc CSDL');
        break;
      case ACTION_TYPES.EXPORT:
        var format = (details.format || 'dữ liệu').toUpperCase();
        prefix = 'Xuất ' + format + (table ? ' từ `' + table + '`' : '');
        break;
      case ACTION_TYPES.IMPORT:
        prefix = 'Nhập dữ liệu vào `' + (table || 'CSDL') + '`';
        break;
      case ACTION_TYPES.BACKUP:
        prefix = 'Sao lưu CSDL ' + (details.database ? '`' + details.database + '`' : '');
        break;
      case ACTION_TYPES.RESTORE:
        prefix = 'Phục hồi CSDL ' + (details.database ? '`' + details.database + '`' : '');
        break;
      case ACTION_TYPES.KILL:
        prefix = 'Hủy tiến trình #' + (details.threadId || '');
        break;
      case ACTION_TYPES.SCHEMA_DIFF:
        prefix = 'Đồng bộ Schema Migration' + (details.targetDb ? ' sang `' + details.targetDb + '`' : '');
        break;
      case ACTION_TYPES.AUTH:
        prefix = details.action || 'Kết nối CSDL';
        break;
      default:
        prefix = 'Thao tác ' + actionType;
    }

    if (details.note) {
      prefix += ' (' + sanitizeAuditSummary(details.note) + ')';
    }

    return sanitizeAuditSummary(prefix);
  }

  /**
   * Generates a unique ID for an audit entry.
   * @returns {string}
   */
  function generateAuditId() {
    var timestamp = Date.now().toString(36);
    var random = Math.random().toString(36).substring(2, 8);
    return 'audit-' + timestamp + '-' + random;
  }

  /**
   * Normalize an audit event entry.
   * @param {Object} input
   * @returns {Object}
   */
  function createAuditEntry(input) {
    if (!input || typeof input !== 'object') {
      input = {};
    }

    var id = typeof input.id === 'string' && input.id ? input.id : generateAuditId();
    var timestamp = input.timestamp && !isNaN(Date.parse(input.timestamp))
      ? new Date(input.timestamp).toISOString()
      : new Date().toISOString();

    var actionType = typeof input.actionType === 'string' && ACTION_TYPES[input.actionType.toUpperCase()]
      ? input.actionType.toUpperCase()
      : ACTION_TYPES.QUERY;

    var profileId = typeof input.profileId === 'string' ? input.profileId : 'default';
    var profileName = typeof input.profileName === 'string' ? input.profileName : 'Default';
    var database = typeof input.database === 'string' ? input.database : '';
    var table = typeof input.table === 'string' ? input.table : null;

    var summary = typeof input.summary === 'string' && input.summary
      ? sanitizeAuditSummary(input.summary)
      : buildAuditSummary(actionType, table, input);

    var affectedRows = Number.isInteger(input.affectedRows) && input.affectedRows >= 0
      ? input.affectedRows
      : null;

    var durationMs = typeof input.durationMs === 'number' && !isNaN(input.durationMs) && input.durationMs >= 0
      ? Math.round(input.durationMs)
      : 0;

    var status = input.status === 'error' ? 'error' : 'success';
    var errorCode = input.errorCode ? String(input.errorCode).slice(0, 64) : null;
    var errorSummary = input.errorSummary ? sanitizeAuditSummary(String(input.errorSummary)) : null;

    return Object.freeze({
      id: id,
      version: AUDIT_VERSION,
      timestamp: timestamp,
      profileId: profileId,
      profileName: profileName,
      database: database,
      table: table,
      actionType: actionType,
      summary: summary,
      affectedRows: affectedRows,
      durationMs: durationMs,
      status: status,
      errorCode: errorCode,
      errorSummary: errorSummary,
      sensitiveScrubbed: true
    });
  }

  /**
   * Filter and search audit log entries.
   * @param {Array<Object>} entries
   * @param {Object} [filter]
   * @returns {Array<Object>}
   */
  function filterAuditEntries(entries, filter) {
    if (!Array.isArray(entries)) return [];
    filter = filter || {};

    var search = typeof filter.search === 'string' ? filter.search.trim().toLowerCase() : '';
    var profileId = typeof filter.profileId === 'string' && filter.profileId ? filter.profileId : null;
    var database = typeof filter.database === 'string' && filter.database ? filter.database.toLowerCase() : null;
    var actionType = typeof filter.actionType === 'string' && filter.actionType && filter.actionType !== 'ALL'
      ? filter.actionType.toUpperCase()
      : null;
    var status = filter.status === 'success' || filter.status === 'error' ? filter.status : null;

    var fromTime = filter.fromTime && !isNaN(Date.parse(filter.fromTime))
      ? new Date(filter.fromTime).getTime()
      : null;
    var toTime = filter.toTime && !isNaN(Date.parse(filter.toTime))
      ? new Date(filter.toTime).getTime()
      : null;

    return entries.filter(function (entry) {
      if (!entry || typeof entry !== 'object') return false;

      if (profileId && entry.profileId !== profileId) return false;
      if (database && (!entry.database || entry.database.toLowerCase() !== database)) return false;
      if (actionType && entry.actionType !== actionType) return false;
      if (status && entry.status !== status) return false;

      var entryTime = new Date(entry.timestamp).getTime();
      if (fromTime !== null && entryTime < fromTime) return false;
      if (toTime !== null && entryTime > toTime) return false;

      if (search) {
        var matchSummary = entry.summary && entry.summary.toLowerCase().indexOf(search) !== -1;
        var matchTable = entry.table && entry.table.toLowerCase().indexOf(search) !== -1;
        var matchDb = entry.database && entry.database.toLowerCase().indexOf(search) !== -1;
        var matchProfile = entry.profileName && entry.profileName.toLowerCase().indexOf(search) !== -1;
        var matchError = entry.errorCode && entry.errorCode.toLowerCase().indexOf(search) !== -1;
        if (!matchSummary && !matchTable && !matchDb && !matchProfile && !matchError) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Prune entries according to retention policy (age or maximum count).
   * @param {Array<Object>} entries
   * @param {Object} [options]
   * @returns {Array<Object>}
   */
  function pruneAuditEntries(entries, options) {
    if (!Array.isArray(entries)) return [];
    options = options || {};

    var maxAgeDays = typeof options.maxAgeDays === 'number' && options.maxAgeDays > 0
      ? options.maxAgeDays
      : null;
    var maxEntries = typeof options.maxEntries === 'number' && options.maxEntries > 0
      ? options.maxEntries
      : MAX_STORED_ENTRIES;

    var now = Date.now();
    var filtered = entries.filter(function (entry) {
      if (!entry || !entry.timestamp) return false;
      if (maxAgeDays !== null) {
        var ageMs = now - new Date(entry.timestamp).getTime();
        var ageDays = ageMs / (1000 * 60 * 60 * 24);
        if (ageDays > maxAgeDays) return false;
      }
      return true;
    });

    // Sort descending by timestamp
    filtered.sort(function (a, b) {
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    });

    if (filtered.length > maxEntries) {
      return filtered.slice(0, maxEntries);
    }
    return filtered;
  }

  /**
   * Escape a string value for RFC-4180 CSV export.
   * @param {*} val
   * @returns {string}
   */
  function escapeCsvValue(val) {
    if (val === null || val === undefined) return '';
    var str = String(val);
    if (str.indexOf(',') !== -1 || str.indexOf('"') !== -1 || str.indexOf('\n') !== -1 || str.indexOf('\r') !== -1) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  /**
   * Export audit log entries as CSV string.
   * @param {Array<Object>} entries
   * @returns {string}
   */
  function exportAuditCsv(entries) {
    if (!Array.isArray(entries)) return '';

    var headers = ['Thời gian', 'Kết nối', 'CSDL', 'Bảng', 'Loại thao tác', 'Tóm tắt', 'Số dòng', 'Thời lượng (ms)', 'Trạng thái', 'Mã lỗi', 'Chi tiết lỗi'];
    var lines = [
      '# ' + AUDIT_DISCLAIMER,
      headers.map(escapeCsvValue).join(',')
    ];

    entries.forEach(function (e) {
      if (!e) return;
      lines.push([
        escapeCsvValue(e.timestamp),
        escapeCsvValue(e.profileName || e.profileId),
        escapeCsvValue(e.database || ''),
        escapeCsvValue(e.table || ''),
        escapeCsvValue(e.actionType),
        escapeCsvValue(e.summary),
        escapeCsvValue(e.affectedRows !== null ? e.affectedRows : ''),
        escapeCsvValue(e.durationMs),
        escapeCsvValue(e.status === 'success' ? 'Thành công' : 'Lỗi'),
        escapeCsvValue(e.errorCode || ''),
        escapeCsvValue(e.errorSummary || '')
      ].join(','));
    });

    return lines.join('\r\n');
  }

  /**
   * Export audit log entries as formatted JSON with disclaimer.
   * @param {Array<Object>} entries
   * @returns {string}
   */
  function exportAuditJson(entries) {
    if (!Array.isArray(entries)) entries = [];

    var exportObj = {
      disclaimer: AUDIT_DISCLAIMER,
      exportedAt: new Date().toISOString(),
      totalEntries: entries.length,
      entries: entries
    };

    return JSON.stringify(exportObj, null, 2);
  }

  return Object.freeze({
    AUDIT_VERSION: AUDIT_VERSION,
    MAX_STORED_ENTRIES: MAX_STORED_ENTRIES,
    ACTION_TYPES: ACTION_TYPES,
    AUDIT_DISCLAIMER: AUDIT_DISCLAIMER,
    classifySqlAction: classifySqlAction,
    sanitizeAuditSummary: sanitizeAuditSummary,
    buildAuditSummary: buildAuditSummary,
    createAuditEntry: createAuditEntry,
    filterAuditEntries: filterAuditEntries,
    pruneAuditEntries: pruneAuditEntries,
    exportAuditCsv: exportAuditCsv,
    exportAuditJson: exportAuditJson
  });
}));
