# Code Review Batch 13: G5.6 Diagnostic Dashboard & Server Process Management

## 1. Overview & Scope
Batch 13 implements item **G5.6 (Diagnostic Dashboard & Server Process Management)** from `ROADMAP_PROGRESS.md`:
- **Processlist Explorer**: Filterable real-time process viewer with search, command type filtering (All, Query, Sleep, Slow, Locked), and auto-refresh intervals (Tắt, 3s, 5s, 10s).
- **Safe Kill Protections**: Distinct actions for safe query cancellation (`KILL QUERY <id>`) vs terminating connection (`KILL <id>`), with explicit warnings when targeting self-connections or server system threads.
- **Locks & Transactions Monitor**: Inspects `information_schema.innodb_trx` and detects blocked/blocking locks with automatic branching for MySQL 8.0+ (`performance_schema.data_lock_waits`) and MySQL 5.7 / MariaDB (`information_schema.innodb_lock_waits`).
- **Slow Query Log Inspector**: Reads `mysql.slow_log` safely (read-only) and displays global slow query metrics (`slow_query_log`, `long_query_time`, `Slow_queries`) with helpful setup instructions when disabled.

---

## 2. Design Patterns & Architecture

### 2.1 Pure Module Pattern (UMD)
Created `diagnostics.js` using the Universal Module Definition (UMD) pattern:
- Independent of DOM and Electron environments.
- Directly importable in Node.js test environments (`test/diagnostics.test.cjs`) and browser contexts (`window.Diagnostics`).
- Encapsulates SQL generation, duration formatting, thread classification, and engine version parsing.

### 2.2 Version Branching Strategy
Database engines differ in metadata tables for locks:
- **MySQL 8.0+**: Uses `performance_schema.data_lock_waits` joined with `performance_schema.data_locks`.
- **MySQL 5.7 & MariaDB**: Uses `information_schema.innodb_lock_waits` joined with `information_schema.innodb_locks`.
`Diagnostics.detectServerEngine` and `Diagnostics.getLockWaitersQuery` automatically detect the server type and select the appropriate schema without hardcoding engine assumptions.

### 2.3 Resource & Memory Management
- Auto-refresh timer is registered via `setInterval` and cleanly cancelled on modal `close`.
- Timer automatically pauses when `document.hidden` is true (window minimized or background tab) to avoid unnecessary server load.
- Confirmations for destructive actions (`KILL QUERY` / `KILL`) use `{ separate: true }` so the diagnostic dashboard modal remains intact underneath.

---

## 3. Files Created & Modified

| File | Status | Description |
|---|---|---|
| `diagnostics.js` | Created | Pure UMD module for diagnostic parsing, query building, and safety checks |
| `test/diagnostics.test.cjs` | Created | Unit test suite (8 tests covering duration, thread safety, engine detection, SQL generation) |
| `index.html` | Modified | Loaded `diagnostics.js` before `app.js` |
| `package.json` | Modified | Added `diagnostics.js` to `check` script and packaged files |
| `app.js` | Modified | Transformed `showProcesslistModal()` into a 3-tab Diagnostic Dashboard |
| `style.css` | Modified | Added styling for diagnostic tabs, stat cards, blocker cards, and dark theme |
| `test/renderer-smoke.cjs` | Modified | Added UI tests for diagnostic tab switching, auto-refresh, and safe kill query |

---

## 4. Verification & Test Results
- **Unit Tests**:
  - `node test/diagnostics.test.cjs`: 8/8 passed (0 failed).
  - `node test/query-snippets.test.cjs`: 7/7 passed (0 failed).
- **Core Checks**:
  - `npm run check`: 915 passed, 0 failed, 13 skipped.
  - `npm --prefix server test`: 17/17 passed (0 failed).
  - `node test/run-website-smoke.cjs --no-sandbox`: 14/14 passed (0 failed).
  - `node test/run-renderer-smoke.cjs --no-sandbox`: 90/90 passed (0 failed).
- **Whitespace / Git Diff Check**: 0 issues.
