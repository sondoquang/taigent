# Release là tag `release:<version>` gắn trên Taiga; ngày đích khai báo trong project manifest

Dashboard của PO cần release burndown, nhưng Taiga không có khái niệm release. Vì vậy một release là tag
`release:<version>` (kebab-case, ví dụ `release:v1-2-0`) mà người dùng **gắn tay trên Taiga**, giống cách gán sprint.
Backlog manifest không khai báo tag này. Project manifest chỉ khai báo danh sách releases (version, ngày đích) để
dashboard vẽ đường lý tưởng.

Release là thông tin planning duy nhất không đi qua backlog manifest. Lý do là `apply` gộp tag: nó giữ mọi tag đang có
trên Taiga rồi thêm tag còn thiếu (`src/planner.ts`). Nếu release nằm trong manifest thì story chuyển release sẽ mang
cả tag cũ lẫn tag mới.

## Considered Options

- Khai báo release trong backlog manifest, và cho `apply` thay hẳn các tag `release:*`: release được đi qua review.
  Nhưng apply phải có ngoại lệ trong quy tắc gộp tag, và sẽ ghi đè tag mà người khác gắn tay trên Taiga.
- Khai báo trong backlog manifest, giữ quy tắc gộp tag: không phải sửa apply, nhưng story chuyển release sẽ thuộc hai
  release cho tới khi có người gỡ tay tag cũ.
- Release là một nhóm sprint hoặc một epic: không cần thêm tag. Nhưng story bị đẩy sang sprint khác sẽ làm sai
  burndown, còn dùng epic thì mất ý nghĩa nhóm tính năng của epic.

## Consequences

- `release:` là tiền tố tag mà manifest không được dùng. `taigent validate` chỉ kiểm tra danh sách releases trong
  project manifest.
- Dashboard không đoán khi dữ liệu lệch nhau, mà hiện cảnh báo:
  - tag release chưa khai báo trong project manifest: vẫn vẽ, nhưng không có đường lý tưởng;
  - release đã khai báo nhưng chưa có story nào: hiện rỗng;
  - story mang từ hai tag release trở lên: loại khỏi burndown và liệt kê ra.
