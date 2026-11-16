'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const crypto = require('node:crypto');
const { DatabaseSession } = require('../electron/database.cjs');
const { explainDocument, reviewExplain, captureExplain, compareExplain } = require('../query-results.js');

test('EXPLAIN formats on an isolated engine retain settings/data and expose capability by server outcome', {
  skip: !process.env.SQLPRO_TEST_EXPLAIN_PORT, timeout: 30000
}, async t => {
  const port = Number(process.env.SQLPRO_TEST_EXPLAIN_PORT), database = `sqlpro_explain_${Date.now()}_${process.pid}`;
  const admin = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root' });
  const reader = new DatabaseSession({ host: '127.0.0.1', port, user: 'root', password: '', database, readOnly: true,
    ssl: { enabled: false }, ssh: { enabled: false } });
  const analyzer = new DatabaseSession({ ...reader.profile, readOnly: false });
  let created = false;
  try {
    await admin.query(`CREATE DATABASE \`${database}\``); created = true;
    await admin.query(`CREATE TABLE \`${database}\`.sample (id INT PRIMARY KEY, label VARCHAR(50)) ENGINE=InnoDB`);
    await admin.query(`INSERT INTO \`${database}\`.sample VALUES (1,'fixture'),(2,'other')`);
    await reader.connect();
    const settings = () => reader.raw('SELECT CONNECTION_ID() AS id, @@SESSION.autocommit AS ac, @@SESSION.sql_mode AS mode');
    const before = (await settings()).rows, snapshot = (await admin.query(`SELECT * FROM \`${database}\`.sample ORDER BY id`))[0];
    const query = async format => {
      const result = await reader.runQueryScript(`EXPLAIN ${format ? `FORMAT=${format} ` : ''}SELECT * FROM sample WHERE id=1`);
      result.isExplain = true; result.explainFormat = format || 'DEFAULT'; return result;
    };
    await t.test('default EXPLAIN remains traditional on fixture defaults', async () => {
      const report = reviewExplain(await query(''));
      assert.ok(report); assert.ok(report.rows.length); assert.equal(report.rows[0].table, 'sample');
    });
    await t.test('JSON is viewable on both MySQL/MariaDB without rewriting native fields', async () => {
      const result = await query('JSON'), beforeResult = structuredClone(result), report = explainDocument(result);
      assert.equal(report.format, 'JSON'); assert.equal(report.status, 'formatted'); assert.equal(report.truncated, false);
      assert.ok(JSON.parse(report.text).query_block); assert.deepEqual(result, beforeResult);
      assert.deepEqual(JSON.parse(report.text), JSON.parse(result.rows[0][0]));
    });
    await t.test('TREE succeeds only when server supports it, unsupported result is a surfaced error', async () => {
      if (process.env.SQLPRO_TEST_EXPLAIN_KIND === 'mariadb') {
        await assert.rejects(query('TREE'), error => ['ER_PARSE_ERROR', 'ER_UNKNOWN_EXPLAIN_FORMAT'].includes(error.code));
      } else {
        const report = explainDocument(await query('TREE'));
        assert.equal(report.format, 'TREE'); assert.equal(report.status, 'raw'); assert.match(report.text, /->/);
      }
    });
    await t.test('read-only policy rejects ANALYZE and values/settings/connection stay unchanged', async () => {
      await assert.rejects(reader.runQueryScript('EXPLAIN ANALYZE SELECT * FROM sample'),
        error => ['CONNECTION_READ_ONLY', 'READ_ONLY_SQL_UNSUPPORTED'].includes(error.code));
      assert.deepEqual((await settings()).rows, before);
      assert.deepEqual((await admin.query(`SELECT * FROM \`${database}\`.sample ORDER BY id`))[0], snapshot);
    });
    await t.test('separate ANALYZE action returns native actual statistics without changing fixture data or session settings', async () => {
      await analyzer.connect();
      const sessionSettings = () => analyzer.raw('SELECT CONNECTION_ID() AS id, @@SESSION.autocommit AS ac, @@SESSION.sql_mode AS mode');
      const original = (await sessionSettings()).rows;
      const result = await analyzer.analyzeQuery('SELECT * FROM sample WHERE id=1', 5000, 'analyze-native');
      assert.equal(result.isAnalyze, true); assert.equal(result.analysis.executed, true);
      assert.equal(result.truncated, false); assert.equal(result.explainContext, undefined);
      const document = explainDocument(result); assert.ok(document);
      if (process.env.SQLPRO_TEST_EXPLAIN_KIND === 'mariadb') {
        assert.equal(result.analysis.engine, 'MariaDB'); assert.equal(document.format, 'JSON');
        assert.match(document.text, /"r_(?:rows|total_time_ms|loops)"/);
      } else {
        assert.equal(result.analysis.engine, 'MySQL'); assert.equal(document.format, 'TREE');
        assert.match(document.text, /actual (?:time|rows)/);
      }
      assert.equal(captureExplain(result, {}), null);
      assert.deepEqual((await sessionSettings()).rows, original);
      assert.deepEqual((await admin.query(`SELECT * FROM \`${database}\`.sample ORDER BY id`))[0], snapshot);
    });
    await t.test('ANALYZE refuses Editor transaction/autocommit-off and read-only profile without committing or resetting them', async () => {
      await analyzer.runQueryScript('START TRANSACTION', 5000, true);
      await assert.rejects(analyzer.analyzeQuery('SELECT * FROM sample'), error => error.code === 'ANALYZE_TRANSACTION_ACTIVE');
      assert.equal(analyzer.inTransaction, true);
      await analyzer.runQueryScript('ROLLBACK', 5000, true);
      await analyzer.runQueryScript('SET autocommit=0', 5000, true);
      await assert.rejects(analyzer.analyzeQuery('SELECT * FROM sample'), error => error.code === 'ANALYZE_TRANSACTION_ACTIVE');
      assert.equal(analyzer.autocommit, false);
      await analyzer.runQueryScript('SET autocommit=1', 5000, true);
      await assert.rejects(reader.analyzeQuery('SELECT * FROM sample'), error => error.code === 'CONNECTION_READ_ONLY');
      assert.deepEqual((await admin.query(`SELECT * FROM \`${database}\`.sample ORDER BY id`))[0], snapshot);
    });
    let task = 0;
    // Main IPC binding is tested separately. This DB fixture supplies the same
    // observation shape using its own actual connection identity and SQL hash.
    const observe = async () => {
      const sql = 'EXPLAIN SELECT label FROM sample ORDER BY label', taskId = `fixture-${++task}`;
      const result = await reader.runQueryScript(sql); result.isExplain = true;
      result.explainContext = { version: 1, profileId: 'fixture', sessionId: String(before[0].id), database, taskId,
        sqlHash: crypto.createHash('sha256').update(sql).digest('hex'), checkedAt: new Date().toISOString() };
      const observation = captureExplain(result, { profileId: 'fixture', database, taskId, explainFormat: 'DEFAULT' });
      assert.ok(observation); return observation;
    };
    await t.test('same SQL plans compare unchanged, adding a covering index changes observed plan', async () => {
      const first = await observe(), second = await observe();
      assert.equal(compareExplain(first, second).status, 'unchanged');
      await admin.query(`CREATE INDEX label_cover ON \`${database}\`.sample(label)`);
      const changed = await observe(); assert.equal(compareExplain(second, changed).status, 'changed');
      assert.ok(changed.rows.some(row => row.key === 'label_cover'));
    });
    await t.test('unchanged plan does not prove schema unchanged, while data and session settings stay intact', async () => {
      const first = await observe();
      await admin.query(`CREATE TABLE \`${database}\`.unrelated (id INT PRIMARY KEY) ENGINE=InnoDB`);
      assert.equal(compareExplain(first, await observe()).status, 'unchanged');
      assert.deepEqual((await settings()).rows, before);
      assert.deepEqual((await admin.query(`SELECT * FROM \`${database}\`.sample ORDER BY id`))[0], snapshot);
    });
    await t.test('opt-in settings observations compare actual server settings and preserve data/session/transaction', async () => {
      const originalZone = (await reader.raw('SELECT @@SESSION.time_zone AS value')).rows[0].value;
      const zone = originalZone === '+07:00' ? '+08:00' : '+07:00';
      const scoped = async () => {
        const taskId = `settings-${++task}`, sql = 'EXPLAIN SELECT * FROM sample WHERE id=1';
        const result = await reader.runQueryScript(sql, 5000, false, taskId, { explainSettings: true });
        assert.equal(result.explainSettings.status, 'observed'); assert.equal(result.explainSettings.fields.length, 11);
        result.isExplain = true;
        result.explainContext = { version: 1, profileId: 'fixture', sessionId: String(before[0].id), database, taskId,
          sqlHash: crypto.createHash('sha256').update(sql).digest('hex'), checkedAt: new Date().toISOString(), settings: result.explainSettings };
        return captureExplain(result, { profileId: 'fixture', database, taskId, explainSettings: true });
      };
      try {
        const first = await scoped(); assert.ok(first);
        assert.equal(compareExplain(first, await scoped()).status, 'unchanged');
        await reader.raw('SET SESSION time_zone=?', [zone]);
        const changed = await scoped(), comparison = compareExplain(first, changed);
        assert.equal(comparison.status, 'settings-changed'); assert.deepEqual(comparison.changedFields, ['time_zone']);
        assert.equal(comparison.changes, undefined); assert.equal(compareExplain(changed, await scoped()).status, 'unchanged');
        const selectLimit = (await reader.raw('SELECT CAST(@@SESSION.sql_select_limit AS CHAR) AS value LIMIT 1')).rows[0].value;
        try {
          await reader.raw('SET SESSION sql_select_limit=0');
          const limited = await scoped(); assert.ok(limited);
          assert.ok(compareExplain(changed, limited).changedFields.includes('sql_select_limit'));
        } finally { await reader.raw('SET SESSION sql_select_limit=CAST(? AS UNSIGNED)', [selectLimit]); }
        const resultsCharset = (await reader.raw('SELECT @@SESSION.character_set_results AS value LIMIT 1')).rows[0].value;
        try {
          await reader.raw("SET SESSION character_set_results='binary'");
          const binary = await reader.runQueryScript('EXPLAIN SELECT * FROM sample', 5000, false, 'binary-context', { explainSettings: true });
          assert.equal(binary.explainSettings.status, 'unknown'); assert.equal(binary.explainSettings.fields, undefined);
        } finally { await reader.raw('SET SESSION character_set_results=?', [resultsCharset]); }
        await reader.raw('START TRANSACTION'); assert.equal(reader.inTransaction, true);
        await scoped(); assert.equal(reader.inTransaction, true);
        assert.equal(String((await reader.raw('SELECT @@SESSION.autocommit AS value')).rows[0].value), '1');
      } finally {
        await reader.raw('ROLLBACK'); await reader.raw('SET SESSION time_zone=?', [originalZone]);
      }
      assert.deepEqual((await settings()).rows, before);
      assert.deepEqual((await admin.query(`SELECT * FROM \`${database}\`.sample ORDER BY id`))[0], snapshot);
    });
    await t.test('single-table SHOW CREATE observations detect definition drift, temporary shadows and unsupported sources without changing fixture data', async () => {
      const sql = 'EXPLAIN SELECT id FROM sample WHERE id=1';
      const scoped = async (source = sql) => {
        const taskId = `schema-${++task}`;
        const result = await reader.runQueryScript(source, 5000, false, taskId, { explainSchema: true }); result.isExplain = true;
        result.explainContext = { version: 1, profileId: 'fixture', sessionId: String(before[0].id), database, taskId,
          sqlHash: crypto.createHash('sha256').update(source).digest('hex'), checkedAt: new Date().toISOString(), schema: result.explainSchema };
        return { result, observation: captureExplain(result, { profileId: 'fixture', database, taskId, explainSchema: true }) };
      };
      const first = await scoped(); assert.ok(first.observation);
      assert.equal(compareExplain(first.observation, (await scoped()).observation).status, 'unchanged');
      await admin.query(`ALTER TABLE \`${database}\`.sample ADD COLUMN schema_note INT NULL`);
      const changed = await scoped(); assert.equal(compareExplain(first.observation, changed.observation).status, 'schema-changed');
      assert.equal(compareExplain(changed.observation, (await scoped()).observation).status, 'unchanged');
      await admin.query(`ALTER TABLE \`${database}\`.sample DROP COLUMN schema_note`);
      await admin.query(`CREATE VIEW \`${database}\`.sample_view AS SELECT id FROM \`${database}\`.sample`);
      for (const source of ['EXPLAIN SELECT a.id FROM sample a JOIN sample b ON a.id=b.id',
        'EXPLAIN WITH x AS (SELECT id FROM sample) SELECT * FROM x', 'EXPLAIN SELECT * FROM sample_view']) {
        const unknown = await scoped(source); assert.equal(unknown.result.explainSchema.status, 'unknown'); assert.equal(unknown.observation, null);
      }
      const permanent = await scoped();
      try {
        await reader.raw('CREATE TEMPORARY TABLE sample(id INT PRIMARY KEY, temporary_column INT)');
        const temporary = await scoped(); assert.ok(temporary.observation);
        assert.equal(compareExplain(permanent.observation, temporary.observation).status, 'schema-changed');
      } finally { await reader.raw('DROP TEMPORARY TABLE IF EXISTS sample'); }
      const quotedName = 'a.b`c', quoted = '`a.b``c`';
      await admin.query(`CREATE TABLE \`${database}\`.${quoted}(id INT PRIMARY KEY) ENGINE=InnoDB`);
      const escaped = await scoped(`EXPLAIN SELECT * FROM ${quoted}`); assert.equal(escaped.result.explainSchema.table, quotedName);
      assert.ok(escaped.observation); assert.doesNotMatch(JSON.stringify(escaped.result.explainSchema), /CREATE TABLE|DEFAULT/);
      const originalRun = reader.runQuery;
      try {
        reader.runQuery = async function (...args) {
          const result = await originalRun.apply(this, args);
          if (args[0] === sql) await admin.query(`ALTER TABLE \`${database}\`.sample ADD COLUMN drift_note INT NULL`);
          return result;
        };
        const during = await scoped(); assert.equal(during.result.explainSchema.status, 'changed-during-run');
        assert.equal(during.observation, null); assert.ok(during.result.rows.length);
      } finally { reader.runQuery = originalRun; }
      await admin.query(`ALTER TABLE \`${database}\`.sample DROP COLUMN drift_note`);
      await reader.raw('START TRANSACTION'); await reader.raw('SAVEPOINT schema_context_guard');
      try {
        assert.ok((await scoped()).observation);
        const combined = await reader.runQueryScript(sql, 5000, false, 'combined-context', { explainSettings: true, explainSchema: true });
        assert.equal(combined.explainSettings.status, 'observed'); assert.equal(combined.explainSchema.status, 'observed');
        await reader.raw('ROLLBACK TO SAVEPOINT schema_context_guard'); assert.equal(reader.inTransaction, true);
      } finally { await reader.raw('ROLLBACK'); }
      assert.deepEqual((await settings()).rows, before);
      assert.deepEqual((await admin.query(`SELECT * FROM \`${database}\`.sample ORDER BY id`))[0], snapshot);
    });
  } finally {
    await reader.close();
    await analyzer.close();
    try { if (created) await admin.query(`DROP DATABASE \`${database}\``); } finally { await admin.end(); }
  }
});
