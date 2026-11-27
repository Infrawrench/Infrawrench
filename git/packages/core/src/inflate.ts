/**
 * A DEFLATE / zlib decoder that says how much input it used.
 *
 * A pack is zlib streams laid end to end with nothing between them that
 * gives a stream's compressed length, so reading one means finding where it
 * stops. `DecompressionStream` does not say (and in some runtimes fails on
 * trailing bytes), so packs are inflated here instead. NOTES.md has the
 * reasoning and the numbers.
 *
 * It accepts exactly what zlib's inflate accepts: a stream this decoder
 * takes and git's would refuse could be stored and then served to a client
 * that cannot read it.
 */
import { adler32 } from "./adler32";
import { concatBytes } from "./bytes";
import { GitError } from "./errors";

/** Receives inflated bytes. The view is only valid during the call: copy what must outlive it. */
export type InflateSink = (chunk: Uint8Array) => void;

export interface InflaterOptions {
  /** Raw DEFLATE: no zlib header and no Adler-32 trailer. */
  readonly raw?: boolean;
}

const WINDOW = 32768;
const OUT_SIZE = 131072;
/** A symbol writes at most 258 bytes, so below this there is always room for one. */
const OUT_LIMIT = OUT_SIZE - 258;

const HEADER = 0;
const BLOCK = 1;
const STORED_LENGTH = 2;
const STORED = 3;
const DYNAMIC = 4;
const CODES = 5;
const TRAILER = 6;
const DONE = 7;

const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const LENGTH_BASE = new Uint16Array([
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
]);
const LENGTH_EXTRA = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
]);
const DISTANCE_BASE = new Uint16Array([
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
]);
const DISTANCE_EXTRA = new Uint8Array([
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
]);

let reversed: Uint16Array | null = null;

/** Every 15-bit value with its bits reversed: Huffman codes are packed most significant bit first. */
function reverseTable(): Uint16Array {
  if (reversed) return reversed;
  const table = new Uint16Array(32768);
  for (let i = 0; i < 32768; i++) {
    let x = ((i & 0xaaaa) >>> 1) | ((i & 0x5555) << 1);
    x = ((x & 0xcccc) >>> 2) | ((x & 0x3333) << 2);
    x = ((x & 0xf0f0) >>> 4) | ((x & 0x0f0f) << 4);
    table[i] = (((x & 0xff00) >>> 8) | ((x & 0x00ff) << 8)) >>> 1;
  }
  reversed = table;
  return table;
}

// Scratch for `buildTable`, which is synchronous and never re-enters.
const lengthCount = new Uint16Array(16);
const nextCode = new Uint16Array(16);

const INCOMPLETE = -1;
const OVERSUBSCRIBED = -2;

/**
 * Fills `table` with a direct lookup for the canonical Huffman code whose
 * symbol `i` has length `lengths[start + i]`: indexing with the next `bits`
 * input bits gives `(symbol << 4) | length`, or 0 where no code matches.
 * Returns `bits`, or a negative value for a set of lengths zlib refuses.
 */
function buildTable(
  lengths: Uint8Array,
  start: number,
  count: number,
  table: Uint16Array,
  allowIncomplete: boolean,
): number {
  lengthCount.fill(0);
  for (let i = 0; i < count; i++) lengthCount[lengths[start + i]!]!++;
  lengthCount[0] = 0;
  let max = 15;
  while (max > 0 && lengthCount[max] === 0) max--;
  if (max === 0) {
    // No codes at all is legal (a block of literals has no distances); using one is the error.
    table[0] = 0;
    return 0;
  }
  let left = 1;
  for (let length = 1; length <= 15; length++) {
    left = (left << 1) - lengthCount[length]!;
    if (left < 0) return OVERSUBSCRIBED;
  }
  if (left > 0 && (!allowIncomplete || max !== 1)) return INCOMPLETE;
  let code = 0;
  for (let length = 1; length <= max; length++) {
    code = (code + lengthCount[length - 1]!) << 1;
    nextCode[length] = code;
  }
  const size = 1 << max;
  table.fill(0, 0, size);
  const rev = reverseTable();
  for (let symbol = 0; symbol < count; symbol++) {
    const length = lengths[start + symbol]!;
    if (length === 0) continue;
    const canonical = nextCode[length]!++;
    const entry = (symbol << 4) | length;
    const step = 1 << length;
    for (let i = rev[canonical]! >>> (15 - length); i < size; i += step) table[i] = entry;
  }
  return max;
}

interface FixedTables {
  readonly literals: Uint16Array;
  readonly distances: Uint16Array;
}

let fixed: FixedTables | null = null;

function fixedTables(): FixedTables {
  if (fixed) return fixed;
  const lengths = new Uint8Array(288 + 32);
  lengths.fill(8, 0, 144);
  lengths.fill(9, 144, 256);
  lengths.fill(7, 256, 280);
  lengths.fill(8, 280, 288);
  lengths.fill(5, 288, 320);
  const literals = new Uint16Array(512);
  const distances = new Uint16Array(32);
  buildTable(lengths, 0, 288, literals, false);
  buildTable(lengths, 288, 32, distances, false);
  fixed = { literals, distances };
  return fixed;
}

function bad(message: string): GitError {
  return new GitError("bad-zlib", message);
}

/**
 * A streaming inflater. Feed it input in any chunking with `push`; it hands
 * output to the sink as it goes and, once the stream ends, reports how many
 * of the bytes it was given lay past the end.
 *
 * One instance holds about 260 KB of tables and window, so reuse it with
 * `reset` rather than making one per object.
 */
export class Inflater {
  private readonly raw: boolean;
  private state: number;
  private final = false;
  /** Bits read from the input but not yet used, least significant first. Never a whole byte between calls. */
  private bitBuffer = 0;
  private bitCount = 0;
  /** Input a previous `push` could not use yet: the start of a symbol or header that ran off its end. */
  private tail: Uint8Array | null = null;
  private readonly out = new Uint8Array(OUT_SIZE);
  private outPosition = 0;
  private emittedTo = 0;
  private checksum = 1;
  private storedLeft = 0;
  private readonly dynamicLiterals = new Uint16Array(32768);
  private readonly dynamicDistances = new Uint16Array(32768);
  private readonly codeLengthTable = new Uint16Array(128);
  private readonly lengths = new Uint8Array(320);
  private literals: Uint16Array = this.dynamicLiterals;
  private distances: Uint16Array = this.dynamicDistances;
  private literalBits = 0;
  private distanceBits = 0;
  private fed = 0;
  private consumed = 0;
  private produced = 0;

  constructor(options: InflaterOptions = {}) {
    this.raw = options.raw === true;
    this.state = this.raw ? BLOCK : HEADER;
  }

  /** True once the end of the stream (and its checksum) has been read. */
  get done(): boolean {
    return this.state === DONE;
  }

  /** Compressed bytes that belong to the stream. Exact once `done`. */
  get bytesIn(): number {
    return this.state === DONE ? this.consumed : this.fed;
  }

  /** Inflated bytes handed to the sink so far. */
  get bytesOut(): number {
    return this.produced;
  }

  reset(): this {
    this.state = this.raw ? BLOCK : HEADER;
    this.final = false;
    this.bitBuffer = 0;
    this.bitCount = 0;
    this.tail = null;
    this.outPosition = 0;
    this.emittedTo = 0;
    this.checksum = 1;
    this.storedLeft = 0;
    this.fed = 0;
    this.consumed = 0;
    this.produced = 0;
    return this;
  }

  /**
   * Inflates as much of `chunk` as it can. Returns how many bytes at the end
   * of `chunk` were not part of the stream: 0 until the stream ends, and
   * after that everything.
   */
  push(chunk: Uint8Array, sink: InflateSink): number {
    if (this.state === DONE) return chunk.length;
    let input = chunk;
    if (this.tail) {
      input = concatBytes([this.tail, chunk]);
      this.tail = null;
    }
    this.fed += chunk.length;
    const stopped = this.run(input, sink);
    this.flush(sink);
    if (this.state === DONE) {
      const unused = input.length - stopped;
      this.consumed = this.fed - unused;
      return unused;
    }
    if (stopped < input.length) this.tail = input.slice(stopped);
    return 0;
  }

  private flush(sink: InflateSink): void {
    if (this.outPosition === this.emittedTo) return;
    const chunk = this.out.subarray(this.emittedTo, this.outPosition);
    if (!this.raw) this.checksum = adler32(chunk, this.checksum);
    this.produced += chunk.length;
    this.emittedTo = this.outPosition;
    sink(chunk);
  }

  /** Hands over what is pending and moves the last 32 KB, which matches may still reach, to the front. */
  private slide(sink: InflateSink): void {
    this.flush(sink);
    this.out.copyWithin(0, this.outPosition - WINDOW, this.outPosition);
    this.outPosition = WINDOW;
    this.emittedTo = WINDOW;
  }

  /** Runs the state machine over `input`; returns the index of the first byte it did not use. */
  private run(input: Uint8Array, sink: InflateSink): number {
    const end = input.length;
    let ip = 0;
    for (;;) {
      switch (this.state) {
        case HEADER: {
          if (end - ip < 2) return ip;
          const cmf = input[ip]!;
          const flags = input[ip + 1]!;
          if ((cmf & 0x0f) !== 8 || cmf >> 4 > 7 || ((cmf << 8) | flags) % 31 !== 0) {
            throw bad("not a zlib stream");
          }
          if (flags & 0x20) throw bad("zlib preset dictionaries are not supported");
          ip += 2;
          this.state = BLOCK;
          break;
        }
        case BLOCK: {
          if (this.bitCount < 3) {
            if (ip >= end) return ip;
            this.bitBuffer |= input[ip++]! << this.bitCount;
            this.bitCount += 8;
          }
          const header = this.bitBuffer & 7;
          this.bitBuffer >>>= 3;
          this.bitCount -= 3;
          this.final = (header & 1) === 1;
          const type = header >> 1;
          if (type === 0) {
            // A stored block starts at the next byte boundary; the rest of this byte is padding.
            this.bitBuffer = 0;
            this.bitCount = 0;
            this.state = STORED_LENGTH;
          } else if (type === 1) {
            const tables = fixedTables();
            this.literals = tables.literals;
            this.distances = tables.distances;
            this.literalBits = 9;
            this.distanceBits = 5;
            this.state = CODES;
          } else if (type === 2) {
            this.state = DYNAMIC;
          } else {
            throw bad("invalid block type");
          }
          break;
        }
        case STORED_LENGTH: {
          if (end - ip < 4) return ip;
          const length = input[ip]! | (input[ip + 1]! << 8);
          const check = input[ip + 2]! | (input[ip + 3]! << 8);
          if ((length ^ 0xffff) !== check) throw bad("invalid stored block lengths");
          ip += 4;
          this.storedLeft = length;
          this.state = STORED;
          break;
        }
        case STORED: {
          while (this.storedLeft > 0) {
            if (ip >= end) return ip;
            if (this.outPosition === OUT_SIZE) this.slide(sink);
            const n = Math.min(this.storedLeft, end - ip, OUT_SIZE - this.outPosition);
            this.out.set(input.subarray(ip, ip + n), this.outPosition);
            this.outPosition += n;
            ip += n;
            this.storedLeft -= n;
          }
          this.state = this.final ? TRAILER : BLOCK;
          break;
        }
        case DYNAMIC: {
          const next = this.readDynamicHeader(input, ip);
          if (next < 0) return ip;
          ip = next;
          this.state = CODES;
          break;
        }
        case CODES: {
          ip = this.inflateCodes(input, ip, sink);
          if (this.state === CODES) return ip;
          break;
        }
        case TRAILER: {
          if (this.raw) {
            this.state = DONE;
            return ip;
          }
          if (end - ip < 4) return ip;
          this.bitBuffer = 0;
          this.bitCount = 0;
          this.flush(sink);
          const expected =
            ((input[ip]! << 24) |
              (input[ip + 1]! << 16) |
              (input[ip + 2]! << 8) |
              input[ip + 3]!) >>>
            0;
          if (expected !== this.checksum) throw bad("incorrect data check");
          ip += 4;
          this.state = DONE;
          return ip;
        }
        default:
          return ip;
      }
    }
  }

  /**
   * Reads a dynamic block's code tables. Returns the new input position, or
   * -1 when the header runs past the input, in which case nothing has changed
   * and the same call is repeated once there is more.
   *
   * It reads past the end as zeros rather than checking each bit, so
   * anything it concludes, an error included, only counts once it knows it
   * stayed inside the input.
   */
  private readDynamicHeader(input: Uint8Array, start: number): number {
    const end = input.length;
    let ip = start;
    let bitBuffer = this.bitBuffer;
    let bitCount = this.bitCount;
    const bits = (n: number): number => {
      while (bitCount < n) {
        bitBuffer |= input[ip++]! << bitCount;
        bitCount += 8;
      }
      const value = bitBuffer & ((1 << n) - 1);
      bitBuffer >>>= n;
      bitCount -= n;
      return value;
    };
    const overran = (): boolean => ip * 8 - bitCount > end * 8;

    const literalCount = bits(5) + 257;
    const distanceCount = bits(5) + 1;
    const codeLengthCount = bits(4) + 4;
    if (literalCount > 286 || distanceCount > 30) {
      if (overran()) return -1;
      throw bad("too many length or distance symbols");
    }
    const lengths = this.lengths;
    lengths.fill(0, 0, 19);
    for (let i = 0; i < codeLengthCount; i++) lengths[CODE_LENGTH_ORDER[i]!] = bits(3);
    const codeBits = buildTable(lengths, 0, 19, this.codeLengthTable, false);
    if (codeBits <= 0) {
      if (overran()) return -1;
      throw bad("invalid code lengths set");
    }
    const codeMask = (1 << codeBits) - 1;
    const codeTable = this.codeLengthTable;
    // The code-length code's own lengths sat in the scratch the real lengths are about to fill.
    const total = literalCount + distanceCount;
    let i = 0;
    while (i < total) {
      while (bitCount < codeBits) {
        bitBuffer |= input[ip++]! << bitCount;
        bitCount += 8;
      }
      const entry = codeTable[bitBuffer & codeMask]!;
      const used = entry & 15;
      if (used === 0) {
        if (overran()) return -1;
        throw bad("invalid code lengths set");
      }
      bitBuffer >>>= used;
      bitCount -= used;
      const symbol = entry >>> 4;
      if (symbol < 16) {
        lengths[i++] = symbol;
        continue;
      }
      let repeat = 0;
      let value = 0;
      if (symbol === 16) {
        if (i === 0) {
          if (overran()) return -1;
          throw bad("invalid bit length repeat");
        }
        value = lengths[i - 1]!;
        repeat = 3 + bits(2);
      } else if (symbol === 17) {
        repeat = 3 + bits(3);
      } else {
        repeat = 11 + bits(7);
      }
      if (i + repeat > total) {
        if (overran()) return -1;
        throw bad("invalid bit length repeat");
      }
      lengths.fill(value, i, i + repeat);
      i += repeat;
    }
    if (overran()) return -1;
    if (lengths[256] === 0) throw bad("invalid code: missing end-of-block");
    const literalBits = buildTable(lengths, 0, literalCount, this.dynamicLiterals, true);
    if (literalBits < 0) throw bad("invalid literal/lengths set");
    const distanceBits = buildTable(
      lengths,
      literalCount,
      distanceCount,
      this.dynamicDistances,
      true,
    );
    if (distanceBits < 0) throw bad("invalid distances set");
    this.literals = this.dynamicLiterals;
    this.distances = this.dynamicDistances;
    this.literalBits = literalBits;
    this.distanceBits = distanceBits;
    // Whole bytes still in the bit buffer go back to the input, so the count of bytes used stays exact.
    ip -= bitCount >>> 3;
    bitCount &= 7;
    this.bitBuffer = bitBuffer & ((1 << bitCount) - 1);
    this.bitCount = bitCount;
    return ip;
  }

  /**
   * Decodes literals and matches until the block ends (the state moves on)
   * or the input runs out (it stays CODES). Returns the new input position.
   *
   * Like the header, a symbol is decoded reading zeros past the end and only
   * then checked: if it used bits that were not there, the position is put
   * back to where the symbol began.
   */
  private inflateCodes(input: Uint8Array, start: number, sink: InflateSink): number {
    const out = this.out;
    const literals = this.literals;
    const distances = this.distances;
    const literalMask = (1 << this.literalBits) - 1;
    const distanceMask = (1 << this.distanceBits) - 1;
    const end = input.length;
    const endBits = end * 8;
    let ip = start;
    let op = this.outPosition;
    let bitBuffer = this.bitBuffer;
    let bitCount = this.bitCount;
    let blockEnded = false;
    for (;;) {
      if (op > OUT_LIMIT) {
        this.outPosition = op;
        this.slide(sink);
        op = this.outPosition;
      }
      const savedIp = ip;
      const savedBuffer = bitBuffer;
      const savedCount = bitCount;
      if (bitCount < 15) {
        bitBuffer |= input[ip++]! << bitCount;
        bitCount += 8;
        bitBuffer |= input[ip++]! << bitCount;
        bitCount += 8;
      }
      let entry = literals[bitBuffer & literalMask]!;
      let used = entry & 15;
      if (used === 0) {
        if (ip > end) {
          ip = savedIp;
          bitBuffer = savedBuffer;
          bitCount = savedCount;
          break;
        }
        throw bad("invalid literal/length code");
      }
      bitBuffer >>>= used;
      bitCount -= used;
      let symbol = entry >>> 4;
      if (symbol < 256) {
        if (ip > end && ip * 8 - bitCount > endBits) {
          ip = savedIp;
          bitBuffer = savedBuffer;
          bitCount = savedCount;
          break;
        }
        out[op++] = symbol;
        continue;
      }
      if (symbol === 256) {
        if (ip > end && ip * 8 - bitCount > endBits) {
          ip = savedIp;
          bitBuffer = savedBuffer;
          bitCount = savedCount;
          break;
        }
        blockEnded = true;
        break;
      }
      symbol -= 257;
      if (symbol >= 29) {
        if (ip > end) {
          ip = savedIp;
          bitBuffer = savedBuffer;
          bitCount = savedCount;
          break;
        }
        throw bad("invalid literal/length code");
      }
      let extra = LENGTH_EXTRA[symbol]!;
      if (bitCount < extra) {
        bitBuffer |= input[ip++]! << bitCount;
        bitCount += 8;
      }
      const length = LENGTH_BASE[symbol]! + (bitBuffer & ((1 << extra) - 1));
      bitBuffer >>>= extra;
      bitCount -= extra;
      if (bitCount < 15) {
        bitBuffer |= input[ip++]! << bitCount;
        bitCount += 8;
        bitBuffer |= input[ip++]! << bitCount;
        bitCount += 8;
      }
      entry = distances[bitBuffer & distanceMask]!;
      used = entry & 15;
      symbol = entry >>> 4;
      if (used === 0 || symbol >= 30) {
        if (ip > end) {
          ip = savedIp;
          bitBuffer = savedBuffer;
          bitCount = savedCount;
          break;
        }
        throw bad("invalid distance code");
      }
      bitBuffer >>>= used;
      bitCount -= used;
      extra = DISTANCE_EXTRA[symbol]!;
      if (bitCount < extra) {
        bitBuffer |= input[ip++]! << bitCount;
        bitCount += 8;
        bitBuffer |= input[ip++]! << bitCount;
        bitCount += 8;
      }
      const distance = DISTANCE_BASE[symbol]! + (bitBuffer & ((1 << extra) - 1));
      bitBuffer >>>= extra;
      bitCount -= extra;
      if (ip > end && ip * 8 - bitCount > endBits) {
        ip = savedIp;
        bitBuffer = savedBuffer;
        bitCount = savedCount;
        break;
      }
      // Before the first slide the buffer starts where the stream does; after it, 32 KB always precede.
      if (distance > op) throw bad("invalid distance too far back");
      let from = op - distance;
      const stop = op + length;
      do {
        out[op++] = out[from++]!;
      } while (op < stop);
    }
    ip -= bitCount >>> 3;
    bitCount &= 7;
    this.bitBuffer = bitBuffer & ((1 << bitCount) - 1);
    this.bitCount = bitCount;
    this.outPosition = op;
    if (blockEnded) this.state = this.final ? TRAILER : BLOCK;
    return ip;
  }
}

const idle: Inflater[] = [];

/**
 * An inflater for a caller that awaits while using it, and so cannot share
 * the synchronous one. Hand it back with `releaseInflater`; a few are kept,
 * because each costs a quarter of a megabyte to make.
 */
export function acquireInflater(): Inflater {
  return idle.pop()?.reset() ?? new Inflater();
}

export function releaseInflater(inflater: Inflater): void {
  if (idle.length < 4) idle.push(inflater);
}

export interface InflateOptions extends InflaterOptions {
  /** Where the stream starts in the input. */
  readonly offset?: number;
  /** The inflated size, when known: the result is checked against it and allocated once. */
  readonly size?: number;
  /** Refuse to inflate past this many bytes. */
  readonly maxSize?: number;
}

export interface InflateResult {
  readonly data: Uint8Array;
  /** Input bytes the stream occupied, counted from `offset`. */
  readonly consumed: number;
}

// One each: the functions below are synchronous, so nothing else can be using them.
let pooled: Inflater | null = null;
let pooledRaw: Inflater | null = null;

/** A shared inflater for a synchronous caller that finishes with it before returning. */
export function borrowInflater(raw = false): Inflater {
  if (raw) return (pooledRaw ??= new Inflater({ raw: true })).reset();
  return (pooled ??= new Inflater()).reset();
}

/**
 * Inflates one stream from a buffer that may hold more after it, and says
 * where the stream ended.
 */
export function inflateSync(input: Uint8Array, options: InflateOptions = {}): InflateResult {
  const offset = options.offset ?? 0;
  const inflater = borrowInflater(options.raw === true);
  const limit = options.maxSize ?? Number.MAX_SAFE_INTEGER;
  const source = offset === 0 ? input : input.subarray(offset);
  let data: Uint8Array;
  if (options.size !== undefined) {
    const size = options.size;
    if (size > limit) throw new GitError("limit", `object of ${size} bytes is over the limit`);
    const target = new Uint8Array(size);
    let position = 0;
    inflater.push(source, (chunk) => {
      if (position + chunk.length > size) throw bad("stream inflates past its declared size");
      target.set(chunk, position);
      position += chunk.length;
    });
    if (inflater.done && position !== size) throw bad("stream inflates short of its declared size");
    data = target;
  } else {
    const chunks: Uint8Array[] = [];
    let total = 0;
    inflater.push(source, (chunk) => {
      total += chunk.length;
      if (total > limit) throw new GitError("limit", "stream inflates past the limit");
      chunks.push(chunk.slice());
    });
    data = concatBytes(chunks);
  }
  if (!inflater.done) throw bad("truncated zlib stream");
  return { data, consumed: inflater.bytesIn };
}
