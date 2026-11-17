# Review đợt 10 — IN/NOT IN filters và prepared table reads

Ngày 17/11/2026. Phạm vi thay đổi sau `0c20508`: thêm toán tử `in` / `not-in` cho text/ENUM/SET/numeric/calendar trong bộ lọc bảng lồng AND/OR, giới hạn 1–20 giá trị mỗi danh sách, 100 giá trị toàn cây bộ lọc; chuyển các luồng đọc grid, count, listColumns và filtered table export sang prepared statements với parameter binding.

## Kết quả rà soát

Không tìm thấy lỗi chặn commit trong phạm vi đọc diff và kiểm thử này. Đây không phải kết luận toàn ứng dụng không còn lỗi.

- Toán tử IN/NOT IN: giữ nguyên từng giá trị, không tự trim hay split dấu phẩy; từ chối sparse array hoặc giá trị sai kiểu dữ liệu; NULL được xử lý riêng qua toán tử Là NULL / Khác NULL; preview chỉ placeholder và đếm số tham số.
- Hộp thoại bộ lọc AND/OR: thêm/xóa từng ô giá trị, phím tắt Ctrl+Enter và Escape; opt-in persistence lưu trữ chính xác cấu trúc; hỗ trợ hiển thị vừa vặn trên giao diện sáng/tối và kích thước nhỏ (940×700).
- Prepared statements: các lệnh đọc có tham số (tableData, count, listColumns) chuyển sang dùng giao thức prepared `raw(sql, params, { prepared: true })`; export có tham số chuyển sang execute stream; giải quyết triệt để lỗi escape quote/backslash dưới chế độ SQL `NO_BACKSLASH_ESCAPES`. Cache driver tối đa 64 statements / kết nối; không tự ý SET mode server.
- Chính sách an toàn: không thay đổi transaction policy, write policy hay quyền ghi; export chụp trạng thái đóng băng tại thời điểm mở.

## Kiểm chứng

- `npm run check`: 899 pass / 0 fail / 13 skip (912 tổng).
- Renderer smoke: 87/87 pass.
- Website smoke: 14/14 pass.
- Server test: 17/17 pass.
- `git diff --check`: không có lỗi thụt lề hay whitespace.

G5.4 đã có bộ lọc nâng cao, multi-sort, column visibility, preference persistence và IN/NOT IN; còn mở rộng kiểu phức tạp (JSON/spatial/binary) và rà soát prepared protocol cho toàn bộ các luồng ghi/import/metadata. Tổng G3–G9 còn 35 đầu việc lớn chưa hoàn tất. Commit local không đồng nghĩa push hoặc phát hành.
