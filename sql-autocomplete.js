(function attachSqlAutocomplete(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.SqlAutocomplete = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createSqlAutocomplete() {
  "use strict";

  const SQL_SUGGESTIONS = Object.freeze([
    { label: "SELECT", insertText: "SELECT", type: "keyword", detail: "Read rows from a table" },
    { label: "FROM", insertText: "FROM", type: "keyword", detail: "Choose the source table" },
    { label: "WHERE", insertText: "WHERE", type: "keyword", detail: "Filter rows" },
    { label: "JOIN", insertText: "JOIN", type: "keyword", detail: "Join another table" },
    { label: "LEFT JOIN", insertText: "LEFT JOIN", type: "keyword", detail: "Keep every row from the left table" },
    { label: "RIGHT JOIN", insertText: "RIGHT JOIN", type: "keyword", detail: "Keep every row from the right table" },
    { label: "INNER JOIN", insertText: "INNER JOIN", type: "keyword", detail: "Keep matching rows" },
    { label: "CROSS JOIN", insertText: "CROSS JOIN", type: "keyword", detail: "Build a Cartesian product" },
    { label: "ON", insertText: "ON", type: "keyword", detail: "Set join conditions" },
    { label: "AS", insertText: "AS", type: "keyword", detail: "Assign an alias" },
    { label: "AND", insertText: "AND", type: "keyword", detail: "Require both conditions" },
    { label: "OR", insertText: "OR", type: "keyword", detail: "Require either condition" },
    { label: "NOT", insertText: "NOT", type: "keyword", detail: "Negate a condition" },
    { label: "IN", insertText: "IN", type: "keyword", detail: "Match a list or subquery" },
    { label: "BETWEEN", insertText: "BETWEEN", type: "keyword", detail: "Match a range" },
    { label: "LIKE", insertText: "LIKE", type: "keyword", detail: "Match a text pattern" },
    { label: "IS NULL", insertText: "IS NULL", type: "keyword", detail: "Match NULL values" },
    { label: "IS NOT NULL", insertText: "IS NOT NULL", type: "keyword", detail: "Exclude NULL values" },
    { label: "DISTINCT", insertText: "DISTINCT", type: "keyword", detail: "Remove duplicate rows" },
    { label: "GROUP BY", insertText: "GROUP BY", type: "keyword", detail: "Group rows" },
    { label: "HAVING", insertText: "HAVING", type: "keyword", detail: "Filter grouped rows" },
    { label: "ORDER BY", insertText: "ORDER BY", type: "keyword", detail: "Sort result rows" },
    { label: "ASC", insertText: "ASC", type: "keyword", detail: "Sort ascending" },
    { label: "DESC", insertText: "DESC", type: "keyword", detail: "Sort descending" },
    { label: "LIMIT", insertText: "LIMIT", type: "keyword", detail: "Limit the result size" },
    { label: "OFFSET", insertText: "OFFSET", type: "keyword", detail: "Skip result rows" },
    { label: "UNION", insertText: "UNION", type: "keyword", detail: "Combine result sets" },
    { label: "UNION ALL", insertText: "UNION ALL", type: "keyword", detail: "Combine result sets with duplicates" },
    { label: "WITH", insertText: "WITH", type: "keyword", detail: "Start a common table expression" },
    { label: "CASE", insertText: "CASE", type: "keyword", detail: "Start a conditional expression" },
    { label: "WHEN", insertText: "WHEN", type: "keyword", detail: "Add a CASE condition" },
    { label: "THEN", insertText: "THEN", type: "keyword", detail: "Add a CASE result" },
    { label: "ELSE", insertText: "ELSE", type: "keyword", detail: "Add a fallback result" },
    { label: "END", insertText: "END", type: "keyword", detail: "End CASE or a compound statement" },
    { label: "INSERT INTO", insertText: "INSERT INTO", type: "keyword", detail: "Insert rows" },
    { label: "VALUES", insertText: "VALUES", type: "keyword", detail: "Provide inserted values" },
    { label: "UPDATE", insertText: "UPDATE", type: "keyword", detail: "Update rows" },
    { label: "SET", insertText: "SET", type: "keyword", detail: "Assign column values" },
    { label: "DELETE FROM", insertText: "DELETE FROM", type: "keyword", detail: "Delete rows" },
    { label: "CREATE TABLE", insertText: "CREATE TABLE", type: "keyword", detail: "Create a table" },
    { label: "ALTER TABLE", insertText: "ALTER TABLE", type: "keyword", detail: "Change a table" },
    { label: "DROP TABLE", insertText: "DROP TABLE", type: "keyword", detail: "Remove a table" },
    { label: "TRUNCATE TABLE", insertText: "TRUNCATE TABLE", type: "keyword", detail: "Remove all table rows" },
    { label: "SHOW TABLES", insertText: "SHOW TABLES", type: "keyword", detail: "List tables" },
    { label: "DESCRIBE", insertText: "DESCRIBE", type: "keyword", detail: "Show table columns" },
    { label: "EXPLAIN", insertText: "EXPLAIN", type: "keyword", detail: "Inspect the query plan" },
    { label: "BEGIN", insertText: "BEGIN", type: "keyword", detail: "Start a transaction" },
    { label: "COMMIT", insertText: "COMMIT", type: "keyword", detail: "Commit a transaction" },
    { label: "ROLLBACK", insertText: "ROLLBACK", type: "keyword", detail: "Roll back a transaction" },
    { label: "COUNT()", insertText: "COUNT()", type: "function", detail: "Count rows or non-NULL values" },
    { label: "SUM()", insertText: "SUM()", type: "function", detail: "Sum numeric values" },
    { label: "AVG()", insertText: "AVG()", type: "function", detail: "Average numeric values" },
    { label: "MIN()", insertText: "MIN()", type: "function", detail: "Find the minimum value" },
    { label: "MAX()", insertText: "MAX()", type: "function", detail: "Find the maximum value" },
    { label: "NOW()", insertText: "NOW()", type: "function", detail: "Get the current date and time" },
    { label: "COALESCE()", insertText: "COALESCE()", type: "function", detail: "Return the first non-NULL value" },
    { label: "CONCAT()", insertText: "CONCAT()", type: "function", detail: "Concatenate strings" },
    { label: "SELECT … FROM …", insertText: "SELECT * FROM ", type: "snippet", detail: "Select all columns from a table" },
    { label: "INSERT INTO … VALUES …", insertText: "INSERT INTO  () VALUES ();", type: "snippet", detail: "Insert a row" },
    { label: "UPDATE … SET … WHERE …", insertText: "UPDATE  SET  WHERE ;", type: "snippet", detail: "Update matching rows" },
    { label: "DELETE FROM … WHERE …", insertText: "DELETE FROM  WHERE ;", type: "snippet", detail: "Delete matching rows" }
  ]);

  const ALIAS_STOP_WORDS = new Set([
    "AS", "ON", "USING", "WHERE", "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "NATURAL",
    "GROUP", "ORDER", "HAVING", "LIMIT", "OFFSET", "UNION", "SET", "VALUES", "RETURNING", "FOR",
    "LOCK", "INTO", "FROM", "WINDOW", "PARTITION", "STRAIGHT_JOIN"
  ]);

  function isWhitespace(character) {
    return character === " " || character === "\t" || character === "\n" || character === "\r" || character === "\f";
  }

  function scanSql(value) {
    const sql = String(value || "");
    const structural = new Array(sql.length).fill(" ");
    const code = new Array(sql.length).fill(" ");
    const states = new Array(sql.length + 1);
    let state = "normal";

    for (let index = 0; index < sql.length; index += 1) {
      states[index] = state;
      const character = sql[index];
      const next = sql[index + 1];

      if (state === "normal") {
        if (character === "'") {
          state = "single";
          continue;
        }
        if (character === '"') {
          state = "double";
          continue;
        }
        if (character === "`") {
          code[index] = character;
          state = "backtick";
          continue;
        }
        if (character === "#") {
          state = "line-comment";
          continue;
        }
        if (character === "-" && next === "-" && (index + 2 >= sql.length || isWhitespace(sql[index + 2]))) {
          states[index + 1] = "line-comment";
          index += 1;
          state = "line-comment";
          continue;
        }
        if (character === "/" && next === "*") {
          states[index + 1] = "block-comment";
          index += 1;
          state = "block-comment";
          continue;
        }

        structural[index] = character;
        code[index] = character;
        continue;
      }

      if (state === "single" || state === "double") {
        const quote = state === "single" ? "'" : '"';
        if (character === "\\" && index + 1 < sql.length) {
          states[index + 1] = state;
          index += 1;
          continue;
        }
        if (character === quote && next === quote) {
          states[index + 1] = state;
          index += 1;
          continue;
        }
        if (character === quote) {
          state = "normal";
        }
        continue;
      }

      if (state === "backtick") {
        code[index] = character;
        if (character === "`" && next === "`") {
          code[index + 1] = next;
          states[index + 1] = state;
          index += 1;
          continue;
        }
        if (character === "`") {
          state = "normal";
        }
        continue;
      }

      if (state === "line-comment") {
        if (character === "\n" || character === "\r") {
          structural[index] = character;
          code[index] = character;
          state = "normal";
        }
        continue;
      }

      if (state === "block-comment" && character === "*" && next === "/") {
        states[index + 1] = state;
        index += 1;
        state = "normal";
      }
    }

    states[sql.length] = state;
    return { structural: structural.join(""), code: code.join(""), states };
  }

  function extractTableReferences(statement) {
    const sql = String(statement || '');
    return tableScope(sql, sql.length).references;
  }

  // A bounded query-block recognizer for suggestions, never an SQL validator or
  // execution permission. Local/opaque sources must not become metadata reads.
  function tableScope(sql, caret) {
    const unknown = { known: false, references: [], allowQualifierCatalog: false };
    if (typeof sql !== 'string' || sql.length > 65536) return unknown;
    caret = Number.isFinite(caret) ? Math.max(0, Math.min(sql.length, Math.trunc(caret))) : sql.length;
    const scanned = scanSql(sql), { code } = scanned;
    for (let i = 0; i < sql.length; i++) {
      if (sql[i] === '\\' && !['line-comment', 'block-comment'].includes(scanned.states[i])) return unknown;
      if (scanned.states[i] === 'normal' && /^\/\*(?:[!+]|M!)/i.test(sql.slice(i, i + 4))) return unknown;
    }
    const root = { start: 0, end: sql.length, tokens: [], parent: null }, groups = [root];
    let current = root, depth = 0, count = 0;
    for (let i = 0; i < code.length;) {
      if (isWhitespace(code[i])) { i++; continue; }
      if (++count > 4096) return unknown;
      const start = i, c = code[i];
      if (c === '(') {
        if (++depth > 32 || groups.length >= 128) return unknown;
        const child = { start: i + 1, end: sql.length, tokens: [], parent: current };
        current.tokens.push({ type: 'group', value: '', start: i, group: child });
        groups.push(child); current = child; i++; continue;
      }
      if (c === ')') {
        if (!current.parent) return unknown;
        current.end = i; current = current.parent; depth--; i++; continue;
      }
      if (c === '`') {
        let value = '', closed = false; i++;
        while (i < code.length) {
          if (code[i] === '`') {
            if (code[i + 1] === '`') { value += '`'; i += 2; continue; }
            i++; closed = true; break;
          }
          value += code[i++];
        }
        current.tokens.push({ type: 'identifier', value, closed, start, end: i }); continue;
      }
      if (c.charCodeAt(0) > 127) return unknown; // Unicode identifiers require backticks in this recognizer.
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*|^[0-9]+/.exec(code.slice(i));
      if (match) {
        const value = match[0]; i += value.length;
        current.tokens.push({ type: /^[0-9]/.test(value) ? 'number' : 'word', value, start, end: i }); continue;
      }
      current.tokens.push({ type: 'symbol', value: c, start, end: i + 1 }); i++;
    }
    const word = (token, value) => token?.type === 'word' && token.value.toUpperCase() === value;
    const stop = new Set([...ALIAS_STOP_WORDS, 'SELECT', 'WITH', 'EXCEPT', 'INTERSECT', 'USE', 'FORCE', 'IGNORE', 'INDEX', 'OUTFILE', 'DUMPFILE', 'PROCEDURE', 'QUALIFY', 'LATERAL', 'TABLE']);
    const name = token => (token?.type === 'identifier' && token.closed || token?.type === 'word' && !stop.has(token.value.toUpperCase()))
      && token.value.length > 0 && token.value.length <= 64 && !token.value.includes('\0');
    const keyword = (tokens, index, value) => tokens[index - 1]?.value !== '.' && word(tokens[index], value);
    const command = tokens => tokens.findIndex((token, index) => ['SELECT', 'UPDATE', 'INSERT', 'REPLACE', 'DELETE'].some(value => keyword(tokens, index, value)));
    const hasLiteral = (start, end) => {
      for (let index = start; index < end; index++) {
        if (['single', 'double'].includes(scanned.states[index])
            || ['\'', '"'].includes(sql[index]) && scanned.states[index] === 'normal') return true;
      }
      return false;
    };
    const declaredColumns = group => {
      const tokens = group.tokens, columns = [], seen = new Set();
      if (!tokens.length || tokens.length % 2 === 0 || tokens.length > 511) return null;
      // Masked literals must not turn an invalid declaration into a list of names.
      if (hasLiteral(group.start, group.end)) return null;
      for (let index = 0; index < tokens.length; index++) {
        if (index % 2) { if (tokens[index].type !== 'symbol' || tokens[index].value !== ',') return null; continue; }
        const token = tokens[index];
        if (!name(token) || seen.has(token.value.toLowerCase())) return null;
        seen.add(token.value.toLowerCase()); columns.push(token.value);
      }
      return Object.freeze(columns);
    };
    const starSourceCache = new WeakMap();
    const localStarSources = (tokens, group, blockEnd) => {
      if (starSourceCache.has(tokens)) return starSourceCache.get(tokens);
      starSourceCache.set(tokens, null);
      const from = tokens.findIndex((token, index) => keyword(tokens, index, 'FROM'));
      if (from < 0) return null;
      const sources = [], owners = new Set();
      const clause = index => ['WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'WINDOW', 'FOR', 'LOCK'].some(value => keyword(tokens, index, value));
      const comma = index => tokens[index]?.type === 'symbol' && tokens[index].value === ',';
      const joinStart = index => ['JOIN', 'INNER', 'LEFT', 'RIGHT', 'CROSS', 'NATURAL', 'FULL', 'OUTER', 'STRAIGHT_JOIN'].some(value => keyword(tokens, index, value));
      let index = from + 1, gapStart = tokens[from].end, joined = false, needsOn = false;
      while (index < tokens.length) {
        if (sources.length >= 64) return null;
        const source = tokens[index];
        let owner = '', columns;
        if (source.type === 'group') { columns = selectColumns(source.group); index++; }
        else {
          if (!name(source)) return null;
          owner = source.value; index++;
          for (let scope = group; scope; scope = scope.parent) {
            if (!scope.headerKnown) return null;
            const local = owner.toLocaleLowerCase();
            if (!scope.locals.has(local)) continue;
            // An unsupported/forward local binding still shadows outer names.
            if (scope.localStarts.get(local) > source.start) return null;
            columns = scope.localBodies.has(local) ? selectColumns(scope.localBodies.get(local)) : scope.localColumns.get(local);
            break;
          }
        }
        if (word(tokens[index], 'AS')) {
          if (!name(tokens[++index])) return null;
          owner = tokens[index++].value;
        } else if (name(tokens[index]) && !word(tokens[index], 'OUTER')) owner = tokens[index++].value;
        if (!owner || !columns || owners.has(owner.toLowerCase())
            || hasLiteral(gapStart, source.start)
            || hasLiteral(source.type === 'group' ? source.group.end + 1 : source.start, tokens[index]?.start ?? blockEnd)) return null;
        owners.add(owner.toLowerCase()); sources.push({ owner, columns });
        if (word(tokens[index], 'ON')) {
          if (!joined) return null;
          const condition = tokens[index++].end, begin = index;
          // Predicates are opaque. Only direct source boundaries are recognized;
          // subqueries/commas inside a parenthesized expression stay in its group.
          while (index < tokens.length && !clause(index) && !comma(index) && !joinStart(index)) {
            if (keyword(tokens, index, 'USING') || keyword(tokens, index, 'ON')) return null;
            index++;
          }
          if (index === begin && !hasLiteral(condition, tokens[index]?.start ?? blockEnd)) return null;
        } else if (needsOn) return null;
        if (index === tokens.length || clause(index)) {
          starSourceCache.set(tokens, sources);
          return sources;
        }
        gapStart = tokens[index].start;
        if (comma(index)) { index++; joined = false; needsOn = false; continue; }
        needsOn = word(tokens[index], 'LEFT') || word(tokens[index], 'RIGHT');
        if (needsOn) { index++; if (word(tokens[index], 'OUTER')) index++; }
        else if (word(tokens[index], 'INNER') || word(tokens[index], 'CROSS')) index++;
        if (!word(tokens[index++], 'JOIN')) return null;
        joined = true;
      }
      return null;
    };
    let starReads = 0, starNames = 0;
    const localStarColumns = (tokens, group, qualifier, blockEnd) => {
      if (++starReads > 64) return null;
      const sources = localStarSources(tokens, group, blockEnd);
      if (!sources || qualifier === null && sources.length !== 1) return null;
      const columns = (qualifier === null ? sources[0] : sources.find(source => source.owner === qualifier))?.columns;
      if (!columns) return null;
      // No physical catalog reads, unqualified multi-source/USING merges or types.
      starNames += columns.length;
      if (starNames > 4096) return null;
      return columns;
    };
    const readSelectColumns = (tokens, blockEnd, group) => {
      const head = 0;
      if (!word(tokens[head], 'SELECT')) return null;
      let begin = head + 1, end = tokens.length;
      if (word(tokens[begin], 'ALL') || word(tokens[begin], 'DISTINCT')) begin++;
      if (['DISTINCTROW', 'HIGH_PRIORITY', 'STRAIGHT_JOIN', 'SQL_SMALL_RESULT', 'SQL_BIG_RESULT', 'SQL_BUFFER_RESULT', 'SQL_NO_CACHE', 'SQL_CALC_FOUND_ROWS'].some(value => word(tokens[begin], value))) return null;
      for (let index = begin; index < tokens.length; index++) {
        if (['FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'WINDOW', 'FOR', 'LOCK'].some(value => keyword(tokens, index, value))) { end = index; break; }
      }
      const columns = [], seen = new Set();
      const outputName = token => name(token) && (token.type === 'identifier' || ![
        'NULL', 'TRUE', 'FALSE', 'DEFAULT', 'CASE', 'END', 'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP',
        'CURRENT_USER', 'LOCALTIME', 'LOCALTIMESTAMP', 'UTC_DATE', 'UTC_TIME', 'UTC_TIMESTAMP', 'SESSION_USER', 'SYSTEM_USER'
      ].includes(token.value.toUpperCase()));
      const columnPath = parts => [1, 3, 5].includes(parts.length) && parts.every((token, index) => index % 2
        ? token.type === 'symbol' && token.value === '.' : outputName(token));
      const implicitName = token => outputName(token) && (token.type === 'identifier' || ![
        'AND', 'OR', 'XOR', 'NOT', 'IS', 'IN', 'LIKE', 'REGEXP', 'RLIKE', 'BETWEEN', 'DIV', 'MOD',
        'COLLATE', 'BINARY', 'WHEN', 'THEN', 'ELSE', 'ASC', 'DESC', 'OVER', 'FILTER', 'AS'
      ].includes(token.value.toUpperCase()));
      const implicitColumn = (item, start, finish) => {
        const alias = item.at(-1), expression = item.slice(0, -1);
        if (!implicitName(alias) || !expression.length) return null;
        const atom = columnPath(expression) || expression.length === 1 && expression[0].type === 'group'
          || expression.length === 2 && implicitName(expression[0]) && expression[1].type === 'group';
        if (!atom) return null;
        const last = expression.at(-1);
        const expressionEnd = last.type === 'group' ? last.group.end + 1 : last.end;
        if (expressionEnd >= alias.start || !/^[ \t\n\r\f]+$/.test(scanned.code.slice(expressionEnd, alias.start))) return null;
        // Literal arguments inside an opaque group are fine. Literals outside
        // groups cannot disappear into the gap before an inferred alias.
        for (const token of expression) {
          if (token.type !== 'group') continue;
          if (hasLiteral(start, token.start)) return null;
          start = token.group.end + 1;
        }
        if (hasLiteral(start, finish)) return null;
        return alias.value;
      };
      let itemStart = tokens[begin - 1]?.start + tokens[begin - 1]?.value.length;
      for (let index = begin; index <= end; index++) {
        if (index !== end && !(tokens[index].type === 'symbol' && tokens[index].value === ',')) continue;
        const itemEnd = tokens[index]?.start ?? blockEnd;
        const item = tokens.slice(begin, index);
        const star = item.length === 1 && item[0].type === 'symbol' && item[0].value === '*';
        const qualifiedStar = item.length === 3 && name(item[0]) && item[1].type === 'symbol' && item[1].value === '.'
          && item[2].type === 'symbol' && item[2].value === '*';
        if (star || qualifiedStar) {
          if (hasLiteral(itemStart, itemEnd)) return null;
          const expanded = localStarColumns(tokens, group, qualifiedStar ? item[0].value : null, blockEnd);
          if (!expanded) return null;
          for (const column of expanded) {
            if (seen.has(column.toLowerCase()) || columns.length >= 256) return null;
            seen.add(column.toLowerCase()); columns.push(column);
          }
          begin = index + 1; itemStart = itemEnd + 1;
          continue;
        }
        const aliasIndex = item.findIndex(token => word(token, 'AS'));
        let column;
        if (aliasIndex >= 0) {
          if (aliasIndex !== item.length - 2 || !name(item.at(-1))
              || hasLiteral(item[aliasIndex].start + 2, itemEnd)
              || aliasIndex === 0 && !hasLiteral(itemStart, item[0].start)) return null;
          const expression = item.slice(0, aliasIndex);
          if (expression.length === 1 && expression[0].value === '*'
              || expression.at(-1)?.value === '*' && expression.at(-2)?.value === '.') return null;
          column = item.at(-1).value;
        } else {
          column = columnPath(item) && !hasLiteral(itemStart, itemEnd)
            ? item.at(-1).value : implicitColumn(item, itemStart, itemEnd);
          if (column === null) return null;
        }
        if (seen.has(column.toLowerCase()) || columns.length >= 256) return null;
        seen.add(column.toLowerCase()); columns.push(column);
        begin = index + 1; itemStart = itemEnd + 1;
      }
      if (!columns.length) return null;
      return Object.freeze(columns);
    };
    const outputCache = new WeakMap();
    const selectColumns = group => {
      if (outputCache.has(group)) return outputCache.get(group);
      outputCache.set(group, null);
      if (!group.query || !group.headerKnown || sql[group.end] !== ')') return null;
      const tokens = group.tokens, head = command(tokens);
      if (head < 0 || !word(tokens[head], 'SELECT')) return null;
      if (tokens.some((token, index) => ['INTO', 'PROCEDURE', 'QUALIFY'].some(value => keyword(tokens, index, value)))) return null;
      const separators = tokens.map((token, index) => index >= head
        && ['UNION', 'INTERSECT', 'EXCEPT'].some(value => keyword(tokens, index, value)) ? index : -1).filter(index => index >= 0);
      if (separators.length > 15) return null;
      let begin = head, first = null;
      for (const end of [...separators, tokens.length]) {
        const columns = readSelectColumns(tokens.slice(begin, end), tokens[end]?.start ?? group.end, group);
        if (!columns || first && columns.length !== first.length) return null;
        if (!first) first = columns;
        begin = end + 1;
        if (word(tokens[begin], 'ALL') || word(tokens[begin], 'DISTINCT')) begin++;
      }
      outputCache.set(group, first);
      return first;
    };
    for (const group of groups) {
      group.query = group === root || word(group.tokens[0], 'SELECT') || word(group.tokens[0], 'WITH');
      group.locals = new Set(); group.localColumns = new Map(); group.localBodies = new Map(); group.localStarts = new Map(); group.headerKnown = true;
      const withIndex = group.tokens.findIndex((token, index) => keyword(group.tokens, index, 'WITH'));
      const firstCommand = command(group.tokens);
      if (!group.query || withIndex < 0 || firstCommand >= 0 && withIndex > firstCommand) continue;
      let index = withIndex + 1;
      if (word(group.tokens[index], 'RECURSIVE')) index++;
      while (index < group.tokens.length) {
        if (!name(group.tokens[index])) { group.headerKnown = false; break; }
        const declaration = group.tokens[index++];
        const local = declaration.value.toLocaleLowerCase();
        if (group.locals.has(local)) { group.headerKnown = false; break; }
        group.locals.add(local);
        group.localStarts.set(local, declaration.start);
        let columnNames = null;
        const declared = group.tokens[index]?.type === 'group';
        if (declared) columnNames = declaredColumns(group.tokens[index++].group);
        group.localColumns.set(local, columnNames);
        if (!word(group.tokens[index++], 'AS') || group.tokens[index]?.type !== 'group') { group.headerKnown = false; break; }
        if (!declared) group.localBodies.set(local, group.tokens[index].group);
        index++;
        if (group.tokens[index]?.value !== ',') break;
        index++;
        if (index === group.tokens.length) group.headerKnown = false;
      }
    }
    for (const group of groups) {
      for (const [local, body] of group.localBodies) group.localColumns.set(local, selectColumns(body));
    }
    let scope = root;
    for (const group of groups) if (group.query && group.start <= caret && caret <= group.end) scope = group;
    const locals = new Set(), localColumns = new Map();
    for (let group = scope; group; group = group.parent) {
      if (!group.headerKnown) return unknown;
      for (const local of group.locals) {
        locals.add(local);
        if (!localColumns.has(local)) localColumns.set(local, { names: group.localColumns.get(local), projected: group.localBodies.has(local) });
      }
    }
    const tokens = scope.tokens, first = command(tokens);
    if (first < 0) return scope === root && ['SHOW', 'DESC', 'DESCRIBE', 'ALTER', 'CREATE', 'DROP', 'TRUNCATE', 'USE'].some(value => word(tokens[0], value))
      ? { known: true, references: [], allowQualifierCatalog: false } : unknown;
    if (caret < tokens[first].start) return unknown;
    const separators = tokens.map((token, index) => ['UNION', 'INTERSECT', 'EXCEPT'].some(value => keyword(tokens, index, value)) ? index : -1).filter(index => index >= 0);
    let begin = first, end = tokens.length;
    if (['INSERT', 'REPLACE'].some(value => word(tokens[first], value))) {
      const select = tokens.findIndex((token, index) => keyword(tokens, index, 'SELECT'));
      if (select > first) { if (caret >= tokens[select].start) begin = select; else end = select; }
    }
    for (const index of separators) {
      if (tokens[index].start >= caret) { end = Math.min(end, index); break; }
      begin = index + 1;
    }
    const branch = tokens.slice(begin, end), head = command(branch);
    if (head < 0 || caret < branch[head].start) return unknown;
    if (separators.length && word(branch[head], 'SELECT')
        && branch.some((token, index) => ['ORDER', 'LIMIT', 'FOR', 'LOCK', 'INTO'].some(value => keyword(branch, index, value)) && token.start <= caret)) return unknown;
    const references = []; let inFrom = false;
    const source = (index, insertTarget) => {
      let table = '', database = '', local = false, columnNames = null, columnSource = null;
      if (branch[index]?.type === 'group') {
        local = true; columnNames = selectColumns(branch[index++].group); columnSource = 'derived-select';
      }
      else {
        if (!name(branch[index])) return null;
        table = branch[index++].value;
        if (branch[index]?.value === '.') {
          if (!name(branch[index + 1])) return null;
          database = table; table = branch[index + 1].value; index += 2;
          if (branch[index]?.value === '.') return null;
        }
        local = !database && locals.has(table.toLocaleLowerCase());
        if (local) {
          const output = localColumns.get(table.toLocaleLowerCase());
          columnNames = output.names; columnSource = output.projected ? 'cte-select' : null;
        }
        if (branch[index]?.type === 'group') { if (!insertTarget) { local = true; columnNames = null; } index++; }
      }
      let alias = '';
      if (word(branch[index], 'AS')) { if (!name(branch[++index])) return null; alias = branch[index++].value; }
      else if (name(branch[index])) alias = branch[index++].value;
      if (['PARTITION', 'USE', 'FORCE', 'IGNORE', 'WITH'].some(value => word(branch[index], value))) return null;
      if (branch[index]?.type === 'symbol' && ![',', ';'].includes(branch[index].value)) return null;
      if (branch[index]?.type === 'group') return null;
      return { index, reference: { table: table || alias, ...(database ? { database } : {}), ...(alias ? { alias } : {}),
        ...(local ? { local: true } : {}), ...(columnNames ? { columnNames, ...(columnSource ? { columnSource } : {}) } : {}) } };
    };
    for (let index = head; index < branch.length; index++) {
      const from = keyword(branch, index, 'FROM'), join = ['JOIN', 'STRAIGHT_JOIN'].some(value => keyword(branch, index, value));
      const insertTarget = ['INSERT', 'REPLACE'].some(value => word(branch[head], value)) && keyword(branch, index, 'INTO');
      const target = index === head && word(branch[index], 'UPDATE') || insertTarget;
      if (from || join || target || inFrom && branch[index].value === ',') {
        inFrom = true;
        if (!branch[index + 1] || branch[index + 1].type === 'identifier' && !branch[index + 1].closed && index + 2 === branch.length) break;
        const parsed = source(index + 1, insertTarget);
        if (!parsed || references.length >= 64) return unknown;
        references.push(parsed.reference); index = parsed.index - 1;
      } else if (['WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'WINDOW', 'FOR', 'LOCK', 'SET', 'VALUES', 'RETURNING'].some(value => keyword(branch, index, value))) inFrom = false;
    }
    return { known: true, references, allowQualifierCatalog: scope === root && locals.size === 0 };
  }

  function identifierContext(sql, caret, scanned, statementStart, statementEnd) {
    let start = caret;
    let end = caret;
    let prefix = '';
    let disabled = false;
    const identifierPart = character => character !== undefined && /[A-Za-z0-9_$]/.test(character);
    const unsupported = character => character !== undefined && character.charCodeAt(0) > 127;
    const quoted = scanned.states[caret] === 'backtick'
      || scanned.states[caret] === 'normal' && sql[caret] === '`';
    if (quoted) {
      while (start > statementStart && scanned.states[start] !== 'normal') start -= 1;
      end = start + 1;
      let closed = false;
      while (end < statementEnd) {
        if (sql[end] === '`') {
          if (sql[end + 1] === '`') { end += 2; continue; }
          end += 1;
          closed = true;
          break;
        }
        end += 1;
      }
      prefix = sql.slice(start + 1, Math.max(start + 1, caret)).replace(/``/g, '`');
      // An unclosed token may swallow SQL to the right; only finish a simple tail at EOF.
      disabled = sql.slice(start, end).includes('\\')
        || identifierPart(sql[start - 1]) || unsupported(sql[start - 1]) || sql[start - 1] === '`'
        || !closed && !/^[A-Za-z0-9_$]*$/.test(sql.slice(caret, end))
        || closed && (identifierPart(sql[end]) || unsupported(sql[end]));
    } else {
      while (start > statementStart && scanned.states[start - 1] === 'normal' && identifierPart(sql[start - 1])) start -= 1;
      while (end < statementEnd && scanned.states[end] === 'normal' && identifierPart(sql[end])) end += 1;
      prefix = sql.slice(start, caret);
      disabled = end > start && !/^[A-Za-z_$]/.test(sql[start])
        || unsupported(sql[start - 1]) || unsupported(sql[end])
        || sql[start - 1] === '`' || sql[end] === '`';
    }
    const ownerText = scanned.code.slice(statementStart, start);
    const owner = ownerText.match(/(?:`((?:``|[^`])*)`|([A-Za-z_$][\w$]*))[ \t\n\r\f]*\.[ \t\n\r\f]*$/);
    const boundary = owner ? ownerText[owner.index - 1] : undefined;
    const qualifier = owner && !identifierPart(boundary) && !unsupported(boundary)
      ? (owner[1] ?? owner[2]).replace(/``/g, '`') : null;
    return { start, end, prefix, qualifier, disabled };
  }

  function getContext(value, caretPosition) {
    const sql = String(value || "");
    const numericCaret = Number.isFinite(caretPosition) ? Math.trunc(caretPosition) : sql.length;
    const caret = Math.max(0, Math.min(sql.length, numericCaret));
    const scanned = scanSql(sql);
    const caretState = scanned.states[caret] || "normal";
    const blocked = caretState === "single" || caretState === "double" || caretState === "line-comment" || caretState === "block-comment";
    const previousDelimiter = scanned.structural.lastIndexOf(";", Math.max(0, caret - 1));
    const nextDelimiter = scanned.structural.indexOf(";", caret);
    const statementStart = previousDelimiter < 0 ? 0 : previousDelimiter + 1;
    const statementEnd = nextDelimiter < 0 ? sql.length : nextDelimiter;
    const statement = sql.slice(statementStart, statementEnd);
    const token = identifierContext(sql, caret, scanned, statementStart, statementEnd);
    const scope = tableScope(statement, caret - statementStart);

    return {
      disabled: blocked || token.disabled,
      value: sql,
      caret,
      start: token.start,
      end: token.end,
      prefix: token.prefix,
      qualifier: token.qualifier,
      expectsColumn: /\b(?:WHERE|AND|OR|ON|HAVING|ORDER\s+BY|GROUP\s+BY)\s+$/i.test(
        scanned.code.slice(statementStart, token.start)
      ),
      statement,
      statementStart,
      statementEnd,
      references: scope.references,
      scopeKnown: scope.known,
      allowQualifierCatalog: scope.allowQualifierCatalog
    };
  }

  function suggestionScore(item, prefix, originalIndex) {
    const label = String(item && item.label !== undefined ? item.label : item || "");
    const insertText = String(item && item.insertText !== undefined ? item.insertText : label);
    const query = String(prefix || "").toLocaleLowerCase();
    const haystacks = [label.toLocaleLowerCase(), insertText.toLocaleLowerCase()];
    const typePriority = { snippet: 0, table: 1, column: 2, keyword: 3, function: 4 }[item && item.type] ?? 5;

    if (!query) {
      return typePriority * 1000 + originalIndex;
    }

    let best = Number.POSITIVE_INFINITY;
    for (const haystack of haystacks) {
      if (haystack === query) best = Math.min(best, 0);
      else if (haystack.startsWith(query)) best = Math.min(best, 100);
      else if (haystack.split(/[^a-z0-9_$]+/i).some((word) => word.startsWith(query))) best = Math.min(best, 200);
      else if (haystack.includes(query)) best = Math.min(best, 300);
      else {
        let queryIndex = 0;
        for (let index = 0; index < haystack.length && queryIndex < query.length; index += 1) {
          if (haystack[index] === query[queryIndex]) queryIndex += 1;
        }
        if (queryIndex === query.length) best = Math.min(best, 400);
      }
    }

    return Number.isFinite(best) ? best * 10000 + typePriority * 1000 + originalIndex : best;
  }

  function rankSuggestions(items, prefix, limit) {
    const maximum = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 60;
    const seen = new Set();

    return (Array.isArray(items) ? items : [])
      .map((item, index) => ({ item, index, score: suggestionScore(item, prefix, index) }))
      .filter((entry) => Number.isFinite(entry.score))
      .sort((left, right) => left.score - right.score)
      .filter((entry) => {
        const item = entry.item;
        const label = String(item && item.label !== undefined ? item.label : item || "");
        const insertText = String(item && item.insertText !== undefined ? item.insertText : label);
        const type = item && item.type ? item.type : '';
        const key = JSON.stringify([['column', 'table', 'view'].includes(type) ? insertText : insertText.toLocaleLowerCase(), type]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, maximum)
      .map((entry) => entry.item);
  }

  // Only projected suggestion metadata is retained. Clearing invalidates old
  // readers but still counts them against admission until they settle.
  function createColumnCache({ now = Date.now } = {}) {
    const ready = new Map(), pending = new Map(), active = new Set();
    const empty = Object.freeze([]);
    let generation = 0, characters = 0;
    const validName = (value, maximum) => typeof value === 'string' && value.length > 0
      && value.length <= maximum && !value.includes('\0');
    const remove = key => { characters -= ready.get(key).characters; ready.delete(key); };
    const prune = time => {
      for (const [key, entry] of ready) {
        if (time < entry.createdAt || time >= entry.expiresAt) remove(key);
      }
    };
    function project(value, key) {
      if (!Array.isArray(value) || value.length === 0 || value.length > 1024) return null;
      const columns = [], names = new Set();
      let size = key.length;
      for (const column of value) {
        const name = column?.name, type = column?.type ?? '';
        if (!validName(name, 64) || typeof type !== 'string' || type.length > 512 || type.includes('\0') || names.has(name)) return null;
        names.add(name); size += name.length + type.length + 8;
        if (size > 65536) return null;
        columns.push(Object.freeze({ name, type }));
      }
      return { columns: Object.freeze(columns), characters: size };
    }
    function load(identity, read) {
      if (!Array.isArray(identity) || identity.length !== 3 || !validName(identity[0], 160)
          || !validName(identity[1], 64) || !validName(identity[2], 64) || typeof read !== 'function') return Promise.resolve(empty);
      const key = JSON.stringify(identity), time = now();
      prune(time);
      const cached = ready.get(key);
      if (cached) {
        ready.delete(key); ready.set(key, cached);
        return Promise.resolve(cached.columns);
      }
      if (pending.has(key)) return pending.get(key).promise;
      if (active.size >= 4) return Promise.resolve(empty);
      const entry = { generation };
      active.add(entry);
      pending.set(key, entry);
      entry.promise = Promise.resolve().then(() => entry.generation === generation ? read() : null).then(value => {
        if (entry.generation !== generation) return empty;
        const projected = project(value, key);
        if (!projected) return empty;
        const completedAt = now();
        prune(completedAt);
        while (ready.size >= 64 || characters + projected.characters > 262144) remove(ready.keys().next().value);
        ready.set(key, { ...projected, createdAt: completedAt, expiresAt: completedAt + 60000 });
        characters += projected.characters;
        return projected.columns;
      }).catch(() => empty).finally(() => {
        active.delete(entry);
        if (pending.get(key) === entry) pending.delete(key);
      });
      return entry.promise;
    }
    return Object.freeze({ load,
      clear() { generation++; ready.clear(); pending.clear(); characters = 0; },
      stats() { prune(now()); return Object.freeze({ entries: ready.size, characters, inFlight: active.size }); }
    });
  }

  return Object.freeze({
    SQL_SUGGESTIONS,
    SUGGESTIONS: SQL_SUGGESTIONS,
    extractTableReferences,
    tableScope,
    createColumnCache,
    getContext,
    rankSuggestions
  });
});
