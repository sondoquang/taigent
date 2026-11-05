// What `taigent metrics` reads from Taiga for one project: the snapshot the pure metrics module (compute.ts)
// computes from, with the history of each story, task and issue (history.ts, cached in `cacheDir` when given).
// Read-only on Taiga; the client disables Taiga's pagination, so every list is complete.

import { readReportExtras, type ReportSource } from '../report.ts';
import type { TaigaClient, TaigaIssueValue, TaigaMilestone, TaigaProjectIssue, TaigaProjectTask, TaigaStatus, TaigaStory } from '../taiga/client.ts';
import { type ItemHistories, readHistories } from './history.ts';

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
  /** The changes of each story, task and issue above, oldest first, by item id. */
  history: ItemHistories;
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
  const historyItems = [
    ...stories.map(({ id, modifiedAt }) => ({ type: 'story' as const, id, modifiedAt })),
    ...tasks.map(({ id, modifiedAt }) => ({ type: 'task' as const, id, modifiedAt })),
    ...issues.map(({ id, modifiedAt }) => ({ type: 'issue' as const, id, modifiedAt })),
  ];
  const [report, history] = await Promise.all([
    readReportExtras(client, project.id, milestones),
    readHistories(client, { id: project.id, slug: project.slug }, historyItems, cacheDir),
  ]);
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
