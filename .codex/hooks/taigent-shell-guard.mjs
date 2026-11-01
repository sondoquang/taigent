// Codex PreToolUse hook of headless runs (tools/taiga/run-skill.ps1 and run-skill.sh pass it with -c; see
// docs/headless.md). Reads the hook input (JSON on stdin) and lets a shell command through only when it is one of the
// taigent commands of tools/taiga/allowlist.txt, run on its own; any other command is blocked (exit 2, reason on
// stderr). A command that passes runs outside the sandbox through the execpolicy rule in .codex/rules/taigent.rules.
import { readFileSync } from 'node:fs';

const ALLOWLIST = new URL('../../tools/taiga/allowlist.txt', import.meta.url);
// Compound commands, redirections, substitutions, variables, globs and line breaks: the command must be plain words.
const SHELL_SYNTAX = /[;&|<>`$(){}*?\r\n]/;

function block(reason) {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

/** Prefixes of the shell rules of the allowlist: `Bash(npx taigent plan *)` gives `npx taigent plan`. */
function allowedPrefixes() {
  const prefixes = readFileSync(ALLOWLIST, 'utf8')
    .split(/\r?\n/)
    .map((line) => /^(?:Bash|PowerShell)\((.+) \*\)$/.exec(line.trim())?.[1])
    .filter((prefix) => prefix !== undefined);
  return [...new Set(prefixes)];
}

try {
  const command = JSON.parse(readFileSync(0, 'utf8'))?.tool_input?.command;
  if (typeof command !== 'string') block('Blocked: the shell command could not be read.');

  const words = command.trim().split(/\s+/);
  const prefixes = allowedPrefixes();
  const allowed =
    !SHELL_SYNTAX.test(command) && prefixes.some((prefix) => prefix.split(' ').every((word, i) => words[i] === word));
  if (!allowed) {
    const commands = prefixes.map((prefix) => `\`${prefix} ...\``).join(', ');
    block(`Blocked: headless runs allow only these commands, each run on its own: ${commands} (tools/taiga/allowlist.txt).`);
  }
} catch (error) {
  block(`Blocked: the taigent shell guard failed (${error instanceof Error ? error.message : String(error)}).`);
}
