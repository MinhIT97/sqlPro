'use strict';

const validName = value => typeof value === 'string' && value.length > 0 && value.length <= 64 && !/[\u0000-\u001f\u007f]/.test(value);

function projectIndexes(list) {
  if (!Array.isArray(list) || list.length > 128) return null;
  const names = new Set(), result = [];
  for (const index of list) {
    if (!index || !validName(index.name) || !['primary', 'unique', 'index'].includes(index.kind)
        || (index.kind === 'primary' ? index.name !== 'PRIMARY' : index.name.toLowerCase() === 'primary')) return null;
    const name = index.name.toLowerCase();
    if (names.has(name)) return null;
    names.add(name);
    if (!Array.isArray(index.columns) || !index.columns.length || index.columns.length > 16) return null;
    const columns = [], seen = new Set();
    for (const part of index.columns) {
      if (!part || !validName(part.name) || part.prefixLength !== null && (!Number.isInteger(part.prefixLength) || part.prefixLength < 1 || part.prefixLength > 65535)) return null;
      const column = part.name.toLowerCase();
      if (seen.has(column)) return null;
      seen.add(column); columns.push({ name: part.name, prefixLength: part.prefixLength });
    }
    result.push({ name: index.name, kind: index.kind, columns });
  }
  return result;
}

// Conservative structural check: require the entire PRIMARY/UNIQUE key in
// order, without prefix parts. Callers distinguish source evidence from target
// observations; this does not validate server rules, visibility flags or data.
function reviewReferencedIndex(definitions, columns) {
  const indexes = projectIndexes(definitions);
  if (!indexes || !Array.isArray(columns) || !columns.length || columns.length > 16 || columns.some(name => !validName(name))
      || new Set(columns.map(name => name.toLowerCase())).size !== columns.length) {
    return { status: 'blocked', code: 'FK_REFERENCED_INDEX_NOT_REVIEWED' };
  }
  const index = indexes.find(index => ['primary', 'unique'].includes(index.kind) && index.columns.length === columns.length
    && index.columns.every((part, position) => part.prefixLength === null && part.name.toLowerCase() === columns[position].toLowerCase()));
  if (!index) return { status: 'blocked', code: 'FK_REFERENCED_UNIQUE_KEY_NOT_FOUND' };
  return { status: 'matched', code: 'FK_REFERENCED_UNIQUE_KEY_MATCHED', name: index.name, kind: index.kind,
    columns: index.columns.map(part => part.name) };
}

module.exports = { projectIndexes, reviewReferencedIndex };
