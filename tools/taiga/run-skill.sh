#!/bin/sh
# Runs one skill headless with OMP (`omp -p`), Claude Code (`claude -p`) or Codex (`codex exec`) and the standard
# allowlist (tools/taiga/allowlist.txt). Same arguments as run-skill.ps1; see docs/headless.md.
#
#   tools/taiga/run-skill.sh [--dry-run] [--output-format json|text] <omp|claude|codex> <skill> [skill arguments...]
#
# The repository is the current directory, wherever this script lives (this repository, node_modules/taigent, or the
# copy bundled in Taigent Desktop): its .agents/skills and the allowlist `taigent init` installed there.

usage="usage: run-skill [--dry-run] [--output-format json|text] <omp|claude|codex> <skill> [skill arguments...]"

fail() {
  printf 'run-skill: %s\n' "$1" >&2
  exit 2
}

fail_usage() {
  printf 'run-skill: %s\n%s\n' "$1" "$usage" >&2
  exit 2
}

root=$(pwd) || exit 2
dry_run=false
format=json

while [ $# -gt 0 ]; do
  case $1 in
    --dry-run) dry_run=true; shift ;;
    --output-format)
      [ $# -ge 2 ] || fail_usage "--output-format needs a value"
      format=$2
      shift 2
      ;;
    -*) fail_usage "unknown option '$1'" ;;
    *) break ;;
  esac
done

case $format in
  json | text) ;;
  *) fail_usage "unknown output format '$format' (expected json or text)" ;;
esac
[ $# -ge 2 ] || fail_usage "missing agent or skill"

agent=$1
skill=$2
shift 2

case $agent in
  omp | claude | codex) ;;
  *) fail "unknown agent '$agent' (expected omp, claude or codex)" ;;
esac
case $skill in
  '' | -* | *- | *--* | *[!a-z0-9-]*) fail "unknown skill '$skill': not a directory of .agents/skills" ;;
esac
[ -f "$root/.agents/skills/$skill/SKILL.md" ] || fail "unknown skill '$skill': no .agents/skills/$skill/SKILL.md"
[ -f "$root/tools/taiga/allowlist.txt" ] ||
  fail "no tools/taiga/allowlist.txt in $root: run run-skill from the repository root (npx taigent init installs the allowlist)"
omp_guard=tools/taiga/omp-guard.mjs
if [ "$agent" = omp ] && [ ! -f "$root/$omp_guard" ]; then
  fail "no $omp_guard in $root: run npx taigent init again to install it"
fi

# Git Bash/MSYS on Windows rewrites arguments that look like POSIX paths ("/taiga-plan-backlog" becomes
# "C:/Program Files/Git/taiga-plan-backlog") when it starts a native program. Pass them through unchanged.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

IFS=' '
request="$skill${1+ $*}"
cr=$(printf '\r')

if [ "$agent" = omp ]; then
  # Print mode answers no approval prompt, so every call is approved and the guard extension is the limit: it refuses
  # every tool call but workspace file tools, the allowlist's taigent commands and its Taiga MCP read tools.
  set -- omp -p --mode "$format" --approval-mode yolo -e "$omp_guard" "/skill:$request"
elif [ "$agent" = claude ]; then
  set -- claude -p "/$request" --output-format "$format" --permission-mode acceptEdits --allowedTools
else
  set -- codex exec --sandbox workspace-write --dangerously-bypass-hook-trust
  [ "$format" = json ] && set -- "$@" --json
  tools=
fi

[ "$agent" = omp ] || while IFS= read -r rule || [ -n "$rule" ]; do
  rule=${rule%"$cr"}
  case $rule in '' | '#'*) continue ;; esac
  if [ "$agent" = claude ]; then
    set -- "$@" "$rule"
  else
    case $rule in mcp__taiga__*) tools="$tools${tools:+,}'${rule#mcp__taiga__}'" ;; esac
  fi
done <"$root/tools/taiga/allowlist.txt"

# Shell parity with Claude (docs/headless.md): the PreToolUse hook blocks every shell command but the allowlist's
# taigent commands, which .codex/rules/taigent.rules runs outside the sandbox (network to reach Taiga).
if [ "$agent" = codex ]; then
  set -- "$@" -c "approvals_reviewer='user'" -c "features.hooks=true" \
    -c "hooks.PreToolUse=[{matcher='^Bash\$',hooks=[{type='command',command='node .codex/hooks/taigent-shell-guard.mjs',timeout=30}]}]" \
    -c "mcp_servers.taiga.enabled_tools=[$tools]" -c "mcp_servers.taiga.default_tools_approval_mode='approve'" "\$$request"
fi

if [ "$dry_run" = true ]; then
  exec node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)) + "\n")' -- "$@"
fi

command -v "$agent" >/dev/null 2>&1 || fail "$agent is not installed (not found on PATH)"
cd "$root" || exit 2
exec "$@"
