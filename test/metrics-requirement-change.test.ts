// `taigent metrics`: the requirement change trend of the Business Analyst section (GLOSSARY.md, Requirement change),
// from each user story's Taiga history.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FakeTaiga, FakeUserStory } from './support/fake-taiga.ts';
import { startHarness, writes } from './support/harness.ts';

// UTC+7 without daylight saving, so a local day runs from 17:00Z the day before to 17:00Z.
const TZ = 'Asia/Ho_Chi_Minh';

interface RequirementChangeEntry {
  period: string;
  changes: number;
  stories: { ref: number; subject: string; changes: number }[];
}

interface MetricsJson {
  periods: { id: string }[];
  businessAnalyst: { requirementChange: RequirementChangeEntry[] };
  unavailable: { metric: string }[];
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

interface Seed {
  /** Current status name. */
  status: string;
  /** Status changes `[days from today, from, to]`. */
  moves?: [number, string, string][];
  /** Description edits, in days from today. */
  edits?: number[];
}

function addStory(fake: FakeTaiga, project: number, subject: string, seed: Seed): FakeUserStory {
  const status = fake.state.storyStatuses.find((candidate) => candidate.project === project && candidate.name === seed.status)!;
  const story = Object.assign(fake.addUserStory({ project, subject }), { status: status.id, status_name: status.name, is_closed: status.is_closed, created_date: at(-60), modified_date: at(-60) });
  // A move and an edit on the same day: the move first.
  for (const [offset, from, to] of seed.moves ?? []) fake.addStatusChange(story, { at: at(offset, 9), from, to });
  for (const [index, offset] of (seed.edits ?? []).entries()) fake.addDescriptionChange(story, { at: at(offset), from: `v${index}`, to: `v${index + 1}` });
  return story;
}

/** Project alpha with a closed sprint (days -20 to -7) and the current one (days -6 to 7). */
function seed(fake: FakeTaiga) {
  const alpha = fake.addProject({ slug: 'alpha', name: 'Alpha' });
  const past = fake.addMilestone({ project: alpha.id, name: 'Sprint 1', estimated_start: day(-20), estimated_finish: day(-7), closed: true });
  const current = fake.addMilestone({ project: alpha.id, name: 'Sprint 2', estimated_start: day(-6), estimated_finish: day(7) });
  const p = alpha.id;
  // Ready on day -18: the edit of day -19 is before it; -15 counts in Sprint 1, -3 and -2 in Sprint 2, also once in progress.
  const login = addStory(fake, p, 'Login', { status: 'In progress', moves: [[-18, 'New', 'Ready'], [-12, 'Ready', 'In progress']], edits: [-19, -15, -3, -2] });
  // The history names the statuses in another language: Ready goes by its id.
  const signup = addStory(fake, p, 'Signup', { status: 'Ready', moves: [[-10, 'New', 'Ready']], edits: [-9] });
  const translated: Record<string, string> = { New: 'Mới', Ready: 'Sẵn sàng' };
  const move = fake.state.history.find((entry) => entry.item === signup.id && entry.diff.status)!;
  move.values.status = Object.fromEntries(Object.entries(move.values.status!).map(([id, name]) => [id, translated[name]!]));
  // Created in Ready (its first change leaves Ready): every edit counts.
  const created = addStory(fake, p, 'Created ready', { status: 'In progress', moves: [[-4, 'Ready', 'In progress']], edits: [-5] });
  // In Ready and never moved: in Ready since it was created.
  const still = addStory(fake, p, 'Still ready', { status: 'Ready', edits: [-1] });
  // Never reached Ready: its edits are not requirement changes.
  addStory(fake, p, 'Draft', { status: 'New', edits: [-3] });
  addStory(fake, p, 'Back to new', { status: 'New', moves: [[-16, 'New', 'In progress'], [-14, 'In progress', 'New']], edits: [-13] });
  // Edited after Ready, but before the periods.
  addStory(fake, p, 'Long ago', { status: 'Done', moves: [[-40, 'New', 'Ready'], [-35, 'Ready', 'Done']], edits: [-30] });
  // A task's description edit is not a requirement change.
  const task = fake.addTask({ project: p, subject: 'Step' });
  fake.addDescriptionChange(task, { at: at(-2), from: 'a', to: 'b' });
  return { past, current, login, signup, created, still };
}

test('requirement change: description edits of a story after it first reached Ready (its status by id), per period', async (t) => {
  const h = await startHarness(t);
  const { past, current, login, signup, created, still } = seed(h.fake);

  const result = await h.taigent(['metrics', '--project', 'alpha', '--json'], { env: { TZ } });

  assert.equal(result.code, 0, result.stderr);
  const report = result.json<MetricsJson>();
  assert.deepEqual(report.periods.map(({ id }) => id), [`sprint:${past.id}`, `sprint:${current.id}`]);
  assert.deepEqual(report.businessAnalyst.requirementChange, [
    {
      period: `sprint:${past.id}`,
      changes: 2,
      stories: [
        { ref: login.ref, subject: 'Login', changes: 1 },
        { ref: signup.ref, subject: 'Signup', changes: 1 },
      ],
    },
    {
      period: `sprint:${current.id}`,
      changes: 4,
      stories: [
        { ref: login.ref, subject: 'Login', changes: 2 },
        { ref: created.ref, subject: 'Created ready', changes: 1 },
        { ref: still.ref, subject: 'Still ready', changes: 1 },
      ],
    },
  ]);
  assert.ok(!report.unavailable.some(({ metric }) => metric === 'businessAnalyst.requirementChange'), 'requirement change is available');
  assert.deepEqual(writes(h.fake), []);
});

test('requirement change is there without a backlog manifest: it comes from Taiga', async (t) => {
  const h = await startHarness(t);
  const { current } = seed(h.fake);

  const report = (await h.taigent(['metrics', '--project', 'alpha', '--json'], { env: { TZ } })).json<MetricsJson>();

  assert.equal(report.businessAnalyst.requirementChange.find(({ period }) => period === `sprint:${current.id}`)?.changes, 4);
});

test('metrics prints the requirement changes of each period in its text summary', async (t) => {
  const h = await startHarness(t);
  seed(h.fake);

  const result = await h.taigent(['metrics', '--project', 'alpha'], { env: { TZ } });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /\n {2}Requirement changes \(story description edits after Ready\):\n {4}Sprint 1: 2 edits of 2 stories\n {4}Sprint 2 \(current\): 4 edits of 3 stories\n/);
});
