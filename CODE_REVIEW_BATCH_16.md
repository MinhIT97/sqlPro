# Code Review Batch 16: G8.1 Local Audit Log (Nhật ký thao tác cục bộ)

## 1. Overview & Scope
Batch 16 implements milestone **G8.1 (Local Audit Log / Nhật ký thao tác cục bộ)** from `DATABASE_PRODUCT_ROADMAP.md`:
- **G8.1.1 Canonical Audit Event Structure & Normalization**:
  - Implements canonical schema versioning (`version: 1`), timestamp (`ISO-8601`), application profile metadata (`profileId`, `profileName`), database context (`database`, `table`), action classification (`actionType`), human-readable sanitized summary (`summary`), affected rows count (`affectedRows`), execution duration (`durationMs`), status (`success` vs `error`), and sanitized error details (`errorCode`, `errorSummary`).
  - Action categorization covering: `QUERY` (SELECT/EXPLAIN), `INSERT`, `UPDATE`, `DELETE`, `DDL` (CREATE/ALTER/DROP/TRUNCATE), `EXPORT` (CSV/JSON/SQL), `IMPORT`, `BACKUP`, `RESTORE`, `KILL` (process/query kill), `SCHEMA_DIFF` (migration script execution), and `AUTH`.
- **G8.1.2 Automatic Sensitive Information Scrubbing**:
  - Automatically scrubs credentials, passwords (`IDENTIFIED BY`, `PASSWORD()`, `mat_khau`), API tokens, and secrets from SQL statements and summaries.
  - Does NOT log raw table data, unbounded rows, or secret credentials, strictly adhering to the roadmap specification.
- **G8.1.3 Atomic File Persistence in Electron**:
  - Implemented `electron/audit-log.cjs` with atomic temporary-file writes (`.part` file + `fs.renameSync`).
  - Storage quota enforcement: maximum 2 MB file quota and 1,000 retained entries.
  - Safe error recovery: corrupt or future-version files are preserved for forensics rather than silently clobbered.
- **G8.1.4 Retention Policies & Pruning**:
  - Selective retention pruning by age (e.g. prune entries older than 7, 30, or 90 days).
  - Maximum count bounding with automatic LRU trimming.
- **G8.1.5 RFC-4180 CSV & Formatted JSON Export**:
  - Exports filtered audit logs to standard CSV with headers (`Thời gian`, `Kết nối`, `CSDL`, `Bảng`, `Loại thao tác`, `Tóm tắt`, `Số dòng`, `Thời lượng`, `Trạng thái`, `Mã lỗi`, `Chi tiết lỗi`).
  - Formatted JSON export with metadata and legal disclaimer.
- **G8.1.6 Interactive Audit Log Viewer Modal**:
  - Opens via header button `[data-click="audit-log"]` ("📋 Nhật ký").
  - Prominent compliance disclaimer banner informing users that this is a local client log and does not replace server-side database auditing.
  - Search filter (keyword in summary, table, DB, error code), Action type dropdown filter, Status dropdown filter, and Time range dropdown (Hôm nay, 7 ngày, 30 ngày, Tất cả).
  - One-click actions: "📥 Xuất CSV", "📥 Xuất JSON", "🧹 Dọn >30 ngày", "🗑️ Xóa toàn bộ".
  - Click-to-expand details row revealing entry ID, ISO timestamp, full error traceback, and target IDs.

---

## 2. Design Patterns & Architecture

### 2.1 Pure Module Pattern (UMD)
Created `audit-log.js` using the Universal Module Definition (UMD) pattern:
- Zero DOM, Electron, or external network dependencies.
- Completely isolated and unit-testable in Node.js (`test/audit-log.test.cjs`) and accessible in Electron/Browser (`window.SqlAuditLog`).
- Pure functions: `classifySqlAction`, `sanitizeAuditSummary`, `buildAuditSummary`, `createAuditEntry`, `filterAuditEntries`, `pruneAuditEntries`, `exportAuditCsv`, `exportAuditJson`.

### 2.2 Store Repository Pattern with Atomic Writes
Created `electron/audit-log.cjs` implementing `createAuditLogStore(root)`:
- Mirrored the atomic persistence architecture established in `electron/table-preferences.cjs`.
- Preserves corrupt files on disk without data loss if JSON syntax errors occur.
- Handles IPC commands `audit-log:read`, `audit-log:append`, `audit-log:prune`, `audit-log:clear`.

### 2.3 Transparent Event Interception
Operations across SqlPro seamlessly invoke `recordAudit` without modifying core business workflows:
- `runQuery`: logs queries, execution time, affected rows, and error states.
- `exportCurrentResult`: logs export format and row counts.
- `diagnostics.js` process kill: logs thread ID and kill action.
- `showSchemaDiffModal`: logs migration script execution.

---

## 3. Files Created & Modified

| File | Status | Description |
|---|---|---|
| `audit-log.js` | Created | Pure UMD module for SQL action classification, PII sanitization, entry creation, filtering, pruning, and CSV/JSON export |
| `electron/audit-log.cjs` | Created | Atomic file store repository in `userData` with quota bounding and error preservation |
| `test/audit-log.test.cjs` | Created | Unit test suite (6 tests covering SQL classification, sanitization, entries, filters, pruning, CSV/JSON export) |
| `test/audit-log-store.test.cjs` | Created | Unit test suite (3 tests covering atomic append, age pruning, clear, and corrupt file preservation) |
| `electron/main.cjs` | Modified | Registered `auditLog` repository and IPC handlers (`audit-log:read/append/prune/clear`) |
| `electron/preload.cjs` | Modified | Exposed `auditLog` API methods in `sqlProDesktop` bridge |
| `package.json` | Modified | Registered `audit-log.js` and `electron/audit-log.cjs` in check script and packaged app files |
| `index.html` | Modified | Added `audit-log.js` script tag and `[data-click="audit-log"]` button in header |
| `app.js` | Modified | Implemented `recordAudit()`, `getAuditLogs()`, `showAuditLogModal()`, and integrated query/export/kill audit hooks |
| `style.css` | Modified | Added styles for audit modal, disclaimer banner, filter bar, table, badges, and dark theme |
| `test/renderer-smoke.cjs` | Modified | Added automated UI smoke test verifying modal open, disclaimer banner, search, filter, and close |

---

## 4. Verification & Test Results
- `npm run check`: Passed (syntax checks across all 37 modules, build checks, and all 952 unit tests: 939 pass, 0 fail, 13 skip).
- `node test/audit-log.test.cjs`: Passed (6/6 tests).
- `node test/audit-log-store.test.cjs`: Passed (3/3 tests).
- `node test/run-renderer-smoke.cjs --no-sandbox`: Passed (93/93 tests, including new audit log smoke test).
- `node test/run-website-smoke.cjs --no-sandbox`: Passed (14/14 tests).
- `npm --prefix server test`: Passed (17/17 tests).
- `git diff --check`: Passed with zero whitespace errors.
