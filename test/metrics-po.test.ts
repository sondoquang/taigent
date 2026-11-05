import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FakeTaiga, FakeTask, FakeUserStory } from './support/fake-taiga.ts';
import { type Harness, startHarness, writes } from './support/harness.ts';

// UTC+7 without daylight saving, so a local day runs from 17:00Z the day before to 17:00Z.
const TZ = 'Asia/Ho_Chi_Minh';

type Level = 'green' | 'yellow' | 'red';

interface Progress {
  done: number;
  total: number;
}

interface CurrentSprintJson {
  id: number;
  name: string;
  start: string;
  finish: string;
  stories: Progress;
  tasks: Progress;
  points: Progress;
  days: { elapsed: number; total: number };
  ideal: { day: string; points: number }[];
}

interface HealthJson {
  sprintPace?: { level: Level; reason: string; sprint: string | null; behindPoints: number | null; behindPercent: number | null };
  overdue: { level: Level; reason: string; stories: number; tasks: number };
  openBugs: { level: Level; reason: string; risingPeriods: number };
  blocked: { level: Level; reason: string; stories: number };
}

interface ProductOwnerJson {
  currentSprint?: CurrentSprintJson | null;
  velocity?: { sprint: string; name: string; start: string; finish: string; points: number }[];
  planned?: { basis: string; sprints: { period: string; planned: number; completed: number }[] };
  health: HealthJson;
  report: Record<string, unknown>;
}

interface MetricsJson {
  productOwner: ProductOwnerJson;
  warnings: { code: string }[];
  unavailable: { metric: string }[];
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

/** An instant at 10:00 (local time in `TZ`) of the day `offset` days from today, ISO 8601. */
function at(offset: number): string {
  return new Date(`${day(offset)}T10:00:00+07:00`).toISOString();
}

function statusFields(fake: FakeTaiga, kind: 'userstory' | 'task', project: number, name: string) {
  const statuses = kind === 'userstory' ? fake.state.storyStatuses : fake.state.taskStatuses;
  const status = statuses.find((candidate) => candidate.project === project && candidate.name === name)!;
  return { status: status.id, status_name: status.name, is_closed: status.is_closed };
}

interface StoryFields {
  sprint?: number;
  points?: number;
  /** Days from today it closed (status Done); open (New) without it. */
  closed?: number;
  due?: number;
  blocked?: boolean;
}

function addStory(fake: FakeTaiga, project: number, subject: string, fields: StoryFields = {}): FakeUserStory {
  const { sprint = null, points = null, closed, due, blocked = false } = fields;
  return Object.assign(fake.addUserStory({ project, subject }), {
    ...statusFields(fake, 'userstory', project, closed === undefined ? 'New' : 'Done'),
    milestone: sprint,
    total_points: points,
    created_date: at(-60),
    finish_date: closed === undefined ? null : at(closed),
    due_date: due === undefined ? null : day(due),
    is_blocked: blocked,
  });
}

function addTask(fake: FakeTaiga, project: number, subject: string, fields: { sprint?: number; closed?: number; due?: number; blocked?: boolean } = {}): FakeTask {
  const { sprint = null, closed, due, blocked = false } = fields;
  return Object.assign(fake.addTask({ project, subject }), {
    ...statusFields(fake, 'task', project, closed === undefined ? 'New' : 'Closed'),
    milestone: sprint,
    created_date: at(-60),
    finished_date: closed === undefined ? null : at(closed),
    due_date: due === undefined ? null : day(due),
    is_blocked: blocked,
  });
}

function addBug(fake: FakeTaiga, project: number, subject: string, created: number) {
  const type = fake.state.issueTypes.find((value) => value.project === project && value.name === 'Bug')!.id;
  const status = fake.state.issueStatuses.find((value) => value.project === project && value.name === 'New')!.id;
  return Object.assign(fake.addIssue({ project, subject, type, status }), { created_date: at(created) });
}

async function metrics(h: Harness, slug: string): Promise<MetricsJson> {
  const result = await h.taigent(['metrics', '--project', slug, '--json'], { env: { TZ } });
  assert.equal(result.code, 0, result.stderr);
  return result.json<MetricsJson>();
}

/** `taigent report --json` of the project without its `project` field: the tables the PO section carries. */
async function reportTables(h: Harness, slug: string): Promise<Record<string, unknown>> {
  const result = await h.taigent(['report', '--project', slug, '--json']);
  assert.equal(result.code, 0, result.stderr);
  const { project: _project, ...tables } = result.json<Record<string, unknown>>();
  return tables;
}

/**
 * A scrum project with a current sprint from 5 days ago to 5 days from now (day 5 of 10, so the ideal line stands at
 * half the points today) holding `total` points, `done` of them closed.
 */
function seedPace(fake: FakeTaiga, slug: string, total: number, done: number) {
  const project = fake.addProject({ slug, name: slug });
  const sprint = fake.addMilestone({ project: project.id, name: 'Now', estimated_start: day(-5), estimated_finish: day(5) });
  addStory(fake, project.id, 'Done part', { sprint: sprint.id, points: done, closed: -1 });
  addStory(fake, project.id, 'Open part', { sprint: sprint.id, points: total - done });
  return { project, sprint };
}

test('product owner: current sprint with its ideal line, velocity of the last 6 closed sprints, planned vs completed, report tables', async (t) => {
  const h = await startHarness(t);
  const alpha = h.fake.addProject({ slug: 'alpha', name: 'Alpha' });
  const p = alpha.id;
  // Seven closed sprints of two weeks each, Sprint k closing k points; then the current sprint and a future one.
  const closed = [1, 2, 3, 4, 5, 6, 7].map((k) => {
    const start = -6 - 14 * (8 - k);
    const sprint = h.fake.addMilestone({ project: p, name: `Sprint ${k}`, estimated_start: day(start), estimated_finish: day(start + 13), closed: true });
    addStory(h.fake, p, `Shipped ${k}`, { sprint: sprint.id, points: k, closed: start + 10 });
    return sprint;
  });
  addStory(h.fake, p, 'Left over', { sprint: closed[6]!.id, points: 2 });
  const current = h.fake.addMilestone({ project: p, name: 'Sprint 8', estimated_start: day(-5), estimated_finish: day(5) });
  h.fake.addMilestone({ project: p, name: 'Sprint 9', estimated_start: day(6), estimated_finish: day(19) });
  const login = addStory(h.fake, p, 'Login', { sprint: current.id, points: 4, closed: -1 });
  addStory(h.fake, p, 'SSO', { sprint: current.id, points: 16, blocked: true });
  addTask(h.fake, p, 'Form', { sprint: current.id, closed: -2 });
  addTask(h.fake, p, 'Schema', { sprint: current.id });
  addStory(h.fake, p, 'Backlog');
  const auth = h.fake.addEpic({ project: p, subject: 'Auth' });
  h.fake.addEpicRelatedUserStory(auth.id, login.id);

  const { productOwner } = await metrics(h, 'alpha');

  assert.deepEqual(productOwner.currentSprint, {
    id: current.id,
    name: 'Sprint 8',
    start: day(-5),
    finish: day(5),
    stories: { done: 1, total: 2 },
    tasks: { done: 1, total: 2 },
    points: { done: 4, total: 20 },
    days: { elapsed: 5, total: 10 },
    // Linear from the 20 points on the first day to 0 on the last.
    ideal: Array.from({ length: 11 }, (_, index) => ({ day: day(-5 + index), points: 20 - 2 * index })),
  });
  // Sprint 1 is the 7th closed sprint back: left out. Oldest first.
  assert.deepEqual(
    productOwner.velocity,
    closed.slice(1).map((sprint, index) => ({ sprint: `sprint:${sprint.id}`, name: sprint.name, start: sprint.estimated_start, finish: sprint.estimated_finish, points: index + 2 })),
  );
  // Over the periods: the last 6 started sprints. Sprint 7 also holds the open "Left over".
  assert.deepEqual(productOwner.planned, {
    basis: 'current',
    sprints: [
      ...closed.slice(2, 6).map((sprint, index) => ({ period: `sprint:${sprint.id}`, planned: index + 3, completed: index + 3 })),
      { period: `sprint:${closed[6]!.id}`, planned: 9, completed: 7 },
      { period: `sprint:${current.id}`, planned: 20, completed: 4 },
    ],
  });
  assert.deepEqual(productOwner.report, await reportTables(h, 'alpha'));
  assert.deepEqual(writes(h.fake), []);
});

test('health: sprint pace behind the ideal line, more than 10% of the points yellow, more than 25% red', async (t) => {
  const h = await startHarness(t);
  // 20 points, half of them ideally left today: 12 left is 10% behind, 13 is 15%, 15 is 25%, 16 is 30%; 9 is ahead.
  const cases: [string, number, Level, number, number][] = [
    ['ahead', 11, 'green', -1, -5],
    ['ten', 8, 'green', 2, 10],
    ['fifteen', 7, 'yellow', 3, 15],
    ['quarter', 5, 'yellow', 5, 25],
    ['thirty', 4, 'red', 6, 30],
  ];
  const seeded = cases.map(([slug, done]) => seedPace(h.fake, slug, 20, done));

  for (const [index, [slug, , level, behindPoints, behindPercent]] of cases.entries()) {
    const { sprintPace } = (await metrics(h, slug)).productOwner.health;
    assert.deepEqual({ ...sprintPace, reason: undefined }, { level, reason: undefined, sprint: `sprint:${seeded[index]!.sprint.id}`, behindPoints, behindPercent }, slug);
    assert.match(sprintPace!.reason, new RegExp(`${20 - cases[index]![1]} of 20 points left`), slug);
  }
});

test('health: a scrum project with no open sprint holding today has no current sprint and a green pace', async (t) => {
  const h = await startHarness(t);
  const idle = h.fake.addProject({ slug: 'idle', name: 'Idle' });
  h.fake.addMilestone({ project: idle.id, name: 'Done', estimated_start: day(-20), estimated_finish: day(-7), closed: true });
  // Holds today but closed early.
  h.fake.addMilestone({ project: idle.id, name: 'Closed early', estimated_start: day(-6), estimated_finish: day(7), closed: true });

  const { productOwner } = await metrics(h, 'idle');

  assert.equal(productOwner.currentSprint, null);
  assert.deepEqual({ ...productOwner.health.sprintPace, reason: undefined }, { level: 'green', reason: undefined, sprint: null, behindPoints: null, behindPercent: null });
  assert.match(productOwner.health.sprintPace!.reason, /no open sprint/);
});

test('health on kanban: overdue 1–2 yellow and 3 red, blocked stories 1 yellow and 2 red, open bugs rising 1 period yellow and 2 red; no sprint metrics', async (t) => {
  const h = await startHarness(t);
  const board = (slug: string) => h.fake.addProject({ slug, name: slug, modules: { is_backlog_activated: false } }).id;
  // All green: due today is not overdue, a blocked task or a closed blocked story is not a blocked story.
  const calm = board('calm');
  addStory(h.fake, calm, 'Due today', { due: 0 });
  addTask(h.fake, calm, 'Blocked task', { blocked: true });
  addStory(h.fake, calm, 'Blocked, done', { blocked: true, closed: -1, due: -3 });
  // One overdue, one blocked story, one bug opened this week.
  const warm = board('warm');
  addStory(h.fake, warm, 'Late', { due: -1, blocked: true });
  addBug(h.fake, warm, 'New this week', 0);
  // Two overdue (a story and a task), two blocked stories; bugs rose last week and held this week.
  const hot = board('hot');
  addStory(h.fake, hot, 'Late', { due: -1 });
  addTask(h.fake, hot, 'Late task', { due: -2 });
  addStory(h.fake, hot, 'Stuck 1', { blocked: true });
  addStory(h.fake, hot, 'Stuck 2', { blocked: true });
  addBug(h.fake, hot, 'Last week', -7);
  // Three overdue; bugs rose last week and this week.
  const fire = board('fire');
  addStory(h.fake, fire, 'Late 1', { due: -1 });
  addStory(h.fake, fire, 'Late 2', { due: -5 });
  addTask(h.fake, fire, 'Late 3', { due: -9 });
  addBug(h.fake, fire, 'Last week', -7);
  addBug(h.fake, fire, 'This week', 0);

  const levels = async (slug: string) => {
    const { productOwner, warnings, unavailable } = await metrics(h, slug);
    assert.ok(!('currentSprint' in productOwner) && !('velocity' in productOwner) && !('planned' in productOwner), slug);
    assert.ok(!('sprintPace' in productOwner.health), slug);
    assert.deepEqual(warnings.map(({ code }) => code), ['kanban']);
    assert.ok(!unavailable.some(({ metric }) => metric === 'productOwner.planned.sprintStart' || metric === 'productOwner.scopeChange'), slug);
    const { overdue, blocked, openBugs } = productOwner.health;
    for (const signal of [overdue, blocked, openBugs]) assert.ok(signal.reason.length > 0, slug);
    return {
      overdue: [overdue.level, overdue.stories, overdue.tasks],
      blocked: [blocked.level, blocked.stories],
      openBugs: [openBugs.level, openBugs.risingPeriods],
    };
  };
  assert.deepEqual(await levels('calm'), { overdue: ['green', 0, 0], blocked: ['green', 0], openBugs: ['green', 0] });
  assert.deepEqual(await levels('warm'), { overdue: ['yellow', 1, 0], blocked: ['yellow', 1], openBugs: ['yellow', 1] });
  assert.deepEqual(await levels('hot'), { overdue: ['yellow', 1, 1], blocked: ['red', 2], openBugs: ['green', 0] });
  assert.deepEqual(await levels('fire'), { overdue: ['red', 2, 1], blocked: ['green', 0], openBugs: ['red', 2] });
  // The tables of a kanban project match report's too.
  assert.deepEqual((await metrics(h, 'hot')).productOwner.report, await reportTables(h, 'hot'));
});

test('metrics text shows the product owner section', async (t) => {
  const h = await startHarness(t);
  seedPace(h.fake, 'alpha', 20, 4);

  const result = await h.taigent(['metrics', '--project', 'alpha'], { env: { TZ } });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Product owner:\n {2}Current sprint: Now, day 5 of 10: points 4\/20 done, stories 1\/2 done, tasks 0\/0 done; ideal 10 points left today/);
  assert.match(result.stdout, /Health:\n {4}sprint pace: red, /);
  assert.match(result.stdout, / {4}overdue: green, /);
  assert.match(result.stdout, /Sprints \(1\):\n {2}Now {2}/);
});
