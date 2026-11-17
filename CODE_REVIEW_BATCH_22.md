# Rà soát đợt 22 — Data Diff và ranh giới đồng bộ

Đối chiếu code sau `b5d799c`, không dùng các nhận định nghiệm thu trong đợt 17 làm bằng chứng an toàn.

## Lỗi đã xác nhận và sửa

- Hai SELECT LIMIT độc lập không chứng minh dòng vắng mặt ở toàn bảng. Code cũ vẫn sinh INSERT/UPDATE/DELETE và gọi query tuần tự, không original-value guard, snapshot hoặc transaction theo lô. Đã khóa toàn bộ generator và UI tạo/copy/tải/mở editor/thực thi SQL đồng bộ. `generateSyncSql` luôn trả blocked, không nhận cờ renderer làm quyền ghi. Giữ báo cáo quan sát chỉ đọc và ghi rõ phạm vi.
- BIGINT/DECIMAL trước đây đi qua Number nên có thể coi hai số khác nhau là bằng. Chuẩn hóa decimal bằng chữ số/exponent, từ chối JS integer đã mất chính xác và dữ liệu numeric sai. Không suy tinyint(1) chỉ có 0/1.
- JSON.parse làm mất chữ số và bỏ duplicate keys; các JSON không hợp lệ trước đây có thể cùng trở thành null và được coi bằng nhau. Parser canonical hữu hạn giữ numeric lexemes, phân biệt string/number, sort tên own keys; từ chối duplicate/invalid/quota/cycle/lossy numeric object. Tối đa 65.536 ký tự, 32 mức, 10.000 node.
- Date.parse và bỏ T/Z có thể suy múi giờ, làm mất microsecond. Temporal hiện so chuỗi SQL chính xác, không chứng nhận timezone/collation tương đương.
- Khóa ghép nối bằng `::` có thể va chạm; Map ghi đè khóa trùng hoặc bỏ qua NULL/missing. Dùng JSON tuple, từ chối khóa thiếu/NULL/trùng/unsafe number. Row/metadata shape sai làm hỏng toàn báo cáo thay vì trả kết quả thiếu; copy/freeze snapshots và kết quả.
- Dùng source metadata thật thay vì field type từ query result. Yêu cầu cùng exact names/types/order/PK ở hai bảng, không suy khóa từ flags UNI. SELECT danh sách cột và ORDER BY PK tường minh, giới hạn 200/500/1000/2000 mỗi phía; từ chối truncated/metadata mismatch. Binary/spatial/object không đủ dữ liệu bị chặn.
- Chụp scope và kiểm modal còn mở/identity/revision sau mỗi await; đổi cấu hình vô hiệu hóa báo cáo. Callback cũ không được đọc đích hoặc ghi vào modal mới. Masking áp cả unmatched rows và keys.

## Kiểm chứng

- Full check: 960 đạt, 0 lỗi, 14 fixture opt-in skip trong lệnh mặc định (974 tổng).
- Focused Data Diff: 6/6, gồm exact decimal/JSON/temporal, tuple collision, bad shapes, immutable observations và forged write flags.
- Electron workspace và Linux ASAR: 100/100; kiểm bị cắt, không suy UNI, metadata mismatch, đổi đích khi đang đọc, callback modal cũ, precision, PII, không có đường export/execution và cửa sổ nhỏ. Runtime ASAR đối chiếu source; ảnh nhỏ đã xem.
- Website 14/14; server syntax và 17/17.
- Fixture mới: 3/3 mỗi MySQL 8.4 và MariaDB 11.4 (hai subcase và parent), driver giữ DECIMAL 40,6, JSON số lớn, DATETIME microsecond; hai PK tuples từng va chạm giờ tách biệt; mẫu bị thiếu dòng không cấp quyền đồng bộ. MySQL regression đầy đủ 33/33.
- Chỉ hai container tmpfs riêng 13317/13318, schema sqlpro_diff_* có marker và schema sqlpro_test_* do integration tạo. Hai container đã dọn, không dùng DB ứng dụng.

## Chưa hoàn thành

G7.1–G7.3 mở lại: còn collector chunk/keyset và byte budgets do main sở hữu; unique key thực sự; đầy đủ binary/JSON/timezone/collation; snapshot consistency; preview token gắn scope/session/generation; drift recheck và guarded writes theo lô, báo commit khi hủy/lỗi. G7.4/G7.5 cũng chưa hoàn thành. Báo cáo hiện tại không chứng nhận toàn bảng hay cấp quyền ghi. Chưa installed Windows/Ubuntu, crash/power-loss hoặc benchmark lớn. Không push/phát hành.
