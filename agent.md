# Quy ước phát triển SqlPro

Tài liệu này mô tả kiến trúc đang dùng và quy tắc cho thay đổi mới. Phạm vi gồm website giới thiệu, ứng dụng Electron và server đồng bộ. Không áp dụng một pattern chỉ để có tên pattern; ưu tiên ranh giới rõ, mã dễ kiểm thử và hành vi hiện có.

## Cấu trúc và design pattern đang áp dụng

| Phần | Pattern / cách tổ chức | Quy tắc sử dụng |
| --- | --- | --- |
| `website/` | Module khởi tạo bằng IIFE và các hàm `init...` độc lập | Mỗi hành vi DOM có hàm khởi tạo riêng; trạng thái ngắn hạn nằm trong closure. `core.js` giữ logic thuần cho bộ cài, checksum, tìm kiếm và cấu hình tự host; `app.js` điều phối API/DOM. HTML song ngữ được sinh từ template chung trong `scripts/build-website.cjs` và nội dung `scripts/website-docs.cjs`, vẫn dùng được khi không có JavaScript. |
| `website/styles.css` | Design tokens và CSS theo component | Màu, font, bán kính, bóng dùng biến ở `:root`; style nằm trong nhóm component tương ứng; responsive ở các breakpoint hiện có. |
| `electron/main.cjs` + `electron/preload.cjs` + `app.js` | Phân lớp main / preload facade / renderer | Main sở hữu hệ điều hành, tệp, secret và database; preload chỉ công bố API IPC có tên rõ; renderer chỉ giữ trạng thái và vẽ UI. |
| `electron/database.cjs` | Session object cho kết nối database | `DatabaseSession` giữ vòng đời kết nối, timeout và hủy; thao tác SQL đi qua session thay vì kết nối trực tiếp từ renderer. |
| `electron/session-registry.cjs` | Resource registry, single-flight và lease | Factory tạo phiên được inject; gộp mở cùng profile, admission tuần tự, bảo vệ phiên bận/transaction và vô hiệu hóa kết quả mở cũ bằng generation. Explicit disconnect được phép đóng phiên; LRU chỉ đóng phiên rảnh. |
| `electron/table-data.cjs` | Application service và chính sách phân trang | Tách SQL plan/count cache khỏi IPC. Dùng keyset khi thứ tự PK cho phép, OFFSET làm fallback; COUNT chỉ theo yêu cầu và cache có TTL/invalidation. |
| `electron/result-budget.cjs` + `query-results.js` | Value object và logic trình bày thuần | Giới hạn row/byte SQL result; giữ origIndex trước sort, không tìm index từng dòng. Query bị giới hạn dùng control connection gửi KILL QUERY; không phá phiên SQL chỉ để cắt kết quả hiển thị. |
| `server/src/async-gate.cjs` | Semaphore với hàng đợi hữu hạn | Scrypt chạy bất đồng bộ, giữ nguyên KDF; giới hạn công việc đồng thời/hàng đợi, trả AUTH_BUSY khi đầy. Không giảm độ khó hash để tăng tốc. |
| `electron/store.cjs` + `electron/store-schema.cjs` | Repository và normalization boundary | Đọc/ghi profile và workspace qua store; chuẩn hóa dữ liệu ở đầu vào, tách secret khỏi dữ liệu trả về renderer. |
| `electron/sql-script.cjs`, `sql-autocomplete.js`, `electron/sync-crypto.cjs` | Pure functions cho parser, gợi ý và biến đổi mã hóa | Giữ logic không phụ thuộc DOM/IPC khi có thể để kiểm thử bằng Node. |
| `row-values.js` + editor trong `app.js` | Metadata strategy và editor dùng chung | Chọn điều khiển theo kiểu cột cho thêm/sửa dòng, ô bảng và kết quả SQL. Module thuần kiểm tra/chuẩn hóa giá trị, được dùng cả ở renderer và main. Giữ ngày giờ dạng chuỗi SQL, không đổi múi giờ; giữ nguyên BIGINT/DECIMAL và JSON chính xác. NULL/DEFAULT là trạng thái riêng, không suy từ chuỗi người dùng nhập. |
| `electron/sync.cjs` | Bộ điều phối trạng thái đồng bộ | Một nơi điều khiển đăng nhập, retry, revision và thông báo trạng thái; tránh tự tạo luồng sync trong renderer. |
| `server/src/app.cjs` | Application factory và dependency injection | `createApp({ db, config })` nhận phụ thuộc từ ngoài; route module nhận `db`, `config`, `limiter` để test không cần mở server thật. |
| `server/src/auth.cjs`, `server/src/vault.cjs`, `server/src/errors.cjs` | Route modules và lỗi có cấu trúc | Validate tại ranh giới HTTP; trả `{ error: { code, message } }` qua `ApiError`; xử lý lỗi tập trung trong `app.cjs`. |

## Quy tắc code

- JavaScript dùng 2 dấu cách, dấu nháy đơn, dấu `;`, `const` mặc định và `let` khi cần gán lại. CommonJS (`.cjs`) cho Node/Electron; website dùng JavaScript thuần, không thêm framework hoặc build step khi chưa có nhu cầu thật.
- Hàm đặt tên theo hành động (`render...`, `load...`, `save...`, `init...`); hằng số dùng `UPPER_SNAKE_CASE`; class chỉ dùng khi có vòng đời hoặc trạng thái riêng như `DatabaseSession`.
- Tách phần thuần dữ liệu khỏi DOM, IPC, HTTP và filesystem. Không thêm logic nghiệp vụ vào callback sự kiện hoặc route dài khi có thể đặt trong hàm có tên rõ.
- Website: dùng phần tử HTML đúng ngữ nghĩa, giữ `aria-expanded`, trạng thái focus và thao tác bàn phím cho menu; dùng `textContent` cho chuỗi văn bản. Listener, timer và trạng thái của một tính năng ở cùng một hàm khởi tạo.
- CSS website: dùng biến `:root` trước khi lặp lại giá trị màu/kiểu chữ; đặt quy tắc ở nhóm component hiện hữu và kiểm tra màn hình nhỏ cùng `prefers-reduced-motion`. Tránh selector phụ thuộc sâu vào cấu trúc HTML nếu có thể dùng class rõ nghĩa.
- Renderer Electron: dữ liệu từ SQL, tệp hoặc server là không tin cậy. Escape trước khi chèn vào HTML; không đưa secret hoặc quyền truy cập Node vào renderer. Chỉ gọi API đã công bố qua `window.sqlProDesktop`.
- Main/server: xác thực và giới hạn dữ liệu ở biên; SQL value dùng placeholder, tên identifier dùng hàm quote riêng. Không log mật khẩu, token, private key, vault key hoặc plaintext vault.
- Với thay đổi có ảnh hưởng đến dữ liệu, auth, đồng bộ hoặc SQL, thêm test cho hành vi và lỗi biên. Với thay đổi UI, kiểm tra tương tác bàn phím và layout trong browser/Electron ở kích thước cửa sổ nhỏ.
- Không sửa hoặc format hàng loạt mã ngoài phạm vi công việc. Giữ trạng thái sửa đổi sẵn có trong workspace; không thay đổi API hoặc định dạng lưu trữ mà thiếu migration và test.

## Kiểm tra trước khi hoàn tất

```bash
npm run check
npm run test:renderer
npm run test:website
npm --prefix server run check
npm run server:test
git diff --check
```

Website nằm trong `website/` và được Express phục vụ trực tiếp. Khi sửa nội dung/layout HTML, sửa generator rồi chạy `npm run website:build`; commit cả sáu trang HTML đã sinh. Không cần build lúc chạy server. Kiểm tra menu, copy, tìm kiếm, song ngữ, tải bộ cài, changelog và generator tự host bằng `npm run test:website`. Ảnh trong `website/assets/screenshots/` được chụp từ renderer với dữ liệu demo bằng biến `SQLPRO_SCREENSHOT_DIR` khi chạy `npm run test:renderer`. `npm run pack:linux` và `npm run pack:windows` chỉ cần chạy khi thay đổi ảnh hưởng bản đóng gói hoặc cần tạo bộ cài.
