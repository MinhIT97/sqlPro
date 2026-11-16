'use strict';

const { splitSqlStatements, stripLeadingComments } = require('./sql-script.cjs');
const { assertReadOnlySql } = require('./connection-policy.cjs');

function invalid(message, code = 'ANALYZE_UNSUPPORTED') {
  return Object.assign(new Error(message), { code });
}

function validateAnalyzeSource(sql) {
  if (typeof sql !== 'string' || !sql.trim() || sql.length > 65536 || sql.includes('\0')) {
    throw invalid('ANALYZE cần một câu SELECT/CTE, tối đa 65.536 ký tự.', 'ANALYZE_INVALID_SQL');
  }
  // Inspect original comments before splitting; executable comments must never
  // be mistaken for ordinary comments by statement selection.
  try { assertReadOnlySql({ readOnly: true }, sql); }
  catch { throw invalid('ANALYZE chỉ nhận SELECT/CTE đọc đơn giản; không hỗ trợ lệnh ghi, khóa, hàm chưa biết, hint hoặc cú pháp phụ thuộc SQL mode.', 'ANALYZE_INVALID_SQL'); }
  const statements = splitSqlStatements(sql);
  if (statements.length !== 1 || !/^(?:SELECT|WITH)\b/i.test(stripLeadingComments(statements[0]))) {
    throw invalid('Chỉ chọn một câu SELECT/CTE để ANALYZE.', 'ANALYZE_INVALID_SQL');
  }
  return statements[0];
}

function buildAnalyzeQuery(sql, version) {
  const source = validateAnalyzeSource(sql);
  const text = typeof version === 'string' && version.length <= 256 && !/[\r\n\0]/.test(version) ? version : '';
  // Restrict to recognized MySQL 8 / MariaDB 10–11 version signatures. Do not
  // probe, retry another syntax or infer compatibility of other server forks.
  const maria = /^(?:5\.5\.5-)?(10|11)\.(\d+)\.(\d+)-MariaDB(?:[-+].*)?$/i.exec(text);
  if (maria && (Number(maria[1]) > 10 || Number(maria[2]) >= 1)) {
    return Object.freeze({ sql: `ANALYZE FORMAT=JSON ${source}`, engine: 'MariaDB', format: 'JSON' });
  }
  const mysql = /^8\.(\d+)\.(\d+)(?:-(?:commercial|log|[0-9][A-Za-z0-9.+~_-]*))?$/.exec(text);
  if (mysql && (Number(mysql[1]) > 0 || Number(mysql[2]) >= 18)) {
    return Object.freeze({ sql: `EXPLAIN ANALYZE FORMAT=TREE ${source}`, engine: 'MySQL', format: 'TREE' });
  }
  throw invalid('Chưa hỗ trợ ANALYZE cho phiên bản server này. Hiện nhận MySQL 8.0.18+/8.x và MariaDB 10.1+/11.x có version chuẩn; dùng EXPLAIN để xem kế hoạch.');
}

function assertAnalyzeSession(session, ownedTask = null) {
  if (session.activeTask && session.activeTask !== ownedTask) throw invalid('Phiên đang chạy một tác vụ khác.', 'SESSION_BUSY');
  if (session.inTransaction !== false || session.autocommit !== true) {
    throw invalid('Hãy kết thúc transaction và bật autocommit trước khi ANALYZE. Ứng dụng không tự Commit/Rollback hoặc đổi chế độ phiên.', 'ANALYZE_TRANSACTION_ACTIVE');
  }
}

function assertPlanExport(sql) {
  if (/^(?:EXPLAIN|DESC|DESCRIBE|ANALYZE)\b/i.test(stripLeadingComments(sql)) || /\/\*(?:!|M!)/i.test(sql)) {
    try { assertReadOnlySql({ readOnly: true }, sql); }
    catch { throw invalid('Không chạy lại ANALYZE hoặc plan chưa xác định để xuất. Hãy dùng nút ANALYZE riêng và lưu kết quả đã nhận.', 'ANALYZE_EXPORT_REPLAY_BLOCKED'); }
  }
}

module.exports = { validateAnalyzeSource, buildAnalyzeQuery, assertAnalyzeSession, assertPlanExport };
