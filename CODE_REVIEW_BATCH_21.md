# Báo cáo Kiểm tra Code & Kiến trúc - Đợt 21 (Batch 21)
## Selective Object Restore & Dependency Graph Ordering (G3.1, G3.2)

### 1. Mục tiêu & Phạm vi
- Triển khai mốc **G3.1** và **G3.2** trong lộ trình [DATABASE_PRODUCT_ROADMAP.md](DATABASE_PRODUCT_ROADMAP.md):
  - **G3.1**: Phân tích kho đối tượng toàn diện theo bảng (table), khung nhìn (view), thủ tục lưu (procedure), hàm (function), bộ kích hoạt (trigger), sự kiện định kỳ (event); hỗ trợ lựa chọn cấu trúc/dữ liệu; xây dựng đồ thị phụ thuộc (dependency graph), xử lý xung đột, thứ tự phục hồi và cảnh báo SQL động (`PREPARE`/`EXECUTE`).
  - **G3.2**: Sinh kế hoạch thực thi phục hồi bất biến (immutable execution plan) gắn với mã băm SHA-256 của tệp sao lưu và định danh cơ sở dữ liệu đích; preflight kiểm tra tính toàn vẹn phụ thuộc trước khi thực thi; kiểm thử độc lập cho chu trình phụ thuộc vòng (circular dependency) và phụ thuộc đa tầng.
- Đồng bộ hóa trạng thái nghiệm thu của các mốc đã hoàn thành: G2.1–G2.5, G3.3, G3.4 trong [DATABASE_PRODUCT_ROADMAP.md](DATABASE_PRODUCT_ROADMAP.md).

---

### 2. Thiết kế Kiến trúc & Design Patterns

```
                                  +------------------------------------+
                                  |     RestoreObjectInventory         |
                                  |   (Phân tích tệp dump SQL)         |
                                  +-----------------+------------------+
                                                    |
                                                    v
                                  +------------------------------------+
                                  |     RestoreDependencyGraph         |
                                  |   (Mô hình DAG & Phân lớp thứ tự)  |
                                  +-----------------+------------------+
                                                    |
         +------------------------------------------+------------------------------------------+
         |                                          |                                          |
         v                                          v                                          v
+------------------+                       +------------------+                       +------------------+
|  Topological     |                       |  Cycle Detection |                       | Selection        |
|  Restore Order   |                       |  (DFS Stack)     |                       | Validator        |
|  1. Tables (FK)  |                       |  Phát hiện FK    |                       | Phát hiện        |
|  2. Functions    |                       |  vòng A <-> B    |                       | thiếu phụ thuộc  |
|  3. Views        |                       +------------------+                       | (Missing Dep)    |
|  4. Procedures   |                                                                  +------------------+
|  5. Triggers     |
|  6. Events       |
+--------+---------+
         |
         v
+------------------------------------------------------+
|            Immutable Execution Plan                  |
|  - planId (SHA-256 của toàn bộ cấu hình & bước)      |
|  - fileChecksum (SHA-256 tệp sao lưu)                |
|  - targetIdentity                                    |
|  - canExecute gating (chặn khi có blockers)          |
|  - Object.freeze() bảo đảm bất biến                  |
+------------------------------------------------------+
```

#### 2.1. Module Đồ thị Phụ thuộc (`electron/restore-dependency-graph.cjs`)
- **Mô hình Directed Acyclic Graph (DAG)**:
  - Các nút (nodes) đại diện cho đối tượng: `{ id, type, name, schema, metadata }`.
  - Cung có hướng (edges): `from -> to` thể hiện `from` phụ thuộc vào `to` (nghĩa là `to` phải được tạo trước `from`).
- **Thuật toán sắp xếp Tô pô phân tầng (Layered Kahn's Algorithm)**:
  - Phân tầng ưu tiên đối tượng:
    1. Bảng (`table`): sắp xếp tô pô theo chuỗi khóa ngoại (FK parent tables tạo trước FK child tables).
    2. Hàm (`function`): tạo trước các thủ tục và khung nhìn gọi đến hàm.
    3. Khung nhìn (`view`): sắp xếp tô pô theo quan hệ view-bảng và view-view (khung nhìn cha tạo trước khung nhìn con).
    4. Thủ tục (`procedure`): sắp xếp theo các hàm/thủ tục gọi lồng nhau.
    5. Bộ kích hoạt (`trigger`): phụ thuộc vào bảng đích `ON table_name`.
    6. Sự kiện định kỳ (`event`): phụ thuộc vào thủ tục được gọi.
  - Sử dụng tiêu chí sắp xếp phụ theo bảng chữ cái (alphabetical tie-breaking) để đảm bảo kết quả hoàn toàn xác định (deterministic).
- **Phát hiện Chu trình Vòng (Cycle Detection via DFS)**:
  - Sử dụng thuật toán tìm kiếm theo chiều sâu (DFS) với ngăn xếp hồi quy (`inStack`) để phát hiện tất cả các chu trình phụ thuộc vòng (ví dụ: bảng A trỏ FK sang B và B trỏ FK sang A).
  - Trả về đường dẫn chu trình chi tiết để người dùng/hệ thống xử lý (`['table:a', 'table:b', 'table:a']`).
- **Thứ tự Hủy An toàn (Reverse Topological Drop Order)**:
  - Hàm `computeDropOrder()` tính toán thứ tự đảo ngược chính xác: xóa sự kiện -> bộ kích hoạt -> thủ tục -> khung nhìn -> hàm -> bảng con -> bảng cha.
- **Xác thực Lựa chọn (Selection Validation)**:
  - Kiểm tra xem mọi đối tượng được chọn có đầy đủ các đối tượng phụ thuộc hay không (`validateSelection`). Nếu thiếu, trả về danh sách `missingDependencies` chi tiết (đối tượng tiêu thụ và đối tượng phụ thuộc còn thiếu).

#### 2.2. Module Kho Đối tượng (`electron/restore-object-inventory.cjs`)
- **Trích xuất thông tin đối tượng từ câu lệnh SQL**:
  - `table`: đếm số câu CREATE, DROP, INSERT; trích xuất các ràng buộc khóa ngoại (FOREIGN KEY ... REFERENCES).
  - `view`: trích xuất các bảng/khung nhìn được tham chiếu trong mệnh đề `FROM`, `JOIN`, `STRAIGHT_JOIN` và danh sách phân cách bởi dấu phẩy thông qua `extractQueryReferences()`.
  - `procedure` / `function`: phát hiện SQL động qua `checkDynamicSql()` (`PREPARE`, `EXECUTE`, `EXECUTE IMMEDIATE`), các lời gọi thủ tục lồng nhau (`CALL ...`), và các bảng bị ghi dữ liệu (`INSERT`, `UPDATE`, `DELETE`).
  - `trigger`: trích xuất thời điểm (`BEFORE`/`AFTER`), sự kiện (`INSERT`/`UPDATE`/`DELETE`), và bảng đích (`ON table_name`) qua `parseTriggerDetails()`.
  - `event`: trích xuất lịch trình và các thủ tục được gọi.
- **Sinh Kế hoạch Thực thi Bất biến (Immutable Execution Plan Generator)**:
  - Hàm `generateExecutionPlan()`:
    - Ràng buộc chặt chẽ với mã băm SHA-256 của tệp và định danh cơ sở dữ liệu đích.
    - Phân tách từng câu lệnh trong dump thành các bước (steps) với quyết định rõ ràng: `candidate` (được đưa vào chạy) hoặc `excluded` (bị loại trừ kèm lý do cụ thể).
    - Cổng an toàn `canExecute`: chuyển thành `false` nếu phát hiện bất kỳ `blockers` nào (chu trình vòng, thiếu phụ thuộc chưa được giải quyết).
    - Khóa bất biến toàn bộ cấu trúc kế hoạch bằng `Object.freeze()`.
    - Tính toán `planId` bằng SHA-256 từ canonical digest của kế hoạch.

#### 2.3. Tích hợp Preload & IPC Main Process
- Bổ sung IPC API vào `electron/preload.cjs`:
  - `inspectRestoreObjects(payload)`: quét toàn bộ đối tượng trong bản sao lưu theo 6 nhóm.
  - `previewObjectRestorePlan(payload)`: thẩm định lựa chọn đối tượng và tạo kế hoạch thực thi bất biến.
- Triển khai bộ xử lý trong `electron/main.cjs` với streaming file reader, tính hash đồng thời qua SHA-256, không nạp toàn bộ tệp dump vào RAM.

---

### 3. Kết quả Kiểm thử & Đo lường

```
-------------------------------------------------------------------------------
Bộ kiểm thử                                         Kết quả        Trạng thái
-------------------------------------------------------------------------------
test/restore-dependency-graph.test.cjs               6/6 passed     Thành công
test/restore-object-inventory.test.cjs                6/6 passed     Thành công
Toàn bộ unit test suite (`npm run check`)           972 passed      Thành công
Renderer smoke test (`test/run-renderer-smoke.cjs`)   94/94 passed   Thành công
Website smoke test (`test/run-website-smoke.cjs`)    14/14 passed   Thành công
Server test suite (`npm --prefix server test`)       17/17 passed   Thành công
Kiểm tra định dạng & khoảng trắng (`git diff`)        0 errors       Sạch sẽ
-------------------------------------------------------------------------------
```

---

### 4. Cập nhật Lộ trình (Roadmap Synchronization)
- [x] **G2.1**: Hoàn thiện ghi chú, ghim, manifest, checksum SHA-256, phiên bản app/DB, tách bạch trạng thái ghi tệp, checksum, phục hồi thử.
- [x] **G2.2**: Quét SQL: taskId, tiến độ, hủy bỏ, giới hạn kết quả, cache theo profile/database/id & file identity.
- [x] **G2.3**: Phục hồi thử độc lập trong sandbox database do ứng dụng tạo và gắn marker nhận diện; preflight quyền, timeout, cleanup tự động và thu hồi sau sự cố qua trial journal.
- [x] **G2.4**: Đánh giá schema/đối tượng, số dòng theo mức tin cậy, rewrite schema an toàn bằng AST analyzer thay vì chuỗi toàn cục.
- [x] **G2.5**: Báo cáo phục hồi thử gắn hash tệp SHA-256, phiên bản server, không báo hoàn tác khi DDL đã thay đổi đích.
- [x] **G3.1**: Kho đối tượng bảng, khung nhìn, thủ tục, hàm, trigger, event; đồ thị phụ thuộc DAG, thứ tự tô pô FK/view/routine và cảnh báo SQL động.
- [x] **G3.2**: Kế hoạch thực thi bất biến gắn hash tệp và selection; preflight thứ tự tô pô, phát hiện phụ thuộc vòng có fixture riêng.
- [x] **G3.3**: Quản lý lịch sao lưu (Scheduler) theo múi giờ, xử lý phiên lỡ hẹn (missed run), retry an toàn với backoff.
- [x] **G3.4**: Quản lý vòng đời sao lưu (Retention) theo số lượng, tuổi tệp, dung lượng; bảo vệ bản ghim và bản mới nhất/đã kiểm chứng.
