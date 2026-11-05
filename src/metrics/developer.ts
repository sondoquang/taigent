// The `developer` section of `taigent metrics` (GLOSSARY.md, Dashboards): throughput per period, lead time,
// workload, blocked and overdue work, from the snapshot alone. User stories and tasks are always counted apart.
// Figures come for the whole team (`all`) and for the user the CLI logs in as (`mine`); lists carry each item's
// assignees, so a client can narrow them to `me` ("Chỉ tôi") itself.

import { daysBetween } from '../days.ts';
import { HISTORY_UNAVAILABLE, type MetricsContext } from './context.ts';
import { inPeriod, type Period } from './periods.ts';
import type { Person } from './snapshot.ts';
import { median, type WorkItem, type WorkType } from './work.ts';

/** A figure for the whole team and for `me`. */
export interface Scoped<T> {
  all: T;
  mine: T;
}

export interface Throughput {
  /** Assigned: open at some time in the period and assigned to someone. Completed: closed in the period. */
  stories: { assigned: number; completed: number };
  tasks: { assigned: number; completed: number };
}

export interface LeadTime {
  /** Median days from the day an item was created to the day it was closed; null without samples. */
  medianDays: number | null;
  /** Items closed in the periods, created on a known day. */
  count: number;
}

export interface WorkloadRow {
  /** Null for the "Chưa giao" row: open work assigned to no one. */
  assignee: number | null;
  /** Null for the unassigned row, and for an assignee who is no longer a member. */
  username: string | null;
  stories: number;
  tasks: number;
  /** Points of those open stories. */
  points: number;
}

/** An open story or task of a list. */
export interface DeveloperItem {
  type: WorkType;
  id: number;
  ref: number;
  subject: string;
  status: string;
  assignees: number[];
  dueDate: string | null;
  blocked: boolean;
  /** A story's points; null for a task or a story without points. */
  points: number | null;
}

export interface DeveloperMetrics {
  me: Person;
  /** The project's members, to name assignees. */
  people: Person[];
  /** One per period, in the order of the report's `periods`. */
  periods: ({ period: string } & Scoped<Throughput>)[];
  /** Over the items closed in the report's periods. */
  leadTime: Scoped<{ stories: LeadTime; tasks: LeadTime }>;
  /** One row per assignee with open work, by username, then the unassigned row. */
  workload: WorkloadRow[];
  /** Open blocked items: stories, then tasks, by ref. */
  blocked: DeveloperItem[];
  /** Open items due before today (due today is not overdue), earliest due day first. */
  overdue: DeveloperItem[];
}

function activeIn(item: WorkItem, period: Period): boolean {
  const created = item.createdDay === null || item.createdDay <= period.finish;
  return created && (!item.closed || (item.closedDay !== null && item.closedDay >= period.start));
}

const completedIn = (item: WorkItem, period: Period) => item.closedDay !== null && inPeriod(item.closedDay, period);

function throughput(items: WorkItem[], period: Period): Throughput {
  const of = (type: WorkType) => {
    const typed = items.filter((item) => item.type === type);
    return {
      assigned: typed.filter((item) => item.assignees.length > 0 && activeIn(item, period)).length,
      completed: typed.filter((item) => completedIn(item, period)).length,
    };
  };
  return { stories: of('story'), tasks: of('task') };
}

function leadTimes(items: WorkItem[], periods: Period[]): { stories: LeadTime; tasks: LeadTime } {
  const of = (type: WorkType): LeadTime => {
    const days = items
      .filter((item) => item.type === type && item.createdDay !== null && periods.some((period) => completedIn(item, period)))
      .map((item) => daysBetween(item.createdDay!, item.closedDay!));
    return { medianDays: median(days), count: days.length };
  };
  return { stories: of('story'), tasks: of('task') };
}

function workload(open: WorkItem[], people: Map<number, string>): WorkloadRow[] {
  const empty = (assignee: number | null): WorkloadRow => ({ assignee, username: assignee === null ? null : (people.get(assignee) ?? null), stories: 0, tasks: 0, points: 0 });
  const unassigned = empty(null);
  const rows = new Map<number, WorkloadRow>();
  for (const item of open) {
    const counted = item.assignees.length === 0 ? [unassigned] : item.assignees.map((id) => rows.get(id) ?? rows.set(id, empty(id)).get(id)!);
    for (const row of counted) {
      if (item.type === 'story') {
        row.stories += 1;
        row.points += item.points ?? 0;
      } else {
        row.tasks += 1;
      }
    }
  }
  // Assignees who left the project (no username) after the members, by id.
  const named = [...rows.values()].sort((a, b) => (a.username ?? '\uffff').localeCompare(b.username ?? '\uffff') || a.assignee! - b.assignee!);
  return [...named, unassigned];
}

function developerItem(item: WorkItem): DeveloperItem {
  const { type, id, ref, subject, status, assignees, dueDate, blocked, points } = item;
  return { type, id, ref, subject, status, assignees, dueDate, blocked, points };
}

const TYPE_ORDER: Record<WorkType, number> = { story: 0, task: 1 };
const byTypeAndRef = (a: WorkItem, b: WorkItem) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || a.ref - b.ref;

export function developerMetrics({ snapshot, today, periods, work, notes }: MetricsContext): DeveloperMetrics {
  const { me } = snapshot;
  const mine = work.filter((item) => item.assignees.includes(me.id));
  const open = work.filter((item) => !item.closed);
  notes.unavailable.push({ metric: 'developer.cycleTime', reason: 'history', message: HISTORY_UNAVAILABLE });
  return {
    me,
    people: snapshot.members,
    periods: periods.map((period) => ({ period: period.id, all: throughput(work, period), mine: throughput(mine, period) })),
    leadTime: { all: leadTimes(work, periods), mine: leadTimes(mine, periods) },
    workload: workload(open, new Map(snapshot.members.map((member) => [member.id, member.username]))),
    blocked: open.filter((item) => item.blocked).sort(byTypeAndRef).map(developerItem),
    overdue: open
      .filter((item) => item.dueDate !== null && item.dueDate < today)
      .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!) || byTypeAndRef(a, b))
      .map(developerItem),
  };
}

function describeThroughput({ stories, tasks }: Throughput): string {
  return `stories ${stories.assigned} assigned, ${stories.completed} completed; tasks ${tasks.assigned} assigned, ${tasks.completed} completed`;
}

function describeLeadTime({ medianDays, count }: LeadTime): string {
  return medianDays === null ? 'none closed' : `${medianDays} days (${count} closed)`;
}

function describeItem(item: DeveloperItem, people: Map<number, string>): string {
  const assignees = item.assignees.map((id) => people.get(id) ?? `#${id}`).join(', ') || 'unassigned';
  const due = item.dueDate === null ? '' : `, due ${item.dueDate}`;
  return `    ${item.type} #${item.ref} ${item.subject} (${item.status}${due}; ${assignees})`;
}

/** The developer section in text form, after the report's header. */
export function formatDeveloperText(developer: DeveloperMetrics, periods: Period[]): string[] {
  const people = new Map(developer.people.map((person) => [person.id, person.username]));
  const lines = [`Developer (mine: ${developer.me.username}):`];
  developer.periods.forEach((entry, index) => {
    const period = periods[index]!;
    lines.push(`  ${period.name}${period.current ? ' (current)' : ''}: ${describeThroughput(entry.all)}`);
    lines.push(`    mine: ${describeThroughput(entry.mine)}`);
  });
  if (developer.periods.length === 0) lines.push('  No period has started.');
  const { all, mine } = developer.leadTime;
  lines.push(`  Lead time (median): stories ${describeLeadTime(all.stories)}, tasks ${describeLeadTime(all.tasks)}`);
  lines.push(`    mine: stories ${describeLeadTime(mine.stories)}, tasks ${describeLeadTime(mine.tasks)}`);
  lines.push('  Workload (open):');
  for (const row of developer.workload) {
    const who = row.assignee === null ? 'Unassigned' : (row.username ?? `#${row.assignee}`);
    lines.push(`    ${who}: ${row.stories} ${row.stories === 1 ? 'story' : 'stories'} (${row.points} points), ${row.tasks} ${row.tasks === 1 ? 'task' : 'tasks'}`);
  }
  lines.push(`  Blocked (${developer.blocked.length}):`, ...developer.blocked.map((item) => describeItem(item, people)));
  lines.push(`  Overdue (${developer.overdue.length}):`, ...developer.overdue.map((item) => describeItem(item, people)));
  return lines;
}
