# Review Gemini — vòng 4, 18/11/2026

> **Trạng thái hiện tại:** [Review cuối, các lỗi đã sửa và việc chưa làm](CODE_REVIEW_FINAL_2026_11_18.md). Các số liệu/findings phía dưới giữ lịch sử trước lượt chốt này.

> **Cập nhật sau sửa lỗi 18/11:** [Kết quả sửa V01–V04](CODE_REVIEW_GEMINI_2026_11_18_R5_FIXES.md) là trạng thái mới nhất. Nội dung review bên dưới giữ nguyên làm lịch sử trước sửa.

**Đã có [review vòng 5](CODE_REVIEW_GEMINI_2026_11_18_R5.md):** probe vòng 4 đã được sửa trong phạm vi được kiểm; còn 4 nhóm (1 P0, 2 P1, 1 P2). Tài liệu vòng 4 này giữ snapshot trước bản sửa mới, không phải trạng thái hiện hành.

**Chưa nghiệm thu: còn 4 nhóm findings (1 P0, 3 P1).** Đã xác nhận sửa được missing approval token, các probe ALTER RENAME/case/transaction cũ và no-replace replica. Tuy nhiên parser vẫn nhầm literal với cú pháp SQL, ledger chưa bao phủ mọi write, transaction state và worker lifecycle chưa đầy đủ. Vì vậy chưa chấp nhận “5/5 triệt để”.

Phạm vi: working tree chưa commit trên `7ede1a6`, package `0.3.12`; review bản sửa sau [vòng 3](CODE_REVIEW_GEMINI_2026_11_18_R3.md). Lượt này chỉ review, test và hồ sơ/evidence; không sửa runtime hoặc commit. Tất cả SQL tái hiện gửi tới driver giả, tệp chỉ nằm trong thư mục tạm riêng. Không chạy DB người dùng.

## 1. Findings còn cần sửa

### U01 — P0: Literal trong COMMENT đánh lừa parser RENAME, Main vẫn phát ALTER sang database khác

- Vị trí: `electron/sql-script.cjs:512`, `:520`; `electron/restore-object-inventory.cjs:227`, `:726`; `electron/restore-selection-executor.cjs:440`.
- `parseAlterRename()` tìm RENAME bằng regex trên phần clauses chưa tách token/string/comment. Nó lấy lần xuất hiện đầu tiên kể cả bên trong literal, rồi bỏ qua RENAME thật ở phía sau. Planner và executor dùng chung parser nên cùng chấp nhận kết quả sai; “shared parser” không tự chứng minh ngữ nghĩa đúng.
- Tái hiện với target `sample`, selection `users`:

```sql
ALTER TABLE `users`
  COMMENT='RENAME TO users ignored',
  RENAME TO `other_db`.`victim`;
```

- Parser trả destination `{schema:null,name:'users'}` từ nội dung COMMENT. Plan `ready`; executor phát nguyên câu ALTER và báo success. Case `mainParserBypass` còn gọi **handler Apply Main thật trong VM**, dùng planner thật/metadata giả: nhận `ok:true` và trace ghi sang `other_db`. Không chỉ gọi hàm parser hoặc thay guard bằng stub.
- MySQL cho phép danh sách nhiều alter options và table options trong cùng ALTER; nội dung COMMENT là dữ liệu, không được xem như token RENAME. Tham chiếu cú pháp chính thức: [ALTER TABLE](https://dev.mysql.com/doc/refman/8.4/en/alter-table.html). Chưa chạy câu này trên DB thật trong lượt review; lỗi parsing và việc phát nguyên SQL đã tái hiện offline.
- Cần sửa: tokenizer/parser phân biệt identifier/literal/comment, kiểm **toàn bộ** write references và rename destinations; hoặc fail-closed với subset ALTER chưa phân tích đủ trước khi ghi. Không chỉ thêm regex bỏ một literal COMMENT cụ thể. Authorized steps của plan phải là phạm vi executor được chạy.
- Test nhận: RENAME trong literal, comment và quoted identifier; RENAME thật ở sau; nhiều clauses; escaped quotes/backticks và SQL modes được hỗ trợ. Invalid plan phải 0 DDL/DML qua handler Main, không chỉ parser unit test.

### U02 — P1: AUTOCOMMIT expression/identifier quote vẫn lọt state tracking và báo success thiếu COMMIT

- Vị trí: `electron/restore-selection-executor.cjs:373`, `:377`, `:585`.
- assertRestoreSet cho qua các SET hợp lệ, nhưng tracker vẫn dùng regex chỉ hiểu tên không quote và giá trị literal. Thêm FALSE vào regex đã sửa ví dụ cũ, chưa giải quyết chênh lệch giữa grammar được cho chạy và grammar được theo dõi.
- Hai probe `quotedAutocommit` và `expressionAutocommit` phát lần lượt ``SET `AUTOCOMMIT`=0`` và `SET AUTOCOMMIT=(0)`, tiếp theo INSERT; không phát COMMIT nhưng trả `success:true`. Marker autocommitDisabled không được bật trong cả hai trường hợp.
- SET hỗ trợ expression, nên `(0)` không thể bị xem là “không tắt autocommit” chỉ vì không khớp regex; autocommit tắt yêu cầu commit để ghi nhận transaction. Đây là đối chiếu semantics từ [SET variable assignment](https://dev.mysql.com/doc/refman/8.4/en/set-variable.html) và [autocommit](https://dev.mysql.com/doc/refman/8.4/en/server-system-variables.html), kết hợp trace fake driver; chưa phải kiểm dữ liệu bền vững trên DB thật.
- Cần sửa: xác định subset session/transaction thật sự hỗ trợ, chặn phần còn lại trước write; theo dõi trạng thái server/transaction ownership khi có thể. Không suy committed state từ vài từ khóa hoặc executedCount. Đồng bộ parser cho planner/executor và kiểm cả implicit commit, chain, rollback/savepoint theo phạm vi được hỗ trợ.
- Test nhận: identifier quote, @@SESSION, expression, user-variable/default, nhiều assignments, CHAIN/NO CHAIN; sau khi worker đóng phải kiểm dữ liệu trên DB test có marker. Unknown semantics phải blocked, không success.

### U03 — P1: Ledger bỏ sót DROP đã ACK và DML đầu tiên mất ACK; IPC còn loại bỏ partial outcome

- Vị trí: `electron/restore-selection-executor.cjs:343`, `:348`, `:620`; `electron/main.cjs:877`.
- **DROP chuẩn bị không được tính:** dropOrder chạy DROP trước stream, nhưng không tăng executedCount hoặc ghi committed/changed ledger. Probe `dropThenContextDrift` nhận ACK `DROP TABLE IF EXISTS users`, rồi trusted profile chuyển read-only; câu kế tiếp bị chặn đúng, nhưng lỗi được đính `executedCount:0`, `partialCommit:false`, `targetChanged:false`. Target đã bị tác động trước khi lỗi context phát sinh.
- **DML đầu tiên chưa có ACK không được báo uncertainty:** điều kiện hadInFlightMutating còn yêu cầu executedCount>0. Probe `firstDmlLostAck` là data-only plan, INSERT đầu tiên throw ECONNRESET; kết quả `partialCommit:false`, `targetChanged:false`, không executionUncertain. Với DML autocommit, mất ACK không chứng minh server chưa ghi; không được khuyến khích retry như chưa tác động.
- **Main làm mất bằng chứng đúng của executor:** probe `mainLostAckProjection` đi qua handler thật cho CREATE mất ACK. Executor có thể đã gắn uncertainty ở lỗi DDL, nhưng `handle()` chỉ chiếu message/code/sqlState và vài trường khác, bỏ executedCount/partialCommit/targetChanged/executionUncertain. Renderer không nhận được outcome cần thiết để báo người dùng. Chỉ sửa module assertions không đủ nghiệm thu đường IPC.
- Cần sửa: một ledger ghi mọi bước có tác động, gồm pre-drop và context/transaction commit có liên quan; phân biệt chưa gửi/đã gửi/ACK/uncertain độc lập với số statement trước đó. Chiếu whitelist outcome an toàn qua IPC và UI; không lộ raw SQL/secrets. Không tự retry đoạn chưa biết kết quả.
- Test nhận: pre-drop ACK rồi policy/cancel/parser lỗi; INSERT đầu tiên mất ACK; DDL/DML đầu/cuối và cleanup failure. Assert cả module error lẫn handler response/UI; không chỉ assert error.code.

### U04 — P1: Guard cancel/deadline vẫn chưa bao trọn connect/USE/cleanup

- Vị trí: `electron/restore-selection-executor.cjs:280`, `:313`, `:316`, `:608`; `electron/database.cjs:1122`, `:1135`, `:1238`.
- `runRaw` hiện race abort cho các query gọi qua wrapper; đây là cải thiện thật. Nhưng connect, useDatabase và cleanup raw/close vẫn await trực tiếp, không đi qua worker guard/deadline. Gắn transfer.session không tự race hoặc dọn connection mở muộn.
- Probe `cancelHungConnect`: signal bị abort trong connect chưa hoàn tất; operation không settle cho tới khi test tự release connect. Mốc chờ ngắn chỉ chứng minh cancellation không race phase này, không dùng để suy thời gian mạng thật. Code cũng không có guard chung cho phase này.
- Connect của DatabaseSession có TCP connectTimeout riêng, nhưng sau handshake còn `SELECT VERSION()` và đọc TLS session status bằng raw không timeout; useDatabase cũng raw không truyền timeout. Do đó connectTimeout TCP không chứng minh cả setup/USE đã được giới hạn. Cleanup còn có hai raw không timeout trước close; lỗi bị nuốt.
- Probe `rawDeadline` dùng worker giả không phản hồi để xác nhận wrapper không có timer riêng; **không kết luận mysql2 bỏ qua timeout**, vì DatabaseSession.raw hiện đã nhận timeout option đúng cho các query được bọc. Vấn đề cần sửa là hợp đồng deadline/cancel toàn vòng đời và các phase chưa được bọc.
- Cần sửa: reuse worker guard có sẵn hoặc triển khai hợp đồng tương đương cho connect/USE/collect/raw/close, late completion và cleanup; giữ reservation tới cleanup, không thả slot rồi để worker cũ quay lại. Có timeout driver không thay thế guard ở các await chưa có timeout.
- Test nhận: cancel/reset/logout tại connect/setup/USE/DDL/cleanup treo; release muộn sau cancel không ghi tiếp; close/SSH cleanup có deadline, đúng worker identity và không đụng Editor. Test driver/fake phải kiểm phase đủ rộng, không chỉ một CREATE đang chờ.

## 2. Đối chiếu 5 nhóm vòng 3

| Nhóm cũ | Kết quả review lại |
| --- | --- |
| T01 Production approval | **Lỗi missing/null receipt đã được chặn.** Probe Main thiếu token không phát query; executor kiểm receipt và hook Main throw khi không hợp lệ. Chưa tự nghiệm thu toàn Production approval UI/expiry/context/valid receipt matrix. |
| T02 scope/exact-case | ALTER RENAME đơn giản ngoài schema bị planner blocked; `Users` không còn được thực thi khi chọn `users`. Còn bypass literal — U01. |
| T03 transaction | FALSE và AND CHAIN cũ đã bị báo chưa commit. Identifier quote/expression còn lọt — U02. |
| T04 worker/outcome | Cancel raw đang chờ đã settle trước ACK, DDL đầu tiên mất ACK được module đánh uncertain. Connect/cleanup và ledger/IPC còn thiếu — U03/U04. |
| T05 replica publication | **Race overwrite cũ đã được xử lý trong phạm vi kiểm chứng:** link no-replace giữ `CONCURRENT BACKUP` ở đường dẫn gốc, replica mới đi suffix và chứa `NEW BACKUP`. Probe vòng 4 kiểm cả đường dẫn gốc lẫn đường dẫn trả về; không suy từ việc đọc riêng replicaPath. Sidecars/remote platform/durable publication/release vẫn cần matrix tương ứng. |

Đây là 4 **nhóm** findings, không cộng cơ học với các cách nhóm R/S/T cũ. Tài liệu và nhận định “đã hoàn thành” của Gemini trước review giữ làm lịch sử, không phải nghiệm thu.

## 3. Kiểm chứng

| Kiểm tra chạy lại | Kết quả |
| --- | --- |
| npm run check | **1.186 tests: 1.172 pass / 0 fail / 14 skip** |
| npm run test:renderer | **100/100** |
| npm run test:website | **14/14** |
| npm --prefix server run check | Đạt |
| npm run server:test | **17/17** |
| git diff --check | Đạt |

Chưa chạy DB thật/integration opt-in, bộ cài/upgrade hoặc end-to-end benchmark. Test xanh chứng minh các assertions hiện có đạt, không chứng minh không còn bug hoặc mọi capability hoàn tất.

Evidence mới: [reproduce-r4.cjs](review/gemini-2026-11-18/reproduce-r4.cjs), [observed-r4.json](review/gemini-2026-11-18/observed-r4.json). Probe vòng 3 chạy lại trên bản sửa mới: [observed-r4-old-r3-probes.json](review/gemini-2026-11-18/observed-r4-old-r3-probes.json).

```bash
node review/gemini-2026-11-18/reproduce-r4.cjs
```

Script chỉ in quan sát, dùng services và Main VM thật với driver/metadata giả, tạo tệp tạm riêng; mọi promise treo được test giải phóng trước cleanup. Exit 0 không có nghĩa findings đã được sửa. Cần chuyển probe thành assertion regression đúng boundary, gồm Main response cho partial/uncertain.

## 4. Giao sửa tiếp cho Gemini

1. **U01 trước:** giữ selective restore Apply fail-closed cho phạm vi chưa được chứng minh an toàn. Chốt tokenizer/grammar hoặc subset có thể kiểm đầy đủ; literal/comment/identifier không được xem là keyword. Planner và executor phải đồng thuận toàn bộ authorized statements.
2. **U02:** thống nhất grammar SET/transaction được cho phép với state tracking/server verification. Case không xác minh được phải blocked trước write, không thêm literal vào regex rồi gọi là hoàn thành.
3. **U03:** ledger mọi tác động từ pre-drop tới DML/COMMIT/cleanup; giữ partial/uncertain qua Main projection và UI. Thiết kế contract rồi mới sửa từng nhánh, tránh đếm ACK thiếu bước.
4. **U04:** reuse worker lifecycle guard xuyên tất cả phase, kiểm late connection và cancellation/cleanup thực; bảo toàn Editor và reservation. Không chỉ truyền timeout vào raw.
5. Giữ khóa sync/migration Apply, không nhận gói tính năng mới trước khi đóng P0/P1 này với diff/test phù hợp. Roadmap vẫn 29/51 mục chưa tick; các mục DB matrix/UI/cron/recovery/installed-release chưa có bằng chứng hoàn tất mới trong lượt này.
