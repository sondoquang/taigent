// Manifest module: loads and validates `taiga/<slug>/docs.yaml` (wiki pages + attachments). No network I/O.
// File paths in docs.yaml are relative to the directory of docs.yaml; the loaded Docs holds absolute paths.

import { stat } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { isFileNotFound, isRecord } from '../guards.ts';
import { backlogKeys } from './backlog.ts';
import { checkAttachmentName, checkKeyReference, checkWikiSlug } from './conventions.ts';
import { ManifestError, type ManifestIssue } from './errors.ts';
import type { LoadContext } from './manifests.ts';
import { readManifestYaml } from './yaml.ts';

export const DOCS_FILE = 'docs.yaml';

/** Attachment targets: `wiki:<slug>` for a wiki page, otherwise a backlog key. */
export const WIKI_TARGET_PREFIX = 'wiki:';

/** The wiki page bootstrap creates from project.yaml; attachments may target it without declaring it here. */
export const HOME_WIKI_SLUG = 'home';

export interface WikiPageSpec {
  slug: string;
  /** Absolute path of the Markdown file. */
  file: string;
}

export type AttachmentTarget = { kind: 'item'; key: string } | { kind: 'wiki'; slug: string };

export interface AttachmentSpec {
  target: AttachmentTarget;
  /** Absolute path of the file; its base name is the attachment name on Taiga. */
  file: string;
  description: string;
}

export interface Docs {
  wiki: WikiPageSpec[];
  attachments: AttachmentSpec[];
}

const DOCS_FIELDS: Record<string, true> = { wiki: true, attachments: true };
const WIKI_FIELDS: Record<string, true> = { slug: true, file: true };
const ATTACHMENT_FIELDS: Record<string, true> = { target: true, file: true, description: true };

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (isFileNotFound(error)) return false;
    throw error;
  }
}

/** Reads and validates docs.yaml at `path`; attachment targets are checked against the loaded backlog. */
export async function loadDocs(path: string, context: Pick<LoadContext, 'loaded' | 'invalid'>): Promise<Docs> {
  const doc = await readManifestYaml(path);
  const dir = dirname(path);
  const issues: ManifestIssue[] = [];
  const issue = (at: string, rule: string, message: string) => issues.push({ file: path, path: at, rule, message });

  if (!isRecord(doc)) {
    issue('', 'type', 'docs must be a mapping with `wiki` and/or `attachments` lists');
    throw new ManifestError(issues);
  }
  for (const field of Object.keys(doc)) {
    if (!Object.hasOwn(DOCS_FIELDS, field)) issue(field, 'known-field', `unknown docs field \`${field}\``);
  }
  const lists = { wiki: doc.wiki ?? [], attachments: doc.attachments ?? [] };
  for (const [name, list] of Object.entries(lists)) {
    if (!Array.isArray(list)) issue(name, 'type', 'must be a list');
  }
  if (issues.length > 0) throw new ManifestError(issues);

  /** Checks `file` (relative to docs.yaml) exists; returns its absolute path. */
  const checkFile = async (file: unknown, at: string): Promise<string> => {
    if (typeof file !== 'string' || file === '') {
      issue(at, 'required', 'file is required (path relative to docs.yaml)');
      return '';
    }
    const absolute = resolve(dir, file);
    if (!(await isFile(absolute))) issue(at, 'file-exists', `file not found: ${file}`);
    return absolute;
  };

  const wiki: WikiPageSpec[] = [];
  const wikiSlugs = new Map<string, string>();
  for (const [index, raw] of (lists.wiki as unknown[]).entries()) {
    const at = `wiki[${index}]`;
    if (!isRecord(raw)) {
      issue(at, 'type', 'wiki page must be a mapping');
      continue;
    }
    for (const field of Object.keys(raw)) {
      if (!Object.hasOwn(WIKI_FIELDS, field)) issue(`${at}.${field}`, 'known-field', `unknown wiki page field \`${field}\``);
    }
    const { slug, file } = raw;
    if (checkWikiSlug(slug, `${at}.slug`, issue)) {
      const first = wikiSlugs.get(slug);
      if (first !== undefined) issue(`${at}.slug`, 'wiki-slug-unique', `duplicate wiki slug ${slug} (first used at ${first})`);
      else wikiSlugs.set(slug, `${at}.slug`);
    }
    const absolute = await checkFile(file, `${at}.file`);
    if (typeof file === 'string' && file !== '' && extname(file).toLowerCase() !== '.md') {
      issue(`${at}.file`, 'wiki-file', 'wiki pages are Markdown files (.md)');
    }
    wiki.push({ slug: slug as string, file: absolute });
  }

  // Key references are only meaningful against a valid backlog; an invalid one already reports its issues.
  const checkKeys = !context.invalid.has('backlog');
  const keys = context.loaded.backlog ? backlogKeys(context.loaded.backlog) : new Set<string>();

  const attachments: AttachmentSpec[] = [];
  for (const [index, raw] of (lists.attachments as unknown[]).entries()) {
    const at = `attachments[${index}]`;
    if (!isRecord(raw)) {
      issue(at, 'type', 'attachment must be a mapping');
      continue;
    }
    for (const field of Object.keys(raw)) {
      if (!Object.hasOwn(ATTACHMENT_FIELDS, field)) issue(`${at}.${field}`, 'known-field', `unknown attachment field \`${field}\``);
    }
    const { target, file, description = '' } = raw;
    let parsedTarget: AttachmentTarget = { kind: 'item', key: '' };
    if (typeof target !== 'string' || target === '') {
      issue(`${at}.target`, 'required', `target is required: a backlog key or ${WIKI_TARGET_PREFIX}<slug>`);
    } else if (target.startsWith(WIKI_TARGET_PREFIX)) {
      const slug = target.slice(WIKI_TARGET_PREFIX.length);
      parsedTarget = { kind: 'wiki', slug };
      if (slug !== HOME_WIKI_SLUG && !wikiSlugs.has(slug)) {
        issue(`${at}.target`, 'wiki-reference', `no wiki page with slug ${slug} in docs.yaml`);
      }
    } else {
      parsedTarget = { kind: 'item', key: target };
      if (checkKeys) checkKeyReference(target, `${at}.target`, issue, keys);
    }
    const absolute = await checkFile(file, `${at}.file`);
    if (absolute !== '') checkAttachmentName(basename(absolute), `${at}.file`, issue);
    if (typeof description !== 'string') issue(`${at}.description`, 'type', 'must be a string');
    attachments.push({ target: parsedTarget, file: absolute, description: description as string });
  }

  if (issues.length > 0) throw new ManifestError(issues);
  return { wiki, attachments };
}
