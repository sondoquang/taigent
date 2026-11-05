// The user stories and tasks of a project as the metrics count them: closed by their status's closed flag (never
// by the status's name), with their assignees and their days in the local time zone.

import { localDay } from '../days.ts';
import type { TaigaStatus } from '../taiga/client.ts';
import type { MetricsSnapshot } from './snapshot.ts';

export type WorkType = 'story' | 'task';

export interface WorkItem {
  type: WorkType;
  id: number;
  ref: number;
  subject: string;
  status: string;
  closed: boolean;
  blocked: boolean;
  /** User ids; a story's every assignee, a task's single one. */
  assignees: number[];
  /** A story's points (null when not estimated); null for a task. */
  points: number | null;
  /** Due day, YYYY-MM-DD, or null. */
  dueDate: string | null;
  /** Local days it was created and closed (null while open, or when Taiga recorded no date). */
  createdDay: string | null;
  closedDay: string | null;
}

interface RawWork {
  statusId: number | null;
  status: string;
  isClosed: boolean;
  createdAt: string | null;
  closedAt: string | null;
}

/** Status, closed flag and days of a story or task: the flag of its status in the project's list wins. */
function stateOf(item: RawWork, statuses: Map<number, TaigaStatus>): Pick<WorkItem, 'status' | 'closed' | 'createdDay' | 'closedDay'> {
  const status = item.statusId === null ? undefined : statuses.get(item.statusId);
  const closed = status?.isClosed ?? item.isClosed;
  return {
    status: status?.name ?? item.status,
    closed,
    createdDay: item.createdAt === null ? null : localDay(new Date(item.createdAt)),
    closedDay: closed && item.closedAt !== null ? localDay(new Date(item.closedAt)) : null,
  };
}

/** Every story, then every task, in Taiga's order. */
export function workItems(snapshot: MetricsSnapshot): WorkItem[] {
  const storyStatuses = new Map(snapshot.statuses.story.map((status) => [status.id, status]));
  const taskStatuses = new Map(snapshot.statuses.task.map((status) => [status.id, status]));
  const stories = snapshot.stories.map((story): WorkItem => ({
    type: 'story',
    id: story.id,
    ref: story.ref,
    subject: story.subject,
    ...stateOf(story, storyStatuses),
    blocked: story.isBlocked,
    assignees: [...new Set(story.assignedTo === null ? story.assignedUsers : [...story.assignedUsers, story.assignedTo])],
    points: story.totalPoints,
    dueDate: story.dueDate,
  }));
  const tasks = snapshot.tasks.map((task): WorkItem => ({
    type: 'task',
    id: task.id,
    ref: task.ref,
    subject: task.subject,
    ...stateOf(task, taskStatuses),
    blocked: task.isBlocked,
    assignees: task.assignedTo === null ? [] : [task.assignedTo],
    points: null,
    dueDate: task.dueDate,
  }));
  return [...stories, ...tasks];
}

/** The median of `values`, null when there are none. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
