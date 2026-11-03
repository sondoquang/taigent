# Taigent Desktop là nơi làm việc chính; mọi thao tác ghi lên Taiga vẫn chỉ qua CLI

Muốn dùng taigent, người dùng phải cài skill rồi mở Claude Code hoặc Codex. Taigent Desktop vì vậy mở rộng ADR 0002 từ
màn hình review thành nơi làm việc chính cho cả BA/PO lẫn dev:

- tạo hoặc clone repo, rồi cài taigent, skill và cấu hình MCP từ bản taigent đóng gói trong app;
- soạn epic, story, task, issue và wiki page bằng form;
- mở terminal nhúng (`claude`, `codex`, `omp`) và có nút chạy skill headless qua `run-skill`;
- có các màn hình Taiga và một panel git tối thiểu.

App không có lối ghi thứ hai lên Taiga. Form chỉ sửa manifest trong repo (`backlog.yaml`, `docs.yaml`). Dữ liệu Taiga
được đọc qua lõi taigent. Mọi thao tác ghi đi qua CLI `taigent` (`apply`, `upload`, `status`, `bootstrap`) sau một
bước xác nhận. MCP Taiga chỉ phục vụ agent trong terminal. Nhờ vậy quy trình plan → review → apply, tag `src:<key>`
(chạy lại không tạo trùng) và luật `--yes` vẫn chỉ có một chỗ, và app tránh được các tool ghi đang hỏng của
`taiga-mcp-server` (conventions §10).

## Considered Options

- Ghi thẳng lên Taiga từ form, qua API hoặc qua tool ghi của MCP: nhanh hơn, nhưng bỏ qua review, có nguy cơ tạo trùng
  hoặc lệch so với manifest, và phụ thuộc vào các tool MCP đang báo thành công giả.
- App tự gọi API LLM thay cho CLI agent: app sẽ phải viết lại skill, allowlist và cách quản lý API key bên trong.
- Workspace riêng của app, không dùng git: dễ cho BA/PO, nhưng team mất lịch sử và mất cách chia sẻ manifest cùng
  `review.yaml`.

## Consequences

- Issue trở thành một backlog item: nằm ở `issues[]` trong `backlog.yaml`, đi qua review → apply như story. Giá trị
  type, severity và priority phải trùng tên với giá trị của project trên Taiga.
- Item tạo bằng form vẫn ở trạng thái *Chưa duyệt*. Form không bao giờ tự đặt verdict.
- Form và agent cùng sửa một manifest. Vì thế form lưu có kiểm tra: nếu file đã đổi từ lúc mở form thì từ chối lưu,
  không ghi đè.
- Terminal không phải ranh giới bảo mật. Chỉ có CLI và bước xác nhận ngăn việc ghi lên Taiga.
