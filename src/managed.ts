// Managed values: the fields of a backlog item that taigent owns on Taiga, projected the same way from a manifest
// item and from the Taiga item it matches. The planner compares the two projections; everything else on Taiga
// (status, assignee, sprint, points, order, tags without a `type:`/`area:` prefix, undeclared custom attributes) is
// outside the projection, so taigent never reads it as a difference nor writes it. Pure and plain JSON, so a
// projection can be stored and compared again later.

import { ISSUE_VALUE_FIELDS, type IssueValueField, type ItemType } from './items.ts';
import type { EpicSpec, IssueSpec, StorySpec, TaskSpec } from './manifest/backlog.ts';
import { TAG_PREFIXES } from './manifest/conventions.ts';
import { storyDescription } from './story-template.ts';
import type { RemoteState } from './planner.ts';
import type { TaigaIssue, TaigaItem, TaigaTask } from './taiga/client.ts';

/** A value as JSON holds it (custom attribute values on Taiga are arbitrary JSON). */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** The managed values of one backlog item. Optional fields belong to one item type, as noted. */
export interface ManagedValues extends Partial<Record<IssueValueField, string | null>> {
  subject: string;
  /** As Taiga stores it: a story's is rendered from its template. */
  description: string;
  /** Lowercased tags with a `type:` or `area:` prefix, first-seen order, no duplicates; the `src:` identity tag is not one. */
  tags: string[];
  /** Values of the custom attributes the manifest declares, by attribute name; null when unset on Taiga. */
  custom_attributes: Record<string, JsonValue>;
  /** Stories: keys of the taigent-managed epics the story is linked to (the manifest's epic, on the manifest side). */
  epics?: string[];
  /** Tasks: key of the story the task is in; null when in no story taigent manages. */
  story?: string | null;
  // `type`, `severity`, `priority` (issues): the value's name; null on Taiga when unset or not in the project's list.
}

/** The manifest key of a Taiga item, from its first `src:` tag (Taiga lowercases tags; keys are uppercase). */
export function keyOf(item: TaigaItem): string | undefined {
  return item.tags.find((t) => t.startsWith('src:'))?.slice('src:'.length).toUpperCase();
}

/** The managed tags among `tags`: lowercased, prefixed `type:`/`area:`, without duplicates. */
function managedTags(tags: readonly string[]): string[] {
  const prefixed = tags.map((t) => t.toLowerCase()).filter((t) => TAG_PREFIXES.some((prefix) => t.startsWith(`${prefix}:`)));
  return [...new Set(prefixed)];
}

/** Where a manifest item sits in the backlog, for the fields that depend on it. */
export type ManifestItem =
  | { type: 'epic'; item: EpicSpec }
  | { type: 'story'; item: StorySpec; epic: string }
  | { type: 'task'; item: TaskSpec; story: string }
  | { type: 'issue'; item: IssueSpec };

/** The managed values of a manifest item. */
export function manifestManagedValues(entry: ManifestItem): ManagedValues {
  const { item } = entry;
  const values: ManagedValues = {
    subject: item.subject,
    description: entry.type === 'story' ? storyDescription(entry.item) : item.description,
    tags: managedTags(item.tags),
    custom_attributes: { ...item.customAttributes },
  };
  if (entry.type === 'story') values.epics = [entry.epic];
  if (entry.type === 'task') values.story = entry.story;
  if (entry.type === 'issue') for (const field of ISSUE_VALUE_FIELDS) values[field] = entry.item[field];
  return values;
}

/**
 * The managed values of a Taiga item. `attributes`: names of the custom attributes the manifest declares for it;
 * only those the project defines are projected (their values must have been read into `remote.attributeValues`).
 */
export function remoteManagedValues(type: ItemType, item: TaigaItem, remote: RemoteState, attributes: readonly string[]): ManagedValues {
  const defined = attributes.flatMap((name) => {
    const attribute = remote.customAttributes[type].find((a) => a.name === name);
    return attribute ? [{ name, id: attribute.id }] : [];
  });
  const custom: Record<string, JsonValue> = {};
  if (defined.length > 0) {
    const current = remote.attributeValues[type].get(item.id);
    if (!current) throw new Error(`planner: custom attribute values of ${type} ${keyOf(item)} were not read`);
    for (const { name, id } of defined) custom[name] = (current.values[String(id)] ?? null) as JsonValue;
  }
  const values: ManagedValues = { subject: item.subject, description: item.description, tags: managedTags(item.tags), custom_attributes: custom };
  if (type === 'story') {
    values.epics = remote.epics.flatMap((epic) => {
      const key = keyOf(epic);
      return key !== undefined && remote.epicStories.get(epic.id)?.includes(item.id) ? [key] : [];
    });
  }
  if (type === 'task') {
    const id = (item as TaigaTask).userStory;
    const story = id === null ? undefined : remote.stories.find((s) => s.id === id);
    values.story = (story && keyOf(story)) ?? null;
  }
  if (type === 'issue') {
    for (const field of ISSUE_VALUE_FIELDS) {
      const id = (item as TaigaIssue)[field];
      values[field] = remote.issueValues[field].find((v) => v.id === id)?.name ?? null;
    }
  }
  return values;
}

/** A managed field. */
export type ManagedField = keyof ManagedValues;

/**
 * The fields where `remote` does not carry `manifest`'s value, in a fixed order. Tags and epic links are additive:
 * extra ones on Taiga are no difference. Custom attributes compare only those the manifest declares.
 */
export function differingFields(manifest: ManagedValues, remote: ManagedValues): ManagedField[] {
  const fields: ManagedField[] = [];
  if (remote.subject !== manifest.subject) fields.push('subject');
  if (remote.description !== manifest.description) fields.push('description');
  if (manifest.tags.some((t) => !remote.tags.includes(t))) fields.push('tags');
  for (const field of ISSUE_VALUE_FIELDS) if (field in manifest && remote[field] !== manifest[field]) fields.push(field);
  const attributes = Object.entries(manifest.custom_attributes);
  if (attributes.some(([name, value]) => JSON.stringify(remote.custom_attributes[name]) !== JSON.stringify(value))) fields.push('custom_attributes');
  if ('story' in manifest && remote.story !== manifest.story) fields.push('story');
  if (manifest.epics?.some((key) => !remote.epics?.includes(key))) fields.push('epics');
  return fields;
}

/**
 * The fields whose value on Taiga (`remote`) is no longer the one taigent last wrote or accepted (`baseline`): a
 * remote edit. Prefixed tags compare as sets (one added or removed on Taiga counts); custom attributes and epic links
 * only those the manifest declares, since nothing else is managed (an attribute value never recorded counts as unset).
 */
export function remoteEditedFields(baseline: ManagedValues, remote: ManagedValues, manifest: ManagedValues): ManagedField[] {
  const fields: ManagedField[] = [];
  if (remote.subject !== baseline.subject) fields.push('subject');
  if (remote.description !== baseline.description) fields.push('description');
  const tags = new Set(baseline.tags);
  if (remote.tags.length !== tags.size || remote.tags.some((t) => !tags.has(t))) fields.push('tags');
  for (const field of ISSUE_VALUE_FIELDS) if (field in manifest && remote[field] !== baseline[field]) fields.push(field);
  const declared = Object.keys(manifest.custom_attributes);
  if (declared.some((name) => JSON.stringify(remote.custom_attributes[name] ?? null) !== JSON.stringify(baseline.custom_attributes[name] ?? null))) {
    fields.push('custom_attributes');
  }
  if ('story' in manifest && remote.story !== baseline.story) fields.push('story');
  if (manifest.epics?.some((key) => remote.epics?.includes(key) !== baseline.epics?.includes(key))) fields.push('epics');
  return fields;
}
