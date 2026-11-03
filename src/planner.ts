// Planner: pure function from (manifest, Taiga state read back) to an ordered plan. No I/O.

import { ISSUE_VALUE_FIELDS, ITEM_TYPES, type IssueValueField, type ItemType } from './items.ts';
import {
  issuePath,
  storyPath,
  type AttributeValue,
  type Backlog,
  type LegacyStoryCreate,
  type UnknownIssueValue,
} from './manifest/backlog.ts';
import { differingFields, keyOf, manifestManagedValues, remoteManagedValues, type ManagedField, type ManifestItem } from './managed.ts';
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

  /**
   * Plans create/update/skip for one manifest item from its managed values and those of its Taiga counterpart.
   * Returns the counterpart, if any, and the fields where it differs. `values`: an issue's type, severity and
   * priority ids.
   */
  function reconcile(entry: ManifestItem, values?: Record<IssueValueField, number>): { existing?: TaigaItem; differing?: ManagedField[] } {
    const { type } = entry;
    const { key } = entry.item;
    const tag = srcTag(key);
    manifestTags[type].add(tag);
    const want = manifestManagedValues(entry);
    const defined = remote.customAttributes[type];
    const declared = Object.keys(want.custom_attributes).filter((name) => {
      if (defined.some((a) => a.name === name)) return true;
      const names = defined.map((a) => `"${a.name}"`).join(', ') || 'none';
      unknownAttributes.push(`  ${key} (${type}): "${name}"; ${type} attributes on Taiga: ${names}`);
      return false;
    });
    const existing = bySrcTag[type].get(tag);
    if (!existing) {
      const parent = entry.type === 'story' ? entry.epic : entry.type === 'task' ? entry.story : undefined;
      operations.push({
        action: 'create',
        type,
        key,
        ...(parent && { parent }),
        fields: { subject: want.subject, description: want.description, tags: [...new Set([...want.tags, tag])], ...values },
        ...(declared.length > 0 && { custom_attributes: entry.item.customAttributes }),
      });
      return {};
    }
    const have = remoteManagedValues(type, existing, remote, declared);
    const differing = differingFields(want, have);
    const changes: FieldChanges = {};
    for (const field of differing) {
      switch (field) {
        case 'subject':
        case 'description':
          changes[field] = { from: existing[field], to: want[field] };
          break;
        case 'tags':
          changes.tags = { from: existing.tags, to: [...existing.tags, ...want.tags.filter((t) => !existing.tags.includes(t))] };
          break;
        case 'type':
        case 'severity':
        case 'priority':
          changes[field] = { from: (existing as TaigaIssue)[field], to: values![field], names: { from: have[field] ?? null, to: want[field]! } };
          break;
        case 'custom_attributes': {
          const from: Record<string, unknown> = {};
          const to: Record<string, AttributeValue> = {};
          for (const name of declared) {
            if (JSON.stringify(have.custom_attributes[name]) === JSON.stringify(want.custom_attributes[name])) continue;
            from[name] = have.custom_attributes[name];
            to[name] = entry.item.customAttributes[name]!;
          }
          if (Object.keys(to).length > 0) changes.custom_attributes = { from, to, version: remote.attributeValues[type].get(existing.id)!.version };
          break;
        }
        case 'story':
          changes.parent = { from: have.story ?? null, to: want.story! };
          break;
        case 'epics':
          // Planned as a link operation by the caller.
          break;
      }
    }
    const { id, ref, version } = existing;
    operations.push(
      Object.keys(changes).length > 0
        ? { action: 'update', type, key, id, ref, version, changes }
        : { action: 'skip', type, key, id, ref, version },
    );
    return { existing, differing };
  }

  // Dependency order: each epic, then each of its stories followed by its epic link and its tasks.
  const staleLinks: StaleLink[] = [];
  for (const [e, epic] of backlog.epics.entries()) {
    const { existing: remoteEpic } = reconcile({ type: 'epic', item: epic });
    for (const [s, story] of epic.stories.entries()) {
      const { existing: remoteStory, differing } = reconcile({ type: 'story', item: story, epic: epic.key });
      if (!remoteStory && story.format === 'legacy') legacyCreates.push({ key: story.key, path: storyPath(e, s) });
      if (!differing || differing.includes('epics')) operations.push({ action: 'link', type: 'story', key: story.key, epic: epic.key });
      // Links of this story to other taigent-managed epics (it moved epics in the manifest) are reported, never removed.
      for (const other of remote.epics) {
        const otherKey = keyOf(other);
        if (!remoteStory || otherKey === undefined || other.id === remoteEpic?.id) continue;
        if (!remote.epicStories.get(other.id)?.includes(remoteStory.id)) continue;
        staleLinks.push({ key: story.key, id: remoteStory.id, ref: remoteStory.ref, epic: otherKey, epicId: other.id, epicRef: other.ref });
      }
      for (const task of story.tasks) reconcile({ type: 'task', item: task, story: story.key });
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
    if (ISSUE_VALUE_FIELDS.every((field) => values[field] !== undefined)) reconcile({ type: 'issue', item: issue }, values as Record<IssueValueField, number>);
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
