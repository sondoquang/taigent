---
name: taiga-setup
description: "Taiga setup check for the taiga-* skills: the taigent CLI, the user's Taiga login, the Taiga MCP server. Use when setting up or installing the Taiga skills on a machine or in a project, or when a taiga-* skill finds one of them missing."
allowed-tools: mcp__taiga__listProjects
---

# Taiga setup

Check the three things the `taiga-*` skills stand on, in order, and put the fix for every failing one in front of the user. Credentials stay with the user: you never ask for, type, print or write a password or token, and you never run `taigent login` yourself (it refuses without a terminal, and a password typed through you would end up in the transcript).

| Check | Needed by |
|---|---|
| 1. `taigent` CLI | every `taiga-*` skill (the MCP server runs through it too) |
| 2. Taiga login | the same |
| 3. Taiga MCP server `taiga` | `taiga-status-report`, `taiga-plan-backlog`, `taiga-bootstrap-project` |

## 1. taigent CLI

Run `node --version`, then `npx --no -- taigent --help`. npx runs the taigent the project pins (`node_modules`), else the global one (`npm i -g taigent`); `--no` keeps it from downloading one when neither is installed.

Passes when Node is v24 or later and the second command prints taigent's usage. The **taigent root**, holding the docs the skills cite (`docs/cli.md`, `docs/taiga/conventions.md`), is then the project root when its `package.json` `name` is `taigent`, else `node_modules/taigent/` when the project installs taigent, else the global install (the `taigent` folder in the directory `npm root -g` prints).

Fix, by where the user works:

- **Any machine (the default)**: `npm i -g taigent` (the CLI from npm, already built), then `taigent setup` once (below): the skills and the MCP server for every project.
- **A project whose team pins taigent**: at the project root `npx taigent setup --project` (below), then `npm install`.
- **A clone of the taigent repository** (`github.com/sondoquang/taigent`): `npm install` in the clone.

## 2. Taiga login

Run `npx taigent whoami`.

- **Prints `User: …`**: passes. Its `Credentials:` line says what taigent uses: the stored login, or `TAIGA_*` variables from the environment or `.env`, which take precedence.
- **`not logged in to Taiga`**: the user runs, **in their own terminal window** (not through you, not with Claude Code's `!`):

  ```
  npx taigent login
  ```

  It asks for the Taiga API URL (e.g. `https://taiga.example.com/api/v1`; a bare host gets `/api/v1`), the username or email, and the password (not shown). It keeps a refresh token in the OS credential store (Windows Credential Manager, macOS Keychain, Linux Secret Service), never the password. When the instance admin created an Application for taigent in Django admin (`/admin/` → Applications) and gave its id, `npx taigent login --application <id>` stores a non-expiring application token instead.
- **`expired or was revoked`**: the refresh token went unused for its lifetime (8 days by default); the user runs `npx taigent login` again.
- **`cannot use the …` credential store**: unlock it. On a machine without one (headless Linux, CI), set `TAIGENT_CREDENTIAL_STORE=file` (a 0600 JSON file in the config directory), or set `TAIGA_API_URL`, `TAIGA_USERNAME` and `TAIGA_PASSWORD` (or `TAIGA_TOKEN`) in the environment or in a git-ignored `.env`.
- **`TAIGA_API_URL is …, but the stored login is for …`**: unset that `TAIGA_API_URL` (often in `.env`), or log in to that instance.

When `.env` holds `TAIGA_PASSWORD`, run `git check-ignore -q .env` (exit 0: ignored); if it is not ignored, the fix is a `.env` line in `.gitignore` before anything is committed. Once the user has logged in, suggest deleting `TAIGA_PASSWORD` from `.env` and from their environment.

## 3. Taiga MCP server

Call the Taiga MCP tool `listProjects`. The skills expect the server under the name `taiga`; your agent prefixes its tools with that name (Claude Code: `mcp__taiga__listProjects`).

- **Projects listed**: passes.
- **Error from the tool**: fix check 2 first; the server acts as the same login.
- **No such tool**: register the server (below). In Claude Code, run `claude mcp get taiga` first and fix by its result:

| `claude mcp get taiga` | Fix |
|---|---|
| `No MCP server named "taiga"` | Register the server, below |
| `Pending approval` | A project `.mcp.json` server: the user restarts Claude Code and accepts the `taiga` server when asked |
| `Rejected` (`disabledMcpjsonServers`) | The user runs `claude mcp reset-project-choices`, restarts Claude Code and accepts `taiga` |
| `Failed to connect` | Run `npx taigent mcp` in a terminal: its error says what is missing (usually check 1 or 2). Ctrl+C ends it |
| `Connected` | The server was added after this session started: restart Claude Code |

An older entry that starts `npx -y taiga-mcp-server@…` with `TAIGA_*` values is replaced by the one below; `taigent setup` replaces a user-scope one itself.

### Registering the server: user scope (default)

`taigent setup` writes the `taiga` server into the user config of every client it finds in the home directory, next to the Taigent skills, and keeps the file's other servers and keys: `mcpServers.taiga` of `~/.claude.json` (Claude Code, no approval step) and of `~/.omp/agent/mcp.json` (OMP):

```json
{
  "mcpServers": {
    "taiga": {
      "type": "stdio",
      "command": "taigent",
      "args": ["mcp"]
    }
  }
}
```

and the `[mcp_servers.taiga]` table of `~/.codex/config.toml` (Codex), where `env_vars` forwards the variables taigent may need when the user sets them (Codex passes a stdio server only a few):

```toml
[mcp_servers.taiga]
command = "taigent"
args = ["mcp"]
env_vars = ["TAIGA_API_URL", "TAIGA_USERNAME", "TAIGA_PASSWORD", "TAIGA_TOKEN", "TAIGENT_CONFIG_DIR", "TAIGENT_CREDENTIAL_STORE", "XDG_CONFIG_HOME", "DBUS_SESSION_BUS_ADDRESS"]
required = true
```

### Registering the server: project scope

`taigent setup --project` writes the same server, run from the project's `node_modules`, into `.mcp.json` (Claude Code; each user accepts the project server once, when Claude Code asks at startup) and `.codex/config.toml` (Codex, read once the project is trusted) at the project root, keeping the files' other entries. They hold no secret, so they are committed. To add one by hand instead, show the user the entry; once they agree, merge it in.

```json
{
  "mcpServers": {
    "taiga": {
      "command": "node",
      "args": ["node_modules/taigent/bin/taigent.js", "mcp"]
    }
  }
}
```

```toml
[mcp_servers.taiga]
command = "node"
args = ["node_modules/taigent/bin/taigent.js", "mcp"]
env_vars = ["TAIGA_API_URL", "TAIGA_USERNAME", "TAIGA_PASSWORD", "TAIGA_TOKEN", "TAIGENT_CONFIG_DIR", "TAIGENT_CREDENTIAL_STORE", "XDG_CONFIG_HOME", "DBUS_SESSION_BUS_ADDRESS"]
required = true
```

`taigent mcp` runs the `taiga-mcp-server` version pinned in taigent's `package.json` (1.9.20): the skills' tool notes and the banned-tool list of `docs/taiga/conventions.md` §10 are written against it.

## Installing Taigent

**For the user, in every project: `taigent setup`.** It finds Claude Code (`~/.claude/` or `~/.claude.json`), Codex (`~/.codex/`) and OMP (`~/.omp/`) in the home directory and installs, from the running taigent, the Taigent skills (every `taiga-*`, `prd-to-taiga` and `ask-taigent`) into each one's user skills directory, `~/.claude/skills/` (Claude Code) and `~/.agents/skills/` (Codex; OMP reads it too), and the user-scope `taiga` server above. A client it does not find is skipped, with the reason. Run `npx taigent setup --dry-run` (exit 3 lists the files under `~/` it would create, update or remove; exit 0: nothing to do), show the user that list, and once they agree run `npx taigent setup`. Exit 2 names a client config it cannot merge (not valid JSON/TOML): the user fixes that file, then setup runs again.

**For a project's team: `taigent setup --project`**, at the project root. It installs the Taigent skills into `.agents/skills/` (Codex) and `.claude/skills/` (Claude Code), the project-scope `taiga` entries above in `.mcp.json` and `.codex/config.toml`, the headless kit (`tools/taiga/allowlist.txt`, `tools/taiga/omp-guard.mjs`, `.codex/hooks/taigent-shell-guard.mjs`, `.codex/rules/taigent.rules`), the `.gitignore` lines of the local copies (`taiga/*/preview.md`, `taiga/*/.preview/`, `taiga/*/snapshot.json`), and `taigent` in `devDependencies`, pinned to the installed version (its npm version). Run `npx taigent setup --project --dry-run`, show the list, and once the user agrees run `npx taigent setup --project`, then `npm install`. Exit 2 names a `.mcp.json`, `.codex/config.toml` or `package.json` it cannot merge. The files it wrote are committed with the project.

Both keep other skills, MCP servers, keys and dependencies and never run `npm install`. After writing the files they check the login (as `whoami`) and the MCP server (`taigent mcp` answering `listProjects`); `--json` reports them as `login` (`source`: `stored`, `environment` or `missing`; `status`: `ok`, `failed` or `skipped`) and `mcp`. Run by you (no terminal), they never ask for a password: without a login, `login.status` is `skipped`, the checks are skipped and the exit is 0; the fix is the user running `taigent login` (or `taigent setup` itself) in their own terminal. Exit 5 names the check that failed (Taiga refused the login, or the MCP server did not answer); its fix is the login or MCP fix above. `--dry-run` neither logs in nor checks. After a taigent upgrade, running them again updates the skills and removes the ones taigent no longer ships.

## Report

One line per check: `ok`, or what failed and its fix. Done when every check passed, or every failing check has its fix in front of the user. When a fix takes effect only after a restart (a new MCP entry, newly copied skills), say so: agents load MCP servers and skills when they start. A new login needs no restart.
