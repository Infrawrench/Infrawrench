/**
 * The repository's packs: where they are in R2, their indexes in memory,
 * and reading an object out of them by byte range.
 */
import {
  GitError,
  type GitObject,
  type ObjectId,
  PackIndex,
  RangeBlockCache,
  type ReadRange,
  acquireInflater,
  applyDelta,
  decodeEntryHeader,
  isDeltaType,
  memoryRangeReader,
  readDeltaHeader,
  readPackEntryAt,
  releaseInflater,
} from "@infrawrench/git-core";
import type { Bucket, Sql } from "./platform";

export const repoPrefix = (repoId: string): string => `repos/${repoId}/`;
export const packKey = (repoId: string, packId: string): string =>
  `${repoPrefix(repoId)}packs/pack-${packId}.pack`;
export const idxKey = (repoId: string, packId: string): string =>
  `${repoPrefix(repoId)}packs/pack-${packId}.idx`;

/** Anything read whole into memory is at most this: half of what a Durable Object has. */
export const MAX_OBJECT_BYTES = 64 * 1024 * 1024;

/** Reads of the bucket a repository has made, for the line a fetch logs when it ends. */
export interface ReadCount {
  gets: number;
  bytes: number;
}

/** Reads a stored object's bytes by range: one R2 request a call. */
export function rangeFetcher(
  bucket: Bucket,
  key: string,
  size: number,
  count?: ReadCount,
): ReadRange {
  return async (offset, length) => {
    const available = Math.min(length, size - offset);
    if (available <= 0) return new Uint8Array(0);
    if (count) {
      count.gets++;
      count.bytes += available;
    }
    const object = await bucket.get(key, { range: { offset, length: available } });
    if (!object) throw new Error(`${key} is missing from storage`);
    return new Uint8Array(await object.arrayBuffer());
  };
}

/**
 * The block cache a repository's packs share: 256 KiB a block, 12 MiB in
 * all, whatever the number of packs. A walk reads trees wherever a push
 * left them, and git writes a pushed pack in the order it walked: a tree,
 * then the files in it. So a walk moves through a pack front to back, and
 * a block missed right after the one before it was used brings the next
 * two with it.
 */
export const newBlockCache = (): RangeBlockCache =>
  new RangeBlockCache({ blockSize: 256 * 1024, maxBlocks: 48, readAhead: 2 });

/** Enough of an entry for its header and the start of a delta's zlib stream. */
const SIZE_PROBE_BYTES = [128, 4096] as const;
/** Two sizes of at most ten bytes each open a delta's instructions. */
const DELTA_SIZES_BYTES = 20;

export type PackState = "incoming" | "live" | "garbage";

export interface PackRow {
  readonly id: string;
  readonly seq: number;
  readonly state: PackState;
  readonly checksum: string | null;
  readonly size: number;
  readonly idx_size: number;
  readonly objects: number;
  readonly self_contained: number;
  readonly upload_id: string | null;
  readonly created_at: number;
  readonly state_at: number;
}

/** A pack with its index loaded: what reads go through. */
export class PackHandle {
  /** Reads through a block cache: many small reads close together become few R2 requests. */
  readonly read: ReadRange;
  /** One R2 range request a call, uncached. */
  readonly fetchRange: ReadRange;
  private sortedOffsets: Float64Array | null = null;
  private sortedPositions: Uint32Array | null = null;

  constructor(
    readonly id: string,
    readonly key: string,
    readonly size: number,
    readonly selfContained: boolean,
    readonly index: PackIndex,
    bucket: Bucket,
    /** The whole pack, kept for a small one so reading it back costs nothing. */
    memory: Uint8Array | null = null,
    /** The repository's block cache. Without one the pack has a small one to itself. */
    blocks: RangeBlockCache = new RangeBlockCache({ blockSize: 256 * 1024, maxBlocks: 16 }),
    count?: ReadCount,
  ) {
    this.fetchRange = memory ? memoryRangeReader(memory) : rangeFetcher(bucket, key, size, count);
    this.read = memory ? this.fetchRange : blocks.reader(id, this.fetchRange, size);
  }

  /**
   * Entry offsets in file order, with each one's position in the index. An
   * entry ends where the next begins, which is the only way to know its
   * length without inflating it. Built on first use: 12 bytes an object.
   */
  private layout(): { offsets: Float64Array; positions: Uint32Array } {
    if (!this.sortedOffsets || !this.sortedPositions) {
      const n = this.index.count;
      const order = new Uint32Array(n);
      const offsets = new Float64Array(n);
      for (let position = 0; position < n; position++) {
        order[position] = position;
        offsets[position] = this.index.offsetAt(position);
      }
      order.sort((a, b) => offsets[a]! - offsets[b]!);
      const sorted = new Float64Array(n);
      for (let i = 0; i < n; i++) sorted[i] = offsets[order[i]!]!;
      this.sortedOffsets = sorted;
      this.sortedPositions = order;
    }
    return { offsets: this.sortedOffsets, positions: this.sortedPositions };
  }

  /** Where `offset` falls in file order, or -1 when no entry starts there. */
  private rank(offset: number): number {
    const { offsets } = this.layout();
    let low = 0;
    let high = offsets.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const at = offsets[middle]!;
      if (at === offset) return middle;
      if (at < offset) low = middle + 1;
      else high = middle - 1;
    }
    return -1;
  }

  /** The packed length of the entry at `offset`. */
  readonly lengthAt = (offset: number): number | undefined => {
    const rank = this.rank(offset);
    if (rank < 0) return undefined;
    const { offsets } = this.layout();
    const end = rank + 1 < offsets.length ? offsets[rank + 1]! : this.size - 20;
    return end - offset;
  };

  /** The id of the object whose entry starts at `offset`. */
  oidAtOffset(offset: number): ObjectId | null {
    const rank = this.rank(offset);
    return rank < 0 ? null : this.index.oidAt(this.layout().positions[rank]!);
  }
}

/** A least-recently-used cache of whole objects, bounded in bytes. */
class ObjectCache {
  private readonly entries = new Map<string, GitObject>();
  private used = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly maxEntryBytes: number,
  ) {}

  get(key: string): GitObject | undefined {
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
    }
    return hit;
  }

  set(key: string, object: GitObject): void {
    if (object.data.length > this.maxEntryBytes || this.entries.has(key)) return;
    this.entries.set(key, object);
    this.used += object.data.length;
    while (this.used > this.maxBytes) {
      const oldest = this.entries.keys().next().value!;
      this.used -= this.entries.get(oldest)!.data.length;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
    this.used = 0;
  }
}

export interface Located {
  readonly pack: PackHandle;
  readonly offset: number;
}

export class PackStore {
  private readonly handles = new Map<string, PackHandle>();
  private liveList: PackHandle[] | null = null;
  private loading: Promise<PackHandle[]> | null = null;
  private generation = 0;
  /** Keyed by pack and offset, so a delta's base is found without knowing its id. */
  private readonly cache = new ObjectCache(16 * 1024 * 1024, 2 * 1024 * 1024);
  /**
   * Commits, trees and tags of the live packs, by id. Every fetch that is
   * not a plain clone reads the trees of the commits it sends and of the
   * commits the client has, and the next commit's trees are nearly all the
   * last one's: with them kept, the fetch a CI runner makes after a push
   * reads the few trees the push changed. They get a cache to themselves
   * because the other one is soon filled with the files a fetch rebuilds.
   */
  private readonly structure = new ObjectCache(6 * 1024 * 1024, 256 * 1024);
  readonly blocks = newBlockCache();
  /** Range reads of packs since the object woke. */
  readonly reads: ReadCount = { gets: 0, bytes: 0 };

  constructor(
    readonly bucket: Bucket,
    readonly sql: Sql,
    readonly repoId: string,
  ) {}

  rows(state: PackState): PackRow[] {
    return this.sql
      .exec<PackRow>("SELECT * FROM packs WHERE state = ? ORDER BY seq, id", state)
      .toArray();
  }

  /** A handle on one of this repository's packs, reading through its caches. */
  handle(
    id: string,
    size: number,
    selfContained: boolean,
    index: PackIndex,
    memory: Uint8Array | null = null,
  ): PackHandle {
    return new PackHandle(
      id,
      packKey(this.repoId, id),
      size,
      selfContained,
      index,
      this.bucket,
      memory,
      this.blocks,
      this.reads,
    );
  }

  /** Registers a pack whose index is already in memory (one just received). */
  adopt(handle: PackHandle): void {
    this.handles.set(handle.id, handle);
  }

  /** Forgets the cached list of live packs. Call after the catalogue changes. */
  invalidate(): void {
    this.liveList = null;
    this.loading = null;
    this.generation++;
  }

  forget(packId: string): void {
    this.handles.delete(packId);
    this.invalidate();
  }

  /**
   * The repository's packs, oldest first, each with its index loaded. Kept
   * until the catalogue changes: a request works on the list it started
   * with, so a repack that finishes meanwhile changes nothing under it.
   */
  async live(): Promise<PackHandle[]> {
    if (this.liveList) return this.liveList;
    const generation = this.generation;
    this.loading ??= (async () => {
      try {
        const rows = this.rows("live");
        const list = await Promise.all(
          rows.map(async (row) => {
            const known = this.handles.get(row.id);
            if (known) return known;
            const object = await this.bucket.get(idxKey(this.repoId, row.id));
            if (!object) throw new Error(`index of pack ${row.id} is missing from storage`);
            const handle = this.handle(
              row.id,
              row.size,
              row.self_contained === 1,
              new PackIndex(new Uint8Array(await object.arrayBuffer())),
            );
            this.handles.set(row.id, handle);
            return handle;
          }),
        );
        // A pack still being received keeps its handle: it is about to be published.
        const keep = new Set([...rows, ...this.rows("incoming")].map((row) => row.id));
        for (const id of this.handles.keys()) if (!keep.has(id)) this.handles.delete(id);
        // The catalogue changed while the indexes loaded: this list is for this caller only.
        if (generation === this.generation) this.liveList = list;
        return list;
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  /** The oldest pack that has the object. */
  locate(packs: readonly PackHandle[], oid: ObjectId): Located | null {
    for (const pack of packs) {
      const position = pack.index.find(oid);
      if (position >= 0) return { pack, offset: pack.index.offsetAt(position) };
    }
    return null;
  }

  has(packs: readonly PackHandle[], oid: ObjectId): boolean {
    return packs.some((pack) => pack.index.has(oid));
  }

  async read(packs: readonly PackHandle[], oid: ObjectId): Promise<GitObject | null> {
    // Only the repository's own list: a pack still arriving is read by its push alone,
    // and nothing it holds may be answered to anyone else by id.
    const shared = packs === this.liveList;
    if (shared) {
      const kept = this.structure.get(oid);
      if (kept) return kept;
    }
    const located = this.locate(packs, oid);
    if (!located) return null;
    const object = await this.readAt(packs, located.pack, located.offset);
    if (shared && object.type !== "blob" && packs === this.liveList) {
      this.structure.set(oid, object);
    }
    return object;
  }

  /**
   * The object stored at an offset. A delta chain is followed down to a
   * whole object or to one already in the cache, then applied back up, and
   * every step is cached: the objects of a chain are each other's bases,
   * and a walk over history asks for most of them.
   */
  async readAt(
    packs: readonly PackHandle[],
    pack: PackHandle,
    offset: number,
    /** Deltas already followed on the way here: a chain through `ref-delta`s counts them all. */
    depth = 0,
  ): Promise<GitObject> {
    const chain: Array<{ offset: number; delta: Uint8Array }> = [];
    let at = offset;
    let base: GitObject | null = null;
    while (base === null) {
      const cached = this.cache.get(`${pack.id}:${at}`);
      if (cached) {
        base = cached;
        break;
      }
      if (depth + chain.length > 4096) throw new GitError("limit", "delta chain is too long");
      const length = pack.lengthAt(at);
      const entry = await readPackEntryAt(pack.read, at, {
        ...(length !== undefined ? { length } : {}),
        maxSize: MAX_OBJECT_BYTES,
      });
      if (!isDeltaType(entry.type)) {
        base = { type: entry.type, data: entry.data };
        this.cache.set(`${pack.id}:${at}`, base);
      } else if (entry.type === "ofs-delta") {
        chain.push({ offset: at, delta: entry.data });
        at = entry.baseOffset!;
      } else {
        chain.push({ offset: at, delta: entry.data });
        // A thin pack's base: in another pack, or elsewhere in this one.
        const located = this.locate(packs, entry.baseOid!);
        if (!located) {
          throw new GitError("missing-object", `delta base ${entry.baseOid} is missing`);
        }
        base = await this.readAt(packs, located.pack, located.offset, depth + chain.length);
      }
    }
    let object = base;
    for (let i = chain.length - 1; i >= 0; i--) {
      const step = chain[i]!;
      if (readDeltaHeader(step.delta).resultSize > MAX_OBJECT_BYTES) {
        throw new GitError("limit", "object is over the size limit");
      }
      object = { type: object.type, data: applyDelta(object.data, step.delta) };
      this.cache.set(`${pack.id}:${step.offset}`, object);
    }
    return object;
  }

  /**
   * How big an object is, without reading it. A whole object's size is in
   * its entry header; a delta's is the second number at the start of its
   * instructions, which the first bytes of its zlib stream give. Either way
   * it is one small read through the block cache, where the object itself
   * could be megabytes and a chain of them.
   */
  async size(packs: readonly PackHandle[], oid: ObjectId): Promise<number | null> {
    const located = this.locate(packs, oid);
    if (!located) return null;
    const { pack, offset } = located;
    const cached = this.cache.get(`${pack.id}:${offset}`);
    if (cached) return cached.data.length;
    for (const probe of SIZE_PROBE_BYTES) {
      // Its own small range, not the block cache: a file table asks this of blobs scattered
      // over the pack, and their blocks would push out the commits and trees a walk is reading.
      const bytes = await pack.fetchRange(offset, probe);
      const header = decodeEntryHeader(bytes, 0, offset);
      if (!header) continue;
      if (!isDeltaType(header.type)) return header.size;
      const start = new Uint8Array(DELTA_SIZES_BYTES);
      let filled = 0;
      const inflater = acquireInflater();
      try {
        inflater.push(bytes.subarray(header.headerLength), (chunk) => {
          const take = Math.min(chunk.length, start.length - filled);
          start.set(chunk.subarray(0, take), filled);
          filled += take;
        });
      } finally {
        releaseInflater(inflater);
      }
      try {
        return readDeltaHeader(start.subarray(0, filled)).resultSize;
      } catch {
        // The stream's own tables took the whole probe: look again with more of it.
      }
    }
    return (await this.readAt(packs, pack, offset)).data.length;
  }

  /** Deletes a pack's files. The catalogue row is the caller's. */
  async deleteFiles(packId: string): Promise<void> {
    await this.bucket.delete([packKey(this.repoId, packId), idxKey(this.repoId, packId)]);
  }

  clearCaches(): void {
    this.handles.clear();
    this.liveList = null;
    this.cache.clear();
    this.structure.clear();
    this.blocks.clear();
  }
}
