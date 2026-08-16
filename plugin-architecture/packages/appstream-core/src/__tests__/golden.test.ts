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
import {
  Codec,
  RectOp,
  applyPayload,
  decodeImageTiles,
  decodePixelPayload,
  dirtyBounds,
} from "../pixels.js";

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

  it("applies the interframe deltas the encoder chose", () => {
    // The zstd fixture reconstructs the right canvas above, which is the real
    // proof; this is here so that "the encoder stopped emitting deltas" fails
    // as itself rather than as a size regression nobody looks at.
    const decoder = new FrameDecoder();
    decoder.push(fixture("zstd-frames.bin"));
    const ops = [...decoder.drain()].flatMap((frame) =>
      decodePixelPayload(frame.payload).rects.map((rect) => rect.op),
    );
    expect(ops).toContain(RectOp.Delta);
  });

  it("wraps rather than clamps when applying a delta", () => {
    // A Uint8ClampedArray clamps what it is assigned, and the encoder's
    // subtraction wraps. A channel near the top of the range would drift and
    // stay drifted — invisible in a screenshot, permanent on screen.
    const canvas = new Uint8ClampedArray([250, 250, 250, 255]);
    const payload = {
      codec: Codec.ZstdRects,
      keyframe: false,
      seq: 1,
      width: 1,
      height: 1,
      rects: [{ x: 0, y: 0, w: 1, h: 1, op: RectOp.Delta, solid: 0 }],
      blob: new Uint8Array(),
    };
    // 250 + 10 wraps to 4 in every channel; the blob is BGRA, the canvas RGBA.
    applyPayload({ ...payload, blob: new Uint8Array([10, 10, 10, 10]) }, canvas, 1, 1, () =>
      Uint8Array.from([10, 10, 10, 10]),
    );
    expect([...canvas]).toEqual([4, 4, 4, 9]);
  });

  it("frames the lossy tier as one length-prefixed JPEG per rectangle", () => {
    // There is no canvas fixture for this tier: the pixels depend on whichever
    // JPEG decoder the client has, which is exactly why the host never sends a
    // delta against one. What has to agree across the two languages is the
    // framing, and that each tile really is an image of its rectangle.
    const decoder = new FrameDecoder();
    decoder.push(fixture("jpeg-frames.bin"));
    let tiled = 0;
    for (const frame of decoder.drain()) {
      const payload = decodePixelPayload(frame.payload);
      if (payload.codec !== Codec.JpegTiles) continue;
      tiled += 1;
      const tiles = decodeImageTiles(payload);
      const withPixels = payload.rects.filter((rect) => rect.op !== RectOp.Solid);
      expect(tiles).toHaveLength(withPixels.length);
      tiles.forEach((tile, index) => {
        // SOI … EOI, and a baseline frame header whose dimensions are the
        // rectangle's. Parsed rather than trusted: a tile that decoded to the
        // wrong size would paint over its neighbours.
        expect([tile[0], tile[1]]).toEqual([0xff, 0xd8]);
        expect([tile.at(-2), tile.at(-1)]).toEqual([0xff, 0xd9]);
        const rect = withPixels[index]!;
        expect(jpegSize(tile)).toEqual({ width: rect.w, height: rect.h });
      });
    }
    expect(tiled).toBeGreaterThan(0);
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

/**
 * Width and height out of a JPEG's frame header.
 *
 * Walks the marker segments to the SOF rather than assuming a byte offset —
 * the encoder is free to put its quantisation and Huffman tables in any order,
 * and a fixed offset would break on a change that is not a bug.
 */
function jpegSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 2; // past SOI
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) throw new Error(`not a marker at ${at}`);
    const marker = bytes[at + 1]!;
    const length = view.getUint16(at + 2, false);
    // SOF0/1/2 — baseline and progressive frame headers.
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return { height: view.getUint16(at + 5, false), width: view.getUint16(at + 7, false) };
    }
    at += 2 + length;
  }
  throw new Error("no frame header in this JPEG");
}

describe("painting only what changed", () => {
  const payload = (rects: Array<{ x: number; y: number; w: number; h: number }>) => ({
    codec: Codec.RawRects,
    keyframe: false,
    seq: 1,
    width: 64,
    height: 64,
    rects: rects.map((r) => ({ ...r, op: RectOp.Pixels, solid: 0 })),
    blob: new Uint8Array(),
  });

  it("bounds a single rectangle exactly", () => {
    expect(dirtyBounds(payload([{ x: 4, y: 8, w: 10, h: 6 }]))).toEqual({
      x: 4,
      y: 8,
      w: 10,
      h: 6,
    });
  });

  it("bounds scattered rectangles with one box", () => {
    // `putImageData` takes one dirty rectangle, so scattered damage becomes
    // the box around it — still far less than the whole window, which is what
    // this replaces.
    expect(
      dirtyBounds(
        payload([
          { x: 50, y: 50, w: 4, h: 4 },
          { x: 2, y: 10, w: 4, h: 4 },
        ]),
      ),
    ).toEqual({ x: 2, y: 10, w: 52, h: 44 });
  });

  it("reports nothing for a payload that paints nothing", () => {
    expect(dirtyBounds(payload([]))).toBeNull();
    expect(dirtyBounds(payload([{ x: 1, y: 1, w: 0, h: 5 }]))).toBeNull();
  });

  it("unpacks pixels identically whether or not the word path is taken", () => {
    // The fast path packs bytes by position and the slow one moves them one at
    // a time; they have to agree, or a frame would look different depending on
    // where in a transport buffer it happened to land.
    const bgra = new Uint8Array(8 * 8 * 4);
    for (let i = 0; i < bgra.length; i++) bgra[i] = (i * 37) & 0xff;
    const frame = { ...payload([{ x: 0, y: 0, w: 8, h: 8 }]), width: 8, height: 8 };

    const aligned = new Uint8ClampedArray(8 * 8 * 4);
    applyPayload({ ...frame, blob: bgra }, aligned, 8, 8);

    // The same bytes at an offset no word can start on.
    const shifted = new Uint8Array(bgra.length + 1);
    shifted.set(bgra, 1);
    const unaligned = new Uint8ClampedArray(8 * 8 * 4);
    applyPayload({ ...frame, blob: shifted.subarray(1) }, unaligned, 8, 8);

    expect([...unaligned]).toEqual([...aligned]);
    // And it really is the swap, not two copies of the same mistake.
    expect([...aligned.slice(0, 4)]).toEqual([bgra[2], bgra[1], bgra[0], bgra[3]]);
  });
});
