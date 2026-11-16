'use strict';

const crypto = require('node:crypto');
const { assertReadOnlySql } = require('./connection-policy.cjs');
const { splitSqlStatements } = require('./sql-script.cjs');

const SCHEMA_BYTES = 512 * 1024;
const validName = value => typeof value === 'string' && value.length > 0 && value.length <= 64 && !value.includes('\0');
const quote = value => '`' + value.replace(/`/g, '``') + '`';

// A deliberately bounded source recognizer, not an SQL parser or an execution
// permission. Unknown syntax must not claim to cover all referenced objects.
function singleTableSource(sql, database) {
  if (typeof sql !== 'string' || sql.length > 65536) return null;
  try {
    assertReadOnlySql({ readOnly: true }, sql);
    if (splitSqlStatements(sql).length !== 1) return null;
  } catch { return null; }
  const tokens = []; let depth = 0;
  for (let i = 0; i < sql.length;) {
    if (tokens.length >= 4096) return null;
    const c = sql[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '#' || sql.startsWith('--', i) && (!sql[i + 2] || /\s/.test(sql[i + 2]))) {
      while (i < sql.length && !/[\r\n]/.test(sql[i])) i++;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) return null;
      i = end + 2; continue;
    }
    if (c === '"') return null;
    if (c === "'" || c === '`') {
      let value = ''; const delimiter = c; i++;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === delimiter) {
          if (sql[i + 1] === delimiter) { value += delimiter; i += 2; continue; }
          i++; closed = true; break;
        }
        value += sql[i++];
      }
      if (!closed) return null;
      tokens.push({ type: delimiter === '`' ? 'identifier' : 'literal', value, depth }); continue;
    }
    const word = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(sql.slice(i));
    if (word) { tokens.push({ type: 'word', value: word[0], depth }); i += word[0].length; continue; }
    if (c === '(') { depth++; if (depth > 32) return null; }
    if (c === ')') { depth--; if (depth < 0) return null; }
    tokens.push({ type: 'symbol', value: c, depth }); i++;
  }
  if (depth) return null;
  const word = (token, value) => token?.type === 'word' && token.value.toUpperCase() === value;
  if (!word(tokens[0], 'EXPLAIN')) return null;
  let start = 1;
  if (word(tokens[start], 'FORMAT') && tokens[start + 1]?.value === '='
      && ['JSON', 'TREE', 'TRADITIONAL'].some(value => word(tokens[start + 2], value))) start += 3;
  if (!word(tokens[start], 'SELECT')) return null;
  const body = tokens.slice(start + 1);
  if (body.some(token => token.type === 'word' && ['SELECT', 'WITH', 'JOIN', 'STRAIGHT_JOIN', 'UNION', 'INTERSECT', 'EXCEPT', 'TABLE', 'VALUES'].includes(token.value.toUpperCase()))) return null;
  const sources = body.map((token, index) => word(token, 'FROM') && token.depth === 0 ? index : -1).filter(index => index >= 0);
  if (sources.length !== 1) return null;
  let index = sources[0] + 1;
  const identifier = token => ['identifier', 'word'].includes(token?.type) && validName(token.value);
  if (!identifier(body[index])) return null;
  const first = body[index++].value;
  let table = first, schema = database;
  if (body[index]?.value === '.') {
    if (!identifier(body[index + 1])) return null;
    schema = first; table = body[index + 1].value; index += 2;
  }
  const clause = token => token?.type === 'word' && ['WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT'].includes(token.value.toUpperCase());
  if (word(body[index], 'AS')) {
    index++;
    if (!identifier(body[index]) || clause(body[index])) return null;
    index++;
  } else if (identifier(body[index]) && !clause(body[index])) index++;
  if (body[index] && body[index].value !== ';' && !clause(body[index])) return null;
  if (!validName(schema) || !validName(table)) return null;
  return Object.freeze({ database: schema, table });
}

function showCreateSql(source) {
  return validName(source?.database) && validName(source?.table)
    ? `SHOW CREATE TABLE ${quote(source.database)}.${quote(source.table)}` : null;
}

function captureTableDefinition(result) {
  if (result?.kind !== 'rows' || result.truncated || !Array.isArray(result.columns) || result.columns.length !== 2
      || result.columns[0]?.name !== 'Table' || result.columns[1]?.name !== 'Create Table'
      || !Array.isArray(result.rows) || result.rows.length !== 1 || !Array.isArray(result.rows[0]) || result.rows[0].length !== 2) return null;
  const [name, ddl] = result.rows[0];
  if (!validName(name) || typeof ddl !== 'string' || ddl.length > 262144 || Buffer.byteLength(ddl, 'utf8') > 262144
      || !/^CREATE (?:TEMPORARY )?TABLE\b/i.test(ddl) || ddl.includes('\0')) return null;
  return crypto.createHash('sha256').update(JSON.stringify([1, name, ddl])).digest('hex');
}

module.exports = { SCHEMA_BYTES, singleTableSource, showCreateSql, captureTableDefinition };
