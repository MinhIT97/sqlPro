'use strict';

const crypto = require('node:crypto');
const MAX_COLUMNS = 256;
const TYPES = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'decimal', 'numeric', 'float', 'double',
  'char', 'varchar', 'binary', 'varbinary', 'tinytext', 'text', 'mediumtext', 'longtext', 'tinyblob', 'blob', 'mediumblob', 'longblob',
  'date', 'datetime', 'timestamp', 'time', 'year', 'json', 'bit']);
const TEXT_TYPES = new Set(['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'enum', 'set']);
const word = (token, value) => token?.kind === 'word' && token.value.toUpperCase() === value;
const symbol = (token, value) => token?.kind === 'symbol' && token.value === value;
const identifier = token => ['word', 'identifier'].includes(token?.kind);

function normalizeColumnType(raw) {
  const text = typeof raw === 'string' ? raw.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\s*([(),])/g, '$1').replace(/([,(])\s*/g, '$1') : '';
  const base = /^([a-z]+)/.exec(text)?.[1] || 'unknown';
  const known = text.length <= 160 && TYPES.has(base) && /^[a-z]+(?:\(\d+(?:,\d+)?\))?(?: unsigned)?(?: zerofill)?$/.test(text);
  return { type: known ? text : `${base.slice(0, 30)}${text.includes('(') ? '(…)' : ''}`, typeKnown: known,
    typeFingerprint: crypto.createHash('sha256').update(typeof raw === 'string' ? raw : '').digest('hex') };
}

// Only describe bounded column metadata. Never retain SQL literals, default
// values, enum labels, comments or generated expressions in the inventory.
function analyzeTableColumns(tokens, opening, budget = MAX_COLUMNS) {
  const schema = { columns: [], complete: true, charset: null, collation: null };
  const clauses = []; let clause = [], depth = 1, closing = -1;
  // Split at top-level commas, keeping commas inside DECIMAL/expressions out.
  for (let i = opening + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (symbol(token, '(')) depth++;
    if (symbol(token, ')')) depth--;
    if (!depth) { clauses.push(clause); closing = i; break; }
    if (depth === 1 && symbol(token, ',')) { clauses.push(clause); clause = []; }
    else clause.push(token);
  }
  if (closing < 0) { schema.complete = false; return schema; }
  for (let i = closing + 1; i < tokens.length; i++) {
    if (word(tokens[i], 'CHARSET') || word(tokens[i], 'COLLATE')) {
      const next = symbol(tokens[i + 1], '=') ? tokens[i + 2] : tokens[i + 1];
      if (identifier(next)) schema[word(tokens[i], 'COLLATE') ? 'collation' : 'charset'] = next.value.slice(0, 64);
    } else if (word(tokens[i], 'CHARACTER') && word(tokens[i + 1], 'SET')) {
      const next = symbol(tokens[i + 2], '=') ? tokens[i + 3] : tokens[i + 2];
      if (identifier(next)) schema.charset = next.value.slice(0, 64);
    }
  }
  const primary = new Set();
  for (const definition of clauses) {
    if (definition[0]?.kind === 'word' && ['PRIMARY', 'KEY', 'INDEX', 'UNIQUE', 'FULLTEXT', 'SPATIAL', 'CONSTRAINT', 'FOREIGN', 'CHECK'].includes(definition[0].value.toUpperCase())) {
      const primaryIndex = word(definition[0], 'PRIMARY') ? 0 : word(definition[0], 'CONSTRAINT') && word(definition[2], 'PRIMARY') ? 2 : -1;
      if (primaryIndex >= 0 && word(definition[primaryIndex + 1], 'KEY')) {
        for (const token of definition.slice(primaryIndex + 2)) if (identifier(token) && !word(token, 'ASC') && !word(token, 'DESC')) primary.add(token.value.toLowerCase());
      }
      continue;
    }
    if (!identifier(definition[0]) || definition[0].value.length > 64 || definition[1]?.kind !== 'word') { schema.complete = false; continue; }
    if (schema.columns.length >= Math.min(MAX_COLUMNS, budget)) { schema.complete = false; continue; }
    const name = definition[0].value;
    if (schema.columns.some(column => column.name.toLowerCase() === name.toLowerCase())) schema.complete = false;
    let index = 2, type = definition[1].value;
    if (symbol(definition[index], '(')) {
      const parameters = []; let nesting = 0;
      do {
        const token = definition[index++];
        if (symbol(token, '(')) nesting++;
        if (symbol(token, ')')) nesting--;
        parameters.push(token.kind === 'literal' ? '?' : token.value);
      } while (index < definition.length && nesting > 0);
      type += parameters.join('');
    }
    while (word(definition[index], 'UNSIGNED') || word(definition[index], 'ZEROFILL')) type += ` ${definition[index++].value}`;
    const normalized = normalizeColumnType(type);
    const column = { name, ordinal: schema.columns.length + 1, ...normalized, nullable: true, hasDefault: false,
      autoIncrement: false, generated: false, generatedKind: null, invisible: false, charset: null, collation: null, attributesKnown: true };
    let nesting = 0;
    for (let i = index; i < definition.length; i++) {
      const token = definition[i];
      if (symbol(token, '(')) { nesting++; continue; }
      if (symbol(token, ')')) { nesting--; continue; }
      if (nesting) continue;
      if (word(token, 'NOT') && word(definition[i + 1], 'NULL')) column.nullable = false;
      if (word(token, 'PRIMARY') && word(definition[i + 1], 'KEY')) column.nullable = false;
      if (word(token, 'AUTO_INCREMENT')) column.autoIncrement = true;
      if (word(token, 'DEFAULT')) column.hasDefault = !word(definition[i + 1], 'NULL');
      if (word(token, 'AS') || word(token, 'GENERATED')) { column.generated = true; column.generatedKind = 'virtual'; }
      if (word(token, 'STORED') || word(token, 'PERSISTENT')) column.generatedKind = 'stored';
      if (word(token, 'INVISIBLE')) column.invisible = true;
      if (['BINARY', 'ASCII', 'UNICODE', 'BYTE', 'COLUMN_FORMAT', 'STORAGE', 'ENGINE_ATTRIBUTE', 'SECONDARY_ENGINE_ATTRIBUTE'].some(value => word(token, value))) column.attributesKnown = false;
      if (word(token, 'ON') && word(definition[i + 1], 'UPDATE') || word(token, 'CHECK') || word(token, 'REFERENCES')) column.attributesKnown = false;
      if (word(token, 'CHARACTER') && word(definition[i + 1], 'SET') && identifier(definition[i + 2])) column.charset = definition[i + 2].value.slice(0, 64);
      if (word(token, 'COLLATE') && identifier(definition[i + 1])) column.collation = definition[i + 1].value.slice(0, 64);
    }
    schema.columns.push(column);
  }
  for (const column of schema.columns) {
    if (primary.has(column.name.toLowerCase())) column.nullable = false;
    if (TEXT_TYPES.has(column.type.split('(')[0])) {
      const explicitCharset = column.charset, explicitCollation = column.collation;
      if (!explicitCharset && (!explicitCollation || explicitCollation.toLowerCase() === schema.collation?.toLowerCase())) column.charset = schema.charset;
      if (!explicitCollation && (!explicitCharset || explicitCharset.toLowerCase() === schema.charset?.toLowerCase())) column.collation = schema.collation;
    }
  }
  return schema;
}

function compareSelectionColumns(source, targetColumns, { metadataComplete = true, limit = 50, findingLimit = 100 } = {}) {
  const schema = source.columnSchema;
  const findings = []; let truncated = false;
  const add = (code, column = null) => { if (findings.length < findingLimit) findings.push({ code, column }); else truncated = true; };
  if (!schema?.complete || !schema.columns.length) add('SOURCE_COLUMNS_INCOMPLETE');
  if (!metadataComplete || !targetColumns.length) add('TARGET_COLUMNS_INCOMPLETE');
  const sourceColumns = schema?.columns || [];
  const target = new Map(targetColumns.map(column => [column.name.toLowerCase(), column]));
  const fields = [];
  for (const column of sourceColumns) {
    const match = target.get(column.name.toLowerCase());
    const differences = [];
    const difference = code => { differences.push(code); add(code, column.name); };
    if (!match) { if (metadataComplete && targetColumns.length) difference('COLUMN_NOT_SEEN_AT_TARGET'); }
    else {
      if (column.attributesKnown === false || match.attributesKnown === false) difference('COLUMN_ATTRIBUTES_NOT_ANALYZED');
      if (!column.typeKnown || !match.typeKnown) difference('COLUMN_TYPE_NOT_ANALYZED');
      else if (column.type !== match.type) difference('COLUMN_TYPE_DIFFERS');
      for (const [key, code] of [['nullable', 'COLUMN_NULLABILITY_DIFFERS'], ['autoIncrement', 'COLUMN_AUTO_INCREMENT_DIFFERS'],
        ['generated', 'COLUMN_GENERATED_DIFFERS'], ['generatedKind', 'COLUMN_GENERATED_STORAGE_DIFFERS'], ['invisible', 'COLUMN_VISIBILITY_DIFFERS'], ['hasDefault', 'COLUMN_DEFAULT_PRESENCE_DIFFERS']]) {
        if (column[key] !== match[key]) difference(code);
      }
      if (column.generated || match.generated) difference('GENERATED_EXPRESSION_NOT_COMPARED');
      if (column.hasDefault || match.hasDefault) difference('DEFAULT_VALUE_NOT_COMPARED');
      if (TEXT_TYPES.has(column.type.split('(')[0])) {
        for (const key of ['charset', 'collation']) {
          if (!column[key] || !match[key]) difference('COLUMN_CHARSET_OR_COLLATION_UNKNOWN');
          else if (column[key].toLowerCase() !== match[key].toLowerCase()) difference(key === 'charset' ? 'COLUMN_CHARSET_DIFFERS' : 'COLUMN_COLLATION_DIFFERS');
        }
      }
    }
    if (fields.length < limit) fields.push({ name: column.name, sourceType: column.type, targetType: match?.type || null, differences,
      sourceOrdinal: column.ordinal, targetOrdinal: match?.ordinal || null });
  }
  if (fields.length < sourceColumns.length) truncated = true;
  if (source.insertColumnMode === 'positional' || source.insertColumnMode === 'mixed') {
    add('POSITIONAL_INSERT_REQUIRES_REVIEW');
    const left = sourceColumns.filter(column => !column.invisible).map(column => column.name.toLowerCase());
    const right = targetColumns.filter(column => !column.invisible).map(column => column.name.toLowerCase());
    if (schema?.complete && metadataComplete && JSON.stringify(left) !== JSON.stringify(right)) add('POSITIONAL_COLUMN_ORDER_OR_COUNT_DIFFERS');
  } else if (source.dataStatements && source.insertColumnMode !== 'explicit') add('INSERT_COLUMNS_UNKNOWN');
  if (schema?.complete && metadataComplete) {
    const names = new Set(sourceColumns.map(column => column.name.toLowerCase()));
    for (const column of targetColumns) {
      if (!names.has(column.name.toLowerCase())) add('EXTRA_TARGET_COLUMN', column.name);
      if (source.insertColumnMode === 'explicit' && source.insertColumnSets?.some(set => !set.some(name => name.toLowerCase() === column.name.toLowerCase()))
          && !column.nullable && !column.hasDefault && !column.autoIncrement && !column.generated) add('REQUIRED_TARGET_COLUMN_NOT_SUPPLIED', column.name);
    }
    for (const set of source.insertColumnSets || []) for (const name of set) {
      if (!names.has(name.toLowerCase())) add('INSERT_COLUMN_NOT_IN_SOURCE_DEFINITION', name);
    }
  }
  return { status: 'partial', sourceColumnCount: sourceColumns.length, targetColumnCount: targetColumns.length, fields, findings, truncated };
}

module.exports = { normalizeColumnType, analyzeTableColumns, compareSelectionColumns };
