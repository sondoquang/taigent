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
