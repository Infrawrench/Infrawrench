/**
 * A streaming pack parser. It is fed chunks as they arrive and never holds
 * more than the chunk in hand: entry data is inflated straight through to
 * the caller, who decides what to keep.
 */
import { crc32 } from "../crc32";
import { GitError } from "../errors";
import { toHex } from "../hex";
import { Inflater } from "../inflate";
import { Sha1 } from "../sha1";
import { type ByteSource, iterateBytes } from "../stream";
import type { ObjectId } from "../types";
import {
  MAX_ENTRY_HEADER_LENGTH,
  PACK_HEADER_LENGTH,
  PACK_TRAILER_LENGTH,
  type PackEntry,
  type PackEntryHeader,
  type PackHeader,
  decodeEntryHeader,
  decodePackHeader,
} from "./entry";

export interface PackParserHandlers {
  onHeader?(header: PackHeader): void;
  /** An entry begins. Its data follows through `onData`, then `onEntryEnd`. */
  onEntry?(entry: PackEntryHeader): void;
  /** Inflated bytes of the current entry. The view is only valid during the call. */
  onData?(chunk: Uint8Array): void;
  onEntryEnd?(entry: PackEntry): void;
}

export interface PackSummary {
  readonly version: number;
  readonly objectCount: number;
  /** The SHA-1 at the end of the pack, checked against the bytes before it. */
  readonly checksum: ObjectId;
  /** The whole pack in bytes, trailer included. */
  readonly size: number;
}

const HEADER = 0;
const ENTRY = 1;
const DATA = 2;
const TRAILER = 3;
const DONE = 4;

export class PackParser {
  private readonly handlers: PackParserHandlers;
  private readonly inflater = new Inflater();
  private readonly hash = new Sha1();
  private readonly pending = new Uint8Array(MAX_ENTRY_HEADER_LENGTH);
  private pendingLength = 0;
  private state = HEADER;
  private position = 0;
  private version = 0;
  private objectCount = 0;
  private remaining = 0;
  private entry: PackEntryHeader | null = null;
  private entryCrc = 0;
  private inflated = 0;
  private checksum = "";
  private readonly sink: (chunk: Uint8Array) => void;

  constructor(handlers: PackParserHandlers = {}) {
    this.handlers = handlers;
    this.sink = (chunk) => {
      this.inflated += chunk.length;
      // A stream that inflates past what its header declared is refused before anyone buffers it.
      if (this.inflated > this.entry!.size) {
        throw new GitError("bad-pack", `entry at ${this.entry!.offset} is larger than it declares`);
      }
      this.handlers.onData?.(chunk);
    };
  }

  /** True once the trailer has been read and verified. */
  get done(): boolean {
    return this.state === DONE;
  }

  /** Bytes of the pack consumed so far. */
  get offset(): number {
    return this.position;
  }

  /**
   * Feeds the next bytes of the pack. Returns how many bytes at the end of
   * `chunk` came after the pack: 0 until it is complete.
   */
  write(chunk: Uint8Array): number {
    let at = 0;
    const end = chunk.length;
    while (at < end && this.state !== DONE) {
      if (this.state === DATA) {
        const unused = this.inflater.push(at === 0 ? chunk : chunk.subarray(at), this.sink);
        const used = end - at - unused;
        const piece = chunk.subarray(at, at + used);
        this.entryCrc = crc32(piece, this.entryCrc);
        this.hash.update(piece);
        this.position += used;
        at += used;
        if (this.inflater.done) this.endEntry();
      } else if (this.state === ENTRY) {
        at = this.readEntryHeader(chunk, at);
      } else if (this.state === HEADER) {
        at = this.fill(chunk, at, PACK_HEADER_LENGTH);
        if (this.pendingLength < PACK_HEADER_LENGTH) break;
        const bytes = this.pending.subarray(0, PACK_HEADER_LENGTH);
        const header = decodePackHeader(bytes);
        this.hash.update(bytes);
        this.position = PACK_HEADER_LENGTH;
        this.pendingLength = 0;
        this.version = header.version;
        this.objectCount = header.objectCount;
        this.remaining = header.objectCount;
        this.state = this.remaining === 0 ? TRAILER : ENTRY;
        this.handlers.onHeader?.(header);
      } else {
        at = this.fill(chunk, at, PACK_TRAILER_LENGTH);
        if (this.pendingLength < PACK_TRAILER_LENGTH) break;
        const expected = toHex(this.pending, 0, PACK_TRAILER_LENGTH);
        const actual = this.hash.digestHex();
        if (expected !== actual) throw new GitError("bad-pack", "pack checksum does not match");
        this.checksum = actual;
        this.position += PACK_TRAILER_LENGTH;
        this.state = DONE;
      }
    }
    return end - at;
  }

  /** The verified pack's summary. Throws when the input stopped before the pack did. */
  finish(): PackSummary {
    if (this.state !== DONE) {
      throw new GitError("bad-pack", `pack is cut short at byte ${this.position}`);
    }
    return {
      version: this.version,
      objectCount: this.objectCount,
      checksum: this.checksum,
      size: this.position,
    };
  }

  private fill(chunk: Uint8Array, at: number, want: number): number {
    const take = Math.min(want - this.pendingLength, chunk.length - at);
    this.pending.set(chunk.subarray(at, at + take), this.pendingLength);
    this.pendingLength += take;
    return at + take;
  }

  private readEntryHeader(chunk: Uint8Array, start: number): number {
    let at = start;
    let header: PackEntryHeader | null = null;
    let bytes: Uint8Array;
    if (this.pendingLength === 0) {
      header = decodeEntryHeader(chunk, at, this.position);
      if (header) {
        bytes = chunk.subarray(at, at + header.headerLength);
        at += header.headerLength;
      } else {
        // The header straddles this chunk and the next. What is left is shorter than any header.
        this.pendingLength = chunk.length - at;
        this.pending.set(chunk.subarray(at), 0);
        return chunk.length;
      }
    } else {
      while (!header && at < chunk.length) {
        this.pending[this.pendingLength++] = chunk[at++]!;
        header = decodeEntryHeader(this.pending.subarray(0, this.pendingLength), 0, this.position);
      }
      if (!header) return at;
      bytes = this.pending.subarray(0, this.pendingLength);
      this.pendingLength = 0;
    }
    this.entryCrc = crc32(bytes);
    this.hash.update(bytes);
    this.position += header.headerLength;
    this.entry = header;
    this.inflated = 0;
    this.inflater.reset();
    this.state = DATA;
    this.handlers.onEntry?.(header);
    return at;
  }

  private endEntry(): void {
    const header = this.entry!;
    if (this.inflated !== header.size) {
      throw new GitError("bad-pack", `entry at ${header.offset} is smaller than it declares`);
    }
    const length = this.position - header.offset;
    this.remaining--;
    this.state = this.remaining === 0 ? TRAILER : ENTRY;
    this.handlers.onEntryEnd?.({
      ...header,
      crc32: this.entryCrc,
      compressedLength: length - header.headerLength,
      length,
    });
  }
}

export interface PackEntryWithData extends PackEntry {
  /** The entry's inflated data: the object, or for a delta the delta instructions. */
  readonly data: Uint8Array;
}

/**
 * Reads a pack entry by entry with each entry's data in memory. Convenient
 * for small packs and tests; anything that must stay within a memory budget
 * drives `PackParser` (or `PackIndexer`) itself. The generator returns the
 * pack's summary.
 */
export async function* readPackEntries(
  source: ByteSource,
): AsyncGenerator<PackEntryWithData, PackSummary, void> {
  let ready: PackEntryWithData[] = [];
  let data = new Uint8Array(0);
  let filled = 0;
  const parser = new PackParser({
    onEntry(entry) {
      data = new Uint8Array(entry.size);
      filled = 0;
    },
    onData(chunk) {
      data.set(chunk, filled);
      filled += chunk.length;
    },
    onEntryEnd(entry) {
      ready.push({ ...entry, data });
    },
  });
  for await (const chunk of iterateBytes(source)) {
    if (parser.write(chunk) > 0) throw new GitError("bad-pack", "data follows the end of the pack");
    if (ready.length > 0) {
      const batch = ready;
      ready = [];
      yield* batch;
    }
  }
  return parser.finish();
}
