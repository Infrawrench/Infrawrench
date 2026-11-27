/**
 * Writing a pack for a fetch out of the packs already stored, without
 * inflating anything that can be sent as it is. An entry's bytes are copied
 * from R2 to the client; only its header is rewritten, because an
 * `ofs-delta` says how far back its base is and that distance changes. A
 * delta whose base is not going out (and that the client does not have) is
 * the one case that is read whole and compressed again.
 *
 * What decides how fast this is in production is how the bucket is read,
 * not the copying: a read of R2 is a round trip of tens of milliseconds
 * before its first byte, whatever its size. So the entries going out are
 * laid out in file order and read as runs (`ReadPlan`): neighbours share one
 * range request, several requests are in flight at once, and nothing that
 * is not going out is read except the small gaps between neighbours.
 */
import {
  GitError,
  type ObjectId,
  Sha1,
  acquireInflater,
  decodeEntryHeader,
  deflate,
  encodeEntryHeader,
  encodePackHeader,
  isDeltaType,
  readDeltaHeader,
  releaseInflater,
} from "@infrawrench/git-core";
import type { OidSet } from "@infrawrench/git-protocol";
import type { PackHandle, PackStore } from "./pack-store";

/** Entries up to this size are read with their neighbours; larger ones are streamed. */
const STREAM_ENTRY_BYTES = 4 * 1024 * 1024;
const OUT_CHUNK_BYTES = 256 * 1024;
/** One read of the bucket covers at most this much of a pack. */
export const SEGMENT_BYTES = 4 * 1024 * 1024;
/**
 * Entries this close together are read in one request, and the bytes
 * between them thrown away: a round trip costs more than they do.
 */
export const SEGMENT_GAP_BYTES = 64 * 1024;
/** Reads of the bucket in flight or waiting to be used, and the bytes they may hold. */
export const READ_AHEAD = 8;
export const READ_AHEAD_BYTES = 12 * 1024 * 1024;
/** Pieces of one entry too large to hold that are read ahead of the one going out. */
const BIG_ENTRY_AHEAD = 2;
/**
 * Entries looked at ahead of the one being written. Looking is free once
 * an entry's run has been read; it is how a delta that must be rebuilt is
 * found early enough for the reads of its base to overlap with others'.
 */
const PREPARE_AHEAD = 128;
/** An object up to this size is rebuilt ahead of the writer; a larger one waits its turn. */
const REBUILD_OBJECT_BYTES = 512 * 1024;
/** Objects being rebuilt ahead, or rebuilt and not yet written, hold at most this. */
const REBUILD_AHEAD_BYTES = 4 * 1024 * 1024;

/** What to send: `count` objects, each stored at a pack and an offset. */
export interface Selection {
  readonly count: number;
  /** Index into the pack list. */
  pack(index: number): number;
  offset(index: number): number;
  oid(index: number): ObjectId;
  /** Whether an object is part of the selection. */
  has(oid: ObjectId): boolean;
}

/** The objects named by `objects`, each from the oldest pack that has it. */
export function selectByOid(
  store: PackStore,
  packs: readonly PackHandle[],
  objects: OidSet,
): Selection {
  const n = objects.size;
  const packOf = new Uint16Array(n);
  const offsets = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const oid = objects.list.hexAt(i);
    let found = false;
    for (let p = 0; p < packs.length; p++) {
      const position = packs[p]!.index.find(oid);
      if (position < 0) continue;
      packOf[i] = p;
      offsets[i] = packs[p]!.index.offsetAt(position);
      found = true;
      break;
    }
    if (!found) throw new GitError("missing-object", `object ${oid} is missing`);
  }
  return {
    count: n,
    pack: (index) => packOf[index]!,
    offset: (index) => offsets[index]!,
    oid: (index) => objects.list.hexAt(index),
    has: (oid) => objects.has(oid),
  };
}

/** Every object in every pack, once: an object in several packs is taken from the oldest. */
export function selectEverything(packs: readonly PackHandle[]): Selection {
  let capacity = 0;
  for (const pack of packs) capacity += pack.index.count;
  const packOf = new Uint16Array(capacity);
  const positions = new Uint32Array(capacity);
  let n = 0;
  for (let p = 0; p < packs.length; p++) {
    const index = packs[p]!.index;
    for (let position = 0; position < index.count; position++) {
      if (p > 0) {
        const oid = index.oidAt(position);
        let earlier = false;
        for (let q = 0; q < p && !earlier; q++) earlier = packs[q]!.index.has(oid);
        if (earlier) continue;
      }
      packOf[n] = p;
      positions[n] = position;
      n++;
    }
  }
  return {
    count: n,
    pack: (index) => packOf[index]!,
    offset: (index) => packs[packOf[index]!]!.index.offsetAt(positions[index]!),
    oid: (index) => packs[packOf[index]!]!.index.oidAt(positions[index]!),
    // Every base a stored delta names is somewhere in the repository, so it is going out.
    has: () => true,
  };
}

export interface PackStreamOptions {
  /** Objects the client has: a delta against one of them may be sent as it is. */
  readonly thinBases: OidSet | null;
  /** The client reads `ofs-delta`; otherwise every delta names its base by id. */
  readonly ofsDelta: boolean;
}

export function streamPack(
  store: PackStore,
  packs: readonly PackHandle[],
  selection: Selection,
  options: PackStreamOptions,
): ReadableStream<Uint8Array> {
  const iterator = generate(store, packs, selection, options);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return();
    },
  });
}

/** A run of a pack read in one request: the entries at `from` up to `until` in file order. */
interface Segment {
  readonly pack: number;
  readonly start: number;
  readonly end: number;
  readonly from: number;
  readonly until: number;
  /** One entry too large to hold: only its first bytes are read here, the rest is streamed. */
  readonly big: boolean;
}

interface Fetched extends Segment {
  readonly bytes: Promise<Uint8Array>;
}

/** An entry ready to be written, but for an `ofs-delta`'s distance, which depends on what is written before it. */
type Prepared =
  | {
      readonly kind: "copy";
      readonly size: number;
      /** The stored header when it goes out as it is. */
      readonly header: Uint8Array | null;
      /** Otherwise the base: its place in the new pack, or its id. */
      readonly basePlace: number;
      readonly baseOid: ObjectId | null;
      readonly body: Uint8Array;
      /** For an entry that is streamed: where its body starts and how long it is. */
      readonly stream: { readonly offset: number; readonly length: number } | null;
    }
  | Whole
  /** A delta to rebuild whose object is too large to hold ahead of time. */
  | { readonly kind: "rebuild" };

interface Whole {
  readonly kind: "whole";
  readonly header: Uint8Array;
  readonly body: Uint8Array;
  /** What it counts for against the rebuild budget until it is written. */
  readonly held: number;
}

const quiet = <T>(promise: Promise<T>): Promise<T> => {
  // Awaited later, in order. Until then a failure must not count as unhandled.
  promise.catch(() => undefined);
  return promise;
};

async function* generate(
  store: PackStore,
  packs: readonly PackHandle[],
  selection: Selection,
  options: PackStreamOptions,
): AsyncGenerator<Uint8Array, void, void> {
  const n = selection.count;
  // File order within each pack: reads run forward, and an `ofs-delta` base
  // (always earlier in its pack) has been written by the time its delta is.
  const packOf = new Uint16Array(n);
  const offsets = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    packOf[i] = selection.pack(i);
    offsets[i] = selection.offset(i);
  }
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => packOf[a]! - packOf[b]! || offsets[a]! - offsets[b]!);
  /** Where each selected entry landed in the new pack, by its place in `order`. */
  const written = new Float64Array(n);

  /** The place in `order` of the entry at a pack and offset, or -1 when it is not selected. */
  const placeOf = (pack: number, offset: number): number => {
    let low = 0;
    let high = n - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const index = order[middle]!;
      const diff = packOf[index]! - pack || offsets[index]! - offset;
      if (diff === 0) return middle;
      if (diff < 0) low = middle + 1;
      else high = middle - 1;
    }
    return -1;
  };

  const lengthOf = (place: number): number => {
    const index = order[place]!;
    const length = packs[packOf[index]!]!.lengthAt(offsets[index]!);
    if (length === undefined) {
      throw new GitError("bad-index", `no entry at ${offsets[index]!} in a pack`);
    }
    return length;
  };

  // The read plan, made as it is used: a list of every run of a large clone would be a second index.
  let planned = 0;
  const plan = (): Segment | null => {
    if (planned >= n) return null;
    const from = planned;
    const first = order[from]!;
    const pack = packOf[first]!;
    const start = offsets[first]!;
    const length = lengthOf(from);
    planned++;
    if (length > STREAM_ENTRY_BYTES) {
      return { pack, start, end: start + 64, from, until: planned, big: true };
    }
    let end = start + length;
    while (planned < n) {
      const next = order[planned]!;
      if (packOf[next]! !== pack) break;
      const offset = offsets[next]!;
      if (offset - end > SEGMENT_GAP_BYTES) break;
      const nextLength = lengthOf(planned);
      if (nextLength > STREAM_ENTRY_BYTES || offset + nextLength - start > SEGMENT_BYTES) break;
      end = offset + nextLength;
      planned++;
    }
    return { pack, start, end, from, until: planned, big: false };
  };

  /** Runs being read or waiting for the writer, oldest first. */
  const segments: Fetched[] = [];
  let segmentBytes = 0;
  let upcoming: Segment | null = plan();
  /** Entries prepared ahead of the writer, the next one first. */
  const prepared: Array<Promise<Prepared>> = [];
  let nextToPrepare = 0;
  /** Bytes of the objects being rebuilt ahead of the writer, or rebuilt and waiting for it. */
  let rebuilding = 0;

  const rebuild = async (pack: PackHandle, offset: number): Promise<Whole> => {
    const object = await store.readAt(packs, pack, offset);
    return {
      kind: "whole",
      header: encodeEntryHeader(object.type, object.data.length),
      body: await deflate(object.data),
      held: 0,
    };
  };

  const prepare = async (place: number): Promise<Prepared> => {
    const segment = segments.find((each) => place >= each.from && place < each.until);
    if (!segment) throw new GitError("bad-index", "an entry was prepared outside its read");
    const index = order[place]!;
    const packNumber = segment.pack;
    const pack = packs[packNumber]!;
    const offset = offsets[index]!;
    const length = lengthOf(place);
    const bytes = await segment.bytes;
    const head = segment.big
      ? bytes
      : bytes.subarray(offset - segment.start, offset - segment.start + length);
    const header = decodeEntryHeader(head, 0, offset);
    if (!header || (!segment.big && head.length !== length)) {
      throw new GitError("bad-pack", `entry at ${offset} is cut short`);
    }
    const copy = (stored: boolean, basePlace: number, baseOid: ObjectId | null): Prepared => ({
      kind: "copy",
      size: header.size,
      header: stored ? head.subarray(0, header.headerLength) : null,
      basePlace,
      baseOid,
      body: segment.big ? new Uint8Array(0) : head.subarray(header.headerLength),
      stream: segment.big
        ? { offset: offset + header.headerLength, length: length - header.headerLength }
        : null,
    });
    if (!isDeltaType(header.type)) return copy(true, -1, null);
    if (header.type === "ofs-delta") {
      const basePlace = placeOf(packNumber, header.baseOffset!);
      if (basePlace >= 0) return copy(false, basePlace, null);
      // The base is the same object wherever it is stored: by id, it may be going out from another pack.
      const baseOid = pack.oidAtOffset(header.baseOffset!);
      if (baseOid !== null && (selection.has(baseOid) || options.thinBases?.has(baseOid))) {
        return copy(false, -1, baseOid);
      }
    } else if (selection.has(header.baseOid!) || options.thinBases?.has(header.baseOid!)) {
      return copy(true, -1, null);
    }
    // A delta against something the client will not have: the object itself goes out.
    const size = segment.big ? null : deltaResultSize(head.subarray(header.headerLength));
    // Ahead of the writer only while what is being rebuilt fits a budget: the size is the
    // object's, which a delta of a few bytes can make megabytes.
    if (size === null || size > REBUILD_OBJECT_BYTES || rebuilding + size > REBUILD_AHEAD_BYTES) {
      return { kind: "rebuild" };
    }
    rebuilding += size;
    try {
      return { ...(await rebuild(pack, offset)), held: size };
    } catch (error) {
      rebuilding -= size;
      throw error;
    }
  };

  /** Starts as many reads, and prepares as many entries, as the limits allow. */
  const fill = (): void => {
    while (
      upcoming !== null &&
      segments.length < READ_AHEAD &&
      (segments.length === 0 || segmentBytes + (upcoming.end - upcoming.start) <= READ_AHEAD_BYTES)
    ) {
      const segment = upcoming;
      const length = segment.end - segment.start;
      segments.push({
        ...segment,
        bytes: quiet(packs[segment.pack]!.fetchRange(segment.start, length)),
      });
      segmentBytes += length;
      upcoming = plan();
    }
    const readable = segments.length > 0 ? segments[segments.length - 1]!.until : 0;
    while (prepared.length < PREPARE_AHEAD && nextToPrepare < readable) {
      prepared.push(quiet(prepare(nextToPrepare++)));
    }
  };

  const hash = new Sha1();
  let position = 0;
  let chunk = new Uint8Array(OUT_CHUNK_BYTES);
  let filled = 0;
  const ready: Uint8Array[] = [];
  const emit = (bytes: Uint8Array): void => {
    hash.update(bytes);
    position += bytes.length;
    if (bytes.length >= OUT_CHUNK_BYTES) {
      if (filled > 0) {
        ready.push(chunk.subarray(0, filled));
        chunk = new Uint8Array(OUT_CHUNK_BYTES);
        filled = 0;
      }
      ready.push(bytes);
      return;
    }
    if (filled + bytes.length > OUT_CHUNK_BYTES) {
      ready.push(chunk.subarray(0, filled));
      chunk = new Uint8Array(OUT_CHUNK_BYTES);
      filled = 0;
    }
    chunk.set(bytes, filled);
    filled += bytes.length;
  };

  emit(encodePackHeader(n));
  for (let place = 0; place < n; place++) {
    // The writer has passed a run: its bytes can go, and the next read can start.
    while (segments.length > 0 && place >= segments[0]!.until) {
      const done = segments.shift()!;
      segmentBytes -= done.end - done.start;
    }
    fill();
    let entry = await prepared.shift()!;
    written[place] = position;
    if (entry.kind === "rebuild") {
      const index = order[place]!;
      entry = await rebuild(packs[packOf[index]!]!, offsets[index]!);
    }
    if (entry.kind === "whole") {
      rebuilding -= entry.held;
      emit(entry.header);
      emit(entry.body);
    } else {
      if (entry.header !== null) emit(entry.header);
      else if (entry.basePlace >= 0 && options.ofsDelta) {
        emit(
          encodeEntryHeader("ofs-delta", entry.size, {
            distance: position - written[entry.basePlace]!,
          }),
        );
      } else {
        const oid = entry.basePlace >= 0 ? selection.oid(order[entry.basePlace]!) : entry.baseOid!;
        emit(encodeEntryHeader("ref-delta", entry.size, { oid }));
      }
      if (entry.stream === null) emit(entry.body);
      else {
        // Too large to hold: read a piece at a time, the next ones already on their way.
        const pack = packs[packOf[order[place]!]!]!;
        const end = entry.stream.offset + entry.stream.length;
        const pieces: Array<Promise<Uint8Array>> = [];
        let next = entry.stream.offset;
        const more = (): void => {
          while (next < end && pieces.length < BIG_ENTRY_AHEAD) {
            const take = Math.min(SEGMENT_BYTES, end - next);
            pieces.push(quiet(pack.fetchRange(next, take)));
            next += take;
          }
        };
        for (more(); pieces.length > 0; more()) {
          const bytes = await pieces.shift()!;
          if (bytes.length === 0) throw new GitError("bad-pack", `pack ${pack.id} is cut short`);
          emit(bytes);
          if (ready.length > 0) yield* ready.splice(0);
        }
      }
    }
    if (ready.length > 0) yield* ready.splice(0);
  }
  const trailer = hash.digest();
  if (filled > 0) ready.push(chunk.subarray(0, filled));
  ready.push(trailer);
  yield* ready;
}

/**
 * How large the object a delta makes is: the second number at the start of
 * its instructions, which the first bytes of its zlib stream give. Null when
 * they do not (the stream's own tables took all of what was looked at).
 */
function deltaResultSize(zlib: Uint8Array): number | null {
  const start = new Uint8Array(20);
  let filled = 0;
  const inflater = acquireInflater();
  try {
    inflater.push(zlib.subarray(0, 4096), (piece) => {
      const take = Math.min(piece.length, start.length - filled);
      start.set(piece.subarray(0, take), filled);
      filled += take;
    });
    return readDeltaHeader(start.subarray(0, filled)).resultSize;
  } catch {
    return null;
  } finally {
    releaseInflater(inflater);
  }
}

/**
 * A stored pack as it is, read as ranges with several in flight: one long
 * read of R2 runs at one connection's pace, and a clone is as long as its
 * pack.
 */
export function streamWhole(pack: PackHandle): ReadableStream<Uint8Array> {
  const pending: Array<Promise<Uint8Array>> = [];
  let next = 0;
  const fill = (): void => {
    while (next < pack.size && pending.length < READ_AHEAD_BYTES / SEGMENT_BYTES) {
      const length = Math.min(SEGMENT_BYTES, pack.size - next);
      pending.push(quiet(pack.fetchRange(next, length)));
      next += length;
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      fill();
      const first = pending.shift();
      if (!first) {
        controller.close();
        return;
      }
      try {
        const bytes = await first;
        if (bytes.length === 0) throw new GitError("bad-pack", `pack ${pack.id} is cut short`);
        controller.enqueue(bytes);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      pending.length = 0;
      next = pack.size;
    },
  });
}
