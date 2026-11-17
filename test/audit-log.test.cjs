'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const SqlAuditLog = require('../audit-log.js');

test('classifySqlAction recognizes SQL statements into categories and targets', () => {
  assert.equal(SqlAuditLog.classifySqlAction('SELECT * FROM users').actionType, 'QUERY');
  assert.equal(SqlAuditLog.classifySqlAction('SELECT * FROM users').table, 'users');

  assert.equal(SqlAuditLog.classifySqlAction('SELECT id, name FROM `shop_db`.`orders`').table, 'shop_db.orders');

  assert.equal(SqlAuditLog.classifySqlAction('/* comment */ INSERT INTO `customers` (name) VALUES ("A")').actionType, 'INSERT');
  assert.equal(SqlAuditLog.classifySqlAction('/* comment */ INSERT INTO `customers` (name) VALUES ("A")').table, 'customers');

  assert.equal(SqlAuditLog.classifySqlAction('UPDATE products SET price = 100 WHERE id = 1').actionType, 'UPDATE');
  assert.equal(SqlAuditLog.classifySqlAction('UPDATE products SET price = 100 WHERE id = 1').table, 'products');

  assert.equal(SqlAuditLog.classifySqlAction('-- delete rows\nDELETE FROM logs WHERE created_at < NOW()').actionType, 'DELETE');
  assert.equal(SqlAuditLog.classifySqlAction('-- delete rows\nDELETE FROM logs WHERE created_at < NOW()').table, 'logs');

  assert.equal(SqlAuditLog.classifySqlAction('CREATE TABLE new_table (id INT)').actionType, 'DDL');
  assert.equal(SqlAuditLog.classifySqlAction('CREATE TABLE new_table (id INT)').table, 'new_table');
  assert.equal(SqlAuditLog.classifySqlAction('CREATE TABLE new_table (id INT)').ddlVerb, 'CREATE');

  assert.equal(SqlAuditLog.classifySqlAction('DROP VIEW old_view').actionType, 'DDL');
  assert.equal(SqlAuditLog.classifySqlAction('DROP VIEW old_view').table, 'old_view');
  assert.equal(SqlAuditLog.classifySqlAction('DROP VIEW old_view').ddlVerb, 'DROP');

  assert.equal(SqlAuditLog.classifySqlAction('KILL QUERY 1234').actionType, 'KILL');
});

test('sanitizeAuditSummary strips passwords, tokens, and trims length', () => {
  const textWithPassword = "CREATE USER 'alice'@'%' IDENTIFIED BY 'SuperSecret123!'";
  const sanitized = SqlAuditLog.sanitizeAuditSummary(textWithPassword);
  assert.ok(!sanitized.includes('SuperSecret123!'), 'Password must be stripped');
  assert.ok(sanitized.includes('********'), 'Must contain asterisks');

  const textWithToken = 'api_key: abc123def456 secret=xyz789';
  const scrubbedToken = SqlAuditLog.sanitizeAuditSummary(textWithToken);
  assert.ok(!scrubbedToken.includes('abc123def456'));
  assert.ok(!scrubbedToken.includes('xyz789'));

  const longText = 'A'.repeat(500);
  assert.ok(SqlAuditLog.sanitizeAuditSummary(longText).length <= 300);
});

test('createAuditEntry normalizes audit event structure and preserves immutability', () => {
  const entry = SqlAuditLog.createAuditEntry({
    profileId: 'prod-1',
    profileName: 'Production DB',
    database: 'analytics',
    table: 'pageviews',
    actionType: 'INSERT',
    affectedRows: 42,
    durationMs: 12.8,
    status: 'success'
  });

  assert.equal(entry.version, 1);
  assert.equal(entry.profileId, 'prod-1');
  assert.equal(entry.profileName, 'Production DB');
  assert.equal(entry.database, 'analytics');
  assert.equal(entry.table, 'pageviews');
  assert.equal(entry.actionType, 'INSERT');
  assert.equal(entry.affectedRows, 42);
  assert.equal(entry.durationMs, 13);
  assert.equal(entry.status, 'success');
  assert.ok(entry.summary.includes('pageviews'));
  assert.ok(entry.timestamp);

  assert.throws(() => {
    entry.status = 'error';
  }, /Cannot assign to read only property/);
});

test('filterAuditEntries filters by search, profile, database, action, status, and dates', () => {
  const now = Date.now();
  const entries = [
    SqlAuditLog.createAuditEntry({
      id: '1',
      profileId: 'prod',
      database: 'db1',
      table: 'users',
      actionType: 'QUERY',
      summary: 'SELECT FROM users',
      status: 'success',
      timestamp: new Date(now - 10000).toISOString()
    }),
    SqlAuditLog.createAuditEntry({
      id: '2',
      profileId: 'prod',
      database: 'db1',
      table: 'users',
      actionType: 'DELETE',
      summary: 'DELETE FROM users',
      status: 'error',
      errorCode: 'ER_ROW_IS_REFERENCED',
      timestamp: new Date(now - 5000).toISOString()
    }),
    SqlAuditLog.createAuditEntry({
      id: '3',
      profileId: 'staging',
      database: 'db2',
      table: 'orders',
      actionType: 'INSERT',
      summary: 'INSERT INTO orders',
      status: 'success',
      timestamp: new Date(now).toISOString()
    })
  ];

  // Search keyword
  const searchResults = SqlAuditLog.filterAuditEntries(entries, { search: 'delete' });
  assert.equal(searchResults.length, 1);
  assert.equal(searchResults[0].id, '2');

  // Filter by profile
  const prodResults = SqlAuditLog.filterAuditEntries(entries, { profileId: 'prod' });
  assert.equal(prodResults.length, 2);

  // Filter by actionType
  const insertResults = SqlAuditLog.filterAuditEntries(entries, { actionType: 'INSERT' });
  assert.equal(insertResults.length, 1);
  assert.equal(insertResults[0].id, '3');

  // Filter by status
  const errorResults = SqlAuditLog.filterAuditEntries(entries, { status: 'error' });
  assert.equal(errorResults.length, 1);
  assert.equal(errorResults[0].errorCode, 'ER_ROW_IS_REFERENCED');

  // Filter by time range
  const recentResults = SqlAuditLog.filterAuditEntries(entries, {
    fromTime: new Date(now - 7000).toISOString(),
    toTime: new Date(now + 1000).toISOString()
  });
  assert.equal(recentResults.length, 2);
});

test('pruneAuditEntries honors maxAgeDays and maxEntries quota', () => {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  const entries = [
    SqlAuditLog.createAuditEntry({ id: 'old', timestamp: new Date(now - 40 * dayMs).toISOString() }),
    SqlAuditLog.createAuditEntry({ id: 'med', timestamp: new Date(now - 10 * dayMs).toISOString() }),
    SqlAuditLog.createAuditEntry({ id: 'new', timestamp: new Date(now - 1 * dayMs).toISOString() })
  ];

  // Prune older than 30 days
  const pruned30 = SqlAuditLog.pruneAuditEntries(entries, { maxAgeDays: 30 });
  assert.equal(pruned30.length, 2);
  assert.ok(!pruned30.some(e => e.id === 'old'));

  // Prune older than 7 days
  const pruned7 = SqlAuditLog.pruneAuditEntries(entries, { maxAgeDays: 7 });
  assert.equal(pruned7.length, 1);
  assert.equal(pruned7[0].id, 'new');

  // Limit max entries
  const capped = SqlAuditLog.pruneAuditEntries(entries, { maxEntries: 2 });
  assert.equal(capped.length, 2);
  assert.equal(capped[0].id, 'new');
  assert.equal(capped[1].id, 'med');
});

test('exportAuditCsv and exportAuditJson produce valid formats with disclaimer', () => {
  const entries = [
    SqlAuditLog.createAuditEntry({
      id: 'e1',
      profileName: 'Main Prod',
      database: 'app_db',
      table: 'accounts',
      actionType: 'UPDATE',
      summary: 'Cập nhật tài khoản, số dư',
      affectedRows: 1,
      durationMs: 5,
      status: 'success'
    }),
    SqlAuditLog.createAuditEntry({
      id: 'e2',
      profileName: 'Main Prod',
      database: 'app_db',
      actionType: 'DDL',
      summary: 'ALTER TABLE accounts ADD col',
      status: 'error',
      errorCode: 'ER_DUP_FIELDNAME',
      errorSummary: 'Duplicate column name "col"'
    })
  ];

  const csv = SqlAuditLog.exportAuditCsv(entries);
  assert.ok(csv.includes(SqlAuditLog.AUDIT_DISCLAIMER), 'CSV must contain disclaimer comment');
  assert.ok(csv.includes('Thời gian,Kết nối,CSDL,Bảng,Loại thao tác'), 'CSV must contain header row');
  assert.ok(csv.includes('"Cập nhật tài khoản, số dư"'), 'CSV must quote commas');
  assert.ok(csv.includes('ER_DUP_FIELDNAME'));

  const jsonStr = SqlAuditLog.exportAuditJson(entries);
  const parsed = JSON.parse(jsonStr);
  assert.equal(parsed.disclaimer, SqlAuditLog.AUDIT_DISCLAIMER);
  assert.equal(parsed.totalEntries, 2);
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries[0].table, 'accounts');
});
