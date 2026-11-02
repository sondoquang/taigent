# Nghiên cứu: Đăng nhập Taiga một lần ở bước setup, không để lộ mật khẩu

- Ngày khảo sát: 2026-11-02.
- Câu hỏi: MCP server lấy thông tin đăng nhập từ biến môi trường của tiến trình agent (Claude Code, Codex), không đọc `.env`. Vậy làm sao để người dùng **đăng nhập một lần ở bước setup** mà mật khẩu không nằm trong file văn bản thường (`.env`, `.mcp.json`, `~/.claude.json`, `.codex/config.toml`) và agent/LLM không bao giờ được hỏi hay nhìn thấy mật khẩu?
- Ưu tiên: Windows trước (môi trường hiện tại), sau đó macOS/Linux. Claude Code là chính, Codex là phụ. MCP server đang ghim `taiga-mcp-server@1.9.20`.
- Quy ước: `[n]` là link tới nguồn ở mục **Nguồn**. `[INFERENCE]` = suy luận từ nguồn, chưa chạy thử. `[UNVERIFIED]` = chưa kiểm chứng được. Mục 5 là **khuyến nghị**, không phải sự thật có nguồn.
- Không đăng nhập vào Taiga thật nào trong lúc nghiên cứu. Ngoài việc đọc mã nguồn, chỉ có hai lệnh `GET` ẩn danh tới `api.taiga.io/api/v1/` và các thí nghiệm cục bộ ở mục 6.

---

## TL;DR

- **Mọi cách có sẵn trên Windows đều để mật khẩu ở dạng văn bản thường.**
  - `claude mcp add -e` ghi vào `~/.claude.json`.
  - `env` của `settings.json` ghi vào file settings, và Bash tool của agent cũng đọc được.
  - Biến môi trường người dùng được Windows ghi vào Registry, không mã hoá.
  - `env` trong `config.toml` của Codex là văn bản thường.
  - Keychain chỉ được dùng ở macOS (cho OAuth và plugin `sensitive`), và chỉ áp dụng cho server HTTP.

  Nguồn: [1] [2] [3] [4] [5].
- **Cách duy nhất giữ mật khẩu ngoài file là một launcher.** `command` của server stdio có thể là chương trình bất kỳ [6]. Launcher đọc thông tin đăng nhập từ kho bí mật của hệ điều hành (Windows Credential Manager, macOS Keychain, Linux Secret Service), gán vào biến môi trường của chính nó, rồi khởi động MCP server. Đã chạy thử trên máy này (mục 6).
- **`taiga-mcp-server@1.9.20` bắt buộc có mật khẩu thật trong biến môi trường.**
  - Không có biến token nào; header luôn là `Bearer`.
  - Refresh token bị bỏ đi; server tự đăng nhập lại bằng mật khẩu mỗi 24 giờ.
  - Các tool attachment, comment, epic và wiki từ chối chạy nếu thiếu `TAIGA_PASSWORD`.

  Nguồn: [7] [8].
- **Taiga không có personal access token.** Chỉ có ba loại [9]:
  - JWT access token: sống 24 giờ.
  - Refresh token: sống 8 ngày, **dùng một lần** (mỗi lần refresh sinh token mới, token cũ bị vô hiệu).
  - Application token: không hết hạn, nhưng cần admin server tạo bản ghi `Application` trong Django admin.

  Đổi mật khẩu **không thu hồi** token nào [10].
- **Tool MCP `authenticate` nhận `password` làm tham số.** Mật khẩu LLM truyền vào sẽ nằm trong transcript, và tool có thể chuyển cả server sang tài khoản khác. Tool này chưa bị cấm trong `docs/taiga/conventions.md` §10, mới chỉ bị loại khỏi allowlist headless [11].
- **Khuyến nghị (mục 5):**
  - Giai đoạn 1: thêm `taigent login`, chạy trong terminal của người dùng, nhập mật khẩu ẩn, lưu vào kho bí mật của hệ điều hành. Thêm `taigent mcp` (launcher) làm `command` trong `.mcp.json` và `.codex/config.toml`. Cấm `authenticate`.
  - Giai đoạn 2 (tuỳ chọn): đặt một proxy cục bộ trước 1.9.20 để chỉ cần lưu token, không lưu mật khẩu.

---

## 1. Hiện trạng: thông tin đăng nhập đi tới MCP server bằng cách nào

### 1a. Claude Code

| Cách | Có thành văn bản thường trên đĩa? | Dùng được cho stdio? | Nguồn |
|---|---|---|---|
| `claude mcp add -s user/local -e K=V` | **Có**, trong `~/.claude.json` | Có | [1] |
| `claude mcp add -s project -e K=V` | **Có**, trong `.mcp.json` (file được commit) | Có | [1] |
| `${VAR}` trong `.mcp.json` | File chỉ chứa tên biến; giá trị phải có sẵn trong biến môi trường của Claude Code. Trên Windows giá trị đó nằm trong Registry | Có. Nếu biến chưa đặt, Claude Code truyền nguyên chuỗi `${VAR}` | [12] [3] |
| `env` trong `settings.json` | **Có**. Bash tool của agent cũng thấy, nên LLM `echo` ra được | Có | [2] |
| `headersHelper` | Không | **Không**, chỉ cho `http`/`sse`/`ws` | [13] |
| OAuth (`/mcp`, `claude mcp login`) | macOS: Keychain. Windows/Linux: `~/.claude/.credentials.json` | **Không**, chỉ cho HTTP/SSE | [4] |
| Plugin `userConfig` có `"sensitive": true` | macOS: Keychain. Windows/Linux: `~/.claude/.credentials.json` | Có | [14] |
| **Launcher** (`command` là chương trình của mình) | **Không** | Có | [6] |

### 1b. Codex

| Cách | Có thành văn bản thường trên đĩa? | Dùng được cho stdio? | Nguồn |
|---|---|---|---|
| `env = {…}` / `codex mcp add --env` | **Có**, trong `config.toml` | Có | [5] |
| `env_vars = [...]` | File chỉ chứa tên biến. Server stdio **không** kế thừa biến môi trường, chỉ nhận một tập mặc định cộng với các biến được liệt kê | Có | [5] [15] |
| ↳ rò sang shell của agent | `*PASSWORD*` không nằm trong danh sách loại trừ mặc định, nên lệnh shell của agent cũng thấy biến này | — | [16] |
| `bearer_token_env_var`, `http_headers_helper`, `codex mcp login` | OAuth lưu vào keyring hệ điều hành (mặc định `auto`) | **Không**, chỉ cho Streamable HTTP | [5] [17] |
| **Launcher** | **Không** | Có | [18] |

`.codex/config.toml` của project chỉ được nạp khi project đã được trust [5].

### 1c. `taiga-mcp-server@1.9.20`

| Điểm | Thực tế | Nguồn |
|---|---|---|
| Nguồn thông tin đăng nhập | Chỉ có `TAIGA_USERNAME` + `TAIGA_PASSWORD`. Đọc thêm `.env` ở cwd và `.env` cạnh package; không ghi đè biến đã có | [7] |
| Token | Giữ trong bộ nhớ, tự đoán hạn 24 giờ, bỏ refresh token, header luôn `Bearer` | [7] |
| Lỗi 401 | Không xử lý, nên token hỏng thì server hỏng tới khi khởi động lại (PR #8 upstream chưa merge) | [19] |
| `isAuthenticated()` | Trả `true` chỉ khi có `TAIGA_PASSWORD` trong biến môi trường; tool attachment/comment/epic/wiki phụ thuộc vào nó | [8] |
| Tool `authenticate` | Nhận `{username?, password?}` do LLM truyền; giá trị truyền vào thắng biến môi trường | [11] |
| Bản mới hơn | Không có. `latest` = 1.9.20 = head của nhánh mặc định | [20] |

**Kết luận:** muốn dùng 1.9.20 mà không sửa mã thì tiến trình server **phải** có mật khẩu thật, trừ khi có proxy đứng giữa (mục 4, phương án F).

---

## 2. Taiga cho phép xác thực theo những cách nào

Nguồn: `taiga-back` tag `6.9.0`.

| Cơ chế | Cách lấy | Thời hạn | Thu hồi | Lúc chạy có cần mật khẩu? | Nguồn |
|---|---|---|---|---|---|
| JWT access token (`Bearer`) | `POST /api/v1/auth` `{type:"normal", username, password}` | 24 giờ | Không thu hồi được phía server; hết hạn tự nhiên | Chỉ cần để lấy cặp token đầu tiên | [9] [21] |
| Refresh token | Trả kèm `auth_token`. Đổi qua `POST /api/v1/auth/refresh {refresh}` | 8 ngày, **xoay vòng mỗi lần dùng** (token cũ bị denylist). Refresh ít nhất 8 ngày một lần thì phiên sống mãi | Chỉ admin denylist được. Đổi mật khẩu hay đăng xuất **không** thu hồi | Không | [9] [22] |
| Application token (`Authorization: Application <t>`) | Cần bản ghi `Application` do admin tạo trong Django admin (không có API tạo). Sau đó có JWT thì gọi `authorize` → `validate` | **Không hết hạn**, quyền giống hệt người dùng | Người dùng tự xoá được: `DELETE /application-tokens/{id}` | Không | [23] |
| Personal access token / API key | **Không tồn tại** | — | — | — | [24] |

Một số hệ quả cho thiết kế:
- **Tranh chấp refresh token:** nếu CLI `taigent` và MCP server dùng chung một refresh token, tiến trình nào refresh sau sẽ bị từ chối ("Token is denylisted"). Hai lần đăng nhập riêng thì có hai chuỗi refresh độc lập [22] `[INFERENCE]`.
- **Người dùng đăng nhập qua GitHub/GitLab/OIDC/LDAP** không đăng nhập được bằng `type:"normal"`. Họ chỉ có JWT qua luồng SSO trên trình duyệt (hoặc `type:"ldap"`) [25]. Cả `taigent` lẫn 1.9.20 hiện chỉ gửi `type:"normal"`.
- **Taiga SaaS** có route `application-tokens` [26]. Có `Application` nào dùng được cho bên thứ ba hay không thì `[UNVERIFIED]`.
- Thời hạn 24 giờ / 8 ngày là mặc định trong mã. Taiga SaaS có giữ nguyên hay không thì `[UNVERIFIED]`: muốn biết phải decode `exp` của một token thật.

---

## 3. Kho bí mật của hệ điều hành dùng được từ Node.js

| Lựa chọn | Tình trạng | Bản dựng sẵn cho win-x64 | Ghi chú | Nguồn |
|---|---|---|---|---|
| **`@napi-rs/keyring` 2.1.2** | Đang được phát triển (bản phát hành 2026-10-19), MIT, không có dependency JS | **Có**, khoảng 2 MB, không cần biên dịch | Windows: Credential Manager. macOS: Keychain. Linux: Secret Service, nhưng **nếu thiếu thì lặng lẽ chuyển sang keyutils trong RAM** (mất khi khởi động lại), nên phải ghim `{ linux: { store: 'secret-service' } }` | [27] |
| `keytar` 7.9.0 | **Đã archive** (2022) | Tải bản dựng sẵn lúc cài; nếu lỗi thì phải có node-gyp | Không nên dùng | [28] |
| `cross-keychain` 1.1.0 | Một maintainer, 17 sao | Dùng `@napi-rs/keyring` 1.x cũ | Backend "file" để khoá ngay cạnh dữ liệu, chỉ là che mắt | [29] |
| PowerShell DPAPI / `security` / `secret-tool` | Có sẵn trong hệ điều hành | — | Mỗi hệ điều hành một cách; DPAPI chỉ mã hoá thật trên Windows. Hợp làm phương án dự phòng thủ công | [30] [31] [32] |

**Nhập mật khẩu ẩn:** `@inquirer/password` che ký tự nhập, nhưng **vẫn nhận stdin được pipe vào**. Trong thí nghiệm, `printf 'hunter2\n' | node t.mjs` trả về đúng giá trị đó. Vậy agent có thể pipe mật khẩu qua Bash tool. `taigent login` phải từ chối chạy nếu `process.stdin.isTTY` hoặc `process.stdout.isTTY` sai, và không nhận mật khẩu qua argv, biến môi trường hay pipe [33] [34]. Chế độ `!` của Claude Code đưa output vào hội thoại, nên người dùng phải chạy lệnh trong một cửa sổ terminal riêng [35].

---

## 4. So sánh phương án

| # | Phương án | Mật khẩu nằm ở đâu | Agent có thể thấy? | Người dùng phải làm | Sửa mã | Ghi chú |
|---|---|---|---|---|---|---|
| A | Hiện tại: `.mcp.json` dùng `${VAR}` + biến môi trường cá nhân | Registry (Windows), không mã hoá | Có (Bash tool kế thừa biến môi trường) | Đặt 3 biến, khởi động lại, duyệt server | Không | `.env` không có tác dụng với MCP |
| B | `claude mcp add -s user -e …` | `~/.claude.json`, văn bản thường | Có (đọc được file) | Chạy một lệnh | Không | Mật khẩu lọt vào lịch sử shell |
| C | `.mcp.json` bỏ khối `env` + `.env` (server tự đọc `.env` ở cwd) | `.env` trong project, văn bản thường | Có | Điền `.env`, duyệt server | Không | Dựa vào hành vi không có trong tài liệu của 1.9.20 |
| **D** | **`taigent login` + launcher, lưu mật khẩu vào kho bí mật của hệ điều hành** | **Credential Manager / Keychain / Secret Service** | Không qua kênh thông thường; xem giới hạn ở mục 5c | Chạy `npx taigent login` một lần, duyệt server | CLI: thêm `login`, `logout`, `mcp` | Giữ 1.9.20 nguyên vẹn. Đã chạy thử (mục 6) |
| E | D, nhưng launcher chạy qua `op run` / `bws run` / `doppler run` | Két của bên thứ ba | Như D | Cần tài khoản và CLI riêng | Như D | Hợp với team đã dùng sẵn các công cụ này [36] |
| F | D + **proxy cục bộ**, chỉ lưu refresh token (hoặc application token) | **Không lưu mật khẩu** | Không | Như D | Launcher + proxy HTTP trên loopback | 1.9.20 nhận user/pass giả; proxy trả lời `/auth` và thay header bằng token thật. Chưa dựng thử. Tránh luôn cả lỗi 401 |
| G | Đổi sang `taiga-api-mcp-server` 0.5.0 (hỗ trợ application token và refresh token) | Token cache trong `~/.taiga-mcp/tokens.json` (quyền 0600) | Không có tool login | Tuỳ | Viết lại allowlist và §10 | Mới 1 tuần tuổi, 0 sao, tên tool khác hẳn [37] |

**Đánh đổi giữa D và F:**
- D lưu mật khẩu (đã mã hoá bởi hệ điều hành). Bị lộ thì đổi mật khẩu, nhưng các token đã phát ra vẫn sống (mục 2).
- F chỉ lưu refresh token, nên mật khẩu (có thể dùng chung ở nơi khác) không bao giờ nằm trên đĩa. Đổi lại, refresh token bị lộ thì **người dùng không tự thu hồi được**, chỉ admin làm được. Application token thì người dùng tự xoá được, nhưng cần admin tạo `Application` trước.

---

## 5. Khuyến nghị

> **Cập nhật 2026-11-02:** quyết định cuối cùng nằm ở **5d** (phương án F, hai chế độ). 5a và 5b được giữ lại làm bối cảnh. Phần cấu hình agent (5a mục 3), cấm `authenticate` (5a mục 5) và cập nhật `taiga-setup` (5a mục 6) vẫn áp dụng.

### 5a. Giai đoạn 1: phương án D

1. **`npx taigent login`**, người dùng tự chạy trong terminal riêng:
   - Từ chối nếu không có TTY.
   - Hỏi `TAIGA_API_URL` và username. Hỏi mật khẩu với input ẩn.
   - Kiểm tra bằng `POST /auth`. Sai thì báo lỗi và không lưu gì.
   - Lưu bằng `@napi-rs/keyring`: `Entry('taigent', '<apiUrl>|<username>')`. URL và username có thể nằm trong một file cấu hình không bí mật, ví dụ `~/.config/taigent/config.json` `[INFERENCE]`.
   - Có thêm `taigent logout` (xoá entry) và `taigent login --status` (chỉ báo đã lưu hay chưa, không in giá trị).
2. **`taigent mcp`** (launcher):
   - Đọc kho bí mật và gán `TAIGA_*` vào `process.env` của chính nó.
   - Rồi `await import('taiga-mcp-server/src/index.js')`. Phải là import **động** để biến môi trường được gán trước khi server chạy; server tự khởi động ở top-level [6] [38].
   - Chỉ ghi log ra **stderr**, không bao giờ in giá trị bí mật (stdout là kênh JSON-RPC của MCP).
   - Không có thông tin đăng nhập thì thoát với mã khác 0 và thông báo "chạy `npx taigent login` trong terminal của bạn".
3. **Cấu hình agent**: không còn khối `env` hay `env_vars`, file nào cũng commit được:

   ```json
   {
     "mcpServers": {
       "taiga": { "command": "node", "args": ["node_modules/taigent/bin/taigent.js", "mcp"] }
     }
   }
   ```

   ```toml
   [mcp_servers.taiga]
   command = "node"
   args = ["node_modules/taigent/bin/taigent.js", "mcp"]
   ```

   - Gọi `node` trực tiếp, không qua `npx`: tránh vấn đề `npx.cmd` trên Windows và không tải package lúc khởi động [39].
   - Codex chỉ cho server 10 giây để khởi động [40]. Vì thế `taiga-mcp-server@1.9.20` nên là dependency ghim cứng của `taigent`, không tải qua `npx -y`.
   - Đường dẫn tương đối dựa trên cwd. Claude Code đặt cwd của server `.mcp.json` là thư mục project (đã kiểm tra trong phiên trước). Codex có trường `cwd` tuỳ chọn [5]. Nếu cần đường dẫn chắc chắn, Claude Code hỗ trợ `${CLAUDE_PROJECT_DIR:-.}` trong `args` [12].
   - `bin/taigent.js` là `bin` hiện tại của package (`package.json`). Trong chính repo taigent thì đường dẫn là `bin/taigent.js`.
4. **CLI `taigent`** cũng đọc kho bí mật. Thứ tự ưu tiên đề xuất: biến môi trường > kho bí mật > `.env`. Biến môi trường vẫn cần cho CI và headless trên máy không có Secret Service `[INFERENCE]`.
5. **Cấm `authenticate`**: thêm vào bảng tool cấm ở `docs/taiga/conventions.md` §10, và thêm rule `permissions.deny: ["mcp__taiga__authenticate"]` cho Claude Code [11].
6. **Skill `taiga-setup`**: check 1 đổi thành "đã `taigent login` chưa" (`taigent login --status`); check 3 không còn hướng dẫn `claude mcp add -e`. Theo AGENTS.md, khi sửa skill phải cập nhật `ask-taigent` và chạy `npx taigent skills sync`.

### 5b. Giai đoạn 2 (tuỳ chọn): phương án F

- Proxy trên `127.0.0.1:<cổng ngẫu nhiên>` đứng giữa 1.9.20 và Taiga, khởi động trong cùng tiến trình launcher.
- Kho bí mật chỉ giữ refresh token (hoặc application token nếu instance có `Application`). Proxy lưu lại refresh token mới **sau mỗi lần refresh**.
- CLI và MCP dùng **hai lần đăng nhập riêng** (hai entry) để tránh tranh chấp refresh token [22] `[INFERENCE]`.
- Lợi ích phụ: proxy tự refresh khi gặp 401, nên vá luôn lỗi của 1.9.20 [19].
- Bất lợi: refresh token sống 8 ngày. Không dùng tới 8 ngày thì phải `taigent login` lại.

### 5c. Giới hạn cần ghi rõ trong tài liệu cho người dùng

- Kho bí mật của hệ điều hành chỉ giúp mật khẩu **không nằm trong file**. Nó **không** chặn được agent: Bash tool chạy dưới cùng tài khoản người dùng nên có thể gọi `CredRead` (Windows) hoặc đọc `/proc/<pid>/environ` (Linux) [41] [42].
- ACL của macOS Keychain gắn theo ứng dụng, mà cả `taigent login` lẫn agent đều chạy bằng `node`, nên ACL không ngăn được `[INFERENCE]`.
- Biện pháp bổ sung là deny rule và sandbox của agent. Phương án F giảm thiệt hại hơn D vì thứ bị đọc được chỉ là token.

### 5d. Hướng đã chọn (2026-11-02): phương án F, hai chế độ, không cần admin

> **Đã triển khai (2026-11-02):** `taigent login` / `logout` / `whoami` / `mcp` (`src/login.ts`, `src/mcp.ts`). Đặc tả hành vi nằm ở `docs/cli.md` §Login and the MCP server. Phần dưới đây là bản thiết kế ban đầu.

Taigent sẽ được dùng ở nhiều nơi khác nhau, và người dùng ở đó thường không có quyền admin để tạo `Application`. Vì vậy chế độ mặc định **không được phụ thuộc vào admin**. Ở cả hai chế độ, mật khẩu chỉ được gõ lúc `taigent login` và không được lưu ở đâu.

| Chế độ | Khi nào dùng | Kho bí mật giữ gì | Hết hạn | Thu hồi |
|---|---|---|---|---|
| **Refresh token** (mặc định) | Mọi instance có đăng nhập email/mật khẩu, kể cả taiga.io | Access token và refresh token | Không dùng quá 8 ngày (theo mặc định của Taiga) thì phải `taigent login` lại | Người dùng không tự thu hồi được; chỉ admin denylist được [22] |
| **Application token** (tuỳ chọn) | Admin của instance đã tạo `Application` và cấp Id, ví dụ `taigent login --application <id>` | Application token | Không hết hạn | Người dùng tự thu hồi bằng `taigent logout` |

**Chế độ refresh token và việc xoay vòng token** (mục 2):
- Một refresh token chỉ dùng được một lần. Trong khi đó nhiều tiến trình có thể dùng chung một entry: CLI, một hoặc nhiều launcher MCP của Claude Code và Codex.
- Cách xử lý đề xuất `[INFERENCE]`:
  1. Mỗi tiến trình đọc access token mới nhất từ kho bí mật trước khi gửi request.
  2. Khi gặp 401: lấy lock (một lockfile cạnh file cấu hình) rồi **đọc lại** kho bí mật. Nếu tiến trình khác đã refresh rồi thì dùng token mới đó. Nếu chưa thì tự gọi `POST /auth/refresh` và ghi cặp token mới vào kho trước khi nhả lock.
  3. Refresh thất bại (token hết hạn hoặc đã bị denylist) thì báo "chạy `taigent login` trong terminal của bạn".

**Chế độ application token** (dành cho tổ chức có admin, ví dụ `taiga.vidratek.net`):

**Admin làm một lần:**
1. Đăng nhập `https://taiga.vidratek.net/admin/` và vào mục *Applications* (app `external_apps`) → *Add*.
2. Điền `Name` (ví dụ `Taigent`) và `Next url`. Trường `Next url` bắt buộc nhưng luồng CLI không dùng tới, nên điền gì cũng được, ví dụ `https://taiga.vidratek.net/`.
3. Lưu, rồi copy `Id` (UUID, chỉ đọc) gửi cho team.

Id này **không phải bí mật**: muốn đổi nó lấy token thì vẫn phải có JWT của một người dùng đã đăng nhập. Nguồn: model `Application` và `ApplicationAdmin` [23].

**`taigent login` làm cho mỗi người dùng:**
1. Đăng nhập bằng mật khẩu nhập ẩn (`POST /auth`) để lấy JWT.
2. Gọi `POST /application-tokens/authorize {application, state}` để lấy `auth_code`.
3. Gọi `POST /application-tokens/validate {application, auth_code, state}` để lấy `token`.
4. Lưu `token` vào kho bí mật của hệ điều hành. Bỏ JWT và mật khẩu.

Nguồn: [23] và `taiga/external_apps/api.py`.

**Cách token được dùng và thu hồi:**
- Mọi request gửi header `Authorization: Application <token>`. CLI `taigent` gửi trực tiếp. Với MCP 1.9.20 thì proxy của launcher thay header.
- Mỗi cặp (người dùng, Application) chỉ có **một** token, và `generate_token()` trả lại token cũ nếu đã có. Vì vậy `taigent logout` phải gọi `DELETE /application-tokens/{id}` để thu hồi; lần login sau mới nhận token mới.
- Khi một người nghỉ việc, admin xoá các *Application tokens* của họ trong Django admin. Bước này cần làm vì backend application token không kiểm tra `is_active` [23].

---

## 6. Thí nghiệm cục bộ (2026-11-02, Windows, Node 24)

| Thí nghiệm | Kết quả |
|---|---|
| 1.9.20 chạy với cwd có `.env`, không có biến môi trường | Server dùng giá trị trong `.env` (`connect ECONNREFUSED 127.0.0.1:9`, đúng địa chỉ giả) |
| 1.9.20 nhận `TAIGA_API_URL="${TAIGA_API_URL}"` nguyên văn (cách Claude Code xử lý biến chưa đặt) | `Authentication failed: Invalid URL`; `.env` bị bỏ qua |
| Claude Code (`-s local`) khởi động server stdio | cwd của server = thư mục project |
| **Launcher**: `@napi-rs/keyring` 2.1.2 ghi một entry giả vào Windows Credential Manager → launcher đọc ra, gán `TAIGA_*`, rồi `import('taiga-mcp-server/src/index.js')` | Server trả lời `initialize`, đăng nhập bằng thông tin lấy từ kho bí mật (`ECONNREFUSED 127.0.0.1:9`). **0,41 giây**. Giá trị bí mật không xuất hiện trên stdout hay stderr. Đã xoá entry và thư mục tạm |
| `@inquirer/password` với stdin bị pipe | Nhận giá trị pipe vào, nên cần kiểm tra TTY |

---

## 7. Câu hỏi còn mở

1. Taiga SaaS và instance `taiga.vidratek.net` có giữ thời hạn 24 giờ / 8 ngày không? Cần decode `exp` của một token thật `[UNVERIFIED]`.
2. Instance của team có tạo được `Application` không? Đã kiểm tra ẩn danh ngày 2026-11-02:
   - `GET https://taiga.vidratek.net/api/v1/` có liệt kê route `applications` và `application-tokens`.
   - `https://taiga.vidratek.net/admin/` (Django admin) trả 302 về trang đăng nhập admin.

   Tính năng có bật. Còn lại phải hỏi: team có ai giữ tài khoản superuser/staff để tạo `Application` không? Nếu có, application token là lựa chọn tốt nhất cho phương án F.
3. ~~Có người dùng SSO/LDAP không?~~ Đã có câu trả lời: `https://taiga.vidratek.net/conf.json` có `"defaultLoginEnabled": true` và `"contribPlugins": []`. Trang đăng nhập chỉ có form email/mật khẩu, không có nút GitHub/GitLab/OIDC. Vậy `type:"normal"` là đủ. Việc phía server cũng không có plugin LDAP chỉ là `[INFERENCE]`, suy ra từ việc không có plugin front-end nào.
4. Bash tool của Claude Code có TTY không? Tài liệu không nói; kiểm tra TTY trong `taigent login` vẫn cần dù kết quả thế nào `[UNVERIFIED]`.
5. Trên Linux không có D-Bus (WSL, server headless) thì không có Secret Service, nên phải quay về biến môi trường. Có cần hỗ trợ không?

---

## Nguồn

[1]: https://code.claude.com/docs/en/mcp#mcp-installation-scopes
[2]: https://code.claude.com/docs/en/settings-reference#env
[3]: https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_environment_variables
[4]: https://code.claude.com/docs/en/mcp#authenticate-with-remote-mcp-servers
[5]: https://learn.chatgpt.com/docs/extend/mcp
[6]: https://code.claude.com/docs/en/mcp#option-3-add-a-local-stdio-server
[7]: https://github.com/greddy7574/taigaMcpServer/blob/77fc95e97042c5f5daa9d3469c1220d7044ea58d/src/taigaAuth.js#L1-L71
[8]: https://github.com/greddy7574/taigaMcpServer/blob/77fc95e97042c5f5daa9d3469c1220d7044ea58d/src/taigaService.js#L13-L22
[9]: https://github.com/kaleidos-ventures/taiga-back/blob/675f652ed9be0b1485ab9983d70455f638dba036/taiga/auth/services.py#L53-L104
[10]: https://github.com/kaleidos-ventures/taiga-back/blob/675f652ed9be0b1485ab9983d70455f638dba036/taiga/users/api.py#L175-L222
[11]: https://github.com/greddy7574/taigaMcpServer/blob/77fc95e97042c5f5daa9d3469c1220d7044ea58d/src/tools/authTools.js#L19-L35 ; `docs/taiga/conventions.md` §10 ; `docs/headless.md:81-82`
[12]: https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcp-json
[13]: https://code.claude.com/docs/en/mcp#use-dynamic-headers-for-custom-authentication
[14]: https://code.claude.com/docs/en/plugins/manifest-reference#user-configuration
[15]: https://github.com/openai/codex/blob/a09812981de703f18f38015cd5d500ab373f616c/codex-rs/rmcp-client/src/utils.rs#L16-L181
[16]: https://github.com/openai/codex/blob/a09812981de703f18f38015cd5d500ab373f616c/codex-rs/protocol/src/shell_environment.rs#L139-L146
[17]: https://github.com/openai/codex/blob/a09812981de703f18f38015cd5d500ab373f616c/codex-rs/rmcp-client/src/oauth.rs#L1-L17
[18]: https://github.com/openai/codex/blob/a09812981de703f18f38015cd5d500ab373f616c/codex-rs/rmcp-client/src/program_resolver.rs#L31-L60
[19]: https://github.com/greddy7574/taigaMcpServer/pull/8
[20]: https://registry.npmjs.org/taiga-mcp-server
[21]: https://github.com/kaleidos-ventures/taiga-back/blob/675f652ed9be0b1485ab9983d70455f638dba036/settings/common.py#L451-L457
[22]: https://github.com/kaleidos-ventures/taiga-back/blob/675f652ed9be0b1485ab9983d70455f638dba036/taiga/auth/tokens.py#L204-L264
[23]: https://github.com/kaleidos-ventures/taiga-back/blob/675f652ed9be0b1485ab9983d70455f638dba036/taiga/external_apps/models.py#L20-L85
[24]: https://github.com/kaleidos-ventures/taiga-back/blob/675f652ed9be0b1485ab9983d70455f638dba036/settings/common.py#L472-L482
[25]: https://github.com/kaleidos-ventures/taiga-back/blob/675f652ed9be0b1485ab9983d70455f638dba036/taiga/auth/api.py#L67-L86
[26]: https://api.taiga.io/api/v1/
[27]: https://registry.npmjs.org/@napi-rs/keyring
[28]: https://github.com/atom/node-keytar
[29]: https://github.com/magarcia/cross-keychain/blob/26f3d4fcf9165786941011109e17fd7f732dced1/README.md
[30]: https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/convertfrom-securestring
[31]: https://github.com/apple-oss-distributions/Security/blob/main/SecurityTool/macOS/security.1
[32]: https://gitlab.gnome.org/GNOME/libsecret/-/blob/0ee86df896582231417b13faaa5a160aec4a1db1/tool/secret-tool.c
[33]: https://registry.npmjs.org/@inquirer/password
[34]: https://nodejs.org/api/tty.html#readstreamistty
[35]: https://code.claude.com/docs/en/interactive-mode#shell-mode-with-prefix
[36]: https://developer.1password.com/docs/cli/reference/commands/run/
[37]: https://github.com/xHisusx/taiga-api-client/tree/8546124f1e468de9c9f0826b151146f0e62ed49d/mcp
[38]: https://github.com/greddy7574/taigaMcpServer/blob/77fc95e97042c5f5daa9d3469c1220d7044ea58d/src/index.js#L119-L130
[39]: https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows
[40]: https://learn.chatgpt.com/docs/config-file/config-reference
[41]: https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw
[42]: https://man7.org/linux/man-pages/man5/proc_pid_environ.5.html
