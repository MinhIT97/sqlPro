# Review Gemini — vòng 3, 18/11/2026

> **Trạng thái hiện tại:** [Review cuối, các lỗi đã sửa và việc chưa làm](CODE_REVIEW_FINAL_2026_11_18.md). Các số liệu/findings phía dưới giữ lịch sử trước lượt chốt này.

> **Cập nhật sau sửa lỗi 18/11:** [Kết quả sửa V01–V04](CODE_REVIEW_GEMINI_2026_11_18_R5_FIXES.md) là trạng thái mới nhất. Nội dung review bên dưới giữ nguyên làm lịch sử trước sửa.

**Trạng thái mới nhất xem [review vòng 5](CODE_REVIEW_GEMINI_2026_11_18_R5.md).** Findings vòng 3/vòng 4 bên dưới là snapshot lịch sử; bản mới đã sửa các probe tương ứng nhưng còn mode/transaction/late cleanup cần xử lý.

**Đã có [review vòng 4](CODE_REVIEW_GEMINI_2026_11_18_R4.md):** missing approval token và replica race đã được sửa trong phạm vi kiểm chứng; còn 4 nhóm (1 P0, 3 P1) về literal-sensitive parser, transaction, ledger/IPC và worker lifecycle. Tài liệu vòng 3 này giữ snapshot trước bản sửa mới.

**Chưa đạt nghiệm thu: còn 5 nhóm findings (2 P0, 3 P1).** Có cải thiện thật so với vòng 2, nhưng sửa approval đã tạo đường bỏ qua xác nhận Production. Selective restore cũng chưa giữ phạm vi database/đối tượng với ALTER RENAME. Không chấp nhận kết luận “8/8 triệt để” chỉ dựa các probe cũ.

Phạm vi: working tree chưa commit trên HEAD `7ede1a6`, package `0.3.12`; Node `v22.22.3`, Electron `45.0.0`. Review lại bản sửa sau [vòng 2](CODE_REVIEW_GEMINI_2026_11_18_R2.md). Lượt này chỉ review, chạy kiểm chứng và cập nhật tài liệu/evidence, không sửa runtime hoặc commit. Mọi lệnh SQL dưới đây chỉ gửi đến fake driver, không chạy trên DB người dùng.

## 1. Findings cần sửa

### T01 — P0: Thiếu approval token vẫn thực thi selective restore trên Production

- Vị trí: `electron/main.cjs:199`, `:247`, `:2425`; `electron/restore-selection-executor.cjs:170`.
- `OperationApprovalManager.authorizeProduction()` nay trả `null` khi thiếu/sai/hết hạn token hoặc receipt không khớp. Executor chỉ `await authorizeProduction(...)`, không kiểm receipt trả về; vì vậy lỗi xác thực bị xem như thành công. Đây là regression từ bản trước dùng throw để chặn.
- Probe `productionWithoutApproval`: dùng store/Main thật trong VM, planner thật với metadata worker giả để tạo plan cho profile `environment:'production'`; gọi **handler `db:apply-selective-restore-plan` thật, không gửi approvalToken**. Kết quả `ok:true`, `success:true`; fake worker ghi nhận CREATE TABLE và INSERT. Không thay hook authorizeProduction bằng stub.
- Khóa public Data Sync Apply không chặn handler restore. Cùng mẫu await không kiểm receipt còn ở DataSyncExecutor nội bộ; giữ sync khóa đến khi sửa.
- Cần sửa: authorization phải fail closed ở cả issuer/verifier và executor; receipt null/false/thiếu/sai phải chặn trước khi mở worker. Native response Hủy không được cấp quyền, token phải bind type/full plan hash/fingerprint/generation/TTL/one-use. Không sửa bằng cách biến null thành receipt mặc định.
- Test nhận: **Main VM thật**, Production với missing/random/expired/replayed/canceled/mismatched token đều 0 write và không mở execution worker. Test module chỉ trả receipt giả không đủ chứng minh boundary này.

### T02 — P0: ALTER RENAME vẫn ghi ngoài target; selection tiếp tục nhầm exact-case tên bảng

- Vị trí: `electron/restore-selection-executor.cjs:108`, `:229`, `:390`, `:406`; `electron/restore-object-inventory.cjs:181`.
- Bản sửa kiểm đủ danh sách DROP nhưng các lệnh khác vẫn chỉ lấy tên đối tượng đầu tiên. `ALTER TABLE users RENAME TO other_db.victim` nhận diện `users` được chọn rồi gửi nguyên câu SQL; không kiểm destination của RENAME.
- Probe `alterRenameOutside`: planner `ready`, target `sample`, selection `users`; executor phát `ALTER TABLE users RENAME TO other_db.victim`, trả success. Đây là trực tiếp thay đổi đối tượng ngoài schema đã phê duyệt; không cần routine/trigger hay dynamic SQL.
- Probe `caseTable`: chỉ chọn `users` nhưng `INSERT INTO Users VALUES (1)` vẫn được gửi vì isSelected dùng exact **hoặc** lowercase match. Bổ sung Set exact không có tác dụng bảo vệ nếu vẫn OR với Set lowercase. Trên engine/config phân biệt tên bảng, đây có thể là bảng khác. Planner cũng còn các map lowercase cần kiểm lại.
- Cần sửa: dùng shared scope parser/guard, kiểm toàn bộ write references và rename destinations; exact-case identity theo capability đã xác minh. Không tự cho phép biến thể chưa phân tích đủ. Preflight toàn bộ phần được phép thực thi trước write đầu tiên, bám authorized steps thay vì chỉ lọc lại basename.
- Test nhận: ALTER RENAME trong/cross schema, tên cũ/mới đều phải thuộc phạm vi đã duyệt; quoted/escaped identifiers, `users`/`Users`, CREATE/ALTER nhiều target; invalid plan phải 0 DDL/DML qua handler thật. Không mở rộng parser theo từng ví dụ mà bỏ qua các write target còn lại.

### T03 — P1: Theo dõi transaction bằng regex vẫn báo restore thành công khi chưa commit

- Vị trí: `electron/restore-selection-executor.cjs:333`, `:348`, `:439`.
- Marker `autocommitDisabled` chỉ nhận literal `0|OFF`; `SET AUTOCOMMIT=FALSE` qua assertRestoreSet nhưng không bật marker. Probe `autocommitFalse` phát SET + INSERT, không có COMMIT, rồi trả success.
- Marker `inTransaction` luôn bị xóa khi gặp COMMIT. Probe `commitChain` phát `START TRANSACTION; INSERT...; COMMIT AND CHAIN; INSERT...` và trả success mà không commit transaction mới.
- MySQL định nghĩa FALSE tương đương 0; tắt autocommit yêu cầu commit để chấp nhận transaction. `AND CHAIN` mở transaction mới sau khi kết thúc transaction hiện tại. Vì vậy các trace trên chưa chứng minh DML cuối đã ghi bền vững; với InnoDB, dữ liệu chưa commit có thể bị rollback khi đóng kết nối. Đây là đối chiếu semantics và trace fake driver, **chưa phải kết quả DB integration thật**. Nguồn chính thức: [boolean constants](https://dev.mysql.com/doc/refman/8.4/en/numeric-type-syntax.html), [autocommit](https://dev.mysql.com/doc/refman/8.4/en/server-system-variables.html), [COMMIT AND CHAIN](https://dev.mysql.com/doc/refman/8.4/en/commit.html).
- Cần sửa: chốt subset transaction/session-context hỗ trợ; ngoài subset phải blocked trước write. Dùng trạng thái server đã xác minh và ownership transaction, không suy bền vững từ vài token regex. Xử lý COMMIT/ROLLBACK AND CHAIN, completion_type, savepoint, implicit commit và expression/biến user khi nằm trong scope được hỗ trợ.
- Test nhận: 0/OFF/FALSE, quoted identifier, @@SESSION, expression, CHAIN/NO CHAIN, rollback/savepoint và lỗi COMMIT. DB marker riêng phải đối chiếu dữ liệu sau khi worker đóng; executedCount không phải committedCount.

### T04 — P1: Cancel chưa ngắt worker treo; mất ACK DDL đầu tiên bị báo chưa đổi target

- Vị trí: `electron/restore-selection-executor.cjs:137`, `:271`, `:406`, `:458`, `:472`; `electron/main.cjs:628`, `:2427`.
- Đã sửa tên operation/controller nên signal nhận abort, nhưng worker thực thi chưa được gắn vào transfer.session và không có guard race/deadline qua connect/USE/raw/close. `statementTimeoutMs` chỉ khai báo, không được dùng vào lời gọi raw trong executor này. Signal chỉ được kiểm giữa các await.
- Probe `cancelHungDdl`: Main handler thật đang await CREATE trên fake driver; cancelDatabaseTransfer trả true nhưng handler chưa kết thúc cho đến khi test tự giải phóng query. Worker có thể giữ operation/slot/cleanup vô hạn nếu driver không trả về. Mốc chờ ngắn trong probe chỉ chứng minh cancel không race query; đọc code xác nhận không có deadline riêng để ngắt nó.
- Probe `firstDdlTimeout`: worker nhận CREATE rồi throw `ECONNRESET` trước ACK. Executor trả `partialCommit:false`, `targetChanged:false`, không có executionUncertain vì executedCount chỉ tăng sau ACK. Server có thể đã chạy DDL, nên không thể khẳng định chưa đổi target. Cleanup lỗi cũng tiếp tục bị nuốt; kiểm context giữa statements chưa giải quyết in-flight uncertainty.
- Cần sửa: reuse worker guard/job lifecycle đã có (có xử lý connect mở muộn và close deadline), cancel đúng worker, giữ lease/reservation tới cleanup. Lập ledger phân biệt chưa gửi/đã gửi/ACK/uncertain; không tự retry hoặc hứa rollback khi mất ACK. IPC error projection phải giữ outcome an toàn để UI không hiểu nhầm.
- Test nhận: cancel/reset/logout lúc connect/USE/DDL/close treo, query ACK trả muộn, disconnect DDL đầu/cuối, cleanup fail. Không chỉ kiểm signal.aborted hoặc code QUERY_CANCELED; kiểm thời hạn kết thúc, worker destruction, ledger và reservation.

### T05 — P1: Replica “no-clobber” vẫn có race ghi đè backup mới xuất hiện

- Vị trí: `electron/backup-replica-manager.cjs:53`, `:84`, `:88`.
- existsSync + tăng counter chỉ tránh file đã có tại thời điểm kiểm tra; publication vẫn dùng rename đè file sau một chuỗi await hash/copy/fsync. Hai tác vụ/process chọn cùng tên hoặc tệp xuất hiện trong lúc copy sẽ bị ghi đè dù overwrite:false.
- Probe `replicaRace`: inject tệp `CONCURRENT BACKUP` ngay khi vào copyAtomic (sau bước chọn tên), rồi chạy copyAtomic thật. Hàm trả verified:true và tệp đích thành `NEW BACKUP`. Tệp mới xuất hiện bị mất. Lỗi collision đơn giản vòng 2 đã sửa, collision lúc publication chưa sửa.
- Cần sửa: cơ chế publication no-replace/exclusive có hiệu lực tại thời điểm xuất bản, chọn tên lại khi collision; không coi rename nguyên tử là no-clobber. Quản lý sidecar tương ứng và phối hợp file locks/source identity/retention; overwrite phải là scope riêng được chấp thuận.
- Test nhận: file xuất hiện giữa check/publication, hai copy đồng thời, suffix đã có, dangling symlink và sidecar collision, crash/disk-full. Bản tốt tồn tại trước publication luôn được giữ khi overwrite:false.

## 2. Phần sửa vòng 2 được xác nhận

| Nhóm vòng 2 | Kết quả đối chiếu lần này |
| --- | --- |
| S01 | Multi-object DROP ngoài database và qualified INSERT khác case database đã bị planner blocked trước write trong probe cũ. Chưa bao phủ ALTER destination/exact-case selection — T02. |
| S02 | Đã tạo staging, hash staging và chạy từ staging; đổi nguồn lúc connect bị từ chối. Probe file-swap cũ không còn chạy SQL bị thay. Chưa tự chứng nhận đầy đủ file lifecycle/cleanup/quota/crash. |
| S03 | AUTOCOMMIT=0 thiếu COMMIT không còn báo success. Các cú pháp khác và CHAIN vẫn sai — T03. |
| S04 | Tên operation/controller đã khớp, signal abort; read-only drift lúc connect đã chặn CREATE/INSERT. Worker in-flight/deadline/uncertainty chưa đạt — T04. |
| S05 | Tệp đích đã tồn tại được giữ và replica chuyển sang suffix. Race lúc publication còn — T05. |
| S06 | Native `{response:0}` không còn cấp receipt, hash/fingerprint có cải thiện. Nhưng null receipt làm executor bỏ qua approval — T01 (regression nghiêm trọng hơn trạng thái bị chặn trước đó). |
| S07 | Probe cũ scope mutation và shallow operations đã đạt: scopes được clone, operations freeze, digest có tables/orders. Không đồng nghĩa Main-owned report/engine/typed write guards đã nghiệm thu; public sync vẫn phải khóa. |
| S08 | Progress Main dùng sendDbProgress, async rejection không còn unhandled trong probe cũ. Giữ kết quả theo phạm vi này; chưa có full UI/new capability evidence. |

Không gộp T01–T05 với các cách nhóm R/S cũ để tạo tổng bug cộng dồn. Các tài liệu R1/R2 là snapshot lịch sử; đây là mốc review hiện hành.

## 3. Kiểm tra đã chạy

| Kiểm tra | Kết quả |
| --- | --- |
| npm run check | **1.180 tests: 1.166 pass, 0 fail, 14 skip** |
| npm run test:renderer | **100/100** |
| npm run test:website | **14/14** |
| npm --prefix server run check | Đạt |
| npm run server:test | **17/17** |
| git diff --check | Đạt |

Probe vòng 1/vòng 2 vẫn chạy được nhưng không kiểm các trường hợp T01–T05. Các assertions regression mới có giá trị cho ví dụ được kiểm, chưa chứng minh “100% resolved” hoặc Production flow. Đặc biệt manager trả authorized:null trong probe là kết quả verifier từ chối; phải kiểm caller cũng từ chối trước write.

Evidence: [probe bổ sung vòng 3](review/gemini-2026-11-18/reproduce-r3.cjs), [output vòng 3](review/gemini-2026-11-18/observed-r3.json), [probe vòng 2 chạy lại trên bản mới](review/gemini-2026-11-18/observed-r3-old-r2-probes.json).

```bash
node review/gemini-2026-11-18/reproduce-r3.cjs
```

Probe dùng Main VM/module thật với store/metadata/SQL driver giả và tệp tạm riêng. Planner của case Production là service Main thật; bước Apply đi qua IPC handler thật. Tệp đích race được tạo bằng test hook trước copyAtomic thật, không giả kết quả rename. Script in quan sát; exit 0 không phải chứng nhận an toàn.

Không chạy DB người dùng, MySQL/MariaDB integration opt-in, installed/upgrade hoặc large end-to-end benchmark trong lượt này. Database semantics ở T03 được đối chiếu tài liệu chính thức; vẫn cần DB tests để nghiệm thu sản phẩm.

## 4. Giao sửa tiếp cho Gemini

1. **T01 trước:** giữ selective restore Apply fail-closed cho đến khi Main VM chứng minh missing/invalid/null receipt không có write. Giữ sync/migration Apply khóa. Không chỉ sửa verifier; kiểm cả caller.
2. **T02:** một scope parser/authorized-step contract dùng chung cho planner/executor; kiểm toàn bộ ALTER/rename targets và exact-case identifiers. Nộp regressions trước khi mở lại phạm vi này.
3. **T03/T04:** thiết kế rõ state machine transaction và worker lifecycle; reuse guard hiện có, không bổ sung regex theo từng test để gọi là hoàn tất. Đối chiếu DDL ACK uncertainty và bảo toàn partial outcome qua IPC/UI.
4. **T05:** publication no-replace thực sự; regression concurrent copy/file preservation, sidecars và crash boundaries.
5. Gửi từng diff nhỏ và log test review lại. Không chuyển gói mới hoặc cập nhật “release-ready” trước khi các P0/P1 trên đóng với bằng chứng đúng boundary. Roadmap vẫn 29/51 mục chưa tick; backlog DB/UI/cron/recovery/installed/release ở các báo cáo trước chưa có bằng chứng hoàn thành mới.
