'use strict';

const MAX_STATEMENT_BYTES = 16 * 1024 * 1024;

function normalizePacketSettings(value) {
  if (!['number', 'string'].includes(typeof value) || !/^[1-9]\d{0,9}$/.test(String(value))) return null;
  const maxAllowedPacket = Number(value);
  return Number.isSafeInteger(maxAllowedPacket) && maxAllowedPacket >= 1024 && maxAllowedPacket <= 1073741824
    ? { version: 1, maxAllowedPacket } : null;
}

function projectPacketSettings(value) {
  return value?.version === 1 ? normalizePacketSettings(value.maxAllowedPacket) : null;
}

function statementSizeReview(sql) {
  if (typeof sql !== 'string' || !sql.length || sql.length > MAX_STATEMENT_BYTES) return null;
  const utf8Bytes = Buffer.byteLength(sql, 'utf8');
  return utf8Bytes <= MAX_STATEMENT_BYTES ? { version: 1, utf8Bytes } : null;
}

function projectStatementSize(value) {
  return value?.version === 1 && Number.isSafeInteger(value.utf8Bytes) && value.utf8Bytes > 0 && value.utf8Bytes <= MAX_STATEMENT_BYTES
    ? { version: 1, utf8Bytes: value.utf8Bytes } : null;
}

// Only original SQL byte sizes versus an observed server limit. No batching,
// rewritten SQL, client/protocol budget or storage row-size proof is inferred.
function reviewSelectionPackets({ ledger, source, targetReview, policyReview }) {
  const settings = projectPacketSettings(targetReview.packetSettings), rows = [], findings = [];
  const totals = { statements: 0, withinObserved: 0, oversized: 0, unknown: 0, excluded: 0 };
  const selected = new Set(source.selectedTables), policies = new Map(policyReview.rows.map(row => [row.name, row]));
  const entries = ledger?.version === 1 && Array.isArray(ledger.entries) ? ledger.entries.slice(0, 10000) : [];
  let truncated = false;
  const flag = code => { if (!findings.includes(code)) { if (findings.length < 20) findings.push(code); else truncated = true; } };
  const encodingKnown = [1, 2].includes(targetReview.sessionSettings?.version) && targetReview.sessionSettings.charsetClient === 'utf8mb4';
  if (!settings) flag('PACKET_LIMIT_NOT_OBSERVED');
  if (!encodingKnown) flag('PACKET_ENCODING_NOT_REVIEWED');
  if (!entries.length || ledger.truncated || ledger.total !== entries.length || entries.some((entry, i) => entry.number !== i + 1)) flag('PACKET_LEDGER_INCOMPLETE');
  for (const entry of entries) {
    if (!selected.has(entry.table) || !['structure', 'data'].includes(entry.kind) || !['CREATE', 'INSERT', 'DROP'].includes(entry.command)) continue;
    totals.statements++;
    if (entry.kind === 'structure' && !source.includeStructure || entry.kind === 'data' && !source.includeData
        || policies.get(entry.table)?.disposition === 'skip' && (!entry.schema || entry.schema === targetReview.database)) { totals.excluded++; continue; }
    const evidence = projectStatementSize(entry.sizeReview);
    let status = 'unknown', reason = !evidence ? 'PACKET_SIZE_NOT_REVIEWED' : !settings ? 'PACKET_LIMIT_NOT_OBSERVED' : !encodingKnown ? 'PACKET_ENCODING_NOT_REVIEWED' : null;
    if (entry.schema && entry.schema !== targetReview.database) reason = 'PACKET_SCHEMA_MAPPING_REQUIRED';
    if (!reason) {
      if (evidence.utf8Bytes > settings.maxAllowedPacket) { status = 'oversized'; reason = 'PACKET_STATEMENT_TOO_LARGE'; }
      // Retain a small conservative protocol margin as unknown, without
      // guessing whether a server/version counts each framing byte.
      else if (evidence.utf8Bytes + 5 >= settings.maxAllowedPacket) reason = 'PACKET_BOUNDARY_REQUIRES_REVIEW';
      else { status = 'withinObserved'; reason = 'PACKET_WITHIN_OBSERVED_LIMIT'; }
    }
    totals[status]++;
    if (status !== 'withinObserved') flag(reason);
    if (rows.length < 200) rows.push({ number: entry.number, table: entry.table, command: entry.command, utf8Bytes: evidence?.utf8Bytes ?? null, status, reason });
    else truncated = true;
  }
  if (truncated) flag('PACKET_REPORT_LIMIT');
  return { version: 1, canExecute: false, status: 'partial', encoding: 'utf8mb4', settings, totals, rows, findings, truncated,
    requires: ['PACKET_CLIENT_PROTOCOL_NOT_VALIDATED', 'PACKET_REWRITE_NOT_VALIDATED', 'PACKET_STORAGE_ROW_LIMITS_NOT_REVIEWED', 'PACKET_TARGET_RECHECK_REQUIRED'] };
}

module.exports = { normalizePacketSettings, projectPacketSettings, statementSizeReview, projectStatementSize, reviewSelectionPackets };
