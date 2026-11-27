/**
 * Writing a pack for a fetch out of the packs already stored, without
 * inflating anything that can be sent as it is. An entry's bytes are copied
 * from R2 to the client; only its header is rewritten, because an
 * `ofs-delta` says how far back its base is and that distance changes. A
 * delta whose base is not going out (and that the client does not have) is
 * the one case that is read whole and compressed again.
 */
import {
  GitError,
  type ObjectId,
  Sha1,
  cachedRangeReader,
  decodeEntryHeader,
  deflate,
  encodeEntryHeader,
  encodePackHeader,
  isDeltaType,
} from "@infrawrench/git-core";
import type { OidSet } from "@infrawrench/git-protocol";
import type { PackHandle, PackStore } from "./pack-store";

/** Entries up to this size are read through the block cache; larger ones are streamed. */
const STREAM_ENTRY_BYTES = 4 * 1024 * 1024;
const OUT_CHUNK_BYTES = 256 * 1024;

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

  // Sequential readers with large blocks: a clone reads each pack front to back.
  const readers = packs.map((pack) =>
    cachedRangeReader(pack.fetchRange, { blockSize: 4 * 1024 * 1024, maxBlocks: 2 }),
  );

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
    const index = order[place]!;
    const packNumber = packOf[index]!;
    const pack = packs[packNumber]!;
    const offset = offsets[index]!;
    const length = pack.lengthAt(offset);
    if (length === undefined) throw new GitError("bad-index", `no entry at ${offset} in a pack`);
    written[place] = position;

    const small = length <= STREAM_ENTRY_BYTES;
    const head = await readers[packNumber]!(offset, small ? length : 64);
    const header = decodeEntryHeader(head, 0, offset);
    if (!header) throw new GitError("bad-pack", `entry at ${offset} is cut short`);

    // Decide the header this entry goes out with; null means it cannot go as stored.
    let outHeader: Uint8Array | null;
    if (!isDeltaType(header.type)) {
      outHeader = head.subarray(0, header.headerLength);
    } else if (header.type === "ofs-delta") {
      const basePlace = placeOf(packNumber, header.baseOffset!);
      if (basePlace >= 0) {
        outHeader = options.ofsDelta
          ? encodeEntryHeader("ofs-delta", header.size, {
              distance: position - written[basePlace]!,
            })
          : encodeEntryHeader("ref-delta", header.size, { oid: selection.oid(order[basePlace]!) });
      } else {
        // The base is the same object wherever it is stored: by id, it may be going out from another pack.
        const baseOid = pack.oidAtOffset(header.baseOffset!);
        outHeader =
          baseOid !== null && (selection.has(baseOid) || options.thinBases?.has(baseOid))
            ? encodeEntryHeader("ref-delta", header.size, { oid: baseOid })
            : null;
      }
    } else {
      const baseOid = header.baseOid!;
      outHeader =
        selection.has(baseOid) || options.thinBases?.has(baseOid)
          ? head.subarray(0, header.headerLength)
          : null;
    }

    if (outHeader === null) {
      const object = await store.readAt(packs, pack, offset);
      emit(encodeEntryHeader(object.type, object.data.length));
      emit(await deflate(object.data));
    } else if (small) {
      emit(outHeader);
      emit(head.subarray(header.headerLength));
    } else {
      emit(outHeader);
      const body = await pack.streamRange(
        offset + header.headerLength,
        length - header.headerLength,
      );
      const reader = body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          emit(value);
          if (ready.length > 0) yield* ready.splice(0);
        }
      } finally {
        reader.releaseLock();
      }
    }
    if (ready.length > 0) yield* ready.splice(0);
  }
  const trailer = hash.digest();
  if (filled > 0) ready.push(chunk.subarray(0, filled));
  ready.push(trailer);
  yield* ready;
}
