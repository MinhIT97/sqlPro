# Review đợt 9 — local star autocomplete

Ngày 17/11/2026. Phạm vi thay đổi sau `99dbee3`: mở rộng tên output CTE/derived từ star đơn nguồn và qualified star trong JOIN/comma local. Không thay SQL execution, IPC, database, policy ghi hoặc định dạng lưu.

## Kết quả rà soát

Không tìm thấy lỗi chặn commit trong phạm vi đọc diff và kiểm thử này. Đây không phải kết luận toàn ứng dụng không còn lỗi.

- Chỉ lấy tên từ declaration/projection local đã biết; không đọc metadata/cache hoặc chạy thân SELECT. Mọi nguồn JOIN phải biết đủ cột; owner trùng, physical/opaque hoặc grammar chưa hỗ trợ trả toàn output chưa xác định.
- Lexical scope và vị trí declaration chặn forward/outer fallback; explicit declaration sai không fallback projection. Memo đánh null trước descent chặn vòng phụ thuộc.
- Quota giữ 64 nguồn/FROM, 64 yêu cầu star/4.096 tên copy/statement và 256 tên/output; không trả danh sách bị cắt. Qualifier exact sau alias, duplicate owner/output casefold và literal masking có regression.
- Predicate ON chỉ được nhận diện ranh giới, không được coi là kiểm chứng SQL. `*` nhiều nguồn, NATURAL/USING, correlated/LATERAL và star physical vẫn ngoài phạm vi.
- Renderer escape tên cột, giữ snapshot/caret và không thay phần SQL xung quanh; Enter và Undo được kiểm tra trong Electron với cửa sổ nhỏ.

## Kiểm chứng

- `npm run check`: 119/119 nhóm; focused local-star: 8/8 case.
- Electron workspace: 74/74; website: 14/14; server syntax và test: 17/17.
- Linux unpacked trước lượt review: 13/13 runtime file ASAR khớp workspace; ASAR renderer smoke: 74/74. Không có thay đổi runtime sau lần đóng gói đó.
- Ảnh `/tmp/sqlpro-join-star-packaged/autocomplete-local-join-star-small.png` đã được xem ở 900×650.
- `git diff --check` qua. Lượt review không chạy DB thật; native UI dùng IPC fixture. Chưa nghiệm thu installed Windows/Ubuntu, crash, tải lớn hoặc mọi SQL mode/dialect.

G5.3 vẫn một phần; còn 35 đầu việc lớn G3–G9 chưa hoàn tất. Commit local không đồng nghĩa push hoặc phát hành.
