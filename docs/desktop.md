# Taigent Desktop

Ứng dụng desktop (Electron) cho Business Analyst / Product Owner: xem backlog mà agent viết trong
`taiga/<slug>/backlog.yaml` đúng như `taigent apply` sẽ ghi lên Taiga, góp ý và duyệt từng epic/story/task, rồi tự
đẩy lên Taiga khi đã ổn. Đây là bước **review** của quy trình plan → review → apply
([conventions §1](taiga/conventions.md)).

Ứng dụng không tự gọi API Taiga. Mọi thứ đi qua lõi và CLI của taigent:

- **xem trước, duyệt, góp ý**: `buildPreview`, `setVerdict`, `addComment`, `saveReview` trong `dist/review.js`.
  Không cần mạng, không cần đăng nhập. Kết quả ghi vào `taiga/<slug>/review.yaml`
  ([docs/cli.md § Review](cli.md#review));
- **thêm, sửa, xoá epic, story và task bằng form**: `readManifestFile`, `readItem`, `saveItem`, `removeItem` trong
  `dist/edit.js` (API sửa manifest, [docs/cli.md § Code map](cli.md#code-map)). Chỉ sửa `backlog.yaml` trong repo, không
  cần mạng; muốn lên Taiga vẫn phải review rồi đẩy như mọi thay đổi khác. Bản xem trước của form story dùng mẫu story
  của lõi (`src/story-template.ts`, cùng hàm với `apply` và `taigent preview`);
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

- **Thanh trên cùng**: mở thư mục repo, chọn **Dự án**, đăng nhập/đăng xuất Taiga. Các phần này dùng chung cho mọi
  mục.
- **Thanh điều hướng bên trái** và màn hình của mục đang chọn:
  - **Backlog**: review backlog (xem bên dưới). Ứng dụng mở vào mục này.
  - **Wiki**, **Taiga** (Project, Ticket của tôi, Báo cáo), **Git**: chưa có nội dung. Mỗi mục chỉ hiện một trạng thái
    trống ghi rõ là chưa có và cách làm việc đó bằng CLI trong lúc chờ. Không có nút nào.
  - **Thay đổi**: xem thay đổi và đẩy lên Taiga (xem [Xem thay đổi và đẩy lên Taiga](#xem-thay-đổi-và-đẩy-lên-taiga)).
  - **Settings**: phiên bản của ứng dụng, taigent, Electron và Node. Chưa có thiết lập nào.

  Chuyển qua lại giữa các mục không đổi dự án đang mở, mục đang chọn trong cây, bộ lọc và góp ý đang viết dở.
- **Panel dưới đáy**: chỗ dành cho terminal. Panel chưa có và đang ẩn.
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

## Thêm, sửa, xoá epic, story và task

Form chỉ sửa `taiga/<slug>/backlog.yaml` trong repo. Không có gì được ghi lên Taiga cho tới khi bạn review rồi bấm
**Đẩy lên Taiga**.

- **+ Epic** (trên cây bên trái) mở form epic: tiêu đề, key, mô tả (Markdown), tag (cách nhau bằng dấu phẩy) và các
  custom attribute mà `project.yaml` khai báo cho epic (`custom_attributes.epic`), nhập theo đúng tên đó.
- Ở một epic, **+ Story** mở form story (xem [Form story](#form-story)).
- Ở một story, **+ Task** mở form task: story cha, tiêu đề, key, định nghĩa done, tag. Đổi story cha trong form là
  chuyển task sang story đó.
- Ở một epic, story hoặc task, **Sửa** mở lại form với nội dung hiện có.
- **Key** được gợi ý theo quy ước khi bạn gõ tiêu đề: epic là vài chữ đầu của tiêu đề (`SOAN-BACKLOG`), story là
  `<EPIC>-<việc>`, task là `<STORY>-<bước>`. Bạn sửa được key; trùng key có sẵn thì form báo ngay. Item đã có trên
  Taiga (`state.json`) bị khoá key, vì đổi key là tạo item mới và biến item cũ thành mồ côi.
- **Lưu** chạy cùng luật với `taigent validate`. Lỗi của chính item hiện ngay dưới ô sai (kèm rule, ví dụ
  `tag-prefix`); lỗi có sẵn ở item khác không chặn lưu. File được sửa tại chỗ: comment, thứ tự, cách viết của phần
  không đụng tới (dấu ngoặc kép, `[a, b]`, xuống dòng CRLF) giữ nguyên.
- Item mới luôn ở trạng thái *Chưa duyệt*. Sửa một item đã *Đạt* thì item thành *Đã đổi sau khi duyệt*, như khi agent
  sửa. Form không ghi `review.yaml`; chỉ khi đổi key hoặc xoá item, ứng dụng chuyển hoặc xoá mục review của key đó.
- **Đang mở form mà file bị đổi** (thường là agent vừa sửa): form báo ngay. Bấm Lưu thì việc lưu bị từ chối, không có
  gì được ghi, và hộp thoại cho xem phần `backlog.yaml` đã đổi (dòng thêm/bớt). **Áp lại thay đổi của tôi** ghi phần
  của bạn lên bản mới; **Huỷ** giữ nguyên bản của agent.
- **Xoá** một item hỏi xác nhận và liệt kê các mục con bị xoá theo (xoá story thì xoá cả task của nó). Nếu có mục đã
  có trên Taiga, hộp thoại cảnh báo chúng sẽ thành **mồ côi**: xoá khỏi manifest không xoá trên Taiga, và *Xem thay đổi
  trên Taiga* sẽ báo chúng là mồ côi để người quyết định.

### Form story

Form story có hai cột: bên trái là các ô, bên phải là **Xem trước**.

- **Thuộc epic**: đổi epic là chuyển story (kèm task) sang epic đó. Tiêu đề, key (gợi ý `<EPIC>-<việc>`).
- **User story**: ba ô *As a*, *I want to*, *so that*, đều bắt buộc.
- **Tiêu chí chấp nhận**: các scenario Gherkin. Mỗi scenario có tên, một hoặc nhiều *Given* (**+ Given**, nút `×`
  xoá một Given), đúng một *When* và một *Then*. **+ Scenario** thêm scenario; `↑`/`↓` đổi thứ tự (thứ tự trên Taiga
  là thứ tự này); **Xoá scenario** bỏ một scenario. Story luôn còn ít nhất một scenario và mỗi scenario ít nhất một
  Given; Given để trống không được lưu.
- **Mô tả thêm** (Markdown, tuỳ chọn), **Spec** (đường dẫn hoặc link, tuỳ chọn), tag và custom attribute mà
  `project.yaml` khai báo cho story (`custom_attributes.story`).
- **Xem trước** cập nhật theo từng phím gõ. Nội dung là đúng mô tả mà `apply` sẽ ghi lên Taiga, cũng là mô tả mà
  `taigent preview` in ra cho story đó: form chạy cùng mẫu story của lõi trên chính các giá trị sẽ lưu, rồi hiển thị
  bằng cùng renderer và cùng bộ làm sạch DOMPurify như màn hình review. Mở **Markdown** để xem chuỗi gốc.
- **Lưu** báo lỗi ngay tại ô hỏng, theo luật của `taigent validate`: ví dụ When để trống hiện `[required]` ngay dưới ô
  When của đúng scenario đó, thiếu *As a* hiện dưới ô *As a*.

Story mới luôn theo user story format (`use_case` + `scenarios`), vì `plan`/`apply` từ chối tạo story legacy.

**Story legacy** (`description` + `acceptance_criteria`, chỉ còn cho story đã có trên Taiga) mở ở chế độ legacy: ô mô
tả và danh sách tiêu chí chấp nhận (thêm, sửa, xoá). Lưu ở chế độ này không đổi format, nên diff chỉ chứa đúng thay
đổi của bạn. Muốn chuẩn hoá thì bấm **Chuyển sang user story format**: form chuyển sang chế độ user story, mỗi tiêu
chí cũ thành tên của một scenario để bạn điền Given/When/Then, rồi điền *As a / I want to / so that*. Chỉ khi bấm
**Lưu**, `acceptance_criteria` mới được thay bằng `use_case` + `scenarios`; *Xem thay đổi trên Taiga* (`plan`) khi đó
báo story được cập nhật `description`. Huỷ form thì story giữ nguyên legacy.

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
5 task; `project.yaml` khai báo custom attribute `Mục tiêu quý` cho epic). Đây không phải project thật trên Taiga, nên
không bootstrap hay apply nó. Muốn smoke trên manifest của mình thì truyền `--project <slug> --story <key>` (chép
`taiga/<slug>`); khi đó script bỏ qua phần form, vì phần này dùng các key của fixture.

Script chép fixture sang thư mục tạm, trỏ ứng dụng vào đó bằng `TAIGENT_MANIFESTS_DIR` và dùng user-data tạm, nên
không đụng tới file của bạn. Script lần lượt: kiểm tra thanh điều hướng và ứng dụng mở vào mục Backlog, mở repo, chụp
cây và chi tiết story `REVIEW-COMMENT`, góp ý, đặt *Cần sửa*, kiểm tra `review.yaml`, sang mục Thay đổi kiểm tra nút
đẩy bị chặn, đi qua Wiki, Taiga, Git, Settings (mỗi mục chỉ có trạng thái trống, không có nút; phím `j` không đổi
mục đang chọn), quay về Backlog kiểm tra dự án và story vẫn được chọn, đặt *Đạt*, sửa mô tả rồi chờ trạng thái *Đã
đổi sau khi duyệt*, thử phím `j`/`k`. Sau đó là phần form: tạo epic (key gợi ý, custom attribute) và task bằng form,
kiểm tra `backlog.yaml` (giữ comment, task nằm dưới đúng story) và trạng thái *Chưa duyệt*; kiểm tra key của epic đã
có trên Taiga bị khoá; mở form sửa task, giả lập agent sửa `backlog.yaml`, kiểm tra form báo file đổi, lưu bị từ chối
(file vẫn là bản của agent), hộp thoại conflict hiện thay đổi, rồi *Áp lại*; kiểm tra cảnh báo mồ côi khi xoá story
đã có trên Taiga (bấm *Huỷ*) và xoá task mới. Tiếp theo là form story: tạo story dưới epic `PUSH` có hai scenario (một
scenario có hai Given), thử thêm, chuyển lên và xoá một scenario, lưu khi một When còn trống để thấy lỗi `[required]`
ngay dưới ô đó (file không đổi), rồi lưu thật; kiểm tra `backlog.yaml` đúng schema (`use_case`, `scenarios`), chạy
`taigent validate` (exit 0), so bản xem trước của form với mô tả của story trong `taigent preview --json` (phải bằng
nhau) và với phần mô tả ở màn hình review (cùng HTML). Sau đó sửa story legacy `REVIEW-MARKDOWN` (vẫn là
`acceptance_criteria`), rồi bấm *Chuyển sang user story format*, điền Given/When/Then, lưu và kiểm tra lại `validate`
và `preview`. Nếu đã đăng nhập, script chạy thêm *Xem thay đổi trên Taiga* trong mục
Thay đổi (chỉ đọc; với fixture, Taiga báo không có project `smoke-taigent-desktop`). Hộp thoại xác nhận đẩy luôn được
trả lời *Huỷ*. Ảnh chụp lưu ở `tmp/desktop-smoke/`.

## Bảo mật

- Cửa sổ chạy với `contextIsolation`, `sandbox`, không có `nodeIntegration`, CSP chặt (không script inline, không tải
  tài nguyên mạng) và chặn mọi điều hướng hay cửa sổ mới. Link trong mô tả mở bằng trình duyệt hệ thống (chỉ http/https).
- Markdown trong mô tả do agent viết được làm sạch bằng DOMPurify trước khi hiển thị.
- Renderer chỉ dùng được API có kiểu trong `desktop/src/shared/api.ts`, qua preload. Nó không đọc file và không gọi
  mạng.
