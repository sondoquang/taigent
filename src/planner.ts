// Planner: pure function from (manifest, Taiga state read back) to an ordered plan. No I/O.

import { ISSUE_VALUE_FIELDS, ITEM_TYPES, type IssueValueField, type ItemType } from './items.ts';
import {
  issuePath,
  storyPath,
  type AttributeValue,
  type Backlog,
  type LegacyStoryCreate,
  type StorySpec,
  type UnknownIssueValue,
} from './manifest/backlog.ts';
import { summarize, type Action, type PlanSummary } from './operations.ts';
import {
  TaigaError,
  type TaigaAttributeValues,
  type TaigaCustomAttribute,
  type TaigaIssue,
  type TaigaIssueValue,
  type TaigaItem,
  type TaigaTask,
} from './taiga/client.ts';

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
  issues: TaigaIssue[];
  /** The project's issue types, severities and priorities (read only when the backlog has issues). */
  issueValues: Record<IssueValueField, readonly TaigaIssueValue[]>;
  /** Ids of the user stories linked to each existing epic that carries a `src:` tag (`related_userstories`). */
  epicStories: ReadonlyMap<number, readonly number[]>;
  /** Custom attributes defined on the project, per item type. */
  customAttributes: Record<ItemType, readonly TaigaCustomAttribute[]>;
  /** Current custom attribute values, by item id, of the existing items that declare attributes in the manifest. */
  attributeValues: Record<ItemType, ReadonlyMap<number, TaigaAttributeValues>>;
}

/** Fields of a new item; an issue's also hold the ids of its type, severity and priority. */
export interface ItemFields extends Partial<Record<IssueValueField, number>> {
  subject: string;
  description: string;
  tags: string[];
}

/**
 * A changed issue type, severity or priority: `from`/`to` are value ids (`to` is what apply sends), `names` their
 * names on Taiga for people reading the plan (`from` is null when the issue has no value, or one the project no
 * longer lists).
 */
export interface IssueValueChange {
  from: number | null;
  to: number;
  names: { from: string | null; to: string };
}

/** Changed fields of an existing item; `type`, `severity` and `priority` are an issue's. */
export interface FieldChanges extends Partial<Record<IssueValueField, IssueValueChange>> {
  subject?: { from: string; to: string };
  description?: { from: string; to: string };
  /** `to` keeps every tag already on Taiga (user-added ones too) and appends the manifest's missing tags. */
  tags?: { from: string[]; to: string[] };
  /**
   * Declared attribute values that differ on Taiga, by attribute name (`from` is null when unset); `version` is the
   * values object's version. Attributes the manifest does not declare are left alone.
   */
  custom_attributes?: { from: Record<string, unknown>; to: Record<string, AttributeValue>; version: number };
  /**
   * Tasks only: the task moved to another story in the manifest. `from` is the key of the story it is in on Taiga
   * (null when it is in no story taigent manages), `to` the manifest's parent story; apply PATCHes `user_story`.
   */
  parent?: { from: string | null; to: string };
}

export type Operation =
  /** `parent`: key of the epic (story) or story (task) the new item belongs to. */
  | { action: 'create'; type: ItemType; key: string; parent?: string; fields: ItemFields; custom_attributes?: Record<string, AttributeValue> }
  | { action: 'update'; type: ItemType; key: string; id: number; ref: number; version: number; changes: FieldChanges }
  | { action: 'link'; type: 'story'; key: string; epic: string }
  | { action: 'skip'; type: ItemType; key: string; id: number; ref: number; version: number };

/** The actions of a backlog plan. */
export const PLAN_ACTIONS = ['create', 'update', 'link', 'skip'] as const;

/** An item tagged `src:<key>` on Taiga whose key is no longer in the manifest. Reported, never deleted. */
export interface Orphan {
  type: ItemType;
  key: string;
  id: number;
  ref: number;
  subject: string;
}

/**
 * A story linked on Taiga to a taigent-managed epic other than its manifest epic (it moved to another epic in the
 * manifest). Reported, never removed: a person decides whether to unlink it.
 */
export interface StaleLink {
  /** The story. */
  key: string;
  id: number;
  ref: number;
  /** The epic it is still linked to. */
  epic: string;
  epicId: number;
  epicRef: number;
}

export interface Plan extends PlanSummary<Action> {
  project: PlanProject;
  operations: Operation[];
  orphans: Orphan[];
  staleLinks: StaleLink[];
}

/**
 * The plan would create stories in the legacy format. Only known once Taiga is read (`src:` tags, not state.json);
 * the caller, which knows the backlog file, reports them as manifest issues.
 */
export class LegacyStoryCreateError extends Error {
  readonly stories: readonly LegacyStoryCreate[];

  constructor(stories: readonly LegacyStoryCreate[]) {
    super(`new stories must use use_case and scenarios: ${stories.map((story) => story.key).join(', ')}`);
    this.name = 'LegacyStoryCreateError';
    this.stories = stories;
  }
}

/**
 * Issues name a type, severity or priority the project does not define on Taiga. Only known once Taiga is read; the
 * caller, which knows the backlog file, reports them as manifest issues (rule `issue-value`).
 */
export class UnknownIssueValueError extends Error {
  readonly values: readonly UnknownIssueValue[];

  constructor(values: readonly UnknownIssueValue[]) {
    super(`issues use values the project does not define: ${values.map((value) => `${value.key} ${value.field} "${value.value}"`).join(', ')}`);
    this.name = 'UnknownIssueValueError';
    this.values = values;
  }
}

/** ` Name: from -> to; …` for the attribute values an operation sets. */
function formatAttributes(from: Record<string, unknown>, to: Record<string, unknown>): string {
  return Object.entries(to)
    .map(([name, value]) => `${name}: ${name in from ? `${JSON.stringify(from[name])} -> ` : ''}${JSON.stringify(value)}`)
    .join('; ');
}

/** Human-readable description of one operation, for the text form of the plan. */
export function describePlanOperation(op: Operation): string {
  switch (op.action) {
    case 'create': {
      const attributes = op.custom_attributes ? `  [custom attributes ${formatAttributes({}, op.custom_attributes)}]` : '';
      return `create ${op.type} ${op.key}  "${op.fields.subject}"${op.parent ? `  (in ${op.type === 'task' ? 'story' : 'epic'} ${op.parent})` : ''}${attributes}`;
    }
    case 'update': {
      const { custom_attributes: changed, parent } = op.changes;
      const attributes = changed ? `  [custom attributes ${formatAttributes(changed.from, changed.to)}]` : '';
      const fields = Object.keys(op.changes).map((field) => {
        if (field === 'parent' && parent) return `parent (${parent.from ? `story ${parent.from}` : 'no story'} -> story ${parent.to})`;
        const value = (ISSUE_VALUE_FIELDS as readonly string[]).includes(field) ? op.changes[field as IssueValueField] : undefined;
        return value ? `${field} (${value.names.from ?? 'none'} -> ${value.names.to})` : field;
      });
      return `update ${op.type} ${op.key}  (#${op.ref}, id ${op.id}): ${fields.join(', ')}${attributes}`;
    }
    case 'link':
      return `link   story ${op.key} -> epic ${op.epic}`;
    case 'skip':
      return `${op.type} ${op.key}  (#${op.ref}, id ${op.id}, unchanged)`;
  }
}

/**
 * Story description. The user story format renders the use case, the free text, one checkbox per scenario with its
 * Given/When/Then, then the spec link. The legacy format keeps its template byte for byte: free text, acceptance
 * criteria as a checklist, then the spec link. Exported so `taigent preview` (src/review.ts) shows exactly the text
 * apply writes.
 */
export function storyDescription(story: StorySpec): string {
  const parts: string[] = [];
  let checklist: string[];
  if (story.format === 'user-story') {
    const { asA, iWantTo, soThat } = story.useCase;
    parts.push([`- **As a** ${asA}`, `- **I want to** ${iWantTo}`, `- **so that** ${soThat}`].join('\n'));
    checklist = story.scenarios.flatMap(({ scenario, given, when, then }) => [
      `- [ ] **Scenario:** ${scenario}`,
      ...given.map((condition, i) => `  - **${i === 0 ? 'Given' : 'and Given'}:** ${condition}`),
      `  - **When:** ${when}`,
      `  - **Then:** ${then}`,
    ]);
  } else {
    checklist = story.acceptanceCriteria.map((criterion) => `- [ ] ${criterion}`);
  }
  if (story.description.trim() !== '') parts.push(story.description.trimEnd());
  if (checklist.length > 0) parts.push(['## Acceptance criteria', '', ...checklist].join('\n'));
  if (story.spec !== '') parts.push(`Spec: ${story.spec}`);
  return parts.join('\n\n');
}

/** The manifest key of an item, from its first `src:` tag (Taiga lowercases tags; keys are uppercase). */
function keyOf(item: TaigaItem): string | undefined {
  return item.tags.find((t) => t.startsWith('src:'))?.slice('src:'.length).toUpperCase();
}

export function buildPlan(backlog: Backlog, remote: RemoteState): Plan {
  const remoteItems: Record<ItemType, TaigaItem[]> = { epic: remote.epics, story: remote.stories, task: remote.tasks, issue: remote.issues };
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
  const manifestTags = Object.fromEntries(ITEM_TYPES.map((type) => [type, new Set<string>()])) as Record<ItemType, Set<string>>;
  const operations: Operation[] = [];
  const unknownAttributes: string[] = [];
  const legacyCreates: LegacyStoryCreate[] = [];
  const unknownIssueValues: UnknownIssueValue[] = [];

  type Spec = { key: string; subject: string; tags: string[]; customAttributes: Record<string, AttributeValue> };

  /**
   * Plans create/update/skip for one manifest item and returns its Taiga counterpart, if any. `parent`: the key of
   * the epic (story) or story (task) a new item belongs to; `moved` tells whether an existing item has to move to
   * another parent (tasks); `values`: an issue's type, severity and priority ids.
   */
  function reconcile(
    type: ItemType,
    spec: Spec,
    description: string,
    { parent, moved, values }: { parent?: string; moved?: (existing: TaigaItem) => FieldChanges['parent']; values?: Record<IssueValueField, number> } = {},
  ): TaigaItem | undefined {
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
        fields: { subject: spec.subject, description, tags, ...values },
        ...(attributes.length > 0 && { custom_attributes: spec.customAttributes }),
      });
      return undefined;
    }
    const changes: FieldChanges = {};
    if (existing.subject !== spec.subject) changes.subject = { from: existing.subject, to: spec.subject };
    if (existing.description !== description) changes.description = { from: existing.description, to: description };
    const missingTags = tags.filter((t) => !existing.tags.includes(t));
    if (missingTags.length > 0) changes.tags = { from: existing.tags, to: [...existing.tags, ...missingTags] };
    for (const field of values ? ISSUE_VALUE_FIELDS : []) {
      const from = (existing as TaigaIssue)[field];
      const to = values![field];
      if (from === to) continue;
      const name = (id: number | null) => remote.issueValues[field].find((v) => v.id === id)?.name ?? null;
      changes[field] = { from, to, names: { from: name(from), to: name(to)! } };
    }
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
    const parentChange = moved?.(existing);
    if (parentChange) changes.parent = parentChange;
    const { id, ref, version } = existing;
    operations.push(
      Object.keys(changes).length > 0
        ? { action: 'update', type, key: spec.key, id, ref, version, changes }
        : { action: 'skip', type, key: spec.key, id, ref, version },
    );
    return existing;
  }

  // Dependency order: each epic, then each of its stories followed by its epic link and its tasks.
  const storiesById = new Map(remote.stories.map((story) => [story.id, story]));
  const staleLinks: StaleLink[] = [];
  for (const [e, epic] of backlog.epics.entries()) {
    const remoteEpic = reconcile('epic', epic, epic.description);
    for (const [s, story] of epic.stories.entries()) {
      const remoteStory = reconcile('story', story, storyDescription(story), { parent: epic.key });
      if (!remoteStory && story.format === 'legacy') legacyCreates.push({ key: story.key, path: storyPath(e, s) });
      const linked = remoteEpic && remoteStory && remote.epicStories.get(remoteEpic.id)?.includes(remoteStory.id);
      if (!linked) operations.push({ action: 'link', type: 'story', key: story.key, epic: epic.key });
      // Links of this story to other taigent-managed epics (it moved epics in the manifest) are reported, never removed.
      for (const other of remote.epics) {
        const otherKey = keyOf(other);
        if (!remoteStory || otherKey === undefined || other.id === remoteEpic?.id) continue;
        if (!remote.epicStories.get(other.id)?.includes(remoteStory.id)) continue;
        staleLinks.push({ key: story.key, id: remoteStory.id, ref: remoteStory.ref, epic: otherKey, epicId: other.id, epicRef: other.ref });
      }
      const inOtherStory = (task: TaigaItem): FieldChanges['parent'] => {
        const current = (task as TaigaTask).userStory;
        if (remoteStory && current === remoteStory.id) return undefined;
        const from = current === null ? undefined : storiesById.get(current);
        return { from: (from && keyOf(from)) ?? null, to: story.key };
      };
      for (const task of story.tasks) reconcile('task', task, task.description, { parent: story.key, moved: inOtherStory });
    }
  }

  // Issues come after the epic tree: they have no parent and no link. Values are matched by exact name.
  for (const [i, issue] of backlog.issues.entries()) {
    const values: Partial<Record<IssueValueField, number>> = {};
    for (const field of ISSUE_VALUE_FIELDS) {
      const defined = remote.issueValues[field];
      const value = defined.find((v) => v.name === issue[field]);
      if (value) values[field] = value.id;
      else unknownIssueValues.push({ key: issue.key, path: `${issuePath(i)}.${field}`, field, value: issue[field], names: defined.map((v) => v.name) });
    }
    // An issue with an unknown value is not planned: the plan fails below anyway.
    if (ISSUE_VALUE_FIELDS.every((field) => values[field] !== undefined)) reconcile('issue', issue, issue.description, { values: values as Record<IssueValueField, number> });
  }

  if (legacyCreates.length > 0) throw new LegacyStoryCreateError(legacyCreates);
  if (unknownIssueValues.length > 0) throw new UnknownIssueValueError(unknownIssueValues);

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
      orphans.push({ type, key: keyOf(item)!, id: item.id, ref: item.ref, subject: item.subject });
    }
  }

  return { project: remote.project, ...summarize(PLAN_ACTIONS, operations), operations, orphans, staleLinks };
}
