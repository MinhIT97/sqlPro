'use strict';

const WIDTHS = [8, 16, 24, 32, 64];

// Ten range bits, never the numeric literal itself. Strip leading zeroes before
// BigInt so a bounded SQL statement cannot allocate an enormous integer.
function integerRangeMask(literal, negative = false) {
  const digits = literal.replace(/^0+/, '') || '0';
  if (digits.length > 20) return 0;
  const value = BigInt(digits) * (negative ? -1n : 1n);
  let mask = 0;
  WIDTHS.forEach((bits, index) => {
    const half = 1n << BigInt(bits - 1), full = half * 2n;
    if (value >= -half && value < half) mask |= 1 << (index * 2);
    if (value >= 0n && value < full) mask |= 1 << (index * 2 + 1);
  });
  return mask;
}

module.exports = { integerRangeMask };
