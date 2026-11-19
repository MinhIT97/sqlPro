# Review sau commit 8ee4c3f — 19/11/2026

> **Cập nhật sau sửa:** [Bản sửa E01–E04 và review tiếp](CODE_REVIEW_GEMINI_2026_11_19_R3_FIXES.md). Findings và bằng chứng bên dưới giữ lịch sử trước sửa.

**Còn 4 findings đã tái hiện: 2 P1, 2 P2.** Commit `8ee4c3f` đã lưu bản sửa D01–D09, test và báo cáo trước đó. Review này không sửa thêm runtime, không mở public Migration/Data Sync Apply. Không suy toàn repository hết lỗi từ suite xanh.

## E01 — P1: Sync kiểm tra PK trước metadata lock, rồi chấp nhận UPDATE nhiều dòng

Vị trí: [data-sync-executor.cjs:120](electron/data-sync-executor.cjs#L120), [lock:204](electron/data-sync-executor.cjs#L204), [affectedRows:252](electron/data-sync-executor.cjs#L252); DELETE có cùng điều kiện chỉ chặn số dòng bằng 0.

Columns/PK được đọc trước START TRANSACTION. Sau khi mở bảng để giữ metadata lock, executor chỉ kiểm lại engine và trigger. Concurrent DDL có thể thay PK trong khoảng giữa hai bước. UPDATE/DELETE lại coi mọi affectedRows khác 0 là thành công, nên không dừng khi một operation khớp nhiều dòng.

**Bằng chứng trên MySQL 8.4.13 và MariaDB 11.4.13:** tạo plan cho một dòng `id=1,v='old'`, sau kiểm schema và ngay trước START TRANSACTION thì connection thứ hai DROP PRIMARY KEY và chèn bản trùng. Executor UPDATE cả **2 dòng** thành `new`, trả **success=true, committedCount=1**, COMMIT. Probe dùng DataSyncPlanService và DataSyncExecutor production; hook chỉ chèn concurrent DDL tại ranh giới raw(), mọi SQL đi tới DB thật.

**Cần sửa:** giữ metadata lock rồi xác minh lại đầy đủ identity/columns/types/PK theo plan trong từng batch, trước DML. Chỉ chấp nhận đúng một dòng với UPDATE/DELETE; khác 1 rollback batch, không nhận nhiều dòng là thành công. Test cả UPDATE/DELETE, race ở đầu và giữa các batch, bảo toàn dữ liệu khi abort. Không dựa vào engine/trigger proof để suy PK còn nguyên.

## E02 — P1: Sync vẫn lowercase literal ENUM/SET khi kiểm tra schema drift

Vị trí: [data-sync-executor.cjs:130](electron/data-sync-executor.cjs#L130), [nhánh một bảng:148](electron/data-sync-executor.cjs#L148).

Bản sửa D01 bảo toàn type literals ở migration, nhưng hai nhánh kiểm schema của Sync vẫn dùng `actual.type.toLowerCase() !== expected.type.toLowerCase()`. Đổi giá trị ENUM chỉ khác case không bị phát hiện.

**Bằng chứng trên cả hai engine:** plan lấy cột `ENUM('pending','done')`, sau đó DB được ALTER thành `ENUM('PENDING','DONE')` với collation không phân biệt case. Executor không báo TARGET_SCHEMA_DRIFT, INSERT `pending` và COMMIT thành công; giá trị lưu là **PENDING**. Đây là thay đổi nội dung dữ liệu so với plan. Probe trực tiếp kiểm ENUM; SET dùng chung phép so sánh nhưng chưa có ca DB riêng trong lượt này.

**Cần sửa:** chuẩn hóa keyword bên ngoài literal, giữ literal/escape theo contract giống migration; kiểm metadata dưới lock như E01. Test enum/set có case/quote/Unicode, unsupported escape phải block; chứng minh không phát DML khi drift. Đồng thời kiểm đầy đủ metadata ảnh hưởng semantics, không chỉ tên và type lowercase.

## E03 — P2: ADD_COLUMN bỏ vị trí cột nhưng migration báo success

Vị trí: [schema-migration-generator.cjs:297](electron/schema-migration-generator.cjs#L297), [postcondition:322](electron/schema-migration-generator.cjs#L322), [executor:224](electron/schema-migration-executor.cjs#L224).

Generator chỉ ADD COLUMN, không FIRST/AFTER hoặc chặn non-append. Hậu kiểm đọc theo ORDINAL_POSITION nhưng tìm từng cột theo tên; không kiểm vị trí.

**Bằng chứng trên cả hai engine:** nguồn `[id, added, tail]`, đích `[id, tail]`. Candidate ready; executor success, đích thành **[id, tail, added]**. Do đó SELECT * và INSERT không có danh sách cột có contract khác nguồn dù migration báo thành công. Chưa tái hiện dữ liệu ứng dụng bị ghi nhầm; probe chỉ xác nhận schema order sai.

**Cần sửa:** gắn ordinal/anchor vào plan và sinh FIRST/AFTER có kiểm chứng hoặc chặn trường hợp không thêm cuối. Hậu kiểm thứ tự cột theo trạng thái dự kiến sau từng statement, bao gồm nhiều cột mới; không chỉ kiểm tên/type/default. Nếu cố ý không hỗ trợ đồng bộ thứ tự, plan phải thể hiện chưa hoàn tất và không báo tương đương schema.

## E04 — P2: connect cũ vẫn ghi đè version/TLS sau reconnect

Vị trí: [database.cjs:1164](electron/database.cjs#L1164).

Generation chỉ được kiểm sau connection.connect(). Hai await đọc VERSION/TLS phía sau chưa đối chiếu generation và connection identity trước khi ghi thuộc tính dùng chung hoặc trả thành công. D09 đã chặn listener cũ, chưa chặn completion metadata cũ.

**Bằng chứng:** gọi production DatabaseSession.connect() với mysql factory giả, giữ phản hồi VERSION của connect đầu; reconnect hoàn tất với version `8.4-new`, sau đó trả phản hồi cũ `5.7-old`. Connect đầu vẫn resolve thành công, connection hiện hành vẫn là connection mới nhưng **session.version=5.7-old**. Đây là probe driver giả, không DB/SSH race thực; chưa chứng minh có đường UI chạy sai SQL từ version cũ. TLS có cùng cấu trúc await chưa guard, probe này trực tiếp xác nhận version.

**Cần sửa:** giữ kết quả metadata trong biến riêng, kiểm generation/connection identity sau từng await và trước công bố. Completion cũ phải reject SESSION_CLOSED, chỉ cleanup tài nguyên do nó sở hữu; không đọc TLS trên connection mới thay cho owner cũ. Test VERSION/TLS chậm, close/reconnect/late error ở từng phase.

## Kiểm tra và phạm vi

- `npm run check`: **1.263 tổng / 1.243 pass / 0 fail / 20 opt-in skip**.
- Electron **103/103**, website **14/14**, server syntax đạt, server tests **17/17**; git diff --check đạt.
- Probe DB: ba tình huống E01–E03 tái hiện trên **MySQL 8.4.13** và **MariaDB 11.4.13**. Đây là observation script, không phải test acceptance đã pass. E04 dùng driver giả gọi connect production.
- Website lần đầu trong sandbox không mở được loopback; chạy lại với quyền mở test HTTP server đạt 14/14. Không sửa assertion/runtime để vượt test.
- DB dùng hai container tmpfs/loopback riêng, schema ngẫu nhiên được xóa trong finally, cả hai container đã dọn. Không dùng DB người dùng. Chưa chạy lại toàn engine/installed/release matrix.

[Bằng chứng/probe](review/gemini-2026-11-19/postcommit/), [MySQL observations](review/gemini-2026-11-19/postcommit/observed-mysql.json), [MariaDB observations](review/gemini-2026-11-19/postcommit/observed-maria.json). Probe exit 0 nghĩa thu thập xong, không chứng nhận an toàn; script chỉ chạy DB khi đặt SQLPRO_REVIEW_MYSQL_PORT cho server loopback dùng một lần/root không mật khẩu.

Public Apply vẫn khóa ở Main/service; không có bằng chứng vượt khóa hoặc DB người dùng đã bị ảnh hưởng. E01/E02 là lỗi có nguy cơ dữ liệu ở executor nội bộ cần sửa trước mở tính năng. Kế hoạch chưa làm vẫn theo [mục 3 bản sửa D](CODE_REVIEW_GEMINI_2026_11_19_R2_FIXES.md#3-giới-hạn-và-phần-kế-hoạch-còn-lại), **29/51 checkbox chưa tick**; không cập nhật checkbox chỉ vì commit/suite xanh.

Ưu tiên tiếp: **E01 → E02 → E03 → E04**, bổ sung regression acceptance thất bại trước sửa rồi đạt sau sửa. Findings đang mở, chưa được sửa trong lượt review này.
