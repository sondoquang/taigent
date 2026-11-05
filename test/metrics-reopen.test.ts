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
  developer: { bugs: { periods: { period: string; all: BugResolutionJson; mine: BugResolutionJson }[] } };
  productOwner: {
    bugTrend: { period: string; created: number; resolved: number; rejected: number; reopened: number; open: number }[];
    health: { openBugs: { level: string; reason: string; risingPeriods: number } };
  };
  unavailable: { metric: string }[];
}

/** The day `offset` days from today in `TZ`, YYYY-MM-DD: the seeds are relative to the real clock. */
function day(offset: number): string {
  const [year, month, date] = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()).split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date + offset)).toISOString().slice(0, 10);
}

/** An instant at 10:00 local time in `TZ` of the day `offset` days from today, ISO 8601. */
function at(offset: number): string {
  return new Date(`${day(offset)}T10:00:00+07:00`).toISOString();
}

/**
 * A bug of `project` in status `status`, created on day `created` and closed on day `closed`, whose history records
 * the status moves `[day, from, to]` (oldest first).
 */
function addBug(
  fake: FakeTaiga,
  project: number,
  subject: string,
  fields: { status: string; created: number; closed?: number; assigned?: number | null; moves?: [number, string, string][] },
): FakeIssue {
  const { status, created, closed, assigned = null, moves = [] } = fields;
  const typeId = fake.state.issueTypes.find((value) => value.project === project && value.name === 'Bug')!.id;
  const statusId = fake.state.issueStatuses.find((value) => value.project === project && value.name === status)!.id;
  const bug = Object.assign(fake.addIssue({ project, subject, type: typeId, status: statusId }), {
    assigned_to: assigned,
    created_date: at(created),
    finished_date: closed === undefined ? null : at(closed),
  });
  for (const [offset, from, to] of moves) fake.addStatusChange(bug, { at: at(offset), from, to });
  return bug;
}

/** Project alpha: a closed sprint (days -20 to -7) and the current one (-6 to 7), with bugs resolved and reopened. */
function seed(fake: FakeTaiga) {
  const me = fake.user.id;
  const alice = fake.addUser({ username: 'alice' }).id;
  const alpha = fake.addProject({ slug: 'alpha', name: 'Alpha', members: [me, alice] });
  const past = fake.addMilestone({ project: alpha.id, name: 'Sprint 1', estimated_start: day(-20), estimated_finish: day(-7), closed: true });
  const current = fake.addMilestone({ project: alpha.id, name: 'Sprint 2', estimated_start: day(-6), estimated_finish: day(7) });
  const p = alpha.id;
  // Resolved in sprint 1 (in Ready for test at its end), reopened in sprint 2 and still open.
  addBug(fake, p, 'Bounce', { status: 'In progress', created: -15, assigned: me, moves: [[-12, 'New', 'In progress'], [-10, 'In progress', 'Ready for test'], [-4, 'Ready for test', 'In progress']] });
  // Resolved, reopened and resolved again in sprint 1: one resolved bug, 9 days from creation to its last resolution.
  addBug(fake, p, 'Twice', { status: 'Closed', created: -18, closed: -9, assigned: alice, moves: [[-16, 'New', 'Closed'], [-14, 'Closed', 'New'], [-9, 'New', 'Closed']] });
  // Resolved, reopened to Needs Info and closed again in sprint 2.
  addBug(fake, p, 'Same sprint', { status: 'Closed', created: -5, closed: -1, assigned: me, moves: [[-3, 'New', 'Ready for test'], [-2, 'Ready for test', 'Needs Info'], [-1, 'Needs Info', 'Closed']] });
  // Closed then Ready for test: still resolved (a closed status), not reopened.
  addBug(fake, p, 'Retest', { status: 'Ready for test', created: -5, closed: -2, assigned: alice, moves: [[-3, 'New', 'Closed'], [-2, 'Closed', 'Ready for test']] });
  // Out of Rejected is not a reopen: Rejected is not resolved. It was rejected in sprint 2 all the same.
  addBug(fake, p, 'Unrejected', { status: 'New', created: -5, moves: [[-4, 'New', 'Rejected'], [-3, 'Rejected', 'New']] });
  // No status change recorded: goes by its status and the days it was created and closed.
  addBug(fake, p, 'Quiet', { status: 'Closed', created: -3, closed: -1 });
  return { past, current };
}

test('reopen rate per period: bugs reopened (resolved, then back to an open status) over bugs resolved, from the history', async (t) => {
  const h = await startHarness(t);
  const { past, current } = seed(h.fake);

  const result = await h.taigent(['metrics', '--project', 'alpha', '--json'], { env: { TZ } });

  assert.equal(result.code, 0, result.stderr);
  const report = result.json<MetricsJson>();
  assert.deepEqual(report.developer.bugs.periods, [
    {
      period: `sprint:${past.id}`,
      // Bounce (5 days) and Twice (9 days) resolved, Twice reopened.
      all: { resolved: 2, rejected: 0, resolutionTime: { medianDays: 7, count: 2 }, reopened: 1, reopenRate: 0.5 },
      mine: { resolved: 1, rejected: 0, resolutionTime: { medianDays: 5, count: 1 }, reopened: 0, reopenRate: 0 },
    },
    {
      period: `sprint:${current.id}`,
      // Same sprint (4 days), Retest (2) and Quiet (2) resolved; Bounce and Same sprint reopened; Unrejected rejected.
      all: { resolved: 3, rejected: 1, resolutionTime: { medianDays: 2, count: 3 }, reopened: 2, reopenRate: 2 / 3 },
      mine: { resolved: 1, rejected: 0, resolutionTime: { medianDays: 4, count: 1 }, reopened: 2, reopenRate: 2 },
    },
  ]);
  const metrics = report.unavailable.map(({ metric }) => metric);
  assert.ok(!metrics.includes('developer.bugs.reopenRate') && !metrics.includes('productOwner.bugTrend.reopened'), metrics.join(', '));
  assert.deepEqual(writes(h.fake), []);
});

test('reopen rate is null in a period without a resolved bug', async (t) => {
  const h = await startHarness(t);
  const alpha = h.fake.addProject({ slug: 'alpha', name: 'Alpha' });
  h.fake.addMilestone({ project: alpha.id, name: 'Sprint 1', estimated_start: day(-3), estimated_finish: day(7) });
  addBug(h.fake, alpha.id, 'Bounce', { status: 'New', created: -30, moves: [[-20, 'New', 'Closed'], [-2, 'Closed', 'New']] });

  const result = await h.taigent(['metrics', '--project', 'alpha', '--json'], { env: { TZ } });

  assert.equal(result.code, 0, result.stderr);
  const { all } = result.json<MetricsJson>().developer.bugs.periods[0]!;
  assert.deepEqual([all.resolved, all.reopened, all.reopenRate], [0, 1, null]);
});

test('a bug rejected, then reopened, stays rejected in the period it was rejected in, from the history', async (t) => {
  const h = await startHarness(t);
  const { past, current } = seed(h.fake);
  const p = past.project;
  // Rejected in sprint 1, back to New in sprint 2: rejected in sprint 1 only.
  addBug(h.fake, p, 'Back', { status: 'New', created: -15, assigned: h.fake.user.id, moves: [[-10, 'New', 'Rejected'], [-3, 'Rejected', 'New']] });
  // Rejected twice in sprint 1: one rejected bug.
  addBug(h.fake, p, 'Again', { status: 'Rejected', created: -15, closed: -8, moves: [[-12, 'New', 'Rejected'], [-11, 'Rejected', 'New'], [-8, 'New', 'Rejected']] });

  const result = await h.taigent(['metrics', '--project', 'alpha', '--json'], { env: { TZ } });

  assert.equal(result.code, 0, result.stderr);
  const report = result.json<MetricsJson>();
  const rejected = report.developer.bugs.periods.map(({ period, all, mine }) => [period, all.rejected, mine.rejected]);
  // Sprint 2 also holds the seed's Unrejected (into Rejected on day -4, out on day -3).
  assert.deepEqual(rejected, [[`sprint:${past.id}`, 2, 1], [`sprint:${current.id}`, 1, 0]]);
  assert.deepEqual(report.productOwner.bugTrend.map(({ period, rejected }) => [period, rejected]), [[`sprint:${past.id}`, 2], [`sprint:${current.id}`, 1]]);
});

test('bug trend: reopened per period and bugs open at the period end from the status the history had then', async (t) => {
  const h = await startHarness(t);
  const { past, current } = seed(h.fake);

  const result = await h.taigent(['metrics', '--project', 'alpha', '--json'], { env: { TZ } });

  assert.equal(result.code, 0, result.stderr);
  const { bugTrend, health } = result.json<MetricsJson>().productOwner;
  assert.deepEqual(bugTrend, [
    // At day -7 Bounce was in Ready for test and Twice Closed: none open.
    { period: `sprint:${past.id}`, created: 2, resolved: 2, rejected: 0, reopened: 1, open: 0 },
    // At day 7 Bounce (reopened) and Unrejected are open; Unrejected was rejected on day -4.
    { period: `sprint:${current.id}`, created: 4, resolved: 3, rejected: 1, reopened: 2, open: 2 },
  ]);
  assert.equal(health.openBugs.level, 'yellow');
  assert.equal(health.openBugs.risingPeriods, 1);
  assert.match(health.openBugs.reason, /\(0 → 2\)/);
});

test('reopened bugs in the text summary', async (t) => {
  const h = await startHarness(t);
  seed(h.fake);

  const result = await h.taigent(['metrics', '--project', 'alpha'], { env: { TZ } });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Bugs, Sprint 2 \(current\): 3 resolved \(median 2 days\), 1 rejected, 2 reopened \(reopen rate 67%\)\n {4}mine: 1 resolved \(median 4 days\), 0 rejected, 2 reopened \(reopen rate 200%\)/);
  assert.match(result.stdout, /Bug trend:\n {2}Sprint 1: 2 created, 2 resolved, 0 rejected, 1 reopened, 0 open at the end\n {2}Sprint 2 \(current\): 4 created, 3 resolved, 1 rejected, 2 reopened, 2 open at the end/);
});
