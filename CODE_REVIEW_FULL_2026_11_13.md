# Rà soát SqlPro sau đợt 4

Ngày chốt: 13/11/2026. Baseline: `9431b98`. Các bản sửa của lượt này được chốt thành commit local; tra git log để đối chiếu. Chưa push/phát hành.

## Kết quả

Xác nhận và sửa 7 nhóm lỗi ứng dụng cùng một lỗi fixture kiểm thử. Mức ưu tiên dưới đây phản ánh tác động có thể xảy ra trước sửa; không có bằng chứng dữ liệu người dùng đã bị ảnh hưởng. Không chạy thao tác thử trên database thật.

| Mức | Lỗi đã xác nhận | Cách sửa và bằng chứng |
| --- | --- | --- |
| P1 | Cache cột/index/PK ghép bằng dấu chấm làm `a.b`/`c` trùng `a`/`b.c`, có thể lấy metadata khóa chính của bảng khác. Cache autocomplete còn lowercase toàn key nên lẫn bảng khác hoa/thường. | Dùng tuple JSON, giữ exact case và cập nhật invalidation. Unit main/renderer kiểm tra hai identity riêng; fixture MySQL tạo hai schema/bảng có dấu chấm, đọc đúng cột/index rồi UPDATE đúng bảng, bảng còn lại giữ nguyên. |
| P1 | Các tab cùng profile có thể gửi SQL/USE trong lúc thao tác ghi đang await metadata hoặc trong bước bind database trước khi activeTask xuất hiện. COMMIT chen vào có thể phá phạm vi transaction của thao tác. | Lease độc quyền cho SQL/row writes/USE bao trùm chuẩn bị và thực thi; trả SESSION_BUSY khi tranh chấp và giải phóng khi lỗi. Regression trì hoãn delete/useDatabase, xác nhận SQL/USE cùng phiên không chạy, profile khác vẫn dùng được và gate được giải phóng. |
| P1 | Đồng bộ đổi host/credentials nhưng registry vẫn tái sử dụng socket cũ, làm đích thực tế lệch cấu hình đang hiển thị và kiểm tra policy. | Gắn fingerprint trusted vào phiên, đối chiếu khi connect/tái dùng/acquire/Commit; socket mở giữa lúc cấu hình đổi được đóng. Giữ phiên cũ, chặn chạy tiếp và yêu cầu reconnect chủ động; không tự commit/rollback. Regression xác nhận đổi đích bị chặn, đổi tên/policy vẫn áp dụng đúng, Rollback đúng sessionId/revision còn dùng được khi profile bị đồng bộ xóa. |
| P1 | DELETE dùng SELECT FOR UPDATE rồi DELETE theo PK nhưng chưa từ chối MyISAM; engine này không bảo đảm khóa dòng/rollback cho contract đó. Mảng originalValues thiếu mục vẫn có thể làm một phần yêu cầu không được đối chiếu gốc. | Từ chối snapshot thiếu/null/sai dạng; sau locking read, kiểm tra engine dưới phạm vi transaction trước DELETE, chỉ chấp nhận InnoDB. Regression kiểm tra không gửi DELETE trên engine khác/không xác định; fixture MySQL MyISAM xác nhận dòng còn nguyên. Giữ savepoint cho transaction của người dùng. |
| P2 | resolveConflicts gọi runSync ngoài inflight nên có thể chạy đồng thời với lượt sync tự động, cùng dùng revision/base/store. | Dùng chung startSync/inflight; conflict resolution đang bận trả SYNC_BUSY, syncNow gộp vào lượt resolution đang chạy. Regression trì hoãn GET và đếm request trong cả hai hướng. |
| P2 | Phản hồi sync thiếu Content-Length được đọc hết bằng response.text() rồi mới kiểm tra byte, khiến giới hạn không ngăn được body lớn chiếm bộ nhớ. | Đọc stream có ngân sách byte, hủy khi vượt/lỗi, giải phóng reader; ghép trong quota rồi decode UTF-8. Regression body chunked dừng tại chunk vượt ngân sách, header quá lớn bị hủy và Unicode tách giữa chunk giữ đúng. Lỗi đọc không lộ raw error. |
| P2 | Thanh transaction dùng `state?.profileId === profileId && state.connected`; khi cả hai profileId đều undefined, nhánh sau vẫn truy cập state chưa tồn tại. | Kiểm tra state.connected bằng optional chaining trước. Lỗi được phát hiện trong Electron smoke, tái hiện bằng unit cho null/undefined ở cả chế độ query/data rồi sửa. |

Lỗi fixture: `backup-retention-apply.test.cjs` tạo manifest bằng ngày thực nhưng planner dùng clock cố định 12/11/2026. Sang 13/11, mọi backup bị giữ vì ngày tương lai, kéo theo 9 test thất bại. Cố định createdAt của manifest fixture tháng 1–3 cùng clock test; giữ nguyên logic ứng dụng bảo vệ ngày bất thường. Nhánh thay anchor để kiểm tra hủy hash cũng dùng ngày cố định.

## Phạm vi rà soát

- Đọc các luồng chính tại app.js, main/preload/session registry/database, metadata/CRUD/transaction, store/sync/crypto, backup catalog/manifest, retention thủ công/tự động, lịch backup, preflight/restore preview và auth/vault server. Chạy các bộ kiểm tra hiện có và bổ sung regression cho lỗi tái hiện được; không coi đây là chứng minh hình thức cho mọi dòng mã.
- Kiểm tra ranh giới renderer/main, trusted profile và secret, async admission/context, token/TTL/recheck, cleanup/cancel và tác động ghi. Không thêm API thực thi phục hồi chọn bảng; bản nháp vẫn blocked/canExecute:false.
- Không sửa dữ liệu local của người dùng, chính sách retention hay cấu hình kết nối thật. Tất cả SQL thử ghi chạy trong database fixture `sqlpro_test_*` do test tạo trên MySQL tạm cổng loopback 13317.

## Kiểm chứng

Kết quả dưới đây là lượt cuối sau sửa; không lấy lượt đỏ hoặc lượt bị chặn làm bằng chứng đã qua.

| Kiểm tra | Kết quả |
| --- | --- |
| `npm run check` | 70/70 nhóm qua |
| `npm run test:renderer` | 56/56 qua, không có renderer exception/unhandled rejection |
| `SQLPRO_TEST_MYSQL_PORT=13317 npm run test:mysql` | 29/29 qua, không skip |
| `npm run test:website` | 14/14 qua |
| `npm --prefix server run check` | Qua |
| `npm run server:test` | 17/17 qua |
| `git diff --check` | Qua |

MySQL 8.4 dùng container `sqlpro-full-review-20261113`, tmpfs riêng. Lượt đầu chưa có container báo ECONNREFUSED; sau khi tạo và xác nhận sẵn sàng đã chạy đủ 29 kiểm tra. Lần chạy bị hệ thống duyệt chặn ở lượt trước không thực thi; lượt tiếp tục ngày 13/11 đã được duyệt. Unit regression có lượt đỏ trước sửa cho các lỗi đã tái hiện; Electron cũng bắt được lỗi state chưa tồn tại trong lượt chạy lại.

Container thử đã dừng và tự xóa sau kiểm chứng (`--rm`); không giữ MySQL thử chạy nền.

## Giới hạn còn lại

- Chưa kiểm chứng MariaDB, Windows, bộ cài, tải lớn, sleep/wake thực tế hoặc crash/mất điện ở mọi điểm. Không kết luận ứng dụng hết lỗi hoặc bảo đảm không mất dữ liệu trong mọi tình huống.
- Chỉ kiểm tra engine của bảng bị DELETE; trigger/routine có thể tác động gián tiếp lên engine khác. SQL tùy ý vẫn phụ thuộc quyền, cấu hình và transaction semantics phía server.
- Fingerprint kiểm tra cấu hình lưu trong profile; chưa theo dõi thay đổi nội dung tệp cert/private key tại cùng đường dẫn hoặc DNS phía ngoài. Không tự chuyển transaction đang mở sang đích mới.
- Cache metadata chưa theo dõi mọi DDL do chương trình khác thực hiện. TTL/invalidation hiện có không phải snapshot schema nguyên tử.
- Phục hồi chọn bảng vẫn chưa thực thi; các hạng mục chưa nghiệm thu trong DATABASE_PRODUCT_ROADMAP.md giữ nguyên.
