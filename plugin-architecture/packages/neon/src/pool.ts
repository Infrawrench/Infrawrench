/**
 * Neon's inventory is a tree (projects, branches, databases), and listing a
 * child type means one request per parent. Run those a few at a time instead
 * of one after another: an account with 40 projects and 75 databases took
 * about two minutes sequentially at ~0.2s per call. Neon allows bursts of
 * 40 requests a second, so 8 in flight stays well clear of its rate limit.
 */
export const NEON_LIST_CONCURRENCY = 8;

/**
 * Map `items` through `fn` with at most `limit` calls in flight, and flatten
 * the per-item arrays in input order. The first failure rejects the lot and
 * starts nothing more: reading a failed parent as having no children would
 * prune them, so `fn` catches whatever really does mean none.
 */
export async function flatMapPooled<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R[]>,
  limit = NEON_LIST_CONCURRENCY,
): Promise<R[]> {
  const out: R[][] = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (next < items.length && !failed) {
      const i = next++;
      try {
        out[i] = await fn(items[i]!);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out.flat();
}
