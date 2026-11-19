# Rà soát sâu sau bản sửa — 19/11/2026

> **Cập nhật sau sửa:** [Bản sửa D01–D09 và giới hạn](CODE_REVIEW_GEMINI_2026_11_19_R2_FIXES.md). Nội dung bên dưới là findings và bằng chứng trước sửa, giữ làm lịch sử.

**Còn 9 findings xác nhận: 5 P1, 4 P2.** Phạm vi: `c7df696` và commit `2489b3a` xuất hiện trong lúc review (xử lý idle connection/global exceptions). Đóng N01–N07 trước đó không chứng minh toàn sản phẩm hết lỗi. Những findings mới ký hiệu D01–D09 bên dưới, chưa sửa runtime hoặc commit trong lượt này.

Public Migration Apply và Data Sync Apply vẫn khóa. Các lỗi migration/Sync dưới đây được tái hiện qua executor nội bộ trên DB thử nghiệm; không khẳng định có đường IPC vượt khóa hoặc database người dùng đã bị ảnh hưởng. Replica, UI và xử lý connection/error là các đường hiện có.

## 1. Findings P1

### D01 — ENUM bị đổi giá trị literal, hậu kiểm che mất khác biệt

Vị trí: [schema-diff.js:40](schema-diff.js#L40), [schema-diff.js:643](schema-diff.js#L643), [schema-migration-generator.cjs:26](electron/schema-migration-generator.cjs#L26), [schema-migration-executor.cjs:213](electron/schema-migration-executor.cjs#L213).

Normalizer lowercase toàn COLUMN_TYPE, formatter uppercase toàn chuỗi kiểu; cả hai chạm vào literal ENUM/SET. Hậu kiểm mới cũng lowercase metadata type nên bỏ qua khác biệt.

**DB thật:** nguồn `ENUM('pending','Done') COLLATE utf8mb4_bin` thành `ENUM('PENDING','DONE')` ở đích. Candidate ready, executor success. INSERT `'pending'` được nguồn chấp nhận nhưng đích từ chối `WARN_DATA_TRUNCATED`. Đây là sai ngữ nghĩa dữ liệu. Probe trực tiếp kiểm ENUM; SET dùng chung formatter nhưng chưa chạy ca DB riêng.

**Cần sửa:** giữ nguyên bytes/case/escape của literal khi normalize/format/compare; chỉ chuẩn hóa keyword. Test ENUM/SET mixed case, quote/backslash và Unicode trên hai engine; chưa có contract thì block trước DDL. Hậu kiểm phải giữ thông tin thay vì lowercase toàn kiểu.

### D02 — Hai bảng khác hoa/thường bị gộp, migration thành công nhưng thiếu bảng

Vị trí: [schema-diff.js:222](schema-diff.js#L222), các map tên trong compareSchemas; generator gọi tại [schema-migration-generator.cjs:145](electron/schema-migration-generator.cjs#L145).

tableMap dùng lowercase và bỏ entry trùng sau normalize. Trên server phân biệt hoa/thường, đó là hai bảng riêng.

**DB thật:** snapshot coverage complete có `edge`, `twin`, `Twin`; generator chỉ tạo `edge` và `twin`. Executor success/executedCount 2, inventory đích thiếu `Twin`. Hậu kiểm từng statement không phát hiện đối tượng đã bị loại trước khi lập plan.

**Cần sửa:** exact identifiers xuyên snapshot/diff/plan; bind khả năng phân biệt tên của server. Nếu target không biểu diễn được phải chặn, không chọn entry đầu. Test case-only tables và hậu kiểm inventory toàn schema.

### D03 — CHECK constraint bị bỏ dù snapshot báo complete

Vị trí: [schema-snapshot.cjs:756](electron/schema-snapshot.cjs#L756), [schema-diff.js:690](schema-diff.js#L690), gate [schema-migration-generator.cjs:45](electron/schema-migration-generator.cjs#L45).

Collector giữ columns/indexes/FK nhưng không giữ completeness của table CHECK constraints. Generator coi đó đủ cho CREATE_TABLE; SQL và hậu kiểm đều bỏ CHECK.

**DB thật:** nguồn `qty INT CHECK(qty > 0)`, snapshot complete, migration success. Nguồn có một CHECK, đích không có. INSERT `qty=-1` bị nguồn từ chối `ER_CHECK_CONSTRAINT_VIOLATED`, đích chấp nhận.

**Cần sửa:** collect/version/hash constraints hoặc block bảng có CHECK chưa hỗ trợ; thiếu quyền/không hiểu phải unknown. Test round-trip/enforced/disabled/dialect; không coi columns/indexes/FK là toàn schema.

### D04 — Guard original-values Sync không so sánh text chính xác

Vị trí: [data-sync-executor.cjs:219](electron/data-sync-executor.cjs#L219), DELETE tương tự tại dòng 246.

Guard dùng `column = ?` theo collation cột. Collation không phân biệt hoa/thường coi giá trị đã đổi vẫn khớp snapshot; affectedRows khác 0 không chứng minh không có xung đột.

**DB thật:** original ở preview là `'old'`, trước apply DB đã là `'OLD'` với `utf8mb4_0900_ai_ci`. Executor vẫn UPDATE thành `'new'`, COMMIT, success/committedCount 1. Thay đổi concurrent bị ghi đè. Probe dùng plan service/executor nội bộ; public Apply và bounded preview Main-owned vẫn bị khóa.

**Cần sửa:** exact guards theo contract từng kiểu: text/binary, JSON document, numeric/temporal và dữ liệu preview bị cắt. Test UPDATE/DELETE với case/accent/trailing spaces; unknown phải chặn trước ghi.

### D05 — Global handlers ghi raw error và tiếp tục sau fatal exception chưa biết

Commit mới `2489b3a`; vị trí [main.cjs:3](electron/main.cjs#L3), [main.cjs:11](electron/main.cjs#L11).

Handlers mới log nguyên error/reason, có thể chứa `.sql`, literal/password/token. uncaughtException khác lỗi connection cũng chỉ log, không có chính sách chốt task/thoát hoặc phục hồi trạng thái.

**Child process riêng:** nạp đúng đoạn đăng ký handlers của Main; reject Error có `.sql` chứa marker giả. stderr giữ marker. Uncaught exception khác loại connection vẫn cho timer tiếp tục, process cuối cùng exit 0. Evidence chỉ giữ boolean/exit status, không in marker. Không khẳng định đã có secret người dùng bị ghi log.

**Cần sửa:** logging projection allowlist/code và redaction, không log raw object. Connection drop phải gắn đúng session/task/outcome; lỗi Main chưa biết cần terminal/restart policy có kiểm soát. Test handlers production, privacy và terminal state.

## 2. Findings P2

### D06 — COMMENT còn diễn giải escape, migration vẫn báo thành công

Vị trí: [schema-diff.js:680](schema-diff.js#L680), table comment cùng formatter; hậu kiểm [schema-migration-executor.cjs:220](electron/schema-migration-executor.cjs#L220).

Sửa DEFAULT chưa áp dụng cho COMMENT: formatter chỉ nhân đôi nháy, hậu kiểm bỏ comment. **DB thật:** source comment có literal backslash+n; target có newline, executor vẫn success. Chưa tái hiện SQL injection từ comment trong lượt này.

**Cần sửa:** literal/mode contract cho column/table comments hoặc block trước DDL; hậu kiểm comment nếu cần bảo toàn. Test backslash/quote/control và SQL modes. Không tự dùng cú pháp hex DEFAULT cho COMMENT nếu chưa kiểm trên engine.

### D07 — Replica dùng sai tên sidecar; collision có thể ghép manifest khác

Vị trí: [backup-replica-manager.cjs:150](electron/backup-replica-manager.cjs#L150), [backup-file.cjs:10](electron/backup-file.cjs#L10).

Backup chuẩn dùng `${filePath}.json`, replica tìm `${filePath}.manifest.json`. **Tệp thật:** saveBackupFile tạo manifest hợp lệ; replica trả verified true nhưng manifestCopied false, canonical manifest đích không tồn tại. verified chỉ là hash SQL, chưa chứng nhận pair đầy đủ.

Ở nhánh legacy, collision làm copyAtomic đổi riêng tên manifest nhưng caller bỏ qua đường dẫn trả về. Probe nhận manifestCopied true trong khi sidecar gắn với SQL là manifest unrelated; manifest nguồn ở tên khác.

**Cần sửa:** dùng manifestPathFor/contract catalog chung; publish SQL+manifest+annotations cùng identity/basename. Collision cấp lại một tên chung hoặc từ chối; phân biệt thiếu sidecar với lỗi đọc/copy/permission/verify, không catch mọi lỗi thành “không có manifest”.

### D08 — Replica/container UI dùng kết quả cũ sau khi modal/context đổi

Vị trí: [app.js:7010](app.js#L7010), [app.js:7027](app.js#L7027).

**Renderer VM với app.js thật, IPC trì hoãn:** tạo replica → đóng modal → mở dialog khác → resolve: callback đóng luôn dialog mới. Container-info sau đổi profile/database ghi đè dialog mới bằng kết quả cũ. Không kiểm identity/generation trước tác động UI.

**Cần sửa:** capture modal/control identity và context/task revision; đối chiếu trước gọi và sau mỗi await. Callback/finally cũ không sửa view mới. Test cancel/reopen/profile change/success-error trễ và keyboard trong renderer thật. Probe hiện là VM + DOM stub, không nghiệm thu layout native.

### D09 — Error muộn connection cũ đánh dấu phiên mới là dead

Commit mới `2489b3a`; vị trí [database.cjs:1148](electron/database.cjs#L1148); SSH/stream callbacks dòng 1014–1028 cũng thiếu đối chiếu identity.

**DatabaseSession.connect thật + fake mysql factory:** connect hai lần để thay connection; phiên mới dead=false. Emit error từ connection cũ: dead=true dù connection hiện tại vẫn là object mới, ensureOpen trả SESSION_CLOSED. Probe trực tiếp xác nhận MySQL; SSH cần fixture riêng.

Test idle mới tự gắn handler giống implementation vào emitter, không kiểm handler connect() gắn, nên bỏ sót lifecycle này.

**Cần sửa:** invalidate/remove listeners tài nguyên cũ, guard identity/generation trong MySQL/SSH/stream callbacks; chỉ đóng tunnel đúng owner. Test actual connect path và late error/close sau reconnect, không thay handler production bằng handler tự viết trong test.

## 3. Tính năng còn thiếu trong kế hoạch

Đếm trực tiếp DATABASE_PRODUCT_ROADMAP.md: **51 checkbox, 22 tick, 29 chưa tick**. Đây là số tài liệu, không phải phần trăm hoàn thành. G6.1–G6.4 đang tick nhưng chưa đạt tiêu chí sau apply; G3.3 đang tick trong khi runtime scheduler vẫn interval/app-open, chưa nối calendar calculator. Cần xét lại nghiệm thu các mục này.

| Nhóm | Còn thiếu và bước tiếp theo |
| --- | --- |
| G6 migration | Sửa D01–D03/D06; fidelity datatype/index/constraint/dialect, MariaDB non-null/expression DEFAULT; full-schema drift/postconditions/uncertainty/Production matrix. Public Apply vẫn khóa. |
| G7 Data Diff/Sync | Hiện bounded ≤2.000 dòng/phía và subset PK có proof. Còn full-table/khóa mapping rộng, consistency hai server, ghi và multi-table UI nghiệm thu. Sửa D04, hoàn thiện authorization/conflict/cancel/partial-commit trước mở Apply. |
| Restore dialect/chọn đối tượng | Inventory/plan/executor có rồi; executable comments/hints, SQL mode/charset/expression/dependency chưa chứng minh vẫn bị chặn. Mở rộng theo dialect/version và marker ngoài selection, không nới unknown. |
| G3.5 crypto | Helper/container V2/IPC có rồi; còn catalog/UI, encrypted-file discovery, compatibility và recovery workflow end-to-end. Kiểm restore/export round-trip, keys/manifest và no-overwrite. |
| G3.6 replica | Sửa D07/D08; metadata pair, retry/cancel/fault/disk-full/collision và adapter remote. Không dùng bản chưa verify đủ cho retention. |
| G3.3 calendar | Cron/timezone/DST calculator có test; chưa nối scheduler/store/claim/UI thực. Còn sleep/wake/missed-run/restart/time-jump đầy đủ; chạy khi app đóng qua OS scheduler là bước riêng. |
| G0/G4 performance | Có synthetic benchmark/quota, chưa baseline và end-to-end 1/10/20 GB, SSH/TLS, peak RSS/event-loop/UI latency/fault matrix. Cần chốt hạ tầng/ngân sách và đo trước-sau. |
| G5 Editor/filter/EXPLAIN | Nhiều chức năng đã có; còn scope/parser ngoài grammar hỗ trợ, capability/dialect/operators và nghiệm thu đầy đủ. Test CTE/derived/correlation/SQL dang dở, stale metadata, schema/settings context, keyboard/undo. |
| G8 kiến trúc/UX/privacy | Sửa D05/D08/D09, rà mọi nơi lưu/log SQL, tách app/main từng phần có contract, thử quy trình với người dùng và cập nhật hướng dẫn. Audit hiện có không thay full privacy review. |
| G9 recovery/sync/release | Recovery-kit helper chưa là account/device recovery; còn vault compatibility/security, rotation/lost-key/logout/conflicts, sender/CSP/path/dependency review, Windows/Ubuntu installed/upgrade/ASAR, checksum/chữ ký và runbook. |

Ưu tiên: **D05 + D09 → D01–D03 → D04 → D07 → D06/D08**, rồi mở rộng tính năng/release. Giữ hai public Apply khóa; không tự tick roadmap từ kết quả unit xanh.

## 4. Kiểm chứng và giới hạn

| Kiểm tra trên HEAD 2489b3a | Kết quả |
| --- | --- |
| npm run check | **1.251 tổng: 1.233 pass / 0 fail / 18 opt-in skip** |
| npm run test:renderer | **101/101 pass** |
| npm run test:website | **14/14 pass** |
| npm --prefix server run check | Pass |
| npm run server:test | **17/17 pass** |
| Probe rà sâu | Tái hiện D01–D09; observation script, không phải acceptance suite |

MySQL **8.4.13** container tmpfs/loopback, hai schema ngẫu nhiên riêng được xóa trong finally; không DB người dùng. Đã dọn container sau khi tiếp tục lượt làm việc. Lệnh dọn ban đầu không được thực thi vì hệ thống duyệt tự động hết hạn mức; khi tiếp tục đã chạy thành công. Replica dùng thư mục tạm đã xóa; global errors dùng child process, không lưu marker/secret; UI dùng VM. Không chạy lại toàn engine matrix hoặc installed release. Suite xanh không phủ định probe mới.

Bằng chứng: [probe](review/gemini-2026-11-19/rereview/reproduce.cjs), [observed.json](review/gemini-2026-11-19/rereview/observed.json), [Node](review/gemini-2026-11-19/rereview/check.txt), [renderer](review/gemini-2026-11-19/rereview/renderer.txt), [website](review/gemini-2026-11-19/rereview/website.txt), [server](review/gemini-2026-11-19/rereview/server.txt), [server syntax](review/gemini-2026-11-19/rereview/server-check.txt).

Probe exit 0 chỉ nghĩa thu thập xong, không chứng nhận an toàn. Không có REVIEW_MYSQL_PORT thì chạy phần VM/file/connection/child-process; phần DB cần server loopback dùng một lần/root không mật khẩu, tự tạo/xóa schema. Container/port phiên review đã dọn. Lượt này chỉ ghi báo cáo/bằng chứng, không sửa runtime, commit hoặc push.
