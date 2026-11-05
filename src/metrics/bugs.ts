// Bug figures of `taigent metrics` (GLOSSARY.md, Dashboards): the bug resolution of the `developer` section and the
// bug trend of the `productOwner` section, from the snapshot alone. A bug is an issue whose type is Bug (a story
// tagged `type:bug` is not one); it is resolved in Ready for test or Closed, and Rejected is counted on its own. These
// are the only metrics that go by a status's name, because the glossary defines a resolved bug by it; open and closed
// still go by the status's closed flag.

import { daysBetween, localDay } from '../days.ts';
import type { MetricsContext } from './context.ts';
import type { Scoped } from './developer.ts';
import { inPeriod, type Period } from './periods.ts';
import type { MetricsSnapshot } from './snapshot.ts';
import { median } from './work.ts';

const BUG_TYPE = 'Bug';
const RESOLVED_STATUSES: Record<string, true> = { 'Ready for test': true, Closed: true };
const REJECTED_STATUS = 'Rejected';

interface Bug {
  assignee: number | null;
  /** `resolved`: Ready for test or Closed; `rejected`: Rejected; `other`: any other status, open or closed. */
  outcome: 'resolved' | 'rejected' | 'other';
  closed: boolean;
  /** Local days it was created and closed (null while open, or when Taiga recorded no date). */
  createdDay: string | null;
  closedDay: string | null;
}

export interface BugResolution {
  /** Bugs resolved in the period (closed into Ready for test or Closed in it), and bugs Rejected in it. */
  resolved: number;
  rejected: number;
  /** Median days from the local day a resolved bug was created to the day it was resolved; null without samples. */
  resolutionTime: { medianDays: number | null; count: number };
}

export interface DeveloperBugs {
  /** One per period, in the order of the report's `periods`; `mine` holds the bugs assigned to `me`. */
  periods: ({ period: string } & Scoped<BugResolution>)[];
}

export interface BugTrendEntry {
  period: string;
  /** Bugs created, resolved and rejected in the period, and bugs open at its last day. */
  created: number;
  resolved: number;
  rejected: number;
  open: number;
}

function bugsOf(snapshot: MetricsSnapshot): Bug[] {
  const bugTypes = new Set(snapshot.issueTypes.filter((type) => type.name === BUG_TYPE).map((type) => type.id));
  const statuses = new Map(snapshot.statuses.issue.map((status) => [status.id, status]));
  return snapshot.issues
    .filter((issue) => issue.typeId !== null && bugTypes.has(issue.typeId))
    .map((issue): Bug => {
      const status = issue.statusId === null ? undefined : statuses.get(issue.statusId);
      const name = status?.name ?? issue.status;
      const closed = status?.isClosed ?? issue.isClosed;
      return {
        assignee: issue.assignedTo,
        outcome: RESOLVED_STATUSES[name] === true ? 'resolved' : name === REJECTED_STATUS ? 'rejected' : 'other',
        closed,
        createdDay: issue.createdAt === null ? null : localDay(new Date(issue.createdAt)),
        closedDay: closed && issue.closedAt !== null ? localDay(new Date(issue.closedAt)) : null,
      };
    });
}

const endedIn = (bug: Bug, outcome: Bug['outcome'], period: Period) => bug.outcome === outcome && bug.closedDay !== null && inPeriod(bug.closedDay, period);

function resolution(bugs: Bug[], period: Period): BugResolution {
  const resolved = bugs.filter((bug) => endedIn(bug, 'resolved', period));
  const days = resolved.filter((bug) => bug.createdDay !== null).map((bug) => daysBetween(bug.createdDay!, bug.closedDay!));
  return {
    resolved: resolved.length,
    rejected: bugs.filter((bug) => endedIn(bug, 'rejected', period)).length,
    resolutionTime: { medianDays: median(days), count: days.length },
  };
}

function trend(bugs: Bug[], period: Period): BugTrendEntry {
  return {
    period: period.id,
    created: bugs.filter((bug) => bug.createdDay !== null && inPeriod(bug.createdDay, period)).length,
    resolved: bugs.filter((bug) => endedIn(bug, 'resolved', period)).length,
    rejected: bugs.filter((bug) => endedIn(bug, 'rejected', period)).length,
    // Created by the period's last day (or on an unknown day) and not closed by then.
    open: bugs.filter((bug) => (bug.createdDay === null || bug.createdDay <= period.finish) && !(bug.closed && (bug.closedDay === null || bug.closedDay <= period.finish))).length,
  };
}

export function bugMetrics({ snapshot, periods }: MetricsContext): { developer: DeveloperBugs; bugTrend: BugTrendEntry[] } {
  const bugs = bugsOf(snapshot);
  const mine = bugs.filter((bug) => bug.assignee === snapshot.me.id);
  return {
    developer: { periods: periods.map((period) => ({ period: period.id, all: resolution(bugs, period), mine: resolution(mine, period) })) },
    bugTrend: periods.map((period) => trend(bugs, period)),
  };
}

function describeResolution({ resolved, rejected, resolutionTime }: BugResolution): string {
  const time = resolutionTime.medianDays === null ? '' : ` (median ${resolutionTime.medianDays} days)`;
  return `${resolved} resolved${time}, ${rejected} rejected`;
}

/** The bug lines of the developer section, in text form. */
export function formatDeveloperBugsText(bugs: DeveloperBugs, periods: Period[]): string[] {
  return bugs.periods.flatMap((entry, index) => {
    const period = periods[index]!;
    return [`  Bugs, ${period.name}${period.current ? ' (current)' : ''}: ${describeResolution(entry.all)}`, `    mine: ${describeResolution(entry.mine)}`];
  });
}

/** The bug trend in text form. */
export function formatBugTrendText(trend: BugTrendEntry[], periods: Period[]): string[] {
  return [
    'Bug trend:',
    ...trend.map((entry, index) => {
      const period = periods[index]!;
      return `  ${period.name}${period.current ? ' (current)' : ''}: ${entry.created} created, ${entry.resolved} resolved, ${entry.rejected} rejected, ${entry.open} open at the end`;
    }),
  ];
}
