// Adopt: writes a hand-made Taiga item (no `src:` tag) into backlog.yaml as a backlog item with its `ref`, so that
// plan proposes the `adopt` action and apply adds its `src:<key>` tag (ADR 0004). Reads Taiga, writes only the
// manifest, through the manifest edit API (comments and layout of the file stay). Content is copied verbatim:
// subject, description, the tags with a prefix the manifest allows, an issue's type, severity and priority names;
// custom attributes are not copied.
//
// Epics and issues sit at the top of the backlog. A story needs a manifest epic as parent, a task a manifest story:
// each type gets its own case in `backlogItem`.

import { mkdir } from 'node:fs/promises';
import { parse } from 'yaml';
import { readManifestFile, saveItem, type BacklogItem } from './edit.ts';
import { ISSUE_VALUE_FIELDS, ITEM_TYPES, type IssueValueField, type ItemType } from './items.ts';
import { checkBacklog, type Backlog } from './manifest/backlog.ts';
import { checkTag } from './manifest/conventions.ts';
import { ManifestError } from './manifest/errors.ts';
import type { PlanProject } from './planner.ts';
import type { TaigaClient, TaigaIssue, TaigaItem } from './taiga/client.ts';

/** The item cannot be adopted (closed, already tagged, of a type adopt does not take, …). Nothing was written. */
export class AdoptError extends Error {}

export interface AdoptRequest {
  /** The Taiga ref of the hand-made item. */
  ref: number;
  /** The key of the new backlog item. */
  key: string;
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
const WHAT: Record<ItemType, string> = { epic: 'epic', story: 'user story', task: 'task', issue: 'issue' };

/** Every key and ref the backlog already uses. */
function usedKeysAndRefs(backlog: Backlog): { keys: Set<string>; refs: Map<number, string> } {
  const items = [...backlog.epics.flatMap((epic) => [epic, ...epic.stories, ...epic.stories.flatMap((story) => story.tasks)]), ...backlog.issues];
  return { keys: new Set(items.map((item) => item.key)), refs: new Map(items.flatMap((item) => (item.ref === undefined ? [] : [[item.ref, item.key] as const]))) };
}

/** The backlog item adopting `item`, of `type`; refuses the types adopt does not take. */
async function backlogItem(type: ItemType, item: TaigaItem, key: string, client: TaigaClient, projectId: number): Promise<BacklogItem> {
  // Only the tags a manifest may hold (`type:`/`area:` ones that follow the conventions); the others stay on Taiga.
  const tags = item.tags.filter((tag) => checkTag(tag, '', () => {}));
  const fields = { ref: item.ref, subject: item.subject, description: item.description, tags };
  switch (type) {
    case 'epic':
      return { type, key, fields };
    case 'issue': {
      const values = {} as Record<IssueValueField, string>;
      for (const field of ISSUE_VALUE_FIELDS) {
        const id = (item as TaigaIssue)[field];
        const name = (await client.listIssueValues(field, projectId)).find((value) => value.id === id)?.name;
        if (name === undefined) throw new AdoptError(`issue #${item.ref} has no ${field} the project defines; set one on Taiga, then adopt it`);
        values[field] = name;
      }
      return { type, key, fields: { ...fields, ...values } };
    }
    case 'story':
    case 'task':
      throw new AdoptError(`#${item.ref} is a ${WHAT[type]}; taigent adopt takes epics and issues`);
  }
}

/**
 * Adopts the hand-made item `request.ref` of project `slug` as backlog item `request.key` in the backlog of the
 * project directory `dir`. Throws AdoptError when the item cannot be adopted, ManifestError when the new item
 * breaks a manifest rule; nothing is written then.
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
  let found: { type: ItemType; item: TaigaItem } | undefined;
  for (const type of ITEM_TYPES) {
    const item = (await client.listItems(type, project.id)).find((candidate) => candidate.ref === ref);
    if (item) found = { type, item };
  }
  if (!found) throw new AdoptError(`no epic, user story, task or issue #${ref} in project ${slug}`);
  const { type, item } = found;
  const tag = item.tags.find((t) => t.startsWith('src:'));
  if (tag) {
    throw new AdoptError(`${WHAT[type]} #${ref} already carries ${tag}: it is backlog item ${tag.slice('src:'.length).toUpperCase()}; one Taiga item is never bound to two backlog items`);
  }
  if (item.closed) throw new AdoptError(`${WHAT[type]} #${ref} is closed; closed items are not adopted`);

  const adopting = await backlogItem(type, item, key, client, project.id);
  await mkdir(dir, { recursive: true });
  const saved = await saveItem(dir, { baseDigest: manifest.digest, item: adopting });
  if (saved.status === 'invalid') throw new ManifestError(saved.issues);
  if (saved.status === 'conflict') throw new AdoptError('backlog.yaml changed while adopting; nothing was written, run adopt again');
  return { project: { id: project.id, slug: project.slug }, type, key, ref, id: item.id, path: saved.path };
}
