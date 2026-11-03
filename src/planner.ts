// Planner: pure function from (manifest, Taiga state read back, baselines of state.json) to an ordered plan. No I/O.

import { ISSUE_VALUE_FIELDS, ITEM_TYPES, type IssueValueField, type ItemType } from './items.ts';
import {
  epicPath,
  issuePath,
  storyPath,
  type AttributeValue,
  type Backlog,
  type LegacyStoryCreate,
  type UnknownIssueValue,
} from './manifest/backlog.ts';
import {
  backlogKeyOf,
  blockedFields,
  differingFields,
  isSrcTag,
  keyOf,
  manifestManagedValues,
  remoteManagedValues,
  type BlockedKind,
  type ManagedField,
  type ManagedValues,
  type ManifestItem,
} from './managed.ts';
import { recordedBaseline, type StateFile } from './manifest/state.ts';
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
  /** Ids of the user stories linked to each epic that carries a `src:` tag or that the backlog adopts by `ref` (`related_userstories`). */
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
  /**
   * Takes over the hand-made item the manifest's `ref` names (no item carries `src:<key>` yet): `changes.tags` adds
   * `src:<key>`; the other changes are content updates, as in `update`.
   */
  | { action: 'adopt'; type: ItemType; key: string; id: number; ref: number; version: number; changes: FieldChanges }
  | { action: 'link'; type: 'story'; key: string; epic: string }
  | { action: 'skip'; type: ItemType; key: string; id: number; ref: number; version: number };

/** The actions of a backlog plan. */
export const PLAN_ACTIONS = ['create', 'update', 'adopt', 'link', 'skip'] as const;

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

/** One field of a blocked item: its baseline (absent for `unknown`), Taiga's and the manifest's value. */
export interface BlockedField {
  baseline?: ManagedValues[ManagedField];
  taiga: ManagedValues[ManagedField];
  manifest: ManagedValues[ManagedField];
}

/** A tagged item plan neither updates nor skips until a person settles it; apply refuses while there is one. */
export interface BlockedItem {
  kind: BlockedKind;
  type: ItemType;
  key: string;
  id: number;
  ref: number;
  /** The fields that differ between any two of the versions. */
  fields: Partial<Record<ManagedField, BlockedField>>;
}

/**
 * A hand-made item (no `src:` tag, adopted by no backlog item) under a backlog item on Taiga: a story linked to a
 * manifest epic, or a task in a manifest story. Reported, never touched: its content and links stay as they are.
 */
export interface HandMadeChild {
  type: 'story' | 'task';
  id: number;
  ref: number;
  subject: string;
  /** Key of the backlog item it is under: the epic (story) or story (task). */
  parent: string;
}

export interface Plan extends PlanSummary<Action> {
  project: PlanProject;
  operations: Operation[];
  orphans: Orphan[];
  staleLinks: StaleLink[];
  blocked: BlockedItem[];
  handMadeChildren: HandMadeChild[];
}

/**
 * The Taiga item a backlog item is (tagged `src:<key>`) or adopts (its `ref`, `adopting`), with the managed values of
 * both sides as plan compared them.
 */
export interface Counterpart {
  type: ItemType;
  item: TaigaItem;
  taiga: ManagedValues;
  manifest: ManagedValues;
  adopting: boolean;
}

/**
 * A plan and the baseline apply records for each item once its operation succeeds (by key; a story's epic links are
 * those before its `link` operation, which adds its epic), and the counterpart of each backlog item on Taiga.
 */
export interface PlannedBacklog {
  plan: Plan;
  baselines: Map<string, ManagedValues>;
  counterparts: Map<string, Counterpart>;
}

/** A manifest `ref` that names no item the backlog item can be or adopt; `path` locates the `ref` in backlog.yaml. */
export interface RefMismatch {
  key: string;
  path: string;
  message: string;
}

/**
 * Backlog items whose `ref` does not match Taiga: the item tagged `src:<key>` has another ref, or the ref names no
 * item, an item of another type, or one tagged with another key. The caller reports them as manifest issues.
 */
export class RefMismatchError extends Error {
  readonly mismatches: readonly RefMismatch[];

  constructor(mismatches: readonly RefMismatch[]) {
    super(mismatches.map((mismatch) => mismatch.message).join('; '));
    this.name = 'RefMismatchError';
    this.mismatches = mismatches;
  }
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
    case 'update':
    case 'adopt': {
      const { custom_attributes: changed, parent } = op.changes;
      const attributes = changed ? `  [custom attributes ${formatAttributes(changed.from, changed.to)}]` : '';
      const fields = Object.keys(op.changes).map((field) => {
        if (field === 'parent' && parent) return `parent (${parent.from ? `story ${parent.from}` : 'no story'} -> story ${parent.to})`;
        const value = (ISSUE_VALUE_FIELDS as readonly string[]).includes(field) ? op.changes[field as IssueValueField] : undefined;
        return value ? `${field} (${value.names.from ?? 'none'} -> ${value.names.to})` : field;
      });
      const title = op.action === 'adopt' ? `adopt  ${op.type} ${op.key}  (hand-made #${op.ref}, id ${op.id})` : `update ${op.type} ${op.key}  (#${op.ref}, id ${op.id})`;
      return `${title}: ${fields.join(', ')}${attributes}`;
    }
    case 'link':
      return `link   story ${op.key} -> epic ${op.epic}`;
    case 'skip':
      return `${op.type} ${op.key}  (#${op.ref}, id ${op.id}, unchanged)`;
  }
}

/** How messages name each item type. */
const ITEM_WHAT: Record<ItemType, string> = { epic: 'an epic', story: 'a user story', task: 'a task', issue: 'an issue' };

/**
 * `state`: state.json; a baseline counts only for the Taiga item of its type and id: an item's in `items` once
 * tagged, the one `adopted` holds (else its `items` one) while the backlog item adopts it by `ref`.
 */
export function buildPlan(backlog: Backlog, remote: RemoteState, state: Pick<StateFile, 'items' | 'adopted'> = { items: {}, adopted: {} }): PlannedBacklog {
  const remoteItems: Record<ItemType, TaigaItem[]> = { epic: remote.epics, story: remote.stories, task: remote.tasks, issue: remote.issues };
  const bySrcTag = {} as Record<ItemType, Map<string, TaigaItem>>;
  for (const type of ITEM_TYPES) {
    bySrcTag[type] = new Map();
    // Oldest first, so if duplicates already exist the original item keeps its identity.
    for (const item of [...remoteItems[type]].sort((a, b) => a.id - b.id)) {
      for (const tag of item.tags) {
        if (isSrcTag(tag) && !bySrcTag[type].has(tag)) bySrcTag[type].set(tag, item);
      }
    }
  }

  // Backlog items that adopt a hand-made item by `ref` (no item carries their `src:<key>` tag yet), resolved before
  // anything is planned: a `ref` naming neither the tagged item nor an untagged item of the same type fails the plan.
  const byRef = new Map<number, { type: ItemType; item: TaigaItem }>();
  for (const type of ITEM_TYPES) for (const item of remoteItems[type]) byRef.set(item.ref, { type, item });
  type RefEntry = { type: ItemType; spec: { key: string; ref?: number }; path: string };
  const refEntries: RefEntry[] = [
    ...backlog.epics.flatMap((epic, e): RefEntry[] => [
      { type: 'epic', spec: epic, path: epicPath(e) },
      ...epic.stories.flatMap((story, s): RefEntry[] => [
        { type: 'story', spec: story, path: storyPath(e, s) },
        ...story.tasks.map((task, t): RefEntry => ({ type: 'task', spec: task, path: `${storyPath(e, s)}.tasks[${t}]` })),
      ]),
    ]),
    ...backlog.issues.map((issue, i): RefEntry => ({ type: 'issue', spec: issue, path: issuePath(i) })),
  ];
  const adopted = new Map<string, TaigaItem>();
  const refMismatches: RefMismatch[] = [];
  for (const { type, spec, path } of refEntries) {
    if (spec.ref === undefined) continue;
    const tagged = bySrcTag[type].get(srcTag(spec.key));
    if (tagged?.ref === spec.ref) continue;
    const found = byRef.get(spec.ref);
    const foundKey = found && keyOf(found.item);
    let problem: string;
    if (tagged) problem = `${spec.key} is #${tagged.ref} on Taiga (tagged ${srcTag(spec.key)}), not #${spec.ref}`;
    else if (!found) problem = `no epic, user story, task or issue #${spec.ref} in project ${remote.project.slug}`;
    else if (found.type !== type) problem = `#${spec.ref} is ${ITEM_WHAT[found.type]} on Taiga, not ${ITEM_WHAT[type]}`;
    else if (foundKey !== undefined) problem = `#${spec.ref} already carries ${srcTag(foundKey)} (backlog item ${foundKey}); one Taiga item is never bound to two backlog items`;
    else {
      adopted.set(spec.key, found.item);
      continue;
    }
    refMismatches.push({ key: spec.key, path: `${path}.ref`, message: `${spec.key}: ${problem}` });
  }
  if (refMismatches.length > 0) throw new RefMismatchError(refMismatches);
  const keyByTagOrRef = backlogKeyOf(backlog);
  /** The key of the backlog item a Taiga item of `type` is: its `src:` tag, or the backlog item adopting it; none: hand-made. */
  const backlogKey = (type: ItemType, item: TaigaItem) => keyByTagOrRef(type, item.ref, keyOf(item));

  const manifestTags = Object.fromEntries(ITEM_TYPES.map((type) => [type, new Set<string>()])) as Record<ItemType, Set<string>>;
  const operations: Operation[] = [];
  const unknownAttributes: string[] = [];
  const legacyCreates: LegacyStoryCreate[] = [];
  const unknownIssueValues: UnknownIssueValue[] = [];
  const blocked: BlockedItem[] = [];
  const baselines = new Map<string, ManagedValues>();
  const counterparts = new Map<string, Counterpart>();

  /**
   * Plans create/update/adopt/skip for one manifest item from its managed values, those of its Taiga counterpart
   * (tagged `src:<key>`, or adopted by `ref`) and its baseline, or blocks it. Returns the counterpart, if any, and the
   * fields to write (none when blocked). `values`: an issue's type, severity and priority ids.
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
    const tagged = bySrcTag[type].get(tag);
    const existing = tagged ?? adopted.get(key);
    const recorded = state.items[key];
    if (!existing) {
      // An item apply recorded, still on Taiga but without its `src:<key>` tag: a remote edit of its tags, never a duplicate.
      const untagged = recorded?.type === type ? remoteItems[type].find((item) => item.id === recorded.id) : undefined;
      if (untagged) {
        const tags = { ...(recorded!.baseline && { baseline: [...recorded!.baseline.tags, tag] }), taiga: untagged.tags, manifest: [...want.tags, tag] };
        blocked.push({ kind: 'remote-edit', type, key, id: untagged.id, ref: untagged.ref, fields: { tags } });
        return { differing: [] };
      }
      const parent = entry.type === 'story' ? entry.epic : entry.type === 'task' ? entry.story : undefined;
      operations.push({
        action: 'create',
        type,
        key,
        ...(parent && { parent }),
        fields: { subject: want.subject, description: want.description, tags: [...new Set([...want.tags, tag])], ...values },
        ...(declared.length > 0 && { custom_attributes: entry.item.customAttributes }),
      });
      // A story's epic link is recorded by its own link operation.
      baselines.set(key, entry.type === 'story' ? { ...want, epics: [] } : want);
      return {};
    }
    const have = remoteManagedValues(type, existing, remote, declared, keyByTagOrRef);
    const differing = differingFields(want, have);
    counterparts.set(key, { type, item: existing, taiga: have, manifest: want, adopting: !tagged });
    // Adopting (no `src:<key>` tag yet): the baseline `adopt` recorded, if any; without one the manifest takes over the
    // hand-made item as it is, and the adopt sets its first baseline.
    const baseline = tagged ? recordedBaseline(recorded, type, existing.id) : (recordedBaseline(state.adopted[key], type, existing.id) ?? recordedBaseline(recorded, type, existing.id));
    const blocking = tagged || baseline ? blockedFields(want, have, baseline) : undefined;
    if (blocking) {
      const versions = blocking.fields.map((field) => [field, { ...(baseline && { baseline: baseline[field] }), taiga: have[field], manifest: want[field] }]);
      blocked.push({ kind: blocking.kind, type, key, id: existing.id, ref: existing.ref, fields: Object.fromEntries(versions) });
      return { existing, differing: [] };
    }
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
    // Adopting adds the identity tag; the rest are the content updates, if any.
    if (!tagged) changes.tags = { from: existing.tags, to: [...(changes.tags?.to ?? existing.tags), tag] };
    const { id, ref, version } = existing;
    if (!tagged) operations.push({ action: 'adopt', type, key, id, ref, version, changes });
    else if (Object.keys(changes).length > 0) operations.push({ action: 'update', type, key, id, ref, version, changes });
    else operations.push({ action: 'skip', type, key, id, ref, version });
    // What Taiga holds once the changes are written: tags are only added; a story's links change by link operations.
    baselines.set(key, differing.length === 0 ? have : { ...want, tags: [...new Set([...have.tags, ...want.tags])], ...(have.epics && { epics: have.epics }) });
    return { existing, differing };
  }

  // Dependency order: each epic, then each of its stories followed by its epic link and its tasks. Hand-made stories
  // and tasks under a backlog item are listed apart: their content and links are never touched.
  const staleLinks: StaleLink[] = [];
  const handMadeChildren: HandMadeChild[] = [];
  for (const [e, epic] of backlog.epics.entries()) {
    const { existing: remoteEpic } = reconcile({ type: 'epic', item: epic });
    for (const id of remoteEpic ? (remote.epicStories.get(remoteEpic.id) ?? []) : []) {
      const linked = remote.stories.find((story) => story.id === id);
      if (linked && backlogKey('story', linked) === undefined) handMadeChildren.push({ type: 'story', id, ref: linked.ref, subject: linked.subject, parent: epic.key });
    }
    for (const [s, story] of epic.stories.entries()) {
      const { existing: remoteStory, differing } = reconcile({ type: 'story', item: story, epic: epic.key });
      // Only a story plan creates (no counterpart, not blocked) must be in the user story format.
      if (!remoteStory && !differing && story.format === 'legacy') legacyCreates.push({ key: story.key, path: storyPath(e, s) });
      if (!differing || differing.includes('epics')) operations.push({ action: 'link', type: 'story', key: story.key, epic: epic.key });
      // Links of this story to other taigent-managed epics (it moved epics in the manifest) are reported, never removed.
      for (const other of remote.epics) {
        const otherKey = backlogKey('epic', other);
        if (!remoteStory || otherKey === undefined || other.id === remoteEpic?.id) continue;
        if (!remote.epicStories.get(other.id)?.includes(remoteStory.id)) continue;
        staleLinks.push({ key: story.key, id: remoteStory.id, ref: remoteStory.ref, epic: otherKey, epicId: other.id, epicRef: other.ref });
      }
      for (const task of story.tasks) reconcile({ type: 'task', item: task, story: story.key });
      for (const task of remoteStory ? remote.tasks : []) {
        if (task.userStory !== remoteStory!.id || backlogKey('task', task) !== undefined) continue;
        handMadeChildren.push({ type: 'task', id: task.id, ref: task.ref, subject: task.subject, parent: story.key });
      }
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
      const srcTags = item.tags.filter(isSrcTag);
      if (srcTags.length === 0 || srcTags.some((t) => manifestTags[type].has(t))) continue;
      orphans.push({ type, key: keyOf(item)!, id: item.id, ref: item.ref, subject: item.subject });
    }
  }

  return { plan: { project: remote.project, ...summarize(PLAN_ACTIONS, operations), operations, orphans, staleLinks, blocked, handMadeChildren }, baselines, counterparts };
}
