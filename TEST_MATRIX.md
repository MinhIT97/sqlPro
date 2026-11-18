# Ma trận Kiểm thử SqlPro (SqlPro Test Matrix)

**Mốc đối chiếu:** Commit `f812fc1` (`f812fc179a32c25a07c1341d24c0429bfef10808`)\
**Phiên bản package:** `0.3.12`\
**Ngày cập nhật:** 18/11/2026\
**Mục tiêu:** Ma trận phân loại toàn bộ hệ thống kiểm thử tự động, mức độ rủi ro, phân định rõ giữa kiểm thử offline/mock và kiểm thử trên cơ sở dữ liệu thật, cùng các ca kiểm thử biên (Negative / Boundary Cases) để phục vụ nghiệm thu chuẩn xác.

**Kiểm chứng mới nhất sau review cuối B02-E1 (18/11):** `npm run check` 1043 pass / 0 fail / 14 opt-in skip (1057 tổng); focused migration executor/admission/service/Main IPC 49/49 (23 admission, 12 executor, 9 service, 5 IPC), Electron 100/100, website 14/14, server check đạt và server 17/17. Adapter approval tự hash payload và không tin digest caller; có test hồi quy fail trước sửa/pass sau sửa. Chưa kiểm DB thật/bộ cài trong lượt này. Executor thử nghiệm chưa nối Apply IPC, Apply ở Main/service vẫn khóa. Mốc commit và số liệu các đợt cũ bên dưới là đối chiếu lịch sử.

---

## 1. Tổng quan Ma trận Kiểm thử

| Danh mục Kiểm thử | Phạm vi kiểm thử | Số ca test | Pass | Fail | Skip | Trạng thái hạ tầng |
| --- | --- | --- | --- | --- | --- | --- |
| **Unit & Pure Logic** | Parser, Tokenizer, Row Values, View, Filters, Autocomplete, Data Masking, Audit Log, Crypto, B01 Risk Verification | 529+ | 529+ | 0 | 0 | Đầy đủ (Chạy qua Node.js) |
| **Main Process Contracts** | Session Registry, Store, Backup File, Retention, Inspection, Scheduler, Policies | 440+ | 440+ | 0 | 0 | Đầy đủ (Mock I/O, IPC stub) |
| **Electron Renderer Smoke** | Toàn bộ UI, Modal, Dialogs, Phím tắt, Thu nhỏ cửa sổ (940×700), Dark Theme, IPC | 100 | 100 | 0 | 0 | Đầy đủ (Electron headless `--no-sandbox`) |
| **Website Smoke** | Trang chủ, Download buttons, Đa ngôn ngữ En/Vi, Tìm kiếm docs, Fallback No-JS | 14 | 14 | 0 | 0 | Đầy đủ (Chromium headless) |
| **Server & E2EE Sync** | Auth, Session expiration, Vault revision, Scrypt KDF rate limiting, Async Gate | 17 | 17 | 0 | 0 | Đầy đủ (Node.js + SQLite in-memory/temp) |
| **Real DB Integration (Opt-in)** | MySQL 8.4 LTS, MariaDB 11.4 LTS, Khóa bảng, DDL đồng thời, DECIMAL lớn, NO_BACKSLASH_ESCAPES | 14 suites | 0 (Mặc định) | 0 | 14 | Cần container tmpfs độc lập với cổng biến môi trường |
| **Bộ cài đặt & Đóng gói (OS)** | Windows installer (.exe), Ubuntu (.deb) in-place upgrade, runtime ASAR integrity | 1 (ASAR) | 1 | 0 | 0 | Linux unpacked ASAR đã qua; Windows/Ubuntu native install: **Chưa có hạ tầng** |
| **Benchmark Dữ liệu Lớn** | Tải 1 GB / 10 GB / 20 GB, p95 UI latency, bộ nhớ heap/RSS khi stream | 0 | 0 | 0 | 0 | **Chưa có hạ tầng (Hoãn tới B15)** |

---

## 2. Ma trận Chi tiết theo Các Mốc Roadmap (Milestones G0–G9)

| Mốc Roadmap | Phạm vi chức năng | Mức độ rủi ro | Bộ test kiểm chứng hiện có | Số test pass | Trạng thái kiểm chứng |
| --- | --- | --- | --- | --- | --- |
| **G0** | Baseline, Contracts, Ma trận an toàn | Thấp | `npm run check`, `npm run test:renderer`, `BASELINE_REPORT.md` | 960 unit + 100 UI | **ĐÃ HOÀN TẤT TRONG B00** |
| **G1.1** | Nhãn môi trường (Local/Staging/Production), Theme border | Thấp | `test/renderer-smoke.cjs` | 6 | Pass |
| **G1.2** | Thực thi kết nối chỉ đọc (Read-Only Gate) | Nghiêm trọng | `test/connection-policy.test.cjs`, `test/renderer-smoke.cjs` | 8 unit + 4 UI | Pass |
| **G1.3** | Cảnh báo phá hủy Production (Destructive Gate) | Nghiêm trọng | `test/connection-policy.test.cjs`, `test/renderer-smoke.cjs` | 8 unit + 5 UI | Pass |
| **G1.4** | Quản lý Transaction & Khóa phiên bận | Nghiêm trọng | `test/session-registry.test.cjs`, `test/mysql-integration.test.cjs` | 12 unit | Pass offline; DB integration opt-in skip |
| **G1.5** | Đóng/ngắt kết nối an toàn, bảo vệ giao dịch dở dang | Cao | `test/session-registry.test.cjs` | 6 unit | Pass |
| **G2.1–G2.5** | Backup Catalog, Annotations, Quét worker, Phục hồi thử sandbox | Cao | `test/backup-catalog.test.cjs`, `test/backup-file.test.cjs`, `test/restore-trial.test.cjs` | 42 unit + 8 UI | Pass |
| **G3.1–G3.2** | Phục hồi chọn đối tượng & Đồ thị phụ thuộc Kahn's DAG | Nghiêm trọng | `test/restore-dependency-graph.test.cjs`, `test/restore-object-inventory.test.cjs`, `test/risk-verification-b01.test.cjs` | 19 unit | Pass (Unit logic); **Xác nhận đứt gãy kiến trúc UI/IPC/Executor trong B01 (P0)** |
| **G3.3** | Lịch sao lưu tự động (Backup Scheduler) | Trung bình | `test/backup-scheduler.test.cjs`, `test/risk-verification-b01.test.cjs`, `test/renderer-smoke.cjs` | 15 unit + 3 UI | Pass (Xác nhận giới hạn: chỉ hỗ trợ intervalHours, âm thầm bỏ qua timeOfDay/cron, in-memory setTimeout) |
| **G3.4** | Tự động dọn dẹp backup (Retention Policy) | Cao | `test/backup-retention.test.cjs`, `test/renderer-smoke.cjs` | 20 unit + 4 UI | Pass |
| **G3.5** | Nén & Mã hóa backup theo luồng | Nghiêm trọng | Chưa có (B10) | 0 | Chưa triển khai |
| **G3.6** | Bản sao backup ngoài máy (Off-site / Remote replica) | Cao | Chưa có (B11) | 0 | Chưa triển khai |
| **G4.1–G4.2** | Cache metadata, Keyset paging, Predicate builder | Trung bình | `test/table-data-sql.test.cjs`, `test/table-search.test.cjs` | 26 unit | Pass |
| **G4.3–G4.5** | Virtualized result grid, Giới hạn DOM, Benchmark tải | Trung bình | `test/query-results.test.cjs`, `test/result-budget.test.cjs` | 18 unit + 4 UI | Pass offline; Benchmark lớn: **Chưa có** |
| **G5.1–G5.2** | EXPLAIN bảng, EXPLAIN JSON/TREE, So sánh plan | Trung bình | `test/explain-formats-integration.test.cjs`, `test/renderer-smoke.cjs` | 12 unit + 6 UI | Pass offline; DB integration opt-in skip |
| **G5.3** | Autocomplete thông minh (CTE, derived table, star local) | Thấp | `test/autocomplete-local-star.test.cjs`, `test/sql-autocomplete.test.cjs` | 38 unit + 8 UI | Pass |
| **G5.4** | Bộ lọc AND/OR nâng cao, sort đa cột, lưu preference | Thấp | `test/table-filters.test.cjs`, `test/table-view.test.cjs`, `test/table-preferences.test.cjs` | 35 unit + 10 UI | Pass |
| **G5.5** | Mẫu truy vấn (Snippets) & Lịch sử làm sạch secret | Thấp | `test/query-snippets.test.cjs`, `test/risk-verification-b01.test.cjs`, `test/renderer-smoke.cjs` | 8 unit + 3 UI | Pass (Tái hiện hổng persistState) |
| **G5.6** | Dashboard chẩn đoán: processlist, locks, safe kill | Cao | `test/diagnostics.test.cjs`, `test/risk-verification-b01.test.cjs`, `test/renderer-smoke.cjs` | 9 unit + 4 UI | Pass (Tái hiện target switch khi đổi app.connection trong lúc confirmation pending và gửi KILL nhầm đích) |
| **G6.1–G6.4** | Schema Diff & Migration synchronization | Nghiêm trọng | `test/schema-diff.test.cjs`, `test/risk-verification-b01.test.cjs`, `test/schema-snapshot*.test.cjs`, `test/schema-migration-service.test.cjs`, `test/schema-migration-executor.test.cjs`, `test/schema-migration-admission.test.cjs`, `test/main-schema-migration.test.cjs` | Focused executor/admission/service/IPC 49/49 | Collector + main-owned preview có lease/scope/policy/quota/immutability test. E1 có admission, single-use Production receipt, context hooks, digest equality và kiểm payload độc lập khi xác minh approval; được chốt trong phạm vi offline/Main contracts. Executor độc lập có test token/receipt/drift/cancel/ledger/progress, chưa nối Apply IPC. **Apply bị khóa ở main và service bằng MIGRATION_APPLY_NOT_READY; chưa nghiệm thu job cancel/worker verifier (E2), generator/DB matrix (E3) hoặc ghi/DB thật.** |
| **G7.1–G7.5** | Data Diff & Báo cáo quan sát hữu hạn | Nghiêm trọng | `test/data-diff.test.cjs`, `test/renderer-smoke.cjs` | 6 unit + 6 UI | Pass; **Đồng bộ đang KHÓA CHỦ ĐÍCH** |
| **G8.1** | Nhật ký thao tác cục bộ (Local Audit Log) | Thấp | `test/audit-log.test.cjs`, `test/audit-log-store.test.cjs` | 9 unit + 3 UI | Pass |
| **G8.2–G8.5** | Tách module kiến trúc, UX phím bấm, Thử nghiệm người dùng | Thấp | `test/renderer-smoke.cjs` | 100 UI pass | Tách dần theo các gói B16 |
| **G9.1–G9.2** | E2EE Sync, Khôi phục Vault, Trùng lặp phiên bản | Cao | `server/test/*.test.cjs`, `test/sync.test.cjs` | 17 server + 6 unit | Pass |
| **G9.3–G9.5** | Security review, CI matrix mở rộng, Phát hành bộ cài | Nghiêm trọng | CI workflow, `git diff --check` | Đạt cú pháp | Cần rà soát cuối (B18) |

---

## 3. Ma trận Các Ca Kiểm Thử Biên & An Toàn Tiêu Cực (Negative & Boundary Matrix)

| Kịch bản kiểm thử biên | Cơ chế phòng thủ / Kỳ vọng của hệ thống | Tệp test kiểm chứng | Kết quả |
| --- | --- | --- | --- |
| **Dữ liệu đầu vào hỏng / Malformed SQL** | Tokenizer từ chối, không ném ngoại lệ crash process, trả về lỗi cú pháp rõ ràng | `test/connection-policy.test.cjs` | Đạt |
| **Vượt Quota kích thước / Byte Budget** | Giới hạn 2 MB cho audit, 128 KiB cho preferences, 4 MB cho production preview | `test/audit-log-store.test.cjs`, `test/result-budget.test.cjs` | Đạt |
| **Token xác nhận hết hạn / Replay Attack** | Production approval token chỉ dùng một lần (consumed), có TTL 120 giây; từ chối khi gọi lại | `test/production-approvals.test.cjs` | Đạt |
| **Race Condition / Đổi đích khi await** | So sánh fingerprint, session ID và generation sau mỗi bước bất đồng bộ; hủy tác vụ nếu phát hiện đổi tab | `test/data-diff.test.cjs`, `test/renderer-smoke.cjs` | Đạt |
| **Mất kết nối giữa transaction** | Tự động đánh dấu phiên chết (`session.dead`), từ chối COMMIT tự động, giải phóng leases | `test/session-registry.test.cjs` | Đạt |
| **Ghi vào CSDL chỉ đọc (Read-Only Safety)** | Chặn ngay tại Main Process trước khi gửi tới driver MySQL; vô hiệu hóa nút ghi trên giao diện | `test/connection-policy.test.cjs`, `test/renderer-smoke.cjs` | Đạt |
| **Xung đột sửa dòng (Original Drift)** | Bảng có dòng bị người khác sửa/xóa trước: câu lệnh đối chiếu hash gốc phát hiện khác biệt và dừng ghi | `test/table-data-sql.test.cjs` | Đạt |
| **Thao tác nguy hiểm không điều kiện (WHERE 1=1)** | Phân tích cú pháp phát hiện `UNCONDITIONAL_DELETE` / `UNCONDITIONAL_UPDATE`, bắt buộc hộp thoại cảnh báo | `test/connection-policy.test.cjs` | Đạt |
| **Khóa chính ghép va chạm (Composite Key Collision)** | Serialization dùng JSON tuple đầy đủ, ngăn chặn chuỗi ghép `::` bị trùng lặp | `test/data-diff.test.cjs` | Đạt |
| **Số lớn mất chính xác (DECIMAL / BIGINT)** | Sử dụng chuỗi số thuần (numeric lexemes), từ chối ép kiểu sang JS IEEE-754 Number | `test/data-diff.test.cjs`, `test/row-values.test.cjs` | Đạt |
| **Dọn dẹp bản sao lưu đang được ghim (Pinned Backup)** | Catalog từ chối xóa hoặc dọn retention nếu backup có cờ `isPinned: true` | `test/backup-catalog.test.cjs`, `test/backup-retention.test.cjs` | Đạt |
| **Sandbox giả mạo (Trial DB Ownership Marker)** | Từ chối DROP bất kỳ database nào nếu thiếu bảng `ownership.marker` hoặc sai token | `test/restore-trial.test.cjs` | Đạt |

---

## 4. Quy trình Tái Chạy và Nghiệm thu Toàn diện

Để tái hiện chính xác kết quả kiểm thử trên bất kỳ môi trường nào:

### 4.1 Bộ lệnh Kiểm thử Cơ sở (Offline / Mock)
```bash
# 1. Kiểm tra toàn bộ cú pháp và chạy 1.057 unit/contract tests (1043 pass, 14 skip)
npm run check

# 2. Chạy 100 bài kiểm thử giao diện Electron Renderer
node test/run-renderer-smoke.cjs --no-sandbox

# 3. Chạy 14 bài kiểm thử giao diện Website
node test/run-website-smoke.cjs --no-sandbox

# 4. Kiểm tra và chạy 17 bài kiểm thử Server E2EE Sync
npm --prefix server run check
npm run server:test

# 5. Kiểm tra định dạng và trailing whitespace
git diff --check
```

### 4.2 Bộ lệnh Kiểm thử Tích hợp CSDL Thật (Isolated DB Environment)
Chỉ thực thi khi đã khởi tạo container tmpfs thử nghiệm độc lập:
```bash
# Chạy bộ tích hợp MySQL (33 kịch bản)
SQLPRO_TEST_MYSQL_PORT=13317 npm run test:mysql

# Chạy kiểm thử Data Diff trên CSDL thật
SQLPRO_DATA_DIFF_PORT=13317 node --test test/data-diff-integration.test.cjs

# Chạy kiểm thử tìm kiếm bảng trên CSDL thật
SQLPRO_TABLE_SEARCH_PORT=13317 node --test test/table-search-integration.test.cjs

# Chạy kiểm thử EXPLAIN formats trên CSDL thật
SQLPRO_TEST_EXPLAIN_PORT=13317 node --test test/explain-formats-integration.test.cjs
```
