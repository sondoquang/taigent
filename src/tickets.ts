// `taigent tickets`: the Period's tickets of the authenticated user (see GLOSSARY.md), each with its Due status.
// Read-only. Days are calendar days in the local time zone (TZ); the client knows Taiga's field names.

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

export const DUE_STATUSES = ['On time', 'Late', 'Overdue', 'On track', 'No due date'] as const;
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
}

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
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Local midnight of a YYYY-MM-DD day, or undefined when `value` is no such calendar day. */
export function parseDay(value: string): Date | undefined {
  const match = DAY.exec(value);
  if (!match) return undefined;
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : undefined;
}

/** The range from `from` to `to` inclusive; both must be calendar days (`parseDay`), `from` not after `to`. */
export function dayRange(from: string, to: string): DayRange {
  const start = parseDay(from)!;
  const last = parseDay(to)!;
  return { from, to, start, end: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1) };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD` of an instant in the local time zone. */
function localDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `YYYY-MM-DD HH:mm` in the local time zone. */
export function localMinute(iso: string): string {
  const date = new Date(iso);
  return `${localDay(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
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

/** Closed in the range, due in the range, or still open. */
function inPeriod(story: TaigaAssignedStory, range: DayRange): boolean {
  if (!story.isClosed) return true;
  if (story.closedAt !== null) {
    const closedAt = new Date(story.closedAt);
    if (closedAt >= range.start && closedAt < range.end) return true;
  }
  return story.dueDate !== null && story.dueDate >= range.from && story.dueDate <= range.to;
}

const OPEN_ORDER: Record<string, number> = { Overdue: 0, 'On track': 1, 'No due date': 2 };

function compareTickets(a: Ticket, b: Ticket): number {
  if (a.isClosed !== b.isClosed) return a.isClosed ? -1 : 1;
  if (a.isClosed) {
    if (a.closedAt === null || b.closedAt === null) return a.closedAt === b.closedAt ? 0 : a.closedAt === null ? 1 : -1;
    return Date.parse(a.closedAt) - Date.parse(b.closedAt);
  }
  return OPEN_ORDER[a.dueStatus!]! - OPEN_ORDER[b.dueStatus!]! || (a.dueDate ?? '').localeCompare(b.dueDate ?? '');
}

/** Reads every story assigned to the user and keeps the Period's tickets, with assignee usernames and due status. */
export async function readTickets(client: TaigaClient, range: DayRange, project?: { id: number; slug: string }): Promise<TicketsReport> {
  const now = new Date();
  const today = localDay(now);
  const me = await client.getMe();
  const stories = (await client.listAssignedStories(me.id, project?.id)).filter((story) => inPeriod(story, range));
  const usernames = new Map<number, Map<number, string>>();
  for (const projectId of new Set(stories.map((story) => story.project.id))) {
    const detail = await client.findProject(projectId);
    usernames.set(projectId, new Map(detail?.members.map((member) => [member.id, member.username])));
  }
  const tickets = stories.map(
    (story): Ticket => ({
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
    }),
  );
  tickets.sort(compareTickets);
  return {
    user: { id: me.id, username: me.username },
    project: project?.slug ?? null,
    range: { from: range.from, to: range.to, start: range.start.toISOString(), end: range.end.toISOString() },
    today,
    generatedAt: now.toISOString(),
    tickets,
  };
}

/** Text form: the totals by due status, then one block per project (most tickets first) with one line per ticket. */
export function formatTicketsText(report: TicketsReport): string {
  const { tickets } = report;
  const scope = report.project === null ? '' : ` in ${report.project}`;
  const counts = DUE_STATUSES.map((status) => `${status} ${tickets.filter((ticket) => ticket.dueStatus === status).length}`);
  const unknown = tickets.filter((ticket) => ticket.dueStatus === null).length;
  if (unknown > 0) counts.push(`closed without a closing day ${unknown}`);
  const lines = [`Tickets ${report.range.from} to ${report.range.to}${scope}, assigned to ${report.user.username}: ${tickets.length} (${counts.join(', ')})`];
  const byProject = Map.groupBy(tickets, (ticket) => ticket.project.slug);
  for (const [slug, group] of [...byProject].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    lines.push('', `${slug} (${group[0]!.project.name}): ${group.length}`);
    for (const ticket of group) {
      const closed = ticket.closedAt === null ? (ticket.isClosed ? 'closed' : 'open') : `closed ${localMinute(ticket.closedAt)}`;
      lines.push(`  #${ticket.ref}  ${ticket.dueStatus ?? 'unknown'}  ${ticket.status}  due ${ticket.dueDate ?? '-'}  ${closed}  ${ticket.subject}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
