# Review code đợt 2 — SqlPro

Ngày review: 12/11/2026. Baseline: `0fa0ab7` (đợt 1). Phạm vi: toàn bộ thay đổi đợt 2 trong workspace; chưa phải chứng nhận phát hành.

## Phạm vi triển khai

- Journal mã hóa cho schema phục hồi thử bị bỏ lại; dọn qua xác nhận native, kiểm tra đích và ownership marker, dùng phiên DB riêng.
- Ghi chú/ghim backup, tương thích tên cũ và giữ metadata khi sao chép; chặn xóa bản ghim tại catalog service.
- Retention planner, chính sách riêng theo profile/database, token một lần + TTL, snapshot tệp, xác minh bản giữ lại, dọn thủ công có xác nhận và báo phần đã xóa.
- Tiến độ/hủy theo task, lịch sử local có giới hạn, phân biệt báo cáo chưa kết thúc sau gián đoạn.

## Các lỗi đã sửa trong lượt review

| Mức | Phát hiện | Sửa và bằng chứng |
| --- | --- | --- |
| Cao | Rename/delete lấy lại profile/database/selection sau khi chờ dialog, có thể tác động sai đích nếu context đổi | Chụp ID/profile/database trước await, kiểm tra context và identity input trước/sau IPC; chặn double-submit rename. `renderer-backup-context.test.cjs` kiểm tra đổi database, selection và dialog mới. |
| Cao | Copy công bố bằng rename có thể thay SQL/metadata của một backup trùng ID | Công bố SQL và metadata bằng hard link không thay tệp đã tồn tại; chỉ dọn metadata do lượt copy hiện tại đã tạo. Test cố tình tạo va chạm ở hai điểm công bố, xác nhận tệp/ghim cũ được giữ nguyên. |
| Cao | Profile đổi sang chỉ đọc trong lúc trial connect vẫn có thể tiếp tục tạo schema | Kiểm tra lại policy và fingerprint ngay sau connect; test main thay readOnly trong connect và xác nhận session đóng trước restore/journal. |
| Vừa | Các preview retention chạy chồng, tăng tải filesystem và có thể vô hiệu token của lượt mới hơn | Chỉ nhận một preview đang chạy trong service; nhả admission trong finally. Test concurrent request và lượt kế tiếp. |
| Vừa | Giới hạn catalog kiểm tra sau khi đã đọc metadata tất cả backup | Catalog nhận maxEntries; snapshot retention áp giới hạn 2.000 trước đọc metadata. Test quota vượt giới hạn với số lần readFile bằng 0. |
| Vừa | Lookup recovery trả chậm có thể thay modal mới đang chứa draft | Render vùng loading riêng, kiểm tra identity và profile sau await; test response muộn không mở lại modal. |
| Vừa | History cho phép trạng thái completed hoặc sqlDeleted mâu thuẫn danh sách kết quả | Kiểm tra độ phủ planned = deleted + remaining cho báo cáo cuối, tính nhất quán state và sqlDeleted; sai thì giữ record đang chạy và báo lỗi. |
| Vừa | Policy load chậm có thể bật lại nút sửa chính sách trong lúc apply, làm mất kết quả do generation đổi | Không bật controls khi busy; chặn policy write lúc preview/apply; phục hồi controls sau finally. Test load chậm trong apply. |
| Thấp | Date.parse nhận số và có thể coi metadata ngày không đúng kiểu là một ngày cũ hợp lệ | Planner chỉ nhận createdAt dạng chuỗi; kiểu khác được bảo vệ với invalid-date. |

## Kiểm tra

| Kiểm tra | Kết quả trong lượt review |
| --- | --- |
| `npm run check` | Qua 59/59 nhóm test file, gồm các regression mới; test MySQL thực vẫn opt-in riêng |
| `npm --prefix server run check` | Qua |
| Syntax các module mới và renderer smoke script | Qua |
| `git diff --check` | Qua |
| Electron smoke | Chưa chạy: automatic approval review từ chối thực thi vì refresh token bị thu hồi |
| Website/server smoke ngoài sandbox | Chưa chạy lại do cùng điều kiện duyệt quyền chưa được khôi phục |
| MySQL 8.4 integration | Chưa chạy lại trong review này; 22/22 ở lượt triển khai journal là bằng chứng lịch sử, không phải kết quả mới |
| MariaDB, installed Windows/Linux, benchmark lớn | Chưa kiểm chứng |

Lỗi duyệt quyền là lỗi xác thực của môi trường, không phải kết luận thao tác không an toàn. Cần đăng xuất/đăng nhập lại trước khi chạy các kiểm tra ngoài sandbox. Không dùng smoke đợt cũ để khẳng định UI đợt 2 đã qua.

## Giới hạn còn lại

- Còn cần Electron/website/server smoke và MySQL integration tại revision chốt trước khi phát hành. Chưa build installer hoặc push.
- Copy yêu cầu filesystem hỗ trợ hard link trong cùng thư mục; filesystem không hỗ trợ sẽ báo lỗi và giữ bản nguồn. Chưa kiểm chứng trên Windows hoặc volume ngoài. Không fallback sang ghi đè tệp đã tồn tại.
- Khóa catalog chỉ bảo vệ trong cùng tiến trình SqlPro; không loại trừ hoàn toàn thay đổi từ chương trình khác giữa stat và unlink. Không xem SQL filter/trial như sandbox chống mọi tác động gián tiếp của server.
- Journal ownership không bảo đảm tự dọn nếu crash sau CREATE trước marker; trường hợp đó vẫn cần DBA kiểm tra. Mất userData/khóa có thể mất khả năng nhận diện.
- Retention/history ghi atomic nhưng chưa có checkpoint bền vững mỗi unlink hoặc kiểm chứng mất điện. Báo cáo incomplete cần đối chiếu catalog; không tự tiếp tục xóa hoặc hứa rollback các bản đã xóa.
- Retention còn dọn thủ công; chưa scheduler, tự dọn sau backup mới hoặc benchmark catalog/dữ liệu lớn. Code orchestration/view trong main/app vẫn cần tách tiếp theo roadmap; không coi G2/G3/G8 đã hoàn tất.

Thông điệp commit đợt 2: `feat: complete SqlPro batch 2 backup retention and recovery`.

Trạng thái chốt: đã tạo commit local gồm 31 tệp, chưa push. Lượt thử trước bị chặn bởi filesystem chỉ đọc và lỗi refresh token của automatic approval review; lượt commit tiếp theo đã được thực thi thành công. Các giới hạn kiểm chứng ở bảng trên vẫn còn hiệu lực.
