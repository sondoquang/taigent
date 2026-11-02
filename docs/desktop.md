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

Bố cục gồm bốn phần, từ trên xuống:

- **Thanh trên cùng**: mở thư mục repo, chọn **Dự án**, bật/tắt **Terminal**, đăng nhập/đăng xuất Taiga. Các phần này
  dùng chung cho mọi mục.
- **Thanh điều hướng bên trái** và màn hình của mục đang chọn:
  - **Backlog**: review backlog (xem bên dưới). Ứng dụng mở vào mục này.
  - **Wiki**, **Taiga** (Project, Ticket của tôi, Báo cáo), **Git**: chưa có nội dung. Mỗi mục chỉ hiện một trạng thái
    trống ghi rõ là chưa có và cách làm việc đó bằng CLI trong lúc chờ. Không có nút nào.
  - **Thay đổi**: xem thay đổi và đẩy lên Taiga (xem [Xem thay đổi và đẩy lên Taiga](#xem-thay-đổi-và-đẩy-lên-taiga)).
  - **Settings**: phiên bản của ứng dụng, taigent, Electron và Node. Chưa có thiết lập nào.

  Chuyển qua lại giữa các mục không đổi dự án đang mở, mục đang chọn trong cây, bộ lọc và góp ý đang viết dở.
- **Panel dưới đáy**: terminal (xem [Terminal](#terminal)), ẩn mặc định.
- **Thanh trạng thái**: người duyệt và kết quả `taigent whoami`.

Mục **Backlog** gồm:

- **Thanh tổng quan**: số epic/story/task; *Mới* (chưa có trên Taiga) và *Đã đẩy*; *Đạt*, *Cần sửa*, *Chưa duyệt*,
  *Đã đổi sau khi duyệt*; số góp ý chưa xử lý; kết quả `taigent validate` (bấm *Manifest lỗi* để xem từng lỗi).
- **Cây bên trái**: epic → story → task. Mỗi mục có nhãn *Mới* hoặc *Đã đẩy #ref*, trạng thái duyệt và số góp ý mở.
  Bộ lọc: *Tất cả*, *Chưa duyệt*, *Cần sửa*, *Đã đổi*. Khi lọc, epic/story cha vẫn hiện (mờ) để bạn biết mục nằm ở
  đâu.
- **Chi tiết bên phải**: tiêu đề, mô tả hiển thị dạng Markdown, đúng nội dung ghi lên Taiga (với story, mô tả đã gồm
  tiêu chí chấp nhận dạng checklist `- [ ]` và link spec, nên không lặp lại thành mục riêng), task/story con, tag,
  custom attribute và chuỗi góp ý.
- **Phím tắt**: `j`/`k` hoặc `↓`/`↑` để chuyển mục (chỉ khi đang ở mục Backlog); `Ctrl+Enter` trong ô góp ý để gửi.

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

Cả hai thao tác nằm ở mục **Thay đổi**. Mục này tóm tắt dự án đang mở (số mục mới, đã đẩy, trạng thái duyệt, manifest
hợp lệ hay không) và hiện kết quả của lần chạy gần nhất ngay trong màn hình. Kết quả bị xoá khi đổi dự án hoặc mở repo
khác.

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

## Terminal

Panel terminal nằm dưới đáy cửa sổ, **ẩn mặc định**. Bật hoặc tắt bằng nút **Terminal** trên thanh trên cùng hoặc
`` Ctrl+` `` (phím tắt vẫn chạy khi con trỏ đang ở trong terminal). Nút **Ẩn** cũng tắt panel. Ẩn panel không dừng
process nào: các tab vẫn chạy và hiện lại nguyên vẹn khi bật panel. Kéo mép trên của panel để đổi chiều cao, terminal
tự đổi số cột và số dòng theo panel và báo cho process.

- **+ Shell** mở một tab shell mới: `pwsh` nếu có trên `PATH`, nếu không thì Windows PowerShell (`powershell.exe`).
  Trên macOS là `$SHELL`. Trên Windows, shell chuyển console sang UTF-8 trước khi chạy, nên output tiếng Việt của
  các chương trình khác (git, agent) cũng hiện đúng.
- **Mở nhanh** `claude`, `codex`, `omp` mở một tab mới chạy agent đó trong shell. Agent chưa cài thì tab hiện lỗi
  của shell và vẫn giữ shell để bạn gõ tiếp. Ứng dụng không cài, không đăng nhập agent giúp bạn.
- Mọi tab chạy ở **thư mục repo đang mở**. Chưa mở repo thì không mở được tab. Môi trường của tab kế thừa từ ứng
  dụng; ứng dụng chỉ thêm `COLORTERM=truecolor` (và `TERM=xterm-256color` ngoài Windows), không thêm thông tin đăng
  nhập hay bí mật nào.
- Có nhiều tab cùng lúc. Bấm tên tab để chuyển. Khi process trong tab kết thúc, tab ghi mã thoát và giữ nguyên nội
  dung cho tới khi bạn đóng.
- **Đóng tab (×) thì kill cả cây process** của tab: shell, agent và mọi process con của chúng (`taskkill /T /F` trên
  Windows, cả process group trên macOS). **Thoát ứng dụng thì kill mọi cây process** của mọi tab trước khi thoát.
- Tab **skill** do ứng dụng mở (chạy một lệnh cho trước, ví dụ một lần chạy skill headless) có thêm nút **Huỷ**: kill
  cả cây process nhưng giữ tab để bạn đọc output.

Đăng nhập Taiga trong ứng dụng bằng hộp thoại **Đăng nhập**, không gõ mật khẩu vào tab terminal. Lần đăng nhập đó
dùng chung với `npx taigent` và agent chạy trong terminal.

Cho các ticket sau (nút skill headless, panel git): main process mở tab qua `terminals.open(...)` trong
`desktop/src/main/terminal.ts`. `{ kind: 'shell', cwd }` mở một shell; `{ kind: 'skill', cwd, title, command: { file,
args, env? } }` chạy thẳng lệnh đó trong pty (không qua shell). Kết quả có `tab`, `cancel()` (kill cả cây process),
`exited` (Promise `{ exitCode, signal?, cancelled }`) và `onData(listener)`. Renderer tự hiện panel và chọn tab mới.

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

`scripts/stage-taigent.mjs` chép vào `desktop/stage/` đúng những gì gói npm của taigent mang theo: `package.json`,
`LICENSE` và mọi file trong danh sách `files` (`bin/`, `dist/`, tài liệu mà skill trích dẫn, cùng những thứ
`taigent init` cài vào repo: các skill Taigent, `tools/taiga/` có `run-skill` và allowlist, guard shell và execpolicy
rule của Codex), kèm các dependency lúc chạy (`yaml`, `smol-toml`, `@napi-rs/keyring` kèm bản N-API prebuilt đã cài).
electron-builder đặt chúng vào
`resources/taigent/node_modules/taigent`, nên CLI chạy bằng file thực thi của ứng dụng, không cần Node trên máy.
`taiga-mcp-server` không được đóng gói vì nó chỉ phục vụ `taigent mcp`, lệnh mà ứng dụng không dùng.

Terminal dùng `node-pty` (dependency của `desktop/`, ghim `1.1.0`). Bản này là module N-API kèm sẵn bản prebuilt cho
Windows x64/arm64 và macOS (`prebuilds/`), nên cùng một file `pty.node` chạy được với mọi bản Electron mà không phải
rebuild, và máy build hay máy người dùng đều không cần Visual Studio/Python. Vì vậy `npmRebuild` tắt trong cấu hình
electron-builder: rebuild bằng node-gyp sẽ tạo `build/Release/pty.node`, được ưu tiên hơn bản prebuilt và đòi build
tool. `node-pty` được giải nén khỏi `app.asar` (`asarUnpack`) vì Windows cần chạy file thật (`conpty.node`, worker
đọc output, `winpty-agent.exe`); main process nạp nó từ `resources/app.asar.unpacked/node_modules/node-pty`. Bộ cài
Windows chỉ kèm bản prebuilt của Windows, bỏ mã nguồn C++ và file `.pdb`. Smoke chạy trên bản đóng gói kiểm tra
chính việc nạp module này.

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
npm run build            # ở thư mục gốc taigent
cd desktop
npm install
npm run smoke                                                             # bản chạy từ mã nguồn (tự build desktop trước)
node scripts/smoke.mjs --exe "release/win-unpacked/Taigent Desktop.exe"   # bản đóng gói (sau npm run dist)
```

Cả hai cách dùng cùng fixture có trong repo: `desktop/scripts/fixture/smoke-taigent-desktop/` (project
`Smoke - Taigent Desktop`: 3 epic, 5 story theo user story format, 1 story legacy đã có trên Taiga theo `state.json`,
5 task). Đây không phải project thật trên Taiga, nên không bootstrap hay apply nó. Muốn smoke trên manifest của mình
thì truyền `--project <slug> --story <key>` (chép `taiga/<slug>`).

Script chép fixture sang thư mục tạm, trỏ ứng dụng vào đó bằng `TAIGENT_MANIFESTS_DIR` và dùng user-data tạm, nên
không đụng tới file của bạn. Script lần lượt: kiểm tra thanh điều hướng và ứng dụng mở vào mục Backlog, mở repo, chụp
cây và chi tiết story `REVIEW-COMMENT`, góp ý, đặt *Cần sửa*, kiểm tra `review.yaml`, sang mục Thay đổi kiểm tra nút
đẩy bị chặn, đi qua Wiki, Taiga, Git, Settings (mỗi mục chỉ có trạng thái trống, không có nút; phím `j` không đổi
mục đang chọn), quay về Backlog kiểm tra dự án và story vẫn được chọn, đặt *Đạt*, sửa mô tả rồi chờ trạng thái *Đã
đổi sau khi duyệt*, thử phím `j`/`k`. Nếu đã đăng nhập, script chạy thêm *Xem thay đổi trên Taiga* trong mục Thay đổi
(chỉ đọc; với fixture, Taiga báo không có project `smoke-taigent-desktop`). Hộp thoại xác nhận đẩy luôn được trả lời
*Huỷ*. Ảnh chụp lưu ở `tmp/desktop-smoke/`.

Phần terminal (`scripts/smoke-terminal.mjs`): panel ẩn lúc mở, bật/tắt bằng `` Ctrl+` `` và nút; mở tab shell, gõ
lệnh và thấy output, in tiếng Việt, in chữ đỏ bằng mã ANSI, kéo panel cao lên rồi kiểm tra shell thấy đúng số cột và
dòng mới; chạy một process con (`ping`), đóng tab rồi kiểm tra shell và process con đã dừng. Ứng dụng được mở với
`PATH` có một `claude` giả (in thư mục làm việc) đứng đầu và không có thư mục nào chứa `omp`: nút mở nhanh `claude`
phải chạy ở thư mục repo, còn `omp` phải hiện lỗi của shell mà tab và ứng dụng vẫn chạy. Cuối cùng script để một
shell chạy `ping`, thoát ứng dụng và kiểm tra mọi process con của ứng dụng đã dừng.

## Bảo mật

- Cửa sổ chạy với `contextIsolation`, `sandbox`, không có `nodeIntegration`, CSP chặt (chỉ script của ứng dụng, không
  script inline, không tải tài nguyên mạng) và chặn mọi điều hướng hay cửa sổ mới. Link trong mô tả mở bằng trình
  duyệt hệ thống (chỉ http/https).
- CSP cho phép style inline (`style-src 'self' 'unsafe-inline'`) vì xterm.js tô màu và đặt kích thước dòng bằng thẻ
  `<style>` và thuộc tính `style`. Nội dung do agent viết không dùng được quyền này: DOMPurify bỏ mọi thẻ `<style>` và
  thuộc tính `style` trong Markdown, và script vẫn chỉ được nạp từ ứng dụng.
- Markdown trong mô tả do agent viết được làm sạch bằng DOMPurify trước khi hiển thị.
- Renderer chỉ dùng được API có kiểu trong `desktop/src/shared/api.ts`, qua preload. Nó không đọc file và không gọi
  mạng.
- **Terminal không phải ranh giới bảo mật.** Shell và agent trong terminal chạy với đúng quyền của bạn, như một
  terminal bình thường: chúng đọc, sửa file và gọi mạng được, và `npx taigent apply --yes` gõ trong terminal sẽ ghi
  lên Taiga. Ứng dụng chỉ chặn việc ghi ở các nút của chính nó (CLI + hộp thoại xác nhận).
- Renderer chỉ mở được tab **shell** hoặc **agent** (`claude`, `codex`, `omp`), luôn ở thư mục repo đang mở. Nó không
  chọn được lệnh, tham số, thư mục hay biến môi trường. Tab chạy lệnh cho trước (kind `skill`) chỉ main process mở.
  Main process chỉ nhận các kênh terminal từ chính trang của ứng dụng (`app://taigent`), và kiểm tra kiểu từng tham
  số.
- Nội dung do agent viết (Markdown, output trong terminal) không điều khiển được shell: Markdown đã được làm sạch và
  không có script; output của terminal chỉ được xterm.js vẽ ra, không bao giờ được chạy hay chèn vào DOM dạng HTML.
- Môi trường của tab kế thừa từ ứng dụng, không thêm token hay mật khẩu. Mật khẩu Taiga chỉ nhập trong hộp thoại
  đăng nhập, không đi qua terminal hay log.
- Đóng tab hoặc thoát ứng dụng kill cả cây process, nên không còn agent nào chạy ngầm sau khi bạn đóng.
