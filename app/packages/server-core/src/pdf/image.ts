/**
 * Raster images for the PDF writer: a JPEG passed through, a PNG decoded.
 *
 * Only what a logo needs. A JPEG is embedded as-is (PDF's `DCTDecode` *is*
 * JPEG), so the only work is reading its dimensions. A PNG has to be decoded,
 * because PDF has no PNG filter: the scanlines are inflated, unfiltered,
 * expanded to 8-bit RGB, and re-deflated, with any transparency split out
 * into a soft mask. Interlaced and 16-bit PNGs are refused with a message
 * rather than decoded, which keeps this to the formats image editors write by
 * default and keeps a hostile file from costing more than a bounded amount of
 * work (dimensions are capped before anything is allocated).
 *
 * Pure apart from `node:zlib`, like the writer itself.
 */
import { deflateSync, inflateSync } from "node:zlib";

/** An image ready to be written as a PDF image XObject. */
export interface PdfImageData {
  width: number;
  height: number;
  colorSpace: "DeviceRGB" | "DeviceGray";
  filter: "DCTDecode" | "FlateDecode";
  /** The stream bytes, already in the encoding `filter` names. */
  data: Uint8Array;
  /** 8-bit gray alpha, Flate-encoded; absent when fully opaque. */
  smask?: Uint8Array | undefined;
}

/** The largest image decoded, in pixels: 4 million is 2000 × 2000. */
export const MAX_IMAGE_PIXELS = 4_000_000;

export class PdfImageError extends Error {
  override readonly name = "PdfImageError";
}

/* ------------------------------------------------------------------ *
 * JPEG
 * ------------------------------------------------------------------ */

/** Read a JPEG's frame header. The bytes are embedded unchanged. */
export function readJpeg(bytes: Uint8Array): PdfImageData {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new PdfImageError("That file is not a JPEG");
  }
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = bytes[i + 1]!;
    // Fill bytes and standalone markers carry no length.
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const length = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (i + 9 >= bytes.length) break;
      const height = (bytes[i + 5]! << 8) | bytes[i + 6]!;
      const width = (bytes[i + 7]! << 8) | bytes[i + 8]!;
      const components = bytes[i + 9]!;
      if (width === 0 || height === 0) throw new PdfImageError("That JPEG has no dimensions");
      if (components !== 1 && components !== 3) {
        throw new PdfImageError(
          "CMYK JPEGs aren't supported. Export the logo as an RGB JPEG or a PNG.",
        );
      }
      return {
        width,
        height,
        colorSpace: components === 1 ? "DeviceGray" : "DeviceRGB",
        filter: "DCTDecode",
        data: bytes,
      };
    }
    if (marker === 0xda || marker === 0xd9) break;
    i += 2 + length;
  }
  throw new PdfImageError("That JPEG could not be read");
}

/* ------------------------------------------------------------------ *
 * PNG
 * ------------------------------------------------------------------ */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function u32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at]! << 24) >>> 0) + (bytes[at + 1]! << 16) + (bytes[at + 2]! << 8) + bytes[at + 3]!
  );
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decode a PNG into 8-bit RGB plus, when anything is transparent, an alpha plane. */
export function readPng(bytes: Uint8Array): PdfImageData {
  if (bytes.length < 8 || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) {
    throw new PdfImageError("That file is not a PNG");
  }
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const idat: Uint8Array[] = [];

  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = u32(bytes, at);
    const type = String.fromCharCode(
      bytes[at + 4]!,
      bytes[at + 5]!,
      bytes[at + 6]!,
      bytes[at + 7]!,
    );
    const start = at + 8;
    const end = start + length;
    if (end > bytes.length) throw new PdfImageError("That PNG is truncated");
    const chunk = bytes.subarray(start, end);
    if (type === "IHDR") {
      width = u32(chunk, 0);
      height = u32(chunk, 4);
      bitDepth = chunk[8]!;
      colorType = chunk[9]!;
      interlace = chunk[12]!;
    } else if (type === "PLTE") palette = chunk;
    else if (type === "tRNS") transparency = chunk;
    else if (type === "IDAT") idat.push(chunk);
    else if (type === "IEND") break;
    at = end + 4; // skip the CRC
  }

  if (width === 0 || height === 0) throw new PdfImageError("That PNG has no dimensions");
  if (width * height > MAX_IMAGE_PIXELS) {
    throw new PdfImageError("That image is too large; use one of at most 2000 × 2000 pixels");
  }
  if (interlace !== 0) {
    throw new PdfImageError("Interlaced PNGs aren't supported. Save it without interlacing.");
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType as 0 | 2 | 3 | 4 | 6];
  if (channels === undefined) throw new PdfImageError("That PNG's colour type isn't supported");
  const depthOk =
    colorType === 0 || colorType === 3 ? [1, 2, 4, 8].includes(bitDepth) : bitDepth === 8;
  if (!depthOk) {
    throw new PdfImageError("16-bit PNGs aren't supported. Export the logo as an 8-bit PNG.");
  }
  if (colorType === 3 && !palette) throw new PdfImageError("That PNG has no palette");

  let raw: Uint8Array;
  try {
    raw = new Uint8Array(inflateSync(Buffer.concat(idat.map((c) => Buffer.from(c)))));
  } catch {
    throw new PdfImageError("That PNG's image data could not be decompressed");
  }
  const bitsPerPixel = channels * bitDepth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  if (raw.length < (stride + 1) * height) throw new PdfImageError("That PNG is truncated");

  // Unfilter in place into `pixels`, one scanline at a time.
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[src + x]!;
      const left = x >= bpp ? pixels[dst + x - bpp]! : 0;
      const up = y > 0 ? pixels[dst - stride + x]! : 0;
      const upLeft = y > 0 && x >= bpp ? pixels[dst - stride + x - bpp]! : 0;
      let out: number;
      switch (filter) {
        case 0:
          out = value;
          break;
        case 1:
          out = value + left;
          break;
        case 2:
          out = value + up;
          break;
        case 3:
          out = value + ((left + up) >> 1);
          break;
        case 4:
          out = value + paeth(left, up, upLeft);
          break;
        default:
          throw new PdfImageError("That PNG uses an unknown filter");
      }
      pixels[dst + x] = out & 0xff;
    }
  }

  // Expand to 8-bit RGB + alpha.
  const rgb = new Uint8Array(width * height * 3);
  const alpha = new Uint8Array(width * height).fill(255);
  let translucent = false;
  const sample = (row: number, index: number): number => {
    // The index-th sample of `bitDepth` bits in a row.
    const bit = index * bitDepth;
    const byte = pixels[row * stride + (bit >> 3)]!;
    const shift = 8 - bitDepth - (bit & 7);
    return (byte >> shift) & ((1 << bitDepth) - 1);
  };
  const scale = bitDepth < 8 ? 255 / ((1 << bitDepth) - 1) : 1;
  const trnsGray =
    colorType === 0 && transparency ? (transparency[0]! << 8) | transparency[1]! : -1;
  const trnsRgb =
    colorType === 2 && transparency && transparency.length >= 6
      ? [transparency[1]!, transparency[3]!, transparency[5]!]
      : null;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      let r: number;
      let g: number;
      let b: number;
      let a = 255;
      if (colorType === 0) {
        const v = sample(y, x);
        r = g = b = Math.round(v * scale);
        if (v === trnsGray) a = 0;
      } else if (colorType === 3) {
        const index = sample(y, x);
        r = palette![index * 3] ?? 0;
        g = palette![index * 3 + 1] ?? 0;
        b = palette![index * 3 + 2] ?? 0;
        if (transparency && index < transparency.length) a = transparency[index]!;
      } else {
        const o = y * stride + x * channels;
        if (colorType === 2) {
          r = pixels[o]!;
          g = pixels[o + 1]!;
          b = pixels[o + 2]!;
          if (trnsRgb && r === trnsRgb[0] && g === trnsRgb[1] && b === trnsRgb[2]) a = 0;
        } else if (colorType === 4) {
          r = g = b = pixels[o]!;
          a = pixels[o + 1]!;
        } else {
          r = pixels[o]!;
          g = pixels[o + 1]!;
          b = pixels[o + 2]!;
          a = pixels[o + 3]!;
        }
      }
      rgb[p * 3] = r;
      rgb[p * 3 + 1] = g;
      rgb[p * 3 + 2] = b;
      alpha[p] = a;
      if (a !== 255) translucent = true;
    }
  }

  return {
    width,
    height,
    colorSpace: "DeviceRGB",
    filter: "FlateDecode",
    data: new Uint8Array(deflateSync(rgb)),
    ...(translucent ? { smask: new Uint8Array(deflateSync(alpha)) } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Data URLs
 * ------------------------------------------------------------------ */

/** Decode a `data:image/png|jpeg;base64,…` URL into a PDF image. */
export function readImageDataUrl(dataUrl: string): PdfImageData {
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!m) throw new PdfImageError("The image must be a PNG or JPEG data URL");
  const bytes = new Uint8Array(Buffer.from(m[2]!, "base64"));
  return m[1] === "png" ? readPng(bytes) : readJpeg(bytes);
}
