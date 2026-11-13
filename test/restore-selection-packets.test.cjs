'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePacketSettings, projectPacketSettings, statementSizeReview, projectStatementSize, reviewSelectionPackets } = require('../electron/restore-selection-packets.cjs');
const { RestoreSelectionInventory, previewRestoreSelection } = require('../electron/restore-selection.cjs');
const { assertStatementScope } = require('../electron/sql-script.cjs');
const { buildSelectionDraft } = require('../electron/restore-selection-plan.cjs');
const { collectSelectionTargetFacts, buildSelectionTargetPreview } = require('../electron/restore-selection-target.cjs');

const insert = size => {
  const start = "INSERT INTO items VALUES('", end = "')";
  return start + 'x'.repeat(size - start.length - end.length) + end;
};
function fixture(statements = [insert(1025)]) {
  const collector = new RestoreSelectionInventory('demo');
  ['CREATE TABLE `items` (`v` VARCHAR(65535)) ENGINE=InnoDB', ...statements]
    .forEach((sql, i) => collector.add(sql, assertStatementScope(sql, 'demo'), i + 1));
  const inventory = collector.finish(), source = previewRestoreSelection(inventory, { tables: ['items'], includeStructure: false });
  const targetReview = { canExecute: false, snapshotId: 'a'.repeat(64), database: 'demo', lowerCaseTableNames: 0, findings: [],
    metadataStatus: { complete: true, databaseVisible: true }, packetSettings: { version: 1, maxAllowedPacket: 1024 },
    sessionSettings: { version: 1, charsetClient: 'utf8mb4' }, rows: [{ name: 'items', objects: [{ name: 'items', type: 'table' }], objectCount: 1 }] };
  return { inventory, ledger: inventory.statementLedger, source, targetReview, policyReview: { rows: [{ name: 'items', disposition: 'review' }] } };
}
const draft = input => buildSelectionDraft({ ...input, checksum: 'b'.repeat(64), targetIdentity: 'c'.repeat(64) });

test('settings and byte evidence are bounded projections; UTF8 bytes are distinct from UTF16 length', () => {
  assert.deepEqual(normalizePacketSettings('67108864'), { version: 1, maxAllowedPacket: 67108864 });
  for (const value of [null, true, {}, [], '1e4', '1024suffix', '1024\n', 1023, -1, 1.5, Infinity, 1073741825]) assert.equal(normalizePacketSettings(value), null);
  assert.equal(projectPacketSettings({ version: 0, maxAllowedPacket: 1024 }), null);
  assert.deepEqual(projectPacketSettings({ version: 1, maxAllowedPacket: 1024, secret: 'private' }), { version: 1, maxAllowedPacket: 1024 });
  const sql = "INSERT INTO items VALUES('é😀')", review = statementSizeReview(sql);
  assert.equal(review.utf8Bytes, Buffer.byteLength(sql)); assert.ok(review.utf8Bytes > sql.length);
  assert.deepEqual(projectStatementSize({ ...review, rawSql: 'private' }), review);
  for (const value of [null, { version: 0, utf8Bytes: 1 }, { version: 1, utf8Bytes: 0 }, { version: 1, utf8Bytes: 16777217 }]) assert.equal(projectStatementSize(value), null);
  assert.equal(statementSizeReview('x'.repeat(16777217)), null);
  assert.equal(statementSizeReview('😀'.repeat(5 * 1024 * 1024)), null);
});

test('only definite original-byte excess is oversized; a conservative protocol margin remains unknown', () => {
  const input = fixture([insert(1018), insert(1019), insert(1024), insert(1025)]), result = reviewSelectionPackets(input);
  assert.deepEqual(result.rows.map(row => row.status), ['withinObserved', 'unknown', 'unknown', 'oversized']);
  assert.equal(result.totals.excluded, 1); assert.equal(result.canExecute, false);
  assert.equal(result.rows[1].reason, 'PACKET_BOUNDARY_REQUIRES_REVIEW');
  assert.ok(result.requires.includes('PACKET_CLIENT_PROTOCOL_NOT_VALIDATED'));
  assert.ok(result.requires.includes('PACKET_STORAGE_ROW_LIMITS_NOT_REVIEWED'));
});

test('missing/old byte evidence, unknown encoding/limits, schema mapping and incomplete ledgers are not proofs', () => {
  for (const [change, reason] of [
    [r => { delete r.ledger.entries[1].sizeReview; }, 'PACKET_SIZE_NOT_REVIEWED'],
    [r => { r.ledger.entries[1].sizeReview.version = 0; }, 'PACKET_SIZE_NOT_REVIEWED'],
    [r => { r.targetReview.packetSettings = null; }, 'PACKET_LIMIT_NOT_OBSERVED'],
    [r => { r.targetReview.sessionSettings.charsetClient = 'latin1'; }, 'PACKET_ENCODING_NOT_REVIEWED'],
    [r => { r.ledger.entries[1].schema = 'elsewhere'; }, 'PACKET_SCHEMA_MAPPING_REQUIRED']
  ]) {
    const input = fixture(); change(input);
    const result = reviewSelectionPackets(input); assert.equal(result.rows[0].status, 'unknown'); assert.equal(result.rows[0].reason, reason);
  }
  const input = fixture(); input.ledger.truncated = true;
  assert.ok(reviewSelectionPackets(input).findings.includes('PACKET_LEDGER_INCOMPLETE'));
  input.ledger.entries[1].number = 5;
  assert.ok(reviewSelectionPackets(input).findings.includes('PACKET_LEDGER_INCOMPLETE'));
});

test('scope and skip policy exclude work but never override an explicit schema mismatch', () => {
  const input = fixture(); input.policyReview.rows[0].disposition = 'skip';
  assert.equal(reviewSelectionPackets(input).rows.length, 0); assert.equal(reviewSelectionPackets(input).totals.excluded, 2);
  input.ledger.entries[1].schema = 'other';
  assert.equal(reviewSelectionPackets(input).rows[0].reason, 'PACKET_SCHEMA_MAPPING_REQUIRED');
  input.source.includeData = false;
  assert.equal(reviewSelectionPackets(input).rows.length, 0);
});

test('draft binds/freezes sizes and server limits, blocks known excess and missing report detail, and retains no SQL', () => {
  const input = fixture(), first = draft(input);
  assert.equal(first.version, 22); assert.equal(first.canExecute, false);
  assert.equal(first.steps[1].reason, 'PACKET_STATEMENT_TOO_LARGE');
  assert.equal(Object.isFrozen(first.packetReview.rows[0]), true); assert.equal(Object.isFrozen(first.steps[1].sizeReview), true);
  input.targetReview.packetSettings.maxAllowedPacket = 2048;
  assert.notEqual(draft(input).planId, first.planId);
  assert.equal(draft(input).steps[1].decision, 'candidate');
  input.ledger.entries[1].sizeReview.rawSql = 'private-query';
  assert.equal(JSON.stringify(draft(input)).includes('private-query'), false);
  assert.equal(JSON.stringify(draft(input)).includes('x'.repeat(100)), false);
  const many = draft(fixture(Array(201).fill(insert(1025))));
  assert.equal(many.packetReview.rows.length, 200); assert.equal(many.packetReview.totals.oversized, 201);
  assert.equal(many.packetReview.truncated, true); assert.ok(many.totals.blocked >= 201);
  assert.ok(many.blockers.some(item => item.code === 'PACKET_REPORT_LIMIT'));
});

test('collector reads packet metadata in the existing SELECT and snapshot binds only projected settings', async () => {
  const input = fixture(), raw = { foreignKeyChecks: 1, autocommit: 1, sqlMode: 'STRICT_TRANS_TABLES',
    charsetClient: 'utf8mb4', charsetConnection: 'utf8mb4', charsetResults: 'utf8mb4', maxAllowedPacket: '32768', private: 'private-metadata' };
  const collect = row => collectSelectionTargetFacts({ raw: async (sql, params) => {
    assert.match(sql, /^SELECT /);
    if (sql.includes('AS foreignKeyChecks')) { assert.match(sql, /@@SESSION.max_allowed_packet/); assert.deepEqual(params, []); return { rows: [row] }; }
    return { rows: [] };
  } }, 'demo');
  const initial = await collect(raw);
  assert.deepEqual(initial.packetSettings, { version: 1, maxAllowedPacket: 32768 });
  assert.equal(JSON.stringify(initial).includes('private-'), false);
  const report = facts => buildSelectionTargetPreview({ source: input.source, checksum: 'a'.repeat(64), targetIdentity: 'b'.repeat(64), facts });
  assert.notEqual(report(initial).snapshotId, report(await collect({ ...raw, maxAllowedPacket: 65536 })).snapshotId);
  const invalid = await collect({ ...raw, maxAllowedPacket: 'private-invalid' });
  assert.equal(invalid.packetSettings, null); assert.ok(invalid.errors.some(error => error.section === 'packetSettings'));
  assert.equal(JSON.stringify(invalid).includes('private-'), false);
});
