// Backlog writes of `adopt` and `pull`: adds items to, and edits or moves items in, `taiga/<slug>/backlog.yaml`. Every
// write names the digest of the file it started from and is refused when the file changed since (a person or an agent
// edited it). Edits go through yaml's Document API, so comments, order and the style of the nodes they do not touch
// stay as written. Before writing, the result goes through the loader `validate` runs; only issues under a written
// item block it. Offline, and it never touches review.yaml: an edited item's verdict turns stale through its digest.
//
// Item kinds live in `KINDS` (where the item sits, its canonical field order).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { type Document, isCollection, isMap, isNode, isScalar, isSeq, parse, parseDocument, visit, type YAMLMap, type YAMLSeq } from 'yaml';
import { sha256, writeAtomic } from './files.ts';
import { isFileNotFound } from './guards.ts';
import { ITEM_TYPES, type ItemType } from './items.ts';
import { type AttributeValue, BACKLOG_FILE, checkBacklog, type Scenario, type UseCase } from './manifest/backlog.ts';
import { checkKey, type IssueSink } from './manifest/conventions.ts';
import { ManifestError, type ManifestIssue } from './manifest/errors.ts';

/** backlog.yaml as read: absolute path, content (empty when the file does not exist) and SHA-256 (hex) of it. */
export interface BacklogFile {
  file: string;
  text: string;
  digest: string;
}

/**
 * Fields of a backlog item, named like the loaded `ItemSpec`. In a save, an absent field stays as it is in the
 * manifest and an empty one (`''`, `[]`, `{}`) is removed from it.
 */
export interface ItemFields {
  /** Taiga ref of the hand-made item the backlog item adopts (`taigent adopt` sets it). */
  ref?: number;
  subject?: string;
  description?: string;
  tags?: string[];
  customAttributes?: Record<string, AttributeValue>;
}

/**
 * Story fields. Setting `useCase` or `scenarios` removes `acceptance_criteria` (user story format); setting
 * `acceptanceCriteria` removes `use_case` and `scenarios` (legacy format).
 */
export interface StoryFields extends ItemFields {
  spec?: string;
  useCase?: UseCase;
  scenarios?: Scenario[];
  acceptanceCriteria?: string[];
}

/** Issue fields: `type`, `severity` and `priority` name the project's own values on Taiga (plan checks them). */
export interface IssueFields extends ItemFields {
  type?: string;
  severity?: string;
  priority?: string;
}

/** An item as it is saved: stories and tasks name the key of their parent (epic, story); issues have none. */
export type BacklogItem =
  | { type: 'epic'; key: string; fields: ItemFields }
  | { type: 'story'; key: string; parent: string; fields: StoryFields }
  | { type: 'task'; key: string; parent: string; fields: ItemFields }
  | { type: 'issue'; key: string; fields: IssueFields };

export interface SaveItemRequest {
  /** `digest` of the backlog.yaml the caller read. */
  baseDigest: string;
  /** Edit the item `item.key` of type `item.type` (a parent different from its current one moves it); absent to add it. */
  edit?: boolean;
  item: BacklogItem;
}

/** Several item writes at once: all of them, or none when one is invalid. */
export interface SaveItemsRequest {
  baseDigest: string;
  items: Omit<SaveItemRequest, 'baseDigest'>[];
}

/**
 * Outcome of a write. `conflict`: the file is no longer the one `baseDigest` names, `current` is what it holds now;
 * `invalid`: the write breaks a rule under a written item (or names a missing item, `key-reference`). In both cases
 * nothing was written.
 */
export type SaveResult<T extends object> =
  | ({ status: 'saved'; digest: string } & T)
  | { status: 'conflict'; current: BacklogFile }
  | { status: 'invalid'; issues: ManifestIssue[] };

/**
 * A command (`adopt`, `pull`) read backlog.yaml before reading Taiga, and the file changed before it wrote it (a person
 * or an agent edited it). Nothing was written; running the command again starts from the current file.
 */
export class ManifestChangedError extends Error {}

interface ItemKind {
  /** The list that holds items of this kind, in their parent item (or at the top of the file). */
  list: string;
  parent?: ItemType;
  child?: ItemType;
  /** Canonical field order: a field the write adds goes before the first present field that comes after it. */
  order: readonly string[];
}

const KINDS: Record<ItemType, ItemKind> = {
  epic: { list: 'epics', child: 'story', order: ['key', 'ref', 'subject', 'description', 'tags', 'custom_attributes', 'stories'] },
  story: {
    list: 'stories',
    parent: 'epic',
    child: 'task',
    order: ['key', 'ref', 'subject', 'use_case', 'scenarios', 'acceptance_criteria', 'description', 'spec', 'tags', 'custom_attributes', 'tasks'],
  },
  task: { list: 'tasks', parent: 'story', order: ['key', 'ref', 'subject', 'description', 'tags', 'custom_attributes'] },
  issue: { list: 'issues', order: ['key', 'ref', 'subject', 'description', 'type', 'severity', 'priority', 'tags', 'custom_attributes'] },
};

/** Top-level fields of backlog.yaml, in order. */
const ROOT_ORDER = ['epics', 'issues'];

/** What `open` says when backlog.yaml is not a mapping, as its loader does. */
const NOT_A_MAPPING = 'backlog must be a mapping with an `epics` list and optional `issues` list';

/** Manifest field name of each input field. */
const FIELD_NAMES: Record<string, string> = {
  ref: 'ref',
  subject: 'subject',
  description: 'description',
  tags: 'tags',
  customAttributes: 'custom_attributes',
  spec: 'spec',
  useCase: 'use_case',
  scenarios: 'scenarios',
  acceptanceCriteria: 'acceptance_criteria',
  type: 'type',
  severity: 'severity',
  priority: 'priority',
};

/** Reads backlog.yaml of the project directory `dir` (empty when it does not exist), with the digest a later write is checked against. */
export async function readBacklogFile(dir: string): Promise<BacklogFile> {
  const file = join(dir, BACKLOG_FILE);
  let text = '';
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (!isFileNotFound(error)) throw error;
  }
  return { file, text, digest: sha256(text) };
}

// ---- Document -----------------------------------------------------------------------------------

/** One item found in the document: its map node, the list holding it and its manifest path (`epics[0].stories[1]`). */
interface Entry {
  type: ItemType;
  key: unknown;
  node: YAMLMap;
  list: YAMLSeq;
  /** The map holding `list`: the parent item's node, or the document root. */
  owner: YAMLMap;
  path: string;
  parent?: Entry;
}

function entries(root: YAMLMap): Entry[] {
  const found: Entry[] = [];
  const visitList = (owner: YAMLMap, type: ItemType, at: string, parent?: Entry): void => {
    const list = owner.get(KINDS[type].list, true);
    if (!isSeq(list)) return;
    list.items.forEach((node, i) => {
      if (!isMap(node)) return;
      const entry: Entry = { type, key: node.get('key'), node, list, owner, path: `${at}${KINDS[type].list}[${i}]`, ...(parent && { parent }) };
      found.push(entry);
      const child = KINDS[type].child;
      if (child) visitList(node, child, `${entry.path}.`, entry);
    });
  };
  for (const type of ITEM_TYPES) if (!KINDS[type].parent) visitList(root, type, '');
  return found;
}

/** Adds `name: value` to `map` at its place in `order` (at the end when no later field is present). */
function insertField(doc: Document, map: YAMLMap, order: readonly string[], name: string, value: unknown): void {
  const rank = order.indexOf(name);
  const pair = doc.createPair(name, value);
  const before = map.items.findIndex((other) => order.indexOf(String(isScalar(other.key) ? other.key.value : other.key)) > rank);
  if (before === -1) map.items.push(pair);
  else map.items.splice(before, 0, pair);
}

function isEmptyValue(value: unknown): boolean {
  if (value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === 'object' && value !== null && Object.keys(value).length === 0;
}

/** Inner padding (`' '` or `''`) of each flow collection, as written in the source or carried over by `setField`. */
const FLOW_PADDING = new WeakMap<YAMLSeq | YAMLMap, string>();

function recordPadding(doc: Document, source: string): void {
  const record = (node: YAMLSeq | YAMLMap) => {
    if (node.flow && node.range) FLOW_PADDING.set(node, source[node.range[0] + 1] === ' ' ? ' ' : '');
  };
  visit(doc, { Seq: (_, node) => record(node), Map: (_, node) => record(node) });
}

/** Sets one field, keeping the node (style, comments) when the value is unchanged or stays a one-line scalar. */
function setField(doc: Document, map: YAMLMap, order: readonly string[], name: string, value: unknown): void {
  const current = map.get(name, true);
  if (isEmptyValue(value)) {
    map.delete(name);
    return;
  }
  if (current === undefined) {
    insertField(doc, map, order, name, value);
    return;
  }
  if (isDeepStrictEqual(isNode(current) ? current.toJSON() : current, value)) return;
  if (isScalar(current) && typeof value !== 'object' && !(typeof value === 'string' && value.includes('\n'))) {
    current.value = value;
    return;
  }
  const node = doc.createNode(value);
  if (isCollection(current) && isCollection(node)) {
    node.flow = current.flow;
    node.comment = current.comment;
    const padding = FLOW_PADDING.get(current);
    if (padding !== undefined) FLOW_PADDING.set(node, padding);
  }
  map.set(name, node);
}

function manifestValue(field: string, value: unknown): unknown {
  if (field !== 'useCase') return value;
  const useCase = value as UseCase;
  return { as_a: useCase.asA, i_want_to: useCase.iWantTo, so_that: useCase.soThat };
}

function applyFields(doc: Document, map: YAMLMap, item: BacklogItem): void {
  const { order } = KINDS[item.type];
  for (const [field, value] of Object.entries(item.fields)) {
    const name = FIELD_NAMES[field];
    if (name === undefined || value === undefined) continue;
    setField(doc, map, order, name, manifestValue(field, value));
  }
  if (item.type !== 'story') return;
  const { useCase, scenarios, acceptanceCriteria } = item.fields;
  if (useCase !== undefined || scenarios !== undefined) map.delete('acceptance_criteria');
  if (acceptanceCriteria !== undefined) {
    map.delete('use_case');
    map.delete('scenarios');
  }
}

/**
 * Removes `entry` from its list, and the list from its owner when it is left empty. yaml keeps a comment above the
 * first item on the list: it goes with the item.
 */
function detach(entry: Entry): void {
  const { list, node } = entry;
  const index = list.items.indexOf(node);
  if (index === 0 && list.commentBefore) {
    node.commentBefore = node.commentBefore ? `${list.commentBefore}\n${node.commentBefore}` : list.commentBefore;
    list.commentBefore = undefined;
  }
  list.items.splice(index, 1);
  if (list.items.length === 0) entry.owner.delete(KINDS[entry.type].list);
}

function append(doc: Document, owner: YAMLMap, ownerOrder: readonly string[], type: ItemType, node: YAMLMap): void {
  const name = KINDS[type].list;
  const list = owner.get(name, true);
  if (isSeq(list)) list.items.push(node);
  else insertField(doc, owner, ownerOrder, name, doc.createNode([node]));
}

/**
 * The document as text, styled like `source`: its indentation, sequence indentation, line ends, and each flow
 * collection's inner padding (`[a, b]` or `{ a: 1 }`, an option yaml otherwise applies to the whole file).
 */
function render(doc: Document, source: string): string {
  const keepPadding = (node: YAMLSeq | YAMLMap) => {
    const padding = FLOW_PADDING.get(node);
    if (padding === undefined) return;
    const toString = node.toString.bind(node);
    // yaml reads the padding from the stringify context; give this collection its own.
    node.toString = (ctx, ...rest) => toString(ctx && { ...ctx, flowCollectionPadding: padding }, ...rest);
  };
  visit(doc, { Seq: (_, node) => keepPadding(node), Map: (_, node) => keepPadding(node) });
  const indent = Math.min(...source.split(/\r?\n/).map((line) => /^( +)[^\s#]/.exec(line)?.[1]!.length ?? Infinity));
  const text = doc.toString({
    lineWidth: 0,
    indent: Number.isFinite(indent) ? indent : 2,
    indentSeq: !/^( *)[^\s#-][^\r\n]*:[ \t]*\r?\n\1- /m.test(source),
  });
  return source.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text;
}

// ---- Writes -------------------------------------------------------------------------------------

type Opened =
  | { ok: true; manifest: BacklogFile; doc: Document; root: YAMLMap }
  | { ok: false; result: SaveResult<never> };

/** Reads backlog.yaml, refusing a stale `baseDigest`, and parses it into an editable document. */
async function open(dir: string, baseDigest: string): Promise<Opened> {
  const current = await readBacklogFile(dir);
  if (current.digest !== baseDigest) return { ok: false, result: { status: 'conflict', current } };
  // Widened from Document.Parsed: the write adds nodes that were never parsed.
  const doc: Document = parseDocument(current.text);
  const invalid = (rule: string, message: string): Opened => ({ ok: false, result: { status: 'invalid', issues: [{ file: current.file, path: '', rule, message }] } });
  if (doc.errors.length > 0) return invalid('yaml-syntax', doc.errors.map((error) => error.message).join('\n'));
  if (doc.contents === null) doc.contents = doc.createNode({});
  if (!isMap(doc.contents)) return invalid('type', NOT_A_MAPPING);
  recordPadding(doc, current.text);
  return { ok: true, manifest: current, doc, root: doc.contents };
}

// Writes of this process run one at a time: a digest check and the write it guards never interleave with another
// write (two quick saves from the same digest), so the second one sees the first and is a conflict.
let writing: Promise<unknown> = Promise.resolve();

function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = writing.then(fn);
  writing = run.catch(() => undefined);
  return run;
}

/** Writes `text` in place of backlog.yaml (atomically), unless the file changed since it was read. Runs in `exclusive`. */
async function replace<T extends object>(dir: string, manifest: BacklogFile, text: string, extra: T): Promise<SaveResult<T>> {
  const current = await readBacklogFile(dir);
  if (current.digest !== manifest.digest) return { status: 'conflict', current };
  await writeAtomic(manifest.file, text);
  return { status: 'saved', digest: sha256(text), ...extra };
}

function missing(file: string, type: ItemType, key: string): SaveResult<never> {
  return { status: 'invalid', issues: [{ file, path: '', rule: 'key-reference', message: `no ${type} with key ${key} in ${BACKLOG_FILE}` }] };
}

/** Whether issue `path` lies under the item at `at`, outside its child items (`stories[…]`, `tasks[…]`). */
function underItem(path: string, at: string, type: ItemType): boolean {
  if (path !== at && !path.startsWith(`${at}.`)) return false;
  const child = KINDS[type].child;
  return !child || !path.startsWith(`${at}.${KINDS[child].list}[`);
}

/** Adds an item, or edits one (fields, parent), in the backlog of the project directory `dir`. `path` is where the item now is in the manifest. */
export async function saveItem(dir: string, request: SaveItemRequest): Promise<SaveResult<{ path: string }>> {
  const saved = await saveItems(dir, { baseDigest: request.baseDigest, items: [request] });
  return saved.status === 'saved' ? { status: 'saved', digest: saved.digest, path: saved.paths[0]! } : saved;
}

/**
 * `saveItem` for several items, in order, written in one go: nothing is written when any of them is invalid. `paths`
 * holds where each item now is in the manifest.
 */
export async function saveItems(dir: string, request: SaveItemsRequest): Promise<SaveResult<{ paths: string[] }>> {
  const opened = await open(dir, request.baseDigest);
  if (!opened.ok) return opened.result;
  const { manifest, doc, root } = opened;
  const issues: ManifestIssue[] = [];
  const issue: IssueSink = (path, rule, message) => issues.push({ file: manifest.file, path, rule, message });
  const nodes: YAMLMap[] = [];

  for (const { item, edit } of request.items) {
    const all = entries(root);
    const kind = KINDS[item.type];
    const existing = edit ? all.find((entry) => entry.type === item.type && entry.key === item.key) : undefined;
    if (edit && !existing) return missing(manifest.file, item.type, item.key);
    const parentKey = 'parent' in item ? item.parent : undefined;
    const parent = kind.parent && all.find((entry) => entry.type === kind.parent && entry.key === parentKey);
    if (kind.parent && !parent) return missing(manifest.file, kind.parent, parentKey ?? '');

    const node = existing?.node ?? doc.createNode({ key: item.key });
    applyFields(doc, node, item);
    if (!existing || existing.parent?.key !== parentKey) {
      if (existing) detach(existing);
      append(doc, parent ? parent.node : root, parent ? KINDS[parent.type].order : ROOT_ORDER, item.type, node);
    }
    nodes.push(node);
  }

  const text = render(doc, manifest.text);
  const placed = entries(root);
  const paths = nodes.map((node) => placed.find((entry) => entry.node === node)!.path);
  try {
    checkBacklog(parse(text), manifest.file);
  } catch (error) {
    if (!(error instanceof ManifestError)) throw error;
    issues.push(...error.issues.filter((found) => request.items.some(({ item }, i) => underItem(found.path, paths[i]!, item.type))));
  }
  // The loader reports a duplicate key on its second use; a written item may be the first one, so written keys are
  // checked last, against every other key.
  const seen = new Map<string, string>();
  for (const entry of placed) if (!nodes.includes(entry.node)) checkKey(entry.key, `${entry.path}.key`, () => {}, seen);
  request.items.forEach(({ item }, i) => {
    checkKey(item.key, `${paths[i]}.key`, (at, rule, message) => {
      if (!issues.some((known) => known.path === at && known.rule === rule)) issue(at, rule, message);
    }, seen);
  });
  if (issues.length > 0) return { status: 'invalid', issues };
  return exclusive(() => replace(dir, manifest, text, { paths }));
}
