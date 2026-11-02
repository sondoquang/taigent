# Taigent Desktop

Ứng dụng desktop (Electron) cho Business Analyst / Product Owner: xem backlog mà agent viết trong
`taiga/<slug>/backlog.yaml` đúng như `taigent apply` sẽ ghi lên Taiga, góp ý và duyệt từng epic/story/task/issue, rồi tự
đẩy lên Taiga khi đã ổn. Đây là bước **review** của quy trình plan → review → apply
([conventions §1](taiga/conventions.md)).

Ứng dụng không tự gọi API Taiga. Mọi thứ đi qua lõi và CLI của taigent:

- **xem trước, duyệt, góp ý**: `buildPreview`, `setVerdict`, `addComment`, `saveReview` trong `dist/review.js`.
  Không cần mạng, không cần đăng nhập. Kết quả ghi vào `taiga/<slug>/review.yaml`
  ([docs/cli.md § Review](cli.md#review));
- **thêm, sửa, xoá epic, story, task và issue bằng form**: `readManifestFile`, `readItem`, `saveItem`, `removeItem` trong
  `dist/edit.js` (API sửa manifest, [docs/cli.md § Code map](cli.md#code-map)). Chỉ sửa `backlog.yaml` trong repo, không
  cần mạng; muốn lên Taiga vẫn phải review rồi đẩy như mọi thay đổi khác. Bản xem trước của form story dùng mẫu story
  của lõi (`src/story-template.ts`, cùng hàm với `apply` và `taigent preview`);
- **đăng nhập / đăng xuất**: `storeLogin` / `removeLogin` (`dist/login.js`), dùng chung kho thông tin đăng nhập với
  `taigent login`;
- **trạng thái đăng nhập, xem thay đổi, đẩy lên Taiga, project trên Taiga**: chạy CLI `bin/taigent.js` (`whoami --json`,
  `plan --project <slug> --json`, `apply --project <slug> --yes --json`, `projects --json`,
  `bootstrap --project <slug> --dry-run --json` rồi `--yes --json`) bằng chính file thực thi của ứng dụng ở chế độ
  Node (`ELECTRON_RUN_AS_NODE=1`), thư mục làm việc là repo đang mở, không qua shell;
- **form `project.yaml`**: `readProjectSettings` / `saveProjectSettings` trong `dist/project-settings.js`. Form chỉ ghi
  file trong repo, không ghi lên Taiga.

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
  - **Taiga**: mục **Project** (xem [Project trên Taiga](#project-trên-taiga)) và **Báo cáo** (xem
    [Báo cáo tiến độ](#báo-cáo-tiến-độ)). Ticket của tôi chưa có: màn hình ghi cách làm việc đó bằng CLI trong lúc chờ.
  - **Wiki**: chưa có nội dung. Mục này chỉ hiện một trạng thái trống ghi rõ là chưa có và cách làm việc đó bằng CLI
    trong lúc chờ. Không có nút nào.
  - **Git**: pull, commit và push thư mục manifest (xem [Git](#git)).
  - **Thay đổi**: xem thay đổi và đẩy lên Taiga (xem [Xem thay đổi và đẩy lên Taiga](#xem-thay-đổi-và-đẩy-lên-taiga)).
  - **Settings**: phiên bản của ứng dụng, taigent, Electron và Node. Chưa có thiết lập nào.

  Chuyển qua lại giữa các mục không đổi dự án đang mở, mục đang chọn trong cây, bộ lọc và góp ý đang viết dở.
- **Panel dưới đáy**: terminal (xem [Terminal](#terminal)), ẩn mặc định.
- **Thanh trạng thái**: người duyệt và kết quả `taigent whoami`.

Mục **Backlog** gồm:

- **Thanh tổng quan**: số epic/story/task/issue; *Mới* (chưa có trên Taiga) và *Đã đẩy*; *Đạt*, *Cần sửa*, *Chưa duyệt*,
  *Đã đổi sau khi duyệt*; số góp ý chưa xử lý; kết quả `taigent validate` (bấm *Manifest lỗi* để xem từng lỗi).
- **Cây bên trái**: epic → story → task, rồi nhóm **Issues** (các issue của `backlog.yaml`, không thuộc epic nào).
  Mỗi mục có nhãn *Mới* hoặc *Đã đẩy #ref*, trạng thái duyệt và số góp ý mở. Bộ lọc: *Tất cả*, *Chưa duyệt*,
  *Cần sửa*, *Đã đổi*. Khi lọc, epic/story cha vẫn hiện (mờ) để bạn biết mục nằm ở đâu.
- **Chi tiết bên phải**: tiêu đề, mô tả hiển thị dạng Markdown, đúng nội dung ghi lên Taiga (với story, mô tả đã gồm
  tiêu chí chấp nhận dạng checklist `- [ ]` và link spec, nên không lặp lại thành mục riêng), task/story con, với
  issue thì mục **Phân loại** (loại, mức độ, ưu tiên), tag, custom attribute và chuỗi góp ý. Issue được duyệt và góp
  ý như mọi mục khác; đổi loại, mức độ hay ưu tiên của một issue đã *Đạt* cũng làm nó thành *Đã đổi sau khi duyệt*.
- **Phím tắt**: `j`/`k` hoặc `↓`/`↑` để chuyển mục (chỉ khi đang ở mục Backlog); `Ctrl+Enter` trong ô góp ý để gửi.

## Duyệt và góp ý

1. Đọc từng mục. Ổn thì bấm **Đạt**. Cần sửa thì viết góp ý rồi bấm **Gửi góp ý** và **Cần sửa**. **Bỏ đánh giá**
   xoá verdict. Tên người duyệt là username của lần đăng nhập Taiga đã lưu, nếu chưa đăng nhập thì là tên tài khoản
   hệ điều hành.
2. Nhờ agent xử lý góp ý (skill `taiga-plan-backlog`). Agent sửa manifest, rồi đánh dấu góp ý *Đã xử lý* và trả lời
   ngắn. Câu trả lời hiện dưới góp ý (*Agent trả lời*). Agent không đổi verdict của bạn.
3. Mục đã **Đạt** mà agent sửa sau đó (nội dung ghi lên Taiga khác lúc bạn duyệt) sẽ chuyển sang
   **Đã đổi sau khi duyệt** và không còn tính là *Đạt*. Hãy xem lại rồi bấm **Đạt** lần nữa.
4. Commit `taiga/<slug>/review.yaml` cùng manifest (mục **Git**, xem [Git](#git)) để cả team thấy kết quả review.

## Thêm, sửa, xoá epic, story, task và issue

Form chỉ sửa `taiga/<slug>/backlog.yaml` trong repo. Không có gì được ghi lên Taiga cho tới khi bạn review rồi bấm
**Đẩy lên Taiga**.

- **+ Epic** (trên cây bên trái) mở form epic: tiêu đề, key, mô tả (Markdown), tag (cách nhau bằng dấu phẩy) và các
  custom attribute mà `project.yaml` khai báo cho epic (`custom_attributes.epic`), nhập theo đúng tên đó.
- Ở một epic, **+ Story** mở form story (xem [Form story](#form-story)).
- Ở một story, **+ Task** mở form task: story cha, tiêu đề, key, định nghĩa done, tag. Đổi story cha trong form là
  chuyển task sang story đó.
- Ở nhóm **Issues** của cây, **+ Issue** mở form issue (xem [Form issue](#form-issue)).
- Ở một epic, story, task hoặc issue, **Sửa** mở lại form với nội dung hiện có.
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

### Form issue

Form issue có hai cột: bên trái là các ô, bên phải là **Xem trước** (mô tả Markdown, cùng renderer và DOMPurify như
màn hình review). Các field theo [conventions §6.4](taiga/conventions.md#64-issue):

- Tiêu đề (triệu chứng, không phải cách sửa) và key (gợi ý từ tiêu đề; issue dùng chung không gian key với epic,
  story, task).
- **Mô tả**: issue mới được điền sẵn mẫu `## Steps to reproduce` / `## Expected` / `## Actual`. Với Question hay
  Enhancement, xoá các phần không hợp và viết một đoạn.
- **Loại (type)**, **Mức độ (severity)**, **Ưu tiên (priority)**: form đọc các giá trị của project bằng `taigent
  projects --project <slug> --json`. Khi đã đăng nhập và project có trên Taiga, ba ô thành dropdown theo đúng thứ tự
  trên Taiga (giá trị hiện có mà Taiga không định nghĩa vẫn được giữ, kèm nhãn *không có trên Taiga*). Khi chưa đăng
  nhập hoặc project chưa có trên Taiga, ba ô cho nhập tự do; *Xem thay đổi trên Taiga* (`plan`) kiểm tên với project
  (rule `issue-value`). Cả ba đều bắt buộc.
- Tag và custom attribute mà `project.yaml` khai báo cho issue (`custom_attributes.issue`).

Issue mới ở trạng thái *Chưa duyệt*, như mọi item tạo bằng form.

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

Cả hai thao tác nằm ở mục **Thay đổi**. Mục này tóm tắt dự án đang mở (số epic/story/task/issue, số mục mới, đã đẩy, trạng thái duyệt, manifest
hợp lệ hay không) và hiện kết quả của lần chạy gần nhất ngay trong màn hình. Kết quả bị xoá khi đổi dự án hoặc mở repo
khác.

- **Xem thay đổi trên Taiga** chạy `taigent plan --project <slug> --json`: chỉ đọc Taiga, không ghi gì. Kết quả liệt
  kê các mục sẽ được tạo mới, cập nhật (kèm trường thay đổi) hoặc gắn vào epic, cả issue, và các mục trên Taiga không
  còn trong backlog, kèm loại của từng mục (taigent không bao giờ xoá chúng).
- **Đẩy lên Taiga** bị chặn khi `taigent validate` báo lỗi hoặc còn mục **Cần sửa** có góp ý chưa xử lý. Nếu không
  bị chặn, ứng dụng chạy `plan` trước. Không có thay đổi thì dừng ở đó. Có thay đổi thì ứng dụng mở hộp thoại xác nhận
  liệt kê số mục tạo mới/cập nhật (trong đó bao nhiêu issue)/gắn epic, số mục chưa duyệt và số mục đã đổi sau khi duyệt. **Bấm "Đẩy lên Taiga"
  trong hộp thoại này chính là đồng ý apply** (conventions §1). Chỉ sau đó ứng dụng mới chạy
  `taigent apply --project <slug> --yes --json` và hiện báo cáo. Nếu apply lỗi giữa chừng, các mục đã ghi được lưu
  trong `state.json`, lần chạy sau sẽ tiếp tục từ chỗ dừng.

Verdict *Đạt* không thay cho bước đồng ý này: `plan`/`apply` không đọc `review.yaml`.

## Project trên Taiga

Mục **Taiga** › **Project** liệt kê:

- các project trên Taiga mà bạn là thành viên (`taigent projects --json`, cần đăng nhập), kèm id, quyền của bạn (admin
  hay thành viên) và trạng thái trong repo: *Có backlog.yaml*, *Có project.yaml*, *Có thư mục* hoặc *Chưa có manifest*;
- các thư mục `taiga/<slug>/` của repo chưa có trên Taiga (*Chưa có trên Taiga*), ví dụ project vừa viết
  `project.yaml` mà chưa bootstrap.

Chưa đăng nhập hoặc Taiga lỗi thì danh sách chỉ có các thư mục của repo, kèm lý do. Bấm **Làm mới** để đọc lại.

Bấm **Mở** (hoặc **Tạo project.yaml** với project chưa có manifest) để mở chi tiết project:

- **trên Taiga**: id, quyền của bạn, và tên các issue type, severity, priority của project theo thứ tự trên Taiga
  (`taigent projects --project <slug> --json`), tức các giá trị mà một issue trong `backlog.yaml` được dùng;
- **Mở backlog**: khi thư mục có `backlog.yaml`, mở dự án đó ở mục Backlog;
- **form `project.yaml`**: tên (`<Khách hàng/Mảng> - <Sản phẩm>`), mô tả, template, riêng tư, các module bật. Slug là
  tên thư mục, và phải đúng slug Taiga suy ra từ tên. Lưu sẽ ghi đè đúng các trường này trong file, giữ nguyên comment,
  thứ tự và các phần khác (tag, custom attribute, member, `wiki_home`), nên các phần đó vẫn do bạn hoặc agent
  (skill `taiga-bootstrap-project`) viết. Trước khi ghi, ứng dụng chạy đúng luật của `taigent validate`. Lỗi ở các
  trường của form thì không ghi và hiện từng lỗi. Lỗi ở chỗ khác chỉ được báo, không chặn việc lưu. Nếu `project.yaml`
  đã đổi từ lúc mở form (ví dụ agent vừa sửa) thì ứng dụng từ chối lưu và cho chọn: tải lại file, hoặc ghi phần của
  bạn lên bản mới.

**Tạo project mới…** mở form trống. Lưu sẽ tạo `taiga/<slug>/project.yaml`, với slug suy ra từ tên.

**Bootstrap lên Taiga…** (chỉ bật khi `project.yaml` đã lưu) chạy `taigent bootstrap --project <slug> --dry-run --json`.
Không có gì để làm thì dừng ở đó. Có thay đổi thì ứng dụng mở hộp thoại xác nhận liệt kê từng thao tác (tạo project,
bật module, tạo tag, custom attribute, mời member, tạo wiki home). **Bấm "Bootstrap" trong hộp thoại này chính là đồng
ý bootstrap** (conventions §1). Chỉ sau đó ứng dụng mới chạy `taigent bootstrap --project <slug> --yes --json`.
Bootstrap không bao giờ tắt, đổi tên hay xoá gì trên Taiga, và cần quyền admin với project đã có.

## Báo cáo tiến độ

Mục **Taiga** › **Báo cáo**, dưới Project, chỉ đọc Taiga. Ô chọn project liệt kê các project trên Taiga mà mục Project
vừa đọc (chưa đăng nhập thì ô trống, kèm lý do). Chọn project rồi bấm **Xem báo cáo** để chạy
`taigent report --project <slug> --json` (xem `docs/cli.md` §Report). Báo cáo gồm:

- **Theo sprint**, sprint mới nhất trước: tên, ngày bắt đầu → kết thúc, đang chạy hay đã đóng, story xong/tổng, task
  xong/tổng, point xong/tổng và các story bị block;
- **Theo epic**: số story xong và đang mở của từng epic, và một dòng cho các story không thuộc epic nào;
- **Story ngoài sprint**: số xong/mở và từng story với trạng thái, point, cờ bị block.

Các con số có cùng nghĩa với báo cáo của skill `taiga-status-report`. Story xong là story Taiga đã đóng; task xong là
task có status đã đóng.

## Git

Mục **Git** chia sẻ manifest và kết quả review với team mà không cần biết git. Nó chỉ thao tác trên **phạm vi** gồm:

- thư mục manifest (`taiga/`, hoặc thư mục `TAIGENT_MANIFESTS_DIR` khi thư mục đó nằm trong repo);
- các file mà `taiga/<slug>/docs.yaml` tham chiếu (`file` của `wiki` và `attachments`) nằm ngoài thư mục đó, ví dụ
  `docs/huong-dan.md`.

File nằm ngoài repo đang mở không thuộc phạm vi. Ứng dụng chạy `git` của máy (không qua shell, không bao giờ hỏi mật
khẩu trong ứng dụng: remote cần đăng nhập thì dùng credential helper của git). Cần git 2.25 trở lên.

Màn hình hiện nhánh, nhánh theo dõi trên remote, số commit chưa push và số commit mới trên remote (theo lần fetch gần
nhất), phạm vi, các file **trong phạm vi** đã đổi (`git status --porcelain`) và số file đã đổi ngoài phạm vi. Bấm
**Làm mới** để đọc lại. Ba thao tác:

- **Pull**: fetch rồi `git pull --ff-only --no-rebase` từ nhánh đang theo dõi. Nếu ở máy có commit chưa push trong khi
  remote có commit mới (lịch sử đã tách nhánh) thì ứng dụng dừng trước khi pull, working tree không đổi.
- **Commit + Push**: nhập message rồi bấm. Ứng dụng `git add` đúng các file trong phạm vi đã đổi, rồi
  `git commit --only` với chính các file đó (file khác dù đã được stage cũng không vào commit), rồi `git push` lên nhánh
  đang theo dõi. Nếu remote có commit mới, ứng dụng không commit và nhắc bấm **Pull** trước.
- **Push**: push các commit chưa push (ví dụ commit trước đó bị lỗi push).

Ứng dụng không bao giờ merge, rebase, force push hay add file ngoài phạm vi. Nó cũng không push commit nào sửa file ngoài
phạm vi (commit bạn tự tạo trong terminal). Khi gặp một trong các trường hợp sau, ứng dụng dừng, giải thích bằng tiếng
Việt, liệt kê lệnh gợi ý và mở một tab shell ở repo trong [panel terminal](#terminal) để bạn xử lý:

- máy chưa cài git, hoặc thư mục đang mở không phải repo git;
- conflict, hoặc một lần merge/rebase/cherry-pick/revert chưa xong;
- lịch sử đã tách nhánh;
- HEAD không ở nhánh nào, repo chưa có remote, hoặc nhánh chưa theo dõi nhánh nào trên remote;
- có commit chưa push sửa file ngoài phạm vi;
- một lệnh git thất bại (ví dụ fetch/push bị từ chối, thiếu `user.name`/`user.email`). Thông báo kèm nguyên văn lỗi của
  git.

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

Cho các phần khác của ứng dụng (mục Git, nút skill headless): main process mở tab qua `terminals.open(...)` trong
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
5 task, 1 issue `BUG-STALE-AFTER-RENAME`; `project.yaml` khai báo custom attribute `Mục tiêu quý` cho epic). Đây không
phải project thật trên Taiga, nên không bootstrap (ngoài `--dry-run`) hay apply nó. Muốn smoke trên manifest của mình thì truyền
`--project <slug> --story <key>` (chép `taiga/<slug>`); khi đó script bỏ qua phần issue và phần form, vì chúng dùng các
key của fixture.

Script chép fixture sang thư mục tạm, trỏ ứng dụng vào đó bằng `TAIGENT_MANIFESTS_DIR` và dùng user-data tạm, nên
không đụng tới file của bạn. Script lần lượt: kiểm tra thanh điều hướng và ứng dụng mở vào mục Backlog, mở repo, chụp
cây và chi tiết story `REVIEW-COMMENT`, góp ý, đặt *Cần sửa*, kiểm tra `review.yaml`, sang mục Thay đổi kiểm tra nút
đẩy bị chặn, đi qua Wiki, Settings (mỗi mục chỉ có trạng thái trống, không có nút; phím `j` không đổi
mục đang chọn), quay về Backlog kiểm tra dự án và story vẫn được chọn, đặt *Đạt*, sửa mô tả rồi chờ trạng thái *Đã
đổi sau khi duyệt*, thử phím `j`/`k`, rồi (chỉ với fixture) mở issue trong nhóm *Issues* của cây, kiểm tra phân loại
và nhãn *Mới*, đặt *Đạt* và kiểm tra `review.yaml`. Sau đó là phần form: tạo epic (key gợi ý, custom attribute) và task bằng form,
kiểm tra `backlog.yaml` (giữ comment, task nằm dưới đúng story) và trạng thái *Chưa duyệt*; kiểm tra key của epic đã
có trên Taiga bị khoá; mở form sửa task, giả lập agent sửa `backlog.yaml`, kiểm tra form báo file đổi, lưu bị từ chối
(file vẫn là bản của agent), hộp thoại conflict hiện thay đổi, rồi *Áp lại*; kiểm tra cảnh báo mồ côi khi xoá story
đã có trên Taiga (bấm *Huỷ*) và xoá task mới. Tiếp theo là form story: tạo story dưới epic `PUSH` có hai scenario (một
scenario có hai Given), thử thêm, chuyển lên và xoá một scenario, lưu khi một When còn trống để thấy lỗi `[required]`
ngay dưới ô đó (file không đổi), rồi lưu thật; kiểm tra `backlog.yaml` đúng schema (`use_case`, `scenarios`), chạy
`taigent validate` (exit 0), so bản xem trước của form với mô tả của story trong `taigent preview --json` (phải bằng
nhau) và với phần mô tả ở màn hình review (cùng HTML). Sau đó sửa story legacy `REVIEW-MARKDOWN` (vẫn là
`acceptance_criteria`), rồi bấm *Chuyển sang user story format*, điền Given/When/Then, lưu và kiểm tra lại `validate`
và `preview`. Cuối phần form là form issue: bấm *+ Issue* trong nhóm Issues, kiểm tra mô tả có sẵn mẫu Steps to
reproduce / Expected / Actual; nếu `taigent projects --project <slug> --json` trả về giá trị (đã đăng nhập, project
có trên Taiga) thì kiểm tra ba dropdown có đúng các giá trị đó, nếu không thì ba ô là ô nhập tự do. Điền, xem bản xem
trước Markdown, lưu, kiểm tra `backlog.yaml` đúng schema, `taigent validate` exit 0 và issue mới *Chưa duyệt*; rồi
bấm *Sửa*, kiểm tra form mở đúng giá trị đã lưu và lưu lại. Nếu đã đăng nhập, script chạy thêm *Xem thay đổi trên Taiga* trong mục
Thay đổi (chỉ đọc; với fixture, Taiga báo không có project `smoke-taigent-desktop`). Sau đó script mở Taiga › Project,
kiểm tra fixture có trong danh sách, mở form `project.yaml`, sửa mô tả, lưu và kiểm tra file giữ comment và tag. Nếu
đã đăng nhập, script bấm *Bootstrap lên Taiga…*: `bootstrap --dry-run` chạy rồi hộp thoại xác nhận hiện ra. Mọi hộp
thoại xác nhận (đẩy, bootstrap) luôn được trả lời *Huỷ*. Sau đó script kiểm tra mục Báo cáo. Nếu đã đăng nhập và bạn
là thành viên ít nhất một project trên Taiga, script mở báo cáo của project đầu tiên (chỉ đọc). Nếu không, script kiểm
tra ô chọn project trống.
Cuối cùng script kiểm tra mục **Git** (`scripts/smoke-git.mjs`) trên một repo tạm có remote là một repo bare tạm, chứa
fixture trong `taiga/<slug>/`, một `docs.yaml` tham chiếu `docs/huong-dan.md` và một file ngoài phạm vi: sửa một file
trong `taiga/` và một file ngoài, kiểm tra danh sách chỉ có file trong `taiga/`, Commit + Push rồi kiểm tra remote chỉ
nhận file đó; sửa `docs/huong-dan.md` và kiểm tra nó vào danh sách; tạo lịch sử tách nhánh (một commit của "đồng đội"
trên remote, một commit ở máy) rồi bấm Pull, kiểm tra ứng dụng giải thích, mở một tab shell ở repo trong panel terminal,
và HEAD, trạng thái cùng nội dung working tree không đổi. Ảnh chụp lưu ở `tmp/desktop-smoke/`.

Phần terminal (`scripts/smoke-terminal.mjs`) chạy sau phần form, trước *Xem thay đổi*: panel ẩn lúc mở, bật/tắt bằng
`` Ctrl+` `` và nút; mở tab shell, gõ lệnh và thấy output, in tiếng Việt, in chữ đỏ bằng mã ANSI, kéo panel cao lên rồi
kiểm tra shell thấy đúng số cột và dòng mới; chạy một process con (`ping`), đóng tab rồi kiểm tra shell và process con
đã dừng. Ứng dụng được mở với `PATH` có một `claude` giả (in thư mục làm việc) đứng đầu và không có thư mục nào chứa
`omp`: nút mở nhanh `claude` phải chạy ở thư mục repo, còn `omp` phải hiện lỗi của shell mà tab và ứng dụng vẫn chạy.
Phần này để lại một shell chạy `ping`. Sau mục Git, script thoát ứng dụng và kiểm tra mọi process con của ứng dụng đã
dừng.

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
- Mục Git chạy `git` bằng `execFile`, không qua shell, với `GIT_TERMINAL_PROMPT=0` (không bao giờ chờ nhập mật khẩu).
  Danh sách file cần add và commit đi qua stdin (`--pathspec-from-file`) và được hiểu đúng nguyên văn
  (`--literal-pathspecs`).
