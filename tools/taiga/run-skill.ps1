# Runs one skill headless with Claude Code (`claude -p`) or Codex (`codex exec`) and the standard allowlist
# (tools/taiga/allowlist.txt). Same arguments as run-skill.sh; see docs/headless.md.
#
#   tools/taiga/run-skill.ps1 [--dry-run] [--output-format json|text] <claude|codex> <skill> [skill arguments...]
#
# The repository is the current directory, wherever this script lives (this repository, node_modules/taigent, or the
# copy bundled in Taigent Desktop): its .agents/skills and the allowlist `taigent init` installed there.
# No param() block on purpose: GNU-style options parse identically to the sh version.

$ErrorActionPreference = 'Stop'
$Usage = 'usage: run-skill [--dry-run] [--output-format json|text] <claude|codex> <skill> [skill arguments...]'

function Stop-Run([string]$Message, [switch]$ShowUsage) {
  [Console]::Error.WriteLine("run-skill: $Message")
  if ($ShowUsage) { [Console]::Error.WriteLine($Usage) }
  exit 2
}

$Root = (Get-Location).ProviderPath
$DryRun = $false
$Format = 'json'
$Rest = [System.Collections.Generic.List[string]]::new()
foreach ($Arg in $args) { $Rest.Add([string]$Arg) }

while ($Rest.Count -gt 0 -and $Rest[0].StartsWith('-')) {
  $Option = $Rest[0]
  $Rest.RemoveAt(0)
  if ($Option -ceq '--dry-run') { $DryRun = $true }
  elseif ($Option -ceq '--output-format') {
    if ($Rest.Count -eq 0) { Stop-Run '--output-format needs a value' -ShowUsage }
    $Format = $Rest[0]
    $Rest.RemoveAt(0)
  }
  else { Stop-Run "unknown option '$Option'" -ShowUsage }
}

if ($Format -cnotin 'json', 'text') { Stop-Run "unknown output format '$Format' (expected json or text)" -ShowUsage }
if ($Rest.Count -lt 2) { Stop-Run 'missing agent or skill' -ShowUsage }

$Agent = $Rest[0]
$Skill = $Rest[1]
$Request = (@($Skill) + @($Rest | Select-Object -Skip 2)) -join ' '

if ($Agent -cnotin 'claude', 'codex') { Stop-Run "unknown agent '$Agent' (expected claude or codex)" }
if ($Skill -cnotmatch '^[a-z0-9]+(-[a-z0-9]+)*$') { Stop-Run "unknown skill '$Skill': not a directory of .agents/skills" }
if (-not (Test-Path -LiteralPath (Join-Path $Root ".agents/skills/$Skill/SKILL.md") -PathType Leaf)) {
  Stop-Run "unknown skill '$Skill': no .agents/skills/$Skill/SKILL.md"
}
$Allowlist = Join-Path $Root 'tools/taiga/allowlist.txt'
if (-not (Test-Path -LiteralPath $Allowlist -PathType Leaf)) {
  Stop-Run "no tools/taiga/allowlist.txt in $Root`: run run-skill from the repository root (npx taigent init installs the allowlist)"
}

$Rules = @(
  Get-Content -LiteralPath $Allowlist -Encoding UTF8 |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ -and -not $_.StartsWith('#') }
)

if ($Agent -ceq 'claude') {
  $Command = @('claude', '-p', "/$Request", '--output-format', $Format, '--permission-mode', 'acceptEdits', '--allowedTools') + $Rules
}
else {
  # Shell parity with Claude (docs/headless.md): the PreToolUse hook blocks every shell command but the allowlist's
  # taigent commands, which .codex/rules/taigent.rules runs outside the sandbox (network to reach Taiga).
  $Tools = @($Rules | Where-Object { $_.StartsWith('mcp__taiga__') } | ForEach-Object { "'$($_.Substring('mcp__taiga__'.Length))'" }) -join ','
  $Command = @('codex', 'exec', '--sandbox', 'workspace-write', '--dangerously-bypass-hook-trust')
  if ($Format -ceq 'json') { $Command += '--json' }
  $Command += @(
    '-c', "approvals_reviewer='user'", '-c', 'features.hooks=true',
    '-c', "hooks.PreToolUse=[{matcher='^Bash`$',hooks=[{type='command',command='node .codex/hooks/taigent-shell-guard.mjs',timeout=30}]}]",
    '-c', "mcp_servers.taiga.enabled_tools=[$Tools]", '-c', "mcp_servers.taiga.default_tools_approval_mode='approve'", "`$$Request"
  )
}

if ($DryRun) {
  ConvertTo-Json -InputObject $Command -Compress
  exit 0
}

if (-not (Get-Command $Agent -ErrorAction SilentlyContinue)) { Stop-Run "$Agent is not installed (not found on PATH)" }
Push-Location -LiteralPath $Root
try {
  & $Command[0] @($Command | Select-Object -Skip 1)
  $Code = $LASTEXITCODE
}
finally {
  Pop-Location
}
exit $Code
