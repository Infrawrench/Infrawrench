/** Writes a pack: header, entries (whole objects or ready-made deltas), trailing SHA-1. */
import { concatBytes } from "../bytes";
import { crc32 } from "../crc32";
import { GitError } from "../errors";
import { toHex } from "../hex";
import { Sha1 } from "../sha1";
import type { ObjectId, ObjectType } from "../types";
import { deflate } from "../zlib";
import { encodeEntryHeader, encodePackHeader } from "./entry";

/**
 * The entry's data, either plain (it is compressed here) or as a zlib
 * stream the caller already has, which is how stored entries are passed
 * through without inflating and deflating them again.
 */
export type PackInputPayload =
  | { readonly data: Uint8Array; readonly compressed?: undefined }
  | {
      readonly compressed: Uint8Array;
      /** The inflated size the entry header declares. */
      readonly size: number;
      readonly data?: undefined;
    };

export type PackInput = PackInputPayload & {
  /**
   * The object's id. Only needed for an object a later `ofs-delta` names as
   * its base; the writer does not hash anything itself.
   */
  readonly oid?: ObjectId;
} & (
    | { readonly type: ObjectType }
    /** `data` is the delta. The base may be anywhere, this pack or not. */
    | { readonly type: "ref-delta"; readonly base: ObjectId }
    /**
     * `data` is the delta. The base is an object written earlier in this
     * pack: its id (it must have been added with `oid`) or its offset.
     */
    | { readonly type: "ofs-delta"; readonly base: ObjectId | number }
  );

export interface WrittenEntry {
  readonly oid: ObjectId | undefined;
  readonly offset: number;
  readonly length: number;
  readonly crc32: number;
}

/**
 * Builds a pack piece by piece. `header`, then `add` for each of exactly
 * `objectCount` entries, then `finish`; each returns bytes to send, in order.
 */
export class PackWriter {
  private readonly objectCount: number;
  private readonly hash = new Sha1();
  private readonly offsets = new Map<ObjectId, number>();
  private position = 0;
  private written = 0;
  private started = false;
  private finished = false;

  constructor(objectCount: number) {
    this.objectCount = objectCount;
  }

  /** Bytes produced so far, which is the offset the next entry will have. */
  get offset(): number {
    return this.position;
  }

  header(): Uint8Array {
    if (this.started) throw new Error("PackWriter: header already written");
    this.started = true;
    const bytes = encodePackHeader(this.objectCount);
    this.hash.update(bytes);
    this.position = bytes.length;
    return bytes;
  }

  /** Encodes one entry. The two chunks (entry header, zlib stream) go out in that order. */
  async add(input: PackInput): Promise<{ chunks: [Uint8Array, Uint8Array]; entry: WrittenEntry }> {
    if (!this.started || this.finished) throw new Error("PackWriter: add outside header..finish");
    if (this.written >= this.objectCount) {
      throw new GitError("bad-pack", `pack was declared with ${this.objectCount} objects`);
    }
    const size = input.compressed !== undefined ? input.size : input.data.length;
    const body = input.compressed !== undefined ? input.compressed : await deflate(input.data);
    // Taken after the await, so the offset is the one this entry really lands on.
    const offset = this.position;
    let header: Uint8Array;
    if (input.type === "ofs-delta") {
      const baseOffset = typeof input.base === "number" ? input.base : this.offsets.get(input.base);
      if (baseOffset === undefined || baseOffset >= offset) {
        throw new GitError("bad-pack", "an ofs-delta's base must come earlier in the same pack");
      }
      header = encodeEntryHeader("ofs-delta", size, { distance: offset - baseOffset });
    } else if (input.type === "ref-delta") {
      header = encodeEntryHeader("ref-delta", size, { oid: input.base });
    } else {
      header = encodeEntryHeader(input.type, size);
    }
    this.hash.update(header).update(body);
    this.position = offset + header.length + body.length;
    this.written++;
    if (input.oid !== undefined) this.offsets.set(input.oid, offset);
    return {
      chunks: [header, body],
      entry: {
        oid: input.oid,
        offset,
        length: header.length + body.length,
        crc32: crc32(body, crc32(header)),
      },
    };
  }

  /** The 20-byte trailer. Throws when fewer entries were added than declared. */
  finish(): Uint8Array {
    if (this.written !== this.objectCount) {
      throw new GitError(
        "bad-pack",
        `pack was declared with ${this.objectCount} objects but has ${this.written}`,
      );
    }
    this.finished = true;
    this.position += 20;
    return this.hash.digest();
  }
}

export interface WritePackOptions {
  /** How many entries `inputs` will yield. The pack header states it before the first one. */
  readonly count: number;
  /** Entries are gathered into chunks of about this size. Default 64 KiB. */
  readonly chunkSize?: number;
}

/**
 * Streams a pack of the given entries. The stream errors if the source
 * yields a different number of entries than `count`.
 */
export function writePack(
  inputs: Iterable<PackInput> | AsyncIterable<PackInput>,
  options: WritePackOptions,
): ReadableStream<Uint8Array> {
  const chunkSize = options.chunkSize ?? 65536;
  async function* generate(): AsyncGenerator<Uint8Array, void, void> {
    const writer = new PackWriter(options.count);
    let buffer = new Uint8Array(chunkSize);
    let filled = 0;
    const out: Uint8Array[] = [];
    // Small entries are gathered; a chunk as large as the buffer goes out as it is, uncopied.
    const put = (bytes: Uint8Array): void => {
      if (bytes.length >= chunkSize) {
        if (filled > 0) {
          out.push(buffer.subarray(0, filled));
          buffer = new Uint8Array(chunkSize);
          filled = 0;
        }
        out.push(bytes);
        return;
      }
      if (filled + bytes.length > chunkSize) {
        out.push(buffer.subarray(0, filled));
        buffer = new Uint8Array(chunkSize);
        filled = 0;
      }
      buffer.set(bytes, filled);
      filled += bytes.length;
    };
    put(writer.header());
    for await (const input of inputs) {
      const { chunks } = await writer.add(input);
      put(chunks[0]);
      put(chunks[1]);
      if (out.length > 0) yield* out.splice(0);
    }
    put(writer.finish());
    if (filled > 0) out.push(buffer.subarray(0, filled));
    yield* out;
  }
  const iterator = generate();
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

export interface BuiltPack {
  readonly pack: Uint8Array;
  readonly checksum: ObjectId;
  readonly entries: readonly WrittenEntry[];
}

/** Builds a whole pack in memory. For tests and small packs; `writePack` is the streaming one. */
export async function buildPack(inputs: readonly PackInput[]): Promise<BuiltPack> {
  const writer = new PackWriter(inputs.length);
  const chunks: Uint8Array[] = [writer.header()];
  const entries: WrittenEntry[] = [];
  for (const input of inputs) {
    const added = await writer.add(input);
    chunks.push(...added.chunks);
    entries.push(added.entry);
  }
  const trailer = writer.finish();
  chunks.push(trailer);
  return { pack: concatBytes(chunks), checksum: toHex(trailer), entries };
}
