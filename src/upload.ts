// Upload: brings Taiga's wiki pages and attachments to what docs.yaml declares. `readUploadRemote` reads Taiga and
// the local files (hashing attachments as a stream); `planUpload` is pure and derives the operations;
// `executeUpload` runs them. Wiki pages are upserted by slug. Attachments are only ever added: one with the same
// name, size and sha1 already on the target is skipped; a changed file is uploaded again and the old attachment stays.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';
import type { ItemType } from './items.ts';
import type { Backlog } from './manifest/backlog.ts';
import { WIKI_HOME_SLUG } from './manifest/conventions.ts';
import { WIKI_TARGET_PREFIX, type AttachmentSpec, type Docs, type WikiPageSpec } from './manifest/docs.ts';
import { FILL_ACTIONS, RESULT, summarize, tally, type FillAction, type FillResult, type PlanSummary } from './operations.ts';
import { srcTag, type PlanProject } from './planner.ts';
import {
  TaigaConflictError,
  TaigaError,
  type AttachmentTargetType,
  type TaigaAttachment,
  type TaigaClient,
  type TaigaItem,
  type TaigaWikiPage,
} from './taiga/client.ts';

/** The resolved target of an attachment: what it hangs off on Taiga. */
interface ResolvedTarget {
  type: AttachmentTargetType;
  /** As written in docs.yaml: an item key or `wiki:<slug>`. */
  target: string;
  /** Null for a wiki page this upload creates. */
  objectId: number | null;
}

/** What `planUpload` compares docs.yaml with, read by `readUploadRemote`. */
export interface UploadRemote {
  project: PlanProject;
  /** Each docs.yaml page: its local Markdown and the page on Taiga (undefined when missing). */
  pages: ReadonlyMap<WikiPageSpec, { content: string; page: TaigaWikiPage | undefined }>;
  /** Each docs.yaml attachment: its target, its file's size/sha1 and the same-name attachments already there. */
  attachments: ReadonlyMap<AttachmentSpec, ResolvedTarget & { size: number; sha1: string; existing: TaigaAttachment[] }>;
}

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

export interface UploadPlan extends PlanSummary<FillAction> {
  project: PlanProject;
  operations: UploadOperation[];
}

export interface UploadReport {
  project: PlanProject;
  /** `id`: the wiki page, or the attachment (the new one when created). */
  operations: (UploadOperation & { id: number; result: FillResult })[];
  summary: Record<FillResult, number>;
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
): Promise<Map<AttachmentSpec, ResolvedTarget>> {
  const types = backlogTypes(backlog);
  const lists: Partial<Record<ItemType, Promise<TaigaItem[]>>> = {};
  const listItems = (type: ItemType) => (lists[type] ??= client.listItems(type, project.id));

  const resolved = new Map<AttachmentSpec, ResolvedTarget>();
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

/** Reads the project, docs.yaml's pages on Taiga, the attachment targets and what they hold, and the local files. */
export async function readUploadRemote(docs: Docs, backlog: Backlog | undefined, client: TaigaClient, slug: string): Promise<UploadRemote> {
  const detail = await client.getProjectBySlug(slug);
  const project = { id: detail.id, slug: detail.slug };
  const pages = new Map<WikiPageSpec, { content: string; page: TaigaWikiPage | undefined }>();
  /** Wiki page id by slug; null when this upload creates the page. */
  const wikiIds = new Map<string, number | null>();
  for (const spec of docs.wiki) {
    const [content, page] = await Promise.all([readFile(spec.file, 'utf8'), client.findWikiPage(project.id, spec.slug)]);
    pages.set(spec, { content, page });
    wikiIds.set(spec.slug, page?.id ?? null);
  }

  const targets = await resolveTargets(docs.attachments, backlog, project, client, wikiIds);
  const attachments = new Map<AttachmentSpec, ResolvedTarget & { size: number; sha1: string; existing: TaigaAttachment[] }>();
  for (const spec of docs.attachments) {
    const target = targets.get(spec)!;
    const name = basename(spec.file);
    const existing = target.objectId === null ? [] : await client.listAttachments(target.type, project.id, target.objectId);
    attachments.set(spec, { ...target, ...(await fileDigest(spec.file)), existing: existing.filter((a) => a.name === name) });
  }
  return { project, pages, attachments };
}

/** Lists the operations that bring Taiga to docs.yaml. File paths in the plan are relative to `cwd`. */
export function planUpload(docs: Docs, remote: UploadRemote, cwd: string): UploadPlan {
  const operations: UploadOperation[] = [];
  for (const spec of docs.wiki) {
    const file = relative(cwd, spec.file);
    const { content, page } = remote.pages.get(spec)!;
    if (!page) operations.push({ action: 'create', type: 'wiki', slug: spec.slug, file });
    else if (page.content !== content) operations.push({ action: 'update', type: 'wiki', slug: spec.slug, file, id: page.id, version: page.version });
    else operations.push({ action: 'skip', type: 'wiki', slug: spec.slug, file, id: page.id });
  }

  for (const spec of docs.attachments) {
    const { type, target, objectId, size, sha1, existing } = remote.attachments.get(spec)!;
    const fields: AttachmentFields = {
      target,
      targetType: type,
      objectId,
      name: basename(spec.file),
      file: relative(cwd, spec.file),
      size,
      sha1,
      description: spec.description,
    };
    const same = existing.find((a) => a.size === size && a.sha1 === sha1);
    if (same) operations.push({ action: 'skip', type: 'attachment', id: same.id, ...fields });
    else operations.push({ action: 'create', type: 'attachment', previous: existing.map(({ id, size, sha1 }) => ({ id, size, sha1 })), ...fields });
  }

  return { project: remote.project, ...summarize(FILL_ACTIONS, operations), operations };
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

  for (const op of plan.operations) {
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
        id = (await client.uploadAttachment(op.targetType, attachment)).id;
      }
    } catch (error) {
      if (!(error instanceof TaigaError)) throw error;
      const what = describeUploadOperation(op);
      if (error instanceof TaigaConflictError && op.type === 'wiki') {
        throw new TaigaConflictError(
          `${what}: version conflict, wiki page ${op.slug} was changed on Taiga by someone else after it was read; nothing was overwritten. Re-run upload --dry-run to review.`,
          `${WIKI_TARGET_PREFIX}${op.slug}`,
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
    operations.push({ ...op, id, result: RESULT[op.action] });
  }
  return { project: plan.project, operations, summary: tally(FILL_ACTIONS, operations) };
}
