// The Taiga history of each user story, task and issue of a project, as `taigent metrics` reads it: one
// `GET /history/{userstory|task|issue}/{id}` per item. With --cache-dir the histories are kept in one file per Taiga
// instance (API URL) and project, by item type and id, and a cached history is used again while the item's
// `modified_date` is the one it was read with (any change on Taiga moves it). Without --cache-dir nothing is written.
// A cache file that cannot be read, of another version, or of another instance or project is ignored: the histories
// are read again and the file is rewritten.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isRecord } from '../guards.ts';
import type { TaigaClient, TaigaHistoryEntry } from '../taiga/client.ts';

export type HistoryType = 'story' | 'task' | 'issue';

/** The changes of each item (oldest first), by type and item id. */
export type ItemHistories = Record<HistoryType, Map<number, TaigaHistoryEntry[]>>;

/** An item whose history to read, with its `modified_date` (null when Taiga sent none: never taken from the cache). */
export interface HistoryItem {
  type: HistoryType;
  id: number;
  modifiedAt: string | null;
}

/** Bumped whenever the file's shape or `TaigaHistoryEntry` changes, so an old file is read again. */
const CACHE_VERSION = 1;

/** History reads in flight at once: one request per item, bounded so Taiga does not throttle (429). */
const CONCURRENCY = 8;

/** One cached history: the item's `modified_date` when it was read, and its changes. */
interface CachedHistory {
  modifiedAt: string;
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

/** The cached changes of an item read at `modifiedAt`, undefined when there are none or they look damaged. */
function cachedEntries(raw: unknown, modifiedAt: string): TaigaHistoryEntry[] | undefined {
  if (!isRecord(raw) || raw.modifiedAt !== modifiedAt || !Array.isArray(raw.entries)) return undefined;
  const entries: unknown[] = raw.entries;
  return entries.every((entry) => isRecord(entry) && typeof entry.at === 'string') ? (entries as TaigaHistoryEntry[]) : undefined;
}

/** Writes the cache file whole, through a temporary file, so a reader never sees half of it. */
async function saveCache(path: string, file: CacheFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(file)}\n`);
  await rename(temporary, path);
}

/** The history of every item in `items`; from the cache in `cacheDir` (when given) for the unchanged ones. */
export async function readHistories(client: TaigaClient, project: { id: number; slug: string }, items: HistoryItem[], cacheDir?: string): Promise<ItemHistories> {
  const path = cacheDir === undefined ? undefined : cachePath(cacheDir, client.apiUrl, project);
  const cached = path === undefined ? {} : await loadCache(path, client.apiUrl, project.id);
  const histories: ItemHistories = { story: new Map(), task: new Map(), issue: new Map() };
  const kept: Record<string, CachedHistory> = {};
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const { type, id, modifiedAt } = items[next++]!;
      const key = `${type}:${id}`;
      const entries = (modifiedAt === null ? undefined : cachedEntries(cached[key], modifiedAt)) ?? (await client.listHistory(type, id));
      histories[type].set(id, entries);
      if (modifiedAt !== null) kept[key] = { modifiedAt, entries };
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  if (path !== undefined) await saveCache(path, { version: CACHE_VERSION, apiUrl: client.apiUrl, project: project.id, items: kept });
  return histories;
}
