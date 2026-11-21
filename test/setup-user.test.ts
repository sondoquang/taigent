import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { OFFLINE, startHarness, type Harness } from './support/harness.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

type Status = 'created' | 'updated' | 'unchanged' | 'removed';
interface SetupClient {
  name: string;
  status: 'configured' | 'skipped';
  skills?: string;
  mcp?: string;
  reason?: string;
}
interface SetupReport {
  files: { path: string; status: Status }[];
  clients: SetupClient[];
}

const TAIGENT_SKILLS = ['ask-taigent', 'prd-to-taiga', 'taiga-apply-backlog', 'taiga-bootstrap-project', 'taiga-create-user-story', 'taiga-dashboard', 'taiga-my-tickets', 'taiga-plan-backlog', 'taiga-review-backlog', 'taiga-setup', 'taiga-status-report', 'taiga-update-ticket', 'taiga-upload-docs'];

/** TOML as plain JSON values (smol-toml builds null-prototype objects). */
const toml = (text: string) => JSON.parse(JSON.stringify(parseToml(text)));
const PROJECT_CODEX_ENTRY = toml(await readFile(join(REPO_ROOT, '.codex/config.toml'), 'utf8')).mcp_servers.taiga;
/** The user-scope `taiga` server: the global `taigent mcp`, no secrets. */
const USER_ENTRY = { type: 'stdio', command: 'taigent', args: ['mcp'] };
/** Codex's: the same command, with the forwarded variables and `required` of the project entry. */
const USER_CODEX_ENTRY = { command: 'taigent', args: ['mcp'], env_vars: PROJECT_CODEX_ENTRY.env_vars, required: PROJECT_CODEX_ENTRY.required };

const setup = (h: Harness, args: string[] = []) => h.taigent(['setup', ...args], { env: OFFLINE });
const read = (h: Harness, file: string) => readFile(join(h.home, file), 'utf8');
const statuses = (report: SetupReport) => Object.fromEntries(report.files.map(({ path, status }) => [path, status]));
const client = (report: SetupReport, name: string) => report.clients.find((c) => c.name === name);

/** Writes files under the temp home (`/`-separated paths; a path ending in `/` is an empty directory). */
async function writeHome(h: Harness, files: Record<string, string>): Promise<void> {
  for (const [file, content] of Object.entries(files)) {
    if (file.endsWith('/')) {
      await mkdir(join(h.home, file), { recursive: true });
      continue;
    }
    await mkdir(dirname(join(h.home, file)), { recursive: true });
    await writeFile(join(h.home, file), content);
  }
}

/** Files of a directory tree, `/`-separated and relative to it (empty when absent). */
async function tree(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(dir.length + 1).replaceAll('\\', '/')).sort();
  } catch {
    return [];
  }
}

test('setup installs the skills and the taiga MCP server into the user config of Claude Code, Codex and OMP', async (t) => {
  const h = await startHarness(t);
  await writeHome(h, { '.claude/': '', '.codex/': '', '.omp/': '' });

  const result = await setup(h, ['--json']);

  assert.equal(result.code, 0, result.stderr);
  const report = result.json<SetupReport>();
  assert.deepEqual(report.clients, [
    { name: 'claude-code', status: 'configured', skills: '~/.claude/skills', mcp: '~/.claude.json' },
    { name: 'codex', status: 'configured', skills: '~/.agents/skills', mcp: '~/.codex/config.toml' },
    { name: 'omp', status: 'configured', skills: '~/.agents/skills', mcp: '~/.omp/agent/mcp.json' },
  ]);
  assert.ok(report.files.length > 0 && report.files.every(({ status }) => status === 'created'), result.stdout);
  const paths = report.files.map(({ path }) => path);
  for (const file of ['~/.claude.json', '~/.codex/config.toml', '~/.omp/agent/mcp.json', '~/.claude/skills/taiga-my-tickets/SKILL.md', '~/.agents/skills/taiga-my-tickets/SKILL.md']) {
    assert.ok(paths.includes(file), `${file} in ${paths.join(', ')}`);
  }

  // Claude Code reads ~/.claude/skills; Codex and OMP both read ~/.agents/skills, so OMP gets no copy of its own.
  for (const dir of ['.claude/skills', '.agents/skills']) {
    assert.deepEqual(await readdir(join(h.home, dir)), TAIGENT_SKILLS);
    assert.equal(await read(h, `${dir}/taiga-setup/SKILL.md`), await readFile(join(REPO_ROOT, '.agents/skills/taiga-setup/SKILL.md'), 'utf8'));
  }
  assert.deepEqual(await readdir(join(h.home, '.omp')), ['agent']);
  assert.deepEqual(await readdir(join(h.home, '.omp/agent')), ['mcp.json']);

  assert.deepEqual(JSON.parse(await read(h, '.claude.json')), { mcpServers: { taiga: USER_ENTRY } });
  assert.deepEqual(toml(await read(h, '.codex/config.toml')), { mcp_servers: { taiga: USER_CODEX_ENTRY } });
  assert.deepEqual(JSON.parse(await read(h, '.omp/agent/mcp.json')), { mcpServers: { taiga: USER_ENTRY } });
  // taiga-setup shows the user these same entries (its first JSON and TOML blocks).
  const skill = await readFile(join(REPO_ROOT, '.agents/skills/taiga-setup/SKILL.md'), 'utf8');
  const block = (lang: string) => new RegExp(`^\`\`\`${lang}\\r?\\n([\\s\\S]*?)^\`\`\``, 'm').exec(skill)?.[1] ?? '';
  assert.deepEqual(JSON.parse(block('json')), JSON.parse(await read(h, '.claude.json')));
  assert.deepEqual(toml(block('toml')), toml(await read(h, '.codex/config.toml')));

  assert.deepEqual(await tree(h.cwd), [], 'nothing is written in the working directory');
  assert.deepEqual(h.fake.requests, []);
});

test('setup skips a client that is not in the home directory, says why, and creates nothing for it', async (t) => {
  const codexOnly = await startHarness(t);
  await writeHome(codexOnly, { '.codex/': '' });

  const result = await setup(codexOnly, ['--json']);

  assert.equal(result.code, 0, result.stderr);
  const report = result.json<SetupReport>();
  assert.equal(client(report, 'codex')?.status, 'configured');
  for (const name of ['claude-code', 'omp']) {
    const skipped = client(report, name);
    assert.equal(skipped?.status, 'skipped', name);
    assert.ok(skipped?.reason, `${name} has a reason`);
  }
  assert.match(client(report, 'claude-code')!.reason!, /~\/\.claude\//);
  assert.deepEqual((await readdir(codexOnly.home)).sort(), ['.agents', '.codex']);

  // Claude Code is found by ~/.claude.json alone; OMP alone still gets the ~/.agents/skills it reads.
  const others = await startHarness(t);
  await writeHome(others, { '.claude.json': '{}\n', '.omp/': '' });

  const second = await setup(others, ['--json']);

  assert.equal(second.code, 0, second.stderr);
  const statuses = second.json<SetupReport>().clients.map(({ name, status }) => `${name}:${status}`);
  assert.deepEqual(statuses, ['claude-code:configured', 'codex:skipped', 'omp:configured']);
  assert.deepEqual((await readdir(others.home)).sort(), ['.agents', '.claude', '.claude.json', '.omp']);
  assert.deepEqual(await readdir(join(others.home, '.agents/skills')), TAIGENT_SKILLS);
  assert.deepEqual(JSON.parse(await read(others, '.claude.json')), { mcpServers: { taiga: USER_ENTRY } });

  const text = await setup(codexOnly, ['--dry-run']);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /^Claude Code: skipped \(.+\)$/m);
  assert.match(text.stdout, /^Codex: .*~\/\.codex\/config\.toml/m);
});

test('setup with no client in the home directory writes nothing and says so', async (t) => {
  const h = await startHarness(t);

  const result = await setup(h, ['--json']);
  const text = await setup(h);

  assert.equal(result.code, 0, result.stderr);
  const report = result.json<SetupReport>();
  assert.deepEqual(report.files, []);
  assert.ok(report.clients.every(({ status }) => status === 'skipped'), result.stdout);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /No client found/);
  assert.deepEqual(await readdir(h.home), []);
});

test('setup keeps the other servers, keys and skills of each client config, and run again finds every file unchanged', async (t) => {
  const h = await startHarness(t);
  const claudeJson = `${JSON.stringify(
    {
      numStartups: 42,
      mcpServers: { github: { type: 'stdio', command: 'github-mcp', args: [] }, taiga: { command: 'npx', args: ['-y', 'taiga-mcp-server@1.0.0'], env: { TAIGA_PASSWORD: 'secret' } } },
      projects: { 'D:/work': { mcpServers: { local: { command: 'x' } }, allowedTools: [] } },
    },
    null,
    2,
  )}\n`;
  const codexConfig = ['model = "o3"', '', '[mcp_servers.taiga]', 'command = "node"', 'args = ["old.js"]', '', '[mcp_servers.taiga.env]', 'TAIGA_PASSWORD = "secret"', '', '# the GitHub server', '[mcp_servers.github]', 'command = "github-mcp"', ''].join('\r\n');
  const ompJson = JSON.stringify({ $schema: 'https://example.test/mcp-schema.json', mcpServers: { rea: { type: 'stdio', command: 'rea' } }, disabledServers: ['rea'], enabledServers: [] }, null, 4);
  await writeHome(h, {
    '.claude.json': claudeJson,
    '.claude/settings.json': '{"theme":"dark"}',
    '.claude/skills/tdd/SKILL.md': 'claude tdd',
    '.codex/config.toml': codexConfig,
    '.agents/skills/grill-me/SKILL.md': 'agents grill-me',
    '.omp/agent/mcp.json': ompJson,
  });

  const result = await setup(h, ['--json']);

  assert.equal(result.code, 0, result.stderr);
  const status = statuses(result.json<SetupReport>());
  for (const file of ['~/.claude.json', '~/.codex/config.toml', '~/.omp/agent/mcp.json']) assert.equal(status[file], 'updated', file);
  assert.equal(status['~/.claude/skills/tdd/SKILL.md'], undefined);
  assert.equal(await read(h, '.claude/skills/tdd/SKILL.md'), 'claude tdd');
  assert.equal(await read(h, '.agents/skills/grill-me/SKILL.md'), 'agents grill-me');
  assert.equal(await read(h, '.claude/settings.json'), '{"theme":"dark"}');

  const claude = await read(h, '.claude.json');
  assert.deepEqual(JSON.parse(claude), {
    numStartups: 42,
    mcpServers: { github: { type: 'stdio', command: 'github-mcp', args: [] }, taiga: USER_ENTRY },
    projects: { 'D:/work': { mcpServers: { local: { command: 'x' } }, allowedTools: [] } },
  });
  assert.match(claude, /^ {2}"numStartups": 42,$/m, 'the indentation of the file is kept');

  const codex = await read(h, '.codex/config.toml');
  assert.deepEqual(toml(codex), { model: 'o3', mcp_servers: { taiga: USER_CODEX_ENTRY, github: { command: 'github-mcp' } } });
  assert.match(codex, /^# the GitHub server\r$/m);
  assert.doesNotMatch(codex, /secret/);
  assert.doesNotMatch(codex, /[^\r]\n/, 'the line endings of the file are kept');

  const omp = await read(h, '.omp/agent/mcp.json');
  assert.deepEqual(JSON.parse(omp), { $schema: 'https://example.test/mcp-schema.json', mcpServers: { rea: { type: 'stdio', command: 'rea' }, taiga: USER_ENTRY }, disabledServers: ['rea'], enabledServers: [] });
  assert.match(omp, /^ {4}"mcpServers"/m);

  const again = await setup(h, ['--json']);
  const dryRun = await setup(h, ['--dry-run', '--json']);
  assert.equal(again.code, 0, again.stderr);
  assert.ok(again.json<SetupReport>().files.every(({ status }) => status === 'unchanged'), again.stdout);
  assert.equal(dryRun.code, 0, dryRun.stderr);
  assert.deepEqual(dryRun.json<SetupReport>().files, again.json<SetupReport>().files);
});

test('setup updates a Taigent skill that differs and removes a Taigent skill gone from taigent, in each user skills directory', async (t) => {
  const h = await startHarness(t);
  await writeHome(h, { '.claude/': '', '.codex/': '' });
  assert.equal((await setup(h)).code, 0);
  await writeHome(h, {
    '.claude/skills/taiga-setup/SKILL.md': 'edited',
    '.agents/skills/taiga-old/SKILL.md': 'retired skill',
    '.agents/skills/tdd/SKILL.md': 'not a Taigent skill',
  });

  const result = await setup(h, ['--json']);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    result.json<SetupReport>().files.filter(({ status }) => status !== 'unchanged'),
    [
      { path: '~/.agents/skills/taiga-old/SKILL.md', status: 'removed' },
      { path: '~/.claude/skills/taiga-setup/SKILL.md', status: 'updated' },
    ],
  );
  assert.deepEqual(await readdir(join(h.home, '.agents/skills')), [...TAIGENT_SKILLS, 'tdd'].sort());
  assert.equal(await read(h, '.claude/skills/taiga-setup/SKILL.md'), await readFile(join(REPO_ROOT, '.agents/skills/taiga-setup/SKILL.md'), 'utf8'));
});

test('setup --dry-run lists the changes under ~/, writes nothing and exits 3', async (t) => {
  const h = await startHarness(t);
  const ompJson = JSON.stringify({ mcpServers: { rea: { command: 'rea' } } });
  await writeHome(h, { '.claude/': '', '.codex/': '', '.omp/agent/mcp.json': ompJson });

  const json = await setup(h, ['--dry-run', '--json']);
  const text = await setup(h, ['--dry-run']);

  assert.equal(json.code, 3, json.stderr);
  const report = json.json<SetupReport>();
  assert.ok(report.files.length > 0 && report.files.every(({ path }) => path.startsWith('~/')), json.stdout);
  assert.equal(statuses(report)['~/.omp/agent/mcp.json'], 'updated');
  assert.equal(text.code, 3, text.stderr);
  assert.match(text.stdout, /^~\/\.claude\.json: created$/m);
  assert.match(text.stdout, /^~\/\.agents\/skills\/taiga-setup\/SKILL\.md: created$/m);
  assert.deepEqual(await tree(h.home), ['.omp/agent/mcp.json']);
  assert.equal(await read(h, '.omp/agent/mcp.json'), ompJson);
});

test('setup refuses a client config it cannot merge (exit 2) and writes nothing, for any client', async (t) => {
  const invalid: [file: string, content: string][] = [['.claude.json', '{ "mcpServers": '], ['.codex/config.toml', '[mcp_servers.taiga\n'], ['.omp/agent/mcp.json', '{"mcpServers": []}']];
  for (const [file, content] of invalid) {
    const h = await startHarness(t);
    await writeHome(h, { '.claude/': '', '.codex/': '', '.omp/': '', [file]: content });

    const result = await setup(h, ['--json']);

    assert.equal(result.code, 2, `${file}: ${result.stdout}`);
    assert.equal(result.json<{ error: { kind: string; message: string } }>().error.kind, 'usage');
    assert.match(result.stderr, new RegExp(`~/${file.replaceAll('.', '\\.')}`));
    assert.deepEqual(await tree(h.home), [file]);
  }
});
