# SqlPro Desktop

SqlPro là ứng dụng desktop Electron quản trị MySQL/MariaDB trên Windows và Ubuntu. Giao diện chạy trong cửa sổ native, không cần web server. Truy vấn, metadata và chỉnh sửa dữ liệu đều chạy thật trên database.

## Chức năng

- Kết nối MySQL/MariaDB qua TCP, SSL/TLS và SSH tunnel.
- Workspace cá nhân để nhóm kết nối theo dự án hoặc môi trường.
- Tài khoản đồng bộ tùy chọn: đẩy connection/workspace lên server và kéo về máy khác, có mã hóa đầu cuối.
- Duyệt database, bảng, view; xem dữ liệu, cấu trúc, index và khóa ngoại.
- Chạy nhiều câu SQL phân cách bằng `;` theo thứ tự; vùng kết quả có tab **Message**, **Summary**, **Result 1**, **Result 2**… để xem từng lưới dữ liệu; hủy truy vấn, timeout, lịch sử truy vấn.
- SQL Editor gợi ý từ khóa, hàm, bảng/view và cột theo kết nối hiện tại; hỗ trợ alias bảng.
- Nhiều tab SQL Editor; mỗi tab giữ nội dung riêng khi chuyển qua lại.
- Thêm, sửa, xóa bản ghi có khóa chính; tìm kiếm và phân trang.
- Editor theo kiểu cột cho hộp thoại thêm/sửa dòng và sửa trực tiếp trong bảng/kết quả SQL: lịch DATE/DATETIME/TIMESTAMP, chọn TIME, số/YEAR, ENUM/SET, JSON và hex nhị phân. NULL/DEFAULT được chọn riêng; giữ số lớn, giây lẻ và giờ theo phiên database. Dữ liệu nhị phân chỉ có bản xem trước, cột generated và dữ liệu không gian được giữ ở chế độ chỉ đọc khi không thể sửa đầy đủ từ lưới.
- Nhập CSV/TSV/JSON và xuất CSV/TSV/JSON theo luồng, có xem trước, ánh xạ cột và hủy giữa chừng.
- Sao lưu database ra tệp `.sql` (cấu trúc bảng/view, trigger, procedure, function, event và dữ liệu) và phục hồi từ tệp `.sql`.
- Lưu mật khẩu bằng Electron `safeStorage` (OS keychain); nếu không khả dụng thì mã hóa AES-256-GCM với khóa cục bộ quyền `0600`.
- Renderer không bao giờ nhận mật khẩu đã lưu; mọi truy cập database nằm trong main process.

## Tương thích Navicat

Nhập được danh sách kết nối từ:

- `~/.config/navicat/Common/connections.json` (Navicat 16/17 trên Linux).
- Tệp xuất `.ncx`.

Các thông số được ánh xạ: host, port, username, password, database mặc định, SSL (CA/client cert/key, passphrase), SSH tunnel (password hoặc private key, passphrase). Mật khẩu Navicat v12+ được giải mã bằng AES-128-CBC trong main process. Kết nối đã nhập có thể dùng ngay mà không cần nhập lại mật khẩu.

Chọn **CONNECTIONS → ⇩** hoặc menu **Tệp → Nhập kết nối Navicat…**.

### Giới hạn tương thích

- Chỉ MySQL và MariaDB; PostgreSQL/SQL Server trong Navicat sẽ bị bỏ qua.
- Không hỗ trợ mật khẩu Navicat v11 (Blowfish) và Navicat Cloud/HTTP tunnel.
- Đường dẫn SSH private key, CA cert và client cert phải tồn tại trên máy đang chạy SqlPro.
- Mặc định không xác thực chứng chỉ SSL (giống thiết lập "weak certificate validation" của Navicat); có thể bật xác thực trong biểu mẫu kết nối.

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

Nhấp chuột phải vào nhóm **Backups** hoặc một bản backup trong cây để mở menu ngữ cảnh: tạo mới, phục hồi, xóa, xuất SQL, sao chép tên, mở thư mục chứa tệp và làm mới. Các lệnh cần một bản backup sẽ bị vô hiệu khi chưa chọn bản nào.

- Sao lưu ra tệp `.sql` gồm `CREATE TABLE`, `CREATE VIEW`, trigger (gắn với các bảng được chọn), procedure, function, event và `INSERT`; có thể chọn từng đối tượng, chỉ lấy cấu trúc hoặc kèm `DROP … IF EXISTS`.
- Procedure, function và event được lấy bằng `SHOW CREATE`, đặt trong khối `DELIMITER $$`; mặc định giữ `DEFINER`, có thể chọn loại bỏ để khôi phục trên server khác. Trigger được nhận đúng loại đối tượng khi phục hồi.
- Phục hồi chạy tệp `.sql` tuần tự vào database đang chọn. Hỗ trợ tệp do SqlPro, `mysqldump` hoặc Navicat tạo, kể cả routine/trigger dùng `DELIMITER`.
- Trong lúc phục hồi, khóa ngoại được tắt tạm thời; các lệnh `USE` và `CREATE/DROP DATABASE` trong tệp bị bỏ qua để không ghi ra ngoài database đích.
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
