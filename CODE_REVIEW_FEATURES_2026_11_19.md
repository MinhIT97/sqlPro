# Rà tính năng và bugs SqlPro — 19/11/2026

> **Cập nhật sau sửa:** [Đã sửa F01–F06 và giới hạn](CODE_REVIEW_FEATURES_2026_11_19_FIXES.md). Findings và observations bên dưới là lịch sử trước bản sửa.

**Baseline: 60cdb20. Có 6 nhóm lỗi mới xác nhận (5 P1, 1 P2), chưa sửa trong lượt này.** Regression N/D/E đã sửa vẫn đạt. Điểm quan trọng nhất: **Schema Diff UI còn chạy collector/generator riêng ở renderer**, chưa sử dụng collector/service Main đã gia cố. Test các module Main đạt không chứng minh SQL người dùng sao chép hoặc mở trong Editor đã có cùng bảo vệ.

Đây là review, không sửa runtime, không commit/push, không mở public Migration/Data Sync Apply. SQL thủ công dưới đây không phải bypass IPC Apply; người dùng vẫn phải chủ động chạy SQL được xuất.

## 1. Findings theo mức độ

### F01 — P1: Đọc metadata lỗi bị coi như bảng không tồn tại và sinh DROP

Vị trí: [app.js:3415](app.js#L3415), [executeCompare:3457](app.js#L3457).

`captureFullSchema()` catch lỗi columns/indexes/relations của một bảng rồi chỉ console.warn và bỏ bảng khỏi snapshot. Không có coverage unknown/partial. Nếu lỗi ở nguồn, bảng có thật trở thành “chỉ có ở đích”; bật tùy chọn DROP sẽ tạo câu xóa dù chưa biết nguồn có bảng hay không.

**Probe app.js thật trong VM, dữ liệu DB thật trên cả MySQL/MariaDB:** nguồn và đích đều có `indexed`; giả lập phản hồi ER_TABLEACCESS_DENIED_ERROR khi đọc columns nguồn. UI sinh **DROP TABLE IF EXISTS `indexed`; với enabled=true** khi tùy chọn DROP được bật. Không gọi schemaSnapshot lần nào. Probe chỉ quan sát SQL, **không thực thi DROP này**. DROP mặc định tắt giúp giảm phơi nhiễm, không sửa được việc nhầm unknown thành absent.

**Cần sửa:** lỗi metadata phải làm comparison incomplete/blocked; không tạo DROP/MODIFY dựa trên phần thiếu. Nối UI với snapshot coverage do Main sở hữu và giữ guards sau await; test permission/timeout/quota từng nhóm, không có destructive SQL trong output khi unknown.

### F02 — P1: UI xuất sai uniqueness, bỏ CHECK và nhận sai dialect

Vị trí: [app.js:3394](app.js#L3394), [isUnique:3409](app.js#L3409), [engine:3429](app.js#L3429); đối chiếu [database.cjs:1520](electron/database.cjs#L1520).

DatabaseSession.listIndexes trả `unique`; UI lại dùng `!i.nonUnique`. Trường nonUnique không tồn tại nên index thường thành unique. Collector UI không mang CHECK inventory/completeness, collation/generated metadata đầy đủ và cố định engine MySQL; các gate Main không tham gia.

**MySQL 8.4.13:** nguồn có `KEY idx_label(label)`, hai dòng label cùng `same`, và `CHECK(qty>0)`. UI tạo CREATE_TABLE severity=safe, chứa **UNIQUE KEY idx_label**, không có CHECK. Thực thi chính DDL xuất ra trên DB tạm tạo unique index; chèn hai giá trị hợp lệ ở nguồn bị **ER_DUP_ENTRY** ở đích. Không có quyền Apply tự động nào được mở trong probe.

**MariaDB 11.4.13:** UI vẫn ghi engineClaim=MySQL; default NULL của qty bị xuất thành `DEFAULT 'NULL'`, CREATE bị **ER_INVALID_DEFAULT**. Không kết luận mọi kiểu MariaDB đều lỗi.

**Cần sửa:** thống nhất projection index/column/dialect với collector chuẩn; bỏ việc đoán field, thiếu fact là unsupported. CHECK chưa hỗ trợ phải block export như candidate. Test UI so sánh/xuất SQL thực sự, round-trip hai engine và kiểm uniqueness/constraints/default/collation; không chỉ mở modal. Code FK còn dùng `r.columnName` trong khi adapter trả `column` và gán RESTRICT cố định: cần bao phủ khi sửa contract, **chưa có probe FK UI riêng trong lượt này**.

### F03 — P1: Script UI tắt FK/UNIQUE và đổi SQL mode trái thông báo bảo vệ

Vị trí: [app.js:3208](app.js#L3208) (`wrapForeignKeys=true`), [formatter call:3635](app.js#L3635), [schema-diff.js:1149](schema-diff.js#L1149).

UI hiện dòng “Ràng buộc khóa ngoại luôn được bảo vệ”, nhưng getFormattedScript truyền wrapForeignKeys mặc định true. Formatter sinh `FOREIGN_KEY_CHECKS=0`, `UNIQUE_CHECKS=0` và thay SQL_MODE thành NO_AUTO_VALUE_ON_ZERO; câu phục hồi chỉ ở cuối script. Main candidate/service từ chối FK override không bảo vệ đường copy/download/open Editor này.

**Probe cả hai engine:** formatter theo cùng option UI; chạy ba câu prefix trên connection test riêng, rồi DDL lỗi ER_TABLE_EXISTS_ERROR và dừng. Trạng thái sau lỗi là **fk=0, uq=0, sqlMode=NO_AUTO_VALUE_ON_ZERO**, thay vì settings trước đó. Đã đóng connection test ngay; không đổi server/global. Probe chứng minh prefix và trạng thái khi execution dừng, không giả định mọi công cụ chạy script có cùng cleanup behavior.

**Cần sửa:** bỏ wrapper tắt checks/đổi mode khỏi script mặc định; unsupported phải block thay vì tắt constraint. Kiểm script có/không statement, thành công/lỗi/hủy, copy/download/open Editor và thông báo đúng với hành vi. Câu SET phục hồi cuối tệp không phải finally.

### F04 — P1: Sync xóa dữ liệu bảng ngoài plan qua FK CASCADE

Vị trí: [data-sync-executor.cjs:153](electron/data-sync-executor.cjs#L153), [DELETE:256](electron/data-sync-executor.cjs#L256).

Target safety kiểm engine/triggers và schema/PK của bảng trong plan, chưa đọc/khóa dependency closure của inbound FK. affectedRows của DELETE parent không phản ánh số dòng cascade ở bảng con. Plan single-table có thể thay đổi dữ liệu ngoài scope đã preview.

**DB thật, cả hai engine:** plan chỉ DELETE parent(id=1), includeDeletes opt-in. Bảng `outside_plan` chứa một dòng FK ON DELETE CASCADE tới parent, không nằm trong plan. Executor production trả **success=true, committedCount=1**; dòng bảng ngoài plan biến mất (**1 → 0**). Không có trigger; InnoDB và exact-row guards đều đạt.

**Cần sửa trước mở Apply:** collect inbound/outbound FK actions từ Main dưới lock phù hợp; block tác động ngoài plan hoặc đưa dependency closure và ảnh hưởng dữ liệu vào preview/authorization. Test DELETE CASCADE/SET NULL và UPDATE CASCADE, nhiều bảng/schema, marker ngoài scope và drift FK. Đây là executor nội bộ; public Data Sync Apply vẫn khóa, không có chứng cứ đã ảnh hưởng DB người dùng.

### F05 — P1: Sync không đọc lại policy/context khi profile bị thu hồi quyền

Vị trí: [data-sync-executor.cjs:105](electron/data-sync-executor.cjs#L105), [batch loop:193](electron/data-sync-executor.cjs#L193).

getProfileWithSecrets/assertWritable/Production approval chỉ chạy lúc bắt đầu. fingerprintProfile được inject nhưng chưa dùng trong executor. Không đọc lại authoritative profile sau await hoặc giữa các batch; schema lock không là proof policy/context còn hợp lệ.

**Production executor với worker giả:** hai INSERT, batchSize=1. Sau batch đầu, thay profile authoritative sang readOnly=true, environment=production. Executor vẫn INSERT/COMMIT batch hai, success/committedCount=2, getProfileWithSecrets chỉ đọc **1 lần**, không yêu cầu approval mới. Đây là probe dependency-injected, không DB concurrency hoặc đường UI public thực.

**Cần sửa trước mở Apply:** snapshot fingerprint/generation/permission, guard từ nguồn Main sau các await và trước DML/COMMIT/batch; drift dừng và báo phần đã commit, không tự chuyển profile/approval. Cần contract timeout/cancel/late cleanup và approval gắn plan digest/đích/TTL đầy đủ. Không nhận callback renderer làm policy authority.

### F06 — P2: Main preview và candidate dùng gate DEFAULT MariaDB khác nhau

Vị trí: [schema-migration-service.cjs:101](electron/schema-migration-service.cjs#L101), [candidate:155](electron/schema-migration-service.cjs#L155).

createCandidatePlan dùng generator có MARIADB_DEFAULT_REVIEW_REQUIRED; createMigrationPlan vẫn đi generateMigrationSql trực tiếp, không gọi gate DEFAULT đó. Cùng snapshot có thể blocked ở candidate nhưng được sinh SQL preview sai semantics.

**MariaDB thật:** nguồn VARCHAR default `pending`, metadata COLUMN_DEFAULT là SQL literal `'pending'`. Candidate blocked với MARIADB_DEFAULT_REVIEW_REQUIRED; preview status=preview, SQL DEFAULT `'''pending'''`. Thực thi DDL preview trên DB tạm rồi INSERT bỏ qua cột v lưu **chuỗi có hai dấu nháy bao quanh** `'pending'`, thay vì `pending`. MySQL control giữ pending đúng. Preview vẫn applySupported=false; UI hiện tại chưa gọi service này, nhưng IPC Main đã công bố nó.

**Cần sửa:** preview/candidate/export dùng một contract metadata/dialect và cùng unsupported gates. Không chỉ nối UI sang createMigrationPlan hiện có rồi coi hoàn tất. Test cùng snapshot qua các đường và so sánh blockReason/SQL fidelity.

## 2. Đối chiếu tính năng với code hiện tại

Đếm trực tiếp DATABASE_PRODUCT_ROADMAP.md: **51 checkbox, 22 tick, 29 chưa tick**. Đây là checklist lịch sử, không phải phần trăm hoàn thành. Những mục có code/helper chưa mặc nhiên đạt tiêu chí toàn luồng.

| Khu vực | Đã có | Chưa hoàn tất / bước tiếp theo |
| --- | --- | --- |
| G1 — kết nối, production, transaction | Profile môi trường/read-only, policy Main, registry/lease, transaction UI và guards; N/D/E regressions đã có. | Rà toàn endpoint/lifecycle/permission, nhất là Sync F05; matrix mất kết nối/approval/context và phiên đích. Không suy module guard bao phủ mọi đường mới. |
| G2 — backup catalog/chi tiết/trial | Rename/note/pin, manifest/checksum, scan worker, trial sandbox/report và retention có code/tests. | Full permission/cancel/disk-full/clock/crash/installed acceptance chưa tái kiểm toàn bộ trong lượt này; checksum và restore verification là hai mức riêng. |
| G3.1/G3.2 — selective restore | Inventory/plan/DAG/executor có Main path; mode/charset/executable comments/unknown đang chặn theo contract. | Mở rộng dialect/dependencies có fixture và marker ngoài selection; chưa full SQL dialect. |
| G3.3 — calendar | Cron/timezone/DST calculator có test; scheduler runtime vẫn intervalHours 1–168 giờ, nextRunAt theo khoảng thời gian. | Chưa nối calendar calculator với scheduler/store/claim/UI; sleep/wake/missed/restart/retry/OS scheduler cần nghiệm thu. Checkbox đang tick không chứng minh đủ timezone/DST/calendar. |
| G3.4–G3.6 — retention, crypto, replica | Retention plan/auto có guards; crypto container V2/legacy và replica pair/IPC/UI helper có rồi. | Catalog chỉ nhận tên .sql; .sql.enc bị loại, resolveBackup không nhận .enc nên chưa có round-trip UI decrypt/catalog hoàn chỉnh. Còn manifest/discovery/recovery, remote adapter/cancel/fault matrix; hash copy không là restore proof. |
| G4 — hiệu năng | Streaming/keyset/filter/quota/cache và virtualization đã có. | Chưa benchmark end-to-end 1/10/20 GB local/SSH/TLS; cần RSS/event loop/UI latency/disk/fault, không thay bằng synthetic rows. |
| G5 — editor/lọc/EXPLAIN | Scope autocomplete/cache, grouped filter/view preferences, snippets/diagnostics, JSON/TREE viewer/context và ANALYZE riêng có code/tests. | Grammar/correlation/dialect ngoài subset, capability và UX/installed acceptance đầy đủ còn thiếu. Checkbox chưa tick không có nghĩa “chưa có code”. |
| G6 — Schema Diff/migration | UI so sánh/xuất SQL; Main collector/service/generator/admission/executor tồn tại. | **UI chưa dùng Main collector/service**, gây F01–F03; Main preview còn F06. Public Apply khóa. G6.1–G6.4 đang tick cần xét lại; chưa nghiệm thu toàn luồng. |
| G7 — Data Diff/Sync | UI báo cáo bounded 200–2.000 dòng/phía, exact values và chặn sync; Main keyset service/internal plan/executor có riêng. | UI vẫn db.query LIMIT, chưa gọi startDataDiff/dataDiffStatus. Full-table/unique-key mapping/consistency hai server chưa nghiệm thu. Apply khóa; F04/F05 cần sửa cùng Main-owned authorization/partial/cancel trước mở. |
| G8/G9 — UX/kiến trúc/sync/release | Audit/masking/E2EE sync, recovery helper và workflows/tests tồn tại. | Tách app/main, privacy đầy đủ, user acceptance 5 người, recovery/device/rotation/conflict, installed Windows/Ubuntu/upgrade/ASAR/signing và release runbook chưa đủ bằng chứng. recovery-kit chưa nối Main/UI như account recovery. |

Các mô tả “hoàn tất B02–B18” cũ không được dùng làm nghiệm thu sản phẩm. Ưu tiên là nối đúng contract vào luồng người dùng và test luồng đó, trước khi viết thêm helper.

## 3. Kiểm chứng và giới hạn

| Kiểm tra ở 60cdb20 | Kết quả |
| --- | --- |
| npm run check | **1.275 tổng / 1.253 pass / 0 fail / 22 opt-in skip** |
| npm run test:renderer | **103/103 pass** |
| npm run test:website | **14/14 pass** |
| npm --prefix server run check | Pass |
| npm run server:test | **17/17 pass** |
| Probe mới | Tái hiện F01–F06, là observation **không phải acceptance pass** |
| git diff --check | Pass |

Renderer smoke hiện có test tên “schema diff ... navigates tabs” nhưng body chỉ kiểm modal/config controls rồi đóng; không so sánh metadata/xuất/thực thi DDL. Vì vậy 103/103 không phủ định findings UI. Probe mới chạy **app.js production trong VM với DOM stub**, dùng metadata thật từ DatabaseSession và SQL trên MySQL **8.4.13** / MariaDB **11.4.13**; chưa kiểm full native keyboard/layout cho tình huống mới. F05 dùng worker giả, không DB thật. F04 dùng plan service/executor thật với DB tạm.

Evidence: [probe](review/gemini-2026-11-19/features/reproduce.cjs), [observed.json](review/gemini-2026-11-19/features/observed.json), [logs](review/gemini-2026-11-19/features/). Probe exit 0 chỉ nghĩa thu thập xong. Script chỉ chạy DB khi đặt SQLPRO_REVIEW_MYSQL_PORT/SQLPRO_REVIEW_MARIA_PORT cho loopback dùng một lần/root không mật khẩu. Schema ngẫu nhiên được xóa trong finally; hai container tmpfs đã dọn, không dùng DB người dùng. Không chạy lại toàn DB regression/installed/release matrix; 27 DB tests ở báo cáo E là mốc trước, không báo thành kết quả chạy lại.

## 4. Thứ tự xử lý đề nghị

1. **Chặn unknown/destructive output và thống nhất collector/UI/Main:** F01/F02; sau đó bỏ wrapper settings F03. Chưa hỗ trợ thì block export rõ, không chỉ disable Apply.
2. **Dùng chung preview/candidate/SQL contract:** sửa F06 trước nối UI; bổ sung index/CHECK/dialect/default/order và guards stale dialog/context.
3. **Giữ Sync Apply khóa**, sửa F04/F05 và nghiệm thu dependency closure/authorization/context/cancel/partial commit trước mở.
4. Sau khi các đường dữ liệu đạt, hoàn thiện calendar, crypto/catalog/recovery và Main Data Diff UI wiring theo từng gói; tiếp đó installed/performance/security/release acceptance.

Lượt này chỉ bổ sung báo cáo/bằng chứng và cập nhật con trỏ tài liệu. **Chưa sửa 6 findings mới, chưa commit.**
