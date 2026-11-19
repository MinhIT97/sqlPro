'use strict';

const { tokenizeSql } = require('./sql-script.cjs');

// Empty information_schema results are not proof of absence when the account
// cannot see children/triggers. Until role/partial-grant closure is modeled,
// require direct global SELECT and TRIGGER, with no partial revocations.
function provesMetadataVisibility(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 256) return false;
  let select = false, trigger = false, bytes = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Object.keys(row).length !== 1) return false;
    const sql = Object.values(row)[0];
    if (typeof sql !== 'string' || sql.length > 16384 || (bytes += Buffer.byteLength(sql)) > 262144) return false;
    let tokens;
    try { tokens = tokenizeSql(sql); } catch { return false; }
    const word = (token, value) => token?.type === 'word' && token.value.toUpperCase() === value;
    if (word(tokens[0], 'REVOKE')) return false;
    if (!word(tokens[0], 'GRANT')) continue;
    const on = tokens.findIndex(token => word(token, 'ON'));
    if (on < 2 || !['*', '.', '*'].every((value, i) => tokens[on + i + 1]?.type === 'symbol' && tokens[on + i + 1].value === value)
        || !word(tokens[on + 4], 'TO')) continue;
    const privileges = tokens.slice(1, on);
    if (privileges.some(token => token.type !== 'word' && !(token.type === 'symbol' && token.value === ','))) continue;
    const names = privileges.map(token => token.value.toUpperCase()).join(' ').split(' , ');
    select ||= names.includes('SELECT') || names.includes('ALL PRIVILEGES');
    trigger ||= names.includes('TRIGGER') || names.includes('ALL PRIVILEGES');
  }
  return select && trigger;
}

module.exports = { provesMetadataVisibility };
