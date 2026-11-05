// Many reads of Taiga at once (one per sprint, epic or item): a few in flight at a time, so Taiga does not throttle
// (429), and none started after one fails.

/** Requests in flight at once for reads of one request per sprint, epic or item. */
export const TAIGA_CONCURRENCY = 8;

/**
 * `read` of every item, at most `limit` at a time, results in the order of `items`. After the first failure no read
 * starts; the ones in flight finish, then it rejects with that failure.
 */
export async function mapLimited<T, R>(items: readonly T[], limit: number, read: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    while (failure === undefined && next < items.length) {
      const index = next++;
      try {
        results[index] = await read(items[index]!);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure !== undefined) throw failure.error;
  return results;
}
