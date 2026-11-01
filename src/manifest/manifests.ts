// Registry of the manifests a project directory may hold, in load order. `validate` checks every manifest
// that exists; plan/apply/bootstrap/upload load the same way and additionally require the ones they apply.
// A new manifest kind plugs in by adding its type to `Manifests` and one entry to `MANIFESTS`; later
// entries may cross-check earlier ones through `LoadContext` (e.g. references to backlog keys).

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isFileNotFound } from '../guards.ts';
import { BACKLOG_FILE, loadBacklog, type Backlog } from './backlog.ts';
import { ManifestError, type ManifestIssue } from './errors.ts';
import { loadProject, PROJECT_FILE, type ProjectManifest } from './project.ts';

/** Validated manifests of one project; a kind is absent when its file does not exist or is invalid. */
export interface Manifests {
  project?: ProjectManifest;
  backlog?: Backlog;
}

export type ManifestKind = keyof Manifests;

export interface LoadContext {
  /** Project slug = name of the manifest directory. */
  slug: string;
  /** Manifests loaded (and valid) so far, in `MANIFESTS` order. */
  loaded: Manifests;
  /** Kinds whose file exists but is invalid; dependants should skip cross-checks against them. */
  invalid: ReadonlySet<ManifestKind>;
}

export interface ManifestEntry<K extends ManifestKind> {
  kind: K;
  file: string;
  /** Reads and validates the file at `path`; throws ManifestError listing every issue. */
  load(path: string, context: LoadContext): Promise<NonNullable<Manifests[K]>>;
}

type AnyManifestEntry = { [K in ManifestKind]: ManifestEntry<K> }[ManifestKind];

export const MANIFESTS: readonly AnyManifestEntry[] = [
  { kind: 'project', file: PROJECT_FILE, load: (path, context) => loadProject(path, context.slug) },
  { kind: 'backlog', file: BACKLOG_FILE, load: (path) => loadBacklog(path) },
];

export interface LoadedProject {
  slug: string;
  manifests: Manifests;
  /** Paths of the manifest files that were found and validated. */
  files: string[];
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (isFileNotFound(error)) return false;
    throw error;
  }
}

async function loadEntry<K extends ManifestKind>(entry: ManifestEntry<K>, path: string, context: LoadContext): Promise<void> {
  context.loaded[entry.kind] = await entry.load(path, context);
}

/**
 * Loads and validates every manifest present in `dir` (the directory of project `slug`). Kinds listed in
 * `require` must exist. Throws one ManifestError with the issues of all files.
 */
export async function loadManifests(dir: string, slug: string, options: { require?: ManifestKind[] } = {}): Promise<LoadedProject> {
  const loaded: Manifests = {};
  const invalid = new Set<ManifestKind>();
  const files: string[] = [];
  const issues: ManifestIssue[] = [];
  for (const entry of MANIFESTS) {
    const path = join(dir, entry.file);
    if (!(await isFile(path))) {
      if (options.require?.includes(entry.kind)) {
        issues.push({ file: path, path: '', rule: 'file-exists', message: 'manifest file not found' });
      }
      continue;
    }
    files.push(path);
    try {
      await loadEntry(entry, path, { slug, loaded, invalid });
    } catch (error) {
      if (!(error instanceof ManifestError)) throw error;
      invalid.add(entry.kind);
      issues.push(...error.issues);
    }
  }
  if (files.length === 0 && issues.length === 0) {
    issues.push({
      file: dir,
      path: '',
      rule: 'file-exists',
      message: `no manifest found (expected ${MANIFESTS.map((entry) => entry.file).join(', ')})`,
    });
  }
  if (issues.length > 0) throw new ManifestError(issues);
  return { slug, manifests: loaded, files };
}

/** Slugs of the project directories under the manifests root, sorted. */
export async function listProjectSlugs(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if (isFileNotFound(error)) return [];
    throw error;
  }
}
