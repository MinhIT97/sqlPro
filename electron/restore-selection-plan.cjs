'use strict';

const crypto = require('node:crypto');
const { projectContextReview, reviewContextSequence } = require('./restore-selection-context.cjs');
const { reviewConflictPolicy } = require('./restore-selection-policy.cjs');
const { projectForeignKeys, reviewSelectedForeignKeys } = require('./restore-selection-foreign-keys.cjs');
const { projectIndexes } = require('./restore-selection-indexes.cjs');
const { compareSelectedForeignKeys } = require('./restore-selection-fk-comparison.cjs');
const { buildSelectionSessionPolicy } = require('./restore-selection-session-policy.cjs');
const { projectValueEvidence, reviewSelectionValues } = require('./restore-selection-values.cjs');
const { reviewOmittedValues } = require('./restore-selection-omitted.cjs');
const { projectStatementSize, reviewSelectionPackets } = require('./restore-selection-packets.cjs');
const { reviewTargetEngine } = require('./restore-selection-engines.cjs');
const { projectTargetTriggerReview } = require('./restore-selection-triggers.cjs');
const { projectTargetExpressions } = require('./restore-selection-expressions.cjs');
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
  if (!['INSERT', 'CREATE'].includes(entry.command) || review?.version !== (entry.command === 'CREATE' ? 3 : 1)) return null;
  const prefix = entry.command === 'CREATE' ? 'CREATE' : 'INSERT';
  if (review.status === 'matched') {
    if (review.table !== entry.table || review.schema !== entry.schema) return { version: review.version, status: 'unsupported', code: `${prefix}_TARGET_MISMATCH` };
    if (entry.command === 'CREATE') {
      const foreignKeys = projectForeignKeys(review.foreignKeys), indexDefinitions = projectIndexes(review.indexDefinitions);
      if (review.code !== 'BASIC_CREATE_MATCHED' || review.engine !== 'InnoDB' || !Number.isInteger(review.columns)
          || review.columns < 1 || review.columns > 256 || !Number.isInteger(review.indexes) || review.indexes < 0 || review.indexes > 128 || !foreignKeys
          || !indexDefinitions || indexDefinitions.length !== review.indexes) return null;
      return { version: 3, status: 'matched', code: 'BASIC_CREATE_MATCHED', columns: review.columns, indexes: review.indexes, engine: 'InnoDB', foreignKeys, indexDefinitions };
    }
    if (!Number.isInteger(review.rows) || review.rows < 1 || review.rows > 10000 || !Number.isInteger(review.valuesPerRow)
        || review.valuesPerRow < 1 || review.valuesPerRow > 256 || !['explicit', 'positional'].includes(review.columnMode)) return null;
    return { version: 1, status: 'matched', code: 'LITERAL_INSERT_MATCHED', rows: review.rows, valuesPerRow: review.valuesPerRow, columnMode: review.columnMode,
      valueReview: projectValueEvidence(review.valueReview, review) };
  }
  if (review.status === 'unsupported' && typeof review.code === 'string' && new RegExp(`^${prefix}_[A-Z_]{1,64}$`).test(review.code)) {
    return { version: review.version, status: 'unsupported', code: review.code };
  }
  return null;
}

// A bounded, immutable review artifact. There is deliberately no execution
// token, SQL text, stored plan registry or write API in this module.
function buildSelectionDraft({ inventory, source, checksum, targetIdentity, targetReview, conflictPolicy }) {
  if (!inventory || !source || source.canExecute !== false || !digest(checksum) || !digest(targetIdentity)
      || targetReview?.canExecute !== false || !digest(targetReview.snapshotId)) throw new Error('Thiếu nguồn hoặc metadata đích cho bản nháp kế hoạch.');
  const selected = new Set(source.selectedTables);
  const ledger = inventory.statementLedger;
  const entries = ledger?.version === 1 && Array.isArray(ledger.entries) ? ledger.entries : [];
  const sessionContextReview = reviewContextSequence(ledger);
  const conflictPolicyReview = reviewConflictPolicy({ source, targetReview, conflictPolicy });
  const tablePolicies = new Map(conflictPolicyReview.rows.map(row => [row.name, row]));
  const engineObservations = new Map();
  const engineRows = Array.isArray(targetReview.rows) && targetReview.rows.length <= 1000 ? targetReview.rows : [];
  for (const row of engineRows) engineObservations.set(row.name, engineObservations.has(row.name) ? null : row);
  const targetEngineReview = { version: 1, rows: source.rows.map(row => {
    return { name: row.name, ...reviewTargetEngine(engineObservations.get(row.name), {
      lowerCaseTableNames: targetReview.lowerCaseTableNames, metadataComplete: targetReview.metadataStatus?.complete === true && !targetReview.findingsTruncated,
      databaseVisible: targetReview.metadataStatus?.databaseVisible }) };
  }) };
  const targetEngines = new Map(targetEngineReview.rows.map(row => [row.name, row]));
  const targetTriggerReview = projectTargetTriggerReview(targetReview.targetTriggerReview);
  const targetExpressionReview = projectTargetExpressions(targetReview.targetExpressionReview);
  const foreignKeyReview = reviewSelectedForeignKeys({ source, targetReview, policyReview: conflictPolicyReview,
    creates: entries.slice(0, 10000).filter(entry => entry.command === 'CREATE').map(entry => ({ table: entry.table, schema: entry.schema, review: syntaxReviewFor(entry) })) });
  const foreignKeyComparison = compareSelectedForeignKeys({ source, targetReview,
    creates: entries.slice(0, 10000).filter(entry => entry.command === 'CREATE').map(entry => ({ table: entry.table, schema: entry.schema, review: syntaxReviewFor(entry) })) });
  const sessionPolicyReview = buildSelectionSessionPolicy({ ledger, source, targetReview });
  const valueReview = reviewSelectionValues({ ledger, source, targetReview, policyReview: conflictPolicyReview, sessionPolicyReview });
  const valueIssues = new Set(valueReview.rows.filter(row => row.status === 'issues').map(row => row.number));
  const valueRows = new Set(valueReview.rows.map(row => row.number));
  const omittedValueReview = reviewOmittedValues({ ledger, source, targetReview, policyReview: conflictPolicyReview });
  const omittedIssues = new Set(omittedValueReview.rows.filter(row => row.status === 'issues').map(row => row.number));
  const omittedRows = new Set(omittedValueReview.rows.map(row => row.number));
  const packetReview = reviewSelectionPackets({ ledger, source, targetReview, policyReview: conflictPolicyReview });
  const oversized = new Set(packetReview.rows.filter(row => row.status === 'oversized').map(row => row.number));
  const packetRows = new Set(packetReview.rows.map(row => row.number));
  const blockers = []; let blockersTruncated = false;
  const block = (code, table = null, detail = null) => {
    if (blockers.length < 100) blockers.push({ code, table, detail }); else blockersTruncated = true;
  };
  block('EXECUTION_NOT_IMPLEMENTED');
  for (const code of [...valueReview.findings, ...valueReview.requires]) block(code);
  for (const code of [...omittedValueReview.findings, ...omittedValueReview.requires]) block(code);
  for (const code of [...packetReview.findings, ...packetReview.requires]) block(code);
  for (const finding of sessionPolicyReview.findings) block(finding.code);
  for (const code of sessionPolicyReview.requires) block(code);
  block('SOURCE_SUBSET_NOT_VALIDATED');
  block('TARGET_RECHECK_REQUIRED');
  block('WRITE_PRIVILEGES_NOT_REVIEWED');
  for (const code of [...targetTriggerReview.findings, ...targetTriggerReview.requires]) block(code);
  for (const code of [...targetExpressionReview.findings, ...targetExpressionReview.requires]) block(code);
  if (source.includeData) {
    block('TARGET_ENGINE_RECHECK_REQUIRED');
    block('TARGET_INDIRECT_WRITES_NOT_REVIEWED');
  }
  for (const finding of foreignKeyReview.findings) block(finding.code, finding.table);
  if (foreignKeyReview.truncated) block('FK_REVIEW_LIMIT');
  for (const row of foreignKeyReview.rows) {
    if (row.status !== 'excluded') block(row.reason, row.table, row.name);
    for (const code of row.requires) block(code, row.table, row.name);
  }
  for (const row of conflictPolicyReview.rows) {
    if (row.disposition === 'blocked') block(row.reason, row.name);
    if (row.disposition === 'review') for (const code of row.requires) block(code, row.name);
  }
  if (sessionContextReview.total) block('DUMP_CONTEXT_REQUIRES_POLICY');
  if (sessionContextReview.foreignKeyRecheckRequired) block('CONTEXT_FOREIGN_KEYS_RECHECK_REQUIRED');
  if (sessionContextReview.sqlModeReviewRequired) block('CONTEXT_SQL_MODE_REVIEW_REQUIRED');
  for (const finding of sessionContextReview.findings) block(finding.code, null, finding.number ? `#${finding.number}` : null);
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
  const createSyntaxTotals = { matched: 0, unsupported: 0, notReviewed: 0 };
  const steps = []; let previous = 0;
  for (const entry of entries.slice(0, 10000)) {
    let decision = 'blocked', reason = 'STATEMENT_NOT_CLASSIFIED';
    const numbered = Number.isSafeInteger(entry.number) && entry.number === previous + 1;
    if (!numbered) block('STATEMENT_LEDGER_INCOMPLETE');
    previous = entry.number;
    const syntaxReview = syntaxReviewFor(entry);
    const contextReview = projectContextReview(entry);
    if (selected.has(entry.table) && source.includeData && entry.command === 'INSERT') {
      syntaxTotals[syntaxReview?.status === 'matched' ? 'matched' : syntaxReview?.status === 'unsupported' ? 'unsupported' : 'notReviewed']++;
    }
    if (selected.has(entry.table) && source.includeStructure && entry.command === 'CREATE') {
      createSyntaxTotals[syntaxReview?.status === 'matched' ? 'matched' : syntaxReview?.status === 'unsupported' ? 'unsupported' : 'notReviewed']++;
    }
    if (numbered && ['structure', 'data'].includes(entry.kind) && typeof entry.table === 'string' && entry.table.length > 0 && entry.table.length <= 64) {
      if (!selected.has(entry.table)) { decision = 'excluded'; reason = 'TABLE_NOT_SELECTED'; }
      else if (entry.kind === 'structure' && !source.includeStructure || entry.kind === 'data' && !source.includeData) {
        decision = 'excluded'; reason = 'PART_NOT_SELECTED';
      } else if (entry.schema && entry.schema !== targetReview.database) reason = 'SCHEMA_MAPPING_REQUIRED';
      else if (!tablePolicies.has(entry.table)) reason = 'POLICY_METADATA_INCOMPLETE';
      else if (tablePolicies.get(entry.table)?.disposition === 'skip') { decision = 'excluded'; reason = 'POLICY_SKIP_EXISTING_TABLE'; }
      else if (tablePolicies.get(entry.table)?.disposition === 'blocked') reason = tablePolicies.get(entry.table).reason;
      else if (entry.command === 'DROP') reason = 'DESTRUCTIVE_POLICY_REQUIRED';
      else if (oversized.has(entry.number)) reason = 'PACKET_STATEMENT_TOO_LARGE';
      else if (packetReview.truncated && !packetRows.has(entry.number)) reason = 'PACKET_REPORT_LIMIT';
      else if (entry.command === 'INSERT' && syntaxReview?.status !== 'matched') reason = syntaxReview?.code || 'INSERT_SYNTAX_NOT_REVIEWED';
      else if (entry.command === 'INSERT' && valueIssues.has(entry.number)) reason = 'VALUE_BASIC_ISSUES';
      // The bounded report can omit a statement whose values have known issues.
      // Missing detail must never turn that statement back into a candidate.
      else if (entry.command === 'INSERT' && valueReview.truncated && !valueRows.has(entry.number)) reason = 'VALUE_REPORT_LIMIT';
      else if (entry.command === 'INSERT' && omittedIssues.has(entry.number)) reason = 'OMITTED_REQUIRED_COLUMN';
      else if (entry.command === 'INSERT' && omittedValueReview.truncated && !omittedRows.has(entry.number)) reason = 'OMITTED_REPORT_LIMIT';
      else if (entry.command === 'CREATE' && syntaxReview?.status !== 'matched') reason = syntaxReview?.code || 'CREATE_SYNTAX_NOT_REVIEWED';
      else if (entry.command === 'INSERT' && !source.includeStructure && targetEngines.get(entry.table)?.reason !== 'TARGET_ENGINE_INNODB_OBSERVED') {
        reason = targetEngines.get(entry.table)?.reason || 'TARGET_ENGINE_NOT_REVIEWED';
      }
      else if (entry.kind === 'structure' && entry.command === 'CREATE' || entry.kind === 'data' && entry.command === 'INSERT') {
        decision = 'candidate'; reason = entry.command === 'INSERT' ? 'LITERAL_INSERT_MATCHED' : 'BASIC_CREATE_MATCHED';
      }
    } else if (numbered && entry.kind === 'context') reason = contextReview?.status === 'matched'
      ? 'DUMP_CONTEXT_REQUIRES_POLICY' : contextReview?.code || 'CONTEXT_NOT_REVIEWED';
    else if (numbered && entry.kind === 'skipped') { decision = 'skipped'; reason = 'DIRECTIVE_SKIPPED_BY_CURRENT_RESTORE'; }
    totals[decision]++;
    if (decision === 'blocked') block(reason, entry.table || null, `#${entry.number}`);
    if (steps.length < 200) steps.push({ number: entry.number, command: entry.command, table: entry.table, schema: entry.schema, decision, reason, syntaxReview, contextReview, sizeReview: projectStatementSize(entry.sizeReview) });
  }
  if (entries.length > 10000) block('STATEMENT_LEDGER_INCOMPLETE');
  const selection = { tables: [...source.selectedTables].sort(), includeStructure: source.includeStructure, includeData: source.includeData };
  const binding = { version: 29, checksum, targetIdentity, targetSnapshotId: targetReview.snapshotId,
    sourceDatabase: source.sourceDatabase, targetDatabase: targetReview.database, selection, policy: 'review-only',
    ledger: ledger || null, sessionContextReview, conflictPolicyReview, targetEngineReview, targetTriggerReview, targetExpressionReview, foreignKeyReview, foreignKeyComparison, sessionPolicyReview, valueReview, omittedValueReview, packetReview, sourceFindings: source.findings, sourceTruncated: inventory.truncated || source.findingsTruncated,
    blockers: [...blockers].sort((left, right) => JSON.stringify(left) < JSON.stringify(right) ? -1 : JSON.stringify(left) > JSON.stringify(right) ? 1 : 0), blockersTruncated };
  const planId = crypto.createHash('sha256').update(JSON.stringify(binding)).digest('hex');
  return freeze({ version: 29, kind: 'restore-selection-draft', canExecute: false, status: 'blocked', planId,
    checksum, targetSnapshotId: targetReview.snapshotId, sourceDatabase: source.sourceDatabase, targetDatabase: targetReview.database,
    selection, policy: 'review-only', statementCount: ledger?.total || 0, totals, syntaxTotals, createSyntaxTotals, sessionContextReview, conflictPolicyReview, targetEngineReview, targetTriggerReview, targetExpressionReview, foreignKeyReview, foreignKeyComparison, sessionPolicyReview, valueReview, omittedValueReview, packetReview, steps,
    stepsTruncated: steps.length < entries.length || !!ledger?.truncated, blockers, blockersTruncated });
}

module.exports = { buildSelectionDraft };
