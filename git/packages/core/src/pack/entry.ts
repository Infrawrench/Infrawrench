/** The pack container: its 12-byte header and the variable-length header before each entry. */
import { GitError } from "../errors";
import { isObjectId, oidFromBytes, writeHex } from "../hex";
import type { ObjectId, ObjectType } from "../types";

export type PackEntryType = ObjectType | "ofs-delta" | "ref-delta";

export const PACK_HEADER_LENGTH = 12;
export const PACK_TRAILER_LENGTH = 20;
/** Longer than any entry header: 10 size bytes, then 10 offset bytes or a 20-byte id. */
export const MAX_ENTRY_HEADER_LENGTH = 32;

const TYPE_CODES: Record<PackEntryType, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
  "ofs-delta": 6,
  "ref-delta": 7,
};
const CODE_TYPES: ReadonlyArray<PackEntryType | null> = [
  null,
  "commit",
  "tree",
  "blob",
  "tag",
  null,
  "ofs-delta",
  "ref-delta",
];

export function packTypeCode(type: PackEntryType): number {
  return TYPE_CODES[type];
}

export function packTypeFromCode(code: number): PackEntryType | null {
  return CODE_TYPES[code] ?? null;
}

export function isDeltaType(type: PackEntryType): type is "ofs-delta" | "ref-delta" {
  return type === "ofs-delta" || type === "ref-delta";
}

export interface PackHeader {
  readonly version: number;
  readonly objectCount: number;
}

export interface PackEntryHeader {
  /** Where the entry starts in the pack. */
  readonly offset: number;
  readonly type: PackEntryType;
  /** The inflated size of the entry's data: the object for a whole object, the delta itself for a delta. */
  readonly size: number;
  /** Bytes of header before the zlib stream. */
  readonly headerLength: number;
  /** For `ofs-delta`: the absolute offset of the base entry. */
  readonly baseOffset?: number;
  /** For `ref-delta`: the id of the base object, which a thin pack may not contain. */
  readonly baseOid?: ObjectId;
}

export interface PackEntry extends PackEntryHeader {
  /** CRC-32 of the entry's packed bytes, header included, as a pack index stores it. */
  readonly crc32: number;
  /** Bytes of zlib stream after the header. */
  readonly compressedLength: number;
  /** `headerLength + compressedLength`: the next entry starts at `offset + length`. */
  readonly length: number;
}

export function encodePackHeader(objectCount: number, version = 2): Uint8Array {
  if (!Number.isInteger(objectCount) || objectCount < 0 || objectCount > 0xffffffff) {
    throw new GitError("bad-pack", "a pack holds at most 2^32 - 1 objects");
  }
  const out = new Uint8Array(PACK_HEADER_LENGTH);
  out.set([0x50, 0x41, 0x43, 0x4b]);
  const view = new DataView(out.buffer);
  view.setUint32(4, version);
  view.setUint32(8, objectCount);
  return out;
}

export function decodePackHeader(bytes: Uint8Array): PackHeader {
  if (bytes.length < PACK_HEADER_LENGTH) throw new GitError("bad-pack", "pack header is cut short");
  if (bytes[0] !== 0x50 || bytes[1] !== 0x41 || bytes[2] !== 0x43 || bytes[3] !== 0x4b) {
    throw new GitError("bad-pack", "not a pack: bad signature");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4);
  if (version !== 2 && version !== 3) {
    throw new GitError("bad-pack", `pack version ${version} is not supported`);
  }
  return { version, objectCount: view.getUint32(8) };
}

/**
 * Decodes the entry header at `position` in `bytes`, for an entry that
 * starts at `offset` in the pack. Returns null when the bytes end before the
 * header does, so a streaming caller can come back with more.
 */
export function decodeEntryHeader(
  bytes: Uint8Array,
  position: number,
  offset: number,
): PackEntryHeader | null {
  const end = bytes.length;
  let at = position;
  if (at >= end) return null;
  let byte = bytes[at++]!;
  const type = packTypeFromCode((byte >> 4) & 7);
  if (type === null) throw new GitError("bad-pack", `entry at ${offset} has an unknown type`);
  let size = byte & 0x0f;
  let scale = 16;
  while (byte & 0x80) {
    if (at >= end) return null;
    // Multiplying keeps going where a shift would wrap at 32 bits.
    if (scale > 2 ** 53) throw new GitError("bad-pack", `entry at ${offset} has an absurd size`);
    byte = bytes[at++]!;
    size += (byte & 0x7f) * scale;
    scale *= 128;
  }
  if (!Number.isSafeInteger(size)) {
    throw new GitError("bad-pack", `entry at ${offset} has an absurd size`);
  }
  if (type === "ofs-delta") {
    if (at >= end) return null;
    byte = bytes[at++]!;
    let distance = byte & 0x7f;
    while (byte & 0x80) {
      if (at >= end) return null;
      byte = bytes[at++]!;
      distance = (distance + 1) * 128 + (byte & 0x7f);
      if (distance > offset) break;
    }
    // A base lies strictly before its delta and after the pack header.
    if (distance <= 0 || distance > offset - PACK_HEADER_LENGTH) {
      throw new GitError("bad-pack", `delta at ${offset} points outside the pack`);
    }
    return { offset, type, size, headerLength: at - position, baseOffset: offset - distance };
  }
  if (type === "ref-delta") {
    if (at + 20 > end) return null;
    const baseOid = oidFromBytes(bytes, at);
    return { offset, type, size, headerLength: at + 20 - position, baseOid };
  }
  return { offset, type, size, headerLength: at - position };
}

export type EntryBase =
  | { readonly distance: number; readonly oid?: undefined }
  | { readonly oid: ObjectId; readonly distance?: undefined };

/**
 * Encodes an entry header. A delta takes its base: how far back it lies in
 * this pack (`ofs-delta`) or its id (`ref-delta`).
 */
export function encodeEntryHeader(type: PackEntryType, size: number, base?: EntryBase): Uint8Array {
  if (!Number.isSafeInteger(size) || size < 0) throw new GitError("bad-pack", "bad entry size");
  const out = new Uint8Array(MAX_ENTRY_HEADER_LENGTH);
  let at = 0;
  let rest = Math.floor(size / 16);
  out[at++] = (TYPE_CODES[type] << 4) | (size % 16) | (rest > 0 ? 0x80 : 0);
  while (rest > 0) {
    const next = Math.floor(rest / 128);
    out[at++] = (rest % 128) | (next > 0 ? 0x80 : 0);
    rest = next;
  }
  if (type === "ofs-delta") {
    let distance = base?.distance;
    if (distance === undefined || !Number.isSafeInteger(distance) || distance <= 0) {
      throw new GitError("bad-pack", "an ofs-delta needs the distance back to its base");
    }
    const digits = [distance % 128];
    distance = Math.floor(distance / 128);
    while (distance > 0) {
      distance -= 1;
      digits.push(0x80 | (distance % 128));
      distance = Math.floor(distance / 128);
    }
    for (let i = digits.length - 1; i >= 0; i--) out[at++] = digits[i]!;
  } else if (type === "ref-delta") {
    if (base?.oid === undefined || !isObjectId(base.oid)) {
      throw new GitError("bad-pack", "a ref-delta needs its base id");
    }
    writeHex(base.oid, out, at);
    at += 20;
  }
  return out.subarray(0, at);
}
