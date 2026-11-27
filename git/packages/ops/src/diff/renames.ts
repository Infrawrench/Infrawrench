/**
 * Rename and copy detection, as git's diffcore-rename does it: identical
 * content first, then files that kept their name and are at least 75%
 * alike, then the best remaining pairs at 50% or more. Similarity is
 * git's own measure (diffcore-delta.c), so the percentages match.
 */
import type { ObjectId } from "@infrawrench/git-core";
import type { EntryRef, ObjectCache } from "../objects";
import { isBinary } from "./lines";
import { type TreeChange, diffTreeEntries, entryKind } from "./tree-diff";

export type ChangeStatus = "added" | "deleted" | "modified" | "renamed" | "copied" | "type-changed";

/** One changed file. Both paths are set except for an addition (no old) and a deletion (no new). */
export interface FileChange {
  readonly status: ChangeStatus;
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly old: EntryRef | null;
  readonly new: EntryRef | null;
  /** For a rename or copy: how alike the two are, 0 to 100, rounded down as git prints it. */
  readonly similarity?: number;
}

export interface RenameOptions {
  /** Least similarity that counts as a rename, 0 to 1. Git's default is 0.5. */
  readonly threshold?: number;
  /** Also find copies of files that changed in the same diff (`git diff -C`). */
  readonly copies?: boolean;
}

export interface RenameCandidate {
  readonly path: string;
  readonly entry: EntryRef;
}

export interface RenameMatch {
  readonly source: number;
  readonly destination: number;
  /** 0 to 60000, git's scale. */
  readonly score: number;
}

const MAX_SCORE = 60000;
const HASH_BASE = 107927;
const CANDIDATES_PER_DESTINATION = 4;

interface Fingerprint {
  readonly size: number;
  /** Chunk hashes in rising order, with the bytes each accounts for. */
  readonly hashes: Uint32Array;
  readonly counts: Uint32Array;
}

/**
 * Git's `hash_chars`: the file as chunks that end at a newline or after 64
 * bytes, each reduced to a hash, with the bytes per hash added up. Two
 * files are alike to the extent the same hashes account for their bytes.
 */
export function fingerprint(data: Uint8Array): Fingerprint {
  const text = !isBinary(data);
  const totals = new Map<number, number>();
  let n = 0;
  let accum1 = 0;
  let accum2 = 0;
  const flush = (): void => {
    const hash = ((accum1 + Math.imul(accum2, 0x61)) >>> 0) % HASH_BASE;
    totals.set(hash, (totals.get(hash) ?? 0) + n);
    n = 0;
    accum1 = accum2 = 0;
  };
  for (let i = 0; i < data.length; i++) {
    const c = data[i]!;
    // A CR before an LF is not counted, so a change of line endings alone is no change.
    if (text && c === 0x0d && i + 1 < data.length && data[i + 1] === 0x0a) continue;
    const old1 = accum1;
    accum1 = ((accum1 << 7) ^ (accum2 >>> 25)) >>> 0;
    accum2 = ((accum2 << 7) ^ (old1 >>> 25)) >>> 0;
    accum1 = (accum1 + c) >>> 0;
    if (++n < 64 && c !== 0x0a) continue;
    flush();
  }
  if (n > 0) flush();
  const hashes = Uint32Array.from(totals.keys()).sort();
  const counts = new Uint32Array(hashes.length);
  for (let i = 0; i < hashes.length; i++) counts[i] = totals.get(hashes[i]!)!;
  return { size: data.length, hashes, counts };
}

/** Bytes of the destination that also occur in the source. */
function copiedBytes(source: Fingerprint, destination: Fingerprint): number {
  let copied = 0;
  let d = 0;
  for (let s = 0; s < source.hashes.length; s++) {
    const hash = source.hashes[s]!;
    while (d < destination.hashes.length && destination.hashes[d]! < hash) d++;
    if (d < destination.hashes.length && destination.hashes[d] === hash) {
      copied += Math.min(source.counts[s]!, destination.counts[d]!);
      d++;
    }
  }
  return copied;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

interface MatchSettings {
  readonly minimumScore: number;
  readonly copies: boolean;
  /** How often each source is already spoken for. A modified file starts at one: using it is a copy. */
  readonly used: number[];
}

/**
 * Pairs destinations (added paths) with sources (deleted, or for copies
 * also modified, paths). Each destination gets at most one source.
 */
export async function matchRenames(
  cache: ObjectCache,
  sources: readonly RenameCandidate[],
  destinations: readonly RenameCandidate[],
  settings: MatchSettings,
): Promise<RenameMatch[]> {
  const { minimumScore, copies, used } = settings;
  const matched: Array<RenameMatch | null> = destinations.map(() => null);
  const record = (destination: number, source: number, score: number): void => {
    matched[destination] = { source, destination, score };
    used[source] = used[source]! + 1;
  };
  const result = (): RenameMatch[] => matched.filter((m): m is RenameMatch => m !== null);
  if (sources.length === 0 || destinations.length === 0) return result();

  // Identical content: no blob is read for these.
  const byOid = new Map<ObjectId, number[]>();
  sources.forEach((source, index) => {
    const list = byOid.get(source.entry.oid);
    if (list) list.push(index);
    else byOid.set(source.entry.oid, [index]);
  });
  destinations.forEach((destination, index) => {
    const same = byOid.get(destination.entry.oid);
    if (!same) return;
    let best = -1;
    let bestScore = -1;
    let budget = 100;
    for (const candidate of same) {
      const source = sources[candidate]!;
      const regular =
        entryKind(source.entry.mode) === "file" && entryKind(destination.entry.mode) === "file";
      if (!regular && source.entry.mode !== destination.entry.mode) continue;
      if (used[candidate]! > 0 && !copies) continue;
      const score =
        (used[candidate]! > 0 ? 0 : 1) +
        (basename(source.path) === basename(destination.path) ? 1 : 0);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
        if (score === 2) break;
      }
      if (--budget === 0) break;
    }
    if (best >= 0) record(index, best, MAX_SCORE);
  });
  if (minimumScore >= MAX_SCORE) return result();

  const prints = new Map<ObjectId, Fingerprint | null>();
  // What inexact matching may read and hold, and how much comparing it may do: a commit can
  // delete and add hundreds of megabyte-sized files, and every pair is a candidate.
  let spent = 0;
  let work = 0;
  const print = async (entry: EntryRef): Promise<Fingerprint | null> => {
    const known = prints.get(entry.oid);
    if (known !== undefined) return known;
    if (
      spent >= cache.limits.renameBudgetBytes ||
      (await cache.overTextLimit(entry.oid, cache.limits.maxRenameBytes))
    ) {
      prints.set(entry.oid, null);
      return null;
    }
    const data = await cache.blob(entry.oid);
    // Not held: only the fingerprint is kept, so a wide diff does not pin every blob it compared.
    const made = data.length > cache.limits.maxRenameBytes ? null : fingerprint(data);
    spent += data.length + (made === null ? 0 : made.hashes.length * 8);
    prints.set(entry.oid, made);
    return made;
  };
  const estimate = async (
    source: RenameCandidate,
    destination: RenameCandidate,
    minimum: number,
  ): Promise<number> => {
    if (entryKind(source.entry.mode) !== "file" || entryKind(destination.entry.mode) !== "file") {
      return 0;
    }
    const a = await print(source.entry);
    if (a === null) return 0;
    const b = await print(destination.entry);
    if (b === null) return 0;
    const maxSize = Math.max(a.size, b.size);
    const delta = maxSize - Math.min(a.size, b.size);
    // A size change this drastic cannot reach the minimum, so the content is not compared.
    if (maxSize * (MAX_SCORE - minimum) < delta * MAX_SCORE) return 0;
    if (b.size === 0) return 0;
    work += a.hashes.length + b.hashes.length;
    if (work > cache.limits.maxRenameWork) return 0;
    return Math.floor((copiedBytes(a, b) * MAX_SCORE) / maxSize);
  };

  const available = (): number[] => {
    const list: number[] = [];
    for (let i = 0; i < sources.length; i++) if (copies || used[i] === 0) list.push(i);
    return list;
  };

  if (!copies) {
    // A file that kept its name and moved directory is the usual rename, and checking those
    // pairs first is linear. The bar is higher, halfway between the minimum and identical.
    const minimumBasename = minimumScore + Math.floor((MAX_SCORE - minimumScore) * 0.5);
    const remaining = available();
    const sourceByName = new Map<string, number>();
    for (const index of remaining) {
      const base = basename(sources[index]!.path);
      sourceByName.set(base, sourceByName.has(base) ? -1 : index);
    }
    const destinationByName = new Map<string, number>();
    destinations.forEach((destination, index) => {
      if (matched[index]) return;
      const base = basename(destination.path);
      destinationByName.set(base, destinationByName.has(base) ? -1 : index);
    });
    for (const index of remaining) {
      const base = basename(sources[index]!.path);
      const destination = destinationByName.get(base);
      if (destination === undefined || destination === -1) continue;
      if (sourceByName.get(base) === -1 || matched[destination]) continue;
      const score = await estimate(sources[index]!, destinations[destination]!, minimumBasename);
      if (score >= minimumBasename) record(destination, index, score);
    }
  }

  const candidates = available();
  const open: number[] = [];
  destinations.forEach((_, index) => {
    if (!matched[index]) open.push(index);
  });
  if (candidates.length === 0 || open.length === 0) return result();
  const limit = cache.limits.renameLimit;
  if (candidates.length * open.length > limit * limit) return result();

  interface Scored {
    readonly source: number;
    readonly destination: number;
    readonly score: number;
    readonly nameScore: number;
  }
  const better = (a: Scored, b: Scored): boolean =>
    a.score > b.score || (a.score === b.score && a.nameScore > b.nameScore);
  const scored: Scored[] = [];
  for (const destination of open) {
    // Git keeps the four best sources per destination, which bounds the table it sorts.
    const top: Scored[] = [];
    for (const source of candidates) {
      const score = await estimate(sources[source]!, destinations[destination]!, minimumScore);
      const next: Scored = {
        source,
        destination,
        score,
        nameScore:
          basename(sources[source]!.path) === basename(destinations[destination]!.path) ? 1 : 0,
      };
      if (top.length < CANDIDATES_PER_DESTINATION) {
        top.push(next);
        continue;
      }
      let worst = 0;
      for (let k = 1; k < top.length; k++) if (better(top[worst]!, top[k]!)) worst = k;
      if (better(next, top[worst]!)) top[worst] = next;
    }
    scored.push(...top);
  }
  scored.sort((a, b) => b.score - a.score || b.nameScore - a.nameScore);

  const take = (allowUsed: boolean): void => {
    for (const item of scored) {
      if (matched[item.destination]) continue;
      if (item.score < minimumScore) break;
      if (!allowUsed && used[item.source]! > 0) continue;
      record(item.destination, item.source, item.score);
    }
  };
  take(false);
  if (copies) take(true);
  return result();
}

function plainStatus(change: TreeChange): ChangeStatus {
  if (change.old === null) return "added";
  if (change.new === null) return "deleted";
  return entryKind(change.old.mode) === entryKind(change.new.mode) ? "modified" : "type-changed";
}

/** The changes as they are, with no rename detection. */
export function plainChanges(changes: readonly TreeChange[]): FileChange[] {
  return changes.map((change) => ({
    status: plainStatus(change),
    oldPath: change.old === null ? null : change.path,
    newPath: change.new === null ? null : change.path,
    old: change.old,
    new: change.new,
  }));
}

/**
 * Turns delete-and-add pairs into renames (and, when asked, copies). The
 * result stays in path order by the new path, as git lists it.
 */
export async function detectRenames(
  cache: ObjectCache,
  changes: readonly TreeChange[],
  options: RenameOptions = {},
): Promise<FileChange[]> {
  const copies = options.copies === true;
  const sourceIndex: number[] = [];
  const destinationIndex: number[] = [];
  const used: number[] = [];
  changes.forEach((change, index) => {
    if (change.old === null) destinationIndex.push(index);
    else if (change.new === null) {
      sourceIndex.push(index);
      used.push(0);
    } else if (copies) {
      sourceIndex.push(index);
      used.push(1);
    }
  });
  const matches = await matchRenames(
    cache,
    sourceIndex.map((index) => ({ path: changes[index]!.path, entry: changes[index]!.old! })),
    destinationIndex.map((index) => ({ path: changes[index]!.path, entry: changes[index]!.new! })),
    { minimumScore: Math.round((options.threshold ?? 0.5) * MAX_SCORE), copies, used },
  );
  const byDestination = new Map<number, RenameMatch>();
  for (const match of matches) byDestination.set(destinationIndex[match.destination]!, match);
  const consumed = new Set<number>();
  sourceIndex.forEach((index, source) => {
    if (used[source]! > 0 && changes[index]!.new === null) consumed.add(index);
  });

  const out: FileChange[] = [];
  changes.forEach((change, index) => {
    if (consumed.has(index)) return;
    const match = byDestination.get(index);
    if (!match) {
      out.push(plainChanges([change])[0]!);
      return;
    }
    const from = changes[sourceIndex[match.source]!]!;
    // The last use of a deleted source is the rename; every use before it, and every use of a
    // source that is still there, is a copy.
    const status: ChangeStatus = --used[match.source]! > 0 ? "copied" : "renamed";
    out.push({
      status,
      oldPath: from.path,
      newPath: change.path,
      old: from.old,
      new: change.new,
      similarity: Math.floor((match.score * 100) / MAX_SCORE),
    });
  });
  return out;
}

/**
 * Where `path`, which `tree` has and `parentTree` does not, came from: the
 * path in the parent it was renamed from, or null. This is what following
 * a file through history and blame ask at the commit that introduced a name.
 */
export async function findRenameSource(
  cache: ObjectCache,
  parentTree: ObjectId,
  tree: ObjectId,
  path: string,
  options: RenameOptions = {},
): Promise<{ path: string; entry: EntryRef } | null> {
  const { changes, truncated } = await diffTreeEntries(cache, parentTree, tree);
  if (truncated) return null;
  const target = changes.find((change) => change.path === path && change.old === null);
  if (!target) return null;
  const sources = changes.filter((change) => change.new === null);
  const matches = await matchRenames(
    cache,
    sources.map((change) => ({ path: change.path, entry: change.old! })),
    [{ path, entry: target.new! }],
    {
      minimumScore: Math.round((options.threshold ?? 0.5) * MAX_SCORE),
      copies: false,
      used: sources.map(() => 0),
    },
  );
  const match = matches[0];
  if (!match) return null;
  const source = sources[match.source]!;
  return { path: source.path, entry: source.old! };
}
