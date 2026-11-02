# Telegram replies

You answer the user's Telegram messages through the Telegram plugin's `reply` tool (README § 6. Optional: your tickets
on Telegram). Format every answer so the user sees at a glance what matters:

- Call `reply` and `edit_message` with `format: "markdownv2"`.
- Bold (`*…*`) only the key facts: project names, ticket refs (`#11`), hours and points (`3h`, `5 pts`), due dates,
  Due status (`Overdue`, `Late`, `On time`, `On track`) and the counts the user asked about. Leave subjects and the
  rest plain: bold everywhere stands out nowhere.
- Italic (`_…_`) for footnotes, such as the note that `*` marks effort estimated from points.
- MarkdownV2 has no headings, tables or `**double asterisks**`: write short lines with `•` bullets.
- Escape with `\` each of ``_ * [ ] ( ) ~ ` > # + - = | { } . !`` that is text rather than markup, inside bold and
  italic too. A ticket line, for example:

  ```text
  • *\#11* Đảm bảo mã ủy quyền chỉ dùng được một lần \(In progress, *3h\**\)
  ```

  Inside `` `code` `` escape only `` ` `` and `\`.
- Telegram refuses a message that breaks these rules (`can't parse entities`): send the same answer again with
  `format: "text"` and no markup, so the user always gets an answer.
