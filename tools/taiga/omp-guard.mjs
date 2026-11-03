// OMP extension of headless runs (tools/taiga/run-skill.ps1 and run-skill.sh load it with -e; see docs/headless.md):
// the same limits as Claude Code's --allowedTools under acceptEdits. Every tool call is blocked unless it is
// - a workspace file tool (read, search, edit, write; a write to an `xd://` device only for an allowed MCP tool);
// - a shell command the Codex shell guard (.codex/hooks/taigent-shell-guard.mjs) lets through: one of the taigent
//   commands of tools/taiga/allowlist.txt, run on its own, as a finite command (no supervised service);
// - one of the allowlist's Taiga MCP read tools.
// Anything else (eval, subagents, browser, web, MCP write tools) is refused with the reason, so the run cannot hang
// on it. A handler error blocks the call (OMP fails closed on tool_call errors).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ALLOWLIST = new URL('./allowlist.txt', import.meta.url);
const SHELL_GUARD = fileURLToPath(new URL('../../.codex/hooks/taigent-shell-guard.mjs', import.meta.url));
const FILE_TOOLS = new Set(['read', 'grep', 'glob', 'find', 'ast_grep', 'edit', 'ast_edit', 'write', 'todo', 'resolve']);

/** OMP's names of the allowlist's MCP tools: `mcp__taiga__listProjects` is registered as `mcp__taiga_listprojects`. */
function mcpTools() {
  const names = readFileSync(ALLOWLIST, 'utf8')
    .split(/\r?\n/)
    .map((line) => /^mcp__taiga__(\w+)$/.exec(line.trim())?.[1])
    .filter((name) => name !== undefined)
    .map((name) => `mcp__taiga_${name.toLowerCase()}`);
  return new Set(names);
}

/** The Codex shell guard's verdict on `command`: undefined when allowed, else its reason. */
function shellVerdict(command) {
  const run = spawnSync('node', [SHELL_GUARD], { input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8' });
  if (run.status === 0) return undefined;
  return run.stderr.trim() || `Blocked: the taigent shell guard failed (${run.error?.message ?? `exit ${run.status}`}).`;
}

function verdict(name, input, allowedMcp) {
  if (allowedMcp.has(name)) return undefined;
  if (name === 'bash') {
    if (typeof input.command !== 'string') return 'Blocked: the shell command could not be read.';
    if (input.name) return 'Blocked: headless runs do not start supervised services.';
    return shellVerdict(input.command);
  }
  if (name === 'write' && typeof input.path === 'string' && input.path.startsWith('xd://')) {
    const device = input.path.slice('xd://'.length).split(/[/?#]/, 1)[0];
    return allowedMcp.has(device) ? undefined : `Blocked: headless runs may only call the Taiga MCP read tools of tools/taiga/allowlist.txt, not xd://${device}.`;
  }
  if (FILE_TOOLS.has(name)) return undefined;
  return `Blocked: headless runs allow only workspace file tools, the taigent commands and the Taiga MCP read tools of tools/taiga/allowlist.txt, not ${name}.`;
}

export default function taigentGuard(pi) {
  const allowedMcp = mcpTools();
  pi.on('tool_call', async (event) => {
    const reason = verdict(event.toolName, event.input ?? {}, allowedMcp);
    return reason === undefined ? undefined : { block: true, reason };
  });
}
