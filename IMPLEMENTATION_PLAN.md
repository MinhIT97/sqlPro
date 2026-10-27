# Kế hoạch nâng cấp toàn diện SqlPro

Ngày lập: 2026-10-27. Tài liệu này là backlog triển khai cho phiên bản desktop tiếp theo, dựa trên trạng thái repo hiện tại. Đây là kế hoạch, chưa phải tuyên bố các hạng mục đã hoàn thành.

## 1. Mục tiêu và ranh giới

SqlPro cần đủ tin cậy để người dùng quản trị MySQL/MariaDB hằng ngày: kết nối rõ trạng thái, truy vấn và sửa dữ liệu chính xác, backup/restore có thể theo dõi và chẩn đoán, giao diện vẫn phản hồi khi xử lý dữ liệu lớn, bộ cài có quy trình phát hành kiểm chứng được. Ưu tiên cao nhất là tránh mất hoặc sửa dữ liệu ngoài ý muốn; tốc độ và hình thức không được đánh đổi mục tiêu này.

Phạm vi: ứng dụng Electron (`electron/`, `app.js`, `desktop.js`, `index.html`, `style.css`), test, CI/CD, website tải bộ cài, tài liệu vận hành và server đồng bộ tùy chọn. Không thay đổi cấu trúc dữ liệu hoặc định dạng backup hiện hữu nếu chưa có phương án đọc ngược và migration. Không dùng database sản xuất làm môi trường thử nghiệm phá hoại.

Các giả định cần ghi trong ticket trước khi bắt đầu: nhóm có quyền tạo MySQL/MariaDB thử nghiệm, có máy Windows và Ubuntu để kiểm tra bộ cài, có bộ dữ liệu thử đủ lớn. Nếu thiếu một điều kiện, hạng mục phụ thuộc chỉ được đánh dấu “chưa xác nhận”, không tự suy ra đã đạt.

## 2. Hiện trạng đã quan sát

| Khu vực | Hiện có | Khoảng trống cần xử lý |
| --- | --- | --- |
| Backup/restore | Backup SQL dạng luồng, tệp `.part` rồi đổi tên; restore quét trước, có log và tiến độ trong tab tác vụ; có test đơn vị. | Restore/copy có thể để lại dữ liệu đích ở trạng thái dở dang khi SQL lỗi hoặc hủy; chẩn đoán routine/binary logging chưa đủ trước khi ghi; chưa có phép thử khôi phục ở kích thước lớn và sự cố hệ thống thực. |
| Hiệu năng | Có worker cho bước quét SQL, giới hạn kết quả truy vấn và một số nhường event loop. | Phần thực thi/biến đổi dữ liệu lớn vẫn có thể gây nghẽn; chưa có benchmark có thể lặp lại và ngưỡng phản hồi UI. |
| Kết nối | Hỗ trợ SSH tunnel, SSL/TLS, quản lý phiên và kiểm tra SSH host key. | Kết nối TLS mới không mặc định xác thực chứng chỉ; cần trình bày rõ kết nối không được xác thực và đường nâng cấp cho profile cũ. |
| Electron | Bật sandbox, context isolation, tắt Node trong renderer và chặn điều hướng. | CSP còn `script-src 'unsafe-inline'`; một số IPC handler đăng ký trực tiếp chưa dùng cùng lớp kiểm tra sender. |
| UI | Có cây database, tab SQL, tab kết quả, autocomplete, tab tác vụ, quản lý backup. | Form kết nối dài, chữ nhỏ ở nhiều nơi, cảnh báo lỗi SQL thô; cần thử quy trình thực với người dùng và hỗ trợ bàn phím/focus tốt hơn. |
| Phát hành | Workflow tạo `.deb`, AppImage, NSIS và portable, gắn artifact vào GitHub Release theo tag. | Chưa có ma trận MariaDB/kiểm tra bản đã cài; cấu hình ký mã Windows chưa thể hiện; `package.json` đang là `0.3.8` trong khi root `package-lock.json` là `0.3.5`. |
| Đồng bộ | Có mã hóa đầu cuối và server riêng. | Cần xác định rõ chính sách khôi phục khóa, backup cấu hình, vòng đời dữ liệu xóa và vận hành server trước khi quảng bá như tính năng ổn định. |

Lỗi người dùng đã gặp khi copy database: câu `CREATE FUNCTION SPLIT_STR(...)` thất bại ở câu SQL số 346325 vì MySQL đích bật binary logging nhưng routine không khai báo đặc tính mà máy chủ yêu cầu. Lỗi này minh họa giới hạn của quy trình hiện tại: target đã nhận nhiều câu lệnh trước khi lỗi xuất hiện. Preflight mới phải phát hiện được **trường hợp đã biết** trước khi ghi; không hứa bảo đảm mọi câu SQL sẽ chạy thành công.

## 3. Thứ tự thực hiện và mốc phát hành

Các khoảng thời gian là ước lượng ngày công kỹ thuật để chia việc, không phải cam kết lịch. Mỗi PR nên giải quyết một hành vi có thể kiểm thử và giữ ứng dụng chạy được.

| Mốc | Ưu tiên | Phụ thuộc | Ước lượng | Đầu ra bắt buộc |
| --- | --- | --- | --- | --- |
| M0 — baseline và hợp đồng hành vi | P0 | Không | 2–4 ngày | Bộ test nền, fixture, log/benchmark hiện trạng, checklist dữ liệu nhạy cảm. |
| M1 — an toàn backup/copy/restore | P0 | M0 | 10–16 ngày | Preflight, báo cáo tác động, xử lý lỗi một phần, xác minh backup/restore và fault test. |
| M2 — bảo mật kết nối/Electron | P0 | M0; phối hợp UI với M1 | 6–10 ngày | Mặc định TLS an toàn cho profile mới, IPC/CSP chặt hơn, migration không làm hỏng profile cũ. |
| M3 — hiệu năng và kiểm chứng quy mô lớn | P1 | M1, M2 | 6–10 ngày | Benchmark có số liệu, sửa đúng điểm nghẽn, bài thử 1/10/20 GB và lỗi hệ thống. |
| M4 — UX và khả năng bảo trì | P1 | Luồng M1/M2 đã ổn định | 8–14 ngày | Form/tác vụ/lỗi rõ hơn, kiểm thử bàn phím và trích tách module theo từng bước. |
| M5 — phát hành và vận hành | P0 để public stable | M1–M4 | 4–7 ngày + thời gian chờ chứng thư | CI matrix, smoke bản cài, ký mã, checksum, tài liệu hỗ trợ/rollback. |
| M6 — đồng bộ và tính năng mở rộng | P2 | Quyết định sản phẩm riêng | Ước lượng sau discovery | Quy trình khôi phục khóa và yêu cầu vận hành rõ; chỉ triển khai khi có acceptance riêng. |

Có thể làm M1 và M2 song song sau M0 nếu không cùng sửa một file lớn trong một PR. M3 phải đo trước khi đổi kiến trúc. M4 chia thành PR nhỏ sau khi hợp đồng UI của M1/M2 ổn định. Không gộp tất cả vào một PR.

## 4. M0 — đóng băng baseline và dựng môi trường kiểm chứng

**T0.1 — Chụp hành vi hiện tại.** Ghi phiên bản Node/Electron, OS, MySQL/MariaDB, cấu hình máy, kích thước dữ liệu, tốc độ đĩa/mạng vào báo cáo benchmark. Chạy `npm run check`, `npm run test:renderer`, `npm run test:website`, `npm --prefix server run check`, `npm run server:test`, `npm run test:mysql`. Ghi số pass/fail và thời gian; test tích hợp chỉ tính khi thật sự có DB thử nghiệm. Không sửa các failure không liên quan trong PR baseline mà chưa phân loại.

**T0.2 — Bộ fixture có thể tái tạo.** Tạo schema thử gồm PK/không PK, FK, view, trigger, event, procedure/function, `DEFINER`, BLOB, JSON, Unicode, BIGINT/DECIMAL, NULL, dữ liệu lớn và engine InnoDB lẫn engine khác. Cần một fixture riêng tái tạo lỗi `SPLIT_STR` với `log_bin` bật. Script tạo dữ liệu phải đặt trong `test/fixtures/` hoặc `scripts/`, không chứa thông tin máy thật. Mọi test phá hoại chỉ chạy trên database có tên/marker thử nghiệm và kiểm tra marker trước khi xóa.

**T0.3 — Hợp đồng trạng thái tác vụ.** Định nghĩa chung các trạng thái `queued`, `preflight`, `running`, `cancelling`, `completed`, `failed`, `cancelled`, cùng `taskId`, `profileId`, `database`, thời điểm, bytes/rows/objects, phần trăm (nếu ước tính được), object hiện tại, lỗi có cấu trúc và phạm vi thay đổi. Dùng hợp đồng này để UI và main không đoán trạng thái từ chuỗi log. Không ghi password, private key, token, SQL chứa dữ liệu nhạy cảm vào log mặc định.

**Nghiệm thu M0:** fixture tái tạo lỗi đã nêu; baseline có thể lặp lại trên cùng cấu hình; test hiện hữu không giảm; chưa thay đổi hành vi sản xuất.

## 5. M1 — bảo vệ dữ liệu trong backup, copy và restore

### T1.1 — Preflight chia làm hai cấp

Thêm lớp kiểm tra không ghi dữ liệu trước khi bắt đầu `db:restore` hoặc copy sang database khác. Cấp 1: thông tin tệp và phạm vi SQL (tệp còn tồn tại, kích thước/hash nếu có, schema được phép, câu lệnh không hỗ trợ, số object/record ước lượng). Cấp 2: kiểm tra target (phiên bản MySQL/MariaDB, database đích, object trùng tên, quyền có thể xác minh, `@@log_bin`, `@@log_bin_trust_function_creators`, đặc tính routine trong SQL, dung lượng đĩa khả dụng khi truy cập được). Báo cáo riêng `blocking`, `warning`, `unknown`. Chỉ `blocking` ngăn chạy; `unknown` không được đổi thành dấu tích thành công.

Với function thiếu `DETERMINISTIC`, `NO SQL` hoặc `READS SQL DATA` trên target có điều kiện binary logging tương ứng, hiển thị tên routine, lý do và cách xử lý phù hợp (sửa định nghĩa **nếu đúng về mặt ngữ nghĩa**, dùng quyền/chính sách do DBA cấp, hoặc bỏ chọn object). Không tự thêm nhãn `DETERMINISTIC` sai sự thật; không âm thầm bật `log_bin_trust_function_creators` toàn server. Nếu preflight không thể xác minh đặc quyền hoặc thay đổi cấu hình đích giữa lúc quét và chạy, dừng hoặc cảnh báo đúng mức, không bảo đảm tuyệt đối.

**File dự kiến:** `electron/database.cjs`, `electron/restore-scan-worker.cjs`, `electron/sql-script.cjs`, `electron/main.cjs`, một module preflight thuần mới, `app.js`, test `database-restore`, `database-routines`, `main-transfer`.

**Nghiệm thu:** fixture `SPLIT_STR` bị chặn/trình bày trước câu ghi đầu tiên; không có thay đổi trên target khi preflight bị chặn; kết quả preflight có mã máy đọc được và tên object cụ thể; test có trường hợp không đủ thông tin trả `unknown`.

### T1.2 — Chính sách đích và tác động một phần

Ở màn copy/restore, hiển thị rõ database đích, tùy chọn tạo database mới hoặc ghi vào database đang có, số object dự kiến tạo/ghi đè/xóa, cảnh báo transaction DDL không bảo đảm hoàn tác toàn bộ. Mặc định đề xuất database mới khi copy/restore từ backup; chỉ cho ghi đè khi người dùng chọn rõ và xác nhận tên database đích. Nếu cần cutover từ database tạm sang tên cũ, thiết kế thao tác riêng có backup nguồn, kiểm tra phụ thuộc và quy trình phục hồi; không mô tả việc đổi tên nhiều bảng là atomic cho cả database.

Khi lỗi/hủy sau khi đã ghi: dừng gửi SQL mới, giải phóng tài nguyên, giữ log/báo cáo, hiển thị trạng thái **“đích có thể đã thay đổi một phần”** cùng object cuối cùng, số câu chạy và các bước kiểm tra thủ công. Không tự retry, tự xóa target hay tự rollback toàn database. Với restore vào database mới, chỉ đề nghị xóa database thử sau khi kiểm tra đúng tên và được xác nhận riêng.

**Nghiệm thu:** lỗi ở giữa 100 câu SQL, mất mạng và hủy tác vụ đều để lại báo cáo tác động; không hiển thị “thành công” hoặc “đã hoàn tác” khi chưa chứng minh; query ở tab khác vẫn sử dụng được nếu kết nối độc lập còn hoạt động.

### T1.3 — Tính toàn vẹn của tệp backup

Giữ cơ chế ghi `.part` và đổi tên sau khi đóng/fsync. Bổ sung manifest nhỏ có version, nguồn, thời gian, lựa chọn object, bytes, kết quả, checksum SHA-256 của tệp hoàn chỉnh và trạng thái kiểm chứng; ưu tiên tính checksum ngay trong luồng ghi để tránh đọc thêm hàng chục GB. Tệp backup cũ không có manifest vẫn phải được nhận diện là “chưa có checksum”, có thể xác minh thủ công và restore theo chính sách phù hợp. Khi sao chép file backup, kiểm tra checksum nguồn/đích; nếu chỉ có hash sau khi copy, vẫn không đánh dấu trước là verified. Không lộ secret/SQL trong manifest.

Phân biệt: “đã ghi tệp”, “checksum khớp” và “đã thử restore thành công” là ba mức khác nhau. Test round-trip có cả schema và dữ liệu; kiểm tra số dòng, FK và giá trị mẫu/aggregate, rồi ghi rõ phạm vi xác minh. Không dùng row count đơn thuần làm bằng chứng toàn vẹn tuyệt đối.

**File dự kiến:** `electron/backup-file.cjs`, `electron/backup-catalog.cjs`, `electron/database.cjs`, test tương ứng.

**Nghiệm thu:** hết dung lượng, bị kill giữa ghi, đổi tên lỗi, checksum sai và backup cũ đều có kết quả rõ; `.part` không xuất hiện như backup hoàn chỉnh.

### T1.4 — Kiểm soát tiến trình và log

Luồng progress cập nhật có giới hạn tần suất (ví dụ tối đa 5–10 lần/giây), giữ ring buffer log hữu hạn, ghi tên object hiện tại và số object/record đã xử lý. `%` backup cần nhãn “ước tính” nếu dựa trên kích thước/row estimate; restore phân biệt giai đoạn quét và thực thi. Không đặt `0%` mãi khi đang chạy nhưng chưa biết tổng: dùng tiến trình không xác định. Nút hủy chỉ báo hoàn thành sau khi main xác nhận dừng ở ranh giới an toàn; bảo đảm task cũ không ghi đè trạng thái task mới.

**Nghiệm thu:** tab tác vụ vẫn hiển thị object và thời gian khi xử lý file lớn; bộ nhớ log hữu hạn; tab query mở/đóng không làm mất tiến trình; không có phần trăm giả chính xác.

## 6. M2 — kết nối an toàn và hardening Electron

### T2.1 — SSL/TLS, SSH và profile cũ

Profile MySQL mới qua mạng nên mặc định xác thực certificate khi bật TLS. Nếu kết nối qua SSH tunnel tới MySQL loopback và không bật TLS, UI phải nói rõ SSH bảo vệ đoạn từ máy người dùng đến SSH host, còn đoạn từ SSH host đến MySQL phụ thuộc địa chỉ đích và cấu hình thực tế. Không suy diễn “an toàn toàn tuyến” chỉ vì có tunnel. Cung cấp CA cert khi cần; khi người dùng chủ động tắt xác thực TLS, hiển thị cảnh báo ngay cạnh cấu hình và trong trạng thái kết nối.

Profile đã lưu với `ssl.verify !== true` phải được giữ cách kết nối hiện tại để không làm hỏng công việc của người dùng; migration thêm trạng thái/cảnh báo và đường nâng cấp rõ ràng, không âm thầm đổi trường verify. Kiểm tra kết hợp MySQL `mysql_clear_password`: chỉ cho phép khi vận chuyển đáp ứng chính sách đã định (TLS đã xác thực hoặc tunnel đủ điều kiện), nêu rõ điểm chưa thể xác minh. SSH host key tiếp tục được kiểm tra; test đổi host key, certificate hết hạn/tên không khớp, server không hỗ trợ TLS và profile cũ.

**File dự kiến:** `electron/database.cjs`, `electron/store-schema.cjs`, `app.js`, `electron/preload.cjs`, test SSL/SSH/profile migration.

**Nghiệm thu:** profile mới không mặc định chấp nhận cert giả; profile cũ không bị mất kết nối do migration; mọi chế độ không xác thực có trạng thái nhìn thấy; thông báo lỗi phân biệt SSH auth, MySQL auth, TLS và cleartext auth.

### T2.2 — IPC, renderer và CSP

Đưa các `ipcMain.handle` đang đăng ký trực tiếp (`app:metadata`, `state:*`, `file:*`) vào cùng lớp kiểm tra sender/frame như `handle(...)`; xác thực payload và giới hạn kích thước/định dạng/đường dẫn tại main. Mỗi channel chỉ trả dữ liệu tối thiểu. Thay inline handler trong HTML/template bằng event delegation hoặc listener gắn từ script; sau đó bỏ `script-src 'unsafe-inline'` và chạy test Electron thật. Rà soát render HTML có dữ liệu SQL/file/server để dùng `textContent` hoặc escape đã chuẩn hóa; test chuỗi độc hại trong tên database, bảng, cột, file.

**File dự kiến:** `electron/main.cjs`, `electron/preload.cjs`, `index.html`, `app.js`, test `main-navigation`, renderer smoke và test IPC mới.

**Nghiệm thu:** IPC từ frame không tin cậy bị từ chối; payload sai được báo lỗi có mã; ứng dụng vẫn chạy với CSP chặt hơn; không lộ secret vào DOM/log; không làm hỏng shortcut/menu hiện tại.

## 7. M3 — đo và tối ưu hiệu năng thực

### T3.1 — Benchmark cố định

Đo backup, restore và copy trên bộ dữ liệu 1 GB, 10 GB, 20 GB (hoặc lớn hơn nếu có phần cứng), schema ít bảng và nhiều bảng, InnoDB và mixed engine, local/SSH/TLS. Mỗi kịch bản chạy ít nhất 3 lần trên cùng máy; ghi median và p95 cho thời gian tác vụ, throughput MB/s, CPU, RSS/heap, độ trễ click/chuyển tab/gõ SQL, thời gian giữa hai progress event. Chụp bản build/commit, cấu hình server, warm/cold cache và điều kiện mạng. So sánh với baseline M0, không so sánh số từ máy khác.

Đặt ngưỡng nghiệm thu ban đầu: thao tác UI thông thường p95 dưới 200 ms trong lúc transfer trên máy benchmark, không hiện hộp thoại “not responding”, bộ nhớ không tăng không giới hạn theo kích thước file, kết quả khôi phục khớp bộ fixture; throughput không giảm quá 10% so với baseline nếu không có lý do an toàn dữ liệu được ghi nhận. Nếu máy benchmark không đạt ngưỡng vì giới hạn phần cứng, ghi số đo và đặt ngưỡng phù hợp trước khi sửa, không sửa tiêu chí sau khi thấy kết quả chỉ để pass.

### T3.2 — Sửa điểm nghẽn theo profile

Đầu tiên profile CPU/main thread, event loop delay, số lần render và lượng log/IPC. Nếu nút thắt là parse/escape/serialize, chuyển **công việc CPU thuần** sang worker hoặc chia lô với backpressure; main vẫn quản lý quyền, kết nối DB, file và hủy. Nếu nút thắt là DB/disk/network, tối ưu batch size, statement generation, stream high-water mark và số kết nối dựa trên kết quả đo. Không chạy nhiều restore đồng thời vào cùng target; không tăng concurrency khi có nguy cơ FK/DDL/lock. Không chuyển secret sang worker một cách mặc định. Kiểm tra hủy và shutdown ở mọi ranh giới.

**Nghiệm thu:** có biểu đồ/số liệu trước-sau gắn với PR; cải thiện đúng bottleneck; các bài thử lỗi M1 vẫn pass; query song song phản hồi trong giới hạn đã thống nhất.

### T3.3 — Bài thử sự cố và độ bền

Gây mất SSH/network, MySQL restart, disk full, file bị sửa sau scan, app bị kill, cửa sổ đóng khi transfer, cancel tại scan và execute, backup chứa SQL không hợp lệ/ngoài scope. Kiểm tra temp file, catalog, connection lease, thông báo UI và dữ liệu đích sau mỗi lỗi. Thử cả backup/restore qua phiên bản cài đặt thật, không chỉ unit test. Mỗi lỗi phải có mã, trạng thái cuối và cách tiếp tục rõ.

## 8. M4 — UX và cấu trúc mã

### T4.1 — Luồng kết nối và tác vụ

Chia form kết nối thành phần cơ bản (host, port, user, database), bảo mật (TLS/SSH) và nâng cao; hiển thị trạng thái kiểm tra kết nối và lỗi đúng lớp, không yêu cầu người dùng hiểu `mysql_clear_password` trước khi biết nguyên nhân. Giữ mật khẩu SSH khi mở lại form nếu đã lưu an toàn; placeholder phải cho biết có secret đã lưu hay chưa, tránh hiểu “rỗng” là đã mất. Backup/restore trình bày lần lượt phạm vi, target, preflight, xác nhận, progress, kết quả. Có nhật ký có thể sao chép sau khi loại secret, object hiện tại và đường dẫn backup có nút mở thư mục.

Đặt cỡ chữ đọc được cho nội dung thường (mục tiêu 13–14 px trở lên trên màn tiêu chuẩn), độ tương phản và focus rõ; modal dài có header/footer cố định, phần nội dung cuộn; tab và menu hỗ trợ bàn phím. Thử trên cửa sổ nhỏ và hệ điều hành thực. Các cảnh báo có hành động cụ thể; trạng thái “đang chạy”, “hủy đang chờ” và “thay đổi một phần” phải khác nhau về chữ, không chỉ màu.

**Nghiệm thu:** tối thiểu 5 lượt kiểm thử tác vụ kết nối → query → backup → restore với người chưa viết phần mềm; ghi thời gian hoàn tất, chỗ nhầm, lỗi nghiêm trọng và sửa lại trước phát hành. Với nhóm nhỏ, có thể dùng 5 người nội bộ chưa làm trực tiếp luồng đó; ghi rõ giới hạn của mẫu.

### T4.2 — Editor và bảng dữ liệu

Giữ query đa câu, tab kết quả, autocomplete và chỉnh sửa dòng hiện có. Bổ sung/hoàn thiện thông báo truy vấn ảnh hưởng nhiều dòng, confirm trước SQL phá hoại nếu product decision yêu cầu, trạng thái transaction, thời gian chạy, số dòng và export kết quả. Với autocomplete, test tên database/schema, table/column, alias và câu SQL đang gõ; không chèn gợi ý vào literal/comment. Các tính năng như explain plan, snippet, format nâng cao chỉ đưa vào sau khi M1–M3 đạt, có yêu cầu và test riêng.

### T4.3 — Tách module theo hành vi, không rewrite một lần

`app.js` và `electron/database.cjs` lớn; trích lần lượt mã thuần hoặc khu vực ít phụ thuộc: transfer state/progress formatter, backup view/controller, connection form, preflight/result mapper; ở main tách transfer orchestration và error mapping. Mỗi bước giữ API preload và trạng thái lưu trữ, có test contract trước khi dời mã. Không đổi framework hoặc editor dependency chỉ để giảm số dòng; chỉ thêm khi có lợi ích đo được và kế hoạch đóng gói/bảo mật.

**Nghiệm thu:** PR nhỏ, `git diff` giới hạn phạm vi; các test luồng hiện hữu pass; không làm tăng số biến global/đường truy cập secret; tài liệu `agent.md` được cập nhật theo kiến trúc thực sau khi merge.

## 9. M5 — CI, bộ cài và phát hành

**T5.1 — Ma trận tương thích.** CI chạy unit, renderer, website, server; test tích hợp MySQL 8.4 và một phiên bản MariaDB được hỗ trợ rõ ràng. Test installed build trên Windows 10/11 và Ubuntu LTS mục tiêu: mở app, tạo/kết nối profile thử, query, backup, restore, đóng/mở lại, nâng cấp từ bản trước. Nêu chính xác phiên bản OS/DB đã kiểm, không ghi “hỗ trợ mọi phiên bản”.

**T5.2 — Quy trình version/tag/artifact.** Đồng bộ version root `package.json` và `package-lock.json` trong PR phát hành; workflow phải fail nếu lệch hoặc tag `vX.Y.Z` không khớp package. Build từ commit/tag cố định, xuất SHA-256 và kiểm tra checksum cho từng artifact. Website chỉ hiển thị tải trực tiếp khi asset của release tương ứng có thật; fallback phải nói rõ chưa có bộ cài. Kiểm tra các tên file `.deb`, AppImage, NSIS, portable và kiến trúc CPU được hiển thị đúng.

**T5.3 — Ký mã và provenance.** Thiết lập chứng thư ký Windows trong secret của CI hoặc dịch vụ ký được cấp quyền; không đưa private key vào repo. Xác minh chữ ký trên máy Windows sau khi tải. Nếu chưa có chứng thư, chỉ phát hành beta có ghi rõ hạn chế, không tuyên bố stable. Với Linux, kiểm tra checksum, nguồn release và tài liệu cài đặt; cân nhắc ký gói theo kênh phân phối khi có hạ tầng phù hợp.

**T5.4 — Vận hành.** Viết release notes gồm thay đổi dữ liệu/schema, migration, lỗi đã sửa và giới hạn còn biết. Tạo runbook hỗ trợ: thu log đã ẩn secret, tái hiện lỗi, nơi chứa backup, cách khôi phục từ bản cũ, cách rollback bộ cài mà không xóa dữ liệu người dùng. Chỉ xuất bản khi checklist Go/No-Go ở mục 11 đạt.

## 10. M6 — đồng bộ tùy chọn và backlog sau stable

Trước khi mở rộng đồng bộ, PM quyết định chính sách khóa khôi phục: người dùng có được xuất recovery kit mã hóa không, mất khóa thì dữ liệu nào không khôi phục được, quy trình đổi thiết bị và xóa tài khoản. Viết threat model ngắn cho dữ liệu profile/secret và kiểm tra server SQLite theo lưu lượng dự kiến, backup server, migration, giám sát và giới hạn kích thước vault. Tách acceptance của sync khỏi điều kiện ship desktop core nếu sync vẫn gắn nhãn beta/optional.

Các tính năng sau stable như pause/resume transfer, task queue bền qua restart, visual query builder, đa hệ DB, profiler nâng cao phải có thiết kế riêng. Pause/resume restore đặc biệt cần checkpoint idempotent; không thêm nút Pause khi backend chưa chứng minh có thể tiếp tục an toàn.

## 11. Điều kiện nghiệm thu phát hành (Go/No-Go)

Một bản public stable chỉ được “Go” khi tất cả điều sau có bằng chứng gắn với commit/tag:

1. Backup/restore/copy pass fixture MySQL và MariaDB, gồm routine binary logging, FK, BLOB/JSON/Unicode; test lỗi giữa chừng cho thấy rõ tác động một phần và không báo hoàn tác sai.
2. Có ít nhất một lượt restore thực từ backup lớn trên máy thử, xác minh dữ liệu theo phạm vi đã định; báo cáo kích thước, thời gian, RAM và độ phản hồi UI. Nếu chưa thử mốc 20 GB, ghi giới hạn hỗ trợ đã kiểm chứng thay vì suy diễn.
3. Kết nối mới có mặc định bảo mật đã kiểm; profile cũ có cảnh báo/migration; CSP và IPC test pass; không có secret trong log mặc định.
4. Installed builds Windows/Ubuntu mở và chạy smoke; version/tag/lockfile/asset/checksum khớp; Windows stable có chữ ký hợp lệ.
5. Toàn bộ bộ test bắt buộc pass; lỗi P0/P1 đã đóng hoặc có quyết định phạm vi rõ bằng văn bản; hướng dẫn backup/restore, rủi ro ghi một phần và recovery được cập nhật.

**No-Go tuyệt đối:** có trường hợp restore báo thành công khi dữ liệu không đúng; tác vụ thất bại mà UI che giấu target đã thay đổi; file backup lỗi được liệt kê như bản hoàn chỉnh; lộ mật khẩu/private key; ứng dụng treo liên tục ở bài benchmark đã chọn; bộ cài/tag không khớp nguồn.

## 12. Cách giao việc cho agent/nhóm

Tạo issue/PR theo thứ tự `T0.x → T1.x/T2.x → T3.x → T4.x → T5.x`. Mỗi issue ghi: đầu vào/fixture, hành vi hiện tại, hành vi mong muốn, file dự kiến, rủi ro dữ liệu, migration, test cần thêm, tiêu chí nghiệm thu ở trên. Agent nhận việc phải đọc `agent.md`, không sửa/format ngoài phạm vi, không đè thay đổi sẵn có; trước khi merge phải có test và một người review riêng cho P0.

Đề xuất chia trách nhiệm: người DB/Electron sở hữu M1 và phần main của M2; người UI sở hữu renderer/form/progress và accessibility; người QA sở hữu fixture, benchmark và installed smoke; người phụ trách release sở hữu version, CI, signing và website. Với một agent duy nhất, vẫn giữ thứ tự phụ thuộc và PR nhỏ. Không cho một agent vừa tự đưa thay đổi restore P0 vừa tự xác nhận Go/No-Go mà không có kiểm tra độc lập.

Mẫu báo cáo cuối mỗi PR: **thay đổi**, **dữ liệu có thể bị tác động**, **migration/tương thích**, **test đã chạy và kết quả**, **test chưa chạy/lý do**, **số đo trước-sau nếu liên quan hiệu năng**, **ảnh hoặc video UI nếu liên quan tương tác**, **cách rollback**.

## Tài liệu kỹ thuật tham chiếu

- Electron Security Checklist: https://www.electronjs.org/docs/latest/tutorial/security
- Electron code signing: https://www.electronjs.org/docs/latest/tutorial/code-signing
- MySQL implicit commit statements: https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html
- MySQL stored program binary logging: https://dev.mysql.com/doc/refman/8.4/en/stored-programs-logging.html

Các link trên giải thích ràng buộc kỹ thuật; hành vi thực tế của SqlPro phải được xác minh bằng test trên phiên bản server mục tiêu.
