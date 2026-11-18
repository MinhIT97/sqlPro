'use strict';

const { tokenizeSql, parseSetAssignments, assertRestoreSet, evaluateAutocommit } = require('./sql-script.cjs');

const INITIAL_MODE = Symbol('initial-session-mode');
// These modes do not change quote/escape/identifier grammar used by this reader.
const SUPPORTED_MODES = new Set([
  'ONLY_FULL_GROUP_BY', 'STRICT_TRANS_TABLES', 'STRICT_ALL_TABLES', 'NO_ZERO_IN_DATE',
  'NO_ZERO_DATE', 'ERROR_FOR_DIVISION_BY_ZERO', 'NO_ENGINE_SUBSTITUTION',
  'NO_AUTO_VALUE_ON_ZERO', 'NO_AUTO_CREATE_USER', 'IGNORE_SPACE'
]);
const fail = message => Object.assign(new Error(message), { code: 'RESTORE_CONTEXT_UNSUPPORTED' });

function assertSupportedRestoreMode(mode) {
  if (typeof mode !== 'string' || mode.length > 4096
      || mode.split(',').some(part => part.trim() && !SUPPORTED_MODES.has(part.trim().toUpperCase()))) {
    throw fail('SQL mode chưa được hỗ trợ cho phục hồi chọn lọc. Chưa có lệnh ghi nào được phép chạy.');
  }
  return mode;
}

function createRestoreContextPolicy() {
  const variables = new Map();
  let currentMode = INITIAL_MODE;
  const readValue = tokens => {
    if (tokens.length !== 1) throw fail('Biểu thức SET chưa được hỗ trợ trong phục hồi chọn lọc.');
    const token = tokens[0];
    if (token.type === 'string' || token.type === 'double_string') return token.value;
    if (token.type === 'word' && /^(?:[0-9]+|ON|OFF|TRUE|FALSE)$/i.test(token.value)) return token.value;
    if (token.type === 'variable') {
      const raw = token.value.replace(/`/g, '');
      if (/^@@(?:(?:SESSION|LOCAL)\.)?SQL_MODE$/i.test(raw)) return currentMode;
      if (/^@@(?:(?:SESSION|LOCAL)\.)?(?:FOREIGN_KEY_CHECKS|UNIQUE_CHECKS|AUTOCOMMIT|TIME_ZONE|SQL_NOTES|CHARACTER_SET_CLIENT|CHARACTER_SET_RESULTS|CHARACTER_SET_CONNECTION|COLLATION_CONNECTION)$/i.test(raw)) {
        return { sessionReference: raw };
      }
      if (/^@[A-Za-z0-9_$]+$/.test(raw) && variables.has(raw.slice(1).toUpperCase())) return variables.get(raw.slice(1).toUpperCase());
    }
    throw fail('Giá trị SET phụ thuộc context chưa được xác minh.');
  };

  const validate = statement => {
    const tokens = tokenizeSql(statement);
    if (tokens[0]?.type !== 'word' || tokens[0].value.toUpperCase() !== 'SET') return;
    assertRestoreSet(statement);
    const parsed = parseSetAssignments(statement);
    if (parsed?.type === 'charset') {
      const names = tokens[1].value.toUpperCase() === 'NAMES';
      const offset = names ? 2 : 3;
      const charset = tokens[offset]?.value || '';
      if (!/^(?:utf8mb4|utf8mb3|utf8|ascii)$/i.test(charset)) {
        throw fail('Charset của dump chưa được hỗ trợ trong phục hồi chọn lọc.');
      }
      const tail = tokens.slice(offset + 1);
      if (tail.at(-1)?.value === ';') tail.pop();
      const validCollation = names && tail.length === 2 && tail[0].value.toUpperCase() === 'COLLATE'
        && new RegExp(`^${charset}_[a-z0-9_]+$`, 'i').test(tail[1].value);
      if (tail.length && !validCollation) {
        throw fail('Charset của dump chưa được hỗ trợ trong phục hồi chọn lọc.');
      }
      return;
    }
    if (!parsed || !parsed.assignments.length) throw fail('Không xác định được context SET.');
    if (parsed.assignments.filter(a => !a.isUserVar && a.name.toUpperCase() === 'AUTOCOMMIT').length > 1) {
      throw fail('Không hỗ trợ nhiều thay đổi AUTOCOMMIT trong cùng một lệnh.');
    }
    for (const assignment of parsed.assignments) {
      const name = assignment.name.toUpperCase();
      if (!assignment.isUserVar && name === 'AUTOCOMMIT') {
        if (evaluateAutocommit(assignment.valueTokens) === null) throw fail('AUTOCOMMIT phải có giá trị tĩnh đã xác minh.');
        continue;
      }
      const value = readValue(assignment.valueTokens);
      if (assignment.isUserVar) {
        if (variables.size >= 64 && !variables.has(name)) throw fail('Dump chứa quá nhiều biến context.');
        variables.set(name, value);
      } else if (name === 'SQL_MODE') {
        if (value !== INITIAL_MODE) assertSupportedRestoreMode(value);
        currentMode = value;
      } else if (/^CHARACTER_SET_(?:CLIENT|RESULTS|CONNECTION)$/.test(name) || name === 'COLLATION_CONNECTION') {
        const safeReference = value?.sessionReference && new RegExp(`^@@(?:(?:SESSION|LOCAL)\\.)?${name}$`, 'i').test(value.sessionReference);
        const safeConstant = typeof value === 'string' && (name === 'COLLATION_CONNECTION'
          ? /^(?:utf8mb4|utf8mb3|utf8)_[a-z0-9_]+$/i.test(value)
          : /^(?:utf8mb4|utf8mb3|utf8)$/i.test(value));
        if (!safeReference && !safeConstant) throw fail('Charset context chưa được hỗ trợ trong phục hồi chọn lọc.');
      }
    }
  };
  return { validate };
}

module.exports = { assertSupportedRestoreMode, createRestoreContextPolicy };
