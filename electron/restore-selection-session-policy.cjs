'use strict';

const crypto = require('node:crypto');
const { projectContextReview, reviewContextSequence } = require('./restore-selection-context.cjs');
const MODES = new Set(['ALLOW_INVALID_DATES', 'ANSI_QUOTES', 'ERROR_FOR_DIVISION_BY_ZERO', 'HIGH_NOT_PRECEDENCE', 'IGNORE_SPACE',
  'NO_AUTO_VALUE_ON_ZERO', 'NO_BACKSLASH_ESCAPES', 'NO_DIR_IN_CREATE', 'NO_ENGINE_SUBSTITUTION', 'NO_UNSIGNED_SUBTRACTION',
  'NO_ZERO_DATE', 'NO_ZERO_IN_DATE', 'ONLY_FULL_GROUP_BY', 'PAD_CHAR_TO_FULL_LENGTH', 'PIPES_AS_CONCAT', 'REAL_AS_FLOAT',
  'STRICT_ALL_TABLES', 'STRICT_TRANS_TABLES', 'TIME_TRUNCATE_FRACTIONAL', 'NO_AUTO_CREATE_USER']);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const charset = value => typeof value === 'string' && /^[a-z0-9_]{1,64}$/.test(value);

function normalizeSessionSettings(row) {
  if (!row || ![0, 1, '0', '1'].includes(row.foreignKeyChecks) || ![0, 1, '0', '1'].includes(row.autocommit)
      || row.uniqueChecks !== undefined && ![0, 1, '0', '1'].includes(row.uniqueChecks)
      || typeof row.sqlMode !== 'string' || row.sqlMode.length > 4096 || !/^(?:[A-Za-z0-9_]+(?:[ \t]*,[ \t]*[A-Za-z0-9_]+)*)?$/.test(row.sqlMode)
      || ![row.charsetClient, row.charsetConnection, row.charsetResults].every(charset)) return null;
  const flags = row.sqlMode ? row.sqlMode.toUpperCase().split(',').map(flag => flag.trim()).sort() : [];
  if (flags.length > 64 || new Set(flags).size !== flags.length) return null;
  return { version: 2, foreignKeyChecks: Number(row.foreignKeyChecks) === 1, autocommit: Number(row.autocommit) === 1,
    uniqueChecks: row.uniqueChecks === undefined ? null : Number(row.uniqueChecks) === 1,
    sqlMode: { flags: flags.filter(flag => MODES.has(flag)), unreviewedCount: flags.filter(flag => !MODES.has(flag)).length, fingerprint: digest(flags.join(',')) },
    charsetClient: row.charsetClient, charsetConnection: row.charsetConnection, charsetResults: row.charsetResults };
}

function projectSessionSettings(value) {
  if (![1, 2].includes(value?.version) || typeof value.foreignKeyChecks !== 'boolean' || typeof value.autocommit !== 'boolean'
      || value.version === 2 && value.uniqueChecks !== null && typeof value.uniqueChecks !== 'boolean'
      || ![value.charsetClient, value.charsetConnection, value.charsetResults].every(charset)) return null;
  const mode = value.sqlMode;
  if (!mode || !Array.isArray(mode.flags) || mode.flags.length > MODES.size || mode.flags.some(flag => !MODES.has(flag))
      || new Set(mode.flags).size !== mode.flags.length || !Number.isSafeInteger(mode.unreviewedCount) || mode.unreviewedCount < 0
      || mode.flags.length + mode.unreviewedCount > 64 || typeof mode.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(mode.fingerprint)) return null;
  const flags = [...mode.flags].sort();
  if (mode.unreviewedCount === 0 && digest(flags.join(',')) !== mode.fingerprint) return null;
  return { version: 2, foreignKeyChecks: value.foreignKeyChecks, autocommit: value.autocommit,
    uniqueChecks: value.version === 2 ? value.uniqueChecks : null,
    charsetClient: value.charsetClient, charsetConnection: value.charsetConnection, charsetResults: value.charsetResults,
    sqlMode: { flags, unreviewedCount: mode.unreviewedCount, fingerprint: mode.fingerprint } };
}

// A concrete proposal, not SQL or an executor. Raw dump SET statements remain
// blocked; future managed session setup must be rechecked on its own connection.
function buildSelectionSessionPolicy({ ledger, source, targetReview }) {
  const context = reviewContextSequence(ledger), observations = projectSessionSettings(targetReview.sessionSettings);
  const findings = [], actions = [];
  const flag = code => { if (!findings.includes(code)) findings.push(code); };
  if (!observations) flag('SESSION_SETTINGS_NOT_REVIEWED');
  else {
    if (!observations.foreignKeyChecks) flag('SESSION_FK_CHECKS_DISABLED');
    if (observations.uniqueChecks === null) flag('SESSION_UNIQUE_CHECKS_NOT_REVIEWED');
    else if (!observations.uniqueChecks) flag('SESSION_UNIQUE_CHECKS_DISABLED');
    if (!observations.autocommit) flag('SESSION_AUTOCOMMIT_DISABLED');
    if ([observations.charsetClient, observations.charsetConnection, observations.charsetResults].some(value => value !== 'utf8mb4')) flag('SESSION_CHARSET_REQUIRES_REVIEW');
    if (observations.sqlMode.unreviewedCount) flag('SESSION_SQL_MODE_FLAGS_NOT_REVIEWED');
    if (!observations.sqlMode.flags.some(flag => ['STRICT_TRANS_TABLES', 'STRICT_ALL_TABLES'].includes(flag))) flag('SESSION_STRICT_MODE_NOT_ENABLED');
  }
  const complete = ledger?.version === 1 && Array.isArray(ledger.entries) && ledger.entries.length > 0 && ledger.entries.length <= 10000
    && ledger.total === ledger.entries.length && !ledger.truncated && ledger.entries.every((entry, index) => entry.number === index + 1);
  if (!complete || context.findings.length || context.findingsTruncated) flag('SESSION_CONTEXT_REQUIRES_REVIEW');
  const entries = ledger?.version === 1 && Array.isArray(ledger.entries) ? ledger.entries.slice(0, 10000) : [];
  let wantsZeroMode = false;
  const proposals = {
    'set-names-utf8mb4': 'require-utf8mb4-connection', 'save-disable-foreign-keys': 'keep-foreign-key-checks-enabled',
    'save-set-sql-mode': 'preserve-mode-add-zero-flag', 'restore-sql-mode': 'restore-captured-mode', 'restore-foreign-keys': 'verify-foreign-key-checks-enabled'
  };
  for (const entry of entries) {
    const review = projectContextReview(entry);
    if (review?.status !== 'matched') continue;
    if (review.action === 'save-set-sql-mode') wantsZeroMode = true;
    if (actions.length < 50) actions.push({ number: Number.isSafeInteger(entry.number) && entry.number > 0 ? entry.number : null, sourceAction: review.action, proposal: proposals[review.action] });
    else flag('SESSION_ACTION_LIMIT');
  }
  const proposedFlags = observations?.sqlMode.unreviewedCount === 0 ? [...observations.sqlMode.flags] : null;
  if (proposedFlags && wantsZeroMode && !proposedFlags.includes('NO_AUTO_VALUE_ON_ZERO')) proposedFlags.push('NO_AUTO_VALUE_ON_ZERO');
  proposedFlags?.sort();
  if (!Array.isArray(source.unresolvedOrder) || source.unresolvedOrder.length) flag('SESSION_DEPENDENCY_ORDER_NOT_PROVEN');
  const requires = ['SESSION_DEDICATED_CONNECTION_REQUIRED', 'SESSION_RECHECK_REQUIRED', 'SESSION_VALUES_NOT_VALIDATED',
    'SESSION_FK_DATA_RECHECK_REQUIRED', 'SESSION_UNIQUE_DATA_NOT_VALIDATED', 'SESSION_UNIQUE_CHECKS_RECHECK_REQUIRED',
    'SESSION_CLEANUP_NOT_IMPLEMENTED', 'SESSION_EXECUTION_NOT_IMPLEMENTED'];
  return { version: 2, canExecute: false, status: 'blocked', policy: 'preserve-target-with-integrity-checks', observations,
    foreignKeys: 'keep-enabled', uniqueChecks: 'keep-enabled', charset: 'require-existing-utf8mb4', sqlMode: 'preserve-target-add-zero-if-needed',
    proposedMode: proposedFlags ? { flags: proposedFlags, fingerprint: digest(proposedFlags.join(',')), changed: digest(proposedFlags.join(',')) !== observations.sqlMode.fingerprint } : null,
    contextPresent: context.total > 0, contextSequenceMatched: context.sequenceMatched, actions, findings: findings.map(code => ({ code })), requires,
    lifecycle: ['open-dedicated-connection', 'capture-and-recheck-settings', 'validate-selection-and-values', 'apply-reviewed-mode',
      'verify-unique-checks-enabled', 'execute-reviewed-statements-with-fk-enabled', 'check-result-and-foreign-keys', 'restore-captured-settings-in-finally', 'close-dedicated-connection'],
    failurePolicy: 'stop-report-partial-never-auto-retry', rollbackAllDdlGuaranteed: false };
}

module.exports = { normalizeSessionSettings, projectSessionSettings, buildSelectionSessionPolicy };
