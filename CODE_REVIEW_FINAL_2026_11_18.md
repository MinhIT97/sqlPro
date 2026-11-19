# Review, sửa lỗi và chốt commit — 18/11/2026

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
