# Báo cáo Xác minh Rủi ro Các Đường Ghi Đã Tick (Gói B01 — Bản Cập Nhật Rà Soát Đầy Đủ)

> Cập nhật sau review: B01 là hồ sơ xác minh, không phải bản sửa các luồng runtime được mô tả dưới đây. Phần collector B02 và hai findings index/trigger đã được sửa riêng; xem [B02_REVIEW_FIXES.md](B02_REVIEW_FIXES.md). Kết quả toàn bộ check mới: **994 pass / 0 fail / 14 skip**; số liệu ở phần kết luận bên dưới là lịch sử trước khi thêm test B02.

**Mốc đối chiếu:** Commit `f812fc1` (`f812fc179a32c25a07c1341d24c0429bfef10808`)\
**Tập kiểm thử tái hiện:** `test/risk-verification-b01.test.cjs` (**10/10 bài kiểm thử gọi trực tiếp code thật đều pass**)\
**Ngày cập nhật:** 17/11/2026\
**Mục tiêu:** Cập nhật kết quả rà soát sau phản hồi của Codex, loại bỏ các phép thử tautology, gọi trực tiếp code ứng dụng thật qua Node.js và VM renderer, phân biệt rõ ràng giữa **Kiểm tra qua đọc code**, **Tái hiện qua code thật trong môi trường giả lập (Mock/VM)**, và **Kiểm chứng trên CSDL thật**.

---

## 1. Bảng Tổng Hợp Findings & Phương Pháp Kiểm Chứng

| Mã Finding | Mức độ | Nhóm chức năng | Tóm tắt lỗi | Phương pháp kiểm chứng | Trạng thái kỹ thuật |
| --- | --- | --- | --- | --- | --- |
| **FINDING-B01-1** | **P1** | G6.4 Schema Migration | **Lỗi gọi hàm `confirmAction` làm nút Apply tê liệt:** `app.js:3724` truyền callback làm tham số thứ hai, nhưng `confirmAction` coi tham số này là `message` và trả về Promise; callback thực thi **không bao giờ được gọi** (gọi 0 lần). | Kích hoạt handler click thật trên `#diffApplyTargetBtn` qua VM renderer (`test B01.1`) | **LỖI ĐÃ XÁC NHẬN (CONFIRMED BUG)** |
| **FINDING-B01-2** | **P0** | G6.4 Schema Migration | **Rò rỉ cờ `FOREIGN_KEY_CHECKS = 0` (Rủi ro tiềm ẩn):** Khối thực thi DDL trong `app.js:3730–3752` thiếu khối `finally` để khôi phục `SET FOREIGN_KEY_CHECKS = 1`. Do nút Apply bị lỗi (B01-1), rủi ro này đang ở dạng tiềm ẩn trong code thực tế; khi kích hoạt callback thực tế trong môi trường cô lập, lỗi DDL bỏ quên cờ FK ở mức 0. | Bắt callback thật từ handler dòng 3724, kích hoạt cô lập khi có lỗi DDL (`test B01.2`) | **LỖI TIỀM ẨN ĐÃ XÁC NHẬN (LATENT DEFECT)** |
| **FINDING-B01-3** | **P0** | G6.4 Schema Migration | **Thiếu kiểm tra Drift CSDL đích:** `app.js` gửi trực tiếp câu lệnh DDL qua `desktop.db.query({ confirmed: true })` mà không có bước re-capture fingerprint hay kiểm tra schema drift của CSDL đích sát lúc chạy. | Rà soát AST và mã nguồn khối sự kiện `#diffApplyTargetBtn` (`test B01.3`) | **KHIẾM KHUYẾT KIẾN TRÚC ĐÃ XÁC NHẬN** |
| **FINDING-B01-4** | **P0** | G6.1/G6.2 Snapshot | **Snapshot thiếu đối tượng & hardcode engine:** `captureFullSchema` trong `app.js` trả về views với `definition: ''`, routines với `sql: ''`, triggers `[]`, events `[]` và hardcode `engine: 'MySQL'`. | Trích xuất chính xác phạm vi hàm `captureFullSchema` từ `app.js` và thực thi với metadata fixture (`test B01.4`) | **LỖI ĐÃ XÁC NHẬN (CONFIRMED BUG)** |
| **FINDING-B01-5** | **P0** | G6.1/G6.2 Snapshot | **`SchemaDiff.compareSchemas` bỏ sót Triggers & Events:** Module `schema-diff.js` hoàn toàn không có vòng lặp so sánh triggers và events, dẫn đến bỏ sót 100% thay đổi của trigger/event. Ngoài ra, view có `definition: ''` gây sinh sai `ALTER_VIEW`. | Chạy trực tiếp `SchemaDiff.compareSchemas` và `generateMigrationSql` (`test B01.5`, `test B01.6`) | **LỖI ĐÃ XÁC NHẬN (CONFIRMED BUG)** |
| **FINDING-B01-6** | **P0** | G3.1/G3.2 Selective Restore | **Đứt gãy liên kết kiến trúc Restore:** IPC `preview-object-restore-plan` và `inspect-restore-objects` **không hề được gọi ở bất kỳ đâu trong UI `app.js`**. Executor `db:restore` và `restoreDatabaseInternal` không nhận và không lọc theo kế hoạch chọn đối tượng. | Rà soát liên kết UI → IPC → Plan → Executor trên toàn codebase (`test B01.7`) | **KHIẾM KHUYẾT KIẾN TRÚC ĐÃ XÁC NHẬN** |
| **FINDING-B01-7** | **P1** | G5.5 Privacy | **Lưu trữ SQL nhạy cảm thô vào đĩa:** `persistState()` trong `app.js` lưu trực tiếp nội dung editor và `queryTabs` chứa mật khẩu (`IDENTIFIED BY`) xuống file state mà không lọc qua `scrubSensitiveSql`. | Chạy trực tiếp `persistState()` qua VM renderer thật (`test B01.8`) | **LỖI ĐÃ XÁC NHẬN (CONFIRMED BUG)** |
| **FINDING-B01-8** | **P1** | G5.6 Diagnostics | **Nhầm lẫn kết nối khi Kill tiến trình:** Dòng tiến trình của `SqlDiagnostics` không chứa `profileId`. Handler click `.kill-query-btn` đánh giá lại `activeQueryTarget()` sau `await confirmAction`, gửi nhầm lệnh `KILL` sang CSDL khác nếu `app.connection` thay đổi trong lúc modal xác nhận đang mở. | Kích hoạt handler click thật, giữ pending confirmation, đổi `app.connection`, và bắt payload `desktop.db.query` (`test B01.9`) | **LỖI ĐÃ XÁC NHẬN (CONFIRMED BUG)** |
| **FINDING-B01-9** | **P1** | G3.3 Scheduler | **Giới hạn bộ lập lịch sao lưu:** `electron/backup-scheduler.cjs` chỉ chấp nhận và kích hoạt theo `intervalHours` (1–168). Các trường bổ sung như `timeOfDay` hay `cron` bị bỏ qua (silently dropped/ignored); không xử lý calendar-based, DST và chỉ chạy bằng `setTimeout` trong tiến trình Node khi app đang mở. | Chạy trực tiếp `createScheduleStore.save()` với dữ liệu cấu hình có `timeOfDay` và `cron` (`test B01.10`) | **GIỚI HẠN ĐÃ XÁC NHẬN (CONFIRMED LIMITATION)** |

---

## 2. Chi Tiết Từng Phát Hiện và Bằng Chứng Kỹ Thuật

### 2.1 FINDING-B01-1: Nút Apply Migration không thể thực thi do sai quy ước gọi `confirmAction`
- **Vị trí code:** `app.js:3724` trong sự kiện `#diffApplyTargetBtn`.
- **Mã nguồn thực tế:**
  ```javascript
  const confirmMsg = `Bạn có chắc chắn muốn thực thi ${activeStatements.length} câu lệnh DDL vào CSDL "${targetDb}" không?...`;

  confirmAction(confirmMsg, async () => {
    closeModal();
    setStatus(`Đang thực thi migration vào ${targetDb}...`);
    ...
  }, { separate: true });
  ```
- **Nguyên nhân kỹ thuật:**
  Hàm `confirmAction` tại [app.js:10895](file:///var/www/project/SqlPro/app.js#L10895) có chữ ký:
  ```javascript
  function confirmAction(title, message, confirmLabel = 'Xác nhận', { separate = false } = {}) {
    return new Promise((resolve) => { ... });
  }
  ```
  Hàm này trả về một `Promise<boolean>` và nhận các tham số là chuỗi hiển thị. Tại dòng 3724, lập trình viên đã truyền hàm `async () => { ... }` vào vị trí tham số thứ hai (`message`). Hàm này bị ép thành chuỗi ký tự hiển thị trong thẻ `<p>` của dialog, và **không bao giờ được thực thi**.
- **Bằng chứng kiểm chứng:**
  Ca test `B01.1` trong `test/risk-verification-b01.test.cjs` nạp `app.js` qua VM renderer, mở modal Schema Diff, chạy so sánh, chuyển sang tab migration, và kích hoạt handler click thực tế của `#diffApplyTargetBtn`:
  - `confirmAction` nhận tham số thứ hai là `function`.
  - Hộp thoại dialog resolve về `true`.
  - Số lệnh truy vấn gửi tới `desktop.db.query`: **chính xác 0 lệnh**.
- **Kết luận:** Nút "Áp dụng trực tiếp vào CSDL Đích" trên giao diện hiện tại hoàn toàn không hoạt động. Do đó, việc rò rỉ `FOREIGN_KEY_CHECKS = 0` chưa từng xảy ra trên thực tế qua nút này vì khối code bên trong chưa từng được chạy.

---

### 2.2 FINDING-B01-2: Khối thực thi DDL thiếu `finally` để khôi phục `FOREIGN_KEY_CHECKS = 1`
- **Vị trí code:** `app.js:3730–3752`.
- **Mã nguồn thực tế:**
  ```javascript
  try {
    if (wrapForeignKeys) {
      await call(desktop.db.query({ profileId: targetProfileId, database: targetDb, sql: 'SET FOREIGN_KEY_CHECKS = 0;' }));
    }
    for (const stmt of activeStatements) {
      await call(desktop.db.query({ profileId: targetProfileId, database: targetDb, sql: stmt.sql, confirmed: true }));
      executedCount++;
    }
    if (wrapForeignKeys) {
      await call(desktop.db.query({ profileId: targetProfileId, database: targetDb, sql: 'SET FOREIGN_KEY_CHECKS = 1;' }));
    }
    toast(...);
  } catch (err) {
    toast(`Lỗi khi áp dụng migration...`, 'error');
    setStatus(`Migration thất bại...`);
  }
  ```
- **Tác động nếu khối code này được kích hoạt:**
  Nếu một câu lệnh DDL ở giữa vòng lặp thất bại, luồng thực thi lập tức nhảy sang khối `catch`. Câu lệnh `SET FOREIGN_KEY_CHECKS = 1;` nằm ở cuối khối `try` sẽ bị bỏ qua. Kết nối CSDL của phiên làm việc đó sẽ bị bỏ quên ở trạng thái tắt kiểm tra khóa ngoại (`0`), khiến các thao tác tiếp theo trong SQL Editor hay Grid trên cùng phiên bị mất kiểm soát toàn vẹn dữ liệu.
- **Bằng chứng kiểm chứng:**
  Ca test `B01.2` bắt lấy chính callback thực tế được xây dựng bên trong handler `diffApplyTargetBtn` (dòng 3724), sau đó thực thi callback này trong môi trường giả lập lỗi DDL. Kết quả: `SET FOREIGN_KEY_CHECKS = 0` được phát đi, DDL thất bại bị bắt bởi `catch`, và `SET FOREIGN_KEY_CHECKS = 1` **hoàn toàn không được gửi đi**.
- **Phân loại rủi ro:** Đây là một **rủi ro tiềm ẩn (latent defect)** đã được chứng minh qua kiểm tra code và thực thi cô lập callback thật. B02 bắt buộc phải xây dựng executor độc lập trên Main Process với khối `finally` nghiêm ngặt và kiểm thử hồi quy trước khi nối lại nút trên UI.

---

### 2.3 FINDING-B01-3: Thiếu hoàn toàn cơ chế kiểm tra Drift CSDL đích sát lúc chạy
- **Vị trí code:** `app.js:3710–3755` và `electron/main.cjs:1199`.
- **Hiện trạng kiểm tra qua mã nguồn:**
  Khi người dùng click nút Apply, Renderer chỉ lọc danh sách `migrationStatements.filter(s => s.enabled)` và phát từng câu lệnh SQL đơn lẻ qua IPC `desktop.db.query`.
  - Không có bước chụp lại fingerprint của CSDL đích.
  - Không có mốc phiên bản (Schema Revision) để đối chiếu xem CSDL đích có bị người khác sửa đổi/xóa bảng trong lúc hộp thoại đang mở hay không.
  - Main Process hoàn toàn bị động, chỉ nhận các chuỗi SQL đơn lẻ kèm cờ `confirmed: true` mà không biết các câu lệnh này thuộc một kế hoạch migration.
- **Bằng chứng kiểm chứng:**
  Ca test `B01.3` rà soát trực tiếp mã nguồn handler trong `app.js`, xác nhận hoàn toàn vắng bóng các lời gọi kiểm tra fingerprint hoặc drift.

---

### 2.4 FINDING-B01-4 & FINDING-B01-5: Snapshot thiếu đối tượng và `SchemaDiff` bỏ sót Triggers/Events
- **Vị trí code:** `app.js:3358–3430` (`captureFullSchema`) và `schema-diff.js:586–637` (`compareSchemas`).
- **Hiện trạng kiểm tra qua mã nguồn và module thật:**
  1. `captureFullSchema` trong `app.js` trả về:
     - `views: rawTables.filter(t => t.type === 'view').map(v => ({ name: v.name, definition: '' }))`
     - `routines: (routinesList || []).map(r => ({ name: r.name, type: r.type, sql: '' }))`
     - `triggers: []` (luôn rỗng)
     - `events: []` (luôn rỗng)
     - `engine: 'MySQL'` (cố định)
  2. Trong `schema-diff.js`, hàm `compareSchemas` chỉ thực hiện so sánh:
     - Pha 1: Bảng & Cột (dòng 409–584)
     - Pha 2: Views (dòng 586–609)
     - Pha 3: Routines (dòng 611–635)
     - **Hoàn toàn không có vòng lặp so sánh Triggers và Events.** Mặc dù đối tượng `diff` có khởi tạo `triggers: { added: [], dropped: [], modified: [] }`, nhưng nó bị bỏ trống 100%.
  3. Khi target view có `definition: ''` (do `captureFullSchema` tạo ra), việc so sánh với source view có định nghĩa thật luôn dẫn đến `sv.definition !== tv.definition`, làm sinh ra lệnh `CREATE OR REPLACE VIEW` giả mà không có căn cứ đối chiếu.
- **Bằng chứng kiểm chứng:**
  - Ca test `B01.4` trích xuất chính xác phạm vi thân hàm `captureFullSchema` từ `app.js` (dòng 3358 đến 3431) và thực thi trong VM với mock metadata fixture; xác nhận kết quả trả về chứa views có `definition: ''`, routines có `sql: ''`, triggers `[]`, events `[]` và `engine: 'MySQL'`.
  - Ca test `B01.5` chạy trực tiếp `SchemaDiff.compareSchemas` với dữ liệu có Triggers và Events, xác nhận `diff.triggers.added` và `diff.events.added` đều có độ dài bằng `0`.
  - Ca test `B01.6` chạy `SchemaDiff.compareSchemas` và `SchemaDiff.generateMigrationSql`, xác nhận việc `definition: ''` sinh ra câu lệnh `CREATE OR REPLACE VIEW` không cần thiết.

---

### 2.5 FINDING-B01-6: Đứt gãy Kiến trúc Selective Object Restore (G3.1/G3.2)
- **Vị trí code:** `app.js`, `electron/preload.cjs:84–87`, `electron/main.cjs:2192`, `electron/database.cjs:3399`.
- **Rà soát toàn diện chuỗi luồng:**
  1. **UI (`app.js`):** Hoàn toàn KHÔNG CÓ giao diện chọn đối tượng khi phục hồi. Các hàm IPC `inspectRestoreObjects` và `previewObjectRestorePlan` được khai báo trong `preload.cjs` nhưng không hề được gọi ở bất kỳ dòng nào trong `app.js`. UI phục hồi tại dòng 12566, 12821, 13060 chỉ gọi duy nhất `desktop.db.restore` (chế độ phục hồi toàn bộ).
  2. **Main Process (`main.cjs`):** Endpoint `db:restore` (dòng 2192) chỉ nhận các tham số `{ database, filePath, dropExisting, createDatabaseIfNotExists, taskId }`. Nó không nhận `planId` hay danh sách câu lệnh từ kế hoạch chọn lọc đối tượng.
  3. **Executor (`database.cjs`):** Hàm `restoreDatabaseInternal` chỉ nhận đường dẫn file và thực thi toàn bộ các câu lệnh trong file qua `readStatementsFromSqlFile`.
- **Đính chính kết luận:**
  UI hiện tại chưa từng có nút hay modal nào cho phép người dùng chọn bảng khi phục hồi. Sự thật kỹ thuật là: **Tính năng Phục hồi chọn lọc đối tượng (G3.1/G3.2) mới chỉ dừng lại ở tầng tính toán đồ thị Kahn's DAG trong inventory độc lập; nó chưa từng được nối vào UI và chưa từng được nối vào Executor.**
- **Bằng chứng kiểm chứng:**
  Ca test `B01.7` kiểm tra trực tiếp mã nguồn của cả 3 tầng (`app.js`, `main.cjs`, `database.cjs`) và tạo kế hoạch mẫu qua `RestoreObjectInventory.generateExecutionPlan`, xác nhận sự đứt gãy hoàn toàn của chuỗi liên kết này.

---

### 2.6 FINDING-B01-7: `persistState` lưu SQL nhạy cảm ở dạng thô
- **Vị trí code:** `app.js:1043–1065` (`persistState`).
- **Hiện trạng kiểm tra qua code thật:**
  Khi người dùng nhập câu lệnh có chứa mật khẩu (ví dụ `CREATE USER root IDENTIFIED BY 'SecretP@ss123!';`), hàm `persistState` kích hoạt và gửi nguyên văn đối tượng `queryTabs` cùng `savedQuery` xuống `desktop.saveState()`.
  Tệp state này được lưu trữ dưới dạng JSON không mã hóa trên ổ đĩa người dùng. Trong khi module `query-snippets.js` sở hữu hàm `scrubSensitiveSql` che giấu mật khẩu rất tốt, thì `persistState` lại không sử dụng hàm này.
- **Bằng chứng kiểm chứng:**
  Ca test `B01.8` nạp `app.js` qua VM, thiết lập tab chứa câu lệnh mật khẩu và kích hoạt `persistState()`. Tệp kiểm tra nhận được chính xác chuỗi mật khẩu thô trong payload gửi tới `desktop.saveState`.

---

### 2.7 FINDING-B01-8: Tiến trình Chẩn đoán không có `profileId` và nguy cơ trôi đích khi Kill
- **Vị trí code:** `diagnostics.js:50–72` và `app.js:2703–2728`.
- **Hiện trạng kiểm tra qua code thật:**
  1. Hàm `parseProcesslistRow` trong `diagnostics.js` chuẩn hóa dữ liệu từ `SHOW FULL PROCESSLIST` của MySQL. Vì MySQL không biết về khái niệm Profile của SqlPro, đối tượng tiến trình `p` trả về **hoàn toàn không có thuộc tính `profileId`**.
  2. Tại `app.js:2715–2720`:
     ```javascript
     const confirmed = await confirmAction(`Dừng câu lệnh SQL #${killId}?`, msg, ...);
     if (!confirmed) return;
     try {
       const sql = typeof SqlDiagnostics !== 'undefined' ? SqlDiagnostics.safeKillQuerySql(killId) : `KILL QUERY ${killId}`;
       await call(desktop.db.query({ ...activeQueryTarget(), sql, confirmed: true }));
     ```
     Biểu thức `activeQueryTarget()` được gọi **sau** khi người dùng bấm xác nhận. Nếu ngữ cảnh kết nối toàn cục (`app.connection`) bị thay đổi trong lúc hộp thoại xác nhận đang mở (do sự kiện bất đồng bộ như kết nối lại, IPC event, tác vụ nền, hoặc chuyển workspace), thì `activeQueryTarget()` sẽ trả về profileId của kết nối mới. Lệnh `KILL QUERY 101` (vốn thuộc Staging) sẽ bị gửi nhầm sang kết nối mới (ví dụ Production).
- **Bằng chứng kiểm chứng:**
  Ca test `B01.9` mở modal `showProcesslistModal()` thật, kích hoạt handler click trên `.kill-query-btn` đối với tiến trình #101 (nạp từ `staging-conn`). Trong lúc `confirmAction` đang ở trạng thái pending, kiểm tra đổi `app.connection` sang `production-conn`. Sau khi người dùng xác nhận, `desktop.db.query` nhận được lệnh `KILL QUERY 101` với `profileId: 'production-conn'`.

---

### 2.8 FINDING-B01-9: Giới hạn của Bộ lập lịch Sao lưu (Backup Scheduler)
- **Vị trí code:** `electron/backup-scheduler.cjs:17–42`.
- **Hiện trạng kiểm tra qua code thật:**
  Hàm `validateSchedule` kiểm tra nghiêm ngặt `Number.isInteger(value.intervalHours) && value.intervalHours >= 1 && value.intervalHours <= 168`. Khi lưu cấu hình:
  - Nếu gửi kèm các trường thời gian cố định theo lịch hoặc biểu thức cron (như `timeOfDay: '02:00'`, `cron: '0 2 * * *'`), hàm `validateSchedule` **không ném lỗi nhưng âm thầm loại bỏ (silently dropped/ignored)** các trường này, chỉ giữ lại các trường nằm trong danh sách whitelist (`intervalHours`, `nextRunAt`, `timeZone`,...).
  - Quá trình kích hoạt sao lưu chỉ dựa vào `intervalHours` cộng dồn vào `nextRunAt`, không hỗ trợ giờ cố định theo lịch (calendar-aligned 02:00 AM) hay cron.
  - Bộ lập lịch `BackupScheduler` hoàn toàn chạy bằng `setTimeout` trong bộ nhớ Node, nghĩa là khi người dùng đóng ứng dụng SqlPro thì lịch sao lưu không thể chạy.
- **Bằng chứng kiểm chứng:**
  Ca test `B01.10` gọi trực tiếp `createScheduleStore.save()` với dữ liệu chứa `timeOfDay: '02:00'` và `cron: '0 2 * * *'`. Kết quả lưu thành công nhưng đối tượng lưu trữ hoàn toàn không chứa các khóa `timeOfDay` hay `cron`. Khi gửi `intervalHours` sai kiểu (chuỗi) hoặc bằng 0 thì ném lỗi validation.

---

## 3. Đính Chính Phương Án Sửa Chữa (Correction of Remediation Strategy)

Để khắc phục các nhận định chưa chuẩn xác trong bản báo cáo trước, phương án sửa đổi được cập nhật như sau:

1. **Về việc khóa nút Apply và chuyển sang Editor (Sửa Finding B01-1, B01-2, B01-3):**
   - *Đính chính:* Không khẳng định việc chuyển script sang SQL Editor là "ngăn chặn hoàn toàn rủi ro FK leak và drift". SQL Editor chỉ là công cụ để DBA xem xét mã nguồn thủ công; nếu DBA chạy script trong Editor thì rủi ro mất an toàn FK vẫn tồn tại nếu có lỗi giữa chừng.
   - *Giải pháp triệt để tại Gói B02:*
     - Tạm thời vô hiệu hóa nút `#diffApplyTargetBtn` trên giao diện Renderer với cảnh báo rõ ràng.
     - Xây dựng **Schema Migration Service do Main Process sở hữu (`electron/schema-migration-service.cjs`)**:
       - Quản lý Migration Plan với token một lần và TTL ngắn.
       - Trước khi apply, Main Process tự động lấy lại fingerprint CSDL đích; nếu phát hiện drift so với lúc so sánh thì hủy bỏ ngay lập tức.
       - Việc điều khiển `FOREIGN_KEY_CHECKS` (nếu được người dùng cho phép) phải chạy trên một dedicated connection riêng biệt, lưu lại giá trị ban đầu và bắt buộc khôi phục trong khối `finally` của worker.
       - Chỉ mở lại nút Apply sau khi Service tại Main và các bài test bảo vệ đã hoàn tất.

2. **Về việc hoàn thiện Snapshot (Sửa Finding B01-4, B01-5):**
   - *Giải pháp tại Gói B02:*
     - Chuyển `captureFullSchema` từ renderer về service tại Main Process (`electron/schema-snapshot.cjs`).
     - Đọc metadata thật bằng `SHOW CREATE VIEW`, `SHOW CREATE PROCEDURE`, `SHOW CREATE FUNCTION`, `SHOW TRIGGERS`, `SHOW EVENTS` theo đúng engine capabilities (`MySQL` vs `MariaDB`).
     - Bổ sung logic so sánh Triggers và Events vào `SchemaDiff.compareSchemas`.
     - Phân định rõ ràng giữa đối tượng không tồn tại và đối tượng bị thiếu quyền truy cập (`status: 'unknown'`), không tự ý sinh lệnh DROP khi thiếu thông tin.

3. **Về việc nối Selective Restore (Sửa Finding B01-6):**
   - *Đính chính:* Ghi nhận rõ ràng trên tài liệu roadmap rằng tính năng Selective Object Restore (G3.1/G3.2) hiện chưa có giao diện người dùng và chưa được nối vào Executor.
   - *Giải pháp tại Gói B03:*
     - Thiết kế giao diện chọn đối tượng trong modal phục hồi.
     - Truyền `planId` do Main sở hữu vào `db:restore`.
     - Cập nhật `DatabaseSession.restoreDatabaseInternal` nhận danh sách câu lệnh từ plan và chỉ thực thi các câu lệnh thuộc các đối tượng được phê duyệt.

4. **Về việc sửa Diagnostics Target (Sửa Finding B01-8):**
   - *Đính chính:* Không đề xuất `p.profileId` vì `p` không có trường này.
   - *Giải pháp:* Tại thời điểm tải processlist (`loadProcesslist`), ghi lại ngữ cảnh kết nối hiện tại vào biến bao đóng `activeProcesslistTarget = { profileId: app.connection?.id, database: app.database, sessionId: ... }`. Khi người dùng bấm Kill, lệnh `KILL` bắt buộc gửi vào `activeProcesslistTarget` đã lưu, đồng thời kiểm tra lại xem kết nối đó có còn mở và khớp với ngữ cảnh ban đầu hay không.

5. **Về việc bảo vệ Privacy (Sửa Finding B01-7):**
   - *Giải pháp:* Bổ sung tùy chọn `persistSensitiveSql` (mặc định là false). Trong hàm `persistState()`, kiểm tra các câu lệnh qua `SqlSnippets.hasSensitiveSql()`; nếu phát hiện mật khẩu/secret và tùy chọn đang tắt, tự động áp dụng `SqlSnippets.scrubSensitiveSql()` trước khi gửi xuống `desktop.saveState()`.

---

## 4. Kết Luận Nghiệm Thu Bản Rà Soát B01

- Đã loại bỏ 100% các bài test tautology tự gán biến.
- Toàn bộ **10 bài kiểm thử** trong `test/risk-verification-b01.test.cjs` đều được phân định phương pháp kiểm chứng rõ ràng:
  - **B01.1 & B01.2:** Kích hoạt handler click thật trên `#diffApplyTargetBtn` và bắt callback thực tế của `app.js:3724` trong VM renderer.
  - **B01.3:** Kiểm tra mã nguồn handler Apply đối với fingerprint/drift checks.
  - **B01.4:** Trích xuất hàm `captureFullSchema` theo đúng phạm vi cú pháp và chạy với mock metadata fixture trong VM renderer.
  - **B01.5 & B01.6:** Chạy trực tiếp module `SchemaDiff.compareSchemas` và `generateMigrationSql`.
  - **B01.7:** Kiểm tra tính toàn vẹn của chuỗi UI → IPC → Plan → Executor trên `app.js`, `main.cjs`, `database.cjs` và `RestoreObjectInventory`.
  - **B01.8:** Kích hoạt trực tiếp hàm `persistState()` thật trong VM renderer.
  - **B01.9:** Kích hoạt handler click `.kill-query-btn` thật trong modal chẩn đoán, trì hoãn confirmation, đổi ngữ cảnh và bắt payload `desktop.db.query`.
  - **B01.10:** Gọi trực tiếp `createScheduleStore` với cấu hình chứa `timeOfDay`/`cron` và kiểm tra hành vi loại bỏ trường bổ sung.
- Tỷ lệ chạy kiểm thử:
  - `node --test test/risk-verification-b01.test.cjs`: **10 pass / 0 fail**.
  - `npm run check`: **984 tests | 970 pass | 0 fail | 14 opt-in skip**.
- Các phát hiện, giới hạn và rủi ro được chứng minh có căn cứ kỹ thuật chính xác, sẵn sàng làm cơ sở vững chắc cho việc triển khai **Gói B02 — Hoàn thiện Snapshot Schema & Migration Apply**.
