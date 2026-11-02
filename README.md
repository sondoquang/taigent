# taigent

Headless toolkit for driving Taiga from AI agents (Claude Code, Codex): declarative manifests in git, applied by the
`taigent` CLI with a plan → review → apply workflow, plus agent skills (`taiga-*` and the `ask-taigent` router) and
the Taiga MCP server for reading.

## Use it in your project

Needs Node.js 24+. Run everything from your project's root.

### 1. Install

```sh
npx skills add sondoquang/taigent          # the Taigent skills, into .agents/skills/ and .claude/skills/
npm install -D github:sondoquang/taigent   # the taigent CLI (append #<tag> to pin a release)
```

`npm install` puts everything in your project's `node_modules`, nothing system-wide:

| Package | Why |
|---|---|
| `taigent` (built from source on install) | the CLI and the docs the skills read |
| `taiga-mcp-server` (exact version pinned by taigent) and its dependencies | the Taiga MCP server that `taigent mcp` runs |
| `@napi-rs/keyring` (+ a small native binary for your OS) | keeps your login in the OS credential store |
| `yaml` | reads the manifests |

### 2. Log in once

In **your own terminal** (not through an agent, not with Claude Code's `!`):

```sh
npx taigent login      # Taiga URL (e.g. https://taiga.example.com), username or email, password (not shown)
npx taigent whoami     # check: prints your Taiga user and where the login is stored
```

Your password is used once and **never stored**. taigent keeps a token in the OS credential store (Windows Credential
Manager, macOS Keychain, Linux Secret Service) and a non-secret `login.json` (URL, username) in your config directory.
The token renews itself while you use taigent; after 8 days unused (Taiga's default), run `npx taigent login` again.
If your Taiga admin created an Application for taigent, `npx taigent login --application <id>` stores a token that
never expires instead. `npx taigent logout` removes the login.

No credential store (CI, headless Linux)? Set `TAIGA_API_URL`, `TAIGA_USERNAME` and `TAIGA_PASSWORD` (or `TAIGA_TOKEN`)
in the environment or a git-ignored `.env` (see `.env.example`); they take precedence over the stored login.

### 3. Connect the Taiga MCP server

No secrets in these files, so they can be committed. Claude Code: `.mcp.json`

```json
{ "mcpServers": { "taiga": { "command": "node", "args": ["node_modules/taigent/bin/taigent.js", "mcp"] } } }
```

Then start `claude` in the project, accept the `taiga` server when asked, and check `/mcp` shows it connected.

Codex: `.codex/config.toml` (read once the project is trusted)

```toml
[mcp_servers.taiga]
command = "node"
args = ["node_modules/taigent/bin/taigent.js", "mcp"]
env_vars = ["TAIGA_API_URL", "TAIGA_USERNAME", "TAIGA_PASSWORD", "TAIGA_TOKEN", "TAIGENT_CONFIG_DIR", "TAIGENT_CREDENTIAL_STORE", "XDG_CONFIG_HOME", "DBUS_SESSION_BUS_ADDRESS"]
required = true
```

`taigent mcp` runs the MCP server with your stored login; the server itself never sees your password or token.

### 4. Check it all

Run the `taiga-setup` skill (`/taiga-setup` in Claude Code, `$taiga-setup` in Codex): it checks the CLI, the login and
the MCP server, and names the fix for anything missing. Not sure which skill or step fits next? Ask `ask-taigent`
(`/ask-taigent`, `$ask-taigent`).

Details: [docs/cli.md](docs/cli.md) (commands, credentials and environment, manifest layout, JSON output, exit codes),
[§ Login and the MCP server](docs/cli.md#login-and-the-mcp-server).

## Develop taigent

```sh
npm install
npm run taigent -- plan --project <slug>
npm run taigent -- apply --project <slug> --yes
npm test && npm run typecheck
```

In this repository `.mcp.json` and `.codex/config.toml` run `bin/taigent.js mcp`; log in with `npm run taigent -- login`.
