// Planner: pure function from (manifest, Taiga state read back) to an ordered plan. No I/O.

import type { Backlog, StorySpec } from './manifest/backlog.ts';
import type { ItemType } from './manifest/state.ts';
import type { TaigaItem, TaigaTask } from './taiga/client.ts';

/** Identity tag of a manifest item on Taiga. Lowercase because Taiga lowercases every tag it stores. */
export function srcTag(key: string): string {
  return `src:${key.toLowerCase()}`;
}

export interface PlanProject {
  id: number;
  slug: string;
}

export interface RemoteState {
  project: PlanProject;
  epics: TaigaItem[];
  stories: TaigaItem[];
  tasks: TaigaTask[];
  /** Ids of the user stories linked to each existing epic (`related_userstories`). */
  epicStories: ReadonlyMap<number, readonly number[]>;
}

export interface ItemFields {
  subject: string;
  description: string;
  tags: string[];
}

export interface FieldChanges {
  subject?: { from: string; to: string };
  description?: { from: string; to: string };
  /** `to` keeps every tag already on Taiga (user-added ones too) and appends the manifest's missing tags. */
  tags?: { from: string[]; to: string[] };
}

export type Operation =
  /** `parent`: key of the epic (story) or story (task) the new item belongs to. */
  | { action: 'create'; type: ItemType; key: string; parent?: string; fields: ItemFields }
  | { action: 'update'; type: ItemType; key: string; id: number; ref: number; version: number; changes: FieldChanges }
  | { action: 'link'; type: 'story'; key: string; epic: string }
  | { action: 'skip'; type: ItemType; key: string; id: number; ref: number; version: number };

export type Action = Operation['action'];

/** An item tagged `src:<key>` on Taiga whose key is no longer in the manifest. Reported, never deleted. */
export interface Orphan {
  type: ItemType;
  key: string;
  id: number;
  ref: number;
  subject: string;
}

export interface Plan {
  project: PlanProject;
  /** True when applying would write to Taiga. */
  changes: boolean;
  summary: Record<Action, number>;
  operations: Operation[];
  orphans: Orphan[];
}

/** Story description template: free text, then acceptance criteria as a checklist, then the spec link. */
function storyDescription(story: StorySpec): string {
  const parts: string[] = [];
  if (story.description.trim() !== '') parts.push(story.description.trimEnd());
  if (story.acceptanceCriteria.length > 0) {
    parts.push(['## Acceptance criteria', '', ...story.acceptanceCriteria.map((criterion) => `- [ ] ${criterion}`)].join('\n'));
  }
  if (story.spec !== '') parts.push(`Spec: ${story.spec}`);
  return parts.join('\n\n');
}

export function buildPlan(backlog: Backlog, remote: RemoteState): Plan {
  const remoteItems: Record<ItemType, TaigaItem[]> = { epic: remote.epics, story: remote.stories, task: remote.tasks };
  const bySrcTag = {} as Record<ItemType, Map<string, TaigaItem>>;
  for (const type of ['epic', 'story', 'task'] as const) {
    bySrcTag[type] = new Map();
    // Oldest first, so if duplicates already exist the original item keeps its identity.
    for (const item of [...remoteItems[type]].sort((a, b) => a.id - b.id)) {
      for (const tag of item.tags) {
        if (tag.startsWith('src:') && !bySrcTag[type].has(tag)) bySrcTag[type].set(tag, item);
      }
    }
  }
  const manifestTags: Record<ItemType, Set<string>> = { epic: new Set(), story: new Set(), task: new Set() };
  const operations: Operation[] = [];

  /** Plans create/update/skip for one manifest item and returns its Taiga counterpart, if any. */
  function reconcile(type: ItemType, spec: { key: string; subject: string; tags: string[] }, description: string, parent?: string): TaigaItem | undefined {
    const tag = srcTag(spec.key);
    manifestTags[type].add(tag);
    const tags = [...new Set([...spec.tags.map((t) => t.toLowerCase()), tag])];
    const existing = bySrcTag[type].get(tag);
    if (!existing) {
      operations.push({ action: 'create', type, key: spec.key, ...(parent && { parent }), fields: { subject: spec.subject, description, tags } });
      return undefined;
    }
    const changes: FieldChanges = {};
    if (existing.subject !== spec.subject) changes.subject = { from: existing.subject, to: spec.subject };
    if (existing.description !== description) changes.description = { from: existing.description, to: description };
    const missingTags = tags.filter((t) => !existing.tags.includes(t));
    if (missingTags.length > 0) changes.tags = { from: existing.tags, to: [...existing.tags, ...missingTags] };
    const { id, ref, version } = existing;
    operations.push(
      Object.keys(changes).length > 0
        ? { action: 'update', type, key: spec.key, id, ref, version, changes }
        : { action: 'skip', type, key: spec.key, id, ref, version },
    );
    return existing;
  }

  // Dependency order: each epic, then each of its stories followed by its epic link and its tasks.
  for (const epic of backlog.epics) {
    const remoteEpic = reconcile('epic', epic, epic.description);
    for (const story of epic.stories) {
      const remoteStory = reconcile('story', story, storyDescription(story), epic.key);
      const linked = remoteEpic && remoteStory && remote.epicStories.get(remoteEpic.id)?.includes(remoteStory.id);
      if (!linked) operations.push({ action: 'link', type: 'story', key: story.key, epic: epic.key });
      for (const task of story.tasks) reconcile('task', task, task.description, story.key);
    }
  }

  const orphans: Orphan[] = [];
  for (const type of ['epic', 'story', 'task'] as const) {
    for (const item of remoteItems[type]) {
      const srcTags = item.tags.filter((t) => t.startsWith('src:'));
      if (srcTags.length === 0 || srcTags.some((t) => manifestTags[type].has(t))) continue;
      orphans.push({ type, key: srcTags[0]!.slice('src:'.length).toUpperCase(), id: item.id, ref: item.ref, subject: item.subject });
    }
  }

  const summary: Record<Action, number> = { create: 0, update: 0, link: 0, skip: 0 };
  for (const op of operations) summary[op.action] += 1;
  return { project: remote.project, changes: operations.some((op) => op.action !== 'skip'), summary, operations, orphans };
}
