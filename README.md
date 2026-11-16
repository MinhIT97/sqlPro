# SqlPro Desktop

SqlPro là ứng dụng desktop Electron quản trị MySQL/MariaDB trên Windows và Ubuntu. Giao diện chạy trong cửa sổ native, không cần web server. Truy vấn, metadata và chỉnh sửa dữ liệu đều chạy thật trên database.

## Chức năng

- Kết nối MySQL/MariaDB qua TCP, SSL/TLS và SSH tunnel.
- Workspace cá nhân để nhóm kết nối theo dự án hoặc môi trường.
- Nhãn môi trường Local/Staging/Production trên kết nối và tab SQL; kết nối cũ mặc định “Chưa phân loại”. Nhãn không thay đổi quyền database.
- Chế độ **Chỉ đọc** trong cấu hình kết nối: main chặn ghi dòng, import, restore, commit và SQL thay đổi dữ liệu/máy chủ; kiểm tra toàn bộ batch trước khi chạy. Vẫn xem/lọc/xuất dữ liệu và tạo backup được. Profile cũ giữ quyền thao tác hiện tại; bật/tắt chỉ đọc không thay quyền của tài khoản MySQL/MariaDB.
- Thanh trạng thái transaction theo phiên, Commit/Rollback có xác nhận và kiểm tra phiên/transaction chưa thay đổi. Các tab cùng kết nối dùng chung phiên; DDL có thể tự commit. Thời gian hiển thị là lúc ứng dụng quan sát transaction, không phải thời điểm bắt đầu chính xác phía server.
- Tài khoản đồng bộ tùy chọn: đẩy connection/workspace lên server và kéo về máy khác, có mã hóa đầu cuối.
- Duyệt database, bảng, view; xem dữ liệu, cấu trúc, index và khóa ngoại.
- Chạy nhiều câu SQL phân cách bằng `;` theo thứ tự; vùng kết quả có tab **Message**, **Summary**, **Result 1**, **Result 2**… để xem từng lưới dữ liệu; hủy truy vấn, timeout, lịch sử truy vấn.
- SQL Editor gợi ý từ khóa, hàm, bảng/view và cột theo đích tab (tab chưa gắn dùng kết nối hiện tại); hỗ trợ alias bảng.
- EXPLAIN có phần **Đọc kế hoạch**: giải thích ALL/index/filesort/temporary và rows/filtered ước lượng theo từng dòng kế hoạch; không tự khuyên thêm index hoặc kết luận truy vấn nhanh/chậm.
- Chọn **Plan: Mặc định/JSON/TREE** khi bấm EXPLAIN; xem JSON thụt lề hoặc TREE nguyên văn trong vùng riêng. Định dạng không được server hỗ trợ sẽ báo lỗi, không tự chạy lại.
- So sánh hai kết quả EXPLAIN liên tiếp trong từng tab: báo nội dung giống/khác và tóm tắt bước trước–sau, gắn đúng SQL/database/phiên. Mốc chỉ giữ trong bộ nhớ.
- Nút **ANALYZE…** riêng cho SELECT/CTE, luôn xác nhận vì thực thi truy vấn; xem thống kê server và xuất kết quả đã nhận mà không chạy lại.
- Nhiều tab SQL Editor; mỗi tab giữ nội dung riêng khi chuyển qua lại.
- Thêm, sửa, xóa bản ghi có khóa chính; tìm kiếm và phân trang.
- Lọc theo cột với chế độ chứa/bằng; lấy trang trước, đếm tổng theo yêu cầu. Phân trang PK dùng keyset khi có cursor phù hợp, có thứ tự ổn định cho khóa ghép; sort khác dùng OFFSET với PK làm tie-breaker. Cache COUNT giữ tối đa 15 giây và bị xóa khi phiên ghi dữ liệu.
- Editor theo kiểu cột cho hộp thoại thêm/sửa dòng và sửa trực tiếp trong bảng/kết quả SQL: lịch DATE/DATETIME/TIMESTAMP, chọn TIME, số/YEAR, ENUM/SET, JSON và hex nhị phân. NULL/DEFAULT được chọn riêng; giữ số lớn, giây lẻ và giờ theo phiên database. Dữ liệu nhị phân chỉ có bản xem trước, cột generated và dữ liệu không gian được giữ ở chế độ chỉ đọc khi không thể sửa đầy đủ từ lưới.
- Nhập CSV/TSV/JSON và xuất CSV/TSV/JSON theo luồng, có xem trước, ánh xạ cột và hủy giữa chừng.
- Sao lưu database ra tệp `.sql` (cấu trúc bảng/view, trigger, procedure, function, event và dữ liệu) và phục hồi từ tệp `.sql`.
- Lưu mật khẩu bằng Electron `safeStorage` (OS keychain); nếu không khả dụng thì mã hóa AES-256-GCM với khóa cục bộ quyền `0600`.
- Renderer không bao giờ nhận mật khẩu đã lưu; mọi truy cập database nằm trong main process.

SQL result giữ tối đa 5.000 dòng và 8 MiB JSON của dữ liệu dòng cho mỗi kết quả; toàn batch tối đa 10.000 dòng/16 MiB. Khi vượt giới hạn, SqlPro thử dùng kết nối điều khiển cùng tài khoản để gửi `KILL QUERY`, giữ phiên và transaction gốc. Nếu không mở được kết nối điều khiển, ứng dụng đọc bỏ phần dư trong giới hạn timeout và thông báo đúng trạng thái. Một dòng vượt ngân sách có thể không được đưa vào lưới; vẫn xuất đầy đủ qua luồng tệp. Giới hạn này không giới hạn kích thước tổng tệp export hay khẳng định giới hạn toàn bộ heap của driver.

Registry giữ tối đa 8 phiên, gộp các yêu cầu mở cùng profile và chỉ loại phiên rảnh khỏi cache. Phiên có tác vụ/lease, transaction hoặc autocommit tắt được bảo vệ; khi hết chỗ ứng dụng báo bận thay vì ngắt tác vụ nền. Server đồng bộ chạy scrypt bất đồng bộ với tối đa 2 hash đang xử lý và 32 yêu cầu chờ; khi đầy trả HTTP 503 `AUTH_BUSY` và `Retry-After`.

SQL Editor, thao tác ghi dòng và đổi database giữ quyền sử dụng riêng trên phiên trong suốt quá trình chuẩn bị/chạy. Nếu một tab khác cùng kết nối đang chạy thao tác đó, yêu cầu mới báo `SESSION_BUSY`; hãy đợi hoàn tất rồi thử lại. Các kết nối khác vẫn có thể sử dụng.

Sửa/xóa dòng từ lưới đối chiếu giá trị gốc để phát hiện xung đột; text phân biệt hoa/thường/dấu/khoảng trắng, JSON được so sánh như document và BLOB preview dùng hash của toàn bộ byte. Khi thiếu dữ liệu gốc đầy đủ, thao tác báo lỗi và giữ nội dung nhập. Xóa trong phiên có transaction hoặc autocommit tắt dùng savepoint, không tự commit thay người dùng; cần Commit/Rollback theo luồng SQL của phiên.

Sửa ô trực tiếp giữ nội dung khi validation/lưu bị lỗi hoặc không xác nhận được dòng UPDATE. Sau lỗi, mất focus không tự gửi lại UPDATE; dùng Lưu/Enter hoặc Tab ra khỏi editor để thử lại tường minh, Esc để hủy. Các sự kiện blur do khóa điều khiển trong lúc đang lưu cũng không tạo lần ghi mới.

Xóa có đối chiếu dữ liệu gốc hiện chỉ hỗ trợ bảng InnoDB. Engine khác hoặc không đọc được engine bị chặn trước DELETE; danh sách snapshot phải có một mục cho mỗi dòng yêu cầu. Điều này không bảo đảm rollback tác động gián tiếp của trigger lên bảng không có transaction. SQL DELETE tự nhập vẫn theo hành vi của server.

### Gợi ý cột trong SQL Editor

Chọn gợi ý khi con trỏ ở giữa tên cột sẽ thay trọn tên, giữ alias và SQL xung quanh. Hỗ trợ tên ASCII không quote và tên backtick có dấu cách, Unicode hoặc backtick kép. Tên chưa đóng backtick chỉ được hoàn tất khi phần đuôi bên phải là chữ/số/`_`/`$` đến cuối tệp; đuôi mơ hồ hoặc escape phụ thuộc SQL mode sẽ đóng gợi ý. Có vùng chọn thì không mở gợi ý. Nội dung, con trỏ, tab hoặc đích thay đổi sẽ chặn chọn gợi ý cũ; Undo khôi phục cả nội dung và vị trí con trỏ.

Sau WHERE/ON/AND/OR/ORDER BY/GROUP BY, Editor gợi ý cột từ các bảng nhận diện trong câu hiện tại. Dùng Ctrl+Space để mở lại, ↑/↓ để chọn và Enter/Tab để chèn; Ctrl+Z hoàn tác phần vừa chèn. JOIN trực tiếp giữ từng alias, kể cả hai alias cùng một bảng. Tên bảng/cột khác hoa/thường không bị gộp; qualifier phải khớp chính xác alias hoặc tên bảng chưa đặt alias. Tên mơ hồ không tự chọn bảng đầu tiên. Gợi ý hỗ trợ soạn SQL, không xác nhận cú pháp hoặc quyền thực thi.

Metadata dùng profile/database đã gắn với tab, kể cả khi sidebar đang mở kết nối khác. Tab chưa gắn dùng đích hiện tại như khi chạy SQL; tab đã gắn mà thiếu database/profile không tự mượn đích sidebar. Có thể đọc bảng ghi rõ schema khi profile còn hợp lệ. Danh sách bảng sidebar chỉ được dùng khi đúng profile/database của tab; chưa lazy-load catalog riêng cho tab đang trỏ nơi khác. Đổi đích tab giữa lúc tải sẽ bỏ kết quả gợi ý cũ, không tự USE hoặc đổi kết nối sidebar.

Metadata cột chỉ tải khi cần và cache tạm theo tuple profile/database/bảng, giữ nguyên tên. Cache tối đa 64 mục theo LRU, hết hạn sau 60 giây kể từ lúc nhận kết quả (kiểm tra khi sử dụng); hit không kéo dài TTL. Chỉ giữ name/type bất biến, tối đa 1.024 cột, type 512 ký tự và 65.536 ký tự quy đổi mỗi mục; tổng ngân sách 262.144 ký tự gồm tên/type/key và phần tính theo cột. Đây là giới hạn dữ liệu cache, không phải giới hạn toàn heap/IPC của metadata reader.

Yêu cầu trùng được gộp, tối đa bốn lượt đọc đang chờ, kể cả lượt cũ sau khi xóa cache; không tạo hàng đợi hoặc tự retry. Metadata lỗi/sai/quá giới hạn không cache. Đổi/mở lại kết nối, chọn database, làm mới danh sách profile, disconnect/logout/reset và invalidation sau SQL thay đổi cấu trúc bỏ cache/mốc gợi ý; kết quả muộn bị bỏ. Không hủy truy vấn metadata đang chạy chỉ để xóa cache. DDL bên ngoài có thể chưa phản ánh trong thời gian TTL; mở lại database để đọc mới. Không tải tất cả cột khi mở DB.

Gợi ý cột dùng khối SELECT chứa con trỏ: câu ngoài không lấy bảng của subquery, subquery không lấy bảng của câu ngoài hoặc nhánh bên cạnh. Biểu thức ngoặc thường vẫn dùng khối SELECT bao quanh. Các nhánh UNION/INTERSECT/EXCEPT tách riêng; ORDER/LIMIT chung của phép tập hợp chưa suy nguồn cột. INSERT…SELECT cơ bản tách phần bảng đích và SELECT nguồn theo vị trí con trỏ. Chọn nhánh cho gợi ý không xác nhận server hỗ trợ phép toán hoặc cú pháp đó.

CTE có danh sách cột tường minh, ví dụ `WITH recent(id,total) AS (...)`, gợi ý các tên đã khai báo cho `recent` hoặc alias của nó. Nhãn **CTE · cột khai báo** phân biệt với metadata bảng thật; không đọc database hoặc cache cột để lấy danh sách này. Hỗ trợ backtick/Unicode, CTE đệ quy và khai báo kế thừa trong scope lồng nhau. Khai báo gần nhất che tên bên ngoài, kể cả khi chưa biết cột. Tối đa 256 tên mỗi danh sách, 64 ký tự UTF-16 mỗi tên; danh sách sai/quá quota/trùng tên kể cả khác hoa thường giữ opaque, không trả một phần.

CTE không có danh sách cột tường minh và derived table có thể lấy tên đầu ra từ SELECT đã đóng ngoặc: cột trực tiếp như `id`, `t.id`, hoặc alias `AS` như `COUNT(*) AS total`. Hỗ trợ ALL/DISTINCT, tên backtick và Unicode. Chỉ nhận khi toàn danh sách xác định được tên, tối đa 256 tên/64 ký tự UTF-16 mỗi tên, không trùng kể cả khác hoa thường. Gợi ý có nhãn **CTE/Derived · tên từ SELECT**; không chạy thân SELECT, đọc metadata bảng thật cùng tên hoặc suy kiểu dữ liệu. Khai báo cột CTE tường minh luôn có ưu tiên, kể cả khi sai thì không fallback sang SELECT.

Alias không có AS cũng được nhận khi tách bằng khoảng trắng hoặc comment: cột trực tiếp (`id item_id`), lời gọi hàm đơn không ghi schema (`COUNT(*) total`), hoặc một biểu thức trong ngoặc (`(price*qty) amount`). Giữ tên backtick/Unicode; comment hoặc literal bên trong lời gọi hàm không trở thành tên cột. Toán tử/COLLATE/window suffix không được đoán là alias. Dạng dính liền (`COUNT(*)total`), literal ở ngoài ngoặc, biểu thức số học không bọc ngoặc và các alias ngầm ngoài phạm vi này chưa hỗ trợ.

CTE/derived chứa chuỗi UNION/INTERSECT/EXCEPT đơn giản cũng có tên đầu ra: dùng tên của SELECT đầu tiên, không dùng alias các nhánh sau. Hỗ trợ modifier ALL/DISTINCT và tối đa 16 nhánh; mỗi nhánh phải có danh sách tên đầy đủ theo grammar trên, không trùng và cùng số cột. Nhánh thiếu/sai/`*`/quá quota hoặc ngoặc bọc riêng từng nhánh giữ toàn nguồn opaque. Chưa suy tương thích kiểu, dữ liệu, thứ tự ưu tiên hoặc capability của server; không chạy truy vấn để kiểm tra. ORDER/LIMIT chung ngay trong phép tập hợp vẫn chưa gợi ý nguồn cột.

Nguồn có `*`/`t.*`, biểu thức thiếu alias hoặc chưa nhận diện, cú pháp chưa hỗ trợ hoặc SELECT chưa đóng giữ opaque, không trả một phần hay mượn tên của scope ngoài. Trong thân SELECT vẫn gợi ý các bảng vật lý nhận diện được. JOIN chỉ gợi ý nguồn có tên cột rõ và alias không mơ hồ. Tên đầu ra là hỗ trợ soạn thảo, chưa kiểm kiểu/tồn tại cột hoặc tính hợp lệ của biểu thức; không phân tích/thực thi biểu thức. Khai báo CTE tường minh chỉ cung cấp tên đã viết, chưa xác minh số cột so với thân SELECT. Chưa mở rộng `*`, correlated outer reference hoặc LATERAL. Schema ghi rõ vẫn là bảng vật lý; chưa phân giải đầy đủ scope SQL.

Bước nhận diện scope tối đa 65.536 ký tự, 4.096 token, 32 mức ngoặc, 128 nhóm tính cả gốc và 64 nguồn. Tên Unicode dùng backtick trong bộ nhận diện hiện tại. Cú pháp/nguồn chưa hỗ trợ, tên nhiều hơn hai phần, hint/executable comment, backslash phụ thuộc SQL mode hoặc quá quota giữ scope unknown, không tự mượn bảng từ sidebar. Từ khóa/chỉnh sửa SQL vẫn dùng được; không tự chạy SQL gốc, USE, probe hoặc fallback truy vấn. G5.3 còn mở rộng star/alias ngầm ngoài grammar/set output ngoài grammar/correlation, dialect/SQL-mode và nghiệm thu parser đầy đủ; kiểm tra SQL trước khi chạy.

### Đọc kế hoạch EXPLAIN

Bấm **EXPLAIN** trên câu SQL đang đặt con trỏ hoặc đoạn đang chọn, rồi mở **Đọc kế hoạch EXPLAIN** bằng click/Enter. Phần này giải thích kết quả dạng bảng truyền thống; giữ nguyên bảng kết quả gốc và không gửi thêm truy vấn. `rows`/`filtered` là ước lượng, không cộng các dòng JOIN thành tổng dòng thực tế. Thời gian nhận EXPLAIN không phải thời gian chạy truy vấn gốc.

ALL có thể phù hợp với bảng nhỏ hoặc khi cần phần lớn dữ liệu. Filesort có thể chạy trong RAM; temporary chưa xác định RAM/đĩa. Có index cũng chưa bảo đảm nhanh. Đánh giá cùng workload, điều kiện lọc và thống kê trước khi thay đổi index. Tham khảo [MySQL EXPLAIN](https://dev.mysql.com/doc/refman/8.4/en/explain-output.html), [ORDER BY](https://dev.mysql.com/doc/refman/8.4/en/order-by-optimization.html) và [MariaDB EXPLAIN](https://mariadb.com/docs/server/reference/sql-statements/administrative-sql-statements/analyze-and-explain-statements/explain).

Giải thích dạng bảng đọc tối đa 200 dòng, hiện tối đa 50; thiếu/sai số liệu là “Chưa xác định”, phần bị cắt có thông báo. DESCRIBE cấu trúc bảng và dạng chưa nhận diện giữ kết quả gốc, chưa có phần diễn giải này.

Lựa chọn **Plan: Mặc định/JSON/TREE** giữ theo tab trong phiên ứng dụng; Mặc định giữ định dạng server. Khi SQL đã có EXPLAIN/DESC/DESCRIBE, ứng dụng giữ SQL đó và bỏ qua lựa chọn định dạng. JSON/TREE gửi đúng một yêu cầu, không probe hoặc fallback; MySQL/MariaDB có khác biệt hỗ trợ và schema JSON. Nút EXPLAIN từ chối ANALYZE, executable comment và optimizer hint; muốn đo thực thi SELECT hãy dùng nút **ANALYZE…** riêng.

Kết quả một cột EXPLAIN có **Xem plan** hỗ trợ bàn phím, hiển thị nội dung vượt phần xem trước của ô. JSON chỉ thụt lề token, giữ chính xác số lớn/thập phân/khóa trùng; không chuẩn hóa schema plan hay giải thích JSON/TREE như bảng truyền thống. Đọc tối đa 262.144 ký tự UTF-16, sâu 64 mức, 10.000 token và 524.288 ký tự sau thụt lề. Quá giới hạn hoặc JSON sai giữ văn bản có thông báo; xuất kết quả để đọc đầy đủ khi kết quả nhận chưa bị cắt. Plan có thể chứa điều kiện/giá trị truy vấn; nội dung không được lưu thêm vào workspace hoặc log.

**So sánh hai lần EXPLAIN** tự tạo mốc ở lần đầu và so với lần thành công liền trước trong tab. Main gắn phiên thực tế, database, hash SQL chính xác và task cho từng kết quả; đổi SQL (kể cả literal/comment), database, profile, phiên/reconnect hoặc định dạng tạo mốc mới. SQL Editor hiện gửi SQL trực tiếp, chưa có ngữ cảnh bind parameter riêng cho so sánh. Thiếu context, dữ liệu quá giới hạn, lỗi/hủy hoặc chạy SQL thường xóa mốc; đóng tab hoặc đăng xuất/reset cũng bỏ mốc. Mặc định không gửi truy vấn thêm; mốc không lưu ra đĩa.

So sánh chỉ xét nội dung kết quả đã nhận, giữ thứ tự cột/dòng và toàn giá trị trong ngân sách 200 dòng/64 cột/262.144 ký tự biểu diễn. Phần tóm tắt hiện tối đa 50 bước khác biệt theo vị trí, gồm bảng/truy cập/index/rows/filtered/Extra (tối đa 4.096 ký tự). JSON/TREE có văn bản trước–sau; khác khoảng trắng cũng có thể báo thay đổi. Nội dung giống nhau không chứng minh schema, thống kê, thiết lập phiên hoặc dữ liệu không đổi; nội dung đổi không chứng minh truy vấn nhanh/chậm hơn. Chưa có snapshot đầy đủ schema, toàn bộ thiết lập hoặc đối chiếu ngữ nghĩa các bước JOIN/JSON giữa engine.

Bật **Kèm thiết lập phiên** nếu cần kiểm tra thêm ngữ cảnh EXPLAIN SELECT. Tùy chọn mặc định tắt, chỉ giữ theo tab trong bộ nhớ; đổi tùy chọn bỏ mốc cũ. Khi bật, ứng dụng đọc tối đa hai SELECT metadata trước/sau EXPLAIN trên cùng phiên: phiên bản server/database, sql_mode, optimizer_switch, time_zone, ba character_set của client/connection/results, collation_connection, autocommit và sql_select_limit. Mỗi SELECT tối đa 2 giây/1 dòng/32 KiB, dùng chung hạn chờ của lượt chạy; LIMIT 1 vẫn đọc được khi sql_select_limit=0. Chỉ giữ hash từng giá trị, không lưu thêm hoặc hiển thị giá trị gốc.

Nếu các giá trị khớp ở hai lần đọc, thông tin được gắn vào mốc so sánh. Khác thiết lập giữa hai mốc thì hiển thị tên thuộc tính đổi, bỏ so nội dung plan và dùng mốc mới cho lần kế tiếp. Thay đổi ngay trong lượt chạy, thiếu/sai/quá quota/binary hoặc lỗi metadata giữ trạng thái chưa đủ thông tin và bỏ mốc; EXPLAIN đã hoàn tất vẫn được giữ. Không tự retry, SET, Commit/Rollback hoặc chạy ANALYZE. Hủy/timeout trong reader đóng phiên như truy vấn thường; transaction chưa commit có thể rollback khi mất kết nối. Hai quan sát giống nhau không chứng minh thiết lập không đổi giữa chừng, cũng chưa bao phủ schema/statistics/data, mọi thiết lập riêng của engine hoặc bind context. Tham khảo biến phiên [MySQL](https://dev.mysql.com/doc/refman/8.4/en/server-system-variables.html), [MariaDB](https://mariadb.com/docs/server/server-management/variables-and-modes/server-system-variables).

Bật **Kèm định nghĩa bảng** để quan sát thêm văn bản `SHOW CREATE TABLE` trước/sau một EXPLAIN SELECT trên một bảng trực tiếp. Mặc định tắt, chỉ giữ theo tab trong bộ nhớ; bật/tắt tạo scope mới. Nhận diện tên bảng/schema từ chính SQL, quote identifier và giữ nguyên hoa/thường. JOIN/CTE/subquery/view, nguồn chưa hỗ trợ, thiếu quyền, kết quả binary/sai/quá giới hạn giữ trạng thái chưa đủ thông tin; không suy đã kiểm tra mọi bảng. Không có tùy chọn nào bật thì không đọc thêm metadata.

Mỗi SHOW tối đa 2 giây/1 dòng/512 KiB, DDL hợp lệ tối đa 262.144 byte UTF-8 và ký tự UTF-16; chỉ giữ hash tạm, không đưa DDL/default/comment vào mốc hoặc log. Hai tùy chọn ngữ cảnh dùng chung task/lease/hạn chờ với đúng một EXPLAIN; bật cả hai thêm tối đa bốn lần đọc metadata. Đổi văn bản giữa hai mốc báo riêng và bỏ so plan; đổi ngay trong lượt chạy hoặc thiếu bằng chứng bỏ mốc, giữ plan đã hoàn tất. Không tự SET, Commit/Rollback, ALTER hoặc retry. Hủy/timeout có thể đóng phiên và rollback transaction chưa commit như truy vấn thường.

Đây chỉ là văn bản server trả về, chưa phải snapshot nguyên tử/toàn schema hoặc chứng nhận cấu trúc tương đương. SQL mode có thể ẩn thuộc tính; AUTO_INCREMENT và định dạng có thể làm văn bản đổi. Chưa quan sát dependency, trigger/routine, statistics/data hoặc bind context; hai lần đọc khớp không chứng minh không đổi giữa chừng. Xem giới hạn SHOW CREATE TABLE của [MySQL](https://dev.mysql.com/doc/refman/8.4/en/show-create-table.html) và [MariaDB](https://mariadb.com/docs/server/reference/sql-statements/administrative-sql-statements/show/show-create-table).

**ANALYZE…** lấy câu SELECT/CTE tại con trỏ hoặc đoạn đang chọn, tối đa 65.536 ký tự. Main kiểm tra SQL, từ chối chế độ chỉ đọc, transaction đang mở/autocommit tắt, lệnh ghi/locking read/hàm chưa biết và executable comment/hint. Luôn có xác nhận native với mặc định **Hủy**, tên kết nối/môi trường/host/database/server, SQL đã che giá trị và giới hạn chờ tối đa 60 giây. Giữ phiên độc quyền trong lúc xác nhận và chạy; đổi phiên/cấu hình/tài khoản hoặc xác nhận quá 2 phút yêu cầu làm lại. Không tự Commit/Rollback hoặc SET để mở đường chạy; trước thực thi có một SELECT kiểm tra autocommit thực tế, có hủy và giới hạn nhận.

Theo version chuẩn của server, ứng dụng dựng `EXPLAIN ANALYZE FORMAT=TREE SELECT…` cho MySQL 8.0.18+/8.x hoặc `ANALYZE FORMAT=JSON SELECT…` cho MariaDB 10.1+/11.x. Version ngoài mẫu bị từ chối; lỗi quyền/capability của server được giữ nguyên, không probe/fallback/retry. Hai cú pháp này thực thi truy vấn và trả thống kê thực tế: [MySQL ANALYZE](https://dev.mysql.com/doc/refman/8.4/en/explain.html), [MariaDB ANALYZE JSON](https://mariadb.com/docs/server/reference/sql-statements/administrative-sql-statements/analyze-and-explain-statements/analyze-format-json). SELECT trên view có thể gọi mã phía server; bộ lọc SQL không thay thế tài khoản có quyền tối thiểu. Hủy/timeout trong đường đọc đóng phiên, không bảo đảm server dừng ngay lập tức và không chứng minh tác động gián tiếp đã rollback.

Kết quả ANALYZE là chỉ đọc, có nhãn đã thực thi và viewer JSON/TREE gốc; không cộng số dòng/thời gian các bước hoặc dùng làm mốc so sánh EXPLAIN. Thời gian ứng dụng nhận kết quả không thay thế thống kê server. Nhận tối đa 100 dòng/1 MiB và dùng quota viewer nêu trên. Xuất CSV/JSON chỉ ghi dữ liệu đã nhận, không chạy ANALYZE lại; kết quả nhận bị cắt phải báo thiếu. Đường xuất toàn bộ bằng cách chạy lại SQL cũng chặn ANALYZE nhập thủ công. Không thêm plan vào lịch sử/workspace/log.

### Giới hạn của chế độ chỉ đọc

Đây là lớp bảo vệ thao tác trong SqlPro, không phải sandbox SQL hay thay thế phân quyền phía server. Nên dùng tài khoản database có quyền tối thiểu và kiểm tra quyền/DEFINER của view, routine và UDF, vì câu SELECT có thể gọi mã phía server một cách gián tiếp.

Chế độ này cho phép SELECT thông thường, CTE SELECT cơ bản, một số hàm dựng sẵn, SHOW/DESCRIBE, EXPLAIN SELECT, USE và ROLLBACK. Câu ghi, locking read, INTO OUTFILE/DUMPFILE, executable comment, EXPLAIN ANALYZE, hàm tùy biến hoặc cú pháp chưa nhận diện sẽ bị từ chối trước khi chạy batch. Chuỗi có backslash bị từ chối để tránh đoán sai SQL mode; có thể dùng dấu nháy đơn lặp đôi khi phù hợp. Kết nối không bật chỉ đọc giữ hành vi SQL hiện có.

Không thể sửa cấu hình kết nối khi có transaction, autocommit OFF hoặc tác vụ đang chạy. Kết thúc transaction và bật lại autocommit trước khi lưu; ứng dụng không tự rollback để đổi cấu hình.

Nếu đồng bộ thay đổi đích/thông tin đăng nhập của profile đang mở, phiên cũ được giữ và yêu cầu chạy tiếp/Commit bị chặn (`PROFILE_TARGET_CHANGED`). Có thể dùng nút Rollback cho transaction đã quan sát trên phiên cũ, kể cả khi profile đã bị đồng bộ xóa; sau đó chủ động ngắt và kết nối lại để dùng cấu hình mới. Ứng dụng không tự Commit hoặc chuyển transaction sang máy chủ mới.

### Xác nhận thao tác trên Production

Trong chi tiết backup có **Phục hồi thử vào database tạm**. Bản đầu hỗ trợ bảng InnoDB thông thường và INSERT literal trong tệp tối đa 512 MiB; cần quyền tạo/xóa database trên kết nối được chọn và dung lượng trống. Ứng dụng tạo schema `sqlpro_trial_*`, kiểm tra số dòng/khóa ngoại rồi đối chiếu marker trước khi xóa. Nếu dọn thất bại, báo cáo ghi tên schema cần kiểm tra thủ công. Báo cáo gắn checksum tệp và lưu cạnh backup ở `.trial.json`; kết quả không xác nhận hash toàn bộ dữ liệu. View/trigger/routine/event, schema ghi rõ không khớp và một số biểu thức SQL chưa được hỗ trợ. Chưa có quota dung lượng phía server; phần xử lý chính được yêu cầu hủy sau 10 phút (hủy hợp tác), mỗi lệnh kiểm tra marker/xóa có timeout 15 giây. Nên thử trên máy chủ kiểm thử riêng trước.

Mục **Database thử còn sót…** trong Backups đọc nhật ký mã hóa cục bộ để kiểm tra các lần thử bị gián đoạn. Dọn yêu cầu xác nhận đúng máy chủ và marker sở hữu; thiếu/sai marker thì giữ database để kiểm tra thủ công. Tính năng chỉ nhận diện các lần thử tạo sau khi có nhật ký và còn dữ liệu local; không tự xóa schema theo tên/prefix.


Nút **Hủy phục hồi thử** dừng sao chép/đọc tệp hoặc gửi yêu cầu hủy tới scanner/restore, sau đó kiểm tra cleanup. Sau 10 phút phần xử lý chính tự yêu cầu hủy; việc dừng phụ thuộc ranh giới tác vụ/server, và cleanup chưa có deadline riêng. Nếu kết nối bị đóng do hủy restore, có thể cần dọn schema tạm thủ công theo báo cáo.

Các lệnh kiểm tra marker và xóa schema tạm có timeout driver 15 giây mỗi lệnh. Khi hết thời gian, báo cáo ghi trạng thái cần dọn thủ công; ứng dụng không tự xóa schema nếu không xác nhận được ownership.

Đọc nội dung backup hỗ trợ nút Hủy quét, chỉ một lượt quét cùng lúc và cache hiển thị 5 phút (tối đa 4 bản). Tệp thay đổi sẽ phải quét lại; cache không được dùng để bỏ qua preflight/checksum khi restore. Quét quá 5 phút được yêu cầu hủy; dữ liệu hiển thị có giới hạn và báo khi danh sách bị cắt.

Tiến độ quét hiển thị byte đã đọc và số câu SQL; đọc 100% vẫn có thể đang phân tích/kiểm tra tệp. Các lượt xem cùng backup dùng chung một lần quét; hủy từ một lượt xem sẽ dừng tác vụ chung. Tiến độ chỉ được hỏi khi vùng chi tiết đang hiển thị.

Kết nối được gắn nhãn Production yêu cầu xem trước và xác nhận khi thêm/sửa/xóa bản ghi hoặc chạy SQL mà ứng dụng không phân loại chắc chắn là đọc. Hộp thoại hiển thị kết nối, host, database ban đầu, bảng/cột khi xác định được, SQL với giá trị đã che và thông tin kiểu tham số. Không chạy COUNT hoặc EXPLAIN ANALYZE để dự đoán số dòng trước khi ghi; số dòng được chọn không bao gồm trigger/cascade.

Xác nhận do main cấp, hết hạn sau 2 phút, dùng một lần và gắn với bản chụp yêu cầu/phiên/transaction/cấu hình. Thao tác trên dòng kiểm tra lại metadata và plan trước khi ghi; dữ liệu bị thay đổi vẫn chịu kiểm tra xung đột hiện có. Nếu phiên kết nối lại, transaction thay đổi hoặc schema khác bản xem trước, cần xem trước lại. Hủy hộp thoại giữ nội dung đang sửa. Không tự retry một thao tác ghi đã được xác nhận.

SQL cần xác nhận nhưng có executable comment, optimizer hint, nháy kép hoặc chuỗi backslash sẽ bị từ chối xem trước để tránh đoán sai SQL mode/che mất câu lệnh thực thi; dùng backtick cho identifier và nháy đơn lặp đôi cho chuỗi, hoặc nhập giá trị bằng form bản ghi có tham số. SQL preview giới hạn 12.000 ký tự, danh sách tham số giới hạn 100 mục; phải kiểm tra toàn bộ SQL trong editor nếu bị cắt. Export SQL trên Production chỉ nhận câu được phân loại đọc, tránh lách xác nhận qua hàm tùy biến.

Commit trên Production cũng yêu cầu token một lần, gắn đúng session/revision và thông báo áp dụng cho mọi tab dùng chung phiên. Rollback giữ xác nhận riêng và vẫn dùng được trong chế độ chỉ đọc.

Import/restore trên Production có xác nhận native do main mở sau khi xác định tệp nguồn và đích, trước khi tạo worker. Hộp thoại hiển thị tệp/dung lượng, database/bảng đích và lựa chọn ảnh hưởng dữ liệu; mặc định là Hủy. Sau xác nhận, main kiểm tra lại cấu hình, nhận diện tệp và thời hạn 2 phút. Đây là kiểm tra danh tính tệp theo metadata, không thay thế checksum hoặc preflight; không giữ kết nối/stream trong lúc chờ người dùng. Tác vụ dùng phiên riêng và khi lỗi/hủy có thể để lại dữ liệu đã ghi.

Không bảo đảm schema hoặc tệp không bị thay đổi bởi tiến trình ngoài sau lần kiểm tra cuối, hay mọi DDL có thể rollback.

## Tương thích Navicat

Nhập được danh sách kết nối từ:

- `~/.config/navicat/Common/connections.json` (Navicat 16/17 trên Linux).
- Tệp xuất `.ncx`.

Các thông số được ánh xạ: host, port, username, password, database mặc định, SSL (CA/client cert/key, passphrase), SSH tunnel (password hoặc private key, passphrase). Mật khẩu Navicat v12+ được giải mã bằng AES-128-CBC trong main process. Kết nối đã nhập có thể dùng ngay mà không cần nhập lại mật khẩu.

Chọn **CONNECTIONS → ⇩** hoặc menu **Tệp → Nhập kết nối Navicat…**.

Hai script cũ không còn là luồng nhập mật khẩu: `import-navicat-passwords.py` chỉ trả số lượng profile/có lưu credential, không giải mã hay xuất host/user/password; `sync-navicat-passwords.cjs` đã khóa ghi trực tiếp và chỉ hướng dẫn mở menu nhập. Luồng nhập trong ứng dụng mã hóa secret qua store repository và yêu cầu xác nhận SSH host key khi kết nối. Tệp `.ncx`/JSON và bản sao lưu có thể chứa credential, cần giữ ngoài repository và không đưa vào log/CI. Nếu từng chạy bản script cũ và lưu/chia sẻ output, kiểm tra nơi đã nhận output và đổi credential thực tế bị lộ; `.gitignore` không xóa lịch sử hoặc log cũ.

### Giới hạn tương thích

- Chỉ MySQL và MariaDB; PostgreSQL/SQL Server trong Navicat sẽ bị bỏ qua.
- Không hỗ trợ mật khẩu Navicat v11 (Blowfish) và Navicat Cloud/HTTP tunnel.
- Đường dẫn SSH private key, CA cert và client cert phải tồn tại trên máy đang chạy SqlPro.
- Kết nối mới mặc định chọn xác thực chứng chỉ khi bật TLS. Profile cũ/nhập từ Navicat giữ cấu hình đã có; kết nối TLS không xác thực được hiển thị cảnh báo và có thể nâng cấp trong biểu mẫu kết nối.

## Tài khoản, workspace và đồng bộ

Tài khoản là **tùy chọn**. Không đăng nhập, SqlPro hoạt động đầy đủ như ứng dụng offline. Đăng nhập chỉ bật đồng bộ connection và workspace giữa các máy.

- Tạo workspace bằng nút **＋** cạnh bộ chọn workspace; đổi tên hoặc xóa bằng nút **⚙**. Workspace mặc định **Cá nhân** không thể xóa hoặc đổi tên. Khi xóa workspace, các connection bên trong được chuyển về **Cá nhân**.
- Mở **Tài khoản & đồng bộ** từ avatar ở góc phải header hoặc nút cuối thanh rail.
- Nhập server đồng bộ, email và mật khẩu. Mật khẩu tối thiểu 10 ký tự. Có thể chọn **Ghi nhớ đăng nhập**; nếu không, token chỉ nằm trong bộ nhớ cho tới khi thoát ứng dụng.
- Sau khi đăng nhập, thay đổi connection/workspace được tự động đẩy lên sau khoảng 2 giây. Khi offline, SqlPro giữ thay đổi và thử lại sau 1, 5 rồi 15 phút.
- Đăng xuất không xóa dữ liệu local. Đăng nhập tài khoản khác trên cùng dữ liệu local sẽ bị chặn để tránh rò dữ liệu giữa hai tài khoản. Khi hộp thoại đăng nhập báo lỗi này, chọn **Sao lưu &amp; xóa dữ liệu local…**. SqlPro sao lưu store cũ thành `connections-backup-<thời-gian>.json` trong thư mục user data (ví dụ `~/.config/SqlPro/` trên Linux), tạo store mới rồi mở lại màn hình đăng nhập. Tệp backup giữ nguyên phần secret đã niêm phong và có thể khôi phục thủ công bằng cách thoát ứng dụng, đổi tên backup thành `connections.json` (giữ lại tệp hiện tại để có thể quay lại).

### Mô hình bảo mật

- Mật khẩu không được gửi lên server. Client dùng `scrypt` để dẫn xuất master key, rồi tách thành `authProof` (gửi server) và `vaultKey` (chỉ nằm trên máy).
- Vault connection được mã hóa **AES-256-GCM** trước khi gửi. Server chỉ thấy email, revision và ciphertext.
- Session token 32 byte; server chỉ lưu SHA-256 của token. Token và vault key không đi xuống renderer.
- Bắt buộc HTTPS khi server không phải localhost. Nếu dùng HTTP không an toàn, ứng dụng yêu cầu xác nhận rõ ràng.
- Khi server bị xâm nhập, kẻ tấn công vẫn có thể brute-force offline nếu mật khẩu yếu. Vì vậy độ dài tối thiểu là 10 ký tự.

### Khôi phục khóa mã hóa local

- Nếu gặp `LOCAL_KEY_MISSING`, `LOCAL_KEY_INVALID`, `LOCAL_KEY_READ_FAILED` hoặc `SECRET_DECRYPT_FAILED`, ứng dụng dừng thao tác dùng secret và giữ nguyên dữ liệu; không tự thay khóa hoặc biến mật khẩu thành chuỗi rỗng. Với lỗi quyền truy cập/I/O, khôi phục quyền truy cập rồi thử lại.
- Trước khi khôi phục thủ công, thoát ứng dụng và sao lưu thư mục user data. Với secret dùng AES local, cần giữ **cả** `connections.json` (hoặc bản backup) và `.connections-key` gốc; khôi phục đúng cặp từ cùng bản sao lưu. Không tạo khóa ngẫu nhiên để thay khóa bị mất. Secret dùng `safeStorage` cần truy cập được kho khóa của tài khoản hệ điều hành đã mã hóa nó; sao chép riêng JSON sang máy khác không đủ.
- Nếu không còn khóa gốc, ciphertext local không thể tự khôi phục. Có thể nhập lại thông tin kết nối hoặc lấy từ vault bằng mật khẩu tài khoản đồng bộ nếu đã có bản cloud. Để bắt đầu lại sau khi đã sao lưu, chọn **Sao lưu & xóa dữ liệu local…**, thoát ứng dụng rồi chuyển tệp `.connections-key` hỏng sang bản lưu riêng; lần lưu secret mới sẽ tạo khóa mới. Giữ các bản backup cũ để còn khả năng phục hồi nếu tìm lại được khóa gốc.
- Đăng xuất/reset vô hiệu hóa công việc đồng bộ đang chờ và hủy request mạng của phiên cũ. Phản hồi đến muộn không được ghi lại store, revision hoặc trạng thái phiên mới. Request đã được server xử lý trước khi hủy có thể đã cập nhật vault cloud của tài khoản cũ.
- Xử lý xung đột và đồng bộ thường dùng chung một lượt chạy; nếu đang đồng bộ, hãy đợi trước khi gửi lựa chọn xử lý xung đột. Phản hồi HTTP được giới hạn byte trong lúc đọc, kể cả khi không có Content-Length.

> **Quan trọng:** không có khóa khôi phục và chưa hỗ trợ quên mật khẩu. Nếu quên mật khẩu, dữ liệu đã đồng bộ trên server không thể giải mã. Dữ liệu local vẫn còn trên máy.

### Giới hạn đồng bộ

- Chưa hỗ trợ xác thực email, đổi email/mật khẩu, khôi phục mật khẩu hoặc chia sẻ workspace nhóm.
- Chỉ đồng bộ đường dẫn tới SSH private key, CA cert và client cert; không đồng bộ nội dung các tệp này.
- Tombstone xóa được giữ 180 ngày. Máy offline lâu hơn có thể làm sống lại bản ghi đã xóa.
- Server SQLite chạy một instance; chưa hỗ trợ scale ngang.
- Vault giới hạn 5 MiB. Tệp quá lớn sẽ báo lỗi thay vì cắt dữ liệu.

## Tự host server đồng bộ

Yêu cầu Docker và Docker Compose.

```bash
cp .env.example .env
docker compose up -d
```

Mở `http://localhost:8080` để xem website giới thiệu và `http://localhost:8080/healthz` để kiểm tra server. SQLite nằm trong volume `sqlpro-data` tại `/data/sqlpro.db`.

Cấu hình trong `.env`:

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | `8080` | Cổng public ánh xạ vào container |
| `ALLOW_REGISTRATION` | `true` | Cho phép tạo tài khoản mới |
| `SESSION_TTL_DAYS` | `30` | Số ngày session còn hiệu lực |
| `MAX_VAULT_BYTES` | `5242880` | Giới hạn ciphertext mỗi vault |
| `TRUST_PROXY` | `0` | Đặt `1` khi chạy sau Caddy/Nginx tin cậy |

Ảnh server cũng được publish lên GHCR:

```bash
docker pull ghcr.io/minhit97/sqlpro-server:latest
docker run -d --name sqlpro -p 8080:8080 \
  -v sqlpro-data:/data \
  -e ALLOW_REGISTRATION=true \
  ghcr.io/minhit97/sqlpro-server:latest
```

Khi đưa server ra Internet, hãy đặt sau reverse proxy có HTTPS hợp lệ (Caddy hoặc Nginx). Không mở trực tiếp HTTP công khai vì mật khẩu đăng nhập và token vẫn cần được bảo vệ trên đường truyền. Có thể tắt đăng ký công khai sau khi tạo tài khoản bằng `ALLOW_REGISTRATION=false`.

Chạy server trực tiếp khi phát triển:

```bash
npm run server:install
npm run server:start
# kiểm tra
npm run server:test
```

## Website giới thiệu

Website tĩnh nằm trong `website/`, được server Express phục vụ tại `/`, không cần bước build và không dùng CDN. Nội dung gồm tính năng, mô hình mã hóa, workspace, hướng dẫn tự host, FAQ và nút tải trực tiếp bộ cài từ GitHub Releases. Website đọc GitHub API để tìm đúng tệp `.deb`/`.exe` của bản mới nhất; khi chưa có Release, website hiển thị trạng thái chưa có bộ cài thay vì đưa người dùng tới một link tải lỗi.

Quy ước kiến trúc, design pattern và chuẩn code của dự án được ghi trong [`agent.md`](agent.md).

## Sao lưu và phục hồi

SqlPro giữ tối đa 8 phiên kết nối MySQL/SSH gần đây trong khi ứng dụng đang mở. Chuyển qua lại giữa các kết nối đã mở sẽ dùng lại phiên cũ và nhớ database/bảng gần nhất; phiên mất kết nối được mở lại khi cần. Ngắt kết nối, sửa hoặc xóa cấu hình sẽ đóng phiên tương ứng.

Chọn database trong thanh bên rồi bấm nhóm **Backups** để mở trang quản lý. Trang này liệt kê tên, ngày tạo và dung lượng; có nút **Tạo bản sao lưu**, **Phục hồi**, **Xóa bản sao lưu**, **Xuất tệp SQL** và **Làm mới**. Chọn một bản trong danh sách trước khi dùng các thao tác đó. SqlPro tự lưu tệp `.sql` vào thư mục dữ liệu ứng dụng (`backups/<kết nối>/<database>/`), đặt tên theo thời gian và hiển thị ngay dưới nhóm Backups. Menu **Tệp → Sao lưu database… / Phục hồi database…** vẫn khả dụng; phục hồi từ menu cho phép chọn tệp `.sql` bên ngoài.

Khi bắt đầu sao lưu hoặc phục hồi, tiến độ mở trong tab **Tác vụ database**. Tab hiển thị giai đoạn, đối tượng đang xử lý, phần trăm ước tính và nhật ký 200 mốc gần nhất; nhật ký vẫn được ghi khi bạn chuyển sang SQL Editor hoặc bảng khác. Tác vụ dùng kết nối riêng; bạn có thể quay lại tab để xem tiến độ, hủy hoặc đọc kết quả. Kết quả hoàn tất và lỗi không bật hộp thoại chặn công việc đang làm; tránh sửa dữ liệu ở database đích trong lúc phục hồi.

Khi sao chép bản backup giữa các kết nối, SqlPro ghi vào tệp tạm và chỉ hiển thị bản mới sau khi ghi hoàn tất. Trước khi phục hồi, SqlPro quét tệp SQL rồi kiểm tra lại đúng tệp sẽ đọc; nếu tệp bị thay thế hoặc thay đổi trong khoảng này, tác vụ dừng trước khi ghi vào database. Vì các câu DDL của MySQL có thể tự commit, hủy hoặc gặp lỗi giữa lúc phục hồi vẫn có thể để lại thay đổi đã áp dụng; hãy phục hồi vào database thử trước khi thay dữ liệu quan trọng.

Trong trang **Backups**, chọn một bản rồi bấm **Ghi chú / Ghim** để ghi chú nhiều dòng (tối đa 2.000 ký tự) hoặc ghim bản quan trọng. Dùng **Ctrl+Enter** để lưu. Bản ghim bị chặn xóa trong SqlPro; cần bỏ ghim trước khi xóa. Đổi tên không làm mất ghi chú/ghim, và sao chép sang database hoặc kết nối khác giữ cả ba thông tin. Ghi chú lưu cục bộ cạnh tệp SQL, không thay đổi checksum; xuất riêng SQL không bao gồm ghi chú. Ghim không ngăn thao tác xóa tệp từ bên ngoài ứng dụng.

Trong chi tiết backup, **Xem phạm vi chọn bảng…** quét SQL bằng worker, rồi cho chọn bảng và phần cấu trúc/dữ liệu để xem số lệnh CREATE, DROP và INSERT đã nhận diện. Bấm **Xem phạm vi** hoặc Ctrl+Enter. Công cụ hiển thị FK trong CREATE TABLE, bảng được tham chiếu chưa chọn/không có trong backup, tham chiếu ngoài database, vòng FK/bảng bị phụ thuộc vào vòng và thứ tự FK tham khảo. Tên bảng được giữ đúng hoa/thường và ký tự quote; tên khác nhau chỉ bởi hoa/thường có cảnh báo. Chưa chọn bảng nào mặc định.

**Xem phạm vi** chỉ đọc nguồn; **Kiểm tra đích (chỉ đọc)** mở phiên riêng để đối chiếu metadata của database bạn nhập trên cùng kết nối. Báo cáo chỉ ra bảng/view trùng tên, trigger và FK liên quan, kể cả bảng ngoài lựa chọn tham chiếu vào bảng chọn. Chưa thấy đối tượng có thể do thiếu quyền; không đồng nghĩa đối tượng không tồn tại. Thiếu quyền, metadata sai hoặc vượt 5.000 mục mỗi nhóm objects/triggers/FK được báo chưa xác định. Không tạo database, không chạy DDL/DML, không đọc dữ liệu dòng và không chạm transaction SQL Editor.

Phần **So sánh lần kiểm tra** giữ một mốc tạm trong hộp thoại sau lượt **Kiểm tra đích** thành công. Bấm lại nút để quét nguồn/đọc metadata mới và so tệp backup, metadata/ngữ cảnh đích, bản nháp kế hoạch. Mốc được xóa khi đổi lựa chọn/đích/chính sách, xem nguồn riêng, lỗi/hủy hoặc đóng hộp thoại; không lưu vào localStorage/sidecar. Kết quả cũ đến muộn không được dùng làm mốc. Chỉ giữ whitelist checksum/digest tổng hợp, version, thời gian và scope, không SQL/giá trị dòng/biểu thức/tài khoản/secret. Module `restore-review.js` thuần dùng chung test và renderer, có trong index/packaging allowlist.

Snapshot v16 thêm metadataId tổng hợp gắn target identity, tập bảng và toàn metadata collector đã đọc, loại thời gian quan sát; tách khỏi checksum tệp và phần cấu trúc/dữ liệu nguồn. Plan v29/snapshot hiện có vẫn gắn nguồn/lựa chọn/đích theo cơ chế cũ. Report cũ/thiếu/binding sai/version hoặc scope khác không được hiện “chưa thay đổi”. Chỉ so hai quan sát, không chứng minh snapshot nguyên tử hoặc đủ quyền. Metadata bằng nhau **không chứng minh dữ liệu dòng đích không đổi**, không bao phủ nội dung/metadata ngoài quota và không cấp quyền phục hồi. Không thêm SELECT hoặc query dữ liệu, token/registry/apply; vẫn canExecute:false. Recheck sát lúc ghi và execution lifecycle vẫn chưa triển khai.

Mở **Khóa ngoại đích** để xem từng định nghĩa với cặp cột theo thứ tự, ON DELETE/ON UPDATE, MATCH và phạm vi: trong lựa chọn, tham chiếu ra ngoài, hoặc bảng ngoài tham chiếu vào. Collector ghép KEY_COLUMN_USAGE với REFERENTIAL_CONSTRAINTS bằng danh tính schema/bảng/tên constraint và bảng/schema được tham chiếu; tên được so chính xác để không trộn metadata khác hoa/thường. FK ghép được tính là một định nghĩa, kèm tổng số cặp cột. Cảnh báo inbound chỉ xuất hiện một lần cho mỗi constraint.

Thiếu join/action, sequence bị gãy/trùng, cột lặp, tham chiếu/action không nhất quán, metadata cũ hoặc lỗi/quota đều báo chưa đủ bằng chứng. Không tự mặc định action khi thiếu metadata; SET DEFAULT/MATCH ngoài NONE chưa được công nhận trong phạm vi đối chiếu này. Metadata được ghép đủ không chứng minh dữ liệu mồ côi, index, cascade hoặc quy tắc server đã hợp lệ. Không thấy FK vẫn có thể do quyền tài khoản; cần đọc lại sát lúc ghi.

FK đích đọc tối đa 5.000 cặp cột, tối đa 16 cặp mỗi định nghĩa được giữ trong báo cáo; report giữ tối đa 200 định nghĩa/1.000 cặp/50 findings và UI hiện 100 định nghĩa đầu, kèm tổng và cảnh báo nếu bị cắt. Báo cáo toàn lượt chưa đầy đủ thì không dùng để nới chính sách xung đột. Snapshot đích v12 và bản nháp v25 bind metadata thứ tự/action mới, không cấp quyền ghi. Tham khảo metadata [MySQL REFERENTIAL_CONSTRAINTS](https://dev.mysql.com/doc/refman/8.4/en/information-schema-referential-constraints-table.html) và [MariaDB REFERENTIAL_CONSTRAINTS](https://mariadb.com/docs/server/reference/system-tables/information-schema/information-schema-tables/information-schema-referential_constraints-table). Có thể chạy fixture độc lập trên database thử nghiệm bằng `SQLPRO_TEST_FK_PORT=<cổng-db-test> node --test test/target-foreign-keys-integration.test.cjs`.

Trong bản nháp, mở **Đối chiếu FK nguồn / đích** để xem định nghĩa nguồn và đích cạnh nhau. Chỉ so CREATE nguồn đã nhận diện với metadata FK đích đầy đủ: ưu tiên tên constraint khi có; nếu tên khác/không ghi tên thì tìm theo đủ cột local, đúng thứ tự. Báo riêng khác bảng/schema tham chiếu, cột local/remote và ON DELETE/UPDATE. Tên khác không tự có nghĩa cấu trúc khác; nhiều ứng viên thì chưa xác định. Không tự suy action mặc định hoặc coi RESTRICT/NO ACTION tương đương nếu chuỗi action khác nhau.

Báo cáo phân biệt khớp metadata, khác, nguồn chưa ghi đủ action, chưa thấy FK tương ứng, chưa thấy bảng đích và FK chỉ thấy ở đích của bảng có CREATE nguồn được nhận diện. Chưa thấy không chứng minh vắng mặt; nguồn thiếu CREATE, đích là view/không duy nhất, schema chưa ánh xạ, metadata cũ/lỗi/quota/truncation đều chưa đủ căn cứ. FK inbound từ bảng ngoài vẫn thuộc báo cáo FK đích, không bị xem nhầm là FK thừa trong nguồn. Khi chỉ chọn dữ liệu, việc so định nghĩa vẫn chỉ là thông tin tham khảo; không tạo/thay constraint.

Đối chiếu tối đa 2.000 FK/10.000 cặp nguồn; report giữ 200 mục/2.000 cặp nguồn+đích/50 findings, UI hiện 100 mục đầu. Số tổng tính phần nguồn trong quota, báo cắt nếu vượt giới hạn. Plan v29 bind báo cáo cùng snapshot và giữ `blocked/canExecute:false`; khớp metadata không bỏ kiểm tra dữ liệu/index/server, skip-existing/dependency hoặc quyền thực thi. Không phát sinh truy vấn database mới và không sinh ALTER.

Mở **Đối chiếu cột** của từng bảng để xem kiểu/độ dài/precision nguồn và đích, khác biệt NULL, auto-increment, generated, invisible, thông tin có default và charset/collation đã nhận diện. Công cụ phân biệt INSERT có danh sách cột với INSERT theo vị trí, cảnh báo lệch thứ tự/số cột và cột bắt buộc ở đích bị bỏ khỏi danh sách INSERT. Chỉ so metadata; không đọc giá trị dòng, không giữ giá trị default, biểu thức generated hoặc nhãn ENUM/SET trong báo cáo. Kiểu/thuộc tính chưa hỗ trợ, thiếu CREATE hoặc metadata không đầy đủ đều báo chưa xác định; chưa thấy khác biệt không bảo đảm các giá trị sẽ chuyển đổi được. Cảnh báo vẫn áp dụng khi chọn cấu trúc vì chưa có chính sách thay đối tượng đích.

Mở **Chỉ mục đích** của từng bảng để xem tên/loại PRIMARY/UNIQUE/INDEX, cột theo thứ tự, prefix, ASC/DESC và loại chỉ mục. Đọc `information_schema.STATISTICS` bằng schema/tên bảng được bind, chỉ lấy các bảng chọn; không lấy cardinality, biểu thức index hoặc dữ liệu dòng. Lỗi/quota/metadata cũ thiếu chỉ mục, bảng chưa xác định, sequence thiếu/trùng, functional index, DESC hoặc loại ngoài BTREE đều được báo chưa đủ bằng chứng. Dò cột metadata mà server cung cấp trước khi đọc `IS_VISIBLE` hoặc `IGNORED`; thiếu/lỗi/mâu thuẫn/quá quota không được suy thành visible. Hiện Visible/Invisible hoặc NOT IGNORED/IGNORED, còn quy tắc FK theo phiên bản server vẫn cần kiểm tra; báo cáo chỉ là metadata quan sát được trong quyền tài khoản.

Trong **Khóa ngoại nguồn**, nếu bảng cha đã thấy ở đích, báo cáo bổ sung quan sát full PRIMARY/UNIQUE KEY khớp đủ cột, đúng thứ tự và không prefix. Tên khóa có thể khác nguồn; chỉ so cột. Chưa thấy khóa khớp không chứng minh khóa không tồn tại. Khóa khớp đang Invisible/IGNORED được đánh dấu cần review, ưu tiên khóa visible/not-ignored khác khớp đủ cột nếu có. Có khóa khớp vẫn không gỡ chặn bảng cha bị bỏ qua hoặc chính sách xung đột; chưa xác nhận cấu trúc/collation, dữ liệu và ràng buộc đích đầy đủ. Nếu một phần báo cáo chỉ mục bị cắt hoặc chưa hỗ trợ, kết quả đối chiếu khóa vẫn chưa xác định.

Metadata chỉ mục giới hạn 20.000 thành phần cột toàn lần đọc; phân tích tối đa 128 chỉ mục/16 thành phần mỗi chỉ mục, chỉ hiện tối đa 50 chỉ mục/800 thành phần mỗi bảng và 1.000 chỉ mục/4.000 thành phần toàn lựa chọn. Quá giới hạn giữ cảnh báo chưa đầy đủ. Snapshot đích v12 bind cả capability và cờ chỉ mục đã đọc (kể cả phần UI không hiện hết); biểu thức index vẫn chưa thu thập. Báo cáo chỉ mục v1 cũ hoặc dữ liệu thiếu cờ/khác capability phải kiểm tra lại trước khi đối chiếu khóa.

Cờ trạng thái chỉ mô tả việc optimizer dùng chỉ mục; không có nghĩa ràng buộc UNIQUE/FK đã tắt hoặc được xác nhận hợp lệ. Tham khảo [MySQL Invisible Indexes](https://dev.mysql.com/doc/refman/8.4/en/invisible-indexes.html) và [MariaDB Ignored Indexes](https://mariadb.com/docs/server/ha-and-performance/optimization-and-tuning/optimization-and-indexes/ignored-indexes). Đã kiểm tra riêng nhánh cờ trên MySQL 8.4 và MariaDB 11.4; chưa nghiệm thu toàn bộ tính năng database trên MariaDB. Có thể chạy fixture riêng bằng `SQLPRO_TEST_INDEX_PORT=<cổng-db-test> node --test test/index-visibility-integration.test.cjs` trên database thử nghiệm; fixture tạo/xóa schema riêng.

Mỗi lần kiểm tra đích quét lại/hash nguồn, kiểm tra file identity trước/sau, chụp lựa chọn và cấu hình kết nối. Mã snapshot gắn hash nguồn, lựa chọn cấu trúc/dữ liệu, đích và metadata đọc được; đó là mã đối chiếu quan sát, **không phải token hoặc kế hoạch được phép thực thi**. Metadata được đọc qua nhiều truy vấn nên chưa phải snapshot nguyên tử. Kiểm tra có giới hạn 60 giây cho lượt đọc (10 giây/truy vấn metadata); Hủy đóng phiên kiểm tra riêng và ngắt lượt quét đã đăng ký, không hủy SQL Editor. Đăng xuất/đóng cửa sổ, đổi cấu hình hoặc sửa tệp làm kết quả cũ bị từ chối. Thay lựa chọn/đích xóa kết quả hiển thị cũ.

Đăng xuất/reset/đóng cửa sổ cũng vô hiệu cache và lượt quét nguồn đang chờ/chạy. Phản hồi Hủy cũ không cập nhật trạng thái lượt kiểm tra mới. Thuộc tính cột chưa hỗ trợ như ON UPDATE được báo chưa phân tích; snapshot gắn thêm fingerprint toàn metadata EXTRA đã đọc, không trả biểu thức đó trong báo cáo.

**Chưa thực thi phục hồi từng bảng**; báo cáo đích vẫn là một phần, chưa xác nhận tương thích giá trị, quyền ghi, dung lượng, ánh xạ schema, chính sách thay/xóa đối tượng hoặc tác động SQL nguồn. View/routine/trigger/event, ALTER, multi-table DROP và SQL động chưa phân tích đầy đủ; INSERT đếm câu lệnh, không cam kết số dòng hoặc tác động gián tiếp. Lựa chọn ở đây không thay đổi nút Phục hồi toàn bộ hiện có. Execution plan bất biến và recheck sát lúc ghi vẫn cần bổ sung.

Inventory chọn bảng giới hạn 1.000 bảng, 10.000 cạnh FK và 50 cảnh báo nguồn; định nghĩa CREATE tối đa 2 MiB/65.536 token. Preview hiển thị tối đa 100 cảnh báo kèm thông báo khi còn mục khác; mỗi bảng đích hiện tối đa 10 tên đối tượng và 10 trigger, FK đích hiện 100 định nghĩa đầu với cặp cột/action, vẫn báo tổng thấy được. Quét dùng chung cơ chế timeout/hủy/cache file identity hiện có; **Hủy quét** hủy lượt quét chung cho cùng backup, đóng hộp thoại chỉ ngừng xem. Xem nguồn không cần mở kết nối database; kiểm tra đích mở phiên riêng chỉ đọc. Cả hai dùng được trên profile chỉ đọc và giữ nguyên tệp nguồn/manifest. Quét thực thi restore toàn bộ hiện có không bật collector mới này.

Metadata cột nguồn giới hạn 256 cột/bảng và 10.000 cột toàn inventory; danh sách INSERT tối đa 8 bộ khác nhau/bảng và 10.000 tên cột được lưu toàn inventory. Truy vấn cột đích chỉ lấy các bảng đã chọn, tối đa 10.000 cột. Báo cáo hiện tối đa 50 cột/20 cảnh báo mỗi bảng và 2.000 cột/1.000 cảnh báo toàn lựa chọn; khi vượt giới hạn có thông báo để giảm phạm vi. Snapshot gắn cả metadata cột đích đã thu thập, kể cả khi UI không hiện hết.

Sau **Kiểm tra đích (chỉ đọc)**, mở **Bản nháp kế hoạch** để review từng câu lệnh theo số thứ tự trong tệp nguồn: phần thuộc lựa chọn, phần ngoài lựa chọn, câu chưa xử lý và chỉ thị USE/DATABASE được luồng restore hiện có bỏ qua. Câu thuộc lựa chọn vẫn chưa được kiểm chứng để chạy. DROP cần chính sách thay/xóa đối tượng; SET, transaction và câu chưa phân loại không bị tự bỏ qua. Thứ tự hiển thị giữ theo nguồn, chưa phải thứ tự phục hồi được xác nhận. Bản nháp nêu các phần còn chặn thực thi và không có nút chạy.

Mã bản nháp gắn checksum nguồn, lựa chọn, đích kết nối/database, snapshot metadata và danh sách câu lệnh đã thu thập; không phải token hoặc kế hoạch được phép ghi. Main dựng bản nháp từ dữ liệu tự đọc, không nhận kế hoạch từ renderer; không lưu quyền chạy cho lần sau. Inventory giữ tối đa 10.000 mục câu lệnh, đếm cả mục vượt quota; UI hiện tối đa 200 mục/100 lý do chặn, báo rõ khi bị cắt. Tổng phân loại chỉ tính các mục giữ được khi inventory vượt quota. Inventory cũ thiếu danh sách, số thứ tự bị gãy hoặc quota bị vượt đều báo chưa đầy đủ. Không lưu raw SQL/giá trị dòng trong bản nháp. Luồng phục hồi toàn bộ hiện có giữ nguyên hành vi.

Bản nháp có cột **Kiểm tra cú pháp** cho INSERT và CREATE, cùng thống kê riêng trong lựa chọn. Với INSERT, chỉ nhận `INSERT INTO [schema.]bảng [(cột,...)] VALUES (...) [, ...]` chứa số, NULL/TRUE/FALSE, chuỗi nháy đơn dùng hai nháy để ghi dấu nháy, hex hoặc bit. Các bộ VALUES phải có cùng số giá trị và khớp danh sách cột nếu có. Chưa hỗ trợ hàm/biểu thức/biến, DEFAULT, INSERT SELECT/SET, modifier, ON DUPLICATE KEY/RETURNING, escape backslash, quote kép hoặc comment còn trong câu lệnh được parser giao cho bộ kiểm tra. Vì vậy một số backup do SqlPro tạo với chuỗi escape backslash cũng được báo chưa hỗ trợ, không tự nới quy tắc. DROP chưa có validator cú pháp chọn bảng tương ứng; SET chỉ nhận diện mẫu dump giới hạn bên dưới.

Khớp cú pháp literal chưa xác nhận kiểu dữ liệu, giá trị chuyển đổi được, quyền ghi, số dòng sẽ ghi hoặc tác động FK/trigger/default. Câu chưa hỗ trợ hoặc inventory cũ thiếu kết quả kiểm tra vẫn bị chặn trong bản nháp. Kiểm tra INSERT giới hạn 2 MiB/câu, 200.000 token/câu, 256 giá trị/bộ, 10.000 bộ VALUES và 100.000 giá trị/câu; vượt giới hạn báo chưa hỗ trợ. Bộ kiểm tra chỉ trả trạng thái, mã lý do và số bộ/giá trị, không trả literal.

Với CREATE, bước đầu chỉ nhận toàn câu `CREATE TABLE` có tên schema/bảng/cột/chỉ mục được quote bằng backtick, ghi rõ `ENGINE=InnoDB`, kiểu cột cơ bản, NULL/NOT NULL, DEFAULT literal, AUTO_INCREMENT và PRIMARY/UNIQUE/KEY đơn giản. Hiện số cột, số chỉ mục, engine và số FK; không trả nội dung default/comment hoặc giá trị AUTO_INCREMENT. Tùy chọn charset/collation/row format được nhận diện theo grammar nhưng chưa xác nhận được server đích hỗ trợ. Generated, CHECK, ENUM/SET, partition/tablespace, hàm DEFAULT, IF NOT EXISTS, CREATE LIKE/SELECT, tên bare, quote kép/escape backslash, comment và phần SQL nối thêm đều được báo chưa hỗ trợ. `SHOW CREATE` dưới ANSI_QUOTES có thể dùng quote kép và vì vậy bị từ chối ở bước này.

Kiểm tra CREATE giới hạn 2 MiB/câu, 65.536 token, 256 cột, 128 chỉ mục và 16 cột/chỉ mục; toàn inventory giữ tối đa 5.000 định nghĩa chỉ mục và 20.000 thành phần cột chỉ mục. Giữ tên/loại/thứ tự cột và độ dài prefix của chỉ mục; vượt quota thì bằng chứng CREATE được báo chưa hỗ trợ. Khớp grammar không chứng minh DDL hợp lệ theo mọi phiên bản/SQL mode, đủ quyền, không xung đột hoặc có thể thực thi an toàn.

CREATE còn nhận diện `FOREIGN KEY` có/không có tên CONSTRAINT, tên index tùy chọn, cặp cột đơn/ghép và REFERENCES có schema. ON DELETE/ON UPDATE hỗ trợ RESTRICT/CASCADE/SET NULL/NO ACTION; bỏ trống action được hiển thị là không ghi rõ. Từ chối arity lệch, cột local không tồn tại, cột trùng, prefix/expression, MATCH/DEFERRABLE, SET DEFAULT hoặc action lặp/chưa hỗ trợ. Bằng chứng CREATE version 3 lưu metadata FK và định nghĩa chỉ mục theo whitelist; version 1/2 cũ được báo cần quét lại.

Trong bản nháp, mở **Khóa ngoại nguồn** để xem cặp cột và action. Báo cáo chỉ đối chiếu CREATE nguồn đã chọn với chính sách đích: báo bảng cha ngoài lựa chọn/bị bỏ qua/bị chặn, schema cần ánh xạ, metadata cột chưa đủ, cột không thấy, type/collation khác và SET NULL trên cột NOT NULL. Báo cáo đối chiếu PRIMARY/UNIQUE KEY của bảng cha trong nguồn: phải khớp đủ cột, đúng thứ tự và không dùng prefix. Hiện tên/loại khóa khớp; chỉ mục thường, sai thứ tự hoặc chỉ khớp một phần của khóa UNIQUE không đủ bằng chứng và vẫn bị chặn. Đây là kiểm tra bảo thủ trên bản backup, không kết luận mọi dạng khóa khác đều không hợp lệ với server. FK khớp khóa nguồn vẫn cần kiểm tra chỉ mục đích, dữ liệu mồ côi và quy tắc server; không tự suy tương thích hoặc sinh ALTER. Vòng FK và thứ tự thực thi chưa được giải quyết chỉ vì cú pháp khớp. Khi chỉ chọn dữ liệu, dùng cảnh báo FK đích hiện có; báo cáo nguồn này không chứng minh constraints đích đầy đủ.

Giới hạn 64 FK/CREATE, 16 cặp cột/FK; toàn inventory/báo cáo tối đa 2.000 định nghĩa và 10.000 cặp cột. Vượt quota bằng chứng CREATE được đánh dấu chưa hỗ trợ hoặc báo cáo bị cắt. Giao diện hiện 100 định nghĩa đầu, giữ totals và tối đa 100 findings; không coi danh sách bị cắt là đủ căn cứ phục hồi.

Phần **DEFAULT/generated ở đích** quan sát nội dung metadata cột qua digest tính ngay tại server trong SELECT COLUMNS sẵn có. COLUMN_DEFAULT dài 0–65.536 byte và GENERATION_EXPRESSION dài 1–65.536 byte được hash; không tải giá trị/biểu thức gốc về app. Metadata NULL của DEFAULT được giữ riêng, không suy không có DEFAULT; biểu thức generated không được công bố cũng không thành bằng chứng nếu cột có generated. Thiếu/cũ/sai status hoặc digest, metadata/quyền/identity/case chưa đủ và quota giữ unknown. Snapshot v16, metadataId binding v2 và plan v29 phát hiện hai DEFAULT khác nhau dù cả hai đều non-null, hoặc hai biểu thức generated khác nhau dù cùng tên/kiểu/thuộc tính. Trong giới hạn hash mới nhận diện được thay đổi; chưa đánh giá giá trị/ngữ nghĩa hoặc đối chiếu biểu thức nguồn với đích.

Profile biểu thức cột v1 và digest riêng chỉ giữ trong facts nội bộ; renderer/report v1/plan chỉ có table/column và status whitelist, không digest riêng/default/generated expression. Collector vẫn tối đa 12 SELECT và 10.000 cột; báo cáo 200 hàng/UI 100. Report complete chỉ là đủ phần metadata quan sát, không chứng minh cấu trúc/dữ liệu tương thích. Giữ gates DEFAULT_VALUES_NOT_VALIDATED, GENERATED_VALUES_NOT_VALIDATED, COLUMN_EXPRESSIONS_RECHECK_REQUIRED cùng toàn bộ gate cũ, canExecute:false; không thay CREATE grammar, full restore/trial/format backup, không executor/token/apply hay query dữ liệu dòng.

Fixture omission mở rộng: `SQLPRO_TEST_OMITTED_PORT=<cổng-db-test> node --test test/selection-omitted-integration.test.cjs`. Trên MySQL 8.4/MariaDB 11.4 đã đối chiếu non-null DEFAULT→DEFAULT, DEFAULT chuỗi rỗng, generated cùng tên đổi biểu thức, missing digest và metadata-only preview giữ Editor transaction. Chỉ dùng server thử nghiệm riêng; writer fixture kiểm chứng hành vi trong schema do test tạo/xóa. Tham khảo [MySQL COLUMNS](https://dev.mysql.com/doc/refman/8.4/en/information-schema-columns-table.html), [MariaDB COLUMNS](https://mariadb.com/docs/server/reference/system-tables/information-schema/information-schema-tables/information-schema-columns-table).

Phần **Trigger ở đích** bổ sung BEFORE/AFTER, sự kiện, thứ tự ACTION_ORDER và quan sát định nghĩa/ngữ cảnh tạo. SELECT TRIGGERS hiện có tính SHA2 tại server cho body 1–65.536 byte và context ≤32 KiB; context kết hợp hash cố định của SQL_MODE, DEFINER, charset và hai collation. Không tải về body/tài khoản/mode; digest riêng chỉ nằm trong facts nội bộ để gắn snapshot, không trả cho renderer hoặc lưu vào report/bản nháp. Trong giới hạn quan sát, thay body hoặc ngữ cảnh dù giữ nguyên tên làm đổi snapshot v16 và plan v29; đây không phải quyền thực thi hoặc snapshot nguyên tử. Tổng collector vẫn tối đa 12 SELECT, chỉ đọc, có timeout/context check như trước.

Metadata trigger v1 kiểm tra schema/table identity, case policy, timing/orientation/order, duplicate, quota và đủ thông tin định nghĩa/ngữ cảnh. Thiếu/cũ/bị từ chối/sai/quá quota giữ unknown; báo cáo không suy không có trigger từ kết quả rỗng. Tối đa 5.000 trigger được đọc, report 200 hàng/UI 100; danh sách từng bảng vẫn 10 mục và tổng thấy được. Report v1/bản nháp chỉ giữ tên, sự kiện/thời điểm/thứ tự, boolean quan sát và mã whitelist. Catalog complete hiện có không chứng nhận hiệu lực hoặc absence của trigger. Giữ các gate TARGET_TRIGGER_EFFECTS_NOT_VALIDATED/VISIBILITY_NOT_PROVEN/RECHECK_REQUIRED, canExecute:false; chưa phân tích body, dependency gọi routine/SQL động/ghi ngoài bảng hay cho phép thực thi chọn bảng.

Fixture engine mở rộng kiểm tra trigger đổi body/cùng tên, đổi SQL mode lúc tạo/cùng body, hai trigger theo thứ tự, missing/denied metadata, không lộ digest/DEFINER/SQL, Reader SELECT-only và Editor giữ transaction trên MySQL 8.4/MariaDB 11.4: `SQLPRO_TEST_ENGINE_PORT=<cổng-db-test> node --test test/selection-engines-integration.test.cjs`. Chỉ chạy trên server thử nghiệm riêng. Tham khảo [MySQL TRIGGERS](https://dev.mysql.com/doc/refman/8.4/en/information-schema-triggers-table.html), [MariaDB TRIGGERS](https://mariadb.com/docs/server/reference/system-tables/information-schema/information-schema-tables/information-schema-triggers-table). Chưa hỗ trợ EVENT_MANIPULATION nhiều sự kiện như MariaDB 12 trong report mới; giữ unknown thay vì suy một sự kiện.

Phần **Storage engine bảng đích** đọc ENGINE trong truy vấn TABLES hiện có, không tăng tổng tối đa 12 SELECT. Mỗi bảng chỉ được ghi nhận engine khi thấy đúng một bảng theo chính sách hoa/thường của server và metadata đủ; thiếu/cũ/null/sai kiểu/view/metadata lỗi vẫn chưa xác định. Bản nháp INSERT chỉ dữ liệu vào bảng đã có bị chặn khi engine chưa rõ hoặc ngoài InnoDB; skip-existing và guard schema/policy vẫn giữ ưu tiên. Không tự ALTER ENGINE. UI hiện tối đa 100 bảng; metadata quota vẫn 5.000 đối tượng. Snapshot v16 gắn engine; plan v29 dựng lại report v1 từ metadata objects, bind/freeze độc lập với snapshot được truyền vào. Đây vẫn là preview canExecute:false, không có executor/token/apply.

Quan sát InnoDB không bảo đảm rollback toàn bộ DDL hoặc tác động trigger sang bảng/engine khác. Giữ yêu cầu recheck engine sát lúc ghi và kiểm chứng tác động gián tiếp. [Tài liệu MySQL về rollback với bảng không hỗ trợ transaction](https://dev.mysql.com/doc/refman/8.4/en/nontransactional-tables.html). Fixture riêng: `SQLPRO_TEST_ENGINE_PORT=<cổng-db-test> node --test test/selection-engines-integration.test.cjs`; chỉ dùng server thử nghiệm vì fixture tạo/xóa schema và có thao tác writer để đối chiếu rollback MyISAM/trigger. Preview Reader chỉ SELECT và giữ settings/transaction của Editor.

Phần **Ràng buộc CHECK ở đích** đọc metadata theo lựa chọn bảng bằng SELECT, có dò capability thay vì đoán theo phiên bản. Ghép TABLE_CONSTRAINTS/CHECK_CONSTRAINTS theo schema/name và thêm table identity khi server công bố TABLE_NAME. Cờ ENFORCED chỉ hiển thị khi metadata có cột đó; nếu thiếu thì giữ chưa xác định, không suy CHECK đang bật hoặc dữ liệu thỏa điều kiện.

Biểu thức không được hiển thị, thực thi hoặc tải về: chỉ lấy SHA-256 metadata ở server khi kích thước biểu thức 1–65.536 byte để bind thay đổi vào snapshot. Digest riêng này không trả về renderer. Thay biểu thức với cùng tên CHECK hoặc đổi ENFORCED làm đổi snapshot v16 và plan v29; đó vẫn không phải snapshot nguyên tử hay quyền ghi. Metadata thiếu/lỗi/trùng/sai schema/case/quá quota giữ unknown; kết quả trống chỉ phản ánh quyền tài khoản. Tối đa 2.000 định nghĩa đọc, report 200 mục/50 findings, UI hiện 100 mục đầu. Report CHECK v2 bổ sung quan sát thiết lập phiên, catalog giữ phạm vi metadata; chưa kiểm chứng CHECK trên dữ liệu, thiết lập phiên hoặc source CHECK grammar. Preview vẫn canExecute:false.

Collector thêm một SELECT dò capability, một SELECT metadata khi capability đủ và một SELECT check_constraint_checks riêng, tối đa 12 SELECT tổng; thiếu capability không tự fallback để coi là không có CHECK. Fixture riêng: `SQLPRO_TEST_CHECKS_PORT=<cổng-db-test> node --test test/selection-checks-integration.test.cjs`, chỉ dùng database thử nghiệm. Đã kiểm chứng MySQL 8.4/MariaDB 11.4 từ chối số nguyên vi phạm CHECK, ALTER cùng tên đổi digest/snapshot/plan, thiếu quyền/capability, ENFORCED metadata và giữ session/transaction Editor. Tham khảo [MySQL CHECK_CONSTRAINTS](https://dev.mysql.com/doc/refman/8.4/en/information-schema-check-constraints-table.html) và [MariaDB CHECK_CONSTRAINTS](https://mariadb.com/docs/server/reference/system-tables/information-schema/information-schema-tables/information-schema-check_constraints-table).

Report CHECK v2 đọc riêng `@@SESSION.check_constraint_checks` bằng một SELECT cố định, timeout 10 giây và kiểm tra context trước/sau await. Chỉ nhận 0/1 hoặc chuỗi đúng 0/1; giữ boolean/null và lý do thuộc whitelist, không raw error/giá trị/SQL. Server báo ER_UNKNOWN_SYSTEM_VARIABLE thì giữ chưa xác định, không đoán theo phiên bản hoặc coi là tắt/bật. Lỗi quyền/kết nối hoặc kết quả thiếu/sai cũng giữ unknown với lý do riêng; không làm mất catalog CHECK đã đọc được. Catalog complete chỉ mô tả metadata, không chứng nhận hiệu lực phiên.

Tắt biến có finding/blocker riêng; thiếu trạng thái khi thấy CHECK vẫn yêu cầu kiểm chứng. Trạng thái này tách khỏi ENFORCED của từng ràng buộc và được bind vào snapshot v16/plan v29. Bật không chứng minh dữ liệu thỏa CHECK hoặc bảo đảm trạng thái phiên thực thi tương lai; report cũ v1 luôn hiển thị trạng thái phiên chưa xác định. Preview không SET/bật lại hoặc thực thi biểu thức; vẫn canExecute:false. Đã kiểm chứng MariaDB 11.4 đọc bật/tắt và giữ cảnh báo, MySQL 8.4 trả biến không có nên giữ unknown, cùng fixture thiếu quyền/kết quả sai/giữ session Editor. Tham khảo [MariaDB CHECK và check_constraint_checks](https://mariadb.com/docs/server/reference/sql-statements/data-definition/constraint) và [MySQL mã lỗi biến hệ thống](https://dev.mysql.com/doc/mysql-errors/8.4/en/server-error-reference.html).

Phần **Kiểm tra giá trị cơ bản** kiểm tra NULL và phạm vi số nguyên literal trên các cột nguồn và cột đích đã thấy. Ánh xạ danh sách INSERT theo tên, hoặc theo thứ tự cột hiển thị của từng phía khi không có danh sách tên. TINYINT/SMALLINT/MEDIUMINT/INT/BIGINT được kiểm tra đủ signed/unsigned bằng số nguyên chính xác, không chuyển BIGINT qua Number; độ rộng hiển thị không làm thay phạm vi và ZEROFILL dùng phạm vi unsigned. NULL ở cột không cho NULL là vấn đề; AUTO_INCREMENT, TIMESTAMP và cột generated/thuộc tính chưa biết cần review riêng.

DECIMAL/NUMERIC được kiểm tra thêm cho literal số nguyên và thập phân cố định viết trực tiếp trong SQL. Hỗ trợ precision 1–65 và scale 0–30, gồm mặc định DECIMAL(10,0), UNSIGNED và metadata ZEROFILL; phạm vi riêng của MariaDB có scale trên 30 vẫn chưa kiểm chứng. Thống kê theo vị trí giữ số lượng, số chữ số phần nguyên, số lẻ có ý nghĩa và số âm khác 0; không đưa giá trị qua Number. Phát hiện vượt phần nguyên, số âm ở cột unsigned và số lẻ không thể lưu nguyên vẹn đều chặn câu INSERT trong bản nháp. Phần lẻ chỉ có thêm số 0 không được xem là mất giá trị; không tự làm tròn, kể cả khi server có thể chấp nhận rồi thay đổi giá trị.

Nhận thêm chuỗi số trong dấu nháy đơn để kiểm tra BIGINT/DECIMAL của backup native. Chỉ nhận trọn chuỗi ASCII tối đa 256 ký tự, dấu `+`/`-` tùy chọn, chữ số và một dấu thập phân; có thể có số 0 đầu chuỗi. Không trim, không nhận khoảng trắng/ký tự xuống dòng, exponent, locale separator, Unicode digits, chuỗi chứa escape/nháy lồng hoặc phần thừa. Cột số nguyên chỉ nhận chuỗi không có dấu thập phân; `'1.0'` vẫn chưa kiểm chứng cho cột INT. Cột DECIMAL nhận cả chuỗi nguyên và thập phân đúng mẫu, giữ giới hạn precision/scale, dấu và mất scale như literal trực tiếp. Chuỗi số ở cột văn bản đi qua kiểm tra độ dài/charset như chuỗi thường; kiểu khác vẫn cần kiểm chứng chuyển đổi.

Kiểm tra thêm literal chuỗi cho VARCHAR/CHAR và nhóm TEXT với charset cụ thể utf8mb4, utf8mb3 hoặc ASCII. VARCHAR đếm Unicode scalar, không đếm UTF-16 unit hoặc cụm ký tự hiển thị; TEXT dùng số byte UTF-8 (ASCII dùng số byte tương ứng). TINYTEXT/TEXT/MEDIUMTEXT/LONGTEXT có giới hạn riêng; cột chứa ký tự không biểu diễn được bị báo nguy cơ mất dữ liệu. CHAR luôn cần xem xét padding/cách đọc theo SQL mode, có khoảng trắng cuối sẽ bị báo nguy cơ thay đổi dữ liệu. Không tự trim, cắt, đổi charset hoặc sửa chuỗi. Alias `utf8`, charset thiếu/khác và Unicode chưa hợp lệ giữ unknown; không suy alias từ phiên bản server. Phần này chưa hỗ trợ SQL backslash escapes; grammar cũ vẫn chặn, còn dấu nháy đơn lặp được đếm đúng theo nội dung đã giải mã. Tham khảo [MySQL CHAR/VARCHAR](https://dev.mysql.com/doc/refman/8.4/en/char.html), [BLOB/TEXT](https://dev.mysql.com/doc/refman/8.4/en/blob.html), [MariaDB Unicode aliases](https://mariadb.com/docs/server/reference/data-types/string-data-types/character-sets/unicode).

Kiểm tra DATE theo dạng `YYYY-MM-DD` và DATETIME theo dạng `YYYY-MM-DD hh:mm:ss[.fraction]`, phần lẻ tối đa 6 chữ số. Chỉ nhận toàn chuỗi ASCII không escape; không dùng Date/locale hoặc chuyển múi giờ. Đối chiếu lịch Gregorian và năm nhuận trong phạm vi năm 1000–9999, giờ 00–23/phút giây 00–59; năm dưới 1000 và phần lẻ giây tại giây cuối cùng của biên trên DATETIME giữ unknown. Ngày không có thật, thành phần ngày bằng 0 và giờ không hợp lệ bị bản nháp chặn để yêu cầu xử lý/chính sách riêng, kể cả khi SQL mode nào đó có thể chấp nhận lưu. Công cụ không tự đổi thành zero date hoặc coi ALLOW_INVALID_DATES là chứng nhận dữ liệu hợp lệ.

DATETIME so phần lẻ có ý nghĩa với precision của từng cột nguồn/đích, mặc định 0, tối đa 6: mất phần lẻ giây là vấn đề chặn, không tự round/truncate; số 0 cuối không tăng precision cần thiết. DATE nhận chuỗi DATETIME và ngược lại, định dạng lỏng/rút gọn, dấu T/timezone, số thay ngày và chuyển đổi khác vẫn chưa kiểm chứng. Evidence v7 giữ thêm profile YEAR; report v8 bổ sung review TIMESTAMP; nhóm DATE/DATETIME/TIME chỉ giữ count, số trường hợp calendar/zero/year/time/boundary và max scale; không ngày giờ gốc, component/minmax/hash. Evidence v1–v4 thiếu profile phải quét lại để kiểm tra ngày giờ; v5 giữ tương thích DATE/DATETIME nhưng cần quét lại cho TIME; v1–v6 thiếu profile YEAR phải quét lại để kiểm tra YEAR. Các profile số/text cũ vẫn tương thích theo version, không suy bằng chứng thiếu là đã kiểm chứng. Plan v29 bind/freeze, snapshot v16 và các quota hiện có giữ nguyên; preview luôn canExecute:false.

TIME được kiểm tra riêng theo dạng `[-]hh:mm:ss[.fraction]` hoặc `[-]hhh:mm:ss[.fraction]`: thời lượng âm và giờ trên 23 là hợp lệ trong phạm vi đã nhận diện, không đổi thành giờ trong ngày. Phạm vi chung được kiểm tra đến ±838:59:59, phút/giây 00–59; `00:00:00` là thời lượng hợp lệ. Phần lẻ giây được đối chiếu với TIME(0–6), giữ số 0 cuối và cảnh báo mất độ chính xác như DATETIME. Không tự cắt về giá trị biên, round/truncate hoặc đổi múi giờ.

Phần lẻ khác 0 tại ±838:59:59 giữ unknown vì quy tắc biên giữa các server chưa được chứng minh chung; fixture MySQL 8.4 và MariaDB 11.4 quan sát clipping khi tắt strict mode lần lượt về .000000 và .999999. Giá trị vượt phạm vi vẫn báo vấn đề dù server ở chế độ lỏng có thể cắt; kết quả preview không phụ thuộc vào việc thao tác ghi có thể được chấp nhận. Dạng rút gọn, ngày+giờ, số, dấu cộng, timezone hoặc escape chưa hỗ trợ vẫn cần kiểm chứng. Không giữ dấu, giờ, phút, giây hay chuỗi TIME gốc; chỉ giữ count/scale/nhóm vấn đề, kiểm tra không đếm trùng với DATE/DATETIME/numeric strings. Tham khảo [MySQL TIME](https://dev.mysql.com/doc/refman/8.4/en/time.html) và [MariaDB TIME](https://mariadb.com/docs/server/reference/data-types/date-and-time-data-types/time).

YEAR được kiểm tra riêng cho số nguyên hoặc chuỗi ASCII đúng 4 chữ số trong phạm vi 1901–2155 và số nguyên `0`. Chuỗi zero, năm rút gọn, leading zeros, dấu cộng/trừ, số thập phân/exponent hoặc dạng chuyển đổi khác giữ unknown; không tự suy thế kỷ hoặc sửa dữ liệu. Năm 4 chữ số vượt phạm vi báo vấn đề kể cả server relaxed có thể đổi thành zero. Grammar CREATE nhận YEAR và YEAR(4) để đọc backup native MariaDB; YEAR(2) và độ rộng khác chưa hỗ trợ. Evidence v7/report v8 chỉ giữ counts raw/quoted theo nhóm valid/zero/outOfRange/conversion, không năm gốc, component/minmax/hash. Plan v29 bind/freeze, snapshot v16 và quota không đổi; mọi gate thực thi vẫn giữ. Tham khảo [MySQL YEAR](https://dev.mysql.com/doc/refman/8.4/en/year.html) và [MariaDB YEAR](https://mariadb.com/docs/server/reference/data-types/date-and-time-data-types/year-data-type).

TIMESTAMP tái sử dụng profile DATETIME để kiểm tra lịch Gregorian, ngày bằng 0, giờ/phút/giây và mất phần lẻ giây theo precision từng cột nguồn/đích. Những vấn đề này được báo riêng, nhưng mọi giá trị khác NULL vẫn cần kiểm chứng múi giờ nguồn/đích, DST và phạm vi UTC của server. Không suy thời điểm hoặc giới hạn lưu từ lịch đúng, chuỗi có vẻ nằm trong phạm vi, phiên bản server hay múi giờ máy. Không đổi múi giờ hoặc tự round/truncate. DATE-only/TIME-only/number/định dạng offset và chuyển đổi khác vẫn unknown; NULL giữ quy tắc nullable/special semantics hiện có. Report v8 dùng evidence DATETIME từ v5–v7, không thêm profile hoặc quét lại chỉ vì nâng report; v1–v4 thiếu bằng chứng lịch vẫn unknown. Plan v29 bind/freeze; snapshot v16/quota/gates không đổi và canExecute:false. Tham khảo [MySQL TIMESTAMP/timezone](https://dev.mysql.com/doc/refman/8.4/en/datetime.html) và [MariaDB TIMESTAMP](https://mariadb.com/docs/server/reference/data-types/date-and-time-data-types/timestamp).

Tham khảo [MySQL DATE/DATETIME](https://dev.mysql.com/doc/refman/8.4/en/datetime.html), [MariaDB DATE](https://mariadb.com/docs/server/reference/data-types/date-and-time-data-types/date) và [date/time literals](https://mariadb.com/docs/server/reference/sql-structure/sql-language-structure/date-and-time-literals). Fixture riêng: `SQLPRO_TEST_TEMPORAL_PORT=<cổng-db-test> node --test test/selection-temporal-integration.test.cjs`, chỉ dùng database thử nghiệm. Đã kiểm tra DATE endpoints/năm nhuận, strict và relaxed SQL mode, DATETIME mất microsecond/ALTER precision, YEAR endpoints/zero/short-year conversions, TIMESTAMP calendar/precision/timezone, backup YEAR(4)/TIMESTAMP native, preview chỉ SELECT và giữ session/transaction Editor trên MySQL 8.4 và MariaDB 11.4.

Collector chỉ giữ thống kê hữu hạn và bitmask phạm vi theo vị trí, không lưu giá trị gốc, min/max giá trị, hash hoặc SQL. Evidence v4 bổ sung số chuỗi, độ dài tối đa theo ký tự/byte và cờ ASCII/BMP/Unicode hợp lệ/khoảng trắng cuối; đọc trực tiếp trong phạm vi SQL có quota, không sao chép nội dung chuỗi vào inventory. V1–v3 cũ thiếu thống kê text cần quét lại; các profile số v2/v3 vẫn được chiếu theo whitelist tương thích. Số dạng mũ/hex/bit ở cột số, định dạng ngày giờ khác và chuyển đổi kiểu khác còn chưa đủ căn cứ. Định dạng backup không đổi; BIGINT/DECIMAL đúng mẫu và VARCHAR/TEXT native không có escape được kiểm chứng qua backup/worker. Báo cáo phân biệt kiểm tra cơ bản qua/có vấn đề/chưa đủ căn cứ cho nguồn và đích. Thiếu metadata/bằng chứng cũ, sai schema, thiếu/không khớp số cột hoặc quá giới hạn phải review lại. Bảng skip và phần dữ liệu không chọn được loại khỏi kiểm tra giá trị, giữ quy tắc chặn schema như cũ.

Bằng chứng giá trị tối đa 256 vị trí/INSERT và 10.000 vị trí toàn inventory; giữ quota grammar 2 MiB/câu, 10.000 tuples/100.000 values, 32 MiB SQL kiểm tra toàn tệp. Metadata cột cho kiểm tra giá trị đích tối đa 256 cột/bảng và 2.000 cột toàn báo cáo; khi cắt không dùng làm chứng minh ánh xạ. Báo cáo giữ 100 câu/1.000 vị trí/50 mã cảnh báo, UI hiện 20 câu/100 vị trí đầu và tổng. Câu INSERT không giữ được chi tiết vì quota báo cáo được đánh dấu chặn, không được suy là đã qua kiểm tra từ tổng thống kê. Đây chưa phải kiểm chứng toàn bộ dữ liệu: vẫn cần SQL mode, khóa trùng, FK/CHECK/trigger, giá trị bị bỏ qua và recheck đích; không có nút chạy. Tham khảo [MySQL Integer Types](https://dev.mysql.com/doc/refman/8.4/en/integer-types.html), [Numeric Attributes](https://dev.mysql.com/doc/refman/8.4/en/numeric-type-attributes.html) và [MariaDB INT](https://mariadb.com/docs/server/reference/data-types/numeric-data-types/int).

Phần **Thiết lập session toàn tệp** nhận diện đúng 5 mẫu SET do SqlPro tạo: chọn utf8mb4; lưu rồi tạm tắt kiểm tra FK; lưu rồi thay SQL_MODE bằng NO_AUTO_VALUE_ON_ZERO; khôi phục SQL_MODE; khôi phục cờ FK. Chỉ nhận mẫu nguyên câu với tên biến gốc của dump, không nhận biểu thức/hàm, global/persist, lệnh bổ sung, quote kép/backslash hoặc comment còn trong câu. SET khác và BEGIN/COMMIT/ROLLBACK/UNLOCK vẫn báo chưa hỗ trợ trong kế hoạch chọn bảng.

Báo cáo đối chiếu trình tự trên toàn danh sách câu lệnh, kể cả bảng ngoài lựa chọn: bước đầu tệp phải ở trước phần SQL, bước khôi phục đảo thứ tự lưu và không có SQL tiếp theo; báo thiếu lưu/khôi phục, lặp bước, thiếu review cũ hoặc ledger bị cắt/gãy. SET tối đa 16 KiB/câu; CREATE, INSERT và context dùng chung 32 MiB SQL kiểm tra/inventory. Kết quả chỉ chứa action/mã lý do/số lượng, không lưu SQL hoặc giá trị SET tùy ý.

Phần **Kích thước SQL và giới hạn packet** so byte UTF-8 của từng câu SQL đã thu thập với `@@SESSION.max_allowed_packet` đọc trên phiên kiểm tra đích. Collector chỉ lưu số byte, không giữ nội dung SQL/giá trị; tính tối đa 16 MiB mỗi câu trong 10.000 mục ledger. Đây là kích thước câu do parser trả về, không phải dung lượng backup, kích thước hàng lưu trữ hoặc cam kết wire size sau rewrite. Giới hạn grammar 2 MiB và 32 MiB syntax budget vẫn giữ nguyên.

Câu có số byte vượt ngưỡng đã đọc bị bản nháp chặn. Vùng sát ngưỡng với khoảng đệm thận trọng 5 byte giữ unknown, không suy cách mỗi server tính framing. Chưa vượt ngưỡng chỉ là quan sát: còn giới hạn client/protocol, batch/rewrite, row storage, bộ nhớ và dung lượng. Không tự tách INSERT, sửa SQL hoặc đổi cấu hình server. Thiếu/cũ/sai/quá quota evidence, thiếu metadata/charset client utf8mb4, schema chưa ánh xạ hoặc ledger không đầy đủ đều cần kiểm tra lại. Skip và lựa chọn cấu trúc/dữ liệu được áp dụng nhưng không ghi đè schema mapping.

Metadata packet v1 được chiếu trong snapshot v16; plan v29 bind/freeze report và số byte từng bước. Đọc thêm biến vào SELECT session hiện có, không thêm truy vấn cho packet; toàn collector hiện tối đa 12 SELECT sau bổ sung CHECK. Report tối đa 200 câu/20 findings, UI hiện 100 câu đầu, tổng tính các mục trong quota; câu bị lược do quota báo cáo vẫn bị chặn. Preview luôn canExecute:false, không có executor/token/apply. Tham khảo [MySQL packet limits](https://dev.mysql.com/doc/refman/8.4/en/packet-too-large.html) và [MariaDB protocol packets](https://mariadb.com/docs/server/reference/clientserver-protocol/0-packet).

Fixture packet cần server thử nghiệm riêng khởi động với `--max-allowed-packet=32768`, sau đó chạy `SQLPRO_TEST_PACKET_PORT=<cổng-db-test> node --test test/selection-packets-integration.test.cjs`. Fixture không đổi giới hạn GLOBAL/SESSION; thử gửi câu quá lớn qua phiên writer dùng một lần vào schema tạm, xác nhận preview chỉ SELECT và phiên Editor không đổi. Không dùng fixture này trên database đang làm việc.

Phần **Cột bị bỏ khỏi INSERT** đối chiếu riêng từng câu với định nghĩa nguồn và metadata đích đã đọc đủ. Danh sách tên cột được ghép không phân biệt hoa/thường; INSERT theo vị trí chỉ ghép khi đủ số cột hiển thị, các cột Invisible nằm ngoài danh sách đó. Cột NOT NULL không thấy DEFAULT hoặc cơ chế tự sinh được báo có vấn đề và chặn câu INSERT trong bản nháp. Cột nullable không thấy DEFAULT chỉ có quan sát dự kiến NULL, chưa chứng nhận dữ liệu/constraints hoặc khả năng phục hồi.

Có DEFAULT luôn cần kiểm chứng giá trị/biểu thức; AUTO_INCREMENT, generated, TIMESTAMP hoặc thuộc tính chưa hỗ trợ vẫn chưa đủ căn cứ. Không giữ giá trị DEFAULT, biểu thức, raw SQL hoặc tự sinh giá trị trong báo cáo. MySQL/MariaDB có khác biệt biểu diễn DEFAULT NULL trong metadata: nếu chỉ thấy có DEFAULT thì công cụ giữ trạng thái cần kiểm chứng. Cột nguồn cần đúng một CREATE v3 được nhận diện với schema phù hợp; projection cột đích v1 cũ thiếu thông tin DEFAULT phải kiểm tra lại. Projection v2 chỉ thêm cờ boolean/null về sự hiện diện DEFAULT; snapshot v16 và plan v29 bind bằng chứng mới.

Review cột bị bỏ giới hạn 10.000 vị trí metadata ở hai phía, 100 câu/1.000 cột bị bỏ/50 findings; UI hiện tối đa 20 câu/100 cột ở hai phía. Câu bị lược do quota báo cáo bị chặn, metadata/ánh xạ/grammar chưa đủ được báo chưa xác định. Đây vẫn là preview `canExecute:false`, không có token/apply/executor. Tham khảo [MySQL default values](https://dev.mysql.com/doc/refman/8.4/en/data-type-defaults.html), [MySQL invisible columns](https://dev.mysql.com/doc/refman/8.4/en/invisible-columns.html), [MariaDB INSERT defaults](https://mariadb.com/docs/server/reference/sql-statements/data-manipulation/inserting-loading-data/insert-default-duplicate-values) và [MariaDB invisible columns](https://mariadb.com/docs/server/reference/sql-statements/data-definition/create/invisible-columns). Fixture riêng: `SQLPRO_TEST_OMITTED_PORT=<cổng-db-test> node --test test/selection-omitted-integration.test.cjs`; chỉ dùng database thử nghiệm vì fixture tạo/xóa schema riêng.

Phần **Chính sách phiên phục hồi** đọc thêm thiết lập session trên kết nối kiểm tra đích riêng bằng SELECT: kiểm tra FK, unique_checks, autocommit, SQL mode và ba charset client/connection/results. Snapshot đích v12 gắn thiết lập này vào mã đối chiếu. SQL mode chỉ giữ cờ thuộc danh sách nhận diện, số cờ chưa nhận diện và fingerprint; không trả chuỗi mode tùy ý. Thiếu/sai/quá giới hạn metadata, FK/unique_checks hoặc autocommit tắt, charset khác utf8mb4, mode chưa nhận diện hoặc thiếu strict mode đều có lý do chặn.

Đề xuất giữ kiểm tra FK và unique_checks bật, giữ SQL mode đích, chỉ thêm `NO_AUTO_VALUE_ON_ZERO` khi mẫu SET native yêu cầu. Báo cáo ánh xạ tối đa 50 bước context sang đề xuất, không chứa SQL để chạy. Nhận diện tên cờ không chứng minh tương thích giá trị/cú pháp với mode đó. Thiết lập quan sát không bảo đảm phiên thực thi tương lai có cùng trạng thái; vẫn cần đọc lại trên đúng kết nối riêng, xác minh dữ liệu/thứ tự phụ thuộc và kiểm tra kết quả/FK. Tham khảo [MySQL SQL Modes](https://dev.mysql.com/doc/refman/8.4/en/sql-mode.html) và [MySQL Foreign Keys](https://dev.mysql.com/doc/refman/8.4/en/create-table-foreign-keys.html).

Metadata phiên v2 thêm unique_checks dạng boolean/null; report chính sách phiên v2 hiển thị bật/tắt/chưa xác định và yêu cầu đọc lại trên đúng phiên trước khi ghi. Profile v1 cũ luôn giữ unique_checks unknown, kể cả có field bổ sung; thiếu field không được suy mặc định bật. Raw metadata chỉ nhận 0/1 hoặc chuỗi đúng 0/1; projection không chấp nhận giá trị sai kiểu. Plan v29 bind/freeze báo cáo, snapshot v16 gắn thay đổi thiết lập; quota giữ nguyên; unique_checks đọc trong SELECT session hiện có, tổng collector tối đa 12 SELECT khi gồm CHECK phiên. Packet byte review vẫn đọc charset từ profile v1/v2, không suy trạng thái uniqueness từ bằng chứng encoding.

Bật unique_checks không chứng minh dữ liệu không trùng khóa hoặc đủ điều kiện phục hồi. Khi tắt, storage engine có thể vẫn phát hiện và từ chối khóa trùng; không suy mọi lần ghi trùng đều thành công. Preview chỉ SELECT, không tự SET/bật lại hoặc áp dụng SET từ dump; full restore/trial/format backup không đổi, canExecute:false. Fixture session riêng kiểm tra drift, legacy unknown, duplicate rejection khi bật và giữ transaction/settings Editor: `SQLPRO_TEST_SESSION_PORT=<cổng-db-test> node --test test/selection-session-policy-integration.test.cjs`. Tham khảo [MySQL unique_checks](https://dev.mysql.com/doc/refman/8.4/en/server-system-variables.html#sysvar_unique_checks) và [MariaDB unique_checks](https://mariadb.com/docs/server/server-management/variables-and-modes/server-system-variables#unique_checks).

Mẫu SET khớp vẫn bị chặn. Vòng đời thực thi/cleanup chưa được triển khai: phải khôi phục thiết lập khi kết thúc, đóng phiên riêng, dừng khi lỗi/hủy và báo phần đã ghi, không tự thử lại hay cam kết rollback toàn bộ DDL. Luồng restore toàn bộ và phục hồi thử hiện có không dùng báo cáo này để nới quyền thực thi.

Trước **Kiểm tra đích (chỉ đọc)**, chọn **Chính sách xung đột**: mặc định **Chặn khi trùng cấu trúc**, hoặc **Bỏ qua toàn bộ bảng đã thấy ở đích**. Bản nháp có báo cáo từng bảng: đối tượng thấy được, dự kiến tạo/thêm dữ liệu/bỏ qua và điều kiện còn thiếu. Bỏ qua áp dụng cho cả CREATE/DROP/INSERT được gán đúng bảng đó; lệnh sai schema, nhiều bảng hoặc chưa phân loại vẫn bị chặn. Chính sách không cho phép DROP, ghi đè hay tự thay view.

Nếu chỉ chọn dữ liệu, chính sách mặc định chỉ đề xuất xem xét thêm vào bảng đã thấy và vẫn yêu cầu kiểm tra khóa trùng/giá trị/constraints/trigger; chưa có xử lý merge/upsert. Metadata thiếu/lỗi/bị cắt, database chưa thấy, tên không duy nhất hoặc chưa rõ hoa/thường đều chặn đề xuất. Bảng chưa thấy không được coi là chắc chắn chưa tồn tại. Bảng còn phục hồi phụ thuộc vào bảng bị bỏ qua cần đối chiếu thêm; không tự coi cấu trúc/dữ liệu bảng đó tương thích.

Đổi chính sách xóa bản xem trước và phải kiểm tra lại; phản hồi cũ không cập nhật lựa chọn mới. Main chỉ nhận tên chính sách thuộc danh sách hỗ trợ rồi tự dựng báo cáo từ metadata mới, không nhận quyết định hay quyền chạy do renderer gửi. Báo cáo giữ tối đa 1.000 bảng, giao diện hiện 100 bảng đầu và tổng đầy đủ. Bản nháp version 25 bind cả chính sách xung đột/phiên, bằng chứng, trình tự session, báo cáo FK và đích vào mã đối chiếu; luôn `blocked/canExecute:false`, không có nút chạy.

Tạo backup trong catalog và sao chép nội bộ công bố tệp theo cách không thay thế backup đã tồn tại khi trùng ID. Filesystem cần hỗ trợ hard link trong cùng thư mục; nếu không hỗ trợ, thao tác báo lỗi và giữ bản đã có. Manifest trùng cũng được giữ nguyên và báo chưa xác minh cho backup mới; không kích hoạt tự dọn. Xuất ra đường dẫn do người dùng chọn vẫn cho ghi thay tệp qua hộp thoại lưu.

**Xem trước dọn backup…** cho nhập số bản tối đa, tuổi tối đa và tổng dung lượng SQL tối đa (MiB). Công cụ đề xuất các bản cũ nhất, bảo vệ bản ghim, bản mới nhất và bản mới nhất đã ghi thành công kèm checksum xác minh. Nếu thiếu bằng chứng hoặc có metadata lỗi/ngày bất thường, công cụ giữ lại và báo lý do; giới hạn có thể chưa đạt vì các bản được bảo vệ. **Lưu chính sách** lưu riêng theo kết nối/database trên máy này, mở lại sẽ nạp các giới hạn đó. **Xóa chính sách đã lưu** chỉ bỏ cấu hình, giữ nguyên backup. Chưa đồng bộ chính sách qua vault. Checksum xác minh không thay thế phục hồi thử.

**Tự dọn sau khi backup mới thành công** mặc định tắt. Muốn bật, đánh dấu checkbox rồi **Lưu chính sách**, kiểm tra xác nhận riêng tại main. Các lần tạo backup tiếp theo trên máy này sẽ tự áp dụng sau khi tệp và manifest/checksum đã ghi thành công, không hỏi lại từng lần. Chỉ dọn các bản cùng nguồn và cùng phạm vi lựa chọn/số đối tượng với backup mới. Manifest mới có dấu nhận diện đích kết nối; backup từ máy chủ khác, bản cũ thiếu dấu này, danh sách đối tượng không khớp số lượng, metadata thiếu và bản ghim được giữ. Vì vậy quota có thể chưa đạt; có thể xem trước rồi dọn thủ công các bản cũ sau khi tự đối chiếu. Không tự xóa backup trước để lấy chỗ trống cho bản mới; nếu backup mới lỗi, không chạy dọn. Đăng xuất/đóng cửa sổ vô hiệu xác nhận đang chờ và dừng dọn đang chạy; các tệp đã xóa trước đó không được hoàn tác.

Kết quả sao lưu hiển thị riêng phần tự dọn. Nếu dọn lỗi/hủy, backup mới đã lưu vẫn thành công và các bản chưa xử lý được giữ; xem **Lịch sử dọn backup** để đối chiếu mã backup kích hoạt và phần đã xóa. Có thể dùng Hủy tác vụ backup để dừng giai đoạn tự dọn; những tệp đã xóa không được hoàn tác. Tắt checkbox và lưu hoặc xóa chính sách để ngừng tự dọn ở lần sau. Chưa đồng bộ cấu hình này và không tự tiếp tục lượt dọn bị gián đoạn sau restart.

**Lịch backup…** trong Backups cho đặt chu kỳ 1–168 giờ và lần chạy đầu trong tương lai, tối đa 366 ngày. Bấm **Lưu và bật lịch** (Ctrl+Enter), kiểm tra đích trong xác nhận native. Mỗi kết nối/database có một lịch, tối đa 50 lịch trên máy. Backup dùng phiên riêng, lấy cấu trúc và dữ liệu của toàn bộ bảng/view/routine/event tài khoản nhìn thấy, tối đa 2.000 đối tượng mỗi nhóm. Không thay cấu hình SSH/TLS khi chạy nền; phải xử lý quyền, secret hoặc SSH host key trong cấu hình kết nối trước. Thay đích kết nối sẽ dừng lịch khi kiểm tra; cần lưu lại để chấp thuận đích mới. Chính sách tự dọn đang bật áp dụng sau backup theo lịch thành công.

Lịch MVP chỉ chạy khi ứng dụng đang mở, theo số giờ trôi qua; múi giờ dùng để nhập/hiển thị, không cố định một giờ địa phương khi DST thay đổi. Bộ chạy kiểm tra khoảng 15 giây/lần, giữ một transfer slot. Trong 60 giây sau giờ hẹn có thể đợi tác vụ khác nhường chỗ; quá hạn do sleep/đóng app/bận thì ghi nhận bỏ lỡ và chuyển tới kỳ tương lai, không chạy bù hàng loạt hoặc tự retry. Lưu lượt chạy và kỳ tiếp theo trước khi bắt đầu để tránh phát lại sau restart. Lượt bị gián đoạn được đánh dấu chưa hoàn tất; hãy đối chiếu catalog, không suy rằng tệp chắc chắn chưa được ghi. Chưa kiểm chứng mất điện ở mọi điểm hoặc tích hợp scheduler hệ điều hành.

Mở lại **Lịch backup…** hoặc bấm **Cập nhật trạng thái** để xem lần kế tiếp, kết quả gần nhất, ID backup, lỗi và cảnh báo manifest/tự dọn. Thanh trạng thái báo khi backup nền kết thúc; phần này chưa mở tab Tác vụ database cho scheduler. **Tạm dừng lịch** ngừng kỳ sau và gửi hủy nếu lịch đang chạy; đợi kết thúc rồi mới xóa lịch. **Xóa lịch** giữ các tệp backup. Đóng cửa sổ hoặc đăng xuất dừng bộ chạy trong phiên hiện tại; mở lại cửa sổ trên macOS cần lưu/bật lại, còn khởi động lại ứng dụng nạp các lịch đã bật. Reset local tắt các lịch đã lưu. Lỗi lưu trạng thái dừng bộ chạy và giữ bằng chứng chưa hoàn tất để đối chiếu; sửa lỗi rồi lưu/bật lại hoặc khởi động lại ứng dụng.

Sau preview, **Dọn các bản đã xem trước…** mở xác nhận riêng liệt kê chính xác các bản sẽ xóa khỏi catalog cục bộ. Xác nhận có hạn 2 phút và chỉ dùng một lần; preview mới cùng database vô hiệu preview cũ. Ứng dụng kiểm tra lại catalog/ghim/metadata và hash của bản giữ lại trước khi xóa từ bản cũ nhất. Có thay đổi thì phải xem trước lại. Mỗi lần dọn tối đa 100 bản trong catalog tối đa 2.000 bản; lỗi giữa chừng dừng phần còn lại và báo những bản đã xóa. Xóa không thể hoàn tác trong SqlPro; crash có thể để metadata còn sót. Không có thao tác thay dữ liệu trên server trong luồng dọn này.

Trong khi dọn, giao diện hiển thị giai đoạn kiểm tra, số byte hash và số bản đã xóa. **Dừng dọn backup** ngắt đọc checksum hoặc dừng trước tệp tiếp theo; các bản đã xóa giữ nguyên kết quả, các bản chưa xử lý được giữ lại và báo trong kết quả. Một thao tác filesystem đang chạy có thể cần hoàn tất trước khi dừng. Đóng hộp thoại không tự hủy tác vụ; hãy dùng Dừng trước nếu muốn ngừng.

**Lịch sử dọn backup…** giữ tối đa 50 lượt trên máy này, riêng theo kết nối/database. Mở từng lượt để xem danh sách đã xóa, chưa xóa, dung lượng SQL và mã lỗi. Nếu báo **Chưa xác nhận kết thúc**, hãy đối chiếu danh sách dự kiến với catalog: ứng dụng có thể đã bị gián đoạn trước khi lưu kết quả cuối, nên số đã xóa chưa chắc đầy đủ. Lịch sử không tự tiếp tục xóa và không khôi phục được backup đã mất. Tệp lịch sử lỗi được giữ nguyên; nếu không ghi được bản ghi đầu, SqlPro dừng trước khi dọn.

Trong lịch sử, **Xuất báo cáo JSON…** lưu các lượt hiện có để đối chiếu hoặc chia sẻ. Báo cáo gồm mã backup, policy, trạng thái, thời gian, dung lượng và mã lỗi; không chứa nội dung SQL, token, host hoặc tên kết nối/database. Nếu tác vụ đang chạy hoặc báo cáo chưa kết thúc, số đã xóa có thể chưa đầy đủ. Chọn nơi lưu ngoài thư mục dữ liệu SqlPro để giữ nguyên backup và cấu hình; thao tác xuất không sửa lịch sử nguồn.

Nhấp chuột phải vào nhóm **Backups** hoặc một bản backup trong cây để mở menu ngữ cảnh: tạo mới, phục hồi, xóa, xuất SQL, sao chép tên, mở thư mục chứa tệp và làm mới. Các lệnh cần một bản backup sẽ bị vô hiệu khi chưa chọn bản nào.

- Sao lưu ra tệp `.sql` gồm `CREATE TABLE`, `CREATE VIEW`, trigger (gắn với các bảng được chọn), procedure, function, event và `INSERT`; có thể chọn từng đối tượng, chỉ lấy cấu trúc hoặc kèm `DROP … IF EXISTS`.
- Procedure, function và event được lấy bằng `SHOW CREATE`, đặt trong khối `DELIMITER $$`; mặc định giữ `DEFINER`, có thể chọn loại bỏ để khôi phục trên server khác. Trigger được nhận đúng loại đối tượng khi phục hồi.
- Phục hồi chạy tệp `.sql` tuần tự vào database đang chọn. Hỗ trợ tệp do SqlPro, `mysqldump` hoặc Navicat tạo, kể cả routine/trigger dùng `DELIMITER`.
- Phục hồi quét toàn bộ tệp trước khi ghi, bỏ qua `USE` và `CREATE/DROP DATABASE`. Tên schema ghi rõ phải trùng chính xác đích đã chọn, kể cả chữ hoa/thường; `ALTER DATABASE/SCHEMA` ngoài đích và lệnh cấp server như `FLUSH`, `SET GLOBAL/PERSIST`, `START REPLICA` bị chặn. `SET` chỉ hỗ trợ các biến session cần cho dump và biến `@`; tệp có lệnh chưa hỗ trợ sẽ báo lỗi trước khi chạy. Vẫn cần tài khoản giới hạn quyền trên đích và tệp đáng tin cậy vì routine/trigger có thể có tác động gián tiếp.
- Trong lúc phục hồi, khóa ngoại được tắt tạm thời rồi bật lại theo trạng thái ban đầu. Sau đó ứng dụng kiểm tra khóa ngoại và số dòng khi có đủ thông tin, phân biệt `verified` (đã kiểm chứng), `unverified` (chưa đủ kiểm chứng) và `failed` (kiểm chứng thất bại); không tự xóa/sửa dòng mồ côi.
- Tùy chọn **Xóa bảng/view/trigger/procedure/function/event trùng tên** sẽ bỏ đúng đối tượng cũ trước khi tạo lại. Mặc định tắt để tránh mất dữ liệu ngoài ý muốn.
- Sao lưu/phục hồi và nhập/xuất tệp chạy trong main process, đọc/ghi theo luồng nên không giới hạn tổng dung lượng tệp trong ứng dụng. Cần đủ dung lượng ổ đĩa; các dòng dữ liệu rất lớn vẫn phụ thuộc `max_allowed_packet` của MySQL/MariaDB. Chỉ phục hồi tệp bạn tin cậy vì nội dung tệp có thể thay đổi dữ liệu.
- Có thể hủy tác vụ đang chạy. Tệp xuất dở được ghi qua tệp tạm `.part` rồi mới đổi tên; khi hủy hoặc lỗi, SqlPro dọn tệp tạm và báo số dòng/dung lượng đã xử lý. Phục hồi/import bị hủy có thể đã ghi một phần dữ liệu, nên báo cáo một phần được hiển thị rõ.

## Nhập và xuất dữ liệu

Mở bằng nút **Nhập**/**Xuất** trên thanh công cụ bảng hoặc menu **Tệp → Nhập dữ liệu… / Xuất dữ liệu…**.

- Toàn bộ việc đọc/ghi tệp diễn ra trong main process. Renderer chỉ nhận metadata, tối đa 20 dòng xem trước và tiến trình; không nhận toàn bộ nội dung tệp hoặc toàn bộ rows.
- Hỗ trợ CSV, TSV và JSON. CSV/TSV dùng UTF-8, có hoặc không có dòng tiêu đề, chọn dấu phân cách `,` `;` `|` hoặc tab. Bộ phân tích xử lý trường có dấu ngoặc kép, dấu phân cách và xuống dòng bên trong ô, BOM và CRLF.
- CSV/TSV: `NULL` được xuất thành `\N`; chuỗi literal `\N` được escape thành `\\N`; dữ liệu nhị phân xuất dạng `0x…`. JSON xuất thành mảng object hợp lệ và giữ nguyên `null`.
- Trước khi nhập, SqlPro xem trước tối đa 20 dòng (có thể yêu cầu tới 100), cho ánh xạ từng cột nguồn sang cột đích và bỏ qua cột. JSON lấy key của các object; CSV/TSV không có tiêu đề dùng thứ tự cột (Cột 1, Cột 2…).
- Giá trị được kiểm tra theo kiểu cột trước khi ghi: số nguyên/số thực, ngày giờ, JSON hợp lệ, hex nhị phân, NULL và cột bắt buộc. Cột generated bị bỏ qua hoặc báo lỗi thay vì ghi trực tiếp.
- Khi trùng khóa: **Dừng và báo lỗi** (`INSERT`), **Bỏ qua bản ghi trùng**, hoặc **Cập nhật bản ghi trùng** (`ON DUPLICATE KEY UPDATE`). Số bản ghi trùng do máy chủ báo sẽ hiện trong tiến trình.
- Transaction: **Mỗi lô một transaction** (mặc định, tối đa 200 dòng/lô và 10.000 tham số), **Toàn bộ trong một transaction** (commit một lần, có rollback nếu lỗi/hủy nhưng giữ transaction lâu), hoặc **Không dùng transaction** (nhanh nhưng có thể để lại dữ liệu đã ghi khi lỗi). Rollback chỉ được bảo đảm với bảng InnoDB; engine không có transaction như MyISAM có thể giữ lại các dòng đã ghi.
- Không có giới hạn 5.000 dòng khi nhập hay 20.000 dòng khi xuất ở luồng tệp. Không hỗ trợ resume sau khi hủy/lỗi: chạy lại sẽ bắt đầu từ đầu tệp và có thể tạo bản ghi trùng nếu transaction trước đã commit một phần.
- Có thể hủy xuất/nhập từ hộp thoại tiến trình; SqlPro dừng ở ranh giới lô, đóng kết nối đang dùng và báo phần đã xử lý.

## Chạy khi phát triển

### Website giới thiệu và tài liệu

Website được server phục vụ trực tiếp, có sáu trang tĩnh: `index.html`, `docs.html`, `changelog.html` và các bản tiếng Anh tương ứng `.en.html`. Tài liệu có tìm kiếm không dấu và mã lỗi; trang tải hiển thị thông tin bộ cài/checksum do GitHub cung cấp; changelog lấy bản phát hành công khai. Khi API lỗi, các trang vẫn giữ liên kết GitHub Releases dự phòng.

Công cụ tự host tạo `.env`, `compose.yaml` và Caddyfile ngay trong trình duyệt. Chế độ localhost chỉ bind loopback; chế độ HTTPS chỉ mở cổng 80/443 của Caddy và giữ app trong mạng Compose. Công cụ không triển khai server thay người dùng.

Sửa template tại `scripts/build-website.cjs`, nội dung tài liệu tại `scripts/website-docs.cjs`, rồi chạy `npm run website:build`. Commit cả các trang HTML được sinh; server không cần chạy bước build. `npm run check` kiểm tra các trang còn khớp source. Chạy `npm run test:website` để kiểm tra bằng Chromium; cần cài dependencies ở cả root và `server/`. Trên Linux không có màn hình, dùng `xvfb-run -a npm run test:website`.

Ảnh sản phẩm được chụp từ chính renderer với dữ liệu demo. Video WebM ngắn được tạo từ ba ảnh này, không có âm thanh, có caption Việt/Anh. Để cập nhật ảnh và video trên PowerShell:

```powershell
$env:SQLPRO_SCREENSHOT_DIR = Join-Path (Get-Location) 'website/assets/screenshots'
npm run test:renderer
Remove-Item Env:SQLPRO_SCREENSHOT_DIR
```

### Ứng dụng desktop

Yêu cầu Node.js 22 trở lên.

```bash
npm install
npm start
```

Chạy kiểm tra toàn bộ cú pháp và test desktop:

```bash
npm run check
```

Kiểm thử MySQL tích hợp chạy trên một server kiểm thử riêng tại `127.0.0.1` với user `root` không mật khẩu. Test tự tạo database tên `sqlpro_test_*` rồi xóa đúng database đó. Trên PowerShell, đặt cổng của instance kiểm thử trước khi chạy:

```powershell
$env:SQLPRO_TEST_MYSQL_PORT = '53379'
npm run test:mysql
Remove-Item Env:SQLPRO_TEST_MYSQL_PORT
```

Không đặt biến này thì bộ test tích hợp được bỏ qua trong `npm run check`. CI tạo container MySQL 8.4 riêng để chạy snapshot khi có ghi đồng thời, transaction độc lập, import JSON/số lớn, CRUD khóa nhị phân và export/hủy stream. Backup dùng kết nối riêng; snapshot dữ liệu áp dụng khi mọi bảng được chọn là InnoDB. Với engine khác hoặc thay đổi DDL đồng thời, cần tạm dừng thay đổi tương ứng trong lúc backup.

Server có bộ test riêng:

```bash
npm ci --prefix server
npm run server:test
```

## Tạo bộ cài

Ubuntu/Linux:

```bash
npm run pack:linux
```

Kết quả gồm AppImage và gói `.deb` trong thư mục `release/`.

Windows (chạy trên máy Windows hoặc CI Windows):

```powershell
npm ci
npm run pack:windows
```

Kết quả gồm bộ cài NSIS `.exe` và bản portable trong `release/`. Bản phát hành công khai cần chứng thư code-signing để tránh cảnh báo SmartScreen.

Nếu chỉ cần gói ZIP portable và đang phát triển trên Ubuntu, có thể chạy:

```bash
npm run pack:windows:zip
```

## GitHub Actions

- `.github/workflows/ci.yml`: chạy check/test desktop, test server và build thử Docker image trên push và pull request.
- `.github/workflows/docker-publish.yml`: publish multi-arch image `ghcr.io/minhit97/sqlpro-server` khi push lên nhánh mặc định hoặc tag `v*`.
- `.github/workflows/build-desktop.yml`: build installer Ubuntu/Windows trên tag `v*`, sau đó tự tạo GitHub Release và đính kèm các tệp trong `release/`.

Muốn các nút tải trên website hoạt động, cần đẩy tag phiên bản (ví dụ `v0.3.5`) lên GitHub và chờ workflow `build-desktop.yml` tạo Release thành công. Build khi push nhánh chỉ tạo artifact trong GitHub Actions, không tạo link tải công khai ổn định.

Workflow release dùng `GITHUB_TOKEN` có sẵn, không cần thêm secret. Việc publish GHCR dùng `packages: write` của token workflow.

## Phím tắt desktop

- `Ctrl+N`: kết nối mới
- `Ctrl+T`: truy vấn mới
- `Ctrl+S`: lưu truy vấn
- `Ctrl+Enter` hoặc `F5`: chạy truy vấn
- `Ctrl+Space`: mở gợi ý SQL; dùng `↑`/`↓`, `Enter` hoặc `Tab` để chọn, `Esc` để đóng
- `Ctrl+B`: ẩn/hiện cây database
- `Ctrl+O`: nhập dữ liệu từ CSV/TSV/JSON
- `Ctrl+Shift+S`: xuất dữ liệu ra CSV/TSV/JSON
- `Ctrl++` hoặc `Ctrl+=`: phóng to; `Ctrl+-`: thu nhỏ; `Ctrl+0`: cỡ mặc định
- `F11`: toàn màn hình

Ứng dụng nhớ kết nối, database, bảng đang mở, truy vấn đã lưu và lịch sử truy vấn. Nhập/xuất dùng hộp thoại tệp của hệ điều hành.

## Giới hạn dữ liệu

- Kết quả SQL tối đa 5000 dòng mỗi câu; khi chạy nhiều câu, tổng số dòng hiển thị tối đa 10000. Tối đa 100 câu SQL trong một lượt chạy.
- Nhập/xuất tệp CSV/TSV/JSON chạy theo luồng, không có giới hạn 5.000/20.000 dòng của luồng cũ; mỗi lô tối đa 200 dòng và 10.000 tham số.
- Sao lưu/phục hồi SQL không giới hạn tổng dung lượng tệp trong ứng dụng; tốc độ và kích thước mỗi câu lệnh còn phụ thuộc máy chủ và ổ đĩa.
- Sửa/xóa trực tiếp yêu cầu bảng có khóa chính.
