# Bàn giao triển khai SqlPro cho Gemini

Ngày cập nhật: 18/11/2026. Mốc đối chiếu ban đầu: f812fc1, phiên bản package 0.3.12.
Tài liệu này là kế hoạch bàn giao dựa trên code và test hiện có, không phải chứng nhận phát hành.

Trạng thái sau review cuối E1: xem [B02_REVIEW_FIXES.md](B02_REVIEW_FIXES.md). Collector/IPC, main-owned preview và admission/approval đã có; 23 test admission và 49 test migration đạt. Digest thống nhất, adapter tự kiểm payload thay vì tin digest caller. Executor thử nghiệm chưa nối Apply IPC; source verifier còn fail-closed. Chốt E1 trong phạm vi offline/Main contracts, chưa nghiệm thu DB thật hoặc toàn B02/G6.

**Nhiệm vụ đang giao: B02-E2 — Job, worker và cancel**, theo thứ tự/file/test/điều kiện nhận ở cuối [B02_REVIEW_FIXES.md](B02_REVIEW_FIXES.md). Chỉ làm E2 rồi gửi Codex review; giữ `MIGRATION_APPLY_NOT_READY` tại Main/service, không thêm đường ghi lách guard. Chưa làm E3 hoặc chuyển B03. Các mục B02 tổng quát bên dưới là đích cuối, không thay thế phạm vi E2.

## 1. Phân công và cách làm từ đây

- **Gemini:** thiết kế chi tiết, triển khai, viết/chạy test và cập nhật bằng chứng cho từng gói bên dưới.
- **Codex:** review diff/commit của Gemini, kiểm tra rủi ro dữ liệu, tính đúng đắn, kiến trúc, test và mức nghiệm thu. Mặc định không tự sửa code, triển khai tiếp hoặc commit thay Gemini; chỉ làm khi người dùng yêu cầu rõ.
- **Người dùng:** giao từng gói, chuyển kết quả/commit cho Codex review, quyết định cho làm gói kế tiếp.
- Mỗi lượt chỉ giao một gói hoặc một phần có thể nghiệm thu độc lập. Không giao “hoàn thành toàn roadmap” trong một lần.
- Một checkbox được tick hoặc một báo cáo cũ nói “an toàn” không thay thế việc đối chiếu đường chạy thật.

Đọc trước: [agent.md](agent.md), [roadmap](DATABASE_PRODUCT_ROADMAP.md), [tiến độ](ROADMAP_PROGRESS.md), [review đợt 22](CODE_REVIEW_BATCH_22.md).

## 2. Còn bao nhiêu phần?

Đếm tại f812fc1: **51 đầu việc roadmap; 29 chưa tick, 22 đã tick**. Đây là số hạng mục, không phải số tính năng chưa có và không suy ra phần trăm hoàn thành.

| Nhóm | Chưa tick / tổng | Hiện trạng và phần còn thiếu |
| --- | --- | --- |
| G0 — baseline/hợp đồng/benchmark | 5/5 | Nhiều test và fixture đã có; thiếu hồ sơ baseline, ma trận nghiệm thu và benchmark thống nhất cho commit phát hành. |
| G1 — bảo vệ kết nối/ghi/transaction | 0/5 | Có policy, production approval, session registry và UI. Giữ và kiểm hồi quy mọi đường ghi mới; không cần viết lại. |
| G2 — backup/kiểm chứng phục hồi | 0/5 | Có catalog, annotations, inspection, trial, recovery journal và manifest. Cần kiểm chứng lại tích hợp khi mở rộng G3. |
| G3 — vận hành backup | 2/6 | Chưa nén/mã hóa và bản sao ngoài máy. G3.1/G3.2/G3.3 đã tick nhưng phạm vi đầy đủ còn phải kiểm lại, xem mục 3. |
| G4 — hiệu năng | 5/5 | Đã có streaming/keyset/cache/filter/virtualized result; chưa nghiệm thu hiệu năng tổng thể và fault/load matrix. |
| G5 — SQL/lọc/chẩn đoán | 3/6 | EXPLAIN/autocomplete/filter có nhiều phần. Còn hoàn thiện scope/dialect/capability và nghiệm thu; snippets/diagnostics đã có, vẫn cần kiểm chứng privacy và phiên đích. |
| G6 — schema/migration | 0/4 | Có UI/module sinh SQL; có khoảng trống rõ trong collector/apply. Không coi toàn G6 là hoàn tất chỉ theo checkbox. |
| G7 — Data Diff/sync | 5/5 | Hiện là báo cáo chỉ đọc, tối đa 2.000 dòng/phía. Đồng bộ và xuất SQL bị khóa có chủ đích. |
| G8 — audit/UX/kiến trúc | 4/5 | Có audit và masking. Còn chia module, UX toàn luồng, thử người dùng, tài liệu cuối. |
| G9 — sync/bảo mật/phát hành | 5/5 | Đã có E2EE sync, CI và workflow build. Còn recovery, migration matrix, security review, installed/upgrade smoke và release runbook. |

Các con số “35/36 việc còn lại”, ước lượng ngày công và bảng hiện trạng cũ trong roadmap là lịch sử. Dùng bảng bàn giao này để xếp việc, rồi cập nhật sau mỗi review.

## 3. Những chỗ đã tick nhưng cần xác minh lại trước

Đây là các quan sát tĩnh tại mốc trên; chưa phải một cuộc audit toàn repository.

| Ưu tiên | Bằng chứng trong code | Việc cần giao Gemini |
| --- | --- | --- |
| P0 — G6.4 migration | showSchemaDiffModal/renderMigrationTab trong app.js gọi db.query từng DDL. Đường này chưa có bước re-capture fingerprint ngay trước apply. Tùy chọn FK gửi SET FOREIGN_KEY_CHECKS=0 rồi 1; cần kiểm tra nhánh lỗi, trạng thái cũ và phiên sở hữu. | Trước hết bổ sung kiểm tra tái hiện, đóng đường apply khi thiếu bằng chứng; sau đó chuyển điều phối sang main và kiểm drift/session/policy. Không hứa rollback DDL. |
| P0 — G6.1/G6.2 snapshot | captureFullSchema trong app.js trả view definition rỗng, routine sql rỗng, triggers/events rỗng và engine cố định MySQL. Một số lỗi đọc metadata bị bỏ qua. | Đọc metadata thật theo capability; denied/thiếu/quota phải unknown, không biến thành “đối tượng không tồn tại” để DROP. Kiểm lại phạm vi generator. |
| P0 — G3.1/G3.2 restore chọn đối tượng | Có RestoreObjectInventory, dependency graph và IPC inspect/preview. db:preview-object-restore-plan nhận targetFacts từ payload; db:restore hiện truyền file/database/dropExisting/taskId vào restoreDatabase, chưa thấy tiêu thụ execution plan chọn đối tượng. | Truy vết UI → preload → main → executor; chứng minh plan được tạo/giữ/kiểm ở main, file identity/hash và selection gắn đúng từng statement. Không coi canExecute trong object preview là quyền ghi. |
| P1 — G3.3 scheduler | backup-scheduler.cjs dùng intervalHours 1–168 và timestamp; timeZone được validate. Đây không tự chứng minh lịch giờ địa phương/DST, retry/backoff hoặc chạy khi app đóng. | Chốt MVP interval/app-open, ghi rõ giới hạn; lịch calendar/DST và OS scheduler là các gói riêng. |
| P1 — G5.5 privacy | Snippets/history đã có tìm/tag/scrub/prune. persistState vẫn lưu savedQuery và SQL của queryTabs. | Kiểm toàn bộ nơi lưu SQL, không chỉ history. Lựa chọn không lưu SQL nhạy cảm phải bao phủ tabs/state/sessionStorage/snippets/export theo chính sách đã công bố. Regex scrub không được quảng bá che hết secret. |
| P1 — G5.6 diagnostics | Processlist/transactions/locks/slow log đã có. Nhiều query và kill gọi activeQueryTarget. | Kiểm target được chụp lúc mở, capability/permission, generation và đúng connection identity lúc kill, không đổi theo tab đang active sau await. |

Không tự xóa dấu tick lịch sử chỉ để làm đẹp số liệu. Mỗi mục cần review riêng, bằng chứng và trạng thái “có một phần/chưa nghiệm thu” rõ ràng.

## 4. Kiến trúc phải giữ

### 4.1 Luồng trách nhiệm

    Renderer: hiển thị, draft, thao tác người dùng
        ↓ named API, payload có schema và quota
    electron/preload.cjs: facade IPC, không logic SQL/secret
        ↓
    electron/main.cjs: xác thực sender/đích, policy, task orchestration
        ↓
    Application services: plan, registry, job, snapshot/token, repository
        ↓
    electron/database.cjs / driver: DB I/O có lease, binding, timeout/cancel

    Pure modules: normalize/compare/compile, không DB/DOM/filesystem
    Repositories ở main: disk, secrets, atomic publication, migration

- Renderer không được cấp quyền ghi bằng confirmed/canExecute/profile flags do chính nó gửi.
- Mọi đích dùng exact tuple profile/database/table và session identity/generation/fingerprint, không nối chuỗi bằng dấu chấm hoặc lowercase toàn bộ.
- Giá trị SQL dùng prepared binding; identifiers quote từ metadata đã kiểm chứng.
- Session/task phải recheck identity sau các await; callback cũ không sửa tác vụ hay modal mới.
- Không tự Commit/Rollback/SET phiên làm việc của người dùng để phục vụ job nền.
- Lỗi/quota/unknown không được biến thành filter rỗng, schema trống, toàn bảng hoặc quyền ghi.
- Test ghi chỉ trên database fixture có marker, trong server thử nghiệm độc lập.

### 4.2 Module hiện có cần tái sử dụng

| Phạm vi | Nền hiện tại |
| --- | --- |
| Session/policy | electron/session-registry.cjs, connection-policy.cjs, production-approvals.cjs |
| Giá trị/lưới | row-values.js, table-filters.js, table-view.js, table-preferences.js, electron/table-data.cjs, table-search.cjs |
| Backup | electron/backup-file.cjs, backup-catalog.cjs, backup-annotations.cjs, backup-inspection.cjs |
| Restore | electron/sql-script.cjs, restore-preflight.cjs, restore-selection*.cjs, restore-trial*.cjs, restore-object-inventory.cjs, restore-dependency-graph.cjs |
| Lịch/dọn | electron/backup-scheduler.cjs, backup-retention*.cjs |
| So sánh | schema-diff.js, data-diff.js |
| SQL/diagnostics | sql-autocomplete.js, query-results.js, query-snippets.js, diagnostics.js |
| Local storage/sync | electron/store*.cjs, sync*.cjs, audit-log.cjs; server/src/* |
| Kiểm thử/đóng gói | test/*.test.cjs, test/renderer-smoke.cjs, test/helpers/renderer.cjs, .github/workflows/*, package.json |

### 4.3 Cấu trúc bổ sung đề xuất

Tên dưới đây là **đề xuất, chưa phải file/API đã có**. Gemini kiểm lại trước khi tạo; không tạo tất cả skeleton trong một PR.

    electron/
      data-diff-service.cjs         # điều phối job đọc/compare
      data-diff-reader.cjs          # chunk/keyset, metadata/key capabilities
      data-diff-snapshot.cjs        # snapshot scope, lifecycle, cleanup
      data-sync-plan.cjs            # plan do main sở hữu, TTL/one-use/state
      data-sync-apply.cjs           # guarded writes, batch, cancel/report
      schema-snapshot.cjs          # collector đầy đủ, unknown/quotas
      schema-migration-service.cjs  # preview/apply, drift, partial DDL report
      restore-plan-service.cjs      # nối inventory/plan/executor hiện có
      backup-container.cjs         # định dạng nén/mã hóa versioned
      backup-replica.cjs            # local replica trước, adapter sau
    renderer/
      data-diff-controller.js      # state/draft/view, không quyền ghi
      schema-diff-controller.js
      backup-controller.js
      query-editor-controller.js
      grid-controller.js
    test/
      data-diff-reader.test.cjs
      data-diff-snapshot.test.cjs
      data-sync-plan.test.cjs
      data-sync-apply.test.cjs
      schema-snapshot.test.cjs
      schema-migration-service.test.cjs
      restore-plan-service.test.cjs

Chỉ tách controller khi có contract tests; không đổi framework hoặc kéo toàn bộ app.js sang kiến trúc khác trong một lượt. Asset renderer mới phải thêm index.html, build.files, check script và VM helper tương ứng.

## 5. Thứ tự giao việc và tiêu chí hoàn thành

Các gói Bxx là đơn vị bàn giao/review; một gói lớn vẫn phải chia nhiều PR. Gói mở đường ghi cần được review trước khi bật UI thực thi.

### B00 — Chốt baseline và ma trận hợp đồng

Bao phủ G0.1–G0.4; làm đầu tiên.

1. Ghi commit, dirty diff, OS, Node/Electron/DB, phiên bản hỗ trợ, quy trình chạy từng suite.
2. Lập bảng mọi IPC ghi: policy, production approval, lease, timeout, cancel, original-value guard, audit và fixture hiện có.
3. Tái sử dụng fixture PK đơn/ghép/no-PK, FK/vòng, JSON/BLOB/BIGINT/DECIMAL, DDL concurrent; bổ sung phần thiếu và marker.
4. Chốt contract target/session/generation/task/report/unknown; phân biệt side effect ở source và target.
5. Xuất BASELINE_REPORT.md và TEST_MATRIX.md, tách pass/fail/skip/chưa có hạ tầng. Không đổi runtime trong gói baseline.

Nghiệm thu: có lệnh tái chạy và đối chiếu code thật; không tính fixture opt-in skip là DB test đã chạy.

### B01 — Xác minh lại các đường rủi ro đã tick

Bao phủ các quan sát ở mục 3 và hồi quy G1/G2.

1. Viết failing tests cho schema apply stale, FK state lỗi, restore preview không ràng buộc executor, callback đổi đích và SQL persistence.
2. Ghi rõ lỗi tái hiện được / nghi vấn chưa tái hiện; không biến nghi vấn thành lời khẳng định.
3. Với đường ghi chưa đủ điều kiện, đề xuất guard cụ thể và triển khai guard sau khi người dùng giao gói sửa.
4. Chia sửa migration, restore, privacy, diagnostics thành các diff riêng.
5. Gửi Codex review trước khi mở rộng tính năng ghi mới.

Nghiệm thu: findings có vị trí code, trigger, tác động, test và trạng thái. Không “sửa” bằng cách thêm checkbox xác nhận ở renderer.

### B02 — Hoàn thiện snapshot schema và apply migration

Bao phủ khoảng trống G6.1–G6.4; ưu tiên trước mở đồng bộ dữ liệu.

1. Chuyển collector DB về main; đọc engine/version/capability thật, name/type/default/generated/collation/index/FK/view/routine/trigger/event.
2. Mỗi lớp có complete/unknown/reason/quota; denied không trở thành array rỗng có nghĩa “không tồn tại”.
3. Snapshot/hash gắn đúng profile/session/database và scope; giữ định nghĩa cần thiết ở main, renderer chỉ nhận projection.
4. Generator chỉ sinh phần đã hỗ trợ; rename cần mapping tường minh; dependency/cycle/DEFINER chưa xử lý phải blocked.
5. Main giữ migration plan, kiểm policy/đích/DDL drift ngay trước chạy; báo từng statement và phần đã thay đổi.
6. Không tự tắt FK checks. Nếu hỗ trợ thay session setting, dùng worker riêng, chụp/khôi phục đúng giá trị cũ và kiểm nhánh lỗi/cancel.
7. Test source không đổi, DDL implicit commit, table rebuild, quyền thiếu, source/target/schema drift và partial failure trên cả hai engine.

Nghiệm thu: full snapshot không có placeholder giả; apply không chỉ phát lại mảng SQL renderer; không hứa rollback toàn bộ DDL.

### B03 — Nối restore chọn đối tượng từ preview tới executor

Bao phủ kiểm chứng lại G3.1/G3.2.

1. Lập đường đi UI → named IPC → inventory → main-owned plan → executor, dùng lại các module hiện có.
2. Thay targetFacts renderer bằng dữ kiện collector đáng tin tại main; phiên bản hóa plan và projection.
3. Bind hash/file identity, nguồn/đích/session, selection, conflict policy, dependency và thời hạn.
4. Trước ghi kiểm lại file/đích/selection/policy và trạng thái job; plan bị stale phải đọc lại.
5. Executor chỉ chạy statement thuộc đối tượng/section đã chọn và dependency được duyệt; không fallback full restore khi parser không hiểu.
6. Hỗ trợ progress/cancel/quota/worker, file đổi giữa scan và apply; không giữ toàn SQL lớn trong RAM để làm inventory.
7. Fixture table/view/routine/trigger/event, FK vòng, dynamic SQL unknown, file malformed, scope khác DB và DDL partial commit.

Nghiệm thu: có end-to-end test chứng minh đối tượng không chọn không bị tác động; preview canExecute không tự là quyền chạy.

### B04 — Data Diff collector theo chunk/keyset, chỉ đọc

Bao phủ G7.1. Đây là gói tiếp theo sau các guard nền; **không mở lại sync**.

1. Tạo service/job ở main với named IPC start/status/cancel/result; renderer không tự SELECT hai bảng rồi giữ toàn kết quả.
2. Đọc metadata và PRIMARY/UNIQUE definitions thật, không suy unique key từ cờ UNI. MVP ưu tiên PK.
3. Chặn key nullable/partial/unsupported, mapping/schema/collation không tương thích; báo lý do thay vì đoán.
4. Quét chunk theo khóa, có row/byte/time quotas và backpressure; kiểm task/target sau mỗi await.
5. Chốt cách ghép keys khi hai DB có collation/order khác nhau. Không dùng phép so string JS để giả thứ tự SQL trên hai server.
6. Giữ counters và số mẫu hữu hạn; nếu cần lưu/spool phải do main quản lý với ownership, quota, TTL và cleanup.
7. Quota/cancel/mất mạng tạo báo cáo incomplete, giữ canSynchronize=false; không suy “không có dòng” từ trang chưa quét.

Nghiệm thu: quét nhiều hơn 2.000 dòng mà bộ nhớ không tăng theo toàn bảng; không query ghi; source/target vẫn nguyên. LIMIT hiện tại chưa phải reader hoàn chỉnh.

### B05 — Canonical data đầy đủ

Bao phủ G7.2; có thể làm sau B04 theo từng kiểu.

1. Giữ decimal string và JSON numeric lexemes hiện có; không quay lại Number hoặc JSON.parse làm mất chữ số.
2. Xác định transport đầy đủ cho binary/BLOB/BIT, không so preview có dấu cắt với giá trị thật.
3. Chốt JSON duplicate-key policy, NULL/empty, charset/collation, timestamp timezone và temporal precision theo engine.
4. Bản không hỗ trợ phải unknown/blocked; hash chỉ là bộ lọc, không đủ căn cứ ghi.
5. Thêm round-trip/integration cho từng kiểu, signed/unsigned, generated columns, Unicode và source/target capabilities khác nhau.

Nghiệm thu: ma trận giá trị rõ phần được hỗ trợ; không tuyên bố canonical toàn MySQL/MariaDB chỉ dựa vài unit test.

### B06 — Snapshot và mức nhất quán Data Diff

Bao phủ G7.4, phụ thuộc B04 và phần kiểu cần dùng từ B05.

1. Dùng kết nối đọc riêng, quản lý lease/generation và transaction/snapshot do job tự mở; không thay phiên editor.
2. Gắn snapshot với hai phía và thời điểm quan sát; hai snapshot độc lập trên hai máy không phải một snapshot nguyên tử toàn hệ thống.
3. Chốt engine isolation được hỗ trợ, giới hạn thời gian giữ snapshot và tác động undo/lock; mixed engine/DDL concurrent phải báo hạn chế.
4. Chụp schema/settings cần thiết trước/sau; reconnect/DDL/cancel/permission change làm evidence stale.
5. Cleanup chỉ đóng/rollback snapshot của job; lỗi cleanup phải được báo và không cấp quyền apply.
6. UI hiện scope, coverage, consistency và thời hạn báo cáo. Thiếu bằng chứng giữ đồng bộ bị khóa.

Nghiệm thu: concurrent data/DDL tests chứng minh đúng mức bảo đảm được công bố; không chỉ gán consistent=true.

### B07 — Preview plan đồng bộ do main sở hữu

Bao phủ phần preview G7.3, sau B04–B06.

1. Tạo plan từ dữ kiện main, phân loại insert/update/delete; mặc định không chọn delete.
2. Plan giữ exact scope, session/profile fingerprint, metadata version, snapshot evidence và originals cần đối chiếu.
3. Renderer chỉ chọn action IDs; main kiểm lại danh sách/quota và giữ plan/token opaque, TTL và trạng thái một lần.
4. Thay đổi lựa chọn/đích/policy/snapshot làm plan cũ không còn dùng được; không tin diffResult/canExecute/confirmed từ renderer.
5. Vòng đời token ready → confirming → applying → complete/stopped/expired; chuyển trạng thái chống replay trước await, recheck sau native confirmation.
6. Preview chỉ đọc, không dùng formatSqlValue hoặc SQL literal tự sinh ở renderer để thực thi.

Nghiệm thu: payload giả, action lạ, token hết hạn/replay, hai apply đồng thời và logout đều không ghi.

### B08 — Executor đồng bộ có điều kiện và báo cáo phần đã commit

Hoàn thiện G7.3; cần review B07 trước khi bật.

1. Policy/production approval/session admission giữ ở main, xác nhận rõ đúng đích và phạm vi.
2. INSERT xử lý conflict đúng policy; UPDATE/DELETE đối chiếu key và snapshot gốc đầy đủ, xác nhận affected rows/matched rows.
3. Chốt dữ liệu nguồn thay đổi sau snapshot được xử lý thế nào: áp snapshot đã duyệt hay yêu cầu làm mới; hiển thị rõ.
4. Chỉ nhận engine/trigger/cascade semantics được hỗ trợ; không suy rollback được mọi tác động gián tiếp.
5. Batch có transaction và giới hạn lock/time/byte; không commit transaction editor. Nếu hỗ trợ dùng lại phiên phải giữ savepoint và semantics hiện có.
6. Cancel/mất mạng dừng có báo cáo added/updated/deleted/conflict/skipped/failed/committed; kết quả không rõ phải unknown, không tự replay.
7. Sau thành công invalidation metadata/count/grid có đúng scope; audit chỉ summary đã che dữ liệu.
8. Chỉ khôi phục UI apply sau khi real-DB conflict/cancel/partial-commit tests và Codex review đạt.

Nghiệm thu: source không ghi; target không bị ghi đè khi drift; chạy lại không nhân đôi; số báo cáo khớp DB. Export SQL, nếu làm, là tính năng riêng có cảnh báo không giữ bảo đảm của executor.

### B09 — Đồng bộ nhiều bảng

Bao phủ G7.5, chỉ sau single-table được nghiệm thu.

1. Dependency graph từ FK/metadata đáng tin, giới hạn số bảng/job và tài nguyên.
2. Đặt thứ tự insert/update/delete, cycles cần policy riêng; không tự tắt FK checks để vượt lỗi.
3. Progress/checkpoint gắn revision, không tự resume từ điểm không chứng minh được commit.
4. Retry chỉ khi chứng minh idempotency; không retry mù batch ghi sau mất kết nối.
5. Kiểm FK cascade/trigger, lỗi ở bảng giữa và job bị cancel.

### B10 — Backup nén/mã hóa theo luồng

Bao phủ G3.5.

1. Đặc tả định dạng container/version/header, SQL cũ, hash stored-file so với content hash.
2. Thiết kế threat model, KDF/salt/nonce, authenticated encryption và quản lý khóa bằng thư viện chuẩn; kiểm tài liệu chính thức hiện hành trước khi chọn tham số.
3. Thống nhất fail-closed khi sai mật khẩu/tag/truncated/quota; không cho SQL chưa xác thực chạy vào database.
4. Chọn chiến lược verify toàn bộ hoặc authenticated chunks trước restore; bảo đảm nội dung không bị thay giữa verify và consume.
5. Pipeline read → compress → encrypt → atomic publish với backpressure/cancel; không đưa password vào manifest/log/renderer-state.
6. Trial/inspection/export hỗ trợ định dạng mới; giới hạn decompression bomb, disk full và temp plaintext.
7. Test round-trip, wrong key, tamper đầu/giữa/cuối, header lạ, crash và tệp SQL legacy.

Nghiệm thu: giải mã sai không thực thi dù chỉ một statement; có recovery/key-management guide.

### B11 — Bản sao backup ngoài máy

Bao phủ G3.6, local directory/ổ khác trước remote.

1. Adapter copy/verify/delete/status; nguồn và đích dùng path/capability được main kiểm.
2. Copy sang temp ở đích, verify hash, atomic publish; thử cross-device semantics.
3. Trạng thái từng nơi độc lập, copy chưa verify không được tính bản bảo vệ cho retention.
4. Retry không overwrite nhầm file mới; mất ổ/mạng/disk full/cancel không làm backup gốc thành lỗi giả.
5. Sau local MVP mới thêm remote adapter với credential ở main/secret store và timeout/quota.

### B12 — Scheduler đầy đủ hơn

Kiểm chứng G3.3; không viết lại interval scheduler đang có.

1. Nghiệm thu interval/app-open, missed/busy/restart/sleep/wake và claim chống trùng.
2. Nếu cần “mỗi ngày lúc 02:00”, tách calendar schema/migration; quy định DST gap/fold và đổi timezone/clock.
3. Retry/backoff chỉ tạo bản mới/claim khi an toàn, không chạy bù dồn.
4. OS scheduler chạy khi app đóng là bước riêng, kiểm secret availability khi desktop bị khóa/logout.
5. Test DST, clock jump, crash trước/sau claim/publication và đúng một job chạy.

### B13 — Metadata và bộ lọc

Bao phủ G4.1/G4.2 và nghiệm thu G5.4.

1. Giữ typed predicates/shared grid-count-export, AND/OR/IN/NOT IN/sort/visible-column/local preference đã có.
2. Đo metadata đọc khi mở DB nhiều bảng; chuẩn hóa lazy/single-flight/TTL/size/generation và DDL invalidation.
3. Chốt operator/type/dialect còn cần theo ma trận, không thêm tùy ý để checkbox “xong”.
4. Kiểm exact/prefix/contains/NULL/list, charset/collation/timezone/SQL mode và prepared binding cả hai engine.
5. Đo EXPLAIN/workload thích hợp trước thay SQL vì index; không hứa prefix luôn dùng index.
6. Metadata drift/quota/invalid saved preference không được tự bỏ filter hoặc mở toàn bảng.

### B14 — SQL Editor, EXPLAIN, snippets và diagnostics

Bao phủ G5.2/G5.3; kiểm chứng lại G5.5/G5.6.

1. Autocomplete: fixture caret/scope/JOIN/CTE/derived/set output, quoted/Unicode và SQL chưa hoàn chỉnh; không lookup sai nguồn local.
2. Parser/dialect mới phải qua fixture/packaging trước, không đổi dependency chỉ vì tên thư viện.
3. EXPLAIN: giữ DEFAULT/JSON/TREE/ANALYZE riêng; capability/unknown rõ, không fallback ngầm hoặc chạy ANALYZE tự động.
4. Schema/bind/settings context ngoài grammar hiện tại phải unknown; không suy plan tương đương hay nhanh hơn từ text diff.
5. Privacy: contract opt-in/retention cho history/tabs/snippets/state/sessionStorage; scrub không che hết secret thì không quảng bá đã che hết.
6. Diagnostics: capture target/session, capability MySQL/MariaDB/permissions, polling bounded và pause ẩn; kill kiểm đúng connection identity.
7. Test keyboard/undo/redo, đổi tab/đích lúc await, schema drift, thiếu quyền và installed assets.

### B15 — Benchmark, render và pipeline

Bao phủ G0.5/G4.3/G4.4/G4.5.

1. Benchmark nhỏ/vừa/lớn có dataset/hardware/OS/version cố định; 1/10/20 GB nếu hạ tầng cho phép, không thử được phải ghi rõ.
2. Thu RSS/heap/CPU/event-loop/UI latency/throughput/temp disk; nhiều mẫu UI để báo p95 có ý nghĩa.
3. Profile rồi mới tối ưu render/virtualization/focus/scroll/selection/cache/progress throttling.
4. Điều chỉnh batch/stream/backpressure dựa số đo; không tăng concurrency restore cùng đích để lấy tốc độ.
5. Lặp trước/sau, fault disk full/mạng chậm/cancel; ngưỡng phải chốt trước đo và giải thích mọi thay đổi an toàn làm chậm.

### B16 — Tách module và nghiệm thu UX

Bao phủ G8.2–G8.5; thực hiện tăng dần cùng các gói trên.

1. Contract tests quanh controller; tách Data Diff/Schema Diff/backup trước, rồi editor/grid/forms/tasks.
2. Main chỉ giữ routing/orchestration mỏng; DB query/backup/restore tách theo hợp đồng đang có.
3. Mỗi PR di chuyển một hành vi, không trộn rewrite lớn với thay đổi SQL ghi.
4. Kiểm focus/keyboard/Escape/Enter, modal dài, dark theme, 940×700 và resize; phím tắt phải dùng lần hai/lần ba vẫn đúng.
5. Thử tối thiểu 5 người quy trình kết nối → query → sửa → backup → trial; đo thời gian/lỗi và tạo ticket từ quan sát.
6. Cập nhật README, website source generator/screenshots, agent.md và giới hạn theo code thật, không theo mong muốn.

### B17 — Recovery và tương thích sync

Bao phủ G9.1/G9.2.

1. Threat model/recovery kit/thiết bị mới/đổi mật khẩu/xóa tài khoản/conflict policy; không hứa phục hồi vault nếu mất khóa.
2. Fixture profile/vault từ bản cũ và bản mới, tombstone, schema migration và conflict.
3. Logout/reset/remote deletion/config change phải vô hiệu callback cũ; không hồi sinh secret hoặc ghi đè dữ liệu mới.
4. Server SQLite backup/restore, concurrency/quota/body limits và load; không giảm KDF để test chạy nhanh.
5. Giữ beta riêng nếu recovery hoặc compatibility chưa nghiệm thu.

### B18 — Security review, CI và release

Bao phủ G9.3–G9.5; chốt cuối mỗi đợt phát hành.

1. IPC sender và frame/origin, payload schema/quota/path; không chỉ dựa tên channel hoặc renderer UI.
2. CSP/navigation/preload isolation, secret storage, dependency và untrusted SQL/manifest/name/config; sidecars quản lý cùng lifecycle backup.
3. CI hiện có phải được mở rộng, không tạo lại từ đầu: MySQL + MariaDB mục tiêu, fixtures opt-in thật, renderer/website/server.
4. Bản ASAR và bản đã cài Windows/Ubuntu: upgrade, giữ profiles/preferences/backups, uninstall/reinstall và recovery.
5. Kiểm version/tag/lockfile/artifact/hash/signature theo chính sách; không publish chỉ vì unit tests xanh.
6. Release notes, migration/recovery guide, disk full/mất mạng/mất khóa và rollback bộ cài.

Nghiệm thu: mất dữ liệu, sai session/đích, lộ secret, backup/restore false-success hoặc missing installed evidence là chưa được phát hành.

## 6. Bao phủ toàn bộ 29 mục chưa tick

Bảng này để Gemini không bỏ sót; không phải yêu cầu triển khai song song.

| Roadmap ID | Gói bàn giao |
| --- | --- |
| G0.1 | B00 |
| G0.2 | B00, B18 |
| G0.3 | B00 và fixture từng gói |
| G0.4 | B00, B02–B08 |
| G0.5 | B15 |
| G3.5 | B10 |
| G3.6 | B11 |
| G4.1 | B13 |
| G4.2 | B13 |
| G4.3 | B15, B16 |
| G4.4 | B15 |
| G4.5 | B15 |
| G5.2 | B14 |
| G5.3 | B14 |
| G5.4 | B13 |
| G7.1 | B04 |
| G7.2 | B05 |
| G7.3 | B07, B08 |
| G7.4 | B06 |
| G7.5 | B09 |
| G8.2 | B16 |
| G8.3 | B16 và UI mỗi gói |
| G8.4 | B16 |
| G8.5 | B16 và tài liệu mỗi gói |
| G9.1 | B17 |
| G9.2 | B17 |
| G9.3 | B18 |
| G9.4 | B18 |
| G9.5 | B18 |

Thứ tự đề nghị: B00 → B01 → sửa P0 ở B02/B03 → B04 → B05 → B06 → B07 → B08 → B09.
B10–B18 đi theo phụ thuộc riêng, không cần dồn toàn bộ sau B09; vẫn mỗi lần giao một phần, chốt review xong rồi chuyển tiếp.

## 7. Hợp đồng tối thiểu cho mọi job mới

Đây là schema thiết kế đề nghị, cần chốt/test ở B00; không phải API hiện có.

    TargetScope:
      profileId, profileFingerprint, sessionId, generation
      database, table, metadataVersion

    ReadEvidence:
      jobId, scope, engineCapabilities, startedAt, finishedAt
      coverage: complete | partial | unknown
      consistency: observed | per-side-snapshot | unsupported
      counters, limits, warnings, snapshotIdentity

    Preview:
      opaquePlanId, revision, expiresAt, mainOwnedEvidence
      allowedActionIds, defaultSelection, blockers
      rendererProjection: counters + bounded samples + warnings

    ApplyReport:
      operationId, planRevision, scope, status
      inserted, updated, deleted, conflicts, skipped, failed
      committedBatches, affectedRows, unknownOutcomes, cancellation
      sanitizedErrorCode, cleanupStatus

- Quyền thực thi không được suy từ một boolean trong projection.
- Mọi quota gồm số lượng và byte; không chỉ count rows.
- Plan có dữ liệu dòng nhạy cảm cần TTL/cleanup và không ghi ra log/vault tùy tiện.
- Tính nhất quán, completeness và khả năng apply là ba khái niệm riêng.
- Với process crash/mất mạng mà không biết commit đã xong chưa: báo unknown, không tự retry.

## 8. Kiểm thử và bằng chứng phải bàn giao

Baseline gần nhất đã ghi ở đợt 22, **không phải test mới chạy trong lượt lập kế hoạch này**:
960 pass / 0 fail / 14 opt-in skip; Electron workspace/ASAR 100/100; website 14/14; server 17/17; Data Diff fixture 3/3 mỗi MySQL/MariaDB; MySQL regression 33/33.

Lệnh nền:

    npm run check
    npm run test:renderer
    npm run test:website
    npm --prefix server run check
    npm run server:test
    git diff --check

DB fixtures phải bật đúng biến môi trường và chỉ trỏ server thử nghiệm. Ví dụ khi đã dựng isolated server:

    SQLPRO_DATA_DIFF_PORT=13317 node --test test/data-diff-integration.test.cjs
    SQLPRO_TEST_MYSQL_PORT=13317 npm run test:mysql

Không tự dùng cổng ứng dụng hoặc database đang có dữ liệu người dùng. Không có hạ tầng thì ghi “chưa chạy”, không giả pass. Không dùng sandbox rút gọn số test để thay kết quả subprocess đầy đủ.

| Thay đổi | Bằng chứng bổ sung |
| --- | --- |
| Query/type/compare | Real MySQL + MariaDB; NULL/empty/Unicode/big numbers/binary/JSON/timezone/collation/SQL mode phù hợp phạm vi |
| Write/transaction | Original drift, concurrent writer, missing row, duplicate key, engine/trigger/cascade, cancel/network loss và dữ liệu sau lỗi |
| File/backup/restore | Round-trip, tamper/truncated, identity đổi, disk full, crash, quota, cancel và cleanup |
| UI/lifecycle | Bàn phím, focus, modal đóng/thay, đổi profile/DB/tab, dark/small và không unhandled rejection |
| Store/sync | Legacy migration, corrupt/future file, ciphertext không mất, logout/generation/tombstone/conflict |
| Performance | Trước/sau cùng workload/hardware, RAM/CPU/latency/throughput |
| Packaging | Asset trong ASAR khớp source, smoke runtime đóng gói; installed/upgrade khi tới B18 |

Mỗi gói báo: commit gốc, file đổi, thiết kế, test names/lệnh/kết quả, fixture/engine, giới hạn chưa kiểm, migration, rủi ro còn lại. Không đưa secret hoặc raw SQL/data thật vào báo cáo.

## 9. Giao việc cho Gemini và gửi lại Codex review

### Mẫu prompt cho Gemini

    Đọc GEMINI_IMPLEMENTATION_HANDOFF.md và agent.md tại commit hiện tại.
    Chỉ làm gói Bxx: [tên], phần [phạm vi nhỏ].
    Trước khi code, xác minh đường chạy thật và tests hiện có; bảo toàn dirty changes.
    Nêu file/hợp đồng sẽ đổi và tiêu chí nghiệm thu cụ thể.
    Không mở đường ghi bị khóa nếu chưa đủ các gói phụ thuộc/bằng chứng.
    Không thao tác DB thật, không tự push/phát hành.
    Thêm regression tests, chạy checks phù hợp, cập nhật tiến độ theo kết quả thật.
    Kết thúc báo diff/commit, tests pass/fail/skip, hạn chế và rủi ro để Codex review.

Nhiệm vụ đầu tiên nên giao: **B00 baseline**, tiếp đến **B01 kiểm chứng G6 migration và G3 restore**, không yêu cầu Gemini bật lại Data Sync ngay.

### Mẫu gửi Codex

    Review code Gemini cho gói Bxx.
    Base commit: ...
    Head commit hoặc diff workspace: ...
    Hành vi mong muốn: ...
    Test/log/bằng chứng Gemini báo: ...
    Chỉ review, không sửa code hoặc commit.

### Cách Codex báo review

1. Findings theo mức nghiêm trọng, có file/vị trí, điều kiện tái hiện, tác động và đề nghị sửa.
2. Phân biệt bug đã xác nhận, rủi ro cần kiểm chứng và test chưa chạy.
3. Kiểm riêng dữ liệu nguồn/đích, policy/session/transaction, precision/schema drift, async lifecycle, security/privacy và packaging.
4. Test phù hợp bằng fixture an toàn khi cần để xác minh; không tự sửa code. Thêm test hay sửa để chứng minh bug phải được người dùng giao rõ.
5. Kết luận: cần sửa trước / còn thiếu bằng chứng / chưa thấy lỗi trong phạm vi đã xem. Không nói “an toàn toàn bộ” chỉ vì test xanh.
6. Gemini sửa findings theo từng vòng; Codex review lại từ diff trước, tránh yêu cầu lặp lại phần đã đạt nếu không có thay đổi/rủi ro mới.

Chỉ đánh dấu roadmap hoàn tất sau khi code, đường UI/IPC/DB thực, fixtures và bằng chứng nghiệm thu cùng khớp.
