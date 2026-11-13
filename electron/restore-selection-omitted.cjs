'use strict';

const { projectValueEvidence, projectValueColumns } = require('./restore-selection-values.cjs');

// Only review metadata for columns omitted by a recognized INSERT. In
// particular, the presence of DEFAULT never proves its value/expression safe.
function reviewOmittedValues({ ledger, source, targetReview, policyReview }) {
  const rows = [], findings = [], creates = new Map(), sourceCache = new Map(), targetCache = new Map();
  const totals = { statements: 0, checked: 0, issues: 0, unknown: 0, excluded: 0, omittedColumns: 0 };
  let truncated = false, examined = 0, retained = 0;
  const flag = code => { if (!findings.includes(code)) { if (findings.length < 50) findings.push(code); else truncated = true; } };
  const entries = ledger?.version === 1 && Array.isArray(ledger.entries) ? ledger.entries.slice(0, 10000) : [];
  if (!entries.length || ledger.truncated || ledger.total !== entries.length || entries.some((entry, index) => entry.number !== index + 1)) flag('OMITTED_LEDGER_INCOMPLETE');
  const sources = new Map(source.rows.map(row => [row.name, row]));
  const targets = new Map(targetReview.rows.map(row => [row.name, row]));
  const policies = new Map(policyReview.rows.map(row => [row.name, row]));
  for (const entry of entries) if (entry.command === 'CREATE') {
    const group = creates.get(entry.table) || []; group.push(entry); creates.set(entry.table, group);
  }
  const unknown = code => ({ status: 'unknown', omittedCount: null, columns: [], findings: [code] });
  const inspect = (metadata, evidence) => {
    if (!metadata.complete) return unknown('OMITTED_COLUMNS_NOT_REVIEWED');
    if (examined + metadata.columns.length > 10000) { flag('OMITTED_ANALYSIS_LIMIT'); return unknown('OMITTED_ANALYSIS_LIMIT'); }
    examined += metadata.columns.length;
    const byName = new Map(metadata.columns.map(column => [column.name.toLowerCase(), column]));
    const supplied = evidence.columns || metadata.columns.filter(column => !column.invisible).map(column => column.name);
    if (supplied.length !== evidence.fields.length || supplied.some(name => !byName.has(name.toLowerCase()))) return unknown('OMITTED_MAPPING_UNKNOWN');
    const names = new Set(supplied.map(name => name.toLowerCase()));
    const columns = metadata.columns.filter(column => !names.has(column.name.toLowerCase())).map(column => {
      let status = 'unknown', code;
      if (!column.attributesKnown || !column.typeKnown) code = 'OMITTED_SEMANTICS_NOT_REVIEWED';
      else if (column.generated) code = 'OMITTED_GENERATED_NOT_REVIEWED';
      else if (column.autoIncrement) code = 'OMITTED_AUTO_INCREMENT_NOT_REVIEWED';
      else if (/^timestamp(?:\(|$)/.test(column.type)) code = 'OMITTED_TIMESTAMP_NOT_REVIEWED';
      else if (column.hasDefault === null) code = 'OMITTED_DEFAULT_METADATA_UNKNOWN';
      else if (column.hasDefault) code = 'OMITTED_DEFAULT_NOT_REVIEWED';
      else if (column.nullable) { status = 'checked'; code = 'OMITTED_IMPLICIT_NULL'; }
      else { status = 'issues'; code = 'OMITTED_REQUIRED_COLUMN'; }
      return { name: column.name, invisible: column.invisible, status, code };
    });
    totals.omittedColumns += columns.length;
    return { status: columns.some(column => column.status === 'issues') ? 'issues' : columns.some(column => column.status === 'unknown') ? 'unknown' : 'checked',
      omittedCount: columns.length, columns, findings: [] };
  };
  for (const entry of entries) {
    if (entry.command !== 'INSERT' || !sources.has(entry.table)) continue;
    totals.statements++;
    if (!source.includeData || policies.get(entry.table)?.disposition === 'skip' && (!entry.schema || entry.schema === targetReview.database)) { totals.excluded++; continue; }
    const syntax = entry.syntaxReview;
    const evidence = entry.kind === 'data' && syntax?.version === 1 && syntax.status === 'matched'
      && syntax.table === entry.table && syntax.schema === entry.schema ? projectValueEvidence(syntax.valueReview, syntax) : null;
    const reasons = [];
    if (!evidence) reasons.push('OMITTED_INSERT_NOT_REVIEWED');
    if (entry.schema && entry.schema !== targetReview.database) reasons.push('OMITTED_SCHEMA_MAPPING_REQUIRED');
    if (!sourceCache.has(entry.table)) {
      const candidates = creates.get(entry.table), create = candidates?.length === 1 ? candidates[0] : null;
      const schema = sources.get(entry.table).columnSchema, review = create?.syntaxReview;
      const matched = create?.kind === 'structure' && review?.version === 3 && review.status === 'matched' && review.code === 'BASIC_CREATE_MATCHED'
        && review.engine === 'InnoDB' && review.table === entry.table && review.schema === create.schema && (!create.schema || create.schema === targetReview.database)
        && review.columns === schema?.columns?.length;
      sourceCache.set(entry.table, projectValueColumns(schema?.columns, schema?.complete && matched));
    }
    if (!targetCache.has(entry.table)) {
      const metadata = targets.get(entry.table)?.valueColumns;
      targetCache.set(entry.table, projectValueColumns(metadata?.columns, metadata?.version === 2 && metadata.complete));
    }
    const left = reasons.length ? unknown(reasons[0]) : inspect(sourceCache.get(entry.table), evidence);
    const right = reasons.length ? unknown(reasons[0]) : inspect(targetCache.get(entry.table), evidence);
    const status = [left, right].some(side => side.status === 'issues') ? 'issues' : reasons.length || [left, right].some(side => side.status === 'unknown') ? 'unknown' : 'checked';
    totals[status]++;
    if (status === 'issues') flag('OMITTED_REQUIRED_COLUMN');
    if (status === 'unknown') flag('OMITTED_REVIEW_INCOMPLETE');
    const size = left.columns.length + right.columns.length;
    if (rows.length < 100 && retained + size <= 1000) { retained += size; rows.push({ number: entry.number, table: entry.table, status, reasons, source: left, target: right }); }
    else truncated = true;
  }
  if (truncated) flag('OMITTED_REPORT_LIMIT');
  return { version: 1, canExecute: false, status: 'partial', totals, rows, findings, truncated,
    requires: ['OMITTED_DEFAULT_VALUES_NOT_VALIDATED', 'OMITTED_SERVER_RULES_NOT_VALIDATED', 'OMITTED_TARGET_RECHECK_REQUIRED'] };
}

module.exports = { reviewOmittedValues };
