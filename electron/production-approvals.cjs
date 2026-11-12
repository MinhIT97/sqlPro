'use strict';

const crypto = require('node:crypto');

class ProductionApprovals {
  constructor({ ttlMs = 120000, limit = 32, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.limit = limit;
    this.now = now;
    this.pending = new Map();
  }

  prune() {
    for (const [token, entry] of this.pending) {
      if (entry.expiresAt <= this.now()) this.pending.delete(token);
    }
  }

  issue(preview, execute) {
    this.prune();
    if (this.pending.size >= this.limit) throw Object.assign(new Error('Có quá nhiều thao tác đang chờ xác nhận. Hãy đóng các hộp thoại cũ.'), {code:'PRODUCTION_APPROVAL_BUSY'});
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = this.now() + this.ttlMs;
    this.pending.set(token, {execute, expiresAt});
    return Object.assign(new Error('Cần xem trước và xác nhận thao tác trên Production.'), {
      code:'PRODUCTION_CONFIRM_REQUIRED', preview:{...preview,token,expiresAt}
    });
  }

  async confirm(token) {
    const entry = this.pending.get(token);
    // Consume before any await, including failures. A token cannot replay a write.
    this.pending.delete(token);
    if (!entry || entry.expiresAt <= this.now()) throw Object.assign(new Error('Xác nhận đã hết hạn hoặc đã sử dụng. Hãy thực hiện lại để xem trước.'), {code:'PRODUCTION_APPROVAL_EXPIRED'});
    return entry.execute();
  }

  cancel(token) {
    this.pending.delete(token);
    return {cancelled:true};
  }
}

// SQL preview never interpolates values. Mask literals/comments and bound text.
function redactSql(sql) {
  const source = String(sql || '');
  let result = '';
  const unsupported = () => Object.assign(new Error('Không thể xem trước SQL này chắc chắn: hãy bỏ executable comment/hint, dùng backtick cho identifier và nháy đơn lặp đôi cho chuỗi. Có thể dùng form bản ghi với tham số để nhập giá trị chứa backslash.'),{code:'PRODUCTION_SQL_PREVIEW_UNSUPPORTED'});
  for (let i = 0; i < source.length;) {
    const c = source[i];
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/',i+2);
      if (/^\/\*(?:!|M!|\+)/i.test(source.slice(i,i+5)) || end < 0 || source.slice(i+2,end).includes('/*')) throw unsupported();
      result += ' /* nội dung ẩn */ ';
      i = end < 0 ? source.length : end+2;
    } else if (c === '#' || (source.startsWith('--',i) && (!source[i+2] || source.charCodeAt(i+2) <= 32))) {
      while (i < source.length && !/[\r\n]/.test(source[i])) i += 1;
      result += ' -- nội dung ẩn\n';
    } else if (c === "'" || c === '"' || c === '`') {
      if (c === '"') throw unsupported();
      const start = i++;
      let closed = false;
      while (i < source.length) {
        if (source[i] === '\\' && c !== '`') throw unsupported();
        if (source[i++] !== c) continue;
        if (source[i] === c) {i += 1;continue;}
        closed = true;break;
      }
      if (!closed) throw unsupported();
      result += c === '`' ? source.slice(start,i) : '?';
    } else if (/[0-9]/.test(c) && (i === 0 || !/[A-Za-z0-9_$]/.test(source[i-1]))) {
      const number = /^(?:0x[0-9a-f]+|0b[01]+|\d+(?:\.\d*)?(?:e[+-]?\d+)?)/i.exec(source.slice(i));
      result += '?'; i += number ? number[0].length : 1;
    } else {result += c;i += 1;}
  }
  return result.slice(0,12000) + (source.length > 12000 ? '\n… Bản xem trước có giới hạn; kiểm tra toàn bộ SQL trong editor.' : '');
}

function parameterSummary(params) {
  return params.slice(0,100).map((value,index) => ({
    position:index+1,
    type:value === null ? 'NULL' : Buffer.isBuffer(value) ? 'binary' : typeof value,
    value:'Đã ẩn'
  }));
}

module.exports = {ProductionApprovals,redactSql,parameterSummary};
