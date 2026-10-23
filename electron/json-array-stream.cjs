'use strict';

class JsonArrayStreamParser {
  constructor() {
    this.state = 'before';
    this.buffer = '';
    this.elements = [];
    this.depth = 0;
    this.inString = false;
    this.escape = false;
    this.primitive = false;
    this.started = false;
    this.line = 1;
    this.hasEntries = false;
    this.awaitingValue = true;
  }

  push(chunk) {
    let input = String(chunk || '');
    if (!this.started && input.length) {
      if (input.charCodeAt(0) === 0xfeff) input = input.slice(1);
      if (input.length) this.started = true;
    }
    this.elements = [];
    for (let index = 0; index < input.length; index += 1) {
      const character = input[index];
      if (character === '\n') this.line += 1;
      if (this.state === 'done') {
        if (!/\s/.test(character)) {
          throw new Error(`JSON có dữ liệu ngoài mảng ở dòng ${this.line}.`);
        }
        continue;
      }
      if (this.state === 'before') {
        if (/\s/.test(character)) continue;
        if (character === '[') {
          this.state = 'array';
          continue;
        }
        throw new Error(`JSON phải là một mảng; ký tự không hợp lệ ở dòng ${this.line}.`);
      }
      if (!this.buffer.length && !this.inString) {
        if (/\s/.test(character)) continue;
        if (character === ',') {
          if (this.awaitingValue) {
            throw new Error(`JSON không hợp lệ ở dòng ${this.line}: dấu phẩy thừa hoặc phần tử rỗng.`);
          }
          this.awaitingValue = true;
          continue;
        }
        if (character === ']') {
          if (this.awaitingValue && this.hasEntries) {
            throw new Error(`JSON không hợp lệ ở dòng ${this.line}: dấu phẩy thừa trước ].`);
          }
          this.state = 'done';
          continue;
        }
        if (!this.awaitingValue) {
          throw new Error(`JSON không hợp lệ ở dòng ${this.line}: thiếu dấu phẩy giữa các phần tử.`);
        }
        this.startValue(character);
        continue;
      }
      this.appendValue(character);
    }
    return this.takeElements();
  }

  end() {
    if (this.inString || this.escape) {
      throw new Error(`JSON không hợp lệ: chuỗi chưa đóng ở dòng ${this.line}.`);
    }
    if (this.state === 'before') {
      throw new Error('Tệp JSON rỗng hoặc không bắt đầu bằng mảng.');
    }
    if (this.state !== 'done') {
      if (this.buffer.trim() || this.depth > 0) {
        throw new Error(`JSON không hợp lệ: phần tử chưa hoàn chỉnh ở dòng ${this.line}.`);
      }
      throw new Error('JSON không hợp lệ: mảng chưa được đóng bằng ].');
    }
    return this.takeElements();
  }

  startValue(character) {
    this.buffer = character;
    this.escape = false;
    this.awaitingValue = false;
    if (character === '"') {
      this.inString = true;
      this.primitive = true;
      return;
    }
    if (character === '{' || character === '[') {
      this.depth = 1;
      this.primitive = false;
      return;
    }
    this.depth = 0;
    this.primitive = true;
  }

  appendValue(character) {
    if (this.inString) {
      this.buffer += character;
      if (this.escape) {
        this.escape = false;
      } else if (character === '\\') {
        this.escape = true;
      } else if (character === '"') {
        this.inString = false;
        if (this.primitive) this.finishElement();
      }
      return;
    }
    if (this.primitive) {
      if (character === ',' || character === ']') {
        this.finishElement();
        if (character === ']') this.state = 'done';
        else this.awaitingValue = true;
        return;
      }
      this.buffer += character;
      return;
    }
    this.buffer += character;
    if (character === '"') {
      this.inString = true;
    } else if (character === '{' || character === '[') {
      this.depth += 1;
    } else if (character === '}' || character === ']') {
      this.depth -= 1;
      if (this.depth === 0) this.finishElement();
    }
  }

  finishElement() {
    const text = this.buffer.trim();
    this.buffer = '';
    this.depth = 0;
    this.primitive = false;
    this.inString = false;
    this.escape = false;
    this.awaitingValue = false;
    if (!text) return;
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(`JSON không hợp lệ ở phần tử ${this.elements.length + 1} (dòng ${this.line}).`);
    }
    this.hasEntries = true;
    this.elements.push(value);
  }

  takeElements() {
    if (!this.elements.length) return [];
    const elements = this.elements;
    this.elements = [];
    return elements;
  }
}

module.exports = { JsonArrayStreamParser };
