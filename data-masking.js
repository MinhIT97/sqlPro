/**
 * Smart Data Masking Module
 *
 * Implements pure PII (Personally Identifiable Information) masking
 * for emails, phone numbers, credit card numbers, secrets, and national IDs.
 *
 * Architecture:
 * - Pure Universal Module Definition (UMD)
 * - Zero DOM / Electron / Database dependencies
 * - Immutable transformation (never mutates source data)
 * - Extensible heuristic detection
 */
(function (root, factory) {
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    root.SqlDataMasking = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Masks an email address preserving first and last characters of local part and domain.
   * e.g. "alexander.smith@example.com" -> "a***h@example.com"
   * e.g. "me@domain.org" -> "*@domain.org"
   */
  function maskEmail(email) {
    if (typeof email !== 'string') return email;
    const str = email.trim();
    if (!str) return email;
    const atIdx = str.indexOf('@');
    if (atIdx <= 0 || atIdx === str.length - 1) return '***';

    const localPart = str.slice(0, atIdx);
    const domainPart = str.slice(atIdx + 1);

    let maskedLocal;
    if (localPart.length <= 2) {
      maskedLocal = '*';
    } else {
      maskedLocal = localPart[0] + '***' + localPart[localPart.length - 1];
    }

    return `${maskedLocal}@${domainPart}`;
  }

  /**
   * Masks a phone number preserving prefix and last 3 digits.
   * e.g. "0912345678" -> "091****678"
   * e.g. "+84 90 123 4567" -> "+84 90***4567"
   */
  function maskPhone(phone) {
    if (phone === null || phone === undefined) return phone;
    const str = String(phone).trim();
    // Extract pure digits
    const digitsOnly = str.replace(/\D/g, '');
    if (digitsOnly.length < 7) {
      return str.replace(/\d/g, '*');
    }

    // Keep first 3 digits and last 3 digits
    let digitCount = 0;
    const totalDigits = digitsOnly.length;
    const keepStart = Math.min(3, Math.floor(totalDigits / 3));
    const keepEnd = 3;

    let result = '';
    for (let i = 0; i < str.length; i++) {
      const char = str[i];
      if (/\d/.test(char)) {
        digitCount++;
        if (digitCount <= keepStart || digitCount > totalDigits - keepEnd) {
          result += char;
        } else {
          result += '*';
        }
      } else {
        result += char;
      }
    }

    return result;
  }

  /**
   * Masks a credit/debit card number keeping only the last 4 digits.
   * e.g. "4111 2222 3333 4444" -> "**** **** **** 4444"
   * e.g. "4111222233334444" -> "************4444"
   */
  function maskCardNumber(card) {
    if (card === null || card === undefined) return card;
    const str = String(card).trim();
    const digits = str.replace(/\D/g, '');
    if (digits.length < 12) {
      return str.replace(/\d/g, '*');
    }

    const lastFour = digits.slice(-4);
    let digitCount = 0;
    const totalDigits = digits.length;

    let result = '';
    for (let i = 0; i < str.length; i++) {
      const char = str[i];
      if (/\d/.test(char)) {
        digitCount++;
        if (digitCount > totalDigits - 4) {
          result += char;
        } else {
          result += '*';
        }
      } else {
        result += char;
      }
    }

    return result;
  }

  /**
   * Masks a secret / password / API key with a fixed mask string.
   */
  function maskSecret(val) {
    if (val === null || val === undefined) return val;
    return '********';
  }

  /**
   * Masks a National ID / Passport / Citizen ID (CMND/CCCD).
   * e.g. "001099123456" -> "0010******56"
   */
  function maskIdNumber(id) {
    if (id === null || id === undefined) return id;
    const str = String(id).trim();
    if (str.length < 6) return '******';

    const start = str.slice(0, 3);
    const end = str.slice(-2);
    const middleStars = '*'.repeat(Math.max(4, str.length - 5));
    return `${start}${middleStars}${end}`;
  }

  /**
   * Detects the recommended mask type from a column name and type heuristics.
   *
   * @param {string} columnName Column name to inspect
   * @param {string} [columnType] Optional SQL column data type
   * @returns {string|null} 'email' | 'phone' | 'card' | 'secret' | 'id_card' | null
   */
  function detectMaskType(columnName, columnType = '') {
    if (!columnName || typeof columnName !== 'string') return null;
    const name = columnName.trim().toLowerCase();

    // 1. Password / Secret / Token
    if (/(password|passwd|pwd|secret|token|api_key|apikey|private_key|auth_key|mat_khau)/i.test(name)) {
      return 'secret';
    }

    // 2. Email
    if (/(email|e_mail|mail_address|thu_dien_tu)/i.test(name)) {
      return 'email';
    }

    // 3. Phone
    if (/(phone|mobile|cellphone|telephone|tel_no|sdt|so_dien_thoai)/i.test(name)) {
      return 'phone';
    }

    // 4. Credit / Debit Card / Bank Account
    if (/(credit_card|card_num|card_number|card_no|so_the|cvv|cvc|ccv)/i.test(name)) {
      return 'card';
    }

    // 5. National ID / SSN / Passport / CCCD / CMND
    if (/(ssn|social_security|passport|national_id|id_number|citizen_id|cmnd|cccd|so_dinh_danh)/i.test(name)) {
      return 'id_card';
    }

    return null;
  }

  /**
   * Masks a single value according to the specified rule type.
   *
   * @param {*} value The value to mask
   * @param {string} maskType 'email' | 'phone' | 'card' | 'secret' | 'id_card'
   * @returns {*} Masked string or original value if null/undefined
   */
  function maskValue(value, maskType) {
    if (value === null || value === undefined || value === '') return value;

    switch (maskType) {
      case 'email':
        return maskEmail(String(value));
      case 'phone':
        return maskPhone(value);
      case 'card':
        return maskCardNumber(value);
      case 'secret':
        return maskSecret(value);
      case 'id_card':
        return maskIdNumber(value);
      default:
        return value;
    }
  }

  /**
   * Creates a column masking rules configuration from column metadata.
   *
   * @param {Array<Object|string>} columns Column descriptors
   * @param {Object} [overrides={}] Manual mask rule overrides keyed by column name (lowercase)
   * @returns {Map<string, string>} Map of lowercase column name -> maskType
   */
  function createMaskingConfig(columns, overrides = {}) {
    const config = new Map();
    if (!Array.isArray(columns)) return config;

    const lowerOverrides = new Map();
    if (overrides && typeof overrides === 'object') {
      for (const [key, val] of Object.entries(overrides)) {
        lowerOverrides.set(String(key).toLowerCase(), val);
      }
    }

    for (const col of columns) {
      const colName = typeof col === 'string' ? col : col?.name;
      if (!colName) continue;
      const lower = String(colName).toLowerCase();

      if (lowerOverrides.has(lower)) {
        const rule = lowerOverrides.get(lower);
        if (rule) config.set(lower, rule);
      } else {
        const detected = detectMaskType(colName, typeof col === 'object' ? col.type : '');
        if (detected) config.set(lower, detected);
      }
    }

    return config;
  }

  /**
   * Masks a single row (array or object) based on the column configuration.
   * Returns a new row; does not mutate input.
   *
   * @param {Array|Object} row
   * @param {Array} columns Column metadata
   * @param {Map|Object} maskConfig Masking configuration
   * @returns {Array|Object} Masked row
   */
  function maskRow(row, columns, maskConfig) {
    if (!row) return row;
    const configMap = maskConfig instanceof Map ? maskConfig : new Map(Object.entries(maskConfig || {}));

    if (Array.isArray(row)) {
      const newRow = [...row];
      for (let i = 0; i < columns.length; i++) {
        const col = columns[i];
        const colName = typeof col === 'string' ? col : col?.name;
        if (!colName) continue;
        const rule = configMap.get(colName.toLowerCase());
        if (rule) {
          newRow[i] = maskValue(newRow[i], rule);
        }
      }
      return newRow;
    }

    if (typeof row === 'object') {
      const newObj = { ...row };
      for (const key of Object.keys(newObj)) {
        const rule = configMap.get(key.toLowerCase());
        if (rule) {
          newObj[key] = maskValue(newObj[key], rule);
        }
      }
      return newObj;
    }

    return row;
  }

  /**
   * Batch masks an array of rows.
   *
   * @param {Array} rows Array of rows
   * @param {Array} columns Column metadata
   * @param {Map|Object} maskConfig Masking configuration
   * @returns {Array} New array of masked rows
   */
  function maskRows(rows, columns, maskConfig) {
    if (!Array.isArray(rows) || !rows.length) return [];
    const configMap = maskConfig instanceof Map ? maskConfig : new Map(Object.entries(maskConfig || {}));
    if (configMap.size === 0) return rows;

    return rows.map((row) => maskRow(row, columns, configMap));
  }

  return {
    maskEmail,
    maskPhone,
    maskCardNumber,
    maskSecret,
    maskIdNumber,
    detectMaskType,
    maskValue,
    createMaskingConfig,
    maskRow,
    maskRows
  };
});
