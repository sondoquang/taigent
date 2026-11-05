import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FakeTaiga, FakeTask, FakeUserStory } from './support/fake-taiga.ts';
import { startHarness, writes } from './support/harness.ts';

// UTC+7 without daylight saving, so a local day runs from 17:00Z the day before to 17:00Z.
const TZ = 'Asia/Ho_Chi_Minh';

interface PeriodJson {
  id: string;
  name: string;
  start: string;
  finish: string;
  current: boolean;
}

interface Throughput {
  stories: { assigned: number; completed: number };
  tasks: { assigned: number; completed: number };
}

interface LeadTime {
  medianDays: number | null;
  count: number;
}

interface ItemJson {
  type: 'story' | 'task';
  id: number;
  ref: number;
  subject: string;
  status: string;
  assignees: number[];
  dueDate: string | null;
  blocked: boolean;
  points: number | null;
}

interface DeveloperJson {
  me: { id: number; username: string };
  people: { id: number; username: string }[];
  periods: { period: string; all: Throughput; mine: Throughput }[];
  leadTime: { all: { stories: LeadTime; tasks: LeadTime }; mine: { stories: LeadTime; tasks: LeadTime } };
  workload: { assignee: number | null; username: string | null; stories: number; tasks: number; points: number }[];
  blocked: ItemJson[];
  overdue: ItemJson[];
}

interface MetricsJson {
  project: { id: number; slug: string; name: string };
  generatedAt: string;
  today: string;
  cadence: 'sprint' | 'week';
  periods: PeriodJson[];
  developer: DeveloperJson;
  warnings: { code: string; message: string }[];
  unavailable: { metric: string; reason: string; message: string }[];
}

/** Today in `TZ`, as YYYY-MM-DD (`en-CA` formats dates that way). */
function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
}

/** The day `offset` days from today in `TZ`, YYYY-MM-DD: the seeds are relative to the real clock. */
function day(offset: number): string {
  const [year, month, date] = todayIn(TZ).split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date + offset)).toISOString().slice(0, 10);
}

/** An instant at `hour` (local time in `TZ`) of the day `offset` days from today, ISO 8601. */
function at(offset: number, hour = 10): string {
  return new Date(`${day(offset)}T${String(hour).padStart(2, '0')}:00:00+07:00`).toISOString();
}

/**
 * Project alpha with members alice and bob besides the fake user: a closed sprint, the current one and one not
 * started yet. Another project has a sprint of its own.
 */
function seedSprints(fake: FakeTaiga) {
  const me = fake.user.id;
  const alice = fake.addUser({ username: 'alice' }).id;
  const bob = fake.addUser({ username: 'bob' }).id;
  const alpha = fake.addProject({ slug: 'alpha', name: 'Alpha', members: [me, alice, bob] });
  const other = fake.addProject({ slug: 'other', name: 'Other' });
  const past = fake.addMilestone({ project: alpha.id, name: 'Sprint 1', estimated_start: day(-20), estimated_finish: day(-7), closed: true });
  const current = fake.addMilestone({ project: alpha.id, name: 'Sprint 2', estimated_start: day(-6), estimated_finish: day(7) });
  fake.addMilestone({ project: alpha.id, name: 'Sprint 3', estimated_start: day(8), estimated_finish: day(21) });
  fake.addMilestone({ project: other.id, name: 'Other sprint', estimated_start: day(-6), estimated_finish: day(7) });
  return { me, alice, bob, alpha, past, current };
}

interface WorkFields {
  /** Status name: one of the project's, which also decides whether the item is closed. */
  status?: string;
  /** Days from today it was created and closed. */
  created?: number;
  closed?: number;
  due?: number;
  blocked?: boolean;
}

function statusFields(fake: FakeTaiga, kind: 'userstory' | 'task', project: number, name: string) {
  const statuses = kind === 'userstory' ? fake.state.storyStatuses : fake.state.taskStatuses;
  const status = statuses.find((candidate) => candidate.project === project && candidate.name === name)!;
  return { status: status.id, status_name: status.name, is_closed: status.is_closed };
}

function addStory(fake: FakeTaiga, project: number, subject: string, fields: WorkFields & { assigned?: number[]; points?: number }): FakeUserStory {
  const { status = 'New', created = -30, closed, due, blocked = false, assigned = [], points = null } = fields;
  return Object.assign(fake.addUserStory({ project, subject }), {
    ...statusFields(fake, 'userstory', project, status),
    created_date: at(created),
    finish_date: closed === undefined ? null : at(closed),
    due_date: due === undefined ? null : day(due),
    is_blocked: blocked,
    assigned_users: assigned,
    assigned_to: assigned[0] ?? null,
    total_points: points,
  });
}

function addTask(fake: FakeTaiga, project: number, subject: string, fields: WorkFields & { assigned?: number }): FakeTask {
  const { status = 'New', created = -30, closed, due, blocked = false, assigned = null } = fields;
  return Object.assign(fake.addTask({ project, subject }), {
    ...statusFields(fake, 'task', project, status),
    created_date: at(created),
    finished_date: closed === undefined ? null : at(closed),
    due_date: due === undefined ? null : day(due),
    is_blocked: blocked,
    assigned_to: assigned,
  });
}

test('metrics of a scrum project: periods are the started sprints, phase 2 metrics are unavailable, nothing is written', async (t) => {
  const h = await startHarness(t);
  const { alpha, past, current } = seedSprints(h.fake);

  const result = await h.taigent(['metrics', '--project', 'alpha', '--json'], { env: { TZ } });

  assert.equal(result.code, 0, result.stderr);
  const report = result.json<MetricsJson>();
  assert.deepEqual(report.project, { id: alpha.id, slug: 'alpha', name: 'Alpha' });
  assert.ok(!Number.isNaN(Date.parse(report.generatedAt)), report.generatedAt);
  assert.equal(report.today, todayIn(TZ));
  assert.equal(report.cadence, 'sprint');
  assert.deepEqual(report.periods, [
    { id: `sprint:${past.id}`, name: 'Sprint 1', start: day(-20), finish: day(-7), current: false },
    { id: `sprint:${current.id}`, name: 'Sprint 2', start: day(-6), finish: day(7), current: true },
  ]);
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(
    report.unavailable.map(({ metric, reason }) => [metric, reason]),
    [
      ['developer.cycleTime', 'history'],
      ['productOwner.planned.sprintStart', 'history'],
      ['productOwner.scopeChange', 'history'],
      ['developer.bugs.reopenRate', 'history'],
      ['productOwner.bugTrend.reopened', 'history'],
      ['businessAnalyst.requirementChange', 'history'],
    ],
  );
  assert.ok(report.unavailable.every(({ message }) => message.length > 0));
  assert.deepEqual(writes(h.fake), []);
});

test('developer counts stories and tasks apart per sprint, for the team and for me, closed by the status flag', async (t) => {
  const h = await startHarness(t);
  const { me, alice, bob, alpha, past, current } = seedSprints(h.fake);
  // A story status named Closed that is not closed, and a task status with another name that is.
  h.fake.addStatus('userstory', { project: alpha.id, name: 'Closed', is_closed: false });
  h.fake.addStatus('task', { project: alpha.id, name: 'Shipped', is_closed: true });
  const p = alpha.id;
  addStory(h.fake, p, 'Login', { status: 'Done', created: -25, closed: -10, assigned: [me] });
  addStory(h.fake, p, 'Signup', { status: 'Done', created: -8, closed: -2, assigned: [alice, me] });
  addStory(h.fake, p, 'Profile', { status: 'In progress', created: -3, assigned: [alice], points: 5 });
  addStory(h.fake, p, 'Billing', { created: -30, points: 3 });
  addStory(h.fake, p, 'Not closed', { status: 'Closed', created: -1, assigned: [bob], points: 2 });
  addStory(h.fake, p, 'Long ago', { status: 'Done', created: -50, closed: -40, assigned: [me] });
  addTask(h.fake, p, 'Form', { status: 'Closed', created: -5, closed: -1, assigned: me });
  addTask(h.fake, p, 'Schema', { status: 'Shipped', created: -12, closed: -9, assigned: alice });
  addTask(h.fake, p, 'Review', { status: 'Ready for test', created: -4, assigned: me });
  addTask(h.fake, p, 'Docs', { created: -2 });

  const result = await h.taigent(['metrics', '--project', 'alpha', '--json'], { env: { TZ } });

  assert.equal(result.code, 0, result.stderr);
  const { developer } = result.json<MetricsJson>();
  assert.deepEqual(developer.me, { id: me, username: 'taigent-bot' });
  assert.deepEqual(
    developer.people.map(({ username }) => username).sort(),
    ['alice', 'bob', 'taigent-bot'],
  );
  const counts = (stories: [number, number], tasks: [number, number]): Throughput => ({
    stories: { assigned: stories[0], completed: stories[1] },
    tasks: { assigned: tasks[0], completed: tasks[1] },
  });
  assert.deepEqual(developer.periods, [
    // Login and Signup were open in Sprint 1 and Login closed in it; Schema closed in it under "Shipped".
    { period: `sprint:${past.id}`, all: counts([2, 1], [1, 1]), mine: counts([2, 1], [0, 0]) },
    // "Not closed" is open whatever its status's name; Review (Ready for test) is open too.
    { period: `sprint:${current.id}`, all: counts([3, 1], [2, 1]), mine: counts([1, 1], [2, 1]) },
  ]);
  // Created to closed, in days: Login 15 and Signup 6; Form 4 and Schema 3. Long ago closed before the periods.
  assert.deepEqual(developer.leadTime, {
    all: { stories: { medianDays: 10.5, count: 2 }, tasks: { medianDays: 3.5, count: 2 } },
    mine: { stories: { medianDays: 10.5, count: 2 }, tasks: { medianDays: 4, count: 1 } },
  });
  assert.deepEqual(developer.workload, [
    { assignee: alice, username: 'alice', stories: 1, tasks: 0, points: 5 },
    { assignee: bob, username: 'bob', stories: 1, tasks: 0, points: 2 },
    { assignee: me, username: 'taigent-bot', stories: 0, tasks: 1, points: 0 },
    { assignee: null, username: null, stories: 1, tasks: 1, points: 3 },
  ]);
});

test('developer lists open blocked and overdue work with assignees: due yesterday is overdue, due today is not', async (t) => {
  const h = await startHarness(t);
  const { me, alice, alpha } = seedSprints(h.fake);
  const p = alpha.id;
  const sso = addStory(h.fake, p, 'SSO', { status: 'In progress', blocked: true, due: -1, assigned: [alice, me], points: 3 });
  addStory(h.fake, p, 'Blocked but done', { status: 'Done', closed: -1, blocked: true, due: -5 });
  addStory(h.fake, p, 'Due today', { due: 0, assigned: [me] });
  const lateTask = addTask(h.fake, p, 'Migrate', { status: 'In progress', due: -3 });
  const blockedTask = addTask(h.fake, p, 'Deploy', { blocked: true, due: 1, assigned: alice });
  addTask(h.fake, p, 'Closed late', { status: 'Closed', closed: -1, due: -2 });

  const result = await h.taigent(['metrics', '--project', 'alpha', '--json'], { env: { TZ } });

  assert.equal(result.code, 0, result.stderr);
  const { developer } = result.json<MetricsJson>();
  const ssoJson: ItemJson = {
    type: 'story', id: sso.id, ref: sso.ref, subject: 'SSO', status: 'In progress', assignees: [alice, me], dueDate: day(-1), blocked: true, points: 3,
  };
  const deployJson: ItemJson = {
    type: 'task', id: blockedTask.id, ref: blockedTask.ref, subject: 'Deploy', status: 'New', assignees: [alice], dueDate: day(1), blocked: true, points: null,
  };
  const migrateJson: ItemJson = {
    type: 'task', id: lateTask.id, ref: lateTask.ref, subject: 'Migrate', status: 'In progress', assignees: [], dueDate: day(-3), blocked: false, points: null,
  };
  assert.deepEqual(developer.blocked, [ssoJson, deployJson]);
  assert.deepEqual(developer.overdue, [migrateJson, ssoJson]);
});

test('metrics of a kanban project counts by week, Monday to Sunday, with a warning and no sprint read', async (t) => {
  const h = await startHarness(t);
  const board = h.fake.addProject({ slug: 'board', name: 'Board', modules: { is_backlog_activated: false } });
  // Days from today back to this week's Monday (getUTCDay of a UTC date: 0 is Sunday).
  const sinceMonday = (new Date(`${day(0)}T00:00:00Z`).getUTCDay() + 6) % 7;
  addStory(h.fake, board.id, 'Card', { status: 'Done', created: -sinceMonday - 8, closed: -sinceMonday, assigned: [h.fake.user.id] });
  addTask(h.fake, board.id, 'Step', { status: 'Closed', created: -sinceMonday - 8, closed: -sinceMonday - 1, assigned: h.fake.user.id });

  const result = await h.taigent(['metrics', '--project', 'board', '--json'], { env: { TZ } });

  assert.equal(result.code, 0, result.stderr);
  const report = result.json<MetricsJson>();
  assert.equal(report.cadence, 'week');
  assert.deepEqual(
    report.periods,
    [5, 4, 3, 2, 1, 0].map((weeksAgo) => {
      const start = day(-sinceMonday - 7 * weeksAgo);
      return { id: `week:${start}`, name: `Week of ${start}`, start, finish: day(-sinceMonday - 7 * weeksAgo + 6), current: weeksAgo === 0 };
    }),
  );
  // The card closed on this Monday, the step on last Sunday.
  assert.deepEqual(
    report.developer.periods.slice(-2).map(({ all }) => [all.stories.completed, all.tasks.completed]),
    [[0, 1], [1, 0]],
  );
  assert.deepEqual(report.warnings.map(({ code }) => code), ['kanban']);
  assert.ok(!h.fake.requests.some((request) => request.path.startsWith('/milestones')), 'a kanban project has no sprints to read');
});

test('metrics reads every story and task of the project, beyond Taiga’s 30-item page', async (t) => {
  const h = await startHarness(t);
  const { me, alpha } = seedSprints(h.fake);
  for (let i = 1; i <= 35; i += 1) {
    addStory(h.fake, alpha.id, `Story ${i}`, { assigned: [me], points: 1 });
    addTask(h.fake, alpha.id, `Task ${i}`, { assigned: me });
  }

  const result = await h.taigent(['metrics', '--project', 'alpha', '--json'], { env: { TZ } });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.json<MetricsJson>().developer.workload, [
    { assignee: me, username: 'taigent-bot', stories: 35, tasks: 35, points: 35 },
    { assignee: null, username: null, stories: 0, tasks: 0, points: 0 },
  ]);
});

test('metrics prints a text summary without --json', async (t) => {
  const h = await startHarness(t);
  const { me, alice, alpha } = seedSprints(h.fake);
  const sso = addStory(h.fake, alpha.id, 'SSO', { status: 'In progress', blocked: true, due: -1, assigned: [alice, me], points: 3 });
  addTask(h.fake, alpha.id, 'Form', { status: 'Closed', created: -5, closed: -1, assigned: me });

  const result = await h.taigent(['metrics', '--project', 'alpha'], { env: { TZ } });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^Metrics of Alpha \\(alpha\\) on ${todayIn(TZ)}, by sprint\\n`));
  assert.match(result.stdout, /Developer \(mine: taigent-bot\):/);
  assert.match(result.stdout, /Sprint 2 \(current\): stories 1 assigned, 0 completed; tasks 1 assigned, 1 completed/);
  assert.match(result.stdout, /Lead time \(median\): stories none closed, tasks 4 days \(1 closed\)/);
  assert.match(result.stdout, /alice: 1 story \(3 points\), 0 tasks/);
  assert.match(result.stdout, /Unassigned: 0 stories \(0 points\), 0 tasks/);
  assert.match(result.stdout, new RegExp(`Blocked \\(1\\):\\n {4}story #${sso.ref} SSO \\(In progress, due ${day(-1)}; alice, taigent-bot\\)`));
  assert.match(result.stdout, /Overdue \(1\):/);
  assert.match(result.stdout, /Not available yet:\n {2}developer\.cycleTime: needs the Taiga history/);
});

test('metrics works under TAIGENT_READ_ONLY=1', async (t) => {
  const h = await startHarness(t);
  seedSprints(h.fake);

  const result = await h.taigent(['metrics', '--project', 'alpha', '--json'], { env: { TZ, TAIGENT_READ_ONLY: '1' } });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json<MetricsJson>().project.slug, 'alpha');
  assert.deepEqual(writes(h.fake), []);
});

test('metrics exits 2 without login, without --project or for an unknown project, and 5 when Taiga fails', async (t) => {
  const h = await startHarness(t);
  const other = h.fake.addUser({ username: 'other' }).id;
  h.fake.addProject({ slug: 'private-other', members: [other] });
  seedSprints(h.fake);
  type ErrorJson = { error: { kind: string; message: string; status?: number | null } };

  const notLoggedIn = await h.taigent(['metrics', '--project', 'alpha', '--json'], { env: { TAIGA_PASSWORD: undefined } });
  assert.equal(notLoggedIn.code, 2, notLoggedIn.stderr);
  assert.equal(notLoggedIn.json<ErrorJson>().error.kind, 'login');

  const noProject = await h.taigent(['metrics', '--json']);
  assert.equal(noProject.code, 2, noProject.stderr);
  assert.match(noProject.stderr, /--project <slug> is required/);

  const hidden = await h.taigent(['metrics', '--project', 'private-other', '--json']);
  assert.equal(hidden.code, 2, hidden.stderr);
  assert.equal(hidden.json<ErrorJson>().error.kind, 'project');
  assert.match(hidden.stderr, /project "private-other" not found/);

  h.fake.intercept({ method: 'GET', path: '/tasks', status: 500, body: { _error_message: 'boom' } });
  const failing = await h.taigent(['metrics', '--project', 'alpha', '--json']);
  assert.equal(failing.code, 5, failing.stderr);
  assert.deepEqual([failing.json<ErrorJson>().error.kind, failing.json<ErrorJson>().error.status], ['taiga', 500]);
  assert.deepEqual(writes(h.fake), []);
});
