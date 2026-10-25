'use strict';

class ResultBudget {
  constructor({ rows = 5000, bytes = 8 * 1024 * 1024 } = {}) {
    this.rowLimit = Math.max(0, rows);
    this.byteLimit = Math.max(0, bytes);
    this.rows = [];
    this.bytes = 2;
    this.reason = null;
  }

  add(row) {
    if (this.reason) return false;
    if (this.rows.length >= this.rowLimit) { this.reason = 'row-limit'; return false; }
    const remaining = this.byteLimit - this.bytes;
    if (row.some((value) => typeof value === 'string' && Buffer.byteLength(value) > remaining)) {
      this.reason = 'byte-limit'; return false;
    }
    const bytes = Buffer.byteLength(JSON.stringify(row)) + (this.rows.length ? 1 : 0);
    if (bytes > remaining) { this.reason = 'byte-limit'; return false; }
    this.bytes += bytes;
    this.rows.push(row);
    return true;
  }
}

module.exports = { ResultBudget };
