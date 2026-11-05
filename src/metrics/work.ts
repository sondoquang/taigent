// The user stories and tasks of a project as the metrics count them: closed by their status's closed flag (never
// by the status's name), with their assignees and their days in the local time zone, and when they started: the first
// time they entered In progress, from their history.

import { localDay } from '../days.ts';
import type { TaigaHistoryEntry, TaigaStatus } from '../taiga/client.ts';
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
  /** Local day it first entered In progress (GLOSSARY.md, Cycle time), null when it never did. */
  startedDay: string | null;
}

/** The status whose first entry starts an item's cycle time (GLOSSARY.md, Cycle time). */
const IN_PROGRESS = 'In progress';

/**
 * When an item first entered In progress, from its changes (oldest first): the first change into it, or its creation
 * when its first status change leaves In progress (Taiga records no change for the status an item is created in). A
 * status goes by its name in the project's list, which Taiga does not translate, and by the name the history recorded
 * for a status no longer in the list.
 */
function startedAt(history: TaigaHistoryEntry[], createdAt: string | null, statuses: Map<number, TaigaStatus>): string | null {
  const changes = history.flatMap((entry) => (entry.status ? [{ at: entry.at, ...entry.status }] : []));
  const isInProgress = (status: { id: number; name: string | null } | null) => status !== null && (statuses.get(status.id)?.name ?? status.name) === IN_PROGRESS;
  if (changes.length > 0 && isInProgress(changes[0]!.from)) return createdAt;
  return changes.find((change) => isInProgress(change.to))?.at ?? null;
}

interface RawWork {
  statusId: number | null;
  status: string;
  isClosed: boolean;
  createdAt: string | null;
  closedAt: string | null;
}

/** Status, closed flag and days of a story or task: the flag of its status in the project's list wins. */
function stateOf(item: RawWork, statuses: Map<number, TaigaStatus>, history: TaigaHistoryEntry[] = []): Pick<WorkItem, 'status' | 'closed' | 'createdDay' | 'closedDay' | 'startedDay'> {
  const status = item.statusId === null ? undefined : statuses.get(item.statusId);
  const closed = status?.isClosed ?? item.isClosed;
  const started = startedAt(history, item.createdAt, statuses);
  return {
    status: status?.name ?? item.status,
    closed,
    createdDay: item.createdAt === null ? null : localDay(new Date(item.createdAt)),
    closedDay: closed && item.closedAt !== null ? localDay(new Date(item.closedAt)) : null,
    startedDay: started === null ? null : localDay(new Date(started)),
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
    ...stateOf(story, storyStatuses, snapshot.history.story.get(story.id)),
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
    ...stateOf(task, taskStatuses, snapshot.history.task.get(task.id)),
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
