# Review backlog trong Taigent Desktop, qua file `review.yaml`

Business Analyst / Product Owner cần xem và góp ý backlog mà agent viết trước khi `apply`, nhưng manifest YAML và
`git diff` khó đọc với họ. Chúng tôi làm **Taigent Desktop**, một app Electron chạy trên máy của BA/PO (đã có repo),
dùng chung core `src/review.ts` với CLI (`taigent preview` in cùng nội dung dạng Markdown). Verdict và comment nằm
trong `taiga/<slug>/review.yaml`, commit cùng manifest: agent đọc file đó để sửa manifest và trả lời, không cần
server hay tài khoản nào khác. App **không bao giờ** gọi Taiga API trực tiếp: mọi thao tác với Taiga đi qua CLI
`taigent` (`plan`, `apply --yes`, `whoami`), nên quy trình plan → review → apply và luật `--yes` vẫn chỉ có một chỗ.

## Considered Options

- Comment trên Taiga (sau khi apply): BA/PO chỉ thấy item sau khi nó đã được tạo, trái với review trước apply.
- Web app / server riêng: cần hosting và đăng nhập, trong khi BA/PO đã có repo trên máy.
- Chỉ dùng `taigent preview` + sửa YAML tay: đủ cho người quen git, không đủ cho BA/PO.

## Consequences

- Verdict gắn với digest của item: sửa item sau khi approved thì verdict thành stale và cần duyệt lại.
- Approve trong `review.yaml` không phải là đồng ý apply; `plan`/`apply` bỏ qua file này.
