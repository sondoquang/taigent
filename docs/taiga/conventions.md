# Quy ước Taiga

Đây là tài liệu quy ước Taiga **duy nhất** của team. `AGENTS.md` trỏ tới đây nên cả Claude Code lẫn Codex CLI
đều đọc. Mọi project, epic, story, task, wiki và attachment trên `taiga.vidratek.net` đều tạo theo tài liệu này.

- Các quy tắc kiểm được offline nằm ở `src/manifest/conventions.ts`, và `taigent validate` kiểm chúng. Mỗi quy tắc
  có một mã `rule` (cột "Rule" bên dưới). Mã này xuất hiện trong lỗi của `validate`/`plan`/`apply`.
- Đổi quy ước thì sửa **cả** tài liệu này **lẫn** `conventions.ts` trong cùng một commit.
- Cú pháp CLI, cấu trúc manifest và exit code: xem `docs/cli.md`. Nguồn và bằng chứng kỹ thuật:
  `docs/research/taiga-agent-automation.md`.

## 1. Quy trình plan → review → apply

Thao tác **ghi** lên Taiga chỉ đi qua CLI `taigent`. MCP Taiga chỉ dùng để đọc, tra cứu, báo cáo và comment.

1. **Plan (chỉ ghi file).** Agent đọc spec/PRD rồi viết hoặc cập nhật manifest trong `taiga/<slug>/`
   (`project.yaml`, `backlog.yaml`, `docs.yaml`).
   - Sửa manifest hiện có, giữ nguyên `key` cũ. Không viết lại từ đầu.
   - Có thể đọc Taiga để tránh tạo trùng việc đã có: `taigent plan --project <slug> --json` (chỉ đọc) cho các item
     đã có tag `src:`, và tool MCP đọc cho việc người khác tạo tay.
   - Kết thúc bằng `taigent validate --project <slug>`. Phải ra exit 0.
2. **Review.** Người dùng duyệt diff manifest trong git như duyệt code, rồi chạy (hoặc để agent chạy)
   `taigent plan --project <slug>` để xem chính xác những gì sẽ đổi trên Taiga (exit 3 = có thay đổi).
3. **Apply (chỉ sau khi người dùng đồng ý tường minh).** `taigent apply --project <slug> --yes`, rồi commit
   `state.json` cùng manifest. Agent **không bao giờ** tự thêm `--yes` khi người dùng chưa đồng ý.

`plan` và `apply` từ chối manifest sai quy ước với exit 4 và không gọi Taiga. Chạy lại `apply` luôn an toàn:
item đã có thì bỏ qua (khớp theo tag `src:<key>`), và CLI không bao giờ xoá gì trên Taiga.

## 2. Tên và slug project

| Rule | Quy tắc |
|---|---|
| `project-name` | Tên có dạng `<Khách hàng/Mảng> - <Sản phẩm>`: đúng hai phần, nối bằng ` - ` (dấu cách, gạch ngang, dấu cách). Mỗi phần không rỗng, không có dấu cách thừa ở đầu/cuối hay hai dấu cách liền nhau. |
| `project-slug` | `slug` = slug Taiga sinh từ tên: bỏ dấu (`đ` → `d`), chữ thường, bỏ ký tự đặc biệt, chuỗi dấu cách/gạch ngang → một `-`. |
| `project-dir` | Thư mục manifest `taiga/<slug>/` trùng với `slug` trong `project.yaml`. |

| Đúng | Sai |
|---|---|
| `Vigo - Core Mapping` → `vigo-core-mapping` | `Vigo-Devops` (thiếu ` - `) |
| `Vigo - Vigo Auth` → `vigo-vigo-auth` | slug `vigo-authenautho` cho `Vigo - Vigo Auth` |
| `Nội bộ - Quản lý kho` → `noi-bo-quan-ly-kho` | `Vigo - Core - Mapping` (ba phần) |

Lưu ý: Taiga coi `slug` là read-only khi tạo project và tự sinh nó từ tên. Nếu instance bật
`DEFAULT_PROJECT_SLUG_PREFIX` (mặc định của taiga-back), slug sẽ có thêm tiền tố username của người tạo.
`taigent bootstrap` kiểm slug thực tế sau khi tạo và báo lỗi nếu nó khác manifest. Đổi tên project về sau
**không** đổi slug.

## 3. Template và module

| Rule | Quy tắc |
|---|---|
| `template` | `template` là `scrum` hoặc `kanban` (hai template của instance). Không tạo template mới, vì việc đó cần quyền superuser. |
| `module-known` | `modules` chỉ gồm `epics`, `backlog`, `kanban`, `issues`, `wiki`. |
| `module-required` | Luôn có `epics` và `wiki`. Template của instance để Epics **tắt**, nên bootstrap phải bật nó. |

Chọn template:

- **`scrum`**: dự án phát triển sản phẩm, chia sprint và ước lượng points (backlog + sprint).
- **`kanban`**: vận hành, bảo trì, hỗ trợ, DevOps. Luồng việc liên tục, không chia sprint.

Bootstrap chỉ **bật** module có trong danh sách. Module không liệt kê thì giữ nguyên, không bị tắt.

## 4. Tags

Manifest chỉ dùng tag có tiền tố. Taiga tự đổi tag sang chữ thường, nên tag trong manifest phải viết thường.

| Tiền tố | Giá trị | Màu chuẩn | Ai gắn |
|---|---|---|---|
| `type:` | `feature`, `bug`, `chore` | `type:feature` `#2E7D32`, `type:bug` `#C62828`, `type:chore` `#757575` | Người viết manifest |
| `area:` | kebab-case chữ thường, tên module/mảng, ví dụ `area:auth`, `area:user-profile` | `#1565C0` (mọi `area:*`) | Người viết manifest |
| `src:` | `src:<key>` viết thường, ví dụ `src:auth-login` | không màu | **Chỉ `taigent`** |

| Rule | Quy tắc |
|---|---|
| `tag-prefix` | Tag phải bắt đầu bằng `type:` hoặc `area:`. |
| `tag-format` | `type:` chỉ nhận `feature`/`bug`/`chore`; giá trị `area:` là kebab-case chữ thường. |
| `tag-reserved` | Không viết `src:` trong manifest. `apply` tự gắn `src:<key>`, và tag này là danh tính của item trên Taiga. |
| `tag-color` | Tag khai báo trong `project.yaml` dùng đúng màu chuẩn ở bảng trên. |

Bootstrap tạo các tag khai báo trong `project.yaml` với màu chuẩn, nên `project.yaml` khai báo đủ ba tag
`type:*` và các tag `area:*` của project. Tag người dùng tự gắn trên Taiga được giữ nguyên, `apply` không gỡ.

## 5. Key của item

| Rule | Quy tắc |
|---|---|
| `key-format` | Mỗi epic, story, task có `key`: chữ hoa, số, gạch ngang giữa các nhóm (`^[A-Z0-9]+(-[A-Z0-9]+)*$`), ví dụ `AUTH`, `AUTH-LOGIN`, `AUTH-LOGIN-API`. |
| `key-unique` | Key duy nhất trong cả project (epic, story, task dùng chung một không gian key). |
| `key-reference` | Mọi chỗ tham chiếu key (ví dụ `target` của attachment trong `docs.yaml`) phải trỏ tới key có trong `backlog.yaml`. |

- Key **không đổi** sau khi đã apply: đổi key = item mới + item cũ thành mồ côi.
- Gợi ý đặt key: epic là tên mảng (`AUTH`), story là `<EPIC>-<việc>` (`AUTH-LOGIN`), task là
  `<STORY>-<bước>` (`AUTH-LOGIN-API`).
- Item bỏ khỏi manifest không bị xoá trên Taiga. `plan` báo nó là mồ côi để người quyết định.
- Chuyển task sang story khác (hoặc story sang epic khác) trong manifest: `apply` gắn task vào story mới
  (`user_story`), và gắn story vào epic mới. Liên kết cũ với epic cũ **không bị gỡ**; `plan` báo nó trong
  `staleLinks` để người quyết định gỡ tay trên Taiga.

## 6. Mẫu mô tả story và task

Manifest không có field status, assignee, sprint hay points. Các field đó thuộc về người làm và `apply` không
ghi đè chúng.

**Story** (`epics[].stories[]`): `key`, `subject`, `description`, `acceptance_criteria` (danh sách), `spec`
(link hoặc đường dẫn tới spec/PRD), `tags`, `tasks`.

- `subject`: một câu ngắn, bắt đầu bằng động từ hoặc tên tính năng, ví dụ `Đăng nhập bằng email`.
- `description`: câu user story `Là <vai trò>, tôi muốn <mục tiêu>, để <lợi ích>.`, có thể kèm ngữ cảnh.
- `acceptance_criteria`: mỗi tiêu chí là một câu kiểm được.

`apply` ghép mô tả trên Taiga theo đúng mẫu sau (phần rỗng thì bỏ):

```markdown
Là người dùng, tôi muốn đăng nhập bằng email, để truy cập dữ liệu của mình.

## Acceptance criteria

- [ ] Đăng nhập đúng mật khẩu thì vào trang chủ.
- [ ] Sai mật khẩu 5 lần thì khoá 15 phút.

Spec: docs/specs/auth.md
```

**Task** (`stories[].tasks[]`): `key`, `subject`, `description`, `tags`. `description` ghi định nghĩa
**done** của task, ví dụ:

```markdown
Done khi: API `POST /login` trả token, có test tích hợp, đã review và merge.
```

**Epic** (`epics[]`): `key`, `subject`, `description` (mục tiêu của mảng việc, kèm link spec nếu có), `tags`.

Epic, story và task đều có thể có `custom_attributes`: mapping **tên** custom attribute → giá trị (chuỗi, số hoặc
`true`/`false`), ví dụ `custom_attributes: { "Estimate (h)": 4 }`. Tên phải trùng đúng (kể cả hoa/thường) với
attribute của loại item đó trên Taiga, tức là attribute khai báo trong `custom_attributes` của `project.yaml` và
đã tạo bằng `taigent bootstrap`. Tên không có trên project thì `plan`/`apply` báo lỗi và không ghi gì. `apply`
chỉ ghi các attribute có trong manifest; giá trị người khác đặt cho attribute khác được giữ nguyên.

## 7. Ánh xạ status mặc định

Status do người làm quản lý trên Taiga (hoặc qua tool MCP đọc/báo cáo). Manifest không khai báo status. Item
mới tạo luôn ở status đầu tiên. Khi báo cáo hoặc cập nhật status, dùng **đúng tên** sau của template mặc định:

| Loại | Status (theo thứ tự) | Ý nghĩa |
|---|---|---|
| User story | `New`, `Ready`, `In progress`, `Ready for test`, `Done`, `Archived` | `New` vừa tạo; `Ready` đủ AC, sẵn sàng làm; `In progress` đang làm; `Ready for test` đã merge, chờ kiểm thử; `Done` đạt AC; `Archived` bỏ hoặc lưu trữ |
| Task | `New`, `In progress`, `Ready for test`, `Closed`, `Needs Info` | `Closed` = đạt định nghĩa done; `Needs Info` = bị chặn, chờ thông tin |
| Epic | `New`, `Ready`, `In progress`, `Ready for test`, `Done` | Epic `Done` khi mọi story của nó `Done` hoặc `Archived` |

Danh sách status story và task đã đối chiếu với template trên instance. Danh sách status epic lấy từ
`taiga/projects/fixtures/initial_project_templates.json` của taiga-back (giống nhau cho `scrum` và `kanban`), chưa
đối chiếu trực tiếp trên instance.

## 8. Wiki

| Rule | Quy tắc |
|---|---|
| `wiki-slug` | Slug là kebab-case chữ thường. |
| `wiki-slug-unique` | Mỗi slug khai báo một lần trong `docs.yaml`. |
| `wiki-file` | Trang wiki là file Markdown (`.md`) trong repo. |
| `wiki-reference` | Attachment `target: wiki:<slug>` trỏ tới trang có trong `docs.yaml` (hoặc `home`). |

Slug chuẩn:

- `home`: trang vào của project, tạo từ `wiki_home` trong `project.yaml` khi bootstrap.
- `spec-<epic-key>`: spec/PRD của một epic, ví dụ `spec-auth` cho epic `AUTH`.
- `adr-<nnnn>-<tiêu-đề>`: quyết định kiến trúc, ví dụ `adr-0001-use-rest-api`.
- `guide-<chủ-đề>`: hướng dẫn, ví dụ `guide-deploy`; `meeting-<yyyy-mm-dd>`: biên bản họp.

## 9. Attachment

| Rule | Quy tắc |
|---|---|
| `attachment-name` | Tên file là kebab-case chữ thường, không dấu, có phần mở rộng: `<chủ-đề>[-<phiên-bản>].<ext>`, ví dụ `auth-login-flow.pdf`, `invoice-template-v2.docx`. |
| `file-exists` | File khai báo trong `docs.yaml` phải có trong repo (đường dẫn tính từ thư mục của `docs.yaml`). |
| `key-reference` | `target` là key của epic/story/task trong `backlog.yaml`, hoặc `wiki:<slug>`. |

- Tên file trên đĩa chính là tên attachment trên Taiga. `upload` coi attachment là trùng khi cùng tên và cùng
  `sha1`/`size`, nên đừng đổi tên file đã upload.
- Gắn attachment vào item hẹp nhất có liên quan (task trước story, story trước epic). Tài liệu chung thì gắn vào
  trang wiki.
- `description` của attachment ghi ngắn gọn nội dung và nguồn (ví dụ `Luồng đăng nhập, bản 2026-10`).

## 10. Tool MCP bị cấm

Các tool sau của `taiga-mcp-server@1.9.20` đang hỏng. Agent **không được gọi** chúng; skill và wrapper headless
không đưa chúng vào allowlist.

| Tool | Lý do | Dùng thay |
|---|---|---|
| `linkStoryToEpic` | Gọi `PATCH /userstories/{id}` với `{epic}` thay vì `POST /epics/{id}/related_userstories`. Tool báo thành công nhưng liên kết **không được lưu**. | Khai báo story dưới epic trong `backlog.yaml`, rồi `taigent apply` |
| `batchCreateUserStories`, `batchCreateTasks`, `batchCreateIssues` | Gửi `projectId` thay cho `project`, `userStoryId` thay cho `user_story`, `points` dạng số thay cho dict, nên dễ bị Taiga trả 400. Item tạo ra cũng không có tag `src:<key>`, nên chạy lại sẽ tạo trùng. | `backlog.yaml` + `taigent apply` |
| `downloadAttachment` cho story/task | Luôn gọi `/issues/attachments/{id}`, nên với attachment của story/task sẽ lỗi hoặc tải nhầm attachment của issue khác. | Đọc link `url` của attachment từ `listAttachments` |
| `deleteAttachment` cho story/task | Luôn gọi `/issues/attachments/{id}`, nên có thể **xoá nhầm** attachment của một issue. Hơn nữa quy trình không xoá dữ liệu trên Taiga. | Xoá tay trên Taiga, sau khi người quyết định |

Ngoài danh sách cấm, các tool MCP **ghi** khác (`createEpic`, `createUserStory`, `createTask`, `updateEpic`,
`createWikiPage`, `updateWikiPage`, `uploadAttachment`…) cũng không dùng cho backlog và tài liệu. Chúng không gắn
`src:<key>` và không chống trùng. Dùng `taigent apply`/`taigent upload`. MCP chỉ dùng để đọc (`list*`, `get*`,
`advancedSearch`, `getMilestoneStats`…) và comment.
