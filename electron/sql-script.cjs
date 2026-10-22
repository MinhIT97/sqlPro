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
  const table = new RegExp(`^CREATE\\s+(?:TEMPORARY\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${identifier})`, 'i').exec(text);
  if (table) return { type: 'table', name: namedIdentifier(table[1]) };
  const view = new RegExp(
    `^CREATE\\s+(?:(?:OR\\s+REPLACE|ALGORITHM\\s*=\\s*\\w+|DEFINER\\s*=\\s*\\S+|SQL\\s+SECURITY\\s+(?:DEFINER|INVOKER))\\s+)*VIEW\\s+(${identifier})`,
    'i'
  ).exec(text);
  if (view) return { type: 'view', name: namedIdentifier(view[1]) };
  const trigger = new RegExp(`^CREATE\\s+(?:DEFINER\\s*=\\s*\\S+\\s+)?TRIGGER\\s+(${identifier})`, 'i').exec(text);
  if (trigger) return { type: 'trigger', name: namedIdentifier(trigger[1]) };
  return null;
}

function skipReason(statement) {
  const sql = stripLeadingComments(statement);
  if (/^USE\b/i.test(sql)) return 'USE';
  if (/^(?:CREATE|DROP)\s+(?:DATABASE|SCHEMA)\b/i.test(sql)) return 'database';
  return '';
}

module.exports = {
  SqlScriptParser,
  splitSqlStatements,
  stripLeadingComments,
  createTarget,
  skipReason,
  namedIdentifier
};
