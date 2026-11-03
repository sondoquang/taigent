// The settings of `taiga/<slug>/project.yaml` that Taigent Desktop's project form edits: name, description,
// template, privacy and modules. A save changes only those fields in place (yaml Document API: comments, order and
// the other fields such as tags, custom attributes, members and wiki_home stay as written), refuses to overwrite a
// file changed since the form read it (`baseDigest`), and runs the loader of `taigent validate` on the result first:
// an issue at a form field blocks the save, issues elsewhere do not. Writes are atomic (temporary file + rename).

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Document, isMap, isScalar, isSeq, parse, parseDocument } from 'yaml';
import { sha256, temporaryPath } from './files.ts';
import { errorMessage, isFileNotFound, isRecord } from './guards.ts';
import { PROJECT_SLUG_PATTERN, projectSlug } from './manifest/conventions.ts';
import { ManifestError, type ManifestIssue } from './manifest/errors.ts';
import { loadProject, PROJECT_FILE } from './manifest/project.ts';

/** The form fields of project.yaml. Read leniently: a value of the wrong type reads as empty, `validate` names it. */
export interface ProjectSettings {
  name: string;
  description: string;
  /** `scrum` or `kanban` (PROJECT_TEMPLATES). */
  template: string;
  isPrivate: boolean;
  /** Modules to enable (PROJECT_MODULES). */
  modules: string[];
}

export interface ProjectSettingsFile {
  slug: string;
  /** SHA-256 of project.yaml as read, the `baseDigest` of the next save; null when the file does not exist. */
  digest: string | null;
  /** Null when project.yaml does not exist or is not a YAML mapping. */
  settings: ProjectSettings | null;
  /** What `taigent validate` reports about project.yaml (none when it does not exist). */
  issues: ManifestIssue[];
}

export type SaveProjectSettingsResult =
  | { status: 'saved'; slug: string; digest: string }
  /** project.yaml changed (or appeared) since `baseDigest`: nothing was written. */
  | { status: 'conflict'; current: string | null }
  /** Issues at the form fields: nothing was written. */
  | { status: 'invalid'; issues: ManifestIssue[] };

/** The fields the form owns, as project.yaml keys, in the order of a new file (`slug` is set from the directory). */
const FORM_FIELDS = ['name', 'slug', 'description', 'template', 'is_private', 'modules'] as const;

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isFileNotFound(error)) return null;
    throw error;
  }
}

/** The issues of `path`'s project.yaml as the validate loader reports them (`[]` when valid). */
async function validationIssues(path: string, slug: string): Promise<ManifestIssue[]> {
  try {
    await loadProject(path, slug);
    return [];
  } catch (error) {
    if (error instanceof ManifestError) return error.issues;
    throw error;
  }
}

function settingsOf(raw: unknown): ProjectSettings | null {
  if (!isRecord(raw)) return null;
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  return {
    name: text(raw.name),
    description: text(raw.description),
    template: text(raw.template),
    isPrivate: typeof raw.is_private === 'boolean' ? raw.is_private : true,
    modules: Array.isArray(raw.modules) ? raw.modules.filter((module): module is string => typeof module === 'string') : [],
  };
}

/** Reads `<manifestsRoot>/<slug>/project.yaml` for the form. */
export async function readProjectSettings(manifestsRoot: string, slug: string): Promise<ProjectSettingsFile> {
  const path = join(manifestsRoot, slug, PROJECT_FILE);
  const text = await readText(path);
  if (text === null) return { slug, digest: null, settings: null, issues: [] };
  let raw: unknown;
  try {
    raw = parse(text);
  } catch {
    raw = undefined; // reported by the loader as yaml-syntax
  }
  return { slug, digest: sha256(text), settings: settingsOf(raw), issues: await validationIssues(path, slug) };
}

/** Sets `key` to `value`, keeping the node (and so its comments and style) when it already holds a scalar or a list. */
function setField(doc: Document, key: string, value: string | boolean | string[]): void {
  const node = doc.get(key, true);
  if (isScalar(node) && !Array.isArray(value)) node.value = value;
  else if (isSeq(node) && Array.isArray(value)) node.items = value.map((item) => doc.createNode(item));
  else doc.set(key, value);
}

function atFormField(issue: ManifestIssue): boolean {
  return issue.path === '' || FORM_FIELDS.some((field) => issue.path === field || issue.path.startsWith(`${field}[`) || issue.path.startsWith(`${field}.`));
}

/**
 * Writes `settings` into `<manifestsRoot>/<slug>/project.yaml`. `slug` defaults to the one Taiga derives from the
 * name (a new project); `baseDigest` is the `digest` the form read (null: the file did not exist).
 */
export async function saveProjectSettings(
  manifestsRoot: string,
  settings: ProjectSettings,
  options: { slug?: string; baseDigest: string | null },
): Promise<SaveProjectSettingsResult> {
  const slug = options.slug ?? projectSlug(settings.name);
  const dir = join(manifestsRoot, slug);
  const path = join(dir, PROJECT_FILE);
  if (!PROJECT_SLUG_PATTERN.test(slug)) {
    const message = options.slug === undefined ? `the project name "${settings.name}" gives no project slug` : `"${slug}" is not a project slug`;
    return { status: 'invalid', issues: [{ file: path, path: 'slug', rule: 'project-slug', message }] };
  }

  const text = await readText(path);
  const current = text === null ? null : sha256(text);
  if (current !== options.baseDigest) return { status: 'conflict', current };

  const doc = text === null ? new Document({}) : parseDocument(text);
  if (doc.errors.length > 0) {
    return { status: 'invalid', issues: [{ file: path, path: '', rule: 'yaml-syntax', message: errorMessage(doc.errors[0]) }] };
  }
  if (doc.contents === null) doc.contents = doc.createNode({});
  if (!isMap(doc.contents)) return { status: 'invalid', issues: [{ file: path, path: '', rule: 'type', message: 'project manifest must be a mapping' }] };
  const values: Record<(typeof FORM_FIELDS)[number], string | boolean | string[]> = {
    name: settings.name,
    slug,
    description: settings.description,
    template: settings.template,
    is_private: settings.isPrivate,
    modules: settings.modules,
  };
  for (const field of FORM_FIELDS) setField(doc, field, values[field]);
  const next = doc.toString({ flowCollectionPadding: false });

  const created = await mkdir(dir, { recursive: true });
  // Validated as the temporary file it is written to, then renamed over project.yaml (atomic).
  const temporary = temporaryPath(path);
  await writeFile(temporary, next);
  const blocking = (await validationIssues(temporary, slug)).filter(atFormField);
  if (blocking.length > 0) {
    await rm(created ?? temporary, { recursive: true, force: true });
    return { status: 'invalid', issues: blocking.map((issue) => ({ ...issue, file: path })) };
  }
  await rename(temporary, path);
  return { status: 'saved', slug, digest: sha256(next) };
}
