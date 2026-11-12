# Review đợt 4 — Preview phục hồi chọn bảng

Ngày: 12/11/2026. Phạm vi: thay đổi sau `5f79200`, gồm inventory chọn bảng, đối chiếu metadata/cột đích, bản nháp kế hoạch và nhận diện INSERT literal. Đây là review cho phần chỉ đọc; chưa nghiệm thu G3.1–G3.2 hoặc phát hành bộ cài.

## Kết quả và lỗi đã sửa

| Mức | Vấn đề trước sửa | Sửa và bằng chứng |
| --- | --- | --- |
| P2 | `db:inspect-backup` có thể công bố kết quả sau logout/reset; cache và lượt quét đang chờ stat chưa được vô hiệu hóa cùng context. | Chụp scope/generation, kiểm tra sau resolve/quét. `BackupInspection.invalidate()` tăng generation, xóa cache, hủy lượt active; lượt stat đến muộn không được mở worker. Test IPC logout và service pending-stat/active/cache qua. |
| P2 | Phản hồi thành công/lỗi từ nút Hủy có thể tới sau khi tác vụ kết thúc hoặc lượt preview mới bắt đầu, rồi ghi đè status/controls của lượt mới. | Gắn phản hồi với taskId/generation/busy đã chụp; finally chỉ cập nhật nút của đúng task. Test cả cancel success/error đến muộn trong cùng modal, giữ status và nút của lượt mới. |
| P2 | `ON UPDATE` và một số thuộc tính cột không được phân tích nhưng vẫn mang `attributesKnown:true`. Metadata `EXTRA` chưa chiếu có thể đổi mà digest quan sát giữ nguyên. | Đánh dấu ON UPDATE/inline CHECK/REFERENCES nguồn và EXTRA chưa hỗ trợ ở đích là chưa phân tích; bind SHA-256 toàn EXTRA, không trả biểu thức. Unit và fixture MySQL ALTER ON UPDATE xác nhận cảnh báo, snapshot đổi, dữ liệu fixture không đổi. |

Đã kiểm tra giả thuyết lẫn metadata giữa hai schema chỉ khác hoa/thường trên MySQL 8.4 `lower_case_table_names=0`; query hiện có trả đúng schema trong fixture. Không đổi SQL filter theo giả thuyết chưa tái hiện. Case policy 1/2 được unit test; chưa kiểm chứng thực tế các cấu hình đó hoặc MariaDB.

## Các ranh giới đã rà soát

- IPC chỉ nhận scope/lựa chọn, không nhận quyền chạy, SQL kế hoạch hoặc metadata đích từ renderer. Main đọc inventory/hash và metadata bằng phiên riêng; các truy vấn metadata cố định, tên schema/bảng được bind bằng tham số.
- Target preview giữ transfer slot và khóa backup; kiểm tra profile/generation, identity nguồn, timeout/cancel trước/sau await và sau cleanup. Không dùng display cache để cho phép ghi; fresh scan vẫn dùng chung một lượt đang chạy khớp identity.
- Collector/validator mới chỉ bật trong worker đọc backup để preview. Luồng quét/restore toàn bộ mặc định tắt option này; thay đổi skip chỉ bổ sung record metadata khi collector được bật.
- Tên và nội dung nguồn/đích được escape trước HTML; có test tên quote/Unicode/HTML/prototype và phản hồi đến muộn. UI hỗ trợ Enter/Ctrl+Enter, cửa sổ 900×650 và giữ nút Đóng.
- Các giới hạn table/FK/definition/column/INSERT syntax/ledger/response được báo khi thiếu hoặc cắt. Không trả SQL text, literal dòng, giá trị default hay biểu thức generated trong bằng chứng. Digest kiểu/EXTRA đích giữ thông tin thay đổi mà không trả nội dung literal.
- Bản nháp deep-freeze tại main, luôn `blocked/canExecute:false`, không có execution token, registry hoặc API apply. INSERT matched chỉ là nhận diện grammar literal; không chứng minh conversion, quyền, constraints, default hoặc tác động trigger/FK. DROP/context/SQL chưa hỗ trợ vẫn có lý do chặn.

## Kiểm chứng trước commit

| Kiểm tra | Kết quả |
| --- | --- |
| `npm run check` | 69/69 nhóm qua |
| `npm run test:renderer` | 56/56 qua |
| `SQLPRO_TEST_MYSQL_PORT=13317 npm run test:mysql` | 27/27 qua, không skip |
| `npm run test:website` | 14/14 qua |
| `npm --prefix server run check` | Qua |
| `npm run server:test` | 17/17 qua |
| `git diff --check` | Qua |

MySQL dùng container riêng `sqlpro-review-batch4-20261112`, tmpfs/cổng loopback 13317, không dùng database ứng dụng. Fixture tạo database `sqlpro_test_*`, kiểm tra backup thật, FK/trigger, snapshot drift, DECIMAL/Unicode/binary/bit/NULL dưới mode mặc định và ANSI_QUOTES/NO_BACKSLASH_ESCAPES/STRICT_TRANS_TABLES; dữ liệu mẫu và transaction Editor giữ nguyên trong các kiểm tra preview. Container thử được dọn sau kiểm tra. Ảnh review tại `/tmp/sqlpro-review4/`.

## Phần còn lại

Chưa có thực thi phục hồi từng bảng. Còn validator CREATE/context, dependency ngoài bảng, chính sách xung đột/thay đối tượng, quyền/dung lượng, execution plan có vòng đời, recheck/native approval và kết quả partial/cancel khi ghi. Chưa kiểm chứng MariaDB, Windows, bộ cài, crash/power loss hoặc tải lớn. Kết quả review không phải cam kết không còn lỗi hoặc chứng nhận an toàn cho SQL tùy ý.

Commit đợt này được tạo local; chưa push hoặc phát hành. Các mục “chưa commit” trong phần tiến độ trước là lịch sử tại thời điểm ghi.
