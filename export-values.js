'use strict';

(function exposeExportValues(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SqlExportValues = api;
}(typeof globalThis === 'object' ? globalThis : this, () => {
  function csvField(value, delimiter = ',') {
    if (value === null || value === undefined) return '\\N';
    let text = String(value);
    if (text === '\\N') text = '\\\\N';
    if (text.includes('"') || text.includes(delimiter) || /[\r\n]/.test(text) || /^\s|\s$/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  }

  function uniqueColumnNames(names) {
    const used = new Set();
    return names.map((name) => {
      const base = String(name === null || name === undefined ? '' : name);
      let candidate = base;
      let suffix = 2;
      while (used.has(candidate)) {
        candidate = `${base}_${suffix}`;
        suffix += 1;
      }
      used.add(candidate);
      return candidate;
    });
  }

  function jsonField(value, column = {}) {
    if (value === null || value === undefined) return 'null';
    if (/^json\b/i.test(column.type || '') && typeof value === 'string') {
      JSON.parse(value);
      return value;
    }
    return JSON.stringify(value);
  }

  return Object.freeze({ csvField, uniqueColumnNames, jsonField });
}));
