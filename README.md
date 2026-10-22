# SqlPro Desktop

SqlPro là ứng dụng desktop Electron quản trị MySQL/MariaDB trên Windows và Ubuntu. Giao diện chạy trong cửa sổ native, không cần web server. Truy vấn, metadata và chỉnh sửa dữ liệu đều chạy thật trên database.

## Chức năng

- Kết nối MySQL/MariaDB qua TCP, SSL/TLS và SSH tunnel.
- Duyệt database, bảng, view; xem dữ liệu, cấu trúc, index và khóa ngoại.
- Chạy SQL, hủy truy vấn, timeout, lịch sử truy vấn.
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

## Phím tắt desktop

- `Ctrl+N`: kết nối mới
- `Ctrl+T`: truy vấn mới
- `Ctrl+S`: lưu truy vấn
- `Ctrl+Enter` hoặc `F5`: chạy truy vấn
- `Ctrl+B`: ẩn/hiện cây database
- `Ctrl+O`: nhập JSON
- `Ctrl+Shift+S`: xuất JSON/CSV
- `F11`: toàn màn hình

Ứng dụng nhớ kết nối, database, bảng đang mở, truy vấn đã lưu và lịch sử truy vấn. Nhập/xuất dùng hộp thoại tệp của hệ điều hành.

## Giới hạn dữ liệu

- Kết quả SQL tối đa 5000 dòng mỗi lần chạy.
- Xuất bảng tối đa 20000 dòng.
- Nhập JSON tối đa 5000 bản ghi mỗi lần.
- Sao lưu/phục hồi SQL tối đa 1 GB mỗi tệp.
- Sửa/xóa trực tiếp yêu cầu bảng có khóa chính.
