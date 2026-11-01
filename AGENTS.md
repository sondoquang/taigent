## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for `sondoquang/taigent` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `GLOSSARY.md` plus `docs/adr/`. See `docs/agents/domain.md`.

## Taiga setup

Set `TAIGA_API_URL` (e.g. `https://taiga.example.com/api/v1`), `TAIGA_USERNAME`, `TAIGA_PASSWORD` (optional `TAIGA_TOKEN`) in your personal environment; see `.env.example`. Never put values in committed files.

- PowerShell: `[Environment]::SetEnvironmentVariable("TAIGA_USERNAME", "<you>", "User")` (repeat per variable, then restart the terminal).
- POSIX shell: `export TAIGA_USERNAME=<you>` in your shell profile.
- Claude Code reads `.mcp.json` (`${TAIGA_*}` placeholders). Check with `claude mcp list`.
- Codex reads `.codex/config.toml` (`env_vars`, `required = true`) once the project is trusted.
- Both pin `taiga-mcp-server@1.9.20`; bump the version in both files together.

## Taiga conventions

Before creating or changing anything on Taiga, read `docs/taiga/conventions.md`: project name/slug, template and modules, prefixed tags, item keys, story/task templates, status names, wiki slugs, attachment names, the **banned MCP tools**, and the plan → review → apply workflow. Writes to Taiga go only through the `taigent` CLI (`docs/cli.md`); MCP is read/report/comment only. Run `taigent validate` after editing any manifest under `taiga/`.

The `taiga-*` skills (`taiga-plan-backlog`, `taiga-apply-backlog`, `taiga-bootstrap-project`, `taiga-upload-docs`, `taiga-status-report`) have one source: `.agents/skills/taiga-*`. After editing one there, run `npx taigent skills sync` to refresh the `.claude/skills/` copy; `taigent skills check` (also run by `npm test`) fails while the copies differ.

## Headless runs

Run a skill without interaction with `tools/taiga/run-skill.ps1` (PowerShell) or `tools/taiga/run-skill.sh` (sh), e.g. `.\tools\taiga\run-skill.ps1 claude taiga-status-report <slug>`; `--dry-run` prints the command only. The standard allowlist (Taiga MCP read tools + `npx taigent` commands) lives in `tools/taiga/allowlist.txt` only: never add an MCP write tool or a banned tool to it. Under `codex exec` the shell gets the same limit from the PreToolUse hook `.codex/hooks/taigent-shell-guard.mjs` (reads the allowlist) and the execpolicy rule `.codex/rules/taigent.rules` (runs the taigent commands outside the sandbox; keep its command list equal to the allowlist's). See `docs/headless.md` (also for how `codex exec` handles MCP approvals and shell commands unattended).
