(function attachTableFilters(root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./row-values.js') : root.SqlRowValues);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SqlTableFilters = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createTableFilters(RowValues) {
  'use strict';

  const limits = Object.freeze({ depth: 3, groups: 8, rules: 20, value: 200 });
  const labels = Object.freeze({ eq: 'Bằng', ne: 'Khác', gt: 'Lớn hơn', gte: 'Lớn hơn hoặc bằng', lt: 'Nhỏ hơn', lte: 'Nhỏ hơn hoặc bằng', between: 'Trong khoảng', contains: 'Chứa', prefix: 'Bắt đầu bằng', 'is-null': 'Là NULL', 'not-null': 'Khác NULL' });
  const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_FILTER' }); };
  const quote = value => '`' + value.replace(/`/g, '``') + '`';
  const nullOperators = ['is-null', 'not-null'];

  function operators(column) {
    if (!column?.type) return [...nullOperators];
    const base = RowValues.describe(column).base;
    if (/^(?:char|varchar|tinytext|text|mediumtext|longtext|enum|set)$/.test(base)) return ['eq', 'ne', 'contains', 'prefix', ...nullOperators];
    if (/^(?:tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|bool|boolean|year|date|datetime|timestamp|time)$/.test(base)) return ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', ...nullOperators];
    return [...nullOperators];
  }

  function compile(input, columns, { quoteId = quote, coerceValue = (value, column) => RowValues.normalizeValue(column, value) } = {}) {
    if (input === null || input === undefined) return { tree: null, where: '', params: [], key: 'null', rules: 0 };
    const byName = new Map();
    for (const column of columns) {
      if (byName.has(column.name)) fail('Metadata cột bị trùng; hãy làm mới bảng.');
      byName.set(column.name, column);
    }
    let groups = 0, rules = 0;
    const params = [], seen = new Set();
    const value = (raw, column) => {
      if (typeof raw !== 'string' || raw.length > limits.value) fail(`Giá trị lọc phải là chuỗi tối đa ${limits.value} ký tự.`);
      try {
        // Generated columns may be read; the row editor's write prohibition
        // must not prevent a predicate on their computed value.
        return coerceValue(raw, { ...column, extra: '' });
      } catch (error) { fail(error.message); }
    };
    const visit = (node, depth, root = false) => {
      if (!node || typeof node !== 'object' || Array.isArray(node) || seen.has(node)) fail('Cấu trúc nhóm lọc không hợp lệ.');
      seen.add(node);
      const keys = Object.keys(node);
      if (Object.hasOwn(node, 'items')) {
        if (depth > limits.depth || ++groups > limits.groups) fail('Bộ lọc vượt giới hạn 3 mức hoặc 8 nhóm.');
        if (keys.some(key => !(root ? ['version', 'op', 'items'] : ['op', 'items']).includes(key))
            || !Object.hasOwn(node, 'op') || root && (!Object.hasOwn(node, 'version') || node.version !== 1) || !['AND', 'OR'].includes(node.op)
            || !Array.isArray(node.items) || !node.items.length || node.items.length > limits.rules) fail('Nhóm cần AND/OR và ít nhất một điều kiện hợp lệ.');
        const items = Array.from(node.items, item => visit(item, depth + 1));
        return { tree: Object.freeze({ ...(root ? { version: 1 } : {}), op: node.op, items: Object.freeze(items.map(item => item.tree)) }), where: `(${items.map(item => item.where).join(` ${node.op} `)})` };
      }
      if (root || ++rules > limits.rules || !Object.hasOwn(node, 'column') || !Object.hasOwn(node, 'operator')
          || keys.some(key => !['column', 'operator', 'value'].includes(key))) fail('Chỉ hỗ trợ tối đa 20 điều kiện trong nhóm gốc.');
      const column = byName.get(node.column);
      if (!column || !operators(column).includes(node.operator)) fail('Cột hoặc toán tử lọc không hợp lệ cho kiểu dữ liệu.');
      const reference = quoteId(column.name), operator = node.operator;
      if (nullOperators.includes(operator)) {
        if (Object.hasOwn(node, 'value')) fail('Điều kiện NULL không nhận giá trị.');
        return { tree: Object.freeze({ column: column.name, operator }), where: `${reference} IS ${operator === 'not-null' ? 'NOT ' : ''}NULL` };
      }
      if (!Object.hasOwn(node, 'value')) fail('Điều kiện thiếu giá trị.');
      let normalized, where;
      if (operator === 'between') {
        if (!Array.isArray(node.value) || node.value.length !== 2) fail('Khoảng lọc cần đúng hai giá trị.');
        normalized = Object.freeze(Array.from(node.value, raw => value(raw, column)));
        params.push(...normalized); where = `${reference} BETWEEN ? AND ?`;
      } else if (operator === 'contains' || operator === 'prefix') {
        // LIKE input is a search string, not an ENUM/SET assignment. Keep empty
        // strings and whitespace exact; never silently drop a rule.
        if (typeof node.value !== 'string' || node.value.length > limits.value) fail('Giá trị tìm kiếm vượt giới hạn hoặc không hợp lệ.');
        normalized = node.value;
        const literal = normalized.replace(/[=%_]/g, character => `=${character}`);
        params.push(operator === 'prefix' ? `${literal}%` : `%${literal}%`);
        where = `${reference} LIKE ? ESCAPE '='`;
      } else {
        normalized = value(node.value, column); params.push(normalized);
        where = `${reference} ${{ eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[operator]} ?`;
      }
      return { tree: Object.freeze({ column: column.name, operator, value: normalized }), where };
    };
    const result = visit(input, 1, true);
    return { ...result, params, key: JSON.stringify(result.tree), rules };
  }

  return Object.freeze({ compile, operators, labels, limits });
}));
