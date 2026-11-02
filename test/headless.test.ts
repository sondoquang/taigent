import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Headless wrapper: tools/taiga/run-skill.ps1 and run-skill.sh build one `claude -p` / `codex exec` command from
// the shared allowlist (tools/taiga/allowlist.txt). Tests only use `--dry-run`, which prints the command (a JSON
// array of arguments) instead of launching an agent. Codex's shell parity lives in .codex/rules/taigent.rules
// (execpolicy) and .codex/hooks/taigent-shell-guard.mjs (PreToolUse hook), both checked here against the allowlist.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ALLOWLIST = join(REPO_ROOT, 'tools/taiga/allowlist.txt');
const CODEX_RULES = join(REPO_ROOT, '.codex/rules/taigent.rules');
const SHELL_GUARD = '.codex/hooks/taigent-shell-guard.mjs';
const GUARD_HOOK = `hooks.PreToolUse=[{matcher='^Bash$',hooks=[{type='command',command='node ${SHELL_GUARD}',timeout=30}]}]`;

/** Taiga MCP tools that only read (taiga-mcp-server@1.9.20). */
const MCP_READ_TOOLS = [
  'listProjects', 'getProject', 'listEpics', 'getEpic', 'listUserStories', 'getUserStory', 'listIssues', 'getIssue',
  'listMilestones', 'getMilestone', 'getMilestoneStats', 'getIssuesByMilestone', 'listComments', 'listAttachments',
  'listWikiPages', 'getWikiPage', 'advancedSearch', 'queryHelp', 'validateQuery',
];

/** Every other tool of taiga-mcp-server@1.9.20: it writes, logs in, or is banned (conventions §10). */
const MCP_WRITE_TOOLS = [
  'addComment', 'addIssueToSprint', 'assignIssue', 'assignUserStoryToSprint', 'authenticate', 'batchCreateIssues',
  'batchCreateTasks', 'batchCreateUserStories', 'createEpic', 'createIssue', 'createMilestone', 'createTask',
  'createUserStory', 'createWikiPage', 'deleteAttachment', 'deleteComment', 'deleteWikiPage', 'downloadAttachment',
  'editComment', 'linkStoryToEpic', 'unlinkStoryFromEpic', 'updateEpic', 'updateIssueStatus', 'updateUserStoryStatus',
  'updateWikiPage', 'uploadAttachment', 'watchWikiPage',
];

const TAIGENT_COMMANDS = ['validate', 'plan', 'apply', 'bootstrap', 'upload', 'tickets', 'status', 'comment'];

async function readAllowlist(): Promise<string[]> {
  return (await readFile(ALLOWLIST, 'utf8'))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/** Tool names in the first column of the banned-tools table, section 10 of docs/taiga/conventions.md. */
async function bannedTools(): Promise<string[]> {
  const doc = await readFile(join(REPO_ROOT, 'docs/taiga/conventions.md'), 'utf8');
  const section = /^## 10\..*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(doc)?.[1] ?? '';
  const rows = section.split(/\r?\n/).filter((line) => line.startsWith('| `'));
  return rows.flatMap((row) => [...row.split('|')[1]!.matchAll(/`([A-Za-z]+)`/g)].map((match) => match[1]!));
}

test('the headless allowlist pre-approves Taiga MCP read tools and taigent commands only', async () => {
  const rules = await readAllowlist();
  const banned = await bannedTools();
  assert.ok(banned.includes('linkStoryToEpic') && banned.includes('batchCreateTasks') && banned.includes('deleteAttachment'), banned.join(', '));

  const mcp = rules.filter((rule) => rule.startsWith('mcp__'));
  assert.deepEqual(new Set(mcp), new Set(MCP_READ_TOOLS.map((tool) => `mcp__taiga__${tool}`)));
  for (const tool of [...MCP_WRITE_TOOLS, ...banned]) assert.ok(!mcp.includes(`mcp__taiga__${tool}`), `allowlist has ${tool}`);

  const shell = rules.filter((rule) => !rule.startsWith('mcp__'));
  assert.deepEqual(shell, [
    ...TAIGENT_COMMANDS.map((command) => `Bash(npx taigent ${command} *)`),
    ...TAIGENT_COMMANDS.map((command) => `PowerShell(npx taigent ${command} *)`),
  ]);
});

test('the Codex execpolicy rule allows exactly the taigent commands of the allowlist', async () => {
  const rules = await readFile(CODEX_RULES, 'utf8');
  const patterns = [...rules.matchAll(/^\s*pattern = (.+),$/gm)].map((match) => JSON.parse(match[1]!) as unknown);
  const commands = (await readAllowlist()).flatMap((rule) => /^(?:Bash|PowerShell)\(npx taigent (\w+) \*\)$/.exec(rule)?.[1] ?? []);

  assert.deepEqual(patterns, [['npx', 'taigent', [...new Set(commands)]]]);
  assert.equal([...rules.matchAll(/prefix_rule\(/g)].length, 1, 'one prefix_rule only');
  assert.match(rules, /decision = "allow"/);
});

async function runGuard(stdin: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [join(REPO_ROOT, SHELL_GUARD)], { cwd: REPO_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  child.stdin.end(stdin);
  const [code] = (await once(child, 'close')) as [number | null];
  return { code, stdout, stderr };
}

const hookInput = (command: unknown): string =>
  JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: REPO_ROOT });

test('the Codex shell guard lets through the allowlist taigent commands, run on their own', async () => {
  for (const command of [
    ...TAIGENT_COMMANDS.map((name) => `npx taigent ${name} --project vigo-auth`),
    'npx taigent apply --project vigo-auth --yes',
    '  npx  taigent plan --project "vigo auth" --json ',
    'npx taigent validate',
  ]) {
    const result = await runGuard(hookInput(command));
    assert.deepEqual(result, { code: 0, stdout: '', stderr: '' }, command);
  }
});

test('the Codex shell guard blocks every other command (exit 2 with the reason on stderr)', async () => {
  for (const command of [
    'npm test',
    'npx taigent skills check',
    'npx -y taigent plan --project vigo-auth',
    'npx taigentx plan',
    'echo npx taigent plan',
    'npx taigent plan --project vigo-auth && rm -rf ~',
    'npx taigent plan --project vigo-auth; Remove-Item -Recurse .',
    'npx taigent plan --project vigo-auth | tee out.txt',
    'npx taigent plan --project vigo-auth > out.txt',
    'npx taigent plan --project $(whoami)',
    'npx taigent plan --project `whoami`',
    'npx taigent plan --project $env:TAIGA_PASSWORD',
    'npx taigent plan --project vigo-auth\nrm -rf ~',
    'npx taigent upload --project vigo-auth docs/*',
    '',
  ]) {
    const result = await runGuard(hookInput(command));
    assert.equal(result.code, 2, JSON.stringify(command));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Blocked: headless runs allow only these commands, each run on its own: `npx taigent validate \.\.\.`, `npx taigent plan \.\.\.`/);
  }
  for (const stdin of [hookInput(['npx', 'taigent', 'plan']), JSON.stringify({ tool_input: {} }), 'not json']) {
    const result = await runGuard(stdin);
    assert.equal(result.code, 2, stdin);
    assert.match(result.stderr, /^Blocked: /);
  }
});

interface Shell {
  name: string;
  command: string;
  args: string[];
}

const SHELLS: Shell[] = [
  {
    name: 'PowerShell',
    command: process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(REPO_ROOT, 'tools/taiga/run-skill.ps1')],
  },
  { name: 'sh', command: 'sh', args: [join(REPO_ROOT, 'tools/taiga/run-skill.sh')] },
];

function available(shell: Shell): boolean {
  return !spawnSync(shell.command, shell.name === 'sh' ? ['-c', 'exit 0'] : ['-NoProfile', '-Command', 'exit 0']).error;
}

interface ScriptResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runScript(shell: Shell, args: string[]): Promise<ScriptResult> {
  const child = spawn(shell.command, [...shell.args, ...args], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const [code] = (await once(child, 'close')) as [number | null];
  return { code, stdout, stderr };
}

/** The command a `--dry-run` prints: a JSON array of arguments. */
async function dryRun(shell: Shell, args: string[]): Promise<string[]> {
  const result = await runScript(shell, ['--dry-run', ...args]);
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout) as string[];
}

for (const shell of SHELLS) {
  const skip = available(shell) ? false : `${shell.command} is not installed`;

  // acceptEdits: workspace edits pass, every other tool needs the allowlist (else denied in -p), whatever the
  // user's default mode (e.g. `auto`, which would let unlisted commands run) says.
  test(`${shell.name}: claude runs the skill as a slash command, edits allowed, other tools only from the allowlist`, { skip }, async () => {
    const command = await dryRun(shell, ['claude', 'taiga-plan-backlog', 'docs/specs/auth.md', 'for vigo-auth']);

    assert.deepEqual(command, [
      'claude', '-p', '/taiga-plan-backlog docs/specs/auth.md for vigo-auth',
      '--output-format', 'json',
      '--permission-mode', 'acceptEdits',
      '--allowedTools', ...(await readAllowlist()),
    ]);
  });

  // codex exec runs with approval policy `never`: the hook blocks non-allowlist shell commands, the execpolicy rule
  // runs the taigent ones outside the sandbox, and approvals_reviewer/features.hooks are pinned against personal config.
  test(`${shell.name}: codex exec mentions the skill, limits the shell to taigent and exposes only the MCP read tools`, { skip }, async () => {
    const command = await dryRun(shell, ['codex', 'taiga-plan-backlog', 'docs/specs/auth.md']);
    const readTools = (await readAllowlist()).filter((rule) => rule.startsWith('mcp__taiga__')).map((rule) => `'${rule.slice('mcp__taiga__'.length)}'`);

    assert.deepEqual(command, [
      'codex', 'exec', '--sandbox', 'workspace-write', '--dangerously-bypass-hook-trust', '--json',
      '-c', `approvals_reviewer='user'`,
      '-c', 'features.hooks=true',
      '-c', GUARD_HOOK,
      '-c', `mcp_servers.taiga.enabled_tools=[${readTools.join(',')}]`,
      '-c', `mcp_servers.taiga.default_tools_approval_mode='approve'`,
      '$taiga-plan-backlog docs/specs/auth.md',
    ]);
  });

  test(`${shell.name}: --output-format text drops the JSON output flags`, { skip }, async () => {
    const claude = await dryRun(shell, ['--output-format', 'text', 'claude', 'taiga-plan-backlog']);
    const codex = await dryRun(shell, ['--output-format', 'text', 'codex', 'taiga-plan-backlog']);

    assert.deepEqual(claude.slice(0, 5), ['claude', '-p', '/taiga-plan-backlog', '--output-format', 'text']);
    assert.ok(!codex.includes('--json'), codex.join(' '));
    assert.equal(codex.at(-1), '$taiga-plan-backlog');
  });

  test(`${shell.name}: an unknown agent is a usage error (exit 2) naming the valid agents`, { skip }, async () => {
    const result = await runScript(shell, ['--dry-run', 'gemini', 'taiga-plan-backlog']);

    assert.equal(result.code, 2, `${result.stdout}${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /unknown agent 'gemini'.*claude.*codex/);
  });

  test(`${shell.name}: a skill missing from .agents/skills is a usage error (exit 2)`, { skip }, async () => {
    for (const skill of ['taiga-nope', '../docs', 'Taiga-Plan-Backlog']) {
      const result = await runScript(shell, ['--dry-run', 'claude', skill]);

      assert.equal(result.code, 2, `${skill}: ${result.stdout}${result.stderr}`);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, new RegExp(`unknown skill '${skill.replaceAll('.', '\\.')}'.*\\.agents/skills`));
    }
  });

  test(`${shell.name}: missing arguments, an unknown option or output format is a usage error (exit 2)`, { skip }, async () => {
    for (const args of [[], ['claude'], ['--verbose', 'claude', 'taiga-plan-backlog'], ['--output-format', 'xml', 'claude', 'taiga-plan-backlog'], ['--output-format']]) {
      const result = await runScript(shell, ['--dry-run', ...args]);

      assert.equal(result.code, 2, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /usage: run-skill/);
    }
  });
}

test('the PowerShell and sh wrappers build the same command from the same arguments', async (t) => {
  if (!SHELLS.every(available)) return t.skip('needs both PowerShell and sh');
  for (const args of [['claude', 'taiga-apply-backlog', 'vigo-auth'], ['--output-format', 'text', 'codex', 'taiga-plan-backlog', 'spec.md']]) {
    const [powershell, sh] = await Promise.all(SHELLS.map((shell) => dryRun(shell, args)));
    assert.deepEqual(powershell, sh);
  }
});
