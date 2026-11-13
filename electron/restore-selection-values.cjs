'use strict';

const { projectFixedPoint, reviewDecimal } = require('./restore-selection-decimal.cjs');

const { integerRangeMask } = require('./restore-selection-integer.cjs');
const { projectNumericStrings, mergeFixedPoint } = require('./restore-selection-numeric-strings.cjs');
const { projectText, reviewTextColumn } = require('./restore-selection-text.cjs');
const { projectTemporal, reviewTemporalColumn, reviewTimestampColumn } = require('./restore-selection-temporal.cjs');
const { projectYear, reviewYearColumn } = require('./restore-selection-year.cjs');
const ALL_RANGES = 1023;
const name = value => typeof value === 'string' && value.length > 0 && value.length <= 64 && !value.includes('\0');
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 10000;

function projectValueEvidence(review, syntax) {
  if (![1, 2, 3, 4, 5, 6, 7].includes(review?.version) || !count(syntax?.rows) || syntax.rows < 1 || !Number.isInteger(syntax.valuesPerRow)
      || syntax.valuesPerRow < 1 || syntax.valuesPerRow > 256 || review.rows !== syntax.rows || !Array.isArray(review.fields)
      || review.fields.length !== syntax.valuesPerRow) return null;
  if (syntax.columnMode === 'explicit') {
    if (!Array.isArray(review.columns) || review.columns.length !== review.fields.length || review.columns.some(value => !name(value))
        || new Set(review.columns.map(value => value.toLowerCase())).size !== review.columns.length) return null;
  } else if (syntax.columnMode !== 'positional' || review.columns !== null) return null;
  const fields = [];
  for (const field of review.fields) {
    if (!field || ![field.nulls, field.integers, field.other].every(count) || field.nulls + field.integers + field.other !== review.rows
        || !Number.isInteger(field.fitMask) || field.fitMask < 0 || field.fitMask > ALL_RANGES
        || field.integers === 0 && field.fitMask !== ALL_RANGES) return null;
    const fixedPoint = review.version >= 2 ? projectFixedPoint(field.fixedPoint, field) : null;
    if (review.version >= 2 && !fixedPoint) return null;
    const numericStrings = review.version >= 3 ? projectNumericStrings(field.numericStrings, field, fixedPoint) : null;
    if (review.version >= 3 && !numericStrings) return null;
    const text = review.version >= 4 ? projectText(field.text, { ...field, fixedPoint, numericStrings }) : null;
    if (review.version >= 4 && !text) return null;
    const temporal = review.version >= 5 ? projectTemporal(field.temporal, { numericStrings, text }, review.version) : null;
    if (review.version >= 5 && !temporal) return null;
    const year = review.version === 7 ? projectYear(field.year, { ...field, numericStrings }) : null;
    if (review.version === 7 && !year) return null;
    fields.push({ nulls: field.nulls, integers: field.integers, other: field.other, fitMask: field.fitMask,
      ...(review.version >= 2 ? { fixedPoint } : {}), ...(review.version >= 3 ? { numericStrings } : {}), ...(review.version >= 4 ? { text } : {}),
      ...(review.version >= 5 ? { temporal } : {}), ...(review.version === 7 ? { year } : {}) });
  }
  return { version: review.version, rows: review.rows, columns: review.columns ? [...review.columns] : null, fields };
}

function projectValueColumns(columns, complete, limit = 256) {
  const result = { version: 2, complete: false, columns: [] };
  if (!Array.isArray(columns) || !columns.length || columns.length > Math.min(256, limit)) return result;
  const names = new Set();
  for (const column of columns) {
    if (!column || !name(column.name) || names.has(column.name.toLowerCase()) || column.ordinal !== result.columns.length + 1
        || typeof column.type !== 'string' || column.type.length > 160
        || !['typeKnown', 'nullable', 'autoIncrement', 'generated', 'invisible', 'attributesKnown'].every(key => typeof column[key] === 'boolean')) return { ...result, columns: [] };
    names.add(column.name.toLowerCase());
    result.columns.push({ name: column.name, ordinal: column.ordinal, type: column.type, typeKnown: column.typeKnown,
      nullable: column.nullable, autoIncrement: column.autoIncrement, generated: column.generated, invisible: column.invisible, attributesKnown: column.attributesKnown,
      hasDefault: typeof column.hasDefault === 'boolean' ? column.hasDefault : null,
      charset: typeof column.charset === 'string' && /^[a-z0-9_]{1,64}$/i.test(column.charset) ? column.charset.toLowerCase() : null });
  }
  result.complete = complete === true;
  return result;
}

function checkField(field, column) {
  if (!column) return { status: 'unknown', findings: ['VALUE_COLUMN_MAPPING_UNKNOWN'] };
  const findings = [];
  let issue = false;
  const add = (code, definite = false) => { findings.push(code); issue ||= definite; };
  if (!column.typeKnown || !column.attributesKnown || column.generated) return { status: 'unknown', findings: ['VALUE_COLUMN_SEMANTICS_NOT_REVIEWED'] };
  if (field.nulls && column.autoIncrement) add('VALUE_NULL_SPECIAL_SEMANTICS');
  else if (field.nulls && !column.nullable) {
    if (/^timestamp(?:\(|$)/.test(column.type)) add('VALUE_NULL_SPECIAL_SEMANTICS');
    else add('VALUE_NULL_NOT_ALLOWED', true);
  }
  const decimal = /^(?:decimal|numeric)(?:\b|\()/.test(column.type);
  const strings = field.numericStrings;
  const integers = field.integers + (strings?.integers || 0);
  const other = field.other - (strings?.integers || 0);
  const text = /^(?:char|varchar|tinytext|text|mediumtext|longtext)(?:\b|\()/.test(column.type);
  const timestamp = /^timestamp(?:\b|\()/.test(column.type);
  const temporal = timestamp || /^(?:date|datetime|time)(?:\b|\()/.test(column.type);
  const year = /^year(?:\b|\()/.test(column.type);
  if (year && (field.integers || field.other)) {
    for (const code of reviewYearColumn(field, column.type)) add(code, code === 'VALUE_YEAR_OUT_OF_RANGE');
  } else if (temporal && (field.integers || field.other)) {
    const review = timestamp ? reviewTimestampColumn : reviewTemporalColumn;
    for (const code of review(field, column.type)) add(code, ['VALUE_TEMPORAL_ZERO_REQUIRES_POLICY', 'VALUE_TEMPORAL_INVALID_CALENDAR', 'VALUE_TEMPORAL_INVALID_TIME', 'VALUE_TEMPORAL_PRECISION_LOSS'].includes(code));
  } else if (text && (field.integers || field.other)) {
    for (const code of reviewTextColumn(field, column)) add(code, ['VALUE_TEXT_TOO_LONG', 'VALUE_TEXT_CHARSET_LOSS', 'VALUE_CHAR_TRAILING_SPACES'].includes(code));
  } else if (decimal && (field.integers || field.other)) {
    const fixedPoint = strings ? mergeFixedPoint(field.fixedPoint, strings.fixedPoint) : field.fixedPoint;
    for (const code of reviewDecimal({ ...field, fixedPoint }, column.type)) add(code, ['VALUE_DECIMAL_OUT_OF_RANGE', 'VALUE_DECIMAL_UNSIGNED_NEGATIVE', 'VALUE_DECIMAL_SCALE_LOSS'].includes(code));
  } else if (integers) {
    const integer = /^(tinyint|smallint|mediumint|int|integer|bigint)(?:\(\d+\))?(?: unsigned)?(?: zerofill)?$/.exec(column.type);
    if (!integer) add('VALUE_CONVERSION_NOT_REVIEWED');
    else {
      const index = ['tinyint', 'smallint', 'mediumint', 'int', 'bigint'].indexOf(integer[1] === 'integer' ? 'int' : integer[1]);
      const bit = index * 2 + (/\b(?:unsigned|zerofill)\b/.test(column.type) ? 1 : 0);
      if (!((field.fitMask & (strings?.fitMask ?? 1023)) & (1 << bit))) add('VALUE_INTEGER_OUT_OF_RANGE', true);
    }
  }
  if (other && !decimal && !text && !temporal && !year) add('VALUE_CONVERSION_NOT_REVIEWED');
  if (column.autoIncrement && integers) add('VALUE_AUTO_INCREMENT_NOT_REVIEWED');
  return { status: issue ? 'issues' : findings.length ? 'unknown' : 'basic-checked', findings };
}

// Only local NULL/numeric/text/calendar/duration/year bounds. Never infer constraint/SQL mode correctness,
// absence of target objects, or permission to execute from these observations.
function reviewSelectionValues({ ledger, source, targetReview, policyReview, sessionPolicyReview }) {
  const rows = [], findings = [];
  let truncated = false, retainedFields = 0, examinedFields = 0;
  const totals = { statements: 0, basicChecked: 0, issues: 0, unknown: 0, excluded: 0 };
  const add = code => { if (findings.includes(code)) return; if (findings.length < 50) findings.push(code); else truncated = true; };
  const entries = Array.isArray(ledger?.entries) ? ledger.entries.slice(0, 10000) : [];
  if (ledger?.version !== 1 || ledger.truncated || ledger.total !== entries.length || !entries.length
      || entries.some((entry, index) => entry.number !== index + 1)) add('VALUE_LEDGER_INCOMPLETE');
  if (!sessionPolicyReview?.observations || sessionPolicyReview.findings.length) add('VALUE_SESSION_NOT_REVIEWED');
  const sourceRows = new Map(source.rows.map(row => [row.name, row]));
  const targetRows = new Map(targetReview.rows.map(row => [row.name, row]));
  const policies = new Map(policyReview.rows.map(row => [row.name, row]));
  const sourceCache = new Map(), targetCache = new Map();
  const creates = new Map();
  for (const entry of entries) if (entry.command === 'CREATE' && entry.kind === 'structure') {
    const review = entry.syntaxReview;
    if (creates.has(entry.table)) creates.set(entry.table, false);
    else creates.set(entry.table, review?.version === 3 && review.status === 'matched' && review.code === 'BASIC_CREATE_MATCHED'
      && review.engine === 'InnoDB' && review.columns === sourceRows.get(entry.table)?.columnSchema?.columns?.length
      && review.table === entry.table && review.schema === entry.schema && (!entry.schema || entry.schema === targetReview.database));
  }
  for (const entry of entries) {
    if (entry.command !== 'INSERT' || !sourceRows.has(entry.table)) continue;
    totals.statements++;
    if (!source.includeData || policies.get(entry.table)?.disposition === 'skip' && (!entry.schema || entry.schema === targetReview.database)) { totals.excluded++; continue; }
    const syntax = entry.syntaxReview;
    let evidence = entry.kind === 'data' && syntax?.version === 1 && syntax.status === 'matched' && syntax.table === entry.table
      && syntax.schema === entry.schema ? projectValueEvidence(syntax.valueReview, syntax) : null;
    if (evidence && examinedFields + evidence.fields.length > 10000) { evidence = null; add('VALUE_EVIDENCE_LIMIT'); }
    if (evidence) examinedFields += evidence.fields.length;
    const reasons = [], fields = [];
    const rowSource = sourceRows.get(entry.table), rowTarget = targetRows.get(entry.table);
    if (!sourceCache.has(entry.table)) sourceCache.set(entry.table,
      projectValueColumns(rowSource.columnSchema?.columns, rowSource.columnSchema?.complete && creates.get(entry.table) === true));
    if (!targetCache.has(entry.table)) targetCache.set(entry.table,
      projectValueColumns(rowTarget?.valueColumns?.columns, [1, 2].includes(rowTarget?.valueColumns?.version) && rowTarget.valueColumns.complete));
    const sourceColumns = sourceCache.get(entry.table), targetColumns = targetCache.get(entry.table);
    if (!evidence) reasons.push('VALUE_EVIDENCE_NOT_REVIEWED');
    if (entry.schema && entry.schema !== targetReview.database) reasons.push('VALUE_SCHEMA_REQUIRES_MAPPING');
    if (!sourceColumns.complete) reasons.push('VALUE_SOURCE_COLUMNS_NOT_REVIEWED');
    if (!targetColumns.complete) reasons.push('VALUE_TARGET_COLUMNS_NOT_REVIEWED');
    if (evidence) {
      const mapped = metadata => ({ ...metadata, byName: new Map(metadata.columns.map(column => [column.name.toLowerCase(), column])),
        visible: metadata.columns.filter(column => !column.invisible) });
      const leftColumns = mapped(sourceColumns), rightColumns = mapped(targetColumns);
      const map = (metadata, position) => {
        if (!metadata.complete) return null;
        if (evidence.columns) return metadata.byName.get(evidence.columns[position].toLowerCase()) || null;
        return metadata.visible.length === evidence.fields.length ? metadata.visible[position] : null;
      };
      for (const [position, field] of evidence.fields.entries()) {
        const left = map(leftColumns, position), right = reasons.includes('VALUE_SCHEMA_REQUIRES_MAPPING') ? null : map(rightColumns, position);
        fields.push({ position: position + 1, column: evidence.columns?.[position] || left?.name || right?.name || null,
          sourceColumn: left?.name || null, targetColumn: right?.name || null,
          counts: { nulls: field.nulls, integers: field.integers, other: field.other,
            fixedDecimals: field.fixedPoint ? field.fixedPoint.count - field.integers : null,
            numericStrings: field.numericStrings?.count ?? null, text: field.text?.count ?? null,
            temporalStrings: field.temporal ? field.temporal.date.count + field.temporal.datetime.count + (field.temporal.time?.count || 0) : null,
            yearLiterals: field.year ? field.year.raw.count + field.year.quoted.count : null }, source: checkField(field, left), target: checkField(field, right) });
      }
    }
    const status = fields.some(field => field.source.status === 'issues' || field.target.status === 'issues') ? 'issues'
      : reasons.length || fields.some(field => field.source.status === 'unknown' || field.target.status === 'unknown') ? 'unknown' : 'basic-checked';
    totals[status === 'basic-checked' ? 'basicChecked' : status]++;
    if (status === 'issues') add('VALUE_BASIC_ISSUES');
    if (status === 'unknown') add('VALUE_REVIEW_INCOMPLETE');
    if (rows.length < 100 && retainedFields + fields.length <= 1000) {
      retainedFields += fields.length;
      rows.push({ number: entry.number, table: entry.table, status, reasons, fields });
    } else truncated = true;
  }
  if (truncated) add('VALUE_REPORT_LIMIT');
  return { version: 8, canExecute: false, status: 'partial', scope: 'null-numeric-text-calendar-duration-year-and-timestamp-local-bounds', totals, rows, findings, truncated,
    requires: ['VALUE_FULL_VALIDATION_REQUIRED', 'VALUE_CONSTRAINTS_NOT_REVIEWED', 'VALUE_TARGET_RECHECK_REQUIRED'] };
}

module.exports = { integerRangeMask, projectValueEvidence, projectValueColumns, reviewSelectionValues };
