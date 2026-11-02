// Review of a backlog before apply: `taiga/<slug>/review.yaml` holds each item's verdict (approved / changes) and
// the comments of the Business Analyst / Product Owner, and `buildPreview` shows the backlog exactly as apply would
// write it, with that review. Offline: no Taiga access. The file is committed with the manifests; Taigent Desktop and
// people write verdicts and comments, the agent answers comments (`resolved` + `reply`) by editing the manifests.

import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';
import { isRecord } from './guards.ts';
import type { ItemType } from './items.ts';
import type { AttributeValue, StorySpec } from './manifest/backlog.ts';
import { checkKeyReference, KEY_PATTERN } from './manifest/conventions.ts';
import { ManifestError, type ManifestIssue } from './manifest/errors.ts';
import { loadManifests } from './manifest/manifests.ts';
import { readState, STATE_FILE } from './manifest/state.ts';
import { readManifestYaml } from './manifest/yaml.ts';
import { storyDescription } from './planner.ts';

export const REVIEW_FILE = 'review.yaml';

export const VERDICTS = ['approved', 'changes'] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface ReviewComment {
  /** `c<n>`, unique within its item. */
  id: string;
  by: string;
  /** ISO 8601 date-time. */
  at: string;
  text: string;
  /** Set by the agent once the manifest addresses the comment. */
  resolved: boolean;
  /** The agent's short answer. */
  reply?: string;
}

export interface ItemReview {
  verdict?: Verdict;
  /** `itemDigest` of the item when the verdict was set; a different digest now makes the verdict stale. */
  digest?: string;
  by?: string;
  at?: string;
  comments: ReviewComment[];
}

export interface Review {
  /** Item key → its review. */
  items: Record<string, ItemReview>;
}

const REVIEW_FIELDS: Record<string, true> = { items: true };
const ITEM_FIELDS: Record<string, true> = { verdict: true, digest: true, by: true, at: true, comments: true };
const COMMENT_FIELDS: Record<string, true> = { id: true, by: true, at: true, text: true, resolved: true, reply: true };

/** ISO 8601 date-time with a time zone, e.g. `2026-11-02T09:30:00.000Z`. */
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

function isDateTime(value: unknown): value is string {
  return typeof value === 'string' && DATE_TIME_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Reads and validates review.yaml at `path`; a missing file is an empty review. With `keys` (the backlog's item keys),
 * an item key not in the backlog is an issue too (rule `key-reference`). Throws ManifestError listing every issue.
 */
export async function loadReview(path: string, keys?: ReadonlySet<string>): Promise<Review> {
  let doc: unknown;
  try {
    doc = await readManifestYaml(path);
  } catch (error) {
    if (error instanceof ManifestError && error.issues.length === 1 && error.issues[0]!.rule === 'file-exists') return { items: {} };
    throw error;
  }
  const issues: ManifestIssue[] = [];
  const issue = (at: string, rule: string, message: string) => issues.push({ file: path, path: at, rule, message });

  if (!isRecord(doc)) {
    issue('', 'type', 'review must be a mapping with an `items` mapping');
    throw new ManifestError(issues);
  }
  for (const field of Object.keys(doc)) {
    if (!Object.hasOwn(REVIEW_FIELDS, field)) issue(field, 'known-field', `unknown review field \`${field}\``);
  }
  const rawItems = doc.items ?? {};
  if (!isRecord(rawItems)) {
    issue('items', 'type', 'must be a mapping of item key to review');
    throw new ManifestError(issues);
  }

  const items: Record<string, ItemReview> = {};
  for (const [key, raw] of Object.entries(rawItems)) {
    const at = `items.${key}`;
    if (!KEY_PATTERN.test(key)) issue(at, 'key-format', `item key ${key} must be uppercase letters/digits in dash-separated groups`);
    else if (keys) checkKeyReference(key, at, issue, keys);
    if (!isRecord(raw)) {
      issue(at, 'type', 'item review must be a mapping');
      continue;
    }
    for (const field of Object.keys(raw)) {
      if (!Object.hasOwn(ITEM_FIELDS, field)) issue(`${at}.${field}`, 'known-field', `unknown item review field \`${field}\``);
    }
    const { verdict, digest, by, at: when, comments: rawComments = [] } = raw;
    const item: ItemReview = { comments: [] };
    if (verdict !== undefined) {
      if (!VERDICTS.includes(verdict as Verdict)) issue(`${at}.verdict`, 'review-verdict', `verdict must be one of: ${VERDICTS.join(', ')}`);
      else item.verdict = verdict as Verdict;
      if (typeof digest !== 'string' || digest === '') issue(`${at}.digest`, 'required', 'a verdict needs the digest of the item it was given on');
    }
    if (digest !== undefined) {
      if (typeof digest !== 'string') issue(`${at}.digest`, 'type', 'must be a string');
      else item.digest = digest;
    }
    if (by !== undefined) {
      if (!isText(by)) issue(`${at}.by`, 'type', 'must be a non-empty string');
      else item.by = by;
    }
    if (when !== undefined) {
      if (!isDateTime(when)) issue(`${at}.at`, 'type', 'must be an ISO 8601 date-time, e.g. 2026-11-02T09:30:00Z');
      else item.at = when;
    }
    if (!Array.isArray(rawComments)) {
      issue(`${at}.comments`, 'type', 'must be a list');
    } else {
      const ids = new Map<string, string>();
      rawComments.forEach((rawComment: unknown, index) => {
        const cat = `${at}.comments[${index}]`;
        if (!isRecord(rawComment)) {
          issue(cat, 'type', 'comment must be a mapping');
          return;
        }
        for (const field of Object.keys(rawComment)) {
          if (!Object.hasOwn(COMMENT_FIELDS, field)) issue(`${cat}.${field}`, 'known-field', `unknown comment field \`${field}\``);
        }
        const { id, by: author, at: written, text, resolved = false, reply } = rawComment;
        if (!isText(id)) issue(`${cat}.id`, 'required', 'id is required');
        else {
          const first = ids.get(id);
          if (first !== undefined) issue(`${cat}.id`, 'review-comment-unique', `duplicate comment id ${id} (first used at ${first})`);
          else ids.set(id, `${cat}.id`);
        }
        if (!isText(author)) issue(`${cat}.by`, 'required', 'by is required');
        if (!isDateTime(written)) issue(`${cat}.at`, 'type', 'must be an ISO 8601 date-time, e.g. 2026-11-02T09:30:00Z');
        if (!isText(text)) issue(`${cat}.text`, 'required', 'text is required');
        if (typeof resolved !== 'boolean') issue(`${cat}.resolved`, 'type', 'must be true or false');
        if (reply !== undefined && typeof reply !== 'string') issue(`${cat}.reply`, 'type', 'must be a string');
        item.comments.push({
          id: id as string,
          by: author as string,
          at: written as string,
          text: text as string,
          resolved: resolved as boolean,
          ...(typeof reply === 'string' && { reply }),
        });
      });
    }
    items[key] = item;
  }
  if (issues.length > 0) throw new ManifestError(issues);
  return { items };
}

/**
 * Writes review.yaml atomically with sorted keys and a fixed field order, so diffs stay stable. Items with neither a
 * verdict nor a comment are dropped.
 */
export async function saveReview(path: string, review: Review): Promise<void> {
  const items: Record<string, unknown> = {};
  for (const key of Object.keys(review.items).sort()) {
    const { verdict, digest, by, at, comments } = review.items[key]!;
    if (verdict === undefined && comments.length === 0) continue;
    items[key] = {
      ...(verdict !== undefined && { verdict, digest, ...(by !== undefined && { by }), ...(at !== undefined && { at }) }),
      ...(comments.length > 0 && {
        comments: comments.map(({ id, by, at, text, resolved, reply }) => ({ id, by, at, text, resolved, ...(reply !== undefined && { reply }) })),
      }),
    };
  }
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, stringify({ items }, { lineWidth: 0 }));
  await rename(temp, path);
}

/** Sets (or, with `verdict` undefined, clears) the verdict of item `key`, recording the digest it was given on. Pure. */
export function setVerdict(review: Review, key: string, verdict: Verdict | undefined, digest: string, by: string, at: string): Review {
  const comments = review.items[key]?.comments ?? [];
  const item: ItemReview = verdict === undefined ? { comments } : { verdict, digest, by, at, comments };
  return { items: { ...review.items, [key]: item } };
}

/** Adds an open comment to item `key` with the next free id `c<n>`. Pure. */
export function addComment(review: Review, key: string, text: string, by: string, at: string): Review {
  const current = review.items[key] ?? { comments: [] };
  const used = new Set(current.comments.map((comment) => comment.id));
  let n = 1 + Math.max(0, ...current.comments.map((comment) => Number(/^c(\d+)$/.exec(comment.id)?.[1] ?? 0)));
  while (used.has(`c${n}`)) n++;
  const comment: ReviewComment = { id: `c${n}`, by, at, text, resolved: false };
  return { items: { ...review.items, [key]: { ...current, comments: [...current.comments, comment] } } };
}

// ---- Preview ------------------------------------------------------------------------------------

export interface PreviewItem {
  type: ItemType;
  key: string;
  subject: string;
  /** Exactly the description apply writes to Taiga (a story's includes its acceptance criteria and spec link). */
  description: string;
  /** Tags as written in the manifest (apply also adds `src:<key>`). */
  tags: string[];
  customAttributes: Record<string, AttributeValue>;
  /** Key of the epic (story) or story (task) the item belongs to; absent for epics. */
  parent?: string;
  /** Id/ref on Taiga, from state.json; absent while the item is new. */
  applied?: { id: number; ref: number };
  /** `itemDigest` of this item. */
  digest: string;
  review: {
    verdict?: Verdict;
    /** A verdict is set but the item changed since (its digest differs). */
    stale: boolean;
    by?: string;
    at?: string;
    comments: ReviewComment[];
    openComments: number;
  };
}

export interface PreviewStory extends PreviewItem {
  type: 'story';
  /** `legacy` stories are only allowed when already on Taiga; plan/apply refuse to create them. */
  format: StorySpec['format'];
  spec: string;
  tasks: PreviewItem[];
}

export interface PreviewEpic extends PreviewItem {
  type: 'epic';
  stories: PreviewStory[];
}

export interface PreviewSummary {
  epics: number;
  stories: number;
  tasks: number;
  /** Items not in state.json yet. */
  new: number;
  applied: number;
  /** Non-stale verdicts; a stale verdict counts in `stale` only. approved + changes + unreviewed + stale = items. */
  approved: number;
  changes: number;
  unreviewed: number;
  stale: number;
  openComments: number;
  /** Keys in review.yaml that the backlog does not declare (their reviews are not shown). */
  unknownReviewKeys: string[];
}

export interface Preview {
  project: { slug: string; name?: string };
  summary: PreviewSummary;
  epics: PreviewEpic[];
}

/** What apply writes for an item, the input of `itemDigest`. */
export type DigestFields = Pick<PreviewItem, 'subject' | 'description' | 'tags' | 'customAttributes' | 'parent'>;

/**
 * SHA-256 (hex) of what apply writes for an item: subject, description as written, tags (lowercased like Taiga,
 * order-insensitive), custom attributes and parent key. Review and Taiga ids are not part of it.
 */
export function itemDigest(item: DigestFields): string {
  const attributes: Record<string, AttributeValue> = {};
  for (const name of Object.keys(item.customAttributes).sort()) attributes[name] = item.customAttributes[name]!;
  const canonical = JSON.stringify({
    subject: item.subject,
    description: item.description,
    tags: [...new Set(item.tags.map((tag) => tag.toLowerCase()))].sort(),
    customAttributes: attributes,
    parent: item.parent ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * The backlog of project `slug` (manifests in `dir`, backlog.yaml required) as apply would write it, with each item's
 * Taiga id from state.json and its review from review.yaml. Offline.
 */
export async function buildPreview(dir: string, slug: string): Promise<Preview> {
  const { manifests } = await loadManifests(dir, slug, { require: ['backlog'] });
  const backlog = manifests.backlog!;
  const state = await readState(join(dir, STATE_FILE), { id: 0, slug });
  const review = await loadReview(join(dir, REVIEW_FILE));

  const summary: PreviewSummary = {
    epics: 0, stories: 0, tasks: 0, new: 0, applied: 0, approved: 0, changes: 0, unreviewed: 0, stale: 0, openComments: 0, unknownReviewKeys: [],
  };
  const keys = new Set<string>();

  function previewItem<T extends ItemType>(
    type: T,
    spec: { key: string; subject: string; tags: string[]; customAttributes: Record<string, AttributeValue> },
    description: string,
    parent?: string,
  ): PreviewItem & { type: T } {
    keys.add(spec.key);
    const fields: DigestFields = {
      subject: spec.subject,
      description,
      tags: [...spec.tags],
      customAttributes: { ...spec.customAttributes },
      ...(parent !== undefined && { parent }),
    };
    const digest = itemDigest(fields);
    const entry = state.items[spec.key];
    const applied = entry && entry.type === type ? { id: entry.id, ref: entry.ref } : undefined;
    const itemReview = review.items[spec.key];
    const comments = itemReview?.comments ?? [];
    const verdict = itemReview?.verdict;
    const stale = verdict !== undefined && itemReview!.digest !== digest;
    const openComments = comments.filter((comment) => !comment.resolved).length;

    summary[applied ? 'applied' : 'new']++;
    if (verdict === undefined) summary.unreviewed++;
    else if (stale) summary.stale++;
    else summary[verdict]++;
    summary.openComments += openComments;

    return {
      type,
      key: spec.key,
      ...fields,
      ...(applied && { applied }),
      digest,
      review: {
        ...(verdict !== undefined && { verdict }),
        stale,
        ...(verdict !== undefined && itemReview!.by !== undefined && { by: itemReview!.by }),
        ...(verdict !== undefined && itemReview!.at !== undefined && { at: itemReview!.at }),
        comments,
        openComments,
      },
    };
  }

  const epics: PreviewEpic[] = backlog.epics.map((epic) => {
    summary.epics++;
    const item = previewItem('epic', epic, epic.description);
    const stories = epic.stories.map((story): PreviewStory => {
      summary.stories++;
      const storyItem = previewItem('story', story, storyDescription(story), epic.key);
      const tasks = story.tasks.map((task) => {
        summary.tasks++;
        return previewItem('task', task, task.description, story.key);
      });
      return { ...storyItem, format: story.format, spec: story.spec, tasks };
    });
    return { ...item, stories };
  });
  summary.unknownReviewKeys = Object.keys(review.items).filter((key) => !keys.has(key)).sort();

  const name = manifests.project?.name;
  return { project: { slug, ...(name !== undefined && { name }) }, summary, epics };
}

// ---- Markdown -----------------------------------------------------------------------------------

/**
 * `markdown` nested under a heading of `level`: its headings shift so the outermost becomes `level + 1`, keeping their
 * relative depth (fenced code untouched).
 */
function nestHeadings(markdown: string, level: number): string {
  let fence: string | undefined;
  const lines = markdown.split('\n').map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (fence === undefined) fence = marker[0]!.repeat(3);
      else if (marker.startsWith(fence)) fence = undefined;
      return { line };
    }
    const depth = fence === undefined ? /^(#{1,6})(?=\s|$)/.exec(line)?.[1]!.length : undefined;
    return { line, depth };
  });
  const outermost = Math.min(...lines.flatMap(({ depth }) => (depth === undefined ? [] : [depth])));
  const shift = level + 1 - outermost;
  return lines
    .map(({ line, depth }) => (depth === undefined ? line : `${'#'.repeat(Math.min(6, depth + shift))}${line.slice(depth)}`))
    .join('\n');
}

/** `2026-11-02T09:30:00Z` → `2026-11-02 09:30`. */
function shortTime(at: string): string {
  return at.slice(0, 16).replace('T', ' ');
}

const TYPE_LABEL: Record<ItemType, string> = { epic: 'Epic', story: 'Story', task: 'Task' };

function renderItem(item: PreviewItem, level: number): string[] {
  const lines = [`${'#'.repeat(level)} ${TYPE_LABEL[item.type]} ${item.key}: ${item.subject}`, ''];
  const facts = [item.applied ? `on Taiga #${item.applied.ref}` : 'new (not on Taiga yet)'];
  if (item.tags.length > 0) facts.push(`tags: ${item.tags.map((tag) => `\`${tag}\``).join(', ')}`);
  const attributes = Object.entries(item.customAttributes);
  if (attributes.length > 0) facts.push(`custom attributes: ${attributes.map(([name, value]) => `${name} = ${String(value)}`).join(', ')}`);
  lines.push(facts.join(' · '), '');

  const { verdict, stale, by, at, comments, openComments } = item.review;
  let status = 'not reviewed';
  if (verdict !== undefined) {
    status = verdict === 'approved' ? 'approved' : 'changes requested';
    if (by !== undefined) status += ` by ${by}`;
    if (at !== undefined) status += ` on ${shortTime(at)}`;
    if (stale) status += ' (stale: the item changed since, review it again)';
  }
  lines.push(`**Review:** ${status}`, '');

  if (item.description.trim() !== '') lines.push(nestHeadings(item.description.trimEnd(), level), '');

  if (comments.length > 0) {
    lines.push(`**Comments** (${openComments} open):`, '');
    for (const comment of comments) {
      const text = comment.text.trimEnd().split('\n').join('\n  ');
      lines.push(`- ${comment.resolved ? '[resolved]' : '**[open]**'} ${comment.by}, ${shortTime(comment.at)} (${comment.id}): ${text}`);
      if (comment.reply !== undefined) lines.push(`  - Reply: ${comment.reply.trimEnd().split('\n').join('\n    ')}`);
    }
    lines.push('');
  }
  return lines;
}

/** The whole preview as one Markdown page: a summary table, then each epic → story → task with its review. */
export function renderPreviewMarkdown(preview: Preview): string {
  const { project, summary } = preview;
  const lines = [
    `# Backlog preview: ${project.name ?? project.slug}`,
    '',
    `Project \`${project.slug}\`: what \`taigent apply\` would write to Taiga, with the review in ${REVIEW_FILE}.`,
    '',
    '| Backlog | Count |',
    '| --- | ---: |',
    `| Epics | ${summary.epics} |`,
    `| Stories | ${summary.stories} |`,
    `| Tasks | ${summary.tasks} |`,
    `| New (not on Taiga yet) | ${summary.new} |`,
    `| On Taiga (state.json) | ${summary.applied} |`,
    `| Approved | ${summary.approved} |`,
    `| Changes requested | ${summary.changes} |`,
    `| Not reviewed | ${summary.unreviewed} |`,
    `| Stale review (item changed since) | ${summary.stale} |`,
    `| Open comments | ${summary.openComments} |`,
    '',
  ];
  if (summary.unknownReviewKeys.length > 0) {
    lines.push(`**Warning:** ${REVIEW_FILE} reviews keys the backlog does not declare: ${summary.unknownReviewKeys.join(', ')}`, '');
  }
  if (preview.epics.length === 0) lines.push('_The backlog has no items._', '');
  for (const epic of preview.epics) {
    lines.push(...renderItem(epic, 2));
    for (const story of epic.stories) {
      lines.push(...renderItem(story, 3));
      for (const task of story.tasks) lines.push(...renderItem(task, 4));
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
