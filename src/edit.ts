// Manifest edit API: adds, edits, re-parents and removes backlog items in `taiga/<slug>/backlog.yaml`, the library
// behind Taigent Desktop's forms. Every write names the digest of the file it started from and is refused when the
// file changed since (an agent edited it). Edits go through yaml's Document API, so comments, order and the style of
// the nodes they do not touch stay as written. Before writing, the result goes through the loader `validate` runs;
// only issues under the edited item block it. Offline, and it never touches review.yaml: an edited item's verdict
// turns stale through its digest.
//
// Item kinds live in `KINDS` (where the item sits, its canonical field order) and files in `EDITABLE_FILES`: wiki
// entries (docs.yaml) plug in there.

import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { type Document, isCollection, isMap, isNode, isScalar, isSeq, parse, parseDocument, visit, type YAMLMap, type YAMLSeq } from 'yaml';
import { isFileNotFound } from './guards.ts';
import { ISSUE_VALUE_FIELDS, ITEM_TYPES, type ItemType } from './items.ts';
import { type AttributeValue, BACKLOG_FILE, checkBacklog, type Scenario, type UseCase } from './manifest/backlog.ts';
import { KEY_PATTERN } from './manifest/conventions.ts';
import { ManifestError, type ManifestIssue } from './manifest/errors.ts';
import { readState, STATE_FILE } from './manifest/state.ts';

/** The manifest files the edit API writes, by name. */
export const EDITABLE_FILES = { backlog: BACKLOG_FILE } as const;
export type EditableManifest = keyof typeof EDITABLE_FILES;

/** A manifest file as read: absolute path, content (empty when the file does not exist) and SHA-256 (hex) of it. */
export interface ManifestFile {
  file: string;
  text: string;
  digest: string;
}

/**
 * Fields of a backlog item, named like the loaded `ItemSpec`. In a save, an absent field stays as it is in the
 * manifest and an empty one (`''`, `[]`, `{}`) is removed from it.
 */
export interface ItemFields {
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

/** An item as a form saves it: stories and tasks name the key of their parent (epic, story); issues have none. */
export type BacklogItem =
  | { type: 'epic'; key: string; fields: ItemFields }
  | { type: 'story'; key: string; parent: string; fields: StoryFields }
  | { type: 'task'; key: string; parent: string; fields: ItemFields }
  | { type: 'issue'; key: string; fields: IssueFields };

export interface SaveItemRequest {
  /** `digest` of the file the form was opened on. */
  baseDigest: string;
  /** Key of the item being edited (of type `item.type`); absent to add a new item. */
  original?: string;
  /** The item after the edit: a key or parent different from the original renames or moves it. */
  item: BacklogItem;
}

export interface RemoveItemRequest {
  baseDigest: string;
  type: ItemType;
  key: string;
}

/**
 * Outcome of a write. `conflict`: the file is no longer the one `baseDigest` names, `current` is what it holds now;
 * `invalid`: the edit breaks a rule under the edited item (or names a missing item, `key-reference`, or renames an
 * item already on Taiga, `key-locked`). In both cases nothing was written.
 */
export type EditResult<T extends object> =
  | ({ status: 'saved'; digest: string } & T)
  | { status: 'conflict'; current: ManifestFile }
  | { status: 'invalid'; issues: ManifestIssue[] };

interface ItemKind {
  /** The list that holds items of this kind, in their parent item (or at the top of the file). */
  list: string;
  parent?: ItemType;
  child?: ItemType;
  /** Canonical field order: a field the edit adds goes before the first present field that comes after it. */
  order: readonly string[];
}

const KINDS: Record<ItemType, ItemKind> = {
  epic: { list: 'epics', child: 'story', order: ['key', 'subject', 'description', 'tags', 'custom_attributes', 'stories'] },
  story: {
    list: 'stories',
    parent: 'epic',
    child: 'task',
    order: ['key', 'subject', 'use_case', 'scenarios', 'acceptance_criteria', 'description', 'spec', 'tags', 'custom_attributes', 'tasks'],
  },
  task: { list: 'tasks', parent: 'story', order: ['key', 'subject', 'description', 'tags', 'custom_attributes'] },
  issue: { list: 'issues', order: ['key', 'subject', 'description', 'type', 'severity', 'priority', 'tags', 'custom_attributes'] },
};

/** Top-level fields of backlog.yaml, in order. */
const ROOT_ORDER = ['epics', 'issues'];

/** Manifest field name of each input field. */
const FIELD_NAMES: Record<string, string> = {
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

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Reads one editable manifest of the project directory `dir`, with the digest a later write is checked against. */
export async function readManifestFile(dir: string, manifest: EditableManifest): Promise<ManifestFile> {
  const file = join(dir, EDITABLE_FILES[manifest]);
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

/** Whether `entry` is `ancestor` or below it. */
function within(entry: Entry, ancestor: Entry): boolean {
  for (let current: Entry | undefined = entry; current; current = current.parent) if (current === ancestor) return true;
  return false;
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

// ---- Reads --------------------------------------------------------------------------------------

/** A scalar as form text; a missing value, or one of the wrong shape (validate reports it), reads as empty. */
function scalarText(value: unknown): string {
  return value === undefined || value === null || typeof value === 'object' ? '' : String(value);
}

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(scalarText) : [];
}

function attributeMap(value: unknown): Record<string, AttributeValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, AttributeValue] => ['string', 'number', 'boolean'].includes(typeof entry[1])));
}

/**
 * The item `key` of `type` in the backlog text `text`, with every field its form edits (an absent one empty), so
 * saving it back unchanged changes nothing. A story comes in its own format: `useCase` + `scenarios` (user story
 * format) or `acceptanceCriteria` (legacy). Undefined when there is no such item. Pure.
 */
export function readItem(text: string, type: BacklogItem['type'], key: string): BacklogItem | undefined {
  const root = parseDocument(text).contents;
  if (!isMap(root)) return undefined;
  const entry = entries(root).find((candidate) => candidate.type === type && candidate.key === key);
  if (!entry) return undefined;
  const raw = entry.node.toJSON() as Record<string, unknown>;
  const fields: StoryFields = {
    subject: scalarText(raw.subject),
    description: scalarText(raw.description),
    tags: textList(raw.tags),
    customAttributes: attributeMap(raw.custom_attributes),
  };
  if (type === 'epic') return { type, key, fields };
  if (type === 'issue') {
    const issueFields: IssueFields = fields;
    for (const field of ISSUE_VALUE_FIELDS) issueFields[field] = scalarText(raw[field]);
    return { type, key, fields: issueFields };
  }
  const parent = scalarText(entry.parent?.key);
  if (type === 'task') return { type, key, parent, fields };
  fields.spec = scalarText(raw.spec);
  if (raw.use_case === undefined && raw.scenarios === undefined) {
    fields.acceptanceCriteria = textList(raw.acceptance_criteria);
    return { type, key, parent, fields };
  }
  const useCase = (typeof raw.use_case === 'object' && raw.use_case !== null ? raw.use_case : {}) as Record<string, unknown>;
  fields.useCase = { asA: scalarText(useCase.as_a), iWantTo: scalarText(useCase.i_want_to), soThat: scalarText(useCase.so_that) };
  fields.scenarios = (Array.isArray(raw.scenarios) ? raw.scenarios : []).map((scenario: unknown) => {
    const fieldsOf = (typeof scenario === 'object' && scenario !== null ? scenario : {}) as Record<string, unknown>;
    return { scenario: scalarText(fieldsOf.scenario), given: textList(fieldsOf.given), when: scalarText(fieldsOf.when), then: scalarText(fieldsOf.then) };
  });
  return { type, key, parent, fields };
}

// ---- Writes -------------------------------------------------------------------------------------

type Opened =
  | { ok: true; manifest: ManifestFile; doc: Document; root: YAMLMap }
  | { ok: false; result: EditResult<never> };

/** Reads the file, refusing a stale `baseDigest`, and parses it into an editable document. */
async function open(dir: string, manifest: EditableManifest, baseDigest: string): Promise<Opened> {
  const current = await readManifestFile(dir, manifest);
  if (current.digest !== baseDigest) return { ok: false, result: { status: 'conflict', current } };
  // Widened from Document.Parsed: the edit adds nodes that were never parsed.
  const doc: Document = parseDocument(current.text);
  const invalid = (rule: string, message: string): Opened => ({ ok: false, result: { status: 'invalid', issues: [{ file: current.file, path: '', rule, message }] } });
  if (doc.errors.length > 0) return invalid('yaml-syntax', doc.errors.map((error) => error.message).join('\n'));
  if (doc.contents === null) doc.contents = doc.createNode({});
  if (!isMap(doc.contents)) return invalid('type', 'backlog must be a mapping with an `epics` list and optional `issues` list');
  recordPadding(doc, current.text);
  return { ok: true, manifest: current, doc, root: doc.contents };
}

/** Writes `text` in place of `manifest` (temporary file + rename), unless the file changed since it was read. */
async function write<T extends object>(manifest: ManifestFile, text: string, extra: T): Promise<EditResult<T>> {
  const current = await readFile(manifest.file, 'utf8').catch((error: unknown) => {
    if (isFileNotFound(error)) return '';
    throw error;
  });
  if (sha256(current) !== manifest.digest) return { status: 'conflict', current: { file: manifest.file, text: current, digest: sha256(current) } };
  const temp = `${manifest.file}.tmp`;
  await writeFile(temp, text);
  await rename(temp, manifest.file);
  return { status: 'saved', digest: sha256(text), ...extra };
}

function missing(file: string, type: ItemType, key: string): EditResult<never> {
  return { status: 'invalid', issues: [{ file, path: '', rule: 'key-reference', message: `no ${type} with key ${key} in ${BACKLOG_FILE}` }] };
}

/** Whether issue `path` lies under the item at `at`, outside its child items (`stories[…]`, `tasks[…]`). */
function underItem(path: string, at: string, type: ItemType): boolean {
  if (path !== at && !path.startsWith(`${at}.`)) return false;
  const child = KINDS[type].child;
  return !child || !path.startsWith(`${at}.${KINDS[child].list}[`);
}

/**
 * Adds an item, or edits the item `original` (fields, key, parent), in the backlog of the project directory `dir`.
 * `path` is where the item now is in the manifest.
 */
export async function saveItem(dir: string, request: SaveItemRequest): Promise<EditResult<{ path: string }>> {
  const { item, original } = request;
  const opened = await open(dir, 'backlog', request.baseDigest);
  if (!opened.ok) return opened.result;
  const { manifest, doc, root } = opened;
  const all = entries(root);
  const kind = KINDS[item.type];

  const existing = original === undefined ? undefined : all.find((entry) => entry.type === item.type && entry.key === original);
  if (original !== undefined && !existing) return missing(manifest.file, item.type, original);
  if (existing && item.key !== original) {
    const state = await readState(join(dir, STATE_FILE), { id: 0, slug: '' });
    if (state.items[original!]?.type === item.type) {
      return {
        status: 'invalid',
        issues: [{ file: manifest.file, path: `${existing.path}.key`, rule: 'key-locked', message: `${original} is already on Taiga: changing its key would create a new item and orphan the old one` }],
      };
    }
  }
  const parentKey = 'parent' in item ? item.parent : undefined;
  const parent = kind.parent && all.find((entry) => entry.type === kind.parent && entry.key === parentKey);
  if (kind.parent && !parent) return missing(manifest.file, kind.parent, parentKey ?? '');

  const node = existing?.node ?? doc.createNode({ key: item.key });
  if (existing && item.key !== original) node.set('key', item.key);
  applyFields(doc, node, item);
  if (!existing || existing.parent?.key !== parentKey) {
    if (existing) detach(existing);
    append(doc, parent ? parent.node : root, parent ? KINDS[parent.type].order : ROOT_ORDER, item.type, node);
  }

  const text = render(doc, manifest.text);
  const placed = entries(root);
  const path = placed.find((entry) => entry.node === node)!.path;
  const issues: ManifestIssue[] = [];
  try {
    checkBacklog(parse(text), manifest.file);
  } catch (error) {
    if (!(error instanceof ManifestError)) throw error;
    issues.push(...error.issues.filter((issue) => underItem(issue.path, path, item.type)));
  }
  // The loader reports a duplicate key on its second use; the edited item may be the first one.
  const keyPath = `${path}.key`;
  const twice = KEY_PATTERN.test(item.key) && placed.some((entry) => entry.node !== node && entry.key === item.key);
  if (twice && !issues.some((issue) => issue.path === keyPath && issue.rule === 'key-unique')) {
    issues.push({ file: manifest.file, path: keyPath, rule: 'key-unique', message: `duplicate key ${item.key}` });
  }
  if (issues.length > 0) return { status: 'invalid', issues };
  return write(manifest, text, { path });
}

/**
 * Removes the item `key` of `type` from the backlog of the project directory `dir`, with its child items (a story's
 * tasks, an epic's stories and their tasks). `removed` lists their keys in manifest order, `orphaned` those already
 * on Taiga (state.json): apply never deletes them there, plan reports them as orphans.
 */
export async function removeItem(dir: string, request: RemoveItemRequest): Promise<EditResult<{ removed: string[]; orphaned: string[] }>> {
  const opened = await open(dir, 'backlog', request.baseDigest);
  if (!opened.ok) return opened.result;
  const { manifest, doc, root } = opened;
  const all = entries(root);
  const target = all.find((entry) => entry.type === request.type && entry.key === request.key);
  if (!target) return missing(manifest.file, request.type, request.key);

  const gone = all.filter((entry) => within(entry, target));
  const state = await readState(join(dir, STATE_FILE), { id: 0, slug: '' });
  const removed = gone.map((entry) => String(entry.key));
  const orphaned = gone.filter((entry) => state.items[String(entry.key)]?.type === entry.type).map((entry) => String(entry.key));
  detach(target);
  return write(manifest, render(doc, manifest.text), { removed, orphaned });
}
