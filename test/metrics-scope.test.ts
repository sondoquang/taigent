// `taigent metrics` planned at sprint start and scope change (GLOSSARY.md, Scope change): the sprint each user story
// was in, rebuilt from the milestone changes of its Taiga history.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FakeMilestone, FakeTaiga, FakeUserStory } from './support/fake-taiga.ts';
import { type Harness, startHarness, writes } from './support/harness.ts';

// UTC+7 without daylight saving, so a local day runs from 17:00Z the day before to 17:00Z.
const TZ = 'Asia/Ho_Chi_Minh';

interface ScopeStoryJson {
  id: number;
  ref: number;
  subject: string;
  points: number | null;
  day: string;
}

interface ScopeChangeJson {
  period: string;
  added: { points: number; stories: ScopeStoryJson[] };
  removed: { points: number; stories: ScopeStoryJson[] };
}

interface MetricsJson {
  productOwner: {
    planned?: { basis: string; sprints: { period: string; planned: number; completed: number }[] };
    scopeChange?: ScopeChangeJson[];
  };
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

function statusFields(fake: FakeTaiga, project: number, name: string) {
  const status = fake.state.storyStatuses.find((candidate) => candidate.project === project && candidate.name === name)!;
  return { status: status.id, status_name: status.name, is_closed: status.is_closed };
}

interface StorySeed {
  /** Its sprint now. */
  sprint: FakeMilestone | null;
  points: number | null;
  /** Days from today it was created (default 60 days ago). */
  created?: number;
  /** Days from today it closed (status Done); open (New) without it. */
  closed?: number;
  /** Sprint changes `[days from today, local hour, from, to]`, oldest first. */
  moves?: [number, number, FakeMilestone | null, FakeMilestone | null][];
}

function addStory(fake: FakeTaiga, project: number, subject: string, seed: StorySeed): FakeUserStory {
  const story = Object.assign(fake.addUserStory({ project, subject }), {
    ...statusFields(fake, project, seed.closed === undefined ? 'New' : 'Done'),
    milestone: seed.sprint?.id ?? null,
    total_points: seed.points,
    created_date: at(seed.created ?? -60),
    modified_date: at(seed.created ?? -60),
    finish_date: seed.closed === undefined ? null : at(seed.closed),
  });
  for (const [offset, hour, from, to] of seed.moves ?? []) fake.addMilestoneChange(story, { at: at(offset, hour), from, to });
  return story;
}

async function metrics(h: Harness, args: string[] = []): Promise<MetricsJson> {
  const result = await h.taigent(['metrics', '--project', 'alpha', '--json', ...args], { env: { TZ } });
  assert.equal(result.code, 0, result.stderr);
  return result.json<MetricsJson>();
}

const entry = (story: FakeUserStory, offset: number): ScopeStoryJson => ({ id: story.id, ref: story.ref, subject: story.subject, points: story.total_points, day: day(offset) });

function seed(fake: FakeTaiga) {
  const p = fake.addProject({ slug: 'alpha', name: 'Alpha' }).id;
  // Sprint A from 30 to 17 days ago (closed), Sprint B from 5 days ago to 5 days from now.
  const a = fake.addMilestone({ project: p, name: 'Sprint A', estimated_start: day(-30), estimated_finish: day(-17), closed: true });
  const b = fake.addMilestone({ project: p, name: 'Sprint B', estimated_start: day(-5), estimated_finish: day(5) });
  const stories = {
    // Sprint A: planned 2 + 6 + 1, then "Swapped" taken out during it; "Carried" moved on after it finished.
    doneInA: addStory(fake, p, 'Done in A', { sprint: a, points: 2, closed: -20 }),
    swapped: addStory(fake, p, 'Swapped', { sprint: b, points: 6, moves: [[-40, 10, null, a], [-20, 10, a, b]] }),
    carried: addStory(fake, p, 'Carried', { sprint: b, points: 1, moves: [[-40, 10, null, a], [-16, 10, a, b]] }),
    // Sprint B: in it on its first day, even late in the evening; "Pulled out" planned and then taken out.
    committed: addStory(fake, p, 'Committed', { sprint: b, points: 5, moves: [[-7, 10, null, b]] }),
    lastMinute: addStory(fake, p, 'Last minute', { sprint: b, points: 4, moves: [[-5, 23, null, b]] }),
    unestimated: addStory(fake, p, 'Unestimated', { sprint: b, points: null, moves: [[-8, 10, null, b]] }),
    pulledOut: addStory(fake, p, 'Pulled out', { sprint: null, points: 8, moves: [[-8, 10, null, b], [-1, 10, b, null]] }),
    // Added after the first day: 01:00 the next morning, a story created right in the sprint, a late addition.
    earlyHours: addStory(fake, p, 'Early hours', { sprint: b, points: 7, moves: [[-4, 1, null, b]] }),
    createdIn: addStory(fake, p, 'Created in sprint', { sprint: b, points: 2, created: -3 }),
    lateAdd: addStory(fake, p, 'Late add', { sprint: b, points: 3, closed: -1, moves: [[-2, 10, null, b]] }),
    // Never in a sprint.
    backlog: addStory(fake, p, 'Backlog', { sprint: null, points: 13 }),
  };
  return { a, b, stories };
}

test('planned: the points of the stories in each sprint on its first day, rebuilt from their sprint changes', async (t) => {
  const h = await startHarness(t);
  const { a, b } = seed(h.fake);

  const { productOwner, unavailable } = await metrics(h);

  assert.deepEqual(productOwner.planned, {
    basis: 'sprint-start',
    sprints: [
      // Done in A, Swapped, Carried; completed: Done in A.
      { period: `sprint:${a.id}`, planned: 9, completed: 2 },
      // Swapped, Carried, Committed, Last minute, Unestimated (0), Pulled out; completed: Late add.
      { period: `sprint:${b.id}`, planned: 24, completed: 3 },
    ],
  });
  assert.ok(!unavailable.some(({ metric }) => metric === 'productOwner.planned.sprintStart' || metric === 'productOwner.scopeChange'));
  assert.deepEqual(writes(h.fake), []);
});

test('scope change: stories added to or taken out of each sprint after its first day, with their points', async (t) => {
  const h = await startHarness(t);
  const { a, b, stories } = seed(h.fake);

  const { productOwner } = await metrics(h);

  assert.deepEqual(productOwner.scopeChange, [
    // Moving "Carried" on after Sprint A finished is no scope change of Sprint A.
    { period: `sprint:${a.id}`, added: { points: 0, stories: [] }, removed: { points: 6, stories: [entry(stories.swapped, -20)] } },
    {
      period: `sprint:${b.id}`,
      added: { points: 12, stories: [entry(stories.earlyHours, -4), entry(stories.createdIn, -3), entry(stories.lateAdd, -2)] },
      removed: { points: 8, stories: [entry(stories.pulledOut, -1)] },
    },
  ]);
});

test('scope change: a story added and taken out again is listed both ways; a story without history keeps its sprint', async (t) => {
  const h = await startHarness(t);
  const p = h.fake.addProject({ slug: 'alpha', name: 'Alpha' }).id;
  const sprint = h.fake.addMilestone({ project: p, name: 'Now', estimated_start: day(-5), estimated_finish: day(5) });
  addStory(h.fake, p, 'Steady', { sprint, points: 3 });
  const blip = addStory(h.fake, p, 'Blip', { sprint: null, points: 2, moves: [[-3, 10, null, sprint], [-2, 10, sprint, null]] });

  const { productOwner } = await metrics(h);

  assert.deepEqual(productOwner.planned?.sprints, [{ period: `sprint:${sprint.id}`, planned: 3, completed: 0 }]);
  assert.deepEqual(productOwner.scopeChange, [
    { period: `sprint:${sprint.id}`, added: { points: 2, stories: [entry(blip, -3)] }, removed: { points: 2, stories: [entry(blip, -2)] } },
  ]);
});

test('scope change and planned in text: planned at sprint start, and each sprint\'s added and removed stories', async (t) => {
  const h = await startHarness(t);
  const { stories } = seed(h.fake);

  const result = await h.taigent(['metrics', '--project', 'alpha'], { env: { TZ } });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Completed\/planned points \(planned as the points in the sprint on its first day\): Sprint A 2\/9, Sprint B 3\/24/);
  assert.match(result.stdout, /\n {2}Scope change:\n {4}Sprint A: added 0 stories \(0 points\), removed 1 story \(6 points\)\n/);
  assert.match(result.stdout, /\n {4}Sprint B: added 3 stories \(12 points\), removed 1 story \(8 points\)\n/);
  assert.match(result.stdout, new RegExp(`\\+ #${stories.lateAdd.ref} Late add \\(3 points, ${day(-2)}\\)`));
  assert.match(result.stdout, new RegExp(`- #${stories.pulledOut.ref} Pulled out \\(8 points, ${day(-1)}\\)`));
  assert.doesNotMatch(result.stdout, /productOwner\.(planned\.sprintStart|scopeChange)/);
});

test('kanban project: no planned and no scope change', async (t) => {
  const h = await startHarness(t);
  h.fake.addProject({ slug: 'alpha', name: 'Alpha', modules: { is_backlog_activated: false } });

  const { productOwner, unavailable } = await metrics(h);

  assert.equal(productOwner.planned, undefined);
  assert.equal(productOwner.scopeChange, undefined);
  assert.ok(!unavailable.some(({ metric }) => metric === 'productOwner.planned.sprintStart' || metric === 'productOwner.scopeChange'));
});
