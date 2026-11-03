// Where a project's manifests live: `<root>/<slug>/{project,backlog,docs}.yaml` + `state.json`, and the git-ignored
// `snapshot.json` of `taigent snapshot`.
// The root defaults to `./taiga` and can be overridden with TAIGENT_MANIFESTS_DIR.

import { join, resolve } from 'node:path';
import { BACKLOG_FILE } from './backlog.ts';
import { STATE_FILE } from './state.ts';

export const DEFAULT_MANIFESTS_DIR = 'taiga';

/** The backlog on Taiga as `taigent snapshot` last read it (src/snapshot.ts); git-ignored, never committed. */
export const SNAPSHOT_FILE = 'snapshot.json';

export interface ProjectLayout {
  dir: string;
  backlog: string;
  state: string;
  snapshot: string;
}

/** The manifests root: TAIGENT_MANIFESTS_DIR, default `./taiga`, resolved against `cwd`. */
export function manifestsRoot(env: NodeJS.ProcessEnv, cwd: string): string {
  return resolve(cwd, env.TAIGENT_MANIFESTS_DIR || DEFAULT_MANIFESTS_DIR);
}

export function projectLayout(slug: string, env: NodeJS.ProcessEnv, cwd: string): ProjectLayout {
  const root = manifestsRoot(env, cwd);
  const dir = join(root, slug);
  return { dir, backlog: join(dir, BACKLOG_FILE), state: join(dir, STATE_FILE), snapshot: join(dir, SNAPSHOT_FILE) };
}
