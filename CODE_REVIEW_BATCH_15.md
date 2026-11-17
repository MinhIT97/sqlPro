# Code Review Batch 15: G4.5 Smart Data Masking (PII Protection)

## 1. Overview & Scope
Batch 15 implements milestone **G4.5 (Smart Data Masking / PII Protection)** from `DATABASE_PRODUCT_ROADMAP.md`:
- **G4.5.1 Sensitive Field Detection (Heuristic & Multilingual)**: Automatic heuristic identification of sensitive columns for English and Vietnamese nomenclature (emails, phone numbers, credit cards, passwords/secrets/tokens, citizen identification/CCCD/Passport numbers, bank accounts).
- **G4.5.2 Format-Preserving & Obfuscation Masking Strategies**:
  - `maskEmail`: Obfuscates username/local part preserving first/last characters and domain (`j***e@domain.com`, `a***x@company.vn`).
  - `maskPhone`: Preserves prefix and suffix while masking middle digits (`091****678`, `+84 9* *** *567`).
  - `maskCardNumber`: Preserves only the last 4 digits (`**** **** **** 4444`).
  - `maskSecret`: Masks passwords, API secrets, and tokens with uniform asterisks (`********`).
  - `maskIdNumber`: Obfuscates citizen ID, CMND/CCCD, and passport numbers (`001*******56`).
- **G4.5.3 Non-Destructive Presentation Layer**:
  - Masking is strictly applied at render-time in grids and display tables; underlying row snapshots (`app.rows` and `result.rows`) retain full fidelity for row editing, saves, and updates without corrupting data with asterisks.
- **G4.5.4 Export-Safe Masking**:
  - CSV, JSON, and SQL exports sanitize sensitive PII values through `SqlDataMasking.maskRows` when masking mode is enabled, preventing accidental leakage in exported data dumps.
- **G4.5.5 Interactive Controls & State Persistence**:
  - Toolbar toggle button `#maskDataBtn` in table grid and `button[data-click="toggle-mask"]` in query result view.
  - Active visual badge and Vietnamese tooltips ("🎭 Che PII" / "🎭 Đang che PII").
  - Persistent preference stored in `localStorage` across app reloads.

---

## 2. Design Patterns & Architecture

### 2.1 Pure Module Pattern (UMD)
Created `data-masking.js` using the Universal Module Definition (UMD) pattern:
- Zero DOM, Electron, or external dependencies.
- Completely isolated and unit-testable in Node.js (`test/data-masking.test.cjs`) and accessible globally in browser renderer (`window.SqlDataMasking`).
- Pure transformation functions: `maskEmail`, `maskPhone`, `maskCardNumber`, `maskSecret`, `maskIdNumber`, `detectMaskType`, `createMaskingConfig`, `maskRow`, `maskRows`.

### 2.2 Non-Destructive Decorator Pattern
Rather than modifying underlying data models, masking acts as an immutable presentation decorator. Cell renderers pass raw data through `SqlDataMasking.maskRow` only when generating HTML strings. Double-clicking a cell to edit or opening the row editor still loads the genuine value, ensuring no accidental saves of masked values back to the database.

---

## 3. Files Created & Modified

| File | Status | Description |
|---|---|---|
| `data-masking.js` | Created | Pure UMD module with masking algorithms, column detection heuristics, and batch row masking |
| `test/data-masking.test.cjs` | Created | Unit test suite (8 tests covering email, phone, card, secret, ID, heuristics, config, rows) |
| `index.html` | Modified | Added `data-masking.js` script tag and `#maskDataBtn` toggle button in table toolbar |
| `package.json` | Modified | Registered `data-masking.js` in check script and packaged app files |
| `app.js` | Modified | Added masking state persistence, cell rendering integration in `dataGridHtml` & `queryGridBodyHtml`, export masking in `exportCurrentResult`, and delegated toggle handler |
| `style.css` | Modified | Added styles for active masking toggle button states and badges |
| `test/renderer-smoke.cjs` | Modified | Added automated UI smoke test verifying toggle state and masked cell rendering in data and query grids |

---

## 4. Verification & Test Results
- `npm run check`: Passed (syntax checks, build checks, and all 943 unit tests).
- `node test/data-masking.test.cjs`: Passed (8/8 tests).
- `node test/run-renderer-smoke.cjs --no-sandbox`: Passed (92/92 tests, including new smart data masking smoke test).
- `node test/run-website-smoke.cjs --no-sandbox`: Passed (14/14 tests).
- `npm --prefix server test`: Passed (17/17 tests).
- `git diff --check`: Passed with zero whitespace errors.
