# Nghiên cứu: Preview và review một loạt ticket trước khi đẩy lên Taiga

- Ngày khảo sát: 2026-11-02.
- Quy ước: `[n]` là link tới nguồn ở mục **Nguồn**. Đường dẫn dạng `src/planner.ts:103-122` là file và dòng trong repo này, đọc ở commit `634e0b8` (nhánh `master`) cộng các file chưa commit trong working tree. `[INFERENCE]` là suy luận từ nguồn, chưa chạy thử. `[CHƯA KIỂM CHỨNG]` là điều chưa xác minh được. Mục **Đề xuất** là đề xuất, chưa được triển khai.
- Phạm vi: chỉ đọc. Không ghi gì lên Taiga, không chạy `taigent plan/apply/bootstrap/upload`, không sửa code, manifest hay skill.

---

## Câu hỏi

> "Tạo ticket nhanh với AI agent rồi đẩy lên Taiga nhanh là tốt. Nhưng sau khi brainstorm với agent và define xong một loạt ticket đầy đủ, việc **preview trước** rất khó; không có công cụ **comment / preview** thì khó biết ticket đã define ổn chưa, cần đổi gì không."

Cụ thể hơn:

1. Hiện nay người review thấy gì trước khi `apply`?
2. Có những cách nào để (a) đọc cả backlog ở dạng dễ đọc, (b) để lại comment trên từng ticket, và (c) đưa comment đó về cho agent sửa?
3. Taigent nên làm gì, theo thứ tự nào, mà vẫn giữ quy trình plan → review → apply và quy tắc "chỉ CLI được ghi lên Taiga"?

## Tóm tắt kết luận

- **Hôm nay không có bản xem dễ đọc nào của nội dung ticket.**
  - `taigent plan` dạng text in mỗi item một dòng: key và subject khi tạo mới, và chỉ *tên* field khi cập nhật. Nó không in description, acceptance criteria hay task (`src/planner.ts:103-122`, `src/cli.ts:298-310`).
  - Nội dung chỉ có trong `plan --json`, ở dạng chuỗi JSON có `\n` (`docs/cli.md:201-229`).
  - Còn lại là `git diff` của YAML. Với backlog mẫu (8 epic, 63 story, 8 task, 650 dòng) thì đó là một khối toàn dòng thêm mới. Hiện `taiga/` còn chưa được track, nên `git diff` không hiện gì cả (mục Hiện trạng).
- **`validate` không kiểm chất lượng nội dung.** Story chỉ bắt buộc `key` và `subject`; `acceptance_criteria` có thể bỏ trống (`src/manifest/backlog.ts:88-90`, `:130-131`). Các rule đều là rule về tên, tag, key, wiki (`docs/taiga/conventions.md` §2–§9).
- **Mẫu UX tốt nhất trong các tool đã khảo sát là Kiro Markdown Review.** Người review bôi đen một đoạn trong tài liệu đã render, ghi comment, rồi gửi tất cả comment cho agent trong một prompt, kèm đoạn trích và vị trí [36]. Taigent có thể làm gần giống vậy bằng file Markdown sinh từ manifest, cộng comment theo `key`.
- **GitHub Pull Request đã có sẵn phần comment và vòng phản hồi.** PR có comment theo dòng hoặc nhiều dòng, suggested change áp dụng được theo lô, và ba trạng thái review (Comment / Approve / Request changes) [15] [16] [18]. Agent đọc comment theo dòng qua REST `GET /repos/{owner}/{repo}/pulls/{n}/comments` (có `path`, `line`, `body`) [20]. GitHub còn render diff của file Markdown (rich diff) [19].
- **Staging ngay trên Taiga không hợp với quy ước hiện tại.**
  - `apply` không bao giờ xoá, nên ticket nháp bị loại sẽ thành mồ côi (`docs/taiga/conventions.md:28`, `:101`).
  - Manifest không có field status và chỉ cho tag `type:`/`area:` (§4, §6).
  - `taigent comment` chỉ comment được lên ticket của chính mình (`src/ticket.ts:79-83`).
  - Taiga có cho chuyển story, task, epic sang project khác qua `PATCH {project}`, nhưng tài liệu API không ghi điều này, ref bị cấp lại, và task phải chuyển riêng từng cái [8] [9] [10] [11].
- **Các tool spec-driven đều thêm một vòng review tự động trước khi người đọc.**
  - spec-kit: `/speckit.clarify` hỏi tối đa 5 câu; `/speckit.analyze` chỉ đọc, xuất bảng finding có mức độ nghiêm trọng [30] [31].
  - Kiro: "Analyze Requirements" [37].
  - BMAD: subagent với context mới chạy checklist trên bản nháp trước khi duyệt [38].
  - Taigent nên có một bước tương tự, dùng INVEST [42], mẫu §6 của conventions, và Gherkin [43] nếu team dùng.
- **Đề xuất:** (1) thêm lệnh offline `taigent preview` render manifest thành một file Markdown, dùng đúng hàm tạo description mà `apply` ghi lên Taiga; (2) thêm skill `taiga-review-backlog`: lint cộng một lượt LLM review, rồi nhận comment theo `key` (trong chat, hoặc từ PR qua `gh api`) và chuyển cho `taiga-plan-backlog` sửa; (3) PR trên GitHub là kênh review cho team. Không dùng staging trên Taiga.

---

## Hiện trạng

### H1. Quy trình và chỗ "review" hiện nay

- Quy trình gồm ba bước. **Plan** chỉ ghi file `taiga/<slug>/*.yaml` và kết thúc bằng `taigent validate`. **Review** nghĩa là người dùng "duyệt diff manifest trong git như duyệt code, rồi chạy `taigent plan`". **Apply** chỉ chạy sau khi người dùng đồng ý tường minh (`docs/taiga/conventions.md:12-25`).
- Skill `taiga-plan-backlog` kết thúc bằng báo cáo trong chat: các key đã thêm, các key đã đổi kèm field, các item spec không còn nhắc tới, và bước tiếp theo "review `git diff taiga/<slug>/`" (`.agents/skills/taiga-plan-backlog/SKILL.md:62-69`).
- Skill `taiga-apply-backlog` in nguyên output của `plan`. Khi có `update`, nó chạy thêm `plan --json` để hiện `field: from → to` (`.agents/skills/taiga-apply-backlog/SKILL.md:31-35`). Đây là chỗ duy nhất người dùng thấy giá trị cũ và mới của nội dung, và chỉ có ở *ngay trước khi apply*.

### H2. `plan` in ra gì

`describePlanOperation` (`src/planner.ts:103-122`) dựng mỗi dòng như sau:

| Action | Dòng text | Có nội dung không? |
|---|---|---|
| `create` | `create story AUTH-LOGIN  "<subject>"  (in epic AUTH)` | Chỉ có subject, không có description, AC hay spec |
| `update` | `update story AUTH-LOGIN  (#12, id 345): description, tags` | Chỉ có **tên** field, không có giá trị |
| `link` | `link   story AUTH-LOGIN -> epic AUTH` | Không |
| `skip` | `story AUTH-LOGIN  (#12, id 345, unchanged)` | Không |

- `formatPlanText` nối các dòng trên, thêm orphan/stale link và một dòng đếm (`src/cli.ts:298-310`, `:324-340`). `--json` in nguyên object `Plan` (`src/cli.ts:343-345`). Ở đó `create.fields.description` là description đã ghép xong, còn `update.changes.description` có `{from, to}` (`docs/cli.md:201-229`).
- `plan` phải đọc Taiga: `runPlan` gọi `connectTaiga` và `readBacklogRemote` trước khi in (`src/cli.ts:473-479`). Project chưa bootstrap hoặc không có mạng thì không có `plan`. Khi đó skill vẫn cho plan offline và chỉ nhắc `taiga-bootstrap-project` (`.agents/skills/taiga-plan-backlog/SKILL.md:29`, `:39`).
- Description của story trên Taiga được ghép bởi `storyDescription` (`src/planner.ts:125-133`): description, rồi `## Acceptance criteria` dạng checklist `- [ ]`, rồi `Spec: …` (`docs/cli.md:102-115`, `docs/taiga/conventions.md:118-129`). Hàm này **không được export**, và không lệnh nào in kết quả của nó ở dạng dễ đọc.

Kết luận: trong repo **không có** bản render dễ đọc nào cho toàn bộ epic → story → AC → task. (Đã tìm trong `src/`: chỉ có `describePlanOperation`, `describeAppliedOperation` và `formatTicketsText` của lệnh `tickets`.)

### H3. Vì sao review backlog lớn bằng YAML diff và `plan` thì khó

1. **Kích thước.** `taiga/internal-taigent/backlog.yaml` có 650 dòng, 8 epic, 63 story, 8 task, mỗi story có tới 4 AC (đếm bằng `yaml.parse` trên file). Lần đầu tạo thì diff toàn dòng `+`; người review phải đọc YAML thô, nơi chuỗi nằm trong ngoặc kép và thụt lề 6–12 dấu cách (`taiga/internal-taigent/backlog.yaml:10-35`).
2. **Không thấy được thứ sẽ lên Taiga.** Taiga hiện description đã ghép theo mẫu, còn YAML tách thành `description`, `acceptance_criteria`, `spec`. Người review phải tự hình dung phần ghép (`src/planner.ts:125-133`).
3. **`plan` text không có nội dung** (bảng H2). `plan --json` có nội dung nhưng là chuỗi JSON một dòng có `\n`.
4. **Manifest chưa track thì không có diff.** `git status` cho thấy `?? taiga/`. `git diff --stat -- taiga/` không in gì và `git ls-files taiga` trả 0 file (chạy trên working tree hiện tại). Bước "duyệt diff trong git" chỉ có tác dụng sau khi đã `git add` hoặc commit.
5. **Không có chỗ để comment.** Không lệnh hay skill nào nhận góp ý theo ticket. Phản hồi hiện chỉ đi qua chat với agent, và không có gì neo nó vào `key`.
6. **`validate` không bắt lỗi nội dung.** Các rule offline là `project-*`, `template`, `module-*`, `tag-*`, `key-*`, `wiki-*`, `attachment-name`, `file-exists`, cộng lỗi schema (`docs/taiga/conventions.md` §2–§9, `src/manifest/backlog.ts:80-104`). Story thiếu AC, AC mơ hồ hay description không theo mẫu "Là …, tôi muốn …, để …" (§6) vẫn qua `validate`.
7. **Sửa sau khi apply thì tốn công.** Key không đổi được sau khi đã apply (`docs/taiga/conventions.md:98`). Item bỏ khỏi manifest không bị xoá mà thành mồ côi (`:101`). Story chuyển epic thì liên kết cũ vẫn còn (`:102-104`). Vì vậy review **trước** apply quan trọng hơn sửa sau.

Thêm một điều không khớp: skill `user-story` (đang chưa track) viết AC theo Gherkin Given/When/Then (`.agents/skills/user-story/SKILL.md:46-51`). Trong khi đó conventions §6 yêu cầu "mỗi tiêu chí là một câu kiểm được" (`docs/taiga/conventions.md:116`), và backlog mẫu dùng câu thường. Working tree không có `docs/adr/` nào ghi quyết định về định dạng này `[CHƯA KIỂM CHỨNG]`.

---

## Các phương án

Mỗi phương án được xét theo: cơ chế, người review thấy gì, comment quay về agent ra sao, chi phí làm trong Taigent, và mức phù hợp với plan → review → apply cùng quy tắc "chỉ CLI ghi lên Taiga" (`docs/taiga/conventions.md:14`).

### a. Render manifest thành Markdown hoặc HTML ngay trên máy

**Cơ chế.** Một lệnh offline, ví dụ `taigent preview --project <slug>`, đọc `backlog.yaml` qua `loadManifests` rồi in ra Markdown theo cấu trúc epic → story → task. Manifest đã đủ dữ liệu để render (`src/manifest/backlog.ts:13-38`):

| Loại | Field có sẵn |
|---|---|
| Epic | `key`, `subject`, `description`, `tags`, `custom_attributes`, `stories` |
| Story | các field trên + `acceptance_criteria[]`, `spec`, `tasks` |
| Task | `key`, `subject`, `description` (định nghĩa done), `tags`, `custom_attributes` |

Cộng thêm: `state.json` cho biết key nào đã apply (`docs/cli.md:133-145`), nên preview đánh dấu được "mới" hay "đã có trên Taiga" mà không cần mạng. `docs.yaml` cho biết attachment gắn vào key nào (`docs/cli.md:120-131`).

**Người review thấy gì.** Một trang đọc như tài liệu: mục lục theo epic; mỗi story có heading `KEY — subject`, tag, câu user story, checklist AC giống hệt trên Taiga (nếu render bằng chính `storyDescription`), rồi danh sách task kèm "Done khi". Mở bằng Markdown preview của VS Code (`Ctrl+Shift+V`, hoặc `Ctrl+K V` để xem cạnh bên) [45], hoặc xem trên GitHub. Có thể thêm bảng tóm tắt: số story, story thiếu AC, story không có task, key mới.

**Comment quay về agent ra sao.** Bản thân render không có chỗ comment. Có ba cách:

- Ghi trong chat theo key, ví dụ "SETUP-TOKEN: thêm AC khi token hết hạn". Heading có key nên neo được vào item.
- Dùng một file góp ý (ví dụ `taiga/<slug>/review.md`, mỗi dòng `KEY: góp ý`) để agent đọc. Đây là cách làm theo Kiro, nơi comment được gửi kèm đoạn trích và vị trí [36].
- Kết hợp với PR (phương án b).

**Chi phí làm.** Thấp `[INFERENCE]`:

- Một module render thuần, một case trong `dispatch`, và export `storyDescription` từ `src/planner.ts`.
- Không cần client Taiga. `docs/cli.md` mô tả kiểu reader → planner → executor; ở đây chỉ cần loader và renderer (`docs/cli.md:675-676`).
- Thêm test qua harness CLI, đúng cách test hiện có (`docs/cli.md:684-687`).

**Mức phù hợp.** Cao. Lệnh chỉ đọc file, không chạm Taiga, nằm ở bước Review. Không cần đổi quy ước.

### b. Review bằng GitHub Pull Request (manifest, và có thể kèm file .md đã render)

**Cơ chế.** Agent làm việc trên một nhánh, commit `backlog.yaml` (và file preview nếu có), rồi mở PR. Repo đã có remote `github.com/sondoquang/taigent`.

**Người review thấy gì** (GitHub docs):

- Comment trên một dòng hoặc một khoảng dòng (click số dòng đầu, Shift+click dòng cuối). Comment trên cả file cũng được. Comment gom vào một review đang chờ, rồi gửi kèm một trong ba trạng thái: **Comment**, **Approve**, **Request changes** [15] [16] [17].
- Đánh dấu file đã xem là **Viewed**; thanh tiến độ cho biết đã xem bao nhiêu file [16].
- **Suggested change**: người review sửa trực tiếp trong khối suggestion; tác giả bấm "Commit suggestion" hoặc gom nhiều suggestion thành một commit ("Add suggestion to batch") [16] [18].
- File Markdown có hai chế độ xem diff: source và rendered ("rich diff") [19]. Comment theo dòng trong chế độ rendered có làm được không thì tài liệu không nói `[CHƯA KIỂM CHỨNG]`. Chế độ source của file `.md` vẫn đọc được và comment theo dòng được.
- "Request changes" chỉ mang tính thông tin. Nó không chặn merge, trừ khi có ruleset hoặc branch protection [16].

**Comment quay về agent ra sao.**

- `gh pr view --comments` in "comments, and reviews". `--json` có các field `comments`, `reviews`, `latestReviews`, `reviewDecision` [21]. Comment theo dòng có nằm trong output này không thì tài liệu không nói `[CHƯA KIỂM CHỨNG]`.
- Comment theo dòng chắc chắn lấy được qua REST "List review comments on a pull request", gọi bằng `gh api repos/{owner}/{repo}/pulls/{n}/comments` [20] [23]. Mỗi comment có `path`, `line`/`start_line`, `side`, `body`. Agent ánh xạ `path` và dòng về key trong YAML hoặc trong file preview, sửa `backlog.yaml`, rồi push lên cùng nhánh.
- Agent hoặc người dùng có thể gửi review qua `gh pr review --comment|--approve|--request-changes -b …` [22].
- Muốn tự động hơn: Claude Code GitHub Actions phản hồi khi có `@claude` trong comment PR hoặc PR review (trigger `issue_comment`, `pull_request_review_comment`) [24]. Cách này chạy agent trong CI, tức là thêm một nơi có quyền ghi repo. Nó vẫn không ghi Taiga, nếu workflow không có secret Taiga `[INFERENCE]`.

**Một điểm cần lưu ý.** Nếu file preview được sinh từ YAML thì suggestion áp lên file preview sẽ bị ghi đè ở lần render sau. Suggestion phải đặt trên `backlog.yaml`, còn file preview chỉ dùng để đọc và comment `[INFERENCE]`. Nếu commit file preview, cần một cách kiểm nó còn khớp YAML hay không, giống `taigent skills check` trả exit 3 khi bản sao lệch (`docs/cli.md:586-587`).

**Chi phí làm.** Thấp nếu chỉ dùng PR có sẵn: không cần sửa code, chỉ cần skill hướng dẫn mở PR và đọc comment. Trung bình nếu thêm việc commit file preview và lệnh `--check`.

**Mức phù hợp.** Cao. Merge PR là bằng chứng đã duyệt, sau đó mới chạy `taiga-apply-backlog`; quy tắc `--yes` vẫn giữ nguyên (`docs/taiga/conventions.md:24-25`). Điều kiện là người review phải có tài khoản GitHub và quyền đọc repo [15].

### c. Staging ngay trên Taiga (status hoặc tag nháp, project sandbox, comment trên Taiga, rồi chuyển sang project thật)

**Taiga có những gì** (tài liệu API và mã nguồn taiga-back):

- **Status.** Tạo bằng `POST /userstory-statuses` `{name, project, is_closed, color, order, wip_limit}` [4]. Object status có `is_closed` và `is_archived` [5]. Template mặc định có `Archived` với `is_closed: true, is_archived: true` [12]. API user story lọc được theo `status__is_archived` và `status__is_closed` [13].
- **Comment.** Gửi `comment` kèm `PATCH` item thì taiga-back ghi comment vào history (`persist_history_snapshot` đọc `request.DATA["comment"]`) [7]. Đọc lại bằng `GET /history/userstory/{id}`; history áp dụng cho user story, task, issue và wiki page. Comment sửa hoặc xoá được qua `edit_comment` và `delete_comment` [1] [2] [3]. Taigent đã dùng đúng cơ chế này cho `taigent comment` (`src/taiga/client.ts:343-347`, `:711-714`).
- **Chuyển giữa các project.** `PATCH /userstories/{id}` với `project` khác thì taiga-back kiểm quyền `destroy` ở project cũ và `create` ở project mới, rồi ánh xạ status theo slug [8]. Task và epic có logic tương tự [9] [10]. Task bị từ chối nếu `user_story` thuộc project khác [9], nên phải chuyển story trước rồi đến từng task. Khi đổi project, item được cấp `ref` mới [11]. Tài liệu API (mục Edit) không ghi khả năng này [6], nên đây là hành vi chưa được tài liệu hoá `[CHƯA KIỂM CHỨNG trên instance]`.
- **Project sandbox.** `POST /projects/{id}/duplicate` clone cấu trúc project [14].

**Vướng gì với Taigent.**

- Manifest không có field status (`docs/taiga/conventions.md:108`). Tag chỉ được bắt đầu bằng `type:` hoặc `area:` (rule `tag-prefix`, `:82`). Muốn có status `Draft` hay tag `review:draft` thì phải đổi cả quy ước lẫn `conventions.ts` (`:8`). Tạo status mới còn cần quyền project admin `[INFERENCE, theo docs/research/taiga-agent-automation.md:265]`.
- `apply` không bao giờ xoá (`:28`). Ticket nháp bị loại sẽ nằm lại thành mồ côi (`:101`). Sửa key sau khi đã apply cũng sinh item mới (`:98`). Tức là Taiga sẽ đầy rác của những vòng review.
- Comment của người review trên Taiga thì agent đọc được qua MCP `listComments` (`docs/research/taiga-agent-automation.md:76`; MCP được dùng để đọc và comment, `docs/taiga/conventions.md:14`). Nhưng `taigent comment` từ chối story không giao cho người đang đăng nhập (`src/ticket.ts:1-2`, `:79-83`), và ticket nháp thì thường chưa giao cho ai.
- Chuyển từ sandbox sang project thật: CLI không có lệnh nào làm việc này, và các tool MCP ghi bị cấm dùng cho backlog (`docs/taiga/conventions.md:204-207`). Viết lệnh mới thì phải xử lý ref đổi, task chuyển riêng, liên kết epic. Còn `src:` tag đi theo item nên `plan` ở project thật sẽ khớp được `[INFERENCE]`. History có giữ nguyên sau khi chuyển không thì chưa rõ `[CHƯA KIỂM CHỨNG]`.
- Một biến thể nhẹ hơn: đưa file preview (phương án a) lên Taiga thành một trang wiki qua `docs.yaml` và `taigent upload`. Rule `wiki-slug` chỉ yêu cầu kebab-case (`docs/taiga/conventions.md:165`). API có history và comment cho wiki page [1]. Giao diện Taiga có cho comment trên wiki không thì chưa kiểm `[CHƯA KIỂM CHỨNG]`. Cách này giúp người không dùng GitHub đọc được, nhưng comment trên một trang wiki không neo được vào từng ticket.

**Chi phí làm.** Cao: đổi quy ước, thêm lệnh promote, dọn mồ côi bằng tay.

**Mức phù hợp.** Thấp. Ghi lên Taiga trước khi duyệt là ngược với quy trình plan → review → apply. Riêng biến thể wiki thì phù hợp ở mức trung bình.

### d. Vòng review ngay trong agent (plan mode, câu hỏi, tool spec-driven)

**Claude Code.**

- **Plan mode**: Claude đọc file, chạy lệnh để tìm hiểu và viết plan, nhưng không sửa source cho tới khi người dùng duyệt. Chuyển chế độ bằng Shift+Tab hoặc `/plan`. `Ctrl+G` mở plan trong editor để sửa trước khi Claude làm tiếp [25].
- **`AskUserQuestion`** hỏi câu trắc nghiệm để làm rõ yêu cầu. **`ExitPlanMode`** trình plan để duyệt [26].
- **Subagent** chạy trong context riêng, có system prompt, tool và quyền riêng [27]. Hợp để làm reviewer độc lập.

**Codex.**

- `/plan` hoặc Shift+Tab chuyển sang plan mode. Ở đó Codex "gather context, ask clarifying questions, and build a stronger plan before implementation" [28] [29].
- `/review` review working tree (thay đổi chưa commit, hoặc so với nhánh gốc) [28].

**spec-kit** (`github/spec-kit`):

- `/speckit.clarify` hỏi **tối đa 5** câu, mỗi lần một câu (trắc nghiệm hoặc trả lời ≤5 từ), rồi ghi câu trả lời vào spec [30].
- `/speckit.analyze` "STRICTLY READ-ONLY". Nó chạy các lượt kiểm Duplication, Ambiguity (tính từ mơ hồ như "fast", "secure"), Underspecification (story không khớp AC), Coverage gaps (yêu cầu chưa có task) và Inconsistency, gán mức CRITICAL/HIGH/MEDIUM/LOW, xuất một bảng `ID | Category | Severity | Location | Summary | Recommendation`, và chỉ đề xuất sửa khi người dùng đồng ý [31].
- `/speckit.checklist` tạo checklist kiểu "unit tests for English" cho phần yêu cầu [32].
- `taskstoissues` (đã deprecated) đẩy task lên GitHub Issues và bỏ qua task đã có issue. Đây là cùng ý tưởng chống trùng như `src:<key>` [33].

**Kiro.**

- Mỗi spec gồm `requirements.md` (hoặc `bugfix.md`), `design.md`, `tasks.md`, làm qua ba pha [34]. Requirements viết theo EARS (`WHEN … THE SYSTEM SHALL …`) [35].
- Ở mỗi pha có nút **Review**, mở **Markdown Review**: bôi đen đoạn trong bản render, ghi comment, rồi "Send N to Kiro". Kiro nhận tất cả comment trong một prompt, kèm đoạn trích và vị trí. Comment nào trỏ tới đoạn đã thay đổi thì được đánh dấu "document updated" [36].
- **Analyze Requirements** suy luận trên toàn bộ tập yêu cầu (mâu thuẫn logic, mơ hồ, ràng buộc xung đột, giả định ngầm, thiếu edge case) và đặt câu hỏi kèm gợi ý sửa [37].

**BMAD Method** (agent PO "Sofia"):

- Bản nháp `tickets.toml` luôn được validate trước khi duyệt. Việc validate do subagent với context mới chạy, theo các mục Ticket, Set, Tree, Dependencies. Kết quả chia thành *fix* (sửa máy móc), *suggest* (kèm lý do) và *ask the user* [38] [39].
- Một câu "yes" là duyệt thứ vừa trình bày. Publish lên tracker là một câu "yes" riêng [40] [41].

**Chung lại.**

- Người review thấy các câu hỏi và bảng finding trong chat. Chỉ Kiro có giao diện comment trên tài liệu đã render.
- Comment quay về agent ngay trong phiên chat, nên không cần thêm hạ tầng. Đổi lại, phản hồi không được lưu lại để người khác trong team cùng xem `[INFERENCE]`.
- Chi phí làm: thấp, chỉ là skill hoặc subagent; không cần sửa CLI.
- Mức phù hợp: cao. Nó nằm trọn trong bước Plan/Review, chỉ đọc file và Taiga.

### e. Kiểm chất lượng tự động trước khi người đọc

**Bộ tiêu chí.**

- **INVEST** (Bill Wake, 2003): Independent, Negotiable, Valuable, Estimable, Small, Testable. Task theo **SMART**; tiêu chí "Measurable" ở đây là "can we mark it as done?" [42]. Điều này khớp với yêu cầu "Done khi: …" của task (`docs/taiga/conventions.md:131-136`).
- **Gherkin**: từ khoá `Feature`, `Rule`, `Scenario`/`Example`, `Given`/`When`/`Then`/`And`/`But`, `Background`, `Scenario Outline`/`Examples`. Gherkin đã được dịch sang hơn 70 ngôn ngữ [43]. Tiếng Việt có `Biết`/`Cho`, `Khi`, `Thì`, `Và`, `Nhưng`, `Tình huống`/`Kịch bản` [44].

**Hai lớp kiểm.**

1. **Lint xác định** (code, cho cùng kết quả mỗi lần chạy), ví dụ:
   - story không có AC;
   - description không khớp mẫu "Là …, tôi muốn …, để …" (§6);
   - task thiếu "Done khi";
   - AC trùng nhau;
   - AC chứa từ mơ hồ (danh sách giống spec-kit Ambiguity [31]);
   - nếu team chọn Gherkin: mỗi AC có đủ Given/When/Then và chỉ một When (`.agents/skills/user-story/SKILL.md:147-151`).

   Nếu đưa các kiểm này vào `validate` (lỗi trả exit 4) thì sẽ chặn cả `plan`/`apply` (`docs/taiga/conventions.md:27`). Vì vậy nên để chúng là **cảnh báo không chặn**, in trong preview hoặc một lệnh riêng `[INFERENCE]`.

2. **Lượt LLM reviewer** (không xác định): một subagent chỉ đọc [27] chấm từng story theo INVEST, §6 và độ phủ của spec; xuất bảng finding theo key, giống `/speckit.analyze` [31]; rồi chia finding thành fix / suggest / hỏi người dùng như BMAD [38].

**Người review thấy gì.** Một bảng vấn đề xếp theo mức độ, mỗi dòng trỏ tới một key, đọc trước khi mở bản preview.

**Comment quay về agent ra sao.** Người dùng chọn finding nào cần sửa, rồi `taiga-plan-backlog` sửa đúng các key đó.

**Chi phí làm.** Lint: thấp đến trung bình (code thuần, có test). LLM pass: thấp (một skill hoặc subagent).

**Mức phù hợp.** Cao. Cả hai đều offline và chỉ đọc file. Kết quả LLM nên coi là gợi ý, không phải cổng chặn `[INFERENCE]`.

---

## Bảng so sánh

Chi phí là ước lượng `[INFERENCE]` dựa trên cấu trúc code đã đọc, chưa tính giờ cụ thể.

| Phương án | Chi phí làm | Trải nghiệm người review | Vòng comment → agent | Rủi ro | Hợp với plan → review → apply và "chỉ CLI ghi Taiga" |
|---|---|---|---|---|---|
| **a. `taigent preview` (Markdown cục bộ)** | Thấp: renderer thuần, export `storyDescription` | Tốt: đọc như tài liệu, giống hệt description trên Taiga; xem bằng VS Code/GitHub | Thủ công: chat hoặc file góp ý theo `key` | Thấp; preview commit vào repo có thể lệch YAML (thêm `--check` là xử lý được) | Rất hợp: offline, chỉ đọc |
| **b. GitHub PR** | Thấp nếu chỉ dùng PR; TB nếu commit preview kèm `--check` | Tốt cho team: comment theo dòng, suggestion, Approve/Request changes; cần tài khoản GitHub | Tốt: `gh api …/pulls/{n}/comments` có `path`/`line`/`body`; có thể tự động bằng `@claude` | Suggestion trên file preview sẽ mất; "Request changes" không chặn merge nếu không cấu hình | Rất hợp: merge = duyệt, `apply --yes` vẫn hỏi riêng |
| **c. Staging trên Taiga** | Cao: đổi quy ước, lệnh promote, dọn mồ côi | Quen thuộc với người chỉ dùng Taiga | Đọc được bằng MCP `listComments`; `taigent comment` chỉ dùng cho ticket của mình | Cao: rác mồ côi, ref đổi khi chuyển project, API chuyển project chưa có tài liệu | Kém: ghi lên Taiga trước khi duyệt; đụng §4, §6, §10 |
| c'. Preview thành trang wiki | Thấp–TB (dùng `upload` có sẵn) | Đọc được trên Taiga | Comment trên wiki chưa kiểm chứng, không neo được theo ticket | Thấp–TB | Trung bình: `upload` vẫn qua CLI và `--yes` |
| **d. Vòng review trong agent** | Thấp: skill hoặc subagent | Trong chat: câu hỏi, bảng finding | Tức thì trong phiên, nhưng không lưu lại cho team | Thấp | Rất hợp |
| **e. Lint và LLM reviewer** | Lint thấp–TB; LLM thấp | Bảng vấn đề theo key, xếp theo mức độ | Chọn finding → `taiga-plan-backlog` sửa | LLM có thể sai hoặc thiếu; lint không được chặn `plan` | Rất hợp, nếu là cảnh báo không chặn |

---

## Đề xuất

> **Đây là đề xuất, chưa triển khai.** Thứ tự dưới đây xếp theo giá trị trên chi phí. Mỗi bước dùng được ngay khi xong, không cần chờ bước sau.

Hướng chung: kết hợp a + e + d làm vòng review cá nhân, và b làm kênh review cho team. Không làm c.

### Bước 1: `taigent preview` (offline)

- **CLI**
  - Thêm lệnh `taigent preview --project <slug> [--out <file>] [--json]` vào `COMMANDS` (`src/cli.ts:76`). Lệnh cần `--project` nhưng không cần `TAIGA_*`, vì nó offline như `validate`.
  - Mặc định in Markdown ra stdout. `--out` ghi ra file, ví dụ `taiga/<slug>/backlog.preview.md`.
- **Renderer**
  - Module mới `src/preview.ts`, là hàm thuần nhận `Backlog`, `state.json` (tuỳ chọn) và `docs.yaml` (tuỳ chọn), trả về chuỗi Markdown.
  - Export `storyDescription` từ `src/planner.ts:125-133` và dùng lại nó, để phần thân mỗi story **giống hệt** thứ `apply` sẽ ghi lên Taiga.
- **Định dạng**
  - Mục lục theo epic.
  - Mỗi item một heading `### <KEY> · <subject>`, kèm tag, nhãn `mới` (key không có trong `state.json`) hoặc `#<ref>` (đã apply), attachment theo `docs.yaml`.
  - Task là danh sách `KEY · subject: Done khi …`.
  - Đầu trang có bảng tóm tắt: số epic, story, task; số key mới; story không có AC; story không có task.
- **Tài liệu**
  - `docs/cli.md`: thêm mục Commands và hàng mới trong Code map.
  - `docs/taiga/conventions.md` §1, bước Review: "chạy `taigent preview` để đọc toàn bộ ticket".
- **Test**: qua harness CLI (`test/support/harness.ts`), giống các lệnh khác.

Ví dụ phần thân một story trong preview (dựng từ `taiga/internal-taigent/backlog.yaml:46-53` theo mẫu `storyDescription`):

```markdown
### SETUP-TOKEN · Hỗ trợ TAIGA_TOKEN thay cho mật khẩu
`type:feature` · mới

Là thành viên team, tôi muốn CLI hỗ trợ TAIGA_TOKEN thay cho mật khẩu, để sau này chuyển sang token mà không phải đổi quy trình.

## Acceptance criteria

- [ ] Có TAIGA_TOKEN thì CLI gửi token đó và không cần TAIGA_PASSWORD.
- [ ] Không có TAIGA_TOKEN thì CLI đăng nhập bằng TAIGA_USERNAME/TAIGA_PASSWORD như trước.

Spec: https://github.com/sondoquang/taigent/issues/1
```

### Bước 2: skill `taiga-review-backlog` (model hoặc user, chỉ đọc)

- **`allowed-tools`**: `npx taigent validate *`, `npx taigent preview *`, và `gh api *`/`gh pr view *` cho bước 4. Không thêm lệnh ghi Taiga nào. Skill này không phải loại user-only, vì không pre-approve `apply`/`bootstrap`/`upload` (`docs/cli.md:607-612`).
- **Các bước**
  1. Chạy `validate`, rồi `preview --out`.
  2. Chạy lượt kiểm chất lượng: lint xác định (bước 3, nếu đã có) cộng một subagent chỉ đọc chấm theo INVEST [42], conventions §6, và độ phủ spec → story, theo mẫu bảng của `/speckit.analyze` [31].
  3. Trình bảng finding theo key, chia fix / suggest / hỏi như BMAD [38]. Hỏi tối đa vài câu quan trọng nhất, như `/speckit.clarify` [30].
  4. Nhận comment theo `KEY: …`, từ chat, từ file góp ý, hoặc từ PR (`gh api repos/{owner}/{repo}/pulls/{n}/comments` [20]).
  5. Chuyển comment cho `taiga-plan-backlog` sửa đúng các key đó (skill này đã quy định sửa tại chỗ và giữ key, `.agents/skills/taiga-plan-backlog/SKILL.md:46-51`). Sau đó render lại preview.
- **Sửa các skill hiện có**
  - `taiga-plan-backlog` §5 Report: bước tiếp theo là `taiga-review-backlog` (hoặc `taigent preview`), rồi mới tới `taiga-apply-backlog`.
  - Router `ask-taigent`: thêm skill mới.
  - Chạy `taigent skills sync`, cập nhật bảng skill trong `docs/cli.md:595-605`.

### Bước 3: lint nội dung không chặn

- Thêm hàm kiểm chất lượng: story thiếu AC; description không theo mẫu "Là …, tôi muốn …, để …"; task thiếu "Done khi"; AC trùng; từ mơ hồ; tuỳ chọn kiểm Gherkin, nhận cả từ khoá tiếng Việt [44].
- Kết quả là **cảnh báo**, in trong bảng tóm tắt của `preview` (và `preview --json`). Không đưa vào `validate`, để `plan`/`apply` không bị chặn (`docs/taiga/conventions.md:27`).
- Trước khi làm, team cần chốt AC viết bằng câu thường (§6 hiện tại) hay Gherkin (skill `user-story`). Ghi quyết định vào ADR, sửa `conventions.md` cùng commit (`docs/taiga/conventions.md:8`).

### Bước 4: PR làm kênh review của team (tuỳ chọn)

- Mở rộng `taiga-plan-backlog`, hoặc thêm một bước trong `taiga-review-backlog`: tạo nhánh, commit manifest và `backlog.preview.md`, mở PR.
  - Comment để đọc thì đặt trên file preview.
  - Sửa chữ thì dùng suggestion trên `backlog.yaml` [18].
- Thêm `taigent preview --project <slug> --check`: exit 3 khi file preview đã commit lệch so với YAML, giống `skills check` (`docs/cli.md:586-587`). Đưa vào `npm test` hoặc CI.
- Sau khi PR được merge: `taiga-apply-backlog` vẫn chạy `plan`, trình kết quả và hỏi "yes" riêng (`.agents/skills/taiga-apply-backlog/SKILL.md:31-42`).
- Tuỳ chọn: workflow Claude Code GitHub Actions trả lời `@claude` trên comment PR để sửa YAML [24]. Không cấp secret Taiga cho workflow này `[INFERENCE]`.

### Không đề xuất

Staging trên Taiga (status hoặc tag nháp, project sandbox rồi chuyển project), vì các lý do ở mục c.

- Nếu có người review không dùng GitHub, cân nhắc biến thể c': đưa file preview lên làm trang wiki qua `docs.yaml` + `taigent upload --yes`.
- Trước đó cần kiểm trên `taiga.vidratek.net` xem wiki có comment được không `[CHƯA KIỂM CHỨNG]`.

### Những điểm còn mở

| # | Điểm | Cách đóng |
|---|---|---|
| 1 | Comment theo dòng trong chế độ rich diff của GitHub có làm được không [19] | Thử trên một PR có file `.md` |
| 2 | `gh pr view --comments`/`--json comments,reviews` có trả comment theo dòng không [21] | Thử, hoặc chỉ dùng REST [20] |
| 3 | Chuyển item giữa project trên instance: hành vi thực tế với task con, liên kết epic, history [8] [9] [11] | Chỉ cần nếu chọn c; thử trên project test |
| 4 | Giao diện Taiga có cho comment trên wiki page không [1] | Mở một trang wiki trên instance |
| 5 | AC viết bằng câu thường hay Gherkin | Quyết định của team, ghi vào ADR |
| 6 | File preview có commit vào repo không, hay chỉ sinh khi cần | Quyết định; nếu commit thì cần `--check` |

---

## Nguồn

Repo (đọc trực tiếp): `docs/taiga/conventions.md`, `docs/cli.md`, `.agents/skills/taiga-plan-backlog/SKILL.md`, `.agents/skills/taiga-apply-backlog/SKILL.md`, `.agents/skills/user-story/SKILL.md`, `src/cli.ts`, `src/planner.ts`, `src/manifest/backlog.ts`, `src/manifest/yaml.ts`, `src/ticket.ts`, `src/taiga/client.ts`, `taiga/internal-taigent/backlog.yaml`, `docs/research/taiga-agent-automation.md`. Lệnh chỉ đọc đã chạy: `git status --short`, `git diff --stat -- taiga/`, `git ls-files taiga`, `git remote -v`, và đếm item bằng `yaml.parse`.

[1]: https://docs.taiga.io/api.html#history-get
[2]: https://docs.taiga.io/api.html#history-edit-comment
[3]: https://docs.taiga.io/api.html#object-history-entry-detail
[4]: https://docs.taiga.io/api.html#user-story-statuses-create
[5]: https://docs.taiga.io/api.html#object-userstory-status-detail
[6]: https://docs.taiga.io/api.html#user-stories-edit
[7]: https://github.com/kaleidos-ventures/taiga-back/blob/675f652ed9be0b1485ab9983d70455f638dba036/taiga/projects/history/mixins.py#L44-L65
[8]: https://github.com/kaleidos-ventures/taiga-back/blob/675f652ed9be0b1485ab9983d70455f638dba036/taiga/projects/userstories/api.py#L310-L340
[9]: https://github.com/kaleidos-ventures/taiga-back/blob/675f652ed9be0b1485ab9983d70455f638dba036/taiga/projects/tasks/api.py#L98-L108 ; https://github.com/kaleidos-ventures/taiga-back/blob/675f652ed9be0b1485ab9983d70455f638dba036/taiga/projects/tasks/api.py#L178-L205
[10]: https://github.com/kaleidos-ventures/taiga-back/blob/675f652ed9be0b1485ab9983d70455f638dba036/taiga/projects/epics/api.py#L124-L143
[11]: https://github.com/kaleidos-ventures/taiga-back/blob/675f652ed9be0b1485ab9983d70455f638dba036/taiga/projects/references/models.py#L93-L111
[12]: https://github.com/kaleidos-ventures/taiga-back/blob/675f652ed9be0b1485ab9983d70455f638dba036/taiga/projects/fixtures/initial_project_templates.json#L113-L121
[13]: https://github.com/kaleidos-ventures/taiga-back/blob/675f652ed9be0b1485ab9983d70455f638dba036/taiga/projects/userstories/api.py#L74-L80
[14]: https://docs.taiga.io/api.html#projects-duplicate
[15]: https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/about-pull-request-reviews
[16]: https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/reviewing-proposed-changes-in-a-pull-request
[17]: https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/commenting-on-a-pull-request
[18]: https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/incorporating-feedback-in-your-pull-request
[19]: https://docs.github.com/en/repositories/working-with-files/using-files/working-with-non-code-files#rendering-differences-in-prose-documents
[20]: https://docs.github.com/en/rest/pulls/comments#list-review-comments-on-a-pull-request
[21]: https://cli.github.com/manual/gh_pr_view
[22]: https://cli.github.com/manual/gh_pr_review
[23]: https://cli.github.com/manual/gh_api
[24]: https://code.claude.com/docs/en/github-actions
[25]: https://code.claude.com/docs/en/permission-modes#analyze-before-you-edit-with-plan-mode
[26]: https://code.claude.com/docs/en/tools-reference
[27]: https://code.claude.com/docs/en/sub-agents
[28]: https://developers.openai.com/codex/cli/slash-commands
[29]: https://developers.openai.com/codex/learn/best-practices
[30]: https://github.com/github/spec-kit/blob/7370e592f3cd9c06e5b698983957e227c75b30e2/templates/commands/clarify.md
[31]: https://github.com/github/spec-kit/blob/7370e592f3cd9c06e5b698983957e227c75b30e2/templates/commands/analyze.md
[32]: https://github.com/github/spec-kit/blob/7370e592f3cd9c06e5b698983957e227c75b30e2/templates/commands/checklist.md
[33]: https://github.com/github/spec-kit/blob/7370e592f3cd9c06e5b698983957e227c75b30e2/templates/commands/taskstoissues.md
[34]: https://kiro.dev/docs/specs/
[35]: https://kiro.dev/docs/specs/feature-specs/
[36]: https://kiro.dev/docs/ide/editor/markdown-review/
[37]: https://kiro.dev/docs/specs/analyze-requirements/
[38]: https://github.com/bmad-code-org/BMAD-METHOD/blob/bd70c643a7ec85d1ec2e88076b3fbdd8e4517f41/skills/bmad-agent-po/references/validate.md
[39]: https://github.com/bmad-code-org/BMAD-METHOD/blob/bd70c643a7ec85d1ec2e88076b3fbdd8e4517f41/skills/bmad-agent-po/references/validate-checks.md
[40]: https://github.com/bmad-code-org/BMAD-METHOD/blob/bd70c643a7ec85d1ec2e88076b3fbdd8e4517f41/skills/bmad-agent-po/references/board.md
[41]: https://github.com/bmad-code-org/BMAD-METHOD/blob/bd70c643a7ec85d1ec2e88076b3fbdd8e4517f41/skills/bmad-agent-po/workflow.md
[42]: https://xp123.com/invest-in-good-stories-and-smart-tasks/
[43]: https://cucumber.io/docs/gherkin/reference/
[44]: https://github.com/cucumber/gherkin/blob/c0d0bf67b0ee1d30f0b7d241c11495f8864c587e/gherkin-languages.json
[45]: https://code.visualstudio.com/docs/languages/markdown
