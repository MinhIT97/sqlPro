'use strict';

// Small ASCII digit grammar only. Numbers and strings have different zero /
// short-year conversion rules; never infer the converted century or value.
function reviewYearDigits(value, quoted = false) {
  if (typeof value !== 'string' || !/^\d{1,4}(?![\s\S])/.test(value)) return null;
  if (!quoted && value === '0') return 'zero';
  if (!/^[1-9]\d{3}(?![\s\S])/.test(value)) return 'conversion';
  const year = Number(value);
  return year >= 1901 && year <= 2155 ? 'valid' : 'outOfRange';
}

const emptyYearGroup = () => ({ count: 0, valid: 0, zero: 0, outOfRange: 0, conversion: 0 });
const emptyYear = () => ({ raw: emptyYearGroup(), quoted: emptyYearGroup() });

function addYear(summary, category, quoted = false) {
  if (!['valid', 'zero', 'outOfRange', 'conversion'].includes(category)) return;
  const group = summary[quoted ? 'quoted' : 'raw']; group.count++; group[category]++;
}

function projectYear(value, field) {
  const result = {};
  for (const kind of ['raw', 'quoted']) {
    const group = value?.[kind];
    if (!group || !['count', 'valid', 'zero', 'outOfRange', 'conversion'].every(key => Number.isSafeInteger(group[key]) && group[key] >= 0 && group[key] <= 10000)
        || group.valid + group.zero + group.outOfRange + group.conversion !== group.count || kind === 'quoted' && group.zero) return null;
    result[kind] = { count: group.count, valid: group.valid, zero: group.zero, outOfRange: group.outOfRange, conversion: group.conversion };
  }
  if (![field?.integers, field?.numericStrings?.integers].every(count => Number.isSafeInteger(count) && count >= 0 && count <= 10000)
      || result.raw.count > field.integers || result.quoted.count > field.numericStrings.integers) return null;
  return result;
}

function reviewYearColumn(field, type) {
  if (!/^year(?:\(4\))?$/.test(type)) return ['VALUE_YEAR_TYPE_NOT_REVIEWED'];
  if (!field.year) return ['VALUE_YEAR_EVIDENCE_NOT_REVIEWED'];
  const { raw, quoted } = field.year, findings = [];
  if (raw.outOfRange || quoted.outOfRange) findings.push('VALUE_YEAR_OUT_OF_RANGE');
  if (raw.conversion || quoted.conversion || raw.count + quoted.count < field.integers + field.other) findings.push('VALUE_YEAR_CONVERSION_NOT_REVIEWED');
  return findings;
}

module.exports = { reviewYearDigits, emptyYear, addYear, projectYear, reviewYearColumn };
