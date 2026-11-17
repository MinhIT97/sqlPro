# Báo cáo Baseline và Kiểm kê An toàn SqlPro (Gói B00)

**Mốc đối chiếu:** Commit `f812fc1` (`f812fc179a32c25a07c1341d24c0429bfef10808`)\
**Phiên bản package:** `0.3.12`\
**Ngày thực hiện:** 17/11/2026\
**Mục tiêu:** Chốt hồ sơ baseline kỹ thuật, kiểm kê toàn diện các kênh IPC ghi, rà soát fixtures/markers, và chuẩn hóa hợp đồng dữ liệu/tác vụ nền theo yêu cầu G0.1–G0.4 trong `DATABASE_PRODUCT_ROADMAP.md` và `GEMINI_IMPLEMENTATION_HANDOFF.md`.

---

## 1. Môi trường Thực thi & Cấu hình Runtime

| Thành phần | Giá trị thực tế quan sát được | Ghi chú kiểm chứng |
| --- | --- | --- |
| **Commit Git** | `f812fc1` (`HEAD -> master`) | Trùng khớp mốc f812fc1 tại handoff |
| **Trạng thái Dirty** | `0` file tracked bị sửa đổi; `1` file untracked | `GEMINI_IMPLEMENTATION_HANDOFF.md` là tài liệu chỉ đạo mới |
| **Hệ điều hành** | Ubuntu 24.04.5 LTS (Noble Numbat) | Kernel Linux `7.0.0-43-generic #43~24.04.1-Ubuntu x86_64` |
| **Node.js** | `v22.22.3` | Thỏa mãn ràng buộc `engines.node >=22.12.0` |
| **Electron** | `45.0.0` | Khai báo trong `node_modules/electron/package.json` |
| **Electron Builder** | `26.17.0` | Phục vụ đóng gói Linux AppImage/deb và Windows NSIS/portable |
| **Cơ sở dữ liệu hỗ trợ** | MySQL 5.7, 8.0, 8.4 LTS; MariaDB 10.3+, 11.4 LTS | Phân nhánh cú pháp/information_schema trong `diagnostics.js`, `connection-policy.cjs`, `database.cjs` |
| **Phạm vi mã nguồn** | Không có thay đổi runtime trong gói B00 | Giữ nguyên 100% logic mã nguồn, chỉ tài liệu hóa và đối chiếu code thật |

---

## 2. Kết quả Chạy Kiểm thử Toàn diện tại Baseline

Tất cả các lệnh kiểm thử tiêu chuẩn đã được thực thi trực tiếp trên hệ thống tại commit `f812fc1`:

```bash
# 1. Cú pháp và Unit/Contract tests
npm run check
# Kết quả: 974 tests | 960 pass | 0 fail | 14 skip | Thời gian: ~5.2s

# 2. Renderer Smoke (Electron UI / IPC / Shortcuts / Dialogs)
node test/run-renderer-smoke.cjs --no-sandbox
# Kết quả: 100/100 passed | Thời gian: ~35s (Cần --no-sandbox trong container Linux không có SUID sandbox)

# 3. Website Smoke (Web pages / Localization / Fallbacks)
node test/run-website-smoke.cjs --no-sandbox
# Kết quả: 14/14 passed | Thời gian: ~12s

# 4. Server Syntax Check & Test Suite
npm --prefix server run check
npm run server:test
# Kết quả: 17/17 passed (SQLite auth, vault E2EE sync, rate limiter, async gate)

# 5. Git Diff Formatting
git diff --check
# Kết quả: 0 cảnh báo, 0 lỗi định dạng
```

### Bảng phân loại chi tiết 14 ca kiểm thử bị bỏ qua (Skip)

Tất cả 14 ca test bị skip trong `npm test` đều là các bài kiểm thử tích hợp trực tiếp với cơ sở dữ liệu thật (Real-Database Integration Tests), được thiết kế theo cơ chế opt-in có chủ đích thông qua biến môi trường để không gây ảnh hưởng đến database người dùng hoặc khi chưa dựng container tmpfs độc lập:

| STT | Tệp kiểm thử | Biến môi trường kích hoạt | Mục tiêu kiểm thử |
| --- | --- | --- | --- |
| 1 | `test/data-diff-integration.test.cjs` | `SQLPRO_DATA_DIFF_PORT` | Kiểm thử so sánh dữ liệu bảng thật (DECIMAL 40,6, JSON lớn, DATETIME microsecond, composite PK collision) |
| 2 | `test/explain-formats-integration.test.cjs` | `SQLPRO_TEST_EXPLAIN_PORT` | Kiểm thử EXPLAIN DEFAULT/JSON/TREE trên MySQL 8.0+ và MariaDB |
| 3 | `test/index-visibility-integration.test.cjs` | `SQLPRO_TEST_INDEX_PORT` | Kiểm thử trạng thái index visible/invisible (MySQL) và ignored (MariaDB) |
| 4 | `test/mysql-integration.test.cjs` | `SQLPRO_TEST_MYSQL_PORT` | Bộ kiểm thử hồi quy 33/33 kịch bản: session, locks, transactions, prepared statements, NO_BACKSLASH_ESCAPES, sandbox trial |
| 5 | `test/selection-checks-integration.test.cjs` | `SQLPRO_TEST_CHECKS_PORT` | Kiểm tra ràng buộc CHECK metadata và trạng thái session check_constraint_checks |
| 6 | `test/selection-engines-integration.test.cjs` | `SQLPRO_TEST_ENGINE_PORT` | Kiểm tra phát hiện engine bảng (InnoDB vs MyISAM/MEMORY) |
| 7 | `test/selection-omitted-integration.test.cjs` | `SQLPRO_TEST_OMITTED_PORT` | Kiểm tra đối chiếu các cột bị bỏ qua trong INSERT và giá trị mặc định |
| 8 | `test/selection-packets-integration.test.cjs` | `SQLPRO_TEST_PACKET_PORT` | Kiểm tra giới hạn kích thước gói mạng @@SESSION.max_allowed_packet |
| 9 | `test/selection-session-policy-integration.test.cjs` | `SQLPRO_TEST_SESSION_PORT` | Kiểm tra trích xuất và đối chiếu cờ phiên: FOREIGN_KEY_CHECKS, UNIQUE_CHECKS, SQL_MODE |
| 10 | `test/selection-temporal-integration.test.cjs` | `SQLPRO_TEST_TEMPORAL_PORT` | Kiểm tra kiểu ngày giờ DATE/DATETIME/TIME/TIMESTAMP và múi giờ |
| 11 | `test/selection-text-integration.test.cjs` | `SQLPRO_TEST_TEXT_PORT` | Kiểm tra literal chuỗi, mã hóa UTF8MB4, ký tự Unicode và trailing spaces |
| 12 | `test/selection-values-integration.test.cjs` | `SQLPRO_TEST_VALUE_PORT` | Kiểm tra giá trị kiểu số, BIGINT, phạm vi 10-bit range mask |
| 13 | `test/table-search-integration.test.cjs` | `SQLPRO_TABLE_SEARCH_PORT` | Kiểm tra tìm kiếm prefix, NULL, escape wildcard `%`/`_` trên server thật |
| 14 | `test/target-foreign-keys-integration.test.cjs` | `SQLPRO_TEST_FK_PORT` | Kiểm tra trích xuất và đối chiếu ràng buộc khóa ngoại đích từ KCU/RC |

---

## 3. Bảng Kiểm Kê Toàn Diện Các Kênh IPC Ghi (IPC Write Inventory)

Mọi thao tác có khả năng làm thay đổi trạng thái (Database, Filesystem, Cấu hình, Nhật ký, Đồng bộ) được rà soát và đối chiếu trực tiếp từ `electron/preload.cjs` và `electron/main.cjs`:

| Kênh IPC | Thao tác | Read-Only Policy Gate | Production Safety Gate | Lease & Quản lý Phiên | Timeout & Hủy bỏ | Original-Value / Conflict Guard | Ghi Audit Log | Fixture / Test hiện có |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `db:query` | Thực thi SQL tùy ý / Batch DDL/DML | Chặn nếu SQL chứa mutating keyword (`assertReadOnlySql`) | `withWriteReview`: phân tích rủi ro cú pháp (`analyzeProductionSqlRisks`), cảnh báo DROP/TRUNCATE/unconditional, bắt buộc token xác nhận | `sessionRegistry.acquire`, kiểm tra `session.activeTask` | Tham số `timeoutMs` (1–900s, mặc định 300s), hủy qua `cancelTask` / KILL QUERY | Tuần tự hóa statement; dừng khi gặp lỗi đầu tiên | Ghi qua `recordAudit` tại `app.js` với `classifySqlAction` | `connection-policy.test.cjs`, `table-data-sql.test.cjs`, `renderer-smoke.cjs` |
| `db:analyze-query` | Thực thi SELECT thực tế để đo plan | `checkConnectionPolicy` (`assertWritable`) | Hộp thoại cảnh báo native `showMessageBox` về tác động CPU/IO/khóa | `withSessionFor` với `{ exclusive: true }`, kiểm tra `transactionRevision` | `timeoutMs` (1–60s, mặc định 30s), kiểm tra task cancel | N/A (chỉ đọc dữ liệu nhưng giữ shared lock) | Không ghi (truy vấn phân tích) | `explain-formats-integration.test.cjs`, `renderer-smoke.cjs` |
| `db:insert-row` | Thêm dòng mới vào bảng | `assertWritable` trên connection profile | `withWriteReview`: sinh preview dòng thêm, bắt buộc xác nhận trên Production | `withSessionFor` + lease | Timeout theo session | Sử dụng prepared statements (`prepared: true`) | Ghi qua `recordAudit` (`actionType: 'INSERT'`) | `table-data-sql.test.cjs`, `mysql-integration.test.cjs`, `renderer-smoke.cjs` |
| `db:update-row` | Sửa giá trị ô/dòng trong bảng | `assertWritable` trên connection profile | `withWriteReview`: sinh preview thay đổi, bắt buộc xác nhận trên Production | `withSessionFor` + lease | Timeout theo session | Khóa bản ghi `SELECT ... FOR UPDATE`, đối chiếu mã băm dòng gốc `rowOriginalHashes`, từ chối nếu bị drift | Ghi qua `recordAudit` (`actionType: 'UPDATE'`) | `table-data-sql.test.cjs`, `mysql-integration.test.cjs`, `renderer-smoke.cjs` |
| `db:delete-rows` | Xóa một hoặc nhiều dòng theo PK | `assertWritable` trên connection profile | `withWriteReview`: cảnh báo số dòng xóa, bắt buộc xác nhận trên Production | `withSessionFor` + lease | Timeout theo session | Kiểm tra engine, khóa dòng gốc trước khi DELETE; xác minh số dòng bị ảnh hưởng | Ghi qua `recordAudit` (`actionType: 'DELETE'`) | `table-data-sql.test.cjs`, `mysql-integration.test.cjs`, `renderer-smoke.cjs` |
| `db:import-file` | Nhập dữ liệu CSV/JSON/TSV hàng loạt | `assertWritable` trên connection profile | `confirmProductionTransfer`: hộp thoại native, hiển thị đường dẫn, dung lượng và định dạng | Độc quyền: `claimDatabaseTransfer` (`activeDatabaseTransfer`) | Timeout theo batch (300s/batch) | Batch prepared statements, ON DUPLICATE KEY UPDATE | Ghi qua `recordAudit` (`actionType: 'IMPORT'`) | `mysql-integration.test.cjs`, `renderer-smoke.cjs` |
| `db:transaction` | Bắt đầu, Commit hoặc Rollback | Chặn Commit nếu kết nối ở chế độ chỉ đọc | Preview hộp thoại giải thích Commit áp dụng cho toàn bộ các tab của phiên | Kiểm tra `activeTask` và lease; bảo vệ phiên bận | Hủy/rollback khi ngắt kết nối hoặc lỗi mạng | Theo dõi `transactionRevision` và `autocommit` state | Ghi qua `recordAudit` | `session-registry.test.cjs`, `renderer-smoke.cjs` |
| `db:backup` | Tạo bản sao lưu CSDL (InnoDB snapshot) | Không (đọc CSDL), nhưng ghi tệp catalog local | N/A (thao tác đọc CSDL nguồn) | Độc quyền: `claimDatabaseTransfer` | Hủy qua `cancelDatabaseTransfer` | Snapshot nhất quán `START TRANSACTION WITH CONSISTENT SNAPSHOT`, ghi tệp tạm `.part` + SHA-256 + atomic hard-link/rename | Ghi vào Backup Catalog và Audit Log | `backup-file.test.cjs`, `backup-catalog.test.cjs`, `renderer-smoke.cjs` |
| `db:restore` | Phục hồi toàn bộ CSDL từ file dump SQL | `assertWritable` trên target connection | `confirmProductionTransfer`: cảnh báo xóa đối tượng hiện có và tạo DB | Độc quyền: `claimDatabaseTransfer` | Hủy qua `cancelDatabaseTransfer` | Preflight inspection; **lưu ý:** Selective object restore execution plan chưa được nối vào executor (P0 rà soát B01) | Ghi qua `recordAudit` (`actionType: 'RESTORE'`) | `database-restore.test.cjs`, `renderer-smoke.cjs` |
| `db:copy-backup` | Sao chép bản backup giữa các profiles | Filesystem operation | Xác nhận nếu profile đích là Production | Khóa file catalog | Atomic publish | Xác thực mã băm SHA-256 | Ghi catalog đích | `backup-catalog.test.cjs` |
| `db:trial-backup` | Phục hồi thử nghiệm vào sandbox CSDL | `assertWritable` trên test server | CSDL sandbox sinh ngẫu nhiên `sqlpro_trial_<token>` | Độc quyền: `claimDatabaseTransfer` | Timeout preflight và import | Bắt buộc bảng đánh dấu sở hữu `ownership.marker` | Ghi vào trial recovery journal | `restore-trial.test.cjs`, `mysql-integration.test.cjs` |
| `db:cleanup-trial-recovery` | Dọn dẹp/DROP CSDL sandbox thử nghiệm | `assertWritable` | Kiểm tra tiền tố `sqlpro_trial_` và token bí mật | Single flight | Timeout tiêu chuẩn | Từ chối DROP nếu thiếu marker hoặc sai token | Cập nhật journal | `restore-trial.test.cjs` |
| `db:delete-backup` | Xóa tệp bản sao lưu khỏi catalog | Thao tác hệ thống tệp local | Chặn xóa nếu bản sao lưu đang được ghim (`isPinned: true`) | Khóa mutex catalog | Đồng bộ | Kiểm tra sự tồn tại của tệp và đối chiếu hash | Cập nhật catalog | `backup-catalog.test.cjs` |
| `db:apply-backup-retention` | Áp dụng chính sách tự động xóa backup cũ | Thao tác hệ thống tệp local | Hộp thoại native hiển thị danh sách sẽ xóa; token một lần với TTL hữu hạn | Khóa mutex catalog | Báo cáo từng tệp | Bảo vệ bản sao lưu ghim và bản sao lưu anchor mới nhất | Cập nhật retention history | `backup-retention.test.cjs`, `renderer-smoke.cjs` |
| `db:save-backup-schedule` | Lưu/bật lịch sao lưu tự động | Lưu trữ cấu hình cục bộ | Cảnh báo native nếu đặt lịch trên kết nối Production | Registry quản lý | Interval trôi qua | Kiểm tra giới hạn 1–168 giờ, múi giờ và target identity | Lưu store cục bộ | `backup-scheduler.test.cjs`, `renderer-smoke.cjs` |
| `db:pause-backup-schedule` | Tạm dừng lịch sao lưu | Lưu trữ cấu hình cục bộ | N/A | Registry quản lý | Ngay lập tức | Hủy timer hiện hành | Lưu store cục bộ | `backup-scheduler.test.cjs` |
| `db:delete-backup-schedule` | Xóa lịch sao lưu | Lưu trữ cấu hình cục bộ | N/A | Registry quản lý | Ngay lập tức | Xóa entry khỏi store | Lưu store cục bộ | `backup-scheduler.test.cjs` |
| `db:update-backup-annotations` | Cập nhật tên, ghi chú, ghim backup | Lưu trữ metadata cục bộ | N/A | Khóa catalog | Đồng bộ | Ghi file `.part` nguyên tử | Cập nhật catalog | `backup-annotations.test.cjs` |
| `db:rename-backup` | Đổi tên hiển thị bản sao lưu | Lưu trữ metadata cục bộ | N/A | Khóa catalog | Đồng bộ | Ghi file `.part` nguyên tử | Cập nhật catalog | `backup-catalog.test.cjs` |
| `table-preferences:save` | Lưu cấu hình hiển thị cột và sort | Lưu trữ cấu hình cục bộ | Mặc định không lưu giá trị tìm kiếm/bộ lọc (cần opt-in) | SHA-256 file hashing | Đồng bộ | Giới hạn 128 KiB, mode 0600, ghi `.part` + rename | N/A | `table-preferences.test.cjs`, `renderer-smoke.cjs` |
| `audit-log:append` | Ghi thêm sự kiện nhật ký thao tác | Lưu trữ cục bộ Electron | N/A (chức năng bảo vệ tuân thủ) | Độc quyền ghi tệp | Đồng bộ | Tự động làm sạch secret (`sanitizeAuditSummary`), quota 2 MB / 1000 bản ghi | Ghi file audit | `audit-log.test.cjs`, `audit-log-store.test.cjs` |
| `audit-log:prune` / `clear` | Dọn dẹp nhật ký theo tuổi / Xóa hết | Lưu trữ cục bộ Electron | Xác nhận giao diện người dùng | Độc quyền ghi tệp | Đồng bộ | Giới hạn số lượng hoặc ngày lưu trữ | Cập nhật tệp audit | `audit-log.test.cjs`, `audit-log-store.test.cjs` |
| `connections:save` / `remove` | Lưu / xóa hồ sơ kết nối | Lưu trữ cục bộ Electron | N/A | Store mutex | Đồng bộ | Chuẩn hóa schema, tách secret an toàn | N/A | `store.test.cjs`, `renderer-smoke.cjs` |
| `workspaces:save` / `remove` | Lưu / xóa workspace | Lưu trữ cục bộ Electron | N/A | Store mutex | Đồng bộ | Chuẩn hóa schema | N/A | `store.test.cjs` |
| `account:sync-now` / `resolve` | Đồng bộ cấu hình E2EE lên server | Giao thức HTTPS API | Xác thực mật khẩu và giải mã Vault | Semaphore hàng đợi (`async-gate`) | 10s HTTP | Envelope revision, KDF scrypt, AEAD AES-GCM | N/A | `sync.test.cjs`, `server test` |

---

## 4. Kiểm Kê Fixtures và Markers Cơ Sở Dữ Liệu Thử Nghiệm

Hệ thống kiểm thử tích hợp sở hữu hệ thống fixtures phong phú trong `test/mysql-integration.test.cjs`, `test/data-diff-integration.test.cjs`, `test/table-data-sql.test.cjs`:

### 4.1 Cấu trúc Khóa Chính (Primary Keys)
- **PK đơn:** Bảng `parents` (`id INT PRIMARY KEY`), `items` (`id BIGINT UNSIGNED PRIMARY KEY`).
- **PK ghép (Composite PK):** Bảng `fk_review_parent` (`a INT, b INT, PRIMARY KEY (a,b)`), `context_review_child`.
- **Bảng không có PK (No-PK Table):** Bảng `review_column_attributes` (`id INT, modified DATETIME DEFAULT NULL`). Thao tác sửa ô inline hoặc xóa dòng trên bảng không có PK bị chặn ngay từ đầu với mã lỗi `NO_PRIMARY_KEY`.

### 4.2 Cấu trúc Khóa Ngoại và Đồ thị Phụ thuộc (Foreign Keys & Graphs)
- **Quan hệ phụ thuộc:** Bảng cha `parents` liên kết bảng con `children` qua `FOREIGN KEY (parent_id) REFERENCES parents(id)`.
- **Ràng buộc composite FK:** `fk_review_child` tham chiếu `(pa, pb)` tới `fk_review_parent(a, b)` với `ON DELETE SET NULL ON UPDATE CASCADE`.
- **Khóa ngoại tự tham chiếu / Vòng lặp (Circular/Self-referencing):** Được mô hình hóa và kiểm chứng bằng thuật toán tô-pô Kahn's và DFS trong `test/restore-dependency-graph.test.cjs`.

### 4.3 Kiểu Dữ Liệu Phức Tạp & Số Độ Chính Xác Cao
- **Số độ chính xác cao:** Bảng `literal_roundtrip` chứa `amount DECIMAL(30,10)`, kiểm thử Data Diff giữ nguyên `DECIMAL(40,6)` dưới dạng decimal string nguyên vẹn, không chuyển thành IEEE-754 Float làm mất chữ số.
- **JSON:** Bảng `items` (`payload JSON`), `guarded_json`. Trích xuất và so sánh qua bộ parser canonical độc lập giữ nguyên numeric lexemes, từ chối duplicate keys và cycles.
- **Chuỗi nhị phân & Bit:** `payload VARBINARY(10)`, `raw VARBINARY(128)`, `flags BIT(4)`.
- **Thời gian & Lịch:** `DATE`, `DATETIME(6)` giữ nguyên microsecond, `TIMESTAMP` với múi giờ đa dạng (`+00:00`, `+07:00`).

### 4.4 Động cơ Lưu trữ & Khóa đồng thời (Mixed Engines & Concurrency)
- **InnoDB:** Hỗ trợ đầy đủ transaction, row-level locking (`SELECT ... FOR UPDATE`), snapshot nhất quán.
- **MyISAM:** Bảng `guarded_myisam` (`ENGINE=MyISAM`). Phát hiện và cảnh báo không hỗ trợ transaction, chặn các thao tác cần rollback an toàn.
- **DDL đồng thời (Implicit Commit):** Kiểm chứng hành vi DDL ngắt transaction hiện hành và cảnh báo người dùng.

### 4.5 Cơ chế Bắt buộc Đánh dấu CSDL Thử Nghiệm (Database Markers)
Để ngăn ngừa tuyệt đối việc can thiệp vào cơ sở dữ liệu production hoặc CSDL của người dùng:
1. Mọi test suite tích hợp đều bắt buộc tạo CSDL với tiền tố định danh ngẫu nhiên:
   - `sqlpro_test_${Date.now()}_${process.pid}`
   - `sqlpro_diff_${Date.now()}_${process.pid}`
   - `sqlpro_trial_${crypto.randomBytes(16).toString('hex')}`
2. Có câu lệnh kiểm tra mẫu tường minh: `assert.match(database, /^sqlpro_test_\d+_\d+$/)`.
3. Bảng đánh dấu sở hữu sandbox: CSDL phục hồi thử nghiệm bắt buộc tạo bảng `ownership.marker` chứa token bí mật 64 ký tự trước khi cấp quyền thao tác hoặc dọn dẹp.

---

## 5. Chuẩn Hóa Hợp Đồng Kiến Trúc Cho Các Tác Vụ Dữ Liệu Mới (B00 Architectural Contracts)

Để chuẩn bị cho các gói B01–B09, tài liệu này chốt đặc tả kỹ thuật cho 5 hợp đồng dữ liệu cốt lõi:

### 5.1 Hợp đồng Ngữ cảnh Đích (`TargetScope`)
```typescript
interface TargetScope {
  profileId: string;              // Định danh kết nối
  profileFingerprint: string;     // SHA-256 của host:port:user:database:environment
  sessionId: string;              // UUID duy nhất của phiên kết nối hiện tại
  generation: number;             // Số thế hệ (tăng khi reconnect, reset, logout)
  database: string;               // Tên CSDL mục tiêu (exact case)
  table: string | null;           // Tên bảng mục tiêu (exact case)
  metadataVersion: number;        // Phiên bản snapshot metadata đã kiểm chứng
}
```

### 5.2 Hợp đồng Bằng chứng Đọc (`ReadEvidence`)
```typescript
interface ReadEvidence {
  jobId: string;
  scope: TargetScope;
  engineCapabilities: {
    engine: 'MySQL' | 'MariaDB';
    version: string;
    supportsJson: boolean;
    supportsTreeExplain: boolean;
    supportsDataLockWaits: boolean;
    supportsCheckConstraints: boolean;
  };
  startedAt: string;              // ISO-8601
  finishedAt: string;             // ISO-8601
  coverage: 'complete' | 'partial' | 'unknown';
  consistency: 'observed' | 'per-side-snapshot' | 'unsupported';
  counters: {
    scannedRows: number;
    scannedBytes: number;
    totalEstimatedRows: number | null;
  };
  limits: {
    maxRows: number;
    maxBytes: number;
    timeoutMs: number;
  };
  warnings: string[];
  snapshotIdentity: string;       // SHA-256 hash của tập dữ kiện/mốc thời gian
}
```

### 5.3 Hợp đồng Kế hoạch Xem Trước (`PlanPreview`)
```typescript
interface PlanPreview {
  opaquePlanId: string;           // UUID bí mật do main process sở hữu
  revision: number;               // Tăng khi cấu hình thay đổi
  createdAt: string;
  expiresAt: string;              // TTL hữu hạn (ví dụ: 120 giây)
  mainOwnedEvidence: ReadEvidence;
  allowedActionIds: string[];     // Whitelist các ID hành động hợp lệ
  defaultSelection: string[];     // Mặc định KHÔNG chọn các hành động phá hủy (như DELETE/DROP)
  blockers: Array<{ code: string; message: string }>;
  rendererProjection: {           // Chỉ gửi bản chiếu an toàn sang Renderer UI
    summaryCounters: {
      inserted: number;
      updated: number;
      deleted: number;
      skipped: number;
      blocked: number;
    };
    boundedSamples: Array<{ id: string; action: string; label: string }>;
    warnings: string[];
    canApply: boolean;            // CHỈ LÀ GỢI Ý UI - Quyền thực thi thực sự do Main thẩm định độc lập
  };
}
```

### 5.4 Hợp đồng Báo cáo Thực thi (`ApplyReport`)
```typescript
interface ApplyReport {
  operationId: string;
  planRevision: number;
  scope: TargetScope;
  status: 'completed' | 'partial_failure' | 'aborted' | 'unknown';
  inserted: number;
  updated: number;
  deleted: number;
  conflicts: number;
  skipped: number;
  failed: number;
  committedBatches: number;
  affectedRows: number;
  unknownOutcomes: boolean;       // Bắt buộc TRUE nếu mất mạng hoặc crash giữa transaction
  cancellation: boolean;
  sanitizedErrorCode: string | null;
  cleanupStatus: 'cleaned' | 'dangling_sandbox' | 'not_applicable';
}
```

### 5.5 Nguyên tắc Tách bạch Tuyệt đối Tác động Biên (Side Effects)
1. **Phía Nguồn (Source):** Tuyệt đối KHÔNG có bất kỳ câu lệnh ghi nào (`INSERT`, `UPDATE`, `DELETE`, `DDL`). Chỉ áp dụng transaction đọc cô lập với snapshot (nếu được hỗ trợ), và luôn tự động `ROLLBACK` hoặc đóng kết nối khi hoàn tất tác vụ để giải phóng tài nguyên.
2. **Phía Đích (Target):** Chỉ thực thi khi có sự xác nhận của Main Process, đối chiếu token xem trước chưa hết hạn, kiểm tra drift của bản ghi gốc (original row values), thực hiện theo từng lô có transaction bảo vệ và báo cáo chính xác số dòng đã commit thực tế.

---

## 6. Đánh giá Hiện trạng Các Đường Ghi Rủi ro Đã Nhận diện (Chuẩn bị cho B01)

Dựa trên việc rà soát code thực tế, nhóm kỹ thuật xác nhận các phát hiện rủi ro P0/P1 cần giải quyết ngay trong B01 trước khi mở rộng tính năng mới:

1. **P0 — G6.4 Schema Migration Apply (`app.js:3710–3755`):**
   - *Hiện trạng:* Giao diện Renderer tự lặp qua mảng `migrationStatements` và gọi `desktop.db.query` tuần tự.
   - *Rủi ro:* Chưa có bước chụp lại fingerprint của CSDL đích ngay trước lúc chạy (nguy cơ schema drift giữa thời điểm so sánh và thời điểm apply). Tùy chọn tắt khóa ngoại gửi lệnh `SET FOREIGN_KEY_CHECKS = 0` rồi `SET FOREIGN_KEY_CHECKS = 1` trực tiếp qua truy vấn thường, nếu gặp lỗi giữa chừng phiên có thể bị bỏ quên ở trạng thái tắt kiểm tra FK.
   - *Hướng xử lý tại B01/B02:* Chuyển toàn bộ điều phối apply về Main Process service; snapshot CSDL đích trước khi chạy; kiểm tra phiên và trạng thái FK an toàn; báo cáo từng câu lệnh đã thực thi.

2. **P0 — G6.1/G6.2 Schema Snapshot (`app.js:3358–3430`):**
   - *Hiện trạng:* Hàm `captureFullSchema` trong `app.js` trả về views với `definition: ''`, routines với `sql: ''`, triggers rỗng `[]`, events rỗng `[]`, và cố định `engine: 'MySQL'`.
   - *Rủi ro:* Sự thiếu hụt này có thể khiến bộ so sánh hiểu lầm là đối tượng không tồn tại và sinh lệnh DROP nguy hiểm nếu người dùng bật tùy chọn xóa đối tượng.
   - *Hướng xử lý tại B01/B02:* Chuyển collector về Main Process, đọc metadata thật từ `information_schema`/`SHOW CREATE` theo engine capabilities; đối tượng bị thiếu quyền hoặc lỗi đọc phải đánh dấu `unknown`, tuyệt đối không giả định là không tồn tại.

3. **P0 — G3.1/G3.2 Restore Chọn Đối Tượng (`electron/main.cjs:2192`, `database.cjs:3399`):**
   - *Hiện trạng:* Đã có module `restore-object-inventory.cjs`, `restore-dependency-graph.cjs` và IPC `db:preview-object-restore-plan`. Tuy nhiên, endpoint thực thi `db:restore` hiện chỉ truyền `{ database, filePath, dropExisting, createDatabaseIfNotExists, taskId }` vào `session.restoreDatabase`, chưa nhận hoặc áp dụng execution plan chọn đối tượng.
   - *Rủi ro:* Người dùng cấu hình chọn lọc bảng/view trong preview nhưng khi ấn phục hồi thực tế có thể dẫn đến việc phục hồi toàn bộ tệp dump hoặc không thực hiện đúng phân tầng phụ thuộc.
   - *Hướng xử lý tại B01/B03:* Nối chặt chẽ execution plan do Main sở hữu từ preview tới executor; đảm bảo executor chỉ duyệt và chạy các câu lệnh thuộc các đối tượng đã được phê duyệt trong plan.

---

## 7. Kết luận & Nghiệm thu Gói B00

- **Mục tiêu hoàn thành:** B00 đã thiết lập đầy đủ hồ sơ baseline kỹ thuật, lập bảng kiểm kê 25+ kênh IPC ghi, kiểm tra toàn bộ 14 bài test skip và 960 bài test pass, xác minh các markers an toàn trên DB thật, và hoàn thiện 5 hợp đồng kiến trúc cốt lõi.
- **Mã nguồn runtime:** Giữ nguyên vẹn, không có thay đổi mã nguồn phát sinh trong gói này, không có hồi quy.
- **Bước tiếp theo:** Sẵn sàng chuyển giao gói **B01 — Xác minh lại các đường rủi ro đã tick (P0 Migration, P0 Snapshot, P0 Selective Restore)** theo lộ trình `GEMINI_IMPLEMENTATION_HANDOFF.md`.
