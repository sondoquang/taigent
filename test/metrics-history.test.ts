// `taigent metrics` with the Taiga history of each item: cycle time, and the history cache of --cache-dir.
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { FakeIssue, FakeTaiga, FakeTask, FakeUserStory } from './support/fake-taiga.ts';
import { type Harness, startHarness, writes } from './support/harness.ts';

// UTC+7 without daylight saving, so a local day runs from 17:00Z the day before to 17:00Z.
const TZ = 'Asia/Ho_Chi_Minh';

interface Median {
  medianDays: number | null;
  count: number;
}

interface MetricsJson {
  developer: {
    cycleTime: { all: { stories: Median; tasks: Median }; mine: { stories: Median; tasks: Median } };
  };
  unavailable: { metric: string; reason: string; message: string }[];
}

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

type Kind = 'userstory' | 'task';

function statusFields(fake: FakeTaiga, kind: Kind, project: number, name: string) {
  const statuses = kind === 'userstory' ? fake.state.storyStatuses : fake.state.taskStatuses;
  const status = statuses.find((candidate) => candidate.project === project && candidate.name === name)!;
  return { status: status.id, status_name: status.name, is_closed: status.is_closed };
}

interface Seed {
  /** Current status name. */
  status: string;
  created: number;
  closed?: number;
  /** Status changes `[days from today, from, to]`, in any order. */
  moves?: [number, string, string][];
}

function addStory(fake: FakeTaiga, project: number, subject: string, seed: Seed & { assigned?: number[] }): FakeUserStory {
  const story = Object.assign(fake.addUserStory({ project, subject }), {
    ...statusFields(fake, 'userstory', project, seed.status),
    created_date: at(seed.created),
    modified_date: at(seed.created),
    finish_date: seed.closed === undefined ? null : at(seed.closed),
    assigned_users: seed.assigned ?? [],
    assigned_to: seed.assigned?.[0] ?? null,
  });
  for (const [offset, from, to] of seed.moves ?? []) fake.addStatusChange(story, { at: at(offset), from, to });
  return story;
}

function addTask(fake: FakeTaiga, project: number, subject: string, seed: Seed & { assigned?: number }): FakeTask {
  const task = Object.assign(fake.addTask({ project, subject }), {
    ...statusFields(fake, 'task', project, seed.status),
    created_date: at(seed.created),
    modified_date: at(seed.created),
    finished_date: seed.closed === undefined ? null : at(seed.closed),
    assigned_to: seed.assigned ?? null,
  });
  for (const [offset, from, to] of seed.moves ?? []) fake.addStatusChange(task, { at: at(offset), from, to });
  return task;
}

/**
 * Project alpha (members: the fake user and alice), a closed sprint and the current one, with stories, tasks and a
 * bug whose histories hold status changes, a sprint change, a description edit and a comment.
 */
function seed(fake: FakeTaiga) {
  const me = fake.user.id;
  const alice = fake.addUser({ username: 'alice' }).id;
  const alpha = fake.addProject({ slug: 'alpha', name: 'Alpha', members: [me, alice] });
  const past = fake.addMilestone({ project: alpha.id, name: 'Sprint 1', estimated_start: day(-20), estimated_finish: day(-7), closed: true });
  fake.addMilestone({ project: alpha.id, name: 'Sprint 2', estimated_start: day(-6), estimated_finish: day(7) });
  const p = alpha.id;
  // Started on day -20, back to Ready, started again on day -15: cycle time from the first start, 10 days.
  const login = addStory(fake, p, 'Login', {
    status: 'Done', created: -25, closed: -10, assigned: [me],
    moves: [[-15, 'Ready', 'In progress'], [-20, 'New', 'In progress'], [-18, 'In progress', 'Ready'], [-10, 'In progress', 'Done']],
  });
  fake.addHistory(login, { at: at(-12), comment: 'Almost there' });
  fake.addMilestoneChange(login, { at: at(-19), from: null, to: past });
  fake.addDescriptionChange(login, { at: at(-17), from: 'Old', to: 'New' });
  // 4 days.
  addStory(fake, p, 'Signup', { status: 'Done', created: -8, closed: -2, assigned: [alice], moves: [[-6, 'New', 'In progress'], [-2, 'In progress', 'Done']] });
  // Created in In progress: no entry into it, so it started when created, 6 days.
  addStory(fake, p, 'Created started', { status: 'Done', created: -9, closed: -3, assigned: [alice], moves: [[-3, 'In progress', 'Done']] });
  // Closed without ever being in progress: no cycle time.
  const never = addStory(fake, p, 'Never started', { status: 'Done', created: -9, closed: -5, moves: [[-5, 'New', 'Done']] });
  // Ready for test is not closed.
  addStory(fake, p, 'In test', { status: 'Ready for test', created: -9, moves: [[-4, 'New', 'In progress'], [-1, 'In progress', 'Ready for test']] });
  // Closed before the periods.
  addStory(fake, p, 'Long ago', { status: 'Done', created: -50, closed: -40, moves: [[-45, 'New', 'In progress'], [-40, 'In progress', 'Done']] });
  // 4 days and 3 days.
  addTask(fake, p, 'Form', { status: 'Closed', created: -6, closed: -1, assigned: me, moves: [[-5, 'New', 'In progress'], [-1, 'In progress', 'Closed']] });
  addTask(fake, p, 'Schema', {
    status: 'Closed', created: -13, closed: -9, assigned: alice,
    moves: [[-12, 'New', 'In progress'], [-10, 'In progress', 'Ready for test'], [-9, 'Ready for test', 'Closed']],
  });
  addTask(fake, p, 'No history', { status: 'Closed', created: -6, closed: -2 });
  const bug: FakeIssue = fake.addIssue({ project: p, subject: 'Crash' });
  fake.addStatusChange(bug, { at: at(-3), from: 'New', to: 'In progress' });
  return { alpha, never };
}

const historyRequests = (h: Harness, since = 0) =>
  h.fake.requests.slice(since).filter((request) => request.path.startsWith('/history/')).map((request) => `${request.method} ${request.path}`);

const EXPECTED = {
  all: { stories: { medianDays: 6, count: 3 }, tasks: { medianDays: 3.5, count: 2 } },
  mine: { stories: { medianDays: 10, count: 1 }, tasks: { medianDays: 4, count: 1 } },
};

test('cycle time runs from the first entry into In progress to the close, for stories and tasks apart, from each item’s history', async (t) => {
  const h = await startHarness(t);
  const { alpha } = seed(h.fake);
  const files = await readdir(h.cwd, { recursive: true });

  const result = await h.taigent(['metrics', '--project', 'alpha', '--json'], { env: { TZ } });

  assert.equal(result.code, 0, result.stderr);
  const report = result.json<MetricsJson>();
  assert.deepEqual(report.developer.cycleTime, EXPECTED);
  assert.ok(!report.unavailable.some(({ metric }) => metric === 'developer.cycleTime'), 'cycle time is available');
  // One history read per story, task and issue of the project.
  const items = [
    ...h.fake.state.userStories.map((story) => `GET /history/userstory/${story.id}`),
    ...h.fake.state.tasks.map((task) => `GET /history/task/${task.id}`),
    ...h.fake.state.issues.filter((issue) => issue.project === alpha.id).map((issue) => `GET /history/issue/${issue.id}`),
  ];
  assert.deepEqual(historyRequests(h).sort(), items.sort());
  assert.deepEqual(writes(h.fake), []);
  assert.deepEqual(await readdir(h.cwd, { recursive: true }), files, 'without --cache-dir nothing is written');
});

test('metrics prints the cycle time in its text summary', async (t) => {
  const h = await startHarness(t);
  seed(h.fake);

  const result = await h.taigent(['metrics', '--project', 'alpha'], { env: { TZ } });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Cycle time \(median\): stories 6 days \(3 closed\), tasks 3\.5 days \(2 closed\)\n {4}mine: stories 10 days \(1 closed\), tasks 4 days \(1 closed\)/);
});

test('--cache-dir keeps the history: the next run reads it again only for items whose modified_date changed', async (t) => {
  const h = await startHarness(t);
  const { never } = seed(h.fake);
  // A task with the id of a story: the cache tells them apart by type. Its history makes a 1-day cycle.
  const twin = addTask(h.fake, never.project, 'Twin', { status: 'Closed', created: -4, closed: -2, assigned: h.fake.user.id, moves: [[-3, 'New', 'In progress']] });
  h.fake.state.history.filter((entry) => entry.kind === 'task' && entry.item === twin.id).forEach((entry) => (entry.item = never.id));
  twin.id = never.id;
  const withTwin = { ...EXPECTED.all, tasks: { medianDays: 3, count: 3 } };
  const mineWithTwin = { ...EXPECTED.mine, tasks: { medianDays: 2.5, count: 2 } };
  const cacheDir = join(h.cwd, 'cache');
  const run = () => h.taigent(['metrics', '--project', 'alpha', '--cache-dir', cacheDir, '--json'], { env: { TZ } });

  const first = await run();
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(first.json<MetricsJson>().developer.cycleTime, { all: withTwin, mine: mineWithTwin });
  assert.equal(historyRequests(h).length, 11);

  const before = h.fake.requests.length;
  const second = await run();
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(historyRequests(h, before), [], 'nothing changed: every history comes from the cache');
  assert.deepEqual(second.json<MetricsJson>().developer.cycleTime, { all: withTwin, mine: mineWithTwin });

  // "Never started" was in progress after all: edited on Taiga now, so its modified_date changes.
  h.fake.addStatusChange(never, { at: at(-7), from: 'New', to: 'In progress' });
  never.modified_date = new Date().toISOString();
  const changed = h.fake.requests.length;
  const third = await run();
  assert.equal(third.code, 0, third.stderr);
  assert.deepEqual(historyRequests(h, changed), [`GET /history/userstory/${never.id}`]);
  assert.deepEqual(third.json<MetricsJson>().developer.cycleTime.all.stories, { medianDays: 5, count: 4 });
  assert.deepEqual(writes(h.fake), []);
});

test('a corrupt cache file or one of another version is read again, and the command still succeeds', async (t) => {
  const h = await startHarness(t);
  seed(h.fake);
  const cacheDir = join(h.cwd, 'cache');
  const run = () => h.taigent(['metrics', '--project', 'alpha', '--cache-dir', cacheDir, '--json'], { env: { TZ } });
  assert.equal((await run()).code, 0);
  const files = await readdir(cacheDir);
  assert.equal(files.length, 1, files.join(', '));
  const file = join(cacheDir, files[0]!);
  const cached = JSON.parse(await readFile(file, 'utf8')) as { version: number };

  for (const content of ['{ not json', JSON.stringify({ ...cached, version: cached.version + 1 }), JSON.stringify({ ...cached, items: 'none' })]) {
    await writeFile(file, content);
    const before = h.fake.requests.length;
    const result = await run();
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.json<MetricsJson>().developer.cycleTime, EXPECTED);
    assert.equal(historyRequests(h, before).length, 10, `history read again after ${content.slice(0, 20)}`);
  }
  assert.equal((await readdir(cacheDir)).length, 1, 'the file is rewritten in place');
});

test('the cache is keyed by the Taiga API URL: another instance with the same project and ids reads its own history', async (t) => {
  const h = await startHarness(t);
  const other = await startHarness(t);
  seed(h.fake);
  seed(other.fake);
  const cacheDir = join(h.cwd, 'cache');
  const args = ['metrics', '--project', 'alpha', '--cache-dir', cacheDir, '--json'];
  assert.equal((await h.taigent(args, { env: { TZ } })).code, 0);
  assert.deepEqual(
    h.fake.state.userStories.map((story) => [story.id, story.modified_date]),
    other.fake.state.userStories.map((story) => [story.id, story.modified_date]),
    'the same ids and modified dates on both instances',
  );

  const result = await other.taigent(args, { env: { TZ } });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(historyRequests(other).length, 10);
  assert.deepEqual(result.json<MetricsJson>().developer.cycleTime, EXPECTED);
});

test('--cache-dir applies only to metrics and needs a directory', async (t) => {
  const h = await startHarness(t);

  const report = await h.taigent(['report', '--project', 'alpha', '--cache-dir', 'cache']);
  assert.equal(report.code, 2);
  assert.match(report.stderr, /--cache-dir applies only to metrics/);
  const empty = await h.taigent(['metrics', '--project', 'alpha', '--cache-dir', '']);
  assert.equal(empty.code, 2);
  assert.match(empty.stderr, /--cache-dir needs a directory/);
  assert.deepEqual(h.fake.requests, []);
});
