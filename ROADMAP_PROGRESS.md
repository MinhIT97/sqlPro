# Tiến độ roadmap SqlPro

Cập nhật: 12/11/2026. Đối chiếu `DATABASE_PRODUCT_ROADMAP.md`. Đợt 1 và đợt 2 (`bd0b78e`) đã có commit local; chưa phát hành. Xem git log và báo cáo review bên dưới.

## 12/11 — Review trước commit đợt 3

- Phạm vi sau `bd0b78e`: export JSON lịch sử, auto-retention và scheduler interval MVP. Báo cáo: `CODE_REVIEW_BATCH_3.md`.
- Sửa nguy cơ tự xóa backup khác máy chủ khi profile giữ ID nhưng đổi host/SSH/TLS/user: manifest version 1 mới lưu source target digest từ profile trusted; auto-retention bắt buộc cùng digest. Manifest cũ thiếu field vẫn đọc bình thường nhưng không tự xóa, phải đối chiếu/dọn thủ công nếu cần. Inventory bảng/view/routine/event phải khớp counts; thiếu danh sách hoặc sai loại routine không đủ bằng chứng thay thế bản cũ.
- Backup catalog ghi độc quyền SQL và manifest, không ghi đè khi ID trùng; export người dùng chọn đường dẫn giữ hành vi ghi thay hiện có. Test collision kiểm tra cả nội dung cũ và cleanup temp; MySQL chạy nhánh exclusive và xác minh anchor sau công bố. Manifest đọc giới hạn 2 MiB, không theo symlink; lỗi metadata giữ tệp và chặn tự dọn.
- Logout/đóng cửa sổ tăng backup generation, vô hiệu native consent còn chờ (enable policy, apply retention, export history), abort hash/dừng dọn giữa tệp và ngăn auto-retention sau backup thủ công cũ vừa kết thúc. Dọn thủ công kiểm tra profile drift trong apply, cùng cơ chế auto. Backup nguồn dùng phiên riêng, không đổi transaction Editor.
- Kiểm chứng lại: check **63/63 nhóm**, Electron **55/55**, website **14/14**, server **17/17**, server syntax và diff qua; MySQL 8.4 tmpfs riêng **24/24**, không skip, thêm bản cùng inventory nhưng khác target metadata để xác nhận giữ lại. Chỉ dùng DB/tệp tạm do test tạo. Chưa build installer, chưa kiểm chứng MariaDB/Windows/mất điện/thay đổi tệp từ phần mềm ngoài; không coi test xanh là bảo đảm tuyệt đối không mất dữ liệu.

## 12/11 — Lịch backup khi ứng dụng đang mở (MVP)

- Backups có **Lịch backup…**: chu kỳ 1–168 giờ, lần đầu trong tương lai tối đa 366 ngày, lưu/bật bằng Ctrl+Enter qua xác nhận native mặc định Hủy; tạm dừng, xóa lịch và cập nhật trạng thái. Xóa lịch giữ backup. Mỗi profile/database một lịch, tối đa 50 lịch local; chưa sync qua vault. Giao diện giữ draft khi Cancel/lỗi, chặn double-submit và phản hồi muộn vào modal/context mới; refresh chỉ cập nhật trạng thái, giữ input.
- `backup-scheduler.cjs` lưu version 1, whitelist dữ liệu không chứa credential/SQL, giới hạn 256 KiB, từ chối symlink/hỏng/version lạ và giữ tệp nguồn. Ghi temp 0600, sync rồi rename. Claim và kỳ tiếp theo ghi trước tác vụ; single-flight và transfer slot chung chống trùng. Đọc lại lịch sau await, kiểm tra generation stop/restart, không chạy sớm khi đồng hồ lùi. Chưa có khóa liên tiến trình hoặc bảo đảm mất điện ở mọi điểm.
- Mỗi lượt dùng `runCatalogBackup` và một DatabaseSession riêng, tải danh sách bảng/view/routine/event tài khoản nhìn thấy (tối đa 2.000 mỗi nhóm), giữ manifest/checksum và auto-retention hiện có. Không thay TLS/SSH để bỏ qua xác minh. Đối chiếu target identity trước connect và sau chuẩn bị; thay đích làm tắt lịch, phải lưu lại để chấp thuận. Pause hủy đúng task; không commit/rollback phiên SQL Editor. Đóng cửa sổ/logout dừng runtime; reset tắt cấu hình đã lưu. Native consent đang chờ bị vô hiệu khi logout/reset.
- Tick khoảng 15 giây, grace 60 giây: bận thì đợi trong grace, quá hạn thì busy/missed và chuyển kỳ tương lai; không catch-up hoặc retry tự động. Interval là giờ trôi qua, UTC lưu trữ và timezone nhập/hiển thị; không hứa cùng giờ địa phương qua DST. Restart chuyển running thành incomplete, không phát lại claim. Lỗi ghi kết quả dừng scheduler, giữ running làm bằng chứng chưa kết thúc thay vì gán backup thất bại; bật lại/restart recover thành incomplete. Không tự tiếp tục retention bị gián đoạn.
- UI xem lần tiếp theo, lần gần nhất, backup ID và warning manifest/retention riêng với kết quả backup. Thanh trạng thái báo kết thúc backup nền; scheduler chưa đưa vào tab Tác vụ database. Giới hạn này được ghi trong README.
- Kiểm chứng: check **63/63 nhóm**, Electron **55/55** (bàn phím, Cancel, lưu/mở lại/pause/delete, progress kết thúc), website **14/14**, server **17/17**, syntax/diff qua. MySQL 8.4 tmpfs riêng **24/24** không skip, có backup bảng/view/procedure/event và giữ transaction Editor. Test unit thêm busy/grace/missed, scope/revision, giới hạn, metadata hỏng, atomic failure, DST interval, clock lùi, restart, stale queued work, timer generation và lỗi lưu kết quả. Ảnh giao diện đã kiểm tra tại `/tmp/sqlpro-schedule-review/backup-schedule.png`.
- G3.3 mới một phần: còn daily wall-time/DST policy, retry/backoff, scheduler hệ điều hành, tab tiến độ nền và kiểm chứng sleep/wake thực tế, MariaDB/Windows/bộ cài/power loss. G3/G4–G9 vẫn chưa nghiệm thu toàn nhóm. Phần tiếp theo ưu tiên phục hồi đối tượng được chọn và dependency (G3.1–G3.2). Lịch, auto-retention và export sau `bd0b78e` được rà soát trong đợt commit 3; tra git log để đối chiếu commit.

## 12/11 — Tự dọn sau backup mới thành công

- Công cụ retention có checkbox **Tự dọn sau khi backup mới thành công**, mặc định tắt. Chính sách version 1 cũ không có field mới vẫn được đọc thành tắt. Bật hoặc sửa giới hạn của chính sách đang bật cần xác nhận native mặc định Hủy, ghi rõ các lần backup sau sẽ áp dụng không hỏi lại. Tắt hoặc xóa chính sách không xóa backup; không cho thay chính sách giữa tác vụ database.
- Main chụp chính sách trước khi backup, chỉ gọi auto-retention sau `saveBackupFile` thành công. Thiếu/lỗi manifest, checksum chưa verified, hủy hoặc scan đang dùng backup thì không tự dọn. Lỗi đọc chính sách hoặc dọn không biến backup mới đã lưu thành thất bại; trả kết quả retention riêng, renderer báo backup đã ghi cùng kết quả dọn. Backup lỗi/disk full không kích hoạt xóa cũ.
- `backup-retention-auto.cjs` dùng planner/token/snapshot/khóa và hash lại bản giữ của service hiện có. Yêu cầu backup vừa tạo là bản mới nhất và latest-verified, không tự chọn một backup cũ khác làm căn cứ. Candidate tự động chỉ cùng profile/database, cùng cấu trúc/dữ liệu/DROP/DEFINER, cùng danh sách bảng/routine/event và số đối tượng; metadata thiếu hoặc danh sách có thể bị cắt thì giữ lại. Bản cũ toàn DB không bị xóa vì một backup mới chỉ chọn một bảng. Phạm vi khác vẫn tính trong tổng quota nên có thể chưa đạt giới hạn.
- Transfer slot được giữ qua bước dọn, operation chuyển sang retention để cancel abort hash và dừng trước tệp tiếp theo; tiến độ backup báo đang tự dọn. Profile/chính sách hoặc scan thay đổi được kiểm tra lại trước và trong apply, dừng phần còn lại với báo cáo từng tệp. Lịch sử có `mode: automatic` và `triggerBackupId`; bản mới không nằm trong planned deletes. Record lịch sử cũ mặc định manual, báo cáo JSON giữ các field mới.
- Check 61/61 nhóm; Electron 54/54, website 14/14, server 17/17, server syntax/diff qua. MySQL 8.4 tmpfs riêng 23/23 không skip, gồm backup thực rồi tự dọn đúng scope và kiểm tra nguồn không đổi; container đã dọn. Test bổ sung migration opt-in, native Cancel/enable/disable, không chạy trước backup thành công, scope/pin/metadata, lỗi history, policy đổi sau một lần xóa và renderer phân biệt lỗi dọn với backup thành công.
- G3.4 tiến thêm một phần, chưa đánh dấu hoàn tất: chưa kiểm chứng mất điện/crash ở mọi điểm, Windows file locking, quota tải lớn hoặc phục hồi sidecar mồ côi. Cấu hình chỉ lưu máy này; không chạy lại việc dọn bị gián đoạn khi mở ứng dụng. Ban đầu áp dụng sau nút tạo backup; lịch MVP bổ sung ở mục mới nhất phía trên. Chưa áp dụng khi copy/import/restore backup. Thay đổi chưa commit.

## 12/11 — Hoàn tất kiểm chứng đợt 2 và xuất lịch sử JSON

- Quyền chạy kiểm tra ngoài sandbox đã hoạt động. Trên commit `bd0b78e`, Electron 54/54, website 14/14, server 17/17 qua; MySQL 8.4 thực chạy lại trong container tmpfs riêng trên cổng 13317, 22/22 qua, không skip. Container thử đã dọn, không dùng MySQL ứng dụng thật trên 3314. Các ghi chú lỗi refresh token ở mục cũ bên dưới là lịch sử.
- Trong **Lịch sử dọn backup**, thêm **Xuất báo cáo JSON…**. Main mở hộp thoại lưu, đọc dữ liệu từ lịch sử local sau khi chọn nơi lưu và xác nhận profile không đổi; không nhận records hoặc đường dẫn từ renderer. Không mở session DB. Xuất trạng thái tại thời điểm ghi, không hứa snapshot kết thúc nếu tác vụ vẫn chạy.
- Báo cáo version 1 có loại `sqlpro-backup-retention-history`, thời gian xuất/phiên bản app, policy và kết quả từng lượt. Chỉ chiếu các field được validate: ID backup, thời gian, trạng thái, số byte và error code. Không xuất SQL/secret/token/raw error/profile name/host/database name. Record chưa kết thúc không trùng tác vụ hiện tại vẫn là incomplete; không thay trạng thái lịch sử nguồn.
- Module `backup-retention-export.cjs` ghi atomic bằng tệp tạm 0600 + flush + rename, giới hạn JSON 2 MiB. Chặn nơi lưu bên trong userData kể cả alias thư mục symlink; không làm hỏng backup/config khi chọn nhầm nơi lưu. Lỗi publish giữ tệp báo cáo cũ, dọn tệp tạm. Thay đích/symlink bởi chương trình ngoài trong cửa sổ filesystem vẫn ngoài bảo đảm khóa nội bộ.
- UI chống gửi trùng, Hủy không xuất tệp, giữ báo cáo hiển thị nếu lỗi, phản hồi cũ không đổi modal/database mới. Electron smoke kiểm tra Enter trên nút xuất và thông báo thành công; test repository/service có safe-field projection, incomplete/active, đường dẫn userData/alias và lỗi publish; IPC có scope, Cancel và dữ liệu main-owned; renderer VM có stale context.
- Sau bổ sung export: check 60/60 nhóm, Electron 54/54, server syntax và diff check qua. Website/server đã qua trong cùng lượt, không thay code các phần đó sau kiểm tra. Chưa build installer, chưa kiểm chứng MariaDB/Windows file locking, crash/power loss và benchmark lớn. G3.3 scheduler và tự dọn sau backup mới của G3.4 còn làm tiếp; chưa đánh dấu toàn nhóm hoàn tất. Thay đổi export hiện chưa commit.

## Review và chốt đợt 2

Đã review toàn bộ thay đổi so với `0fa0ab7`, sửa 9 nhóm lỗi về context rename/delete, va chạm khi copy, read-only sau trial connect, preview chồng nhau/quota metadata, recovery modal đến muộn, tính nhất quán history, controls khi load policy chậm và kiểu ngày. Chi tiết: [CODE_REVIEW_BATCH_2.md](CODE_REVIEW_BATCH_2.md). Check qua 59/59 nhóm; server syntax/diff qua. Electron/website/server smoke và MySQL thực chưa được kiểm chứng lại trong lượt review do duyệt quyền ngoài sandbox lỗi token. Chưa phát hành.

Đã tạo commit local đợt 2 gồm 31 tệp, chưa push. Lượt commit trước bị chặn bởi `.git/index.lock` chỉ đọc và lỗi refresh token; lượt tiếp theo đã thành công. Chưa chạy lại các kiểm tra ngoài sandbox nêu trên.

## 12/11 — Lịch sử kết quả dọn backup

- Backups có **Lịch sử dọn backup…** đọc theo profile/database, xem số bản/byte SQL đã ghi nhận xóa, các bản chưa xóa, policy và mã lỗi. Dùng details/summary hỗ trợ bàn phím; escape mọi nội dung, chặn phản hồi cũ khi đổi database/hộp thoại. Không cần kết nối DB để đọc báo cáo.
- `backup-retention-history.cjs` ghi record trước apply và kết quả cuối sau khi hoàn tất/dừng/lỗi. Nếu không ghi được record đầu thì chưa dọn; lỗi ghi kết quả cuối vẫn trả kết quả thật cùng cảnh báo `historySaveError`, giữ record chưa kết thúc để kiểm tra. Native Cancel không tạo lượt lịch sử vì chưa bắt đầu tác vụ.
- Lưu version 1 atomic 0600, tối đa 50 record/1 MiB theo scope, ưu tiên giữ record chưa kết thúc và bỏ report hoàn tất cũ nhất. Đầy 50 record chưa kết thúc thì báo lỗi, không tự xóa bằng chứng. Tệp hỏng/symlink/version lạ bị từ chối, không tự ghi đè. Chỉ lưu ID backup, giới hạn, timestamps, số byte và error code; không lưu SQL, token, raw error message hoặc secret.
- Record còn running nhưng không trùng tác vụ main đang chạy được hiển thị **Chưa xác nhận kết thúc**, kèm danh sách dự kiến và cảnh báo số đã xóa có thể chưa được cập nhật. Không suy thành thành công hoặc tự tiếp tục xóa sau restart. Đây là lịch sử local phục vụ đối chiếu, không phải log chống sửa đổi hoặc recovery journal bảo đảm từng unlink.
- `npm run check` qua 58/58 nhóm, server syntax và diff check qua. Test có reopen/scope/quota, giữ bằng chứng chưa xong, lỗi publish, corrupt metadata, code-only errors, fail-before-apply, báo cáo cuối lỗi vẫn giữ kết quả, render escape/stale context. Electron smoke thêm mở chi tiết bằng Enter và layout; **chưa thực thi** vì automatic approval review tiếp tục báo refresh token bị thu hồi. Website/server smoke ngoài sandbox chưa chạy lại; cần đăng xuất/đăng nhập để phục hồi kiểm chứng.
- Giới hạn: chưa checkpoint mỗi unlink, chưa kiểm chứng power loss/Windows và chưa có export báo cáo. Trạng thái incomplete cần đối chiếu catalog thủ công; không đủ căn cứ khẳng định chính xác số đã xóa nếu ứng dụng crash trước khi lưu report cuối. G3.4 và audit chung G8.1 còn một phần.

## 12/11 — Tiến độ và dừng tác vụ retention

- Luồng dọn có taskId riêng và endpoint status theo đúng profile/database/taskId. Renderer hỏi tiến độ mỗi 500 ms, mỗi lần chỉ có một request; dừng polling khi task kết thúc hoặc context/hộp thoại thay đổi. Không đưa token hoặc đường dẫn tệp vào status.
- UI hiển thị giai đoạn kiểm tra catalog, byte đọc khi hash bản giữ lại, số bản đã xóa/tổng số và byte SQL đã dọn. **Dừng dọn backup** chỉ bật khi main báo tác vụ đang chạy; lúc xác nhận native có thể chọn Hủy ngay trên dialog.
- Cancel abort stream hash bằng AbortSignal và kiểm tra cờ giữa các tệp/các lượt snapshot, đồng thời giữ transfer slot tới khi cleanup trả kết quả. Nếu SQL vừa bị xóa thì vẫn dọn các sidecar tương ứng trước khi dừng ở tệp kế tiếp; báo riêng metadata lỗi. Đã xóa không được rollback; báo `stopped` và danh sách chưa xử lý kể cả khi hủy trước lần xóa đầu tiên. Thời gian chờ lấy khóa hoặc một lệnh filesystem đang thực hiện vẫn là hủy hợp tác.
- `npm run check` qua 57/57 nhóm; server syntax và diff check qua. Test mới có abort trong lúc đọc hash 4 MiB trước xóa, dừng giữa tệp, status/cancel sai scope, không tác động session SQL và renderer ngừng polling sau thay hộp thoại. Electron smoke thêm tiến độ + Enter trên nút Dừng, **chưa thực thi** vì automatic approval review tiếp tục báo refresh token bị thu hồi. Website/server smoke ngoài sandbox chưa chạy lại; cần đăng xuất/đăng nhập để phục hồi kiểm chứng.
- G3.4 chưa hoàn tất: chưa tự dọn sau backup mới/scheduler, chưa benchmark lớn và chưa kiểm chứng crash/Windows file locking. Đóng hộp thoại ngừng xem tiến độ nhưng không tự hủy thao tác đang chạy; cần dùng Dừng trước khi đóng nếu muốn ngừng.

## 12/11 — Áp dụng retention thủ công sau khi xem trước

- Công cụ có **Dọn các bản đã xem trước…**: xác nhận native mặc định Hủy, liệt kê tên/ID/database/dung lượng SQL và cảnh báo không thể hoàn tác. Main chỉ nhận token, không nhận danh sách xóa từ renderer. Token một lần, TTL 2 phút, tối đa 8 scope đang chờ; preview mới cùng scope vô hiệu preview cũ. Bản kế hoạch giữ snapshot riêng, không sửa được qua response.
- `backup-retention-apply.cjs` chụp file identity của SQL/manifest/name/trial và catalog hai lần khi preview. Apply giữ khóa metadata theo thứ tự trên toàn catalog, kiểm tra snapshot và hash lại bản `latest-verified` được giữ, rồi so identity các tệp còn lại trước từng lần xóa. Ghim/đổi tên/sửa SQL/metadata hoặc thêm/xóa backup sau preview yêu cầu xem trước lại. Chỉ bản được planner đánh dấu remove mới là candidate; catalog tối đa 2.000 bản, mỗi lần áp dụng tối đa 100 bản, xóa từ cũ nhất.
- Main giữ transfer slot suốt apply, không mở/commit phiên DB; từ chối khi transfer hoặc scan đang dùng backup. Scan mới bị chặn trong lúc dọn; verify/copy/export dùng cùng khóa với metadata/delete để tránh xóa giữa lúc đọc. Hủy transfer retention không gọi cancelTask của SQL Editor. Hủy giữa các tệp báo phần đã xóa, không hứa hoàn tác.
- Báo cáo trả ID đã xóa, byte SQL, lỗi từng bản và danh sách chưa xóa; dừng ở lỗi đầu tiên. Lỗi sidecar ghi rõ SQL đã xóa nhưng metadata có thể còn. Preview/edit/save policy vô hiệu hóa nút Dọn cũ; sau Hủy/lỗi/hoàn tất phải xem trước lại. Xóa chỉ tác động các tệp SQL/sidecar catalog trên máy này; chính sách và recovery journal riêng được giữ.
- Check 57/57 nhóm và server syntax/diff check qua. Test filesystem thật trong thư mục tạm: apply thành công, replay/TTL/scope, pin/SQL/manifest/addition drift, hash anchor sai, lỗi unlink, lỗi metadata, hủy giữa tệp và response mutation. Test IPC: native Cancel, token consumed trước dialog, failure release và không mở DB session. Renderer VM: token payload, invalidation và Cancel. Electron/website/server smoke ngoài sandbox **chưa chạy**: automatic approval review tiếp tục từ chối thực thi do refresh token bị thu hồi; cần đăng xuất/đăng nhập lại. Không dùng smoke cũ làm bằng chứng cho thao tác xóa mới.
- Giới hạn: đây là dọn thủ công, chưa tự dọn sau backup mới hoặc theo lịch. Chưa kiểm chứng kill/power loss ở mọi điểm và Windows file locking; xóa có thể để sidecar mồ côi nếu crash. Khóa bảo vệ thao tác trong cùng tiến trình SqlPro; không phải khóa độc quyền với phần mềm ngoài, vẫn còn cửa sổ giữa kiểm tra identity và unlink. Chưa benchmark catalog lớn; G3.4 chưa hoàn tất toàn tiêu chí.

## 12/11 — Lưu chính sách retention theo database

- Công cụ retention có **Lưu chính sách** và **Xóa chính sách đã lưu**. Mỗi profile/database giữ cấu hình riêng, mở lại nạp số bản/tuổi/dung lượng đã lưu; xóa cấu hình giữ nguyên mọi tệp backup. Chính sách chỉ dùng để điền giới hạn xem trước, chưa bật tự động dọn hay scheduler.
- `backup-retention-store.cjs` lưu `retention-policy.json` version 1 trong thư mục catalog đã hash theo profile/database. Validate bằng policy dùng chung; ghi atomic 0600; tệp hỏng, symlink, quá 4 KiB hoặc version chưa hỗ trợ báo lỗi và giữ nguyên. Lỗi publish giữ cấu hình cũ, dọn tệp tạm. Thiếu tệp trả về chưa có chính sách, không tự ghi mặc định.
- Renderer giữ profile/database và identity vùng hiển thị; nạp chậm không ghi đè draft đã sửa. Lưu lỗi giữ nội dung nhập, chống submit trùng và kiểm tra đầu vào trước khi disable controls. Nạp cấu hình lỗi vẫn cho preview nhưng khóa ghi/xóa cấu hình để tránh ghi đè bằng giá trị mặc định. Giới hạn byte lưu chính xác, hiển thị MiB có phần lẻ khi cần.
- `npm run check` qua 56/56 nhóm; server syntax và diff check qua. Test repository có round-trip/restart, cách ly profile/database, clear không xóa backup, lỗi ghi và metadata hỏng; test IPC/renderer VM có target capture, draft và lỗi lưu. Electron smoke bổ sung lưu/mở lại/xóa cấu hình, nhưng **chưa chạy được**: automatic approval review tiếp tục báo refresh token bị thu hồi; lệnh không được thực thi. Website/server smoke ngoài sandbox cũng chưa chạy lại; cần đăng xuất/đăng nhập để phục hồi bước duyệt quyền. Không coi kết quả đợt cũ là kiểm chứng UI mới.
- G3.4 vẫn còn execution plan bất biến, xác minh lại trước apply và tự dọn sau backup thành công; scheduler ở G3.3 chưa triển khai. Chính sách lưu cục bộ, chưa đồng bộ qua vault.

## 12/11 — Xem trước retention backup

- Backups có **Xem trước dọn backup…** theo số bản, tuổi (ngày) và tổng dung lượng SQL (MiB). Có thể bỏ trống từng giới hạn, phải nhập ít nhất một giới hạn nguyên dương; các giới hạn được xét đồng thời, ưu tiên đề xuất bản cũ nhất. Hiển thị số bản/dung lượng giữ và đề xuất dọn, lý do từng bản và giới hạn chưa đạt. Bảng giới hạn 500 dòng DOM, thống kê vẫn theo toàn catalog.
- Module thuần `backup-retention.cjs` không ghi/xóa tệp. Main đọc catalog đúng profile/database, không tin danh sách từ renderer và từ chối xem trước khi có transfer. Bản ghim, đang dùng, mới nhất và bản mới nhất có fileWritten + checksum verified được giữ. Metadata lỗi, checksum mismatch, ngày không hợp lệ/tương lai hoặc dung lượng không hợp lệ được bảo vệ; thiếu bản thành công đã xác minh thì không đề xuất dọn. Tổng dung lượng chưa rõ được cảnh báo riêng.
- Preview có context profile/database, generation khi sửa giới hạn và identity vùng hiển thị; phản hồi cũ không ghi đè hộp thoại hoặc chính sách mới. Hỗ trợ Ctrl+Enter, escape tên backup và lý do. Đây là công cụ đọc catalog, không xác minh lại hash ngay trong preview và không phải quyền cho phép xóa.
- Unit/policy kiểm tra giới hạn, giữ bản bảo vệ, count/age/bytes, đồng hồ tương lai, metadata lỗi, thiếu bằng chứng, số vượt phạm vi chính xác và input bất biến. Test IPC xác nhận catalog do main đọc; renderer VM kiểm tra payload, escape và phản hồi stale. Electron smoke đã thêm kiểm tra tương tác/layout nhưng **chưa chạy được**: automatic approval review báo refresh token đã bị thu hồi, nên lệnh Electron/website/server test ngoài sandbox không được thực thi. Cần đăng xuất/đăng nhập lại để chạy kiểm chứng này; không dùng kết quả smoke đợt trước làm bằng chứng cho UI mới.
- G3.4 còn một phần: chưa lưu chính sách, chưa tự dọn sau backup mới, chưa có execution token/snapshot để áp dụng an toàn hoặc scheduler. Chưa xóa tệp nào qua retention trong đợt này.
- Kết quả thực thi được: `npm run check` 55/55 nhóm, server syntax và `git diff --check` qua. Đợt này không thay SQL/database, không chạy lại MySQL integration.

## 12/11 — Ghi chú, ghim và bảo toàn metadata backup

- Backups có **Ghi chú / Ghim**: ghi chú nhiều dòng tối đa 2.000 ký tự, ghim/bỏ ghim và lưu bằng Ctrl+Enter. Nội dung được escape khi hiển thị; lỗi lưu giữ nguyên bản nháp. Lưu thành công giữ selection/focus và vị trí cuộn bảng; phản hồi đến muộn không tác động hộp thoại/database mới.
- Bản ghim không thể xóa qua catalog service, kể cả gọi IPC trực tiếp. Toolbar/menu vô hiệu hóa xóa, phải bỏ ghim trước. Tệp metadata hỏng báo lỗi và chặn xóa/ghi đè/sao chép để tránh mất trạng thái bảo vệ; giữ nguyên tệp để kiểm tra thủ công.
- Module `backup-annotations.cjs` đọc metadata tên cũ `{name}` và ghi bản version 1 gồm name/note/pinned vào cùng `.name.json` (tối đa 16 KiB, ghi atomic 0600). Khóa theo đường dẫn tuần tự hóa đổi tên/ghi chú/ghim/xóa, không làm mất field khi chỉnh đồng thời. SQL/checksum/manifest không đổi khi sửa ghi chú.
- Sao chép nội bộ sang database/kết nối khác giữ tên, ghi chú và ghim; ghi metadata trước khi công bố SQL. Lỗi ghi metadata hoặc công bố SQL không để lại backup chưa được ghim trong catalog. Báo cáo phục hồi thử không được chuyển thành bằng chứng đã kiểm tra trên máy chủ đích. Xuất tệp SQL vẫn chỉ xuất SQL, không đóng gói ghi chú.
- Check 53/53 nhóm; Electron 52/52 có kiểm tra Ctrl+Enter, lỗi ghi, phản hồi stale, pin và XSS; website 14/14, server 17/17 và syntax qua. Test catalog bao gồm migration tên cũ, chỉnh đồng thời, chặn xóa bản ghim, giữ metadata khi copy, metadata hỏng, ENOSPC giả lập và cleanup khi công bố copy lỗi. Đợt này không thay SQL/database nên không chạy lại MySQL thực.
- Đây là phần bổ sung G2.1 và nền cho G3.4. Chưa có retention tự động hoặc scheduler; ghim bảo vệ thao tác trong SqlPro, không ngăn xóa tệp từ bên ngoài. Các nhóm roadmap chưa đủ nghiệm thu vẫn giữ trạng thái chưa hoàn tất.

## 12/11 — Nhật ký phục hồi thử sau khi ứng dụng bị tắt đột ngột

- Ghi một record mã hóa có xác thực vào `restore-trial-journal/` trước CREATE DATABASE; file riêng 0600, ghi tạm/flush/rename. Record chứa schema, marker/token và fingerprint đích, không đưa marker/token vào renderer. Ghi nhật ký lỗi thì không tạo schema. Khi CREATE lỗi không rõ server đã thực hiện chưa, giữ nhật ký và báo cần kiểm tra.
- Backups có nút **Database thử còn sót…** để đọc nhật ký của profile. Dọn dùng phiên riêng, xác nhận native mặc định Hủy, kiểm tra lại policy/profile/TTL và transfer slot; chỉ DROP sau khi marker/token khớp. Thiếu/sai marker giữ nguyên để kiểm tra thủ công. Schema đã không còn thì cho kết thúc record sau truy vấn xác nhận. Không tự quét/xóa database theo prefix hoặc tự dọn lúc khởi động.
- Giữ nhật ký khi dọn lỗi hoặc kết quả CREATE mơ hồ; xóa record sau khi xác nhận cleanup. Mất khóa local không tạo khóa thay thế nếu còn journal mã hóa. Tệp journal hỏng được giữ lại và báo lỗi, không lặng lẽ bỏ qua. Đổi host/port/user/SSH/TLS chặn cleanup; đổi tên profile không đổi đích.
- Kiểm chứng: check 53/53 nhóm; Electron 51/51 có Enter trên nút cleanup, chặn đích thay đổi và layout nhỏ; MySQL 8.4 thực 22/22 gồm mở lại journal, thiếu/sai marker và cleanup đúng sở hữu; website 14/14, server 17/17 và server syntax qua. Test IPC xác nhận chỉ đọc, Hủy và cleanup phiên riêng không tác động transaction SQL Editor. MySQL thử độc lập trên tmpfs, không dùng database ứng dụng thật.
- Giới hạn: mới mô phỏng mở lại nhật ký giữa các phiên và lỗi CREATE mơ hồ; chưa thử kill tiến trình Electron ở mọi điểm hoặc sự cố mất điện. Journal cục bộ không còn sau mất/xóa userData; không nhận diện trial được tạo trước tính năng này. Database tạo xong nhưng chưa có marker cần DBA kiểm tra thủ công. Chưa có quota đĩa/RAM server, hash toàn bộ nội dung, MariaDB hoặc installed-build smoke; G2 chưa được đánh dấu hoàn tất.

## Phạm vi còn lại sau đợt này

Roadmap có 51 đầu việc. G0–G2 còn baseline dữ liệu lớn/ma trận DB/bộ cài và phần hoàn thiện backup; chưa đủ căn cứ đếm tất cả là đã nghiệm thu. G3–G9 có **36 đầu việc chưa hoàn tất trong 7 nhóm**:

| Nhóm | Đầu việc | Phạm vi |
| --- | ---: | --- |
| G3 | 6 | Phục hồi chọn đối tượng, lịch backup, retention, nén/mã hóa và bản sao ngoài máy |
| G4 | 5 | Đo và tối ưu hiệu năng, dữ liệu lớn |
| G5 | 6 | SQL Editor, filter, EXPLAIN và chẩn đoán; một số phần đã có |
| G6 | 4 | So sánh schema, migration và kiểm tra drift |
| G7 | 5 | So sánh dữ liệu và đồng bộ có preview |
| G8 | 5 | Audit, tách module, UX, thử người dùng và tài liệu |
| G9 | 5 | Recovery/sync, bảo mật, CI và kiểm chứng phát hành |

## Review và chốt đợt 1

Đã rà soát, sửa các lỗi về validator trial SET/default function, schema cache khi confirm Production, query chen ngang, SQL preview bị cắt sớm, cancel/stat race, giới hạn byte copy thực và timeout cleanup. Chi tiết bằng chứng, kết quả test và các giới hạn còn lại ở `CODE_REVIEW_BATCH_1.md`. Check 52/52 nhóm, Electron 51/51, MySQL 8.4 thực 21/21, website 14/14 và server 17/17 đều qua trước khi chốt commit phát triển đợt 1. Cleanup trial hiện có timeout 15 giây từng lệnh marker/drop; các ghi chú chưa có cleanup timeout ở các đợt trước bên dưới là trạng thái lịch sử.

## 12/11 — Phục hồi thử backup, bản đầu

Cập nhật tiếp: nút Hủy phục hồi thử gọi đúng profile/taskId. Controller hủy stream sao chép, đọc/validation/hash qua AbortSignal, chuyển atomic cancel flag cho scan worker và gọi cancelTask đúng taskId khi restore. Giới hạn 10 phút yêu cầu dừng phần xử lý chính; đây là hủy hợp tác, lệnh server đang chờ có thể cần kết thúc trước khi nhận hủy. Sau khi dừng phần chính, cleanup marker vẫn chạy và ghi trạng thái rõ, chưa có deadline riêng cho cleanup.

Phân biệt báo cáo `cancelled`, `timeout`, `failed`; không báo verified nếu cancellation xảy ra sau restore trước bước hash cuối. Timer được dọn trước cleanup. Unit kiểm tra hủy trước khi tạo schema, timeout khi scan và hủy trong restore vẫn kiểm tra ownership/cleanup. Chưa chạy lại integration MySQL thực trong đợt hủy này; integration 21/21 ở đợt trước kiểm tra restore thành công.

- Nút trong chi tiết backup mở xác nhận native ghi rõ máy chủ và phạm vi tạo/xóa database thử. Dùng phiên riêng, kiểm tra chỉ đọc và cấu hình sau xác nhận, giữ transfer slot trong suốt tác vụ.
- Tạo bản sao tệp riêng quyền 0600 để kiểm tra/phục hồi; giới hạn 512 MiB, đối chiếu manifest/hash, xác thực câu SQL và scope trước tạo database. Không rewrite schema ghi rõ; tệp thuộc scope khác bị từ chối. Chỉ hỗ trợ CREATE/DROP bảng InnoDB thông thường, INSERT literal và SET session được parser cho phép. Chưa hỗ trợ view/trigger/routine/event, biểu thức generated/check/partition hoặc chuỗi backslash.
- Database tên ngẫu nhiên `sqlpro_trial_*`, tạo không dùng IF NOT EXISTS. Marker tên/token ngẫu nhiên được kiểm tra trước DROP. Không đủ ownership thì để nguyên và báo tên database cần dọn; không tự xóa schema chỉ dựa vào prefix. Nếu lỗi tạo marker, báo cần dọn thủ công.
- Báo cáo có checksum, thời gian, phiên bản server, kết quả row-count/FK verification từ restore và trạng thái cleanup. Ghi sidecar `.trial.json` atomic; lỗi lưu vẫn trả báo cáo/cleanup cho UI. Catalog hiển thị lịch sử thử, xóa backup dọn sidecar.
- MySQL 8.4 tạm: 21/21 pass gồm phục hồi và dọn schema thử thực, nguồn không đổi. Container tmpfs đã dọn. Check 52/52 nhóm; Electron 51/51 trước chỉnh câu chữ kết quả. Unit kiểm tra SQL bị từ chối, cleanup khi thành công/lỗi và không DROP khi marker sai.
- G2.3–G2.5 còn một phần: chưa có quota đĩa/RAM phía server, hash dữ liệu toàn bảng, recovery journal sau crash, hủy xuyên suốt giai đoạn scan/copy và timeout tổng tác vụ; chưa thử MariaDB/installed build. Tệp 512 MiB vẫn có thể mở rộng nhiều khi restore. Kết quả verified chỉ trong phạm vi kiểm tra row-count/FK hiện có, không phải so sánh toàn bộ nội dung. Không gọi đây là sandbox chống SQL độc hại; cần quyền DB phù hợp và xem xét trên máy chủ thử nghiệm trước.

## Cập nhật mới nhất — Commit, import và restore trên Production

### Đợt quét backup và ổn định test giao diện

Cập nhật tiếp: đã thêm progress polling 500 ms chỉ khi vùng chi tiết còn hiện/đang quét; hiển thị byte đã đọc, phần trăm byte và số câu SQL. Poll không chồng nhau và kết quả cũ không được cập nhật vào vùng chi tiết mới. 100% byte không đồng nghĩa tác vụ đã kết thúc; UI nói rõ vẫn phân tích/kiểm tra tệp.

Các yêu cầu cùng profile/database/backup và file identity được gộp vào một promise/worker, tối đa 32 subscriber. Status/cancel đối chiếu profile và taskId thuộc nhóm; cancel từ một subscriber dừng tác vụ chung và thông báo điều này trong UI. Backup khác vẫn trả busy, chưa có hàng đợi. Kết quả lỗi/hủy/file đổi không được cache. Unit kiểm tra shared scan/progress/privacy và cancel tất cả subscriber.

`npm run check`: 51/51 nhóm pass; Electron sau thay đổi 51/51, gồm smoke trực tiếp tiến độ 50%, số câu SQL và nút hủy. Các ghi chú chưa có progress/gộp yêu cầu bên dưới là trạng thái đợt trước. Đợt này không thay SQL thực thi database, chưa chạy lại integration DB/bộ cài.

- Test drag-selection cuộn dòng đích vào viewport, đóng menu che khuất và đợi hit-test trúng dòng trước khi kéo. Lượt kiểm chứng sau sửa qua Electron 51/51; không thay logic chọn dòng sản phẩm để làm test pass.
- Quét nội dung backup có taskId và nút Hủy; main giới hạn một worker đang quét, từ chối lượt khác bằng BACKUP_SCAN_BUSY. Hủy đối chiếu profile/taskId và gửi atomic cancel flag tới scanner; timeout 5 phút yêu cầu hủy hợp tác và chờ worker dọn.
- Cache display-only tối đa 4 inventory, TTL 5 phút, khóa theo profile/database/backup và nhận diện dev/ino/size/mtime/ctime. Kiểm tra lại nhận diện sau quét, không cache kết quả hủy/lỗi/tệp đổi; không dùng cache này để cấp phép restore.
- Kết quả trả tối đa 5.000 bảng và 5.000 đối tượng, bỏ nội dung định nghĩa khỏi response và báo truncated. Chưa giới hạn toàn bộ inventory nội bộ của parser; chưa có hàng đợi/gộp yêu cầu trùng hoặc progress định lượng. G2.2 còn một phần, chưa đạt toàn bộ roadmap.
- Unit kiểm tra cache invalidation, changed-file, busy, scoped cancellation, output/cache limits và renderer không ghi kết quả vào selection mới. `npm run check` qua 51/51 nhóm. Chưa chạy DB integration mới vì dùng lại scanner hiện có.

- Commit từ thanh transaction dùng cùng cơ chế token Production một lần; token chụp session/revision/profile, không tin `confirmed:true`. Trước thực thi kiểm tra lại bận, phiên và policy; không reconnect/retry. Hộp thoại nói rõ commit mọi tab dùng chung phiên, không riêng database hiển thị.
- Rollback tiếp tục có luồng xác nhận riêng; kết nối chỉ đọc vẫn rollback được.
- Import/restore dùng hộp thoại native từ main vì tác vụ cần tệp và phiên worker riêng. Xác nhận sau khi resolve tệp/đích và trước claim task/tạo worker; mặc định Hủy. Main giữ snapshot cấu hình, so file identity (dev/ino/size/mtime/ctime) và thời hạn 2 phút sau dialog. Đây không phải hash file hay ngăn mọi sửa file sau kiểm tra cuối; restore vẫn chạy preflight/checksum hiện có.
- Dialog hiển thị user/host/port, database đích, đường dẫn/dung lượng, bảng/mode/transaction khi import và drop/create lựa chọn khi restore. Cảnh báo ghi một phần và việc không dùng transaction SQL Editor.
- Unit/main: 24 test main pass, gồm xác nhận Commit một lần, revision/reconnect/busy/readonly/cancel, Rollback, import cancel/changed-file/execute, restore đúng targetProfileId. Toàn `npm run check`: 50/50 nhóm pass.
- Chưa chạy lại integration DB thực trong đợt này vì thay đổi tập trung orchestration/confirmation, không thay SQL ghi. Chưa kiểm chứng native transfer dialog bằng thao tác thật trên Windows/Ubuntu; test main inject phản hồi dialog, Electron smoke kiểm tra dialog Commit.
- Hai lượt Electron chạy trong đợt này đều qua phần dialog Production/Commit mới nhưng timeout ở test kéo chọn 3 dòng đã từng không ổn định. Không ghi toàn bộ smoke pass cho đợt này; cần điều tra riêng test hit-testing/resize/scroll trước phát hành.
- Các ghi chú “chưa tích hợp Commit/import/restore” ở báo cáo đợt trước bên dưới là trạng thái lịch sử, đã được cập nhật ở đợt này.

## Baseline

- Commit nền: `1d139d5`; workspace đã có thay đổi backup/autocomplete/version trước khi bắt đầu đợt này. Giữ nguyên các thay đổi đó.
- Node: v22.22.3; package: 0.3.12.
- Trước thay đổi: `npm run check` pass 46 nhóm; website smoke 14/14, server 17/17 khi chạy ngoài sandbox cho phép localhost. Lỗi website/server ở lượt trước là giới hạn môi trường, không tái hiện ở lượt kiểm chứng này.
- Sau thay đổi: `npm run check` pass 48 nhóm; renderer Electron 48/48, gồm transaction, bàn phím và layout. `npm --prefix server run check` pass.
- Lần chạy mặc định `npm run test:mysql` bỏ qua test bên trong vì thiếu `SQLPRO_TEST_MYSQL_PORT`. Sau đó đã dựng MySQL 8.4 tạm riêng tại localhost:13317, chạy `SQLPRO_TEST_MYSQL_PORT=13317 node test/mysql-integration.test.cjs`: **18/18 pass, không skip**, gồm 17 kịch bản và test cha. Container dùng tmpfs đã được dừng/xóa sau test; không dùng database ứng dụng hiện có.
- Bổ sung integration thật cho BEGIN/ROLLBACK/COMMIT/autocommit OFF, kiểm tra dữ liệu từ kết nối thứ hai. Sửa fixture round-trip backup thiếu `selection.tables` khi gọi `saveBackupFile`; không đổi hợp đồng sản phẩm để làm test pass.
- Chưa có benchmark 1/10/20 GB, chưa kiểm chứng bộ cài Windows/Ubuntu và chưa có ma trận DB thực. G0 còn đang làm.

## Đợt triển khai đầu tiên

| Ticket | Trạng thái | Đã làm / phần còn lại |
| --- | --- | --- |
| G0.1–G0.2 | Một phần | Baseline, phân loại test và integration MySQL 8.4 thực; còn MariaDB và installed builds |
| G1.1 | Đã triển khai, qua test hiện có | Môi trường profile, giữ profile cũ chưa phân loại, lưu/đồng bộ qua vault, hiển thị ở sidebar/tab/header và transaction confirmation |
| G1.2 | Đã triển khai, còn mở rộng ma trận MariaDB | Profile chỉ đọc, guard main/API database, kiểm tra batch SQL bảo thủ, UI và integration tài khoản SELECT/SHOW VIEW |
| G1.3 | Đã triển khai các đường chính, còn mở rộng kiểm chứng | Grid/SQL/Commit dùng token một lần; import/restore dùng xác nhận native tại main với kiểm tra file/profile trước tạo worker |
| G1.4–G1.5 | Một phần | Thanh transaction, xác nhận Commit/Rollback, session identity + revision, chặn bận/stale/reconnect, không replay commit lỗi; đã kiểm chứng trạng thái trên MySQL 8.4, còn MariaDB và audit toàn bộ vòng đời |
| G5.1 | Một phần | EXPLAIN ALL không còn kết luận bắt buộc thêm index; còn giải thích plan có ngữ cảnh đầy đủ |
| G2–G9 còn lại | Chưa triển khai | Theo dependency roadmap, không được coi là đã hoàn tất |

## Bằng chứng và giới hạn

- Test main: commit/rollback đúng profile dù active connection khác; từ chối phiên mới, revision cũ, tác vụ bận và thao tác chồng nhau; lỗi mạng không mở lại/replay commit.
- Test DB state: ghi nhận transaction từ serverStatus, autocommit, thời điểm quan sát và invalidation revision khi phát sinh lệnh mới.
- Test renderer: đích transaction lấy từ tab SQL; đổi đích trong lúc xác nhận không gửi lệnh; cancellation không gửi lệnh; tên được escape.
- Test store: profile cũ không tự suy môi trường theo host, lưu nhãn qua edit/vault round trip, giá trị môi trường sai được chuẩn hóa.
- Electron smoke: điều khiển có thể focus bằng bàn phím, nút bị khóa khi phiên bận, toolbar không tràn ngang. Ảnh kiểm tra lưu tại `/tmp/sqlpro-g1-review/` trong phiên phát triển, không đưa dữ liệu thật vào repo.
- Nhãn Production chỉ giúp nhận diện, chưa phải cơ chế giới hạn ghi. Quyền DB vẫn là lớp bảo vệ cần thiết.
- Commit/Rollback áp dụng cho toàn bộ transaction của session; không có transaction riêng theo tab, không bảo đảm rollback DDL.

## Công việc tiếp theo

1. Mở rộng DB thử với tài khoản quyền tối thiểu và MariaDB; kiểm chứng bộ cài trước khi phát hành.
2. Kiểm chứng policy chỉ đọc trên MariaDB và bổ sung fixture theo cú pháp được hỗ trợ; giữ fail-closed cho câu/hàm chưa nhận diện.
3. Hoàn thiện scan backup có cancel/cache, sau đó sandbox restore; mở rộng kiểm chứng native dialog trên bộ cài thực.

## Đợt tiếp theo — xem trước ghi trên Production

- Grid thêm/sửa/xóa và `db:query` có guard Production tại main, không tin `confirmed:true` do caller gửi để bỏ qua bước xem trước. Các câu được phân loại đọc vẫn chạy bình thường.
- Token ngẫu nhiên có TTL 2 phút, tối đa 32 yêu cầu đang chờ, dùng một lần kể cả khi thực thi lỗi. Nội dung yêu cầu được chụp bằng V8 serialization, giữ chính xác Buffer/BigInt và không dùng lại payload có thể thay đổi.
- Trước xác nhận chỉ tải metadata. Preview có đích cụ thể, cột, SQL placeholder/literal đã che, kiểu/thứ tự tham số và số dòng được chọn; không giả lập số dòng ảnh hưởng. Insert/update dùng chung planner với code ghi; delete là SQL dự kiến theo PK, vẫn dùng validation/lock/original-value guard khi xóa thật.
- Confirm kiểm tra session identity, transaction revision, cấu hình trusted profile và metadata/plan của thao tác dòng; giữ session lease tới khi thao tác async kết thúc. Không tự reconnect/retry. Các thay đổi từ session bên ngoài sau bước kiểm tra cuối vẫn có thể xảy ra và được kiểm soát trong giới hạn guard hiện có.
- Renderer dùng dialog riêng, focus mặc định ở Hủy, Escape hủy; bản nháp/form đang mở được giữ lại. Không gửi giá trị tham số/SQL literal vào preview.
- SQL không thể preview chắc chắn do executable comment/hint hoặc quote/escape phụ thuộc SQL mode bị từ chối thay vì che mất cấu trúc câu lệnh. Export SQL Production chỉ cho câu được phân loại đọc để không lách qua export.
- Phạm vi chưa hoàn thành: import/restore/Commit có xác nhận riêng hiện tại, chưa dùng token Production này. Chưa có tùy chọn hiện giá trị tham số, chưa có schema-diff/migration approval.

Kiểm chứng: unit/main cho token hết hạn, hủy, replay, payload thay đổi, session/revision/schema/policy đổi, giữ lease khi write đang chờ, readonly precedence và export bypass. Electron kiểm tra dialog, Escape, giữ draft, exact-token confirm và layout. MySQL thật kiểm tra preview không ghi rồi insert/update/delete đúng kế hoạch; round-trip backup, transaction, row conflict và tài khoản chỉ đọc tiếp tục được kiểm tra.

Kết quả đợt này: check **50/50 nhóm**, Electron **50/50**, website **14/14**, server **17/17**, server syntax check pass; MySQL 8.4 tạm **20/20** (19 kịch bản và test cha), không skip. Container tmpfs đã dọn. Ảnh kiểm tra: `/tmp/sqlpro-production-review/production-review.png`. Chưa kiểm tra MariaDB hoặc bộ cài Windows trong đợt này.

## Đợt tiếp theo — chế độ chỉ đọc

- Thêm `readOnly` vào profile/store/vault, mặc định false cho profile cũ; giá trị explicit sai kiểu khi đọc được chuẩn hóa về chế độ an toàn, save yêu cầu boolean.
- Cho phép SELECT cơ bản/CTE SELECT, hàm dựng sẵn trong allowlist, metadata, EXPLAIN SELECT, USE và ROLLBACK. Chặn toàn bộ batch nếu bất kỳ câu nào bị từ chối; không dựa vào `confirmed` hoặc cờ readOnly do renderer gửi trong request query.
- Hàm tùy biến/qualified function, executable comment, optimizer hint, SQL mode-dependent backslash string và cú pháp chưa nhận diện bị từ chối. Đây là policy tránh ghi nhầm, không phải SQL sandbox; quyền/DEFINER phía server vẫn cần được kiểm soát.
- Profile chỉ đọc vẫn có thể tạo/xem/đổi tên/xóa/xuất file backup cục bộ. Chỉ đọc áp dụng cho database, không khóa kho file backup.
- Khi đổi cấu hình có transaction, autocommit OFF hoặc tác vụ đang chạy, trả lỗi và giữ phiên; không tự đóng để rollback. Các task đã bắt đầu không được hứa sẽ được hoàn tác bằng cách đổi policy.

| Đường vào main | Policy |
| --- | --- |
| `db:query` | Kiểm tra trusted profile trước mở phiên và sát lúc thực thi; xác nhận batch không bỏ qua chỉ đọc |
| `db:insert-row`, `db:update-row`, `db:delete-rows` | Chặn trước mở phiên và tại callback phiên; API DatabaseSession cũng có guard |
| `db:import-file`, `db:restore` | Kiểm tra profile đích, trước dialog/task và sau chuẩn bị worker; restore/copy sang DB khác xét targetProfileId |
| `db:export-query` | Kiểm tra SQL trước dialog và sau dialog trước chạy; không cho SELECT hàm chưa phân loại lách qua export |
| `db:transaction` | Commit bị chặn; rollback vẫn được phép với đúng session/revision |
| Metadata, table-data/count, export-file, backup | Cho phép đọc/backup; câu do app dựng vẫn đi qua biên quote/parameter hiện có |
| Catalog copy/rename/delete/export | Cho phép thao tác file cục bộ, không ghi database |

Kiểm chứng đợt này: `npm run check` **49/49 nhóm**, Electron **49/49**, website **14/14**, server **17/17**, server syntax check pass. MySQL 8.4 tạm riêng: **19/19 pass** gồm 18 kịch bản và test cha, không skip; kiểm tra read-only account, từ chối ghi cả khi gọi raw trực tiếp theo quyền server, CTE/metadata đọc được và dữ liệu không đổi sau batch bị chặn. Container tmpfs đã dọn. Ảnh UI kiểm tra ở `/tmp/sqlpro-readonly-review/`.

Một lượt Electron cuối timeout ở test kéo chọn 3 dòng; chạy lại không thay code đạt 49/49. Cần theo dõi độ ổn định test drag-selection trong CI; không coi việc rerun là bằng chứng lỗi đó đã được sửa.
