'use strict';

const MAX_BYTES = 2 * 1024 * 1024;
const NUMBER = /(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const WORD = /[A-Za-z_$][A-Za-z0-9_$]*/y;

class UnsupportedInsert extends Error {}

// Recognize only a bounded INSERT ... VALUES literal grammar. This never
// validates conversion, privileges, constraints, triggers or server effects.
// Tokens discard literal contents; no SQL text or values leave this function.
function reviewLiteralInsert(sql) {
  const reject = code => { throw new UnsupportedInsert(code); };
  try {
    if (typeof sql !== 'string') reject('INSERT_FORM_UNSUPPORTED');
    if (sql.length > MAX_BYTES || Buffer.byteLength(sql) > MAX_BYTES) reject('INSERT_VALIDATION_LIMIT');
    if (sql.includes('\0')) reject('INSERT_QUOTING_UNSUPPORTED');
    let index = 0, tokenCount = 0;
    const quoted = (quote, keepName = false, alphabet = null) => {
      index++;
      let name = '', count = 0;
      while (index < sql.length) {
        const character = sql[index++];
        if (character === '\\') reject('INSERT_QUOTING_UNSUPPORTED');
        if (character === quote) {
          if (!alphabet && sql[index] === quote) {
            index++; count++;
            if (keepName) name += quote;
          } else {
            if (alphabet === 'hex' && count % 2 || alphabet === 'bit' && !count) reject('INSERT_LITERAL_UNSUPPORTED');
            return keepName ? { kind: 'identifier', value: name } : { kind: 'literal' };
          }
        } else {
          if (alphabet === 'hex' && !/[0-9a-f]/i.test(character) || alphabet === 'bit' && !/[01]/.test(character)) reject('INSERT_LITERAL_UNSUPPORTED');
          count++;
          if (keepName) name += character;
        }
        if (keepName && count > 64) reject('INSERT_IDENTIFIER_UNSUPPORTED');
      }
      reject('INSERT_QUOTING_UNSUPPORTED');
    };
    const next = () => {
      while (index < sql.length && /[ \t\r\n]/.test(sql[index])) index++;
      if (++tokenCount > 200000) reject('INSERT_VALIDATION_LIMIT');
      if (index === sql.length) return { kind: 'end' };
      const character = sql[index], after = sql[index + 1];
      if (character === '`') return quoted('`', true);
      if (character === "'") return quoted("'");
      if (character === '"' || character === '\\') reject('INSERT_QUOTING_UNSUPPORTED');
      if (character === '#' || character === '/' || character === '-' && after === '-') reject('INSERT_COMMENT_UNSUPPORTED');
      if (/[xXbB]/.test(character) && after === "'") { index++; return quoted("'", false, /x/i.test(character) ? 'hex' : 'bit'); }
      if (sql.startsWith('0x', index) || sql.startsWith('0b', index)) {
        const hex = sql[index + 1] === 'x'; index += 2;
        const start = index, alphabet = hex ? /[0-9a-f]/i : /[01]/;
        while (index < sql.length && alphabet.test(sql[index])) index++;
        if (index === start) reject('INSERT_LITERAL_UNSUPPORTED');
        return { kind: 'literal' };
      }
      NUMBER.lastIndex = index;
      const number = NUMBER.exec(sql);
      if (number) { index = NUMBER.lastIndex; return { kind: 'number' }; }
      WORD.lastIndex = index;
      const word = WORD.exec(sql);
      if (word) { index = WORD.lastIndex; return { kind: 'word', value: word[0] }; }
      if ('(),.;+-'.includes(character)) { index++; return { kind: 'symbol', value: character }; }
      reject('INSERT_FORM_UNSUPPORTED');
    };
    let token = next();
    const isWord = word => token.kind === 'word' && token.value.toUpperCase() === word;
    const isSymbol = symbol => token.kind === 'symbol' && token.value === symbol;
    const consumeWord = word => { if (!isWord(word)) reject('INSERT_FORM_UNSUPPORTED'); token = next(); };
    const name = () => {
      if (!['word', 'identifier'].includes(token.kind) || !token.value || token.value.length > 64) reject('INSERT_IDENTIFIER_UNSUPPORTED');
      const value = token.value; token = next(); return value;
    };
    consumeWord('INSERT'); consumeWord('INTO');
    const first = name(); let schema = null, table = first;
    if (isSymbol('.')) { token = next(); schema = first; table = name(); }
    let columnCount = null;
    if (isSymbol('(')) {
      token = next(); const names = new Set();
      for (;;) {
        const column = name().toLowerCase();
        if (names.has(column) || names.size >= 256) reject('INSERT_COLUMN_LIST_INVALID');
        names.add(column);
        if (!isSymbol(',')) break;
        token = next();
      }
      if (!isSymbol(')')) reject('INSERT_COLUMN_LIST_INVALID');
      columnCount = names.size; token = next();
    }
    consumeWord('VALUES');
    let rows = 0, valuesPerRow = null, valueCount = 0;
    for (;;) {
      if (!isSymbol('(')) reject('INSERT_FORM_UNSUPPORTED');
      token = next(); let count = 0;
      for (;;) {
        if (isSymbol('+') || isSymbol('-')) { token = next(); if (token.kind !== 'number') reject('INSERT_VALUE_EXPRESSION'); }
        if (token.kind !== 'number' && token.kind !== 'literal' && !['NULL', 'TRUE', 'FALSE'].some(isWord)) reject('INSERT_VALUE_EXPRESSION');
        count++; valueCount++;
        if (count > 256 || valueCount > 100000) reject('INSERT_VALIDATION_LIMIT');
        token = next();
        if (!isSymbol(',')) break;
        token = next();
      }
      if (!isSymbol(')')) reject('INSERT_VALUE_EXPRESSION');
      if (columnCount !== null && count !== columnCount || valuesPerRow !== null && count !== valuesPerRow) reject('INSERT_ARITY_MISMATCH');
      valuesPerRow = count;
      if (++rows > 10000) reject('INSERT_VALIDATION_LIMIT');
      token = next();
      if (!isSymbol(',')) break;
      token = next();
    }
    if (isSymbol(';')) token = next();
    if (token.kind !== 'end') reject('INSERT_TRAILING_SQL');
    return { version: 1, status: 'matched', code: 'LITERAL_INSERT_MATCHED', table, schema, rows, valuesPerRow,
      columnMode: columnCount === null ? 'positional' : 'explicit' };
  } catch (error) {
    if (!(error instanceof UnsupportedInsert)) throw error;
    return { version: 1, status: 'unsupported', code: error.message };
  }
}

module.exports = { reviewLiteralInsert };
