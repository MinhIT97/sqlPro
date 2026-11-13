'use strict';

function fractionScale(value = '') {
  let scale = value.length;
  while (scale && value.charCodeAt(scale - 1) === 48) scale--;
  return scale;
}

// Only canonical single-quoted DATE/DATETIME/TIME bodies, with no escapes,
// timezone, relaxed separators or conversion. Never retain the original value.
function reviewTemporalString(value) {
  if (typeof value !== 'string' || value.length > 26) return null;
  const time = /^-?(\d{2,3}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?![\s\S])/.exec(value);
  if (time) {
    const hours = Number(time[1]), minutes = Number(time[2]), seconds = Number(time[3]), scale = fractionScale(time[4]);
    return { kind: 'time', problem: null, invalidTime: hours > 838 || minutes > 59 || seconds > 59, scale,
      upperBoundary: hours === 838 && minutes === 59 && seconds === 59 && scale > 0 };
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?)?(?![\s\S])/.exec(value);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const kind = match[4] === undefined ? 'date' : 'datetime';
  const leap = year % 400 === 0 || year % 4 === 0 && year % 100 !== 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const problem = !year || !month || !day ? 'zero' : year < 1000 ? 'year' : month > 12 || day > days[month - 1] ? 'calendar' : null;
  const scale = fractionScale(match[7]);
  return { kind, problem, invalidTime: kind === 'datetime' && (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59), scale,
    // The last fractional second at the documented upper bound needs separate
    // server/rounding proof; do not certify it from calendar checks alone.
    upperBoundary: kind === 'datetime' && year === 9999 && month === 12 && day === 31
      && match[4] === '23' && match[5] === '59' && match[6] === '59' && scale > 0 };
}

function emptyTemporalGroup() {
  return { count: 0, zeroComponents: 0, invalidDates: 0, unknownYears: 0, invalidTimes: 0, maxScale: 0, upperBoundary: 0 };
}
const emptyTemporal = () => ({ date: emptyTemporalGroup(), datetime: emptyTemporalGroup(), time: emptyTemporalGroup() });

function addTemporal(summary, value) {
  if (!value) return;
  const group = summary[value.kind];
  group.count++;
  if (value.problem === 'zero') group.zeroComponents++;
  if (value.problem === 'calendar') group.invalidDates++;
  if (value.problem === 'year') group.unknownYears++;
  if (value.invalidTime) group.invalidTimes++;
  if (value.upperBoundary) group.upperBoundary++;
  group.maxScale = Math.max(group.maxScale, value.scale);
}

function projectTemporal(value, field, version = 6) {
  if (![5, 6, 7].includes(version)) return null;
  if (![field?.text?.count, field?.numericStrings?.count].every(count => Number.isSafeInteger(count) && count >= 0 && count <= 10000)) return null;
  const result = {};
  for (const kind of version >= 6 ? ['date', 'datetime', 'time'] : ['date', 'datetime']) {
    const group = value?.[kind];
    if (!group || !['count', 'zeroComponents', 'invalidDates', 'unknownYears', 'invalidTimes', 'upperBoundary'].every(key =>
      Number.isSafeInteger(group[key]) && group[key] >= 0 && group[key] <= 10000)
      || group.zeroComponents + group.invalidDates + group.unknownYears > group.count
      || group.invalidTimes > group.count || group.upperBoundary > group.count
      || !Number.isInteger(group.maxScale) || group.maxScale < 0 || group.maxScale > 6
      || !group.count && (group.maxScale || group.invalidTimes || group.upperBoundary)
      || group.upperBoundary && !group.maxScale || kind === 'date' && (group.maxScale || group.invalidTimes || group.upperBoundary)
      || kind === 'time' && (group.zeroComponents || group.invalidDates || group.unknownYears)) return null;
    result[kind] = { count: group.count, zeroComponents: group.zeroComponents, invalidDates: group.invalidDates,
      unknownYears: group.unknownYears, invalidTimes: group.invalidTimes, maxScale: group.maxScale, upperBoundary: group.upperBoundary };
  }
  if (result.date.count + result.datetime.count + (result.time?.count || 0) + field.numericStrings.count > field.text.count) return null;
  return result;
}

function reviewTemporalColumn(field, type) {
  const match = /^(date|datetime|time)(?:\((\d+)\))?$/.exec(type);
  if (!match || match[1] === 'date' && match[2] !== undefined || Number(match[2] || 0) > 6) return ['VALUE_TEMPORAL_TYPE_NOT_REVIEWED'];
  if (!field.temporal?.[match[1]]) return ['VALUE_TEMPORAL_EVIDENCE_NOT_REVIEWED'];
  const group = field.temporal[match[1]], findings = [];
  if (group.zeroComponents) findings.push('VALUE_TEMPORAL_ZERO_REQUIRES_POLICY');
  if (group.invalidDates) findings.push('VALUE_TEMPORAL_INVALID_CALENDAR');
  if (group.invalidTimes) findings.push('VALUE_TEMPORAL_INVALID_TIME');
  if (group.unknownYears) findings.push('VALUE_TEMPORAL_YEAR_NOT_REVIEWED');
  if (group.upperBoundary) findings.push('VALUE_TEMPORAL_UPPER_BOUNDARY_NOT_REVIEWED');
  if (group.maxScale > Number(match[2] || 0)) findings.push('VALUE_TEMPORAL_PRECISION_LOSS');
  if (group.count < field.integers + field.other) findings.push('VALUE_CONVERSION_NOT_REVIEWED');
  return findings;
}

function reviewTimestampColumn(field, type) {
  const match = /^timestamp(?:\(([0-6])\))?$/.exec(type);
  if (!match) return ['VALUE_TEMPORAL_TYPE_NOT_REVIEWED'];
  // Calendar and precision evidence can be reused, but it carries no source or
  // destination zone, UTC instant, DST or server-range proof. Keep that gate.
  return [...reviewTemporalColumn(field, `datetime${match[1] === undefined ? '' : `(${match[1]})`}`),
    'VALUE_TIMESTAMP_ZONE_RANGE_NOT_REVIEWED'];
}

module.exports = { reviewTemporalString, emptyTemporal, addTemporal, projectTemporal, reviewTemporalColumn, reviewTimestampColumn };
