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
- Nhập/xuất JSON, xuất CSV.
- Sao lưu database ra tệp `.sql` (cấu trúc bảng/view, trigger và dữ liệu) và phục hồi từ tệp `.sql`.
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

Website tĩnh nằm trong `website/`, được server Express phục vụ tại `/`, không cần bước build và không dùng CDN. Nội dung gồm tính năng, mô hình mã hóa, workspace, hướng dẫn tự host, FAQ và liên kết tải bản phát hành mới nhất.

Quy ước kiến trúc, design pattern và chuẩn code của dự án được ghi trong [`agent.md`](agent.md).

## Sao lưu và phục hồi

Chọn database trong thanh bên rồi dùng **⇩ Sao lưu** / **⇧ Phục hồi**, hoặc menu **Tệp → Sao lưu database… / Phục hồi database…**.

- Sao lưu ra tệp `.sql` gồm `CREATE TABLE`, `CREATE VIEW`, trigger (gắn với các bảng được chọn) và `INSERT`; có thể chọn từng bảng/view, chỉ lấy cấu trúc hoặc kèm `DROP … IF EXISTS`.
- Phục hồi chạy tệp `.sql` tuần tự vào database đang chọn. Hỗ trợ tệp do SqlPro, `mysqldump` hoặc Navicat tạo, kể cả trigger dùng `DELIMITER`.
- Trong lúc phục hồi, khóa ngoại được tắt tạm thời; các lệnh `USE` và `CREATE/DROP DATABASE` trong tệp bị bỏ qua để không ghi ra ngoài database đích.
- Tùy chọn **Xóa bảng/view/trigger trùng tên** sẽ bỏ đối tượng cũ trước khi tạo lại. Mặc định tắt để tránh mất dữ liệu ngoài ý muốn.
- Procedure, function và event chưa được sao lưu; có thể thêm thủ công vào tệp `.sql` nếu cần.
- Tệp sao lưu/phục hồi giới hạn 1 GB. Chỉ phục hồi tệp bạn tin cậy vì nội dung tệp có thể thay đổi dữ liệu.

## Chạy khi phát triển

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

Workflow release dùng `GITHUB_TOKEN` có sẵn, không cần thêm secret. Việc publish GHCR dùng `packages: write` của token workflow.

## Phím tắt desktop

- `Ctrl+N`: kết nối mới
- `Ctrl+T`: truy vấn mới
- `Ctrl+S`: lưu truy vấn
- `Ctrl+Enter` hoặc `F5`: chạy truy vấn
- `Ctrl+Space`: mở gợi ý SQL; dùng `↑`/`↓`, `Enter` hoặc `Tab` để chọn, `Esc` để đóng
- `Ctrl+B`: ẩn/hiện cây database
- `Ctrl+O`: nhập JSON
- `Ctrl+Shift+S`: xuất JSON/CSV
- `Ctrl++` hoặc `Ctrl+=`: phóng to; `Ctrl+-`: thu nhỏ; `Ctrl+0`: cỡ mặc định
- `F11`: toàn màn hình

Ứng dụng nhớ kết nối, database, bảng đang mở, truy vấn đã lưu và lịch sử truy vấn. Nhập/xuất dùng hộp thoại tệp của hệ điều hành.

## Giới hạn dữ liệu

- Kết quả SQL tối đa 5000 dòng mỗi câu; khi chạy nhiều câu, tổng số dòng hiển thị tối đa 10000. Tối đa 100 câu SQL trong một lượt chạy.
- Xuất bảng tối đa 20000 dòng.
- Nhập JSON tối đa 5000 bản ghi mỗi lần.
- Sao lưu/phục hồi SQL tối đa 1 GB mỗi tệp.
- Sửa/xóa trực tiếp yêu cầu bảng có khóa chính.
