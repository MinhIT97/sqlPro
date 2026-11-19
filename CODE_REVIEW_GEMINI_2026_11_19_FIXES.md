# Sửa N01–N07 sau review — 19/11/2026

> **Review tiếp theo:** [D01–D09 và tính năng còn thiếu](CODE_REVIEW_GEMINI_2026_11_19_R2.md), trên `c7df696` và `2489b3a`: còn 9 findings mới chưa sửa. Đóng N01–N07 bên dưới chỉ áp dụng phạm vi lượt sửa trước.

Đã xử lý cả 7 findings trong [báo cáo review](CODE_REVIEW_GEMINI_2026_11_19.md), trên baseline `cf907bd`. Giữ nguyên khóa public Migration Apply/Data Sync Apply. Không thay đổi database người dùng; toàn bộ kiểm chứng DB dùng hai container tạm, schema riêng có tên ngẫu nhiên và đã dọn.

## Thay đổi và bằng chứng

| Finding | Bản sửa | Kiểm chứng |
| --- | --- | --- |
| N01 — DEFAULT/hậu kiểm | Literal chứa backslash, control hoặc Unicode dùng `_utf8mb4 0x…`, độc lập NO_BACKSLASH_ESCAPES. Chuỗi `NULL`/`CURRENT_TIMESTAMP` ở VARCHAR giữ là literal; SQL NULL phân biệt theo dialect. Generator gắn expectedColumns vào CREATE_TABLE/ADD_COLUMN. Executor đối chiếu name/type/nullability/default/extra/collation thực tế, không chỉ tồn tại; query có params dùng prepared execution. | CREATE_TABLE và ADD_COLUMN thật trên MySQL 8.4.13 qua hai SQL mode, kiểm metadata và INSERT dùng DEFAULT với backslash, nháy, Unicode, empty, keyword literals và SQL NULL. Regression hậu kiểm DEFAULT sai phải báo failed/partialCommit, dừng statement tiếp theo. MariaDB non-null/expression defaults bị chặn rõ `MARIADB_DEFAULT_REVIEW_REQUIRED` tại generator và preview service, không suy biểu thức thành literal. |
| N02 — collation | Chỉ admit VARCHAR `utf8mb4_0900_bin` khi server trả đúng một proof charset utf8mb4 và NO PAD. CHAR, PAD SPACE, collation khác, denied/missing/malformed proof đều chặn. | MySQL xác nhận `utf8mb4_bin` coi `key` và `key ` bằng nhau; reader mới từ chối trường hợp đó. Subset NO PAD được kiểm với trailing spaces và 21 dòng chung qua nhiều chunks. Unit test thêm missing proof/wrong charset/CHAR. |
| N03 — audit | Redact generic PKCS#8 và RSA/EC/OPENSSH/ENCRYPTED PRIVATE KEY, gồm block bị cắt. Store áp quy tắc mới khi đọc entry cũ trước UI/export và lần ghi lại tiếp theo. | Test entry, file, CSV/JSON export, legacy read và rewrite; không lưu/in secret trong bằng chứng. Tệp audit cũ chưa được đọc/ghi lại không bị tự sửa nền; không tuyên bố xóa được các bản export đã phát hành. |
| N04 — Main-owned plan | DataDiffService lưu scope/generation/fingerprint lúc tạo job và có getJob Main-only trả clone frozen, kiểm lại profile/context/TTL. IPC tạo plan dùng createSyncPlanFromJob với allowlist; từ chối report/scope/SQL từ caller, thiếu service hoặc job không hợp lệ. Report phải complete + consistent; plan từ bounded observation vẫn chỉ preview và executor nội bộ cũng chặn Apply cho plan này. | Main VM dùng Main + service thật: startDiff → completed → createSyncPlan; rejected forged fields, unknown/running/cancelled/failed/expired/incomplete/context-changed jobs. Không dùng getJob giả để thay thế integration evidence. Public và internal Apply của preview đều bị chặn. |
| N05 — MariaDB JSON | Main/renderer dùng chung parser chỉ nhận toàn bộ ràng buộc JSON_VALID của đúng cột, với outer parentheses cân bằng và identifier quoted/escaped. Bỏ suy JSON từ substring. | MariaDB 11.4.13: JSON alias được nhận diện; LONGTEXT với `JSON_VALID(payload) OR payload='plain'` giữ text, nhận `'plain'`. Unit test OR/NOT/literal/khác cột/constraint phức hợp và dấu ngoặc sai. |
| N06 — Buffer renderer | Guard sự tồn tại của Buffer; giữ typed-array API của browser. | VM không có Buffer: object/array nhận lỗi validation, primitive/JSON/typed-array không phát ReferenceError. Renderer smoke thật đạt. |
| N07 — metadata guards | Engine phải có đúng một row/string InnoDB; trigger response phải là array hợp lệ. Thiếu/sai metadata chặn trước DML. Mỗi batch mở bảng trong transaction để giữ metadata lock rồi mới kiểm engine/triggers; operation ngoài danh sách bảng đã khóa bị từ chối. Metadata queries dùng prepared execution. | Unit test empty/malformed/duplicate engine, malformed triggers: không DML/COMMIT, có ROLLBACK. Cả MySQL/MariaDB thật: ALTER ENGINE đồng thời timeout khi giữ lock; MyISAM và bảng có trigger bị chặn, số dòng đích giữ nguyên sau hai lần từ chối. |

Fixture cũ đã được bổ sung metadata đúng shape để các test concurrency/COMMIT/approval tiếp tục kiểm đúng hành vi ban đầu. Không nới assertion để bỏ qua guard mới.

## Kết quả chạy cuối

| Lệnh/phạm vi | Kết quả |
| --- | --- |
| `npm run check` | **1.250 tổng: 1.232 pass / 0 fail / 18 opt-in skip** |
| 7 regression N01–N07 trên code baseline | **0 pass / 7 fail**, như kỳ vọng để chứng minh bắt lỗi trước sửa |
| Cùng 7 regression trên bản sửa | **7/7 pass** |
| Main integration và semantic postcondition mới | Đạt, đã tính trong tổng Node; không cộng trùng |
| `npm run test:renderer` | **101/101 pass** |
| `npm run test:website` | **14/14 pass** |
| `npm --prefix server run check` | Pass |
| `npm run server:test` | **17/17 pass** |
| `test/review-nov19-db.test.cjs` trên MySQL 8.4.13 và MariaDB 11.4.13 | **9/9 pass, 0 skip**, chỉ các regression DB của lượt này |
| `git diff --check` | Pass |

18 skip gồm 16 opt-in cũ và hai root tests DB mới. Không cộng kết quả matrix 18/11 vào lượt chạy này. Test DB migration gọi admission/executor nội bộ với context hook trong fixture; không phải bằng chứng public Apply đã được mở.

Bằng chứng: [trước sửa](review/gemini-2026-11-19/fixes/before.txt), [sau sửa](review/gemini-2026-11-19/fixes/after.txt), [Node check](review/gemini-2026-11-19/fixes/check.txt), [DB](review/gemini-2026-11-19/fixes/database.txt), [renderer](review/gemini-2026-11-19/fixes/renderer.txt), [website](review/gemini-2026-11-19/fixes/website.txt), [server](review/gemini-2026-11-19/fixes/server.txt), [server syntax](review/gemini-2026-11-19/fixes/server-check.txt).

Chạy regression thuần bằng `node test/review-nov19-regressions.test.cjs`. Regression DB opt-in dùng `SQLPRO_REVIEW_MYSQL_PORT`/`SQLPRO_REVIEW_MARIA_PORT`, trỏ tới server loopback dùng một lần với root không mật khẩu. Các container/cổng của phiên này đã dọn, không dùng chúng như cấu hình cố định.

## Phần còn lại để Gemini triển khai

Đóng findings không đồng nghĩa mở đủ tính năng hoặc nghiệm thu release. Còn các hạng mục đã có trong [baseline roadmap](CODE_REVIEW_FINAL_2026_11_18.md#3-các-việc-chưa-làm--giao-tiếp-cho-gemini), ưu tiên:

1. Hoàn thiện dialect contract cho DEFAULT biểu thức/non-null MariaDB, mở rộng proof collation ngoài subset VARCHAR NO PAD đã kiểm. Các trường hợp này đang bị chặn có chủ đích.
2. Migration Apply và Data Sync Apply thực tế: admission, authorization, full lifecycle/schema/source proof, concurrency và UI nghiệm thu; hai public endpoint vẫn khóa.
3. UI replica/container: kiểm thêm cancel/context/modal lifecycle và luồng người dùng hoàn chỉnh; test smoke chung không thay thế các tình huống riêng này.
4. Các tích hợp backup crypto/calendar/recovery và installed/release matrix còn lại theo roadmap. Lượt này không chạy lại toàn bộ matrix engine cũ hoặc bộ cài Windows/macOS.

Không tự tick thêm checkbox roadmap hay cam kết toàn sản phẩm hết lỗi từ lượt sửa này.
