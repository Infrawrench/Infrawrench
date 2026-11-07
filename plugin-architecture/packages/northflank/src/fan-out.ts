import { reportUnreadListPart } from "@infrawrench/plugin-base";
import { statusOf } from "./api.js";

/**
 * Parents a type reads one request each for in one poll. Northflank allows 1000 requests
 * an hour per account by default, and the poller lists every type many times an hour, so
 * reading every project's children on every poll would spend that allowance on a team of a
 * few dozen projects and answer 429 to everything after.
 */
export const MAX_FANOUT_READS = 40;

/**
 * The parents to read this poll and the ones left for later. Polls share nothing, so past
 * the budget the start moves with the clock by the golden ratio, which spreads evenly over
 * the list however long it is.
 */
export function fanOutWindow<P>(
  parents: P[],
  idOf: (p: P) => string,
  max = MAX_FANOUT_READS,
): { now: P[]; later: P[] } {
  if (parents.length <= max) return { now: parents, later: [] };
  const sorted = [...parents].sort((a, b) => (idOf(a) < idOf(b) ? -1 : 1));
  const minute = Math.floor(Date.now() / 60_000);
  const start = Math.floor(((minute * 0.618_033_988_75) % 1) * sorted.length);
  const rotated = [...sorted.slice(start), ...sorted.slice(0, start)];
  return { now: rotated.slice(0, max), later: rotated.slice(max) };
}

/** What a per-parent read got: its rows, the parents it did not read, and why. */
export interface FanOut<V> {
  rows: V[];
  /** Ids of parents whose children were not read: past the budget, or refused. */
  unread: string[];
  /** Why the first refused parent was, if one was. */
  refusal?: unknown;
}

/**
 * Read `read(parent)` for the parents inside this poll's window, or for every parent when
 * `whole`. A 403 is a role that does not reach that parent, and a 404 one deleted since it
 * was listed: neither fails the type. Anything else (a throttle, a 5xx, a cut-short list)
 * does, so stored rows stay.
 */
export async function readPerParent<P, V>(
  parents: P[],
  idOf: (p: P) => string,
  read: (p: P) => Promise<V[]>,
  whole = false,
): Promise<FanOut<V>> {
  const { now, later } = fanOutWindow(parents, idOf, whole ? Infinity : MAX_FANOUT_READS);
  const rows: V[] = [];
  const unread = later.map(idOf);
  let refusal: unknown;
  for (const p of now) {
    try {
      rows.push(...(await read(p)));
    } catch (err) {
      const status = statusOf(err);
      if (status === 404) continue;
      if (status !== 403) throw err;
      unread.push(idOf(p));
      refusal ??= err;
    }
  }
  return { rows, unread, ...(refusal !== undefined ? { refusal } : {}) };
}

/**
 * Name the parents a fan-out did not read, so their children go stale rather than
 * deleted, and say whether the host keeps them. One that keeps no track (the desktop)
 * answers false: there a refusal shows, and the caller reads again with no budget.
 */
export function reportUnreadParents(
  fan: FanOut<unknown>,
  parentId: (id: string) => string,
): boolean {
  if (fan.unread.length === 0) return true;
  if (reportUnreadListPart({ parentResourceIds: fan.unread.map(parentId) })) return true;
  if (fan.refusal !== undefined) throw fan.refusal;
  return false;
}
