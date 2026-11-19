# Sửa E01–E04 và rà lại — 19/11/2026

Đã xử lý bốn findings trong [review sau commit](CODE_REVIEW_GEMINI_2026_11_19_R3.md), baseline `a564507`. Workspace được xác minh vẫn là SqlPro, không có `Modules/PPM/Services/PPMAssessmentService.php`; lượt này thực hiện các lỗi SqlPro đã bàn giao, không sửa dự án PHP khác.

## Thay đổi

| Finding | Bản sửa | Bằng chứng |
| --- | --- | --- |
| E01 — PK/schema race và nhiều dòng | Tách một verifier dùng chung cho single/multi-table. Giữ precheck và kiểm lại schema/PK sau khi mở mọi bảng lấy metadata lock, trong **từng batch**. UPDATE/DELETE chỉ chấp nhận affectedRows đúng 1, 0 là conflict, giá trị khác là SYNC_ROW_COUNT_MISMATCH và đi qua rollback. | DB thật: DROP PK + duplicate trước batch đầu chặn trước DML cho cả UPDATE/DELETE; drift batch 2 giữ batch 1 đã commit và báo partial/committedCount đúng. Unit kiểm affectedRows=2 không COMMIT. |
| E02 — literal ENUM/SET | Dùng normalizer chỉ đổi keyword ngoài literal; kiểm cả order/name và từng semantic fact có trong plan (nullable/default/extra/collation/charset...). ENUM/SET có backslash chưa chứng minh SQL mode bị chặn. | ENUM và SET đổi pending → PENDING bị chặn trước INSERT trên hai engine, không thêm dòng. Unit kiểm single/multi-table, Unicode/quote, keyword case hợp lệ và escape unsupported. |
| E03 — thứ tự cột | Chặn thêm cột không ở cuối hoặc reorder cột hiện có bằng COLUMN_ORDER_REVIEW_REQUIRED trước DDL. CREATE/ADD_COLUMN gắn expectedColumnOrder; executor hậu kiểm toàn thứ tự cột sau từng statement. Giữ ưu tiên gate destructive khi DROP COLUMN. | Hai DB: non-append bị chặn; thêm hai cột cuối qua admission/executor thực và giữ thứ tự. Unit hậu kiểm order sai phải báo partialCommit sau DDL đã ACK và không chạy statement sau. |
| E04 — metadata/callback cũ | VERSION/TLS lưu tạm, kiểm generation và connection identity sau mỗi await trước khi công bố. raw() capture owner/generation, callback cũ reject SESSION_CLOSED trước cập nhật transaction/cache hoặc trả kết quả. | Production connect với fake driver: VERSION/TLS đến trễ đều reject, không đè version/TLS của connection mới. Rà tiếp phát hiện raw callback cũ sửa transaction status; test fail trước guard và pass sau sửa, phiên mới vẫn dùng được. |

Không triển khai FIRST/AFTER/reorder tự động trong lượt này; nhánh đó được chặn rõ, không báo schema hoàn tất khi order sai. Metadata guard Sync chỉ kiểm các fact plan thực sự mang theo; bounded report public vẫn không là quyền ghi. Giữ public Migration Apply và Data Sync Apply khóa.

## Kết quả kiểm chứng

| Phạm vi | Kết quả |
| --- | --- |
| Cùng test review-e-regressions trên baseline a564507 | **0 pass / 9 fail**, checkout tạm đã dọn |
| Regression E mới trên bản sửa | **9/9 pass** |
| Hậu kiểm order trong schema-migration-executor.test.cjs | Đạt; không chấp nhận success khi thứ tự sai |
| npm run check | **1.275 tổng / 1.253 pass / 0 fail / 22 opt-in skip** |
| Ba suite DB regression N/D/E | **27/27 pass, 0 skip**, MySQL **8.4.13**, MariaDB **11.4.13** |
| npm run test:renderer | **103/103 pass** |
| npm run test:website | **14/14 pass** |
| npm --prefix server run check | Pass |
| npm run server:test | **17/17 pass** |
| git diff --check | Pass |

[Bằng chứng](review/gemini-2026-11-19/e-fixes/), [unit](test/review-e-regressions.test.cjs), [DB](test/review-e-db.test.cjs). 27 DB tests gồm test cha/con của cả ba suite; không cộng trùng vào số Node mặc định. 22 skip gồm hai root DB opt-in mới. Không thay assertion để cho phép DML khi drift; fixture matrix được bổ sung cột id vào metadata order thực tế, expected CREATE postcondition thêm order. Lượt full suite đầu phát hiện fixture cũ và ưu tiên mã lỗi DROP bị đổi; đã bổ sung fixture và giữ lại gate destructive, chạy lại full suite đạt.

Hai container DB tạm dùng tmpfs/loopback, schema ngẫu nhiên riêng được xóa trong finally; container đã dọn. Không dùng DB người dùng. Driver giả chỉ chứng minh lifecycle callback, không thay nghiệm thu đầy đủ mạng/SSH/TLS/OS. Chưa chạy lại toàn engine/installed/release matrix.

## Review tiếp và việc chưa hoàn tất

Đã rà lại diff runtime, verifier giữa các batch, số dòng và ledger khi lỗi, generator/postcondition order, connection owner/generation và raw callback. Trong phạm vi bản sửa và các ca hồi quy nêu trên, **không còn finding E01–E04 mở và chưa xác nhận thêm finding mới chưa xử lý**. Điều này không chứng nhận toàn repository hết lỗi.

Các giới hạn triển khai vẫn còn:

- Migration: CHECK/dialect/default/type/index/constraint chưa có contract vẫn chặn; non-append/reorder mới được chặn, chưa hỗ trợ thực thi. Còn Main/Production/full-schema/uncertainty matrix trước mở Apply.
- Sync: public Apply khóa, observation tối đa 2.000 dòng/phía; còn full-table/key mapping, consistency hai server, Main-owned write authorization/cancel/partial commit và multi-table UX/acceptance đầy đủ. Không dùng helper nội bộ làm chứng cứ release-ready.
- Backup/restore: còn mở rộng dialect/selection, crypto V2 với catalog/discovery/UI/recovery, calendar nối scheduler/store/UI, remote replica và fault/cancel/disk-full/OS matrix.
- Hiệu năng/editor/kiến trúc/bảo mật/phát hành: còn benchmark end-to-end 1/10/20 GB và SSH/TLS/load, parser ngoài grammar, privacy toàn app, recovery/rotation/conflict, Windows/Ubuntu installed/upgrade/ASAR/signing/runbook.

Đếm lại roadmap: **51 checkbox, 22 tick, 29 chưa tick**; các mục đã tick vẫn cần xét tiêu chí nghiệm thu như các báo cáo trước. Không tick thêm roadmap chỉ vì sửa bugs hoặc suite xanh. Chi tiết kế hoạch còn lại giữ tại [bản sửa D, mục 3](CODE_REVIEW_GEMINI_2026_11_19_R2_FIXES.md#3-giới-hạn-và-phần-kế-hoạch-còn-lại).
