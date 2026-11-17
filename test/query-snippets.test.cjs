'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const QuerySnippets = require('../query-snippets.js');

test('normalizeSnippet validates titles, shortcuts, tags and SQL length', () => {
  assert.equal(QuerySnippets.normalizeSnippet(null), null);
  assert.equal(QuerySnippets.normalizeSnippet({ title: '', sql: 'SELECT 1' }), null);
  assert.equal(QuerySnippets.normalizeSnippet({ title: 'T', sql: '' }), null);
  assert.equal(QuerySnippets.normalizeSnippet({ title: 'a'.repeat(101), sql: 'SELECT 1' }), null);
  assert.equal(QuerySnippets.normalizeSnippet({ title: 'Valid', sql: 'x'.repeat(65537) }), null);

  const snippet = QuerySnippets.normalizeSnippet({
    title: '  Select Users  ',
    shortcut: '  !su  ',
    tags: ['#Admin', 'users', 'ADMIN', '', '  reports  ', 'x'.repeat(35)],
    sql: 'SELECT * FROM users WHERE active = 1'
  });

  assert.equal(snippet.title, 'Select Users');
  assert.equal(snippet.shortcut, '!su');
  assert.deepEqual(snippet.tags, ['admin', 'users', 'reports']);
  assert.equal(snippet.sql, 'SELECT * FROM users WHERE active = 1');
  assert.ok(snippet.id.startsWith('snip_'));
  assert.ok(Object.isFrozen(snippet));
  assert.ok(Object.isFrozen(snippet.tags));
});

test('searchSnippets matches queries by title, shortcut, content or tag', () => {
  const snippets = [
    QuerySnippets.normalizeSnippet({ title: 'List Orders', shortcut: '!orders', tags: ['sales', 'orders'], sql: 'SELECT * FROM orders' }),
    QuerySnippets.normalizeSnippet({ title: 'Top Customers', shortcut: '!top', tags: ['sales', 'vip'], sql: 'SELECT customer_id, SUM(total) FROM orders GROUP BY customer_id' }),
    QuerySnippets.normalizeSnippet({ title: 'Server Health', shortcut: '!health', tags: ['ops'], sql: 'SHOW PROCESSLIST' })
  ];

  assert.equal(QuerySnippets.searchSnippets(snippets, { query: 'orders' }).length, 2);
  assert.equal(QuerySnippets.searchSnippets(snippets, { query: '!top' }).length, 1);
  assert.equal(QuerySnippets.searchSnippets(snippets, { tag: 'sales' }).length, 2);
  assert.equal(QuerySnippets.searchSnippets(snippets, { tag: 'ops' }).length, 1);
  assert.equal(QuerySnippets.searchSnippets(snippets, { tag: 'sales', query: 'customer' }).length, 1);
  assert.equal(QuerySnippets.searchSnippets(snippets, { query: 'nonexistent' }).length, 0);
});

test('scrubSensitiveSql masks passwords, tokens and secrets without mutating query structure', () => {
  const q1 = "CREATE USER 'admin'@'%' IDENTIFIED BY 'SuperSecret123!'";
  assert.equal(QuerySnippets.scrubSensitiveSql(q1), "CREATE USER 'admin'@'%' IDENTIFIED BY '***'");

  const q2 = "ALTER USER 'dev'@'localhost' IDENTIFIED BY PASSWORD '*2470C0C06DEE42FD1618BB99005ADCA2EC9D1E19'";
  assert.equal(QuerySnippets.scrubSensitiveSql(q2), "ALTER USER 'dev'@'localhost' IDENTIFIED BY '***'");

  const q3 = "SET PASSWORD FOR 'root'@'localhost' = 'MyNewPassword'";
  assert.equal(QuerySnippets.scrubSensitiveSql(q3), "SET PASSWORD FOR 'root'@'localhost' = '***'");

  const q4 = "SELECT * FROM api_keys WHERE secret = 'sk_live_abcdef123456'";
  assert.equal(QuerySnippets.scrubSensitiveSql(q4), "SELECT * FROM api_keys WHERE secret = '***'");

  const normal = 'SELECT id, name FROM users WHERE id = 1';
  assert.equal(QuerySnippets.scrubSensitiveSql(normal), normal);

  assert.equal(QuerySnippets.hasSensitiveSql(q1), true);
  assert.equal(QuerySnippets.hasSensitiveSql(q2), true);
  assert.equal(QuerySnippets.hasSensitiveSql(q3), true);
  assert.equal(QuerySnippets.hasSensitiveSql(q4), true);
  assert.equal(QuerySnippets.hasSensitiveSql(normal), false);
});

test('normalizeHistoryEntry handles strings, objects and sensitive scrubbing', () => {
  const fromStr = QuerySnippets.normalizeHistoryEntry('SELECT 1');
  assert.equal(fromStr.sql, 'SELECT 1');
  assert.equal(fromStr.ok, true);

  const sensitive = QuerySnippets.normalizeHistoryEntry(
    { sql: "CREATE USER 'test'@'%' IDENTIFIED BY 'secret'", ok: true },
    { scrubSensitive: true }
  );
  assert.equal(sensitive.sql, "CREATE USER 'test'@'%' IDENTIFIED BY '***'");

  const normal = QuerySnippets.normalizeHistoryEntry({
    sql: 'SELECT * FROM items',
    ok: false,
    durationMs: 42,
    message: 'Table not found',
    database: 'shop',
    tags: ['audit', '#p1']
  });
  assert.equal(normal.sql, 'SELECT * FROM items');
  assert.equal(normal.ok, false);
  assert.equal(normal.durationMs, 42);
  assert.equal(normal.database, 'shop');
  assert.deepEqual(normal.tags, ['audit', 'p1']);
  assert.ok(Object.isFrozen(normal));
});

test('searchHistory filters by text, execution status, database and tags', () => {
  const history = [
    QuerySnippets.normalizeHistoryEntry({ sql: 'SELECT * FROM customers', ok: true, database: 'crm', tags: ['crm'] }),
    QuerySnippets.normalizeHistoryEntry({ sql: 'UPDATE customers SET active = 0', ok: true, database: 'crm' }),
    QuerySnippets.normalizeHistoryEntry({ sql: 'DROP TABLE nonexistent', ok: false, database: 'crm', message: 'Unknown table' }),
    QuerySnippets.normalizeHistoryEntry({ sql: 'SELECT * FROM inventory', ok: true, database: 'warehouse', tags: ['stock'] })
  ];

  assert.equal(QuerySnippets.searchHistory(history, { query: 'customers' }).length, 2);
  assert.equal(QuerySnippets.searchHistory(history, { status: 'error' }).length, 1);
  assert.equal(QuerySnippets.searchHistory(history, { status: 'ok' }).length, 3);
  assert.equal(QuerySnippets.searchHistory(history, { database: 'warehouse' }).length, 1);
  assert.equal(QuerySnippets.searchHistory(history, { tag: 'stock' }).length, 1);
  assert.equal(QuerySnippets.searchHistory(history, { database: 'crm', status: 'ok', query: 'UPDATE' }).length, 1);
});

test('pruneHistory respects item count caps and retention time boundaries', () => {
  const now = new Date('2026-11-17T12:00:00Z').getTime();
  const history = [
    QuerySnippets.normalizeHistoryEntry({ sql: 'Q1', at: '2026-11-17T11:00:00Z' }), // today
    QuerySnippets.normalizeHistoryEntry({ sql: 'Q2', at: '2026-11-15T11:00:00Z' }), // 2 days ago
    QuerySnippets.normalizeHistoryEntry({ sql: 'Q3', at: '2026-11-01T11:00:00Z' }), // 16 days ago
    QuerySnippets.normalizeHistoryEntry({ sql: 'Q4', at: '2026-10-01T11:00:00Z' })  // 47 days ago
  ];

  // Count limit
  assert.equal(QuerySnippets.pruneHistory(history, { maxItems: 2 }).length, 2);

  // Time retention (7 days)
  const past7Days = QuerySnippets.pruneHistory(history, { maxDays: 7, now });
  assert.equal(past7Days.length, 2);
  assert.deepEqual(past7Days.map(e => e.sql), ['Q1', 'Q2']);

  // Time retention (30 days)
  const past30Days = QuerySnippets.pruneHistory(history, { maxDays: 30, now });
  assert.equal(past30Days.length, 3);
  assert.deepEqual(past30Days.map(e => e.sql), ['Q1', 'Q2', 'Q3']);
});

test('defaultSnippets returns initial library of clean normalized snippets', () => {
  const defaults = QuerySnippets.defaultSnippets();
  assert.ok(Array.isArray(defaults));
  assert.ok(defaults.length >= 4);
  for (const snip of defaults) {
    assert.ok(snip.id);
    assert.ok(snip.title);
    assert.ok(snip.sql);
    assert.ok(Array.isArray(snip.tags));
  }
});
