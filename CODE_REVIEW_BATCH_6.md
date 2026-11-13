# Review đợt 6 — Cột bị bỏ, ngày giờ và giới hạn packet

Ngày: 13/11/2026. Phạm vi: các thay đổi sau `73d4582`, gồm omitted/default metadata, DATE/DATETIME/TIME/YEAR, kiểm tra lịch/precision TIMESTAMP và SQL bytes/max_allowed_packet trong preview phục hồi chọn bảng. Không phải nghiệm thu G3.1–G3.2 hoặc chứng nhận phát hành.

## Phát hiện và sửa

| Mức | Phát hiện | Sửa và bằng chứng |
| --- | --- | --- |
| P2 | Review giá trị có thể dùng CREATE ghi schema khác đích làm bằng chứng cột nguồn cho INSERT không ghi schema. Review cột bị bỏ đã chặn trường hợp này, nhưng value review có thể báo basic-checked. Không có đường thực thi được mở. | Ràng buộc CREATE không ghi schema hoặc đúng schema đích trước khi dùng source-column proof. Regression tái hiện basic-checked trước sửa và qua sau sửa; schema đúng đích vẫn được nhận, kiểm tra target độc lập không bị mất. |

Không phát hiện thêm lỗi chặn commit trong phạm vi đã rà soát. Điều này không có nghĩa đã chứng minh không còn lỗi.

## Ranh giới đã rà soát

- Module mới thuần, không ghi database/tệp hay thực thi SQL. Collector chỉ bật qua preview; full restore/trial và format backup giữ hành vi hiện có.
- Dữ liệu profile chỉ có counts/masks/scale/byte count, không raw literals/default expressions/calendar components/minmax/hash giá trị. Projection kiểm tra version/shape/tổng/bounds, thiếu/cũ/quá quota giữ unknown. BigInt/Unicode và ngày giờ không qua Date/locale hoặc chuyển múi giờ.
- YEAR phân biệt số 0 và chuỗi zero/năm rút gọn; TIME là duration; TIMESTAMP luôn cần bằng chứng timezone/DST/range cho giá trị khác NULL. Không tự suy thế kỷ, clip/round/truncate hoặc chấp nhận dữ liệu chỉ vì relaxed SQL mode cho lưu.
- Metadata packet đọc trong SELECT session hiện có, không thay GLOBAL/SESSION hoặc tăng 9 truy vấn. SQL byte UTF-8 khác UTF-16 length; sát ngưỡng unknown, vượt ngưỡng chặn. Không suy đủ giới hạn client/protocol/storage row.
- Omitted review đối chiếu từng INSERT, source CREATE v3/schema phù hợp và projection đích v2. Có DEFAULT không chứng minh giá trị/biểu thức; auto-increment/generated/TIMESTAMP giữ review. Quota detail không biến câu có vấn đề thành candidate.
- Report v8/plan v22/snapshot v9 bind/freeze metadata. Preview luôn blocked/canExecute:false, không executor/token/apply; giữ scope/skip/session/FK/recheck gates. Không thay transaction hoặc thiết lập Editor.
- UI escape tên/lý do, không hiển thị dữ liệu literal hoặc control ghi. Electron qua Enter, màn hình 900×650 và không có renderer exception; ảnh report ở `/tmp/sqlpro-review6/`.

## Kiểm chứng trước commit

| Kiểm tra | Kết quả |
| --- | --- |
| npm run check | 97/97 nhóm |
| npm run test:renderer | 57/57 |
| npm run test:website | 14/14 |
| npm --prefix server run check | Qua |
| npm run server:test | 17/17 |
| MySQL đầy đủ | 33/33, không skip |
| Bảy fixture preview trên MySQL 8.4 | 46/46, không skip |
| Bảy fixture preview trên MariaDB 11.4 | 46/46, không skip |
| Packet fixture 32 KiB | 6/6 mỗi engine, không skip |
| git diff --check | Qua |

Fixture dùng database tự tạo trên container tmpfs loopback riêng cổng 13317–13320; không dùng database ứng dụng. Tổng fixture hai cấu hình 52 kiểm tra mỗi engine, ngoài MySQL đầy đủ. Hai container packet đã dọn trước commit; hai container mặc định được dùng tiếp cho phần CHECK sau commit và đã dọn khi kết thúc lượt làm. Xem mục CHECK tiếp nối trong ROADMAP_PROGRESS.md.

## Giới hạn còn lại

Chưa có thực thi phục hồi chọn bảng. Còn SQL escapes/chuyển đổi/DEFAULT semantics, TIMESTAMP timezone/range, storage row/client/protocol, kiểm chứng constraints/data và dependency ngoài bảng, quyền/dung lượng và lifecycle/recheck/native approval/cancel/partial-result. Chưa nghiệm thu toàn MariaDB, Windows/installed builds, crash/power loss hoặc tải lớn. Commit local, không push/phát hành.
