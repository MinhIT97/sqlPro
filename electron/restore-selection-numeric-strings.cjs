'use strict';

const { integerRangeMask } = require('./restore-selection-integer.cjs');
const { fixedPointShape, emptyFixedPoint, addFixedPoint, projectFixedPoint } = require('./restore-selection-decimal.cjs');

// Exact, complete ASCII numeric strings only. No trim, prefix parsing,
// exponent, locale separator or SQL escape interpretation. Contents never leave
// this function: only bounded counts/digit requirements and range bits do.
function reviewNumericString(value) {
  // Unlike $, this end check also rejects a final line terminator.
  if (typeof value !== 'string' || value.length > 256 || !/^[+-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?![\s\S])/.test(value)) return null;
  const negative = value[0] === '-', digits = /^[+-]/.test(value) ? value.slice(1) : value;
  const integer = !digits.includes('.');
  return { integer, fitMask: integer ? integerRangeMask(digits, negative) : 1023, shape: fixedPointShape(digits, negative) };
}

function emptyNumericStrings() {
  return { count: 0, integers: 0, fitMask: 1023, fixedPoint: emptyFixedPoint() };
}

function addNumericString(summary, value) {
  if (!value) return;
  summary.count++;
  if (value.integer) { summary.integers++; summary.fitMask &= value.fitMask; }
  addFixedPoint(summary.fixedPoint, value.shape);
}

function projectNumericStrings(value, field, rawFixedPoint) {
  if (!value || !rawFixedPoint || !Number.isSafeInteger(value.count) || value.count < 0
      || value.count > field.other - (rawFixedPoint.count - field.integers)
      || !Number.isSafeInteger(value.integers) || value.integers < 0 || value.integers > value.count
      || !Number.isInteger(value.fitMask) || value.fitMask < 0 || value.fitMask > 1023
      || value.integers === 0 && value.fitMask !== 1023) return null;
  const fixedPoint = projectFixedPoint(value.fixedPoint, { integers: value.integers, other: value.count - value.integers });
  if (!fixedPoint || fixedPoint.count !== value.count) return null;
  return { count: value.count, integers: value.integers, fitMask: value.fitMask, fixedPoint };
}

function mergeFixedPoint(left, right) {
  if (!left || !right) return null;
  return { count: left.count + right.count, integerDigits: Math.max(left.integerDigits, right.integerDigits),
    scale: Math.max(left.scale, right.scale), literalDigits: Math.max(left.literalDigits, right.literalDigits), negativeCount: left.negativeCount + right.negativeCount };
}

module.exports = { reviewNumericString, emptyNumericStrings, addNumericString, projectNumericStrings, mergeFixedPoint };
