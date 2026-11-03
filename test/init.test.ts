import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { OFFLINE, runTaigent, startHarness, type Harness } from './support/harness.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const VERSION = (JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version;

type Status = 'created' | 'updated' | 'unchanged' | 'removed';
interface InitReport {
  files: { path: string; status: Status }[];
}

const TAIGENT_SKILLS = ['ask-taigent', 'prd-to-taiga', 'taiga-apply-backlog', 'taiga-bootstrap-project', 'taiga-create-user-story', 'taiga-my-tickets', 'taiga-plan-backlog', 'taiga-setup', 'taiga-status-report', 'taiga-update-ticket', 'taiga-upload-docs'];
const KIT = ['tools/taiga/allowlist.txt', 'tools/taiga/omp-guard.mjs', '.codex/hooks/taigent-shell-guard.mjs', '.codex/rules/taigent.rules'];
const CONFIGS = ['.mcp.json', '.codex/config.toml', 'package.json', '.gitignore'];
const PREVIEW_IGNORES = ['taiga/*/preview.md', 'taiga/*/.preview/'];

/** The `taiga` entries of this repository's own config, as another project runs them: from node_modules. */
const installed = (text: string) => text.replaceAll('"bin/taigent.js"', '"node_modules/taigent/bin/taigent.js"');
/** TOML as plain JSON values (smol-toml builds null-prototype objects). */
const toml = (text: string) => JSON.parse(JSON.stringify(parseToml(text)));
const MCP_ENTRY = JSON.parse(installed(await readFile(join(REPO_ROOT, '.mcp.json'), 'utf8'))).mcpServers.taiga;
const CODEX_ENTRY = toml(installed(await readFile(join(REPO_ROOT, '.codex/config.toml'), 'utf8'))).mcp_servers.taiga;

const init = (h: Harness, args: string[] = []) => h.taigent(['init', ...args], { env: OFFLINE });
const read = (h: Harness, file: string) => readFile(join(h.cwd, file), 'utf8');
const statuses = (report: InitReport) => Object.fromEntries(report.files.map(({ path, status }) => [path, status]));

async function writeFiles(h: Harness, files: Record<string, string>): Promise<void> {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(h.cwd, file)), { recursive: true });
    await writeFile(join(h.cwd, file), content);
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

test('init on an empty folder creates the skills, the MCP entries, the headless kit and the pinned devDependency', async (t) => {
  const h = await startHarness(t);

  const result = await init(h, ['--json']);

  assert.equal(result.code, 0, result.stderr);
  const report = result.json<InitReport>();
  assert.ok(report.files.length > 0);
  assert.ok(report.files.every(({ status }) => status === 'created'), JSON.stringify(report.files));
  const paths = report.files.map(({ path }) => path);
  for (const file of [...KIT, ...CONFIGS, '.agents/skills/taiga-setup/SKILL.md', '.claude/skills/ask-taigent/SKILL.md']) {
    assert.ok(paths.includes(file), `${file} in ${paths.join(', ')}`);
  }

  // The Taigent skills of the running taigent, in both places, and nothing else.
  for (const dir of ['.agents/skills', '.claude/skills']) {
    assert.deepEqual(await readdir(join(h.cwd, dir)), TAIGENT_SKILLS);
    assert.equal(await read(h, `${dir}/taiga-setup/SKILL.md`), await readFile(join(REPO_ROOT, '.agents/skills/taiga-setup/SKILL.md'), 'utf8'));
  }
  const check = await h.taigent(['skills', 'check', '--json'], { env: OFFLINE });
  assert.equal(check.code, 0, check.stdout);
  for (const file of KIT) assert.equal(await read(h, file), await readFile(join(REPO_ROOT, file), 'utf8'), file);

  assert.deepEqual(JSON.parse(await read(h, '.mcp.json')), { mcpServers: { taiga: MCP_ENTRY } });
  assert.deepEqual(toml(await read(h, '.codex/config.toml')), { mcp_servers: { taiga: CODEX_ENTRY } });
  assert.deepEqual(JSON.parse(await read(h, 'package.json')), { devDependencies: { taigent: `github:sondoquang/taigent#v${VERSION}` } });
  assert.deepEqual((await read(h, '.gitignore')).split('\n').filter((line) => line && !line.startsWith('#')), PREVIEW_IGNORES);
  assert.deepEqual(h.fake.requests, []);
});

test('init run again finds every file unchanged and exits 0', async (t) => {
  const h = await startHarness(t);
  assert.equal((await init(h)).code, 0);

  const again = await init(h, ['--json']);
  const dryRun = await init(h, ['--dry-run', '--json']);

  assert.equal(again.code, 0, again.stderr);
  assert.ok(again.json<InitReport>().files.every(({ status }) => status === 'unchanged'), again.stdout);
  assert.equal(dryRun.code, 0, dryRun.stderr);
  assert.deepEqual(dryRun.json(), again.json());
});

test('init keeps other skills, MCP servers, settings and dependencies, and its merged JSON and TOML stay valid', async (t) => {
  const h = await startHarness(t);
  const codexConfig = [
    '# team settings',
    'model = "o3"',
    '',
    '[mcp_servers.taiga]',
    'command = "npx"',
    'args = ["-y", "taiga-mcp-server@1.0.0"]',
    '',
    '[mcp_servers.taiga.env]',
    'TAIGA_PASSWORD = "secret"',
    '',
    '# the GitHub server',
    '[mcp_servers.github]',
    'command = "github-mcp"',
    'description = """',
    '[not a table]',
    '"""',
    '',
  ].join('\n');
  await writeFiles(h, {
    '.agents/skills/tdd/SKILL.md': 'agents tdd',
    '.claude/skills/grill-me/SKILL.md': 'claude grill-me',
    '.mcp.json': JSON.stringify({ mcpServers: { github: { command: 'github-mcp' } }, note: 'kept' }, null, 4),
    '.codex/config.toml': codexConfig,
    'package.json': `${JSON.stringify({ name: 'app', scripts: { test: 'vitest' }, dependencies: { react: '^19.0.0', taigent: '^0.0.1' }, devDependencies: { vitest: '^3.0.0' } }, null, 2)}\n`,
    '.gitignore': 'node_modules/\r\ntaiga/*/preview.md  \r\ndist/',
  });

  const result = await init(h, ['--json']);

  assert.equal(result.code, 0, result.stderr);
  const status = statuses(result.json<InitReport>());
  assert.equal(status['.mcp.json'], 'updated');
  assert.equal(status['.codex/config.toml'], 'updated');
  assert.equal(status['package.json'], 'updated');
  assert.equal(status['.gitignore'], 'updated');
  assert.equal(status['.agents/skills/tdd/SKILL.md'], undefined);
  assert.equal(await read(h, '.agents/skills/tdd/SKILL.md'), 'agents tdd');
  assert.equal(await read(h, '.claude/skills/grill-me/SKILL.md'), 'claude grill-me');

  assert.deepEqual(JSON.parse(await read(h, '.mcp.json')), { mcpServers: { github: { command: 'github-mcp' }, taiga: MCP_ENTRY }, note: 'kept' });
  assert.match(await read(h, '.mcp.json'), /^ {4}"mcpServers"/m, 'the indentation of the file is kept');

  const codex = await read(h, '.codex/config.toml');
  assert.deepEqual(toml(codex), {
    model: 'o3',
    mcp_servers: { taiga: CODEX_ENTRY, github: { command: 'github-mcp', description: '[not a table]\n' } },
  });
  assert.match(codex, /^# team settings$/m);
  assert.match(codex, /^# the GitHub server$/m);
  assert.doesNotMatch(codex, /secret/);

  assert.deepEqual(JSON.parse(await read(h, 'package.json')), {
    name: 'app',
    scripts: { test: 'vitest' },
    dependencies: { react: '^19.0.0' },
    devDependencies: { vitest: '^3.0.0', taigent: `github:sondoquang/taigent#v${VERSION}` },
  });
  // Only the missing preview line is added, in the file's own line endings; every other line stays.
  assert.equal(await read(h, '.gitignore'), `node_modules/\r\ntaiga/*/preview.md  \r\ndist/\r\n\r\n# Taigent: BA preview working copies (taiga-apply-backlog carries the edits into backlog.yaml)\r\ntaiga/*/.preview/\r\n`);

  const again = await init(h, ['--json']);
  assert.ok(again.json<InitReport>().files.every(({ status }) => status === 'unchanged'), again.stdout);
});

test('init appends the taiga table to a Codex config without one', async (t) => {
  const h = await startHarness(t);
  await writeFiles(h, { '.codex/config.toml': '[mcp_servers.github]\ncommand = "github-mcp"' });

  const result = await init(h, ['--json']);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(statuses(result.json<InitReport>())['.codex/config.toml'], 'updated');
  const codex = await read(h, '.codex/config.toml');
  assert.deepEqual(toml(codex), { mcp_servers: { github: { command: 'github-mcp' }, taiga: CODEX_ENTRY } });
  assert.ok(codex.startsWith('[mcp_servers.github]\ncommand = "github-mcp"\n'), codex);
});

test('init updates a Taigent skill that differs and removes a Taigent skill gone from taigent', async (t) => {
  const h = await startHarness(t);
  assert.equal((await init(h)).code, 0);
  await writeFiles(h, {
    '.agents/skills/taiga-setup/SKILL.md': 'edited',
    '.claude/skills/taiga-setup/notes.md': 'stale',
    '.agents/skills/taiga-old/SKILL.md': 'retired skill',
    '.claude/skills/taiga-old/SKILL.md': 'retired skill',
  });

  const result = await init(h, ['--json']);

  assert.equal(result.code, 0, result.stderr);
  const changed = result.json<InitReport>().files.filter(({ status }) => status !== 'unchanged');
  assert.deepEqual(changed, [
    { path: '.agents/skills/taiga-old/SKILL.md', status: 'removed' },
    { path: '.agents/skills/taiga-setup/SKILL.md', status: 'updated' },
    { path: '.claude/skills/taiga-old/SKILL.md', status: 'removed' },
    { path: '.claude/skills/taiga-setup/notes.md', status: 'removed' },
  ]);
  assert.equal(await read(h, '.agents/skills/taiga-setup/SKILL.md'), await readFile(join(REPO_ROOT, '.agents/skills/taiga-setup/SKILL.md'), 'utf8'));
  for (const dir of ['.agents/skills', '.claude/skills']) assert.deepEqual(await readdir(join(h.cwd, dir)), TAIGENT_SKILLS);
  assert.deepEqual(await tree(join(h.cwd, '.claude/skills/taiga-setup')), await tree(join(REPO_ROOT, '.agents/skills/taiga-setup')));
});

test('init --dry-run lists the changes, writes nothing and exits 3', async (t) => {
  const h = await startHarness(t);

  const empty = await init(h, ['--dry-run', '--json']);

  assert.equal(empty.code, 3, empty.stderr);
  const report = empty.json<InitReport>();
  assert.ok(report.files.length > 0 && report.files.every(({ status }) => status === 'created'), empty.stdout);
  assert.deepEqual(await tree(h.cwd), []);

  const mcp = JSON.stringify({ mcpServers: { github: { command: 'github-mcp' } } });
  await writeFiles(h, { '.mcp.json': mcp, '.agents/skills/taiga-old/SKILL.md': 'retired skill' });
  const text = await init(h, ['--dry-run']);
  assert.equal(text.code, 3, text.stderr);
  assert.match(text.stdout, /^\.mcp\.json: updated$/m);
  assert.match(text.stdout, /^\.agents\/skills\/taiga-old\/SKILL\.md: removed$/m);
  assert.deepEqual(await tree(h.cwd), ['.agents/skills/taiga-old/SKILL.md', '.mcp.json']);
  assert.equal(await read(h, '.mcp.json'), mcp);
});

test('init refuses a config it cannot merge (exit 2) and writes nothing', async (t) => {
  const invalid: [file: string, content: string][] = [['.mcp.json', '{ "mcpServers": '], ['.codex/config.toml', '[mcp_servers.taiga\n'], ['package.json', '[]']];
  for (const [file, content] of invalid) {
    const h = await startHarness(t);
    await writeFiles(h, { [file]: content });

    const result = await init(h, ['--json']);

    assert.equal(result.code, 2, `${file}: ${result.stdout}`);
    assert.equal(result.json<{ error: { kind: string; message: string } }>().error.kind, 'usage');
    assert.match(result.stderr, new RegExp(file.replaceAll('.', '\\.')));
    assert.deepEqual(await tree(h.cwd), [file]);
  }
});

test('init refuses to install taigent into the running taigent itself (exit 2)', async () => {
  const result = await runTaigent(['init', '--dry-run'], { env: OFFLINE, cwd: REPO_ROOT });

  assert.equal(result.code, 2, result.stdout);
  assert.match(result.stderr, /another repository/);
});
