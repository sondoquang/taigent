// Upload: brings Taiga's wiki pages and attachments to what docs.yaml declares. `planUpload` reads Taiga
// and the local files (hashing attachments as a stream) and derives the operations; `executeUpload` runs
// them. Wiki pages are upserted by slug. Attachments are only ever added: one with the same name, size and
// sha1 already on the target is skipped; a changed file is uploaded again and the old attachment stays.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';
import { ApplyConflictError } from './executor.ts';
import type { Backlog } from './manifest/backlog.ts';
import { WIKI_HOME_SLUG } from './manifest/conventions.ts';
import { WIKI_TARGET_PREFIX, type AttachmentSpec, type Docs } from './manifest/docs.ts';
import type { ItemType } from './manifest/state.ts';
import { srcTag, type PlanProject } from './planner.ts';
import { TaigaConflictError, TaigaError, type AttachmentObjectType, type TaigaClient, type TaigaItem } from './taiga/client.ts';

export type AttachmentTargetType = ItemType | 'wiki';

/** Attachment already on Taiga with the name of a changed local file; it is left in place. */
export interface PreviousAttachment {
  id: number;
  size: number;
  sha1: string;
}

interface AttachmentFields {
  /** As written in docs.yaml: an item key or `wiki:<slug>`. */
  target: string;
  targetType: AttachmentTargetType;
  /** Id of the epic/story/task/wiki page; null for a wiki page this upload creates. */
  objectId: number | null;
  name: string;
  /** Path relative to the working directory. */
  file: string;
  size: number;
  sha1: string;
  description: string;
}

export type UploadOperation =
  | { action: 'create'; type: 'wiki'; slug: string; file: string }
  | { action: 'update'; type: 'wiki'; slug: string; file: string; id: number; version: number }
  | { action: 'skip'; type: 'wiki'; slug: string; file: string; id: number }
  /** `previous`: attachments with the same name but other content, which stay on Taiga. */
  | ({ action: 'create'; type: 'attachment'; previous: PreviousAttachment[] } & AttachmentFields)
  | ({ action: 'skip'; type: 'attachment'; id: number } & AttachmentFields);

export interface UploadPlan {
  project: PlanProject;
  changes: boolean;
  summary: { create: number; update: number; skip: number };
  operations: UploadOperation[];
}

export type UploadResult = 'created' | 'updated' | 'unchanged';

export interface UploadReport {
  project: PlanProject;
  /** `id`: the wiki page, or the attachment (the new one when created). */
  operations: (UploadOperation & { id: number; result: UploadResult })[];
  summary: Record<UploadResult, number>;
}

/** Taiga (or its reverse proxy) refused an upload as too large (HTTP 413). */
export class UploadTooLargeError extends TaigaError {
  readonly file: string;

  constructor(file: string, message: string) {
    super(message, 413);
    this.name = 'UploadTooLargeError';
    this.file = file;
  }
}

const ENDPOINTS: Record<AttachmentTargetType, AttachmentObjectType> = { epic: 'epics', story: 'userstories', task: 'tasks', wiki: 'wiki' };

/** Size and sha1 of a file, read as a stream (never held in memory as a whole). */
async function fileDigest(path: string): Promise<{ size: number; sha1: string }> {
  const hash = createHash('sha1');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { size, sha1: hash.digest('hex') };
}

/** Item type of every backlog key. */
function backlogTypes(backlog: Backlog | undefined): Map<string, ItemType> {
  const types = new Map<string, ItemType>();
  for (const epic of backlog?.epics ?? []) {
    types.set(epic.key, 'epic');
    for (const story of epic.stories) {
      types.set(story.key, 'story');
      for (const task of story.tasks) types.set(task.key, 'task');
    }
  }
  return types;
}

/** Finds an attachment's target on Taiga: items by their `src:<key>` tag, wiki pages by slug. */
async function resolveTargets(
  attachments: AttachmentSpec[],
  backlog: Backlog | undefined,
  project: PlanProject,
  client: TaigaClient,
  wikiIds: Map<string, number | null>,
): Promise<Map<AttachmentSpec, { type: AttachmentTargetType; target: string; objectId: number | null }>> {
  const types = backlogTypes(backlog);
  const lists: Partial<Record<ItemType, Promise<TaigaItem[]>>> = {};
  const listItems = (type: ItemType) =>
    (lists[type] ??= type === 'epic' ? client.listEpics(project.id) : type === 'story' ? client.listUserStories(project.id) : client.listTasks(project.id));

  const resolved = new Map<AttachmentSpec, { type: AttachmentTargetType; target: string; objectId: number | null }>();
  for (const spec of attachments) {
    if (spec.target.kind === 'wiki') {
      const { slug } = spec.target;
      const target = `${WIKI_TARGET_PREFIX}${slug}`;
      if (!wikiIds.has(slug)) {
        // Only `home` may be targeted without being declared in docs.yaml (bootstrap creates it).
        const page = await client.findWikiPage(project.id, slug);
        if (!page) {
          throw new TaigaError(
            `attachment target ${target}: wiki page "${slug}" does not exist on Taiga` +
              (slug === WIKI_HOME_SLUG ? ' (bootstrap creates it from wiki_home in project.yaml)' : ''),
          );
        }
        wikiIds.set(slug, page.id);
      }
      resolved.set(spec, { type: 'wiki', target, objectId: wikiIds.get(slug)! });
      continue;
    }
    const { key } = spec.target;
    // loadDocs already checked the key against backlog.yaml (`key-reference`).
    const type = types.get(key)!;
    const item = (await listItems(type)).find((candidate) => candidate.tags.includes(srcTag(key)));
    if (!item) {
      throw new TaigaError(
        `attachment target ${key}: no ${type} tagged ${srcTag(key)} on Taiga yet; run \`taigent apply --project ${project.slug} --yes\` first`,
      );
    }
    resolved.set(spec, { type, target: key, objectId: item.id });
  }
  return resolved;
}

/**
 * Reads Taiga and the local files and lists the operations that bring Taiga to docs.yaml. File paths in
 * the plan are relative to `cwd`.
 */
export async function planUpload(docs: Docs, backlog: Backlog | undefined, project: PlanProject, client: TaigaClient, cwd: string): Promise<UploadPlan> {
  const operations: UploadOperation[] = [];
  /** Wiki page id by slug; null when this upload creates the page. */
  const wikiIds = new Map<string, number | null>();

  for (const page of docs.wiki) {
    const file = relative(cwd, page.file);
    const [content, remote] = await Promise.all([readFile(page.file, 'utf8'), client.findWikiPage(project.id, page.slug)]);
    wikiIds.set(page.slug, remote?.id ?? null);
    if (!remote) operations.push({ action: 'create', type: 'wiki', slug: page.slug, file });
    else if (remote.content !== content) operations.push({ action: 'update', type: 'wiki', slug: page.slug, file, id: remote.id, version: remote.version });
    else operations.push({ action: 'skip', type: 'wiki', slug: page.slug, file, id: remote.id });
  }

  const targets = await resolveTargets(docs.attachments, backlog, project, client, wikiIds);
  for (const spec of docs.attachments) {
    const { type, target, objectId } = targets.get(spec)!;
    const name = basename(spec.file);
    const { size, sha1 } = await fileDigest(spec.file);
    const fields: AttachmentFields = { target, targetType: type, objectId, name, file: relative(cwd, spec.file), size, sha1, description: spec.description };
    const existing = objectId === null ? [] : (await client.listAttachments(ENDPOINTS[type], project.id, objectId)).filter((a) => a.name === name);
    const same = existing.find((a) => a.size === size && a.sha1 === sha1);
    if (same) operations.push({ action: 'skip', type: 'attachment', id: same.id, ...fields });
    else operations.push({ action: 'create', type: 'attachment', previous: existing.map(({ id, size, sha1 }) => ({ id, size, sha1 })), ...fields });
  }

  const summary = { create: 0, update: 0, skip: 0 };
  for (const op of operations) summary[op.action] += 1;
  return { project, changes: summary.create + summary.update > 0, summary, operations };
}

/** Human-readable description of one operation, shared by the plan and the report. */
export function describeUploadOperation(op: UploadOperation): string {
  if (op.type === 'wiki') {
    if (op.action === 'create') return `create wiki page ${op.slug}  (${op.file})`;
    if (op.action === 'update') return `update wiki page ${op.slug}  (id ${op.id}, from ${op.file})`;
    return `wiki page ${op.slug}  (id ${op.id}, unchanged)`;
  }
  const where = `${op.name} -> ${op.targetType} ${op.target}`;
  if (op.action === 'skip') return `${where}  (attachment id ${op.id}, same name, size and sha1)`;
  const kept = op.previous.map((p) => `id ${p.id}`).join(', ');
  return `upload ${where}  (${op.size} bytes${kept ? `; changed file: the previous attachment (${kept}) stays on Taiga` : ''})`;
}

/** Runs the plan in order and stops at the first error, naming the operation. Paths resolve against `cwd`. */
export async function executeUpload(plan: UploadPlan, client: TaigaClient, cwd: string): Promise<UploadReport> {
  const wikiIds = new Map<string, number>();
  const operations: UploadReport['operations'] = [];
  const summary: Record<UploadResult, number> = { created: 0, updated: 0, unchanged: 0 };

  for (const op of plan.operations) {
    const result: UploadResult = op.action === 'create' ? 'created' : op.action === 'update' ? 'updated' : 'unchanged';
    const file = resolve(cwd, op.file);
    let id: number;
    try {
      if (op.type === 'wiki') {
        if (op.action === 'create') id = (await client.createWikiPage({ project: plan.project.id, slug: op.slug, content: await readFile(file, 'utf8') })).id;
        else if (op.action === 'update') id = (await client.updateWikiPage(op.id, await readFile(file, 'utf8'), op.version)).id;
        else id = op.id;
        wikiIds.set(op.slug, id);
      } else if (op.action === 'skip') {
        id = op.id;
      } else {
        const objectId = op.objectId ?? wikiIds.get(op.target.slice(WIKI_TARGET_PREFIX.length))!;
        const attachment = { project: plan.project.id, object_id: objectId, file, name: op.name, description: op.description };
        id = (await client.uploadAttachment(ENDPOINTS[op.targetType], attachment)).id;
      }
    } catch (error) {
      if (!(error instanceof TaigaError)) throw error;
      const what = describeUploadOperation(op);
      if (error instanceof TaigaConflictError && op.type === 'wiki') {
        throw new ApplyConflictError(
          `${WIKI_TARGET_PREFIX}${op.slug}`,
          `${what}: version conflict, wiki page ${op.slug} was changed on Taiga by someone else after it was read; nothing was overwritten. Re-run upload --dry-run to review.`,
        );
      }
      if (error.status === 413 && op.type === 'attachment') {
        throw new UploadTooLargeError(
          op.file,
          `${op.file} (${op.size} bytes) is too large for the Taiga server (HTTP 413 Request Entity Too Large) uploading it to ` +
            `${op.targetType} ${op.target}; raise the server's upload limit (e.g. nginx client_max_body_size) or attach a smaller file`,
        );
      }
      throw new TaigaError(`${what} failed: ${error.message}`, error.status);
    }
    operations.push({ ...op, id, result });
    summary[result] += 1;
  }
  return { project: plan.project, operations, summary };
}
