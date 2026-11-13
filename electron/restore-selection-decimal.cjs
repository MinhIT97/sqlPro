'use strict';

// Saturated shape statistics only: neither digits nor a reversible value/hash
// are retained. Exponent literals use approximate-number semantics and are
// deliberately excluded from this fixed-point review.
function fixedPointShape(literal, negative = false) {
  if (typeof literal !== 'string' || literal.length > 2 * 1024 * 1024 || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(literal)) return null;
  const dot = literal.indexOf('.');
  const whole = dot < 0 ? literal : literal.slice(0, dot), fraction = dot < 0 ? '' : literal.slice(dot + 1);
  const integerDigits = whole.replace(/^0+/, '').length;
  let scale = fraction.length;
  while (scale > 0 && fraction.charCodeAt(scale - 1) === 48) scale--;
  return { integerDigits: Math.min(66, integerDigits), scale: Math.min(31, scale),
    literalDigits: Math.min(66, integerDigits + fraction.length), negative: negative && (integerDigits > 0 || scale > 0) };
}

function emptyFixedPoint() {
  return { count: 0, integerDigits: 0, scale: 0, literalDigits: 0, negativeCount: 0 };
}

function addFixedPoint(summary, shape) {
  if (!shape) return;
  summary.count++;
  summary.integerDigits = Math.max(summary.integerDigits, shape.integerDigits);
  summary.scale = Math.max(summary.scale, shape.scale);
  summary.literalDigits = Math.max(summary.literalDigits, shape.literalDigits);
  if (shape.negative) summary.negativeCount++;
}

function projectFixedPoint(value, field) {
  if (!value || !Number.isSafeInteger(value.count) || value.count < field.integers || value.count > field.integers + field.other
      || !Number.isSafeInteger(value.negativeCount) || value.negativeCount < 0 || value.negativeCount > value.count
      || !Number.isInteger(value.integerDigits) || value.integerDigits < 0 || value.integerDigits > 66
      || !Number.isInteger(value.scale) || value.scale < 0 || value.scale > 31
      || !Number.isInteger(value.literalDigits) || value.literalDigits < Math.max(value.integerDigits, value.scale) || value.literalDigits > 66
      || value.count === field.integers && (value.scale || value.literalDigits !== value.integerDigits)
      || value.count === 0 && (value.integerDigits || value.scale || value.literalDigits || value.negativeCount)
      || value.negativeCount && !value.integerDigits && !value.scale) return null;
  return { count: value.count, integerDigits: value.integerDigits, scale: value.scale, literalDigits: value.literalDigits, negativeCount: value.negativeCount };
}

function decimalType(type) {
  const match = /^(?:decimal|numeric)(?:\((\d+)(?:,(\d+))?\))?(?: unsigned)?(?: zerofill)?$/.exec(type);
  if (!match) return null;
  const precision = match[1] === undefined ? 10 : Number(match[1]), scale = match[2] === undefined ? 0 : Number(match[2]);
  // Shared verified MySQL/MariaDB range. MariaDB scale >30 needs a separate
  // server-specific proof rather than guessing from its version string.
  if (precision < 1 || precision > 65 || scale < 0 || scale > 30 || scale > precision) return null;
  return { precision, scale, unsigned: /\b(?:unsigned|zerofill)\b/.test(type) };
}

function reviewDecimal(field, type) {
  const definition = decimalType(type), shape = field.fixedPoint;
  if (!definition) return ['VALUE_DECIMAL_TYPE_NOT_REVIEWED'];
  if (!shape) return ['VALUE_DECIMAL_EVIDENCE_NOT_REVIEWED'];
  const findings = [];
  if (shape.integerDigits > definition.precision - definition.scale) findings.push('VALUE_DECIMAL_OUT_OF_RANGE');
  if (definition.unsigned && shape.negativeCount) findings.push('VALUE_DECIMAL_UNSIGNED_NEGATIVE');
  if (shape.scale > definition.scale) findings.push('VALUE_DECIMAL_SCALE_LOSS');
  if (shape.literalDigits > 65) findings.push('VALUE_NUMERIC_LITERAL_PRECISION_NOT_REVIEWED');
  if (shape.count < field.integers + field.other) findings.push('VALUE_CONVERSION_NOT_REVIEWED');
  return findings;
}

module.exports = { fixedPointShape, emptyFixedPoint, addFixedPoint, projectFixedPoint, decimalType, reviewDecimal };
