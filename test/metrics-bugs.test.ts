import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FakeIssue, FakeTaiga } from './support/fake-taiga.ts';
import { startHarness, writes } from './support/harness.ts';

// UTC+7 without daylight saving, so a local day runs from 17:00Z the day before to 17:00Z.
const TZ = 'Asia/Ho_Chi_Minh';

interface BugResolutionJson {
  resolved: number;
  rejected: number;
  resolutionTime: { medianDays: number | null; count: number };
  reopened: number;
  reopenRate: number | null;
}

interface MetricsJson {
  periods: { id: string }[];
  developer: { bugs: { periods: { period: string; all: BugResolutionJson; mine: BugResolutionJson }[] } };
  productOwner: { bugTrend: { period: string; created: number; resolved: number; rejected: number; reopened: number; open: number }[] };
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

/** Project alpha: a closed sprint (days -20 to -7) and the current one (-6 to 7); another project has a bug of its own. */
function seed(fake: FakeTaiga) {
  const me = fake.user.id;
  const alice = fake.addUser({ username: 'alice' }).id;
  const alpha = fake.addProject({ slug: 'alpha', name: 'Alpha', members: [me, alice] });
  const other = fake.addProject({ slug: 'other', name: 'Other' });
  const past = fake.addMilestone({ project: alpha.id, name: 'Sprint 1', estimated_start: day(-20), estimated_finish: day(-7), closed: true });
  const current = fake.addMilestone({ project: alpha.id, name: 'Sprint 2', estimated_start: day(-6), estimated_finish: day(7) });
  addIssue(fake, other.id, 'Elsewhere', { created: -3, status: 'Closed', closed: -2 });
  return { me, alice, alpha, past, current };
}

function addIssue(
  fake: FakeTaiga,
  project: number,
  subject: string,
  fields: { type?: string; status?: string; created?: number; closed?: number; assigned?: number },
): FakeIssue {
  const { type = 'Bug', status = 'New', created = -30, closed, assigned = null } = fields;
  const typeId = fake.state.issueTypes.find((value) => value.project === project && value.name === type)!.id;
  const statusId = fake.state.issueStatuses.find((value) => value.project === project && value.name === status)!.id;
  return Object.assign(fake.addIssue({ project, subject, type: typeId, status: statusId }), {
    assigned_to: assigned,
    created_date: at(created),
    finished_date: closed === undefined ? null : at(closed),
  });
}

const resolution = (resolved: number, rejected: number, medianDays: number | null, count: number): BugResolutionJson => ({
  resolved,
  rejected,
  resolutionTime: { medianDays, count },
  reopened: 0,
  reopenRate: resolved === 0 ? null : 0,
});

test('bug resolution per period: Ready for test and Closed are resolved, Rejected counted apart with no resolution time', async (t) => {
  const h = await startHarness(t);
  const { me, alice, alpha, past, current } = seed(h.fake);
  const p = alpha.id;
  addIssue(h.fake, p, 'Crash', { status: 'Closed', created: -15, closed: -10, assigned: me });
  addIssue(h.fake, p, 'Typo', { status: 'Ready for test', created: -5, closed: -1, assigned: alice });
  addIssue(h.fake, p, 'Slow', { status: 'Closed', created: -6, closed: -4, assigned: me });
  addIssue(h.fake, p, 'Wontfix', { status: 'Rejected', created: -3, closed: -2, assigned: me });
  addIssue(h.fake, p, 'Open', { status: 'In progress', created: -2, assigned: me });
  // Not bugs: an issue of another type, and a user story tagged as a bug.
  addIssue(h.fake, p, 'How to?', { type: 'Question', status: 'Closed', created: -5, closed: -1 });
  Object.assign(h.fake.addUserStory({ project: p, subject: 'Bug story', tags: ['type:bug'] }), { is_closed: true, status_name: 'Done', finish_date: at(-1) });

  const result = await h.taigent(['metrics', '--project', 'alpha', '--json'], { env: { TZ } });

  assert.equal(result.code, 0, result.stderr);
  const { developer } = result.json<MetricsJson>();
  assert.deepEqual(developer.bugs.periods, [
    // Crash: created day -15, resolved day -10.
    { period: `sprint:${past.id}`, all: resolution(1, 0, 5, 1), mine: resolution(1, 0, 5, 1) },
    // Typo 4 days, Slow 2 days; Wontfix is rejected.
    { period: `sprint:${current.id}`, all: resolution(2, 1, 3, 2), mine: resolution(1, 1, 2, 1) },
  ]);
  assert.deepEqual(writes(h.fake), []);
});

test('bug trend per period: created, resolved, rejected and open at the period end, from the days created and closed', async (t) => {
  const h = await startHarness(t);
  const { alpha, past, current } = seed(h.fake);
  const p = alpha.id;
  addIssue(h.fake, p, 'Old open', { created: -40 });
  addIssue(h.fake, p, 'Old fixed', { status: 'Closed', created: -40, closed: -8 });
  addIssue(h.fake, p, 'Fixed now', { status: 'Ready for test', created: -12, closed: -3 });
  addIssue(h.fake, p, 'Rejected now', { status: 'Rejected', created: -9, closed: -1 });
  addIssue(h.fake, p, 'New one', { status: 'Needs Info', created: -2 });
  addIssue(h.fake, p, 'Not a bug', { type: 'Enhancement', created: -2 });

  const result = await h.taigent(['metrics', '--project', 'alpha', '--json'], { env: { TZ } });

  assert.equal(result.code, 0, result.stderr);
  const report = result.json<MetricsJson>();
  assert.deepEqual(report.productOwner.bugTrend, [
    // At day -7: Old open, Fixed now and Rejected now are open; Old fixed closed on day -8.
    { period: `sprint:${past.id}`, created: 2, resolved: 1, rejected: 0, reopened: 0, open: 3 },
    // At day 7: Old open and New one.
    { period: `sprint:${current.id}`, created: 1, resolved: 1, rejected: 1, reopened: 0, open: 2 },
  ]);
});

test('bug figures read every issue of the project, beyond Taiga’s 30-item page', async (t) => {
  const h = await startHarness(t);
  const { alpha } = seed(h.fake);
  for (let i = 1; i <= 35; i += 1) addIssue(h.fake, alpha.id, `Bug ${i}`, { status: 'Closed', created: -3, closed: -1 });

  const result = await h.taigent(['metrics', '--project', 'alpha', '--json'], { env: { TZ } });

  assert.equal(result.code, 0, result.stderr);
  const { developer, productOwner } = result.json<MetricsJson>();
  assert.deepEqual(developer.bugs.periods.at(-1)!.all, resolution(35, 0, 2, 35));
  assert.deepEqual(productOwner.bugTrend.at(-1), { period: productOwner.bugTrend.at(-1)!.period, created: 35, resolved: 35, rejected: 0, reopened: 0, open: 0 });
});

test('bug figures in the text summary', async (t) => {
  const h = await startHarness(t);
  const { me, alpha } = seed(h.fake);
  addIssue(h.fake, alpha.id, 'Crash', { status: 'Closed', created: -5, closed: -1, assigned: me });
  addIssue(h.fake, alpha.id, 'Wontfix', { status: 'Rejected', created: -3, closed: -2 });
  addIssue(h.fake, alpha.id, 'Open', { created: -2 });

  const result = await h.taigent(['metrics', '--project', 'alpha'], { env: { TZ } });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Bugs, Sprint 2 \(current\): 1 resolved \(median 4 days\), 1 rejected, 0 reopened \(reopen rate 0%\)\n {4}mine: 1 resolved \(median 4 days\), 0 rejected, 0 reopened \(reopen rate 0%\)/);
  assert.match(result.stdout, /Bug trend:\n(?: {2}.*\n)* {2}Sprint 2 \(current\): 3 created, 1 resolved, 1 rejected, 0 reopened, 1 open at the end/);
});
