# Review đợt 7 — Metadata và thay đổi trước phục hồi chọn bảng

Ngày: 16/11/2026. Phạm vi: các thay đổi sau `4330f56`: unique_checks/CHECK phiên, engine bảng đích, metadata/digest trigger, DEFAULT/generated và so sánh hai lần kiểm tra. Chốt commit local cho phần preview; chưa nghiệm thu G3.1–G3.2 hoặc phát hành.

## Phát hiện và sửa

| Mức | Phát hiện | Sửa và bằng chứng |
| --- | --- | --- |
| P3 | Hai quan sát cột cùng identity khiến hàng đầu còn là metadata-observed, hàng sau unknown; tổng đã quan sát có thể cao hơn bằng chứng không mơ hồ. Report toàn cục vẫn incomplete và không có executor. | Đếm toàn bộ identity trong quota trước khi đánh giá, đưa cả hai hàng trùng về unknown; cột độc lập giữ trạng thái riêng. Regression thất bại trước sửa, qua sau sửa, totals và projection khớp. |
| P3 | Projection trigger chỉ kiểm tra tổng INSERT nằm trong tổng trigger, chưa đối chiếu sự kiện từng hàng; report không nhất quán có thể được chiếu như đã đủ metadata. Không cấp quyền ghi. | Kiểm tra số INSERT nằm trong số đã giữ và số hàng còn ngoài report; report đủ hàng phải khớp chính xác. Regression có cả thiếu/thừa count và truncated upper/lower bounds, thất bại trước sửa và qua sau sửa. |

Không phát hiện thêm lỗi chặn commit trong phạm vi đã rà soát. Kết quả này không chứng minh toàn ứng dụng không còn lỗi.

## Ranh giới đã rà soát

- Luồng mới chỉ SELECT metadata trên kết nối riêng, tối đa 12 truy vấn có timeout/context check và schema binding. Không SET phiên/GLOBAL, không đọc dữ liệu dòng, không chạm transaction SQL Editor. Full restore/trial/backup format giữ hành vi hiện có.
- Metadata thiếu/cũ/sai/quyền/quota giữ unknown. unique_checks/CHECK bật không chứng minh dữ liệu hợp lệ; ENFORCED không thay cho kiểm chứng phiên hoặc dữ liệu. Engine ngoài InnoDB/chưa rõ chặn INSERT data-only sau guard schema/skip/policy; quan sát InnoDB không bảo đảm rollback DDL/trigger.
- Body/ngữ cảnh trigger và DEFAULT/generated được hash có giới hạn tại server; không tải raw body/default/expression/DEFINER/mode tạo trigger về app. Digest riêng chỉ ở facts nội bộ, không report/renderer/plan. Report chiếu whitelist, có quota và các gate side effects/visibility/default/generated/recheck.
- Snapshot v16/metadataId binding v2/plan v29 bind thay đổi giữa hai quan sát metadata. Plan deep-freeze, luôn blocked/canExecute:false; không token/registry/apply/executor hoặc quyền chạy từ renderer.
- So sánh hai lượt giữ một mốc tạm trong hộp thoại, ràng buộc reply với request; không lưu localStorage/sidecar. Đổi scope, lỗi/hủy/source-only/đóng xóa mốc; kết quả stale không cập nhật. Metadata bằng nhau không chứng minh dữ liệu dòng không đổi hoặc snapshot nguyên tử.
- UI escape identifiers, giới hạn hàng, không raw SQL/value/expression/hash riêng hoặc control ghi. Renderer module mới có trong index và packaging allowlist; version/lockfile không đổi vì không thêm dependency hoặc phát hành.

## Kiểm chứng trước commit

| Kiểm tra | Kết quả |
| --- | --- |
| npm run check | 104/104 nhóm |
| npm run test:renderer | 57/57 |
| npm run test:website | 14/14 |
| npm --prefix server run check | Qua |
| npm run server:test | 17/17 |
| MySQL 8.4 đầy đủ | 33/33, không skip |
| Chín fixture preview MySQL 8.4 | 68/68, không skip |
| Chín fixture preview MariaDB 11.4 | 68/68, không skip |
| Packet fixture startup 32 KiB | 6/6 mỗi engine, không skip |
| Linux unpacked | Tạo thành công ở /tmp/sqlpro-review7-package |
| Renderer/preload từ app.asar | 57/57 bằng test harness |
| Nội dung app.asar | 12 tệp renderer/preload/preview được review khớp bytes workspace |
| git diff --check | Qua |

Tổng fixture hai cấu hình là 74 kiểm tra mỗi engine, ngoài bộ MySQL đầy đủ. Database thử chỉ nằm trong schema tự tạo trên container tmpfs loopback riêng, cổng 13317–13320. Container mặc định đã dọn sau fixture; container packet được dọn trước commit. Không dùng database ứng dụng hoặc đổi GLOBAL. Log kiểm tra ở `/tmp/sqlpro-review7-*.log`; regression trước/sau sửa ở `/tmp/sqlpro-batch7-*-before.log` và `*-after.log`.

Đã xem ảnh `/tmp/sqlpro-review7/backup-selection-expressions-small.png` và `backup-selection-drift-small.png`; Electron kiểm tra Enter, HTML escaping, báo cáo engine/trigger/CHECK/phiên và layout 900×650. Smoke từ ASAR kiểm tra renderer/preload với IPC fixture, không phải installed/main-process smoke hoặc nghiệm thu bộ cài.

## Phần còn lại

Phục hồi chọn bảng vẫn chỉ preview. Còn semantics SQL/default/generated/timezone/storage, dữ liệu PK/UNIQUE/FK/CHECK/collation, dependency/tác động gián tiếp, quyền/dung lượng và vòng đời thực thi/recheck/approval/cancel/cleanup/partial-result. Chưa nghiệm thu toàn MariaDB, Windows/installed builds/upgrade, crash/power loss hoặc tải lớn. Roadmap G3–G9 vẫn còn 36 đầu việc lớn chưa nghiệm thu trọn vẹn; chi tiết trong ROADMAP_PROGRESS.md. Commit local, không push/phát hành.
