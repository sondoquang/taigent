// Bug figures of `taigent metrics` (GLOSSARY.md, Dashboards): the bug resolution of the `developer` section and the
// bug trend of the `productOwner` section. A bug is an issue whose type is Bug (a story tagged `type:bug` is not one);
// it is resolved in Ready for test or Closed, and Rejected is counted on its own. These are the only metrics that go
// by a status's name, because the glossary defines a resolved bug by it; open and closed still go by the status's
// closed flag. A bug's history tells when it was resolved, rejected and reopened (moved from a resolved status back
// to an open one) and whether it was open at a period's end; a bug whose history records no status change goes by
// its current status and the days it was created and closed.

import { daysBetween, localDay } from '../days.ts';
import type { TaigaHistoryStatus, TaigaIssueValue } from '../taiga/client.ts';
import type { MetricsContext } from './context.ts';
import type { Scoped } from './developer.ts';
import { inPeriod, type Period } from './periods.ts';
import type { MetricsSnapshot } from './snapshot.ts';
import { historyStatusName, median } from './work.ts';

const BUG_TYPE = 'Bug';

/** The ids of the project's issue types that make an issue a bug: the type named Bug. */
export function bugTypeIds(issueTypes: TaigaIssueValue[]): Set<number> {
  return new Set(issueTypes.filter((type) => type.name === BUG_TYPE).map((type) => type.id));
}

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
  /** Local days it moved into a resolved status; without status changes, its closed day while resolved. */
  resolvedDays: string[];
  /** Local days it moved into Rejected; without status changes, its closed day while Rejected. */
  rejectedDays: string[];
  /** Local days it moved from a resolved status back to an open one. */
  reopenedDays: string[];
  /** Whether its status was closed before its first recorded status change, and after each one (oldest first). */
  initiallyClosed: boolean;
  changes: { day: string; closed: boolean }[];
}

export interface BugResolution {
  /** Bugs resolved in the period (moved into Ready for test or Closed in it), and bugs Rejected in it (moved into it). */
  resolved: number;
  rejected: number;
  /** Median days from the local day a resolved bug was created to the day it was resolved; null without samples. */
  resolutionTime: { medianDays: number | null; count: number };
  /** Bugs reopened in the period, and their share of the bugs resolved in it (null when none was resolved). */
  reopened: number;
  reopenRate: number | null;
}

export interface DeveloperBugs {
  /** One per period, in the order of the report's `periods`; `mine` holds the bugs assigned to `me`. */
  periods: ({ period: string } & Scoped<BugResolution>)[];
}

export interface BugTrendEntry {
  period: string;
  /** Bugs created, resolved, rejected and reopened in the period, and bugs open at its last day. */
  created: number;
  resolved: number;
  rejected: number;
  reopened: number;
  open: number;
}

function bugsOf(snapshot: MetricsSnapshot): Bug[] {
  const bugTypes = bugTypeIds(snapshot.issueTypes);
  const statuses = new Map(snapshot.statuses.issue.map((status) => [status.id, status]));
  return snapshot.issues
    .filter((issue) => issue.typeId !== null && bugTypes.has(issue.typeId))
    .map((issue): Bug => {
      const status = issue.statusId === null ? undefined : statuses.get(issue.statusId);
      const name = status?.name ?? issue.status;
      const closed = status?.isClosed ?? issue.isClosed;
      const outcome = RESOLVED_STATUSES[name] === true ? 'resolved' : name === REJECTED_STATUS ? 'rejected' : 'other';
      const closedDay = closed && issue.closedAt !== null ? localDay(new Date(issue.closedAt)) : null;
      // A status goes by its name and closed flag in the project's list (`historyStatusName`); a status no longer in
      // the list is closed only when it is the issue's own.
      const isResolved = (value: TaigaHistoryStatus | null) => RESOLVED_STATUSES[historyStatusName(value, statuses) ?? ''] === true;
      const isRejected = (value: TaigaHistoryStatus | null) => historyStatusName(value, statuses) === REJECTED_STATUS;
      const isClosed = (value: TaigaHistoryStatus | null) => value !== null && (statuses.get(value.id)?.isClosed ?? (value.id === issue.statusId && issue.isClosed));
      const moves = (snapshot.history.issue.get(issue.id) ?? []).flatMap((entry) => (entry.status ? [{ day: localDay(new Date(entry.at)), ...entry.status }] : []));
      const fallback = (ended: Bug['outcome']) => (outcome === ended && closedDay !== null ? [closedDay] : []);
      const into = (is: (value: TaigaHistoryStatus | null) => boolean) => moves.filter((move) => is(move.to) && !is(move.from)).map((move) => move.day);
      return {
        assignee: issue.assignedTo,
        outcome,
        closed,
        createdDay: issue.createdAt === null ? null : localDay(new Date(issue.createdAt)),
        closedDay,
        resolvedDays: moves.length === 0 ? fallback('resolved') : into(isResolved),
        rejectedDays: moves.length === 0 ? fallback('rejected') : into(isRejected),
        reopenedDays: moves.filter((move) => isResolved(move.from) && move.to !== null && !isClosed(move.to)).map((move) => move.day),
        initiallyClosed: moves.length > 0 && isClosed(moves[0]!.from),
        changes: moves.map((move) => ({ day: move.day, closed: isClosed(move.to) })),
      };
    });
}

/** Whether the bug was open at the end of `day`: created by then (or on an unknown day) and not closed then. */
function openAt(bug: Bug, day: string): boolean {
  if (bug.createdDay !== null && bug.createdDay > day) return false;
  if (bug.changes.length === 0) return !(bug.closed && (bug.closedDay === null || bug.closedDay <= day));
  const last = bug.changes.findLast((change) => change.day <= day);
  return !(last === undefined ? bug.initiallyClosed : last.closed);
}

/** The last day in the period from `days`, if any. */
const lastIn = (days: string[], period: Period) => days.findLast((day) => inPeriod(day, period));

const rejectedIn = (bugs: Bug[], period: Period) => bugs.filter((bug) => lastIn(bug.rejectedDays, period) !== undefined).length;

const reopenedIn = (bugs: Bug[], period: Period) => bugs.filter((bug) => lastIn(bug.reopenedDays, period) !== undefined).length;

function resolution(bugs: Bug[], period: Period): BugResolution {
  const resolved = bugs.flatMap((bug) => {
    const day = lastIn(bug.resolvedDays, period);
    return day === undefined ? [] : [{ bug, day }];
  });
  const days = resolved.filter(({ bug }) => bug.createdDay !== null).map(({ bug, day }) => daysBetween(bug.createdDay!, day));
  const reopened = reopenedIn(bugs, period);
  return {
    resolved: resolved.length,
    rejected: rejectedIn(bugs, period),
    resolutionTime: { medianDays: median(days), count: days.length },
    reopened,
    reopenRate: resolved.length === 0 ? null : reopened / resolved.length,
  };
}

function trend(bugs: Bug[], period: Period): BugTrendEntry {
  return {
    period: period.id,
    created: bugs.filter((bug) => bug.createdDay !== null && inPeriod(bug.createdDay, period)).length,
    resolved: bugs.filter((bug) => lastIn(bug.resolvedDays, period) !== undefined).length,
    rejected: rejectedIn(bugs, period),
    reopened: reopenedIn(bugs, period),
    open: bugs.filter((bug) => openAt(bug, period.finish)).length,
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

function describeResolution({ resolved, rejected, resolutionTime, reopened, reopenRate }: BugResolution): string {
  const time = resolutionTime.medianDays === null ? '' : ` (median ${resolutionTime.medianDays} days)`;
  const rate = reopenRate === null ? '' : ` (reopen rate ${Math.round(reopenRate * 100)}%)`;
  return `${resolved} resolved${time}, ${rejected} rejected, ${reopened} reopened${rate}`;
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
      return `  ${period.name}${period.current ? ' (current)' : ''}: ${entry.created} created, ${entry.resolved} resolved, ${entry.rejected} rejected, ${entry.reopened} reopened, ${entry.open} open at the end`;
    }),
  ];
}
