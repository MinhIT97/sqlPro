'use strict';

const MAX_BYTES = 2 * 1024 * 1024;
const NUMBER = /(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const WORD = /[A-Za-z_][A-Za-z0-9_]*/y;
const INTEGERS = new Set(['TINYINT', 'SMALLINT', 'MEDIUMINT', 'INT', 'INTEGER', 'BIGINT']);
const STRINGS = new Set(['CHAR', 'VARCHAR', 'TINYTEXT', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT']);
class UnsupportedCreate extends Error {}

// Recognizes a deliberately small, whole-statement grammar from the original
// SQL. A match is syntax evidence only, never permission or a proof of effects.
// Literal/default/comment contents and option values never leave this module.
function reviewBasicCreate(sql) {
  const reject = code => { throw new UnsupportedCreate(code); };
  try {
    if (typeof sql !== 'string') reject('CREATE_FORM_UNSUPPORTED');
    if (sql.length > MAX_BYTES || Buffer.byteLength(sql) > MAX_BYTES) reject('CREATE_VALIDATION_LIMIT');
    if (sql.includes('\0')) reject('CREATE_QUOTING_UNSUPPORTED');
    let position = 0, tokens = 0;
    const quoted = quote => {
      position++; let name = '', closed = false;
      while (position < sql.length) {
        const character = sql[position++];
        if (character === '\\') reject('CREATE_QUOTING_UNSUPPORTED');
        if (character === quote) {
          if (sql[position] === quote) { position++; if (quote === '`') name += quote; }
          else { closed = true; break; }
        } else if (quote === '`') name += character;
        if (name.length > 64) reject('CREATE_IDENTIFIER_UNSUPPORTED');
      }
      if (!closed) reject('CREATE_QUOTING_UNSUPPORTED');
      return quote === '`' ? { kind: 'identifier', value: name } : { kind: 'literal' };
    };
    const next = () => {
      while (position < sql.length && /[ \t\r\n]/.test(sql[position])) position++;
      if (++tokens > 65536) reject('CREATE_VALIDATION_LIMIT');
      if (position === sql.length) return { kind: 'end' };
      const character = sql[position], after = sql[position + 1];
      if (character === '`' || character === "'") return quoted(character);
      if (character === '"' || character === '\\') reject('CREATE_QUOTING_UNSUPPORTED');
      if (character === '#' || character === '/' || character === '-' && after === '-') reject('CREATE_COMMENT_UNSUPPORTED');
      NUMBER.lastIndex = position;
      const number = NUMBER.exec(sql);
      if (number) { position = NUMBER.lastIndex; return { kind: 'number', value: number[0] }; }
      WORD.lastIndex = position;
      const word = WORD.exec(sql);
      if (word) { position = WORD.lastIndex; return { kind: 'word', value: word[0].toUpperCase() }; }
      if ('(),.;=+-'.includes(character)) { position++; return { kind: 'symbol', value: character }; }
      reject('CREATE_FORM_UNSUPPORTED');
    };
    let token = next();
    const word = value => token.kind === 'word' && token.value === value;
    const symbol = value => token.kind === 'symbol' && token.value === value;
    const consume = value => {
      if (!word(value) && !symbol(value)) reject('CREATE_FORM_UNSUPPORTED');
      token = next();
    };
    const identifier = () => {
      // Quoted identifiers avoid treating reserved words as valid bare names.
      if (token.kind !== 'identifier' || !token.value || /[\u0001-\u001f\u007f]/.test(token.value)) reject('CREATE_IDENTIFIER_UNSUPPORTED');
      const value = token.value; token = next(); return value;
    };
    const boundedInteger = (minimum, maximum) => {
      if (token.kind !== 'number' || !/^\d{1,6}$/.test(token.value)) reject('CREATE_TYPE_OR_LENGTH_UNSUPPORTED');
      const value = Number(token.value);
      if (value < minimum || value > maximum) reject('CREATE_TYPE_OR_LENGTH_UNSUPPORTED');
      token = next(); return value;
    };
    const oneArgument = (minimum, maximum) => {
      consume('('); const value = boundedInteger(minimum, maximum); consume(')'); return value;
    };
    const optionName = () => {
      if (token.kind !== 'word' || token.value.length > 64) reject('CREATE_OPTION_UNSUPPORTED');
      token = next();
    };
    const literal = () => {
      if (symbol('+') || symbol('-')) { token = next(); if (token.kind !== 'number') reject('CREATE_DEFAULT_UNSUPPORTED'); }
      if (!['literal', 'number'].includes(token.kind) && !['NULL', 'TRUE', 'FALSE'].some(word)) reject('CREATE_DEFAULT_UNSUPPORTED');
      token = next();
    };
    consume('CREATE'); consume('TABLE');
    const first = identifier(); let schema = null, table = first;
    if (symbol('.')) { token = next(); schema = first; table = identifier(); }
    consume('(');
    const columns = new Set(), indexNames = new Set(), references = [], constraintNames = new Set(), foreignKeys = [], indexDefinitions = [];
    let indexCount = 0, primaryKeys = 0, hasIndexes = false;
    const column = () => {
      const name = identifier().toLowerCase();
      if (columns.has(name)) reject('CREATE_DUPLICATE_NAME');
      if (columns.size >= 256) reject('CREATE_VALIDATION_LIMIT');
      columns.add(name);
      if (token.kind !== 'word') reject('CREATE_TYPE_OR_LENGTH_UNSUPPORTED');
      const type = token.value; token = next();
      if (INTEGERS.has(type)) {
        if (symbol('(')) oneArgument(1, 255);
      } else if (['DECIMAL', 'NUMERIC'].includes(type)) {
        if (symbol('(')) {
          token = next(); const precision = boundedInteger(1, 65);
          if (symbol(',')) { token = next(); boundedInteger(0, Math.min(30, precision)); }
          consume(')');
        }
      } else if (['FLOAT', 'DOUBLE', 'DATE', 'YEAR', 'JSON', 'BOOL', 'BOOLEAN', 'TINYBLOB', 'BLOB', 'MEDIUMBLOB', 'LONGBLOB', 'TINYTEXT', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT'].includes(type)) {
        // Parameters for these types are outside this grammar.
      } else if (['DATETIME', 'TIMESTAMP', 'TIME'].includes(type)) {
        if (symbol('(')) oneArgument(0, 6);
      } else if (type === 'BIT') {
        if (symbol('(')) oneArgument(1, 64);
      } else if (['CHAR', 'BINARY', 'VARCHAR', 'VARBINARY'].includes(type)) {
        oneArgument(1, ['CHAR', 'BINARY'].includes(type) ? 255 : 65535);
      } else reject('CREATE_TYPE_OR_LENGTH_UNSUPPORTED');
      if (word('UNSIGNED')) {
        if (!INTEGERS.has(type) && !['DECIMAL', 'NUMERIC', 'FLOAT', 'DOUBLE'].includes(type)) reject('CREATE_COLUMN_ATTRIBUTE_UNSUPPORTED');
        token = next();
      }
      if (word('CHARACTER')) {
        if (!STRINGS.has(type)) reject('CREATE_COLUMN_ATTRIBUTE_UNSUPPORTED');
        token = next(); consume('SET'); optionName();
      }
      if (word('COLLATE')) {
        if (!STRINGS.has(type)) reject('CREATE_COLUMN_ATTRIBUTE_UNSUPPORTED');
        token = next(); optionName();
      }
      if (word('NOT')) { token = next(); consume('NULL'); }
      else if (word('NULL')) token = next();
      if (word('DEFAULT')) { token = next(); literal(); }
      if (word('AUTO_INCREMENT')) {
        if (!INTEGERS.has(type)) reject('CREATE_COLUMN_ATTRIBUTE_UNSUPPORTED');
        token = next();
      }
      if (word('COMMENT')) {
        token = next(); if (token.kind !== 'literal') reject('CREATE_COLUMN_ATTRIBUTE_UNSUPPORTED'); token = next();
      }
      if (!symbol(',') && !symbol(')')) reject('CREATE_COLUMN_ATTRIBUTE_UNSUPPORTED');
    };
    const index = () => {
      hasIndexes = true;
      if (++indexCount > 128) reject('CREATE_VALIDATION_LIMIT');
      let name = 'PRIMARY', kind = 'primary';
      if (word('PRIMARY')) {
        token = next(); consume('KEY');
        if (++primaryKeys > 1) reject('CREATE_INDEX_UNSUPPORTED');
      } else {
        kind = word('UNIQUE') ? 'unique' : 'index';
        if (word('UNIQUE')) token = next();
        if (!word('KEY') && !word('INDEX')) reject('CREATE_INDEX_UNSUPPORTED');
        token = next(); name = identifier();
        const folded = name.toLowerCase();
        if (folded === 'primary' || indexNames.has(folded)) reject('CREATE_DUPLICATE_NAME');
        indexNames.add(folded);
      }
      consume('('); const seen = new Set(), parts = [];
      for (;;) {
        const column = identifier(), folded = column.toLowerCase();
        if (seen.has(folded) || seen.size >= 16) reject('CREATE_INDEX_UNSUPPORTED');
        seen.add(folded); references.push(folded);
        const prefixLength = symbol('(') ? oneArgument(1, 65535) : null;
        parts.push({ name: column, prefixLength });
        if (word('ASC')) token = next();
        if (!symbol(',')) break;
        token = next();
      }
      consume(')');
      if (!symbol(',') && !symbol(')')) reject('CREATE_INDEX_UNSUPPORTED');
      indexDefinitions.push({ name, kind, columns: parts });
    };
    const foreignKeyColumns = () => {
      consume('('); const names = [], seen = new Set();
      for (;;) {
        const name = identifier();
        if (seen.has(name.toLowerCase()) || names.length >= 16) reject('CREATE_FOREIGN_KEY_COLUMNS_INVALID');
        seen.add(name.toLowerCase()); names.push(name);
        if (!symbol(',')) break;
        token = next();
      }
      consume(')'); return names;
    };
    const foreignKey = () => {
      hasIndexes = true;
      if (foreignKeys.length >= 64) reject('CREATE_FOREIGN_KEY_LIMIT');
      let name = null;
      if (word('CONSTRAINT')) {
        token = next(); name = identifier();
        if (constraintNames.has(name.toLowerCase())) reject('CREATE_DUPLICATE_NAME');
        constraintNames.add(name.toLowerCase());
      }
      consume('FOREIGN'); consume('KEY');
      if (token.kind === 'identifier') identifier(); // Optional index name, not an execution identity.
      const local = foreignKeyColumns();
      consume('REFERENCES');
      let referencedTable = identifier(), referencedSchema = null;
      if (symbol('.')) { token = next(); referencedSchema = referencedTable; referencedTable = identifier(); }
      const remote = foreignKeyColumns();
      if (local.length !== remote.length) reject('CREATE_FOREIGN_KEY_ARITY_MISMATCH');
      const actions = { onDelete: null, onUpdate: null };
      while (word('ON')) {
        token = next();
        const field = word('DELETE') ? 'onDelete' : word('UPDATE') ? 'onUpdate' : null;
        if (!field || actions[field] !== null) reject('CREATE_FOREIGN_KEY_ACTION_UNSUPPORTED');
        token = next(); let action = null;
        if (word('RESTRICT') || word('CASCADE')) { action = token.value; token = next(); }
        else if (word('SET')) { token = next(); consume('NULL'); action = 'SET NULL'; }
        else if (word('NO')) { token = next(); consume('ACTION'); action = 'NO ACTION'; }
        else reject('CREATE_FOREIGN_KEY_ACTION_UNSUPPORTED');
        actions[field] = action;
      }
      if (!symbol(',') && !symbol(')')) reject('CREATE_FOREIGN_KEY_FORM_UNSUPPORTED');
      foreignKeys.push({ name, columns: local, referencedSchema, referencedTable, referencedColumns: remote, ...actions });
    };
    for (;;) {
      if (token.kind === 'identifier') {
        if (hasIndexes) reject('CREATE_FORM_UNSUPPORTED');
        column();
      } else if (['PRIMARY', 'UNIQUE', 'KEY', 'INDEX'].some(word)) index();
      else if (word('CONSTRAINT') || word('FOREIGN')) foreignKey();
      else reject('CREATE_DEFINITION_UNSUPPORTED');
      if (!symbol(',')) break;
      token = next();
    }
    consume(')');
    if (!columns.size || references.some(name => !columns.has(name))) reject('CREATE_INDEX_UNSUPPORTED');
    if (foreignKeys.some(fk => fk.columns.some(name => !columns.has(name.toLowerCase())))) reject('CREATE_FOREIGN_KEY_COLUMN_UNKNOWN');
    const options = new Set(); let engine = null;
    while (token.kind !== 'end' && !symbol(';')) {
      let key = token.value;
      if (word('DEFAULT')) {
        token = next();
        if (!['CHARACTER', 'CHARSET', 'COLLATE'].some(word)) reject('CREATE_OPTION_UNSUPPORTED');
        key = token.value;
      }
      if (word('CHARACTER')) { token = next(); consume('SET'); key = 'CHARSET'; }
      else if (['ENGINE', 'CHARSET', 'COLLATE', 'AUTO_INCREMENT', 'COMMENT', 'ROW_FORMAT'].some(word)) token = next();
      else reject('CREATE_OPTION_UNSUPPORTED');
      if (options.has(key)) reject('CREATE_OPTION_UNSUPPORTED');
      options.add(key);
      if (symbol('=')) token = next();
      if (key === 'ENGINE') {
        if (!word('INNODB')) reject('CREATE_ENGINE_UNSUPPORTED');
        engine = 'InnoDB'; token = next();
      } else if (key === 'AUTO_INCREMENT') {
        if (token.kind !== 'number' || !/^[1-9]\d{0,19}$/.test(token.value)) reject('CREATE_OPTION_UNSUPPORTED');
        token = next();
      } else if (key === 'COMMENT') {
        if (token.kind !== 'literal') reject('CREATE_OPTION_UNSUPPORTED'); token = next();
      } else if (key === 'ROW_FORMAT') {
        if (!['DYNAMIC', 'COMPACT', 'REDUNDANT', 'COMPRESSED'].some(word)) reject('CREATE_OPTION_UNSUPPORTED');
        token = next();
      } else optionName();
    }
    if (symbol(';')) token = next();
    if (token.kind !== 'end') reject('CREATE_TRAILING_SQL');
    if (!engine) reject('CREATE_ENGINE_REQUIRED');
    return { version: 3, status: 'matched', code: 'BASIC_CREATE_MATCHED', table, schema,
      columns: columns.size, indexes: indexCount, engine, foreignKeys, indexDefinitions };
  } catch (error) {
    if (!(error instanceof UnsupportedCreate)) throw error;
    return { version: 3, status: 'unsupported', code: error.message };
  }
}

module.exports = { reviewBasicCreate };
