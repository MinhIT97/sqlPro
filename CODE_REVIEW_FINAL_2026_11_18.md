# Review, sửa lỗi và chốt commit — 18/11/2026


## Gói ưu tiên bảo vệ dữ liệu — 20/11/2026

Tiếp nối R20, đã triển khai ba phần có thể dùng trong ứng dụng. Phạm vi nghiệm thu dưới đây thay các mô tả “UI chưa nối Main”, “chưa có catalog crypto” và “chỉ có interval” ở mốc cũ. **Chưa hoàn thành toàn bộ roadmap; Migration/Data Sync Apply vẫn khóa.** Chưa commit hoặc phát hành.

| Phần | Đã triển khai | Ranh giới còn giữ |
| --- | --- | --- |
| Data Diff UI → Main | `data-diff-job.js` điều phối named start/status/cancel; Main dùng keyset và phiên riêng. Đổi cấu hình/đóng dialog hủy, bỏ kết quả muộn; timeout, tối đa 16 job lưu/4 MiB report và TTL. Schema giữ nguyên chữ hoa/thường trong ENUM literal. Error không lộ driver SQL. | 200–2.000 dòng/phía; PK số exact. InnoDB có snapshot **riêng mỗi phía**, không phải snapshot chung cùng thời điểm giữa hai server. Text/temporal/unique-key chưa có proof bị chặn. `canSynchronize=false`, không sinh quyền ghi từ report. |
| Backup mã hóa → SQL mới → phục hồi | Toolbar **Mã hóa bản sao…**, **Bản mã hóa / Giải mã…**; catalog `.sql.enc` riêng; V2 AES-GCM có AAD, đọc tương thích V1. Sai khóa/tamper/quá quota/hủy/context hoặc tệp nguồn đổi không công bố SQL. Tệp mới `wx`/0600/fsync/hard-link độc quyền, giữ SQL gốc; giải mã trả ID SQL mới. Main giữ transfer slot, timeout 10 phút; tối đa 10 GiB plaintext. | Không tự khôi phục DB sau giải mã. SQL mới chưa có manifest và trạng thái restore vẫn `not-tested`; cần xác minh và phục hồi thử. Archive không nằm trong tự dọn SQL. Chưa quản lý/xuất/xóa archive, encrypted manifest/metadata roundtrip hoặc recovery tài khoản hoàn chỉnh. Gzip/crypto không thay phục hồi thử. |
| Lịch hằng ngày theo múi giờ | UI chọn chu kỳ hoặc HH:mm + múi giờ IANA; Main tự tính kỳ tới, không tin giờ renderer. Store đọc interval v1, ghi v2 khi có daily, giữ target/history. Claim và kỳ tới lưu trước khi chạy. Test DST gap/fold, restart/bỏ lỡ, native Cancel và bàn phím. | Chỉ khi app mở; giờ DST thiếu bỏ qua, giờ lặp có thể chạy cả hai lần. Quá 60 giây ghi nhận bỏ lỡ, không chạy bù/retry. Chưa cron tùy ý, scheduler OS/app đóng hoặc remote replica. |

### Kiểm chứng gói ưu tiên

- `npm run check`: **1.328 tổng, 1.302 pass, 0 fail, 26 DB opt-in skip**. Các DB opt-in được chạy riêng ở matrix bên dưới; không cộng các số thành tổng test duy nhất.
- Electron **113/113**, website **14/14**, server **17/17** và server syntax đạt. Native kiểm hủy/lưu/mở lại daily, timezone sai, cửa sổ nhỏ, Data Diff cancel và mã hóa thật → sai/đúng mật khẩu → SQL ID mới. Không gọi restore DB tự động từ UI.
- `npm run test:data-safety`: **328/328, 0 fail, 0 skip**: MySQL **153**, MariaDB **120**, regression schema/sync + encrypted restore trên cả hai engine **49**, packet 32 KiB **6**. MySQL **8.4.13**, MariaDB **11.4.13-MariaDB-ubu2404**. Encrypted roundtrip kiểm BIGINT chính xác, Unicode, SQL gốc và marker ở bảng ngoài phạm vi giữ nguyên.
- `npm run pack:dir -- --linux --config.directories.output=/tmp/sqlpro-priority-package`: đạt; 12 file ASAR mới/sửa khớp byte với nguồn; không thay nghiệm thu bộ cài/upgrade Windows/Ubuntu.
- Evidence cuối và nhật ký các lần fixture sai ở [priority](review/gemini-2026-11-20/priority/). Các database dùng container riêng/tmpfs/loopback của phiên kiểm tra, không dùng dữ liệu người dùng; đã dọn cả ba container và anonymous volumes.

Lần kiểm tra đầu có lỗi fixture: truyền nhầm index capability của từng engine, truyền SSL profile app trực tiếp vào mysql2 test, và DOM fake chưa có các input daily. Đã sửa fixture theo hợp đồng thật, giữ assertion và chạy lại. Không che các lần lỗi bằng cách tính root suite là số test con hoặc bỏ kiểm tra.

### Phần ưu tiên còn chưa hoàn thành

1. **Migration Apply / Data Sync Apply:** vẫn `MIGRATION_APPLY_NOT_READY` / `SYNC_APPLY_NOT_READY`. Cần proof dependency/trigger/engine/quyền đầy đủ, native approval gắn immutable Main plan, drift trước ghi/commit, DDL implicit commit/mất ACK và concurrency matrix. Không mở nút Apply chỉ vì unit/DB hiện có xanh; `agent.md` yêu cầu giữ khóa.
2. **Selective restore/dialect mở rộng:** các cấu trúc chưa chứng minh (executable comments, charset/SQL mode, dependency động, MariaDB JSON) tiếp tục bị chặn; cần roundtrip và marker ngoài lựa chọn trước khi mở từng capability.
3. **Backup hoàn chỉnh:** encrypted manifest/metadata và trial integration, quản lý archive, remote replica/credential/network/crash matrix, recovery UI và quy trình mất khóa/đổi thiết bị. Bản plaintext gốc vẫn được giữ sau mã hóa; nếu cần loại bỏ phải có thiết kế/quyền xóa riêng.
4. **Vận hành/release:** lịch khi app đóng, arbitrary cron/backoff, disk-full/power-loss/OS khác, tải 1/10/20 GB với RSS/UI p95 và SSH/TLS, installer/upgrade/security/UAT. Các ca pass hiện tại không chứng nhận các phần này.

Checklist `DATABASE_PRODUCT_ROADMAP.md` vẫn **29/51 mục chưa tick**: các gói trên hoàn thiện một phần nghiệm thu, chưa đủ điều kiện tự tick những mục lớn. Bảng bên dưới mô tả phạm vi còn lại, các mốc 18–19/11 là lịch sử.

---

## Rà soát và sửa lỗi ngày 20/11/2026

Baseline của lượt này: `3b5fab5` (sau `9504570` và bản sửa Windows `9cc28d1`); working tree ban đầu sạch. Các phần ngày 18–19/11 phía dưới giữ làm lịch sử. Lượt này không commit, push, phát hành hoặc chạy trên database người dùng.

### Các lỗi đã sửa

| Mã | Lỗi xác nhận | Bản sửa và bằng chứng |
| --- | --- | --- |
| R20-01 — P1 | Đóng các tab khác/bên phải đổi `app.query` nhưng giữ editor/kết quả cũ; `persistState` chép SQL cũ sang tab mới. Tab đang chạy bị chọn sai khi index dịch chuyển. | Đồng bộ tab cũ trước khi lọc; chọn tab bằng object identity, dựng lại editor/kết quả khi chuyển đích, giữ tab đang chạy và xóa observation của tab đã đóng. Unit và Electron kiểm SQL, database, tab identity/index và tab chạy kế bên. |
| R20-02 — P1 | `desktop.js` có serializer khi unload riêng, bỏ profile/database từng tab, savedQueries, snippets và masking. Restart suy đích thiếu/null từ sidebar, có thể gắn bản nháp sang DB khác. Title chứa số lớn còn chi phối bộ đếm ID. | Dùng chung `captureRendererState` cho autosave/unload; target thiếu/null giữ unbound, cần gắn lại tường minh. ID khôi phục theo số tab, không theo title; giữ nguyên tên đã lưu. Native kiểm payload unload đầy đủ; unit kiểm target thiếu/null/sai kiểu. |
| R20-03 — P1/P2 | Save modal giữ SQL tab A nhưng đọc đích/tab hiện hành B khi bấm lưu. Mở saved query ở giới hạn 50 tab vẫn đổi tên và savedQueryId của tab đang mở dù không tạo được tab. | Chụp query object/SQL/target, kiểm tab còn tồn tại và đích không đổi; nối saved identity trong `newQuery` sau admission. Lỗi/quota không sửa tab hiện tại. Unit kiểm cả đổi tab lúc lưu và giới hạn tab; native kiểm giới hạn và đổi tên bằng Enter. |
| R20-04 — P1 | File watcher tự reload renderer sau 250 ms, kể cả đang nhập form/chạy SQL. Menu reload không có guard. | Watcher chỉ phát thông báo qua command được preload allowlist. Reload thủ công cần native confirm mặc định Hủy; chặn transfer, transaction/autocommit OFF, active task, lease và opening; kiểm lại window/context sau dialog. Không tự hủy tác vụ hoặc commit/rollback. Unit kiểm trước/trong confirm; native kiểm thông báo không thay editor. |
| R20-05 — P1 | Diagnostics đọc và KILL qua `activeQueryTarget()` sau await; đổi kết nối lúc confirm gửi KILL đến máy chủ khác. | Chụp profile/database, dùng cùng đích cho mọi read/KILL/KILL blocker; guard modal revision/open/context trước và sau await. Kết quả cũ không vẽ lên dialog mới, polling cũ được dọn, audit ghi đúng đích. B01.9 chuyển từ test xác nhận bug thành regression; Electron kiểm KILL QUERY/KILL khi đổi profile hoặc thay dialog. |
| R20-06 — P1 | SQL của draft/history/saved query/snippet nằm dạng rõ trong renderer-state và cache sessionStorage. | Main dùng `renderer-state.cjs`: envelope v1, toàn trạng thái qua `store.seal/unseal` hiện có; không sửa SQL hoặc dùng regex để biến mật khẩu thành câu SQL khác. Cache SQL trình duyệt được thay bằng RAM và xóa key cũ. Tệp plaintext cũ đọc được, chuyển sang mã hóa ở lần lưu thành công; packaging `electron/**/*` đã gồm module. Unit dùng crypto thật và Main IPC kiểm marker không có trên đĩa, exact round-trip và mode 0600 trên Unix. |
| R20-07 — P1/P2 | Tệp trạng thái lỗi đọc/JSON bị coi như rỗng rồi ghi đè; lỗi lưu bị nuốt, nút Save báo thành công trước khi có xác nhận lưu. | Read/decrypt/version/quota lỗi phải dừng save và giữ tệp cũ. Temp độc quyền, fsync, rename; lỗi write/fsync/rename dọn đúng temp của lần này. Thiếu khóa khi chỉ còn encrypted state cũng không được sinh khóa thay thế. Save chờ Main ACK, lỗi giữ form và bản nháp; retry không nhân đôi entry, ACK cũ không đóng dialog mới. |

Tệp chính: `app.js`, `desktop.js`, `electron/main.cjs`, `electron/preload.cjs`, `electron/renderer-state.cjs`, `electron/store.cjs`. Không thay `.env.example` vì các biến trong tệp vẫn khớp cấu hình Docker/server đang dùng.

### Kiểm chứng của lượt 20/11

- Sáu regression tab ban đầu và ba regression reload **đều fail trên baseline**, đạt sau sửa; không tính các test bổ sung sau đó là đã chạy trên baseline.
- Ba suite mới: `review-nov20-tabs.test.cjs` **9/9**, `review-nov20-reload.test.cjs` **3/3**, `renderer-state.test.cjs` **7/7**. Gồm crypto thật, legacy migration, corruption/future version, mất khóa, disk full/write/fsync/rename, Main IPC và late ACK.
- `npm run check`: **1.306 tổng / 1.282 pass / 0 fail / 24 opt-in skip**. Lần chạy trong sandbox chỉ hiện 175 tên file; không dùng con số đó để nghiệm thu. Số trên lấy từ lượt ngoài sandbox thực thi từng test.
- Electron/preload thật với IPC fixture: **110/110 pass**, gồm 5 regression mới, keyboard Enter, target/draft/unload/KILL và các ca layout nhỏ hiện có.
- Website **14/14**, server **17/17**, server syntax và `git diff --check` đạt.
- [Evidence 20/11](review/gemini-2026-11-20/): baseline tab/reload, unit, check, renderer, website, server. Không chạy lại DB opt-in hai engine ở lượt này; số DB ngày 19/11 phía dưới không phải số mới. Không tiếp xúc dữ liệu thật.

Mã hóa state dùng cùng OS keychain hoặc fallback AES-256-GCM/khóa local hiện có của app. Cần giữ `.connections-key` và quyền truy cập keychain; đây không phải recovery kit hoặc cơ chế chống người đã kiểm soát tài khoản máy. Không hứa xóa an toàn các bản plaintext/backup cũ, không chứng nhận toàn bộ clipboard/export/log/OS crash dump đã bảo vệ. Trạng thái không lưu được có thông báo; việc đảm bảo ACK cuối khi hệ điều hành tắt cưỡng bức còn thuộc fault/release matrix. Native dialog reload ở lượt này kiểm bằng Main VM, chưa kiểm bộ cài Windows.

### Việc chưa hoàn thành — danh sách hiện hành

Đếm lại `DATABASE_PRODUCT_ROADMAP.md`: **51 checkbox, 22 đã tick, 29 chưa tick**. Không suy phần trăm hoàn thành từ số này. Đặc biệt **G6.4 đã tick lịch sử nhưng Migration Apply vẫn khóa**; **G3.3 đã tick nhưng cron tùy ý/OS scheduler chưa nghiệm thu**. Các dòng “đã hoàn thành” cũ không thay nghiệm thu.

| Ưu tiên / gói | Phần còn làm | Bước tiếp theo và điều kiện nhận |
| --- | --- | --- |
| P1 — B02 / G6 | Migration Apply và fidelity schema đầy đủ | Giữ `MIGRATION_APPLY_NOT_READY`; export hiện chỉ CREATE_TABLE/append ADD_COLUMN/ADD_INDEX trong allowlist. Mở rộng từng dialect DEFAULT/CHECK/FK/generated/routine/view/rename có round-trip; nối admission/approval/executor với snapshot và drift; kiểm DDL implicit commit/lock/mất ACK/cancel trước khi mở Apply. |
| P1 — B03 / G3.1–G3.2 | Selective restore end-to-end và grammar còn bị chặn | Nối UI/plan/Main executor đúng luồng được nghiệm thu; bổ sung SQL-mode/charset/executable comments/dynamic dependencies và MariaDB JSON theo capability. Unknown phải chặn trước ghi; fixture marker ngoài selection, cleanup và kết quả phần đã ghi là điều kiện bắt buộc. |
| P1 — B04–B06 / G7.1–G7.2/G7.4 | Data Diff completeness/key mapping/canonical coverage | UI đã dùng start/status/cancel Main keyset, progress/quota/expiry; mở rộng PK/unique-key/text/temporal chỉ khi có order/collation proof; phân biệt snapshot riêng hai server với snapshot chung. |
| P1 — B07–B09 / G7.3/G7.5 | Data Sync an toàn từ preview tới Apply và nhiều bảng | Giữ `SYNC_APPLY_NOT_READY`, `canSynchronize=false`. Main-owned authorization/dependency closure/approval/original guard; timeout/network/cancel/uncertain commit/partial commit matrix. Mọi inbound FK hiện bị chặn; role-only/thiếu visibility không được suy đủ metadata. |
| P2 — B10 / G3.5 | Container nén/mã hóa còn thiếu manifest/trial/recovery | Đã có catalog archive riêng và giải mã thành SQL ID mới; chưa chuyển manifest/annotations. Hoàn thiện checksum/trial/export, quản lý archive, khóa/recovery và migration format; kiểm corruption/tag/quota/disk full/cancel, không overwrite. Backup crypto UI không thay quy trình phục hồi tài khoản/mất khóa. |
| P2 — B11 / G3.6 | Replica ngoài máy | Bản sao local theo cặp đã có. Cần remote adapter/credential flow, cancel, disk full/network/OS/crash và pair recovery; copy/checksum không là proof phục hồi được. |
| P2 — B12 / G3.3 | Cron tùy ý và chạy khi app đóng | Daily HH:mm/timezone đã nối store/claim/runtime/UI, giữ interval 1–168. Còn cron tùy ý, backoff, fault/sleep-wake matrix; OS scheduler và secret availability là bước riêng. |
| P2 — B13–B14 / G4.1–G4.2/G5.2–G5.4 | Metadata/filter/SQL Editor, EXPLAIN và diagnostics đầy đủ | Giữ các phần đã có. Hoàn thiện scope/correlation/star/dialect autocomplete, capability/quyền/session identity diagnostics và EXPLAIN context, type/operator/collation/timezone matrix; đo cache/reads/query plans. Privacy còn opt-in/retention toàn ứng dụng và các nơi xuất/lưu ngoài renderer-state. |
| P2 — B00/B15 / G0.1–G0.5/G4.3–G4.5 | Baseline, performance và fault/load | Chốt DB/OS support matrix/CI/fixtures và hợp đồng; đo 1/10/20 GB trên phần cứng cố định, RSS/heap/event-loop/UI p95/SSH/TLS/stream/backpressure và trước-sau. Benchmark vài chục nghìn dòng chưa thay nghiệm thu tải thật. |
| P2 — B16 / G8.2–G8.5 | Tách module và UX | Tách backup/editor/grid/IPC theo contract tests, tránh refactor hàng loạt. Nghiệm thu focus/keyboard/theme/window nhỏ, ít nhất 5 người dùng, tài liệu/screenshot theo bản phát hành. |
| P2 — B17 / G9.1–G9.2 | Recovery và tương thích sync | Recovery helper chưa là quy trình thiết bị/tài khoản hoàn chỉnh. Nối UI/Main, đổi mật khẩu/thiết bị, vault/profile/tombstone/conflict/late replies, migration máy cũ và phục hồi server SQLite; không hứa mở vault khi mất khóa. |
| P3 — B18 / G9.3–G9.5 | Security/installed/upgrade/release | Rà IPC/frame/payload/path/CSP/dependency/privacy, ma trận quyền và DB mục tiêu; bộ cài Windows/Ubuntu/upgrade/ASAR/signing/checksum/version, runbook mất mạng/disk full/mất khóa và user acceptance. Chưa phát hành hoặc tạo installer trong lượt này. |

Phân rã đúng 29 mục chưa tick: G0 **5**, G3 **2**, G4 **5**, G5 **3**, G7 **5**, G8 **4**, G9 **5**. G1/G2/G6 không có checkbox trống nhưng vẫn phải kiểm hồi quy và các giới hạn đã nêu.

Gói tiếp theo cần review riêng: encrypted manifest/trial/metadata và quản lý archive, rồi remote/recovery. Data Diff UI → Main đã hoàn thành phạm vi chỉ đọc hữu hạn nêu ở đầu báo cáo. Public Migration/Sync Apply tiếp tục khóa theo `agent.md`.

Không còn finding R20 mở trong các ca đã kiểm chứng. Các tính năng và ma trận chưa nghiệm thu ở trên vẫn tồn đọng; không kết luận toàn repository hết bug.

---

> **Mốc mới nhất 19/11:** [Đã sửa F01–F06 và giới hạn](CODE_REVIEW_FEATURES_2026_11_19_FIXES.md). Schema Diff UI đã dùng Main snapshot/plan; script giữ settings; Sync chặn inbound FK/metadata thiếu proof và đối chiếu lại quyền/context. Node **1.263 pass/0 fail/24 skip**, DB **43/43**, renderer **105/105**, website **14/14**, server **17/17**. Public Apply vẫn khóa; các dòng F01–F06 còn mở phía dưới giữ lịch sử trước sửa.

> **Review mới nhất 19/11:** [Rà tính năng và bugs tại 60cdb20](CODE_REVIEW_FEATURES_2026_11_19.md): còn **F01–F06 (5 P1/1 P2)** đã tái hiện, chưa sửa runtime. Schema Diff UI chưa dùng Main collector/service; public Apply khóa không bảo vệ toàn bộ SQL xuất/mở Editor. Các mốc sửa lỗi phía dưới giữ lịch sử; không tự tick roadmap.

> Review và bản sửa tiếp theo cho hai commit sau baseline: [N01–N07 đã xử lý](CODE_REVIEW_GEMINI_2026_11_19_FIXES.md), [bằng chứng review trước sửa](CODE_REVIEW_GEMINI_2026_11_19.md). Kết quả 18/11 bên dưới không bao phủ các thay đổi mới đó.

Đối chiếu working tree trên `7ede1a6`, package 0.3.12. Người dùng yêu cầu rà soát, sửa lỗi, báo cáo phần còn lại và commit. Commit này gom triển khai Gemini đang có, các bản sửa từ review R1–R5 và bản sửa bổ sung dưới đây. Không mở khóa public Migration/Data Sync Apply và không chứng nhận toàn bộ sản phẩm hết lỗi.

## 1. Các lỗi đã sửa và bằng chứng

| Nhóm | Vấn đề | Sửa và kiểm chứng |
| --- | --- | --- |
| Restore V01–V04 | SQL mode làm parser/server hiểu khác nhau, user variable/DEFAULT sai tracker, COMMIT mất ACK, late connect | Đã sửa theo [hồ sơ R5](CODE_REVIEW_GEMINI_2026_11_18_R5_FIXES.md), gồm preflight staging, policy context, typed assignment, commit ledger, guard timeout/cancel/close và generation/fingerprint. Regression 15/15, kiểm chứng lại trên MySQL 8.4.13 và MariaDB 11.4.13. |
| Autocomplete | Scroll/blur từ textarea cũ sau render làm đóng popup của textarea mới; blur timer cũ có thể đóng popup sau refocus | Bỏ sự kiện từ editor đã bị thay/không connected; timer phải còn đúng editor và chưa refocus. Notification scroll với viewport không đổi không đóng popup. Test trong renderer thực: dispatch scroll/blur từ editor cũ, refocus qua thời hạn blur, native keyboard/undo và cuộn thật. Handler cũ thất bại ở assertion sau scroll, bản sửa đạt. Không sửa grammar hoặc bỏ assertion. |
| Backup crypto — bảo toàn file | Mã hóa/giải mã thành công dùng rename có thể ghi đè file đích, gồm file xuất hiện sau khi bắt đầu | Publish bằng hard link độc quyền sau fsync, temp tạo `wx`. Đích tồn tại trả `BACKUP_DESTINATION_EXISTS`, giữ nguyên file. Test collision tại đúng lúc publish, mật khẩu sai, lỗi header và cleanup temp. Không fallback sang rename ghi đè. |
| Backup crypto — định dạng | Header chưa được xác thực; không kiểm version/cipher/compression; backup rỗng không nén lỗi | File mới ghi header version **2**, AAD bao phủ header. Chỉ đọc version 1/2, cipher/flag đã hỗ trợ; thiếu dữ liệu/unknown bị chặn. V1 vẫn đọc được, không đổi byte file cũ. Test tamper/version/cipher/truncation, legacy và empty round-trip có/không gzip. Magic `SQLPRO_ENC_V1` giữ để nhận diện họ container, version byte quyết định cách xác thực. Header V1 lịch sử không có AAD, không tuyên bố retrofit được bảo vệ V2. |
| Cron | `parseInt` nhận `1junk`, `*/2x` hoặc range thừa; DOM/DOW bị AND cả khi hai trường bị giới hạn | Parse toàn bộ token theo grammar giới hạn, kiểm khoảng/step, nhận Sunday 7, DOM/DOW dùng OR khi cả hai restricted. Validate Date và tái dùng formatter trong vòng tìm lịch. Unit kiểm malformed input, range/step, ngày, Sunday và DST lặp giờ. Đây vẫn là helper, chưa tích hợp scheduler calendar end-to-end. |
| Data Diff IPC/privacy | Trả function `generateSyncSql` trong report làm IPC structured clone thất bại; raw driver message có thể chứa SQL/giá trị | Status chỉ project dữ liệu clone được và tách khỏi cache; sync vẫn blocked. Error code allowlist + thông báo cố định, không trả driver message. Test clone/đổi projection không sửa report gốc, secret-marker không xuất hiện trong error. |
| Data Diff context/lifecycle | Connect/USE/read không bounded; reset chờ rồi mới xóa jobs; tác vụ/profile cũ có thể tiếp tục | Worker guard xuyên các phase, deadline toàn job, generation và fingerprint trước/sau await. Reset xóa jobs ngay, chặn job mới trong cleanup; late completion đóng lại. Chỉ công bố completed report sau close; lỗi close không trả success. Test hung connect/deadline/late completion/profile drift/cleanup lỗi. |
| Data Diff proof | Mặc định engine InnoDB khi không đọc được metadata; merge text PK bằng JS chưa có collation proof; snapshot theo isolation kế thừa | Engine thiếu bằng chứng là unknown; chỉ mở consistent snapshot cho InnoDB, yêu cầu REPEATABLE READ trước START. Keyset service chỉ nhận PK số exact; text/enum/temporal chưa có order proof bị chặn. MyISAM không được ghi consistent. Hai worker có snapshot riêng, không phải snapshot chung đồng thời giữa hai DB; `canSynchronize=false` luôn giữ. |
| Migration executor nội bộ | Driver code lạ có thể bị coi chắc chắn, không phân biệt lỗi trước gửi DDL; precondition await thiếu recheck; observer Promise treo giữ worker | Theo dõi `not_sent/in_flight/acknowledged`: lỗi không xác định khi DDL in-flight là uncertain, lỗi precondition chưa gửi DDL không bị báo đã ghi. Recheck context/approval sau precondition, observer không được giữ cleanup. Test unknown driver error, precondition drift, observer treo. Public Apply vẫn khóa. |

Bộ `test/review-final-safety.test.cjs` có **13 test**, cộng **2 regression migration** và **1 regression renderer**. Các test cũ chỉ được cập nhật fake session để phản ánh SET isolation và session facts mới; giữ assertion chunk count, selection, policy và ledger.

## 2. Kết quả kiểm tra cuối

| Kiểm tra | Kết quả |
| --- | --- |
| `npm run check` | **1.222 tổng: 1.206 pass, 0 fail, 16 opt-in skip**. Syntax + toàn bộ Node suite. |
| `npm run test:renderer` | **101/101 pass**, gồm regression editor cũ/scroll/refocus, layout nhỏ, keyboard và undo. |
| Test regression với handler autocomplete cũ trong bản app tạm | Thất bại tại assertion gợi ý sau sự kiện scroll của editor cũ, đúng kỳ vọng. |
| `npm run test:website` | **14/14 pass**. |
| `npm --prefix server run check` | Đạt. |
| `npm run server:test` | **17/17 pass**. |
| MySQL **8.4.13** — 16 suite, toàn matrix có các ca restore/Data Diff mới | **159/159 pass, 0 skip**. Packet suite dùng server riêng có `max_allowed_packet=32768`. |
| MariaDB **11.4.13** — 14 suite dùng chung, gồm restore/Data Diff mới | **120/120 pass, 0 skip**. Không đưa fixture MySQL-only và packet MySQL vào con số này. |
| Packet MySQL riêng chạy độc lập | **6/6 pass**, đã nằm trong 159 bên trên, không cộng trùng. |
| `git diff --check` | Đạt. |

Dùng ba container riêng: `sqlpro-review-mysql-20261118`, `sqlpro-review-mariadb-20261118`, `sqlpro-review-packet-20261118`; tmpfs cho datadir, port chỉ bind localhost. Test chỉ tạo/xóa DB riêng, marker/row counts kiểm tra dữ liệu ngoài lựa chọn không đổi. Không chạy DB người dùng. Dọn container và anonymous volumes sau khi hoàn tất.

**Lượt chạy đầu không che giấu:** packet suite thất bại do dùng server mặc định 64 MB thay vì fixture 32 KB; đã chạy lại đúng server, không đổi assertion. Chạy nhầm toàn bộ `mysql-integration.test.cjs` trên MariaDB có 4 subtest fail (CREATE/SHOW CREATE có thuộc tính khác, expression index cú pháp MySQL, MariaDB JSON được báo longtext gây từ chối object import, và ca export phụ thuộc fixture trước). Đây là ranh giới hỗ trợ cần giữ rõ, không tính chúng là đã xanh bằng việc bỏ assertion. Các ca chung đã chạy lại thành matrix MariaDB riêng. Full Node lần đầu có benchmark fake tính nhầm SET isolation thành data chunk; sửa fake nhận diện đúng SET, vẫn yêu cầu chính xác 4 chunk/2.000 dòng. Các log lần đầu và lần cuối được giữ trong evidence.

Lượt trước hệ thống duyệt từng ngắt chạy DB vì hết hạn mức duyệt. Khi người dùng yêu cầu tiếp tục, việc duyệt hoạt động lại; đã chạy đủ các ca trên, không còn coi đó là blocker.

Evidence: [thư mục kiểm chứng](review/gemini-2026-11-18/final/). Có log kiểm tra, trace editor cũ và kết quả handler trước/sau. Số pass là bằng chứng các ca đã chạy, không chứng nhận toàn bộ grammar/server/filesystem/platform.

## 3. Các việc chưa làm — giao tiếp cho Gemini

| Ưu tiên | Việc chưa hoàn thành | Bước tiếp theo và tiêu chí nhận |
| --- | --- | --- |
| 1 | Migration Apply end-to-end | Giữ `MIGRATION_APPLY_NOT_READY`. Nối collector/generator/admission/approval/executor bằng evidence Main; DB drift/pre/postcondition, DDL uncertain và quyền Production đủ matrix. Chỉ mở UI/IPC sau review riêng, không loop `db.query` ở renderer. |
| 1 | Data Sync Main-owned planning và ghi an toàn | Giữ `SYNC_APPLY_NOT_READY`, `canSynchronize=false`; report renderer chưa là quyền ghi. Lấy report/metadata/plan tại Main, engine/trigger effects, full exact original-value guards và rollback/implicit commit/approval/context matrix trước mở chức năng. |
| 1 | Full dialect restore và MariaDB JSON/import/export | Selective restore hiện chặn executable comments/hints, SQL mode/charset chưa chứng minh, expression động và các loại transaction chưa hỗ trợ. Muốn mở rộng cần bind dialect/version, cùng semantics plan/apply, marker ngoài selection và 0-write khi unknown. MariaDB JSON là longtext có CHECK: cần metadata/serialization contract riêng trước nhận JSON object, không gán tất cả longtext thành JSON. |
| 2 | Data Diff loại PK và completeness toàn bảng | Chưa text/enum/temporal PK khi không có order/collation proof, chưa snapshot chung hai server, chưa compare không giới hạn hoặc sync. Giữ bounded observation tối đa 2.000 dòng/phía. Bổ sung capability/quota/key order matrix trước mở rộng. |
| 2 | Crypto, replica, calendar scheduler, recovery UI | Helper/test và một số IPC đã có nhưng chưa toàn luồng catalog/manifest/migration/UI. File crypto mới V2 cần cập nhật contract/giao diện/read compatibility trước phát hành, không overwrite. Calendar chưa nối scheduler đang dùng interval/app-open; recovery helper chưa là quy trình khôi phục tài khoản hoàn chỉnh. |
| 2 | B13/B14/B16 và G4/G5/G8 | Metadata/filter, SQL Editor, privacy toàn bộ nơi lưu SQL, refactor/UX và performance/fault/load end-to-end; benchmark 50.000 dòng không thay thế nghiệm thu sản phẩm. Các mục chưa được review riêng không tự tick. |
| 3 | G9 release | Windows installer, Ubuntu installed/upgrade, ASAR mới cho commit này, crash/power-loss/filesystem khác, user acceptance/security review và runbook phát hành. Chưa tạo bộ cài hoặc publish trong lượt này. |

Đếm trực tiếp `DATABASE_PRODUCT_ROADMAP.md`: **51 mục, 29 chưa tick, 22 đã tick**. Đây là số checklist lịch sử, không suy phần trăm hoàn thành. Những mục đã tick vẫn có phần cần nghiệm thu ở bảng trên. Autocomplete cũ ở báo cáo R5 không còn là lỗi chưa rõ nguyên nhân; nguyên nhân đã có trace và regression trong lượt này.

## 4. Trạng thái commit

Commit được tạo sau khi các kiểm tra trên đạt, gồm runtime/test/tài liệu của working tree đang review; không push hoặc phát hành. Hash thực tế xem `git log -1` và thông báo hoàn tất của Codex. Các tài liệu R1–R5 giữ làm lịch sử và trỏ về báo cáo này để tránh đọc nhầm findings cũ là trạng thái hiện tại.
