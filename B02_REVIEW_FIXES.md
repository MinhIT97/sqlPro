# B02 — Sửa findings và bàn giao tiếp

Ngày cập nhật: 18/11/2026. Gói này lưu cả hồ sơ B00/B01 và collector B02 đã được chỉnh sau review. B01 là xác minh rủi ro; các lỗi runtime của migration/diagnostics/privacy trong báo cáo chưa được sửa bởi gói này.

**Hiện trạng mới nhất:** E1 đã chốt review trong phạm vi admission/approval và test offline/Main contracts. Executor thử nghiệm **chưa nối vào Apply IPC**; service chỉ tạo preview, Apply vẫn trả `MIGRATION_APPLY_NOT_READY`, source verifier vẫn trả `SOURCE_VERIFIER_NOT_READY`. Gemini làm **B02-E2** theo phần bàn giao cuối tài liệu; chưa chuyển B03 hoặc coi B02/G6 hoàn tất.

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

## Giao Gemini làm tiếp: B02-E2 — Job, worker và cancel

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

### Gói sau E2 — chưa giao triển khai

- **B02-E3 — generator và nghiệm thu engine:** allowlist DDL tối thiểu theo capability; kiểm schema kỳ vọng trước/sau từng bước, explicit block dependency/metadata chưa hỗ trợ; MySQL/MariaDB cô lập có marker và user quyền tối thiểu. Test drift, quyền thiếu, FK, implicit commit, lỗi ở câu đầu/giữa, timeout/cancel và kết quả schema thực. Chỉ đề xuất bỏ guard sau review bằng chứng toàn đường chạy; UI chuyển sang named APIs là phần tích hợp sau đó.
