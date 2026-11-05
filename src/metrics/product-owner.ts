// The `productOwner` section of `taigent metrics` (GLOSSARY.md, Dashboards), besides the bug trend (bugs.ts) and the
// release burndown (releases.ts): the current sprint against its ideal line, velocity, planned vs completed, the
// project's health, and the sprint and epic tables of `report`, computed by report.ts so both stay the same. A kanban
// project has no sprint metrics: no `currentSprint`, `velocity`, `planned` or sprint pace.

import { addDays, daysBetween } from '../days.ts';
import { formatReportTablesText, reportTables, type Progress, type ReportTables, type SprintReport } from '../report.ts';
import type { BugTrendEntry } from './bugs.ts';
import { HISTORY_UNAVAILABLE, type MetricsContext } from './context.ts';
import type { DeveloperMetrics } from './developer.ts';
import type { Period } from './periods.ts';

/** How many closed sprints velocity covers. */
const VELOCITY_SPRINTS = 6;

export interface CurrentSprint {
  id: number;
  name: string;
  /** First and last day, YYYY-MM-DD. */
  start: string;
  finish: string;
  /** From the sprint's stats and points, as in the sprint table. */
  stories: Progress;
  tasks: Progress;
  points: Progress;
  /** Days from the first day to today, and to the last day. */
  days: { elapsed: number; total: number };
  /** The ideal line: points left on each day, linear from all of them on the first day to 0 on the last. */
  ideal: { day: string; points: number }[];
}

export interface VelocityEntry {
  /** `sprint:<id>`, like a period's id. */
  sprint: string;
  name: string;
  start: string;
  finish: string;
  /** Points closed in the sprint. */
  points: number;
}

export interface Planned {
  /** `current`: the sprint's points now, not the points committed at its start (that needs the history). */
  basis: 'current';
  /** One per period, in the order of the report's `periods`. */
  sprints: { period: string; planned: number; completed: number }[];
}

export type HealthLevel = 'green' | 'yellow' | 'red';

interface Signal {
  level: HealthLevel;
  /** Why, with the figures. */
  reason: string;
}

export interface Health {
  /** The current sprint's points left against its ideal line today; absent on a kanban project. */
  sprintPace?: Signal & { sprint: string | null; behindPoints: number | null; behindPercent: number | null };
  /** Open stories and tasks due before today. */
  overdue: Signal & { stories: number; tasks: number };
  /** Periods in a row, up to the current one, whose bugs open at the end rose over the period before (at most 2). */
  openBugs: Signal & { risingPeriods: number };
  /** Open blocked user stories. */
  blocked: Signal & { stories: number };
}

export interface ProductOwnerMetrics {
  /** The open sprint holding today, or null; absent on a kanban project. */
  currentSprint?: CurrentSprint | null;
  /** The last VELOCITY_SPRINTS closed sprints, oldest first; absent on a kanban project. */
  velocity?: VelocityEntry[];
  /** Absent on a kanban project. */
  planned?: Planned;
  health: Health;
  /** The tables of `taigent report --json`, without its `project`. */
  report: ReportTables;
}

const round = (value: number, digits: number) => Number(value.toFixed(digits));

function currentSprint(sprints: SprintReport[], today: string): CurrentSprint | null {
  // `sprints` is newest first: the latest open sprint holding today.
  const sprint = sprints.find((candidate) => !candidate.closed && candidate.start <= today && today <= candidate.finish);
  if (!sprint) return null;
  const { id, name, start, finish, stories, tasks, points } = sprint;
  const total = daysBetween(start, finish);
  const idealAt = (index: number) => (total === 0 ? 0 : round(points.total * (1 - index / total), 2));
  return {
    id, name, start, finish, stories, tasks, points,
    days: { elapsed: daysBetween(start, today), total },
    ideal: Array.from({ length: total + 1 }, (_, index) => ({ day: addDays(start, index), points: idealAt(index) })),
  };
}

function velocity(sprints: SprintReport[]): VelocityEntry[] {
  return sprints
    .filter((sprint) => sprint.closed)
    .slice(0, VELOCITY_SPRINTS)
    .reverse()
    .map(({ id, name, start, finish, points }) => ({ sprint: `sprint:${id}`, name, start, finish, points: points.done }));
}

function planned(sprints: SprintReport[], periods: Period[]): Planned {
  const byPeriod = new Map(sprints.map((sprint) => [`sprint:${sprint.id}`, sprint]));
  return {
    basis: 'current',
    sprints: periods.flatMap((period) => {
      const sprint = byPeriod.get(period.id);
      return sprint ? [{ period: period.id, planned: sprint.points.total, completed: sprint.points.done }] : [];
    }),
  };
}

/** More than 10% of the sprint's points behind the ideal line is yellow, more than 25% red. */
function sprintPace(sprint: CurrentSprint | null): NonNullable<Health['sprintPace']> {
  if (!sprint) return { level: 'green', reason: 'no open sprint holds today', sprint: null, behindPoints: null, behindPercent: null };
  const { points, days } = sprint;
  const left = points.total - points.done;
  const ideal = days.total === 0 ? 0 : points.total * (1 - days.elapsed / days.total);
  const behind = left - ideal;
  const percent = points.total === 0 ? 0 : (behind / points.total) * 100;
  const level: HealthLevel = percent > 25 ? 'red' : percent > 10 ? 'yellow' : 'green';
  const where = behind > 0 ? `${round(behind, 2)} points (${round(percent, 1)}%) behind the ideal line` : 'on or ahead of the ideal line';
  return {
    level,
    reason: `${sprint.name} is ${where}: ${left} of ${points.total} points left on day ${days.elapsed} of ${days.total}, ideally ${round(ideal, 2)}`,
    sprint: `sprint:${sprint.id}`,
    behindPoints: round(behind, 2),
    behindPercent: round(percent, 1),
  };
}

/** 1 or 2 overdue stories and tasks is yellow, 3 or more red. */
function overdue(items: DeveloperMetrics['overdue']): Health['overdue'] {
  const stories = items.filter((item) => item.type === 'story').length;
  const tasks = items.length - stories;
  const level: HealthLevel = items.length >= 3 ? 'red' : items.length >= 1 ? 'yellow' : 'green';
  return { level, reason: `${stories} open ${stories === 1 ? 'story' : 'stories'} and ${tasks} open ${tasks === 1 ? 'task' : 'tasks'} overdue`, stories, tasks };
}

/** Bugs open at the end rising over 1 period is yellow, over 2 periods in a row red. */
function openBugs(trend: BugTrendEntry[]): Health['openBugs'] {
  const open = trend.map((entry) => entry.open);
  let rising = 0;
  while (rising < 2 && open.length - rising >= 2 && open[open.length - 1 - rising]! > open[open.length - 2 - rising]!) rising += 1;
  const level: HealthLevel = rising >= 2 ? 'red' : rising === 1 ? 'yellow' : 'green';
  const shown = open.slice(-3).join(' → ');
  const reason = open.length < 2
    ? `${open.length === 0 ? 'no period' : 'only one period'} to compare open bugs`
    : rising === 0
      ? `open bugs at the end of the periods did not rise in the last one (${shown})`
      : `open bugs at the end of the periods rose in the last ${rising === 1 ? 'one' : '2 in a row'} (${shown})`;
  return { level, reason, risingPeriods: rising };
}

/** 1 blocked user story is yellow, 2 or more red. */
function blocked(items: DeveloperMetrics['blocked']): Health['blocked'] {
  const stories = items.filter((item) => item.type === 'story').length;
  const level: HealthLevel = stories >= 2 ? 'red' : stories === 1 ? 'yellow' : 'green';
  return { level, reason: `${stories} open user ${stories === 1 ? 'story is' : 'stories are'} blocked`, stories };
}

export function productOwnerMetrics(context: MetricsContext, developer: DeveloperMetrics, bugTrend: BugTrendEntry[]): ProductOwnerMetrics {
  const { snapshot, today, cadence, periods, notes } = context;
  const report = reportTables({ milestones: snapshot.sprints, stories: snapshot.stories, ...snapshot.report });
  const health: Health = { overdue: overdue(developer.overdue), openBugs: openBugs(bugTrend), blocked: blocked(developer.blocked) };
  if (cadence === 'week') return { health, report };
  for (const metric of ['productOwner.planned.sprintStart', 'productOwner.scopeChange']) notes.unavailable.push({ metric, reason: 'history', message: HISTORY_UNAVAILABLE });
  const sprint = currentSprint(report.sprints, today);
  return {
    currentSprint: sprint,
    velocity: velocity(report.sprints),
    planned: planned(report.sprints, periods),
    health: { sprintPace: sprintPace(sprint), ...health },
    report,
  };
}

const describe = (name: string, signal: Signal) => `    ${name}: ${signal.level}, ${signal.reason}`;

/** The product owner section in text form (the bug trend and release burndown have their own). */
export function formatProductOwnerText(productOwner: ProductOwnerMetrics, periods: Period[]): string[] {
  const { currentSprint: sprint, velocity: closed, planned: plan, health, report } = productOwner;
  const lines = ['Product owner:'];
  if (sprint === null) lines.push('  Current sprint: none holds today');
  if (sprint) {
    const { name, days, points, stories, tasks } = sprint;
    const ideal = sprint.ideal[days.elapsed]?.points ?? 0;
    lines.push(`  Current sprint: ${name}, day ${days.elapsed} of ${days.total}: points ${points.done}/${points.total} done, stories ${stories.done}/${stories.total} done, tasks ${tasks.done}/${tasks.total} done; ideal ${ideal} points left today`);
  }
  if (closed) lines.push(`  Velocity (points closed): ${closed.length === 0 ? 'no closed sprint' : closed.map((entry) => `${entry.name} ${entry.points}`).join(', ')}`);
  if (plan) {
    const names = new Map(periods.map((period) => [period.id, period.name]));
    const sprints = plan.sprints.map((entry) => `${names.get(entry.period)} ${entry.completed}/${entry.planned}`).join(', ');
    lines.push(`  Completed/planned points (planned as the sprint's points now): ${sprints || 'no sprint started'}`);
  }
  lines.push('  Health:');
  if (health.sprintPace) lines.push(describe('sprint pace', health.sprintPace));
  lines.push(describe('overdue', health.overdue), describe('open bugs', health.openBugs), describe('blocked', health.blocked));
  lines.push('', ...formatReportTablesText(report));
  return lines;
}
