import { ListTruncatedError, reportUnreadListPart } from "@infrawrench/plugin-base";
import type { VaultContext } from "./api.js";
import { encodePath, statusOf, vaultList } from "./api.js";

const VENDOR = "HashiCorp Vault";

/** The ceiling for a list going through the sync: past it a poll runs out of memory or time. */
const MAX_LIST_ROWS = 100_000;
/** Vault's LIST has no pages, so a walk costs one request a folder. */
const MAX_WALK_REQUESTS = 1_000;
/** Per type. Six at a time, about 70 seconds at 200 ms a read. */
const MAX_DETAIL_READS = 2_000;
/** Types run side by side and a poll past 300 seconds is killed with no message. */
const MAX_LIST_MS = 200_000;
/** The sync compares every stored row with every prefix, so a long list of them costs more than it saves. */
const MAX_NAMED_FOLDERS = 1_000;

const CONCURRENCY = 6;

export const listDeadline = (): number => Date.now() + MAX_LIST_MS;

/** Stops starting work at the first failure, so a refused list does not go on sending requests. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        try {
          out[i] = await fn(items[i]!);
        } catch (err) {
          next = items.length;
          throw err;
        }
      }
    }),
  );
  return out;
}

function takeAtRandom<T>(items: T[], count: number): T[] {
  const taken: T[] = [];
  while (taken.length < count && items.length > 0) {
    const i = Math.floor(Math.random() * items.length);
    taken.push(items[i]!);
    items[i] = items[items.length - 1]!;
    items.pop();
  }
  return taken;
}

export interface WalkRoot {
  /** Request path of the top folder. A folder's own path is appended to it. */
  path: string;
  /** What the id of every row under this root starts with. */
  idPrefix: string;
}

export interface WalkLeaf<R> {
  root: R;
  /** The path under the root, folders included. */
  key: string;
}

/**
 * Every key under the roots, in id order. A folder the token may not list keeps its
 * stored rows, since Vault policies often grant a subtree and not its parent. If no
 * folder at all could be listed, that refusal is thrown for the caller to judge. Past
 * the request budget the rest keeps its stored rows, and a random order means every
 * folder is reached over time.
 */
export async function walkFolders<R extends WalkRoot>(
  ctx: VaultContext,
  roots: R[],
  deadline: number,
): Promise<Array<WalkLeaf<R>>> {
  const leaves: Array<WalkLeaf<R>> = [];
  const pending: Array<{ root: R; prefix: string }> = roots.map((root) => ({ root, prefix: "" }));
  const refused: string[] = [];
  let firstRefusal: unknown;
  let listed = 0;
  let requests = 0;

  while (pending.length > 0 && requests < MAX_WALK_REQUESTS && Date.now() < deadline) {
    const batch = takeAtRandom(pending, Math.min(CONCURRENCY, MAX_WALK_REQUESTS - requests));
    requests += batch.length;
    await Promise.all(
      batch.map(async ({ root, prefix }) => {
        let keys: string[];
        try {
          keys = await vaultList(ctx, `${root.path}${encodePath(prefix)}`);
        } catch (err) {
          if (statusOf(err) !== 403) throw err;
          firstRefusal ??= err;
          refused.push(`${root.idPrefix}${prefix}`);
          return;
        }
        listed++;
        for (const key of keys) {
          if (key.endsWith("/")) pending.push({ root, prefix: `${prefix}${key}` });
          else leaves.push({ root, key: `${prefix}${key}` });
        }
      }),
    );
    if (leaves.length + pending.length > MAX_LIST_ROWS) {
      throw new ListTruncatedError({
        vendor: VENDOR,
        path: batch[0]!.root.path,
        items: leaves.length + pending.length,
        maxItems: MAX_LIST_ROWS,
      });
    }
  }

  if (listed === 0 && firstRefusal !== undefined) throw firstRefusal;
  const unreached =
    pending.length > MAX_NAMED_FOLDERS
      ? [...new Set(pending.map(({ root }) => root.idPrefix))]
      : pending.map(({ root, prefix }) => `${root.idPrefix}${prefix}`);
  const unread = [...refused, ...unreached];
  if (unread.length > 0) reportUnreadListPart({ idPrefixes: unread });

  const idOf = ({ root, key }: WalkLeaf<R>) => `${root.idPrefix}${key}`;
  return leaves
    .map((leaf) => ({ leaf, id: idOf(leaf) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(({ leaf }) => leaf);
}

/**
 * Prefixes matching every unread id and no read one, as few as it can: a run of ids
 * read from a sorted list leaves a small number of whole subtrees, so this stays short
 * however long the list is.
 */
export function unreadPrefixes(ids: string[], read: ReadonlySet<string>): string[] {
  const sorted = [...ids].sort();
  const out: string[] = [];
  const cover = (from: number, to: number, depth: number): void => {
    let reads = 0;
    for (let i = from; i < to; i++) if (read.has(sorted[i]!)) reads++;
    if (reads === to - from) return;
    if (reads === 0) {
      out.push(sorted[from]!.slice(0, depth));
      return;
    }
    let start = from;
    while (start < to) {
      const char = sorted[start]!.charAt(depth);
      let end = start + 1;
      while (end < to && sorted[end]!.charAt(depth) === char) end++;
      if (char !== "") cover(start, end, depth + 1);
      else if (!read.has(sorted[start]!)) out.push(sorted[start]!);
      start = end;
    }
  };
  cover(0, sorted.length, 0);
  return out;
}

/**
 * A row for each item, for a type whose rows take one request each. Past the budget it
 * reads a run of them from a random start and names the rest, so they keep their stored
 * rows and are read on a later poll. Bare rows would be the alternative, but a row
 * flipping between full and bare would fill the change timeline, and a token or
 * certificate with no details reads as not expiring or not revoked.
 */
export async function readWithinBudget<T, R>(
  items: T[],
  idOf: (item: T) => string,
  deadline: number,
  read: (item: T) => Promise<R | undefined>,
): Promise<R[]> {
  const ordered = items.map((item) => ({ item, id: idOf(item) }));
  const start = ordered.length > MAX_DETAIL_READS ? Math.floor(Math.random() * ordered.length) : 0;
  const window = [...ordered.slice(start), ...ordered.slice(0, start)].slice(0, MAX_DETAIL_READS);

  const reached = new Set<string>();
  const rows = await mapLimit(window, CONCURRENCY, async ({ item, id }) => {
    if (Date.now() >= deadline) return undefined;
    reached.add(id);
    return read(item);
  });
  if (reached.size < ordered.length) {
    reportUnreadListPart({
      idPrefixes: unreadPrefixes(
        ordered.map(({ id }) => id),
        reached,
      ),
    });
  }
  return rows.filter((row): row is R => row !== undefined);
}
