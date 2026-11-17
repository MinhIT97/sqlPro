# Code Review Batch 17: G7 Data Diff & Table Synchronization (So sánh & Đồng bộ dữ liệu bảng)

## 1. Overview & Scope
Batch 17 implements milestone **G7 (Table Data Diff & Synchronization)** from `DATABASE_PRODUCT_ROADMAP.md`:
- **G7.1 Key-Based Table Data Comparison**:
  - Requires valid Primary Key (PK) or Unique Key (UNI) for unique row identification and matching across tables.
  - Supports composite primary keys with canonical composite key extraction (`extractRowKey`).
  - Limits chunk scanning with user-configurable limits (200, 500, 1000, 2000 rows) to avoid unconstrained RAM usage.
- **G7.2 Strict Canonical Value Equality (`compareCanonicalValues`)**:
  - Explicit distinction between `NULL` and empty strings `""`, `0`, or `'NULL'`.
  - Type-aware normalization:
    - Boolean / Tinyint(1): `true`, `1`, `'1'` vs `false`, `0`, `'0'`.
    - Numeric: BigInt, Decimal, Integer string representations compared with numeric precision.
    - Dates / Timestamps: Normalized ISO string formats (with `T`/`Z` vs spaces).
    - JSON: Deep canonical key sorting and equality comparison.
- **G7.3 Full Categorization & Metrics**:
  - Categorizes records into:
    - `identical`: rows identical across all columns.
    - `different`: rows with matching PK but differences in one or more non-PK columns, capturing exact column differences (`column`, `sourceValue`, `targetValue`).
    - `onlyInSource`: rows present in Source but missing in Target (to be added via INSERT).
    - `onlyInTarget`: rows present in Target but deleted in Source (extra in Target).
  - Summary metrics: `identicalCount`, `differentCount`, `onlyInSourceCount`, `onlyInTargetCount`.
- **G7.4 Safe Synchronization SQL Generator (`generateSyncSql`)**:
  - Generates parameterized DDL/DML statements:
    - `INSERT INTO target (columns) VALUES (...)` for missing rows.
    - `UPDATE target SET col = val WHERE pk = ...` for modified rows (updating only changed columns).
    - `DELETE FROM target WHERE pk = ...` for extra rows with an explicit safety gate (`includeDeletes: false` by default).
  - Severity tagging: `safe` for INSERT, `warning` for UPDATE, `destructive` for DELETE.
- **G7.5 Interactive 4-Tab Modal UI in `app.js` (`showDataDiffModal`)**:
  - Header button `[data-click="data-diff"]` ("⚖️ Data Diff") in top navigation.
  - Cross-Database and Cross-Connection profile support (Local vs Staging vs Prod).
  - Side-by-side color-coded differences table (Green for Source values, Red for Target values) with Smart Data Masking integration for PII columns.
  - Actions: "📋 Sao chép SQL", "💾 Tải file .sql", "▷ Mở trong SQL Editor" (with target database context), and "⚡ Thực thi vào Đích" with confirmation dialog and automatic audit logging via `recordAudit`.

---

## 2. Design Patterns & Architecture

### 2.1 Pure Module Pattern (UMD)
Created `data-diff.js` using the Universal Module Definition (UMD) pattern:
- Zero DOM, Electron, or external network dependencies.
- Completely isolated and unit-testable in Node.js (`test/data-diff.test.cjs`) and accessible in Electron/Browser (`window.SqlDataDiff`).
- Pure functions: `compareCanonicalValues`, `extractRowKey`, `compareTableData`, `generateSyncSql`, `formatSqlValue`.

### 2.2 Safety Guard Pattern
Destructive data modification operations (`DELETE FROM target`) are disabled by default. The user must explicitly check the safety checkbox `⚠️ Xóa dòng thừa (DELETE)` to include deletions in the generated sync script.

### 2.3 Presentation Layer Integration with Data Masking & Audit Logging
- When `app.maskData` is active, sensitive columns in the side-by-side comparison grid are automatically obfuscated with asterisks using `SqlDataMasking`.
- When sync scripts are executed, an immutable audit event is recorded through `recordAudit()` with operation summary, affected row counts, and status.

---

## 3. Files Created & Modified

| File | Status | Description |
|---|---|---|
| `data-diff.js` | Created | Pure UMD module for canonical value comparison, row key extraction, table data diffing, and synchronization SQL generation |
| `test/data-diff.test.cjs` | Created | Unit test suite (5 tests covering canonical types, composite keys, diff categorization, sync scripts, and safety gates) |
| `index.html` | Modified | Added `data-diff.js` script tag and `[data-click="data-diff"]` button in header |
| `package.json` | Modified | Registered `data-diff.js` in check script and packaged app files |
| `app.js` | Modified | Implemented `showDataDiffModal()` with 4 tabs, profile/table introspection, side-by-side viewer, sync execution, and audit logging |
| `style.css` | Modified | Added responsive styles for data diff card, side-by-side comparison table, source/target badges, and dark theme |
| `test/renderer-smoke.cjs` | Modified | Added automated UI smoke test verifying modal open, table selectors, and tab switching |

---

## 4. Verification & Test Results
- `npm run check`: Passed (syntax checks across all 38 modules, build checks, and all 957 unit tests: 944 pass, 0 fail, 13 skip).
- `node test/data-diff.test.cjs`: Passed (5/5 tests).
- `node test/run-renderer-smoke.cjs --no-sandbox`: Passed (94/94 tests, including new data diff smoke test).
- `node test/run-website-smoke.cjs --no-sandbox`: Passed (14/14 tests).
- `npm --prefix server test`: Passed (17/17 tests).
- `git diff --check`: Passed with zero whitespace errors.
