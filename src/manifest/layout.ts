// Where a project's manifests live: `<root>/<slug>/{project,backlog,docs}.yaml` + `state.json`.
// The root defaults to `./taiga` and can be overridden with TAIGENT_MANIFESTS_DIR.

import { join, resolve } from 'node:path';
import { BACKLOG_FILE } from './backlog.ts';
import { STATE_FILE } from './state.ts';

export const DEFAULT_MANIFESTS_DIR = 'taiga';

export interface ProjectLayout {
  dir: string;
  backlog: string;
  state: string;
}

export function projectLayout(slug: string, env: NodeJS.ProcessEnv, cwd: string): ProjectLayout {
  const root = resolve(cwd, env.TAIGENT_MANIFESTS_DIR || DEFAULT_MANIFESTS_DIR);
  const dir = join(root, slug);
  return { dir, backlog: join(dir, BACKLOG_FILE), state: join(dir, STATE_FILE) };
}
