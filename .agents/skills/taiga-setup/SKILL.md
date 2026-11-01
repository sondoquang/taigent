---
name: taiga-setup
description: "Taiga setup check for the taiga-* skills: TAIGA_* variables, the taigent CLI, the Taiga MCP server. Use when setting up or installing the Taiga skills on a machine or in a project, or when a taiga-* skill finds one of them missing."
allowed-tools: mcp__taiga__listProjects
---

# Taiga setup

Check the three things the `taiga-*` skills stand on, in order, and put the fix for every failing one in front of the user. Credentials stay with the user: this skill checks only whether each variable is set, never prints or writes a value, and leaves typing passwords to the user.

| Check | Needed by |
|---|---|
| 1. Node.js and `TAIGA_*` variables | `taiga-plan-backlog`, `taiga-apply-backlog`, `taiga-bootstrap-project`, `taiga-upload-docs`, `taiga-my-tickets` (through the `taigent` CLI) |
| 2. `taigent` CLI | the same five |
| 3. Taiga MCP server `taiga` | `taiga-status-report`, `taiga-plan-backlog`, `taiga-bootstrap-project` |

For `taiga-status-report` alone, check 3 decides: when it passes, the others do not matter.

## 1. Node.js and variables

Run from the project root:

```
node -e "const fs = require('fs'); const file = fs.existsSync('.env') ? require('util').parseEnv(fs.readFileSync('.env', 'utf8')) : {}; console.log('node', process.version); for (const k of ['TAIGA_API_URL', 'TAIGA_USERNAME', 'TAIGA_PASSWORD', 'TAIGA_TOKEN']) console.log(k, process.env[k] ? 'set (environment)' : file[k] ? 'set (.env)' : 'missing')"
```

Passes when Node is v24 or later and `TAIGA_API_URL`, `TAIGA_USERNAME` and `TAIGA_PASSWORD` are `set`. `TAIGA_TOKEN` is optional: `taigent` uses it in place of the username and password. `taigent` reads a variable from `.env` in the directory it runs in when the environment does not set it; the environment wins. `.env` serves the CLI only: the MCP server gets its values from check 3.

When a value comes from `.env`, also run `git check-ignore -q .env` (exit 0: ignored). If it is not ignored, the fix is a `.env` line in `.gitignore` before anything is committed.

Fix, either way (restart the terminal and the agent after changing the environment: a running agent keeps the environment it started with):

- **`.env` at the project root** (simplest): `TAIGA_API_URL=…`, `TAIGA_USERNAME=…`, `TAIGA_PASSWORD=…`, one per line, kept out of git as above.
- **Personal environment**: PowerShell `[Environment]::SetEnvironmentVariable("TAIGA_USERNAME", "<you>", "User")`, once per variable; POSIX shell `export TAIGA_USERNAME=<you>` in the shell profile.

`TAIGA_API_URL` is the API base including `/api/v1`, e.g. `https://taiga.example.com/api/v1`, with no `user:password@` in it.

## 2. taigent CLI

Run from the project root: `npx --no -- taigent --help`. `--no` restricts npx to an installed `taigent`, so it never fetches the unrelated npm package of that name.

Passes when it prints taigent's usage. The **taigent root**, holding the docs the skills cite (`docs/cli.md`, `docs/taiga/conventions.md`), is then the project root when its `package.json` `name` is `taigent`, else `node_modules/taigent/`.

Fix, by where the user works:

- **A clone of the taigent repository** (`github.com/sondoquang/taigent`): `npm install` in the clone.
- **Another project**: `npm install -D github:sondoquang/taigent` at the project root (creates `package.json` when there is none). npm builds the CLI on install; it needs read access to the repository. Append `#<tag>` to pin a release.

## 3. Taiga MCP server

Call the Taiga MCP tool `listProjects`. The skills expect the server under the name `taiga`; your agent prefixes its tools with that name (Claude Code: `mcp__taiga__listProjects`).

- **Projects listed**: passes.
- **Error from the tool** (login refused, host unreachable): the server runs with wrong values; have the user correct them where the server was registered (below). The server logs in only when a tool is called, so a server shown as connected says nothing about the credentials.
- **No such tool**: in Codex, register the server (below). In Claude Code, run `claude mcp get taiga` and fix by its result:

| `claude mcp get taiga` | Fix |
|---|---|
| `No MCP server named "taiga"` | Register the server, below |
| `Pending approval` | The user restarts Claude Code and accepts the `taiga` server when asked |
| `Rejected` (`disabledMcpjsonServers`) | The user runs `claude mcp reset-project-choices`, restarts Claude Code and accepts `taiga` |
| `Failed to connect` | Native Windows with an older Claude Code may not start `npx` directly: use `"command": "cmd", "args": ["/c", "npx", "-y", "taiga-mcp-server@1.9.20"]` |
| `Connected` | The server was added after this session started: restart Claude Code |

### Registering the server: Claude Code

**Default, one command, no approval step.** The user runs it in their own terminal, with their values, from the project root:

```
claude mcp add -s user taiga -e TAIGA_API_URL=https://taiga.example.com/api/v1 -e TAIGA_USERNAME=<you> -e TAIGA_PASSWORD=<password> -- npx -y taiga-mcp-server@1.9.20
```

`-s user` stores the entry, values included, in the user's own `~/.claude.json` (`%USERPROFILE%\.claude.json` on Windows), never in the project, and makes `taiga` available in every project; `-s local` limits it to this project. Then `claude mcp get taiga` shows `Connected`. This route needs no `.mcp.json` entry; a project `.mcp.json` that also declares `taiga` takes precedence, so leave `taiga` out of it.

**Shared through the repository.** `.mcp.json` at the project root, naming the variables only, so the file holds no secret and can be committed. Claude Code fills `${…}` from its own environment, not from `.env`: each user sets the three variables in their personal environment (check 1), restarts, and accepts the project server when asked. Show the user this entry; once they agree, merge it into `.mcp.json`, keeping the file's other entries.

```json
{
  "mcpServers": {
    "taiga": {
      "command": "npx",
      "args": ["-y", "taiga-mcp-server@1.9.20"],
      "env": {
        "TAIGA_API_URL": "${TAIGA_API_URL}",
        "TAIGA_USERNAME": "${TAIGA_USERNAME}",
        "TAIGA_PASSWORD": "${TAIGA_PASSWORD}"
      }
    }
  }
}
```

### Registering the server: Codex

`.codex/config.toml` at the project root, read once the project is trusted. Codex forwards the variables from its environment, not from `.env`: they must be in the personal environment (check 1).

```toml
[mcp_servers.taiga]
command = "npx"
args = ["-y", "taiga-mcp-server@1.9.20"]
env_vars = ["TAIGA_API_URL", "TAIGA_USERNAME", "TAIGA_PASSWORD"]
required = true
```

Keep version `1.9.20` in every entry above: the skills' tool notes and the banned-tool list of `docs/taiga/conventions.md` §10 are written against it.

## Installing the skills into another project

When the user asks for it: `npx skills add sondoquang/taigent` at the project root installs the eight Taigent skills (every `taiga-*` and `ask-taigent`) for the agents it detects, into `.agents/skills/` (Codex) and `.claude/skills/` (Claude Code); `npx skills update` refreshes them. It registers no MCP server: run the checks the table above lists for the skills they will use.

## Report

One line per check: `ok`, or what failed and its fix. Done when every check passed, or every failing check has its fix in front of the user. When a fix takes effect only after a restart (new variables, a new MCP entry, newly copied skills), say so: agents load variables, MCP servers and skills when they start.
