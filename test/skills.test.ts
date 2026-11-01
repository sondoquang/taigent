import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { runTaigent } from './support/harness.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** `skills` works on the files of the working directory only: no Taiga, no env. */
const OFFLINE = { TAIGA_API_URL: undefined, TAIGA_USERNAME: undefined, TAIGA_PASSWORD: undefined };

interface SkillsCheck {
  inSync: boolean;
  skills: string[];
  differences: { skill: string; file: string; status: 'missing' | 'changed' | 'extra' }[];
}

/** A temp repository root with the given files (paths relative to it, `/`-separated). */
async function repo(t: TestContext, files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'taigent-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), content);
  }
  return root;
}

const skills = (args: string[], cwd: string) => runTaigent(['skills', ...args], { env: OFFLINE, cwd });

test('skills check exits 0 when every taiga-* skill has an identical Claude copy', async (t) => {
  const root = await repo(t, {
    '.agents/skills/taiga-plan-backlog/SKILL.md': 'plan',
    '.agents/skills/taiga-plan-backlog/agents/openai.yaml': 'interface: {}',
    '.claude/skills/taiga-plan-backlog/SKILL.md': 'plan',
    '.claude/skills/taiga-plan-backlog/agents/openai.yaml': 'interface: {}',
  });

  const result = await skills(['check', '--json'], root);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.json<SkillsCheck>(), { inSync: true, skills: ['taiga-plan-backlog'], differences: [] });
});

test('skills check exits 3 and names every file whose Claude copy is missing, changed or extra', async (t) => {
  const root = await repo(t, {
    '.agents/skills/taiga-apply-backlog/SKILL.md': 'apply v2',
    '.agents/skills/taiga-apply-backlog/agents/openai.yaml': 'policy: {}',
    '.agents/skills/taiga-plan-backlog/SKILL.md': 'plan',
    '.claude/skills/taiga-apply-backlog/SKILL.md': 'apply v1',
    '.claude/skills/taiga-apply-backlog/notes.md': 'stale',
    '.claude/skills/taiga-old/SKILL.md': 'removed from the source',
  });

  const result = await skills(['check', '--json'], root);

  assert.equal(result.code, 3, result.stderr);
  assert.deepEqual(result.json<SkillsCheck>(), {
    inSync: false,
    skills: ['taiga-apply-backlog', 'taiga-plan-backlog'],
    differences: [
      { skill: 'taiga-apply-backlog', file: 'SKILL.md', status: 'changed' },
      { skill: 'taiga-apply-backlog', file: 'agents/openai.yaml', status: 'missing' },
      { skill: 'taiga-apply-backlog', file: 'notes.md', status: 'extra' },
      { skill: 'taiga-old', file: 'SKILL.md', status: 'extra' },
      { skill: 'taiga-plan-backlog', file: 'SKILL.md', status: 'missing' },
    ],
  });
  const text = await skills(['check'], root);
  assert.equal(text.code, 3);
  assert.match(text.stdout, /\.claude\/skills\/taiga-apply-backlog\/SKILL\.md: changed/);
  assert.match(text.stdout, /taigent skills sync/);
});

test('skills check ignores skills without the taiga- prefix', async (t) => {
  const root = await repo(t, {
    '.agents/skills/tdd/SKILL.md': 'agents copy',
    '.claude/skills/tdd/SKILL.md': 'claude copy, edited',
    '.claude/skills/grill-me/SKILL.md': 'only on the Claude side',
  });

  const result = await skills(['check', '--json'], root);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.json<SkillsCheck>(), { inSync: true, skills: [], differences: [] });
});

test('skills sync makes the Claude copies identical and leaves other skills alone', async (t) => {
  const root = await repo(t, {
    '.agents/skills/taiga-apply-backlog/SKILL.md': 'apply v2',
    '.agents/skills/taiga-apply-backlog/agents/openai.yaml': 'policy: {}',
    '.agents/skills/taiga-plan-backlog/SKILL.md': 'plan',
    '.agents/skills/tdd/SKILL.md': 'agents copy',
    '.claude/skills/taiga-apply-backlog/SKILL.md': 'apply v1',
    '.claude/skills/taiga-apply-backlog/notes.md': 'stale',
    '.claude/skills/taiga-old/SKILL.md': 'removed from the source',
    '.claude/skills/tdd/SKILL.md': 'claude copy, edited',
  });

  const result = await skills(['sync', '--json'], root);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.json(), {
    skills: ['taiga-apply-backlog', 'taiga-plan-backlog'],
    synced: ['taiga-apply-backlog', 'taiga-plan-backlog'],
    removed: ['taiga-old'],
  });
  const claude = (file: string) => readFile(join(root, '.claude/skills', file), 'utf8');
  assert.equal(await claude('taiga-apply-backlog/SKILL.md'), 'apply v2');
  assert.equal(await claude('taiga-apply-backlog/agents/openai.yaml'), 'policy: {}');
  assert.equal(await claude('taiga-plan-backlog/SKILL.md'), 'plan');
  await assert.rejects(claude('taiga-apply-backlog/notes.md'), { code: 'ENOENT' });
  await assert.rejects(claude('taiga-old/SKILL.md'), { code: 'ENOENT' });
  assert.equal(await claude('tdd/SKILL.md'), 'claude copy, edited');
  assert.equal(await readFile(join(root, '.agents/skills/tdd/SKILL.md'), 'utf8'), 'agents copy');

  const check = await skills(['check'], root);
  assert.equal(check.code, 0, check.stdout);
  const again = await skills(['sync', '--json'], root);
  assert.deepEqual(again.json(), { skills: ['taiga-apply-backlog', 'taiga-plan-backlog'], synced: [], removed: [] });
});

test('skills commands outside a repository root are a usage error (exit 2)', async (t) => {
  const root = await repo(t, { 'README.md': 'not a repository root' });

  const check = await skills(['check'], root);
  const sync = await skills(['sync'], root);
  const noAction = await skills([], root);

  assert.equal(check.code, 2);
  assert.match(check.stderr, /no \.agents\/skills directory/);
  assert.equal(sync.code, 2);
  assert.equal(noAction.code, 2);
  assert.match(noAction.stderr, /skills needs one of: sync, check/);
});

test('the repository Claude copies of the taiga-* skills match .agents/skills', async () => {
  const result = await skills(['check'], REPO_ROOT);

  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
});

/** Taiga MCP tools that only read (taiga-mcp-server@1.9.20). Write tools and banned tools are absent. */
const MCP_READ_TOOLS = new Set(
  [
    'listProjects', 'getProject', 'listEpics', 'getEpic', 'listUserStories', 'getUserStory', 'listIssues', 'getIssue',
    'listMilestones', 'getMilestone', 'getMilestoneStats', 'getIssuesByMilestone', 'listComments', 'listAttachments',
    'listWikiPages', 'getWikiPage', 'advancedSearch', 'queryHelp', 'validateQuery',
  ].map((tool) => `mcp__taiga__${tool}`),
);

interface SkillFrontmatter {
  name: string;
  description: string;
  'disable-model-invocation'?: boolean;
  'allowed-tools'?: string;
}

async function readSkill(skill: string): Promise<{ frontmatter: SkillFrontmatter; allowedTools: string[]; openai: { policy?: { allow_implicit_invocation?: boolean } } }> {
  const dir = join(REPO_ROOT, '.agents/skills', skill);
  const text = await readFile(join(dir, 'SKILL.md'), 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  assert.ok(match, `${skill}/SKILL.md has YAML frontmatter`);
  const frontmatter = parse(match[1]!) as SkillFrontmatter;
  return {
    frontmatter,
    // Space-separated, but shell rules like `Bash(npx taigent plan *)` contain spaces.
    allowedTools: frontmatter['allowed-tools']?.match(/\S*\([^)]*\)|\S+/g) ?? [],
    openai: parse(await readFile(join(dir, 'agents/openai.yaml'), 'utf8')) as { policy?: { allow_implicit_invocation?: boolean } },
  };
}

test('taiga-* skills follow Agent Skills and pre-approve only taigent commands and Taiga MCP read tools', async () => {
  const names = (await readdir(join(REPO_ROOT, '.agents/skills'))).filter((name) => name.startsWith('taiga-'));
  assert.ok(names.includes('taiga-plan-backlog') && names.includes('taiga-apply-backlog'), names.join(', '));

  for (const name of names) {
    const { frontmatter, allowedTools } = await readSkill(name);
    assert.equal(frontmatter.name, name);
    assert.match(frontmatter.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(frontmatter.description.length > 0 && frontmatter.description.length <= 1024, `${name}: description length`);
    for (const tool of allowedTools) {
      assert.ok(/^(Bash|PowerShell)\(npx taigent [a-z]+ \*\)$/.test(tool) || MCP_READ_TOOLS.has(tool), `${name}: allowed-tools has ${tool}`);
    }
  }
});

test('taiga-apply-backlog runs only when invoked explicitly, on Claude Code and on Codex', async () => {
  const { frontmatter, allowedTools, openai } = await readSkill('taiga-apply-backlog');

  assert.equal(frontmatter['disable-model-invocation'], true);
  assert.equal(openai.policy?.allow_implicit_invocation, false);
  assert.deepEqual(allowedTools.filter((tool) => tool.includes('(')), [
    'Bash(npx taigent validate *)',
    'Bash(npx taigent plan *)',
    'Bash(npx taigent apply *)',
    'PowerShell(npx taigent validate *)',
    'PowerShell(npx taigent plan *)',
    'PowerShell(npx taigent apply *)',
  ]);
});

test('taiga-plan-backlog only writes files: it pre-approves validate, never apply', async () => {
  const { allowedTools } = await readSkill('taiga-plan-backlog');

  assert.deepEqual(allowedTools.filter((tool) => tool.includes('(')), ['Bash(npx taigent validate *)', 'PowerShell(npx taigent validate *)']);
});
