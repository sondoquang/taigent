// What `taigent metrics` reads from Taiga for one project: the snapshot the pure metrics module (compute.ts)
// computes from, with the history of each story, task and bug (history.ts, cached in `cacheDir` when given).
// Read-only on Taiga; the client disables Taiga's pagination, so every list is complete.

import { readReportExtras, type ReportSource } from '../report.ts';
import type { TaigaClient, TaigaIssueValue, TaigaMilestone, TaigaProjectIssue, TaigaProjectTask, TaigaStatus, TaigaStory } from '../taiga/client.ts';
import { bugTypeIds } from './bugs.ts';
import { type HistoryItem, type ItemHistories, readHistories } from './history.ts';

/** The project is not on Taiga or not visible to the user. Maps to ExitCode.Usage, kind `project`. */
export class ProjectNotFoundError extends Error {}

export interface Person {
  id: number;
  username: string;
}

export interface MetricsSnapshot {
  /** `sprints`: whether the project's Backlog module (sprints) is on; off is a kanban project. */
  project: { id: number; slug: string; name: string; sprints: boolean };
  /** The user the CLI logs in as: "assigned to you" and "Chỉ tôi" mean assigned to them. */
  me: Person;
  /** Active members. */
  members: Person[];
  /** Every sprint; none for a kanban project. */
  sprints: TaigaMilestone[];
  statuses: { story: TaigaStatus[]; task: TaigaStatus[]; issue: TaigaStatus[] };
  stories: TaigaStory[];
  tasks: TaigaProjectTask[];
  /** Every issue, with the project's issue types to tell bugs (type `Bug`) from the rest. */
  issues: TaigaProjectIssue[];
  issueTypes: TaigaIssueValue[];
  /** What `report`'s tables need besides the sprints and stories: sprint stats (in the order of `sprints`), epics. */
  report: Pick<ReportSource, 'stats' | 'epics' | 'epicStories'>;
  /** The changes of each story, task and bug above, oldest first, by item id; none for an issue of another type. */
  history: ItemHistories;
}

/**
 * What a cached history is checked against: the item's `modified_date` and the fields Taiga changes without moving
 * it. Dragging on a board or into a sprint moves the rows without the model's save(), which alone sets
 * modified_date, though it records the change in the history (taiga-back `taiga/projects/userstories/services.py`:
 * `update_userstories_kanban_order_in_bulk` runs `queryset.update(status=…)` then `close_userstory`/`open_userstory`
 * with `save(update_fields=["is_closed", "finish_date"])`; `update_userstories_milestone_in_bulk` runs a raw SQL
 * `UPDATE … milestone_id` through `db.update_attr_in_bulk_for_ids`). So a cached history holds while all of them are
 * unchanged; null (never cached) without a modified_date. For the same reason no item is skipped by its
 * modified_date: an old one may still have been moved in the periods.
 */
function fingerprint(item: { modifiedAt: string | null; statusId: number | null; isClosed: boolean; closedAt: string | null; milestone?: number | null }): string | null {
  return item.modifiedAt === null ? null : JSON.stringify([item.modifiedAt, item.statusId, item.milestone ?? null, item.isClosed, item.closedAt]);
}

export async function readSnapshot(client: TaigaClient, slug: string, cacheDir?: string): Promise<MetricsSnapshot> {
  const project = await client.findProjectBySlug(slug);
  if (!project) throw new ProjectNotFoundError(`project "${slug}" not found on ${client.apiUrl} (or not visible to this user)`);
  const sprints = project.modules.is_backlog_activated;
  const [me, milestones, storyStatuses, taskStatuses, issueStatuses, issueTypes, stories, tasks, issues] = await Promise.all([
    client.getMe(),
    sprints ? client.listMilestones(project.id) : [],
    client.listStatuses('story', project.id),
    client.listStatuses('task', project.id),
    client.listStatuses('issue', project.id),
    client.listIssueValues('type', project.id),
    client.listStories(project.id),
    client.listProjectTasks(project.id),
    client.listProjectIssues(project.id),
  ]);
  const bugTypes = bugTypeIds(issueTypes);
  // No metric reads the history of an issue that is not a bug.
  const bugs = issues.filter((issue) => issue.typeId !== null && bugTypes.has(issue.typeId));
  const historyItems: HistoryItem[] = [
    ...stories.map((story) => ({ type: 'story' as const, id: story.id, fingerprint: fingerprint(story) })),
    ...tasks.map((task) => ({ type: 'task' as const, id: task.id, fingerprint: fingerprint(task) })),
    ...bugs.map((bug) => ({ type: 'issue' as const, id: bug.id, fingerprint: fingerprint(bug) })),
  ];
  // One after the other, so no more than TAIGA_CONCURRENCY requests are in flight at once.
  const report = await readReportExtras(client, project.id, milestones);
  const history = await readHistories(client, { id: project.id, slug: project.slug }, historyItems, cacheDir);
  return {
    project: { id: project.id, slug: project.slug, name: project.name, sprints },
    me: { id: me.id, username: me.username },
    members: project.members,
    sprints: milestones,
    statuses: { story: storyStatuses, task: taskStatuses, issue: issueStatuses },
    stories,
    tasks,
    issues,
    issueTypes,
    report,
    history,
  };
}
