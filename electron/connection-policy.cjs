'use strict';

// This conservative application guard supplements DB privileges. A SELECT on a
// view can invoke server-side code; only a least-privilege DB account is a boundary.
const SAFE_FUNCTIONS = new Set((
  'ABS ACOS ASIN ATAN ATAN2 AVG CEIL CEILING CHAR_LENGTH CHARACTER_LENGTH COALESCE CONCAT CONCAT_WS COS COT COUNT ' +
  'CRC32 CURDATE CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER CURTIME DATABASE DATE DATEDIFF DATE_ADD DATE_FORMAT DATE_SUB ' +
  'DAY DAYNAME DAYOFMONTH DAYOFWEEK DAYOFYEAR EXP EXTRACT FLOOR FORMAT GREATEST GROUP_CONCAT HEX HOUR IF IFNULL INSTR ISNULL ' +
  'JSON_ARRAY JSON_CONTAINS JSON_CONTAINS_PATH JSON_DEPTH JSON_EXTRACT JSON_KEYS JSON_LENGTH JSON_OBJECT JSON_QUOTE JSON_TYPE JSON_UNQUOTE JSON_VALID ' +
  'LCASE LEAST LEFT LENGTH LN LOCATE LOG LOG10 LOG2 LOWER LPAD LTRIM MAX MD5 MICROSECOND MID MIN MINUTE MOD MONTH MONTHNAME ' +
  'NULLIF OCTET_LENGTH PI POSITION POW POWER QUARTER RADIANS RAND REGEXP_LIKE REGEXP_REPLACE REGEXP_SUBSTR REPEAT REPLACE REVERSE RIGHT ' +
  'ROUND RPAD RTRIM SECOND SHA SHA1 SHA2 SIGN SIN SPACE SQRT STRCMP STR_TO_DATE SUBSTR SUBSTRING SUBSTRING_INDEX SUM TAN TIME TIMEDIFF ' +
  'TIMESTAMP TIMESTAMPADD TIMESTAMPDIFF TIME_FORMAT TIME_TO_SEC TO_BASE64 TO_DAYS TRIM TRUNCATE UCASE UNHEX UNIX_TIMESTAMP UPPER USER VERSION ' +
  'WEEK WEEKDAY WEEKOFYEAR YEAR CAST CONVERT CHAR DECIMAL SIGNED UNSIGNED BINARY DATETIME VARCHAR ' +
  'ROW_NUMBER RANK DENSE_RANK LAG LEAD FIRST_VALUE LAST_VALUE NTH_VALUE NTILE CUME_DIST PERCENT_RANK ' +
  'IN EXISTS AS OVER USING AGAINST MATCH'
).split(/\s+/));

const BLOCKED_WORDS = new Set(('INSERT UPDATE DELETE REPLACE CREATE ALTER DROP TRUNCATE RENAME GRANT REVOKE CALL DO ' +
  'SET PREPARE EXECUTE DEALLOCATE LOAD HANDLER KILL FLUSH RESET PURGE INSTALL UNINSTALL SHUTDOWN INTO OUTFILE DUMPFILE FOR LOCK ' +
  'UNLOCK ANALYZE OPTIMIZE REPAIR CHECKSUM COMMIT SAVEPOINT RELEASE START BEGIN XA DELIMITER').split(/\s+/));
const PAREN_SYNTAX = new Set('SELECT FROM WHERE ON HAVING AND OR NOT UNION ALL DISTINCT BY'.split(' '));

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

function assertReadStatement(tokens) {
  if (!tokens.length) return;
  const first = tokens[0].value;
  if (first === 'ROLLBACK' && tokens.length === 1) return;
  if (first === 'USE' && tokens.length === 2 && ['word', 'quoted'].includes(tokens[1].type)) return;
  if (!['SELECT', 'WITH', 'SHOW', 'DESC', 'DESCRIBE', 'EXPLAIN'].includes(first)) throw denied();
  if (first === 'SHOW') {
    const head = tokens.slice(1).filter((entry) => entry.type === 'word').slice(0, 3).map((entry) => entry.value).join(' ');
    if (!/^(?:(?:FULL )?(?:TABLES|COLUMNS|FIELDS|PROCESSLIST)|(?:GLOBAL |SESSION )?(?:STATUS|VARIABLES)|DATABASES|SCHEMAS|INDEX|INDEXES|KEYS|CREATE (?:TABLE|VIEW|PROCEDURE|FUNCTION|TRIGGER|EVENT|DATABASE)|ENGINES|CHARACTER SET|COLLATION|WARNINGS|ERRORS|GRANTS)(?: |$)/.test(head)) throw denied(true);
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

module.exports = { assertWritable, assertReadOnlySql };
