// `taigent tickets`: the Period's tickets of the authenticated user (see GLOSSARY.md, "Reporting on your work"): the
// planned tickets plus those moved to Done in the period, each with its progress group, Finishing day, Due status and
// Effort. Read-only. Days are calendar days in the local time zone (TZ); the client knows Taiga's field names.

import { localDay, localMinute, parseDay } from './days.ts';
import { readHistories } from './metrics/history.ts';
import { historyStatusName } from './metrics/work.ts';
import type { TaigaAssignedStory, TaigaClient, TaigaHistoryEntry, TaigaStatus } from './taiga/client.ts';

/** An inclusive range of days: `from` and `to` as written (YYYY-MM-DD), `start`/`end` the instants bounding it. */
export interface DayRange {
  from: string;
  to: string;
  /** Local midnight starting `from`. */
  start: Date;
  /** Local midnight ending `to` (exclusive). */
  end: Date;
}

/**
 * The progress groups, in workflow order: the user story statuses of a Period's ticket, by their template names
 * (docs/taiga/conventions.md §7). Ready, In progress and Ready for test hold the planned tickets.
 */
export const PROGRESS_GROUPS = ['Ready', 'In progress', 'Ready for test', 'Done'] as const;
export type ProgressGroup = (typeof PROGRESS_GROUPS)[number];

/** The progress groups of a finished ticket: the developer's part is done. */
const FINISHED: Record<string, true> = { 'Ready for test': true, Done: true };

export const DUE_STATUSES = ['On time', 'Late', 'Overdue', 'Due today', 'On track', 'No due date'] as const;
export type DueStatus = (typeof DUE_STATUSES)[number];

/** One ticket of the period. */
export interface Ticket {
  id: number;
  ref: number;
  subject: string;
  /** Status name, as Taiga names it. */
  status: string;
  /** The progress group: the ticket's status. */
  progress: ProgressGroup;
  /** In Ready for test or Done. */
  isFinished: boolean;
  project: { id: number; slug: string; name: string };
  /** Username of every assignee; the user id when it matches no project member. */
  assignees: (string | number)[];
  /** YYYY-MM-DD, or null. */
  dueDate: string | null;
  /** When Taiga closed it (ISO 8601): a Done ticket's closing instant, null when Taiga recorded none or it is not Done. */
  closedAt: string | null;
  /** The instant of its Finishing day (ISO 8601); null when not finished, or when neither history nor closing tells it. */
  finishedAt: string | null;
  /** Null only for a finished ticket with a due date but no known finishing day: it cannot be compared. */
  dueStatus: DueStatus | null;
  /** Hours: the Spent Time value when set (0 included), else `total_points` (1 point = 1 hour), else null. */
  effort: number | null;
  effortSource: EffortSource | null;
}

/** Where an effort comes from: the "Spent Time" custom attribute, or the story's total points (an estimate). */
export type EffortSource = 'spent' | 'points';

/** The `--json` output of `taigent tickets`. */
export interface TicketsReport {
  user: { id: number; username: string };
  /** The `--project` slug, or null for every project the user sees. */
  project: string | null;
  range: { from: string; to: string; start: string; end: string };
  /** The local day of "now" that due dates are compared with (YYYY-MM-DD). */
  today: string;
  /** "Now" (ISO 8601): `TAIGENT_NOW` when set, else the system clock. */
  generatedAt: string;
  /** By progress group in workflow order; not finished ones by due date (none last), finished ones by `finishedAt` (none last); then by ref. */
  tickets: Ticket[];
  /** Every day of the range: the tickets whose finishing day it is and the sum of their effort (hours). */
  days: { date: string; finished: number; effort: number }[];
  summary: TicketsSummary;
  notes: {
    /** Runs of 3 or more tickets, each closed at most 60 seconds after the previous one, by closing time. */
    bulkCloses: { count: number; first: string; last: string; tickets: TicketId[] }[];
    /** Tickets with neither Spent Time nor points. */
    missingEffort: TicketId[];
  };
}

/** How notes name a ticket: its ref and its project's slug. */
export interface TicketId {
  ref: number;
  project: string;
}

const ticketId = (ticket: Ticket): TicketId => ({ ref: ticket.ref, project: ticket.project.slug });

/** Totals of `tickets`. */
export interface TicketsSummary {
  tickets: number;
  byProgress: Record<ProgressGroup, number>;
  /** `withoutFinishingDay`: finished tickets with a due date but no known finishing day, which have no due status. */
  finished: { total: number; byDueStatus: Record<'On time' | 'Late' | 'No due date', number>; withoutFinishingDay: number };
  notFinished: { total: number; byDueStatus: Record<'Overdue' | 'Due today' | 'On track' | 'No due date', number> };
  /** Hours in total, and the hours and tickets of each effort source. */
  effort: { hours: number; spent: { hours: number; tickets: number }; points: { hours: number; tickets: number } };
  /** Most tickets first, then by slug. */
  projects: { slug: string; name: string; tickets: number }[];
}

/** The range from `from` to `to` inclusive; both must be calendar days (`parseDay`), `from` not after `to`. */
export function dayRange(from: string, to: string): DayRange {
  const start = parseDay(from)!;
  const last = parseDay(to)!;
  return { from, to, start, end: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1) };
}

/** The progress group of a Period's ticket: a planned ticket, or one moved to Done in the range; undefined for any other story. */
function progressOf(story: TaigaAssignedStory, range: DayRange): ProgressGroup | undefined {
  if (story.status === 'Done') {
    if (story.closedAt === null) return undefined;
    const closedAt = new Date(story.closedAt);
    return closedAt >= range.start && closedAt < range.end ? 'Done' : undefined;
  }
  return PROGRESS_GROUPS.find((group) => group === story.status);
}

/**
 * The Finishing day instant of a finished ticket: its last status change into a finished status from one that is not
 * (none counts as not finished); without one, Taiga's closing instant of a Done ticket, else null.
 */
function finishedAtOf(progress: ProgressGroup, closedAt: string | null, history: TaigaHistoryEntry[], statuses: Map<number, TaigaStatus>): string | null {
  const finishing = history.findLast(
    ({ status }) =>
      status !== null && FINISHED[historyStatusName(status.to, statuses) ?? ''] === true && FINISHED[historyStatusName(status.from, statuses) ?? ''] !== true,
  );
  return finishing?.at ?? (progress === 'Done' ? closedAt : null);
}

/** Due status by calendar day: a finished ticket's finishing day, or a ticket not finished `today`, against its due date. */
function dueStatusOf(dueDate: string | null, isFinished: boolean, finishedAt: string | null, today: string): DueStatus | null {
  if (dueDate === null) return 'No due date';
  if (isFinished) {
    if (finishedAt === null) return null;
    return localDay(new Date(finishedAt)) <= dueDate ? 'On time' : 'Late';
  }
  if (dueDate < today) return 'Overdue';
  return dueDate === today ? 'Due today' : 'On track';
}

function effortOf(spent: unknown, story: TaigaAssignedStory): Pick<Ticket, 'effort' | 'effortSource'> {
  if (typeof spent === 'number' && Number.isFinite(spent)) return { effort: spent, effortSource: 'spent' };
  if (story.totalPoints !== null) return { effort: story.totalPoints, effortSource: 'points' };
  return { effort: null, effortSource: null };
}

/** Ascending, null last. */
function compareNullable<T>(a: T | null, b: T | null, compare: (a: T, b: T) => number): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return compare(a, b);
}

function compareTickets(a: Ticket, b: Ticket): number {
  const byGroup = PROGRESS_GROUPS.indexOf(a.progress) - PROGRESS_GROUPS.indexOf(b.progress);
  if (byGroup !== 0) return byGroup;
  const byDay = a.isFinished
    ? compareNullable(a.finishedAt, b.finishedAt, (x, y) => Date.parse(x) - Date.parse(y))
    : compareNullable(a.dueDate, b.dueDate, (x, y) => x.localeCompare(y));
  return byDay || a.ref - b.ref;
}

/** Sum of efforts in hours, rounded to hundredths so float noise never shows. */
function sumHours(tickets: Ticket[]): number {
  return Math.round(tickets.reduce((sum, ticket) => sum + (ticket.effort ?? 0), 0) * 100) / 100;
}

/** Every day from `range.from` to `range.to`, with the tickets finished on it. */
function daysOf(tickets: Ticket[], range: DayRange): TicketsReport['days'] {
  const finishedByDay = Map.groupBy(
    tickets.filter((ticket) => ticket.finishedAt !== null),
    (ticket) => localDay(new Date(ticket.finishedAt!)),
  );
  const days: TicketsReport['days'] = [];
  for (let day = range.start; day < range.end; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
    const finished = finishedByDay.get(localDay(day)) ?? [];
    days.push({ date: localDay(day), finished: finished.length, effort: sumHours(finished) });
  }
  return days;
}

function summarize(tickets: Ticket[]): TicketsSummary {
  const finished = tickets.filter((ticket) => ticket.isFinished);
  const notFinished = tickets.filter((ticket) => !ticket.isFinished);
  const count = <S extends string>(group: Ticket[], statuses: readonly S[]) =>
    Object.fromEntries(statuses.map((status) => [status, group.filter((ticket) => ticket.dueStatus === status).length])) as Record<S, number>;
  const spent = tickets.filter((ticket) => ticket.effortSource === 'spent');
  const points = tickets.filter((ticket) => ticket.effortSource === 'points');
  const byProject = Map.groupBy(tickets, (ticket) => ticket.project.slug);
  return {
    tickets: tickets.length,
    byProgress: Object.fromEntries(PROGRESS_GROUPS.map((group) => [group, tickets.filter((ticket) => ticket.progress === group).length])) as Record<ProgressGroup, number>,
    finished: {
      total: finished.length,
      byDueStatus: count(finished, ['On time', 'Late', 'No due date']),
      withoutFinishingDay: finished.filter((ticket) => ticket.dueStatus === null).length,
    },
    notFinished: { total: notFinished.length, byDueStatus: count(notFinished, ['Overdue', 'Due today', 'On track', 'No due date']) },
    effort: {
      hours: sumHours(tickets),
      spent: { hours: sumHours(spent), tickets: spent.length },
      points: { hours: sumHours(points), tickets: points.length },
    },
    projects: [...byProject]
      .map(([slug, group]) => ({ slug, name: group[0]!.project.name, tickets: group.length }))
      .sort((a, b) => b.tickets - a.tickets || a.slug.localeCompare(b.slug)),
  };
}

const BULK_GAP_MS = 60_000;
const BULK_MIN = 3;

/** Runs of tickets, by closing time, each closed at most `BULK_GAP_MS` after the previous one; only runs of `BULK_MIN` or more. */
function bulkCloses(tickets: Ticket[]): TicketsReport['notes']['bulkCloses'] {
  const closed = tickets.filter((ticket) => ticket.closedAt !== null).sort((a, b) => Date.parse(a.closedAt!) - Date.parse(b.closedAt!));
  const runs: Ticket[][] = [];
  for (const ticket of closed) {
    const run = runs.at(-1);
    if (run && Date.parse(ticket.closedAt!) - Date.parse(run.at(-1)!.closedAt!) <= BULK_GAP_MS) run.push(ticket);
    else runs.push([ticket]);
  }
  return runs
    .filter((run) => run.length >= BULK_MIN)
    .map((run) => ({
      count: run.length,
      first: run[0]!.closedAt!,
      last: run.at(-1)!.closedAt!,
      tickets: run.map(ticketId),
    }));
}

/**
 * Reads every story assigned to the user and keeps the Period's tickets, with assignee usernames, finishing day, due
 * status and effort. Only finished tickets have their history read (one request each), with their project's statuses.
 */
export async function readTickets(client: TaigaClient, range: DayRange, now: Date, project?: { id: number; slug: string }): Promise<TicketsReport> {
  const today = localDay(now);
  const me = await client.getMe();
  const stories = (await client.listAssignedStories(me.id, project?.id)).flatMap((story) => {
    const progress = progressOf(story, range);
    return progress === undefined ? [] : [{ story, progress, isFinished: FINISHED[progress] === true }];
  });
  const usernames = new Map<number, Map<number, string>>();
  const spentTimeIds = new Map<number, number | undefined>();
  const statuses = new Map<number, Map<number, TaigaStatus>>();
  const histories = new Map<number, TaigaHistoryEntry[]>();
  for (const [projectId, group] of Map.groupBy(stories, ({ story }) => story.project.id)) {
    const detail = await client.findProject(projectId);
    usernames.set(projectId, new Map(detail?.members.map((member) => [member.id, member.username])));
    // The user story attribute "Spent Time" (trimmed, any case): its id differs from project to project.
    spentTimeIds.set(projectId, detail?.customAttributes.story.find((attribute) => attribute.name.trim().toLowerCase() === 'spent time')?.id);
    const finished = group.filter(({ isFinished }) => isFinished);
    if (finished.length === 0) continue;
    statuses.set(projectId, new Map((await client.listStatuses('story', projectId)).map((status) => [status.id, status])));
    const read = await readHistories(client, group[0]!.story.project, finished.map(({ story }) => ({ type: 'story', id: story.id, fingerprint: null })));
    for (const [id, entries] of read.story) histories.set(id, entries);
  }
  const tickets: Ticket[] = [];
  for (const { story, progress, isFinished } of stories) {
    const attributeId = spentTimeIds.get(story.project.id);
    const spent = attributeId === undefined ? undefined : (await client.getAttributeValues('story', story.id)).values[String(attributeId)];
    const finishedAt = isFinished ? finishedAtOf(progress, story.closedAt, histories.get(story.id) ?? [], statuses.get(story.project.id)!) : null;
    tickets.push({
      id: story.id,
      ref: story.ref,
      subject: story.subject,
      status: story.status,
      progress,
      isFinished,
      project: story.project,
      assignees: story.assignedUsers.map((id) => usernames.get(story.project.id)?.get(id) ?? id),
      dueDate: story.dueDate,
      closedAt: progress === 'Done' ? story.closedAt : null,
      finishedAt,
      dueStatus: dueStatusOf(story.dueDate, isFinished, finishedAt, today),
      ...effortOf(spent, story),
    });
  }
  tickets.sort(compareTickets);
  return {
    user: { id: me.id, username: me.username },
    project: project?.slug ?? null,
    range: { from: range.from, to: range.to, start: range.start.toISOString(), end: range.end.toISOString() },
    today,
    generatedAt: now.toISOString(),
    tickets,
    days: daysOf(tickets, range),
    summary: summarize(tickets),
    notes: {
      bulkCloses: bulkCloses(tickets),
      missingEffort: tickets.filter((ticket) => ticket.effort === null).map(ticketId),
    },
  };
}

/** `3.5h`, `5h (estimated from points)`, or `no effort`. */
function formatEffort(ticket: Ticket): string {
  if (ticket.effort === null) return 'no effort';
  return ticket.effortSource === 'points' ? `${ticket.effort}h (estimated from points)` : `${ticket.effort}h`;
}

/** `On time 2, Late 1`: each count of a summary record. */
const formatCounts = (counts: Record<string, number>) =>
  Object.entries(counts)
    .map(([name, n]) => `${name} ${n}`)
    .join(', ');

/**
 * Text form: the totals (tickets and effort; by progress group; finished and not finished tickets by due status), then
 * one block per project (most tickets first) with one line per ticket.
 */
export function formatTicketsText(report: TicketsReport): string {
  const { tickets, summary } = report;
  const scope = report.project === null ? '' : ` in ${report.project}`;
  const { effort, finished, notFinished } = summary;
  const finishedCounts = formatCounts(finished.byDueStatus) + (finished.withoutFinishingDay > 0 ? `, without a finishing day ${finished.withoutFinishingDay}` : '');
  const lines = [
    `Tickets ${report.range.from} to ${report.range.to}${scope}, assigned to ${report.user.username}, today ${report.today}: ${summary.tickets},` +
      ` effort ${effort.hours}h (Spent Time ${effort.spent.tickets} tickets, points ${effort.points.tickets} tickets)`,
    `Progress: ${formatCounts(summary.byProgress)}`,
    `Not finished ${notFinished.total}: ${formatCounts(notFinished.byDueStatus)}`,
    `Finished ${finished.total}: ${finishedCounts}`,
  ];
  const byProject = Map.groupBy(tickets, (ticket) => ticket.project.slug);
  for (const project of summary.projects) {
    lines.push('', `${project.slug} (${project.name}): ${project.tickets}`);
    for (const ticket of byProject.get(project.slug) ?? []) {
      const state = ticket.isFinished ? (ticket.finishedAt === null ? 'finished' : `finished ${localMinute(ticket.finishedAt)}`) : 'not finished';
      lines.push(
        `  #${ticket.ref}  ${ticket.progress}  ${ticket.dueStatus ?? 'unknown'}  due ${ticket.dueDate ?? '-'}  ${state}  ${formatEffort(ticket)}  ${ticket.subject}`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}
