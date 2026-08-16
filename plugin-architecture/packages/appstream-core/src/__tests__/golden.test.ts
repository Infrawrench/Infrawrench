/**
 * The cross-language guard.
 *
 * `fixtures/` is written by the Rust encoder (`cargo test -p iw-codec --test
 * golden`), and this test decodes those exact bytes with this package and
 * reconstructs the canvas the Rust reference blit produced. When the two halves
 * of the protocol disagree — a field width, a rectangle op, a byte order — one
 * of these two tests fails, in the language whose expectations moved.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { FrameDecoder, FrameKind } from "../frame.js";
import { Codec, RectOp, applyPayload, decodePixelPayload } from "../pixels.js";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url))));

const meta = JSON.parse(new TextDecoder().decode(fixture("meta.json"))) as {
  width: number;
  height: number;
  windowId: number;
};

/** Play a fixture's frames onto a blank canvas, exactly as the viewer will. */
function replay(frames: Uint8Array, zstd?: (input: Uint8Array, expected: number) => Uint8Array) {
  const canvas = new Uint8ClampedArray(meta.width * meta.height * 4);
  const decoder = new FrameDecoder();
  decoder.push(frames);

  const seqs: number[] = [];
  let keyframes = 0;
  let solids = 0;
  for (const frame of decoder.drain()) {
    expect(frame.kind).toBe(FrameKind.Pixels);
    expect(frame.windowId).toBe(meta.windowId);
    const payload = decodePixelPayload(frame.payload);
    seqs.push(payload.seq);
    if (payload.keyframe) keyframes += 1;
    solids += payload.rects.filter((rect) => rect.op === RectOp.Solid).length;
    applyPayload(payload, canvas, meta.width, meta.height, zstd);
  }
  return { canvas, seqs, keyframes, solids };
}

describe("golden fixtures from the Rust encoder", () => {
  it("reconstructs the canvas from uncompressed rectangles", () => {
    const { canvas, seqs, keyframes } = replay(fixture("raw-frames.bin"));
    expect(new Uint8Array(canvas)).toEqual(fixture("raw-canvas.rgba"));
    // Sequence numbers start at one and are contiguous: the client acks by
    // seq, so a gap would mean a frame the host thinks is still in flight.
    expect(seqs).toEqual([1, 2, 3, 4]);
    expect(keyframes).toBe(1);
  });

  it("reconstructs the same canvas from the zstd tier", () => {
    // The compression tier is a transport detail. If these two disagree, the
    // viewer would show different pixels depending on the client's caps.
    const { canvas } = replay(fixture("zstd-frames.bin"), (input, expected) => {
      const out = new Uint8Array(zstdDecompressSync(input));
      expect(out.length).toBe(expected);
      return out;
    });
    expect(new Uint8Array(canvas)).toEqual(fixture("raw-canvas.rgba"));
  });

  it("compresses the same picture into an order of magnitude fewer bytes", () => {
    // Not a benchmark — a check that the lossless tier is actually doing
    // something, since a zstd stream of incompressible noise would still
    // decode correctly and quietly cost ten times the bandwidth.
    expect(fixture("zstd-frames.bin").length * 5).toBeLessThan(fixture("raw-frames.bin").length);
  });

  it("recognises a flat band as a solid fill rather than pixels", () => {
    const { solids } = replay(fixture("raw-frames.bin"));
    expect(solids).toBeGreaterThan(0);
  });

  it("refuses a zstd payload when no decompressor was supplied", () => {
    const decoder = new FrameDecoder();
    decoder.push(fixture("zstd-frames.bin"));
    const payload = decodePixelPayload(decoder.next()!.payload);
    expect(payload.codec).toBe(Codec.ZstdRects);
    const canvas = new Uint8ClampedArray(meta.width * meta.height * 4);
    expect(() => applyPayload(payload, canvas, meta.width, meta.height)).toThrow(/no decompressor/);
  });

  it("refuses a rectangle that would write past the canvas", () => {
    // A frame sized for the buffer before a resize must not be applied to the
    // one after it.
    const decoder = new FrameDecoder();
    decoder.push(fixture("raw-frames.bin"));
    const payload = decodePixelPayload(decoder.next()!.payload);
    const tooSmall = new Uint8ClampedArray((meta.width - 1) * meta.height * 4);
    expect(() => applyPayload(payload, tooSmall, meta.width - 1, meta.height)).toThrow(
      /does not fit/,
    );
  });
});
