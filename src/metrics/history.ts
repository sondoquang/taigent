// The Taiga history of each user story, task and issue of a project, as `taigent metrics` reads it: one
// `GET /history/{userstory|task|issue}/{id}` per item. With --cache-dir the histories are kept in one file per Taiga
// instance (API URL) and project, by item type and id, and a cached history is used again while the item's
// fingerprint (its `modified_date` and the fields Taiga changes without moving it, snapshot.ts) is the one it was
// read with. Without --cache-dir nothing is written. A cache file that cannot be read, of another version, or of
// another instance or project is ignored: the histories are read again and the file is rewritten. When a history
// read fails, no other one starts and the histories read so far are still written to the cache before the failure is
// reported.

import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeAtomic } from '../files.ts';
import { errorMessage, isRecord } from '../guards.ts';
import type { TaigaClient, TaigaHistoryEntry } from '../taiga/client.ts';
import { mapLimited, TAIGA_CONCURRENCY } from '../taiga/concurrency.ts';

export type HistoryType = 'story' | 'task' | 'issue';

/** The changes of each item (oldest first), by type and item id. */
export type ItemHistories = Record<HistoryType, Map<number, TaigaHistoryEntry[]>>;

/** An item whose history to read, with its fingerprint (null when Taiga sent no `modified_date`: never cached). */
export interface HistoryItem {
  type: HistoryType;
  id: number;
  fingerprint: string | null;
}

/** Bumped whenever the file's shape or `TaigaHistoryEntry` changes, so an old file is read again. */
const CACHE_VERSION = 3;

/** The --cache-dir cannot hold the cache file (not a directory, no permission). Maps to ExitCode.Usage. */
export class HistoryCacheError extends Error {}

/** One cached history: the item's fingerprint when it was read, and its changes. */
interface CachedHistory {
  fingerprint: string;
  entries: TaigaHistoryEntry[];
}

/** The cache file of one project on one Taiga instance. `items` is keyed `<type>:<id>`. */
interface CacheFile {
  version: number;
  apiUrl: string;
  project: number;
  items: Record<string, CachedHistory>;
}

function cachePath(dir: string, apiUrl: string, project: { id: number; slug: string }): string {
  const instance = createHash('sha256').update(`${apiUrl}\n${project.id}`).digest('hex').slice(0, 16);
  return join(dir, `history-${project.slug}-${instance}.json`);
}

/** The cached histories of the file at `path` when it is this version's, of this instance and project; else none. */
async function loadCache(path: string, apiUrl: string, project: number): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return {};
  }
  if (!isRecord(parsed) || parsed.version !== CACHE_VERSION || parsed.apiUrl !== apiUrl || parsed.project !== project || !isRecord(parsed.items)) return {};
  return parsed.items;
}

/** The cached changes of an item read at `fingerprint`, undefined when there are none or they look damaged. */
function cachedEntries(raw: unknown, fingerprint: string): TaigaHistoryEntry[] | undefined {
  if (!isRecord(raw) || raw.fingerprint !== fingerprint || !Array.isArray(raw.entries)) return undefined;
  const entries: unknown[] = raw.entries;
  return entries.every((entry) => isRecord(entry) && typeof entry.at === 'string') ? (entries as TaigaHistoryEntry[]) : undefined;
}

/** Writes the cache file whole and atomically, so a reader never sees half of it. */
async function saveCache(path: string, file: CacheFile): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeAtomic(path, `${JSON.stringify(file)}\n`);
  } catch (error) {
    throw new HistoryCacheError(`cannot write the history cache in ${dirname(path)}: ${errorMessage(error)}; give a writable directory as --cache-dir`);
  }
}

/** The history of every item in `items`; from the cache in `cacheDir` (when given) for the unchanged ones. */
export async function readHistories(client: TaigaClient, project: { id: number; slug: string }, items: HistoryItem[], cacheDir?: string): Promise<ItemHistories> {
  const path = cacheDir === undefined ? undefined : cachePath(cacheDir, client.apiUrl, project);
  const cached = path === undefined ? {} : await loadCache(path, client.apiUrl, project.id);
  const histories: ItemHistories = { story: new Map(), task: new Map(), issue: new Map() };
  const kept: Record<string, CachedHistory> = {};
  const save = () => (path === undefined ? undefined : saveCache(path, { version: CACHE_VERSION, apiUrl: client.apiUrl, project: project.id, items: kept }));
  try {
    await mapLimited(items, TAIGA_CONCURRENCY, async ({ type, id, fingerprint }) => {
      const key = `${type}:${id}`;
      const entries = (fingerprint === null ? undefined : cachedEntries(cached[key], fingerprint)) ?? (await client.listHistory(type, id));
      histories[type].set(id, entries);
      if (fingerprint !== null) kept[key] = { fingerprint, entries };
    });
  } catch (error) {
    // The read failure is what to report; a cache that cannot be written as well only costs the next run its reads.
    await save()?.catch(() => undefined);
    throw error;
  }
  await save();
  return histories;
}
