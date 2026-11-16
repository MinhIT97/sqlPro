# Roadmap nâng cấp SqlPro cho quản trị database

Ngày lập: 11/11/2026. Baseline đọc từ workspace phiên bản 0.3.12, gồm thay đổi chưa commit. Trạng thái: kế hoạch triển khai, không phải báo cáo tính năng đã hoàn thành.

## 1. Mục tiêu và cách dùng

Cập nhật 12/11/2026 sau đợt 1: roadmap có 51 đầu việc trong 10 nhóm. G0–G2 đã triển khai nhiều phần nhưng chưa đủ toàn bộ tiêu chí nghiệm thu. G3–G9 còn **7 nhóm lớn với 36 đầu việc chưa hoàn tất**; một số phần nền như gợi ý SQL/EXPLAIN đã có. Không đồng nhất số checkbox với số tính năng chưa có hoặc dùng nó để suy phần trăm hoàn thành. Tiến độ và bằng chứng mới nhất ở [ROADMAP_PROGRESS.md](ROADMAP_PROGRESS.md).

Đưa SqlPro thành công cụ quản trị MySQL/MariaDB hằng ngày: giảm thao tác nhầm, kiểm soát transaction, backup có thể phục hồi được, vận hành database lớn mà giao diện vẫn phản hồi, và hỗ trợ so sánh/migration có thể xem xét trước khi chạy.

Tài liệu này cập nhật thứ tự ưu tiên sau đánh giá ngày 11/11 và bao phủ toàn bộ đề xuất trong cuộc trao đổi. `IMPLEMENTATION_PLAN.md` là tham chiếu lịch sử và các tình huống lỗi chi tiết; khi mô tả hiện trạng khác nhau, phải xác minh code/test trước khi tạo ticket. Không coi mục cũ là chưa làm chỉ vì chưa có dấu hoàn tất.

Phạm vi gồm Electron, renderer, lưu trữ cấu hình, backup, SQL, test, CI, tài liệu và server đồng bộ tùy chọn. PostgreSQL/SQL Server, HA/replication administration và PITR từ binlog là hướng nghiên cứu sau roadmap này, không phải tính năng cam kết trong đợt triển khai.

Chỉ lập kế hoạch trong thay đổi này. Không tự chạy migration, sửa database thật, lên lịch backup thật hoặc phát hành bộ cài.

Cập nhật 16/11/2026: G5.1 đã triển khai và qua kiểm thử logic/Electron cho phần diễn giải EXPLAIN dạng bảng; G3–G9 còn **35 đầu việc lớn chưa hoàn tất**. Phần sau `81d0228` được review/chốt đợt 8; bằng chứng và giới hạn ở [ROADMAP_PROGRESS.md](ROADMAP_PROGRESS.md). Đã thêm các phần G5.2: chọn/xem JSON/TREE, so sánh quan sát có binding SQL/database/phiên, tùy chọn đọc một danh sách thiết lập phiên và SHOW CREATE TABLE cho một bảng trực tiếp trước/sau, cùng ANALYZE riêng có xác nhận thực thi. Còn schema context đầy đủ (JOIN/CTE/view/dependency), bind context, toàn bộ thiết lập riêng theo engine và diễn giải/đối chiếu semantics plan. SHOW CREATE chỉ đối chiếu văn bản server trả về, không chứng nhận toàn schema. Đây không phải nghiệm thu toàn G5 hoặc phát hành.

## 2. Hiện trạng cần bảo toàn

| Khu vực | Đã quan sát trong code | Công việc tiếp theo |
| --- | --- | --- |
| Kết nối | TLS/SSH, kiểm tra host key, registry nhiều phiên; test kết nối mới xác thực TLS | Kiểm chứng migration profile cũ; thêm môi trường và chế độ chỉ đọc |
| Transaction | Theo dõi transaction/autocommit; savepoint trong một số thao tác; cảnh báo khi ngắt phiên | Trạng thái thường trực, điều khiển rõ phạm vi phiên và tab |
| SQL và bảng | Nhiều tab, autocomplete, format, EXPLAIN, giới hạn kết quả, kiểm tra xung đột khi ghi | Policy ghi dữ liệu, autocomplete theo scope, lọc nhiều điều kiện |
| Backup | Snapshot InnoDB, manifest/checksum, đổi tên, chi tiết metadata và quét SQL qua worker | Hủy/cache quét, phục hồi thử, chọn đối tượng, lịch/retention, nén/mã hóa |
| Hiệu năng | Streaming, keyset khi phù hợp, COUNT theo yêu cầu, kết quả lớn có giới hạn | Benchmark có thể tái tạo, tối ưu lọc/cache/render theo profile |
| Bảo mật | Main giữ secret; preload facade; renderer isolation; IPC có wrapper | Kiểm chứng toàn bộ đường ghi, CSP, log và tính năng mới |
| Bảo trì | Module thuần và bộ test đã có | Tách dần app.js/database.cjs; cập nhật tài liệu và kiểm chứng bộ cài |

Kết quả đã quan sát ở lượt làm trước: `npm run check` pass 46 nhóm test; Electron smoke pass 47/47. Website/server test chưa pass trong môi trường thực thi lúc đó. Đây không phải baseline chứng nhận phát hành: G0 phải chạy lại tại commit được chốt và phân loại lỗi môi trường/lỗi sản phẩm. Chưa có số đo xác nhận tải 10–20 GB.

## 3. Thứ tự, phụ thuộc và ước lượng

Ước lượng là ngày công kỹ thuật cho một người làm tuần tự, gồm thiết kế/code/test/tài liệu, chưa tính chờ hạ tầng, chứng thư, review hay phản hồi người dùng. Sau G0, cập nhật từng khoảng theo kết quả discovery. Không chuyển thành ngày giao cố định trước khi có baseline.

| Mốc | Phạm vi | Phụ thuộc | Ngày công dự kiến |
| --- | --- | --- | --- |
| G0 | Kiểm kê, baseline, fixture và thiết kế các hợp đồng chung | Không | 3–5 |
| G1 | Bảo vệ production, policy ghi và transaction | G0 | 10–16 |
| G2 | Hoàn thiện chi tiết backup, quét và phục hồi thử | G1 | 10–16 |
| G3 | Phục hồi chọn đối tượng, lịch backup, retention, nén/mã hóa | G2 | 20–32 |
| G4 | Đo và tối ưu hiệu năng | Baseline G0; kiểm chứng lại G2/G3 | 8–14 |
| G5 | SQL Editor, bộ lọc và công cụ chẩn đoán | G1, G4 | 15–24 |
| G6 | So sánh schema và migration | G1, G2, G5 | 12–20 |
| G7 | So sánh dữ liệu và đồng bộ có xem trước | G4, G6 | 12–20 |
| G8 | Nhật ký thao tác, UX và hoàn thiện kiến trúc | Khởi đầu G1; kết thúc G7 | 8–14 |
| G9 | Đồng bộ tùy chọn, kiểm chứng bảo mật và phát hành | Các mốc được đưa vào bản phát hành | 8–14 |

Tổng sơ bộ: **106–175 ngày công** cho toàn phạm vi, chưa có dự phòng. Dành thêm 20–30% cho tương thích, sự cố dữ liệu lớn và điều chỉnh UX. Mỗi mốc chia thành nhiều PR nhỏ; mốc chưa đủ tiêu chí không được gắn nhãn hoàn tất. Refactor và tài liệu đi cùng từng PR, phần G8 là công việc còn lại, không chờ cuối mới tách mã.

Các đợt giao sản phẩm: A = G0–G1; B = G2; C = G3–G4; D = G5; E = G6–G7; F = hoàn tất G8–G9. Mỗi đợt có thể phát hành beta riêng sau kiểm chứng, không cần đợi toàn roadmap.

## 4. G0 — baseline và thiết kế chung

- [ ] G0.1 Chụp commit, diff hiện có, phiên bản OS/Node/Electron/DB; kiểm kê chức năng hiện tại. Giữ thay đổi đang có; phân biệt phần đã kiểm chứng và phần chỉ thấy trong code.
- [ ] G0.2 Chạy lại toàn bộ check, dựng MySQL/MariaDB thử nghiệm với tài khoản chỉ đọc và ghi; chốt phiên bản hỗ trợ trong ma trận CI.
- [ ] G0.3 Fixture gồm PK đơn/ghép/không PK, FK vòng, view phụ thuộc, routine/trigger/event/DEFINER, InnoDB/mixed engine, Unicode, BLOB/JSON, BIGINT/DECIMAL, DDL concurrent và file lỗi. Mọi test ghi phải kiểm tra marker database thử nghiệm.
- [ ] G0.4 Chốt hợp đồng session identity/generation, policy ghi, task lifecycle, metadata version và audit event. Xác định tab nào dùng chung session; không suy diễn một tab là một transaction độc lập.
- [ ] G0.5 Benchmark nhỏ/vừa/lớn trên cùng cấu hình: ít/nhiều bảng, local/SSH/TLS, file 1/10/20 GB nếu đủ hạ tầng. Thu thời gian, throughput, peak RSS/heap, event-loop delay, UI latency, CPU và dung lượng tạm.

Nghiệm thu: báo cáo có cách tái chạy, commit và môi trường; failure được phân loại; hạng mục không thử được ghi rõ lý do. Chốt ngân sách RAM và tập phép đo UI trước khi tối ưu. Không dùng ba mẫu throughput để khẳng định p95 đáng tin cậy; lấy nhiều mẫu tương tác UI, báo median/range cho ít lượt transfer.

## 5. G1 — bảo vệ production và transaction

- [ ] G1.1 Thêm `environment` Local/Staging/Production và màu profile; migration profile cũ mặc định không phân loại, không tự đoán production theo hostname. Hiện tên kết nối/database tại tab, editor, dialog ghi và thanh trạng thái; dùng chữ cùng màu.
- [ ] G1.2 Chế độ chỉ đọc: ưu tiên tài khoản DB có quyền chỉ đọc; thêm policy tại main cho toàn bộ đường ghi (SQL, grid, import, restore, copy, migration). Phân tích batch/comment/CTE/routine; câu chưa phân loại được bị từ chối trong chế độ chỉ đọc của app. Không tuyên bố bộ phân tích SQL thay thế quyền DB.
- [ ] G1.3 Policy production: preview SQL có placeholder/tham số cho thao tác UI; che giá trị nhạy cảm mặc định; xác nhận đích và thao tác DROP/TRUNCATE/ghi thiếu điều kiện. Tách cảnh báo theo cú pháp khỏi dự báo số dòng; không chạy COUNT tốn kém hoặc EXPLAIN ANALYZE ngầm.
- [ ] G1.4 Thanh transaction hiển thị session, autocommit, trạng thái, thời điểm bắt đầu quan sát; Commit/Rollback chỉ tác động session đã chụp. Không cho commit xen vào tác vụ bận. Cảnh báo DDL có thể implicit commit; đồng bộ lại trạng thái từ server sau lỗi/reconnect.
- [ ] G1.5 Đóng/đổi/ngắt kết nối: báo đúng transaction chưa kết thúc; giữ pin session đang có transaction; không tự chạy lại câu ghi sau mất mạng. Xác định và trình bày rõ quan hệ tab/session.

File chính: `electron/store-schema.cjs`, `store.cjs`, `session-registry.cjs`, `database.cjs`, `main.cjs`, `preload.cjs`, `app.js`, `style.css`, test tương ứng. Module mới dự kiến: policy SQL thuần và controller transaction.

Nghiệm thu: không đường IPC ghi nào vượt policy; profile cũ đọc được; tab khác không commit nhầm session; test batch/CTE/comment, quyền thiếu, mất mạng và phản hồi đến muộn. Production có đích nhìn thấy ở mọi điểm xác nhận.

## 6. G2 — backup dễ hiểu và có thể kiểm chứng phục hồi

- [ ] G2.1 Hoàn thiện tên/ghi chú, nguồn, lựa chọn backup, consistency, cảnh báo engine/DDL, phiên bản app/DB, checksum và lịch sử kiểm tra. Tách trạng thái ghi tệp, checksum, phục hồi thử; không dùng một dấu tích chung.
- [ ] G2.2 Quét SQL: taskId, tiến độ, cancel, hàng đợi hữu hạn, timeout và giới hạn kết quả; gộp yêu cầu trùng. Cache theo profile/database/id và file identity; vô hiệu khi đổi nội dung. Kiểm tra tệp thay đổi trong/sau quét. Không dùng cache stale để cho phép restore.
- [ ] G2.3 Phục hồi thử bằng kết nối riêng vào database sandbox do ứng dụng tạo và nhận diện; có preflight quyền/dung lượng, quota, timeout, hủy và cleanup. Không đụng database người dùng trùng tên; còn sandbox sau lỗi phải hiển thị và cho dọn có kiểm tra ownership.
- [ ] G2.4 Đánh giá schema/đối tượng, số dòng theo mức đáng tin và hash dữ liệu có canonicalization khi khả thi. Phạm vi không xác minh được phải là unknown. Đối với SQL có schema ghi rõ, dùng rewrite có phân tích và kiểm chứng hoặc báo không hỗ trợ sandbox; không replace tên bằng chuỗi toàn cục. Không nới kiểm tra scope của restore hiện tại.
- [ ] G2.5 Lưu báo cáo gắn hash tệp, phiên bản server, thời gian và phạm vi xác minh. Chạy fixture restore lỗi/hủy/disk full/file đổi; kết quả không được báo hoàn tác toàn bộ khi DDL đã thay đổi đích.

Nghiệm thu: backup cũ vẫn đọc được; hủy quét giải phóng worker; không trộn kết quả khi đổi selection; phục hồi thử không thể chọn nhầm DB thật; thành công có bằng chứng đối chiếu. Nội dung backup không được coi là tin cậy; sandbox cần tài khoản DB hạn chế quyền vì routine/trigger có thể có tác động gián tiếp.

## 7. G3 — phục hồi chọn đối tượng và vận hành backup

- [ ] G3.1 Inventory theo bảng/view/routine/trigger/event; chọn cấu trúc/dữ liệu; dependency graph, xung đột, thứ tự FK/view/routine và chính sách đích rõ ràng. Trường hợp dependency động không phân tích được cần cảnh báo/báo không hỗ trợ; không tự bỏ qua lỗi.
- [ ] G3.2 Tạo execution plan bất biến gắn hash tệp và selection; preview CREATE/DROP/ghi dữ liệu; preflight lại sát lúc chạy. Bảo đảm mỗi statement được chọn đúng đối tượng; FK vòng và dữ liệu phụ thuộc có fixture riêng.
- [ ] G3.3 Scheduler: lịch theo múi giờ người dùng, DST, missed run, sleep/wake, retry có backoff và chống trùng. MVP chạy khi app đang mở và nói rõ giới hạn; bước sau tích hợp scheduler hệ điều hành cho chạy khi app đóng, có kiểm tra khả năng truy cập secret khi không có desktop session.
- [ ] G3.4 Retention theo số bản/tuổi/tổng dung lượng; preview dọn; chỉ dọn sau backup mới thành công; giữ bản ghim và bản đang được dùng. Phân biệt lỗi ghi tệp, lỗi verify và lỗi xóa; thử disk full, đồng hồ thay đổi và crash.
- [ ] G3.5 Nén/mã hóa theo luồng, định dạng versioned; thiết kế KDF, authenticated encryption và recovery trước khi code. Hỗ trợ file SQL cũ; checksum tệp lưu và hash nội dung là hai giá trị riêng. Không lưu mật khẩu giải mã trong manifest/log; xuất hướng dẫn quản lý khóa.
- [ ] G3.6 Bản sao ngoài máy: thư mục/ổ khác trước, remote storage sau qua adapter. Ghi atomic, verify đích, retry an toàn, trạng thái từng nơi lưu; không coi copy chưa xác minh là bản đủ điều kiện retention. Không đặt credential trong renderer.

Nghiệm thu: restore chỉ tác động đối tượng được chọn và dependency đã chấp thuận; lịch không chạy trùng sau restart; retention không xóa bản cuối cùng đạt chính sách; giải mã sai hoặc file hỏng không được đưa vào restore. Trường hợp không đủ dung lượng cho bản mới phải báo lỗi thay vì tự xóa bản bảo vệ.

## 8. G4 — hiệu năng đo được

- [ ] G4.1 Metadata lazy-load, single-flight, TTL/cache size hữu hạn, invalidation sau DDL/reconnect; không tải tất cả cột khi mở DB nhiều bảng.
- [ ] G4.2 Query filter theo kiểu cột: giữ so sánh có thể dùng index, phân biệt exact/prefix/contains; parameter binding; kiểm tra NULL, collation, timezone và ký tự `%`/`_`. Chỉ đổi SQL khi kết quả giữ đúng ngữ nghĩa.
- [ ] G4.3 Giảm render toàn trang, giữ focus/scroll/selection; virtualization khi cần; giới hạn cache, log và IPC progress. Profile trước khi đưa thêm việc CPU sang worker.
- [ ] G4.4 Tối ưu batch/stream/backpressure backup/restore dựa trên đo; không tăng concurrency restore vào cùng đích để lấy tốc độ.
- [ ] G4.5 Chạy lại benchmark và fault test; công bố dữ liệu trước/sau cùng phần cứng, phiên bản, engine và mạng.

Nghiệm thu dự kiến: UI p95 dưới 200 ms trên cấu hình chốt ở G0; bộ nhớ không tăng theo toàn bộ kích thước tệp khi streaming; throughput không giảm quá 10% trừ thay đổi an toàn được giải thích. Ngân sách RAM cụ thể được chốt tại G0; mốc không đủ phần cứng phải ghi chưa kiểm chứng, không tự hạ tiêu chí sau đo.

## 9. G5 — SQL Editor, bộ lọc và chẩn đoán

Tiếp tục 16/11: G5.3 đã có cache metadata cột hữu hạn/TTL/single-flight/generation, metadata theo đích tab, giữ alias self-JOIN/tên khác hoa-thường và tách bảng vật lý theo khối SELECT/nhánh set tại caret. CTE/derived là nguồn local không đọc nhầm tên như bảng thật; CTE có danh sách cột tường minh được gợi ý trực tiếp từ declaration, gồm scope lồng nhau/đệ quy. CTE thiếu declaration và derived table nhận toàn danh sách tên trực tiếp/AS và alias ngầm dạng atom từ SELECT đã đóng, không lookup bảng nguồn hoặc suy kiểu. Chọn gợi ý giữa identifier thay toàn token ASCII/backtick, giữ SQL xung quanh và Undo; kiểm tra snapshot editor/tab/đích trước chèn. Còn mở rộng star/alias ngầm ngoài grammar/set output/correlation, dialect/SQL-mode/parser fixture và nghiệm thu đầy đủ; G5.3 vẫn chưa đánh dấu hoàn tất, tổng G3–G9 vẫn 35 đầu việc lớn chưa hoàn tất.

- [x] G5.1 Sửa lời khuyên EXPLAIN: ALL/filesort/temporary là tín hiệu cần xem xét, không tự kết luận phải thêm index. Thêm mô tả có ngữ cảnh, phân biệt estimate với actual.
- [ ] G5.2 EXPLAIN JSON/tree theo server capability; so sánh hai plan cùng query/parameter/schema context. EXPLAIN ANALYZE là hành động riêng có cảnh báo thực thi; không chạy tự động.
- [ ] G5.3 Autocomplete theo scope: alias/JOIN, tên quote/database, subquery/CTE, derived table, nhiều statement và caret ở giữa câu; không gợi ý trong string/comment. Metadata cache hữu hạn và kết quả cũ bị vô hiệu hóa. Chọn parser theo thử nghiệm fixture/khả năng đóng gói thay vì thay dependency ngay.
- [ ] G5.4 Bộ lọc AND/OR có nhóm, toán tử theo kiểu, NULL/range/date, chọn cột hiển thị, sort nhiều cột; lưu cấu hình theo profile/database/table. Preview điều kiện và đặt lại; không tải toàn bảng để lọc ở renderer.
- [ ] G5.5 Query snippets và lịch sử có tìm kiếm/tag; lưu SQL nhạy cảm là tùy chọn có retention. Duy trì keyboard, undo/redo và khôi phục tab sau restart.
- [ ] G5.6 Dashboard chẩn đoán: processlist, transaction lâu, lock waiter/blocker, truy vấn lâu, slow query qua nguồn server sẵn có. Capability detection cho MySQL/MariaDB và quyền thiếu; polling có giới hạn, pause khi ẩn. Không tự bật slow log hoặc thay cấu hình global.

Nghiệm thu: fixture query lồng nhau, tên Unicode/quote và editor chưa viết xong; bộ lọc khớp SQL mong đợi trên DB thật; dashboard không lộ query của phiên khác ngoài quyền tài khoản; kill query xác nhận đúng connection identity và không chạm phiên hệ thống ngoài lựa chọn.

## 10. G6 — so sánh schema và migration

- [ ] G6.1 Snapshot schema chuẩn hóa theo engine/version: column/type/default/generated/collation, PK/index/FK, view, routine, trigger, event. Không bỏ khác biệt ngữ nghĩa khi normalize.
- [ ] G6.2 So sánh nguồn/đích chỉ đọc, phân loại thêm/sửa/xóa và trường hợp không hỗ trợ; xử lý DEFINER, SQL mode, charset và tên phân biệt hoa thường.
- [ ] G6.3 Sinh migration SQL có thứ tự dependency và cảnh báo DROP/data loss/table rebuild/lock; cho chọn hạng mục và xuất file xem xét. Rename phải được người dùng chỉ định, không tự suy thành DROP/CREATE.
- [ ] G6.4 Apply qua policy G1, kiểm tra drift từ snapshot tới lúc chạy, backup phù hợp và báo cáo từng statement. Không hứa rollback toàn bộ DDL; reverse script chỉ xuất khi có thể và chỉ rõ không khôi phục dữ liệu đã mất.

Nghiệm thu: schema sau apply khớp snapshot mong đợi trên fixture; không chạy khi drift chưa được xử lý; migration qua phiên bản/collation không hỗ trợ phải báo rõ; nguồn không bị ghi.

## 11. G7 — so sánh và đồng bộ dữ liệu

- [ ] G7.1 MVP cho một bảng với PK/unique key hợp lệ; không có khóa thì chỉ báo cáo hoặc yêu cầu mapping duy nhất được kiểm chứng. Quét theo chunk/keyset; không nạp toàn bảng vào RAM.
- [ ] G7.2 Canonical hóa so sánh chính xác BIGINT/DECIMAL, NULL/empty, binary, JSON, timezone/collation. Hash chỉ giúp lọc chunk; có bước kiểm tra cần thiết trước ghi, không dựa duy nhất vào hash yếu.
- [ ] G7.3 Preview thêm/sửa/xóa và chọn chiều đồng bộ; mặc định không chọn xóa. Lưu snapshot identity, kiểm tra xung đột giá trị gốc lúc apply; transaction theo lô và báo số đã commit khi hủy/lỗi.
- [ ] G7.4 Tính nhất quán nguồn/đích: snapshot khi khả thi; với database đang thay đổi phải hiển thị mức bảo đảm. Chặn hoặc phát hiện drift; không gọi báo cáo là nhất quán nếu chưa có cơ chế tương ứng.
- [ ] G7.5 Mở rộng nhiều bảng theo dependency sau MVP; giới hạn tải/khóa, retry chỉ khi chứng minh an toàn; không tự tiếp tục từ checkpoint mơ hồ.

Nghiệm thu: không ghi nguồn, preview không thay đổi dữ liệu, chạy lại không nhân đôi dòng, xung đột không bị ghi đè im lặng, tổng added/changed/deleted/skipped/failed khớp DB; fault test xác nhận phạm vi đã commit.

## 12. G8 — audit, UX và kiến trúc

- [ ] G8.1 Audit cục bộ có version, thời gian, app/session/profile/database, loại thao tác, affected rows và trạng thái/error code. Mặc định không lưu SQL literal, dữ liệu dòng, password/token/key; retention/quota và export đã che dữ liệu. Audit cục bộ không được quảng bá là log chống sửa đổi hay thay thế audit phía server.
- [ ] G8.2 Tách module từng hành vi: backup controller/view, SQL editor, grid/filter, connection form, task controller; main tách orchestration/IPC service; DB tách query/backup/restore qua hợp đồng hiện tại. Có test contract trước khi di chuyển.
- [ ] G8.3 UX bàn phím/focus, cỡ chữ dễ đọc, dark theme, màn hình nhỏ; dialog dài có phần cuộn và hành động nhìn thấy. Giữ focus sau chọn backup/render lại, không chỉ kiểm tra lần Enter đầu tiên.
- [ ] G8.4 Thử ít nhất 5 người dùng quy trình kết nối → query → sửa dữ liệu → backup → phục hồi thử; ghi thời gian, thao tác nhầm và phần cần sửa.
- [ ] G8.5 Cập nhật README, hướng dẫn, screenshot và `agent.md` theo code thật; sửa mô tả TLS cũ. Nếu thêm renderer asset/module, cập nhật index, packaging allowlist và smoke bản đóng gói.

Nghiệm thu: không đổi định dạng/API ngoài migration đã test; không thêm secret vào renderer/log; luồng cũ và shortcut pass; mỗi module có trách nhiệm rõ, không rewrite framework toàn app.

## 13. G9 — đồng bộ tùy chọn và phát hành

- [ ] G9.1 Đánh giá recovery kit mã hóa, đổi thiết bị/mật khẩu, xóa tài khoản và conflict policy trước khi mở rộng sync. Không làm suy yếu mã hóa đầu cuối; không reset mật khẩu theo cách hứa khôi phục vault khi không có khóa.
- [ ] G9.2 Kiểm chứng schema/migration của profile mới trong vault, tương thích máy cũ, tombstone, logout và phản hồi trễ; backup/restore server SQLite và giới hạn tải. Sync có thể tiếp tục beta riêng nếu chưa đạt.
- [ ] G9.3 Rà soát IPC sender/frame/payload, CSP, file path, secret storage và dependency; test đầu vào không tin cậy từ SQL/manifest/name/config. Bản backup và tệp metadata sidecar phải được quản lý nhất quán khi copy/export/delete.
- [ ] G9.4 CI unit/integration/renderer/website/server; ma trận DB mục tiêu; installed smoke Windows/Ubuntu, nâng cấp từ bản trước, giữ cấu hình và backup. Version/tag/lockfile/artifact/checksum phải khớp; xác minh chữ ký theo chính sách release.
- [ ] G9.5 Release notes, migration/recovery guide, giới hạn đã kiểm chứng, runbook disk full/mất kết nối/mất khóa và rollback bộ cài. Không phát hành tự động chỉ vì các unit test xanh.

Nghiệm thu: mọi tính năng công bố có bằng chứng trên bản đóng gói; test thiếu hạ tầng không được tính pass; lỗi mất dữ liệu, sai session, lộ secret, false-success backup/restore là No-Go.

## 14. Kiểm thử và cách chia PR

Mỗi ticket gồm: ID mốc, vấn đề cụ thể, input/fixture, hành vi mong muốn, file/hợp đồng ảnh hưởng, migration, rủi ro dữ liệu, cách test, tiêu chí nghiệm thu và rollback. Mỗi PR giải quyết một hành vi có thể kiểm chứng, không gộp refactor lớn với thay đổi SQL ghi dữ liệu.

| Loại thay đổi | Kiểm tra bắt buộc |
| --- | --- |
| Policy/parser/plan | Unit cho happy path và lỗi biên; integration trên DB thực cho ngữ nghĩa SQL |
| Ghi/transaction/migration | Conflict, mất mạng, cancel, implicit commit, quyền thiếu, kiểm tra dữ liệu sau lỗi |
| Backup/restore/schedule | Round trip, checksum/file đổi, disk full, crash, lịch trùng, retention và khóa giải mã |
| UI | Electron tương tác thực, keyboard/focus, dark theme và cửa sổ nhỏ |
| Hiệu năng | Baseline trước/sau cùng điều kiện; RSS/CPU/latency, bounded memory và log |
| Lưu trữ/sync | Đọc profile/manifest cũ, migration và rollback, generation/logout, không mất secret |
| Release | Bản đã cài, upgrade, version/checksum/signature và hướng dẫn recovery |

Các lệnh nền theo `agent.md`: `npm run check`, `npm run test:renderer`, `npm run test:website`, `npm --prefix server run check`, `npm run server:test`, `git diff --check`. Các thay đổi DB chạy thêm `npm run test:mysql` với fixture/môi trường thật được cấu hình. Kiểm tra phù hợp được chạy trong từng PR; release chạy toàn ma trận, không bỏ qua lỗi môi trường bằng cách đánh dấu pass.

## 15. Backlog đầu tiên để bắt đầu triển khai

1. G0.1–G0.2: báo cáo baseline, phân loại test website/server và xác nhận workspace hiện tại.
2. G0.3: fixture tài khoản chỉ đọc, transaction liên tab và backup round trip.
3. G0.4: tài liệu identity tab/session và ma trận mọi đường ghi qua main.
4. G1.1: migration environment + hiển thị đích trên tab/dialog, không thay hành vi SQL.
5. G1.2: policy chỉ đọc toàn đường IPC, kiểm chứng quyền DB và câu chưa phân loại.
6. G1.3: preview thao tác grid và xác nhận production nhất quán.
7. G1.4–G1.5: transaction controller/UI và vòng đời session.
8. G2.1–G2.2: chuẩn hóa chi tiết backup, quét có hủy/cache và chống stale.
9. G2.3–G2.5: sandbox restore, đối chiếu và báo cáo gắn hash.

Sau mỗi đợt cập nhật bảng tiến độ: chưa bắt đầu / đang làm / chờ điều kiện / đạt nghiệm thu, kèm commit, bằng chứng test và giới hạn. Chỉ điều chỉnh thứ tự khi có dependency hoặc phát hiện rủi ro mới, và ghi lý do trong roadmap.
