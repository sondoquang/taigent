# taigent

Headless toolkit for driving Taiga from AI agents (Claude Code, Codex): declarative manifests in git, applied by the
`taigent` CLI with a plan → review → apply workflow, plus agent skills (`taiga-*` and the `ask-taigent` router) and
the Taiga MCP server for reading.

## Use it

Five steps, a few minutes. You need **Node.js 24 or later** (`node --version`), **git** (`git --version`) and a Taiga
account.

### 1. Install

From your project's root folder:

```sh
npm install -D github:sondoquang/taigent
npx taigent setup --project
```

The first command installs the `taigent` CLI and the Taiga MCP server into `node_modules` (nothing system-wide): npm
fetches taigent from GitHub and builds it, and creates `package.json` if the project has none. `taigent setup
--project` then adds the Taigent skills to `.agents/skills/` (Codex) and `.claude/skills/` (Claude Code), the `taiga`
MCP server to `.mcp.json` and `.codex/config.toml`, the headless kit (`tools/taiga/allowlist.txt`,
`tools/taiga/omp-guard.mjs`, `.codex/hooks/`, `.codex/rules/`), the `.gitignore` lines of the BA preview working copies
(`taiga/*/preview.md`, `taiga/*/.preview/`), and `taigent` in `devDependencies` as `github:sondoquang/taigent`
(`package-lock.json` records the commit). It keeps your other skills, servers and settings, and lists every file it
wrote (`--dry-run` shows them first). Run it in **your own terminal**: when you have no Taiga login yet, it then logs
you in (step 2's questions), and it checks the login and the MCP server (`Login: …`, `MCP server: ok …`). Run by an
agent, it never asks for a password: it says to run `npx taigent login` yourself.

`taigent setup` without `--project` installs the skills and the MCP server for you, in every project, from a global
`npm i -g taigent`. That needs taigent on npm, where it is not published yet: npm cannot build it in a global install
from GitHub.

### 2. Log in to Taiga

Skip this when `taigent setup --project` already logged you in. Otherwise open **your own terminal**: not inside Claude Code or
Codex, and not with Claude Code's `!`. Then run:

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

`taigent setup --project` (step 1) put the `taiga` server in `.mcp.json` (Claude Code) and `.codex/config.toml`
(Codex). Start `claude` in the project and answer **yes** when it asks to use the `taiga` server; Codex reads
`.codex/config.toml` once you trust the project. None of the files step 1 wrote holds a password, so commit them
(`package-lock.json` too): teammates then only run `npm install` and skip this step.

### 4. Check everything

In your agent, run `/taiga-setup` (Claude Code) or `$taiga-setup` (Codex). It checks the CLI, your login and the MCP
server: three `ok` means you are done. Anything else comes with the fix.

### 5. Try it

Ask for your tickets with `/taiga-my-tickets` (e.g. `/taiga-my-tickets October`), or close one with "close #84"
(`taiga-update-ticket`), or ask for a project's dashboard for your role (`taiga-dashboard`). Not sure which skill fits? Ask `/ask-taigent` (`$ask-taigent` in Codex).

### 6. Optional: your tickets on Telegram

In a private chat with your own Telegram bot you get your week's plan and warnings on Monday at 08:30, your day's
plan every weekday at 08:35, and at 16:45 an end-of-day reminder of the unfinished planned tickets due today or
earlier, with their re-plan. Answer it with "đóng hết" or "đóng #84" and they move to `Ready for test` right away, or
with "duyệt re-plan" to write the new due dates. The bot acts with your Taiga login, so it is one bot per
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
      "Bash(npx taigent tickets *)", "Bash(npx taigent status *)", "Bash(npx taigent comment *)", "Bash(npx taigent due *)",
      "PowerShell(npx taigent tickets *)", "PowerShell(npx taigent status *)", "PowerShell(npx taigent comment *)",
      "PowerShell(npx taigent due *)"
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
| `npm install -D github:…` fails with a git error | Install git (`git --version`), then redo step 1 |
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
- Update later with `npm install -D github:sondoquang/taigent` (the latest commit of `master`), then
  `npx taigent setup --project` (it updates the skills); commit the changed files, and teammates run `npm install`.
  Every skill setup installs carries its taigent version: setup names the skills older than it, and the skills or
  `taiga` servers installed both for you and in the project, with the copy each agent uses (it never removes one;
  [§ Setup: skill versions and duplicates](docs/cli.md#setup-skill-versions-and-duplicates)).
- Details: [docs/cli.md](docs/cli.md) (commands, credentials, manifests, exit codes) and
  [§ Login and the MCP server](docs/cli.md#login-and-the-mcp-server).

## Develop taigent

```sh
npm install
npm run taigent -- plan --project <slug>
npm run taigent -- apply --project <slug> --yes
npm test && npm run typecheck
```

In this repository `.mcp.json` and `.codex/config.toml` run `bin/taigent.js mcp`; log in with `npm run taigent -- login`.
