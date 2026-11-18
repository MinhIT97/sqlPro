# Review Gemini — vòng 5, 18/11/2026

> **Trạng thái hiện tại:** [Review cuối, các lỗi đã sửa và việc chưa làm](CODE_REVIEW_FINAL_2026_11_18.md). Các số liệu/findings phía dưới giữ lịch sử trước lượt chốt này.

> **Cập nhật sau sửa lỗi 18/11:** [Kết quả sửa V01–V04](CODE_REVIEW_GEMINI_2026_11_18_R5_FIXES.md) là trạng thái mới nhất. Nội dung review bên dưới giữ nguyên làm lịch sử trước sửa.

**Chưa nghiệm thu: còn 4 nhóm findings (1 P0, 2 P1, 1 P2).** Các probe vòng 4 đã được sửa trong phạm vi được kiểm, nhưng chưa đủ kết luận “4/4 triệt để”. Những khoảng trống còn lại nằm ở SQL mode, phân biệt user/system variables, ACK của COMMIT và cleanup connection mở muộn sau timeout.

Phạm vi: working tree chưa commit trên `7ede1a6`, package `0.3.12`, Node `v22.22.3`/Electron `45.0.0`; đối chiếu bản sửa sau [vòng 4](CODE_REVIEW_GEMINI_2026_11_18_R4.md). Chỉ review, chạy test/probe và cập nhật evidence/tài liệu; không sửa runtime hoặc commit. SQL chỉ gửi driver giả; không chạy DB người dùng.

## 1. Findings còn phải sửa

### V01 — P0: Tokenizer không gắn SQL mode, vẫn phát ALTER ra ngoài target khi NO_BACKSLASH_ESCAPES

- Vị trí: `electron/sql-script.cjs:424`, `:461`, `:636`; `electron/restore-selection-executor.cjs:357`; `electron/restore-object-inventory.cjs:227`.
- Lexer mới phân biệt literal/comment tốt hơn nhưng luôn coi backslash trong string là escape; SQL parser chia statement cũng dùng giả định này. Trong khi đó dump được phép chạy `SET SQL_MODE='NO_BACKSLASH_ESCAPES'`, và lexer/planner không đổi grammar hay chặn mode chưa hỗ trợ. Đọc previousSqlMode để cleanup không ràng buộc cách parse với mode thực tế.
- Probe `modeParser`/`mainSqlMode` dùng đoạn sau sau CREATE TABLE users:

```sql
SET SQL_MODE='NO_BACKSLASH_ESCAPES';
ALTER TABLE `users` COMMENT='x\', RENAME TO `other_db`.`victim` -- '
;
```

- Theo NO_BACKSLASH_ESCAPES, dấu backslash trong COMMENT là ký tự thường; quote tiếp theo kết thúc literal, RENAME là cú pháp thật, quote cuối nằm trong line comment. Lexer hiện tại lại xem quote sau backslash là escaped, gộp phần RENAME vào string đến quote trong comment. `parseAlterRename` trả destinations rỗng.
- Planner thật trả ready; **handler Apply Main thật trong VM** phát SET mode và toàn bộ ALTER sang driver giả, rồi trả `ok:true`. Không thay scope guard bằng stub. Mode-dependent interpretation được đối chiếu [MySQL string literals](https://dev.mysql.com/doc/refman/8.4/en/string-literals.html) và [SQL modes](https://dev.mysql.com/doc/refman/8.4/en/sql-mode.html). Chưa chạy câu này trên MySQL thật trong lượt review; bằng chứng thực thi ở đây là phát SQL qua Main/fake driver, không phải dữ liệu đã đổi trên DB thật.
- Cần sửa: bind dialect/version/SQL mode/charset vào bằng chứng nguồn-đích và parser/executor; hoặc fail-closed khi mode/SET thay đổi mode chưa nằm trong subset được xác minh. Không cho cùng một SQL được parser và server hiểu khác nhau. Không thêm regex chỉ chặn chuỗi exploit cụ thể; preflight phải kiểm byte stream theo đúng grammar sẽ được chạy.
- Test nhận: NO_BACKSLASH_ESCAPES/ANSI_QUOTES, mode ban đầu và mode thay đổi trong dump, escaped/doubled quotes/backticks, executable comments theo engine/version. Mọi trường hợp chưa hiểu phải blocked trước write. Cần Main tests lẫn MySQL/MariaDB test DB riêng có marker.

### V02 — P1: User variable @autocommit làm sai tracker; DEFAULT bị suy thành ON

- Vị trí: `electron/restore-selection-executor.cjs:366`, `:369`; `electron/sql-script.cjs:985`, `:993`.
- Parser đã trả `isUserVar` và scope, nhưng executor chỉ so tên AUTOCOMMIT rồi đổi tracker, không kiểm đó có phải system variable của session hay không.
- Probe `userVariableAutocommit` chạy `SET AUTOCOMMIT=0; SET @autocommit=1; INSERT INTO users VALUES (1)`. @autocommit chỉ là user variable, nhưng tracker chuyển autocommitDisabled thành false; không có COMMIT và executor vẫn success. Đây là lỗi phân biệt loại biến, không phải grammar của literal 0/1.
- evaluateAutocommit còn trả true cho DEFAULT. DEFAULT của session system variable lấy giá trị global tương ứng, không bảo đảm là 1. Probe `defaultAutocommit` xác nhận evaluator tĩnh trả true và executor success; nếu global autocommit=0 thì kết luận đó không đúng. Chưa dựng DB có global=0 trong lượt này. Semantics tham chiếu: [SET variable assignment](https://dev.mysql.com/doc/refman/8.4/en/set-variable.html).
- Cần sửa: cùng một typed assignment model cho validator/executor; chỉ update tracker cho system/session AUTOCOMMIT đã xác minh. Giá trị phụ thuộc server không được suy thành ON; đọc proof phù hợp hoặc blocked. Theo dõi trạng thái sau ACK, không đổi tracker trước rồi coi là trạng thái server.
- Test nhận: @autocommit/@@autocommit, SESSION/LOCAL/GLOBAL, quoted identifiers, DEFAULT với global 0 và 1; error/cancel ở SET; transaction đã tồn tại. DB test phải kiểm dữ liệu sau khi worker đóng, không chỉ executedCount.

### V03 — P1: COMMIT mất ACK chưa vào ledger uncertainty

- Vị trí: `electron/restore-selection-executor.cjs:391`, `:395`, `:639`.
- Đã sửa ledger pre-drop/DML/DDL, nhưng COMMIT vẫn xóa uncommittedWrites trước khi await, không đặt inFlight và không đánh dấu outcome uncertain khi ACK lỗi. partialCommit chỉ được cập nhật trong những nhánh write khác.
- Probe data-only `commitLostAck`: `START TRANSACTION; INSERT INTO users VALUES (1); COMMIT`. Fake worker ACK INSERT, throw ECONNRESET khi COMMIT được gửi. Executor trả `partialCommit:false`, `targetChanged:true`, không executionUncertain. Server có thể đã commit trước khi mất kết nối, nên không được khẳng định không có phần đã commit hoặc retry như an toàn.
- Main đã chiếu outcome tốt hơn, nhưng projection không thể bù field executor chưa tính. Không chỉ sửa cùng vấn đề trong DataSyncExecutor rồi coi restore đã bao phủ.
- Cần sửa: ledger/state machine bao trọn BEGIN/SET autocommit/COMMIT/ROLLBACK và implicit commit theo subset được hỗ trợ. Phân biệt đã gửi/ACK/unknown, giữ uncertainty qua IPC/UI và không tự retry. Không clear transaction proof trước ACK.
- Test nhận: mất ACK COMMIT đầu/cuối, SET AUTOCOMMIT 0→1 có commit, rollback/chain, DDL implicit commit, error trước/sau gửi; assert module và Main response. Dùng DB fixture để kiểm kết quả sau reconnect khi phù hợp, không hứa rollback từ việc client mất kết nối.

### V04 — P2: Late connect sau deadline không được helper đóng lại

- Vị trí: `electron/restore-selection-executor.cjs:259`, `:263`, `:273`.
- Callback late completion chỉ cleanup khi `signal.aborted || timer === null`. Khi deadline timer đã fire, biến timer vẫn giữ handle; finally chỉ clearTimeout, không set null hoặc đánh dấu interrupted. Timeout không đồng nghĩa signal.aborted.
- Probe `lateConnectAfterTimeout`: connect pending, deadline trả STATEMENT_TIMEOUT và cleanup đã chạy; sau đó test release connect, worker đánh dấu connection mở. `closeCountBeforeRelease` và `closeCountAfterRelease` đều 2, `connectionOpenAfterLateCompletion:true`. Script chủ động close cuối cùng để không để lại tài nguyên giả.
- Đây là lỗi contract của helper với createSession worker, **không phải bằng chứng đã rò connection MySQL thật**. DatabaseSession có các biện pháp dead/close riêng có thể giảm rủi ro; helper vẫn chưa thực hiện đúng lời hứa cleanup late completion và tests mới chưa kiểm trạng thái sau release.
- Cần sửa: trạng thái settled/interrupted rõ ràng, timer cleanup tách khỏi cờ timeout; close/destroy late worker bounded và idempotent, không để callback cũ ghi trạng thái job mới. Ưu tiên reuse worker guard đã có thay vì thêm biến thể khác khó đối chiếu.
- Test nhận: timeout không AbortSignal, cancel có signal, connect resolve/reject muộn sau cleanup và sau job mới; assert worker cuối cùng closed/destroyed, không chỉ handler đã reject đúng hạn.

## 2. Phần sửa vòng 4 đã được xác nhận

| Nhóm cũ | Kết quả review lại |
| --- | --- |
| U01 | Literal COMMENT thông thường không còn đánh lừa RENAME; plan bị blocked, Main 0 query trong probe cũ. Chưa bind lexical mode — V01. |
| U02 | Quote/ngoặc AUTOCOMMIT cũ bị báo chưa commit; expression không xác định bị từ chối. Loại biến và DEFAULT còn sai — V02. |
| U03 | Pre-drop ACK được đếm; DML đầu tiên mất ACK có uncertainty; Main giữ partial fields trong probe cũ. COMMIT chưa vào ledger — V03. |
| U04 | Cancel connect settle sớm; raw deadline có timer; cleanup được bọc guard và không query khi chưa connect. Late completion sau timeout chưa cleanup đúng — V04. |

Missing approval token và replica no-replace từ các vòng trước chưa thấy tái phát trong các probe đã chạy. Chưa tự chứng nhận đầy đủ Production UI/receipt matrix, mọi filesystem/platform hoặc toàn bộ roadmap.

## 3. Kiểm chứng

| Kiểm tra chạy lại | Kết quả |
| --- | --- |
| npm run check | **1.190 tests: 1.176 pass / 0 fail / 14 skip** |
| npm run test:renderer | **100/100** |
| npm run test:website | **14/14** |
| npm --prefix server run check | Đạt |
| npm run server:test | **17/17** |
| git diff --check | Đạt |

Không chạy DB người dùng, DB integration opt-in, installed/upgrade hoặc end-to-end performance matrix trong lượt này. Bốn test regression mới của vòng 4 có giá trị cho assertions hiện có; chúng chưa bao phủ mode, loại biến, COMMIT ACK hoặc trạng thái worker sau connect release muộn.

Evidence: [reproduce-r5.cjs](review/gemini-2026-11-18/reproduce-r5.cjs), [observed-r5.json](review/gemini-2026-11-18/observed-r5.json), [probe vòng 4 chạy lại](review/gemini-2026-11-18/observed-r5-old-r4-probes.json).

```bash
node review/gemini-2026-11-18/reproduce-r5.cjs
```

Script in quan sát bằng module/Main VM thật và driver/metadata giả; dùng tệp tạm riêng, đóng late fake connection cuối test. Exit 0 không phải chứng nhận đã fix hoặc nghiệm thu DB thật.

## 4. Giao sửa tiếp cho Gemini

1. **V01 chặn trước:** selective restore writer cần fail-closed cho SQL mode/dialect chưa chứng minh. Chốt một hợp đồng grammar/context/authorized statements; kiểm cùng bytes theo cùng mode từ plan đến apply.
2. Lập bảng assignment/transaction state trước khi sửa V02/V03: user/system scope, static/server-dependent values, trước gửi/ACK/unknown, commit/rollback/implicit commit. Chuyển bảng này thành fixtures thay vì sửa thêm từng chuỗi probe.
3. V04 dùng worker lifecycle guard thống nhất, kiểm tài nguyên sau late completion; deadline reject là một phần của acceptance, không phải toàn bộ cleanup.
4. Mỗi diff nhỏ phải có test fail trước/pass sau ở module **và** Main boundary khi liên quan. Giữ sync/migration Apply khóa, không nhận gói mới hoặc ghi “release-ready” từ unit tests.
5. Roadmap vẫn 29/51 mục chưa tick; DB matrix, UI integration, cron/recovery, installed/upgrade/release chưa có evidence hoàn tất mới. Cần kiểm DB thật có marker cho grammar/mode/transaction sau khi các fail-closed guards được chốt.
