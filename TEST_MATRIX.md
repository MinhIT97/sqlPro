# Ma trận kiểm thử SqlPro — cập nhật 19/11/2026

> **Mốc mới nhất 19/11:** [Đã sửa F01–F06 và giới hạn](CODE_REVIEW_FEATURES_2026_11_19_FIXES.md). Schema Diff UI đã dùng Main snapshot/plan; script giữ settings; Sync chặn inbound FK/metadata thiếu proof và đối chiếu lại quyền/context. Node **1.263 pass/0 fail/24 skip**, DB **43/43**, renderer **105/105**, website **14/14**, server **17/17**. Public Apply vẫn khóa; các dòng F01–F06 còn mở phía dưới giữ lịch sử trước sửa.

> **Review mới nhất 19/11:** [Rà tính năng và bugs tại 60cdb20](CODE_REVIEW_FEATURES_2026_11_19.md): còn **F01–F06 (5 P1/1 P2)** đã tái hiện, chưa sửa runtime. Schema Diff UI chưa dùng Main collector/service; public Apply khóa không bảo vệ toàn bộ SQL xuất/mở Editor. Các mốc sửa lỗi phía dưới giữ lịch sử; không tự tick roadmap.

## Mốc hiện tại — sửa E01–E04

[Bản sửa E01–E04 và review tiếp](CODE_REVIEW_GEMINI_2026_11_19_R3_FIXES.md): Node **1.275 tổng / 1.253 pass / 0 fail / 22 opt-in skip**; unit E mới **9/9** (cùng test baseline a564507: 9 fail); DB N/D/E trên MySQL 8.4.13/MariaDB 11.4.13 **27/27, 0 skip**. Renderer **103/103**, website **14/14**, server syntax đạt và tests **17/17**. Hai root DB mới vẫn opt-in trong Node suite; không cộng trùng số liệu. Chưa full installed/release matrix, public Apply tiếp tục khóa. [Evidence](review/gemini-2026-11-19/e-fixes/). Các mốc dưới đây giữ lịch sử.

> **Review sau commit:** [Review sau commit 8ee4c3f](CODE_REVIEW_GEMINI_2026_11_19_R3.md). Các suite hiện có chạy lại đạt cùng số liệu bên dưới; probe mới vẫn tái hiện E01–E04. Không suy pass suite là nghiệm thu hết lỗi. Public Apply tiếp tục khóa.

## Mốc mới nhất — sửa D01–D09

[Bản sửa D01–D09 và giới hạn](CODE_REVIEW_GEMINI_2026_11_19_R2_FIXES.md): Node **1.263 tổng / 1.243 pass / 0 fail / 20 opt-in skip**; regression mới **11/11** (baseline 2489b3a: 11 fail), renderer **103/103**, website **14/14**, server check đạt và tests **17/17**. Hai suite DB regression N/D chạy trên MySQL 8.4.13 và MariaDB 11.4.13 **17/17, 0 skip**. Các test DB opt-in vẫn skip trong lệnh Node mặc định; không cộng trùng số liệu. Chưa chạy lại toàn engine/installed/release matrix. Public Apply vẫn khóa, unsupported CHECK/SQL-mode literals bị chặn. [Evidence](review/gemini-2026-11-19/d-fixes/).

## Mốc trước — sửa N01–N07

[Bản sửa và phạm vi nghiệm thu](CODE_REVIEW_GEMINI_2026_11_19_FIXES.md): Node **1.250 tổng / 1.232 pass / 0 fail / 18 opt-in skip**; renderer **101/101**, website **14/14**, server syntax đạt và server tests **17/17**. Bảy regression thuần thất bại trên baseline và đạt trên bản sửa. DB regression mới trên MySQL 8.4.13/MariaDB 11.4.13 **9/9**, có metadata-lock race, DEFAULT qua hai SQL mode, collation và JSON. Không chạy lại toàn matrix engine/bộ cài của baseline bên dưới. Hai public Apply vẫn khóa; không chứng nhận release-ready.

## Baseline 18/11 — lịch sử

Package 0.3.12; đối chiếu working tree trên `7ede1a6`, được commit sau khi kiểm tra. [Báo cáo review cuối và việc chưa làm](CODE_REVIEW_FINAL_2026_11_18.md) là trạng thái hiện hành. Báo cáo R1–R5 giữ lịch sử, không tự suy nghiệm thu từ các dòng “hoàn thành” trong báo cáo cũ.

## Kết quả thực thi

| Nhóm | Lệnh/phạm vi | Kết quả và giới hạn |
| --- | --- | --- |
| Syntax + Node | `npm run check` | **1.222 tests: 1.206 pass / 0 fail / 16 opt-in skip**. Skip là các suite DB cần môi trường riêng, đã chạy riêng theo bảng dưới; không cộng trùng số test. |
| Renderer | `npm run test:renderer` | **101/101**, renderer/preload thật với IPC giả; layout nhỏ, bàn phím, undo và regression sự kiện editor cũ. Không phải nghiệm thu UI với dữ liệu Production. |
| Website | `npm run test:website` | **14/14**, generator, nội dung, responsive, tải xuống/fallback. |
| Server | `npm --prefix server run check`; `npm run server:test` | Syntax đạt; **17/17** tests. |
| MySQL | 16 suite trên MySQL **8.4.13** riêng | **159/159, 0 skip**; gồm restore, Data Diff service và packet trên server riêng 32 KB. |
| MariaDB | 14 suite chung trên MariaDB **11.4.13** riêng | **120/120, 0 skip**. Không bao gồm `mysql-integration.test.cjs` viết riêng cho MySQL hoặc packet suite chạy MySQL. |
| Packet boundary | `selection-packets-integration.test.cjs`, server `max_allowed_packet=32768` | **6/6**, đã nằm trong 159 MySQL; không cộng thêm. |
| Diff whitespace | `git diff --check` | Đạt. |
| Bộ cài/upgrade | Windows/Ubuntu installed, ASAR mới | **Chưa chạy trong lượt này**; không đánh dấu release-ready. |

Evidence lần chạy cuối và lần thất bại ban đầu: [review/gemini-2026-11-18/final](review/gemini-2026-11-18/final/). DB dùng container tạm/tmpfs và marker riêng, không DB người dùng. Không đổi global server người dùng hoặc nới assertion để xanh test.

## Regression và bằng chứng an toàn

| Phạm vi | Test | Hành vi kiểm chứng |
| --- | --- | --- |
| Restore V01–V04 | `restore-safety-fixes.test.cjs` — 15 tests | Context/mode/conditional comments, preflight trước pre-drop, typed AUTOCOMMIT, pending writes, COMMIT lost ACK, Main IPC outcome, timeout/cancel/late connect/close, generation/profile drift. |
| Restore DB thật | `restore-safety-mysql.test.cjs` — 6 gồm test cha | Worker context bất tương thích không xóa marker; chưa COMMIT rollback khi đóng; save/restore context; COMMIT thật rồi lỗi ACK báo uncertain; inherited CHAIN. Chạy cả MySQL/MariaDB. |
| Bổ sung review cuối | `review-final-safety.test.cjs` — 13 tests | No-overwrite kể cả race publish, AAD/header/legacy/empty backup, cron invalid token/DOM-DOW/DST, IPC clone/error privacy/Data Diff cleanup/drift/order proof. |
| Data Diff DB thật | `data-diff-service-integration.test.cjs` | PK bigint chính xác, decimal, báo cáo clone được, row counts giữ nguyên, MyISAM không được coi consistent, text PK bị chặn. Chạy cả hai engine. |
| Migration nội bộ | `schema-migration-executor.test.cjs` | Thêm unknown DDL error/precondition not-sent, context drift trong precondition, observer treo không giữ worker. Public Apply tiếp tục khóa. |
| Autocomplete | `renderer-smoke.cjs` | Editor cũ phát scroll/blur không đóng popup mới; queued viewport notification/refocus không làm mất popup, cuộn thật vẫn đóng, keyboard/undo và layout nhỏ được giữ. Test fail với handler cũ trong bản app tạm, pass với bản sửa. |
| Các đường an toàn trước đây | `code-review-regressions*.test.cjs`, suites hiện có | Production receipt/token, immutable plan/checksum, exact-case/scope, replica không ghi đè, schema metadata/generator và public Apply bị khóa. Tests giả không thay thế mọi engine/platform. |

## Khả năng còn hạn chế hoặc chưa nghiệm thu

- **Migration/Data Sync:** public Apply vẫn khóa; Data Diff report không là quyền ghi, sync vẫn `canSynchronize=false`. Cần Main-owned evidence, schema/engine/trigger/concurrency và approval matrix trước mở.
- **Selective restore:** unsupported SQL modes/charset, executable comments/hints và expression/transaction chưa chứng minh đều bị từ chối trước ghi. Không tuyên bố parser full dialect/version.
- **Data Diff:** service PK số exact; chưa hỗ trợ khóa phụ thuộc collation/order chưa chứng minh. Bounded 2.000 dòng/phía; hai snapshot riêng không phải một snapshot chung hai server. Unknown engine không được đoán InnoDB.
- **MariaDB:** các suite dùng chung đã qua; fixture riêng MySQL có khác biệt CREATE/expression-index/JSON. MariaDB JSON longtext/CHECK và luồng object import/export cần hợp đồng riêng; không gán mọi longtext thành JSON để vượt test.
- **Crypto/replica/calendar/recovery:** có helper và test, chưa toàn bộ catalog/UI/manifest/upgrade. Container mới ghi version 2 có AAD, vẫn đọc legacy V1; cần compatibility UI/contract trước release. Scheduler hiện không tự chạy khi app đóng.
- **Hiệu năng/kiến trúc/UX/phát hành:** chưa full fault/load/OS filesystem, installer/upgrade, user acceptance hoặc security/release runbook.

Checklist roadmap đọc trực tiếp: **29/51 chưa tick**, không đổi checkbox do helper tests. Bảng nghiệm thu cũ từng ghi B03–B18 “hoàn thành” đã được thay bằng trạng thái có điều kiện ở trên để tránh hiểu nhầm.
