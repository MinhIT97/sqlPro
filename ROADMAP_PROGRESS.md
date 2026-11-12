# Tiến độ roadmap SqlPro

Cập nhật: 12/11/2026. Đối chiếu `DATABASE_PRODUCT_ROADMAP.md`. Đợt 1 được chốt trong commit phát triển local; chưa phát hành. Xem commit bằng git log và báo cáo review bên dưới.

## Review và chốt đợt 1

Đã rà soát, sửa các lỗi về validator trial SET/default function, schema cache khi confirm Production, query chen ngang, SQL preview bị cắt sớm, cancel/stat race, giới hạn byte copy thực và timeout cleanup. Chi tiết bằng chứng, kết quả test và các giới hạn còn lại ở `CODE_REVIEW_BATCH_1.md`. Check 52/52 nhóm, Electron 51/51, MySQL 8.4 thực 21/21, website 14/14 và server 17/17 đều qua trước khi chốt commit phát triển đợt 1. Cleanup trial hiện có timeout 15 giây từng lệnh marker/drop; các ghi chú chưa có cleanup timeout ở các đợt trước bên dưới là trạng thái lịch sử.

## 12/11 — Phục hồi thử backup, bản đầu

Cập nhật tiếp: nút Hủy phục hồi thử gọi đúng profile/taskId. Controller hủy stream sao chép, đọc/validation/hash qua AbortSignal, chuyển atomic cancel flag cho scan worker và gọi cancelTask đúng taskId khi restore. Giới hạn 10 phút yêu cầu dừng phần xử lý chính; đây là hủy hợp tác, lệnh server đang chờ có thể cần kết thúc trước khi nhận hủy. Sau khi dừng phần chính, cleanup marker vẫn chạy và ghi trạng thái rõ, chưa có deadline riêng cho cleanup.

Phân biệt báo cáo `cancelled`, `timeout`, `failed`; không báo verified nếu cancellation xảy ra sau restore trước bước hash cuối. Timer được dọn trước cleanup. Unit kiểm tra hủy trước khi tạo schema, timeout khi scan và hủy trong restore vẫn kiểm tra ownership/cleanup. Chưa chạy lại integration MySQL thực trong đợt hủy này; integration 21/21 ở đợt trước kiểm tra restore thành công.

- Nút trong chi tiết backup mở xác nhận native ghi rõ máy chủ và phạm vi tạo/xóa database thử. Dùng phiên riêng, kiểm tra chỉ đọc và cấu hình sau xác nhận, giữ transfer slot trong suốt tác vụ.
- Tạo bản sao tệp riêng quyền 0600 để kiểm tra/phục hồi; giới hạn 512 MiB, đối chiếu manifest/hash, xác thực câu SQL và scope trước tạo database. Không rewrite schema ghi rõ; tệp thuộc scope khác bị từ chối. Chỉ hỗ trợ CREATE/DROP bảng InnoDB thông thường, INSERT literal và SET session được parser cho phép. Chưa hỗ trợ view/trigger/routine/event, biểu thức generated/check/partition hoặc chuỗi backslash.
- Database tên ngẫu nhiên `sqlpro_trial_*`, tạo không dùng IF NOT EXISTS. Marker tên/token ngẫu nhiên được kiểm tra trước DROP. Không đủ ownership thì để nguyên và báo tên database cần dọn; không tự xóa schema chỉ dựa vào prefix. Nếu lỗi tạo marker, báo cần dọn thủ công.
- Báo cáo có checksum, thời gian, phiên bản server, kết quả row-count/FK verification từ restore và trạng thái cleanup. Ghi sidecar `.trial.json` atomic; lỗi lưu vẫn trả báo cáo/cleanup cho UI. Catalog hiển thị lịch sử thử, xóa backup dọn sidecar.
- MySQL 8.4 tạm: 21/21 pass gồm phục hồi và dọn schema thử thực, nguồn không đổi. Container tmpfs đã dọn. Check 52/52 nhóm; Electron 51/51 trước chỉnh câu chữ kết quả. Unit kiểm tra SQL bị từ chối, cleanup khi thành công/lỗi và không DROP khi marker sai.
- G2.3–G2.5 còn một phần: chưa có quota đĩa/RAM phía server, hash dữ liệu toàn bảng, recovery journal sau crash, hủy xuyên suốt giai đoạn scan/copy và timeout tổng tác vụ; chưa thử MariaDB/installed build. Tệp 512 MiB vẫn có thể mở rộng nhiều khi restore. Kết quả verified chỉ trong phạm vi kiểm tra row-count/FK hiện có, không phải so sánh toàn bộ nội dung. Không gọi đây là sandbox chống SQL độc hại; cần quyền DB phù hợp và xem xét trên máy chủ thử nghiệm trước.

## Cập nhật mới nhất — Commit, import và restore trên Production

### Đợt quét backup và ổn định test giao diện

Cập nhật tiếp: đã thêm progress polling 500 ms chỉ khi vùng chi tiết còn hiện/đang quét; hiển thị byte đã đọc, phần trăm byte và số câu SQL. Poll không chồng nhau và kết quả cũ không được cập nhật vào vùng chi tiết mới. 100% byte không đồng nghĩa tác vụ đã kết thúc; UI nói rõ vẫn phân tích/kiểm tra tệp.

Các yêu cầu cùng profile/database/backup và file identity được gộp vào một promise/worker, tối đa 32 subscriber. Status/cancel đối chiếu profile và taskId thuộc nhóm; cancel từ một subscriber dừng tác vụ chung và thông báo điều này trong UI. Backup khác vẫn trả busy, chưa có hàng đợi. Kết quả lỗi/hủy/file đổi không được cache. Unit kiểm tra shared scan/progress/privacy và cancel tất cả subscriber.

`npm run check`: 51/51 nhóm pass; Electron sau thay đổi 51/51, gồm smoke trực tiếp tiến độ 50%, số câu SQL và nút hủy. Các ghi chú chưa có progress/gộp yêu cầu bên dưới là trạng thái đợt trước. Đợt này không thay SQL thực thi database, chưa chạy lại integration DB/bộ cài.

- Test drag-selection cuộn dòng đích vào viewport, đóng menu che khuất và đợi hit-test trúng dòng trước khi kéo. Lượt kiểm chứng sau sửa qua Electron 51/51; không thay logic chọn dòng sản phẩm để làm test pass.
- Quét nội dung backup có taskId và nút Hủy; main giới hạn một worker đang quét, từ chối lượt khác bằng BACKUP_SCAN_BUSY. Hủy đối chiếu profile/taskId và gửi atomic cancel flag tới scanner; timeout 5 phút yêu cầu hủy hợp tác và chờ worker dọn.
- Cache display-only tối đa 4 inventory, TTL 5 phút, khóa theo profile/database/backup và nhận diện dev/ino/size/mtime/ctime. Kiểm tra lại nhận diện sau quét, không cache kết quả hủy/lỗi/tệp đổi; không dùng cache này để cấp phép restore.
- Kết quả trả tối đa 5.000 bảng và 5.000 đối tượng, bỏ nội dung định nghĩa khỏi response và báo truncated. Chưa giới hạn toàn bộ inventory nội bộ của parser; chưa có hàng đợi/gộp yêu cầu trùng hoặc progress định lượng. G2.2 còn một phần, chưa đạt toàn bộ roadmap.
- Unit kiểm tra cache invalidation, changed-file, busy, scoped cancellation, output/cache limits và renderer không ghi kết quả vào selection mới. `npm run check` qua 51/51 nhóm. Chưa chạy DB integration mới vì dùng lại scanner hiện có.

- Commit từ thanh transaction dùng cùng cơ chế token Production một lần; token chụp session/revision/profile, không tin `confirmed:true`. Trước thực thi kiểm tra lại bận, phiên và policy; không reconnect/retry. Hộp thoại nói rõ commit mọi tab dùng chung phiên, không riêng database hiển thị.
- Rollback tiếp tục có luồng xác nhận riêng; kết nối chỉ đọc vẫn rollback được.
- Import/restore dùng hộp thoại native từ main vì tác vụ cần tệp và phiên worker riêng. Xác nhận sau khi resolve tệp/đích và trước claim task/tạo worker; mặc định Hủy. Main giữ snapshot cấu hình, so file identity (dev/ino/size/mtime/ctime) và thời hạn 2 phút sau dialog. Đây không phải hash file hay ngăn mọi sửa file sau kiểm tra cuối; restore vẫn chạy preflight/checksum hiện có.
- Dialog hiển thị user/host/port, database đích, đường dẫn/dung lượng, bảng/mode/transaction khi import và drop/create lựa chọn khi restore. Cảnh báo ghi một phần và việc không dùng transaction SQL Editor.
- Unit/main: 24 test main pass, gồm xác nhận Commit một lần, revision/reconnect/busy/readonly/cancel, Rollback, import cancel/changed-file/execute, restore đúng targetProfileId. Toàn `npm run check`: 50/50 nhóm pass.
- Chưa chạy lại integration DB thực trong đợt này vì thay đổi tập trung orchestration/confirmation, không thay SQL ghi. Chưa kiểm chứng native transfer dialog bằng thao tác thật trên Windows/Ubuntu; test main inject phản hồi dialog, Electron smoke kiểm tra dialog Commit.
- Hai lượt Electron chạy trong đợt này đều qua phần dialog Production/Commit mới nhưng timeout ở test kéo chọn 3 dòng đã từng không ổn định. Không ghi toàn bộ smoke pass cho đợt này; cần điều tra riêng test hit-testing/resize/scroll trước phát hành.
- Các ghi chú “chưa tích hợp Commit/import/restore” ở báo cáo đợt trước bên dưới là trạng thái lịch sử, đã được cập nhật ở đợt này.

## Baseline

- Commit nền: `1d139d5`; workspace đã có thay đổi backup/autocomplete/version trước khi bắt đầu đợt này. Giữ nguyên các thay đổi đó.
- Node: v22.22.3; package: 0.3.12.
- Trước thay đổi: `npm run check` pass 46 nhóm; website smoke 14/14, server 17/17 khi chạy ngoài sandbox cho phép localhost. Lỗi website/server ở lượt trước là giới hạn môi trường, không tái hiện ở lượt kiểm chứng này.
- Sau thay đổi: `npm run check` pass 48 nhóm; renderer Electron 48/48, gồm transaction, bàn phím và layout. `npm --prefix server run check` pass.
- Lần chạy mặc định `npm run test:mysql` bỏ qua test bên trong vì thiếu `SQLPRO_TEST_MYSQL_PORT`. Sau đó đã dựng MySQL 8.4 tạm riêng tại localhost:13317, chạy `SQLPRO_TEST_MYSQL_PORT=13317 node test/mysql-integration.test.cjs`: **18/18 pass, không skip**, gồm 17 kịch bản và test cha. Container dùng tmpfs đã được dừng/xóa sau test; không dùng database ứng dụng hiện có.
- Bổ sung integration thật cho BEGIN/ROLLBACK/COMMIT/autocommit OFF, kiểm tra dữ liệu từ kết nối thứ hai. Sửa fixture round-trip backup thiếu `selection.tables` khi gọi `saveBackupFile`; không đổi hợp đồng sản phẩm để làm test pass.
- Chưa có benchmark 1/10/20 GB, chưa kiểm chứng bộ cài Windows/Ubuntu và chưa có ma trận DB thực. G0 còn đang làm.

## Đợt triển khai đầu tiên

| Ticket | Trạng thái | Đã làm / phần còn lại |
| --- | --- | --- |
| G0.1–G0.2 | Một phần | Baseline, phân loại test và integration MySQL 8.4 thực; còn MariaDB và installed builds |
| G1.1 | Đã triển khai, qua test hiện có | Môi trường profile, giữ profile cũ chưa phân loại, lưu/đồng bộ qua vault, hiển thị ở sidebar/tab/header và transaction confirmation |
| G1.2 | Đã triển khai, còn mở rộng ma trận MariaDB | Profile chỉ đọc, guard main/API database, kiểm tra batch SQL bảo thủ, UI và integration tài khoản SELECT/SHOW VIEW |
| G1.3 | Đã triển khai các đường chính, còn mở rộng kiểm chứng | Grid/SQL/Commit dùng token một lần; import/restore dùng xác nhận native tại main với kiểm tra file/profile trước tạo worker |
| G1.4–G1.5 | Một phần | Thanh transaction, xác nhận Commit/Rollback, session identity + revision, chặn bận/stale/reconnect, không replay commit lỗi; đã kiểm chứng trạng thái trên MySQL 8.4, còn MariaDB và audit toàn bộ vòng đời |
| G5.1 | Một phần | EXPLAIN ALL không còn kết luận bắt buộc thêm index; còn giải thích plan có ngữ cảnh đầy đủ |
| G2–G9 còn lại | Chưa triển khai | Theo dependency roadmap, không được coi là đã hoàn tất |

## Bằng chứng và giới hạn

- Test main: commit/rollback đúng profile dù active connection khác; từ chối phiên mới, revision cũ, tác vụ bận và thao tác chồng nhau; lỗi mạng không mở lại/replay commit.
- Test DB state: ghi nhận transaction từ serverStatus, autocommit, thời điểm quan sát và invalidation revision khi phát sinh lệnh mới.
- Test renderer: đích transaction lấy từ tab SQL; đổi đích trong lúc xác nhận không gửi lệnh; cancellation không gửi lệnh; tên được escape.
- Test store: profile cũ không tự suy môi trường theo host, lưu nhãn qua edit/vault round trip, giá trị môi trường sai được chuẩn hóa.
- Electron smoke: điều khiển có thể focus bằng bàn phím, nút bị khóa khi phiên bận, toolbar không tràn ngang. Ảnh kiểm tra lưu tại `/tmp/sqlpro-g1-review/` trong phiên phát triển, không đưa dữ liệu thật vào repo.
- Nhãn Production chỉ giúp nhận diện, chưa phải cơ chế giới hạn ghi. Quyền DB vẫn là lớp bảo vệ cần thiết.
- Commit/Rollback áp dụng cho toàn bộ transaction của session; không có transaction riêng theo tab, không bảo đảm rollback DDL.

## Công việc tiếp theo

1. Mở rộng DB thử với tài khoản quyền tối thiểu và MariaDB; kiểm chứng bộ cài trước khi phát hành.
2. Kiểm chứng policy chỉ đọc trên MariaDB và bổ sung fixture theo cú pháp được hỗ trợ; giữ fail-closed cho câu/hàm chưa nhận diện.
3. Hoàn thiện scan backup có cancel/cache, sau đó sandbox restore; mở rộng kiểm chứng native dialog trên bộ cài thực.

## Đợt tiếp theo — xem trước ghi trên Production

- Grid thêm/sửa/xóa và `db:query` có guard Production tại main, không tin `confirmed:true` do caller gửi để bỏ qua bước xem trước. Các câu được phân loại đọc vẫn chạy bình thường.
- Token ngẫu nhiên có TTL 2 phút, tối đa 32 yêu cầu đang chờ, dùng một lần kể cả khi thực thi lỗi. Nội dung yêu cầu được chụp bằng V8 serialization, giữ chính xác Buffer/BigInt và không dùng lại payload có thể thay đổi.
- Trước xác nhận chỉ tải metadata. Preview có đích cụ thể, cột, SQL placeholder/literal đã che, kiểu/thứ tự tham số và số dòng được chọn; không giả lập số dòng ảnh hưởng. Insert/update dùng chung planner với code ghi; delete là SQL dự kiến theo PK, vẫn dùng validation/lock/original-value guard khi xóa thật.
- Confirm kiểm tra session identity, transaction revision, cấu hình trusted profile và metadata/plan của thao tác dòng; giữ session lease tới khi thao tác async kết thúc. Không tự reconnect/retry. Các thay đổi từ session bên ngoài sau bước kiểm tra cuối vẫn có thể xảy ra và được kiểm soát trong giới hạn guard hiện có.
- Renderer dùng dialog riêng, focus mặc định ở Hủy, Escape hủy; bản nháp/form đang mở được giữ lại. Không gửi giá trị tham số/SQL literal vào preview.
- SQL không thể preview chắc chắn do executable comment/hint hoặc quote/escape phụ thuộc SQL mode bị từ chối thay vì che mất cấu trúc câu lệnh. Export SQL Production chỉ cho câu được phân loại đọc để không lách qua export.
- Phạm vi chưa hoàn thành: import/restore/Commit có xác nhận riêng hiện tại, chưa dùng token Production này. Chưa có tùy chọn hiện giá trị tham số, chưa có schema-diff/migration approval.

Kiểm chứng: unit/main cho token hết hạn, hủy, replay, payload thay đổi, session/revision/schema/policy đổi, giữ lease khi write đang chờ, readonly precedence và export bypass. Electron kiểm tra dialog, Escape, giữ draft, exact-token confirm và layout. MySQL thật kiểm tra preview không ghi rồi insert/update/delete đúng kế hoạch; round-trip backup, transaction, row conflict và tài khoản chỉ đọc tiếp tục được kiểm tra.

Kết quả đợt này: check **50/50 nhóm**, Electron **50/50**, website **14/14**, server **17/17**, server syntax check pass; MySQL 8.4 tạm **20/20** (19 kịch bản và test cha), không skip. Container tmpfs đã dọn. Ảnh kiểm tra: `/tmp/sqlpro-production-review/production-review.png`. Chưa kiểm tra MariaDB hoặc bộ cài Windows trong đợt này.

## Đợt tiếp theo — chế độ chỉ đọc

- Thêm `readOnly` vào profile/store/vault, mặc định false cho profile cũ; giá trị explicit sai kiểu khi đọc được chuẩn hóa về chế độ an toàn, save yêu cầu boolean.
- Cho phép SELECT cơ bản/CTE SELECT, hàm dựng sẵn trong allowlist, metadata, EXPLAIN SELECT, USE và ROLLBACK. Chặn toàn bộ batch nếu bất kỳ câu nào bị từ chối; không dựa vào `confirmed` hoặc cờ readOnly do renderer gửi trong request query.
- Hàm tùy biến/qualified function, executable comment, optimizer hint, SQL mode-dependent backslash string và cú pháp chưa nhận diện bị từ chối. Đây là policy tránh ghi nhầm, không phải SQL sandbox; quyền/DEFINER phía server vẫn cần được kiểm soát.
- Profile chỉ đọc vẫn có thể tạo/xem/đổi tên/xóa/xuất file backup cục bộ. Chỉ đọc áp dụng cho database, không khóa kho file backup.
- Khi đổi cấu hình có transaction, autocommit OFF hoặc tác vụ đang chạy, trả lỗi và giữ phiên; không tự đóng để rollback. Các task đã bắt đầu không được hứa sẽ được hoàn tác bằng cách đổi policy.

| Đường vào main | Policy |
| --- | --- |
| `db:query` | Kiểm tra trusted profile trước mở phiên và sát lúc thực thi; xác nhận batch không bỏ qua chỉ đọc |
| `db:insert-row`, `db:update-row`, `db:delete-rows` | Chặn trước mở phiên và tại callback phiên; API DatabaseSession cũng có guard |
| `db:import-file`, `db:restore` | Kiểm tra profile đích, trước dialog/task và sau chuẩn bị worker; restore/copy sang DB khác xét targetProfileId |
| `db:export-query` | Kiểm tra SQL trước dialog và sau dialog trước chạy; không cho SELECT hàm chưa phân loại lách qua export |
| `db:transaction` | Commit bị chặn; rollback vẫn được phép với đúng session/revision |
| Metadata, table-data/count, export-file, backup | Cho phép đọc/backup; câu do app dựng vẫn đi qua biên quote/parameter hiện có |
| Catalog copy/rename/delete/export | Cho phép thao tác file cục bộ, không ghi database |

Kiểm chứng đợt này: `npm run check` **49/49 nhóm**, Electron **49/49**, website **14/14**, server **17/17**, server syntax check pass. MySQL 8.4 tạm riêng: **19/19 pass** gồm 18 kịch bản và test cha, không skip; kiểm tra read-only account, từ chối ghi cả khi gọi raw trực tiếp theo quyền server, CTE/metadata đọc được và dữ liệu không đổi sau batch bị chặn. Container tmpfs đã dọn. Ảnh UI kiểm tra ở `/tmp/sqlpro-readonly-review/`.

Một lượt Electron cuối timeout ở test kéo chọn 3 dòng; chạy lại không thay code đạt 49/49. Cần theo dõi độ ổn định test drag-selection trong CI; không coi việc rerun là bằng chứng lỗi đó đã được sửa.
