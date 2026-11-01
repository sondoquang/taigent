// `taigent closed`: the stories, tasks and issues assigned to the authenticated user that Taiga closed in a range of
// days. Read-only. Days are calendar days in the local time zone (TZ); the client knows Taiga's field names.

import { type TaigaClient, type TaigaClosedItem, WORK_ITEM_TYPES, type WorkItemType } from './taiga/client.ts';
import { type DayRange, localMinute } from './tickets.ts';

/** The `--json` output of `taigent closed`. */
export interface ClosedReport {
  user: { id: number; username: string };
  /** The `--project` slug, or null for every project the user sees. */
  project: string | null;
  range: { from: string; to: string; start: string; end: string };
  summary: Record<WorkItemType, number> & { total: number };
  /** Ordered by `closedAt`. */
  items: (TaigaClosedItem & { closedAt: string })[];
}

/** Reads the closed items of every type assigned to the user and keeps those closed within `range`. */
export async function readClosed(client: TaigaClient, range: DayRange, project?: { id: number; slug: string }): Promise<ClosedReport> {
  const me = await client.getMe();
  const items: ClosedReport['items'] = [];
  for (const type of WORK_ITEM_TYPES) {
    for (const item of await client.listClosedAssigned(type, me.id, project?.id)) {
      if (item.closedAt === null) continue;
      const closedAt = new Date(item.closedAt);
      if (closedAt >= range.start && closedAt < range.end) items.push({ ...item, closedAt: item.closedAt });
    }
  }
  items.sort((a, b) => Date.parse(a.closedAt) - Date.parse(b.closedAt));
  const count = (type: WorkItemType) => items.filter((item) => item.type === type).length;
  return {
    user: { id: me.id, username: me.username },
    project: project?.slug ?? null,
    range: { from: range.from, to: range.to, start: range.start.toISOString(), end: range.end.toISOString() },
    summary: { story: count('story'), task: count('task'), issue: count('issue'), total: items.length },
    items,
  };
}

/** Text form: the totals, then one block per project (most items first) with one line per item. */
export function formatClosedText(report: ClosedReport): string {
  const { summary } = report;
  const scope = report.project === null ? '' : ` in ${report.project}`;
  const lines = [
    `Closed ${report.range.from} to ${report.range.to}${scope}, assigned to ${report.user.username}: ${summary.total} ` +
      `(${summary.story} stories, ${summary.task} tasks, ${summary.issue} issues)`,
  ];
  const byProject = Map.groupBy(report.items, (item) => item.project.slug);
  for (const [slug, items] of [...byProject].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    lines.push('', `${slug} (${items[0]!.project.name}): ${items.length}`);
    for (const item of items) lines.push(`  ${localMinute(item.closedAt)}  ${item.type} #${item.ref}  ${item.status}  ${item.subject}`);
  }
  return `${lines.join('\n')}\n`;
}
