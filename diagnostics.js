(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SqlDiagnostics = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function createSqlDiagnostics() {
  'use strict';

  const SYSTEM_USERS = Object.freeze(['system user', 'event_scheduler', 'root_replication']);
  const SYSTEM_COMMANDS = Object.freeze(['Binlog Dump', 'Binlog Dump GTID', 'Daemon', 'Register Slave']);

  function isSystemThread(proc) {
    if (!proc || typeof proc !== 'object') return false;
    const user = String(proc.user || '').toLowerCase().trim();
    const command = String(proc.command || '').trim();
    if (SYSTEM_USERS.includes(user)) return true;
    if (SYSTEM_COMMANDS.some(cmd => cmd.toLowerCase() === command.toLowerCase())) return true;
    return false;
  }

  function isMyConnection(proc, currentThreadId) {
    if (!proc || typeof proc !== 'object') return false;
    if (!currentThreadId) return false;
    return String(proc.id) === String(currentThreadId);
  }

  function formatDuration(seconds) {
    const sec = Math.max(0, Math.floor(Number(seconds) || 0));
    if (sec < 60) return `${sec}s`;
    const mins = Math.floor(sec / 60);
    const remainSec = sec % 60;
    if (mins < 60) {
      return `${mins}m ${remainSec}s`;
    }
    const hours = Math.floor(mins / 60);
    const remainMins = mins % 60;
    return `${hours}h ${remainMins}m ${remainSec}s`;
  }

  function parseProcesslistRow(row, currentThreadId = null) {
    if (!Array.isArray(row)) return null;
    const id = row[0] !== undefined && row[0] !== null ? String(row[0]) : '';
    const user = String(row[1] || '');
    const host = String(row[2] || '');
    const db = row[3] !== undefined && row[3] !== null ? String(row[3]) : '';
    const command = String(row[4] || '');
    const timeSec = Number.isFinite(Number(row[5])) ? Number(row[5]) : 0;
    const state = String(row[6] || '');
    const info = row[7] !== undefined && row[7] !== null ? String(row[7]) : '';

    const isSystem = isSystemThread({ user, command });
    const isSelf = Boolean(currentThreadId && id && String(id) === String(currentThreadId));
    const isSlow = timeSec >= 5 && command.toLowerCase() === 'query';
    const isLocked = Boolean(state && /lock|waiting for/i.test(state));

    return Object.freeze({
      id,
      user,
      host,
      db,
      command,
      timeSec,
      timeFormatted: formatDuration(timeSec),
      state,
      info,
      isSystem,
      isSelf,
      isSlow,
      isLocked
    });
  }

  function filterProcesses(processes, { query = '', filterType = 'all' } = {}) {
    if (!Array.isArray(processes)) return [];
    const q = String(query || '').trim().toLowerCase();
    const type = String(filterType || 'all').toLowerCase();

    return processes.filter((p) => {
      if (!p || typeof p !== 'object') return false;

      if (type === 'query' && p.command.toLowerCase() !== 'query') return false;
      if (type === 'sleep' && p.command.toLowerCase() !== 'sleep') return false;
      if (type === 'slow' && !p.isSlow) return false;
      if (type === 'locked' && !p.isLocked) return false;

      if (!q) return true;

      return (
        p.id.toLowerCase().includes(q) ||
        p.user.toLowerCase().includes(q) ||
        p.host.toLowerCase().includes(q) ||
        p.db.toLowerCase().includes(q) ||
        p.command.toLowerCase().includes(q) ||
        p.state.toLowerCase().includes(q) ||
        p.info.toLowerCase().includes(q)
      );
    });
  }

  function detectServerEngine(versionString = '') {
    const raw = String(versionString || '');
    const isMariaDB = /mariadb/i.test(raw);
    const engine = isMariaDB ? 'mariadb' : 'mysql';

    const match = raw.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
    const major = match ? Number(match[1]) : 0;
    const minor = match ? Number(match[2]) : 0;
    const patch = match && match[3] ? Number(match[3]) : 0;

    return Object.freeze({
      raw,
      engine,
      isMariaDB,
      major,
      minor,
      patch
    });
  }

  function getLockWaitersQuery(engineInfo = {}) {
    // If MySQL 8.0+: performance_schema.data_lock_waits
    if (engineInfo.engine === 'mysql' && engineInfo.major >= 8) {
      return `
        SELECT
          r.trx_id AS waiting_trx_id,
          r.trx_mysql_thread_id AS waiting_thread_id,
          b.trx_id AS blocking_trx_id,
          b.trx_mysql_thread_id AS blocking_thread_id,
          w.requesting_engine_lock_id AS waiting_lock_id,
          w.blocking_engine_lock_id AS blocking_lock_id,
          TIMESTAMPDIFF(SECOND, r.trx_wait_started, NOW()) AS wait_time_sec,
          r.trx_query AS waiting_query,
          b.trx_query AS blocking_query
        FROM performance_schema.data_lock_waits w
        JOIN information_schema.innodb_trx r ON r.trx_id = w.requesting_engine_transaction_id
        JOIN information_schema.innodb_trx b ON b.trx_id = w.blocking_engine_transaction_id
        LIMIT 100;
      `.trim();
    }

    // Default for MySQL 5.7 and MariaDB: information_schema.innodb_lock_waits
    return `
      SELECT
        r.trx_id AS waiting_trx_id,
        r.trx_mysql_thread_id AS waiting_thread_id,
        b.trx_id AS blocking_trx_id,
        b.trx_mysql_thread_id AS blocking_thread_id,
        w.requesting_trx_id AS waiting_lock_id,
        w.blocking_trx_id AS blocking_lock_id,
        TIMESTAMPDIFF(SECOND, r.trx_wait_started, NOW()) AS wait_time_sec,
        r.trx_query AS waiting_query,
        b.trx_query AS blocking_query
      FROM information_schema.innodb_lock_waits w
      JOIN information_schema.innodb_trx r ON r.trx_id = w.requesting_trx_id
      JOIN information_schema.innodb_trx b ON b.trx_id = w.blocking_trx_id
      LIMIT 100;
    `.trim();
  }

  function parseLockWaiterRow(row) {
    if (!row) return null;
    // Row can be array or object from database driver
    if (Array.isArray(row)) {
      const waitTime = Number(row[6]) || 0;
      return Object.freeze({
        waitingTrxId: String(row[0] || ''),
        waitingThreadId: String(row[1] || ''),
        blockingTrxId: String(row[2] || ''),
        blockingThreadId: String(row[3] || ''),
        waitingLockId: String(row[4] || ''),
        blockingLockId: String(row[5] || ''),
        waitTimeSec: waitTime,
        waitTimeFormatted: formatDuration(waitTime),
        waitingQuery: String(row[7] || ''),
        blockingQuery: String(row[8] || '')
      });
    }

    const waitTime = Number(row.wait_time_sec) || 0;
    return Object.freeze({
      waitingTrxId: String(row.waiting_trx_id || ''),
      waitingThreadId: String(row.waiting_thread_id || ''),
      blockingTrxId: String(row.blocking_trx_id || ''),
      blockingThreadId: String(row.blocking_thread_id || ''),
      waitingLockId: String(row.waiting_lock_id || ''),
      blockingLockId: String(row.blocking_lock_id || ''),
      waitTimeSec: waitTime,
      waitTimeFormatted: formatDuration(waitTime),
      waitingQuery: String(row.waiting_query || ''),
      blockingQuery: String(row.blocking_query || '')
    });
  }

  function getLongTransactionsQuery() {
    return `
      SELECT
        trx_id,
        trx_state,
        trx_started,
        TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS duration_sec,
        trx_mysql_thread_id AS thread_id,
        trx_rows_locked,
        trx_rows_modified,
        trx_isolation_level,
        trx_query
      FROM information_schema.innodb_trx
      ORDER BY trx_started ASC
      LIMIT 100;
    `.trim();
  }

  function parseTransactionRow(row) {
    if (!row) return null;
    if (Array.isArray(row)) {
      const duration = Number(row[3]) || 0;
      return Object.freeze({
        trxId: String(row[0] || ''),
        state: String(row[1] || ''),
        startedAt: String(row[2] || ''),
        durationSec: duration,
        durationFormatted: formatDuration(duration),
        threadId: String(row[4] || ''),
        rowsLocked: Number(row[5]) || 0,
        rowsModified: Number(row[6]) || 0,
        isolationLevel: String(row[7] || ''),
        query: String(row[8] || '')
      });
    }

    const duration = Number(row.duration_sec) || 0;
    return Object.freeze({
      trxId: String(row.trx_id || ''),
      state: String(row.trx_state || ''),
      startedAt: String(row.trx_started || ''),
      durationSec: duration,
      durationFormatted: formatDuration(duration),
      threadId: String(row.thread_id || ''),
      rowsLocked: Number(row.trx_rows_locked) || 0,
      rowsModified: Number(row.trx_rows_modified) || 0,
      isolationLevel: String(row.trx_isolation_level || ''),
      query: String(row.trx_query || '')
    });
  }

  function getSlowQueriesQuery() {
    return `
      SELECT
        start_time,
        user_host,
        query_time,
        lock_time,
        rows_sent,
        rows_examined,
        db,
        sql_text
      FROM mysql.slow_log
      ORDER BY start_time DESC
      LIMIT 50;
    `.trim();
  }

  function parseSlowQueryRow(row) {
    if (!row) return null;
    if (Array.isArray(row)) {
      return Object.freeze({
        startTime: String(row[0] || ''),
        userHost: String(row[1] || ''),
        queryTime: String(row[2] || ''),
        lockTime: String(row[3] || ''),
        rowsSent: Number(row[4]) || 0,
        rowsExamined: Number(row[5]) || 0,
        db: String(row[6] || ''),
        sql: String(row[7] || '')
      });
    }

    return Object.freeze({
      startTime: String(row.start_time || ''),
      userHost: String(row.user_host || ''),
      queryTime: String(row.query_time || ''),
      lockTime: String(row.lock_time || ''),
      rowsSent: Number(row.rows_sent) || 0,
      rowsExamined: Number(row.rows_examined) || 0,
      db: String(row.db || ''),
      sql: String(row.sql_text || '')
    });
  }

  function safeKillQuerySql(threadId) {
    const id = String(threadId || '').trim();
    if (!/^\d+$/.test(id)) throw new Error('ID tiến trình không hợp lệ.');
    return `KILL QUERY ${id}`;
  }

  function safeKillConnectionSql(threadId) {
    const id = String(threadId || '').trim();
    if (!/^\d+$/.test(id)) throw new Error('ID tiến trình không hợp lệ.');
    return `KILL ${id}`;
  }

  return Object.freeze({
    isSystemThread,
    isMyConnection,
    formatDuration,
    parseProcesslistRow,
    filterProcesses,
    detectServerEngine,
    getLockWaitersQuery,
    parseLockWaiterRow,
    getLongTransactionsQuery,
    parseTransactionRow,
    getSlowQueriesQuery,
    parseSlowQueryRow,
    safeKillQuerySql,
    safeKillConnectionSql
  });
}));
