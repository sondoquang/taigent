// What `taigent setup` and `setup --project` report after their files: the Taigent skills older than the running
// taigent (each installed skill carries the version that installed it, `metadata.taigent-version`), and `duplicates`:
// the Taigent skills and the `taiga` MCP server installed both for the user (home) and in the working directory, with
// the copy each client uses. Offline: no login, so the login and MCP checks are skipped.

import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { OFFLINE, startHarness, type Harness } from './support/harness.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const VERSION = (JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version;

const TAIGENT_SKILLS = ['ask-taigent', 'prd-to-taiga', 'taiga-apply-backlog', 'taiga-bootstrap-project', 'taiga-create-user-story', 'taiga-dashboard', 'taiga-my-tickets', 'taiga-plan-backlog', 'taiga-review-backlog', 'taiga-setup', 'taiga-status-report', 'taiga-update-ticket', 'taiga-upload-docs'];

interface OutdatedSkill {
  scope: 'user' | 'project';
  path: string;
  version: string | null;
}
interface Duplicate {
  kind: 'skill' | 'mcp';
  name: string;
  client: string;
  user: string;
  project: string;
  winner: 'user' | 'project' | 'both';
  rule: string;
}
interface SetupReport {
  files: { path: string; status: string }[];
  taigentVersion: string;
  outdatedSkills: OutdatedSkill[];
  duplicates: Duplicate[];
}

const setup = (h: Harness, args: string[] = [], cwd?: string) => h.taigent(['setup', ...args], { env: OFFLINE, ...(cwd ? { cwd } : {}) });

/** Writes files under `root` (`/`-separated; a path ending in `/` is an empty directory). */
async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [file, content] of Object.entries(files)) {
    if (file.endsWith('/')) {
      await mkdir(join(root, file), { recursive: true });
      continue;
    }
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), content);
  }
}

/** Files of a directory tree with their contents, `/`-separated paths (empty when absent). */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files: Record<string, string> = {};
  for (const entry of entries.filter((e) => e.isFile())) {
    const path = join(entry.parentPath, entry.name);
    files[path.slice(dir.length + 1).replaceAll('\\', '/')] = await readFile(path, 'utf8');
  }
  return files;
}

/** The YAML frontmatter of a SKILL.md text, and the text with its `metadata.taigent-version` line(s) taken out. */
function splitSkill(text: string): { frontmatter: Record<string, unknown>; unstamped: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  assert.ok(match, 'SKILL.md has YAML frontmatter');
  return { frontmatter: parse(match[1]!) as Record<string, unknown>, unstamped: text.replace(/^metadata:\r?\n {2}taigent-version: "[^"]*"\r?\n/m, '') };
}

const source = (skill: string) => readFile(join(REPO_ROOT, '.agents/skills', skill, 'SKILL.md'), 'utf8');

/** A SKILL.md as an older taigent installed it: the source with `version` in its metadata (none: before versions). */
async function olderSkill(skill: string, version?: string): Promise<string> {
  const text = await source(skill);
  return version === undefined ? text : text.replace(/\r?\n---\r?\n/, `\nmetadata:\n  taigent-version: "${version}"\n---\n`);
}

test('every skill setup installs carries the running taigent version in its metadata, for the user and for a project, and run again changes nothing', async (t) => {
  const h = await startHarness(t);
  await writeFiles(h.home, { '.claude/': '', '.codex/': '' });

  const user = await setup(h, ['--json']);
  const project = await setup(h, ['--project', '--json']);

  for (const result of [user, project]) {
    assert.equal(result.code, 0, result.stderr);
    const report = result.json<SetupReport>();
    assert.equal(report.taigentVersion, VERSION);
    assert.deepEqual(report.outdatedSkills, []);
  }
  for (const [root, dir] of [[h.home, '.claude/skills'], [h.home, '.agents/skills'], [h.cwd, '.agents/skills'], [h.cwd, '.claude/skills']] as const) {
    for (const skill of TAIGENT_SKILLS) {
      const { frontmatter, unstamped } = splitSkill(await readFile(join(root, dir, skill, 'SKILL.md'), 'utf8'));
      // Agent Skills: `metadata` maps string keys to string values.
      assert.deepEqual(frontmatter.metadata, { 'taigent-version': VERSION }, `${dir}/${skill}`);
      assert.equal(frontmatter.name, skill);
      assert.equal(unstamped, await source(skill), `${dir}/${skill}: only the version is added`);
    }
  }
  // The project's two copies stay identical, so `skills check` passes there.
  const check = await h.taigent(['skills', 'check'], { env: OFFLINE });
  assert.equal(check.code, 0, check.stdout);

  for (const args of [[], ['--project']]) {
    const again = await setup(h, [...args, '--json']);
    assert.equal(again.code, 0, again.stderr);
    assert.ok(again.json<SetupReport>().files.every(({ status }) => status === 'unchanged'), again.stdout);
  }
});

test('setup reports the installed skills older than taigent, for the user and in the project, and says to run setup again', async (t) => {
  const h = await startHarness(t);
  await writeFiles(h.home, { '.claude/': '' });
  assert.equal((await setup(h)).code, 0);
  await writeFiles(h.home, {
    '.claude/skills/taiga-setup/SKILL.md': await olderSkill('taiga-setup', '0.0.1'),
    '.claude/skills/ask-taigent/SKILL.md': await olderSkill('ask-taigent'),
    '.claude/skills/taiga-dashboard/SKILL.md': await olderSkill('taiga-dashboard', '999.0.0'),
  });
  await writeFiles(h.cwd, { '.agents/skills/taiga-my-tickets/SKILL.md': await olderSkill('taiga-my-tickets', '0.0.9') });
  const userCopies = { 'taiga-setup': '0.0.1', 'ask-taigent': null } as const;

  const dryRun = await setup(h, ['--dry-run', '--json']);
  const dryRunText = await setup(h, ['--dry-run']);

  assert.equal(dryRun.code, 3, dryRun.stderr);
  assert.deepEqual(dryRun.json<SetupReport>().outdatedSkills, [
    { scope: 'user', path: '~/.claude/skills/ask-taigent', version: userCopies['ask-taigent'] },
    { scope: 'user', path: '~/.claude/skills/taiga-setup', version: userCopies['taiga-setup'] },
    { scope: 'project', path: '.agents/skills/taiga-my-tickets', version: '0.0.9' },
  ]);
  assert.match(dryRunText.stdout, new RegExp(`^Older than taigent ${VERSION.replaceAll('.', '\\.')} in ~/\\.claude/skills: ask-taigent \\(no version\\), taiga-setup \\(0\\.0\\.1\\); run taigent setup to update them\\.$`, 'm'));
  assert.match(dryRunText.stdout, /^Older than taigent .* in \.agents\/skills: taiga-my-tickets \(0\.0\.9\); run taigent setup --project here to update them\.$/m);

  // Setup updates the user's copies (a newer one too: it installs its own version); the project's stay until setup --project.
  const result = await setup(h, ['--json']);
  const text = await setup(h);

  assert.equal(result.code, 0, result.stderr);
  const report = result.json<SetupReport>();
  assert.deepEqual(report.outdatedSkills, [{ scope: 'project', path: '.agents/skills/taiga-my-tickets', version: '0.0.9' }]);
  assert.deepEqual(splitSkill(await readFile(join(h.home, '.claude/skills/taiga-dashboard/SKILL.md'), 'utf8')).frontmatter.metadata, { 'taigent-version': VERSION });
  assert.match(text.stdout, /run taigent setup --project here to update them/);
  assert.doesNotMatch(text.stdout, /~\/\.claude\/skills: /);

  const project = await setup(h, ['--project', '--json']);
  assert.equal(project.code, 0, project.stderr);
  assert.deepEqual(project.json<SetupReport>().outdatedSkills, []);
});

test('duplicates: a skill or the taiga server both for the user and in the project is reported per client with the copy that client uses, and nothing is removed', async (t) => {
  const h = await startHarness(t);
  await writeFiles(h.home, { '.claude/': '', '.codex/': '', '.omp/': '' });
  const onlyUser = await setup(h, ['--json']);
  assert.equal(onlyUser.code, 0, onlyUser.stderr);
  assert.deepEqual(onlyUser.json<SetupReport>().duplicates, [], 'nothing in the project yet');

  const result = await setup(h, ['--project', '--json']);

  assert.equal(result.code, 0, result.stderr);
  const duplicates = result.json<SetupReport>().duplicates;
  const pick = (kind: string, name: string) => duplicates.filter((d) => d.kind === kind && d.name === name).map(({ rule, ...d }) => (assert.ok(rule, `${d.client} ${name}: rule`), d));
  assert.deepEqual(pick('skill', 'taiga-setup'), [
    // Claude Code: the personal skill wins over the project one.
    { kind: 'skill', name: 'taiga-setup', client: 'claude-code', user: '~/.claude/skills/taiga-setup', project: '.claude/skills/taiga-setup', winner: 'user' },
    // Codex shows both.
    { kind: 'skill', name: 'taiga-setup', client: 'codex', user: '~/.agents/skills/taiga-setup', project: '.agents/skills/taiga-setup', winner: 'both' },
    // OMP: a project .claude/skills skill beats ~/.agents/skills.
    { kind: 'skill', name: 'taiga-setup', client: 'omp', user: '~/.agents/skills/taiga-setup', project: '.claude/skills/taiga-setup', winner: 'project' },
  ]);
  assert.deepEqual(pick('mcp', 'taiga'), [
    { kind: 'mcp', name: 'taiga', client: 'claude-code', user: '~/.claude.json', project: '.mcp.json', winner: 'project' },
    { kind: 'mcp', name: 'taiga', client: 'codex', user: '~/.codex/config.toml', project: '.codex/config.toml', winner: 'project' },
    // OMP's native user mcp.json precedes a project .mcp.json.
    { kind: 'mcp', name: 'taiga', client: 'omp', user: '~/.omp/agent/mcp.json', project: '.mcp.json', winner: 'user' },
  ]);
  assert.equal(duplicates.length, TAIGENT_SKILLS.length * 3 + 3);

  // A project .omp/mcp.json precedes OMP's user mcp.json; setup never removes a copy.
  await writeFiles(h.cwd, { '.omp/mcp.json': JSON.stringify({ mcpServers: { taiga: { command: 'node', args: ['x'] } } }) });
  const [home, cwd] = [await snapshot(h.home), await snapshot(h.cwd)];

  const again = await setup(h, ['--json']);
  const text = await setup(h);

  assert.equal(again.code, 0, again.stderr);
  const omp = again.json<SetupReport>().duplicates.find((d) => d.kind === 'mcp' && d.client === 'omp');
  assert.deepEqual({ ...omp, rule: undefined }, { kind: 'mcp', name: 'taiga', client: 'omp', user: '~/.omp/agent/mcp.json', project: '.omp/mcp.json', winner: 'project', rule: undefined });
  assert.deepEqual(await snapshot(h.home), home);
  assert.deepEqual(await snapshot(h.cwd), cwd);
  assert.match(text.stdout, /nothing was removed/);
  assert.match(text.stdout, /^ {2}Claude Code: skills ask-taigent, .*taiga-upload-docs in ~\/\.claude\/skills and \.claude\/skills: the user copy wins \(.+\)\.$/m);
  assert.match(text.stdout, /^ {2}Codex: skills .* in ~\/\.agents\/skills and \.agents\/skills: both are used \(.+\)\.$/m);
  assert.match(text.stdout, /^ {2}Claude Code: MCP server taiga in ~\/\.claude\.json and \.mcp\.json: the project copy wins \(.+\)\.$/m);
  assert.match(text.stdout, /^ {2}OMP: MCP server taiga in ~\/\.omp\/agent\/mcp\.json and \.omp\/mcp\.json: the project copy wins \(.+\)\.$/m);
});

test('duplicates are only for clients found in the home directory, and none when the working directory is the home directory', async (t) => {
  const h = await startHarness(t);
  await writeFiles(h.home, { '.claude/': '' });
  assert.equal((await setup(h, ['--project'])).code, 0);

  const result = await setup(h, ['--json']);
  const fromHome = await setup(h, ['--json'], h.home);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual([...new Set(result.json<SetupReport>().duplicates.map((d) => d.client))], ['claude-code']);
  assert.equal(fromHome.code, 0, fromHome.stderr);
  assert.deepEqual(fromHome.json<SetupReport>().duplicates, []);
  assert.deepEqual(fromHome.json<SetupReport>().outdatedSkills, []);
});

test('in the taigent repository itself, its skill sources are not reported as older', async (t) => {
  const h = await startHarness(t);
  await writeFiles(h.home, { '.claude/': '' });

  const result = await setup(h, ['--dry-run', '--json'], REPO_ROOT);

  assert.equal(result.code, 3, result.stderr);
  assert.deepEqual(result.json<SetupReport>().outdatedSkills, []);
});
