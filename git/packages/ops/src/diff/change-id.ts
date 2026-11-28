/**
 * What a change does, as one id that does not depend on where it was made:
 * two commits that change the same files the same way have the same id
 * whatever the rest of their trees hold. It is how a squash is recognised
 * after the base moved on, as `git cherry` recognises a picked commit by its
 * patch id: the branch's whole change against its merge base and the squash
 * commit's change against its parent are the same change.
 *
 * Unlike git's patch id it leaves out the context lines and the order of the
 * lines within a file: a squash made after the base edited lines around the
 * change shows other context, and the same lines can come out of the diff
 * in another arrangement. What it keeps, file by file in path order: the
 * path, its kind on each side, and for a text file changed in place the lines
 * removed and the lines added; an added file by its content, a deleted one
 * by its path alone (the base may have edited it before it went), a binary
 * or oversized one by its new content.
 */
import {
  type ObjectId,
  type ObjectReader,
  encodeText,
  sha1Sync,
  toHex,
} from "@infrawrench/git-core";
import type { Limits } from "../limits";
import { type ObjectCache, cacheOf } from "../objects";
import { isBinary, lineBytes, splitLines } from "./lines";
import { type TreeChange, diffTreeEntries, entryKind } from "./tree-diff";
import { diffLines } from "./xdiff";

/** The paths a change touches, in path order, as one string: a cheap first test before {@link changeId}. */
export async function changedPaths(
  reader: ObjectReader,
  oldTree: ObjectId | null,
  newTree: ObjectId,
  options: { readonly limits?: Partial<Limits> } = {},
): Promise<string | null> {
  const diff = await diffTreeEntries(cacheOf(reader, options.limits), oldTree, newTree);
  if (diff.truncated || diff.changes.length === 0) return null;
  return diff.changes.map((change) => change.path).join("\0");
}

const compareBytes = (a: Uint8Array, b: Uint8Array): number => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
};

/**
 * The change from `oldTree` to `newTree` as a hex id, or null when there is
 * none or it is too large to list (`maxDiffEntries`).
 */
export async function changeId(
  reader: ObjectReader,
  oldTree: ObjectId | null,
  newTree: ObjectId,
  options: { readonly limits?: Partial<Limits> } = {},
): Promise<string | null> {
  const cache = cacheOf(reader, options.limits);
  const diff = await diffTreeEntries(cache, oldTree, newTree);
  if (diff.truncated || diff.changes.length === 0) return null;
  const parts: Uint8Array[] = [];
  const put = (text: string) => parts.push(encodeText(text));
  for (const change of diff.changes) {
    put(`\0path ${change.path}\0${kindOf(change.old)} ${kindOf(change.new)}\0`);
    await describe(cache, change, parts, put);
  }
  let length = 0;
  for (const part of parts) length += part.length;
  const all = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  return toHex(sha1Sync(all));
}

const kindOf = (entry: TreeChange["old"]): string =>
  entry === null ? "none" : `${entryKind(entry.mode)}:${entry.mode}`;

async function describe(
  cache: ObjectCache,
  change: TreeChange,
  parts: Uint8Array[],
  put: (text: string) => void,
): Promise<void> {
  const { old, new: next } = change;
  // Gone: the base may have edited it before it went, so its last content says nothing.
  if (next === null) return;
  // Added, a link or a submodule, or a kind changed: the new side is the change.
  if (old === null || entryKind(old.mode) !== "file" || entryKind(next.mode) !== "file") {
    put(`new ${next.oid}`);
    return;
  }
  const limit = cache.limits.maxTextBytes;
  const [oldSize, newSize] = await Promise.all([cache.size(old.oid), cache.size(next.oid)]);
  if ((oldSize ?? 0) > limit || (newSize ?? 0) > limit) {
    put(`new ${next.oid}`);
    return;
  }
  const [before, after] = await Promise.all([cache.blob(old.oid), cache.blob(next.oid)]);
  if (before.length > limit || after.length > limit || isBinary(before) || isBinary(after)) {
    put(`new ${next.oid}`);
    return;
  }
  const a = splitLines(before);
  const b = splitLines(after);
  const lines = diffLines(a, b);
  const removed: Uint8Array[] = [];
  const added: Uint8Array[] = [];
  for (let i = 0; i < a.count; i++) if (lines.removed[i]) removed.push(lineBytes(a, i));
  for (let i = 0; i < b.count; i++) if (lines.added[i]) added.push(lineBytes(b, i));
  removed.sort(compareBytes);
  added.sort(compareBytes);
  put(`-${removed.length}\0`);
  for (const line of removed) {
    parts.push(line);
    put("\0");
  }
  put(`+${added.length}\0`);
  for (const line of added) {
    parts.push(line);
    put("\0");
  }
}
