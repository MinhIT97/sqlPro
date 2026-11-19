# Sửa F01–F06 — 19/11/2026

Đã xử lý cả sáu nhóm lỗi trong [review tính năng tại 60cdb20](CODE_REVIEW_FEATURES_2026_11_19.md). Public Migration Apply và Data Sync Apply tiếp tục khóa. Chỉ các nhánh SQL đã hỗ trợ mới được xuất; một số trường hợp được sửa bằng cách chặn rõ ràng, chưa triển khai đầy đủ tính năng đó.

## 1. Thay đổi

| Finding | Bản sửa | Kiểm chứng |
| --- | --- | --- |
| F01 — unknown thành absent/DROP | Xóa collector schema cũ ở renderer. UI gọi schemaSnapshot hai phía rồi createMigrationPlan tại Main; snapshot partial/lỗi dừng trước plan. Modal/profile/database/revision và expiry guards chặn completion, export và nút cũ. | App.js VM + DB thật: denied columns nguồn làm partial, không gọi plan hoặc sinh DROP. Native Electron kiểm partial và completion cũ không thay modal/focus mới. |
| F02 — index/CHECK/dialect | UI không tự đổi metadata index/column hoặc cố định engine. Main collector giữ unique đúng; CHECK/unsupported được gate chung chặn. Xóa các nút cho phép DROP khỏi luồng chưa hỗ trợ; không biến thông tin thiếu thành schema có thể xuất. | MySQL/MariaDB: SQL Main qua UI tạo index thường, chèn hai label trùng thành công. CHECK chặn SQL. Native test chạy so sánh thật trong renderer, kiểm nội dung copy và Editor, không chỉ mở modal. |
| F03 — settings wrapper | Formatter mặc định không sinh SET checks/mode; gọi wrapForeignKeys=true bị từ chối. UI dùng sqlScript đã được Main tạo, không gọi formatter khác. Header names được giữ trên một dòng comment. Thông báo UI ghi đúng việc giữ thiết lập phiên. | Script thành công hoặc CREATE lỗi đều giữ FK/UNIQUE/sql_mode trên hai engine. Unit kiểm không SET, override bị chặn, tên có newline không thành SQL mới. |
| F04 — cascade ngoài scope | Metadata safety từ chối mọi inbound FK đến khi có dependency closure được phê duyệt; đọc lại trước commit sau DML. Không coi I_S rỗng là proof nếu tài khoản không thấy đủ metadata: SHOW GRANTS cần direct global SELECT/TRIGGER, không chấp nhận role-only/partial revoke/shape sai. Không tự cấp quyền. | DELETE CASCADE/SET NULL và UPDATE khóa cha không đổi parent/child ngoài plan; account chỉ có SELECT/DELETE parent bị chặn trước DML. Race thêm FK sát DELETE giữ child marker: DDL bị lock hoặc executor thấy FK mới và rollback. Unit kiểm cả dependency phát hiện sau DML. |
| F05 — quyền/context stale | Capture bản sao profile, full fingerprint gồm credentials, fingerprint policy, generation và TTL. Đọc lại authoritative profile sau các phase có await và trước DML/COMMIT/batch. Production receipt phải khớp token/digest/target fingerprint và expiry; Main thêm generation hook và fingerprint vào receipt. Rollback/close vẫn chạy khi policy bị thu hồi. | Read-only/Production/password/logout/delete profile giữa hai batch chỉ commit batch đầu; drift trong DML rollback batch đang mở. DB thật xác nhận chỉ dòng batch đầu được ghi. Receipt thiếu/sai/hết hạn bị từ chối trước SQL. |
| F06 — preview khác candidate | SchemaMigrationService preview dùng cùng SchemaMigrationGenerator với candidate; không còn formatter/gates riêng cho preview. Unsupported trả statements=[], sqlScript='', exportSupported=false. Projection tách khỏi cache; Apply vẫn false. | Cùng snapshot qua preview/candidate có cùng blockReason. MariaDB DEFAULT chưa hỗ trợ bị chặn; MySQL control round-trip vẫn lưu pending đúng. |

Các tệp chính: [app.js](app.js), [schema service](electron/schema-migration-service.cjs), [formatter](schema-diff.js), [Sync executor](electron/data-sync-executor.cjs), [metadata visibility proof](electron/sync-metadata-visibility.cjs), [Main](electron/main.cjs). `agent.md` được cập nhật theo contract mới.

## 2. Kiểm chứng

| Phạm vi | Kết quả |
| --- | --- |
| Cùng 9 regression F trên baseline 60cdb20 | **0 pass / 9 fail**, checkout tạm đã dọn |
| Regression F + parser metadata visibility | **10/10 pass** |
| npm run check | **1.287 tổng / 1.263 pass / 0 fail / 24 opt-in skip** |
| DB regression N/D/E/F | **43/43 pass, 0 skip**, MySQL **8.4.13**, MariaDB **11.4.13** |
| npm run test:renderer | **105/105 pass**, Electron/preload thật, IPC giả dùng schema service/generator thật |
| npm run test:website | **14/14 pass** |
| npm --prefix server run check | Pass |
| npm run server:test | **17/17 pass** |
| git diff --check | Pass |

[Bằng chứng](review/gemini-2026-11-19/f-fixes/), [unit](test/review-f-regressions.test.cjs), [DB](test/review-f-db.test.cjs), [visibility grammar](test/sync-metadata-visibility.test.cjs). Số 43 gồm test cha và con của bốn suite trên hai engine; không cộng trùng vào Node default hoặc mốc DB trước. 24 skip gồm hai root DB F mới cần môi trường riêng.

DB tests chạy app.js trong VM với DOM stub và collector/service/SQL thật. Native renderer tests kiểm Main API được gọi thay legacy metadata, SQL clipboard bằng IPC, Enter mở đúng profile/database Editor, cửa sổ 940 px, partial/CHECK không có export và late completion giữ focus dialog mới. Không phải nghiệm thu installed với DB Production.

Các fake session cũ được bổ sung empty FK inventory và grant proof rõ ràng. Test B01 từng xác nhận bug collector cũ được thay bằng assertion Main partial snapshot không tạo SQL. Test formatter đổi sang giữ settings và từ chối override; không bỏ kiểm tra bảo toàn dữ liệu để vượt test.

Các lượt đầu không che giấu: full suite phát hiện fake metadata cũ không trả proof FK, expected wrapper và test còn tìm collector đã xóa; đã sửa fixture/contract assertions, chạy lại đạt. Test DB bổ sung FK chéo schema ban đầu cleanup sai thứ tự gây giữ connection; sửa xóa fixture child trước parent DB và luôn đóng admin trong finally. Native test lần đầu so sánh Promise clipboard với string; sửa await trong harness, vẫn yêu cầu đúng toàn bộ SQL. Các lỗi harness này không được tính là lỗi runtime đã sửa.

Chỉ dùng hai container tmpfs/loopback do lượt này tạo và schema/user fixture ngẫu nhiên; đã dọn cả container, kể cả fixture từ lượt cleanup thất bại. Không dùng DB người dùng. Chưa chạy lại full installed/engine-version/security/release matrix.

## 3. Giới hạn còn lại

- **Migration export hiện chỉ hỗ trợ CREATE_TABLE, append ADD_COLUMN và ADD_INDEX trong allowlist đã chứng minh.** DROP, mutation/reorder, FK, CHECK, expressions/default/dialect chưa hỗ trợ không xuất SQL. Đó là block có chủ đích, không phải hoàn thành round-trip cho mọi schema. Comparison có schema unsupported hiện dừng kèm lý do để tránh báo tương đương sai.
- **Sync vẫn experimental và public Apply khóa.** Mọi inbound FK bị chặn, kể cả child có trong multi-table plan; chưa hỗ trợ dependency closure được phê duyệt. Cần metadata visibility trực tiếp global SELECT/TRIGGER; role-only/partial-grant không được suy đủ quyền. Đây là ranh giới thử nghiệm, không có thao tác tự tăng quyền. Chưa nghiệm thu toàn timeout/network/cancel/approval/dependency/partial-commit matrix để mở tính năng.
- Manual SQL trong Editor vẫn cần người dùng xem xét và chịu policy hiện có. Preview không hứa tránh DDL implicit commit, table rebuild/lock hoặc drift sau lúc xuất tệp.
- Data Diff Main keyset/UI wiring, full-table/unique-key mapping/consistency hai server; crypto/catalog/discovery/recovery; calendar/store/scheduler/UI và remote replica còn ở các gói tiếp theo.
- Performance 1/10/20 GB, SSH/TLS/load, privacy/UX toàn app, người dùng nghiệm thu, installed Windows/Ubuntu/upgrade/ASAR/signing/runbook chưa đủ bằng chứng hoàn tất.

Đếm lại roadmap vẫn **51 checkbox, 22 tick, 29 chưa tick**; không tự tick do sửa bugs. Trong phạm vi các ca F đã kiểm chứng không còn finding F01–F06 mở; không tuyên bố toàn repository hết lỗi. Bản sửa này chưa commit.
