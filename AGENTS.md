## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for `sondoquang/taigent` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `GLOSSARY.md` plus `docs/adr/`. See `docs/agents/domain.md`.

## Taiga setup

Each user logs in once with `npx taigent login`, in their own terminal: it stores a token in the OS credential store, never the password. Never ask for, type or write a Taiga password or token; the `taigent` CLI and the Taiga MCP server (`taigent mcp`, registered in `.mcp.json` and `.codex/config.toml`) both use that login. `TAIGA_*` variables (environment or a git-ignored `.env`) override it, for CI. To check or fix the CLI, the login or the MCP server, or to install the skills into another project, use the `taiga-setup` skill.

`package.json` pins `taiga-mcp-server` to an exact version (1.9.20), which `taiga-setup`, the `taiga-*` skills' tool notes, `docs/cli.md` and `docs/taiga/conventions.md` §10 are written against; bump them together. `npm test` fails when `.mcp.json`, `.codex/config.toml` and the entries in `taiga-setup` differ.

## Taiga conventions

Before creating or changing anything on Taiga, read `docs/taiga/conventions.md`: project name/slug, template and modules, prefixed tags, item keys, story/task templates, status names, wiki slugs, attachment names, the **banned MCP tools**, and the plan → review → apply workflow. Writes to Taiga go only through the `taigent` CLI (`docs/cli.md`); MCP is read/report/comment only. Run `taigent validate` after editing any manifest under `taiga/`.

The Taigent skills (`taiga-setup`, `taiga-plan-backlog`, `taiga-apply-backlog`, `taiga-create-user-story`, `taiga-bootstrap-project`, `taiga-upload-docs`, `taiga-status-report`, `taiga-my-tickets`, `taiga-update-ticket`, and the router `ask-taigent`) have one source: `.agents/skills/`. After editing one there, run `npx taigent skills sync` to refresh the `.claude/skills/` copy; `taigent skills check` (also run by `npm test`) fails while the copies differ. Adding, removing or changing a Taigent skill: update `ask-taigent` in the same change.

## Headless runs

Run a skill without interaction with `tools/taiga/run-skill.ps1` (PowerShell) or `tools/taiga/run-skill.sh` (sh), e.g. `.\tools\taiga\run-skill.ps1 claude taiga-status-report <slug>`; `--dry-run` prints the command only. The standard allowlist (Taiga MCP read tools + `npx taigent` commands) lives in `tools/taiga/allowlist.txt` only: never add an MCP write tool or a banned tool to it. Under `codex exec` the shell gets the same limit from the PreToolUse hook `.codex/hooks/taigent-shell-guard.mjs` (reads the allowlist) and the execpolicy rule `.codex/rules/taigent.rules` (runs the taigent commands outside the sandbox; keep its command list equal to the allowlist's). See `docs/headless.md` (also for how `codex exec` handles MCP approvals and shell commands unattended).
