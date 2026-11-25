/**
 * The check a pack must pass before it is stored: every object it holds
 * names only objects that the pack or the repository has.
 *
 * Git checks less, walking from the new ref tips only. Checking every object
 * instead keeps one invariant true of the whole store (an object that exists
 * has its history), which is what lets a later push or fetch stop walking at
 * the first object it already knows. It also needs no second pass over the
 * pack: commits, trees and tags are in memory as the indexer hashes them.
 */
import {
  GitError,
  type ObjectId,
  type ObjectType,
  decodeLatin1,
  toHex,
} from "@infrawrench/git-core";
import { OidSet, forEachTreeEntry } from "./oid-set";

export class ConnectivityCheck {
  /** Every id an object of the pack refers to. */
  private readonly needed = new OidSet(1024);

  /** Records what one object of the pack refers to. Blobs refer to nothing. */
  note(type: ObjectType, data: Uint8Array | null): void {
    if (type === "blob") return;
    if (data === null) throw new GitError("bad-pack", `a ${type} is too large to check`);
    if (type === "tree") {
      forEachTreeEntry(data, (_isTree, source, at) => {
        this.needed.addBytes(source, at);
      });
      return;
    }
    // A commit's `tree` and `parent` lines, or a tag's `object` line, up to the blank line.
    let end = 0;
    while (end < data.length && !(data[end] === 0x0a && data[end + 1] === 0x0a)) end++;
    let found = false;
    for (const line of decodeLatin1(data.subarray(0, end)).split("\n")) {
      const key =
        type === "commit" ? /^(?:tree|parent) ([0-9a-f]{40})$/ : /^object ([0-9a-f]{40})$/;
      const match = key.exec(line);
      if (match) {
        this.needed.add(match[1]!);
        found = true;
      }
    }
    if (!found) throw new GitError("bad-object", `a ${type} in the pack names no object`);
  }

  get size(): number {
    return this.needed.size;
  }

  /**
   * The first id that neither side has, or null when the pack is complete.
   * `inPack` is asked first: for most ids it is the answer, and it is a
   * lookup in memory.
   */
  async firstMissing(
    inPack: (oid: ObjectId) => boolean,
    inRepository: (oid: ObjectId) => Promise<boolean> | boolean,
  ): Promise<ObjectId | null> {
    const bytes = this.needed.list.bytes;
    for (let index = 0; index < this.needed.size; index++) {
      const oid = toHex(bytes, index * 20, index * 20 + 20);
      if (inPack(oid)) continue;
      if (!(await inRepository(oid))) return oid;
    }
    return null;
  }
}
