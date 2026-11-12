'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { RestoreSelectionInventory, previewRestoreSelection } = require('../electron/restore-selection.cjs');
const { SqlScriptParser, assertStatementScope, skipReason } = require('../electron/sql-script.cjs');
const { DatabaseSession } = require('../electron/database.cjs');

function inventory(sql, database = 'demo') {
  const parser = new SqlScriptParser();
  const collector = new RestoreSelectionInventory(database);
  let number = 0;
  for (const statement of [...parser.push(sql), ...parser.end()]) {
    number++;
    if (!skipReason(statement)) collector.add(statement, assertStatementScope(statement, database, number), number);
  }
  return collector.finish();
}
const source = 'CREATE TABLE `parent` (`id` int PRIMARY KEY);\nCREATE TABLE `child` (`id` int, `parent_id` int, FOREIGN KEY (`parent_id`) REFERENCES `parent` (`id`));\nINSERT INTO `parent` VALUES (1);\nINSERT INTO `child` VALUES (2,1);';

test('source preview selects exactly requested statements and reports FK dependencies without execution authority', () => {
  const data = inventory(`DROP TABLE IF EXISTS parent;\n${source}`);
  const before = structuredClone(data);
  const partial = previewRestoreSelection(data, { tables: ['child'] });
  assert.equal(partial.canExecute, false); assert.equal(partial.targetReviewed, false);
  assert.deepEqual(partial.totals, { createStatements: 1, dataStatements: 1, dropStatements: 0 });
  assert.equal(partial.excludedTables, 1);
  assert.ok(partial.findings.some(item => item.code === 'MISSING_DEPENDENCY' && item.dependency === 'parent'));
  const complete = previewRestoreSelection(data, { tables: ['child', 'parent'] });
  assert.deepEqual(complete.order, ['parent', 'child']);
  assert.equal(complete.totals.dropStatements, 1); assert.equal(complete.findings.length, 0);
  const structure = previewRestoreSelection(data, { tables: ['parent'], includeData: false });
  assert.equal(structure.totals.dataStatements, 0);
  const onlyData = previewRestoreSelection(data, { tables: ['child'], includeStructure: false });
  assert.equal(onlyData.totals.createStatements, 0); assert.equal(onlyData.totals.dropStatements, 0);
  assert.ok(onlyData.findings.some(item => item.code === 'TARGET_STRUCTURE_NOT_CHECKED'));
  assert.deepEqual(data, before);
});

test('quoted Unicode, dots, whitespace, escaped backticks and keyword-like names retain exact identity', () => {
  const data = inventory('CREATE TABLE ` cha.``mẹ ` (`references` int PRIMARY KEY, `SELECT` varchar(80) COMMENT \'REFERENCES fake(id)\');\nCREATE TABLE `con` (`id` int, FOREIGN KEY (`id`) REFERENCES ` cha.``mẹ ` (`references`));\nINSERT INTO ` cha.``mẹ ` VALUES (1,\'DROP TABLE con; REFERENCES fake(id)\');\nDROP TABLE ` cha.``mẹ `;');
  const parent = data.tables.find(table => table.name === ' cha.`mẹ ');
  assert.equal(parent.createStatements, 1); assert.equal(parent.dataStatements, 1); assert.equal(parent.dropStatements, 1);
  assert.deepEqual(parent.dependencies, []);
  const plan = previewRestoreSelection(data, { tables: ['con', ' cha.`mẹ '] });
  assert.deepEqual(plan.order, [' cha.`mẹ ', 'con']);
  assert.deepEqual(plan.findings, []);
});

test('strings/comments and quoted identifiers never invent references; executable comments are flagged unknown', () => {
  const data = inventory("CREATE TABLE parent (id int PRIMARY KEY); CREATE TABLE child (id int /* REFERENCES absent(id) */, `REFERENCES` varchar(200) DEFAULT 'REFERENCES fake(id)', FOREIGN KEY (id) REFERENCES demo.parent(id));");
  assert.deepEqual(data.tables[1].dependencies, [{ schema: 'demo', table: 'parent' }]);
  const collector = new RestoreSelectionInventory('demo');
  const sql = 'CREATE TABLE t (id int) /*!50100 TABLESPACE ts */';
  collector.add(sql, { command: 'CREATE', refs: [{ table: 't' }], sql }, 1);
  assert.equal(collector.finish().findings[0].code, 'EXECUTABLE_COMMENT');
});

test('external/missing FK, case ambiguity, cycles and downstream blockers are visible', () => {
  const data = inventory('CREATE TABLE a (id int, FOREIGN KEY(id) REFERENCES b(id)); CREATE TABLE b (id int, FOREIGN KEY(id) REFERENCES a(id)); CREATE TABLE c (id int, FOREIGN KEY(id) REFERENCES a(id)); CREATE TABLE orphan (id int, FOREIGN KEY(id) REFERENCES absent(id)); CREATE TABLE A (id int);');
  const plan = previewRestoreSelection(data, { tables: ['a', 'b', 'c', 'orphan'] });
  assert.deepEqual(plan.unresolvedOrder.sort(), ['a', 'b', 'c']);
  assert.ok(plan.findings.some(item => item.code === 'CASE_AMBIGUITY'));
  assert.ok(plan.findings.some(item => item.code === 'DEPENDENCY_NOT_IN_BACKUP'));
  assert.ok(plan.findings.some(item => item.code === 'FK_CYCLE_OR_BLOCKED'));
  const external = inventory('CREATE TABLE t (id int, FOREIGN KEY(id) REFERENCES other.parent(id));');
  assert.ok(previewRestoreSelection(external, { tables: ['t'] }).findings.some(item => item.code === 'EXTERNAL_DEPENDENCY'));
});

test('non-table definitions, unsupported operations and data-only backups report limitations', () => {
  const data = inventory("CREATE TABLE t (id int); CREATE VIEW v AS SELECT * FROM t; UPDATE t SET id=1; ALTER TABLE t ADD x int; DROP TABLE t, x; INSERT INTO only_data VALUES (1);");
  assert.ok(data.findings.some(item => item.code === 'NON_TABLE_DEFINITION'));
  assert.ok(data.findings.some(item => item.code === 'UNSUPPORTED_STATEMENT'));
  assert.equal(data.opaqueObjects.length, 1);
  assert.ok(previewRestoreSelection(data, { tables: ['only_data'] }).findings.some(item => item.code === 'STRUCTURE_UNAVAILABLE'));
  const conditional = inventory('CREATE TABLE IF NOT EXISTS t (id int); CREATE TABLE t (id int);');
  assert.ok(conditional.findings.some(item => item.code === 'CONDITIONAL_CREATE'));
  assert.ok(conditional.findings.some(item => item.code === 'REPEATED_CREATE'));
  const modeAndSelect = inventory("SET SQL_MODE='ANSI_QUOTES'; INSERT INTO t SELECT * FROM source_table;");
  assert.ok(modeAndSelect.findings.some(item => item.code === 'SQL_MODE_CONTEXT'));
  assert.ok(modeAndSelect.findings.some(item => item.code === 'DATA_DEPENDENCIES_NOT_ANALYZED'));
});

test('inventory and definition quotas bound output; prototype-like names stay ordinary keys', () => {
  const data = inventory('CREATE TABLE `__proto__` (id int); CREATE TABLE `constructor` (id int);');
  assert.deepEqual(previewRestoreSelection(data, { tables: ['__proto__', 'constructor'] }).order, ['__proto__', 'constructor']);
  const collector = new RestoreSelectionInventory('demo');
  for (let i = 0; i < 1001; i++) { const sql = `CREATE TABLE t${i} (id int)`; collector.add(sql, assertStatementScope(sql, 'demo', i), i); }
  const limited = collector.finish();
  assert.equal(limited.tables.length, 1000); assert.equal(limited.truncated, true);
  assert.ok(previewRestoreSelection(limited, { tables: ['t0'] }).findings.some(item => item.code === 'INVENTORY_TRUNCATED'));
  const huge = `CREATE TABLE huge (id int COMMENT '${'x'.repeat(2 * 1024 * 1024)}')`;
  collector.add(huge, { command: 'CREATE', refs: [{ table: 'huge' }] }, 1002);
  assert.ok(collector.finish().findings.some(item => item.code === 'DEFINITION_LIMIT'));
});

test('invalid selections are rejected instead of broadening scope', () => {
  const data = inventory(source);
  for (const selection of [{ tables: [] }, { tables: ['missing'] }, { tables: ['child', 'child'] }, { tables: [1] },
    { tables: ['child'], includeStructure: false, includeData: false }, { tables: ['child'], includeData: 'yes' }]) assert.throws(() => previewRestoreSelection(data, selection));
  assert.throws(() => previewRestoreSelection(null, { tables: ['child'] }));
});

test('worker source preview preserves byte hash and makes no database calls, normal restore scan remains unchanged', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-selection-worker-'));
  const filePath = path.join(directory, 'backup.sql');
  await fs.writeFile(filePath, source);
  try {
    const session = new DatabaseSession({});
    session.raw = async () => { throw new Error('source preview must not query database'); };
    const worker = await session.scanRestoreInventoryInWorker({ filePath, database: 'demo', totalBytes: Buffer.byteLength(source), selectionPreview: true });
    assert.equal(worker.checksum, crypto.createHash('sha256').update(source).digest('hex'));
    assert.deepEqual(previewRestoreSelection(worker.inventory.selectionPreview, { tables: ['child', 'parent'] }).order, ['parent', 'child']);
    const normal = await session.scanRestoreInventory({ filePath, database: 'demo', readChunkBytes: 1 });
    assert.equal(normal.inventory.selectionPreview, undefined);
    assert.equal(normal.checksum, worker.checksum);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
