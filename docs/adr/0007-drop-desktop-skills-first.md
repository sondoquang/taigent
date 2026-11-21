# Bỏ Taigent Desktop; Taigent là CLI + skill + MCP, cài một lần cho mỗi người dùng

ADR 0003 làm Taigent Desktop thành nơi làm việc chính để bớt khó khi cài skill và MCP. Kết quả là một app Electron
khoảng 14k dòng phải bảo trì song song, trong khi người dùng vẫn làm việc trong Claude Code, Codex hoặc OMP. Chúng tôi
bỏ Desktop (tag `desktop-final` giữ commit cuối) và giải quyết chuyện cài đặt ngay trong CLI: publish `taigent` lên
npm, `npm i -g taigent` rồi `taigent setup` cài skill và MCP server `taiga` vào cấu hình **user** của từng client đã
có, đăng nhập nếu chưa, rồi kiểm tra. `taigent setup --project` thay `taigent init` cho repo muốn pin phiên bản
(như TaigaManage). Skill luôn gọi `npx taigent`, nên dùng bản pin của project nếu có, không thì bản global.

Những gì Desktop làm mà vẫn cần thì chuyển thành skill: review của BA/PO là skill user-only gọi `taigent review …`
(ghi verdict đúng digest, chỉ khi người duyệt nói rõ); dashboard là skill `taiga-dashboard` đọc `taigent metrics
--json` theo Role.

## Considered Options

- Giữ Desktop, chỉ sửa onboarding: vẫn phải bảo trì hai giao diện cho cùng một quy trình.
- Tách Desktop sang repo riêng: vẫn tốn công giữ hai bên khớp với CLI mà không ai cần.
- Chỉ per-project như cũ: mỗi repo phải có `package.json`/`node_modules`, và người chỉ xem ticket của mình cũng phải cài
  vào một repo.
- Không cài global, dùng `npx -y taigent@…` cho cả MCP: agent khởi động MCP chậm và phụ thuộc mạng/cache.

## Consequences

- Code chỉ Desktop dùng bị xóa: `src/edit.ts`, `src/project-settings.ts`, `suggestKey`/`issueKeyPrefix`/`checkKeyLocked`,
  `TAIGENT_READ_ONLY`.
- Agent không tự duyệt việc của mình: `review approve|request-changes` không nằm trong allowlist headless, và
  `taiga-plan-backlog` chỉ được đánh dấu comment là resolved.
- Khi một máy có cả bản user và bản project trùng tên, `taigent setup` và `taiga-setup` báo bản nào thắng ở từng client,
  không tự gỡ gì.
