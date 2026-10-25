'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SqlQueryResults = api;
}(typeof globalThis === 'object' ? globalThis : this, () => {
  const compareText = new Intl.Collator(undefined, { numeric: true }).compare;
  function orderedRows(rows, column, direction = 'ASC') {
    const indexed = rows.map((row, origIndex) => ({ row, origIndex }));
    if (!Number.isInteger(column) || column < 0) return indexed;
    const sign = direction === 'DESC' ? -1 : 1;
    return indexed.sort((a, b) => {
      const left = a.row[column], right = b.row[column];
      if (left == null) return right == null ? 0 : -sign;
      if (right == null) return sign;
      if (typeof left === 'number' && typeof right === 'number') return (left - right) * sign;
      return compareText(String(left), String(right)) * sign;
    });
  }
  return Object.freeze({ orderedRows });
}));
