// `taigent tickets`: the Period's tickets of the authenticated user (see GLOSSARY.md), each with its Due status and Effort.
// Read-only. Days are calendar days in the local time zone (TZ); the client knows Taiga's field names.

import { localDay, localMinute, parseDay } from './days.ts';
import type { TaigaAssignedStory, TaigaClient } from './taiga/client.ts';

/** An inclusive range of days: `from` and `to` as written (YYYY-MM-DD), `start`/`end` the instants bounding it. */
export interface DayRange {
  from: string;
  to: string;
  /** Local midnight starting `from`. */
  start: Date;
  /** Local midnight ending `to` (exclusive). */
  end: Date;
}

const DUE_STATUSES = ['On time', 'Late', 'Overdue', 'On track', 'No due date'] as const;
export type DueStatus = (typeof DUE_STATUSES)[number];

/** One ticket of the period. */
export interface Ticket {
  id: number;
  ref: number;
  subject: string;
  /** Status name. */
  status: string;
  isClosed: boolean;
  project: { id: number; slug: string; name: string };
  /** Username of every assignee; the user id when it matches no project member. */
  assignees: (string | number)[];
  /** YYYY-MM-DD, or null. */
  dueDate: string | null;
  /** ISO 8601, or null: open, or closed without a closing day recorded by Taiga. */
  closedAt: string | null;
  /** Null only for a closed ticket with a due date but no closing day: it cannot be compared. */
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
  /** The local day open tickets are compared with (YYYY-MM-DD). */
  today: string;
  generatedAt: string;
  /** Closed tickets first by `closedAt` (those without one last), then open ones: Overdue, On track, No due date, each by due date. */
  tickets: Ticket[];
  /** Every day of the range: the tickets closed that local day and the sum of their effort (hours). */
  days: { date: string; closed: number; effort: number }[];
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
  /** `withoutClosingDay`: closed tickets with a due date but no closing day, which have no due status. */
  closed: { total: number; byDueStatus: Record<'On time' | 'Late' | 'No due date', number>; withoutClosingDay: number };
  open: { total: number; byDueStatus: Record<'Overdue' | 'On track' | 'No due date', number> };
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

/** Due status by calendar day: a closed ticket's closing day, or an open ticket's `today`, against its due date. */
function dueStatus(story: TaigaAssignedStory, today: string): DueStatus | null {
  if (story.dueDate === null) return 'No due date';
  if (story.isClosed) {
    if (story.closedAt === null) return null;
    return localDay(new Date(story.closedAt)) <= story.dueDate ? 'On time' : 'Late';
  }
  return story.dueDate < today ? 'Overdue' : 'On track';
}

function effortOf(spent: unknown, story: TaigaAssignedStory): Pick<Ticket, 'effort' | 'effortSource'> {
  if (typeof spent === 'number' && Number.isFinite(spent)) return { effort: spent, effortSource: 'spent' };
  if (story.totalPoints !== null) return { effort: story.totalPoints, effortSource: 'points' };
  return { effort: null, effortSource: null };
}

/** Closed in the range, due in the range, or still open. */
function inPeriod(story: TaigaAssignedStory, range: DayRange): boolean {
  if (!story.isClosed) return true;
  if (story.closedAt !== null) {
    const closedAt = new Date(story.closedAt);
    if (closedAt >= range.start && closedAt < range.end) return true;
  }
  return story.dueDate !== null && story.dueDate >= range.from && story.dueDate <= range.to;
}

/** Order of open tickets; closed statuses never reach the lookup. */
const OPEN_ORDER: Record<DueStatus, number> = { Overdue: 0, 'On track': 1, 'No due date': 2, 'On time': 3, Late: 3 };
const openRank = (ticket: Ticket) => OPEN_ORDER[ticket.dueStatus ?? 'No due date'];

function compareTickets(a: Ticket, b: Ticket): number {
  if (a.isClosed !== b.isClosed) return a.isClosed ? -1 : 1;
  if (a.isClosed) {
    if (a.closedAt === null || b.closedAt === null) return a.closedAt === b.closedAt ? 0 : a.closedAt === null ? 1 : -1;
    return Date.parse(a.closedAt) - Date.parse(b.closedAt);
  }
  return openRank(a) - openRank(b) || (a.dueDate ?? '').localeCompare(b.dueDate ?? '');
}

/** Sum of efforts in hours, rounded to hundredths so float noise never shows. */
function sumHours(tickets: Ticket[]): number {
  return Math.round(tickets.reduce((sum, ticket) => sum + (ticket.effort ?? 0), 0) * 100) / 100;
}

/** Every day from `range.from` to `range.to`, with the tickets closed on it. */
function daysOf(tickets: Ticket[], range: DayRange): TicketsReport['days'] {
  const closedByDay = Map.groupBy(
    tickets.filter((ticket) => ticket.closedAt !== null),
    (ticket) => localDay(new Date(ticket.closedAt!)),
  );
  const days: TicketsReport['days'] = [];
  for (let day = range.start; day < range.end; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
    const closed = closedByDay.get(localDay(day)) ?? [];
    days.push({ date: localDay(day), closed: closed.length, effort: sumHours(closed) });
  }
  return days;
}

function summarize(tickets: Ticket[]): TicketsSummary {
  const closed = tickets.filter((ticket) => ticket.isClosed);
  const open = tickets.filter((ticket) => !ticket.isClosed);
  const count = (group: Ticket[], status: DueStatus) => group.filter((ticket) => ticket.dueStatus === status).length;
  const spent = tickets.filter((ticket) => ticket.effortSource === 'spent');
  const points = tickets.filter((ticket) => ticket.effortSource === 'points');
  const byProject = Map.groupBy(tickets, (ticket) => ticket.project.slug);
  return {
    tickets: tickets.length,
    closed: {
      total: closed.length,
      byDueStatus: { 'On time': count(closed, 'On time'), Late: count(closed, 'Late'), 'No due date': count(closed, 'No due date') },
      withoutClosingDay: closed.filter((ticket) => ticket.dueStatus === null).length,
    },
    open: {
      total: open.length,
      byDueStatus: { Overdue: count(open, 'Overdue'), 'On track': count(open, 'On track'), 'No due date': count(open, 'No due date') },
    },
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

/** Reads every story assigned to the user and keeps the Period's tickets, with assignee usernames, due status and effort. */
export async function readTickets(client: TaigaClient, range: DayRange, project?: { id: number; slug: string }): Promise<TicketsReport> {
  const now = new Date();
  const today = localDay(now);
  const me = await client.getMe();
  const stories = (await client.listAssignedStories(me.id, project?.id)).filter((story) => inPeriod(story, range));
  const usernames = new Map<number, Map<number, string>>();
  const spentTimeIds = new Map<number, number | undefined>();
  for (const projectId of new Set(stories.map((story) => story.project.id))) {
    const detail = await client.findProject(projectId);
    usernames.set(projectId, new Map(detail?.members.map((member) => [member.id, member.username])));
    // The user story attribute "Spent Time" (trimmed, any case): its id differs from project to project.
    spentTimeIds.set(projectId, detail?.customAttributes.story.find((attribute) => attribute.name.trim().toLowerCase() === 'spent time')?.id);
  }
  const tickets: Ticket[] = [];
  for (const story of stories) {
    const attributeId = spentTimeIds.get(story.project.id);
    const spent = attributeId === undefined ? undefined : (await client.getAttributeValues('story', story.id)).values[String(attributeId)];
    tickets.push({
      id: story.id,
      ref: story.ref,
      subject: story.subject,
      status: story.status,
      isClosed: story.isClosed,
      project: story.project,
      assignees: story.assignedUsers.map((id) => usernames.get(story.project.id)?.get(id) ?? id),
      dueDate: story.dueDate,
      closedAt: story.closedAt,
      dueStatus: dueStatus(story, today),
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

/** Text form: the totals by due status and the total effort, then one block per project (most tickets first) with one line per ticket. */
export function formatTicketsText(report: TicketsReport): string {
  const { tickets, summary } = report;
  const scope = report.project === null ? '' : ` in ${report.project}`;
  const closedCounts = Object.entries(summary.closed.byDueStatus).map(([status, n]) => `${status} ${n}`);
  if (summary.closed.withoutClosingDay > 0) closedCounts.push(`without a closing day ${summary.closed.withoutClosingDay}`);
  const openCounts = Object.entries(summary.open.byDueStatus).map(([status, n]) => `${status} ${n}`);
  const { effort } = summary;
  const lines = [
    `Tickets ${report.range.from} to ${report.range.to}${scope}, assigned to ${report.user.username}: ${summary.tickets}` +
      ` (closed ${summary.closed.total}: ${closedCounts.join(', ')}; open ${summary.open.total}: ${openCounts.join(', ')}),` +
      ` effort ${effort.hours}h (Spent Time ${effort.spent.tickets} tickets, points ${effort.points.tickets} tickets)`,
  ];
  const byProject = Map.groupBy(tickets, (ticket) => ticket.project.slug);
  for (const project of summary.projects) {
    const group = byProject.get(project.slug) ?? [];
    lines.push('', `${project.slug} (${project.name}): ${project.tickets}`);
    for (const ticket of group) {
      const state = ticket.closedAt === null ? (ticket.isClosed ? 'closed' : 'open') : `closed ${localMinute(ticket.closedAt)}`;
      lines.push(
        `  #${ticket.ref}  ${ticket.dueStatus ?? 'unknown'}  ${ticket.status}  due ${ticket.dueDate ?? '-'}  ${state}  ${formatEffort(ticket)}  ${ticket.subject}`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}
