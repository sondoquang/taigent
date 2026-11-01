# Nghiên cứu: Tự động hoá Taiga bằng AI agent (Claude Code / Codex CLI) qua MCP + skills

- Ngày khảo sát: 2026-11-01.
- Phạm vi: (1) gói `taiga-mcp-server` và các MCP server thay thế, (2) mức độ bao phủ Taiga REST API, (3) cách Claude Code và Codex CLI cấu hình MCP, nạp skills, chạy headless và giữ bí mật, (4) kiến trúc đề xuất cho repo `taigent`.
- Quy ước: `[[n]][sN]` là link tới nguồn số *n* (danh sách đầy đủ ở mục **Nguồn**). `[INFERENCE]` = suy luận từ nguồn, chưa chạy thử. `[UNVERIFIED]` = chưa kiểm chứng được. Mục 4 là **khuyến nghị**, không phải sự thật có nguồn.
- Việc đọc mã nguồn dựa trên tarball npm `taiga-mcp-server@1.9.20`. Mã này giống hệt commit `77fc95e` trên GitHub (đã so khớp từng file `src/taigaService.js`, `src/taigaAuth.js`, `src/tools/batchTools.js`, `src/tools/attachmentTools.js`, `src/constants.js`, `src/index.js`) [[2]][s2] [[4]][s4].
- Mọi thao tác với Taiga trong lúc nghiên cứu đều chỉ đọc: tool MCP `listProjects` và `GET /api/v1/project-templates` ẩn danh. Không tạo, sửa hay xoá gì.

---

## TL;DR

- **`taiga-mcp-server` là gói cá nhân, ít người dùng.** Bản mới nhất 1.9.20 phát hành ngày 2026-01-19. Gói có 41 phiên bản, chỉ một maintainer (`greddy7574`), license ISC. Repo GitHub có 7 sao và 5 issue/PR đang mở; PR gần nhất (2026-09-09) vẫn chưa được merge [[1]][s1] [[3]][s3].
- **Server có 46 tool nhưng thiếu các thao tác nền tảng.** Không có tạo hoặc sửa project, không tạo từ template, không có tags/custom attributes/statuses/memberships/roles/swimlanes. Không có `listTasks`/`updateTask`/`updateUserStory` tổng quát, không xoá được story/task/epic. Chỉ upload được attachment vào issue, user story và task, **không** vào epic hay wiki [[10]][s10] [[6]][s6].
- **Một số tool hỏng hoặc rủi ro theo mã nguồn và issue tracker:**
  - `linkStoryToEpic` dùng sai endpoint nên liên kết không được lưu (issue #5, #6, PR #7 chưa merge) [[11]][s11] [[12]][s12] [[13]][s13].
  - Các tool `batchCreate*` gửi khoá `projectId` thay vì `project`, nên `[INFERENCE]` nhiều khả năng bị Taiga trả 400 [[7]][s7] [[32]][s32].
  - `downloadAttachment`/`deleteAttachment` luôn gọi endpoint của issue [[5]][s5].
  - Khi Taiga thu hồi token sớm, server không tự đăng nhập lại (PR #8) [[15]][s15].
- **Chỉ hỗ trợ đăng nhập bằng mật khẩu.** Server gọi `POST /auth` với `type: normal`, cache token trong bộ nhớ và tự giả định token sống 24h; không dùng refresh token, không có application token [[4]][s4]. Taiga mặc định cấp access token 24h và refresh token 8 ngày [[33]][s33].
- **Có MCP server thay thế phủ rộng hơn.**
  - `@madebyclowd/taiga-mcp-server` (MIT, TypeScript): upload attachment cho cả epic/story/task/issue/wiki, liên kết epic đúng qua `related_userstories`, tự refresh token, có tool `taiga_raw_request` để gọi bất kỳ endpoint nào (ví dụ tạo project với `creation_template`) [[19]][s19] [[20]][s20] [[21]][s21] [[22]][s22] [[23]][s23].
  - `illodev/taiga-mcp` có khoảng 150 tool CRUD, kể cả custom attributes, nhưng không có tool upload [[26]][s26].
  - `talhaorak/pytaiga-mcp` (Python) có `create_project`, tags và custom attributes, nhưng không có upload [[28]][s28] [[29]][s29].
- **REST API của Taiga làm được hết những gì repo cần:**
  - Tạo project với `creation_template`, nhân bản project (`/projects/{id}/duplicate`).
  - Bulk create epics/stories/tasks, liên kết epic qua `related_userstories`.
  - Upload multipart cho epic/story/task/issue/wiki, wiki theo slug, tags, custom attributes, statuses, memberships/roles, auth refresh và application token.
  - Chỉ superuser mới tạo được *project template* [[32]][s32] [[36]][s36].
- **Instance `taiga.vidratek.net` hiện chỉ có 2 template mặc định, `scrum` và `kanban`, cả hai đều có `is_epics_activated: false`.** Vì vậy project tạo từ template sẽ ẩn module Epics cho tới khi bật lên [[40]][s40] [[35]][s35].
- **Hai agent cấu hình khác nhau nhưng nạp chung một định dạng skill:**
  - Claude Code đọc MCP từ `.mcp.json` (có hỗ trợ `${VAR}`) và skills từ `.claude/skills/` [[41]][s41] [[42]][s42].
  - Codex đọc MCP từ `[mcp_servers.*]` trong `~/.codex/config.toml`, hoặc `.codex/config.toml` của project nếu project đã được trust. Skills nằm ở `.agents/skills/`, chỉ dẫn nằm ở `AGENTS.md` [[48]][s48] [[49]][s49] [[53]][s53].
  - Cả hai đều theo chuẩn Agent Skills và chạy headless được bằng `claude -p` / `codex exec` [[42]][s42] [[49]][s49] [[43]][s43] [[50]][s50].
- **Cảnh báo bảo mật (quan sát trong repo):** `.mcp.json` đang chứa `TAIGA_PASSWORD` dạng giá trị literal, không qua `${VAR}`. File chưa bị git track, nhưng repo không có `.gitignore` nên rất dễ bị commit nhầm [[57]][s57].

---

## 1. `taiga-mcp-server`

### 1.1 Thông tin gói

| Thuộc tính | Giá trị | Nguồn |
|---|---|---|
| Tên npm / bin | `taiga-mcp-server` / `taiga-mcp` → `src/index.js` | [[1]][s1] |
| Bản mới nhất | `1.9.20`, phát hành 2026-01-19. Gói tạo ngày 2025-06-13, có 41 phiên bản. Các bản 1.9.x ra dồn trong tháng 6/2025, sau đó là 12/2025 và 01/2026 | [[1]][s1] |
| Maintainer | Chỉ `greddy7574`. Gói tự mô tả là "Based on mcpTAIGA by adriapedralbes … Developed collaboratively with Claude Code" | [[1]][s1] |
| License | ISC (cả npm lẫn file `LICENSE`). GitHub hiển thị "Other/NOASSERTION" vì LICENSE có thêm đoạn ghi công | [[1]][s1] [[16]][s16] [[3]][s3] |
| Repo | `github.com/greddy7574/taigaMcpServer`: 7 sao, 10 fork, 5 issue/PR mở, push cuối 2026-01-19 | [[3]][s3] |
| Transport | Chỉ stdio (`StdioServerTransport`) | [[9]][s9] |
| Phụ thuộc | `@modelcontextprotocol/sdk ^1.8.0`, `axios`, `zod`, `dotenv`, `form-data` | [[1]][s1] |
| Cấu hình | Biến môi trường `TAIGA_API_URL` (mặc định `https://api.taiga.io/api/v1`), `TAIGA_USERNAME`, `TAIGA_PASSWORD`. Server cũng nạp `.env` nằm ở thư mục gốc của *package* | [[4]][s4] [[9]][s9] |

### 1.2 Cơ chế xác thực

- Server đăng nhập bằng `POST {TAIGA_API_URL}/auth` với `{type:"normal", username, password}`, lưu `auth_token` vào biến module và **tự đặt** hạn dùng là 24h kể từ lúc đăng nhập [[4]][s4].
- Mọi request đều gửi header `Authorization: Bearer <token>` [[4]][s4].
- Server không gọi `/auth/refresh` và không hỗ trợ `Authorization: Application <token>` [[4]][s4].
- Phía Taiga: `SIMPLE_JWT.ACCESS_TOKEN_LIFETIME = 24h`, `REFRESH_TOKEN_LIFETIME = 8 ngày` [[33]][s33]. API có endpoint `/api/v1/auth/refresh` và cơ chế application token [[32]][s32].
- Lỗi đã biết: nếu token bị vô hiệu hoá trước mốc 24h, mọi lời gọi đều lỗi với thông báo chung chung cho tới khi khởi động lại process. PR #8 (mở ngày 2026-09-09, chưa merge) sửa bằng cách đăng nhập lại và retry khi gặp 401 [[15]][s15].

### 1.3 Danh sách tool (46 tool, đọc trực tiếp từ schema MCP đang chạy)

Tên tool đúng như server khai báo (camelCase). Trong Claude Code, tên đầy đủ có dạng `mcp__taiga__<tên>` [[41]][s41] [[10]][s10].

| Nhóm | Tool | Tham số chính |
|---|---|---|
| Auth | `authenticate` | `username?`, `password?` |
| Project | `listProjects`, `getProject` | `projectIdentifier` (ID hoặc slug) |
| Epic | `createEpic`, `listEpics`, `getEpic`, `updateEpic`, `linkStoryToEpic`, `unlinkStoryFromEpic` | `project:number`, `subject`, `description?`, `color?`, `tags?`; `updateEpic` có thêm `status?:number` |
| User story | `listUserStories`, `getUserStory`, `createUserStory`, `updateUserStoryStatus`, `assignUserStoryToSprint` | `projectIdentifier`, `subject`, `description?`, `status?` (tên status), `tags?` |
| Task | `createTask` | `projectIdentifier`, `userStoryIdentifier` (ID hoặc ref), `subject`, `description?`, `status?`, `tags?` |
| Issue | `listIssues`, `getIssue`, `createIssue`, `updateIssueStatus`, `assignIssue`, `addIssueToSprint` | `type?`, `priority?`, `severity?` (theo tên) |
| Sprint | `listMilestones`, `getMilestone`, `getMilestoneStats`, `createMilestone`, `getIssuesByMilestone` | `name`, `estimatedStart?`, `estimatedFinish?` |
| Batch | `batchCreateIssues`, `batchCreateUserStories`, `batchCreateTasks` | mảng `{subject, description?, tags?, points?}`, tối đa 20 phần tử |
| Comment | `addComment`, `listComments`, `editComment`, `deleteComment` | `itemType ∈ {issue,user_story,task}` |
| Attachment | `uploadAttachment`, `listAttachments`, `downloadAttachment`, `deleteAttachment` | `itemType ∈ {issue,user_story,task}`, `filePath?` hoặc `fileData`(base64)+`fileName` |
| Wiki | `createWikiPage`, `listWikiPages`, `getWikiPage`, `updateWikiPage`, `deleteWikiPage`, `watchWikiPage` | `project` (ID, slug hoặc tên), `slug`, `content` (Markdown) |
| Tìm kiếm | `advancedSearch`, `queryHelp`, `validateQuery` | DSL kiểu `tags:in:[a,b] AND status:!=done` cho issues/user_stories/tasks |

Nguồn: schema tool lấy trực tiếp từ server đang kết nối trong phiên này, đối chiếu với `src/tools/index.js` [[10]][s10].

### 1.4 `uploadAttachment` hoạt động thế nào

- **Hai cách truyền file:**
  - `filePath` (khuyến nghị trong mô tả tool). Đường dẫn tuyệt đối dùng nguyên. Đường dẫn tương đối được thử lần lượt theo `cwd` → `$HOME` → `~/Desktop` → `~/Downloads` [[6]][s6] [[5]][s5].
  - `fileData` (base64, chấp nhận cả tiền tố data-URI) kèm `fileName` [[6]][s6] [[5]][s5].
- File được đọc toàn bộ vào RAM, chuyển sang base64 rồi gửi multipart với các field `object_id`, `attached_file`, `description` và `project`. Field `project` được tra cứu thêm; nếu tra lỗi thì server bỏ qua im lặng [[5]][s5].
- **Phía server MCP không giới hạn kích thước** (`maxContentLength/maxBodyLength: Infinity`) [[5]][s5]. Giới hạn thực tế đến từ reverse proxy của Taiga: `taiga-docker` mặc định `client_max_body_size 100M` [[39]][s39]. Instance này có thể cấu hình khác `[UNVERIFIED]`.
- Truyền `fileData` qua tham số tool nghĩa là nội dung file nằm trong context của model. Vì vậy với agent, nên dùng `filePath` `[INFERENCE]`.
- MIME type được đoán từ phần mở rộng theo một bảng nhỏ; định dạng không có trong bảng thành `application/octet-stream`. Tool chỉ nhận `itemType ∈ {issue, user_story, task}`; không hỗ trợ epic hay wiki dù hằng số `WIKI_ATTACHMENTS` có tồn tại [[6]][s6] [[8]][s8].

### 1.5 Lỗi và rủi ro đã biết

| Vấn đề | Bằng chứng | Hệ quả |
|---|---|---|
| `linkStoryToEpic` gọi `PATCH /userstories/{id}` với `{epic}`, trong khi API đúng là `POST /epics/{id}/related_userstories` với `{epic, user_story}` | Code [[5]][s5]; issue #5, #6, PR #7 (mở từ 2026-05-31) [[11]][s11] [[12]][s12] [[13]][s13]; tài liệu API [[32]][s32] | Tool báo thành công nhưng liên kết không được lưu (#5) |
| `batchCreateUserStories/Tasks/Issues` gửi `projectId` thay cho `project`, `userStoryId` thay cho `user_story`, và `points` dạng số trong khi API yêu cầu "dictionary of points" | `batchTools.js` dòng 59, 144, 147, 236–237 [[7]][s7]; API ghi `project (required)` [[32]][s32] | `[INFERENCE]` lời gọi dễ bị 400. Ngoài ra batch chạy tuần tự từng request, không dùng `/bulk_create` [[7]][s7] |
| `downloadAttachment`/`deleteAttachment` luôn dùng `/issues/attachments/{id}` | `taigaService.js` dòng 966, 1006 [[5]][s5] | `[INFERENCE]` sai với attachment của story/task |
| `updateUserStoryStatus` bỏ qua `projectIdentifier`, coi số truyền vào là ID toàn cục | Issue #4 [[14]][s14] | Có thể sửa nhầm story ở project khác |
| Token bị thu hồi sớm làm server "kẹt" | PR #8 [[15]][s15] | Phải khởi động lại agent |
| `advancedSearch` tải toàn bộ items về rồi lọc phía client; task được lấy bằng cách duyệt từng story | `QueryExecutor.js` [[17]][s17] | Chậm với project lớn `[INFERENCE]` |
| Tool không khai báo annotation (`readOnlyHint`…) | Đăng ký bằng `server.tool(name, schema, handler)` [[10]][s10] | Chế độ `writes` của Codex chỉ tự duyệt tool đánh dấu read-only, nên `[INFERENCE]` mọi tool đều sẽ bị hỏi duyệt [[48]][s48] |
| `.mcp.json` gọi `npx -y taiga-mcp-server` không ghim phiên bản | Quan sát repo [[57]][s57] | Mỗi máy có thể chạy một phiên bản khác nhau (rủi ro supply-chain) `[INFERENCE]` |

### 1.6 Những gì server còn thiếu

Đã đối chiếu 46 tool với tài liệu API [[10]][s10] [[32]][s32]. Server **không có**:

- Tạo, sửa, xoá project; tạo từ `creation_template`; `duplicate`; bật/tắt module (`is_epics_activated`…).
- Liệt kê project template (`/project-templates`).
- Tags của project (`create_tag`/`edit_tag`/`delete_tag`), custom attributes và giá trị của chúng.
- Statuses/points/priorities/severities/issue types, memberships/roles, swimlanes.
- `listTasks`/`getTask`/`updateTask`, `updateUserStory` tổng quát (subject/description/points/assignee), xoá epic/story/task/issue.
- Attachment cho epic và wiki; bulk create thật (`/bulk_create`); `related_userstories/bulk_create`; wiki links; export/import.

### 1.7 So sánh các MCP server Taiga khác

Danh sách ứng viên lấy từ tìm kiếm npm và GitHub [[31]][s31]. Các cột được kiểm tra bằng cách đọc README và mã nguồn.

| Server | Ngôn ngữ / phân phối | Hoạt động | License | Auth | Tạo project / template | Liên kết epic↔story | Upload attachment | Tags / custom attrs | Bulk | Gọi API thô |
|---|---|---|---|---|---|---|---|---|---|---|
| **`taiga-mcp-server`** (greddy7574) | JS, npm `1.9.20` | Release cuối 2026-01; PR treo nhiều tháng | ISC | Mật khẩu, không refresh | ✗ / ✗ | ✗ (hỏng) | issue/story/task | ✗ | Tuần tự, `[INFERENCE]` hỏng | ✗ |
| **`@elio9352/taiga-mcp-server`** (fork) | JS, npm `1.12.0` (2026-07) | 7 release, 0 sao | ISC (npm) | Như bản gốc | ✗ | ✗ (vẫn `PATCH {epic}`) | Như bản gốc | ✗ | Như bản gốc | ✗ |
| **`@madebyclowd/taiga-mcp-server`** | TS, npm `1.0.2` (2026-10), stdio và HTTP | Push 2026-10-18, 3 sao | MIT | `TAIGA_TOKEN` hoặc mật khẩu, tự `/auth/refresh` khi gặp 401; chế độ HTTP dùng token riêng của từng client | `project_create` (name/description/is_private); template qua `taiga_raw_request` | ✓ `POST related_userstories` | epic/story/task/issue/**wiki**, base64, ≤10 MiB | Không có tool riêng; dùng raw request | `batch_create_*` (dùng `bulk_create`) | ✓ `taiga_raw_request` |
| **`illodev/taiga-mcp`** | TS, npm `@illodev/taiga-mcp 1.0.0` (1 bản duy nhất, 2026-03) | Push 2026-03, 4 sao | MIT (npm) | Tự refresh khi gặp 401 | `taiga_projects_create` (không có field template), có export/import | ✓ `related_userstories_add/bulk_create` | ✗ (chỉ list/get; hàm `postMultipart` có nhưng không được dùng) | ✓ tags, custom attributes | ✓ | ✗ |
| **`talhaorak/pytaiga-mcp`** | Python (uv, cài từ git, không có trên PyPI) | Push 2026-03, 38 sao | MIT | Mật khẩu, theo session | ✓ `create_project` (kwargs cho phép `creation_template`) | ✓ `link_user_story_to_epic` | ✗ (chỉ list/delete) | ✓ tags, custom attributes | ✓ `bulk_create_*` | ✗ |

Nguồn từng dòng: greddy [[1]][s1] [[5]][s5]; Elio [[18]][s18]; madebyclowd [[19]][s19] [[20]][s20] [[21]][s21] [[22]][s22] [[23]][s23] [[24]][s24] [[25]][s25]; illodev [[26]][s26] [[27]][s27]; pytaiga [[28]][s28] [[29]][s29].

Các repo khác như `OFFSET3/taiga-mcp`, `negoro26/mcp-taiga`, `afalabarce/taiga-mcp-server` nhỏ hơn hoặc thiếu nhiều tính năng nên không đi sâu [[30]][s30].

**Nhận xét [INFERENCE]:** Xét theo nhu cầu tạo backlog và upload tài liệu, `@madebyclowd/taiga-mcp-server` phủ tốt nhất. Nó dùng đúng endpoint, upload được vào epic/wiki, có refresh token, có raw request để bù chỗ thiếu, và README ghi đã test với Taiga thật [[19]][s19]. Đổi lại, gói mới, chỉ có 3 sao và một maintainer. Chưa server nào có tool chuyên biệt để "tạo project từ template rồi cấu hình tags/custom attributes theo chuẩn công ty".

---

## 2. Taiga REST API: endpoint cần thiết và mức bao phủ của MCP

Base URL của instance: `https://taiga.vidratek.net/api/v1`. Tài liệu chính thức: [[32]][s32].

Ký hiệu cột cuối: ✓ = `taiga-mcp-server` có tool, ✗ = không có, ⚠ = có tool nhưng sai hoặc thiếu.

| Năng lực | Endpoint (tài liệu) | Ghi chú | MCP |
|---|---|---|---|
| Đăng nhập | `POST /auth` `{type:"normal"}` ([#auth-normal-login][s32a]) | Trả về `auth_token` và `refresh` | ✓ |
| Refresh token | `POST /auth/refresh` `{refresh}` ([#auth-refresh][s32b]) | Access token 24h, refresh token 8 ngày [[33]][s33] | ✗ |
| Application token | `/applications/{id}/token`, `/application-tokens/authorize`, `/validate`; header `Authorization: Application …` ([#_application_token_authentication][s32c]) | Application được tạo qua Django admin hoặc API | ✗ |
| Liệt kê template | `GET /project-templates` ([#project-templates-list][s32d]) | Ai cũng đọc được (`AllowAny`) [[36]][s36] | ✗ |
| Tạo template | `POST /project-templates`, `POST /projects/{id}/create_template` ([#projects-create-template][s32e]) | **Chỉ superuser** [[36]][s36] | ✗ |
| Tạo project | `POST /projects` `{name, description, creation_template?, is_*_activated, is_private…}` ([#projects-create][s32f]) | Không truyền `creation_template` thì dùng `DEFAULT_PROJECT_TEMPLATE="scrum"` [[33]][s33] [[34]][s34]. Template sinh ra statuses, points, priorities, severities, issue types, due dates, roles và cờ module [[35]][s35] | ✗ |
| Nhân bản project | `POST /projects/{id}/duplicate` `{name, description, is_private, users}` ([#projects-duplicate][s32g]) | Cấu trúc được clone qua `load_data_from_project` → `apply_to_project` [[38]][s38]. `[INFERENCE]` custom attributes không nằm trong `apply_to_project` [[35]][s35] | ✗ |
| Bật/tắt module | `PATCH /projects/{id}` (`is_epics_activated`…) ([#projects-edit][s32h]) | Cần cho Epics vì template của instance để `false` [[40]][s40] | ✗ |
| Tags | `POST /projects/{id}/create_tag` `{tag, color}`, `edit_tag`, `delete_tag`, `mix_tags`, `GET tags_colors` ([#projects-create-tag][s32i]) | Cần quyền project admin [[36]][s36] | ✗ |
| Statuses / points… | `POST /userstory-statuses`, `/task-statuses`, `/epic-statuses`, `/issue-statuses`, `/points`… ([#user-story-statuses-create][s32j]) | | ✗ (chỉ đọc nội bộ để tra tên) |
| Custom attributes | `POST /{epic,userstory,task,issue}-custom-attributes`; giá trị qua `PATCH /{type}s/custom-attributes-values/{id}` `{attributes_values, version}` ([#user-story-custom-attributes-values-edit][s32k]) | | ✗ |
| Memberships / roles | `POST /memberships` `{project, role, username}`, `/memberships/bulk_create`, `/roles` ([#memberships-create][s32l]) | | ✗ |
| Swimlanes | `/swimlanes`, `/swimlane-userstory-statuses` | Có trong router của taiga-back [[37]][s37] nhưng **không có trong tài liệu API** `[UNVERIFIED payload]` | ✗ |
| Epic | `POST /epics` `{project, subject, …}`; `POST /epics/bulk_create` `{project_id, bulk_epics}` ([#epics-create][s32m], [#epics-bulk-create][s32n]) | | ✓ đơn lẻ, ✗ bulk |
| Epic ↔ story | `POST /epics/{id}/related_userstories` `{epic, user_story}`; `…/related_userstories/bulk_create` `{project_id, bulk_userstories}` ([#epics-related-user-stories-create][s32o]) | Bulk vừa tạo story mới vừa liên kết | ⚠ (sai endpoint) |
| User story | `POST /userstories` (`project` bắt buộc, `points` là dict); `POST /userstories/bulk_create` `{project_id, status_id?, bulk_stories:"A\nB"}` ([#user-stories-create][s32p], [#user-stories-bulk-create][s32q]) | Bulk chỉ nhận subject, mỗi dòng một story | ✓ đơn lẻ, ⚠ batch |
| Task | `POST /tasks` `{project, user_story, …}`; `POST /tasks/bulk_create` `{project_id, us_id?, bulk_tasks}` ([#tasks-create][s32r], [#tasks-bulk-create][s32s]) | | ✓ tạo, ✗ sửa/list, ⚠ batch |
| Issue | `POST /issues`, `/issues/bulk_create` | | ✓ |
| Attachments | `POST /{epics,userstories,tasks,issues,wiki}/attachments` multipart `object_id`, `project`, `attached_file`, `description?` ([#user-stories-create-attachment][s32t], [#wiki-create-attachment][s32u]) | Object trả về có `sha1` và `size`, dùng được để chống trùng ([#object-attachment-detail][s32v]) | ⚠ (chỉ issue/story/task) |
| Wiki | `POST /wiki` `{project, slug, content}`, `GET /wiki/by_slug`, `/wiki-links` ([#wiki-create][s32w]) | Slug là khoá tự nhiên, upsert được | ✓ (không có wiki-links) |
| Tra cứu theo ref/slug | `GET /resolver`, `/userstories/by_ref`, `/projects/by_slug` | | Một phần |
| Lọc theo tag | `GET /userstories?project=&tags=a,b` ([#user-stories-list][s32x]) | Dùng làm khoá idempotency | ✗ (`listUserStories` chỉ lọc theo project) |
| OCC | Mọi PATCH/PUT phải gửi kèm `version` ([#_occ_optimistic_concurrency_control][s32y]) | | ✓ (server tự lấy `version`) |
| Phân trang / throttle | `x-disable-pagination: True`, `page_size` tối đa 1000. Lỗi 429 khi bị throttle ([#_pagination][s32z]) | Mặc định taiga-back không throttle API thường; `import-dump-mode` giới hạn 1/phút [[33]][s33] | ✓ (tự phân trang) |

**Kết luận mục 2:** Để chuẩn hoá việc bootstrap project, cần các endpoint mà MCP hiện tại không có: `POST /projects` có `creation_template`, `PATCH` cờ module, `create_tag`, custom attributes, `related_userstories`, và attachment cho epic/wiki. Có thể bù bằng một MCP server khác có raw request, hoặc bằng một script/CLI mỏng gọi REST trực tiếp (xem mục 4).

---

## 3. Claude Code và Codex CLI

| Khía cạnh | Claude Code | OpenAI Codex CLI |
|---|---|---|
| File cấu hình MCP theo project | `.mcp.json` ở thư mục gốc repo, khoá `mcpServers`, nên commit để cả team dùng chung [[41]][s41] | `.codex/config.toml`, bảng `[mcp_servers.<name>]`. **Chỉ nạp khi project đã được trust**; mặc định đọc `~/.codex/config.toml` [[48]][s48] [[51]][s51] |
| Duyệt server của project | Phiên tương tác hỏi duyệt server trong `.mcp.json`. Repo vừa clone không tự duyệt được: `enableAllProjectMcpServers` commit sẵn bị bỏ qua khi thư mục chưa trust. `claude -p` nạp server của project **không hỏi** [[41]][s41] | Project chưa trust thì toàn bộ lớp `.codex/` (config, hooks, rules) bị bỏ qua [[51]][s51] |
| Biến môi trường và bí mật | `.mcp.json` hỗ trợ `${VAR}` và `${VAR:-default}`. Biến chưa đặt thì Claude cảnh báo và giữ nguyên chuỗi `${VAR}` [[41]][s41]. `.claude/settings.local.json` dùng cho cấu hình cá nhân và không vào git [[45]][s45] | Server stdio có `env` (map tĩnh) và `env_vars` (whitelist biến được chuyển tiếp từ môi trường cục bộ) [[48]][s48] [[52]][s52]. Server HTTP có `bearer_token_env_var` và `env_http_headers` [[48]][s48] |
| Nơi đặt skills | `.claude/skills/<name>/SKILL.md` (project), `~/.claude/skills/` (cá nhân). Theo chuẩn Agent Skills [[42]][s42] [[56]][s56] | `.agents/skills` trong mọi thư mục từ `cwd` lên tới gốc repo, `~/.agents/skills`, `/etc/codex/skills`. Hỗ trợ symlink. `agents/openai.yaml` khai báo UI, `allow_implicit_invocation` và phụ thuộc tool MCP [[49]][s49] |
| File chỉ dẫn | `CLAUDE.md`. Đọc `AGENTS.md` **chỉ khi không có** `CLAUDE.md` (cần v2.1.277 trở lên), hoặc import `AGENTS.md` từ `CLAUDE.md` [[46]][s46] | `AGENTS.md` / `AGENTS.override.md`, ghép từ gốc repo xuống `cwd`, tối đa 32 KiB (`project_doc_max_bytes`) [[53]][s53] |
| Chạy headless | `claude -p "<prompt>" --allowedTools "…" --output-format json` [[43]][s43]. Có `--mcp-config` và `--strict-mcp-config` để chỉ dùng đúng server được truyền vào [[41]][s41] [[47]][s47] | `codex exec "<prompt>"`, mặc định sandbox read-only, có thể chọn `--sandbox workspace-write` và `--json` (JSONL). `--full-auto` đã bị gỡ. Server có `required = true` mà lỗi thì `exec` thoát [[50]][s50] |
| Quyền với tool MCP | Rule `mcp__taiga__*` hoặc `mcp__taiga__list*`. Glob trong allow chỉ hợp lệ sau tiền tố `mcp__<server>__`; `"mcp__*"` trong allow bị bỏ qua. Deny `mcp__*` chặn mọi tool MCP [[44]][s44]. Skill có thể khai báo `allowed-tools` trong frontmatter [[42]][s42] | `enabled_tools`/`disabled_tools`, `default_tools_approval_mode ∈ {auto, prompt, writes, approve}`, `tools.<tool>.approval_mode` [[48]][s48] [[52]][s52]. Tool khai báo destructive luôn phải duyệt [[54]][s54] |
| Giới hạn output | Cảnh báo khi output > 10k token, mặc định cắt ở 25k (`MAX_MCP_OUTPUT_TOKENS`) [[41]][s41] | `tools.<tool>.output_token_limit` [[48]][s48] |
| Timeout | `MCP_TIMEOUT` (khởi động), trường `timeout` cho từng server [[41]][s41] | `startup_timeout_sec` (mặc định 10), `tool_timeout_sec` (mặc định 60) [[48]][s48] |

Hệ quả cho repo `taigent`:

- Repo đang giữ **hai bản sao giống hệt nhau** của skills ở `.claude/skills/` và `.agents/skills/` (không phải symlink). Mỗi skill bên `.agents` có thêm `agents/openai.yaml` [[57]][s57]. Như vậy một `SKILL.md` theo chuẩn Agent Skills dùng được cho cả hai agent [[42]][s42] [[49]][s49]. Cái giá là phải đồng bộ hai bản.
- Repo có `AGENTS.md` và không có `CLAUDE.md`, nên Claude Code (≥ v2.1.277) đọc `AGENTS.md` và cả hai agent nhận chung chỉ dẫn [[46]][s46] [[53]][s53].
- Cấu hình MCP thì **không** dùng chung được: Claude đọc `.mcp.json` (JSON), Codex đọc `.codex/config.toml` (TOML) [[41]][s41] [[48]][s48]. Phải duy trì hai file, nhưng cả hai đều có thể chỉ tham chiếu biến môi trường thay vì chứa bí mật.

---

## 4. Kiến trúc đề xuất cho repo (KHUYẾN NGHỊ)

> Toàn bộ mục này là khuyến nghị dựa trên các sự thật ở mục 1–3. Mỗi khuyến nghị có ghi sự thật làm căn cứ.

### 4.1 Nguyên tắc

1. **Viết mỗi thứ một lần, dùng được cho cả hai agent.** Quy ước nằm trong docs, quy trình nằm trong skills (định dạng Agent Skills dùng chung), còn thao tác ghi vào Taiga đi qua một lớp có kiểm soát. Căn cứ: hai agent đọc cùng định dạng `SKILL.md` và cùng `AGENTS.md` [[42]][s42] [[49]][s49] [[46]][s46].
2. **Tách lập kế hoạch khỏi thực thi (plan → review → apply).** Agent chuyển spec/PRD thành một **manifest** (YAML) nằm trong repo. Con người duyệt diff, sau đó một bước `apply` idempotent đẩy manifest lên Taiga. Cách này làm kết quả đồng nhất giữa các thành viên: cùng manifest cho ra cùng kết quả. Agent tự gọi từng tool rời rạc thì không có được điều đó.
3. **Thao tác cấu trúc phải tất định.** Bootstrap project, tags, custom attributes, liên kết epic và attachment epic/wiki chính là những chỗ MCP hiện tại thiếu hoặc lỗi (mục 1.5–1.6). Nên viết các thao tác này bằng mã có test, gọi thẳng REST.

### 4.2 Các thành phần

| Thành phần | Vị trí đề xuất | Vai trò |
|---|---|---|
| Quy ước Taiga | `docs/taiga/conventions.md` (được `AGENTS.md` tham chiếu) | Một nguồn chuẩn duy nhất: cách đặt tên project/slug, cấu trúc epic, story, task, bộ tags, mẫu mô tả, slug wiki, đặt tên attachment, ánh xạ status |
| Manifest | `taiga/<project-slug>/project.yaml`, `backlog.yaml`, `docs.yaml` | Trạng thái mong muốn. Mỗi item có `key` ổn định |
| CLI mỏng | `tools/taiga/` (Node, hoặc Python với `uv`), lệnh `plan`/`apply`/`bootstrap`/`upload`/`report` | Gọi REST trực tiếp: `creation_template`, `PATCH` module, `create_tag`, custom attributes, `related_userstories`, attachment multipart cho mọi loại kể cả wiki/epic, tự refresh token khi gặp 401 |
| MCP server | Giữ cho thao tác đọc và hỏi đáp tương tác | Agent dùng để tra cứu (list/get/search) và comment |
| Skills | `.claude/skills/taiga-*` và bản đồng bộ ở `.agents/skills/taiga-*` | Quy trình theo từng việc (xem 4.3) |
| Cấu hình agent | `.mcp.json` (chỉ chứa `${VAR}`), `.codex/config.toml` (`env_vars`), `.gitignore`, `.env.example` | Giữ bí mật ngoài git |

**Chọn MCP server:**

- **Ngắn hạn:** giữ `taiga-mcp-server` nhưng ghim phiên bản (`taiga-mcp-server@1.9.20`). Trong conventions, ghi rõ **cấm dùng** `linkStoryToEpic`, `batchCreate*`, `download/deleteAttachment` cho story/task; các việc đó chuyển sang CLI. Căn cứ: mục 1.5.
- **Nên đánh giá:** `@madebyclowd/taiga-mcp-server` trên project `test` (ID 7) của instance [[40]][s40]. Kiểm tra tạo epic, `epic_link_user_story`, `attachment_upload` lên wiki/epic, rồi xác minh kết quả trên giao diện web. Nếu đạt, gói này có thể thay MCP hiện tại và thu nhỏ phạm vi CLI. Căn cứ: mục 1.7 [[19]][s19] [[20]][s20] [[21]][s21].
- **Không nên** tự viết một MCP server đầy đủ. Lý do: những gì còn thiếu (bootstrap, apply manifest) là thao tác lô tất định. Một CLI gọi qua shell hoạt động giống nhau trên cả hai agent, test được, và không đổ payload lớn vào context [[41]][s41] [[48]][s48] `[INFERENCE]`. Nếu sau này muốn chỉ dùng MCP, có thể bọc chính CLI đó thành vài tool MCP (`taiga_plan`, `taiga_apply`).

### 4.3 Danh sách skills đề xuất

| Skill | Mục đích | Chạm Taiga qua |
|---|---|---|
| `taiga-bootstrap-project` | Tạo project từ template chuẩn: `POST /projects {creation_template}`, bật `is_epics_activated`, tạo tags chuẩn, custom attributes, wiki "Home" và memberships. Kiểm tra trùng theo slug trước khi tạo | CLI `bootstrap` (MCP không có endpoint này) [[32]][s32] [[40]][s40] |
| `taiga-plan-backlog` | Đọc spec/PRD → sinh hoặc cập nhật `backlog.yaml` (epic → stories → tasks, acceptance criteria, tags) theo conventions. Chỉ ghi file, không chạm Taiga | Không (chỉ đọc qua MCP để đối chiếu) |
| `taiga-apply-backlog` | `plan` (diff giữa manifest và Taiga) → hỏi xác nhận → `apply` idempotent: tạo hoặc cập nhật, liên kết epic qua `related_userstories`, ghi ID trả về | CLI `plan`/`apply` |
| `taiga-upload-docs` | Đẩy tài liệu: Markdown thành trang wiki (upsert theo slug), file nhị phân thành attachment của epic/story/wiki. Chống trùng bằng `name` và `sha1` | CLI `upload` (MCP thiếu epic/wiki) [[32]][s32] |
| `taiga-status-report` | Báo cáo tiến độ sprint/epic, chỉ đọc | MCP (`listUserStories`, `getMilestoneStats`, `advancedSearch`) |
| `taiga-sync-status` *(tuỳ chọn)* | Đồng bộ trạng thái từ PR hoặc commit sang story/task | MCP `updateUserStoryStatus` (lưu ý issue #4: luôn truyền ID toàn cục, không truyền ref) [[14]][s14] |

Viết skill theo `writing-for-agents`/Agent Skills:

- `description` cần đưa từ khoá kích hoạt lên đầu, vì Codex rút gọn mô tả khi có nhiều skill [[49]][s49].
- Các skill có ghi (`apply`, `bootstrap`, `upload`) nên đặt `allow_implicit_invocation: false` trong `agents/openai.yaml` [[49]][s49] và dùng `disable-model-invocation`/`allowed-tools` phía Claude [[42]][s42]. Như vậy chỉ khi người dùng gọi tường minh thì agent mới ghi vào Taiga.

### 4.4 Nội dung cần có trong `docs/taiga/conventions.md`

- Tên project `"<Khách hàng/Mảng> - <Sản phẩm>"` và quy tắc slug.
  - Dữ liệu thực tế đang lệch nhau: có cả `Vigo - Core Mapping` lẫn `Vigo-Devops`, và slug `vigo-authenautho` cho project "Vigo - Vigo Auth" [[40]][s40]. Đây là đúng loại lệch chuẩn mà conventions phải ngăn.
- Template: dùng `scrum` hay `kanban` ứng với loại dự án nào. Luôn bật Epics vì template của instance để `false` [[40]][s40].
- Bộ tags có tiền tố: `type:feature|bug|chore`, `area:<module>`, `src:<manifest-key>`. Màu tags được tạo một lần khi bootstrap qua `create_tag` [[32]][s32].
- Mẫu mô tả story: user story + acceptance criteria + link spec. Mẫu task: định nghĩa "done".
- Quy tắc ánh xạ status theo template mặc định: story có `New, Ready, In progress, Ready for test, Done, Archived`; task có `New, In progress, Ready for test, Closed, Needs Info` [[40]][s40].
- Slug wiki (`spec-<epic-key>`, `adr-<n>`…) và quy tắc đặt tên attachment.

### 4.5 Idempotency và chống trùng

- **Khoá ổn định:** mỗi epic/story/task trong manifest có `key` (ví dụ `AUTH-LOGIN`). Khi tạo item, ghi khoá thành tag `src:<key>`. Trước khi tạo, gọi `GET /userstories?project=<id>&tags=src:<key>` (API có lọc theo tag) [[32]][s32]. Nếu đã có thì cập nhật, chưa có thì tạo.
  - Với epic, `[UNVERIFIED]` tài liệu không ghi rõ lọc theo tag; có thể lấy toàn bộ epic của project rồi so tag phía client.
- **Lưu ID:** sau khi `apply`, ghi ID và ref của Taiga vào `taiga/<slug>/state.json` (commit cùng manifest) để những lần chạy sau tra nhanh. Tag vẫn là nguồn đối chiếu chính nếu file state bị lệch.
- **Wiki:** upsert theo `GET /wiki/by_slug` [[32]][s32]. **Attachment:** liệt kê `/{type}/attachments?object_id=…` rồi so `name` và `sha1`/`size` trước khi upload ([#object-attachment-detail][s32v]).
- **Cập nhật** phải gửi kèm `version` hiện tại (OCC) [[32]][s32]. **Liên kết epic:** `GET /epics/{id}/related_userstories` trước khi `POST` [[32]][s32].
- Có throttle thì xử lý 429 bằng backoff [[32]][s32]. Theo mặc định taiga-back không bật throttle cho API thường [[33]][s33].

### 4.6 Bí mật và danh tính

- **Việc cần làm ngay:**
  - Thay giá trị literal trong `.mcp.json` bằng `"TAIGA_PASSWORD": "${TAIGA_PASSWORD}"` (tương tự cho username và URL), vì `.mcp.json` hỗ trợ `${VAR}` [[41]][s41].
  - Thêm `.gitignore` cho `.env`, `.claude/settings.local.json` và `.codex/` cá nhân nếu có.
  - Coi mật khẩu hiện tại là đã lộ cục bộ và **đổi mật khẩu** [[57]][s57].
- **Codex:** dùng `.codex/config.toml` với `env_vars = ["TAIGA_API_URL","TAIGA_USERNAME","TAIGA_PASSWORD"]`, không dùng `env = {…}` literal [[48]][s48] [[52]][s52]. Cấu hình project chỉ được nạp khi người dùng đã trust repo [[51]][s51] [[55]][s55]. Muốn tách cấu hình theo người hoặc theo môi trường thì dùng profile `--profile <name>` (`~/.codex/<name>.config.toml`) [[55]][s55].
- **Danh tính:** khuyến nghị mỗi người dùng tài khoản Taiga riêng để giữ audit và phân quyền theo role. Có thể dùng thêm một tài khoản bot là project admin, chỉ cho việc bootstrap (tạo tags, custom attributes và statuses cần quyền project admin) [[36]][s36].
  - Tạo *project template* mới cần quyền superuser [[36]][s36]. Vì vậy "template chuẩn công ty" nên được mã hoá thành bước bootstrap trong CLI, chạy trên template `scrum`/`kanban`, hoặc dùng `duplicate` từ một project mẫu [[32]][s32] [[38]][s38], thay vì xin quyền superuser.
- **Về lâu dài:** chuyển sang application token (`Authorization: Application …`) hoặc server có refresh token, để không phải để mật khẩu trong biến môi trường [[32]][s32] [[22]][s22].

### 4.7 Chạy headless thống nhất

- **Claude:**

  ```
  claude -p "/taiga-apply-backlog taiga/<slug>/backlog.yaml" --allowedTools "mcp__taiga__list*,mcp__taiga__get*,Bash(node tools/taiga/*)" --output-format json
  ```

  Ghi chú: `claude -p` nạp `.mcp.json` mà không hỏi duyệt; dùng `--strict-mcp-config` nếu muốn khoá đúng tập server [[41]][s41] [[43]][s43] [[44]][s44]. Cú pháp gọi skill bằng `/<name>` trong `-p` `[UNVERIFIED]` với mọi phiên bản.
- **Codex:**

  ```
  codex exec --sandbox workspace-write --json "Dùng skill taiga-apply-backlog cho taiga/<slug>/backlog.yaml"
  ```

  Đặt `required = true` cho server taiga để job dừng hẳn khi MCP không khởi động được, và đặt `tools.<tool>.approval_mode` cho các tool đọc [[50]][s50] [[48]][s48]. `[UNVERIFIED]` Chưa rõ cách `codex exec` xử lý yêu cầu duyệt tool MCP khi không có người trả lời; cần thử thực tế.
- Nên có một script `tools/taiga/run-agent.(sh|ps1)` bọc hai lệnh trên, để mọi người chạy cùng tham số. User là người dùng Windows nên cần bản PowerShell `[INFERENCE]`.

### 4.8 Đồng bộ skills giữa `.claude` và `.agents`

- Chọn một nguồn chuẩn duy nhất, ví dụ `.agents/skills/taiga-*`. Bên còn lại sinh ra bằng script copy, hoặc symlink: Codex hỗ trợ symlink [[49]][s49]; Claude `[UNVERIFIED]`; symlink trên Windows còn cần Developer Mode/quyền admin `[INFERENCE]`.
- Thêm một bước kiểm tra (git hook hoặc CI) so hash hai bản. `skills-lock.json` hiện chỉ theo dõi các skill lấy từ `mattpocock/skills`, không theo dõi skill nội bộ [[57]][s57].

---

## 5. Rủi ro và câu hỏi mở

| # | Rủi ro / câu hỏi | Mức | Cách giảm hoặc bước tiếp theo |
|---|---|---|---|
| 1 | `taiga-mcp-server` gần như ngừng bảo trì (PR #7, #8 treo nhiều tháng) [[3]][s3] [[13]][s13] [[15]][s15] | Cao | Ghim phiên bản, tránh các tool hỏng, đánh giá server thay thế |
| 2 | Lỗi `batchCreate*` mới là suy luận từ code, chưa chạy thử [[7]][s7] | TB | Chạy thử trên project `test` (ID 7). Ghi kết quả vào conventions |
| 3 | Mật khẩu literal trong `.mcp.json`, chưa có `.gitignore` [[57]][s57] | Cao | Mục 4.6, đổi mật khẩu |
| 4 | Gói mới (`@madebyclowd`) chỉ có một maintainer, ít người dùng; rủi ro supply-chain qua `npx -y` [[19]][s19] | TB | Ghim version và integrity, đọc mã trước khi nâng cấp, cân nhắc vendor hoặc fork |
| 5 | Phiên bản Taiga của instance và giới hạn upload (`client_max_body_size`) chưa biết `[UNVERIFIED]` [[39]][s39] | Thấp | Hỏi admin hoặc thử upload file lớn trên project test |
| 6 | Swimlanes có trong backend nhưng không có trong tài liệu API [[37]][s37] | Thấp | Nếu cần, đọc `taiga/projects/api.py`/validators trước khi dùng |
| 7 | `duplicate` có clone custom attributes hay không: tài liệu nói "same status, colors, attributes…" [[32]][s32] nhưng `apply_to_project` không tạo custom attributes [[35]][s35] `[INFERENCE]` | TB | Thử duplicate project mẫu trên môi trường test |
| 8 | Hành vi duyệt tool MCP trong `codex exec` không tương tác `[UNVERIFIED]` [[50]][s50] [[48]][s48] | TB | Thử với `default_tools_approval_mode` từng giá trị |
| 9 | Nhóm chọn tài khoản riêng hay tài khoản bot (audit và quyền)? | Quyết định | Chốt trước khi viết skill bootstrap |
| 10 | Manifest sống trong repo này hay trong repo của từng sản phẩm? | Quyết định | Ảnh hưởng tới đường dẫn manifest và cách CI chạy `apply` |
| 11 | Chi phí và độ trễ khi agent đọc output MCP lớn (`listUserStories` của project lớn) [[41]][s41] | Thấp | Ưu tiên `advancedSearch`/CLI có bộ lọc, hoặc tăng `MAX_MCP_OUTPUT_TOKENS` |

---

## Nguồn

1. npm registry metadata `taiga-mcp-server`: https://registry.npmjs.org/taiga-mcp-server
2. Tarball `taiga-mcp-server@1.9.20`: https://registry.npmjs.org/taiga-mcp-server/-/taiga-mcp-server-1.9.20.tgz
3. Repo GitHub `greddy7574/taigaMcpServer`: https://github.com/greddy7574/taigaMcpServer
4. `src/taigaAuth.js` @1.9.20: https://github.com/greddy7574/taigaMcpServer/blob/77fc95e97042c5f5daa9d3469c1220d7044ea58d/src/taigaAuth.js
5. `src/taigaService.js` @1.9.20: https://github.com/greddy7574/taigaMcpServer/blob/77fc95e97042c5f5daa9d3469c1220d7044ea58d/src/taigaService.js
6. `src/tools/attachmentTools.js` @1.9.20: https://github.com/greddy7574/taigaMcpServer/blob/77fc95e97042c5f5daa9d3469c1220d7044ea58d/src/tools/attachmentTools.js
7. `src/tools/batchTools.js` @1.9.20: https://github.com/greddy7574/taigaMcpServer/blob/77fc95e97042c5f5daa9d3469c1220d7044ea58d/src/tools/batchTools.js
8. `src/constants.js` @1.9.20: https://github.com/greddy7574/taigaMcpServer/blob/77fc95e97042c5f5daa9d3469c1220d7044ea58d/src/constants.js
9. `src/index.js` @1.9.20: https://github.com/greddy7574/taigaMcpServer/blob/77fc95e97042c5f5daa9d3469c1220d7044ea58d/src/index.js
10. `src/tools/index.js` @1.9.20 (tool registry): https://github.com/greddy7574/taigaMcpServer/blob/77fc95e97042c5f5daa9d3469c1220d7044ea58d/src/tools/index.js
11. Issue #5, linkStoryToEpic dùng sai endpoint: https://github.com/greddy7574/taigaMcpServer/issues/5
12. Issue #6, linkStoryToEpic 400 "epic field is required": https://github.com/greddy7574/taigaMcpServer/issues/6
13. PR #7, sửa endpoint linkStoryToEpic: https://github.com/greddy7574/taigaMcpServer/pull/7
14. Issue #4, updateUserStoryStatus bỏ qua projectIdentifier: https://github.com/greddy7574/taigaMcpServer/issues/4
15. PR #8, đăng nhập lại khi gặp 401: https://github.com/greddy7574/taigaMcpServer/pull/8
16. `LICENSE` @1.9.20: https://github.com/greddy7574/taigaMcpServer/blob/77fc95e97042c5f5daa9d3469c1220d7044ea58d/LICENSE
17. `src/query/QueryExecutor.js` @1.9.20: https://github.com/greddy7574/taigaMcpServer/blob/77fc95e97042c5f5daa9d3469c1220d7044ea58d/src/query/QueryExecutor.js
18. Fork `Elio9352/taigaMcpServer` / npm `@elio9352/taiga-mcp-server`: https://github.com/Elio9352/taigaMcpServer, https://registry.npmjs.org/@elio9352%2Ftaiga-mcp-server
19. `madebyclowd/taiga-mcp-server` (README) / npm: https://github.com/madebyclowd/taiga-mcp-server, https://registry.npmjs.org/@madebyclowd%2Ftaiga-mcp-server
20. madebyclowd `attachments/tool.ts`: https://github.com/madebyclowd/taiga-mcp-server/blob/4979c1eba59cf49c13b8cf0a8732f2c10912aa59/src/tools/attachments/tool.ts
21. madebyclowd `epics/tool.ts` (`epic_link_user_story`): https://github.com/madebyclowd/taiga-mcp-server/blob/4979c1eba59cf49c13b8cf0a8732f2c10912aa59/src/tools/epics/tool.ts#L79
22. madebyclowd `client/auth.ts` (refresh): https://github.com/madebyclowd/taiga-mcp-server/blob/4979c1eba59cf49c13b8cf0a8732f2c10912aa59/src/client/auth.ts#L116
23. madebyclowd `raw-request/schema.ts`: https://github.com/madebyclowd/taiga-mcp-server/blob/4979c1eba59cf49c13b8cf0a8732f2c10912aa59/src/tools/raw-request/schema.ts
24. madebyclowd `projects/schema.ts`: https://github.com/madebyclowd/taiga-mcp-server/blob/4979c1eba59cf49c13b8cf0a8732f2c10912aa59/src/tools/projects/schema.ts
25. madebyclowd `shared/resource-registry.ts`: https://github.com/madebyclowd/taiga-mcp-server/blob/4979c1eba59cf49c13b8cf0a8732f2c10912aa59/src/tools/shared/resource-registry.ts
26. `illodev/taiga-mcp` (README, `src/client.ts`): https://github.com/illodev/taiga-mcp, https://github.com/illodev/taiga-mcp/blob/d2720f8b14e5bbb6cd67d54b7bfc6fd06df40dde/src/client.ts#L170
27. npm `@illodev/taiga-mcp`: https://registry.npmjs.org/@illodev%2Ftaiga-mcp
28. `talhaorak/pytaiga-mcp` (README): https://github.com/talhaorak/pytaiga-mcp
29. pytaiga-mcp `src/server.py` (`create_project` L776, `link_user_story_to_epic` L1753, `set_custom_attribute_values` L2517, `list_attachments` L3033): https://github.com/talhaorak/pytaiga-mcp/blob/ec361ec2ed65b6612443087ebf5a483858d81b8c/src/server.py#L776
30. Repo nhỏ khác: https://github.com/OFFSET3/taiga-mcp, https://github.com/negoro26/mcp-taiga, https://github.com/afalabarce/taiga-mcp-server
31. Tìm kiếm npm "taiga mcp": https://registry.npmjs.org/-/v1/search?text=taiga%20mcp ; GitHub: https://github.com/search?q=taiga+mcp&type=repositories
32. Taiga REST API docs: https://docs.taiga.io/api.html (các anchor cụ thể nằm trong danh sách link ở cuối file)
33. taiga-back `settings/common.py` (JWT L450–454, throttle L487, `MAX_PAGINATE_BY` L505, `DEFAULT_PROJECT_TEMPLATE` L520): https://github.com/taigaio/taiga-back/blob/830978962987b0de8856f5bb6344ba06399dc1aa/settings/common.py#L450-L520
34. taiga-back `taiga/projects/signals.py` (template mặc định khi tạo project, L51–62): https://github.com/taigaio/taiga-back/blob/830978962987b0de8856f5bb6344ba06399dc1aa/taiga/projects/signals.py#L51-L62
35. taiga-back `taiga/projects/models.py` (`ProjectTemplate.apply_to_project`, L1250): https://github.com/taigaio/taiga-back/blob/830978962987b0de8856f5bb6344ba06399dc1aa/taiga/projects/models.py#L1250
36. taiga-back `taiga/projects/permissions.py` (`create_template_perms` L69, `create_tag_perms` L76, `duplicate_perms` L80, `ProjectTemplatePermission` L247): https://github.com/taigaio/taiga-back/blob/830978962987b0de8856f5bb6344ba06399dc1aa/taiga/projects/permissions.py#L69-L253
37. taiga-back `taiga/routers.py` (swimlanes, L81): https://github.com/taigaio/taiga-back/blob/830978962987b0de8856f5bb6344ba06399dc1aa/taiga/routers.py#L81
38. taiga-back `taiga/projects/services/projects.py` (`duplicate_project`, L291): https://github.com/taigaio/taiga-back/blob/830978962987b0de8856f5bb6344ba06399dc1aa/taiga/projects/services/projects.py#L291
39. taiga-docker `taiga-gateway/taiga.conf` (`client_max_body_size 100M`): https://github.com/taigaio/taiga-docker/blob/e12c106b265ab8c51ee7e62b744ffddd0f0d9771/taiga-gateway/taiga.conf#L4
40. Quan sát trực tiếp instance (chỉ đọc, 2026-11-01): `GET https://taiga.vidratek.net/api/v1/project-templates` (ẩn danh) và tool MCP `listProjects`
41. Claude Code, MCP: https://code.claude.com/docs/en/mcp
42. Claude Code, Skills: https://code.claude.com/docs/en/skills
43. Claude Code, Headless / Agent SDK CLI: https://code.claude.com/docs/en/headless
44. Claude Code, Permissions: https://code.claude.com/docs/en/permissions
45. Claude Code, Settings: https://code.claude.com/docs/en/settings
46. Claude Code, Memory (CLAUDE.md / AGENTS.md): https://code.claude.com/docs/en/memory
47. Claude Code, CLI reference: https://code.claude.com/docs/en/cli-reference
48. Codex, MCP (chuyển hướng tới learn.chatgpt.com/docs/extend/mcp): https://developers.openai.com/codex/mcp
49. Codex, Skills: https://developers.openai.com/codex/skills
50. Codex, Non-interactive mode (`codex exec`): https://developers.openai.com/codex/noninteractive
51. Codex, Config basics (project config và trust): https://developers.openai.com/codex/config-basic
52. Codex, Config reference: https://developers.openai.com/codex/config-reference
53. Codex, AGENTS.md: https://developers.openai.com/codex/guides/agents-md
54. Codex, Agent approvals & security: https://developers.openai.com/codex/agent-approvals-security
55. Codex, Advanced config: https://developers.openai.com/codex/config-advanced
56. Chuẩn Agent Skills: https://agentskills.io
57. Quan sát trong repo `taigent` (2026-11-01): `.mcp.json` (env literal, `npx -y` không ghim phiên bản, chưa bị git track, không có `.gitignore`); `.claude/skills` và `.agents/skills` là hai bản sao giống hệt nhau; `skills-lock.json`; `AGENTS.md`

[s1]: https://registry.npmjs.org/taiga-mcp-server
[s2]: https://registry.npmjs.org/taiga-mcp-server/-/taiga-mcp-server-1.9.20.tgz
[s3]: https://github.com/greddy7574/taigaMcpServer
[s4]: https://github.com/greddy7574/taigaMcpServer/blob/77fc95e97042c5f5daa9d3469c1220d7044ea58d/src/taigaAuth.js
[s5]: https://github.com/greddy7574/taigaMcpServer/blob/77fc95e97042c5f5daa9d3469c1220d7044ea58d/src/taigaService.js
[s6]: https://github.com/greddy7574/taigaMcpServer/blob/77fc95e97042c5f5daa9d3469c1220d7044ea58d/src/tools/attachmentTools.js
[s7]: https://github.com/greddy7574/taigaMcpServer/blob/77fc95e97042c5f5daa9d3469c1220d7044ea58d/src/tools/batchTools.js#L55-L60
[s8]: https://github.com/greddy7574/taigaMcpServer/blob/77fc95e97042c5f5daa9d3469c1220d7044ea58d/src/constants.js
[s9]: https://github.com/greddy7574/taigaMcpServer/blob/77fc95e97042c5f5daa9d3469c1220d7044ea58d/src/index.js
[s10]: https://github.com/greddy7574/taigaMcpServer/blob/77fc95e97042c5f5daa9d3469c1220d7044ea58d/src/tools/index.js
[s11]: https://github.com/greddy7574/taigaMcpServer/issues/5
[s12]: https://github.com/greddy7574/taigaMcpServer/issues/6
[s13]: https://github.com/greddy7574/taigaMcpServer/pull/7
[s14]: https://github.com/greddy7574/taigaMcpServer/issues/4
[s15]: https://github.com/greddy7574/taigaMcpServer/pull/8
[s16]: https://github.com/greddy7574/taigaMcpServer/blob/77fc95e97042c5f5daa9d3469c1220d7044ea58d/LICENSE
[s17]: https://github.com/greddy7574/taigaMcpServer/blob/77fc95e97042c5f5daa9d3469c1220d7044ea58d/src/query/QueryExecutor.js
[s18]: https://github.com/Elio9352/taigaMcpServer
[s19]: https://github.com/madebyclowd/taiga-mcp-server
[s20]: https://github.com/madebyclowd/taiga-mcp-server/blob/4979c1eba59cf49c13b8cf0a8732f2c10912aa59/src/tools/attachments/tool.ts
[s21]: https://github.com/madebyclowd/taiga-mcp-server/blob/4979c1eba59cf49c13b8cf0a8732f2c10912aa59/src/tools/epics/tool.ts#L79
[s22]: https://github.com/madebyclowd/taiga-mcp-server/blob/4979c1eba59cf49c13b8cf0a8732f2c10912aa59/src/client/auth.ts#L116
[s23]: https://github.com/madebyclowd/taiga-mcp-server/blob/4979c1eba59cf49c13b8cf0a8732f2c10912aa59/src/tools/raw-request/schema.ts
[s24]: https://github.com/madebyclowd/taiga-mcp-server/blob/4979c1eba59cf49c13b8cf0a8732f2c10912aa59/src/tools/projects/schema.ts
[s25]: https://github.com/madebyclowd/taiga-mcp-server/blob/4979c1eba59cf49c13b8cf0a8732f2c10912aa59/src/tools/shared/resource-registry.ts
[s26]: https://github.com/illodev/taiga-mcp
[s27]: https://registry.npmjs.org/@illodev%2Ftaiga-mcp
[s28]: https://github.com/talhaorak/pytaiga-mcp
[s29]: https://github.com/talhaorak/pytaiga-mcp/blob/ec361ec2ed65b6612443087ebf5a483858d81b8c/src/server.py#L776
[s30]: https://github.com/OFFSET3/taiga-mcp
[s31]: https://registry.npmjs.org/-/v1/search?text=taiga%20mcp
[s32]: https://docs.taiga.io/api.html
[s32a]: https://docs.taiga.io/api.html#auth-normal-login
[s32b]: https://docs.taiga.io/api.html#auth-refresh
[s32c]: https://docs.taiga.io/api.html#_application_token_authentication
[s32d]: https://docs.taiga.io/api.html#project-templates-list
[s32e]: https://docs.taiga.io/api.html#projects-create-template
[s32f]: https://docs.taiga.io/api.html#projects-create
[s32g]: https://docs.taiga.io/api.html#projects-duplicate
[s32h]: https://docs.taiga.io/api.html#projects-edit
[s32i]: https://docs.taiga.io/api.html#projects-create-tag
[s32j]: https://docs.taiga.io/api.html#user-story-statuses-create
[s32k]: https://docs.taiga.io/api.html#user-story-custom-attributes-values-edit
[s32l]: https://docs.taiga.io/api.html#memberships-create
[s32m]: https://docs.taiga.io/api.html#epics-create
[s32n]: https://docs.taiga.io/api.html#epics-bulk-create
[s32o]: https://docs.taiga.io/api.html#epics-related-user-stories-create
[s32p]: https://docs.taiga.io/api.html#user-stories-create
[s32q]: https://docs.taiga.io/api.html#user-stories-bulk-create
[s32r]: https://docs.taiga.io/api.html#tasks-create
[s32s]: https://docs.taiga.io/api.html#tasks-bulk-create
[s32t]: https://docs.taiga.io/api.html#user-stories-create-attachment
[s32u]: https://docs.taiga.io/api.html#wiki-create-attachment
[s32v]: https://docs.taiga.io/api.html#object-attachment-detail
[s32w]: https://docs.taiga.io/api.html#wiki-create
[s32x]: https://docs.taiga.io/api.html#user-stories-list
[s32y]: https://docs.taiga.io/api.html#_occ_optimistic_concurrency_control
[s32z]: https://docs.taiga.io/api.html#_pagination
[s33]: https://github.com/taigaio/taiga-back/blob/830978962987b0de8856f5bb6344ba06399dc1aa/settings/common.py#L450-L520
[s34]: https://github.com/taigaio/taiga-back/blob/830978962987b0de8856f5bb6344ba06399dc1aa/taiga/projects/signals.py#L51-L62
[s35]: https://github.com/taigaio/taiga-back/blob/830978962987b0de8856f5bb6344ba06399dc1aa/taiga/projects/models.py#L1250
[s36]: https://github.com/taigaio/taiga-back/blob/830978962987b0de8856f5bb6344ba06399dc1aa/taiga/projects/permissions.py#L69-L253
[s37]: https://github.com/taigaio/taiga-back/blob/830978962987b0de8856f5bb6344ba06399dc1aa/taiga/routers.py#L81
[s38]: https://github.com/taigaio/taiga-back/blob/830978962987b0de8856f5bb6344ba06399dc1aa/taiga/projects/services/projects.py#L291
[s39]: https://github.com/taigaio/taiga-docker/blob/e12c106b265ab8c51ee7e62b744ffddd0f0d9771/taiga-gateway/taiga.conf#L4
[s40]: https://taiga.vidratek.net/api/v1/project-templates
[s41]: https://code.claude.com/docs/en/mcp
[s42]: https://code.claude.com/docs/en/skills
[s43]: https://code.claude.com/docs/en/headless
[s44]: https://code.claude.com/docs/en/permissions
[s45]: https://code.claude.com/docs/en/settings
[s46]: https://code.claude.com/docs/en/memory
[s47]: https://code.claude.com/docs/en/cli-reference
[s48]: https://developers.openai.com/codex/mcp
[s49]: https://developers.openai.com/codex/skills
[s50]: https://developers.openai.com/codex/noninteractive
[s51]: https://developers.openai.com/codex/config-basic
[s52]: https://developers.openai.com/codex/config-reference
[s53]: https://developers.openai.com/codex/guides/agents-md
[s54]: https://developers.openai.com/codex/agent-approvals-security
[s55]: https://developers.openai.com/codex/config-advanced
[s56]: https://agentskills.io
[s57]: ../../AGENTS.md
