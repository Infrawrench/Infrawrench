/**
 * The SSH data representations (RFC 4251, section 5): byte, boolean, uint32,
 * string, mpint and name-list, read from and written to message payloads.
 */
import { concat, fromUtf8, utf8 } from "./bytes";
import { protocolError } from "./errors";

export class WireReader {
  private offset: number;

  constructor(
    private readonly buffer: Uint8Array,
    offset = 0,
  ) {
    this.offset = offset;
  }

  get remaining(): number {
    return this.buffer.length - this.offset;
  }

  private take(length: number): Uint8Array {
    if (length > this.remaining) throw protocolError("truncated message");
    const view = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return view;
  }

  byte(): number {
    return this.take(1)[0]!;
  }

  boolean(): boolean {
    return this.byte() !== 0;
  }

  uint32(): number {
    const b = this.take(4);
    return ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  }

  /** A length-prefixed byte string, as a view into the message (not a copy). */
  string(): Uint8Array {
    return this.take(this.uint32());
  }

  text(): string {
    try {
      return fromUtf8(this.string());
    } catch {
      throw protocolError("string is not valid UTF-8");
    }
  }

  nameList(): string[] {
    const bytes = this.string();
    if (bytes.length === 0) return [];
    let text = "";
    for (let i = 0; i < bytes.length; i++) {
      const c = bytes[i]!;
      // Names are printable US-ASCII without spaces (RFC 4251, section 6).
      if (c <= 0x20 || c >= 0x7f) throw protocolError("invalid character in name-list");
      text += String.fromCharCode(c);
    }
    return text.split(",");
  }

  /**
   * A non-negative mpint as its magnitude, big-endian, with no leading zero
   * bytes. A negative value is refused: nothing in SSH sends one.
   */
  mpint(): Uint8Array {
    const bytes = this.string();
    if (bytes.length > 0 && (bytes[0]! & 0x80) !== 0) throw protocolError("negative mpint");
    let start = 0;
    while (start < bytes.length && bytes[start] === 0) start++;
    return bytes.subarray(start);
  }

  /** Messages with bytes left over are refused, so nothing rides along behind a parser. */
  end(): void {
    if (this.remaining !== 0) throw protocolError("trailing bytes in message");
  }
}

export class WireWriter {
  private readonly parts: Uint8Array[] = [];

  byte(value: number): this {
    this.parts.push(Uint8Array.of(value & 0xff));
    return this;
  }

  boolean(value: boolean): this {
    return this.byte(value ? 1 : 0);
  }

  uint32(value: number): this {
    this.parts.push(Uint8Array.of(value >>> 24, value >>> 16, value >>> 8, value));
    return this;
  }

  raw(bytes: Uint8Array): this {
    this.parts.push(bytes);
    return this;
  }

  string(value: Uint8Array | string): this {
    const bytes = typeof value === "string" ? utf8(value) : value;
    return this.uint32(bytes.length).raw(bytes);
  }

  nameList(names: readonly string[]): this {
    return this.string(names.join(","));
  }

  /** `magnitude` is an unsigned big-endian integer; leading zeros are dropped and a sign byte added when needed. */
  mpint(magnitude: Uint8Array): this {
    let start = 0;
    while (start < magnitude.length && magnitude[start] === 0) start++;
    const trimmed = magnitude.subarray(start);
    if (trimmed.length > 0 && (trimmed[0]! & 0x80) !== 0) {
      return this.uint32(trimmed.length + 1)
        .byte(0)
        .raw(trimmed);
    }
    return this.uint32(trimmed.length).raw(trimmed);
  }

  finish(): Uint8Array {
    return concat(this.parts);
  }
}
