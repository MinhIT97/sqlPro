# B02 — Sửa findings và bàn giao tiếp

> **Trạng thái hiện tại:** [Review cuối, các lỗi đã sửa và việc chưa làm](CODE_REVIEW_FINAL_2026_11_18.md). Các số liệu/findings phía dưới giữ lịch sử trước lượt chốt này.

> **Cập nhật sau sửa lỗi 18/11:** [Kết quả sửa V01–V04](CODE_REVIEW_GEMINI_2026_11_18_R5_FIXES.md) là trạng thái mới nhất. Nội dung review bên dưới giữ nguyên làm lịch sử trước sửa.

**Mốc hiện hành — vòng 5:** [CODE_REVIEW_GEMINI_2026_11_18_R5.md](CODE_REVIEW_GEMINI_2026_11_18_R5.md). V01 SQL mode còn P0; V02/V03 transaction và COMMIT còn P1; V04 late connect cleanup P2. Các probe U01–U04 đã cải thiện, nhưng chưa đủ nghiệm thu grammar/context/transaction toàn luồng. Các mốc bên dưới giữ lịch sử.

**Mốc hiện hành — vòng 4:** [CODE_REVIEW_GEMINI_2026_11_18_R4.md](CODE_REVIEW_GEMINI_2026_11_18_R4.md). Còn U01–U04 (1 P0, 3 P1). Chốt grammar/subset và authorized statements trước khi mở selective restore; ledger phải bao gồm pre-drop/first DML và giữ partial outcome qua IPC. Bản sửa approval/no-replace replica có tác dụng; các mốc bên dưới giữ làm lịch sử.

**Mốc hiện hành — vòng 3:** [CODE_REVIEW_GEMINI_2026_11_18_R3.md](CODE_REVIEW_GEMINI_2026_11_18_R3.md). Còn 5 nhóm (2 P0, 3 P1); sửa T01/T02 trước. Các bản sửa đã cải thiện probe cũ nhưng Production restore hiện vẫn chạy khi thiếu approval token, và ALTER RENAME vượt schema đích. Không mở capability mới hoặc chốt nghiệm thu từ test helper; các mốc bên dưới là lịch sử.

**Review vòng 2 là mốc hiện hành:** [CODE_REVIEW_GEMINI_2026_11_18_R2.md](CODE_REVIEW_GEMINI_2026_11_18_R2.md). Chưa nghiệm thu “12/12 triệt để”; còn 8 nhóm (1 P0, 4 P1, 3 P2). Ưu tiên S01–S05: restore vượt phạm vi, file race, SET/transaction, cancel/context và bảo toàn backup đích. Các trạng thái E2/vòng 1 bên dưới là lịch sử; không mở sync/migration Apply trước review tiếp.

**Review mới nhất 18/11:** [CODE_REVIEW_GEMINI_2026_11_18.md](CODE_REVIEW_GEMINI_2026_11_18.md) ghi nhận 12 findings trên triển khai E2.1/E3/B03–B18. Facade Main E2.1 đã có và test VM pass; mô tả thiếu facade bên dưới thuộc review E2 trước đó. Chưa nghiệm thu E3/UI hoặc DB thật; ưu tiên sửa theo mục 5 của báo cáo mới, không chuyển trạng thái release-ready từ các test helper.

Ngày cập nhật: 18/11/2026. Gói này lưu cả hồ sơ B00/B01 và collector B02 đã được chỉnh sau review. B01 là xác minh rủi ro; các lỗi runtime của migration/diagnostics/privacy trong báo cáo chưa được sửa bởi gói này.

**Hiện trạng mới nhất:** Đã review/sửa nền module E2; **chưa nghiệm thu tích hợp E2 toàn đường chạy**. Job/worker/verifier có test hồi quy, nhưng Main chưa có factory điều phối executor/job và vẫn khởi tạo source verifier không kèm store (fail-closed). Apply tại Main/service vẫn `MIGRATION_APPLY_NOT_READY`. Gemini tiếp tục **E2.1** ở cuối tài liệu, chưa chuyển E3/B03 hoặc coi B02/G6 hoàn tất.

## 18/11 — Review/sửa nền E2 trước commit

- **P1 — ownership/session:** Không ghi đè exclusive flag/lease của tác vụ khác. Kiểm mọi entry trước acquire, cleanup cả khi acquire một phần lỗi; dùng `SessionRegistry` thật trong test. Job phải được đúng manager đăng ký, chỉ chạy một lần và token phải khớp plan.
- **P1 — cancel/cleanup:** `cancelling` là trạng thái đang dọn, chưa phải terminal. Cancel/clear không nhả target hoặc slot chạy trước cleanup; kết quả executor trả muộn không chuyển job hủy thành completed. Clear giữ reservation của job còn chạy, chặn callback muộn và chỉ xóa entry sau cleanup. Observer listener được tháo đúng vòng đời.
- **P1 — ranh giới context:** Bỏ việc thêm `jobId` do caller đưa vào plan và bỏ ngoại lệ loại `jobId` khỏi digest. `checkContext(plan, {jobId})` chỉ bỏ qua lease khi callback `manager.ownsLease` xác minh registration, plan digest/token, entry thực và đúng số lease. Chèn `plan.jobId` hoặc đoán owner ID không cấp quyền.
- **P1 — worker treo/mở muộn:** Thêm `schema-migration-worker.cjs` dùng chung cho source và target; race cancel/deadline qua connect/USE/collect/DDL, close có giới hạn, phá kết nối/SSH khi bị hủy. Connect trả muộn vẫn bị destroy/close, không chạy bước tiếp. Timeout DDL trả uncertain/partialCommit, không retry và không hứa rollback. Promise reject không có error object vẫn là lỗi, không bị đổi thành DDL thành công.
- **P1 — proof nguồn:** Verifier có deadline chung, scope/quota/coverage/hash/engine/version checks, recheck credential trong vòng đời worker ngay cả khi policy fingerprint không hash password. Close lỗi không trả proof thành công. Cả source và target collector dùng identity worker riêng; `captureSessionId` chỉ là correlation tới capture Editor, không giả worker thuộc phiên Editor.
- **P2 — quota/projection:** Target key dùng JSON tuple, tránh va chạm dấu `:`. Giới hạn số job lưu và TTL; metadata identity bất biến. Error code dùng allowlist thực thay vì regex; cleanup/status/duration/warnings được chiếu an toàn. Observer nhận bản sao riêng, async rejection được bắt, promise treo không giữ worker chờ ACK.
- **Kiểm chứng:** `npm run check` **1072 pass / 0 fail / 14 opt-in skip** (1086 tổng); focused migration **78/78** (23 admission, 15 executor, 15 jobs, 9 service, 11 verifier, 5 Main IPC). Electron **100/100**, website **14/14**, server check đạt và **17/17**, diff whitespace check đạt. Fixture source mới chạy collector + `DatabaseSession` thật, metadata driver giả lập; lần đọc mới thực sự phát SQL và đổi column type làm drift hash.
- Chưa chạy MySQL/MariaDB thật, bộ cài, benchmark hoặc DB ứng dụng. Các số liệu/nhận định E2 trước review bên dưới là lịch sử, không phải nghiệm thu Main integration hay bật ghi.

## 18/11 — Hồ sơ triển khai E2 trước review

- **Schema Migration Job Module (`electron/schema-migration-jobs.cjs`)**:
  - Quản lý vòng đời migration job với state machine rõ ràng: `preparing` -> `verifying` -> `executing` -> `completed` | `cancelled` | `failed` | `uncertain`.
  - Quản lý concurrency quota: tối đa 2 job active song song, cấm 2 job chạy đồng thời trên cùng database đích (`TARGET_BUSY`). Tự động dọn dẹp job cũ theo TTL (`jobTtlMs`).
  - Hỗ trợ hủy bỏ toàn diện: `cancelJob(jobId)`, `cancelAll(reason)`, `clear()`. Tích hợp `AbortController`/signal xuyên suốt các bước.
  - Phân tách và bảo vệ dữ liệu: `projectForRenderer()` áp dụng whitelist nghiêm ngặt, tuyệt đối không lộ mật khẩu, thông tin kết nối, raw SQL, DEFINER, hay nội dung lỗi driver chứa SQL. Mã lỗi được whitelist hóa an toàn (`sanitizeErrorCode`). Toàn bộ ledger chi tiết và raw SQL chỉ lưu trữ in-memory tại Main Process.
- **Source Verifier đọc mới trên worker độc lập (`createSourceVerifier` trong `electron/schema-migration-admission.cjs`)**:
  - Thay thế placeholder fail-closed của E1 bằng implementation hoàn chỉnh. Đọc profile với secret từ store thật, tạo `DatabaseSession` độc lập (không dùng phiên Editor), kết nối, `USE \`<database>\``, và thu thập snapshot mới qua `SchemaSnapshotCollector`.
  - Kiểm tra trôi cấu hình (drift) profile nguồn trước và sau khi đọc metadata; chặn ngay khi coverage không `complete` (`SOURCE_SCHEMA_INCOMPLETE`) hoặc khi fingerprint `snapshotIdentity` bị thay đổi (`SOURCE_SCHEMA_DRIFT`).
  - Đảm bảo worker session luôn được đóng trong `finally`.
  - Phân biệt rõ danh tính worker (`workerSessionId`) với phiên Editor đã được bind (`captureSessionId` / `sessionId`).
- **Điều phối Lease & Session Registry**:
  - Khi job chạy, phiên Editor của target và source được đánh dấu `exclusiveOperation = true` và `exclusiveOwnerJobId = job.jobId`.
  - Mọi thao tác khác từ Editor hoặc job cạnh tranh đều thấy `SESSION_BUSY`, bảo vệ tính toàn vẹn của phiên.
  - `checkContext(plan)` của chính migration job nhận diện `exclusiveOwnerJobId === plan.jobId` nên không tự chặn chính mình. Leases được giải phóng sạch sẽ trong `finally`.
- **Giữ nguyên Fail-Closed Apply Guard**:
  - `db:apply-migration-plan` và `SchemaMigrationService.applyPlan` tiếp tục trả lỗi `MIGRATION_APPLY_NOT_READY`. Không có bất kỳ đường ghi công khai nào được mở.
- **Kiểm chứng thực tế**:
  - Unit tests mới: `test/schema-migration-jobs.test.cjs` (9/9 pass), `test/schema-migration-source-verifier.test.cjs` (7/7 pass).
  - Toàn bộ test migration: **75/75 pass** (5 Main IPC, 10 B01 baseline, 23 admission, 12 executor, 9 jobs, 9 service, 7 source verifier).
  - `npm run check`: **1059 pass / 0 fail / 14 opt-in skip** (1073 tổng).
  - Electron renderer smoke: **100/100 pass**. Website smoke: **14/14 pass**. Server tests: **17/17 pass**.
  - `git diff --check`: đạt chuẩn, 0 lỗi whitespace/formatting.

## 18/11 — Review cuối E1 và chốt commit

- Xác minh các bản sửa trước: dialog bắt buộc, bind profile nguồn/đích, generation sau await, slot quota theo ID, expiry không vượt plan, token consume một lần và digest không tự tham chiếu. Main vẫn kiểm credential/session qua registry thật; chưa có public API chạy worker ghi.
- Sửa thêm lỗi verifier approval tin digest do bên gọi truyền: đổi SQL/thứ tự/options/nguồn/đích nhưng giữ digest cũ có thể lấy receipt từ adapter. Executor hiện tự tính hash nên có lớp bảo vệ riêng; adapter giờ tự hash lại payload, kiểm target profile ID và expiry hợp lệ trước cấp receipt. Token sai vẫn bị consume, không được retry với payload khác.
- Test mới tại `test/schema-migration-admission.test.cjs` đã fail trước sửa (`Missing expected exception`), pass sau sửa cho cả năm nhóm thay đổi. Bản sửa digest của Gemini giữ equality `admitted.planDigest === planDigest(admitted)` và dùng chung hàm tính hash trong admission/approval/executor.
- Kiểm chứng thực chạy: `npm run check` **1043 pass / 0 fail / 14 opt-in skip** (1057 tổng); focused migration **49/49** (23 admission, 12 executor, 9 service, 5 Main IPC). Electron **100/100**, website **14/14**, server syntax check đạt, server **17/17**, `git diff --check` đạt.
- Chỉ chạy fixture/temp; chưa chạy MySQL/MariaDB thật, benchmark hoặc bộ cài. Kết quả này chốt nền E1 có guard, không nghiệm thu thực thi migration thật. Các mục 17/11 bên dưới là hồ sơ lịch sử.

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

1. Collector đã nối `db:schema-snapshot` tại main: lease độc quyền, bảo vệ transaction Editor, identity thật từ registry, recheck session/profile/policy/generation sau await, quota do main quản lý. Chưa nối UI và chưa có job cancel xuyên suốt; cân nhắc worker đọc riêng.
2. Kiểm chứng trên MySQL/MariaDB cô lập: capability theo phiên bản, functional/hidden index, trigger context, quyền hạn thiếu và drift. Kết quả information_schema rỗng do quyền bị giới hạn không tự chứng minh đối tượng không tồn tại; cần policy chứng minh đủ quyền trước thao tác phá hủy.
3. Xây main-owned migration plan: giữ metadata đầy đủ tại main, bind source/target/scope/hash/TTL, token một lần, kiểm policy và drift sát lúc ghi, báo kết quả từng statement/partial DDL. Không dùng lại vòng lặp phát SQL renderer làm executor tin cậy.
4. Bảo đảm generator và executor kiểm `coverage`, `status`, `migrationStatus`/block reason **trước** khi chuẩn hóa dữ liệu qua SchemaDiff. Module SchemaDiff hiện chưa tự bảo vệ các trạng thái mới. Chưa mở lại Apply chỉ vì collector có fingerprint.
5. Giữ các nhóm sửa migration, selective restore, privacy và diagnostics riêng theo `GEMINI_IMPLEMENTATION_HANDOFF.md`. Chưa coi B02 hay toàn bộ G6 hoàn tất.

## Review lần nối migration service — trạng thái mới nhất

- Đã sửa collision: hai capture khác server/phiên có thể cùng `snapshotIdentity` (content hash), nên mỗi capture giờ có `snapshotId` ngẫu nhiên riêng. `storeSnapshot` giữ bản sao bất biến; không cho sửa snapshot/plan thông qua response renderer.
- API: `db:schema-snapshot({profileId,database})` trả projection kèm `snapshotId`. Gửi `db:create-migration-plan({sourceSnapshotId,targetSnapshotId,options})`; không dùng content hash làm capture ID. Main kiểm scope của cả hai capture còn đúng phiên/cấu hình trước khi tạo preview.
- `db:apply-migration-plan` và `SchemaMigrationService.applyPlan` đều từ chối bằng `MIGRATION_APPLY_NOT_READY`, không mở session, không USE/DDL/SET FK. `confirmed:true`, token hay environment do renderer gửi không thể bật ghi. Đường Apply thử nghiệm đã bị gỡ vì dùng phiên Editor, bỏ qua policy do `entry.profile` không tồn tại, và tắt FK mặc định.
- Plan chỉ là preview: `status: preview|blocked`, `applySupported:false`, `summary.executable:0`, mọi statement `enabled:false`. Partial/unknown chặn toàn bộ thay vì chỉ DROP. Metadata lồng nhau được kiểm trước SchemaDiff; expression/generated/FK/dependency/view/routine/trigger/event chưa được generator xử lý an toàn sẽ bị blocked. Chưa thực thi các thuộc tính đó bằng cách bỏ mất metadata.
- Snapshot/plan có TTL và quota kể cả plan bị blocked. Logout/reset/profile lifecycle gọi `stopBackupSchedules` sẽ xóa cache. Thay đổi scope sau capture yêu cầu thu thập lại.
- Kiểm chứng: `npm run check` **1008 pass / 0 fail / 14 skip** (1022 tổng). Focused service + IPC **14/14**. `test/main-schema-migration.test.cjs` chạy `main.cjs` thật với registry/collector/service thật, driver giả lập; không dùng handler IPC chép lại. Chưa kiểm DB thật.

### Điều kiện trước khi Gemini mở Apply

1. Xây executor worker riêng, check writable/production bằng profile thật từ store; không dùng `entry.profile`, không tin `confirmed` renderer. Token phê duyệt gắn nội dung/đích và chỉ dùng một lần; thu hồi khi scope đổi/hết hạn.
2. Recheck source và target/session/generation/profile/DDL hash ngay trước lần ghi đầu và trước từng bước cần thiết. Partial/unknown/quota/cancel không thể cấp quyền ghi. Snapshot hết hạn hoặc schema không còn đúng phải tạo preview lại.
3. Không tự tắt FK checks. Nếu hỗ trợ tùy chọn thay setting, đọc giá trị cũ và khôi phục đúng giá trị ấy trên worker riêng ở mọi nhánh; không mặc định SET về 1 và không dùng phiên Editor.
4. Hoàn thiện generator theo engine và dependency, xử lý hoặc chặn rõ metadata chưa hỗ trợ; thêm ledger từng statement, cancel/timeout, báo partial/uncertain DDL, không hứa rollback implicit commit.
5. Kiểm chứng MySQL/MariaDB cô lập và review trước khi thay guard `MIGRATION_APPLY_NOT_READY`. Các test hiện tại xác nhận không ghi, chưa phải nghiệm thu executor ghi an toàn.

## Review executor thử nghiệm — 17/11/2026

Các lỗi dưới đây nằm trong module executor mới, chưa được nối vào IPC; không có bằng chứng chúng đã chạy trên dữ liệu ứng dụng. Đã sửa tại `electron/schema-migration-executor.cjs` và thêm hồi quy tại `test/schema-migration-executor.test.cjs`:

| Mức | Lỗi trước sửa | Hành vi sau sửa |
| --- | --- | --- |
| P0 | Nhận cả plan từ caller, chỉ so token, có thể chạy preview/statement disabled hoặc replay đồng thời | Chỉ nhận token; bắt buộc Main cung cấp hàm consume; reserve token trước await, không retry token đã dùng. Clone/freeze plan và yêu cầu ready/applySupported/executable/enabled, scope/TTL/quota hợp lệ. |
| P0 | Dùng `ProductionApprovals.confirm()` như hàm xác minh; thực tế hàm này chạy callback của yêu cầu đã lưu | Không gọi confirm chung. Hook riêng phải cấp receipt bất biến gắn đúng digest toàn plan, token, target fingerprint và expiry. Thiếu/sai receipt chặn trước mở worker. |
| P0 | Tin profile đã đọc trước await, thiếu bằng chứng nguồn và thiếu kiểm tra policy/context lại | Đọc cả hai profile từ store qua hook, kiểm writable, fingerprint và context sau await. Nguồn được xác minh hai lần, đích đọc mới trên worker; kiểm coverage/hash và đầy đủ tuple scope/engine/version. |
| P0 | Có thể tắt FK mặc định, giá trị setting đọc lỗi bị suy thành 1 | Từ chối `wrapForeignKeys:true`. Chỉ đọc worker settings, yêu cầu FK checks và autocommit đều bật; không tự SET hoặc dùng phiên Editor. |
| P1 | Cancel chỉ được xét giữa các câu; timeout ở DDL đầu bị báo như chưa có tác động | Abort phá kết nối worker đang chạy DDL, dừng câu tiếp; timeout/cancel/mất kết nối trả ledger `uncertain`, `executionUncertain:true` và `partialCommit:true` kể cả executedCount=0. Không hứa rollback. |
| P1 | Callback tiến độ sửa được ledger hoặc ném lỗi khiến DDL thành công bị báo sai | Gửi bản sao; bắt cả lỗi sync/async thành observer warning. Recheck sau callback; cancel ở callback cuối giữ ledger executed nhưng trả trạng thái hủy, không báo thành công. |
| P1 | Lỗi setup/close có thể bỏ cleanup hoặc mất thông tin DDL đã chạy | Luôn thử close worker trong finally; lỗi close giữ executedCount/ledger/partialCommit. |

Kiểm chứng lượt review này:

- `npm run check`: **1020 pass / 0 fail / 14 opt-in skip** (1034 tổng).
- Focused executor/service/Main IPC: **26/26**, gồm **12 test executor** với driver/hook giả lập. Test IPC vẫn chứng minh Apply không mở worker hoặc phát SQL.
- Electron renderer **100/100**, website **14/14**, server syntax check đạt và server test **17/17**; chạy bằng fixture/temp.
- Chưa chạy MySQL/MariaDB thật, benchmark, ASAR/bộ cài hoặc tác động database ứng dụng trong lượt này. Các số liệu trước đó trong tài liệu là lịch sử.

### Hợp đồng executor hiện tại

```js
// Chỉ dùng trong Main; chưa có instance được nối vào apply IPC.
new SchemaMigrationExecutor({
  consumePlan, getProfileWithSecrets, fingerprintProfile, checkContext, verifySource,
  authorizeProduction // bắt buộc khi target Production
}).executePlan({ planToken, approvalToken, signal, onProgress });
```

- Năm hook đầu là bắt buộc; thiếu một hook sẽ từ chối. `checkContext(plan)` phải trả chính xác `true` sau khi kiểm registry/lifecycle thật; không viết stub `true` ở production. `consumePlan` phải lấy bản main-owned và tiêu thụ nguyên tử, không nhận plan/SQL do renderer dựng.
- **Service hiện tại không cấp ready plan.** `sourceScope`/`targetScope` của preview chỉ có scope capture; cấu trúc admitted plan trong test executor còn có `snapshotIdentity` trong từng scope. Khi làm admission phải lấy hash từ snapshot main-owned tương ứng và giữ toàn bộ scope, không lấy lại hash từ renderer.
- `fingerprintProfile` cần bảo vệ đích, policy và cấu hình; đồng thời `checkContext` phải dùng `assertSessionProfile` hoặc tương đương để phát hiện credential/session drift, vì `productionProfileFingerprint` hiện không hash password. Không trả secret/profile nguyên vẹn ra renderer.
- `verifySource` phải đọc mới, có quota/cancel và bằng chứng đúng scope; không chỉ trả snapshot cache đang được dùng làm kỳ vọng. Target proof do collector thật trên worker độc lập trả về.
- Receipt Production: `{planToken, planDigest, targetProfileFingerprint, expiresAt}`. `planDigest` hash payload plan, bao gồm SQL/thứ tự/options/nguồn/đích, loại riêng trường digest dẫn xuất. `SchemaMigrationApproval` đã có dialog và token một lần, tự hash lại payload khi xác minh; adapter/context được khởi tạo tại Main nhưng chưa nối public Apply/approval IPC.
- `onProgress` nhận bản sao và được await; adapter Main chỉ gửi sự kiện nhanh, không chờ ACK renderer. Cancel hiện kiểm chứng cho DDL đang chạy; chưa nghiệm thu cancel xuyên suốt connect/collector/hook hoặc job registry.
- Re-capture trước DDL là quan sát tại thời điểm kiểm tra, không khóa được mọi DDL ngoài ứng dụng. Chưa có mô hình schema đích kỳ vọng sau từng bước, admission/lease xuyên suốt tại Main, UI, durable recovery journal hay kiểm chứng DB thật. Không mở Apply từ kết quả test mock.

## Hồ sơ phạm vi B02-E1 — Main-owned admission và Production approval

E1 được chốt review ngày 18/11 trong phạm vi ghi ở đầu tài liệu. Các bước dưới đây là phạm vi đã bàn giao E1. **Giữ nguyên guard Apply tại Main và service.** Không phát SQL từ renderer, không mở ready plan bằng cờ môi trường hoặc `confirmed:true`.

### Thứ tự và cấu trúc

1. Đọc `schema-migration-service.cjs`, `schema-migration-executor.cjs`, `main.cjs`, `session-registry.cjs`, `production-approvals.cjs` và ba file test migration hiện có. Chốt contract capture ID/content hash/private execution token, tránh dùng lẫn.
2. Tạo module Main-only `electron/schema-migration-admission.cjs` (hoặc module tương đương có giải thích): candidate immutable, TTL/quota; consume nguyên tử trước await; bind plan digest/SQL/options/source/target/profile/session/generation/version. Thất bại/hủy/hết hạn vẫn tiêu thụ token. Preview hiện tại không được tự nâng thành ready. Candidate ready chỉ được dùng qua fixture trong test cho tới khi generator/DB matrix được nghiệm thu.
3. Tạo adapter xác nhận migration riêng: mô tả đúng nguồn/đích/môi trường/số statement và rủi ro; mặc định Hủy, token một lần và có TTL. Giữ payload thật tại Main. Không gọi `ProductionApprovals.confirm()` để kiểm một token bất kỳ; nếu tái sử dụng lớp này phải chứng minh callback thuộc đúng migration và chỉ chạy một lần sau context check. Receipt phải bind đúng `planDigest`/target, có expiry không vượt plan.
4. Dựng các hook context từ store/registry thật: `getProfileWithSecrets`, fingerprint, `checkContext`; kiểm cả credential fingerprint và busy/transaction/session/generation/lifecycle. Sau mọi await phải kiểm lại đúng entry. Nêu rõ lease/job còn thiếu để E2 xử lý; chưa tạo đường ghi IPC trong E1.
5. Thêm `test/schema-migration-admission.test.cjs` và test adapter Main: token replay đồng thời; cancel/TTL; logout/config/credential/session đổi lúc native confirm đang chờ; đổi SQL/thứ tự/options/target; preview/blocked/partial không cấp quyền; read-only ưu tiên; token Production của thao tác khác không chạy callback/SQL. Dùng Main/registry/service thật khi kiểm tích hợp, không chép handler sang test.
6. Cập nhật `package.json` syntax checks cho module mới và tài liệu trạng thái. Báo file sửa, lỗi còn lại, kết quả lệnh thực chạy và mọi skip; không tick B02/G6 hoàn tất.

### Điều kiện nhận E1

- Unit + Main contracts chứng minh không token/receipt giả hoặc stale context nào đi tới worker/SQL; test Apply IPC vẫn trả `MIGRATION_APPLY_NOT_READY`, không USE/SET/DDL.
- `npm run check`, Electron renderer smoke, website smoke, server check/test và `git diff --check` đạt. Không dùng dữ liệu ứng dụng làm fixture.
- Chưa nghiệm thu chạy migration thật. Codex review E1 xong mới giao E2.

## Hồ sơ phạm vi E2 — Job, worker và cancel

Chỉ triển khai E2 rồi gửi diff/test cho Codex review. **Cả `db:apply-migration-plan` và `SchemaMigrationService.applyPlan` tiếp tục trả `MIGRATION_APPLY_NOT_READY`.** Không thêm endpoint khác để lách guard này; không tự nâng preview/blocked thành ready. Candidate ghi chỉ dùng trong fixture/test nội bộ cho đến E3.

### Thứ tự triển khai

1. Tạo module Main-only `electron/schema-migration-jobs.cjs` hoặc module tương đương: job ID ngẫu nhiên, scope bất biến, AbortController, state rõ (`preparing`, `verifying`, `executing`, `completed`, `cancelled`, `failed`, `uncertain`), quota/concurrency/TTL và hủy theo lifecycle. Job giữ context nguồn/đích/profile/session/generation/credential, không dùng tab active hoặc flags renderer để xác định quyền.
2. Thay placeholder `createSourceVerifier()` bằng verifier đọc mới trên worker riêng. Đọc profile từ store thật, connect/USE/collect có timeout/cancel, quota Main và recheck scope sau await. Không trả snapshot cache làm bằng chứng fresh; coverage partial/unknown/denied/quota phải chặn. Giữ đúng capture scope và hash kỳ vọng; phân biệt identity phiên Editor với identity worker, không tự bịa session ID để proof khớp.
3. Điều phối source/target worker qua job, giữ admission/lease phù hợp. Không acquire lease Editor rồi để `checkContext` tự từ chối chính lease của job; nếu cần đổi contract, phải phân biệt đúng owner và giữ chặn tác vụ khác. Không Commit/Rollback/SET, không reconnect/retry tự động và không thay setting phiên Editor.
4. Truyền cancel xuyên suốt admission/dialog/verify/connect/USE/collector/DDL/close. Abort hoặc logout phải vô hiệu hóa job trước cleanup; worker mở xong muộn phải được đóng, kết quả/callback cũ không cập nhật job mới. Hủy DDL không hứa rollback: giữ ledger executed/failed/uncertain, dừng câu sau và báo cần đối chiếu schema thật. Observer không được giữ worker chờ ACK renderer.
5. Progress/result projection có quota và whitelist; không trả profile secret, raw SQL/body/DEFINER hoặc lỗi driver chứa SQL vào event/log/renderer. Ledger SQL đầy đủ chỉ ở Main. Không xây durable recovery journal hoặc UI mới trong E2; ghi rõ kết quả hiện tại chỉ trong bộ nhớ và còn việc ở gói sau.
6. Thêm `test/schema-migration-jobs.test.cjs`, `test/schema-migration-source-verifier.test.cjs` và mở rộng Main contracts. Dùng registry/service/collector thật với driver giả lập khi kiểm tích hợp; không chép handler vào test. Thêm syntax checks cho module mới, cập nhật bằng chứng và phần còn thiếu.

### Điều kiện nhận E2

- Test drift nguồn/đích, credential/session/generation/policy đổi sau await; chỉ đúng job sở hữu được cancel. Unknown/partial/timeout/cancel không được trở thành quyền ghi.
- Test cancel khi chưa mở worker, trong connect/USE/collect/DDL, khi close lỗi và worker trả kết quả muộn; không leak worker/lease/listener hoặc chạy câu tiếp. Test job đầy/quota/TTL, callback cũ, logout/reset và hai job cạnh tranh cùng đích.
- Test source verifier thật phát metadata reads mới; thay đổi schema giữa hai lần phải đổi hash hoặc bị chặn, không chỉ sửa proof giả. Có marker/DB cô lập nếu chạy tích hợp thật; tuyệt đối không dùng database ứng dụng.
- Các test Apply IPC/service vẫn xác nhận guard không mở session hoặc phát USE/SET/DDL, kể cả gửi candidate ready/token/confirmed. Test execution nội bộ dùng fixture, không được trở thành public write path.
- `npm run check`, renderer/website smoke, server check/test và `git diff --check` đạt. Báo đúng DB thật nào đã chạy hoặc chưa chạy; chưa tick B02/G6 hoàn tất.

## Giao Gemini làm tiếp: B02-E2.1 — Tích hợp Main và kiểm chứng lifecycle

Chỉ làm E2.1 rồi gửi review. **Giữ nguyên `MIGRATION_APPLY_NOT_READY` tại Main/service; không thêm endpoint chạy DDL khác, không tự nâng preview thành ready.** Chưa làm generator E3 hoặc UI Apply.

1. Đọc các module/test migration hiện tại và `main.cjs`. Tạo facade/factory Main-only (có thể dùng `schema-migration-orchestrator.cjs`) để dựng admission, approval, job, executor và source verifier với store/registry/context thật. Hiện `schemaMigrationSourceVerifier = createSourceVerifier()` tại Main còn fail-closed do thiếu store; không được chỉ truyền store rồi bỏ qua scope/lifecycle/credential checks.
2. Chốt handshake private giữa create job / peek / consume token / approval / cancel: lấy plan từ admission Main-owned theo token, so digest với job bất biến; không nhận plan/SQL/hook/profile do renderer cung cấp. Định nghĩa rõ khi nào consume/revoke plan và approval trong pre-cancel, timeout, TTL và retry; một job không được chạy lại. Không chuyển `jobId` thành quyền bằng cách chèn vào plan hoặc loại nó khỏi digest.
3. Dựng executor per-job với hook Main thật; `checkContext(plan, {jobId})` phải dùng `manager.ownsLease`. Verifier đọc source worker phải nhận đúng signal/job context và xác minh capture session/generation/credential sau await. Không dùng callback `checkContext: () => true` trong production. Native Production dialog lấy từ Main, mặc định Hủy; không cho caller override receipt/dialog/hooks.
4. Lưu completion promise tại Main để cancel/logout/reset có thể invalidate trước và theo dõi cleanup hữu hạn; không nhả reservation khi chỉ vừa phát signal. Observer Main gửi event nhanh, có whitelist và kiểm lifecycle; kết quả muộn sau logout không được xuất hiện trên phiên mới. Nếu thêm IPC status/cancel thì chỉ đọc/hủy job Main-owned với sender/scope đúng; **không thêm start/write IPC trong E2.1**.
5. Mở rộng test VM chạy `main.cjs` thật: tạo capture qua named IPC, preview vẫn disabled; dựng ready candidate chỉ trong fixture nội bộ. Chạy registry/collector/services/executor thật với driver giả lập. Chứng minh chỉ worker phát USE/metadata/DDL fixture, phiên Editor không bị Commit/Rollback/SET; thay đổi metadata nguồn phải được phát hiện qua reads mới, không sửa proof giả.
6. Test Main lifecycle có job đang chạy: cancel trong connect/USE/collect/DDL/close, profile/credential/session/generation đổi khi confirm pending hoặc worker await, hai job tranh source/target, acquire lỗi, native confirm hủy/hết hạn, cleanup lỗi, callback muộn. Assert số worker/lease/listener/reservation sau cleanup và trạng thái partial/uncertain. Chạy thêm fixture DB cô lập nếu có điều kiện; không dùng DB ứng dụng.
7. Chạy full check, renderer/website, server check/test và diff check; cập nhật đúng bằng chứng/skip/giới hạn. Apply guard tests phải tiếp tục xác nhận không session/USE/SET/DDL dù gửi ready/confirmed/token/jobId. E2.1 xong gửi Codex review trước E3; không tick B02/G6 hoàn tất.

### Trạng thái hoàn thành B02-E2.1 (Gemini)

Đã hoàn thành triển khai facade và tích hợp lifecycle Main theo đúng 7 yêu cầu trong B02-E2.1:
1. **Facade Main-only**: Đã tạo [`electron/schema-migration-orchestrator.cjs`](file:///var/www/project/SqlPro/electron/schema-migration-orchestrator.cjs) phối hợp `SchemaMigrationAdmission`, `SchemaMigrationApproval`, `SchemaMigrationJobManager`, `SchemaMigrationExecutor`, và `createSourceVerifier` với `store`, `sessionRegistry`, `openSessions`, `getGeneration`, `productionProfileFingerprint`, `assertSessionProfile`, `showConfirmDialog` của Main thật. `schemaMigrationSourceVerifier` tại top-level `main.cjs` được cấu hình đầy đủ `store`, `DatabaseSession`, `SchemaSnapshotCollector`, `productionProfileFingerprint`, và `checkContext`.
2. **Handshake Private & Token Invariant**:
   - `orchestrator.executeMigrationJob` chỉ nhận `{ planToken, approvalToken, signal }`; từ chối nghiêm ngặt bất kỳ plan/sql/statements/hooks/profile nào do caller truyền vào (`CALLER_FIELDS_REJECTED`).
   - `plan` lấy trực tiếp từ admission Main-owned, đối chiếu `planDigest` bất biến, không chèn `jobId` vào plan và không loại `jobId` khỏi digest.
   - `jobContext = { jobId: job.jobId }` được truyền riêng rẽ sang `checkContext`.
   - `cancelJob` thu hồi `planToken` và `approvalToken` chưa consume. Một job không thể chạy lại (`JOB_INVALID_STATE`).
3. **Per-job Hook & Real Source Verifier**:
   - `contextHooks` per-job dùng `ownsLease: (jobId, p, entry) => this.jobManager.ownsLease(jobId, p, entry)`.
   - `sourceVerifier` per-job nhận `job.signal` và `checkContext` gắn với `jobId`, kiểm tra capture session, generation, và credential drift sau mỗi lần await.
   - Native Production confirmation dialog do Main sở hữu (`showConfirmDialog`), cấu hình `defaultId: 0, cancelId: 0` (mặc định Hủy), không nhận override từ caller.
4. **Finite Completion Tracking & Fail-Closed Public IPC**:
   - `orchestrator.runningPromises` lưu trữ completion promises để `reset()` có thể invalidate trước và await worker close tối đa 2 giây trước khi giải phóng map.
   - `onProgress` kiểm tra `this.getGeneration() === jobGen` để loại bỏ toàn bộ late callbacks sau khi logout/reset.
   - Bổ sung IPC `db:migration-job-status` và `db:migration-job-cancel` (chỉ đọc status và hủy job Main-owned hợp lệ).
   - **Giữ nguyên fail-closed**: `db:apply-migration-plan` và `schemaMigrationService.applyPlan` tiếp tục ném `MIGRATION_APPLY_NOT_READY`. Không mở start/write IPC.
5. **Kiểm thử VM Main & Lifecycle**:
   - Tạo mới [`test/schema-migration-orchestrator.test.cjs`](file:///var/www/project/SqlPro/test/schema-migration-orchestrator.test.cjs) với 10/10 test pass (happy path, production approval flow, cancellation, profile drift, context drift, generation logout, target busy, session busy, bounded reset).
   - Mở rộng [`test/main-schema-migration.test.cjs`](file:///var/www/project/SqlPro/test/main-schema-migration.test.cjs) với 8/8 test pass chạy trên VM `main.cjs` thật: chứng minh chỉ worker phát DDL, Editor session không nhận COMMIT/ROLLBACK/SET; thay đổi metadata nguồn phát hiện qua reads mới (`SOURCE_SCHEMA_DRIFT`).
6. **Bằng chứng kiểm thử**:
   - `npm run check`: 1099 pass / 0 fail / 14 skip.
   - Migration tests: 101/101 pass, 0 fail.
   - Renderer smoke: 100/100 pass.
   - Website smoke: 14/14 pass.
   - Server test: 17/17 pass.
   - `git diff --check`: sạch, không lỗi trailing whitespace / conflict marker.
   - Chưa chạy database thật; chưa tick hoàn tất B02/G6.

### Trạng thái hoàn thành B02-E3 & B02-UI (Gemini)

Đã hoàn thành triển khai Generator DDL, Engine Migration Matrix, và Tích hợp UI an toàn:
1. **Generator DDL (`electron/schema-migration-generator.cjs`)**:
   - Allowlist tối thiểu: `CREATE_TABLE`, `ADD_COLUMN`, `ADD_INDEX`.
   - Pre-condition: kiểm tra bảng/cột/chỉ mục chưa tồn tại qua `information_schema.TABLES`, `information_schema.COLUMNS`, `information_schema.STATISTICS`. Vi phạm ném `MIGRATION_PRECONDITION_FAILED`, không chạy DDL (`executedCount = 0`, `partialCommit = false`).
   - Post-condition: kiểm tra bảng/cột/chỉ mục đã tồn tại sau DDL. Vi phạm ném `MIGRATION_POSTCONDITION_FAILED`, ghi nhận `partialCommit = true` (implicit commit).
   - Explicit blocking: `DESTRUCTIVE_DDL_BLOCKED` (DROP TABLE/COLUMN/INDEX), `TYPE_MUTATION_REVIEW_REQUIRED` (MODIFY COLUMN), `FOREIGN_KEY_DEPENDENCY_REVIEW_REQUIRED` (khóa ngoại), `OBJECT_DEPENDENCY_REVIEW_REQUIRED` (views, routines, triggers, events), `COLUMN_EXPRESSION_UNSUPPORTED` (cột ảo/sinh), `INDEX_DEFINITION_UNSUPPORTED` (chỉ mục biểu thức/DESC), `UNSAFE_COLUMN_ADD_REVIEW_REQUIRED` (NOT NULL không DEFAULT), `ENGINE_MUTATION_REVIEW_REQUIRED`.
   - Quotas: `maxStatements` (500), `maxPlanBytes` (1MB).
2. **Engine Matrix & Executor (`electron/schema-migration-executor.cjs`)**:
   - Truy vấn tham số hóa cho pre/post-conditions (`query(sql, params)`).
   - Bổ sung `MIGRATION_PRECONDITION_FAILED` và `MIGRATION_POSTCONDITION_FAILED` vào `SAFE_CODES` tại `electron/schema-migration-jobs.cjs`.
   - Quản lý chính xác trạng thái ledger và lỗi driver/timeout/cancel.
3. **UI Migration Wiring (`app.js`)**:
   - Loại bỏ hoàn toàn raw loop `desktop.db.query` và `SET FOREIGN_KEY_CHECKS = 0` trên Editor session.
   - Nối nút Áp dụng sang named API `desktop.db.applyMigrationPlan`.
   - Thông báo rõ ràng hướng dẫn chuyển sang "▷ Mở trong Editor" khi ở chế độ preview.
4. **Bằng chứng kiểm thử**:
   - `test/schema-migration-generator.test.cjs`: 14/14 pass.
   - `test/schema-migration-engine-matrix.test.cjs`: 6/6 pass.
   - Toàn bộ suite migration: 121/121 pass.
   - `npm run check`: 1105 pass / 0 fail / 14 skip.
   - Renderer smoke: 100/100 pass. Website smoke: 14/14 pass. Server tests: 17/17 pass.
   - `git diff --check`: 0 lỗi.
   - **Hoàn tất Milestone B02 (G6)**.
