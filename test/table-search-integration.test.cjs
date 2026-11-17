'use strict';

// Opt in against a disposable test server. Never use an existing application DB.
const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { DatabaseSession } = require('../electron/database.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Preferences = require('../table-preferences.js');
const { createTablePreferences } = require('../electron/table-preferences.cjs');

test('table search matches grid, explicit COUNT and streamed export on a real server', {
  skip: !process.env.SQLPRO_TABLE_SEARCH_PORT, timeout: 30000
}, async t => {
  const database = `sqlpro_search_${Date.now()}_${process.pid}`;
  assert.match(database, /^sqlpro_search_[0-9]+_[0-9]+$/);
  const profile = { host: '127.0.0.1', port: Number(process.env.SQLPRO_TABLE_SEARCH_PORT), user: 'root', password: '', database, ssl: { enabled: false }, ssh: { enabled: false } };
  const admin = await mysql.createConnection({ host: profile.host, port: profile.port, user: profile.user });
  const session = new DatabaseSession(profile);
  const marker = `table-search-${process.pid}`;
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  try {
    await admin.query(`USE \`${database}\``);
    await admin.query('CREATE TABLE __sqlpro_fixture_marker (marker VARCHAR(100))');
    await admin.query('INSERT INTO __sqlpro_fixture_marker VALUES (?)', [marker]);
    assert.equal((await admin.query('SELECT marker FROM __sqlpro_fixture_marker'))[0][0].marker, marker);
    await admin.query('CREATE TABLE samples (id INT PRIMARY KEY, label VARCHAR(200), note VARCHAR(30), amount DECIMAL(30,2), happened DATE, doubled INT GENERATED ALWAYS AS (id*2) VIRTUAL) ENGINE=InnoDB');
    const needle = "a%_==\\quote' Việt";
    const rows = [[1, needle, null], [2, "aXX_==\\quote' Việt", ''], [3, "A%_==\\quote' Việt suffix", 'NULL'], [4, `lead ${needle}`, 'x'], [5, 'plain', null], [6, null, ''], [7, '', null]];
    for (const [id, label, note] of rows) await admin.query('INSERT INTO samples (id,label,note,amount,happened) VALUES (?,?,?,?,?)', [id, label, note, '12345678901234567890.12', id <= 3 ? '2026-11-01' : '2026-11-17']);
    await admin.query('CREATE TABLE composite_samples (a INT, b INT, label VARCHAR(30), PRIMARY KEY(a,b)) ENGINE=InnoDB');
    for (const [a, b] of [[1, 1], [1, 2], [2, 1], [2, 2], [3, 1]]) await admin.query('INSERT INTO composite_samples VALUES (?,?,?)', [a, b, `${a}.${b}`]);
    await admin.query('CREATE TABLE list_variants (id INT PRIMARY KEY, ci VARCHAR(200) COLLATE utf8mb4_unicode_ci, cs VARCHAR(200) COLLATE utf8mb4_bin, happened TIMESTAMP NULL) ENGINE=InnoDB');
    await admin.query("SET SESSION time_zone = '+00:00'");
    for (const [id, text] of [[1, 'Alpha'], [2, 'alpha'], [3, needle], [4, null], [5, ''], [6, 'a,b'], [7, 'NULL']]) {
      await admin.query('INSERT INTO list_variants VALUES (?,?,?,?)', [id, text, text, '2026-11-17 00:00:00']);
    }
    await session.connect();
    await session.runQuery('START TRANSACTION');
    const before = (await session.raw('SELECT @@SESSION.sql_mode AS mode, @@SESSION.autocommit AS autocommit')).rows[0];
    const group = (op, ...items) => ({ version: 1, op, items });
    const rule = (column, operator, value) => ({ column, operator, value });
    const cases = [
      ['contains all literal characters', { searchMode: 'contains', searchColumn: 'label', search: needle }, [1, 3, 4]],
      ['prefix preserves text collation', { searchMode: 'prefix', searchColumn: 'label', search: needle }, [1, 3]],
      ['all-column prefix', { searchMode: 'prefix', search: 'a%' }, [1, 3]],
      ['exact text', { searchMode: 'exact', searchColumn: 'label', search: needle }, [1]],
      ['literal percent', { searchColumn: 'label', search: '%' }, [1, 3, 4]],
      ['literal underscore', { searchColumn: 'label', search: '_' }, [1, 2, 3, 4]],
      ['literal escape', { searchColumn: 'label', search: '=' }, [1, 2, 3, 4]],
      ['literal backslash', { searchColumn: 'label', search: '\\' }, [1, 2, 3, 4]],
      ['NULL differs from empty and NULL text', { searchMode: 'is-null', searchColumn: 'note', search: 'ignored' }, [1, 5, 7]],
      ['not NULL includes empty and NULL text', { searchMode: 'not-null', searchColumn: 'note' }, [2, 3, 4, 6]],
      ['NULL source column', { searchMode: 'is-null', searchColumn: 'label' }, [6]],
      ['exact DECIMAL retains digits', { searchMode: 'exact', searchColumn: 'amount', search: '12345678901234567890.12' }, [1, 2, 3, 4, 5, 6, 7]],
      ['nested OR inside AND', { filterTree: group('AND', rule('id', 'gte', '2'), { op: 'OR', items: [rule('note', 'eq', ''), { column: 'note', operator: 'is-null' }] }) }, [2, 5, 6, 7]],
      ['OR preserves grouping with quick search AND', { search: needle, searchColumn: 'label', filterTree: group('OR', rule('id', 'eq', '1'), rule('id', 'eq', '2')) }, [1]],
      ['NULL compared separately from empty text', { filterTree: group('OR', rule('label', 'eq', ''), { column: 'label', operator: 'is-null' }) }, [6, 7]],
      ['integer range and decimal comparison', { filterTree: group('AND', rule('id', 'between', ['2', '4']), rule('amount', 'eq', '12345678901234567890.12')) }, [2, 3, 4]],
      ['DATE range retains SQL calendar values', { filterTree: group('AND', rule('happened', 'between', ['2026-11-01', '2026-11-02'])) }, [1, 2, 3]],
      ['generated columns are readable predicates', { filterTree: group('AND', rule('doubled', 'gte', '10')) }, [5, 6, 7]],
      ['advanced prefix escapes wildcards', { filterTree: group('AND', rule('label', 'prefix', needle)) }, [1, 3]],
      ['IN text uses exact members and native collation', { filterTree: group('AND', rule('label', 'in', [needle, '', 'plain'])) }, [1, 5, 7]],
      ['NOT IN excludes NULL but retains empty text', { filterTree: group('AND', rule('note', 'not-in', ['NULL', 'x'])) }, [2, 6]],
      ['NULL text and empty values are separate list members', { filterTree: group('AND', rule('note', 'in', ['NULL', ''])) }, [2, 3, 6]],
      ['OR adds NULL explicitly to NOT IN', { filterTree: group('OR', rule('note', 'not-in', ['NULL', 'x']), { column: 'note', operator: 'is-null' }) }, [1, 2, 5, 6, 7]],
      ['typed integer and generated column lists', { filterTree: group('AND', rule('id', 'in', ['1', '3', '5']), rule('doubled', 'not-in', ['6'])) }, [1, 5]],
      ['typed decimal list retains long digits', { filterTree: group('AND', rule('amount', 'in', ['12345678901234567890.12', '0'])) }, [1, 2, 3, 4, 5, 6, 7]],
      ['typed date list combines with quick search', { search: needle, searchColumn: 'label', filterTree: group('AND', rule('happened', 'in', ['2026-11-17'])) }, [4]]
    ];
    for (const [label, search, expected] of cases) await t.test(label, async () => {
      const options = { database, table: 'samples', pageSize: 100, orderBy: 'id', ...search };
      assert.deepEqual((await session.tableData(options)).rows.map(row => row.id), expected);
      assert.equal((await session.countTableRows({ ...options, force: true })).total, expected.length);
      let json = '';
      const stats = await session.exportTableFile({ ...options, format: 'json', orderBy: { column: 'id', direction: 'ASC' } }, async chunk => { json += chunk; });
      assert.deepEqual(JSON.parse(json).map(row => row.id), expected); assert.equal(stats.rows, expected.length);
    });
    await t.test('non-key mixed sorts use OFFSET and export the same order with hidden PK retained in grid', async () => {
      const sorts = [{ column: 'happened', direction: 'ASC' }, { column: 'note', direction: 'DESC' }];
      const options = { database, table: 'samples', sorts, pageSize: 2 };
      const ids = [];
      for (let page = 1; page <= 4; page++) {
        const result = await session.tableData({ ...options, page });
        assert.equal(result.pagination, 'offset'); assert.equal(result.nextCursor, null);
        ids.push(...result.rows.map(row => row.id));
      }
      assert.deepEqual(ids, [3, 2, 1, 4, 6, 5, 7]);
      let output = '';
      await session.exportTableFile({ ...options, format: 'json' }, async chunk => { output += chunk; });
      assert.deepEqual(JSON.parse(output).map(row => row.id), ids);
      output = '';
      await session.exportTableFile({ ...options, columns: ['label'], format: 'json' }, async chunk => { output += chunk; });
      assert.ok(JSON.parse(output).every(row => Object.keys(row).join() === 'label'));
      assert.deepEqual(JSON.parse(output).map(row => row.label), ids.map(id => rows.find(row => row[0] === id)[1]));
    });
    await t.test('mixed-direction composite key pages forward/backward without duplicates and match export', async () => {
      for (const sorts of [
        [{ column: 'a', direction: 'ASC' }, { column: 'b', direction: 'DESC' }],
        [{ column: 'b', direction: 'DESC' }, { column: 'a', direction: 'ASC' }],
        [{ column: 'a', direction: 'DESC' }, { column: 'b', direction: 'ASC' }]
      ]) {
        const options = { database, table: 'composite_samples', sorts, pageSize: 2 };
        const first = await session.tableData(options);
        const second = await session.tableData({ ...options, page: 2, cursor: first.nextCursor });
        const third = await session.tableData({ ...options, page: 3, cursor: second.nextCursor });
        assert.equal(second.pagination, 'keyset'); assert.equal(third.pagination, 'keyset');
        const previous = await session.tableData({ ...options, page: 1, cursor: second.previousCursor });
        assert.equal(previous.pagination, 'keyset'); assert.deepEqual(previous.rows, first.rows);
        let output = '';
        await session.exportTableFile({ ...options, format: 'json' }, async chunk => { output += chunk; });
        const names = [...first.rows, ...second.rows, ...third.rows].map(row => row.label);
        assert.equal(new Set(names).size, 5); assert.deepEqual(names, JSON.parse(output).map(row => row.label));
        const stale = await session.tableData({ ...options, sorts: [], page: 2, cursor: first.nextCursor });
        assert.equal(stale.pagination, 'offset');
      }
    });
    await t.test('disk-restored filters and hidden-column sorts match grid, count and projected export', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-view-integration-'));
      try {
        const metadata = await session.listColumns(database, 'samples');
        const scope = { profileId: 'fixture', database, table: 'samples' };
        const view = Preferences.capture({ visibleColumns: ['id', 'label'], sorts: [{ column: 'note', direction: 'DESC' }, { column: 'id', direction: 'DESC' }],
          search: needle, searchColumn: 'label', searchMode: 'contains', filterTree: group('AND', rule('id', 'in', ['3', '4'])) }, metadata, true);
        createTablePreferences(root).save(scope, view);
        const restored = Preferences.normalize(createTablePreferences(root).read(scope).view, metadata);
        const options = { database, table: 'samples', pageSize: 100, sorts: restored.sorts, ...restored.filters };
        const data = await session.tableData(options);
        assert.deepEqual(data.rows.map(row => row.id), [4, 3]);
        assert.equal((await session.countTableRows(options)).total, 2);
        let output = '';
        await session.exportTableFile({ ...options, columns: restored.visibleColumns, format: 'json' }, async chunk => { output += chunk; });
        const rows = JSON.parse(output);
        assert.deepEqual(rows.map(row => row.id), [4, 3]);
        assert.deepEqual(Object.keys(rows[0]), ['id', 'label']);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
    await t.test('lists preserve native collations and timestamp timezone conversion across SQL mode variants', async () => {
      const original = (await session.raw('SELECT @@SESSION.sql_mode AS mode, @@SESSION.time_zone AS zone')).rows[0];
      try {
        for (const sqlMode of ['', 'STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES,ANSI_QUOTES']) {
          await session.raw('SET SESSION sql_mode = ?', [sqlMode]);
          for (const [column, operator, values, expected] of [
            ['ci', 'in', ['ALPHA'], [1, 2]], ['cs', 'in', ['Alpha'], [1]],
            ['cs', 'not-in', ['Alpha'], [2, 3, 5, 6, 7]], ['cs', 'in', [needle, '', 'a,b', 'NULL'], [3, 5, 6, 7]]
          ]) {
            const options = { database, table: 'list_variants', filterTree: group('AND', rule(column, operator, values)), pageSize: 100 };
            assert.deepEqual((await session.tableData(options)).rows.map(row => row.id), expected);
            assert.equal((await session.countTableRows({ ...options, force: true })).total, expected.length);
            let output = '';
            await session.exportTableFile({ ...options, sorts: [], format: 'json' }, async chunk => { output += chunk; });
            assert.deepEqual(JSON.parse(output).map(row => row.id), expected);
          }
        }
        for (const [zone, value] of [['+00:00', '2026-11-17 00:00:00'], ['+07:00', '2026-11-17 07:00:00']]) {
          await session.raw('SET SESSION time_zone = ?', [zone]);
          const options = { database, table: 'list_variants', filterTree: group('AND', rule('happened', 'in', [value])), pageSize: 100 };
          assert.equal((await session.tableData(options)).rows.length, 7);
          assert.equal((await session.countTableRows({ ...options, force: true })).total, 7);
          let output = '';
          await session.exportTableFile({ ...options, format: 'json' }, async chunk => { output += chunk; });
          assert.equal(JSON.parse(output).length, 7);
        }
      } finally {
        await session.raw('SET SESSION sql_mode = ?', [original.mode]);
        await session.raw('SET SESSION time_zone = ?', [original.zone]);
      }
      assert.equal((await session.raw('SELECT @@SESSION.time_zone AS zone')).rows[0].zone, original.zone);
    });
    assert.deepEqual((await session.raw('SELECT @@SESSION.sql_mode AS mode, @@SESSION.autocommit AS autocommit')).rows[0], before);
    assert.equal(session.inTransaction, true);
    assert.equal(Number((await session.raw('SELECT COUNT(*) AS n FROM samples')).rows[0].n), 7);
  } finally {
    try {
      if (session.connection) { try { await session.runQuery('ROLLBACK'); } finally { await session.close(); } }
    } finally {
      try {
        const markerRow = (await admin.query(`SELECT marker FROM \`${database}\`.__sqlpro_fixture_marker`))[0][0];
        assert.equal(markerRow.marker, marker);
        await admin.query(`DROP DATABASE \`${database}\``);
      } finally { await admin.end(); }
    }
  }
});
