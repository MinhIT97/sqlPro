'use strict';

// Only the five statements emitted by SqlPro's dump writer are recognized.
// This module never executes SQL or returns literal contents. A match still
// needs a dedicated-session policy, target checks and cleanup before execution.
const FORMS = [
  ['set-names-utf8mb4', /^SET[ \t\r\n]+NAMES[ \t\r\n]+utf8mb4$/i],
  ['save-disable-foreign-keys', /^SET[ \t\r\n]+@OLD_FOREIGN_KEY_CHECKS[ \t\r\n]*=[ \t\r\n]*@@FOREIGN_KEY_CHECKS[ \t\r\n]*,[ \t\r\n]*FOREIGN_KEY_CHECKS[ \t\r\n]*=[ \t\r\n]*0$/i],
  ['save-set-sql-mode', /^SET[ \t\r\n]+@OLD_SQL_MODE[ \t\r\n]*=[ \t\r\n]*@@SQL_MODE[ \t\r\n]*,[ \t\r\n]*SQL_MODE[ \t\r\n]*=[ \t\r\n]*'NO_AUTO_VALUE_ON_ZERO'$/i],
  ['restore-sql-mode', /^SET[ \t\r\n]+SQL_MODE[ \t\r\n]*=[ \t\r\n]*@OLD_SQL_MODE$/i],
  ['restore-foreign-keys', /^SET[ \t\r\n]+FOREIGN_KEY_CHECKS[ \t\r\n]*=[ \t\r\n]*@OLD_FOREIGN_KEY_CHECKS$/i]
];
const ACTIONS = new Set(FORMS.map(([action]) => action));
const CONTEXT_COMMANDS = new Set(['SET', 'BEGIN', 'START', 'COMMIT', 'ROLLBACK', 'UNLOCK']);
const UNSUPPORTED_CODES = new Set(['CONTEXT_VALIDATION_LIMIT', 'CONTEXT_SET_UNSUPPORTED', 'CONTEXT_TRANSACTION_UNSUPPORTED',
  'CONTEXT_QUOTING_UNSUPPORTED', 'CONTEXT_COMMENT_UNSUPPORTED']);

function reviewDumpContext(sql) {
  const unsupported = code => ({ version: 1, status: 'unsupported', code });
  if (typeof sql !== 'string') return unsupported('CONTEXT_SET_UNSUPPORTED');
  if (sql.length > 16384 || Buffer.byteLength(sql) > 16384) return unsupported('CONTEXT_VALIDATION_LIMIT');
  if (/[\0\\"]/.test(sql)) return unsupported('CONTEXT_QUOTING_UNSUPPORTED');
  if (/\/\*|--|#/.test(sql)) return unsupported('CONTEXT_COMMENT_UNSUPPORTED');
  if (/[^\x20-\x7e\t\r\n]/.test(sql)) return unsupported('CONTEXT_SET_UNSUPPORTED');
  const text = sql.trim().replace(/;$/, '').trim();
  for (const [action, pattern] of FORMS) {
    if (pattern.test(text)) return { version: 1, status: 'matched', code: 'DUMP_CONTEXT_MATCHED', action };
  }
  return unsupported(/^(?:BEGIN|START|COMMIT|ROLLBACK|UNLOCK)\b/i.test(text) ? 'CONTEXT_TRANSACTION_UNSUPPORTED' : 'CONTEXT_SET_UNSUPPORTED');
}

function projectContextReview(entry) {
  if (entry?.kind !== 'context' || !CONTEXT_COMMANDS.has(entry.command)) return null;
  const review = entry.contextReview;
  if (review?.version !== 1) return null;
  if (entry.command === 'SET' && review.status === 'matched' && review.code === 'DUMP_CONTEXT_MATCHED' && ACTIONS.has(review.action)) {
    return { version: 1, status: 'matched', code: 'DUMP_CONTEXT_MATCHED', action: review.action };
  }
  if (review.status === 'unsupported' && UNSUPPORTED_CODES.has(review.code)) return { version: 1, status: 'unsupported', code: review.code };
  return null;
}

// Check sequence shape across the WHOLE retained ledger, including statements
// for unselected tables. This is not a proof of session/server semantics.
function reviewContextSequence(ledger) {
  const entries = ledger?.version === 1 && Array.isArray(ledger.entries) ? ledger.entries.slice(0, 10000) : [];
  const findings = [];
  let findingsTruncated = false;
  const flag = (code, number = null) => {
    if (findings.length < 50) findings.push({ code, number }); else findingsTruncated = true;
  };
  const ledgerComplete = !!ledger && ledger.version === 1 && Array.isArray(ledger.entries) && ledger.entries.length <= 10000
    && !ledger.truncated && entries.length > 0 && entries.length === ledger.total
    && entries.every((entry, index) => entry.number === index + 1);
  if (!ledgerComplete) flag('CONTEXT_LEDGER_INCOMPLETE');
  const seen = new Set(), stack = [];
  let phase = 'header', total = 0, matched = 0, unsupported = 0, notReviewed = 0;
  for (const entry of entries) {
    if (entry.kind !== 'context' && !CONTEXT_COMMANDS.has(entry.command)) {
      if (entry.kind !== 'skipped') {
        if (phase === 'footer') flag('CONTEXT_BODY_AFTER_RESTORE', entry.number);
        else phase = 'body';
      }
      continue;
    }
    total++;
    const review = projectContextReview(entry);
    if (!review) { notReviewed++; flag('CONTEXT_NOT_REVIEWED', entry.number); continue; }
    if (review.status !== 'matched') { unsupported++; flag(review.code, entry.number); continue; }
    matched++;
    const action = review.action;
    if (seen.has(action)) { flag('CONTEXT_DUPLICATE_ACTION', entry.number); continue; }
    seen.add(action);
    if (action.startsWith('restore-')) {
      phase = 'footer';
      const setting = action === 'restore-sql-mode' ? 'sql-mode' : 'foreign-keys';
      if (!stack.includes(setting)) flag('CONTEXT_RESTORE_WITHOUT_SAVE', entry.number);
      else if (stack.at(-1) !== setting) flag('CONTEXT_RESTORE_ORDER', entry.number);
      else stack.pop();
    } else {
      if (phase !== 'header') flag('CONTEXT_HEADER_AFTER_BODY', entry.number);
      if (action === 'save-set-sql-mode') stack.push('sql-mode');
      else if (action === 'save-disable-foreign-keys') stack.push('foreign-keys');
    }
  }
  if (stack.length) flag('CONTEXT_SETTINGS_NOT_RESTORED');
  return { version: 1, canExecute: false, requiresDedicatedSession: true, total, matched, unsupported, notReviewed,
    sequenceMatched: total > 0 && !findings.length && !findingsTruncated,
    foreignKeyRecheckRequired: seen.has('save-disable-foreign-keys'), sqlModeReviewRequired: seen.has('save-set-sql-mode'),
    findings, findingsTruncated };
}

module.exports = { reviewDumpContext, projectContextReview, reviewContextSequence };
