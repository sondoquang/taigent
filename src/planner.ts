// Planner: pure function from (manifest, Taiga state read back) to an ordered plan. No I/O.

import { ITEM_TYPES, type ItemType } from './items.ts';
import type { AttributeValue, Backlog, StorySpec } from './manifest/backlog.ts';
import { TaigaError, type TaigaAttributeValues, type TaigaCustomAttribute, type TaigaItem, type TaigaTask } from './taiga/client.ts';

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
  /** Custom attributes defined on the project, per item type. */
  customAttributes: Record<ItemType, readonly TaigaCustomAttribute[]>;
  /** Current custom attribute values, by item id, of the existing items that declare attributes in the manifest. */
  attributeValues: Record<ItemType, ReadonlyMap<number, TaigaAttributeValues>>;
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
  /**
   * Declared attribute values that differ on Taiga, by attribute name (`from` is null when unset); `version` is the
   * values object's version. Attributes the manifest does not declare are left alone.
   */
  custom_attributes?: { from: Record<string, unknown>; to: Record<string, AttributeValue>; version: number };
}

export type Operation =
  /** `parent`: key of the epic (story) or story (task) the new item belongs to. */
  | { action: 'create'; type: ItemType; key: string; parent?: string; fields: ItemFields; custom_attributes?: Record<string, AttributeValue> }
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
  for (const type of ITEM_TYPES) {
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
  const unknownAttributes: string[] = [];

  type Spec = { key: string; subject: string; tags: string[]; customAttributes: Record<string, AttributeValue> };

  /** Plans create/update/skip for one manifest item and returns its Taiga counterpart, if any. */
  function reconcile(type: ItemType, spec: Spec, description: string, parent?: string): TaigaItem | undefined {
    const tag = srcTag(spec.key);
    manifestTags[type].add(tag);
    const tags = [...new Set([...spec.tags.map((t) => t.toLowerCase()), tag])];
    const defined = remote.customAttributes[type];
    const attributes = Object.entries(spec.customAttributes).flatMap(([name, value]) => {
      const attribute = defined.find((a) => a.name === name);
      if (attribute) return [{ name, id: attribute.id, value }];
      const names = defined.map((a) => `"${a.name}"`).join(', ') || 'none';
      unknownAttributes.push(`  ${spec.key} (${type}): "${name}"; ${type} attributes on Taiga: ${names}`);
      return [];
    });
    const existing = bySrcTag[type].get(tag);
    if (!existing) {
      operations.push({
        action: 'create',
        type,
        key: spec.key,
        ...(parent && { parent }),
        fields: { subject: spec.subject, description, tags },
        ...(attributes.length > 0 && { custom_attributes: spec.customAttributes }),
      });
      return undefined;
    }
    const changes: FieldChanges = {};
    if (existing.subject !== spec.subject) changes.subject = { from: existing.subject, to: spec.subject };
    if (existing.description !== description) changes.description = { from: existing.description, to: description };
    const missingTags = tags.filter((t) => !existing.tags.includes(t));
    if (missingTags.length > 0) changes.tags = { from: existing.tags, to: [...existing.tags, ...missingTags] };
    if (attributes.length > 0) {
      const current = remote.attributeValues[type].get(existing.id);
      if (!current) throw new Error(`planner: custom attribute values of ${type} ${spec.key} were not read`);
      const from: Record<string, unknown> = {};
      const to: Record<string, AttributeValue> = {};
      for (const { name, id, value } of attributes) {
        const now = current.values[String(id)];
        if (JSON.stringify(now) !== JSON.stringify(value)) {
          from[name] = now ?? null;
          to[name] = value;
        }
      }
      if (Object.keys(to).length > 0) changes.custom_attributes = { from, to, version: current.version };
    }
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

  if (unknownAttributes.length > 0) {
    throw new TaigaError(
      `backlog.yaml uses custom attributes that project ${remote.project.slug} does not define (attributes are matched by exact ` +
        `name; declare them under custom_attributes in project.yaml and run taigent bootstrap):\n${unknownAttributes.join('\n')}`,
    );
  }

  const orphans: Orphan[] = [];
  for (const type of ITEM_TYPES) {
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
