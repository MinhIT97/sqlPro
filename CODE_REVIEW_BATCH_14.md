# Code Review Batch 14: G6 Schema Diff & Migration Synchronization

## 1. Overview & Scope
Batch 14 implements milestone **G6 (Schema Comparison & Migration Synchronization)** from `DATABASE_PRODUCT_ROADMAP.md`:
- **G6.1 Schema Snapshot Normalization**: Canonical structural snapshot capturing tables (columns, data types, nullability, default values, extra/auto_increment, collations, comments), indexes (primary, unique, type, column sequences), foreign keys (referencing and referenced tables and columns, CASCADE/SET NULL/RESTRICT actions), views, and routines.
- **G6.2 Deep Structural Schema Comparison**: Compares desired source schema against existing target schema, categorizing differences into `added`, `modified`, and `dropped` with multi-tier risk tagging (`safe`, `warning`, `destructive`).
- **G6.3 Topologically-Ordered Migration Script Generator**: Generates executable DDL statements in strictly ordered phases:
  1. Drop foreign keys on tables being modified or dropped.
  2. Create new tables without foreign keys (preventing circular reference deadlocks).
  3. Alter existing tables: add columns, modify column types/nullability, drop removed columns (opt-in safety gate).
  4. Create/drop indexes.
  5. Add foreign key constraints (once all parent tables and referenced columns exist).
  6. Create/alter views and stored routines.
  7. Drop removed tables (opt-in safety gate).
- **G6.4 Safe Execution & Interactive UI**:
  - Modal with 5 tabs: Cấu hình (Config), Tổng quan (Summary), Bảng & Cột (Tables), Chỉ mục & FK (Indexes), and Mã Migration SQL (Script).
  - Dual-selector for comparing across different databases on the same host or between different connection profiles (e.g. Local vs Staging vs Production).
  - Safety toggles: DROP TABLE / DROP COLUMN disabled by default to prevent accidental data loss.
  - One-click actions: "📋 Sao chép", "💾 Tải file .sql", "▷ Mở trong SQL Editor" (with target context), and "⚡ Thực thi vào Đích" (with explicit confirmation).

---

## 2. Design Patterns & Architecture

### 2.1 Pure Module Pattern (UMD)
Created `schema-diff.js` using the Universal Module Definition (UMD) pattern:
- Zero DOM, Electron, or network dependencies.
- Completely isolated and unit-testable in Node.js (`test/schema-diff.test.cjs`) and usable in browser renderer (`window.SchemaDiff`).
- Pure functions: `normalizeSchemaSnapshot`, `compareSchemas`, `generateMigrationSql`, `formatMigrationScript`.

### 2.2 Topological Execution Order Pattern
Schema migrations frequently fail due to dependency order issues (e.g. trying to add a foreign key to a table before the referenced table exists, or modifying a column that is part of a foreign key). `generateMigrationSql` guarantees correct multi-phase ordering to prevent MySQL/MariaDB DDL constraint violations.

### 2.3 Safe Execution & Destruction Guards
Destructive DDL operations (dropping tables, dropping columns) are tagged with `severity: 'destructive'` and disabled (`enabled: false`) by default unless the user explicitly checks the opt-in permission checkbox.

---

## 3. Files Created & Modified

| File | Status | Description |
|---|---|---|
| `schema-diff.js` | Created | Pure UMD module for schema normalization, deep comparison, and topological migration generation |
| `test/schema-diff.test.cjs` | Created | Comprehensive unit test suite (7 tests covering snapshots, diffs, ordering, formatting) |
| `index.html` | Modified | Added `schema-diff.js` script tag and "🔄 Schema Diff" header action button |
| `package.json` | Modified | Registered `schema-diff.js` in check script and packaged app files |
| `app.js` | Modified | Implemented `showSchemaDiffModal()`, schema introspection, and click event handler |
| `style.css` | Modified | Responsive styling for schema diff card, compare grid, stat cards, and dark theme |
| `test/renderer-smoke.cjs` | Modified | Added automated UI smoke test verifying modal open, profile selectors, and tab navigation |

---

## 4. Verification & Test Results
- **Unit Tests**:
  - `node test/schema-diff.test.cjs`: 7/7 passed (0 failed).
  - `node test/diagnostics.test.cjs`: 8/8 passed (0 failed).
  - `node test/query-snippets.test.cjs`: 7/7 passed (0 failed).
- **Core Checks**:
  - `npm run check`: 922 passed, 0 failed, 13 skipped.
  - `npm --prefix server test`: 17/17 passed (0 failed).
  - `node test/run-website-smoke.cjs --no-sandbox`: 14/14 passed (0 failed).
  - `node test/run-renderer-smoke.cjs --no-sandbox`: 91/91 passed (0 failed).
- **Whitespace / Git Diff Check**: 0 issues.
