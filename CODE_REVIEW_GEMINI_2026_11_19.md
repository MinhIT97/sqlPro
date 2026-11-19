# Review Gemini — 19/11/2026

> **Cập nhật sau sửa:** N01–N07 đã được xử lý theo [báo cáo bản sửa và phần còn lại](CODE_REVIEW_GEMINI_2026_11_19_FIXES.md). Nội dung dưới đây giữ nguyên làm bằng chứng trước sửa.

Đối chiếu `06e45ef..cf907bd` (hai commit `e4e8bf8`, `cf907bd`, 18 tệp), tập trung generator migration, Data Diff/Sync, MariaDB JSON, audit và UI backup mới. **Còn 7 findings: 4 P1, 3 P2. Chưa nghiệm thu các gói liên quan là hoàn tất.** Lượt này chỉ review và lưu bằng chứng, không sửa runtime, không commit.

Hai public Apply vẫn khóa: migration trả `MIGRATION_APPLY_NOT_READY`, Data Sync trả `SYNC_APPLY_NOT_READY`. Không phát hiện hay khẳng định có đường ghi công khai vượt hai khóa này. Findings ở executor nội bộ được phân biệt bên dưới. Báo cáo 18/11 là baseline lịch sử, không bao gồm hai commit mới.

## Findings

### N01 — P1: Generator làm đổi DEFAULT chứa backslash, hậu kiểm vẫn thành công

Vị trí: [schema-migration-generator.cjs:180](electron/schema-migration-generator.cjs#L180), hậu kiểm tại dòng 196; [schema-diff.js:658](schema-diff.js#L658). Nhánh ADD_COLUMN dòng 254 cũng dùng chung formatter.

`createCandidatePlan()` mới nối snapshot store với generator thật tại [schema-migration-service.cjs:147](electron/schema-migration-service.cjs#L147), nhưng formatter cũ chỉ nhân đôi dấu nháy, không bảo toàn backslash theo SQL mode của phiên thực thi. Không coi đây là lỗi mới được tạo ra bởi riêng bốn dòng sửa trong generator; đây là lỗi còn tồn tại trong đường tích hợp vừa bổ sung.

**Tái hiện MySQL 8.4.13:** bảng nguồn có DEFAULT chứa đúng các ký tự `C:`, backslash, `new`. Snapshot collector thật trả coverage complete; candidate ready; admission và executor nội bộ chạy DDL thành công, `executedCount: 1`. DEFAULT đích lại chứa ký tự xuống dòng thay cho backslash + `n`. JSON bằng chứng ghi nguồn `"C:\\new"`, đích `"C:\new"`. Hậu kiểm CREATE_TABLE chỉ xác nhận bảng tồn tại nên vẫn báo success.

**Ảnh hưởng:** SQL migration có thể tạo schema sai ngữ nghĩa và làm các INSERT dùng DEFAULT về sau sinh dữ liệu sai. Public Migration Apply vẫn khóa; probe gọi executor nội bộ, với `checkContext` được stub thành true, không phải bằng chứng đã mở luồng Apply UI.

**Tiêu chí sửa:** encoder literal có contract SQL mode/charset rõ ràng hoặc từ chối trường hợp chưa chứng minh; phân biệt literal với expression; hậu kiểm định nghĩa thực tế của cột/default. Regression cần có backslash, nháy, chuỗi literal `NULL`/`CURRENT_TIMESTAMP`, và SQL mode khác nhau trên DB thật. Không mở Apply chỉ vì bảng/cột tồn tại.

### N02 — P1: `_bin` chưa chứng minh equality/order của khóa text

Vị trí: [data-diff-reader.cjs:213](electron/data-diff-reader.cjs#L213), comparator dòng 108; đối chiếu collation tại [data-diff-service.cjs:422](electron/data-diff-service.cjs#L422).

Reader chấp nhận PK CHAR/VARCHAR khi tên collation kết thúc `_bin`, rồi so UTF-8 bằng `Buffer.compare`. Tên này chưa chứng minh quy tắc PAD SPACE tương đương comparator.

**Tái hiện MySQL 8.4.13:** hai bảng cùng PK `VARCHAR(10) COLLATE utf8mb4_bin`, nguồn `('key',1)`, đích `('key ',2)`. JOIN theo PK của server trả `sameKey: 1`. DataDiffService thật lại báo 1 onlyInSource, 1 onlyInTarget, 0 different, với `complete: true`, `consistent: true`.

**Ảnh hưởng:** báo cáo quan sát phân loại sai khóa khớp thành hai dòng không khớp. `canSynchronize: false` vẫn đúng; chưa có DML công khai từ báo cáo này.

**Tiêu chí sửa:** chứng minh charset, collation, pad semantics và thứ tự/equality của comparator cùng server; chưa chứng minh thì chặn text PK. Không sửa bằng cách trim mọi loại khóa. Test DB thật cần trailing spaces, case, Unicode và nhiều chunk, trên từng subset collation được cho phép.

### N03 — P1: Audit vẫn giữ nội dung private key PKCS#8

Vị trí: [audit-log.js:108](audit-log.js#L108), `createAuditEntry()` dùng sanitizer tại dòng 215.

Regex mới yêu cầu một tiền tố trước `PRIVATE KEY`, nên bỏ lọt block chuẩn `-----BEGIN PRIVATE KEY-----`. Nó bắt được `RSA PRIVATE KEY`, nhưng không bắt generic PKCS#8.

**Tái hiện:** tạo khóa Ed25519 dùng một lần, export PKCS#8 rồi gọi `sanitizeAuditSummary()`. Kết quả vẫn chứa header và toàn bộ base64 của khóa (118 ký tự trước gộp whitespace). Probe chỉ lưu boolean/độ dài, không in hoặc lưu PEM. Vì entry summary/errorSummary đi qua sanitizer này, nội dung nhạy cảm dạng đó vẫn có thể đi vào audit entry và bản xuất log.

**Tiêu chí sửa:** redact block generic PRIVATE KEY và các biến thể RSA/EC/OPENSSH/ENCRYPTED; regression qua `createAuditEntry`, lưu/đọc và export, không chỉ helper. Test multiline và input có khoảng trắng. Không đưa private key thật vào fixture/log bằng chứng.

### N04 — P1: Main-owned Data Sync chưa nối được service thật, vẫn fallback payload renderer

Vị trí: [data-sync-plan-service.cjs:109](electron/data-sync-plan-service.cjs#L109), [main.cjs:2484](electron/main.cjs#L2484), cấu trúc job thật tại [data-diff-service.cjs:354](electron/data-diff-service.cjs#L354).

Nhánh mới chỉ đọc job khi service có `getJob()`. DataDiffService thật không có method đó; job cũng chưa lưu `sourceScope`/`targetScope`. Khi thiếu method, code âm thầm dùng `diffReport` và scopes từ caller. Test mới mock `getJob()`, nên chưa kiểm chứng seam thực tế.

**Tái hiện Main VM:** dùng Main và hai service thật, fake SQL driver trả metadata/rows hữu hạn. Sau một job diff completed, gọi IPC tạo plan chỉ với jobId thật bị `INVALID_DIFF_REPORT`. Gửi jobId không tồn tại kèm report/scopes tự dựng lại được `ok: true`, một INSERT và database đích `made_up_target`. Apply sau đó vẫn bị `SYNC_APPLY_NOT_READY`; không có ghi DB qua IPC này.

**Ảnh hưởng:** API mới không dùng được theo contract jobId và chưa bảo đảm nguồn gốc Main-owned. Không nghiệm thu Main-owned Data Sync chỉ dựa trên test stub.

**Tiêu chí sửa:** public IPC chỉ chấp nhận lựa chọn hữu hạn từ renderer; resolve immutable report/scopes/proof từ job Main; job thiếu, hết hạn, cancelled, context đổi, thiếu service API hoặc report chưa đủ proof đều phải bị chặn. Không fallback sang report của caller. Test toàn đường `startDiff → completed → createSyncPlan` với service thật và rejected caller fields.

### N05 — P2: Nhận diện MariaDB JSON quá rộng, chặn giá trị text hợp lệ

Vị trí: [database.cjs:1414](electron/database.cjs#L1414), [row-values.js:57](row-values.js#L57).

Chỉ cần tìm thấy `json_valid(column)` ở bất cứ đâu trong CHECK là metadata gắn `isJson: true`. CHECK có OR không đồng nghĩa cột bắt buộc chứa JSON.

**Tái hiện MariaDB 11.4.13:** `payload LONGTEXT CHECK(JSON_VALID(payload) OR payload='plain')` nhận và lưu được `'plain'`. `listColumns(..., { fresh: true })` lại gắn cột là JSON; `normalizeValue(column, 'plain')` ném lỗi JSON không hợp lệ.

**Ảnh hưởng:** form/normalizer từ chối dữ liệu text hợp lệ của DB; contract kiểu trả về cũng có thể bị phân loại sai. Probe xác nhận lỗi validation, không khẳng định đã ghi hỏng dữ liệu.

**Tiêu chí sửa:** chỉ suy JSON khi chứng minh ràng buộc JSON_VALID bắt buộc của đúng cột; OR/NOT/biểu thức không hỗ trợ phải giữ text/unknown. Không chỉ thu hẹp regex Main trong khi renderer còn suy từ substring `checkClause`. Test JSON alias thực và LONGTEXT có CHECK phức hợp trên MariaDB thật.

### N06 — P2: Kiểm tra object mới dùng Buffer không tồn tại trong renderer

Vị trí: [row-values.js:100](row-values.js#L100).

Module UMD gọi `Buffer.isBuffer(raw)` trực tiếp khi raw là object không phải JSON. Renderer không bật Node integration, nên không có global Buffer.

**Tái hiện:** load module vào VM không có Buffer và normalize object cho VARCHAR: nhận `ReferenceError: Buffer is not defined`, thay vì lỗi validation theo contract. Đây là input object; không khẳng định nhập text bình thường bị lỗi. Node tests có Buffer nên không bắt được.

**Tiêu chí sửa:** guard capability Buffer và hỗ trợ typed-array theo môi trường; browser VM/renderer regression phải kiểm object, array, typed-array, JSON object và primitive. Lỗi dữ liệu phải trả thông báo validation, không ReferenceError.

### N07 — P2: Guard engine/trigger của Data Sync nội bộ cho qua metadata unknown

Vị trí: [data-sync-executor.cjs:138](electron/data-sync-executor.cjs#L138), kiểm tra triggers tại dòng 147.

Engine rỗng/không có row trở thành chuỗi rỗng và được cho qua bởi `if (engine && engine !== 'INNODB')`. Trigger response sai shape cũng bị coi như không có trigger; nếu thiếu `raw` thì toàn bộ guard bị bỏ qua.

**Tái hiện module với fake worker:** schema/PK khớp nhưng mọi `raw()` trả `{ result: [] }`. Executor vẫn phát INSERT và COMMIT, trả success với committedCount 1 dù chưa có bằng chứng InnoDB. Đây là kiểm chứng nhánh guard bằng fake worker, không phải thử ghi vào MyISAM thật hay chứng minh bypass Apply công khai.

**Tiêu chí sửa:** yêu cầu metadata engine đúng một row và giá trị đã xác nhận InnoDB; trigger response phải là mảng hợp lệ, thiếu API/metadata phải chặn. Kiểm lại engine/trigger trong phạm vi giữ ổn định định nghĩa bảng khi mở đường ghi; test unknown/malformed và đổi schema đồng thời, không chỉ explicit MyISAM hoặc có trigger.

## Kiểm chứng và giới hạn

| Kiểm tra chạy lại trên HEAD `cf907bd` | Kết quả |
| --- | --- |
| `npm run check` | 1.239 tổng: **1.223 pass, 0 fail, 16 opt-in skip** |
| `npm run test:renderer` | **101/101 pass** |
| `npm run test:website` | **14/14 pass** |
| `npm --prefix server run check` | Pass |
| `npm run server:test` | **17/17 pass** |
| Probe ngoài suite | Tái hiện N01–N07, xem observed.json |

Smoke/HTTP tests ban đầu bị sandbox chặn Electron/mở cổng loopback; đã chạy lại ngoài sandbox và đạt các kết quả trên. Không tính lỗi môi trường ban đầu thành lỗi sản phẩm. Hai container MySQL 8.4.13/MariaDB 11.4.13 dùng datadir tmpfs, chỉ mở loopback; probe tạo database tên ngẫu nhiên riêng, finally xóa database đó. Đã dọn cả hai container sau kiểm chứng. Không dùng database của người dùng.

Không chạy lại toàn bộ engine matrix 18/11, không kiểm installed Windows/macOS hoặc chứng nhận toàn roadmap. UI replica/container mới có trong diff nhưng smoke hiện có chưa chứng minh đầy đủ các tình huống cancel/context change của riêng hai luồng đó. Đây là phần kiểm chứng còn thiếu, không được tính thành finding đã tái hiện.

## Bằng chứng và giao tiếp cho Gemini

- [Probe nguồn](review/gemini-2026-11-19/reproduce.cjs), [quan sát JSON](review/gemini-2026-11-19/observed.json).
- [Node check](review/gemini-2026-11-19/check.txt), [renderer](review/gemini-2026-11-19/renderer.txt), [website](review/gemini-2026-11-19/website.txt), [server check](review/gemini-2026-11-19/server-check.txt), [server tests](review/gemini-2026-11-19/server-test.txt).

Probe là script thu thập quan sát, không phải acceptance suite có assertion: exit 0 nghĩa là chạy xong, **không nghĩa sản phẩm đạt**. Chạy phần VM/module bằng `node review/gemini-2026-11-19/reproduce.cjs`. Phần DB cần cung cấp `REVIEW_MYSQL_PORT`/`REVIEW_MARIA_PORT` trỏ tới DB loopback dùng một lần, root không mật khẩu như fixture này; container cũ đã được dọn, không tái dùng các port ngẫu nhiên đã ghi trong phiên review.

Giao sửa theo từng gói: **N01 generator/default/postcondition → N02 collation proof → N03 audit privacy → N04 + N07 Main-owned Sync/metadata guards → N05 + N06 contract JSON/browser**. Mỗi gói phải có regression bắt lỗi trên code trước sửa và chạy lại bộ kiểm tra liên quan; giữ hai public Apply khóa cho đến khi đủ tiêu chí đường ghi. Sau đó bổ sung UI lifecycle evidence cho replica/container và tiếp tục các hạng mục roadmap còn lại trong báo cáo baseline. Không tick hoàn tất toàn bộ B02/B06–B09 hoặc release chỉ vì suite hiện có xanh.
