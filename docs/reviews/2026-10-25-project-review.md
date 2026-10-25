# Review SqlPro — 25/10/2026, đã triển khai bản sửa

## Kết quả xử lý O1–O7 — trạng thái mới nhất

**Đã sửa O1–O7**, giữ nguyên các thay đổi và tính năng R1–R5 của đợt trước. Cấu trúc mới ưu tiên các ranh giới có trách nhiệm rõ, không thêm framework hoặc lớp chỉ để đủ tên pattern.

| Mục | Thay đổi và pattern áp dụng | Kiểm chứng |
| --- | --- | --- |
| **O1 — phiên đang bận bị LRU đóng** | SessionRegistry quản lý tài nguyên; lease/reference count bảo vệ mọi thao tác IPC, activeTask, transaction và autocommit tắt. Admission tuần tự chỉ loại phiên rảnh; hết chỗ trả SESSION_BUSY. | Test registry và main mở thêm 8 profile trong lúc query nền đang chạy; phiên nền còn sống. |
| **O2 — mở trùng connection** | Single-flight theo profile, factory tạo session được inject. Generation vô hiệu hóa kết quả mở cũ khi disconnect/edit/remove; admission giữ đúng giới hạn khi mở nhiều profile đồng thời. | Test gộp promise, mở lỗi rồi retry, pending disconnect rồi mở lại, tạo nhiều profile đồng thời. |
| **O3 — đóng quá hạn** | Cleanup idempotent có deadline: timeout hoặc end ném lỗi sẽ destroy socket, sau đó đóng SSH; callback muộn không dọn hai lần. | Test end không phản hồi, end ném lỗi và callback muộn. |
| **O4 — kết quả SQL không có ngân sách byte** | ResultBudget tách logic giới hạn dòng/byte. Tối đa 8 MiB dữ liệu dòng mỗi kết quả và 16 MiB mỗi batch; có lý do row-limit/byte-limit. Khi chạm giới hạn, dùng control connection gửi KILL QUERY và giữ phiên/transaction gốc. | Unit test byte escaping, ô quá lớn và ngân sách batch; MySQL 8.4.3 thật dừng query dài, giữ cập nhật chưa commit, rollback được rồi tiếp tục SELECT trên cùng phiên. |
| **O5 — COUNT/OFFSET/tìm kiếm** | TableDataService tách lập kế hoạch SQL và cache COUNT có TTL. Lấy dữ liệu trước, đếm theo nút Đếm tổng/Đếm lại; cache 15 giây tối đa 100 key, invalidation khi phiên ghi. Keyset cho thứ tự PK, OFFSET fallback; sort có PK tie-breaker. UI lọc theo cột và chứa/bằng; so sánh chính xác theo cột dùng codec kiểu chung. | Unit test cursor/cache TTL/invalidation/validation; MySQL thật tiến/lùi qua khóa ghép, count cache và exact filter; Electron kiểm tra nút đếm, gửi bộ lọc và layout 940×700. |
| **O6 — indexOf O(n²)** | query-results.js là module trình bày thuần với comparator dùng chung, lưu origIndex trước sort; không tìm lại vị trí từng row. Đã thêm file vào HTML và cấu hình đóng gói. | Test indexOf ném lỗi vẫn render/sort được và mapping về đúng dòng gốc. Probe 5.000 dòng: 0 lời gọi indexOf, sinh chuỗi HTML khoảng 18 ms so với mẫu trước khoảng 33 ms. |
| **O7 — hash chặn event loop** | Scrypt bất đồng bộ, không đổi KDF. Semaphore/async gate giới hạn 2 hash đang chạy, 32 chờ; đầy trả 503 AUTH_BUSY và Retry-After. Giữ timing-safe và dummy verification, route chờ hash trước khi truy cập DB tiếp. | Test hàng đợi đầy/khôi phục, định dạng verifier cũ, timer chạy trước khi loạt hash xong và /healthz đáp ứng khi có burst login thật. |

Các module mới: [SessionRegistry](../../electron/session-registry.cjs), [ResultBudget](../../electron/result-budget.cjs), [TableDataService](../../electron/table-data.cjs), [query-results](../../query-results.js), [async gate](../../server/src/async-gate.cjs). Quy ước kiến trúc đã bổ sung trong [agent.md](../../agent.md).

### Kiểm chứng đợt tối ưu

- npm run check: **199 đạt, 0 lỗi**; 1 nhóm MySQL opt-in được bỏ qua khi không đặt cổng, tổng runner 200 test.
- npm run test:renderer: **34/34**; đã xem ảnh bộ lọc/counter ở cửa sổ nhỏ.
- npm run test:mysql: **9 kịch bản tích hợp đạt**, runner báo 10/10 tính cả nhóm; MySQL **8.4.3** thật, instance tạm chỉ bind loopback.
- npm run server:test: **16/16**, gồm burst login và khả năng đáp ứng health.
- npm --prefix server run check và npm run test:website: đạt; website **14/14**.
- git diff --check: đạt; chỉ có cảnh báo chuẩn hóa LF/CRLF.

Instance MySQL tạm đã dừng sau kiểm thử, không còn database sqlpro_test_* và datadir tạm đã được dọn. Không dùng dữ liệu MySQL Laragon hiện có.

Probe cục bộ sau sửa: 5 hash async mất khoảng 162 ms tổng cộng, timer được phục vụ sau khoảng 2 ms. So với mẫu trước 243 ms chặn timer, ý nghĩa chính là event loop không còn bị chặn; đây không phải benchmark p95 production hoặc cam kết tốc độ hash. Thời gian render HTML cũng chưa gồm DOM/layout/paint.

### Giới hạn có chủ đích

- Ngân sách byte áp dụng cho JSON của dữ liệu dòng SQL result giữ lại, không phải giới hạn toàn bộ heap/metadata hay kích thước tệp export. Driver vẫn có thể phải đọc một packet/giá trị lớn trước khi ứng dụng quyết định dừng; một row quá lớn có thể không xuất hiện trong lưới, nhưng vẫn xuất toàn bộ qua luồng tệp.
- Control connection dùng cùng tài khoản. Nếu không thể mở kết nối điều khiển hoặc server không cho ngắt query, ứng dụng đọc bỏ phần dư trong timeout hiện có, không tự phá transaction để cắt hiển thị; UI phản ánh trạng thái thực tế.
- Keyset áp dụng khi có cursor hợp lệ và thứ tự theo PK; sort cột khác/nhảy trang không có cursor dùng OFFSET với thứ tự ổn định. COUNT cache có thể cũ khi nguồn khác ghi dữ liệu; dùng Đếm lại/Làm mới để cập nhật.
- Kết quả tích hợp lần này dùng MySQL 8.4.3; chưa chạy MariaDB thật, GitHub Actions remote hay tạo installer. Các đề xuất tính năng riêng như schema diff, lịch backup, recovery key và data-grid Commit/Rollback vẫn là roadmap.

## Kết quả sửa R1–R5 và kiểm chứng đợt trước

**R1–R5 đã được sửa và có kiểm thử hồi quy.** Phần backup của F3 đã dùng kết nối riêng; snapshot và transaction được kiểm chứng trên MySQL 8.4.3 thật. Bảng dưới là trạng thái mới nhất, thay thế các kết luận trong lịch sử review.

| Mục | Bản sửa cuối | Kiểm chứng |
| --- | --- | --- |
| **R1 / F2 — JSON và số lớn** | Dựng own property an toàn cho mọi key; dùng WeakSet nhận diện JsonNumber, không dựa vào prototype kế thừa. Giữ nguyên khóa __proto__ ở root/nested và số lớn. | Parser round-trip, kiểm tra giả mạo prototype; import JSON chứa __proto__, BIGINT/BIT trên MySQL thật. |
| **R2 / F1 — store sai cấu trúc** | Validate phiên bản, collection, ID/phần tử trùng hoặc hỏng và tham chiếu workspace trước normalize/migration. Lỗi trả STORE_READ_FAILED, giữ nguyên tệp; vẫn hỗ trợ migration v1 hợp lệ. | Test list/save với store hỏng không ghi đè; migration v1 giữ nguyên kết nối và secret đã niêm phong. |
| **R3 — form SSH** | Dialog tin cậy riêng, giữ nguyên form và dữ liệu nhập. Nhớ fingerprint đã chấp nhận trong state của form. Escape chỉ đóng xác nhận; hủy hoặc retry lỗi vẫn sửa/lưu được. | Electron thật: chấp nhận rồi Lưu, hủy, retry lỗi và Escape; kiểm tra form giữ nguyên và fingerprint được gửi khi lưu. |
| **R4 / F6 — dữ liệu export** | Kết quả có SQL nguồn dùng backend streaming cả khi ít dòng; không xuất preview BLOB. Nhánh không có SQL chặn dữ liệu thiếu và giữ kiểu JSON/key đặc biệt. Lưu SQL/context của EXPLAIN và database từng statement trong batch có USE. | MySQL thật: 1 dòng BLOB 64 byte còn đầy đủ, JSON gốc/số lớn, tên cột trùng và alias __proto__; test renderer/context/batch. |
| **R5 — tiến trình và hủy** | Có taskId, tiến trình, nút hủy; chặn tác vụ chồng nhau từ trước hộp thoại lưu. Hủy được lúc chuẩn bị hoặc đang stream; kiểm tra lại hủy sau lần ghi cuối. Escape không làm mất modal tiến trình. | Test IPC pending/stream, renderer gửi đúng ID/profile, Electron bấm hủy và MySQL hủy stream; test final buffered write. |
| **F3 — backup** | Main tạo DatabaseSession riêng, đóng trong finally và điều hướng hủy đúng worker. InnoDB dùng consistent snapshot; engine khác trả cảnh báo, hiện trong UI và ghi rõ chế độ nhất quán ở header backup. | Test main không chạm phiên SQL người dùng; MySQL thật có writer commit giữa snapshot, transaction người dùng đang mở và engine hỗn hợp. |
| **F4 / F5 / F7** | Giữ các bản sửa khóa binary/BIT, coerce import dùng chung và renderer smoke trên CI/build. Thêm job MySQL 8.4 tích hợp riêng. | Unit, renderer và MySQL thật đạt; chưa chạy workflow GitHub remote trong phiên này. |

Kiểm thử MySQL đã phát hiện thêm trường hợp driver mysql2 không chấp nhận alias __proto__ ở parser động dù trả mảng. Các truy vấn trả mảng chuyển sang parser tĩnh với disableEval để giữ tên cột đặc biệt. Đồng thời sửa trường hợp hủy đúng lúc flush cuối nhưng tác vụ vẫn trả thành công.

### Kết quả kiểm tra cuối

| Lệnh | Kết quả |
| --- | --- |
| npm run check | **186 đạt, 0 lỗi**; 1 nhóm MySQL opt-in được skip khi không đặt cổng; tổng runner 187 test |
| npm run test:renderer | **33/33**; đã xem ảnh chụp dialog SSH và tiến trình export |
| npm run test:mysql với SQLPRO_TEST_MYSQL_PORT | **7 kịch bản tích hợp đạt**, runner báo 8/8 tính cả nhóm; MySQL 8.4.3 thật |
| npm run test:website | **14/14** |
| npm --prefix server run check và npm run server:test | **Đạt, 13/13 test server** |
| git diff --check | **Đạt**; cảnh báo LF/CRLF không phải lỗi diff |

MySQL được khởi tạo riêng trong thư mục tạm, chỉ bind 127.0.0.1 ở cổng kiểm thử. Database sqlpro_test_* do test tạo đã được xóa, instance đã dừng và datadir tạm đã được dọn; không dùng dữ liệu MySQL Laragon hiện có. Cách chạy lại test nằm trong [README](../../README.md).

### Giới hạn và phần chưa triển khai

- Snapshot dữ liệu bảo đảm cho tập bảng InnoDB được chọn; engine hỗn hợp/không transaction cần tạm dừng ghi, đã có cảnh báo. Không hứa bảo đảm schema nhất quán khi có DDL đồng thời; UI yêu cầu tránh đổi cấu trúc trong lúc backup.
- Export có SQL nguồn sẽ **chạy lại câu lệnh tại thời điểm xuất**, có thông báo trong tiến trình. Dữ liệu có thể khác kết quả đã xem nếu server thay đổi sau lần chạy trước.
- Kiểm chứng tích hợp lần này dùng MySQL 8.4.3; chưa chạy MariaDB thật hoặc workflow GitHub remote. Chưa tạo installer hay triển khai bản phát hành.
- Những đề xuất roadmap như phát hiện xung đột, Commit/Rollback data grid, connection chỉ đọc, schema diff, lịch backup và recovery key vẫn là công việc riêng, không thuộc đợt sửa lỗi này.

## Review tối ưu trước khi xử lý O1–O7 — lịch sử 25/10/2026

> Phần này ghi nhận tình trạng trước bản tối ưu. Trạng thái và kiểm chứng mới nhất nằm ở đầu tài liệu.

Lượt này chỉ review, chạy probe trong bộ nhớ và cập nhật tài liệu; không sửa code ứng dụng. R1–R5 ở trên vẫn là các hạng mục đã xử lý. Các phát hiện O1–O7 dưới đây là công việc tiếp theo về vòng đời session, hiệu năng và khả năng mở rộng.

### O1 — P1: Cache có thể đóng session đang chạy truy vấn

- Code: [openSession/LRU](../../electron/main.cjs:431), đặc biệt chọn phiên để đóng tại dòng 458.
- Khi vượt 8 phiên, bộ cache chỉ loại trừ activeSession. Nó chưa loại trừ session có activeTask hoặc thao tác đang dùng phiên. Một query tab chạy nền có thể dùng phiên khác với connection đang hiển thị.
- Đã tái hiện bằng VM chạy main thật với session giả: mở p0, đặt activeTask đang chạy, mở tiếp tới p8 → p0 bị close và xóa khỏi cache dù đang bận. Đây là kiểm chứng việc chọn/đóng phiên, chưa tái hiện trên MySQL thật trong lượt này.
- Tác động: chuyển/mở thêm connection có thể làm gián đoạn query đang chạy nền. Với transaction/session state cần có chính sách bảo vệ riêng, không được suy rằng phiên không hiển thị là phiên rảnh.
- Hướng sửa: pin/reference-count các phiên có tác vụ; chỉ evict phiên rảnh. Khi tất cả đều bận, trả SESSION_BUSY hoặc cho vượt giới hạn tạm có kiểm soát. Test mở phiên thứ 9 khi phiên cũ có query/transfer và xác nhận tác vụ không bị đóng ngoài ý muốn.

### O2 — P2: Hai yêu cầu mở cùng profile có thể tạo hai connection

- Code: [openSession](../../electron/main.cjs:431), khoảng trống giữa kiểm tra cache và await connect tại dòng 446; [ensureSession](../../electron/main.cjs:465).
- Hai lời gọi cùng lúc khi cache chưa có profile đều tạo DatabaseSession riêng. Sau khi connect xong, phiên sau thay entry của phiên trước trong Map nhưng không đóng phiên trước.
- Probe VM: hai openSession('same') đồng thời tạo **2 session sống**, trong cache chỉ có **1 entry**. Có thể gặp khi nhiều yêu cầu metadata cùng khôi phục connection đã chết.
- Hướng sửa: dùng Map chứa promise mở phiên theo profile, dọn trong finally; có generation/token để remove/edit/disconnect không bị kết quả connect cũ đưa phiên trở lại. Test connect đồng thời, connect lỗi và xóa profile khi connect chưa xong.

### O3 — P2: close() quá hạn nhưng chưa cưỡng bức ngắt socket

- Code: [DatabaseSession.close](../../electron/database.cjs:861), timer tại dòng 874.
- Sau 1 giây, timer chỉ resolve. Nếu connection.end không gọi callback, hàm vẫn báo hoàn tất và bỏ tham chiếu connection nhưng không gọi destroy.
- Probe với connection giả bị kẹt end: close trả sau **1.000 ms**, destroy được gọi **0 lần**. Đây là kiểm chứng nhánh cleanup; chưa đo số socket rò thực tế trên server.
- Hướng sửa: timeout phải destroy connection trước resolve; dùng finish idempotent, dọn timer cả khi end/destroy phát lỗi và luôn đóng SSH. Thêm test end không phản hồi, callback muộn và end ném lỗi.

### O4 — P2: Giới hạn số dòng chưa giới hạn kích thước kết quả hoặc lượng dữ liệu phải đọc

- Code: [runQuery](../../electron/database.cjs:1254), [serializeValue](../../electron/database.cjs:64).
- Sau rowLimit, callback chỉ ngừng lưu rows; driver vẫn nhận các result event đến khi end. TEXT/JSON được giữ đầy đủ, khác BLOB có preview. Do đó giới hạn 5.000 dòng không đồng nghĩa giới hạn RAM/IPC hoặc thời gian server/network.
- Probe EventEmitter: giới hạn 2 dòng, vẫn nhận **20.000 dòng**, giữ 2 và trả truncated=true. Probe 8 ô TEXT, mỗi ô 1 MiB: JSON của rows dài **8.388.649 byte**, dù UI chỉ hiển thị 180 ký tự/ô. Đây là kích thước serialized payload, không phải phép đo heap thực tế.
- Hướng sửa: có ngân sách byte cho mỗi kết quả/toàn batch, metadata phân biệt row-limit/byte-limit và lazy fetch giá trị lớn. Cân nhắc connection thực thi riêng để có thể dừng query sau giới hạn; không tự phá connection có transaction hoặc tự chèn LIMIT vào mọi loại SQL. Test nhiều dòng nhỏ, ít dòng rất lớn và hủy/dừng khi đang có transaction.

### O5 — P2: Phân trang đếm tổng lại trước mỗi lần lấy dữ liệu

- Code: [tableData](../../electron/database.cjs:1105), COUNT tại dòng 1131 và OFFSET tại dòng 1138.
- Mỗi lần paging/sort/refresh chạy COUNT trước SELECT trang. Search ghép CAST(... AS CHAR) LIKE '%term%' trên mọi cột. Trang sâu vẫn dùng OFFSET, chưa có keyset/cursor. Đây là các nguồn chi phí theo cấu trúc SQL; chưa có benchmark bảng lớn/EXPLAIN mới để định lượng mức chậm.
- Hướng sửa: tải trang trước, đếm tổng theo yêu cầu hoặc cache ngắn theo profile/database/table/filter; không đếm lại chỉ vì đổi sort. Thêm keyset khi có thứ tự khóa ổn định, fallback OFFSET khi cần nhảy trang. Cho lọc theo cột/kiểu thay vì luôn tìm mọi cột; dùng EXPLAIN trên dữ liệu đại diện trước khi tối ưu index.
- Thứ tự hiện chỉ mặc định ORDER BY khi PK có một cột; nên dùng toàn bộ PK ghép và thêm PK làm tie-breaker khi sort cột không unique để phân trang ổn định.

### O6 — P2: Render kết quả tìm lại index của từng dòng, tạo bước O(n²)

- Code: [singleQueryResultHtml](../../app.js:5036), result.rows.indexOf(row) tại dòng 5064.
- Dù không sort, mỗi dòng vẫn tìm lại vị trí từ đầu mảng. Probe render 5.000 dòng: **5.000 lời gọi indexOf**, tương ứng **12.502.500 vị trí quét**; sinh HTML khoảng **33 ms** trên máy hiện tại. Thời gian này chưa gồm DOM/layout/paint và không đại diện mọi máy.
- Hướng sửa: mang origIndex theo row ngay từ đầu hoặc sort mảng chỉ số. Giữ mapping chính xác để sửa ô sau sort không ghi nhầm dòng. Đây là tối ưu nhỏ có ranh giới rõ; kiểm tra trước khi quyết định virtualize cả grid.

### O7 — P2: Hash đăng nhập đồng bộ chặn event loop server

- Code: [scryptSync](../../server/src/auth.cjs:32), được dùng ở hashSecret/verifySecret trong route đăng ký/đăng nhập.
- Microbenchmark với fixture không nhạy cảm: 5 hash mất khoảng **243 ms**; timer đã lên lịch trước đó không được chạy trong khoảng này. Đây là thời gian hash trực tiếp, chưa phải số đo p95 HTTP khi chịu tải. Rate limit hiện có không loại bỏ chi phí của burst đăng nhập hợp lệ trên cùng process phục vụ website/vault.
- Hướng sửa: crypto.scrypt bất đồng bộ với concurrency/queue có giới hạn, giữ nguyên tham số KDF, kiểm tra timing-safe và dummy verification. Đo p50/p95 của /healthz và vault trong lúc có burst login; không giảm độ khó hash để đổi lấy tốc độ.

### Khả năng bảo trì và thứ tự nên làm

1. **O1–O3 trước:** bảo vệ phiên đang dùng, gộp mở connection đồng thời và cleanup socket chắc chắn.
2. **O4 và O6:** kiểm soát kích thước kết quả, bỏ indexOf theo từng dòng. Chỉ thêm virtualization sau khi đo DOM/layout.
3. **O5:** thay đổi mô hình count/pagination/filter bằng dữ liệu đại diện; không tăng pageSize để che chậm.
4. **O7:** ưu tiên khi server đồng bộ phục vụ nhiều người dùng.
5. **P3 — tách module dần:** app.js hiện khoảng 7.560 dòng, database.cjs 2.450 dòng, main.cjs 1.178 dòng. Tách session registry/transfer lifecycle trước, rồi query-result renderer và metadata/row services. Store đang đọc/ghi đồng bộ nhiều nơi; chỉ cache hoặc chuyển async sau khi đo, với invalidation và ghi tuần tự để giữ các bảo đảm chống mất dữ liệu vừa sửa.

Kiểm chứng riêng lượt này: npm run check **186 đạt, 0 lỗi, 1 nhóm MySQL opt-in bỏ qua**, git diff --check đạt; các probe ở trên chạy trong bộ nhớ, không gọi database/tài khoản người dùng. Không chạy lại Electron/MySQL/server load test trong lượt review chỉ đọc này; các kết quả 33/33 UI và MySQL 8.4 ở phần trước thuộc lần kiểm chứng bản sửa. Các probe mới chưa nằm trong bộ test hồi quy đang theo dõi.

## Lịch sử review trước khi triển khai

<details>
<summary>Hai vòng review trước sửa, giữ để đối chiếu</summary>

## Review lại — kết quả hiện tại

Đối chiếu F1–F7 với working tree phiên bản 0.3.6 và test mới, bao gồm thay đổi luồng tin cậy SSH trong app/main. Hai script Navicat chưa được Git theo dõi không thuộc phạm vi kiểm chứng lượt này. Lượt này chỉ cập nhật tài liệu, không sửa code ứng dụng hay các thay đổi đang có.

**3 mục cũ đã xử lý ở mức code/test local: F4, F5, F7. 4 mục xử lý một phần: F1, F2, F3, F6.** Có thêm lỗi trong parser JSON và hộp thoại SSH. Các kết luận dưới đây thay thế trạng thái của bản review đầu được lưu ở cuối tài liệu.

| Mục cũ | Trạng thái | Đối chiếu bản sửa |
| --- | --- | --- |
| **F1 — store bị ghi đè** | **Một phần** | Chỉ khởi tạo mặc định khi ENOENT; JSON lỗi/I/O/root không phải object trả STORE_READ_FAILED. Test bảo vệ tệp đạt. Object hợp lệ nhưng collection/phần tử sai cấu trúc vẫn có thể bị normalize rồi ghi đè; xem R2. |
| **F2 — số lớn trong JSON** | **Một phần** | Import/preview dùng preserveNumbers; JsonNumber và stringifyJsonValue giữ BIGINT/DECIMAL và số lồng nhau. Lỗi làm tròn số đã sửa, nhưng dựng lại object làm mất khóa __proto__ và có thể đổi kiểu dòng; xem R1. |
| **F3 — snapshot backup** | **Một phần** | Có REPEATABLE READ + CONSISTENT SNAPSHOT khi tất cả bảng dữ liệu được chọn là InnoDB; ROLLBACK trong finally. Vẫn dùng connection người dùng, chưa tách session; engine hỗn hợp bỏ qua snapshot, UI chưa nêu rõ. Chưa kiểm thử ghi đồng thời/transaction/DDL bằng database thật. |
| **F4 — khóa nhị phân khi xóa** | **Đã xử lý ở code/test local** | Update/delete dùng chung rowKeyParameter; có test binary/BIT và chặn preview không đầy đủ. Chưa xác minh trên MySQL/MariaDB thật. |
| **F5 — validation import** | **Đã xử lý các trường hợp đã nêu** | Import số/ngày/ENUM/SET qua coerceValue; test ngày sai lịch, số vượt phạm vi và BIT thành Buffer đạt. Sentinel CSV, JSON và binary vẫn có adapter riêng; không khẳng định đã hợp nhất mọi kiểu hoàn toàn. |
| **F6 — export SQL result** | **Một phần** | CSV dùng chính sách NULL/rỗng chung; JSON tách tên cột trùng; thêm backend streaming khi số dòng bị cắt. Export ít dòng vẫn dùng giá trị serialize/preview; xem R4. Luồng hủy chưa nối đầy đủ; xem R5. |
| **F7 — renderer smoke trong CI** | **Đã bổ sung cấu hình** | CI Linux có Xvfb; workflow installer có smoke Linux/Windows; runner chuyển tiếp --no-sandbox. Test local đạt. Chưa kiểm chứng lần chạy GitHub Actions thực tế. |

## Các phát hiện còn mở sau sửa

### R1 — P1: Parser JSON mới làm mất khóa __proto__, có thể biến cả dòng thành JsonNumber

- Code: [replaceNumberPlaceholders](../../electron/json-array-stream.cjs:53), phép gán tại dòng 67.
- Dựng `const result = {}` rồi gán `result[key] = ...` khiến key `__proto__` đổi prototype thay vì thành own property như khi JSON.parse.
- Đã tái hiện với parser thật, preserveNumbers bật:

```json
[{"payload":{"__proto__":{"keep":1},"n":9007199254740993}}]
```

Serializer trả `{"payload":{"n":9007199254740993}}`, mất key `__proto__`. Với `[{"__proto__":123,"id":1}]`, dòng có own key `id` nhưng `row instanceof JsonNumber === true`, serializer trả `123`; import có thể từ chối object như một số.

- Đây là thay đổi prototype của object vừa dựng; chưa chứng minh tác động lên prototype toàn cục.
- Hướng sửa: dùng object không có prototype hoặc định nghĩa own property an toàn; nhận diện JsonNumber không bị kế thừa giả. Thêm test key đặc biệt ở root/nested/array, giá trị số/object/null và round-trip JSON.

### R2 — P1: Store là JSON hợp lệ nhưng sai cấu trúc vẫn bị ghi đè

- Code: [readStore](../../electron/store.cjs:30), [normalize/migration](../../electron/store.cjs:53), [normalizeStore](../../electron/store-schema.cjs:129).
- Bản sửa chặn JSON lỗi/root sai kiểu, chưa kiểm tra cấu trúc collection/phần tử trước normalization.
- Probe bằng filesystem giả: `{"version":2,"connections":{"old":{"id":"old","host":"db.test"}}}` → gọi list trả 0 kết nối và migration thay tệp gốc bằng store rỗng. `{"version":2,"connections":[{"host":"db.test"}]}` cũng bị bỏ phần tử thiếu id rồi ghi lại.
- Hướng sửa: phân biệt schema cũ được hỗ trợ với dữ liệu hỏng; báo lỗi hoặc giữ bản gốc trước migration có thể làm mất bản ghi. Thêm test collection sai kiểu, phần tử hỏng và phiên bản chưa hỗ trợ.

### R3 — P2: Xác nhận host key SSH làm mất form kết nối chưa lưu

- Code: [handleHostKeyPrompt](../../app.js:6193), [confirmAction](../../app.js:5520), [modal](../../app.js:117).
- Bấm Kiểm tra kết nối gặp host key chưa biết/đã đổi sẽ gọi confirmAction. Hàm này dùng lại #modal và thay innerHTML của form bằng nội dung xác nhận; sau đó đóng dialog, không khôi phục form.
- Đã tái hiện qua renderer VM/DOM giả mô phỏng thay nội dung modal: lần test đầu trả SSH_HOST_KEY_UNKNOWN, chấp nhận fingerprint, retry thành công. Có 2 lời gọi test nhưng không còn #connectionForm, dialog đóng; showSuccess cập nhật node cũ đã bị tách. Nhánh hủy và retry lỗi cũng cần test.
- Hướng sửa: dialog xác nhận riêng hoặc giữ/khôi phục form và state, gồm fingerprint đã chấp nhận để lần Lưu không hỏi lại. Thêm smoke cho chấp nhận, hủy, retry lỗi và Lưu sau Kiểm tra.

### R4 — P2: Export ít dòng vẫn xuất preview BLOB và JSON dạng chuỗi

- Code: [exportCurrentResult](../../app.js:1627), điều kiện backend tại dòng 1655; [serializeValue](../../electron/database.cjs:64).
- Chỉ gọi streaming khi target.truncated là true. Đây là cờ cắt số dòng, không bảo đảm từng giá trị trong ô còn đầy đủ.
- BLOB >32 byte đã thành hex preview có dấu … trước khi tới renderer. Kết quả 1 dòng vẫn có truncated=false; saveTextFile ghi preview vào tệp và báo thành công.
- Probe renderer xác nhận JSON xuất 1 dòng vẫn chứa dấu …, backend không được gọi. Cột JSON trong nhánh này thành chuỗi chứa JSON; backend exportQueryFile lại xuất giá trị JSON gốc.
- Nhánh JSON ít dòng cũng dùng object thường rồi gán tên cột; alias __proto__ cần test để tránh mất cột theo cùng cơ chế ở R1.
- Hướng sửa: chỉ xuất từ renderer khi bảo đảm dữ liệu đầy đủ và chính sách kiểu thống nhất; dữ liệu preview cần backend hoặc thông báo rõ. Nếu chạy lại SQL, nói rõ dữ liệu được đọc lại tại thời điểm xuất. Test ít/nhiều dòng, BLOB dài, BIT, JSON, tên cột đặc biệt.

### R5 — P2: Xuất toàn bộ kết quả truy vấn chưa nối luồng hủy tác vụ

- Code: [request exportQuery](../../app.js:1655), [handler main](../../electron/main.cjs:887), [cancel-task](../../electron/main.cjs:773).
- Renderer không gửi taskId, không khởi tạo modal tiến trình/active transfer như export bảng. Main lưu taskId=null; cancel-task từ chối taskId rỗng.
- Đã đối chiếu request/handler/điều kiện cancel; chưa chạy tác vụ dài trên database thật. Backend có callback hủy nhưng UI hiện chưa nối tới callback qua cancel-task.
- Hướng sửa: tạo ID, dùng chung tiến trình/hủy, chống bấm xuất chồng nhau; test hủy giữa stream, dọn tệp tạm và giữ tệp đích cũ.

## Backup và kiến trúc còn cần hoàn thiện

- F3: [writeBackup](../../electron/database.cjs:1925) mở/rollback snapshot trên this.connection; [main](../../electron/main.cjs:996) vẫn dùng phiên hiện có. Cần kết nối backup riêng và test rằng transaction SQL người dùng không bị ảnh hưởng. Với engine hỗn hợp, trả snapshot=false nhưng UI chưa giải thích giới hạn. Mock mới chỉ kiểm tra thứ tự lệnh; chưa chứng minh snapshot với ghi đồng thời/DDL thật.
- Điểm cải thiện design pattern: import dùng coerceValue chung; update/delete dùng rowKeyParameter; export-values.js tách logic CSV và tên cột. Cần thống nhất tiếp giá trị đầy đủ, progress/cancel và vòng đời modal, thay vì thêm pattern hình thức.
- Kích thước hiện tại: app.js khoảng **7.518 dòng**, database.cjs **2.430 dòng**, main.cjs **1.155 dòng**. Ưu tiên tách controller data/query/connection/transfer và service metadata/row/backup, giữ API IPC ổn định; số dòng không tự thân là lỗi.
- Roadmap bản đầu vẫn hợp lý: phát hiện xung đột, thay đổi chờ lưu/Commit/Rollback, connection chỉ đọc, filter/sort nâng cao, schema diff, lịch backup/retention, recovery key và quản lý phiên.
- Điều chỉnh roadmap: **xuất toàn bộ SQL result đã có bản triển khai đầu tiên**, chuyển sang nhóm cần hoàn thiện R4/R5. Kiểm tra cập nhật/nâng cấp ứng dụng vẫn là tính năng chưa thấy triển khai.

## Kiểm chứng của lần review lại

| Kiểm tra | Kết quả |
| --- | --- |
| npm run check | **Đạt — 175 test**, cú pháp và template website hợp lệ |
| npm run test:renderer | **Đạt — 30/30** |
| npm run test:website | **Đạt — 14/14** |
| npm --prefix server run check | **Đạt** |
| npm run server:test | **Đạt — 13/13** |
| git diff --check | **Đạt**, chỉ cảnh báo LF/CRLF của Git |

Probe bổ sung chạy độc lập trong bộ nhớ: JSON với __proto__, store sai cấu trúc/migration ghi đè bằng filesystem giả, mất form SSH qua renderer VM/DOM giả, export ít dòng giữ preview BLOB và JSON dạng chuỗi. Probe không nằm trong 175 test hiện có; bộ test xanh chưa bao phủ các lỗi mới.

Chưa kết nối MySQL/MariaDB thật, kiểm chứng GitHub Actions remote, tạo installer hay ghi dữ liệu người dùng. Server test dùng SQLite thật; test database desktop dùng mock. Không kiểm tra dịch vụ đang triển khai hoặc lịch sử Git.

**Thứ tự tiếp theo:** R1/R2 và regression test → R3/R4/R5 → session backup riêng và test tích hợp để đóng F3 → xác nhận CI trên runner thật → tách module và làm roadmap.

---

> **Lịch sử: bản review đầu dưới đây được giữ để đối chiếu.** Các mức độ, mô tả code, số dòng và kết quả test trong phần bản gốc là tại thời điểm trước sửa; trạng thái hiện tại nằm ở các mục cập nhật phía trên.

Phạm vi: kiến trúc desktop Electron, database/import/export/backup, parser, lưu cấu hình, đồng bộ, API server, website và CI. Đánh giá trên working tree phiên bản 0.3.6; giữ nguyên các thay đổi đang có trong `app.js`, `electron/main.cjs`, `package.json` và hai script Navicat chưa được theo dõi bởi Git. Review không thay đổi hành vi ứng dụng.

## Bản gốc — Kết luận

Kiến trúc có nền tảng hợp lý: phân lớp main/preload/renderer, facade IPC, repository cho cấu hình, session cho database, module thuần cho parser và kiểu cột, application factory và dependency injection phía server. Không cần áp dụng thêm toàn bộ GoF hay chuyển framework để được coi là “chuẩn”.

Điểm yếu chính là trách nhiệm tập trung trong các tệp lớn và quy tắc chuyển đổi dữ liệu chưa được dùng nhất quán. `app.js` khoảng 7.488 dòng, `electron/database.cjs` khoảng 2.307 dòng và `electron/main.cjs` khoảng 1.107 dòng. Kích thước không tự tạo ra lỗi, nhưng hiện import, sửa ô, xóa và xuất kết quả đã có hành vi khác nhau đối với cùng một kiểu dữ liệu.

## Bản gốc — Phát hiện theo ưu tiên

### F1 — P1: Lỗi đọc cấu hình có thể dẫn đến ghi đè dữ liệu kết nối

- Vị trí: [readStore](../../electron/store.cjs:23), [writeStore](../../electron/store.cjs:38), [save](../../electron/store.cjs:296).
- `readStore()` bắt mọi lỗi, kể cả JSON hỏng hoặc lỗi I/O, rồi trả một store rỗng. Lần lưu tiếp theo ghi store mới lên cùng tệp.
- Đã tái hiện bằng filesystem giả lập trong VM: `connections.json` chứa JSON lỗi → `list()` trả 0 kết nối → lưu một kết nối mới thay thế nội dung cũ; không giữ bản hỏng.
- Hướng sửa: chỉ khởi tạo rỗng khi `ENOENT`; lỗi parse/quyền đọc phải trả mã lỗi riêng, giữ tệp gốc và chặn ghi đè cho tới khi khôi phục hoặc reset có chủ đích. Thêm test cấu hình hỏng và lỗi I/O.

### F2 — P1: Import JSON làm mất độ chính xác của số lớn

- Vị trí: [finishElement](../../electron/json-array-stream.cjs:137), [validateImportValue](../../electron/database.cjs:296).
- Parser dùng `JSON.parse(text)` trước khi biết kiểu cột đích. Chuyển số đã bị làm tròn về chuỗi sau đó không khôi phục giá trị gốc.
- Đã tái hiện: `[{"id":9007199254740993,"payload":{"n":9007199254740993}}]` được đọc thành `9007199254740992` ở cả `id` và giá trị lồng trong `payload`.
- Ảnh hưởng: import BIGINT và JSON có số lớn; export JSON chính xác hiện tại chưa bảo đảm import lại giữ nguyên dữ liệu.
- Hướng sửa: giữ token số/raw JSON trong parser hoặc dùng parser giữ chính xác số, sau đó chuyển theo metadata cột. Cần test vòng export → import với BIGINT, DECIMAL và số trong JSON lồng nhau.

### F3 — P1: Backup nhiều bảng chưa bảo đảm cùng một snapshot

- Vị trí: [writeBackup](../../electron/database.cjs:1824).
- Backup đọc lần lượt metadata và dữ liệu từng bảng; không mở transaction snapshot hay khóa tương ứng trong luồng này.
- Nếu có giao dịch thay đổi các bảng liên quan giữa hai lần đọc, backup có thể chứa trạng thái khác thời điểm giữa bảng cha và con. Đây là thiếu bảo đảm từ cấu trúc code; chưa tái hiện bằng database đang ghi đồng thời.
- Hướng sửa: chế độ snapshot nhất quán cho engine hỗ trợ transaction, dùng kết nối riêng và dọn transaction khi lỗi/hủy. Nêu rõ giới hạn với DDL đồng thời và engine không có transaction. Test tích hợp bằng hai kết nối thật.

### F4 — P2: Xóa dòng bằng khóa nhị phân/BIT chưa dùng cùng cách chuyển đổi với cập nhật

- Vị trí: [serializeValue](../../electron/database.cjs:63), [updateRow](../../electron/database.cjs:1421), [deleteRows](../../electron/database.cjs:1451).
- UI nhận biểu diễn hex; update chuyển khóa nhị phân về byte, nhưng delete đưa thẳng chuỗi vào tham số SQL.
- Probe bằng session giả xác nhận khóa `0x00ff` đi vào DELETE dưới dạng chuỗi `"0x00ff"`, không phải `Buffer` chứa `00 ff`.
- Hướng sửa: dùng chung bộ mã hóa khóa cho update/delete. Khóa bị cắt thành preview phải bị chặn hoặc truyền đầy đủ qua cơ chế riêng. Test cả khóa ghép và BIT.

### F5 — P2: Import và row editor có hai bộ quy tắc kiểu dữ liệu khác nhau

- Vị trí: [validateImportValue](../../electron/database.cjs:296), [tham số import](../../electron/database.cjs:1699), [RowValues](../../row-values.js:1), [coerceValue](../../electron/database.cjs:96).
- Probe xác nhận import chấp nhận `2026-02-30` cho DATE và `256` cho TINYINT UNSIGNED, trong khi row editor từ chối đúng hai giá trị này.
- Import BIT trả chuỗi `1010` và bind trực tiếp; luồng sửa ô chuyển chuỗi bit thành byte. Chưa xác minh kết quả import BIT với MySQL/MariaDB thật trong phiên review này.
- Hướng sửa: tách xử lý sentinel CSV khỏi kiểm tra kiểu, sau đó dùng chung normalization và chuyển đổi sang tham số SQL. Giữ mã lỗi import có số dòng/tên cột. Test ma trận kiểu cột trên các luồng ghi.

### F6 — P2: Xuất kết quả SQL chưa giữ nguyên ngữ nghĩa dữ liệu

- Vị trí: [exportCurrentResult](../../app.js:1626).
- CSV đổi cả SQL NULL và chuỗi rỗng thành cùng giá trị `""`, khác quy ước `\N` của xuất bảng.
- JSON tạo object theo tên cột; kết quả `SELECT a.id, b.id ...` có hai cột cùng tên sẽ ghi đè giá trị đầu trong object.
- Nhánh xuất chỉ dùng các dòng đang được giữ trong renderer; truy vấn có giới hạn hiển thị không xuất được toàn bộ dữ liệu từ nút này.
- Hướng sửa: dùng chung chính sách export, xử lý tên cột trùng rõ ràng và phân biệt “xuất các dòng đang hiển thị” với tác vụ xuất toàn bộ theo luồng. Thêm test NULL/rỗng, tên cột trùng và kết quả bị cắt.

### F7 — P2: CI chưa chạy desktop renderer smoke

- Vị trí: [.github/workflows/ci.yml](../../.github/workflows/ci.yml:18), [build-desktop.yml](../../.github/workflows/build-desktop.yml:1).
- Workflow chạy unit/syntax, website, server và Docker; chưa gọi `npm run test:renderer`. Workflow đóng gói cũng chỉ chạy `check` trước build.
- Các kiểm tra tương tác ngày giờ, sửa ô, chuyển kết nối và luồng backup có thể qua unit test nhưng không được chặn bởi renderer smoke trên CI.
- Hướng sửa: chạy renderer dưới Xvfb ở job Linux, truyền cờ phù hợp với runner; bổ sung smoke trên Windows cho đường dẫn/quyền và đóng gói khi có điều kiện.

## Bản gốc — Đánh giá design pattern

| Thành phần | Đánh giá | Hướng cải thiện |
| --- | --- | --- |
| Main / preload / renderer | Phân lớp rõ; preload chỉ công bố API có tên, tắt Node ở renderer | Chuẩn hóa kiểm tra payload và sender cho tất cả IPC; main đóng vai trò lắp ghép các service |
| Store | Có repository, ghi tệp tạm rồi rename và tách secret khỏi dữ liệu UI | Xử lý lỗi đọc rõ ràng; inject filesystem/key provider để kiểm thử sự cố lưu trữ |
| DatabaseSession | Hợp lý cho vòng đời MySQL/SSH và hủy tác vụ | Tách MetadataService, RowService, TransferService, BackupService; vẫn giữ session làm facade |
| Parser / RowValues | Logic thuần, độc lập DOM và có test | Dùng codec kiểu cột chung ở mọi luồng ghi/xuất; tránh bộ quy tắc import riêng |
| Renderer | Có editor dùng chung và tách một phần logic thuần | Tách controller theo data grid, query editor, connection, transfer, account; truyền context đích đã chụp thay vì đọc biến toàn cục sau await |
| Server | Application factory, route modules, lỗi có cấu trúc và DI đã hợp lý | Khi thêm nghiệp vụ tài khoản, tách service khỏi HTTP; không cần thêm lớp cho từng hàm đơn giản |
| Website | Module khởi tạo độc lập, logic thuần và template dùng chung Việt/Anh | Giữ cách tổ chức hiện tại; chưa thấy nhu cầu chuyển sang framework |
| Đồng bộ | Có một nơi điều phối trạng thái/retry, module mã hóa riêng | Dần đưa state/dependencies vào instance để kiểm thử offline, logout và retry chồng nhau dễ hơn |

## Bản gốc — Tính năng nên bổ sung

Ưu tiên sau các lỗi dữ liệu ở trên; đây là đề xuất mở rộng, không phải tất cả đều là lỗi hiện tại.

1. **Lưu nháp thay đổi, xem trước SQL và Commit/Rollback cho data grid.** Hiện sửa ô/form ghi ngay. Thêm phát hiện xung đột bằng giá trị gốc/version: `updateRow` hiện chỉ ràng buộc khóa chính, nên có thể ghi đè thay đổi của người khác ở cùng trường. Cần xác định hành vi khi mất kết nối và với bảng không hỗ trợ transaction.
2. **Chế độ chỉ đọc và bảo vệ môi trường production theo connection.** Khóa thao tác ghi ở main/service, không chỉ ẩn nút UI; màu môi trường và xác nhận nêu rõ kết nối/database đích. Hiện có xác nhận SQL nguy hiểm nhưng chưa thấy chính sách connection chỉ đọc.
3. **Bộ lọc nhiều điều kiện, sắp xếp nhiều cột và xem bản ghi liên quan theo FK.** Backend export có hỗ trợ filter/order riêng; lưới chính vẫn thiên về một ô tìm kiếm và một cột sort. Tái sử dụng mô hình query/filter chung.
4. **So sánh schema và sinh migration SQL để xem trước.** Hữu ích khi làm việc giữa dev/staging/production; bắt đầu với bảng/cột/index/FK, không tự chạy thay đổi ngay.
5. **Backup theo lịch, chính sách giữ bản và kiểm tra phục hồi.** Hoàn thiện snapshot trước; lưu trạng thái tác vụ và kết quả restore thử. Không gọi tính năng này chỉ bằng cách thêm timer trong renderer.
6. **Khôi phục tài khoản với recovery key và quản lý phiên đăng nhập.** README đã ghi rõ chưa có quên/đổi mật khẩu hay email. Vì có vault mã hóa đầu cuối, đổi mật khẩu cần thiết kế lại dẫn xuất khóa/tái mã hóa; reset password đơn thuần không khôi phục được vault.
7. **Xuất toàn bộ kết quả truy vấn, kiểm tra cập nhật và đường nâng cấp ứng dụng.** Hiện xuất SQL result theo các dòng đang giữ trong renderer; chưa thấy luồng auto-update trong mã ứng dụng. Tách phát hiện bản mới, tải và cài đặt với xử lý chữ ký/phục hồi phù hợp.

Không ưu tiên thêm PostgreSQL/SQL Server ngay: trước hết cần ổn định tính đúng đắn của MySQL/MariaDB và tách ranh giới driver/service.

## Bản gốc — Kiểm chứng

- `npm run check`: đạt, 151 test; template website khớp source.
- `npm run test:renderer`: đạt, 30/30.
- `npm run test:website`: đạt, 14/14.
- `npm --prefix server run check`: đạt.
- `npm run server:test`: đạt, 13/13.
- Probe độc lập trong bộ nhớ: lỗi store và ghi đè, mất số JSON, khác biệt validation import/editor, tham số khóa nhị phân khi xóa.
- Không kết nối database thật, không ghi dữ liệu người dùng, không kiểm tra dịch vụ đang triển khai hay quét toàn bộ lịch sử Git. Các test database hiện dùng mock nên không thay thế kiểm tra tích hợp MySQL/MariaDB về kiểu dữ liệu, transaction và snapshot.

## Bản gốc — Thứ tự triển khai

1. F1/F2 và kiểm thử hồi quy để bảo vệ cấu hình, dữ liệu số.
2. Hợp nhất codec cho import/update/delete/export; xử lý F4/F5/F6.
3. Snapshot backup và test tích hợp MySQL/MariaDB, chạy renderer smoke trong CI.
4. Tách module dần theo phần đang sửa, giữ API IPC ổn định.
5. Thêm phát hiện xung đột, thay đổi chờ lưu/transaction và chế độ production chỉ đọc; sau đó mới mở rộng schema diff, lịch backup và tài khoản.

</details>
