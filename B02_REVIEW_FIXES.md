# B02 — Sửa findings và bàn giao tiếp

Ngày: 17/11/2026. Gói này lưu cả hồ sơ B00/B01 và collector B02 đã được chỉnh sau review. B01 là xác minh rủi ro; các lỗi runtime của migration/diagnostics/privacy trong báo cáo chưa được sửa bởi gói này.

## Hai findings đã sửa

- `DatabaseSession.listIndexes(..., { includeDefinition: true })` đọc capability của `information_schema.STATISTICS` trước khi chọn `EXPRESSION`, `IS_VISIBLE` (MySQL) hoặc `IGNORED` (MariaDB). Cache chi tiết tách khỏi cache cơ bản. Timeout dùng deadline chung. Capability không đọc được thì không tự hạ xuống metadata cơ bản.
- Snapshot giữ expression từng thành phần index, visibility/kind và trạng thái completeness trong fingerprint. Thiếu expression/visibility hoặc vượt ngân sách expression: partial/unknown. Functional index và index invisible/ignored giữ migration blocked cho đến khi generator/service hỗ trợ chính xác.
- Trigger đọc/hash DEFINER, SQL_MODE (kể cả chuỗi rỗng hợp lệ), ACTION_ORDER, CHARACTER_SET_CLIENT, COLLATION_CONNECTION và DATABASE_COLLATION cùng nội dung/action/timing. Thiếu ngữ cảnh: partial/unknown. Ngân sách byte tính cả ngữ cảnh. Trigger đủ metadata vẫn blocked với `TRIGGER_CONTEXT_REVIEW_REQUIRED`: đọc được quyền thực thi không phải quyền phát lại DEFINER.
- Projection chỉ chứa trạng thái và số lượng; không trả expression index, body trigger, DEFINER hay SQL_MODE.

## Kiểm chứng trong lượt sửa

- `npm run check`: 994 pass / 0 fail / 14 opt-in skip (1008 tổng).
- Test mới: `test/schema-snapshot-definition.test.cjs`, dùng `DatabaseSession` thật với phản hồi driver giả lập. Kiểm tra drift expression/visibility/context từng trường, MySQL/MariaDB capability, denied/unknown, cache isolation, quota và projection.
- Không chạy MySQL/MariaDB thật, Electron smoke hay bộ cài trong lượt này. Các số liệu DB/UI ở báo cáo baseline là hồ sơ của lượt trước, không phải bằng chứng kiểm chứng lại tại đây.

## Gemini làm tiếp

1. Nối collector vào named IPC tại main với lease/worker, identity từ registry, recheck profile/session/generation sau await, timeout/cancel và projection giới hạn. Collector hiện chưa được nối vào UI/main IPC.
2. Kiểm chứng trên MySQL/MariaDB cô lập: capability theo phiên bản, functional/hidden index, trigger context, quyền hạn thiếu và drift. Kết quả information_schema rỗng do quyền bị giới hạn không tự chứng minh đối tượng không tồn tại; cần policy chứng minh đủ quyền trước thao tác phá hủy.
3. Xây main-owned migration plan: giữ metadata đầy đủ tại main, bind source/target/scope/hash/TTL, token một lần, kiểm policy và drift sát lúc ghi, báo kết quả từng statement/partial DDL. Không dùng lại vòng lặp phát SQL renderer làm executor tin cậy.
4. Bảo đảm generator và executor kiểm `coverage`, `status`, `migrationStatus`/block reason **trước** khi chuẩn hóa dữ liệu qua SchemaDiff. Module SchemaDiff hiện chưa tự bảo vệ các trạng thái mới. Chưa mở lại Apply chỉ vì collector có fingerprint.
5. Giữ các nhóm sửa migration, selective restore, privacy và diagnostics riêng theo `GEMINI_IMPLEMENTATION_HANDOFF.md`. Chưa coi B02 hay toàn bộ G6 hoàn tất.
