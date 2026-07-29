import { describe, expect, it } from "vitest";
import { base64ToBytes, base64ToUtf8, bytesToBase64, utf8ToBase64 } from "../base64.js";

/**
 * Vectors are hand-derived rather than taken from Node's Buffer: this module
 * exists precisely because Buffer is unavailable in the Electron renderer, so
 * checking it against Buffer would test the wrong thing.
 */
describe("base64 helpers", () => {
  it("round-trips arbitrary bytes, including nulls and high bytes", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255, 0, 42]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it("encodes a known byte sequence", () => {
    // FF D8 FF E0 00 10 — a JPEG SOI/APP0 header, whose base64 is "/9j/4AAQ".
    expect(bytesToBase64(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toBe("/9j/4AAQ");
  });

  it("decodes a known base64 string", () => {
    // "SUQzBAA=" is the ID3 tag marker: 49 44 33 ("ID3") then 04 00.
    expect(base64ToBytes("SUQzBAA=")).toEqual(new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]));
  });

  it("handles multi-byte UTF-8", () => {
    // "héllo" is 68 C3 A9 6C 6C 6F once encoded — six bytes, not five chars.
    expect(utf8ToBase64("héllo")).toBe("aMOpbGxv");
    const text = "héllo — 🎙 speech";
    expect(base64ToUtf8(utf8ToBase64(text))).toBe(text);
  });

  it("encodes payloads past the String.fromCharCode argument limit", () => {
    // 0x8000 is the chunk size; go well past it so a regression to a single
    // spread call throws RangeError instead of silently passing.
    const big = new Uint8Array(0x8000 * 3 + 17).map((_, i) => i % 251);
    expect(() => bytesToBase64(big)).not.toThrow();
    expect(base64ToBytes(bytesToBase64(big))).toEqual(big);
  });

  it("accepts an ArrayBuffer as well as a view", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(bytesToBase64(bytes.buffer)).toBe(bytesToBase64(bytes));
  });
});
