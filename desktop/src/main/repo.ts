// The opened repository: the remembered folder, its environment (`.env` completes process.env, as the CLI does),
// where its manifests live and which projects they hold.

import { readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { app } from 'electron';
import type { ProjectEntry, RepoInfo } from '../shared/api.ts';
import { loadCore } from './taigent.ts';

const SETTINGS_FILE = 'settings.json';

interface Settings {
  lastRepo?: string;
}

async function readSettings(): Promise<Settings> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(app.getPath('userData'), SETTINGS_FILE), 'utf8'));
    if (parsed && typeof parsed === 'object' && 'lastRepo' in parsed && typeof parsed.lastRepo === 'string') {
      return { lastRepo: parsed.lastRepo };
    }
  } catch {
    // no settings yet
  }
  return {};
}

export async function rememberRepo(root: string): Promise<void> {
  const dir = app.getPath('userData');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, SETTINGS_FILE), `${JSON.stringify({ lastRepo: root } satisfies Settings, null, 2)}\n`);
}

/** The remembered repository, when it still exists. */
export async function lastRepo(): Promise<string | undefined> {
  const { lastRepo: root } = await readSettings();
  if (!root) return undefined;
  const info = await stat(root).catch(() => undefined);
  return info?.isDirectory() ? root : undefined;
}

/** process.env completed from `<root>/.env` (a non-empty process variable wins), like the CLI. */
export function repoEnv(root: string): NodeJS.ProcessEnv {
  let text: string;
  try {
    text = readFileSync(join(root, '.env'), 'utf8');
  } catch {
    return process.env;
  }
  const merged = { ...process.env };
  for (const [name, value] of Object.entries(parseEnv(text))) {
    if (!merged[name]) merged[name] = value;
  }
  return merged;
}

export function manifestsDir(root: string): string {
  return resolve(root, repoEnv(root).TAIGENT_MANIFESTS_DIR || 'taiga');
}

export function projectDir(root: string, slug: string): string {
  return join(manifestsDir(root), slug);
}

/** Every `<manifests>/<slug>/` holding a backlog.yaml, named from project.yaml when it loads. */
export async function readRepo(root: string): Promise<RepoInfo> {
  const dir = manifestsDir(root);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const { review } = await loadCore();
  const projects: ProjectEntry[] = [];
  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const hasBacklog = await stat(join(dir, entry.name, 'backlog.yaml')).then((s) => s.isFile(), () => false);
    if (!hasBacklog) continue;
    const name = await review.buildPreview(join(dir, entry.name), entry.name).then((p) => p.project.name, () => undefined);
    projects.push(name ? { slug: entry.name, name } : { slug: entry.name });
  }
  return { root, manifestsDir: dir, projects };
}

/** The reviewer's name: the stored `taigent login` username, else the OS account name. */
export async function reviewerName(root: string | undefined): Promise<string> {
  try {
    const { login } = await loadCore();
    const parsed: unknown = JSON.parse(await readFile(join(login.configDir(root ? repoEnv(root) : process.env), 'login.json'), 'utf8'));
    if (parsed && typeof parsed === 'object' && 'username' in parsed && typeof parsed.username === 'string' && parsed.username) {
      return parsed.username;
    }
  } catch {
    // not logged in
  }
  return userInfo().username;
}
