/**
 * The smallest protobuf codec the Modal API needs.
 *
 * Modal publishes its API as a protobuf service (`modal_proto/api.proto` in
 * github.com/modal-labs/modal-client, the file its Python, JavaScript and Go
 * SDKs are generated from) and serves it over gRPC only. Rather than ship a
 * protobuf runtime plus generated code for a 5,000-line schema to use a dozen
 * messages, the plugin encodes the few request fields it sends and decodes
 * responses into a field-number index, read through the typed accessors
 * below. Every field number used anywhere in the plugin carries the message
 * and field name it came from.
 *
 * Wire format: https://protobuf.dev/programming-guides/encoding/
 */

const WIRE_VARINT = 0;
const WIRE_I64 = 1;
const WIRE_LEN = 2;
const WIRE_I32 = 5;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/** Builds one message. Fields are appended in call order, which protobuf allows. */
export class ProtoWriter {
  private readonly chunks: number[] = [];

  private varint(value: bigint): void {
    let v = BigInt.asUintN(64, value);
    while (v >= 0x80n) {
      this.chunks.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    this.chunks.push(Number(v));
  }

  private tag(field: number, wire: number): void {
    this.varint(BigInt((field << 3) | wire));
  }

  private bytesField(field: number, bytes: Uint8Array): void {
    this.tag(field, WIRE_LEN);
    this.varint(BigInt(bytes.length));
    for (const b of bytes) this.chunks.push(b);
  }

  /** A `string` field; empty strings are the proto3 default and are skipped. */
  string(field: number, value: string | undefined): this {
    if (value) this.bytesField(field, utf8Encoder.encode(value));
    return this;
  }

  /** Every element of a `repeated string`, including empty ones. */
  strings(field: number, values: readonly string[] | undefined): this {
    for (const v of values ?? []) this.bytesField(field, utf8Encoder.encode(v));
    return this;
  }

  /**
   * An integer field (`int32`, `uint32`, `int64`, `uint64`, `bool`, enums).
   * `always` writes a zero too, which an `optional` field needs to say
   * "explicitly zero" rather than "unset".
   */
  int(field: number, value: number | bigint | boolean | undefined, always = false): this {
    if (value === undefined) return this;
    const n = typeof value === "boolean" ? (value ? 1n : 0n) : BigInt(Math.trunc(Number(value)));
    if (n === 0n && !always) return this;
    this.tag(field, WIRE_VARINT);
    this.varint(n);
    return this;
  }

  /** A `double` field. */
  double(field: number, value: number | undefined): this {
    if (value === undefined || value === 0) return this;
    this.tag(field, WIRE_I64);
    const buf = new DataView(new ArrayBuffer(8));
    buf.setFloat64(0, value, true);
    for (let i = 0; i < 8; i++) this.chunks.push(buf.getUint8(i));
    return this;
  }

  /** An embedded message field. Written even when empty, so presence is kept. */
  message(field: number, inner: ProtoWriter | undefined): this {
    if (inner) this.bytesField(field, inner.finish());
    return this;
  }

  /** `google.protobuf.Timestamp { int64 seconds = 1; int32 nanos = 2; }` */
  timestamp(field: number, ms: number | undefined): this {
    if (ms === undefined) return this;
    const seconds = Math.floor(ms / 1000);
    const nanos = Math.round((ms - seconds * 1000) * 1_000_000);
    return this.message(field, new ProtoWriter().int(1, seconds).int(2, nanos));
  }

  /** `google.protobuf.StringValue { string value = 1; }`, written only when set. */
  stringValue(field: number, value: string | undefined): this {
    if (value === undefined) return this;
    return this.message(field, new ProtoWriter().string(1, value));
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

type RawValue =
  | { wire: typeof WIRE_VARINT; value: bigint }
  | { wire: typeof WIRE_I64; value: Uint8Array }
  | { wire: typeof WIRE_LEN; value: Uint8Array }
  | { wire: typeof WIRE_I32; value: Uint8Array };

/**
 * A decoded message: every occurrence of every field, by field number.
 * Unknown fields are kept and simply never read, which is what lets Modal add
 * fields without breaking the plugin.
 */
export class ProtoMessage {
  private readonly fields = new Map<number, RawValue[]>();

  constructor(bytes: Uint8Array) {
    let pos = 0;
    const readVarint = (): bigint => {
      let result = 0n;
      let shift = 0n;
      for (;;) {
        if (pos >= bytes.length) throw new Error("Malformed protobuf: truncated varint");
        const b = bytes[pos++]!;
        result |= BigInt(b & 0x7f) << shift;
        if ((b & 0x80) === 0) return result;
        shift += 7n;
        if (shift > 63n) throw new Error("Malformed protobuf: varint too long");
      }
    };
    const take = (n: number): Uint8Array => {
      if (pos + n > bytes.length) throw new Error("Malformed protobuf: truncated field");
      const out = bytes.subarray(pos, pos + n);
      pos += n;
      return out;
    };
    while (pos < bytes.length) {
      const key = Number(readVarint());
      const field = key >>> 3;
      const wire = key & 7;
      let raw: RawValue;
      switch (wire) {
        case WIRE_VARINT:
          raw = { wire, value: readVarint() };
          break;
        case WIRE_I64:
          raw = { wire, value: take(8) };
          break;
        case WIRE_LEN:
          raw = { wire, value: take(Number(readVarint())) };
          break;
        case WIRE_I32:
          raw = { wire, value: take(4) };
          break;
        default:
          // Groups (3/4) are proto2-only and never appear in Modal's schema.
          throw new Error(`Malformed protobuf: unsupported wire type ${wire}`);
      }
      const list = this.fields.get(field);
      if (list) list.push(raw);
      else this.fields.set(field, [raw]);
    }
  }

  private last(field: number): RawValue | undefined {
    const list = this.fields.get(field);
    return list ? list[list.length - 1] : undefined;
  }

  has(field: number): boolean {
    return this.fields.has(field);
  }

  string(field: number): string {
    const raw = this.last(field);
    return raw?.wire === WIRE_LEN ? utf8Decoder.decode(raw.value) : "";
  }

  strings(field: number): string[] {
    return (this.fields.get(field) ?? [])
      .filter((r) => r.wire === WIRE_LEN)
      .map((r) => utf8Decoder.decode(r.value));
  }

  /** Unsigned integer fields (`uint32`, `uint64`, `bool`, enums). */
  uint(field: number): number {
    const raw = this.last(field);
    return raw?.wire === WIRE_VARINT ? Number(BigInt.asUintN(64, raw.value)) : 0;
  }

  /** Signed `int32`/`int64` fields (two's complement varints, not zigzag). */
  int(field: number): number {
    const raw = this.last(field);
    return raw?.wire === WIRE_VARINT ? Number(BigInt.asIntN(64, raw.value)) : 0;
  }

  bool(field: number): boolean {
    return this.uint(field) !== 0;
  }

  double(field: number): number {
    const raw = this.last(field);
    if (raw?.wire !== WIRE_I64) return 0;
    return new DataView(raw.value.buffer, raw.value.byteOffset, 8).getFloat64(0, true);
  }

  float(field: number): number {
    const raw = this.last(field);
    if (raw?.wire !== WIRE_I32) return 0;
    return new DataView(raw.value.buffer, raw.value.byteOffset, 4).getFloat32(0, true);
  }

  message(field: number): ProtoMessage | undefined {
    const raw = this.last(field);
    return raw?.wire === WIRE_LEN ? new ProtoMessage(raw.value) : undefined;
  }

  messages(field: number): ProtoMessage[] {
    return (this.fields.get(field) ?? [])
      .filter((r) => r.wire === WIRE_LEN)
      .map((r) => new ProtoMessage(r.value));
  }

  /** `map<string, string>`: repeated entry messages `{ key = 1; value = 2; }`. */
  stringMap(field: number): Record<string, string> {
    const out: Record<string, string> = {};
    for (const entry of this.messages(field)) out[entry.string(1)] = entry.string(2);
    return out;
  }

  /** `map<string, Message>`. */
  messageMap(field: number): Record<string, ProtoMessage> {
    const out: Record<string, ProtoMessage> = {};
    for (const entry of this.messages(field)) {
      out[entry.string(1)] = entry.message(2) ?? new ProtoMessage(new Uint8Array());
    }
    return out;
  }

  /** `google.protobuf.Timestamp` as epoch milliseconds, or undefined when unset. */
  timestampMs(field: number): number | undefined {
    const ts = this.message(field);
    if (!ts) return undefined;
    return ts.int(1) * 1000 + Math.floor(ts.int(2) / 1_000_000);
  }
}

/** Decode one message from its bytes. */
export function decode(bytes: Uint8Array): ProtoMessage {
  return new ProtoMessage(bytes);
}
