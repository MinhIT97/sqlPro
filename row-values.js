'use strict';

(function exposeRowValues(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SqlRowValues = api;
}(typeof globalThis === 'object' ? globalThis : this, () => {
  const INTEGER_BITS = { tinyint: 8, smallint: 16, mediumint: 24, int: 32, integer: 32, bigint: 64 };
  const SPATIAL = /^(geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection)$/;

  function parseChoices(type) {
    const body = String(type).slice(String(type).indexOf('(') + 1, String(type).lastIndexOf(')'));
    const choices = [];
    let index = 0;
    while (index < body.length) {
      while (/\s/.test(body[index] || '') && index < body.length) index += 1;
      const quote = body[index++];
      if (quote !== "'" && quote !== '"') return [];
      let value = '';
      let closed = false;
      while (index < body.length) {
        const char = body[index++];
        if (char === '\\' && index < body.length) {
          const next = body[index++];
          value += ({ '0': '\0', b: '\b', n: '\n', r: '\r', t: '\t', Z: '\x1a' })[next] ?? next;
        } else if (char === quote) {
          if (body[index] === quote) { value += quote; index += 1; }
          else { closed = true; break; }
        } else value += char;
      }
      if (!closed) return [];
      choices.push(value);
      while (/\s/.test(body[index] || '') && index < body.length) index += 1;
      if (index < body.length && body[index++] !== ',') return [];
    }
    return choices;
  }

  function describe(column = {}, value) {
    const type = String(column.type || 'text').toLowerCase();
    const base = /^\w+/.exec(type)?.[0] || 'text';
    const args = /\((\d+)(?:\s*,\s*(\d+))?\)/.exec(type);
    const spec = { type, base, kind: 'text', nullable: column.nullable === 'YES', precision: 0, choices: [], readOnly: false, hint: '' };
    if (INTEGER_BITS[base]) spec.kind = 'integer';
    else if (['decimal', 'numeric'].includes(base)) spec.kind = 'decimal';
    else if (['float', 'double', 'real'].includes(base)) spec.kind = 'float';
    else if (['bool', 'boolean'].includes(base)) { spec.kind = 'boolean'; spec.choices = ['0', '1']; }
    else if (base === 'bit') { spec.kind = 'bit'; spec.width = Number(args?.[1] || 1); }
    else if (base === 'year') spec.kind = 'year';
    else if (['date', 'datetime', 'timestamp', 'time'].includes(base)) {
      spec.kind = base === 'date' ? 'date' : base === 'time' ? 'time' : 'datetime';
      spec.precision = Math.min(6, Number(args?.[1] || 0));
      spec.hint = spec.kind === 'date' ? 'YYYY-MM-DD · bấm biểu tượng lịch để chọn ngày.'
        : spec.kind === 'time' ? 'HH:mm:ss · hỗ trợ thời lượng âm, hơn 24 giờ và giây lẻ.'
          : 'YYYY-MM-DD HH:mm:ss · giữ nguyên giờ theo phiên database, không đổi múi giờ.';
    } else if (['enum', 'set'].includes(base)) { spec.kind = base; spec.choices = parseChoices(column.type); }
    else if (base === 'json') { spec.kind = 'json'; spec.hint = 'Nhập JSON hợp lệ. JSON null khác với SQL NULL.'; }
    else if (/^(binary|varbinary|tinyblob|blob|mediumblob|longblob)$/.test(base)) {
      spec.kind = 'binary'; spec.hint = 'Hex: 0x0123abcd. 0x là dữ liệu nhị phân rỗng.';
      if (typeof value === 'string' && value.includes('…')) { spec.readOnly = true; spec.hint = 'Chỉ có bản xem trước nhị phân. Dùng SQL hoặc nhập tệp để thay đổi dữ liệu đầy đủ.'; }
    } else if (SPATIAL.test(base)) { spec.readOnly = true; spec.hint = 'Dữ liệu không gian: dùng SQL với hàm ST_GeomFromText/ST_GeomFromWKB để thay đổi.'; }
    if (INTEGER_BITS[base]) {
      const bits = BigInt(INTEGER_BITS[base]);
      const unsigned = /\bunsigned\b/.test(type);
      spec.min = (unsigned ? 0n : -(1n << (bits - 1n))).toString();
      spec.max = (unsigned ? (1n << bits) - 1n : (1n << (bits - 1n)) - 1n).toString();
    }
    if (spec.kind === 'decimal') { spec.digits = Number(args?.[1] || 10); spec.scale = Number(args?.[2] || 0); spec.hint = `Số chính xác, tối đa ${spec.digits} chữ số, ${spec.scale} chữ số sau dấu chấm.`; }
    if (['char', 'varchar', 'binary', 'varbinary'].includes(base)) spec.length = args ? Number(args[1]) : null;
    if (/(virtual|stored) generated/i.test(column.extra || '')) { spec.readOnly = true; spec.hint = 'Cột generated được database tự tính toán.'; }
    return spec;
  }

  function displayValue(column, value) {
    if (value === null || value === undefined) return '';
    const spec = describe(column, value);
    if (spec.kind === 'bit' && /^0x[0-9a-f]+$/i.test(String(value))) return BigInt(String(value)).toString(2).padStart(spec.width, '0');
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  function validDate(value, allowZero = true) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    const [, yearText, monthText, dayText] = match;
    const year = Number(yearText), month = Number(monthText), day = Number(dayText);
    if (month > 12 || day > 31) return false;
    if (month === 0 || day === 0 || year === 0) return allowZero;
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  }

  function normalizeValue(column, raw) {
    const spec = describe(column, raw);
    const invalid = (message) => { throw new Error(`Cột "${column.name || ''}": ${message}`); };
    if (raw === null || raw === undefined) {
      if (!spec.nullable) invalid('không cho phép NULL.');
      return null;
    }
    const value = typeof raw === 'string' ? raw : String(raw);
    const text = value.trim();
    if (spec.kind === 'integer') {
      if (!/^[+-]?\d+$/.test(text)) invalid('cần nhập số nguyên.');
      const number = BigInt(text);
      if (number < BigInt(spec.min) || number > BigInt(spec.max)) invalid(`giá trị phải từ ${spec.min} đến ${spec.max}.`);
      return text;
    }
    if (spec.kind === 'year') {
      if (!/^\d{1,4}$/.test(text) || (Number(text) !== 0 && (Number(text) < 1901 || Number(text) > 2155))) invalid('YEAR phải là 0 hoặc từ 1901 đến 2155.');
      return text;
    }
    if (spec.kind === 'decimal' || spec.kind === 'float') {
      const pattern = spec.kind === 'decimal' ? /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/ : /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
      if (!pattern.test(text)) invalid('cần nhập số hợp lệ, dùng dấu chấm cho phần thập phân.');
      if (/\bunsigned\b/.test(spec.type) && /^-/.test(text) && /[1-9]/.test(text)) invalid('không được nhập số âm.');
      if (spec.kind === 'decimal') {
        const [whole, fraction = ''] = text.replace(/^[+-]/, '').split('.');
        if (whole.replace(/^0+/, '').length > spec.digits - spec.scale || fraction.length > spec.scale) invalid(`vượt giới hạn ${column.type}.`);
      } else if (!Number.isFinite(Number(text))) invalid('số vượt giới hạn biểu diễn.');
      return text;
    }
    if (spec.kind === 'date') {
      if (!validDate(text)) invalid('ngày không hợp lệ; dùng YYYY-MM-DD.');
      return text;
    }
    if (spec.kind === 'datetime' || spec.kind === 'time') {
      let normalized = text.replace('T', ' ');
      if (spec.kind === 'datetime' && /^\d{4}-\d{2}-\d{2}$/.test(normalized)) normalized += ' 00:00:00';
      const match = spec.kind === 'datetime'
        ? /^(\d{4}-\d{2}-\d{2}) (\d{2}):([0-5]\d)(?::([0-5]\d))?(?:\.(\d{1,6}))?$/.exec(normalized)
        : /^(-?\d{1,3}):([0-5]\d)(?::([0-5]\d))?(?:\.(\d{1,6}))?$/.exec(normalized);
      if (!match) invalid('ngày/giờ không đúng định dạng.');
      const dateTime = spec.kind === 'datetime';
      const hours = Number(match[dateTime ? 2 : 1]);
      const fraction = match[dateTime ? 5 : 4] || '';
      if ((dateTime && (!validDate(match[1]) || hours > 23)) || (!dateTime && Math.abs(hours) > 838)) invalid('giờ hoặc ngày nằm ngoài giới hạn.');
      if (fraction.length > spec.precision) invalid(`chỉ cho phép ${spec.precision} chữ số giây lẻ.`);
      const seconds = match[dateTime ? 4 : 3] || '00';
      return `${dateTime ? `${match[1]} ` : ''}${match[dateTime ? 2 : 1]}:${match[dateTime ? 3 : 2]}:${seconds}${fraction ? `.${fraction}` : ''}`;
    }
    if (spec.kind === 'enum') {
      if (!spec.choices.includes(value)) invalid('giá trị không thuộc danh sách ENUM.');
      return value;
    }
    if (spec.kind === 'set') {
      const selected = value === '' ? [] : value.split(',');
      if (selected.some((item) => !spec.choices.includes(item))) invalid('giá trị không thuộc danh sách SET.');
      return spec.choices.filter((item) => selected.includes(item)).join(',');
    }
    if (spec.kind === 'boolean' || spec.kind === 'bit') {
      const width = spec.kind === 'boolean' ? 1 : spec.width;
      if (!/^[01]+$/.test(text) || text.length > width) invalid(`chỉ nhận tối đa ${width} bit 0/1.`);
      return text;
    }
    if (spec.kind === 'json') {
      try { JSON.parse(value); } catch { invalid('JSON không hợp lệ.'); }
      return value;
    }
    if (spec.kind === 'binary') {
      const hex = value === '' ? '0x' : text;
      if (!/^0x(?:[0-9a-f]{2})*$/i.test(hex)) invalid('nhập hex đầy đủ theo dạng 0x0123abcd, mỗi byte có hai ký tự.');
      if (spec.length && (hex.length - 2) / 2 > spec.length) invalid(`vượt độ dài ${spec.length} byte.`);
      return hex;
    }
    if (spec.length && Array.from(value).length > spec.length) invalid(`vượt độ dài ${spec.length} ký tự.`);
    if (spec.readOnly) invalid(spec.hint);
    return value;
  }

  function pickerValue(column, value) {
    const spec = describe(column);
    const raw = String(value || '').replace(' ', 'T');
    if (spec.kind === 'date') return validDate(raw, false) ? raw : '';
    const match = /^(?:(\d{4}-\d{2}-\d{2})T)?(\d{2}):([0-5]\d)(?::([0-5]\d))?(?:\.(\d{1,6}))?$/.exec(raw);
    if (!match || Number(match[2]) > 23 || (spec.kind === 'datetime' && !validDate(match[1] || '', false))) return '';
    return `${spec.kind === 'datetime' ? `${match[1]}T` : ''}${match[2]}:${match[3]}:${match[4] || '00'}${match[5] ? `.${match[5].slice(0, 3)}` : ''}`;
  }

  function mergePickerValue(column, selected, previous) {
    if (!selected) return '';
    const spec = describe(column);
    if (spec.kind === 'date') return selected;
    let base = selected.replace('T', ' ').split('.')[0];
    if (base.split(' ').at(-1).split(':').length === 2) base += ':00';
    const before = /\.(\d+)$/.exec(String(previous))?.[1] || '';
    const chosen = /\.(\d+)$/.exec(selected)?.[1] || '';
    const fraction = (chosen.padEnd(3, '0') + before.slice(3).padEnd(Math.max(0, spec.precision - 3), '0')).slice(0, spec.precision);
    return base + (spec.precision ? `.${fraction}` : '');
  }

  return Object.freeze({ parseChoices, describe, displayValue, normalizeValue, validDate, pickerValue, mergePickerValue });
}));
