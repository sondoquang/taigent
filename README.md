# taigent

Headless toolkit for driving Taiga from AI agents (Claude Code, Codex): declarative manifests in git, applied by the
`taigent` CLI with a plan → review → apply workflow, plus agent skills (`taiga-*` and the `ask-taigent` router) and
the Taiga MCP server for reading.

## Use it in your project

Five steps, a few minutes. You need **Node.js 24 or later** (`node --version`) and a Taiga account. Run every command
from your project's root folder.

### 1. Install

```sh
npx skills add sondoquang/taigent
npm install -D github:sondoquang/taigent
```

The first command adds the eight Taigent skills to `.agents/skills/` (Codex) and `.claude/skills/` (Claude Code);
pick your agents when it asks. The second installs the `taigent` CLI and the Taiga MCP server into `node_modules`
(nothing system-wide) and creates `package.json` if the project has none.

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

**Claude Code.** Create `.mcp.json` in the project root (or add the `taiga` entry to the one you have):

```json
{ "mcpServers": { "taiga": { "command": "node", "args": ["node_modules/taigent/bin/taigent.js", "mcp"] } } }
```

Start `claude` in the project and answer **yes** when it asks to use the `taiga` server. `/mcp` then shows `taiga`
as connected.

**Codex.** Create `.codex/config.toml` in the project root; Codex reads it once you trust the project:

```toml
[mcp_servers.taiga]
command = "node"
args = ["node_modules/taigent/bin/taigent.js", "mcp"]
env_vars = ["TAIGA_API_URL", "TAIGA_USERNAME", "TAIGA_PASSWORD", "TAIGA_TOKEN", "TAIGENT_CONFIG_DIR", "TAIGENT_CREDENTIAL_STORE", "XDG_CONFIG_HOME", "DBUS_SESSION_BUS_ADDRESS"]
required = true
```

Neither file holds a password, so commit them: teammates then skip this step.

### 4. Check everything

In your agent, run `/taiga-setup` (Claude Code) or `$taiga-setup` (Codex). It checks the CLI, your login and the MCP
server: three `ok` means you are done. Anything else comes with the fix.

### 5. Try it

Ask for your tickets with `/taiga-my-tickets` (e.g. `/taiga-my-tickets October`). Not sure which skill fits? Ask
`/ask-taigent` (`$ask-taigent` in Codex).

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

### Good to know

- Your password is used once and **never stored**. taigent keeps a token in your OS credential store (Windows
  Credential Manager, macOS Keychain, Linux Secret Service); it renews itself while you use taigent.
  `npx taigent logout` removes it.
- Your Taiga admin can create an Application for taigent: `npx taigent login --application <id>` then stores a token
  that never expires.
- No credential store (CI, headless Linux)? Set `TAIGA_API_URL`, `TAIGA_USERNAME` and `TAIGA_PASSWORD` (or
  `TAIGA_TOKEN`) in the environment or a git-ignored `.env` (see `.env.example`). They take precedence over the stored
  login.
- Update later with `npx skills update` and `npm install -D github:sondoquang/taigent` (append `#<tag>` to pin a
  release).
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
