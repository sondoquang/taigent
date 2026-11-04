# Renderer của Taigent Desktop viết bằng React và shadcn/ui, ưu tiên giao diện tối

Renderer cũ dựng DOM bằng tay (`h()`, `byId()`) và có một file `styles.css` gần 2.800 dòng. Mỗi màn hình mới lại thêm
CSS riêng, và các trạng thái (focus, loading, lỗi, rỗng) mỗi chỗ làm một kiểu. Vì vậy renderer chuyển sang **React 19**
với component của **shadcn/ui** (style `new-york`, màu gốc `zinc`) trên **Tailwind CSS v4**. Giao diện mặc định là
giao diện tối.

- Design system nằm trong token của `desktop/src/renderer/globals.css` và được mô tả ở `docs/desktop-design-system.md`.
  Cỡ chữ gốc 13px nên thang của Tailwind trùng với token.
- Main process, preload, IPC và luật "mọi thao tác ghi lên Taiga chỉ qua CLI" (ADR 0003) giữ nguyên. Renderer vẫn chỉ
  dùng `window.taigent`.
- Bundle vẫn dùng esbuild (một IIFE). CSS biên dịch bằng CLI của Tailwind. Thư viện của renderer nằm trong
  `devDependencies` vì đều được bundle.

## Considered Options

- Giữ DOM thuần và viết lại CSS theo design system mới: không cần dependency, nhưng vẫn phải tự làm từng trạng thái của
  từng control, và mỗi màn hình vẫn là code mệnh lệnh khó đọc.
- Một thư viện component khác (MUI, Mantine): có sẵn nhiều thứ hơn, nhưng style khó chỉnh theo token, bundle nặng, và
  code component không nằm trong repo.
- Vite thay esbuild: có dev server, nhưng app Electron này chỉ cần một bundle tĩnh, và esbuild đã có sẵn trong build.

## Consequences

- Component của shadcn được copy vào `desktop/src/renderer/components/ui/`. Chúng là code của repo: sửa được, nhưng
  nên giữ mặc định.
- Script smoke vẫn chọn theo id, `data-*` và vài class móc. Dialog của shadcn mở với `data-state="open"` thay vì thuộc
  tính `open`, và toast của sonner thay `#toast`.
- Giao diện mặc định đổi từ *Theo hệ thống* sang *Tối*. Lựa chọn đã lưu trong `settings.json` vẫn được giữ.
- Toàn bộ giao diện dùng font Geist, kể cả key và code; chỉ terminal dùng Geist Mono.
