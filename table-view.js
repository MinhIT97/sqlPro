(function attachTableView(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SqlTableView = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createTableView() {
  'use strict';

  function normalizeSorts(input, columns) {
    const fail = () => { throw Object.assign(new Error('Chọn tối đa 5 cột sắp xếp khác nhau, hướng ASC hoặc DESC.'), { code: 'INVALID_ORDER' }); };
    if (!Array.isArray(input) || input.length > 5) fail();
    const names = new Set(columns.map(column => column.name)), seen = new Set();
    return Object.freeze(Array.from(input, entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)
          || Object.keys(entry).some(key => !['column', 'direction'].includes(key))
          || !Object.hasOwn(entry, 'column') || !Object.hasOwn(entry, 'direction')
          || !names.has(entry.column) || seen.has(entry.column) || !['ASC', 'DESC'].includes(entry.direction)) fail();
      seen.add(entry.column);
      return Object.freeze({ column: entry.column, direction: entry.direction });
    }));
  }

  function order(options, columns) {
    const requested = options.sorts !== undefined && options.sorts !== null
      ? normalizeSorts(options.sorts, columns)
      : normalizeSorts(options.orderBy ? [{ column: options.orderBy, direction: options.orderDir === 'DESC' ? 'DESC' : 'ASC' }] : [], columns);
    const primary = columns.filter(column => column.key === 'PRI');
    const direction = requested[0]?.direction || 'ASC';
    const entries = [...requested, ...primary.filter(column => !requested.some(entry => entry.column === column.name)).map(column => ({ column: column.name, direction }))];
    return { requested, entries, keyset: primary.length > 0 && requested.every(entry => primary.some(column => column.name === entry.column)) };
  }

  function visible(input, columns) {
    // Visibility is presentation only. Keep every row field/PK/original snapshot
    // available for editing; never use it to authorize a write or shape metadata.
    if (!Array.isArray(input)) return columns;
    const names = new Set(input), selected = columns.filter(column => names.has(column.name));
    return selected.length ? selected : columns;
  }

  return Object.freeze({ normalizeSorts, order, visible });
}));
