# Design system của Taigent Desktop

Giao diện Taigent Desktop dùng **shadcn/ui** (style `new-york`, màu gốc `zinc`) trên **Tailwind CSS v4**, viết bằng
**React 19**, ưu tiên giao diện tối. Tài liệu này là luật cho mọi màn hình trong `desktop/src/renderer/`. Token khai báo
một chỗ duy nhất: `desktop/src/renderer/globals.css`.

## 1. Bối cảnh và mục tiêu

Ý đồ thiết kế: một bàn làm việc gọn, tối, đậm chất công cụ, để BA/PO và dev review backlog rồi đẩy lên Taiga mà không
phải đoán nút nào làm gì.

- Người dùng: BA/PO review backlog và dev dùng terminal, agent, git. Đây là app desktop (Electron), cửa sổ rộng tối
  thiểu 960px, không phải trang web bán hàng.
- Token lấy từ một bảng đo giao diện admin tối kiểu Medusa (trang Orders): nền đen, bề mặt zinc, chữ zinc-100/400,
  13px. Các phần bảng đo không đáng tin (đối tượng, loại sản phẩm, "border trắng") đã được chỉnh theo app này. Font
  của bảng đo (Inter) được thay bằng Geist, font của app.
- Mục tiêu: nhất quán (chỉ component của shadcn với variant mặc định), dễ tiếp cận (WCAG 2.2 AA), làm nhanh (không có
  CSS riêng cho từng màn hình).

## 2. Token và nền tảng

### Cỡ gốc

`html { font-size: 13px }`. Nhờ vậy thang spacing và radius của Tailwind trùng với token: không cần giá trị tuỳ ý.

| Token | Giá trị | Class Tailwind |
|---|---|---|
| `space.1` | 1.63px | `*-0.5` |
| `space.2` | 3.25px | `*-1` |
| `space.3` | 6.5px | `*-2` |
| `space.4` | 9.75px | `*-3` |
| `space.5` | 34px | `h-10.5`, chiều cao hàng lớn |
| `radius.xs` | 4.88px | `rounded-sm` |
| `radius.sm` | 6.5px | `rounded-lg` (`--radius`) |

Ngoài bảng trên, app chỉ dùng các bậc kế tiếp của cùng thang: `*-4` 13px, `*-6` 19.5px.

### Chữ

| Token | Cỡ | Class | Dùng cho |
|---|---|---|---|
| `font.size.xs` | 10px | `text-2xs` | nhãn loại item (EPIC, STORY) |
| `font.size.sm` | 10.56px | `text-xs` | meta, chú thích, badge, status bar |
| `font.size.md` (base) | 13px, line-height 19.5px | `text-sm`, `text-base` | chữ thân, control (mặc định của shadcn) |
| `font.size.lg` | 14.63px | `text-lg` | số thống kê, tiêu đề phụ |
| — | 16.25px | `text-xl` | tiêu đề màn hình (`PageHeader`) |

Font: `Geist` (biến thể variable, thẳng và nghiêng) cho toàn bộ giao diện, kể cả key, đường dẫn và code; `Geist Mono`
chỉ dùng cho terminal. Cả hai đóng gói trong `desktop/src/renderer/fonts/` (SIL OFL 1.1, `OFL.txt`), không tải gì từ
mạng. Không dùng class `font-mono`: `--font-mono` cũng trỏ về Geist để thẻ `code`, `kbd`, `pre` theo cùng font.
Trọng số: 400 cho chữ thân, 500 (`font-medium`) cho nhãn, 600 (`font-semibold`) cho tiêu đề.

### Màu (token ngữ nghĩa)

Component chỉ dùng tên token, không bao giờ dùng mã màu.

| Token shadcn | Tối (mặc định) | Token gốc | Dùng cho |
|---|---|---|---|
| `background` | `#000000` | `color.surface.base` | nền trang |
| `card`, `popover`, `sidebar` | `#18181b` | `color.surface.raised` | panel, dialog, top bar, rail |
| `muted`, `secondary`, `accent` | `#212124` | `color.surface.strong` | hover, hàng chọn, code |
| `foreground` | `#f4f4f5` | `color.text.secondary` | chữ chính |
| `muted-foreground` | `#a1a1aa` | `color.text.primary` | chữ phụ, placeholder |
| `border`, `input` | `#27272a` | vòng `rgb(39,39,42)` của `shadow.1` | viền |
| `ring` | `#a1a1aa` | — | viền focus |
| `primary` | `#f4f4f5` trên `#18181b` | — | nút hành động chính |
| `destructive`, `success`, `warning`, `info` | đỏ, xanh lá, vàng, xanh dương (oklch) | — | trạng thái |

`color.text.tertiary` (`#71717a`) không dùng cho chữ: chỉ đạt 3.67:1 trên `surface.raised`. Control bị vô hiệu hoá
dùng `opacity-50` mặc định của shadcn. Giao diện sáng dùng nguyên bảng zinc sáng của shadcn.

Tông trạng thái của review (`StatusBadge`, `TONE_CLASS` trong `components/common.tsx`):

| Trạng thái | Tông |
|---|---|
| Đạt | `success` |
| Cần sửa | `warning` |
| Đã đổi sau khi duyệt | `destructive` |
| Chưa duyệt | `muted` |
| Mới, góp ý mở | `info` |
| Đã đẩy | `secondary` |

### Độ nổi và chuyển động

- `shadow-xs`/`shadow-sm` = `shadow.1` (control, card), `shadow-md`/`shadow-lg` = `shadow.2` (popover, dialog). Ở giao
  diện tối, hai shadow này có vòng sáng 6% phía trên.
- `motion.duration.instant` 150ms: mọi transition mặc định. `motion.duration.fast` 200ms: mở và đóng overlay (mặc định
  của shadcn).
- Chế độ sáng/tối: biến thể `dark:` của Tailwind đi theo `prefers-color-scheme`. Main process đặt giá trị này qua
  `nativeTheme.themeSource` (Settings > Giao diện, mặc định *Tối*).

## 3. Luật cho component

Mọi control lấy từ `desktop/src/renderer/components/ui/` với variant mặc định. Thêm component bằng
`npx shadcn@latest add <tên>` trong `desktop/`. Component dùng chung của app nằm trong `components/`: `PageHeader`,
`ScreenBody`, `Block`, `StatCell`, `StatusBadge`, `ReviewBadges`, `TypeBadge`, `Markdown`, `FailureBlock` và
`showConflict`.

Trạng thái bắt buộc của mọi component tương tác:

| Trạng thái | Cách làm |
|---|---|
| default, hover, active | style mặc định của shadcn |
| focus-visible | `focus-visible:ring-[3px] ring-ring/50` cộng `border-ring` (mặc định của shadcn); không bao giờ gỡ |
| disabled | thuộc tính `disabled` (shadcn đặt `opacity-50`, `pointer-events-none`) |
| loading | `disabled` cộng `<Spinner/>` trong nút khi thao tác async đang chạy |
| error | `FailureBlock`, hoặc `Field data-invalid` + `FieldError` + `aria-invalid` trên control |
| empty | câu trống rõ nghĩa (`Empty` hoặc đoạn `text-muted-foreground`) |

| Component | Cấu tạo và variant | Bàn phím, chuột, cảm ứng | Nội dung dài, tràn, trống |
|---|---|---|---|
| Button | `default` cho hành động chính (mỗi vùng một nút), `outline` cho hành động phụ, `ghost` cho thanh công cụ, `destructive` cho xoá; `size="sm"` trên thanh công cụ | Tab tới; Enter hoặc Space kích hoạt; nút chỉ có icon phải có `aria-label` và Tooltip; vùng chạm ≥ 24px | nhãn một dòng, không xuống dòng; nhãn mô tả hành động (*Đẩy lên Taiga*, không phải *OK*) |
| Link (`Button variant="link"`, link trong Markdown) | gạch chân, màu `foreground` | link Markdown mở bằng trình duyệt hệ thống (`a[data-external]`) | `overflow-wrap: anywhere` |
| Card (panel) | `Card` > `CardHeader` (`CardTitle`, `CardDescription`, `CardAction`) > `CardContent` | không tự nhận focus | nội dung dài cuộn trong `CardContent` (`max-h-*` + `overflow-auto`) |
| List, cây | hàng `button` (cây Backlog) hoặc `Item` / `Table` | cây: j/k, ↑/↓ chuyển mục; hàng là button nên Tab và Enter dùng được | `truncate` + `title` cho tiêu đề; câu trống khi không có mục hoặc bộ lọc không khớp |
| Navigation (rail) | button `ghost` có icon và nhãn; mục đang mở có `aria-current="page"` và nền `sidebar-accent` | Tab hoặc Shift+Tab, Enter | nhãn `truncate` |
| Dialog, AlertDialog | `DialogHeader` (tiêu đề, mô tả), thân cuộn, `DialogFooter` (Huỷ `outline` bên trái, hành động chính bên phải) | bẫy focus; Esc đóng; focus trả về nút đã mở | thân `max-h-[60vh]`+ cuộn; form rộng dùng `sm:max-w-3xl`/`4xl` |
| Form | `FieldGroup` > `Field` > `FieldLabel` + control + `FieldDescription`/`FieldError` | mọi input có nhãn; Enter gửi form một dòng; Ctrl+Enter gửi góp ý | lỗi đặt ngay dưới input |
| Select | `NativeSelect` (giữ select gốc, dùng được với bàn phím và trình đọc màn hình) | mũi tên chọn | tuỳ chọn dài: `truncate` |
| Toast | `toast()` trong `actions.ts` (sonner): thông tin 3 giây, lỗi 8 giây | có nút đóng; vùng live của sonner đọc nội dung | một câu |
| Terminal | xterm.js, nền tối ở cả hai giao diện | Ctrl+` bật hoặc tắt; thanh tab dùng được bằng bàn phím | cuộn trong xterm |

Bố cục và responsive:

- Màn hình (trừ Backlog) dùng `ScreenBody`: rộng tối đa `max-w-6xl`, `p-6`, khoảng cách giữa khối `gap-6`. Lưới nhiều
  cột dùng `md:` hoặc `lg:`, hẹp hơn thì xếp chồng. Breakpoint của Tailwind tính bằng rem nên ở cỡ gốc 13px chúng là
  `sm` 416px, `md` 624px, `lg` 832px, `xl` 1040px, `2xl` 1248px (bề ngang viewport). Cửa sổ rộng tối thiểu 960px,
  nên `lg:` luôn áp dụng cho cửa sổ; trong dialog, dùng chiều rộng của dialog để quyết định số cột.
- Con của flex luôn có `min-w-0`. Đường dẫn, key, tiêu đề trong hàng dùng `truncate` + `title`. Text tự do dùng
  `whitespace-pre-wrap` hoặc `break-words`.

Mật độ component trong bảng đo tham chiếu: 16 nút, 15 link, 3 card, 3 list, 1 thanh điều hướng. Màn hình của app nên
giữ cỡ đó: một hàng hành động chính, ít card, list là phần chính.

## 4. Tiếp cận (WCAG 2.2 AA) và tiêu chí kiểm tra

| # | Tiêu chí | Cách kiểm tra | Đạt khi |
|---|---|---|---|
| A1 | Tương phản chữ | đo màu chữ trên nền của nó | ≥ 4.5:1 (chữ thường), ≥ 3:1 (chữ ≥ 18.66px đậm). `foreground` ≥ 14.6:1 và `muted-foreground` ≥ 6.2:1 trên mọi bề mặt tối |
| A2 | Focus nhìn thấy | Tab qua từng control | mọi control có vòng focus; không control nào có `outline-none` mà thiếu `focus-visible:ring` |
| A3 | Bàn phím | dùng cả màn hình không cần chuột | mọi hành động tới được bằng Tab và kích hoạt bằng Enter/Space; Esc đóng overlay; focus không bị kẹt ngoài dialog |
| A4 | Nhãn | công cụ accessibility tree (Playwright `getByRole`/`getByLabel`) | mọi input, select, textarea có tên truy cập; nút chỉ có icon có `aria-label` |
| A5 | Thông báo kết quả | trình đọc màn hình hoặc kiểm tra DOM | vùng kết quả async có `aria-live="polite"`; toast nằm trong vùng live của sonner |
| A6 | Trạng thái không chỉ bằng màu | xem ảnh chụp đen trắng | badge trạng thái luôn có chữ (*Đạt*, *Cần sửa*…) |
| A7 | Vùng chạm | đo kích thước | control ≥ 24×24px (`size="sm"` = 26px) |
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
- Gỡ vòng focus (`outline-none` không có `focus-visible:ring`), hay chữ quá mờ (`opacity` dưới 80% trên chữ).
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
- Viền control (`--input` `#27272a`) chỉ đạt 1.41:1 trên nền đen, như shadcn mặc định. Ô nhập vẫn nhận ra được nhờ
  nhãn, nền `input/30` và viền `ring` khi focus.
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
