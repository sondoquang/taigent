# Headless skill runs

`tools/taiga/run-skill.ps1` (PowerShell) and `tools/taiga/run-skill.sh` (POSIX sh, also Git Bash) run one skill
without interaction through Claude Code (`claude -p`) or Codex (`codex exec`), with the team's standard allowlist.
Both take the same arguments:

```
run-skill [--dry-run] [--output-format json|text] <claude|codex> <skill> [skill arguments...]
```

```powershell
.\tools\taiga\run-skill.ps1 claude taiga-status-report vigo-core-mapping
.\tools\taiga\run-skill.ps1 --dry-run codex taiga-plan-backlog docs/specs/auth.md
```

```sh
tools/taiga/run-skill.sh claude taiga-status-report vigo-core-mapping
tools/taiga/run-skill.sh --output-format text codex taiga-plan-backlog docs/specs/auth.md
```

| Argument | Meaning |
|---|---|
| `<claude\|codex>` | The agent CLI to start. Anything else: `unknown agent`, exit 2 |
| `<skill>` | A directory of `.agents/skills/` holding a `SKILL.md`, e.g. `taiga-status-report`. Anything else: `unknown skill`, exit 2 |
| `[skill arguments...]` | Joined with spaces after the skill name into the prompt |
| `--output-format json` (default) | Claude `--output-format json` (one JSON result); Codex `--json` (JSON Lines events) |
| `--output-format text` | Plain text: Claude `--output-format text`; Codex without `--json` |
| `--dry-run` | Print the command as a JSON array of arguments instead of running it (no agent starts) |

Options go before the agent. The agent starts in the repository root (where `.mcp.json`, `.codex/config.toml`
and the skills live) and the wrapper exits with the agent's exit code. Wrapper errors (unknown option, output
format, agent or skill; missing arguments; agent not on `PATH`) print `run-skill: <reason>` to stderr and exit 2.
Set `TAIGA_API_URL`, `TAIGA_USERNAME` and `TAIGA_PASSWORD` first (see `AGENTS.md`): both agents start the
Taiga MCP server and `taigent` with them.

## Commands built

```
claude -p "/<skill> <args>" --output-format json --allowedTools <every rule of allowlist.txt>
codex exec --sandbox workspace-write --json
  -c "mcp_servers.taiga.enabled_tools=['listProjects',…]"
  -c "mcp_servers.taiga.default_tools_approval_mode='approve'"
  "$<skill> <args>"
```

- **Claude Code** runs a skill when the prompt starts with `/<skill>`, including skills with
  `disable-model-invocation: true`. In `-p` mode a tool call that neither `--allowedTools` nor the skill's
  `allowed-tools` pre-approves is denied (listed in `permission_denials` of the JSON result); nothing waits for an
  answer. Compound shell commands (`cd … &&`, `; echo $?`) are denied too, which is why the skills run each
  `npx taigent …` command on its own.
- A skill's `allowed-tools` apply only in the turn that invoked it. The wrapper starts new sessions only; to
  answer a skill's question in a follow-up turn (`claude -p --resume <session_id> "<answer>"`), repeat
  `--allowedTools` with the rules of `tools/taiga/allowlist.txt`, or the `npx taigent …` commands of that turn
  are denied (observed with Claude Code 2.1.302 on Windows).
- **Codex** runs a skill named in the prompt as `$<skill>` (explicit invocation:
  [Build skills](https://learn.chatgpt.com/docs/build-skills); the CLI extracts `$tool-name` mentions from the
  prompt text, `codex-rs/skills/src/mentions.rs`), including skills with `allow_implicit_invocation: false`.
  `--sandbox workspace-write` lets it edit the workspace only. The two `-c` overrides expose only the allowlist's
  Taiga MCP read tools (`enabled_tools`; write and banned tools do not exist for the run) and let them run
  without approval (see below).

## The standard allowlist

`tools/taiga/allowlist.txt` is the only list; both scripts read it (one rule per line, `#` comments). It holds:

- `Bash(npx taigent <command> *)` and `PowerShell(npx taigent <command> *)` for `validate`, `plan`, `apply`,
  `bootstrap`, `upload`: writes to Taiga go through the CLI only. `apply`/`bootstrap`/`upload` still need `--yes`,
  which the skills add only after the user's explicit confirmation, so a headless run of `taiga-apply-backlog`
  stops at the plan unless its arguments carry that confirmation.
- The Taiga MCP read tools of `taiga-mcp-server@1.9.20` (`list*`, `get*`, `getMilestoneStats`,
  `getIssuesByMilestone`, `advancedSearch`, `queryHelp`, `validateQuery`) as `mcp__taiga__<tool>`.

It never holds an MCP write tool (create, update, link, batch, upload, comment, delete, assign, watch,
`authenticate`) nor a tool banned in `docs/taiga/conventions.md` §10; `test/headless.test.ts` fails if it does
(it reads the banned tools from §10). Claude gets every rule; Codex gets the MCP tool names (Codex has no
equivalent of the shell rules, see below).

## Platform notes

- **Git Bash/MSYS** would rewrite the prompt `/taiga-…` into a Windows path (`C:/Program Files/Git/taiga-…`)
  before starting `claude`; `run-skill.sh` sets `MSYS_NO_PATHCONV=1` and `MSYS2_ARG_CONV_EXCL=*` to prevent it.
  `.gitattributes` keeps `*.sh` at LF endings in Windows checkouts.
- **Windows PowerShell 5.1** mangles double quotes inside arguments passed to native programs; keep `"` out of
  skill arguments there (PowerShell 7.3+ passes them correctly). The wrapper's own arguments contain none (the
  Codex overrides use TOML single-quoted strings).

## `codex exec` and MCP approvals when unattended

Open question of spec #1. `[UNVERIFIED]`: Codex CLI is not installed on the machine where this was written, so
nothing below was run. Sources: the official docs and the `openai/codex` source (`main`, read 2026-11-01).

1. `codex exec` never asks: it sets the approval policy to `never` unless configured otherwise
   ("Default to never ask for approvals in headless mode", `codex-rs/exec/src/lib.rs`;
   [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)). MCP elicitation requests are
   answered with *cancel* (reason `non_interactive`) instead of being shown.
2. Whether an MCP tool call needs approval depends on `mcp_servers.<id>.default_tools_approval_mode` /
   `tools.<tool>.approval_mode` (`auto` default, `prompt`, `writes`, `approve`;
   [MCP](https://learn.chatgpt.com/docs/extend/mcp), [Config reference](https://learn.chatgpt.com/docs/config-file/config-reference)).
   In `auto` a tool needs approval unless it advertises `readOnlyHint` (or `destructiveHint: false` and
   `openWorldHint: false`); destructive tools always do
   ([Agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security)).
   `taiga-mcp-server@1.9.20` declares no annotations, so in `auto` **every** Taiga tool, read tools included,
   needs approval.
3. A call that needs approval under policy `never` is **denied, not left waiting**: the model gets
   "MCP tool call requires approval, but approval policy is never" (`codex-rs/core/src/mcp_tool_call.rs`).
   Only `approval_mode = "approve"`, or a sandbox with full disk write access, skips the check.
4. Hence the wrapper's overrides: `enabled_tools` = the read tools of the allowlist, and
   `default_tools_approval_mode = 'approve'` for them. The run cannot hang on a prompt, and write tools are
   not offered at all. `required = true` in `.codex/config.toml` makes `exec` exit with an error when the Taiga MCP
   server does not start. The project `.codex/config.toml` is read only when the project is trusted.
5. Shell commands: `workspace-write` has no network access by default and escalations are refused under
   `never`, so `npx taigent validate` works but `plan`/`apply`/`bootstrap`/`upload` cannot reach Taiga in a Codex
   headless run. Untested options: an execpolicy rule in `.codex/rules/*.rules` such as
   `prefix_rule(pattern = ["npx", "taigent", ["plan", "apply", "bootstrap", "upload"]], decision = "allow")`
   (runs matching commands outside the sandbox; [Rules](https://learn.chatgpt.com/docs/agent-configuration/rules)),
   or `-c sandbox_workspace_write.network_access=true` (network for every command). Verify one on a machine with
   Codex before relying on Codex for those skills.
