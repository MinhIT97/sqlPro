(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.QuerySnippets = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function createQuerySnippets() {
  'use strict';

  const limits = Object.freeze({
    maxSnippets: 200,
    maxSql: 65536,
    maxTitle: 100,
    maxShortcut: 30,
    maxTags: 10,
    maxTag: 30,
    maxHistory: 500,
    maxHistorySql: 65536
  });

  const SENSITIVE_PATTERNS = [
    /\bIDENTIFIED\s+BY\s+(?:PASSWORD\s+)?(?:'[^']*'|"[^"]*")/gi,
    /\bSET\s+PASSWORD(?:\s+FOR\s+[^=]+)?\s*=\s*(?:'[^']*'|"[^"]*")/gi,
    /\bPASSWORD\s*\(\s*(?:'[^']*'|"[^"]*")\s*\)/gi,
    /\b(?:api_?key|secret|token|auth_?token|private_?key)\s*[:=]\s*(?:'[^']*'|"[^"]*")/gi
  ];

  function scrubSensitiveSql(sql) {
    if (typeof sql !== 'string') return '';
    let scrubbed = sql;
    scrubbed = scrubbed.replace(/\bIDENTIFIED\s+BY\s+(?:PASSWORD\s+)?(?:'[^']*'|"[^"]*")/gi, "IDENTIFIED BY '***'");
    scrubbed = scrubbed.replace(/\bSET\s+PASSWORD(?:\s+FOR\s+[^=]+)?\s*=\s*(?:'[^']*'|"[^"]*")/gi, (match) => {
      const prefix = match.split('=')[0];
      return `${prefix}= '***'`;
    });
    scrubbed = scrubbed.replace(/\bPASSWORD\s*\(\s*(?:'[^']*'|"[^"]*")\s*\)/gi, "PASSWORD('***')");
    scrubbed = scrubbed.replace(/\b(api_?key|secret|token|auth_?token|private_?key)\s*([:=])\s*(?:'[^']*'|"[^"]*")/gi, "$1 $2 '***'");
    return scrubbed;
  }

  function hasSensitiveSql(sql) {
    if (typeof sql !== 'string') return false;
    return SENSITIVE_PATTERNS.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(sql);
    });
  }

  function normalizeTag(tag) {
    if (typeof tag !== 'string') return null;
    const clean = tag.trim().toLowerCase().replace(/^[#@]+/, '');
    if (!clean || clean.length > limits.maxTag) return null;
    return clean;
  }

  function normalizeSnippet(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    const sql = typeof raw.sql === 'string' ? raw.sql.trim() : '';
    if (!title || title.length > limits.maxTitle) return null;
    if (!sql || sql.length > limits.maxSql) return null;

    const id = typeof raw.id === 'string' && raw.id ? raw.id : `snip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const shortcut = typeof raw.shortcut === 'string' ? raw.shortcut.trim().slice(0, limits.maxShortcut) : '';
    
    let tags = [];
    if (Array.isArray(raw.tags)) {
      const seen = new Set();
      for (const t of raw.tags) {
        const tag = normalizeTag(t);
        if (tag && !seen.has(tag)) {
          seen.add(tag);
          tags.push(tag);
          if (tags.length >= limits.maxTags) break;
        }
      }
    }

    return Object.freeze({
      id,
      title,
      shortcut,
      tags: Object.freeze(tags),
      sql,
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString()
    });
  }

  function searchSnippets(snippets, { query = '', tag = '' } = {}) {
    if (!Array.isArray(snippets)) return [];
    const q = String(query || '').trim().toLowerCase();
    const filterTag = String(tag || '').trim().toLowerCase();

    return snippets.filter((s) => {
      if (!s || typeof s !== 'object') return false;
      if (filterTag && (!Array.isArray(s.tags) || !s.tags.includes(filterTag))) return false;
      if (!q) return true;
      const matchTitle = (s.title || '').toLowerCase().includes(q);
      const matchShortcut = (s.shortcut || '').toLowerCase().includes(q);
      const matchSql = (s.sql || '').toLowerCase().includes(q);
      const matchTags = Array.isArray(s.tags) && s.tags.some((t) => t.toLowerCase().includes(q));
      return matchTitle || matchShortcut || matchSql || matchTags;
    });
  }

  function normalizeHistoryEntry(raw, { scrubSensitive = false } = {}) {
    if (typeof raw === 'string') {
      const sql = scrubSensitive ? scrubSensitiveSql(raw) : raw;
      return Object.freeze({
        id: `h_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        sql: sql.slice(0, limits.maxHistorySql),
        ok: true,
        at: '',
        durationMs: null,
        message: '',
        profileId: null,
        database: null,
        tags: Object.freeze([])
      });
    }
    if (!raw || typeof raw !== 'object' || typeof raw.sql !== 'string') return null;

    const sql = scrubSensitive ? scrubSensitiveSql(raw.sql) : raw.sql;
    const id = typeof raw.id === 'string' && raw.id ? raw.id : `h_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    
    let tags = [];
    if (Array.isArray(raw.tags)) {
      const seen = new Set();
      for (const t of raw.tags) {
        const tag = normalizeTag(t);
        if (tag && !seen.has(tag)) {
          seen.add(tag);
          tags.push(tag);
          if (tags.length >= limits.maxTags) break;
        }
      }
    }

    return Object.freeze({
      id,
      sql: sql.slice(0, limits.maxHistorySql),
      ok: raw.ok !== false,
      at: typeof raw.at === 'string' ? raw.at : '',
      durationMs: Number.isFinite(raw.durationMs) ? Number(raw.durationMs) : null,
      message: typeof raw.message === 'string' ? raw.message : '',
      profileId: typeof raw.profileId === 'string' ? raw.profileId : null,
      database: typeof raw.database === 'string' ? raw.database : null,
      tags: Object.freeze(tags)
    });
  }

  function searchHistory(history, { query = '', status = 'all', database = '', tag = '' } = {}) {
    if (!Array.isArray(history)) return [];
    const q = String(query || '').trim().toLowerCase();
    const filterStatus = String(status || 'all').toLowerCase();
    const filterDb = String(database || '').trim().toLowerCase();
    const filterTag = String(tag || '').trim().toLowerCase();

    return history.filter((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      if (filterStatus === 'ok' && !entry.ok) return false;
      if (filterStatus === 'error' && entry.ok) return false;
      if (filterDb && (entry.database || '').toLowerCase() !== filterDb) return false;
      if (filterTag && (!Array.isArray(entry.tags) || !entry.tags.includes(filterTag))) return false;
      if (!q) return true;
      const matchSql = (entry.sql || '').toLowerCase().includes(q);
      const matchMsg = (entry.message || '').toLowerCase().includes(q);
      const matchTags = Array.isArray(entry.tags) && entry.tags.some((t) => t.toLowerCase().includes(q));
      return matchSql || matchMsg || matchTags;
    });
  }

  function pruneHistory(history, { maxItems = limits.maxHistory, maxDays = null, now = Date.now() } = {}) {
    if (!Array.isArray(history)) return [];
    let items = history.filter(Boolean);
    if (Number.isFinite(maxDays) && maxDays > 0) {
      const cutoff = now - (maxDays * 86400000);
      items = items.filter((entry) => {
        if (!entry.at) return true; // keep entries without timestamps
        const timestamp = new Date(entry.at).getTime();
        return isNaN(timestamp) || timestamp >= cutoff;
      });
    }
    const limit = Number.isInteger(maxItems) && maxItems > 0 ? maxItems : limits.maxHistory;
    return items.slice(0, limit);
  }

  function defaultSnippets() {
    return [
      normalizeSnippet({
        id: 'snip_default_select_limit',
        title: 'Select phân trang',
        shortcut: 'sel',
        tags: ['select', 'query'],
        sql: 'SELECT *\nFROM `table_name`\nWHERE 1 = 1\nORDER BY id DESC\nLIMIT 50;'
      }),
      normalizeSnippet({
        id: 'snip_default_group_count',
        title: 'Đếm theo nhóm (GROUP BY)',
        shortcut: 'grp',
        tags: ['aggregate', 'select'],
        sql: 'SELECT `status`, COUNT(*) AS total\nFROM `table_name`\nGROUP BY `status`\nORDER BY total DESC;'
      }),
      normalizeSnippet({
        id: 'snip_default_cte',
        title: 'Bảng tạm CTE (WITH)',
        shortcut: 'cte',
        tags: ['cte', 'advanced'],
        sql: 'WITH cte AS (\n  SELECT id, created_at\n  FROM `table_name`\n  WHERE created_at >= NOW() - INTERVAL 7 DAY\n)\nSELECT *\nFROM cte;'
      }),
      normalizeSnippet({
        id: 'snip_default_insert_batch',
        title: 'Chèn nhiều dòng (Batch INSERT)',
        shortcut: 'ins',
        tags: ['insert', 'dml'],
        sql: 'INSERT INTO `table_name` (`col1`, `col2`)\nVALUES\n  (\'val1\', \'val2\'),\n  (\'val3\', \'val4\');'
      }),
      normalizeSnippet({
        id: 'snip_default_explain',
        title: 'Phân tích kế hoạch EXPLAIN ANALYZE',
        shortcut: 'exp',
        tags: ['explain', 'perf'],
        sql: 'EXPLAIN ANALYZE\nSELECT *\nFROM `table_name`\nWHERE id = 1;'
      })
    ].filter(Boolean);
  }

  return Object.freeze({
    limits,
    scrubSensitiveSql,
    hasSensitiveSql,
    normalizeTag,
    normalizeSnippet,
    searchSnippets,
    defaultSnippets,
    normalizeHistoryEntry,
    searchHistory,
    pruneHistory
  });
}));
