# Rà soát chất lượng code — đợt 1

Ngày: 12/11/2026. Nền: commit `1d139d5`, workspace SqlPro 0.3.12. Phạm vi gồm các thay đổi từ cuộc trao đổi: autocomplete, backup catalog/inspection, policy chỉ đọc và Production, transaction, phục hồi thử, test và tài liệu. Đây là review trực tiếp mã và kiểm chứng bằng test, chưa có review độc lập từ người thứ hai.

## Kết luận

Đủ điều kiện tạo commit phát triển đợt 1 sau các sửa lỗi bên dưới. Không có lỗi mức nghiêm trọng/cao đã xác định nào bị để nguyên trong phạm vi review này. Kết luận không phải chứng nhận bản phát hành stable: kiểm chứng MariaDB, installed builds và tải lớn vẫn còn trong roadmap.

## Các phát hiện đã sửa

| Mã | Mức | Vấn đề trước review | Sửa và kiểm chứng |
| --- | --- | --- | --- |
| R1 | Cao | Kiểm tra scope của SET chỉ giới hạn biến đích; vế phải vẫn có thể gọi hàm hoặc SELECT ngoài phạm vi trong phục hồi thử | Trial từ chối SET có biểu thức/hàm/subquery; giữ literal và biến session cho dump. Test có `custom_write()` và subquery |
| R2 | Cao | Validator CREATE TABLE thay mọi tên quote bằng cùng placeholder và vô tình cho phép hàm quote trong DEFAULT | Chỉ nhận tên quote trước ngoặc ở vị trí index/key/referenced table; test DEFAULT hàm quote bị chặn và FK/index bình thường vẫn được nhận |
| R3 | Cao | Xem trước lại schema Production có thể đọc metadata cache cũ, không thấy DDL từ kết nối khác | Preview xóa cache cột đích và đọc metadata mới từ server trước lập plan; test stale columns |
| R4 | Cao | Session lease chống eviction nhưng không tự ngăn query khác chen vào giữa bước kiểm tra plan và ghi Production | Đặt trạng thái ghi Production và từ chối đường `withSession` trong thời gian đó; giữ lease tới khi promise thực thi kết thúc; test query chen ngang trả SESSION_BUSY |
| R5 | Vừa | Redactor dừng phân tích sau 12.000 ký tự nên không phát hiện cú pháp không thể preview ở phần cuối | Phân tích toàn SQL, chỉ cắt phần hiển thị; test executable comment sau ngưỡng hiển thị |
| R6 | Vừa | Hủy scan tới trong lúc await stat cuối vẫn có thể cache kết quả thành công | Kiểm tra cancellation sau stat, trước publish/cache; test race bằng stat bị giữ chờ |
| R7 | Vừa | Chỉ kiểm tra kích thước tệp trước copy: nguồn tăng trong lúc copy có thể vượt giới hạn trial | Transform giới hạn tổng byte thực sao chép ở 512 MiB; stream vẫn nhận AbortSignal |
| R8 | Vừa | Cleanup trial có thể chờ query không giới hạn | Thêm timeout driver 15 giây cho từng SELECT marker và DROP DATABASE; lỗi trả manual-required. Test driver nhận timeout đúng; integration cleanup thực qua |
| R9 | Vừa | Trial không bắt buộc taskId và chưa kiểm tra file identity/thời hạn sau dialog | Yêu cầu taskId hữu hạn, kiểm tra identity sau xác nhận và TTL 2 phút, từ chối sớm khi transfer đang chạy |
| R10 | Thấp | Tệp tên backup đọc không có giới hạn kích thước; lịch sử trial có thể bị hiểu như trạng thái tệp hiện tại | Giới hạn sidecar tên 4 KiB/file thường; nhãn trial nhắc chưa đối chiếu nếu checksum hiện tại chưa verified |

Các sửa R1/R2 chỉ áp dụng validator phục hồi thử mới. Không mở rộng hay thay chính sách parser restore tổng quát ngoài phạm vi đợt này.

## Kiểm chứng cuối

| Kiểm tra | Kết quả |
| --- | --- |
| `npm run check` | 52/52 nhóm test file, syntax và website generator check qua |
| Electron renderer smoke | 51/51, gồm keyboard, Production confirmation, backup progress/cancel và trial cancel |
| Website smoke | 14/14 |
| Server syntax check và server tests | Qua, 17/17 test |
| MySQL 8.4 integration thực | 21/21 gồm test cha, 20 kịch bản; không skip |
| Test tái hiện các phát hiện | SET/default function, metadata stale, query chen ngang, redact phần cuối, cancel/stat race và cleanup timeout đều qua |
| `git diff --check` | Qua |
| Cấu hình đóng gói | Module mới nằm trong `electron/**/*`, version package/lock cùng 0.3.12; chưa build/cài thử artifact |

Integration dùng container MySQL riêng, localhost:13317, data tmpfs. Không dùng container/database ứng dụng đang hoạt động. Container test được dọn sau kiểm chứng. Các log kiểm tra trong `/tmp/sqlpro-batch1-*.log` thuộc phiên phát triển, không đưa vào commit.

## Giới hạn còn lại và việc cần làm tiếp

- Phục hồi thử là bản đầu cho bảng InnoDB và INSERT literal; schema-qualified SQL khác đích, view/trigger/routine/event và một số expression bị từ chối. Verification mới đối chiếu số dòng/FK, chưa hash toàn nội dung.
- Deadline 10 phút gửi yêu cầu hủy hợp tác. Lệnh server đang chạy có thể cần thời gian dừng; cleanup có timeout từng query nhưng chưa có quy trình tự phục hồi cleanup sau app crash. Nếu ownership không xác nhận được hoặc kết nối chết, báo cáo yêu cầu dọn thủ công.
- Chưa có quota dung lượng/RAM phía server; tệp 512 MiB vẫn có thể tạo database lớn hơn. Chưa benchmark 1/10/20 GB hoặc kiểm chứng MariaDB/Windows installer.
- Quyền MySQL/MariaDB vẫn là lớp giới hạn thực thi. Policy chỉ đọc bảo vệ thao tác SqlPro; SELECT qua view/DEFINER có thể có tác động gián tiếp cần DBA quản lý.
- Kiểm tra schema trước ghi vẫn có khoảng thời gian mà DDL từ kết nối ngoài có thể xảy ra; không hứa loại bỏ mọi race phía server.
- `main.cjs` và `app.js` vẫn lớn, một số phần mới còn viết dày. Tách controller/IPC services và chuẩn hóa formatting từng module là việc bảo trì tiếp theo; không format lại toàn bộ file cũ trong commit này.
- Chưa publish hoặc push remote. Commit này đóng gói đợt phát triển đầu, không đánh dấu toàn bộ roadmap hoàn tất.

## Phạm vi commit và rollback

Commit bao gồm toàn bộ thay đổi đợt 1 liệt kê trong `git status` của workspace này, bao gồm version 0.3.12 đã có trước lượt review. Không thêm dependency, credential, file backup thật hoặc artifact kiểm thử. Rollback mã bằng revert commit; giữ nguyên user-data trước khi đổi phiên bản. Trường environment/readOnly của profile có giá trị mặc định tương thích; backup SQL cũ vẫn đọc được.
