import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeSprintAdd, planSprintAdd } from '../src/sprint.ts';
import { TaigaClient, TaigaConflictError } from '../src/taiga/client.ts';
import { startFakeTaiga, type FakeTaiga } from './support/fake-taiga.ts';
import { startHarness, writes } from './support/harness.ts';

// `taigent sprint`: list sprints with their stories, create a sprint, put stories into one. Writes
// go through the review gate like bootstrap/upload: --yes writes, --dry-run plans, neither refuses with exit 2.

interface SprintListJson {
  project: { id: number; slug: string; name: string };
  sprints: { id: number; name: string; start: string; finish: string; closed: boolean; stories: { ref: number; subject: string }[] }[];
}

interface PlanJson {
  changes: boolean;
  summary: Record<string, number>;
  operations: { action: string; ref?: number; id: number | null; name?: string; from?: { id: number; name: string } | null }[];
}

interface ReportJson {
  operations: { result: string; id: number | null; ref?: number }[];
  summary: Record<string, number>;
}

function seed(fake: FakeTaiga) {
  const alpha = fake.addProject({ slug: 'alpha', name: 'Alpha' });
  const other = fake.addProject({ slug: 'other', name: 'Other' });
  const s1 = fake.addMilestone({ project: alpha.id, name: 'Sprint 1', estimated_start: '2026-11-02', estimated_finish: '2026-11-15', closed: true });
  const s2 = fake.addMilestone({ project: alpha.id, name: 'Sprint 2', estimated_start: '2026-11-16', estimated_finish: '2026-11-29' });
  fake.addMilestone({ project: other.id, name: 'Sprint 3', estimated_start: '2026-11-30', estimated_finish: '2026-12-13' });
  const login = Object.assign(fake.addUserStory({ project: alpha.id, subject: 'Login' }), { milestone: s1.id });
  const logout = Object.assign(fake.addUserStory({ project: alpha.id, subject: 'Logout' }), { milestone: s2.id });
  const profile = fake.addUserStory({ project: alpha.id, subject: 'Profile' });
  const task = fake.addTask({ project: alpha.id, subject: 'A task', user_story: login.id });
  const foreign = fake.addUserStory({ project: other.id, subject: 'Foreign' });
  return { alpha, other, s1, s2, login, logout, profile, task, foreign };
}

test('sprint list shows every sprint of the project, newest first, with its stories; read-only', async (t) => {
  const h = await startHarness(t);
  const { alpha, s1, s2, login, logout } = seed(h.fake);

  const result = await h.taigent(['sprint', 'list', '--project', 'alpha', '--json']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.json<SprintListJson>(), {
    project: { id: alpha.id, slug: 'alpha', name: 'Alpha' },
    sprints: [
      { id: s2.id, name: 'Sprint 2', start: '2026-11-16', finish: '2026-11-29', closed: false, stories: [{ ref: logout.ref, subject: 'Logout' }] },
      { id: s1.id, name: 'Sprint 1', start: '2026-11-02', finish: '2026-11-15', closed: true, stories: [{ ref: login.ref, subject: 'Login' }] },
    ],
  });

  const text = await h.taigent(['sprint', 'list', '--project', 'alpha']);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /Sprints of project Alpha \(alpha\): 2/);
  assert.match(text.stdout, new RegExp(`Sprint 2  2026-11-16 → 2026-11-29  active  \\(id ${s2.id}\\)\\n    #${logout.ref} Logout`));
  assert.match(text.stdout, /Sprint 1  2026-11-02 → 2026-11-15  closed/);
  assert.deepEqual(writes(h.fake), []);
});

test('sprint create needs --yes, plans with --dry-run, then creates the sprint; a second run is unchanged', async (t) => {
  const h = await startHarness(t);
  const { alpha } = seed(h.fake);
  const args = ['sprint', 'create', '--project', 'alpha', '--name', 'Sprint 3', '--from', '2026-11-30', '--to', '2026-12-13'];

  const refused = await h.taigent(args);
  assert.equal(refused.code, 2, refused.stderr);
  assert.match(refused.stdout, /\+ sprint "Sprint 3" 2026-11-30 → 2026-12-13/);
  assert.match(refused.stderr, /refusing to sprint create without --yes/);

  const dry = await h.taigent([...args, '--dry-run', '--json']);
  assert.equal(dry.code, 3, dry.stderr);
  assert.deepEqual(dry.json<PlanJson>().summary, { create: 1, skip: 0 });
  assert.deepEqual(writes(h.fake), []);

  const created = await h.taigent([...args, '--yes', '--json']);
  assert.equal(created.code, 0, created.stderr);
  const report = created.json<ReportJson>();
  assert.deepEqual(report.summary, { created: 1, unchanged: 0 });
  assert.deepEqual(writes(h.fake), ['POST /milestones']);
  const sprint = h.fake.state.milestones.find((m) => m.project === alpha.id && m.name === 'Sprint 3');
  assert.ok(sprint);
  assert.equal(report.operations[0]!.id, sprint.id);
  assert.deepEqual([sprint.estimated_start, sprint.estimated_finish, sprint.slug], ['2026-11-30', '2026-12-13', 'sprint-3']);
  const body = h.fake.requests.find((r) => r.method === 'POST' && r.path === '/milestones')!.body;
  assert.deepEqual(body, { project: alpha.id, name: 'Sprint 3', estimated_start: '2026-11-30', estimated_finish: '2026-12-13' });

  // Same name and days: unchanged, nothing written, with or without --yes.
  for (const extra of [[], ['--yes']]) {
    const again = await h.taigent([...args, ...extra]);
    assert.equal(again.code, 0, again.stderr);
    if (extra.length === 0) assert.match(again.stdout, /No changes\./);
    else assert.match(again.stdout, /1 unchanged/);
  }
  assert.deepEqual(writes(h.fake), ['POST /milestones']);
});

test('sprint create refuses a taken name with other days, and bad dates, before writing', async (t) => {
  const h = await startHarness(t);
  seed(h.fake);
  const taken = await h.taigent(['sprint', 'create', '--project', 'alpha', '--name', 'Sprint 2', '--from', '2026-11-16', '--to', '2026-11-30', '--yes', '--json']);
  assert.equal(taken.code, 2, taken.stderr);
  assert.match(taken.json<{ error: { kind: string; message: string } }>().error.message, /"Sprint 2" of alpha already exists from 2026-11-16 to 2026-11-29/);

  const usage: [string[], RegExp][] = [
    [['--from', '2026-12-13', '--to', '2026-11-30'], /--from 2026-12-13 is after --to 2026-11-30/],
    [['--from', '2026-11-31', '--to', '2026-12-13'], /--from must be a calendar day/],
    [['--to', '2026-12-13'], /sprint needs --from/],
  ];
  for (const [dates, message] of usage) {
    const result = await h.taigent(['sprint', 'create', '--project', 'alpha', '--name', 'New', ...dates, '--yes']);
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, message);
  }
  const noName = await h.taigent(['sprint', 'create', '--project', 'alpha', '--from', '2026-11-30', '--to', '2026-12-13', '--yes']);
  assert.equal(noName.code, 2);
  assert.match(noName.stderr, /sprint create needs --name/);
  assert.deepEqual(writes(h.fake), []);
});

test('sprint add moves user stories into the sprint with their version; stories already in it are unchanged', async (t) => {
  const h = await startHarness(t);
  const { s1, s2, login, logout, profile } = seed(h.fake);
  const args = ['sprint', 'add', '--project', 'alpha', '--name', 'Sprint 2', String(login.ref), `#${logout.ref}`, String(profile.ref)];

  const refused = await h.taigent(args);
  assert.equal(refused.code, 2, refused.stderr);
  assert.match(refused.stderr, /refusing to sprint add without --yes/);
  assert.match(refused.stdout, new RegExp(`~ story #${login.ref} Login  \\(from sprint "Sprint 1"\\)`));

  const dry = await h.taigent([...args, '--dry-run', '--json']);
  assert.equal(dry.code, 3, dry.stderr);
  const plan = dry.json<PlanJson>();
  assert.deepEqual(plan.summary, { update: 2, skip: 1 });
  assert.deepEqual(plan.operations.map((op) => [op.ref, op.action, op.from?.id ?? null]), [
    [login.ref, 'update', s1.id],
    [logout.ref, 'skip', s2.id],
    [profile.ref, 'update', null],
  ]);
  assert.deepEqual(writes(h.fake), []);

  const versions = [login.version, profile.version];
  const applied = await h.taigent([...args, '--yes', '--json']);
  assert.equal(applied.code, 0, applied.stderr);
  assert.deepEqual(applied.json<ReportJson>().summary, { updated: 2, unchanged: 1 });
  assert.deepEqual(writes(h.fake), [`PATCH /userstories/${login.id}`, `PATCH /userstories/${profile.id}`]);
  const bodies = h.fake.requests.filter((r) => r.method === 'PATCH').map((r) => r.body);
  assert.deepEqual(bodies, [{ milestone: s2.id, version: versions[0] }, { milestone: s2.id, version: versions[1] }]);
  assert.deepEqual([login.milestone, logout.milestone, profile.milestone], [s2.id, s2.id, s2.id]);

  const again = await h.taigent([...args, '--yes']);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /3 unchanged/);
  assert.equal(writes(h.fake).length, 2);
});

test('sprint add refuses an unknown sprint or a ref that is no user story of the project, before any write', async (t) => {
  const h = await startHarness(t);
  const { login, task, foreign } = seed(h.fake);
  const cases: [string[], RegExp][] = [
    [['--name', 'Sprint 3', String(login.ref)], /no sprint named "Sprint 3" in alpha; its sprints: "Sprint 1", "Sprint 2"/],
    [['--name', 'Sprint 2', String(login.ref), String(task.ref), '999'], new RegExp(`not a user story of alpha: #${task.ref}, #999`)],
    [['--name', 'Sprint 2', String(foreign.ref + 1000)], /not a user story of alpha/],
  ];
  for (const [rest, message] of cases) {
    const result = await h.taigent(['sprint', 'add', '--project', 'alpha', ...rest, '--yes']);
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, message);
  }
  const usage = await h.taigent(['sprint', 'add', '--project', 'alpha', '--name', 'Sprint 2', 'abc', '--yes']);
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /sprint add needs user story refs/);
  const none = await h.taigent(['sprint', 'add', '--project', 'alpha', '--name', 'Sprint 2', '--yes']);
  assert.equal(none.code, 2);
  assert.match(none.stderr, /sprint add needs the refs/);
  assert.deepEqual(writes(h.fake), []);
});

test('sprint add turns a stale story version into a conflict naming its ref', async (t) => {
  const fake = await startFakeTaiga();
  t.after(() => fake.close());
  const { s1, profile } = seed(fake);
  const client = await TaigaClient.connect({ apiUrl: fake.url, credentials: { username: fake.user.username, password: fake.user.password }, retryUnitMs: 0 });
  const plan = await planSprintAdd(client, 'alpha', 'Sprint 2', [profile.ref]);
  // Someone puts the story into another sprint between the plan and the write.
  fake.editItem(profile, { milestone: s1.id });
  await assert.rejects(executeSprintAdd(plan, client), (error) => error instanceof TaigaConflictError && error.key === `#${profile.ref}`);
  assert.equal(profile.milestone, s1.id);
});

test('sprint options are checked: subcommand, --name and --from/--to only where they apply', async (t) => {
  const h = await startHarness(t);
  seed(h.fake);
  const cases: [string[], RegExp][] = [
    [['sprint', '--project', 'alpha'], /sprint needs one of: list, create, add/],
    [['sprint', 'delete', '--project', 'alpha'], /sprint needs one of/],
    [['sprint', 'list', '--project', 'alpha', '--name', 'X'], /--name applies only to sprint create and sprint add/],
    [['sprint', 'list', '--project', 'alpha', '--from', '2026-11-01', '--to', '2026-11-02'], /--from and --to apply only to tickets and sprint create/],
    [['sprint', 'list'], /--project <slug> is required/],
    [['report', '--project', 'alpha', '--name', 'X'], /--name applies only/],
  ];
  for (const [args, message] of cases) {
    const result = await h.taigent(args);
    assert.equal(result.code, 2, `${args.join(' ')}: ${result.stderr}`);
    assert.match(result.stderr, message);
  }
  assert.equal(h.fake.requests.length, 0);
});

test('under TAIGENT_READ_ONLY sprint create/add --yes refuse before contacting Taiga; list and --dry-run still work', async (t) => {
  const h = await startHarness(t);
  const { profile } = seed(h.fake);
  const READ_ONLY = { env: { TAIGENT_READ_ONLY: '1' } };
  const create = ['sprint', 'create', '--project', 'alpha', '--name', 'Sprint 3', '--from', '2026-11-30', '--to', '2026-12-13'];
  const add = ['sprint', 'add', '--project', 'alpha', '--name', 'Sprint 2', String(profile.ref)];
  for (const args of [create, add]) {
    const result = await h.taigent([...args, '--yes', '--json'], READ_ONLY);
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, new RegExp(`taigent: sprint ${args[1]} writes to Taiga.*TAIGENT_READ_ONLY`));
    assert.equal(result.json<{ error: { kind: string } }>().error.kind, 'read-only');
  }
  assert.equal(h.fake.requests.length, 0, 'refused before contacting Taiga');
  for (const args of [create, add]) assert.equal((await h.taigent([...args, '--dry-run'], READ_ONLY)).code, 3);
  assert.equal((await h.taigent(['sprint', 'list', '--project', 'alpha'], READ_ONLY)).code, 0);
  assert.deepEqual(writes(h.fake), []);
});
