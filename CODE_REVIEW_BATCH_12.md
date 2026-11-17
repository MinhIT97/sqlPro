# Review đợt 12 — Quản lý mẫu truy vấn SQL (Snippets) và Lịch sử truy vấn nâng cao (Advanced History)

Ngày 17/11/2026. Phạm vi thay đổi sau `36ccfa9`: hoàn thành hạng mục **G5.5 (P1) Query Snippets & Advanced History** theo lộ trình sản phẩm `DATABASE_PRODUCT_ROADMAP.md`.

## Kết quả rà soát

Không tìm thấy lỗi chặn commit trong phạm vi đọc diff và kiểm thử này.

- **Kiến trúc Clean Architecture & Pure Module (`query-snippets.js`)**:
  - Đóng gói toàn bộ nghiệp vụ kiểm tra tính hợp lệ, chuẩn hóa dữ liệu, tìm kiếm đa trường, cắt tỉa lịch sử theo thời gian và ẩn dữ liệu nhạy cảm vào module thuần UMD `query-snippets.js`.
  - Không phụ thuộc vào DOM hay Node.js runtime, dễ dàng chạy đồng nhất cả ở môi trường Electron renderer lẫn server / test harness.
  - Các đối tượng trả về được `Object.freeze` để ngăn ngừa hiện tượng mutation ngoài ý muốn.
- **Bảo mật và bảo vệ dữ liệu nhạy cảm (`scrubSensitiveSql` & `hasSensitiveSql`)**:
  - Tự động nhận diện và che giấu các mật khẩu (`IDENTIFIED BY`, `SET PASSWORD`, hàm `PASSWORD(...)`) cũng như các token, API keys, chuỗi bí mật trước khi hiển thị hoặc lưu trữ khi kích hoạt tùy chọn "Ẩn thông tin nhạy cảm".
- **Thư viện Snippets phong phú & trải nghiệm chèn mượt mà**:
  - Hỗ trợ thư viện mẫu khởi tạo sẵn (`defaultSnippets`) cho các câu lệnh thông dụng: SELECT phân trang, GROUP BY tổng hợp, CTE đệ quy, Batch INSERT, EXPLAIN ANALYZE.
  - Hỗ trợ phím tắt nhanh `F2` hoặc nút `📋 Snippets` trên thanh công cụ SQL Editor.
  - Khi chèn snippet (`insertSnippetIntoEditor`), nội dung được chèn chính xác tại vị trí con trỏ (hoặc thay thế đoạn đang bôi đen) và được lưu vào ngăn xếp lịch sử Undo/Redo (`sqlEditorSnapshot` + `recordSqlEditorChange`) giúp người dùng có thể `Ctrl+Z` hoàn tác bất kỳ lúc nào.
  - Hỗ trợ lọc theo thẻ nhãn (tag pills), tìm kiếm trực tiếp theo tiêu đề, phím tắt hoặc nội dung SQL, cùng các chức năng Sao chép, Chỉnh sửa và Xóa.
- **Lịch sử truy vấn nâng cao (`renderHistoryView`)**:
  - Bộ lọc trực quan: tìm kiếm theo từ khóa trong câu SQL hoặc thông báo lỗi, lọc theo trạng thái (`Thành công` / `Lỗi`), lọc ẩn thông tin nhạy cảm.
  - Cơ chế dọn dẹp và duy trì (`pruneHistory`): tự động giữ 7 ngày, 30 ngày gần nhất hoặc xóa toàn bộ.
  - Nút hành động nhanh trên từng dòng lịch sử: Mở lại trong tab SQL (`▷ Mở`), Sao chép (`📋 Chép`), và đặc biệt là chuyển đổi nhanh một câu truy vấn trong lịch sử thành Snippet tái sử dụng (`＋ Snippet`).
- **Giao diện Responsive & Hỗ trợ Dark Theme**:
  - Bổ sung định dạng CSS tinh gọn, mượt mà cho các thẻ snippet, tag chip, khung preview code và thanh công cụ lịch sử, tương thích hoàn toàn với cả hai chế độ Sáng và Tối.

## Kiểm chứng

- `npm run check`: **907 đạt / 0 lỗi / 13 skip** (920 tổng), tăng 7 unit test cho module `query-snippets.js`.
- `node test/run-renderer-smoke.cjs --no-sandbox`: **89/89 pass** (tăng 2 UI smoke tests kiểm tra toàn bộ luồng mở modal, lọc snippet, chèn vào editor với undo, và tìm kiếm/lọc/dọn dẹp lịch sử truy vấn).
- `node test/run-website-smoke.cjs --no-sandbox`: **14/14 pass**.
- `npm --prefix server test`: **17/17 pass**.
- `git diff --check`: Không có lỗi thụt lề hoặc khoảng trắng dư thừa.
