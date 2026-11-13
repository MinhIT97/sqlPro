'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RestoreSelectionInventory, previewRestoreSelection } = require('../electron/restore-selection.cjs');
const { SqlScriptParser, assertStatementScope } = require('../electron/sql-script.cjs');
const { normalizeColumnType, compareSelectionColumns } = require('../electron/restore-selection-columns.cjs');

function inventory(sql) {
  const parser = new SqlScriptParser(), collector = new RestoreSelectionInventory('demo');
  for (const [i, statement] of [...parser.push(sql), ...parser.end()].entries()) collector.add(statement, assertStatementScope(statement, 'demo', i + 1), i + 1);
  return collector.finish();
}
function row(sql, flags = {}) {
  return previewRestoreSelection(inventory(sql), { tables: ['items'], ...flags }).rows[0];
}
const ddl = "CREATE TABLE items (`id` bigint unsigned NOT NULL AUTO_INCREMENT, `name` varchar(40) NOT NULL DEFAULT 'private-default', amount decimal(20,6) DEFAULT NULL, `calc` int GENERATED ALWAYS AS ((id + 1)) STORED, PRIMARY KEY (`id`), KEY idx (`name`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;";

test('type normalization preserves UNSIGNED/ZEROFILL separators after display width or precision', () => {
  for (const [raw, expected] of [['TINYINT(3) UNSIGNED', 'tinyint(3) unsigned'], ['int ( 11 ) unsigned zerofill', 'int(11) unsigned zerofill'],
    ['decimal ( 20 , 6 ) unsigned', 'decimal(20,6) unsigned'], ['BIGINT(20)', 'bigint(20)']]) {
    const result = normalizeColumnType(raw); assert.equal(result.typeKnown, true); assert.equal(result.type, expected);
  }
  assert.equal(normalizeColumnType('int(11) unsigned; SELECT 1').typeKnown, false);
});

test('source inventory splits nested definitions and extracts PK/null/type/generated/default/charset without literals', () => {
  const source = row(ddl);
  const schema = source.columnSchema;
  assert.equal(schema.complete, true); assert.equal(schema.columns.length, 4);
  assert.deepEqual(schema.columns.map(column => column.type), ['bigint unsigned', 'varchar(40)', 'decimal(20,6)', 'int']);
  assert.equal(schema.columns[0].nullable, false); assert.equal(schema.columns[0].autoIncrement, true);
  assert.equal(schema.columns[1].hasDefault, true); assert.equal(schema.columns[1].charset, 'utf8mb4'); assert.equal(schema.columns[1].collation, 'utf8mb4_bin');
  assert.equal(schema.columns[2].hasDefault, false); assert.equal(schema.columns[3].generated, true); assert.equal(schema.columns[3].generatedKind, 'stored');
  assert.equal(JSON.stringify(source).includes('private-default'), false);
  assert.equal(JSON.stringify(source).includes('id + 1'), false);
  const implicit = row('CREATE TABLE items (`id` int, CONSTRAINT pk PRIMARY KEY (`id`));');
  assert.equal(implicit.columnSchema.columns[0].nullable, false);
});

test('exact quoted column identities and commas inside strings or expressions do not become extra columns', () => {
  const source = row("CREATE TABLE items (`a,``b` varchar(50) COMMENT 'x,y', `AS` int DEFAULT 1, `calc` int AS (IF(`AS` > 0, 1, 2)) VIRTUAL);");
  assert.deepEqual(source.columnSchema.columns.map(column => column.name), ['a,`b', 'AS', 'calc']);
  assert.equal(source.columnSchema.columns[1].generated, false); assert.equal(source.columnSchema.columns[2].generatedKind, 'virtual');
});

test('INSERT mapping distinguishes explicit, positional and mixed scope, keeps names only and bounds repeated lists', () => {
  const source = row(ddl + " INSERT INTO items (`id`, `name`) VALUES (1,'secret-row'); INSERT INTO items (`id`, `name`) VALUES (2,'secret-row2');");
  assert.equal(source.insertColumnMode, 'explicit'); assert.deepEqual(source.insertColumnSets, [['id', 'name']]);
  assert.equal(JSON.stringify(source).includes('secret-row'), false);
  assert.equal(row(`${ddl} INSERT INTO items VALUES (1,'x',1,DEFAULT);`).insertColumnMode, 'positional');
  assert.equal(row(`${ddl} INSERT INTO items(id) VALUES(1); INSERT INTO items VALUES(2,'x',1,DEFAULT);`).insertColumnMode, 'mixed');
  const many = Array.from({ length: 10 }, (_, i) => `INSERT INTO items(c${i}) VALUES(1);`).join('');
  const limited = row(`${ddl}${many}`);
  assert.ok(['unknown', 'mixed'].includes(limited.insertColumnMode)); assert.equal(limited.insertColumnSets.length, 8);
});

test('comparison reports differing type/nullability/auto increment/generated/default and charset', () => {
  const source = row(ddl);
  const target = structuredClone(source.columnSchema.columns);
  target[0].type = 'int'; target[0].autoIncrement = false; target[0].nullable = true;
  target[1].charset = 'latin1'; target[1].collation = 'latin1_bin'; target[1].hasDefault = false;
  target[3].generatedKind = 'virtual';
  const comparison = compareSelectionColumns(source, target);
  for (const code of ['COLUMN_TYPE_DIFFERS', 'COLUMN_AUTO_INCREMENT_DIFFERS', 'COLUMN_NULLABILITY_DIFFERS', 'COLUMN_CHARSET_DIFFERS', 'COLUMN_COLLATION_DIFFERS', 'COLUMN_DEFAULT_PRESENCE_DIFFERS', 'COLUMN_GENERATED_STORAGE_DIFFERS', 'GENERATED_EXPRESSION_NOT_COMPARED', 'DEFAULT_VALUE_NOT_COMPARED']) assert.ok(comparison.findings.some(item => item.code === code), code);
  assert.equal(comparison.status, 'partial');
});

test('positional INSERT checks visible order while explicit INSERT does not infer order loss', () => {
  const create = 'CREATE TABLE items (id int, value int);';
  const positional = row(`${create}INSERT INTO items VALUES(1,2);`);
  const reversed = [...positional.columnSchema.columns].reverse().map((column, i) => ({ ...column, ordinal: i + 1 }));
  assert.ok(compareSelectionColumns(positional, reversed).findings.some(item => item.code === 'POSITIONAL_COLUMN_ORDER_OR_COUNT_DIFFERS'));
  const explicit = row(`${create}INSERT INTO items(id,value) VALUES(1,2);`);
  assert.equal(compareSelectionColumns(explicit, reversed).findings.some(item => item.code === 'POSITIONAL_COLUMN_ORDER_OR_COUNT_DIFFERS'), false);
});

test('explicit INSERT identifies required target columns omitted from each supplied set', () => {
  const source = row('CREATE TABLE items(id int, value int);INSERT INTO items(id) VALUES(1);');
  const target = structuredClone(source.columnSchema.columns);
  target[1].nullable = false;
  target.push({ ...target[1], name: 'required_extra', ordinal: 3 });
  const result = compareSelectionColumns(source, target);
  assert.ok(result.findings.some(item => item.code === 'REQUIRED_TARGET_COLUMN_NOT_SUPPLIED' && item.column === 'value'));
  assert.ok(result.findings.some(item => item.code === 'REQUIRED_TARGET_COLUMN_NOT_SUPPLIED' && item.column === 'required_extra'));
  assert.ok(result.findings.some(item => item.code === 'EXTRA_TARGET_COLUMN'));
  target[1].hasDefault = true; target[2].generated = true;
  assert.equal(compareSelectionColumns(source, target).findings.some(item => item.code === 'REQUIRED_TARGET_COLUMN_NOT_SUPPLIED'), false);
});

test('unknown columns, ENUM/SET, quota, incomplete metadata and source without CREATE stay partial', () => {
  const unknown = row("CREATE TABLE items(kind enum('private-label','other'), payload geometry);");
  assert.equal(unknown.columnSchema.columns[0].typeKnown, false);
  assert.equal(JSON.stringify(unknown).includes('private-label'), false);
  assert.equal(normalizeColumnType("enum('private-label')").type, 'enum(…)');
  assert.notEqual(normalizeColumnType("enum('A')").typeFingerprint, normalizeColumnType("enum('a')").typeFingerprint);
  assert.ok(compareSelectionColumns(unknown, unknown.columnSchema.columns).findings.some(item => item.code === 'COLUMN_TYPE_NOT_ANALYZED'));
  const limited = row(`CREATE TABLE items(${Array.from({ length: 257 }, (_, i) => `c${i} int`).join(',')});`);
  assert.equal(limited.columnSchema.complete, false); assert.equal(limited.columnSchema.columns.length, 256);
  const result = compareSelectionColumns(limited, [], { metadataComplete: false, limit: 2, findingLimit: 1 });
  assert.equal(result.fields.length, 2); assert.equal(result.findings.length, 1); assert.equal(result.truncated, true);
  const dataOnly = row('INSERT INTO items(id) VALUES(1);');
  assert.ok(compareSelectionColumns(dataOnly, []).findings.some(item => item.code === 'SOURCE_COLUMNS_INCOMPLETE'));
});

test('charset override does not inherit an incompatible table collation; shorthand attributes stay unknown', () => {
  const source = row('CREATE TABLE items(a varchar(20) CHARACTER SET latin1, b varchar(20) COLLATE latin1_bin, c varchar(20) BINARY) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;');
  assert.equal(source.columnSchema.columns[0].charset, 'latin1'); assert.equal(source.columnSchema.columns[0].collation, null);
  assert.equal(source.columnSchema.columns[1].charset, null); assert.equal(source.columnSchema.columns[1].collation, 'latin1_bin');
  assert.equal(source.columnSchema.columns[2].attributesKnown, false);
  assert.ok(compareSelectionColumns(source, source.columnSchema.columns).findings.some(item => item.code === 'COLUMN_ATTRIBUTES_NOT_ANALYZED'));
});

test('column ON UPDATE and inline constraints are explicitly outside analyzed attributes', () => {
  const source = row('CREATE TABLE items(id int CHECK (id > 0), updated_at timestamp NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP, parent_id int REFERENCES parent(id));');
  assert.ok(source.columnSchema.columns.every(column => column.attributesKnown === false));
  const target = structuredClone(source.columnSchema.columns);
  assert.ok(compareSelectionColumns(source, target).findings.some(item => item.code === 'COLUMN_ATTRIBUTES_NOT_ANALYZED'));
});
