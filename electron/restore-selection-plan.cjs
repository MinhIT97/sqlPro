'use strict';

const crypto = require('node:crypto');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

function syntaxReviewFor(entry) {
  const review = entry.syntaxReview;
  if (review?.version !== 1) return null;
  if (review.status === 'matched') {
    if (review.table !== entry.table || review.schema !== entry.schema) return { version: 1, status: 'unsupported', code: 'INSERT_TARGET_MISMATCH' };
    if (!Number.isInteger(review.rows) || review.rows < 1 || review.rows > 10000 || !Number.isInteger(review.valuesPerRow)
        || review.valuesPerRow < 1 || review.valuesPerRow > 256 || !['explicit', 'positional'].includes(review.columnMode)) return null;
    return { version: 1, status: 'matched', code: 'LITERAL_INSERT_MATCHED', rows: review.rows, valuesPerRow: review.valuesPerRow, columnMode: review.columnMode };
  }
  if (review.status === 'unsupported' && typeof review.code === 'string' && /^INSERT_[A-Z_]{1,64}$/.test(review.code)) {
    return { version: 1, status: 'unsupported', code: review.code };
  }
  return null;
}

// A bounded, immutable review artifact. There is deliberately no execution
// token, SQL text, stored plan registry or write API in this module.
function buildSelectionDraft({ inventory, source, checksum, targetIdentity, targetReview }) {
  if (!inventory || !source || source.canExecute !== false || !digest(checksum) || !digest(targetIdentity)
      || targetReview?.canExecute !== false || !digest(targetReview.snapshotId)) throw new Error('Thiếu nguồn hoặc metadata đích cho bản nháp kế hoạch.');
  const selected = new Set(source.selectedTables);
  const ledger = inventory.statementLedger;
  const entries = ledger?.version === 1 && Array.isArray(ledger.entries) ? ledger.entries : [];
  const blockers = []; let blockersTruncated = false;
  const block = (code, table = null, detail = null) => {
    if (blockers.length < 100) blockers.push({ code, table, detail }); else blockersTruncated = true;
  };
  block('EXECUTION_NOT_IMPLEMENTED');
  block('SOURCE_SUBSET_NOT_VALIDATED');
  block('TARGET_RECHECK_REQUIRED');
  block('WRITE_PRIVILEGES_NOT_REVIEWED');
  if (!ledger || ledger.version !== 1 || ledger.truncated || !entries.length || entries.length !== ledger.total) block('STATEMENT_LEDGER_INCOMPLETE');
  if (inventory.truncated || source.findingsTruncated) block('SOURCE_REVIEW_INCOMPLETE');
  for (const finding of source.findings) block('SOURCE_REVIEW_FINDING', finding.table || null, finding.code);
  for (const finding of targetReview.findings) {
    if (!['ACCOUNT_VISIBLE_METADATA_ONLY', 'TARGET_RECHECK_REQUIRED', 'TARGET_METADATA_NOT_ATOMIC', 'SOURCE_SQL_EFFECTS_NOT_VALIDATED'].includes(finding.code)) {
      block('TARGET_REVIEW_FINDING', finding.table || null, finding.code);
    }
  }
  if (targetReview.findingsTruncated) block('TARGET_REVIEW_INCOMPLETE');
  for (const row of targetReview.rows) {
    if (!row.columnReview || row.columnReview.truncated || row.columnReview.findings.length) block('COLUMNS_REQUIRE_REVIEW', row.name);
  }
  const totals = { candidate: 0, excluded: 0, blocked: 0, skipped: 0 };
  const syntaxTotals = { matched: 0, unsupported: 0, notReviewed: 0 };
  const steps = []; let previous = 0;
  for (const entry of entries.slice(0, 10000)) {
    let decision = 'blocked', reason = 'STATEMENT_NOT_CLASSIFIED';
    const numbered = Number.isSafeInteger(entry.number) && entry.number === previous + 1;
    if (!numbered) block('STATEMENT_LEDGER_INCOMPLETE');
    previous = entry.number;
    const syntaxReview = syntaxReviewFor(entry);
    if (selected.has(entry.table) && source.includeData && entry.command === 'INSERT') {
      syntaxTotals[syntaxReview?.status === 'matched' ? 'matched' : syntaxReview?.status === 'unsupported' ? 'unsupported' : 'notReviewed']++;
    }
    if (numbered && ['structure', 'data'].includes(entry.kind) && typeof entry.table === 'string' && entry.table.length > 0 && entry.table.length <= 64) {
      if (!selected.has(entry.table)) { decision = 'excluded'; reason = 'TABLE_NOT_SELECTED'; }
      else if (entry.kind === 'structure' && !source.includeStructure || entry.kind === 'data' && !source.includeData) {
        decision = 'excluded'; reason = 'PART_NOT_SELECTED';
      } else if (entry.schema && entry.schema !== targetReview.database) reason = 'SCHEMA_MAPPING_REQUIRED';
      else if (entry.command === 'DROP') reason = 'DESTRUCTIVE_POLICY_REQUIRED';
      else if (entry.command === 'INSERT' && syntaxReview?.status !== 'matched') reason = syntaxReview?.code || 'INSERT_SYNTAX_NOT_REVIEWED';
      else if (entry.kind === 'structure' && entry.command === 'CREATE' || entry.kind === 'data' && entry.command === 'INSERT') {
        decision = 'candidate'; reason = entry.command === 'INSERT' ? 'LITERAL_INSERT_MATCHED' : 'SOURCE_SQL_REQUIRES_VALIDATION';
      }
    } else if (numbered && entry.kind === 'context') reason = 'SESSION_CONTEXT_NOT_PLANNED';
    else if (numbered && entry.kind === 'skipped') { decision = 'skipped'; reason = 'DIRECTIVE_SKIPPED_BY_CURRENT_RESTORE'; }
    totals[decision]++;
    if (decision === 'blocked') block(reason, entry.table || null, `#${entry.number}`);
    if (steps.length < 200) steps.push({ number: entry.number, command: entry.command, table: entry.table, schema: entry.schema, decision, reason, syntaxReview });
  }
  if (entries.length > 10000) block('STATEMENT_LEDGER_INCOMPLETE');
  const selection = { tables: [...source.selectedTables].sort(), includeStructure: source.includeStructure, includeData: source.includeData };
  const binding = { version: 2, checksum, targetIdentity, targetSnapshotId: targetReview.snapshotId,
    sourceDatabase: source.sourceDatabase, targetDatabase: targetReview.database, selection, policy: 'review-only',
    ledger: ledger || null, sourceFindings: source.findings, sourceTruncated: inventory.truncated || source.findingsTruncated,
    blockers: [...blockers].sort((left, right) => JSON.stringify(left) < JSON.stringify(right) ? -1 : JSON.stringify(left) > JSON.stringify(right) ? 1 : 0), blockersTruncated };
  const planId = crypto.createHash('sha256').update(JSON.stringify(binding)).digest('hex');
  return freeze({ version: 2, kind: 'restore-selection-draft', canExecute: false, status: 'blocked', planId,
    checksum, targetSnapshotId: targetReview.snapshotId, sourceDatabase: source.sourceDatabase, targetDatabase: targetReview.database,
    selection, policy: 'review-only', statementCount: ledger?.total || 0, totals, syntaxTotals, steps,
    stepsTruncated: steps.length < entries.length || !!ledger?.truncated, blockers, blockersTruncated });
}

module.exports = { buildSelectionDraft };
