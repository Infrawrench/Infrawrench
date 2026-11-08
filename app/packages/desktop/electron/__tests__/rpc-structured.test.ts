/**
 * `StructuredValue` carries what Electron's structured clone did, through the
 * JSON codec Effect RPC encodes every frame with.
 */
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { StructuredArgs, StructuredValue } from "../../shared/rpc/structured";

const codec = Schema.toCodecJson(StructuredValue);
const roundTrip = (value: unknown): unknown =>
  Schema.decodeUnknownSync(codec)(
    JSON.parse(JSON.stringify(Schema.encodeUnknownSync(codec)(value))),
  );

describe("StructuredValue", () => {
  it("keeps what JSON keeps", () => {
    const value = { a: 1, b: "two", c: [true, null, { d: 3.5 }] };
    expect(roundTrip(value)).toEqual(value);
  });

  it("keeps what JSON would lose or refuse", () => {
    const at = new Date("2026-11-08T10:00:00.000Z");
    const out = roundTrip({
      at,
      bytes: Buffer.from("hi"),
      big: 12345678901234567890n,
      nan: NaN,
      inf: -Infinity,
      gap: undefined,
      list: [1, undefined, 3],
      map: new Map([["k", 1]]),
      set: new Set(["x"]),
      error: new TypeError("boom"),
    });
    expect(out).toEqual({
      at,
      bytes: new Uint8Array([104, 105]),
      big: 12345678901234567890n,
      nan: NaN,
      inf: -Infinity,
      gap: undefined,
      list: [1, undefined, 3],
      map: new Map([["k", 1]]),
      set: new Set(["x"]),
      error: expect.objectContaining({ name: "TypeError", message: "boom" }),
    });
    expect(out).toHaveProperty("gap");
  });

  it("cannot be fooled by an object that looks like an encoded special", () => {
    const value = { $iw: "u", v: 1 };
    expect(roundTrip(value)).toEqual(value);
  });

  it("drops functions the way a copy of the object's data would", () => {
    expect(roundTrip({ keep: 1, drop: () => 1 })).toEqual({ keep: 1 });
  });

  it("keeps positional holes in an argument list", () => {
    const args = Schema.toCodecJson(StructuredArgs);
    const encoded = JSON.stringify(Schema.encodeUnknownSync(args)(["acc", undefined, "x"]));
    const decoded = Schema.decodeUnknownSync(args)(JSON.parse(encoded));
    expect(decoded).toHaveLength(3);
    expect(decoded[1]).toBeUndefined();
  });

  it("refuses a cycle rather than looping", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => Schema.encodeUnknownSync(codec)(cyclic)).toThrow();
  });
});
