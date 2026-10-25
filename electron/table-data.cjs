'use strict';

// SQL planning and bounded count cache are independent of IPC and renderer state.
class TableDataService {
  constructor({ columns, raw, quoteId, tableRef, serializeRow, keyParameter, searchParameter, now = Date.now }) {
    Object.assign(this, { columns, raw, quoteId, tableRef, serializeRow, keyParameter, searchParameter, now });
    this.counts = new Map();
  }

  invalidate() { this.counts.clear(); }

  async plan(options) {
    const { database, table } = options;
    const columns = await this.columns(database, table);
    if (!columns.length) throw Object.assign(new Error(`Không tìm thấy bảng ${table}.`), { code: 'TABLE_NOT_FOUND' });
    const term = String(options.search || '').trim().slice(0, 200);
    const selected = options.searchColumn ? columns.filter((column) => column.name === options.searchColumn) : columns;
    if (!selected.length) throw Object.assign(new Error('Cột tìm kiếm không hợp lệ.'), { code: 'INVALID_COLUMN' });
    const searchMode = options.searchMode === 'exact' ? 'exact' : 'contains';
    const clauses = term ? selected.map((column) => searchMode === 'exact'
      ? `${options.searchColumn ? this.quoteId(column.name) : `CAST(${this.quoteId(column.name)} AS CHAR)`} = ?` : `CAST(${this.quoteId(column.name)} AS CHAR) LIKE ?`) : [];
    const params = term ? selected.map((column) => searchMode === 'exact'
      ? (options.searchColumn ? this.searchParameter(term, column) : term) : `%${term}%`) : [];
    const where = clauses.length ? `(${clauses.join(' OR ')})` : '';
    const key = JSON.stringify([database, table, term, options.searchColumn || '', searchMode]);
    const cached = this.counts.get(key);
    const total = cached && cached.until > this.now() ? cached.total : null;
    return { columns, params: clauses.length ? params : [], where, key, total };
  }

  async count(options) {
    const plan = await this.plan(options);
    if (plan.total !== null && !options.force) return { total: plan.total, cached: true };
    const { rows } = await this.raw(`SELECT /*+ MAX_EXECUTION_TIME(3000) */ COUNT(*) AS total FROM ${this.tableRef(options.database, options.table)}${plan.where ? ` WHERE ${plan.where}` : ''}`, plan.params);
    const total = Number(rows[0]?.total || 0);
    if (this.counts.size >= 100) this.counts.delete(this.counts.keys().next().value);
    this.counts.set(plan.key, { total, until: this.now() + 15000 });
    return { total, cached: false };
  }

  async read(options) {
    const plan = await this.plan(options);
    const page = Math.max(1, Math.min(1000000, Math.trunc(Number(options.page) || 1)));
    const pageSize = Math.max(1, Math.min(500, Math.trunc(Number(options.pageSize) || 100)));
    const primary = plan.columns.filter((column) => column.key === 'PRI');
    const sorted = plan.columns.find((column) => column.name === options.orderBy);
    const keys = sorted ? [sorted, ...primary.filter((column) => column !== sorted)] : primary;
    const direction = sorted && options.orderDir === 'DESC' ? 'DESC' : 'ASC';
    const signature = JSON.stringify([plan.key, pageSize, keys.map((column) => column.name), direction]);
    const input = options.cursor;
    const usable = primary.length > 0 && (!sorted || sorted.key === 'PRI') && input
      && input.signature === signature && input.page === page && ['next', 'previous'].includes(input.direction)
      && Array.isArray(input.values) && input.values.length === keys.length;
    const backwards = usable && input.direction === 'previous';
    const parts = plan.where ? [plan.where] : [];
    const params = [...plan.params];
    if (usable) {
      const greater = (direction === 'ASC') !== backwards;
      const terms = keys.map((column, index) => {
        const equal = keys.slice(0, index).map((previous, position) => {
          params.push(this.keyParameter(input.values[position], previous));
          return `${this.quoteId(previous.name)} = ?`;
        });
        params.push(this.keyParameter(input.values[index], column));
        return `(${[...equal, `${this.quoteId(column.name)} ${greater ? '>' : '<'} ?`].join(' AND ')})`;
      });
      parts.push(`(${terms.join(' OR ')})`);
    }
    const sqlDirection = backwards ? (direction === 'ASC' ? 'DESC' : 'ASC') : direction;
    const order = keys.length ? ` ORDER BY ${keys.map((column) => `${this.quoteId(column.name)} ${sqlDirection}`).join(', ')}` : '';
    let sql = `SELECT * FROM ${this.tableRef(options.database, options.table)}${parts.length ? ` WHERE ${parts.join(' AND ')}` : ''}${order} LIMIT ?`;
    params.push(pageSize + 1);
    if (!usable) { sql += ' OFFSET ?'; params.push((page - 1) * pageSize); }
    const { result } = await this.raw(sql, params);
    const extra = result.length > pageSize;
    let rows = result.slice(0, pageSize);
    if (backwards) rows = rows.reverse();
    const cursor = (row, nextPage, nextDirection) => row && primary.length > 0 && (!sorted || sorted.key === 'PRI') ? {
      signature, page: nextPage, direction: nextDirection,
      values: keys.map((column) => Buffer.isBuffer(row[column.name]) ? `0x${row[column.name].toString('hex')}` : row[column.name])
    } : null;
    return {
      columns: plan.columns, primaryKey: primary.map((column) => column.name), rows: rows.map(this.serializeRow),
      total: plan.total, page, pageSize, hasMore: backwards ? rows.length > 0 : extra,
      nextCursor: cursor(rows.at(-1), page + 1, 'next'), previousCursor: page > 1 ? cursor(rows[0], page - 1, 'previous') : null,
      pagination: usable ? 'keyset' : 'offset'
    };
  }
}

module.exports = { TableDataService };
