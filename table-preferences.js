(function attachTablePreferences(root, factory) {
  const common = typeof module === 'object' && module.exports;
  const api = factory(common ? require('./table-view.js') : root.SqlTableView, common ? require('./table-filters.js') : root.SqlTableFilters);
  if (common) module.exports = api;
  if (root) root.SqlTablePreferences = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createTablePreferences(View, Filters) {
  'use strict';

  const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_TABLE_PREFERENCE' }); };
  function fields(value, names) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !names.includes(key)) || names.some(key => !Object.hasOwn(value, key))) fail('Cấu hình bảng không hợp lệ.');
  }
  function scope(input) {
    fields(input, ['profileId', 'database', 'table']);
    if ([input.profileId, input.database, input.table].some(value => typeof value !== 'string' || !value || value.length > 256 || value.includes('\0'))) fail('Đích cấu hình bảng không hợp lệ.');
    return Object.freeze({ profileId: input.profileId, database: input.database, table: input.table });
  }
  function metadata(input) {
    if (!Array.isArray(input) || !input.length || input.length > 1024) fail('Metadata cấu hình bảng vượt giới hạn.');
    const seen = new Set();
    return Object.freeze(Array.from(input, column => {
      fields(column, ['name', 'type']);
      if (typeof column.name !== 'string' || !column.name || column.name.length > 64 || column.name.includes('\0') || seen.has(column.name)
          || typeof column.type !== 'string' || !column.type || column.type.length > 512) fail('Metadata cấu hình bảng không hợp lệ.');
      seen.add(column.name);
      return Object.freeze({ name: column.name, type: column.type });
    }));
  }
  function normalize(input, currentColumns) {
    fields(input, ['version', 'columns', 'visibleColumns', 'sorts', 'filters']);
    if (input.version !== 1) fail('Phiên bản cấu hình bảng chưa được hỗ trợ.');
    const columns = metadata(input.columns);
    if (currentColumns && JSON.stringify(columns) !== JSON.stringify(metadata(currentColumns.map(column => ({ name: column.name, type: column.type }))))) fail('Cấu trúc bảng đã thay đổi. Cấu hình đã lưu chưa được áp dụng.');
    const names = new Set(columns.map(column => column.name));
    let visibleColumns = null;
    if (input.visibleColumns !== null) {
      if (!Array.isArray(input.visibleColumns) || !input.visibleColumns.length || input.visibleColumns.length > columns.length
          || Array.from(input.visibleColumns).some(name => !names.has(name)) || new Set(input.visibleColumns).size !== input.visibleColumns.length) fail('Cột hiển thị đã lưu không hợp lệ.');
      visibleColumns = Object.freeze([...input.visibleColumns]);
    }
    const sorts = View.normalizeSorts(input.sorts, columns);
    let filters = null;
    if (input.filters !== null) {
      fields(input.filters, ['search', 'searchColumn', 'searchMode', 'filterTree']);
      const { search, searchColumn, searchMode, filterTree } = input.filters;
      if (typeof search !== 'string' || search.length > 200 || search !== search.trim()
          || searchColumn !== null && !names.has(searchColumn)
          || !['contains', 'exact', 'prefix', 'is-null', 'not-null'].includes(searchMode)
          || ['is-null', 'not-null'].includes(searchMode) && (searchColumn === null || search !== '')
          || filterTree === undefined) fail('Bộ lọc đã lưu không hợp lệ.');
      filters = Object.freeze({ search, searchColumn, searchMode, filterTree: Filters.compile(filterTree, columns).tree });
    }
    return Object.freeze({ version: 1, columns, visibleColumns, sorts, filters });
  }
  function capture(state, columns, includeFilters = false) {
    if (typeof includeFilters !== 'boolean') fail('Lựa chọn lưu bộ lọc không hợp lệ.');
    return normalize({ version: 1, columns: columns.map(column => ({ name: column.name, type: column.type })),
      visibleColumns: state.visibleColumns || null, sorts: state.sorts || [],
      filters: includeFilters ? { search: (state.search || '').trim().slice(0, 200), searchColumn: state.searchColumn || null,
        searchMode: state.searchMode || 'contains', filterTree: state.filterTree || null } : null });
  }
  return Object.freeze({ scope, normalize, capture });
}));
