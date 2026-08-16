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
} as const;
export type Codec = (typeof Codec)[keyof typeof Codec];

export const RectOp = { Pixels: 0, Solid: 1 } as const;
export type RectOp = (typeof RectOp)[keyof typeof RectOp];

/** First frame of a window, or the first after a reattach. */
export const FLAG_KEYFRAME = 1 << 0;

const HEADER_LEN = 12;
const RECT_LEN = 13;

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
    if (op !== RectOp.Pixels && op !== RectOp.Solid) {
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
    if (rect.op === RectOp.Pixels) total += rect.w * rect.h * 4;
  }
  return total;
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
