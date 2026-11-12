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
- SQL Editor gợi ý từ khóa, hàm, bảng/view và cột theo kết nối hiện tại; hỗ trợ alias bảng.
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

Sửa/xóa dòng từ lưới đối chiếu giá trị gốc để phát hiện xung đột; text phân biệt hoa/thường/dấu/khoảng trắng, JSON được so sánh như document và BLOB preview dùng hash của toàn bộ byte. Khi thiếu dữ liệu gốc đầy đủ, thao tác báo lỗi và giữ nội dung nhập. Xóa trong phiên có transaction hoặc autocommit tắt dùng savepoint, không tự commit thay người dùng; cần Commit/Rollback theo luồng SQL của phiên.

### Giới hạn của chế độ chỉ đọc

Đây là lớp bảo vệ thao tác trong SqlPro, không phải sandbox SQL hay thay thế phân quyền phía server. Nên dùng tài khoản database có quyền tối thiểu và kiểm tra quyền/DEFINER của view, routine và UDF, vì câu SELECT có thể gọi mã phía server một cách gián tiếp.

Chế độ này cho phép SELECT thông thường, CTE SELECT cơ bản, một số hàm dựng sẵn, SHOW/DESCRIBE, EXPLAIN SELECT, USE và ROLLBACK. Câu ghi, locking read, INTO OUTFILE/DUMPFILE, executable comment, EXPLAIN ANALYZE, hàm tùy biến hoặc cú pháp chưa nhận diện sẽ bị từ chối trước khi chạy batch. Chuỗi có backslash bị từ chối để tránh đoán sai SQL mode; có thể dùng dấu nháy đơn lặp đôi khi phù hợp. Kết nối không bật chỉ đọc giữ hành vi SQL hiện có.

Không thể sửa cấu hình kết nối khi có transaction, autocommit OFF hoặc tác vụ đang chạy. Kết thúc transaction và bật lại autocommit trước khi lưu; ứng dụng không tự rollback để đổi cấu hình.

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
