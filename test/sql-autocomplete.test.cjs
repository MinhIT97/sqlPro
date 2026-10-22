const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SQL_SUGGESTIONS,
  SUGGESTIONS,
  extractTableReferences,
  getContext,
  rankSuggestions
} = require("../sql-autocomplete.js");

test("exports built-in keyword, function and snippet suggestions", () => {
  assert.equal(SUGGESTIONS, SQL_SUGGESTIONS);
  assert.ok(SQL_SUGGESTIONS.some((item) => item.label === "SELECT" && item.type === "keyword"));
  assert.ok(SQL_SUGGESTIONS.some((item) => item.label === "COUNT()" && item.type === "function"));
  assert.ok(SQL_SUGGESTIONS.some((item) => item.type === "snippet"));
  assert.ok(SQL_SUGGESTIONS.every((item) => item.label && item.insertText && item.type && item.detail));
});

test("getContext selects the statement around the caret", () => {
  const sql = "SELECT 'first;value' FROM logs;\nSELECT us FROM users u;\nSELECT 3";
  const caret = sql.indexOf("us FROM") + 2;
  const context = getContext(sql, caret);

  assert.equal(context.disabled, false);
  assert.equal(context.prefix, "us");
  assert.equal(context.qualifier, null);
  assert.equal(context.start, caret - 2);
  assert.equal(context.end, caret);
  assert.equal(context.statement.trim(), "SELECT us FROM users u");
  assert.deepEqual(context.references, [{ table: "users", alias: "u" }]);
});

test("semicolons in strings, quoted identifiers and comments do not change the current statement", () => {
  const sql = [
    "SELECT ';' AS value, `odd;name` FROM alpha;",
    "/* ignored ; delimiter */ SELECT be FROM beta b # another ; delimiter",
    "WHERE b.id = 1"
  ].join("\n");
  const caret = sql.indexOf("be FROM") + 2;
  const context = getContext(sql, caret);

  assert.equal(context.prefix, "be");
  assert.equal(context.statement.trim().startsWith("/* ignored ; delimiter */ SELECT be"), true);
  assert.deepEqual(context.references, [{ table: "beta", alias: "b" }]);
});

test("autocomplete is disabled while the caret is in a string or comment", () => {
  const inString = "SELECT 'hello world' FROM users";
  const inDashComment = "SELECT * -- user note\nFROM users";
  const inHashComment = "SELECT * # user note\nFROM users";
  const inBlockComment = "SELECT /* user note */ * FROM users";

  assert.equal(getContext(inString, inString.indexOf("world") + 2).disabled, true);
  assert.equal(getContext(inDashComment, inDashComment.indexOf("note") + 2).disabled, true);
  assert.equal(getContext(inHashComment, inHashComment.indexOf("note") + 2).disabled, true);
  assert.equal(getContext(inBlockComment, inBlockComment.indexOf("note") + 2).disabled, true);
  assert.equal(getContext(inDashComment, inDashComment.indexOf("FROM") + 2).disabled, false);
});

test("MySQL double dash comments require whitespace after the second dash", () => {
  const arithmetic = "SELECT 3--2; SELECT nex FROM next_table";
  const caret = arithmetic.indexOf("nex FROM") + 3;
  const context = getContext(arithmetic, caret);

  assert.equal(context.prefix, "nex");
  assert.equal(context.statement.trim(), "SELECT nex FROM next_table");
});

test("getContext recognizes a qualifier and returns an absolute replacement range", () => {
  const sql = "SELECT u.na FROM app.users AS u WHERE u.id > 0";
  const caret = sql.indexOf("u.na") + 4;
  const context = getContext(sql, caret);

  assert.equal(context.qualifier, "u");
  assert.equal(context.prefix, "na");
  assert.equal(sql.slice(context.start, context.end), "na");
  assert.deepEqual(context.references, [{ database: "app", table: "users", alias: "u" }]);
});

test("extractTableReferences supports joins, aliases and backtick quoting", () => {
  const sql = [
    "SELECT u.id, m.body",
    "FROM `app-db`.`users` AS u",
    "LEFT JOIN `messages` m ON m.user_id = u.id",
    "JOIN ignored i ON i.id = 1 /* JOIN secret_table s ON true */",
    "WHERE u.name <> 'JOIN fake_table f'"
  ].join("\n");

  assert.deepEqual(extractTableReferences(sql), [
    { database: "app-db", table: "users", alias: "u" },
    { table: "messages", alias: "m" },
    { table: "ignored", alias: "i" }
  ]);
});

test("reserved clauses are not mistaken for aliases", () => {
  assert.deepEqual(extractTableReferences("SELECT * FROM users WHERE active = 1"), [{ table: "users" }]);
  assert.deepEqual(extractTableReferences("UPDATE users SET active = 1"), [{ table: "users" }]);
  assert.deepEqual(extractTableReferences("INSERT INTO users VALUES (1)"), [{ table: "users" }]);
});

test("rankSuggestions ranks exact and prefix matches, removes duplicates and applies a limit", () => {
  const items = [
    { label: "messages", insertText: "messages", type: "table" },
    { label: "SELECT", insertText: "SELECT", type: "keyword" },
    { label: "selection_count", insertText: "selection_count", type: "column" },
    { label: "SELECT duplicate", insertText: "SELECT", type: "keyword" },
    { label: "last_selected", insertText: "last_selected", type: "column" }
  ];

  const ranked = rankSuggestions(items, "select", 3);
  assert.deepEqual(ranked.map((item) => item.label), ["SELECT", "selection_count", "last_selected"]);
});

test("rankSuggestions accepts string items and omits unrelated matches", () => {
  assert.deepEqual(rankSuggestions(["SELECT", "FROM", "SET"], "se", 10), ["SELECT", "SET"]);
});
