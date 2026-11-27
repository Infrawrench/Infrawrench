/**
 * What a profile may hold: how long a bio is, and what an organisation's
 * uploaded picture may be. The Worker checks an upload with
 * {@link inspectAvatar} and the UI's dev mock does the same, so both refuse
 * the same file with the same sentence.
 *
 * A picture is judged by its bytes, never by the type its sender names: it
 * is a PNG, a JPEG or a WebP because it starts like one and its header
 * parses, and that is the type it is stored and served as. Nothing else is
 * kept, an SVG least of all (it is a document).
 */

/** A bio is one short paragraph. */
export const BIO_MAX_LENGTH = 280;

export const AVATAR_LIMITS = {
  /** The file as it is stored. */
  maxBytes: 1024 * 1024,
  /** Each side, in pixels. */
  minDimension: 16,
  maxDimension: 2048,
} as const;

/** How long the base64 of the largest picture is: what the upload's body is capped at. */
export const AVATAR_MAX_BASE64_LENGTH = 4 * Math.ceil(AVATAR_LIMITS.maxBytes / 3);

export const AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type AvatarType = (typeof AVATAR_TYPES)[number];

/** The extension a stored picture's name ends in, which is how it is served as its type. */
export const AVATAR_EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
} as const satisfies Record<AvatarType, string>;

export interface AvatarImage {
  readonly type: AvatarType;
  readonly width: number;
  readonly height: number;
}

export type AvatarInspection =
  | { readonly ok: true; readonly image: AvatarImage }
  | { readonly ok: false; readonly problem: string };

const refuse = (problem: string): AvatarInspection => ({ ok: false, problem });

const NOT_A_PICTURE = "The picture must be a PNG, JPEG or WebP image";
const ANIMATED = "The picture must be a still image";

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0): boolean =>
  bytes.length >= at + signature.length && signature.every((byte, i) => bytes[at + i] === byte);

const ascii = (bytes: Uint8Array, at: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(at, at + length));

const u32be = (bytes: Uint8Array, at: number): number =>
  ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;

const u16be = (bytes: Uint8Array, at: number): number => (bytes[at]! << 8) | bytes[at + 1]!;
const u16le = (bytes: Uint8Array, at: number): number => bytes[at]! | (bytes[at + 1]! << 8);
const u24le = (bytes: Uint8Array, at: number): number =>
  bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);

type Parsed = AvatarImage | "animated" | null;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The size is in `IHDR`, the first chunk; an `acTL` before the image data makes it an animation. */
const parsePng = (bytes: Uint8Array): Parsed => {
  if (bytes.length < 33 || u32be(bytes, 8) !== 13 || ascii(bytes, 12, 4) !== "IHDR") return null;
  const image = { type: "image/png" as const, width: u32be(bytes, 16), height: u32be(bytes, 20) };
  for (let at = 8; at + 8 <= bytes.length;) {
    const length = u32be(bytes, at);
    const name = ascii(bytes, at + 4, 4);
    if (name === "acTL") return "animated";
    if (name === "IDAT" || name === "IEND") break;
    at += 12 + length;
  }
  return image;
};

/** The size is in the first start-of-frame segment. */
const parseJpeg = (bytes: Uint8Array): Parsed => {
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    // Fill bytes before a marker.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    // Markers that stand alone: restarts, start and end of image, TEM.
    if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      at += 2;
      continue;
    }
    const length = u16be(bytes, at + 2);
    if (length < 2) return null;
    const startOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (startOfFrame) {
      if (at + 9 > bytes.length) return null;
      return { type: "image/jpeg", height: u16be(bytes, at + 5), width: u16be(bytes, at + 7) };
    }
    // The image data follows the scan header; a frame comes before it.
    if (marker === 0xda) return null;
    at += 2 + length;
  }
  return null;
};

/** `RIFF....WEBP` and then one of three first chunks, each with the size somewhere else. */
const parseWebp = (bytes: Uint8Array): Parsed => {
  if (bytes.length < 30) return null;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8 ") {
    if (!startsWith(bytes, [0x9d, 0x01, 0x2a], 23)) return null;
    return {
      type: "image/webp",
      width: u16le(bytes, 26) & 0x3fff,
      height: u16le(bytes, 28) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    if (bytes[20] !== 0x2f) return null;
    const b0 = bytes[21]!;
    const b1 = bytes[22]!;
    const b2 = bytes[23]!;
    const b3 = bytes[24]!;
    return {
      type: "image/webp",
      width: 1 + (b0 | ((b1 & 0x3f) << 8)),
      height: 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)),
    };
  }
  if (chunk === "VP8X") {
    if ((bytes[20]! & 0x02) !== 0) return "animated";
    return { type: "image/webp", width: 1 + u24le(bytes, 24), height: 1 + u24le(bytes, 27) };
  }
  return null;
};

const parse = (bytes: Uint8Array): Parsed => {
  if (startsWith(bytes, PNG_SIGNATURE)) return parsePng(bytes);
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return parseJpeg(bytes);
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return parseWebp(bytes);
  return null;
};

/**
 * What an uploaded picture is, read from its own bytes, or the sentence that
 * refuses it: not one of the three formats, animated, too large a file, or
 * too small or too large a picture.
 */
export function inspectAvatar(bytes: Uint8Array): AvatarInspection {
  if (bytes.length === 0) return refuse(NOT_A_PICTURE);
  if (bytes.length > AVATAR_LIMITS.maxBytes) {
    return refuse("The picture must be 1 MB or smaller");
  }
  const image = parse(bytes);
  if (image === null) return refuse(NOT_A_PICTURE);
  if (image === "animated") return refuse(ANIMATED);
  const { minDimension, maxDimension } = AVATAR_LIMITS;
  if (image.width < minDimension || image.height < minDimension) {
    return refuse(`The picture must be at least ${minDimension} pixels on each side`);
  }
  if (image.width > maxDimension || image.height > maxDimension) {
    return refuse(`The picture must be at most ${maxDimension} pixels on each side`);
  }
  return { ok: true, image };
}

/** The bytes a base64 string stands for, or null when it is not base64. */
export function decodeBase64(text: string): Uint8Array<ArrayBuffer> | null {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}
