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
- **tạo và sửa trang wiki**: `readWikiPages`, `saveWikiPage` trong `dist/edit.js`. Chỉ sửa `docs.yaml` và file Markdown
  của trang trong repo, không cần mạng. Wiki không qua review;
- **đăng nhập / đăng xuất**: `storeLogin` / `removeLogin` (`dist/login.js`), dùng chung kho thông tin đăng nhập với
  `taigent login`;
- **trạng thái đăng nhập, xem thay đổi, đẩy lên Taiga, project trên Taiga, đẩy wiki, ticket của tôi**: chạy CLI
  `bin/taigent.js` (`whoami --json`, `plan --project <slug> --json`, `apply --project <slug> --yes --json`,
  `projects --json`, `projects --project <slug> --json`, `bootstrap --project <slug> --dry-run --json` rồi `--yes --json`,
  `upload --project <slug> --dry-run --json` rồi `--yes --json`, `tickets --from <ngày> --to <ngày> --json`,
  `status`/`comment --project <slug> --json <ref> -- <…>`) bằng chính file thực thi của ứng dụng ở chế độ Node
  (`ELECTRON_RUN_AS_NODE=1`), thư mục làm việc là repo đang mở, không qua shell;
- **form `project.yaml`**: `readProjectSettings` / `saveProjectSettings` trong `dist/project-settings.js`. Form chỉ ghi
  file trong repo, không ghi lên Taiga;
- **nút chạy skill headless**: `tools/taiga/run-skill` của taigent kèm trong ứng dụng, chạy trong một tab terminal ở
  repo đang mở (xem [Nút chạy skill headless](#nút-chạy-skill-headless)). Agent chỉ sửa file trong repo;
- **setup repo**: `init --dry-run --json` (repo đã có Taigent chưa, có cũ hơn ứng dụng không) và `init --json` của
  chính taigent kèm ứng dụng, chạy như các lệnh CLI ở trên, thư mục làm việc là repo vừa tạo, clone hoặc mở (xem
  [Setup repo](#setup-repo-wizard)).

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

### Setup repo (wizard)

Mục **Setup repo** (thanh điều hướng, phía trên Settings) đưa một repo tới chỗ dùng được Taigent, theo bốn bước. Khi
chưa mở repo nào, thanh trên cùng có gợi ý *Chưa mở repo* kèm nút **Setup repo**.

1. **Repo.** Chọn **Thư mục chứa repo**, rồi:
   - **Tạo repo mới**: nhập tên thư mục. Ứng dụng tạo `<thư mục chứa>/<tên>`, chạy `git init`, tạo `taiga/` (kèm
     `.gitkeep` để commit được) và `.gitignore` (`node_modules/`, `.env`), mở repo đó rồi tự chạy bước 2. Thư mục đã
     tồn tại thì ứng dụng từ chối, không đụng tới nó.
   - **Clone từ URL**: URL `https://`, `ssh://`, `git@host:đường-dẫn` hoặc đường dẫn tới một repo trên máy; tên thư
     mục lấy từ URL (sửa được). Ứng dụng chạy `git clone` không qua shell và không bao giờ hỏi mật khẩu trong terminal
     (`GIT_TERMINAL_PROMPT=0`): repo riêng tư cần đăng nhập git trước (Git Credential Manager hoặc SSH key). Clone
     lỗi thì ứng dụng giải thích bằng tiếng Việt (*Không tìm thấy repo ở URL này*, *Không có quyền truy cập*, *Không
     kết nối được*, kèm nguyên văn lỗi của git, đã che thông tin đăng nhập trong URL) và **xoá thư mục dở**, nên không
     còn gì sót lại. Clone quá 10 phút thì bị dừng, cũng xoá thư mục.
   - **Mở repo có sẵn…**: như nút *Mở thư mục repo…* trên thanh trên cùng.
2. **Cài Taigent vào repo.** Mỗi khi mở một repo (từ wizard hay thanh trên cùng), ứng dụng chạy
   `taigent init --dry-run --json` của **chính taigent kèm ứng dụng** (không phải bản trong `node_modules` của repo) để
   biết repo ở trạng thái nào:
   - *đã cài, cùng version*: init không đổi file nào. Ứng dụng không yêu cầu setup lại;
   - *chưa cài Taigent* (chưa có skill Taigent nào): thanh trên cùng gợi ý **Cài Taigent**;
   - *cũ hơn ứng dụng* (init sẽ đổi file, thường là sau khi nâng cấp ứng dụng): thanh trên cùng gợi ý **Chạy lại
     init**, mục Setup repo liệt kê các file sẽ đổi.

   Bấm **Cài Taigent vào repo** (hoặc **Chạy lại init**) chạy `taigent init --json`: các skill Taigent, entry MCP
   `taiga` trong `.mcp.json` và `.codex/config.toml`, bộ chạy headless và devDependency `taigent` ghim theo version của
   ứng dụng ([docs/cli.md § Using the skills in another project](cli.md#using-the-skills-in-another-project)). Ứng
   dụng liệt kê từng file: *Tạo mới*, *Cập nhật*, *Xoá* hoặc *Giữ nguyên*. Skill, MCP server và dependency khác của repo
   giữ nguyên. Hãy commit các file đó (mục **Git** chỉ commit `taiga/`, nên commit chúng trong terminal).
3. **npm install** mở một tab terminal chạy `npm install` ở repo (trên Windows qua `cmd`, vì `npm` là file `.cmd`), có
   nút **Huỷ**. Wizard báo khi lệnh xong và mã thoát. Cần Node.js 24+ trên máy; khi repo `sondoquang/taigent` còn
   private, tài khoản git trên máy cần quyền đọc repo đó.
4. **Kiểm tra** (chạy khi mở mục, bấm **Kiểm tra lại** để chạy lại):
   - `git`, `claude`, `codex`, `omp`: version (kèm đường dẫn trên `PATH`), hoặc *Chưa cài* kèm lệnh cài và nút **Chạy
     trong terminal** mở một tab chạy đúng lệnh đó (ví dụ `irm https://claude.ai/install.ps1 | iex`,
     `npm install -g @openai/codex`, `irm https://omp.sh/install.ps1 | iex`, `winget install --id Git.Git -e`). Ứng dụng
     **không tự cài** công cụ nào: lệnh chỉ chạy khi bạn bấm. Mỗi công cụ được tìm trên `PATH` rồi chạy `--version`
     bằng `execFile`, **không qua shell**, với **timeout 10 giây**: quá hạn thì hiện *không trả lời* thay vì treo. Trên
     Windows, công cụ cài bằng `npm install -g` là file `.cmd`, chỉ shell mới chạy được; ứng dụng đọc file `.cmd` mà npm
     viết để lấy script và chạy script đó bằng `node`. File `.cmd` kiểu khác được báo là có trên máy nhưng không đọc
     được version. Cài xong mà vẫn báo *Chưa cài* thì mở lại ứng dụng để nhận `PATH` mới;
   - **đăng nhập Taiga** (`taigent whoami`): chưa đăng nhập thì có nút **Đăng nhập** mở hộp thoại
     [Đăng nhập Taiga](#đăng-nhập-taiga);
   - lời nhắc **duyệt MCP server `taiga`**: lần đầu mở `claude` trong repo, Claude Code hỏi có dùng server `taiga` của
     `.mcp.json` không, hãy chọn dùng (kiểm tra bằng `claude mcp get taiga`); Codex chỉ nạp `.codex/config.toml` của
     repo khi bạn trust project.

## Mở repo và chọn dự án

1. Bấm **Mở thư mục repo…** và chọn thư mục gốc của repo có `taiga/<slug>/backlog.yaml` (repo mà agent đang sửa trên
   máy của bạn). Lần sau ứng dụng tự mở lại thư mục này.
2. Chọn **Dự án**. Danh sách gồm mọi thư mục con của `taiga/` có `backlog.yaml`. Repo chỉ có một dự án thì dự án đó
   được mở luôn. Thư mục manifest theo `TAIGENT_MANIFESTS_DIR` (biến môi trường, rồi tới `.env` của repo), mặc định
   `taiga`, giống CLI.

Ứng dụng theo dõi thư mục `taiga/<slug>/` và các thư mục con (`pages/`). Khi agent sửa `backlog.yaml`, `docs.yaml`,
một trang wiki hoặc trả lời góp ý trong `review.yaml`, màn hình tự cập nhật, không cần mở lại.

## Màn hình

Bố cục gồm bốn phần, từ trên xuống:

- **Thanh trên cùng**: mở thư mục repo, chọn **Dự án**, gợi ý setup (chưa mở repo, repo chưa cài Taigent, hoặc Taigent
  trong repo cũ hơn ứng dụng; xem [Setup repo](#setup-repo-wizard)), bật/tắt **Terminal**, đăng nhập/đăng xuất Taiga.
  Các phần này dùng chung cho mọi mục.
- **Thanh điều hướng bên trái** và màn hình của mục đang chọn:
  - **Dashboard**: số liệu của dự án đang mở theo vai trò của bạn (xem [Dashboard](#dashboard)). Ứng dụng mở vào mục
    này.
  - **Backlog**: review backlog (xem bên dưới).
  - **Taiga**: mục **Project** (xem [Project trên Taiga](#project-trên-taiga)) và **Ticket của tôi** (xem
    [Ticket của tôi](#ticket-của-tôi)). Bảng tiến độ theo sprint và theo epic nằm ở dashboard Product Owner.
  - **Wiki**: các trang của `docs.yaml`, form tạo/sửa trang và nút **Đẩy wiki lên Taiga** (xem [Wiki](#wiki)).
  - **Git**: pull, commit và push thư mục manifest (xem [Git](#git)).
  - **Thay đổi**: xem thay đổi và đẩy lên Taiga (xem [Xem thay đổi và đẩy lên Taiga](#xem-thay-đổi-và-đẩy-lên-taiga)).
  - **Setup repo**: tạo, clone hoặc mở repo, cài Taigent vào repo, `npm install` và checklist công cụ (xem
    [Setup repo](#setup-repo-wizard)).
  - **Settings**: **Giao diện** (*Theo hệ thống*, đổi theo chế độ sáng/tối của Windows hoặc macOS; *Sáng*; *Tối*, mặc
    định), **Vai trò trên Dashboard** (xem [Dashboard](#dashboard)), agent cho các nút chạy skill headless (`omp`,
    `claude` hoặc `codex`), cả ba lưu trong `settings.json` của ứng dụng, và phiên bản của ứng dụng, taigent, Electron
    và Node. Giao diện đổi ngay khi chọn, cả thanh tiêu đề của cửa sổ (main process đặt `nativeTheme.themeSource`, trang
    đổi theo `prefers-color-scheme`); terminal giữ nền tối ở cả hai giao diện.

  Chuyển qua lại giữa các mục không đổi dự án đang mở, mục đang chọn trong cây, bộ lọc và góp ý đang viết dở.
- **Panel dưới đáy**: terminal (xem [Terminal](#terminal)), ẩn mặc định.
- **Thanh trạng thái**: người duyệt và kết quả `taigent whoami`.

Mục **Backlog** gồm:

- **Thanh Nhờ agent**: ba nút chạy skill headless và kết quả của lần chạy gần nhất (xem
  [Nút chạy skill headless](#nút-chạy-skill-headless)).
- **Thanh tổng quan**: số epic/story/task/issue; *Mới* (chưa có trên Taiga) và *Đã đẩy*; thanh tiến độ duyệt (số mục
  *Đạt* trên tổng số mục, chia màu theo *Đạt*, *Cần sửa*, *Đã đổi sau khi duyệt*, *Chưa duyệt*) cùng số của từng trạng
  thái; số góp ý chưa xử lý; kết quả `taigent validate` (bấm *Manifest lỗi* để xem từng lỗi).
- **Cây bên trái**: epic → story → task, rồi nhóm **Issues** (các issue của `backlog.yaml`, không thuộc epic nào).
  Mỗi mục có nhãn *Mới* hoặc *Đã đẩy #ref*, trạng thái duyệt và số góp ý mở; *Mới* và *Chưa duyệt* (trạng thái mặc
  định) hiện dạng chữ nhạt, các trạng thái còn lại dạng nhãn màu. Bộ lọc: *Tất cả*, *Chưa duyệt*, *Cần sửa*, *Đã đổi*.
  Khi lọc, epic/story cha vẫn hiện (mờ) để bạn biết mục nằm ở đâu.
- **Chi tiết bên phải**: tiêu đề, mô tả hiển thị dạng Markdown, đúng nội dung ghi lên Taiga (với story, mô tả đã gồm
  tiêu chí chấp nhận dạng checklist `- [ ]` và link spec, nên không lặp lại thành mục riêng), task/story con, với
  issue thì mục **Phân loại** (loại, mức độ, ưu tiên), tag, custom attribute và chuỗi góp ý. Issue được duyệt và góp
  ý như mọi mục khác; đổi loại, mức độ hay ưu tiên của một issue đã *Đạt* cũng làm nó thành *Đã đổi sau khi duyệt*.
- **Phím tắt**: `j`/`k` hoặc `↓`/`↑` để chuyển mục (chỉ khi đang ở mục Backlog); `Ctrl+Enter` trong ô góp ý để gửi.

Giao diện viết bằng React với component của shadcn/ui trên Tailwind CSS v4, theo một design system duy nhất: token
(màu, chữ, khoảng cách, bo góc, đổ bóng) khai báo ở `desktop/src/renderer/globals.css`, luật dùng trong
[docs/desktop-design-system.md](desktop-design-system.md). Giao diện tối là mặc định. Toàn bộ giao diện dùng font Geist,
riêng terminal dùng Geist Mono; cả hai đóng gói sẵn trong `desktop/src/renderer/fonts/` (giấy phép SIL OFL 1.1,
`OFL.txt`) nên không tải gì từ mạng.

Các mục Dashboard, Wiki, Taiga, Thay đổi, Git, Setup repo và Settings có cùng bố cục: đầu trang có tiêu đề và mô tả ở
bên trái, các nút của mục ở bên phải; nội dung chia thành các card. Git (nhánh và ô commit) và Setup repo (bước 4 Kiểm
tra) đặt nội dung phụ thành cột bên phải, Settings xếp các card thành hai cột.

## Dashboard

Mục đầu tiên của thanh điều hướng, và là mục ứng dụng mở vào. Dashboard hiện số liệu của dự án đang mở ở thanh trên
cùng (repo có nhiều dự án mà chưa chọn thì Dashboard nhắc chọn, không tự đoán), theo **vai trò** của bạn: Developer,
Product Owner hoặc Business Analyst (thuật ngữ trong `GLOSSARY.md`, mục Dashboards). Dashboard chỉ đọc Taiga, không
bao giờ ghi.

- **Vai trò.** Lần đầu, Dashboard hiện ba lựa chọn ngay trong trang (không có hộp thoại, nên các mục khác vẫn dùng
  được khi chưa chọn). Đổi vai trò bằng menu **Vai trò: …** ở đầu Dashboard, hoặc ở Settings › **Vai trò trên
  Dashboard**. Vai trò lưu trong `settings.json` của ứng dụng (khoá `role`), giữ qua các lần mở.
- **Số liệu.** Main process chạy `taigent metrics --project <slug> --cache-dir <userData>/metrics-cache --json` (xem
  `docs/cli.md` §Metrics) trong repo đang mở, nên `.env` của repo (`TAIGA_*`) được dùng như mọi lệnh đọc khác. Mỗi
  lần đọc xong, kết quả được lưu vào `metrics-cache/latest-<slug>-<hash>.json` trong thư mục dữ liệu của ứng dụng,
  `<hash>` là 16 ký tự hex đầu của SHA-256 URL API Taiga mà bạn đang đăng nhập (như `whoami` báo, cùng cách CLI chọn),
  nên mỗi dự án trên mỗi Taiga có một bản lưu riêng. File lưu kèm số phiên bản định dạng và URL API; file của phiên
  bản khác, của Taiga khác, hay thiếu một phần số liệu (`developer`, `productOwner`, `businessAnalyst`, `periods`) bị bỏ
  qua. Lần sau mở, Dashboard hiện ngay số liệu đã lưu kèm thời điểm đọc (*Cập nhật lúc …*), trong khi lần đọc mới chạy
  ở nền; chưa đăng nhập thì không hiện số liệu đã lưu và không lưu gì. File được ghi ra một file tạm tên riêng rồi đổi
  tên (`writeAtomic` của lõi taigent), nên hai lần đọc chồng nhau không giẫm lên nhau. Cùng thư mục đó, CLI giữ history
  của từng item (`history-<slug>-<hash>.json`), nên các lần đọc sau chỉ đọc lại history của item đã đổi trên Taiga.
- **Khi nào đọc.** Lần đầu mục Dashboard hiện ra trong phiên (sau khi ứng dụng kiểm tra xong đăng nhập), mỗi lần đổi
  dự án, và mỗi lần URL API của đăng nhập đổi (đăng nhập, đăng xuất); Dashboard đang ẩn thì đọc khi nó hiện ra. Nút
  **Làm mới** đọc lại.
- **Lỗi.** Không đọc được (chưa đăng nhập, đăng nhập hết hạn hoặc bị từ chối, project không có trên Taiga hoặc bạn
  không xem được, `project.yaml` của dự án không hợp lệ, mạng hay URL API) thì lỗi hiện bằng tiếng Việt kèm cách sửa,
  chi tiết của CLI để bên dưới. `project.yaml` không hợp lệ (CLI thoát mã 4, lỗi `validation`) thì cách sửa là chạy
  `taigent validate --project <slug>`, sửa các lỗi nó báo, rồi bấm *Làm mới*. Số liệu đang hiện vẫn giữ nguyên.

**Developer** (từ phần `developer` của `taigent metrics`):

- **Kỳ hiện tại** (sprint đang chạy, hoặc tuần này với project kanban): số story và số task được giao và hoàn thành,
  đếm riêng;
- **Thời gian xử lý**: lead time và cycle time trung vị của story và của task. Cycle time tính từ lần đầu item vào
  `In progress` (theo history trên Taiga) tới lúc đóng; Ready for test chưa tính là đóng. Số liệu lưu từ phiên bản
  taigent cũ chưa có cycle time thì hai ô này hiện *Chưa có* kèm lý do, tới lần đọc sau;
- **Xu hướng hoàn thành**: biểu đồ cột story và task đóng trong từng kỳ;
- **Bug**: số bug resolved và số bug Rejected (đếm riêng) trong kỳ hiện tại, resolution time trung vị, **reopen
  rate** (số bug reopened, tức từ Ready for test hoặc Closed quay lại status đang mở theo history trên Taiga, chia cho
  số bug resolved trong kỳ; *—* khi kỳ chưa có bug resolved), và bảng theo từng kỳ;
- **Workload**: story mở, task mở và point của từng người, cộng một hàng *Chưa giao*;
- **Bị block** và **Quá hạn**: story và task đang mở, kèm status, người làm và hạn (hạn hôm nay chưa tính là quá hạn).

Công tắc **Chỉ tôi** thu mọi số liệu về việc được giao cho bạn (người dùng mà CLI đăng nhập): số của bạn, hàng
workload của bạn, các item block và quá hạn của bạn. Công tắc lọc ngay trong ứng dụng, không chạy lại lệnh.

**Product Owner** (từ phần `productOwner` của `taigent metrics`):

- **Sức khoẻ project**: bốn tín hiệu, mỗi tín hiệu có màu (xanh, vàng, đỏ) và lý do bằng số liệu: tiến độ sprint so
  với đường lý tưởng (chậm hơn 10% tổng point là vàng, hơn 25% là đỏ), story và task quá hạn (1–2 là vàng, từ 3 là
  đỏ), bug mở cuối kỳ (tăng 1 kỳ là vàng, tăng 2 kỳ liên tiếp là đỏ), story bị block (1 là vàng, từ 2 là đỏ);
- **Sprint hiện tại**: point, story và task xong trên tổng, số ngày đã qua, và biểu đồ đường lý tưởng (giảm đều từ
  tổng point về 0) kèm số point còn lại hôm nay;
- **Velocity**: point đã đóng của tối đa 6 sprint đã đóng gần nhất;
- **Planned vs completed**: point planned và point đã đóng của từng sprint. Planned (`basis: "sprint-start"`) là
  point của các story nằm trong sprint vào cuối ngày sprint bắt đầu, dựng lại từ history đổi sprint của từng story;
  nhãn biểu đồ ghi rõ điều đó;
- **Scope change**: bảng theo sprint, cột *Thêm vào* và *Rút ra*: số story và tổng point được thêm vào hoặc rút ra
  khỏi sprint sau ngày bắt đầu, tới ngày cuối của sprint, kèm từng story (ref, tên, point hiện tại, ngày). Story bị dời
  sang sprint khác sau khi sprint đã kết thúc không tính;
- **Release burndown**: mỗi release (story mang đúng một tag `release:<version>`, ngày đích khai báo ở `releases` của
  `project.yaml`, ADR 0005) có số story đóng, point còn lại và biểu đồ point còn lại theo ngày cùng đường lý tưởng tới
  ngày đích. Ô cảnh báo liệt kê tag chưa khai báo trong `project.yaml` (vẽ không có đường lý tưởng), release đã khai
  báo mà chưa có story, và story mang từ hai tag release trở lên (không tính vào burndown nào), kèm cách sửa;
- **Bug trend**: theo từng kỳ, số bug tạo, bug resolved (Ready for test hoặc Closed), bug Rejected, bug reopened và bug
  còn mở cuối kỳ (theo history trên Taiga, nên bug đã bị reopen được tính đúng), dạng biểu đồ và bảng;
- **Theo sprint**, **Theo epic** và **Story ngoài sprint**: các bảng trước đây ở card Báo cáo của mục Taiga, nay lấy
  từ `productOwner.report` của cùng lần đọc (không chạy `taigent report` riêng). Theo sprint, sprint mới nhất trước:
  tên, ngày, đang chạy hay đã đóng, story, task và point xong trên tổng, các story bị block. Theo epic: story xong và
  đang mở của từng epic, cộng một dòng cho story không thuộc epic nào. Story xong là story Taiga đã đóng; task xong là
  task có status đã đóng, cùng nghĩa với báo cáo của skill `taiga-status-report`.

Project kanban (module Backlog tắt) không có tiến độ sprint, velocity, planned vs completed và scope change: một ghi
chú nói lý do, các xu hướng tính theo tuần.

**Business Analyst** (từ phần `businessAnalyst` của `taigent metrics`):

- **Pipeline phân tích**: số story trên Taiga theo từng status, theo thứ tự status của project, dạng biểu đồ và bảng
  (project chưa có status nào cho user story thì thay bằng một ô trống nói lý do).
  Dashboard đọc *New* là *đang phân tích* và *Ready* là *đủ AC* (tên status trên Taiga giữ nguyên). Thêm nhóm **Chưa
  apply**: story của backlog chưa có trên Taiga (mới, hoặc story đã ghi trong `state.json` không còn trên Taiga);
- **Requirement change**: số lần sửa mô tả (description) của story trên Taiga sau lần đầu story vào *Ready* (theo
  history trên Taiga, status so theo id nên tên status trong history có dịch sang tiếng khác vẫn đúng), theo từng kỳ:
  số lần sửa và số story bị sửa trong kỳ hiện tại, biểu đồ cột mỗi kỳ, và bảng mỗi kỳ kèm các story bị sửa. Lấy từ
  Taiga nên vẫn hiện khi chưa có backlog manifest. Số liệu lưu từ phiên bản taigent cũ chưa có requirement change thì
  widget chờ lần đọc sau;
- **Độ phủ yêu cầu**: số epic có ít nhất một story đủ acceptance criteria trên tổng số epic, và danh sách epic chưa
  được phủ;
- **Acceptance criteria**: số story đủ AC (có ít nhất một scenario đủ Given, When và Then) trên tổng số story, và các
  story chưa đủ kèm lý do: định dạng cũ (legacy, luôn tính là chưa đủ), chưa có scenario, hoặc scenario thiếu Given,
  When hay Then;
- **Chờ review**: item của backlog chưa có verdict, hoặc đã đổi sau khi duyệt (*Đã đổi sau khi duyệt*);
- **Chờ làm rõ**: item còn góp ý chưa xử lý trong `review.yaml`, kèm các góp ý đó.

Bốn mục sau và nhóm *Chưa apply* tính từ backlog manifest và `review.yaml` của dự án trong repo (cùng bản xem trước
của mục Backlog). Dự án chưa có `backlog.yaml`, hoặc manifest hay `review.yaml` đang lỗi, thì chỉ còn phân bố status:
thay vào đó là ghi chú nói lý do và cách sửa (lỗi thì chạy `taigent validate --project <slug>`), kèm lời của CLI.

Biểu đồ dùng component Chart của shadcn/ui (Recharts, đóng gói cùng renderer), màu lấy từ token `--chart-1`…`--chart-5`
của `globals.css`; selector màu của mỗi biểu đồ đặt id trong ngoặc kép (`CSS.escape`), nên id có `:` hay `.` (như
release `1.2.0`) vẫn có màu. Mỗi widget có `id` ổn định (`#dashboard-throughput`, `#dashboard-workload`…) cho smoke.

## Duyệt và góp ý

1. Đọc từng mục. Ổn thì bấm **Đạt**. Cần sửa thì viết góp ý rồi bấm **Gửi góp ý** và **Cần sửa**. **Bỏ đánh giá**
   xoá verdict. Tên người duyệt là username của lần đăng nhập Taiga đã lưu, nếu chưa đăng nhập thì là tên tài khoản
   hệ điều hành.
2. Bấm **Nhờ agent xử lý góp ý** (skill `taiga-plan-backlog`, xem [Nút chạy skill headless](#nút-chạy-skill-headless)),
   hoặc gọi skill đó trong agent của bạn. Agent sửa manifest, rồi đánh dấu góp ý *Đã xử lý* và trả lời ngắn. Câu trả
   lời hiện dưới góp ý (*Agent trả lời*). Agent không đổi verdict của bạn.
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
- Mọi form có hai cột: bên trái là các ô, bên phải là **Xem trước**, cập nhật theo từng phím gõ. Form epic, task và
  issue hiện mô tả (Markdown) bằng cùng renderer và cùng bộ làm sạch DOMPurify như màn hình review; form story hiện
  mô tả ghép từ mẫu story (xem [Form story](#form-story)).
- **Key** được gợi ý theo quy ước khi bạn gõ tiêu đề: epic là vài chữ đầu của tiêu đề (`SOAN-BACKLOG`), story là
  `<EPIC>-<việc>`, task là `<STORY>-<bước>`, issue là `<BUG|ASK|ENH>-<triệu chứng>` theo loại của issue. Bạn sửa được
  key; trùng key có sẵn thì form báo ngay. Item đã có trên Taiga (`state.json`) bị khoá key, vì đổi key là tạo item
  mới và biến item cũ thành mồ côi.
- **Lưu** chạy cùng luật với `taigent validate`. Lỗi của chính item hiện ngay dưới ô sai (kèm rule, ví dụ
  `tag-prefix`); lỗi có sẵn ở item khác không chặn lưu. File được sửa tại chỗ: comment, thứ tự, cách viết của phần
  không đụng tới (dấu ngoặc kép, `[a, b]`, xuống dòng CRLF) giữ nguyên.
- Item mới luôn ở trạng thái *Chưa duyệt*. Sửa một item đã *Đạt* thì item thành *Đã đổi sau khi duyệt*, như khi agent
  sửa. Form không ghi `review.yaml`, trừ hai trường hợp: đổi key thì comment chuyển sang key mới và verdict bị bỏ (item
  thành *Chưa duyệt*); xoá item thì mục review của nó bị xoá.
- **Đang mở form mà file bị đổi** (thường là agent vừa sửa): form báo ngay. Bấm Lưu thì việc lưu bị từ chối, không có
  gì được ghi, và hộp thoại cho xem phần `backlog.yaml` đã đổi (dòng thêm/bớt). **Áp lại thay đổi của tôi** ghi phần
  của bạn lên bản mới; **Huỷ** giữ nguyên bản của agent.
- **Xoá** một item hỏi xác nhận và liệt kê các mục con bị xoá theo (xoá story thì xoá cả task của nó). Nếu có mục đã
  có trên Taiga, hộp thoại cảnh báo chúng sẽ thành **mồ côi**: xoá khỏi manifest không xoá trên Taiga, và *Xem thay đổi
  trên Taiga* sẽ báo chúng là mồ côi để người quyết định.

### Form story

Bên phải form story, **Xem trước** là mô tả story đúng như `apply` ghi lên Taiga.

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

Bên phải form issue là **Xem trước** của mô tả Markdown. Các field theo [conventions §6.4](taiga/conventions.md#64-issue):

- Tiêu đề (triệu chứng, không phải cách sửa) và key (gợi ý từ tiêu đề, theo conventions §5: `BUG-` cho Bug và loại
  khác, `ASK-` cho Question, `ENH-` cho Enhancement; đổi loại thì gợi ý đổi theo, trừ khi bạn đã tự sửa key). Issue
  dùng chung không gian key với epic, story, task.
- **Mô tả**: issue mới được điền sẵn mẫu `## Steps to reproduce` / `## Expected` / `## Actual`. Với Question hay
  Enhancement, xoá các phần không hợp và viết một đoạn.
- **Loại (type)**, **Mức độ (severity)**, **Ưu tiên (priority)**: form đọc các giá trị của project bằng `taigent
  projects --project <slug> --json`. Khi đã đăng nhập và project có trên Taiga, ba ô thành dropdown theo đúng thứ tự
  trên Taiga (giá trị hiện có mà Taiga không định nghĩa vẫn được giữ, kèm nhãn *không có trên Taiga*). Khi chưa đăng
  nhập hoặc project chưa có trên Taiga, ba ô cho nhập tự do; *Xem thay đổi trên Taiga* (`plan`) kiểm tên với project
  (rule `issue-value`). Cả ba đều bắt buộc.
- Tag và custom attribute mà `project.yaml` khai báo cho issue (`custom_attributes.issue`).

Issue mới ở trạng thái *Chưa duyệt*, như mọi item tạo bằng form.

## Wiki

Mục **Wiki** liệt kê các trang của `taiga/<slug>/docs.yaml` (slug, file Markdown, tiêu đề `#` đầu tiên). Wiki không
qua review: không có verdict, không ghi `review.yaml`.

- **+ Trang wiki** mở form: **slug** và **nội dung Markdown**, kèm bản xem trước dùng cùng renderer và bộ làm sạch
  DOMPurify như màn hình review. Lưu thì ứng dụng ghi file `taiga/<slug>/pages/<slug trang>.md` và thêm entry
  `{ slug, file: pages/<slug trang>.md }` vào cuối danh sách `wiki` của `docs.yaml` (tạo file nếu chưa có). Comment và
  các entry khác giữ nguyên.
- Slug theo luật của `taigent validate` (chữ thường, số, gạch ngang, ví dụ `spec-auth-login`; không trùng slug có sẵn).
  Slug sai thì lỗi hiện dưới ô slug kèm rule (`wiki-slug`, `wiki-slug-unique`) và không có gì được ghi. Lỗi có sẵn ở
  entry khác không chặn lưu. Nếu `pages/<slug trang>.md` đã có mà không nằm trong `docs.yaml`, ứng dụng không ghi đè:
  chọn slug khác hoặc nhờ agent thêm entry cho file đó.
- **Sửa** một trang ghi vào đúng file mà entry của nó chỉ tới, kể cả file ở ngoài `taiga/` (ví dụ
  `../../docs/specs/auth.md`); `docs.yaml` không đổi, file CRLF vẫn giữ CRLF. Slug bị khoá vì trang có thể đã có trên
  Taiga (upload ghép trang theo slug, đổi slug là tạo trang mới).
- Đang mở form mà `docs.yaml` hoặc file của trang bị đổi (thường là agent): form báo ngay; Lưu bị từ chối và hộp thoại
  cho xem phần đã đổi, **Áp lại thay đổi của tôi** ghi phần của bạn lên bản mới, như form backlog.
- **Đẩy wiki lên Taiga** chạy `taigent upload --project <slug> --dry-run --json` (chỉ đọc Taiga). Không có gì cần đẩy
  thì dừng ở đó. Có thay đổi thì ứng dụng mở hộp thoại xác nhận liệt kê từng trang wiki và tệp đính kèm sẽ **tạo
  mới**, **cập nhật** và **bỏ qua** (đã khớp với Taiga). **Bấm "Đẩy wiki lên Taiga" trong hộp thoại này là đồng ý
  upload**; chỉ sau đó ứng dụng mới chạy `upload --project <slug> --yes --json` và hiện báo cáo. *Huỷ* thì không có gì
  được ghi lên Taiga.
- Upload lỗi thì màn hình hiện thông báo tiếng Việt kèm **cách sửa** và nguyên văn lỗi của CLI: trang bị người khác
  sửa trên Taiga trong lúc đẩy (`conflict`: trang không bị ghi đè, chép phần cần giữ vào file rồi đẩy lại),
  `docs.yaml` không hợp lệ, chưa đăng nhập hoặc đăng nhập bị từ chối, tệp quá lớn, item mà tệp đính kèm trỏ tới chưa
  được đẩy, hoặc lỗi Taiga khác. Những gì đã ghi trước lỗi được giữ và lần chạy sau bỏ qua.

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
  kê các mục sẽ được tạo mới, cập nhật (kèm trường thay đổi) hoặc gắn vào epic, cả issue, rồi hai danh sách không phải
  thay đổi (taigent không bao giờ gỡ hay xoá chúng):
  - **mục mồ côi**: mục trên Taiga không còn trong backlog, kèm loại của từng mục;
  - **liên kết cũ (stale link)**: story trên Taiga còn gắn với một epic taigent khác epic của nó trong backlog (story
    đã chuyển epic). `apply` gắn story vào epic mới nhưng không gỡ liên kết cũ; nếu không cần nữa, gỡ tay trên Taiga.
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

Chưa đăng nhập hoặc Taiga lỗi thì danh sách chỉ có các thư mục của repo, kèm lý do bằng tiếng Việt và cách sửa (cùng
cách báo lỗi với [Ticket của tôi](#ticket-của-tôi): chưa đăng nhập, đăng nhập hết hạn hoặc bị từ chối, còn lại là
mạng hay URL API, kèm thông báo của CLI). Bấm **Làm mới** để đọc lại.

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

## Ticket của tôi

Mục **Taiga** › **Ticket của tôi** là các **ticket** của bạn (user story được giao cho tài khoản đang đăng nhập, cả
task lẫn issue đều không tính) trong một kỳ, đọc bằng `taigent tickets --from <ngày> --to <ngày> --json`
([docs/cli.md § Tickets](cli.md#tickets)):

- **Kỳ** mặc định là tuần hiện tại, thứ Hai tới Chủ nhật. **‹ Tuần trước**, **Tuần này**, **Tuần sau ›** chuyển tuần;
  hai ô *Từ*/*đến* chọn kỳ bất kỳ. Đổi kỳ là đọc lại ngay. **Làm mới** đọc lại kỳ đang chọn.
- Danh sách gồm ticket **đóng trong kỳ**, ticket **có hạn trong kỳ** và **mọi ticket còn mở** (đúng như `tickets`): ticket
  đã đóng trước, rồi ticket mở theo *Quá hạn*, *Còn hạn*, *Không có hạn*. Mỗi ticket có project, status, hạn kèm
  **due status** (*Đúng hạn*, *Trễ hạn*, *Quá hạn*, *Còn hạn*, *Không có hạn*), lúc đóng và **effort** (giờ, từ Spent
  Time; không có thì *ước tính từ points*; không có cả hai thì *Chưa có effort*). Dòng tổng kết đếm ticket theo due
  status và cộng effort. Ticket không có effort và các lần đóng hàng loạt (3 ticket trở lên trong một phút) được ghi
  chú dưới bảng.
- **Đổi status**: chọn status trong dropdown rồi bấm **Đổi status**. Dropdown liệt kê các user story status của project
  theo thứ tự trên Taiga (`taigent projects --project <slug> --json`, trường `storyStatuses`); status đóng ghi *(đóng)*.
  Ứng dụng hỏi xác nhận (status đóng thì báo ticket sẽ được đóng, Taiga ghi lại thời điểm đóng). **Bấm "Đổi status"
  trong hộp thoại này chính là đồng ý ghi**; chỉ sau đó ứng dụng mới chạy `taigent status --project <slug> --json <ref>
  -- <status>`.
- **Comment**: bấm **Comment…** ở một ticket, viết rồi bấm **Gửi comment** (hoặc `Ctrl+Enter`). Sau hộp thoại xác nhận,
  ứng dụng chạy `taigent comment --project <slug> --json <ref> -- <nội dung>`: nội dung đi nguyên vẹn thành một tham
  số, kể cả xuống dòng hay dấu `-` ở đầu. Comment đang viết dở được giữ khi bạn đóng ô hoặc chuyển mục.
- Sau **mỗi lần ghi**, xong hay lỗi, danh sách được đọc lại từ Taiga. Kết quả lần ghi gần nhất hiện trên danh sách.

Lỗi hiện bằng tiếng Việt kèm cách sửa, chi tiết của CLI để bên dưới:

| Tình huống | Ứng dụng báo | Cách sửa |
|---|---|---|
| Chưa đăng nhập | *Chưa đăng nhập Taiga* | Bấm **Đăng nhập** (hoặc `npx taigent login`), rồi **Làm mới** |
| Đăng nhập hết hạn hoặc bị từ chối | *Đăng nhập Taiga đã hết hạn hoặc bị từ chối* | Đăng xuất rồi đăng nhập lại; hoặc sửa `TAIGA_TOKEN`/`TAIGA_USERNAME`/`TAIGA_PASSWORD` của repo |
| Ticket vừa bị đổi trên Taiga (conflict) | *Ticket #84 vừa được đổi trên Taiga…*, chưa ghi gì | Xem lại ticket trong danh sách đã đọc lại, rồi thử lại |
| Ticket không còn là của bạn | *#84 không phải ticket của bạn*, chưa ghi gì | Nhờ người được giao, hoặc nhờ giao lại cho bạn trên Taiga |
| Status không còn trong project | *Project … không còn status này*, chưa ghi gì | Chọn lại status trong danh sách đã đọc lại |
| Taiga không trả lời | *Không ghi được lên ticket…* / *Không đọc được ticket…* | Kiểm tra mạng và URL API, **Làm mới** để xem ticket trên Taiga trước khi thử lại |

Không cần mở repo để dùng mục này. Khi đã mở repo, CLI chạy trong repo đó nên `.env` của repo (`TAIGA_*`) được dùng,
như `whoami`. Đăng nhập hay đăng xuất xong, lần mở mục Taiga kế tiếp tự đọc lại.

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
`` Ctrl+` `` (phím tắt vẫn chạy khi con trỏ đang ở trong terminal). Nút mũi tên xuống ở cuối thanh tab cũng tắt
panel. Ẩn panel không dừng process nào: các tab vẫn chạy và hiện lại nguyên vẹn khi bật panel. Kéo mép trên của panel
để đổi chiều cao, terminal tự đổi số cột và số dòng theo panel và báo cho process.

Thanh tab giống thanh tab của editor: mỗi tab có biểu tượng theo loại (shell, agent, skill), tên và nút **×**. Bấm tên
tab để chuyển, bấm chuột giữa để đóng, lăn chuột trên thanh để cuộn ngang khi có nhiều tab.

- Nút **+** ngay sau tab cuối mở menu tab mới, có ô tìm (gõ không dấu cũng được, ví dụ `cai dat`), phím mũi tên để
  chọn, `Enter` để mở, `Esc` để đóng:
  - **Terminal: …** mở một tab shell mới. Trên Windows có **PowerShell** (`pwsh` nếu có trên `PATH`, nếu không thì
    Windows PowerShell `powershell.exe`, là shell mặc định), **Command Prompt** (`cmd.exe`) và **Git Bash** (khi máy
    đã cài Git for Windows: `bin\bash.exe` cạnh `git.exe` trên `PATH`, hoặc trong `Program Files\Git`). Trên macOS chỉ
    có `$SHELL`. PowerShell chuyển console sang UTF-8, Command Prompt chuyển code page sang 65001 trước khi chạy, nên
    output tiếng Việt của các chương trình khác (git, agent) cũng hiện đúng. Git Bash mở ở thư mục repo, không về
    thư mục home.
  - **Claude Code**, **Codex**, **OMP** mở một tab mới chạy `claude`, `codex`, `omp` trong shell mặc định. Agent
    chưa cài thì tab hiện lỗi của shell và vẫn giữ shell để bạn gõ tiếp. Ứng dụng không cài, không đăng nhập agent
    giúp bạn.
  - **Cài đặt agent…** chuyển sang mục **Setup repo**, nơi kiểm tra và chạy lệnh cài `claude`, `codex`, `omp`.
- Bấm đúp vào chỗ trống của thanh tab mở một tab shell mặc định.
- Mọi tab chạy ở **thư mục repo đang mở**. Chưa mở repo thì không mở được tab. Môi trường của tab kế thừa từ ứng
  dụng; ứng dụng chỉ thêm `COLORTERM=truecolor` (và `TERM=xterm-256color` ngoài Windows; `CHERE_INVOKING=1` cho Git
  Bash), không thêm thông tin đăng nhập hay bí mật nào.
- Có nhiều tab cùng lúc. Khi process trong tab kết thúc, tab mờ đi, có chấm trạng thái (xanh: mã thoát 0, đỏ: mã
  khác, xám: đã dừng) và giữ nguyên nội dung cho tới khi bạn đóng.
- **Đóng tab (×) thì kill cả cây process** của tab: shell, agent và mọi process con của chúng (`taskkill /T /F` trên
  Windows, cả process group trên macOS). **Thoát ứng dụng thì kill mọi cây process** của mọi tab trước khi thoát.
- Tab **skill** do ứng dụng mở (chạy một lệnh cho trước, ví dụ một lần chạy skill headless) có chấm nhấp nháy khi
  đang chạy và thêm nút **Huỷ** (ô vuông): kill cả cây process nhưng giữ tab để bạn đọc output; tab ghi *Đã huỷ lần
  chạy*.

Đăng nhập Taiga trong ứng dụng bằng hộp thoại **Đăng nhập**, không gõ mật khẩu vào tab terminal. Lần đăng nhập đó
dùng chung với `npx taigent` và agent chạy trong terminal.

Cho các phần khác của ứng dụng (mục Git, nút skill headless, wizard Setup repo): main process mở tab qua
`terminals.open(...)` trong `desktop/src/main/terminal.ts`. `{ kind: 'shell', cwd, shell? }` mở một shell (`shell`
là id trong menu **+**: `powershell`, `cmd`, `git-bash`; bỏ trống là shell mặc định); `{ kind: 'skill', cwd, title,
command: { file, args, env? } }` chạy thẳng lệnh đó trong pty (không qua shell). Kết quả có `tab`, `cancel()` (kill cả
cây process), `exited` (Promise `{ exitCode, signal?, cancelled }`) và `onData(listener)`. Renderer tự hiện panel và
chọn tab mới. Lệnh cần shell (ví dụ `irm … | iex` khi cài công cụ) dùng `command: shellRun('<lệnh>')`: shell mặc định
chạy lệnh đó rồi vẫn mở để bạn gõ tiếp.

## Nút chạy skill headless

Thanh **Nhờ agent** ở đầu mục Backlog có ba nút. Mỗi nút chạy một skill Taigent không tương tác, bằng agent chọn ở ô
**Agent** đầu thanh (tô màu để thấy ngay agent nào sẽ chạy) hoặc trong **Settings**: **OMP** (`omp`, mặc định),
**Claude Code** (`claude`) hay **Codex** (`codex`). Hai chỗ chọn là một: đổi ở chỗ này thì chỗ kia đổi theo, lưu vào
`settings.json` của ứng dụng. Trong lúc một lần chạy chưa xong, ô Agent bị khoá như các nút.

| Nút | Skill | Agent làm gì |
|---|---|---|
| **Plan backlog từ spec…** | `taiga-plan-backlog` | Bạn chọn file spec (thường trong repo); agent viết hoặc cập nhật `backlog.yaml` của dự án đang mở (chưa mở dự án thì skill tự chọn hoặc tạo) |
| **Nhờ agent xử lý góp ý** | `taiga-plan-backlog` | Sửa manifest theo các góp ý còn mở trong `review.yaml` và trả lời từng góp ý |
| **Tạo user story…** | `taiga-create-user-story` | Bạn tả nhu cầu trong một câu; agent soạn một story theo user story format dưới epic hợp nhất, ghi vào `backlog.yaml` rồi dừng ở bước hỏi xác nhận: story ở lại trong manifest |

- Mỗi lần chạy mở một tab **skill** trong [panel terminal](#terminal), chạy `run-skill` của taigent kèm trong ứng dụng
  (cùng version với ứng dụng) với thư mục làm việc là repo đang mở. `run-skill` dùng `.agents/skills/` và allowlist
  `tools/taiga/allowlist.txt` của chính repo đó (do `taigent init` cài), nên lần chạy chỉ được dùng đúng các lệnh trong
  allowlist, như khi chạy `run-skill` ngoài ứng dụng ([docs/headless.md](headless.md#taigent-desktop-buttons)).
  Repo chưa có allowlist (hoặc, với `omp`, chưa có `tools/taiga/omp-guard.mjs`) thì `run-skill` dừng với mã thoát 2
  và nhắc chạy `npx taigent init`.
- **Huỷ** trên tab kill cả cây process (agent và mọi process con); tab ghi *Đã huỷ lần chạy*.
- Chạy xong, thanh Nhờ agent báo **xong** (mã thoát 0), **lỗi** kèm mã thoát và dòng lỗi cuối của output, hoặc **đã
  huỷ**. Cây, form đang mở và màn hình review tự cập nhật theo file agent sửa (ứng dụng theo dõi `taiga/<slug>/`);
  dự án agent vừa tạo hiện trong danh sách **Dự án**.
- Mỗi lúc chỉ có một lần chạy: các nút tắt cho tới khi lần chạy đang có kết thúc.
- **Không nút nào apply, upload hay bootstrap.** Yêu cầu gửi agent luôn ghi rõ không chạy các lệnh đó, và một lần
  chạy headless không có cách nào nhận lời đồng ý mà `--yes` cần. Muốn lên Taiga, review rồi bấm **Đẩy lên Taiga** như
  mọi thay đổi khác.
- Đường dẫn spec và câu mô tả story đi vào yêu cầu gửi agent: không được chứa dấu ngoặc kép (`"`) hay xuống dòng.
- Ứng dụng không cài, không đăng nhập agent. Agent chưa cài thì tab báo `run-skill: <agent> is not installed` (mã thoát
  2). Agent cần lần đăng nhập Taiga (`npx taigent login` hoặc hộp thoại **Đăng nhập**) và MCP server `taiga` đã duyệt.
- Kiểm tra mà không chạy agent: mở ứng dụng với biến môi trường `TAIGENT_RUN_SKILL_DRY_RUN=1`. Khi đó các nút chạy
  `run-skill --dry-run`, tab chỉ in lệnh sẽ chạy (mảng JSON). Smoke dùng cách này.

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
rebuild, và máy build hay máy người dùng đều không cần Visual Studio/Python. Vì vậy `npmRebuild: false` trong cấu hình
electron-builder là cố ý: node-pty (`node-addon-api`, `napi.h`) không gắn với ABI của Node hay Electron, còn rebuild
bằng node-gyp sẽ tạo `build/Release/pty.node`, được nạp trước bản prebuilt và đòi build tool. `node-pty` được giải nén
khỏi `app.asar` (`asarUnpack`) vì Windows cần chạy file thật (`conpty.node`, worker
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
5 task, 1 issue `BUG-STALE-AFTER-RENAME`; `project.yaml` khai báo custom attribute `Mục tiêu quý` cho epic; `docs.yaml`
có 2 trang wiki dưới `pages/`). Đây không phải project thật trên Taiga, nên không bootstrap (ngoài `--dry-run`), apply
hay upload nó lên Taiga thật. Muốn smoke trên manifest của mình thì truyền `--project <slug> --story <key>` (chép
`taiga/<slug>`); khi đó script bỏ qua phần issue, phần form và phần wiki, vì chúng dùng các key và trang của fixture.

Script chép fixture sang thư mục tạm, trỏ ứng dụng vào đó bằng `TAIGENT_MANIFESTS_DIR` và dùng user-data tạm, nên
không đụng tới file của bạn. Script lần lượt: kiểm tra thanh điều hướng (Dashboard đứng đầu), ứng dụng mở vào mục
Dashboard với ba lựa chọn vai trò ngay trong trang và gợi ý *Chưa mở repo* trên thanh trên cùng, mở repo, chạy phần
**Dashboard** (`scripts/smoke-dashboard.mjs`, xem bên dưới), sang Backlog chụp
cây và chi tiết story `REVIEW-COMMENT`, góp ý, đặt *Cần sửa*, kiểm tra `review.yaml`, sang mục Thay đổi kiểm tra nút
đẩy bị chặn, đi qua Settings (phím `j` không đổi
mục đang chọn), quay về Backlog kiểm tra dự án và story vẫn được chọn, đặt *Đạt*, sửa mô tả rồi chờ trạng thái *Đã
đổi sau khi duyệt*, thử phím `j`/`k`, rồi (chỉ với fixture) mở issue trong nhóm *Issues* của cây, kiểm tra phân loại
và nhãn *Mới*, đặt *Đạt* và kiểm tra `review.yaml`. Sau đó là phần form: tạo epic (key gợi ý, custom attribute) và task bằng form,
kiểm tra bản xem trước Markdown của cả hai, `backlog.yaml` (giữ comment, task nằm dưới đúng story) và trạng thái *Chưa duyệt*; kiểm tra key của epic đã
có trên Taiga bị khoá; mở form sửa task, giả lập agent sửa `backlog.yaml`, kiểm tra form báo file đổi, lưu bị từ chối
(file vẫn là bản của agent), hộp thoại conflict hiện thay đổi, rồi *Áp lại*; kiểm tra cảnh báo mồ côi khi xoá story
đã có trên Taiga (bấm *Huỷ*) và xoá task mới. Tiếp theo là form story: tạo story dưới epic `PUSH` có hai scenario (một
scenario có hai Given), thử thêm, chuyển lên và xoá một scenario, lưu khi một When còn trống để thấy lỗi `[required]`
ngay dưới ô đó (file không đổi), rồi lưu thật; kiểm tra `backlog.yaml` đúng schema (`use_case`, `scenarios`), chạy
`taigent validate` (exit 0), so bản xem trước của form với mô tả của story trong `taigent preview --json` (phải bằng
nhau) và với phần mô tả ở màn hình review (cùng HTML). Sau đó sửa story legacy `REVIEW-MARKDOWN` (vẫn là
`acceptance_criteria`), rồi bấm *Chuyển sang user story format*, điền Given/When/Then, lưu và kiểm tra lại `validate`
và `preview`. Cuối phần form là form issue: bấm *+ Issue* trong nhóm Issues, kiểm tra mô tả có sẵn mẫu Steps to
reproduce / Expected / Actual và ba ô type, severity, priority nhập tự do (fixture không có trên Taiga), điền, kiểm tra
key gợi ý có tiền tố theo loại (`BUG-`; đổi loại sang Question thì thành `ASK-`), xem
bản xem trước Markdown, lưu, kiểm tra `backlog.yaml` đúng schema, `taigent validate` exit 0 và issue mới *Chưa
duyệt*; rồi bấm *Sửa*, kiểm tra form mở đúng giá trị đã lưu và lưu lại. Rồi tới phần wiki: mục Wiki liệt kê 2 trang, form từ chối slug sai
(rule `wiki-slug`), tạo trang `trang-smoke` (kiểm tra `pages/trang-smoke.md` và entry cuối `docs.yaml`, comment giữ
nguyên), sửa trang đó (slug bị khoá, chỉ file trang đổi). *Đẩy wiki lên Taiga* chạy với một Taiga giả
(`test/support/fake-taiga.ts`, trong tiến trình của script; ứng dụng nhận `TAIGA_API_URL`/`TAIGA_USERNAME`/
`TAIGA_PASSWORD` của nó trong lúc đó): hộp thoại xác nhận liệt kê tạo mới, cập nhật, bỏ qua và được trả lời *Huỷ*
(Taiga giả không nhận request ghi nào); sai mật khẩu thì hiện thông báo tiếng Việt kèm cách sửa; cuối cùng, chỉ với
Taiga giả, hộp thoại được trả lời đồng ý trong khi trang bị sửa trên Taiga giữa chừng, và màn hình hiện thông báo
conflict kèm cách sửa. Tiếp đó, cũng với một Taiga giả có story `REVIEW-MARKDOWN` còn gắn với epic cũ `OLD-REVIEW`,
script bấm *Xem thay đổi trên Taiga* trong mục Thay đổi và kiểm tra màn hình liệt kê liên kết cũ đó (stale link) và
epic cũ là mục mồ côi, không có request ghi nào. Nếu đã đăng nhập, script chạy thêm *Xem thay đổi trên Taiga* trong mục
Thay đổi (chỉ đọc; với fixture, Taiga báo không có project `smoke-taigent-desktop`), rồi tạo tạm một `backlog.yaml`
trống cho project Taiga đầu tiên bạn là thành viên, mở form issue của project đó và kiểm tra ba dropdown type,
severity, priority có đúng các giá trị trong `taigent projects --project <slug> --json` (bấm *Huỷ*, không lưu gì; thư
mục tạm được xoá và fixture được mở lại). Script gọi vài kênh IPC với slug xấu (`../outside`, `..`, chữ hoa,
`project.yaml` có slug `../x`) và kiểm tra mọi kênh từ chối ngay tại ranh giới. Sau đó script mở Taiga › Project,
kiểm tra fixture có trong danh sách, mở form `project.yaml`, sửa mô tả, lưu và kiểm tra file giữ comment và tag. Nếu
đã đăng nhập, script bấm *Bootstrap lên Taiga…*: `bootstrap --dry-run` chạy rồi hộp thoại xác nhận hiện ra. Mọi hộp
thoại xác nhận với Taiga thật (đẩy, bootstrap) luôn được trả lời *Huỷ*. Sau đó script kiểm tra mục Taiga không còn
card Báo cáo hay bảng theo sprint và theo epic (đã chuyển sang dashboard Product Owner).
Tiếp theo là **Ticket của tôi** (`scripts/smoke-tickets.mjs`): kiểm tra kỳ mặc định là tuần này (thứ Hai tới Chủ
nhật). Nếu đã đăng nhập, script đọc ticket thật của tuần này rồi bấm *‹ Tuần trước* và chờ kỳ trước được đọc (chỉ
đọc); nếu chưa, kiểm tra lỗi *Chưa đăng nhập* kèm cách sửa và kỳ vẫn đổi được. Thao tác ghi chỉ chạy trên FakeTaiga
(`test/support/fake-taiga.ts`, khởi động trong script): script tạm trỏ CLI của ứng dụng vào FakeTaiga (biến `TAIGA_*`
của tiến trình chính, kho đăng nhập tạm), kiểm tra hai ticket với due status và effort, dropdown status, *Huỷ* trong hộp
thoại không ghi gì, đổi status và gửi comment (có xuống dòng) rồi kiểm tra danh sách được đọc lại, conflict, ticket
không còn là của bạn và đăng nhập bị từ chối đều hiện lỗi tiếng Việt kèm cách sửa; xong thì trả lại biến môi trường.
Không có gì được ghi lên Taiga thật: muốn thử ghi thật thì làm bằng tay trên một project thử.
Cuối cùng script kiểm tra mục **Git** (`scripts/smoke-git.mjs`) trên một repo tạm có remote là một repo bare tạm, chứa
fixture trong `taiga/<slug>/`, một `docs.yaml` tham chiếu `docs/huong-dan.md` và một file ngoài phạm vi: sửa một file
trong `taiga/` và một file ngoài, kiểm tra danh sách chỉ có file trong `taiga/`, Commit + Push rồi kiểm tra remote chỉ
nhận file đó; sửa `docs/huong-dan.md` và kiểm tra nó vào danh sách; tạo lịch sử tách nhánh (một commit của "đồng đội"
trên remote, một commit ở máy) rồi bấm Pull, kiểm tra ứng dụng giải thích, mở một tab shell ở repo trong panel terminal,
và HEAD, trạng thái cùng nội dung working tree không đổi. Ảnh chụp lưu ở `tmp/desktop-smoke/`.

Phần **Dashboard** (`scripts/smoke-dashboard.mjs`) chạy ngay sau khi mở repo, khi Dashboard đang hiện. Lần đọc đầu
(bằng đăng nhập của bạn, hoặc lỗi nếu chưa đăng nhập) chạy xong trước, rồi script trỏ CLI của ứng dụng vào FakeTaiga
(như phần Ticket của tôi) qua một proxy có thể giữ request lại, với một project cùng slug với fixture: hai sprint,
story và task của người dùng giả và một đồng đội, ba bug (một bug bị reopen rồi đóng lại), và history của một story,
một task và bug đó. Script tải lại cửa sổ để `whoami` của ứng dụng biết đăng nhập giả, rồi kiểm tra: Dashboard đọc số
liệu (Taiga giả chỉ nhận request đọc), kết quả được lưu trong `metrics-cache/latest-<slug>-<hash>.json` của user-data
(phiên bản, URL API của đăng nhập, số liệu) và CLI giữ history ở đó (`--cache-dir`); chưa có
vai trò thì số liệu chờ lựa chọn, chọn Developer trong trang thì `settings.json` lưu `role`; số story/task của kỳ hiện
tại, bug resolved và Rejected, cycle time của story và của task, reopen rate (1 reopened / 2 resolved), biểu đồ xu
hướng, workload (kèm *Chưa giao*), danh sách quá hạn và bị block; *Chỉ tôi* chỉ giữ
hàng workload và item của người dùng mà không chạy lại lệnh; menu vai trò chuyển sang dashboard Product Owner và
Business Analyst (xem bên dưới) và lưu lựa chọn. Ở dashboard Product Owner (`scripts/smoke-dashboard-po.mjs`), script
xếp các story giả vào hai sprint, gắn tag release, thêm một epic và tạm khai báo hai release trong `project.yaml` của
thư mục tạm (trả lại sau), đọc lại rồi kiểm tra: bốn tín hiệu sức khoẻ có màu và lý do tiếng Việt; tiến độ sprint hiện
tại, velocity, planned vs completed có nhãn theo `basis` (lúc sprint bắt đầu); scope change của từng sprint (story
thêm vào sau ngày bắt đầu, và một story rút ra theo history đổi sprint); burndown của release đã khai báo có đường lý tưởng, tag chưa
khai báo (`release:3.0.0`, có dấu chấm) thì không nhưng biểu đồ vẫn có màu, kèm đủ ba cảnh báo release; bug trend (tạo, resolved, reopened, mở cuối kỳ theo từng sprint); bảng theo sprint (cả story bị block), theo epic và story
ngoài sprint. Tắt module Backlog trên Taiga giả thì các widget sprint biến mất và có ghi chú lý do. `project.yaml`
không hợp lệ (trong một bản chép riêng của manifest, trỏ bằng `TAIGENT_MANIFESTS_DIR`) thì lỗi tiếng Việt chỉ cách sửa `taigent validate --project <slug>`. Settings hiện vai
trò đang chọn và đổi lại được; *Làm mới* thấy story vừa đóng trên
Taiga giả, kèm thời điểm mới. Sau đó script xoá cycle time khỏi số liệu đã lưu (như bản lưu của taigent cũ), cho proxy
giữ mọi request trừ đăng nhập rồi tải lại cửa sổ (như mở lại ứng dụng): vai trò còn giữ, số liệu đã lưu hiện kèm thời
điểm trong khi lần đọc mới còn chạy, hai ô cycle time hiện *Chưa có* kèm lý do. Proxy ngắt kết nối, rồi đăng nhập bị
từ chối (sai mật khẩu): cả hai lần đều hiện lỗi tiếng Việt kèm cách sửa mà số liệu cũ vẫn trên màn hình. Cuối cùng
script ghi một bản lưu theo định dạng cũ (chỉ số liệu, thiếu phần Product Owner và Business Analyst), chọn Product
Owner và tải lại cửa sổ: bản lưu đó bị bỏ qua, dashboard hiện lần đọc mới. Xong thì trả lại biến môi trường.

Phần **Business Analyst** (`scripts/smoke-dashboard-ba.mjs`) chạy khi menu vừa chuyển sang Business Analyst. Script
trỏ CLI vào một bản chép riêng của fixture (ứng dụng và mục Backlog không thấy các sửa đổi này): story `SMOKE-FIXTURE`
mất Then, `review.yaml` có một verdict đã cũ, một góp ý chưa xử lý và một góp ý đã xử lý, `state.json` ghi một story
có trên Taiga giả và một story không còn; history của story đó trên Taiga giả có lần vào *Ready* và bốn lần sửa mô tả
(một lần trước khi vào Ready). Script kiểm tra: số story theo status, *New* đọc là *đang phân tích* và *Ready* là *đủ
AC*, nhóm *Chưa apply*, biểu đồ; requirement change chỉ đếm các lần sửa sau Ready, theo sprint (số liệu kỳ hiện tại,
biểu đồ, story trong bảng), không còn ô *Chưa có*; độ phủ yêu cầu và epic `SMOKE` chưa được phủ; tỉ lệ đủ AC và hai
story chưa đủ kèm lý do (legacy, thiếu Then); 15 item chờ review (có item đã đổi sau khi duyệt); chỉ item còn góp ý
chưa xử lý ở *Chờ làm rõ*. Rồi trỏ CLI vào một thư mục không có manifest: phân bố status và requirement change vẫn
còn, không còn *Chưa apply*, ghi chú thiếu backlog manifest thay cho các widget kia. Xong thì trả lại biến môi trường.

Phần terminal (`scripts/smoke-terminal.mjs`) chạy sau phần form và phần wiki, trước *Xem thay đổi*: panel ẩn lúc mở, bật/tắt bằng
`` Ctrl+` `` và nút; mở tab shell, gõ lệnh và thấy output, in tiếng Việt, in chữ đỏ bằng mã ANSI, kéo panel cao lên rồi
kiểm tra shell thấy đúng số cột và dòng mới; chạy một process con (`ping`), đóng tab rồi kiểm tra shell và process con
đã dừng. Ứng dụng được mở với `PATH` có một `claude` giả (in thư mục làm việc) đứng đầu và không có thư mục nào chứa
`omp`: nút mở nhanh `claude` phải chạy ở thư mục repo, còn `omp` phải hiện lỗi của shell mà tab và ứng dụng vẫn chạy.
Phần này để lại một shell chạy `ping`. Sau phần setup repo, script gọi lại bước kiểm tra công cụ để `claude --version`
giả (không bao giờ trả lời) còn chạy ngoài terminal, rồi thoát ứng dụng và kiểm tra mọi process con của ứng dụng, kể cả
process đó, đã dừng.

Phần nút chạy skill headless (`scripts/smoke-headless.mjs`) chạy ngay sau phần terminal. Ứng dụng được mở với
`TAIGENT_RUN_SKILL_DRY_RUN=1` và một `codex` giả đứng đầu `PATH`. Script kiểm tra Settings mặc định là `claude`, bấm
**Plan backlog từ spec…** (hộp thoại chọn file trả về `docs/headless.md`) và **Nhờ agent xử lý góp ý** với `claude`,
chọn `codex` trong Settings (kiểm tra `settings.json` lưu `headlessAgent` mà vẫn giữ `lastRepo`) rồi bấm **Tạo user
story…** với một câu mô tả. Mỗi lần, tab skill phải in đúng lệnh mà `run-skill --dry-run` của repo in ra cho cùng
agent, skill và yêu cầu (gồm cả allowlist), yêu cầu phải có spec/dự án/mô tả và câu cấm apply/upload/bootstrap, và
thanh Nhờ agent báo xong. Sau đó script bỏ `--dry-run`: `codex` giả chạy với `TAIGENT_READ_ONLY=1` (nó in giá trị biến
này ra tab) và chờ, các nút tắt trong lúc chạy, bấm **Huỷ** thì tab ghi *Đã huỷ lần chạy* và cả cây process đã dừng;
rồi cho `codex` giả lỗi (mã thoát 3) và kiểm tra thanh Nhờ agent báo mã thoát và dòng lỗi cuối.

Phần setup repo (`scripts/smoke-wizard.mjs`) chạy cuối, sau mục Git, trên một thư mục tạm. Nó đặt vào thư mục đầu tiên
của `PATH` của ứng dụng (thay `codex` giả của phần headless): một `codex` giả dạng file `.cmd` mà `npm install -g`
viết (in `codex-cli 9.9.9-smoke`), một `claude` giả không bao giờ trả lời `--version`, và một `npm` giả (in tham số và
thư mục làm việc); `omp` vẫn không có trên `PATH`.
Script tạo repo mới bằng wizard và kiểm tra: có `.git` và `taiga/`, repo mới là repo đang mở, `taigent init` đã cài đủ
(chạy `init --dry-run` của taigent trong repo này không còn gì để làm, có `.mcp.json` với server `taiga`), danh sách
file của wizard đúng bằng các file đó và đều *Tạo mới*, không có gợi ý setup. Rồi: **npm install** mở một tab terminal
chạy ở repo mới và wizard báo xong với mã 0; checklist hiện `git` với đúng version của máy, `codex` với version đọc qua
file `.cmd` (không qua shell), `claude` *không trả lời* (timeout), `omp` *Chưa cài* kèm lệnh cài và nút chạy (script
không bấm), trạng thái đăng nhập Taiga đúng với `whoami` và lời nhắc duyệt MCP server `taiga`. Sau đó sửa một skill
Taigent trong repo cho cũ đi, mở lại repo và kiểm tra thanh trên cùng gợi ý chạy lại init, bấm gợi ý rồi chạy lại init
(file *Cập nhật*, repo hết cũ); clone một đường dẫn không có repo và kiểm tra thông báo tiếng Việt, không còn thư mục
dở; clone ba URL có `user:token@` (một URL bị từ chối có scheme, một không có scheme, một URL git không kết nối được)
và kiểm tra token không có trong thông báo nào; clone một repo bare tạm (không có Taigent) và kiểm tra repo được mở,
được đề nghị cài Taigent, rồi cài; cuối cùng mở lại repo đã setup và kiểm tra ứng dụng không yêu cầu setup lại.

## Bảo mật

- Cửa sổ chạy với `contextIsolation`, `sandbox`, không có `nodeIntegration`, CSP chặt (chỉ script của ứng dụng, không
  script inline, không tải tài nguyên mạng) và chặn mọi điều hướng hay cửa sổ mới. Link trong mô tả mở bằng trình
  duyệt hệ thống (chỉ http/https).
- CSP cho phép style inline (`style-src 'self' 'unsafe-inline'`) vì xterm.js tô màu và đặt kích thước dòng bằng thẻ
  `<style>` và thuộc tính `style` (thanh tiến độ duyệt cũng đặt độ dài từng đoạn bằng thuộc tính `style`). Font chỉ nạp
  từ ứng dụng (`font-src 'self'`).
  Nội dung do agent viết không dùng được quyền này: DOMPurify bỏ mọi thẻ `<style>` và
  thuộc tính `style` trong Markdown, và script vẫn chỉ được nạp từ ứng dụng.
- Markdown trong mô tả do agent viết được làm sạch bằng DOMPurify trước khi hiển thị.
- Renderer chỉ dùng được API có kiểu trong `desktop/src/shared/api.ts`, qua preload. Nó không đọc file và không gọi
  mạng.
- Mọi kênh IPC, gọi (`invoke`) lẫn gửi (`send`), đi qua một wrapper duy nhất (`desktop/src/main/ipc.ts`). Main process
  chỉ nhận yêu cầu từ trang của ứng dụng (`app://taigent/`) trong cửa sổ của nó: yêu cầu gọi từ nơi khác nhận Failure,
  yêu cầu gửi bị bỏ. Lỗi bất ngờ trong handler cũng thành Failure. Slug dự án được kiểm tra ngay tại ranh giới IPC theo
  đúng một mẫu (`PROJECT_SLUG_PATTERN` trong `src/manifest/conventions.ts`), trước khi thành thư mục hay tham số
  `--project`, nên một slug như `../x` không ra được khỏi thư mục manifest.
- **Terminal không phải ranh giới bảo mật.** Shell và agent trong terminal chạy với đúng quyền của bạn, như một
  terminal bình thường: chúng đọc, sửa file và gọi mạng được, và `npx taigent apply --yes` gõ trong terminal sẽ ghi
  lên Taiga. Ứng dụng chỉ chặn việc ghi ở các nút của chính nó (CLI + hộp thoại xác nhận).
- Renderer chỉ mở được tab **shell** hoặc **agent** (`claude`, `codex`, `omp`), luôn ở thư mục repo đang mở. Nó không
  chọn được lệnh, tham số, thư mục hay biến môi trường. Tab chạy lệnh cho trước (kind `skill`) chỉ main process mở.
  Các kênh terminal cũng đi qua wrapper trên, và main process kiểm tra kiểu từng tham số. Nút chạy skill headless chỉ
  chọn được một trong ba hành động; main process dựng lệnh `run-skill`, kiểm tra dự án có trong repo và từ chối `"`,
  xuống dòng trong văn bản đưa vào yêu cầu.
- Lần chạy skill headless có `TAIGENT_READ_ONLY=1`. Shell của agent và mọi `npx taigent` nó chạy đều kế thừa biến này,
  nên CLI từ chối mọi lệnh ghi lên Taiga (`apply --yes`, `upload --yes`, `bootstrap --yes`, `status`, `comment`; mã
  thoát 2). Việc ghi lên Taiga chỉ đi qua các nút của ứng dụng, sau hộp thoại xác nhận.
- Nội dung do agent viết (Markdown, output trong terminal) không điều khiển được shell: Markdown đã được làm sạch và
  không có script; output của terminal chỉ được xterm.js vẽ ra, không bao giờ được chạy hay chèn vào DOM dạng HTML.
- Môi trường của tab kế thừa từ ứng dụng, không thêm token hay mật khẩu (tab chạy skill headless chỉ thêm
  `TAIGENT_READ_ONLY=1`). Mật khẩu Taiga chỉ nhập trong hộp thoại đăng nhập, không đi qua terminal hay log.
- Đóng tab hoặc thoát ứng dụng kill cả cây process, nên không còn agent nào chạy ngầm sau khi bạn đóng. Các process
  con khác (CLI taigent, `git`, `--version` của công cụ) được ghi vào một danh sách lúc khởi chạy
  (`desktop/src/main/processes.ts`); thoát ứng dụng kill cây process của mọi process còn chạy trong danh sách đó.
- Mục Git chạy `git` bằng `execFile`, không qua shell, với `GIT_TERMINAL_PROMPT=0` (không bao giờ chờ nhập mật khẩu).
  Danh sách file cần add và commit đi qua stdin (`--pathspec-from-file`) và được hiểu đúng nguyên văn
  (`--literal-pathspecs`).
- Wizard **Setup repo** không cho renderer chọn lệnh: renderer chỉ xin "npm install" hoặc "lệnh cài của `git` / `claude`
  / `codex` / `omp`"; main process kiểm tra tên công cụ nằm trong danh sách cố định và tự chọn lệnh, rồi mở tab `skill`
  ở repo. Lệnh cài chỉ chạy khi bạn bấm. Phát hiện công cụ chạy `--version` bằng `execFile`, không qua shell, với timeout
  10 giây. `git init` và `git clone` cũng chạy bằng `execFile` với `GIT_TERMINAL_PROMPT=0` và timeout; URL clone phải
  là URL git hoặc đường dẫn tuyệt đối, không bao giờ bắt đầu bằng `-`, và được đặt sau `--`. Không thông báo nào (URL
  bị từ chối, lỗi của git) chứa thông tin đăng nhập nằm trong URL: `user:token@` hiện thành `***@`.
