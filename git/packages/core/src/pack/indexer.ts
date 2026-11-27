/**
 * Indexes a pack as it streams in: every object's id, type, size, offset
 * and CRC-32, with deltas resolved, in bounded memory.
 *
 * It works in two passes. While the pack streams past (`write`), whole
 * objects are hashed as they inflate, and a delta is resolved on the spot
 * when its base is still in the cache, which for a pack git wrote is nearly
 * always: git puts a base before its deltas. Whatever is left (a base that
 * had been evicted, a `ref-delta` to something later in the pack or outside
 * it) is resolved in `finish`, which reads the entries it needs back by
 * byte range. NOTES.md has the memory accounting.
 */
import { GitError } from "../errors";
import { toHex, writeHex } from "../hex";
import { inflateSync } from "../inflate";
import { hashObjectBytes, objectHeader } from "../object/hash";
import { Sha1 } from "../sha1";
import { type ByteSource, iterateBytes } from "../stream";
import type { ObjectId, ObjectReader, ObjectType } from "../types";
import { type ReadRange, cachedRangeReader } from "./access";
import { applyDelta, readDeltaHeader } from "./delta";
import { type PackEntry, type PackEntryHeader, isDeltaType, packTypeCode } from "./entry";
import { ByteLru } from "./lru";
import { PackParser, type PackSummary } from "./reader";

const OFS_DELTA = 6;
const REF_DELTA = 7;
const OBJECT_TYPES: ReadonlyArray<ObjectType> = ["blob", "commit", "tree", "blob", "tag"];

export interface IndexedObject {
  readonly oid: ObjectId;
  readonly type: ObjectType;
  /** The object's own size, also for an object stored as a delta. */
  readonly size: number;
  /** Where its entry starts in the pack. */
  readonly offset: number;
  /** CRC-32 of its packed bytes. */
  readonly crc32: number;
}

/**
 * The objects of an indexed pack, in pack order. It is a table of typed
 * arrays rather than an array of objects: a pack can hold a million entries
 * and this keeps them at about 40 bytes each.
 */
export class IndexedObjects implements Iterable<IndexedObject> {
  readonly count: number;
  private readonly offsets: Float64Array;
  private readonly sizes: Float64Array;
  private readonly crcs: Uint32Array;
  private readonly oids: Uint8Array;
  private readonly types: Uint8Array;

  constructor(
    count: number,
    offsets: Float64Array,
    sizes: Float64Array,
    crcs: Uint32Array,
    oids: Uint8Array,
    types: Uint8Array,
  ) {
    this.count = count;
    this.offsets = offsets;
    this.sizes = sizes;
    this.crcs = crcs;
    this.oids = oids;
    this.types = types;
  }

  oid(index: number): ObjectId {
    return toHex(this.oids, index * 20, index * 20 + 20);
  }

  /** Copies the raw 20-byte id, for building an index without making a string per object. */
  copyOid(index: number, target: Uint8Array, at: number): void {
    target.set(this.oids.subarray(index * 20, index * 20 + 20), at);
  }

  offset(index: number): number {
    return this.offsets[index]!;
  }

  size(index: number): number {
    return this.sizes[index]!;
  }

  crc32(index: number): number {
    return this.crcs[index]!;
  }

  type(index: number): ObjectType {
    return OBJECT_TYPES[this.types[index]!]!;
  }

  get(index: number): IndexedObject {
    return {
      oid: this.oid(index),
      type: this.type(index),
      size: this.size(index),
      offset: this.offset(index),
      crc32: this.crc32(index),
    };
  }

  *[Symbol.iterator](): Iterator<IndexedObject> {
    for (let i = 0; i < this.count; i++) yield this.get(i);
  }
}

export interface PackIndexerOptions {
  /**
   * Reads bytes of the same pack back by range. `finish` needs it when some
   * delta could not be resolved while streaming; the pack must be readable
   * through it by the time `finish` is called.
   */
  readonly readRange?: ReadRange;
  /** The repository's existing objects, for the `ref-delta` bases a thin pack leaves out. */
  readonly bases?: ObjectReader;
  /** Budget for the cache of resolved objects that later deltas may build on. Default 32 MiB. */
  readonly cacheBytes?: number;
  /**
   * Budget for deltas kept from the stream because their base was not at
   * hand, so `finish` need not read them back. Default 8 MiB.
   */
  readonly heldDeltaBytes?: number;
  /** Refuse a pack with more objects than this. */
  readonly maxObjects?: number;
  /**
   * Refuse an object over this size that has to be held whole: any commit,
   * tree or tag, and anything that is a delta or a delta's base. A blob
   * stored whole is hashed as a stream and is not subject to it. Default
   * 32 MiB: applying a delta holds the base and the result together, and an
   * entry's header can claim any size before a byte of it has arrived.
   */
  readonly maxObjectBytes?: number;
  /**
   * Refuse a pack once its entries add up to more than this many bytes
   * inflated, counting each entry's declared size, each delta's result, and
   * every object `finish` has to rebuild because the cache had let it go.
   * It bounds the work one pack can ask for: a few megabytes of deltas that
   * each copy a large base can otherwise describe terabytes to rebuild and
   * hash. Checked before the bytes are produced. Default: no limit.
   */
  readonly maxInflatedBytes?: number;
  /** Block size for the read-ahead in front of `readRange`; 0 to call it directly. Default 512 KiB. */
  readonly readAheadBytes?: number;
  /**
   * Objects of at least this size that are in memory anyway have their id
   * computed in a later turn (`hashObjectBytes`) instead of in line. Default
   * `Infinity`: every id comes from `Sha1` with collision detection, which
   * WebCrypto's SHA-1 does not have, so there is no faster hash to hand an
   * object to and deferring gains nothing. A finite value still works.
   */
  readonly nativeHashBytes?: number;
  /**
   * How many bytes of objects may be waiting for a deferred id at once. Past
   * it an object is hashed in line instead, so a caller that never yields
   * between writes still stays in bounds. Default 8 MiB.
   */
  readonly hashQueueBytes?: number;
  /**
   * Called once per object as its id becomes known, in no particular order.
   * `data` is the content whenever it was in memory: always for commits,
   * trees and tags, and for blobs except large ones stored whole. This is
   * the hook for checking what a push brings without reading it again.
   */
  readonly onObject?: (object: IndexedObject, data: Uint8Array | null) => void;
}

export interface PackIndexStats {
  /** Deltas resolved as they streamed past. */
  readonly resolvedInline: number;
  /** Deltas resolved in `finish`. */
  readonly resolvedLater: number;
  /** Calls made to `readRange` (after read-ahead). */
  readonly rangeReads: number;
}

export interface PackIndexResult extends PackSummary {
  readonly objects: IndexedObjects;
  /** Ids of objects outside the pack that its deltas build on. Not empty means the pack is thin. */
  readonly externalBases: readonly ObjectId[];
  readonly stats: PackIndexStats;
}

/** External bases live in the cache and in `baseIndex` under negative keys: base k is -(k + 2). */
function externalKey(k: number): number {
  return -(k + 2);
}

export class PackIndexer {
  private readonly options: PackIndexerOptions;
  private readonly parser: PackParser;
  private readonly cache: ByteLru<number>;
  private readonly cacheEntryLimit: number;
  private readonly heldLimit: number;
  private readonly maxObjectBytes: number;
  /** Inflated bytes the entries so far have declared or produced, for `maxInflatedBytes`. */
  private inflatedBytes = 0;
  private readonly hasher = new Sha1();
  private readonly nativeHashMin: number;
  private readonly hashQueueLimit: number;
  private hashQueued = 0;
  private readonly hashJobs = new Set<Promise<void>>();
  /** Entries resolved but not yet hashed: their slot in `oids` does not hold their id yet. */
  private readonly hashPending = new Set<number>();
  private hashError: unknown = null;
  /** The current whole object is being left for WebCrypto, so the stream is not hashed as it passes. */
  private hashingLater = false;

  private count = 0;
  private offsets: Float64Array = new Float64Array(0);
  private sizes: Float64Array = new Float64Array(0);
  private crcs: Uint32Array = new Uint32Array(0);
  /** An object's id once resolved; until then, for a `ref-delta`, the id of its base. */
  private oids: Uint8Array = new Uint8Array(0);
  private packedTypes: Uint8Array = new Uint8Array(0);
  /** 0 until resolved, then the pack type code of the object (1 to 4). */
  private types: Uint8Array = new Uint8Array(0);
  private baseIndex: Int32Array = new Int32Array(0);
  private headerLengths: Uint8Array = new Uint8Array(0);

  private resolved = 0;
  private resolvedInline = 0;
  private resolvedLater = 0;
  private rangeReads = 0;

  private readonly held = new Map<number, Uint8Array>();
  private heldBytes = 0;
  /** Ids of cached objects, kept only once a `ref-delta` shows up to ask for one. */
  private cachedOids: Map<string, number> | null = null;

  private readonly externalOids: ObjectId[] = [];

  private current = -1;
  private collecting: Uint8Array | null = null;
  private collected = 0;
  private readonly deltaStart = new Uint8Array(32);
  private deltaStartLength = 0;

  constructor(options: PackIndexerOptions = {}) {
    this.options = options;
    const cacheBytes = options.cacheBytes ?? 32 * 1024 * 1024;
    // One object may take a quarter of the cache, so a few large ones cannot empty it.
    this.cacheEntryLimit = Math.floor(cacheBytes / 4);
    this.heldLimit = options.heldDeltaBytes ?? 8 * 1024 * 1024;
    this.nativeHashMin = options.nativeHashBytes ?? Number.POSITIVE_INFINITY;
    this.hashQueueLimit = options.hashQueueBytes ?? 8 * 1024 * 1024;
    this.maxObjectBytes = options.maxObjectBytes ?? 32 * 1024 * 1024;
    this.cache = new ByteLru<number>(cacheBytes, (key) => {
      if (this.cachedOids && key >= 0 && !this.hashPending.has(key)) {
        this.cachedOids.delete(this.oidAt(key));
      }
    });
    this.parser = new PackParser({
      onHeader: (header) => {
        if (options.maxObjects !== undefined && header.objectCount > options.maxObjects) {
          throw new GitError("limit", `pack has ${header.objectCount} objects, over the limit`);
        }
        // The count is the sender's claim: grow towards it rather than trusting it with one allocation.
        this.grow(Math.min(header.objectCount, 4096));
      },
      onEntry: (entry) => this.startEntry(entry),
      onData: (chunk) => this.entryData(chunk),
      onEntryEnd: (entry) => this.endEntry(entry),
    });
  }

  /**
   * Feeds the next bytes of the pack. Returns how many bytes at the end of
   * `chunk` came after the pack: 0 until it is complete.
   */
  write(chunk: Uint8Array): number {
    return this.parser.write(chunk);
  }

  /** True once the whole pack, trailer included, has been written. */
  get done(): boolean {
    return this.parser.done;
  }

  /** Resolves what streaming left and returns the index. Throws when the pack is incomplete or unsound. */
  async finish(): Promise<PackIndexResult> {
    const summary = this.parser.finish();
    await this.settleHashes();
    if (this.resolved < this.count) await this.resolveRest(summary.size - 20);
    const n = this.count;
    return {
      ...summary,
      objects: new IndexedObjects(
        n,
        this.offsets.subarray(0, n),
        this.sizes.subarray(0, n),
        this.crcs.subarray(0, n),
        this.oids.subarray(0, n * 20),
        this.types.subarray(0, n),
      ),
      externalBases: this.externalOids,
      stats: {
        resolvedInline: this.resolvedInline,
        resolvedLater: this.resolvedLater,
        rangeReads: this.rangeReads,
      },
    };
  }

  private grow(capacity: number): void {
    if (capacity <= this.offsets.length) return;
    const size = Math.max(capacity, this.offsets.length * 2, 64);
    const float = (old: Float64Array): Float64Array => {
      const next = new Float64Array(size);
      next.set(old);
      return next;
    };
    const bytes = (old: Uint8Array, width: number): Uint8Array => {
      const next = new Uint8Array(size * width);
      next.set(old);
      return next;
    };
    this.offsets = float(this.offsets);
    this.sizes = float(this.sizes);
    const crcs = new Uint32Array(size);
    crcs.set(this.crcs);
    this.crcs = crcs;
    this.oids = bytes(this.oids, 20);
    this.packedTypes = bytes(this.packedTypes, 1);
    this.types = bytes(this.types, 1);
    this.headerLengths = bytes(this.headerLengths, 1);
    const baseIndex = new Int32Array(size);
    baseIndex.set(this.baseIndex);
    this.baseIndex = baseIndex;
  }

  private oidAt(index: number): string {
    return toHex(this.oids, index * 20, index * 20 + 20);
  }

  private objectAt(index: number): IndexedObject {
    return {
      oid: this.oidAt(index),
      type: OBJECT_TYPES[this.types[index]!]!,
      size: this.sizes[index]!,
      offset: this.offsets[index]!,
      crc32: this.crcs[index]!,
    };
  }

  private checkSize(size: number, offset: number): void {
    if (size > this.maxObjectBytes) {
      throw new GitError("limit", `object at ${offset} is ${size} bytes, over the limit`);
    }
  }

  /** Counts `size` inflated bytes against `maxInflatedBytes`, before they are produced. */
  private countInflated(size: number, offset: number): void {
    this.inflatedBytes += size;
    const limit = this.options.maxInflatedBytes;
    if (limit !== undefined && this.inflatedBytes > limit) {
      throw new GitError("limit", `pack inflates past ${limit} bytes at ${offset}`);
    }
  }

  /** The entry that starts exactly at `offset`, among those seen so far. */
  private indexOfOffset(offset: number): number {
    let low = 0;
    let high = this.count - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const value = this.offsets[middle]!;
      if (value === offset) return middle;
      if (value < offset) low = middle + 1;
      else high = middle - 1;
    }
    return -1;
  }

  private startEntry(entry: PackEntryHeader): void {
    const index = this.count;
    let base = -1;
    if (entry.type === "ofs-delta") {
      base = this.indexOfOffset(entry.baseOffset!);
      if (base < 0) {
        throw new GitError("bad-pack", `delta at ${entry.offset} has no entry at its base offset`);
      }
    }
    this.countInflated(entry.size, entry.offset);
    this.grow(index + 1);
    this.count = index + 1;
    this.current = index;
    this.offsets[index] = entry.offset;
    this.sizes[index] = entry.size;
    this.headerLengths[index] = entry.headerLength;
    this.packedTypes[index] = packTypeCode(entry.type);
    this.types[index] = 0;
    this.baseIndex[index] = base;
    this.collected = 0;
    this.deltaStartLength = 0;
    if (isDeltaType(entry.type)) {
      if (entry.type === "ref-delta") writeHex(entry.baseOid!, this.oids, index * 20);
      // The instructions are held whole to be applied, here or in `finish`.
      this.checkSize(entry.size, entry.offset);
      // A delta too big to keep is only measured now and read back in `finish`.
      this.collecting = entry.size <= this.cacheEntryLimit ? new Uint8Array(entry.size) : null;
      return;
    }
    if (entry.type === "blob") {
      this.collecting = entry.size <= this.cacheEntryLimit ? new Uint8Array(entry.size) : null;
    } else {
      this.checkSize(entry.size, entry.offset);
      this.collecting = new Uint8Array(entry.size);
    }
    this.hashingLater = this.collecting !== null && this.canHashNatively(entry.size);
    if (!this.hashingLater) this.hasher.reset().update(objectHeader(entry.type, entry.size));
  }

  private entryData(chunk: Uint8Array): void {
    const index = this.current;
    const delta = this.packedTypes[index]! >= OFS_DELTA;
    if (!delta && !this.hashingLater) this.hasher.update(chunk);
    if (this.collecting) {
      this.collecting.set(chunk, this.collected);
      this.collected += chunk.length;
    } else if (delta && this.deltaStartLength < this.deltaStart.length) {
      const take = Math.min(chunk.length, this.deltaStart.length - this.deltaStartLength);
      this.deltaStart.set(chunk.subarray(0, take), this.deltaStartLength);
      this.deltaStartLength += take;
    }
  }

  private endEntry(entry: PackEntry): void {
    const index = this.current;
    const data = this.collecting;
    this.collecting = null;
    this.crcs[index] = entry.crc32;
    if (!isDeltaType(entry.type)) {
      this.types[index] = this.packedTypes[index]!;
      this.resolved++;
      if (data && data.length <= this.cacheEntryLimit) this.cache.set(index, data);
      if (this.hashingLater && data) {
        this.hashLater(index, data);
      } else {
        this.hasher.digestInto(this.oids, index * 20);
        this.announce(index, data);
      }
      return;
    }
    const start = data ?? this.deltaStart.subarray(0, this.deltaStartLength);
    const { resultSize } = readDeltaHeader(start);
    this.checkSize(resultSize, entry.offset);
    this.countInflated(resultSize, entry.offset);
    this.sizes[index] = resultSize;
    if (!data) return;
    let baseIndex = this.baseIndex[index]!;
    if (entry.type === "ref-delta") {
      this.cachedOids ??= this.indexCachedOids();
      baseIndex = this.cachedOids.get(entry.baseOid!) ?? -1;
    }
    const base =
      baseIndex >= 0 && this.types[baseIndex] !== 0 ? this.cache.get(baseIndex) : undefined;
    if (base) {
      this.baseIndex[index] = baseIndex;
      this.resolvedInline++;
      this.finishDelta(index, this.types[baseIndex]!, applyDelta(base, data));
    } else if (this.heldBytes + data.length <= this.heldLimit) {
      this.held.set(index, data);
      this.heldBytes += data.length;
    }
  }

  private indexCachedOids(): Map<string, number> {
    const map = new Map<string, number>();
    for (const key of this.cache.keys()) {
      if (key >= 0 && !this.hashPending.has(key)) map.set(this.oidAt(key), key);
    }
    return map;
  }

  private canHashNatively(size: number): boolean {
    return size >= this.nativeHashMin && this.hashQueued + size <= this.hashQueueLimit;
  }

  /**
   * Leaves an object's id to a later turn. The object already counts as
   * resolved and deltas can build on it; only its id, and so the `onObject`
   * call, arrive later. `finish` waits for all of these.
   */
  private hashLater(index: number, data: Uint8Array): void {
    this.hashQueued += data.length;
    this.hashPending.add(index);
    const job: Promise<void> = hashObjectBytes(OBJECT_TYPES[this.types[index]!]!, data)
      .then((digest) => {
        // `this.oids` is read now, not captured: the table may have grown since.
        this.oids.set(digest, index * 20);
        this.hashPending.delete(index);
        this.announce(index, data);
      })
      .catch((error: unknown) => {
        this.hashError ??= error;
      })
      .finally(() => {
        this.hashQueued -= data.length;
        this.hashJobs.delete(job);
      });
    this.hashJobs.add(job);
  }

  private async settleHashes(): Promise<void> {
    while (this.hashJobs.size > 0) await Promise.all(this.hashJobs);
    if (this.hashError !== null) throw this.hashError;
  }

  /**
   * Waits for hashing handed to WebCrypto to catch up, once enough is
   * queued to matter. A caller whose source never waits on I/O (a pack
   * already in memory) calls this between writes; without it the queue
   * fills and hashing falls back to the slower synchronous path.
   */
  async settle(): Promise<void> {
    if (this.hashQueued * 2 >= this.hashQueueLimit) await this.settleHashes();
  }

  /** A delta's result: the object is resolved and cached, and hashed now or handed to WebCrypto. */
  private finishDelta(index: number, type: number, data: Uint8Array): void {
    this.types[index] = type;
    this.resolved++;
    if (data.length <= this.cacheEntryLimit) this.cache.set(index, data);
    if (this.canHashNatively(data.length)) {
      this.hashLater(index, data);
      return;
    }
    this.hasher.reset().update(objectHeader(OBJECT_TYPES[type]!, data.length)).update(data);
    this.hasher.digestInto(this.oids, index * 20);
    this.announce(index, data);
  }

  /** The object's id is now in the table: make it findable as a base and tell the caller. */
  private announce(index: number, data: Uint8Array | null): void {
    if (this.cachedOids && this.cache.has(index)) this.cachedOids.set(this.oidAt(index), index);
    this.options.onObject?.(this.objectAt(index), data);
  }

  private async resolveRest(trailerOffset: number): Promise<void> {
    const n = this.count;
    const source = this.options.readRange;
    const counted: ReadRange | null = source
      ? (offset, length) => {
          this.rangeReads++;
          return source(offset, length);
        }
      : null;
    const readAhead = this.options.readAheadBytes ?? 512 * 1024;
    const read =
      counted && readAhead > 0 ? cachedRangeReader(counted, { blockSize: readAhead }) : counted;

    // Children of each entry, as linked lists threaded through two arrays.
    const firstChild = new Int32Array(n).fill(-1);
    const nextSibling = new Int32Array(n).fill(-1);
    const waiting = new Map<string, number[]>();
    for (let i = n - 1; i >= 0; i--) {
      if (this.types[i] !== 0) continue;
      if (this.packedTypes[i] === OFS_DELTA) {
        const base = this.baseIndex[i]!;
        nextSibling[i] = firstChild[base]!;
        firstChild[base] = i;
      } else {
        const oid = this.oidAt(i);
        const list = waiting.get(oid);
        if (list) list.push(i);
        else waiting.set(oid, [i]);
      }
    }

    const readEntry = async (index: number): Promise<Uint8Array> => {
      if (!read) {
        throw new GitError("bad-pack", "this pack's deltas cannot be resolved without readRange");
      }
      const offset = this.offsets[index]!;
      const length = (index + 1 < n ? this.offsets[index + 1]! : trailerOffset) - offset;
      const bytes = await read(offset, length);
      if (bytes.length !== length) {
        throw new GitError("bad-pack", `readRange returned ${bytes.length} of ${length} bytes`);
      }
      const headerLength = this.headerLengths[index]!;
      const whole = this.packedTypes[index]! < OFS_DELTA;
      const { data, consumed } = inflateSync(bytes, {
        offset: headerLength,
        // For a delta the table now holds the object's size, not the delta's.
        ...(whole ? { size: this.sizes[index]! } : { maxSize: this.maxObjectBytes }),
      });
      if (consumed !== length - headerLength) {
        throw new GitError("bad-pack", `entry at ${offset} changed since it was streamed`);
      }
      return data;
    };

    const deltaData = async (index: number): Promise<Uint8Array> =>
      this.held.get(index) ?? (await readEntry(index));

    /** The content of a resolved entry or external base: from the cache, or rebuilt from the pack. */
    const materialize = async (start: number): Promise<Uint8Array> => {
      const chain: number[] = [];
      let at = start;
      let data: Uint8Array | undefined;
      for (;;) {
        data = this.cache.get(at);
        if (data) break;
        if (at < 0) {
          const oid = this.externalOids[-at - 2]!;
          const object = await this.options.bases?.read(oid);
          if (!object) throw new GitError("missing-object", `delta base ${oid} is missing`);
          data = object.data;
          this.cache.set(at, data);
          break;
        }
        if (this.packedTypes[at]! < OFS_DELTA) {
          this.checkSize(this.sizes[at]!, this.offsets[at]!);
          // Rebuilding what the cache let go is work too, and a long chain
          // of large objects would otherwise be rebuilt once per link.
          this.countInflated(this.sizes[at]!, this.offsets[at]!);
          data = await readEntry(at);
          this.cache.set(at, data);
          break;
        }
        chain.push(at);
        at = this.baseIndex[at]!;
      }
      for (let i = chain.length - 1; i >= 0; i--) {
        const index = chain[i]!;
        this.countInflated(this.sizes[index]!, this.offsets[index]!);
        data = applyDelta(data, await deltaData(index));
        this.cache.set(index, data);
      }
      return data;
    };

    const hasChildren = (index: number): boolean =>
      firstChild[index]! >= 0 || (waiting.size > 0 && waiting.has(this.oidAt(index)));

    const stack: number[] = [];

    /** Resolves every delta directly on `parent`, whose content is `base`. */
    const resolveChildren = async (
      parent: number,
      type: number,
      base: Uint8Array,
      children: number[],
    ): Promise<void> => {
      const next: number[] = [];
      for (const child of children) {
        if (this.types[child] !== 0) continue;
        const delta = await deltaData(child);
        this.baseIndex[child] = parent;
        this.resolvedLater++;
        this.finishDelta(child, type, applyDelta(base, delta));
        // Whether something waits on this object by id cannot be asked before the id exists.
        if (waiting.size > 0) await this.settleHashes();
        else await this.settle();
        if (hasChildren(child)) next.push(child);
      }
      // Reversed, so the lowest offset is popped first and reads move forward through the pack.
      for (let i = next.length - 1; i >= 0; i--) stack.push(next[i]!);
    };

    const drain = async (): Promise<void> => {
      while (stack.length > 0) {
        const parent = stack.pop()!;
        const children: number[] = [];
        for (let child = firstChild[parent]!; child >= 0; child = nextSibling[child]!) {
          children.push(child);
        }
        if (waiting.size > 0) {
          const oid = this.oidAt(parent);
          const byOid = waiting.get(oid);
          if (byOid) {
            waiting.delete(oid);
            for (let i = byOid.length - 1; i >= 0; i--) children.push(byOid[i]!);
          }
        }
        if (children.length === 0) continue;
        await resolveChildren(parent, this.types[parent]!, await materialize(parent), children);
      }
    };

    for (let i = n - 1; i >= 0; i--) {
      if (this.types[i] !== 0 && hasChildren(i)) stack.push(i);
    }
    await drain();

    // What still waits has no base in the pack: the pack is thin and the repository must have it.
    while (waiting.size > 0) {
      const [oid, children] = waiting.entries().next().value!;
      waiting.delete(oid);
      const object = await this.options.bases?.read(oid);
      if (!object) {
        throw new GitError(
          "missing-object",
          `delta base ${oid} is in neither the pack nor the repository`,
        );
      }
      this.checkSize(object.data.length, this.offsets[children[0]!]!);
      const key = externalKey(this.externalOids.length);
      this.externalOids.push(oid);
      this.cache.set(key, object.data);
      children.reverse();
      await resolveChildren(key, packTypeCode(object.type), object.data, children);
      await drain();
    }

    await this.settleHashes();
    if (this.resolved !== n) {
      throw new GitError("bad-pack", `${n - this.resolved} deltas have no base to build on`);
    }
  }
}

/** Indexes a whole pack from a stream. See `PackIndexer` for what the options need. */
export async function indexPack(
  source: ByteSource,
  options: PackIndexerOptions = {},
): Promise<PackIndexResult> {
  const indexer = new PackIndexer(options);
  for await (const chunk of iterateBytes(source)) {
    if (indexer.write(chunk) > 0)
      throw new GitError("bad-pack", "data follows the end of the pack");
    await indexer.settle();
  }
  return indexer.finish();
}
