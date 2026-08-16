/**
 * The pixel payload, mirroring `linux-appserver/crates/iw-codec/src/payload.rs`.
 *
 * ```text
 * u8  codec        u8  flags        u16 rectCount
 * u32 seq          u16 width        u16 height
 * rect[rectCount]: u16 x, u16 y, u16 w, u16 h, u8 op, u32 solid
 * blob[..]
 * ```
 *
 * The header is parsed with a `DataView` and the blob is handed to wasm
 * whole — no allocation per rectangle on the hot path.
 */

export const Codec = {
  /** Rectangle pixels, uncompressed. */
  RawRects: 0,
  /** Rectangle pixels, one zstd frame for the concatenation. */
  ZstdRects: 1,
  /** A VP9 frame covering the window. */
  Vp9: 2,
  /** Per-rectangle WebP images, each u32 length-prefixed. */
  WebpTiles: 3,
  /**
   * Per-rectangle baseline JPEG images, each u32 length-prefixed, in table
   * order for the rectangles that carry pixels. The lossy tier: the browser
   * decodes these itself, so it costs nothing to ship.
   */
  JpegTiles: 4,
} as const;
export type Codec = (typeof Codec)[keyof typeof Codec];

export const RectOp = {
  Pixels: 0,
  Solid: 1,
  /**
   * The blob holds a per-byte wrapping difference from what this canvas
   * already shows — interframe compression. Mostly zeros, which is what makes
   * it compress where the pixels themselves would not.
   */
  Delta: 2,
} as const;
export type RectOp = (typeof RectOp)[keyof typeof RectOp];

/** First frame of a window, or the first after a reattach. */
export const FLAG_KEYFRAME = 1 << 0;

const HEADER_LEN = 12;
const RECT_LEN = 13;

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

export interface RectEntry {
  x: number;
  y: number;
  w: number;
  h: number;
  op: RectOp;
  /** Fill colour for a solid rectangle, in the session's pixel format. */
  solid: number;
}

export interface PixelPayload {
  codec: Codec;
  keyframe: boolean;
  seq: number;
  width: number;
  height: number;
  rects: RectEntry[];
  blob: Uint8Array;
}

export class PayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadError";
  }
}

export function decodePixelPayload(bytes: Uint8Array): PixelPayload {
  if (bytes.length < HEADER_LEN) {
    throw new PayloadError(`payload is ${bytes.length} bytes, shorter than the header`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const codec = bytes[0] as Codec;
  if (!Object.values(Codec).includes(codec)) {
    throw new PayloadError(`unknown codec ${bytes[0]}`);
  }
  const rectCount = view.getUint16(2, true);
  const tableEnd = HEADER_LEN + rectCount * RECT_LEN;
  if (bytes.length < tableEnd) {
    throw new PayloadError(
      `rect table claims ${rectCount} rects, payload holds ${bytes.length} bytes`,
    );
  }

  const rects: RectEntry[] = new Array(rectCount);
  for (let i = 0; i < rectCount; i++) {
    const at = HEADER_LEN + i * RECT_LEN;
    const op = bytes[at + 8] as RectOp;
    if (op !== RectOp.Pixels && op !== RectOp.Solid && op !== RectOp.Delta) {
      throw new PayloadError(`unknown rect op ${bytes[at + 8]}`);
    }
    rects[i] = {
      x: view.getUint16(at, true),
      y: view.getUint16(at + 2, true),
      w: view.getUint16(at + 4, true),
      h: view.getUint16(at + 6, true),
      op,
      solid: view.getUint32(at + 9, true),
    };
  }

  return {
    codec,
    keyframe: (bytes[1]! & FLAG_KEYFRAME) !== 0,
    seq: view.getUint32(4, true),
    width: view.getUint16(8, true),
    height: view.getUint16(10, true),
    rects,
    blob: bytes.subarray(tableEnd),
  };
}

/** Total decompressed pixel bytes the blob must yield. */
export function expectedPixelBytes(payload: PixelPayload): number {
  let total = 0;
  for (const rect of payload.rects) {
    if (rect.op === RectOp.Pixels || rect.op === RectOp.Delta) total += rect.w * rect.h * 4;
  }
  return total;
}

/**
 * The images inside a tiled-codec blob, one per rectangle that carries pixels,
 * in table order. Each is `u32` length-prefixed.
 *
 * Returned as views over the payload rather than copies: they go straight to
 * `createImageBitmap`, which takes a Blob built from them.
 */
export function decodeImageTiles(payload: PixelPayload): Uint8Array[] {
  const tiles: Uint8Array[] = [];
  const view = new DataView(payload.blob.buffer, payload.blob.byteOffset, payload.blob.byteLength);
  let at = 0;
  for (const rect of payload.rects) {
    if (rect.op === RectOp.Solid) continue;
    if (at + 4 > payload.blob.length) {
      throw new PayloadError(`tile table ends after ${tiles.length} of ${payload.rects.length}`);
    }
    const length = view.getUint32(at, true);
    at += 4;
    if (at + length > payload.blob.length) {
      throw new PayloadError(`tile ${tiles.length} claims ${length} bytes past the blob`);
    }
    tiles.push(payload.blob.subarray(at, at + length));
    at += length;
  }
  return tiles;
}

/**
 * The bounding box of everything a payload touches.
 *
 * What a viewer hands `putImageData`'s dirty-rectangle form: uploading the
 * whole canvas for a frame that changed one line of a terminal costs the same
 * as a full-screen repaint, every frame, and on a HiDPI window that is
 * megabytes each time.
 *
 * `null` when the payload paints nothing at all.
 */
export function dirtyBounds(
  payload: PixelPayload,
): { x: number; y: number; w: number; h: number } | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = 0;
  let y1 = 0;
  for (const rect of payload.rects) {
    if (rect.w === 0 || rect.h === 0) continue;
    x0 = Math.min(x0, rect.x);
    y0 = Math.min(y0, rect.y);
    x1 = Math.max(x1, rect.x + rect.w);
    y1 = Math.max(y1, rect.y + rect.h);
  }
  if (!Number.isFinite(x0) || x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Decompresses a zstd frame. Supplied by the host so this package stays free of wasm. */
export type ZstdDecompress = (input: Uint8Array, expectedBytes: number) => Uint8Array;

/**
 * Apply a payload to an RGBA canvas buffer — the one `ImageData` wants.
 *
 * Mirrors `PixelPayload::apply` in `iw-codec`, which is the reference
 * implementation, with one difference that is the whole reason this function
 * is not a memcpy: the wire carries BGRA (little-endian `Argb8888`, which is
 * what `wl_shm` gives the compositor) and a canvas wants RGBA, so red and blue
 * swap on the way in.
 */
export function applyPayload(
  payload: PixelPayload,
  canvas: Uint8ClampedArray | Uint8Array,
  canvasWidth: number,
  canvasHeight: number,
  zstd?: ZstdDecompress,
): void {
  let pixels: Uint8Array;
  switch (payload.codec) {
    case Codec.RawRects:
      pixels = payload.blob;
      break;
    case Codec.ZstdRects: {
      if (!zstd) {
        throw new PayloadError("payload is zstd but no decompressor was supplied");
      }
      pixels = zstd(payload.blob, expectedPixelBytes(payload));
      break;
    }
    default:
      throw new PayloadError(
        `codec ${payload.codec} is decoded by the browser (WebCodecs / createImageBitmap), not here`,
      );
  }

  const expected = expectedPixelBytes(payload);
  if (pixels.length !== expected) {
    throw new PayloadError(`blob is ${pixels.length} bytes, expected ${expected}`);
  }

  let at = 0;
  for (const rect of payload.rects) {
    if (rect.x + rect.w > canvasWidth || rect.y + rect.h > canvasHeight) {
      throw new PayloadError(
        `rect ${rect.x},${rect.y} ${rect.w}x${rect.h} does not fit a ${canvasWidth}x${canvasHeight} canvas`,
      );
    }
    if (rect.op === RectOp.Solid) {
      // The solid is stored little-endian in the session's pixel format, so
      // the bytes come out b, g, r, a.
      const b = rect.solid & 0xff;
      const g = (rect.solid >>> 8) & 0xff;
      const r = (rect.solid >>> 16) & 0xff;
      const a = (rect.solid >>> 24) & 0xff;
      for (let row = 0; row < rect.h; row++) {
        let to = ((rect.y + row) * canvasWidth + rect.x) * 4;
        for (let col = 0; col < rect.w; col++) {
          canvas[to] = r;
          canvas[to + 1] = g;
          canvas[to + 2] = b;
          canvas[to + 3] = a;
          to += 4;
        }
      }
      continue;
    }

    if (rect.op === RectOp.Delta) {
      for (let row = 0; row < rect.h; row++) {
        let to = ((rect.y + row) * canvasWidth + rect.x) * 4;
        for (let col = 0; col < rect.w; col++) {
          // Masked before the store rather than after the add: a
          // Uint8ClampedArray clamps what it is given, so 250 + 10 would land
          // on 255 instead of wrapping to 4 — and the encoder's subtraction
          // wraps. Silent, permanent, and only on the pixels that happened to
          // straddle the top of the range.
          canvas[to] = (canvas[to]! + pixels[at + 2]!) & 0xff;
          canvas[to + 1] = (canvas[to + 1]! + pixels[at + 1]!) & 0xff;
          canvas[to + 2] = (canvas[to + 2]! + pixels[at]!) & 0xff;
          canvas[to + 3] = (canvas[to + 3]! + pixels[at + 3]!) & 0xff;
          to += 4;
          at += 4;
        }
      }
      continue;
    }

    // A word at a time when both sides are word-aligned, which is the normal
    // case: the canvas is our own allocation and the blob is a decompressor's.
    // Four byte loads, four stores and eight index computations per pixel is
    // the difference between a full-window frame costing a few milliseconds
    // and costing tens of them.
    const words = wordViews(canvas, pixels, at);
    if (words) {
      const { dst, src } = words;
      for (let row = 0; row < rect.h; row++) {
        let to = ((rect.y + row) * canvasWidth + rect.x) | 0;
        for (let col = 0; col < rect.w; col++) {
          const v = src[at >>> 2]!;
          // BGRA to RGBA: green and alpha stay, red and blue trade places.
          dst[to] = (v & 0xff00ff00) | ((v >>> 16) & 0xff) | ((v & 0xff) << 16);
          to += 1;
          at += 4;
        }
      }
      continue;
    }

    for (let row = 0; row < rect.h; row++) {
      let to = ((rect.y + row) * canvasWidth + rect.x) * 4;
      for (let col = 0; col < rect.w; col++) {
        canvas[to] = pixels[at + 2]!;
        canvas[to + 1] = pixels[at + 1]!;
        canvas[to + 2] = pixels[at]!;
        canvas[to + 3] = pixels[at + 3]!;
        to += 4;
        at += 4;
      }
    }
  }
}

/**
 * 32-bit views over the canvas and the blob, when both are aligned to a word
 * boundary and the blob's read offset is too.
 *
 * `null` when any of that fails — a payload's pixels can start at any offset
 * inside the frame it arrived in — and the caller falls back to bytes. Writing
 * through a `Uint32Array` also side-steps `Uint8ClampedArray`'s clamping, which
 * is what we want here: these are raw pixels, not arithmetic.
 */
function wordViews(
  canvas: Uint8ClampedArray | Uint8Array,
  pixels: Uint8Array,
  at: number,
): { dst: Uint32Array; src: Uint32Array } | null {
  // The word path packs bytes by position, so it is only the same operation as
  // the byte path on a little-endian machine. Every browser runs on one; the
  // check costs nothing and means the fallback is a fallback rather than a
  // silently wrong answer somewhere else.
  if (!LITTLE_ENDIAN) return null;
  if ((canvas.byteOffset & 3) !== 0 || (pixels.byteOffset & 3) !== 0 || (at & 3) !== 0) return null;
  if ((canvas.byteLength & 3) !== 0 || (pixels.byteLength & 3) !== 0) return null;
  try {
    return {
      dst: new Uint32Array(canvas.buffer, canvas.byteOffset, canvas.byteLength >>> 2),
      src: new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.byteLength >>> 2),
    };
  } catch {
    // A SharedArrayBuffer-backed view, or a length that does not divide: not
    // worth reasoning about when the byte path is right there.
    return null;
  }
}
