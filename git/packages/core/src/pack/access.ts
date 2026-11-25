/**
 * Random access into a stored pack through range reads, which is how a pack
 * in R2 is read: nothing here ever asks for the whole file.
 */
import { crc32 } from "../crc32";
import { GitError } from "../errors";
import { acquireInflater, releaseInflater } from "../inflate";
import type { GitObject, ObjectId } from "../types";
import { applyDelta, readDeltaHeader } from "./delta";
import { MAX_ENTRY_HEADER_LENGTH, decodeEntryHeader, isDeltaType } from "./entry";
import type { PackEntryWithData } from "./reader";

/**
 * Reads `length` bytes of a pack starting at `offset`. It may return fewer
 * only when the pack ends first. In production this is an R2 range GET.
 */
export type ReadRange = (offset: number, length: number) => Promise<Uint8Array>;

export interface CachedRangeReaderOptions {
  /** Bytes fetched per underlying read. Default 512 KiB. */
  readonly blockSize?: number;
  /** Blocks kept. Default 8, so 4 MiB at the default block size. */
  readonly maxBlocks?: number;
}

/**
 * Wraps a range reader so that many small reads close together become few
 * large ones. Resolving deltas reads one entry at a time, and an object
 * store charges a round trip for each.
 */
export function cachedRangeReader(
  read: ReadRange,
  options: CachedRangeReaderOptions = {},
): ReadRange {
  const blockSize = options.blockSize ?? 512 * 1024;
  const maxBlocks = options.maxBlocks ?? 8;
  const blocks = new Map<number, Uint8Array>();

  const block = async (index: number): Promise<Uint8Array> => {
    const hit = blocks.get(index);
    if (hit) {
      blocks.delete(index);
      blocks.set(index, hit);
      return hit;
    }
    const bytes = await read(index * blockSize, blockSize);
    blocks.set(index, bytes);
    if (blocks.size > maxBlocks) blocks.delete(blocks.keys().next().value!);
    return bytes;
  };

  return async (offset, length) => {
    // A read that would fill the cache by itself is better served directly.
    if (length >= blockSize * 2) return read(offset, length);
    const out = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      const at = offset + filled;
      const index = Math.floor(at / blockSize);
      const bytes = await block(index);
      const start = at - index * blockSize;
      if (start >= bytes.length) break;
      const take = Math.min(bytes.length - start, length - filled);
      out.set(bytes.subarray(start, start + take), filled);
      filled += take;
      if (bytes.length < blockSize) break;
    }
    return filled === length ? out : out.subarray(0, filled);
  };
}

/** A range reader over bytes already in memory, for small packs and tests. */
export function memoryRangeReader(pack: Uint8Array): ReadRange {
  return async (offset, length) => pack.subarray(offset, Math.min(pack.length, offset + length));
}

export interface ReadEntryOptions {
  /**
   * The entry's exact packed length (header and zlib stream), when the
   * caller knows it from the next entry's offset. It turns the read into a
   * single range request.
   */
  readonly length?: number;
  /** Bytes fetched first when the length is not known. Default 8 KiB. */
  readonly firstRead?: number;
  /** Refuse an entry, or an object rebuilt from deltas, whose inflated size is over this. */
  readonly maxSize?: number;
}

/** Reads and inflates the entry at `offset`: an object, or a delta's instructions. */
export async function readPackEntryAt(
  read: ReadRange,
  offset: number,
  options: ReadEntryOptions = {},
): Promise<PackEntryWithData> {
  const known = options.length;
  let bytes = await read(offset, known ?? Math.max(options.firstRead ?? 8192, 64));
  const header = decodeEntryHeader(bytes, 0, offset);
  if (!header) throw new GitError("bad-pack", `entry at ${offset} is cut short`);
  if (options.maxSize !== undefined && header.size > options.maxSize) {
    throw new GitError("limit", `entry at ${offset} is ${header.size} bytes, over the limit`);
  }
  const data = new Uint8Array(header.size);
  let filled = 0;
  // Not the shared synchronous one: this function awaits between pushes.
  const inflater = acquireInflater();
  const sink = (chunk: Uint8Array): void => {
    if (filled + chunk.length > data.length) {
      throw new GitError("bad-pack", `entry at ${offset} is larger than it declares`);
    }
    data.set(chunk, filled);
    filled += chunk.length;
  };
  let crc = crc32(bytes.subarray(0, header.headerLength));
  let consumed = header.headerLength;
  let piece = bytes.subarray(header.headerLength);
  try {
    for (;;) {
      const unused = inflater.push(piece, sink);
      const used = piece.length - unused;
      crc = crc32(piece.subarray(0, used), crc);
      consumed += used;
      if (inflater.done) break;
      if (known !== undefined) throw new GitError("bad-pack", `entry at ${offset} is cut short`);
      // zlib's own worst case for what is left, so a well-formed entry needs one more read at most.
      const left = header.size - filled;
      const want = left + (left >>> 10) + 64 + MAX_ENTRY_HEADER_LENGTH;
      bytes = await read(offset + consumed, Math.max(want, 4096));
      if (bytes.length === 0) throw new GitError("bad-pack", `entry at ${offset} is cut short`);
      piece = bytes;
    }
  } finally {
    releaseInflater(inflater);
  }
  if (filled !== header.size) {
    throw new GitError("bad-pack", `entry at ${offset} is smaller than it declares`);
  }
  if (known !== undefined && consumed !== known) {
    throw new GitError("bad-pack", `entry at ${offset} does not fill its ${known} bytes`);
  }
  return {
    ...header,
    data,
    crc32: crc,
    compressedLength: consumed - header.headerLength,
    length: consumed,
  };
}

export interface ReadObjectOptions extends ReadEntryOptions {
  /**
   * Finds the base of a `ref-delta` by id. The base may be elsewhere in the
   * same pack or in another one; only the caller's object index knows.
   */
  readonly resolveBase?: (oid: ObjectId) => Promise<GitObject | null>;
  /** The packed length of the entry at an offset, when the caller's index has it. */
  readonly lengthAt?: (offset: number) => number | undefined;
  /** Longest delta chain followed. Default 4096, past anything git writes. */
  readonly maxDepth?: number;
}

/**
 * Reads the object stored at `offset`, following its delta chain down to a
 * whole object and applying the deltas back up.
 */
export async function readPackObjectAt(
  read: ReadRange,
  offset: number,
  options: ReadObjectOptions = {},
): Promise<GitObject> {
  const maxDepth = options.maxDepth ?? 4096;
  const deltas: Uint8Array[] = [];
  let at = offset;
  let object: GitObject | null = null;
  while (object === null) {
    if (deltas.length > maxDepth) {
      throw new GitError("limit", `delta chain at ${offset} is longer than ${maxDepth}`);
    }
    const length = at === offset ? options.length : undefined;
    const known = length ?? options.lengthAt?.(at);
    const entry = await readPackEntryAt(read, at, {
      ...(known !== undefined ? { length: known } : {}),
      ...(options.firstRead !== undefined ? { firstRead: options.firstRead } : {}),
      ...(options.maxSize !== undefined ? { maxSize: options.maxSize } : {}),
    });
    if (!isDeltaType(entry.type)) {
      object = { type: entry.type, data: entry.data };
    } else if (entry.type === "ofs-delta") {
      deltas.push(entry.data);
      at = entry.baseOffset!;
    } else {
      deltas.push(entry.data);
      const base = await options.resolveBase?.(entry.baseOid!);
      if (!base) {
        throw new GitError("missing-object", `delta base ${entry.baseOid} is missing`);
      }
      object = base;
    }
  }
  let data = object.data;
  for (let i = deltas.length - 1; i >= 0; i--) {
    const delta = deltas[i]!;
    if (options.maxSize !== undefined && readDeltaHeader(delta).resultSize > options.maxSize) {
      throw new GitError("limit", `object at ${offset} is over the size limit`);
    }
    data = applyDelta(data, delta);
  }
  return { type: object.type, data };
}
