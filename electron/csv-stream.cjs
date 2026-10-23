'use strict';

class CsvStreamParser {
  constructor({ delimiter = ',', quote = '"' } = {}) {
    if (typeof delimiter !== 'string' || delimiter.length !== 1) {
      throw new Error('Delimiter CSV không hợp lệ.');
    }
    if (typeof quote !== 'string' || quote.length !== 1) {
      throw new Error('Ký tự quote CSV không hợp lệ.');
    }
    this.delimiter = delimiter;
    this.quote = quote;
    this.field = '';
    this.row = [];
    this.rows = [];
    this.quoted = false;
    this.afterQuote = false;
    this.fieldStarted = false;
    this.rowStarted = false;
    this.pendingCr = false;
    this.started = false;
    this.line = 1;
  }

  push(chunk) {
    let input = String(chunk || '');
    if (!this.started && input.length) {
      if (input.charCodeAt(0) === 0xfeff) input = input.slice(1);
      if (input.length) this.started = true;
    }
    this.rows = [];
    for (let index = 0; index < input.length; index += 1) {
      const character = input[index];
      if (this.pendingCr) {
        this.pendingCr = false;
        if (character === '\n') continue;
      }
      if (this.quoted) {
        if (character === this.quote) {
          if (input[index + 1] === this.quote) {
            this.field += this.quote;
            index += 1;
          } else {
            this.quoted = false;
            this.afterQuote = true;
          }
        } else {
          this.field += character;
          if (character === '\n') this.line += 1;
        }
        continue;
      }
      if (this.afterQuote) {
        if (character === this.delimiter) {
          this.endField();
          this.afterQuote = false;
        } else if (character === '\n') {
          this.endRow();
          this.line += 1;
          this.afterQuote = false;
        } else if (character === '\r') {
          this.endRow();
          this.line += 1;
          this.afterQuote = false;
          this.pendingCr = true;
        } else if (character === ' ' || character === '\t') {
          // tolerate trailing whitespace after a closing quote
        } else {
          throw new Error(`CSV không hợp lệ ở dòng ${this.line}: ký tự sau dấu ngoặc kép.`);
        }
        continue;
      }
      if (!this.rowStarted && !this.fieldStarted && (character === '\n' || character === '\r')) {
        this.line += 1;
        if (character === '\r') this.pendingCr = true;
        continue;
      }
      if (!this.fieldStarted) {
        if (character === this.quote) {
          this.quoted = true;
          this.fieldStarted = true;
          this.rowStarted = true;
          continue;
        }
        this.fieldStarted = true;
        this.rowStarted = true;
      }
      if (character === this.delimiter) {
        this.endField();
      } else if (character === '\n') {
        this.endRow();
        this.line += 1;
      } else if (character === '\r') {
        this.endRow();
        this.line += 1;
        this.pendingCr = true;
      } else if (character === this.quote) {
        throw new Error(`CSV không hợp lệ ở dòng ${this.line}: dấu ngoặc kép trong ô chưa được escape.`);
      } else {
        this.field += character;
      }
    }
    return this.takeRows();
  }

  end() {
    if (this.quoted) throw new Error(`CSV không hợp lệ: chuỗi trích dẫn chưa đóng ở dòng ${this.line}.`);
    this.pendingCr = false;
    if (this.rowStarted || this.row.length || this.fieldStarted || this.field !== '') {
      this.endRow();
    }
    return this.takeRows();
  }

  endField() {
    this.row.push(this.field);
    this.field = '';
    this.fieldStarted = false;
  }

  endRow() {
    if (this.rowStarted || this.row.length || this.fieldStarted || this.field !== '') {
      this.row.push(this.field);
      this.rows.push(this.row);
    }
    this.row = [];
    this.field = '';
    this.fieldStarted = false;
    this.rowStarted = false;
    this.afterQuote = false;
  }

  takeRows() {
    if (!this.rows.length) return [];
    const rows = this.rows;
    this.rows = [];
    return rows;
  }
}

module.exports = { CsvStreamParser };
