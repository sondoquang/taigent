# taigent

Headless toolkit for driving Taiga from AI agents (Claude Code, Codex): declarative manifests in git, applied by the
`taigent` CLI with a plan → review → apply workflow, plus agent skills (`taiga-*` and the `ask-taigent` router) and
the Taiga MCP server for reading.

## Use it in your project

Five steps, a few minutes. You need **Node.js 24 or later** (`node --version`) and a Taiga account. Run every command
from your project's root folder.

### 1. Install

```sh
npm install -D github:sondoquang/taigent
npx taigent init
npm install
```

The first command installs the `taigent` CLI and the Taiga MCP server into `node_modules` (nothing system-wide) and
creates `package.json` if the project has none. `taigent init` then adds the ten Taigent skills to `.agents/skills/`
(Codex) and `.claude/skills/` (Claude Code), the `taiga` MCP server to `.mcp.json` and `.codex/config.toml`, the
headless kit (`tools/taiga/allowlist.txt`, `.codex/hooks/`, `.codex/rules/`), and pins `taigent` in `package.json` to
its release tag, which `npm install` installs. It keeps your other skills, servers and dependencies, and lists every
file it wrote (`--dry-run` shows them first).

### 2. Log in to Taiga

Open **your own terminal**: not inside Claude Code or Codex, and not with Claude Code's `!`. Then run:

```sh
npx taigent login
```

| It asks for | Type |
|---|---|
| Taiga API URL | your Taiga address, e.g. `https://taiga.example.com` (`/api/v1` is added for you) |
| Username or email | your Taiga username or email |
| Password | your Taiga password (hidden while you type) |

Check it worked:

```sh
npx taigent whoami
```

```text
Taiga: https://taiga.example.com/api/v1
User: jane (id 42)
Credentials: stored login (refresh-token, in Windows Credential Manager)
```

### 3. Connect your agent to Taiga

`taigent init` (step 1) wrote the `taiga` server into `.mcp.json` (Claude Code) and `.codex/config.toml` (Codex).

**Claude Code.** Start `claude` in the project and answer **yes** when it asks to use the `taiga` server. `/mcp` then
shows `taiga` as connected.

**Codex.** Codex reads `.codex/config.toml` once you trust the project.

None of the files `init` wrote holds a password, so commit them: teammates then only run `npm install` in step 1 and
skip this step.

### 4. Check everything

In your agent, run `/taiga-setup` (Claude Code) or `$taiga-setup` (Codex). It checks the CLI, your login and the MCP
server: three `ok` means you are done. Anything else comes with the fix.

### 5. Try it

Ask for your tickets with `/taiga-my-tickets` (e.g. `/taiga-my-tickets October`), or close one with "close #84"
(`taiga-update-ticket`). Not sure which skill fits? Ask `/ask-taigent` (`$ask-taigent` in Codex).

### 6. Optional: your tickets on Telegram

In a private chat with your own Telegram bot you get your week's tickets on Monday at 08:30, your day's tickets every
weekday at 08:35, and at 16:45 an end-of-day reminder of the open tickets due today or earlier. Answer it with
"đóng hết" or "đóng #84" and they move to `Done` right away. The bot acts with your Taiga login, so it is one bot per
person. Nothing to deploy: it runs on your machine, so messages go out while the machine is on, and the bot answers
while the session of step d is open. Steps 1–4 done (`taiga` connected in `/mcp`)? Start here, in the project root.

**a. Install Bun**, which runs the Telegram plugin, then open a new terminal and check `bun --version`:

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"     # Windows
```

```sh
curl -fsSL https://bun.sh/install | bash          # macOS, Linux
```

**b. Create your bot.** In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot`, give it a name and a
username ending in `bot`. Copy the token it replies (`123456789:AA…`) and keep it to yourself.

**c. Install the Telegram plugin.** Start `claude` and type (choose the user scope when asked):

```text
/plugin install telegram@claude-plugins-official
/telegram:configure 123456789:AA...
```

`Marketplace "claude-plugins-official" not found`: run `/plugin marketplace add anthropics/claude-plugins-official`
first. Then exit `claude`.

**d. Start the chat session** and pair your Telegram account:

```sh
claude --channels plugin:telegram@claude-plugins-official --append-system-prompt-file node_modules/taigent/docs/telegram-reply.md
```

Send any message to your bot: it replies with a 6-character code. Back in `claude`, type `/telegram:access pair
<code>`, then `/telegram:access policy allowlist` so nobody else can use it. Leave this terminal open.

`--append-system-prompt-file` makes the answers bold the key facts (project, ticket refs, hours, due status) with
Telegram's MarkdownV2; the rules are in [docs/telegram-reply.md](docs/telegram-reply.md), and in the taigent
repository itself the path is `docs/telegram-reply.md`. Without it the answers are plain text.

**e. Let chats run without prompts.** Add these rules to the project's `.claude/settings.json` (the taigent repository
has them already):

```json
{
  "permissions": {
    "allow": [
      "Bash(npx taigent tickets *)", "Bash(npx taigent status *)", "Bash(npx taigent comment *)",
      "PowerShell(npx taigent tickets *)", "PowerShell(npx taigent status *)", "PowerShell(npx taigent comment *)"
    ]
  }
}
```

The bot's first answer asks, in the terminal, to allow the plugin's `reply` tool: pick the option that stops asking.

**f. Try it.** In another terminal, in the project root:

```sh
npx taigent notify eod --dry-run   # prints the end-of-day reminder, sends nothing
npx taigent notify day             # sends your day's tickets to Telegram
```

Then write to the bot, e.g. "ticket nào đến hạn hôm nay?" or "đóng #84".

**g. Schedule the messages.** Windows, in PowerShell, from the project root (the tasks run as you while you are
logged on):

```powershell
$weekdays = 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'
$runs = @{ week = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 08:30
           day  = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $weekdays -At 08:35
           eod  = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $weekdays -At 16:45 }
foreach ($kind in $runs.Keys) {
  $action = New-ScheduledTaskAction -Execute 'npx.cmd' -Argument "taigent notify $kind" -WorkingDirectory (Get-Location).Path
  Register-ScheduledTask -TaskName "taigent notify $kind" -Trigger $runs[$kind] -Action $action
}
```

`Get-ScheduledTask -TaskName 'taigent notify*'` lists the three tasks; `Unregister-ScheduledTask -TaskName 'taigent
notify eod'` removes one. macOS or Linux: `crontab -e` and add (on Linux, cron has no desktop session: log in with
`TAIGENT_CREDENTIAL_STORE=file`):

```text
30 8 * * 1    cd /path/to/project && npx taigent notify week
35 8 * * 1-5  cd /path/to/project && npx taigent notify day
45 16 * * 1-5 cd /path/to/project && npx taigent notify eod
```

### If something goes wrong

| You see | Do this |
|---|---|
| `node` missing, or a version below 24 | Install Node.js 24 or later, then redo step 1 |
| `not logged in to Taiga` | Step 2, in your own terminal |
| `taigent login reads your password from a terminal` | You ran it through an agent or a pipe: run it in your own terminal |
| `the stored login … has expired or was revoked` | Unused for 8 days: run `npx taigent login` again |
| `TAIGA_API_URL is …, but the stored login is for …` | Remove that `TAIGA_API_URL` (often in `.env`), or log in to that Taiga |
| `/mcp` has no `taiga`, or shows it pending | Check `.mcp.json` is in the project root, restart `claude` there and accept `taiga` |
| You declined `taiga` earlier | `claude mcp reset-project-choices`, then restart `claude` and accept it |
| `taiga` failed to connect | Run `npx taigent mcp` in a terminal: its error names the problem (Ctrl+C to stop) |
| `no Telegram bot token` | Step 6c (`/telegram:configure <token>`) |
| `no paired Telegram user` | Step 6d: message the bot, then `/telegram:access pair <code>` |
| `Telegram refused the message … chat not found` | Send your bot a message first: a bot cannot start a chat |
| The bot does not answer in Telegram | The session of step 6d is closed: start it again in the project root |
| `--channels` is not available | Claude Code needs a claude.ai or Console login; on Team/Enterprise plans an admin enables channels |

### Good to know

- Your password is used once and **never stored**. taigent keeps a token in your OS credential store (Windows
  Credential Manager, macOS Keychain, Linux Secret Service); it renews itself while you use taigent.
  `npx taigent logout` removes it.
- Your Taiga admin can create an Application for taigent: `npx taigent login --application <id>` then stores a token
  that never expires.
- No credential store (CI, headless Linux)? Set `TAIGA_API_URL`, `TAIGA_USERNAME` and `TAIGA_PASSWORD` (or
  `TAIGA_TOKEN`) in the environment or a git-ignored `.env` (see `.env.example`). They take precedence over the stored
  login.
- Update later with `npm install -D github:sondoquang/taigent`, then `npx taigent init` (it updates the skills and
  the pin) and `npm install`.
- Details: [docs/cli.md](docs/cli.md) (commands, credentials, manifests, exit codes) and
  [§ Login and the MCP server](docs/cli.md#login-and-the-mcp-server).

## Taigent Desktop (review app for BA/PO)

`desktop/` holds **Taigent Desktop**, an Electron app for Business Analysts and Product Owners: open the repository
folder, read the backlog the agent wrote exactly as `apply` would write it, comment and mark each item **Đạt**
(approved) or **Cần sửa** (changes) in `taiga/<slug>/review.yaml`, log in, see the Taiga plan and push after an
explicit confirmation. A terminal panel (`` Ctrl+` ``) runs shells and `claude`, `codex` or `omp` in the repository,
in tabs. It runs the taigent CLI and core bundled inside it (no Node needed for the installed app).

```sh
npm run build && cd desktop && npm install && npm start   # from source
npm run dist                                              # in desktop/: Windows installer in desktop/release/
```

Guide (Vietnamese): [docs/desktop.md](docs/desktop.md).

## Develop taigent

```sh
npm install
npm run taigent -- plan --project <slug>
npm run taigent -- apply --project <slug> --yes
npm test && npm run typecheck
```

In this repository `.mcp.json` and `.codex/config.toml` run `bin/taigent.js mcp`; log in with `npm run taigent -- login`.
