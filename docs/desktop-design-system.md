# Design system của Taigent Desktop

Giao diện Taigent Desktop dùng **shadcn/ui** (style `new-york`, màu gốc `zinc`) trên **Tailwind CSS v4**, viết bằng
**React 19**, ưu tiên giao diện tối. Tài liệu này là luật cho mọi màn hình trong `desktop/src/renderer/`. Token khai báo
một chỗ duy nhất: `desktop/src/renderer/globals.css`.

## 1. Bối cảnh và mục tiêu

Ý đồ thiết kế: một bàn làm việc gọn, tối, đậm chất công cụ, để BA/PO và dev review backlog rồi đẩy lên Taiga mà không
phải đoán nút nào làm gì.

- Người dùng: BA/PO review backlog và dev dùng terminal, agent, git. Đây là app desktop (Electron), cửa sổ rộng tối
  thiểu 960px, không phải trang web bán hàng.
- Giao diện theo admin của Medusa (`@medusajs/ui`, đo trực tiếp trên trang Products ở chế độ tối): nền trang
  `bg-subtle`, card `bg-base` có viền vẽ bằng shadow, chữ 13px với hai trọng số 400/500, thanh bên trái cao hết cửa
  sổ, bảng tràn hết bề ngang card, skeleton nhấp nháy khi đang đọc dữ liệu. Font của Medusa (Inter) được thay bằng
  Geist, font của app.
- Mục tiêu: nhất quán (chỉ component của shadcn với variant mặc định), dễ tiếp cận (WCAG 2.2 AA), làm nhanh (không có
  CSS riêng cho từng màn hình).

## 2. Token và nền tảng

### Cỡ gốc và khoảng cách

`html { font-size: 13px }`, nhưng thang spacing của Tailwind đặt lại là bước 4px (`--spacing: 4px`) như Medusa: class
của Medusa dùng nguyên được, không cần giá trị tuỳ ý. Cỡ gốc 13px chỉ còn quyết định breakpoint và `max-w-*` (rem).

| Class | Giá trị | Dùng cho |
|---|---|---|
| `*-0.5` | 2px | đệm trong hàng nav, avatar |
| `*-1.5`, `*-2` | 6px, 8px | đệm control, khoảng cách icon |
| `*-3` | 12px | đệm sidebar, khoảng giữa mục nav |
| `*-4`, `*-6` | 16px, 24px | đệm card (`py-4`, `px-6`), mép bảng |
| `h-7`, `h-8`, `h-12`, `h-13` | 28px, 32px, 48px, 52px | mục nav và nút nhỏ, control, hàng bảng, top bar |
| `w-55` | 220px | sidebar |
| `rounded-sm`, `rounded-md`, `rounded-lg` | 4px, 6px, 8px | skeleton và chip, control và mục nav, card và dialog |

### Chữ

| Class | Cỡ / line-height | Medusa | Dùng cho |
|---|---|---|---|
| `text-2xs` | 11px / 16px | — | nhãn loại item (EPIC, STORY) |
| `text-xs` | 12px / 20px | `txt-compact-xsmall` | meta, chú thích, badge, status bar |
| `text-sm`, `text-base` | 13px / 20px | `txt-compact-small` | chữ thân, control, bảng, nav |
| `text-lg` | 16px / 24px | `h2-core` | tiêu đề card, dialog, số thống kê |
| `text-xl` | 18px / 28px | `h1-core` | tiêu đề màn hình (`PageHeader`) |

Font: `Geist` (biến thể variable, thẳng và nghiêng) cho toàn bộ giao diện, kể cả key, đường dẫn và code; `Geist Mono`
chỉ dùng cho terminal. Cả hai đóng gói trong `desktop/src/renderer/fonts/` (SIL OFL 1.1, `OFL.txt`), không tải gì từ
mạng. Không dùng class `font-mono`: `--font-mono` cũng trỏ về Geist để thẻ `code`, `kbd`, `pre` theo cùng font.
Trọng số như Medusa, chỉ hai mức: 400 cho chữ thân và ô bảng, 500 (`font-medium`) cho nhãn, nút, mục nav, đầu cột và
mọi tiêu đề. Không dùng `font-semibold`/`font-bold`; `b`, `strong` (cả trong Markdown) cũng là 500.

### Màu (token ngữ nghĩa)

Component chỉ dùng tên token, không bao giờ dùng mã màu.

| Token | Tối (mặc định) | Sáng | Medusa | Dùng cho |
|---|---|---|---|---|
| `background`, `sidebar` | `#18181b` | `#fafafa` | `bg-subtle` | nền trang, sidebar, top bar, đầu bảng |
| `card` | `#212124` | `#ffffff` | `bg-base` | card, dialog, hàng bảng, mục nav đang mở |
| `popover` | `#27272a` | `#ffffff` | `bg-component` | menu, select |
| `muted`, `secondary`, `accent` | `#27272a` | `#f4f4f5` | `bg-component`, `bg-base-hover` | skeleton, hover trên card |
| `sidebar-accent` | `#212124` | `#f4f4f5` | `bg-subtle-hover` | hover trên sidebar và cây Backlog |
| `field`, `field-hover` | trắng 4% / 8% | `#fafafa` / `#f4f4f5` | `bg-field` | nền input, select, textarea |
| `button-neutral(-hover)` | trắng 4% / 8% | `#ffffff` / `#f4f4f5` | `button-neutral` | nút `outline`, `secondary` |
| `primary` | `#52525b` | `#27272a` | `button-inverted` | nút hành động chính |
| `foreground` | `#f4f4f5` | `#18181b` | `fg-base` | chữ chính |
| `muted-foreground` | `#a1a1aa` | `#52525b` | `fg-subtle` | chữ phụ, placeholder, ô bảng, mục nav chưa mở |
| `border` | trắng 8% | `#e4e4e7` | `border-base` | đường chia |
| `ring`, `interactive` | `#60a5fa` | `#3b82f6` | `fg-interactive` | focus, checkbox/radio/switch đang bật, link |
| `highlight` | `#172554` | `#eff6ff` | `bg-highlight` | hàng bảng đang chọn |
| `success`, `warning`, `danger`, `info`, `neutral` (+ `-bg`, `-border`, `-icon`) | màu tag của Medusa | | `tag-*` | badge, hộp cảnh báo, số thống kê |
| `destructive` | `#fb7185` | `#e11d48` | `fg-error` | chữ lỗi |

`fg-muted` của Medusa (`#71717a`) không dùng cho chữ: chỉ đạt khoảng 3.7:1. Control bị vô hiệu hoá dùng `opacity-50`.

Tông trạng thái của review (`StatusBadge`, `TONE_CLASS` trong `components/common.tsx`), theo màu tag của Medusa:

| Trạng thái | Tông |
|---|---|
| Đạt | `success` (xanh lá) |
| Cần sửa | `warning` (cam) |
| Đã đổi sau khi duyệt | `danger` (đỏ) |
| Chưa duyệt, Đã đẩy | `neutral` (xám) |
| Mới, góp ý mở | `info` (xanh dương) |

### Độ nổi và chuyển động

- Như Medusa, control và card không có `border`: viền là shadow. `shadow-borders-base` (input, select, avatar),
  `shadow-buttons-neutral`/`-inverted`/`-danger` (nút), `shadow-elevation-card` (card, mục nav và hàng cây đang chọn),
  `shadow-elevation-flyout` (menu, popover, select), `shadow-elevation-tooltip`, `shadow-elevation-modal` (dialog).
  Focus cũng là shadow: `shadow-borders-focus`, `shadow-borders-active` (input), `shadow-buttons-*-focus` (nút).
- `divider-dashed`: đường chia nét đứt 1px của sidebar.
- 150ms cho mọi transition mặc định; 200ms khi mở và đóng overlay (mặc định của shadcn).
- Chế độ sáng/tối: biến thể `dark:` của Tailwind đi theo `prefers-color-scheme`. Main process đặt giá trị này qua
  `nativeTheme.themeSource` (Settings > Giao diện, mặc định *Tối*).

## 3. Luật cho component

Mọi control lấy từ `desktop/src/renderer/components/ui/` với variant mặc định. Thêm component bằng
`npx shadcn@latest add <tên>` trong `desktop/`. Component dùng chung của app nằm trong `components/`: `PageHeader`,
`ScreenBody`, `Block`, `StatCell`, `StatusBadge`, `ReviewBadges`, `TypeBadge`, `TableSkeleton`, `Markdown`,
`FailureBlock` và `showConflict`.

Trạng thái bắt buộc của mọi component tương tác:

| Trạng thái | Cách làm |
|---|---|
| default, hover, active | style của component trong `components/ui/` (đã theo Medusa) |
| focus-visible | shadow focus của component (`shadow-borders-focus`, `shadow-buttons-*-focus`); không bao giờ gỡ |
| disabled | thuộc tính `disabled` (`opacity-50`, `pointer-events-none`) |
| loading | nút: `disabled` cộng `<Spinner/>`; bảng hoặc danh sách đang đọc lần đầu: `TableSkeleton` (một dải đầu bảng và các dải hàng `h-10`, `animate-pulse`, nền `muted`) hoặc `Skeleton` cùng hình với nội dung, có `role="status"` và `aria-label` |
| error | `FailureBlock`, hoặc `Field data-invalid` + `FieldError` + `aria-invalid` trên control |
| empty | câu trống rõ nghĩa (`Empty` hoặc đoạn `text-muted-foreground`) |

| Component | Cấu tạo và variant | Bàn phím, chuột, cảm ứng | Nội dung dài, tràn, trống |
|---|---|---|---|
| Button | `default` (inverted) cho hành động chính (mỗi vùng một nút), `outline` cho hành động phụ, `ghost` cho thanh công cụ, `destructive` cho xoá; cao 32px, `size="sm"` 28px trên thanh công cụ | Tab tới; Enter hoặc Space kích hoạt; nút chỉ có icon phải có `aria-label` và Tooltip; vùng chạm ≥ 24px | nhãn một dòng, không xuống dòng; nhãn mô tả hành động (*Đẩy lên Taiga*, không phải *OK*) |
| Link (`Button variant="link"`, link trong Markdown) | gạch chân, màu `foreground` | link Markdown mở bằng trình duyệt hệ thống (`a[data-external]`) | `overflow-wrap: anywhere` |
| Card (panel) | `Card` > `CardHeader` (`CardTitle` 16px, `CardDescription`, `CardAction`) > `CardContent`; `bg-card`, `rounded-lg`, `shadow-elevation-card`, không viền | không tự nhận focus | nội dung dài cuộn trong `CardContent` (`max-h-*` + `overflow-auto`) |
| Table | đầu bảng nền `background`, hàng `h-12` có đường chia, hover `accent`, chữ ô `muted-foreground`; trong card, bọc bảng bằng `-mx-6` để bảng chạm hai mép card (mép ô đầu/cuối 24px, `--table-edge`); bảng khoá-giá trị ngoài card đặt `[--table-edge:0px]` | — | `truncate` + `title` cho ô một dòng, `whitespace-normal` cho ô dài |
| List, cây | hàng `button` (cây Backlog: cao 28px, hover `sidebar-accent`, mục chọn `bg-card shadow-elevation-card`) hoặc `Item` | cây: j/k, ↑/↓ chuyển mục; hàng là button nên Tab và Enter dùng được | `truncate` + `title` cho tiêu đề; câu trống khi không có mục hoặc bộ lọc không khớp |
| Sidebar | cao hết cửa sổ, rộng 220px: brand, đường chia nét đứt, mục nav (28px, icon trong ô 24px, cách nhau 12px; mục đang mở có `aria-current="page"`, `bg-card shadow-elevation-card`), Setup repo và Settings ở đáy, nút tài khoản Taiga (`#login-btn`) cuối cùng | Tab hoặc Shift+Tab, Enter | nhãn `truncate` |
| Dialog, AlertDialog | `DialogHeader` (tiêu đề, mô tả), thân cuộn, `DialogFooter` (Huỷ `outline` bên trái, hành động chính bên phải) | bẫy focus; Esc đóng; focus trả về nút đã mở | thân `max-h-[60vh]`+ cuộn; form rộng dùng `sm:max-w-3xl`/`4xl` |
| Form | `FieldGroup` > `Field` > `FieldLabel` + control + `FieldDescription`/`FieldError` | mọi input có nhãn; Enter gửi form một dòng; Ctrl+Enter gửi góp ý | lỗi đặt ngay dưới input |
| Select | `NativeSelect` (giữ select gốc, dùng được với bàn phím và trình đọc màn hình) | mũi tên chọn | tuỳ chọn dài: `truncate` |
| Toast | `toast()` trong `actions.ts` (sonner): thông tin 3 giây, lỗi 8 giây | có nút đóng; vùng live của sonner đọc nội dung | một câu |
| Terminal | xterm.js, nền tối ở cả hai giao diện | Ctrl+` bật hoặc tắt; thanh tab dùng được bằng bàn phím | cuộn trong xterm |

Bố cục và responsive:

- Khung như Medusa: sidebar cao hết cửa sổ bên trái; bên phải là top bar (`h-13`, repo, dự án, Terminal), nội dung,
  panel terminal và status bar.
- Màn hình (trừ Backlog) dùng `ScreenBody`: rộng tối đa `max-w-6xl`, `p-6` (24px), khoảng cách giữa khối `gap-6`. Lưới
  nhiều cột dùng `md:` hoặc `lg:`, hẹp hơn thì xếp chồng. Breakpoint của Tailwind tính bằng rem nên ở cỡ gốc 13px chúng
  là `sm` 416px, `md` 624px, `lg` 832px, `xl` 1040px, `2xl` 1248px (bề ngang viewport). Cửa sổ rộng tối thiểu 960px,
  nên `lg:` luôn áp dụng cho cửa sổ; trong dialog, dùng chiều rộng của dialog để quyết định số cột.
- Con của flex luôn có `min-w-0`. Đường dẫn, key, tiêu đề trong hàng dùng `truncate` + `title`. Text tự do dùng
  `whitespace-pre-wrap` hoặc `break-words`.

## 4. Tiếp cận (WCAG 2.2 AA) và tiêu chí kiểm tra

| # | Tiêu chí | Cách kiểm tra | Đạt khi |
|---|---|---|---|
| A1 | Tương phản chữ | đo màu chữ trên nền của nó | ≥ 4.5:1 (chữ thường), ≥ 3:1 (chữ ≥ 18.66px đậm). Tối: `foreground` ≥ 13.5:1 và `muted-foreground` ≥ 5.8:1 trên `background`, `card`, `muted`; sáng: ≥ 16:1 và ≥ 7:1; chữ tag ≥ 6.3:1 trên nền tag |
| A2 | Focus nhìn thấy | Tab qua từng control | mọi control có vòng focus; không control nào có `outline-none` mà thiếu shadow focus (`focus-visible:shadow-*-focus`) |
| A3 | Bàn phím | dùng cả màn hình không cần chuột | mọi hành động tới được bằng Tab và kích hoạt bằng Enter/Space; Esc đóng overlay; focus không bị kẹt ngoài dialog |
| A4 | Nhãn | công cụ accessibility tree (Playwright `getByRole`/`getByLabel`) | mọi input, select, textarea có tên truy cập; nút chỉ có icon có `aria-label` |
| A5 | Thông báo kết quả | trình đọc màn hình hoặc kiểm tra DOM | vùng kết quả async có `aria-live="polite"`; toast nằm trong vùng live của sonner |
| A6 | Trạng thái không chỉ bằng màu | xem ảnh chụp đen trắng | badge trạng thái luôn có chữ (*Đạt*, *Cần sửa*…) |
| A7 | Vùng chạm | đo kích thước | control ≥ 24×24px (`size="sm"` = 28px) |
| A8 | Nội dung tràn | cửa sổ 960px, tên dài 200 ký tự | không có thanh cuộn ngang ở cấp trang; tên dài bị cắt có `title` |

## 5. Nội dung và giọng văn

Ngắn, chắc, tập trung vào việc làm. Chữ giao diện bằng tiếng Việt; tên lệnh, file và key giữ nguyên trong `code`.

| Nên | Không nên |
|---|---|
| *Đẩy lên Taiga* | *OK*, *Tiếp tục* |
| *Chưa ghi gì lên Taiga.* | *Có lỗi xảy ra.* |
| *Không có mục nào khớp bộ lọc.* | một vùng trống không có chữ |
| *Mở thư mục repo có `taiga/<slug>/backlog.yaml`, rồi chọn dự án.* | *Không có dữ liệu* |

Lỗi nói rõ chuyện gì xảy ra và cách sửa, kèm chi tiết của CLI khi có (`FailureBlock`).

## 6. Mẫu bị cấm

- Mã màu trong component (`#…`, `rgb(…)`, `text-zinc-400`, `bg-red-500`): dùng token ngữ nghĩa.
- Cỡ chữ hay khoảng cách tuỳ ý (`text-[11px]`, `p-[7px]`): dùng thang ở mục 2.
- CSS riêng cho một màn hình, hay viết lại style mà shadcn đã có. Ngoại lệ duy nhất là `.markdown` trong
  `globals.css`.
- Gỡ vòng focus (`outline-none` không có `focus-visible:shadow-*-focus`), hay chữ quá mờ (`opacity` dưới 80% trên chữ).
- `<dialog>`, `window.confirm` hay `alert` trong renderer: dùng `Dialog`/`AlertDialog`. Xác nhận trước khi ghi lên
  Taiga vẫn là hộp thoại gốc của main process.
- Đọc hay ghi DOM bằng `document.getElementById`/`querySelector` để vẽ giao diện: chỉ dùng ref khi thật cần node
  (xterm, focus, cuộn).
- Nhãn mơ hồ (*Bấm vào đây*), hay hành động chỉ có icon mà không có `aria-label`.

## 7. Ghi chú chuyển đổi và trường hợp biên

- Renderer cũ (DOM thuần, `styles.css` với ba màu trắng, than, đỏ) được thay bằng React + shadcn/ui; font Geist giữ nguyên. Id,
  `data-*` và class mà script smoke chọn vẫn được giữ: class móc (`node`, `selected`, `badge approved`…) đứng cạnh
  class Tailwind. Dialog của shadcn mở với `data-state="open"` thay cho thuộc tính `open` của `<dialog>`.
- Giao diện mặc định đổi từ *Theo hệ thống* sang *Tối*. File `settings.json` đã lưu lựa chọn thì giữ nguyên.
- Viền control là `shadow-borders-base` (vòng 1px `#27272a` cộng ánh sáng 6% ở tối), mờ như ở Medusa. Ô nhập vẫn
  nhận ra được nhờ nhãn, nền `field` và vòng xanh `shadow-borders-active` khi focus.
- Chuyển sang giao diện Medusa: nền trang tối đổi từ `#000000` sang `#18181b` (cả `backgroundColor` của cửa sổ trong
  `src/main/main.ts`), brand lên đầu sidebar, nút đăng nhập Taiga xuống cuối sidebar, `font-semibold` thành
  `font-medium`, `--spacing` từ 3.25px (theo cỡ gốc) thành 4px.
- Terminal giữ nền tối ở cả hai giao diện (màu của xterm nằm trong theme của xterm, không qua token CSS).

## 8. Checklist QA

- [ ] Chỉ dùng component trong `components/ui` và `components/`; không thêm file CSS mới.
- [ ] `grep -rE "#[0-9a-fA-F]{3,8}\b|rgb\(|text-\[|p-\[|m-\[|gap-\[" desktop/src/renderer --include=*.tsx` không ra kết quả mới (trừ theme của xterm).
- [ ] Mỗi control mới có đủ các trạng thái ở mục 3, gồm loading và error.
- [ ] Tab qua màn hình: thứ tự hợp lý, focus luôn thấy được, Esc đóng dialog.
- [ ] Mọi input có nhãn, mọi nút chỉ có icon có `aria-label`.
- [ ] Xem ở cửa sổ 960px và ở cửa sổ toàn màn hình, với cả giao diện tối và sáng.
- [ ] Thử với tên rất dài, danh sách trống và lỗi từ CLI.
- [ ] `npm run smoke` trong `desktop/` chạy hết.
