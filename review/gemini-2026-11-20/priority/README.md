# Gói ưu tiên dữ liệu — 20/11/2026

Baseline `3b5fab5`, working tree gồm cả R20 trước đó; chưa commit hoặc phát hành.

- Node: 1.328 tổng, 1.302 pass, 0 fail, 26 DB opt-in skip.
- Electron: 113/113 ở cả lượt thường và chụp ảnh. Website 14/14, server 17/17, server syntax đạt.
- Database: 328/328, 0 fail, 0 skip. MySQL 153, MariaDB 120, regression N/D/E/F + encrypted restore cả hai engine 49, packet 32 KiB 6. Không cộng số này với Node để suy số test duy nhất.
- Linux unpacked tạo bằng `npm run pack:dir -- --linux --config.directories.output=/tmp/sqlpro-priority-package`; 12 file ASAR mới/sửa khớp byte nguồn. Chưa kiểm installer/upgrade Windows hoặc Ubuntu installed.
- Ảnh daily: cửa sổ 900×650, nút lưu vào viewport sau cuộn, focus input thời gian, không tràn ngang. Lịch HH:mm/IANA, DST gap bỏ qua/fold hai lần, app phải mở.

## Tái chạy database

Dùng riêng ba server loopback disposable: MySQL 8.4.13, MariaDB 11.4.13, MySQL packet 32768 byte; root không mật khẩu, schema random/tạm được test tự tạo và dọn. Không dùng dữ liệu vận hành. Cổng phiên này 32768/32769/32770; không mặc định các cổng này cho máy khác. Container/datadir tmpfs riêng ghi trong `db-environment.log`, đã dọn ba container và anonymous volumes trong `db-cleanup.log`.

```bash
SQLPRO_REVIEW_MYSQL_PORT=<mysql-test-port> SQLPRO_REVIEW_MARIA_PORT=<maria-test-port> SQLPRO_TEST_PACKET_PORT=<packet-test-port> npm run test:data-safety
```

Lượt cuối đặt thêm `SQLPRO_RESTORE_TEST_SOCKET=/tmp/sqlpro-unused-fixture.sock` để chứng minh runner bỏ socket kế thừa và dùng đúng cổng. Không skip khi một suite được bật mà không thực thi; runner yêu cầu 0 skip/0 fail và tests > 0.

## Lượt fixture sai giữ làm bằng chứng

- `initial-mysql-fixture.log`/`initial-mariadb-fixture.log`: index capability lúc đầu đặt sai `mysql`/`mariadb`, test cần `mysql-visible`/`mariadb-ignored`. Đã sửa runner, giữ assertion, chạy lại đủ matrix.
- `initial-encrypted-ssl-fixture.log`: fixture truyền cấu trúc SSL của profile app trực tiếp cho mysql2, bị hiểu là bật TLS. Chuyển admin fixture sang config driver host/port/user, không sửa TLS runtime. Roundtrip cuối ở matrix đạt, kiểm marker ngoài phạm vi và BIGINT/Unicode.
- Lượt unit đầu sau thêm daily có bốn lỗi fake DOM thiếu input mới. Đã thêm element vào fixture và thêm test daily; không bỏ bốn ca cũ. Log cuối và focused unit có trong thư mục này.
- X11 atom-cache warning trong Electron là thông báo môi trường; assertion không có renderer exception/unhandled rejection đạt.

## Ranh giới nghiệm thu

Data Diff chỉ đọc, tối đa 2.000 dòng/phía, PK số exact; snapshot InnoDB riêng từng phía, không chung cùng thời điểm liên server. Public Migration/Sync Apply giữ khóa theo agent.md.

Crypto UI tạo archive riêng, giải mã xác thực xong tạo SQL ID mới, không tự restore, giữ SQL gốc. Bản giải mã chưa manifest/trial; archive chưa thuộc retention. Sai mật khẩu/tag/quota/hủy/drift không publish SQL. Có quota 10 GiB/10 phút, không hứa temp sau crash đã được xóa an toàn. Encrypted manifest/metadata/trial, quản lý archive, remote replica, recovery, OS scheduler, tải lớn và installed/security/UAT vẫn còn.
