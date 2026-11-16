# Review đợt 8 — EXPLAIN, ANALYZE và autocomplete

Ngày: 16/11/2026. Phạm vi: toàn bộ thay đổi sau `81d0228`, gồm G5.1, các phần G5.2/G5.3 và sửa automatic retry khi lưu ô. Commit local, không push/phát hành.

## Phát hiện và sửa trong lượt review

| Mức | Phát hiện | Sửa và kiểm chứng |
| --- | --- | --- |
| P3 | Chọn hàm khi con trỏ ở giữa tên và phía sau đã có ngoặc có thể tạo `COUNT()()` hoặc làm hỏng lời gọi có tham số. | Giữ ngoặc/tham số có sẵn sau whitespace, chỉ thay tên và đặt caret trong lời gọi. Unit kiểm có/không ngoặc, whitespace/newline; Electron Enter/Ctrl+Z kiểm `COUNTA(id)` → `COUNT(id)` và khôi phục SQL/caret. |
| P3 | Qualifier trùng giữa alias của nguồn này và tên một nguồn không đặt alias bị ưu tiên chọn alias, dù hai owner cùng hiện diện. | Xét toàn namespace owner nhìn thấy; nhiều kết quả giữ ambiguous và không đọc metadata. Test cả CTE/physical, unaliased physical và tên bảng đã được che bằng alias khác. |
| P3 | Bộ kiểm context EXPLAIN dùng regex `$` cho hash mà chưa chặn newline cuối chuỗi. Main hiện chỉ tạo hash đúng định dạng nên không mở đường ghi. | Bắt buộc đúng 64 ký tự trước regex; regression context giả có newline không được làm mốc. |

Lỗi blur tự retry UPDATE sau thất bại đã được phát hiện và sửa trong phần triển khai trước review này; test Electron lỗi DB/zero-row/explicit retry được chạy lại. Không phát hiện thêm lỗi chặn commit trong phạm vi đã đọc và kiểm thử; đây không phải khẳng định toàn ứng dụng không còn lỗi.

## Ranh giới được rà soát

- Main/preload/database: ANALYZE là API riêng, source classifier trước thực thi, lease qua native confirmation mặc định Hủy; kiểm profile/session/generation/version/revision/TTL, transaction và autocommit thực. Không tự SET/Commit/Rollback/retry; Symbol nội bộ chỉ mở reader cho lệnh đã dựng. Export ANALYZE chỉ từ kết quả đã nhận, main/session chặn replay qua export.
- Metadata EXPLAIN opt-in dùng deadline/task/lease chung, bounded reads và context check; giữ kết quả plan đã xong nếu trailing observation lỗi. Chỉ hash metadata, không đưa raw settings/DDL vào context; default không query thêm. SHOW CREATE một bảng không đại diện toàn schema. Hủy/timeout có thể đóng phiên theo reader hiện có.
- Renderer capture request trước await, task/generation guards cho result/error/finally; baseline WeakMap theo tab, binding profile/database/session/SQL hash/format. JSON indent không reserialize number/key, quotas và escape output. Không dùng khác biệt plan để suy nhanh/chậm.
- Autocomplete: scope recognizer hữu hạn, local CTE/derived không thành physical lookup; declaration/projection/implicit atom giữ all-or-opaque, không evaluate expression hoặc cấp quyền chạy. Cache exact tuple, LRU/TTL/admission/generation; metadata theo đích tab; snapshot/selection/IME trước chèn, Undo và HTML escaping.
- Giữ thay đổi có sẵn, không thêm dependency hoặc sửa version/lockfile; module runtime mới đều trong `electron/**/*` allowlist. Không thay backup/restore executor hay format lưu.

## Kiểm chứng lượt này

| Kiểm tra | Kết quả |
| --- | --- |
| npm run check | 117/117 nhóm |
| Focused backend/renderer/pure regression | 16/16 nhóm |
| npm run test:renderer | 71/71 |
| npm run test:website | 14/14 |
| npm --prefix server run check | Qua |
| npm run server:test | 17/17 |
| Syntax test smoke và git diff --check | Qua |
| Linux unpacked /tmp/sqlpro-review8-package | Qua; 13/13 runtime ASAR khớp bytes workspace |
| Smoke từ ASAR cuối | 71/71 |

Log `/tmp/sqlpro-batch8-review-*.log`. Native UI dùng IPC fixture; backend guards được kiểm qua VM/unit. Các fixture MySQL 8.4/MariaDB 11.4 thực của phần EXPLAIN/ANALYZE trước đó có bằng chứng trong ROADMAP_PROGRESS.md, không chạy lại DB thật trong lượt review này. Không chạm database ứng dụng.

G5.2/G5.3 vẫn một phần; G3–G9 còn 35 đầu việc lớn chưa hoàn tất. Chưa nghiệm thu installed/native-main end-to-end, Windows/upgrade, crash/power loss, tải lớn, toàn dialect/SQL mode hoặc toàn schema/bind context.
