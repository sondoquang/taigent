import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

test('skills check ignores skills that are not Taigent skills', async (t) => {
  const root = await repo(t, {
    '.agents/skills/tdd/SKILL.md': 'agents copy',
    '.claude/skills/tdd/SKILL.md': 'claude copy, edited',
    '.claude/skills/grill-me/SKILL.md': 'only on the Claude side',
  });

  const result = await skills(['check', '--json'], root);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.json<SkillsCheck>(), { inSync: true, skills: [], differences: [] });
});

test('skills check and sync cover ask-taigent like the taiga-* skills', async (t) => {
  const root = await repo(t, {
    '.agents/skills/ask-taigent/SKILL.md': 'router v2',
    '.agents/skills/ask-matt/SKILL.md': 'vendored',
    '.agents/skills/taiga-setup/SKILL.md': 'setup',
    '.claude/skills/ask-taigent/SKILL.md': 'router v1',
    '.claude/skills/taiga-setup/SKILL.md': 'setup',
  });

  const check = await skills(['check', '--json'], root);
  assert.equal(check.code, 3, check.stderr);
  assert.deepEqual(check.json<SkillsCheck>(), {
    inSync: false,
    skills: ['ask-taigent', 'taiga-setup'],
    differences: [{ skill: 'ask-taigent', file: 'SKILL.md', status: 'changed' }],
  });

  const sync = await skills(['sync', '--json'], root);
  assert.equal(sync.code, 0, sync.stderr);
  assert.deepEqual(sync.json(), { skills: ['ask-taigent', 'taiga-setup'], synced: ['ask-taigent'], removed: [] });
  assert.equal(await readFile(join(root, '.claude/skills/ask-taigent/SKILL.md'), 'utf8'), 'router v2');
  await assert.rejects(readFile(join(root, '.claude/skills/ask-matt/SKILL.md')), { code: 'ENOENT' });
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

const TAIGENT_SKILLS = ['ask-taigent', 'taiga-apply-backlog', 'taiga-bootstrap-project', 'taiga-my-tickets', 'taiga-plan-backlog', 'taiga-setup', 'taiga-status-report', 'taiga-upload-docs'];

test('the repository holds exactly the Taigent skills, with Claude copies that match .agents/skills', async () => {
  const result = await skills(['check', '--json'], REPO_ROOT);

  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  assert.deepEqual(result.json<SkillsCheck>().skills, TAIGENT_SKILLS);
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

/** `taigent` commands a skill may pre-approve; the writing ones make a skill explicit-only. */
const TAIGENT_COMMANDS = ['validate', 'plan', 'apply', 'bootstrap', 'upload', 'closed', 'tickets'];
const WRITING_COMMANDS = ['apply', 'bootstrap', 'upload'];
const SHELL_RULE = new RegExp(`^(Bash|PowerShell)\\(npx taigent (${TAIGENT_COMMANDS.join('|')}) \\*\\)$`);

test('Taigent skills follow Agent Skills and pre-approve only taigent commands and Taiga MCP read tools', async () => {
  for (const name of TAIGENT_SKILLS) {
    const { frontmatter, allowedTools } = await readSkill(name);
    assert.equal(frontmatter.name, name);
    assert.match(frontmatter.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(frontmatter.description.length > 0 && frontmatter.description.length <= 1024, `${name}: description length`);
    for (const tool of allowedTools) {
      assert.ok(SHELL_RULE.test(tool) || MCP_READ_TOOLS.has(tool), `${name}: allowed-tools has ${tool}`);
    }
  }
});

test('Taigent skills that write to Taiga run only when invoked explicitly, on Claude Code and on Codex', async () => {
  const writers: string[] = [];
  for (const name of TAIGENT_SKILLS) {
    const { frontmatter, allowedTools, openai } = await readSkill(name);
    if (!allowedTools.some((tool) => WRITING_COMMANDS.includes(SHELL_RULE.exec(tool)?.[2] ?? ''))) continue;
    writers.push(name);
    assert.equal(frontmatter['disable-model-invocation'], true, `${name}: disable-model-invocation`);
    assert.equal(openai.policy?.allow_implicit_invocation, false, `${name}: agents/openai.yaml policy`);
  }

  assert.deepEqual(writers, ['taiga-apply-backlog', 'taiga-bootstrap-project', 'taiga-upload-docs']);
});

/** Each skill's shell rules: the commands it pre-approves, as Bash and as PowerShell rules. */
const shellRules = (...commands: string[]) => ['Bash', 'PowerShell'].flatMap((shell) => commands.map((command) => `${shell}(npx taigent ${command} *)`));

test('each taiga-* skill pre-approves only the taigent commands of its step', async () => {
  const expected: Record<string, string[]> = {
    'taiga-plan-backlog': shellRules('validate', 'plan'),
    'taiga-apply-backlog': shellRules('validate', 'plan', 'apply'),
    'taiga-bootstrap-project': shellRules('validate', 'bootstrap'),
    'taiga-upload-docs': shellRules('validate', 'upload'),
    'taiga-my-tickets': shellRules('tickets'),
    'taiga-status-report': [],
    'taiga-setup': [],
  };

  for (const [name, rules] of Object.entries(expected)) {
    const { allowedTools } = await readSkill(name);
    assert.deepEqual(allowedTools.filter((tool) => tool.includes('(')), rules, name);
  }
});

test('taiga-status-report reads Taiga through MCP read tools only, and may be invoked implicitly', async () => {
  const { frontmatter, allowedTools, openai } = await readSkill('taiga-status-report');

  assert.notEqual(frontmatter['disable-model-invocation'], true);
  assert.notEqual(openai.policy?.allow_implicit_invocation, false);
  for (const tool of ['listProjects', 'listEpics', 'listUserStories', 'getUserStory', 'listMilestones', 'getMilestone', 'getMilestoneStats', 'advancedSearch']) {
    assert.ok(allowedTools.includes(`mcp__taiga__${tool}`), `allowed-tools has mcp__taiga__${tool}`);
  }
  assert.ok(allowedTools.every((tool) => MCP_READ_TOOLS.has(tool)), allowedTools.join(' '));
  const skill = await readFile(join(REPO_ROOT, '.agents/skills/taiga-status-report/SKILL.md'), 'utf8');
  assert.doesNotMatch(skill, /\bclosed --|taigent closed/);
  assert.match(skill, /taiga-my-tickets/);
});

test('taiga-my-tickets pre-approves only taigent tickets, may be invoked implicitly, and ask-taigent routes to it', async () => {
  const { frontmatter, allowedTools, openai } = await readSkill('taiga-my-tickets');

  assert.notEqual(frontmatter['disable-model-invocation'], true);
  assert.equal(openai.policy?.allow_implicit_invocation, true);
  assert.deepEqual(allowedTools, shellRules('tickets'));
  const router = await readFile(join(REPO_ROOT, '.agents/skills/ask-taigent/SKILL.md'), 'utf8');
  assert.match(router, /`taiga-my-tickets`/);
});

test('taiga-setup gives the same Taiga MCP server entries as the repository configs', async () => {
  const skill = await readFile(join(REPO_ROOT, '.agents/skills/taiga-setup/SKILL.md'), 'utf8');
  const block = (lang: string) => new RegExp(`^\`\`\`${lang}\\r?\\n([\\s\\S]*?)^\`\`\``, 'm').exec(skill)?.[1] ?? '';
  const lines = (text: string) => text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));

  assert.deepEqual(JSON.parse(block('json')), JSON.parse(await readFile(join(REPO_ROOT, '.mcp.json'), 'utf8')));
  assert.deepEqual(lines(block('toml')), lines(await readFile(join(REPO_ROOT, '.codex/config.toml'), 'utf8')));
});
