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

  function unquoteIdentifier(value) {
    const identifier = String(value || "").trim();
    if (identifier.startsWith("`") && identifier.endsWith("`") && identifier.length >= 2) {
      return identifier.slice(1, -1).replace(/``/g, "`");
    }
    return identifier;
  }

  function extractTableReferences(statement) {
    const sql = String(statement || "");
    const { code } = scanSql(sql);
    const identifier = "(?:`(?:``|[^`])+`|[A-Za-z_$][\\w$]*)";
    const qualified = `(${identifier})(?:\\s*\\.\\s*(${identifier}))?`;
    const pattern = new RegExp(`\\b(FROM|JOIN|UPDATE|INTO)\\s+${qualified}(?:\\s+(?:AS\\s+)?(${identifier}))?`, "gi");
    const references = [];
    let match;

    while ((match = pattern.exec(code))) {
      const first = unquoteIdentifier(match[2]);
      const second = match[3] ? unquoteIdentifier(match[3]) : "";
      let alias = match[4] ? unquoteIdentifier(match[4]) : "";

      if (alias && ALIAS_STOP_WORDS.has(alias.toUpperCase())) {
        alias = "";
      }

      references.push({
        table: second || first,
        ...(second ? { database: first } : {}),
        ...(alias ? { alias } : {})
      });
    }

    return references;
  }

  function identifierContext(beforeCaret, absoluteCaret) {
    const qualified = beforeCaret.match(/(?:`((?:``|[^`])*)`|([A-Za-z_$][\w$]*))\s*\.\s*(?:`([^`]*)|([A-Za-z_$][\w$]*))?$/);
    if (qualified) {
      const qualifier = (qualified[1] || qualified[2] || "").replace(/``/g, "`");
      const prefix = (qualified[3] || qualified[4] || "").replace(/``/g, "`");
      const rawPrefix = qualified[3] !== undefined ? `\`${qualified[3]}` : (qualified[4] || "");
      return {
        prefix,
        qualifier,
        start: absoluteCaret - rawPrefix.length,
        end: absoluteCaret
      };
    }

    const unclosedBacktick = beforeCaret.match(/`([^`]*)$/);
    if (unclosedBacktick) {
      return {
        prefix: unclosedBacktick[1].replace(/``/g, "`"),
        qualifier: null,
        start: absoluteCaret - unclosedBacktick[0].length,
        end: absoluteCaret
      };
    }

    const plain = beforeCaret.match(/[A-Za-z_$][\w$]*$/);
    const prefix = plain ? plain[0] : "";
    return {
      prefix,
      qualifier: null,
      start: absoluteCaret - prefix.length,
      end: absoluteCaret
    };
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
    const token = identifierContext(sql.slice(statementStart, caret), caret);

    return {
      disabled: blocked,
      start: token.start,
      end: token.end,
      prefix: token.prefix,
      qualifier: token.qualifier,
      statement,
      statementStart,
      statementEnd,
      references: extractTableReferences(statement)
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
        const key = `${insertText}\u0000${item && item.type ? item.type : ""}`.toLocaleLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, maximum)
      .map((entry) => entry.item);
  }

  return Object.freeze({
    SQL_SUGGESTIONS,
    SUGGESTIONS: SQL_SUGGESTIONS,
    extractTableReferences,
    getContext,
    rankSuggestions
  });
});
