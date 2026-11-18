# Review lại bản sửa Gemini — vòng 2, 18/11/2026

> **Trạng thái hiện tại:** [Review cuối, các lỗi đã sửa và việc chưa làm](CODE_REVIEW_FINAL_2026_11_18.md). Các số liệu/findings phía dưới giữ lịch sử trước lượt chốt này.

> **Cập nhật sau sửa lỗi 18/11:** [Kết quả sửa V01–V04](CODE_REVIEW_GEMINI_2026_11_18_R5_FIXES.md) là trạng thái mới nhất. Nội dung review bên dưới giữ nguyên làm lịch sử trước sửa.

**Trạng thái mới nhất xem [review vòng 4](CODE_REVIEW_GEMINI_2026_11_18_R4.md).** Các mô tả findings vòng 2/vòng 3 dưới đây là lịch sử đối chiếu, không phải trạng thái bản đang review.

**Đã có [review vòng 3](CODE_REVIEW_GEMINI_2026_11_18_R3.md):** các probe cũ đã cải thiện, nhưng còn 5 nhóm (2 P0, 3 P1), bao gồm Production restore chạy khi thiếu approval token. Tài liệu này giữ snapshot findings vòng 2; trạng thái mới xem vòng 3.

**Chưa đạt nghiệm thu. Không xác nhận “đã xử lý triệt để 12/12”.** Bản sửa có tác dụng thực: public Data Sync Apply đã khóa, loop migration cũ đã gỡ, decrypt sai mật khẩu giữ tệp đích, quota và FULLTEXT có cải thiện. Tuy nhiên selective restore vẫn phát được lệnh xóa ngoài selection/database, và các khoảng trống file/context/cancel chưa được xử lý đầy đủ.

Phạm vi: working tree trên `7ede1a6`, gồm bản sửa Gemini sau [review vòng 1](CODE_REVIEW_GEMINI_2026_11_18.md). Chỉ review, chạy test/probe và cập nhật hồ sơ; **không sửa runtime hoặc commit**. Mọi tái hiện dùng fake SQL driver và thư mục tạm, không ghi DB người dùng.

## Findings còn phải sửa

Có **8 nhóm findings: 1 P0, 4 P1, 3 P2**. Các nhóm này đối chiếu lại các lỗi cũ và bản sửa, không cộng thành 20 lỗi độc lập với 12 findings vòng 1.

### S01 — P0: Multi-object DROP vượt bộ lọc selective restore

- Vị trí: `electron/restore-selection-executor.cjs:59`, `:68`, `:227`, `:243`.
- Regex chỉ lấy đối tượng đầu tiên, sau đó thực thi nguyên câu SQL. Với selection `users`, `dropExisting:true`, dump có `DROP TABLE users, other_db.victim` được planner báo ready và executor phát nguyên lệnh rồi trả success. Bảng `victim` không được chọn, schema `other_db` cũng không phải target `sample`.
- Tái hiện qua RestorePlanService và RestoreSelectionExecutor thật với fake worker; xem `multiDrop` trong evidence. Đây là biến thể của R02 vẫn mở qua public restore Apply, không được bảo vệ bởi việc khóa Data Sync.
- So sánh schema còn dùng `.toLowerCase()` ở dòng 53/68; probe `caseDatabase` phát `INSERT INTO SAMPLE.users` dù target là `sample`. Trên server phân biệt hoa/thường, đó có thể là database khác. Selection cũng lowercase mọi tên, không giữ exact-case identity.
- Cần sửa: parse/kiểm toàn bộ đối tượng bị tác động và schema exact-case; từ chối statement chưa phân tích đầy đủ; executor chỉ chạy authorized steps. Dùng chung guard restore hiện có thay vì regex kiểm tên đầu. Preflight toàn bộ phần được phép chạy trước DDL đầu tiên.
- Test nhận: DROP nhiều bảng/view, đối tượng thứ hai không được chọn hoặc nằm ngoài target, quoted/escaped names, case-sensitive target. Handler Main thật phải phát **0 DDL/DML** khi kế hoạch không hợp lệ.

### S02 — P1: SHA-256 vẫn có khoảng TOCTOU trước stream thực thi

- Vị trí: `electron/restore-selection-executor.cjs:136`, `:177`, `:199`.
- Hash được đọc từ path rồi đóng; tiếp theo await connect/USE/query session, rồi mở path lần nữa để chạy. Không giữ tệp bất biến gắn hash hoặc file lease/identity qua toàn vòng đời.
- Probe `lateFileSwap`: dump được duyệt có `VALUES (1)`, fake `connect()` thay file thành `VALUES (9)` sau khi checksum đã hợp lệ. Executor chạy `VALUES (9)` và báo success.
- R03 đã chặn thay đổi **trước** checksum, chưa chặn thay đổi **sau** checksum. Kiểm lại stat/hash thêm một lần nhưng vẫn mở lại tệp mutable không tự giải quyết race.
- Cần sửa: snapshot/staging tệp bất biến do operation sở hữu, identity/locks phối hợp catalog-retention; chạy đúng byte stream đã xác minh. Không coi chỉ giữ FD là đủ nếu nội dung inode vẫn bị ghi sửa tại chỗ.
- Test nhận: thay nội dung/inode/symlink trong connect/USE và giữa các chunk, cancel/crash/retention. Không được chạy nội dung ngoài plan đã duyệt.

### S03 — P1: SET allowlist vẫn cho AUTOCOMMIT=0 rồi báo restore thành công thiếu COMMIT

- Vị trí: `electron/restore-selection-executor.cjs:215`, `:219`, `:223`, `:283`.
- Regex chấp nhận hầu như mọi `SET SESSION ...`, `SET @@...` hoặc `SET tên=...`; không phải allowlist theo biến và giá trị. Dump `SET AUTOCOMMIT=0; INSERT INTO users VALUES (1)` được chạy. Executor không COMMIT nhưng đóng worker và trả success/executedCount.
- Probe `sessionAutocommit` ghi nhận trace này. Với DML InnoDB chưa commit, đóng kết nối có thể rollback, nên executedCount không chứng minh dữ liệu đã phục hồi bền vững. Chưa chạy tình huống này trên DB thật trong lượt review.
- Các SET có ảnh hưởng replication/session policy khác cũng chưa được kiểm theo hợp đồng. Việc chỉ chặn từ GLOBAL/PERSIST chưa đáp ứng R02.
- Cần sửa: reuse session-context allowlist đã có, từ chối SET chưa hiểu; quy định ownership transaction/autocommit và xác minh trạng thái trước khi báo thành công. Không tự thêm COMMIT vô điều kiện mà bỏ qua semantics của dump.
- Test nhận: AUTOCOMMIT off/on, transaction statements, SET expression/unknown variable, lỗi giữa chừng, disconnect; DB integration phải kiểm dữ liệu sau khi worker đóng.

### S04 — P1: Tên operation lệch khiến cancel/reset không hủy restore; policy drift vẫn không chặn ghi

- Vị trí: `electron/main.cjs:92`, `:592`, `:2394`; `electron/restore-selection-executor.cjs:107`, `:177`.
- Handler đăng ký transfer `operation:'restore-selective'`; cancel/reset lại xử lý `'selective-restore'`. Dù đã thêm controller/cancelController, nhánh đúng không chạy. Generic cancel có thể trả true nhờ pending nhưng không abort controller hoặc worker riêng.
- Probe Main VM thật: claim transfer bằng tên handler, gọi cancel rồi stopBackupSchedules; kết quả `{canceled:true, afterCancel:false, afterReset:false}`. Hai trường cuối là signal.aborted.
- Profile chỉ được kiểm trước các await. Probe `profileDrift` đổi trusted profile thành readOnly ngay lúc worker connect; executor tiếp tục CREATE/INSERT và trả success. Chưa có generation/credential/policy recheck và lease/worker guard xuyên suốt; clear pending plan không vô hiệu plan đã consume.
- Cần sửa: một enum operation dùng chung, bind scope từ plan Main, hủy đúng worker qua deadline/cancel guard; context/generation/policy recheck trước mọi tác động sau await, invalidation trước cleanup. Kiểm cả Data Diff clear và callback muộn, không chỉ rename enum.
- Test nhận: dùng handler Main thật, transfer thật và registry thật; cancel/logout/reset/profile change ở connect/query/cleanup, Editor transaction đang mở. Không báo canceled trong khi restore vẫn được chạy tiếp.

### S05 — P1: Replica vẫn ghi đè backup đã có mà không xác nhận

- Vị trí: `electron/backup-replica-manager.cjs:52`, `:80`, `:104`; `electron/main.cjs:2459`.
- Đã sửa mismatch checksum trước rename và chặn cùng canonical directory. Nhưng rename vẫn thay thế tệp đích đã tồn tại. UI/IPC chọn destinationDir không đồng nghĩa chấp thuận xóa nội dung backup cùng tên ở đó; handler không có bước xác nhận collision hoặc unique publication.
- Probe `replicaOverwrite`: source chứa `NEW BACKUP`, destination cùng basename chứa `EXISTING BACKUP`; hàm trả verified:true và tệp cũ bị thay bằng `NEW BACKUP`.
- Cần sửa: no-clobber/unique destination hoặc workflow overwrite xác nhận cụ thể; giữ backup cũ nếu không có approval. Kiểm inode/hardlink/path aliases, file/sidecar locks, nguồn đổi trong copy và publish/crash semantics.
- Test nhận: đích đã có nội dung khác, cạnh tranh tạo đích lúc publication, checksum mismatch, sidecar failure, same-file aliases; không mất bản tốt ngoài ý định.

### S06 — P2: OperationApprovalManager chưa phải luồng Production hợp lệ

- Vị trí: `electron/main.cjs:141`, `:165`, `:184`; `electron/restore-plan-service.cjs:159`.
- Không có caller/IPC dùng requestApproval; restore plan chưa có planDigest, nên không tạo được receipt qua chính method mới. Test R12 dùng authorizeProduction giả tự định nghĩa, không chạy OperationApprovalManager/Main.
- requestApproval coi giá trị callback là boolean; trả nguyên native result `{response:0}` vẫn truthy và được cấp receipt. Chưa có adapter thực tế nên đây là lỗi contract nội bộ, không kết luận có public production bypass hiện tại.
- authorizeProduction so sánh plan.planDigest do plan khai, không tự hash payload; fingerprint đã lưu không được đối chiếu và không recheck context sau dialog. Probe `approval` dùng native-shaped cancel, rồi sửa operation/fingerprint nhưng giữ claimed digest; manager vẫn authorize.
- Cần sửa: receipt gắn type/full digest/fingerprint/generation/TTL/one-use; native adapter kiểm đúng response, mặc định Hủy; after-await context checks; request API nhận plan ID/token Main. Giữ Production blocked đến khi flow này có Main VM tests.

### S07 — P2: “Immutable plan” chỉ freeze lớp ngoài, nguồn bằng chứng sync vẫn do renderer khai

- Vị trí: `electron/data-sync-plan-service.cjs:15`, `:242`, `:478`; `electron/main.cjs:2425`.
- Đã thêm op.table vào digest nhưng chưa hash tables metadata/dependency orders. consumePlan trả Object.freeze(plan), không clone/deep freeze operations/scopes; pending plan còn giữ reference từ input.
- Probe `syncShallowFreeze`: sửa targetScope sau createPlan làm database trong plan đổi, planDigest không còn khớp; top-level frozen:true nhưng operationFrozen:false. Probe cũ frozen:true không chứng nhận bất biến sâu.
- Main vẫn nhận report giả, nhưng Apply hiện fail-closed SYNC_APPLY_NOT_READY và không phát DML: R01 được **kiềm chế rủi ro**, chưa hoàn thành Main-owned planning. Không nên mở lại Apply chỉ vì probe cũ không còn DELETE.
- R06 cũng chỉ sửa DELETE thêm originalValues; UPDATE chưa full exact guards, không có engine validation trong planner/executor, fingerprint hook vẫn không dùng. Cần các điều kiện này trước khi mở sync.

### S08 — P2: Observer/progress chưa được xử lý đúng toàn luồng

- Vị trí: `electron/main.cjs:2403`, `electron/data-sync-executor.cjs:228`.
- Restore progress vẫn gọi sendToRenderer chưa được định nghĩa; executor nuốt lỗi nên không có event thực cho UI. Probe cũ xác nhận typeof sendToRenderer là undefined. Nhánh Main sync gọi callback này đã được gỡ cùng public Apply, không phải hàm đã được sửa như tiến độ mô tả.
- Sync executor try/catch chỉ bắt callback throw đồng bộ, không xử lý Promise rejection. Probe `asyncProgress`: transaction trả success, callback async reject tạo unhandledRejection. Chưa public sync Apply, nhưng module phải sửa trước khi mở capability.
- Cần sửa: dùng progress API thật, throttle/projection đúng; observer throw/reject/hang không thay outcome hoặc giữ worker chờ; chặn event stale. Test cả Main event delivery và async observer.

## Đối chiếu 12 findings vòng 1

| Finding cũ | Kết quả review lại |
| --- | --- |
| R01 | Apply IPC đã khóa, không DML trong probe. Planning/proof/immutability chưa xong — S07. |
| R02 | Chặn được GLOBAL và qualified INSERT đơn giản; còn multi-object DROP/case/SET semantics — S01/S03. |
| R03 | Chặn tamper trước hash; race sau hash còn — S02. |
| R04 | Same-dir source và checksum mismatch đã cải thiện; destination collision vẫn mất bản cũ — S05. |
| R05 | Lỗi gốc wrong-password xóa destination đã xử lý; probe giữ tệp cũ. Các điều kiện hardening/publication/catalog khác chưa tự coi hoàn tất. |
| R06 | DELETE có originalValues; engine/typed exact guard/UPDATE/context chưa đủ — S07. |
| R07 | Lost COMMIT ACK có executionUncertain/partialCommit; observer async và progress Main còn lỗi — S08. |
| R08 | Clear thêm restore plans và controller đã có; cancel sai operation, context drift còn — S04. |
| R09 | Đã gỡ loop cũ và khóa nút Apply; chấp nhận biện pháp chặn này, chưa nghiệm thu tính năng Apply mới. |
| R10 | Probe ADD FULLTEXT sinh đúng; có nhánh SPATIAL/postcondition type. Chấp nhận sửa lỗi gốc, chưa có engine matrix thật. |
| R11 | Quota không còn bị coi complete trong probe; string collation/reader-service budget/isolation proof vẫn cần nghiệm thu. |
| R12 | Manager mới chưa nối request flow; contract và validation còn lỗi — S06. |

Ba lỗi gốc R05/R09/R10 có sửa được xác nhận trong phạm vi trên; R01 đã chặn đường ghi. Các mục còn lại còn phần chưa đạt. **Không dùng phép đếm này để suy phần trăm hoàn thành sản phẩm.**

## Kiểm tra và giới hạn bằng chứng

| Kiểm tra chạy lại | Kết quả |
| --- | --- |
| npm run check | **1.173 tests: 1.159 pass / 0 fail / 14 skip** |
| npm run test:renderer | **100/100** |
| npm run test:website | **14/14** |
| npm --prefix server run check | Đạt |
| npm run server:test | **17/17** |
| git diff --check | Đạt |

Không có DB thật hoặc installed/upgrade evidence mới trong lượt này. Full check có chạy các test regression mới của Gemini, nhưng những test đó chưa bao phủ các biến thể trên: R02 đặt câu nguy hiểm đầu file và chỉ kiểm qualified statement đơn; R06 test tên UPDATE/DELETE nhưng chỉ dựng DELETE; R12 dùng hook approval giả; chưa có assertion Main cancel đúng tên operation. Test mang tên “đã fix” không thay thế test fail trước và pass sau ở đúng boundary.

Probe vòng 1 chạy lại: [observed-r2-original-probes.json](review/gemini-2026-11-18/observed-r2-original-probes.json). Probe bổ sung và output: [reproduce-r2.cjs](review/gemini-2026-11-18/reproduce-r2.cjs), [observed-r2-extra.json](review/gemini-2026-11-18/observed-r2-extra.json).

```bash
node review/gemini-2026-11-18/reproduce.cjs
node review/gemini-2026-11-18/reproduce-r2.cjs
```

Các script in quan sát, không assert mọi điều kiện an toàn; exit 0 không phải “0 finding tái hiện”. Probe manager/worker/module là kiểm tra nội bộ, không tự chứng minh end-to-end UI/Production/DB thật. Output có timestamp thay đổi theo lần chạy; fixtures chỉ chứa dữ liệu giả.

## Giao sửa tiếp cho Gemini

1. Giữ khóa sync/migration Apply. Ưu tiên **S01–S04**; selective restore chưa đạt phải fail-closed cho phạm vi chưa chứng minh an toàn. Dùng shared statement/context guards, immutable backup proof và worker lifecycle contract hiện có.
2. Sửa **S05** để bảo toàn backup đích; thêm collision/race/file-preservation assertions.
3. Sau đó hoàn thiện **S06–S08**, plan proof và typed/engine guards. Không mở lại capability để “test đã chạy được” trước khi có receipt/context/DB evidence.
4. Chuyển từng probe lỗi thành regression test đúng boundary: Main VM thật cho IPC/cancel, module + file race hooks cho restore/copy, DB test marker riêng cho commit/rollback/collation. Gửi diff và output review lại trước gói mới.
5. Backlog sản phẩm chưa thay đổi: roadmap vẫn 29/51 mục chưa tick; B13 metadata/filter, B14 SQL Editor, B16 refactor/UX và tích hợp cron/recovery/DB/installed-release matrix chưa có bằng chứng hoàn thành mới.
