# Sửa lỗi sau review vòng 5 — 18/11/2026

> **Trạng thái hiện tại:** [Review cuối, các lỗi đã sửa và việc chưa làm](CODE_REVIEW_FINAL_2026_11_18.md). Các số liệu/findings phía dưới giữ lịch sử trước lượt chốt này.

Đã sửa V01–V04 theo yêu cầu người dùng trên working tree của `7ede1a6`. Phạm vi là bốn nhóm lỗi restore còn mở ở vòng 5 và các trường hợp liên quan trực tiếp; không phải chứng nhận hoàn tất B02–B18 hoặc toàn bộ roadmap. Chưa commit trong lượt này; các thay đổi Gemini có sẵn được giữ nguyên.

## Thay đổi và bằng chứng

| Finding | Cách sửa | Kiểm chứng |
| --- | --- | --- |
| V01 — grammar/context | Thêm `restore-context-policy.cjs`, dùng chung ở planner và executor. Quét toàn bộ staging trước mở writer/pre-drop. Chỉ nhận SQL mode trong allowlist không đổi cách đọc quote/escape. Kiểm mode/FK/autocommit thực tế trên worker, thiếu facts thì từ chối. Pin UTF-8 và `completion_type=0` trên worker riêng. | Mode trong dump và mode ban đầu NO_BACKSLASH_ESCAPES/ANSI_QUOTES bị chặn trước DDL/DML. Main IPC trả lỗi với 0 query cho plan bị chặn; DB marker có sẵn giữ nguyên khi yêu cầu dropExisting. |
| V02 — assignment/autocommit | Phân biệt user variable và system/session variable; `@autocommit` không đổi tracker. DEFAULT/biểu thức chưa chứng minh bị chặn trước ghi. Lấy autocommit ban đầu từ server; chỉ cập nhật tracker sau ACK; không nhận nhiều system AUTOCOMMIT assignment trong một SET. | Unit kiểm @autocommit, DEFAULT, giá trị kế thừa và chuyển 0→1 khi transaction rỗng. MySQL xác nhận INSERT chưa COMMIT không còn sau khi worker đóng; không báo success. |
| V03 — commit ledger | COMMIT và chuyển AUTOCOMMIT 0→1 có pending writes được đánh dấu in-flight trước gửi; không xóa pending state trước ACK. Giữ committed ledger khi lệnh sau thất bại. ROLLBACK TO và mở transaction mới khi còn pending writes bị từ chối. | Unit/Main IPC giữ `executionUncertain`, `partialCommit`, `targetChanged` khi mất ACK. MySQL thực thi COMMIT thật rồi mô phỏng mất ACK ở driver: dữ liệu đã bền vững và kết quả được báo uncertain. |
| V04 — worker lifecycle | Dùng lại `createWorkerGuard` cho connect/USE/raw, hủy/deadline, cleanup và late completion. Close có giới hạn thời gian, lỗi close không trả success. | Fake worker connect hoàn tất sau timeout không có AbortSignal và sau cancel đều được close lại; worker không còn open. Close treo bị kết thúc bằng lỗi trong giới hạn guard. |

Ngoài ra, generation/fingerprint guard chặn kế hoạch đang tạo quay lại cache sau logout/reset hoặc sau khi profile đích đổi, kể cả khoảng await resolveBackup ở Main. Test giữ metadata collect đang chờ rồi clear/đổi profile, xác nhận không có pending plan được lưu. Stream parser giữ nguyên `--` khi không có whitespace phía sau và kết thúc line comment đúng cả CR/LF, tránh tự biến câu SQL thành câu khác. Các fake worker cũ được bổ sung session facts thật theo hợp đồng mới; không bỏ các assertion về phạm vi, ledger hoặc policy.

## Phạm vi SQL được hỗ trợ

- SQL mode allowlist: ONLY_FULL_GROUP_BY, STRICT_TRANS_TABLES, STRICT_ALL_TABLES, NO_ZERO_IN_DATE, NO_ZERO_DATE, ERROR_FOR_DIVISION_BY_ZERO, NO_ENGINE_SUBSTITUTION, NO_AUTO_VALUE_ON_ZERO, NO_AUTO_CREATE_USER, IGNORE_SPACE; mode rỗng được hỗ trợ. Server có thể từ chối mode không tồn tại ở phiên bản của nó.
- SQL mode khác, SET expression tùy ý, charset không chứng minh được và AUTOCOMMIT DEFAULT bị từ chối. Không chạy UDF/biểu thức động để đoán giá trị context.
- Hỗ trợ save/restore biến context bằng SET thông thường, bao gồm tên user variable không phân biệt hoa thường. Chỉ worker riêng được thay đổi; không sửa global cấu hình server.
- **Executable comment MySQL/MariaDB và optimizer hint chưa được chứng minh theo engine/version nên bị từ chối trước ghi trong selective restore.** Dump có `/*!...*/`, `/*M!...*/` hoặc `/*+...*/` thực sự phải chờ gói hỗ trợ dialect/version; không tự bỏ conditional clause hoặc tự sửa dump. Chuỗi literal chứa các ký tự này vẫn hợp lệ. Các đường restore khác không được tuyên bố có cùng chứng nhận.
- `executedCount` đếm lệnh đã ACK, không phải số lệnh committed. DDL có thể implicit commit; báo lỗi không có nghĩa mọi thay đổi đã rollback. Mất ACK được báo uncertain, không tự thử lại.

## Kiểm tra đã chạy

| Kiểm tra | Kết quả |
| --- | --- |
| `npm run check` | **1.191 pass / 0 fail / 15 opt-in skip**, 1.206 tests tổng. Gồm syntax check module mới và toàn bộ Node suite. |
| `test/restore-safety-fixes.test.cjs` | **15/15 pass**, gồm parser/policy, executor, late cleanup và Main IPC thật trong VM. |
| MySQL riêng: `test/restore-safety-mysql.test.cjs` | **6/6 pass**, gồm test cha và 5 kịch bản, MySQL **8.0.46**. Không skip trong lượt opt-in này. |
| `npm run test:renderer` | Lượt đầu lỗi autocomplete tại `renderer-smoke.cjs:860` (danh sách rỗng); chạy riêng lại **100/100 pass**, không sửa renderer. **Chưa xác định nguyên nhân, không coi flaky này đã được sửa.** |
| `npm run test:website` | **14/14 pass**. |
| `npm --prefix server run check` | Đạt. |
| `npm run server:test` | **17/17 pass**. |
| `git diff --check` | Đạt. |

MySQL được khởi tạo bằng datadir riêng trong `/tmp`, `--skip-networking`, socket riêng; test chỉ tạo/xóa database có tên ngẫu nhiên của chính test và kiểm tra bảng `untouched` có marker. Không kết nối DB người dùng. Mô phỏng lost ACK là lỗi driver sau COMMIT thật, không phải fault injection trên mạng. Server tạm được tắt và datadir được dọn sau kiểm tra.

Test DB có thể chạy lại trên server test riêng:

```bash
SQLPRO_RESTORE_TEST_SOCKET=/path/to/disposable/mysql.sock node test/restore-safety-mysql.test.cjs
```

Probe kiểm tra lại: [observed-r5-fixed.json](review/gemini-2026-11-18/observed-r5-fixed.json). Probe đã thêm session facts vào fake worker để phù hợp hợp đồng mới. `observed-r5.json` giữ nguyên bằng chứng trước sửa; probe exit 0 không thay cho assertions của test.

## Việc còn lại cho Gemini

1. Kiểm chứng restore subset trên **MariaDB và MySQL phiên bản khác**, đặc biệt grammar/mode/transaction/cancel/indirect trigger effects. Muốn hỗ trợ conditional comments phải bind engine/version và cùng interpretation giữa plan/apply, có marker ngoài selection và test 0-write khi không chứng minh được.
2. Điều tra smoke autocomplete không ổn định ở `renderer-smoke.cjs:860`; có bằng chứng tái hiện rồi mới sửa runtime hoặc đồng bộ hóa test. Không thêm sleep hoặc bỏ assertion để làm xanh.
3. Giữ migration/data-sync public Apply ở chế độ khóa đến khi có evidence được Main sở hữu, drift/approval/transaction matrix và DB integration đủ. Lượt này không mở capability hoặc đổi trạng thái nghiệm thu những gói đó.
4. Tiếp tục các gói tồn đọng trong handoff: UI/tích hợp crypto–replica–cron–recovery, metadata/filter/SQL Editor, refactor/UX, performance toàn luồng, installed/upgrade và release matrix. Checklist roadmap vẫn **29/51 chưa tick** tại mốc bàn giao, không tự tick bằng test helper.
