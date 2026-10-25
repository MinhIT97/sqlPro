'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const values = require('../row-values.js');
const fs = require('node:fs');
const path = require('node:path');
const column = (type, nullable = 'YES') => ({ name: 'value', type, nullable, extra: '' });

test('date picker preserves SQL wall-clock values and microseconds', () => {
  const date = column('date');
  const timestamp = column('timestamp(6)');
  assert.equal(values.pickerValue(date, '2026-10-24'), '2026-10-24');
  assert.equal(values.pickerValue(timestamp, '2026-10-24 23:45:30.123456'), '2026-10-24T23:45:30.123');
  assert.equal(values.mergePickerValue(timestamp, '2026-10-25T00:15:30.123', '2026-10-24 23:45:30.123456'), '2026-10-25 00:15:30.123456');
  assert.equal(values.mergePickerValue(column('datetime'), '2026-10-25T12:30', ''), '2026-10-25 12:30:00');
  assert.equal(values.mergePickerValue(column('datetime(6)'), '2026-10-25T12:30:00', '2026-10-24 12:30:00.000001'), '2026-10-25 12:30:00.000001');
});

test('zero dates and MySQL duration values remain editable as raw SQL values', () => {
  assert.equal(values.pickerValue(column('date'), '0000-00-00'), '');
  assert.equal(values.normalizeValue(column('date'), '0000-00-00'), '0000-00-00');
  assert.equal(values.pickerValue(column('time(6)'), '-125:04:03.123456'), '');
  assert.equal(values.normalizeValue(column('time(6)'), '-125:04:03.123456'), '-125:04:03.123456');
  assert.equal(values.normalizeValue(column('datetime'), '2026-10-24T12:30'), '2026-10-24 12:30:00');
  assert.throws(() => values.normalizeValue(column('time'), '839:00:00'), /giới hạn/);
  assert.throws(() => values.normalizeValue(column('datetime(3)'), '2026-10-24 00:00:00.123456'), /3/);
});

test('temporal validation rejects impossible dates and invalid times', () => {
  for (const value of ['2026-02-29', '2026-04-31', '2026-13-01', '24/10/2026']) assert.throws(() => values.normalizeValue(column('date'), value));
  assert.equal(values.normalizeValue(column('date'), '2024-02-29'), '2024-02-29');
  for (const value of ['2026-10-24 24:00:00', '2026-02-30 12:00:00', '2026-10-24 12:60:00']) assert.throws(() => values.normalizeValue(column('datetime'), value));
});

test('BIGINT and DECIMAL validation keeps all digits without converting to Number', () => {
  assert.equal(values.normalizeValue(column('bigint unsigned'), '18446744073709551615'), '18446744073709551615');
  assert.equal(values.normalizeValue(column('decimal(30,6)'), '123456789012345678901234.123456'), '123456789012345678901234.123456');
  assert.throws(() => values.normalizeValue(column('bigint unsigned'), '18446744073709551616'));
  assert.throws(() => values.normalizeValue(column('tinyint unsigned'), '-1'));
  assert.throws(() => values.normalizeValue(column('int'), '1e3'));
  assert.throws(() => values.normalizeValue(column('decimal(4,2)'), '100.01'));
  assert.throws(() => values.normalizeValue(column('decimal(4,2)'), '1.123'));
  assert.equal(values.normalizeValue(column('tinyint(1)'), '2'), '2');
});

test('ENUM parser handles quoted commas, doubled quotes and escaped values', () => {
  assert.deepEqual(values.parseChoices(String.raw`enum('a,b','it''s','can\'t','back\\slash','')`), ['a,b', "it's", "can't", 'back\\slash', '']);
  assert.equal(values.normalizeValue(column("enum('NULL','a,b','')"), 'NULL'), 'NULL');
  assert.equal(values.normalizeValue(column("enum('NULL','a,b','')"), ''), '');
  assert.throws(() => values.normalizeValue(column("enum('a','b')"), 'c'));
});

test('SET selections are validated and follow the schema declaration order', () => {
  assert.equal(values.normalizeValue(column("set('read','write','admin')"), 'write,read'), 'read,write');
  assert.equal(values.normalizeValue(column("set('read','write')"), ''), '');
  assert.throws(() => values.normalizeValue(column("set('read','write')"), 'unknown'));
});

test('SQL NULL, empty string, literal NULL and JSON null stay distinct', () => {
  assert.equal(values.normalizeValue(column('varchar(20)'), null), null);
  assert.equal(values.normalizeValue(column('varchar(20)'), ''), '');
  assert.equal(values.normalizeValue(column('varchar(20)'), 'NULL'), 'NULL');
  assert.equal(values.normalizeValue(column('json'), 'null'), 'null');
  const json = '{"value":18446744073709551615}';
  assert.equal(values.normalizeValue(column('json'), json), json);
  assert.throws(() => values.normalizeValue(column('json'), '{bad}'));
  assert.throws(() => values.normalizeValue(column('varchar(20)', 'NO'), null));
  assert.throws(() => values.normalizeValue(column('int'), ''));
});

test('binary previews are read-only and hex/bit values validate without losing bytes', () => {
  assert.equal(values.describe(column('blob'), '0x1234… (100 bytes)').readOnly, true);
  assert.equal(values.normalizeValue(column('varbinary(4)'), '0x00ff'), '0x00ff');
  assert.equal(values.normalizeValue(column('blob'), ''), '0x');
  assert.throws(() => values.normalizeValue(column('blob'), '0x123'));
  assert.throws(() => values.normalizeValue(column('varbinary(1)'), '0x0102'));
  assert.equal(values.displayValue(column('bit(4)'), '0x0a'), '1010');
  assert.equal(values.normalizeValue(column('bit(4)'), '1010'), '1010');
  assert.throws(() => values.normalizeValue(column('bit(4)'), '10101'));
  assert.equal(values.describe(column('geometry'), '{}').readOnly, true);
  assert.equal(values.describe({ ...column('int'), extra: 'STORED GENERATED' }).readOnly, true);
});

test('text length counts Unicode characters and YEAR retains its special zero value', () => {
  assert.equal(values.normalizeValue(column('varchar(2)'), '😀😀'), '😀😀');
  assert.throws(() => values.normalizeValue(column('varchar(2)'), '😀😀😀'));
  assert.equal(values.normalizeValue(column('year'), '0000'), '0000');
  assert.throws(() => values.normalizeValue(column('year'), '1900'));
});

test('desktop packaging includes the shared editor module before the renderer', () => {
  const config = require('../package.json');
  assert.ok(config.build.files.includes('row-values.js'));
  assert.ok(config.build.files.includes('query-results.js'));
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.ok(html.indexOf('src="row-values.js"') < html.indexOf('src="app.js"'));
  assert.ok(html.indexOf('src="query-results.js"') < html.indexOf('src="app.js"'));
});
