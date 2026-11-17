# Review đợt 11 — prepared statements cho toàn bộ các luồng ghi, import và metadata

Ngày 17/11/2026. Phạm vi thay đổi sau `b2b36d4`: mở rộng giao thức binary prepared statement (`prepared: true`) cho toàn bộ các luồng ghi dữ liệu (`insertRow`, `updateRow`, `deleteRows`), nhập file hàng loạt (`importFile`), và đọc metadata schema có tham số (`listTables`, `listRoutines`, `listEvents`, `listIndexes`, `listRelations`, `restoreTargetFacts`).

## Kết quả rà soát

Không tìm thấy lỗi chặn commit trong phạm vi đọc diff và kiểm thử này.

- **Toàn vẹn dữ liệu qua Binary Protocol**: Toàn bộ tham số trong các thao tác Thêm (`insertRow`), Sửa (`updateRow` - bao gồm cả câu SELECT kiểm tra xung đột `ROW_CONFLICT`), Xóa (`deleteRows` - bao gồm cả câu SELECT FOR UPDATE kiểm tra khóa gốc và câu kiểm tra engine InnoDB), và Nhập file theo lô (`importFile` - batch INSERT và ON DUPLICATE KEY UPDATE) đều được truyền trực tiếp qua giao thức binary prepared statement của MySQL/MariaDB.
- **Miễn nhiễm với SQL Mode `NO_BACKSLASH_ESCAPES`**: Loại bỏ hoàn toàn việc driver mysql2 tự ý nội suy chuỗi client-side (thay thế `'` bằng `\'` và `\` bằng `\\`), ngăn chặn triệt để lỗi cú pháp hoặc làm biến dạng dữ liệu khi chuỗi chứa dấu nháy đơn, nháy kép hoặc dấu gạch chéo ngược.
- **Bảo toàn kiểu dữ liệu và Transaction**: Giữ nguyên cơ chế ép kiểu an toàn (`coerceValue`), truyền Buffer cho BINARY/BIT/BLOB, giữ nguyên định dạng chuỗi số lớn BigInt/Decimal và DateTime; các cơ chế kiểm tra xung đột khóa gốc, rollback savepoint khi thất bại được bảo toàn 100%.
- **Phân tách giao thức rõ ràng**: Các lệnh quản trị / thiết lập phiên (`SET SESSION sql_mode`, `USE`, `SAVEPOINT`) và SQL Editor tự do của người dùng được giữ nguyên ở giao thức text query (`query`), đảm bảo tính tương thích cao và không gặp lỗi `ER_UNSUPPORTED_PS`.

## Kiểm chứng

- `npm run check`: **900 đạt / 0 lỗi / 13 skip** (913 tổng), tăng 1 test kiểm chứng toàn diện cho prepared write & metadata protocol.
- `node test/run-renderer-smoke.cjs --no-sandbox`: **87/87 pass**.
- `node test/run-website-smoke.cjs --no-sandbox`: **14/14 pass**.
- `npm --prefix server test`: **17/17 pass**.
- `git diff --check`: Không có lỗi thụt lề hoặc khoảng trắng dư thừa.
