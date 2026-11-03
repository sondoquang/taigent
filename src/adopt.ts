// Adopt: writes a hand-made Taiga item (no `src:` tag) into backlog.yaml as a backlog item with its `ref`, so that
// plan proposes the `adopt` action and apply adds its `src:<key>` tag (ADR 0004). Reads Taiga, writes only local
// files: the manifest, through the manifest edit API (comments and layout of the file stay), and the Taiga values it
// copied as the item's baseline under `adopted` in state.json, so that plan blocks the adopt when Taiga changes before
// apply. Content is copied verbatim: subject, description, the tags with a prefix the manifest allows, an issue's
// type, severity and priority names; custom attributes are not copied.
//
// Epics and issues sit at the top of the backlog. A story goes under the manifest epic the caller names (`--epic`),
// one of the epics it is linked to on Taiga if it is linked to any, and keeps its whole description in the legacy
// format, no acceptance criteria split out. A task goes under the manifest story the caller names (`--story`), which
// must be the backlog item its story on Taiga is.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ManifestChangedError, readManifestFile, saveItem, type BacklogItem } from './edit.ts';
import { ISSUE_VALUE_FIELDS, ITEM_TYPES, type IssueValueField, type ItemType } from './items.ts';
import { backlogKeyOf, issueValueName, keyOf, managedTags, type ManagedValues } from './managed.ts';
import { checkBacklog, type Backlog } from './manifest/backlog.ts';
import { checkTag } from './manifest/conventions.ts';
import { ManifestError } from './manifest/errors.ts';
import { readState, STATE_FILE, writeState } from './manifest/state.ts';
import { srcTag, type PlanProject } from './planner.ts';
import type { TaigaClient, TaigaIssue, TaigaItem, TaigaTask } from './taiga/client.ts';

/** The item cannot be adopted (closed, already tagged, without the manifest parent it needs, …). Nothing was written. */
export class AdoptError extends Error {}

/** The manifest parent of the adopted item: an epic for a story (`--epic`), a story for a task (`--story`). */
export interface AdoptParent {
  type: 'epic' | 'story';
  key: string;
}

export interface AdoptRequest {
  /** The Taiga ref of the hand-made item. */
  ref: number;
  /** The key of the new backlog item. */
  key: string;
  /** Required for a story and a task, refused for an epic and an issue. */
  parent?: AdoptParent;
}

/** What `taigent adopt --json` prints: the new backlog item and where it is in backlog.yaml. */
export interface AdoptResult {
  project: PlanProject;
  type: ItemType;
  key: string;
  ref: number;
  id: number;
  path: string;
}

/** How messages name each item type. */
const TYPE_NAME: Record<ItemType, string> = { epic: 'epic', story: 'user story', task: 'task', issue: 'issue' };

/** Every key and ref the backlog already uses. */
function usedKeysAndRefs(backlog: Backlog): { keys: Set<string>; refs: Map<number, string> } {
  const items = [...backlog.epics.flatMap((epic) => [epic, ...epic.stories, ...epic.stories.flatMap((story) => story.tasks)]), ...backlog.issues];
  return { keys: new Set(items.map((item) => item.key)), refs: new Map(items.flatMap((item) => (item.ref === undefined ? [] : [[item.ref, item.key] as const]))) };
}

/** What `backlogItem` reads besides the item: the backlog, the project's items on Taiga, by type, and the parent. */
interface AdoptContext {
  backlog: Backlog;
  items: Record<ItemType, TaigaItem[]>;
  parent: AdoptParent | undefined;
  client: TaigaClient;
  projectId: number;
}

/**
 * The backlog item adopting `item`, of `type`, under its manifest parent, and its baseline: Taiga's managed values of
 * the item as plan projects them (the values adopt copies, plus the tags and epic links it leaves on Taiga). Refuses a
 * missing or wrong parent.
 */
async function backlogItem(type: ItemType, item: TaigaItem, key: string, context: AdoptContext): Promise<{ adopting: BacklogItem; baseline: ManagedValues }> {
  const { backlog, parent } = context;
  const what = `${TYPE_NAME[type]} #${item.ref}`;
  const backlogKey = backlogKeyOf(backlog);
  // Only the tags a manifest may hold (`type:`/`area:` ones that follow the conventions); the others stay on Taiga.
  const tags = item.tags.filter((tag) => checkTag(tag, '', () => {}));
  const fields = { ref: item.ref, subject: item.subject, description: item.description, tags };
  const baseline: ManagedValues = { subject: item.subject, description: item.description, tags: managedTags(item.tags), custom_attributes: {} };
  if ((type === 'epic' || type === 'issue') && parent) throw new AdoptError(`${what} sits at the top of backlog.yaml: drop --${parent.type}`);
  switch (type) {
    case 'epic':
      return { adopting: { type, key, fields }, baseline };
    case 'issue': {
      const values = {} as Record<IssueValueField, string>;
      for (const field of ISSUE_VALUE_FIELDS) {
        const name = issueValueName(await context.client.listIssueValues(field, context.projectId), (item as TaigaIssue)[field]);
        if (name === null) throw new AdoptError(`issue #${item.ref} has no ${field} the project defines; set one on Taiga, then adopt it`);
        values[field] = name;
      }
      return { adopting: { type, key, fields: { ...fields, ...values } }, baseline: { ...baseline, ...values } };
    }
    case 'story': {
      if (parent?.type !== 'epic') throw new AdoptError(`${what} goes under an epic of backlog.yaml: add --epic <KEY>${parent ? `, not --${parent.type}` : ''}`);
      if (!backlog.epics.some((epic) => epic.key === parent.key)) throw new AdoptError(`--epic ${parent.key} is not an epic of backlog.yaml`);
      // A story linked on Taiga stays under one of its epics; an unlinked one is linked to --epic by the adopt.
      const linked: TaigaItem[] = [];
      for (const epic of context.items.epic) if ((await context.client.listEpicUserStories(epic.id)).includes(item.id)) linked.push(epic);
      const epics = linked.flatMap((epic) => backlogKey('epic', epic.ref, keyOf(epic)) ?? []);
      if (linked.length > 0 && !epics.includes(parent.key)) {
        const refs = linked.map((epic) => `#${epic.ref}`).join(', ');
        throw new AdoptError(`${what} is linked on Taiga to epic ${refs}, not to backlog epic ${parent.key}; adopt that epic first, then adopt the story under it`);
      }
      // Legacy format: the whole description as written on Taiga, which it renders back byte for byte.
      return { adopting: { type, key, parent: parent.key, fields }, baseline: { ...baseline, epics } };
    }
    case 'task': {
      if (parent?.type !== 'story') throw new AdoptError(`${what} goes under a story of backlog.yaml: add --story <KEY>${parent ? `, not --${parent.type}` : ''}`);
      if (!backlog.epics.some((epic) => epic.stories.some((story) => story.key === parent.key))) throw new AdoptError(`--story ${parent.key} is not a story of backlog.yaml`);
      const storyId = (item as TaigaTask).userStory;
      if (storyId === null) throw new AdoptError(`${what} is in no user story; only a task in a backlog story is adopted`);
      const story = context.items.story.find((candidate) => candidate.id === storyId);
      const storyWhat = story ? `user story #${story.ref}` : `user story id ${storyId}`;
      const storyKey = story && backlogKey('story', story.ref, keyOf(story));
      if (storyKey === undefined) throw new AdoptError(`${what} is in ${storyWhat}, which is not a backlog item; adopt that story first`);
      if (storyKey !== parent.key) throw new AdoptError(`${what} is in ${storyWhat}, which is backlog item ${storyKey}, not ${parent.key}`);
      return { adopting: { type, key, parent: parent.key, fields }, baseline: { ...baseline, story: storyKey } };
    }
  }
}

/**
 * Adopts the hand-made item `request.ref` of project `slug` as backlog item `request.key` in the backlog of the
 * project directory `dir`, and records the Taiga values it copied as the item's baseline under `adopted` in
 * state.json, for the three-way check of the adopt. Throws AdoptError when the item cannot be adopted, ManifestError
 * when the new item breaks a manifest rule, ManifestChangedError when backlog.yaml changed meanwhile; nothing is
 * written then.
 */
export async function adoptItem(dir: string, slug: string, client: TaigaClient, request: AdoptRequest): Promise<AdoptResult> {
  const { ref, key } = request;
  const manifest = await readManifestFile(dir, 'backlog');
  const backlog = manifest.text.trim() === '' ? { epics: [], issues: [] } : checkBacklog(parse(manifest.text), manifest.file);
  const used = usedKeysAndRefs(backlog);
  if (used.keys.has(key)) throw new AdoptError(`key ${key} is already in backlog.yaml; choose another key`);
  const adoptedBy = used.refs.get(ref);
  if (adoptedBy !== undefined) throw new AdoptError(`#${ref} is already adopted by ${adoptedBy} in backlog.yaml`);

  const project = await client.getProjectBySlug(slug);
  const items = {} as Record<ItemType, TaigaItem[]>;
  let found: { type: ItemType; item: TaigaItem } | undefined;
  for (const type of ITEM_TYPES) {
    items[type] = await client.listItems(type, project.id);
    const item = items[type].find((candidate) => candidate.ref === ref);
    if (item) found = { type, item };
  }
  if (!found) throw new AdoptError(`no epic, user story, task or issue #${ref} in project ${slug}`);
  const { type, item } = found;
  const taggedKey = keyOf(item);
  if (taggedKey !== undefined) {
    throw new AdoptError(`${TYPE_NAME[type]} #${ref} already carries ${srcTag(taggedKey)}: it is backlog item ${taggedKey}; one Taiga item is never bound to two backlog items`);
  }
  if (item.isClosed) throw new AdoptError(`${TYPE_NAME[type]} #${ref} is closed (${item.status ?? 'closed status'}); closed items are not adopted`);

  const { adopting, baseline } = await backlogItem(type, item, key, { backlog, items, parent: request.parent, client, projectId: project.id });
  await mkdir(dir, { recursive: true });
  const saved = await saveItem(dir, { baseDigest: manifest.digest, item: adopting });
  if (saved.status === 'invalid') throw new ManifestError(saved.issues);
  if (saved.status === 'conflict') throw new ManifestChangedError('backlog.yaml changed while adopting; nothing was written, run adopt again');
  const statePath = join(dir, STATE_FILE);
  const state = await readState(statePath, { id: project.id, slug: project.slug });
  state.adopted[key] = { type, id: item.id, ref: item.ref, version: item.version, baseline };
  await writeState(statePath, state);
  return { project: { id: project.id, slug: project.slug }, type, key, ref, id: item.id, path: saved.path };
}
