# Quy ước Taiga

Đây là tài liệu quy ước Taiga **duy nhất** của team. `AGENTS.md` trỏ tới đây nên cả Claude Code lẫn Codex CLI
đều đọc. Mọi project, epic, story, task, issue, wiki và attachment trên `taiga.vidratek.net` đều tạo theo tài liệu này.

- Các quy tắc kiểm được offline nằm ở `src/manifest/conventions.ts`, và `taigent validate` kiểm chúng. Mỗi quy tắc
  có một mã `rule` (cột "Rule" bên dưới). Mã này xuất hiện trong lỗi của `validate`/`plan`/`apply`.
- Đổi quy ước thì sửa **cả** tài liệu này **lẫn** `conventions.ts` trong cùng một commit.
- Cú pháp CLI, cấu trúc manifest và exit code: xem `docs/cli.md`. Nguồn và bằng chứng kỹ thuật:
  `docs/research/taiga-agent-automation.md`.

## 1. Quy trình plan → review → apply

Thao tác **ghi** lên Taiga chỉ đi qua CLI `taigent`. MCP Taiga chỉ dùng để đọc, tra cứu, báo cáo và comment.

**Taiga là nguồn sự thật; manifest là bản nháp** của những gì chưa apply
([ADR 0004](../adr/0004-adopt-existing-taiga-projects.md)). Ai đó sửa item trên Taiga thì giá trị trên Taiga thắng:
`taigent pull` ghi lại vào `backlog.yaml`, không bao giờ âm thầm ghi đè Taiga.

1. **Plan (chỉ ghi file).** Agent đọc spec/PRD rồi viết hoặc cập nhật manifest trong `taiga/<slug>/`
   (`project.yaml`, `backlog.yaml`, `docs.yaml`).
   - Sửa manifest hiện có, giữ nguyên `key` cũ. Không viết lại từ đầu.
   - Đọc Taiga để tránh tạo trùng việc đã có: `taigent snapshot --project <slug>` ghi toàn bộ epic và story, task,
     issue đang mở (cả item tạo tay) vào `taiga/<slug>/snapshot.json` (không commit), và
     `taigent plan --project <slug> --json` (chỉ đọc) cho các item đã có tag `src:`. Item tạo tay mà spec đụng tới
     chỉ vào manifest qua `taigent adopt`, sau khi người dùng xác nhận **từng item** (§5).
   - Kết thúc bằng `taigent validate --project <slug>`. Phải ra exit 0.
2. **Review.** Business Analyst / Product Owner duyệt backlog trước khi apply:
   - **Taigent Desktop** (`docs/desktop.md`) hoặc `taigent preview --project <slug>` (offline, in một trang Markdown
     đúng những gì `apply` sẽ ghi, kèm trạng thái review). Mỗi item được đánh dấu **approved** (đồng ý) hoặc
     **changes** (cần sửa) và có thể kèm comment. Tất cả nằm trong `taiga/<slug>/review.yaml`, commit cùng manifest
     (định dạng: `docs/cli.md` mục Review).
   - Agent đọc `review.yaml`, xử lý từng comment chưa resolved bằng cách sửa manifest, rồi đặt `resolved: true` và
     `reply` (trả lời ngắn bằng tiếng Việt) cho comment đó. Agent **không bao giờ** đổi verdict; verdict chỉ do người
     review đặt. Item sửa sau khi đã approved thì verdict thành **stale** (digest khác) và cần duyệt lại.
   - BA cũng có thể sửa thẳng bản preview: `taigent preview --project <slug> --out taiga/<slug>/preview.md`, kèm một
     bản giữ nguyên ở `taiga/<slug>/.preview/base.md` (ghi cùng lúc). Skill `taiga-apply-backlog` so hai bản bằng
     `git diff --no-index`, ghi từng chỗ BA sửa vào `backlog.yaml` (manifest vẫn là nguồn sự thật), chạy `validate`
     rồi mới `plan`. Không commit `preview.md` và `.preview/`: đó là bản làm việc.
   - Người dùng duyệt diff manifest trong git như duyệt code, rồi chạy (hoặc để agent chạy)
     `taigent plan --project <slug>` để xem chính xác những gì sẽ đổi trên Taiga (exit 3 = có thay đổi).
3. **Apply (chỉ sau khi người dùng đồng ý tường minh).** `taigent apply --project <slug> --yes`, rồi commit
   `state.json` cùng manifest. Agent **không bao giờ** tự thêm `--yes` khi người dùng chưa đồng ý. Approve trong
   `review.yaml` **không** phải là đồng ý apply: `plan`/`apply` bỏ qua `review.yaml`, và apply vẫn cần người dùng đồng
   ý tường minh.

`plan` và `apply` từ chối manifest sai quy ước với exit 4 và không ghi gì lên Taiga. Riêng rule `story-format` cho
story sắp được tạo (§6.2), rule `issue-value` (§6.4) và rule `item-ref` (§5) được kiểm sau khi đọc Taiga, vì chỉ
Taiga biết story nào là mới, project có những giá trị issue nào và mỗi `ref` là item nào. Chạy lại `apply` luôn an
toàn: item đã có thì bỏ qua (khớp theo tag `src:<key>`), và CLI không bao giờ xoá gì trên Taiga.
Item bị sửa trên Taiga sau lần apply trước (remote edit), bị sửa khác nhau ở cả hai bên (both edited, `both-edited`),
hoặc chưa có baseline trong `state.json` mà khác manifest (unknown) thì bị chặn: `plan` liệt kê chúng kèm giá trị từng
bên và thoát exit 6, `apply --yes` thoát exit 6 và không ghi gì (`docs/cli.md` §Baseline and remote edits). Item
đang được adopt theo `ref` được so ba bên với baseline mà `taigent adopt` ghi vào map `adopted` của `state.json`: Taiga
bị sửa sau lần adopt thì item bị chặn như trên. Item có `ref` viết tay mà không có mục `adopted` thì không bị chặn.
Item `state.json` đã ghi (key → id) mà trên Taiga mất tag `src:<key>` bị chặn `remote-edit` ở field `tags` (không
bao giờ tạo bản trùng); gỡ bằng cách gắn lại tag `src:<key>` trên Taiga, hoặc ghi `ref: <n>` của item vào
`backlog.yaml` để apply adopt lại (`pull` từ chối item này). Agent không chạy `apply --yes` khi còn item bị chặn; mỗi
item được gỡ bằng `taigent pull` (lấy giá trị Taiga vào manifest), hoặc gộp với người dùng rồi `pull --keep-manifest`
(both edited), hoặc `--keep-manifest` khi người dùng chủ ý giữ manifest sau khi đã xem item (không bao giờ mặc định).
`pull` story user story format phải parse lại được, không thì dừng (exit 4, kind `pull`); story legacy có
`acceptance_criteria` cũng vậy; story legacy không có `acceptance_criteria` lẫn `spec` (dạng adopt ghi) thì nhận
nguyên mô tả Taiga vào `description`. Khi parse lỗi, agent viết lại item theo **đúng format của nó**: user story
format cho story user story format; story legacy thì cùng người dùng tách lại `acceptance_criteria`, không bao giờ
chuyển legacy sang user story format. Lần `plan` đầu sau khi nâng cấp hiện các item apply trước đây mà khác Taiga là
`unknown`.

`taigent validate` kiểm cả `review.yaml` (khi có):

| Rule | Quy tắc |
|---|---|
| `key-reference` | Mỗi key trong `items` của `review.yaml` có trong `backlog.yaml`. Xoá item thì xoá mục review của nó; đổi key item thì chuyển comment sang key mới và bỏ verdict (item cần duyệt lại). Taigent Desktop tự làm việc này khi form đổi key hoặc xoá item. |
| `review-verdict` | `verdict` là `approved` hoặc `changes`, và đi kèm `digest` của item lúc duyệt. |
| `review-comment-unique` | `id` của comment là duy nhất trong một item (`c1`, `c2`, …). |

Ngoại lệ duy nhất của quy trình trên là sửa **ticket của chính mình** (user story được giao cho mình):
`taigent status` (đổi status) và `taigent comment` (thêm comment) ghi ngay, không cần `--yes`, vì chính yêu cầu của
người dùng đã nêu rõ ticket và việc cần làm (skill `taiga-update-ticket`, kể cả khi yêu cầu đến từ Telegram). CLI
từ chối story không được giao cho người đang đăng nhập.

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
`taigent bootstrap` kiểm slug thực tế sau khi tạo và báo lỗi nếu nó khác manifest. Slug trùng với project private
mà bạn không thấy (không là thành viên) thì bootstrap từ chối trước khi tạo gì (nếu không Taiga sẽ tạo project thứ
hai với slug `<slug>-1`). Đổi tên project về sau **không** đổi slug.

**Project có sẵn** (Hand-made, tạo trên Taiga trước khi dùng taigent, tên/slug không theo quy ước): khai báo
`existing: true` trong `project.yaml`. Khi đó `project-name` và `project-slug` không áp dụng: `name` chỉ cần không rỗng,
`slug` là slug thật của project trên Taiga (chữ thường, số, `-`, `_`); `project-dir` vẫn áp dụng. `taigent bootstrap`
không bao giờ tạo project có `existing: true`: không tìm thấy slug trên Taiga thì dừng (exit 5, không ghi gì); tìm
thấy thì chỉ bổ sung module, tag, custom attribute, thành viên và wiki còn thiếu. Form project của Taigent Desktop tự
đặt cờ này khi lấy tên project từ Taiga.

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
| `key-format` | Mỗi epic, story, task, issue có `key`: chữ hoa, số, gạch ngang giữa các nhóm (`^[A-Z0-9]+(-[A-Z0-9]+)*$`), ví dụ `AUTH`, `AUTH-LOGIN`, `AUTH-LOGIN-API`. |
| `key-unique` | Key duy nhất trong cả project (epic, story, task, issue dùng chung một không gian key). |
| `key-reference` | Mọi chỗ tham chiếu key (ví dụ `target` của attachment trong `docs.yaml`) phải trỏ tới key có trong `backlog.yaml`. Attachment chỉ gắn vào epic, story hoặc task, không gắn vào issue. |
| `key-locked` | Item đã có trên Taiga (key có trong `state.json`) không đổi key: đổi key = item mới + item cũ thành mồ côi. Form của Taigent Desktop kiểm rule này khi lưu. |
| `ref-unique` | `ref` (nếu có) là số nguyên dương và mỗi ref chỉ thuộc một backlog item: một item trên Taiga không bao giờ gắn với hai backlog item. |
| `item-ref` | Kiểm sau khi đọc Taiga (`plan`/`apply`, exit 4): item mang tag `src:<key>` phải có đúng ref trong manifest; nếu chưa có item nào mang tag đó thì ref phải là một item **cùng loại**, **chưa có tag `src:`** trong project. |

- Key **không đổi** sau khi đã apply (rule `key-locked`).
- Gợi ý đặt key: epic là tên mảng (`AUTH`), story là `<EPIC>-<việc>` (`AUTH-LOGIN`), task là
  `<STORY>-<bước>` (`AUTH-LOGIN-API`), issue là `<tiền tố>-<việc>` với tiền tố theo `type`: `Question` → `ASK`,
  `Enhancement` → `ENH`, type khác (kể cả `Bug`) → `BUG`. Ví dụ `BUG-LONG-PASSWORD`.
- **Adopt hand-made item.** Item tạo tay trên Taiga (chưa có tag `src:`) chỉ vào manifest qua
  `taigent adopt --project <slug> --ref <n> --key <KEY>`, sau khi người dùng xác nhận từng item. Lệnh chỉ đọc Taiga
  và chỉ ghi file local: trong `backlog.yaml` một backlog item mới có `ref: <n>`, chép nguyên văn subject, mô tả, các
  tag có prefix hợp lệ (§4; tag khác vẫn nằm trên Taiga), và `type`/`severity`/`priority` theo tên với issue; không
  chép custom attribute; trong `state.json` (map `adopted`) các giá trị đã chép, làm baseline. Epic và issue nằm ở
  đầu `backlog.yaml`. Story cần thêm `--epic <KEY>`: nếu story đã nối với một hay nhiều epic trên Taiga thì `--epic`
  phải là một trong số đó (khớp theo tag `src:` hoặc `ref`), không thì adopt epic đó trước; story chưa nối epic nào
  thì `plan` đề xuất thêm `link`, nên adopt cũng nối nó vào epic `--epic`. Story giữ legacy format (§6.2). Task cần
  thêm `--story <KEY>`: story trong manifest, và phải đúng là backlog item mà task đang nằm trong trên Taiga. Lệnh từ
  chối (exit 2) item đã đóng, item đã có tag `src:`, key hoặc ref đã có trong manifest, story/task thiếu cha trong
  manifest, story có epic trên Taiga không phải `--epic`, task có story trên Taiga không phải backlog item (adopt story
  đó trước), và `backlog.yaml` bị sửa trong lúc adopt. Sau đó `plan` đề xuất action `adopt` (thêm tag `src:<key>`,
  cùng các update nội dung nếu có), so ba bên với baseline của adopt, và `apply` ghi tag đó rồi chuyển mục `adopted`
  sang `items`. `ref` giữ lại trong manifest sau apply, làm phép kiểm (rule `item-ref`).
- Story và task tạo tay nằm dưới một epic hoặc story của manifest (kể cả epic, story đã adopt) được `plan` liệt kê
  riêng trong `handMadeChildren`, không phải `staleLinks`. Taigent không động vào nội dung và liên kết của chúng.
- Item bỏ khỏi manifest không bị xoá trên Taiga. `plan` báo nó là mồ côi để người quyết định.
- Chuyển task sang story khác (hoặc story sang epic khác) trong manifest: `apply` gắn task vào story mới
  (`user_story`), và gắn story vào epic mới. Liên kết cũ với epic cũ **không bị gỡ**; `plan` báo nó trong
  `staleLinks` để người quyết định gỡ tay trên Taiga.

## 6. Mẫu mô tả story, task và issue

Manifest không có field status, assignee, sprint hay points. Các field đó thuộc về người làm và `apply` không
ghi đè chúng.

Mục này là nguồn chuẩn duy nhất cho user story của Taigent. Chuẩn là format **Mike Cohn** (Use case "As a / I
want to / so that") kết hợp tiêu chí chấp nhận **Gherkin** (Scenario / Given / When / Then). Đọc mục này là đủ
để viết đúng chuẩn, không cần cài skill nào khác.

### 6.1 User story format (bắt buộc cho mọi story mới)

**Story** (`epics[].stories[]`): `key`, `subject`, `use_case`, `scenarios`, `description` (tuỳ chọn), `spec`
(link hoặc đường dẫn tới spec/PRD), `tags`, `tasks`, `custom_attributes`. Nhãn (`As a`, `Scenario`, `Given`…)
giữ tiếng Anh; nội dung viết bằng ngôn ngữ của nhóm.

```yaml
- key: AUTH-GOOGLE
  subject: Đăng nhập bằng Google để người dùng thử không phải tạo mật khẩu mới
  use_case:
    as_a: người dùng thử lần đầu vào ứng dụng
    i_want_to: đăng nhập bằng tài khoản Google
    so_that: vào được ứng dụng mà không phải tạo và nhớ thêm một mật khẩu
  scenarios:
    - scenario: Người dùng thử đăng nhập lần đầu qua Google
      given:
        - Tôi đang ở trang đăng nhập
        - Tôi có tài khoản Google
      when: Tôi bấm "Đăng nhập bằng Google" và cấp quyền cho ứng dụng
      then: Tôi vào được ứng dụng và được chuyển tới màn hình onboarding
  description: Chỉ hỗ trợ tài khoản Google cá nhân ở bản này.
  spec: docs/specs/auth.md
```

Khung (do `taigent validate` kiểm tra offline):

- `use_case` là mapping có đủ `as_a`, `i_want_to`, `so_that`, mỗi trường là chuỗi không rỗng.
- `scenarios` là danh sách không rỗng. Mỗi scenario có `scenario` (tên, chuỗi không rỗng), `given` (danh sách
  ≥ 1 chuỗi), đúng **một** `when` và đúng **một** `then` (chuỗi, không phải danh sách).
- `use_case` và `scenarios` luôn đi cùng nhau, và không đi cùng `acceptance_criteria` (rule `story-format`).
  Trường lạ bị báo `known-field`.
- `description`: bối cảnh tuỳ chọn (ghi chú, giới hạn, link), không lặp lại Use case.

**Summary → subject.** `subject` chính là Summary của story: một câu ngắn, dễ nhớ, nói về **giá trị** cho người
dùng chứ không phải tính năng. ✅ `Xoá hàng loạt để người dùng thường xuyên tiết kiệm thời gian`;
❌ `Thêm nút xoá`.

`apply` ghép mô tả trên Taiga theo đúng mẫu sau. Các phần nối bằng một dòng trống, phần rỗng thì bỏ; Given thứ
hai trở đi dùng nhãn `and Given`:

```markdown
- **As a** người dùng thử lần đầu vào ứng dụng
- **I want to** đăng nhập bằng tài khoản Google
- **so that** vào được ứng dụng mà không phải tạo và nhớ thêm một mật khẩu

Chỉ hỗ trợ tài khoản Google cá nhân ở bản này.

## Acceptance criteria

- [ ] **Scenario:** Người dùng thử đăng nhập lần đầu qua Google
  - **Given:** Tôi đang ở trang đăng nhập
  - **and Given:** Tôi có tài khoản Google
  - **When:** Tôi bấm "Đăng nhập bằng Google" và cấp quyền cho ứng dụng
  - **Then:** Tôi vào được ứng dụng và được chuyển tới màn hình onboarding

Spec: docs/specs/auth.md
```

Mỗi scenario là một checkbox để QA viết test case và tick khi đã kiểm.

**Quality check** (máy không kiểm, người viết và reviewer kiểm):

- **As a** là persona cụ thể (`người dùng thử`, `admin của workspace`), không phải `người dùng` chung chung.
- **I want to** là hành động người dùng làm, không phải tính năng đội đang xây.
- **so that** là kết quả/động lực thật, không lặp lại "I want to". ❌ `muốn bấm Lưu, để lưu bài`;
  ✅ `muốn bấm Lưu, để không mất bài khi trang bị lỗi`.
- **When** khớp với "I want to"; **Then** khớp với "so that".
- **Then** đo được: ❌ `trải nghiệm tốt hơn`, `nhanh hơn`; ✅ `trang tải dưới 2 giây`, `thấy thông báo thành công`.
- Nhiều Given là bình thường; QA phải viết được test case từ mỗi scenario.

**Anti-pattern:**

- **Task kỹ thuật đội lốt story**: `Là developer, tôi muốn refactor API, để code sạch hơn`. Không có giá trị cho
  người dùng thì không phải story: ghi thành task (`tasks[]`) của story liên quan.
- **Feature list**: `tôi muốn dashboard, báo cáo và phân tích`. Quá lớn, phải tách.
- **Tiêu chí mơ hồ**: `tôi muốn trải nghiệm tốt hơn`, Then không đo được.
- Story là chỗ bắt đầu trao đổi, không phải hợp đồng khoá cứng.

**Luật tách story:**

- Cần nhiều hơn một When hoặc một Then trong một scenario → có nhiều story, tách ra.
- Use case chứa nhiều mục tiêu (nhiều "và" trong I want to, hay một danh sách tính năng) → mỗi mục tiêu một story.
- Các scenario của một story cùng phục vụ một Use case; scenario theo đuổi mục tiêu khác thì thành story riêng.
- Mỗi story sau khi tách vẫn phải độc lập, có giá trị và kiểm thử được.

### 6.2 Legacy format (chỉ cho story đã có trên Taiga)

Legacy format chỉ dành cho story đã có trên Taiga: story có tag `src:<key>`, hoặc story được adopt (có `ref`, §5).
`description` là câu `Là <vai trò>, tôi muốn <mục tiêu>, để <lợi ích>.` (kèm ngữ cảnh) và `acceptance_criteria` là
danh sách câu kiểm được. `apply` ghép:

```markdown
Là người dùng, tôi muốn đăng nhập bằng email, để truy cập dữ liệu của mình.

## Acceptance criteria

- [ ] Đăng nhập đúng mật khẩu thì vào trang chủ.
- [ ] Sai mật khẩu 5 lần thì khoá 15 phút.

Spec: docs/specs/auth.md
```

**Story tạo tay được adopt.** `taigent adopt` ghi story viết tự do trên Taiga thành story legacy format: toàn bộ mô tả
nằm nguyên văn trong `description`, không tách `acceptance_criteria` và không có `spec`. Story legacy không có
`acceptance_criteria` và không có `spec` được ghép ra **đúng** `description`, từng byte (giữ CRLF, khoảng trắng cuối
dòng, dòng trống cuối). Vì vậy adopt rồi `plan` ngay thì không có update nội dung nào, chỉ có tag `src:<key>`.

Không dùng legacy format cho story mới: `plan` và `apply` thoát exit 4 (rule `story-format`) khi một story sắp được
tạo không có `use_case`/`scenarios`. Story được adopt không bị rule này chặn, vì action của nó là `adopt`, không phải
`create`. Story cũ chỉ được chuyển sang user story format khi người dùng yêu cầu; khi đó `apply` cập nhật
`description` của nó như một thay đổi bình thường.

### 6.3 Task, epic và custom attributes

**Task** (`stories[].tasks[]`): `key`, `subject`, `description`, `tags`. `description` ghi định nghĩa
**done** của task, ví dụ:

```markdown
Done khi: API `POST /login` trả token, có test tích hợp, đã review và merge.
```

**Epic** (`epics[]`): `key`, `subject`, `description` (mục tiêu của mảng việc, kèm link spec nếu có), `tags`.

Epic, story, task và issue đều có thể có `custom_attributes`: mapping **tên** custom attribute → giá trị (chuỗi, số hoặc
`true`/`false`), ví dụ `custom_attributes: { "Estimate (h)": 4 }`. Tên phải trùng đúng (kể cả hoa/thường) với
attribute của loại item đó trên Taiga, tức là attribute khai báo trong `custom_attributes` của `project.yaml` và
đã tạo bằng `taigent bootstrap`. Tên không có trên project thì `plan`/`apply` báo lỗi và không ghi gì. `apply`
chỉ ghi các attribute có trong manifest; giá trị người khác đặt cho attribute khác được giữ nguyên.

### 6.4 Issue

**Issue** (`issues[]`, cấp trên cùng của `backlog.yaml`, ngang hàng với `epics`): `key`, `subject`, `description`,
`type`, `severity`, `priority`, `tags`, `custom_attributes`. Issue là bug, câu hỏi hoặc đề xuất cải tiến; nó nằm
ngoài cây epic → story → task: không có cha, không gắn vào epic hay story. Không có field status, assignee hay
sprint: người làm quản lý chúng trên Taiga, `apply` không bao giờ ghi chúng. Issue mới nhận status mặc định của
project (`New`).

`subject` tả triệu chứng, ngắn và cụ thể (`Login fails with a 100-character password`), không tả cách sửa.
`description` theo mẫu dưới (nhãn giữ tiếng Anh, nội dung viết bằng ngôn ngữ của nhóm). `apply` ghi description đúng
như trong manifest; `validate` không kiểm mẫu này. Với type `Question` hay `Enhancement`, bỏ các phần không hợp và
viết câu hỏi hoặc đề xuất trong một đoạn.

```markdown
## Steps to reproduce

1. Open the sign-in page
2. Type a 100-character password and submit

## Expected

I am signed in.

## Actual

The page shows "Server error" (HTTP 500).

Environment: production, Chrome 130
```

`type`, `severity`, `priority` là **tên** giá trị của chính project trên Taiga, viết đúng từng ký tự (kể cả
hoa/thường). Template mặc định (`scrum` và `kanban`) có:

| Field | Giá trị (theo thứ tự) | Mặc định | Chọn |
|---|---|---|---|
| `type` | `Bug`, `Question`, `Enhancement` | `Bug` | `Bug`: hệ thống chạy sai so với spec hoặc mong đợi; `Question`: cần câu trả lời, chưa chắc là lỗi; `Enhancement`: đề xuất cải tiến nhỏ, không đủ lớn để thành story |
| `severity` | `Wishlist`, `Minor`, `Normal`, `Important`, `Critical` | `Normal` | Mức ảnh hưởng: `Critical` mất dữ liệu, sập hoặc chặn luồng chính và không có cách vòng; `Important` hỏng một chức năng, có cách vòng; `Normal` lỗi thường; `Minor` lỗi giao diện, câu chữ; `Wishlist` cho đẹp hơn |
| `priority` | `Low`, `Normal`, `High` | `Normal` | Mức gấp, do BA/PO quyết: `High` cần sửa trong sprint này; `Normal` xếp vào backlog; `Low` khi rảnh |

Project có thể đổi tên hoặc thêm giá trị. Khi không chắc, xem tên type/severity/priority của issue có sẵn bằng tool
MCP đọc `getIssue`, hoặc chạy `taigent plan`: tên không có trên project bị báo (`issue-value`) kèm danh sách tên đúng.

| Rule | Quy tắc |
|---|---|
| `required` / `type` | `type`, `severity`, `priority` là chuỗi không rỗng (kiểm offline, cả trong `validate`). |
| `issue-value` | `type`, `severity`, `priority` trùng đúng tên một giá trị của project trên Taiga. Kiểm sau khi đọc Taiga: `plan`/`apply` thoát exit 4 và không ghi gì, lỗi trỏ tới `issues[i].<field>`. |

Issue bỏ khỏi manifest không bị xoá trên Taiga; `plan` báo nó là mồ côi như các item khác.

### 6.5 Nguồn tham khảo

- Mike Cohn, *User Stories Applied* (2004): format As a / I want to / so that.
- Gherkin (Cucumber): Given / When / Then.
- Skill `user-story` trong [deanpeters/product-manager-skills](https://github.com/deanpeters/product-manager-skills).

## 7. Ánh xạ status mặc định

Status do người làm quản lý: trên Taiga, hoặc với ticket của chính mình thì qua `taigent status` (§1). Manifest không khai báo status. Item
mới tạo luôn ở status đầu tiên. Khi báo cáo hoặc cập nhật status, dùng **đúng tên** sau của template mặc định:

| Loại | Status (theo thứ tự) | Ý nghĩa |
|---|---|---|
| User story | `New`, `Ready`, `In progress`, `Ready for test`, `Done`, `Archived` | `New` vừa tạo; `Ready` đủ AC, sẵn sàng làm; `In progress` đang làm; `Ready for test` đã merge, chờ kiểm thử; `Done` đạt AC; `Archived` bỏ hoặc lưu trữ |
| Task | `New`, `In progress`, `Ready for test`, `Closed`, `Needs Info` | `Closed` = đạt định nghĩa done; `Needs Info` = bị chặn, chờ thông tin |
| Epic | `New`, `Ready`, `In progress`, `Ready for test`, `Done` | Epic `Done` khi mọi story của nó `Done` hoặc `Archived` |
| Issue | `New`, `In progress`, `Ready for test`, `Closed`, `Needs Info`, `Rejected`, `Postponed` | `Ready for test`, `Closed`, `Rejected` là status đóng; `Needs Info` chờ người báo bổ sung; `Postponed` để sau |

Danh sách status story và task đã đối chiếu với template trên instance. Danh sách status epic và issue lấy từ
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

## 10. Lệnh được phép và tool MCP bị cấm

Lệnh `taigent` skill được dùng (allowlist của skill và wrapper headless): `validate`, `preview`, `plan`, `snapshot`
(chỉ đọc Taiga, chỉ ghi `snapshot.json`), `adopt` và `pull` (chỉ đọc Taiga, chỉ ghi file local), `tickets`, `status`,
`comment`, và các lệnh ghi `apply`, `bootstrap`, `upload` chỉ với `--yes` sau khi người dùng đồng ý (§1).

Các tool sau của `taiga-mcp-server@1.9.20` đang hỏng hoặc nguy hiểm. Agent **không được gọi** chúng; skill và wrapper
headless không đưa chúng vào allowlist.

| Tool | Lý do | Dùng thay |
|---|---|---|
| `linkStoryToEpic` | Gọi `PATCH /userstories/{id}` với `{epic}` thay vì `POST /epics/{id}/related_userstories`. Tool báo thành công nhưng liên kết **không được lưu**. | Khai báo story dưới epic trong `backlog.yaml`, rồi `taigent apply` |
| `batchCreateUserStories`, `batchCreateTasks`, `batchCreateIssues` | Gửi `projectId` thay cho `project`, `userStoryId` thay cho `user_story`, `points` dạng số thay cho dict, nên dễ bị Taiga trả 400. Item tạo ra cũng không có tag `src:<key>`, nên chạy lại sẽ tạo trùng. | `backlog.yaml` + `taigent apply` |
| `downloadAttachment` cho story/task | Luôn gọi `/issues/attachments/{id}`, nên với attachment của story/task sẽ lỗi hoặc tải nhầm attachment của issue khác. | Đọc link `url` của attachment từ `listAttachments` |
| `deleteAttachment` cho story/task | Luôn gọi `/issues/attachments/{id}`, nên có thể **xoá nhầm** attachment của một issue. Hơn nữa quy trình không xoá dữ liệu trên Taiga. | Xoá tay trên Taiga, sau khi người quyết định |
| `authenticate` | Nhận `username`/`password` làm tham số: mật khẩu agent truyền vào sẽ nằm trong transcript, và tool đổi tài khoản của cả server. Qua `taigent mcp`, server đã đăng nhập sẵn bằng login của người dùng và từ chối mọi thông tin đăng nhập khác. | Người dùng tự chạy `npx taigent login` trong terminal của mình |

Ngoài danh sách cấm, các tool MCP **ghi** khác (`createEpic`, `createUserStory`, `createTask`, `updateEpic`,
`createWikiPage`, `updateWikiPage`, `uploadAttachment`…) cũng không dùng cho backlog và tài liệu. Chúng không gắn
`src:<key>` và không chống trùng. Dùng `taigent apply`/`taigent upload`. MCP chỉ dùng để đọc (`list*`, `get*`,
`advancedSearch`, `getMilestoneStats`…) và comment.
