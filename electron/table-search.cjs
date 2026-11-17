'use strict';

// Shared read-only predicate for grid, COUNT and streaming export. Identifiers
// come from metadata; values stay in parameters and never become SQL syntax.
function buildTableSearch(options, columns, { quoteId, coerceValue }) {
  const mode = options.searchMode || 'contains';
  const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_FILTER' }); };
  if (!['contains', 'exact', 'prefix', 'is-null', 'not-null'].includes(mode)) fail('Cách tìm kiếm không hợp lệ.');
  const selected = options.searchColumn ? columns.filter(column => column.name === options.searchColumn) : columns;
  if (!selected.length) throw Object.assign(new Error('Cột tìm kiếm không hợp lệ.'), { code: 'INVALID_COLUMN' });
  const nullMode = mode === 'is-null' || mode === 'not-null';
  if (nullMode && !options.searchColumn) fail('Hãy chọn một cột để lọc NULL hoặc khác NULL.');
  const term = nullMode ? '' : String(options.search || '').trim().slice(0, 200);
  const params = [];
  const clauses = term || nullMode ? selected.map(column => {
    const reference = quoteId(column.name);
    if (nullMode) return `${reference} IS ${mode === 'not-null' ? 'NOT ' : ''}NULL`;
    if (mode === 'exact') {
      params.push(options.searchColumn ? coerceValue(term, column) : term);
      return `${options.searchColumn ? reference : `CAST(${reference} AS CHAR)`} = ?`;
    }
    // A fixed non-backslash escape keeps %, _ and the escape character literal.
    const literal = term.replace(/[=%_]/g, character => `=${character}`);
    params.push(mode === 'prefix' ? `${literal}%` : `%${literal}%`);
    const nativeText = mode === 'prefix' && options.searchColumn
      && /^(?:char|varchar|tinytext|text|mediumtext|longtext|enum|set)\b/i.test(column.type || '');
    return `${nativeText ? reference : `CAST(${reference} AS CHAR)`} LIKE ? ESCAPE '='`;
  }) : [];
  return {
    where: clauses.length ? `(${clauses.join(' OR ')})` : '', params,
    key: JSON.stringify([term, options.searchColumn || '', mode])
  };
}

module.exports = { buildTableSearch };
