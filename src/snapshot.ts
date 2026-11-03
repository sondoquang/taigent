// The read-only `snapshot` command: the whole backlog on Taiga, as one file the skills plan with instead of the Taiga
// MCP lists (at most 30 stories, no tasks): every epic, closed ones too, and every open story, task and issue, hand-made
// or carrying a `src:<key>` tag, with their full descriptions. Written to `taiga/<slug>/snapshot.json` (git-ignored);
// Taigent Desktop and `preview` read it offline. The client disables Taiga's pagination, so every list is complete.

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeAtomic } from './files.ts';
import { ISSUE_VALUE_FIELDS, type IssueValueField } from './items.ts';
import { keyOf } from './managed.ts';
import type { TaigaClient, TaigaItem } from './taiga/client.ts';

/** One epic, story, task or issue as Taiga holds it. */
export interface SnapshotItem {
  id: number;
  ref: number;
  subject: string;
  /** Its status name, null when Taiga sends none. */
  status: string | null;
  closed: boolean;
  /** Every tag, as Taiga stores it (lowercased), `src:` and hand-made ones alike. */
  tags: string[];
  /** The key of its first `src:` tag (uppercase), null for a hand-made item. */
  key: string | null;
  /** The full description, byte for byte. */
  description: string;
}

export interface SnapshotStory extends SnapshotItem {
  /** Refs of the epics it is linked to, any epic, in Taiga's order of the epics. */
  epics: number[];
}

export interface SnapshotTask extends SnapshotItem {
  /** Ref of its parent story (open or closed), null for a task outside any story. */
  story: number | null;
}

export type SnapshotIssue = SnapshotItem & Record<IssueValueField, string | null>;

/** `taiga/<slug>/snapshot.json`. */
export interface Snapshot {
  project: { id: number; slug: string };
  /** When Taiga was read (ISO 8601, UTC). */
  readAt: string;
  /** Every epic, closed ones too. */
  epics: SnapshotItem[];
  /** Open stories, tasks and issues only. */
  stories: SnapshotStory[];
  tasks: SnapshotTask[];
  issues: SnapshotIssue[];
}

/** What `snapshot` prints: the file, when Taiga was read, how many items of each type, and how many are hand-made. */
export interface SnapshotSummary {
  file: string;
  readAt: string;
  epics: number;
  stories: number;
  tasks: number;
  issues: number;
  /** Items without a `src:<key>` tag. */
  handMade: number;
}

function snapshotItem(item: TaigaItem): SnapshotItem {
  return {
    id: item.id,
    ref: item.ref,
    subject: item.subject,
    status: item.status,
    closed: item.isClosed,
    tags: item.tags,
    key: keyOf(item) ?? null,
    description: item.description,
  };
}

/** Reads the project's backlog from Taiga. Only GET requests. */
export async function readSnapshot(client: TaigaClient, slug: string): Promise<Snapshot> {
  const project = await client.getProjectBySlug(slug);
  const readAt = new Date().toISOString();
  const [epics, stories, tasks, issues] = await Promise.all([
    client.listItems('epic', project.id),
    client.listItems('story', project.id),
    client.listItems('task', project.id),
    client.listItems('issue', project.id),
  ]);

  const epicRefs = new Map<number, number[]>();
  for (const epic of epics) {
    for (const storyId of await client.listEpicUserStories(epic.id)) epicRefs.set(storyId, [...(epicRefs.get(storyId) ?? []), epic.ref]);
  }
  const storyRefs = new Map(stories.map((story) => [story.id, story.ref]));

  const valueNames = {} as Record<IssueValueField, Map<number, string>>;
  for (const field of ISSUE_VALUE_FIELDS) {
    valueNames[field] = new Map((await client.listIssueValues(field, project.id)).map((value) => [value.id, value.name]));
  }

  return {
    project: { id: project.id, slug: project.slug },
    readAt,
    epics: epics.map(snapshotItem),
    stories: stories.filter((story) => !story.isClosed).map((story) => ({ ...snapshotItem(story), epics: epicRefs.get(story.id) ?? [] })),
    tasks: tasks.filter((task) => !task.isClosed).map((task) => ({ ...snapshotItem(task), story: task.userStory === null ? null : (storyRefs.get(task.userStory) ?? null) })),
    issues: issues
      .filter((issue) => !issue.isClosed)
      .map((issue) => {
        const values = Object.fromEntries(ISSUE_VALUE_FIELDS.map((field) => [field, issue[field] === null ? null : (valueNames[field].get(issue[field]) ?? null)]));
        return { ...snapshotItem(issue), ...(values as Record<IssueValueField, string | null>) };
      }),
  };
}

/** Writes the snapshot atomically, creating the project directory when it has none yet. */
export async function writeSnapshot(path: string, snapshot: Snapshot): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeAtomic(path, `${JSON.stringify(snapshot, null, 2)}\n`);
}

export function summarizeSnapshot(snapshot: Snapshot, file: string): SnapshotSummary {
  const items = [...snapshot.epics, ...snapshot.stories, ...snapshot.tasks, ...snapshot.issues];
  return {
    file,
    readAt: snapshot.readAt,
    epics: snapshot.epics.length,
    stories: snapshot.stories.length,
    tasks: snapshot.tasks.length,
    issues: snapshot.issues.length,
    handMade: items.filter((item) => item.key === null).length,
  };
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function formatSnapshotText(slug: string, summary: SnapshotSummary): string {
  return [
    `Snapshot of ${slug} written to ${summary.file} (read ${summary.readAt}):`,
    `  ${count(summary.epics, 'epic')}, ${count(summary.stories, 'story', 'stories')}, ${count(summary.tasks, 'task')}, ${count(summary.issues, 'issue')}`,
    `  (every epic, open and closed; open stories, tasks and issues only)`,
    `  ${summary.handMade} hand-made (no src:<key> tag)`,
    '',
  ].join('\n');
}
