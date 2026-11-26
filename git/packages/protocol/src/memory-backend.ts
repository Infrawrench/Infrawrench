/**
 * A repository in memory: the backend the protocol's own tests run against,
 * and a reference for what a storage implementation has to do. It keeps
 * each pack it was pushed as bytes and reads objects out of them, the way
 * the worker's Durable Object does over R2.
 */
import {
  GitError,
  type GitObject,
  type ObjectId,
  type ObjectReader,
  PackIndex,
  PackIndexer,
  type Ref,
  type RefUpdate,
  ZERO_OID,
  concatBytes,
  memoryRangeReader,
  readPackObjectAt,
  streamOf,
  writePackIndex,
} from "@infrawrench/git-core";
import type { IngestedPack, RefUpdateResult, RepositoryBackend } from "./backend";
import { ConnectivityCheck } from "./connectivity";

interface StoredPack {
  readonly bytes: Uint8Array;
  readonly index: PackIndex;
  /** No delta in it leans on an object outside it. */
  readonly selfContained: boolean;
}

interface StagedPack extends IngestedPack {
  readonly pack: StoredPack | null;
}

const CACHE_BYTES = 64 * 1024 * 1024;

export class MemoryBackend implements RepositoryBackend {
  readonly packs: StoredPack[] = [];
  readonly refs = new Map<string, ObjectId>();
  headRef: string | null = "refs/heads/main";
  /** Whether `packEverything` may answer with the stored pack. Tests turn it off to force a walk. */
  serveStoredPack = true;
  /**
   * Cleared once a ref is deleted, moved or made outside branches and tags:
   * from then on the stored pack may hold what no branch or tag reaches, so
   * a clone walks. (A pack pushed with objects nothing names is not caught
   * here; the worker's backend checks that too.)
   */
  private everythingReachable = true;
  private readonly cache = new Map<ObjectId, GitObject>();
  private cached = 0;

  private async readFrom(packs: readonly StoredPack[], oid: ObjectId): Promise<GitObject | null> {
    const hit = this.cache.get(oid);
    if (hit) return hit;
    for (const pack of packs) {
      const record = pack.index.lookup(oid);
      if (!record) continue;
      const object = await readPackObjectAt(memoryRangeReader(pack.bytes), record.offset, {
        resolveBase: (base) => this.readFrom(packs, base),
      });
      this.cache.set(oid, object);
      this.cached += object.data.length;
      while (this.cached > CACHE_BYTES) {
        const oldest = this.cache.keys().next().value!;
        this.cached -= this.cache.get(oldest)!.data.length;
        this.cache.delete(oldest);
      }
      return object;
    }
    return null;
  }

  read(oid: ObjectId): Promise<GitObject | null> {
    return this.readFrom(this.packs, oid);
  }

  async has(oid: ObjectId): Promise<boolean> {
    return this.packs.some((pack) => pack.index.has(oid));
  }

  async listRefs(): Promise<Ref[]> {
    return [...this.refs].map(([name, oid]) => ({ name, oid }));
  }

  async head(): Promise<string | null> {
    return this.headRef;
  }

  async ingestPack(pack: ReadableStream<Uint8Array>): Promise<IngestedPack> {
    const chunks: Uint8Array[] = [];
    let bytes: Uint8Array | null = null;
    const check = new ConnectivityCheck();
    const indexer = new PackIndexer({
      bases: this,
      readRange: (offset, length) =>
        memoryRangeReader((bytes ??= concatBytes(chunks)))(offset, length),
      onObject: (object, data) => check.note(object.type, data),
    });
    const reader = pack.getReader();
    try {
      while (!indexer.done) {
        const { done, value } = await reader.read();
        if (done) break;
        const extra = indexer.write(value);
        chunks.push(extra > 0 ? value.subarray(0, value.length - extra) : value);
        await indexer.settle();
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const result = await indexer.finish();
    const index = new PackIndex(writePackIndex(result.objects, result.checksum));
    const missing = await check.firstMissing(
      (oid) => index.has(oid),
      (oid) => this.has(oid),
    );
    if (missing) throw new GitError("missing-object", `missing necessary object ${missing}`);
    const stored: StoredPack | null =
      result.objectCount === 0
        ? null
        : {
            bytes: (bytes ??= concatBytes(chunks)),
            index,
            selfContained: result.externalBases.length === 0,
          };
    const visible = stored ? [...this.packs, stored] : this.packs;
    const combined: ObjectReader = {
      read: (oid) => this.readFrom(visible, oid),
      has: async (oid) => visible.some((each) => each.index.has(oid)),
    };
    const staged: StagedPack = {
      objectCount: result.objectCount,
      size: result.size,
      reader: combined,
      pack: stored,
    };
    return staged;
  }

  async updateRefs(
    updates: readonly RefUpdate[],
    options: { readonly atomic: boolean; readonly pack?: IngestedPack | null },
  ): Promise<RefUpdateResult[]> {
    const results = updates.map((update): RefUpdateResult => {
      const current = this.refs.get(update.name) ?? ZERO_OID;
      if (current === update.oldOid) return { name: update.name, error: null };
      return {
        name: update.name,
        error: current === ZERO_OID ? "reference does not exist" : "stale info",
      };
    });
    const failed = results.some((result) => result.error !== null);
    if (options.atomic && failed) {
      return results.map((result) => ({
        name: result.name,
        error: result.error ?? "atomic push failure",
      }));
    }
    if (results.every((result) => result.error !== null)) return results;
    const staged = (options.pack as StagedPack | null | undefined)?.pack;
    if (staged) this.packs.push(staged);
    updates.forEach((update, index) => {
      if (results[index]!.error !== null) return;
      const branchOrTag =
        update.name.startsWith("refs/heads/") || update.name.startsWith("refs/tags/");
      if (update.oldOid !== ZERO_OID || !branchOrTag) this.everythingReachable = false;
      if (update.newOid === ZERO_OID) this.refs.delete(update.name);
      else this.refs.set(update.name, update.newOid);
    });
    return results;
  }

  async discardPack(): Promise<void> {}

  async packEverything(options: {
    readonly ofsDelta: boolean;
  }): Promise<{ stream: ReadableStream<Uint8Array>; objectCount: number } | null> {
    const only = this.packs.length === 1 ? this.packs[0]! : null;
    // One pack that stands alone is already the answer. A client without
    // `ofs-delta` could not read it as stored.
    if (!this.serveStoredPack || !this.everythingReachable) return null;
    if (!only || !only.selfContained || !options.ofsDelta) return null;
    const chunks: Uint8Array[] = [];
    for (let at = 0; at < only.bytes.length; at += 1 << 20) {
      chunks.push(only.bytes.subarray(at, at + (1 << 20)));
    }
    return { stream: streamOf(...chunks), objectCount: only.index.count };
  }
}
