#!/bin/sh
# Runs one skill headless with Claude Code (`claude -p`) or Codex (`codex exec`) and the standard allowlist
# (tools/taiga/allowlist.txt). Same arguments as run-skill.ps1; see docs/headless.md.
#
#   tools/taiga/run-skill.sh [--dry-run] [--output-format json|text] <claude|codex> <skill> [skill arguments...]

usage="usage: run-skill [--dry-run] [--output-format json|text] <claude|codex> <skill> [skill arguments...]"

fail() {
  printf 'run-skill: %s\n' "$1" >&2
  exit 2
}

fail_usage() {
  printf 'run-skill: %s\n%s\n' "$1" "$usage" >&2
  exit 2
}

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd) || exit 2
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
  claude | codex) ;;
  *) fail "unknown agent '$agent' (expected claude or codex)" ;;
esac
case $skill in
  '' | -* | *- | *--* | *[!a-z0-9-]*) fail "unknown skill '$skill': not a directory of .agents/skills" ;;
esac
[ -f "$root/.agents/skills/$skill/SKILL.md" ] || fail "unknown skill '$skill': no .agents/skills/$skill/SKILL.md"

# Git Bash/MSYS on Windows rewrites arguments that look like POSIX paths ("/taiga-plan-backlog" becomes
# "C:/Program Files/Git/taiga-plan-backlog") when it starts a native program. Pass them through unchanged.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

IFS=' '
request="$skill${1+ $*}"
cr=$(printf '\r')

if [ "$agent" = claude ]; then
  set -- claude -p "/$request" --output-format "$format" --permission-mode acceptEdits --allowedTools
else
  set -- codex exec --sandbox workspace-write
  [ "$format" = json ] && set -- "$@" --json
  tools=
fi

while IFS= read -r rule || [ -n "$rule" ]; do
  rule=${rule%"$cr"}
  case $rule in '' | '#'*) continue ;; esac
  if [ "$agent" = claude ]; then
    set -- "$@" "$rule"
  else
    case $rule in mcp__taiga__*) tools="$tools${tools:+,}'${rule#mcp__taiga__}'" ;; esac
  fi
done <"$root/tools/taiga/allowlist.txt"

if [ "$agent" = codex ]; then
  set -- "$@" -c "mcp_servers.taiga.enabled_tools=[$tools]" -c "mcp_servers.taiga.default_tools_approval_mode='approve'" "\$$request"
fi

if [ "$dry_run" = true ]; then
  exec node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)) + "\n")' -- "$@"
fi

command -v "$agent" >/dev/null 2>&1 || fail "$agent is not installed (not found on PATH)"
cd "$root" || exit 2
exec "$@"
