# Sửa findings D01–D09 — 19/11/2026

Đã xử lý 9 nhóm lỗi xác nhận trong [review R2](CODE_REVIEW_GEMINI_2026_11_19_R2.md), trên baseline `2489b3a`. Một số trường hợp chưa có contract an toàn được chặn trước DDL; đây không phải triển khai đầy đủ các khả năng đó. Public Migration Apply và Data Sync Apply tiếp tục khóa.

## 1. Thay đổi và bằng chứng

| Finding | Bản sửa | Kiểm chứng |
| --- | --- | --- |
| D01 — ENUM/SET | Chuẩn hóa keyword bên ngoài literal, giữ case/quote/Unicode khi diff, sinh DDL và hậu kiểm COLUMN_TYPE. Literal có backslash bị chặn với COLUMN_TYPE_SQL_MODE_UNSUPPORTED. | Regression thuần và round-trip DB ENUM/SET trên cả hai engine, INSERT giá trị gốc thành công. |
| D02 — identifier case | Map/compare dùng tên chính xác. Collector đọc và gắn lower_case_table_names vào scope/hash; có tên bảng khác case nhưng cùng dạng lowercase thì chỉ cho phép khi đích xác minh mode 0. | Twin/twin được giữ đủ qua diff và tạo trên cả hai engine; thiếu mode hoặc mode 1/2 bị chặn trước DDL. |
| D03 — CHECK | Collector giữ trạng thái đọc inventory CHECK trong snapshot/hash. Metadata lỗi/thiếu thành unknown/partial; generator và preview service chặn CHECK chưa hỗ trợ. | CHECK có thật được phát hiện trên MySQL/MariaDB và chặn trước tạo bảng; fixture thiếu quyền/shape sai không cấp quyền migration. |
| D04 — conflict text | UPDATE/DELETE đòi original snapshot đủ cột. Text/ENUM/SET so sánh CAST AS BINARY; JSON so sánh document qua JSON_EXTRACT trên cùng engine; giá trị không hỗ trợ bị từ chối. | UPDATE và DELETE đều phát hiện case/accent/trailing-space drift trên collation không phân biệt; dữ liệu concurrent giữ nguyên. Test snapshot thiếu cột không phát DML. |
| D05 — fatal errors | Main đăng ký handler dùng mã sự kiện cố định, không log error/message/stack/SQL/rejection object. Unhandled fatal kết thúc process với exit 1. | Child process dùng module production: exception/rejection không lộ marker, không tiếp tục timer, exit 1; kiểm wiring Main. |
| D06 — COMMENT | Giữ whitespace comment, escape nháy bằng doubling. Backslash/control bị chặn cả ở gate và formatter; column comment tham gia semantic postcondition. | Quote/whitespace được bảo toàn; backslash/control bị chặn trước DDL. DB xác nhận safe comment và chặn unsupported comment. |
| D07 — replica metadata | Đọc manifest canonical .sql.json, kèm annotations và legacy nếu có; lỗi đọc/shape/hash không bị coi là thiếu. Stage và verify trước, chọn chung basename, hard-link metadata trước và SQL cuối, không ghi đè; collision dọn đúng inode sở hữu. Retry hữu hạn chỉ cho lỗi I/O transient khi staging. | Tệp thật: canonical/annotations/legacy giữ nguyên, collision không ghép metadata khác; corrupt manifest bị chặn; lỗi công bố sidecar không để SQL; EIO staging retry đạt. T05 cũ kiểm race tại final link thay vì staging. |
| D08 — stale UI | Revision/identity/modal-open/profile/database guard trước và sau await. Callback, error và finally cũ không sửa dialog mới; nút detached không gọi IPC. | VM và Electron thật: delayed replica/container, cancel/reopen/profile change giữ dialog/focus mới, không mở lại modal đã đóng. |
| D09 — connection ownership | MySQL/SSH/stream listener gắn generation và owner. Close vô hiệu hóa thế hệ trước; cleanup chỉ đóng tunnel đúng owner. | Gọi production connect/openSshTunnel với driver giả: lỗi cũ không làm dead hoặc đóng tunnel mới; lỗi current vẫn vô hiệu hóa đúng phiên. Bỏ test tự cài handler trùng implementation. |

Test mới: [review-d-regressions.test.cjs](test/review-d-regressions.test.cjs), [review-d-db.test.cjs](test/review-d-db.test.cjs). Các fixture hiện có được bổ sung CHECK completeness và comment hậu kiểm; không bỏ assertion dữ liệu hay mở public Apply để vượt test.

## 2. Kết quả kiểm tra

| Phạm vi | Kết quả |
| --- | --- |
| Regression mới trên baseline 2489b3a | **0 pass / 11 fail**; cùng 11 nhóm test đạt trên bản sửa. Chạy trong checkout tạm đã dọn. |
| Regression mới trên bản sửa | **11/11 pass** |
| npm run check | **1.263 tổng / 1.243 pass / 0 fail / 20 opt-in skip** |
| DB regression 19/11, hai suite N và D | **17/17 pass, 0 skip**, MySQL **8.4.13** và MariaDB **11.4.13** |
| npm run test:renderer | **103/103 pass**, Electron/preload thật với IPC giả |
| npm run test:website | **14/14 pass** |
| npm --prefix server run check | Pass |
| npm run server:test | **17/17 pass** |
| git diff --check | Pass |

[Bằng chứng thực thi](review/gemini-2026-11-19/d-fixes/): before, unit, check, database, renderer, website, server, server-check. 17 DB tests gồm test cha và con của hai suite; không cộng trùng với Node suite hoặc số matrix 18/11. Hai DB container dùng tmpfs/loopback và schema ngẫu nhiên riêng, đã dọn sau kiểm tra; không dùng database người dùng. Evidence review R2 giữ nguyên làm lịch sử, probe observation cũ không dùng làm acceptance sau sửa.

## 3. Giới hạn và phần kế hoạch còn lại

- Migration: chưa hỗ trợ CHECK round-trip/expression/enforcement, ENUM/SET có backslash, COMMENT có backslash/control, MariaDB non-null/expression DEFAULT và toàn bộ datatype/index/constraint/dialect. Đây là các nhánh bị chặn có chủ đích; còn full-schema drift/Production/uncertainty matrix trước mở Apply.
- Data Diff/Sync: public Apply khóa; bounded observation tối đa 2.000 dòng/phía không là quyền ghi. Còn full-table/key mapping, consistency, Main-owned authorization và multi-table UI/acceptance. JSON guard mới không chứng nhận toàn bộ numeric/temporal/dialect contract.
- Restore: SQL mode/charset/executable comments/hints/expression/dependency chưa chứng minh vẫn chặn; cần mở rộng có test theo version.
- Backup: còn tích hợp crypto V2/catalog/discovery/UI/recovery, calendar với scheduler/store/claim/UI, adapter remote và cancel/disk-full/OS fault matrix. Replica verified chỉ xác nhận hash SQL đã copy; không chứng nhận restore thành công, file-identity manifest mới hay atomicity qua mất điện. Không dùng làm bằng chứng đủ cho retention tự động.
- Main fatal: exit 1 là terminal policy cho lỗi không có owner đã xác minh. Không hứa rollback mọi thao tác đang ghi; khi mất ACK vẫn phải coi outcome chưa chắc chắn theo contract tác vụ.
- Hiệu năng/UX/bảo mật/phát hành: chưa benchmark end-to-end 1/10/20 GB, SSH/TLS/load/peak RSS; còn grammar editor ngoài scope, privacy review toàn app, chia module, recovery/rotation/conflict và Windows/Ubuntu installed/upgrade/ASAR/signing/runbook.

Roadmap hiện còn **29/51 checkbox chưa tick**; một số mục đã tick như G6 và calendar vẫn cần xét nghiệm thu như review R2. Không thay checkbox từ việc sửa lỗi này. Chưa chạy lại toàn bộ engine/installed/release matrix và không tuyên bố phần mềm hết mọi lỗi.
