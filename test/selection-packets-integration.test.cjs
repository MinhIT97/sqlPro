'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSession } = require('../electron/database.cjs');
const { saveBackupFile } = require('../electron/backup-file.cjs');
const { RestoreSelectionInventory, previewRestoreSelection } = require('../electron/restore-selection.cjs');
const { assertStatementScope } = require('../electron/sql-script.cjs');
const { collectSelectionTargetFacts, buildSelectionTargetPreview } = require('../electron/restore-selection-target.cjs');
const { buildSelectionDraft } = require('../electron/restore-selection-plan.cjs');

// Dedicated disposable server started with --max-allowed-packet=32768 only.
// This fixture never changes global/session limits or uses the app database.
test('packet preview integration: observed SQL bytes agree with a disposable low-packet server', {
  skip: !process.env.SQLPRO_TEST_PACKET_PORT, timeout: 30000
}, async t => {
  const database = `sqlpro_packets_${Date.now()}_${process.pid}`;
  const profile = { host: '127.0.0.1', port: Number(process.env.SQLPRO_TEST_PACKET_PORT), user: 'root', password: '', database,
    ssl: { enabled: false }, ssh: { enabled: false } };
  const admin = await mysql.createConnection({ host: profile.host, port: profile.port, user: profile.user });
  const reader = new DatabaseSession(profile), editor = new DatabaseSession(profile);
  let created = false;
  try {
    const limit = Number((await admin.query('SELECT @@SESSION.max_allowed_packet AS n'))[0][0].n);
    assert.equal(limit, 32768, 'Use an isolated server started with --max-allowed-packet=32768');
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`); created = true; await admin.query(`USE \`${database}\``);
    const definition = 'CREATE TABLE `packet_sample` (`v` LONGTEXT CHARACTER SET utf8mb4) ENGINE=InnoDB';
    await admin.query(definition);
    await reader.connect(); await editor.connect(); await editor.runQuery('START TRANSACTION');
    const settings = session => session.raw('SELECT CONNECTION_ID() AS id, @@SESSION.max_allowed_packet AS size, @@SESSION.sql_mode AS mode, @@SESSION.autocommit AS auto');
    const beforeReader = (await settings(reader)).rows, beforeEditor = (await settings(editor)).rows;
    const queries = [], raw = reader.raw.bind(reader);
    reader.raw = async (sql, ...args) => { queries.push(sql); return raw(sql, ...args); };
    const small = `INSERT INTO packet_sample VALUES('${'a'.repeat(1024)}')`;
    const large = `INSERT INTO packet_sample VALUES('${'😀'.repeat(limit / 4 + 1024)}')`;
    assert.ok(large.length < limit); assert.ok(Buffer.byteLength(large) > limit);
    const inventory = statements => {
      const collector = new RestoreSelectionInventory(database);
      [definition, ...statements].forEach((sql, i) => collector.add(sql, assertStatementScope(sql, database), i + 1));
      return collector.finish();
    };
    const build = async (data, checksum = 'a'.repeat(64)) => {
      const source = previewRestoreSelection(data, { tables: ['packet_sample'], includeStructure: false });
      const facts = await collectSelectionTargetFacts(reader, database, () => {}, source.selectedTables);
      const targetIdentity = 'b'.repeat(64), targetReview = buildSelectionTargetPreview({ source, checksum, targetIdentity, facts });
      return { facts, targetReview, draft: buildSelectionDraft({ inventory: data, source, checksum, targetIdentity, targetReview }) };
    };

    await t.test('preview reads the session limit, counts UTF8 rather than code units and performs no writes', async () => {
      const result = await build(inventory([small, large]));
      assert.deepEqual(result.facts.errors, []); assert.equal(result.targetReview.packetSettings.maxAllowedPacket, limit);
      assert.deepEqual(result.draft.packetReview.rows.map(row => row.status), ['withinObserved', 'oversized']);
      assert.equal(result.draft.packetReview.rows[1].utf8Bytes, Buffer.byteLength(large));
      assert.equal(result.draft.steps[2].reason, 'PACKET_STATEMENT_TOO_LARGE'); assert.equal(result.draft.canExecute, false);
      assert.equal(JSON.stringify(result.draft).includes('😀'), false);
      assert.equal(Number((await admin.query('SELECT COUNT(*) AS n FROM packet_sample'))[0][0].n), 0);
    });

    await t.test('a separate disposable writer accepts the small statement and rejects the oversized one', async () => {
      const writer = await mysql.createConnection({ host: profile.host, port: profile.port, user: profile.user, database, charset: 'utf8mb4' });
      writer.on('error', () => {});
      try {
        await writer.query(small);
        await assert.rejects(writer.query(large), error => error.errno === 1153 || ['ER_NET_PACKET_TOO_LARGE', 'ECONNRESET', 'PROTOCOL_CONNECTION_LOST', 'EPIPE'].includes(error.code));
      } finally { writer.destroy(); }
      assert.equal(Number((await admin.query('SELECT COUNT(*) AS n FROM packet_sample'))[0][0].n), 1);
      assert.equal(editor.inTransaction, true);
    });

    await t.test('denied settings remain unknown and raw errors never enter the report', async () => {
      reader.raw = async (sql, ...args) => {
        if (sql.includes('@@SESSION.max_allowed_packet')) throw Object.assign(new Error('private-packet-metadata'), { code: 'ER_SPECIFIC_ACCESS_DENIED_ERROR' });
        return raw(sql, ...args);
      };
      try {
        const result = await build(inventory([large]));
        assert.equal(result.targetReview.packetSettings, null); assert.equal(result.draft.packetReview.rows[0].status, 'unknown');
        assert.equal(JSON.stringify(result).includes('private-packet-metadata'), false);
        assert.equal(result.draft.canExecute, false);
      } finally { reader.raw = async (sql, ...args) => { queries.push(sql); return raw(sql, ...args); }; }
    });

    await t.test('published source file and worker retain byte evidence without SQL or row contents in the draft', async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-packets-'));
      try {
        const filePath = path.join(directory, 'backup.sql');
        const saved = await saveBackupFile(filePath, async write => {
          await write(`${definition};\n`); await write(`${large};\n`);
          return { bytes: Buffer.byteLength(`${definition};\n${large};\n`), database, tables: 1, rows: 1, objects: 1 };
        });
        const scanner = new DatabaseSession({});
        const scanned = await scanner.scanRestoreInventoryInWorker({ filePath, database, selectionPreview: true, totalBytes: saved.bytes });
        const data = scanned.inventory.selectionPreview;
        assert.equal(data.statementLedger.entries[1].sizeReview.utf8Bytes, Buffer.byteLength(large));
        const result = await build(data, saved.checksum);
        assert.equal(result.draft.packetReview.rows[0].status, 'oversized');
        assert.equal(JSON.stringify(result.draft).includes('😀'), false);
        assert.equal(Number((await admin.query('SELECT COUNT(*) AS n FROM packet_sample'))[0][0].n), 1);
      } finally { await fs.rm(directory, { recursive: true, force: true }); }
    });

    await t.test('preview uses only SELECT and leaves reader/editor settings and the editor transaction intact', async () => {
      assert.ok(queries.length > 0); assert.ok(queries.every(sql => /^SELECT /.test(sql)));
      assert.deepEqual((await settings(reader)).rows, beforeReader); assert.deepEqual((await settings(editor)).rows, beforeEditor);
      assert.equal(editor.inTransaction, true); await editor.runQuery('ROLLBACK');
    });
  } finally {
    await Promise.allSettled([reader.close(), editor.close()]);
    try { if (created) await admin.query(`DROP DATABASE \`${database}\``); } finally { await admin.end(); }
  }
});
