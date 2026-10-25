'use strict';

function stripLeadingComments(sql) {
  let remaining = String(sql || '');
  for (;;) {
    const trimmed = remaining.trimStart();
    const dashComment = trimmed.startsWith('--')
      && (trimmed.length === 2 || trimmed.charCodeAt(2) <= 32);
    if (dashComment || trimmed.startsWith('#')) {
      const newline = trimmed.search(/[\r\n]/);
      if (newline === -1) return '';
      remaining = trimmed.slice(newline + 1);
    } else if (trimmed.startsWith('/*') && !trimmed.startsWith('/*!')) {
      const end = trimmed.indexOf('*/');
      if (end === -1) return '';
      remaining = trimmed.slice(end + 2);
    } else {
      return trimmed;
    }
  }
}

function splitSqlStatements(sql) {
  const source = String(sql || '');
  const statements = [];
  let buffer = '';
  let state = 'normal';
  let escaped = false;

  const pushStatement = () => {
    const statement = buffer.trim();
    buffer = '';
    if (statement && stripLeadingComments(statement)) statements.push(statement);
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    buffer += character;

    if (state === 'lineComment') {
      if (character === '\n' || character === '\r') state = 'normal';
      continue;
    }
    if (state === 'blockComment') {
      if (character === '*' && next === '/') {
        buffer += next;
        index += 1;
        state = 'normal';
      }
      continue;
    }
    if (state === 'single' || state === 'double') {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      const quote = state === 'single' ? "'" : '"';
      if (character === quote) {
        if (next === quote) {
          buffer += next;
          index += 1;
        } else {
          state = 'normal';
        }
      }
      continue;
    }
    if (state === 'backtick') {
      if (character === '`') {
        if (next === '`') {
          buffer += next;
          index += 1;
        } else {
          state = 'normal';
        }
      }
      continue;
    }

    if (character === "'") {
      state = 'single';
    } else if (character === '"') {
      state = 'double';
    } else if (character === '`') {
      state = 'backtick';
    } else if (character === '#') {
      state = 'lineComment';
    } else if (character === '-' && next === '-') {
      const after = source[index + 2];
      if (after === undefined || after.charCodeAt(0) <= 32) {
        buffer += next;
        index += 1;
        state = 'lineComment';
      }
    } else if (character === '/' && next === '*') {
      buffer += next;
      index += 1;
      state = 'blockComment';
    } else if (character === ';') {
      buffer = buffer.slice(0, -1);
      pushStatement();
    }
  }

  if (state === 'single' || state === 'double' || state === 'backtick') {
    throw new Error('SQL không hợp lệ: chuỗi hoặc identifier chưa được đóng.');
  }
  if (state === 'blockComment') {
    throw new Error('SQL không hợp lệ: block comment chưa được đóng.');
  }
  pushStatement();
  return statements;
}

function couldBeDelimiter(text) {
  const trimmed = String(text || '').replace(/^\s+/, '').toUpperCase();
  if (!trimmed) return true;
  if ('DELIMITER'.startsWith(trimmed)) return true;
  return /^DELIMITER\s/.test(trimmed);
}

class SqlScriptParser {
  constructor() {
    this.delimiter = ';';
    this.buffer = '';
    this.state = 'normal';
    this.escaped = false;
    this.blockStar = false;
    this.rawLine = '';
    this.collectingLine = true;
    this.started = false;
  }

  isClean() {
    return this.state === 'normal' && this.buffer.trim() === '';
  }

  push(chunk) {
    const statements = [];
    let input = String(chunk || '');
    if (!this.started && input.length) {
      if (input.charCodeAt(0) === 0xfeff) input = input.slice(1);
      if (input.length) this.started = true;
    }
    let index = 0;
    while (index < input.length) {
      if (this.collectingLine) {
        const character = input[index++];
        this.rawLine += character;
        if (this.rawLine.length > 4096 || !couldBeDelimiter(this.rawLine)) {
          const line = this.rawLine;
          this.rawLine = '';
          this.collectingLine = false;
          this.feedText(line, statements);
          this.collectingLine = line.endsWith('\n') && this.isClean();
          continue;
        }
        if (character === '\n') {
          const line = this.rawLine;
          this.rawLine = '';
          const match = /^\s*DELIMITER\s+(.+?)\s*$/i.exec(line);
          if (match) {
            this.delimiter = match[1];
          } else {
            this.collectingLine = false;
            this.feedText(line, statements);
            this.collectingLine = this.isClean();
          }
        }
        continue;
      }
      const character = input[index++];
      this.feedCharacter(character, statements);
      if (character === '\n' && this.isClean()) this.collectingLine = true;
    }
    return statements;
  }

  feedText(text, statements) {
    for (const character of text) this.feedCharacter(character, statements);
  }

  feedCharacter(character, statements) {
    if (['normal', 'slash', 'dash'].includes(this.state)
        && this.delimiter
        && character === this.delimiter[this.delimiter.length - 1]) {
      const candidate = this.buffer + character;
      if (candidate.endsWith(this.delimiter)) {
        this.buffer = candidate.slice(0, -this.delimiter.length);
        this.state = 'normal';
        const statement = this.buffer.trim();
        this.buffer = '';
        if (statement) statements.push(statement);
        return;
      }
    }
    switch (this.state) {
      case 'lineComment':
        if (character === '\n') {
          this.state = 'normal';
          this.buffer += '\n';
        }
        return;
      case 'blockComment':
        if (character === '*') {
          this.blockStar = true;
          return;
        }
        if (this.blockStar && character === '/') {
          this.blockStar = false;
          this.state = 'normal';
          this.buffer += ' ';
          return;
        }
        this.blockStar = false;
        return;
      case 'versionComment':
        this.buffer += character;
        if (this.buffer.endsWith('*/')) this.state = 'normal';
        return;
      case 'single':
      case 'double':
        this.buffer += character;
        if (this.escaped) {
          this.escaped = false;
          return;
        }
        if (character === '\\') {
          this.escaped = true;
          return;
        }
        if (character === (this.state === 'single' ? "'" : '"')) this.state = 'normal';
        return;
      case 'backtick':
        this.buffer += character;
        if (character === '`') this.state = 'normal';
        return;
      case 'dash':
        if (character === '-') {
          this.buffer = this.buffer.slice(0, -1);
          this.state = 'lineComment';
          return;
        }
        this.state = 'normal';
        this.feedCharacter(character, statements);
        return;
      case 'slash':
        if (character === '*') {
          this.state = 'star';
          return;
        }
        this.state = 'normal';
        this.feedCharacter(character, statements);
        return;
      case 'star':
        if (character === '!') {
          this.buffer += '*!';
          this.state = 'versionComment';
          return;
        }
        if (this.buffer.endsWith('/')) this.buffer = this.buffer.slice(0, -1);
        this.state = 'blockComment';
        this.blockStar = false;
        return;
      default:
        break;
    }

    if (character === '-' ) {
      this.buffer += character;
      this.state = 'dash';
      return;
    }
    if (character === '#') {
      this.state = 'lineComment';
      return;
    }
    if (character === '/') {
      this.buffer += character;
      this.state = 'slash';
      return;
    }
    if (character === "'" || character === '"') {
      this.buffer += character;
      this.state = character === "'" ? 'single' : 'double';
      return;
    }
    if (character === '`') {
      this.buffer += character;
      this.state = 'backtick';
      return;
    }

    this.buffer += character;
    if (this.delimiter && this.buffer.endsWith(this.delimiter)) {
      const statement = this.buffer.slice(0, -this.delimiter.length).trim();
      this.buffer = '';
      if (statement) statements.push(statement);
    }
  }

  end() {
    const statements = [];
    if (this.rawLine) {
      const line = this.rawLine;
      this.rawLine = '';
      const match = /^\s*DELIMITER\s+(.+?)\s*$/i.exec(line);
      if (match) {
        this.delimiter = match[1];
      } else {
        this.feedText(line, statements);
      }
    }
    if (this.state === 'dash' || this.state === 'slash') this.state = 'normal';
    if (['single', 'double', 'backtick', 'blockComment', 'versionComment'].includes(this.state)) {
      throw new Error('Tệp SQL không hợp lệ: chuỗi hoặc comment chưa được đóng.');
    }
    const trailing = this.buffer.trim();
    this.buffer = '';
    if (trailing) statements.push(trailing);
    return statements;
  }
}

function namedIdentifier(raw) {
  const value = String(raw || '').trim().replace(/,$/, '');
  const parts = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (character === '`') {
        if (value[index + 1] === '`') {
          current += '`';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += character;
      }
    } else if (character === '`') {
      quoted = true;
    } else if (character === '.') {
      parts.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  parts.push(current);
  return parts[parts.length - 1].trim() || null;
}

function createTarget(statement) {
  const text = String(statement || '').trimStart();
  const identifier = '(?:`(?:[^`]|``)+`|[^\\s.(]+)(?:\\s*\\.\\s*(?:`(?:[^`]|``)+`|[^\\s.(]+))?';
  const definer = 'DEFINER\\s*=\\s*(?:`(?:[^`]|``)*`|\'(?:[^\'\\\\]|\\\\.|\'\')*\'|"(?:[^"\\\\]|\\\\.|"")*"|\\S+)';
  const createPrefix = '^CREATE\\s+';
  const table = new RegExp(
    `${createPrefix}(?:OR\\s+REPLACE\\s+)?(?:TEMPORARY\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${identifier})`,
    'i'
  ).exec(text);
  if (table) return { type: 'table', name: namedIdentifier(table[1]) };
  const view = new RegExp(
    `${createPrefix}(?:(?:OR\\s+REPLACE|ALGORITHM\\s*=\\s*\\w+|SQL\\s+SECURITY\\s+(?:DEFINER|INVOKER)|${definer})\\s+)*VIEW\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${identifier})`,
    'i'
  ).exec(text);
  if (view) return { type: 'view', name: namedIdentifier(view[1]) };
  const trigger = new RegExp(
    `${createPrefix}(?:(?:OR\\s+REPLACE|${definer})\\s+)*TRIGGER\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${identifier})`,
    'i'
  ).exec(text);
  if (trigger) return { type: 'trigger', name: namedIdentifier(trigger[1]) };
  const procedure = new RegExp(
    `${createPrefix}(?:(?:OR\\s+REPLACE|${definer})\\s+)*PROCEDURE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${identifier})`,
    'i'
  ).exec(text);
  if (procedure) return { type: 'procedure', name: namedIdentifier(procedure[1]) };
  const fn = new RegExp(
    `${createPrefix}(?:(?:OR\\s+REPLACE|AGGREGATE|${definer})\\s+)*FUNCTION\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${identifier})`,
    'i'
  ).exec(text);
  if (fn) return { type: 'function', name: namedIdentifier(fn[1]) };
  const event = new RegExp(
    `${createPrefix}(?:(?:OR\\s+REPLACE|${definer})\\s+)*EVENT\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${identifier})`,
    'i'
  ).exec(text);
  if (event) return { type: 'event', name: namedIdentifier(event[1]) };
  return null;
}

function skipReason(statement) {
  const sql = stripLeadingComments(statement);
  if (/^USE\b/i.test(sql)) return 'USE';
  if (/^(?:CREATE|DROP)\s+(?:DATABASE|SCHEMA)\b/i.test(sql)) return 'database';
  return '';
}

const IDENTIFIER = '(?:`(?:[^`]|``)+`|[A-Za-z0-9_$]+)';
const REFERENCE = `(${IDENTIFIER}(?:\\s*\\.\\s*${IDENTIFIER})?)`;
const ALLOWED_RESTORE_COMMANDS = new Set([
  'ALTER', 'ANALYZE', 'BEGIN', 'CHECK', 'COMMIT', 'CREATE', 'DELETE', 'DROP',
  'INSERT', 'LOAD', 'LOCK', 'OPTIMIZE', 'RELEASE', 'RENAME', 'REPAIR', 'REPLACE',
  'ROLLBACK', 'SAVEPOINT', 'SELECT', 'SET', 'START', 'TRUNCATE', 'UNLOCK', 'UPDATE', 'USE'
]);
const REJECTED_RESTORE_COMMANDS = new Set([
  'CALL', 'DEALLOCATE', 'DO', 'EXECUTE', 'GRANT', 'HANDLER', 'INSTALL', 'PREPARE',
  'PURGE', 'RESET', 'REVOKE', 'SHUTDOWN', 'STOP', 'UNINSTALL'
]);

function scopeError(message, statement) {
  const error = new Error(message);
  error.code = 'RESTORE_SCOPE_REJECTED';
  if (statement) error.statement = statement;
  return error;
}

function scrubSql(sql) {
  const source = String(sql || '');
  let output = '';
  let index = 0;
  const skipQuoted = (quote) => {
    index += 1;
    while (index < source.length) {
      const character = source[index];
      if (character === '\\') {
        index += 2;
        continue;
      }
      if (character === quote) {
        if (source[index + 1] === quote) {
          index += 2;
          continue;
        }
        index += 1;
        return;
      }
      index += 1;
    }
  };
  while (index < source.length) {
    const character = source[index];
    if (character === "'" || character === '"') {
      output += '?';
      skipQuoted(character);
      continue;
    }
    if (character === '`') {
      const start = index;
      index += 1;
      while (index < source.length) {
        if (source[index] === '`') {
          if (source[index + 1] === '`') {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      output += source.slice(start, index);
      continue;
    }
    if (character === '#' || (character === '-' && source[index + 1] === '-'
      && (source[index + 2] === undefined || source[index + 2].charCodeAt(0) <= 32))) {
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') index += 1;
      output += ' ';
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      if (source[index + 2] === '!') {
        index += 3;
        while (index < source.length && /[0-9]/.test(source[index])) index += 1;
        continue;
      }
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      output += ' ';
      continue;
    }
    if (character === '*' && source[index + 1] === '/') {
      index += 2;
      continue;
    }
    output += character;
    index += 1;
  }
  return output;
}

function splitReference(raw) {
  const parts = [];
  let current = '';
  let quoted = false;
  const value = String(raw || '').trim();
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (character === '`') {
        if (value[index + 1] === '`') {
          current += '`';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += character;
      }
    } else if (character === '`') {
      quoted = true;
    } else if (character === '.') {
      parts.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  parts.push(current.trim());
  return parts.length > 1
    ? { schema: parts[parts.length - 2], table: parts[parts.length - 1] }
    : { schema: null, table: parts[parts.length - 1] };
}

function qualifiedReferences(sql) {
  const pattern = new RegExp(`(?<![@\\w$])(${IDENTIFIER})\\s*\\.\\s*(${IDENTIFIER})`, 'g');
  const refs = [];
  for (const match of String(sql).matchAll(pattern)) {
    const schema = splitReference(match[1]).table;
    const table = splitReference(match[2]).table;
    if (schema) refs.push({ schema, table });
  }
  return refs;
}

function tableListReferences(text) {
  const pattern = new RegExp(`(?:^|,|\\bJOIN\\b|\\bSTRAIGHT_JOIN\\b)\\s*${REFERENCE}`, 'gi');
  return [...String(text).matchAll(pattern)].map((match) => splitReference(match[1]));
}

function targetReference(text, pattern) {
  const match = pattern.exec(text);
  return match ? splitReference(match[1]) : null;
}

function routineWriteReferences(sql) {
  const text = String(sql);
  const refs = [];
  const push = (list) => { for (const ref of list) refs.push(ref); };
  for (const match of text.matchAll(/\bUPDATE\s+(?:(?:LOW_PRIORITY|IGNORE)\s+)*([\s\S]*?)\bSET\b/gi)) {
    push(tableListReferences(match[1]));
  }
  for (const match of text.matchAll(new RegExp(`\\b(?:INSERT|REPLACE)\\s+(?:(?:LOW_PRIORITY|DELAYED|HIGH_PRIORITY|IGNORE)\\s+)*(?:INTO\\s+)?${REFERENCE}`, 'gi'))) {
    push([splitReference(match[1])]);
  }
  for (const match of text.matchAll(new RegExp(`\\bDELETE\\s+FROM\\s+${REFERENCE}`, 'gi'))) {
    push([splitReference(match[1])]);
  }
  for (const match of text.matchAll(new RegExp(`\\bTRUNCATE\\s+(?:TABLE\\s+)?${REFERENCE}`, 'gi'))) {
    push([splitReference(match[1])]);
  }
  for (const match of text.matchAll(new RegExp(`\\bLOAD\\s+DATA\\b[\\s\\S]*?\\bINTO\\s+TABLE\\s+${REFERENCE}`, 'gi'))) {
    push([splitReference(match[1])]);
  }
  return refs;
}

const RESTORE_SESSION_VARIABLES = new Set([
  'SQL_MODE', 'FOREIGN_KEY_CHECKS', 'UNIQUE_CHECKS', 'AUTOCOMMIT', 'TIME_ZONE', 'SQL_NOTES',
  'CHARACTER_SET_CLIENT', 'CHARACTER_SET_RESULTS', 'CHARACTER_SET_CONNECTION', 'COLLATION_CONNECTION'
]);

function assertRestoreSet(sql) {
  const body = sql.replace(/^SET\s+/i, '').trim();
  if (/^(?:NAMES|CHARACTER\s+SET)\s+(?:\?|[A-Za-z0-9_]+)(?:\s+COLLATE\s+(?:\?|[A-Za-z0-9_]+))?$/i.test(body)) return;
  // Strings/comments have already been scrubbed; only top-level commas split assignments.
  const assignments = [];
  let start = 0;
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === '`') {
      if (quoted && body[index + 1] === '`') { index += 1; continue; }
      quoted = !quoted;
    } else if (!quoted) {
      if (character === '(') depth += 1;
      else if (character === ')') depth -= 1;
      else if (character === ',' && depth === 0) { assignments.push(body.slice(start, index)); start = index + 1; }
    }
  }
  assignments.push(body.slice(start));
  for (const assignment of assignments) {
    const equal = assignment.indexOf('=');
    if (equal < 1) throw scopeError('Chỉ hỗ trợ SET biến session hoặc biến @ của tệp dump trong chế độ phục hồi an toàn.');
    let name = assignment.slice(0, equal).trim();
    if (/^@[A-Za-z0-9_$]+$/.test(name)) continue;
    name = name.replace(/^(?:SESSION|LOCAL)\s+/i, '').replace(/^@@(?:(?:SESSION|LOCAL)\s*\.\s*)?/i, '');
    if (/^`[A-Za-z0-9_]+`$/.test(name)) name = name.slice(1, -1);
    if (!RESTORE_SESSION_VARIABLES.has(name.toUpperCase())) {
      throw scopeError('SET chỉ được thay đổi các biến session cần cho tệp dump; biến global/persist hoặc chưa hỗ trợ bị chặn.');
    }
  }
}

function targetReferences(statement) {
  const sql = scrubSql(statement).trim();
  const command = (/^([A-Za-z]+)/.exec(sql) || [])[1]?.toUpperCase() || '';
  if (!command) throw scopeError('Không phân tích được câu lệnh SQL trong chế độ an toàn.');
  if (REJECTED_RESTORE_COMMANDS.has(command)) {
    throw scopeError(`Câu lệnh ${command} có thể ghi ngoài phạm vi database đích và bị chặn trong chế độ an toàn.`);
  }
  if (!ALLOWED_RESTORE_COMMANDS.has(command)) {
    throw scopeError(`Không nhận diện được câu lệnh ${command}; chế độ an toàn từ chối câu lệnh chưa phân tích.`);
  }
  const refs = [];
  const add = (ref) => { if (ref && ref.table) refs.push(ref); };
  if (command === 'SET') {
    assertRestoreSet(sql);
  } else if (command === 'START' && !/^START\s+TRANSACTION\b/i.test(sql)) {
    throw scopeError('Chỉ hỗ trợ START TRANSACTION trong chế độ phục hồi an toàn.');
  } else if (command === 'UNLOCK' && !/^UNLOCK\s+TABLES\s*$/i.test(sql)) {
    throw scopeError('Chỉ hỗ trợ UNLOCK TABLES trong chế độ phục hồi an toàn.');
  } else if (command === 'INSERT' || command === 'REPLACE') {
    add(targetReference(sql, new RegExp(`^(?:INSERT|REPLACE)\\s+(?:(?:LOW_PRIORITY|DELAYED|HIGH_PRIORITY|IGNORE)\\s+)*(?:INTO\\s+)?${REFERENCE}`, 'i')));
  } else if (command === 'UPDATE') {
    const body = sql.replace(/^UPDATE\s+(?:(?:LOW_PRIORITY|IGNORE)\s+)*/i, '');
    const setIndex = /\bSET\b/i.exec(body);
    const clause = setIndex ? body.slice(0, setIndex.index) : body;
    if (!setIndex) throw scopeError('Câu lệnh UPDATE thiếu SET nên không thể xác minh phạm vi ghi.');
    for (const ref of tableListReferences(clause)) add(ref);
    if (!refs.length) throw scopeError('Không xác định được bảng đích của câu lệnh UPDATE.');
  } else if (command === 'DELETE') {
    const fromMatch = /\b(?:FROM|USING)\b/i.exec(sql);
    if (fromMatch) {
      for (const ref of tableListReferences(sql.slice(fromMatch.index + fromMatch[0].length))) add(ref);
    }
    if (!refs.length) throw scopeError('Không xác định được bảng đích của câu lệnh DELETE.');
  } else if (command === 'TRUNCATE') {
    add(targetReference(sql, new RegExp(`^TRUNCATE\\s+(?:TABLE\\s+)?${REFERENCE}`, 'i')));
  } else if (command === 'RENAME') {
    if (!/^RENAME\s+TABLE\b/i.test(sql)) throw scopeError('Chỉ hỗ trợ RENAME TABLE trong chế độ phục hồi an toàn.');
    const body = sql.replace(/^RENAME\s+TABLE\s+/i, '');
    for (const part of body.split(',')) {
      const match = new RegExp(`^\\s*${REFERENCE}\\s+TO\\s+${REFERENCE}`, 'i').exec(part);
      if (!match) throw scopeError('Không phân tích được câu lệnh RENAME TABLE.');
      add(splitReference(match[1]));
      add(splitReference(match[2]));
    }
  } else if (command === 'CREATE') {
    if (/\bCREATE\s+(?:USER|ROLE|SERVER|TABLESPACE|LOGFILE|SPATIAL\s+REFERENCE\s+SYSTEM)\b/i.test(sql)) {
      throw scopeError('CREATE USER/ROLE/SERVER/TABLESPACE bị chặn trong chế độ phục hồi an toàn.');
    }
    const definer = 'DEFINER\\s*=\\s*(?:`(?:[^`]|``)*`|\'(?:[^\'\\\\]|\\\\.|\'\')*\'|"(?:[^"\\\\]|\\\\.|"")*"|\\S+)';
    const kinds = [
      ['TABLE', `^CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:TEMPORARY\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${REFERENCE}`],
      ['VIEW', `^CREATE\\s+(?:(?:OR\\s+REPLACE|ALGORITHM\\s*=\\s*\\w+|SQL\\s+SECURITY\\s+(?:DEFINER|INVOKER)|${definer})\\s+)*VIEW\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${REFERENCE}`],
      ['TRIGGER', `^CREATE\\s+(?:(?:OR\\s+REPLACE|${definer})\\s+)*TRIGGER\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${REFERENCE}`],
      ['PROCEDURE', `^CREATE\\s+(?:(?:OR\\s+REPLACE|${definer})\\s+)*PROCEDURE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${REFERENCE}`],
      ['FUNCTION', `^CREATE\\s+(?:(?:OR\\s+REPLACE|AGGREGATE|${definer})\\s+)*FUNCTION\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${REFERENCE}`],
      ['EVENT', `^CREATE\\s+(?:(?:OR\\s+REPLACE|${definer})\\s+)*EVENT\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${REFERENCE}`]
    ];
    let kind = null;
    for (const [name, pattern] of kinds) {
      const ref = targetReference(sql, new RegExp(pattern, 'i'));
      if (ref) { add(ref); kind = name; break; }
    }
    if (!kind) {
      add(targetReference(sql, new RegExp(`^CREATE\\s+(?:UNIQUE\\s+|FULLTEXT\\s+|SPATIAL\\s+)?INDEX\\s+${IDENTIFIER}\\s+ON\\s+${REFERENCE}`, 'i')));
      kind = refs.length ? 'INDEX' : null;
    }
    if (!kind) throw scopeError('Không phân tích được đối tượng đích của câu lệnh CREATE.');
    if (kind === 'TRIGGER') {
      add(targetReference(sql, new RegExp(`\\bON\\s+${REFERENCE}`, 'i')));
    }
    if (['TRIGGER', 'PROCEDURE', 'FUNCTION', 'EVENT'].includes(kind)) {
      for (const ref of routineWriteReferences(sql)) refs.push(ref);
    }
  } else if (command === 'ALTER') {
    if (/^ALTER\s+(?:DATABASE|SCHEMA)\b/i.test(sql)) {
      const database = new RegExp(`^ALTER\\s+(?:DATABASE|SCHEMA)\\s+(${IDENTIFIER})(?=\\s|$)`, 'i').exec(sql);
      if (!database) throw scopeError('ALTER DATABASE phải chỉ rõ database đích.');
      refs.push({ schema: splitReference(database[1]).table, table: null, objectType: 'database' });
      return { command, refs, sql };
    }
    if (/\bALTER\s+(?:USER|INSTANCE)\b/i.test(sql)) {
      throw scopeError('ALTER USER/INSTANCE bị chặn trong chế độ phục hồi an toàn.');
    }
    add(targetReference(sql, new RegExp(`^ALTER\\s+(?:ONLINE\\s+|OFFLINE\\s+|IGNORE\\s+)?(?:TABLE|VIEW|PROCEDURE|FUNCTION|EVENT)\\s+(?:IF\\s+EXISTS\\s+)?${REFERENCE}`, 'i')));
    if (!refs.length) throw scopeError('Không xác định được đối tượng đích của ALTER.');
    for (const match of sql.matchAll(new RegExp(`\\bRENAME\\s+(?:TO|AS)\\s+${REFERENCE}`, 'gi'))) add(splitReference(match[1]));
  } else if (command === 'DROP') {
    if (/\bDROP\s+(?:USER|ROLE|SERVER|TABLESPACE|LOGFILE)\b/i.test(sql)) {
      throw scopeError('DROP USER/ROLE/SERVER/TABLESPACE bị chặn trong chế độ phục hồi an toàn.');
    }
    add(targetReference(sql, new RegExp(`^DROP\\s+INDEX\\s+${IDENTIFIER}\\s+ON\\s+${REFERENCE}`, 'i')));
    const drop = new RegExp(`^DROP\\s+(?:TEMPORARY\\s+)?(?:TABLE|VIEW|TRIGGER|PROCEDURE|FUNCTION|EVENT)\\s+(?:IF\\s+EXISTS\\s+)?(.+?)(?:\\s+(?:RESTRICT|CASCADE))?$`, 'i').exec(sql);
    if (drop) {
      for (const part of drop[1].split(',')) add(splitReference(part.trim()));
    }
  } else if (command === 'LOAD') {
    add(targetReference(sql, new RegExp(`\\bINTO\\s+TABLE\\s+${REFERENCE}`, 'i')));
  } else if (command === 'LOCK') {
    if (!/^LOCK\s+TABLES?\b/i.test(sql)) throw scopeError('Chỉ hỗ trợ LOCK TABLES trong chế độ phục hồi an toàn.');
    for (const ref of tableListReferences(sql.replace(/^LOCK\s+TABLES?\s+/i, ''))) add(ref);
  } else if (['ANALYZE', 'OPTIMIZE', 'REPAIR', 'CHECK'].includes(command)) {
    const match = new RegExp(`\\bTABLE\\s+(.+)$`, 'i').exec(sql);
    if (match) {
      for (const part of match[1].split(',')) add(splitReference(part.trim()));
    }
  } else if (command === 'SELECT') {
    if (/\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i.test(sql)) {
      throw scopeError('SELECT ... INTO OUTFILE/DUMPFILE bị chặn trong chế độ phục hồi an toàn.');
    }
  }
  const requiresTable = ['INSERT', 'REPLACE', 'UPDATE', 'DELETE', 'TRUNCATE', 'RENAME', 'LOAD'];
  if (requiresTable.includes(command) && !refs.length) {
    throw scopeError(`Không xác định được bảng đích của câu lệnh ${command}.`);
  }
  return { command, refs, sql };
}

function assertStatementScope(statement, targetDatabase, statementNumber) {
  const result = targetReferences(statement);
  // Without server lower_case_table_names information, exact spelling is the safe portable policy.
  const target = String(targetDatabase || '');
  for (const ref of result.refs) {
    if (ref.schema && ref.schema !== target) {
      const error = scopeError(
        `Câu lệnh #${statementNumber || '?'} ghi vào \`${ref.schema}\`${ref.table ? `.\`${ref.table}\`` : ''}, ngoài database đích \`${targetDatabase}\`. Chế độ an toàn đã chặn trước khi ghi.`
      );
      error.schema = ref.schema;
      error.table = ref.table;
      error.statementNumber = statementNumber;
      throw error;
    }
  }
  return result;
}

function countInsertRows(statement) {
  const sql = scrubSql(statement).trim();
  if (!/^(?:INSERT|REPLACE)\b/i.test(sql)) return { rows: 0, reliable: true };
  const upper = sql.toUpperCase();
  const setMatch = /\bSET\b/.exec(upper);
  const valuesMatch = /\bVALUES\b/.exec(upper);
  if (setMatch && (!valuesMatch || setMatch.index < valuesMatch.index)) return { rows: 1, reliable: true };
  if (!valuesMatch) return { rows: null, reliable: false };
  let depth = 0;
  let rows = 0;
  for (let index = valuesMatch.index + 6; index < sql.length; index += 1) {
    const character = sql[index];
    if (character === '(') {
      if (depth === 0) rows += 1;
      depth += 1;
    } else if (character === ')') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && /[A-Za-z]/.test(character)) {
      const rest = sql.slice(index).toUpperCase();
      if (/^(?:ON\s+DUPLICATE|RETURNING)\b/.test(rest)) break;
    }
  }
  return rows ? { rows, reliable: true } : { rows: null, reliable: false };
}

module.exports = {
  SqlScriptParser,
  splitSqlStatements,
  stripLeadingComments,
  createTarget,
  skipReason,
  namedIdentifier,
  scrubSql,
  targetReferences,
  assertStatementScope,
  countInsertRows,
  routineWriteReferences
};
