# Code Review Batch 19: G1.2 Read-Only Connection Enforcement & Safety Gate

## 1. Overview & Scope
Batch 19 implements milestone **G1.2 (Strict Read-Only Connection Enforcement & Comprehensive Safety Gate)** from `DATABASE_PRODUCT_ROADMAP.md`:
- **G1.2.1 Conservative SQL Policy Tokenizer & Parser Enhancement**:
  - Full support for Common Table Expressions (CTE) with explicit column lists (`WITH [RECURSIVE] cte_name(col1, col2) AS (SELECT ...) SELECT ...`), rigorously validated via `isCteColumnList` to distinguish CTE definitions from unsafe function calls.
  - Extended standard SQL syntax support for read queries: `JOIN (SELECT ...)`, `LEFT JOIN (SELECT ...)`, `STRAIGHT_JOIN (SELECT ...)`, `CASE WHEN (cond) THEN (val) ELSE (other) END`, `WHERE col BETWEEN (min) AND (max)`, `LIKE (pattern)`.
  - Comprehensive inspection metadata support for `SHOW` queries: `SHOW TABLE STATUS`, `SHOW PROCEDURE STATUS`, `SHOW FUNCTION STATUS`, `SHOW TRIGGERS`, `SHOW EVENTS`, `SHOW OPEN TABLES`, `SHOW PLUGINS`, `SHOW PRIVILEGES`, `SHOW PROFILES`, `SHOW SLAVE/REPLICA STATUS`.
  - Expanded `SAFE_FUNCTIONS` set with safe MySQL/MariaDB deterministic read-only functions: `NOW`, `LOCALTIME`, `LOCALTIMESTAMP`, `SYSDATE`, `LAST_DAY`, `JSON_ARRAYAGG`, `JSON_PRETTY`, `ASCII`, `BIT_COUNT`, `DEGREES`, `MAKEDATE`, `MAKETIME`, `PERIOD_ADD`, `PERIOD_DIFF`, `SEC_TO_TIME`, `STD`, `STDDEV`, `VAR_POP`, `VARIANCE`, `YEARWEEK`, etc.
  - Strict preservation of security boundaries: all unclassified statements, executable comments (`/*!`, `/*M!`, `/*+`), unterminated/nested comments, and mutation keywords (`INSERT`, `UPDATE`, `DELETE`, `REPLACE`, `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `CALL`, `DO`, `SET`, `KILL`, `LOCK`, `INTO OUTFILE/DUMPFILE`, `FOR UPDATE`) fail closed with `READ_ONLY_SQL_UNSUPPORTED` or `CONNECTION_READ_ONLY`.
- **G1.2.2 End-to-End Safety Gate on All Write Pathways**:
  - **DatabaseSession backend**: `insertRow`, `updateRow`, `deleteRows`, `importFile`, `restoreDatabase`, `analyzeQuery`, `cleanupTrialDatabases` all guarded by `assertWritable(this.profile)`.
  - **Table Grid & Query Grid UI**:
    - Disables and rejects direct inline cell editing (`inlineEditCell`, `inlineEditQueryResultCell`), pasting (`pasteQueryResultCell`), setting null/empty (`setQueryResultCellValue`), and row deletion (`deleteSelectedRows`, `deleteQueryResultRows`).
    - Disables mutate items in query grid context menu (`contextMenu`).
  - **Schema Diff modal**:
    - `#diffApplyTargetBtn` disabled with clear lock notice (`🔒 CSDL Đích Chỉ Đọc`) when target connection is read-only.
    - Click event listener enforces read-only check with friendly Vietnamese toast error.
  - **Data Diff modal**:
    - `#syncApplyBtn` disabled with red warning (`🔒 CSDL Đích chỉ đọc — áp dụng trực tiếp bị khóa`) when target connection is read-only.
    - Click event listener enforces read-only check with friendly Vietnamese toast error.
  - **Database & Backup Restore modals**:
    - `#restoreGo`, `#pasteGoBtn`, `#copyGoBtn` disabled or guarded with clear security notices when target connection is read-only.
  - **Connection Modal & User Guidance**:
    - Clear explanatory note: *"Nên dùng tài khoản database chỉ có quyền đọc. Cú pháp/hàm chưa được hỗ trợ sẽ bị chặn; quyền database bảo vệ cả tác động gián tiếp từ view/routine."* (conservative application guard supplements DB privileges; least-privilege DB account is the true boundary).

---

## 2. Files Modified

| File | Status | Description |
|---|---|---|
| `electron/connection-policy.cjs` | Modified | Added `isCteColumnList`, expanded `PAREN_SYNTAX`, `SAFE_FUNCTIONS`, and `SHOW` metadata patterns |
| `test/connection-policy.test.cjs` | Modified | Added 2 comprehensive test suites for CTEs, recursive CTEs, JOIN subqueries, CASE WHEN, SHOW metadata, and mutation blocking |
| `app.js` | Modified | Added read-only guards and visual indicators to cell editing, context menu, Schema Diff, Data Diff, and Restore modals |
| `DATABASE_PRODUCT_ROADMAP.md` | Modified | Marked milestone G1.2 as completed `[x]` |
| `ROADMAP_PROGRESS.md` | Modified | Documented Batch 19 implementation details |
| `agent.md` | Modified | Documented `electron/connection-policy.cjs` architectural role and design pattern |

---

## 3. Verification & Test Results
- `npm run check`: **Passed** (959 tests: 946 pass, 0 fail, 13 skip).
- `node --test test/connection-policy.test.cjs`: **Passed** (7/7 tests pass).
- `node test/run-renderer-smoke.cjs --no-sandbox`: **Passed** (94/94 tests).
- `node test/run-website-smoke.cjs --no-sandbox`: **Passed** (14/14 tests).
- `npm --prefix server test`: **Passed** (17/17 tests).
- `git diff --check`: **Passed** with 0 whitespace errors.
