# Review triển khai Gemini — 18/11/2026

> **Trạng thái hiện tại:** [Review cuối, các lỗi đã sửa và việc chưa làm](CODE_REVIEW_FINAL_2026_11_18.md). Các số liệu/findings phía dưới giữ lịch sử trước lượt chốt này.

> **Cập nhật sau sửa lỗi 18/11:** [Kết quả sửa V01–V04](CODE_REVIEW_GEMINI_2026_11_18_R5_FIXES.md) là trạng thái mới nhất. Nội dung review bên dưới giữ nguyên làm lịch sử trước sửa.

**Mốc hiện hành: [review vòng 5](CODE_REVIEW_GEMINI_2026_11_18_R5.md).** Probe vòng 4 đã cải thiện, nhưng còn 4 nhóm (1 P0, 2 P1, 1 P2): SQL mode/lexing, loại biến và DEFAULT, COMMIT ACK, late connect sau timeout. Các mốc cũ bên dưới là lịch sử đối chiếu.

**Mốc hiện hành: [review vòng 4](CODE_REVIEW_GEMINI_2026_11_18_R4.md).** Đã xác nhận cải thiện approval/no-replace replica; còn 4 nhóm (1 P0, 3 P1), gồm RENAME bị literal COMMENT đánh lừa. Các kết luận vòng 1–3 bên dưới là lịch sử, không phải trạng thái bản mới.

**Mốc hiện hành: [review vòng 3](CODE_REVIEW_GEMINI_2026_11_18_R3.md).** Đã kiểm lại bản sửa sau vòng 2; còn 5 nhóm (2 P0, 3 P1), gồm regression thiếu approval token vẫn chạy Production restore. Vòng 1/vòng 2 bên dưới là lịch sử, không dùng để kết luận trạng thái bản mới.

**Đã có review vòng 2:** [kết quả kiểm lại bản sửa](CODE_REVIEW_GEMINI_2026_11_18_R2.md). Các mô tả bên dưới là snapshot vòng 1; không dùng nguyên trạng để kết luận lỗi vẫn còn hoặc đã sửa hết. Vòng 2 xác nhận một số biện pháp chặn/sửa có tác dụng, nhưng selective restore vẫn còn P0 và chưa nghiệm thu “12/12 triệt để”.

**Kết luận: chưa nghiệm thu các gói B02–B18 là hoàn tất; chưa đủ điều kiện phát hành.** Các số test trong bảng bàn giao chạy lại đều pass, nhưng nhiều test chỉ xác minh module với driver giả. Có đường IPC ghi dữ liệu chưa giữ hợp đồng an toàn của ứng dụng, UI cũ vẫn chạy migration trực tiếp, và một số gói được báo hoàn thành khác với phạm vi bàn giao ban đầu.

Phạm vi: diff và tệp mới trong working tree trên HEAD `7ede1a6`, package `0.3.12`; Linux `7.0.0-43-generic`, Node `v22.22.3`, Electron `45.0.0`. Bản triển khai Gemini đang chưa commit. Đây là review và hồ sơ tái hiện; lượt này không sửa runtime hoặc commit thay Gemini.

## 1. Lỗi cần sửa

Ghi nhận **12 findings: 2 P0, 9 P1, 1 P2**. P0 là đường thực thi đang được công bố qua IPC có thể phát lệnh ghi vượt phạm vi đã kiểm chứng. Phân loại này không có nghĩa đã ghi/xóa dữ liệu thật: mọi tái hiện dưới đây dùng driver giả và tệp tạm.

### R01 — P0: Main lập kế hoạch sync từ dữ liệu do renderer tự khai

- Vị trí: `electron/main.cjs:2329`, `electron/data-sync-plan-service.cjs:81`, `electron/data-sync-executor.cjs:47`.
- `db:create-data-sync-plan` chuyển nguyên payload vào planner. Renderer gửi được `diffReport`, scopes, row values và `includeDeletes: true`; không cần observation/snapshot ID do Main cấp. Planner không kiểm `coverage.complete`, `consistent` hoặc `canSynchronize`. `store` có trong constructor nhưng không dùng để xác thực bằng chứng nguồn/đích.
- Tái hiện qua **main.cjs thật trong VM**, dùng fixture đang có: gửi report có cả ba cờ bảo đảm bằng `false`, yêu cầu xóa dòng id=1. Main trả plan token; apply phát `DELETE FROM sample.users WHERE id = ?`, rồi `COMMIT` trên driver giả. Không có bước Data Diff trước đó. `profileId` ở apply còn có thể khác profile trong plan.
- Cần sửa: tạm chặn đường Apply mới; Main chỉ nhận report/job/snapshot ID đã lưu cùng scope đầy đủ. Chỉ tạo write plan từ dữ kiện đủ điều kiện; không nâng bounded observation thành bằng chứng dòng vắng mặt toàn bảng. Bind source/target identity, policy, generation, expiry và options trong immutable plan.
- Test nhận: report/scopes/rows/deletes giả, report partial/inconsistent/stale và job không thuộc context đều bị từ chối **trước DML**, chạy qua handler Main thật.

### R02 — P0: Selective restore thực thi SET GLOBAL và ghi sang database khác

- Vị trí: `electron/restore-selection-executor.cjs:20`, `:163`, `:173`, `:200`.
- Mọi câu bắt đầu bằng `SET` được gửi thẳng xuống worker; không qua allowlist session context/preflight hiện có. Regex nhận diện đối tượng bỏ phần schema qualifier, rồi executor chạy nguyên SQL. Việc chọn bảng `users` vì thế cho phép `INSERT INTO other_db.users ...`.
- Tái hiện bằng **RestorePlanService + RestoreSelectionExecutor thật**: dump chứa `SET GLOBAL max_connections=999` được plan đánh dấu `ready`, rồi phát lệnh đó. Dump chứa `INSERT INTO other_db.users VALUES (1)` cũng `ready` và được thực thi, dù target là `sample`.
- Cần sửa: dùng chung kiểm tra statement/schema/context đã có trong restore hiện hành; từ chối server/global/persist và SET chưa hỗ trợ; schema ghi rõ phải đúng exact-case target. Executor phải bám các bước được plan chấp thuận, không chỉ lọc lại tên đối tượng. Quyền DB tối thiểu vẫn cần giữ cho tác động gián tiếp của routine/trigger.
- Test nhận: GLOBAL/PERSIST/SET lạ, qualified name khác đích, multi-object DDL, routine/trigger ghi ngoài scope và tên quote/case phải có fixture; kiểm không có lệnh ghi được phát khi plan không hợp lệ.

### R03 — P1: Checksum đã tính trong plan không được kiểm lại khi restore

- Vị trí: `electron/restore-plan-service.cjs:156`, `electron/restore-selection-executor.cjs:89`.
- Plan lưu checksum/dev/ino nhưng executor chỉ so `size` và `mtimeMs`. Sau đó mở stream mới, không ràng buộc nội dung thực thi với checksum hoặc danh sách steps đã duyệt.
- Tái hiện: tạo plan cho `VALUES (1)`, sửa dump thành `VALUES (9)` cùng độ dài, đặt lại mtime cũ. Executor báo thành công và phát `VALUES (9)`.
- Cần sửa: giữ file lease/identity, xác minh checksum và đọc từ nguồn bất biến gắn plan; kiểm TOCTOU giữa xác minh và thực thi. Dùng hash byte gốc, không coi size/mtime là proof nội dung.
- Test nhận: thay file cùng size/mtime, thay inode/symlink, mutation trong lúc đọc và backup bị retention/copy thay thế; phải dừng trước ghi hoặc báo uncertainty chính xác nếu đã gửi lệnh.

### R04 — P1: Replica có thể xóa backup nguồn hoặc bản replica tốt sẵn có

- Vị trí: `electron/backup-replica-manager.cjs:49`, `:78`, `:89`; IPC `electron/main.cjs:2379`.
- `copyAtomic` rename đè destination trước khi so checksum mong đợi; mismatch thì unlink destination. Không chặn source và destination cùng file. Renderer được gửi `destinationDir` và `expectedFileChecksum`.
- Tái hiện: source `source.sql`, destinationDir chính là thư mục source, expected checksum sai, một lần thử. Hàm trả `REPLICA_CREATION_FAILED` và **source không còn tồn tại**. Đích đã có replica tốt cũng có thể bị thay rồi xóa khi mismatch.
- Cần sửa: chặn cùng canonical path/inode; verify tệp `.part` trước publication; không overwrite dữ liệu đã có nếu chưa có quy trình xác nhận rõ; giữ bản tốt khi fail. Dùng checksum Main/catalog, phối hợp file locks/retention, quản lý sidecars và publish bền vững phù hợp nền tảng.
- Test nhận: same-directory/same-file/hardlink/symlink, destination có sẵn, checksum sai, disk-full, crash trước/sau publication và sidecar lỗi; nguồn/bản tốt luôn được giữ.

### R05 — P1: Giải mã sai mật khẩu xóa tệp đích đã có

- Vị trí: `electron/backup-crypto.cjs:88`, `:177`, `:198`.
- Encrypt/decrypt dùng `createWriteStream` mặc định truncate đích. Khi decrypt lỗi, unlink đích mà không phân biệt tệp mới với tệp người dùng đã có.
- Tái hiện: destination chứa `DO NOT DELETE`, giải mã bằng mật khẩu sai. Hàm trả `BACKUP_DECRYPTION_FAILED`, destination đã bị xóa.
- Cần sửa: ghi tệp tạm độc quyền, xác thực tag/hash và hoàn tất stream trước publication; cleanup chỉ tệp tạm do chính operation sở hữu; tránh source/destination alias. Thêm quota/decompression limits và lưu checksum/format vào manifest/catalog.
- Test nhận: wrong password/tamper giữ nguyên destination có sẵn; source=destination, lỗi ghi, cancel/crash, leftover `.part`, input cũ và file nén quá giới hạn.

### R06 — P1: DELETE sync bỏ kiểm tra original values và chưa xác minh khả năng rollback

- Vị trí: `electron/data-sync-executor.cjs:82`, `:188`.
- Planner giữ `originalValues` cho DELETE nhưng executor chỉ dùng PK. Dòng đã bị người khác sửa vẫn bị xóa nếu PK còn tồn tại. UPDATE chỉ guard các cột sửa bằng so sánh `=`, chưa giữ hợp đồng so sánh chính xác text/JSON/binary của ứng dụng.
- Executor kiểm tên/type cột và PK nhưng không kiểm engine; transaction theo batch không chứng minh rollback được với MyISAM hoặc tác động trigger sang engine khác. `affectedRows === 0` chỉ phát hiện dòng không khớp WHERE đang dùng, không tự chứng minh optimistic concurrency đầy đủ.
- Cần sửa: snapshot nguyên bản cho từng dòng, guard chính xác theo kiểu, kiểm capability/engine trong phạm vi bảo vệ trước ghi; giữ semantics affected/matched rows hiện có. Chưa hỗ trợ thì blocked rõ.
- Test nhận: sửa dòng sau diff rồi DELETE phải conflict; case/accent/trailing spaces, JSON/binary, trigger, InnoDB/MyISAM/mixed engine; không xóa dòng mới sửa và không báo rollback giả.

### R07 — P1: Main báo sync thất bại sau COMMIT; mất ACK COMMIT bị báo chắc chắn quá mức

- Vị trí: `electron/main.cjs:2347`, `electron/data-sync-executor.cjs:201`, `:211`, `:228`.
- Callback gọi `sendToRenderer` nhưng không có hàm này trong Main. Callback chạy sau COMMIT, throw rồi vào nhánh ROLLBACK; transaction đã commit không được hoàn tác. Handler hiện trả lỗi `sendToRenderer is not defined` dù DML và COMMIT đã phát. Selective restore dùng cùng callback sai nhưng nuốt lỗi progress.
- Tái hiện Main ở R01 ghi nhận thứ tự `START TRANSACTION → DELETE → COMMIT → ROLLBACK`, response `ok:false`.
- Tái hiện khác: worker throw `ECONNRESET` tại COMMIT đầu tiên; executor trả `committedCount:0`, `partialCommit:false`, không có `executionUncertain`. Server có thể đã commit trước khi mất ACK, nên không thể khẳng định trạng thái đó.
- Cần sửa: observer/progress không làm thay đổi kết quả transaction; dùng API progress thật. Phân biệt đã commit, chưa gửi, đã gửi nhưng không biết kết quả, cleanup lỗi và hủy; không retry lô có kết quả mơ hồ. Giữ ledger/uncertainty qua IPC projection.
- Test nhận: callback throw/reject/hang sau commit; disconnect trước/khi/sau COMMIT; batch đầu/cuối; kết quả và UI không được hứa rollback hoặc retry an toàn khi chưa có proof.

### R08 — P1: Cancel/context/logout của các tác vụ mới chưa nối worker thật

- Vị trí: `electron/main.cjs:80`, `:274`, `:502`, `:2295`, `:2335`; `electron/data-sync-executor.cjs:52`; `electron/data-diff-service.cjs:462`.
- Transfer mới không tạo controller/session nhưng truyền `transfer.cancelController?.signal`. Cơ chế cũ dùng `controller` và `transfer.session`; cancel có thể tìm phiên Editor theo profile thay vì worker riêng. `pending:true` khiến có thể báo hủy dù worker không nhận signal.
- Sync có hook fingerprint nhưng không sử dụng; profile/policy chỉ đọc một lần, không bind session/generation và không recheck sau await trước write. Restore cũng không có lease/context guard xuyên suốt. `stopBackupSchedules()` không clear restorePlanService và không hủy các transfer mới này.
- Data Diff clear chờ mọi job rồi mới xóa toàn Map; không deadline/guard cho connect/query treo, không generation fence khi kết quả trả muộn. Job mới được tạo trong lúc clear chờ cũng có nguy cơ bị clear xóa.
- Cần sửa: dùng hợp đồng worker/job/lease/generation đã có, một controller đúng tên, cancel đúng worker, deadline connect/USE/query/close; invalidation đồng bộ trước cleanup, tách tập job cũ khỏi job mới. Transfer scope phải lấy từ plan Main.
- Test nhận: Main thật + registry thật + driver giả; logout/reset/profile credential/policy change tại mỗi await, Editor transaction đang mở, cancel lúc connect/query/cleanup treo, response muộn không hồi sinh trạng thái hoặc ghi tiếp.

### R09 — P1: UI migration vẫn chạy db.query cũ, vượt đường Apply được khóa

- Vị trí: `app.js:3624`, `:3720`, `:3731`, `:3735`; `electron/main.cjs:1375`.
- `app.js` không có thay đổi trong diff Gemini. Nút Apply của Schema Diff vẫn bật cho đích writable, phát `SET FOREIGN_KEY_CHECKS = 0`, loop `desktop.db.query({sql:stmt.sql,confirmed:true})`, rồi bật lại FK khi thành công. Nếu statement giữa chừng lỗi, không có finally khôi phục FK. Luồng này chưa dùng orchestrator/source proof/plan token.
- Khóa `db:apply-migration-plan` bằng `MIGRATION_APPLY_NOT_READY` vẫn tồn tại nhưng không khóa được luồng UI cũ nói trên. Bảng bàn giao khẳng định đã xóa loop và SET FK là không đúng code.
- Cần sửa: vô hiệu đường Apply UI cũ trong lúc review; sau đó nối API Main duy nhất với preview, production receipt, job/progress/cancel và kết quả partial. Không mở Apply trước khi generator và matrix được nghiệm thu. Không mặc định tắt FK.
- Test nhận: renderer tương tác nút Apply phải gọi named API; không phát DDL/SET qua `db.query`; test drift, reject approval, partial DDL, keyboard và đổi đích lúc await.

### R10 — P1: Generator đánh dấu ready nhưng làm mất loại FULLTEXT của index

- Vị trí: `electron/schema-migration-generator.cjs:28`, `:63`, `:274`.
- Inspector không từ chối index type không hỗ trợ; `formatAddIndexSql` chỉ phân biệt PRIMARY/UNIQUE/KEY. Không có nhánh FULLTEXT/SPATIAL hoặc block loại này.
- Tái hiện: source có `FULLTEXT ft_body(body)`, target chưa có; generator trả `status:'ready'` với `ALTER TABLE users ADD KEY ft_body(body);`. Đây là khác định nghĩa; trên cột TEXT còn có thể lỗi vì thiếu prefix. Postcondition hiện chỉ đếm sự tồn tại tên, không xác minh định nghĩa vừa tạo.
- Cần sửa: allowlist đầy đủ theo metadata thật, giữ loại/options hoặc blocked; postcondition đối chiếu fingerprint/định nghĩa mong đợi. Thử cả CREATE_TABLE và ADD_INDEX, default/collation/charset/column order, không chỉ kiểm tên tồn tại.
- Giới hạn: generator mới chưa được nối vào public Apply; lỗi này chặn nghiệm thu E3 trước khi mở ghi.

### R11 — P1: Data Diff nhầm hết quota thành hết bảng; thứ tự merge chưa gắn collation

- Vị trí: `electron/data-diff-reader.cjs:108`, `:245`, `:335`; `electron/data-diff-service.cjs:216`, `:351`.
- Reader đặt `hasMore:false` khi chạm `maxRows`; báo cáo không phân biệt exhaustion với quota. Service gửi `rowLimit` vào reader nhưng constructor chỉ đọc `maxRows`; người gọi có thể đặt rowLimit cao hơn cap 2.000 của reader rồi nhận `coverage.complete:true` sau khi chỉ đọc 2.000 dòng.
- Tái hiện thu nhỏ: reader quota 1 dòng, comparer rowLimit 10, fake driver vẫn có thể trả tiếp; báo cáo đánh dấu `complete:true` sau 1 dòng mỗi phía.
- String PK được SQL ORDER BY theo collation DB, nhưng merge comparator dùng thứ tự chuỗi JavaScript. Chưa có proof hai thứ tự tương đương, thiếu test DB thật cho case/accent/Unicode; không đủ cơ sở nghiệm thu canonical/collation.
- Cần sửa: exhaustion/quota/truncated là trạng thái riêng, row/byte budgets do Main kiểm soát và thống nhất giữa reader/service. Comparator/keyset phải cùng ordering semantics hoặc từ chối key/collation chưa hỗ trợ. Không suy complete hoặc dòng vắng mặt toàn bảng từ bounded scan.
- Test nhận: quota-1/quota/quota+1, hai phía độ dài lệch, rowLimit cao/NaN/Infinity, nhiều chunk, numeric precision, string collations và schema/snapshot drift trên engine thật.

### R12 — P2: Production approval của restore/sync gọi sai hợp đồng

- Vị trí: `electron/main.cjs:130`, `:150`; `electron/schema-migration-admission.cjs:387`.
- Adapter gọi `authorizeProduction({plan,approvalToken})` nhưng verifier cần `planDigest` hợp lệ gắn receipt; chưa có issuer/dialog cho các loại plan restore/sync. Chỉ truyền token không thể tạo approval hợp lệ.
- Đây là đường bị chặn, không phải đã bypass production approval. Nhưng không thể nghiệm thu tính năng Production theo các test module staging/local hiện có.
- Cần sửa: thiết kế receipt riêng hoặc hợp đồng dùng chung có discriminator loại tác vụ, digest đầy đủ, fingerprint/generation/TTL/one-use và native dialog mặc định Hủy. Không sửa bằng cách bỏ kiểm tra digest.
- Test nhận: Production đầy đủ qua Main, accept/cancel/expiry/replay/plan drift/credential drift và receipt nhầm loại tác vụ.

## 2. Bằng chứng thực thi

Chạy lại trên working tree trong lượt review:

| Kiểm tra | Kết quả | Phạm vi |
| --- | --- | --- |
| `npm run check` | 1.163 tests: **1.149 pass, 0 fail, 14 skip** | Syntax, website generated check và Node tests hiện có |
| `npm run test:renderer` | **100/100** | Electron smoke hiện có; chưa cover UI của các API mới |
| `npm run test:website` | **14/14** | Website smoke hiện có |
| `npm --prefix server run check` | Đạt | Syntax server |
| `npm run server:test` | **17/17** | Server fixtures/localhost |
| `git diff --check` | Đạt | Whitespace tracked diff |

Electron/localhost bị hạn chế trong sandbox lần đầu; chạy lại ngoài sandbox đã đạt. Không tính lỗi môi trường lần đầu là bug sản phẩm. Không chạy DB người dùng, MySQL/MariaDB thật, DB integration opt-in hoặc bộ cài Windows/Ubuntu trong lượt này. **14 skip không phải 14 test đã đạt**.

Tái hiện lỗi lưu tại [script offline](review/gemini-2026-11-18/reproduce.cjs) và [kết quả quan sát](review/gemini-2026-11-18/observed.json). Chạy từ repo:

```bash
node review/gemini-2026-11-18/reproduce.cjs
```

Script dùng fake driver, module thật và fixture VM Main hiện có; chỉ tạo/xóa tệp trong thư mục tạm riêng. Nó in hành vi đang quan sát, **không phải một suite chứng nhận an toàn**; exit 0 không có nghĩa lỗi đã được sửa. Sau sửa phải chuyển các tình huống này thành regression assertions trong test chính. Script phụ thuộc cấu trúc helper test của snapshot review, cần cập nhật nếu helper được đổi.

## 3. Đối chiếu 8 nhóm trong bảng Gemini

82 tests của 8 nhóm dưới đây đều pass khi chạy lại riêng. Chúng đã nằm trong tổng `npm run check`, không cộng vào tổng lần nữa.

| Nhóm được báo hoàn tất | Test chạy lại | Trạng thái thực sau review |
| --- | --- | --- |
| B02-E2.1 | 18/18: orchestrator 10 + Main VM 8 | Có facade và kiểm chứng offline/Main VM; giữ kết quả này theo phạm vi. Chưa phải nghiệm thu migration DB thật hoặc public Apply. |
| B02-E3/UI | 20/20: generator 14 + matrix 6 | Generator có lỗi R10. Matrix dùng `FakeMatrixWorker`, không kết nối MySQL/MariaDB thật. UI chưa nối, loop cũ còn nguyên (R09); Apply IPC mới vẫn khóa. |
| B03 | 10/10 | Có planner/executor/IPC, chưa nghiệm thu vì R02/R03/R08/R12. `main-selective-restore.test.cjs` chỉ ghép service/executor với fake worker, không nạp Main handlers. |
| B04/B05 | 16/16 | Có keyset/canonical helpers/service, vẫn bounded observation. R11 chưa xử lý; chưa nối UI và thiếu DB collation/type matrix. `main-data-diff.test.cjs` không nạp Main. |
| B06–B09 | 10/10 | Có sync module và single-table IPC nhưng R01/R06/R07/R08/R12 chặn nghiệm thu. Multi-table chỉ có module; Main chỉ gọi `createSyncPlan`, chưa có IPC/UI cho multitable. Plan chưa deep freeze, digest bỏ `op.table`, tables metadata và dependency orders; đổi op.table không đổi digest trong probe. |
| B10–B12 | 3/3 | Crypto/replica helper và IPC có, còn R04/R05. Catalog chỉ chấp nhận ID `.sql`, encrypt tạo `.sql.enc` nhưng decrypt IPC lại resolve ID `.sql`; encrypted output chưa vào catalog/restore/retention. Cron calculator chưa được scheduler/UI gọi; scheduler vẫn dùng intervalHours. Test không có DST transition. |
| B13–B15 | 3/3 | Chỉ thêm parser microbench CSV 50.000 dòng, JSON 30.000 objects và fake keyset 2.000 dòng. Không chứng minh B13 metadata/filter hoặc B14 editor/EXPLAIN/diagnostics. Đo heap trước/sau không phải peak RSS/heap; test keyset cấu hình maxBytes **5 MiB**, chưa có case vượt byte budget. |
| B16–B18 | 2/2 | Recovery key wrap/unwrap helper có test round-trip. Chưa nối account/vault/server/UI/new-device recovery; chưa có refactor/UX nghiệm thu B16 hoặc security/CI/installed/upgrade/release evidence đầy đủ của B18. `node --check` chỉ kiểm cú pháp. |

`sanitizeDiffError` còn trả nguyên `err.message` dù allowlist code; cần bổ sung privacy contract/test trước khi xuất lỗi driver qua IPC. Việc có tên file `main-*`, `integration`, `matrix`, `benchmark` không tự chứng minh loại nghiệm thu tương ứng.

## 4. Thống kê tồn đọng theo roadmap thật

Đếm trực tiếp `DATABASE_PRODUCT_ROADMAP.md`: **51 hạng mục, 29 chưa tick, 22 đã tick**. Đây là trạng thái checkbox, không phải 22 chức năng đã được chứng nhận hoàn tất. Không giảm backlog chỉ dựa bảng Gemini hoặc tên test.

| Nhóm | Chưa tick / tổng | Việc còn cần hoàn thành/kiểm chứng |
| --- | --- | --- |
| G0 | 5/5 | Baseline theo commit, DB fixture/permissions/engine matrix, hợp đồng lifecycle và benchmark môi trường thật |
| G1 | 0/5 | Giữ nền policy/transaction; áp dụng đầy đủ vào các IPC mới ở R01/R06/R08/R12 |
| G2 | 0/5 | Giữ catalog/trial/manifest; kiểm hồi quy khi thêm crypto/replica/selective restore |
| G3 | 2/6 | G3.5 crypto và G3.6 replica chưa nghiệm thu; G3.1/G3.2 selective restore và G3.3 scheduler đã tick vẫn cần kiểm lại scope đầy đủ |
| G4 | 5/5 | Metadata/filter performance, render/backpressure, số đo và fault/load matrix |
| G5 | 3/6 | Hoàn thiện/kiểm chứng autocomplete, EXPLAIN và filter/dialect/capability; không được coi B13/B14 xong bởi parser benchmark |
| G6 | 0/4 | Checkbox hiện có nhưng Apply an toàn/UI/DDL fidelity chưa đạt; tối thiểu mở lại phạm vi nghiệm thu G6.3/G6.4 |
| G7 | 5/5 | Keyset/canonical/snapshot proof, Main-owned sync, concurrency/partial outcome và multi-table integration |
| G8 | 4/5 | Tách module, keyboard/focus/dark/small-window UX, thử 5 người, tài liệu/screenshot đúng code |
| G9 | 5/5 | Recovery/compatibility/tombstones/logout, security, DB CI, installed/upgrade, release/runbook |

Đối chiếu tên gói ban đầu trong `GEMINI_IMPLEMENTATION_HANDOFF.md`: **B13 là metadata/filter; B14 là SQL Editor/EXPLAIN/diagnostics; B15 mới là benchmark. B16 là refactor/UX; B17 là recovery/sync compatibility; B18 là security/CI/release.** Bảng Gemini đang gộp sai phạm vi này. Không có cơ sở tính phần trăm hoàn thành hoặc thời gian “xong hết” từ số test pass hiện tại.

## 5. Thứ tự bàn giao lại cho Gemini

Mỗi đợt chỉ một gói sửa, kèm diff và regression evidence; review xong mới mở capability kế tiếp.

1. **Đợt sửa an toàn tức thời:** fail-closed các đường ghi mới chưa đủ proof (R01/R02) và Apply UI cũ (R09); bảo vệ source/destination file (R04/R05). Thêm Main VM tests và file preservation tests trước khi mở lại. Không thay quyền/global server để làm test xanh.
2. **Chốt B02-E2.1/E3:** giữ private orchestration, kiểm lifecycle/cleanup; sửa fidelity R10, pre/post expected schema, nối generator tới Main snapshot cache/admission. Sau engine matrix MySQL/MariaDB thật mới nối UI Apply có production receipt, progress/cancel/partial outcome.
3. **Chốt B03:** reuse preflight/context helpers, immutable file proof (R02/R03), authorized steps/dependency order, target drift, worker guard/lease/generation (R08), production receipt (R12). Nối preview/UI và test DB thật phạm vi selected objects.
4. **B04–B06 chỉ đọc:** sửa quota/order R11, canonical types/charset/timezone/collation, xác minh isolation level thay vì chỉ đánh dấu transaction=true, source/target capture identity và consistency limits. Nối Data Diff UI chỉ đọc, test drift/schema/type/engine/permission matrix.
5. **B07–B09 ghi có điều kiện:** sau bước 4, Main-owned report ID → cloned/frozen full-digest plan → approved worker; sửa R01/R06/R07/R08/R12. Single-table ổn mới multi-table: Main lấy FK thật, exact-case identifiers, cycles/missing dependencies, order và table-bound digest, IPC/UI/evidence. Không lấy relations từ renderer làm bằng chứng.
6. **B10–B12 vận hành backup:** sửa atomic encryption/decryption/replica, catalog/manifest dual hashes, retention/file leases, restore/trial giải mã an toàn; scheduler repository/UI/crash/restart/missed-run/DST tests. Thư mục/ổ khác là phạm vi replica đầu tiên; remote adapter làm khi được đưa vào scope.
7. **B13 và B14 đúng phạm vi:** metadata cache/lazy/single-flight/invalidation, typed filters và EXPLAIN theo DB; autocomplete scope/dialect, privacy/retention history/snippets/tabs, diagnostics target/cancel/permissions. Giữ những hành vi đã có, bổ sung bằng chứng thiếu.
8. **B15:** benchmark end-to-end DB/file/network/UI, peak RSS/heap/event-loop/latency/temp disk, dataset và hardware cố định; fault/cancel/disk-full và so trước/sau. Không có hạ tầng 1/10/20 GB thì ghi rõ chưa kiểm chứng.
9. **B16 và B17:** refactor theo contract, UX/user trials/tài liệu; recovery kit gắn vault thật, lưu/khôi phục kitData an toàn, new device/password change/account deletion/conflicts/old-client/tombstone/logout tests. Chỉ emergency sheet có recovery key chưa đủ luồng recovery.
10. **B18 chốt phát hành:** review sender/frame/origin/payload/path/quota/secrets/dependencies và sidecars; DB CI; installed/ASAR Windows/Ubuntu, upgrade giữ profiles/backups, artifact/version/checksum và runbook. Chỉ gắn trạng thái release-ready khi bằng chứng này tồn tại.

Các phát hiện runtime trong tài liệu này **chưa được sửa trong lượt review**. Không đánh dấu “đã fix” hoặc “đạt nghiệm thu” trước khi có diff và test tương ứng. Tiến độ Gemini trước review được giữ làm lịch sử, báo cáo này là mốc đối chiếu mới.
