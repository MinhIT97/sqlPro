# Review code đợt 3 — Backup automation

Ngày: 12/11/2026. Baseline: `bd0b78e`. Phạm vi: toàn bộ thay đổi sau đợt 2, gồm lịch backup interval khi app mở, tự dọn sau backup mới thành công, xuất lịch sử JSON và các regression bảo vệ dữ liệu. Chưa phải nghiệm thu phát hành.

## Phát hiện đã sửa

| Mức | Nguy cơ | Cách sửa và bằng chứng |
| --- | --- | --- |
| Cao | Profile giữ ID nhưng đổi máy chủ: auto-retention có thể coi backup trên đích cũ là cùng nguồn | Manifest mới lưu digest đích từ trusted profile; scope tự động bắt buộc cùng digest. Thiếu digest giữ lại, không suy từ ID. Test auto có target khác/thiếu; MySQL thật có bản cùng inventory nhưng target metadata khác, xác nhận giữ lại. |
| Cao | Inventory thiếu/rút gọn nhưng cùng counts có thể coi backup khác bảng/routine là bản thay thế | Kiểm tra số tên bảng/view, procedure/function và event khớp counts; routine phải đúng tiền tố và số lượng theo loại. Chặn anchor thiếu bằng chứng, bảo vệ candidate không rõ. Test empty inventory, lệch count/loại và anchor legacy. |
| Cao | Công bố bằng rename có thể ghi đè backup catalog nếu trùng ID | Catalog dùng `exclusive: true` do main quyết định, SQL và manifest công bố bằng hard link không thay tệp đã có. Gỡ tên tạm trước chụp identity; không fallback ghi đè. Test va chạm SQL/manifest, giữ byte cũ, cleanup temp và stable identity. Export người dùng chọn đích giữ overwrite hiện có. |
| Cao | Xác nhận dọn đang chờ hoặc tác vụ cũ có thể tiếp tục xóa sau logout/đóng cửa sổ | Backup generation tăng trước cleanup; native enable/apply/export kiểm tra lại sau await. Abort retention đang chạy, auto-retention nhận canceled nếu backup thủ công cũ kết thúc muộn. Dọn thủ công kiểm tra profile drift trong service trước các lần xóa. Test IPC cho pending consent, đang apply, auto sau logout và drift. |
| Vừa | Manifest quá lớn hoặc symlink được đọc trước khi snapshot từ chối | Đọc qua lstat, chỉ tệp thường tối đa 2 MiB, lỗi trả về metadata error và giữ tệp. Test oversized/symlink và nội dung đích không đổi. |

## Các ranh giới đã đối chiếu

- Scheduler reserve kỳ tiếp và task trước chạy, single-flight, cùng transfer slot; generation bảo vệ timer và danh sách chờ, không replay claim sau restart. Lỗi lưu kết quả dừng bộ chạy, không đổi backup đã ghi thành thất bại. Không có retry ghi database hoặc chạy bù hàng loạt.
- Backup dùng session riêng, chỉ lấy metadata/dữ liệu. Retention chỉ unlink SQL/sidecar trong catalog local; không gửi DROP/DELETE vào database nguồn. Apply giữ khóa, đối chiếu snapshot toàn catalog, hash anchor, kiểm tra lại trước từng lần xóa. Không đủ bằng chứng hoặc có lỗi/hủy thì dừng phần còn lại và báo phần đã xác nhận.
- Chỉ chạy tự dọn sau SQL/manifest/checksum thành công, với opt-in native; chưa xóa trước backup để lấy chỗ. Bản ghim, bản mới, anchor và scope khác được giữ. Lỗi dọn không đổi kết quả backup mới thành thất bại.
- Báo cáo JSON chỉ chọn field an toàn, không SQL/token/credential. Chặn đích bên trong userData sau realpath; ghi temp và rename. Renderer escape nội dung và kiểm tra context/identity sau await, chống gửi trùng, giữ draft khi Cancel/lỗi.

## Kiểm chứng

| Lệnh | Kết quả |
| --- | --- |
| `npm run check` | 63/63 nhóm test file qua; DB thật kiểm tra riêng bên dưới |
| `npm run test:renderer` | 55/55 qua |
| `npm run test:website` | 14/14 qua |
| `npm --prefix server run check` | Qua |
| `npm run server:test` | 17/17 qua |
| `SQLPRO_TEST_MYSQL_PORT=13317 npm run test:mysql` | MySQL 8.4 riêng, 24/24 gồm test cha, không skip; backup/restore, snapshot, guard dòng, cancel và giữ transaction Editor |
| `git diff --check` | Qua |

MySQL dùng container tmpfs riêng `sqlpro-review-batch3-20261112`, chỉ database ngẫu nhiên/tệp tạm của test. Container được dọn sau kiểm tra; không dùng database ứng dụng thật.

## Giới hạn còn lại

- Chưa kiểm chứng bộ cài Windows/Linux, MariaDB, sleep/wake trên phần cứng thật, power loss và benchmark lớn. Hard link phải được filesystem hỗ trợ; lỗi báo ra thay vì ghi đè.
- Dấu nhận diện là cấu hình đích, không phải chứng thực máy chủ vật lý: DNS/endpoint trỏ sang server khác với cùng cấu hình chưa được nhận diện bằng server UUID. Đây không phải metadata chống giả mạo; quyền filesystem và xác minh SSH/TLS vẫn cần giữ.
- Khóa chỉ trong cùng tiến trình SqlPro, vẫn có cửa sổ giữa kiểm tra identity và unlink trước thay đổi từ phần mềm ngoài. Lịch sử chưa checkpoint bền vững sau từng unlink; báo incomplete cần đối chiếu catalog, không hứa rollback hay tự phục hồi backup đã xóa.
- Checksum mới xác minh byte, không thay thế phục hồi thử. Những bản cũ thiếu source target/inventory đầy đủ được giữ; quota có thể chưa đạt. Lịch chỉ chạy khi app mở theo giờ trôi qua, chưa daily wall-time/DST/retry/OS scheduler.
