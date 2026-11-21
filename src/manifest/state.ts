// Per-project state file `taiga/<slug>/state.json`: key → Taiga id/ref/version and baseline, committed with the
// manifests. The `src:<key>` tag on Taiga stays the only identity; the baseline (the managed values taigent last
// wrote or accepted for the item) lets plan tell a manifest change from an edit made on Taiga. `adopted` holds the
// baseline of the items `taigent adopt` wrote into backlog.yaml until apply adopts them: the Taiga values adopt copied.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isFileNotFound } from '../guards.ts';
import type { ItemType } from '../items.ts';
import type { ManagedValues } from '../managed.ts';

export const STATE_FILE = 'state.json';

export interface StateEntry {
  type: ItemType;
  id: number;
  ref: number;
  version: number;
  /** Managed values taigent last wrote or accepted; absent in state files from before baselines. */
  baseline?: ManagedValues;
}

export interface StateFile {
  project: { id: number; slug: string };
  /** The items apply wrote or accepted on Taiga. */
  items: Record<string, StateEntry>;
  /** Items `taigent adopt` wrote into backlog.yaml that apply has not adopted yet; apply moves each to `items`. */
  adopted: Record<string, StateEntry>;
}

/** The baseline `entry` records for the Taiga item of `type` and `id`; undefined when it records another item, or none. */
export function recordedBaseline(entry: StateEntry | undefined, type: ItemType, id: number): ManagedValues | undefined {
  return entry?.type === type && entry.id === id ? entry.baseline : undefined;
}

/** Reads the state file; a missing file is an empty state. */
export async function readState(path: string, project: StateFile['project']): Promise<StateFile> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isFileNotFound(error)) return { project, items: {}, adopted: {} };
    throw error;
  }
  // Written only by writeState; a hand-broken file surfaces as a JSON parse error.
  const state = JSON.parse(text) as Partial<StateFile>;
  return { project, items: state.items ?? {}, adopted: state.adopted ?? {} };
}

/** The project recorded in the state file (by bootstrap or apply), or undefined when there is none. */
export async function readSavedProject(path: string): Promise<StateFile['project'] | undefined> {
  try {
    return (JSON.parse(await readFile(path, 'utf8')) as Partial<StateFile>).project;
  } catch (error) {
    if (isFileNotFound(error)) return undefined;
    throw error;
  }
}

/** Writes the state atomically with sorted keys, so diffs stay stable; `adopted` only while it holds an item. */
export async function writeState(path: string, state: StateFile): Promise<void> {
  const sorted = (entries: Record<string, StateEntry>) => {
    const items: Record<string, StateEntry> = {};
    for (const key of Object.keys(entries).sort()) {
      const { type, id, ref, version, baseline } = entries[key]!;
      items[key] = { type, id, ref, version, ...(baseline && { baseline }) };
    }
    return items;
  };
  const adopted = sorted(state.adopted);
  const body = `${JSON.stringify({ project: state.project, items: sorted(state.items), ...(Object.keys(adopted).length > 0 && { adopted }) }, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, body);
  await rename(temp, path);
}
