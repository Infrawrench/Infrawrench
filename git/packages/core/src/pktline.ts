/**
 * pkt-line, the framing of the git wire protocol: four hex digits of length
 * (which count themselves), then the payload. Lengths 0, 1 and 2 are the
 * flush, delimiter and response-end markers and carry nothing.
 */
import { concatBytes, decodeText, encodeText } from "./bytes";
import { GitError } from "./errors";
import { type ByteSource, iterateBytes, streamFrom } from "./stream";

/** The longest packet, length digits included (`LARGE_PACKET_MAX`). */
export const PKT_MAX_LENGTH = 65520;
/** The most payload one packet carries. */
export const PKT_MAX_DATA = PKT_MAX_LENGTH - 4;

export const FLUSH_PKT: Uint8Array = encodeText("0000");
export const DELIM_PKT: Uint8Array = encodeText("0001");
export const RESPONSE_END_PKT: Uint8Array = encodeText("0002");

export type Pkt =
  | { readonly type: "data"; readonly data: Uint8Array }
  | { readonly type: "flush" }
  | { readonly type: "delim" }
  | { readonly type: "response-end" };

const HEX_DIGITS = "0123456789abcdef";

/** One data packet. A string is sent as UTF-8, exactly as given: add the `\n` yourself. */
export function encodePktLine(payload: Uint8Array | string): Uint8Array {
  const data = typeof payload === "string" ? encodeText(payload) : payload;
  if (data.length > PKT_MAX_DATA) {
    throw new GitError("bad-pkt-line", `a packet holds at most ${PKT_MAX_DATA} bytes`);
  }
  const length = data.length + 4;
  const out = new Uint8Array(length);
  out[0] = HEX_DIGITS.charCodeAt(length >>> 12);
  out[1] = HEX_DIGITS.charCodeAt((length >>> 8) & 15);
  out[2] = HEX_DIGITS.charCodeAt((length >>> 4) & 15);
  out[3] = HEX_DIGITS.charCodeAt(length & 15);
  out.set(data, 4);
  return out;
}

/** Several packets as one buffer. `null` stands for a flush. */
export function encodePktLines(payloads: ReadonlyArray<Uint8Array | string | null>): Uint8Array {
  return concatBytes(
    payloads.map((payload) => (payload === null ? FLUSH_PKT : encodePktLine(payload))),
  );
}

/** A data packet's payload as text, without the newline most lines end in. */
export function pktLineText(pkt: Pkt): string {
  if (pkt.type !== "data") throw new GitError("bad-pkt-line", `expected data, got ${pkt.type}`);
  const text = decodeText(pkt.data);
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

function hexDigit(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 97 && code <= 102) return code - 87;
  if (code >= 65 && code <= 70) return code - 55;
  return -1;
}

/**
 * Reads the length at `at`. Returns it, or -1 for anything that is not four
 * hex digits.
 */
function readLength(bytes: Uint8Array, at: number): number {
  const a = hexDigit(bytes[at]!);
  const b = hexDigit(bytes[at + 1]!);
  const c = hexDigit(bytes[at + 2]!);
  const d = hexDigit(bytes[at + 3]!);
  if (a < 0 || b < 0 || c < 0 || d < 0) return -1;
  return (a << 12) | (b << 8) | (c << 4) | d;
}

const FLUSH: Pkt = { type: "flush" };
const DELIM: Pkt = { type: "delim" };
const RESPONSE_END: Pkt = { type: "response-end" };

function special(length: number): Pkt | null {
  if (length === 0) return FLUSH;
  if (length === 1) return DELIM;
  if (length === 2) return RESPONSE_END;
  if (length === 3) throw new GitError("bad-pkt-line", "packet length 3 is not valid");
  if (length > PKT_MAX_LENGTH) throw new GitError("bad-pkt-line", "packet is over the size limit");
  return null;
}

/**
 * Decodes a buffer that holds only whole packets, such as a smart HTTP
 * request body already read into memory.
 */
export function decodePktLines(bytes: Uint8Array): Pkt[] {
  const out: Pkt[] = [];
  let at = 0;
  while (at < bytes.length) {
    if (at + 4 > bytes.length) throw new GitError("bad-pkt-line", "packet is cut short");
    const length = readLength(bytes, at);
    if (length < 0) throw new GitError("bad-pkt-line", "packet length is not hex");
    const marker = special(length);
    if (marker) {
      out.push(marker);
      at += 4;
      continue;
    }
    if (at + length > bytes.length) throw new GitError("bad-pkt-line", "packet is cut short");
    out.push({ type: "data", data: bytes.subarray(at + 4, at + length) });
    at += length;
  }
  return out;
}

/**
 * Reads packets one at a time from a stream, and can hand the stream back.
 *
 * It pulls a packet only when asked, never ahead, because a conversation
 * changes framing partway: receive-pack sends its commands as packets and
 * then the pack as raw bytes on the same stream. `rest` returns whatever
 * follows the last packet read.
 */
export class PktLineReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private buffer: Uint8Array = new Uint8Array(0);
  private at = 0;
  private ended = false;
  private handedOff = false;

  constructor(source: ByteSource) {
    this.iterator = iterateBytes(source)[Symbol.asyncIterator]();
  }

  /** Makes `need` bytes available at `this.at`. False when the stream ends first. */
  private async fill(need: number): Promise<boolean> {
    if (this.buffer.length - this.at >= need) return true;
    const parts: Uint8Array[] = [];
    let have = this.buffer.length - this.at;
    if (have > 0) parts.push(this.buffer.subarray(this.at));
    while (have < need && !this.ended) {
      const next = await this.iterator.next();
      if (next.done) {
        this.ended = true;
        break;
      }
      parts.push(next.value);
      have += next.value.length;
    }
    this.buffer = parts.length === 0 ? new Uint8Array(0) : concatBytes(parts);
    this.at = 0;
    return have >= need;
  }

  /** The next packet, or null when the stream ended cleanly between packets. */
  async read(): Promise<Pkt | null> {
    if (this.handedOff) throw new Error("PktLineReader: the stream was handed off with rest()");
    if (!(await this.fill(4))) {
      if (this.buffer.length - this.at === 0) return null;
      throw new GitError("bad-pkt-line", "stream ends inside a packet length");
    }
    const length = readLength(this.buffer, this.at);
    if (length < 0) throw new GitError("bad-pkt-line", "packet length is not hex");
    const marker = special(length);
    if (marker) {
      this.at += 4;
      return marker;
    }
    if (!(await this.fill(length))) {
      throw new GitError("bad-pkt-line", "stream ends inside a packet");
    }
    const data = this.buffer.subarray(this.at + 4, this.at + length);
    this.at += length;
    return { type: "data", data };
  }

  /**
   * Reads data packets up to the next flush, delimiter or response-end, or
   * the end of the stream. Returns the payloads and what stopped it.
   */
  async readSection(): Promise<{ lines: Uint8Array[]; end: Exclude<Pkt["type"], "data"> | "eof" }> {
    const lines: Uint8Array[] = [];
    for (;;) {
      const pkt = await this.read();
      if (pkt === null) return { lines, end: "eof" };
      if (pkt.type !== "data") return { lines, end: pkt.type };
      lines.push(pkt.data);
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Pkt, void, void> {
    for (;;) {
      const pkt = await this.read();
      if (pkt === null) return;
      yield pkt;
    }
  }

  /** Everything after the last packet read, unframed. The reader is finished after this. */
  async *rest(): AsyncGenerator<Uint8Array, void, void> {
    if (this.handedOff) throw new Error("PktLineReader: rest() called twice");
    this.handedOff = true;
    try {
      if (this.at < this.buffer.length) yield this.buffer.subarray(this.at);
      this.buffer = new Uint8Array(0);
      this.at = 0;
      while (!this.ended) {
        const next = await this.iterator.next();
        if (next.done) break;
        yield next.value;
      }
    } finally {
      this.ended = true;
      await this.iterator.return?.();
    }
  }

  restStream(): ReadableStream<Uint8Array> {
    return streamFrom(this.rest());
  }

  /** Stops reading and releases the source. */
  async cancel(): Promise<void> {
    this.ended = true;
    this.handedOff = true;
    await this.iterator.return?.();
  }
}
