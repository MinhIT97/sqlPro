'use strict';

const MAX_BYTES = 2 * 1024 * 1024;

// Inspect an already recognized single-quoted body without copying/retaining
// its contents. Decode only doubled quotes; backslash SQL escapes stay outside
// the supported grammar. Unicode scalars, not UTF-16 units or grapheme clusters.
function reviewTextLiteral(sql, start, end) {
  if (typeof sql !== 'string' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || end < start || end > sql.length || end - start > MAX_BYTES) return null;
  let characters = 0, utf8Bytes = 0, ascii = true, bmp = true, wellFormed = true, last = null;
  for (let index = start; index < end;) {
    const point = sql.codePointAt(index);
    if (point === 92) return null;
    if (point === 39) { if (sql[index + 1] !== "'" || index + 1 >= end) return null; index++; }
    const units = point > 65535 ? 2 : 1;
    if (index + units > end) return null;
    index += units; characters++;
    utf8Bytes += point <= 127 ? 1 : point <= 2047 ? 2 : point <= 65535 ? 3 : 4;
    ascii &&= point <= 127; bmp &&= point <= 65535;
    if (point >= 0xd800 && point <= 0xdfff) wellFormed = false;
    last = point;
    if (utf8Bytes > MAX_BYTES) return null;
  }
  return { characters, utf8Bytes, ascii, bmp, wellFormed, trailingSpace: last === 32 };
}

function emptyText() {
  return { count: 0, maxCharacters: 0, maxUtf8Bytes: 0, ascii: true, bmp: true, wellFormed: true, trailingSpaces: 0 };
}

function addText(summary, value) {
  if (!value) return;
  summary.count++; summary.maxCharacters = Math.max(summary.maxCharacters, value.characters);
  summary.maxUtf8Bytes = Math.max(summary.maxUtf8Bytes, value.utf8Bytes);
  summary.ascii &&= value.ascii; summary.bmp &&= value.bmp; summary.wellFormed &&= value.wellFormed;
  if (value.trailingSpace) summary.trailingSpaces++;
}

function projectText(value, field) {
  const maximum = field.other - (field.fixedPoint.count - field.integers);
  if (!value || !Number.isSafeInteger(value.count) || value.count < field.numericStrings.count || value.count > maximum
      || !Number.isInteger(value.maxCharacters) || value.maxCharacters < 0 || value.maxCharacters > MAX_BYTES
      || !Number.isInteger(value.maxUtf8Bytes) || value.maxUtf8Bytes < value.maxCharacters || value.maxUtf8Bytes > Math.min(MAX_BYTES, value.maxCharacters * 4)
      || !['ascii', 'bmp', 'wellFormed'].every(key => typeof value[key] === 'boolean')
      || !Number.isInteger(value.trailingSpaces) || value.trailingSpaces < 0 || value.trailingSpaces > value.count
      || value.ascii && (!value.bmp || !value.wellFormed || value.maxUtf8Bytes !== value.maxCharacters)
      || value.bmp && value.maxUtf8Bytes > value.maxCharacters * 3
      || value.count === 0 && (value.maxCharacters || value.maxUtf8Bytes || !value.ascii || !value.bmp || !value.wellFormed || value.trailingSpaces)
      || value.maxCharacters === 0 && (!value.ascii || !value.bmp || !value.wellFormed || value.trailingSpaces)) return null;
  return { count: value.count, maxCharacters: value.maxCharacters, maxUtf8Bytes: value.maxUtf8Bytes,
    ascii: value.ascii, bmp: value.bmp, wellFormed: value.wellFormed, trailingSpaces: value.trailingSpaces };
}

function reviewTextColumn(field, column) {
  const findings = [], summary = field.text;
  if (!summary) return ['VALUE_TEXT_EVIDENCE_NOT_REVIEWED'];
  if (summary.count < field.integers + field.other) findings.push('VALUE_CONVERSION_NOT_REVIEWED');
  if (!summary.count) return findings;
  const sized = /^(char|varchar)\((\d+)\)$/.exec(column.type);
  const bytes = { tinytext: 255, text: 65535, mediumtext: 16777215, longtext: 4294967295 }[column.type];
  if (sized) {
    const length = Number(sized[2]);
    if (length < 1 || length > (sized[1] === 'char' ? 255 : 65535)) findings.push('VALUE_TEXT_TYPE_NOT_REVIEWED');
    else if (summary.maxCharacters > length) findings.push('VALUE_TEXT_TOO_LONG');
    if (sized[1] === 'char') {
      findings.push('VALUE_CHAR_PADDING_NOT_REVIEWED');
      if (summary.trailingSpaces) findings.push('VALUE_CHAR_TRAILING_SPACES');
    }
  } else if (!bytes) findings.push('VALUE_TEXT_TYPE_NOT_REVIEWED');
  if (!summary.wellFormed) findings.push('VALUE_TEXT_ENCODING_NOT_REVIEWED');
  const charset = column.charset;
  // Do not infer what the configurable utf8 alias means on a given server.
  if (!['utf8mb4', 'utf8mb3', 'ascii'].includes(charset)) findings.push('VALUE_TEXT_CHARSET_NOT_REVIEWED');
  else {
    if (charset === 'ascii' && !summary.ascii || charset === 'utf8mb3' && !summary.bmp) findings.push('VALUE_TEXT_CHARSET_LOSS');
    if (bytes && (charset === 'ascii' ? summary.maxCharacters : summary.maxUtf8Bytes) > bytes) findings.push('VALUE_TEXT_TOO_LONG');
  }
  return findings;
}

module.exports = { reviewTextLiteral, emptyText, addText, projectText, reviewTextColumn };
