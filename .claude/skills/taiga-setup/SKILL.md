---
name: taiga-setup
description: "Taiga setup check for the taiga-* skills: TAIGA_* variables, the taigent CLI, the Taiga MCP server. Use when setting up or installing the Taiga skills on a machine or in a project, or when a taiga-* skill finds one of them missing."
allowed-tools: mcp__taiga__listProjects
---

# Taiga setup

Check the three things the `taiga-*` skills stand on, in order, and put the fix for every failing one in front of the user. Credentials stay in the user's own environment: this skill checks only whether each variable is set, and writes no value anywhere.

| Check | Needed by |
|---|---|
| 1. Node.js and `TAIGA_*` variables | every `taiga-*` skill |
| 2. `taigent` CLI | `taiga-plan-backlog`, `taiga-apply-backlog`, `taiga-bootstrap-project`, `taiga-upload-docs` |
| 3. Taiga MCP server `taiga` | `taiga-status-report`, `taiga-plan-backlog`, `taiga-bootstrap-project` |

For `taiga-status-report` alone, check 3 decides: when it passes, the others do not matter.

## 1. Node.js and variables

Run from the project root:

```
node -e "console.log('node', process.version); for (const k of ['TAIGA_API_URL', 'TAIGA_USERNAME', 'TAIGA_PASSWORD', 'TAIGA_TOKEN']) console.log(k, process.env[k] ? 'set' : 'missing')"
```

Passes when Node is v24 or later and `TAIGA_API_URL`, `TAIGA_USERNAME` and `TAIGA_PASSWORD` are `set`. `TAIGA_TOKEN` is optional: `taigent` uses it in place of the username and password, the MCP server always needs both.

Fix: the user sets each missing variable in their personal environment, then restarts the terminal and the agent (a running agent keeps the environment it started with):

- PowerShell: `[Environment]::SetEnvironmentVariable("TAIGA_USERNAME", "<you>", "User")`, once per variable.
- POSIX shell: `export TAIGA_USERNAME=<you>` in the shell profile.

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
- **Error from the tool** (login refused, host unreachable): the server runs but its variables are wrong; fix them with check 1.
- **No such tool**: register the server. Show the user the entry for their agent; once they agree, merge it into the project file, keeping the file's other entries. Both entries name the variables only, so the files hold no secret and can be committed.

Claude Code, `.mcp.json` at the project root. After a restart Claude Code asks to approve the project server; `claude mcp list` then shows `taiga` connected.

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

Codex, `.codex/config.toml` at the project root, read once the project is trusted:

```toml
[mcp_servers.taiga]
command = "npx"
args = ["-y", "taiga-mcp-server@1.9.20"]
env_vars = ["TAIGA_API_URL", "TAIGA_USERNAME", "TAIGA_PASSWORD"]
required = true
```

Keep version `1.9.20`: the skills' tool notes and the banned-tool list of `docs/taiga/conventions.md` §10 are written against it.

## Installing the skills into another project

When the user asks for it: `npx skills add sondoquang/taigent` at the project root installs the seven Taigent skills (every `taiga-*` and `ask-taigent`) for the agents it detects, into `.agents/skills/` (Codex) and `.claude/skills/` (Claude Code); `npx skills update` refreshes them. Then run the checks the table above lists for the skills they will use.

## Report

One line per check: `ok`, or what failed and its fix. Done when every check passed, or every failing check has its fix in front of the user. When a fix takes effect only after a restart (new variables, a new MCP entry, newly copied skills), say so: agents load variables, MCP servers and skills when they start.
