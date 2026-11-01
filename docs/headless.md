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
| `--output-format json` (default) | Claude `--output-format json` (Claude Code 2.1.302 prints a JSON array of the session's messages; the last, `"type": "result"`, holds `result`, `is_error` and `permission_denials`); Codex `--json` (JSON Lines events) |
| `--output-format text` | Plain text: Claude `--output-format text`; Codex without `--json` |
| `--dry-run` | Print the command as a JSON array of arguments instead of running it (no agent starts) |

Options go before the agent. The agent starts in the repository root (where `.mcp.json`, `.codex/config.toml`
and the skills live) and the wrapper exits with the agent's exit code. Wrapper errors (unknown option, output
format, agent or skill; missing arguments; agent not on `PATH`) print `run-skill: <reason>` to stderr and exit 2.
Set `TAIGA_API_URL`, `TAIGA_USERNAME` and `TAIGA_PASSWORD` first (the `taiga-setup` skill checks them): both agents
start the Taiga MCP server and `taigent` with them.

## Commands built

```
claude -p "/<skill> <args>" --output-format json --permission-mode acceptEdits --allowedTools <every rule of allowlist.txt>
codex exec --sandbox workspace-write --dangerously-bypass-hook-trust --json
  -c "approvals_reviewer='user'"
  -c "features.hooks=true"
  -c "hooks.PreToolUse=[{matcher='^Bash$',hooks=[{type='command',command='node .codex/hooks/taigent-shell-guard.mjs',timeout=30}]}]"
  -c "mcp_servers.taiga.enabled_tools=['listProjects',…]"
  -c "mcp_servers.taiga.default_tools_approval_mode='approve'"
  "$<skill> <args>"
```

- **Claude Code** runs a skill when the prompt starts with `/<skill>`, including skills with
  `disable-model-invocation: true`. `--permission-mode acceptEdits` mirrors Codex's `workspace-write`: file
  edits in the workspace pass, and any other tool call that neither `--allowedTools` nor the skill's
  `allowed-tools` pre-approves is denied (listed in `permission_denials` of the JSON result); nothing waits for
  an answer. The mode is pinned because a personal default can widen the run: with `"auto"` (the classifier
  mode) an unlisted `npx taigent skills check` ran, with `acceptEdits` it was denied (Claude Code 2.1.302,
  Windows). Compound shell commands (`cd … &&`, `; echo $?`) are denied too, which is why the skills run each
  `npx taigent …` command on its own.
- A skill's `allowed-tools` apply only in the turn that invoked it. The wrapper starts new sessions only; to
  answer a skill's question in a follow-up turn (`claude -p --resume <session_id> "<answer>"`), repeat
  `--allowedTools` with the rules of `tools/taiga/allowlist.txt`, or the `npx taigent …` commands of that turn
  are denied (observed with Claude Code 2.1.302 on Windows).
- **Codex** runs a skill named in the prompt as `$<skill>` (explicit invocation:
  [Build skills](https://learn.chatgpt.com/docs/build-skills); the CLI extracts `$tool-name` mentions from the
  prompt text, `codex-rs/skills/src/mentions.rs`), including skills with `allow_implicit_invocation: false`.
  `--sandbox workspace-write` lets it edit the workspace only. The last two `-c` overrides expose only the
  allowlist's Taiga MCP read tools (`enabled_tools`; write and banned tools do not exist for the run) and let them
  run without approval (see [MCP approvals](#codex-exec-and-mcp-approvals-when-unattended)). The hook, the
  committed `.codex/rules/taigent.rules` and the other flags limit the shell to the allowlist's `npx taigent`
  commands and give those network access (see [shell commands](#codex-exec-and-shell-commands-when-unattended)).

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
(it reads the banned tools from §10). Claude gets every rule. Codex gets the MCP tool names as `enabled_tools`;
for the shell, its PreToolUse hook reads the `Bash(…)`/`PowerShell(…)` rules of the file on every command, and
`.codex/rules/taigent.rules` repeats the five taigent commands in Codex's rule language, which cannot read
files (`test/headless.test.ts` fails when the two lists differ).

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

## `codex exec` and shell commands when unattended

Spec #1 asks that a headless run allow only MCP read tools and the `taigent` CLI on both agents. Without the
mechanisms below, `codex exec --sandbox workspace-write` runs **any** shell command (inside the sandbox) and none
can reach Taiga (no network in `workspace-write`). `[UNVERIFIED]`: Codex CLI is not installed on the machine where
this was written, so nothing in this section was run; it rests on the official docs and the `openai/codex` source
(`main` at `67f0994b`, 2026-10-31). The hook script and the rule/allowlist agreement are tested
(`test/headless.test.ts`); Codex loading and applying them is not.

How Codex decides a shell command under `codex exec`:

1. The approval policy is `never`: exec passes it as a harness override, which wins over `-c approval_policy`
   (`codex-rs/exec/src/lib.rs`, `ConfigOverrides { approval_policy: Some(AskForApproval::Never) }`;
   `codex-rs/core/src/config/mod.rs`, `approval_policy_override.or(cfg.approval_policy)`). Only a resolved
   `approvals_reviewer = "auto_review"` makes exec rebuild the config without that override
   (`build_exec_config`); the wrapper pins `-c approvals_reviewer='user'` so a personal config cannot switch the run
   to the reviewer subagent ([Config reference](https://learn.chatgpt.com/docs/config-file/config-reference):
   `approvals_reviewer`). `approval_policy = "untrusted"` (prompt for every command no rule allows) cannot be set:
   Codex rejects it ("no longer supported", same reference and `config/mod.rs`).
2. Execpolicy rules ([Rules](https://learn.chatgpt.com/docs/agent-configuration/rules)): `.rules` files under
   `rules/` of every active config layer; the project's `.codex/rules/` loads only when the project is trusted
   (`codex-rs/core/src/exec_policy.rs`, `policy_files`). A matching `decision = "allow"` rule runs the command
   **outside the sandbox** without prompting (`Decision::Allow` → `ExecApprovalRequirement::Skip { bypass_sandbox:
   true }`, then `SandboxOverride::BypassSandboxFirstAttempt` in `codex-rs/core/src/tools/sandboxing.rs`), so it has
   network access. `.codex/rules/taigent.rules` allows `npx taigent validate|plan|apply|bootstrap|upload …`; its
   `match`/`not_match` examples are checked by Codex when it loads the file.
3. A command that **no rule matches** is decided by `render_decision_for_unmatched_command_for_platform`
   (`exec_policy.rs`): under `never` it is *allowed* inside the sandbox unless flagged dangerous. Rules cannot
   express "everything else": a `pattern` is a non-empty list of literal tokens or unions of literals, with no
   wildcard (`codex-rs/execpolicy/src/parser.rs`, `parse_pattern_token`). So rules alone cannot refuse other
   commands; a `prompt` or `forbidden` rule only covers the prefixes it names.
4. Hence the PreToolUse hook ([Hooks](https://learn.chatgpt.com/docs/hooks)): Codex runs it before every shell
   command (tool name `Bash`, also for `exec_command` and on Windows; `tool_input.command` is the command line,
   `codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs`). `.codex/hooks/taigent-shell-guard.mjs` reads
   `tools/taiga/allowlist.txt` and exits 0 only for a command that starts with one of its taigent prefixes and holds
   plain words (none of ``; & | < > $ ` ( ) { } * ?`` nor a line break); otherwise it exits 2 with the reason on stderr,
   which blocks the call and returns the reason to the model (`codex-rs/hooks/src/events/pre_tool_use.rs`). Like
   Claude Code, compound commands are refused, so the skills keep running each `npx taigent …` on its own.

The wrapper passes the hook on the command line, so it applies to headless runs only, not to interactive Codex
sessions in this repository:

- `-c hooks.PreToolUse=[…]`: inline hooks use the `config.toml` `[hooks]` schema (`matcher`, `hooks[].type`,
  `command`, `timeout`; Config reference: `hooks`, `hooks.<Event>`, `hooks.<Event>[].hooks`;
  `codex-rs/protocol/src/hooks.rs`), and Codex discovers hooks in the `-c` (session flags) layer too
  (`codex-rs/hooks/src/engine/discovery.rs`). A `-c` value that is not valid TOML silently becomes a string
  (`codex-rs/utils/cli/src/config_override.rs`), so the value is kept to TOML single-quoted strings; Codex runs
  the command with the session shell from the session directory, which the wrapper sets to the repository root
  (`codex-rs/hooks/src/engine/command_runner.rs`).
- `--dangerously-bypass-hook-trust`: non-managed hooks run only once trusted through `/hooks`, and a hook from `-c`
  cannot be trusted that way; the flag runs enabled hooks "without requiring persisted hook trust for that
  invocation", meant for automation that vets hook sources itself (Hooks guide; `codex-rs/utils/cli/src/shared_options.rs`).
  Here the only hook source is this repository's reviewed script. The flag also lets the user's own enabled
  hooks run untrusted in that run.
- `-c features.hooks=true`: hooks are on by default, but a personal `features.hooks = false` would silently drop
  the guard (Config reference: `features.hooks`; `codex-rs/features/src/lib.rs`).

Rejected: `-c sandbox_workspace_write.network_access=true` (Config reference) would give every command network,
and `npx` would stay inside the sandbox, where writes outside the workspace (such as its cache) fail
`[INFERENCE]`; `--ignore-rules` ([Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode))
would drop the project rule.

Limits, by the sources above:

- Everything under `.codex/` (MCP server, rules) needs a trusted project; untrusted, the hook still blocks
  non-taigent commands, but taigent runs inside the sandbox and cannot reach Taiga.
- Hooks fail open: a hook that cannot start, times out (30 s) or exits with another code than 0 or 2 is reported
  as failed and the command goes on (`pre_tool_use.rs`); the Hooks guide calls tool hooks "a useful guardrail, not
  a complete enforcement boundary". The script turns its own errors into exit 2, and an unmatched command that
  slips through still runs inside the sandbox without network.
- User-level rules still apply (stricter ones win; an `allow` rule only matters for commands the hook let through).
- `[UNVERIFIED]` live behaviour: that Codex loads `.codex/rules/taigent.rules` and the `-c` hook as described, that
  allowed `npx taigent` commands reach Taiga (including through the Windows sandbox and PowerShell lowering,
  `codex-rs/shell-command/src/powershell.rs`), and the exact message the model gets for a blocked command. Check
  on a machine with Codex: `codex execpolicy check --rules .codex/rules/taigent.rules -- npx taigent plan --project
  x` should print `"decision":"allow"`, and a headless run whose skill asks for `npm test` should report it blocked.
