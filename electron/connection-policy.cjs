'use strict';

// This conservative application guard supplements DB privileges. A SELECT on a
// view can invoke server-side code; only a least-privilege DB account is a boundary.
const SAFE_FUNCTIONS = new Set((
  'ABS ACOS ASIN ATAN ATAN2 AVG CEIL CEILING CHAR_LENGTH CHARACTER_LENGTH COALESCE CONCAT CONCAT_WS COS COT COUNT ' +
  'CRC32 CURDATE CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER CURTIME DATABASE DATE DATEDIFF DATE_ADD DATE_FORMAT DATE_SUB ' +
  'DAY DAYNAME DAYOFMONTH DAYOFWEEK DAYOFYEAR EXP EXTRACT FLOOR FORMAT GREATEST GROUP_CONCAT HEX HOUR IF IFNULL INSTR ISNULL ' +
  'JSON_ARRAY JSON_ARRAYAGG JSON_CONTAINS JSON_CONTAINS_PATH JSON_DEPTH JSON_EXTRACT JSON_KEYS JSON_LENGTH JSON_OBJECT JSON_OBJECTAGG JSON_OVERLAPS JSON_PRETTY JSON_QUOTE JSON_SEARCH JSON_STORAGE_FREE JSON_STORAGE_SIZE JSON_TYPE JSON_UNQUOTE JSON_VALID JSON_VALUE ' +
  'LCASE LEAST LEFT LENGTH LN LOCALTIME LOCALTIMESTAMP LOCATE LOG LOG10 LOG2 LOWER LPAD LTRIM MAX MD5 MICROSECOND MID MIN MINUTE MOD MONTH MONTHNAME ' +
  'NOW NULLIF OCTET_LENGTH PI POSITION POW POWER QUARTER RADIANS RAND REGEXP_LIKE REGEXP_REPLACE REGEXP_SUBSTR REPEAT REPLACE REVERSE RIGHT ' +
  'ROUND RPAD RTRIM SECOND SHA SHA1 SHA2 SIGN SIN SPACE SQRT STRCMP STR_TO_DATE SUBSTR SUBSTRING SUBSTRING_INDEX SUM TAN TIME TIMEDIFF ' +
  'TIMESTAMP TIMESTAMPADD TIMESTAMPDIFF TIME_FORMAT TIME_TO_SEC TO_BASE64 TO_DAYS TRIM TRUNCATE UCASE UNHEX UNIX_TIMESTAMP UPPER USER VERSION ' +
  'WEEK WEEKDAY WEEKOFYEAR YEAR CAST CONVERT CHAR DECIMAL SIGNED UNSIGNED BINARY DATETIME VARCHAR ' +
  'ROW_NUMBER RANK DENSE_RANK LAG LEAD FIRST_VALUE LAST_VALUE NTH_VALUE NTILE CUME_DIST PERCENT_RANK ' +
  'IN EXISTS AS OVER USING AGAINST MATCH ' +
  'ASCII BIN BIT_AND BIT_COUNT BIT_LENGTH BIT_OR BIT_XOR DEGREES ELT EXPORT_SET FIELD FIND_IN_SET FROM_BASE64 LAST_DAY MAKEDATE MAKETIME PERIOD_ADD PERIOD_DIFF SEC_TO_TIME STD STDDEV STDDEV_POP STDDEV_SAMP SUBDATE SYSDATE UTC_DATE UTC_TIME UTC_TIMESTAMP VAR_POP VAR_SAMP VARIANCE YEARWEEK'
).split(/\s+/));

const BLOCKED_WORDS = new Set(('INSERT UPDATE DELETE REPLACE CREATE ALTER DROP TRUNCATE RENAME GRANT REVOKE CALL DO ' +
  'SET PREPARE EXECUTE DEALLOCATE LOAD HANDLER KILL FLUSH RESET PURGE INSTALL UNINSTALL SHUTDOWN INTO OUTFILE DUMPFILE FOR LOCK ' +
  'UNLOCK ANALYZE OPTIMIZE REPAIR CHECKSUM COMMIT SAVEPOINT RELEASE START BEGIN XA DELIMITER').split(/\s+/));
const PAREN_SYNTAX = new Set((
  'SELECT FROM WHERE ON HAVING AND OR NOT UNION ALL DISTINCT BY ' +
  'JOIN STRAIGHT_JOIN CASE WHEN THEN ELSE BETWEEN LIKE ILIKE REGEXP RLIKE ' +
  'EXCEPT INTERSECT AS IN EXISTS OVER USING AGAINST MATCH IS INTERVAL ' +
  'COLLATE DEFAULT LIMIT OFFSET VALUES'
).split(/\s+/));

function denied(unknown = false) {
  return Object.assign(new Error(unknown
    ? 'Chế độ chỉ đọc chưa hỗ trợ cú pháp hoặc hàm SQL này. Dùng câu SELECT đơn giản hơn và tài khoản database chỉ có quyền đọc.'
    : 'Kết nối đang ở chế độ chỉ đọc. Không thể thực hiện thao tác ghi dữ liệu hoặc thay đổi máy chủ.'), {
    code: unknown ? 'READ_ONLY_SQL_UNSUPPORTED' : 'CONNECTION_READ_ONLY'
  });
}

function assertWritable(profile) {
  if (profile?.readOnly === true) throw denied();
}

function tokenize(source) {
  const tokens = [];
  for (let i = 0; i < source.length;) {
    if (tokens.length > 100000) throw denied(true);
    const c = source[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === '#' || (source.startsWith('--', i) && (!source[i + 2] || /\s/.test(source[i + 2])))) {
      while (i < source.length && !/[\r\n]/.test(source[i])) i += 1;
      continue;
    }
    if (source.startsWith('/*', i)) {
      // Executable comments differ between MySQL and MariaDB. Never discard them.
      if (/^\/\*(?:!|M!|\+)/i.test(source.slice(i, i + 5))) throw denied(true);
      const end = source.indexOf('*/', i + 2);
      if (end < 0) throw denied(true);
      if (source.slice(i + 2, end).includes('/*')) throw denied(true);
      i = end + 2; continue;
    }
    if (["'", '"', '`'].includes(c)) {
      const start = i++;
      let closed = false;
      for (; i < source.length; i += 1) {
        // Reject mode-dependent escaping rather than guess NO_BACKSLASH_ESCAPES.
        if (source[i] === '\\' || source[i] === '\0') throw denied(true);
        if (source[i] !== c) continue;
        if (source[i + 1] === c) { i += 1; continue; }
        i += 1; closed = true; break;
      }
      if (!closed) throw denied(true);
      tokens.push({ type: c === "'" ? 'literal' : 'quoted', value: source.slice(start, i) });
      continue;
    }
    const word = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(i));
    if (word) { tokens.push({type:'word',value:word[0].toUpperCase()}); i += word[0].length; continue; }
    const number = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(i));
    if (number) { tokens.push({type:'number',value:number[0]}); i += number[0].length; continue; }
    if (c.charCodeAt(0) < 32 || c.charCodeAt(0) > 126) throw denied(true);
    if (source.startsWith(':=', i)) throw denied();
    tokens.push({type:'symbol',value:c}); i += 1;
  }
  return tokens;
}

function isCteColumnList(tokens, i) {
  if (i < 1 || tokens[i + 1]?.value !== '(') return false;
  const prev = tokens[i - 1]?.value;
  if (prev !== 'WITH' && prev !== 'RECURSIVE' && prev !== ',') return false;
  let depth = 1;
  let j = i + 2;
  for (; j < tokens.length; j += 1) {
    if (tokens[j].value === '(') depth += 1;
    else if (tokens[j].value === ')') {
      depth -= 1;
      if (depth === 0) break;
    } else if (!['word', 'quoted'].includes(tokens[j].type) && tokens[j].value !== ',') {
      return false;
    }
  }
  return j < tokens.length && tokens[j + 1]?.value === 'AS';
}

function assertReadStatement(tokens) {
  if (!tokens.length) return;
  const first = tokens[0].value;
  if (first === 'ROLLBACK' && tokens.length === 1) return;
  if (first === 'USE' && tokens.length === 2 && ['word', 'quoted'].includes(tokens[1].type)) return;
  if (!['SELECT', 'WITH', 'SHOW', 'DESC', 'DESCRIBE', 'EXPLAIN'].includes(first)) throw denied();
  if (first === 'SHOW') {
    const head = tokens.slice(1).filter((entry) => entry.type === 'word').slice(0, 3).map((entry) => entry.value).join(' ');
    if (!/^(?:(?:FULL )?(?:TABLES|COLUMNS|FIELDS|PROCESSLIST)|(?:GLOBAL |SESSION )?(?:STATUS|VARIABLES)|DATABASES|SCHEMAS|INDEX|INDEXES|KEYS|CREATE (?:TABLE|VIEW|PROCEDURE|FUNCTION|TRIGGER|EVENT|DATABASE)|ENGINES|STORAGE ENGINES|CHARACTER SET|COLLATION|WARNINGS|ERRORS|GRANTS|(?:TABLE|PROCEDURE|FUNCTION|TRIGGER|EVENT) STATUS|TRIGGERS|EVENTS|OPEN TABLES|PLUGINS|PRIVILEGES|PROFILES|(?:SLAVE|REPLICA) STATUS)(?: |$)/.test(head)) throw denied(true);
  }
  // SHOW CREATE is metadata; its CREATE token is allowed only in this position.
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    const metadataKeyword = first === 'SHOW' && ((i === 1 && token.value === 'CREATE') || (i === 2 && tokens[1].value === 'CHARACTER' && token.value === 'SET'));
    const safeFunction = token.type === 'word' && SAFE_FUNCTIONS.has(token.value) && tokens[i + 1]?.value === '(';
    if (token.type === 'word' && BLOCKED_WORDS.has(token.value) && !metadataKeyword && !safeFunction) throw denied();
  }
  if (first === 'EXPLAIN') {
    let rest = tokens.slice(1);
    if (rest[0]?.value === 'FORMAT' && rest[1]?.value === '=' && ['JSON', 'TREE', 'TRADITIONAL'].includes(rest[2]?.value)) rest = rest.slice(3);
    if (!['SELECT', 'WITH'].includes(rest[0]?.value)) throw denied(true);
  }
  if (first === 'WITH' && !tokens.some((entry) => entry.type === 'word' && entry.value === 'SELECT')) throw denied(true);
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const token = tokens[i];
    if (tokens[i + 1].value !== '(' || !['word', 'quoted'].includes(token.type)) continue;
    if (first === 'WITH' && isCteColumnList(tokens, i)) continue;
    if (tokens[i - 1]?.value === '.' || token.type !== 'word' || (!SAFE_FUNCTIONS.has(token.value) && !PAREN_SYNTAX.has(token.value))) throw denied(true);
  }
}

function assertReadOnlySql(profile, sql) {
  if (profile?.readOnly !== true) return;
  if (typeof sql !== 'string' || sql.length > 1024 * 1024) throw denied(true);
  const tokens = tokenize(sql);
  let statement = [];
  // Validate the entire batch before the first statement is sent to the server.
  for (const token of tokens) {
    if (token.value === ';' && token.type === 'symbol') { assertReadStatement(statement); statement = []; }
    else statement.push(token);
  }
  assertReadStatement(statement);
}

function analyzeProductionSqlRisks(sql) {
  if (typeof sql !== 'string' || !sql.trim()) return [];
  const risks = [];

  const tokens = [];
  let depth = 0;
  for (let i = 0; i < sql.length;) {
    const c = sql[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === '#' || (sql.startsWith('--', i) && (!sql[i + 2] || /\s/.test(sql[i + 2])))) {
      while (i < sql.length && !/[\r\n]/.test(sql[i])) i += 1;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) break;
      i = end + 2; continue;
    }
    if (["'", '"', '`'].includes(c)) {
      const start = i++;
      for (; i < sql.length; i += 1) {
        if (sql[i] === '\\') { i += 1; continue; }
        if (sql[i] === c) {
          if (sql[i + 1] === c) { i += 1; continue; }
          i += 1; break;
        }
      }
      tokens.push({ type: c === '`' ? 'ident' : 'literal', value: sql.slice(start, i), depth });
      continue;
    }
    if (c === '(') { depth += 1; tokens.push({ type: 'symbol', value: '(', depth }); i += 1; continue; }
    if (c === ')') { tokens.push({ type: 'symbol', value: ')', depth }); if (depth > 0) depth -= 1; i += 1; continue; }
    if (c === ';') {
      tokens.push({ type: 'symbol', value: ';', depth: 0 });
      depth = 0;
      i += 1;
      continue;
    }
    const word = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(sql.slice(i));
    if (word) {
      tokens.push({ type: 'word', value: word[0].toUpperCase(), raw: word[0], depth });
      i += word[0].length;
      continue;
    }
    tokens.push({ type: 'symbol', value: c, depth });
    i += 1;
  }

  const statements = [];
  let currentStmt = [];
  for (const t of tokens) {
    if (t.value === ';' && t.type === 'symbol') {
      if (currentStmt.length) statements.push(currentStmt);
      currentStmt = [];
    } else {
      currentStmt.push(t);
    }
  }
  if (currentStmt.length) statements.push(currentStmt);

  for (const stmt of statements) {
    const firstWordIdx = stmt.findIndex((t) => t.type === 'word');
    if (firstWordIdx === -1) continue;
    const firstWord = stmt[firstWordIdx].value;

    if (firstWord === 'DROP') {
      const words = stmt.slice(firstWordIdx + 1).filter((t) => t.type === 'word' || t.type === 'ident');
      const targetDesc = words.slice(0, 3).map((w) => w.value).join(' ');
      risks.push({
        type: 'DROP',
        severity: 'destructive',
        target: targetDesc,
        message: `Xóa vĩnh viễn đối tượng (DROP ${targetDesc}). Thao tác này không thể hoàn tác.`
      });
    } else if (firstWord === 'TRUNCATE') {
      const words = stmt.slice(firstWordIdx + 1).filter((t) => t.type === 'word' || t.type === 'ident');
      const targetDesc = words.slice(0, 2).map((w) => w.value).join(' ');
      risks.push({
        type: 'TRUNCATE',
        severity: 'destructive',
        target: targetDesc,
        message: `Làm rỗng toàn bộ bảng (TRUNCATE ${targetDesc}). Toàn bộ dữ liệu trong bảng sẽ bị xóa sạch.`
      });
    } else if (firstWord === 'DELETE') {
      const whereIdx = stmt.findIndex((t) => t.type === 'word' && t.value === 'WHERE' && t.depth === 0);
      let isUnconditional = whereIdx === -1;
      if (!isUnconditional) {
        const afterWhere = stmt.slice(whereIdx + 1).filter((t) => t.depth === 0);
        const norm = afterWhere.map((t) => t.value).join('').toUpperCase();
        if (['1', '1=1', 'TRUE', "'1'='1'", '"1"="1"'].includes(norm)) {
          isUnconditional = true;
        }
      }
      if (isUnconditional) {
        const tableWord = stmt.slice(firstWordIdx + 1).find((t) => (t.type === 'word' && t.value !== 'FROM') || t.type === 'ident')?.value || '';
        risks.push({
          type: 'UNCONDITIONAL_DELETE',
          severity: 'destructive',
          target: tableWord,
          message: `Lệnh DELETE ${tableWord ? 'trên bảng ' + tableWord + ' ' : ''}không có điều kiện WHERE (hoặc điều kiện luôn đúng). Thao tác này sẽ xóa TẤT CẢ các dòng trong bảng!`
        });
      }
    } else if (firstWord === 'UPDATE') {
      const whereIdx = stmt.findIndex((t) => t.type === 'word' && t.value === 'WHERE' && t.depth === 0);
      let isUnconditional = whereIdx === -1;
      if (!isUnconditional) {
        const afterWhere = stmt.slice(whereIdx + 1).filter((t) => t.depth === 0);
        const norm = afterWhere.map((t) => t.value).join('').toUpperCase();
        if (['1', '1=1', 'TRUE', "'1'='1'", '"1"="1"'].includes(norm)) {
          isUnconditional = true;
        }
      }
      if (isUnconditional) {
        const tableWord = stmt.slice(firstWordIdx + 1).find((t) => t.type === 'word' || t.type === 'ident')?.value || '';
        risks.push({
          type: 'UNCONDITIONAL_UPDATE',
          severity: 'warning',
          target: tableWord,
          message: `Lệnh UPDATE ${tableWord ? 'trên bảng ' + tableWord + ' ' : ''}không có điều kiện WHERE (hoặc điều kiện luôn đúng). Thao tác này sẽ cập nhật TẤT CẢ các dòng trong bảng!`
        });
      }
    } else if (firstWord === 'ALTER' && stmt.some((t) => t.type === 'word' && t.value === 'TABLE')) {
      const tableWord = stmt.slice(firstWordIdx + 1).find((t) => t.type === 'ident' || (t.type === 'word' && t.value !== 'TABLE'))?.value || '';
      risks.push({
        type: 'ALTER_TABLE',
        severity: 'warning',
        target: tableWord,
        message: `Thay đổi cấu trúc bảng (ALTER TABLE ${tableWord}). Thao tác DDL này có thể khóa bảng và gây implicit commit.`
      });
    }
  }

  return risks;
}

module.exports = { assertWritable, assertReadOnlySql, analyzeProductionSqlRisks };
