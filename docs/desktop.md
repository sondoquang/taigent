# Taigent Desktop

Ứng dụng desktop (Electron) cho Business Analyst / Product Owner: xem backlog mà agent viết trong
`taiga/<slug>/backlog.yaml` đúng như `taigent apply` sẽ ghi lên Taiga, góp ý và duyệt từng epic/story/task, rồi tự
đẩy lên Taiga khi đã ổn. Đây là bước **review** của quy trình plan → review → apply
([conventions §1](taiga/conventions.md)).

Ứng dụng không tự gọi API Taiga. Mọi thứ đi qua lõi và CLI của taigent:

- **xem trước, duyệt, góp ý**: `buildPreview`, `setVerdict`, `addComment`, `saveReview` trong `dist/review.js`.
  Không cần mạng, không cần đăng nhập. Kết quả ghi vào `taiga/<slug>/review.yaml`
  ([docs/cli.md § Review](cli.md#review));
- **đăng nhập / đăng xuất**: `storeLogin` / `removeLogin` (`dist/login.js`), dùng chung kho thông tin đăng nhập với
  `taigent login`;
- **trạng thái đăng nhập, xem thay đổi, đẩy lên Taiga**: chạy CLI `bin/taigent.js` (`whoami --json`,
  `plan --project <slug> --json`, `apply --project <slug> --yes --json`) bằng chính file thực thi của ứng dụng ở chế độ
  Node (`ELECTRON_RUN_AS_NODE=1`), thư mục làm việc là repo đang mở, không qua shell.

## Cài đặt

**Bản đóng gói (Windows):** chạy `Taigent-Desktop-Setup-<version>.exe` (xem [Đóng gói](#đóng-gói)). Bộ cài chưa ký
nên Windows SmartScreen có thể cảnh báo: chọn *More info* → *Run anyway*. Ứng dụng đã kèm sẵn taigent (CLI, lõi,
`yaml`, `@napi-rs/keyring`), không cần cài Node.

**Chạy từ mã nguồn** (cần Node.js 24+):

```sh
npm install && npm run build      # ở thư mục gốc taigent: tạo dist/ mà ứng dụng dùng
cd desktop
npm install
npm start                         # build rồi mở ứng dụng
```

Lần chạy đầu `npm start` có thể tự tải Electron nếu `npm install` chưa tải. Khi chạy từ mã nguồn, ứng dụng dùng
taigent của chính repo này: lõi từ `dist/` (sửa `src/` thì chạy lại `npm run build` ở thư mục gốc), CLI từ
`bin/taigent.js`.

## Mở repo và chọn dự án

1. Bấm **Mở thư mục repo…** và chọn thư mục gốc của repo có `taiga/<slug>/backlog.yaml` (repo mà agent đang sửa trên
   máy của bạn). Lần sau ứng dụng tự mở lại thư mục này.
2. Chọn **Dự án**. Danh sách gồm mọi thư mục con của `taiga/` có `backlog.yaml`. Repo chỉ có một dự án thì dự án đó
   được mở luôn. Thư mục manifest theo `TAIGENT_MANIFESTS_DIR` (biến môi trường, rồi tới `.env` của repo), mặc định
   `taiga`, giống CLI.

Ứng dụng theo dõi thư mục `taiga/<slug>/`. Khi agent sửa `backlog.yaml` hoặc trả lời góp ý trong `review.yaml`, màn
hình tự cập nhật, không cần mở lại.

## Màn hình

- **Thanh tổng quan**: số epic/story/task; *Mới* (chưa có trên Taiga) và *Đã đẩy*; *Đạt*, *Cần sửa*, *Chưa duyệt*,
  *Đã đổi sau khi duyệt*; số góp ý chưa xử lý; kết quả `taigent validate` (bấm *Manifest lỗi* để xem từng lỗi).
- **Cây bên trái**: epic → story → task. Mỗi mục có nhãn *Mới* hoặc *Đã đẩy #ref*, trạng thái duyệt và số góp ý mở.
  Bộ lọc: *Tất cả*, *Chưa duyệt*, *Cần sửa*, *Đã đổi*. Khi lọc, epic/story cha vẫn hiện (mờ) để bạn biết mục nằm ở
  đâu.
- **Chi tiết bên phải**: tiêu đề, mô tả hiển thị dạng Markdown, đúng nội dung ghi lên Taiga (với story, mô tả đã gồm
  tiêu chí chấp nhận dạng checklist `- [ ]` và link spec, nên không lặp lại thành mục riêng), task/story con, tag,
  custom attribute và chuỗi góp ý.
- **Phím tắt**: `j`/`k` hoặc `↓`/`↑` để chuyển mục; `Ctrl+Enter` trong ô góp ý để gửi.

## Duyệt và góp ý

1. Đọc từng mục. Ổn thì bấm **Đạt**. Cần sửa thì viết góp ý rồi bấm **Gửi góp ý** và **Cần sửa**. **Bỏ đánh giá**
   xoá verdict. Tên người duyệt là username của lần đăng nhập Taiga đã lưu, nếu chưa đăng nhập thì là tên tài khoản
   hệ điều hành.
2. Nhờ agent xử lý góp ý (skill `taiga-plan-backlog`). Agent sửa manifest, rồi đánh dấu góp ý *Đã xử lý* và trả lời
   ngắn. Câu trả lời hiện dưới góp ý (*Agent trả lời*). Agent không đổi verdict của bạn.
3. Mục đã **Đạt** mà agent sửa sau đó (nội dung ghi lên Taiga khác lúc bạn duyệt) sẽ chuyển sang
   **Đã đổi sau khi duyệt** và không còn tính là *Đạt*. Hãy xem lại rồi bấm **Đạt** lần nữa.
4. Commit `taiga/<slug>/review.yaml` cùng manifest để cả team thấy kết quả review.

## Đăng nhập Taiga

Bấm **Đăng nhập**, nhập URL API (ví dụ `https://taiga.example.com/api/v1`; chỉ nhập `https://host` thì ứng dụng tự
thêm `/api/v1`), tên đăng nhập hoặc email và mật khẩu. Ứng dụng làm giống `taigent login`:

- mật khẩu được gửi tới Taiga đúng một lần để lấy cặp access/refresh token. Mật khẩu không được lưu, không ghi log
  và không đi qua CLI;
- token được cất trong kho thông tin đăng nhập của hệ điều hành (Windows Credential Manager, macOS Keychain), còn
  `login.json` (không chứa bí mật) nằm trong thư mục cấu hình của taigent. Vì vậy `npx taigent` trong terminal và
  agent cũng dùng được lần đăng nhập này, và ngược lại;
- refresh token hết hạn nếu không dùng trong 8 ngày (mặc định của Taiga). Khi đó hãy đăng nhập lại.

Bấm tên người dùng → **Đăng xuất** để xoá đăng nhập (`removeLogin`, giống `taigent logout`). Thanh trạng thái hiện
kết quả `taigent whoami`. Nếu repo đặt `TAIGA_USERNAME`/`TAIGA_PASSWORD` hoặc `TAIGA_TOKEN` (biến môi trường hoặc
`.env`) thì CLI ưu tiên các biến đó.

## Xem thay đổi và đẩy lên Taiga

- **Xem thay đổi trên Taiga** chạy `taigent plan --project <slug> --json`: chỉ đọc Taiga, không ghi gì. Kết quả liệt
  kê các mục sẽ được tạo mới, cập nhật (kèm trường thay đổi) hoặc gắn vào epic, và các mục trên Taiga không còn trong
  backlog (taigent không bao giờ xoá chúng).
- **Đẩy lên Taiga** bị chặn khi `taigent validate` báo lỗi hoặc còn mục **Cần sửa** có góp ý chưa xử lý. Nếu không
  bị chặn, ứng dụng chạy `plan` trước. Không có thay đổi thì dừng ở đó. Có thay đổi thì ứng dụng mở hộp thoại xác nhận
  liệt kê số mục tạo mới/cập nhật/gắn epic, số mục chưa duyệt và số mục đã đổi sau khi duyệt. **Bấm "Đẩy lên Taiga"
  trong hộp thoại này chính là đồng ý apply** (conventions §1). Chỉ sau đó ứng dụng mới chạy
  `taigent apply --project <slug> --yes --json` và hiện báo cáo. Nếu apply lỗi giữa chừng, các mục đã ghi được lưu
  trong `state.json`, lần chạy sau sẽ tiếp tục từ chỗ dừng.

Verdict *Đạt* không thay cho bước đồng ý này: `plan`/`apply` không đọc `review.yaml`.

## Đóng gói

```sh
npm run build            # ở thư mục gốc taigent
cd desktop
npm run dist             # build + scripts/stage-taigent.mjs + electron-builder
```

- Windows: `desktop/release/Taigent-Desktop-Setup-<version>.exe` (NSIS, x64, cài cho người dùng hiện tại, chọn được
  thư mục cài), thư mục chạy thử `desktop/release/win-unpacked/`.
- macOS: cấu hình `dmg` có sẵn trong `desktop/package.json`. Phải chạy `npm run dist` trên máy Mac để
  `@napi-rs/keyring` có bản prebuilt cho macOS.

`scripts/stage-taigent.mjs` chép `bin/`, `dist/`, `package.json` của taigent và các dependency lúc chạy (`yaml`,
`@napi-rs/keyring` kèm bản N-API prebuilt đã cài) vào `desktop/stage/`. electron-builder đặt chúng vào
`resources/taigent/node_modules/taigent`, nên CLI chạy bằng file thực thi của ứng dụng, không cần Node trên máy.
`taiga-mcp-server` không được đóng gói vì nó chỉ phục vụ `taigent mcp`, lệnh mà ứng dụng không dùng.

### Ký số (người làm)

Bộ cài chưa được ký. Việc ký cần chứng chỉ và tài khoản của tổ chức, agent không làm được:

- **Windows**: mua chứng chỉ code signing (OV/EV, hoặc dùng Azure Trusted Signing). Đặt `CSC_LINK` (file `.pfx` hoặc
  base64) và `CSC_KEY_PASSWORD` (hoặc cấu hình `win.azureSignOptions`) trong môi trường build/CI, rồi chạy lại
  `npm run dist`.
- **macOS**: cần Apple Developer ID Application certificate (`CSC_LINK`/`CSC_KEY_PASSWORD`) và notarize
  (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, cùng `mac.notarize: true`). Bản dmg chưa ký sẽ bị
  Gatekeeper chặn.

Không commit chứng chỉ hay mật khẩu. Hãy để chúng trong secret của CI.

## Kiểm thử nhanh (smoke)

```sh
cd desktop
npm run smoke                                         # bản chạy từ mã nguồn (cần npm run build trước)
node scripts/smoke.mjs --exe "release/win-unpacked/Taigent Desktop.exe"   # bản đóng gói
```

Script chép `taiga/internal-taigent` sang thư mục tạm, trỏ ứng dụng vào đó bằng `TAIGENT_MANIFESTS_DIR` và dùng
user-data tạm, nên không đụng tới file của bạn. Script lần lượt: mở repo, chụp cây và chi tiết story, góp ý, đặt
*Cần sửa*, kiểm tra `review.yaml`, kiểm tra nút đẩy bị chặn, đặt *Đạt*, sửa mô tả rồi chờ trạng thái *Đã đổi sau khi
duyệt*, thử phím `j`/`k`. Nếu đã đăng nhập, script chạy thêm *Xem thay đổi trên Taiga* (chỉ đọc). Hộp thoại xác nhận
đẩy luôn được trả lời *Huỷ*. Ảnh chụp lưu ở `tmp/desktop-smoke/`.

## Bảo mật

- Cửa sổ chạy với `contextIsolation`, `sandbox`, không có `nodeIntegration`, CSP chặt (không script inline, không tải
  tài nguyên mạng) và chặn mọi điều hướng hay cửa sổ mới. Link trong mô tả mở bằng trình duyệt hệ thống (chỉ http/https).
- Markdown trong mô tả do agent viết được làm sạch bằng DOMPurify trước khi hiển thị.
- Renderer chỉ dùng được API có kiểu trong `desktop/src/shared/api.ts`, qua preload. Nó không đọc file và không gọi
  mạng.
